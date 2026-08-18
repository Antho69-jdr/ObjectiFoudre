"""Auto-calibration & apprentissage du modèle de score (boucle fermée).

Logique PURE (Python standard, sans numpy ni serveur), testable seule. Elle apprend
de l'archive « prévu vs foudre observée » pour :

- Niveau A — Calibration : courbe monotone trigger_score -> P(foudre) (isotone/PAVA)
  + seuil de décision optimal (CSI max).
- Niveau B — Poids (gated) : réapprend les 4 poids de mélange de haut niveau
  (CAPE / humidité / chauffage / convergence) par recherche sur le simplexe.

Garde-fous : volumes minimaux + validation croisée temporelle (train sur jours
anciens, test sur le bloc récent) ; un candidat n'est « activable » que s'il bat la
baseline sur le test. Tout est réversible (supprimer active.json -> modèle de base).

Le stockage et les loaders d'archive vivent dans app.py ; ici, que des maths.
"""

from __future__ import annotations

import gzip
import json
import math
from pathlib import Path
from typing import Any, Callable, Iterable

import verification

# --- Constantes de modèle ------------------------------------------------------

# Poids de mélange de haut niveau par défaut (= constantes codées en dur de
# weather_logic.compute_initiation, forme à 4 poids ; convergence renormalisée si absente).
DEFAULT_BLEND_WEIGHTS: dict[str, float] = {"cape": 0.44, "humid": 0.34, "heat": 0.10, "conv": 0.12}
BASELINE_THRESHOLD: int = 60  # seuil « zones prévues » de référence (verification.py, abaissé 70→60)

# Garde-fous de volume (conservateurs) : rien n'est appris en-dessous.
CALIB_MIN_DAYS = 10
CALIB_MIN_POSITIVES = 40
WEIGHTS_MIN_DAYS = 25
WEIGHTS_MIN_POSITIVES = 300

# Règle d'activation : le candidat doit battre la baseline sur le test held-out.
ACTIVATION_CSI_MARGIN = 0.02     # gain minimal de CSI
# Les POIDS appris ne s'activent que s'ils battent le candidat CALIBRATION SEULE (poids
# d'origine) sur le held-out, de cette marge. Sinon les poids « montent à bord » du gain de
# la calibration sans rien apporter (voire proportions douteuses : humidité à 0) — cf. audit.
WEIGHTS_CSI_MARGIN = 0.02

# --- Force du boost « indice de soulèvement » (lifted index) apprise --------------------------
# On cherche la force qui maximise le CSI held-out en RECONSTRUISANT le trigger déployé
# (base pré-boost + boost activité + boost LI[gain]) — jamais depuis le trigger archivé, qui
# inclut déjà le boost (double-comptage). Le boost LI n'est archivé que depuis v1.3.167 : les
# jours plus anciens ont lifted_index None → boost 0 quel que soit le gain (neutre, normal).
LI_GAIN_CANDIDATES = (0, 2, 4, 6, 8, 10)  # 0 = LI désactivé (référence)
LI_GAIN_CSI_MARGIN = 0.02        # le gain retenu doit battre gain=0 d'au moins ça (held-out)
LI_MIN_DAYS = 15                 # jours AVEC LI archivé requis avant de calibrer la force
LI_MIN_POSITIVES = 60            # positifs (cellules foudroyées) parmi les jours avec LI

TEST_FRACTION = 0.30             # part des jours (les plus récents) réservée au test
MIN_TEST_DAYS = 3
FLASH_THRESHOLD = 1              # >= 1 flash dans la cellule = orage observé

CONFIG_VERSION = 3


# --- Petits utilitaires (répliques fidèles de weather_logic) -------------------

def clamp(value: float, low: float = 0.0, high: float = 100.0) -> int:
    return int(max(low, min(high, round(value))))


def humidity_block(dew_s: float, rh_s: float, vpd_s: float, wet_s: float, pwat_s: float | None) -> int:
    """Bloc humidité reconstruit depuis les sous-scores archivés.

    Réplique weather_logic.compute_initiation (saturation_s + humidity_block,
    ~L791-795). À garder synchronisé si la formule y change.
    """
    saturation_s = clamp(vpd_s * 0.60 + rh_s * 0.40)
    if pwat_s is None:
        return clamp(dew_s * 0.65 + saturation_s * 0.35)
    return clamp(dew_s * 0.48 + saturation_s * 0.27 + wet_s * 0.08 + pwat_s * 0.17)


def cell_blocks(metric_scores: dict[str, Any]) -> dict[str, float | None] | None:
    """Les 4 blocs de haut niveau (cape, humid, heat, conv) depuis metric_scores."""
    if not isinstance(metric_scores, dict):
        return None

    def _num(key: str) -> float | None:
        v = metric_scores.get(key)
        if v is None:
            return None
        try:
            f = float(v)
        except (TypeError, ValueError):
            return None
        return f if math.isfinite(f) else None

    cape = _num("cape_score")
    heat = _num("surface_heating_score")
    if cape is None or heat is None:
        return None
    dew = _num("dewpoint_score") or 0.0
    rh = _num("humidity_score") or 0.0
    vpd = _num("vpd_score") or 0.0
    wet = _num("wetbulb_score") or 0.0
    pwat = _num("precipitable_water_score")
    conv = _num("surface_trigger_score")  # peut être None (pas de convergence)
    return {
        "cape": cape,
        "humid": float(humidity_block(dew, rh, vpd, wet, pwat)),
        "heat": heat,
        "conv": conv,
    }


def blend_score(blocks: dict[str, float | None], weights: dict[str, float]) -> int:
    """Score 0-100 = moyenne pondérée des blocs ; convergence renormalisée si absente."""
    cape = float(blocks.get("cape") or 0.0)
    humid = float(blocks.get("humid") or 0.0)
    heat = float(blocks.get("heat") or 0.0)
    conv = blocks.get("conv")
    w = weights
    if conv is None:
        denom = w["cape"] + w["humid"] + w["heat"]
        if denom <= 0:
            return 0
        return clamp((w["cape"] * cape + w["humid"] * humid + w["heat"] * heat) / denom)
    return clamp(w["cape"] * cape + w["humid"] * humid + w["heat"] * heat + w["conv"] * float(conv))


# --- Construction du jeu d'apprentissage ---------------------------------------

def build_training_examples(
    dates: Iterable[str],
    forecast_full_loader: Callable[[str], dict[str, Any] | None],
    lightning_loader: Callable[[str], dict[str, Any] | None],
    *,
    flash_threshold: int = FLASH_THRESHOLD,
) -> list[dict[str, Any]]:
    """Un exemple par cellule-jour : blocs (du créneau de score max) + label foudre.

    `forecast_full_loader(date)` -> payload FULL (cellules avec metric_scores) ;
    `lightning_loader(date)` -> archive foudre (flashes_per_cell), ignorée si non finale.
    """
    examples: list[dict[str, Any]] = []
    for date_str in dates:
        lightning = lightning_loader(date_str)
        if not lightning or not lightning.get("final"):
            continue
        flashes_per_cell = lightning.get("flashes_per_cell") or {}
        payload = forecast_full_loader(date_str)
        if not payload:
            continue
        days = payload.get("days") or []
        slots = (days[0].get("slots") or []) if days else []
        # par cellule : retenir les blocs du créneau où trigger_score est maximal
        by_key: dict[str, dict[str, Any]] = {}
        for slot in slots:
            for cell in (slot.get("cells") or []):
                lat, lon = cell.get("lat"), cell.get("lon")
                if lat is None or lon is None:
                    continue
                try:
                    trig = float(cell.get("trigger_score") or 0)
                except (TypeError, ValueError):
                    trig = 0.0
                key = verification.cell_key(lat, lon)
                prev = by_key.get(key)
                if prev is not None and trig <= prev["trigger"]:
                    continue
                blocks = cell_blocks(cell.get("metric_scores") or {})
                if blocks is None:
                    continue
                # `rec` : de quoi RE-SCORER la cellule via le pipeline complet (blend+gates+
                # modificateurs+confiance) pour des poids candidats — cf. weather_logic.
                # score_from_archived_cell. Objectif : valider l'objet réellement DÉPLOYÉ.
                rec = {
                    "metric_scores": cell.get("metric_scores") or {},
                    "mucape": cell.get("mucape"),
                    "shear_ms": cell.get("shear_ms"),
                    "selected_time_iso": cell.get("selected_time_iso"),
                    "confidence_score": cell.get("confidence_score"),
                }
                by_key[key] = {"trigger": trig, "blocks": blocks, "rec": rec,
                               "lat": float(lat), "lon": float(lon)}
        for key, agg in by_key.items():
            observed = float(flashes_per_cell.get(key, 0.0))
            examples.append({
                "date": date_str,
                "cell_key": key,
                "lat": agg["lat"],
                "lon": agg["lon"],
                "blocks": agg["blocks"],
                "rec": agg["rec"],
                "trigger": agg["trigger"],
                "label": 1 if observed >= flash_threshold else 0,
            })
    return examples


# --- Calibration de fiabilité (isotone / PAVA) ---------------------------------

def isotonic_pav(scores: list[float], labels: list[int]) -> list[list[float]]:
    """Régression isotone (Pool Adjacent Violators) : renvoie une courbe monotone
    croissante [[score, prob], ...] (points de rupture)."""
    pairs = sorted(zip(scores, labels), key=lambda p: p[0])
    if not pairs:
        return [[0.0, 0.0], [100.0, 0.0]]
    # Passe 1 — agrégation par x : un bloc initial par valeur de score DISTINCTE. Sans
    # ça, chaque exemple devient son propre bloc et, comme la fusion PAVA n'agit que sur
    # un `>` STRICT, des milliers d'exemples de même score et même moyenne (ex. score=2,
    # label=0 ×1500) ne se poolent jamais → la courbe explose en doublons ([2.0, 0.0]
    # répété), gonflant active.json / le payload /api/learning/status et ralentissant
    # calibrated_probability ; pire, deux exemples de MÊME score pouvaient hériter de
    # probas différentes (isotonie violée). Agréger d'abord garantit une proba unique par
    # score et une courbe compacte : c'est la régression isotone CORRECTE (elle ne diffère
    # de l'ancienne courbe que là où celle-ci était incohérente sur des scores dupliqués ;
    # écart moyen pondéré par la fréquence des scores ~3e-4, mesuré). Non appliquée au
    # scoring live (seuls poids+seuil le sont) → sert au Brier calibré interne + diagnostic.
    agg: list[list[float]] = []  # [sum_y, count, x] par x croissant
    for x, y in pairs:
        xf = float(x)
        if agg and agg[-1][2] == xf:
            agg[-1][0] += float(y)
            agg[-1][1] += 1.0
        else:
            agg.append([float(y), 1.0, xf])
    # Passe 2 — PAVA : fusion des blocs adjacents tant que non monotones (moyenne).
    blocks: list[list[float]] = []  # [sum_y, count, x_repr]
    for sy, n, x in agg:
        blocks.append([sy, n, x])
        while len(blocks) >= 2 and (blocks[-2][0] / blocks[-2][1]) > (blocks[-1][0] / blocks[-1][1]):
            sy2, n2, _ = blocks.pop()
            sy1, n1, x1 = blocks.pop()
            blocks.append([sy1 + sy2, n1 + n2, x1])
    curve: list[list[float]] = []
    for sy, n, x in blocks:
        curve.append([round(x, 3), round(sy / n, 5)])
    # borne haute pour l'interpolation
    if curve[-1][0] < 100.0:
        curve.append([100.0, curve[-1][1]])
    if curve[0][0] > 0.0:
        curve.insert(0, [0.0, curve[0][1]])
    return curve


def calibrated_probability(curve: list[list[float]], score: float) -> float:
    """Interpole la probabilité pour un score sur la courbe isotone."""
    if not curve:
        return 0.0
    if score <= curve[0][0]:
        return curve[0][1]
    if score >= curve[-1][0]:
        return curve[-1][1]
    for i in range(1, len(curve)):
        x0, p0 = curve[i - 1]
        x1, p1 = curve[i]
        if score <= x1:
            if x1 == x0:
                return p1
            return p0 + (p1 - p0) * (score - x0) / (x1 - x0)
    return curve[-1][1]


def calibrated_brier(scores: list[float], labels: list[int]) -> float:
    """Brier APRÈS calibration isotone : mesure la discrimination, pas l'échelle.

    Le Brier brut de score/100 est dominé par l'échelle quand les positifs sont
    rares (~10 %) : il récompense « qui prédit le plus bas » — c'est ce qui faisait
    converger le fit des poids sur 100 % CAPE (bloc au score moyen le plus proche du
    taux de base), pas sur le meilleur mélange. Comme la calibration isotone absorbe
    l'échelle en aval de toute façon, on compare les candidats sur le Brier de leurs
    probabilités CALIBRÉES (terme de raffinement) : seul le classement compte.

    Scores bornés 0-100 binnés à l'entier -> PAVA sur <=101 bins, O(n)."""
    if not scores:
        return 0.0
    n_bin = [0] * 101
    pos_bin = [0] * 101
    for s, y in zip(scores, labels):
        b = int(min(100.0, max(0.0, round(s))))
        n_bin[b] += 1
        pos_bin[b] += 1 if y >= 1 else 0
    # PAVA sur les bins non vides : blocs [somme_pos, effectif, bins couverts]
    blocks: list[list[Any]] = []
    for b in range(101):
        if n_bin[b] == 0:
            continue
        blocks.append([float(pos_bin[b]), float(n_bin[b]), [b]])
        while len(blocks) >= 2 and blocks[-2][0] / blocks[-2][1] > blocks[-1][0] / blocks[-1][1]:
            sy2, n2, b2 = blocks.pop()
            sy1, n1, b1 = blocks.pop()
            blocks.append([sy1 + sy2, n1 + n2, b1 + b2])
    total = 0.0
    for sy, cnt, bins in blocks:
        p = sy / cnt
        for b in bins:
            # somme de (p - y)^2 sur le bin b (y binaire) : n·p² − 2·p·pos + pos
            total += n_bin[b] * p * p - 2.0 * p * pos_bin[b] + pos_bin[b]
    return total / len(scores)


# --- Skill (CSI / HSS) sur (scores, labels, seuil) -----------------------------

def skill_at_threshold(scores: list[float], labels: list[int], threshold: float) -> dict[str, float]:
    hits = misses = fa = cn = 0
    for s, y in zip(scores, labels):
        pred = s >= threshold
        obs = y >= 1
        if pred and obs:
            hits += 1
        elif obs and not pred:
            misses += 1
        elif pred and not obs:
            fa += 1
        else:
            cn += 1
    csi = hits / (hits + misses + fa) if (hits + misses + fa) > 0 else 0.0
    total = hits + misses + fa + cn
    hss = 0.0
    if total > 0:
        expected = ((hits + misses) * (hits + fa) + (cn + misses) * (cn + fa)) / total
        denom = total - expected
        hss = (hits + cn - expected) / denom if denom != 0 else 0.0
    brier = (
        sum((min(max(s / 100.0, 0.0), 1.0) - y) ** 2 for s, y in zip(scores, labels)) / len(scores)
        if scores else 0.0
    )
    return {"csi": round(csi, 4), "hss": round(hss, 4), "brier": round(brier, 4),
            "hits": hits, "misses": misses, "false_alarms": fa, "correct_negatives": cn}


def best_threshold(scores: list[float], labels: list[int]) -> tuple[int, float]:
    """Seuil entier maximisant le CSI (tie-break : seuil le plus haut = moins de fausses alertes)."""
    best_thr, best_csi = BASELINE_THRESHOLD, -1.0
    for thr in range(1, 100):
        csi = skill_at_threshold(scores, labels, thr)["csi"]
        if csi > best_csi + 1e-9 or (abs(csi - best_csi) <= 1e-9 and thr > best_thr):
            best_csi, best_thr = csi, thr
    return best_thr, round(best_csi, 4)


# --- Skill de VOISINAGE (par jour) : aligne l'apprentissage sur la vérif affichée -----

DEFAULT_NEIGHBORHOOD_KM = verification.DEFAULT_NEIGHBORHOOD_KM


def skill_neighborhood(
    examples: list[dict[str, Any]],
    scores: list[float],
    threshold: float,
    *,
    neighborhood_km: float = DEFAULT_NEIGHBORHOOD_KM,
    flash_threshold: int = FLASH_THRESHOLD,
) -> dict[str, float]:
    """Skill agrégé en VOISINAGE : regroupe les exemples par jour et réutilise
    verification.compute_verification (cellules = exemples avec leur score candidat),
    puis somme la table de contingence sur tous les jours. `examples`/`scores` parallèles.
    Mesure le MÊME skill que la vérif affichée (cohérence apprentissage ↔ vérité-terrain)."""
    by_date: dict[str, list[tuple[dict[str, Any], float]]] = {}
    for ex, sc in zip(examples, scores):
        by_date.setdefault(ex["date"], []).append((ex, float(sc)))
    H = M = FA = CN = 0
    for items in by_date.values():
        cells = [{"lat": ex.get("lat"), "lon": ex.get("lon"), "trigger_score": sc} for ex, sc in items]
        fpc = {
            verification.cell_key(ex["lat"], ex["lon"]): (1.0 if ex["label"] >= flash_threshold else 0.0)
            for ex, _sc in items if ex.get("lat") is not None and ex["label"] >= flash_threshold
        }
        res = verification.compute_verification(
            cells, fpc, score_threshold=threshold, flash_threshold=flash_threshold,
            neighborhood_km=neighborhood_km,
        )
        c = res["contingency"]
        H += c["hits"]; M += c["misses"]; FA += c["false_alarms"]; CN += c["correct_negatives"]
    csi = H / (H + M + FA) if (H + M + FA) > 0 else 0.0
    total = H + M + FA + CN
    hss = 0.0
    if total > 0:
        expected = ((H + M) * (H + FA) + (CN + M) * (CN + FA)) / total
        denom = total - expected
        hss = (H + CN - expected) / denom if denom != 0 else 0.0
    brier = (
        sum((min(max(s / 100.0, 0.0), 1.0) - ex["label"]) ** 2 for ex, s in zip(examples, scores)) / len(scores)
        if scores else 0.0
    )
    return {"csi": round(csi, 4), "hss": round(hss, 4), "brier": round(brier, 4),
            "hits": H, "misses": M, "false_alarms": FA, "correct_negatives": CN}


def best_threshold_neighborhood(
    examples: list[dict[str, Any]],
    scores: list[float],
    *,
    neighborhood_km: float = DEFAULT_NEIGHBORHOOD_KM,
) -> tuple[int, float]:
    """Seuil entier maximisant le CSI de VOISINAGE (tie-break : seuil le plus haut)."""
    best_thr, best_csi = BASELINE_THRESHOLD, -1.0
    for thr in range(1, 100):
        csi = skill_neighborhood(examples, scores, thr, neighborhood_km=neighborhood_km)["csi"]
        if csi > best_csi + 1e-9 or (abs(csi - best_csi) <= 1e-9 and thr > best_thr):
            best_csi, best_thr = csi, thr
    return best_thr, round(best_csi, 4)


# --- Réapprentissage des poids (recherche sur le simplexe) ---------------------

def _simplex_grid(step: float, with_conv: bool = True) -> list[dict[str, float]]:
    """Poids >=0 multiples de `step` sommant à 1. Si `with_conv` est faux, conv=0
    (convergence majoritairement absente -> poids non identifiable, on l'écarte)."""
    n = round(1.0 / step)
    combos: list[dict[str, float]] = []
    if with_conv:
        for a in range(n + 1):
            for b in range(n + 1 - a):
                for c in range(n + 1 - a - b):
                    d = n - a - b - c
                    combos.append({"cape": a / n, "humid": b / n, "heat": c / n, "conv": d / n})
    else:
        for a in range(n + 1):
            for b in range(n + 1 - a):
                c = n - a - b
                combos.append({"cape": a / n, "humid": b / n, "heat": c / n, "conv": 0.0})
    return combos


def fit_blend_weights(examples: list[dict[str, Any]]) -> dict[str, float]:
    """Poids minimisant le Brier CALIBRÉ (discrimination) du blend vs label. Grille
    grossière (0.1) puis raffinement local. Robuste et interprétable (≤4 paramètres).
    La convergence n'est apprise que si elle est présente dans assez d'exemples
    (sinon conv=0). Les ex æquo reviennent aux poids par défaut (init du best)."""
    if not examples:
        return dict(DEFAULT_BLEND_WEIGHTS)
    blocks = [e["blocks"] for e in examples]
    labels = [e["label"] for e in examples]
    conv_present = sum(1 for blk in blocks if blk.get("conv") is not None)
    use_conv = conv_present >= max(1, int(0.20 * len(blocks)))

    def brier(weights: dict[str, float]) -> float:
        return calibrated_brier([blend_score(blk, weights) for blk in blocks], labels)

    best_w = dict(DEFAULT_BLEND_WEIGHTS) if use_conv else {"cape": 0.5, "humid": 0.4, "heat": 0.1, "conv": 0.0}
    best_b = brier(best_w)
    for w in _simplex_grid(0.1, with_conv=use_conv):
        b = brier(w)
        if b < best_b:
            best_b, best_w = b, w
    # raffinement local (pas 0.02), en respectant le simplexe (conv = reste, ou 0)
    keys = ["cape", "humid", "heat", "conv"]
    deltas = (-0.06, -0.02, 0.0, 0.02, 0.06)
    for _ in range(2):
        improved = False
        center = best_w
        for da in deltas:
            for db in deltas:
                inner = deltas if use_conv else (0.0,)
                for dc in inner:
                    cand = {"cape": center["cape"] + da, "humid": center["humid"] + db}
                    if use_conv:
                        cand["heat"] = center["heat"] + dc
                        cand["conv"] = 1.0 - cand["cape"] - cand["humid"] - cand["heat"]
                    else:
                        cand["heat"] = 1.0 - cand["cape"] - cand["humid"]
                        cand["conv"] = 0.0
                    if any(cand[k] < -1e-9 for k in keys):
                        continue
                    b = brier(cand)
                    if b < best_b - 1e-9:
                        best_b, best_w, improved = b, {k: round(cand[k], 4) for k in keys}, True
        if not improved:
            break
    return {k: round(best_w[k], 4) + 0.0 for k in keys}  # +0.0 : évite -0.0


# --- Évaluation + sélection (validation croisée temporelle) --------------------

def _data_counts(examples: list[dict[str, Any]]) -> dict[str, int]:
    days = sorted({e["date"] for e in examples})
    positives = sum(1 for e in examples if e["label"] >= 1)
    storm_days = sorted({e["date"] for e in examples if e["label"] >= 1})
    li = _li_data_counts(examples)
    return {
        "days": len(days),
        "storm_days": len(storm_days),
        "examples": len(examples),
        "positives": positives,
        "li_days": li["li_days"],
        "li_positives": li["li_positives"],
    }


def _example_lifted_index(example: dict[str, Any]) -> float | None:
    """Valeur BRUTE (K) du lifted index archivé pour cet exemple, ou None (jour < v1.3.167,
    trou de données, ou champ absent)."""
    rec = example.get("rec")
    if not isinstance(rec, dict):
        return None
    ms = rec.get("metric_scores") or {}
    v = ms.get("lifted_index")
    if v is None:
        return None
    try:
        f = float(v)
    except (TypeError, ValueError):
        return None
    return f if math.isfinite(f) else None


def _li_data_counts(examples: list[dict[str, Any]]) -> dict[str, int]:
    """Volumes RESTREINTS aux exemples porteurs d'un lifted index archivé : c'est le seul
    signal qui peut discriminer les gains (les autres jours sont neutres au boost LI)."""
    li_days: set[str] = set()
    li_positives = 0
    li_examples = 0
    for e in examples:
        if _example_lifted_index(e) is None:
            continue
        li_examples += 1
        li_days.add(e["date"])
        if e["label"] >= 1:
            li_positives += 1
    return {"li_days": len(li_days), "li_positives": li_positives, "li_examples": li_examples}


def _time_split(examples: list[dict[str, Any]]) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    days = sorted({e["date"] for e in examples})
    if len(days) < MIN_TEST_DAYS + 1:
        return examples, []
    n_test = max(MIN_TEST_DAYS, round(len(days) * TEST_FRACTION))
    n_test = min(n_test, len(days) - 1)
    test_days = set(days[-n_test:])
    train = [e for e in examples if e["date"] not in test_days]
    test = [e for e in examples if e["date"] in test_days]
    return train, test


def evaluate_and_select(
    examples: list[dict[str, Any]],
    *,
    neighborhood_km: float = DEFAULT_NEIGHBORHOOD_KM,
    rescore_fn: Callable[[dict[str, Any], dict[str, float]], int | None] | None = None,
    li_rescore_fn: Callable[[dict[str, Any], float], int | None] | None = None,
) -> dict[str, Any]:
    """Construit un candidat (calibration + poids si gate + force du boost LI si gate), le valide
    en CV temporelle contre la baseline, et décide de l'activer ou non. Renvoie décision + config
    + skill.

    Le skill (baseline & candidat) est mesuré en VOISINAGE (`neighborhood_km`), comme la
    vérif affichée — pour que l'apprentissage optimise bien la métrique qu'on regarde.

    `rescore_fn(rec, weights) -> score` (injecté par app.py = weather_logic.score_from_archived_cell)
    re-score une cellule via le PIPELINE COMPLET (blend[weights]+gates+modificateurs+confiance).
    Fourni → le candidat à poids appris est validé/déployé À L'IDENTIQUE (fin de l'ancienne
    comparaison inéquitable « blend nu vs formule complète » qui n'activait jamais les poids).
    Absent (auto-tests) → repli sur `blend_score` (ancien comportement).

    `li_rescore_fn(rec, gain) -> score` (injecté = weather_logic.deployed_trigger_from_archived_cell,
    gain explicite) reconstruit le trigger DÉPLOYÉ (base pré-boost + activité + boost LI[gain]) —
    JAMAIS depuis le trigger archivé, qui inclut déjà le boost (double-comptage). Fourni + gate LI
    atteint → on calibre la force du boost LI (cf. LI_GAIN_CANDIDATES). Absent → LI laissé au défaut."""
    counts = _data_counts(examples)
    gates = {
        "calibration_ready": counts["days"] >= CALIB_MIN_DAYS and counts["positives"] >= CALIB_MIN_POSITIVES,
        "weights_ready": counts["days"] >= WEIGHTS_MIN_DAYS and counts["positives"] >= WEIGHTS_MIN_POSITIVES,
        "li_ready": counts.get("li_days", 0) >= LI_MIN_DAYS and counts.get("li_positives", 0) >= LI_MIN_POSITIVES,
        "calib_min_days": CALIB_MIN_DAYS,
        "calib_min_positives": CALIB_MIN_POSITIVES,
        "weights_min_days": WEIGHTS_MIN_DAYS,
        "weights_min_positives": WEIGHTS_MIN_POSITIVES,
        "li_min_days": LI_MIN_DAYS,
        "li_min_positives": LI_MIN_POSITIVES,
    }
    base = {
        "decision": "collecting",
        "data": counts,
        "gates": gates,
        "config": None,
        "skill": None,
        "reason": None,
    }
    if not gates["calibration_ready"]:
        base["reason"] = "not_enough_data"
        return base

    train, test = _time_split(examples)
    if not test:
        base["reason"] = "not_enough_days_for_validation"
        return base

    use_weights = gates["weights_ready"]

    # --- baseline (modèle actuel) sur le test, en VOISINAGE ---
    base_scores_test = [e["trigger"] for e in test]
    baseline_skill = skill_neighborhood(test, base_scores_test, BASELINE_THRESHOLD, neighborhood_km=neighborhood_km)

    # Score d'un candidat à poids `w` : PIPELINE COMPLET si rescore_fn fourni (objet déployé),
    # sinon blend linéaire nu (repli auto-tests). Le fit reste sur le blend (grille rapide) ;
    # seule la VALIDATION passe par le pipeline complet — d'où « fit rapide, validation exacte ».
    def _cand_score(example: dict[str, Any], w: dict[str, float]) -> int:
        if rescore_fn is not None and example.get("rec") is not None:
            s = rescore_fn(example["rec"], w)
            if s is not None:
                return int(s)
        return blend_score(example["blocks"], w)

    # --- candidats : fit sur le train uniquement, skill mesuré sur le test held-out ---
    train_labels = [e["label"] for e in train]
    trigger_train = [e["trigger"] for e in train]

    def _fit_and_score(train_scores: list[int], test_scores: list[int]):
        """Réapprend calibration (isotone) + seuil sur le train, mesure le skill sur le test."""
        curve = isotonic_pav(train_scores, train_labels)
        thr, _ = best_threshold_neighborhood(train, train_scores, neighborhood_km=neighborhood_km)
        skill = skill_neighborhood(test, test_scores, int(thr), neighborhood_km=neighborhood_km)
        return curve, int(thr), skill

    # --- Force du boost LI (indice de soulèvement) : gain ∈ LI_GAIN_CANDIDATES, validé held-out.
    # On RECONSTRUIT le trigger déployé à chaque gain (base pré-boost + activité + boost LI[gain])
    # via li_rescore_fn — jamais depuis e["trigger"] archivé (déjà boosté = double-comptage). Les
    # jours sans LI archivé sont NEUTRES (boost 0 quel que soit le gain) : le signal vient des
    # seuls jours porteurs. On RETIENT un gain > 0 uniquement s'il bat gain=0 d'une marge réelle.
    def _li_trigger_scores(exs: list[dict[str, Any]], gain: float) -> list[int]:
        out: list[int] = []
        for e in exs:
            rec = e.get("rec")
            s = li_rescore_fn(rec, gain) if (li_rescore_fn is not None and rec is not None) else None
            out.append(int(s) if s is not None else int(round(float(e["trigger"]))))
        return out

    li_boost_gain: int | None = None
    li_gain_skill: dict[str, Any] | None = None
    if li_rescore_fn is not None and gates["li_ready"]:
        per_gain = {g: _fit_and_score(_li_trigger_scores(train, g), _li_trigger_scores(test, g))[2]
                    for g in LI_GAIN_CANDIDATES}
        li_gain_skill = {str(g): per_gain[g] for g in LI_GAIN_CANDIDATES}
        zero = per_gain[0]
        best_g = max((g for g in LI_GAIN_CANDIDATES if g > 0),
                     key=lambda g: (per_gain[g]["csi"], per_gain[g]["hss"]))
        if (per_gain[best_g]["csi"] >= zero["csi"] + LI_GAIN_CSI_MARGIN
                and per_gain[best_g]["hss"] >= zero["hss"] - 1e-9):
            li_boost_gain = int(best_g)

    # Candidat CALIBRATION SEULE (poids d'origine) : apporte l'essentiel du gain (seuil+isotone).
    # Au gain LI RETENU si la calibration LI a tranché (sinon trigger archivé = défaut) → le seuil
    # et la courbe restent cohérents avec le trigger réellement déployé.
    if li_boost_gain is not None:
        calib_train_scores = _li_trigger_scores(train, li_boost_gain)
        calib_test_scores = _li_trigger_scores(test, li_boost_gain)
    else:
        calib_train_scores, calib_test_scores = trigger_train, base_scores_test
    calib_curve, calib_thr, calib_skill = _fit_and_score(calib_train_scores, calib_test_scores)
    weights = None
    curve, thr, candidate_skill = calib_curve, calib_thr, calib_skill
    weights_skill = None

    # Candidat À POIDS APPRIS : validé via le pipeline complet (rescore_fn = objet déployé),
    # puis RETENU seulement s'il bat la calibration seule sur le HELD-OUT d'une marge réelle.
    # Sans ce gate, les poids « montaient à bord » du gain de la calibration (l'ancien garde-fou
    # train-Brier sur-apprenait) et s'activaient sans rien apporter — voire avec des proportions
    # physiquement douteuses (humidité à 0 alors que les gates la gèrent déjà).
    if use_weights:
        w = fit_blend_weights(train)
        cand_train = [_cand_score(e, w) for e in train]
        cand_test = [_cand_score(e, w) for e in test]
        w_curve, w_thr, weights_skill = _fit_and_score(cand_train, cand_test)
        if (weights_skill["csi"] >= calib_skill["csi"] + WEIGHTS_CSI_MARGIN
                and weights_skill["hss"] >= calib_skill["hss"] - 1e-9):
            weights = w
            curve, thr, candidate_skill = w_curve, w_thr, weights_skill

    better = (
        candidate_skill["csi"] >= baseline_skill["csi"] + ACTIVATION_CSI_MARGIN
        and candidate_skill["hss"] >= baseline_skill["hss"] - 1e-9
    )

    config = {
        "version": CONFIG_VERSION,
        "mode": "auto",
        "threshold": int(thr),
        "neighborhood_km": round(float(neighborhood_km), 1),
        "calibration": {"type": "isotonic", "points": curve},
        "weights": ({"enabled": True, **weights} if weights else {"enabled": False}),
        # Force du boost LI apprise : None → défaut codé en dur (weather_logic.LI_BOOST_GAIN).
        # Un entier ∈ LI_GAIN_CANDIDATES\{0} seulement s'il bat gain=0 held-out d'une marge.
        "li_boost_gain": li_boost_gain,
        "data": counts,
        # `calibration_only`, `weights` (candidat poids même rejeté) et `li_gain` (CSI par gain LI)
        # exposés pour la transparence : on voit ce que chaque levier APPORTERAIT.
        "skill": {"baseline": baseline_skill, "candidate": candidate_skill,
                  "calibration_only": calib_skill, "weights": weights_skill,
                  "li_gain": li_gain_skill,
                  "test_days": sorted({e["date"] for e in test})},
    }
    base["config"] = config
    base["skill"] = config["skill"]
    base["decision"] = "activate" if better else "keep_baseline"
    base["reason"] = "candidate_better" if better else "no_improvement"
    return base


# --- Persistance (dossier history/learning/) -----------------------------------

def _learning_dir(history_dir: str | Path) -> Path:
    return Path(history_dir) / "learning"


def active_path(history_dir: str | Path) -> Path:
    return _learning_dir(history_dir) / "active.json"


def candidate_path(history_dir: str | Path) -> Path:
    return _learning_dir(history_dir) / "candidate.json"


def log_path(history_dir: str | Path) -> Path:
    return _learning_dir(history_dir) / "log.jsonl"


def load_active(history_dir: str | Path) -> dict[str, Any] | None:
    p = active_path(history_dir)
    if not p.exists():
        return None
    try:
        return json.loads(p.read_text(encoding="utf-8"))
    except Exception:
        return None


def _atomic_write_json(path: Path, payload: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(json.dumps(payload, ensure_ascii=False), encoding="utf-8")
    tmp.replace(path)


def save_active(history_dir: str | Path, config: dict[str, Any]) -> None:
    _atomic_write_json(active_path(history_dir), config)


def save_candidate(history_dir: str | Path, config: dict[str, Any]) -> None:
    _atomic_write_json(candidate_path(history_dir), config)


def clear_active(history_dir: str | Path) -> bool:
    p = active_path(history_dir)
    if p.exists():
        try:
            p.unlink()
            return True
        except OSError:
            return False
    return False


def append_log(history_dir: str | Path, entry: dict[str, Any]) -> None:
    p = log_path(history_dir)
    p.parent.mkdir(parents=True, exist_ok=True)
    try:
        with p.open("a", encoding="utf-8") as fh:
            fh.write(json.dumps(entry, ensure_ascii=False) + "\n")
    except OSError:
        pass


def read_log_tail(history_dir: str | Path, limit: int = 20) -> list[dict[str, Any]]:
    p = log_path(history_dir)
    if not p.exists():
        return []
    try:
        lines = p.read_text(encoding="utf-8").splitlines()
    except OSError:
        return []
    out = []
    for line in lines[-limit:]:
        try:
            out.append(json.loads(line))
        except json.JSONDecodeError:
            continue
    return out


# --- Auto-test -----------------------------------------------------------------

if __name__ == "__main__":
    import random

    # 1) blocs/blend : non-régression du défaut
    blk = {"cape": 80.0, "humid": 60.0, "heat": 50.0, "conv": 40.0}
    expected = clamp(0.44 * 80 + 0.34 * 60 + 0.10 * 50 + 0.12 * 40)
    assert blend_score(blk, DEFAULT_BLEND_WEIGHTS) == expected, blend_score(blk, DEFAULT_BLEND_WEIGHTS)
    # convergence absente -> renormalisation sur 3 poids
    blk_nc = {"cape": 80.0, "humid": 60.0, "heat": 50.0, "conv": None}
    denom = 0.44 + 0.34 + 0.10
    assert blend_score(blk_nc, DEFAULT_BLEND_WEIGHTS) == clamp((0.44 * 80 + 0.34 * 60 + 0.10 * 50) / denom)

    # 2) isotone : monotone croissant
    random.seed(7)
    sc = [random.uniform(0, 100) for _ in range(400)]
    lab = [1 if random.random() < (s / 100.0) else 0 for s in sc]
    curve = isotonic_pav(sc, lab)
    probs = [p for _, p in curve]
    assert all(probs[i] <= probs[i + 1] + 1e-9 for i in range(len(probs) - 1)), curve
    assert calibrated_probability(curve, 90) >= calibrated_probability(curve, 10) - 1e-9

    # 2b) Brier calibré : insensible à l'échelle (même classement, échelle écrasée),
    #     sensible au classement (scores mélangés -> discrimination nulle).
    cb_full = calibrated_brier(sc, lab)
    cb_small = calibrated_brier([s * 0.2 for s in sc], lab)
    assert abs(cb_full - cb_small) < 5e-3, (cb_full, cb_small)  # binning entier -> petite tolérance
    sc_shuffled = list(sc)
    random.shuffle(sc_shuffled)
    assert calibrated_brier(sc_shuffled, lab) > cb_full + 1e-3

    # 2c) RÉGRESSION « 100 % CAPE » : positifs rares + bloc bruit à PETITE échelle.
    #     Au Brier brut, le bruit gagnait (score moyen ≈ taux de base) ; au Brier
    #     calibré, le bloc informatif (échelle haute) doit dominer.
    rng3 = random.Random(23)
    reg = []
    for d in range(30):
        for k in range(80):
            humid = rng3.uniform(50, 100)   # informatif, échelle HAUTE
            cape = rng3.uniform(0, 25)      # bruit pur, échelle basse (piège du Brier brut)
            heat = rng3.uniform(0, 100)     # bruit
            p = 1.0 / (1.0 + math.exp(-(humid - 90.0) / 4.0))
            reg.append({"date": f"2026-06-{d + 1:02d}", "label": 1 if rng3.random() < p else 0,
                        "blocks": {"cape": cape, "humid": humid, "heat": heat, "conv": None}})
    w3 = fit_blend_weights(reg)
    print("poids anti-échelle:", w3, "| positifs:", sum(e["label"] for e in reg))
    assert w3["humid"] > w3["cape"] and w3["humid"] > w3["heat"], w3

    # 3) jeu synthétique : la foudre est pilotée par l'humidité -> le fit doit lui
    #    donner le poids dominant, et le candidat doit battre la baseline en CV.
    rng = random.Random(11)
    examples = []
    for d in range(40):  # 40 jours -> passe le gate calibration ; pas le gate poids
        date = f"2026-04-{d + 1:02d}"
        for _ in range(60):
            cape = rng.uniform(0, 100)
            humid = rng.uniform(0, 100)
            heat = rng.uniform(0, 100)
            conv = rng.uniform(0, 100)
            # vérité terrain : humidité forte + un peu de cape
            p = 1.0 / (1.0 + math.exp(-(0.09 * humid + 0.02 * cape - 7.5)))
            label = 1 if rng.random() < p else 0
            # le modèle "actuel" sous-pondère l'humidité -> trigger mal calibré
            trigger = clamp(0.6 * cape + 0.2 * humid + 0.2 * heat)
            examples.append({
                "date": date, "cell_key": f"{d}_{_}",
                "lat": 43.0 + (_ // 8) * 1.0, "lon": 0.0 + (_ % 8) * 1.0,  # grille 1° (>30km) -> voisinage = exact
                "blocks": {"cape": cape, "humid": humid, "heat": heat, "conv": conv},
                "trigger": trigger, "label": label,
            })
    counts = _data_counts(examples)
    print("counts:", counts)
    assert counts["days"] == 40
    w = fit_blend_weights(examples)
    print("poids appris:", w)
    assert w["humid"] >= max(w["cape"], w["heat"], w["conv"]), w  # humidité dominante

    res = evaluate_and_select(examples)
    print("décision:", res["decision"], "| skill:", res["skill"])
    assert res["gates"]["calibration_ready"] is True
    # 40 jours (>=25) et 719 positifs (>=300) -> le gate poids est aussi atteint ici
    assert res["gates"]["weights_ready"] is True
    assert res["config"]["weights"]["enabled"] is True
    assert res["decision"] == "activate"  # humidité mal pondérée par la baseline -> battue
    assert res["skill"]["candidate"]["csi"] >= res["skill"]["baseline"]["csi"], res["skill"]

    # 3b-pré) Garde-fou : si le score actuel (trigger) classe MIEUX que tout blend
    #     linéaire (ici : interaction cape×humidité qu'aucun mélange ne reproduit),
    #     les poids restent désactivés — on ne remplace pas la formule par pire qu'elle.
    rng4 = random.Random(31)
    guard = []
    for d in range(40):
        date = f"2026-03-{d + 1:02d}" if d < 30 else f"2026-04-{d - 29:02d}"
        for k in range(60):
            cape = rng4.uniform(0, 100)
            humid = rng4.uniform(0, 100)
            heat = rng4.uniform(0, 100)
            inter = cape * humid / 100.0
            guard.append({
                "date": date, "cell_key": f"g{d}_{k}",
                "lat": 43.0 + (k // 8) * 1.0, "lon": 0.0 + (k % 8) * 1.0,
                "blocks": {"cape": cape, "humid": humid, "heat": heat, "conv": None},
                "trigger": clamp(inter),
                "label": 1 if rng4.random() < 1.0 / (1.0 + math.exp(-(inter - 55.0) / 6.0)) else 0,
            })
    res_guard = evaluate_and_select(guard)
    assert res_guard["config"] is not None, res_guard
    assert res_guard["config"]["weights"]["enabled"] is False, res_guard["config"]["weights"]
    print("garde-fou trigger>blend : weights désactivés OK")

    # 3b-bis) rescore_fn injecté : le candidat est scoré via le PIPELINE fourni (pas le blend
    #     nu). Ici le blend sur `blocks` est du BRUIT et le `trigger` aussi, mais rescore_fn
    #     expose le vrai signal (rec['ideal']) → le candidat doit battre la baseline et activer,
    #     avec des scores candidats = ceux du pipeline injecté (preuve du câblage).
    rng5 = random.Random(41)
    inj = []
    for d in range(40):
        date = f"2026-02-{d + 1:02d}" if d < 28 else f"2026-03-{d - 27:02d}"
        for k in range(70):
            h = rng5.uniform(0, 100)                       # variable cachée = vrai signal
            label = 1 if rng5.random() < 1.0 / (1.0 + math.exp(-(h - 62.0) / 7.0)) else 0
            inj.append({
                "date": date, "cell_key": f"i{d}_{k}",
                "lat": 43.0 + (k // 8) * 1.0, "lon": 0.0 + (k % 8) * 1.0,
                "blocks": {"cape": rng5.uniform(0, 100), "humid": rng5.uniform(0, 100),
                           "heat": rng5.uniform(0, 100), "conv": None},   # bruit
                "rec": {"ideal": clamp(h)},                # le pipeline injecté verra le signal
                "trigger": clamp(rng5.uniform(0, 100)),    # baseline = bruit
                "label": label,
            })
    stub_rescore = lambda rec, w: rec["ideal"]            # ignore w, renvoie le vrai signal
    res_inj = evaluate_and_select(inj, rescore_fn=stub_rescore)
    res_noinj = evaluate_and_select(inj)                  # candidat = blend nu sur du bruit
    assert res_inj["gates"]["weights_ready"] is True, res_inj["data"]
    assert res_inj["config"]["weights"]["enabled"] is True, res_inj["config"]["weights"]
    assert res_inj["decision"] == "activate", res_inj["decision"]
    # Preuve du câblage : le candidat scoré via le pipeline injecté (signal parfait) discrimine
    # FRANCHEMENT mieux que le candidat sans injection (blend nu sur du bruit).
    csi_inj = res_inj["skill"]["candidate"]["csi"]
    csi_noinj = res_noinj["skill"]["candidate"]["csi"]
    assert csi_inj > csi_noinj + 0.15, (csi_inj, csi_noinj)
    print(f"rescore_fn injecté : candidat via pipeline CSI={csi_inj:.2f} > sans injection {csi_noinj:.2f} (câblage OK)")

    # 3c) FORCE DU BOOST LI (indice de soulèvement) : reconstruction + calibration.
    #     li_rescore_fn(rec, gain) = base pré-boost + boost LI[gain] (même forme que
    #     weather_logic._lifted_index_boost). Vérité terrain pilotée par base + boost(gain=5).
    rng6 = random.Random(53)
    def _inst(li):  # réplique de la forme du boost LI (onset 2, cap 4)
        return min(4.0, max(0.0, -(li + 2.0)))
    li_stub = lambda rec, gain: clamp(rec["base"] + gain * _inst(rec["li"]))
    li_ex = []
    for d in range(40):
        date = f"2026-07-{d + 1:02d}" if d < 31 else f"2026-08-{d - 30:02d}"
        for k in range(70):
            base_env = rng6.uniform(20, 60)                 # base seule = signal faible/bruité
            li = rng6.uniform(-9.0, 3.0)                    # instabilité d'altitude (négatif = instable)
            deployed = clamp(base_env + 5.0 * _inst(li))    # vérité = base + boost LI (gain défaut 5)
            p = 1.0 / (1.0 + math.exp(-(deployed - 55.0) / 6.0))
            li_ex.append({
                "date": date, "cell_key": f"li{d}_{k}",
                "lat": 43.0 + (k // 8) * 1.0, "lon": 0.0 + (k % 8) * 1.0,
                "blocks": {"cape": base_env, "humid": base_env, "heat": base_env, "conv": None},
                # rec porte le LI archivé (gate) + de quoi reconstruire la base pré-boost (stub).
                "rec": {"base": base_env, "li": li, "metric_scores": {"lifted_index": li}},
                "trigger": deployed,                        # archive = déployé au gain défaut
                "label": 1 if rng6.random() < p else 0,
            })

    # (a) ANTI-DOUBLE-COMPTAGE : reconstruire au gain DÉFAUT (5) reproduit le trigger archivé
    #     (base + boost une seule fois) — surtout PAS archive + boost (qui doublerait).
    for e in li_ex[:200]:
        assert li_stub(e["rec"], 5) == int(round(e["trigger"])), (li_stub(e["rec"], 5), e["trigger"])
        boosted_twice = clamp(e["trigger"] + 5.0 * _inst(e["rec"]["li"]))
        # là où le boost est actif (LI < -2), doubler donnerait STRICTEMENT plus (hors saturation).
        if _inst(e["rec"]["li"]) > 0 and e["trigger"] < 100:
            assert li_stub(e["rec"], 5) < boosted_twice, (li_stub(e["rec"], 5), boosted_twice)
    print("anti-double-comptage LI : reconstruction au gain défaut == archive (pas de double boost) OK")

    # (b) La calibration RETIENT un gain > 0 qui bat gain=0 sur le held-out.
    res_li = evaluate_and_select(li_ex, li_rescore_fn=li_stub)
    assert res_li["gates"]["li_ready"] is True, res_li["data"]
    li_cfg = res_li["config"]["li_boost_gain"]
    assert li_cfg is not None and li_cfg > 0, li_cfg
    lig = res_li["config"]["skill"]["li_gain"]
    csi0 = lig["0"]["csi"]
    csi_best = lig[str(li_cfg)]["csi"]
    assert csi_best >= csi0 + LI_GAIN_CSI_MARGIN, (csi0, csi_best)
    print(f"boost LI calibré : gain={li_cfg} CSI {csi0:.2f}→{csi_best:.2f} (bat gain=0, gate li={res_li['data']['li_days']}j)")

    # (c) Sans li_rescore_fn OU gate LI non atteint → li_boost_gain None (défaut préservé).
    res_no_li = evaluate_and_select(li_ex)  # pas d'injection
    assert res_no_li["config"]["li_boost_gain"] is None, res_no_li["config"]["li_boost_gain"]
    li_short = [e for e in li_ex if e["date"] <= "2026-07-12"]  # < 15 jours avec LI
    res_short = evaluate_and_select(li_short, li_rescore_fn=li_stub)
    assert res_short["gates"]["li_ready"] is False, res_short["data"]
    assert res_short["config"] is None or res_short["config"]["li_boost_gain"] is None
    print("gate LI : pas d'injection ou < seuil jours → gain défaut préservé OK")

    # 3b) gate poids NON atteint (assez de jours, trop peu de positifs) -> calibration seule
    sparse = []
    for d in range(15):
        date = f"2026-05-{d + 1:02d}"
        for k in range(40):
            humid = rng.uniform(0, 100)
            label = 1 if rng.random() < (0.05 if humid < 80 else 0.5) else 0
            sparse.append({
                "date": date, "cell_key": f"s{d}_{k}",
                "lat": 43.0 + (k // 8) * 1.0, "lon": 0.0 + (k % 8) * 1.0,
                "blocks": {"cape": rng.uniform(0, 100), "humid": humid,
                           "heat": rng.uniform(0, 100), "conv": rng.uniform(0, 100)},
                "trigger": clamp(humid), "label": label,
            })
    res_sparse = evaluate_and_select(sparse)
    assert res_sparse["gates"]["calibration_ready"] is True
    assert res_sparse["gates"]["weights_ready"] is False, res_sparse["data"]
    assert res_sparse["config"]["weights"]["enabled"] is False

    # 4) données insuffisantes -> collecting
    few = [e for e in examples if e["date"] <= "2026-04-05"]
    res2 = evaluate_and_select(few)
    assert res2["decision"] == "collecting", res2["decision"]

    # 4b) skill VOISINAGE : un orage à ~14 km d'une cellule à haut score est un near-miss
    #     -> 0 hit en exact, 1 hit en voisinage 30 km (valide la logique spatiale du learning).
    nbh_ex = [
        {"date": "2026-06-01", "lat": 45.0, "lon": 2.0, "label": 0, "blocks": {}},   # prévu (haut score)
        {"date": "2026-06-01", "lat": 45.13, "lon": 2.0, "label": 1, "blocks": {}},  # foudre ~14 km au nord
    ]
    nbh_scores = [80.0, 10.0]
    sk_exact = skill_neighborhood(nbh_ex, nbh_scores, 60, neighborhood_km=0)
    sk_near = skill_neighborhood(nbh_ex, nbh_scores, 60, neighborhood_km=30)
    assert sk_exact["hits"] == 0 and sk_near["hits"] == 1, (sk_exact, sk_near)
    print("voisinage learning: exact hits=%d -> 30km hits=%d" % (sk_exact["hits"], sk_near["hits"]))

    # 5) persistance round-trip (dossier temp)
    import tempfile
    with tempfile.TemporaryDirectory() as tmp:
        assert load_active(tmp) is None
        save_active(tmp, res["config"])
        loaded = load_active(tmp)
        assert loaded and loaded["threshold"] == res["config"]["threshold"]
        append_log(tmp, {"decision": res["decision"]})
        assert read_log_tail(tmp)[-1]["decision"] == res["decision"]
        assert clear_active(tmp) is True
        assert load_active(tmp) is None

    print("OK ✅ auto-test learning")
