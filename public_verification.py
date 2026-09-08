"""public_verification.py — Page de vérification publique (« prévu contre observé »).

Logique PURE, sans dépendance au serveur ni à l'archive (testable seule), au même contrat
que `verification.py` : ici, que des maths et des règles ; la lecture de l'archive, les
caches et le HTML vivent dans app.py.

Ce que ce module produit, et rien d'autre :
- l'AGRÉGATION de tables de contingence quotidiennes en fenêtres glissantes (7 j / 30 j /
  saison), chacune avec son EFFECTIF — un score sans son n ne veut rien dire, et sous un
  plancher on renvoie None avec la raison plutôt qu'un chiffre trompeur ;
- la CLASSIFICATION cellule par cellule (hit / miss / fausse alerte), qui n'existe pas dans
  verification.py, pour ventiler par région — l'auto-test vérifie qu'elle reproduit
  EXACTEMENT `verification.compute_verification`, sinon la page dirait autre chose que la
  page Historique ;
- la COURBE DE FIABILITÉ binée, sur les DEUX définitions de « la foudre est tombée »
  (cellule exacte / voisinage), parce que l'écart entre les deux est du simple au double
  et qu'un lecteur d'Infoclimat cherchera laquelle on a prise ;
- la SÉLECTION DES CAS montrés, déterministe et bornée : les N journées les plus actives et
  les N pires CSI. Aucune main humaine, jamais — c'est la condition pour que la page reste
  un argument de crédibilité et pas une vitrine.

CE QUE CE MODULE NE FAIT PAS : il ne calcule aucun score de prévision et ne relit aucun
seuil appris. Le moteur (`weather_logic`, `learning`) est en lecture seule vis-à-vis de la
page publique.
"""

from __future__ import annotations

import math
from datetime import date as Date, timedelta
from typing import Any, Callable, Iterable, Sequence

import verification

# ── Planchers d'effectif ─────────────────────────────────────────────────────
# Sous ces valeurs, on n'affiche PAS un score : on dit qu'il n'est pas significatif. Un CSI
# sur 3 événements est du bruit, et le publier serait exactement le genre de présentation
# flatteuse que la page est censée rendre impossible.
MIN_POSITIVES_WINDOW = 30    # fenêtre glissante (cellules-jours foudroyées)
MIN_POSITIVES_REGION = 50    # ventilation régionale : maille plus fine, plancher plus haut
MIN_POSITIVES_CASE = 20      # une journée montrée comme « cas »
MIN_N_RELIABILITY_BIN = 100  # tranche de la courbe de fiabilité

RELIABILITY_BIN_WIDTH = 10   # tranches de score : 0-9, 10-19, …, 90-100
SEASON_START_MONTH = 4       # « saison » = depuis le 1er avril. Règle de CALENDRIER, fixe :
SEASON_START_DAY = 1         # jamais une plage choisie après coup pour flatter le résultat.

CASES_MOST_ACTIVE = 3        # journées les plus foudroyées
CASES_WORST = 3              # pires CSI — les ratés sont montrés au même titre


# ── Table de contingence → scores ────────────────────────────────────────────

def _ratio(num: int, den: int) -> float | None:
    return round(num / den, 3) if den > 0 else None


def scores_from_table(hits: int, misses: int, false_alarms: int, correct_negatives: int) -> dict[str, Any]:
    """POD / FAR / success ratio / CSI / biais / HSS depuis une table de contingence.

    Formules IDENTIQUES à verification.compute_verification (l'auto-test le vérifie sur des
    tables réelles) : la page publique et la page Historique doivent dire le même chiffre.
    """
    hits, misses = int(hits), int(misses)
    false_alarms, correct_negatives = int(false_alarms), int(correct_negatives)
    total = hits + misses + false_alarms + correct_negatives
    hss: float | None = None
    if total > 0:
        expected = (
            (hits + misses) * (hits + false_alarms)
            + (correct_negatives + misses) * (correct_negatives + false_alarms)
        ) / total
        denom = total - expected
        hss = round((hits + correct_negatives - expected) / denom, 3) if denom != 0 else None
    return {
        "pod": _ratio(hits, hits + misses),
        "far": _ratio(false_alarms, hits + false_alarms),
        "success_ratio": _ratio(hits, hits + false_alarms),
        "csi": _ratio(hits, hits + misses + false_alarms),
        "frequency_bias": _ratio(hits + false_alarms, hits + misses),
        "hss": hss,
    }


def _table_of(day: dict[str, Any]) -> dict[str, int]:
    c = day.get("contingency") or {}
    return {
        "hits": int(c.get("hits") or 0),
        "misses": int(c.get("misses") or 0),
        "false_alarms": int(c.get("false_alarms") or 0),
        "correct_negatives": int(c.get("correct_negatives") or 0),
    }


def pool_days(days: Sequence[dict[str, Any]], *, min_positives: int = MIN_POSITIVES_WINDOW) -> dict[str, Any]:
    """Somme les tables de contingence quotidiennes, puis calcule les scores dessus.

    C'est la méthode standard (« pooled contingency table ») : on ne fait JAMAIS la moyenne
    de CSI journaliers, qui donnerait le même poids à une journée de 3 cellules et à une
    journée de 1 200. `positives` (= hits + misses) est l'effectif publié à côté du score ;
    sous `min_positives`, les scores valent None et `reason` dit pourquoi.
    """
    h = m = fa = cn = 0
    dates: list[str] = []
    for day in days:
        t = _table_of(day)
        h += t["hits"]; m += t["misses"]; fa += t["false_alarms"]; cn += t["correct_negatives"]
        if day.get("date"):
            dates.append(str(day["date"]))
    positives = h + m
    significant = positives >= int(min_positives)
    return {
        "days": len(days),
        "dates": sorted(dates),
        "first_date": min(dates) if dates else None,
        "last_date": max(dates) if dates else None,
        "contingency": {"hits": h, "misses": m, "false_alarms": fa, "correct_negatives": cn},
        # `positives` = cellules-jours réellement foudroyées : le SEUL effectif qui compte
        # pour juger un CSI. Affiché systématiquement à côté du score.
        "positives": positives,
        "forecast_positives": h + fa,
        "significant": significant,
        "min_positives": int(min_positives),
        "scores": scores_from_table(h, m, fa, cn) if significant else {
            "pod": None, "far": None, "success_ratio": None, "csi": None,
            "frequency_bias": None, "hss": None,
        },
        "reason": None if significant else "effectif_insuffisant",
    }


# ── Fenêtres glissantes ──────────────────────────────────────────────────────

def season_start(reference: Date) -> Date:
    """Début de la « saison » : le 1er avril qui précède `reference`. Règle de calendrier
    pure — aucune borne ne dépend des résultats."""
    start = Date(reference.year, SEASON_START_MONTH, SEASON_START_DAY)
    return start if reference >= start else Date(reference.year - 1, SEASON_START_MONTH, SEASON_START_DAY)


def windows(days: Sequence[dict[str, Any]], reference: Date) -> dict[str, dict[str, Any]]:
    """Trois fenêtres FIXES, bornées par la date de référence (dernier jour vérifié).

    Aucune n'est choisie par l'utilisateur ni par nous : 7 jours, 30 jours, et la saison en
    cours (depuis le 1er avril). Chaque fenêtre porte son effectif et son étiquette.
    """
    by_date = {str(d.get("date")): d for d in days if d.get("date")}

    def _slice(start: Date) -> list[dict[str, Any]]:
        lo, hi = start.isoformat(), reference.isoformat()
        return [by_date[k] for k in sorted(by_date) if lo <= k <= hi]

    saison_debut = season_start(reference)
    return {
        "7j": {
            "label": "7 derniers jours",
            "start": (reference - timedelta(days=6)).isoformat(),
            "end": reference.isoformat(),
            **pool_days(_slice(reference - timedelta(days=6))),
        },
        "30j": {
            "label": "30 derniers jours",
            "start": (reference - timedelta(days=29)).isoformat(),
            "end": reference.isoformat(),
            **pool_days(_slice(reference - timedelta(days=29))),
        },
        "saison": {
            "label": f"Saison {reference.year if reference >= Date(reference.year, SEASON_START_MONTH, SEASON_START_DAY) else reference.year - 1}"
                     " (depuis le 1er avril)",
            "start": saison_debut.isoformat(),
            "end": reference.isoformat(),
            **pool_days(_slice(saison_debut)),
        },
    }


# ── Classification cellule par cellule (pour la ventilation régionale) ───────

class _NeighborIndex:
    """Index par seaux de 0,5° pour répondre à « existe-t-il un point à ≤ rayon ? ».

    La recherche est un SUR-ENSEMBLE conservateur (bornes en latitude par radius/111, en
    longitude par le cosinus de la latitude la plus défavorable du voisinage) : le prédicat
    de distance appliqué ensuite est celui de verification.py, au réel près. Le résultat est
    donc identique à la boucle naïve — l'auto-test le vérifie — mais on passe de ~530 000
    distances par journée à quelques centaines.
    """

    BUCKET = 0.5

    def __init__(self, points: Iterable[tuple[float, float]]) -> None:
        self.buckets: dict[tuple[int, int], list[tuple[float, float]]] = {}
        self.empty = True
        for lat, lon in points:
            self.empty = False
            key = (int(math.floor(lat / self.BUCKET)), int(math.floor(lon / self.BUCKET)))
            self.buckets.setdefault(key, []).append((lat, lon))

    def any_within(self, lat: float, lon: float, radius: float) -> bool:
        if self.empty or radius < 0:
            return False
        dlat = radius / 111.0
        # cosinus au pire (latitude la plus éloignée de l'équateur dans la fenêtre) → dlon max
        worst_lat = max(abs(lat - dlat), abs(lat + dlat))
        cos_worst = math.cos(math.radians(min(worst_lat, 89.9)))
        dlon = radius / (111.0 * cos_worst) if cos_worst > 1e-9 else 180.0
        lat_lo = int(math.floor((lat - dlat) / self.BUCKET))
        lat_hi = int(math.floor((lat + dlat) / self.BUCKET))
        lon_lo = int(math.floor((lon - dlon) / self.BUCKET))
        lon_hi = int(math.floor((lon + dlon) / self.BUCKET))
        for blat in range(lat_lo, lat_hi + 1):
            for blon in range(lon_lo, lon_hi + 1):
                for point in self.buckets.get((blat, blon), ()):
                    if _dist_km((lat, lon), point) <= radius:
                        return True
        return False


def classify_cells(
    cells: list[dict[str, Any]],
    flashes_per_cell: dict[str, float],
    *,
    score_threshold: int,
    flash_threshold: float = verification.DEFAULT_FLASH_THRESHOLD,
    neighborhood_km: float = verification.DEFAULT_NEIGHBORHOOD_KM,
) -> list[dict[str, Any]]:
    """Étiquette CHAQUE cellule : prévue ? observée ? hit / miss / fausse alerte ? foudre à côté ?

    `verification.compute_verification` ne rend que les totaux ; pour ventiler par région et
    pour tracer la courbe de fiabilité il faut savoir OÙ chaque événement est tombé. On
    reproduit donc sa règle de voisinage à l'identique (l'auto-test compare les deux sorties) :

      - une cellule OBSERVÉE est un HIT s'il existe une cellule prévue à ≤ rayon, sinon un MISS ;
      - une cellule PRÉVUE est une FAUSSE ALERTE s'il n'y a aucune cellule observée à ≤ rayon ;
      - tout le reste est un correct negative.

    Une même cellule peut être observée ET prévue : elle compte alors une fois côté observé
    (hit) et zéro fois côté prévu (pas une fausse alerte). Aucun double comptage.

    `near_observed` est calculé pour TOUTES les cellules, prévues ou non — c'est ce dont la
    courbe de fiabilité a besoin, et ça n'entre dans aucune table de contingence.
    """
    radius = float(neighborhood_km or 0)
    labelled: list[dict[str, Any]] = []
    forecast_pts: list[tuple[float, float]] = []
    observed_pts: list[tuple[float, float]] = []
    for cell in cells:
        lat, lon = cell.get("lat"), cell.get("lon")
        if lat is None or lon is None:
            continue
        try:
            score = float(cell.get("trigger_score") or 0)
        except (TypeError, ValueError):
            score = 0.0
        key = verification.cell_key(lat, lon)
        observed_flashes = float(flashes_per_cell.get(key, 0.0))
        forecast = score >= score_threshold
        observed = observed_flashes >= flash_threshold
        entry = {
            "key": key, "lat": float(lat), "lon": float(lon), "score": score,
            "flashes": observed_flashes, "forecast": forecast, "observed": observed,
            "hit": False, "miss": False, "false_alarm": False, "near_observed": observed,
        }
        if forecast:
            forecast_pts.append((float(lat), float(lon)))
        if observed:
            observed_pts.append((float(lat), float(lon)))
        labelled.append(entry)

    if radius > 0:
        forecast_index = _NeighborIndex(forecast_pts)
        observed_index = _NeighborIndex(observed_pts)
        for entry in labelled:
            lat, lon = entry["lat"], entry["lon"]
            near_obs = entry["observed"] or observed_index.any_within(lat, lon, radius)
            entry["near_observed"] = near_obs
            if entry["observed"]:
                near_forecast = forecast_index.any_within(lat, lon, radius)
                entry["hit"] = near_forecast
                entry["miss"] = not near_forecast
            if entry["forecast"]:
                entry["false_alarm"] = not near_obs
    else:
        for entry in labelled:
            entry["hit"] = entry["forecast"] and entry["observed"]
            entry["miss"] = entry["observed"] and not entry["forecast"]
            entry["false_alarm"] = entry["forecast"] and not entry["observed"]
    return labelled


def _dist_km(a: tuple[float, float], b: tuple[float, float]) -> float:
    """Même distance équirectangulaire que verification._dist_km — recopiée plutôt
    qu'importée d'un nom privé, mais l'auto-test vérifie qu'elles concordent."""
    dlat = a[0] - b[0]
    dlon = (a[1] - b[1]) * math.cos(math.radians((a[0] + b[0]) / 2.0))
    return 111.0 * math.hypot(dlat, dlon)


def table_from_classified(labelled: Iterable[dict[str, Any]]) -> dict[str, int]:
    """Table de contingence d'un sous-ensemble de cellules étiquetées."""
    entries = list(labelled)
    hits = sum(1 for e in entries if e["hit"])
    misses = sum(1 for e in entries if e["miss"])
    fa = sum(1 for e in entries if e["false_alarm"])
    return {
        "hits": hits, "misses": misses, "false_alarms": fa,
        # Comme dans verification.py (branche voisinage) : le reste de la grille.
        "correct_negatives": max(0, len(entries) - hits - misses - fa),
    }


# ── Ventilation régionale ────────────────────────────────────────────────────

def aggregate_by_zone(
    labelled: Iterable[dict[str, Any]],
    zone_of: Callable[[dict[str, Any]], str | None],
) -> dict[str, dict[str, int]]:
    """Tables de contingence par zone. `zone_of` rend None pour une cellule hors zone
    (littoral, frontière) : elle est alors comptée nulle part, jamais rattachée d'office."""
    out: dict[str, dict[str, int]] = {}
    for entry in labelled:
        zone = zone_of(entry)
        if not zone:
            continue
        acc = out.setdefault(zone, {"hits": 0, "misses": 0, "false_alarms": 0, "cells": 0})
        acc["cells"] += 1
        if entry["hit"]:
            acc["hits"] += 1
        if entry["miss"]:
            acc["misses"] += 1
        if entry["false_alarm"]:
            acc["false_alarms"] += 1
    for acc in out.values():
        acc["correct_negatives"] = max(
            0, acc["cells"] - acc["hits"] - acc["misses"] - acc["false_alarms"])
    return out


def merge_zone_tables(a: dict[str, dict[str, int]], b: dict[str, dict[str, int]]) -> dict[str, dict[str, int]]:
    """Somme deux ventilations (accumulation jour après jour)."""
    out = {zone: dict(table) for zone, table in a.items()}
    for zone, table in b.items():
        acc = out.setdefault(zone, {k: 0 for k in table})
        for key, value in table.items():
            acc[key] = acc.get(key, 0) + value
    return out


def zone_rows(zones: dict[str, dict[str, int]], *, min_positives: int = MIN_POSITIVES_REGION) -> list[dict[str, Any]]:
    """Lignes prêtes à afficher, triées par zone. Une zone sous le plancher garde ses
    effectifs mais perd ses scores : on montre qu'elle existe et qu'on ne sait pas."""
    rows: list[dict[str, Any]] = []
    for zone in sorted(zones):
        t = zones[zone]
        positives = t.get("hits", 0) + t.get("misses", 0)
        significant = positives >= int(min_positives)
        rows.append({
            "zone": zone,
            "cells": t.get("cells", 0),
            "contingency": {k: t.get(k, 0) for k in
                            ("hits", "misses", "false_alarms", "correct_negatives")},
            "positives": positives,
            "significant": significant,
            "scores": scores_from_table(
                t.get("hits", 0), t.get("misses", 0),
                t.get("false_alarms", 0), t.get("correct_negatives", 0),
            ) if significant else {"pod": None, "far": None, "success_ratio": None,
                                   "csi": None, "frequency_bias": None, "hss": None},
            "reason": None if significant else "effectif_insuffisant",
        })
    return rows


# ── Régions : la maille de la ventilation géographique ───────────────────────
# Les 13 régions métropolitaines, choisies plutôt qu'un découpage maison : un lecteur
# reconnaît « Occitanie », pas « Sud-Centre ». Par DÉPARTEMENT l'effectif serait du bruit
# (≈ 27 cellules de grille chacun) ; par région il tient (mesuré : 350 à 1 000 cellules-jours
# foudroyées par fenêtre de 30 jours en saison). La géométrie vient de push.department_at.
REGIONS_FR: dict[str, tuple[str, ...]] = {
    "Auvergne-Rhône-Alpes":      ("01", "03", "07", "15", "26", "38", "42", "43", "63", "69", "73", "74"),
    "Bourgogne-Franche-Comté":   ("21", "25", "39", "58", "70", "71", "89", "90"),
    "Bretagne":                  ("22", "29", "35", "56"),
    "Centre-Val de Loire":       ("18", "28", "36", "37", "41", "45"),
    "Corse":                     ("2A", "2B"),
    "Grand Est":                 ("08", "10", "51", "52", "54", "55", "57", "67", "68", "88"),
    "Hauts-de-France":           ("02", "59", "60", "62", "80"),
    "Île-de-France":             ("75", "77", "78", "91", "92", "93", "94", "95"),
    "Normandie":                 ("14", "27", "50", "61", "76"),
    "Nouvelle-Aquitaine":        ("16", "17", "19", "23", "24", "33", "40", "47", "64", "79", "86", "87"),
    "Occitanie":                 ("09", "11", "12", "30", "31", "32", "34", "46", "48", "65", "66", "81", "82"),
    "Pays de la Loire":          ("44", "49", "53", "72", "85"),
    "Provence-Alpes-Côte d'Azur": ("04", "05", "06", "13", "83", "84"),
}

_REGION_OF_DEPT: dict[str, str] = {
    code: region for region, codes in REGIONS_FR.items() for code in codes
}


def region_of_department(code: str | None) -> str | None:
    """Région métropolitaine d'un code département, ou None (mer, hors métropole, code
    inconnu). Rendre None plutôt que de rattacher d'office : une cellule au large ne doit
    gonfler le score d'aucune région."""
    if not code:
        return None
    return _REGION_OF_DEPT.get(str(code).strip().upper())


# ── Courbe de fiabilité ──────────────────────────────────────────────────────

def bin_index(score: float) -> int:
    """Tranche de 10 points ; 100 rejoint la tranche 90-100 (pas de 11e tranche à 1 point)."""
    return min(int(max(0.0, float(score)) // RELIABILITY_BIN_WIDTH), 9)


def empty_bins() -> list[dict[str, int]]:
    return [{"n": 0, "cell": 0, "near": 0} for _ in range(10)]


def add_day_to_bins(bins: list[dict[str, int]], labelled: Iterable[dict[str, Any]]) -> list[dict[str, int]]:
    """Accumule une journée. `cell` = foudre DANS la cellule ; `near` = foudre à ≤ rayon
    (la cellule elle-même comptant comme à distance nulle). Deux définitions, jamais mélangées."""
    for entry in labelled:
        b = bins[bin_index(entry["score"])]
        b["n"] += 1
        if entry["observed"]:
            b["cell"] += 1
        if entry.get("near_observed"):
            b["near"] += 1
    return bins


def reliability_rows(bins: Sequence[dict[str, int]], *, min_n: int = MIN_N_RELIABILITY_BIN) -> list[dict[str, Any]]:
    """Fréquence observée par tranche de score, sur les deux définitions, avec n.

    Une tranche sous `min_n` garde son effectif mais ses fréquences valent None : c'est
    exactement ce qui arrive à la tranche 90-100, qui compte quelques dizaines de cellules.
    """
    rows: list[dict[str, Any]] = []
    for i, b in enumerate(bins):
        lo = i * RELIABILITY_BIN_WIDTH
        hi = 100 if i == 9 else lo + RELIABILITY_BIN_WIDTH - 1
        n = int(b.get("n") or 0)
        ok = n >= int(min_n)
        rows.append({
            "bin": [lo, hi],
            "label": f"{lo}-{hi}",
            "n": n,
            "observed_in_cell": round(b.get("cell", 0) / n, 4) if (ok and n) else None,
            "observed_nearby": round(b.get("near", 0) / n, 4) if (ok and n) else None,
            "counts": {"in_cell": int(b.get("cell") or 0), "nearby": int(b.get("near") or 0)},
            "significant": ok,
        })
    return rows


# ── Sélection déterministe des cas montrés ───────────────────────────────────

def pick_cases(
    days: Sequence[dict[str, Any]],
    *,
    most_active: int = CASES_MOST_ACTIVE,
    worst: int = CASES_WORST,
    min_positives: int = MIN_POSITIVES_CASE,
) -> list[dict[str, Any]]:
    """Les journées montrées côte à côte : les plus actives ET les pires.

    Règle ENTIÈREMENT déterministe, réexécutable par n'importe qui à partir des mêmes
    données — c'est ce qui interdit de choisir les cas à la main :
      1. on écarte les journées sous le plancher d'effectif (un CSI sur 4 cellules ne dit rien) ;
      2. `most_active` journées avec le plus de cellules foudroyées ;
      3. `worst` journées au plus faible CSI parmi celles qui restent ;
      4. tri final par date décroissante, chaque cas portant la raison de sa sélection.
    Départage systématique par la date (la plus récente d'abord) : aucune égalité ne laisse
    de place à l'arbitraire.
    """
    eligible = [d for d in days
                if d.get("date") and (_table_of(d)["hits"] + _table_of(d)["misses"]) >= int(min_positives)]

    def positives(d: dict[str, Any]) -> int:
        t = _table_of(d)
        return t["hits"] + t["misses"]

    def csi_of(d: dict[str, Any]) -> float:
        t = _table_of(d)
        denom = t["hits"] + t["misses"] + t["false_alarms"]
        return (t["hits"] / denom) if denom else 0.0

    # Deux tris stables enchaînés : date décroissante d'abord, critère ensuite. À égalité
    # parfaite, c'est donc toujours la journée la plus RÉCENTE qui passe — règle unique,
    # indépendante de l'ordre dans lequel les journées arrivent.
    par_date = sorted(eligible, key=lambda d: str(d["date"]), reverse=True)
    actifs = sorted(par_date, key=lambda d: -positives(d))[:int(most_active)]
    pris = {str(d["date"]) for d in actifs}
    rates = sorted((d for d in par_date if str(d["date"]) not in pris), key=csi_of)[:int(worst)]

    cases: list[dict[str, Any]] = []
    for day in actifs:
        cases.append({"date": str(day["date"]), "reason": "journee_la_plus_active",
                      "positives": positives(day), "csi": round(csi_of(day), 3)})
    for day in rates:
        cases.append({"date": str(day["date"]), "reason": "pire_csi",
                      "positives": positives(day), "csi": round(csi_of(day), 3)})
    cases.sort(key=lambda c: c["date"], reverse=True)
    return cases


# ── Auto-test ────────────────────────────────────────────────────────────────
if __name__ == "__main__":
    ok = {"n": 0, "fail": 0}

    def check(label: str, cond: bool, detail: Any = "") -> None:
        ok["n"] += 1
        ok["fail"] += 0 if cond else 1
        print(("  ✓ " if cond else "  ✗ ") + label + (f"  {detail}" if (detail and not cond) else ""))

    print("=== la classification reproduit EXACTEMENT verification.compute_verification ===")
    # Grille 8x8 (~0.135°), prévision = moitié gauche, foudre = un carré décalé : la
    # configuration qui produit des hits, des misses ET des fausses alertes à la fois.
    grid = []
    for i in range(8):
        for j in range(8):
            grid.append({
                "lat": 45.0 + i * 0.135, "lon": 2.0 + j * 0.135,
                "cell_height_deg": 0.135, "cell_width_deg": 0.135,
                "trigger_score": 75 if j < 4 else 12,
            })
    fpc = {verification.cell_key(45.0 + i * 0.135, 2.0 + j * 0.135): 3.0
           for i in range(8) for j in (2, 3, 4, 5)}

    for nb in (0.0, 30.0):
        ref = verification.compute_verification(grid, fpc, score_threshold=60, neighborhood_km=nb)
        mine = table_from_classified(classify_cells(grid, fpc, score_threshold=60, neighborhood_km=nb))
        check(f"table identique à voisinage {nb:g} km", mine == ref["contingency"],
              f"{mine} != {ref['contingency']}")
        check(f"scores identiques à voisinage {nb:g} km",
              scores_from_table(**mine) == ref["scores"],
              f"{scores_from_table(**mine)} != {ref['scores']}")

    print("=== la distance est bien celle de verification.py ===")
    for a, b in (((45.0, 2.0), (45.3, 2.4)), ((48.9, 2.35), (43.3, 5.4)), ((41.1, 9.0), (51.4, -5.5))):
        check(f"_dist_km {a}→{b}", abs(_dist_km(a, b) - verification._dist_km(a, b)) < 1e-9)

    print("=== l'agrégation somme les TABLES, pas les CSI ===")
    # Une journée énorme bien prévue + une minuscule ratée : la moyenne de CSI donnerait
    # 0,25, la table groupée donne 0,49. C'est tout l'enjeu.
    gros = {"date": "2026-06-28", "contingency": {"hits": 100, "misses": 10, "false_alarms": 10, "correct_negatives": 2500}}
    petit = {"date": "2026-06-29", "contingency": {"hits": 0, "misses": 4, "false_alarms": 6, "correct_negatives": 2600}}
    pooled = pool_days([gros, petit], min_positives=1)
    check("hits sommés", pooled["contingency"]["hits"] == 100)
    check("effectif = hits + misses", pooled["positives"] == 114, pooled["positives"])
    check("CSI groupé ≠ moyenne des CSI", pooled["scores"]["csi"] == round(100 / 130, 3), pooled["scores"]["csi"])
    check("la plage est bornée par les dates réelles",
          (pooled["first_date"], pooled["last_date"]) == ("2026-06-28", "2026-06-29"))

    print("=== sous le plancher, on n'affiche PAS un chiffre ===")
    maigre = pool_days([petit], min_positives=MIN_POSITIVES_WINDOW)
    check("scores neutralisés", all(v is None for v in maigre["scores"].values()))
    check("effectif tout de même publié", maigre["positives"] == 4)
    check("la raison est explicite", maigre["reason"] == "effectif_insuffisant")
    check("significant = False", maigre["significant"] is False)
    check("au-dessus du plancher, le score revient",
          pool_days([gros], min_positives=MIN_POSITIVES_WINDOW)["scores"]["csi"] is not None)

    print("=== les fenêtres sont FIXES et bornées par la référence ===")
    jours = [{"date": (Date(2026, 9, 8) - timedelta(days=k)).isoformat(),
              "contingency": {"hits": 20, "misses": 5, "false_alarms": 7, "correct_negatives": 2600}}
             for k in range(120)]
    w = windows(jours, Date(2026, 9, 8))
    check("7 jours = 7 journées", w["7j"]["days"] == 7, w["7j"]["days"])
    check("30 jours = 30 journées", w["30j"]["days"] == 30, w["30j"]["days"])
    check("saison démarre le 1er avril", w["saison"]["start"] == "2026-04-01", w["saison"]["start"])
    check("saison bornée par les données disponibles", w["saison"]["days"] == 120, w["saison"]["days"])
    check("aucune fenêtre ne dépasse la référence",
          all(x["end"] == "2026-09-08" for x in w.values()))
    check("saison avant avril = celle de l'an passé",
          season_start(Date(2026, 2, 3)) == Date(2025, 4, 1), season_start(Date(2026, 2, 3)))
    check("le 1er avril appartient à sa propre saison",
          season_start(Date(2026, 4, 1)) == Date(2026, 4, 1))
    vide = windows([], Date(2026, 9, 8))
    check("aucune donnée → pas de score inventé", vide["7j"]["scores"]["csi"] is None)
    check("aucune donnée → effectif zéro assumé", vide["7j"]["positives"] == 0)

    print("=== ventilation régionale ===")
    lab = classify_cells(grid, fpc, score_threshold=60, neighborhood_km=30.0)
    zones = aggregate_by_zone(lab, lambda e: "ouest" if e["lon"] < 2.4 else "est")
    total = table_from_classified(lab)
    check("les zones se recomposent en la table entière",
          sum(z["hits"] for z in zones.values()) == total["hits"]
          and sum(z["misses"] for z in zones.values()) == total["misses"]
          and sum(z["false_alarms"] for z in zones.values()) == total["false_alarms"])
    hors = aggregate_by_zone(lab, lambda e: None)
    check("une cellule hors zone n'est rattachée à personne", hors == {})
    fusion = merge_zone_tables(zones, zones)
    check("la fusion double les effectifs",
          fusion["ouest"]["hits"] == 2 * zones["ouest"]["hits"])
    rows = zone_rows(zones, min_positives=10_000)
    check("zone sous plancher : effectif gardé, scores retirés",
          rows[0]["positives"] > 0 and rows[0]["scores"]["csi"] is None)
    check("les zones sortent triées", [r["zone"] for r in rows] == sorted(r["zone"] for r in rows))

    print("=== régions ===")
    tous = [c for codes in REGIONS_FR.values() for c in codes]
    check("13 régions métropolitaines", len(REGIONS_FR) == 13, len(REGIONS_FR))
    check("96 départements couverts", len(tous) == 96, len(tous))
    check("aucun département dans deux régions", len(tous) == len(set(tous)))
    check("la Corse est en 2A/2B, pas en 20", "20" not in tous and {"2A", "2B"} <= set(tous))
    check("Rhône → Auvergne-Rhône-Alpes", region_of_department("69") == "Auvergne-Rhône-Alpes")
    check("code en minuscules accepté", region_of_department("2a") == "Corse")
    check("code inconnu → None (jamais rattaché d'office)", region_of_department("99") is None)
    check("None → None", region_of_department(None) is None)

    print("=== courbe de fiabilité ===")
    check("tranche 0", bin_index(0) == 0)
    check("tranche 9 → 0-9", bin_index(9) == 0)
    check("tranche 70 → 70-79", bin_index(70) == 7)
    check("100 rejoint 90-100 (pas de 11e tranche)", bin_index(100) == 9)
    check("un score négatif ne sort pas de la grille", bin_index(-5) == 0)
    bins = add_day_to_bins(empty_bins(), lab)
    check("toutes les cellules sont binées", sum(b["n"] for b in bins) == len(lab), sum(b["n"] for b in bins))
    check("voisinage ≥ cellule exacte, tranche par tranche",
          all(b["near"] >= b["cell"] for b in bins))
    rrows = reliability_rows(bins, min_n=1)
    check("les fréquences restent dans [0, 1]",
          all(r["observed_nearby"] is None or 0.0 <= r["observed_nearby"] <= 1.0 for r in rrows))
    check("étiquette de la dernière tranche", rrows[-1]["label"] == "90-100")
    check("tranche sous l'effectif minimal : n gardé, fréquence retirée",
          all(r["n"] == 0 or r["observed_nearby"] is None
              for r in reliability_rows(bins, min_n=10 ** 9)))

    print("=== sélection des cas : déterministe, ratés compris ===")
    jeu = [
        {"date": "2026-06-28", "contingency": {"hits": 900, "misses": 100, "false_alarms": 120, "correct_negatives": 1500}},
        {"date": "2026-06-27", "contingency": {"hits": 700, "misses": 90, "false_alarms": 100, "correct_negatives": 1700}},
        {"date": "2026-06-25", "contingency": {"hits": 400, "misses": 80, "false_alarms": 90, "correct_negatives": 2000}},
        {"date": "2026-07-24", "contingency": {"hits": 32, "misses": 233, "false_alarms": 16, "correct_negatives": 2355}},
        {"date": "2026-06-14", "contingency": {"hits": 1, "misses": 23, "false_alarms": 16, "correct_negatives": 2596}},
        {"date": "2026-07-23", "contingency": {"hits": 1, "misses": 31, "false_alarms": 6, "correct_negatives": 2598}},
        {"date": "2026-07-05", "contingency": {"hits": 1, "misses": 3, "false_alarms": 1, "correct_negatives": 2631}},
    ]
    cas = pick_cases(jeu)
    dates_cas = [c["date"] for c in cas]
    check("6 cas", len(cas) == 6, dates_cas)
    check("les 3 plus actives sont là", {"2026-06-28", "2026-06-27", "2026-06-25"} <= set(dates_cas))
    check("les 3 pires aussi", {"2026-07-24", "2026-06-14", "2026-07-23"} <= set(dates_cas))
    check("la journée à 4 cellules est écartée", "2026-07-05" not in dates_cas)
    check("aucune journée n'est prise deux fois", len(dates_cas) == len(set(dates_cas)))
    check("tri par date décroissante", dates_cas == sorted(dates_cas, reverse=True), dates_cas)
    check("chaque cas dit pourquoi il est là",
          all(c["reason"] in ("journee_la_plus_active", "pire_csi") for c in cas))
    check("les ratés sont bien des ratés",
          all(c["csi"] < 0.2 for c in cas if c["reason"] == "pire_csi"))
    check("relancée, la sélection est identique", pick_cases(jeu) == cas)
    check("l'ordre d'entrée ne change rien", pick_cases(list(reversed(jeu))) == cas)
    check("pas assez de données → aucun cas inventé", pick_cases(jeu[-1:]) == [])

    print(f"\n{ok['n'] - ok['fail']}/{ok['n']} OK" + ("" if ok["fail"] == 0 else f" — {ok['fail']} ÉCHEC(S)"))
    raise SystemExit(1 if ok["fail"] else 0)
