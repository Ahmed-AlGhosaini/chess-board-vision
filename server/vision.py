"""Screenshot bytes -> recognised position, in a form the UI can edit."""
from __future__ import annotations

import io
import threading

import chess
import cv2
import numpy as np
from PIL import Image, ImageOps

from chessvision.board_detect import BoardNotFound, detect_board, geometry_from_bbox
from chessvision.model import SquareClassifier
from chessvision.recognize import recognise

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
