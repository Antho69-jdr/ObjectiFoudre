from __future__ import annotations

import asyncio
import base64
import concurrent.futures
import contextlib
import contextvars
import copy
import gzip
import multiprocessing
import hashlib
import http.client
import importlib
import importlib.util
import json
import math
import mimetypes
import os
import io
import functools
import re
import shutil
import struct
import sys
import tempfile
import threading
import zipfile
import time
import unicodedata
import urllib.error
import urllib.parse
import urllib.request
import xml.etree.ElementTree as ET
import zlib
from array import array
from datetime import date as Date
from datetime import datetime, time as Time, timezone
from datetime import timedelta
from pathlib import Path
from typing import Any, Callable, Literal
from zoneinfo import ZoneInfo

from fastapi import BackgroundTasks, FastAPI, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware
from starlette.middleware.gzip import GZipMiddleware
from fastapi.responses import FileResponse, JSONResponse, PlainTextResponse, Response
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

from weather_logic import DEFAULT_CENTER_LABEL, CELL_SIZE_KM, Point, build_historical_analysis_payload, build_latest_payload, build_grid, fetch_model, flatten_rows_for_analysis, group_for_output, km_to_deg_lat, km_to_deg_lon, rows_for_grid_locations
import weather_logic
import verification
import learning
try:
    import wcs_client  # client WCS GetCoverage (CIN/MLCAPE/cisaillement) — enrichissement non-fatal
except Exception:  # pragma: no cover - eccodes/deps absents -> enrichissement simplement désactivé
    wcs_client = None

BASE_DIR = Path(__file__).resolve().parent
STATIC_DIR = BASE_DIR / "static"
ASSETS_DIR = STATIC_DIR / "assets"
JS_DIR = ASSETS_DIR / "js"
CSS_DIR = ASSETS_DIR / "css"
VENDOR_DIR = ASSETS_DIR / "vendor"
DIST_DIR = ASSETS_DIR / "dist"
LOCAL_ECCODES_DEFINITION_PATH = BASE_DIR / ".cache" / "eccodes-definition-path" / "ECCODES_DEFINITION_PATH"
APP_VERSION = "1.2.230"


def _env_flag(name: str, default: bool = False) -> bool:
    raw = os.environ.get(name)
    if raw is None:
        return default
    return raw.strip().lower() in {"1", "true", "yes", "on"}


def _env_int(name: str, default: int, *, min_value: int | None = None, max_value: int | None = None) -> int:
    raw = os.environ.get(name)
    try:
        value = int(raw) if raw is not None and raw.strip() else int(default)
    except (TypeError, ValueError):
        value = int(default)
    if min_value is not None:
        value = max(min_value, value)
    if max_value is not None:
        value = min(max_value, value)
    return value


def _env_float(name: str, default: float, *, min_value: float | None = None, max_value: float | None = None) -> float:
    raw = os.environ.get(name)
    try:
        value = float(raw) if raw is not None and raw.strip() else float(default)
    except (TypeError, ValueError):
        value = float(default)
    if min_value is not None:
        value = max(min_value, value)
    if max_value is not None:
        value = min(max_value, value)
    return value


def _configure_local_eccodes_definition_path() -> str | None:
    if os.environ.get("ECCODES_DEFINITION_PATH"):
        return os.environ["ECCODES_DEFINITION_PATH"]
    if not LOCAL_ECCODES_DEFINITION_PATH.is_dir():
        return None
    default_path = "/MEMFS/definitions"
    definition_path = f"{LOCAL_ECCODES_DEFINITION_PATH}:{default_path}"
    os.environ["ECCODES_DEFINITION_PATH"] = definition_path
    return definition_path


_configure_local_eccodes_definition_path()

mimetypes.add_type("application/javascript", ".js")
mimetypes.add_type("text/css", ".css")
mimetypes.add_type("image/svg+xml", ".svg")
mimetypes.add_type("application/manifest+json", ".webmanifest")
CACHE_TTL_SECONDS = 60 * 60
STALE_TTL_SECONDS = 2 * 60 * 60
METEOFRANCE_AROME_WMS_CAPABILITIES_URL = (
    "https://public-api.meteofrance.fr/public/arome/1.0/wms/"
    "MF-NWP-HIGHRES-AROME-001-FRANCE-WMS/GetCapabilities"
    "?service=WMS&version=1.3.0&language=fre"
)
METEOFRANCE_AROME_WCS_CAPABILITIES_URL = (
    "https://public-api.meteofrance.fr/public/arome/1.0/wcs/"
    "MF-NWP-HIGHRES-AROME-001-FRANCE-WCS/GetCapabilities"
    "?service=WCS&version=2.0.1&language=fre"
)
METEOFRANCE_AROME_WCS_DESCRIBE_URL = (
    "https://public-api.meteofrance.fr/public/arome/1.0/wcs/"
    "MF-NWP-HIGHRES-AROME-001-FRANCE-WCS/DescribeCoverage"
)
METEOFRANCE_AROME_WCS_COVERAGE_URL = (
    "https://public-api.meteofrance.fr/public/arome/1.0/wcs/"
    "MF-NWP-HIGHRES-AROME-001-FRANCE-WCS/GetCoverage"
)
METEOFRANCE_TEST_TIMEOUT_SECONDS = 12
METEOFRANCE_WCS_READ_LIMIT_BYTES = 2_500_000
METEOFRANCE_COVERAGE_READ_LIMIT_BYTES = 5_000_000
METEOFRANCE_MODEL_PACKAGE_READ_LIMIT_BYTES = 1_000_000
METEOFRANCE_MODEL_PACKAGE_PROBE_RANGE_BYTES = 65_536
METEOFRANCE_MODEL_PACKAGE_FULL_PROBE_LIMIT_BYTES = 120_000_000
METEOFRANCE_METADATA_CACHE_TTL_SECONDS = 20 * 60
METEOFRANCE_SLOT_GRID_CACHE_TTL_SECONDS = 20 * 60
METEOFRANCE_PACKAGE_JSON_CACHE_TTL_SECONDS = 3 * 60 * 60
# Un run AROME encore en cours de publication n'expose pas tous ses groupes horaires.
# On ne fige PAS sa liste 3 h (sinon les heures longue échéance restent bloquées sur le
# run précédent) : TTL court tant que le run est partiel, puis 3 h une fois complet.
METEOFRANCE_PACKAGE_JSON_PARTIAL_RUN_CACHE_TTL_SECONDS = _env_int(
    "OBJECTIFOUDRE_PACKAGE_JSON_PARTIAL_TTL_SECONDS", 5 * 60, min_value=60, max_value=3 * 60 * 60
)
METEOFRANCE_PACKAGE_JSON_STALE_TTL_SECONDS = 24 * 60 * 60
METEOFRANCE_GRIB_SLOT_GRID_CACHE_TTL_SECONDS = 6 * 60 * 60
METEOFRANCE_GRIB_PROFILE_CACHE_TTL_SECONDS = 6 * 60 * 60
METEOFRANCE_GRIB_TARGET_CACHE_TTL_SECONDS = 6 * 60 * 60
METEOFRANCE_GRIB_INDEX_CACHE_TTL_SECONDS = 24 * 60 * 60
METEOFRANCE_GRIB_MESSAGE_CACHE_TTL_SECONDS = 24 * 60 * 60
METEOFRANCE_GRIB_FULL_PACKAGE_CACHE_TTL_SECONDS = 24 * 60 * 60
METEOFRANCE_GRIB_NATIONAL_FIELD_CACHE_TTL_SECONDS = 24 * 60 * 60
METEOFRANCE_QUOTA_COOLDOWN_SECONDS = 5 * 60
METEOFRANCE_EXTERNAL_REQUEST_MIN_INTERVAL_SECONDS = _env_float(
    "OBJECTIFOUDRE_METEOFRANCE_REQUEST_MIN_INTERVAL_SECONDS",
    6.0,
    min_value=0.0,
    max_value=30.0,
)
METEOFRANCE_EXTERNAL_RETRY_BASE_DELAY_SECONDS = _env_float(
    "OBJECTIFOUDRE_METEOFRANCE_RETRY_BASE_DELAY_SECONDS",
    1.0,
    min_value=0.0,
    max_value=20.0,
)
METEOFRANCE_GRIB_PACKAGE_QUOTA_SCOPE = "grib-package"
METEOFRANCE_GRIB_AUTO_PRELOAD_MAX_HOURS = 8
METEOFRANCE_GRIB_AUTO_PRELOAD_JOB_TTL_SECONDS = 10 * 60
METEOFRANCE_GRIB_SLOT_GRID_ALGORITHM_VERSION = "france-grid-sampling-v46-blh-smart-run-window24"
METEOFRANCE_GRIB_RUN_SELECTION_MAX_RUNS = 24
METEOFRANCE_PRECIPITATION_ENRICHMENT_FIELD = "precipitation_rate"
METEOFRANCE_PRECIPITATION_ENRICHMENT_MAX_HOURS = 0
METEOFRANCE_PRECIPITATION_ENRICHMENT_TRIGGER_THRESHOLD = 45
METEOFRANCE_GRIB_NATIONAL_FIELD_ALGORITHM_VERSION = "float32-zlib-v1"
METEOFRANCE_GRIB_USE_NATIONAL_FIELD_REGISTRY = _env_flag("OBJECTIFOUDRE_GRIB_NATIONAL_FIELD_REGISTRY", True)
METEOFRANCE_GRIB_FULL_PACKAGE_CACHE_ENABLED = _env_flag("OBJECTIFOUDRE_GRIB_FULL_PACKAGE_CACHE", True)
METEOFRANCE_GRIB_PACKAGE_ONLY_NATIONAL_PRELOAD = _env_flag("OBJECTIFOUDRE_GRIB_PACKAGE_ONLY_NATIONAL_PRELOAD", True)
METEOFRANCE_PERSISTENT_CACHE_DIR = Path(
    os.environ.get("OBJECTIFOUDRE_CACHE_DIR")
    or os.environ.get("METEOFRANCE_CACHE_DIR")
    or BASE_DIR / ".cache" / "meteofrance"
).expanduser()
OBJECTIFOUDRE_SERVER_TIMEZONE = ZoneInfo(os.environ.get("OBJECTIFOUDRE_TIMEZONE", "Europe/Paris"))
# --- Historique de grille : archive durable hors du cache TTL ------------------
OBJECTIFOUDRE_HISTORY_ENABLED = _env_flag("OBJECTIFOUDRE_HISTORY_ENABLED", True)
OBJECTIFOUDRE_HISTORY_DIR = Path(
    os.environ.get("OBJECTIFOUDRE_HISTORY_DIR")
    or BASE_DIR / "history"
).expanduser()
OBJECTIFOUDRE_HISTORY_RETENTION_DAYS = _env_int("OBJECTIFOUDRE_HISTORY_RETENTION_DAYS", 180, min_value=1)
# --- Vérification prévision vs réalité (Phase 3) : foudre MTG-LI / EUMETSAT ----
# Identifiants EUMDAC (compte EUMETSAT gratuit). À renseigner pour activer la
# collecte ; le scoring et l'archive fonctionnent sans (ex. archive injectée).
EUMETSAT_CONSUMER_KEY = os.environ.get("EUMETSAT_CONSUMER_KEY") or os.environ.get("EUMDAC_KEY") or None
EUMETSAT_CONSUMER_SECRET = os.environ.get("EUMETSAT_CONSUMER_SECRET") or os.environ.get("EUMDAC_SECRET") or None
# bbox France métropolitaine (mêmes bornes que la grille France)
FRANCE_LIGHTNING_BBOX = (-5.55, 41.05, 9.75, 51.45)  # west, south, east, north
# Automatisation : collecte quotidienne de la foudre des journées écoulées.
OBJECTIFOUDRE_LIGHTNING_AUTOMATION = _env_flag("OBJECTIFOUDRE_LIGHTNING_AUTOMATION", True)
OBJECTIFOUDRE_LIGHTNING_AUTOMATION_INTERVAL_SECONDS = _env_int(
    "OBJECTIFOUDRE_LIGHTNING_AUTOMATION_INTERVAL_SECONDS", 6 * 3600, min_value=900
)
OBJECTIFOUDRE_AUTO_PRELOAD_INTERVAL_SECONDS = _env_int("OBJECTIFOUDRE_AUTO_PRELOAD_INTERVAL_SECONDS", 5 * 60, min_value=60)
OBJECTIFOUDRE_AROME_RUN_UPDATE_INTERVAL_SECONDS = _env_int(
    "OBJECTIFOUDRE_AROME_RUN_UPDATE_INTERVAL_SECONDS",
    3 * 60 * 60,
    min_value=60 * 60,
)
OBJECTIFOUDRE_AROME_RUN_AVAILABILITY_DELAY_SECONDS = _env_int(
    "OBJECTIFOUDRE_AROME_RUN_AVAILABILITY_DELAY_SECONDS",
    10 * 60,
    min_value=0,
    max_value=3 * 60 * 60,
)
OBJECTIFOUDRE_AROME_RUN_POLL_INTERVAL_SECONDS = _env_int(
    "OBJECTIFOUDRE_AROME_RUN_POLL_INTERVAL_SECONDS",
    10 * 60,
    min_value=60,
    max_value=60 * 60,
)
OBJECTIFOUDRE_CACHE_RETENTION_HOURS = _env_int("OBJECTIFOUDRE_CACHE_RETENTION_HOURS", 24, min_value=24)
# Rétention DÉDIÉE, plus courte, pour les paquets GRIB bruts complets (`grib-full-package`,
# le plus gros poste). Une fois les messages/champs nationaux extraits et la grille archivée,
# le paquet complet est redondant → on le purge bien avant les caches encore utiles.
OBJECTIFOUDRE_FULL_PACKAGE_RETENTION_HOURS = _env_int("OBJECTIFOUDRE_FULL_PACKAGE_RETENTION_HOURS", 12, min_value=1)
OBJECTIFOUDRE_CACHE_CLEANUP_INTERVAL_SECONDS = _env_int("OBJECTIFOUDRE_CACHE_CLEANUP_INTERVAL_SECONDS", 60 * 60, min_value=5 * 60)
# J-1 n'est PLUS préchargé : il est servi à la demande depuis l'archive (history/),
# ce qui évite de recalculer/garder en RAM une grille déjà persistée durablement.
OBJECTIFOUDRE_AUTO_PRELOAD_DAYS = os.environ.get("OBJECTIFOUDRE_AUTO_PRELOAD_DAYS", "today,tomorrow,day_after_tomorrow")
# Jours préchargés via ARPEGE. J+2 est inclus car le run AROME (~+51 h) ne couvre que
# le DÉBUT de J+2 → ARPEGE complète l'après-midi/soirée de J+2, puis J+3/J+4. Vide = off.
OBJECTIFOUDRE_AUTO_PRELOAD_ARPEGE_DAYS = os.environ.get("OBJECTIFOUDRE_AUTO_PRELOAD_ARPEGE_DAYS", "j+2,j+3")
# Nb de PROCESSUS pour matérialiser les 24 créneaux d'un jour en parallèle (chaque
# processus a son propre GIL → vrai parallélisme sur le scoring Python pur). Défaut 1 =
# séquentiel (comportement historique, Render inchangé). En local, mettre p.ex. 6.
OBJECTIFOUDRE_PRELOAD_WORKERS = _env_int(
    "OBJECTIFOUDRE_PRELOAD_WORKERS", 1, min_value=1, max_value=max(1, (os.cpu_count() or 1)),
)

# --- Tendance ECMWF open data (J+5 → J+10) -------------------------------------
# Open data IFS/HRES, sans clé (licence CC-BY 4.0). Fichiers GRIB2 indexés par champ
# (.index json-lines avec _offset/_length) → on Range-fetch uniquement les champs utiles.
# C'est une TENDANCE quotidienne (maille 0,25° ≈ 28 km), pas la grille horaire fine.
ECMWF_OPEN_DATA_BASE = os.environ.get("OBJECTIFOUDRE_ECMWF_OPEN_DATA_BASE", "https://data.ecmwf.int/forecasts")
ECMWF_OPEN_DATA_STREAM = "ifs/0p25/oper"   # IFS HRES déterministe 0,25°
ECMWF_TREND_DAYS_AHEAD = (4, 5, 6, 7, 8, 9, 10)   # J+4 inclus : ARPEGE s'arrête à J+3 (horizon)
ECMWF_TREND_PEAK_UTC_HOUR = 12             # instant ≈ pic d'instabilité (14h CEST)
ECMWF_TREND_MAX_STEP_HOURS = 360
ECMWF_TREND_ATTRIBUTION = "ECMWF IFS open data (CC-BY 4.0)"
# Champ ObjectiFoudre -> nom de paramètre dans l'index ECMWF. Le vent est reconstruit
# depuis 10u/10v. Champs absents (rayonnement, taux de pluie, nébulosité, CIN, BLH) :
# le score les gère en None (comme ARPEGE-moins) → tendance, score un peu moins affûté.
ECMWF_TREND_FIELD_MAP = {
    "cape": "mucape",
    "temperature_2m": "2t",
    "dew_point_2m": "2d",
    "precipitable_water": "tcwv",
    "wind_gusts_10m": "10fg3",
}
ECMWF_TREND_WIND_COMPONENTS = ("10u", "10v")
ECMWF_TREND_CACHE_TTL_SECONDS = int(os.environ.get("OBJECTIFOUDRE_ECMWF_TREND_CACHE_TTL_SECONDS", "43200"))  # 12 h
ECMWF_TREND_MODEL_NAME = "ecmwf_ifs_trend"
OBJECTIFOUDRE_AUTO_PRELOAD_GRID = os.environ.get("OBJECTIFOUDRE_AROME_GRID") or None
OBJECTIFOUDRE_ENABLE_LEGACY_OPEN_METEO = _env_flag("OBJECTIFOUDRE_ENABLE_LEGACY_OPEN_METEO", False)
OBJECTIFOUDRE_ENABLE_LEGACY_LOCAL_AROME = _env_flag("OBJECTIFOUDRE_ENABLE_LEGACY_LOCAL_AROME", False)
OBJECTIFOUDRE_ENABLE_METEOFRANCE_DIAGNOSTICS = _env_flag("OBJECTIFOUDRE_ENABLE_METEOFRANCE_DIAGNOSTICS", False)
METEOFRANCE_AROME_WCS_GRID_MAX_DAYS_AHEAD = 1
METEOFRANCE_AROME_GRIB_MAX_DAYS_AHEAD = 2
METEOFRANCE_AROME_FORECAST_HORIZON_HOURS = 51
METEOFRANCE_GRIB_SLOT_MODEL_NAME = "meteofrance_arome_grib_slot"
METEOFRANCE_SAMPLE_COVERAGE_PREFIX = "TEMPERATURE__SPECIFIC_HEIGHT_LEVEL_ABOVE_GROUND"
METEOFRANCE_SLOT_MODEL_NAME = "meteofrance_arome_wcs_slot"
METEOFRANCE_SLOT_GRID_CORE_DETAIL = "core"
METEOFRANCE_SLOT_GRID_ADVANCED_DETAIL = "advanced"
METEOFRANCE_AROME_PACKAGE_API_BASE = "https://public-api.meteofrance.fr/previnum/DPPaquetAROME/v1"
METEOFRANCE_AROME_PACKAGE_MODEL = "AROME"
METEOFRANCE_AROME_PACKAGE_PREFERRED_GRIDS = ["0.025", "0.01"]
METEOFRANCE_AROME_SURFACE_PACKAGE_CANDIDATES = ["SP1", "SP2", "SP3"]
METEOFRANCE_ARPEGE_PACKAGE_API_BASE = "https://public-api.meteofrance.fr/previnum/DPPaquetARPEGE/v1"

# Registre des modèles PNT. Le pipeline paquets (catalogue -> runs -> produits GRIB)
# est paramétré par ce registre ; "arome" garde un cache_scope_prefix vide pour que
# ses clés de cache restent strictement identiques à l'existant (ne pas invalider).
DEFAULT_NWP_MODEL = "arome"
NWP_MODEL_REGISTRY: dict[str, dict[str, Any]] = {
    "arome": {
        "label": "AROME",
        "package_api_base": METEOFRANCE_AROME_PACKAGE_API_BASE,
        "package_model": METEOFRANCE_AROME_PACKAGE_MODEL,
        "preferred_grids": METEOFRANCE_AROME_PACKAGE_PREFERRED_GRIDS,
        "surface_package_candidates": METEOFRANCE_AROME_SURFACE_PACKAGE_CANDIDATES,
        "forecast_horizon_hours": METEOFRANCE_AROME_FORECAST_HORIZON_HOURS,
        "max_days_ahead": 2,
        "cache_scope_prefix": "",
        "api_key_env_vars": ("METEOFRANCE_API_KEY", "METEOFRANCE_API_TOKEN", "METEOFRANCE_TOKEN"),
        "api_key_file": None,
    },
    "arpege": {
        "label": "ARPEGE",
        "package_api_base": METEOFRANCE_ARPEGE_PACKAGE_API_BASE,
        "package_model": "ARPEGE",
        "preferred_grids": ["0.1", "0.25"],
        "surface_package_candidates": ["SP1", "SP2", "SP3"],
        "forecast_horizon_hours": 102,
        "max_days_ahead": 3,
        "cache_scope_prefix": "arpege:",
        "api_key_env_vars": ("METEOFRANCE_ARPEGE_API_KEY",),
        "api_key_file": "Clef API ARPEGE.txt",
    },
}


def _nwp_model_spec(model: str | None) -> dict[str, Any]:
    model_id = (model or DEFAULT_NWP_MODEL).strip().lower()
    spec = NWP_MODEL_REGISTRY.get(model_id)
    if spec is None:
        raise ValueError(f"Modèle PNT inconnu : {model!r}")
    return spec


# Modèle PNT « actif » pour le pipeline paquets : les fonctions profondes (URLs
# catalogue, clés de cache, specs de champs, horizon) le lisent au lieu de recevoir
# un paramètre supplémentaire sur ~20 signatures. Défaut "arome" → tout code qui ne
# pose pas explicitement de contexte garde le comportement historique à l'identique.
# contextvars se propage à asyncio.to_thread ; les threads créés à la main doivent
# re-poser le contexte (cf. _run_meteofrance_grib_national_day_preload_job).
_NWP_ACTIVE_MODEL: contextvars.ContextVar[str] = contextvars.ContextVar("nwp_active_model", default=DEFAULT_NWP_MODEL)


def _active_nwp_model() -> str:
    return _NWP_ACTIVE_MODEL.get()


def _active_nwp_spec() -> dict[str, Any]:
    return _nwp_model_spec(_NWP_ACTIVE_MODEL.get())


@contextlib.contextmanager
def _nwp_model_context(model: str | None):
    model_id = (model or DEFAULT_NWP_MODEL).strip().lower()
    _nwp_model_spec(model_id)  # validation
    token = _NWP_ACTIVE_MODEL.set(model_id)
    try:
        yield model_id
    finally:
        _NWP_ACTIVE_MODEL.reset(token)


def _nwp_models_for_date(target_date: Date, today: Date | None = None) -> list[str]:
    """Modèles applicables pour une date, par ordre de préférence. AROME est préféré
    là où il a des données ; le run AROME (~+51 h) ne couvre que le DÉBUT de J+2 →
    ARPEGE prend le relais pour la fin de J+2 (et J+3). J+4+ = [] : géré par le
    sous-système tendance ECMWF (carte Prévision), pas par la grille de base — ARPEGE
    (~+102 h) n'atteint pas l'après-midi de J+4. Le service essaie les modèles dans
    l'ordre et garde le premier qui a le créneau en cache (relais créneau par créneau)."""
    today_date = today or datetime.now(OBJECTIFOUDRE_SERVER_TIMEZONE).date()
    offset_days = (target_date - today_date).days
    arome_max = int(_nwp_model_spec("arome").get("max_days_ahead") or 2)
    arpege_max = int(_nwp_model_spec("arpege").get("max_days_ahead") or 4)
    if offset_days < arome_max:
        return ["arome"]                       # J-1, J0, J+1 : AROME couvre toute la journée
    if offset_days == arome_max:
        return ["arome", "arpege"]             # J+2 : AROME jusqu'à l'horizon, puis ARPEGE
    if offset_days <= arpege_max:
        return ["arpege"]                       # J+3, J+4 : ARPEGE
    return []                                   # au-delà : ECMWF (sous-système tendance)


def _nwp_model_for_date(target_date: Date, today: Date | None = None) -> str:
    """Modèle PRIMAIRE d'une date (clé API, routage front, contexte par défaut)."""
    models = _nwp_models_for_date(target_date, today)
    return models[0] if models else DEFAULT_NWP_MODEL
METEOFRANCE_AROME025_OBJECTIFOUDRE_GRIB_PLAN = [
    {
        "field": "wind_speed_10m",
        "label": "Vent 10 m",
        "package_id": "SP1",
        "source_field": "si10",
        "status": "available",
    },
    {
        "field": "wind_direction_10m",
        "label": "Direction vent 10 m",
        "package_id": "SP1",
        "source_field": "wdir10",
        "status": "available",
    },
    {
        "field": "wind_gusts_10m",
        "label": "Rafales 10 m",
        "package_id": "SP1",
        "source_field": "max_i10fg",
        "status": "available",
    },
    {
        "field": "relative_humidity_2m",
        "label": "Humidité relative 2 m",
        "package_id": "SP1",
        "source_field": "r2",
        "status": "available",
    },
    {
        "field": "temperature_2m",
        "label": "Température 2 m",
        "package_id": "SP1",
        "source_field": "t2m",
        "status": "available",
    },
    {
        "field": "dew_point_2m",
        "label": "Point de rosée 2 m",
        "package_id": "SP2",
        "source_field": "d2m",
        "status": "available",
    },
    {
        "field": "specific_humidity_2m",
        "label": "Humidité spécifique 2 m",
        "package_id": "SP2",
        "source_field": "sh2",
        "status": "available",
    },
    {
        "field": "cape",
        "label": "CAPE",
        "package_id": "SP2",
        "source_field": "CAPE_INS",
        "status": "available",
    },
    {
        "field": "precipitable_water",
        "label": "Vapeur d’eau intégrée colonne",
        "package_id": "SP3",
        "source_field": "GRIB2 0.1.64",
        "status": "available",
    },
    {
        "field": "shortwave_radiation",
        "label": "Flux net rayonnement court",
        "package_id": "SP3",
        "source_field": "GRIB2 0.4.9",
        "status": "available",
    },
    {
        "field": "precipitation_rate",
        "label": "Taux de précipitations total",
        "package_id": "SP1",
        "source_field": "prate",
        "status": "available",
    },
    {
        "field": "cloud_cover_low",
        "label": "Nuages bas",
        "package_id": "SP2",
        "source_field": "lcc",
        "status": "available",
    },
    {
        "field": "cloud_cover_mid",
        "label": "Nuages moyens",
        "package_id": "SP2",
        "source_field": "mcc",
        "status": "available",
    },
    {
        "field": "cloud_cover_high",
        "label": "Nuages hauts",
        "package_id": "SP2",
        "source_field": "hcc",
        "status": "available",
    },
    {
        "field": "pressure",
        "label": "Pression",
        "package_id": "SP2",
        "source_field": "sp",
        "status": "available",
    },
    {
        "field": "convective_inhibition",
        "label": "CIN",
        "package_id": None,
        "source_field": None,
        "status": "not_listed",
    },
]

METEOFRANCE_OBJECTIFOUDRE_FIELDS = [
    {
        "field": "mucape",
        "label": "CAPE",
        "coverage_prefix": "CONVECTIVE_AVAILABLE_POTENTIAL_ENERGY__GROUND_OR_WATER_SURFACE",
        "mode": "direct",
    },
    {
        "field": "temp_c",
        "label": "Température 2 m",
        "coverage_prefix": "TEMPERATURE__SPECIFIC_HEIGHT_LEVEL_ABOVE_GROUND",
        "mode": "direct",
    },
    {
        "field": "dewpoint_c",
        "label": "Point de rosée 2 m",
        "coverage_prefix": "DEW_POINT_TEMPERATURE__SPECIFIC_HEIGHT_LEVEL_ABOVE_GROUND",
        "mode": "direct",
    },
    {
        "field": "convective_inhibition",
        "label": "CIN",
        "coverage_prefix": "CONVECTIVE_INHIBITION__GROUND_OR_WATER_SURFACE",
        "match_tokens": ["CONVECTIVE", "INHIBITION"],
        "mode": "direct",
        "optional": True,
    },
    {
        "field": "relative_humidity_2m",
        "label": "Humidité relative 2 m",
        "coverage_prefix": "RELATIVE_HUMIDITY__SPECIFIC_HEIGHT_LEVEL_ABOVE_GROUND",
        "mode": "direct",
    },
    {
        "field": "cloud_cover_low",
        "label": "Nuages bas",
        "coverage_prefix": "LOW_CLOUD_COVER__GROUND_OR_WATER_SURFACE",
        "mode": "direct",
    },
    {
        "field": "cloud_cover_mid",
        "label": "Nuages moyens",
        "coverage_prefix": "MEDIUM_CLOUD_COVER__GROUND_OR_WATER_SURFACE",
        "mode": "direct",
    },
    {
        "field": "cloud_cover_high",
        "label": "Nuages hauts",
        "coverage_prefix": "HIGH_CLOUD_COVER__GROUND_OR_WATER_SURFACE",
        "mode": "direct",
    },
    {
        "field": "wind_gusts_10m",
        "label": "Rafales 10 m",
        "coverage_prefix": "WIND_SPEED_GUST__SPECIFIC_HEIGHT_LEVEL_ABOVE_GROUND",
        "mode": "direct",
    },
    {
        "field": "shear_ms",
        "label": "Shear 10-100 m",
        "coverage_prefix": "WIND_SPEED__SPECIFIC_HEIGHT_LEVEL_ABOVE_GROUND",
        "mode": "computed",
        "depends_on": ["WIND_SPEED__SPECIFIC_HEIGHT_LEVEL_ABOVE_GROUND"],
    },
    {
        "field": "vapour_pressure_deficit",
        "label": "VPD",
        "mode": "computed",
        "depends_on": [
            "TEMPERATURE__SPECIFIC_HEIGHT_LEVEL_ABOVE_GROUND",
            "DEW_POINT_TEMPERATURE__SPECIFIC_HEIGHT_LEVEL_ABOVE_GROUND",
        ],
    },
    {
        "field": "wet_bulb_temperature_2m",
        "label": "Bulbe humide 2 m",
        "mode": "computed",
        "depends_on": [
            "TEMPERATURE__SPECIFIC_HEIGHT_LEVEL_ABOVE_GROUND",
            "RELATIVE_HUMIDITY__SPECIFIC_HEIGHT_LEVEL_ABOVE_GROUND",
        ],
    },
]

METEOFRANCE_SLOT_GRID_SPECS = [
    {
        "field": "cape",
        "coverage_prefix": "CONVECTIVE_AVAILABLE_POTENTIAL_ENERGY__GROUND_OR_WATER_SURFACE",
        "height": None,
    },
    {
        "field": "temperature_2m",
        "coverage_prefix": "TEMPERATURE__SPECIFIC_HEIGHT_LEVEL_ABOVE_GROUND",
        "height": "2",
    },
    {
        "field": "dew_point_2m",
        "coverage_prefix": "DEW_POINT_TEMPERATURE__SPECIFIC_HEIGHT_LEVEL_ABOVE_GROUND",
        "height": "2",
    },
    {
        "field": "convective_inhibition",
        "coverage_prefix": "CONVECTIVE_INHIBITION__GROUND_OR_WATER_SURFACE",
        "match_tokens": ["CONVECTIVE", "INHIBITION"],
        "height": None,
        "optional": True,
    },
    {
        "field": "relative_humidity_2m",
        "coverage_prefix": "RELATIVE_HUMIDITY__SPECIFIC_HEIGHT_LEVEL_ABOVE_GROUND",
        "height": "2",
        "optional": True,
    },
    {
        "field": "cloud_cover_low",
        "coverage_prefix": "LOW_CLOUD_COVER__GROUND_OR_WATER_SURFACE",
        "height": None,
        "optional": True,
    },
    {
        "field": "cloud_cover_mid",
        "coverage_prefix": "MEDIUM_CLOUD_COVER__GROUND_OR_WATER_SURFACE",
        "height": None,
        "optional": True,
    },
    {
        "field": "cloud_cover_high",
        "coverage_prefix": "HIGH_CLOUD_COVER__GROUND_OR_WATER_SURFACE",
        "height": None,
        "optional": True,
    },
    {
        "field": "wind_gusts_10m",
        "coverage_prefix": "WIND_SPEED_GUST__SPECIFIC_HEIGHT_LEVEL_ABOVE_GROUND",
        "height": "10",
        "optional": True,
    },
    {
        "field": "wind_speed_10m",
        "coverage_prefix": "WIND_SPEED__SPECIFIC_HEIGHT_LEVEL_ABOVE_GROUND",
        "height": "10",
        "optional": True,
    },
    {
        "field": "wind_speed_100m",
        "coverage_prefix": "WIND_SPEED__SPECIFIC_HEIGHT_LEVEL_ABOVE_GROUND",
        "height": "100",
        "optional": True,
    },
    {
        "field": "wind_direction_10m",
        "coverage_prefix": "WIND_DIRECTION__SPECIFIC_HEIGHT_LEVEL_ABOVE_GROUND",
        "height": "10",
        "optional": True,
    },
    {
        "field": "wind_direction_100m",
        "coverage_prefix": "WIND_DIRECTION__SPECIFIC_HEIGHT_LEVEL_ABOVE_GROUND",
        "height": "100",
        "optional": True,
    },
]

METEOFRANCE_GRIB_SLOT_GRID_SPECS = [
    {
        "field": "cape",
        "package_id": "SP2",
        "parameter_label": "CAPE",
        "level_contains": None,
        "required": True,
    },
    {
        "field": "precipitable_water",
        "package_id": "SP3",
        "parameter_label": "Vapeur d’eau intégrée colonne",
        "level_contains": None,
        "required": True,
    },
    {
        "field": "shortwave_radiation",
        "package_id": "SP3",
        "parameter_label": "Flux net rayonnement court",
        "level_contains": None,
        "required": True,
    },
    {
        "field": "precipitation_rate",
        "package_id": "SP1",
        "parameter_label": "Taux de précipitations total",
        "level_contains": None,
        "required": True,
    },
    {
        "field": "relative_humidity_2m",
        "package_id": "SP1",
        "parameter_label": "Humidité relative",
        "level_contains": "2 m",
        "required": True,
    },
    {
        "field": "wind_speed_10m",
        "package_id": "SP1",
        "parameter_label": "Vitesse du vent",
        "level_contains": "10 m",
        "required": True,
    },
    {
        "field": "wind_direction_10m",
        "package_id": "SP1",
        "parameter_label": "Direction du vent",
        "level_contains": "10 m",
        "required": True,
    },
    {
        "field": "temperature_2m",
        "package_id": "SP2",
        "parameter_label": "Température",
        "level_contains": "2 m",
        "required": True,
    },
    {
        "field": "dew_point_2m",
        "package_id": "SP2",
        "parameter_label": "Point de rosée",
        "level_contains": "2 m",
        "required": True,
    },
    {
        "field": "cloud_cover_low",
        "package_id": "SP2",
        "parameter_label": "Nuages bas",
        "level_contains": None,
        "required": True,
    },
    {
        "field": "cloud_cover_mid",
        "package_id": "SP2",
        "parameter_label": "Nuages moyens",
        "level_contains": None,
        "required": True,
    },
    {
        "field": "cloud_cover_high",
        "package_id": "SP2",
        "parameter_label": "Nuages hauts",
        "level_contains": None,
        "required": True,
    },
    {
        "field": "wind_gusts_10m",
        "package_id": "SP1",
        "parameter_label": "Rafales",
        "level_contains": "10 m",
        "required": True,
    },
    {
        # Hauteur de couche limite (SP2, déjà téléchargé) : champ INSTANTANÉ en mètres.
        # Récupéré (required → préchargé) mais NON FATAL si absent (cf.
        # METEOFRANCE_GRIB_NON_FATAL_FIELDS) pour ne jamais casser la grille.
        "field": "boundary_layer_height",
        "package_id": "SP2",
        "parameter_label": "Hauteur de couche limite",
        "level_contains": None,
        "required": True,
    },
]
# Champs « required » (donc préchargés) dont l'absence ne doit PAS faire échouer la
# grille : ce sont des enrichissements (le scoring les gère en None). Permet d'ajouter
# de nouveaux champs AROME sans risque de régression si un run/groupe ne les expose pas.
METEOFRANCE_GRIB_NON_FATAL_FIELDS = {"boundary_layer_height"}
METEOFRANCE_GRIB_SLOT_PACKAGE_INDEX_LIMITS = {
    "SP1": 24,
    "SP2": 80,
    "SP3": 32,
}
METEOFRANCE_GRIB_SLOT_PACKAGE_INDEX_RETRY_LIMITS = {
    "SP1": 96,
    "SP2": 160,
    "SP3": 96,
}
# Plan de champs ARPEGE 0.1° (sondé le 2026-06-13 sur run réel : tout est HORAIRE
# jusqu'à h102). Différences vs AROME : pas de SP3 — la vapeur d'eau colonne est dans
# SP2 ; « Flux net rayonnement court » et « Taux de précipitations total » n'existent
# qu'à h0 → absents du plan (weather_logic gère None : chauffage = timing seul,
# precipitation_available=False).
METEOFRANCE_ARPEGE_GRIB_SLOT_GRID_SPECS = [
    {"field": "cape", "package_id": "SP2", "parameter_label": "CAPE", "level_contains": None, "required": True},
    {"field": "precipitable_water", "package_id": "SP2", "parameter_label": "Vapeur d’eau intégrée colonne", "level_contains": None, "required": True},
    {"field": "relative_humidity_2m", "package_id": "SP1", "parameter_label": "Humidité relative", "level_contains": "2 m", "required": True},
    {"field": "wind_speed_10m", "package_id": "SP1", "parameter_label": "Vitesse du vent", "level_contains": "10 m", "required": True},
    {"field": "wind_direction_10m", "package_id": "SP1", "parameter_label": "Direction du vent", "level_contains": "10 m", "required": True},
    {"field": "wind_gusts_10m", "package_id": "SP1", "parameter_label": "Rafales", "level_contains": "10 m", "required": True},
    {"field": "temperature_2m", "package_id": "SP2", "parameter_label": "Température", "level_contains": "2 m", "required": True},
    {"field": "dew_point_2m", "package_id": "SP2", "parameter_label": "Point de rosée", "level_contains": "2 m", "required": True},
    {"field": "cloud_cover_low", "package_id": "SP2", "parameter_label": "Nuages bas", "level_contains": None, "required": True},
    {"field": "cloud_cover_mid", "package_id": "SP2", "parameter_label": "Nuages moyens", "level_contains": None, "required": True},
    {"field": "cloud_cover_high", "package_id": "SP2", "parameter_label": "Nuages hauts", "level_contains": None, "required": True},
    {"field": "boundary_layer_height", "package_id": "SP2", "parameter_label": "Hauteur de couche limite", "level_contains": None, "required": True},
]
# Paquets ARPEGE : ~325-331 messages par groupe d'échéances (13 h × ~25 paramètres),
# et le paquet complet est en cache disque → indexer profond est local et peu coûteux.
METEOFRANCE_ARPEGE_GRIB_SLOT_PACKAGE_INDEX_LIMITS = {"SP1": 400, "SP2": 400}
METEOFRANCE_ARPEGE_GRIB_SLOT_PACKAGE_INDEX_RETRY_LIMITS = {"SP1": 512, "SP2": 512}


def _nwp_slot_grid_specs() -> list[dict[str, Any]]:
    if _active_nwp_model() == "arpege":
        return METEOFRANCE_ARPEGE_GRIB_SLOT_GRID_SPECS
    return METEOFRANCE_GRIB_SLOT_GRID_SPECS
METEOFRANCE_FRANCE_GRID_CENTER_LAT = 46.65
METEOFRANCE_FRANCE_GRID_CENTER_LON = 2.45
METEOFRANCE_FRANCE_GRID_LABEL = "France métropolitaine"
METEOFRANCE_FRANCE_GRID_BOUNDS = {
    "south": 41.25,
    "north": 51.15,
    "west": -5.25,
    "east": 9.65,
}
METEOFRANCE_MAINLAND_FRANCE_POLYGON = [
    (-4.7385, 48.0385),
    (-4.7036, 48.0447),
    (-4.7106, 48.0633),
    (-4.4123, 48.1044),
    (-4.3606, 48.1086),
    (-4.3274, 48.0786),
    (-4.3308, 48.0957),
    (-4.2821, 48.1060),
    (-4.2707, 48.1508),
    (-4.3020, 48.1935),
    (-4.4386, 48.2307),
    (-4.4945, 48.2310),
    (-4.5490, 48.1664),
    (-4.5698, 48.2324),
    (-4.5408, 48.2476),
    (-4.6217, 48.2539),
    (-4.6302, 48.2787),
    (-4.5641, 48.2842),
    (-4.5537, 48.3352),
    (-4.5308, 48.3399),
    (-4.5543, 48.3031),
    (-4.5338, 48.2823),
    (-4.5065, 48.3101),
    (-4.5002, 48.2790),
    (-4.2602, 48.2918),
    (-4.2864, 48.2722),
    (-4.2670, 48.2569),
    (-4.2171, 48.2563),
    (-4.2044, 48.2372),
    (-4.1104, 48.2423),
    (-4.1155, 48.2164),
    (-4.0940, 48.2539),
    (-4.1321, 48.2396),
    (-4.2365, 48.2523),
    (-4.2757, 48.2796),
    (-4.1791, 48.2944),
    (-4.2809, 48.3121),
    (-4.2431, 48.3259),
    (-4.3349, 48.3113),
    (-4.2588, 48.3559),
    (-4.4515, 48.3247),
    (-4.4327, 48.3601),
    (-4.2719, 48.4420),
    (-4.6048, 48.3370),
    (-4.6763, 48.3537),
    (-4.7098, 48.3295),
    (-4.7703, 48.3300),
    (-4.7792, 48.3563),
    (-4.7436, 48.3650),
    (-4.7851, 48.3595),
    (-4.7583, 48.3768),
    (-4.7907, 48.4142),
    (-4.7623, 48.4639),
    (-4.7155, 48.4726),
    (-4.7693, 48.4766),
    (-4.7459, 48.5417),
    (-4.6263, 48.5763),
    (-4.5929, 48.5516),
    (-4.5037, 48.5450),
    (-4.6076, 48.5753),
    (-4.5938, 48.6056),
    (-4.4759, 48.5703),
    (-4.5646, 48.6082),
    (-4.5401, 48.6343),
    (-4.5068, 48.6207),
    (-4.3949, 48.6346),
    (-4.4308, 48.6516),
    (-4.3467, 48.6746),
    (-4.2921, 48.6617),
    (-4.2996, 48.6312),
    (-4.1922, 48.6501),
    (-4.2197, 48.6561),
    (-4.1308, 48.6934),
    (-4.0550, 48.6677),
    (-4.0516, 48.7004),
    (-3.9847, 48.7265),
    (-3.9330, 48.5968),
    (-3.9487, 48.6495),
    (-3.9193, 48.6722),
    (-3.8891, 48.6696),
    (-3.8476, 48.6019),
    (-3.8459, 48.6242),
    (-3.8094, 48.6270),
    (-3.8455, 48.6280),
    (-3.8609, 48.6701),
    (-3.8443, 48.6583),
    (-3.8218, 48.7179),
    (-3.6403, 48.6920),
    (-3.6574, 48.6573),
    (-3.6358, 48.6803),
    (-3.5715, 48.6728),
    (-3.5805, 48.7189),
    (-3.5477, 48.7437),
    (-3.5792, 48.7563),
    (-3.5769, 48.7862),
    (-3.5021, 48.8369),
    (-3.5065, 48.8229),
    (-3.4776, 48.8356),
    (-3.4270, 48.8182),
    (-3.4389, 48.7964),
    (-3.3186, 48.8352),
    (-3.2629, 48.8323),
    (-3.2189, 48.8642),
    (-3.2193, 48.7821),
    (-3.1669, 48.8497),
    (-3.0715, 48.8818),
    (-3.0982, 48.8289),
    (-3.0701, 48.8301),
    (-3.1196, 48.7573),
    (-3.0648, 48.8195),
    (-3.0113, 48.8166),
    (-3.0423, 48.7813),
    (-2.9287, 48.7543),
    (-2.9435, 48.7187),
    (-2.8284, 48.6537),
    (-2.8179, 48.5914),
    (-2.7150, 48.5524),
    (-2.6748, 48.4890),
    (-2.6813, 48.5317),
    (-2.6294, 48.5243),
    (-2.5480, 48.5950),
    (-2.4699, 48.6220),
    (-2.4872, 48.6423),
    (-2.4376, 48.6502),
    (-2.4165, 48.6310),
    (-2.3164, 48.6864),
    (-2.2842, 48.6665),
    (-2.3369, 48.6176),
    (-2.2441, 48.6422),
    (-2.2130, 48.5717),
    (-2.1930, 48.6048),
    (-2.1800, 48.5748),
    (-2.1499, 48.6144),
    (-2.1234, 48.6023),
    (-2.1479, 48.6303),
    (-2.0499, 48.6338),
    (-1.9736, 48.5429),
    (-2.0012, 48.4894),
    (-1.9622, 48.5248),
    (-1.9397, 48.5172),
    (-1.9883, 48.5823),
    (-1.9552, 48.5742),
    (-1.9619, 48.5905),
    (-2.0115, 48.5961),
    (-2.0275, 48.6493),
    (-1.9354, 48.7003),
    (-1.9038, 48.6886),
    (-1.8440, 48.7095),
    (-1.8705, 48.6415),
    (-1.8452, 48.6142),
    (-1.7677, 48.6002),
    (-1.5428, 48.6290),
    (-1.4898, 48.6135),
    (-1.4257, 48.6422),
    (-1.3478, 48.6292),
    (-1.4011, 48.6552),
    (-1.3726, 48.6916),
    (-1.4467, 48.6524),
    (-1.5724, 48.7449),
    (-1.5757, 48.8202),
    (-1.6147, 48.8324),
    (-1.5534, 48.9329),
    (-1.5507, 48.8915),
    (-1.5562, 49.0227),
    (-1.5048, 49.0179),
    (-1.5427, 49.0391),
    (-1.5794, 48.9985),
    (-1.5938, 49.0190),
    (-1.6105, 49.1017),
    (-1.5803, 49.1293),
    (-1.6139, 49.2167),
    (-1.5673, 49.2187),
    (-1.6150, 49.2375),
    (-1.6263, 49.2074),
    (-1.7111, 49.3232),
    (-1.6749, 49.3296),
    (-1.7200, 49.3233),
    (-1.7710, 49.3786),
    (-1.8086, 49.3700),
    (-1.8513, 49.5075),
    (-1.8862, 49.5352),
    (-1.8408, 49.5695),
    (-1.8536, 49.6386),
    (-1.9426, 49.6723),
    (-1.9434, 49.7203),
    (-1.8564, 49.7142),
    (-1.6236, 49.6417),
    (-1.4880, 49.6661),
    (-1.4372, 49.6984),
    (-1.2687, 49.6925),
    (-1.2291, 49.6031),
    (-1.2557, 49.6101),
    (-1.2727, 49.5683),
    (-1.3006, 49.5764),
    (-1.3080, 49.5435),
    (-1.1713, 49.4099),
    (-1.1779, 49.3627),
    (-1.1364, 49.3518),
    (-1.0743, 49.3872),
    (-0.9621, 49.3942),
    (-0.7559, 49.3454),
    (-0.3986, 49.3308),
    (-0.2270, 49.2795),
    (-0.0150, 49.3187),
    (0.1307, 49.4012),
    (0.3388, 49.4319),
    (0.1562, 49.4526),
    (0.0683, 49.5040),
    (0.1630, 49.6843),
    (0.2036, 49.7106),
    (0.5795, 49.8497),
    (1.0234, 49.9141),
    (1.1920, 49.9656),
    (1.4511, 50.1075),
    (1.4804, 50.1702),
    (1.5430, 50.2117),
    (1.5934, 50.1837),
    (1.6809, 50.1805),
    (1.5356, 50.2777),
    (1.5539, 50.3607),
    (1.6387, 50.3497),
    (1.5532, 50.3963),
    (1.5828, 50.5336),
    (1.6600, 50.5040),
    (1.5740, 50.5716),
    (1.5593, 50.7228),
    (1.5998, 50.7190),
    (1.6065, 50.8019),
    (1.5787, 50.8667),
    (1.8486, 50.9690),
    (2.0805, 51.0059),
    (2.1173, 50.9895),
    (2.1470, 51.0296),
    (2.1771, 51.0044),
    (2.1673, 51.0421),
    (2.3805, 51.0465),
    (2.5425, 51.0869),
    (2.6261, 50.9468),
    (2.5864, 50.9166),
    (2.5955, 50.8473),
    (2.6313, 50.8102),
    (2.7161, 50.8095),
    (2.7874, 50.7250),
    (2.9059, 50.6918),
    (2.9531, 50.7502),
    (3.1429, 50.7873),
    (3.1880, 50.7223),
    (3.2556, 50.6961),
    (3.2401, 50.6383),
    (3.2821, 50.5250),
    (3.3728, 50.4884),
    (3.4703, 50.5306),
    (3.5135, 50.5189),
    (3.4977, 50.4853),
    (3.6032, 50.4939),
    (3.6562, 50.4549),
    (3.6530, 50.3679),
    (3.7056, 50.3005),
    (3.7379, 50.3454),
    (3.8352, 50.3512),
    (3.8958, 50.3248),
    (4.0201, 50.3552),
    (4.1131, 50.2996),
    (4.1297, 50.2564),
    (4.1583, 50.2546),
    (4.1551, 50.2832),
    (4.2006, 50.2698),
    (4.2155, 50.2516),
    (4.1456, 50.2107),
    (4.1216, 50.1322),
    (4.1899, 50.1319),
    (4.2221, 50.0770),
    (4.1301, 50.0125),
    (4.1570, 49.9938),
    (4.1356, 49.9760),
    (4.1920, 49.9518),
    (4.3051, 49.9658),
    (4.4402, 49.9344),
    (4.6887, 49.9937),
    (4.6969, 50.0929),
    (4.8168, 50.1649),
    (4.8896, 50.1335),
    (4.8148, 50.0625),
    (4.8343, 50.0372),
    (4.7840, 49.9661),
    (4.8791, 49.9094),
    (4.8490, 49.7918),
    (4.9853, 49.7974),
    (5.0834, 49.7620),
    (5.1598, 49.6901),
    (5.2619, 49.6931),
    (5.3261, 49.6507),
    (5.3084, 49.6092),
    (5.3403, 49.6280),
    (5.4243, 49.5896),
    (5.4642, 49.4944),
    (5.5472, 49.5250),
    (5.6041, 49.5031),
    (5.6383, 49.5468),
    (5.7357, 49.5364),
    (5.7657, 49.5597),
    (5.8291, 49.5389),
    (5.8569, 49.4984),
    (5.9383, 49.4968),
    (5.9748, 49.4482),
    (6.0349, 49.4449),
    (6.0491, 49.4625),
    (6.0935, 49.4500),
    (6.1494, 49.5000),
    (6.2352, 49.5093),
    (6.3262, 49.4640),
    (6.4148, 49.4731),
    (6.5277, 49.4312),
    (6.5328, 49.3982),
    (6.5915, 49.3637),
    (6.5576, 49.3464),
    (6.6599, 49.2775),
    (6.7300, 49.1616),
    (6.8264, 49.1484),
    (6.8528, 49.1757),
    (6.8324, 49.2113),
    (6.9161, 49.2201),
    (7.0254, 49.1853),
    (7.0497, 49.1096),
    (7.0898, 49.1514),
    (7.1504, 49.1178),
    (7.2849, 49.1122),
    (7.3542, 49.1422),
    (7.3576, 49.1690),
    (7.4369, 49.1810),
    (7.4287, 49.1616),
    (7.4826, 49.1655),
    (7.5224, 49.0941),
    (7.6185, 49.0704),
    (7.6264, 49.0512),
    (7.7233, 49.0414),
    (7.7909, 49.0612),
    (7.8583, 49.0305),
    (7.9279, 49.0532),
    (8.0821, 48.9862),
    (8.2194, 48.9676),
    (8.1322, 48.8930),
    (8.0777, 48.7990),
    (7.9610, 48.7532),
    (7.9525, 48.7172),
    (7.8268, 48.6307),
    (7.7911, 48.5801),
    (7.7961, 48.5105),
    (7.7245, 48.3957),
    (7.7362, 48.3268),
    (7.6849, 48.2991),
    (7.6572, 48.2181),
    (7.5689, 48.1184),
    (7.5597, 48.0333),
    (7.6132, 47.9706),
    (7.5488, 47.8779),
    (7.5213, 47.7804),
    (7.5397, 47.7324),
    (7.5032, 47.6931),
    (7.5840, 47.5978),
    (7.5753, 47.5727),
    (7.4956, 47.5399),
    (7.5211, 47.5233),
    (7.4889, 47.5182),
    (7.4767, 47.4788),
    (7.4259, 47.4949),
    (7.4124, 47.4771),
    (7.4446, 47.4705),
    (7.3775, 47.4289),
    (7.2384, 47.4181),
    (7.1635, 47.4425),
    (7.1895, 47.4906),
    (6.9745, 47.4912),
    (6.9898, 47.4486),
    (6.9308, 47.4307),
    (6.8714, 47.3494),
    (7.0029, 47.3685),
    (7.0463, 47.3307),
    (6.9325, 47.2836),
    (6.9467, 47.2401),
    (6.7027, 47.0820),
    (6.6897, 47.0354),
    (6.6031, 46.9880),
    (6.4886, 46.9712),
    (6.4250, 46.9248),
    (6.4565, 46.8869),
    (6.4230, 46.8093),
    (6.4428, 46.7722),
    (6.1055, 46.5756),
    (6.1477, 46.5426),
    (6.0661, 46.4614),
    (6.0563, 46.4133),
    (6.1606, 46.3645),
    (6.0946, 46.2819),
    (6.1081, 46.2414),
    (5.9667, 46.2118),
    (5.9560, 46.1940),
    (5.9855, 46.1819),
    (5.9484, 46.1291),
    (6.0493, 46.1481),
    (6.1276, 46.1383),
    (6.2865, 46.2219),
    (6.3006, 46.2520),
    (6.2566, 46.2468),
    (6.2307, 46.2793),
    (6.2945, 46.3632),
    (6.3356, 46.3667),
    (6.3777, 46.3377),
    (6.5049, 46.4018),
    (6.7968, 46.3910),
    (6.7663, 46.3443),
    (6.8553, 46.2768),
    (6.7951, 46.2001),
    (6.7888, 46.1353),
    (6.8886, 46.1200),
    (6.8641, 46.0490),
    (6.9276, 46.0612),
    (7.0334, 45.9217),
    (6.9291, 45.8445),
    (6.8710, 45.8449),
    (6.8573, 45.8233),
    (6.8131, 45.8340),
    (6.8009, 45.7229),
    (6.9062, 45.6487),
    (6.9905, 45.6351),
    (6.9702, 45.5856),
    (6.9913, 45.5018),
    (7.0930, 45.4655),
    (7.1047, 45.4312),
    (7.1753, 45.4004),
    (7.1019, 45.3235),
    (7.1263, 45.2515),
    (7.0671, 45.2091),
    (7.0424, 45.2223),
    (6.9576, 45.2034),
    (6.8457, 45.1256),
    (6.7610, 45.1563),
    (6.6186, 45.0996),
    (6.6638, 45.0205),
    (6.7348, 45.0116),
    (6.7425, 44.9025),
    (6.8562, 44.8476),
    (6.9271, 44.8582),
    (7.0107, 44.8213),
    (6.9906, 44.7867),
    (7.0656, 44.6783),
    (6.9544, 44.6751),
    (6.9584, 44.6199),
    (6.8465, 44.5273),
    (6.9334, 44.4287),
    (6.8867, 44.4147),
    (6.8787, 44.3567),
    (6.9830, 44.2764),
    (6.9982, 44.2324),
    (7.1780, 44.1945),
    (7.2537, 44.1418),
    (7.3318, 44.1389),
    (7.3498, 44.1106),
    (7.4177, 44.1063),
    (7.4236, 44.1230),
    (7.6067, 44.1435),
    (7.6316, 44.1715),
    (7.6705, 44.1700),
    (7.6582, 44.1242),
    (7.7035, 44.0555),
    (7.6538, 44.0214),
    (7.6433, 43.9683),
    (7.5623, 43.9393),
    (7.5520, 43.8912),
    (7.4896, 43.8637),
    (7.5205, 43.7747),
    (7.3957, 43.7081),
    (7.3335, 43.7035),
    (7.3259, 43.6659),
    (7.3065, 43.6960),
    (7.2969, 43.6741),
    (7.2387, 43.6805),
    (7.2034, 43.6366),
    (7.1512, 43.6443),
    (7.1139, 43.5757),
    (7.1334, 43.5401),
    (7.1126, 43.5325),
    (7.0940, 43.5601),
    (7.0294, 43.5248),
    (6.9572, 43.5318),
    (6.8813, 43.4156),
    (6.8514, 43.4188),
    (6.8454, 43.3993),
    (6.7381, 43.4062),
    (6.7051, 43.3329),
    (6.5768, 43.2663),
    (6.5856, 43.2492),
    (6.6874, 43.2522),
    (6.6380, 43.1549),
    (6.5531, 43.1759),
    (6.4855, 43.1380),
    (6.3794, 43.1311),
    (6.3556, 43.0766),
    (6.2635, 43.1081),
    (6.1928, 43.1025),
    (6.1466, 43.0643),
    (6.1416, 43.0145),
    (6.0853, 43.0242),
    (6.1236, 43.0373),
    (6.1172, 43.0647),
    (6.0113, 43.0675),
    (5.9989, 43.0901),
    (5.9207, 43.0917),
    (5.9130, 43.1090),
    (5.8776, 43.1042),
    (5.8880, 43.0697),
    (5.9412, 43.0586),
    (5.8795, 43.0636),
    (5.8220, 43.0370),
    (5.7879, 43.0594),
    (5.7993, 43.1028),
    (5.6881, 43.1322),
    (5.6780, 43.1662),
    (5.6148, 43.1727),
    (5.5970, 43.1495),
    (5.5314, 43.1982),
    (5.5025, 43.1850),
    (5.3330, 43.2015),
    (5.3658, 43.2354),
    (5.3404, 43.2693),
    (5.3661, 43.2821),
    (5.3060, 43.3467),
    (5.2167, 43.3154),
    (5.0473, 43.3138),
    (5.0093, 43.3303),
    (4.9583, 43.4143),
    (4.8823, 43.3980),
    (4.8970, 43.4162),
    (4.8768, 43.4068),
    (4.8547, 43.4436),
    (4.8708, 43.3999),
    (4.8224, 43.4179),
    (4.8520, 43.3887),
    (4.8259, 43.3637),
    (4.8754, 43.3443),
    (4.9109, 43.3642),
    (4.8500, 43.3141),
    (4.6569, 43.3336),
    (4.5606, 43.3561),
    (4.5904, 43.3935),
    (4.5473, 43.4344),
    (4.2238, 43.4482),
    (4.1241, 43.4754),
    (4.1305, 43.5205),
    (4.0947, 43.5433),
    (3.9631, 43.5289),
    (3.7193, 43.3892),
    (3.6468, 43.3755),
    (3.5101, 43.2632),
    (3.3946, 43.2746),
    (3.2656, 43.2207),
    (3.0789, 43.0435),
    (3.0373, 42.9475),
    (3.0301, 42.6281),
    (3.0456, 42.5327),
    (3.1308, 42.5036),
    (3.1262, 42.4700),
    (3.1683, 42.4225),
    (3.0795, 42.4137),
    (3.0348, 42.4610),
    (2.9415, 42.4692),
    (2.9150, 42.4448),
    (2.8344, 42.4463),
    (2.7887, 42.4056),
    (2.6686, 42.3921),
    (2.6580, 42.3284),
    (2.5566, 42.3445),
    (2.5327, 42.3211),
    (2.4797, 42.3275),
    (2.4282, 42.3794),
    (2.2521, 42.4259),
    (2.1520, 42.4108),
    (2.0811, 42.3512),
    (2.0080, 42.3368),
    (1.9650, 42.3641),
    (1.9291, 42.4416),
    (1.7279, 42.4807),
    (1.7335, 42.5407),
    (1.7816, 42.5611),
    (1.7237, 42.5770),
    (1.7321, 42.6053),
    (1.4894, 42.6407),
    (1.4697, 42.5986),
    (1.4347, 42.5918),
    (1.3532, 42.7069),
    (1.2252, 42.7152),
    (1.1610, 42.6970),
    (1.0748, 42.7759),
    (0.9799, 42.7746),
    (0.9559, 42.7932),
    (0.9220, 42.7772),
    (0.7048, 42.8490),
    (0.6590, 42.8287),
    (0.6664, 42.7912),
    (0.6410, 42.7706),
    (0.6696, 42.6789),
    (0.5932, 42.6931),
    (0.4223, 42.6784),
    (0.3568, 42.7119),
    (0.2923, 42.6626),
    (0.2566, 42.7034),
    (0.1721, 42.7234),
    (-0.0096, 42.6725),
    (-0.1090, 42.7097),
    (-0.1615, 42.7833),
    (-0.1857, 42.7744),
    (-0.3162, 42.8370),
    (-0.3915, 42.7882),
    (-0.4441, 42.7846),
    (-0.5039, 42.8156),
    (-0.5703, 42.7686),
    (-0.6048, 42.8178),
    (-0.7311, 42.8828),
    (-0.7551, 42.9547),
    (-0.9498, 42.9429),
    (-1.1144, 43.0094),
    (-1.1412, 42.9962),
    (-1.2143, 43.0392),
    (-1.2635, 43.0314),
    (-1.3103, 43.0588),
    (-1.2720, 43.1063),
    (-1.3341, 43.0956),
    (-1.3584, 43.0167),
    (-1.4415, 43.0337),
    (-1.4739, 43.0759),
    (-1.4177, 43.1156),
    (-1.3846, 43.2399),
    (-1.5309, 43.2812),
    (-1.5633, 43.2762),
    (-1.5750, 43.2404),
    (-1.6086, 43.2411),
    (-1.6247, 43.2915),
    (-1.7325, 43.2868),
    (-1.7402, 43.3169),
    (-1.7874, 43.3383),
    (-1.7536, 43.3729),
    (-1.6709, 43.3761),
    (-1.6110, 43.4159),
    (-1.4503, 43.6315),
    (-1.3180, 44.1233),
    (-1.2614, 44.5421),
    (-1.1954, 44.6559),
    (-1.1491, 44.6584),
    (-1.1515, 44.6391),
    (-1.0064, 44.6459),
    (-1.1635, 44.7726),
    (-1.2307, 44.6953),
    (-1.2464, 44.6228),
    (-1.2631, 44.6294),
    (-1.1558, 45.4789),
    (-1.0922, 45.5611),
    (-1.0621, 45.5708),
    (-1.0397, 45.5316),
    (-1.0698, 45.5127),
    (-0.8051, 45.3416),
    (-0.7488, 45.2245),
    (-0.6920, 45.2340),
    (-0.7549, 45.4201),
    (-0.8207, 45.4897),
    (-0.9732, 45.5611),
    (-1.0244, 45.6198),
    (-1.2110, 45.6933),
    (-1.2208, 45.6676),
    (-1.2369, 45.6906),
    (-1.2423, 45.7833),
    (-1.1405, 45.7967),
    (-1.1735, 45.8533),
    (-1.1219, 45.8555),
    (-1.0757, 45.9099),
    (-1.0996, 45.9427),
    (-1.0659, 45.9508),
    (-1.1217, 45.9995),
    (-1.0544, 46.0015),
    (-1.1045, 46.0927),
    (-1.1419, 46.1056),
    (-1.1275, 46.1214),
    (-1.1727, 46.1369),
    (-1.1643, 46.1512),
    (-1.2416, 46.1574),
    (-1.2009, 46.2102),
    (-1.1126, 46.2588),
    (-1.1306, 46.3080),
    (-1.2032, 46.3138),
    (-1.2089, 46.2647),
    (-1.2952, 46.3194),
    (-1.2770, 46.2885),
    (-1.3003, 46.2882),
    (-1.3425, 46.3388),
    (-1.4663, 46.3405),
    (-1.5060, 46.3971),
    (-1.6249, 46.4119),
    (-1.8131, 46.4922),
    (-1.8566, 46.6062),
    (-2.1422, 46.8168),
    (-2.1547, 46.8860),
    (-2.1100, 46.8973),
    (-2.0284, 47.0074),
    (-1.9807, 47.0267),
    (-2.0539, 47.0921),
    (-2.2438, 47.1330),
    (-2.1666, 47.1652),
    (-2.1682, 47.2659),
    (-2.0107, 47.2824),
    (-2.0104, 47.3126),
    (-2.1816, 47.2964),
    (-2.2945, 47.2325),
    (-2.3905, 47.2794),
    (-2.4495, 47.2615),
    (-2.5462, 47.2898),
    (-2.5010, 47.3229),
    (-2.5572, 47.3720),
    (-2.4705, 47.4148),
    (-2.4338, 47.4109),
    (-2.4582, 47.4460),
    (-2.4934, 47.4473),
    (-2.5000, 47.4880),
    (-2.4202, 47.4931),
    (-2.5349, 47.5237),
    (-2.8141, 47.4849),
    (-2.9182, 47.5465),
    (-2.8788, 47.5616),
    (-2.8527, 47.5353),
    (-2.8155, 47.5393),
    (-2.8227, 47.5541),
    (-2.7980, 47.5358),
    (-2.7278, 47.5426),
    (-2.7166, 47.5950),
    (-2.7770, 47.6180),
    (-2.7365, 47.6122),
    (-2.7596, 47.6393),
    (-2.7908, 47.6156),
    (-2.8585, 47.6202),
    (-2.8902, 47.5769),
    (-2.9302, 47.6049),
    (-2.9351, 47.5838),
    (-2.9349, 47.6232),
    (-2.9767, 47.6582),
    (-2.9680, 47.5868),
    (-2.9252, 47.5536),
    (-2.9663, 47.5529),
    (-3.0222, 47.5894),
    (-3.0212, 47.5653),
    (-3.0408, 47.5854),
    (-3.0967, 47.5628),
    (-3.1275, 47.5968),
    (-3.1314, 47.5287),
    (-3.0867, 47.4703),
    (-3.1310, 47.4744),
    (-3.1581, 47.5245),
    (-3.1396, 47.5790),
    (-3.2091, 47.6409),
    (-3.2065, 47.6666),
    (-3.1502, 47.6907),
    (-3.2148, 47.6928),
    (-3.2127, 47.6436),
    (-3.2760, 47.6796),
    (-3.3599, 47.6891),
    (-3.2795, 47.6864),
    (-3.3585, 47.7071),
    (-3.2741, 47.7934),
    (-3.3435, 47.7409),
    (-3.3876, 47.8266),
    (-3.4026, 47.8066),
    (-3.3489, 47.7415),
    (-3.3813, 47.7025),
    (-3.4555, 47.6958),
    (-3.5249, 47.7626),
    (-3.5405, 47.8647),
    (-3.5362, 47.7613),
    (-3.6460, 47.7741),
    (-3.6382, 47.7896),
    (-3.6755, 47.7738),
    (-3.7206, 47.8007),
    (-3.6381, 47.8271),
    (-3.6928, 47.8285),
    (-3.7312, 47.7997),
    (-3.7461, 47.8461),
    (-3.7363, 47.7964),
    (-3.8489, 47.7915),
    (-3.8966, 47.8326),
    (-3.8769, 47.8579),
    (-3.9085, 47.8506),
    (-3.9442, 47.9026),
    (-3.9894, 47.8953),
    (-3.9728, 47.8528),
    (-4.0388, 47.8452),
    (-4.0793, 47.8726),
    (-4.0992, 47.8602),
    (-4.1369, 47.9228),
    (-4.0674, 47.9311),
    (-4.0817, 47.9504),
    (-4.1070, 47.9409),
    (-4.1150, 47.9823),
    (-4.1104, 47.9348),
    (-4.1443, 47.8956),
    (-4.1741, 47.9053),
    (-4.1117, 47.8599),
    (-4.1683, 47.8379),
    (-4.1708, 47.8733),
    (-4.2120, 47.8671),
    (-4.1589, 47.8325),
    (-4.1702, 47.8053),
    (-4.3692, 47.7962),
    (-4.3373, 47.8979),
    (-4.3643, 47.8910),
    (-4.4185, 47.9587),
    (-4.5337, 48.0093),
    (-4.5285, 48.0333),
    (-4.4886, 48.0375),
    (-4.5386, 48.0352),
    (-4.5637, 47.9986),
    (-4.7385, 48.0385),
]
METEOFRANCE_CORSICA_POLYGON = [
    (8.5490, 42.3549),
    (8.5616, 42.3221),
    (8.5941, 42.3385),
    (8.6203, 42.3344),
    (8.6313, 42.3238),
    (8.6068, 42.2989),
    (8.6650, 42.2893),
    (8.6951, 42.2619),
    (8.6934, 42.2504),
    (8.5444, 42.2244),
    (8.5782, 42.2138),
    (8.5717, 42.1924),
    (8.5837, 42.1943),
    (8.5910, 42.1682),
    (8.5643, 42.1598),
    (8.5984, 42.1529),
    (8.5648, 42.1328),
    (8.5898, 42.1379),
    (8.5835, 42.1146),
    (8.6193, 42.1200),
    (8.6672, 42.0908),
    (8.7057, 42.0982),
    (8.7250, 42.0512),
    (8.7426, 42.0516),
    (8.7520, 42.0348),
    (8.6628, 41.9976),
    (8.6729, 41.9691),
    (8.6533, 41.9559),
    (8.5985, 41.9506),
    (8.6275, 41.9214),
    (8.6138, 41.8826),
    (8.6503, 41.8965),
    (8.7242, 41.8961),
    (8.7521, 41.9200),
    (8.7832, 41.9123),
    (8.8070, 41.8796),
    (8.7849, 41.8693),
    (8.7940, 41.8401),
    (8.7598, 41.8322),
    (8.7860, 41.8173),
    (8.7757, 41.7982),
    (8.7171, 41.7883),
    (8.7349, 41.7667),
    (8.7166, 41.7471),
    (8.6719, 41.7390),
    (8.6658, 41.7280),
    (8.7070, 41.7266),
    (8.7144, 41.7093),
    (8.7822, 41.7274),
    (8.7777, 41.7037),
    (8.7906, 41.6904),
    (8.8172, 41.7005),
    (8.8465, 41.6846),
    (8.9166, 41.6780),
    (8.9201, 41.6686),
    (8.8875, 41.6575),
    (8.8738, 41.6331),
    (8.7971, 41.6162),
    (8.7835, 41.5775),
    (8.8037, 41.5602),
    (8.7898, 41.5475),
    (8.8561, 41.5287),
    (8.8499, 41.5050),
    (8.8791, 41.5116),
    (8.8894, 41.4936),
    (8.9177, 41.4951),
    (8.9254, 41.4766),
    (8.9670, 41.4775),
    (8.9863, 41.4634),
    (8.9990, 41.4726),
    (9.0290, 41.4482),
    (9.0422, 41.4569),
    (9.0445, 41.4441),
    (9.0841, 41.4645),
    (9.0765, 41.4311),
    (9.0995, 41.4366),
    (9.1227, 41.4248),
    (9.0999, 41.3809),
    (9.1320, 41.3843),
    (9.1738, 41.3704),
    (9.1869, 41.3530),
    (9.2236, 41.3551),
    (9.2674, 41.4134),
    (9.2226, 41.3945),
    (9.2299, 41.4295),
    (9.2912, 41.4708),
    (9.2760, 41.4893),
    (9.2799, 41.5160),
    (9.3519, 41.5508),
    (9.3717, 41.5803),
    (9.3239, 41.5911),
    (9.2984, 41.5714),
    (9.2879, 41.5823),
    (9.3092, 41.6129),
    (9.3545, 41.6056),
    (9.3552, 41.6266),
    (9.3720, 41.6239),
    (9.3873, 41.6368),
    (9.3773, 41.6640),
    (9.4081, 41.6985),
    (9.4011, 41.8615),
    (9.4174, 41.9422),
    (9.5531, 42.0908),
    (9.5600, 42.1296),
    (9.5636, 42.2697),
    (9.5364, 42.3660),
    (9.5472, 42.4149),
    (9.5314, 42.5519),
    (9.4531, 42.6492),
    (9.4652, 42.7271),
    (9.4953, 42.7845),
    (9.4731, 42.9234),
    (9.4558, 42.9500),
    (9.4645, 42.9728),
    (9.4254, 42.9977),
    (9.3476, 42.9847),
    (9.3635, 42.9098),
    (9.3257, 42.8827),
    (9.3443, 42.8526),
    (9.3141, 42.8194),
    (9.3465, 42.7812),
    (9.3470, 42.7199),
    (9.3000, 42.6631),
    (9.2259, 42.7211),
    (9.2017, 42.7125),
    (9.1678, 42.7232),
    (9.1276, 42.7172),
    (9.0624, 42.6793),
    (9.0631, 42.6491),
    (9.0219, 42.6295),
    (8.9527, 42.6205),
    (8.9399, 42.6276),
    (8.8870, 42.6143),
    (8.8718, 42.5954),
    (8.8102, 42.5889),
    (8.8076, 42.5569),
    (8.7911, 42.5450),
    (8.7715, 42.5427),
    (8.7643, 42.5560),
    (8.7309, 42.5497),
    (8.7301, 42.5702),
    (8.7156, 42.5651),
    (8.7251, 42.5109),
    (8.6684, 42.5015),
    (8.6521, 42.4617),
    (8.6809, 42.4631),
    (8.6840, 42.4543),
    (8.6673, 42.4428),
    (8.6754, 42.4314),
    (8.6533, 42.4306),
    (8.6611, 42.4046),
    (8.6116, 42.4038),
    (8.6144, 42.3743),
    (8.5780, 42.3684),
    (8.5748, 42.3583),
    (8.5514, 42.3668),
    (8.5490, 42.3549),
]


app = FastAPI(title="ObjectiFoudre", version=APP_VERSION)
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=False,
    allow_methods=["GET", "POST"],
    allow_headers=["*"],
)
app.add_middleware(GZipMiddleware, minimum_size=1024)
app.mount("/static", StaticFiles(directory=str(STATIC_DIR)), name="static")

# --- Gating des endpoints de diagnostic ---------------------------------------
# Ces routes sont des sondes de développement (probe/test/sample/decoder et les
# variantes de grille « brutes » non utilisées par le client). Elles restent
# inaccessibles en production sauf si OBJECTIFOUDRE_ENABLE_DEBUG_ENDPOINTS est
# activé. Le client de prod ne consomme aucune de ces routes ; on renvoie 404
# (et non 403) pour ne pas révéler leur existence.
DEBUG_ENDPOINTS_ENABLED = os.environ.get("OBJECTIFOUDRE_ENABLE_DEBUG_ENDPOINTS", "").strip().lower() in {"1", "true", "yes", "on"}
_DEBUG_ONLY_PATHS = frozenset({
    "/api/meteofrance/grib-decoder-status",
    "/api/meteofrance/test-key",
    "/api/meteofrance/sample-coverage",
    "/api/meteofrance/probe-multitime-coverage",
    "/api/meteofrance/probe-model-packages",
    "/api/meteofrance/probe-grib-package",
    "/api/meteofrance/probe-grib-full-package",
    "/api/meteofrance/probe-grib-index",
    "/api/meteofrance/probe-grib-profile",
    "/api/meteofrance/probe-grib-target-message",
    "/api/meteofrance/slot-grid",
    "/api/meteofrance/grib-slot-grid",
    "/api/meteofrance/grib-france-slot-grid",
    "/api/meteofrance/grib-slot-grid-cache",
    "/api/meteofrance/grib-cache-status",
})


@app.middleware("http")
async def _gate_debug_endpoints(request, call_next):
    if not DEBUG_ENDPOINTS_ENABLED and request.url.path in _DEBUG_ONLY_PATHS:
        return PlainTextResponse("Not Found", status_code=404)
    return await call_next(request)

_cache: dict[str, dict[str, Any]] = {}
_inflight: dict[str, asyncio.Task] = {}
_lock = asyncio.Lock()
_grib_auto_preload_jobs: dict[str, dict[str, Any]] = {}
_grib_auto_preload_lock = threading.Lock()
_meteofrance_external_request_lock = threading.Lock()
_meteofrance_last_external_request_at = 0.0
_server_arome_automation_lock = threading.Lock()
_server_arome_automation_stop = threading.Event()
_server_arome_automation_thread: threading.Thread | None = None
_lightning_automation_lock = threading.Lock()
_lightning_automation_stop = threading.Event()
_lightning_automation_thread: threading.Thread | None = None
_server_arome_cache_dir_status_lock = threading.Lock()
_server_arome_cache_dir_status_snapshot: dict[str, Any] | None = None
_server_arome_cache_dir_status_snapshot_at = 0.0
_server_arome_cache_cleanup_lock = threading.Lock()
_server_arome_cache_cleanup_last_at = 0.0
_server_arome_automation_state: dict[str, Any] = {
    "enabled": False,
    "running": False,
    "message": "Automatisation AROME serveur inactive.",
    "started_at": None,
    "updated_at": None,
    "last_job_key": None,
    "last_schedule": None,
    "current_job": None,
}


class MeteoFranceKeyTestRequest(BaseModel):
    token: str = Field(..., min_length=8, max_length=4096)


class MeteoFranceCoverageSampleRequest(BaseModel):
    token: str = Field(..., min_length=8, max_length=4096)
    lat: float = Field(..., ge=37.5, le=55.4)
    lon: float = Field(..., ge=-12.0, le=16.0)
    half_box_km: float = Field(4.0, ge=0.5, le=30.0)


class MeteoFranceMultiTimeCoverageProbeRequest(BaseModel):
    token: str = Field(..., min_length=8, max_length=4096)
    lat: float = Field(..., ge=37.5, le=55.4)
    lon: float = Field(..., ge=-12.0, le=16.0)
    date: Date
    start_hour: int = Field(0, ge=0, le=23)
    end_hour: int = Field(23, ge=0, le=23)
    half_box_km: float = Field(4.0, ge=0.5, le=30.0)


class MeteoFranceModelPackageProbeRequest(BaseModel):
    token: str = Field(..., min_length=8, max_length=4096)
    grid: str | None = Field(None, max_length=24)
    inspect_all: bool = False
    max_inspected_packages: int = Field(3, ge=1, le=12)


class MeteoFranceGribPackageProbeRequest(BaseModel):
    token: str = Field(..., min_length=8, max_length=4096)
    grid: str | None = Field(None, max_length=24)
    package_id: str = Field("SP1", min_length=1, max_length=32)
    time_group: str | None = Field(None, max_length=32)
    range_bytes: int = Field(METEOFRANCE_MODEL_PACKAGE_PROBE_RANGE_BYTES, ge=4096, le=262144)


class MeteoFranceGribFullPackageProbeRequest(BaseModel):
    token: str = Field(..., min_length=8, max_length=4096)
    grid: str | None = Field(None, max_length=24)
    package_id: str = Field("SP1", min_length=1, max_length=32)
    time_group: str | None = Field("00H06H", max_length=32)
    max_bytes: int = Field(METEOFRANCE_MODEL_PACKAGE_FULL_PROBE_LIMIT_BYTES, ge=1_000_000, le=160_000_000)
    max_messages: int = Field(256, ge=1, le=512)


class MeteoFranceGribIndexProbeRequest(BaseModel):
    token: str = Field(..., min_length=8, max_length=4096)
    grid: str | None = Field(None, max_length=24)
    package_id: str = Field("SP1", min_length=1, max_length=32)
    time_group: str | None = Field(None, max_length=32)
    max_messages: int = Field(32, ge=1, le=96)


class MeteoFranceGribProfileProbeRequest(BaseModel):
    token: str = Field(..., min_length=8, max_length=4096)
    grid: str | None = Field(None, max_length=24)
    package_ids: list[str] | None = Field(None, max_length=8)
    time_group: str | None = Field(None, max_length=32)
    max_messages: int = Field(32, ge=1, le=96)


class MeteoFranceGribTargetMessageRequest(BaseModel):
    token: str = Field(..., min_length=8, max_length=4096)
    grid: str | None = Field(None, max_length=24)
    package_id: str = Field("SP2", min_length=1, max_length=32)
    time_group: str | None = Field("00H06H", max_length=32)
    parameter_label: str = Field("Température", min_length=1, max_length=80)
    level_contains: str | None = Field(None, max_length=80)
    forecast_hour: int | None = Field(0, ge=0, le=72)
    max_messages: int = Field(96, ge=1, le=128)
    lat: float = Field(45.7640, ge=37.5, le=55.4)
    lon: float = Field(4.8357, ge=-12.0, le=16.0)
    label: str = Field(DEFAULT_CENTER_LABEL, min_length=1, max_length=120)
    sample_points: int = Field(9, ge=1, le=169)


class MeteoFranceSlotGridRequest(BaseModel):
    token: str = Field(..., min_length=8, max_length=4096)
    lat: float = Field(..., ge=37.5, le=55.4)
    lon: float = Field(..., ge=-12.0, le=16.0)
    label: str = Field(DEFAULT_CENTER_LABEL, min_length=1, max_length=120)
    date: Date
    hour: int = Field(..., ge=0, le=23)
    detail_level: Literal["core", "advanced", "render"] = METEOFRANCE_SLOT_GRID_CORE_DETAIL


class MeteoFranceGribSlotGridRequest(BaseModel):
    token: str | None = Field(None, min_length=8, max_length=4096)
    lat: float = Field(..., ge=37.5, le=55.4)
    lon: float = Field(..., ge=-12.0, le=16.0)
    label: str = Field(DEFAULT_CENTER_LABEL, min_length=1, max_length=120)
    date: Date
    hour: int = Field(..., ge=0, le=23)
    grid: str | None = Field(None, max_length=24)
    detail_level: Literal["core", "advanced", "render"] = METEOFRANCE_SLOT_GRID_CORE_DETAIL
    cache_only: bool = False


class MeteoFranceGribPreloadRequest(BaseModel):
    token: str = Field(..., min_length=8, max_length=4096)
    lat: float = Field(..., ge=37.5, le=55.4)
    lon: float = Field(..., ge=-12.0, le=16.0)
    label: str = Field(DEFAULT_CENTER_LABEL, min_length=1, max_length=120)
    date: Date
    hour: int = Field(..., ge=0, le=23)
    grid: str | None = Field(None, max_length=24)
    detail_level: Literal["core", "advanced", "render"] = METEOFRANCE_SLOT_GRID_CORE_DETAIL
    scope: Literal["time_group", "day"] = "time_group"
    max_hours: int = Field(8, ge=1, le=24)


class MeteoFranceGribCacheStatusRequest(BaseModel):
    token: str | None = Field(None, min_length=8, max_length=4096)
    lat: float = Field(..., ge=37.5, le=55.4)
    lon: float = Field(..., ge=-12.0, le=16.0)
    label: str = Field(DEFAULT_CENTER_LABEL, min_length=1, max_length=120)
    date: Date
    grid: str | None = Field(None, max_length=24)
    detail_level: Literal["core", "advanced", "render"] = METEOFRANCE_SLOT_GRID_CORE_DETAIL


class ServerAromeAutomationRequest(BaseModel):
    secret: str = Field(..., min_length=8, max_length=4096)


class ServerAromePreloadNowRequest(ServerAromeAutomationRequest):
    date: Date | None = None
    grid: str | None = Field(None, max_length=24)


def _cache_key(lat: float, lon: float, target_date: Date | None) -> str:
    date_key = target_date.isoformat() if target_date is not None else "auto"
    return f"{lat:.4f}:{lon:.4f}:{date_key}"


def _label_cache_key(label: str) -> str:
    normalized = " ".join(label.strip().split()).lower()
    safe = "".join(ch if ch.isalnum() else "-" for ch in normalized)
    return safe[:80] or "zone"


def _latest_cache_key(lat: float, lon: float, target_date: Date | None, mode: str, label: str) -> str:
    return f"latest:{_cache_key(lat, lon, target_date)}:{mode}:label={_label_cache_key(label)}"


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


def _slot_payload_cell_count(payload: dict[str, Any], hour: int) -> int:
    target_slot = f"h{int(hour):02d}"
    for day in payload.get("days", []) if isinstance(payload, dict) else []:
        for slot in day.get("slots", []) if isinstance(day, dict) else []:
            if slot.get("slot_key") == target_slot:
                cells = slot.get("cells")
                return len(cells) if isinstance(cells, list) else 0
    return 0


def _grib_slot_required_fields(detail_level: str = METEOFRANCE_SLOT_GRID_CORE_DETAIL) -> set[str]:
    return {
        str(spec.get("field"))
        for spec in _nwp_slot_grid_specs()
        if spec.get("required") and spec.get("field")
    }


def _grib_slot_grid_result_missing_required_fields(result: dict[str, Any], detail_level: str = METEOFRANCE_SLOT_GRID_CORE_DETAIL) -> list[str]:
    required = _grib_slot_required_fields(detail_level)
    if not required:
        return []
    if not isinstance(result, dict) or not result.get("ok"):
        return sorted(required)
    payload = result.get("payload")
    meta = payload.get("meta", {}) if isinstance(payload, dict) else {}
    if not isinstance(meta, dict):
        return sorted(required)
    missing = {str(item) for item in meta.get("missing_fields") or [] if item}
    field_requests = meta.get("field_requests") or []
    seen_ok = {
        str(item.get("field"))
        for item in field_requests
        if isinstance(item, dict) and item.get("ok") and item.get("field")
    }
    return sorted((required - seen_ok) | (missing & required))


def _grib_slot_grid_result_has_required_fields(result: dict[str, Any], detail_level: str = METEOFRANCE_SLOT_GRID_CORE_DETAIL) -> bool:
    return not _grib_slot_grid_result_missing_required_fields(result, detail_level)


def _mark_grib_slot_grid_cache_hit(result: dict[str, Any], hour: int, *, backend: str, created_at: float | None = None) -> dict[str, Any]:
    out = copy.deepcopy(result)
    out["cache_hit"] = True
    if isinstance(out.get("payload"), dict):
        meta = dict(out["payload"].get("meta", {}))
        cached_total = int(meta.get("cached_total_range_request_count") or meta.get("total_range_request_count") or 0)
        meta["slot_grid_cache_hit"] = True
        meta["slot_grid_cache_backend"] = backend
        meta["slot_grid_cache_ttl_seconds"] = METEOFRANCE_GRIB_SLOT_GRID_CACHE_TTL_SECONDS
        meta["grib_slot_grid_algorithm_version"] = METEOFRANCE_GRIB_SLOT_GRID_ALGORITHM_VERSION
        if created_at is not None:
            age = max(0, int(time.time() - float(created_at)))
            meta["slot_grid_cache_age_seconds"] = age
            meta["slot_grid_cache_expires_in_seconds"] = max(0, METEOFRANCE_GRIB_SLOT_GRID_CACHE_TTL_SECONDS - age)
        meta["cached_total_range_request_count"] = cached_total
        meta["cached_index_range_request_count"] = int(meta.get("cached_index_range_request_count") or meta.get("index_range_request_count") or 0)
        meta["cached_message_range_request_count"] = int(meta.get("cached_message_range_request_count") or meta.get("message_range_request_count") or 0)
        meta["total_range_request_count"] = 0
        meta["index_range_request_count"] = 0
        meta["message_range_request_count"] = 0
        out["payload"]["meta"] = meta
        cell_count = _slot_payload_cell_count(out["payload"], hour)
        grid_label_prefix = "France " if meta.get("grid_scope") == "france" else ""
        out["message"] = f"Grille {grid_label_prefix}Météo-France GRIB servie depuis le cache pour {hour:02d}h : {cell_count} cellules, 0 Range API."
    return out


def _meteofrance_grib_slot_grid_cache_status_sync(
    api_key: str,
    lat: float,
    lon: float,
    label: str,
    target_date: Date,
    requested_grid: str | None = None,
    detail_level: str = METEOFRANCE_SLOT_GRID_CORE_DETAIL,
) -> dict[str, Any]:
    detail_level = METEOFRANCE_SLOT_GRID_CORE_DETAIL
    coverage = _meteofrance_grib_slot_grid_cache_coverage(
        api_key,
        requested_grid,
        lat,
        lon,
        label,
        target_date,
        list(range(24)),
        detail_level,
    )
    cached_hours = [int(item) for item in coverage.get("cached_hours", [])]
    return {
        "ok": True,
        "status": 200,
        "target": "AROME Paquet Modèles GRIB cache serveur",
        "cache_only": True,
        "date": target_date.isoformat(),
        "detail_level": detail_level,
        "hours": coverage.get("hours", []),
        "cached_hours": cached_hours,
        "cached_slot_keys": [f"h{hour:02d}" for hour in cached_hours],
        "missing_hours": coverage.get("missing_hours", []),
        "cached_count": int(coverage.get("ok_count") or 0),
        "hour_count": int(coverage.get("hour_count") or 0),
        "cached_total_range_request_count": int(coverage.get("cached_total_range_request_count") or 0),
        "message": f"{len(cached_hours)} heure(s) AROME GRIB en cache serveur.",
    }


def _meteofrance_grib_france_slot_grid_cache_status_sync(
    api_key: str,
    target_date: Date,
    requested_grid: str | None = None,
    detail_level: str = METEOFRANCE_SLOT_GRID_CORE_DETAIL,
) -> dict[str, Any]:
    detail_level = METEOFRANCE_SLOT_GRID_CORE_DETAIL
    coverage = _meteofrance_grib_france_slot_grid_cache_coverage(
        api_key,
        requested_grid,
        target_date,
        list(range(24)),
        detail_level,
    )
    cached_hours = [int(item) for item in coverage.get("cached_hours", [])]
    run_schedule = _server_arome_run_schedule()
    with _server_arome_automation_lock:
        state = copy.deepcopy(_server_arome_automation_state)
    availability_reference_time, availability_reference_source = _server_arome_availability_reference(state, run_schedule)
    availability = _server_arome_available_hours_for_date(target_date, availability_reference_time, cached_hours)
    available_hours = [int(item) for item in (availability.get("available_hours") or list(range(24))) if 0 <= int(item) <= 23]
    unavailable_hours = [int(item) for item in (availability.get("unavailable_hours") or []) if 0 <= int(item) <= 23]
    return {
        "ok": True,
        "status": 200,
        "target": "AROME Paquet Modèles GRIB cache France serveur",
        "cache_only": True,
        "grid_scope": "france",
        "france_grid": True,
        "date": target_date.isoformat(),
        "detail_level": detail_level,
        "hours": coverage.get("hours", []),
        "cached_hours": cached_hours,
        "cached_slot_keys": [f"h{hour:02d}" for hour in cached_hours],
        "available_hours": available_hours,
        "available_slot_keys": [f"h{hour:02d}" for hour in available_hours],
        "unavailable_hours": unavailable_hours,
        "unavailable_slot_keys": [f"h{hour:02d}" for hour in unavailable_hours],
        "partial_availability": len(available_hours) < 24,
        "availability_reference_time": availability.get("reference_time"),
        "availability_until": availability.get("available_until"),
        "availability_source": availability.get("source"),
        "availability_reference_source": availability_reference_source,
        "forecast_horizon_hours": availability.get("forecast_horizon_hours"),
        "missing_hours": [hour for hour in available_hours if hour not in cached_hours],
        "cached_count": len([hour for hour in available_hours if hour in cached_hours]),
        "hour_count": len(available_hours),
        "calendar_hour_count": 24,
        "cached_total_range_request_count": int(coverage.get("cached_total_range_request_count") or 0),
        "message": f"{len(cached_hours)} heure(s) AROME GRIB France en cache serveur.",
    }


def _get_meteofrance_grib_slot_grid_cached_sync(
    api_key: str,
    lat: float,
    lon: float,
    label: str,
    target_date: Date,
    hour: int,
    requested_grid: str | None = None,
    detail_level: str = METEOFRANCE_SLOT_GRID_CORE_DETAIL,
) -> dict[str, Any]:
    detail_level = METEOFRANCE_SLOT_GRID_CORE_DETAIL
    target = "AROME Paquet Modèles GRIB cache serveur"
    cache_key = _meteofrance_grib_slot_grid_cache_key(api_key, requested_grid, lat, lon, label, target_date, hour, detail_level)
    cached = _get_cached_value(cache_key, ttl=METEOFRANCE_GRIB_SLOT_GRID_CACHE_TTL_SECONDS)
    if cached is not None and _grib_slot_grid_result_has_required_fields(cached["payload"], detail_level):
        return _mark_grib_slot_grid_cache_hit(cached["payload"], hour, backend="memory", created_at=float(cached["ts"]))

    persistent = _read_meteofrance_local_persistent_cache(
        "grib-slot-grid",
        cache_key,
        METEOFRANCE_GRIB_SLOT_GRID_CACHE_TTL_SECONDS,
    )
    if persistent is not None and _grib_slot_grid_result_has_required_fields(persistent["payload"], detail_level):
        _set_cached_value(cache_key, persistent["payload"])
        return _mark_grib_slot_grid_cache_hit(persistent["payload"], hour, backend="disk", created_at=float(persistent["ts"]))

    return {
        "ok": False,
        "status": 404,
        "target": target,
        "cache_only": True,
        "total_range_request_count": 0,
        "index_range_request_count": 0,
        "message_range_request_count": 0,
        "message": f"Aucune grille Météo-France GRIB en cache pour {hour:02d}h.",
    }


def _get_meteofrance_grib_france_slot_grid_cached_sync(
    api_key: str,
    target_date: Date,
    hour: int,
    requested_grid: str | None = None,
    detail_level: str = METEOFRANCE_SLOT_GRID_CORE_DETAIL,
) -> dict[str, Any]:
    detail_level = METEOFRANCE_SLOT_GRID_CORE_DETAIL
    target = "AROME Paquet Modèles GRIB cache France serveur"
    cache_key = _meteofrance_grib_france_slot_grid_cache_key(api_key, requested_grid, target_date, hour, detail_level)
    cached = _get_cached_value(cache_key, ttl=METEOFRANCE_GRIB_SLOT_GRID_CACHE_TTL_SECONDS)
    if cached is not None and _grib_slot_grid_result_has_required_fields(cached["payload"], detail_level):
        return _mark_grib_slot_grid_cache_hit(cached["payload"], hour, backend="memory", created_at=float(cached["ts"]))

    persistent = _read_meteofrance_local_persistent_cache(
        "grib-france-slot-grid",
        cache_key,
        METEOFRANCE_GRIB_SLOT_GRID_CACHE_TTL_SECONDS,
    )
    if persistent is not None and _grib_slot_grid_result_has_required_fields(persistent["payload"], detail_level):
        _set_cached_value(cache_key, persistent["payload"])
        return _mark_grib_slot_grid_cache_hit(persistent["payload"], hour, backend="disk", created_at=float(persistent["ts"]))

    return {
        "ok": False,
        "status": 404,
        "target": target,
        "cache_only": True,
        "grid_scope": "france",
        "france_grid": True,
        "total_range_request_count": 0,
        "index_range_request_count": 0,
        "message_range_request_count": 0,
        "message": f"Aucune grille France Météo-France GRIB en cache pour {hour:02d}h.",
    }

def _get_meteofrance_grib_france_day_cached_sync(
    api_key: str,
    target_date: Date,
    requested_grid: str | None = None,
    detail_level: str = METEOFRANCE_SLOT_GRID_CORE_DETAIL,
) -> dict[str, Any]:
    detail_level = METEOFRANCE_SLOT_GRID_CORE_DETAIL
    target = "AROME Paquet Modèles GRIB cache France serveur"
    slots: list[dict[str, Any]] = []
    cached_hours: list[int] = []
    missing_hours: list[int] = []
    first_meta: dict[str, Any] = {}
    total_cached_range = 0

    for hour in range(24):
        result = _get_meteofrance_grib_france_slot_grid_cached_sync(
            api_key,
            target_date,
            hour,
            requested_grid=requested_grid,
            detail_level=detail_level,
        )
        payload = result.get("payload") if isinstance(result.get("payload"), dict) else {}
        days = payload.get("days") if isinstance(payload, dict) else []
        day = days[0] if isinstance(days, list) and days else {}
        day_slots = day.get("slots") if isinstance(day, dict) else []
        slot = day_slots[0] if isinstance(day_slots, list) and day_slots else None
        if result.get("ok") and isinstance(slot, dict):
            slots.append(slot)
            cached_hours.append(hour)
            meta = payload.get("meta") if isinstance(payload.get("meta"), dict) else {}
            if not first_meta:
                first_meta = copy.deepcopy(meta)
            total_cached_range += int(meta.get("cached_total_range_request_count") or result.get("cached_total_range_request_count") or 0)
        else:
            missing_hours.append(hour)

    meta = {
        **first_meta,
        "provider": "meteofrance_arome_grib",
        "source_provider": "meteofrance_arome_grib",
        "source_label": "Météo-France AROME GRIB cache",
        "target": target,
        "requested_date": target_date.isoformat(),
        "detail_level": detail_level,
        "cache_only": True,
        "batch_cache": True,
        "grid_scope": "france",
        "france_grid": True,
        "country_mask": "france",
        "cached_hours": cached_hours,
        "missing_hours": missing_hours,
        "cached_total_range_request_count": total_cached_range,
    }
    payload = {
        "meta": meta,
        "days": [
            {
                "day_key": target_date.isoformat(),
                "day_label": target_date.isoformat(),
                "day_index": 0,
                "slots": slots,
            }
        ],
    }
    return {
        "ok": bool(slots),
        "status": 200 if slots else 404,
        "target": target,
        "cache_only": True,
        "grid_scope": "france",
        "france_grid": True,
        "date": target_date.isoformat(),
        "detail_level": detail_level,
        "cached_hours": cached_hours,
        "cached_slot_keys": [f"h{hour:02d}" for hour in cached_hours],
        "missing_hours": missing_hours,
        "cached_count": len(cached_hours),
        "hour_count": 24,
        "payload": payload if slots else None,
        "message": f"{len(cached_hours)}/24 heure(s) AROME GRIB France servies en lot depuis le cache serveur.",
    }


def _distance_km(a_lat: float, a_lon: float, b_lat: float, b_lon: float) -> float:
    dx = (a_lon - b_lon) * 111.0 * math.cos(math.radians((a_lat + b_lat) / 2))
    dy = (a_lat - b_lat) * 111.0
    return math.hypot(dx, dy)


def _nearest_recent_cache(lat: float, lon: float, target_date: Date | None, mode: str, ttl: int = STALE_TTL_SECONDS, max_distance_km: float = 80.0):
    now = time.time()
    best = None
    best_dist = None
    target_date_key = target_date.isoformat() if target_date is not None else "auto"
    for key, entry in _cache.items():
        if not key.startswith("latest:"):
            continue
        if (now - float(entry["ts"])) >= ttl:
            continue
        try:
            parts = key.split(":")
            if len(parts) < 5:
                continue
            _, e_lat_s, e_lon_s, e_date_key, e_mode = parts[:5]
            if e_mode != mode:
                continue
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


def _cache_status(hit: bool, backend: str, created_at: float | None, ttl: int) -> dict[str, Any]:
    now = time.time()
    ts = float(created_at if created_at is not None else now)
    age = max(0, int(now - ts))
    return {
        "hit": hit,
        "backend": backend,
        "ttl_seconds": ttl,
        "created_at_epoch": ts,
        "age_seconds": age,
        "expires_in_seconds": max(0, ttl - age),
    }


def _stable_cache_hash(value: str) -> str:
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


def _meteofrance_persistent_cache_enabled(source_url: str | None) -> bool:
    if not source_url:
        return False
    host = urllib.parse.urlparse(source_url).netloc.lower()
    return host.endswith("meteofrance.fr")


def _meteofrance_persistent_cache_path(namespace: str, key: str) -> Path:
    safe_namespace = "".join(ch if ch.isalnum() or ch in {"-", "_"} else "-" for ch in namespace) or "cache"
    return METEOFRANCE_PERSISTENT_CACHE_DIR / safe_namespace / f"{_stable_cache_hash(key)}.json"


def _read_meteofrance_persistent_cache(namespace: str, key: str, ttl: int, source_url: str | None = None) -> dict[str, Any] | None:
    if not _meteofrance_persistent_cache_enabled(source_url):
        return None
    path = _meteofrance_persistent_cache_path(namespace, key)
    try:
        entry = json.loads(path.read_text(encoding="utf-8"))
        created_at = float(entry.get("ts") or 0)
    except Exception:
        return None
    if created_at <= 0 or (time.time() - created_at) >= ttl or "payload" not in entry:
        return None
    return {"ts": created_at, "payload": entry["payload"], "path": str(path)}


def _write_meteofrance_persistent_cache(namespace: str, key: str, payload: Any, source_url: str | None = None) -> None:
    if not _meteofrance_persistent_cache_enabled(source_url):
        return
    path = _meteofrance_persistent_cache_path(namespace, key)
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        tmp_path = path.with_suffix(".json.tmp")
        tmp_path.write_text(
            json.dumps({"ts": time.time(), "payload": payload}, ensure_ascii=False, separators=(",", ":")),
            encoding="utf-8",
        )
        tmp_path.replace(path)
    except Exception:
        return


def _read_meteofrance_local_persistent_cache(namespace: str, key: str, ttl: int) -> dict[str, Any] | None:
    path = _meteofrance_persistent_cache_path(namespace, key)
    try:
        entry = json.loads(path.read_text(encoding="utf-8"))
        created_at = float(entry.get("ts") or 0)
    except Exception:
        return None
    if created_at <= 0 or (time.time() - created_at) >= ttl or "payload" not in entry:
        return None
    return {"ts": created_at, "payload": entry["payload"], "path": str(path)}


def _write_meteofrance_local_persistent_cache(namespace: str, key: str, payload: Any) -> None:
    path = _meteofrance_persistent_cache_path(namespace, key)
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        tmp_path = path.with_suffix(".json.tmp")
        tmp_path.write_text(
            json.dumps({"ts": time.time(), "payload": payload}, ensure_ascii=False, separators=(",", ":")),
            encoding="utf-8",
        )
        tmp_path.replace(path)
    except Exception:
        return


# --- Historique de grille -----------------------------------------------------
# On persiste chaque grille France fraîchement calculée hors du cache TTL, pour
# pouvoir rouvrir d'anciennes prévisions (et plus tard les comparer au réel).
# Rétention : dernier run AROME par (date, créneau) — un run plus récent écrase.
HISTORY_SCHEMA_VERSION = 1
_history_last_prune_at = 0.0
_history_prune_lock = threading.Lock()
# Cache des réponses /api/history/day déjà sérialisées (date -> octets JSON slim).
# Évite de re-décompresser 24 archives + re-sérialiser à chaque ouverture.
# Invalidé pour une date dès qu'un nouveau créneau y est archivé.
_history_day_bytes_cache: dict[str, bytes] = {}
_history_day_cache_lock = threading.Lock()


def _is_iso_date(value: Any) -> bool:
    return (
        isinstance(value, str)
        and len(value) == 10
        and value[4] == "-"
        and value[7] == "-"
        and value[:4].isdigit()
        and value[5:7].isdigit()
        and value[8:10].isdigit()
    )


def _history_now_iso() -> str:
    return datetime.now(OBJECTIFOUDRE_SERVER_TIMEZONE).isoformat()


def _history_slot_path(date_str: str, hour: int) -> Path:
    return OBJECTIFOUDRE_HISTORY_DIR / "france" / date_str / f"h{int(hour):02d}.json.gz"


def _write_history_gzip(path: Path, obj: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp_path = path.with_suffix(".gz.tmp")
    data = json.dumps(obj, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    with gzip.open(tmp_path, "wb") as handle:
        handle.write(data)
    tmp_path.replace(path)


def _read_history_gzip(path: Path) -> dict[str, Any] | None:
    with gzip.open(path, "rb") as handle:
        return json.loads(handle.read().decode("utf-8"))


def _archive_france_slot_grid(result: dict[str, Any]) -> None:
    """Persist a freshly computed France slot grid into the durable history store.
    Keeps only the latest AROME run per (date, slot). Never raises: archiving must
    never break the request path."""
    if not OBJECTIFOUDRE_HISTORY_ENABLED:
        return
    try:
        if not isinstance(result, dict) or not result.get("ok"):
            return
        payload = result.get("payload")
        if not isinstance(payload, dict):
            return
        meta = payload.get("meta") if isinstance(payload.get("meta"), dict) else {}
        if meta.get("grid_scope") != "france":
            return
        date_str = str(meta.get("requested_date") or "").strip()
        hour = meta.get("requested_hour")
        if not _is_iso_date(date_str) or not isinstance(hour, int) or not (0 <= hour <= 23):
            return
        days = payload.get("days") if isinstance(payload.get("days"), list) else []
        day = days[0] if days else {}
        day_slots = day.get("slots") if isinstance(day, dict) else []
        slot = day_slots[0] if isinstance(day_slots, list) and day_slots else None
        if not isinstance(slot, dict) or not slot.get("cells"):
            return  # no real grid -> nothing worth archiving
        new_cell_count = len(slot.get("cells") or [])
        run_ref = str(meta.get("arome_run_latest_reference_time") or "")
        path = _history_slot_path(date_str, hour)
        # Garde-fou anti-grille dégénérée : une grille France complète ≈ 2636 cellules. Un
        # build tronqué (ex. 13×13 = 169 cellules d'un carré central) ne doit JAMAIS être
        # archivé ni écraser une grille plus riche, même avec un run plus récent — c'est la
        # cause du « trou carré » observé dans l'archive.
        MIN_FRANCE_GRID_CELLS = 800
        if path.exists():
            try:
                existing = _read_history_gzip(path)
            except Exception:
                existing = None
            if isinstance(existing, dict):
                existing_run = str(existing.get("run_reference_time") or "")
                if existing_run and run_ref and run_ref < existing_run:
                    return  # incoming AROME run is older than the archived one
                try:
                    existing_slot = (((existing.get("payload") or {}).get("days") or [{}])[0].get("slots") or [{}])[0]
                    existing_cell_count = len(existing_slot.get("cells") or [])
                except Exception:
                    existing_cell_count = 0
                if existing_cell_count and new_cell_count < max(MIN_FRANCE_GRID_CELLS, existing_cell_count // 2):
                    return  # grille entrante anormalement pauvre -> on garde l'existante
        if new_cell_count < MIN_FRANCE_GRID_CELLS:
            return  # grille dégénérée -> ne pas archiver du tout
        record = {
            "schema": HISTORY_SCHEMA_VERSION,
            "date": date_str,
            "slot_key": meta.get("requested_slot") or f"h{hour:02d}",
            "hour": hour,
            "run_reference_time": run_ref,
            "algorithm_version": meta.get("grib_slot_grid_algorithm_version"),
            "generated_at": meta.get("generated_at"),
            "archived_at": _history_now_iso(),
            "payload": payload,
        }
        _write_history_gzip(path, record)
        with _history_day_cache_lock:
            _history_day_bytes_cache.pop(date_str, None)
        # la prévision du jour a changé -> caches dérivés obsolètes
        _forecast_cells_cache.pop(date_str, None)
        _verification_cache.pop(date_str, None)
        _prune_history_dirs()
    except Exception:
        pass


def _prune_history_dirs(now: float | None = None) -> None:
    """Drop history date folders older than the retention window. Throttled to
    once per hour; never raises."""
    global _history_last_prune_at
    current = now or time.time()
    with _history_prune_lock:
        if current - _history_last_prune_at < 3600:
            return
        _history_last_prune_at = current
    try:
        base = OBJECTIFOUDRE_HISTORY_DIR / "france"
        if not base.is_dir():
            return
        cutoff = (
            datetime.now(OBJECTIFOUDRE_SERVER_TIMEZONE).date()
            - timedelta(days=OBJECTIFOUDRE_HISTORY_RETENTION_DAYS)
        ).isoformat()
        for child in base.iterdir():
            if child.is_dir() and _is_iso_date(child.name) and child.name < cutoff:
                shutil.rmtree(child, ignore_errors=True)
    except Exception:
        pass


# Champs conservés en mode « slim » : juste ce qu'il faut au rendu de la grille
# colorée + une synthèse minimale. On écarte les gros objets imbriqués par cellule
# (metrics_used, metric_scores, category_breakdown, diagnostics, summary…) qui
# faisaient exploser la réponse à ~195 Mo. Les floats sont arrondis pour alléger.
_HISTORY_SLIM_CELL_FIELDS = (
    "zone", "lat", "lon", "cell_height_deg", "cell_width_deg",
    "trigger_score", "confidence_score",
    "mucape", "temp_c", "dewpoint_c", "wind_gusts_10m",
    "source_provider",
)


def _history_round(value: Any) -> Any:
    if isinstance(value, float):
        return round(value, 3)
    return value


def _history_project_slot(slot: dict[str, Any]) -> dict[str, Any]:
    cells = slot.get("cells")
    if not isinstance(cells, list):
        return slot
    projected = {key: value for key, value in slot.items() if key != "cells"}
    projected["cells"] = [
        {field: _history_round(cell[field]) for field in _HISTORY_SLIM_CELL_FIELDS if field in cell}
        for cell in cells if isinstance(cell, dict)
    ]
    return projected


def _list_history_dates() -> list[dict[str, Any]]:
    base = OBJECTIFOUDRE_HISTORY_DIR / "france"
    out: list[dict[str, Any]] = []
    if not base.is_dir():
        return out
    for child in base.iterdir():
        if not child.is_dir() or not _is_iso_date(child.name):
            continue
        slot_files = sorted(child.glob("h*.json.gz"))
        if not slot_files:
            continue
        out.append({
            "date": child.name,
            "slot_count": len(slot_files),
            "slot_keys": [path.name.split(".")[0] for path in slot_files],
        })
    out.sort(key=lambda item: item["date"], reverse=True)
    return out


def _get_history_france_day_sync(date_str: str, slim: bool = True) -> dict[str, Any]:
    """Assemble an archived day from its per-slot files, in the same shape the
    live grib-france-day-cache returns, so the existing grid renderer can show it.
    `slim` (default) projects cells to render+summary fields only — the faithful
    archive keeps everything, but the full day is ~195 Mo and must not be shipped."""
    slots: list[dict[str, Any]] = []
    cached_hours: list[int] = []
    missing_hours: list[int] = []
    first_meta: dict[str, Any] = {}
    run_refs: set[str] = set()
    for hour in range(24):
        path = _history_slot_path(date_str, hour)
        record = None
        if path.exists():
            try:
                record = _read_history_gzip(path)
            except Exception:
                record = None
        payload = record.get("payload") if isinstance(record, dict) and isinstance(record.get("payload"), dict) else {}
        days = payload.get("days") if isinstance(payload.get("days"), list) else []
        day = days[0] if days else {}
        day_slots = day.get("slots") if isinstance(day, dict) else []
        slot = day_slots[0] if isinstance(day_slots, list) and day_slots else None
        if record and isinstance(slot, dict):
            slots.append(_history_project_slot(slot) if slim else slot)
            cached_hours.append(hour)
            if not first_meta:
                first_meta = copy.deepcopy(payload.get("meta") if isinstance(payload.get("meta"), dict) else {})
            if record.get("run_reference_time"):
                run_refs.add(str(record["run_reference_time"]))
        else:
            missing_hours.append(hour)
    meta = {
        **first_meta,
        "provider": "meteofrance_arome_grib",
        "source_provider": "meteofrance_arome_grib",
        "source_label": "Historique ObjectiFoudre (archive)",
        "requested_date": date_str,
        "grid_scope": "france",
        "france_grid": True,
        "country_mask": "france",
        "history": True,
        "cached_hours": cached_hours,
        "missing_hours": missing_hours,
        "archived_runs": sorted(run_refs),
    }
    payload = {
        "meta": meta,
        "days": [{
            "day_key": date_str,
            "day_label": date_str,
            "day_index": 0,
            "slots": slots,
        }],
    }
    return {
        "ok": bool(slots),
        "status": 200 if slots else 404,
        "history": True,
        "grid_scope": "france",
        "france_grid": True,
        "date": date_str,
        "cached_hours": cached_hours,
        "cached_slot_keys": [f"h{hour:02d}" for hour in cached_hours],
        "missing_hours": missing_hours,
        "cached_count": len(cached_hours),
        "hour_count": 24,
        "payload": payload if slots else None,
        "archived_runs": sorted(run_refs),
        "message": (
            f"{len(cached_hours)}/24 créneau(x) archivé(s) pour {date_str}."
            if slots else f"Aucune grille archivée pour {date_str}."
        ),
    }


# --- Vérification prévision vs réalité (foudre MTG-LI) ------------------------
def _lightning_archive_path(date_str: str) -> Path:
    return OBJECTIFOUDRE_HISTORY_DIR / "lightning" / "france" / f"{date_str}.json.gz"


def _read_lightning_archive(date_str: str) -> dict[str, Any] | None:
    path = _lightning_archive_path(date_str)
    if not path.exists():
        return None
    try:
        return _read_history_gzip(path)
    except Exception:
        return None


# Caches (invalidés quand un créneau prévu est archivé, ou la foudre re-collectée).
_forecast_cells_cache: dict[str, list[dict[str, Any]]] = {}
_verification_cache: dict[str, dict[str, Any]] = {}


def _forecast_day_cells(date_str: str) -> list[dict[str, Any]]:
    """Cellules prévues du jour avec leur trigger_score MAX sur les 24 créneaux
    (« a-t-on prévu un orage ici à un moment de la journée ? »). Mis en cache : la
    décompression des 24 archives est coûteuse."""
    cached = _forecast_cells_cache.get(date_str)
    if cached is not None:
        return cached
    day_payload = _get_history_france_day_sync(date_str, slim=True)
    if not day_payload.get("ok"):
        return []
    days = day_payload.get("payload", {}).get("days", [])
    slots = days[0].get("slots", []) if days else []
    by_key: dict[str, dict[str, Any]] = {}
    for slot in slots:
        for cell in (slot.get("cells") or []):
            lat = cell.get("lat")
            lon = cell.get("lon")
            if lat is None or lon is None:
                continue
            key = verification.cell_key(lat, lon)
            try:
                score = float(cell.get("trigger_score") or 0)
            except (TypeError, ValueError):
                score = 0.0
            existing = by_key.get(key)
            if existing is None:
                by_key[key] = {
                    "lat": lat,
                    "lon": lon,
                    "cell_height_deg": cell.get("cell_height_deg"),
                    "cell_width_deg": cell.get("cell_width_deg"),
                    "trigger_score": score,
                }
            elif score > existing["trigger_score"]:
                existing["trigger_score"] = score
    cells = list(by_key.values())
    if cells:
        _forecast_cells_cache[date_str] = cells
        while len(_forecast_cells_cache) > 8:
            _forecast_cells_cache.pop(next(iter(_forecast_cells_cache)))
    return cells


_eumdac_token_state: dict[str, Any] = {"token": None, "exp": 0.0}
_eumdac_token_lock = threading.Lock()
LI_FLASH_COLLECTION = "EO:EUM:DAT:0691"  # « LI Lightning Flashes - MTG - 0 degree »


def _eumdac_token() -> str | None:
    """Jeton OAuth EUMETSAT (client_credentials), mis en cache ~1 h."""
    if not (EUMETSAT_CONSUMER_KEY and EUMETSAT_CONSUMER_SECRET):
        return None
    with _eumdac_token_lock:
        now = time.time()
        if _eumdac_token_state["token"] and now < float(_eumdac_token_state["exp"]) - 60:
            return _eumdac_token_state["token"]
        auth = base64.b64encode(f"{EUMETSAT_CONSUMER_KEY}:{EUMETSAT_CONSUMER_SECRET}".encode()).decode()
        req = urllib.request.Request(
            "https://api.eumetsat.int/token",
            data=b"grant_type=client_credentials",
            headers={"Authorization": f"Basic {auth}", "Content-Type": "application/x-www-form-urlencoded"},
            method="POST",
        )
        with urllib.request.urlopen(req, timeout=30) as resp:
            data = json.loads(resp.read().decode("utf-8"))
        token = data.get("access_token")
        _eumdac_token_state["token"] = token
        _eumdac_token_state["exp"] = now + float(data.get("expires_in") or 3000)
        return token


def _eumdac_search_flash_links(date_str: str) -> list[str]:
    """URLs de téléchargement des produits LI Flashes couvrant la journée UTC."""
    token = _eumdac_token()
    if not token:
        return []
    dtstart = f"{date_str}T00:00:00Z"
    dtend = (Date.fromisoformat(date_str) + timedelta(days=1)).isoformat() + "T00:00:00Z"
    links: list[str] = []
    start_index = 0
    for _ in range(40):  # garde-fou pagination (~144 produits/jour)
        url = (
            "https://api.eumetsat.int/data/search-products/1.0.0/os?format=json"
            f"&pi={LI_FLASH_COLLECTION}&dtstart={dtstart}&dtend={dtend}"
            f"&si={start_index}&c=100"
        )
        req = urllib.request.Request(url, headers={"Authorization": f"Bearer {token}"})
        with urllib.request.urlopen(req, timeout=45) as resp:
            payload = json.loads(resp.read().decode("utf-8"))
        feats = payload.get("features", [])
        for feat in feats:
            data_links = (feat.get("properties", {}).get("links", {}) or {}).get("data") or []
            if data_links and data_links[0].get("href"):
                links.append(data_links[0]["href"])
        total = int(payload.get("totalResults") or 0)
        start_index += len(feats)
        if not feats or start_index >= total:
            break
    return links


def _eumdac_extract_france_flashes(zip_bytes: bytes, offset_seconds: float = 0.0) -> list[tuple[float, float, int]]:
    """D'un produit (zip -> .nc CHK-BODY) : flashs dans la bbox France, en
    (lat, lon, heure_locale). lat/lon sont des int16 scalés (CF) : degrés = raw *
    scale_factor + add_offset. flash_time = secondes depuis 2000-01-01 UTC -> on
    ajoute offset_seconds (UTC->Paris) puis on en tire l'heure locale 0-23."""
    import h5py
    import numpy as np

    try:
        with zipfile.ZipFile(io.BytesIO(zip_bytes)) as archive:
            body = next((n for n in archive.namelist() if "CHK-BODY" in n and n.endswith(".nc")), None)
            if not body:
                return []
            nc_bytes = archive.read(body)
    except Exception:
        return []

    def _scalar(value: Any) -> float | None:
        arr = np.asarray(value).ravel()
        return float(arr[0]) if arr.size else None

    def _decode(handle, name: str):
        dataset = handle[name]
        raw = dataset[:].astype("f8")
        fill = _scalar(dataset.attrs.get("_FillValue"))
        scale = _scalar(dataset.attrs.get("scale_factor"))
        offset = _scalar(dataset.attrs.get("add_offset"))
        if fill is not None:
            raw = np.where(raw == fill, np.nan, raw)
        if scale:
            raw = raw * scale
        if offset:
            raw = raw + offset
        return raw

    tmp_path = None
    try:
        with tempfile.NamedTemporaryFile(suffix=".nc", delete=False) as tmp:
            tmp.write(nc_bytes)
            tmp_path = tmp.name
        with h5py.File(tmp_path, "r") as handle:
            if "latitude" not in handle or "longitude" not in handle:
                return []
            lat = _decode(handle, "latitude")
            lon = _decode(handle, "longitude")
            if "flash_time" in handle:
                ftime = np.nan_to_num(handle["flash_time"][:].astype("f8"), nan=0.0)
            else:
                ftime = np.zeros_like(lat)
    except Exception:
        return []
    finally:
        if tmp_path:
            try:
                os.unlink(tmp_path)
            except OSError:
                pass

    west, south, east, north = FRANCE_LIGHTNING_BBOX
    mask = (
        (lon >= west) & (lon <= east) & (lat >= south) & (lat <= north)
        & np.isfinite(lat) & np.isfinite(lon)
    )
    hours = (np.floor((ftime + offset_seconds) / 3600.0) % 24).astype(int)
    return [
        (round(float(la), 4), round(float(lo), 4), int(h))
        for la, lo, h in zip(lat[mask].tolist(), lon[mask].tolist(), hours[mask].tolist())
    ]


def _fetch_mtg_li_flashes_for_date(date_str: str) -> tuple[list[tuple[float, float, float]] | None, str]:
    """Flashs MTG-LI du jour (impacts individuels) sur la bbox France, via le Data
    Store EUMETSAT (collection LI Lightning Flashes, fichiers full-disk de 10 min).
    Retour (flashs|None, status). Ne lève pas."""
    if not (EUMETSAT_CONSUMER_KEY and EUMETSAT_CONSUMER_SECRET):
        return None, "eumdac_not_configured"
    for module_name in ("h5py", "numpy"):
        try:
            importlib.import_module(module_name)
        except ModuleNotFoundError as exc:
            if exc.name == module_name:
                return None, f"{module_name}_not_installed"
            return None, f"{module_name}_dependency_missing:{exc.name or 'unknown'}"
        except Exception as exc:
            return None, f"{module_name}_import_failed:{type(exc).__name__}"
    try:
        if not _eumdac_token():
            return None, "auth_failed"
        links = _eumdac_search_flash_links(date_str)
    except Exception as exc:
        return None, f"fetch_failed:{type(exc).__name__}"
    if not links:
        return [], "no_products"
    try:
        offset_seconds = datetime(
            int(date_str[:4]), int(date_str[5:7]), int(date_str[8:10]), 12,
            tzinfo=OBJECTIFOUDRE_SERVER_TIMEZONE,
        ).utcoffset().total_seconds()
    except Exception:
        offset_seconds = 0.0
    flashes: list[tuple[float, float, int]] = []
    for href in links:
        try:
            req = urllib.request.Request(href, headers={"Authorization": f"Bearer {_eumdac_token()}"})
            with urllib.request.urlopen(req, timeout=120) as resp:
                zip_bytes = resp.read()
            flashes.extend(_eumdac_extract_france_flashes(zip_bytes, offset_seconds))
        except Exception:
            continue
    return flashes, "ok"


def _build_lightning_archive_for_date(
    date_str: str,
    flashes: list[tuple[float, float, float]] | None = None,
) -> dict[str, Any]:
    """Construit l'archive foudre du jour : agrège les flashs sur la grille prévue
    (mêmes clés de cellule) -> {cell_key: count}, puis l'écrit. `flashes` peut être
    injecté directement (test) ; sinon on tente MTG-LI."""
    source = "mtg-li"
    if flashes is None:
        flashes, status = _fetch_mtg_li_flashes_for_date(date_str)
        if flashes is None:
            return {"ok": False, "date": date_str, "reason": status}
        if status == "no_products":
            # aucune donnée d'observation (date future ou indisponible) : on n'écrit
            # pas d'archive « 0 flash » qui fausserait la vérification.
            return {"ok": False, "date": date_str, "reason": "no_products"}
        source = status if status != "ok" else source
    else:
        source = "injected"
    cells = _forecast_day_cells(date_str)
    if not cells:
        return {"ok": False, "date": date_str, "reason": "no_forecast_archived"}
    # Agrégation pour le SCORE : (lat, lon) seulement (l'heure n'est pas un poids).
    per_cell = verification.bin_flashes_to_cells([(f[0], f[1]) for f in flashes], cells)
    total = round(sum(per_cell.values()), 1)
    # Points individuels pour la VISUALISATION : (lat, lon, heure_locale) pour
    # l'overlay synchronisé à l'animation. Masqués à la France (dans une cellule)
    # pour ne pas afficher la plaine du Pô attrapée par la bbox. Downsample si gros.
    france_flashes = verification.flashes_within_cells(flashes, cells)
    points = [
        [round(float(f[0]), 3), round(float(f[1]), 3), int(f[2]) if len(f) > 2 else 0]
        for f in france_flashes
    ]
    point_cap = 25000
    if len(points) > point_cap:
        step = (len(points) // point_cap) + 1
        points = points[::step]
    today_iso = datetime.now(OBJECTIFOUDRE_SERVER_TIMEZONE).date().isoformat()
    record = {
        "schema": 2,
        "date": date_str,
        "source": source,
        "generated_at": _history_now_iso(),
        "final": date_str < today_iso,  # journée complète (données du jour complètes)
        "flash_total": total,
        "touched_cells": len(per_cell),
        "flashes_per_cell": per_cell,
        "points": points,
        "point_count": len(points),
    }
    path = _lightning_archive_path(date_str)
    path.parent.mkdir(parents=True, exist_ok=True)
    _write_history_gzip(path, record)
    _verification_cache.pop(date_str, None)  # la foudre a changé -> recalcul
    return {"ok": True, "date": date_str, "flash_total": total, "touched_cells": len(per_cell), "final": record["final"], "source": source}


def _compute_day_verification(date_str: str) -> dict[str, Any]:
    cached = _verification_cache.get(date_str)
    if cached is not None:
        return cached
    lightning = _read_lightning_archive(date_str)
    if not lightning:
        return {
            "ok": False,
            "date": date_str,
            "reason": "no_observation",
            "message": "Pas encore de foudre observée archivée pour cette date.",
        }
    cells = _forecast_day_cells(date_str)
    if not cells:
        return {
            "ok": False,
            "date": date_str,
            "reason": "no_forecast_archived",
            "message": "Aucune grille prévue archivée pour cette date.",
        }
    result = verification.compute_verification(
        cells, lightning.get("flashes_per_cell") or {},
        score_threshold=_active_score_threshold,
        neighborhood_km=verification.DEFAULT_NEIGHBORHOOD_KM,
    )
    result["date"] = date_str
    result["flash_total"] = lightning.get("flash_total")
    result["observation_source"] = lightning.get("source")
    result["observation_generated_at"] = lightning.get("generated_at")
    _verification_cache[date_str] = result
    while len(_verification_cache) > 16:
        _verification_cache.pop(next(iter(_verification_cache)))
    return result


# --- Auto-calibration & apprentissage (boucle fermée, cf. learning.py) ---------
# Seuil de décision « zones prévues » actif (appris ou défaut). Les poids de mélange
# appris vivent dans weather_logic (set_active_blend_weights). Tout est réversible.
_active_score_threshold: int = verification.DEFAULT_SCORE_THRESHOLD
_learning_lock = threading.Lock()


def _learning_full_day_loader(date_str: str) -> dict[str, Any] | None:
    """Payload FULL d'un jour archivé (cellules avec metric_scores) pour l'apprentissage."""
    result = _get_history_france_day_sync(date_str, slim=False)
    return result.get("payload") if result.get("ok") else None


def _learning_finalized_dates() -> list[str]:
    """Dates RÉVOLUES ET FIGÉES éligibles à l'auto-calibration.

    Un jour n'est utilisé que si SA PRÉVISION et SA FOUDRE sont réellement stables — sinon
    le held-out bouge entre deux évaluations (cf. instabilité CSI constatée). Deux conditions :
    - **Prévision figée** : date STRICTEMENT avant le plus ancien jour préchargé
      (`_server_arome_preload_dates`, par défaut J-1). Le préchargement ré-écrit la grille de
      score de ces jours à chaque run → on ne touche jamais un jour qu'il peut encore réécrire.
    - **Foudre complète** : date ≤ aujourd'hui − 2 (≥ 1 jour plein pour que toutes les tranches
      10 min MTG-LI soient publiées ; déterminisme de la collecte vérifié sur jour figé).
    Le seuil est DÉRIVÉ de la même fonction que l'automatisation → impossible de se
    désynchroniser si la fenêtre de préchargement change. Monotone : un jour ne fait qu'ENTRER
    dans l'ensemble en vieillissant (jamais de va-et-vient)."""
    today = datetime.now(OBJECTIFOUDRE_SERVER_TIMEZONE).date()
    try:
        preload = _server_arome_preload_dates()
    except Exception:
        preload = []
    earliest_preload = min(preload) if preload else (today - timedelta(days=1))
    # min() : avant la fenêtre de préchargement ET au moins 1 jour de marge foudre.
    frozen_cutoff = min(earliest_preload - timedelta(days=1), today - timedelta(days=2))
    cutoff_iso = frozen_cutoff.isoformat()
    dates: list[str] = []
    for item in _list_history_dates():
        d = item.get("date")
        if not d or d > cutoff_iso:    # jour non figé (préchargé/du jour/futur) → exclu
            continue
        light = _read_lightning_archive(d)
        if light and light.get("final"):
            dates.append(d)
    return sorted(dates)


def _learning_data_counts_cheap() -> dict[str, int]:
    """Compteurs de progression sans décompresser les 24 créneaux (lit la foudre seule)."""
    days = storm_days = positives = 0
    for d in _learning_finalized_dates():
        light = _read_lightning_archive(d)
        if not light:
            continue
        days += 1
        touched = len(light.get("flashes_per_cell") or {})
        if touched > 0:
            storm_days += 1
            positives += touched
    return {"days": days, "storm_days": storm_days, "positives": positives}


def _apply_learning_config(config: dict[str, Any] | None) -> None:
    """Applique (ou réinitialise) la config apprise : poids de mélange + seuil de décision."""
    global _active_score_threshold
    if config:
        weights = config.get("weights") or {}
        weather_logic.set_active_blend_weights(weights if weights.get("enabled") else None)
        try:
            _active_score_threshold = int(config.get("threshold") or verification.DEFAULT_SCORE_THRESHOLD)
        except (TypeError, ValueError):
            _active_score_threshold = verification.DEFAULT_SCORE_THRESHOLD
    else:
        weather_logic.set_active_blend_weights(None)
        _active_score_threshold = verification.DEFAULT_SCORE_THRESHOLD
    _verification_cache.clear()  # le seuil « zones prévues » a pu changer


def _load_and_apply_active_learning() -> dict[str, Any] | None:
    """Au démarrage : charge active.json et applique poids + seuil (sinon défaut)."""
    config = learning.load_active(OBJECTIFOUDRE_HISTORY_DIR)
    _apply_learning_config(config)
    return config


def _run_learning_evaluation(*, source: str = "manual") -> dict[str, Any]:
    """Construit le jeu d'apprentissage, évalue, et en mode auto applique le candidat
    s'il bat la baseline (held-out). Toujours journalisé. Réversible."""
    with _learning_lock:
        dates = _learning_finalized_dates()
        examples = learning.build_training_examples(
            dates, _learning_full_day_loader, _read_lightning_archive,
        )
        res = learning.evaluate_and_select(examples)
        applied = False
        config = res.get("config")
        if config:
            config["fitted_at"] = datetime.now(OBJECTIFOUDRE_SERVER_TIMEZONE).isoformat()
        if res["decision"] == "activate" and config:
            learning.save_active(OBJECTIFOUDRE_HISTORY_DIR, config)
            _apply_learning_config(config)
            applied = True
        elif config:
            learning.save_candidate(OBJECTIFOUDRE_HISTORY_DIR, config)
        learning.append_log(OBJECTIFOUDRE_HISTORY_DIR, {
            "at": datetime.now(OBJECTIFOUDRE_SERVER_TIMEZONE).isoformat(),
            "source": source,
            "decision": res["decision"],
            "reason": res.get("reason"),
            "data": res.get("data"),
            "applied": applied,
            "skill": res.get("skill"),
        })
        res["applied"] = applied
        return res


def _learning_status() -> dict[str, Any]:
    """État courant pour l'UI : volumes, garde-fous, seuil/poids actifs, skill, journal."""
    active = learning.load_active(OBJECTIFOUDRE_HISTORY_DIR)
    counts = _learning_data_counts_cheap()
    gates = {
        "calibration_ready": counts["days"] >= learning.CALIB_MIN_DAYS and counts["positives"] >= learning.CALIB_MIN_POSITIVES,
        "weights_ready": counts["days"] >= learning.WEIGHTS_MIN_DAYS and counts["positives"] >= learning.WEIGHTS_MIN_POSITIVES,
        "calib_min_days": learning.CALIB_MIN_DAYS,
        "calib_min_positives": learning.CALIB_MIN_POSITIVES,
        "weights_min_days": learning.WEIGHTS_MIN_DAYS,
        "weights_min_positives": learning.WEIGHTS_MIN_POSITIVES,
    }
    if active:
        state = "active"
    elif gates["calibration_ready"]:
        state = "baseline"   # assez de données mais aucun candidat n'améliorait la baseline
    else:
        state = "collecting"
    return {
        "ok": True,
        "state": state,
        "mode": "auto",
        "data": counts,
        "gates": gates,
        "threshold": {"active": _active_score_threshold, "baseline": verification.DEFAULT_SCORE_THRESHOLD},
        "weights": {
            "active": (active.get("weights") if active else None),
            "default": learning.DEFAULT_BLEND_WEIGHTS,
        },
        "calibration": (active.get("calibration") if active else None),
        "skill": (active.get("skill") if active else None),
        "fitted_at": (active.get("fitted_at") if active else None),
        "last_runs": learning.read_log_tail(OBJECTIFOUDRE_HISTORY_DIR, 10),
    }


def _collect_pending_lightning() -> dict[str, Any]:
    """Collecte la foudre observée pour chaque journée PRÉVUE déjà écoulée qui n'a
    pas encore d'archive finale. Idempotent : une journée déjà finalisée est sautée.
    On ne collecte jamais aujourd'hui/le futur (jour partiel)."""
    if not (EUMETSAT_CONSUMER_KEY and EUMETSAT_CONSUMER_SECRET):
        return {"ok": False, "reason": "eumdac_not_configured"}
    today_iso = datetime.now(OBJECTIFOUDRE_SERVER_TIMEZONE).date().isoformat()
    collected: list[dict[str, Any]] = []
    for item in _list_history_dates():
        date_str = item.get("date")
        if not date_str or date_str >= today_iso:
            continue
        existing = _read_lightning_archive(date_str)
        if existing and existing.get("final"):
            continue
        try:
            result = _build_lightning_archive_for_date(date_str)
        except Exception as exc:
            result = {"ok": False, "reason": type(exc).__name__}
        collected.append({
            "date": date_str,
            "ok": bool(result.get("ok")),
            "flash_total": result.get("flash_total"),
            "reason": result.get("reason"),
        })
        if _lightning_automation_stop.is_set():
            break
        _lightning_automation_stop.wait(3)  # politesse entre journées
    return {"ok": True, "today": today_iso, "collected_count": len(collected), "collected": collected}


def _lightning_automation_loop() -> None:
    # délai initial : on laisse le démarrage + le préchargement AROME respirer.
    _lightning_automation_stop.wait(180)
    while not _lightning_automation_stop.is_set():
        try:
            _collect_pending_lightning()
        except Exception:
            pass
        # Boucle fermée : après chaque collecte de foudre, on réévalue le modèle.
        try:
            _run_learning_evaluation(source="automation")
        except Exception:
            pass
        _lightning_automation_stop.wait(OBJECTIFOUDRE_LIGHTNING_AUTOMATION_INTERVAL_SECONDS)


def _start_lightning_automation_thread() -> None:
    global _lightning_automation_thread
    if not (OBJECTIFOUDRE_LIGHTNING_AUTOMATION and EUMETSAT_CONSUMER_KEY and EUMETSAT_CONSUMER_SECRET):
        return
    with _lightning_automation_lock:
        if _lightning_automation_thread is not None and _lightning_automation_thread.is_alive():
            return
        _lightning_automation_stop.clear()
        _lightning_automation_thread = threading.Thread(
            target=_lightning_automation_loop,
            daemon=True,
            name="objectifoudre-lightning-automation",
        )
        _lightning_automation_thread.start()


def _meteofrance_grib_full_package_cache_key(product_href: str) -> str:
    return f"meteofrance:grib-full-package:{_stable_cache_hash(product_href)}"


def _meteofrance_grib_full_package_cache_paths(key: str) -> tuple[Path, Path]:
    base_path = _meteofrance_persistent_cache_path("grib-full-package", key)
    return base_path, base_path.with_suffix(".grib")


def _read_meteofrance_grib_full_package_cache(key: str, ttl: int) -> dict[str, Any] | None:
    meta_path, grib_path = _meteofrance_grib_full_package_cache_paths(key)
    try:
        entry = json.loads(meta_path.read_text(encoding="utf-8"))
        created_at = float(entry.get("ts") or 0)
        payload = entry.get("payload")
    except Exception:
        return None
    if created_at <= 0 or (time.time() - created_at) >= ttl or not isinstance(payload, dict):
        return None
    try:
        raw = grib_path.read_bytes()
    except Exception:
        return None
    expected_byte_count = int(payload.get("byte_count") or 0)
    if expected_byte_count and len(raw) != expected_byte_count:
        return None
    payload = copy.deepcopy(payload)
    payload["cache_path"] = str(grib_path)
    return {"ts": created_at, "payload": payload, "raw": raw, "path": str(meta_path)}


def _write_meteofrance_grib_full_package_cache(key: str, payload: dict[str, Any], raw: bytes) -> None:
    meta_path, grib_path = _meteofrance_grib_full_package_cache_paths(key)
    try:
        meta_path.parent.mkdir(parents=True, exist_ok=True)
        tmp_grib_path = grib_path.with_suffix(".grib.tmp")
        tmp_meta_path = meta_path.with_suffix(".json.tmp")
        tmp_grib_path.write_bytes(raw)
        stored_payload = copy.deepcopy(payload)
        stored_payload["cache_path"] = str(grib_path)
        stored_payload["byte_count"] = len(raw)
        tmp_meta_path.write_text(
            json.dumps({"ts": time.time(), "payload": stored_payload}, ensure_ascii=False, separators=(",", ":")),
            encoding="utf-8",
        )
        tmp_grib_path.replace(grib_path)
        tmp_meta_path.replace(meta_path)
    except Exception:
        return


def _fetch_grib_full_package_cached(
    api_key: str,
    product_href: str,
    *,
    max_bytes: int = METEOFRANCE_MODEL_PACKAGE_FULL_PROBE_LIMIT_BYTES,
    cache_only: bool = False,
) -> dict[str, Any]:
    parsed_href = urllib.parse.urlparse(product_href)
    href_path = parsed_href.path.lower()
    is_arome_package_product = "dppaquetarome" in href_path or "/previnum/" in href_path
    if (
        not METEOFRANCE_GRIB_FULL_PACKAGE_CACHE_ENABLED
        or not _meteofrance_persistent_cache_enabled(product_href)
        or not is_arome_package_product
    ):
        return {"ok": False, "message": "Cache paquet complet GRIB désactivé pour cette ressource.", "disabled": True}
    cache_key = _meteofrance_grib_full_package_cache_key(product_href)
    cached = _read_meteofrance_grib_full_package_cache(cache_key, METEOFRANCE_GRIB_FULL_PACKAGE_CACHE_TTL_SECONDS)
    if cached is not None:
        payload = dict(cached.get("payload") or {})
        return {
            "ok": True,
            "raw": cached["raw"],
            "status": int(payload.get("status") or 200),
            "content_type": str(payload.get("content_type") or "application/octet-stream"),
            "headers": dict(payload.get("headers") or {}),
            "byte_count": int(payload.get("byte_count") or len(cached["raw"])),
            "content_length": payload.get("content_length"),
            "package_request_count": 0,
            "cached_package_request_count": 1,
            "cache": _cache_status(True, "disk", float(cached["ts"]), METEOFRANCE_GRIB_FULL_PACKAGE_CACHE_TTL_SECONDS),
        }
    if cache_only:
        return {
            "ok": False,
            "message": "Paquet GRIB complet absent du cache.",
            "cache_only_miss": True,
            "package_request_count": 0,
            "cached_package_request_count": 0,
            "cache": _cache_status(False, "none", None, METEOFRANCE_GRIB_FULL_PACKAGE_CACHE_TTL_SECONDS),
        }
    status, content_type, raw, headers, truncated_by_limit = _fetch_meteofrance_package_full_bytes(api_key, product_href, max_bytes=max_bytes)
    content_length = None
    try:
        content_length = int(str(headers.get("content-length") or "").strip() or "0") or None
    except ValueError:
        content_length = None
    if truncated_by_limit or not raw or raw.find(b"GRIB") < 0:
        return {
            "ok": False,
            "status": status,
            "content_type": content_type,
            "headers": headers,
            "byte_count": len(raw),
            "content_length": content_length,
            "truncated": bool(truncated_by_limit),
            "message": "Paquet GRIB complet inutilisable ou tronqué.",
            "package_request_count": 1,
            "cached_package_request_count": 0,
            "cache": _cache_status(False, "api", None, METEOFRANCE_GRIB_FULL_PACKAGE_CACHE_TTL_SECONDS),
        }
    payload = {
        "status": status,
        "content_type": content_type,
        "headers": headers,
        "byte_count": len(raw),
        "content_length": content_length,
        "truncated": False,
    }
    if 200 <= status < 300:
        _write_meteofrance_grib_full_package_cache(cache_key, payload, raw)
    return {
        "ok": bool(200 <= status < 300),
        "raw": raw,
        "status": status,
        "content_type": content_type,
        "headers": headers,
        "byte_count": len(raw),
        "content_length": content_length,
        "package_request_count": 1,
        "cached_package_request_count": 0,
        "cache": _cache_status(False, "api", None, METEOFRANCE_GRIB_FULL_PACKAGE_CACHE_TTL_SECONDS),
    }


def _meteofrance_grib_national_field_cache_paths(key: str) -> tuple[Path, Path]:
    base_path = _meteofrance_persistent_cache_path("grib-national-field", key)
    return base_path, base_path.with_suffix(".bin.z")


def _read_meteofrance_grib_national_field_cache(key: str, ttl: int) -> dict[str, Any] | None:
    meta_path, bin_path = _meteofrance_grib_national_field_cache_paths(key)
    try:
        entry = json.loads(meta_path.read_text(encoding="utf-8"))
        created_at = float(entry.get("ts") or 0)
        payload = entry.get("payload")
    except Exception:
        return None
    if created_at <= 0 or (time.time() - created_at) >= ttl or not isinstance(payload, dict):
        return None
    if not bin_path.is_file():
        return None
    payload = copy.deepcopy(payload)
    payload["cache_path"] = str(bin_path)
    return {"ts": created_at, "payload": payload, "path": str(meta_path)}


def _write_meteofrance_grib_national_field_cache(key: str, payload: dict[str, Any], compressed_values: bytes) -> None:
    meta_path, bin_path = _meteofrance_grib_national_field_cache_paths(key)
    try:
        meta_path.parent.mkdir(parents=True, exist_ok=True)
        tmp_bin_path = bin_path.with_suffix(".bin.z.tmp")
        tmp_meta_path = meta_path.with_suffix(".json.tmp")
        tmp_bin_path.write_bytes(compressed_values)
        stored_payload = copy.deepcopy(payload)
        stored_payload["cache_path"] = str(bin_path)
        stored_payload["compressed_byte_count"] = len(compressed_values)
        tmp_meta_path.write_text(
            json.dumps({"ts": time.time(), "payload": stored_payload}, ensure_ascii=False, separators=(",", ":")),
            encoding="utf-8",
        )
        tmp_bin_path.replace(bin_path)
        tmp_meta_path.replace(meta_path)
    except Exception:
        return


def _meteofrance_metadata_cache_key(api_key: str, scope: str, model: str | None = None) -> str:
    digest = hashlib.sha256(api_key.encode("utf-8")).hexdigest()[:20]
    prefix = str(_nwp_model_spec(model or _active_nwp_model()).get("cache_scope_prefix") or "")
    return f"meteofrance:{digest}:{prefix}{scope}"


def _meteofrance_slot_grid_cache_key(api_key: str, lat: float, lon: float, label: str, target_date: Date, hour: int, detail_level: str) -> str:
    base = _meteofrance_metadata_cache_key(api_key, "slot-grid")
    return f"{base}:{_cache_key(lat, lon, target_date)}:h{hour:02d}:detail={detail_level}:label={_label_cache_key(label)}"


def _meteofrance_grib_slot_grid_cache_key(api_key: str, requested_grid: str | None, lat: float, lon: float, label: str, target_date: Date, hour: int, detail_level: str) -> str:
    grid_part = requested_grid or "auto"
    base = _meteofrance_metadata_cache_key(api_key, "grib-slot-grid")
    return (
        f"{base}:grid={grid_part}:{_cache_key(lat, lon, target_date)}:h{hour:02d}:"
        f"detail={detail_level}:algo={METEOFRANCE_GRIB_SLOT_GRID_ALGORITHM_VERSION}:label={_label_cache_key(label)}"
    )


def _meteofrance_grib_france_slot_grid_cache_key(api_key: str, requested_grid: str | None, target_date: Date, hour: int, detail_level: str) -> str:
    grid_part = requested_grid or "auto"
    base = _meteofrance_metadata_cache_key(api_key, "grib-france-slot-grid")
    return (
        f"{base}:grid={grid_part}:date={target_date.isoformat()}:h{hour:02d}:"
        f"detail={detail_level}:algo={METEOFRANCE_GRIB_SLOT_GRID_ALGORITHM_VERSION}"
    )


def _meteofrance_grib_national_field_cache_key(
    requested_grid: str | None,
    product_href: str,
    selected_message: dict[str, Any],
    field: str,
) -> str:
    offset = int(selected_message.get("offset") or 0)
    length = int(selected_message.get("length") or 0)
    grid_part = requested_grid or "auto"
    source = (
        f"grid={grid_part}|field={field}|href={product_href}|offset={offset}|length={length}|"
        f"algo={METEOFRANCE_GRIB_NATIONAL_FIELD_ALGORITHM_VERSION}"
    )
    return f"meteofrance:grib-national-field:{_stable_cache_hash(source)}"






def _meteofrance_grib_national_field_registry_key(
    requested_grid: str | None,
    target_date: Date,
    hour: int,
    field: str,
) -> str:
    grid_part = requested_grid or "auto"
    model = _active_nwp_model()
    model_part = "" if model == DEFAULT_NWP_MODEL else f"model={model}|"
    source = (
        f"{model_part}grid={grid_part}|date={target_date.isoformat()}|hour={int(hour):02d}|field={field}|"
        f"algo={METEOFRANCE_GRIB_NATIONAL_FIELD_ALGORITHM_VERSION}:slot-algo={METEOFRANCE_GRIB_SLOT_GRID_ALGORITHM_VERSION}"
    )
    return f"meteofrance:grib-national-field-registry:{_stable_cache_hash(source)}"


def _write_meteofrance_grib_national_field_registry(
    requested_grid: str | None,
    target_date: Date,
    hour: int,
    field: str,
    field_cache_key: str,
    product: dict[str, Any] | None = None,
    selected_message: dict[str, Any] | None = None,
    spec: dict[str, Any] | None = None,
    forecast_hour: int | None = None,
) -> None:
    registry_key = _meteofrance_grib_national_field_registry_key(requested_grid, target_date, hour, field)
    payload = {
        "field_cache_key": field_cache_key,
        "requested_grid": requested_grid or "auto",
        "date": target_date.isoformat(),
        "hour": int(hour),
        "field": field,
        "package_id": (spec or {}).get("package_id"),
        "parameter_label": (spec or {}).get("parameter_label"),
        "level_contains": (spec or {}).get("level_contains"),
        "forecast_hour": forecast_hour,
        "time_group": (product or {}).get("time"),
        "product_href_hash": _stable_cache_hash(str((product or {}).get("href") or "")),
        "offset": (selected_message or {}).get("offset"),
        "length": (selected_message or {}).get("length"),
        "codec": METEOFRANCE_GRIB_NATIONAL_FIELD_ALGORITHM_VERSION,
        "slot_algorithm": METEOFRANCE_GRIB_SLOT_GRID_ALGORITHM_VERSION,
    }
    _set_cached_value(registry_key, payload)
    _write_meteofrance_local_persistent_cache("grib-national-field-registry", registry_key, payload)


def _get_meteofrance_grib_national_field_registry_payload(
    requested_grid: str | None,
    target_date: Date,
    hour: int,
    field: str,
) -> tuple[dict[str, Any] | None, dict[str, Any] | None, str | None, float | None]:
    registry_key = _meteofrance_grib_national_field_registry_key(requested_grid, target_date, hour, field)
    cached = _get_cached_value(registry_key, ttl=METEOFRANCE_GRIB_NATIONAL_FIELD_CACHE_TTL_SECONDS)
    if cached is not None and isinstance(cached.get("payload"), dict):
        entry = copy.deepcopy(cached["payload"])
    else:
        persistent = _read_meteofrance_local_persistent_cache(
            "grib-national-field-registry",
            registry_key,
            METEOFRANCE_GRIB_NATIONAL_FIELD_CACHE_TTL_SECONDS,
        )
        if persistent is None or not isinstance(persistent.get("payload"), dict):
            return None, None, None, None
        entry = copy.deepcopy(persistent["payload"])
        _set_cached_value(registry_key, entry)
    field_cache_key = str(entry.get("field_cache_key") or "")
    if not field_cache_key:
        return None, None, None, None
    national_payload, national_backend, national_created_at = _get_meteofrance_grib_national_field_cache_payload(field_cache_key)
    if national_payload is None:
        return None, None, None, None
    return entry, national_payload, national_backend, national_created_at


def _point_in_polygon(lon: float, lat: float, polygon: list[tuple[float, float]]) -> bool:
    inside = False
    j = len(polygon) - 1
    for i, (xi, yi) in enumerate(polygon):
        xj, yj = polygon[j]
        intersects = ((yi > lat) != (yj > lat)) and (
            lon < ((xj - xi) * (lat - yi) / ((yj - yi) or 1e-12)) + xi
        )
        if intersects:
            inside = not inside
        j = i
    return inside


def _is_meteofrance_france_grid_point(lat: float, lon: float) -> bool:
    return (
        _point_in_polygon(lon, lat, METEOFRANCE_MAINLAND_FRANCE_POLYGON)
        or _point_in_polygon(lon, lat, METEOFRANCE_CORSICA_POLYGON)
    )


_polygon_bbox_cache: dict[int, tuple[float, float, float, float]] = {}


def _polygon_bbox(polygon: list[tuple[float, float]]) -> tuple[float, float, float, float]:
    cache_key = id(polygon)
    cached = _polygon_bbox_cache.get(cache_key)
    if cached is not None:
        return cached
    bbox = (
        min(lon for lon, _ in polygon),
        min(lat for _, lat in polygon),
        max(lon for lon, _ in polygon),
        max(lat for _, lat in polygon),
    )
    _polygon_bbox_cache[cache_key] = bbox
    return bbox


def _rects_overlap(a: tuple[float, float, float, float], b: tuple[float, float, float, float]) -> bool:
    return not (a[2] < b[0] or a[0] > b[2] or a[3] < b[1] or a[1] > b[3])


def _polygon_intersects_rect(polygon: list[tuple[float, float]], min_lon: float, min_lat: float, max_lon: float, max_lat: float) -> bool:
    if not _rects_overlap(_polygon_bbox(polygon), (min_lon, min_lat, max_lon, max_lat)):
        return False
    mid_lon = (min_lon + max_lon) / 2
    mid_lat = (min_lat + max_lat) / 2
    samples = (
        (min_lon, min_lat),
        (mid_lon, min_lat),
        (max_lon, min_lat),
        (min_lon, mid_lat),
        (mid_lon, mid_lat),
        (max_lon, mid_lat),
        (min_lon, max_lat),
        (mid_lon, max_lat),
        (max_lon, max_lat),
    )
    return any(_point_in_polygon(lon, lat, polygon) for lon, lat in samples)


def _is_meteofrance_france_grid_cell(lat: float, lon: float, cell_height_deg: float, cell_width_deg: float) -> bool:
    if _is_meteofrance_france_grid_point(lat, lon):
        return True
    min_lat = lat - cell_height_deg / 2
    max_lat = lat + cell_height_deg / 2
    min_lon = lon - cell_width_deg / 2
    max_lon = lon + cell_width_deg / 2
    return (
        _polygon_intersects_rect(METEOFRANCE_MAINLAND_FRANCE_POLYGON, min_lon, min_lat, max_lon, max_lat)
        or _polygon_intersects_rect(METEOFRANCE_CORSICA_POLYGON, min_lon, min_lat, max_lon, max_lat)
    )


# Mémoïsé : le masque grille France ne dépend que du préfixe de zone, de la taille
# de cellule et de constantes (polygones 817+157 sommets, bornes). Sans cache il était
# reconstruit à CHAQUE heure matérialisée (24×/jour), à ~45 M opérations point-dans-
# polygone par construction. La liste renvoyée est PARTAGÉE et doit rester en lecture
# seule (tous les appelants la passent en points_override sans la muter).
@functools.lru_cache(maxsize=8)
def _build_meteofrance_france_grid_points(zone_prefix: str = METEOFRANCE_FRANCE_GRID_LABEL, cell_size_km: float = CELL_SIZE_KM) -> list[Point]:
    bounds = METEOFRANCE_FRANCE_GRID_BOUNDS
    step_lat = km_to_deg_lat(cell_size_km)
    safe_prefix = "".join(ch for ch in zone_prefix if ch.isalnum())[:14] or "France"
    points: list[Point] = []
    row = 0
    lat = float(bounds["south"])
    while lat <= float(bounds["north"]) + 1e-9:
        step_lon = km_to_deg_lon(cell_size_km, lat)
        lon = float(bounds["west"])
        while lon <= float(bounds["east"]) + 1e-9:
            if _is_meteofrance_france_grid_cell(lat, lon, step_lat, step_lon):
                points.append(
                    Point(
                        zone=f"{safe_prefix}-{len(points) + 1}",
                        lat=round(lat, 5),
                        lon=round(lon, 5),
                        cell_height_deg=step_lat,
                        cell_width_deg=step_lon,
                    )
                )
            lon += step_lon
        row += 1
        lat = float(bounds["south"]) + row * step_lat
    return points


def _get_meteofrance_grib_national_field_cache_payload(field_cache_key: str) -> tuple[dict[str, Any] | None, str | None, float | None]:
    cached = _get_cached_value(field_cache_key, ttl=METEOFRANCE_GRIB_NATIONAL_FIELD_CACHE_TTL_SECONDS)
    if cached is not None and isinstance(cached.get("payload"), dict):
        return copy.deepcopy(cached["payload"]), "memory", float(cached.get("ts") or time.time())

    persistent = _read_meteofrance_grib_national_field_cache(
        field_cache_key,
        METEOFRANCE_GRIB_NATIONAL_FIELD_CACHE_TTL_SECONDS,
    )
    if persistent is not None and isinstance(persistent.get("payload"), dict):
        payload = copy.deepcopy(persistent["payload"])
        _set_cached_value(field_cache_key, payload)
        return payload, "disk", float(persistent.get("ts") or time.time())
    return None, None, None



def _sample_meteofrance_grib_national_field_registry_for_points(
    requested_grid: str | None,
    target_date: Date,
    hour: int,
    field: str,
    spec: dict[str, Any],
    points: list[Any],
) -> dict[str, Any] | None:
    registry_entry, registry_payload, registry_backend, registry_created_at = _get_meteofrance_grib_national_field_registry_payload(
        requested_grid,
        target_date,
        hour,
        field,
    )
    if registry_entry is None or registry_payload is None:
        return None
    field_cache_key = str(registry_entry.get("field_cache_key") or "")
    if not field_cache_key:
        return None
    sampled = _sample_meteofrance_grib_national_field_cache(field_cache_key, registry_payload, field, points)
    values_by_zone = {
        str(item.get("zone")): item.get("value")
        for item in sampled.get("samples", [])
        if item.get("zone") and item.get("value") is not None
    }
    if not values_by_zone:
        return None
    created_at = float(registry_created_at) if registry_created_at is not None else None
    field_request = {
        "field": field,
        "package_id": registry_entry.get("package_id") or spec.get("package_id"),
        "parameter_label": registry_entry.get("parameter_label") or spec.get("parameter_label"),
        "level_contains": registry_entry.get("level_contains") or spec.get("level_contains"),
        "forecast_hour": registry_entry.get("forecast_hour"),
        "time_group": registry_entry.get("time_group"),
        "offset": registry_entry.get("offset"),
        "length": registry_entry.get("length"),
        "message_short_name": sampled.get("metadata", {}).get("shortName"),
        "message_name": sampled.get("metadata", {}).get("name"),
        "units": sampled.get("metadata", {}).get("units"),
        "valid_count": sampled.get("valid_count"),
        "count": sampled.get("count"),
        "index_cache": {"hit": True, "backend": "national-field-registry"},
        "message_cache": {"hit": True, "backend": "national-field", "source_backend": registry_backend},
        "national_field_cache_hit": True,
        "national_field_registry_hit": True,
        "national_field_cache_backend": registry_backend,
        "national_field_cache_age_seconds": max(0, int(time.time() - created_at)) if created_at is not None else None,
        "national_values_backend": sampled.get("values_backend"),
        "cache_only_miss": False,
        "cache_only_incomplete": False,
        "index_range_request_count": 0,
        "message_range_request_count": 0,
        "ok": bool(sampled.get("ok") and values_by_zone),
        "message": sampled.get("message"),
    }
    return {
        "values_by_zone": values_by_zone,
        "field_request": field_request,
        "sampled_count": int(sampled.get("valid_count") or 0),
    }


def _current_float32_byteorder_label() -> str:
    return "little" if struct.pack("=I", 1)[0] == 1 else "big"


def _load_meteofrance_grib_national_field_values(field_cache_key: str, payload: dict[str, Any]) -> dict[str, Any]:
    values_cache_key = f"{field_cache_key}:values"
    cached = _get_cached_value(values_cache_key, ttl=METEOFRANCE_GRIB_NATIONAL_FIELD_CACHE_TTL_SECONDS)
    if cached is not None and isinstance(cached.get("payload"), array):
        return {"ok": True, "values": cached["payload"], "backend": "memory"}

    _, default_bin_path = _meteofrance_grib_national_field_cache_paths(field_cache_key)
    path = Path(str(payload.get("cache_path") or default_bin_path))
    if not path.is_file():
        return {"ok": False, "message": "Valeurs nationales GRIB absentes du cache disque."}
    try:
        raw_values = zlib.decompress(path.read_bytes())
        values = array("f")
        values.frombytes(raw_values)
        if payload.get("byteorder") in {"little", "big"} and payload.get("byteorder") != _current_float32_byteorder_label():
            values.byteswap()
        expected = int(payload.get("value_count") or 0)
        if expected and len(values) != expected:
            return {
                "ok": False,
                "message": f"Cache national incoherent : {len(values)} valeur(s) pour {expected} attendue(s).",
            }
        _set_cached_value(values_cache_key, values)
        return {"ok": True, "values": values, "backend": "disk"}
    except Exception as exc:
        return {"ok": False, "message": f"Lecture du cache national GRIB impossible : {exc}"}


def _metadata_float(metadata: dict[str, Any], key: str) -> float | None:
    try:
        value = metadata.get(key)
        return None if value is None else float(value)
    except (TypeError, ValueError):
        return None


def _metadata_int(metadata: dict[str, Any], key: str) -> int | None:
    try:
        value = metadata.get(key)
        return None if value is None else int(float(value))
    except (TypeError, ValueError):
        return None


def _grib_axis_index(value: float, first: float, last: float, count: int, increment: float | None, *, cyclic: bool = False) -> tuple[int, float] | None:
    if count <= 0:
        return None
    if count == 1:
        return 0, first
    start = float(first)
    end = float(last)
    target = float(value)
    if cyclic and end < start and (end + 360.0 - start) <= 180.0:
        end += 360.0
    if cyclic:
        low = min(start, end)
        high = max(start, end)
        while target < low:
            target += 360.0
        while target > high:
            target -= 360.0
    step = abs(float(increment or 0.0))
    if not step:
        span = abs(end - start)
        if not span:
            return None
        step = span / max(1, count - 1)
    raw_index = (target - start) / step if end >= start else (start - target) / step
    index = int(round(raw_index))
    index = max(0, min(count - 1, index))
    coordinate = start + index * step if end >= start else start - index * step
    if cyclic and coordinate > 180.0:
        coordinate -= 360.0
    return index, coordinate


def _sample_meteofrance_grib_national_field_cache(
    field_cache_key: str,
    payload: dict[str, Any],
    field: str,
    points: list[Any],
) -> dict[str, Any]:
    metadata = payload.get("metadata") if isinstance(payload.get("metadata"), dict) else {}
    ni = _metadata_int(metadata, "Ni")
    nj = _metadata_int(metadata, "Nj")
    first_lat = _metadata_float(metadata, "latitudeOfFirstGridPointInDegrees")
    last_lat = _metadata_float(metadata, "latitudeOfLastGridPointInDegrees")
    first_lon = _metadata_float(metadata, "longitudeOfFirstGridPointInDegrees")
    last_lon = _metadata_float(metadata, "longitudeOfLastGridPointInDegrees")
    lon_increment = _metadata_float(metadata, "iDirectionIncrementInDegrees")
    lat_increment = _metadata_float(metadata, "jDirectionIncrementInDegrees")
    if not ni or not nj or first_lat is None or last_lat is None or first_lon is None or last_lon is None:
        return {"ok": False, "message": "Metadonnees de grille nationale incompletes.", "samples": []}

    loaded = _load_meteofrance_grib_national_field_values(field_cache_key, payload)
    if not loaded.get("ok"):
        return {"ok": False, "message": loaded.get("message"), "samples": []}
    values = loaded["values"]
    if len(values) < ni * nj:
        return {"ok": False, "message": "Tableau national GRIB plus court que la grille annoncee.", "samples": []}

    samples = []
    valid_samples = []
    for point in points:
        lat = float(getattr(point, "lat"))
        lon = float(getattr(point, "lon"))
        y_axis = _grib_axis_index(lat, first_lat, last_lat, nj, lat_increment, cyclic=False)
        x_axis = _grib_axis_index(lon, first_lon, last_lon, ni, lon_increment, cyclic=True)
        if y_axis is None or x_axis is None:
            continue
        y, grid_lat = y_axis
        x, grid_lon = x_axis
        grid_index = y * ni + x
        if grid_index < 0 or grid_index >= len(values):
            continue
        raw_value = float(values[grid_index])
        value = round(raw_value, 3) if math.isfinite(raw_value) else None
        sample = {
            "zone": getattr(point, "zone", ""),
            "lat": lat,
            "lon": lon,
            "grid_lat": round(float(grid_lat), 5),
            "grid_lon": round(float(grid_lon), 5),
            "raw_value": round(raw_value, 3) if math.isfinite(raw_value) else None,
            "value": value,
            "distance_km": round(_distance_km(lat, lon, float(grid_lat), float(grid_lon)), 3),
            "grid_index": grid_index,
        }
        samples.append(sample)
        if value is not None:
            valid_samples.append(sample)
    return {
        "ok": True,
        "message": f"{len(valid_samples)}/{len(samples)} point(s) echantillonnes depuis le cache national pour {field}.",
        "metadata": metadata,
        "samples": samples,
        "valid_count": len(valid_samples),
        "count": len(samples),
        "values_backend": loaded.get("backend"),
    }


def _meteofrance_grib_national_preload_job_key(api_key: str, requested_grid: str | None, target_date: Date) -> str:
    grid_part = requested_grid or "auto"
    base = _meteofrance_metadata_cache_key(api_key, "grib-national-preload")
    return (
        f"{base}:grid={grid_part}:date={target_date.isoformat()}:"
        f"algo={METEOFRANCE_GRIB_NATIONAL_FIELD_ALGORITHM_VERSION}:slot-algo={METEOFRANCE_GRIB_SLOT_GRID_ALGORITHM_VERSION}"
    )


def _meteofrance_grib_auto_preload_job_key(
    api_key: str,
    requested_grid: str | None,
    lat: float,
    lon: float,
    label: str,
    target_date: Date,
    hour: int,
    detail_level: str,
    block_key: str | None = None,
) -> str:
    grid_part = requested_grid or "auto"
    block_part = block_key or f"local-{max(0, min(23, int(hour))) // 6}"
    base = _meteofrance_metadata_cache_key(api_key, "grib-auto-preload")
    return (
        f"{base}:grid={grid_part}:{_cache_key(lat, lon, target_date)}:block={block_part}:"
        f"detail={detail_level}:algo={METEOFRANCE_GRIB_SLOT_GRID_ALGORITHM_VERSION}:label={_label_cache_key(label)}"
    )


def _meteofrance_grib_slot_grid_cache_coverage(
    api_key: str,
    requested_grid: str | None,
    lat: float,
    lon: float,
    label: str,
    target_date: Date,
    hours: list[int],
    detail_level: str,
) -> dict[str, Any]:
    detail_level = _meteofrance_slot_grid_detail_level(detail_level)
    normalized_hours = sorted(set(max(0, min(23, int(item))) for item in hours))
    cached_hours = []
    cached_total_range_requests = 0
    for slot_hour in normalized_hours:
        cache_key = _meteofrance_grib_slot_grid_cache_key(
            api_key,
            requested_grid,
            lat,
            lon,
            label,
            target_date,
            slot_hour,
            detail_level,
        )
        entry = _get_cached_value(cache_key, ttl=METEOFRANCE_GRIB_SLOT_GRID_CACHE_TTL_SECONDS)
        if entry is None:
            entry = _read_meteofrance_local_persistent_cache(
                "grib-slot-grid",
                cache_key,
                METEOFRANCE_GRIB_SLOT_GRID_CACHE_TTL_SECONDS,
            )
            if entry is not None:
                _set_cached_value(cache_key, entry["payload"])
        if entry is None:
            continue
        payload = entry.get("payload")
        if not isinstance(payload, dict) or not _grib_slot_grid_result_has_required_fields(payload, detail_level):
            continue
        meta = payload.get("payload", {}).get("meta", {}) if isinstance(payload.get("payload"), dict) else {}
        cached_total_range_requests += int(meta.get("cached_total_range_request_count") or meta.get("total_range_request_count") or 0)
        cached_hours.append(slot_hour)
    return {
        "complete": bool(normalized_hours) and len(cached_hours) == len(normalized_hours),
        "hours": normalized_hours,
        "cached_hours": cached_hours,
        "missing_hours": [item for item in normalized_hours if item not in cached_hours],
        "ok_count": len(cached_hours),
        "hour_count": len(normalized_hours),
        "cached_total_range_request_count": cached_total_range_requests,
    }


def _meteofrance_grib_france_slot_grid_cache_coverage(
    api_key: str,
    requested_grid: str | None,
    target_date: Date,
    hours: list[int],
    detail_level: str,
) -> dict[str, Any]:
    detail_level = METEOFRANCE_SLOT_GRID_CORE_DETAIL
    normalized_hours = sorted(set(max(0, min(23, int(item))) for item in hours))
    cached_hours = []
    cached_total_range_requests = 0
    for slot_hour in normalized_hours:
        cache_key = _meteofrance_grib_france_slot_grid_cache_key(
            api_key,
            requested_grid,
            target_date,
            slot_hour,
            detail_level,
        )
        entry = _get_cached_value(cache_key, ttl=METEOFRANCE_GRIB_SLOT_GRID_CACHE_TTL_SECONDS)
        if entry is None:
            entry = _read_meteofrance_local_persistent_cache(
                "grib-france-slot-grid",
                cache_key,
                METEOFRANCE_GRIB_SLOT_GRID_CACHE_TTL_SECONDS,
            )
            if entry is not None:
                _set_cached_value(cache_key, entry["payload"])
        if entry is None:
            continue
        payload = entry.get("payload")
        if not isinstance(payload, dict) or not _grib_slot_grid_result_has_required_fields(payload, detail_level):
            continue
        meta = payload.get("payload", {}).get("meta", {}) if isinstance(payload.get("payload"), dict) else {}
        cached_total_range_requests += int(meta.get("cached_total_range_request_count") or meta.get("total_range_request_count") or 0)
        cached_hours.append(slot_hour)
    return {
        "complete": bool(normalized_hours) and len(cached_hours) == len(normalized_hours),
        "hours": normalized_hours,
        "cached_hours": cached_hours,
        "missing_hours": [item for item in normalized_hours if item not in cached_hours],
        "ok_count": len(cached_hours),
        "hour_count": len(normalized_hours),
        "cached_total_range_request_count": cached_total_range_requests,
    }


def _meteofrance_grib_profile_cache_key(api_key: str, requested_grid: str | None, package_ids: list[str] | None, requested_time_group: str | None, max_messages: int) -> str:
    package_part = ",".join(_normalize_meteofrance_package_ids(package_ids))
    grid_part = requested_grid or "auto"
    time_part = requested_time_group or "auto"
    base = _meteofrance_metadata_cache_key(api_key, "grib-profile")
    return f"{base}:grid={grid_part}:packages={package_part}:time={time_part}:max={max_messages}"


def _meteofrance_quota_cooldown_cache_key(api_key: str, scope: str) -> str:
    return _meteofrance_metadata_cache_key(api_key, f"quota-cooldown:{scope}")


def _meteofrance_quota_cooldown_remaining(api_key: str, scope: str) -> int:
    cooldown = _get_cached_value(_meteofrance_quota_cooldown_cache_key(api_key, scope), ttl=METEOFRANCE_QUOTA_COOLDOWN_SECONDS)
    if cooldown is None:
        return 0
    elapsed = max(0, int(time.time() - float(cooldown["ts"])))
    return max(1, METEOFRANCE_QUOTA_COOLDOWN_SECONDS - elapsed)


def _set_meteofrance_quota_cooldown(api_key: str, scope: str, payload: dict[str, Any] | None = None) -> None:
    _set_cached_value(
        _meteofrance_quota_cooldown_cache_key(api_key, scope),
        payload or {"status": 429, "message": "Quota Météo-France dépassé."},
    )


def _meteofrance_quota_cooldown_result(api_key: str, scope: str, target: str, operation: str) -> dict[str, Any] | None:
    remaining = _meteofrance_quota_cooldown_remaining(api_key, scope)
    if remaining <= 0:
        return None
    return {
        "ok": False,
        "status": 429,
        "message": f"Quota Météo-France déjà atteint récemment : {operation} suspendu côté serveur encore {remaining // 60 + 1} min pour éviter d’aggraver le quota.",
        "target": target,
        "quota_cooldown_seconds": remaining,
        "quota_cooldown_scope": scope,
    }


def _is_meteofrance_quota_or_rate_limit_failure(failure: dict[str, Any], exc: Exception | None = None) -> bool:
    status = int(failure.get("status") or getattr(exc, "code", 0) or 0)
    if status == 429:
        return True
    haystack = " ".join(
        str(failure.get(key) or "")
        for key in ("message", "preview", "content_type")
    ).lower()
    return any(
        token in haystack
        for token in (
            "quota",
            "too many requests",
            "rate limit",
            "ratelimit",
            "limite",
            "dépassé",
            "depass",
        )
    )


def _meteofrance_arome_wcs_grid_date_status(
    target_date: Date,
    today: Date | None = None,
    allow_previous_day: bool = False,
) -> dict[str, Any]:
    today_date = today or datetime.now(ZoneInfo("Europe/Paris")).date()
    start = today_date - timedelta(days=1) if allow_previous_day else today_date
    if allow_previous_day:
        max_days_ahead = int(_active_nwp_spec().get("max_days_ahead") or METEOFRANCE_AROME_GRIB_MAX_DAYS_AHEAD)
    else:
        max_days_ahead = METEOFRANCE_AROME_WCS_GRID_MAX_DAYS_AHEAD
    end = today_date + timedelta(days=max_days_ahead)
    if target_date < start:
        return {
            "ok": False,
            "message": (
                f"La grille AROME {'GRIB' if allow_previous_day else 'WCS directe'} couvre "
                f"{'la veille et ' if allow_previous_day else ''}l’horizon prévisionnel courant "
                f"({start.isoformat()} à {end.isoformat()}). Les heures publiées sont ensuite limitées par l’horizon du run AROME."
            ),
            "supported_start": start.isoformat(),
            "supported_until": end.isoformat(),
        }
    if target_date > end:
        return {
            "ok": False,
            "message": (
                f"La grille AROME {'GRIB France' if allow_previous_day else 'WCS directe'} est limitée "
                f"à l’horizon courant ({start.isoformat()} à {end.isoformat()}). Sélection actuelle : {target_date.isoformat()}."
            ),
            "supported_start": start.isoformat(),
            "supported_until": end.isoformat(),
        }
    return {
        "ok": True,
        "message": "",
        "supported_start": start.isoformat(),
        "supported_until": end.isoformat(),
    }


def _meteofrance_api_key_from_optional_token(raw_key: str | None, *, allow_server_key: bool = False) -> str:
    if raw_key and raw_key.strip():
        return _clean_meteofrance_api_key(raw_key)
    if allow_server_key:
        return _server_meteofrance_api_key_required()
    raise HTTPException(status_code=400, detail="Clé API Météo-France invalide.")


def _clean_meteofrance_api_key(raw_key: str) -> str:
    api_key = raw_key.strip()
    if api_key.lower().startswith("apikey:"):
        api_key = api_key.split(":", 1)[1].strip()
    if api_key.lower().startswith("authorization:"):
        api_key = api_key.split(":", 1)[1].strip()
    if api_key.lower().startswith("bearer "):
        api_key = api_key[7:].strip()
    if not api_key or any(ch in api_key for ch in "\r\n"):
        raise HTTPException(status_code=400, detail="Clé API Météo-France invalide.")
    return api_key


def _decode_response_preview(raw: bytes, limit: int = 900) -> str:
    text = raw.decode("utf-8", errors="replace")
    text = " ".join(text.split())
    return text[:limit]


def _meteofrance_http_message(status: int) -> str:
    if status == 401:
        return "Clé API refusée ou expirée. Regénère-la depuis le portail Météo-France."
    if status == 403:
        return "Clé reconnue, mais accès interdit : vérifie l’abonnement à l’API AROME / Prévision."
    if status == 404:
        return "Endpoint AROME introuvable côté Météo-France."
    if status == 429:
        return "Quota Météo-France dépassé pour cette clé."
    if 500 <= status <= 599:
        return "Service Météo-France temporairement indisponible."
    return f"Météo-France a répondu HTTP {status}."


def _fetch_meteofrance_bytes(api_key: str, url: str, accept: str, read_limit: int) -> tuple[int, str, bytes]:
    request = urllib.request.Request(
        url,
        headers={
            "Accept": accept,
            "apikey": api_key,
            "User-Agent": f"ObjectiFoudre/{APP_VERSION}",
        },
        method="GET",
    )
    status, content_type, raw, _headers = _read_meteofrance_request_with_retries(request, read_limit)
    return status, content_type, raw


def _is_meteofrance_transient_network_error(exc: Exception) -> bool:
    if isinstance(exc, urllib.error.HTTPError):
        return False
    return isinstance(
        exc,
        (
            urllib.error.URLError,
            TimeoutError,
            ConnectionResetError,
            http.client.RemoteDisconnected,
            http.client.IncompleteRead,
        ),
    )


def _read_meteofrance_request_with_retries(
    request: urllib.request.Request,
    read_limit: int,
    *,
    attempts: int = 3,
) -> tuple[int, str, bytes, dict[str, str]]:
    global _meteofrance_last_external_request_at
    last_exc: Exception | None = None
    total_attempts = max(1, int(attempts))
    for attempt in range(total_attempts):
        try:
            with _meteofrance_external_request_lock:
                delay = float(METEOFRANCE_EXTERNAL_REQUEST_MIN_INTERVAL_SECONDS)
                if delay > 0:
                    elapsed = time.monotonic() - _meteofrance_last_external_request_at
                    wait_seconds = delay - elapsed
                    if wait_seconds > 0:
                        time.sleep(wait_seconds)
                try:
                    with urllib.request.urlopen(request, timeout=METEOFRANCE_TEST_TIMEOUT_SECONDS) as response:
                        raw = response.read(read_limit)
                        return response.status, response.headers.get("content-type", ""), raw, {k.lower(): v for k, v in response.headers.items()}
                finally:
                    _meteofrance_last_external_request_at = time.monotonic()
        except Exception as exc:
            if not _is_meteofrance_transient_network_error(exc) or attempt >= total_attempts - 1:
                raise
            last_exc = exc
            retry_delay = float(METEOFRANCE_EXTERNAL_RETRY_BASE_DELAY_SECONDS) * (attempt + 1)
            if retry_delay > 0:
                time.sleep(retry_delay)
    if last_exc is not None:
        raise last_exc
    raise RuntimeError("Lecture Météo-France impossible.")


def _meteofrance_package_json_run_is_complete(payload_json: Any) -> bool:
    """Vrai si un JSON de produits de run AROME couvre tout l'horizon (groupes horaires
    jusqu'à METEOFRANCE_AROME_FORECAST_HORIZON_HOURS). Un listing de paquets/grille (sans
    groupe horaire) est considéré complet (stable) -> TTL long. Un run encore en cours de
    publication (groupes manquants) est partiel -> TTL court, pour le redécouvrir vite."""
    try:
        products = _package_product_links(payload_json) if isinstance(payload_json, dict) else []
    except Exception:
        return True
    groups = [str(item.get("time") or "") for item in products if item.get("time")]
    if not groups:
        return True
    max_end = 0
    for group in groups:
        bounds = _parse_meteofrance_grib_time_group_bounds(group)
        if bounds:
            max_end = max(max_end, bounds[1])
    return max_end >= int(_active_nwp_spec().get("forecast_horizon_hours") or METEOFRANCE_AROME_FORECAST_HORIZON_HOURS)


def _effective_package_json_cache_ttl(payload_json: Any) -> int:
    if _meteofrance_package_json_run_is_complete(payload_json):
        return METEOFRANCE_PACKAGE_JSON_CACHE_TTL_SECONDS
    return METEOFRANCE_PACKAGE_JSON_PARTIAL_RUN_CACHE_TTL_SECONDS


def _fetch_meteofrance_package_json(api_key: str, url: str, *, force_refresh: bool = False) -> tuple[int, str, dict[str, Any]]:
    cache_key = f"{_meteofrance_metadata_cache_key(api_key, 'package-json')}:{_stable_cache_hash(url)}"
    if not force_refresh:
        # TTL conscient de la complétude : un run partiel n'est gardé que quelques minutes,
        # un run complet (ou un listing sans groupe horaire) reste caché 3 h.
        entry = _cache.get(cache_key)
        if entry is not None:
            payload = dict(entry["payload"])
            if _cache_fresh(entry, ttl=_effective_package_json_cache_ttl(payload.get("json"))):
                return int(payload.get("status") or 200), str(payload.get("content_type") or "application/json"), dict(payload.get("json") or {})

        persistent = _read_meteofrance_persistent_cache(
            "package-json",
            cache_key,
            METEOFRANCE_PACKAGE_JSON_CACHE_TTL_SECONDS,
            source_url=url,
        )
        if persistent is not None:
            payload = dict(persistent["payload"])
            if (time.time() - float(persistent["ts"])) < _effective_package_json_cache_ttl(payload.get("json")):
                _set_cached_value(cache_key, payload)
                return int(payload.get("status") or 200), str(payload.get("content_type") or "application/json"), dict(payload.get("json") or {})

    request = urllib.request.Request(
        url,
        headers={
            "Accept": "text/json,application/json,*/*",
            "apikey": api_key,
            "Authorization": f"Bearer {api_key}",
            "User-Agent": f"ObjectiFoudre/{APP_VERSION}",
        },
        method="GET",
    )
    try:
        status, content_type, raw, _headers = _read_meteofrance_request_with_retries(request, METEOFRANCE_MODEL_PACKAGE_READ_LIMIT_BYTES)
        try:
            payload = json.loads(raw.decode("utf-8"))
        except json.JSONDecodeError as exc:
            raise ValueError(f"Réponse JSON Paquet Modèles invalide : {exc}") from exc
        stored = {"status": status, "content_type": content_type, "json": payload}
        _set_cached_value(cache_key, stored)
        _write_meteofrance_persistent_cache("package-json", cache_key, stored, source_url=url)
        return status, content_type, payload
    except urllib.error.HTTPError as exc:
        if exc.code == 429:
            stale = _read_meteofrance_persistent_cache(
                "package-json",
                cache_key,
                METEOFRANCE_PACKAGE_JSON_STALE_TTL_SECONDS,
                source_url=url,
            )
            if stale is not None:
                payload = dict(stale["payload"])
                _set_cached_value(cache_key, payload)
                return int(payload.get("status") or 200), str(payload.get("content_type") or "application/json"), dict(payload.get("json") or {})
        raise



def _fetch_meteofrance_package_json_for_cache_policy(api_key: str, url: str, force_refresh: bool) -> tuple[int, str, dict[str, Any]]:
    if force_refresh:
        return _fetch_meteofrance_package_json(api_key, url, force_refresh=True)
    return _fetch_meteofrance_package_json(api_key, url)

def _fetch_meteofrance_package_bytes(api_key: str, url: str, range_bytes: int | None = None, range_start: int = 0) -> tuple[int, str, bytes, dict[str, str]]:
    headers = {
        "Accept": "application/octet-stream,*/*",
        "apikey": api_key,
        "Authorization": f"Bearer {api_key}",
        "User-Agent": f"ObjectiFoudre/{APP_VERSION}",
    }
    if range_bytes:
        start = max(0, int(range_start))
        headers["Range"] = f"bytes={start}-{start + max(0, int(range_bytes) - 1)}"
    request = urllib.request.Request(url, headers=headers, method="GET")
    return _read_meteofrance_request_with_retries(request, int(range_bytes or METEOFRANCE_MODEL_PACKAGE_PROBE_RANGE_BYTES))


def _fetch_meteofrance_package_full_bytes(
    api_key: str,
    url: str,
    max_bytes: int = METEOFRANCE_MODEL_PACKAGE_FULL_PROBE_LIMIT_BYTES,
) -> tuple[int, str, bytes, dict[str, str], bool]:
    headers = {
        "Accept": "application/octet-stream,*/*",
        "apikey": api_key,
        "Authorization": f"Bearer {api_key}",
        "User-Agent": f"ObjectiFoudre/{APP_VERSION}",
    }
    request = urllib.request.Request(url, headers=headers, method="GET")
    limit = max(1, int(max_bytes))
    status, content_type, raw, response_headers = _read_meteofrance_request_with_retries(request, limit + 1)
    truncated_by_limit = len(raw) > limit
    if truncated_by_limit:
        raw = raw[:limit]
    return status, content_type, raw, response_headers, truncated_by_limit


def _meteofrance_failure_result(exc: Exception, target: str) -> dict[str, Any]:
    if isinstance(exc, urllib.error.HTTPError):
        raw = exc.read(2048)
        return {
            "ok": False,
            "status": exc.code,
            "message": _meteofrance_http_message(exc.code),
            "target": target,
            "content_type": exc.headers.get("content-type", "") if exc.headers else "",
            "preview": _decode_response_preview(raw, limit=320),
        }
    if isinstance(exc, urllib.error.URLError):
        return {
            "ok": False,
            "status": None,
            "message": f"Impossible de joindre Météo-France : {exc.reason}",
            "target": target,
            "content_type": "",
            "preview": "",
        }
    if _is_meteofrance_transient_network_error(exc):
        return {
            "ok": False,
            "status": None,
            "message": f"Connexion Météo-France interrompue après plusieurs tentatives : {exc}",
            "target": target,
            "content_type": "",
            "preview": "",
        }
    if isinstance(exc, TimeoutError):
        return {
            "ok": False,
            "status": None,
            "message": "Timeout pendant l’appel Météo-France.",
            "target": target,
            "content_type": "",
            "preview": "",
        }
    return {
        "ok": False,
        "status": None,
        "message": f"Erreur pendant l’appel Météo-France : {exc}",
        "target": target,
        "content_type": "",
        "preview": "",
    }


def _normalize_meteofrance_package_url(url: str) -> str:
    # Quirk API Météo-France : les liens HATEOAS omettent le segment /v1 après
    # DPPaquet<MODELE> ; valable pour tous les modèles paquets (AROME, ARPEGE…).
    if "/previnum/DPPaquet" not in url or "/models/" not in url:
        return url
    head, _, tail = url.partition("/models/")
    if head.endswith("/v1"):
        return url
    return f"{head}/v1/models/{tail}"


def _payload_links(payload: dict[str, Any]) -> list[dict[str, Any]]:
    raw_links = payload.get("links", [])
    if isinstance(raw_links, dict):
        values = []
        for value in raw_links.values():
            if isinstance(value, list):
                values.extend(item for item in value if isinstance(item, dict))
            elif isinstance(value, dict):
                values.append(value)
        raw_links = values
    if not isinstance(raw_links, list):
        return []
    return [item for item in raw_links if isinstance(item, dict)]


def _url_last_path_segment(url: str) -> str:
    path = urllib.parse.urlparse(url).path.rstrip("/")
    return urllib.parse.unquote(path.rsplit("/", 1)[-1]) if path else ""


def _query_param_from_url(url: str, name: str) -> str | None:
    values = urllib.parse.parse_qs(urllib.parse.urlparse(url).query).get(name)
    return values[0] if values else None


def _catalog_items_from_links(payload: dict[str, Any], marker: str) -> list[dict[str, str]]:
    items = []
    seen = set()
    for link in _payload_links(payload):
        href = str(link.get("href") or "")
        if marker not in href:
            continue
        if marker == "/grids/" and "/packages/" in href:
            continue
        item_id = _url_last_path_segment(href)
        if not item_id or item_id in {"grids", "packages"} or item_id in seen:
            continue
        seen.add(item_id)
        items.append(
            {
                "id": item_id,
                "title": str(link.get("title") or item_id),
                "href": _normalize_meteofrance_package_url(href),
                "type": str(link.get("type") or ""),
            }
        )
    return items


def _test_meteofrance_wms_sync(api_key: str) -> dict[str, Any]:
    try:
        status, content_type, raw = _fetch_meteofrance_bytes(
            api_key,
            METEOFRANCE_AROME_WMS_CAPABILITIES_URL,
            "application/xml,text/xml,*/*",
            4096,
        )
        preview = _decode_response_preview(raw)
        looks_like_wms = "WMS_Capabilities" in preview or "<Layer" in preview
        return {
            "ok": bool(200 <= status < 300 and looks_like_wms),
            "status": status,
            "message": "Clé API acceptée : le catalogue AROME WMS répond correctement." if looks_like_wms else "Clé API acceptée, mais la réponse ne ressemble pas au catalogue WMS attendu.",
            "target": "AROME WMS GetCapabilities",
            "content_type": content_type,
            "preview": preview[:320],
        }
    except Exception as exc:
        return _meteofrance_failure_result(exc, "AROME WMS GetCapabilities")


def _xml_local_name(tag: str) -> str:
    if "}" in tag:
        return tag.rsplit("}", 1)[1]
    return tag


def _coverage_prefix(coverage_id: str) -> str:
    return coverage_id.split("___", 1)[0]


def _coverage_prefix_candidates(item: dict[str, Any]) -> list[str]:
    candidates = []
    for key in ("coverage_prefix", "coverage_prefixes"):
        raw = item.get(key)
        if isinstance(raw, str):
            candidates.append(raw)
        elif isinstance(raw, list):
            candidates.extend(str(value) for value in raw if value)
    seen = set()
    ordered = []
    for candidate in candidates:
        if candidate not in seen:
            seen.add(candidate)
            ordered.append(candidate)
    return ordered


def _meteofrance_prefix_match_score(prefix: str, item: dict[str, Any]) -> int:
    upper = prefix.upper()
    score = 0
    for token in item.get("match_prefer_tokens", []):
        if str(token).upper() in upper:
            score += 3
    for token in item.get("match_avoid_tokens", []):
        if str(token).upper() in upper:
            score -= 5
    if "GROUND_OR_WATER_SURFACE" in upper:
        score += 4
    if "SURFACE" in upper:
        score += 1
    return score


def _resolve_meteofrance_coverage_id(latest_by_prefix: dict[str, str], item: dict[str, Any]) -> tuple[str | None, str | None]:
    for prefix in _coverage_prefix_candidates(item):
        coverage_id = latest_by_prefix.get(prefix)
        if coverage_id:
            return coverage_id, prefix

    tokens = [str(token).upper() for token in item.get("match_tokens", []) if token]
    if tokens:
        matching_prefixes = [
            prefix
            for prefix in latest_by_prefix
            if all(token in prefix.upper() for token in tokens)
        ]
        if matching_prefixes:
            prefix = max(
                matching_prefixes,
                key=lambda value: (_meteofrance_prefix_match_score(value, item), -len(value), value),
            )
            return latest_by_prefix[prefix], prefix
    return None, None


def _meteofrance_slot_grid_detail_level(detail_level: str | None) -> str:
    text = (detail_level or "").strip().lower()
    return (
        METEOFRANCE_SLOT_GRID_ADVANCED_DETAIL
        if text == METEOFRANCE_SLOT_GRID_ADVANCED_DETAIL
        else METEOFRANCE_SLOT_GRID_CORE_DETAIL
    )


def _meteofrance_slot_grid_specs_for_detail(detail_level: str) -> tuple[list[dict[str, Any]], list[str]]:
    normalized = _meteofrance_slot_grid_detail_level(detail_level)
    active_specs = [
        spec
        for spec in METEOFRANCE_SLOT_GRID_SPECS
        if normalized == METEOFRANCE_SLOT_GRID_ADVANCED_DETAIL or not spec.get("optional")
    ]
    skipped_optional = [
        spec["field"]
        for spec in METEOFRANCE_SLOT_GRID_SPECS
        if spec.get("optional") and normalized != METEOFRANCE_SLOT_GRID_ADVANCED_DETAIL
    ]
    return active_specs, skipped_optional


def _parse_meteofrance_wcs_capabilities(raw: bytes) -> dict[str, Any]:
    root = ET.fromstring(raw)
    coverage_ids: list[str] = []
    for element in root.iter():
        if _xml_local_name(element.tag) == "CoverageId":
            coverage_id = (element.text or "").strip()
            if coverage_id:
                coverage_ids.append(coverage_id)

    latest_by_prefix: dict[str, str] = {}
    for coverage_id in coverage_ids:
        prefix = _coverage_prefix(coverage_id)
        current = latest_by_prefix.get(prefix)
        if current is None or coverage_id > current:
            latest_by_prefix[prefix] = coverage_id

    prefixes = set(latest_by_prefix)
    required = []
    for item in METEOFRANCE_OBJECTIFOUDRE_FIELDS:
        coverage_id, resolved_prefix = _resolve_meteofrance_coverage_id(latest_by_prefix, item)
        direct_prefix = resolved_prefix or item.get("coverage_prefix")
        depends_on = list(item.get("depends_on", []))
        if direct_prefix:
            depends_on = depends_on or [direct_prefix]
        available = bool(coverage_id) if _coverage_prefix_candidates(item) else all(prefix in prefixes for prefix in depends_on)
        required.append(
            {
                "field": item["field"],
                "label": item["label"],
                "mode": item["mode"],
                "coverage_prefix": direct_prefix,
                "coverage_id": coverage_id if coverage_id else (latest_by_prefix.get(direct_prefix) if direct_prefix else None),
                "depends_on": depends_on,
                "available": available,
                "optional": bool(item.get("optional")),
            }
        )

    required_missing = [item for item in required if not item["available"] and not item.get("optional")]
    optional_missing = [item for item in required if not item["available"] and item.get("optional")]
    required_items = [item for item in required if not item.get("optional")]
    return {
        "coverage_count": len(coverage_ids),
        "prefix_count": len(prefixes),
        "latest_by_prefix": latest_by_prefix,
        "available_prefixes": sorted(prefixes),
        "required": required,
        "missing": required_missing,
        "optional_missing": optional_missing,
        "objecti_foudre_ready": not required_missing,
        "ready_count": sum(1 for item in required_items if item["available"]),
        "required_count": len(required_items),
        "optional_ready_count": sum(1 for item in required if item.get("optional") and item["available"]),
        "optional_count": sum(1 for item in required if item.get("optional")),
    }


def _build_meteofrance_wcs_capabilities(api_key: str) -> dict[str, Any]:
    cache_key = _meteofrance_metadata_cache_key(api_key, "wcs-capabilities")
    cached = _get_cached_value(cache_key, ttl=METEOFRANCE_METADATA_CACHE_TTL_SECONDS)
    if cached is not None:
        parsed = dict(cached["payload"])
        parsed["metadata_cache_hit"] = True
        return parsed

    status, content_type, raw = _fetch_meteofrance_bytes(
        api_key,
        METEOFRANCE_AROME_WCS_CAPABILITIES_URL,
        "application/xml,text/xml,*/*",
        METEOFRANCE_WCS_READ_LIMIT_BYTES,
    )
    parsed = _parse_meteofrance_wcs_capabilities(raw)
    parsed["status"] = status
    parsed["content_type"] = content_type
    parsed["metadata_cache_hit"] = False
    _set_cached_value(cache_key, parsed)
    return dict(parsed)


def _test_meteofrance_wcs_sync(api_key: str) -> dict[str, Any]:
    target = "AROME WCS GetCapabilities"
    try:
        parsed = _build_meteofrance_wcs_capabilities(api_key)
        ready = parsed["objecti_foudre_ready"]
        missing_labels = ", ".join(item["label"] for item in parsed["missing"][:4])
        message = (
            f"WCS OK : {parsed['ready_count']}/{parsed['required_count']} champs ObjectiFoudre disponibles."
            if ready
            else f"WCS OK, mais champs manquants pour migration complète : {missing_labels}."
        )
        return {
            "ok": bool(200 <= parsed["status"] < 300 and parsed["coverage_count"] > 0),
            "status": parsed["status"],
            "message": message,
            "target": target,
            "content_type": parsed["content_type"],
            "coverage_count": parsed["coverage_count"],
            "prefix_count": parsed["prefix_count"],
            "required": parsed["required"],
            "missing": parsed["missing"],
            "optional_missing": parsed["optional_missing"],
            "objecti_foudre_ready": ready,
            "ready_count": parsed["ready_count"],
            "required_count": parsed["required_count"],
            "optional_ready_count": parsed["optional_ready_count"],
            "optional_count": parsed["optional_count"],
            "metadata_cache_hit": bool(parsed.get("metadata_cache_hit")),
            "metadata_cache_ttl_seconds": METEOFRANCE_METADATA_CACHE_TTL_SECONDS,
        }
    except ET.ParseError as exc:
        return {
            "ok": False,
            "status": None,
            "message": f"Catalogue WCS illisible : {exc}",
            "target": target,
            "content_type": "",
            "preview": _decode_response_preview(raw[:320]) if "raw" in locals() else "",
        }
    except Exception as exc:
        return _meteofrance_failure_result(exc, target)


def _test_meteofrance_api_key_sync(api_key: str) -> dict[str, Any]:
    wms = _test_meteofrance_wms_sync(api_key)
    if not wms["ok"]:
        return {
            **wms,
            "wms": wms,
            "wcs": None,
        }

    wcs = _test_meteofrance_wcs_sync(api_key)
    migration_ready = bool(wcs.get("ok") and wcs.get("objecti_foudre_ready"))
    if migration_ready:
        message = f"Clé API OK : WMS et WCS répondent. {wcs['ready_count']}/{wcs['required_count']} champs ObjectiFoudre sont disponibles ou calculables."
    elif wcs.get("ok"):
        message = wcs.get("message", "WCS répond, mais la compatibilité complète reste à vérifier.")
    else:
        message = f"WMS OK, mais WCS indisponible : {wcs.get('message', 'erreur inconnue')}"
    return {
        "ok": migration_ready,
        "status": wcs.get("status") or wms.get("status"),
        "message": message,
        "target": "AROME WMS/WCS GetCapabilities",
        "content_type": wcs.get("content_type") or wms.get("content_type", ""),
        "wms": wms,
        "wcs": wcs,
    }


def _choose_meteofrance_package_grid(
    grids: list[dict[str, str]],
    requested_grid: str | None,
    preferred_grids: list[str] | None = None,
) -> str | None:
    available = {item["id"] for item in grids}
    if requested_grid and requested_grid in available:
        return requested_grid
    for preferred in preferred_grids if preferred_grids is not None else METEOFRANCE_AROME_PACKAGE_PREFERRED_GRIDS:
        if preferred in available:
            return preferred
    return grids[0]["id"] if grids else None


def _package_run_links(payload: dict[str, Any]) -> list[dict[str, str]]:
    runs = []
    seen = set()
    for link in _payload_links(payload):
        href = str(link.get("href") or "")
        reference_time = str(link.get("reference_time") or _query_param_from_url(href, "referencetime") or "")
        if not reference_time:
            continue
        if reference_time in seen:
            continue
        seen.add(reference_time)
        runs.append(
            {
                "reference_time": reference_time,
                "title": str(link.get("title") or reference_time),
                "href": _normalize_meteofrance_package_url(href),
            }
        )
    return sorted(runs, key=lambda item: item["reference_time"], reverse=True)


def _package_product_links(payload: dict[str, Any]) -> list[dict[str, str]]:
    products = []
    for link in _payload_links(payload):
        href = str(link.get("href") or "")
        time_group = str(link.get("time") or _query_param_from_url(href, "time") or "")
        if not time_group:
            continue
        products.append(
            {
                "time": time_group,
                "reference_time": str(link.get("reference_time") or _query_param_from_url(href, "referencetime") or ""),
                "insert_time": str(link.get("insert_time") or ""),
                "title": str(link.get("title") or time_group),
                "href": _normalize_meteofrance_package_url(href),
                "type": str(link.get("type") or ""),
                "format": str(_query_param_from_url(href, "format") or ""),
            }
        )
    return products


def _resolve_meteofrance_package_product(
    api_key: str,
    requested_grid: str | None,
    package_id: str,
    requested_time_group: str | None,
    *,
    force_refresh: bool = False,
) -> dict[str, Any]:
    package_id = package_id.strip().upper()
    cache_key = _meteofrance_metadata_cache_key(
        api_key,
        f"package-product:grid={requested_grid or 'auto'}:package={package_id}:time={requested_time_group or 'auto'}",
    )
    if not force_refresh:
        cached = _get_cached_value(cache_key, ttl=METEOFRANCE_METADATA_CACHE_TTL_SECONDS)
        if cached is not None:
            result = copy.deepcopy(cached["payload"])
            result["metadata_cache_hit"] = True
            return result

    context = _resolve_meteofrance_package_base(api_key, requested_grid, force_refresh=force_refresh)
    statuses = context["statuses"]
    selected_grid = context["grid"]
    packages_url = context["packages_url"]
    packages = context["packages"]
    package_ids = {item["id"] for item in packages}
    if package_id not in package_ids:
        raise ValueError(f"Paquet {package_id} absent de la grille {selected_grid}.")

    package_url = f"{packages_url}/{urllib.parse.quote(package_id)}"
    status, content_type, package_payload = _fetch_meteofrance_package_json_for_cache_policy(api_key, package_url, force_refresh)
    statuses.append({"step": f"package:{package_id}", "status": status, "content_type": content_type})
    run_links = _package_run_links(package_payload)
    if not run_links:
        raise ValueError(f"Aucun réseau disponible pour le paquet {package_id}.")

    latest_run = run_links[0]
    status, content_type, run_payload = _fetch_meteofrance_package_json_for_cache_policy(api_key, latest_run["href"], force_refresh)
    statuses.append({"step": f"package:{package_id}:run", "status": status, "content_type": content_type})
    product_links = _package_product_links(run_payload)
    if not product_links:
        raise ValueError(f"Aucun produit GRIB disponible pour le paquet {package_id}.")

    selected_product = None
    if requested_time_group:
        selected_product = next((item for item in product_links if item["time"] == requested_time_group), None)
    selected_product = selected_product or product_links[0]
    result = {
        "statuses": statuses,
        "grid": selected_grid,
        "package_id": package_id,
        "package_title": next((item["title"] for item in packages if item["id"] == package_id), package_id),
        "package_description": str(package_payload.get("description") or ""),
        "reference_time": latest_run["reference_time"],
        "available_time_groups": [item["time"] for item in product_links],
        "product": selected_product,
        "metadata_cache_hit": False,
    }
    _set_cached_value(cache_key, copy.deepcopy(result))
    return result


def _parse_meteofrance_grib_time_group_bounds(time_group: str | None) -> tuple[int, int] | None:
    text = str(time_group or "").strip().upper()
    parts = [part for part in text.split("H") if part != ""]
    if len(parts) < 2:
        return None
    try:
        start = int(parts[0])
        end = int(parts[1])
    except ValueError:
        return None
    return min(start, end), max(start, end)


def _choose_meteofrance_grib_product_for_slot(product_links: list[dict[str, str]], reference_time: str, target_date: Date, hour: int) -> tuple[dict[str, str], dict[str, Any]]:
    if not product_links:
        raise ValueError("Aucun produit GRIB disponible.")
    reference_dt = _parse_meteofrance_datetime(reference_time)
    target_local = datetime.combine(target_date, Time(hour=hour), tzinfo=ZoneInfo("Europe/Paris"))
    target_utc = target_local.astimezone(timezone.utc)
    forecast_hour_raw = int(hour)
    if reference_dt is not None:
        forecast_hour_raw = int(round((target_utc - reference_dt).total_seconds() / 3600))

    def distance(item: dict[str, str]) -> tuple[int, int, str]:
        bounds = _parse_meteofrance_grib_time_group_bounds(item.get("time"))
        if bounds is None:
            return (10_000, 10_000, str(item.get("time") or ""))
        start, end = bounds
        if start <= forecast_hour_raw <= end:
            return (0, 0, str(item.get("time") or ""))
        return (min(abs(forecast_hour_raw - start), abs(forecast_hour_raw - end)), start, str(item.get("time") or ""))

    selected = min(product_links, key=distance)
    selected_bounds = _parse_meteofrance_grib_time_group_bounds(selected.get("time"))
    if selected_bounds is None:
        forecast_hour = max(0, forecast_hour_raw)
    else:
        forecast_hour = max(selected_bounds[0], min(selected_bounds[1], forecast_hour_raw))
    forecast_hour_delta = forecast_hour - forecast_hour_raw
    return selected, {
        "reference_time": reference_time,
        "target_local": target_local.isoformat(),
        "target_utc": target_utc.isoformat(),
        "forecast_hour_raw": forecast_hour_raw,
        "forecast_hour": forecast_hour,
        "time_group": selected.get("time"),
        "time_group_bounds": list(selected_bounds) if selected_bounds else None,
        "forecast_hour_delta": forecast_hour_delta,
        "exact_forecast_hour": forecast_hour_delta == 0,
    }


def _choose_meteofrance_grib_run_product_for_slot(
    api_key: str,
    statuses: list[dict[str, Any]],
    run_links: list[dict[str, str]],
    target_date: Date,
    hour: int,
    *,
    force_refresh: bool = False,
) -> dict[str, Any]:
    target_local = datetime.combine(target_date, Time(hour=hour), tzinfo=ZoneInfo("Europe/Paris"))
    target_utc = target_local.astimezone(timezone.utc)

    def rank_run(item: tuple[int, dict[str, str]]) -> tuple[int, int, int]:
        run_index, run = item
        reference_dt = _parse_meteofrance_datetime(str(run.get("reference_time") or ""))
        if reference_dt is None:
            return (3, 100_000, run_index)
        forecast_hour_raw = int(round((target_utc - reference_dt).total_seconds() / 3600))
        if 0 <= forecast_hour_raw <= 72:
            return (0, forecast_hour_raw, run_index)
        if forecast_hour_raw > 72:
            return (1, forecast_hour_raw - 72, run_index)
        return (2, abs(forecast_hour_raw), run_index)

    ranked_runs = sorted(
        enumerate(run_links[:METEOFRANCE_GRIB_RUN_SELECTION_MAX_RUNS]),
        key=rank_run,
    )
    candidates = []
    for run_index, run in ranked_runs:
        status, content_type, run_payload = _fetch_meteofrance_package_json_for_cache_policy(api_key, run["href"], force_refresh)
        statuses.append({"step": f"run:{run.get("reference_time") or run_index}", "status": status, "content_type": content_type})
        product_links = _package_product_links(run_payload)
        if not product_links:
            continue
        selected_product, time_target = _choose_meteofrance_grib_product_for_slot(
            product_links,
            run["reference_time"],
            target_date,
            hour,
        )
        candidate = {
            "run": run,
            "run_index": run_index,
            "run_rank": rank_run((run_index, run)),
            "product_links": product_links,
            "product": selected_product,
            "time_target": time_target,
        }
        candidates.append(candidate)
        if time_target.get("exact_forecast_hour"):
            return candidate
        if len(candidates) >= 4:
            break
    if not candidates:
        raise ValueError("Aucun produit GRIB disponible pour les réseaux AROME inspectés.")
    return min(
        candidates,
        key=lambda item: (
            abs(int(item["time_target"].get("forecast_hour_delta") or 0)),
            item.get("run_rank") or (9, 9, 9),
        ),
    )


def _meteofrance_grib_local_hours_for_time_group(time_target: dict[str, Any], selected_hour: int) -> list[int]:
    bounds = time_target.get("time_group_bounds")
    if not isinstance(bounds, list) or len(bounds) != 2:
        return [int(selected_hour)]
    try:
        start, end = int(bounds[0]), int(bounds[1])
        selected_forecast_hour = int(time_target.get("forecast_hour_raw"))
    except Exception:
        return [int(selected_hour)]
    selected_hour = int(selected_hour)
    hours = [
        hour
        for hour in range(24)
        if start <= selected_forecast_hour + (hour - selected_hour) <= end
    ]
    return hours or [selected_hour]


def _resolve_meteofrance_package_product_for_slot(
    api_key: str,
    requested_grid: str | None,
    package_id: str,
    target_date: Date,
    hour: int,
    *,
    force_refresh: bool = False,
) -> dict[str, Any]:
    package_id = package_id.strip().upper()
    cache_key = _meteofrance_metadata_cache_key(
        api_key,
        f"package-product-slot:grid={requested_grid or 'auto'}:package={package_id}:date={target_date.isoformat()}:hour={hour:02d}:run-window={METEOFRANCE_GRIB_RUN_SELECTION_MAX_RUNS}",
    )
    if not force_refresh:
        cached = _get_cached_value(cache_key, ttl=METEOFRANCE_METADATA_CACHE_TTL_SECONDS)
        if cached is not None:
            result = copy.deepcopy(cached["payload"])
            result["metadata_cache_hit"] = True
            return result

    context = _resolve_meteofrance_package_base(api_key, requested_grid, force_refresh=force_refresh)
    statuses = context["statuses"]
    selected_grid = context["grid"]
    packages_url = context["packages_url"]
    packages = context["packages"]
    package_ids = {item["id"] for item in packages}
    if package_id not in package_ids:
        raise ValueError(f"Paquet {package_id} absent de la grille {selected_grid}.")

    package_url = f"{packages_url}/{urllib.parse.quote(package_id)}"
    status, content_type, package_payload = _fetch_meteofrance_package_json_for_cache_policy(api_key, package_url, force_refresh)
    statuses.append({"step": f"package:{package_id}", "status": status, "content_type": content_type})
    run_links = _package_run_links(package_payload)
    if not run_links:
        raise ValueError(f"Aucun réseau disponible pour le paquet {package_id}.")

    run_choice = _choose_meteofrance_grib_run_product_for_slot(api_key, statuses, run_links, target_date, hour, force_refresh=force_refresh)
    selected_run = run_choice["run"]
    product_links = run_choice["product_links"]
    selected_product = run_choice["product"]
    time_target = run_choice["time_target"]
    result = {
        "statuses": statuses,
        "grid": selected_grid,
        "package_id": package_id,
        "package_title": next((item["title"] for item in packages if item["id"] == package_id), package_id),
        "package_description": str(package_payload.get("description") or ""),
        "reference_time": selected_run["reference_time"],
        "selected_run_index": run_choice.get("run_index"),
        "exact_forecast_hour": bool(time_target.get("exact_forecast_hour")),
        "available_time_groups": [item["time"] for item in product_links],
        "product": selected_product,
        "time_target": time_target,
        "metadata_cache_hit": False,
    }
    _set_cached_value(cache_key, copy.deepcopy(result))
    return result


def _resolve_meteofrance_package_product_candidates_for_slot(
    api_key: str,
    requested_grid: str | None,
    package_id: str,
    target_date: Date,
    hour: int,
    max_runs: int = METEOFRANCE_GRIB_RUN_SELECTION_MAX_RUNS,
) -> list[dict[str, Any]]:
    package_id = package_id.strip().upper()
    max_runs = max(1, min(METEOFRANCE_GRIB_RUN_SELECTION_MAX_RUNS, int(max_runs)))
    cache_key = _meteofrance_metadata_cache_key(
        api_key,
        f"package-product-candidates:grid={requested_grid or 'auto'}:package={package_id}:date={target_date.isoformat()}:hour={hour:02d}:max={max_runs}",
    )
    cached = _get_cached_value(cache_key, ttl=METEOFRANCE_METADATA_CACHE_TTL_SECONDS)
    if cached is not None:
        return copy.deepcopy(cached["payload"])

    context = _resolve_meteofrance_package_base(api_key, requested_grid)
    selected_grid = context["grid"]
    packages_url = context["packages_url"]
    packages = context["packages"]
    package_ids = {item["id"] for item in packages}
    if package_id not in package_ids:
        raise ValueError(f"Paquet {package_id} absent de la grille {selected_grid}.")

    package_url = f"{packages_url}/{urllib.parse.quote(package_id)}"
    _status, _content_type, package_payload = _fetch_meteofrance_package_json(api_key, package_url)
    run_links = _package_run_links(package_payload)
    if not run_links:
        raise ValueError(f"Aucun réseau disponible pour le paquet {package_id}.")

    candidates = []
    for run_index, run in enumerate(run_links[:max_runs]):
        status, content_type, run_payload = _fetch_meteofrance_package_json(api_key, run["href"])
        product_links = _package_product_links(run_payload)
        if not product_links:
            continue
        selected_product, time_target = _choose_meteofrance_grib_product_for_slot(
            product_links,
            run["reference_time"],
            target_date,
            hour,
        )
        candidates.append(
            {
                "statuses": list(context.get("statuses") or [])
                + [
                    {"step": f"package:{package_id}", "status": _status, "content_type": _content_type},
                    {"step": f"run:{run.get('reference_time') or run_index}", "status": status, "content_type": content_type},
                ],
                "grid": selected_grid,
                "package_id": package_id,
                "package_title": next((item["title"] for item in packages if item["id"] == package_id), package_id),
                "package_description": str(package_payload.get("description") or ""),
                "reference_time": run["reference_time"],
                "selected_run_index": run_index,
                "exact_forecast_hour": bool(time_target.get("exact_forecast_hour")),
                "available_time_groups": [item["time"] for item in product_links],
                "product": selected_product,
                "time_target": time_target,
                "metadata_cache_hit": False,
            }
        )
    candidates.sort(
        key=lambda item: (
            0 if item.get("exact_forecast_hour") else 1,
            abs(int(item.get("time_target", {}).get("forecast_hour_delta") or 0)),
            int(item.get("selected_run_index") or 0),
        )
    )
    _set_cached_value(cache_key, copy.deepcopy(candidates))
    return candidates


def _find_grib_target_in_alternate_run(
    api_key: str,
    requested_grid: str | None,
    package_id: str,
    target_date: Date,
    hour: int,
    current_product_href: str,
    package_specs: list[dict[str, Any]],
    parameter_label: str,
    level_contains: str | None,
    field: str | None,
    indexes: dict[Any, dict[str, Any]],
    cache_only: bool = False,
    package_only: bool = False,
) -> tuple[dict[str, Any] | None, dict[str, Any] | None, dict[str, Any] | None, int, int]:
    range_count = 0
    cached_count = 0
    if cache_only:
        cache_key = _meteofrance_metadata_cache_key(
            api_key,
            f"package-product-candidates:grid={requested_grid or 'auto'}:package={package_id.strip().upper()}:date={target_date.isoformat()}:hour={hour:02d}:max={METEOFRANCE_GRIB_RUN_SELECTION_MAX_RUNS}",
        )
        cached = _get_cached_value(cache_key, ttl=METEOFRANCE_METADATA_CACHE_TTL_SECONDS)
        candidates = copy.deepcopy(cached["payload"]) if cached is not None else []
    else:
        candidates = _resolve_meteofrance_package_product_candidates_for_slot(
            api_key,
            requested_grid,
            package_id,
            target_date,
            hour,
        )
    for candidate in candidates:
        product = candidate.get("product") if isinstance(candidate, dict) else None
        if not isinstance(product, dict):
            continue
        product_href = str(product.get("href") or "")
        if not product_href or product_href == current_product_href:
            continue
        forecast_hour = int(candidate.get("time_target", {}).get("forecast_hour") or 0)
        index_key = (package_id, product_href, forecast_hour)
        index = indexes.get(index_key)
        if index is None:
            index = _index_grib_message_headers_cached(
                api_key,
                product_href,
                max_messages=_meteofrance_grib_slot_index_limit(package_id),
                stop_when=_grib_slot_index_stop_when(package_specs, forecast_hour),
                cache_only=cache_only,
                package_only=package_only,
            )
            indexes[index_key] = index
            range_count += int(index.get("range_request_count") or 0)
            cached_count += int(index.get("cached_range_request_count") or 0)
        index, selected_message, retry_ranges = _ensure_grib_target_message_indexed(
            api_key,
            product_href,
            package_id,
            package_specs,
            forecast_hour,
            parameter_label,
            level_contains,
            index,
            field=field,
            cache_only=cache_only,
            package_only=package_only,
        )
        if retry_ranges:
            indexes[index_key] = index
            range_count += retry_ranges
        if selected_message is not None:
            annotated = copy.deepcopy(selected_message)
            annotated["_run_fallback"] = "older-run-content"
            annotated["_run_fallback_reference_time"] = candidate.get("reference_time")
            return candidate, index, annotated, range_count, cached_count
    return None, None, None, range_count, cached_count


def _resolve_meteofrance_package_product_for_slot_cache_only(
    api_key: str,
    requested_grid: str | None,
    package_id: str,
    target_date: Date,
    hour: int,
) -> dict[str, Any] | None:
    package_id = package_id.strip().upper()
    cache_key = _meteofrance_metadata_cache_key(
        api_key,
        f"package-product-slot:grid={requested_grid or 'auto'}:package={package_id}:date={target_date.isoformat()}:hour={hour:02d}:run-window={METEOFRANCE_GRIB_RUN_SELECTION_MAX_RUNS}",
    )
    cached = _get_cached_value(cache_key, ttl=METEOFRANCE_METADATA_CACHE_TTL_SECONDS)
    if cached is None:
        return None
    result = copy.deepcopy(cached["payload"])
    result["metadata_cache_hit"] = True
    result["metadata_cache_only"] = True
    return result


def _resolve_meteofrance_package_base(
    api_key: str,
    requested_grid: str | None,
    *,
    force_refresh: bool = False,
    model: str | None = None,
) -> dict[str, Any]:
    model = model or _active_nwp_model()
    spec = _nwp_model_spec(model)
    cache_key = _meteofrance_metadata_cache_key(api_key, f"package-base:grid={requested_grid or 'auto'}", model)
    if not force_refresh:
        cached = _get_cached_value(cache_key, ttl=METEOFRANCE_METADATA_CACHE_TTL_SECONDS)
        if cached is not None:
            result = copy.deepcopy(cached["payload"])
            result["metadata_cache_hit"] = True
            return result

    statuses = []
    grids_url = f"{spec['package_api_base']}/models/{spec['package_model']}/grids"
    status, content_type, grids_payload = _fetch_meteofrance_package_json_for_cache_policy(api_key, grids_url, force_refresh)
    statuses.append({"step": "grids", "status": status, "content_type": content_type})
    grids = _catalog_items_from_links(grids_payload, "/grids/")
    selected_grid = _choose_meteofrance_package_grid(grids, requested_grid, spec["preferred_grids"])
    if not selected_grid:
        raise ValueError(f"Aucune grille {spec['package_model']} exploitable trouvée.")

    packages_url = f"{spec['package_api_base']}/models/{spec['package_model']}/grids/{urllib.parse.quote(selected_grid)}/packages"
    status, content_type, packages_payload = _fetch_meteofrance_package_json_for_cache_policy(api_key, packages_url, force_refresh)
    statuses.append({"step": "packages", "status": status, "content_type": content_type})
    packages = _catalog_items_from_links(packages_payload, "/packages/")
    result = {
        "statuses": statuses,
        "model": spec["package_model"],
        "grid": selected_grid,
        "packages_url": packages_url,
        "packages": packages,
        "metadata_cache_hit": False,
    }
    _set_cached_value(cache_key, copy.deepcopy(result))
    return result


def _scan_grib_messages(raw: bytes, max_messages: int = 64) -> dict[str, Any]:
    messages = []
    pos = 0
    while pos < len(raw) and len(messages) < max_messages:
        start = raw.find(b"GRIB", pos)
        if start < 0:
            break
        if start + 16 > len(raw):
            messages.append({"offset": start, "header_complete": False, "complete": False})
            break
        discipline = raw[start + 6]
        edition = raw[start + 7]
        total_length = int.from_bytes(raw[start + 8:start + 16], "big")
        complete = total_length > 0 and start + total_length <= len(raw)
        messages.append(
            {
                "offset": start,
                "header_complete": True,
                "edition": edition,
                "discipline": discipline,
                "length": total_length,
                "complete": complete,
            }
        )
        pos = start + max(total_length, 4) if total_length > 0 else start + 4
    return {
        "is_grib": bool(messages),
        "message_count_in_sample": len(messages),
        "messages": messages[:12],
        "truncated_message_list": len(messages) >= max_messages,
        "signature_hex": raw[:16].hex(),
    }


def _parse_content_range_total(content_range: str | None) -> int | None:
    if not content_range or "/" not in content_range:
        return None
    total = content_range.rsplit("/", 1)[1].strip()
    if not total or total == "*":
        return None
    try:
        return int(total)
    except ValueError:
        return None


GRIB2_TIME_UNIT_TO_HOURS = {
    0: 1 / 60,
    1: 1,
    2: 24,
    10: 3,
    11: 6,
    12: 12,
}

GRIB2_PARAMETER_LABELS = {
    (0, 0, 0): "Température",
    (0, 0, 6): "Point de rosée",
    (0, 0, 10): "Flux net chaleur latente",
    (0, 0, 11): "Flux net chaleur sensible",
    (0, 1, 0): "Humidité spécifique",
    (0, 1, 1): "Humidité relative",
    (0, 1, 6): "Évaporation",
    (0, 1, 8): "Précipitations totales",
    (0, 1, 52): "Taux de précipitations total",
    (0, 1, 64): "Vapeur d’eau intégrée colonne",
    (0, 1, 83): "Eau liquide nuageuse spécifique",
    (0, 1, 84): "Glace nuageuse spécifique",
    (0, 2, 0): "Direction du vent",
    (0, 2, 1): "Vitesse du vent",
    (0, 2, 2): "Vent U",
    (0, 2, 3): "Vent V",
    (0, 2, 8): "Vitesse verticale pression",
    (0, 2, 9): "Vitesse verticale géométrique",
    (0, 2, 10): "Tourbillon absolu",
    (0, 2, 11): "Divergence absolue",
    (0, 2, 12): "Tourbillon relatif",
    (0, 2, 13): "Divergence relative",
    (0, 2, 14): "Tourbillon potentiel",
    (0, 2, 22): "Rafales",
    (0, 3, 0): "Pression",
    (0, 3, 18): "Hauteur de couche limite",
    (0, 4, 9): "Flux net rayonnement court",
    (0, 5, 3): "Flux descendant rayonnement long",
    (0, 6, 1): "Nébulosité totale",
    (0, 6, 3): "Nuages bas",
    (0, 6, 4): "Nuages moyens",
    (0, 6, 5): "Nuages hauts",
    (0, 7, 0): "Lifted index",
    (0, 7, 6): "CAPE",
    (0, 7, 7): "CIN",
    (0, 7, 8): "Hélicité relative à l’orage",
    (0, 16, 192): "Réflectivité radar pluie",
    (0, 16, 198): "Réflectivité simulée horaire max",
    (0, 19, 11): "Énergie cinétique turbulente",
}

GRIB2_SURFACE_LABELS = {
    1: "surface",
    2: "niveau nuageux",
    8: "sommet atmosphère",
    100: "niveau isobare",
    101: "couche entre isobares",
    103: "hauteur sol",
    104: "hauteur mer",
    106: "profondeur sol",
    107: "niveau isentropique",
    109: "niveau hybride",
    255: "manquant",
}


def _grib2_parameter_label(discipline: int, category: int, parameter_number: int) -> str:
    return GRIB2_PARAMETER_LABELS.get(
        (discipline, category, parameter_number),
        f"GRIB2 {discipline}.{category}.{parameter_number}",
    )


def _grib2_parameter_label_from_key(parameter_key: str | None) -> str | None:
    try:
        parts = [int(part) for part in str(parameter_key or "").split(".")]
    except ValueError:
        return None
    if len(parts) != 3:
        return None
    label = _grib2_parameter_label(parts[0], parts[1], parts[2])
    return label if not label.startswith("GRIB2 ") else None


def _grib2_signed_byte(value: int) -> int:
    return value - 256 if value > 127 else value


def _grib2_scaled_value(scale_factor: int | None, raw_value: bytes) -> float | int | None:
    if scale_factor is None or raw_value == b"\xff\xff\xff\xff":
        return None
    value = int.from_bytes(raw_value, "big", signed=True)
    scaled = value * (10 ** (-scale_factor))
    return int(scaled) if float(scaled).is_integer() else scaled


def _parse_grib2_surface(section: bytes, start: int) -> dict[str, Any] | None:
    if len(section) < start + 6:
        return None
    surface_type = section[start]
    scale_factor = None if section[start + 1] == 255 else _grib2_signed_byte(section[start + 1])
    value = _grib2_scaled_value(scale_factor, section[start + 2:start + 6])
    return {
        "type": surface_type,
        "label": GRIB2_SURFACE_LABELS.get(surface_type, f"type {surface_type}"),
        "scale_factor": scale_factor,
        "value": value,
    }


def _format_grib2_level(surface: dict[str, Any] | None) -> str:
    if not surface:
        return "niveau inconnu"
    surface_type = surface.get("type")
    value = surface.get("value")
    if surface_type == 1:
        return "surface"
    if surface_type == 103 and value is not None:
        return f"{value:g} m sol"
    if surface_type == 104 and value is not None:
        return f"{value:g} m mer"
    if surface_type == 100 and value is not None:
        return f"{float(value) / 100:g} hPa"
    if value is not None:
        return f"{surface.get('label', 'niveau')} {value:g}"
    return str(surface.get("label") or "niveau inconnu")


def _normalize_grib_number(value: float | int) -> float | int:
    if isinstance(value, float) and value.is_integer():
        return int(value)
    return value


def _parse_grib2_metadata(raw: bytes, offset: int, total_length: int) -> dict[str, Any]:
    message_limit = min(len(raw), total_length)
    metadata: dict[str, Any] = {
        "metadata_complete": False,
        "sections_complete": False,
        "sections": [],
    }
    pos = 16
    while pos + 5 <= message_limit:
        if raw[pos:pos + 4] == b"7777":
            metadata["sections"].append({"number": 8, "offset": offset + pos, "length": 4, "complete": True})
            metadata["sections_complete"] = True
            break
        section_length = int.from_bytes(raw[pos:pos + 4], "big")
        section_number = raw[pos + 4]
        if section_length < 5:
            metadata["sections"].append({"number": section_number, "offset": offset + pos, "length": section_length, "complete": False})
            break
        section_end = pos + section_length
        section_complete = section_end <= message_limit
        metadata["sections"].append(
            {
                "number": section_number,
                "offset": offset + pos,
                "length": section_length,
                "complete": section_complete,
            }
        )
        if not section_complete:
            break

        section = raw[pos:section_end]
        if section_number == 1 and len(section) >= 21:
            year = int.from_bytes(section[12:14], "big")
            metadata["identification"] = {
                "center": int.from_bytes(section[5:7], "big"),
                "subcenter": int.from_bytes(section[7:9], "big"),
                "master_table_version": section[9],
                "reference_time_significance": section[11],
                "reference_time": f"{year:04d}-{section[14]:02d}-{section[15]:02d}T{section[16]:02d}:{section[17]:02d}:{section[18]:02d}Z",
                "production_status": section[19],
                "data_type": section[20],
            }
        elif section_number == 3 and len(section) >= 14:
            metadata["grid"] = {
                "source": section[5],
                "data_points": int.from_bytes(section[6:10], "big"),
                "grid_template": int.from_bytes(section[12:14], "big"),
            }
        elif section_number == 4 and len(section) >= 11:
            discipline = raw[6]
            category = section[9]
            parameter_number = section[10]
            product: dict[str, Any] = {
                "template": int.from_bytes(section[7:9], "big"),
                "discipline": discipline,
                "category": category,
                "parameter_number": parameter_number,
                "parameter_key": f"{discipline}.{category}.{parameter_number}",
                "parameter_label": _grib2_parameter_label(discipline, category, parameter_number),
            }
            if len(section) >= 22:
                time_unit = section[17]
                forecast_time = int.from_bytes(section[18:22], "big", signed=True)
                product["time_unit"] = time_unit
                product["forecast_time"] = forecast_time
                if time_unit in GRIB2_TIME_UNIT_TO_HOURS:
                    product["forecast_hour"] = _normalize_grib_number(forecast_time * GRIB2_TIME_UNIT_TO_HOURS[time_unit])
            first_surface = _parse_grib2_surface(section, 22)
            second_surface = _parse_grib2_surface(section, 28)
            if first_surface:
                product["first_surface"] = first_surface
                product["level"] = _format_grib2_level(first_surface)
            if second_surface and second_surface.get("type") != 255:
                product["second_surface"] = second_surface
            metadata["product"] = product
            metadata["metadata_complete"] = True
        elif section_number == 5 and len(section) >= 11:
            metadata["data_representation"] = {
                "data_points": int.from_bytes(section[5:9], "big"),
                "template": int.from_bytes(section[9:11], "big"),
            }

        pos = section_end
    return metadata


def _parse_grib_header(raw: bytes, offset: int) -> dict[str, Any] | None:
    if len(raw) < 16 or raw[:4] != b"GRIB":
        return None
    total_length = int.from_bytes(raw[8:16], "big")
    if total_length < 16:
        return None
    return {
        "offset": offset,
        "edition": raw[7],
        "discipline": raw[6],
        "length": total_length,
        "end_offset": offset + total_length,
    }


def _index_grib_messages_from_buffer(raw: bytes, max_messages: int = 512) -> dict[str, Any]:
    messages: list[dict[str, Any]] = []
    pos = 0
    max_messages = max(1, int(max_messages))
    while pos < len(raw) and len(messages) < max_messages:
        start = raw.find(b"GRIB", pos)
        if start < 0:
            break
        if start + 16 > len(raw):
            messages.append({"offset": start, "header_complete": False, "complete": False})
            break
        total_length = int.from_bytes(raw[start + 8:start + 16], "big")
        if total_length < 16:
            pos = start + 4
            continue
        segment_end = min(len(raw), start + total_length)
        segment = raw[start:segment_end]
        header = _parse_grib_header(segment, start)
        if header is None:
            pos = start + 4
            continue
        header["header_complete"] = True
        header["complete"] = segment_end >= start + total_length
        if header.get("edition") == 2 and len(segment) > 16:
            header.update(_parse_grib2_metadata(segment, start, int(header["length"])))
        messages.append(header)
        pos = start + total_length
    next_offset = int(messages[-1].get("end_offset") or 0) if messages else 0
    return {
        "messages": _refresh_grib_index_labels(messages),
        "message_count_indexed": len(messages),
        "next_offset": next_offset,
        "total_size": len(raw),
        "complete": bool(messages and next_offset >= len(raw)),
        "truncated": bool(messages and next_offset < len(raw) and len(messages) >= max_messages),
        "range_request_count": 0,
        "parameter_summary": _summarize_grib_index_messages(messages),
        "statuses": [],
    }


def _index_grib_message_headers(
    api_key: str,
    product_href: str,
    max_messages: int,
    metadata_bytes: int = 4096,
    start_offset: int = 0,
    total_size: int | None = None,
    stop_when: Callable[[list[dict[str, Any]]], bool] | None = None,
) -> dict[str, Any]:
    messages = []
    offset = max(0, int(start_offset))
    statuses = []
    for _ in range(max_messages):
        status, content_type, raw, headers = _fetch_meteofrance_package_bytes(
            api_key,
            product_href,
            range_bytes=max(16, metadata_bytes),
            range_start=offset,
        )
        statuses.append({"offset": offset, "status": status, "content_type": content_type})
        if total_size is None:
            total_size = _parse_content_range_total(headers.get("content-range", ""))
        header = _parse_grib_header(raw, offset)
        if header is None:
            break
        if header["edition"] == 2 and len(raw) > 16:
            header.update(_parse_grib2_metadata(raw, offset, int(header["length"])))
        messages.append(header)
        offset = int(header["end_offset"])
        if stop_when is not None and stop_when(messages):
            break
        if total_size is not None and offset >= total_size:
            break
    parameter_summary = _summarize_grib_index_messages(messages)
    return {
        "messages": messages,
        "message_count_indexed": len(messages),
        "next_offset": offset,
        "total_size": total_size,
        "complete": bool(total_size is not None and offset >= total_size),
        "truncated": bool(messages and total_size is not None and offset < total_size and len(messages) >= max_messages),
        "range_request_count": len(statuses),
        "range_bytes_per_request": max(16, metadata_bytes),
        "parameter_summary": parameter_summary,
        "statuses": statuses,
    }


def _meteofrance_grib_progressive_index_cache_key(product_href: str, metadata_bytes: int) -> str:
    source = f"{product_href}|progressive|metadata={int(metadata_bytes)}"
    return f"meteofrance:grib-index:{_stable_cache_hash(source)}"


def _refresh_grib_index_labels(messages: list[dict[str, Any]]) -> list[dict[str, Any]]:
    refreshed = copy.deepcopy(messages)
    for message in refreshed:
        product = message.get("product")
        if not isinstance(product, dict):
            continue
        label = _grib2_parameter_label_from_key(str(product.get("parameter_key") or ""))
        if label:
            product["parameter_label"] = label
    return refreshed


def _slice_grib_index(index: dict[str, Any], max_messages: int) -> dict[str, Any]:
    out = copy.deepcopy(index)
    messages = _refresh_grib_index_labels(list(out.get("messages") or []))
    if len(messages) > max_messages:
        messages = messages[:max_messages]
    out["messages"] = messages
    out["message_count_indexed"] = len(messages)
    if messages:
        out["next_offset"] = int(messages[-1].get("end_offset") or messages[-1].get("offset") or 0)
    else:
        out["next_offset"] = int(out.get("next_offset") or 0)
    total_size = out.get("total_size")
    out["complete"] = bool(total_size is not None and int(out["next_offset"]) >= int(total_size))
    out["truncated"] = bool(messages and not out["complete"] and len(messages) >= max_messages)
    out["parameter_summary"] = _summarize_grib_index_messages(messages)
    statuses = list(out.get("statuses") or [])
    if len(statuses) > len(messages):
        out["statuses"] = statuses[:len(messages)]
    out["range_request_count"] = min(int(out.get("range_request_count") or len(out.get("statuses") or [])), len(messages))
    return out


def _annotate_grib_index_cache(index: dict[str, Any], *, hit: bool, backend: str, created_at: float | None) -> dict[str, Any]:
    out = copy.deepcopy(index)
    original_count = int(out.get("cached_range_request_count") or out.get("range_request_count") or 0)
    out["messages"] = _refresh_grib_index_labels(list(out.get("messages") or []))
    out["parameter_summary"] = _summarize_grib_index_messages(out["messages"])
    out["cached_range_request_count"] = original_count
    if hit:
        out["range_request_count"] = 0
    out["cache"] = _cache_status(hit, backend, created_at, METEOFRANCE_GRIB_INDEX_CACHE_TTL_SECONDS)
    return out


def _index_grib_message_headers_from_full_package_cached(
    api_key: str,
    product_href: str,
    max_messages: int,
    *,
    stop_when: Callable[[list[dict[str, Any]]], bool] | None = None,
    cache_only: bool = False,
) -> dict[str, Any] | None:
    full_package = _fetch_grib_full_package_cached(api_key, product_href, cache_only=cache_only)
    if not full_package.get("ok"):
        return None
    raw = full_package.get("raw")
    if not isinstance(raw, (bytes, bytearray)) or not raw:
        return None
    index_message_limit = max_messages
    if stop_when is not None:
        # A full package is already local at this point. Index farther inside it
        # so new fields can be found without raising the Range fallback limit.
        index_message_limit = max(max_messages, 512)
    index = _index_grib_messages_from_buffer(bytes(raw), max_messages=index_message_limit)
    messages = list(index.get("messages") or [])
    package_request_count = int(full_package.get("package_request_count") or 0)
    cached_package_request_count = int(full_package.get("cached_package_request_count") or 0)
    index.update(
        {
            "range_request_count": 0,
            "cached_range_request_count": 0,
            "package_request_count": package_request_count,
            "cached_package_request_count": cached_package_request_count,
            "estimated_range_requests_replaced": len(messages),
            "full_package_byte_count": int(full_package.get("byte_count") or len(raw)),
            "full_package_cache": full_package.get("cache"),
            "cache": full_package.get("cache"),
            "statuses": [
                {
                    "offset": 0,
                    "status": full_package.get("status"),
                    "content_type": full_package.get("content_type"),
                    "source": "full-package",
                    "byte_count": int(full_package.get("byte_count") or len(raw)),
                }
            ],
        }
    )
    index["satisfied_max_messages"] = max_messages if bool(index.get("complete")) or len(messages) >= max_messages else 0
    return index


def _index_grib_message_headers_cached(
    api_key: str,
    product_href: str,
    max_messages: int,
    metadata_bytes: int = 4096,
    stop_when: Callable[[list[dict[str, Any]]], bool] | None = None,
    cache_only: bool = False,
    package_only: bool = False,
) -> dict[str, Any]:
    max_messages = max(1, int(max_messages))
    cache_key = _meteofrance_grib_progressive_index_cache_key(product_href, metadata_bytes)
    cached = _get_cached_value(cache_key, ttl=METEOFRANCE_GRIB_INDEX_CACHE_TTL_SECONDS)
    existing_payload = None
    existing_created_at = None
    existing_backend = None
    if cached is not None:
        existing_payload = copy.deepcopy(cached["payload"])
        existing_created_at = float(cached["ts"])
        existing_backend = "memory"

    if existing_payload is None:
        persistent = _read_meteofrance_persistent_cache(
            "grib-index",
            cache_key,
            METEOFRANCE_GRIB_INDEX_CACHE_TTL_SECONDS,
            source_url=product_href,
        )
        if persistent is not None:
            existing_payload = copy.deepcopy(persistent["payload"])
            existing_created_at = float(persistent["ts"])
            existing_backend = "disk"
            _set_cached_value(cache_key, existing_payload)

    if existing_payload is not None:
        existing_payload["messages"] = _refresh_grib_index_labels(list(existing_payload.get("messages") or []))
        existing_payload["parameter_summary"] = _summarize_grib_index_messages(existing_payload["messages"])
        satisfied_max = int(existing_payload.get("satisfied_max_messages") or 0)
        if stop_when is not None and stop_when(list(existing_payload["messages"])):
            return _annotate_grib_index_cache(
                existing_payload,
                hit=True,
                backend=str(existing_backend or "memory"),
                created_at=existing_created_at,
            )
        if stop_when is None:
            if (
                bool(existing_payload.get("complete"))
                or int(existing_payload.get("message_count_indexed") or 0) >= max_messages
                or satisfied_max >= max_messages
            ):
                return _annotate_grib_index_cache(
                    _slice_grib_index(existing_payload, max_messages),
                    hit=True,
                    backend=str(existing_backend or "memory"),
                    created_at=existing_created_at,
                )
        elif bool(existing_payload.get("complete")) and not bool(existing_payload.get("truncated")):
            return _annotate_grib_index_cache(
                existing_payload,
                hit=True,
                backend=str(existing_backend or "memory"),
                created_at=existing_created_at,
            )

    if cache_only:
        if existing_payload is not None:
            result = _slice_grib_index(existing_payload, max_messages)
            result["range_request_count"] = 0
            result["cached_range_request_count"] = len(existing_payload.get("messages") or [])
            result["cache"] = _cache_status(True, str(existing_backend or "memory"), existing_created_at, METEOFRANCE_GRIB_INDEX_CACHE_TTL_SECONDS)
            result["cache_only_incomplete"] = True
            return result
        return {
            "messages": [],
            "message_count_indexed": 0,
            "next_offset": 0,
            "total_size": None,
            "complete": False,
            "truncated": False,
            "range_request_count": 0,
            "cached_range_request_count": 0,
            "range_bytes_per_request": max(16, metadata_bytes),
            "parameter_summary": _summarize_grib_index_messages([]),
            "statuses": [],
            "cache": _cache_status(False, "none", None, METEOFRANCE_GRIB_INDEX_CACHE_TTL_SECONDS),
            "cache_only_miss": True,
        }

    existing_messages = list(existing_payload.get("messages") or []) if existing_payload else []
    try:
        full_index = _index_grib_message_headers_from_full_package_cached(
            api_key,
            product_href,
            max_messages=max_messages,
            stop_when=stop_when,
            cache_only=cache_only,
        )
    except Exception:
        full_index = None
    if full_index is not None:
        stored = copy.deepcopy(full_index)
        stored.pop("cache", None)
        _set_cached_value(cache_key, stored)
        _write_meteofrance_persistent_cache("grib-index", cache_key, stored, source_url=product_href)
        if stop_when is not None and stop_when(list(full_index.get("messages") or [])):
            result = copy.deepcopy(full_index)
        else:
            result = _slice_grib_index(full_index, max_messages)
        result["range_request_count"] = 0
        result["cached_range_request_count"] = len(existing_messages)
        result["package_request_count"] = int(full_index.get("package_request_count") or 0)
        result["cached_package_request_count"] = int(full_index.get("cached_package_request_count") or 0)
        result["estimated_range_requests_replaced"] = int(full_index.get("estimated_range_requests_replaced") or len(result.get("messages") or []))
        result["full_package_byte_count"] = int(full_index.get("full_package_byte_count") or 0)
        result["full_package_cache"] = full_index.get("full_package_cache")
        result["cache"] = full_index.get("cache") or _cache_status(False, "full-package", None, METEOFRANCE_GRIB_INDEX_CACHE_TTL_SECONDS)
        return result

    if package_only:
        result = _slice_grib_index(existing_payload, max_messages) if existing_payload is not None else {
            "messages": [],
            "message_count_indexed": 0,
            "next_offset": 0,
            "total_size": None,
            "complete": False,
            "truncated": False,
            "range_request_count": 0,
            "cached_range_request_count": 0,
            "range_bytes_per_request": max(16, metadata_bytes),
            "parameter_summary": _summarize_grib_index_messages([]),
            "statuses": [],
        }
        result["range_request_count"] = 0
        result["cached_range_request_count"] = len((existing_payload or {}).get("messages") or [])
        result["package_request_count"] = 0
        result["cached_package_request_count"] = 0
        result["package_only_miss"] = True
        result["cache_only_miss"] = existing_payload is None
        result["message"] = "Paquet GRIB complet absent ou inutilisable ; fallback Range désactivé pour le préchargement national."
        result["cache"] = _cache_status(False, "none", None, METEOFRANCE_GRIB_INDEX_CACHE_TTL_SECONDS)
        return result

    start_offset = int(existing_payload.get("next_offset") or 0) if existing_payload else 0
    existing_total_size = existing_payload.get("total_size") if existing_payload else None
    remaining_messages = max(0, max_messages - len(existing_messages))
    extension_stop_when = None
    if stop_when is not None:
        extension_stop_when = lambda messages: stop_when(existing_messages + list(messages))
    extension = _index_grib_message_headers(
        api_key,
        product_href,
        max_messages=remaining_messages,
        metadata_bytes=metadata_bytes,
        start_offset=start_offset,
        total_size=existing_total_size,
        stop_when=extension_stop_when,
    )
    combined_messages = existing_messages + list(extension.get("messages") or [])
    combined_statuses = list(existing_payload.get("statuses") or []) if existing_payload else []
    combined_statuses.extend(list(extension.get("statuses") or []))
    next_offset = int(extension.get("next_offset") or start_offset)
    total_size = extension.get("total_size") if extension.get("total_size") is not None else existing_total_size
    combined = {
        "messages": _refresh_grib_index_labels(combined_messages),
        "message_count_indexed": len(combined_messages),
        "next_offset": next_offset,
        "total_size": total_size,
        "complete": bool(total_size is not None and next_offset >= int(total_size)),
        "truncated": False,
        "satisfied_max_messages": max(
            max_messages if bool(total_size is not None and next_offset >= int(total_size)) or len(combined_messages) >= max_messages else 0,
            int(existing_payload.get("satisfied_max_messages") or 0) if existing_payload else 0,
        ),
        "range_request_count": len(combined_statuses),
        "range_bytes_per_request": max(16, metadata_bytes),
        "parameter_summary": _summarize_grib_index_messages(combined_messages),
        "statuses": combined_statuses,
    }
    stored = copy.deepcopy(combined)
    stored.pop("cache", None)
    _set_cached_value(cache_key, stored)
    _write_meteofrance_persistent_cache("grib-index", cache_key, stored, source_url=product_href)

    result = _slice_grib_index(combined, max_messages)
    result["range_request_count"] = int(extension.get("range_request_count") or 0)
    result["cached_range_request_count"] = len(existing_messages)
    result["cache"] = _cache_status(False, "api", None, METEOFRANCE_GRIB_INDEX_CACHE_TTL_SECONDS)
    return result


def _summarize_grib_index_messages(messages: list[dict[str, Any]]) -> dict[str, Any]:
    parameters: dict[str, dict[str, Any]] = {}
    forecast_hours = set()
    product_metadata_count = 0
    for message in messages:
        product = message.get("product")
        if not isinstance(product, dict):
            continue
        key = product.get("parameter_key")
        if not key:
            continue
        product_metadata_count += 1
        entry = parameters.setdefault(
            str(key),
            {
                "key": str(key),
                "label": str(product.get("parameter_label") or key),
                "count": 0,
                "levels": set(),
                "forecast_hours": set(),
            },
        )
        entry["count"] += 1
        if product.get("level"):
            entry["levels"].add(str(product["level"]))
        forecast_hour = product.get("forecast_hour")
        if isinstance(forecast_hour, (int, float)):
            normalized_hour = _normalize_grib_number(forecast_hour)
            entry["forecast_hours"].add(normalized_hour)
            forecast_hours.add(normalized_hour)

    parameter_list = []
    for entry in parameters.values():
        parameter_list.append(
            {
                "key": entry["key"],
                "label": entry["label"],
                "count": entry["count"],
                "levels": sorted(entry["levels"], key=str),
                "forecast_hours": sorted(entry["forecast_hours"]),
            }
        )
    parameter_list.sort(key=lambda item: (str(item["label"]), str(item["key"])))
    return {
        "product_metadata_count": product_metadata_count,
        "parameter_count": len(parameter_list),
        "forecast_hours": sorted(forecast_hours),
        "parameters": parameter_list,
    }


def _probe_meteofrance_grib_package_sync(
    api_key: str,
    requested_grid: str | None = None,
    package_id: str = "SP1",
    requested_time_group: str | None = None,
    range_bytes: int = METEOFRANCE_MODEL_PACKAGE_PROBE_RANGE_BYTES,
) -> dict[str, Any]:
    target = "AROME API Paquet Modèles GRIB Range"
    try:
        resolved = _resolve_meteofrance_package_product(api_key, requested_grid, package_id, requested_time_group)
        product = resolved["product"]
        status, content_type, raw, headers = _fetch_meteofrance_package_bytes(api_key, product["href"], range_bytes=range_bytes)
        grib = _scan_grib_messages(raw)
        content_range = headers.get("content-range", "")
        total_size = _parse_content_range_total(content_range)
        message = (
            f"Probe GRIB OK : {product['time']} contient {grib['message_count_in_sample']} message(s) GRIB détecté(s) dans les premiers {len(raw)} octets."
            if grib["is_grib"]
            else "Probe GRIB reçu, mais aucun en-tête GRIB détecté dans l’extrait."
        )
        return {
            "ok": bool(200 <= status < 300 and grib["is_grib"]),
            "status": status,
            "message": message,
            "target": target,
            "content_type": content_type,
            "byte_count": len(raw),
            "content_range": content_range,
            "total_size": total_size,
            "grid": resolved["grid"],
            "package_id": resolved["package_id"],
            "package_title": resolved["package_title"],
            "reference_time": resolved["reference_time"],
            "time_group": product["time"],
            "available_time_groups": resolved["available_time_groups"],
            "product": product,
            "grib": grib,
            "statuses": resolved["statuses"],
        }
    except Exception as exc:
        return _meteofrance_failure_result(exc, target)


def _format_meteofrance_byte_count(byte_count: int | None) -> str:
    if byte_count is None:
        return "taille inconnue"
    value = max(0, int(byte_count))
    if value >= 1024 * 1024:
        return f"{value / (1024 * 1024):.1f} Mo"
    if value >= 1024:
        return f"{value / 1024:.0f} Ko"
    return f"{value} octets"


def _probe_meteofrance_grib_full_package_sync(
    api_key: str,
    requested_grid: str | None = None,
    package_id: str = "SP1",
    requested_time_group: str | None = "00H06H",
    max_bytes: int = METEOFRANCE_MODEL_PACKAGE_FULL_PROBE_LIMIT_BYTES,
    max_messages: int = 256,
) -> dict[str, Any]:
    target = "AROME API Paquet Modèles GRIB paquet complet"
    package_cooldown = _meteofrance_quota_cooldown_result(
        api_key,
        METEOFRANCE_GRIB_PACKAGE_QUOTA_SCOPE,
        target,
        "probe paquet complet GRIB",
    )
    if package_cooldown:
        return package_cooldown
    try:
        resolved = _resolve_meteofrance_package_product(api_key, requested_grid, package_id, requested_time_group)
        product = resolved["product"]
        full_package = _fetch_grib_full_package_cached(api_key, product["href"], max_bytes=max_bytes)
        if not full_package.get("ok"):
            return {
                "ok": False,
                "status": full_package.get("status"),
                "message": full_package.get("message") or "Paquet complet GRIB indisponible.",
                "target": target,
                "package_request_count": int(full_package.get("package_request_count") or 0),
                "cached_package_request_count": int(full_package.get("cached_package_request_count") or 0),
            }
        status = int(full_package.get("status") or 200)
        content_type = str(full_package.get("content_type") or "application/octet-stream")
        raw = bytes(full_package.get("raw") or b"")
        content_length = full_package.get("content_length")
        full_size = int(content_length or len(raw))
        truncated = False
        index = _index_grib_messages_from_buffer(raw, max_messages=max_messages)
        complete_messages = [message for message in index.get("messages", []) if message.get("complete")]
        parameter_count = int(index.get("parameter_summary", {}).get("parameter_count") or 0)
        size_text = _format_meteofrance_byte_count(full_size)
        if 200 <= status < 300 and complete_messages and not truncated:
            message = (
                f"Probe paquet complet OK : {resolved['package_id']} {product['time']} téléchargé en 1 requête non-Range, "
                f"{size_text}, {len(complete_messages)} message(s) GRIB, {parameter_count} paramètre(s)."
            )
        elif complete_messages:
            message = (
                f"Probe paquet complet partiel : {resolved['package_id']} {product['time']} lu en 1 requête non-Range, "
                f"{_format_meteofrance_byte_count(len(raw))}/{size_text}, {len(complete_messages)} message(s) GRIB détecté(s)."
            )
        else:
            message = "Probe paquet complet reçu, mais aucun message GRIB complet n’a été détecté."
        return {
            "ok": bool(200 <= status < 300 and complete_messages and not truncated),
            "status": status,
            "message": message,
            "target": target,
            "content_type": content_type,
            "byte_count": len(raw),
            "content_length": content_length,
            "full_size": full_size,
            "truncated": truncated,
            "range_request_count": 0,
            "package_request_count": int(full_package.get("package_request_count") or 0),
            "cached_package_request_count": int(full_package.get("cached_package_request_count") or 0),
            "estimated_range_requests_replaced": len(complete_messages),
            "grid": resolved["grid"],
            "package_id": resolved["package_id"],
            "package_title": resolved["package_title"],
            "reference_time": resolved["reference_time"],
            "time_group": product["time"],
            "available_time_groups": resolved["available_time_groups"],
            "product": product,
            "index": {
                "message_count_indexed": index.get("message_count_indexed"),
                "parameter_summary": index.get("parameter_summary"),
                "messages": list(index.get("messages") or [])[:24],
                "truncated": index.get("truncated"),
            },
            "statuses": resolved["statuses"],
        }
    except Exception as exc:
        failure = _meteofrance_failure_result(exc, target)
        if failure.get("status") == 429:
            _set_meteofrance_quota_cooldown(api_key, METEOFRANCE_GRIB_PACKAGE_QUOTA_SCOPE, failure)
            failure["quota_cooldown_scope"] = METEOFRANCE_GRIB_PACKAGE_QUOTA_SCOPE
        return failure


def _probe_meteofrance_grib_index_sync(
    api_key: str,
    requested_grid: str | None = None,
    package_id: str = "SP1",
    requested_time_group: str | None = None,
    max_messages: int = 32,
) -> dict[str, Any]:
    target = "AROME API Paquet Modèles GRIB index"
    try:
        resolved = _resolve_meteofrance_package_product(api_key, requested_grid, package_id, requested_time_group)
        product = resolved["product"]
        index = _index_grib_message_headers_cached(api_key, product["href"], max_messages=max_messages)
        count = int(index["message_count_indexed"])
        total_size = index.get("total_size")
        complete_text = "complet" if index.get("complete") else "partiel"
        summary = index.get("parameter_summary", {})
        parameter_count = int(summary.get("parameter_count") or 0)
        metadata_count = int(summary.get("product_metadata_count") or 0)
        metadata_text = (
            f" Métadonnées produit : {metadata_count}/{count}, {parameter_count} paramètre(s) distinct(s)."
            if metadata_count
            else ""
        )
        message = (
            f"Index GRIB {complete_text} : {count} message(s) indexé(s) pour {product['time']} avec {index['range_request_count']} requêtes Range.{metadata_text}"
            if count
            else f"Index GRIB impossible : aucun en-tête GRIB détecté pour {product['time']}."
        )
        return {
            "ok": count > 0,
            "status": index["statuses"][-1]["status"] if index["statuses"] else None,
            "message": message,
            "target": target,
            "grid": resolved["grid"],
            "package_id": resolved["package_id"],
            "package_title": resolved["package_title"],
            "reference_time": resolved["reference_time"],
            "time_group": product["time"],
            "available_time_groups": resolved["available_time_groups"],
            "product": product,
            "total_size": total_size,
            "index": index,
            "parameter_summary": summary,
            "statuses": resolved["statuses"],
        }
    except Exception as exc:
        return _meteofrance_failure_result(exc, target)


def _normalize_meteofrance_package_ids(package_ids: list[str] | None) -> list[str]:
    cleaned = []
    seen = set()
    for raw_id in package_ids or METEOFRANCE_AROME_SURFACE_PACKAGE_CANDIDATES:
        package_id = str(raw_id or "").strip().upper()
        if not package_id or package_id in seen:
            continue
        seen.add(package_id)
        cleaned.append(package_id)
    return cleaned[:8]


def _package_match_text(*parts: Any) -> str:
    text = " ".join(str(part or "") for part in parts)
    normalized = unicodedata.normalize("NFKD", text)
    return normalized.encode("ascii", "ignore").decode("ascii").casefold()


def _classify_meteofrance_package_candidate(package: dict[str, Any]) -> dict[str, Any]:
    package_id = str(package.get("id") or package.get("package_id") or "").strip().upper()
    title = str(package.get("title") or package.get("package_title") or package_id)
    description = str(package.get("description") or package.get("package_description") or "")
    text = _package_match_text(package_id, title, description)
    score = 0
    reasons = []

    profile_keywords = [
        ("isobare", 4, "niveaux isobares"),
        ("isobaric", 4, "niveaux isobares"),
        ("pression", 3, "niveaux pression"),
        ("pressure", 3, "niveaux pression"),
        ("hauteur", 3, "niveaux hauteur"),
        ("altitude", 3, "niveaux hauteur"),
        ("height", 3, "niveaux hauteur"),
        ("profil", 4, "profil vertical"),
        ("profile", 4, "profil vertical"),
        ("vertical", 3, "vertical"),
        ("niveau", 2, "niveaux"),
        ("level", 2, "niveaux"),
        ("hybride", 3, "niveaux hybrides"),
        ("hybrid", 3, "niveaux hybrides"),
        ("3d", 3, "3D"),
        ("vitesse verticale", 3, "forçage vertical"),
        ("vertical velocity", 3, "forçage vertical"),
        ("theta", 2, "thermodynamique"),
        ("thetav", 2, "thermodynamique"),
        ("thetapw", 2, "thermodynamique"),
    ]
    for needle, weight, reason in profile_keywords:
        if needle in text:
            score += weight
            if reason not in reasons:
                reasons.append(reason)

    if package_id.startswith(("IP", "HP", "VP", "PP")):
        score += 4
        reasons.append("id compatible profil")
    elif package_id.startswith(("SP", "S")):
        reasons.append("paquet surface")

    surface_like = any(needle in text for needle in ("surface", "sol", "2m", "10m", "basses couches"))
    if surface_like and "paquet surface" not in reasons:
        reasons.append("surface/basses couches")

    if score >= 4:
        role = "profile_candidate"
    elif surface_like or package_id.startswith("SP"):
        role = "surface"
    else:
        role = "unknown"

    return {
        "id": package_id,
        "title": title,
        "score": score,
        "role": role,
        "reasons": reasons[:5],
    }


def _summarize_meteofrance_package_candidates(packages: list[dict[str, Any]]) -> dict[str, Any]:
    classified = [_classify_meteofrance_package_candidate(package) for package in packages]
    classified = [item for item in classified if item["id"]]
    profile_candidates = sorted(
        [item for item in classified if item["role"] == "profile_candidate"],
        key=lambda item: (-int(item["score"]), item["id"]),
    )
    surface_candidates = sorted(
        [item for item in classified if item["role"] == "surface"],
        key=lambda item: item["id"],
    )
    unknown_candidates = sorted(
        [item for item in classified if item["role"] == "unknown"],
        key=lambda item: item["id"],
    )
    recommended = [item["id"] for item in profile_candidates]
    if not recommended:
        recommended = [item["id"] for item in unknown_candidates if not item["id"].startswith("SP")]
    return {
        "package_count": len(classified),
        "profile_candidates": profile_candidates[:8],
        "surface_candidates": surface_candidates[:6],
        "unknown_candidates": unknown_candidates[:8],
        "recommended_profile_package_ids": recommended[:8],
    }


def _choose_meteofrance_packages_to_inspect(packages: list[dict[str, Any]], inspect_all: bool, max_packages: int) -> list[str]:
    package_ids = {str(item.get("id") or "").upper() for item in packages}
    if not inspect_all:
        selected = [package_id for package_id in METEOFRANCE_AROME_SURFACE_PACKAGE_CANDIDATES if package_id in package_ids]
        return selected or [str(item["id"]).upper() for item in packages[:max_packages]]

    summary = _summarize_meteofrance_package_candidates(packages)
    ordered = []
    ordered.extend(summary.get("recommended_profile_package_ids", []))
    ordered.extend(package_id for package_id in METEOFRANCE_AROME_SURFACE_PACKAGE_CANDIDATES if package_id in package_ids)
    ordered.extend(str(item.get("id") or "").upper() for item in packages)
    selected = []
    seen = set()
    for package_id in ordered:
        package_id = str(package_id or "").upper()
        if not package_id or package_id not in package_ids or package_id in seen:
            continue
        seen.add(package_id)
        selected.append(package_id)
        if len(selected) >= max(1, int(max_packages)):
            break
    return selected


def _combine_grib_profile_parameters(package_profiles: list[dict[str, Any]]) -> dict[str, Any]:
    combined: dict[str, dict[str, Any]] = {}
    forecast_hours = set()
    for profile in package_profiles:
        package_id = str(profile.get("package_id") or "")
        summary = profile.get("parameter_summary") or {}
        for item in summary.get("parameters", []):
            key = str(item.get("key") or "")
            if not key:
                continue
            entry = combined.setdefault(
                key,
                {
                    "key": key,
                    "label": str(item.get("label") or key),
                    "count": 0,
                    "packages": set(),
                    "levels": set(),
                    "forecast_hours": set(),
                },
            )
            entry["count"] += int(item.get("count") or 0)
            if package_id:
                entry["packages"].add(package_id)
            for level in item.get("levels", []):
                entry["levels"].add(str(level))
            for hour in item.get("forecast_hours", []):
                if isinstance(hour, (int, float)):
                    normalized_hour = _normalize_grib_number(hour)
                    entry["forecast_hours"].add(normalized_hour)
                    forecast_hours.add(normalized_hour)

    parameters = []
    for entry in combined.values():
        parameters.append(
            {
                "key": entry["key"],
                "label": entry["label"],
                "count": entry["count"],
                "packages": sorted(entry["packages"]),
                "levels": sorted(entry["levels"], key=str),
                "forecast_hours": sorted(entry["forecast_hours"]),
            }
        )
    parameters.sort(key=lambda item: (str(item["label"]), str(item["key"])))
    return {
        "parameter_count": len(parameters),
        "forecast_hours": sorted(forecast_hours),
        "parameters": parameters,
    }


def _meteofrance_grib_objectifoudre_plan(grid: str | None = None) -> dict[str, Any]:
    normalized_grid = grid or "0.025"
    fields = copy.deepcopy(METEOFRANCE_AROME025_OBJECTIFOUDRE_GRIB_PLAN)
    available_fields = [item for item in fields if item.get("status") == "available"]
    missing_fields = [item for item in fields if item.get("status") != "available"]
    packages = sorted({str(item["package_id"]) for item in available_fields if item.get("package_id")})
    by_package: dict[str, list[dict[str, Any]]] = {}
    for item in available_fields:
        by_package.setdefault(str(item["package_id"]), []).append(item)
    return {
        "grid": normalized_grid,
        "source": "arome025_package_table",
        "packages": packages,
        "fields": fields,
        "by_package": by_package,
        "available_count": len(available_fields),
        "missing_count": len(missing_fields),
        "missing_fields": missing_fields,
        "summary": "SP1 couvre vent/rafales/humidité/température 2 m ; SP2 couvre point de rosée, CAPE et nébulosité basse/moyenne/haute ; CIN absent du catalogue inspecté.",
    }


def _detect_grib_decoder_status() -> dict[str, Any]:
    python_modules = []
    for module_name in ("eccodes", "cfgrib", "pygrib"):
        python_modules.append(
            {
                "name": module_name,
                "available": importlib.util.find_spec(module_name) is not None,
            }
        )

    commands = []
    for command_name in ("wgrib2", "grib_ls", "grib_dump"):
        path = shutil.which(command_name)
        commands.append(
            {
                "name": command_name,
                "available": path is not None,
                "path": path,
            }
        )

    available_modules = [item["name"] for item in python_modules if item["available"]]
    available_commands = [item["name"] for item in commands if item["available"]]
    can_decode = bool(available_modules or available_commands)
    preferred = None
    if "eccodes" in available_modules:
        preferred = "eccodes"
    elif "pygrib" in available_modules:
        preferred = "pygrib"
    elif "cfgrib" in available_modules:
        preferred = "cfgrib"
    elif "wgrib2" in available_commands:
        preferred = "wgrib2"
    elif "grib_ls" in available_commands:
        preferred = "ecCodes CLI"

    return {
        "ok": True,
        "can_decode_grib": can_decode,
        "preferred_decoder": preferred,
        "definition_path": os.environ.get("ECCODES_DEFINITION_PATH"),
        "local_definition_path": str(LOCAL_ECCODES_DEFINITION_PATH) if LOCAL_ECCODES_DEFINITION_PATH.is_dir() else None,
        "python_modules": python_modules,
        "commands": commands,
        "message": (
            f"Décodeur GRIB disponible : {preferred}."
            if can_decode
            else "Aucun décodeur GRIB détecté côté serveur. On peut indexer les paquets, mais pas encore extraire les valeurs de grille."
        ),
        "next_step": (
            "Le décodage GRIB local est prêt pour alimenter les grilles horaires en cache serveur."
            if can_decode
            else "Installer un décodeur GRIB serveur, idéalement ecCodes/eccodes ou wgrib2, avant de remplacer les GetCoverage par le cache GRIB."
        ),
    }


def _safe_eccodes_get(handle: Any, key: str) -> Any:
    try:
        import eccodes  # type: ignore

        return eccodes.codes_get(handle, key)
    except Exception:
        return None


def _safe_eccodes_get_values(handle: Any, metadata: dict[str, Any], limit: int = 8) -> dict[str, Any]:
    try:
        import eccodes  # type: ignore

        values = eccodes.codes_get_values(handle)
    except Exception as exc:
        return {"readable": False, "error": str(exc), "sample": []}

    missing_value = metadata.get("missingValue")
    try:
        missing_value = float(missing_value) if missing_value is not None else None
    except Exception:
        missing_value = None
    short_name = str(metadata.get("shortName") or "").lower()
    sample = []
    valid_sample = []
    valid_sample_c = []
    finite_count = 0
    valid_count = 0
    min_value = None
    max_value = None
    valid_min = None
    valid_max = None
    for raw in values:
        try:
            value = float(raw)
        except Exception:
            continue
        if math.isfinite(value):
            finite_count += 1
            min_value = value if min_value is None else min(min_value, value)
            max_value = value if max_value is None else max(max_value, value)
            if len(sample) < limit:
                sample.append(round(value, 3))
            is_missing = missing_value is not None and math.isclose(value, missing_value, rel_tol=0.0, abs_tol=1e-6)
            if not is_missing:
                valid_count += 1
                valid_min = value if valid_min is None else min(valid_min, value)
                valid_max = value if valid_max is None else max(valid_max, value)
                if len(valid_sample) < limit:
                    valid_sample.append(round(value, 3))
                    if _is_grib_temperature_short_name(short_name) and value > 170:
                        valid_sample_c.append(round(value - 273.15, 2))
    converted = {}
    if _is_grib_temperature_short_name(short_name) and valid_min is not None and valid_max is not None:
        converted = {
            "unit": "°C",
            "min": round(valid_min - 273.15, 2),
            "max": round(valid_max - 273.15, 2),
            "sample": valid_sample_c,
        }
    return {
        "readable": True,
        "count": int(len(values)),
        "finite_count": finite_count,
        "min": round(min_value, 3) if min_value is not None else None,
        "max": round(max_value, 3) if max_value is not None else None,
        "sample": sample,
        "missing_value": missing_value,
        "valid_count": valid_count,
        "valid_min": round(valid_min, 3) if valid_min is not None else None,
        "valid_max": round(valid_max, 3) if valid_max is not None else None,
        "valid_sample": valid_sample,
        "converted": converted,
    }


def _is_grib_temperature_short_name(short_name: str) -> bool:
    normalized = str(short_name or "").lower()
    return normalized in {"t", "2t"} or normalized.endswith("_2t") or normalized.endswith("_t")


def _decode_grib_message_with_eccodes(raw: bytes) -> dict[str, Any]:
    try:
        import eccodes  # type: ignore
    except Exception as exc:
        return {"ok": False, "message": f"Module eccodes indisponible : {exc}"}

    handle = None
    try:
        handle = eccodes.codes_new_from_message(raw)
        metadata_keys = [
            "shortName",
            "name",
            "parameterCategory",
            "parameterNumber",
            "typeOfLevel",
            "level",
            "stepRange",
            "step",
            "Ni",
            "Nj",
            "numberOfPoints",
            "gridType",
            "latitudeOfFirstGridPointInDegrees",
            "longitudeOfFirstGridPointInDegrees",
            "latitudeOfLastGridPointInDegrees",
            "longitudeOfLastGridPointInDegrees",
            "missingValue",
        ]
        metadata = {key: _safe_eccodes_get(handle, key) for key in metadata_keys}
        values = _safe_eccodes_get_values(handle, metadata)
        return {
            "ok": True,
            "message": "Message GRIB décodé avec eccodes.",
            "metadata": metadata,
            "values": values,
        }
    except Exception as exc:
        return {"ok": False, "message": f"Décodage eccodes impossible : {exc}"}
    finally:
        if handle is not None:
            try:
                eccodes.codes_release(handle)
            except Exception:
                pass


def _convert_grib_nearest_value(value: float | None, metadata: dict[str, Any]) -> float | None:
    if value is None or not math.isfinite(value):
        return None
    missing_value = metadata.get("missingValue")
    try:
        if missing_value is not None and math.isclose(float(value), float(missing_value), rel_tol=0.0, abs_tol=1e-6):
            return None
    except Exception:
        pass
    short_name = str(metadata.get("shortName") or "").lower()
    if _is_grib_temperature_short_name(short_name) and value > 170:
        return round(value - 273.15, 2)
    return round(value, 3)


def _normalize_eccodes_nearest_point(nearest_point: Any) -> dict[str, Any] | None:
    if isinstance(nearest_point, dict):
        try:
            return {
                "lat": float(nearest_point["lat"]),
                "lon": float(nearest_point["lon"]),
                "value": float(nearest_point["value"]),
                "distance": float(nearest_point.get("distance", 0.0)),
                "index": int(nearest_point.get("index", 0)),
            }
        except Exception:
            return None
    try:
        outlat, outlon, raw_value, distance, grid_index = nearest_point[:5]
        return {
            "lat": float(outlat),
            "lon": float(outlon),
            "value": float(raw_value),
            "distance": float(distance),
            "index": int(grid_index),
        }
    except Exception:
        return None


def _convert_meteofrance_grib_field_value(field: str, value: float | None, metadata: dict[str, Any]) -> float | None:
    if value is None or not math.isfinite(value):
        return None
    missing_value = metadata.get("missingValue")
    try:
        if missing_value is not None and math.isclose(float(value), float(missing_value), rel_tol=0.0, abs_tol=1e-6):
            return None
    except Exception:
        pass

    converted = float(value)
    if field in {"temperature_2m", "dew_point_2m"} and converted > 170:
        converted -= 273.15
    if field in {"cloud_cover_low", "cloud_cover_mid", "cloud_cover_high"} and 0 <= converted <= 1.5:
        converted *= 100.0
    if field.startswith("wind_direction_"):
        converted %= 360.0
    if field in {"cape", "precipitable_water", "shortwave_radiation"}:
        converted = max(0.0, converted)
    if field == "precipitation_rate":
        units = str(metadata.get("units") or "").lower()
        converted = max(0.0, converted)
        if "s" in units and ("kg" in units or "m" in units):
            converted *= 3600.0
    return round(converted, 3)


def _grib_nearest_samples(handle: Any, in_lats: list[float], in_lons: list[float]) -> list[dict[str, Any] | None]:
    """Plus proche voisin pour une liste de points, renvoyé aligné sur l'entrée.

    Sur grille régulière (regular_ll — cas AROME/ARPEGE/WCS), l'indice se calcule par
    simple arithmétique vectorisée numpy (arrondi lat/lon → indice), O(1) par point, au
    lieu de la recherche eccodes O(taille de grille) par point qui dominait la
    matérialisation (~5500 points × ~14 champs × 24 h). Équivalence exacte vérifiée vs
    codes_grib_find_nearest (0 écart d'index/valeur). Repli eccodes multi-points pour
    toute grille non régulière ou en cas d'imprévu.
    """
    import eccodes  # type: ignore

    n = len(in_lats)
    if not n:
        return []
    try:
        if str(_safe_eccodes_get(handle, "gridType") or "") == "regular_ll":
            import numpy as np

            ni = int(eccodes.codes_get(handle, "Ni"))
            nj = int(eccodes.codes_get(handle, "Nj"))
            j_consecutive = int(eccodes.codes_get(handle, "jPointsAreConsecutive"))
            dlat = np.asarray(eccodes.codes_get_array(handle, "distinctLatitudes"), dtype=float)
            dlon = np.asarray(eccodes.codes_get_array(handle, "distinctLongitudes"), dtype=float)
            if dlat.size == nj and dlon.size == ni and dlat.size >= 2 and dlon.size >= 2:
                lat0 = dlat[0]
                lon0 = dlon[0]
                lat_step = dlat[1] - dlat[0]
                lon_step = dlon[1] - dlon[0]
                qlat = np.asarray(in_lats, dtype=float)
                qlon = np.asarray(in_lons, dtype=float)
                jj = np.clip(np.rint((qlat - lat0) / lat_step).astype(int), 0, nj - 1)
                ii = np.clip(np.rint((qlon - lon0) / lon_step).astype(int), 0, ni - 1)
                flat = (ii * nj + jj) if j_consecutive else (jj * ni + ii)
                values = np.asarray(eccodes.codes_get_values(handle), dtype=float)
                grid_lats = dlat[jj]
                grid_lons = dlon[ii]
                # Distance grand-cercle (km) — diagnostique, calculée vectoriellement.
                phi1 = np.radians(qlat)
                phi2 = np.radians(grid_lats)
                dphi = np.radians(grid_lats - qlat)
                dlmb = np.radians(grid_lons - qlon)
                hav = np.sin(dphi / 2.0) ** 2 + np.cos(phi1) * np.cos(phi2) * np.sin(dlmb / 2.0) ** 2
                dist_km = 2.0 * 6371.0 * np.arcsin(np.minimum(1.0, np.sqrt(hav)))
                return [
                    {
                        "lat": float(grid_lats[k]),
                        "lon": float(grid_lons[k]),
                        "value": float(values[flat[k]]),
                        "distance": float(dist_km[k]),
                        "index": int(flat[k]),
                    }
                    for k in range(n)
                ]
    except Exception:
        pass

    # Repli : recherche eccodes multi-points (grille non régulière, ou clé manquante).
    nearest = eccodes.codes_grib_find_nearest_multiple(handle, False, list(in_lats), list(in_lons))
    return [_normalize_eccodes_nearest_point(item) for item in nearest]


def _sample_grib_field_nearest_with_eccodes(raw: bytes, field: str, points: list[Any]) -> dict[str, Any]:
    try:
        import eccodes  # type: ignore
    except Exception as exc:
        return {"ok": False, "message": f"Module eccodes indisponible : {exc}", "samples": []}

    handle = None
    try:
        handle = eccodes.codes_new_from_message(raw)
        metadata = {
            "shortName": _safe_eccodes_get(handle, "shortName"),
            "name": _safe_eccodes_get(handle, "name"),
            "units": _safe_eccodes_get(handle, "units"),
            "missingValue": _safe_eccodes_get(handle, "missingValue"),
        }
        # Échantillonnage du plus proche voisin vectorisé (cf. _grib_nearest_samples) :
        # calcul d'indice O(1)/point sur grille régulière au lieu d'une recherche eccodes
        # O(grille)/point — c'était le goulot dominant de la matérialisation.
        point_list = list(points)
        samples = []
        valid_samples = []
        if point_list:
            in_lats = [float(point.lat) for point in point_list]
            in_lons = [float(point.lon) for point in point_list]
            nearest_points = _grib_nearest_samples(handle, in_lats, in_lons)
            for point, normalized in zip(point_list, nearest_points):
                if normalized is None:
                    continue
                converted = _convert_meteofrance_grib_field_value(field, normalized["value"], metadata)
                sample = {
                    "zone": getattr(point, "zone", ""),
                    "lat": float(point.lat),
                    "lon": float(point.lon),
                    "grid_lat": round(normalized["lat"], 5),
                    "grid_lon": round(normalized["lon"], 5),
                    "raw_value": round(normalized["value"], 3),
                    "value": converted,
                    "distance_km": round(normalized["distance"], 3),
                    "grid_index": normalized["index"],
                }
                samples.append(sample)
                if converted is not None:
                    valid_samples.append(sample)
        return {
            "ok": True,
            "message": f"{len(valid_samples)}/{len(samples)} point(s) GRIB valides échantillonnés pour {field}.",
            "metadata": metadata,
            "samples": samples,
            "valid_count": len(valid_samples),
            "count": len(samples),
        }
    except Exception as exc:
        return {"ok": False, "message": f"Échantillonnage GRIB {field} impossible : {exc}", "samples": []}
    finally:
        if handle is not None:
            try:
                eccodes.codes_release(handle)
            except Exception:
                pass


def _decode_meteofrance_grib_national_field(raw: bytes, field: str) -> dict[str, Any]:
    try:
        import eccodes  # type: ignore
    except Exception as exc:
        return {"ok": False, "message": f"Module eccodes indisponible : {exc}"}

    handle = None
    try:
        handle = eccodes.codes_new_from_message(raw)
        metadata_keys = [
            "shortName",
            "name",
            "units",
            "parameterCategory",
            "parameterNumber",
            "typeOfLevel",
            "level",
            "stepRange",
            "step",
            "Ni",
            "Nj",
            "numberOfPoints",
            "gridType",
            "latitudeOfFirstGridPointInDegrees",
            "longitudeOfFirstGridPointInDegrees",
            "latitudeOfLastGridPointInDegrees",
            "longitudeOfLastGridPointInDegrees",
            "iDirectionIncrementInDegrees",
            "jDirectionIncrementInDegrees",
            "missingValue",
        ]
        metadata = {key: _safe_eccodes_get(handle, key) for key in metadata_keys}
        # Décodage vectorisé numpy : les conversions de _convert_meteofrance_grib_field_value
        # sont toutes élémentaires (K→°C, ×100 nuages, %360 vent, max(0), ×3600 pluie,
        # arrondi). Sur ~1,5 M points × ~14 champs × 24 h, la boucle Python par valeur était
        # le goulot dominant du préchargement (≈40 min). Équivalence numérique vérifiée
        # (NaN/missing/arrondi/float32 identiques à la version scalaire conservée pour
        # l'échantillonnage ponctuel).
        import numpy as np

        arr = np.asarray(eccodes.codes_get_values(handle), dtype=np.float64)
        valid = np.isfinite(arr)
        missing_value = metadata.get("missingValue")
        if missing_value is not None:
            try:
                valid &= ~np.isclose(arr, float(missing_value), rtol=0.0, atol=1e-6)
            except Exception:
                pass
        out = arr.copy()
        with np.errstate(invalid="ignore", divide="ignore"):
            if field in {"temperature_2m", "dew_point_2m"}:
                mask = out > 170
                out[mask] = out[mask] - 273.15
            if field in {"cloud_cover_low", "cloud_cover_mid", "cloud_cover_high"}:
                mask = (out >= 0) & (out <= 1.5)
                out[mask] = out[mask] * 100.0
            if field.startswith("wind_direction_"):
                out = np.mod(out, 360.0)
            if field in {"cape", "precipitable_water", "shortwave_radiation"}:
                out = np.maximum(0.0, out)
            if field == "precipitation_rate":
                units = str(metadata.get("units") or "").lower()
                out = np.maximum(0.0, out)
                if "s" in units and ("kg" in units or "m" in units):
                    out = out * 3600.0
        out = np.round(out, 3)
        out[~valid] = np.nan
        values = out.astype(np.float32)
        valid_count = int(np.count_nonzero(valid))
        if valid_count:
            valid_values = out[valid]
            valid_min = float(np.min(valid_values))
            valid_max = float(np.max(valid_values))
            sample = [round(float(v), 3) for v in valid_values[:8]]
        else:
            valid_min = None
            valid_max = None
            sample = []
        raw_bytes = values.tobytes()
        compressed_values = zlib.compress(raw_bytes, level=1)
        value_count = int(values.size)
        payload = {
            "ok": True,
            "message": f"Champ national {field} décodé et compressé.",
            "field": field,
            "codec": METEOFRANCE_GRIB_NATIONAL_FIELD_ALGORITHM_VERSION,
            "metadata": metadata,
            "value_count": value_count,
            "valid_count": valid_count,
            "valid_min": round(valid_min, 3) if valid_min is not None else None,
            "valid_max": round(valid_max, 3) if valid_max is not None else None,
            "sample": sample,
            "value_type": "float32",
            "value_itemsize": values.itemsize,
            "byteorder": "little" if struct.pack("=I", 1)[0] == 1 else "big",
            "uncompressed_byte_count": len(raw_bytes),
            "compressed_byte_count": len(compressed_values),
            "compression_ratio": round(len(compressed_values) / max(1, len(raw_bytes)), 4),
        }
        return {"ok": True, "payload": payload, "compressed_values": compressed_values}
    except Exception as exc:
        return {"ok": False, "message": f"Décodage national GRIB {field} impossible : {exc}"}
    finally:
        if handle is not None:
            try:
                eccodes.codes_release(handle)
            except Exception:
                pass


def _sample_grib_message_nearest_with_eccodes(raw: bytes, points: list[Any], max_points: int = 9) -> dict[str, Any]:
    try:
        import eccodes  # type: ignore
    except Exception as exc:
        return {"ok": False, "message": f"Module eccodes indisponible : {exc}", "samples": []}

    handle = None
    try:
        handle = eccodes.codes_new_from_message(raw)
        metadata = {
            "shortName": _safe_eccodes_get(handle, "shortName"),
            "missingValue": _safe_eccodes_get(handle, "missingValue"),
        }
        samples = []
        valid_samples = []
        for point in points[:max_points]:
            try:
                nearest_points = eccodes.codes_grib_find_nearest(handle, float(point.lat), float(point.lon), False, 1)
            except TypeError:
                nearest = eccodes.codes_grib_nearest_new(handle)
                try:
                    nearest_points = eccodes.codes_grib_nearest_find(nearest, handle, float(point.lat), float(point.lon), 0, False, 4)
                finally:
                    try:
                        eccodes.codes_grib_nearest_delete(nearest)
                    except Exception:
                        pass
            if not nearest_points:
                continue
            normalized = _normalize_eccodes_nearest_point(nearest_points[0])
            if normalized is None:
                continue
            converted = _convert_grib_nearest_value(normalized["value"], metadata)
            sample = {
                "zone": getattr(point, "zone", ""),
                "lat": float(point.lat),
                "lon": float(point.lon),
                "grid_lat": round(normalized["lat"], 5),
                "grid_lon": round(normalized["lon"], 5),
                "raw_value": round(normalized["value"], 3),
                "value": converted,
                "distance_km": round(normalized["distance"], 3),
                "grid_index": normalized["index"],
            }
            samples.append(sample)
            if converted is not None:
                valid_samples.append(sample)
        return {
            "ok": True,
            "message": f"{len(valid_samples)}/{len(samples)} point(s) GRIB valides échantillonnés.",
            "samples": samples,
            "valid_count": len(valid_samples),
            "count": len(samples),
        }
    except Exception as exc:
        return {"ok": False, "message": f"Échantillonnage nearest eccodes impossible : {exc}", "samples": []}
    finally:
        if handle is not None:
            try:
                eccodes.codes_release(handle)
            except Exception:
                pass


def _meteofrance_grib_message_cache_key(product_href: str, selected_message: dict[str, Any]) -> str:
    offset = int(selected_message.get("offset") or 0)
    length = int(selected_message.get("length") or 0)
    source = f"{product_href}|offset={offset}|length={length}"
    return f"meteofrance:grib-message:{_stable_cache_hash(source)}"


def _grib_message_payload_from_raw(status: int, content_type: str, raw: bytes, headers: dict[str, str]) -> dict[str, Any]:
    return {
        "status": status,
        "content_type": content_type,
        "headers": headers,
        "byte_count": len(raw),
        "raw_b64": base64.b64encode(raw).decode("ascii"),
    }


def _raw_from_grib_message_payload(payload: dict[str, Any]) -> bytes | None:
    try:
        raw_b64 = str(payload.get("raw_b64") or "")
        return base64.b64decode(raw_b64.encode("ascii"), validate=True)
    except Exception:
        return None


def _fetch_grib_message_cached(api_key: str, product_href: str, selected_message: dict[str, Any], decode_values: bool = True, cache_only: bool = False, package_only: bool = False) -> dict[str, Any]:
    cache_key = _meteofrance_grib_message_cache_key(product_href, selected_message)
    cached = _get_cached_value(cache_key, ttl=METEOFRANCE_GRIB_MESSAGE_CACHE_TTL_SECONDS)
    payload = None
    cache_backend = None
    cache_created_at = None
    if cached is not None:
        payload = copy.deepcopy(cached["payload"])
        cache_backend = "memory"
        cache_created_at = float(cached["ts"])
    else:
        persistent = _read_meteofrance_persistent_cache(
            "grib-message",
            cache_key,
            METEOFRANCE_GRIB_MESSAGE_CACHE_TTL_SECONDS,
            source_url=product_href,
        )
        if persistent is not None:
            payload = copy.deepcopy(persistent["payload"])
            cache_backend = "disk"
            cache_created_at = float(persistent["ts"])
            _set_cached_value(cache_key, payload)

    if payload is not None:
        raw = _raw_from_grib_message_payload(payload)
        if raw is not None:
            return {
                "raw": raw,
                "status": int(payload.get("status") or 200),
                "content_type": str(payload.get("content_type") or ""),
                "headers": dict(payload.get("headers") or {}),
                "byte_count": int(payload.get("byte_count") or len(raw)),
                "decode": _decode_grib_message_with_eccodes(raw) if decode_values else {"ok": True, "message": "Message GRIB disponible depuis le cache."},
                "range_request_count": 0,
                "cached_range_request_count": 1,
                "package_request_count": 0,
                "cached_package_request_count": 0,
                "cache": _cache_status(True, str(cache_backend or "memory"), cache_created_at, METEOFRANCE_GRIB_MESSAGE_CACHE_TTL_SECONDS),
            }

    message_offset = int(selected_message["offset"])
    message_length = int(selected_message["length"])
    full_package = _fetch_grib_full_package_cached(api_key, product_href, cache_only=cache_only)
    if full_package.get("ok"):
        package_raw = full_package.get("raw")
        if isinstance(package_raw, (bytes, bytearray)):
            raw = bytes(package_raw[message_offset:message_offset + message_length])
            if len(raw) == message_length and raw.startswith(b"GRIB"):
                status = int(full_package.get("status") or 200)
                content_type = str(full_package.get("content_type") or "application/octet-stream")
                headers = dict(full_package.get("headers") or {})
                payload = _grib_message_payload_from_raw(status, content_type, raw, headers)
                if 200 <= status < 300 and raw:
                    _set_cached_value(cache_key, payload)
                    _write_meteofrance_persistent_cache("grib-message", cache_key, payload, source_url=product_href)
                return {
                    "raw": raw,
                    "status": status,
                    "content_type": content_type,
                    "headers": headers,
                    "byte_count": len(raw),
                    "decode": _decode_grib_message_with_eccodes(raw) if decode_values else {"ok": True, "message": "Message GRIB extrait du paquet complet."},
                    "range_request_count": 0,
                    "cached_range_request_count": 0,
                    "package_request_count": int(full_package.get("package_request_count") or 0),
                    "cached_package_request_count": int(full_package.get("cached_package_request_count") or 0),
                    "full_package_cache": full_package.get("cache"),
                    "cache": _cache_status(False, "full-package", None, METEOFRANCE_GRIB_MESSAGE_CACHE_TTL_SECONDS),
                }

    if package_only:
        return {
            "raw": b"",
            "status": None,
            "content_type": "",
            "headers": {},
            "byte_count": 0,
            "decode": {"ok": False, "message": "Message GRIB absent du paquet complet ; fallback Range désactivé."},
            "range_request_count": 0,
            "cached_range_request_count": 0,
            "package_request_count": 0,
            "cached_package_request_count": int(full_package.get("cached_package_request_count") or 0),
            "cache": _cache_status(False, "none", None, METEOFRANCE_GRIB_MESSAGE_CACHE_TTL_SECONDS),
            "cache_only_miss": True,
            "package_only_miss": True,
        }

    if cache_only:
        return {
            "raw": b"",
            "status": None,
            "content_type": "",
            "headers": {},
            "byte_count": 0,
            "decode": {"ok": False, "message": "Message GRIB absent du cache."},
            "range_request_count": 0,
            "cached_range_request_count": 0,
            "package_request_count": 0,
            "cached_package_request_count": int(full_package.get("cached_package_request_count") or 0),
            "cache": _cache_status(False, "none", None, METEOFRANCE_GRIB_MESSAGE_CACHE_TTL_SECONDS),
            "cache_only_miss": True,
        }

    status, content_type, raw, headers = _fetch_meteofrance_package_bytes(
        api_key,
        product_href,
        range_bytes=message_length,
        range_start=message_offset,
    )
    payload = _grib_message_payload_from_raw(status, content_type, raw, headers)
    if 200 <= status < 300 and raw:
        _set_cached_value(cache_key, payload)
        _write_meteofrance_persistent_cache("grib-message", cache_key, payload, source_url=product_href)
    return {
        "raw": raw,
        "status": status,
        "content_type": content_type,
        "headers": headers,
        "byte_count": len(raw),
        "decode": _decode_grib_message_with_eccodes(raw) if decode_values else {"ok": True, "message": "Message GRIB téléchargé."},
        "range_request_count": 1,
        "cached_range_request_count": 1,
        "package_request_count": 0,
        "cached_package_request_count": 0,
        "cache": _cache_status(False, "api", None, METEOFRANCE_GRIB_MESSAGE_CACHE_TTL_SECONDS),
    }


def _message_matches_grib_target(message: dict[str, Any], parameter_label: str, forecast_hour: int | None, level_contains: str | None = None) -> bool:
    product = message.get("product")
    if not isinstance(product, dict):
        return False
    label = str(product.get("parameter_label") or "").lower()
    key = str(product.get("parameter_key") or "").lower()
    needle = parameter_label.strip().lower()
    if needle and needle not in label and needle not in key:
        return False
    level_needle = (level_contains or "").strip().lower()
    if level_needle:
        level = str(product.get("level") or "").lower()
        if level_needle not in level:
            return False
    if forecast_hour is None:
        return True
    product_hour = product.get("forecast_hour")
    return isinstance(product_hour, (int, float)) and int(round(float(product_hour))) == int(forecast_hour)


def _select_grib_zero_hour_sequence_message(
    index: dict[str, Any],
    parameter_label: str,
    forecast_hour: int | None,
    level_contains: str | None = None,
) -> dict[str, Any] | None:
    if forecast_hour is None:
        return None
    label = parameter_label.strip().lower()
    sequenced_labels = {
        "taux de précipitations total",
        "flux net rayonnement court",
    }
    if label not in sequenced_labels:
        return None
    messages = list(index.get("messages") or [])
    candidates = []
    for message in messages:
        product = message.get("product") if isinstance(message, dict) else None
        if not isinstance(product, dict):
            continue
        if not _message_matches_grib_target(message, parameter_label, None, level_contains):
            continue
        product_hour = product.get("forecast_hour")
        try:
            product_hour_int = int(round(float(product_hour)))
        except Exception:
            continue
        if product_hour_int == 0:
            candidates.append(message)
    if not candidates:
        return None

    forecast_hour_counts: dict[int, int] = {}
    for message in messages:
        product = message.get("product") if isinstance(message, dict) else None
        if not isinstance(product, dict):
            continue
        value = product.get("forecast_hour")
        try:
            hour = int(round(float(value)))
        except Exception:
            continue
        if hour > 0:
            forecast_hour_counts[hour] = forecast_hour_counts.get(hour, 0) + 1
    if forecast_hour_counts:
        max_count = max(forecast_hour_counts.values())
        sequence_start = min(hour for hour, count in forecast_hour_counts.items() if count == max_count)
        if int(forecast_hour) == 0 and sequence_start > 0:
            sequence_start = 0
    else:
        sequence_start = 0
    sequence_index = int(forecast_hour) - int(sequence_start)
    if sequence_index < 0 or sequence_index >= len(candidates):
        return None
    annotated = copy.deepcopy(candidates[sequence_index])
    annotated["_sequenced_forecast_hour"] = int(forecast_hour)
    annotated["_sequence_start_forecast_hour"] = int(sequence_start)
    annotated["_sequence_index"] = int(sequence_index)
    return annotated


def _select_grib_nearest_forecast_message(
    index: dict[str, Any],
    parameter_label: str,
    forecast_hour: int | None,
    level_contains: str | None,
    max_distance_hours: int,
) -> dict[str, Any] | None:
    """Message du paramètre dont l'échéance est la PLUS PROCHE de celle demandée
    (dans une tolérance). Sert à combler les pas 3-horaires d'ARPEGE au-delà de +48 h :
    une heure locale sans message exact est calée sur l'échéance voisine."""
    if forecast_hour is None:
        return None
    best = None
    best_dist = None
    for message in index.get("messages", []):
        if not _message_matches_grib_target(message, parameter_label, None, level_contains):
            continue
        product = message.get("product") if isinstance(message, dict) else None
        product_hour = product.get("forecast_hour") if isinstance(product, dict) else None
        if not isinstance(product_hour, (int, float)):
            continue
        dist = abs(int(round(float(product_hour))) - int(forecast_hour))
        if dist > max_distance_hours:
            continue
        if best_dist is None or dist < best_dist:
            best, best_dist = message, dist
    if best is None:
        return None
    annotated = copy.deepcopy(best)
    annotated["_snapped_from_forecast_hour"] = int(forecast_hour)
    return annotated


def _select_grib_target_message(
    index: dict[str, Any],
    parameter_label: str,
    forecast_hour: int | None,
    level_contains: str | None = None,
    *,
    allow_forecast_fallback: bool = True,
    nearest_tolerance_hours: int = 0,
) -> dict[str, Any] | None:
    selected_message = next(
        (message for message in index.get("messages", []) if _message_matches_grib_target(message, parameter_label, forecast_hour, level_contains)),
        None,
    )
    if selected_message is None:
        selected_message = _select_grib_zero_hour_sequence_message(index, parameter_label, forecast_hour, level_contains)
    # Calage sur l'échéance la plus proche (ARPEGE 3-horaire au-delà de +48 h).
    if selected_message is None and nearest_tolerance_hours > 0:
        selected_message = _select_grib_nearest_forecast_message(
            index, parameter_label, forecast_hour, level_contains, nearest_tolerance_hours,
        )
    if selected_message is None and forecast_hour is not None and allow_forecast_fallback:
        selected_message = next(
            (message for message in index.get("messages", []) if _message_matches_grib_target(message, parameter_label, None, level_contains)),
            None,
        )
    return selected_message


def _grib_slot_index_stop_when(
    specs: list[dict[str, Any]],
    forecast_hour: int | None,
) -> Callable[[list[dict[str, Any]]], bool] | None:
    targets = [
        (
            str(spec.get("parameter_label") or ""),
            forecast_hour,
            spec.get("level_contains"),
        )
        for spec in specs
        if spec.get("parameter_label")
    ]
    if not targets:
        return None

    def stop_when(messages: list[dict[str, Any]]) -> bool:
        return all(
            any(_message_matches_grib_target(message, label, hour, level) for message in messages)
            for label, hour, level in targets
        )

    return stop_when


def _probe_meteofrance_grib_target_message_sync(
    api_key: str,
    requested_grid: str | None = None,
    package_id: str = "SP2",
    requested_time_group: str | None = "00H06H",
    parameter_label: str = "Température",
    level_contains: str | None = None,
    forecast_hour: int | None = 0,
    max_messages: int = 96,
    lat: float = 45.7640,
    lon: float = 4.8357,
    label: str = DEFAULT_CENTER_LABEL,
    sample_points: int = 9,
) -> dict[str, Any]:
    target = "AROME API Paquet Modèles GRIB message ciblé"
    try:
        decoder = _detect_grib_decoder_status()
        if not decoder["can_decode_grib"]:
            return {
                "ok": False,
                "status": None,
                "message": decoder["message"],
                "target": target,
                "decoder": decoder,
            }

        package_id = package_id.strip().upper()
        resolved = _resolve_meteofrance_package_product(api_key, requested_grid, package_id, requested_time_group)
        product = resolved["product"]
        stop_when = _grib_slot_index_stop_when(
            [{"parameter_label": parameter_label, "level_contains": level_contains}],
            forecast_hour,
        )
        index = _index_grib_message_headers_cached(
            api_key,
            product["href"],
            max_messages=max_messages,
            stop_when=stop_when,
        )
        selected_message = _select_grib_target_message(index, parameter_label, forecast_hour, level_contains)
        if selected_message is None:
            level_text = f" niveau contenant {level_contains}" if level_contains else ""
            return {
                "ok": False,
                "status": index["statuses"][-1]["status"] if index["statuses"] else None,
                "message": f"Aucun message {parameter_label}{level_text} trouvé dans {package_id} {product['time']} sur {index['message_count_indexed']} message(s) indexés.",
                "target": target,
                "grid": resolved["grid"],
                "package_id": package_id,
                "time_group": product["time"],
                "index": index,
                "decoder": decoder,
            }

        message_offset = int(selected_message["offset"])
        message_length = int(selected_message["length"])
        message_payload = _fetch_grib_message_cached(api_key, product["href"], selected_message)
        raw = message_payload["raw"]
        decode = message_payload["decode"]
        grid_points = build_grid(center_lat=lat, center_lon=lon, zone_prefix=label)
        center_first_points = sorted(grid_points, key=lambda point: _distance_km(float(point.lat), float(point.lon), lat, lon))
        nearest_samples = _sample_grib_message_nearest_with_eccodes(raw, center_first_points, max_points=sample_points)
        index_range_requests = int(index.get("range_request_count") or 0)
        message_range_requests = int(message_payload.get("range_request_count") or 0)
        total_range_requests = index_range_requests + message_range_requests
        result = {
            "ok": bool(200 <= int(message_payload["status"]) < 300 and decode.get("ok")),
            "status": message_payload["status"],
            "message": (
                f"Message GRIB ciblé décodé : {package_id} {product['time']} offset {message_offset}, {message_length} octets."
                if decode.get("ok")
                else f"Message GRIB ciblé téléchargé, mais décodage impossible : {decode.get('message')}"
            ),
            "target": target,
            "content_type": message_payload["content_type"],
            "content_range": dict(message_payload.get("headers") or {}).get("content-range", ""),
            "byte_count": message_payload["byte_count"],
            "grid": resolved["grid"],
            "package_id": package_id,
            "time_group": product["time"],
            "product": product,
            "selected_message": selected_message,
            "decode": decode,
            "nearest_samples": nearest_samples,
            "index_range_request_count": index_range_requests,
            "message_range_request_count": message_range_requests,
            "total_range_request_count": total_range_requests,
            "index_cached_range_request_count": int(index.get("cached_range_request_count") or 0),
            "message_cached_range_request_count": int(message_payload.get("cached_range_request_count") or 0),
            "grib_index_cache": index.get("cache"),
            "grib_message_cache": message_payload.get("cache"),
            "grib_target_cache_hit": total_range_requests == 0,
            "decoder": decoder,
        }
        result["grib_target_cache_ttl_seconds"] = METEOFRANCE_GRIB_TARGET_CACHE_TTL_SECONDS
        return result
    except Exception as exc:
        return _meteofrance_failure_result(exc, target)


def _meteofrance_grib_slot_index_limit(package_id: str) -> int:
    package_id = package_id.strip().upper()
    if _active_nwp_model() == "arpege":
        return int(METEOFRANCE_ARPEGE_GRIB_SLOT_PACKAGE_INDEX_LIMITS.get(package_id, 400))
    return int(METEOFRANCE_GRIB_SLOT_PACKAGE_INDEX_LIMITS.get(package_id, 96))


def _meteofrance_grib_slot_index_retry_limit(package_id: str) -> int:
    package_id = package_id.strip().upper()
    if _active_nwp_model() == "arpege":
        retry_limits = METEOFRANCE_ARPEGE_GRIB_SLOT_PACKAGE_INDEX_RETRY_LIMITS
        default_retry = 512
    else:
        retry_limits = METEOFRANCE_GRIB_SLOT_PACKAGE_INDEX_RETRY_LIMITS
        default_retry = 160
    return max(
        _meteofrance_grib_slot_index_limit(package_id),
        int(retry_limits.get(package_id, default_retry)),
    )


def _select_grib_boundary_fallback_message(
    index: dict[str, Any],
    field: str | None,
    parameter_label: str,
    forecast_hour: int | None,
    level_contains: str | None,
) -> dict[str, Any] | None:
    if field not in {"temperature_2m", "wind_gusts_10m"} or forecast_hour is None:
        return None
    try:
        fallback_hour = int(round(float(forecast_hour))) - 1
    except Exception:
        return None
    if fallback_hour < 0:
        return None
    fallback = _select_grib_target_message(
        index,
        parameter_label,
        fallback_hour,
        level_contains,
        allow_forecast_fallback=False,
    )
    if fallback is None:
        return None
    annotated = copy.deepcopy(fallback)
    annotated["_requested_forecast_hour"] = int(round(float(forecast_hour)))
    annotated["_message_forecast_hour"] = fallback_hour
    annotated["_forecast_hour_fallback"] = "previous-hour-boundary"
    return annotated


def _ensure_grib_target_message_indexed(
    api_key: str,
    product_href: str,
    package_id: str,
    package_specs: list[dict[str, Any]],
    forecast_hour: int | None,
    parameter_label: str,
    level_contains: str | None,
    index: dict[str, Any],
    field: str | None = None,
    cache_only: bool = False,
    package_only: bool = False,
) -> tuple[dict[str, Any], dict[str, Any] | None, int]:
    # ARPEGE devient 3-horaire au-delà de +48 h → on cale une heure sans message exact
    # sur l'échéance voisine (≤ 2 h). AROME reste strict (horaire) : frontière nette.
    nearest_tolerance = 2 if _active_nwp_model() == "arpege" else 0
    selected_message = _select_grib_target_message(
        index,
        parameter_label,
        forecast_hour,
        level_contains,
        allow_forecast_fallback=False,
        nearest_tolerance_hours=nearest_tolerance,
    )
    if selected_message is not None:
        return index, selected_message, 0

    if not index.get("complete"):
        current_count = int(index.get("message_count_indexed") or len(index.get("messages") or []))
        retry_limit = _meteofrance_grib_slot_index_retry_limit(package_id)
        if retry_limit > current_count:
            extended_index = _index_grib_message_headers_cached(
                api_key,
                product_href,
                max_messages=retry_limit,
                stop_when=_grib_slot_index_stop_when(package_specs, forecast_hour),
                cache_only=cache_only,
                package_only=package_only,
            )
            selected_message = _select_grib_target_message(
                extended_index,
                parameter_label,
                forecast_hour,
                level_contains,
                allow_forecast_fallback=False,
                nearest_tolerance_hours=nearest_tolerance,
            )
            if selected_message is not None:
                return extended_index, selected_message, int(extended_index.get("range_request_count") or 0)
            fallback = _select_grib_boundary_fallback_message(
                extended_index,
                field,
                parameter_label,
                forecast_hour,
                level_contains,
            )
            return extended_index, fallback, int(extended_index.get("range_request_count") or 0)

    fallback = _select_grib_boundary_fallback_message(
        index,
        field,
        parameter_label,
        forecast_hour,
        level_contains,
    )
    return index, fallback, 0


def _enrich_field_values_with_wcs(field_values: dict[str, Any], slot_dt: datetime, points: list[Point]) -> None:
    """Enrichit la grille France via le WCS Météo-France — NON-FATAL.

    Ajoute CIN (convective_inhibition) et MLCAPE (mucape) — absents des paquets GRIB —
    par GetCoverage (cf. wcs_client / mémoire project_wcs_solution). En cas d'échec
    (WCS indispo, run manquant, quota), on log sur stderr et on continue : la grille
    reste celle des paquets (non-régression stricte).
    """
    if wcs_client is None:
        return
    try:
        valid_iso = slot_dt.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    except Exception:
        return

    wind_spd = field_values.get("wind_speed_10m") or {}
    wind_dir = field_values.get("wind_direction_10m") or {}
    want_shear = bool(wind_spd and wind_dir)

    # Les champs WCS sont des téléchargements GetCoverage indépendants → récupérés EN
    # PARALLÈLE (I/O réseau dominant ; le GIL est relâché pendant urllib et les appels
    # eccodes). Avant : 4 requêtes séquentielles par heure. Chaque champ reste NON-FATAL.
    field_keys = ["convective_inhibition", "mucape"]
    if want_shear:
        field_keys += ["u_500hpa", "v_500hpa"]

    def _fetch_one(field_key: str) -> tuple[str, dict[str, float] | None]:
        try:
            return field_key, wcs_client.fetch_france_field(field_key, valid_iso, points)
        except Exception as exc:  # noqa: BLE001
            print(f"[wcs] {field_key} indisponible pour {valid_iso}: {exc}", file=sys.stderr)
            return field_key, None

    results: dict[str, dict[str, float] | None] = {}
    with concurrent.futures.ThreadPoolExecutor(max_workers=len(field_keys)) as executor:
        for field_key, vals in executor.map(_fetch_one, field_keys):
            results[field_key] = vals

    if results.get("convective_inhibition"):
        field_values["convective_inhibition"] = results["convective_inhibition"]
    if results.get("mucape"):
        field_values["mucape"] = results["mucape"]

    # Cisaillement profond 0-6 km = |V(500 hPa) - V(10 m)| : u/v 500 hPa (ARPEGE WCS
    # isobare) moins le vent 10 m déjà extrait des paquets SP. Non-fatal.
    if want_shear:
        u500 = results.get("u_500hpa") or {}
        v500 = results.get("v_500hpa") or {}
        if u500 and v500:
            shear: dict[str, float] = {}
            for p in points:
                z = p.zone
                spd, drc = wind_spd.get(z), wind_dir.get(z)
                u5, v5 = u500.get(z), v500.get(z)
                if spd is None or drc is None or u5 is None or v5 is None:
                    continue
                dr = math.radians(drc)
                u10, v10 = -spd * math.sin(dr), -spd * math.cos(dr)  # convention météo (dir = provenance)
                shear[z] = round(math.hypot(u5 - u10, v5 - v10), 2)
            if shear:
                field_values["shear_ms"] = shear


def _build_meteofrance_grib_slot_grid_sync(
    api_key: str,
    lat: float,
    lon: float,
    label: str,
    target_date: Date,
    hour: int,
    requested_grid: str | None = None,
    detail_level: str = METEOFRANCE_SLOT_GRID_CORE_DETAIL,
    points_override: list[Point] | None = None,
    grid_scope: str = "local",
    cache_only: bool = False,
    force_rebuild: bool = False,
    package_only: bool = False,
) -> dict[str, Any]:
    target = "AROME Paquet Modèles GRIB grille ObjectiFoudre 1 h"
    try:
        requested_detail_level = _meteofrance_slot_grid_detail_level(detail_level)
        detail_level = METEOFRANCE_SLOT_GRID_CORE_DETAIL
        model_slot_specs = _nwp_slot_grid_specs()
        required_specs = [spec for spec in model_slot_specs if spec.get("required")]
        cache_optional_specs = [
            spec
            for spec in model_slot_specs
            if spec.get("cache_only_optional") and not spec.get("required")
        ]
        active_specs = list(required_specs)
        skipped_optional = [
            spec["field"]
            for spec in model_slot_specs
            if not spec.get("required")
        ]
        date_status = _meteofrance_arome_wcs_grid_date_status(target_date, allow_previous_day=True)
        if not date_status["ok"]:
            return {
                "ok": False,
                "status": 400,
                "message": date_status["message"],
                "target": target,
                "supported_start": date_status["supported_start"],
                "supported_until": date_status["supported_until"],
            }

        normalized_grid_scope = "france" if grid_scope == "france" else "local"
        active_package_only = bool(package_only or (normalized_grid_scope == "france" and METEOFRANCE_GRIB_PACKAGE_ONLY_NATIONAL_PRELOAD))
        if normalized_grid_scope == "france" and cache_optional_specs:
            active_specs = required_specs + cache_optional_specs
        payload_lat = METEOFRANCE_FRANCE_GRID_CENTER_LAT if normalized_grid_scope == "france" else lat
        payload_lon = METEOFRANCE_FRANCE_GRID_CENTER_LON if normalized_grid_scope == "france" else lon
        payload_label = METEOFRANCE_FRANCE_GRID_LABEL if normalized_grid_scope == "france" else label
        cache_namespace = "grib-france-slot-grid" if normalized_grid_scope == "france" else "grib-slot-grid"
        if normalized_grid_scope == "france":
            cache_key = _meteofrance_grib_france_slot_grid_cache_key(api_key, requested_grid, target_date, hour, detail_level)
        else:
            cache_key = _meteofrance_grib_slot_grid_cache_key(api_key, requested_grid, lat, lon, label, target_date, hour, detail_level)
        cached = _get_cached_value(cache_key, ttl=METEOFRANCE_GRIB_SLOT_GRID_CACHE_TTL_SECONDS)
        if not force_rebuild and cached is not None and _grib_slot_grid_result_has_required_fields(cached["payload"], detail_level):
            return _mark_grib_slot_grid_cache_hit(cached["payload"], hour, backend="memory", created_at=float(cached["ts"]))

        persistent = None if force_rebuild else _read_meteofrance_local_persistent_cache(
            cache_namespace,
            cache_key,
            METEOFRANCE_GRIB_SLOT_GRID_CACHE_TTL_SECONDS,
        )
        if not force_rebuild and persistent is not None and _grib_slot_grid_result_has_required_fields(persistent["payload"], detail_level):
            _set_cached_value(cache_key, persistent["payload"])
            return _mark_grib_slot_grid_cache_hit(persistent["payload"], hour, backend="disk", created_at=float(persistent["ts"]))

        if not cache_only:
            cooldown_result = _meteofrance_quota_cooldown_result(
                api_key,
                METEOFRANCE_GRIB_PACKAGE_QUOTA_SCOPE,
                target,
                "chargement GRIB",
            )
            if cooldown_result is not None:
                return cooldown_result

        decoder = _detect_grib_decoder_status()
        if not decoder["can_decode_grib"]:
            return {
                "ok": False,
                "status": None,
                "message": decoder["message"],
                "target": target,
                "decoder": decoder,
            }

        if points_override is not None:
            points = list(points_override)
        elif normalized_grid_scope == "france":
            # Sécurité racine du « trou carré » : un build France sans points fournis DOIT
            # utiliser la grille nationale (~2636 cellules), jamais build_grid (grille locale
            # 13×13 = 169 cellules / 195 km autour du centre). Sinon on produit — et on
            # archive (grid_scope='france') — un carré central tagué France au lieu du pays.
            points = _build_meteofrance_france_grid_points()
        else:
            points = build_grid(center_lat=lat, center_lon=lon, zone_prefix=label)
        contexts: dict[str, dict[str, Any]] = {}
        indexes: dict[tuple[str, str, int], dict[str, Any]] = {}
        field_values: dict[str, dict[str, float]] = {}
        field_requests = []
        missing: list[str] = []
        optional_missing: list[str] = []
        total_index_range_requests = 0
        total_message_range_requests = 0
        total_package_requests = 0
        cached_total_range_requests = 0
        cached_package_requests = 0
        national_field_cache_hits = 0
        national_field_sampled_count = 0
        last_status = None

        for spec in active_specs:
            field = str(spec["field"])
            package_id = str(spec["package_id"])
            if spec.get("cache_only_optional"):
                registry_sample = _sample_meteofrance_grib_national_field_registry_for_points(
                    requested_grid,
                    target_date,
                    hour,
                    field,
                    spec,
                    points,
                )
                if registry_sample is not None:
                    field_values[field] = registry_sample["values_by_zone"]
                    national_field_cache_hits += 1
                    national_field_sampled_count += int(registry_sample.get("sampled_count") or 0)
                    field_requests.append(registry_sample["field_request"])
                else:
                    optional_missing.append(field)
                    field_requests.append(
                        {
                            "field": field,
                            "package_id": package_id,
                            "parameter_label": spec["parameter_label"],
                            "level_contains": spec.get("level_contains"),
                            "forecast_hour": None,
                            "ok": False,
                            "cache_only_miss": True,
                            "optional_cache_only": True,
                            "index_range_request_count": 0,
                            "message_range_request_count": 0,
                            "message": "Champ optionnel non chargé : absent du cache national, aucune requête API lancée.",
                        }
                    )
                continue
            # Resolve the current AROME run before reusing national fields.
            # A date/hour/field registry can become stale as soon as Meteo-France publishes a newer run.
            context = contexts.get(package_id)
            if context is None:
                context = (
                    _resolve_meteofrance_package_product_for_slot_cache_only(api_key, requested_grid, package_id, target_date, hour)
                    if cache_only
                    else _resolve_meteofrance_package_product_for_slot(api_key, requested_grid, package_id, target_date, hour)
                )
            if context is None:
                if spec.get("required"):
                    missing.append(field)
                else:
                    optional_missing.append(field)
                field_requests.append(
                    {
                        "field": field,
                        "package_id": package_id,
                        "parameter_label": spec["parameter_label"],
                        "level_contains": spec.get("level_contains"),
                        "forecast_hour": None,
                        "ok": False,
                        "cache_only_miss": True,
                        "message": "Métadonnées du champ absentes du cache serveur.",
                    }
                )
                continue
            if package_id not in contexts:
                contexts[package_id] = context
            product = context["product"]
            forecast_hour = int(context.get("time_target", {}).get("forecast_hour") or 0)
            index_key = (package_id, str(product["href"]), forecast_hour)
            index = indexes.get(index_key)
            if index is None:
                package_specs = [
                    item
                    for item in active_specs
                    if str(item.get("package_id") or "") == package_id
                ]
                stop_when = _grib_slot_index_stop_when(package_specs, forecast_hour)
                index = _index_grib_message_headers_cached(
                    api_key,
                    product["href"],
                    max_messages=_meteofrance_grib_slot_index_limit(package_id),
                    stop_when=stop_when,
                    cache_only=cache_only,
                    package_only=active_package_only,
                )
                indexes[index_key] = index
                total_index_range_requests += int(index.get("range_request_count") or 0)
                total_package_requests += int(index.get("package_request_count") or 0)
                cached_total_range_requests += int(index.get("cached_range_request_count") or 0)
                cached_package_requests += int(index.get("cached_package_request_count") or 0)
                if index.get("statuses"):
                    last_status = index["statuses"][-1].get("status", last_status)

            package_specs = [
                item
                for item in active_specs
                if str(item.get("package_id") or "") == package_id
            ]
            index, selected_message, retry_index_range_requests = _ensure_grib_target_message_indexed(
                api_key,
                product["href"],
                package_id,
                package_specs,
                forecast_hour,
                str(spec["parameter_label"]),
                spec.get("level_contains"),
                index,
                field=field,
                cache_only=cache_only,
                package_only=active_package_only,
            )
            if retry_index_range_requests:
                indexes[index_key] = index
                total_index_range_requests += retry_index_range_requests
                if index.get("statuses"):
                    last_status = index["statuses"][-1].get("status", last_status)
            if selected_message is None:
                alt_context, alt_index, alt_message, alt_range_count, alt_cached_count = _find_grib_target_in_alternate_run(
                    api_key,
                    requested_grid,
                    package_id,
                    target_date,
                    hour,
                    str(product["href"]),
                    package_specs,
                    str(spec["parameter_label"]),
                    spec.get("level_contains"),
                    field,
                    indexes,
                    cache_only=cache_only,
                    package_only=active_package_only,
                )
                if alt_range_count or alt_cached_count:
                    total_index_range_requests += alt_range_count
                    cached_total_range_requests += alt_cached_count
                if alt_context is not None and alt_index is not None and alt_message is not None:
                    context = alt_context
                    contexts[package_id] = alt_context
                    product = alt_context["product"]
                    forecast_hour = int(alt_context.get("time_target", {}).get("forecast_hour") or 0)
                    index = alt_index
                    selected_message = alt_message

            if selected_message is None:
                if spec.get("required"):
                    missing.append(field)
                else:
                    optional_missing.append(field)
                field_requests.append(
                    {
                        "field": field,
                        "package_id": package_id,
                        "parameter_label": spec["parameter_label"],
                        "level_contains": spec.get("level_contains"),
                        "forecast_hour": forecast_hour,
                        "time_group": product.get("time"),
                        "ok": False,
                        "message": "Message GRIB introuvable dans l’index.",
                    }
                )
                continue

            field_cache_key = _meteofrance_grib_national_field_cache_key(requested_grid, product["href"], selected_message, field)
            national_payload, national_backend, national_created_at = _get_meteofrance_grib_national_field_cache_payload(field_cache_key)
            if national_payload is not None:
                sampled = _sample_meteofrance_grib_national_field_cache(field_cache_key, national_payload, field, points)
                values_by_zone = {
                    str(item.get("zone")): item.get("value")
                    for item in sampled.get("samples", [])
                    if item.get("zone") and item.get("value") is not None
                }
                if values_by_zone:
                    field_values[field] = values_by_zone
                    national_field_cache_hits += 1
                    national_field_sampled_count += int(sampled.get("valid_count") or 0)
                    field_requests.append(
                        {
                            "field": field,
                            "package_id": package_id,
                            "parameter_label": spec["parameter_label"],
                            "level_contains": spec.get("level_contains"),
                            "forecast_hour": forecast_hour,
                            "time_group": product.get("time"),
                            "offset": selected_message.get("offset"),
                            "length": selected_message.get("length"),
                            "message_short_name": sampled.get("metadata", {}).get("shortName"),
                            "message_name": sampled.get("metadata", {}).get("name"),
                            "units": sampled.get("metadata", {}).get("units"),
                            "valid_count": sampled.get("valid_count"),
                            "count": sampled.get("count"),
                            "index_cache": index.get("cache"),
                            "message_cache": {"hit": True, "backend": "national-field", "source_backend": national_backend},
                            "national_field_cache_hit": True,
                            "national_field_cache_backend": national_backend,
                            "national_field_cache_age_seconds": (
                                max(0, int(time.time() - float(national_created_at)))
                                if national_created_at is not None
                                else None
                            ),
                            "national_values_backend": sampled.get("values_backend"),
                            "cache_only_miss": False,
                            "cache_only_incomplete": bool(index.get("cache_only_incomplete")),
                            "index_range_request_count": int(index.get("range_request_count") or 0),
                            "message_range_request_count": 0,
                            "ok": bool(sampled.get("ok") and values_by_zone),
                            "message": sampled.get("message"),
                        }
                    )
                    continue

            message_payload = _fetch_grib_message_cached(api_key, product["href"], selected_message, decode_values=False, cache_only=cache_only, package_only=active_package_only)
            total_message_range_requests += int(message_payload.get("range_request_count") or 0)
            total_package_requests += int(message_payload.get("package_request_count") or 0)
            cached_total_range_requests += int(message_payload.get("cached_range_request_count") or 0)
            cached_package_requests += int(message_payload.get("cached_package_request_count") or 0)
            last_status = int(message_payload.get("status") or last_status or 0) or last_status
            if message_payload.get("cache_only_miss"):
                if spec.get("required"):
                    missing.append(field)
                else:
                    optional_missing.append(field)
                field_requests.append(
                    {
                        "field": field,
                        "package_id": package_id,
                        "parameter_label": spec["parameter_label"],
                        "level_contains": spec.get("level_contains"),
                        "forecast_hour": forecast_hour,
                        "time_group": product.get("time"),
                        "offset": selected_message.get("offset"),
                        "length": selected_message.get("length"),
                        "index_cache": index.get("cache"),
                        "message_cache": message_payload.get("cache"),
                        "index_range_request_count": int(index.get("range_request_count") or 0),
                        "message_range_request_count": 0,
                        "ok": False,
                        "cache_only_miss": True,
                        "package_only_miss": bool(message_payload.get("package_only_miss")),
                        "message": (
                            "Message GRIB absent du paquet complet/cache national ; aucune requête Range lancée."
                            if message_payload.get("package_only_miss")
                            else "Message GRIB absent du cache."
                        ),
                    }
                )
                continue
            sampled = _sample_grib_field_nearest_with_eccodes(message_payload["raw"], field, points)
            values_by_zone = {
                str(item.get("zone")): item.get("value")
                for item in sampled.get("samples", [])
                if item.get("zone") and item.get("value") is not None
            }
            if values_by_zone:
                field_values[field] = values_by_zone
            elif spec.get("required") and field not in METEOFRANCE_GRIB_NON_FATAL_FIELDS:
                missing.append(field)
            else:
                optional_missing.append(field)
            field_requests.append(
                {
                    "field": field,
                    "package_id": package_id,
                    "parameter_label": spec["parameter_label"],
                    "level_contains": spec.get("level_contains"),
                    "forecast_hour": forecast_hour,
                    "time_group": product.get("time"),
                    "offset": selected_message.get("offset"),
                    "length": selected_message.get("length"),
                    "message_short_name": sampled.get("metadata", {}).get("shortName"),
                    "message_name": sampled.get("metadata", {}).get("name"),
                    "units": sampled.get("metadata", {}).get("units"),
                    "valid_count": sampled.get("valid_count"),
                    "count": sampled.get("count"),
                    "index_cache": index.get("cache"),
                    "message_cache": message_payload.get("cache"),
                    "cache_only_miss": bool(index.get("cache_only_miss")),
                    "cache_only_incomplete": bool(index.get("cache_only_incomplete")),
                    "index_range_request_count": int(index.get("range_request_count") or 0),
                    "message_range_request_count": int(message_payload.get("range_request_count") or 0),
                    "ok": bool(sampled.get("ok") and values_by_zone),
                    "message": sampled.get("message"),
                }
            )

        if not any(field_values.values()) or missing:
            missing_text = ", ".join(missing) if missing else "aucun champ lisible"
            return {
                "ok": False,
                "status": last_status,
                "message": (
                    f"Grille France AROME incomplète pour {hour:02d}h : champ(s) requis manquant(s) {missing_text}."
                    if normalized_grid_scope == "france"
                    else f"Grille AROME incomplète pour {hour:02d}h : champ(s) requis manquant(s) {missing_text}."
                ),
                "target": target,
                "cache_only": bool(cache_only),
                "package_only": bool(active_package_only),
                "missing_fields": missing,
                "optional_missing_fields": optional_missing,
                "field_requests": field_requests,
                "decoder": decoder,
            }

        slot_dt = datetime.combine(target_date, Time(hour=hour), tzinfo=ZoneInfo("Europe/Paris"))
        if normalized_grid_scope == "france":
            _enrich_field_values_with_wcs(field_values, slot_dt, points)
        grid_locations = []
        for point in points:
            zone = point.zone
            temp_c = field_values.get("temperature_2m", {}).get(zone)
            dewpoint_c = field_values.get("dew_point_2m", {}).get(zone)
            rh2m = field_values.get("relative_humidity_2m", {}).get(zone)
            if rh2m is None:
                rh2m = _relative_humidity_from_dewpoint_c(temp_c, dewpoint_c)
            wind_speed_10m = field_values.get("wind_speed_10m", {}).get(zone)
            wind_direction_10m = field_values.get("wind_direction_10m", {}).get(zone)
            wind_direction_10m_available = wind_speed_10m is not None and wind_direction_10m is not None
            hourly = {
                "time": [slot_dt.isoformat()],
                "cape": [field_values.get("mucape", {}).get(zone) or field_values.get("cape", {}).get(zone) or 0.0],
                "precipitable_water": [field_values.get("precipitable_water", {}).get(zone)],
                "shortwave_radiation": [field_values.get("shortwave_radiation", {}).get(zone)],
                "precipitation_rate": [field_values.get("precipitation_rate", {}).get(zone)],
                "temperature_2m": [temp_c or 0.0],
                "dew_point_2m": [dewpoint_c or 0.0],
                "convective_inhibition": [field_values.get("convective_inhibition", {}).get(zone)],
                "shear_ms": [field_values.get("shear_ms", {}).get(zone)],
                "relative_humidity_2m": [rh2m or 0.0],
                "vapour_pressure_deficit": [_vapour_pressure_deficit_kpa(float(temp_c or 0.0), float(dewpoint_c or 0.0))],
                "wet_bulb_temperature_2m": [_wet_bulb_stull_c(float(temp_c or 0.0), float(rh2m or 0.0))],
                "cloud_cover_low": [field_values.get("cloud_cover_low", {}).get(zone)],
                "cloud_cover_mid": [field_values.get("cloud_cover_mid", {}).get(zone)],
                "cloud_cover_high": [field_values.get("cloud_cover_high", {}).get(zone)],
                "boundary_layer_height": [field_values.get("boundary_layer_height", {}).get(zone)],
                "wind_gusts_10m": [field_values.get("wind_gusts_10m", {}).get(zone) or 0.0],
                "wind_speed_10m": [wind_speed_10m or 0.0],
                "wind_direction_10m": [wind_direction_10m or 0.0],
                "wind_direction_10m_available": [wind_direction_10m_available],
            }
            grid_locations.append({"hourly": hourly, "models": METEOFRANCE_GRIB_SLOT_MODEL_NAME})

        rows = rows_for_grid_locations(points, grid_locations)
        payload = group_for_output(rows, payload_lat, payload_lon, payload_label, target_date=target_date, model_name=METEOFRANCE_GRIB_SLOT_MODEL_NAME)
        for day in payload.get("days", []):
            for slot in day.get("slots", []):
                slot["grid_scope"] = normalized_grid_scope
                slot["france_grid"] = normalized_grid_scope == "france"
                if normalized_grid_scope == "france":
                    slot["country_mask"] = "france"
                for cell in slot.get("cells", []):
                    cell["source_provider"] = "meteofrance_arome_grib"
                    cell["source_label"] = "Météo-France AROME GRIB cache"
        meta = dict(payload.get("meta", {}))
        time_targets = {
            package_id: context.get("time_target", {})
            for package_id, context in contexts.items()
        }
        arome_run_reference_times = sorted({
            str(context.get("reference_time") or "")
            for context in contexts.values()
            if context.get("reference_time")
        })
        latest_arome_run_reference_time = arome_run_reference_times[-1] if arome_run_reference_times else None
        warning = "AROME GRIB : mode probabilite strict enrichi ; champs requis CAPE, temperature 2 m, point de rosee 2 m, humidite relative 2 m, vapeur d'eau integree, rayonnement court, taux de precipitation, nebulosite basse/moyenne/haute, rafales 10 m, vent 10 m et direction 10 m. VPD/bulbe humide sont recalcules ; aucun champ optionnel n'est utilise."
        meta.update(
            {
                "provider": "meteofrance_arome_grib",
                "source_provider": "meteofrance_arome_grib",
                "source_label": "Météo-France AROME GRIB cache",
                "nwp_model": _active_nwp_model(),
                "nwp_model_label": _active_nwp_spec().get("label"),
                "migration_probe": True,
                "requested_hour": hour,
                "requested_slot": f"h{hour:02d}",
                "grid_scope": normalized_grid_scope,
                "france_grid": normalized_grid_scope == "france",
                "cache_only": bool(cache_only),
                "country_mask": "france" if normalized_grid_scope == "france" else None,
                "france_grid_cell_count": len(points) if normalized_grid_scope == "france" else None,
                "detail_level": detail_level,
                "requested_detail_level": requested_detail_level,
                "field_request_count": len(field_requests),
                "field_requests": field_requests,
                "index_range_request_count": total_index_range_requests,
                "message_range_request_count": total_message_range_requests,
                "total_range_request_count": total_index_range_requests + total_message_range_requests,
                "package_request_count": total_package_requests,
                "cached_package_request_count": cached_package_requests,
                "cached_total_range_request_count": cached_total_range_requests,
                "national_field_cache_hit_count": national_field_cache_hits,
                "national_field_sampled_count": national_field_sampled_count,
                "missing_fields": missing,
                "optional_missing_fields": optional_missing,
                "skipped_optional_fields": skipped_optional,
                "slot_grid_cache_hit": False,
                "slot_grid_cache_ttl_seconds": METEOFRANCE_GRIB_SLOT_GRID_CACHE_TTL_SECONDS,
                "grib_slot_grid_algorithm_version": METEOFRANCE_GRIB_SLOT_GRID_ALGORITHM_VERSION,
                "time_targets": time_targets,
                "arome_run_reference_times": arome_run_reference_times,
                "arome_run_latest_reference_time": latest_arome_run_reference_time,
                "arome_run_api_updated_at": latest_arome_run_reference_time,
                "decoder": decoder,
                "warning": warning,
            }
        )
        payload["meta"] = meta
        source_suffix = " depuis le cache national" if national_field_cache_hits and national_field_cache_hits == len(field_values) else ""
        grid_label_prefix = "France " if normalized_grid_scope == "france" else ""
        result = {
            "ok": True,
            "status": last_status or 200,
            "message": f"Grille {grid_label_prefix}Météo-France GRIB générée{source_suffix} pour {hour:02d}h : {len(rows)} cellules, {total_index_range_requests + total_message_range_requests} Range API" + (f", {total_package_requests} paquet(s) complet(s)" if total_package_requests else "") + ".",
            "target": target,
            "payload": payload,
            "cache_hit": False,
        }
        _set_cached_value(cache_key, result)
        _write_meteofrance_local_persistent_cache(cache_namespace, cache_key, result)
        if cache_namespace == "grib-france-slot-grid":
            _archive_france_slot_grid(result)
        return result
    except Exception as exc:
        failure = _meteofrance_failure_result(exc, target)
        if isinstance(exc, urllib.error.HTTPError) and exc.code == 429:
            _set_meteofrance_quota_cooldown(api_key, METEOFRANCE_GRIB_PACKAGE_QUOTA_SCOPE, failure)
            failure["quota_cooldown_seconds"] = METEOFRANCE_QUOTA_COOLDOWN_SECONDS
            failure["quota_cooldown_scope"] = METEOFRANCE_GRIB_PACKAGE_QUOTA_SCOPE
        return failure


def _build_meteofrance_grib_france_slot_grid_sync(
    api_key: str,
    target_date: Date,
    hour: int,
    requested_grid: str | None = None,
    detail_level: str = METEOFRANCE_SLOT_GRID_CORE_DETAIL,
    cache_only: bool = False,
    force_rebuild: bool = False,
    package_only: bool | None = None,
) -> dict[str, Any]:
    points = _build_meteofrance_france_grid_points()
    if not points:
        return {
            "ok": False,
            "status": None,
            "target": "AROME Paquet Modèles GRIB grille France",
            "message": "Grille France impossible : aucun point généré.",
        }
    return _build_meteofrance_grib_slot_grid_sync(
        api_key,
        METEOFRANCE_FRANCE_GRID_CENTER_LAT,
        METEOFRANCE_FRANCE_GRID_CENTER_LON,
        METEOFRANCE_FRANCE_GRID_LABEL,
        target_date,
        hour,
        requested_grid=requested_grid,
        detail_level=detail_level,
        points_override=points,
        grid_scope="france",
        cache_only=cache_only,
        force_rebuild=force_rebuild,
        package_only=(METEOFRANCE_GRIB_PACKAGE_ONLY_NATIONAL_PRELOAD if package_only is None else package_only),
    )


# ===================== Tendance ECMWF open data (J+5 → J+10) =====================

def _ecmwf_run_dir_url(run_date: Date, run_hour: int) -> str:
    return f"{ECMWF_OPEN_DATA_BASE}/{run_date.strftime('%Y%m%d')}/{run_hour:02d}z/{ECMWF_OPEN_DATA_STREAM}"


def _ecmwf_product_basename(run_date: Date, run_hour: int, step_hours: int) -> str:
    return f"{run_date.strftime('%Y%m%d')}{run_hour:02d}0000-{step_hours}h-oper-fc"


def _ecmwf_http_get(url: str, range_header: str | None = None, timeout: int = 60) -> tuple[int, bytes]:
    headers = {"User-Agent": f"ObjectiFoudre/{APP_VERSION}"}
    if range_header:
        headers["Range"] = range_header
    request = urllib.request.Request(url, headers=headers, method="GET")
    last_exc: Exception | None = None
    for attempt in range(3):
        try:
            with urllib.request.urlopen(request, timeout=timeout) as response:
                return int(getattr(response, "status", 200) or 200), response.read()
        except urllib.error.HTTPError as exc:
            if exc.code in {404, 416}:
                return exc.code, b""
            last_exc = exc
        except Exception as exc:  # réseau transitoire
            last_exc = exc
        time.sleep(0.6 * (attempt + 1))
    if last_exc is not None:
        raise last_exc
    raise RuntimeError("Lecture ECMWF impossible.")


def _ecmwf_fetch_index(run_date: Date, run_hour: int, step_hours: int) -> list[dict[str, Any]] | None:
    """Liste des messages GRIB du produit (param/levtype/_offset/_length). None si absent."""
    cache_key = _stable_cache_hash(f"ecmwf-index:{_ecmwf_product_basename(run_date, run_hour, step_hours)}")
    cached = _get_cached_value(cache_key, ttl=ECMWF_TREND_CACHE_TTL_SECONDS)
    if cached is not None:
        return list(cached["payload"])
    persistent = _read_meteofrance_local_persistent_cache("ecmwf-index", cache_key, ECMWF_TREND_CACHE_TTL_SECONDS)
    if persistent is not None and isinstance(persistent.get("payload"), list):
        _set_cached_value(cache_key, persistent["payload"])
        return list(persistent["payload"])
    url = f"{_ecmwf_run_dir_url(run_date, run_hour)}/{_ecmwf_product_basename(run_date, run_hour, step_hours)}.index"
    status, raw = _ecmwf_http_get(url)
    if status != 200 or not raw:
        return None
    messages: list[dict[str, Any]] = []
    for line in raw.decode("utf-8", "replace").splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            messages.append(json.loads(line))
        except json.JSONDecodeError:
            continue
    if not messages:
        return None
    _set_cached_value(cache_key, messages)
    _write_meteofrance_local_persistent_cache("ecmwf-index", cache_key, messages)
    return messages


def _ecmwf_message_for_param(messages: list[dict[str, Any]], param: str, levtype: str = "sfc") -> dict[str, Any] | None:
    for msg in messages:
        if str(msg.get("param")) == param and str(msg.get("levtype") or "sfc") == levtype:
            return msg
    # repli : certains paramètres surface n'ont pas de levtype explicite
    for msg in messages:
        if str(msg.get("param")) == param:
            return msg
    return None


def _ecmwf_fetch_message_raw(run_date: Date, run_hour: int, step_hours: int, message: dict[str, Any]) -> bytes | None:
    try:
        offset = int(message["_offset"])
        length = int(message["_length"])
    except (KeyError, TypeError, ValueError):
        return None
    url = f"{_ecmwf_run_dir_url(run_date, run_hour)}/{_ecmwf_product_basename(run_date, run_hour, step_hours)}.grib2"
    status, raw = _ecmwf_http_get(url, range_header=f"bytes={offset}-{offset + length - 1}")
    if status not in {200, 206} or len(raw) < 16 or not raw.startswith(b"GRIB"):
        return None
    return raw


def _ecmwf_decode_grid_values(raw: bytes) -> tuple[dict[str, Any], Any] | None:
    """Décode un message GRIB ECMWF : (métadonnées de grille, tableau 1D des valeurs).
    On échantillonne ensuite par index analytique (grille lat/lon régulière) plutôt que
    par find_nearest, beaucoup trop lent sur la grille globale ECMWF (~1 M points)."""
    try:
        import eccodes  # type: ignore
    except Exception:
        return None
    handle = None
    try:
        handle = eccodes.codes_new_from_message(raw)
        meta_keys = (
            "Ni", "Nj", "units", "missingValue",
            "latitudeOfFirstGridPointInDegrees", "longitudeOfFirstGridPointInDegrees",
            "iDirectionIncrementInDegrees", "jDirectionIncrementInDegrees",
            "iScansNegatively", "jScansPositively",
        )
        meta = {key: _safe_eccodes_get(handle, key) for key in meta_keys}
        values = eccodes.codes_get_values(handle)
        return meta, values
    except Exception:
        return None
    finally:
        if handle is not None:
            try:
                eccodes.codes_release(handle)
            except Exception:
                pass


def _ecmwf_point_grid_indices(meta: dict[str, Any], points: list[Any]) -> list[int | None]:
    try:
        ni = int(meta["Ni"]); nj = int(meta["Nj"])
        lat0 = float(meta["latitudeOfFirstGridPointInDegrees"])
        lon0 = float(meta["longitudeOfFirstGridPointInDegrees"])
        di = abs(float(meta["iDirectionIncrementInDegrees"]))
        dj = abs(float(meta["jDirectionIncrementInDegrees"]))
    except (KeyError, TypeError, ValueError, ZeroDivisionError):
        return [None] * len(points)
    if di <= 0 or dj <= 0:
        return [None] * len(points)
    i_neg = bool(meta.get("iScansNegatively"))
    j_pos = bool(meta.get("jScansPositively"))
    indices: list[int | None] = []
    for point in points:
        lat = float(point.lat); lon = float(point.lon)
        lon_rel = (lon - lon0)
        if i_neg:
            lon_rel = -lon_rel
        lon_rel %= 360.0
        i = int(round(lon_rel / di)) % ni
        if j_pos:
            j = int(round((lat - lat0) / dj))
        else:
            j = int(round((lat0 - lat) / dj))
        if 0 <= j < nj and 0 <= i < ni:
            indices.append(j * ni + i)
        else:
            indices.append(None)
    return indices


def _ecmwf_sample_param(run_date: Date, run_hour: int, step_hours: int, messages: list[dict[str, Any]], param: str, field: str, points: list[Any], indices_cache: dict[str, Any]) -> dict[str, float] | None:
    message = _ecmwf_message_for_param(messages, param)
    if message is None:
        return None
    raw = _ecmwf_fetch_message_raw(run_date, run_hour, step_hours, message)
    if raw is None:
        return None
    decoded = _ecmwf_decode_grid_values(raw)
    if decoded is None:
        return None
    meta, values = decoded
    # Index par point calculé une seule fois (même grille pour tous les champs du run/step)
    indices = indices_cache.get("indices")
    if indices is None:
        indices = _ecmwf_point_grid_indices(meta, points)
        indices_cache["indices"] = indices
        indices_cache["meta"] = meta
    n = len(values)
    out: dict[str, float] = {}
    for point, idx in zip(points, indices):
        if idx is None or idx >= n:
            continue
        converted = _convert_meteofrance_grib_field_value(field, float(values[idx]), meta)
        if converted is not None:
            out[str(point.zone)] = converted
    return out or None


def _ecmwf_step_for_day(run_date: Date, run_hour: int, target_date: Date) -> int:
    target_utc = datetime.combine(target_date, Time(hour=ECMWF_TREND_PEAK_UTC_HOUR), tzinfo=timezone.utc)
    run_dt = datetime.combine(run_date, Time(hour=run_hour), tzinfo=timezone.utc)
    return int(round((target_utc - run_dt).total_seconds() / 3600.0))


def _ecmwf_latest_trend_run(reference_date: Date | None = None) -> tuple[Date, int] | None:
    """Run 00z/12z le plus récent dont l'échéance J+10 (12 UTC) est déjà publiée."""
    now = datetime.now(timezone.utc)
    today = reference_date or now.date()
    max_target = today + timedelta(days=max(ECMWF_TREND_DAYS_AHEAD))
    candidates: list[tuple[Date, int]] = []
    for back in range(0, 3):
        run_date = now.date() - timedelta(days=back)
        for run_hour in (12, 0):
            candidates.append((run_date, run_hour))
    candidates.sort(key=lambda rc: datetime.combine(rc[0], Time(hour=rc[1]), tzinfo=timezone.utc), reverse=True)
    for run_date, run_hour in candidates:
        run_dt = datetime.combine(run_date, Time(hour=run_hour), tzinfo=timezone.utc)
        if run_dt > now:
            continue
        far_step = _ecmwf_step_for_day(run_date, run_hour, max_target)
        if far_step <= 0 or far_step > ECMWF_TREND_MAX_STEP_HOURS:
            continue
        if _ecmwf_fetch_index(run_date, run_hour, far_step) is not None:
            return run_date, run_hour
    return None


def _ecmwf_trend_day_cache_key(run_date: Date, run_hour: int, target_date: Date) -> str:
    return _stable_cache_hash(
        f"ecmwf-trend-day:run={run_date.isoformat()}T{run_hour:02d}:date={target_date.isoformat()}:"
        f"peak={ECMWF_TREND_PEAK_UTC_HOUR}:algo={METEOFRANCE_GRIB_SLOT_GRID_ALGORITHM_VERSION}"
    )


def _ecmwf_build_trend_day_sync(target_date: Date, run_date: Date, run_hour: int) -> dict[str, Any]:
    """Construit la grille tendance ECMWF d'un jour (CAPE ≈ pic d'instabilité), scorée
    avec le même assemblage que la grille AROME/ARPEGE, projetée en niveau « render »."""
    cache_key = _ecmwf_trend_day_cache_key(run_date, run_hour, target_date)
    cached = _get_cached_value(cache_key, ttl=ECMWF_TREND_CACHE_TTL_SECONDS)
    if cached is not None:
        return copy.deepcopy(cached["payload"])
    persistent = _read_meteofrance_local_persistent_cache("ecmwf-trend-day", cache_key, ECMWF_TREND_CACHE_TTL_SECONDS)
    if persistent is not None and isinstance(persistent.get("payload"), dict):
        _set_cached_value(cache_key, persistent["payload"])
        return copy.deepcopy(persistent["payload"])

    step_hours = _ecmwf_step_for_day(run_date, run_hour, target_date)
    if step_hours <= 0 or step_hours > ECMWF_TREND_MAX_STEP_HOURS:
        return {"ok": False, "status": 400, "message": f"Échéance ECMWF hors horizon pour {target_date.isoformat()}."}
    messages = _ecmwf_fetch_index(run_date, run_hour, step_hours)
    if messages is None:
        return {"ok": False, "status": 404, "message": f"Produit ECMWF {step_hours}h indisponible pour {target_date.isoformat()}."}

    points = _build_meteofrance_france_grid_points()
    indices_cache: dict[str, Any] = {}
    field_values: dict[str, dict[str, float]] = {}
    for field, param in ECMWF_TREND_FIELD_MAP.items():
        values = _ecmwf_sample_param(run_date, run_hour, step_hours, messages, param, field, points, indices_cache)
        if values:
            field_values[field] = values
    # Vent : reconstruit depuis 10u/10v (vitesse + direction météo)
    u_vals = _ecmwf_sample_param(run_date, run_hour, step_hours, messages, ECMWF_TREND_WIND_COMPONENTS[0], "wind_u_10m", points, indices_cache)
    v_vals = _ecmwf_sample_param(run_date, run_hour, step_hours, messages, ECMWF_TREND_WIND_COMPONENTS[1], "wind_v_10m", points, indices_cache)
    if u_vals and v_vals:
        speed: dict[str, float] = {}
        direction: dict[str, float] = {}
        for zone, u in u_vals.items():
            v = v_vals.get(zone)
            if u is None or v is None:
                continue
            speed[zone] = round(math.hypot(float(u), float(v)), 3)
            direction[zone] = round((math.degrees(math.atan2(-float(u), -float(v))) + 360.0) % 360.0, 1)
        if speed:
            field_values["wind_speed_10m"] = speed
            field_values["wind_direction_10m"] = direction

    if "cape" not in field_values:
        return {"ok": False, "status": 502, "message": f"CAPE ECMWF illisible pour {target_date.isoformat()}."}

    valid_utc = datetime.combine(run_date, Time(hour=run_hour), tzinfo=timezone.utc) + timedelta(hours=step_hours)
    slot_local = valid_utc.astimezone(ZoneInfo("Europe/Paris"))
    grid_locations = []
    for point in points:
        zone = point.zone
        temp_c = field_values.get("temperature_2m", {}).get(zone)
        dewpoint_c = field_values.get("dew_point_2m", {}).get(zone)
        rh2m = _relative_humidity_from_dewpoint_c(temp_c, dewpoint_c)
        wind_speed = field_values.get("wind_speed_10m", {}).get(zone)
        wind_dir = field_values.get("wind_direction_10m", {}).get(zone)
        hourly = {
            "time": [slot_local.isoformat()],
            "cape": [field_values.get("cape", {}).get(zone) or 0.0],
            "precipitable_water": [field_values.get("precipitable_water", {}).get(zone)],
            "shortwave_radiation": [None],
            "precipitation_rate": [None],
            "temperature_2m": [temp_c if temp_c is not None else 0.0],
            "dew_point_2m": [dewpoint_c if dewpoint_c is not None else 0.0],
            "convective_inhibition": [None],
            "relative_humidity_2m": [rh2m if rh2m is not None else 0.0],
            "vapour_pressure_deficit": [_vapour_pressure_deficit_kpa(float(temp_c or 0.0), float(dewpoint_c or 0.0))],
            "wet_bulb_temperature_2m": [_wet_bulb_stull_c(float(temp_c or 0.0), float(rh2m or 0.0))],
            "cloud_cover_low": [None],
            "cloud_cover_mid": [None],
            "cloud_cover_high": [None],
            "boundary_layer_height": [None],
            "wind_gusts_10m": [field_values.get("wind_gusts_10m", {}).get(zone) or 0.0],
            "wind_speed_10m": [wind_speed if wind_speed is not None else 0.0],
            "wind_direction_10m": [wind_dir if wind_dir is not None else 0.0],
            "wind_direction_10m_available": [wind_speed is not None and wind_dir is not None],
        }
        grid_locations.append({"hourly": hourly, "models": ECMWF_TREND_MODEL_NAME})

    rows = rows_for_grid_locations(points, grid_locations)
    payload = group_for_output(
        rows,
        METEOFRANCE_FRANCE_GRID_CENTER_LAT,
        METEOFRANCE_FRANCE_GRID_CENTER_LON,
        METEOFRANCE_FRANCE_GRID_LABEL,
        target_date=target_date,
        model_name=ECMWF_TREND_MODEL_NAME,
    )
    for day in payload.get("days", []):
        for slot in day.get("slots", []):
            slot["grid_scope"] = "france"
            slot["france_grid"] = True
            for cell in slot.get("cells", []):
                cell["source_provider"] = ECMWF_TREND_MODEL_NAME
                cell["source_label"] = "ECMWF IFS tendance"
    run_iso = datetime.combine(run_date, Time(hour=run_hour), tzinfo=timezone.utc).isoformat().replace("+00:00", "Z")
    meta = dict(payload.get("meta") or {})
    meta.update({
        "provider": ECMWF_TREND_MODEL_NAME,
        "source_provider": ECMWF_TREND_MODEL_NAME,
        "source_label": "ECMWF IFS tendance",
        "nwp_model": "ecmwf",
        "nwp_model_label": "ECMWF",
        "trend": True,
        "attribution": ECMWF_TREND_ATTRIBUTION,
        "grid_scope": "france",
        "france_grid": True,
        "ecmwf_run_reference_time": run_iso,
        "ecmwf_step_hours": step_hours,
        "valid_time": valid_utc.isoformat().replace("+00:00", "Z"),
        "valid_time_local": slot_local.isoformat(),
        "resolution_label": "0,25° (~28 km)",
        "fields_available": sorted(field_values.keys()),
    })
    payload["meta"] = meta
    result = _project_grib_result_for_render({"ok": True, "payload": payload})
    result.update({
        "ok": True,
        "status": 200,
        "date": target_date.isoformat(),
        "run_reference_time": run_iso,
        "step_hours": step_hours,
        "message": f"Tendance ECMWF {target_date.isoformat()} (échéance {step_hours}h) : {len(points)} cellules.",
    })
    _set_cached_value(cache_key, result)
    _write_meteofrance_local_persistent_cache("ecmwf-trend-day", cache_key, result)
    return copy.deepcopy(result)


def _ecmwf_trend_dates(reference_date: Date | None = None) -> list[Date]:
    today = reference_date or datetime.now(OBJECTIFOUDRE_SERVER_TIMEZONE).date()
    return [today + timedelta(days=offset) for offset in ECMWF_TREND_DAYS_AHEAD]


def _ecmwf_trend_status_sync(reference_date: Date | None = None) -> dict[str, Any]:
    today = reference_date or datetime.now(OBJECTIFOUDRE_SERVER_TIMEZONE).date()
    run = _ecmwf_latest_trend_run(today)
    dates = _ecmwf_trend_dates(today)
    if run is None:
        return {
            "ok": False,
            "available": False,
            "message": "Aucun run ECMWF open data disponible pour la tendance J+5 → J+10.",
            "dates": [d.isoformat() for d in dates],
            "attribution": ECMWF_TREND_ATTRIBUTION,
        }
    run_date, run_hour = run
    run_iso = datetime.combine(run_date, Time(hour=run_hour), tzinfo=timezone.utc).isoformat().replace("+00:00", "Z")
    days = []
    for d, offset in zip(dates, ECMWF_TREND_DAYS_AHEAD):
        cache_key = _ecmwf_trend_day_cache_key(run_date, run_hour, d)
        cached = _get_cached_value(cache_key, ttl=ECMWF_TREND_CACHE_TTL_SECONDS) or _read_meteofrance_local_persistent_cache(
            "ecmwf-trend-day", cache_key, ECMWF_TREND_CACHE_TTL_SECONDS
        )
        days.append({
            "date": d.isoformat(),
            "day_offset": offset,
            "label": f"J+{offset}",
            "step_hours": _ecmwf_step_for_day(run_date, run_hour, d),
            "cached": cached is not None,
        })
    return {
        "ok": True,
        "available": True,
        "run_reference_time": run_iso,
        "resolution_label": "0,25° (~28 km)",
        "attribution": ECMWF_TREND_ATTRIBUTION,
        "peak_utc_hour": ECMWF_TREND_PEAK_UTC_HOUR,
        "dates": [d.isoformat() for d in dates],
        "days": days,
    }


def _preload_meteofrance_grib_slot_grids_sync(
    api_key: str,
    lat: float,
    lon: float,
    label: str,
    target_date: Date,
    hour: int,
    requested_grid: str | None = None,
    detail_level: str = METEOFRANCE_SLOT_GRID_CORE_DETAIL,
    scope: str = "time_group",
    max_hours: int = 8,
    progress_callback: Callable[[dict[str, Any]], None] | None = None,
) -> dict[str, Any]:
    target = "AROME Paquet Modèles GRIB préchargement"
    started = time.time()
    try:
        detail_level = METEOFRANCE_SLOT_GRID_CORE_DETAIL
        max_hours = max(1, min(24, int(max_hours)))
        if scope == "day":
            hours = list(range(24))
        else:
            context = _resolve_meteofrance_package_product_for_slot(api_key, requested_grid, "SP2", target_date, hour)
            hours = _meteofrance_grib_local_hours_for_time_group(context.get("time_target", {}), hour)
        if hour not in hours:
            hours.append(hour)
        hours = sorted(set(max(0, min(23, int(item))) for item in hours))[:max_hours]
        if progress_callback:
            progress_callback(
                {
                    "running": True,
                    "started_at": started,
                    "hours": hours,
                    "hour_count": len(hours),
                    "completed_count": 0,
                    "ok_count": 0,
                    "failed_count": 0,
                    "slot_grid_cache_hit_count": 0,
                    "total_range_request_count": 0,
                    "cached_total_range_request_count": 0,
                    "current_hour": hours[0] if hours else None,
                    "current_index": 0 if hours else None,
                    "results": [],
                }
            )

        results = []
        ok_count = 0
        slot_cache_hits = 0
        total_range_requests = 0
        cached_total_range_requests = 0
        for index, slot_hour in enumerate(hours):
            if progress_callback:
                progress_callback(
                    {
                        "running": True,
                        "current_hour": slot_hour,
                        "current_index": index,
                        "completed_count": len(results),
                        "ok_count": ok_count,
                        "failed_count": len([item for item in results if not item.get("ok")]),
                        "slot_grid_cache_hit_count": slot_cache_hits,
                        "total_range_request_count": total_range_requests,
                        "cached_total_range_request_count": cached_total_range_requests,
                    }
                )
            result = _build_meteofrance_grib_slot_grid_sync(
                api_key,
                lat,
                lon,
                label,
                target_date,
                slot_hour,
                requested_grid=requested_grid,
                detail_level=detail_level,
            )
            payload_meta = result.get("payload", {}).get("meta", {}) if isinstance(result.get("payload"), dict) else {}
            range_count = int(payload_meta.get("total_range_request_count") or 0)
            cached_range_count = int(payload_meta.get("cached_total_range_request_count") or 0)
            total_range_requests += range_count
            cached_total_range_requests += cached_range_count
            if result.get("ok"):
                ok_count += 1
            if payload_meta.get("slot_grid_cache_hit"):
                slot_cache_hits += 1
            results.append(
                {
                    "hour": slot_hour,
                    "ok": bool(result.get("ok")),
                    "status": result.get("status"),
                    "message": result.get("message"),
                    "slot_grid_cache_hit": bool(payload_meta.get("slot_grid_cache_hit")),
                    "field_request_count": payload_meta.get("field_request_count"),
                    "range_request_count": range_count,
                    "cached_range_request_count": cached_range_count,
                    "missing_fields": payload_meta.get("missing_fields", []),
                    "optional_missing_fields": payload_meta.get("optional_missing_fields", []),
                }
            )
            if progress_callback:
                progress_callback(
                    {
                        "running": True,
                        "current_hour": slot_hour,
                        "current_index": index,
                        "completed_count": len(results),
                        "ok_count": ok_count,
                        "failed_count": len([item for item in results if not item.get("ok")]),
                        "slot_grid_cache_hit_count": slot_cache_hits,
                        "total_range_request_count": total_range_requests,
                        "cached_total_range_request_count": cached_total_range_requests,
                        "last_result": results[-1] if results else None,
                        "results": copy.deepcopy(results),
                    }
                )
            if int(result.get("status") or 0) == 429:
                remaining = int(result.get("quota_cooldown_seconds") or METEOFRANCE_QUOTA_COOLDOWN_SECONDS)
                for skipped_hour in hours[index + 1:]:
                    results.append(
                        {
                            "hour": skipped_hour,
                            "ok": False,
                            "status": 429,
                            "message": "Préchargement non tenté : quota Météo-France en cooldown serveur.",
                            "slot_grid_cache_hit": False,
                            "field_request_count": None,
                            "range_request_count": 0,
                            "cached_range_request_count": 0,
                            "missing_fields": [],
                            "optional_missing_fields": [],
                            "skipped_due_to_quota": True,
                            "quota_cooldown_seconds": remaining,
                        }
                    )
                if progress_callback:
                    progress_callback(
                        {
                            "running": True,
                            "current_hour": None,
                            "current_index": None,
                            "completed_count": len(results),
                            "ok_count": ok_count,
                            "failed_count": len([item for item in results if not item.get("ok")]),
                            "slot_grid_cache_hit_count": slot_cache_hits,
                            "total_range_request_count": total_range_requests,
                            "cached_total_range_request_count": cached_total_range_requests,
                            "quota_cooldown_seconds": remaining,
                            "last_result": results[-1] if results else None,
                            "results": copy.deepcopy(results),
                        }
                    )
                break

        elapsed_ms = int((time.time() - started) * 1000)
        failed_results = [item for item in results if not item.get("ok")]
        failure_summary = [
            {
                "hour": item.get("hour"),
                "status": item.get("status"),
                "message": item.get("message"),
                "missing_fields": item.get("missing_fields", []),
                "optional_missing_fields": item.get("optional_missing_fields", []),
                "range_request_count": item.get("range_request_count", 0),
                "skipped_due_to_quota": bool(item.get("skipped_due_to_quota")),
                "quota_cooldown_seconds": item.get("quota_cooldown_seconds"),
            }
            for item in failed_results
        ]
        quota_cooldown_seconds = next(
            (int(item.get("quota_cooldown_seconds")) for item in results if int(item.get("status") or 0) == 429 and item.get("quota_cooldown_seconds")),
            None,
        )
        if ok_count == len(hours):
            message = f"Préchargement GRIB OK : {ok_count}/{len(hours)} heure(s), {total_range_requests} Range API."
        elif ok_count:
            message = f"Préchargement GRIB partiel : {ok_count}/{len(hours)} heure(s), {total_range_requests} Range API."
        else:
            message = "Préchargement GRIB impossible : aucune heure générée."
        return {
            "ok": bool(ok_count),
            "status": next((item.get("status") for item in results if item.get("status")), None),
            "message": message,
            "target": target,
            "scope": scope if scope in {"time_group", "day"} else "time_group",
            "detail_level": detail_level,
            "hours": hours,
            "hour_count": len(hours),
            "ok_count": ok_count,
            "failed_count": len(failed_results),
            "failed_hours": [item.get("hour") for item in failed_results],
            "failure_summary": failure_summary,
            "quota_cooldown_seconds": quota_cooldown_seconds,
            "slot_grid_cache_hit_count": slot_cache_hits,
            "total_range_request_count": total_range_requests,
            "cached_total_range_request_count": cached_total_range_requests,
            "elapsed_ms": elapsed_ms,
            "results": results,
        }
    except Exception as exc:
        failure = _meteofrance_failure_result(exc, target)
        if isinstance(exc, urllib.error.HTTPError) and exc.code == 429:
            _set_meteofrance_quota_cooldown(api_key, METEOFRANCE_GRIB_PACKAGE_QUOTA_SCOPE, failure)
            failure["quota_cooldown_seconds"] = METEOFRANCE_QUOTA_COOLDOWN_SECONDS
            failure["quota_cooldown_scope"] = METEOFRANCE_GRIB_PACKAGE_QUOTA_SCOPE
        return failure


def _preload_meteofrance_grib_national_day_sync(
    api_key: str,
    target_date: Date,
    requested_grid: str | None = None,
    max_hours: int = 24,
    progress_callback: Callable[[dict[str, Any]], None] | None = None,
    hours_override: list[int] | None = None,
    field_names: set[str] | None = None,
    progress_scope: str = "national_day",
    force_refresh_run_metadata: bool = False,
) -> dict[str, Any]:
    target = "AROME Paquet Modèles GRIB préchargement France"
    started = time.time()
    try:
        max_hours = max(1, min(24, int(max_hours)))
        if hours_override is None:
            hours = list(range(24))[:max_hours]
        else:
            hours = [int(hour) for hour in hours_override if 0 <= int(hour) <= 23]
            hours = list(dict.fromkeys(hours))[:max_hours]
        model_slot_specs = _nwp_slot_grid_specs()
        if field_names is None:
            active_specs = [spec for spec in model_slot_specs if spec.get("required")]
        else:
            requested_fields = {str(item) for item in field_names}
            active_specs = [spec for spec in model_slot_specs if str(spec.get("field")) in requested_fields]
        unit_count = len(hours) * len(active_specs)
        active_package_only = bool(METEOFRANCE_GRIB_PACKAGE_ONLY_NATIONAL_PRELOAD)
        if progress_callback:
            progress_callback(
                {
                    "running": True,
                    "started_at": started,
                    "scope": progress_scope,
                    "package_only": active_package_only,
                    "hours": hours,
                    "hour_count": len(hours),
                    "unit_count": unit_count,
                    "unit_label": "champ(s)",
                    "completed_count": 0,
                    "ok_count": 0,
                    "failed_count": 0,
                    "total_range_request_count": 0,
                    "cached_total_range_request_count": 0,
                    "national_field_cache_hit_count": 0,
                    "decoded_field_count": 0,
                    "current_hour": hours[0] if hours else None,
                    "current_index": 0 if hours else None,
                    "current_field": active_specs[0]["field"] if active_specs else None,
                    "results": [],
                }
            )

        date_status = _meteofrance_arome_wcs_grid_date_status(target_date, allow_previous_day=True)
        if not date_status["ok"]:
            return {
                "ok": False,
                "status": 400,
                "message": date_status["message"],
                "target": target,
                "package_only": active_package_only,
                "scope": progress_scope,
                "hours": hours,
                "hour_count": len(hours),
                "unit_count": unit_count,
                "unit_label": "champ(s)",
            }

        cooldown_result = _meteofrance_quota_cooldown_result(
            api_key,
            METEOFRANCE_GRIB_PACKAGE_QUOTA_SCOPE,
            target,
            "préchargement France GRIB",
        )
        if cooldown_result is not None:
            cooldown_result.update(
                {
                    "scope": progress_scope,
                    "hours": hours,
                    "hour_count": len(hours),
                    "unit_count": unit_count,
                    "unit_label": "champ(s)",
                }
            )
            return cooldown_result

        decoder = _detect_grib_decoder_status()
        if not decoder["can_decode_grib"]:
            return {
                "ok": False,
                "status": None,
                "message": decoder["message"],
                "target": target,
                "scope": progress_scope,
                "hours": hours,
                "hour_count": len(hours),
                "unit_count": unit_count,
                "unit_label": "champ(s)",
                "decoder": decoder,
            }

        contexts: dict[tuple[str, int], dict[str, Any]] = {}
        indexes: dict[tuple[Any, ...], dict[str, Any]] = {}
        forced_metadata_refresh_packages: set[str] = set()
        results: list[dict[str, Any]] = []
        ok_count = 0
        field_cache_hits = 0
        decoded_fields = 0
        total_index_range_requests = 0
        total_message_range_requests = 0
        total_package_requests = 0
        cached_total_range_requests = 0
        cached_package_requests = 0
        last_status = None
        quota_cooldown_seconds = None
        stop_requested = False
        stop_status = None
        stop_message = None
        stop_is_quota = False

        def push_progress(**extra: Any) -> None:
            if not progress_callback:
                return
            update = {
                "running": True,
                "scope": progress_scope,
                "hours": hours,
                "hour_count": len(hours),
                "unit_count": unit_count,
                "unit_label": "champ(s)",
                "completed_count": len(results),
                "ok_count": ok_count,
                "failed_count": len([item for item in results if not item.get("ok")]),
                "total_range_request_count": total_index_range_requests + total_message_range_requests,
                "package_request_count": total_package_requests,
                "cached_total_range_request_count": cached_total_range_requests,
                "cached_package_request_count": cached_package_requests,
                "national_field_cache_hit_count": field_cache_hits,
                "decoded_field_count": decoded_fields,
                "last_result": results[-1] if results else None,
                "results": copy.deepcopy(results),
            }
            update.update(extra)
            progress_callback(update)

        for hour_index, slot_hour in enumerate(hours):
            for field_index, spec in enumerate(active_specs):
                field = str(spec["field"])
                package_id = str(spec["package_id"])
                push_progress(current_hour=slot_hour, current_index=len(results), current_field=field)
                result_item: dict[str, Any] = {
                    "hour": slot_hour,
                    "field": field,
                    "package_id": package_id,
                    "ok": False,
                    "status": None,
                    "range_request_count": 0,
                    "cached_range_request_count": 0,
                    "field_cache_hit": False,
                    "decoded": False,
                }
                try:
                    # Do not trust the direct date/hour/field registry before resolving
                    # the current AROME run. It can point to a previous run after model updates.
                    context_key = (package_id, slot_hour)
                    context = contexts.get(context_key)
                    if context is None:
                        refresh_metadata = bool(force_refresh_run_metadata and package_id not in forced_metadata_refresh_packages)
                        context = _resolve_meteofrance_package_product_for_slot(
                            api_key,
                            requested_grid,
                            package_id,
                            target_date,
                            slot_hour,
                            force_refresh=refresh_metadata,
                        )
                        if refresh_metadata:
                            forced_metadata_refresh_packages.add(package_id)
                        contexts[context_key] = context
                    product = context["product"]
                    forecast_hour = int(context.get("time_target", {}).get("forecast_hour") or 0)
                    index_key = (package_id, str(product["href"])) if active_package_only else (package_id, str(product["href"]), forecast_hour)
                    index = indexes.get(index_key)
                    if index is None:
                        package_specs = [item for item in active_specs if str(item.get("package_id") or "") == package_id]
                        index = _index_grib_message_headers_cached(
                            api_key,
                            product["href"],
                            max_messages=(
                                _meteofrance_grib_slot_index_retry_limit(package_id)
                                if active_package_only
                                else _meteofrance_grib_slot_index_limit(package_id)
                            ),
                            stop_when=(None if active_package_only else _grib_slot_index_stop_when(package_specs, forecast_hour)),
                            package_only=active_package_only,
                        )
                        indexes[index_key] = index
                        index_range_count = int(index.get("range_request_count") or 0)
                        total_index_range_requests += index_range_count
                        total_package_requests += int(index.get("package_request_count") or 0)
                        cached_total_range_requests += int(index.get("cached_range_request_count") or 0)
                        cached_package_requests += int(index.get("cached_package_request_count") or 0)
                    else:
                        index_range_count = 0
                    if index.get("statuses"):
                        last_status = index["statuses"][-1].get("status", last_status)

                    package_specs = [item for item in active_specs if str(item.get("package_id") or "") == package_id]
                    index, selected_message, retry_index_range_count = _ensure_grib_target_message_indexed(
                        api_key,
                        product["href"],
                        package_id,
                        package_specs,
                        forecast_hour,
                        str(spec["parameter_label"]),
                        spec.get("level_contains"),
                        index,
                        field=field,
                        package_only=active_package_only,
                    )
                    if retry_index_range_count:
                        indexes[index_key] = index
                        index_range_count += retry_index_range_count
                        total_index_range_requests += retry_index_range_count
                        if index.get("statuses"):
                            last_status = index["statuses"][-1].get("status", last_status)
                    if selected_message is None:
                        alt_context, alt_index, alt_message, alt_range_count, alt_cached_count = _find_grib_target_in_alternate_run(
                            api_key,
                            requested_grid,
                            package_id,
                            target_date,
                            slot_hour,
                            str(product["href"]),
                            package_specs,
                            str(spec["parameter_label"]),
                            spec.get("level_contains"),
                            field,
                            indexes,
                            package_only=active_package_only,
                        )
                        if alt_range_count or alt_cached_count:
                            index_range_count += alt_range_count
                            total_index_range_requests += alt_range_count
                            cached_total_range_requests += alt_cached_count
                        if alt_context is not None and alt_index is not None and alt_message is not None:
                            context = alt_context
                            contexts[context_key] = alt_context
                            product = alt_context["product"]
                            forecast_hour = int(alt_context.get("time_target", {}).get("forecast_hour") or 0)
                            index = alt_index
                            selected_message = alt_message
                    if selected_message is None:
                        result_item.update(
                            {
                                "message": "Message GRIB exact introuvable dans l'index.",
                                "forecast_hour": forecast_hour,
                                "time_group": product.get("time"),
                                "index_range_request_count": index_range_count,
                                "range_request_count": index_range_count,
                            }
                        )
                        results.append(result_item)
                        push_progress(current_hour=slot_hour, current_index=len(results), current_field=field)
                        continue

                    field_cache_key = _meteofrance_grib_national_field_cache_key(requested_grid, product["href"], selected_message, field)
                    cached = _get_cached_value(field_cache_key, ttl=METEOFRANCE_GRIB_NATIONAL_FIELD_CACHE_TTL_SECONDS)
                    cache_payload = copy.deepcopy(cached["payload"]) if cached is not None else None
                    if cache_payload is None:
                        persistent = _read_meteofrance_grib_national_field_cache(
                            field_cache_key,
                            METEOFRANCE_GRIB_NATIONAL_FIELD_CACHE_TTL_SECONDS,
                        )
                        if persistent is not None:
                            cache_payload = copy.deepcopy(persistent["payload"])
                            _set_cached_value(field_cache_key, cache_payload)
                    if cache_payload is not None:
                        _write_meteofrance_grib_national_field_registry(
                            requested_grid,
                            target_date,
                            slot_hour,
                            field,
                            field_cache_key,
                            product,
                            selected_message,
                            spec,
                            forecast_hour,
                        )
                        ok_count += 1
                        field_cache_hits += 1
                        result_item.update(
                            {
                                "ok": True,
                                "status": 200,
                                "message": "Champ national déjà en cache serveur.",
                                "field_cache_hit": True,
                                "forecast_hour": forecast_hour,
                                "time_group": product.get("time"),
                                "offset": selected_message.get("offset"),
                                "length": selected_message.get("length"),
                                "index_range_request_count": index_range_count,
                                "message_range_request_count": 0,
                                "range_request_count": index_range_count,
                                "value_count": cache_payload.get("value_count"),
                                "valid_count": cache_payload.get("valid_count"),
                                "compressed_byte_count": cache_payload.get("compressed_byte_count"),
                            }
                        )
                        results.append(result_item)
                        push_progress(current_hour=slot_hour, current_index=len(results), current_field=field)
                        continue

                    message_payload = _fetch_grib_message_cached(api_key, product["href"], selected_message, decode_values=False, package_only=active_package_only)
                    message_range_count = int(message_payload.get("range_request_count") or 0)
                    if message_payload.get("package_only_miss"):
                        result_item.update(
                            {
                                "status": last_status,
                                "message": message_payload.get("decode", {}).get("message") or "Message GRIB absent du paquet complet.",
                                "forecast_hour": forecast_hour,
                                "time_group": product.get("time"),
                                "offset": selected_message.get("offset"),
                                "length": selected_message.get("length"),
                                "index_range_request_count": index_range_count,
                                "message_range_request_count": 0,
                                "range_request_count": index_range_count,
                                "package_only_miss": True,
                            }
                        )
                        results.append(result_item)
                        push_progress(current_hour=slot_hour, current_index=len(results), current_field=field)
                        continue
                    total_message_range_requests += message_range_count
                    total_package_requests += int(message_payload.get("package_request_count") or 0)
                    cached_total_range_requests += int(message_payload.get("cached_range_request_count") or 0)
                    cached_package_requests += int(message_payload.get("cached_package_request_count") or 0)
                    last_status = int(message_payload.get("status") or last_status or 0) or last_status
                    decoded = _decode_meteofrance_grib_national_field(message_payload["raw"], field)
                    if not decoded.get("ok"):
                        result_item.update(
                            {
                                "status": last_status,
                                "message": decoded.get("message") or "Décodage national impossible.",
                                "forecast_hour": forecast_hour,
                                "time_group": product.get("time"),
                                "offset": selected_message.get("offset"),
                                "length": selected_message.get("length"),
                                "index_range_request_count": index_range_count,
                                "message_range_request_count": message_range_count,
                                "range_request_count": index_range_count + message_range_count,
                            }
                        )
                        results.append(result_item)
                        push_progress(current_hour=slot_hour, current_index=len(results), current_field=field)
                        continue

                    decoded_payload = decoded["payload"]
                    decoded_payload.update(
                        {
                            "forecast_hour": forecast_hour,
                            "time_group": product.get("time"),
                            "package_id": package_id,
                            "parameter_label": spec.get("parameter_label"),
                            "level_contains": spec.get("level_contains"),
                            "product_href_hash": _stable_cache_hash(str(product["href"])),
                            "offset": selected_message.get("offset"),
                            "length": selected_message.get("length"),
                        }
                    )
                    _write_meteofrance_grib_national_field_cache(field_cache_key, decoded_payload, decoded["compressed_values"])
                    _set_cached_value(field_cache_key, decoded_payload)
                    _write_meteofrance_grib_national_field_registry(
                        requested_grid,
                        target_date,
                        slot_hour,
                        field,
                        field_cache_key,
                        product,
                        selected_message,
                        spec,
                        forecast_hour,
                    )
                    ok_count += 1
                    decoded_fields += 1
                    result_item.update(
                        {
                            "ok": True,
                            "status": last_status or 206,
                            "message": decoded_payload.get("message"),
                            "decoded": True,
                            "forecast_hour": forecast_hour,
                            "time_group": product.get("time"),
                            "offset": selected_message.get("offset"),
                            "length": selected_message.get("length"),
                            "index_range_request_count": index_range_count,
                            "message_range_request_count": message_range_count,
                            "range_request_count": index_range_count + message_range_count,
                            "value_count": decoded_payload.get("value_count"),
                            "valid_count": decoded_payload.get("valid_count"),
                            "compressed_byte_count": decoded_payload.get("compressed_byte_count"),
                            "compression_ratio": decoded_payload.get("compression_ratio"),
                        }
                    )
                    results.append(result_item)
                    push_progress(current_hour=slot_hour, current_index=len(results), current_field=field)
                except Exception as exc:
                    failure = _meteofrance_failure_result(exc, target)
                    failure_status = int(failure.get("status") or 0)
                    if _is_meteofrance_quota_or_rate_limit_failure(failure, exc):
                        _set_meteofrance_quota_cooldown(api_key, METEOFRANCE_GRIB_PACKAGE_QUOTA_SCOPE, failure)
                        quota_cooldown_seconds = METEOFRANCE_QUOTA_COOLDOWN_SECONDS
                        stop_requested = True
                        stop_status = failure_status or 429
                        stop_message = "Préchargement non tenté : quota Météo-France en cooldown serveur."
                        stop_is_quota = True
                    elif failure_status in {401, 403}:
                        stop_requested = True
                        stop_status = failure_status
                        stop_message = "Préchargement non tenté : accès Météo-France refusé côté serveur."
                    result_item.update(
                        {
                            "status": failure.get("status"),
                            "message": failure.get("message") or str(exc),
                            "range_request_count": 0,
                            "quota_cooldown_seconds": quota_cooldown_seconds,
                        }
                    )
                    results.append(result_item)
                    push_progress(
                        current_hour=None if stop_requested else slot_hour,
                        current_index=len(results),
                        current_field=None if stop_requested else field,
                        quota_cooldown_seconds=quota_cooldown_seconds,
                    )
                    if stop_requested:
                        break
            if stop_requested:
                break

        pending_unit_count = max(0, unit_count - len(results))
        if stop_requested and pending_unit_count > 0:
            # Keep the remaining units pending instead of marking them failed. The
            # automation loop will wait for the cooldown and call this preloader
            # again, reusing the fields that were already cached.
            push_progress(
                current_hour=None,
                current_index=len(results),
                current_field=None,
                quota_cooldown_seconds=quota_cooldown_seconds,
                pending_unit_count=pending_unit_count,
                paused_for_quota=bool(stop_is_quota),
            )

        elapsed_ms = int((time.time() - started) * 1000)
        failed_results = [item for item in results if not item.get("ok")]
        total_range_requests = total_index_range_requests + total_message_range_requests
        request_summary = f"{total_range_requests} Range API" + (f", {total_package_requests} paquet(s) complet(s)" if total_package_requests else "")
        if ok_count == unit_count:
            message = f"Préchargement France AROME OK : {ok_count}/{unit_count} champ(s), {request_summary}."
        elif quota_cooldown_seconds:
            message = f"Préchargement France AROME suspendu par quota : {ok_count}/{unit_count} champ(s) déjà prêts, reprise automatique après cooldown."
        elif ok_count:
            message = f"Préchargement France AROME partiel : {ok_count}/{unit_count} champ(s), {request_summary}."
        else:
            message = "Préchargement France AROME impossible : aucun champ national généré."
        return {
            "ok": bool(ok_count),
            "status": next((item.get("status") for item in results if item.get("status")), last_status),
            "message": message,
            "target": target,
            "scope": "national_day",
            "hours": hours,
            "hour_count": len(hours),
            "unit_count": unit_count,
            "unit_label": "champ(s)",
            "ok_count": ok_count,
            "completed_count": len(results),
            "pending_unit_count": max(0, unit_count - len(results)),
            "paused_for_quota": bool(quota_cooldown_seconds),
            "failed_count": len(failed_results),
            "failed_units": [
                {
                    "hour": item.get("hour"),
                    "field": item.get("field"),
                    "status": item.get("status"),
                    "message": item.get("message"),
                }
                for item in failed_results
            ],
            "quota_cooldown_seconds": quota_cooldown_seconds,
            "total_range_request_count": total_range_requests,
            "package_request_count": total_package_requests,
            "cached_total_range_request_count": cached_total_range_requests,
            "cached_package_request_count": cached_package_requests,
            "national_field_cache_hit_count": field_cache_hits,
            "decoded_field_count": decoded_fields,
            "elapsed_ms": elapsed_ms,
            "decoder": decoder,
            "results": results,
        }
    except Exception as exc:
        failure = _meteofrance_failure_result(exc, target)
        if isinstance(exc, urllib.error.HTTPError) and exc.code == 429:
            _set_meteofrance_quota_cooldown(api_key, METEOFRANCE_GRIB_PACKAGE_QUOTA_SCOPE, failure)
            failure["quota_cooldown_seconds"] = METEOFRANCE_QUOTA_COOLDOWN_SECONDS
            failure["quota_cooldown_scope"] = METEOFRANCE_GRIB_PACKAGE_QUOTA_SCOPE
        return failure


def _purge_finished_grib_auto_preload_jobs(now: float | None = None) -> None:
    now = time.time() if now is None else float(now)
    expired = [
        key
        for key, job in _grib_auto_preload_jobs.items()
        if not job.get("running") and now - float(job.get("finished_at") or job.get("started_at") or 0) > METEOFRANCE_GRIB_AUTO_PRELOAD_JOB_TTL_SECONDS
    ]
    for key in expired:
        _grib_auto_preload_jobs.pop(key, None)


def _format_grib_auto_preload_job(job_key: str, job: dict[str, Any]) -> dict[str, Any]:
    hours = [
        int(item)
        for item in job.get("hours", [])
        if isinstance(item, int) or (isinstance(item, str) and item.isdigit())
    ]
    results = list(job.get("results") or [])
    running = bool(job.get("running"))
    hour_count = int(job.get("hour_count") or len(hours) or 0)
    unit_count = int(job.get("unit_count") or hour_count or 0)
    completed_count = int(job.get("completed_count") or len(results) or 0)
    progress_count = unit_count or hour_count
    if not running and job.get("ok") and progress_count and completed_count == 0:
        completed_count = progress_count
    if progress_count:
        completed_count = max(0, min(progress_count, completed_count))
        percent = int(round((completed_count / progress_count) * 100))
    else:
        percent = 100 if not running and job.get("ok") else 0
    ok_count = int(job.get("ok_count") or sum(1 for item in results if item.get("ok")))
    failed_count = int(job.get("failed_count") or sum(1 for item in results if not item.get("ok")))
    last_result = job.get("last_result") or (results[-1] if results else None)
    failed_units = job.get("failed_units")
    if failed_units is None:
        failed_units = [
            {"hour": item.get("hour"), "field": item.get("field"), "message": item.get("message")}
            for item in results
            if not item.get("ok") and item.get("field") is not None
        ]
    started_at = job.get("started_at")
    finished_at = job.get("finished_at")
    elapsed_ms = None
    if started_at is not None:
        try:
            end_at = float(finished_at) if finished_at is not None else time.time()
            elapsed_ms = max(0, int((end_at - float(started_at)) * 1000))
        except (TypeError, ValueError):
            elapsed_ms = None
    return {
        "ok": True,
        "job_key": job_key,
        "running": running,
        "finished": bool(job.get("finished_at") or (not running and completed_count and progress_count and completed_count >= progress_count)),
        "from_cache": bool(job.get("from_cache")),
        "started_at": job.get("started_at"),
        "finished_at": job.get("finished_at"),
        "updated_at": job.get("updated_at"),
        "elapsed_ms": elapsed_ms,
        "date": job.get("date"),
        "hour": job.get("hour"),
        "detail_level": job.get("detail_level"),
        "scope": job.get("scope"),
        "package_only": bool(job.get("package_only")),
        "hours": hours,
        "cached_hours": job.get("cached_hours") or [],
        "missing_hours": job.get("missing_hours") or [],
        "target_hour_count": int(job.get("target_hour_count") or 0),
        "day_cache_complete": bool(job.get("day_cache_complete")),
        "coverage_before": job.get("coverage_before"),
        "coverage_after": job.get("coverage_after"),
        "hour_count": hour_count,
        "unit_count": unit_count,
        "unit_label": job.get("unit_label") or "heure(s)",
        "completed_count": completed_count,
        "ok_count": ok_count,
        "failed_count": failed_count,
        "current_hour": job.get("current_hour"),
        "current_index": job.get("current_index"),
        "current_field": job.get("current_field"),
        "percent": percent,
        "message": job.get("message"),
        "total_range_request_count": int(job.get("total_range_request_count") or 0),
        "package_request_count": int(job.get("package_request_count") or 0),
        "cached_total_range_request_count": int(job.get("cached_total_range_request_count") or 0),
        "cached_package_request_count": int(job.get("cached_package_request_count") or 0),
        "slot_grid_cache_hit_count": int(job.get("slot_grid_cache_hit_count") or 0),
        "national_field_cache_hit_count": int(job.get("national_field_cache_hit_count") or 0),
        "decoded_field_count": int(job.get("decoded_field_count") or 0),
        "materializing_slot_grids": bool(job.get("materializing_slot_grids")),
        "materialized_hour_count": int(job.get("materialized_hour_count") or 0),
        "materialization_failed_count": int(job.get("materialization_failed_count") or 0),
        "materialization_total_hours": int(job.get("materialization_total_hours") or 0),
        "materialization_range_request_count": int(job.get("materialization_range_request_count") or 0),
        "materialization_cached_range_request_count": int(job.get("materialization_cached_range_request_count") or 0),
        "materialization_current_hour": job.get("materialization_current_hour"),
        "materialization_result": job.get("materialization_result"),
        "precipitation_enrichment_running": bool(job.get("precipitation_enrichment_running")),
        "precipitation_enrichment_hours": job.get("precipitation_enrichment_hours") or [],
        "precipitation_enrichment_ok_count": int(job.get("precipitation_enrichment_ok_count") or 0),
        "precipitation_enrichment_unit_count": int(job.get("precipitation_enrichment_unit_count") or 0),
        "precipitation_enrichment_range_request_count": int(job.get("precipitation_enrichment_range_request_count") or 0),
        "precipitation_enrichment_result": job.get("precipitation_enrichment_result"),
        "precipitation_materialization_result": job.get("precipitation_materialization_result"),
        "quota_cooldown_seconds": job.get("quota_cooldown_seconds"),
        "failed_units": failed_units[:20] if isinstance(failed_units, list) else [],
        "last_result": last_result,
    }


def _grib_auto_preload_status(job_key: str) -> dict[str, Any]:
    with _grib_auto_preload_lock:
        _purge_finished_grib_auto_preload_jobs()
        job = copy.deepcopy(_grib_auto_preload_jobs.get(job_key))
    if not job:
        return {
            "ok": False,
            "status": 404,
            "job_key": job_key,
            "message": "Préchargement GRIB introuvable ou expiré.",
        }
    status = _format_grib_auto_preload_job(job_key, job)
    status["status"] = 200
    return status


def _run_meteofrance_grib_auto_preload_job(
    job_key: str,
    api_key: str,
    lat: float,
    lon: float,
    label: str,
    target_date: Date,
    hour: int,
    requested_grid: str | None,
    detail_level: str,
    scope: str = "time_group",
    max_hours: int = METEOFRANCE_GRIB_AUTO_PRELOAD_MAX_HOURS,
) -> None:
    def update_progress(update: dict[str, Any]) -> None:
        progress = copy.deepcopy(update)
        progress["updated_at"] = time.time()
        with _grib_auto_preload_lock:
            job = _grib_auto_preload_jobs.setdefault(job_key, {})
            job.update(progress)

    try:
        result = _preload_meteofrance_grib_slot_grids_sync(
            api_key,
            lat,
            lon,
            label,
            target_date,
            hour,
            requested_grid=requested_grid,
            detail_level=detail_level,
            scope=scope,
            max_hours=max_hours,
            progress_callback=update_progress,
        )
        with _grib_auto_preload_lock:
            job = _grib_auto_preload_jobs.setdefault(job_key, {})
            job.update(
                {
                    "running": False,
                    "finished_at": time.time(),
                    "updated_at": time.time(),
                    "ok": bool(result.get("ok")),
                    "message": result.get("message"),
                    "scope": result.get("scope") or scope,
                    "max_hours": max_hours,
                    "total_range_request_count": int(result.get("total_range_request_count") or 0),
                    "cached_total_range_request_count": int(result.get("cached_total_range_request_count") or 0),
                    "slot_grid_cache_hit_count": int(result.get("slot_grid_cache_hit_count") or 0),
                    "ok_count": int(result.get("ok_count") or 0),
                    "hour_count": int(result.get("hour_count") or 0),
                    "failed_count": int(result.get("failed_count") or 0),
                    "completed_count": int(result.get("hour_count") or 0),
                    "current_hour": None,
                    "current_index": None,
                    "quota_cooldown_seconds": result.get("quota_cooldown_seconds"),
                    "results": result.get("results") or [],
                    "failed_hours": result.get("failed_hours") or [],
                }
            )
            _purge_finished_grib_auto_preload_jobs()
    except Exception as exc:
        with _grib_auto_preload_lock:
            job = _grib_auto_preload_jobs.setdefault(job_key, {})
            job.update(
                {
                    "running": False,
                    "finished_at": time.time(),
                    "updated_at": time.time(),
                    "ok": False,
                    "message": f"Préchargement GRIB arrière-plan impossible : {exc}",
                }
            )
            _purge_finished_grib_auto_preload_jobs()


def _max_trigger_score_from_grib_payload(payload: dict[str, Any] | None) -> int:
    if not isinstance(payload, dict):
        return 0
    max_score = 0
    for day in payload.get("days", []) if isinstance(payload.get("days"), list) else []:
        for slot in day.get("slots", []) if isinstance(day, dict) else []:
            for cell in slot.get("cells", []) if isinstance(slot, dict) else []:
                if not isinstance(cell, dict):
                    continue
                try:
                    score = int(round(float(cell.get("trigger_score") if cell.get("trigger_score") is not None else cell.get("score_global") or 0)))
                except Exception:
                    score = 0
                max_score = max(max_score, score)
    return max_score


def _precipitation_enrichment_candidate_hours(materialization_result: dict[str, Any] | None) -> list[int]:
    if METEOFRANCE_PRECIPITATION_ENRICHMENT_MAX_HOURS <= 0:
        return []
    if not isinstance(materialization_result, dict):
        return []
    candidates = []
    for item in materialization_result.get("results", []) if isinstance(materialization_result.get("results"), list) else []:
        if not isinstance(item, dict) or not item.get("ok"):
            continue
        try:
            hour = int(item.get("hour"))
            score = int(item.get("max_trigger_score") or 0)
        except Exception:
            continue
        if 0 <= hour <= 23 and score >= METEOFRANCE_PRECIPITATION_ENRICHMENT_TRIGGER_THRESHOLD:
            candidates.append((score, hour))
    candidates.sort(key=lambda item: (-item[0], item[1]))
    selected = []
    seen = set()
    for _score, hour in candidates:
        if hour in seen:
            continue
        seen.add(hour)
        selected.append(hour)
        if len(selected) >= METEOFRANCE_PRECIPITATION_ENRICHMENT_MAX_HOURS:
            break
    return selected


def _preload_worker_materialize_slot(
    date_iso: str, hour: int, api_key: str, requested_grid: str | None, force_rebuild: bool,
    model: str | None = None,
) -> dict[str, Any]:
    """Exécuté dans un PROCESSUS worker (forkserver). Construit un créneau France depuis les
    champs nationaux déjà persistés sur disque (`cache_only`), écrit le résultat dans le cache
    disque + l'archive (effets de bord persistants), et ne renvoie qu'un RÉSUMÉ léger — pas le
    payload, trop gros pour l'IPC. Le worker réimporte `app` SANS déclencher les events startup
    (pas de uvicorn) → aucun thread d'automatisation ni serveur n'est lancé.
    Le modèle actif (AROME/ARPEGE) est un `contextvar` qui NE traverse PAS les processus : on le
    REDONNE explicitement ici, sinon un créneau ARPEGE chercherait le cache AROME et échouerait."""
    target_date = Date.fromisoformat(date_iso)
    with _nwp_model_context(model):
        result = _build_meteofrance_grib_france_slot_grid_sync(
            api_key, target_date, hour,
            requested_grid=requested_grid,
            detail_level=METEOFRANCE_SLOT_GRID_CORE_DETAIL,
            cache_only=True, force_rebuild=force_rebuild,
        )
    payload_data = result.get("payload") if isinstance(result.get("payload"), dict) else {}
    meta = payload_data.get("meta", {}) if isinstance(payload_data, dict) else {}
    return {
        "hour": hour,
        "ok": bool(result.get("ok")),
        "status": result.get("status"),
        "message": result.get("message"),
        "cache_hit": bool(result.get("cache_hit")),
        "total_range_request_count": int(meta.get("total_range_request_count") or result.get("total_range_request_count") or 0),
        "cached_total_range_request_count": int(meta.get("cached_total_range_request_count") or result.get("cached_total_range_request_count") or 0),
        "national_field_cache_hit_count": int(meta.get("national_field_cache_hit_count") or 0),
        "max_trigger_score": _max_trigger_score_from_grib_payload(payload_data),
    }


_preload_process_pool: "concurrent.futures.ProcessPoolExecutor | None" = None
_preload_process_pool_lock = threading.Lock()


def _get_preload_process_pool() -> "concurrent.futures.ProcessPoolExecutor | None":
    """Pool de processus (forkserver) partagé pour matérialiser les créneaux en parallèle.
    None si OBJECTIFOUDRE_PRELOAD_WORKERS <= 1 (séquentiel). forkserver = process neuf (pas un
    fork du parent multi-thread) → évite les deadlocks ; workers réutilisés entre les jours."""
    global _preload_process_pool
    if OBJECTIFOUDRE_PRELOAD_WORKERS <= 1:
        return None
    with _preload_process_pool_lock:
        if _preload_process_pool is None:
            try:
                _preload_process_pool = concurrent.futures.ProcessPoolExecutor(
                    max_workers=OBJECTIFOUDRE_PRELOAD_WORKERS,
                    mp_context=multiprocessing.get_context("forkserver"),
                )
            except Exception:
                _preload_process_pool = None
    return _preload_process_pool


def _reset_preload_process_pool() -> None:
    """Réinitialise le pool (ex. après un BrokenProcessPool) ; il sera recréé à la demande."""
    global _preload_process_pool
    with _preload_process_pool_lock:
        pool, _preload_process_pool = _preload_process_pool, None
    if pool is not None:
        try:
            pool.shutdown(wait=False, cancel_futures=True)
        except Exception:
            pass


def _materialize_meteofrance_grib_france_slot_grids_from_cache_sync(
    api_key: str,
    target_date: Date,
    requested_grid: str | None = None,
    hours: list[int] | None = None,
    progress_callback: Callable[[dict[str, Any]], None] | None = None,
    force_rebuild: bool = False,
) -> dict[str, Any]:
    started = time.time()
    target_hours = [int(hour) for hour in (hours if hours is not None else list(range(24))) if 0 <= int(hour) <= 23]
    results: list[dict[str, Any]] = []
    ok_count = 0
    failed_count = 0
    total_range = 0
    cached_range = 0
    national_hits = 0

    def push_progress(current_hour: int | None = None) -> None:
        if not progress_callback:
            return
        progress_callback(
            {
                "materializing_slot_grids": True,
                "materialized_hour_count": ok_count,
                "materialization_failed_count": failed_count,
                "materialization_total_hours": len(target_hours),
                "materialization_current_hour": current_hour,
                "materialization_results": copy.deepcopy(results[-12:]),
            }
        )

    def _accumulate(item: dict[str, Any]) -> None:
        nonlocal ok_count, failed_count, total_range, cached_range, national_hits
        total_range += int(item.get("total_range_request_count") or 0)
        cached_range += int(item.get("cached_total_range_request_count") or 0)
        national_hits += int(item.get("national_field_cache_hit_count") or 0)
        results.append({
            "hour": item.get("hour"),
            "ok": bool(item.get("ok")),
            "status": item.get("status"),
            "message": item.get("message"),
            "cache_hit": bool(item.get("cache_hit")),
            "total_range_request_count": int(item.get("total_range_request_count") or 0),
            "national_field_cache_hit_count": int(item.get("national_field_cache_hit_count") or 0),
            "max_trigger_score": item.get("max_trigger_score"),
        })
        if item.get("ok"):
            ok_count += 1
        else:
            failed_count += 1

    def _materialize_one_sync(hour: int) -> dict[str, Any]:
        result = _build_meteofrance_grib_france_slot_grid_sync(
            api_key, target_date, hour,
            requested_grid=requested_grid,
            detail_level=METEOFRANCE_SLOT_GRID_CORE_DETAIL,
            cache_only=True, force_rebuild=force_rebuild,
        )
        # Repli Range ciblé : si la matérialisation cache_only échoue car des messages GRIB
        # REQUIS ne sont pas dans les paquets téléchargés (package_only_miss — cause des ~19
        # échecs à froid quand les paquets ne sont que partiellement présents), on retente
        # CETTE heure en autorisant les requêtes Range ciblées (cache_only=False,
        # package_only=False) → ne récupère que les messages manquants. Sauté si le quota
        # AROME est en cooldown (le build gère aussi le cooldown en interne, double sécurité).
        if (
            not result.get("ok")
            and result.get("missing_fields")
            and _meteofrance_quota_cooldown_remaining(api_key, METEOFRANCE_GRIB_PACKAGE_QUOTA_SCOPE) <= 0
        ):
            range_result = _build_meteofrance_grib_france_slot_grid_sync(
                api_key, target_date, hour,
                requested_grid=requested_grid,
                detail_level=METEOFRANCE_SLOT_GRID_CORE_DETAIL,
                cache_only=False, force_rebuild=force_rebuild,
                package_only=False,
            )
            if range_result.get("ok"):
                result = range_result
        payload_data = result.get("payload") if isinstance(result.get("payload"), dict) else {}
        meta = payload_data.get("meta", {}) if isinstance(payload_data, dict) else {}
        return {
            "hour": hour,
            "ok": bool(result.get("ok")),
            "status": result.get("status"),
            "message": result.get("message"),
            "cache_hit": bool(result.get("cache_hit")),
            "total_range_request_count": int(meta.get("total_range_request_count") or result.get("total_range_request_count") or 0),
            "cached_total_range_request_count": int(meta.get("cached_total_range_request_count") or result.get("cached_total_range_request_count") or 0),
            "national_field_cache_hit_count": int(meta.get("national_field_cache_hit_count") or 0),
            "max_trigger_score": _max_trigger_score_from_grib_payload(payload_data),
        }

    # Parallèle (un processus par créneau, réutilisés) si OBJECTIFOUDRE_PRELOAD_WORKERS > 1 ;
    # sinon séquentiel. Tout échec d'infrastructure du pool → repli séquentiel propre.
    pool = _get_preload_process_pool() if len(target_hours) > 1 else None
    done_parallel = False
    if pool is not None:
        # Le modèle actif (contextvar) ne se propage pas aux processus → on le capture ici
        # pour le redonner à chaque worker (sinon ARPEGE échouerait en cherchant le cache AROME).
        active_model = _active_nwp_model()
        try:
            future_to_hour = {
                pool.submit(
                    _preload_worker_materialize_slot,
                    target_date.isoformat(), hour, api_key, requested_grid, force_rebuild, active_model,
                ): hour
                for hour in target_hours
            }
            retry_hours: list[int] = []
            for future in concurrent.futures.as_completed(future_to_hour):
                hour = future_to_hour[future]
                try:
                    item = future.result()
                except Exception:
                    item = None
                if item and item.get("ok"):
                    _accumulate(item)
                    push_progress(item.get("hour"))
                else:
                    retry_hours.append(hour)
            # Filet de sécurité : tout créneau non produit par un worker est réessayé EN
            # SÉQUENTIEL dans le parent (contexte modèle + caches mémoire corrects) → le
            # parallèle ne peut jamais faire pire que le séquentiel.
            for hour in sorted(retry_hours):
                push_progress(hour)
                _accumulate(_materialize_one_sync(hour))
                push_progress(hour)
            done_parallel = True
        except Exception:
            # Pool indisponible/cassé : on le réinitialise et on repart en séquentiel.
            _reset_preload_process_pool()
            results.clear()
            ok_count = failed_count = total_range = cached_range = national_hits = 0

    if not done_parallel:
        for hour in target_hours:
            push_progress(hour)
            _accumulate(_materialize_one_sync(hour))
            push_progress(hour)

    elapsed_ms = int((time.time() - started) * 1000)
    if ok_count == len(target_hours):
        message = f"Matérialisation grilles horaires France OK : {ok_count}/{len(target_hours)} heure(s)."
    elif ok_count:
        message = f"Matérialisation grilles horaires France partielle : {ok_count}/{len(target_hours)} heure(s)."
    else:
        message = "Matérialisation grilles horaires France impossible depuis le cache national."
    return {
        "ok": ok_count > 0,
        "message": message,
        "hours": target_hours,
        "hour_count": len(target_hours),
        "ok_count": ok_count,
        "failed_count": failed_count,
        "total_range_request_count": total_range,
        "cached_total_range_request_count": cached_range,
        "national_field_cache_hit_count": national_hits,
        "elapsed_ms": elapsed_ms,
        "results": results,
    }


def _run_meteofrance_grib_national_day_preload_job(
    job_key: str,
    api_key: str,
    target_date: Date,
    requested_grid: str | None,
    max_hours: int = 24,
    hours: list[int] | None = None,
    force_rebuild: bool = False,
    model: str = DEFAULT_NWP_MODEL,
) -> None:
    def update_progress(update: dict[str, Any]) -> None:
        progress = copy.deepcopy(update)
        progress["updated_at"] = time.time()
        with _grib_auto_preload_lock:
            job = _grib_auto_preload_jobs.setdefault(job_key, {})
            job.update(progress)

    # Le job tourne dans un thread créé à la main : les contextvars ne se propagent
    # pas, on re-pose explicitement le modèle capturé au moment du scheduling.
    with _nwp_model_context(model):
        _run_meteofrance_grib_national_day_preload_job_inner(
            job_key, api_key, target_date, requested_grid, max_hours, hours, force_rebuild, update_progress
        )


def _run_meteofrance_grib_national_day_preload_job_inner(
    job_key: str,
    api_key: str,
    target_date: Date,
    requested_grid: str | None,
    max_hours: int,
    hours: list[int] | None,
    force_rebuild: bool,
    update_progress: Callable[[dict[str, Any]], None],
) -> None:
    try:
        result = _preload_meteofrance_grib_national_day_sync(
            api_key,
            target_date,
            requested_grid=requested_grid,
            max_hours=max_hours,
            hours_override=hours,
            progress_callback=update_progress,
            force_refresh_run_metadata=False,
        )
        materialization_result = None
        precipitation_enrichment_result = None
        precipitation_materialization_result = None
        precipitation_enrichment_hours: list[int] = []
        preload_ok_count = int(result.get("ok_count") or 0)
        preload_paused_for_quota = bool(result.get("quota_cooldown_seconds") or result.get("paused_for_quota"))
        can_materialize_slots = preload_ok_count > 0 and not preload_paused_for_quota
        if can_materialize_slots:
            update_progress(
                {
                    "materializing_slot_grids": True,
                    "materialized_hour_count": 0,
                    "materialization_failed_count": 0,
                    "materialization_total_hours": int(result.get("hour_count") or max_hours),
                    "message": "Matérialisation des grilles horaires France depuis le cache national…",
                }
            )
            materialization_result = _materialize_meteofrance_grib_france_slot_grids_from_cache_sync(
                api_key,
                target_date,
                requested_grid=requested_grid,
                hours=[int(item) for item in (result.get("hours") or list(range(max_hours)))],
                progress_callback=update_progress,
                force_rebuild=force_rebuild,
            )
            if materialization_result.get("message"):
                result["message"] = f"{result.get('message') or 'Préchargement France AROME terminé.'} {materialization_result['message']}"

            precipitation_enrichment_hours = _precipitation_enrichment_candidate_hours(materialization_result)
            if precipitation_enrichment_hours:
                update_progress(
                    {
                        "precipitation_enrichment_running": True,
                        "precipitation_enrichment_hours": precipitation_enrichment_hours,
                        "precipitation_enrichment_total_hours": len(precipitation_enrichment_hours),
                        "message": f"Complément précipitation ciblé sur {len(precipitation_enrichment_hours)} heure(s)…",
                    }
                )
                precipitation_enrichment_result = _preload_meteofrance_grib_national_day_sync(
                    api_key,
                    target_date,
                    requested_grid=requested_grid,
                    max_hours=len(precipitation_enrichment_hours),
                    hours_override=precipitation_enrichment_hours,
                    field_names={METEOFRANCE_PRECIPITATION_ENRICHMENT_FIELD},
                    progress_callback=None,
                    progress_scope="national_precipitation",
                )
                if precipitation_enrichment_result.get("ok"):
                    precipitation_materialization_result = _materialize_meteofrance_grib_france_slot_grids_from_cache_sync(
                        api_key,
                        target_date,
                        requested_grid=requested_grid,
                        hours=precipitation_enrichment_hours,
                        progress_callback=None,
                        force_rebuild=True,
                    )
                rain_ok = int((precipitation_enrichment_result or {}).get("ok_count") or 0)
                rain_total = int((precipitation_enrichment_result or {}).get("unit_count") or len(precipitation_enrichment_hours))
                rain_range = int((precipitation_enrichment_result or {}).get("total_range_request_count") or 0)
                rain_text = f" Précipitation ciblée : {rain_ok}/{rain_total} champ(s), {rain_range} Range API."
                if (precipitation_enrichment_result or {}).get("quota_cooldown_seconds"):
                    rain_text += " Enrichissement précipitation suspendu par cooldown quota."
                result["message"] = f"{result.get('message') or 'Préchargement France AROME terminé.'}{rain_text}"
        coverage_after = _server_arome_cache_coverage(api_key, target_date, requested_grid)
        with _grib_auto_preload_lock:
            job = _grib_auto_preload_jobs.setdefault(job_key, {})
            job.update(
                {
                    "running": False,
                    "finished_at": time.time(),
                    "updated_at": time.time(),
                    "ok": bool(result.get("ok")),
                    "message": result.get("message"),
                    "scope": "national_day",
                    "max_hours": max_hours,
                    "hours": result.get("hours") or list(range(max_hours)),
                    "hour_count": int(result.get("hour_count") or max_hours),
                    "unit_count": int(result.get("unit_count") or 0),
                    "unit_label": result.get("unit_label") or "champ(s)",
                    "completed_count": int(result.get("completed_count") or len(result.get("results") or []) or 0),
                    "pending_unit_count": int(result.get("pending_unit_count") or 0),
                    "paused_for_quota": bool(result.get("paused_for_quota")),
                    "package_only": bool(result.get("package_only") or METEOFRANCE_GRIB_PACKAGE_ONLY_NATIONAL_PRELOAD),
                    "total_range_request_count": int(result.get("total_range_request_count") or 0),
                    "cached_total_range_request_count": int(result.get("cached_total_range_request_count") or 0),
                    "national_field_cache_hit_count": int(result.get("national_field_cache_hit_count") or 0),
                    "decoded_field_count": int(result.get("decoded_field_count") or 0),
                    "materializing_slot_grids": False,
                    "materialized_hour_count": int((materialization_result or {}).get("ok_count") or 0),
                    "materialization_failed_count": int((materialization_result or {}).get("failed_count") or 0),
                    "materialization_total_hours": int((materialization_result or {}).get("hour_count") or 0),
                    "materialization_range_request_count": int((materialization_result or {}).get("total_range_request_count") or 0),
                    "materialization_cached_range_request_count": int((materialization_result or {}).get("cached_total_range_request_count") or 0),
                    "materialization_result": materialization_result,
                    "coverage_after": coverage_after,
                    "cached_hours": coverage_after.get("cached_hours") or [],
                    "missing_hours": coverage_after.get("missing_hours") or [],
                    "target_hour_count": int(coverage_after.get("hour_count") or 24),
                    "day_cache_complete": bool(coverage_after.get("complete")),
                    "precipitation_enrichment_running": False,
                    "precipitation_enrichment_hours": precipitation_enrichment_hours,
                    "precipitation_enrichment_result": precipitation_enrichment_result,
                    "precipitation_materialization_result": precipitation_materialization_result,
                    "precipitation_enrichment_ok_count": int((precipitation_enrichment_result or {}).get("ok_count") or 0),
                    "precipitation_enrichment_unit_count": int((precipitation_enrichment_result or {}).get("unit_count") or 0),
                    "precipitation_enrichment_range_request_count": int((precipitation_enrichment_result or {}).get("total_range_request_count") or 0),
                    "ok_count": int(result.get("ok_count") or 0),
                    "failed_count": int(result.get("failed_count") or 0),
                    "current_hour": None,
                    "current_index": None,
                    "current_field": None,
                    "quota_cooldown_seconds": result.get("quota_cooldown_seconds"),
                    "results": result.get("results") or [],
                    "failed_units": result.get("failed_units") or [],
                }
            )
            _purge_finished_grib_auto_preload_jobs()
    except Exception as exc:
        with _grib_auto_preload_lock:
            job = _grib_auto_preload_jobs.setdefault(job_key, {})
            job.update(
                {
                    "running": False,
                    "finished_at": time.time(),
                    "updated_at": time.time(),
                    "ok": False,
                    "message": f"Préchargement France AROME arrière-plan impossible : {exc}",
                }
            )
            _purge_finished_grib_auto_preload_jobs()


def _schedule_meteofrance_grib_national_day_preload(
    background_tasks: BackgroundTasks | None,
    api_key: str,
    target_date: Date,
    requested_grid: str | None,
    *,
    force_rebuild: bool = False,
    allowed_hours: list[int] | None = None,
) -> dict[str, Any]:
    all_hours = sorted({int(item) for item in (allowed_hours if allowed_hours is not None else list(range(24))) if 0 <= int(item) <= 23})
    active_specs = [spec for spec in _nwp_slot_grid_specs() if spec.get("required")]
    if not all_hours:
        return {
            "scheduled": False,
            "already_running": False,
            "already_done": False,
            "scope": "national_day",
            "max_hours": 0,
            "hours": [],
            "message": f"Aucune échéance AROME publiée pour {target_date.isoformat()}.",
        }
    job_key = _meteofrance_grib_national_preload_job_key(api_key, requested_grid, target_date)
    with _grib_auto_preload_lock:
        _purge_finished_grib_auto_preload_jobs()
        existing = _grib_auto_preload_jobs.get(job_key)
        if existing and existing.get("running"):
            running_hours = [int(item) for item in (existing.get("hours") or all_hours) if 0 <= int(item) <= 23]
            running_unit_count = int(existing.get("unit_count") or (len(running_hours) * len(active_specs)))
            return {
                "scheduled": False,
                "already_running": True,
                "job_key": job_key,
                "scope": "national_day",
                "max_hours": len(running_hours) or 24,
                "hours": running_hours,
                "unit_count": running_unit_count,
                "unit_label": "champ(s)",
                "progress": _format_grib_auto_preload_job(job_key, existing),
            }

        cache_coverage = _meteofrance_grib_france_slot_grid_cache_coverage(
            api_key,
            requested_grid,
            target_date,
            all_hours,
            METEOFRANCE_SLOT_GRID_CORE_DETAIL,
        )
        cached_hours = [int(item) for item in (cache_coverage.get('cached_hours') or []) if 0 <= int(item) <= 23]
        missing_hours = [int(item) for item in (cache_coverage.get('missing_hours') or []) if 0 <= int(item) <= 23]
        if cache_coverage.get('complete') and not force_rebuild:
            unit_count = len(all_hours) * len(active_specs)
            now = time.time()
            _grib_auto_preload_jobs[job_key] = {
                'running': False,
                'started_at': now,
                'finished_at': now,
                'updated_at': now,
                'ok': True,
                'from_cache': True,
                'hour': 0,
                'date': target_date.isoformat(),
                'detail_level': METEOFRANCE_SLOT_GRID_CORE_DETAIL,
                'scope': 'national_day',
                'max_hours': 24,
                'hours': all_hours,
                'hour_count': len(all_hours),
                'unit_count': unit_count,
                'unit_label': 'champ(s)',
                'completed_count': unit_count,
                'ok_count': unit_count,
                'failed_count': 0,
                'total_range_request_count': 0,
                'cached_total_range_request_count': cache_coverage.get('cached_total_range_request_count'),
                'national_field_cache_hit_count': 0,
                'decoded_field_count': 0,
                'coverage_before': cache_coverage,
                'coverage_after': cache_coverage,
                'message': 'Préchargement France AROME déjà disponible dans le cache serveur.',
            }
            progress = _format_grib_auto_preload_job(job_key, _grib_auto_preload_jobs[job_key])
            return {
                'scheduled': False,
                'already_running': False,
                'already_done': True,
                'already_cached': True,
                'job_key': job_key,
                'scope': 'national_day',
                'max_hours': 24,
                'hours': all_hours,
                'cached_hours': cached_hours,
                'missing_hours': [],
                'ok_count': unit_count,
                'hour_count': len(all_hours),
                'unit_count': unit_count,
                'unit_label': 'champ(s)',
                'total_range_request_count': 0,
                'cached_total_range_request_count': cache_coverage.get('cached_total_range_request_count'),
                'coverage': cache_coverage,
                'progress': progress,
            }

        hours = all_hours if force_rebuild else (missing_hours if missing_hours else all_hours)
        max_hours = len(hours) or 24
        unit_count = len(hours) * len(active_specs)

        existing_unit_count = int(existing.get("unit_count") or unit_count) if existing else unit_count
        existing_ok_count = int(existing.get("ok_count") or 0) if existing else 0
        existing_failed_count = int(existing.get("failed_count") or 0) if existing else 0
        if existing and existing.get("ok") and existing_unit_count > 0 and existing_ok_count >= existing_unit_count and existing_failed_count == 0:
            # A previous job may have completed only the then-missing subset. Trust the
            # coverage check above for the full day; if it is still incomplete, resume
            # only the hours still absent instead of returning already_done.
            existing = None

        cooldown = _meteofrance_quota_cooldown_result(
            api_key,
            METEOFRANCE_GRIB_PACKAGE_QUOTA_SCOPE,
            "AROME Paquet Modèles GRIB préchargement France",
            "préchargement France GRIB",
        )
        if cooldown:
            progress = _format_grib_auto_preload_job(job_key, existing) if existing else {
                "ok": True,
                "job_key": job_key,
                "running": False,
                "finished": False,
                "scope": "national_day",
                "hours": hours,
                "hour_count": len(hours),
                "unit_count": unit_count,
                "unit_label": "champ(s)",
                "completed_count": 0,
                "ok_count": 0,
                "failed_count": 0,
                "percent": 0,
                "message": cooldown.get("message"),
                "quota_cooldown_seconds": cooldown.get("quota_cooldown_seconds"),
            }
            return {
                "scheduled": False,
                "already_running": False,
                "already_done": False,
                "quota_cooldown": True,
                "job_key": job_key,
                "scope": "national_day",
                "max_hours": max_hours,
                "hours": hours,
                "cached_hours": cached_hours,
                "missing_hours": missing_hours,
                "unit_count": unit_count,
                "unit_label": "champ(s)",
                "status": cooldown.get("status"),
                "message": cooldown.get("message"),
                "quota_cooldown_seconds": cooldown.get("quota_cooldown_seconds"),
                "quota_cooldown_scope": cooldown.get("quota_cooldown_scope"),
                "coverage": cache_coverage,
                "progress": progress,
            }
        _grib_auto_preload_jobs[job_key] = {
            "running": True,
            "started_at": time.time(),
            "updated_at": time.time(),
            "hour": hours[0] if hours else 0,
            "date": target_date.isoformat(),
            "detail_level": METEOFRANCE_SLOT_GRID_CORE_DETAIL,
            "scope": "national_day",
            "max_hours": max_hours,
            "hours": hours,
            "cached_hours": cached_hours,
            "missing_hours": missing_hours,
            "coverage_before": cache_coverage,
            "hour_count": len(hours),
            "target_hour_count": len(all_hours),
            "unit_count": unit_count,
            "unit_label": "champ(s)",
            "completed_count": 0,
            "ok_count": 0,
            "failed_count": 0,
            "total_range_request_count": 0,
            "cached_total_range_request_count": 0,
            "national_field_cache_hit_count": 0,
            "decoded_field_count": 0,
            "current_hour": hours[0] if hours else None,
            "current_index": 0,
            "current_field": active_specs[0]["field"] if active_specs else None,
            "force_rebuild": bool(force_rebuild),
            "package_only": bool(METEOFRANCE_GRIB_PACKAGE_ONLY_NATIONAL_PRELOAD),
            "message": (
                "Préchargement France AROME : nouveau run API, reconstruction complète."
                if force_rebuild
                else (
                    f"Préchargement France AROME : reprise sur {len(hours)} heure(s) manquante(s)."
                    if cached_hours
                    else "Préchargement France AROME : journée complète."
                )
            ),
            "results": [],
        }
        progress = _format_grib_auto_preload_job(job_key, _grib_auto_preload_jobs[job_key])
    job_model = _active_nwp_model()
    if background_tasks is not None:
        background_tasks.add_task(
            _run_meteofrance_grib_national_day_preload_job,
            job_key,
            api_key,
            target_date,
            requested_grid,
            max_hours,
            hours,
            force_rebuild,
            job_model,
        )
    else:
        thread = threading.Thread(
            target=_run_meteofrance_grib_national_day_preload_job,
            args=(job_key, api_key, target_date, requested_grid, max_hours, hours, force_rebuild, job_model),
            daemon=True,
            name=f"objectifoudre-{job_model}-france-{target_date.isoformat()}",
        )
        thread.start()
    return {
        "scheduled": True,
        "already_running": False,
        "job_key": job_key,
        "scope": "national_day",
        "max_hours": max_hours,
        "hours": hours,
        "cached_hours": cached_hours,
        "missing_hours": missing_hours,
        "unit_count": unit_count,
        "unit_label": "champ(s)",
        "force_rebuild": bool(force_rebuild),
        "coverage": cache_coverage,
        "progress": progress,
    }

def _schedule_meteofrance_grib_day_preload(
    background_tasks: BackgroundTasks,
    api_key: str,
    lat: float,
    lon: float,
    label: str,
    target_date: Date,
    hour: int,
    requested_grid: str | None,
    detail_level: str,
) -> dict[str, Any]:
    detail_level = METEOFRANCE_SLOT_GRID_CORE_DETAIL
    max_hours = 24
    hours = list(range(24))
    job_key = _meteofrance_grib_auto_preload_job_key(
        api_key,
        requested_grid,
        lat,
        lon,
        label,
        target_date,
        hour,
        detail_level,
        block_key="day-00-23",
    )
    with _grib_auto_preload_lock:
        _purge_finished_grib_auto_preload_jobs()
        existing = _grib_auto_preload_jobs.get(job_key)
        if existing and existing.get("running"):
            return {
                "scheduled": False,
                "already_running": True,
                "job_key": job_key,
                "scope": "day",
                "max_hours": max_hours,
                "hours": hours,
                "progress": _format_grib_auto_preload_job(job_key, existing),
            }
        if existing and existing.get("ok"):
            return {
                "scheduled": False,
                "already_running": False,
                "already_done": True,
                "job_key": job_key,
                "scope": "day",
                "max_hours": max_hours,
                "hours": hours,
                "ok_count": existing.get("ok_count"),
                "hour_count": existing.get("hour_count"),
                "total_range_request_count": existing.get("total_range_request_count"),
                "cached_total_range_request_count": existing.get("cached_total_range_request_count"),
                "progress": _format_grib_auto_preload_job(job_key, existing),
            }
        cache_coverage = _meteofrance_grib_slot_grid_cache_coverage(
            api_key,
            requested_grid,
            lat,
            lon,
            label,
            target_date,
            hours,
            detail_level,
        )
        if cache_coverage.get("complete"):
            now = time.time()
            _grib_auto_preload_jobs[job_key] = {
                "running": False,
                "started_at": now,
                "finished_at": now,
                "ok": True,
                "from_cache": True,
                "hour": int(hour),
                "date": target_date.isoformat(),
                "detail_level": detail_level,
                "scope": "day",
                "max_hours": max_hours,
                "hours": hours,
                "ok_count": cache_coverage.get("ok_count"),
                "hour_count": cache_coverage.get("hour_count"),
                "total_range_request_count": 0,
                "cached_total_range_request_count": cache_coverage.get("cached_total_range_request_count"),
            }
            progress = _format_grib_auto_preload_job(job_key, _grib_auto_preload_jobs[job_key])
            return {
                "scheduled": False,
                "already_running": False,
                "already_done": True,
                "already_cached": True,
                "job_key": job_key,
                "scope": "day",
                "max_hours": max_hours,
                "hours": hours,
                "ok_count": cache_coverage.get("ok_count"),
                "hour_count": cache_coverage.get("hour_count"),
                "total_range_request_count": 0,
                "cached_total_range_request_count": cache_coverage.get("cached_total_range_request_count"),
                "progress": progress,
            }
        _grib_auto_preload_jobs[job_key] = {
            "running": True,
            "started_at": time.time(),
            "updated_at": time.time(),
            "hour": int(hour),
            "date": target_date.isoformat(),
            "detail_level": detail_level,
            "scope": "day",
            "max_hours": max_hours,
            "hours": hours,
            "hour_count": len(hours),
            "completed_count": 0,
            "ok_count": 0,
            "failed_count": 0,
            "total_range_request_count": 0,
            "cached_total_range_request_count": 0,
            "slot_grid_cache_hit_count": 0,
            "current_hour": hours[0],
            "current_index": 0,
            "results": [],
        }
        progress = _format_grib_auto_preload_job(job_key, _grib_auto_preload_jobs[job_key])
    background_tasks.add_task(
        _run_meteofrance_grib_auto_preload_job,
        job_key,
        api_key,
        lat,
        lon,
        label,
        target_date,
        hour,
        requested_grid,
        detail_level,
        "day",
        max_hours,
    )
    return {
        "scheduled": True,
        "already_running": False,
        "job_key": job_key,
        "scope": "day",
        "max_hours": max_hours,
        "hours": hours,
        "progress": progress,
    }


def _schedule_meteofrance_grib_auto_preload(
    background_tasks: BackgroundTasks,
    api_key: str,
    lat: float,
    lon: float,
    label: str,
    target_date: Date,
    hour: int,
    requested_grid: str | None,
    detail_level: str,
    time_target: dict[str, Any] | None = None,
) -> dict[str, Any]:
    detail_level = METEOFRANCE_SLOT_GRID_CORE_DETAIL
    block_hours = _meteofrance_grib_local_hours_for_time_group(time_target or {}, hour)
    block_key = ",".join(str(item) for item in block_hours)
    job_key = _meteofrance_grib_auto_preload_job_key(
        api_key,
        requested_grid,
        lat,
        lon,
        label,
        target_date,
        hour,
        detail_level,
        block_key=block_key,
    )
    with _grib_auto_preload_lock:
        _purge_finished_grib_auto_preload_jobs()
        existing = _grib_auto_preload_jobs.get(job_key)
        if existing and existing.get("running"):
            return {
                "scheduled": False,
                "already_running": True,
                "job_key": job_key,
                "scope": "time_group",
                "max_hours": METEOFRANCE_GRIB_AUTO_PRELOAD_MAX_HOURS,
                "hours": block_hours,
                "progress": _format_grib_auto_preload_job(job_key, existing),
            }
        if existing and existing.get("ok"):
            return {
                "scheduled": False,
                "already_running": False,
                "already_done": True,
                "job_key": job_key,
                "scope": "time_group",
                "max_hours": METEOFRANCE_GRIB_AUTO_PRELOAD_MAX_HOURS,
                "hours": block_hours,
                "ok_count": existing.get("ok_count"),
                "hour_count": existing.get("hour_count"),
                "total_range_request_count": existing.get("total_range_request_count"),
                "cached_total_range_request_count": existing.get("cached_total_range_request_count"),
                "progress": _format_grib_auto_preload_job(job_key, existing),
            }
        cache_coverage = _meteofrance_grib_slot_grid_cache_coverage(
            api_key,
            requested_grid,
            lat,
            lon,
            label,
            target_date,
            block_hours,
            detail_level,
        )
        if cache_coverage.get("complete"):
            now = time.time()
            _grib_auto_preload_jobs[job_key] = {
                "running": False,
                "started_at": now,
                "finished_at": now,
                "ok": True,
                "from_cache": True,
                "hour": int(hour),
                "date": target_date.isoformat(),
                "detail_level": detail_level,
                "scope": "time_group",
                "max_hours": METEOFRANCE_GRIB_AUTO_PRELOAD_MAX_HOURS,
                "hours": block_hours,
                "ok_count": cache_coverage.get("ok_count"),
                "hour_count": cache_coverage.get("hour_count"),
                "total_range_request_count": 0,
                "cached_total_range_request_count": cache_coverage.get("cached_total_range_request_count"),
            }
            progress = _format_grib_auto_preload_job(job_key, _grib_auto_preload_jobs[job_key])
            return {
                "scheduled": False,
                "already_running": False,
                "already_done": True,
                "already_cached": True,
                "job_key": job_key,
                "scope": "time_group",
                "max_hours": METEOFRANCE_GRIB_AUTO_PRELOAD_MAX_HOURS,
                "hours": block_hours,
                "ok_count": cache_coverage.get("ok_count"),
                "hour_count": cache_coverage.get("hour_count"),
                "total_range_request_count": 0,
                "cached_total_range_request_count": cache_coverage.get("cached_total_range_request_count"),
                "progress": progress,
            }
        _grib_auto_preload_jobs[job_key] = {
            "running": True,
            "started_at": time.time(),
            "updated_at": time.time(),
            "hour": int(hour),
            "date": target_date.isoformat(),
            "detail_level": detail_level,
            "scope": "time_group",
            "max_hours": METEOFRANCE_GRIB_AUTO_PRELOAD_MAX_HOURS,
            "hours": block_hours,
            "hour_count": len(block_hours),
            "completed_count": 0,
            "ok_count": 0,
            "failed_count": 0,
            "total_range_request_count": 0,
            "cached_total_range_request_count": 0,
            "slot_grid_cache_hit_count": 0,
            "current_hour": block_hours[0] if block_hours else None,
            "current_index": 0 if block_hours else None,
            "results": [],
        }
        progress = _format_grib_auto_preload_job(job_key, _grib_auto_preload_jobs[job_key])
    background_tasks.add_task(
        _run_meteofrance_grib_auto_preload_job,
        job_key,
        api_key,
        lat,
        lon,
        label,
        target_date,
        hour,
        requested_grid,
        detail_level,
    )
    return {
        "scheduled": True,
        "already_running": False,
        "job_key": job_key,
        "scope": "time_group",
        "max_hours": METEOFRANCE_GRIB_AUTO_PRELOAD_MAX_HOURS,
        "hours": block_hours,
        "progress": progress,
    }


def _server_meteofrance_api_key() -> str | None:
    raw_key = (
        os.environ.get("METEOFRANCE_API_KEY")
        or os.environ.get("METEOFRANCE_API_TOKEN")
        or os.environ.get("METEOFRANCE_TOKEN")
    )
    if not raw_key:
        return None
    try:
        return _clean_meteofrance_api_key(raw_key)
    except HTTPException:
        return None


def _server_meteofrance_api_key_required() -> str:
    api_key = _server_meteofrance_api_key()
    if not api_key:
        raise HTTPException(
            status_code=400,
            detail="Clé API Météo-France serveur absente. Définis METEOFRANCE_API_KEY ou METEOFRANCE_API_TOKEN.",
        )
    return api_key


def _server_nwp_api_key(model: str = DEFAULT_NWP_MODEL) -> str | None:
    """Clé API serveur pour un modèle du registre : variables d'environnement du
    modèle d'abord, puis fichier local à côté d'app.py (dev) si déclaré. AROME
    reste env-only (comportement historique inchangé)."""
    spec = _nwp_model_spec(model)
    for env_name in spec.get("api_key_env_vars") or ():
        raw_key = os.environ.get(env_name)
        if raw_key:
            try:
                return _clean_meteofrance_api_key(raw_key)
            except HTTPException:
                continue
    file_name = spec.get("api_key_file")
    if file_name:
        path = os.path.join(os.path.dirname(os.path.abspath(__file__)), file_name)
        try:
            with open(path, encoding="utf-8") as handle:
                raw_key = handle.read().strip()
        except OSError:
            return None
        if raw_key:
            try:
                return _clean_meteofrance_api_key(raw_key)
            except HTTPException:
                return None
    return None


def _nwp_api_key_for_request(model: str, token: str | None) -> str:
    """Clé API pour une requête front : le token explicite du client gagne, sinon la
    clé serveur du modèle (les clés de cache d'un modèle sont dérivées de SA clé)."""
    if token and token.strip():
        return _clean_meteofrance_api_key(token)
    api_key = _server_nwp_api_key(model)
    if api_key:
        return api_key
    if model == DEFAULT_NWP_MODEL:
        return _server_meteofrance_api_key_required()
    raise HTTPException(
        status_code=400,
        detail=f"Clé API Météo-France serveur absente pour le modèle {model.upper()}.",
    )


def _validate_server_preload_secret(secret: str | None) -> None:
    expected = os.environ.get("OBJECTIFOUDRE_PRELOAD_SECRET")
    if expected and secret != expected:
        raise HTTPException(status_code=403, detail="Secret de préchargement serveur invalide.")



def _validate_server_admin_secret(secret: str) -> None:
    expected = os.environ.get('OBJECTIFOUDRE_PRELOAD_SECRET')
    if not expected:
        raise HTTPException(
            status_code=403,
            detail='Commande serveur desactivee : definis OBJECTIFOUDRE_PRELOAD_SECRET pour activer ce pilotage.',
        )
    if secret != expected:
        raise HTTPException(status_code=403, detail='Secret de prechargement serveur invalide.')


def _server_arome_preload_dates(reference_date: Date | None = None, raw_value: str | None = None) -> list[Date]:
    today = reference_date or datetime.now(OBJECTIFOUDRE_SERVER_TIMEZONE).date()
    source = raw_value if raw_value is not None else OBJECTIFOUDRE_AUTO_PRELOAD_DAYS
    raw_tokens = [item.strip() for item in source.split(",") if item.strip()]
    if not raw_tokens:
        raw_tokens = ["today", "tomorrow"]
    aliases = {
        "yesterday": -1,
        "veille": -1,
        "previous": -1,
        "today": 0,
        "now": 0,
        "aujourdhui": 0,
        "tomorrow": 1,
        "demain": 1,
        "dayaftertomorrow": 2,
        "day_after_tomorrow": 2,
        "aftertomorrow": 2,
        "apresdemain": 2,
        "j+2": 2,
        "j2": 2,
        "j+3": 3,
        "j3": 3,
        "j+4": 4,
        "j4": 4,
    }
    dates: list[Date] = []
    seen: set[str] = set()
    for token in raw_tokens:
        normalized = unicodedata.normalize("NFKD", token.lower()).encode("ascii", "ignore").decode("ascii")
        normalized = normalized.replace("'", "").replace(" ", "")
        if normalized in aliases:
            target_date = today + timedelta(days=aliases[normalized])
        else:
            try:
                target_date = Date.fromisoformat(token)
            except ValueError:
                continue
        key = target_date.isoformat()
        if key not in seen:
            seen.add(key)
            dates.append(target_date)
    return dates


def _server_arpege_preload_dates(reference_date: Date | None = None) -> list[Date]:
    """Jours préchargés via ARPEGE : à partir de J+2 (offset == horizon AROME), là où
    AROME ne couvre plus toute la journée. On exclut J-1..J+1 (AROME complet)."""
    raw = OBJECTIFOUDRE_AUTO_PRELOAD_ARPEGE_DAYS.strip()
    if not raw:
        return []
    today = reference_date or datetime.now(OBJECTIFOUDRE_SERVER_TIMEZONE).date()
    arome_max = int(_nwp_model_spec("arome").get("max_days_ahead") or 2)
    out: list[Date] = []
    seen: set[str] = set()
    for item in _server_arome_preload_dates(reference_date, raw_value=raw):
        if (item - today).days < arome_max:
            continue
        key = item.isoformat()
        if key not in seen:
            seen.add(key)
            out.append(item)
    return out


def _server_arome_cache_coverage(
    api_key: str,
    target_date: Date,
    requested_grid: str | None = None,
    availability_reference_time: str | None = None,
) -> dict[str, Any]:
    all_hours = list(range(24))
    full_coverage = _meteofrance_grib_france_slot_grid_cache_coverage(
        api_key,
        requested_grid,
        target_date,
        all_hours,
        METEOFRANCE_SLOT_GRID_CORE_DETAIL,
    )
    cached_hours = sorted({int(item) for item in (full_coverage.get('cached_hours') or []) if 0 <= int(item) <= 23})
    availability = _server_arome_available_hours_for_date(target_date, availability_reference_time, cached_hours)
    available_hours = [int(item) for item in (availability.get('available_hours') or all_hours) if 0 <= int(item) <= 23]
    cached_available_hours = [hour for hour in available_hours if hour in cached_hours]
    missing_hours = [hour for hour in available_hours if hour not in cached_hours]
    cached_run_reference_time = _server_arome_cached_run_reference(api_key, target_date, requested_grid)
    return {
        'date': target_date.isoformat(),
        'complete': bool(available_hours) and not missing_hours,
        'partial_availability': len(available_hours) < 24,
        'available_hours': available_hours,
        'unavailable_hours': availability.get('unavailable_hours') or [],
        'availability_reference_time': availability.get('reference_time'),
        'availability_until': availability.get('available_until'),
        'availability_source': availability.get('source'),
        'forecast_horizon_hours': availability.get('forecast_horizon_hours'),
        'cached_hours': cached_hours,
        'cached_available_hours': cached_available_hours,
        'missing_hours': missing_hours,
        'ok_count': len(cached_available_hours),
        'hour_count': len(available_hours),
        'calendar_hour_count': 24,
        'cached_total_range_request_count': int(full_coverage.get('cached_total_range_request_count') or 0),
        'cached_api_run_reference_time': cached_run_reference_time,
    }


def _server_arome_normalize_reference_time(value: str | None) -> str | None:
    dt = _parse_meteofrance_datetime(value)
    if dt is None:
        return None
    return dt.astimezone(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")


def _server_arome_reference_epoch(value: str | None) -> float | None:
    dt = _parse_meteofrance_datetime(value)
    if dt is None:
        return None
    return dt.astimezone(timezone.utc).timestamp()


def _server_arome_run_reference_from_meta(meta: dict[str, Any] | None) -> str | None:
    if not isinstance(meta, dict):
        return None
    refs: list[str] = []

    def add(value: Any) -> None:
        normalized = _server_arome_normalize_reference_time(str(value or ""))
        if normalized:
            refs.append(normalized)

    add(meta.get("arome_run_latest_reference_time"))
    add(meta.get("arome_run_api_updated_at"))
    for value in meta.get("arome_run_reference_times") or []:
        add(value)
    time_targets = meta.get("time_targets")
    if isinstance(time_targets, dict):
        for target in time_targets.values():
            if isinstance(target, dict):
                add(target.get("reference_time"))
    grib_meta = meta.get("meteofrance_grib")
    if isinstance(grib_meta, dict):
        add(grib_meta.get("arome_run_latest_reference_time"))
        add(grib_meta.get("arome_run_api_updated_at"))
        for value in grib_meta.get("arome_run_reference_times") or []:
            add(value)
        grib_targets = grib_meta.get("time_targets")
        if isinstance(grib_targets, dict):
            for target in grib_targets.values():
                if isinstance(target, dict):
                    add(target.get("reference_time"))
    return max(refs) if refs else None


def _server_arome_cached_run_reference(api_key: str, target_date: Date, requested_grid: str | None = None) -> str | None:
    for hour in [12, 0, 6, 18, 23, 1, 2, 3, 4, 5, 7, 8, 9, 10, 11, 13, 14, 15, 16, 17, 19, 20, 21, 22]:
        cached = _get_meteofrance_grib_france_slot_grid_cached_sync(
            api_key,
            target_date,
            hour,
            requested_grid=requested_grid,
            detail_level=METEOFRANCE_SLOT_GRID_CORE_DETAIL,
        )
        if not cached.get("ok"):
            continue
        ref = _server_arome_run_reference_from_meta((cached.get("payload") or {}).get("meta") or {})
        if ref:
            return ref
    return None


def _server_arome_run_schedule(now: datetime | None = None) -> dict[str, Any]:
    now_utc = (now or datetime.now(timezone.utc)).astimezone(timezone.utc)
    interval = max(60 * 60, int(OBJECTIFOUDRE_AROME_RUN_UPDATE_INTERVAL_SECONDS))
    delay = max(0, int(OBJECTIFOUDRE_AROME_RUN_AVAILABILITY_DELAY_SECONDS))
    current_epoch = int(now_utc.timestamp() // interval) * interval
    current_run = datetime.fromtimestamp(current_epoch, timezone.utc)
    current_availability = current_run + timedelta(seconds=delay)
    if now_utc < current_availability:
        expected_run = current_run - timedelta(seconds=interval)
        next_check = current_availability
    else:
        expected_run = current_run
        next_check = current_run + timedelta(seconds=interval + delay)
    expected_availability = expected_run + timedelta(seconds=delay)
    return {
        "update_interval_seconds": interval,
        "availability_delay_seconds": delay,
        "poll_interval_seconds": OBJECTIFOUDRE_AROME_RUN_POLL_INTERVAL_SECONDS,
        "expected_reference_time": expected_run.isoformat(timespec="seconds").replace("+00:00", "Z"),
        "expected_availability_time": expected_availability.isoformat(timespec="seconds").replace("+00:00", "Z"),
        "next_check_time": next_check.isoformat(timespec="seconds").replace("+00:00", "Z"),
        "seconds_until_next_check": max(0, int((next_check - now_utc).total_seconds())),
    }


def _server_arome_availability_reference(state: dict[str, Any] | None, run_schedule: dict[str, Any] | None) -> tuple[str | None, str]:
    state = state or {}
    run_schedule = run_schedule or {}
    actual = _server_arome_normalize_reference_time(str(state.get("last_api_run_reference_time") or ""))
    last_coverage = state.get("last_coverage") if isinstance(state.get("last_coverage"), dict) else {}
    if actual is None:
        actual = _server_arome_normalize_reference_time(str(last_coverage.get("api_run_reference_time") or ""))
    expected = _server_arome_normalize_reference_time(str(run_schedule.get("expected_reference_time") or ""))
    if actual and state.get("api_run_is_expected") is False:
        return actual, "api"
    refs = [item for item in [actual, expected] if item]
    if not refs:
        return None, "unknown"
    selected = max(refs)
    return selected, "api" if selected == actual else "schedule"


def _server_arome_available_hours_for_date(
    target_date: Date,
    reference_time: str | None,
    cached_hours: list[int] | None = None,
) -> dict[str, Any]:
    all_hours = list(range(24))
    today = datetime.now(OBJECTIFOUDRE_SERVER_TIMEZONE).date()
    cached = sorted({int(item) for item in (cached_hours or []) if 0 <= int(item) <= 23})
    horizon_hours = int(_active_nwp_spec().get("forecast_horizon_hours") or METEOFRANCE_AROME_FORECAST_HORIZON_HOURS)
    if target_date <= today:
        return {
            "available_hours": all_hours,
            "unavailable_hours": [],
            "reference_time": reference_time,
            "forecast_horizon_hours": horizon_hours,
            "source": "past_or_current_runs",
        }
    ref_dt = _parse_meteofrance_datetime(reference_time or "")
    if ref_dt is None:
        return {
            "available_hours": sorted(set(all_hours) | set(cached)),
            "unavailable_hours": [],
            "reference_time": None,
            "forecast_horizon_hours": horizon_hours,
            "source": "unknown_reference",
        }
    start_utc = ref_dt.astimezone(timezone.utc)
    end_utc = start_utc + timedelta(hours=horizon_hours)
    available: set[int] = set(cached)
    for hour in all_hours:
        slot_utc = datetime.combine(target_date, Time(hour=hour), tzinfo=OBJECTIFOUDRE_SERVER_TIMEZONE).astimezone(timezone.utc)
        if start_utc <= slot_utc <= end_utc:
            available.add(hour)
    available_hours = sorted(available)
    return {
        "available_hours": available_hours,
        "unavailable_hours": [hour for hour in all_hours if hour not in available],
        "reference_time": start_utc.isoformat(timespec="seconds").replace("+00:00", "Z"),
        "available_until": end_utc.isoformat(timespec="seconds").replace("+00:00", "Z"),
        "forecast_horizon_hours": horizon_hours,
        "source": "run_horizon_plus_cache",
    }


def _server_arome_latest_api_run_sync(api_key: str, requested_grid: str | None = None) -> dict[str, Any]:
    target = "Catalogue API AROME dernier run"
    statuses: list[dict[str, Any]] = []
    try:
        context = _resolve_meteofrance_package_base(api_key, requested_grid, force_refresh=False)
        selected_grid = context.get("grid")
        packages_url = str(context.get("packages_url") or "")
        packages = list(context.get("packages") or [])
        available = {str(item.get("id") or "").upper(): item for item in packages}
        preferred_ids = [item for item in ["SP1", "SP2", "SP3"] if item in available] or list(available.keys())[:1]
        latest: dict[str, Any] | None = None
        for package_id in preferred_ids:
            package_url = f"{packages_url}/{urllib.parse.quote(package_id)}"
            status, content_type, package_payload = _fetch_meteofrance_package_json(api_key, package_url, force_refresh=True)
            statuses.append({"step": f"package:{package_id}", "status": status, "content_type": content_type})
            run_links = _package_run_links(package_payload)
            if not run_links:
                continue
            candidate = run_links[0]
            candidate_ref = _server_arome_normalize_reference_time(candidate.get("reference_time"))
            if not candidate_ref:
                continue
            candidate_payload = {
                "package_id": package_id,
                "reference_time": candidate_ref,
                "title": candidate.get("title"),
                "href": candidate.get("href"),
                "run_count": len(run_links),
            }
            if latest is None or str(candidate_payload["reference_time"]) > str(latest.get("reference_time") or ""):
                latest = candidate_payload
        if latest is None:
            return {
                "ok": False,
                "status": None,
                "target": target,
                "message": "Aucun run AROME publié dans le catalogue API.",
                "statuses": statuses,
                "grid": selected_grid,
            }
        # Complétude du dernier run : ses groupes horaires couvrent-ils tout l'horizon ?
        # Sert de garde-fou pour ne pas reconstruire en boucle un run encore partiel.
        latest.setdefault("complete", True)
        latest.setdefault("available_time_groups", [])
        latest.setdefault("max_forecast_hour", None)
        try:
            _ls, _lct, latest_run_payload = _fetch_meteofrance_package_json(api_key, str(latest.get("href") or ""))
            latest_groups = sorted({str(item.get("time") or "") for item in _package_product_links(latest_run_payload) if item.get("time")})
            latest_max_end = 0
            for _group in latest_groups:
                _bounds = _parse_meteofrance_grib_time_group_bounds(_group)
                if _bounds:
                    latest_max_end = max(latest_max_end, _bounds[1])
            latest["available_time_groups"] = latest_groups
            latest["max_forecast_hour"] = latest_max_end
            latest["complete"] = (not latest_groups) or latest_max_end >= int(
                _active_nwp_spec().get("forecast_horizon_hours") or METEOFRANCE_AROME_FORECAST_HORIZON_HOURS
            )
        except Exception:
            latest["complete"] = True  # en cas de doute, ne pas bloquer le rattrapage
        return {
            "ok": True,
            "status": statuses[-1].get("status") if statuses else 200,
            "target": target,
            "message": f"Dernier run AROME API : {latest['reference_time']}.",
            "statuses": statuses,
            "grid": selected_grid,
            **latest,
        }
    except Exception as exc:
        failure = _meteofrance_failure_result(exc, target)
        if isinstance(exc, urllib.error.HTTPError) and exc.code == 429:
            _set_meteofrance_quota_cooldown(api_key, METEOFRANCE_GRIB_PACKAGE_QUOTA_SCOPE, failure)
            failure["quota_cooldown_seconds"] = METEOFRANCE_QUOTA_COOLDOWN_SECONDS
            failure["quota_cooldown_scope"] = METEOFRANCE_GRIB_PACKAGE_QUOTA_SCOPE
        failure["statuses"] = statuses
        return failure


def _server_arome_cache_dir_status() -> dict[str, Any]:
    global _server_arome_cache_dir_status_snapshot, _server_arome_cache_dir_status_snapshot_at
    now = time.time()
    with _server_arome_cache_dir_status_lock:
        if (
            _server_arome_cache_dir_status_snapshot is not None
            and now - _server_arome_cache_dir_status_snapshot_at < 30
        ):
            return copy.deepcopy(_server_arome_cache_dir_status_snapshot)
    path = METEOFRANCE_PERSISTENT_CACHE_DIR
    status: dict[str, Any] = {
        'path': str(path),
        'exists': False,
        'is_dir': False,
        'writable': False,
        'top_level_entry_count': 0,
        'estimated_byte_count': 0,
        'estimated_megabyte_count': 0.0,
        'disk_total_byte_count': None,
        'disk_free_byte_count': None,
        'disk_free_megabyte_count': None,
    }
    try:
        path.mkdir(parents=True, exist_ok=True)
        status['exists'] = path.exists()
        status['is_dir'] = path.is_dir()
        status['writable'] = bool(status['is_dir'] and os.access(path, os.W_OK))
        if status['is_dir']:
            status['top_level_entry_count'] = sum(1 for _ in path.iterdir())
            estimated_size = 0
            for item in path.rglob('*'):
                try:
                    if item.is_file():
                        estimated_size += int(item.stat().st_size)
                except OSError:
                    continue
            status['estimated_byte_count'] = estimated_size
            status['estimated_megabyte_count'] = round(estimated_size / (1024 * 1024), 1)
            try:
                usage = shutil.disk_usage(path)
                status['disk_total_byte_count'] = int(usage.total)
                status['disk_free_byte_count'] = int(usage.free)
                status['disk_free_megabyte_count'] = round(int(usage.free) / (1024 * 1024), 1)
            except OSError:
                pass
    except Exception as exc:
        status['error'] = str(exc)
    with _server_arome_cache_dir_status_lock:
        _server_arome_cache_dir_status_snapshot = copy.deepcopy(status)
        _server_arome_cache_dir_status_snapshot_at = now
    return status


def _cleanup_server_arome_cache_dir(*, force: bool = False) -> dict[str, Any]:
    global _server_arome_cache_cleanup_last_at, _server_arome_cache_dir_status_snapshot_at
    now = time.time()
    with _server_arome_cache_cleanup_lock:
        if not force and now - _server_arome_cache_cleanup_last_at < OBJECTIFOUDRE_CACHE_CLEANUP_INTERVAL_SECONDS:
            return {
                "ok": True,
                "skipped": True,
                "reason": "interval",
                "last_cleanup_at": _server_arome_cache_cleanup_last_at or None,
            }
        _server_arome_cache_cleanup_last_at = now
    path = METEOFRANCE_PERSISTENT_CACHE_DIR
    result: dict[str, Any] = {
        "ok": True,
        "skipped": False,
        "path": str(path),
        "retention_hours": OBJECTIFOUDRE_CACHE_RETENTION_HOURS,
        "deleted_file_count": 0,
        "deleted_byte_count": 0,
        "deleted_megabyte_count": 0.0,
        "removed_empty_dir_count": 0,
        "finished_at": None,
    }
    if not path.is_dir():
        result["skipped"] = True
        result["reason"] = "missing_cache_dir"
        return result
    cutoff = now - (OBJECTIFOUDRE_CACHE_RETENTION_HOURS * 60 * 60)
    full_pkg_cutoff = now - (OBJECTIFOUDRE_FULL_PACKAGE_RETENTION_HOURS * 60 * 60)
    full_pkg_dir = path / "grib-full-package"
    result["full_package_retention_hours"] = OBJECTIFOUDRE_FULL_PACKAGE_RETENTION_HOURS
    try:
        files = [item for item in path.rglob("*") if item.is_file()]
        for item in files:
            try:
                stat = item.stat()
            except OSError:
                continue
            # Les paquets GRIB bruts complets ont une rétention dédiée plus courte.
            item_cutoff = full_pkg_cutoff if full_pkg_dir in item.parents else cutoff
            if stat.st_mtime >= item_cutoff:
                continue
            try:
                item.unlink()
                result["deleted_file_count"] += 1
                result["deleted_byte_count"] += int(stat.st_size)
            except OSError:
                continue
        dirs = sorted((item for item in path.rglob("*") if item.is_dir()), key=lambda item: len(item.parts), reverse=True)
        for item in dirs:
            try:
                item.rmdir()
                result["removed_empty_dir_count"] += 1
            except OSError:
                continue
        result["deleted_megabyte_count"] = round(int(result["deleted_byte_count"]) / (1024 * 1024), 1)
        result["finished_at"] = time.time()
        with _server_arome_cache_dir_status_lock:
            _server_arome_cache_dir_status_snapshot_at = 0.0
    except Exception as exc:
        result["ok"] = False
        result["error"] = str(exc)
    return result


def _server_arome_automation_config() -> dict[str, Any]:
    return {
        'version': APP_VERSION,
        'enabled_by_env': _env_flag('OBJECTIFOUDRE_AUTO_PRELOAD', False),
        'server_key_configured': bool(_server_meteofrance_api_key()),
        'cache_dir': str(METEOFRANCE_PERSISTENT_CACHE_DIR),
        'cache_dir_status': _server_arome_cache_dir_status(),
        'grid': OBJECTIFOUDRE_AUTO_PRELOAD_GRID,
        'days': [item.isoformat() for item in _server_arome_preload_dates()],
        'arpege_days': [item.isoformat() for item in _server_arpege_preload_dates()],
        'arpege_server_key_configured': bool(_server_nwp_api_key('arpege')),
        'interval_seconds': OBJECTIFOUDRE_AUTO_PRELOAD_INTERVAL_SECONDS,
        'arome_run_update_interval_seconds': OBJECTIFOUDRE_AROME_RUN_UPDATE_INTERVAL_SECONDS,
        'arome_run_availability_delay_seconds': OBJECTIFOUDRE_AROME_RUN_AVAILABILITY_DELAY_SECONDS,
        'arome_run_poll_interval_seconds': OBJECTIFOUDRE_AROME_RUN_POLL_INTERVAL_SECONDS,
        'arome_run_schedule_source': 'AROME France every 3h; catalogue API reference_time is authoritative',
        'meteofrance_request_min_interval_seconds': METEOFRANCE_EXTERNAL_REQUEST_MIN_INTERVAL_SECONDS,
        'meteofrance_retry_base_delay_seconds': METEOFRANCE_EXTERNAL_RETRY_BASE_DELAY_SECONDS,
        'cache_retention_hours': OBJECTIFOUDRE_CACHE_RETENTION_HOURS,
        'cache_cleanup_interval_seconds': OBJECTIFOUDRE_CACHE_CLEANUP_INTERVAL_SECONDS,
        'timezone': str(OBJECTIFOUDRE_SERVER_TIMEZONE),
        'national_field_registry_enabled': METEOFRANCE_GRIB_USE_NATIONAL_FIELD_REGISTRY,
        'full_package_cache_enabled': METEOFRANCE_GRIB_FULL_PACKAGE_CACHE_ENABLED,
        'package_only_national_preload_enabled': METEOFRANCE_GRIB_PACKAGE_ONLY_NATIONAL_PRELOAD,
        'secret_required': bool(os.environ.get('OBJECTIFOUDRE_PRELOAD_SECRET')),
    }


def _server_arome_automation_status() -> dict[str, Any]:
    api_key = _server_meteofrance_api_key()
    dates = _server_arome_preload_dates()
    run_schedule = _server_arome_run_schedule()
    with _server_arome_automation_lock:
        state = copy.deepcopy(_server_arome_automation_state)
    availability_reference_time, availability_reference_source = _server_arome_availability_reference(state, run_schedule)
    # Couverture FUSIONNÉE par date : un jour mixte (ex. J+2 = AROME le matin, ARPEGE
    # l'après-midi) renvoie l'union des heures disponibles/en cache des deux modèles,
    # avec le détail par modèle. Le front lit une seule entrée par date.
    today = datetime.now(OBJECTIFOUDRE_SERVER_TIMEZONE).date()
    arpege_key = _server_nwp_api_key("arpege")
    arpege_ref = str(state.get("last_arpege_api_run_reference_time") or "") or None
    by_date: dict[str, dict[str, Any]] = {}
    order: list[str] = []

    def _hour_set(values: Any) -> set[int]:
        return {int(x) for x in (values or []) if 0 <= int(x) <= 23}

    def _add_model_coverage(item_date: Date, cov: dict[str, Any], model: str) -> None:
        key = item_date.isoformat()
        if key not in by_date:
            by_date[key] = {
                "date": key,
                "available_hours": set(),
                "cached_hours": set(),
                "by_model": {},
                "nwp_model": model,
            }
            order.append(key)
        entry = by_date[key]
        entry["available_hours"] |= _hour_set(cov.get("available_hours"))
        entry["cached_hours"] |= _hour_set(cov.get("cached_hours"))
        entry["by_model"][model] = cov

    if api_key:
        for item in dates:
            cov = _server_arome_cache_coverage(api_key, item, OBJECTIFOUDRE_AUTO_PRELOAD_GRID, availability_reference_time)
            cov["nwp_model"] = "arome"
            _add_model_coverage(item, cov, "arome")
    if arpege_key:
        with _nwp_model_context("arpege"):
            for item_date in _server_arpege_preload_dates():
                cov = _server_arome_cache_coverage(arpege_key, item_date, None, arpege_ref)
                cov["nwp_model"] = "arpege"
                _add_model_coverage(item_date, cov, "arpege")

    coverage = []
    for key in order:
        entry = by_date[key]
        available = sorted(entry["available_hours"])
        cached = sorted(entry["cached_hours"])
        missing = [h for h in available if h not in entry["cached_hours"]]
        models = list(entry["by_model"].keys())
        coverage.append({
            "date": key,
            "nwp_model": entry["nwp_model"],
            "models": models,
            "available_hours": available,
            "cached_hours": cached,
            "missing_hours": missing,
            "ok_count": len(cached),
            "hour_count": len(available),
            "complete": bool(available) and not missing,
            "by_model": entry["by_model"],
        })
    return {
        "ok": True,
        "config": _server_arome_automation_config(),
        "run_schedule": run_schedule,
        "arome_availability": {
            "reference_time": availability_reference_time,
            "source": availability_reference_source,
            "forecast_horizon_hours": METEOFRANCE_AROME_FORECAST_HORIZON_HOURS,
        },
        "state": state,
        "quota_cooldown_seconds": (
            _meteofrance_quota_cooldown_remaining(api_key, METEOFRANCE_GRIB_PACKAGE_QUOTA_SCOPE)
            if api_key
            else 0
        ),
        "coverage": coverage,
    }


def _update_server_arome_automation_state(**updates: Any) -> None:
    updates["updated_at"] = time.time()
    with _server_arome_automation_lock:
        _server_arome_automation_state.update(updates)


def _server_arome_rebuild_marker(date_iso: str) -> dict[str, Any] | None:
    """Mémoire du dernier « meilleur effort » de reconstruction d'un jour pour un run
    donné : sert à ne pas reconstruire en boucle quand la couverture ne peut plus
    progresser (run encore partiel, OU heures passées du jour courant non couvrables
    par le dernier run)."""
    with _server_arome_automation_lock:
        markers = _server_arome_automation_state.get("rebuild_markers") or {}
        marker = markers.get(date_iso)
        return dict(marker) if isinstance(marker, dict) else None


def _server_arome_set_rebuild_marker(date_iso: str, run_ref: str | None, max_forecast_hour: Any, cached_ref_after: str | None) -> None:
    with _server_arome_automation_lock:
        markers = dict(_server_arome_automation_state.get("rebuild_markers") or {})
        markers[date_iso] = {
            "run_ref": run_ref,
            "max_forecast_hour": max_forecast_hour,
            "cached_ref_after": cached_ref_after,
            "at": time.time(),
        }
        _server_arome_automation_state["rebuild_markers"] = markers


def _server_arome_clear_rebuild_marker(date_iso: str) -> None:
    with _server_arome_automation_lock:
        markers = _server_arome_automation_state.get("rebuild_markers")
        if isinstance(markers, dict) and date_iso in markers:
            markers = dict(markers)
            markers.pop(date_iso, None)
            _server_arome_automation_state["rebuild_markers"] = markers


# Marqueur « meilleur effort » : pour un jour qui reste INCOMPLET avec le run courant
# (heures restantes hors données du modèle — ex. ARPEGE 3-horaire au bord de l'horizon
# à J+4), on mémorise le nombre d'heures atteint pour ce run afin de NE PAS re-matérialiser
# en boucle (sinon le serveur reste saturé et tout le front rame). On ne retente que si
# le run change ou si le cache a pu grandir.
def _server_arome_best_effort_marker(key: str) -> dict[str, Any] | None:
    with _server_arome_automation_lock:
        markers = _server_arome_automation_state.get("best_effort_markers")
        if isinstance(markers, dict):
            entry = markers.get(key)
            return dict(entry) if isinstance(entry, dict) else None
    return None


def _server_arome_set_best_effort_marker(key: str, run_ref: str | None, cached_count: int) -> None:
    with _server_arome_automation_lock:
        markers = dict(_server_arome_automation_state.get("best_effort_markers") or {})
        markers[key] = {"run_ref": run_ref, "cached_count": int(cached_count), "at": time.time()}
        _server_arome_automation_state["best_effort_markers"] = markers


def _server_arome_clear_best_effort_marker(key: str) -> None:
    with _server_arome_automation_lock:
        markers = _server_arome_automation_state.get("best_effort_markers")
        if isinstance(markers, dict) and key in markers:
            markers = dict(markers)
            markers.pop(key, None)
            _server_arome_automation_state["best_effort_markers"] = markers


def _server_arome_automation_loop() -> None:
    _update_server_arome_automation_state(
        enabled=True,
        running=True,
        started_at=time.time(),
        message="Automatisation AROME serveur active.",
    )
    try:
        while not _server_arome_automation_stop.is_set():
            api_key = _server_meteofrance_api_key()
            if not api_key:
                _update_server_arome_automation_state(
                    running=True,
                    message="Automatisation en attente : clé API serveur absente.",
                    current_job=None,
                )
                _server_arome_automation_stop.wait(60)
                continue

            cleanup_result = _cleanup_server_arome_cache_dir()
            if cleanup_result.get("deleted_file_count") or cleanup_result.get("error"):
                _update_server_arome_automation_state(last_cache_cleanup=cleanup_result)

            requested_grid = OBJECTIFOUDRE_AUTO_PRELOAD_GRID
            target_dates = _server_arome_preload_dates()
            arpege_dates = _server_arpege_preload_dates()
            arpege_api_key = _server_nwp_api_key("arpege") if arpege_dates else None
            run_schedule = _server_arome_run_schedule()
            if not target_dates:
                _update_server_arome_automation_state(
                    running=True,
                    message="Automatisation en attente : aucune date configurée.",
                    current_job=None,
                    run_schedule=run_schedule,
                )
                _server_arome_automation_stop.wait(OBJECTIFOUDRE_AUTO_PRELOAD_INTERVAL_SECONDS)
                continue

            cooldown = _meteofrance_quota_cooldown_remaining(api_key, METEOFRANCE_GRIB_PACKAGE_QUOTA_SCOPE)
            if cooldown > 0:
                _update_server_arome_automation_state(
                    running=True,
                    message=f"Automatisation AROME en pause quota : reprise dans {cooldown // 60 + 1} min.",
                    quota_cooldown_seconds=cooldown,
                    next_retry_at=time.time() + cooldown,
                    current_job=None,
                    run_schedule=run_schedule,
                )
                _server_arome_automation_stop.wait(min(cooldown, 60))
                continue

            api_run = _server_arome_latest_api_run_sync(api_key, requested_grid)
            api_ref = None
            if api_run.get("ok"):
                api_ref = _server_arome_normalize_reference_time(str(api_run.get("reference_time") or ""))
                if api_ref:
                    api_run["reference_time"] = api_ref
            expected_ref = str(run_schedule.get("expected_reference_time") or "")
            api_epoch = _server_arome_reference_epoch(api_ref)
            expected_epoch = _server_arome_reference_epoch(expected_ref)
            api_run_is_expected = bool(
                api_ref
                and (
                    api_epoch is None
                    or expected_epoch is None
                    or api_epoch + 60 >= expected_epoch
                )
            )
            # Le dernier run est-il entièrement publié (tous ses groupes horaires) ?
            api_run_complete = bool(api_run.get("complete", True)) if api_run.get("ok") else True
            api_run_max_forecast_hour = api_run.get("max_forecast_hour")
            _update_server_arome_automation_state(
                running=True,
                run_schedule=run_schedule,
                last_api_run=api_run,
                last_api_run_reference_time=api_ref,
                last_api_run_complete=api_run_complete,
                last_api_run_max_forecast_hour=api_run_max_forecast_hour,
                expected_api_run_reference_time=expected_ref or None,
                api_run_is_expected=api_run_is_expected,
                quota_cooldown_seconds=0,
            )

            if not api_run.get("ok"):
                status = int(api_run.get("status") or 0)
                if status in {401, 403}:
                    _update_server_arome_automation_state(
                        running=False,
                        enabled=False,
                        current_job=None,
                        message="Automatisation AROME arrêtée : accès Météo-France serveur refusé. Vérifie la clé ou l’abonnement AROME avant de relancer.",
                    )
                    return
                cooldown = int(api_run.get("quota_cooldown_seconds") or _meteofrance_quota_cooldown_remaining(api_key, METEOFRANCE_GRIB_PACKAGE_QUOTA_SCOPE) or 0)
                wait_seconds = min(cooldown, 60) if cooldown > 0 else int(OBJECTIFOUDRE_AROME_RUN_POLL_INTERVAL_SECONDS)
                _update_server_arome_automation_state(
                    running=True,
                    message=(
                        f"Catalogue AROME inaccessible, pause quota : reprise dans {cooldown // 60 + 1} min."
                        if cooldown > 0
                        else f"Catalogue AROME inaccessible : nouvelle vérification dans {wait_seconds // 60} min."
                    ),
                    quota_cooldown_seconds=cooldown if cooldown > 0 else 0,
                    next_retry_at=time.time() + wait_seconds,
                    current_job=None,
                )
                _server_arome_automation_stop.wait(wait_seconds)
                continue

            # Run ARPEGE du cycle (une seule découverte catalogue, sous contexte arpege).
            arpege_api_ref = None
            arpege_api_run_max_forecast_hour = None
            if arpege_dates and arpege_api_key:
                try:
                    with _nwp_model_context("arpege"):
                        arpege_api_run = _server_arome_latest_api_run_sync(arpege_api_key, None)
                    if arpege_api_run.get("ok"):
                        arpege_api_ref = _server_arome_normalize_reference_time(str(arpege_api_run.get("reference_time") or ""))
                        arpege_api_run_max_forecast_hour = arpege_api_run.get("max_forecast_hour")
                    _update_server_arome_automation_state(
                        running=True,
                        last_arpege_api_run_reference_time=arpege_api_ref,
                        last_arpege_api_run_max_forecast_hour=arpege_api_run_max_forecast_hour,
                    )
                except Exception as exc:
                    _update_server_arome_automation_state(running=True, last_arpege_api_run_error=str(exc))

            launched_job = False
            launched_incomplete_rebuild = False
            blocked_by_pending_run = False
            blocked_by_stale_rebuild = False
            last_schedule = None
            # Sauvegarde des paramètres AROME : la boucle les permute par modèle, la
            # logique d'attente après la boucle doit retrouver les valeurs AROME.
            arome_loop_params = (api_key, api_ref, api_run_is_expected, api_run_max_forecast_hour, expected_ref, requested_grid)
            target_items = [("arome", item) for item in target_dates]
            if arpege_api_key and arpege_api_ref:
                target_items.extend(("arpege", item) for item in arpege_dates)
            for nwp_model_id, target_date in target_items:
                if _server_arome_automation_stop.is_set():
                    break
                if nwp_model_id == "arome":
                    api_key, api_ref, api_run_is_expected, api_run_max_forecast_hour, expected_ref, requested_grid = arome_loop_params
                else:
                    # ARPEGE : pas de cadence « run attendu » gérée (runs toutes les 6 h),
                    # on reconstruit dès qu'un nouveau run est visible au catalogue.
                    api_key = arpege_api_key
                    api_ref = arpege_api_ref
                    api_run_is_expected = True
                    api_run_max_forecast_hour = arpege_api_run_max_forecast_hour
                    expected_ref = ""
                    requested_grid = None
                marker_key = target_date.isoformat() if nwp_model_id == "arome" else f"{nwp_model_id}:{target_date.isoformat()}"
                availability_ref_for_date = api_ref or expected_ref or None
                with _nwp_model_context(nwp_model_id):
                    coverage = _server_arome_cache_coverage(api_key, target_date, requested_grid, availability_ref_for_date)
                cached_hours = [int(item) for item in (coverage.get("cached_hours") or []) if 0 <= int(item) <= 23]
                cached_ref = coverage.get("cached_api_run_reference_time")
                cache_complete = bool(coverage.get("complete"))
                has_cached_hours = bool(cached_hours)
                run_changed = bool(api_ref and target_date >= datetime.now(OBJECTIFOUDRE_SERVER_TIMEZONE).date() and has_cached_hours and cached_ref != api_ref)
                pending_new_run = bool(api_ref and not api_run_is_expected and not run_changed)
                coverage_status = dict(coverage)
                coverage_status.update(
                    {
                        "nwp_model": nwp_model_id,
                        "api_run_reference_time": api_ref,
                        "expected_api_run_reference_time": expected_ref or None,
                        "api_run_is_expected": api_run_is_expected,
                        "run_changed": run_changed,
                        "waiting_for_expected_run": pending_new_run,
                    }
                )
                _update_server_arome_automation_state(
                    running=True,
                    message=f"Vérification du cache {nwp_model_id.upper()} France {target_date.isoformat()} avec run API {api_ref or 'inconnu'}.",
                    last_coverage=coverage_status,
                    quota_cooldown_seconds=0,
                )

                available_hours = [int(item) for item in (coverage.get("available_hours") or []) if 0 <= int(item) <= 23]
                if not available_hours:
                    continue
                if cache_complete and not run_changed:
                    continue
                if pending_new_run and cache_complete:
                    blocked_by_pending_run = True
                    continue

                # Garde-fou « meilleur effort » : jour INCOMPLET déjà matérialisé au mieux
                # pour ce run (les heures restantes ne sont pas dans les données du modèle —
                # ex. ARPEGE 3-horaire au bord de l'horizon à J+4). On ne re-matérialise pas
                # à chaque cycle (évite la boucle perpétuelle qui sature le serveur).
                if not run_changed:
                    be = _server_arome_best_effort_marker(marker_key)
                    if be and be.get("run_ref") == api_ref and len(cached_hours) <= int(be.get("cached_count") or -1):
                        blocked_by_stale_rebuild = True
                        _update_server_arome_automation_state(
                            running=True,
                            message=(
                                f"{nwp_model_id.upper()} {target_date.isoformat()} : couverture déjà au mieux pour ce run "
                                f"({len(cached_hours)} h ; heures restantes hors données du modèle) ; attente d'un nouveau run."
                            ),
                            last_coverage=coverage_status,
                        )
                        continue

                # Garde-fou anti-boucle : si on a déjà fait le meilleur effort pour ce jour
                # avec ce run (même run_ref ET pas de nouveaux groupes), et que la dernière
                # reconstruction n'a pas pu adopter le dernier run, on ne reconstruit pas à
                # l'identique. Couvre deux cas : run encore partiel (groupes longue échéance
                # manquants), et jour courant dont les heures passées ne sont pas couvrables
                # par le dernier run. On relance seulement si le run change ou s'enrichit.
                if run_changed and cache_complete:
                    marker = _server_arome_rebuild_marker(marker_key)
                    already_best_effort = bool(
                        marker
                        and marker.get("run_ref") == api_ref
                        and marker.get("max_forecast_hour") is not None
                        and api_run_max_forecast_hour is not None
                        and int(api_run_max_forecast_hour) <= int(marker.get("max_forecast_hour"))
                    )
                    if already_best_effort:
                        blocked_by_stale_rebuild = True
                        _update_server_arome_automation_state(
                            running=True,
                            message=(
                                f"Run {nwp_model_id.upper()} {api_ref} : couverture {target_date.isoformat()} déjà au mieux "
                                f"(heures restantes non couvrables par ce run) ; attente d'un nouveau run/groupe."
                            ),
                            last_coverage=coverage_status,
                        )
                        continue

                with _nwp_model_context(nwp_model_id):
                    schedule = _schedule_meteofrance_grib_national_day_preload(
                        None,
                        api_key,
                        target_date,
                        requested_grid,
                        force_rebuild=run_changed,
                        allowed_hours=available_hours,
                    )
                last_schedule = schedule
                launched_job = bool(schedule.get("scheduled") or schedule.get("already_running"))
                job_key = schedule.get("job_key")
                schedule_cooldown = int(schedule.get("quota_cooldown_seconds") or 0)
                _update_server_arome_automation_state(
                    running=True,
                    message=(
                        schedule.get("message")
                        or (
                            f"Nouveau run AROME API {api_ref} détecté : reconstruction France {target_date.isoformat()} lancée."
                            if run_changed and launched_job
                            else (
                                f"Préchargement AROME France {target_date.isoformat()} lancé côté serveur."
                                if launched_job
                                else f"Préchargement AROME France {target_date.isoformat()} non lancé."
                            )
                        )
                    ),
                    last_job_key=job_key,
                    last_schedule=schedule,
                    current_job=schedule.get("progress"),
                    quota_cooldown_seconds=schedule_cooldown,
                    next_retry_at=(time.time() + schedule_cooldown) if schedule_cooldown > 0 else None,
                )
                if schedule.get("quota_cooldown") and schedule_cooldown > 0:
                    cooldown = schedule_cooldown
                    break
                while job_key and not _server_arome_automation_stop.is_set():
                    status = _grib_auto_preload_status(str(job_key))
                    _update_server_arome_automation_state(
                        running=True,
                        current_job=status,
                        quota_cooldown_seconds=status.get("quota_cooldown_seconds"),
                        message=status.get("message") or f"Préchargement AROME France {target_date.isoformat()} en cours.",
                    )
                    if not status.get("running"):
                        break
                    _server_arome_automation_stop.wait(2)
                if job_key:
                    final_status = _grib_auto_preload_status(str(job_key))
                    cooldown = int(final_status.get("quota_cooldown_seconds") or 0)
                    last_result = final_status.get("last_result") or {}
                    last_status = int(last_result.get("status") or 0)
                    _update_server_arome_automation_state(
                        running=True,
                        current_job=final_status,
                        quota_cooldown_seconds=cooldown,
                        message=final_status.get("message") or "Préchargement AROME France terminé.",
                    )
                    if last_status in {401, 403}:
                        _update_server_arome_automation_state(
                            running=False,
                            enabled=False,
                            current_job=final_status,
                            message="Automatisation AROME arrêtée : accès Météo-France serveur refusé. Vérifie la clé ou l’abonnement AROME avant de relancer.",
                        )
                        return
                    if cooldown > 0:
                        break
                    # Garde-fou : après une reconstruction réussie, on regarde si le jour a pu
                    # adopter le dernier run. Si oui -> on efface le marqueur. Sinon (run encore
                    # partiel, ou heures passées non couvrables) -> on mémorise ce meilleur
                    # effort pour ne pas refaire la même reconstruction au prochain cycle.
                    if run_changed and final_status.get("ok"):
                        with _nwp_model_context(nwp_model_id):
                            cached_ref_after = _server_arome_normalize_reference_time(
                                _server_arome_cached_run_reference(api_key, target_date, requested_grid)
                            )
                        if cached_ref_after == api_ref:
                            _server_arome_clear_rebuild_marker(marker_key)
                        else:
                            launched_incomplete_rebuild = True
                            _server_arome_set_rebuild_marker(
                                marker_key, api_ref, api_run_max_forecast_hour, cached_ref_after
                            )

                    # Meilleur effort : après le job, si le jour reste INCOMPLET (heures hors
                    # données du modèle), on mémorise le niveau atteint pour ce run et on
                    # n'y retouche plus avant un nouveau run (sinon boucle perpétuelle).
                    if final_status.get("ok"):
                        with _nwp_model_context(nwp_model_id):
                            cov_after = _server_arome_cache_coverage(api_key, target_date, requested_grid, availability_ref_for_date)
                        cached_after = [int(x) for x in (cov_after.get("cached_hours") or []) if 0 <= int(x) <= 23]
                        if cov_after.get("complete"):
                            _server_arome_clear_best_effort_marker(marker_key)
                        else:
                            _server_arome_set_best_effort_marker(marker_key, api_ref, len(cached_after))
                            blocked_by_stale_rebuild = True

            # Restaure les paramètres AROME (la boucle a pu les permuter sur un jour ARPEGE)
            # pour que la logique d'attente ci-dessous raisonne sur le run AROME.
            api_key, api_ref, api_run_is_expected, api_run_max_forecast_hour, expected_ref, requested_grid = arome_loop_params

            if cooldown > 0:
                wait_seconds = min(cooldown, 60)
                wait_message = f"Automatisation AROME en pause quota : reprise dans {cooldown // 60 + 1} min."
            elif launched_incomplete_rebuild or blocked_by_stale_rebuild:
                # Garde-fou : la couverture ne peut pas (encore) adopter pleinement le dernier
                # run — run en cours de publication, ou heures passées du jour courant. On a fait
                # le meilleur effort ; on attend le poll interval (au lieu de boucler toutes les
                # 20 s) qu'un nouveau run/groupe arrive (le cache package-json partiel expire vite).
                wait_seconds = int(OBJECTIFOUDRE_AROME_RUN_POLL_INTERVAL_SECONDS)
                wait_message = (
                    f"Run AROME {api_ref} : couverture déjà au mieux ; nouvelle vérification "
                    f"dans {wait_seconds // 60} min (attente d'un nouveau run/groupe)."
                )
            elif launched_job:
                wait_seconds = 20
                wait_message = "Automatisation AROME : vérification courte après préchargement."
            elif blocked_by_pending_run or (api_ref and not api_run_is_expected):
                wait_seconds = int(OBJECTIFOUDRE_AROME_RUN_POLL_INTERVAL_SECONDS)
                wait_message = (
                    f"Run AROME attendu {expected_ref or 'API'} pas encore publié dans le catalogue ; "
                    f"nouvelle vérification dans {wait_seconds // 60} min."
                )
            else:
                scheduled_wait = int(run_schedule.get("seconds_until_next_check") or OBJECTIFOUDRE_AROME_RUN_UPDATE_INTERVAL_SECONDS)
                wait_seconds = max(60, min(scheduled_wait, int(OBJECTIFOUDRE_AROME_RUN_UPDATE_INTERVAL_SECONDS)))
                wait_message = "Automatisation AROME serveur en veille jusqu’au prochain créneau de run."
            _update_server_arome_automation_state(
                running=True,
                message=wait_message,
                quota_cooldown_seconds=cooldown if cooldown > 0 else 0,
                next_retry_at=time.time() + wait_seconds,
                last_schedule=last_schedule,
                run_schedule=run_schedule,
            )
            _server_arome_automation_stop.wait(wait_seconds)
    except Exception as exc:
        _update_server_arome_automation_state(
            running=False,
            enabled=False,
            message=f"Automatisation AROME serveur arrêtée : {exc}",
            error=str(exc),
        )
    finally:
        _update_server_arome_automation_state(
            running=False,
            enabled=False,
            stopped_at=time.time(),
        )


def _start_server_arome_automation_thread(*, manual: bool = False) -> dict[str, Any]:
    global _server_arome_automation_thread
    if not manual and not _env_flag("OBJECTIFOUDRE_AUTO_PRELOAD", False):
        return {"ok": True, "started": False, "message": "Automatisation AROME serveur désactivée par configuration."}
    _server_meteofrance_api_key_required()
    already_running = False
    with _server_arome_automation_lock:
        if _server_arome_automation_thread is not None and _server_arome_automation_thread.is_alive():
            already_running = True
        else:
            _server_arome_automation_stop.clear()
            _server_arome_automation_thread = threading.Thread(
                target=_server_arome_automation_loop,
                daemon=True,
                name="objectifoudre-arome-automation",
            )
            _server_arome_automation_thread.start()
    if already_running:
        return {"ok": True, "started": False, "already_running": True, "status": _server_arome_automation_status()}
    return {"ok": True, "started": True, "status": _server_arome_automation_status()}


def _stop_server_arome_automation_thread() -> None:
    _server_arome_automation_stop.set()


@app.on_event("startup")
def _startup_server_arome_automation() -> None:
    if _env_flag("OBJECTIFOUDRE_AUTO_PRELOAD", False):
        try:
            _start_server_arome_automation_thread(manual=False)
        except HTTPException:
            _update_server_arome_automation_state(
                enabled=False,
                running=False,
                message="Automatisation AROME non démarrée : clé API serveur absente.",
            )
    try:
        _start_lightning_automation_thread()
    except Exception:
        pass
    # Applique la config d'auto-calibration déjà apprise (poids + seuil), si présente.
    try:
        _load_and_apply_active_learning()
    except Exception:
        pass


@app.on_event("shutdown")
def _shutdown_server_arome_automation() -> None:
    _stop_server_arome_automation_thread()
    _lightning_automation_stop.set()
    _reset_preload_process_pool()


def _probe_meteofrance_grib_profile_sync(
    api_key: str,
    requested_grid: str | None = None,
    package_ids: list[str] | None = None,
    requested_time_group: str | None = None,
    max_messages: int = 32,
) -> dict[str, Any]:
    target = "AROME API Paquet Modèles GRIB profil"
    objectifoudre_plan = _meteofrance_grib_objectifoudre_plan(requested_grid)
    package_cooldown = _meteofrance_quota_cooldown_result(
        api_key,
        METEOFRANCE_GRIB_PACKAGE_QUOTA_SCOPE,
        target,
        "profil GRIB",
    )
    if package_cooldown is not None:
        package_cooldown["objectifoudre_plan"] = objectifoudre_plan
        package_cooldown["grib_profile_cache_hit"] = False
        return package_cooldown

    cache_key = _meteofrance_grib_profile_cache_key(api_key, requested_grid, package_ids, requested_time_group, max_messages)
    cached = _get_cached_value(cache_key, ttl=METEOFRANCE_GRIB_PROFILE_CACHE_TTL_SECONDS)
    if cached is not None:
        result = copy.deepcopy(cached["payload"])
        cached_range_count = int(result.get("cached_total_range_request_count") or result.get("total_range_request_count") or 0)
        ok_profiles = [profile for profile in result.get("package_profiles", []) if profile.get("ok")]
        package_count = len(result.get("package_ids", []) or result.get("package_profiles", []))
        parameter_count = int((result.get("combined_parameter_summary") or {}).get("parameter_count") or 0)
        for profile in result.get("package_profiles", []):
            original_profile_count = int(profile.get("cached_range_request_count") or profile.get("range_request_count") or 0)
            profile["cached_range_request_count"] = original_profile_count
            profile["range_request_count"] = 0
        result["objectifoudre_plan"] = objectifoudre_plan
        result["message"] = (
            f"Profil GRIB servi depuis le cache : {len(ok_profiles)}/{package_count} paquet(s) inspecté(s), "
            f"{parameter_count} paramètre(s) distinct(s), 0 requête Range API."
        )
        result["cached_total_range_request_count"] = cached_range_count
        result["total_range_request_count"] = 0
        result["grib_profile_cache_hit"] = True
        result["grib_profile_cache_ttl_seconds"] = METEOFRANCE_GRIB_PROFILE_CACHE_TTL_SECONDS
        return result

    quota_key = _meteofrance_quota_cooldown_cache_key(api_key, "grib-profile")
    quota_cooldown = _get_cached_value(quota_key, ttl=METEOFRANCE_QUOTA_COOLDOWN_SECONDS)
    if quota_cooldown is not None:
        elapsed = max(0, int(time.time() - float(quota_cooldown["ts"])))
        remaining = max(1, METEOFRANCE_QUOTA_COOLDOWN_SECONDS - elapsed)
        return {
            "ok": False,
            "status": 429,
            "message": f"Quota Météo-France déjà dépassé récemment : profil GRIB suspendu côté serveur encore {remaining // 60 + 1} min pour éviter d’aggraver le quota.",
            "target": target,
            "quota_cooldown_seconds": remaining,
            "objectifoudre_plan": objectifoudre_plan,
            "grib_profile_cache_hit": False,
        }

    try:
        context = _resolve_meteofrance_package_base(api_key, requested_grid)
        statuses = context["statuses"]
        packages = context["packages"]
        packages_url = context["packages_url"]
        available_packages = {item["id"]: item for item in packages}
        selected_package_ids = [
            package_id
            for package_id in _normalize_meteofrance_package_ids(package_ids)
            if package_id in available_packages
        ]
        if not selected_package_ids:
            return {
                "ok": False,
                "status": statuses[-1]["status"] if statuses else None,
                "message": "Aucun paquet GRIB demandé n’est disponible sur cette grille.",
                "target": target,
                "grid": context["grid"],
                "available_package_ids": sorted(available_packages),
                "objectifoudre_plan": objectifoudre_plan,
                "statuses": statuses,
            }

        package_profiles = []
        last_status = statuses[-1]["status"] if statuses else None
        total_range_requests = 0
        cached_total_range_requests = 0
        for package_id in selected_package_ids:
            package_url = f"{packages_url}/{urllib.parse.quote(package_id)}"
            status, content_type, package_payload = _fetch_meteofrance_package_json(api_key, package_url)
            statuses.append({"step": f"package:{package_id}", "status": status, "content_type": content_type})
            run_links = _package_run_links(package_payload)
            if not run_links:
                package_profiles.append(
                    {
                        "ok": False,
                        "package_id": package_id,
                        "package_title": available_packages[package_id].get("title", package_id),
                        "message": f"Aucun réseau disponible pour {package_id}.",
                    }
                )
                continue

            latest_run = run_links[0]
            status, content_type, run_payload = _fetch_meteofrance_package_json(api_key, latest_run["href"])
            statuses.append({"step": f"package:{package_id}:run", "status": status, "content_type": content_type})
            product_links = _package_product_links(run_payload)
            if not product_links:
                package_profiles.append(
                    {
                        "ok": False,
                        "package_id": package_id,
                        "package_title": available_packages[package_id].get("title", package_id),
                        "reference_time": latest_run["reference_time"],
                        "message": f"Aucun produit GRIB disponible pour {package_id}.",
                    }
                )
                continue

            selected_product = None
            if requested_time_group:
                selected_product = next((item for item in product_links if item["time"] == requested_time_group), None)
            selected_product = selected_product or product_links[0]
            index = _index_grib_message_headers_cached(api_key, selected_product["href"], max_messages=max_messages)
            range_request_count = int(index.get("range_request_count") or 0)
            cached_range_request_count = int(index.get("cached_range_request_count") or 0)
            total_range_requests += range_request_count
            cached_total_range_requests += cached_range_request_count
            if index.get("statuses"):
                last_status = index["statuses"][-1].get("status", last_status)
            package_profiles.append(
                {
                    "ok": bool(index.get("message_count_indexed")),
                    "package_id": package_id,
                    "package_title": available_packages[package_id].get("title", package_id),
                    "package_description": str(package_payload.get("description") or ""),
                    "reference_time": latest_run["reference_time"],
                    "time_group": selected_product["time"],
                    "available_time_groups": [item["time"] for item in product_links],
                    "product": selected_product,
                    "message_count_indexed": index["message_count_indexed"],
                    "complete": index["complete"],
                    "truncated": index["truncated"],
                    "next_offset": index["next_offset"],
                    "total_size": index["total_size"],
                    "range_request_count": range_request_count,
                    "cached_range_request_count": cached_range_request_count,
                    "parameter_summary": index["parameter_summary"],
                    "first_messages": index["messages"][:4],
                }
            )

        combined = _combine_grib_profile_parameters(package_profiles)
        ok_profiles = [profile for profile in package_profiles if profile.get("ok")]
        message = (
            f"Profil GRIB OK : {len(ok_profiles)}/{len(selected_package_ids)} paquet(s) inspecté(s), "
            f"{combined['parameter_count']} paramètre(s) distinct(s), {total_range_requests} requêtes Range."
            if ok_profiles
            else "Profil GRIB impossible : aucun message GRIB indexé sur les paquets inspectés."
        )
        result = {
            "ok": bool(ok_profiles),
            "status": last_status,
            "message": message,
            "target": target,
            "grid": context["grid"],
            "package_ids": selected_package_ids,
            "available_package_ids": sorted(available_packages),
            "time_group": requested_time_group,
            "max_messages": max_messages,
            "total_range_request_count": total_range_requests,
            "cached_total_range_request_count": cached_total_range_requests,
            "combined_parameter_summary": combined,
            "package_profiles": package_profiles,
            "objectifoudre_plan": _meteofrance_grib_objectifoudre_plan(context["grid"]),
            "statuses": statuses,
        }
        _set_cached_value(cache_key, result)
        result["grib_profile_cache_hit"] = False
        result["grib_profile_cache_ttl_seconds"] = METEOFRANCE_GRIB_PROFILE_CACHE_TTL_SECONDS
        return result
    except Exception as exc:
        failure = _meteofrance_failure_result(exc, target)
        if isinstance(exc, urllib.error.HTTPError) and exc.code == 429:
            failure["quota_cooldown_seconds"] = METEOFRANCE_QUOTA_COOLDOWN_SECONDS
            _set_cached_value(quota_key, failure)
            _set_meteofrance_quota_cooldown(api_key, METEOFRANCE_GRIB_PACKAGE_QUOTA_SCOPE, failure)
        return failure


def _probe_meteofrance_model_packages_sync(
    api_key: str,
    requested_grid: str | None = None,
    inspect_all: bool = False,
    max_inspected_packages: int = 3,
) -> dict[str, Any]:
    target = "AROME API Paquet Modèles catalogue"
    cooldown_result = _meteofrance_quota_cooldown_result(
        api_key,
        METEOFRANCE_GRIB_PACKAGE_QUOTA_SCOPE,
        target,
        "lecture catalogue paquets",
    )
    if cooldown_result is not None:
        return cooldown_result
    try:
        max_inspected_packages = max(1, min(12, int(max_inspected_packages)))
        statuses = []
        grids_url = f"{METEOFRANCE_AROME_PACKAGE_API_BASE}/models/{METEOFRANCE_AROME_PACKAGE_MODEL}/grids"
        status, content_type, grids_payload = _fetch_meteofrance_package_json(api_key, grids_url)
        statuses.append({"step": "grids", "status": status, "content_type": content_type})
        grids = _catalog_items_from_links(grids_payload, "/grids/")
        selected_grid = _choose_meteofrance_package_grid(grids, requested_grid)
        if not selected_grid:
            return {
                "ok": False,
                "status": status,
                "message": "Catalogue Paquet Modèles OK, mais aucune grille AROME exploitable trouvée.",
                "target": target,
                "grids": grids,
            }

        packages_url = f"{METEOFRANCE_AROME_PACKAGE_API_BASE}/models/{METEOFRANCE_AROME_PACKAGE_MODEL}/grids/{urllib.parse.quote(selected_grid)}/packages"
        status, content_type, packages_payload = _fetch_meteofrance_package_json(api_key, packages_url)
        statuses.append({"step": "packages", "status": status, "content_type": content_type})
        packages = _catalog_items_from_links(packages_payload, "/packages/")
        available_packages = {item["id"]: item for item in packages}
        package_candidate_summary = _summarize_meteofrance_package_candidates(packages)
        inspected_ids = _choose_meteofrance_packages_to_inspect(packages, inspect_all, max_inspected_packages)

        inspected_packages = []
        for package_id in inspected_ids:
            package_url = f"{packages_url}/{urllib.parse.quote(package_id)}"
            package_status, package_content_type, package_payload = _fetch_meteofrance_package_json(api_key, package_url)
            statuses.append({"step": f"package:{package_id}", "status": package_status, "content_type": package_content_type})
            run_links = _package_run_links(package_payload)
            product_links: list[dict[str, str]] = []
            latest_run = run_links[0] if run_links else None
            if latest_run:
                run_status, run_content_type, run_payload = _fetch_meteofrance_package_json(api_key, latest_run["href"])
                statuses.append({"step": f"package:{package_id}:run", "status": run_status, "content_type": run_content_type})
                product_links = _package_product_links(run_payload)
            inspected_packages.append(
                {
                    "id": package_id,
                    "title": available_packages.get(package_id, {}).get("title", package_id),
                    "description": str(package_payload.get("description") or ""),
                    "candidate": _classify_meteofrance_package_candidate(
                        {
                            **available_packages.get(package_id, {}),
                            "description": str(package_payload.get("description") or ""),
                        }
                    ),
                    "run_count": len(run_links),
                    "latest_reference_time": latest_run["reference_time"] if latest_run else None,
                    "product_count": len(product_links),
                    "time_groups": [item["time"] for item in product_links[:12]],
                    "sample_products": product_links[:6],
                }
            )

        total_products = sum(item["product_count"] for item in inspected_packages)
        candidate_count = len(package_candidate_summary.get("profile_candidates", []))
        return {
            "ok": True,
            "status": statuses[-1]["status"] if statuses else None,
            "message": f"Catalogue Paquet AROME OK : grille {selected_grid}, {len(packages)} paquets, {candidate_count} candidat(s) profil, {total_products} produits GRIB listés sur les paquets inspectés.",
            "target": target,
            "model": METEOFRANCE_AROME_PACKAGE_MODEL,
            "selected_grid": selected_grid,
            "grids": grids,
            "packages": packages,
            "package_candidate_summary": package_candidate_summary,
            "inspected_package_ids": inspected_ids,
            "inspect_all": inspect_all,
            "inspected_packages": inspected_packages,
            "statuses": statuses,
        }
    except Exception as exc:
        failure = _meteofrance_failure_result(exc, target)
        if isinstance(exc, urllib.error.HTTPError) and exc.code == 429:
            _set_meteofrance_quota_cooldown(api_key, METEOFRANCE_GRIB_PACKAGE_QUOTA_SCOPE, failure)
            failure["quota_cooldown_seconds"] = METEOFRANCE_QUOTA_COOLDOWN_SECONDS
            failure["quota_cooldown_scope"] = METEOFRANCE_GRIB_PACKAGE_QUOTA_SCOPE
        return failure


def _parse_meteofrance_describe_coverage(raw: bytes) -> dict[str, Any]:
    root = ET.fromstring(raw)
    axes: dict[str, list[str]] = {}
    lower_corner = None
    upper_corner = None
    begin_position = None
    end_position = None
    for element in root.iter():
        local = _xml_local_name(element.tag)
        text = (element.text or "").strip()
        if local == "lowerCorner" and text:
            lower_corner = text
        elif local == "upperCorner" and text:
            upper_corner = text
        elif local == "beginPosition" and text:
            begin_position = text
        elif local == "endPosition" and text:
            end_position = text
        elif local == "GeneralGridAxis":
            axis_name = None
            coefficients = []
            for child in element.iter():
                child_local = _xml_local_name(child.tag)
                child_text = (child.text or "").strip()
                if child_local == "gridAxesSpanned" and child_text:
                    axis_name = child_text
                elif child_local == "coefficients" and child_text:
                    coefficients = child_text.split()
            if axis_name:
                axes[axis_name] = coefficients
    return {
        "axes": axes,
        "lower_corner": lower_corner,
        "upper_corner": upper_corner,
        "begin_position": begin_position,
        "end_position": end_position,
    }


def _describe_meteofrance_coverage(api_key: str, coverage_id: str) -> dict[str, Any]:
    cache_key = _meteofrance_metadata_cache_key(api_key, f"describe:{coverage_id}")
    cached = _get_cached_value(cache_key, ttl=METEOFRANCE_METADATA_CACHE_TTL_SECONDS)
    if cached is not None:
        parsed = dict(cached["payload"])
        parsed["metadata_cache_hit"] = True
        return parsed

    query = urllib.parse.urlencode(
        {
            "service": "WCS",
            "version": "2.0.1",
            "coverageID": coverage_id,
        }
    )
    status, content_type, raw = _fetch_meteofrance_bytes(
        api_key,
        f"{METEOFRANCE_AROME_WCS_DESCRIBE_URL}?{query}",
        "application/xml,text/xml,*/*",
        METEOFRANCE_WCS_READ_LIMIT_BYTES,
    )
    parsed = _parse_meteofrance_describe_coverage(raw)
    parsed["status"] = status
    parsed["content_type"] = content_type
    parsed["metadata_cache_hit"] = False
    _set_cached_value(cache_key, parsed)
    return dict(parsed)


def _select_meteofrance_time_subset(axis_values: list[str]) -> str:
    numbers = []
    for value in axis_values:
        try:
            numbers.append(int(float(value)))
        except ValueError:
            continue
    if not numbers:
        return "3600"
    positives = [value for value in numbers if value > 0]
    if 3600 in positives:
        return "3600"
    return str(positives[0] if positives else numbers[0])


def _select_meteofrance_height_subset(axis_values: list[str], preferred: str = "2") -> str:
    normalized = {value.strip(): value.strip() for value in axis_values if value.strip()}
    return normalized.get(preferred, next(iter(normalized.values()), preferred))


def _sample_bbox(lat: float, lon: float, half_box_km: float) -> tuple[float, float, float, float]:
    half_lat = half_box_km / 111.0
    cos_lat = max(0.2, math.cos(math.radians(lat)))
    half_lon = half_box_km / (111.0 * cos_lat)
    south = max(37.5, lat - half_lat)
    north = min(55.4, lat + half_lat)
    west = max(-12.0, lon - half_lon)
    east = min(16.0, lon + half_lon)
    return south, north, west, east


def _build_meteofrance_getcoverage_url(
    coverage_id: str,
    *,
    lat: float,
    lon: float,
    half_box_km: float,
    time_subset: str,
    height_subset: str | None,
    output_format: str = "image/tiff",
) -> tuple[str, dict[str, Any]]:
    south, north, west, east = _sample_bbox(lat, lon, half_box_km)
    return _build_meteofrance_getcoverage_url_for_bbox(
        coverage_id,
        south=south,
        north=north,
        west=west,
        east=east,
        time_subset=time_subset,
        height_subset=height_subset,
        output_format=output_format,
    )


def _build_meteofrance_getcoverage_url_for_bbox(
    coverage_id: str,
    *,
    south: float,
    north: float,
    west: float,
    east: float,
    time_subset: str,
    height_subset: str | None,
    output_format: str = "image/tiff",
) -> tuple[str, dict[str, Any]]:
    return _build_meteofrance_getcoverage_url_for_bbox_time_subsets(
        coverage_id,
        south=south,
        north=north,
        west=west,
        east=east,
        time_subsets=[time_subset],
        height_subset=height_subset,
        output_format=output_format,
    )


def _build_meteofrance_getcoverage_url_for_bbox_time_subsets(
    coverage_id: str,
    *,
    south: float,
    north: float,
    west: float,
    east: float,
    time_subsets: list[str],
    height_subset: str | None,
    output_format: str = "image/tiff",
) -> tuple[str, dict[str, Any]]:
    params = [
        ("service", "WCS"),
        ("version", "2.0.1"),
        ("coverageid", coverage_id),
    ]
    for time_subset in time_subsets:
        params.append(("subset", f"time({time_subset})"))
    if height_subset is not None:
        params.append(("subset", f"height({height_subset})"))
    params.extend(
        [
            ("subset", f"lat({south:.5f},{north:.5f})"),
            ("subset", f"long({west:.5f},{east:.5f})"),
            ("format", output_format),
        ]
    )
    url = f"{METEOFRANCE_AROME_WCS_COVERAGE_URL}?{urllib.parse.urlencode(params)}"
    time_value: str | list[str] = time_subsets[0] if len(time_subsets) == 1 else list(time_subsets)
    return url, {
        "south": south,
        "north": north,
        "west": west,
        "east": east,
        "time": time_value,
        "time_subsets": list(time_subsets),
        "height": height_subset,
        "format": output_format,
    }


def _tiff_type_size(type_id: int) -> int:
    return {
        1: 1,
        2: 1,
        3: 2,
        4: 4,
        5: 8,
        11: 4,
        12: 8,
    }.get(type_id, 0)


def _read_tiff_values(raw: bytes, endian: str, type_id: int, count: int, value_offset: int) -> list[Any]:
    size = _tiff_type_size(type_id)
    total = size * count
    if total <= 4:
        data = raw[value_offset:value_offset + 4][:total]
    else:
        data = raw[value_offset:value_offset + total]
    if len(data) < total:
        return []
    if type_id == 1:
        return list(data)
    if type_id == 2:
        return [data.rstrip(b"\x00").decode("ascii", errors="replace")]
    if type_id == 3:
        return list(struct.unpack(f"{endian}{count}H", data))
    if type_id == 4:
        return list(struct.unpack(f"{endian}{count}I", data))
    if type_id == 5:
        unpacked = struct.unpack(f"{endian}{count * 2}I", data)
        return [unpacked[i] / unpacked[i + 1] if unpacked[i + 1] else None for i in range(0, len(unpacked), 2)]
    if type_id == 11:
        return list(struct.unpack(f"{endian}{count}f", data))
    if type_id == 12:
        return list(struct.unpack(f"{endian}{count}d", data))
    return []


def _parse_tiff_ifd(raw: bytes) -> tuple[str, dict[int, list[Any]]]:
    if len(raw) < 8:
        raise ValueError("TIFF trop court.")
    if raw[:2] == b"II":
        endian = "<"
    elif raw[:2] == b"MM":
        endian = ">"
    else:
        raise ValueError("Signature TIFF absente.")
    magic = struct.unpack(f"{endian}H", raw[2:4])[0]
    if magic != 42:
        raise ValueError("BigTIFF ou format TIFF non supporté.")
    ifd_offset = struct.unpack(f"{endian}I", raw[4:8])[0]
    if ifd_offset + 2 > len(raw):
        raise ValueError("IFD TIFF hors limites.")
    entry_count = struct.unpack(f"{endian}H", raw[ifd_offset:ifd_offset + 2])[0]
    pos = ifd_offset + 2
    tags: dict[int, list[Any]] = {}
    for _ in range(entry_count):
        if pos + 12 > len(raw):
            break
        tag, type_id, count = struct.unpack(f"{endian}HHI", raw[pos:pos + 8])
        value_bytes = raw[pos + 8:pos + 12]
        size = _tiff_type_size(type_id)
        if size * count <= 4:
            value_offset = pos + 8
        else:
            value_offset = struct.unpack(f"{endian}I", value_bytes)[0]
        tags[tag] = _read_tiff_values(raw, endian, type_id, count, value_offset)
        pos += 12
    return endian, tags


def _tiff_header(raw: bytes) -> tuple[str, int] | None:
    if len(raw) < 8:
        return None
    if raw[:2] == b"II":
        endian = "<"
    elif raw[:2] == b"MM":
        endian = ">"
    else:
        return None
    magic = struct.unpack(f"{endian}H", raw[2:4])[0]
    if magic != 42:
        return None
    return endian, struct.unpack(f"{endian}I", raw[4:8])[0]


def _parse_tiff_ifd_at(raw: bytes, endian: str, ifd_offset: int) -> tuple[dict[int, list[Any]], int]:
    if ifd_offset <= 0 or ifd_offset + 2 > len(raw):
        return {}, 0
    entry_count = struct.unpack(f"{endian}H", raw[ifd_offset:ifd_offset + 2])[0]
    pos = ifd_offset + 2
    tags: dict[int, list[Any]] = {}
    for _ in range(entry_count):
        if pos + 12 > len(raw):
            return tags, 0
        tag, type_id, count = struct.unpack(f"{endian}HHI", raw[pos:pos + 8])
        value_bytes = raw[pos + 8:pos + 12]
        size = _tiff_type_size(type_id)
        if size * count <= 4:
            value_offset = pos + 8
        else:
            value_offset = struct.unpack(f"{endian}I", value_bytes)[0]
        tags[tag] = _read_tiff_values(raw, endian, type_id, count, value_offset)
        pos += 12
    if pos + 4 > len(raw):
        return tags, 0
    return tags, struct.unpack(f"{endian}I", raw[pos:pos + 4])[0]


def _inspect_tiff_structure(raw: bytes, max_ifds: int = 32) -> dict[str, Any]:
    header = _tiff_header(raw)
    if header is None:
        return {
            "is_tiff": False,
            "ifd_count": 0,
            "ifds": [],
            "signature_hex": raw[:16].hex(),
        }

    endian, ifd_offset = header
    ifds = []
    seen_offsets = set()
    while ifd_offset and ifd_offset not in seen_offsets and len(ifds) < max_ifds:
        seen_offsets.add(ifd_offset)
        tags, next_offset = _parse_tiff_ifd_at(raw, endian, ifd_offset)
        if not tags:
            break
        strip_byte_counts = [int(value) for value in tags.get(279, []) if value is not None]
        ifds.append(
            {
                "offset": ifd_offset,
                "width": int(tags.get(256, [0])[0] or 0),
                "height": int(tags.get(257, [0])[0] or 0),
                "bits_per_sample": tags.get(258, []),
                "sample_format": tags.get(339, []),
                "samples_per_pixel": int(tags.get(277, [1])[0] or 1),
                "compression": int(tags.get(259, [1])[0] or 1),
                "strip_count": len(tags.get(273, [])),
                "strip_byte_count_total": sum(strip_byte_counts),
            }
        )
        ifd_offset = next_offset

    first = ifds[0] if ifds else {}
    return {
        "is_tiff": True,
        "ifd_count": len(ifds),
        "ifds": ifds,
        "truncated_ifd_list": bool(ifd_offset and len(ifds) >= max_ifds),
        "first_width": first.get("width"),
        "first_height": first.get("height"),
        "first_samples_per_pixel": first.get("samples_per_pixel"),
    }


def _extract_geotiff_center_sample(raw: bytes) -> dict[str, Any]:
    endian, tags = _parse_tiff_ifd(raw)
    width = int(tags.get(256, [0])[0] or 0)
    height = int(tags.get(257, [0])[0] or 0)
    bits_per_sample = int(tags.get(258, [0])[0] or 0)
    compression = int(tags.get(259, [1])[0] or 1)
    strip_offsets = [int(value) for value in tags.get(273, [])]
    rows_per_strip = int(tags.get(278, [height or 0])[0] or 0)
    strip_byte_counts = [int(value) for value in tags.get(279, [])]
    sample_format = int(tags.get(339, [1])[0] or 1)
    samples_per_pixel = int(tags.get(277, [1])[0] or 1)
    no_data = tags.get(42113, [None])[0]

    parsed = {
        "width": width,
        "height": height,
        "bits_per_sample": bits_per_sample,
        "sample_format": sample_format,
        "compression": compression,
        "samples_per_pixel": samples_per_pixel,
        "no_data": no_data,
        "center_value": None,
        "temperature_c": None,
        "readable": False,
    }
    if not width or not height or not strip_offsets or compression != 1 or samples_per_pixel != 1:
        return parsed

    bytes_per_sample = bits_per_sample // 8
    if bytes_per_sample <= 0:
        return parsed
    row = height // 2
    col = width // 2
    strip_index = min(len(strip_offsets) - 1, row // max(1, rows_per_strip))
    row_in_strip = row - (strip_index * max(1, rows_per_strip))
    offset = strip_offsets[strip_index] + ((row_in_strip * width) + col) * bytes_per_sample
    if offset + bytes_per_sample > len(raw):
        return parsed

    data = raw[offset:offset + bytes_per_sample]
    if sample_format == 3 and bits_per_sample == 32:
        value = struct.unpack(f"{endian}f", data)[0]
    elif sample_format == 3 and bits_per_sample == 64:
        value = struct.unpack(f"{endian}d", data)[0]
    elif sample_format in (1, 0) and bits_per_sample == 16:
        value = struct.unpack(f"{endian}H", data)[0]
    elif sample_format in (1, 0) and bits_per_sample == 32:
        value = struct.unpack(f"{endian}I", data)[0]
    elif sample_format == 2 and bits_per_sample == 16:
        value = struct.unpack(f"{endian}h", data)[0]
    elif sample_format == 2 and bits_per_sample == 32:
        value = struct.unpack(f"{endian}i", data)[0]
    else:
        return parsed

    parsed["center_value"] = round(float(value), 4)
    parsed["readable"] = True
    if float(value) > 170:
        parsed["temperature_c"] = round(float(value) - 273.15, 2)
    else:
        parsed["temperature_c"] = round(float(value), 2)
    return parsed


def _tiff_sample_value(raw: bytes, endian: str, sample_format: int, bits_per_sample: int, offset: int) -> float | None:
    bytes_per_sample = bits_per_sample // 8
    if bytes_per_sample <= 0 or offset + bytes_per_sample > len(raw):
        return None
    data = raw[offset:offset + bytes_per_sample]
    if sample_format == 3 and bits_per_sample == 32:
        return float(struct.unpack(f"{endian}f", data)[0])
    if sample_format == 3 and bits_per_sample == 64:
        return float(struct.unpack(f"{endian}d", data)[0])
    if sample_format in (1, 0) and bits_per_sample == 16:
        return float(struct.unpack(f"{endian}H", data)[0])
    if sample_format in (1, 0) and bits_per_sample == 32:
        return float(struct.unpack(f"{endian}I", data)[0])
    if sample_format == 2 and bits_per_sample == 16:
        return float(struct.unpack(f"{endian}h", data)[0])
    if sample_format == 2 and bits_per_sample == 32:
        return float(struct.unpack(f"{endian}i", data)[0])
    return None


def _nodata_value(raw_no_data: Any) -> float | None:
    if raw_no_data is None:
        return None
    try:
        return float(str(raw_no_data).strip())
    except (TypeError, ValueError):
        return None


def _is_nodata(value: float | None, no_data: float | None) -> bool:
    if value is None or not math.isfinite(value):
        return True
    if no_data is None:
        return False
    return abs(value - no_data) <= max(1e-6, abs(no_data) * 1e-9)


def _extract_geotiff_raster(raw: bytes) -> dict[str, Any]:
    endian, tags = _parse_tiff_ifd(raw)
    width = int(tags.get(256, [0])[0] or 0)
    height = int(tags.get(257, [0])[0] or 0)
    bits_per_sample = int(tags.get(258, [0])[0] or 0)
    compression = int(tags.get(259, [1])[0] or 1)
    strip_offsets = [int(value) for value in tags.get(273, [])]
    rows_per_strip = int(tags.get(278, [height or 0])[0] or 0)
    sample_format = int(tags.get(339, [1])[0] or 1)
    samples_per_pixel = int(tags.get(277, [1])[0] or 1)
    no_data = _nodata_value(tags.get(42113, [None])[0])
    raster = {
        "width": width,
        "height": height,
        "bits_per_sample": bits_per_sample,
        "sample_format": sample_format,
        "compression": compression,
        "samples_per_pixel": samples_per_pixel,
        "no_data": no_data,
        "values": [],
        "readable": False,
    }
    if not width or not height or not strip_offsets or compression != 1 or samples_per_pixel != 1:
        return raster

    bytes_per_sample = bits_per_sample // 8
    if bytes_per_sample <= 0:
        return raster

    values: list[float | None] = []
    rows_per_strip = max(1, rows_per_strip)
    for row in range(height):
        strip_index = min(len(strip_offsets) - 1, row // rows_per_strip)
        row_in_strip = row - (strip_index * rows_per_strip)
        row_offset = strip_offsets[strip_index] + (row_in_strip * width * bytes_per_sample)
        for col in range(width):
            value = _tiff_sample_value(raw, endian, sample_format, bits_per_sample, row_offset + (col * bytes_per_sample))
            values.append(None if _is_nodata(value, no_data) else value)

    raster["values"] = values
    raster["readable"] = len(values) == width * height
    return raster


def _sample_geotiff_raster_nearest(raster: dict[str, Any], *, lat: float, lon: float, bbox: dict[str, float]) -> float | None:
    if not raster.get("readable"):
        return None
    width = int(raster.get("width") or 0)
    height = int(raster.get("height") or 0)
    values = raster.get("values") or []
    if not width or not height or len(values) != width * height:
        return None
    west = float(bbox["west"])
    east = float(bbox["east"])
    south = float(bbox["south"])
    north = float(bbox["north"])
    if east <= west or north <= south:
        return None
    col = round((lon - west) / (east - west) * (width - 1))
    row = round((north - lat) / (north - south) * (height - 1))
    col = max(0, min(width - 1, int(col)))
    row = max(0, min(height - 1, int(row)))
    value = values[row * width + col]
    return float(value) if value is not None else None


def _bbox_for_grid_points(points: list[Any]) -> dict[str, float]:
    south = min(point.lat - point.cell_height_deg / 2 for point in points)
    north = max(point.lat + point.cell_height_deg / 2 for point in points)
    west = min(point.lon - point.cell_width_deg / 2 for point in points)
    east = max(point.lon + point.cell_width_deg / 2 for point in points)
    return {
        "south": max(37.5, south),
        "north": min(55.4, north),
        "west": max(-12.0, west),
        "east": min(16.0, east),
    }


def _parse_meteofrance_datetime(value: str | None) -> datetime | None:
    if not value:
        return None
    text = value.strip()
    if text.endswith("Z"):
        text = f"{text[:-1]}+00:00"
    if "T" in text:
        date_part, time_part = text.split("T", 1)
        if "." in time_part[:8] and ":" not in time_part[:8]:
            time_part = time_part.replace(".", ":", 1).replace(".", ":", 1)
            text = f"{date_part}T{time_part}"
    try:
        dt = datetime.fromisoformat(text)
    except ValueError:
        return None
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt.astimezone(timezone.utc)


def _select_meteofrance_time_subset_for_hour(description: dict[str, Any], target_date: Date, hour: int) -> tuple[str, dict[str, Any]]:
    axis_values = description.get("axes", {}).get("time", [])
    numbers = []
    for value in axis_values:
        try:
            numbers.append(int(float(value)))
        except ValueError:
            continue
    if not numbers:
        selected = _select_meteofrance_time_subset(axis_values)
        return selected, {"selected": selected, "target_offset_seconds": None, "delta_seconds": None}

    begin = _parse_meteofrance_datetime(description.get("begin_position"))
    if begin is None:
        selected_number = 3600 if 3600 in numbers else numbers[0]
        return str(selected_number), {"selected": str(selected_number), "target_offset_seconds": None, "delta_seconds": None}

    target_local = datetime.combine(target_date, Time(hour=hour), tzinfo=ZoneInfo("Europe/Paris"))
    target_utc = target_local.astimezone(timezone.utc)
    target_offset = int(round((target_utc - begin).total_seconds()))
    selected_number = min(numbers, key=lambda value: abs(value - target_offset))
    return str(selected_number), {
        "selected": str(selected_number),
        "target_offset_seconds": target_offset,
        "delta_seconds": selected_number - target_offset,
        "target_utc": target_utc.isoformat(),
        "begin_utc": begin.isoformat(),
    }


def _select_meteofrance_time_range_subset_for_hours(description: dict[str, Any], target_date: Date, start_hour: int, end_hour: int) -> tuple[str, dict[str, Any]]:
    start_hour = max(0, min(23, int(start_hour)))
    end_hour = max(0, min(23, int(end_hour)))
    if end_hour < start_hour:
        start_hour, end_hour = end_hour, start_hour

    axis_values = description.get("axes", {}).get("time", [])
    numbers = []
    for value in axis_values:
        try:
            numbers.append(int(float(value)))
        except ValueError:
            continue
    numbers = sorted(set(numbers))
    if not numbers:
        selected = _select_meteofrance_time_subset(axis_values)
        return f"{selected},{selected}", {
            "selected": f"{selected},{selected}",
            "start_offset_seconds": None,
            "end_offset_seconds": None,
            "start_delta_seconds": None,
            "end_delta_seconds": None,
        }

    begin = _parse_meteofrance_datetime(description.get("begin_position"))
    if begin is None:
        selected_start = numbers[0]
        selected_end = numbers[-1]
        return f"{selected_start},{selected_end}", {
            "selected": f"{selected_start},{selected_end}",
            "start_offset_seconds": None,
            "end_offset_seconds": None,
            "start_delta_seconds": None,
            "end_delta_seconds": None,
        }

    start_local = datetime.combine(target_date, Time(hour=start_hour), tzinfo=ZoneInfo("Europe/Paris"))
    end_local = datetime.combine(target_date, Time(hour=end_hour), tzinfo=ZoneInfo("Europe/Paris"))
    start_utc = start_local.astimezone(timezone.utc)
    end_utc = end_local.astimezone(timezone.utc)
    start_offset = int(round((start_utc - begin).total_seconds()))
    end_offset = int(round((end_utc - begin).total_seconds()))
    selected_start = min(numbers, key=lambda value: abs(value - start_offset))
    selected_end = min(numbers, key=lambda value: abs(value - end_offset))
    if selected_end < selected_start:
        selected_start, selected_end = selected_end, selected_start
    selected = f"{selected_start},{selected_end}"
    return selected, {
        "selected": selected,
        "start_hour": start_hour,
        "end_hour": end_hour,
        "start_offset_seconds": start_offset,
        "end_offset_seconds": end_offset,
        "start_delta_seconds": selected_start - start_offset,
        "end_delta_seconds": selected_end - end_offset,
        "start_utc": start_utc.isoformat(),
        "end_utc": end_utc.isoformat(),
        "begin_utc": begin.isoformat(),
        "available_time_values_count": len(numbers),
    }


def _height_subset_for_description(description: dict[str, Any], preferred: str | None) -> str | None:
    height_values = description.get("axes", {}).get("height", [])
    if not height_values:
        return None
    return _select_meteofrance_height_subset(height_values, preferred or height_values[0])


def _convert_meteofrance_value(field: str, value: float | None) -> float | None:
    if value is None or not math.isfinite(float(value)):
        if field == "convective_inhibition":
            return None
        return 0.0
    converted = float(value)
    if field in {"temperature_2m", "dew_point_2m"} and converted > 170:
        converted -= 273.15
    if field in {"relative_humidity_2m", "cloud_cover_low", "cloud_cover_mid", "cloud_cover_high"} and 0 <= converted <= 1.5:
        converted *= 100.0
    if field.startswith("wind_direction_"):
        converted %= 360.0
    if field == "precipitation_rate":
        converted = max(0.0, converted)
    return round(converted, 2)


def _saturation_vapour_pressure_kpa(temp_c: float) -> float:
    return 0.6108 * math.exp((17.27 * temp_c) / (temp_c + 237.3))


def _relative_humidity_from_dewpoint_c(temp_c: float | None, dewpoint_c: float | None) -> float | None:
    if temp_c is None or dewpoint_c is None:
        return None
    try:
        temp = float(temp_c)
        dew = float(dewpoint_c)
    except Exception:
        return None
    if not math.isfinite(temp) or not math.isfinite(dew):
        return None
    saturation = _saturation_vapour_pressure_kpa(temp)
    if saturation <= 0:
        return None
    actual = _saturation_vapour_pressure_kpa(dew)
    return round(max(0.0, min(100.0, (actual / saturation) * 100.0)), 1)


def _vapour_pressure_deficit_kpa(temp_c: float, dewpoint_c: float) -> float:
    return round(max(0.0, _saturation_vapour_pressure_kpa(temp_c) - _saturation_vapour_pressure_kpa(dewpoint_c)), 2)


def _wet_bulb_stull_c(temp_c: float, rh_percent: float) -> float:
    rh = max(1.0, min(100.0, rh_percent))
    wetbulb = (
        temp_c * math.atan(0.151977 * math.sqrt(rh + 8.313659))
        + math.atan(temp_c + rh)
        - math.atan(rh - 1.676331)
        + 0.00391838 * rh ** 1.5 * math.atan(0.023101 * rh)
        - 4.686035
    )
    return round(wetbulb, 2)


def _build_meteofrance_slot_grid_sync(
    api_key: str,
    lat: float,
    lon: float,
    label: str,
    target_date: Date,
    hour: int,
    detail_level: str = METEOFRANCE_SLOT_GRID_CORE_DETAIL,
) -> dict[str, Any]:
    target = "AROME WCS grille ObjectiFoudre 1 h"
    try:
        detail_level = _meteofrance_slot_grid_detail_level(detail_level)
        active_specs, skipped_optional = _meteofrance_slot_grid_specs_for_detail(detail_level)
        date_status = _meteofrance_arome_wcs_grid_date_status(target_date)
        if not date_status["ok"]:
            return {
                "ok": False,
                "status": 400,
                "message": date_status["message"],
                "target": target,
                "supported_start": date_status["supported_start"],
                "supported_until": date_status["supported_until"],
            }

        cache_key = _meteofrance_slot_grid_cache_key(api_key, lat, lon, label, target_date, hour, detail_level)
        cached = _get_cached_value(cache_key, ttl=METEOFRANCE_SLOT_GRID_CACHE_TTL_SECONDS)
        if cached is not None:
            result = copy.deepcopy(cached["payload"])
            result["cache_hit"] = True
            if isinstance(result.get("payload"), dict):
                meta = dict(result["payload"].get("meta", {}))
                cached_count = int(meta.get("cached_coverage_request_count") or meta.get("coverage_request_count") or 0)
                meta["slot_grid_cache_hit"] = True
                meta["slot_grid_cache_ttl_seconds"] = METEOFRANCE_SLOT_GRID_CACHE_TTL_SECONDS
                meta["cached_coverage_request_count"] = cached_count
                meta["coverage_request_count"] = 0
                result["payload"]["meta"] = meta
                cell_count = _slot_payload_cell_count(result["payload"], hour)
                result["message"] = f"Grille Météo-France WCS servie depuis le cache pour {hour:02d}h : {cell_count} cellules."
            return result

        points = build_grid(center_lat=lat, center_lon=lon, zone_prefix=label)
        bbox = _bbox_for_grid_points(points)
        capabilities = _build_meteofrance_wcs_capabilities(api_key)
        latest_by_prefix = capabilities.get("latest_by_prefix", {})
        descriptions: dict[str, dict[str, Any]] = {}
        rasters: dict[str, dict[str, Any]] = {}
        coverage_requests: list[dict[str, Any]] = []
        missing: list[str] = []
        optional_missing: list[str] = []

        for spec in active_specs:
            field = spec["field"]
            coverage_id, resolved_prefix = _resolve_meteofrance_coverage_id(latest_by_prefix, spec)
            if not coverage_id:
                if spec.get("optional"):
                    optional_missing.append(field)
                else:
                    missing.append(field)
                continue
            description = descriptions.get(coverage_id)
            if description is None:
                description = _describe_meteofrance_coverage(api_key, coverage_id)
                descriptions[coverage_id] = description
            time_subset, time_meta = _select_meteofrance_time_subset_for_hour(description, target_date, hour)
            height_subset = _height_subset_for_description(description, spec.get("height"))
            raster_key = f"{coverage_id}|{height_subset or '-'}|{time_subset}"
            if raster_key not in rasters:
                coverage_url, request_meta = _build_meteofrance_getcoverage_url_for_bbox(
                    coverage_id,
                    south=bbox["south"],
                    north=bbox["north"],
                    west=bbox["west"],
                    east=bbox["east"],
                    time_subset=time_subset,
                    height_subset=height_subset,
                )
                status, content_type, raw = _fetch_meteofrance_bytes(
                    api_key,
                    coverage_url,
                    "image/tiff,application/octet-stream,*/*",
                    METEOFRANCE_COVERAGE_READ_LIMIT_BYTES,
                )
                raster = _extract_geotiff_raster(raw)
                raster.update(
                    {
                        "status": status,
                        "content_type": content_type,
                        "byte_count": len(raw),
                        "coverage_id": coverage_id,
                        "request": request_meta,
                        "time": time_meta,
                    }
                )
                rasters[raster_key] = raster
                coverage_requests.append(
                    {
                        "field": field,
                        "coverage_id": coverage_id,
                        "coverage_prefix": resolved_prefix,
                        "height": height_subset,
                        "time": time_subset,
                        "readable": bool(raster.get("readable")),
                        "width": raster.get("width"),
                        "height_px": raster.get("height"),
                        "byte_count": len(raw),
                        "delta_seconds": time_meta.get("delta_seconds"),
                        "optional": bool(spec.get("optional")),
                    }
                )
            rasters[field] = rasters[raster_key]

        if not any(rasters.get(spec["field"], {}).get("readable") for spec in active_specs):
            return {
                "ok": False,
                "status": capabilities.get("status"),
                "message": "Aucun GeoTIFF WCS lisible pour construire la grille Météo-France.",
                "target": target,
                "missing": missing,
                "coverage_requests": coverage_requests,
                "detail_level": detail_level,
                "skipped_optional_fields": skipped_optional,
            }

        slot_dt = datetime.combine(target_date, Time(hour=hour), tzinfo=ZoneInfo("Europe/Paris"))
        grid_locations = []
        wind_direction_10m_ready = bool(rasters.get("wind_direction_10m", {}).get("readable"))
        for point in points:
            hourly = {
                "time": [slot_dt.isoformat()],
                "cape": [0.0],
                "temperature_2m": [0.0],
                "dew_point_2m": [0.0],
                "convective_inhibition": [None],
                "relative_humidity_2m": [0.0],
                "vapour_pressure_deficit": [0.0],
                "wet_bulb_temperature_2m": [0.0],
                "cloud_cover_low": [0.0],
                "cloud_cover_mid": [0.0],
                "cloud_cover_high": [0.0],
                "wind_gusts_10m": [0.0],
                "wind_speed_10m": [0.0],
                "wind_speed_100m": [0.0],
                "wind_direction_10m": [0.0],
                "wind_direction_10m_available": [False],
                "wind_direction_100m": [0.0],
            }
            for spec in active_specs:
                field = spec["field"]
                raster = rasters.get(field)
                if not raster:
                    continue
                raw_value = _sample_geotiff_raster_nearest(raster, lat=point.lat, lon=point.lon, bbox=bbox)
                hourly[field] = [_convert_meteofrance_value(field, raw_value)]

            temp_c = float(hourly["temperature_2m"][0] or 0)
            dewpoint_c = float(hourly["dew_point_2m"][0] or 0)
            rh2m = float(hourly["relative_humidity_2m"][0] or 0)
            hourly["vapour_pressure_deficit"] = [_vapour_pressure_deficit_kpa(temp_c, dewpoint_c)]
            hourly["wet_bulb_temperature_2m"] = [_wet_bulb_stull_c(temp_c, rh2m)]
            hourly["wind_direction_10m_available"] = [wind_direction_10m_ready]
            grid_locations.append({"hourly": hourly, "models": METEOFRANCE_SLOT_MODEL_NAME})

        rows = rows_for_grid_locations(points, grid_locations)
        payload = group_for_output(rows, lat, lon, label, target_date=target_date, model_name=METEOFRANCE_SLOT_MODEL_NAME)
        for day in payload.get("days", []):
            for slot in day.get("slots", []):
                for cell in slot.get("cells", []):
                    cell["source_provider"] = "meteofrance_arome_wcs"
                    cell["source_label"] = "Météo-France AROME WCS direct"
        meta = dict(payload.get("meta", {}))
        wind_direction_ready = all(
            bool(rasters.get(field, {}).get("readable"))
            for field in ("wind_direction_10m", "wind_direction_100m")
        )
        meta.update(
            {
                "provider": "meteofrance_arome_wcs",
                "source_provider": "meteofrance_arome_wcs",
                "source_label": "Météo-France AROME WCS direct",
                "migration_probe": True,
                "requested_hour": hour,
                "requested_slot": f"h{hour:02d}",
                "detail_level": detail_level,
                "coverage_request_count": len(coverage_requests),
                "coverage_requests": coverage_requests,
                "missing_fields": missing,
                "optional_missing_fields": optional_missing,
                "skipped_optional_fields": skipped_optional,
                "metadata_cache_ttl_seconds": METEOFRANCE_METADATA_CACHE_TTL_SECONDS,
                "slot_grid_cache_hit": False,
                "slot_grid_cache_ttl_seconds": METEOFRANCE_SLOT_GRID_CACHE_TTL_SECONDS,
                "capabilities_cache_hit": bool(capabilities.get("metadata_cache_hit")),
                "description_count": len(descriptions),
                "description_cache_hit_count": sum(1 for item in descriptions.values() if item.get("metadata_cache_hit")),
                "wcs_supported_start": date_status["supported_start"],
                "wcs_supported_until": date_status["supported_until"],
                "wind_direction_ready": wind_direction_ready,
                "warning": (
                    "Grille Météo-France WCS avancée : CIN et directions de vent sont demandés seulement s'ils existent dans le catalogue."
                    if detail_level == METEOFRANCE_SLOT_GRID_ADVANCED_DETAIL and wind_direction_ready
                    else "Grille Météo-France WCS avancée : les champs optionnels absents restent vides et le shear utilise les vitesses sans direction si besoin."
                    if detail_level == METEOFRANCE_SLOT_GRID_ADVANCED_DETAIL
                    else "Grille Météo-France WCS allégée : seules les couvertures nécessaires au score de base sont demandées."
                ),
            }
        )
        payload["meta"] = meta
        result = {
            "ok": True,
            "status": capabilities.get("status"),
            "message": f"Grille Météo-France WCS générée pour {hour:02d}h : {len(rows)} cellules.",
            "target": target,
            "payload": payload,
            "cache_hit": False,
        }
        _set_cached_value(cache_key, result)
        return result
    except Exception as exc:
        return _meteofrance_failure_result(exc, target)


def _sample_meteofrance_temperature_coverage_sync(api_key: str, lat: float, lon: float, half_box_km: float) -> dict[str, Any]:
    target = "AROME WCS GetCoverage température 2 m"
    try:
        capabilities = _build_meteofrance_wcs_capabilities(api_key)
        coverage_id = capabilities["latest_by_prefix"].get(METEOFRANCE_SAMPLE_COVERAGE_PREFIX)
        if not coverage_id:
            return {
                "ok": False,
                "status": capabilities.get("status"),
                "message": "Coverage température 2 m introuvable dans le catalogue WCS.",
                "target": target,
            }
        description = _describe_meteofrance_coverage(api_key, coverage_id)
        axes = description.get("axes", {})
        time_subset = _select_meteofrance_time_subset(axes.get("time", []))
        height_subset = _select_meteofrance_height_subset(axes.get("height", []), "2")
        coverage_url, request_meta = _build_meteofrance_getcoverage_url(
            coverage_id,
            lat=lat,
            lon=lon,
            half_box_km=half_box_km,
            time_subset=time_subset,
            height_subset=height_subset,
        )
        status, content_type, raw = _fetch_meteofrance_bytes(
            api_key,
            coverage_url,
            "image/tiff,application/octet-stream,*/*",
            METEOFRANCE_COVERAGE_READ_LIMIT_BYTES,
        )
        sample = {}
        parse_error = None
        try:
            sample = _extract_geotiff_center_sample(raw)
        except Exception as exc:
            parse_error = str(exc)
        readable = bool(sample.get("readable"))
        temperature = sample.get("temperature_c")
        message = (
            f"GetCoverage OK : GeoTIFF reçu, valeur centre ≈ {temperature} °C."
            if readable and temperature is not None
            else "GetCoverage OK : fichier reçu, extraction GeoTIFF à compléter pour ce raster."
        )
        return {
            "ok": bool(200 <= status < 300),
            "status": status,
            "message": message,
            "target": target,
            "content_type": content_type,
            "byte_count": len(raw),
            "coverage_id": coverage_id,
            "request": request_meta,
            "description": {
                "begin_position": description.get("begin_position"),
                "end_position": description.get("end_position"),
                "height_values": axes.get("height", []),
                "time_values_count": len(axes.get("time", [])),
            },
            "sample": sample,
            "parse_error": parse_error,
        }
    except Exception as exc:
        return _meteofrance_failure_result(exc, target)


def _meteofrance_multitime_probe_variants(range_subset: str) -> list[dict[str, Any]]:
    parts = [part.strip() for part in range_subset.split(",", 1)]
    if len(parts) != 2 or not parts[0] or not parts[1]:
        return [{"name": "single", "label": "single", "time_subsets": [range_subset], "multi": False}]
    start, end = parts
    return [
        {
            "name": "numeric_range",
            "label": f"time({start},{end})",
            "time_subsets": [f"{start},{end}"],
            "multi": True,
        },
        {
            "name": "quoted_numeric_range",
            "label": f'time("{start}","{end}")',
            "time_subsets": [f'"{start}","{end}"'],
            "multi": True,
        },
        {
            "name": "repeated_bounds",
            "label": f"time({start}) + time({end})",
            "time_subsets": [start, end],
            "multi": True,
        },
        {
            "name": "single_start_control",
            "label": f"time({start})",
            "time_subsets": [start],
            "multi": False,
        },
    ]


def _probe_meteofrance_multitime_coverage_sync(
    api_key: str,
    lat: float,
    lon: float,
    target_date: Date,
    start_hour: int,
    end_hour: int,
    half_box_km: float,
) -> dict[str, Any]:
    target = "AROME WCS GetCoverage température 2 m multi-heures"
    try:
        date_status = _meteofrance_arome_wcs_grid_date_status(target_date)
        if not date_status["ok"]:
            return {
                "ok": False,
                "status": 400,
                "message": date_status["message"],
                "target": target,
                "supported_start": date_status["supported_start"],
                "supported_until": date_status["supported_until"],
            }

        capabilities = _build_meteofrance_wcs_capabilities(api_key)
        coverage_id = capabilities["latest_by_prefix"].get(METEOFRANCE_SAMPLE_COVERAGE_PREFIX)
        if not coverage_id:
            return {
                "ok": False,
                "status": capabilities.get("status"),
                "message": "Coverage température 2 m introuvable dans le catalogue WCS.",
                "target": target,
            }

        description = _describe_meteofrance_coverage(api_key, coverage_id)
        axes = description.get("axes", {})
        time_subset, time_meta = _select_meteofrance_time_range_subset_for_hours(description, target_date, start_hour, end_hour)
        height_subset = _select_meteofrance_height_subset(axes.get("height", []), "2")
        south, north, west, east = _sample_bbox(lat, lon, half_box_km)
        attempts = []
        successful_attempt: dict[str, Any] | None = None
        best_multi_attempt: dict[str, Any] | None = None

        for variant in _meteofrance_multitime_probe_variants(time_subset):
            coverage_url, request_meta = _build_meteofrance_getcoverage_url_for_bbox_time_subsets(
                coverage_id,
                south=south,
                north=north,
                west=west,
                east=east,
                time_subsets=variant["time_subsets"],
                height_subset=height_subset,
            )
            attempt = {
                "name": variant["name"],
                "label": variant["label"],
                "multi": bool(variant["multi"]),
                "request": request_meta,
                "ok": False,
                "status": None,
                "content_type": "",
                "byte_count": 0,
                "tiff": {},
                "sample": {},
                "parse_error": None,
                "preview": "",
            }
            try:
                status, content_type, raw = _fetch_meteofrance_bytes(
                    api_key,
                    coverage_url,
                    "image/tiff,application/octet-stream,*/*",
                    METEOFRANCE_COVERAGE_READ_LIMIT_BYTES,
                )
                tiff_info = _inspect_tiff_structure(raw)
                sample = {}
                parse_error = None
                if tiff_info.get("is_tiff"):
                    try:
                        sample = _extract_geotiff_center_sample(raw)
                    except Exception as exc:
                        parse_error = str(exc)
                attempt.update(
                    {
                        "ok": bool(200 <= status < 300),
                        "status": status,
                        "content_type": content_type,
                        "byte_count": len(raw),
                        "tiff": tiff_info,
                        "sample": sample,
                        "parse_error": parse_error,
                        "preview": "" if tiff_info.get("is_tiff") else _decode_response_preview(raw, limit=420),
                    }
                )
            except urllib.error.HTTPError as exc:
                raw = exc.read(2048)
                attempt.update(
                    {
                        "status": exc.code,
                        "content_type": exc.headers.get("content-type", "") if exc.headers else "",
                        "byte_count": len(raw),
                        "preview": _decode_response_preview(raw, limit=420),
                        "error": _meteofrance_http_message(exc.code),
                    }
                )
            attempts.append(attempt)
            if attempt["ok"] and successful_attempt is None:
                successful_attempt = attempt
            if attempt["multi"] and attempt["ok"] and int(attempt.get("tiff", {}).get("ifd_count") or 0) > 1:
                best_multi_attempt = attempt
                break

        selected_attempt = best_multi_attempt or successful_attempt or (attempts[0] if attempts else {})
        tiff_info = selected_attempt.get("tiff") or {}
        likely_multi_time = bool(best_multi_attempt)
        if best_multi_attempt:
            message = f"Multi-heures accepté : {best_multi_attempt['label']} renvoie un GeoTIFF avec {tiff_info.get('ifd_count')} images/IFD."
        elif successful_attempt and successful_attempt.get("multi"):
            message = f"Syntaxe multi-heures acceptée avec {successful_attempt['label']}, mais la réponse ne semble pas contenir plusieurs images."
        elif successful_attempt:
            message = "Les syntaxes multi-heures testées sont refusées ; le contrôle mono-heure fonctionne."
        else:
            message = "Les syntaxes multi-heures testées sont refusées par le backend WCS Météo-France."

        return {
            "ok": bool(successful_attempt),
            "status": selected_attempt.get("status"),
            "message": message,
            "target": target,
            "content_type": selected_attempt.get("content_type", ""),
            "byte_count": selected_attempt.get("byte_count", 0),
            "coverage_id": coverage_id,
            "request": selected_attempt.get("request", {}),
            "time": time_meta,
            "description": {
                "begin_position": description.get("begin_position"),
                "end_position": description.get("end_position"),
                "height_values": axes.get("height", []),
                "time_values_count": len(axes.get("time", [])),
            },
            "tiff": tiff_info,
            "sample": selected_attempt.get("sample", {}),
            "parse_error": selected_attempt.get("parse_error"),
            "preview": selected_attempt.get("preview", ""),
            "attempts": attempts,
            "likely_multi_time": likely_multi_time,
        }
    except Exception as exc:
        return _meteofrance_failure_result(exc, target)


def _purge_expired_cache(now: float | None = None) -> None:
    current = now or time.time()
    expired = [key for key, entry in _cache.items() if (current - float(entry.get("ts", 0))) >= STALE_TTL_SECONDS]
    for key in expired:
        _cache.pop(key, None)


def _analysis_csv(rows: list[dict[str, Any]]) -> str:
    base_fields = [
        'day_key','day_label','slot_key','slot_label','selected_time_iso','selected_hour','zone','lat','lon',
        'trigger_score','confidence_score','potentiel','confiance','analysis_rank','mucape','convective_inhibition',
        'relative_humidity_2m','vapour_pressure_deficit','wet_bulb_temperature_2m','temp_c','dewpoint_c',
        'analysis_mode','summary'
    ]
    metric_score_fields = [
        'cape_score','dewpoint_score','humidity_score','vpd_score','wetbulb_score','timing_score',
        'cin_actual_score','surface_trigger_score',
        'confidence_consistency_score','confidence_temporal_score','confidence_margin_score'
    ]
    breakdown_fields = [
        'probability_instability','probability_moisture','probability_timing','probability_inhibition_penalty',
        'confidence_consistency','confidence_temporal_stability','confidence_margin'
    ]
    header = base_fields + metric_score_fields + breakdown_fields + ['diagnostics']
    lines = [','.join(header)]
    for row in rows:
        metric_scores = row.get('metric_scores', {})
        breakdown = row.get('category_breakdown', {})
        probability = breakdown.get('probability', {})
        confidence = breakdown.get('confidence', {})
        mapped = {
            'probability_instability': probability.get('instability', ''),
            'probability_moisture': probability.get('moisture', ''),
            'probability_timing': probability.get('timing', ''),
            'probability_inhibition_penalty': probability.get('inhibition_penalty', ''),
            'confidence_consistency': confidence.get('consistency', ''),
            'confidence_temporal_stability': confidence.get('temporal_stability', ''),
            'confidence_margin': confidence.get('margin', ''),
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


@app.get("/styleguide")
def styleguide() -> FileResponse:
    # Page de validation visuelle du design system (dev). Charge /assets/dist/app.css.
    return FileResponse(STATIC_DIR / "styleguide.html", headers={"Cache-Control": "no-store, max-age=0"})


@app.get("/assets/dist/{filename:path}")
def asset_dist(filename: str) -> FileResponse:
    target = (DIST_DIR / filename).resolve()
    if not target.is_file() or DIST_DIR.resolve() not in target.parents:
        raise HTTPException(status_code=404, detail="Bundle asset not found")
    media_type = mimetypes.guess_type(str(target))[0] or "application/octet-stream"
    return FileResponse(target, media_type=media_type, headers={"Cache-Control": "public, max-age=300"})


@app.get("/assets/vendor/{filename:path}")
def asset_vendor(filename: str) -> FileResponse:
    target = (VENDOR_DIR / filename).resolve()
    if not target.is_file() or VENDOR_DIR.resolve() not in target.parents:
        raise HTTPException(status_code=404, detail="Vendor asset not found")
    media_type = mimetypes.guess_type(str(target))[0] or "application/octet-stream"
    return FileResponse(target, media_type=media_type, headers={"Cache-Control": "public, max-age=300"})


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


@app.get("/api/meteofrance/grib-decoder-status")
def meteofrance_grib_decoder_status() -> dict[str, Any]:
    return _detect_grib_decoder_status()


@app.post("/api/meteofrance/test-key")
async def meteofrance_test_key(payload: MeteoFranceKeyTestRequest) -> dict[str, Any]:
    _ensure_meteofrance_diagnostics_enabled("/api/meteofrance/test-key")
    api_key = _clean_meteofrance_api_key(payload.token)
    result = await asyncio.to_thread(_test_meteofrance_api_key_sync, api_key)
    return result


@app.post("/api/meteofrance/sample-coverage")
async def meteofrance_sample_coverage(payload: MeteoFranceCoverageSampleRequest) -> dict[str, Any]:
    _ensure_meteofrance_diagnostics_enabled("/api/meteofrance/sample-coverage")
    api_key = _clean_meteofrance_api_key(payload.token)
    result = await asyncio.to_thread(
        _sample_meteofrance_temperature_coverage_sync,
        api_key,
        payload.lat,
        payload.lon,
        payload.half_box_km,
    )
    return result


@app.post("/api/meteofrance/probe-multitime-coverage")
async def meteofrance_probe_multitime_coverage(payload: MeteoFranceMultiTimeCoverageProbeRequest) -> dict[str, Any]:
    _ensure_meteofrance_diagnostics_enabled("/api/meteofrance/probe-multitime-coverage")
    api_key = _clean_meteofrance_api_key(payload.token)
    result = await asyncio.to_thread(
        _probe_meteofrance_multitime_coverage_sync,
        api_key,
        payload.lat,
        payload.lon,
        payload.date,
        payload.start_hour,
        payload.end_hour,
        payload.half_box_km,
    )
    return result


@app.post("/api/meteofrance/probe-model-packages")
async def meteofrance_probe_model_packages(payload: MeteoFranceModelPackageProbeRequest) -> dict[str, Any]:
    _ensure_meteofrance_diagnostics_enabled("/api/meteofrance/probe-model-packages")
    api_key = _clean_meteofrance_api_key(payload.token)
    result = await asyncio.to_thread(
        _probe_meteofrance_model_packages_sync,
        api_key,
        payload.grid,
        payload.inspect_all,
        payload.max_inspected_packages,
    )
    return result


@app.post("/api/meteofrance/probe-grib-package")
async def meteofrance_probe_grib_package(payload: MeteoFranceGribPackageProbeRequest) -> dict[str, Any]:
    _ensure_meteofrance_diagnostics_enabled("/api/meteofrance/probe-grib-package")
    api_key = _clean_meteofrance_api_key(payload.token)
    result = await asyncio.to_thread(
        _probe_meteofrance_grib_package_sync,
        api_key,
        payload.grid,
        payload.package_id,
        payload.time_group,
        payload.range_bytes,
    )
    return result


@app.post("/api/meteofrance/probe-grib-full-package")
async def meteofrance_probe_grib_full_package(payload: MeteoFranceGribFullPackageProbeRequest) -> dict[str, Any]:
    api_key = _clean_meteofrance_api_key(payload.token)
    result = await asyncio.to_thread(
        _probe_meteofrance_grib_full_package_sync,
        api_key,
        payload.grid,
        payload.package_id,
        payload.time_group,
        payload.max_bytes,
        payload.max_messages,
    )
    return result


@app.post("/api/meteofrance/probe-grib-index")
async def meteofrance_probe_grib_index(payload: MeteoFranceGribIndexProbeRequest) -> dict[str, Any]:
    _ensure_meteofrance_diagnostics_enabled("/api/meteofrance/probe-grib-index")
    api_key = _clean_meteofrance_api_key(payload.token)
    result = await asyncio.to_thread(
        _probe_meteofrance_grib_index_sync,
        api_key,
        payload.grid,
        payload.package_id,
        payload.time_group,
        payload.max_messages,
    )
    return result


@app.post("/api/meteofrance/probe-grib-profile")
async def meteofrance_probe_grib_profile(payload: MeteoFranceGribProfileProbeRequest) -> dict[str, Any]:
    _ensure_meteofrance_diagnostics_enabled("/api/meteofrance/probe-grib-profile")
    api_key = _clean_meteofrance_api_key(payload.token)
    result = await asyncio.to_thread(
        _probe_meteofrance_grib_profile_sync,
        api_key,
        payload.grid,
        payload.package_ids,
        payload.time_group,
        payload.max_messages,
    )
    return result


@app.post("/api/meteofrance/probe-grib-target-message")
async def meteofrance_probe_grib_target_message(payload: MeteoFranceGribTargetMessageRequest) -> dict[str, Any]:
    _ensure_meteofrance_diagnostics_enabled("/api/meteofrance/probe-grib-target-message")
    api_key = _clean_meteofrance_api_key(payload.token)
    result = await asyncio.to_thread(
        _probe_meteofrance_grib_target_message_sync,
        api_key,
        payload.grid,
        payload.package_id,
        payload.time_group,
        payload.parameter_label,
        payload.level_contains,
        payload.forecast_hour,
        payload.max_messages,
        payload.lat,
        payload.lon,
        payload.label,
        payload.sample_points,
    )
    return result


@app.post("/api/meteofrance/slot-grid")
async def meteofrance_slot_grid(payload: MeteoFranceSlotGridRequest) -> dict[str, Any]:
    _ensure_legacy_local_arome_enabled('/api/meteofrance/slot-grid')
    api_key = _clean_meteofrance_api_key(payload.token)
    result = await asyncio.to_thread(
        _build_meteofrance_slot_grid_sync,
        api_key,
        payload.lat,
        payload.lon,
        payload.label,
        payload.date,
        payload.hour,
        payload.detail_level,
    )
    return result


@app.post("/api/meteofrance/grib-slot-grid")
async def meteofrance_grib_slot_grid(payload: MeteoFranceGribSlotGridRequest, background_tasks: BackgroundTasks) -> dict[str, Any]:
    _ensure_legacy_local_arome_enabled('/api/meteofrance/grib-slot-grid')
    api_key = _clean_meteofrance_api_key(payload.token)
    result = await asyncio.to_thread(
        _build_meteofrance_grib_slot_grid_sync,
        api_key,
        payload.lat,
        payload.lon,
        payload.label,
        payload.date,
        payload.hour,
        payload.grid,
        payload.detail_level,
    )
    if result.get("ok"):
        meta = result.get("payload", {}).get("meta", {}) if isinstance(result.get("payload"), dict) else {}
        time_targets = meta.get("time_targets") if isinstance(meta, dict) else {}
        schedule_time_target = time_targets.get("SP2") if isinstance(time_targets, dict) else None
        result["background_preload"] = _schedule_meteofrance_grib_auto_preload(
            background_tasks,
            api_key,
            payload.lat,
            payload.lon,
            payload.label,
            payload.date,
            payload.hour,
            payload.grid,
            payload.detail_level,
            schedule_time_target if isinstance(schedule_time_target, dict) else None,
        )
    return result


@app.post("/api/meteofrance/grib-france-slot-grid")
async def meteofrance_grib_france_slot_grid(payload: MeteoFranceGribSlotGridRequest) -> dict[str, Any]:
    return {
        "ok": False,
        "status": 410,
        "message": (
            "Matérialisation horaire directe désactivée : les grilles horaires France "
            "sont produites uniquement par le préchargement serveur en paquets complets."
        ),
        "package_only": True,
        "replacement": "/api/meteofrance/grib-france-slot-grid-cache",
    }


# Niveau « render » : projection allégée pour AFFICHER la grille (couleur/score/sélection).
# Retire des cellules les champs de détail lourds (~70 % du poids JSON), réservés au modal
# de détails qui les récupère à la demande via /grib-france-cell-details. Le cache serveur
# et l'archive restent complets : la projection se fait à la réponse, sans muter le cache.
METEOFRANCE_SLOT_GRID_RENDER_DETAIL = "render"
METEOFRANCE_GRIB_RENDER_HEAVY_CELL_FIELDS = frozenset(
    {"category_breakdown", "diagnostics", "metric_scores", "metrics_used", "summary"}
)


def _project_grib_result_for_render(result: dict[str, Any]) -> dict[str, Any]:
    payload = result.get("payload")
    if not isinstance(payload, dict):
        return result
    out = dict(result)
    new_payload = dict(payload)
    meta = dict(new_payload.get("meta") or {})
    meta["detail_level"] = METEOFRANCE_SLOT_GRID_RENDER_DETAIL
    new_payload["meta"] = meta
    days = []
    for day in new_payload.get("days") or []:
        if not isinstance(day, dict):
            continue
        new_day = dict(day)
        slots = []
        for slot in new_day.get("slots") or []:
            if not isinstance(slot, dict):
                continue
            new_slot = dict(slot)
            cells = slot.get("cells")
            if isinstance(cells, list):
                new_slot["cells"] = [
                    {k: v for k, v in cell.items() if k not in METEOFRANCE_GRIB_RENDER_HEAVY_CELL_FIELDS}
                    if isinstance(cell, dict) else cell
                    for cell in cells
                ]
            slots.append(new_slot)
        new_day["slots"] = slots
        days.append(new_day)
    new_payload["days"] = days
    out["payload"] = new_payload
    return out


def _serve_france_slot_from_archive(target_date: Date, hour: int) -> dict[str, Any] | None:
    """Repli durable pour un créneau France d'un jour PASSÉ absent du cache live :
    on relit le créneau archivé (history/, rétention 180 j) plutôt que de le préchauffer.
    L'archive brute garde les cellules COMPLÈTES → la frise ET les détails de cellule
    fonctionnent. Le payload a la même forme qu'un résultat live ; le rendu l'accepte déjà."""
    if not OBJECTIFOUDRE_HISTORY_ENABLED:
        return None
    path = _history_slot_path(target_date.isoformat(), hour)
    if not path.exists():
        return None
    try:
        record = _read_history_gzip(path)
    except Exception:
        return None
    payload = record.get("payload") if isinstance(record, dict) else None
    if not isinstance(payload, dict):
        return None
    base_meta = payload.get("meta") if isinstance(payload.get("meta"), dict) else {}
    payload = {**payload, "meta": {**base_meta, "history": True, "source_label": "Historique ObjectiFoudre (archive)"}}
    return {"ok": True, "status": 200, "history": True, "cache_hit": True, "payload": payload}


def _serve_france_slot_models_sync(target_date: Date, hour: int, grid: str | None, detail_level: str, token: str | None) -> dict[str, Any]:
    """Sert un créneau France en essayant les modèles applicables dans l'ordre
    (AROME puis ARPEGE) et en gardant le PREMIER qui a le créneau en cache. Réalise
    le relais AROME→ARPEGE créneau par créneau (ex. J+2 12h+ non couvert par AROME).
    Pour un jour PASSÉ absent du cache live (ex. J-1, plus préchargé), repli sur l'archive."""
    models = _nwp_models_for_date(target_date) or [DEFAULT_NWP_MODEL]
    last_result: dict[str, Any] | None = None
    for model in models:
        try:
            api_key = _nwp_api_key_for_request(model, token)
        except HTTPException:
            continue
        with _nwp_model_context(model):
            result = _get_meteofrance_grib_france_slot_grid_cached_sync(
                api_key, target_date, hour, requested_grid=grid, detail_level=detail_level,
            )
        last_result = result
        if result.get("ok"):
            return result
    today = datetime.now(OBJECTIFOUDRE_SERVER_TIMEZONE).date()
    if target_date < today:
        archived = _serve_france_slot_from_archive(target_date, hour)
        if archived:
            return archived
    return last_result or {"ok": False, "status": 404, "message": "Aucune grille France en cache pour ce créneau."}


def _serve_france_day_models_sync(target_date: Date, grid: str | None, detail_level: str, token: str | None) -> dict[str, Any]:
    """Lot des 24 h d'un jour, chaque créneau servi par le meilleur modèle disponible
    (AROME puis ARPEGE). Permet à un jour mixte (AROME le matin, ARPEGE l'après-midi)
    d'être servi en un lot cohérent."""
    slots: list[dict[str, Any]] = []
    cached_hours: list[int] = []
    missing_hours: list[int] = []
    first_meta: dict[str, Any] = {}
    for hour in range(24):
        res = _serve_france_slot_models_sync(target_date, hour, grid, detail_level, token)
        payload = res.get("payload") if isinstance(res.get("payload"), dict) else {}
        days = payload.get("days") if isinstance(payload, dict) else []
        day = days[0] if isinstance(days, list) and days else {}
        day_slots = day.get("slots") if isinstance(day, dict) else []
        slot = day_slots[0] if isinstance(day_slots, list) and day_slots else None
        if res.get("ok") and isinstance(slot, dict):
            slots.append(slot)
            cached_hours.append(hour)
            if not first_meta:
                first_meta = copy.deepcopy(payload.get("meta") if isinstance(payload.get("meta"), dict) else {})
        else:
            missing_hours.append(hour)
    meta = {
        **first_meta,
        "provider": "meteofrance_arome_grib",
        "source_provider": "meteofrance_arome_grib",
        "source_label": "Météo-France AROME/ARPEGE GRIB cache",
        "requested_date": target_date.isoformat(),
        "detail_level": detail_level,
        "cache_only": True,
        "batch_cache": True,
        "grid_scope": "france",
        "france_grid": True,
        "country_mask": "france",
        "cached_hours": cached_hours,
        "missing_hours": missing_hours,
    }
    payload = {
        "meta": meta,
        "days": [{"day_key": target_date.isoformat(), "day_label": target_date.isoformat(), "day_index": 0, "slots": slots}],
    }
    return {
        "ok": bool(slots),
        "status": 200 if slots else 404,
        "cache_only": True,
        "grid_scope": "france",
        "france_grid": True,
        "date": target_date.isoformat(),
        "detail_level": detail_level,
        "cached_hours": cached_hours,
        "cached_slot_keys": [f"h{hour:02d}" for hour in cached_hours],
        "payload": payload,
    }


@app.post("/api/meteofrance/grib-france-slot-grid-cache")
async def meteofrance_grib_france_slot_grid_cache(payload: MeteoFranceGribSlotGridRequest) -> dict[str, Any]:
    requested_render = (payload.detail_level or "").strip().lower() == METEOFRANCE_SLOT_GRID_RENDER_DETAIL
    result = await asyncio.to_thread(
        _serve_france_slot_models_sync,
        payload.date,
        payload.hour,
        payload.grid,
        payload.detail_level,
        payload.token,
    )
    if requested_render and result.get("ok"):
        result = _project_grib_result_for_render(result)
    return result


class MeteoFranceCellDetailsRequest(BaseModel):
    token: str | None = Field(None, max_length=4096)
    date: Date
    hour: int = Field(..., ge=0, le=23)
    zone: str = Field(..., min_length=1, max_length=128)
    grid: str | None = Field(None, max_length=32)


@app.post("/api/meteofrance/grib-france-cell-details")
async def meteofrance_grib_france_cell_details(payload: MeteoFranceCellDetailsRequest) -> dict[str, Any]:
    """Cellule COMPLÈTE (metric_scores, metrics_used, diagnostics…) pour le modal de
    détails, quand la grille a été chargée en niveau « render » allégé."""
    result = await asyncio.to_thread(
        _serve_france_slot_models_sync,
        payload.date,
        payload.hour,
        payload.grid,
        METEOFRANCE_SLOT_GRID_CORE_DETAIL,
        payload.token,
    )
    if not result.get("ok"):
        return {"ok": False, "status": result.get("status") or 404, "message": result.get("message") or "Grille absente du cache."}
    days = (result.get("payload") or {}).get("days") or []
    slots = (days[0].get("slots") or []) if days else []
    cells = (slots[0].get("cells") or []) if slots else []
    zone = str(payload.zone)
    cell = next((c for c in cells if isinstance(c, dict) and str(c.get("zone")) == zone), None)
    if cell is None:
        return {"ok": False, "status": 404, "message": f"Cellule {zone} absente du créneau {payload.hour:02d}h."}
    return {"ok": True, "cell": cell, "date": payload.date.isoformat(), "hour": payload.hour}


class MeteoFranceWindProfileRequest(BaseModel):
    date: Date
    hour: int = Field(..., ge=0, le=23)
    lat: float = Field(..., ge=37.5, le=55.4)
    lon: float = Field(..., ge=-16.0, le=16.0)


# Profil vertical de vent (ARPEGE WCS isobare) à la demande. Caché par (échéance, lat/lon
# arrondis 0,1° = maille ARPEGE) → les cellules voisines et les re-clics partagent le résultat.
_WIND_PROFILE_CACHE: dict[tuple[str, float, float], list[dict[str, float]]] = {}
_WIND_PROFILE_CACHE_MAX = 4000


def _wind_profile_sync(target_date: Date, hour: int, lat: float, lon: float) -> list[dict[str, float]]:
    if wcs_client is None:
        return []
    slot_dt = datetime.combine(target_date, Time(hour=hour), tzinfo=ZoneInfo("Europe/Paris"))
    valid_iso = slot_dt.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    rlat, rlon = round(lat, 1), round(lon, 1)
    ckey = (valid_iso, rlat, rlon)
    if ckey in _WIND_PROFILE_CACHE:
        return _WIND_PROFILE_CACHE[ckey]
    try:
        prof = wcs_client.fetch_wind_profile(rlat, rlon, valid_iso)
    except Exception as exc:  # noqa: BLE001
        print(f"[wcs] profil vent indisponible {valid_iso} {rlat},{rlon}: {exc}", file=sys.stderr)
        prof = []
    if len(_WIND_PROFILE_CACHE) > _WIND_PROFILE_CACHE_MAX:
        _WIND_PROFILE_CACHE.clear()
    _WIND_PROFILE_CACHE[ckey] = prof
    return prof


@app.post("/api/meteofrance/grib-france-wind-profile")
async def meteofrance_grib_france_wind_profile(payload: MeteoFranceWindProfileRequest) -> dict[str, Any]:
    """Profil vertical de vent (force + direction) à plusieurs niveaux de pression au point
    de la cellule, pour le modal de détails. À la demande, non-fatal."""
    profile = await asyncio.to_thread(_wind_profile_sync, payload.date, payload.hour, payload.lat, payload.lon)
    return {"ok": True, "profile": profile}


@app.post("/api/meteofrance/grib-france-day-cache")
async def meteofrance_grib_france_day_cache(payload: MeteoFranceGribCacheStatusRequest) -> dict[str, Any]:
    requested_render = (payload.detail_level or "").strip().lower() == METEOFRANCE_SLOT_GRID_RENDER_DETAIL
    result = await asyncio.to_thread(
        _serve_france_day_models_sync,
        payload.date,
        payload.grid,
        payload.detail_level,
        payload.token,
    )
    # Projection « render » : lot des 24 h allégé (sans les champs lourds par cellule)
    # pour le préchargement multi-jours de la page Prévision/Tendance.
    if requested_render and result.get("ok"):
        result = _project_grib_result_for_render(result)
    return result


def _build_history_day_bytes(date_str: str) -> bytes:
    """Build the slim day once, serialize to JSON bytes and memo-cache them, so
    later opens are served instantly (no re-decompression / re-serialization)."""
    payload = _get_history_france_day_sync(date_str, slim=True)
    data = json.dumps(payload, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    with _history_day_cache_lock:
        _history_day_bytes_cache[date_str] = data
        # borne mémoire : on ne garde que les dates récemment consultées
        while len(_history_day_bytes_cache) > 12:
            _history_day_bytes_cache.pop(next(iter(_history_day_bytes_cache)))
    return data


async def _warm_history_day(date_str: str) -> None:
    try:
        if date_str not in _history_day_bytes_cache:
            await asyncio.to_thread(_build_history_day_bytes, date_str)
    except Exception:
        pass


@app.get("/api/history/dates")
async def history_dates() -> dict[str, Any]:
    dates = await asyncio.to_thread(_list_history_dates)
    # Préchauffe en arrière-plan les caches des dates récentes : à l'ouverture de
    # l'écran, /dates est appelé en premier ; le temps que l'utilisateur clique
    # une date, sa réponse est déjà construite (sinon la 1re construction de ~4 s
    # peut être affamée par les connexions navigateur durant un préchargement).
    if OBJECTIFOUDRE_HISTORY_ENABLED:
        for item in dates[:4]:
            date_value = item.get("date")
            if date_value:
                asyncio.create_task(_warm_history_day(date_value))
    return {
        "ok": True,
        "enabled": OBJECTIFOUDRE_HISTORY_ENABLED,
        "retention_days": OBJECTIFOUDRE_HISTORY_RETENTION_DAYS,
        "date_count": len(dates),
        "dates": dates,
    }


@app.get("/api/history/day")
async def history_day(
    date: str = Query(..., min_length=10, max_length=10),
    full: bool = Query(False),
) -> Response:
    if not _is_iso_date(date):
        raise HTTPException(status_code=400, detail="Date attendue au format AAAA-MM-JJ.")
    if full:
        payload = await asyncio.to_thread(_get_history_france_day_sync, date, False)
        return JSONResponse(payload)
    cached = _history_day_bytes_cache.get(date)
    if cached is None:
        cached = await asyncio.to_thread(_build_history_day_bytes, date)
    return Response(content=cached, media_type="application/json")


@app.get("/api/history/verification")
async def history_verification(date: str = Query(..., min_length=10, max_length=10)) -> dict[str, Any]:
    if not _is_iso_date(date):
        raise HTTPException(status_code=400, detail="Date attendue au format AAAA-MM-JJ.")
    return await asyncio.to_thread(_compute_day_verification, date)


@app.post("/api/history/collect-lightning")
async def history_collect_lightning(date: str = Query(..., min_length=10, max_length=10)) -> dict[str, Any]:
    if not _is_iso_date(date):
        raise HTTPException(status_code=400, detail="Date attendue au format AAAA-MM-JJ.")
    return await asyncio.to_thread(_build_lightning_archive_for_date, date)


@app.get("/api/history/lightning")
async def history_lightning(date: str = Query(..., min_length=10, max_length=10)) -> dict[str, Any]:
    """Points de foudre observés (lat, lon) pour l'overlay sur la carte."""
    if not _is_iso_date(date):
        raise HTTPException(status_code=400, detail="Date attendue au format AAAA-MM-JJ.")
    record = await asyncio.to_thread(_read_lightning_archive, date)
    if not record:
        return {"ok": False, "date": date, "reason": "no_observation", "points": []}
    points = record.get("points") or []
    return {
        "ok": True,
        "date": date,
        "flash_total": record.get("flash_total"),
        "count": record.get("point_count") or len(points),
        "final": record.get("final"),
        "points": points,
    }


@app.post("/api/history/collect-pending-lightning")
async def history_collect_pending_lightning() -> dict[str, Any]:
    """Déclenche la collecte foudre de toutes les journées prévues écoulées non
    encore finalisées (idempotent). Ce que fait aussi l'automatisation quotidienne."""
    return await asyncio.to_thread(_collect_pending_lightning)


@app.get("/api/learning/status")
async def learning_status() -> dict[str, Any]:
    """État de l'auto-calibration : volumes, garde-fous, seuil/poids actifs, skill, journal."""
    return await asyncio.to_thread(_learning_status)


@app.post("/api/learning/retrain")
async def learning_retrain() -> dict[str, Any]:
    """Réentraîne maintenant : construit le jeu, évalue, et applique si meilleur (auto)."""
    res = await asyncio.to_thread(_run_learning_evaluation, source="manual")
    status = await asyncio.to_thread(_learning_status)
    return {"ok": True, "result": res, "status": status}


@app.post("/api/learning/revert")
async def learning_revert() -> dict[str, Any]:
    """Revient au modèle de base (supprime active.json, réinitialise poids + seuil)."""
    cleared = await asyncio.to_thread(learning.clear_active, OBJECTIFOUDRE_HISTORY_DIR)
    await asyncio.to_thread(_apply_learning_config, None)
    await asyncio.to_thread(learning.append_log, OBJECTIFOUDRE_HISTORY_DIR, {
        "at": datetime.now(OBJECTIFOUDRE_SERVER_TIMEZONE).isoformat(),
        "source": "manual", "decision": "revert", "applied": cleared,
    })
    status = await asyncio.to_thread(_learning_status)
    return {"ok": True, "reverted": cleared, "status": status}


@app.post("/api/meteofrance/grib-slot-grid-cache")
async def meteofrance_grib_slot_grid_cache(payload: MeteoFranceGribSlotGridRequest) -> dict[str, Any]:
    _ensure_legacy_local_arome_enabled('/api/meteofrance/grib-slot-grid-cache')
    api_key = _clean_meteofrance_api_key(payload.token)
    result = await asyncio.to_thread(
        _get_meteofrance_grib_slot_grid_cached_sync,
        api_key,
        payload.lat,
        payload.lon,
        payload.label,
        payload.date,
        payload.hour,
        payload.grid,
        payload.detail_level,
    )
    return result


@app.post("/api/meteofrance/grib-cache-status")
async def meteofrance_grib_cache_status(payload: MeteoFranceGribCacheStatusRequest) -> dict[str, Any]:
    _ensure_legacy_local_arome_enabled('/api/meteofrance/grib-cache-status')
    api_key = _clean_meteofrance_api_key(payload.token)
    result = await asyncio.to_thread(
        _meteofrance_grib_slot_grid_cache_status_sync,
        api_key,
        payload.lat,
        payload.lon,
        payload.label,
        payload.date,
        payload.grid,
        payload.detail_level,
    )
    return result


def _meteofrance_grib_france_cache_status_models_sync(target_date: Date, grid: str | None, detail_level: str, token: str | None) -> dict[str, Any]:
    """Statut de cache FUSIONNÉ sur les modèles applicables (AROME ∪ ARPEGE) : un jour
    mixte (J+2) renvoie l'union des heures en cache/disponibles des deux modèles."""
    models = _nwp_models_for_date(target_date) or [DEFAULT_NWP_MODEL]
    base: dict[str, Any] | None = None
    cached: set[int] = set()
    available: set[int] = set()
    for model in models:
        try:
            api_key = _nwp_api_key_for_request(model, token)
        except HTTPException:
            continue
        with _nwp_model_context(model):
            res = _meteofrance_grib_france_slot_grid_cache_status_sync(api_key, target_date, grid, detail_level)
        if not isinstance(res, dict) or not res.get("ok"):
            continue
        base = res if base is None else base
        cached |= {int(h) for h in (res.get("cached_hours") or []) if 0 <= int(h) <= 23}
        available |= {int(h) for h in (res.get("available_hours") or []) if 0 <= int(h) <= 23}
    if base is None:
        return {"ok": False, "status": 404, "date": target_date.isoformat(), "message": "Aucun statut de cache disponible."}
    cached_hours = sorted(cached)
    available_hours = sorted(available)
    unavailable_hours = [h for h in range(24) if h not in available]
    out = dict(base)
    out.update({
        "models": models,
        "cached_hours": cached_hours,
        "cached_slot_keys": [f"h{h:02d}" for h in cached_hours],
        "available_hours": available_hours,
        "available_slot_keys": [f"h{h:02d}" for h in available_hours],
        "unavailable_hours": unavailable_hours,
        "unavailable_slot_keys": [f"h{h:02d}" for h in unavailable_hours],
        "partial_availability": len(available_hours) < 24,
    })
    return out


@app.post("/api/meteofrance/grib-france-cache-status")
async def meteofrance_grib_france_cache_status(payload: MeteoFranceGribCacheStatusRequest) -> dict[str, Any]:
    return await asyncio.to_thread(
        _meteofrance_grib_france_cache_status_models_sync,
        payload.date,
        payload.grid,
        payload.detail_level,
        payload.token,
    )


@app.post("/api/meteofrance/grib-preload")
async def meteofrance_grib_preload(payload: MeteoFranceGribPreloadRequest) -> dict[str, Any]:
    _ensure_legacy_local_arome_enabled('/api/meteofrance/grib-preload')
    api_key = _clean_meteofrance_api_key(payload.token)
    result = await asyncio.to_thread(
        _preload_meteofrance_grib_slot_grids_sync,
        api_key,
        payload.lat,
        payload.lon,
        payload.label,
        payload.date,
        payload.hour,
        payload.grid,
        payload.detail_level,
        payload.scope,
        payload.max_hours,
    )
    return result


@app.post("/api/meteofrance/grib-preload-national-day")
async def meteofrance_grib_preload_national_day(payload: MeteoFranceGribPreloadRequest, background_tasks: BackgroundTasks) -> dict[str, Any]:
    api_key = _clean_meteofrance_api_key(payload.token)
    run_schedule = _server_arome_run_schedule()
    with _server_arome_automation_lock:
        state = copy.deepcopy(_server_arome_automation_state)
    availability_reference_time, _ = _server_arome_availability_reference(state, run_schedule)
    coverage = _server_arome_cache_coverage(api_key, payload.date, payload.grid, availability_reference_time)
    allowed_hours = [int(item) for item in (coverage.get("available_hours") or []) if 0 <= int(item) <= 23]
    return _schedule_meteofrance_grib_national_day_preload(
        background_tasks,
        api_key,
        payload.date,
        payload.grid,
        allowed_hours=allowed_hours,
    )


@app.post("/api/meteofrance/grib-preload-day")
async def meteofrance_grib_preload_day(payload: MeteoFranceGribPreloadRequest, background_tasks: BackgroundTasks) -> dict[str, Any]:
    _ensure_legacy_local_arome_enabled('/api/meteofrance/grib-preload-day')
    api_key = _clean_meteofrance_api_key(payload.token)
    return _schedule_meteofrance_grib_day_preload(
        background_tasks,
        api_key,
        payload.lat,
        payload.lon,
        payload.label,
        payload.date,
        payload.hour,
        payload.grid,
        payload.detail_level,
    )


@app.get("/api/meteofrance/grib-preload-status")
async def meteofrance_grib_preload_status(job_key: str = Query(..., min_length=8, max_length=1024)) -> dict[str, Any]:
    return _grib_auto_preload_status(job_key)


@app.get("/api/server/arome-automation-status")
async def server_arome_automation_status() -> dict[str, Any]:
    return await asyncio.to_thread(_server_arome_automation_status)


def _server_nwp_models_overview_sync(probe: bool) -> dict[str, Any]:
    models = []
    for model_id, spec in NWP_MODEL_REGISTRY.items():
        api_key = _server_nwp_api_key(model_id)
        entry: dict[str, Any] = {
            "id": model_id,
            "label": spec["label"],
            "package_api_base": spec["package_api_base"],
            "package_model": spec["package_model"],
            "preferred_grids": list(spec["preferred_grids"]),
            "surface_package_candidates": list(spec["surface_package_candidates"]),
            "forecast_horizon_hours": spec["forecast_horizon_hours"],
            "max_days_ahead": spec["max_days_ahead"],
            "cache_scope_prefix": spec["cache_scope_prefix"],
            "api_key_env_vars": list(spec["api_key_env_vars"]),
            "api_key_file": spec["api_key_file"],
            "server_key_configured": bool(api_key),
        }
        if probe:
            if not api_key:
                entry["probe"] = {"ok": False, "error": "Clé API serveur absente pour ce modèle."}
            else:
                try:
                    context = _resolve_meteofrance_package_base(api_key, None, model=model_id)
                    package_ids = [str(item.get("id") or "") for item in context.get("packages") or []]
                    probe_info: dict[str, Any] = {
                        "ok": True,
                        "grid": context.get("grid"),
                        "packages": package_ids,
                        "metadata_cache_hit": bool(context.get("metadata_cache_hit")),
                    }
                    surface_candidates = [item for item in spec["surface_package_candidates"] if item in set(package_ids)]
                    if surface_candidates:
                        package_url = f"{context['packages_url']}/{urllib.parse.quote(surface_candidates[0])}"
                        _, _, package_payload = _fetch_meteofrance_package_json(api_key, package_url)
                        run_links = _package_run_links(package_payload)
                        probe_info["package_probed"] = surface_candidates[0]
                        probe_info["runs"] = [item["reference_time"] for item in run_links[:4]]
                        if run_links:
                            _, _, run_payload = _fetch_meteofrance_package_json(api_key, run_links[0]["href"])
                            probe_info["latest_run_time_groups"] = [
                                str(item.get("time") or "") for item in _package_product_links(run_payload)
                            ]
                    entry["probe"] = probe_info
                except Exception as exc:
                    entry["probe"] = {"ok": False, "error": str(exc)}
        models.append(entry)
    return {"ok": True, "default_model": DEFAULT_NWP_MODEL, "models": models}


@app.get("/api/server/nwp-models")
async def server_nwp_models(probe: bool = False) -> dict[str, Any]:
    """Registre des modèles PNT + sonde optionnelle du catalogue paquets de chaque
    modèle (grilles, paquets, runs, groupes d'échéances) avec sa clé serveur."""
    return await asyncio.to_thread(_server_nwp_models_overview_sync, probe)


class EcmwfTrendDayRequest(BaseModel):
    date: Date


@app.get("/api/ecmwf/trend-status")
async def ecmwf_trend_status() -> dict[str, Any]:
    """Run ECMWF open data disponible + liste des 6 jours de tendance J+5 → J+10
    (avec l'état de cache de chacun)."""
    return await asyncio.to_thread(_ecmwf_trend_status_sync)


@app.post("/api/ecmwf/trend-day")
async def ecmwf_trend_day(payload: EcmwfTrendDayRequest) -> dict[str, Any]:
    """Grille tendance ECMWF d'un jour (J+5 → J+10), scorée et projetée « render ».
    Construit à la demande puis mise en cache pour la durée de vie du run."""
    today = datetime.now(OBJECTIFOUDRE_SERVER_TIMEZONE).date()
    offset = (payload.date - today).days
    if offset < min(ECMWF_TREND_DAYS_AHEAD) or offset > max(ECMWF_TREND_DAYS_AHEAD):
        return {
            "ok": False,
            "status": 400,
            "message": f"La tendance ECMWF couvre J+{min(ECMWF_TREND_DAYS_AHEAD)} → J+{max(ECMWF_TREND_DAYS_AHEAD)}. Sélection : {payload.date.isoformat()}.",
        }
    run = await asyncio.to_thread(_ecmwf_latest_trend_run, today)
    if run is None:
        return {"ok": False, "status": 503, "message": "Aucun run ECMWF open data disponible."}
    run_date, run_hour = run
    return await asyncio.to_thread(_ecmwf_build_trend_day_sync, payload.date, run_date, run_hour)


# ============== Mode « En chasse » — AROME-PI (prévision immédiate) ==============
# AROME-PI = nowcasting Météo-France (maille ~1,3 km, pas 15 min, ~H+15min → +6h,
# run horaire). API WMS (tuiles rendues, EPSG:4326 seulement) + WCS (valeurs au point,
# GeoTIFF). Clé dédiée (abonnement séparé). Le radar OBSERVÉ vient de RainViewer côté
# front (gratuit, sans clé). Le WMS exige la clé → proxy serveur obligatoire (la clé ne
# doit jamais atteindre le navigateur).
METEOFRANCE_AROMEPI_WMS_URL = "https://public-api.meteofrance.fr/public/aromepi/1.0/wms/MF-NWP-HIGHRES-AROMEPI-001-FRANCE-WMS"
# PNG 256×256 transparent renvoyé quand une tuile WMS échoue (évite les 502 et l'erreur
# MapLibre « source image could not be decoded » : la tuile doit faire la taille attendue,
# pas 1×1). Généré via Pillow ; repli 1×1 si Pillow absent.
def _aromepi_make_transparent_png() -> bytes:
    try:
        from PIL import Image
        buf = io.BytesIO()
        Image.new("RGBA", (256, 256), (0, 0, 0, 0)).save(buf, format="PNG")
        return buf.getvalue()
    except Exception:
        return base64.b64decode(
            "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M8AAAMCAQDhUkXkAAAAAElFTkSuQmCC"
        )


AROMEPI_TRANSPARENT_PNG = _aromepi_make_transparent_png()
METEOFRANCE_AROMEPI_WCS_URL = "https://public-api.meteofrance.fr/public/aromepi/1.0/wcs/MF-NWP-HIGHRES-AROMEPI-001-FRANCE-WCS"
AROMEPI_NOWCAST_HORIZON_HOURS = 6
AROMEPI_CAPABILITIES_TTL_SECONDS = 300
# clé -> couche WMS / préfixe WCS (= même nom) / libellé / unité. La réflectivité est la
# couche maîtresse (radar simulé). styles WMS = défaut (vide) → rendu ombré officiel.
# Par couche : nom WMS, libellé, unité, et options de requête WCS au point :
#  - wcs_accum : suffixe d'accumulation du coverageId (rafales/graupel sont des max sur
#    une période ; `_PT15M` = sur les 15 min de l'échéance) ;
#  - wcs_height : niveau (m) requis pour les coverages SPECIFIC_HEIGHT (rafales 10 m) ;
#  - wcs_scale : facteur d'échelle appliqué à la valeur (rafales m/s → km/h) ;
#  - point : False = pas de valeur au point (MOCON est analyse-seule en WCS), couche carte
#    seulement.
AROMEPI_LAYERS = {
    "reflectivity": {"layer": "REFLECTIVITY_MAX_DBZ__GROUND_OR_WATER_SURFACE", "label": "Réflectivité", "unit": "dBZ", "primary": True},
    "hail": {"layer": "DIAG_GRELE__GROUND_OR_WATER_SURFACE", "label": "Grêle", "unit": ""},
    "graupel": {"layer": "GRAUPEL__GROUND_OR_WATER_SURFACE", "label": "Graupel", "unit": "kg/m²", "wcs_accum": "_PT15M"},
    "gusts": {"layer": "WIND_SPEED_GUST_15MIN__SPECIFIC_HEIGHT_LEVEL_ABOVE_GROUND", "label": "Rafales 15 min", "unit": "km/h", "wcs_accum": "_PT15M", "wcs_height": 10, "wcs_scale": 3.6},
    "cape": {"layer": "CONVECTIVE_AVAILABLE_POTENTIAL_ENERGY__GROUND_OR_WATER_SURFACE", "label": "CAPE", "unit": "J/kg"},
    "mocon": {"layer": "MOCON__GROUND_OR_WATER_SURFACE", "label": "MOCON", "unit": "g/kg/s", "point": False},
}

# Emprise des données AROME-PI (lat 37.5–55.4, lon -12–16). Sert de bbox unique pour
# l'image plein-domaine et de coins pour la source MapLibre `image`.
AROMEPI_DOMAIN = {"min_lat": 37.5, "min_lon": -12.0, "max_lat": 55.4, "max_lon": 16.0}


def _aromepi_api_key() -> str | None:
    raw = os.environ.get("METEOFRANCE_AROME_PI_API_KEY") or os.environ.get("METEOFRANCE_AROMEPI_API_KEY")
    if not raw:
        path = os.path.join(os.path.dirname(os.path.abspath(__file__)), "Clef API AROME PI.txt")
        try:
            with open(path, encoding="utf-8") as handle:
                raw = handle.read().strip()
        except OSError:
            return None
    if not raw:
        return None
    try:
        return _clean_meteofrance_api_key(raw)
    except HTTPException:
        return None


def _aromepi_http_get(url: str, api_key: str, timeout: int = 40) -> tuple[int, str, bytes]:
    request = urllib.request.Request(url, headers={"apikey": api_key, "User-Agent": f"ObjectiFoudre/{APP_VERSION}"}, method="GET")
    last_exc: Exception | None = None
    for attempt in range(3):
        try:
            with urllib.request.urlopen(request, timeout=timeout) as response:
                return int(getattr(response, "status", 200) or 200), str(response.headers.get("Content-Type") or ""), response.read()
        except urllib.error.HTTPError as exc:
            return exc.code, str(exc.headers.get("Content-Type") or ""), exc.read()
        except Exception as exc:
            last_exc = exc
            time.sleep(0.5 * (attempt + 1))
    if last_exc:
        raise last_exc
    raise RuntimeError("Lecture AROME-PI impossible.")


def _aromepi_capabilities_sync(api_key: str) -> dict[str, Any]:
    """Dernier run (reference_time) + échéances 15 min disponibles pour ce run."""
    cache_key = _meteofrance_metadata_cache_key(api_key, "aromepi:wms-capabilities")
    cached = _get_cached_value(cache_key, ttl=AROMEPI_CAPABILITIES_TTL_SECONDS)
    if cached is not None:
        return dict(cached["payload"])
    url = METEOFRANCE_AROMEPI_WMS_URL + "/GetCapabilities?service=WMS&version=1.3.0&language=eng"
    status, _ct, raw = _aromepi_http_get(url, api_key)
    if status != 200 or not raw:
        return {"ok": False, "status": status}
    body = raw.decode("utf-8", "replace")
    i = body.find("<Name>REFLECTIVITY_MAX_DBZ__GROUND_OR_WATER_SURFACE</Name>")
    seg = body[i:body.find("</Layer>", i)] if i >= 0 else body
    run = None
    # l'ordre des attributs varie (default peut précéder name) → on isole la balise
    # Dimension reference_time puis on extrait default depuis ses attributs.
    m_ref = re.search(r'<Dimension\b([^>]*\bname="reference_time"[^>]*)>', seg)
    if m_ref:
        md = re.search(r'\bdefault="([^"]+)"', m_ref.group(1))
        run = md.group(1) if md else None
    times: list[str] = []
    m_time = re.search(r'<Dimension\b[^>]*\bname="time"[^>]*>(.*?)</Dimension>', seg, re.S)
    if m_time:
        times = [t.strip() for t in m_time.group(1).replace("\n", "").split(",") if t.strip()]
    # ne garder que les échéances du dernier run (run → run+6h)
    run_dt = _parse_meteofrance_datetime(run or "")
    forecast_times: list[str] = []
    if run_dt is not None:
        end_dt = run_dt + timedelta(hours=AROMEPI_NOWCAST_HORIZON_HOURS)
        for t in times:
            tdt = _parse_meteofrance_datetime(t)
            # le WMS ne sert qu'à partir de run+15min (l'instant du run lui-même → 502)
            if tdt is not None and run_dt < tdt <= end_dt:
                forecast_times.append(t)
    forecast_times = sorted(set(forecast_times))
    result = {"ok": bool(run and forecast_times), "run": run, "forecast_times": forecast_times}
    _set_cached_value(cache_key, result)
    return result


def _aromepi_mercator_to_lonlat(x: float, y: float) -> tuple[float, float]:
    R = 20037508.342789244
    lon = (x / R) * 180.0
    lat = math.degrees(2.0 * math.atan(math.exp((y / R) * 180.0 * math.pi / 180.0)) - math.pi / 2.0)
    return lon, lat


def _aromepi_reproject_tile(png_bytes: bytes, miny: float, maxy: float, min_lat: float, max_lat: float, size: int) -> bytes:
    """Reprojette une tuile WMS plate-carrée (EPSG:4326) vers Web Mercator (EPSG:3857).
    La longitude est linéaire dans les deux → seul un ré-échantillonnage VERTICAL des
    lignes est nécessaire (rapide, vectorisé). Repli : tuile d'origine si Pillow/numpy
    indisponibles (affichage légèrement décalé mais fonctionnel)."""
    try:
        from PIL import Image
        import numpy as np
        img = Image.open(io.BytesIO(png_bytes)).convert("RGBA")
        src = np.asarray(img)
        src_h = src.shape[0]
        r_earth = 6378137.0
        rows = np.arange(size)
        merc_y = maxy - (rows + 0.5) / size * (maxy - miny)
        lat = np.degrees(2.0 * np.arctan(np.exp(merc_y / r_earth)) - np.pi / 2.0)
        denom = (max_lat - min_lat) or 1e-9
        src_rows = np.clip(((max_lat - lat) / denom * src_h).astype(np.int64), 0, src_h - 1)
        out = src[src_rows, :, :]
        buf = io.BytesIO()
        Image.fromarray(out, "RGBA").save(buf, format="PNG")
        return buf.getvalue()
    except Exception:
        return png_bytes


def _aromepi_wms_tile_sync(api_key: str, layer_key: str, time_iso: str, run_iso: str | None, bbox3857: str, width: int, height: int) -> tuple[int, bytes]:
    spec = AROMEPI_LAYERS.get(layer_key)
    if spec is None:
        return 404, b""
    try:
        minx, miny, maxx, maxy = (float(v) for v in bbox3857.split(","))
    except (ValueError, TypeError):
        return 400, b""
    min_lon, min_lat = _aromepi_mercator_to_lonlat(minx, miny)
    max_lon, max_lat = _aromepi_mercator_to_lonlat(maxx, maxy)
    # WMS 1.3.0 EPSG:4326 → ordre bbox = minlat,minlon,maxlat,maxlon. La carte est en
    # Web Mercator → on reprojette la tuile rendue (plate carrée) en sortie.
    params = [
        ("service", "WMS"), ("version", "1.3.0"), ("request", "GetMap"),
        ("layers", spec["layer"]), ("styles", ""), ("crs", "EPSG:4326"),
        ("bbox", f"{min_lat:.6f},{min_lon:.6f},{max_lat:.6f},{max_lon:.6f}"),
        ("width", str(int(width))), ("height", str(int(height))),
        ("format", "image/png"), ("transparent", "true"), ("time", time_iso),
    ]
    if run_iso:
        params.append(("dim_reference_time", run_iso))
    url = METEOFRANCE_AROMEPI_WMS_URL + "/GetMap?" + urllib.parse.urlencode(params)
    status, _ct, raw = _aromepi_http_get(url, api_key, timeout=30)
    if status == 200 and raw[:4] == b"\x89PNG":
        return 200, _aromepi_reproject_tile(raw, miny, maxy, min_lat, max_lat, int(height))
    return (status if status != 200 else 502), b""


def _aromepi_reproject_domain(png_bytes: bytes, dom: dict, out_width: int) -> bytes | None:
    """Reprojette l'image plein-domaine plate-carrée (lignes ∝ latitude) vers une image
    dont les lignes sont ∝ Mercator-y entre merc(max_lat) et merc(min_lat). Posée en
    source `image` calée sur les 4 coins du domaine, MapLibre l'interpole linéairement en
    Mercator → alignement exact à tous les zooms. Colonnes inchangées (lon linéaire en
    Mercator-x). None si Pillow/numpy indisponibles (le proxy renvoie alors le transparent)."""
    try:
        from PIL import Image
        import numpy as np
        r = 6378137.0
        min_lat, max_lat = dom["min_lat"], dom["max_lat"]
        min_lon, max_lon = dom["min_lon"], dom["max_lon"]
        src = np.asarray(Image.open(io.BytesIO(png_bytes)).convert("RGBA"))
        src_h = src.shape[0]
        merc_top = r * math.log(math.tan(math.pi / 4 + math.radians(max_lat) / 2))
        merc_bot = r * math.log(math.tan(math.pi / 4 + math.radians(min_lat) / 2))
        merc_x_span = r * math.radians(max_lon - min_lon)
        out_h = max(1, round(out_width * (merc_top - merc_bot) / merc_x_span))
        rows = np.arange(out_h)
        merc_y = merc_top - (rows + 0.5) / out_h * (merc_top - merc_bot)
        lat = np.degrees(2.0 * np.arctan(np.exp(merc_y / r)) - np.pi / 2.0)
        denom = (max_lat - min_lat) or 1e-9
        src_rows = np.clip(((max_lat - lat) / denom * src_h).astype(np.int64), 0, src_h - 1)
        out = src[src_rows, :, :]
        buf = io.BytesIO()
        Image.fromarray(out, "RGBA").save(buf, format="PNG")
        return buf.getvalue()
    except Exception:
        return None


def _aromepi_domain_image_sync(api_key: str, layer_key: str, time_iso: str, run_iso: str | None) -> bytes | None:
    """Image AROME-PI couvrant tout le domaine, reprojetée plate-carrée→Web Mercator.

    Pourquoi pas des tuiles : la passerelle WMS Météo-France PRÉSERVE le ratio géographique
    du bbox au lieu de l'étirer sur width×height (non conforme WMS). Demander des tuiles
    carrées 256×256 pour des bbox non-carrées en degrés décale la donnée verticalement,
    d'un montant variable selon le zoom (= le « radar qui se déplace au zoom »). En
    demandant UNE image plein-domaine au ratio EXACT des degrés, le rendu est fidèle
    (vérifié vs WCS) ; la reprojection verticale suffit (longitude linéaire en Mercator-x)."""
    spec = AROMEPI_LAYERS.get(layer_key)
    if spec is None:
        return None
    cache_key = f"aromepi:image:{layer_key}:{time_iso}:{run_iso}"
    # Image immuable pour un (couche, échéance, run) donné → cache long (le run change
    # chaque heure, la clé inclut le run). Évite de re-rendre lors de la navigation /
    # préchargement (clé API limitée à 50 req/min).
    cached = _get_cached_value(cache_key, ttl=2700)
    if cached is not None:
        return cached.get("payload")
    d = AROMEPI_DOMAIN
    # 2400 px sur ~28° de longitude ≈ 1,16 km/px → proche de la maille native AROME-PI
    # (~1,3 km) : au-delà, pas de détail supplémentaire (donnée limitée). Image immuable et
    # mise en cache long (cf. plus bas) → coût de rendu/reprojection payé une seule fois.
    out_width = 2400
    # largeur:hauteur = ratio des degrés → le WMS rend une plate-carrée fidèle.
    src_height = max(1, round(out_width * (d["max_lat"] - d["min_lat"]) / (d["max_lon"] - d["min_lon"])))
    params = [
        ("service", "WMS"), ("version", "1.3.0"), ("request", "GetMap"),
        ("layers", spec["layer"]), ("styles", ""), ("crs", "EPSG:4326"),
        ("bbox", f'{d["min_lat"]},{d["min_lon"]},{d["max_lat"]},{d["max_lon"]}'),
        ("width", str(out_width)), ("height", str(src_height)),
        ("format", "image/png"), ("transparent", "true"), ("time", time_iso),
    ]
    if run_iso:
        params.append(("dim_reference_time", run_iso))
    url = METEOFRANCE_AROMEPI_WMS_URL + "/GetMap?" + urllib.parse.urlencode(params)
    status, _ct, raw = _aromepi_http_get(url, api_key, timeout=35)
    if status != 200 or raw[:4] != b"\x89PNG":
        return None
    png = _aromepi_reproject_domain(raw, d, out_width)
    if png:
        _set_cached_value(cache_key, png)
    return png


def _aromepi_wcs_coverage_ids(api_key: str) -> dict[str, list[str]]:
    """Map {nom de couche → liste de coverageId WCS}. La structure varie selon le
    paramètre : certains ont UN coverage par run (subset time), d'autres un coverage
    par échéance (datetime = temps valide) ou des accumulations (`_PT3H`/`_PT6H`).
    On lit tout dans le GetCapabilities WCS et on choisit au moment de la requête."""
    cache_key = _meteofrance_metadata_cache_key(api_key, "aromepi:wcs-coverages")
    cached = _get_cached_value(cache_key, ttl=AROMEPI_CAPABILITIES_TTL_SECONDS)
    if cached is not None:
        return {k: list(v) for k, v in cached["payload"].items()}
    url = METEOFRANCE_AROMEPI_WCS_URL + "/GetCapabilities?service=WCS&version=2.0.1&language=eng"
    try:
        status, _ct, raw = _aromepi_http_get(url, api_key, timeout=45)
    except Exception:
        return {}
    if status != 200 or not raw:
        return {}
    by_prefix: dict[str, list[str]] = {}
    for cid in re.findall(r"CoverageId>([^<]+)<", raw.decode("utf-8", "replace")):
        if "___" not in cid:
            continue
        by_prefix.setdefault(cid.split("___", 1)[0], []).append(cid)
    if by_prefix:
        _set_cached_value(cache_key, by_prefix)
    return by_prefix


def _aromepi_pick_coverage(ids: list[str], time_iso: str) -> tuple[str | None, bool]:
    """Choisit le coverageId pour une échéance. (coverage, besoin_subset_time).
    1) coverage dont le datetime == temps valide (par-échéance) → sans subset time ;
    2) sinon coverage de série SANS suffixe d'accumulation (`_PT`) → avec subset time ;
    3) sinon le plus récent (au pire)."""
    if not ids:
        return None, True
    t_dot = "___" + time_iso.replace(":", ".")
    exact = [c for c in ids if c.endswith(t_dot)]
    if exact:
        return exact[0], False
    series = sorted([c for c in ids if "_PT" not in c.split("___", 1)[1]])
    if series:
        return series[-1], True
    return sorted(ids)[-1], True


def _aromepi_point_sync(api_key: str, lat: float, lon: float, time_iso: str, run_iso: str | None, layer_keys: list[str]) -> dict[str, Any]:
    out: dict[str, Any] = {}
    d = 0.02
    coverage_ids = _aromepi_wcs_coverage_ids(api_key)
    ref_dot = (run_iso or "").replace(":", ".")
    for key in layer_keys:
        spec = AROMEPI_LAYERS.get(key)
        if spec is None or spec.get("point") is False:
            out[key] = None
            continue
        accum = spec.get("wcs_accum")
        if accum and ref_dot:
            # coverage d'accumulation (rafale/graupel max sur la période de l'échéance)
            coverage_id, need_time = f"{spec['layer']}___{ref_dot}{accum}", True
        else:
            ids = coverage_ids.get(spec["layer"]) or ([f"{spec['layer']}___{ref_dot}"] if ref_dot else [])
            coverage_id, need_time = _aromepi_pick_coverage(ids, time_iso)
        if not coverage_id:
            out[key] = None
            continue
        params = [("service", "WCS"), ("version", "2.0.1"), ("coverageid", coverage_id)]
        if need_time:
            params.append(("subset", f"time({time_iso})"))
        if spec.get("wcs_height") is not None:
            params.append(("subset", f"height({int(spec['wcs_height'])})"))
        params += [
            ("subset", f"lat({lat - d:.5f},{lat + d:.5f})"),
            ("subset", f"long({lon - d:.5f},{lon + d:.5f})"),
            ("format", "image/tiff"),
        ]
        url = METEOFRANCE_AROMEPI_WCS_URL + "/GetCoverage?" + urllib.parse.urlencode(params)
        try:
            status, _ct, raw = _aromepi_http_get(url, api_key, timeout=30)
            if status != 200 or raw[:2] not in (b"II", b"MM"):
                out[key] = None
                continue
            sample = _extract_geotiff_center_sample(raw)
            value = sample.get("center_value") if sample.get("readable") else None
            if value is not None and spec.get("wcs_scale"):
                value = round(float(value) * float(spec["wcs_scale"]), 2)
            out[key] = value
        except Exception:
            out[key] = None
    return out


def _aromepi_status_sync() -> dict[str, Any]:
    api_key = _aromepi_api_key()
    if not api_key:
        return {"ok": False, "available": False, "message": "Clé API AROME-PI absente côté serveur."}
    caps = _aromepi_capabilities_sync(api_key)
    if not caps.get("ok"):
        return {"ok": False, "available": False, "message": "Catalogue AROME-PI indisponible."}
    return {
        "ok": True,
        "available": True,
        "run": caps.get("run"),
        "forecast_times": caps.get("forecast_times"),
        "horizon_hours": AROMEPI_NOWCAST_HORIZON_HOURS,
        "layers": [{"key": k, "label": v["label"], "unit": v["unit"], "primary": bool(v.get("primary"))} for k, v in AROMEPI_LAYERS.items()],
        "attribution": "Météo-France AROME-PI",
    }


def _aromepi_activity_sync(layer_key: str, time_iso: str, run_iso: str | None) -> dict[str, Any]:
    """Fraction du domaine AROME-PI qui porte une donnée (pixels opaques) pour une
    couche/échéance — permet d'indiquer « aucune / faible / modérée / forte » activité
    (rassure : carte sobre = temps calme, pas un bug). Domaine WMS = lat 37.5–55.4,
    lon -12–16."""
    api_key = _aromepi_api_key()
    spec = AROMEPI_LAYERS.get(layer_key)
    if not api_key or spec is None:
        return {"ok": False}
    params = [
        ("service", "WMS"), ("version", "1.3.0"), ("request", "GetMap"),
        ("layers", spec["layer"]), ("styles", ""), ("crs", "EPSG:4326"),
        ("bbox", "37.5,-12,55.4,16"), ("width", "300"), ("height", "300"),
        ("format", "image/png"), ("transparent", "true"), ("time", time_iso),
    ]
    if run_iso:
        params.append(("dim_reference_time", run_iso))
    url = METEOFRANCE_AROMEPI_WMS_URL + "/GetMap?" + urllib.parse.urlencode(params)
    try:
        status, _ct, raw = _aromepi_http_get(url, api_key, timeout=25)
        if status != 200 or raw[:4] != b"\x89PNG":
            return {"ok": False}
        from PIL import Image
        import numpy as np
        alpha = np.asarray(Image.open(io.BytesIO(raw)).convert("RGBA"))[:, :, 3]
        fraction = float((alpha > 10).sum()) / float(alpha.size or 1)
    except Exception:
        return {"ok": False}
    if fraction < 0.004:
        level = "none"
    elif fraction < 0.04:
        level = "low"
    elif fraction < 0.18:
        level = "moderate"
    else:
        level = "high"
    return {"ok": True, "fraction": round(fraction, 4), "level": level}


@app.get("/api/aromepi/activity")
async def aromepi_activity(
    layer: str = Query(..., min_length=1, max_length=40),
    time: str = Query(..., min_length=10, max_length=40),
    run: str | None = Query(None, max_length=40),
) -> dict[str, Any]:
    return await asyncio.to_thread(_aromepi_activity_sync, layer, time, run)


class AromepiPointRequest(BaseModel):
    lat: float = Field(..., ge=-90, le=90)
    lon: float = Field(..., ge=-180, le=180)
    time: str = Field(..., min_length=10, max_length=40)
    run: str | None = Field(None, max_length=40)
    layers: list[str] | None = None


@app.get("/api/aromepi/status")
async def aromepi_status() -> dict[str, Any]:
    """Mode En chasse : dernier run AROME-PI + échéances 15 min disponibles + couches."""
    return await asyncio.to_thread(_aromepi_status_sync)


@app.get("/api/aromepi/wms")
async def aromepi_wms(
    layer: str = Query(..., min_length=1, max_length=40),
    time: str = Query(..., min_length=10, max_length=40),
    bbox: str = Query(..., min_length=8, max_length=120),
    run: str | None = Query(None, max_length=40),
    width: int = Query(256, ge=64, le=1024),
    height: int = Query(256, ge=64, le=1024),
) -> Response:
    """Proxy de tuiles WMS AROME-PI (clé serveur). bbox attendu en EPSG:3857
    (MapLibre `{bbox-epsg-3857}`), converti en 4326 côté serveur."""
    api_key = _aromepi_api_key()
    if not api_key:
        return Response(content=AROMEPI_TRANSPARENT_PNG, media_type="image/png")
    status, png = await asyncio.to_thread(_aromepi_wms_tile_sync, api_key, layer, time, run, bbox, width, height)
    if status != 200 or not png:
        # tuile transparente plutôt qu'une erreur : la carte reste propre (échéance ou
        # secteur sans donnée AROME-PI).
        return Response(content=AROMEPI_TRANSPARENT_PNG, media_type="image/png", headers={"Cache-Control": "public, max-age=30"})
    return Response(content=png, media_type="image/png", headers={"Cache-Control": "public, max-age=120"})


@app.get("/api/aromepi/image")
async def aromepi_image(
    layer: str = Query(..., min_length=1, max_length=40),
    time: str = Query(..., min_length=10, max_length=40),
    run: str | None = Query(None, max_length=40),
) -> Response:
    """Image AROME-PI plein-domaine reprojetée Web Mercator (source MapLibre `image`).
    Remplace le proxy de tuiles : la passerelle WMS MF préserve le ratio géographique du
    bbox, donc des tuiles carrées décalent la donnée selon le zoom. Une image unique au bon
    ratio reste calée exactement (coins = domaine AROME-PI)."""
    api_key = _aromepi_api_key()
    if not api_key:
        return Response(content=AROMEPI_TRANSPARENT_PNG, media_type="image/png")
    png = await asyncio.to_thread(_aromepi_domain_image_sync, api_key, layer, time, run)
    if not png:
        return Response(content=AROMEPI_TRANSPARENT_PNG, media_type="image/png", headers={"Cache-Control": "public, max-age=30"})
    # immuable pour ce (couche, échéance, run) → cache navigateur long : la navigation
    # (frise / onglets) ne refait aucune requête.
    return Response(content=png, media_type="image/png", headers={"Cache-Control": "public, max-age=900"})


@app.post("/api/aromepi/point")
async def aromepi_point(payload: AromepiPointRequest) -> dict[str, Any]:
    """Valeurs AROME-PI à une position (réflectivité, grêle, rafales, CAPE, MOCON…)
    pour l'échéance demandée — alimente le panneau « conditions à ta position »."""
    api_key = _aromepi_api_key()
    if not api_key:
        return {"ok": False, "message": "Clé API AROME-PI absente côté serveur."}
    keys = [k for k in (payload.layers or list(AROMEPI_LAYERS.keys())) if k in AROMEPI_LAYERS]
    run = payload.run
    if not run:
        caps = await asyncio.to_thread(_aromepi_capabilities_sync, api_key)
        run = caps.get("run")
    values = await asyncio.to_thread(_aromepi_point_sync, api_key, payload.lat, payload.lon, payload.time, run, keys)
    return {"ok": True, "lat": payload.lat, "lon": payload.lon, "time": payload.time, "run": run, "values": values}


# ── Radar observé Météo-France (paquet DPPaquetRadar) ───────────────────────────
# Mosaïque « lame d'eau » (cumul de pluie 5 min, quantité ODIM ACRR) métropole, fichier
# HDF5 ODIM `T_IPRN20…h5` dans le paquet `/mosaique/paquet` (.tar.gz, dernier 1/4h = 3
# échéances à 5 min). Officiel MF, 500 m. Sert de radar observé sur la France ; RainViewer
# reste le repli mondial (boucle plus longue). Réflectivité dBZ = BUFR à tables locales MF,
# non retenue (déploiement trop lourd). Reprojection stéréographique polaire → Web Mercator
# (pyproj) pour la source MapLibre `image`, calée sur MF_RADAR_DOMAIN.
METEOFRANCE_RADAR_PACKAGE_URL = "https://public-api.meteofrance.fr/public/DPPaquetRadar/v1/mosaique/paquet"
MF_RADAR_PROJDEF = "+proj=stere +lat_0=90 +lon_0=0 +lat_ts=45 +ellps=WGS84 +x_0=619652.07 +y_0=5262818.34 +datum=WGS84"
MF_RADAR_GRID_EXTENT_M = 1736000.0   # 3472 px × 500 m
MF_RADAR_GRID_SIZE = 3472
MF_RADAR_PIXEL_M = 500.0
MF_RADAR_DOMAIN = {"min_lon": -10.0, "max_lon": 17.6, "min_lat": 37.4, "max_lat": 53.7}
# 2400 px sur ~27,6° ≈ 1,15 km/px (vs 500 m natif) : ~2× la résolution précédente, lisible
# au zoom France. Carte d'indices calculée une fois (par blocs, cf. _mf_radar_index_map).
MF_RADAR_OUT_WIDTH = 2400
MF_RADAR_CACHE_TTL = 150
# Bandes de cumul 5 min (mm) → couleurs type radar (croissant ; <0.03 mm = transparent).
# Seuil d'entrée abaissé (0.05→0.03) + opacités relevées : MF moins « discret » que RainViewer
# (qui est dessous) là où il pleut, tout en restant lisible.
_MF_RADAR_BANDS = [0.03, 0.1, 0.3, 0.7, 1.5, 3.0, 6.0, 12.0]
_MF_RADAR_COLORS = [
    (90, 150, 250, 205), (60, 180, 255, 220), (30, 210, 170, 230), (130, 225, 70, 238),
    (245, 225, 50, 244), (250, 150, 30, 248), (240, 70, 45, 252), (185, 50, 175, 255),
]
_MF_RADAR_INDEX = None  # carte d'indices sortie(Mercator)→grille(stéréo), calculée une fois


def _mf_radar_api_key() -> str | None:
    raw = os.environ.get("METEOFRANCE_RADAR_API_KEY")
    if not raw:
        path = os.path.join(os.path.dirname(os.path.abspath(__file__)), "Clef API RADAR.txt")
        try:
            with open(path, encoding="utf-8") as handle:
                raw = handle.read().strip()
        except OSError:
            return None
    if not raw:
        return None
    try:
        return _clean_meteofrance_api_key(raw)
    except HTTPException:
        return None


def _mf_radar_index_map():
    """(row, col, in_bounds, OW, OH) : pour chaque pixel de l'image de sortie (grille Web
    Mercator sur MF_RADAR_DOMAIN), l'indice du pixel source dans la grille stéréographique.
    Géométrie pure (indépendante de la donnée) → calculée une seule fois."""
    global _MF_RADAR_INDEX
    if _MF_RADAR_INDEX is not None:
        return _MF_RADAR_INDEX
    import numpy as np
    import pyproj
    d = MF_RADAR_DOMAIN
    r_earth = 6378137.0
    mx0 = r_earth * math.radians(d["min_lon"]); mx1 = r_earth * math.radians(d["max_lon"])
    my0 = r_earth * math.log(math.tan(math.pi / 4 + math.radians(d["min_lat"]) / 2))
    my1 = r_earth * math.log(math.tan(math.pi / 4 + math.radians(d["max_lat"]) / 2))
    ow = MF_RADAR_OUT_WIDTH
    oh = int(round(ow * (my1 - my0) / (mx1 - mx0)))
    xs = mx0 + (np.arange(ow) + 0.5) / ow * (mx1 - mx0)
    lon = np.degrees(xs / r_earth)                                  # (ow,) — colonnes
    ys = my1 - (np.arange(oh) + 0.5) / oh * (my1 - my0)
    lat = np.degrees(2.0 * np.arctan(np.exp(ys / r_earth)) - np.pi / 2.0)   # (oh,) — lignes
    transformer = pyproj.Transformer.from_crs("EPSG:4326", pyproj.CRS.from_proj4(MF_RADAR_PROJDEF), always_xy=True)
    # Reprojection par BLOCS de lignes : seuls row/col/inb (int) sont conservés (~45 Mo à
    # 2400 px) ; le transitoire flottant est borné à un bloc (~30 Mo) → sûr en mémoire.
    row = np.empty(oh * ow, np.int32)
    col = np.empty(oh * ow, np.int32)
    inb = np.empty(oh * ow, bool)
    block = max(1, 1_000_000 // ow)
    for r0 in range(0, oh, block):
        r1 = min(oh, r0 + block)
        lon2d = np.broadcast_to(lon, (r1 - r0, ow)).ravel()
        lat2d = np.repeat(lat[r0:r1], ow)
        px, py = transformer.transform(lon2d, lat2d)
        c = (np.asarray(px) / MF_RADAR_PIXEL_M).astype(np.int32)
        rr = ((MF_RADAR_GRID_EXTENT_M - np.asarray(py)) / MF_RADAR_PIXEL_M).astype(np.int32)
        sl = slice(r0 * ow, r1 * ow)
        col[sl] = c; row[sl] = rr
        inb[sl] = (c >= 0) & (c < MF_RADAR_GRID_SIZE) & (rr >= 0) & (rr < MF_RADAR_GRID_SIZE)
    _MF_RADAR_INDEX = (row, col, inb, ow, oh)
    return _MF_RADAR_INDEX


def _mf_radar_render_h5(h5_bytes: bytes) -> bytes | None:
    """Décode un HDF5 ODIM (lame d'eau ACRR), ré-échantillonne sur la grille Mercator via la
    carte d'indices, colorise (bandes mm) → PNG RGBA transparent hors pluie/hors couverture."""
    try:
        import numpy as np
        import h5py
        from PIL import Image
        with h5py.File(io.BytesIO(h5_bytes), "r") as h:
            dw = h["dataset1"]["data1"]["what"].attrs
            gain = float(dw["gain"]); offset = float(dw["offset"])
            nodata = float(dw["nodata"]); undetect = float(dw["undetect"])
            grid = h["dataset1"]["data1"]["data"][:]
        row, col, inb, ow, oh = _mf_radar_index_map()
        samp = np.full(row.shape, nodata, np.float32)
        samp[inb] = grid[row[inb], col[inb]]
        valid = (samp != nodata) & (samp != undetect)
        mm = np.where(valid, samp * gain + offset, 0.0)
        palette = np.array([(0, 0, 0, 0)] + _MF_RADAR_COLORS, np.uint8)
        idx = np.digitize(mm, np.array(_MF_RADAR_BANDS))
        out = palette[idx].reshape(oh, ow, 4)
        buf = io.BytesIO()
        Image.fromarray(out, "RGBA").save(buf, format="PNG")
        return buf.getvalue()
    except Exception:
        return None


def _mf_radar_refresh_sync(api_key: str) -> dict[str, Any]:
    """Télécharge le paquet radar (cache court), extrait les 3 mosaïques lame d'eau
    métropole, les rend en PNG Mercator. Renvoie {ok, times[], frames{iso:png}}."""
    cache_key = "mfradar:bundle"
    cached = _get_cached_value(cache_key, ttl=MF_RADAR_CACHE_TTL)
    if cached is not None:
        return cached["payload"]
    import tarfile
    status, _ct, raw = _aromepi_http_get(METEOFRANCE_RADAR_PACKAGE_URL, api_key, timeout=90)
    if status != 200 or not raw or raw[:2] != b"\x1f\x8b":
        result = {"ok": False, "times": [], "frames": {}}
        _set_cached_value(cache_key, result)
        return result
    frames: dict[str, bytes] = {}
    try:
        tf = tarfile.open(fileobj=io.BytesIO(raw), mode="r:gz")
        for member in tf.getmembers():
            name = member.name
            if "IPRN20" not in name or not name.endswith(".h5"):
                continue
            stamp = re.search(r"_(\d{14})\.h5", name)
            if not stamp:
                continue
            s = stamp.group(1)
            iso = f"{s[0:4]}-{s[4:6]}-{s[6:8]}T{s[8:10]}:{s[10:12]}:{s[12:14]}Z"
            data = tf.extractfile(member).read()
            png = _mf_radar_render_h5(data)
            if png:
                frames[iso] = png
    except Exception:
        pass
    result = {"ok": bool(frames), "times": sorted(frames), "frames": frames}
    _set_cached_value(cache_key, result)
    return result


@app.get("/api/radar/mf/status")
async def mf_radar_status() -> dict[str, Any]:
    """Échéances radar observé Météo-France (lame d'eau) du dernier 1/4h + domaine (coins)."""
    api_key = _mf_radar_api_key()
    if not api_key:
        return {"ok": False, "reason": "no_key"}
    bundle = await asyncio.to_thread(_mf_radar_refresh_sync, api_key)
    return {
        "ok": bool(bundle.get("ok")),
        "times": bundle.get("times", []),
        "domain": MF_RADAR_DOMAIN,
        "attribution": "Météo-France — radar lame d'eau",
    }


@app.get("/api/radar/mf/image")
async def mf_radar_image(time: str = Query(..., min_length=10, max_length=40)) -> Response:
    """Image radar observé MF (lame d'eau) reprojetée Web Mercator pour une échéance,
    source MapLibre `image` calée sur MF_RADAR_DOMAIN."""
    api_key = _mf_radar_api_key()
    if not api_key:
        return Response(content=AROMEPI_TRANSPARENT_PNG, media_type="image/png")
    bundle = await asyncio.to_thread(_mf_radar_refresh_sync, api_key)
    png = bundle.get("frames", {}).get(time)
    if not png:
        return Response(content=AROMEPI_TRANSPARENT_PNG, media_type="image/png", headers={"Cache-Control": "public, max-age=30"})
    return Response(content=png, media_type="image/png", headers={"Cache-Control": "public, max-age=120"})


@app.post('/api/server/arome-automation-start')
async def server_arome_automation_start(payload: ServerAromeAutomationRequest) -> dict[str, Any]:
    _validate_server_admin_secret(payload.secret)
    return await asyncio.to_thread(_start_server_arome_automation_thread, manual=True)


@app.post('/api/server/arome-automation-stop')
async def server_arome_automation_stop(payload: ServerAromeAutomationRequest) -> dict[str, Any]:
    _validate_server_admin_secret(payload.secret)
    await asyncio.to_thread(_stop_server_arome_automation_thread)
    _update_server_arome_automation_state(
        enabled=False,
        running=False,
        message='Arret de l automatisation AROME serveur demande.',
        current_job=None,
    )
    return await asyncio.to_thread(_server_arome_automation_status)


@app.post('/api/server/arome-preload-now')
async def server_arome_preload_now(payload: ServerAromePreloadNowRequest) -> dict[str, Any]:
    _validate_server_admin_secret(payload.secret)
    api_key = _server_meteofrance_api_key_required()
    target_date = payload.date or datetime.now(OBJECTIFOUDRE_SERVER_TIMEZONE).date()
    requested_grid = payload.grid if payload.grid is not None else OBJECTIFOUDRE_AUTO_PRELOAD_GRID
    run_schedule = _server_arome_run_schedule()
    with _server_arome_automation_lock:
        state = copy.deepcopy(_server_arome_automation_state)
    availability_reference_time, _ = _server_arome_availability_reference(state, run_schedule)
    coverage = _server_arome_cache_coverage(api_key, target_date, requested_grid, availability_reference_time)
    allowed_hours = [int(item) for item in (coverage.get("available_hours") or []) if 0 <= int(item) <= 23]
    schedule = await asyncio.to_thread(
        _schedule_meteofrance_grib_national_day_preload,
        None,
        api_key,
        target_date,
        requested_grid,
        allowed_hours=allowed_hours,
    )
    _update_server_arome_automation_state(
        last_job_key=schedule.get('job_key'),
        last_schedule=schedule,
        current_job=schedule.get('progress'),
        message=(
            f'Prechargement manuel AROME France {target_date.isoformat()} lance.'
            if schedule.get('scheduled')
            else schedule.get('message') or f'Prechargement manuel AROME France {target_date.isoformat()} deja traite.'
        ),
    )
    return {
        'ok': True,
        'date': target_date.isoformat(),
        'schedule': schedule,
        'status': await asyncio.to_thread(_server_arome_automation_status),
    }


@app.get("/sw.js")
def service_worker() -> FileResponse:
    return FileResponse(STATIC_DIR / "sw.js", media_type="application/javascript", headers={"Cache-Control": "no-store, max-age=0"})


@app.get("/favicon.ico")
def favicon() -> FileResponse:
    icon = STATIC_DIR / "icons" / "icon-192.png"
    return FileResponse(icon, media_type="image/png")




def _ensure_meteofrance_diagnostics_enabled(endpoint: str) -> None:
    if OBJECTIFOUDRE_ENABLE_METEOFRANCE_DIAGNOSTICS:
        return
    raise HTTPException(
        status_code=410,
        detail={
            "message": f"{endpoint} est un endpoint de diagnostic Météo-France et est désactivé par défaut.",
            "replacement": "/api/meteofrance/grib-france-slot-grid-cache",
            "enable_with": "OBJECTIFOUDRE_ENABLE_METEOFRANCE_DIAGNOSTICS=1",
        },
    )


def _ensure_legacy_local_arome_enabled(endpoint: str) -> None:
    if OBJECTIFOUDRE_ENABLE_LEGACY_LOCAL_AROME:
        return
    raise HTTPException(
        status_code=410,
        detail={
            'message': f'{endpoint} est retire de la migration AROME France et desactive par defaut.',
            'replacement': '/api/meteofrance/grib-france-slot-grid-cache',
            'enable_with': 'OBJECTIFOUDRE_ENABLE_LEGACY_LOCAL_AROME=1',
        },
    )


def _ensure_legacy_open_meteo_enabled(endpoint: str) -> None:
    if OBJECTIFOUDRE_ENABLE_LEGACY_OPEN_METEO:
        return
    raise HTTPException(
        status_code=410,
        detail={
            "message": f"{endpoint} est retire de la migration AROME France et desactive par defaut.",
            "replacement": "/api/meteofrance/grib-france-slot-grid-cache",
            "enable_with": "OBJECTIFOUDRE_ENABLE_LEGACY_OPEN_METEO=1",
        },
    )

@app.get("/api/latest")
async def latest(
    lat: float = Query(45.7640, ge=-90, le=90),
    lon: float = Query(4.8357, ge=-180, le=180),
    label: str = Query(DEFAULT_CENTER_LABEL, min_length=1, max_length=120),
    date: Date | None = Query(None),
    force: bool = False,
    mode: str = Query("auto", pattern="^(auto|forecast|historical|mock)$"),
) -> dict:
    _ensure_legacy_open_meteo_enabled("/api/latest")
    _purge_expired_cache()
    key = _latest_cache_key(lat, lon, date, mode, label)
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
    except ValueError as exc:
        async with _lock:
            if _inflight.get(key) is task:
                _inflight.pop(key, None)
        raise HTTPException(status_code=400, detail=str(exc))
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

        nearby, dist = _nearest_recent_cache(lat, lon, date, mode)
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
    _ensure_legacy_open_meteo_enabled("/api/historical-analysis")
    _purge_expired_cache()
    key = _historical_cache_key(lat, lon, date, label, mode)
    cached = _get_cached_value(key)
    if not force and cached is not None:
        return _with_cache_meta(cached["payload"], hit=True, created_at=cached["ts"])

    points = build_grid(center_lat=lat, center_lon=lon, zone_prefix=label)
    try:
        rows = await asyncio.to_thread(fetch_model, points, date, mode)
        payload = build_historical_analysis_payload(rows, lat, lon, label, date)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
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
    _ensure_legacy_open_meteo_enabled("/api/historical-analysis.csv")
    _purge_expired_cache()
    key = _historical_cache_key(lat, lon, date, label, mode, zone=zone, slot=slot)
    cached = _get_cached_value(key)
    if not force and cached is not None:
        rows = cached["payload"]
    else:
        try:
            rows = await asyncio.to_thread(_analysis_rows, lat, lon, label, date, zone, slot, mode)
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc))
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
