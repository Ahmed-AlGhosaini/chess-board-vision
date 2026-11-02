#!/usr/bin/env python3
"""Generate the synthetic training data without training anything.

    python generate_data.py                          # -> data.npz (same data train.py uses)
    python generate_data.py --png-dir squares/       # also one PNG per square, a folder per class
    python generate_data.py --train-boards 200 --preview preview.png   # small set + a peek

Every board gives 64 squares (32x32 RGB), so the default 2,500 + 300 + 300
boards produce about 198,000 squares (~600 MB as .npz).

The .npz contains, for each split (tr = train, va = validation, ho = held-out
piece sets):  X?? (N,32,32,3) uint8 images, y?? (N,) labels indexing
`classes`, s?? (N,) piece-set names. Train on it later with
    python train.py --data-cache data.npz
"""
from __future__ import annotations

import argparse
import time

import numpy as np
from PIL import Image

from chessvision import CLASSES
from chessvision.dataset import build_splits, export_pngs, save_npz, split_sets


def preview(data, path, n=256):
    rng = np.random.default_rng(0)
    idx = rng.choice(len(data["Xtr"]), size=min(n, len(data["Xtr"])), replace=False)
    cols = 16
    rows = (len(idx) + cols - 1) // cols
    sheet = np.zeros((rows * 34, cols * 34, 3), np.uint8)
    for k, i in enumerate(idx):
        r, c = divmod(k, cols)
        sheet[r * 34 + 1:r * 34 + 33, c * 34 + 1:c * 34 + 33] = data["Xtr"][i]
    Image.fromarray(sheet).resize((cols * 68, rows * 68), Image.NEAREST).save(path)


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--out", default="data.npz")
    ap.add_argument("--png-dir", default=None, help="also write every square as a PNG, one folder per class")
    ap.add_argument("--preview", default=None, help="save a grid of random training squares to this image")
    ap.add_argument("--pieces-dir", default="assets/pieces")
    ap.add_argument("--sets", nargs="*", default=None, help="piece sets to use (default: all known)")
    ap.add_argument("--holdout", nargs="*", default=["tatiana", "maestro"],
                    help="sets kept for the held-out split (pass nothing to put all sets in train/val)")
    ap.add_argument("--train-boards", type=int, default=2500)
    ap.add_argument("--val-boards", type=int, default=300)
    ap.add_argument("--workers", type=int, default=2, help="processes for rendering")
    ap.add_argument("--seed", type=int, default=0)
    args = ap.parse_args()

    train_sets, holdout = split_sets(args.pieces_dir, args.sets, args.holdout)
    print(f"train/val piece sets: {len(train_sets)}; held out: {holdout or 'none'}")
    t = time.time()
    data = build_splits(args.pieces_dir, train_sets, holdout, args.train_boards, args.val_boards,
                        args.seed, args.workers)
    print(f"rendered in {time.time() - t:.0f}s")

    save_npz(args.out, data)
    for split, k in (("train", "ytr"), ("val", "yva"), ("held-out", "yho")):
        if k in data:
            counts = np.bincount(data[k], minlength=len(CLASSES))
            print(f"  {split:<8} {len(data[k]):>7,} squares  "
                  f"(empty {counts[0]:,}, pieces {counts[1:].sum():,}, ~{counts[1:].mean():,.0f} per piece type)")
    print(f"saved {args.out}")

    if args.png_dir:
        n = export_pngs(args.png_dir, data)
        print(f"wrote {n:,} PNGs to {args.png_dir}/<split>/<class>/")
    if args.preview:
        preview(data, args.preview)
        print(f"preview: {args.preview}")


if __name__ == "__main__":
    main()
