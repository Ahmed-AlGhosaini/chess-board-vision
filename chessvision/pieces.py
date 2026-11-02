"""Download Lichess piece sets (SVG) and rasterise them to cached RGBA PNGs.

The piece sets live in the open-source Lichess repository:
  https://github.com/lichess-org/lila/tree/master/public/piece
Each set has its own licence (see lila's COPYING.md). They are downloaded to
your machine only to generate synthetic training data.
"""
from __future__ import annotations

import concurrent.futures as cf
import io
import re
import urllib.request
from pathlib import Path

from PIL import Image

from . import PIECE_CODES

LILA_PIECE_URL = "https://raw.githubusercontent.com/lichess-org/lila/master/public/piece/{set}/{code}.svg"

# Sets that look like real chess pieces in two colours. Excluded on purpose:
# 'disguised' (all pieces identical), 'mono' (one colour), 'letter', 'shapes'.
DEFAULT_SETS = [
    "cburnett", "merida", "alpha", "pirouetti", "chessnut", "chess7", "reillycraig",
    "companion", "riohacha", "kosal", "leipzig", "fantasy", "spatial", "celtic",
    "california", "caliente", "pixel", "maestro", "fresca", "cardinal", "gioco",
    "tatiana", "staunty", "governor", "dubrovny", "icpieces", "mpchess", "kiwen-suwi",
    "horsey", "anarcandy", "cooke", "rhosgfx", "firi", "monarchy", "libra", "xkcd",
]

RASTER_PX = 160


def _rasterise_svg(svg: bytes, size: int = RASTER_PX) -> Image.Image:
    # resvg (Rust, pip wheels for Win/macOS/Linux, no system cairo needed) handles
    # the CSS classes/gradients many Lichess sets use; MuPDF and others do not.
    import resvg_py

    text = svg.decode("utf-8", errors="replace")
    # some sets declare width="50mm"; drop absolute sizes and let the viewBox decide
    m = re.search(r"<svg\b[^>]*>", text)
    if m and "viewBox" in m.group(0):
        root = re.sub(r'\s(width|height)="[^"]*"', "", m.group(0))
        text = text[:m.start()] + root + text[m.end():]
    png = resvg_py.svg_to_bytes(svg_string=text, width=size)
    img = Image.open(io.BytesIO(bytes(png))).convert("RGBA")
    if max(img.size) != size:
        img.thumbnail((size, size), Image.LANCZOS)
    canvas = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    canvas.paste(img, ((size - img.width) // 2, (size - img.height) // 2))
    return canvas


def _fetch_one(set_name: str, code: str, dest: Path) -> bool:
    out = dest / set_name / f"{code}.png"
    if out.exists():
        return True
    url = LILA_PIECE_URL.format(set=set_name, code=code)
    try:
        with urllib.request.urlopen(url, timeout=30) as r:
            svg = r.read()
        img = _rasterise_svg(svg)
    except Exception:
        return False
    if img.getchannel("A").getbbox() is None:  # rendered nothing
        return False
    out.parent.mkdir(parents=True, exist_ok=True)
    img.save(out)
    return True


def ensure_piece_sets(dest: str | Path, sets: list[str] | None = None,
                      verbose: bool = True) -> list[str]:
    """Download + rasterise piece sets into dest/<set>/<code>.png.

    Returns the list of sets that are complete (all 12 pieces present).
    """
    dest = Path(dest)
    sets = sets or DEFAULT_SETS
    jobs = [(s, c) for s in sets for c in PIECE_CODES]
    with cf.ThreadPoolExecutor(max_workers=16) as ex:
        list(ex.map(lambda sc: _fetch_one(sc[0], sc[1], dest), jobs))
    complete = [s for s in sets if all((dest / s / f"{c}.png").exists() for c in PIECE_CODES)]
    if verbose:
        missing = sorted(set(sets) - set(complete))
        print(f"piece sets ready: {len(complete)}" + (f" (skipped: {', '.join(missing)})" if missing else ""))
    return complete


def load_piece_set(dest: str | Path, set_name: str) -> dict[str, Image.Image]:
    dest = Path(dest)
    return {c: Image.open(dest / set_name / f"{c}.png").convert("RGBA") for c in PIECE_CODES}


def contact_sheet(dest: str | Path, sets: list[str], out: str | Path, cell: int = 40) -> None:
    """Debug helper: one row per set, 12 pieces on a light/dark background."""
    sheet = Image.new("RGB", (cell * 12, cell * len(sets)), (240, 217, 181))
    for r, s in enumerate(sets):
        pcs = load_piece_set(dest, s)
        for c, code in enumerate(PIECE_CODES):
            bg = (240, 217, 181) if (r + c) % 2 == 0 else (181, 136, 99)
            tile = Image.new("RGBA", (cell, cell), bg + (255,))
            p = pcs[code].resize((cell, cell), Image.LANCZOS)
            tile.alpha_composite(p)
            sheet.paste(tile.convert("RGB"), (c * cell, r * cell))
    sheet.save(out)
