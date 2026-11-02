"""chessvision: screenshot of a chessboard -> FEN -> Stockfish top moves -> arrows."""

CLASSES = ["empty",
           "wP", "wN", "wB", "wR", "wQ", "wK",
           "bP", "bN", "bB", "bR", "bQ", "bK"]
PIECE_CODES = CLASSES[1:]

# Lichess FEN letters for each class
FEN_LETTER = {"wP": "P", "wN": "N", "wB": "B", "wR": "R", "wQ": "Q", "wK": "K",
              "bP": "p", "bN": "n", "bB": "b", "bR": "r", "bQ": "q", "bK": "k"}

INPUT_SIZE = 32  # each square is resized to INPUT_SIZE x INPUT_SIZE RGB
