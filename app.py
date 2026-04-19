from __future__ import annotations

import asyncio
import math
import mimetypes
import time
from datetime import date as Date
from pathlib import Path
from typing import Any

from fastapi import FastAPI, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, PlainTextResponse
from fastapi.staticfiles import StaticFiles

from weather_logic import DEFAULT_CENTER_LABEL, build_historical_analysis_payload, build_latest_payload, build_grid, fetch_model, flatten_rows_for_analysis

BASE_DIR = Path(__file__).resolve().parent
STATIC_DIR = BASE_DIR / "static"
ASSETS_DIR = STATIC_DIR / "assets"
JS_DIR = ASSETS_DIR / "js"
CSS_DIR = ASSETS_DIR / "css"

mimetypes.add_type("application/javascript", ".js")
mimetypes.add_type("text/css", ".css")
mimetypes.add_type("image/svg+xml", ".svg")
mimetypes.add_type("application/manifest+json", ".webmanifest")
CACHE_TTL_SECONDS = 60 * 60
STALE_TTL_SECONDS = 2 * 60 * 60

app = FastAPI(title="ObjectiFoudre", version="1.0.2")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=False,
    allow_methods=["GET"],
    allow_headers=["*"],
)
app.mount("/static", StaticFiles(directory=str(STATIC_DIR)), name="static")

_cache: dict[str, dict[str, Any]] = {}
_inflight: dict[str, asyncio.Task] = {}
_lock = asyncio.Lock()


def _cache_key(lat: float, lon: float, target_date: Date | None) -> str:
    date_key = target_date.isoformat() if target_date is not None else "auto"
    return f"{lat:.2f}:{lon:.2f}:{date_key}"


def _latest_cache_key(lat: float, lon: float, target_date: Date | None, mode: str) -> str:
    return f"latest:{_cache_key(lat, lon, target_date)}:{mode}"


def _historical_cache_key(lat: float, lon: float, target_date: Date, label: str, mode: str, zone: str | None = None, slot: str | None = None) -> str:
    suffix = []
    if zone:
        suffix.append(f"zone={zone}")
    if slot:
        suffix.append(f"slot={slot}")
    suffix_key = ":".join(suffix) if suffix else "all"
    return f"historical:{_cache_key(lat, lon, target_date)}:{label}:{mode}:{suffix_key}"


def _cache_fresh(entry: dict[str, Any] | None, ttl: int = CACHE_TTL_SECONDS) -> bool:
    if entry is None:
        return False
    return (time.time() - float(entry["ts"])) < ttl


def _merge_label(payload: dict[str, Any], label: str) -> dict[str, Any]:
    out = dict(payload)
    meta = dict(out.get("meta", {}))
    center = dict(meta.get("center", {}))
    center["label"] = label
    meta["center"] = center
    out["meta"] = meta
    return out


def _stale_payload(entry: dict[str, Any], label: str, warning: str) -> dict[str, Any]:
    stale = _merge_label(entry["payload"], label)
    meta = dict(stale.get("meta", {}))
    meta["warning"] = warning
    meta["stale"] = True
    meta["cached_at_epoch"] = entry["ts"]
    stale["meta"] = meta
    return stale


def _with_cache_meta(payload: dict[str, Any], *, hit: bool, created_at: float | None = None, ttl: int = CACHE_TTL_SECONDS, backend: str = "memory") -> dict[str, Any]:
    out = dict(payload)
    meta = dict(out.get("meta", {}))
    cache_meta = dict(meta.get("cache", {}))
    now = time.time()
    cache_meta["backend"] = backend
    cache_meta["hit"] = hit
    cache_meta["ttl_seconds"] = ttl
    if created_at is not None:
        age = max(0, int(now - created_at))
        cache_meta["created_at_epoch"] = created_at
        cache_meta["age_seconds"] = age
        cache_meta["expires_in_seconds"] = max(0, ttl - age)
    else:
        cache_meta["created_at_epoch"] = now
        cache_meta["age_seconds"] = 0
        cache_meta["expires_in_seconds"] = ttl
    meta["cache"] = cache_meta
    out["meta"] = meta
    return out


def _distance_km(a_lat: float, a_lon: float, b_lat: float, b_lon: float) -> float:
    dx = (a_lon - b_lon) * 111.0 * math.cos(math.radians((a_lat + b_lat) / 2))
    dy = (a_lat - b_lat) * 111.0
    return math.hypot(dx, dy)


def _nearest_recent_cache(lat: float, lon: float, target_date: Date | None, ttl: int = STALE_TTL_SECONDS, max_distance_km: float = 80.0):
    now = time.time()
    best = None
    best_dist = None
    target_date_key = target_date.isoformat() if target_date is not None else "auto"
    for key, entry in _cache.items():
        if (now - float(entry["ts"])) >= ttl:
            continue
        try:
            parts = key.split(":")
            if len(parts) < 3:
                continue
            e_lat_s, e_lon_s, e_date_key = parts[:3]
            e_lat = float(e_lat_s)
            e_lon = float(e_lon_s)
        except Exception:
            continue
        if e_date_key != target_date_key:
            continue
        dist = _distance_km(lat, lon, e_lat, e_lon)
        if dist > max_distance_km:
            continue
        if best is None or dist < best_dist:
            best = entry
            best_dist = dist
    return best, best_dist


async def _build_payload(lat: float, lon: float, label: str, target_date: Date | None, mode: str = "auto") -> dict[str, Any]:
    payload = await asyncio.to_thread(build_latest_payload, lat, lon, label, target_date, mode)
    return _merge_label(payload, label)


def _csv_escape(value: Any) -> str:
    text = "" if value is None else str(value)
    if any(ch in text for ch in [',', '"', '\n']):
        text = '"' + text.replace('"', '""') + '"'
    return text


def _analysis_rows(lat: float, lon: float, label: str, target_date: Date | None, zone: str | None = None, slot: str | None = None, mode: str = "historical") -> list[dict[str, Any]]:
    points = build_grid(center_lat=lat, center_lon=lon, zone_prefix=label)
    rows = fetch_model(points, target_date=target_date, mode=mode)
    flattened = flatten_rows_for_analysis(rows)
    if zone:
        flattened = [row for row in flattened if str(row.get("zone")) == zone]
    if slot:
        flattened = [row for row in flattened if str(row.get("slot_key")) == slot]
    return flattened


def _get_cached_value(key: str, ttl: int = CACHE_TTL_SECONDS) -> dict[str, Any] | None:
    entry = _cache.get(key)
    if _cache_fresh(entry, ttl=ttl):
        return entry
    return None


def _set_cached_value(key: str, payload: Any) -> dict[str, Any]:
    entry = {"ts": time.time(), "payload": payload}
    _cache[key] = entry
    return entry


def _purge_expired_cache(now: float | None = None) -> None:
    current = now or time.time()
    expired = [key for key, entry in _cache.items() if (current - float(entry.get("ts", 0))) >= STALE_TTL_SECONDS]
    for key in expired:
        _cache.pop(key, None)


def _analysis_csv(rows: list[dict[str, Any]]) -> str:
    base_fields = [
        'day_key','day_label','slot_key','slot_label','selected_time_iso','selected_hour','zone','lat','lon',
        'score_global','trigger_score','structure_score','chase_quality_score','stability_score','confidence_score',
        'potentiel','confiance','analysis_rank','mucape','relative_humidity_2m','vapour_pressure_deficit',
        'wet_bulb_temperature_2m','cloud_cover_low','cloud_cover_mid','cloud_cover_high','wind_gusts_10m','shear_ms',
        'temp_c','dewpoint_c','analysis_mode','summary'
    ]
    metric_score_fields = ['cape_score','dewpoint_score','humidity_score','vpd_score','wetbulb_score','timing_score','shear_score','gust_score','cloud_score']
    breakdown_fields = [
        'initiation_instability','initiation_moisture','initiation_timing','initiation_inhibition_penalty',
        'severity_updraft','severity_organization','severity_maintenance',
        'chaseability_visibility','chaseability_photogenicity','chaseability_comfort',
        'reliability_consistency','reliability_stability','reliability_confidence_margin'
    ]
    header = base_fields + metric_score_fields + breakdown_fields + ['diagnostics']
    lines = [','.join(header)]
    for row in rows:
        metric_scores = row.get('metric_scores', {})
        breakdown = row.get('category_breakdown', {})
        mapped = {
            'initiation_instability': breakdown.get('initiation', {}).get('instability', ''),
            'initiation_moisture': breakdown.get('initiation', {}).get('moisture', ''),
            'initiation_timing': breakdown.get('initiation', {}).get('timing', ''),
            'initiation_inhibition_penalty': breakdown.get('initiation', {}).get('inhibition_penalty', ''),
            'severity_updraft': breakdown.get('severity', {}).get('updraft', ''),
            'severity_organization': breakdown.get('severity', {}).get('organization', ''),
            'severity_maintenance': breakdown.get('severity', {}).get('maintenance', ''),
            'chaseability_visibility': breakdown.get('chaseability', {}).get('visibility', ''),
            'chaseability_photogenicity': breakdown.get('chaseability', {}).get('photogenicity', ''),
            'chaseability_comfort': breakdown.get('chaseability', {}).get('comfort', ''),
            'reliability_consistency': breakdown.get('reliability', {}).get('consistency', ''),
            'reliability_stability': breakdown.get('reliability', {}).get('stability', ''),
            'reliability_confidence_margin': breakdown.get('reliability', {}).get('confidence_margin', ''),
        }
        output = []
        for field in base_fields:
            output.append(_csv_escape(row.get(field, '')))
        for field in metric_score_fields:
            output.append(_csv_escape(metric_scores.get(field, '')))
        for field in breakdown_fields:
            output.append(_csv_escape(mapped.get(field, '')))
        output.append(_csv_escape(' | '.join(row.get('diagnostics', []))))
        lines.append(','.join(output))
    return '\n'.join(lines)


@app.get("/assets/js/{filename:path}")
def asset_js(filename: str) -> FileResponse:
    target = (JS_DIR / filename).resolve()
    if not target.is_file() or JS_DIR.resolve() not in target.parents:
        raise HTTPException(status_code=404, detail="JavaScript asset not found")
    return FileResponse(target, media_type="application/javascript", headers={"Cache-Control": "public, max-age=300"})


@app.get("/assets/css/{filename:path}")
def asset_css(filename: str) -> FileResponse:
    target = (CSS_DIR / filename).resolve()
    if not target.is_file() or CSS_DIR.resolve() not in target.parents:
        raise HTTPException(status_code=404, detail="Stylesheet not found")
    return FileResponse(target, media_type="text/css", headers={"Cache-Control": "public, max-age=300"})


@app.get("/logo-objectif-foudre.svg")
def logo_svg() -> FileResponse:
    target = STATIC_DIR / "logo-objectif-foudre.svg"
    return FileResponse(target, media_type="image/svg+xml", headers={"Cache-Control": "public, max-age=300"})


@app.get("/manifest.webmanifest")
def manifest() -> FileResponse:
    target = STATIC_DIR / "storm-chase.webmanifest"
    return FileResponse(target, media_type="application/manifest+json", headers={"Cache-Control": "no-store, max-age=0"})


@app.get("/api/health")
def health() -> dict[str, str]:
    return {"status": "ok"}


@app.get("/sw.js")
def service_worker() -> FileResponse:
    return FileResponse(STATIC_DIR / "sw.js", media_type="application/javascript", headers={"Cache-Control": "no-store, max-age=0"})


@app.get("/favicon.ico")
def favicon() -> FileResponse:
    icon = STATIC_DIR / "icons" / "icon-192.png"
    return FileResponse(icon, media_type="image/png")


@app.get("/api/latest")
async def latest(
    lat: float = Query(45.7640, ge=-90, le=90),
    lon: float = Query(4.8357, ge=-180, le=180),
    label: str = Query(DEFAULT_CENTER_LABEL, min_length=1, max_length=120),
    date: Date | None = Query(None),
    force: bool = False,
    mode: str = Query("auto", pattern="^(auto|forecast|historical|mock)$"),
) -> dict:
    _purge_expired_cache()
    key = _latest_cache_key(lat, lon, date, mode)
    cached = _get_cached_value(key)
    if not force and cached is not None:
        payload = _merge_label(cached["payload"], label)
        return _with_cache_meta(payload, hit=True, created_at=cached["ts"])

    async with _lock:
        cached = _get_cached_value(key)
        if not force and cached is not None:
            payload = _merge_label(cached["payload"], label)
            return _with_cache_meta(payload, hit=True, created_at=cached["ts"])

        task = _inflight.get(key)
        if task is None or task.done():
            task = asyncio.create_task(_build_payload(lat, lon, label, date, mode))
            _inflight[key] = task

    try:
        payload = await task
    except Exception as exc:
        async with _lock:
            if _inflight.get(key) is task:
                _inflight.pop(key, None)

        cached = _cache.get(key)
        if cached is not None and _cache_fresh(cached, ttl=STALE_TTL_SECONDS):
            stale_payload = _stale_payload(
                cached,
                label=label,
                warning=f"Données mises en cache utilisées après erreur de rafraîchissement: {exc}",
            )
            return _with_cache_meta(stale_payload, hit=True, created_at=cached["ts"], ttl=STALE_TTL_SECONDS)

        nearby, dist = _nearest_recent_cache(lat, lon, date)
        if nearby is not None:
            stale_payload = _stale_payload(
                nearby,
                label=label,
                warning=f"Données de secours d'une zone voisine (~{round(dist)} km) utilisées après erreur de rafraîchissement: {exc}",
            )
            return _with_cache_meta(stale_payload, hit=True, created_at=nearby["ts"], ttl=STALE_TTL_SECONDS)

        try:
            mock_payload = await asyncio.to_thread(build_latest_payload, lat, lon, label, date, "mock")
            meta = dict(mock_payload.get("meta", {}))
            meta["warning"] = f"Mode mock aléatoire activé après erreur Open-Meteo: {exc}"
            mock_payload["meta"] = meta
            return _with_cache_meta(mock_payload, hit=False)
        except Exception:
            pass

        raise HTTPException(status_code=502, detail=f"Weather refresh failed: {exc}")
    else:
        async with _lock:
            entry = _set_cached_value(key, payload)
            if _inflight.get(key) is task:
                _inflight.pop(key, None)
        merged = _merge_label(payload, label)
        return _with_cache_meta(merged, hit=False, created_at=entry["ts"])


@app.get("/api/historical-analysis")
async def historical_analysis(
    lat: float = Query(45.7640, ge=-90, le=90),
    lon: float = Query(4.8357, ge=-180, le=180),
    label: str = Query(DEFAULT_CENTER_LABEL, min_length=1, max_length=120),
    date: Date = Query(...),
    mode: str = Query("historical", pattern="^(historical|mock)$"),
    force: bool = False,
) -> dict:
    _purge_expired_cache()
    key = _historical_cache_key(lat, lon, date, label, mode)
    cached = _get_cached_value(key)
    if not force and cached is not None:
        return _with_cache_meta(cached["payload"], hit=True, created_at=cached["ts"])

    points = build_grid(center_lat=lat, center_lon=lon, zone_prefix=label)
    rows = await asyncio.to_thread(fetch_model, points, date, mode)
    payload = build_historical_analysis_payload(rows, lat, lon, label, date)
    if mode == "mock":
        payload.setdefault("meta", {})["warning"] = "Analyse mock aléatoire : données synthétiques, pas d'observation Open-Meteo."
    entry = _set_cached_value(key, payload)
    return _with_cache_meta(payload, hit=False, created_at=entry["ts"])


@app.get("/api/historical-analysis.csv")
async def historical_analysis_csv(
    lat: float = Query(45.7640, ge=-90, le=90),
    lon: float = Query(4.8357, ge=-180, le=180),
    label: str = Query(DEFAULT_CENTER_LABEL, min_length=1, max_length=120),
    date: Date = Query(...),
    zone: str | None = Query(None),
    slot: str | None = Query(None),
    mode: str = Query("historical", pattern="^(historical|mock)$"),
    force: bool = False,
) -> PlainTextResponse:
    _purge_expired_cache()
    key = _historical_cache_key(lat, lon, date, label, mode, zone=zone, slot=slot)
    cached = _get_cached_value(key)
    if not force and cached is not None:
        rows = cached["payload"]
    else:
        rows = await asyncio.to_thread(_analysis_rows, lat, lon, label, date, zone, slot, mode)
        _set_cached_value(key, rows)
    csv_text = _analysis_csv(rows)
    suffix = ""
    if zone:
        suffix += f"-{zone}"
    if slot:
        suffix += f"-{slot}"
    filename = f"objectifoudre-historical-{date.isoformat()}{suffix}.csv"
    headers = {"Content-Disposition": f'attachment; filename="{filename}"'}
    return PlainTextResponse(csv_text, media_type="text/csv; charset=utf-8", headers=headers)


@app.get("/")
def index() -> FileResponse:
    return FileResponse(STATIC_DIR / "index.html", headers={"Cache-Control": "no-store, max-age=0"})
