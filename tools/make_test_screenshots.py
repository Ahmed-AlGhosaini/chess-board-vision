"""Render Lichess-like test screenshots with known positions (ground truth in JSON)."""
import io
import json
import sys
from pathlib import Path

import chess
import numpy as np
from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from chessvision.pieces import ensure_piece_sets, load_piece_set  # noqa: E402
from chessvision.recognize import square_to_image  # noqa: E402
from chessvision.synth import render_board, _font  # noqa: E402

OUT = Path(sys.argv[1] if len(sys.argv) > 1 else "test_screens")
OUT.mkdir(parents=True, exist_ok=True)
PIECES = str(ROOT / "assets" / "pieces")
ensure_piece_sets(PIECES, ["cburnett", "merida", "tatiana", "alpha"], verbose=False)


def placement(board, wab):
    g = [[None] * 8 for _ in range(8)]
    for sq, p in board.piece_map().items():
        r, c = square_to_image(sq, wab)
        g[r][c] = ("w" if p.color else "b") + p.symbol().upper()
    return g


def game(moves):
    b = chess.Board()
    for m in moves.split():
        b.push_san(m)
    return b


CASES = [
    dict(name="ruy_lopez_dark", moves="e4 e5 Nf3 Nc6 Bb5 a6 Ba4 Nf6 O-O Be7", set="cburnett",
         theme=((240, 217, 181), (181, 136, 99)), sq=75, wab=True, page=(22, 21, 18), size=(1440, 900),
         at=(380, 110), jpeg=None),
    dict(name="sicilian_flipped_light", moves="e4 c5 Nf3 d6 d4 cxd4 Nxd4 Nf6 Nc3 a6 Be3 e5 Nb3 Be6 f3 Be7 Qd2 O-O",
         set="merida", theme=((222, 227, 230), (140, 162, 173)), sq=64, wab=False, page=(245, 245, 245),
         size=(1366, 768), at=(330, 120), jpeg=None),
    dict(name="endgame_heldout_jpeg", moves="d4 d5 c4 e6 Nc3 Nf6 Bg5 Be7 e3 O-O Nf3 h6 Bxf6 Bxf6 cxd5 exd5 Bd3 c6 O-O Re8 Qc2 Nd7 b4 Nf8 b5 Bg4 bxc6 bxc6 Nd2 Rc8 Rab1 Qd6 Rb7 Re7 Rfb1 Be6 Qa4",
         set="tatiana", theme=((255, 255, 221), (134, 166, 102)), sq=52, wab=True, page=(38, 36, 33),
         size=(1100, 700), at=(140, 140), jpeg=70),
    dict(name="cropped_alpha_black", moves="e4 e6 d4 d5 Nc3 Bb4 e5 c5 a3 Bxc3+ bxc3 Ne7 Qg4 Qc7 Qxg7 Rg8 Qxh7 cxd4",
         set="alpha", theme=((236, 236, 236), (193, 193, 142)), sq=90, wab=False, page=None,
         size=None, at=(0, 0), jpeg=None),
]


def fake_ui(img, board_box, rng):
    d = ImageDraw.Draw(img)
    x, y, w, h = board_box
    W, H = img.size
    dark = sum(img.getpixel((5, 5))) < 300
    fg = (190, 190, 190) if dark else (60, 60, 60)
    panel = tuple(min(255, v + 18) if dark else max(0, v - 12) for v in img.getpixel((5, 5)))
    d.rectangle([0, 0, W, 48], fill=panel)
    d.text((20, 14), "lichess.org    PLAY   PUZZLES   LEARN   WATCH   COMMUNITY   TOOLS", fill=fg, font=_font(16))
    px = x + w + 30
    d.rectangle([px, y, min(W - 20, px + 360), y + h], fill=panel)
    d.text((px + 15, y + 15), "opponent_42   1873", fill=fg, font=_font(16))
    d.rectangle([px + 15, y + 50, px + 140, y + 95], fill=(60, 60, 60) if dark else (220, 220, 220))
    d.text((px + 25, y + 58), "4:31", fill=fg, font=_font(26))
    for i in range(12):
        d.text((px + 15, y + 120 + i * 24), f"{i + 1}   Nf{rng.integers(1, 9)}   e{rng.integers(1, 9)}xd5+",
               fill=fg, font=_font(15))
    d.text((px + 15, y + h - 30), "you   1902", fill=fg, font=_font(16))
    lx = max(10, x - 300)
    if x > 300:
        d.rectangle([lx, y + 40, x - 30, y + 300], fill=panel)
        for i in range(8):
            d.text((lx + 12, y + 60 + i * 26), "Chat room: good game, well played", fill=fg, font=_font(13))


truth = {}
rng = np.random.default_rng(7)
for c in CASES:
    b = game(c["moves"])
    last = b.peek()
    lm = (square_to_image(last.from_square, c["wab"]), square_to_image(last.to_square, c["wab"]))
    board_img, _ = render_board(load_piece_set(PIECES, c["set"]), c["sq"], rng,
                                placement=placement(b, c["wab"]), theme=c["theme"], highlights=True,
                                coords=True, last_move=lm, piece_jitter=False)
    if c["page"] is None:
        img = board_img
    else:
        img = Image.new("RGB", c["size"], c["page"])
        img.paste(board_img, c["at"])
        fake_ui(img, (*c["at"], board_img.width, board_img.height), rng)
    if c["jpeg"]:
        buf = io.BytesIO()
        img.save(buf, "JPEG", quality=c["jpeg"])
        img = Image.open(io.BytesIO(buf.getvalue())).convert("RGB")
    p = OUT / f"{c['name']}.png"
    img.save(p)
    truth[c["name"]] = dict(fen=b.board_fen(), turn="w" if b.turn else "b",
                            bbox=[*c["at"], 8 * c["sq"], 8 * c["sq"]], white_at_bottom=c["wab"])
    print(p, truth[c["name"]])
json.dump(truth, open(OUT / "truth.json", "w"), indent=1)
