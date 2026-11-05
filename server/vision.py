"""Screenshot bytes -> recognised position, in a form the UI can edit;
and frames of a screen capture -> the moves played since the last frame."""
from __future__ import annotations

import io
import threading
from collections import OrderedDict

import chess
import cv2
import numpy as np
from PIL import Image, ImageOps

from chessvision import FEN_LETTER
from chessvision.board_detect import BoardNotFound, detect_board, geometry_from_bbox
from chessvision.highlight import detect_last_move
from chessvision.model import SquareClassifier
from chessvision.recognize import STATUS_TEXT, grid_to_board, image_to_square, recognise, white_at_bottom_score

from .paths import MODEL

_clf: SquareClassifier | None = None
_lock = threading.Lock()


def _classifier() -> SquareClassifier:
    global _clf
    with _lock:
        if _clf is None:
            _clf = SquareClassifier(str(MODEL))
        return _clf


def recognize_image(data: bytes, bbox: tuple[float, float, float, float] | None = None,
                    turn: str = "auto", orientation: str = "auto") -> dict:
    """Locate the board (or use `bbox`), classify the squares, build a FEN.

    The grid is returned in picture layout (row 0 = top of the image) together
    with per-square confidence, so the UI can re-map it if the user flips the
    orientation and can flag squares worth double-checking. With turn="auto",
    the side to move is read off the highlighted last move; `turn` in the
    result is what was detected (None when the board shows no last move).
    """
    img = ImageOps.exif_transpose(Image.open(io.BytesIO(data))).convert("RGB")
    if bbox:
        geom = geometry_from_bbox(*bbox)
    else:
        bgr = cv2.cvtColor(np.asarray(img), cv2.COLOR_RGB2BGR)
        try:
            geom = detect_board(bgr)
        except BoardNotFound as e:
            return {"ok": False, "error": f"Could not find a chessboard ({e}). "
                                          "Drag a box around the board and try again.",
                    "width": img.width, "height": img.height}
    wab = {"auto": None, "white": True, "black": False}[orientation]
    rec = recognise(img, geom, _classifier(), turn=chess.BLACK if turn == "b" else chess.WHITE,
                    white_at_bottom=wab)
    last = detect_last_move(img, geom, rec.grid, rec.white_at_bottom)
    if turn == "auto" and last is not None and rec.board.turn != last.turn:
        rec.board.turn = last.turn
        rec.warnings = [text for flag, text in STATUS_TEXT.items() if rec.board.status() & flag]
    x, y, w, h = geom.bbox
    return {
        "ok": True,
        "width": img.width,
        "height": img.height,
        "bbox": [x, y, w, h],
        "grid": rec.grid,
        "confidence": np.round(rec.confidence.astype(float), 3).tolist(),
        "whiteAtBottom": bool(rec.white_at_bottom),
        "fen": rec.board.fen(),
        "warnings": rec.warnings,
        "uncertain": rec.uncertain_squares(),
        "turn": None if last is None else ("w" if last.turn else "b"),
        "lastMove": None if last is None else [list(sq) for sq in last.squares],
    }


# ---------------------------------------------------------------- screen capture

SURE = 0.8          # squares read with less confidence may disagree with a candidate position
MAX_UNSURE_MISMATCH = 2
MAX_MISREAD = 1     # a sure read can still be wrong on a blurred video: one such square is forgiven
MAX_UNSURE_ON_SCREEN = 8  # with more unsure squares than this, the picture is not taken for a position
FLIP_SCORE = -16    # how far the armies must sit on the wrong sides before the view counts as flipped

# Only squares whose picture changed are classified again. The change of a square is that of its
# most changed 8x8 block (of 32x32). Over every pair of pieces on 4 themes and 4 piece sets, at video
# quality, the weakest real change measures 15 and pure noise at most 4.3.
SQUARE_CHANGED = 6.0
MAX_READERS = 16

# what no engine can be given, whatever the moves that led to it
NOT_A_POSITION = (chess.STATUS_EMPTY | chess.STATUS_NO_WHITE_KING | chess.STATUS_NO_BLACK_KING | chess.STATUS_TOO_MANY_KINGS
                  | chess.STATUS_PAWNS_ON_BACKRANK | chess.STATUS_OPPOSITE_CHECK)


def _square_change(a: np.ndarray, b: np.ndarray) -> np.ndarray:
    """(N,32,32,3) twice -> (N,) largest mean difference of any 8x8 block of each square."""
    d = np.abs(a.astype(np.int16) - b).mean(axis=3)
    return d.reshape(len(a), 4, 8, 4, 8).mean(axis=(2, 4)).max(axis=(1, 2))


class _BoardReader:
    """A classifier for one captured board: remembers its squares, so that a frame only costs the few that changed.

    A new picture is compared with the one a square was last classified from, not with the previous
    frame, so a slow drift adds up and is noticed.
    """

    def __init__(self, clf: SquareClassifier):
        self.clf, self.classes = clf, clf.classes
        self.lock = threading.Lock()  # one frame of a session at a time
        self.squares: np.ndarray | None = None
        self.labels: np.ndarray | None = None
        self.probs: np.ndarray | None = None

    def predict(self, squares: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
        if self.squares is None or self.squares.shape != squares.shape:
            self.labels, self.probs = self.clf.predict(squares)
            self.squares = squares.copy()
            return self.labels, self.probs
        changed = _square_change(squares, self.squares) >= SQUARE_CHANGED
        if changed.any():
            self.labels[changed], self.probs[changed] = self.clf.predict(squares[changed])
            self.squares[changed] = squares[changed]
        return self.labels, self.probs


_readers: OrderedDict[str, _BoardReader] = OrderedDict()


def _reader(session: str) -> _BoardReader:
    clf = _classifier()
    with _lock:
        reader = _readers.get(session)
        if reader is None:
            reader = _readers[session] = _BoardReader(clf)
            while len(_readers) > MAX_READERS:
                _readers.popitem(last=False)
        _readers.move_to_end(session)
        return reader


def _read_squares(img: Image.Image, geom, wab: bool, session: str | None):
    if not session:
        return recognise(img, geom, _classifier(), white_at_bottom=wab)
    reader = _reader(session)
    with reader.lock:
        return recognise(img, geom, reader, white_at_bottom=wab)


def _seen(grid, confidence, white_at_bottom: bool) -> list[tuple[chess.Square, str | None, float]]:
    out = []
    for r in range(8):
        for c in range(8):
            code = grid[r][c]
            out.append((image_to_square(r, c, white_at_bottom), FEN_LETTER[code] if code else None,
                        float(confidence[r][c])))
    return out


def _mismatch(board: chess.Board, seen, misread: int = 0) -> float | None:
    """How badly `board` disagrees with what was seen: None if more than `misread` confidently read squares differ."""
    cost, unsure, sure = 0.0, 0, 0
    for sq, symbol, conf in seen:
        piece = board.piece_at(sq)
        if (piece.symbol() if piece else None) != symbol:
            if conf >= SURE:
                sure += 1
                if sure > misread:
                    return None
            else:
                unsure += 1
                if unsure > MAX_UNSURE_MISMATCH:
                    return None
            cost += conf
    return cost


def _search(board: chess.Board, seen, max_depth: int, misread: int = 0) -> list[chess.Move] | None:
    if _mismatch(board, seen, misread) is not None:
        return []
    best: tuple[float, list[chess.Move]] | None = None
    frontier: list[list[chess.Move]] = [[]]
    for _ in range(max_depth):
        nxt = []
        for line in frontier:
            for mv in line:
                board.push(mv)
            for mv in list(board.legal_moves):
                board.push(mv)
                cost = _mismatch(board, seen, misread)
                if cost is not None and (best is None or cost < best[0]):
                    best = (cost, line + [mv])
                nxt.append(line + [mv])
                board.pop()
            for _ in line:
                board.pop()
        if best is not None:
            return best[1]
        frontier = nxt
    return None


def match_moves(board: chess.Board, seen, max_depth: int = 2) -> list[chess.Move] | None:
    """The shortest legal move sequence (up to `max_depth`) from `board` to the seen position.

    [] = nothing changed, None = no sequence fits. Two plies cover a frame that was
    missed between the moves of both players. Failing an exact fit, one misread
    square is forgiven, so a persistent misreading does not derail the game; a move
    changes at least two squares, so this cannot hide one.
    """
    exact = _search(board, seen, max_depth)
    return exact if exact is not None else _search(board, seen, 1, MAX_MISREAD)


def _position_on_screen(rec, img: Image.Image, geom, base: chess.Board) -> str | None:
    """A FEN for a board that does not follow from `base`, or None if the picture is no position at all.

    The side to move comes from the highlighted last move, or else from the colour of the
    pieces that arrived since `base`; if the position rules that side out, it is the other.
    """
    if len(rec.uncertain_squares(SURE)) > MAX_UNSURE_ON_SCREEN:
        return None
    board = rec.board
    board.fullmove_number = base.fullmove_number
    last = detect_last_move(img, geom, rec.grid, rec.white_at_bottom)
    arrived = {p.color for sq, p in board.piece_map().items() if base.piece_at(sq) != p}
    turn = last.turn if last else (not arrived.pop()) if len(arrived) == 1 else (not base.turn)
    for side in (turn, not turn):
        board.turn = side
        if not board.status() & NOT_A_POSITION:
            return board.fen()
    return None


def track_frame(data: bytes, bbox: tuple[float, float, float, float] | None, orientation: str, fen: str,
                max_depth: int = 2, session: str | None = None) -> dict:
    """Read one frame of a captured board and work out what was played since `fen`.

    The board's box is known already (from the first frame), so there is no detection
    here: the frame is cut into squares and classified directly. With a `session`,
    squares that look as in the session's previous frames are not classified again.

    When the frame does not follow from `fen`, the status is "unknown" and `fen` in the
    result is the position on screen (None if there is no such position), for the caller
    to decide what to do about it. `whiteAtBottom` says which way up the board was read:
    it differs from `orientation` when the view was found to have been flipped.
    """
    img = Image.open(io.BytesIO(data)).convert("RGB")
    geom = geometry_from_bbox(*(bbox or (0, 0, img.width, img.height)))
    wab = orientation != "black"
    rec = _read_squares(img, geom, wab, session)
    board = chess.Board(fen)
    moves = match_moves(board, _seen(rec.grid, rec.confidence, wab), max_depth)
    if moves is None:
        flipped = match_moves(board, _seen(rec.grid, rec.confidence, not wab), 1)
        unlikely = white_at_bottom_score(rec.grid) * (1 if wab else -1) <= FLIP_SCORE
        if flipped is not None or unlikely or rec.board.status() & chess.STATUS_PAWNS_ON_BACKRANK:
            other = grid_to_board(rec.grid, not wab, chess.WHITE)
            if flipped is not None or not other.status() & chess.STATUS_PAWNS_ON_BACKRANK:
                wab, moves = not wab, flipped
                rec.white_at_bottom, rec.board = wab, other
    out = {"ok": True, "placement": rec.board.board_fen(), "uncertain": rec.uncertain_squares(SURE), "whiteAtBottom": wab}
    if moves is None:
        return {**out, "status": "unknown", "moves": [], "fen": _position_on_screen(rec, img, geom, board)}
    for mv in moves:
        board.push(mv)
    return {**out, "status": "moves" if moves else "same", "moves": [m.uci() for m in moves], "fen": board.fen()}
