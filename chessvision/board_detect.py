"""Locate an axis-aligned 2D chessboard in a screenshot.

Idea (works for any digital board theme, no training needed):
  On an interior grid line of a checkerboard, the colour flips light->dark on
  one square and dark->light on the next, so the image gradient across that
  line has *both* signs in roughly equal amounts. Edges in the rest of the UI
  (panels, the board's outer border, text baselines) are mostly one-signed.
  So for every column x we compute  sqrt(sum(+dI/dx) * sum(-dI/dx)),  which
  peaks on the 7 interior vertical lines, and the same for rows. We then look
  for 7 equally spaced peaks and refine them with a least-squares fit.
"""
from __future__ import annotations

from dataclasses import dataclass

import cv2
import numpy as np


@dataclass
class BoardGeometry:
    x0: float  # left edge of the board (pixel coordinates, continuous)
    y0: float  # top edge
    dx: float  # square width
    dy: float  # square height
    confidence: float = 1.0

    @property
    def bbox(self) -> tuple[int, int, int, int]:
        return (int(round(self.x0)), int(round(self.y0)),
                int(round(8 * self.dx)), int(round(8 * self.dy)))

    def square_rect(self, row: int, col: int) -> tuple[float, float, float, float]:
        """(x, y, w, h) of the square at image row/col (0,0 = top-left)."""
        return (self.x0 + col * self.dx, self.y0 + row * self.dy, self.dx, self.dy)

    def square_center(self, row: int, col: int) -> tuple[float, float]:
        return (self.x0 + (col + 0.5) * self.dx, self.y0 + (row + 0.5) * self.dy)


@dataclass
class _Lines:
    first: float      # position of first interior line (continuous coords)
    d: float          # spacing
    strength: float   # normalised strength of the weakest supported line


class BoardNotFound(RuntimeError):
    pass


def _bipolar_profile(gray: np.ndarray, axis: int) -> np.ndarray:
    """axis=0 -> profile over x (vertical lines); axis=1 -> profile over y."""
    if axis == 0:
        g = cv2.Sobel(gray, cv2.CV_32F, 1, 0, ksize=3)
        pos = np.clip(g, 0, None).sum(axis=0)
        neg = np.clip(-g, 0, None).sum(axis=0)
    else:
        g = cv2.Sobel(gray, cv2.CV_32F, 0, 1, ksize=3)
        pos = np.clip(g, 0, None).sum(axis=1)
        neg = np.clip(-g, 0, None).sum(axis=1)
    prof = np.sqrt(pos * neg)
    # light smoothing so a 2-px Sobel response becomes a single peak
    prof = cv2.GaussianBlur(prof.reshape(1, -1).astype(np.float32), (0, 0), 1.0).ravel()
    return prof


def _peaks(prof: np.ndarray, max_peaks: int = 48) -> np.ndarray:
    if prof.max() <= 0:
        return np.array([], dtype=int)
    n = len(prof)
    thr = 0.12 * prof.max()
    cand = []
    for i in range(1, n - 1):
        v = prof[i]
        if v >= thr and v >= prof[max(0, i - 2):i + 3].max():
            cand.append(i)
    cand = np.array(cand, dtype=int)
    if len(cand) > max_peaks:
        cand = cand[np.argsort(prof[cand])[::-1][:max_peaks]]
    return np.sort(cand)


def _support(prof: np.ndarray, lines: np.ndarray, tol: int) -> np.ndarray:
    n = len(prof)
    out = np.empty(len(lines), dtype=np.float32)
    for j, l in enumerate(lines):
        c = int(round(l))
        lo, hi = max(0, c - tol), min(n, c + tol + 1)
        out[j] = prof[lo:hi].max() if hi > lo else 0.0
    return out


def _refine(prof: np.ndarray, lines: np.ndarray, tol: int) -> tuple[float, float]:
    """Sub-pixel peak per line, then least-squares fit pos = first + k*d."""
    n = len(prof)
    pos = []
    for l in lines:
        c = int(round(l))
        lo, hi = max(1, c - tol), min(n - 1, c + tol + 1)
        i = lo + int(np.argmax(prof[lo:hi]))
        a, b, c3 = prof[i - 1], prof[i], prof[min(i + 1, n - 1)]
        den = a - 2 * b + c3
        off = 0.5 * (a - c3) / den if den != 0 else 0.0
        pos.append(i + float(np.clip(off, -0.5, 0.5)))
    k = np.arange(len(lines))
    d, first = np.polyfit(k, np.array(pos), 1)
    return float(first), float(d)


def _find_lines(prof: np.ndarray, extent: int, lineal_len: float,
                d_min: float, d_max: float, d_hint: float | None = None) -> _Lines | None:
    """Find the best set of 7 equally spaced interior grid lines in a profile.

    lineal_len: number of pixels summed per line (used to normalise strength).
    """
    peaks = _peaks(prof)
    # Every candidate grid: two peaks a < b that are k lines apart, with a as line idx.
    # Enumerated in the same order as the nested loops this replaces, so that
    # argmax (first maximum) breaks ties the same way.
    firsts, ds = [], []
    for a in peaks:
        for b in peaks:
            if b <= a:
                continue
            for k in range(1, 7):
                d = (b - a) / k
                if d < d_min or d > d_max:
                    continue
                if d_hint is not None and abs(d - d_hint) > 0.06 * d_hint:
                    continue
                for idx in range(0, 7 - k):
                    first = a - idx * d
                    if first - d < -0.15 * d or first + 7 * d > extent - 1 + 0.15 * d:
                        continue
                    firsts.append(first)
                    ds.append(d)
    if not firsts:
        return None
    firsts_a, ds_a = np.array(firsts), np.array(ds)
    tols = np.maximum(1, np.round(0.04 * ds_a).astype(int))
    centres = np.round(firsts_a[:, None] + ds_a[:, None] * np.arange(7)).astype(int)
    # _support() for all candidates at once: windowed max of the profile. The profile
    # is >= 0, so zero padding reproduces its clipping at the ends exactly.
    pad = len(prof) + int(tols.max()) + 2
    padded = np.concatenate([np.zeros(pad, np.float32), prof.astype(np.float32), np.zeros(pad, np.float32)])
    metric = np.empty(len(firsts), dtype=np.float32)
    for tol in np.unique(tols):
        sel = tols == tol
        wmax = np.lib.stride_tricks.sliding_window_view(padded, 2 * tol + 1).max(axis=1)
        vals = wmax[np.clip(centres[sel] + pad - tol, 0, len(wmax) - 1)]
        metric[sel] = np.sort(vals, axis=1)[:, :5].sum(axis=1)  # robust: all lines must be present
    i = int(np.argmax(metric))
    first, d, tol = firsts[i], ds[i], int(tols[i])
    first, d = _refine(prof, first + d * np.arange(7), tol)
    vals = _support(prof, first + d * np.arange(7), max(1, int(round(0.04 * d))))
    # Sobel step response is ~4*contrast per pixel row; normalise to "grey levels"
    strength = float(vals.min()) / (4.0 * max(lineal_len, 1.0))
    return _Lines(first=first, d=d, strength=strength)


def _checker_score(gray: np.ndarray, g: BoardGeometry) -> float:
    """How strongly the found grid alternates light/dark (0 = not at all).

    Uses a thin ring near each square's border, where pieces rarely reach.
    """
    vals = np.zeros((8, 8), dtype=np.float32)
    H, W = gray.shape
    for r in range(8):
        for c in range(8):
            x, y, w, h = g.square_rect(r, c)
            m = max(1, int(0.08 * w))
            x0, y0 = int(round(x)) + m, int(round(y)) + m
            x1, y1 = int(round(x + w)) - m, int(round(y + h)) - m
            x0, y0, x1, y1 = max(0, x0), max(0, y0), min(W, x1), min(H, y1)
            if x1 - x0 < 3 or y1 - y0 < 3:
                return 0.0
            patch = gray[y0:y1, x0:x1]
            t = max(1, int(0.12 * w))
            ring = np.concatenate([patch[:t].ravel(), patch[-t:].ravel(),
                                   patch[:, :t].ravel(), patch[:, -t:].ravel()])
            vals[r, c] = np.median(ring)
    parity = (np.add.outer(np.arange(8), np.arange(8)) % 2).astype(bool)
    a, b = vals[~parity], vals[parity]
    spread = np.concatenate([a - np.median(a), b - np.median(b)]).std() + 1.0
    return float(abs(np.median(a) - np.median(b)) / spread)


def detect_board(img_bgr: np.ndarray, min_square_px: int = 10) -> BoardGeometry:
    gray = cv2.cvtColor(img_bgr, cv2.COLOR_BGR2GRAY).astype(np.float32)
    H, W = gray.shape
    d_max = min(H, W) / 8.0 + 1.0

    # pass 1: whole image, both axes
    lx = _find_lines(_bipolar_profile(gray, 0), W, H, min_square_px, d_max)
    ly = _find_lines(_bipolar_profile(gray, 1), H, W, min_square_px, d_max)
    if lx is None and ly is None:
        raise BoardNotFound("no checkerboard grid found")

    # passes 2-3: restrict each axis to the other's span (removes UI clutter)
    for _ in range(2):
        if lx is not None:
            x0 = int(max(0, lx.first - lx.d)); x1 = int(min(W, lx.first + 7 * lx.d))
            strip = gray[:, x0:x1]
            ly = _find_lines(_bipolar_profile(strip, 1), H, x1 - x0, min_square_px, d_max,
                             d_hint=lx.d) or ly
        if ly is not None:
            y0 = int(max(0, ly.first - ly.d)); y1 = int(min(H, ly.first + 7 * ly.d))
            strip = gray[y0:y1, :]
            lx = _find_lines(_bipolar_profile(strip, 0), W, y1 - y0, min_square_px, d_max,
                             d_hint=ly.d) or lx
        if lx is None or ly is None:
            raise BoardNotFound("grid found along one axis only")

    # +0.5: a Sobel peak at index i marks the boundary between pixels i and i+1
    geom = BoardGeometry(x0=lx.first - lx.d + 0.5, y0=ly.first - ly.d + 0.5,
                         dx=lx.d, dy=ly.d)
    aspect = geom.dx / geom.dy
    if not 0.9 < aspect < 1.1:
        raise BoardNotFound(f"grid is not square (aspect {aspect:.2f})")
    if min(lx.strength, ly.strength) < 2.0:
        raise BoardNotFound("grid lines too weak")
    chk = _checker_score(gray, geom)
    geom.confidence = float(min(1.0, chk / 4.0))
    if chk < 1.5:
        raise BoardNotFound(f"found a grid but squares do not alternate (score {chk:.2f})")
    return geom


def geometry_from_bbox(x: float, y: float, w: float, h: float) -> BoardGeometry:
    return BoardGeometry(x0=x, y0=y, dx=w / 8.0, dy=h / 8.0)
