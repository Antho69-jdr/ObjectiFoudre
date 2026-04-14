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
from datetime import date as Date
from datetime import datetime
from zoneinfo import ZoneInfo
from pathlib import Path
from typing import Iterable

FORECAST_API_BASE = "https://api.open-meteo.com/v1/meteofrance"
HISTORICAL_API_BASE = "https://historical-forecast-api.open-meteo.com/v1/forecast"
OUTPUT_JSON = Path("orages_output_horizons.json")
TIMEZONE = "auto"

DEFAULT_CENTER_LAT = 45.7640
DEFAULT_CENTER_LON = 4.8357
DEFAULT_CENTER_LABEL = "Lyon"
GRID_SIDE_KM = 65.0
HALF_BOX_KM_LAT = GRID_SIDE_KM / 2
HALF_BOX_KM_LON = GRID_SIDE_KM / 2
CELL_SIZE_KM = 5.0
TARGET_BATCHES = 5
FORECAST_MODEL_LABEL = "arome_france"
HISTORICAL_MODEL = "arome_france"
FORECAST_MAX_DAYS = 2
FORECAST_HOURS = 48
HISTORICAL_MIN_DATE = Date(2022, 1, 1)

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
SLOT_HOURS = 2
TIME_SLOTS = [
    (
        f"h{start_hour:02d}",
        start_hour,
        min(23, start_hour + SLOT_HOURS - 1),
        f"{start_hour:02d}h–{min(23, start_hour + SLOT_HOURS - 1):02d}h",
    )
    for start_hour in range(0, 24, SLOT_HOURS)
]


def clamp(value: float, low: float = 0, high: float = 100) -> int:
    return int(max(low, min(high, round(value))))


def km_to_deg_lat(km: float) -> float:
    return km / 111.0


def km_to_deg_lon(km: float, lat: float) -> float:
    return km / (111.0 * math.cos(math.radians(lat)))


def local_today() -> Date:
    return datetime.now(ZoneInfo("Europe/Paris")).date()


def batch_size_for_points(points: list[Point]) -> int:
    return max(1, math.ceil(len(points) / TARGET_BATCHES))


def api_context(target_date: Date | None) -> tuple[str, dict[str, str], str]:
    today = local_today()
    if target_date is not None and target_date < HISTORICAL_MIN_DATE:
        raise ValueError(f"Date trop ancienne pour l'archive de prévisions Open-Meteo : {target_date.isoformat()} < {HISTORICAL_MIN_DATE.isoformat()}")

    if target_date is not None and target_date < today:
        return HISTORICAL_API_BASE, {
            "start_date": target_date.isoformat(),
            "end_date": target_date.isoformat(),
        }, "historical"

    if target_date is not None and target_date >= today:
        forecast_days = max(1, min(FORECAST_MAX_DAYS, (target_date - today).days + 1))
        return FORECAST_API_BASE, {
            "forecast_days": str(forecast_days),
            "past_days": "0",
        }, "forecast"

    return FORECAST_API_BASE, {
        "forecast_days": str(FORECAST_MAX_DAYS),
        "past_days": "0",
    }, "forecast"


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
    analysis_mode: str
    metrics_used: dict[str, float]
    metric_scores: dict[str, int]
    category_breakdown: dict[str, dict[str, int]]
    diagnostics: list[str]
    summary: str


def frange(start: float, stop: float, step: float) -> Iterable[float]:
    value = start
    while value <= stop + 1e-9:
        yield round(value, 5)
        value += step


def build_grid(center_lat: float = DEFAULT_CENTER_LAT, center_lon: float = DEFAULT_CENTER_LON, zone_prefix: str = DEFAULT_CENTER_LABEL) -> list[Point]:
    step_lat = km_to_deg_lat(CELL_SIZE_KM)
    safe_prefix = "".join(ch for ch in zone_prefix if ch.isalnum())[:14] or "Zone"

    row_count = max(3, int(round((HALF_BOX_KM_LAT * 2) / CELL_SIZE_KM)))
    col_count = max(3, int(round((HALF_BOX_KM_LON * 2) / CELL_SIZE_KM)))
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


def build_api_url(points: list[Point], target_date: Date | None = None) -> str:
    latitudes = ",".join(str(p.lat) for p in points)
    longitudes = ",".join(str(p.lon) for p in points)
    api_base, date_params, api_mode = api_context(target_date)
    params = {
        "latitude": latitudes,
        "longitude": longitudes,
        "hourly": ",".join(HOURLY_VARS),
        "timezone": TIMEZONE,
        "wind_speed_unit": "ms",
        "format": "json",
        **date_params,
    }
    if api_mode == "historical":
        params["models"] = HISTORICAL_MODEL
    elif api_mode == "forecast":
        # Forecast is intentionally pinned to AROME France and limited to 2 days.
        # This keeps the model consistent with the user workflow and stays within
        # the horizon reliably supported by this model.
        params["models"] = FORECAST_MODEL_LABEL
        params["forecast_hours"] = str(FORECAST_HOURS)
    return api_base + "?" + urllib.parse.urlencode(params)


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


def piecewise_score(value: float, points: list[tuple[float, float]], inverse: bool = False) -> int:
    if value is None or not math.isfinite(value):
        return 0
    pts = sorted(points, key=lambda x: x[0], reverse=inverse)
    if not inverse:
        if value <= pts[0][0]:
            return clamp(pts[0][1])
        if value >= pts[-1][0]:
            return clamp(pts[-1][1])
        for (x1, y1), (x2, y2) in zip(pts, pts[1:]):
            if x1 <= value <= x2:
                ratio = 0 if x2 == x1 else (value - x1) / (x2 - x1)
                return clamp(y1 + (y2 - y1) * ratio)
    else:
        if value >= pts[0][0]:
            return clamp(pts[0][1])
        if value <= pts[-1][0]:
            return clamp(pts[-1][1])
        for (x1, y1), (x2, y2) in zip(pts, pts[1:]):
            if x2 <= value <= x1:
                ratio = 0 if x1 == x2 else (x1 - value) / (x1 - x2)
                return clamp(y1 + (y2 - y1) * ratio)
    return clamp(pts[-1][1])


def score_cape(cape: float) -> int:
    return piecewise_score(cape, [
        (0, 0),
        (100, 8),
        (300, 20),
        (700, 40),
        (1200, 62),
        (1800, 82),
        (2500, 96),
        (3200, 100),
    ])


def score_shear(shear_ms: float) -> int:
    return piecewise_score(shear_ms, [
        (0, 0),
        (6, 10),
        (10, 28),
        (14, 46),
        (18, 66),
        (22, 84),
        (28, 96),
        (35, 100),
    ])


def score_dewpoint(dewpoint_c: float) -> int:
    return piecewise_score(dewpoint_c, [
        (0, 0),
        (8, 8),
        (10, 24),
        (12, 42),
        (14, 62),
        (17, 84),
        (20, 96),
        (23, 100),
    ])


def score_humidity(rh2m: float) -> int:
    return piecewise_score(rh2m, [
        (20, 0),
        (35, 8),
        (45, 22),
        (55, 42),
        (65, 66),
        (80, 88),
        (95, 100),
    ])


def score_vpd(vpd: float) -> int:
    return piecewise_score(vpd, [
        (3.5, 0),
        (3.0, 8),
        (2.4, 20),
        (1.8, 42),
        (1.2, 68),
        (0.8, 86),
        (0.4, 96),
        (0.0, 100),
    ], inverse=True)


def score_wetbulb(wetbulb_c: float) -> int:
    return piecewise_score(wetbulb_c, [
        (4, 0),
        (8, 8),
        (11, 24),
        (14, 46),
        (17, 72),
        (20, 92),
        (23, 100),
    ])


def score_gusts(gusts: float) -> int:
    return piecewise_score(gusts, [
        (0, 10),
        (8, 18),
        (12, 28),
        (16, 44),
        (20, 62),
        (24, 78),
        (30, 92),
        (36, 100),
    ])


def score_cloud_penalty(cloud_low: float, cloud_mid: float, cloud_high: float) -> int:
    low = piecewise_score(cloud_low, [(0, 100), (10, 95), (25, 84), (40, 66), (60, 38), (80, 16), (100, 4)])
    mid = piecewise_score(cloud_mid, [(0, 100), (10, 96), (25, 88), (40, 74), (60, 50), (80, 24), (100, 6)])
    high = piecewise_score(cloud_high, [(0, 100), (10, 96), (25, 90), (40, 80), (60, 62), (80, 36), (100, 10)])
    return clamp(low * 0.50 + mid * 0.30 + high * 0.20)


def score_timing(dt: datetime) -> int:
    hour = dt.hour + dt.minute / 60.0
    if hour < 8:
        return 8
    if hour < 10:
        return 20
    if hour < 12:
        return 42
    if hour < 14:
        return 62
    if hour < 17:
        return 86
    if hour < 20:
        return 100
    if hour < 22:
        return 70
    return 30


def compute_initiation(cape: float, dewpoint_c: float, rh2m: float, vpd: float, temp_c: float, wetbulb_c: float, dt: datetime) -> tuple[int, dict[str, int]]:
    cape_s = score_cape(cape)
    dew_s = score_dewpoint(dewpoint_c)
    rh_s = score_humidity(rh2m)
    vpd_s = score_vpd(vpd)
    wet_s = score_wetbulb(wetbulb_c)
    timing_s = score_timing(dt)
    moisture = clamp(dew_s * 0.34 + rh_s * 0.24 + vpd_s * 0.26 + wet_s * 0.16)
    instability = cape_s
    score = instability * 0.35 + moisture * 0.35 + timing_s * 0.20

    inhibition_penalty = 0.0
    if cape >= 1200 and dewpoint_c < 11:
        inhibition_penalty += 10
    if temp_c >= 31 and dewpoint_c < 13:
        inhibition_penalty += 8
    if cape >= 900 and vpd >= 2.0:
        inhibition_penalty += 8
    if rh2m < 40:
        inhibition_penalty += 8
    score -= inhibition_penalty

    return clamp(score), {
        'instability': instability,
        'moisture': moisture,
        'timing': timing_s,
        'inhibition_penalty': clamp(inhibition_penalty),
        'cape_component': cape_s,
        'dew_component': dew_s,
        'humidity_component': rh_s,
        'vpd_component': vpd_s,
        'wetbulb_component': wet_s,
    }


def compute_severity(shear_ms: float, gusts: float, cape: float, initiation_score: int) -> tuple[int, dict[str, int]]:
    shear_s = score_shear(shear_ms)
    cape_s = score_cape(cape)
    gust_s = score_gusts(gusts)
    updraft = clamp(cape_s * 0.75 + max(0, shear_s - 15) * 0.25)
    organization = clamp(shear_s * 0.82 + gust_s * 0.18)
    maintenance = clamp(shear_s * 0.55 + cape_s * 0.30 + gust_s * 0.15)
    score = updraft * 0.40 + organization * 0.40 + maintenance * 0.20

    if initiation_score < 25:
        score -= 22
    elif initiation_score < 40:
        score -= 12

    if shear_ms >= 16 and cape < 200:
        score -= 16
    elif shear_ms >= 12 and cape < 350:
        score -= 8

    if cape >= 1500 and shear_ms >= 18:
        score += 6
    elif cape >= 900 and shear_ms >= 14:
        score += 3

    return clamp(score), {
        'updraft': updraft,
        'organization': organization,
        'maintenance': maintenance,
        'shear_component': shear_s,
        'gust_component': gust_s,
    }


def compute_chaseability(cloud_low: float, cloud_mid: float, cloud_high: float, dt: datetime, gusts: float) -> tuple[int, dict[str, int]]:
    cloud_score = score_cloud_penalty(cloud_low, cloud_mid, cloud_high)
    visibility = cloud_score
    timing_s = score_timing(dt)
    photogenicity = clamp(visibility * 0.72 + timing_s * 0.28)
    comfort = clamp(100 - max(0, gusts - 18) * 3.2)
    score = visibility * 0.50 + photogenicity * 0.30 + comfort * 0.20
    return clamp(score), {
        'visibility': visibility,
        'photogenicity': photogenicity,
        'comfort': comfort,
        'cloud_score': cloud_score,
    }


def compute_reliability(reference: dict, neighbours: list[dict]) -> tuple[int, dict[str, int]]:
    if not neighbours:
        return 36, {'consistency': 32, 'stability': 34, 'confidence_margin': 44}

    ref_global = reference['pre_global']
    ref_initiation = reference['trigger']
    ref_severity = reference['structure']
    ref_chaseability = reference['quality']
    gap = abs(ref_initiation - ref_severity)
    consistency = 90 - gap * 1.1
    if ref_initiation >= 60 and reference['moisture'] < 40:
        consistency -= 12
    if ref_severity >= 65 and ref_initiation < 35:
        consistency -= 14
    if ref_chaseability < 20 and ref_global >= 60:
        consistency -= 8

    global_diffs = [abs(ref_global - n['pre_global']) for n in neighbours]
    initiation_diffs = [abs(ref_initiation - n['trigger']) for n in neighbours]
    severity_diffs = [abs(ref_severity - n['structure']) for n in neighbours]
    stability = 84 - (sum(global_diffs) / len(global_diffs)) * 1.15 - (sum(initiation_diffs) / len(initiation_diffs)) * 0.30 - (sum(severity_diffs) / len(severity_diffs)) * 0.25

    comps = [
        reference['cape_component'],
        reference['dew_component'],
        reference['humidity_component'],
        reference['vpd_component'],
        reference['wetbulb_component'],
        reference['shear_component'],
    ]
    sorted_comps = sorted(comps)
    margin = (sorted_comps[-1] - sorted_comps[0]) * 0.15
    confidence_margin = max(0, min(sorted_comps[-2], sorted_comps[-1]) - margin)

    score = consistency * 0.40 + stability * 0.35 + confidence_margin * 0.25
    return clamp(score), {
        'consistency': clamp(consistency),
        'stability': clamp(stability),
        'confidence_margin': clamp(confidence_margin),
    }


def compute_bust_risk(initiation_score: int, severity_score: int, chaseability_score: int, reliability_score: int, moisture_component: int, timing_component: int) -> int:
    risk = 100.0
    risk -= initiation_score * 0.42
    risk -= severity_score * 0.18
    risk -= reliability_score * 0.20
    risk -= moisture_component * 0.10
    risk -= timing_component * 0.07
    risk -= chaseability_score * 0.03

    if initiation_score < 25:
        risk += 18
    elif initiation_score < 40:
        risk += 10
    if reliability_score < 35:
        risk += 12
    if moisture_component < 30:
        risk += 10
    if severity_score >= 70 and initiation_score < 35:
        risk += 10

    return clamp(risk)


def score_global(trigger_score: int, structure_score: int, chase_quality_score: int, stability_score: int, confidence_score: int | None = None) -> int:
    score = trigger_score * 0.30 + structure_score * 0.30 + chase_quality_score * 0.25 + stability_score * 0.15
    if trigger_score < 25:
        score = min(score, 55)
    elif trigger_score < 40:
        score = min(score, 68)
    if chase_quality_score < 15:
        score -= 8
    if confidence_score is not None:
        if confidence_score >= 75:
            score += 3
        elif confidence_score >= 60:
            score += 1
        elif confidence_score >= 45:
            score -= 2
        else:
            score -= 5
    return clamp(score)


def score_confidence(trigger_score: int, structure_score: int, chase_quality_score: int, stability_score: int, global_score_value: int) -> int:
    return compute_bust_risk(trigger_score, structure_score, chase_quality_score, stability_score, global_score_value, global_score_value)


def build_cell_diagnostics(metric: dict, reliability_diag: dict[str, int], global_score: int, bust_risk: int) -> list[str]:
    diagnostics: list[str] = []

    if metric['trigger'] >= 70:
        diagnostics.append("Initiation solide : instabilité et humidité basses couches bien alignées.")
    elif metric['trigger'] >= 45:
        diagnostics.append("Initiation jouable : déclenchement plausible mais encore sensible au timing local.")
    else:
        diagnostics.append("Initiation fragile : risque de blocage ou de convection trop dispersée.")

    if metric['structure'] >= 70:
        diagnostics.append("Severity crédible : combinaison CAPE / shear favorable à une convection organisée.")
    elif metric['structure'] >= 45:
        diagnostics.append("Severity modérée : intensité possible mais organisation encore limitée.")
    else:
        diagnostics.append("Severity faible : structure orageuse probablement brève ou peu marquée.")

    if metric['quality'] >= 70:
        diagnostics.append("Chaseability élevée : visibilité et lecture terrain favorables.")
    elif metric['quality'] >= 45:
        diagnostics.append("Chaseability moyenne : potentiel exploitable avec compromis visuels.")
    else:
        diagnostics.append("Chaseability pénalisée : nébulosité ou confort terrain peu favorables.")

    if reliability_diag['consistency'] < 40:
        diagnostics.append("Fiabilité pénalisée par des signaux internes contradictoires.")
    if reliability_diag['stability'] < 40:
        diagnostics.append("Fiabilité pénalisée par une forte variabilité horaire locale.")
    if metric['moisture'] < 35:
        diagnostics.append("Humidité basse couche trop limitée pour soutenir durablement l’initiation.")
    if metric['vpd_component'] < 35:
        diagnostics.append("VPD élevé : l’air proche du sol reste trop sec pour limiter le risque de bust.")
    if metric['cloud_score'] < 35:
        diagnostics.append("Nébulosité défavorable à la lecture terrain et à la photogénie.")
    if bust_risk >= 70:
        diagnostics.append("Bust Risk élevé : scénario séduisant sur le papier mais encore fragile sur le terrain.")
    elif bust_risk <= 35:
        diagnostics.append("Bust Risk contenu : signaux suffisamment robustes pour une analyse historical comparative.")
    if global_score >= 75:
        diagnostics.append("Cellule prioritaire en historical analysis : signal global franchement au-dessus du bruit de fond.")

    return diagnostics[:8]


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
    if confidence_score < 20:
        return "Très faible"
    if confidence_score < 40:
        return "Faible"
    if confidence_score < 60:
        return "Modéré"
    if confidence_score < 80:
        return "Élevé"
    return "Très élevé"


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
    initiation_text = (
        "initiation solide"
        if trigger_score >= 70
        else "initiation jouable"
        if trigger_score >= 45
        else "initiation fragile"
    )
    severity_text = (
        "potentiel sévère crédible"
        if structure_score >= 70
        else "potentiel structuré correct"
        if structure_score >= 45
        else "structure limitée"
    )
    chase_text = (
        "bonne chaseability"
        if chase_quality_score >= 70
        else "lecture terrain moyenne"
        if chase_quality_score >= 45
        else "lecture terrain pénalisée"
    )
    reliability_text = (
        "signal robuste"
        if stability_score >= 70
        else "signal exploitable"
        if stability_score >= 45
        else "signal encore fragile"
    )
    bust_text = (
        "risque de bust élevé"
        if confidence_score >= 70
        else "risque de bust modéré"
        if confidence_score >= 40
        else "risque de bust contenu"
    )
    return f"{day_label} {slot_label} ({selected_hour}) : {initiation_text}, {severity_text}, {chase_text}, {reliability_text}, {bust_text}."


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

        trigger, initiation_diag = compute_initiation(cape, dew, rh2m, vpd, temp, wetbulb, dt)
        structure, severity_diag = compute_severity(shear, gusts, cape, trigger)
        quality, chase_diag = compute_chaseability(cloud_low, cloud_mid, cloud_high, dt, gusts)
        pre_global = clamp(trigger * 0.34 + structure * 0.33 + quality * 0.33)

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
                **initiation_diag,
                **severity_diag,
                **chase_diag,
            }
        )

    metrics_by_idx = {m["idx"]: m for m in metrics}

    rows: list[OutputRow] = []
    sorted_days = sorted(by_day.items(), key=lambda x: x[0])

    for day_index, (day_key, items) in enumerate(sorted_days):
        weekday = WEEKDAYS_FR[items[0][1].weekday()]
        day_label = f"{weekday} {items[0][1].day:02d}"

        for slot_key, start_hour, end_hour, slot_label in TIME_SLOTS:
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
                stability, reliability_diag = compute_reliability(metric, neighbours)
                conf_score = compute_bust_risk(metric["trigger"], metric["structure"], metric["quality"], stability, metric["moisture"], metric["timing"])
                global_score = score_global(metric["trigger"], metric["structure"], metric["quality"], stability, conf_score)
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

                metric_scores = {
                    "cape_score": metric["cape_component"],
                    "dewpoint_score": metric["dew_component"],
                    "humidity_score": metric["humidity_component"],
                    "vpd_score": metric["vpd_component"],
                    "wetbulb_score": metric["wetbulb_component"],
                    "timing_score": metric["timing"],
                    "shear_score": metric["shear_component"],
                    "gust_score": metric["gust_component"],
                    "cloud_score": metric["cloud_score"],
                }
                metrics_used = {
                    "cape_jkg": round(metric["cape"], 1),
                    "temperature_c": round(metric["temp"], 1),
                    "dewpoint_c": round(metric["dew"], 1),
                    "relative_humidity_2m": round(metric["rh2m"], 1),
                    "vapour_pressure_deficit": round(metric["vpd"], 2),
                    "wet_bulb_temperature_2m": round(metric["wetbulb"], 1),
                    "cloud_cover_low": round(metric["cloud_low"], 1),
                    "cloud_cover_mid": round(metric["cloud_mid"], 1),
                    "cloud_cover_high": round(metric["cloud_high"], 1),
                    "wind_gusts_10m": round(metric["gusts"], 1),
                    "shear_ms": round(metric["shear"], 1),
                }
                category_breakdown = {
                    "initiation": {
                        "score": metric["trigger"],
                        "instability": metric["instability"],
                        "moisture": metric["moisture"],
                        "timing": metric["timing"],
                        "inhibition_penalty": metric["inhibition_penalty"],
                    },
                    "severity": {
                        "score": metric["structure"],
                        "updraft": metric["updraft"],
                        "organization": metric["organization"],
                        "maintenance": metric["maintenance"],
                    },
                    "chaseability": {
                        "score": metric["quality"],
                        "visibility": metric["visibility"],
                        "photogenicity": metric["photogenicity"],
                        "comfort": metric["comfort"],
                    },
                    "reliability": {
                        "score": stability,
                        "consistency": reliability_diag["consistency"],
                        "stability": reliability_diag["stability"],
                        "confidence_margin": reliability_diag["confidence_margin"],
                    },
                    "bust_risk": {
                        "score": conf_score,
                    },
                }
                diagnostics = build_cell_diagnostics(metric, reliability_diag, global_score, conf_score)

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
                    analysis_mode="historical" if point and metric["dt"].date() < local_today() else "forecast",
                    metrics_used=metrics_used,
                    metric_scores=metric_scores,
                    category_breakdown=category_breakdown,
                    diagnostics=diagnostics,
                    summary=summary,
                )

                score_key = global_score * 1000 + (100 - conf_score) * 10 + stability
                if score_key > best_score:
                    best_score = score_key
                    best = row

            if best is not None:
                rows.append(best)

    return rows


def fetch_model(points: list[Point], target_date: Date | None = None) -> list[OutputRow]:
    batch_size = batch_size_for_points(points)
    batches = list(chunks(points, batch_size))
    total_batches = len(batches)
    rows: list[OutputRow] = []
    day_mode = target_date.isoformat() if target_date is not None else "jours glissants"
    for batch_index, batch in enumerate(batches, start=1):
        print(f"{FORECAST_MODEL_LABEL if (target_date is None or target_date >= local_today()) else HISTORICAL_MODEL} | lot {batch_index}/{total_batches} | {len(batch)} points | {day_mode}")
        url = build_api_url(batch, target_date=target_date)
        payload = get_json(url)
        structures = location_structures(payload)
        for point, loc in zip(batch, structures):
            rows.extend(rows_for_location(point, loc))
        time.sleep(0.35)
    return rows


def flatten_rows_for_analysis(rows: list[OutputRow]) -> list[dict]:
    flattened: list[dict] = []
    for row in rows:
        entry = asdict(row)
        entry["analysis_rank"] = round(row.score_global - row.confidence_score * 0.35 + row.stability_score * 0.15, 1)
        flattened.append(entry)
    return flattened


def build_historical_analysis_payload(rows: list[OutputRow], center_lat: float, center_lon: float, center_label: str, target_date: Date | None) -> dict:
    flattened = flatten_rows_for_analysis(rows)
    days = sorted({row.day_key for row in rows})
    slots = sorted({row.slot_key for row in rows})
    top_cells = sorted(flattened, key=lambda cell: (cell["analysis_rank"], cell["score_global"], -cell["confidence_score"]), reverse=True)[:30]
    return {
        "meta": {
            "generated_at": datetime.now(ZoneInfo("Europe/Paris")).isoformat(timespec="seconds"),
            "analysis_type": "historical" if target_date is not None and target_date < local_today() else "forecast",
            "target_date": target_date.isoformat() if target_date is not None else None,
            "center": {"lat": center_lat, "lon": center_lon, "label": center_label},
            "rows": len(flattened),
            "days": days,
            "slots": slots,
            "methodology": {
                "goal": "Comparer les sous-scores v2 et le score global à des observations orageuses réelles sur une base historique.",
                "global_score": "Initiation 30%, Severity 30%, Chaseability 25%, Reliability 15%, avec plafonds anti faux positifs et ajustement via Bust Risk.",
                "recommended_join_key": "selected_time_iso + lat/lon ou zone pour recroiser avec éclairs, radar ou observations terrain.",
            },
        },
        "top_cells": top_cells,
        "rows": flattened,
    }



def group_for_output(rows: list[OutputRow], center_lat: float, center_lon: float, center_label: str, target_date: Date | None = None) -> dict:
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
        for slot_key, _, _, _ in TIME_SLOTS:
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
            "model": FORECAST_MODEL_LABEL if (target_date is None or target_date >= local_today()) else HISTORICAL_MODEL,
            "center": {"lat": center_lat, "lon": center_lon, "label": center_label},
            "grid": {
                "half_box_km_lat": HALF_BOX_KM_LAT,
                "half_box_km_lon": HALF_BOX_KM_LON,
                "grid_side_km": GRID_SIDE_KM,
                "cell_size_km": CELL_SIZE_KM,
                "target_batches": TARGET_BATCHES,
            },
            "requested_date": target_date.isoformat() if target_date is not None else None,
            "legend": {
                "global_score": "0-100, combine Initiation 30%, Severity 30%, Chaseability 25%, Reliability 15%, avec plafonds anti faux-positifs et ajustement par Bust Risk.",
                "trigger": "Initiation : instabilité utilisable + humidité basse couche + fenêtre horaire, pénalisée si la couche basse est trop sèche.",
                "structure": "Severity : potentiel d’intensité et d’organisation via CAPE, shear et dynamique de surface.",
                "chase_quality": "Chaseability : visibilité terrain, photogénie et confort relatif via nébulosité, timing et vent.",
                "stability": "Reliability : cohérence interne + stabilité temporelle locale + marge vis-à-vis des seuils.",
                "confidence": "Bust Risk : risque qu’une cellule paraisse prometteuse mais produise peu ou rien sur le terrain.",
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
                f"- {r.zone} | {r.selected_hour} | global {r.score_global} | init {r.trigger_score} | "
                f"severity {r.structure_score} | chase {r.chase_quality_score} | bust {r.confidence_score}"
            )


def main() -> None:
    points = build_grid()
    print(f"Grille construite autour de {DEFAULT_CENTER_LABEL} : {len(points)} points")
    rows = fetch_model(points)
    print(f"{FORECAST_MODEL_LABEL} : {len(rows)} lignes générées")
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



def build_latest_payload(
    center_lat: float = DEFAULT_CENTER_LAT,
    center_lon: float = DEFAULT_CENTER_LON,
    center_label: str = DEFAULT_CENTER_LABEL,
    target_date: Date | None = None,
) -> dict:
    points = build_grid(center_lat=center_lat, center_lon=center_lon, zone_prefix=center_label)
    rows = fetch_model(points, target_date=target_date)
    return group_for_output(rows, center_lat, center_lon, center_label, target_date=target_date)
