#!/usr/bin/env python3
"""Harnais PARITÉ + BENCHMARK : Python (`weather_logic`) vs Rust (`scoring_rs`).

Prouve, sans toucher au code de production, que le noyau Rust donne EXACTEMENT les mêmes
scores que le Python, puis mesure le gain de vitesse. Couvre les scorers-feuilles ET
`compute_initiation` complet (score + dict de sous-scores).

À lancer depuis `storm_chase_hosted`, dans le venv où `scoring_rs` a été installé
(`cd scoring-rs && maturin develop --release`). Hypothèse : `weather_logic._active_blend_weights`
vaut None (poids d'origine) — c'est le défaut.

Usage:  python bench_scoring.py
"""
from __future__ import annotations

import math
import random
import time
from datetime import datetime

import weather_logic as wl

try:
    import scoring_rs as rs
except ImportError:
    rs = None

# Créneau partagé par toutes les cellules d'un lot (un créneau = une heure).
DT = datetime(2026, 6, 22, 15, 0)
HOUR, MINUTE = DT.hour, DT.minute


# ---------------------------------------------------------------- scorers-feuilles
LEAF = [
    ("score_cape", wl.score_cape, lambda: rs.score_cape, (-50.0, 3200.0)),
    ("score_dewpoint", wl.score_dewpoint, lambda: rs.score_dewpoint, (-5.0, 25.0)),
    ("score_humidity", wl.score_humidity, lambda: rs.score_humidity, (0.0, 105.0)),
    ("score_vpd", wl.score_vpd, lambda: rs.score_vpd, (-0.2, 4.0)),
    ("score_wetbulb", wl.score_wetbulb, lambda: rs.score_wetbulb, (0.0, 26.0)),
]


def _sweep(lo: float, hi: float, steps: int = 20000) -> list[float]:
    vals = [lo + (hi - lo) * i / steps for i in range(steps + 1)]
    vals += [float("nan"), float("inf"), float("-inf"), lo - 1.0, hi + 1.0]
    rng = random.Random(12345)
    vals += [rng.uniform(lo - 2.0, hi + 2.0) for _ in range(20000)]
    return vals


def check_parity_leaf() -> bool:
    print("=== PARITÉ scorers-feuilles ===")
    ok_all = True
    for name, py_fn, rs_getter, (lo, hi) in LEAF:
        rs_fn = rs_getter()
        mism = [(v, py_fn(v), rs_fn(v)) for v in _sweep(lo, hi) if py_fn(v) != rs_fn(v)]
        if mism:
            ok_all = False
            print(f"  ✗ {name}: {len(mism)} écarts, ex: {mism[:3]}")
        else:
            print(f"  ✓ {name}")
    return ok_all


# ---------------------------------------------------------- compute_initiation complet
OPT_RANGES = {
    "cin": (0.0, 300.0), "conv": (-0.0004, 0.0004), "precip": (0.0, 6.0),
    "pwat": (5.0, 50.0), "shortwave": (0.0, 900.0), "gusts": (0.0, 32.0),
    "cloud_low": (0.0, 100.0), "cloud_mid": (0.0, 100.0), "cloud_high": (0.0, 100.0),
    "blh": (50.0, 3800.0),
}
OPT_KEYS = list(OPT_RANGES)


def _gen_cells(n: int, seed: int = 7) -> list[dict]:
    rng = random.Random(seed)
    cells = []
    for _ in range(n):
        c = {
            "cape": rng.uniform(-20, 3000), "dewpoint": rng.uniform(-5, 24),
            "rh": rng.uniform(0, 100), "vpd": rng.uniform(0, 3.5),
            "temp": rng.uniform(5, 35), "wetbulb": rng.uniform(0, 25),
        }
        for k, (lo, hi) in OPT_RANGES.items():
            c[k] = None if rng.random() < 0.18 else rng.uniform(lo, hi)
        cells.append(c)
    return cells


def _py_full(c: dict):
    return wl.compute_initiation(
        c["cape"], c["dewpoint"], c["rh"], c["vpd"], c["temp"], c["wetbulb"], DT,
        cin_jkg=c["cin"], surface_convergence_s1=c["conv"], precipitation_rate_mm_h=c["precip"],
        precipitable_water_kg_m2=c["pwat"], shortwave_radiation_w_m2=c["shortwave"],
        wind_gusts_10m_ms=c["gusts"], cloud_low=c["cloud_low"], cloud_mid=c["cloud_mid"],
        cloud_high=c["cloud_high"], boundary_layer_height_m=c["blh"],
    )


def _columns(cells: list[dict]) -> dict:
    cols = {k: [c[k] for c in cells] for k in
            ("cape", "dewpoint", "rh", "vpd", "wetbulb", *OPT_KEYS)}
    return cols


def _rs_full(cells: list[dict]):
    k = _columns(cells)
    return rs.compute_initiation_batch(
        HOUR, MINUTE, k["cape"], k["dewpoint"], k["rh"], k["vpd"], k["wetbulb"],
        k["cin"], k["conv"], k["precip"], k["pwat"], k["shortwave"], k["gusts"],
        k["cloud_low"], k["cloud_mid"], k["cloud_high"], k["blh"],
    )


def _equal(a, b) -> bool:
    if a is None or b is None:
        return a is None and b is None
    if isinstance(a, float) or isinstance(b, float):
        return abs(float(a) - float(b)) < 1e-9
    return a == b


def check_parity_full(n: int = 50_000) -> bool:
    print(f"\n=== PARITÉ compute_initiation ({n:,} cellules aléatoires) ===")
    cells = _gen_cells(n)
    rs_out = _rs_full(cells)
    score_mism = 0
    key_mism: dict[str, int] = {}
    examples = []
    for i, c in enumerate(cells):
        py_score, py_d = _py_full(c)
        rs_score, rs_d = rs_out[i]
        if py_score != rs_score:
            score_mism += 1
            if len(examples) < 3:
                examples.append((i, "SCORE", py_score, rs_score))
        for key in py_d:
            if not _equal(py_d[key], rs_d.get(key)):
                key_mism[key] = key_mism.get(key, 0) + 1
                if len(examples) < 6:
                    examples.append((i, key, py_d[key], rs_d.get(key)))
    ok = score_mism == 0 and not key_mism
    print(f"  score   : {'✓ identique' if score_mism == 0 else f'✗ {score_mism} écarts'}")
    if key_mism:
        print(f"  sous-scores : ✗ écarts par clé -> {key_mism}")
    else:
        print("  sous-scores : ✓ identiques (28 clés)")
    for i, key, a, b in examples:
        print(f"      cell#{i} {key}: py={a!r} rust={b!r}")
    return ok


def benchmark_full(n: int = 120_000, repeats: int = 3) -> None:
    print(f"\n=== BENCHMARK compute_initiation ({n:,} cellules, meilleur de {repeats}) ===")
    cells = _gen_cells(n, seed=99)
    k = _columns(cells)

    def py_loop():
        return [_py_full(c) for c in cells]

    def rs_scores():
        return rs.compute_initiation_scores_batch(
            HOUR, MINUTE, k["cape"], k["dewpoint"], k["rh"], k["vpd"], k["wetbulb"],
            k["cin"], k["conv"], k["precip"], k["pwat"], k["shortwave"], k["gusts"],
            k["cloud_low"], k["cloud_mid"], k["cloud_high"], k["blh"])

    def rs_full():
        return _rs_full(cells)

    def best(fn):
        bt = math.inf
        for _ in range(repeats):
            t0 = time.perf_counter()
            fn()
            bt = min(bt, time.perf_counter() - t0)
        return bt

    t_py = best(py_loop)
    t_rs_full = best(rs_full)
    t_rs_sc = best(rs_scores)
    print(f"  Python (boucle, score+dict)  : {t_py*1000:8.1f} ms  ({t_py/n*1e9:6.0f} ns/cell)")
    print(f"  Rust   (batch, score+dict)   : {t_rs_full*1000:8.1f} ms  ({t_rs_full/n*1e9:6.0f} ns/cell)  → {t_py/t_rs_full:5.1f}x")
    print(f"  Rust   (batch, scores seuls) : {t_rs_sc*1000:8.1f} ms  ({t_rs_sc/n*1e9:6.0f} ns/cell)  → {t_py/t_rs_sc:5.1f}x")


def main() -> None:
    if rs is None:
        print("Module Rust `scoring_rs` introuvable.")
        print("Construis-le :  cd scoring-rs && maturin develop --release  (voir README.md)")
        return
    ok = check_parity_leaf()
    ok = check_parity_full() and ok
    benchmark_full()
    print("\nRésultat :", "PARITÉ TOTALE ✓" if ok else "ÉCARTS DÉTECTÉS ✗ (à corriger avant tout swap)")


if __name__ == "__main__":
    main()
