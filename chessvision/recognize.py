"""Board image -> 8x8 piece grid -> python-chess Board."""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import TYPE_CHECKING

import chess
import numpy as np
from PIL import Image

from . import CLASSES, FEN_LETTER
from .board_detect import BoardGeometry
from .synth import board_to_squares

if TYPE_CHECKING:  # keep torch out of the import chain for geometry-only users
    from .model import SquareClassifier


@dataclass
class Recognition:
    grid: list[list[str | None]]          # image layout, row 0 = top of the picture
    confidence: np.ndarray                 # (8,8) max softmax prob per square
    white_at_bottom: bool
    board: chess.Board
    warnings: list[str] = field(default_factory=list)

    def uncertain_squares(self, threshold: float = 0.8) -> list[str]:
        out = []
        for r in range(8):
            for c in range(8):
                if self.confidence[r, c] < threshold:
                    out.append(chess.square_name(image_to_square(r, c, self.white_at_bottom)))
        return out


def image_to_square(row: int, col: int, white_at_bottom: bool) -> chess.Square:
    if white_at_bottom:
        return chess.square(col, 7 - row)
    return chess.square(7 - col, row)


def square_to_image(sq: chess.Square, white_at_bottom: bool) -> tuple[int, int]:
    f, r = chess.square_file(sq), chess.square_rank(sq)
    return (7 - r, f) if white_at_bottom else (r, 7 - f)


def crop_squares(img: Image.Image, geom: BoardGeometry) -> np.ndarray:
    # Pad by replicating the border so boxes that poke a sub-pixel (or a manual
    # --bbox a few pixels) outside the image are still valid for PIL.
    m = int(np.ceil(max(geom.dx, geom.dy) * 0.25)) + 2
    img = Image.fromarray(np.pad(np.asarray(img), ((m, m), (m, m), (0, 0)), mode="edge"))
    x0, y0 = geom.x0 + m, geom.y0 + m
    # geometry may have dx != dy by a hair; resample each square from its exact box
    if abs(geom.dx - geom.dy) < 0.5:
        return board_to_squares(img, (geom.dx + geom.dy) / 2, offset=(x0, y0))
    from . import INPUT_SIZE
    out = np.zeros((64, INPUT_SIZE, INPUT_SIZE, 3), np.uint8)
    for r in range(8):
        for c in range(8):
            x, y = x0 + c * geom.dx, y0 + r * geom.dy
            out[r * 8 + c] = np.asarray(img.resize((INPUT_SIZE, INPUT_SIZE), Image.BILINEAR,
                                                   box=(x, y, x + geom.dx, y + geom.dy)))
    return out


def white_at_bottom_score(grid: list[list[str | None]]) -> float:
    """Positive when the armies stand as if White were at the bottom: most of each on its own side (pawns weigh double)."""
    score = 0.0
    for r in range(8):
        for c in range(8):
            p = grid[r][c]
            if not p:
                continue
            w = 2.0 if p[1] == "P" else 1.0
            bottom = r >= 4
            score += w if (p[0] == "w") == bottom else -w
    return score


def guess_white_at_bottom(grid: list[list[str | None]]) -> bool:
    return white_at_bottom_score(grid) >= 0


def grid_to_board(grid, white_at_bottom: bool, turn: chess.Color) -> chess.Board:
    board = chess.Board(None)
    for r in range(8):
        for c in range(8):
            p = grid[r][c]
            if p:
                board.set_piece_at(image_to_square(r, c, white_at_bottom),
                                   chess.Piece.from_symbol(FEN_LETTER[p]))
    board.turn = turn
    # castling: allowed whenever king and rook still stand on their start squares
    fen_castle = ""
    for color, k, rooks in ((chess.WHITE, chess.E1, ((chess.H1, "K"), (chess.A1, "Q"))),
                            (chess.BLACK, chess.E8, ((chess.H8, "k"), (chess.A8, "q")))):
        if board.piece_at(k) == chess.Piece(chess.KING, color):
            for rsq, letter in rooks:
                if board.piece_at(rsq) == chess.Piece(chess.ROOK, color):
                    fen_castle += letter
    board.set_castling_fen(fen_castle or "-")
    return board


STATUS_TEXT = {
    chess.STATUS_NO_WHITE_KING: "no white king found",
    chess.STATUS_NO_BLACK_KING: "no black king found",
    chess.STATUS_TOO_MANY_KINGS: "more than one king of a colour",
    chess.STATUS_TOO_MANY_WHITE_PAWNS: "more than 8 white pawns",
    chess.STATUS_TOO_MANY_BLACK_PAWNS: "more than 8 black pawns",
    chess.STATUS_PAWNS_ON_BACKRANK: "pawn on the first/last rank (orientation wrong?)",
    chess.STATUS_TOO_MANY_WHITE_PIECES: "more than 16 white pieces",
    chess.STATUS_TOO_MANY_BLACK_PIECES: "more than 16 black pieces",
    chess.STATUS_OPPOSITE_CHECK: "the side NOT to move is in check (wrong --turn?)",
    chess.STATUS_TOO_MANY_CHECKERS: "impossible check (too many checkers)",
    chess.STATUS_IMPOSSIBLE_CHECK: "impossible check configuration",
}


def recognise(img: Image.Image, geom: BoardGeometry, clf: SquareClassifier,
              turn: chess.Color = chess.WHITE, white_at_bottom: bool | None = None) -> Recognition:
    squares = crop_squares(img, geom)
    labels, probs = clf.predict(squares)
    grid = [[None if clf.classes[labels[r * 8 + c]] == "empty" else clf.classes[labels[r * 8 + c]]
             for c in range(8)] for r in range(8)]
    conf = probs.max(1).reshape(8, 8)
    auto = white_at_bottom is None
    if auto:
        white_at_bottom = guess_white_at_bottom(grid)
    board = grid_to_board(grid, white_at_bottom, turn)
    warnings = []
    status = board.status()
    for flag, text in STATUS_TEXT.items():
        if status & flag:
            warnings.append(text)
    if auto and status & chess.STATUS_PAWNS_ON_BACKRANK:
        # the orientation guess may be wrong: try the other way round
        alt = grid_to_board(grid, not white_at_bottom, turn)
        if not alt.status() & chess.STATUS_PAWNS_ON_BACKRANK:
            white_at_bottom, board = not white_at_bottom, alt
            warnings = [t for f, t in STATUS_TEXT.items() if alt.status() & f]
    return Recognition(grid=grid, confidence=conf, white_at_bottom=white_at_bottom,
                       board=board, warnings=warnings)


assert CLASSES[0] == "empty"
