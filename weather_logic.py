from __future__ import annotations

import json
import math
import random
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
GRID_SIDE_KM = 195.0
HALF_BOX_KM_LAT = GRID_SIDE_KM / 2
HALF_BOX_KM_LON = GRID_SIDE_KM / 2
CELL_SIZE_KM = 15.0
TARGET_BATCHES = 5
FORECAST_MODEL_LABEL = "arome_france"
FORECAST_FALLBACK_MODEL_LABEL = "meteofrance_best_match"
HISTORICAL_MODEL = "arome_france"
AROME_FORECAST_DAYS = 2
FORECAST_MAX_DAYS = 4
FORECAST_HOURS = 96
HISTORICAL_MIN_DATE = Date(2022, 1, 1)

HOURLY_VARS = [
    "cape",
    "precipitable_water",
    "shortwave_radiation",
    "precipitation_rate",
    "relative_humidity_2m",
    "wind_speed_10m",
    "wind_direction_10m",
    "temperature_2m",
    "dew_point_2m",
    "cloud_cover_low",
    "cloud_cover_mid",
    "cloud_cover_high",
    "wind_gusts_10m",
]

WEEKDAYS_FR = ["Lun", "Mar", "Mer", "Jeu", "Ven", "Sam", "Dim"]
SLOT_HOURS = 1
TIME_SLOTS = [
    (
        f"h{start_hour:02d}",
        start_hour,
        min(23, start_hour + SLOT_HOURS - 1),
        f"{start_hour:02d}h" if SLOT_HOURS == 1 else f"{start_hour:02d}h–{min(23, start_hour + SLOT_HOURS - 1):02d}h",
    )
    for start_hour in range(0, 24, SLOT_HOURS)
]


def clamp(value: float, low: float = 0, high: float = 100) -> int:
    return int(max(low, min(high, round(value))))


def km_to_deg_lat(km: float) -> float:
    return km / 111.0


def km_to_deg_lon(km: float, lat: float) -> float:
    return km / (111.0 * math.cos(math.radians(lat)))


def distance_km(a_lat: float, a_lon: float, b_lat: float, b_lon: float) -> float:
    dx = (a_lon - b_lon) * 111.0 * math.cos(math.radians((a_lat + b_lat) / 2))
    dy = (a_lat - b_lat) * 111.0
    return math.hypot(dx, dy)


def local_today() -> Date:
    return datetime.now(ZoneInfo("Europe/Paris")).date()


def batch_size_for_points(points: list[Point]) -> int:
    return max(1, math.ceil(len(points) / TARGET_BATCHES))


def forecast_days_ahead(target_date: Date | None) -> int | None:
    if target_date is None:
        return None
    return (target_date - local_today()).days


def forecast_model_for_date(target_date: Date | None) -> str | None:
    days_ahead = forecast_days_ahead(target_date)
    if days_ahead is None:
        return None
    if days_ahead < AROME_FORECAST_DAYS:
        return FORECAST_MODEL_LABEL
    return None


def forecast_model_label_for_meta(target_date: Date | None) -> str:
    return forecast_model_for_date(target_date) or FORECAST_FALLBACK_MODEL_LABEL


def model_name_for_request(target_date: Date | None, mode: str = "auto") -> str:
    _, _, api_mode = api_context(target_date, mode=mode)
    if api_mode == "mock":
        return "mock_random"
    if api_mode == "historical":
        return HISTORICAL_MODEL
    return forecast_model_label_for_meta(target_date)


def api_context(target_date: Date | None, mode: str = "auto") -> tuple[str, dict[str, str], str]:
    today = local_today()
    if target_date is not None and target_date < HISTORICAL_MIN_DATE:
        raise ValueError(f"Date trop ancienne pour l'archive de prévisions Open-Meteo : {target_date.isoformat()} < {HISTORICAL_MIN_DATE.isoformat()}")

    def forecast_date_params(forecast_ref: Date | None) -> dict[str, str]:
        if forecast_ref is None:
            return {
                "forecast_days": str(FORECAST_MAX_DAYS),
                "past_days": "0",
            }
        days_ahead = (forecast_ref - today).days
        if days_ahead < 0:
            raise ValueError(f"Date hors horizon forecast : {forecast_ref.isoformat()} est passée. Utilise le mode historical.")
        if days_ahead >= FORECAST_MAX_DAYS:
            max_date = today.toordinal() + FORECAST_MAX_DAYS - 1
            max_iso = Date.fromordinal(max_date).isoformat()
            raise ValueError(f"Date hors horizon forecast Météo-France : {forecast_ref.isoformat()} > {max_iso}")
        return {
            "start_date": forecast_ref.isoformat(),
            "end_date": forecast_ref.isoformat(),
        }

    if mode == "mock":
        if target_date is None:
            target_date = today
        return "mock://local", {
            "start_date": target_date.isoformat(),
            "end_date": target_date.isoformat(),
        }, "mock"

    if mode == "historical":
        if target_date is None:
            target_date = today
        return HISTORICAL_API_BASE, {
            "start_date": target_date.isoformat(),
            "end_date": target_date.isoformat(),
        }, "historical"

    if mode == "forecast":
        return FORECAST_API_BASE, forecast_date_params(target_date), "forecast"

    if target_date is not None and target_date < today:
        return HISTORICAL_API_BASE, {
            "start_date": target_date.isoformat(),
            "end_date": target_date.isoformat(),
        }, "historical"

    return FORECAST_API_BASE, forecast_date_params(target_date), "forecast"


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
    convective_inhibition: float | None
    relative_humidity_2m: float
    vapour_pressure_deficit: float
    wet_bulb_temperature_2m: float
    precipitable_water: float | None
    shortwave_radiation: float | None
    precipitation_rate: float | None
    cloud_cover_low: float
    cloud_cover_mid: float
    cloud_cover_high: float
    wind_gusts_10m: float
    wind_speed_10m: float
    wind_direction_10m: float
    surface_convergence_1e4s: float | None
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
    step_lon = km_to_deg_lon(CELL_SIZE_KM, center_lat)
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
        for col in range(-col_half, col_half + 1):
            lon = round(center_lon + col * step_lon, 5)
            points.append(
                Point(
                    zone=f"{safe_prefix}-{idx}",
                    lat=lat,
                    lon=lon,
                    cell_height_deg=step_lat,
                    cell_width_deg=step_lon,
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


def build_api_url(points: list[Point], target_date: Date | None = None, mode: str = "auto") -> str:
    latitudes = ",".join(str(p.lat) for p in points)
    longitudes = ",".join(str(p.lon) for p in points)
    api_base, date_params, api_mode = api_context(target_date, mode=mode)
    params = {
        "latitude": latitudes,
        "longitude": longitudes,
        "hourly": ",".join(HOURLY_VARS),
        "timezone": TIMEZONE,
        "wind_speed_unit": "ms",
        "format": "json",
        **date_params,
    }
    if api_mode == "mock":
        params["models"] = "mock_random"
    elif api_mode == "historical":
        params["models"] = HISTORICAL_MODEL
    elif api_mode == "forecast":
        # AROME France only covers today + tomorrow. Beyond that, let Open-Meteo
        # select the best Météo-France model, typically ARPEGE, up to J+3.
        model_name = forecast_model_for_date(target_date)
        if model_name:
            params["models"] = model_name
        if "start_date" not in date_params:
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


def wind_components_ms(speed_ms: float, direction_deg: float) -> tuple[float, float]:
    # Meteorological direction is the direction the wind comes from.
    u = -float(speed_ms) * math.sin(math.radians(float(direction_deg)))
    v = -float(speed_ms) * math.cos(math.radians(float(direction_deg)))
    return u, v


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
        (25, 2),
        (50, 5),
        (100, 10),
        (150, 16),
        (300, 28),
        (600, 48),
        (1000, 66),
        (1800, 82),
        (2500, 100),
    ])


def score_shear(shear_ms: float) -> int:
    return piecewise_score(shear_ms, [
        (0, 0),
        (8, 10),
        (12, 30),
        (18, 60),
        (25, 85),
        (32, 100),
    ])


def score_dewpoint(dewpoint_c: float) -> int:
    return piecewise_score(dewpoint_c, [
        (0, 0),
        (6, 0),
        (8, 10),
        (10, 25),
        (12, 45),
        (14, 65),
        (16, 80),
        (18, 90),
        (20, 100),
    ])


def score_humidity(rh2m: float) -> int:
    return piecewise_score(rh2m, [
        (20, 0),
        (35, 0),
        (45, 20),
        (55, 40),
        (65, 60),
        (80, 80),
        (95, 90),
    ])


def score_vpd(vpd: float) -> int:
    return piecewise_score(vpd, [
        (3.5, 0),
        (2.5, 20),
        (1.8, 40),
        (1.2, 65),
        (0.8, 85),
        (0.0, 100),
    ], inverse=True)


def score_wetbulb(wetbulb_c: float) -> int:
    return piecewise_score(wetbulb_c, [
        (4, 0),
        (8, 15),
        (11, 35),
        (14, 55),
        (17, 75),
        (20, 92),
        (23, 100),
    ])


def score_precipitable_water(pwat_kg_m2: float | None) -> int | None:
    if pwat_kg_m2 is None or not math.isfinite(float(pwat_kg_m2)):
        return None
    return piecewise_score(max(0.0, float(pwat_kg_m2)), [
        (8, 0),
        (14, 15),
        (18, 35),
        (24, 55),
        (30, 75),
        (38, 92),
        (45, 100),
    ])


def score_shortwave_radiation(shortwave_w_m2: float | None) -> int | None:
    if shortwave_w_m2 is None or not math.isfinite(float(shortwave_w_m2)):
        return None
    return piecewise_score(max(0.0, float(shortwave_w_m2)), [
        (0, 0),
        (50, 10),
        (120, 25),
        (250, 50),
        (400, 75),
        (600, 92),
        (800, 100),
    ])


def score_gusts(gusts: float) -> int:
    return piecewise_score(gusts, [
        (40, 8),
        (32, 24),
        (26, 48),
        (20, 68),
        (14, 86),
        (8, 96),
        (0, 100),
    ], inverse=True)


def score_gust_potential(gusts_ms: float | None) -> int | None:
    if gusts_ms is None:
        return None
    try:
        value = float(gusts_ms)
    except (TypeError, ValueError):
        return None
    if not math.isfinite(value):
        return None
    return piecewise_score(max(0.0, value), [
        (4, 0),
        (7, 12),
        (10, 28),
        (14, 48),
        (18, 68),
        (24, 86),
        (30, 100),
    ])


def score_precipitation_rate(rate_mm_h: float | None) -> int:
    if rate_mm_h is None or not math.isfinite(rate_mm_h):
        return 0
    return piecewise_score(max(0.0, float(rate_mm_h)), [
        (0.0, 0),
        (0.05, 8),
        (0.15, 20),
        (0.30, 38),
        (0.60, 58),
        (1.20, 76),
        (2.50, 92),
        (5.00, 100),
    ])


def score_cloud_penalty(cloud_low: float, cloud_mid: float, cloud_high: float) -> int:
    low = piecewise_score(cloud_low, [(0, 100), (10, 95), (25, 84), (40, 66), (60, 38), (80, 16), (100, 4)])
    mid = piecewise_score(cloud_mid, [(0, 100), (10, 96), (25, 88), (40, 74), (60, 50), (80, 24), (100, 6)])
    high = piecewise_score(cloud_high, [(0, 100), (10, 96), (25, 90), (40, 80), (60, 62), (80, 36), (100, 10)])
    return clamp(low * 0.50 + mid * 0.30 + high * 0.20)


def _cloud_value(value: float | None) -> float | None:
    if value is None:
        return None
    try:
        numeric = float(value)
    except (TypeError, ValueError):
        return None
    if not math.isfinite(numeric):
        return None
    return max(0.0, min(100.0, numeric))


def score_clear_sky_guard(
    cloud_low: float | None,
    cloud_mid: float | None,
    cloud_high: float | None,
) -> tuple[int | None, int, float | None, float | None]:
    low = _cloud_value(cloud_low)
    mid = _cloud_value(cloud_mid)
    high = _cloud_value(cloud_high)
    if low is None and mid is None and high is None:
        return None, 0, None, None

    low_v = low or 0.0
    mid_v = mid or 0.0
    high_v = high or 0.0
    convective_cover = max(
        low_v,
        mid_v * 0.85,
        min(100.0, low_v * 0.70 + mid_v * 0.55 + high_v * 0.18),
    )
    total_cover = max(
        low_v,
        mid_v,
        high_v * 0.60,
        min(100.0, low_v + mid_v * 0.75 + high_v * 0.35),
    )
    support = piecewise_score(convective_cover, [
        (0, 0),
        (8, 8),
        (15, 22),
        (25, 45),
        (38, 68),
        (55, 86),
        (75, 100),
    ])
    # A clear pre-convective sky can favour surface heating; cloud cover is
    # therefore a context signal, not a hard no-go gate. Keep only a light
    # uncertainty penalty when AROME materialises almost no cloud signal.
    penalty = piecewise_score(convective_cover, [
        (0, 8),
        (8, 7),
        (15, 5),
        (25, 3),
        (35, 1),
        (45, 0),
    ])
    if total_cover < 12:
        penalty = max(penalty, 8)
    elif total_cover < 20:
        penalty = max(penalty, 5)
    return support, penalty, round(convective_cover, 1), round(total_cover, 1)


def score_timing(dt: datetime) -> int:
    hour = dt.hour + dt.minute / 60.0
    if hour < 8:
        return 10
    if hour < 12:
        return 30
    if hour < 18:
        return 100
    if hour < 22:
        return 60
    return 20


def score_cin_actual(cin_jkg: float | None) -> int | None:
    if cin_jkg is None or not math.isfinite(cin_jkg):
        return None
    magnitude = abs(float(cin_jkg))
    return piecewise_score(magnitude, [
        (250, 0),
        (150, 10),
        (100, 28),
        (50, 58),
        (25, 78),
        (0, 100),
    ], inverse=True)


def score_surface_convergence(convergence_s1: float | None) -> int | None:
    if convergence_s1 is None or not math.isfinite(convergence_s1):
        return None
    convergence_1e4 = convergence_s1 * 10_000.0
    return piecewise_score(convergence_1e4, [
        (-2.0, 0),
        (-1.0, 20),
        (0.0, 50),
        (0.5, 65),
        (1.0, 80),
        (2.0, 95),
        (3.0, 100),
    ])


def compute_initiation(
    cape: float,
    dewpoint_c: float,
    rh2m: float,
    vpd: float,
    temp_c: float,
    wetbulb_c: float,
    dt: datetime,
    cin_jkg: float | None = None,
    surface_convergence_s1: float | None = None,
    precipitation_rate_mm_h: float | None = None,
    precipitable_water_kg_m2: float | None = None,
    shortwave_radiation_w_m2: float | None = None,
    wind_gusts_10m_ms: float | None = None,
    cloud_low: float | None = None,
    cloud_mid: float | None = None,
    cloud_high: float | None = None,
) -> tuple[int, dict[str, float | int | None]]:
    cape_s = score_cape(cape)
    dew_s = score_dewpoint(dewpoint_c)
    rh_s = score_humidity(rh2m)
    vpd_s = score_vpd(vpd)
    wet_s = score_wetbulb(wetbulb_c)
    timing_s = score_timing(dt)
    shortwave_s = score_shortwave_radiation(shortwave_radiation_w_m2)
    surface_heating_s = clamp(timing_s * 0.55 + shortwave_s * 0.45) if shortwave_s is not None else timing_s
    shortwave_radiation = (
        max(0.0, float(shortwave_radiation_w_m2))
        if shortwave_radiation_w_m2 is not None and math.isfinite(float(shortwave_radiation_w_m2))
        else None
    )
    cin_actual_s = score_cin_actual(cin_jkg)
    # Without a real vertical CIN field, the 2 m proxy remains diagnostic only.
    # It must not double-count the dry-air penalties already captured by Td/VPD.
    cin_support_s = cin_actual_s
    precipitation_available = precipitation_rate_mm_h is not None and math.isfinite(float(precipitation_rate_mm_h))
    precipitation_s = score_precipitation_rate(precipitation_rate_mm_h) if precipitation_available else None
    precipitation_rate = max(0.0, float(precipitation_rate_mm_h)) if precipitation_available else None
    gust_potential_s = score_gust_potential(wind_gusts_10m_ms)
    precipitable_water_s = score_precipitable_water(precipitable_water_kg_m2)
    precipitable_water = (
        max(0.0, float(precipitable_water_kg_m2))
        if precipitable_water_kg_m2 is not None and math.isfinite(float(precipitable_water_kg_m2))
        else None
    )
    surface_trigger_s = score_surface_convergence(surface_convergence_s1)
    surface_convergence_1e4 = (
        round(surface_convergence_s1 * 10_000.0, 2)
        if surface_convergence_s1 is not None and math.isfinite(surface_convergence_s1)
        else None
    )
    cloud_support_s, clear_sky_penalty, convective_cloud_cover, total_cloud_cover = score_clear_sky_guard(
        cloud_low,
        cloud_mid,
        cloud_high,
    )

    convective_activity_s = None
    if precipitation_s is not None:
        cloud_activity = cloud_support_s if cloud_support_s is not None else 0
        gust_activity = gust_potential_s if gust_potential_s is not None else 0
        if precipitation_s >= 58 or (precipitation_s >= 30 and cloud_activity >= 25):
            convective_activity_s = clamp(precipitation_s * 0.55 + cloud_activity * 0.25 + gust_activity * 0.20)
        elif cloud_activity >= 55 and gust_activity >= 35:
            convective_activity_s = clamp(cloud_activity * 0.55 + gust_activity * 0.25 + precipitation_s * 0.20)

    if precipitable_water_s is None:
        humidity_block = clamp(dew_s * 0.60 + rh_s * 0.20 + vpd_s * 0.20)
    else:
        humidity_block = clamp(dew_s * 0.45 + rh_s * 0.15 + vpd_s * 0.18 + wet_s * 0.07 + precipitable_water_s * 0.15)
    moisture = humidity_block
    instability = cape_s

    if surface_trigger_s is None:
        score = (
            0.50 * cape_s +
            0.40 * humidity_block +
            0.10 * surface_heating_s
        )
    else:
        score = (
            0.44 * cape_s +
            0.34 * humidity_block +
            0.10 * surface_heating_s +
            0.12 * surface_trigger_s
        )

    inhibition_penalty = 0.0
    if cape <= 0 or cape_s <= 0:
        score = min(score * 0.20, 8)
        inhibition_penalty += 20
    elif cape_s < 12:
        score *= 0.45
        inhibition_penalty += 12
    elif cape_s < 25:
        score *= 0.65
        inhibition_penalty += 8
    elif cape_s < 40:
        score *= 0.78
        inhibition_penalty += 5
    if 300 < cape < 1000 and dew_s > 70:
        score += 10
    if cape_s > 60 and dew_s < 40:
        score *= 0.50
        inhibition_penalty += 18
    if dew_s < 30:
        score *= 0.30
        inhibition_penalty += 24
    if vpd_s < 30:
        score *= 0.50
        inhibition_penalty += 18
    if dew_s < 30 and vpd_s < 30:
        score *= 0.20
        inhibition_penalty += 20
    if cin_support_s is not None:
        if cin_support_s < 25:
            score *= 0.55
            inhibition_penalty += 16
        elif cin_support_s < 40:
            score *= 0.75
            inhibition_penalty += 8
    if cin_actual_s is not None and cin_actual_s >= 70:
        score += 5
    if surface_trigger_s is not None:
        if surface_trigger_s < 25 and cape_s < 65:
            score *= 0.88
            inhibition_penalty += 5
        elif surface_trigger_s >= 75 and cape_s >= 35 and dew_s >= 40 and (cin_support_s is None or cin_support_s >= 35):
            score += 6
    if precipitable_water_s is not None:
        if precipitable_water_s < 25 and cape_s >= 45:
            score *= 0.92
            inhibition_penalty += 4
        elif precipitable_water_s >= 75 and cape_s >= 35 and dew_s >= 45:
            score += 4
    if shortwave_s is not None:
        if shortwave_s < 20 and 9 <= dt.hour <= 19 and cape_s >= 45:
            score *= 0.94
            inhibition_penalty += 3
        elif shortwave_s >= 70 and cape_s >= 35 and dew_s >= 40:
            score += 3
    if convective_activity_s is not None:
        activity_score = convective_activity_s
        if cape_s < 15 and dew_s < 35:
            activity_score *= 0.55
            inhibition_penalty += 6
        elif cape_s < 15:
            activity_score *= 0.75
            inhibition_penalty += 3
        score = max(score, activity_score)

    # Cloud cover is diagnostic only here: a clear pre-convective sky can
    # support surface heating, so low cloud signal must not subtract
    # probability. Keep the value as an uncertainty indicator for UI/confidence.
    applied_clear_sky_penalty = int(clear_sky_penalty or 0)

    environment_score = clamp(score)

    return clamp(score), {
        'instability': instability,
        'moisture': moisture,
        'timing': timing_s,
        'surface_heating_component': surface_heating_s,
        'shortwave_radiation_component': shortwave_s,
        'shortwave_radiation_w_m2': round(shortwave_radiation, 1) if shortwave_radiation is not None else None,
        'environment_component': environment_score,
        'inhibition_penalty': clamp(inhibition_penalty),
        'cape_component': cape_s,
        'dew_component': dew_s,
        'humidity_component': rh_s,
        'vpd_component': vpd_s,
        'wetbulb_component': wet_s,
        'cin_actual_component': cin_actual_s,
        'surface_trigger_component': surface_trigger_s,
        'precipitation_component': precipitation_s,
        'precipitation_rate_mm_h': round(precipitation_rate, 3) if precipitation_rate is not None else None,
        'gust_potential_component': gust_potential_s,
        'convective_activity_component': convective_activity_s,
        'precipitable_water_component': precipitable_water_s,
        'precipitable_water_kg_m2': round(precipitable_water, 1) if precipitable_water is not None else None,
        'surface_convergence_1e4s': surface_convergence_1e4,
        'cloud_trigger_component': cloud_support_s,
        'clear_sky_penalty': applied_clear_sky_penalty,
        'convective_cloud_cover': convective_cloud_cover,
        'total_cloud_cover': total_cloud_cover,
    }


def compute_severity(shear_ms: float, gusts: float, cape: float, initiation_score: int) -> tuple[int, dict[str, int]]:
    cape_s = score_cape(cape)
    surface_dynamics_s = clamp(100 - score_gusts(gusts))
    updraft = cape_s
    organization = clamp(cape_s * 0.65 + surface_dynamics_s * 0.35)
    maintenance = clamp(cape_s * 0.45 + surface_dynamics_s * 0.25 + initiation_score * 0.30)
    score = cape_s * 0.62 + surface_dynamics_s * 0.23 + initiation_score * 0.15

    if cape_s < 40:
        score *= 0.60
    if initiation_score < 20:
        score = 0
    elif initiation_score < 35:
        score *= 0.55
    elif initiation_score < 50:
        score *= 0.75

    if cape_s > 70 and surface_dynamics_s > 35 and initiation_score >= 60:
        score += 8
    elif cape_s > 55 and initiation_score >= 50:
        score += 4

    return clamp(score), {
        'updraft': clamp(updraft),
        'organization': clamp(organization),
        'maintenance': clamp(maintenance),
        'surface_dynamics_component': surface_dynamics_s,
        'gust_component': surface_dynamics_s,
    }


def compute_chaseability(cloud_low: float, cloud_mid: float, cloud_high: float, dt: datetime, gusts: float) -> tuple[int, dict[str, int]]:
    cloud_score = score_cloud_penalty(cloud_low, cloud_mid, cloud_high)
    visibility = cloud_score
    timing_s = score_timing(dt)
    photogenicity = clamp(visibility * 0.70 + timing_s * 0.30)
    comfort = score_gusts(gusts)
    score = visibility * 0.50 + timing_s * 0.30 + comfort * 0.20
    return clamp(score), {
        'visibility': clamp(visibility),
        'photogenicity': clamp(photogenicity),
        'comfort': clamp(comfort),
        'cloud_score': clamp(cloud_score),
    }


def compute_reliability(reference: dict, neighbours: list[dict]) -> tuple[int, dict[str, int]]:
    if not neighbours:
        base = clamp(reference['trigger'] * 0.45 + reference['moisture'] * 0.35 + reference['timing'] * 0.20)
        return base, {'consistency': base, 'stability': base, 'confidence_margin': base}

    ref_initiation = reference['trigger']
    ref_severity = reference['structure']
    consistency = 88.0
    if ref_initiation >= 55 and reference['moisture'] < 40:
        consistency -= 18
    if ref_initiation >= 45 and reference['cape_component'] < 25:
        consistency -= 18
    if ref_severity >= 70 and ref_initiation < 35:
        consistency -= 12

    initiation_diffs = [abs(ref_initiation - n['trigger']) for n in neighbours]
    severity_diffs = [abs(ref_severity - n['structure']) for n in neighbours]
    stability = 86 - (sum(initiation_diffs) / len(initiation_diffs)) * 0.55 - (sum(severity_diffs) / len(severity_diffs)) * 0.25

    low_support = min(reference['cape_component'], reference['dew_component'], reference['vpd_component'])
    confidence_margin = clamp(low_support * 0.85 + reference['humidity_component'] * 0.15)

    score = consistency * 0.45 + stability * 0.25 + confidence_margin * 0.30
    return clamp(score), {
        'consistency': clamp(consistency),
        'stability': clamp(stability),
        'confidence_margin': clamp(confidence_margin),
    }
def compute_bust_risk(initiation_score: int, severity_score: int, chaseability_score: int, reliability_score: int, moisture_component: int, timing_component: int) -> int:
    risk = 100.0
    risk -= initiation_score * 0.55
    risk -= moisture_component * 0.15
    risk -= reliability_score * 0.15
    risk -= timing_component * 0.10
    risk -= severity_score * 0.05

    if initiation_score < 10:
        risk += 20
    elif initiation_score < 25:
        risk += 12
    if moisture_component < 30:
        risk += 16
    if reliability_score < 35:
        risk += 10
    if severity_score >= 70 and initiation_score < 35:
        risk += 10

    return clamp(risk)
def compute_signal_confidence(reference: dict, neighbours: list[dict]) -> tuple[int, dict[str, int]]:
    trigger = int(reference.get('trigger') or 0)
    support_values = [
        int(reference.get('cape_component') or 0),
        int(reference.get('dew_component') or 0),
        int(reference.get('humidity_component') or 0),
        int(reference.get('vpd_component') or 0),
        int(reference.get('wetbulb_component') or 0),
    ]
    if reference.get('cin_actual_component') is not None:
        support_values.append(int(reference.get('cin_actual_component') or 0))
    if reference.get('precipitable_water_component') is not None:
        support_values.append(int(reference.get('precipitable_water_component') or 0))
    if reference.get('surface_heating_component') is not None:
        support_values.append(int(reference.get('surface_heating_component') or 0))
    # Activity fields are positive evidence only. Clear sky, no rain or weak gusts
    # must not reduce confidence by themselves before convection starts.
    for activity_key in (
        'precipitation_component',
        'gust_potential_component',
        'convective_activity_component',
    ):
        value = reference.get(activity_key)
        if value is not None and int(value or 0) >= 25:
            support_values.append(int(value or 0))
    support_floor = min(support_values) if support_values else 0
    support_mean = sum(support_values) / len(support_values) if support_values else 0
    spread = max(support_values) - support_floor if support_values else 100

    consistency = 100 - spread * 0.42
    if trigger >= 35 and support_floor < 30:
        consistency -= 18
    if trigger >= 55 and support_floor < 45:
        consistency -= 12
    if neighbours:
        trigger_diffs = [abs(trigger - int(n.get('trigger') or 0)) for n in neighbours]
        temporal = 92 - (sum(trigger_diffs) / len(trigger_diffs)) * 0.85
    else:
        temporal = 74

    if trigger < 20:
        blocker_values = [
            100 - int(reference.get('cape_component') or 0),
            100 - int(reference.get('dew_component') or 0),
            100 - int(reference.get('vpd_component') or 0),
        ]
        strongest_blocker = max(blocker_values)
        margin = clamp(strongest_blocker * 0.70 + (100 - trigger) * 0.30)
    else:
        margin = clamp(support_floor * 0.65 + support_mean * 0.35)
    score = consistency * 0.35 + temporal * 0.30 + margin * 0.35
    return clamp(score), {
        'consistency': clamp(consistency),
        'temporal_stability': clamp(temporal),
        'margin': clamp(margin),
    }


_CONFIDENCE_ALPHA = 0.45  # atténuation douce : (conf/100)^0.45 — pénalise fortement <30, peu >70

def compute_storm_probability(initiation_score: int, confidence_score: int = 50, *_ignored: int) -> int:
    """Score calibré : signal brut atténué par la confiance.

    Exemples pour initiation=89 :
      conf=90 → 85 | conf=70 → 82 | conf=50 → 69 | conf=30 → 57 | conf=10 → 37
    """
    calibration = (max(1, confidence_score) / 100) ** _CONFIDENCE_ALPHA
    return clamp(round(initiation_score * calibration))



def score_global(trigger_score: int, *_ignored: int, **_kwargs: int) -> int:
    return clamp(trigger_score)


def score_confidence(trigger_score: int, *_ignored: int, **_kwargs: int) -> int:
    return clamp(trigger_score)


def build_cell_diagnostics(metric: dict, confidence_diag: dict[str, int], probability_score: int, confidence_score: int) -> list[str]:
    diagnostics: list[str] = []

    if probability_score >= 75:
        diagnostics.append("Probabilité orage élevée : instabilité, humidité et contexte horaire convergent bien.")
    elif probability_score >= 45:
        diagnostics.append("Probabilité orage modérée : environnement convectif présent mais encore sensible au déclenchement.")
    else:
        diagnostics.append("Probabilité orage faible : au moins un ingrédient convectif majeur manque encore.")

    if metric['cape_component'] == 0:
        diagnostics.append("CAPE nul ou quasi nul : sans instabilité exploitable, le scénario orageux reste fermé.")
    elif metric['cape_component'] < 25:
        diagnostics.append("CAPE marginal : convection possible seulement avec un forçage ou un environnement très favorable.")

    if metric['dew_component'] < 30 or metric['humidity_component'] < 25:
        diagnostics.append("Humidité basse couche trop limitée : le déclenchement reste fragile malgré d'autres signaux favorables.")
    if metric['vpd_component'] < 30:
        diagnostics.append("Air trop sec près du sol : l'évaporation pénalise le signal via l'humidité et le VPD.")
    if metric.get('precipitable_water_component') is not None:
        if int(metric.get('precipitable_water_component') or 0) < 35:
            diagnostics.append("Humidité de colonne faible : le point de rosée de surface est moins robuste pour soutenir une convection profonde.")
        elif int(metric.get('precipitable_water_component') or 0) >= 75:
            diagnostics.append("Humidité de colonne favorable : la réserve en vapeur d’eau soutient mieux le signal convectif.")
    if metric.get('shortwave_radiation_component') is not None:
        if int(metric.get('shortwave_radiation_component') or 0) < 25 and 9 <= metric['dt'].hour <= 19:
            diagnostics.append("Rayonnement court faible : le chauffage de surface prévu soutient peu le déclenchement diurne.")
        elif int(metric.get('shortwave_radiation_component') or 0) >= 70:
            diagnostics.append("Rayonnement court favorable : le chauffage de surface soutient le potentiel pré-convectif.")
    clear_sky_penalty = int(metric.get('clear_sky_penalty') or 0)
    cloud_support = metric.get('cloud_trigger_component')
    if clear_sky_penalty >= 6:
        diagnostics.append("Ciel peu nuageux : contexte potentiellement favorable au chauffage diurne, mais AROME ne matérialise pas encore de signal nuageux.")
    elif clear_sky_penalty > 0:
        diagnostics.append("Nébulosité faible : le contexte nuageux reste surtout informatif et ne ferme pas le déclenchement.")
    elif cloud_support is not None and int(cloud_support) >= 55:
        diagnostics.append("Nébulosité convective crédible : le signal nuageux AROME accompagne le potentiel prévu.")
    surface_trigger = metric.get('surface_trigger_component')
    if surface_trigger is not None and surface_trigger >= 75:
        diagnostics.append("Convergence 10 m favorable : le vent de surface soutient localement le déclenchement.")
    elif surface_trigger is not None and surface_trigger < 25:
        diagnostics.append("Divergence 10 m locale : le déclenchement est moins soutenu par le vent de surface.")
    if confidence_diag.get('consistency', 100) < 45:
        diagnostics.append("Confiance limitée : les ingrédients ne vont pas tous dans le même sens.")
    if confidence_diag.get('temporal_stability', 100) < 45:
        diagnostics.append("Confiance limitée : le signal varie fortement autour de l'heure retenue.")
    if confidence_score >= 75:
        diagnostics.append("Confiance élevée : le signal est cohérent et peu marginal.")

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
    confidence_score: int,
    *_ignored: int,
) -> str:
    probability_text = (
        "probabilité orage élevée"
        if trigger_score >= 70
        else "probabilité orage modérée"
        if trigger_score >= 45
        else "probabilité orage faible"
    )
    confidence_text = (
        "confiance élevée"
        if confidence_score >= 70
        else "confiance moyenne"
        if confidence_score >= 45
        else "confiance faible"
    )
    return f"{day_label} {slot_label} ({selected_hour}) : {probability_text}, {confidence_text}."


def _relative_humidity_from_dewpoint_c(temp_c: float | None, dewpoint_c: float | None) -> float | None:
    if temp_c is None or dewpoint_c is None:
        return None
    if not math.isfinite(temp_c) or not math.isfinite(dewpoint_c):
        return None
    try:
        saturation = math.exp((17.625 * temp_c) / (243.04 + temp_c))
        actual = math.exp((17.625 * dewpoint_c) / (243.04 + dewpoint_c))
    except (OverflowError, ZeroDivisionError):
        return None
    return max(0.0, min(100.0, 100.0 * actual / saturation))


def _vapour_pressure_deficit_kpa(temp_c: float | None, dewpoint_c: float | None) -> float | None:
    if temp_c is None or dewpoint_c is None:
        return None
    if not math.isfinite(temp_c) or not math.isfinite(dewpoint_c):
        return None
    es = 0.6108 * math.exp((17.27 * temp_c) / (temp_c + 237.3))
    ea = 0.6108 * math.exp((17.27 * dewpoint_c) / (dewpoint_c + 237.3))
    return max(0.0, es - ea)


def _wet_bulb_stull_c(temp_c: float | None, rh_percent: float | None) -> float | None:
    if temp_c is None or rh_percent is None:
        return None
    if not math.isfinite(temp_c) or not math.isfinite(rh_percent):
        return None
    rh = max(1.0, min(100.0, rh_percent))
    return (
        temp_c * math.atan(0.151977 * math.sqrt(rh + 8.313659))
        + math.atan(temp_c + rh)
        - math.atan(rh - 1.676331)
        + 0.00391838 * (rh ** 1.5) * math.atan(0.023101 * rh)
        - 4.686035
    )


def optional_hourly_float(hourly: dict, keys: list[str], idx: int) -> float | None:
    for key in keys:
        values = hourly.get(key)
        if not isinstance(values, list) or idx >= len(values):
            continue
        value = values[idx]
        if value is None or value == "":
            return None
        try:
            number = float(value)
        except (TypeError, ValueError):
            return None
        if math.isfinite(number):
            return number
    return None


def round_optional(value: float | None, digits: int = 1) -> float | None:
    if value is None or not math.isfinite(value):
        return None
    return round(value, digits)


def _hourly_value(values: list | None, idx: int) -> float | None:
    if not isinstance(values, list) or idx >= len(values):
        return None
    value = values[idx]
    if value is None or value == "":
        return None
    try:
        number = float(value)
    except (TypeError, ValueError):
        return None
    return number if math.isfinite(number) else None


def _hourly_bool(values: list | None, idx: int, default: bool) -> bool:
    if not isinstance(values, list) or idx >= len(values):
        return default
    value = values[idx]
    if isinstance(value, bool):
        return value
    if isinstance(value, (int, float)):
        return bool(value)
    if isinstance(value, str):
        return value.strip().lower() not in {"", "0", "false", "non", "no"}
    return default


def _surface_convergence_by_point_time(points: list[Point], locations: list[dict]) -> dict[tuple[str, str], float]:
    by_time: dict[str, dict[tuple[float, float], dict[str, float | str]]] = {}
    for point, loc in zip(points, locations):
        hourly = loc.get("hourly", {}) if isinstance(loc, dict) else {}
        times = hourly.get("time", [])
        wind_speeds = hourly.get("wind_speed_10m")
        wind_dirs = hourly.get("wind_direction_10m")
        direction_flags = hourly.get("wind_direction_10m_available")
        for idx, time_value in enumerate(times if isinstance(times, list) else []):
            speed = _hourly_value(wind_speeds, idx)
            direction = _hourly_value(wind_dirs, idx)
            direction_available = _hourly_bool(direction_flags, idx, default=isinstance(wind_dirs, list))
            if speed is None or direction is None or not direction_available:
                continue
            u, v = wind_components_ms(speed, direction)
            by_time.setdefault(str(time_value), {})[(round(point.lat, 5), round(point.lon, 5))] = {
                "zone": point.zone,
                "lat": point.lat,
                "lon": point.lon,
                "u": u,
                "v": v,
            }

    convergence: dict[tuple[str, str], float] = {}
    for time_value, vectors in by_time.items():
        if len(vectors) < 9:
            continue
        lats = sorted({key[0] for key in vectors})
        lons = sorted({key[1] for key in vectors})
        if len(lats) < 3 or len(lons) < 3:
            continue
        for lat_idx in range(1, len(lats) - 1):
            for lon_idx in range(1, len(lons) - 1):
                key = (lats[lat_idx], lons[lon_idx])
                west_key = (lats[lat_idx], lons[lon_idx - 1])
                east_key = (lats[lat_idx], lons[lon_idx + 1])
                south_key = (lats[lat_idx - 1], lons[lon_idx])
                north_key = (lats[lat_idx + 1], lons[lon_idx])
                if not all(item in vectors for item in (key, west_key, east_key, south_key, north_key)):
                    continue
                cell = vectors[key]
                west = vectors[west_key]
                east = vectors[east_key]
                south = vectors[south_key]
                north = vectors[north_key]
                mean_lat_rad = math.radians(float(cell["lat"]))
                dx_m = max(1.0, abs(float(east["lon"]) - float(west["lon"])) * 111_320.0 * max(0.15, math.cos(mean_lat_rad)))
                dy_m = max(1.0, abs(float(north["lat"]) - float(south["lat"])) * 111_320.0)
                du_dx = (float(east["u"]) - float(west["u"])) / dx_m
                dv_dy = (float(north["v"]) - float(south["v"])) / dy_m
                convergence[(str(cell["zone"]), time_value)] = -(du_dx + dv_dy)
    return convergence


def rows_for_grid_locations(points: list[Point], locations: list[dict]) -> list[OutputRow]:
    convergence_by_zone_time = _surface_convergence_by_point_time(points, locations)
    rows: list[OutputRow] = []
    for point, loc in zip(points, locations):
        rows.extend(rows_for_location(point, loc, convergence_by_zone_time=convergence_by_zone_time))
    return rows


def rows_for_location(point: Point, loc: dict, convergence_by_zone_time: dict[tuple[str, str], float] | None = None) -> list[OutputRow]:
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

        cape = float(_hourly_value(hourly.get("cape"), idx) or 0.0)
        precipitation_raw = _hourly_value(hourly.get("precipitation_rate"), idx)
        precipitation_rate = float(precipitation_raw) if precipitation_raw is not None else None
        precipitable_water_raw = _hourly_value(hourly.get("precipitable_water"), idx)
        precipitable_water = float(precipitable_water_raw) if precipitable_water_raw is not None else None
        shortwave_raw = _hourly_value(hourly.get("shortwave_radiation"), idx)
        shortwave_radiation = float(shortwave_raw) if shortwave_raw is not None else None
        temp = float(_hourly_value(hourly.get("temperature_2m"), idx) or 0.0)
        dew = float(_hourly_value(hourly.get("dew_point_2m"), idx) or 0.0)
        rh_raw = _hourly_value(hourly.get("relative_humidity_2m"), idx)
        rh2m = float(rh_raw) if rh_raw is not None else float(_relative_humidity_from_dewpoint_c(temp, dew) or 0.0)
        vpd_raw = _hourly_value(hourly.get("vapour_pressure_deficit"), idx)
        vpd = float(vpd_raw) if vpd_raw is not None else float(_vapour_pressure_deficit_kpa(temp, dew) or 0.0)
        wet_raw = _hourly_value(hourly.get("wet_bulb_temperature_2m"), idx)
        wetbulb = float(wet_raw) if wet_raw is not None else float(_wet_bulb_stull_c(temp, rh2m) or 0.0)
        cin = optional_hourly_float(hourly, ["convective_inhibition", "cin", "cin_jkg"], idx)
        cloud_low_raw = _hourly_value(hourly.get("cloud_cover_low"), idx)
        cloud_mid_raw = _hourly_value(hourly.get("cloud_cover_mid"), idx)
        cloud_high_raw = _hourly_value(hourly.get("cloud_cover_high"), idx)
        cloud_low = float(cloud_low_raw) if cloud_low_raw is not None else 0.0
        cloud_mid = float(cloud_mid_raw) if cloud_mid_raw is not None else 0.0
        cloud_high = float(cloud_high_raw) if cloud_high_raw is not None else 0.0
        gusts = float(_hourly_value(hourly.get("wind_gusts_10m"), idx) or 0.0)
        ws10 = float(_hourly_value(hourly.get("wind_speed_10m"), idx) or 0.0)
        wd10 = float(_hourly_value(hourly.get("wind_direction_10m"), idx) or 0.0)
        surface_convergence = (convergence_by_zone_time or {}).get((point.zone, str(t)))

        trigger, initiation_diag = compute_initiation(
            cape,
            dew,
            rh2m,
            vpd,
            temp,
            wetbulb,
            dt,
            cin_jkg=cin,
            surface_convergence_s1=surface_convergence,
            precipitation_rate_mm_h=precipitation_rate,
            precipitable_water_kg_m2=precipitable_water,
            shortwave_radiation_w_m2=shortwave_radiation,
            wind_gusts_10m_ms=gusts,
            cloud_low=cloud_low if cloud_low_raw is not None else None,
            cloud_mid=cloud_mid if cloud_mid_raw is not None else None,
            cloud_high=cloud_high if cloud_high_raw is not None else None,
        )

        metrics.append(
            {
                "idx": idx,
                "dt": dt,
                "day_key": day_key,
                "cape": cape,
                "precipitation_rate": precipitation_rate,
                "precipitable_water": precipitable_water,
                "shortwave_radiation": shortwave_radiation,
                "temp": temp,
                "dew": dew,
                "rh2m": rh2m,
                "vpd": vpd,
                "wetbulb": wetbulb,
                "cin": cin,
                "cloud_low": cloud_low,
                "cloud_mid": cloud_mid,
                "cloud_high": cloud_high,
                "gusts": gusts,
                "ws10": ws10,
                "wd10": wd10,
                "shear": 0.0,
                "trigger": trigger,
                **initiation_diag,
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
                confidence_score, confidence_diag = compute_signal_confidence(metric, neighbours)
                raw_trigger = clamp(metric["trigger"])
                storm_probability = compute_storm_probability(raw_trigger, confidence_score)
                pot = potentiel(storm_probability)
                conf = confiance_label(confidence_score)
                selected_hour = metric["dt"].strftime("%Hh")
                summary = build_summary(day_label, slot_label, selected_hour, storm_probability, confidence_score)

                metric_scores = {
                    "cape_score": metric["cape_component"],
                    "dewpoint_score": metric["dew_component"],
                    "humidity_score": metric["humidity_component"],
                    "vpd_score": metric["vpd_component"],
                    "wetbulb_score": metric["wetbulb_component"],
                    "precipitable_water_score": metric.get("precipitable_water_component"),
                    "shortwave_radiation_score": metric.get("shortwave_radiation_component"),
                    "surface_heating_score": metric.get("surface_heating_component"),
                    "precipitation_score": metric.get("precipitation_component"),
                    "gust_potential_score": metric.get("gust_potential_component"),
                    "convective_activity_score": metric.get("convective_activity_component"),
                    "environment_score": metric.get("environment_component", 0),
                    "timing_score": metric["timing"],
                    "cin_actual_score": metric.get("cin_actual_component"),
                    "surface_trigger_score": metric.get("surface_trigger_component"),
                    "cloud_trigger_score": metric.get("cloud_trigger_component"),
                    "clear_sky_penalty_score": metric.get("clear_sky_penalty", 0),
                    "confidence_consistency_score": confidence_diag.get("consistency"),
                    "confidence_temporal_score": confidence_diag.get("temporal_stability"),
                    "confidence_margin_score": confidence_diag.get("margin"),
                }
                metrics_used = {
                    "cape_jkg": round(metric["cape"], 1),
                    "temperature_c": round(metric["temp"], 1),
                    "dewpoint_c": round(metric["dew"], 1),
                    "relative_humidity_2m": round(metric["rh2m"], 1),
                    "vapour_pressure_deficit": round(metric["vpd"], 2),
                    "wet_bulb_temperature_2m": round(metric["wetbulb"], 1),
                    "precipitable_water_kg_m2": round_optional(metric.get("precipitable_water"), 1),
                    "shortwave_radiation_w_m2": round_optional(metric.get("shortwave_radiation"), 1),
                    "precipitation_rate_mm_h": round_optional(metric.get("precipitation_rate"), 3),
                    "wind_gusts_10m_ms": round_optional(metric.get("gusts"), 1),
                    "convective_inhibition_jkg": round_optional(metric.get("cin"), 1),
                    "surface_convergence_1e4s": round_optional(metric.get("surface_convergence_1e4s"), 2),
                    "cloud_cover_low": round(metric["cloud_low"], 1),
                    "cloud_cover_mid": round(metric["cloud_mid"], 1),
                    "cloud_cover_high": round(metric["cloud_high"], 1),
                    "convective_cloud_cover": round_optional(metric.get("convective_cloud_cover"), 1),
                    "total_cloud_cover": round_optional(metric.get("total_cloud_cover"), 1),
                }
                category_breakdown = {
                    "probability": {
                        "score": storm_probability,
                        "raw_initiation": metric["trigger"],
                        "environment": metric.get("environment_component"),
                        "instability": metric["instability"],
                        "moisture": metric["moisture"],
                        "precipitable_water": metric.get("precipitable_water_component"),
                        "precipitable_water_kg_m2": metric.get("precipitable_water"),
                        "shortwave_radiation": metric.get("shortwave_radiation_component"),
                        "shortwave_radiation_w_m2": metric.get("shortwave_radiation"),
                        "surface_heating": metric.get("surface_heating_component"),
                        "precipitation": metric.get("precipitation_component"),
                        "precipitation_rate_mm_h": metric.get("precipitation_rate"),
                        "gust_potential": metric.get("gust_potential_component"),
                        "convective_activity": metric.get("convective_activity_component"),
                        "timing": metric["timing"],
                        "inhibition_penalty": metric["inhibition_penalty"],
                        "cin_actual": metric.get("cin_actual_component"),
                        "surface_trigger": metric.get("surface_trigger_component"),
                        "surface_convergence_1e4s": metric.get("surface_convergence_1e4s"),
                        "cloud_support": metric.get("cloud_trigger_component"),
                        "clear_sky_penalty": metric.get("clear_sky_penalty", 0),
                        "convective_cloud_cover": metric.get("convective_cloud_cover"),
                        "total_cloud_cover": metric.get("total_cloud_cover"),
                    },
                    "confidence": {
                        "score": confidence_score,
                        "consistency": confidence_diag.get("consistency"),
                        "temporal_stability": confidence_diag.get("temporal_stability"),
                        "margin": confidence_diag.get("margin"),
                    },
                }
                diagnostics = build_cell_diagnostics(metric, confidence_diag, raw_trigger, confidence_score)

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
                    trigger_score=storm_probability,
                    structure_score=0,
                    chase_quality_score=0,
                    stability_score=confidence_score,
                    confidence_score=confidence_score,
                    score_global=storm_probability,
                    potentiel=pot,
                    confiance=conf,
                    mucape=round(metric["cape"], 1),
                    convective_inhibition=round_optional(metric.get("cin"), 1),
                    relative_humidity_2m=round(metric["rh2m"], 1),
                    vapour_pressure_deficit=round(metric["vpd"], 2),
                    wet_bulb_temperature_2m=round(metric["wetbulb"], 1),
                    precipitable_water=round_optional(metric.get("precipitable_water"), 1),
                    shortwave_radiation=round_optional(metric.get("shortwave_radiation"), 1),
                    precipitation_rate=round_optional(metric.get("precipitation_rate"), 3),
                    cloud_cover_low=round(metric["cloud_low"], 1),
                    cloud_cover_mid=round(metric["cloud_mid"], 1),
                    cloud_cover_high=round(metric["cloud_high"], 1),
                    wind_gusts_10m=round(metric["gusts"], 1),
                    wind_speed_10m=round(metric.get("ws10", 0.0), 1),
                    wind_direction_10m=round(metric.get("wd10", 0.0), 0),
                    surface_convergence_1e4s=round_optional(metric.get("surface_convergence_1e4s"), 2),
                    shear_ms=0.0,
                    temp_c=round(metric["temp"], 1),
                    dewpoint_c=round(metric["dew"], 1),
                    analysis_mode="historical" if point and metric["dt"].date() < local_today() else "forecast",
                    metrics_used=metrics_used,
                    metric_scores=metric_scores,
                    category_breakdown=category_breakdown,
                    diagnostics=diagnostics,
                    summary=summary,
                )

                score_key = storm_probability * 100000 + raw_trigger * 100 + confidence_score
                if score_key > best_score:
                    best_score = score_key
                    best = row

            if best is not None:
                rows.append(best)

    return rows



def _stable_seed(*parts: object) -> int:
    raw = "|".join(str(part) for part in parts)
    total = 0
    for idx, ch in enumerate(raw):
        total = (total * 131 + ord(ch) + idx) % (2 ** 32)
    return total


def _mock_times_for_date(target_date: Date | None) -> list[datetime]:
    base = target_date or local_today()
    tz = ZoneInfo("Europe/Paris")
    return [datetime(base.year, base.month, base.day, hour, 0, tzinfo=tz) for hour in range(24)]


def generate_mock_location(point: Point, target_date: Date | None = None, seed_base: int | None = None) -> dict:
    base_date = target_date or local_today()
    day_seed = seed_base if seed_base is not None else _stable_seed(base_date.isoformat(), round(point.lat, 3), round(point.lon, 3))
    rng = random.Random(day_seed)
    times = _mock_times_for_date(base_date)

    centers = []
    for idx in range(3):
        cx = DEFAULT_CENTER_LAT + rng.uniform(-0.65, 0.65)
        cy = DEFAULT_CENTER_LON + rng.uniform(-0.9, 0.9)
        peak_hour = rng.randint(11, 20)
        spatial_km = rng.uniform(18, 42)
        temporal_h = rng.uniform(1.6, 3.8)
        strength = rng.uniform(0.55, 1.0)
        centers.append((cx, cy, peak_hour, spatial_km, temporal_h, strength))

    def influence(dt: datetime) -> float:
        val = 0.0
        for cx, cy, peak_hour, spatial_km, temporal_h, strength in centers:
            dist = distance_km(point.lat, point.lon, cx, cy)
            spatial = math.exp(-((dist / spatial_km) ** 2))
            temporal = math.exp(-(((dt.hour - peak_hour) / temporal_h) ** 2))
            val = max(val, strength * spatial * temporal)
        return max(0.0, min(1.0, val))

    site_rng = random.Random(_stable_seed("site", point.zone, base_date.isoformat()))
    moisture_bias = site_rng.uniform(-1.6, 1.8)
    temp_bias = site_rng.uniform(-1.3, 1.3)

    hourly = {k: [] for k in HOURLY_VARS}
    hourly['time'] = [dt.isoformat() for dt in times]

    for dt in times:
        diurnal = math.sin(((dt.hour - 6) / 24.0) * math.pi * 2)
        sun = max(0.0, math.sin(((dt.hour - 6) / 12.0) * math.pi))
        storm = influence(dt)
        noise_rng = random.Random(_stable_seed(point.zone, dt.isoformat(), base_date.isoformat()))

        temp = 16.0 + 9.5 * max(0.0, diurnal) + temp_bias + noise_rng.uniform(-0.8, 0.8)
        dew = 7.5 + storm * 10.5 + moisture_bias + noise_rng.uniform(-0.9, 0.9)
        cape = max(0.0, 40.0 + storm * 2400.0 + max(0.0, diurnal) * 350.0 + noise_rng.uniform(-120.0, 120.0))
        rh = _relative_humidity_from_dewpoint_c(temp, dew) or 0.0
        cloud_low = max(0.0, min(100.0, 8.0 + storm * 52.0 + noise_rng.uniform(-8.0, 12.0)))
        cloud_mid = max(0.0, min(100.0, 12.0 + storm * 64.0 + noise_rng.uniform(-10.0, 14.0)))
        cloud_high = max(0.0, min(100.0, 18.0 + storm * 42.0 + noise_rng.uniform(-12.0, 18.0)))
        cloud_block = max(cloud_low * 0.35, cloud_mid * 0.45, cloud_high * 0.20)
        shortwave = max(0.0, sun * 820.0 * (1.0 - min(0.72, cloud_block / 135.0)) + noise_rng.uniform(-18.0, 18.0))
        precipitable_water = max(4.0, 13.0 + storm * 24.0 + max(0.0, moisture_bias) * 1.8 + noise_rng.uniform(-2.0, 2.5))
        precipitation_rate = max(0.0, (storm - 0.56) * 5.2 + noise_rng.uniform(-0.08, 0.16))
        wind_speed = max(0.4, 2.8 + storm * 6.8 + noise_rng.uniform(-0.9, 1.4))
        wind_direction = (205.0 + point.lon * 4.5 + point.lat * 1.7 + dt.hour * 4.0 + noise_rng.uniform(-18.0, 18.0)) % 360.0
        gusts = max(wind_speed, wind_speed + storm * 8.5 + noise_rng.uniform(0.4, 3.8))

        hourly['cape'].append(round(cape, 1))
        hourly['precipitable_water'].append(round(precipitable_water, 1))
        hourly['shortwave_radiation'].append(round(shortwave, 1))
        hourly['precipitation_rate'].append(round(precipitation_rate, 3))
        hourly['relative_humidity_2m'].append(round(rh, 1))
        hourly['wind_speed_10m'].append(round(wind_speed, 1))
        hourly['wind_direction_10m'].append(round(wind_direction, 0))
        hourly['temperature_2m'].append(round(temp, 1))
        hourly['dew_point_2m'].append(round(dew, 1))
        hourly['cloud_cover_low'].append(round(cloud_low, 1))
        hourly['cloud_cover_mid'].append(round(cloud_mid, 1))
        hourly['cloud_cover_high'].append(round(cloud_high, 1))
        hourly['wind_gusts_10m'].append(round(gusts, 1))

    hourly['wind_direction_10m_available'] = [True for _ in times]

    return {
        'latitude': point.lat,
        'longitude': point.lon,
        'generationtime_ms': 0.1,
        'timezone': 'Europe/Paris',
        'elevation': 300,
        'hourly': hourly,
        'models': 'mock_random',
    }


def fetch_mock_model(points: list[Point], target_date: Date | None = None) -> list[OutputRow]:
    locations = [generate_mock_location(point, target_date=target_date) for point in points]
    return rows_for_grid_locations(points, locations)


def fetch_model(points: list[Point], target_date: Date | None = None, mode: str = "auto") -> list[OutputRow]:
    if mode == "mock":
        print(f"mock_random | {len(points)} points | {(target_date or local_today()).isoformat()}")
        return fetch_mock_model(points, target_date=target_date)

    batch_size = batch_size_for_points(points)
    batches = list(chunks(points, batch_size))
    total_batches = len(batches)
    rows: list[OutputRow] = []
    day_mode = target_date.isoformat() if target_date is not None else "jours glissants"
    for batch_index, batch in enumerate(batches, start=1):
        print(f"{FORECAST_MODEL_LABEL if (target_date is None or target_date >= local_today()) else HISTORICAL_MODEL} | lot {batch_index}/{total_batches} | {len(batch)} points | {day_mode}")
        url = build_api_url(batch, target_date=target_date, mode=mode)
        payload = get_json(url)
        structures = location_structures(payload)
        rows.extend(rows_for_grid_locations(batch, structures))
        time.sleep(0.35)
    return rows

def flatten_rows_for_analysis(rows: list[OutputRow]) -> list[dict]:
    flattened: list[dict] = []
    for row in rows:
        entry = cell_payload_for_output(row)
        entry["analysis_rank"] = round(row.trigger_score, 1)
        flattened.append(entry)
    return flattened


def build_historical_analysis_payload(rows: list[OutputRow], center_lat: float, center_lon: float, center_label: str, target_date: Date | None) -> dict:
    flattened = flatten_rows_for_analysis(rows)
    days = sorted({row.day_key for row in rows})
    slots = sorted({row.slot_key for row in rows})
    top_cells = sorted(flattened, key=lambda cell: (cell["analysis_rank"], cell["trigger_score"]), reverse=True)[:30]
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
                    "goal": "Comparer la probabilité orageuse et sa confiance à des observations orageuses réelles sur une base historique.",
                    "probability_score": "Score principal 0-100 piloté par CAPE, point de rosée, humidité basse couche, VPD, bulbe humide, vapeur colonne, rayonnement, activité AROME et déclencheur de surface quand disponible.",
                    "confidence_score": "Cohérence des ingrédients et stabilité du signal autour de l'heure retenue.",
                    "recommended_join_key": "selected_time_iso + lat/lon ou zone pour recroiser avec éclairs, radar ou observations terrain.",
                },
        },
        "top_cells": top_cells,
        "rows": flattened,
    }



def cell_payload_for_output(row: OutputRow) -> dict:
    cell = asdict(row)
    for obsolete_key in (
        "structure_score",
        "chase_quality_score",
        "stability_score",
        "score_global",
    ):
        cell.pop(obsolete_key, None)
    return cell


def group_for_output(rows: list[OutputRow], center_lat: float, center_lon: float, center_label: str, target_date: Date | None = None, model_name: str | None = None) -> dict:
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
        slot["cells"].append(cell_payload_for_output(row))

    days = []
    for _, day in sorted(days_map.items(), key=lambda kv: kv[1]["day_index"]):
        slots = []
        for slot_key, _, _, _ in TIME_SLOTS:
            if slot_key in day["slots"]:
                slot = day["slots"][slot_key]
                cells = slot["cells"]
                max_score = max(cell["trigger_score"] for cell in cells) if cells else 0
                mean_score = round(sum(cell["trigger_score"] for cell in cells) / len(cells)) if cells else 0
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
            "model": model_name or (forecast_model_label_for_meta(target_date) if (target_date is None or target_date >= local_today()) else HISTORICAL_MODEL),
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
                "trigger": "Probabilité orage : CAPE, point de rosée, humidité recalculée, VPD, bulbe humide, vapeur colonne, insolation et déclencheur de surface quand disponible. La nébulosité est un contexte, pas un verrou.",
                "confidence": "Confiance : cohérence des ingrédients et stabilité du signal autour de l'heure retenue.",
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
        subset.sort(key=lambda r: (r.trigger_score, r.confidence_score), reverse=True)
        print(f"\n=== {day_label} | {slot_label} ===")
        for r in subset[:5]:
            print(
                f"- {r.zone} | {r.selected_hour} | proba {r.trigger_score} | confiance {r.confidence_score}"
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
    print("Note : sortie JSON horaire sur 24 boutons, pensée pour un usage terrain sur WebApp.")


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
    mode: str = "auto",
) -> dict:
    points = build_grid(center_lat=center_lat, center_lon=center_lon, zone_prefix=center_label)
    rows = fetch_model(points, target_date=target_date, mode=mode)
    model_name = model_name_for_request(target_date, mode)
    payload = group_for_output(rows, center_lat, center_lon, center_label, target_date=target_date, model_name=model_name)
    if mode == "mock":
        payload.setdefault("meta", {})["warning"] = "Mode mock aléatoire activé : données synthétiques, pas de source Open-Meteo."
        payload["meta"]["analysis_type"] = "mock"
    return payload
