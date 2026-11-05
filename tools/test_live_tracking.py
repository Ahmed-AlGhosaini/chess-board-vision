"""Regression test for live games: screen-capture move tracking and Lichess link parsing.

Renders known games frame by frame (one frame per position, like a capture of
a Lichess board), feeds every frame to server.vision.track_frame and checks
that exactly the game's moves come back. Also drops frames, so that two moves
have to be recovered from one frame; then only the positions must agree, since
e.g. c2c3 d4xc3 and c2c4 d4xc3 (en passant) end in the same picture. Then what
keeps a capture fast and on the screen: reading only the squares that changed,
forgiving a misread square, reporting positions that follow from no move, and
evaluating the newest position first.

    python tools/test_live_tracking.py
"""
import io
import sys
import threading
import time
from pathlib import Path

import chess
import numpy as np
from PIL import Image

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from chessvision.pieces import ensure_piece_sets, load_piece_set  # noqa: E402
from chessvision.recognize import square_to_image  # noqa: E402
from chessvision.synth import render_board  # noqa: E402
from server import engines, live, vision  # noqa: E402

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


def still_frame(board, case) -> bytes:
    """A picture of the board that differs from another only where the boards do, unlike the randomised frames above."""
    sprites = load_piece_set(PIECES, case["set"])
    sq = case["sq"]
    light, dark = case["theme"]
    img = Image.new("RGB", (8 * sq, 8 * sq))
    lit = {board.peek().from_square, board.peek().to_square} if board.move_stack else set()
    for s in chess.SQUARES:
        r, c = square_to_image(s, case["wab"])
        colour = (205, 210, 106) if s in lit else light if (r + c) % 2 == 0 else dark
        img.paste(colour, (c * sq, r * sq, (c + 1) * sq, (r + 1) * sq))
        p = board.piece_at(s)
        if p:
            sprite = sprites[("w" if p.color else "b") + p.symbol().upper()].convert("RGBA").resize((sq, sq))
            img.paste(sprite, (c * sq, r * sq), sprite)
    buf = io.BytesIO()
    img.save(buf, "JPEG", quality=90)
    return buf.getvalue()


def test_session_reads_only_what_changed():
    """In a session, a frame costs only the squares that changed, and the reads are the same."""
    case = GAMES[0]
    ensure_piece_sets(PIECES, [case["set"]], verbose=False)
    calls = []
    clf = vision._classifier()
    predict = clf.predict

    def counting(squares):
        calls.append(len(squares))
        return predict(squares)

    clf.predict = counting
    try:
        b = chess.Board()
        fen = b.fen()
        r = vision.track_frame(still_frame(b, case), None, "white", fen, session="test-cost")
        assert r["status"] == "same" and calls == [64], (r, calls)
        for san in case["moves"].split():
            calls.clear()
            b.push_san(san)
            r = vision.track_frame(still_frame(b, case), None, "white", fen, session="test-cost")
            assert r["status"] == "moves" and r["fen"].split()[:2] == b.fen().split()[:2], (san, r)
            assert sum(calls) <= 8, f"{san}: read {sum(calls)} squares"  # both moves' squares, or four for castling
            fen = r["fen"]
        calls.clear()
        r = vision.track_frame(still_frame(b, case), None, "white", fen, session="test-cost")
        assert r["status"] == "same" and not calls, (r, calls)
    finally:
        clf.predict = predict
    print("ok  a session reads only the squares that changed")


def test_misread_square():
    """One square read wrongly with confidence neither looks like a change nor hides the next move."""
    b = chess.Board()
    for san in "e4 e5 Nf3".split():
        b.push_san(san)

    def seen(board, wrong=()):
        out = []
        for sq in chess.SQUARES:
            p = board.piece_at(sq)
            out.append((sq, dict(wrong).get(sq, p.symbol() if p else None), 0.99))
        return out

    assert vision.match_moves(b.copy(), seen(b, [(chess.F3, "B")])) == []
    after = b.copy()
    mv = after.push_san("Nc6")
    assert vision.match_moves(b.copy(), seen(after, [(chess.F3, "B")])) == [mv]
    assert vision.match_moves(b.copy(), seen(b, [(chess.F3, "B"), (chess.A2, "Q")])) is None
    print("ok  one misread square is forgiven, two are not")


def test_following_the_screen():
    """What follows from no move still comes back as a position, unless the picture shows none."""
    case = GAMES[0]
    ensure_piece_sets(PIECES, [case["set"]], verbose=False)

    def read(board, base=chess.STARTING_FEN, orientation="white", wab=True):
        return vision.track_frame(frame(board, {**case, "wab": wab}, np.random.default_rng(1)), None, orientation, base)

    # several moves at once
    b = chess.Board()
    for san in "e4 e5 Nf3 Nc6 Bb5 a6".split():
        b.push_san(san)
    r = read(b)
    assert r["status"] == "unknown" and r["fen"].split()[:2] == b.fen().split()[:2], r

    # a move that makes no sense: the rook jumps over its own pawn, and it is not the side to move anyway
    b = chess.Board()
    b.push_san("e4")
    base = b.fen()
    silly = b.copy(stack=False)
    silly.remove_piece_at(chess.H1)
    silly.set_piece_at(chess.H5, chess.Piece(chess.ROOK, chess.WHITE))
    r = read(silly, base)
    assert r["status"] == "unknown" and chess.Board(r["fen"]).board_fen() == silly.board_fen(), r
    assert r["fen"].split()[1] == "b", r  # white's piece arrived: black to move

    # a side moving twice: the colour of what arrived says whose move it is now
    twice = b.copy(stack=False)
    twice.turn = chess.WHITE
    twice.push_san("d4")
    r = read(twice, base)
    assert r["status"] == "unknown" and r["fen"].split()[:2] == [twice.board_fen(), "b"], r

    # the same game seen from the other side
    b = chess.Board()
    for san in "e4 e5 Nf3".split():
        b.push_san(san)
    r = read(b, b.fen(), "white", wab=False)
    assert r["status"] == "same" and r["whiteAtBottom"] is False, r

    # a new game, seen from the other side
    r = read(chess.Board(), b.fen(), "white", wab=False)
    assert r["whiteAtBottom"] is False and r["fen"].split()[0] == chess.Board().board_fen(), r

    # no board at all: nothing to go to
    noise = np.random.default_rng(3).integers(0, 255, (512, 512, 3), np.uint8)
    buf = io.BytesIO()
    Image.fromarray(noise).save(buf, "JPEG", quality=90)
    r = vision.track_frame(buf.getvalue(), None, "white", chess.STARTING_FEN)
    assert r["status"] == "unknown" and r["fen"] is None, r
    print("ok  jumps, nonsense moves, flipped views and pictures without a board")


def test_newest_position_first():
    """The evaluation of the position on the board does not wait for older ones."""
    done, order, release = threading.Event(), [], threading.Event()

    class FakeEngine:
        def quit(self):
            pass

    def evaluate(_engine, board, _limit, game=None):
        order.append(len(board.move_stack))
        release.wait(5)
        if len(order) == 4:
            done.set()
        return {"score": {"cp": 0}}

    saved = engines.background_engine, engines.evaluate, engines.configure
    engines.background_engine, engines.evaluate, engines.configure = lambda _: FakeEngine(), evaluate, lambda *_: None
    try:
        q = engines.EvalQueue("test", lambda _: None)
        moves = ["e2e4", "e7e5", "g1f3"]
        q.request({"tag": "a", "moves": []})
        while not order:
            time.sleep(0.01)
        for i in range(1, 4):  # these arrive while the first is searching
            q.request({"tag": str(i), "moves": moves[:i]})
        release.set()
        assert done.wait(5), order
        assert order == [0, 3, 1, 2], order
        q.cancel()
    finally:
        engines.background_engine, engines.evaluate, engines.configure = saved
    print("ok  the newest position is evaluated first, then the rest in order")


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
    test_misread_square()
    test_following_the_screen()
    test_session_reads_only_what_changed()
    test_newest_position_first()
    test_tracking()
    print("all live tests passed")
