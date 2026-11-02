#!/usr/bin/env python3
"""Train the square classifier on synthetic boards (JAX, CPU is fine).

    python train.py                                  # ~2 min data + a few min/epoch on a laptop
    python train.py --train-boards 6000 --epochs 12 --holdout     # bigger run, nothing held out

The result is a plain .npz (BatchNorm folded into the convs) that
chessvision/model.py runs with NumPy only.
"""
from __future__ import annotations

import argparse
import json
import time
from functools import partial
from pathlib import Path

import jax
import jax.numpy as jnp
import numpy as np
import optax

from chessvision import CLASSES, INPUT_SIZE
from chessvision.model import N_CONV, SquareClassifier, normalise
from chessvision.pieces import DEFAULT_SETS, ensure_piece_sets
from chessvision.synth import make_dataset_parallel as generate

EPS = 1e-5


# ---------------------------------------------------------------- model (JAX)
def init_params(key, width: int, n_classes: int = len(CLASSES)):
    chans = [3, width, width, 2 * width, 2 * width, 4 * width, 4 * width]
    params, stats = {}, {}
    for i in range(N_CONV):
        key, k = jax.random.split(key)
        cin, cout = chans[i], chans[i + 1]
        params[f"conv{i}"] = jax.random.normal(k, (3, 3, cin, cout)) * jnp.sqrt(2.0 / (9 * cin))
        params[f"bn{i}_g"] = jnp.ones(cout)
        params[f"bn{i}_b"] = jnp.zeros(cout)
        stats[f"bn{i}_m"] = jnp.zeros(cout)
        stats[f"bn{i}_v"] = jnp.ones(cout)
    key, k = jax.random.split(key)
    params["dense_w"] = jax.random.normal(k, (4 * width, n_classes)) * jnp.sqrt(1.0 / (4 * width))
    params["dense_b"] = jnp.zeros(n_classes)
    return params, stats


def forward(params, stats, x, train: bool, key=None, momentum: float = 0.9):
    new_stats = {}
    for i in range(N_CONV):
        x = jax.lax.conv_general_dilated(x, params[f"conv{i}"], (1, 1), "SAME",
                                         dimension_numbers=("NHWC", "HWIO", "NHWC"))
        if train:
            m, v = x.mean((0, 1, 2)), x.var((0, 1, 2))
            new_stats[f"bn{i}_m"] = momentum * stats[f"bn{i}_m"] + (1 - momentum) * m
            new_stats[f"bn{i}_v"] = momentum * stats[f"bn{i}_v"] + (1 - momentum) * v
        else:
            m, v = stats[f"bn{i}_m"], stats[f"bn{i}_v"]
        x = (x - m) * jax.lax.rsqrt(v + EPS) * params[f"bn{i}_g"] + params[f"bn{i}_b"]
        x = jax.nn.relu(x)
        if i % 2 == 1:
            x = jax.lax.reduce_window(x, -jnp.inf, jax.lax.max, (1, 2, 2, 1), (1, 2, 2, 1), "VALID")
    x = x.mean((1, 2))
    if train:
        keep = jax.random.bernoulli(key, 0.8, x.shape)
        x = jnp.where(keep, x / 0.8, 0.0)
    return x @ params["dense_w"] + params["dense_b"], (new_stats if train else stats)


def export_npz(params, stats, path: Path, meta: dict):
    """Fold BatchNorm into each conv: w' = w*s, b' = beta - mean*s, s = gamma/sqrt(var+eps)."""
    out = {}
    for i in range(N_CONV):
        s = np.asarray(params[f"bn{i}_g"]) / np.sqrt(np.asarray(stats[f"bn{i}_v"]) + EPS)
        out[f"conv{i}_w"] = (np.asarray(params[f"conv{i}"]) * s).astype(np.float32)
        out[f"conv{i}_b"] = (np.asarray(params[f"bn{i}_b"]) - np.asarray(stats[f"bn{i}_m"]) * s).astype(np.float32)
    out["dense_w"] = np.asarray(params["dense_w"], np.float32)
    out["dense_b"] = np.asarray(params["dense_b"], np.float32)
    np.savez(path, meta=np.array(json.dumps(meta)), **out)


# ---------------------------------------------------------------- training
def augment(x: np.ndarray, rng: np.random.Generator) -> np.ndarray:
    """Cheap on-the-fly augmentation on a normalised NHWC batch."""
    n = len(x)
    flip = rng.random(n) < 0.5                     # a mirrored knight is still a knight
    x[flip] = x[flip, :, ::-1]
    perm = rng.random(n) < 0.3                     # shuffle colour channels -> theme invariance
    if perm.any():
        x[perm] = x[perm][..., rng.permutation(3)]
    x *= 1 + 0.15 * (rng.random((n, 1, 1, 1)) - 0.5)
    x += 0.3 * (rng.random((n, 1, 1, 1)) - 0.5)
    return x


def report(name, p, y):
    sq = float((p == y).mean())
    board = float((p.reshape(-1, 64) == y.reshape(-1, 64)).all(1).mean())
    print(f"  {name:<8} square acc {sq * 100:6.2f}%   whole-board acc {board * 100:6.2f}%", flush=True)
    return sq, board


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--pieces-dir", default="assets/pieces")
    ap.add_argument("--sets", nargs="*", default=None, help="piece sets to use (default: all known)")
    ap.add_argument("--holdout", nargs="*", default=["tatiana", "maestro"],
                    help="sets kept out of training to measure generalisation (pass nothing to disable)")
    ap.add_argument("--train-boards", type=int, default=2500)
    ap.add_argument("--val-boards", type=int, default=300)
    ap.add_argument("--epochs", type=int, default=8)
    ap.add_argument("--batch", type=int, default=256)
    ap.add_argument("--lr", type=float, default=3e-3)
    ap.add_argument("--width", type=int, default=16)
    ap.add_argument("--workers", type=int, default=2, help="processes for data generation")
    ap.add_argument("--out", default="models/squarenet.npz")
    ap.add_argument("--seed", type=int, default=0)
    ap.add_argument("--data-cache", default=None,
                    help="save generated data to / load it from this .npz (fast re-runs)")
    args = ap.parse_args()

    sets = ensure_piece_sets(args.pieces_dir, args.sets or DEFAULT_SETS)
    holdout = [s for s in (args.holdout or []) if s in sets]
    train_sets = [s for s in sets if s not in holdout]
    print(f"training on {len(train_sets)} piece sets; held out: {holdout or 'none'}")

    t = time.time()
    if args.data_cache and Path(args.data_cache).exists():
        z = np.load(args.data_cache)
        Xtr, ytr, Xva, yva, sva = z["Xtr"], z["ytr"], z["Xva"], z["yva"], z["sva"]
        Xho, yho = (z["Xho"], z["yho"]) if "Xho" in z else (None, None)
        print(f"loaded cached data from {args.data_cache}")
    else:
        Xtr, ytr, _ = generate(args.pieces_dir, train_sets, args.train_boards, args.seed + 1, args.workers)
        Xva, yva, sva = generate(args.pieces_dir, train_sets, args.val_boards, args.seed + 2, args.workers)
        Xho = yho = None
        if holdout:
            Xho, yho, _ = generate(args.pieces_dir, holdout, args.val_boards, args.seed + 3, args.workers)
        if args.data_cache:
            extra = {"Xho": Xho, "yho": yho} if holdout else {}
            np.savez(args.data_cache, Xtr=Xtr, ytr=ytr, Xva=Xva, yva=yva, sva=sva, **extra)
    print(f"{len(Xtr):,} train / {len(Xva):,} val squares ready in {time.time() - t:.0f}s", flush=True)

    key = jax.random.PRNGKey(args.seed)
    key, k = jax.random.split(key)
    params, stats = init_params(k, args.width)
    n_params = sum(int(np.prod(v.shape)) for k_, v in params.items() if not k_.startswith("bn"))
    print(f"model parameters: {n_params:,}")

    steps_per_epoch = len(Xtr) // args.batch
    sched = optax.cosine_onecycle_schedule(args.epochs * steps_per_epoch, args.lr, pct_start=0.15)
    opt = optax.adamw(sched, weight_decay=1e-4)
    opt_state = opt.init(params)
    n_cls = len(CLASSES)

    def loss_fn(p, s, x, y, k):
        logits, new_s = forward(p, s, x, True, k)
        labels = optax.smooth_labels(jax.nn.one_hot(y, n_cls), 0.05)
        return optax.softmax_cross_entropy(logits, labels).mean(), new_s

    @jax.jit
    def train_step(p, s, o, x, y, k):
        (loss, new_s), g = jax.value_and_grad(loss_fn, has_aux=True)(p, s, x, y, k)
        updates, o = opt.update(g, o, p)
        return optax.apply_updates(p, updates), new_s, o, loss

    @partial(jax.jit, static_argnums=())
    def eval_logits(p, s, x):
        return forward(p, s, x, False)[0]

    def predict(p, s, X, bs=2048):
        return np.concatenate([np.asarray(eval_logits(p, s, jnp.asarray(normalise(X[i:i + bs])))).argmax(1)
                               for i in range(0, len(X), bs)])

    rng = np.random.default_rng(args.seed)
    out = Path(args.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    best, best_state, metrics = -1.0, None, {}
    for ep in range(args.epochs):
        t = time.time()
        order = rng.permutation(len(Xtr))
        total = 0.0
        for i in range(steps_per_epoch):
            idx = order[i * args.batch:(i + 1) * args.batch]
            xb = augment(normalise(Xtr[idx]), rng)
            key, k = jax.random.split(key)
            params, stats, opt_state, loss = train_step(params, stats, opt_state, xb, ytr[idx], k)
            total += float(loss)
        print(f"epoch {ep + 1}/{args.epochs}  loss {total / steps_per_epoch:.4f}  ({time.time() - t:.0f}s)",
              flush=True)
        va = report("val", predict(params, stats, Xva), yva)
        ho = report("held-out", predict(params, stats, Xho), yho) if Xho is not None else None
        if va[1] >= best:
            best = va[1]
            best_state = (jax.tree.map(np.asarray, params), jax.tree.map(np.asarray, stats))
            metrics = {"val_square": va[0], "val_board": va[1],
                       "holdout_square": ho[0] if ho else None, "holdout_board": ho[1] if ho else None}

    meta = {"classes": CLASSES, "input_size": INPUT_SIZE, "width": args.width,
            "train_sets": train_sets, "holdout_sets": holdout, "metrics": metrics}
    export_npz(*best_state, out, meta)

    # sanity check: the NumPy runtime must agree with the JAX model it was exported from
    clf = SquareClassifier(str(out))
    p_np, _ = clf.predict(Xva[:512])
    p_jax = predict(*best_state, Xva[:512])
    print(f"numpy/jax agreement on 512 squares: {(p_np == p_jax).mean() * 100:.1f}%")

    p = clf.predict(Xva)[0]
    wrong = np.flatnonzero(p != yva)
    if len(wrong):
        pairs, counts = np.unique(np.stack([yva[wrong], p[wrong]], 1), axis=0, return_counts=True)
        top = np.argsort(counts)[::-1][:8]
        print("most common val confusions (true -> predicted):",
              ", ".join(f"{CLASSES[pairs[k][0]]}->{CLASSES[pairs[k][1]]} x{counts[k]}" for k in top))
        sw, c2 = np.unique(sva[wrong], return_counts=True)
        print("errors by piece set:", ", ".join(f"{s}:{n}" for s, n in sorted(zip(sw, c2), key=lambda z: -z[1])[:8]))
    print(f"saved {out}  {json.dumps(metrics)}")


if __name__ == "__main__":
    main()
