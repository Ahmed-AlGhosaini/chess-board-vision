"""Screenshot bytes -> recognised position, in a form the UI can edit;
and frames of a screen capture -> the moves played since the last frame."""
from __future__ import annotations

import io
import threading

import chess
import cv2
import numpy as np
from PIL import Image, ImageOps

from chessvision import FEN_LETTER
from chessvision.board_detect import BoardNotFound, detect_board, geometry_from_bbox
from chessvision.model import SquareClassifier
from chessvision.recognize import image_to_square, recognise

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
                    turn: str = "w", orientation: str = "auto") -> dict:
    """Locate the board (or use `bbox`), classify the squares, build a FEN.

    The grid is returned in picture layout (row 0 = top of the image) together
    with per-square confidence, so the UI can re-map it if the user flips the
    orientation and can flag squares worth double-checking.
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
    }


# ---------------------------------------------------------------- screen capture

SURE = 0.8          # squares read with less confidence may disagree with a candidate position
MAX_UNSURE_MISMATCH = 2


def _seen(grid, confidence, white_at_bottom: bool) -> list[tuple[chess.Square, str | None, float]]:
    out = []
    for r in range(8):
        for c in range(8):
            code = grid[r][c]
            out.append((image_to_square(r, c, white_at_bottom), FEN_LETTER[code] if code else None,
                        float(confidence[r][c])))
    return out


def _mismatch(board: chess.Board, seen) -> float | None:
    """How badly `board` disagrees with what was seen: None if a confidently read square differs."""
    cost, unsure = 0.0, 0
    for sq, symbol, conf in seen:
        piece = board.piece_at(sq)
        if (piece.symbol() if piece else None) != symbol:
            if conf >= SURE:
                return None
            unsure += 1
            cost += conf
            if unsure > MAX_UNSURE_MISMATCH:
                return None
    return cost


def match_moves(board: chess.Board, seen, max_depth: int = 2) -> list[chess.Move] | None:
    """The shortest legal move sequence (up to `max_depth`) from `board` to the seen position.

    [] = nothing changed, None = no sequence fits. Two plies cover a frame
    that was missed between the moves of both players.
    """
    if _mismatch(board, seen) is not None:
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
                cost = _mismatch(board, seen)
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


def track_frame(data: bytes, bbox: tuple[float, float, float, float] | None, orientation: str, fen: str,
                max_depth: int = 2) -> dict:
    """Read one frame of a captured board and work out what was played since `fen`.

    The board's box is known already (from the first frame), so there is no
    detection here: the frame is cut into squares and classified directly.
    """
    img = Image.open(io.BytesIO(data)).convert("RGB")
    geom = geometry_from_bbox(*(bbox or (0, 0, img.width, img.height)))
    wab = orientation != "black"
    rec = recognise(img, geom, _classifier(), white_at_bottom=wab)
    board = chess.Board(fen)
    moves = match_moves(board, _seen(rec.grid, rec.confidence, wab), max_depth)
    out = {"ok": True, "placement": rec.board.board_fen(), "uncertain": rec.uncertain_squares(SURE)}
    if moves is None:
        return {**out, "status": "unknown", "moves": []}
    for mv in moves:
        board.push(mv)
    return {**out, "status": "moves" if moves else "same", "moves": [m.uci() for m in moves], "fen": board.fen()}
