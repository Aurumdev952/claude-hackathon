"""Tier 3 training (SPEC §13.7): BCE with pos_weight, AdamW + cosine schedule, early stopping on validation AUPRC,
temperature scaling then isotonic calibration on the (non-downsampled) validation set."""
from __future__ import annotations

import json
import time

import jax
import jax.numpy as jnp
import numpy as np
import optax
from scipy.optimize import minimize_scalar
from ml.calibration import fit_calibrator
from sklearn.metrics import average_precision_score

from . import model as M


def _batches(n, bs, rng):
    idx = rng.permutation(n)
    for i in range(0, n, bs):
        yield idx[i:i + bs]


def predict_logits(p, cfg, ids, days, age, static, bs: int = 1024) -> np.ndarray:
    f = jax.jit(lambda p, a, b, c, d: M.logits(p, a, b, c, d, cfg))
    out = []
    for i in range(0, len(ids), bs):
        out.append(np.asarray(f(p, ids[i:i + bs], days[i:i + bs], age[i:i + bs], static[i:i + bs])))
    return np.concatenate(out) if out else np.zeros(0)


def fit(train, val, vocab_size: int, cfg: dict, log=print, seed: int = 42):
    """train/val: dicts with ids, days, age, static, y (val NOT downsampled)."""
    cfg = dict(cfg)
    rng = np.random.default_rng(seed)
    key = jax.random.PRNGKey(seed)
    p = M.init(key, vocab_size, train["static"].shape[1], cfg)
    pos = train["y"].mean()
    pos_weight = float((1 - pos) / max(pos, 1e-6))
    bs = int(cfg.get("batch_size", 256))
    epochs = int(cfg.get("epochs", 8))
    steps = epochs * int(np.ceil(len(train["y"]) / bs))
    sched = optax.cosine_decay_schedule(float(cfg.get("lr", 3e-4)), steps)
    opt = optax.chain(optax.clip_by_global_norm(1.0), optax.adamw(sched, weight_decay=0.01))
    state = opt.init(p)

    def loss_fn(p, ids, days, age, static, y, k):
        z = M.logits(p, ids, days, age, static, cfg, train=True, rng=k)
        l = optax.sigmoid_binary_cross_entropy(z, y)
        w = jnp.where(y > 0.5, pos_weight, 1.0)
        return (l * w).sum() / w.sum()

    @jax.jit
    def step(p, state, ids, days, age, static, y, k):
        l, g = jax.value_and_grad(loss_fn)(p, ids, days, age, static, y, k)
        upd, state = opt.update(g, state, p)
        return optax.apply_updates(p, upd), state, l

    best, best_p, bad, history = -1.0, p, 0, []
    for ep in range(epochs):
        t0 = time.time()
        losses = []
        for i, b in enumerate(_batches(len(train["y"]), bs, rng)):
            k = jax.random.fold_in(key, ep * 100000 + i)
            p, state, l = step(p, state, train["ids"][b], train["days"][b], train["age"][b], train["static"][b],
                               train["y"][b].astype(np.float32), k)
            losses.append(float(l))
        zv = predict_logits(p, cfg, val["ids"], val["days"], val["age"], val["static"])
        ap = float(average_precision_score(val["y"], zv)) if 0 < val["y"].sum() < len(val["y"]) else 0.0
        history.append({"epoch": ep + 1, "loss": float(np.mean(losses)), "val_auprc": ap, "secs": round(time.time() - t0, 1)})
        log(f"      tier3 epoch {ep + 1}: loss={np.mean(losses):.4f} val_auprc={ap:.4f} ({time.time() - t0:.0f}s)")
        if ap > best + 1e-4:
            best, best_p, bad = ap, p, 0
        else:
            bad += 1
            if bad >= int(cfg.get("patience", 3)):
                break
    zv = predict_logits(best_p, cfg, val["ids"], val["days"], val["age"], val["static"])
    T = _temperature(zv, val["y"])
    iso = fit_calibrator(1 / (1 + np.exp(-zv / T)), val["y"])  # same small-plateau shrinkage as tier 2 (D-58)
    return best_p, T, iso, history


def _temperature(z, y) -> float:
    y = y.astype(float)

    def nll(t):
        q = 1 / (1 + np.exp(-z / t))
        q = np.clip(q, 1e-7, 1 - 1e-7)
        return -(y * np.log(q) + (1 - y) * np.log(1 - q)).mean()

    return float(minimize_scalar(nll, bounds=(0.05, 20.0), method="bounded").x)


def calibrated(z, T, iso) -> np.ndarray:
    return iso.predict(1 / (1 + np.exp(-np.asarray(z) / T)))


def save(path, p, T, iso, cfg, static_mean, static_std, history):
    import joblib
    M.save_params(p, path / "params.npz")
    joblib.dump(iso, path / "isotonic.joblib")
    json.dump({"temperature": T, "cfg": cfg, "static_mean": static_mean.tolist(), "static_std": static_std.tolist(),
               "history": history}, open(path / "meta.json", "w"), indent=1)


def load(path, vocab_size: int, n_static: int):
    import joblib
    meta = json.load(open(path / "meta.json"))
    template = M.init(jax.random.PRNGKey(0), vocab_size, n_static, meta["cfg"])
    p = M.load_params(path / "params.npz", template)
    return p, meta, joblib.load(path / "isotonic.joblib")
