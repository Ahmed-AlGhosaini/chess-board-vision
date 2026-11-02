"""Build / save / load the synthetic train, val and held-out splits.

Shared by generate_data.py (data only) and train.py, so both produce the same
data for the same arguments and seed.
"""
from __future__ import annotations

from pathlib import Path

import numpy as np
from PIL import Image

from . import CLASSES
from .pieces import DEFAULT_SETS, ensure_piece_sets
from .synth import make_dataset_parallel


def split_sets(pieces_dir, sets=None, holdout=None):
    """Download/rasterise piece sets; return (train_sets, holdout_sets)."""
    available = ensure_piece_sets(pieces_dir, sets or DEFAULT_SETS)
    held = [s for s in (holdout or []) if s in available]
    return [s for s in available if s not in held], held


def build_splits(pieces_dir, train_sets, holdout_sets, train_boards=2500, val_boards=300,
                 seed=0, workers=2) -> dict[str, np.ndarray]:
    """X* are (N,32,32,3) uint8 squares, y* class indices into CLASSES, s* piece-set names."""
    d = {}
    d["Xtr"], d["ytr"], d["str"] = make_dataset_parallel(pieces_dir, train_sets, train_boards, seed + 1, workers)
    d["Xva"], d["yva"], d["sva"] = make_dataset_parallel(pieces_dir, train_sets, val_boards, seed + 2, workers)
    if holdout_sets:
        d["Xho"], d["yho"], d["sho"] = make_dataset_parallel(pieces_dir, holdout_sets, val_boards,
                                                             seed + 3, workers)
    return d


def save_npz(path, data: dict[str, np.ndarray]) -> None:
    Path(path).parent.mkdir(parents=True, exist_ok=True)
    np.savez(path, classes=np.array(CLASSES), **data)


def load_npz(path) -> dict[str, np.ndarray]:
    z = np.load(path)
    return {k: z[k] for k in z.files if k != "classes"}


def export_pngs(out_dir, data: dict[str, np.ndarray]) -> int:
    """Write every square as out_dir/<split>/<class>/<index>_<pieceset>.png.

    This is the usual "one folder per class" layout, readable by most
    image-classification tools (e.g. torchvision's ImageFolder).
    """
    out_dir = Path(out_dir)
    n = 0
    for split, (xk, yk, sk) in {"train": ("Xtr", "ytr", "str"), "val": ("Xva", "yva", "sva"),
                                "heldout": ("Xho", "yho", "sho")}.items():
        if xk not in data:
            continue
        for c in CLASSES:
            (out_dir / split / c).mkdir(parents=True, exist_ok=True)
        for i, (x, y) in enumerate(zip(data[xk], data[yk])):
            s = data[sk][i] if sk in data else "unknown"
            Image.fromarray(x).save(out_dir / split / CLASSES[int(y)] / f"{i:06d}_{s}.png")
            n += 1
    return n
