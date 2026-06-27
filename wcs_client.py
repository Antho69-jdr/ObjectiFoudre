#!/usr/bin/env python3
"""Client WCS GetCoverage Météo-France — module isolé, pur, testable seul.

Contourne le mur des paquets IP (cf. mémoire project_wcs_solution) : au lieu de
télécharger un paquet GRIB de 538 Mo, on demande UN champ (1 niveau, 1 échéance,
bbox France) en GRIB via WCS GetCoverage → quelques Mo, décodé avec eccodes.

Deux sources :
  - AROME FRANCE 0,01° : champs SURFACE absents des paquets (CIN, MLCAPE, CAPE_INS…)
  - ARPEGE EUROPE 0,1° : vent ISOBARE (u/v à un niveau de pression) → cisaillement profond

API principale : fetch_france_field(field_key, run_iso, valid_iso, points, keys) -> {zone: value}
`points` = itérable d'objets/dicts avec .zone/.lat/.lon (ou clés "zone"/"lat"/"lon").

N'importe RIEN de app.py (pas d'effet de bord). Intégration : app.py appelle
fetch_france_field en enrichissement NON-FATAL de field_values.
"""
from __future__ import annotations

import math
import os
import re
import tempfile
import threading
import time
import urllib.parse
import urllib.request
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterable

import eccodes

HERE = Path(__file__).resolve().parent

_AROME_BASE = "https://public-api.meteofrance.fr/public/arome/1.0/wcs/MF-NWP-HIGHRES-AROME-001-FRANCE-WCS"
_ARPEGE_BASE = "https://public-api.meteofrance.fr/public/arpege/1.0/wcs/MF-NWP-GLOBAL-ARPEGE-01-EUROPE-WCS"

# bbox France métropolitaine (long_min, long_max, lat_min, lat_max)
FRANCE_BBOX = (-5.5, 9.8, 41.0, 51.6)

# field_key -> (source, coverage_id, pressure_level|None)
COVERAGE_REGISTRY: dict[str, tuple[str, str, int | None]] = {
    "convective_inhibition": ("arome", "CIN__GROUND", None),
    "mucape": ("arome", "MLCAPE__GROUND", None),
    "mlcape": ("arome", "MLCAPE__GROUND", None),
    "cape_ins": ("arome", "CAPE_INS__GROUND", None),
    "u_500hpa": ("arpege", "U_COMPONENT_OF_WIND__ISOBARIC_SURFACE", 500),
    "v_500hpa": ("arpege", "V_COMPONENT_OF_WIND__ISOBARIC_SURFACE", 500),
}

_BASE_BY_SOURCE = {"arome": _AROME_BASE, "arpege": _ARPEGE_BASE}


class WcsError(RuntimeError):
    pass


_ENV_KEY = {"arome": "METEOFRANCE_MODEL_AROME_API_KEY", "arpege": "METEOFRANCE_MODEL_ARPEGE_API_KEY"}


def default_key(source: str) -> str:
    """Clé WCS : variable d'env d'abord (Render), sinon fichier texte (local)."""
    env = os.environ.get(_ENV_KEY[source], "").strip()
    if env:
        return env
    fname = "Clef API MODEL AROME.txt" if source == "arome" else "Clef API MODEL ARPEGE.txt"
    return (HERE / fname).read_text().strip()


# --- sélection du run via GetCapabilities (mis en cache) --------------------
_MAX_HORIZON_H = {"arome": 48, "arpege": 102}  # horizon max couvert par run
_CAPS_TTL_S = 1800.0
_caps_lock = threading.Lock()
_caps_cache: dict[str, tuple[float, str]] = {}  # source -> (fetched_at, xml)


def _caps_url(source: str) -> str:
    svc = "MF-NWP-HIGHRES-AROME-001-FRANCE-WCS" if source == "arome" else "MF-NWP-GLOBAL-ARPEGE-01-EUROPE-WCS"
    model = "arome" if source == "arome" else "arpege"
    return (f"https://public-api.meteofrance.fr/public/{model}/1.0/wcs/{svc}/GetCapabilities"
            "?service=WCS&version=2.0.1&language=fre")


def _fetch_caps(source: str, key: str, timeout: float = 60.0) -> str:
    now = time.time()
    with _caps_lock:
        hit = _caps_cache.get(source)
        if hit and now - hit[0] < _CAPS_TTL_S:
            return hit[1]
    req = urllib.request.Request(_caps_url(source), headers={"apikey": key, "Authorization": f"Bearer {key}"})
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        xml = resp.read().decode("utf-8", "replace")
    with _caps_lock:
        _caps_cache[source] = (now, xml)
    return xml


def _parse_run(ts: str) -> datetime:
    return datetime.strptime(ts, "%Y-%m-%dT%H.%M.%SZ").replace(tzinfo=timezone.utc)


_RUN_TS_RE = re.compile(r"___([0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}\.[0-9]{2}\.[0-9]{2}Z)")


def available_runs(source: str, key: str) -> list[str]:
    """Tous les timestamps de run du caps (communs à tous les params, robuste au
    double nommage MF codes-courts / noms-longs servi par les deux backends)."""
    xml = _fetch_caps(source, key)
    return sorted(set(_RUN_TS_RE.findall(xml)), key=_parse_run)


def run_for_valid(source: str, valid_dt: datetime, key: str) -> str | None:
    """Run le plus récent qui couvre valid_dt (run <= valid, écart <= horizon)."""
    horizon = _MAX_HORIZON_H.get(source, 48)
    best = None
    for ts in available_runs(source, key):  # trié croissant
        r = _parse_run(ts)
        if r <= valid_dt and (valid_dt - r).total_seconds() <= horizon * 3600:
            best = ts
    return best


def get_coverage(source: str, coverage_id: str, *, subsets: list[str], key: str, timeout: float = 90.0) -> bytes:
    base = _BASE_BY_SOURCE[source]
    params = {"service": "WCS", "version": "2.0.1", "coverageId": coverage_id, "format": "application/wmo-grib"}
    url = f"{base}/GetCoverage?" + urllib.parse.urlencode(params)
    for s in subsets:
        url += "&subset=" + urllib.parse.quote(s, safe="(),.:-")
    req = urllib.request.Request(url, headers={"apikey": key, "Authorization": f"Bearer {key}"})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            raw = resp.read()
    except urllib.error.HTTPError as e:  # noqa: PERF203
        body = e.read()[:400].decode("utf-8", "replace")
        raise WcsError(f"WCS {coverage_id} HTTP {e.code}: {body}") from e
    if not raw.startswith(b"GRIB"):
        raise WcsError(f"WCS {coverage_id}: réponse non-GRIB ({raw[:120]!r})")
    return raw


def _point_fields(p: Any) -> tuple[str, float, float]:
    if isinstance(p, dict):
        return str(p["zone"]), float(p["lat"]), float(p["lon"])
    return str(p.zone), float(p.lat), float(p.lon)


def _nearest_values(gid: int, lats: list[float], lons: list[float]) -> list[float | None]:
    """Valeurs au plus proche voisin, alignées sur l'entrée. Sur grille régulière
    (regular_ll), indice calculé par arithmétique vectorisée numpy (O(1)/point) au lieu
    d'une recherche eccodes O(grille)/point. Repli eccodes multi-points sinon. Résultat
    identique à codes_grib_find_nearest (équivalence vérifiée)."""
    n = len(lats)
    if not n:
        return []
    try:
        if str(eccodes.codes_get(gid, "gridType")) == "regular_ll":
            import numpy as np

            ni = int(eccodes.codes_get(gid, "Ni"))
            nj = int(eccodes.codes_get(gid, "Nj"))
            j_consecutive = int(eccodes.codes_get(gid, "jPointsAreConsecutive"))
            dlat = np.asarray(eccodes.codes_get_array(gid, "distinctLatitudes"), dtype=float)
            dlon = np.asarray(eccodes.codes_get_array(gid, "distinctLongitudes"), dtype=float)
            if dlat.size == nj and dlon.size == ni and dlat.size >= 2 and dlon.size >= 2:
                lat0 = dlat[0]
                lon0 = dlon[0]
                lat_step = dlat[1] - dlat[0]
                lon_step = dlon[1] - dlon[0]
                qlat = np.asarray(lats, dtype=float)
                qlon = np.asarray(lons, dtype=float)
                jj = np.clip(np.rint((qlat - lat0) / lat_step).astype(int), 0, nj - 1)
                ii = np.clip(np.rint((qlon - lon0) / lon_step).astype(int), 0, ni - 1)
                flat = (ii * nj + jj) if j_consecutive else (jj * ni + ii)
                values = np.asarray(eccodes.codes_get_values(gid), dtype=float)
                return [float(values[f]) for f in flat]
    except Exception:
        pass
    nearest = eccodes.codes_grib_find_nearest_multiple(gid, False, list(lats), list(lons))
    return [near.value for near in nearest]


def sample_at_points(raw: bytes, points: Iterable[Any]) -> dict[str, float]:
    """Décode le 1er message GRIB et renvoie {zone: valeur} au point le plus proche."""
    with tempfile.NamedTemporaryFile(suffix=".grib", delete=False) as fh:
        fh.write(raw)
        path = fh.name
    out: dict[str, float] = {}
    try:
        with open(path, "rb") as f:
            gid = eccodes.codes_grib_new_from_file(f)
            if gid is None:
                raise WcsError("pas de message GRIB décodable")
            try:
                triples = [_point_fields(p) for p in points]
                if triples:
                    vals = _nearest_values(gid, [t[1] for t in triples], [t[2] for t in triples])
                    for (zone, _lat, _lon), val in zip(triples, vals):
                        if val is not None and math.isfinite(val):
                            out[zone] = float(val)
            finally:
                eccodes.codes_release(gid)
    finally:
        Path(path).unlink(missing_ok=True)
    return out


def fetch_france_field(
    field_key: str,
    valid_iso: str,          # ex "2026-06-22T15:00:00Z" (deux-points, SANS guillemets)
    points: Iterable[Any],
    *,
    run_iso: str | None = None,   # auto-résolu depuis valid_iso si None (ex "2026-06-22T12.00.00Z")
    keys: dict[str, str] | None = None,
    bbox: tuple[float, float, float, float] = FRANCE_BBOX,
    timeout: float = 90.0,
) -> dict[str, float]:
    if field_key not in COVERAGE_REGISTRY:
        raise WcsError(f"champ WCS inconnu: {field_key}")
    source, coverage, level = COVERAGE_REGISTRY[field_key]
    key = (keys or {}).get(source) or default_key(source)
    if run_iso is None:
        valid_dt = datetime.strptime(valid_iso, "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=timezone.utc)
        run_iso = run_for_valid(source, valid_dt, key)
        if run_iso is None:
            raise WcsError(f"aucun run WCS {source} ne couvre {valid_iso}")
    lo_lon, hi_lon, lo_lat, hi_lat = bbox
    subsets = [f"time({valid_iso})", f"long({lo_lon},{hi_lon})", f"lat({lo_lat},{hi_lat})"]
    if level is not None:
        subsets.append(f"pressure({level})")
    raw = get_coverage(source, f"{coverage}___{run_iso}", subsets=subsets, key=key, timeout=timeout)
    return sample_at_points(raw, list(points))


_ARPEGE_U_ISO = "U_COMPONENT_OF_WIND__ISOBARIC_SURFACE"
_ARPEGE_V_ISO = "V_COMPONENT_OF_WIND__ISOBARIC_SURFACE"
PROFILE_LEVELS = (925, 850, 700, 500, 300)


def _sample_isobaric(coverage: str, level: int, lat: float, lon: float, valid_iso: str, run_iso: str, key: str) -> float | None:
    d = 0.25  # mini-bbox autour du point (ARPEGE 0,1° -> quelques points)
    subsets = [f"time({valid_iso})", f"pressure({level})", f"long({lon - d},{lon + d})", f"lat({lat - d},{lat + d})"]
    raw = get_coverage("arpege", f"{coverage}___{run_iso}", subsets=subsets, key=key, timeout=30.0)
    return sample_at_points(raw, [{"zone": "pt", "lat": lat, "lon": lon}]).get("pt")


def fetch_wind_profile(
    lat: float,
    lon: float,
    valid_iso: str,
    *,
    levels: tuple[int, ...] = PROFILE_LEVELS,
    keys: dict[str, str] | None = None,
    run_iso: str | None = None,
) -> list[dict[str, float]]:
    """Profil vertical de vent (force + direction) aux niveaux isobares donnés, au point
    (lat, lon), pour l'échéance valid_iso. ARPEGE WCS. Une requête u + une v par niveau,
    parallélisées. Renvoie [{level, speed_ms, dir_deg}, ...] (niveaux trouvés seulement)."""
    key = (keys or {}).get("arpege") or default_key("arpege")
    if run_iso is None:
        valid_dt = datetime.strptime(valid_iso, "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=timezone.utc)
        run_iso = run_for_valid("arpege", valid_dt, key)
        if run_iso is None:
            raise WcsError(f"aucun run ARPEGE ne couvre {valid_iso}")

    def _one(level: int) -> dict[str, float] | None:
        try:
            u = _sample_isobaric(_ARPEGE_U_ISO, level, lat, lon, valid_iso, run_iso, key)
            v = _sample_isobaric(_ARPEGE_V_ISO, level, lat, lon, valid_iso, run_iso, key)
        except Exception:  # noqa: BLE001 - un niveau qui échoue ne casse pas le profil
            return None
        if u is None or v is None:
            return None
        speed = math.hypot(u, v)
        direction = (math.degrees(math.atan2(-u, -v)) + 360.0) % 360.0
        return {"level": int(level), "speed_ms": round(speed, 1), "dir_deg": round(direction)}

    from concurrent.futures import ThreadPoolExecutor
    with ThreadPoolExecutor(max_workers=min(5, len(levels))) as ex:
        results = list(ex.map(_one, levels))
    return [r for r in results if r]


# --- self-test standalone ---------------------------------------------------
if __name__ == "__main__":
    import sys

    run = sys.argv[1] if len(sys.argv) > 1 else "2026-06-22T12.00.00Z"
    valid = sys.argv[2] if len(sys.argv) > 2 else "2026-06-22T15:00:00Z"
    test_points = [
        {"zone": "Lyon", "lat": 45.7640, "lon": 4.8357},
        {"zone": "Toulouse", "lat": 43.6045, "lon": 1.4440},
        {"zone": "Paris", "lat": 48.8566, "lon": 2.3522},
        {"zone": "Strasbourg", "lat": 48.5734, "lon": 7.7521},
    ]
    print(f"== wcs_client self-test == valid={valid} (run auto-résolu)\n")
    for src in ("arome", "arpege"):
        runs = available_runs(src, default_key(src))
        print(f"  runs {src}: {len(runs)} dispo, dernier={runs[-1] if runs else None}")
    print()
    for fk in ("convective_inhibition", "mucape", "cape_ins", "u_500hpa", "v_500hpa"):
        try:
            vals = fetch_france_field(fk, valid, test_points)
            shown = "  ".join(f"{z}={vals.get(z, float('nan')):.1f}" for z in (p["zone"] for p in test_points))
            print(f"{fk:22s} -> {shown}")
        except Exception as e:  # noqa: BLE001
            print(f"{fk:22s} -> ECHEC: {e}")
