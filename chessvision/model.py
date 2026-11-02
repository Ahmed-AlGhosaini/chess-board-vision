"""Square classifier inference in plain NumPy (no ML framework needed at runtime).

Architecture (trained by train.py, BatchNorm folded into the convs on export):

    32x32x3 -> [conv3x3 -> ReLU] x2 -> maxpool2      (16 ch)
            -> [conv3x3 -> ReLU] x2 -> maxpool2      (32 ch)
            -> [conv3x3 -> ReLU] x2 -> maxpool2      (64 ch)
            -> global average pool -> dense -> 13 logits
"""
from __future__ import annotations

import json

import numpy as np
from numpy.lib.stride_tricks import sliding_window_view

from . import INPUT_SIZE

N_CONV = 6


def normalise(batch_uint8: np.ndarray) -> np.ndarray:
    """(N,32,32,3) uint8 -> float32, roughly zero-centred. Shared with training."""
    return (batch_uint8.astype(np.float32) - 127.5) / 64.0


def conv3x3_same(x: np.ndarray, w: np.ndarray, b: np.ndarray) -> np.ndarray:
    """x (N,H,W,C), w (3,3,C,O) -> (N,H,W,O). im2col + one matmul."""
    n, h, wd, c = x.shape
    xp = np.pad(x, ((0, 0), (1, 1), (1, 1), (0, 0)))
    cols = sliding_window_view(xp, (3, 3), axis=(1, 2))          # (N,H,W,C,3,3)
    cols = cols.reshape(n * h * wd, c * 9)
    wm = w.transpose(2, 0, 1, 3).reshape(c * 9, -1)               # (C*3*3, O)
    return (cols @ wm + b).reshape(n, h, wd, -1)


def maxpool2(x: np.ndarray) -> np.ndarray:
    n, h, w, c = x.shape
    return x.reshape(n, h // 2, 2, w // 2, 2, c).max(axis=(2, 4))


class SquareClassifier:
    def __init__(self, weights: str):
        z = np.load(weights, allow_pickle=False)
        self.meta = json.loads(str(z["meta"]))
        self.classes: list[str] = self.meta["classes"]
        assert self.meta.get("input_size", INPUT_SIZE) == INPUT_SIZE
        self.convs = [(z[f"conv{i}_w"].astype(np.float32), z[f"conv{i}_b"].astype(np.float32))
                      for i in range(N_CONV)]
        self.dense = (z["dense_w"].astype(np.float32), z["dense_b"].astype(np.float32))

    def logits(self, squares: np.ndarray) -> np.ndarray:
        x = normalise(squares)
        for i, (w, b) in enumerate(self.convs):
            x = np.maximum(conv3x3_same(x, w, b), 0.0)
            if i % 2 == 1:
                x = maxpool2(x)
        x = x.mean(axis=(1, 2))
        return x @ self.dense[0] + self.dense[1]

    def predict(self, squares: np.ndarray, batch: int = 256) -> tuple[np.ndarray, np.ndarray]:
        """squares (N,32,32,3) uint8 -> (labels (N,), probabilities (N,13)).

        Batched because im2col on the first layer costs ~600 KB per square.
        """
        z = np.concatenate([self.logits(squares[i:i + batch]) for i in range(0, len(squares), batch)])
        z = z - z.max(axis=1, keepdims=True)
        p = np.exp(z)
        p /= p.sum(axis=1, keepdims=True)
        return p.argmax(1), p
