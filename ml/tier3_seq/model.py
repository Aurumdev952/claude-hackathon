"""Tier 3 deep sequence model in JAX (SPEC §13.7; JAX instead of PyTorch, see docs/decisions.md D-18).

token_emb(vocab, d) + time_emb(sinusoidal(log days) -> d) + age_proj(1 -> d)
 -> GRU(hidden d)  |  TransformerEncoder(layers, heads, d, ff, pre-LN)
 -> [CLS]/last state (d) ++ MLP(static -> 32) -> MLP(d+32 -> 64 -> 1) -> logit
Integrated Gradients on token embeddings gives per-event attributions for the Doctor timeline.
"""
from __future__ import annotations

import math

import jax
import jax.numpy as jnp
import numpy as np


def _dense(key, n_in, n_out):
    w = jax.random.normal(key, (n_in, n_out)) * math.sqrt(2.0 / (n_in + n_out))
    return {"w": w, "b": jnp.zeros(n_out)}


def _ln(d):
    return {"g": jnp.ones(d), "b": jnp.zeros(d)}


def init(key, vocab: int, n_static: int, cfg: dict) -> dict:
    d = int(cfg.get("d_model", 64))
    ks = jax.random.split(key, 16 + 4 * int(cfg.get("layers", 2)))
    p = {"emb": jax.random.normal(ks[0], (vocab, d)) * 0.02, "time": _dense(ks[1], 32, d), "age": _dense(ks[2], 1, d),
         "static": _dense(ks[3], n_static, 32), "h1": _dense(ks[4], d + 32, 64), "out": _dense(ks[5], 64, 1)}
    if cfg.get("arch", "gru") == "gru":
        p["gru"] = {"wx": _dense(ks[6], d, 3 * d), "wh": _dense(ks[7], d, 3 * d)}
    else:
        p["layers"] = []
        for i in range(int(cfg.get("layers", 2))):
            k = ks[8 + 4 * i: 12 + 4 * i]
            ff = int(cfg.get("ff", 2 * d))
            p["layers"].append({"ln1": _ln(d), "qkv": _dense(k[0], d, 3 * d), "o": _dense(k[1], d, d), "ln2": _ln(d),
                                "f1": _dense(k[2], d, ff), "f2": _dense(k[3], ff, d)})
        p["ln_f"] = _ln(d)
    return p


def _apply_dense(p, x):
    return x @ p["w"] + p["b"]


def _layernorm(p, x):
    m = x.mean(-1, keepdims=True)
    v = ((x - m) ** 2).mean(-1, keepdims=True)
    return (x - m) / jnp.sqrt(v + 1e-5) * p["g"] + p["b"]


def time_features(days):
    t = jnp.log1p(jnp.maximum(days, 0.0))[..., None]
    freqs = jnp.exp(jnp.linspace(0.0, math.log(100.0), 16))
    return jnp.concatenate([jnp.sin(t * freqs), jnp.cos(t * freqs)], axis=-1)


def embed(p, ids, days, age):
    return p["emb"][ids] + _apply_dense(p["time"], time_features(days)) + _apply_dense(p["age"], (age[..., None] - 50.0) / 20.0)


def encode(p, x, mask, cfg, train=False, rng=None):
    if "gru" in p:
        g = p["gru"]
        d = x.shape[-1]

        def step(h, inp):
            xt, mt = inp
            gx = _apply_dense(g["wx"], xt)
            gh = _apply_dense(g["wh"], h)
            r = jax.nn.sigmoid(gx[:, :d] + gh[:, :d])
            z = jax.nn.sigmoid(gx[:, d:2 * d] + gh[:, d:2 * d])
            n = jnp.tanh(gx[:, 2 * d:] + r * gh[:, 2 * d:])
            hn = (1 - z) * n + z * h
            h = jnp.where(mt[:, None], hn, h)
            return h, None

        h0 = jnp.zeros((x.shape[0], d))
        h, _ = jax.lax.scan(step, h0, (jnp.swapaxes(x, 0, 1), jnp.swapaxes(mask, 0, 1)))
        return h
    heads = int(cfg.get("heads", 4))
    B, T, d = x.shape
    attn_mask = mask[:, None, None, :]
    for i, L in enumerate(p["layers"]):
        h = _layernorm(L["ln1"], x)
        qkv = _apply_dense(L["qkv"], h).reshape(B, T, 3, heads, d // heads)
        q, k, v = qkv[:, :, 0], qkv[:, :, 1], qkv[:, :, 2]
        att = jnp.einsum("bthd,bshd->bhts", q, k) / math.sqrt(d // heads)
        att = jnp.where(attn_mask, att, -1e9)
        att = jax.nn.softmax(att, axis=-1)
        if train and rng is not None:
            att = att * jax.random.bernoulli(jax.random.fold_in(rng, i), 0.9, att.shape) / 0.9
        o = jnp.einsum("bhts,bshd->bthd", att, v).reshape(B, T, d)
        x = x + _apply_dense(L["o"], o)
        h = _layernorm(L["ln2"], x)
        x = x + _apply_dense(L["f2"], jax.nn.gelu(_apply_dense(L["f1"], h)))
    x = _layernorm(p["ln_f"], x)
    return x[:, -1]  # [CLS] is the last position


def logits_from_embedded(p, x, mask, static, cfg, train=False, rng=None):
    h = encode(p, x, mask, cfg, train, rng)
    s = jax.nn.relu(_apply_dense(p["static"], static))
    z = jax.nn.relu(_apply_dense(p["h1"], jnp.concatenate([h, s], axis=-1)))
    return _apply_dense(p["out"], z)[:, 0]


def logits(p, ids, days, age, static, cfg, train=False, rng=None):
    mask = ids != 0
    return logits_from_embedded(p, embed(p, ids, days, age), mask, static, cfg, train, rng)


def integrated_gradients(p, ids, days, age, static, cfg, steps: int = 16) -> np.ndarray:
    """Attribution per sequence position: sum over dims of (x - 0) * mean grad along the straight path."""
    x = embed(p, ids, days, age)
    mask = ids != 0

    def f(xs):
        return logits_from_embedded(p, xs, mask, static, cfg).sum()

    g = jax.grad(f)
    total = jnp.zeros_like(x)
    for a in np.linspace(1.0 / steps, 1.0, steps):
        total = total + g(x * a)
    attr = (x * total / steps).sum(-1)
    return np.asarray(jnp.where(mask, attr, 0.0))


def flatten(p) -> dict:
    leaves, tree = jax.tree_util.tree_flatten(p)
    return {f"p{i}": np.asarray(l) for i, l in enumerate(leaves)}, tree


def save_params(p, path):
    flat, _ = flatten(p)
    np.savez_compressed(path, **flat)


def load_params(path, template):
    d = np.load(path)
    leaves, tree = jax.tree_util.tree_flatten(template)
    return jax.tree_util.tree_unflatten(tree, [jnp.asarray(d[f"p{i}"]) for i in range(len(leaves))])
