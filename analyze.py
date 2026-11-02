#!/usr/bin/env python3
"""Find the chessboard in a screenshot, read the position, and draw the
engine's top moves as arrows.

    python analyze.py position.png --turn w
    python analyze.py photo.png --turn b --orientation black --time 3
"""
from __future__ import annotations

import argparse
import sys
from pathlib import Path

import chess
import cv2
import numpy as np
from PIL import Image

from chessvision.board_detect import BoardNotFound, detect_board, geometry_from_bbox
from chessvision.draw import annotate
from chessvision.engine import find_engine, top_moves
from chessvision.model import SquareClassifier
from chessvision.recognize import recognise

HERE = Path(__file__).resolve().parent


def save_debug(img: Image.Image, geom, rec, path: Path):
    """Board crop with the predicted label and confidence drawn on each square."""
    from PIL import ImageDraw
    from chessvision.synth import _font
    x, y, w, h = geom.bbox
    crop = img.crop((x, y, x + w, y + h)).resize((640, 640), Image.LANCZOS)
    d = ImageDraw.Draw(crop)
    f = _font(14)
    for r in range(8):
        for c in range(8):
            d.rectangle([c * 80, r * 80, c * 80 + 79, r * 80 + 79], outline=(255, 0, 255))
            lab = rec.grid[r][c] or "."
            conf = rec.confidence[r, c]
            col = (255, 0, 0) if conf < 0.8 else (255, 0, 255)
            d.text((c * 80 + 3, r * 80 + 2), f"{lab} {conf:.2f}", fill=col, font=f,
                   stroke_width=2, stroke_fill=(255, 255, 255))
    crop.save(path)


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("image")
    ap.add_argument("--turn", choices=["w", "b"], default=None,
                    help="side to move (cannot be read from a picture; default: white)")
    ap.add_argument("--orientation", choices=["auto", "white", "black"], default="auto",
                    help="which side is at the bottom of the picture")
    ap.add_argument("--bbox", help="skip detection: x,y,w,h of the board in pixels")
    ap.add_argument("--lines", type=int, default=3, help="number of moves to show (max 3 arrows)")
    ap.add_argument("--time", type=float, default=1.5, help="engine think time in seconds")
    ap.add_argument("--depth", type=int, default=None, help="search depth instead of time")
    ap.add_argument("--engine", default=None, help="path to Stockfish (or set STOCKFISH_PATH)")
    ap.add_argument("--model", default=str(HERE / "models" / "squarenet.npz"))
    ap.add_argument("--out", default=None, help="output image (default: <image>_analysis.png)")
    ap.add_argument("--fen-only", action="store_true", help="just print the recognised FEN")
    ap.add_argument("--debug", action="store_true", help="also save a labelled board crop")
    args = ap.parse_args()

    img = Image.open(args.image).convert("RGB")
    bgr = cv2.cvtColor(np.asarray(img), cv2.COLOR_RGB2BGR)

    if args.bbox:
        geom = geometry_from_bbox(*[float(v) for v in args.bbox.split(",")])
    else:
        try:
            geom = detect_board(bgr)
        except BoardNotFound as e:
            sys.exit(f"Could not find the board ({e}). Crop the screenshot closer to the board "
                     f"or pass --bbox x,y,w,h.")
    print(f"board at x={geom.x0:.0f} y={geom.y0:.0f}, size {8 * geom.dx:.0f}x{8 * geom.dy:.0f}px")

    turn = chess.BLACK if args.turn == "b" else chess.WHITE
    wab = {"auto": None, "white": True, "black": False}[args.orientation]
    rec = recognise(img, geom, SquareClassifier(args.model), turn=turn, white_at_bottom=wab)
    board = rec.board

    # letters (uppercase = White), drawn the way the screenshot shows the board
    shown = board if rec.white_at_bottom else board.transform(chess.flip_vertical).transform(chess.flip_horizontal)
    print()
    print(str(shown))
    print()
    print(f"FEN:      {board.fen()}")
    print(f"Lichess:  https://lichess.org/analysis/standard/{board.fen().replace(' ', '_')}")
    print(f"View:     {'white' if rec.white_at_bottom else 'black'} at the bottom"
          + (" (auto-detected)" if wab is None else ""))
    if args.turn is None:
        print("To move:  white (assumed - pass --turn b if it is Black's move)")
    unsure = rec.uncertain_squares()
    if unsure:
        print(f"Unsure about: {', '.join(unsure)} - check these squares")
    if args.debug:
        dbg = Path(args.image).with_name(Path(args.image).stem + "_debug.png")
        save_debug(img, geom, rec, dbg)
        print(f"debug crop: {dbg}")
    if rec.warnings or not board.is_valid():
        sys.exit("Position is not legal: " + "; ".join(rec.warnings or ["invalid position"])
                 + ". Fix the FEN in the Lichess link above, or try --orientation/--turn.")
    if args.fen_only:
        return
    if board.is_game_over():
        print(f"Game over: {board.result()} ({board.outcome().termination.name.lower()})")
        return

    cands = top_moves(board, find_engine(args.engine), n=args.lines, seconds=args.time, depth=args.depth)
    print(f"\nStockfish, depth {cands[0].depth if cands else '?'} (eval from White's side):")
    for i, c in enumerate(cands, 1):
        print(f"{i}. {c.san:<8} {c.eval_text():>7}   {' '.join(c.pv_san)}")

    out = Path(args.out) if args.out else Path(args.image).with_name(Path(args.image).stem + "_analysis.png")
    annotate(img, geom, rec.white_at_bottom, cands).save(out)
    print(f"\nsaved {out}")


if __name__ == "__main__":
    main()
