from __future__ import annotations

import json
import math
import socket
import ssl
import sys
import time
import urllib.parse
import urllib.request
from dataclasses import asdict, dataclass
from datetime import datetime
from zoneinfo import ZoneInfo
from pathlib import Path
from typing import Iterable

API_BASE = "https://api.open-meteo.com/v1/meteofrance"
OUTPUT_JSON = Path("orages_output_horizons.json")
TIMEZONE = "auto"

DEFAULT_CENTER_LAT = 45.7640
DEFAULT_CENTER_LON = 4.8357
DEFAULT_CENTER_LABEL = "Lyon"
HALF_BOX_KM_LAT = 24.0
HALF_BOX_KM_LON = 24.0
CELL_SIZE_KM = 7.5
BATCH_SIZE = 20
MODEL = "arome_france"
FORECAST_HOURS = 96

HOURLY_VARS = [
    "cape",
    "temperature_2m",
    "dew_point_2m",
    "relative_humidity_2m",
    "vapour_pressure_deficit",
    "wet_bulb_temperature_2m",
    "cloud_cover_low",
    "cloud_cover_mid",
    "cloud_cover_high",
    "wind_gusts_10m",
    "wind_speed_10m",
    "wind_speed_100m",
    "wind_direction_10m",
    "wind_direction_100m",
]

WEEKDAYS_FR = ["Lun", "Mar", "Mer", "Jeu", "Ven", "Sam", "Dim"]
TIME_SLOTS = {
    "midday": (11, 14, "11h–14h"),
    "afternoon": (15, 18, "15h–18h"),
    "evening": (19, 21, "19h–21h"),
}


def clamp(value: float, low: float = 0, high: float = 100) -> int:
    return int(max(low, min(high, round(value))))


def km_to_deg_lat(km: float) -> float:
    return km / 111.0


def km_to_deg_lon(km: float, lat: float) -> float:
    return km / (111.0 * math.cos(math.radians(lat)))


@dataclass
class Point:
    zone: str
    lat: float
    lon: float
    cell_height_deg: float
    cell_width_deg: float


@dataclass
class OutputRow:
    day_key: str
    day_label: str
    day_index: int
    slot_key: str
    slot_label: str
    selected_time_iso: str
    selected_hour: str
    zone: str
    lat: float
    lon: float
    cell_height_deg: float
    cell_width_deg: float
    trigger_score: int
    structure_score: int
    chase_quality_score: int
    stability_score: int
    confidence_score: int
    score_global: int
    potentiel: str
    confiance: str
    mucape: float
    relative_humidity_2m: float
    vapour_pressure_deficit: float
    wet_bulb_temperature_2m: float
    cloud_cover_low: float
    cloud_cover_mid: float
    cloud_cover_high: float
    wind_gusts_10m: float
    shear_ms: float
    temp_c: float
    dewpoint_c: float
    summary: str


def frange(start: float, stop: float, step: float) -> Iterable[float]:
    value = start
    while value <= stop + 1e-9:
        yield round(value, 5)
        value += step


def build_grid(center_lat: float = DEFAULT_CENTER_LAT, center_lon: float = DEFAULT_CENTER_LON, zone_prefix: str = DEFAULT_CENTER_LABEL) -> list[Point]:
    step_lat = km_to_deg_lat(CELL_SIZE_KM)
    safe_prefix = "".join(ch for ch in zone_prefix if ch.isalnum())[:14] or "Zone"

    row_count = math.ceil((HALF_BOX_KM_LAT * 2) / CELL_SIZE_KM) + 1
    col_count = math.ceil((HALF_BOX_KM_LON * 2) / CELL_SIZE_KM) + 1
    if row_count % 2 == 0:
        row_count += 1
    if col_count % 2 == 0:
        col_count += 1

    row_half = row_count // 2
    col_half = col_count // 2

    points: list[Point] = []
    idx = 1
    for row in range(-row_half, row_half + 1):
        lat = round(center_lat + row * step_lat, 5)
        width_deg = km_to_deg_lon(CELL_SIZE_KM, lat)
        for col in range(-col_half, col_half + 1):
            lon = round(center_lon + col * width_deg, 5)
            points.append(
                Point(
                    zone=f"{safe_prefix}-{idx}",
                    lat=lat,
                    lon=lon,
                    cell_height_deg=step_lat,
                    cell_width_deg=width_deg,
                )
            )
            idx += 1
    return points


def chunks(seq: list[Point], size: int) -> Iterable[list[Point]]:
    for i in range(0, len(seq), size):
        yield seq[i:i + size]


def get_json(url: str, retries: int = 4, timeout: int = 60) -> dict:
    last_error: Exception | None = None
    for attempt in range(1, retries + 1):
        try:
            req = urllib.request.Request(
                url,
                headers={"User-Agent": "storm-chase-prototype/2.1", "Accept": "application/json"},
            )
            with urllib.request.urlopen(req, timeout=timeout) as response:
                return json.loads(response.read().decode("utf-8"))
        except urllib.error.HTTPError as err:
            last_error = err
            print(f"Erreur réseau tentative {attempt}/{retries}: {err}")
            if getattr(err, "code", None) == 429:
                time.sleep(min(8, 1.5 * attempt))
            else:
                time.sleep(1.5 * attempt)
        except (
            urllib.error.URLError,
            TimeoutError,
            ssl.SSLError,
            socket.timeout,
        ) as err:
            last_error = err
            print(f"Erreur réseau tentative {attempt}/{retries}: {err}")
            time.sleep(1.5 * attempt)
    raise RuntimeError(f"Échec après {retries} tentatives: {last_error}")


def build_api_url(points: list[Point]) -> str:
    latitudes = ",".join(str(p.lat) for p in points)
    longitudes = ",".join(str(p.lon) for p in points)
    params = {
        "latitude": latitudes,
        "longitude": longitudes,
        "hourly": ",".join(HOURLY_VARS),
        "models": MODEL,
        "forecast_hours": str(FORECAST_HOURS),
        "timezone": TIMEZONE,
        "wind_speed_unit": "ms",
        "format": "json",
    }
    return API_BASE + "?" + urllib.parse.urlencode(params)


def location_structures(payload: dict) -> list[dict]:
    if isinstance(payload, list):
        return payload
    if isinstance(payload, dict) and isinstance(payload.get("latitude"), list):
        count = len(payload["latitude"])
        out = []
        for i in range(count):
            entry = {}
            for k, v in payload.items():
                if isinstance(v, list) and len(v) == count:
                    entry[k] = v[i]
                else:
                    entry[k] = v
            out.append(entry)
        return out
    return [payload]


def dt_from_iso(value: str) -> datetime:
    return datetime.fromisoformat(value)


def shear_proxy_ms(ws10: float, wd10: float, ws100: float, wd100: float) -> float:
    u10 = -ws10 * math.sin(math.radians(wd10))
    v10 = -ws10 * math.cos(math.radians(wd10))
    u100 = -ws100 * math.sin(math.radians(wd100))
    v100 = -ws100 * math.cos(math.radians(wd100))
    du = u100 - u10
    dv = v100 - v10
    return round(math.sqrt(du * du + dv * dv), 1)


def score_trigger(cape: float, dewpoint_c: float, rh2m: float, vpd: float, temp_c: float, wetbulb_c: float) -> int:
    score = 0.0

    # Instabilité utilisable : on évite de sur-récompenser un CAPE élevé seul.
    if cape < 75:
        score += 0
    elif cape < 200:
        score += 6
    elif cape < 500:
        score += 16
    elif cape < 900:
        score += 28
    elif cape < 1500:
        score += 38
    elif cape < 2200:
        score += 45
    else:
        score += 48

    # Humidité basse couche.
    if dewpoint_c < 7:
        score -= 16
    elif dewpoint_c < 10:
        score -= 8
    elif dewpoint_c < 13:
        score += 0
    elif dewpoint_c < 16:
        score += 8
    elif dewpoint_c < 19:
        score += 14
    else:
        score += 18

    # VPD : préférence pour une couche basse ni saturée ni trop sèche.
    if vpd < 0.25:
        score += 2
    elif vpd < 0.7:
        score += 10
    elif vpd < 1.2:
        score += 14
    elif vpd < 1.8:
        score += 8
    elif vpd < 2.5:
        score -= 2
    else:
        score -= 12

    # RH : appoint.
    if rh2m >= 85:
        score += 4
    elif rh2m >= 70:
        score += 3
    elif rh2m < 35:
        score -= 8

    # Température humide : bon proxy simple d'une couche basse exploitable.
    if wetbulb_c >= 18:
        score += 8
    elif wetbulb_c >= 15:
        score += 5
    elif wetbulb_c < 9:
        score -= 8

    # Cas classiques d'instabilité sèche peu fiable pour du déclenchement réel.
    if cape >= 1200 and dewpoint_c < 11:
        score -= 10
    if temp_c >= 31 and dewpoint_c < 13:
        score -= 8
    if cape >= 900 and vpd >= 2.0:
        score -= 6

    return clamp(score)


def score_structure(shear_ms: float, gusts: float, cape: float, trigger_score: int) -> int:
    score = 0.0

    # Cisaillement = axe principal, avec plateau au-delà d'un certain seuil.
    if shear_ms < 5:
        score += 0
    elif shear_ms < 8:
        score += 8
    elif shear_ms < 12:
        score += 20
    elif shear_ms < 16:
        score += 34
    elif shear_ms < 20:
        score += 47
    elif shear_ms < 26:
        score += 58
    elif shear_ms < 32:
        score += 62
    else:
        score += 60

    # Rafales : appoint, utile pour distinguer un champ de vent un peu plus dynamique.
    if gusts >= 11:
        score += 3
    if gusts >= 16:
        score += 4
    if gusts >= 22:
        score += 4

    # Impossible d'avoir une "bonne organisation chassable" si le signal de déclenchement est très faible.
    if trigger_score < 20:
        score -= 18
    elif trigger_score < 35:
        score -= 10

    # On évite les faux positifs sur fort shear avec instabilité quasi absente.
    if shear_ms >= 16 and cape < 200:
        score -= 14
    elif shear_ms >= 12 and cape < 350:
        score -= 7

    return clamp(score)


def score_chase_quality(low: float, mid: float, high: float) -> int:
    score = 100.0

    # La couche basse pénalise le plus la lisibilité terrain.
    if low >= 95:
        score -= 46
    elif low >= 80:
        score -= 32
    elif low >= 60:
        score -= 18
    elif low >= 40:
        score -= 8

    if mid >= 95:
        score -= 24
    elif mid >= 80:
        score -= 17
    elif mid >= 60:
        score -= 9

    if high >= 98:
        score -= 10
    elif high >= 90:
        score -= 7
    elif high >= 75:
        score -= 4

    return clamp(score)


def score_stability(reference: dict, neighbours: list[dict]) -> int:
    if not neighbours:
        return 35

    ref_global = reference["pre_global"]
    ref_trigger = reference["trigger"]
    ref_structure = reference["structure"]

    global_diffs = [abs(ref_global - n["pre_global"]) for n in neighbours]
    trigger_diffs = [abs(ref_trigger - n["trigger"]) for n in neighbours]
    structure_diffs = [abs(ref_structure - n["structure"]) for n in neighbours]

    mean_global_diff = sum(global_diffs) / len(global_diffs)
    mean_trigger_diff = sum(trigger_diffs) / len(trigger_diffs)
    mean_structure_diff = sum(structure_diffs) / len(structure_diffs)

    score = 78.0
    score -= mean_global_diff * 1.25
    score -= mean_trigger_diff * 0.45
    score -= mean_structure_diff * 0.35

    close_support = sum(1 for n in neighbours if n["pre_global"] >= ref_global - 10)
    score += close_support * 4

    if ref_global >= 60 and close_support == 0:
        score -= 10
    if ref_global >= 70 and mean_global_diff <= 8:
        score += 8
    if mean_global_diff >= 18:
        score -= 10

    return clamp(score)


def score_global(trigger_score: int, structure_score: int, chase_quality_score: int, stability_score: int) -> int:
    return clamp(trigger_score * 0.40 + structure_score * 0.28 + chase_quality_score * 0.14 + stability_score * 0.18)


def score_confidence(trigger_score: int, structure_score: int, chase_quality_score: int, stability_score: int, global_score_value: int) -> int:
    score = 28.0

    # Équilibre entre déclenchement et organisation.
    gap = abs(trigger_score - structure_score)
    if gap <= 8:
        score += 16
    elif gap <= 16:
        score += 10
    elif gap <= 26:
        score += 4
    else:
        score -= 8

    # La stabilité temporelle pèse lourd sur la confiance.
    score += stability_score * 0.40

    if global_score_value >= 70:
        score += 8
    elif global_score_value >= 55:
        score += 4
    elif global_score_value < 25:
        score -= 6

    if chase_quality_score < 25:
        score -= 7
    elif chase_quality_score >= 75:
        score += 3

    return clamp(score)


def potentiel(score_global: int) -> str:
    if score_global < 20:
        return "Très faible"
    if score_global < 40:
        return "Faible"
    if score_global < 60:
        return "Modéré"
    if score_global < 75:
        return "Élevé"
    return "Très élevé"


def confiance_label(confidence_score: int) -> str:
    if confidence_score < 30:
        return "Faible"
    if confidence_score < 50:
        return "Moyenne"
    if confidence_score < 70:
        return "Bonne"
    return "Très bonne"


def build_summary(
    day_label: str,
    slot_label: str,
    selected_hour: str,
    trigger_score: int,
    structure_score: int,
    chase_quality_score: int,
    stability_score: int,
    confidence_score: int,
) -> str:
    trigger_text = (
        "déclenchement favorable"
        if trigger_score >= 65
        else "déclenchement possible"
        if trigger_score >= 45
        else "déclenchement limité"
    )
    structure_text = (
        "organisation crédible"
        if structure_score >= 55
        else "organisation possible"
        if structure_score >= 35
        else "organisation faible"
    )
    quality_text = (
        "bonne lisibilité terrain"
        if chase_quality_score >= 70
        else "qualité de chasse moyenne"
        if chase_quality_score >= 45
        else "visibilité pénalisée"
    )
    stability_text = (
        "bonne stabilité horaire"
        if stability_score >= 70
        else "stabilité correcte"
        if stability_score >= 45
        else "fenêtre fragile"
    )
    conf_text = (
        "signal robuste"
        if confidence_score >= 70
        else "signal cohérent"
        if confidence_score >= 50
        else "signal fragile"
    )
    return f"{day_label} {slot_label} ({selected_hour}) : {trigger_text}, {structure_text}, {quality_text}, {stability_text}, {conf_text}."


def rows_for_location(point: Point, loc: dict) -> list[OutputRow]:
    hourly = loc.get("hourly", {})
    times = hourly.get("time", [])
    if not times:
        return []

    metrics: list[dict] = []
    by_day: dict[str, list[tuple[int, datetime]]] = {}

    for idx, t in enumerate(times):
        dt = dt_from_iso(t)
        day_key = dt.date().isoformat()
        by_day.setdefault(day_key, []).append((idx, dt))

        cape = float(hourly.get("cape", [0])[idx] or 0)
        temp = float(hourly.get("temperature_2m", [0])[idx] or 0)
        dew = float(hourly.get("dew_point_2m", [0])[idx] or 0)
        rh2m = float(hourly.get("relative_humidity_2m", [0])[idx] or 0)
        vpd = float(hourly.get("vapour_pressure_deficit", [0])[idx] or 0)
        wetbulb = float(hourly.get("wet_bulb_temperature_2m", [0])[idx] or 0)
        cloud_low = float(hourly.get("cloud_cover_low", [0])[idx] or 0)
        cloud_mid = float(hourly.get("cloud_cover_mid", [0])[idx] or 0)
        cloud_high = float(hourly.get("cloud_cover_high", [0])[idx] or 0)
        gusts = float(hourly.get("wind_gusts_10m", [0])[idx] or 0)
        ws10 = float(hourly.get("wind_speed_10m", [0])[idx] or 0)
        ws100 = float(hourly.get("wind_speed_100m", [0])[idx] or 0)
        wd10 = float(hourly.get("wind_direction_10m", [0])[idx] or 0)
        wd100 = float(hourly.get("wind_direction_100m", [0])[idx] or 0)
        shear = shear_proxy_ms(ws10, wd10, ws100, wd100)

        trigger = score_trigger(cape, dew, rh2m, vpd, temp, wetbulb)
        structure = score_structure(shear, gusts, cape, trigger)
        quality = score_chase_quality(cloud_low, cloud_mid, cloud_high)
        pre_global = clamp(trigger * 0.48 + structure * 0.32 + quality * 0.20)

        metrics.append(
            {
                "idx": idx,
                "dt": dt,
                "day_key": day_key,
                "cape": cape,
                "temp": temp,
                "dew": dew,
                "rh2m": rh2m,
                "vpd": vpd,
                "wetbulb": wetbulb,
                "cloud_low": cloud_low,
                "cloud_mid": cloud_mid,
                "cloud_high": cloud_high,
                "gusts": gusts,
                "shear": shear,
                "trigger": trigger,
                "structure": structure,
                "quality": quality,
                "pre_global": pre_global,
            }
        )

    metrics_by_idx = {m["idx"]: m for m in metrics}

    rows: list[OutputRow] = []
    sorted_days = sorted(by_day.items(), key=lambda x: x[0])

    for day_index, (day_key, items) in enumerate(sorted_days):
        weekday = WEEKDAYS_FR[items[0][1].weekday()]
        day_label = f"{weekday} {items[0][1].day:02d}"

        for slot_key, (start_hour, end_hour, slot_label) in TIME_SLOTS.items():
            candidate_indices = [i for i, dt in items if start_hour <= dt.hour <= end_hour]
            if not candidate_indices:
                continue

            best: OutputRow | None = None
            best_score = -10_000

            for idx in candidate_indices:
                metric = metrics_by_idx[idx]
                neighbours = [
                    metrics_by_idx[n_idx]
                    for n_idx in range(idx - 1, idx + 2)
                    if n_idx in metrics_by_idx and n_idx != idx
                ]
                stability = score_stability(metric, neighbours)
                global_score = score_global(metric["trigger"], metric["structure"], metric["quality"], stability)
                conf_score = score_confidence(metric["trigger"], metric["structure"], metric["quality"], stability, global_score)
                pot = potentiel(global_score)
                conf = confiance_label(conf_score)
                selected_hour = metric["dt"].strftime("%Hh")
                summary = build_summary(
                    day_label,
                    slot_label,
                    selected_hour,
                    metric["trigger"],
                    metric["structure"],
                    metric["quality"],
                    stability,
                    conf_score,
                )

                row = OutputRow(
                    day_key=day_key,
                    day_label=day_label,
                    day_index=day_index,
                    slot_key=slot_key,
                    slot_label=slot_label,
                    selected_time_iso=metric["dt"].isoformat(),
                    selected_hour=selected_hour,
                    zone=point.zone,
                    lat=point.lat,
                    lon=point.lon,
                    cell_height_deg=point.cell_height_deg,
                    cell_width_deg=point.cell_width_deg,
                    trigger_score=metric["trigger"],
                    structure_score=metric["structure"],
                    chase_quality_score=metric["quality"],
                    stability_score=stability,
                    confidence_score=conf_score,
                    score_global=global_score,
                    potentiel=pot,
                    confiance=conf,
                    mucape=round(metric["cape"], 1),
                    relative_humidity_2m=round(metric["rh2m"], 1),
                    vapour_pressure_deficit=round(metric["vpd"], 2),
                    wet_bulb_temperature_2m=round(metric["wetbulb"], 1),
                    cloud_cover_low=round(metric["cloud_low"], 1),
                    cloud_cover_mid=round(metric["cloud_mid"], 1),
                    cloud_cover_high=round(metric["cloud_high"], 1),
                    wind_gusts_10m=round(metric["gusts"], 1),
                    shear_ms=round(metric["shear"], 1),
                    temp_c=round(metric["temp"], 1),
                    dewpoint_c=round(metric["dew"], 1),
                    summary=summary,
                )

                score_key = global_score * 1000 + conf_score * 10 + stability
                if score_key > best_score:
                    best_score = score_key
                    best = row

            if best is not None:
                rows.append(best)

    return rows


def fetch_model(points: list[Point]) -> list[OutputRow]:
    batches = list(chunks(points, BATCH_SIZE))
    total_batches = len(batches)
    rows: list[OutputRow] = []
    for batch_index, batch in enumerate(batches, start=1):
        print(f"{MODEL} | lot {batch_index}/{total_batches} | {len(batch)} points | jours glissants (V19 allégée)")
        url = build_api_url(batch)
        payload = get_json(url)
        structures = location_structures(payload)
        for point, loc in zip(batch, structures):
            rows.extend(rows_for_location(point, loc))
        time.sleep(0.4)
    return rows


def group_for_output(rows: list[OutputRow], center_lat: float, center_lon: float, center_label: str) -> dict:
    days_map: dict[str, dict] = {}
    for row in rows:
        day = days_map.setdefault(
            row.day_key,
            {
                "day_key": row.day_key,
                "day_label": row.day_label,
                "day_index": row.day_index,
                "slots": {},
            },
        )
        slot = day["slots"].setdefault(
            row.slot_key,
            {
                "slot_key": row.slot_key,
                "slot_label": row.slot_label,
                "cells": [],
            },
        )
        slot["cells"].append(asdict(row))

    days = []
    for _, day in sorted(days_map.items(), key=lambda kv: kv[1]["day_index"]):
        slots = []
        for slot_key in TIME_SLOTS:
            if slot_key in day["slots"]:
                slot = day["slots"][slot_key]
                cells = slot["cells"]
                max_score = max(cell["score_global"] for cell in cells) if cells else 0
                mean_score = round(sum(cell["score_global"] for cell in cells) / len(cells)) if cells else 0
                slot["summary"] = {
                    "cells": len(cells),
                    "max_score": max_score,
                    "mean_score": mean_score,
                }
                slots.append(slot)
        days.append(
            {
                "day_key": day["day_key"],
                "day_label": day["day_label"],
                "day_index": day["day_index"],
                "slots": slots,
            }
        )

    generated_at = datetime.now(ZoneInfo("Europe/Paris")).isoformat(timespec="seconds")
    return {
        "meta": {
            "generated_at": generated_at,
            "model": MODEL,
            "center": {"lat": center_lat, "lon": center_lon, "label": center_label},
            "grid": {
                "half_box_km_lat": HALF_BOX_KM_LAT,
                "half_box_km_lon": HALF_BOX_KM_LON,
                "cell_size_km": CELL_SIZE_KM,
            },
            "legend": {
                "global_score": "0-100, combine déclenchement 40%, organisation 28%, qualité terrain 14%, stabilité 18%",
                "trigger": "Instabilité utilisable + humidité basse couche (CAPE, Td, VPD, RH, Tw)",
                "structure": "Cisaillement prioritaire, rafales en appoint, pondéré par le déclenchement",
                "chase_quality": "Nébulosité / lisibilité terrain",
                "stability": "Stabilité horaire locale autour du créneau retenu",
                "confidence": "Équilibre déclenchement/organisation + stabilité horaire + lisibilité terrain",
            },
        },
        "days": days,
    }


def write_json_payload(payload: dict, path: Path) -> None:
    path.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")


def print_summary(rows: list[OutputRow]) -> None:
    keys = sorted({(r.day_index, r.day_label, r.slot_key, r.slot_label) for r in rows})
    for day_index, day_label, slot_key, slot_label in keys:
        subset = [r for r in rows if r.day_index == day_index and r.slot_key == slot_key]
        subset.sort(key=lambda r: (r.score_global, r.confidence_score), reverse=True)
        print(f"\n=== {day_label} | {slot_label} ===")
        for r in subset[:5]:
            print(
                f"- {r.zone} | {r.selected_hour} | global {r.score_global} | trig {r.trigger_score} | "
                f"struct {r.structure_score} | qual {r.chase_quality_score} | conf {r.confidence_score}"
            )


def main() -> None:
    points = build_grid()
    print(f"Grille construite autour de {DEFAULT_CENTER_LABEL} : {len(points)} points")
    rows = fetch_model(points)
    print(f"{MODEL} : {len(rows)} lignes générées")
    payload = group_for_output(rows, DEFAULT_CENTER_LAT, DEFAULT_CENTER_LON, DEFAULT_CENTER_LABEL)
    write_json_payload(payload, OUTPUT_JSON)
    print_summary(rows)
    print(f"\nJSON écrit : {OUTPUT_JSON.resolve()}")
    print("Terminé.")
    print("Note : sortie JSON multi-créneaux (11h–14h, 15h–18h, 19h–21h), pensée pour un usage terrain sur WebApp.")


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        print("Interrompu.")
        sys.exit(1)



def build_latest_payload(center_lat: float = DEFAULT_CENTER_LAT, center_lon: float = DEFAULT_CENTER_LON, center_label: str = DEFAULT_CENTER_LABEL) -> dict:
    points = build_grid(center_lat=center_lat, center_lon=center_lon, zone_prefix=center_label)
    rows = fetch_model(points)
    return group_for_output(rows, center_lat, center_lon, center_label)
