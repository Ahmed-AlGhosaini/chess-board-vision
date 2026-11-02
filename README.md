# chess-board-vision

Screenshot of a 2D chessboard → board located → pieces recognised → FEN →
Stockfish's top 3 moves → numbered arrows drawn back onto the image.

```
python analyze.py examples/screenshot.png
```

![example](examples/screenshot_analysis.png)

```
board at x=380 y=110, size 600x600px

r . b q k . . r
. p p p b p p p
p . n . . n . .
. . . . p . . .
B . . . P . . .
. . . . . N . .
P P P P . P P P
R N B Q . R K .

FEN:      r1bqk2r/1pppbppp/p1n2n2/4p3/B3P3/5N2/PPPP1PPP/RNBQ1RK1 w kq - 0 1
Lichess:  https://lichess.org/analysis/standard/r1bqk2r/...
View:     white at the bottom (auto-detected)

Stockfish, depth 18 (eval from White's side):
1. Re1        +0.40   Re1 b5 Bb3 O-O c3 Na5 Bc2 d5
2. d3         +0.32   d3 b5 Bb3 d6 a4 Bd7 c3 Na5
3. Bxc6       +0.17   Bxc6 dxc6 d3 Bg4 Nbd2 Nd7 Nc4 f6
```

## Pipeline

```
screenshot ──► 1. find board ──► 2. classify 64 squares ──► 3. build position ──► 4. Stockfish MultiPV ──► 5. draw arrows
               (classical CV)     (tiny CNN, NumPy)          (python-chess)
```

| Stage | Module | How |
|---|---|---|
| 1. Find the board | `board_detect.py` | No learning. On an interior grid line of a checkerboard the brightness flips light→dark on one square and dark→light on the next, so the gradient across that line has *both* signs. Per column/row we score `sqrt(Σ(+∂I) · Σ(−∂I))`, pick the 7 equally spaced peaks, refine them with a least-squares fit, then re-run each axis restricted to the other's span to drop UI clutter. Works with any theme, sub-pixel accurate, down to ~10 px per square. |
| 2. Read the squares | `model.py`, `synth.py`, `train.py` | A 73k-parameter CNN (3 × [conv-conv-pool], 32×32 RGB in, 13 classes out). Trained only on **synthetic** boards: 32 Lichess piece sets on random themes, with last-move/check/selection highlights, move dots, in-board coordinates, wood-like textures, JPEG and blur, and ±5 % crop jitter so it tolerates imperfect localisation. BatchNorm is folded into the convs on export, and inference is plain NumPy (~0.1 s per board), so running the tool needs no ML framework. |
| 3. Build the position | `recognize.py` | Grid → `chess.Board`. Orientation is guessed from where White's army sits (pawns count double); castling rights come from kings/rooks on their home squares; `board.status()` catches impossible positions; squares below 80 % confidence are listed. |
| 4. Analyse | `engine.py` | Stockfish over UCI with MultiPV 3. Lines are taken from the deepest iteration in which all three finished, so the ranking is consistent (a time-limited search otherwise mixes depths). |
| 5. Draw | `draw.py` | Anti-aliased arrows in Lichess brush colours (green/blue/orange = 1st/2nd/3rd), number badges that dodge each other, and a legend with evals and lines. |

The side to move cannot be read from a still image, so pass `--turn b` when
it is Black's move (White is assumed otherwise). En-passant rights are never set.

## Results

| | per square | whole board correct |
|---|---|---|
| Validation (32 training piece sets, new random boards) | 99.95 % | 98.3 % |
| Held-out piece sets never seen in training (`tatiana`, `maestro`) | 99.98 % | 99.3 % |
| End-to-end on 4 Lichess-style screenshots (dark/light page, flipped, JPEG, cropped) | | 4 / 4 |

Remaining validation errors come mostly from the more stylised sets
(`pirouetti`, `staunty`); typical confusions are bishop↔king and queen↔king.
The screenshots above are rendered by `tools/make_test_screenshots.py`, so try
it on your own real screenshots and use `--debug` to see each square's label.

## Setup

```bash
pip install -r requirements.txt          # numpy, opencv-python, pillow, chess
```

Install Stockfish from https://stockfishchess.org/download/ and either put it
on your PATH, set `STOCKFISH_PATH`, or pass `--engine C:\path\to\stockfish.exe`.

`models/squarenet.npz` is the trained model, so `analyze.py` works right away.

## Usage

```bash
python analyze.py shot.png                       # white to move, orientation auto
python analyze.py shot.png --turn b              # black to move
python analyze.py shot.png --orientation black   # force: black at the bottom
python analyze.py shot.png --bbox 380,110,600,600   # skip detection (x,y,w,h)
python analyze.py shot.png --time 5              # think longer (or --depth 22)
python analyze.py shot.png --fen-only            # just print the FEN + Lichess link
python analyze.py shot.png --debug               # save a crop with each square's label/confidence
```

## Retraining

```bash
pip install -r requirements-train.txt            # adds jax, optax, resvg-py
python train.py --data-cache data.npz            # downloads ~34 Lichess piece sets on first run
python train.py --train-boards 6000 --epochs 12 --holdout   # bigger run, nothing held out
```

The default run (2,500 boards = 160k squares, 8 epochs) took ~50 min on two
CPU cores; a laptop with more cores or a GPU is much faster. `--data-cache`
saves the generated data so you can iterate on the model without re-rendering.
After training, the script checks that the NumPy runtime agrees with the JAX
model and prints the most common confusions and which piece sets cause them.

Regression test after changes:

```bash
python tools/make_test_screenshots.py test_screens
python tools/e2e_test.py test_screens path/to/stockfish
```

## Limitations and next steps

* **2D, axis-aligned digital boards only.** Photos of physical boards need a
  different localiser (corner/keypoint detection + homography) and real
  training images; the classifier and everything after it would carry over.
* **Side to move** must be given. It could be inferred from the last-move
  highlight: the piece standing on the highlighted destination square just moved.
* **3D or unusual piece sets** outside the training mix may confuse the
  classifier. Add the set name to `DEFAULT_SETS` in `pieces.py` (or put your own
  PNGs in `assets/pieces/<name>/wK.png` …) and retrain.
* Piece sets are downloaded from the open-source Lichess repository
  (`lichess-org/lila/public/piece`) to your machine for training only; each set
  has its own licence, listed in lila's `COPYING.md`.
