"""Whose move is it? Read it off the highlighted last move, if the board shows one.

Sites tint the from- and to-square of the last move. Each square's background
is sampled from a band just inside its edges (where pieces rarely reach) and
compared with the usual colour of light and dark squares; the two squares that
stand out are the last move, and the piece now standing on one of them shows
which side has just moved.
"""
from __future__ import annotations

from dataclasses import dataclass

import chess
import numpy as np
from PIL import Image

from .board_detect import BoardGeometry
from .recognize import grid_to_board

INNER, OUTER = 0.16, 0.05  # sample band, as fractions of the square inset from its edges
MIN_SHIFT = 28.0           # RGB distance from the usual square colour that counts as a tint
SPREAD = 6.0               # ... and how many times the typical square's own deviation it must exceed


@dataclass
class LastMove:
    squares: list[tuple[int, int]]  # image row/col of the highlighted squares
    mover: chess.Color               # the side that played it

    @property
    def turn(self) -> chess.Color:
        return not self.mover


def square_backgrounds(img: Image.Image, geom: BoardGeometry) -> np.ndarray:
    """(8,8,3) median colour of a band just inside each square's border."""
    a = np.asarray(img.convert("RGB"), np.float32)
    H, W = a.shape[:2]
    out = np.zeros((8, 8, 3), np.float32)
    for r in range(8):
        for c in range(8):
            x, y, w, h = geom.square_rect(r, c)
            x0, y0 = int(round(x + w * OUTER)), int(round(y + h * OUTER))
            x1, y1 = int(round(x + w * (1 - OUTER))), int(round(y + h * (1 - OUTER)))
            ix, iy = max(1, int(round(w * INNER))), max(1, int(round(h * INNER)))
            x0, y0, x1, y1 = max(0, x0), max(0, y0), min(W, x1), min(H, y1)
            if x1 - x0 <= 2 * ix or y1 - y0 <= 2 * iy:
                out[r, c] = np.nan
                continue
            sq = a[y0:y1, x0:x1]
            band = np.concatenate([sq[:iy].reshape(-1, 3), sq[-iy:].reshape(-1, 3),
                                   sq[iy:-iy, :ix].reshape(-1, 3), sq[iy:-iy, -ix:].reshape(-1, 3)])
            out[r, c] = np.median(band, axis=0)
    return out


def highlighted_squares(bg: np.ndarray) -> list[tuple[int, int]]:
    """Squares whose background differs clearly from the other squares of their colour."""
    out = []
    for parity in (0, 1):
        cells = [(r, c) for r in range(8) for c in range(8) if (r + c) % 2 == parity]
        cols = np.array([bg[r, c] for r, c in cells])
        if np.isnan(cols).any():
            return []
        dist = np.linalg.norm(cols - np.median(cols, axis=0), axis=1)
        limit = max(MIN_SHIFT, SPREAD * float(np.median(dist)))
        out += [cell for cell, d in zip(cells, dist) if d > limit]
    return out


def _colour(code: str | None) -> chess.Color | None:
    return None if not code else code[0] == "w"


def _mover(grid, a: tuple[int, int], b: tuple[int, int]) -> chess.Color | None:
    pa, pb = grid[a[0]][a[1]], grid[b[0]][b[1]]
    if bool(pa) != bool(pb):  # from-square empty, to-square holds the piece that moved
        return _colour(pa or pb)
    if pa and pb:  # both occupied (e.g. castling shown as king-takes-rook): only if one side
        return _colour(pa) if _colour(pa) == _colour(pb) else None
    # both empty: castling highlighted as king square -> rook square; the king now stands between
    if a[0] == b[0]:
        for c in range(min(a[1], b[1]) + 1, max(a[1], b[1])):
            if grid[a[0]][c] and grid[a[0]][c][1] == "K":
                return _colour(grid[a[0]][c])
    return None


def detect_last_move(img: Image.Image, geom: BoardGeometry, grid: list[list[str | None]],
                     white_at_bottom: bool) -> LastMove | None:
    """The highlighted last move and who played it, or None if the board shows none (or it is unclear)."""
    lit = highlighted_squares(square_backgrounds(img, geom))
    if len(lit) > 2:  # a check is usually marked on the king's square too
        lit = [(r, c) for r, c in lit if not (grid[r][c] and grid[r][c][1] == "K")]
    if len(lit) != 2:
        return None
    mover = _mover(grid, *lit)
    if mover is None:
        return None
    # the side that has just moved cannot be left in check
    board = grid_to_board(grid, white_at_bottom, not mover)
    if board.status() & chess.STATUS_OPPOSITE_CHECK:
        return None
    return LastMove(squares=lit, mover=mover)
