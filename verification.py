"""Vérification prévision vs réalité (Phase 3).

Logique PURE, sans dépendance au serveur (testable seule) :
- agréger des flashs observés (MTG-LI) sur les cellules de la grille prévue ;
- croiser « prévu » (trigger_score ≥ seuil) et « observé » (flashs ≥ seuil) en une
  table de contingence, puis en scores de vérification météo standards
  (POD, FAR, CSI, biais, HSS) et un score de fidélité 0-100.

Le récupérateur EUMDAC et le stockage vivent dans app.py ; ici, que des maths.
"""

from __future__ import annotations

import math
from typing import Any, Iterable


# Seuils par défaut, alignés sur l'échelle de la carte de risque.
DEFAULT_SCORE_THRESHOLD = 60      # ≥ 60 = orage prévu (abaissé de 70 : les vrais orages
                                  # observés scoraient 50-67, jamais 70+ — cf. analyse
                                  # modèle-vs-réalité ; CSI=0 à 70, réel à ~55-60).
DEFAULT_FLASH_THRESHOLD = 1       # ≥ 1 flash dans la cellule = orage observé
# Vérification de VOISINAGE : un modèle d'environnement à ~15 km ne peut pas pointer la
# cellule exacte d'une foudre éparse. On tolère un rayon : une cellule prévue est utile si
# de la foudre tombe à ≤ ce rayon, et une cellule foudre est détectée si une cellule prévue
# est à ≤ ce rayon. 0 = correspondance cellule exacte (rétro-compatible).
DEFAULT_NEIGHBORHOOD_KM = 30.0


def cell_key(lat: float, lon: float) -> str:
    """Clé stable d'une cellule (mêmes 3 décimales que predictionCellId côté JS)."""
    return f"{float(lat):.3f}|{float(lon):.3f}"


def _dist_km(a: tuple[float, float], b: tuple[float, float]) -> float:
    """Distance approchée (équirectangulaire) entre deux (lat, lon), en km."""
    dlat = a[0] - b[0]
    dlon = (a[1] - b[1]) * math.cos(math.radians((a[0] + b[0]) / 2.0))
    return 111.0 * math.hypot(dlat, dlon)


def _cell_bounds(cell: dict[str, Any]) -> tuple[float, float, float, float] | None:
    try:
        lat = float(cell["lat"])
        lon = float(cell["lon"])
    except (KeyError, TypeError, ValueError):
        return None
    half_h = abs(float(cell.get("cell_height_deg") or 0.135)) / 2 or 0.0675
    half_w = abs(float(cell.get("cell_width_deg") or 0.18)) / 2 or 0.09
    return (lat - half_h, lat + half_h, lon - half_w, lon + half_w)


def bin_flashes_to_cells(
    flashes: Iterable[tuple[float, float] | tuple[float, float, float]],
    cells: list[dict[str, Any]],
) -> dict[str, float]:
    """Compte les flashs tombant dans chaque cellule de la grille prévue.

    `flashes` : itérable de (lat, lon) ou (lat, lon, poids) — un flash ponctuel ou
    le comptage d'une maille 2 km MTG-LI. `cells` : cellules de la grille (lat, lon,
    cell_width_deg, cell_height_deg). Retour : {cell_key: total_flashs}.

    Indexation spatiale par bucket de 1° : une cellule est enregistrée dans chaque
    bucket entier que ses bornes recouvrent ; un flash n'est testé que contre les
    cellules de SON bucket (garantit l'exactitude car la cellule qui le contient
    recouvre forcément ce bucket).
    """
    buckets: dict[tuple[int, int], list[tuple[str, float, float, float, float]]] = {}
    for cell in cells:
        bounds = _cell_bounds(cell)
        if bounds is None:
            continue
        s, n, w, e = bounds
        key = cell_key(cell["lat"], cell["lon"])
        for blat in range(math.floor(s), math.floor(n) + 1):
            for blon in range(math.floor(w), math.floor(e) + 1):
                buckets.setdefault((blat, blon), []).append((key, s, n, w, e))

    counts: dict[str, float] = {}
    for flash in flashes:
        if len(flash) >= 3:
            flat, flon, weight = float(flash[0]), float(flash[1]), float(flash[2])
        else:
            flat, flon, weight = float(flash[0]), float(flash[1]), 1.0
        if weight <= 0 or not (math.isfinite(flat) and math.isfinite(flon)):
            continue
        candidates = buckets.get((math.floor(flat), math.floor(flon)))
        if not candidates:
            continue
        for key, s, n, w, e in candidates:
            if s <= flat <= n and w <= flon <= e:
                counts[key] = counts.get(key, 0.0) + weight
                break
    return counts


def flashes_within_cells(
    flashes: Iterable[tuple[float, float] | tuple[float, float, float]],
    cells: list[dict[str, Any]],
) -> list[tuple]:
    """Sous-ensemble des flashs tombant DANS une cellule de la grille (= masque
    France : la grille épouse la forme du pays, contrairement à la bbox rectangle
    qui attrape l'Italie/la Suisse). Conserve chaque tuple flash tel quel (heure
    incluse)."""
    buckets: dict[tuple[int, int], list[tuple[float, float, float, float]]] = {}
    for cell in cells:
        bounds = _cell_bounds(cell)
        if bounds is None:
            continue
        s, n, w, e = bounds
        for blat in range(math.floor(s), math.floor(n) + 1):
            for blon in range(math.floor(w), math.floor(e) + 1):
                buckets.setdefault((blat, blon), []).append((s, n, w, e))
    out: list[tuple] = []
    for flash in flashes:
        flat, flon = float(flash[0]), float(flash[1])
        if not (math.isfinite(flat) and math.isfinite(flon)):
            continue
        candidates = buckets.get((math.floor(flat), math.floor(flon)))
        if not candidates:
            continue
        for s, n, w, e in candidates:
            if s <= flat <= n and w <= flon <= e:
                out.append(flash)
                break
    return out


def compute_verification(
    cells: list[dict[str, Any]],
    flashes_per_cell: dict[str, float],
    *,
    score_threshold: int = DEFAULT_SCORE_THRESHOLD,
    flash_threshold: float = DEFAULT_FLASH_THRESHOLD,
    neighborhood_km: float = 0.0,
) -> dict[str, Any]:
    """Table de contingence prévu/observé sur les cellules + scores de vérification.

    Retourne hits/misses/false_alarms/correct_negatives, POD, FAR, success ratio,
    CSI, biais de fréquence, HSS, un score de fidélité 0-100 et une étiquette.

    `neighborhood_km` > 0 active la vérification de VOISINAGE : une cellule foudre est un
    hit s'il existe une cellule prévue à ≤ ce rayon (sinon un miss) ; une cellule prévue est
    une fausse alerte s'il n'y a aucune foudre à ≤ ce rayon. 0 = correspondance cellule exacte.
    """
    forecast_pts: list[tuple[float, float]] = []
    observed_pts: list[tuple[float, float]] = []
    forecast_keys: set[str] = set()
    observed_keys: set[str] = set()
    cell_count = len(cells)
    for cell in cells:
        try:
            score = float(cell.get("trigger_score") or 0)
        except (TypeError, ValueError):
            score = 0.0
        lat, lon = cell.get("lat"), cell.get("lon")
        key = cell_key(lat, lon) if lat is not None else None
        observed = float(flashes_per_cell.get(key, 0.0)) if key else 0.0
        if score >= score_threshold:
            forecast_keys.add(key) if key else None
            forecast_pts.append((float(lat), float(lon)))
        if observed >= flash_threshold:
            observed_keys.add(key) if key else None
            observed_pts.append((float(lat), float(lon)))
    forecast_cells = len(forecast_pts)
    observed_cells = len(observed_pts)

    if neighborhood_km and neighborhood_km > 0:
        radius = float(neighborhood_km)
        hits = sum(1 for o in observed_pts if any(_dist_km(o, f) <= radius for f in forecast_pts))
        misses = observed_cells - hits
        false_alarms = sum(1 for f in forecast_pts if not any(_dist_km(f, o) <= radius for o in observed_pts))
        correct_neg = max(0, cell_count - hits - misses - false_alarms)
    else:
        hits = len(forecast_keys & observed_keys)
        misses = len(observed_keys - forecast_keys)
        false_alarms = len(forecast_keys - observed_keys)
        correct_neg = cell_count - len(forecast_keys | observed_keys)

    def _ratio(num: int, den: int) -> float | None:
        return round(num / den, 3) if den > 0 else None

    pod = _ratio(hits, hits + misses)                       # détection
    far = _ratio(false_alarms, hits + false_alarms)         # fausses alertes
    success_ratio = _ratio(hits, hits + false_alarms)       # précision (1 - FAR)
    csi = _ratio(hits, hits + misses + false_alarms)        # indice de succès critique
    bias = _ratio(hits + false_alarms, hits + misses)       # biais de fréquence

    total = hits + misses + false_alarms + correct_neg
    hss: float | None = None
    if total > 0:
        expected = (
            (hits + misses) * (hits + false_alarms)
            + (correct_neg + misses) * (correct_neg + false_alarms)
        ) / total
        denom = total - expected
        hss = round((hits + correct_neg - expected) / denom, 3) if denom != 0 else None

    # Trop peu d'orages observés -> le CSI est très bruité, score peu significatif.
    low_signal = observed_cells < 5
    # Score de fidélité 0-100 : CSI quand il y a des orages ; cas particuliers sinon.
    if observed_cells == 0 and forecast_cells == 0:
        fidelity = 100
        label = "Journée calme correctement prévue"
    elif observed_cells == 0 and forecast_cells > 0:
        fidelity = 0
        label = "Calme observé, quelques zones prévues à tort"
    elif csi is None:
        fidelity = None
        label = "Indéterminé"
    elif low_signal:
        fidelity = round(csi * 100)
        label = "Activité orageuse faible — score peu significatif"
    else:
        fidelity = round(csi * 100)
        if fidelity >= 70:
            label = "Très bonne prévision"
        elif fidelity >= 45:
            label = "Bonne prévision"
        elif fidelity >= 20:
            label = "Prévision moyenne"
        else:
            label = "Prévision médiocre"

    return {
        "ok": True,
        "score_threshold": score_threshold,
        "flash_threshold": flash_threshold,
        "neighborhood_km": round(float(neighborhood_km), 1),
        "cell_count": len(cells),
        "forecast_cells": forecast_cells,
        "observed_cells": observed_cells,
        "contingency": {
            "hits": hits,
            "misses": misses,
            "false_alarms": false_alarms,
            "correct_negatives": correct_neg,
        },
        "scores": {
            "pod": pod,
            "far": far,
            "success_ratio": success_ratio,
            "csi": csi,
            "frequency_bias": bias,
            "hss": hss,
        },
        "fidelity": fidelity,
        "label": label,
        "low_signal": low_signal,
    }


if __name__ == "__main__":
    # Auto-test : grille 5x5 (~0.135°), prévision = moitié gauche, foudre = un carré
    # qui chevauche en partie la zone prévue -> on attend des hits + misses + FA.
    grid = []
    for i in range(5):
        for j in range(5):
            grid.append({
                "lat": 45.0 + i * 0.135,
                "lon": 2.0 + j * 0.135,
                "cell_height_deg": 0.135,
                "cell_width_deg": 0.135,
                "trigger_score": 75 if j < 3 else 10,  # prévu : colonnes 0-2
            })
    # flashs observés dans les colonnes 1-3 (chevauchement partiel avec le prévu)
    flashes = []
    for i in range(5):
        for j in (1, 2, 3):
            flashes.append((45.0 + i * 0.135, 2.0 + j * 0.135))  # centre de cellule
    binned = bin_flashes_to_cells(flashes, grid)
    res = compute_verification(grid, binned)
    print("flashs agrégés sur cellules:", len(binned), "cellules touchées")
    print("contingence:", res["contingency"])
    print("scores:", res["scores"])
    print("fidélité:", res["fidelity"], "·", res["label"])
    c = res["contingency"]
    assert c["hits"] == 10, c          # colonnes 1-2 prévues+observées (2 col x 5)
    assert c["misses"] == 5, c         # colonne 3 observée non prévue
    assert c["false_alarms"] == 5, c   # colonne 0 prévue non observée
    assert c["correct_negatives"] == 5, c
    assert res["scores"]["pod"] == round(10 / 15, 3)
    assert res["scores"]["csi"] == round(10 / 20, 3)
    print("OK ✅ auto-test vérification")
