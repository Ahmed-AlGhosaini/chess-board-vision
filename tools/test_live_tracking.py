"""Regression test for live games: screen-capture move tracking and Lichess link parsing.

Renders known games frame by frame (one frame per position, like a capture of
a Lichess board), feeds every frame to server.vision.track_frame and checks
that exactly the game's moves come back. Also drops frames, so that two moves
have to be recovered from one frame; then only the positions must agree, since
e.g. c2c3 d4xc3 and c2c4 d4xc3 (en passant) end in the same picture.

    python tools/test_live_tracking.py
"""
import io
import sys
from pathlib import Path

import chess
import numpy as np

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from chessvision.pieces import ensure_piece_sets, load_piece_set  # noqa: E402
from chessvision.recognize import square_to_image  # noqa: E402
from chessvision.synth import render_board  # noqa: E402
from server import live, vision  # noqa: E402

PIECES = str(ROOT / "assets" / "pieces")

GAMES = [
    # castling both sides, en passant, promotion to queen and to knight
    dict(name="castles_ep_promo", set="cburnett", theme=((240, 217, 181), (181, 136, 99)), sq=60, wab=True,
         moves="e4 d5 e5 f5 exf6 Nc6 fxg7 Be6 gxh8=N Qd7 Nf3 O-O-O Bb5 d4 c4 dxc3 O-O cxb2 Nf7 bxa1=Q Nxd8 Kxd8"),
    dict(name="sicilian_flipped", set="merida", theme=((222, 227, 230), (140, 162, 173)), sq=52, wab=False,
         moves="e4 c5 Nf3 d6 d4 cxd4 Nxd4 Nf6 Nc3 a6 Be3 e5 Nb3 Be6 f3 Be7 Qd2 O-O O-O-O Nbd7 g4 b5"),
]


def placement(board, wab):
    g = [[None] * 8 for _ in range(8)]
    for sq, p in board.piece_map().items():
        r, c = square_to_image(sq, wab)
        g[r][c] = ("w" if p.color else "b") + p.symbol().upper()
    return g


def frame(board, case, rng) -> bytes:
    lm = None
    if board.move_stack:
        mv = board.peek()
        lm = (square_to_image(mv.from_square, case["wab"]), square_to_image(mv.to_square, case["wab"]))
    img, _ = render_board(load_piece_set(PIECES, case["set"]), case["sq"], rng, placement=placement(board, case["wab"]),
                          theme=case["theme"], highlights=True, coords=True, last_move=lm, piece_jitter=False)
    buf = io.BytesIO()
    img.convert("RGB").save(buf, "JPEG", quality=90)  # the UI sends JPEG crops
    return buf.getvalue()


def run(case, step: int) -> list[str]:
    """Track a game seeing only every `step`-th position (1 = every frame)."""
    rng = np.random.default_rng(0)
    truth = chess.Board()
    for san in case["moves"].split():
        truth.push_san(san)
    replay = chess.Board()
    fen, found = replay.fen(), []
    orientation = "white" if case["wab"] else "black"
    for i, mv in enumerate(truth.move_stack, 1):
        replay.push(mv)
        if i % step and i != len(truth.move_stack):
            continue  # this frame is never seen
        r = vision.track_frame(frame(replay, case, rng), None, orientation, fen)
        assert r["status"] == "moves", f"{case['name']} ply {i}: {r['status']} (uncertain {r['uncertain']})"
        assert r["fen"].split()[:2] == replay.fen().split()[:2], f"{case['name']} ply {i}: {r['moves']}"
        found += r["moves"]
        fen = r["fen"]
    # a repeated frame of the final position changes nothing
    r = vision.track_frame(frame(replay, case, rng), None, orientation, fen)
    assert r["status"] == "same", r
    return found


def test_tracking():
    ensure_piece_sets(PIECES, sorted({c["set"] for c in GAMES}), verbose=False)
    for case in GAMES:
        expected = []
        b = chess.Board()
        for san in case["moves"].split():
            expected.append(b.push_san(san).uci())
        for step in (1, 2):
            got = run(case, step)
            if step == 1:
                assert got == expected, f"{case['name']}:\n got      {got}\n expected {expected}"
            print(f"ok  {case['name']:<18} every {'' if step == 1 else '2nd '}frame: {len(got)} moves")


def test_unknown():
    """A frame that no short sequence of legal moves explains is reported, not guessed."""
    ensure_piece_sets(PIECES, ["cburnett"], verbose=False)
    case = GAMES[0]
    b = chess.Board()
    for san in "e4 e5 Nf3 Nc6 Bb5 a6".split():
        b.push_san(san)
    r = vision.track_frame(frame(b, case, np.random.default_rng(1)), None, "white", chess.STARTING_FEN)
    assert r["status"] == "unknown", r
    print("ok  six moves at once -> unknown")


def test_links():
    cases = {
        "ZcaR9owR": {"kind": "game", "id": "ZcaR9owR"},
        "https://lichess.org/ZcaR9owRab12": {"kind": "game", "id": "ZcaR9owR"},
        "lichess.org/ZcaR9owR/black#12": {"kind": "game", "id": "ZcaR9owR"},
        "https://lichess.org/embed/game/ZcaR9owR": None,
        "https://lichess.org/tv": {"kind": "tv", "channel": None},
        "https://lichess.org/tv/blitz": {"kind": "tv", "channel": "blitz"},
        "https://lichess.org/broadcast/stockholms-gp-2026/round-8/kVjdumLW/yHXrbHee":
            {"kind": "broadcast", "tour": None, "round": "kVjdumLW", "game": "yHXrbHee"},
        "https://lichess.org/broadcast/stockholms-gp-2026/round-8/kVjdumLW":
            {"kind": "broadcast", "tour": None, "round": "kVjdumLW", "game": None},
        "https://lichess.org/broadcast/stockholms-gp-2026/4hzvh9Z3":
            {"kind": "broadcast", "tour": "4hzvh9Z3", "round": None, "game": None},
        "https://www.chess.com/game/live/123": None,
        "": None,
    }
    for text, want in cases.items():
        try:
            got = live.parse_source(text)
        except ValueError:
            got = None
        assert got == want, f"{text!r}: {got} != {want}"
    print(f"ok  {len(cases)} Lichess links parsed")


if __name__ == "__main__":
    test_links()
    test_unknown()
    test_tracking()
    print("all live tests passed")
