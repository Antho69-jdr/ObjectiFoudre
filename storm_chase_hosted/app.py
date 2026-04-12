from __future__ import annotations

import asyncio
import math
import time
from pathlib import Path
from typing import Any

from fastapi import FastAPI, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

from weather_logic import DEFAULT_CENTER_LABEL, build_latest_payload

BASE_DIR = Path(__file__).resolve().parent
STATIC_DIR = BASE_DIR / "static"
CACHE_TTL_SECONDS = 15 * 60
STALE_TTL_SECONDS = 2 * 60 * 60

app = FastAPI(title="Storm Chase", version="1.3.0")
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


def _cache_key(lat: float, lon: float) -> str:
    return f"{lat:.2f}:{lon:.2f}"


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


def _distance_km(a_lat: float, a_lon: float, b_lat: float, b_lon: float) -> float:
    dx = (a_lon - b_lon) * 111.0 * math.cos(math.radians((a_lat + b_lat) / 2))
    dy = (a_lat - b_lat) * 111.0
    return math.hypot(dx, dy)


def _nearest_recent_cache(lat: float, lon: float, ttl: int = STALE_TTL_SECONDS, max_distance_km: float = 80.0):
    now = time.time()
    best = None
    best_dist = None
    for key, entry in _cache.items():
        if (now - float(entry["ts"])) >= ttl:
            continue
        try:
            e_lat_s, e_lon_s = key.split(":")
            e_lat = float(e_lat_s)
            e_lon = float(e_lon_s)
        except Exception:
            continue
        dist = _distance_km(lat, lon, e_lat, e_lon)
        if dist > max_distance_km:
            continue
        if best is None or dist < best_dist:
            best = entry
            best_dist = dist
    return best, best_dist


async def _build_payload(lat: float, lon: float, label: str) -> dict[str, Any]:
    payload = await asyncio.to_thread(build_latest_payload, lat, lon, label)
    return _merge_label(payload, label)


@app.get("/api/health")
def health() -> dict[str, str]:
    return {"status": "ok"}


@app.get("/sw.js")
def service_worker() -> FileResponse:
    return FileResponse(STATIC_DIR / "sw.js", media_type="application/javascript")


@app.get("/favicon.ico")
def favicon() -> FileResponse:
    icon = STATIC_DIR / "icons" / "icon-192.png"
    return FileResponse(icon, media_type="image/png")


@app.get("/api/latest")
async def latest(
    lat: float = Query(45.7640, ge=-90, le=90),
    lon: float = Query(4.8357, ge=-180, le=180),
    label: str = Query(DEFAULT_CENTER_LABEL, min_length=1, max_length=120),
    force: bool = False,
) -> dict:
    key = _cache_key(lat, lon)
    cached = _cache.get(key)
    if not force and _cache_fresh(cached):
        return _merge_label(cached["payload"], label)

    async with _lock:
        cached = _cache.get(key)
        if not force and _cache_fresh(cached):
            return _merge_label(cached["payload"], label)

        task = _inflight.get(key)
        if task is None or task.done():
            task = asyncio.create_task(_build_payload(lat, lon, label))
            _inflight[key] = task

    try:
        payload = await task
    except Exception as exc:
        async with _lock:
            if _inflight.get(key) is task:
                _inflight.pop(key, None)

        cached = _cache.get(key)
        if cached is not None and _cache_fresh(cached, ttl=STALE_TTL_SECONDS):
            return _stale_payload(
                cached,
                label=label,
                warning=f"Données mises en cache utilisées après erreur de rafraîchissement: {exc}",
            )

        nearby, dist = _nearest_recent_cache(lat, lon)
        if nearby is not None:
            return _stale_payload(
                nearby,
                label=label,
                warning=f"Données de secours d'une zone voisine (~{round(dist)} km) utilisées après erreur de rafraîchissement: {exc}",
            )

        raise HTTPException(status_code=502, detail=f"Weather refresh failed: {exc}")
    else:
        async with _lock:
            _cache[key] = {"ts": time.time(), "payload": payload}
            if _inflight.get(key) is task:
                _inflight.pop(key, None)
        return _merge_label(payload, label)


@app.get("/")
def index() -> FileResponse:
    return FileResponse(STATIC_DIR / "index.html")
