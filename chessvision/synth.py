"""Synthetic training data: random boards in random themes, cut into squares.

Every board gets a random piece set, square colours, size, highlights
(last move, check, selection, move dots), in-board coordinates, texture and
compression noise, so the classifier learns "what piece is on this square"
rather than the look of one specific theme.
"""
from __future__ import annotations

import colorsys
import io

import numpy as np
from PIL import Image, ImageDraw, ImageFilter, ImageFont

from . import CLASSES, INPUT_SIZE, PIECE_CODES

LICHESS_THEMES = [
    ((240, 217, 181), (181, 136, 99)),   # brown (default)
    ((222, 227, 230), (140, 162, 173)),  # blue
    ((255, 255, 221), (134, 166, 102)),  # green
    ((236, 236, 236), (193, 193, 142)),  # ic
    ((159, 144, 176), (125, 74, 141)),   # purple
    ((238, 238, 210), (118, 150, 86)),   # green 2
    ((232, 235, 239), (125, 135, 150)),  # slate
    ((255, 206, 158), (209, 139, 71)),   # orange-brown
    ((200, 200, 200), (130, 130, 130)),  # grey
    ((234, 233, 210), (75, 115, 153)),   # blue 2
]
HIGHLIGHT_COLOURS = [(155, 199, 0), (205, 210, 106), (170, 162, 58), (246, 246, 105), (100, 150, 220)]
RESAMPLE = [Image.BILINEAR, Image.BICUBIC, Image.LANCZOS, Image.BOX]

_FONT_CACHE: dict[int, ImageFont.ImageFont] = {}


def _font(size: int):
    if size in _FONT_CACHE:
        return _FONT_CACHE[size]
    f = None
    for name in ("DejaVuSans-Bold.ttf", "arialbd.ttf", "Arial Bold.ttf", "LiberationSans-Bold.ttf"):
        try:
            f = ImageFont.truetype(name, size)
            break
        except OSError:
            pass
    if f is None:
        try:
            f = ImageFont.load_default(size=size)
        except TypeError:
            f = ImageFont.load_default()
    _FONT_CACHE[size] = f
    return f


def random_theme(rng: np.random.Generator):
    if rng.random() < 0.5:
        light, dark = LICHESS_THEMES[rng.integers(len(LICHESS_THEMES))]
    else:
        h = rng.random()
        light = colorsys.hsv_to_rgb(h, rng.uniform(0.0, 0.35), rng.uniform(0.75, 1.0))
        dark = colorsys.hsv_to_rgb((h + rng.uniform(-0.08, 0.08)) % 1, rng.uniform(0.15, 0.7),
                                   rng.uniform(0.35, 0.7))
        light = tuple(int(255 * v) for v in light)
        dark = tuple(int(255 * v) for v in dark)
    if rng.random() < 0.15:  # sometimes "dark" is the lighter one; don't rely on it
        light, dark = dark, light
    return light, dark


def _texture(size: int, rng: np.random.Generator) -> np.ndarray:
    """Low-frequency noise, optionally streaky (wood-like). Returns HxW float in [-1,1]."""
    if rng.random() < 0.5:
        small = rng.standard_normal((rng.integers(3, 12), rng.integers(3, 12))).astype(np.float32)
    else:  # streaks
        small = rng.standard_normal((rng.integers(2, 5), rng.integers(30, 90))).astype(np.float32)
        if rng.random() < 0.5:
            small = small.T
    img = Image.fromarray(small).resize((size, size), Image.BICUBIC)
    arr = np.asarray(img, dtype=np.float32)
    return arr / (np.abs(arr).max() + 1e-6)


def _overlay(base: Image.Image, box, colour, alpha: float, shape: str = "rect"):
    x0, y0, x1, y1 = [int(round(v)) for v in box]
    layer = Image.new("RGBA", base.size, (0, 0, 0, 0))
    d = ImageDraw.Draw(layer)
    a = int(255 * alpha)
    if shape == "rect":
        d.rectangle([x0, y0, x1 - 1, y1 - 1], fill=colour + (a,))
    elif shape == "dot":
        cx, cy, r = (x0 + x1) / 2, (y0 + y1) / 2, (x1 - x0) * 0.14
        d.ellipse([cx - r, cy - r, cx + r, cy + r], fill=colour + (a,))
    elif shape == "corners":  # Lichess "capture" hint: coloured corners, clear centre
        d.rectangle([x0, y0, x1 - 1, y1 - 1], fill=colour + (a,))
        r = (x1 - x0) * 0.56
        cx, cy = (x0 + x1) / 2, (y0 + y1) / 2
        d.ellipse([cx - r, cy - r, cx + r, cy + r], fill=(0, 0, 0, 0))
    elif shape == "check":
        n = x1 - x0
        yy, xx = np.mgrid[0:n, 0:n]
        dist = np.hypot(xx - n / 2, yy - n / 2) / (n / 2 * 1.2)
        al = np.clip(1.0 - dist, 0, 1) ** 0.8 * a
        rgba = np.zeros((n, n, 4), np.uint8)
        rgba[..., 0] = 231
        rgba[..., 3] = al.astype(np.uint8)
        layer.paste(Image.fromarray(rgba, "RGBA"), (x0, y0))
    base.alpha_composite(layer)


def render_board(piece_set: dict[str, Image.Image], sq: int, rng: np.random.Generator,
                 placement: list[list[str | None]] | None = None,
                 theme=None, occupancy: float | None = None,
                 highlights: bool = True, coords: bool | None = None,
                 last_move: tuple[tuple[int, int], tuple[int, int]] | None = None,
                 piece_jitter: bool = True):
    """Render an 8x8 board image (RGB, size 8*sq) and return (image, labels).

    placement[row][col] is a piece code ('wK', ...) or None, row 0 = top of image.
    labels are class indices in the same layout.
    """
    light, dark = theme or random_theme(rng)
    B = 8 * sq
    board = np.zeros((B, B, 3), np.float32)
    for r in range(8):
        for c in range(8):
            board[r * sq:(r + 1) * sq, c * sq:(c + 1) * sq] = light if (r + c) % 2 == 0 else dark
    if placement is None and rng.random() < 0.35:  # textured (wood/marble-ish) boards
        board += _texture(B, rng)[..., None] * rng.uniform(5, 28)
    img = Image.fromarray(np.clip(board, 0, 255).astype(np.uint8)).convert("RGBA")

    if placement is None:
        occ = occupancy if occupancy is not None else rng.uniform(0.15, 0.7)
        placement = [[PIECE_CODES[rng.integers(12)] if rng.random() < occ else None
                      for _ in range(8)] for _ in range(8)]

    def box(r, c):
        return (c * sq, r * sq, (c + 1) * sq, (r + 1) * sq)

    if highlights:
        if last_move is not None:
            col = (155, 199, 0)
            for (r, c) in last_move:
                _overlay(img, box(r, c), col, 0.41)
        elif rng.random() < 0.7:
            col = HIGHLIGHT_COLOURS[rng.integers(len(HIGHLIGHT_COLOURS))]
            a = rng.uniform(0.3, 0.6)
            for _ in range(2):
                _overlay(img, box(rng.integers(8), rng.integers(8)), col, a)
        if last_move is None and rng.random() < 0.15:
            kings = [(r, c) for r in range(8) for c in range(8) if placement[r][c] in ("wK", "bK")]
            if kings:
                _overlay(img, box(*kings[rng.integers(len(kings))]), (231, 0, 0), 1.0, "check")
        if last_move is None and rng.random() < 0.2:  # a piece is selected: show its moves
            _overlay(img, box(rng.integers(8), rng.integers(8)), (20, 85, 30), 0.5)
            for _ in range(rng.integers(2, 10)):
                r, c = rng.integers(8), rng.integers(8)
                _overlay(img, box(r, c), (20, 85, 30), 0.5,
                         "corners" if placement[r][c] else "dot")

    if coords is None:
        coords = rng.random() < 0.6
    if coords:
        d = ImageDraw.Draw(img)
        fsize = max(6, int(sq * rng.uniform(0.17, 0.26)))
        f = _font(fsize)
        files = "abcdefgh" if rng.random() < 0.5 else "hgfedcba"
        ranks = "87654321" if files[0] == "a" else "12345678"
        right = rng.random() < 0.5
        for c in range(8):  # file letters along the bottom row
            colr = dark if (7 + c) % 2 == 0 else light
            d.text((c * sq + sq - fsize * 0.8, 8 * sq - fsize * 1.25), files[c], fill=colr, font=f)
        for r in range(8):  # rank numbers along one side
            cc = 7 if right else 0
            colr = dark if (r + cc) % 2 == 0 else light
            x = cc * sq + (sq - fsize * 0.75 if right else fsize * 0.15)
            d.text((x, r * sq + fsize * 0.1), ranks[r], fill=colr, font=f)

    labels = np.zeros((8, 8), np.int64)
    for r in range(8):
        for c in range(8):
            code = placement[r][c]
            if not code:
                continue
            labels[r, c] = CLASSES.index(code)
            s = int(round(sq * (rng.uniform(0.86, 1.0) if piece_jitter else 1.0)))
            p = piece_set[code].resize((s, s), Image.LANCZOS)
            jx = int(round(rng.uniform(-0.03, 0.03) * sq)) if piece_jitter else 0
            jy = int(round(rng.uniform(-0.03, 0.03) * sq)) if piece_jitter else 0
            img.alpha_composite(p, (c * sq + (sq - s) // 2 + jx, r * sq + (sq - s) // 2 + jy))
    return img.convert("RGB"), labels


def _degrade(img: Image.Image, rng: np.random.Generator) -> Image.Image:
    if rng.random() < 0.25:
        img = img.filter(ImageFilter.GaussianBlur(rng.uniform(0.3, 1.0)))
    if rng.random() < 0.35:
        buf = io.BytesIO()
        img.save(buf, "JPEG", quality=int(rng.integers(35, 95)))
        img = Image.open(io.BytesIO(buf.getvalue())).convert("RGB")
    arr = np.asarray(img, np.float32)
    arr = (arr - 128) * rng.uniform(0.85, 1.15) + 128 + rng.uniform(-18, 18)
    if rng.random() < 0.2:
        arr += rng.normal(0, rng.uniform(2, 8), arr.shape)
    return Image.fromarray(np.clip(arr, 0, 255).astype(np.uint8))


def board_to_squares(img: Image.Image, sq: float, rng: np.random.Generator | None = None,
                     jitter: float = 0.0, offset: tuple[float, float] = (0, 0)) -> np.ndarray:
    """Cut a board image into 64 INPUT_SIZE crops (row-major, row 0 = top)."""
    out = np.zeros((64, INPUT_SIZE, INPUT_SIZE, 3), np.uint8)
    ox, oy = offset
    for r in range(8):
        for c in range(8):
            x, y, s = ox + c * sq, oy + r * sq, sq
            if rng is not None and jitter > 0:
                x += rng.uniform(-jitter, jitter) * sq
                y += rng.uniform(-jitter, jitter) * sq
                s *= 1 + rng.uniform(-jitter, jitter) * 0.7
            res = RESAMPLE[rng.integers(len(RESAMPLE))] if rng is not None else Image.BILINEAR
            crop = img.resize((INPUT_SIZE, INPUT_SIZE), res, box=(x, y, x + s, y + s))
            out[r * 8 + c] = np.asarray(crop)
    return out


def make_dataset(piece_sets: dict[str, dict[str, Image.Image]], n_boards: int, seed: int = 0):
    """Return X (N,32,32,3) uint8, y (N,) int64, set_idx (N,) int16."""
    rng = np.random.default_rng(seed)
    names = list(piece_sets)
    X = np.zeros((n_boards * 64, INPUT_SIZE, INPUT_SIZE, 3), np.uint8)
    y = np.zeros(n_boards * 64, np.int64)
    sidx = np.zeros(n_boards * 64, np.int16)
    for i in range(n_boards):
        si = int(rng.integers(len(names)))
        sq = int(rng.integers(22, 110))
        board, labels = render_board(piece_sets[names[si]], sq, rng)
        pad = sq // 2
        canvas = Image.new("RGB", (8 * sq + 2 * pad, 8 * sq + 2 * pad),
                           tuple(int(v) for v in rng.integers(0, 256, 3)))
        canvas.paste(board, (pad, pad))
        canvas = _degrade(canvas, rng)
        X[i * 64:(i + 1) * 64] = board_to_squares(canvas, sq, rng, jitter=0.05, offset=(pad, pad))
        y[i * 64:(i + 1) * 64] = labels.ravel()
        sidx[i * 64:(i + 1) * 64] = si
    return X, y, sidx


def _gen_chunk(args):
    from .pieces import load_piece_set
    pieces_dir, sets, n, seed = args
    ps = {s: load_piece_set(pieces_dir, s) for s in sets}
    X, y, sidx = make_dataset(ps, n, seed=seed)
    return X, y, np.array(sets)[sidx]


def make_dataset_parallel(pieces_dir, sets, n_boards: int, seed: int, workers: int = 2):
    """make_dataset split over processes. Returns X, y, set_name (N,) str."""
    import concurrent.futures as cf
    chunks = max(1, workers * 2)
    sizes = [n_boards // chunks + (1 if i < n_boards % chunks else 0) for i in range(chunks)]
    jobs = [(str(pieces_dir), list(sets), n, seed * 1000 + i) for i, n in enumerate(sizes) if n]
    with cf.ProcessPoolExecutor(workers) as ex:
        parts = list(ex.map(_gen_chunk, jobs))
    return (np.concatenate([p[0] for p in parts]), np.concatenate([p[1] for p in parts]),
            np.concatenate([p[2] for p in parts]))
