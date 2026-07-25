"""Horizon / champ de vision dégagé d'un spot — module isolé, pur, testable seul.

Brique « topographie » pour la carte « Mes spots » (Trello 6a57bacb…) et, à terme, un
facteur du score de chasse d'étoile. Audit de faisabilité : .h_collect/audit_lidar_2026-07-24.md.

Principe (validé au S0, hors ligne) : on échantillonne l'altitude du TERRAIN NU le long de
N azimuts autour du spot, via l'API altimétrie IGN (RGE ALTI = MNT dérivé du LiDAR HD), on
calcule l'angle d'élévation du relief par azimut (avec correction courbure terrestre +
réfraction) et on en tire un indice d'« ouverture » 0..100. Terrain statique → on cache par
spot (calcul une seule fois, ~13 s / ~330 Ko).

MVP = relief seul (pas d'obstruction proche arbres/bâti : le MNS LiDAR HD serait une phase 2,
cf. audit). N'importe RIEN de app.py : intégration en enrichissement NON-FATAL.

Contraintes mesurées : l'API renvoie 429 dès ~8 requêtes concurrentes → pool ≤ 3 + backoff.
Seule ressource acceptée : ign_rge_alti_wld.
"""
from __future__ import annotations

import json
import math
import os
import tempfile
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from typing import Callable

HERE = Path(__file__).resolve().parent

_ALTI_LINE = "https://data.geopf.fr/altimetrie/1.0/calcul/alti/rest/elevationLine.json"
_ALTI_PT = "https://data.geopf.fr/altimetrie/1.0/calcul/alti/rest/elevation.json"
_RESOURCE = "ign_rge_alti_wld"
_UA = "ObjectiFoudre/1.0 (+https://objectifoudre.com)"

_R_EARTH = 6371000.0        # m
_K_REFRAC = 0.13            # réfraction atmosphérique standard (abaisse la courbure vue)
_MAX_WORKERS = 3            # rate-limit IGN : 429 au-delà (mesuré)
_NEAR_IGNORE_M = 30.0       # ignore l'immédiat (le point lui-même / bruit)

# Défauts du scan (24 azimuts × 150 échantillons sur 30 km = ~330 Ko, ~13 s au S0)
DEF_N_AZ = 24
DEF_DIST_KM = 30.0
DEF_SAMPLES = 150
DEF_EYE_H = 1.6             # hauteur d'œil de l'observateur (m)

_COMPASS = ["N", "NNE", "NE", "ENE", "E", "ESE", "SE", "SSE",
            "S", "SSW", "SW", "WSW", "W", "WNW", "NW", "NNW"]


class HorizonError(RuntimeError):
    pass


def cardinal(az_deg: float) -> str:
    return _COMPASS[int((az_deg % 360) / 22.5 + 0.5) % 16]


# --- HTTP avec backoff 429 ---------------------------------------------------
def _get_json(url: str, *, timeout: float = 40.0, tries: int = 5) -> dict:
    req = urllib.request.Request(url, headers={"User-Agent": _UA})
    for attempt in range(tries):
        try:
            with urllib.request.urlopen(req, timeout=timeout) as r:
                return json.loads(r.read())
        except urllib.error.HTTPError as e:
            if e.code == 429 and attempt < tries - 1:
                time.sleep(0.5 * (2 ** attempt))
                continue
            raise HorizonError(f"altimétrie HTTP {e.code}") from e
        except (urllib.error.URLError, TimeoutError) as e:
            if attempt < tries - 1:
                time.sleep(0.5 * (2 ** attempt))
                continue
            raise HorizonError(f"altimétrie injoignable: {e}") from e
    raise HorizonError("altimétrie: échec après retries")


# --- géodésie : point à distance+azimut -------------------------------------
def _dest_point(lon: float, lat: float, az_deg: float, dist_m: float) -> tuple[float, float]:
    """Point d'arrivée (lon,lat) à distance/azimut. pyproj si dispo, sinon sphérique."""
    try:
        from pyproj import Geod
        lon1, lat1, _ = Geod(ellps="WGS84").fwd(lon, lat, az_deg, dist_m)
        return lon1, lat1
    except Exception:
        ad = dist_m / _R_EARTH
        br = math.radians(az_deg)
        la1, lo1 = math.radians(lat), math.radians(lon)
        la2 = math.asin(math.sin(la1) * math.cos(ad) + math.cos(la1) * math.sin(ad) * math.cos(br))
        lo2 = lo1 + math.atan2(math.sin(br) * math.sin(ad) * math.cos(la1),
                               math.cos(ad) - math.sin(la1) * math.sin(la2))
        return math.degrees(lo2), math.degrees(la2)


def point_elevation(lon: float, lat: float) -> float:
    q = urllib.parse.urlencode({"lon": lon, "lat": lat, "resource": _RESOURCE, "zonly": "true"})
    d = _get_json(f"{_ALTI_PT}?{q}")
    els = d.get("elevations") or []
    if not els:
        raise HorizonError("altimétrie: pas d'élévation renvoyée")
    return float(els[0])


def _ray(lon: float, lat: float, az_deg: float, dist_m: float, samples: int) -> dict:
    """Profil d'un azimut → {'d':[m...], 'z':[m...], 'denivele_pos', 'denivele_neg'}."""
    lon1, lat1 = _dest_point(lon, lat, az_deg, dist_m)
    q = urllib.parse.urlencode({
        "lon": f"{lon}|{lon1}", "lat": f"{lat}|{lat1}",
        "resource": _RESOURCE, "sampling": samples, "delimiter": "|",
    })
    d = _get_json(f"{_ALTI_LINE}?{q}")
    els = d.get("elevations") or []
    if len(els) < 2:
        raise HorizonError("altimétrie: profil trop court")
    n = len(els) - 1
    ds = [dist_m * k / n for k in range(len(els))]
    zs = [float(e["z"]) for e in els]
    hd = d.get("height_differences") or {}
    return {"d": ds, "z": zs,
            "denivele_pos": float(hd.get("positive", 0.0)),
            "denivele_neg": float(hd.get("negative", 0.0))}


def _horizon_angle(z_eye: float, ds: list[float], zs: list[float]) -> tuple[float, float]:
    """Angle d'élévation (deg) du relief le plus haut vu depuis l'observateur ET sa distance
    (m), avec correction courbure terrestre + réfraction. >0 = au-dessus de l'horizontale.
    La distance est celle du point qui DÉFINIT l'horizon (la ligne de crête)."""
    best = -90.0
    best_d = 0.0
    for d, z in zip(ds, zs):
        if d < _NEAR_IGNORE_M:
            continue
        curv = (1.0 - _K_REFRAC) * d * d / (2.0 * _R_EARTH)
        ang = math.degrees(math.atan2((z - z_eye) - curv, d))
        if ang > best:
            best = ang
            best_d = d
    return best, best_d


def horizon_scan(lon: float, lat: float, *, n_az: int = DEF_N_AZ, dist_km: float = DEF_DIST_KM,
                 samples: int = DEF_SAMPLES, eye_h: float = DEF_EYE_H) -> dict:
    """Scan d'horizon 360° d'un spot. Renvoie :
      z0 (alt. spot, m), openness (0..100), mean_horizon_deg, max_horizon_deg,
      pct_below_5deg, pct_below_2deg, denivele_max_m (relief le plus marqué autour),
      azimuths [{az, cardinal, horizon_deg}].
    Lève HorizonError en cas d'échec réseau (à traiter en enrichissement non-fatal)."""
    z0 = point_elevation(lon, lat)
    z_eye = z0 + eye_h
    dist_m = dist_km * 1000.0
    azimuths = [360.0 * i / n_az for i in range(n_az)]

    def one(az: float) -> tuple[float, float, float, float]:
        r = _ray(lon, lat, az, dist_m, samples)
        ang, dist = _horizon_angle(z_eye, r["d"], r["z"])
        return az, ang, dist, r["denivele_pos"]

    with ThreadPoolExecutor(max_workers=_MAX_WORKERS) as ex:
        rows = sorted(ex.map(one, azimuths))

    angles = [a for _, a, _, _ in rows]
    denivele_max = max((dp for _, _, _, dp in rows), default=0.0)
    mean_ang = sum(angles) / len(angles)
    openness = max(0.0, min(100.0, 100.0 - 4.0 * mean_ang))
    return {
        "lon": lon, "lat": lat, "z0": round(z0, 1),
        "openness": round(openness, 1),
        "mean_horizon_deg": round(mean_ang, 2),
        "max_horizon_deg": round(max(angles), 2),
        "pct_below_5deg": round(100.0 * sum(1 for a in angles if a < 5.0) / len(angles)),
        "pct_below_2deg": round(100.0 * sum(1 for a in angles if a < 2.0) / len(angles)),
        "denivele_max_m": round(denivele_max),
        "azimuths": [{"az": round(az, 1), "cardinal": cardinal(az), "horizon_deg": round(a, 2),
                      "dist_km": round(dist / 1000.0, 2)}
                     for az, a, dist, _ in rows],
    }


def horizon_toward(scan: dict, az_deg: float) -> float:
    """Angle d'horizon (deg) le plus proche d'un azimut donné (ex. direction de l'orage)."""
    rows = scan.get("azimuths") or []
    if not rows:
        return 0.0
    best = min(rows, key=lambda r: abs(((r["az"] - az_deg + 180) % 360) - 180))
    return best["horizon_deg"]


def openness_factor(scan: dict) -> float:
    """Facteur 0..1 pour pondérer un score (1 = horizon dégagé). À brancher dans
    observation_score (chasse d'étoile) ou le score de spot."""
    return max(0.0, min(1.0, scan.get("openness", 0.0) / 100.0))


# --- cache disque par spot (terrain statique → 1 calcul à vie) --------------
def _cache_dir() -> Path:
    d = Path(os.environ.get("OBJECTIFOUDRE_HORIZON_CACHE", HERE / "data" / "horizon_cache"))
    d.mkdir(parents=True, exist_ok=True)
    return d


def _cache_key(lon: float, lat: float) -> str:
    # ~11 m de résolution (5 décimales) : deux spots à <11 m partagent leur horizon (OK)
    return f"{lat:.5f}_{lon:.5f}"


_scan_lock = threading.Lock()   # sérialise les calculs COLD (jamais > _MAX_WORKERS requêtes IGN)


def _read_cache(path: Path) -> dict | None:
    if path.exists():
        try:
            return json.loads(path.read_text())
        except Exception:
            return None  # cache corrompu → recalcul
    return None


def cached_horizon_scan(lon: float, lat: float, **kw) -> dict:
    """horizon_scan avec cache disque JSON atomique. Recalcul uniquement si absent.
    Les calculs COLD sont sérialisés par un verrou global : plusieurs spots créés en même
    temps ne lancent PAS N scans en parallèle (sinon 3·N requêtes concurrentes → 429 IGN).
    Le cache est re-vérifié sous verrou (double-checked) pour ne pas recalculer un point
    qu'un autre thread vient de terminer."""
    path = _cache_dir() / f"{_cache_key(lon, lat)}.json"
    hit = _read_cache(path)
    if hit is not None:
        return hit
    with _scan_lock:
        hit = _read_cache(path)     # un autre thread l'a peut-être calculé pendant l'attente
        if hit is not None:
            return hit
        scan = horizon_scan(lon, lat, **kw)
        with tempfile.NamedTemporaryFile("w", dir=path.parent, suffix=".tmp", delete=False) as fh:
            json.dump(scan, fh)
            tmp = fh.name
        os.replace(tmp, path)       # écriture atomique
        return scan


# --- self-test standalone ----------------------------------------------------
if __name__ == "__main__":
    SPOTS = {
        "Puy de Dôme (sommet)":   (2.9646, 45.7723, "ouvert"),
        "Chamonix (vallée)":      (6.8694, 45.9237, "encaissé"),
        "Beauce (plaine)":        (1.5000, 48.3000, "plat"),
    }
    ok = True
    for name, (lon, lat, attendu) in SPOTS.items():
        t0 = time.time()
        s = horizon_scan(lon, lat)
        dt = time.time() - t0
        print(f"\n=== {name} — attendu: {attendu} ===")
        print(f"  z0={s['z0']} m  ouverture={s['openness']}/100  "
              f"horizon moy={s['mean_horizon_deg']:+.2f}° max={s['max_horizon_deg']:+.2f}°  "
              f"<5°={s['pct_below_5deg']}%  dénivelé_max={s['denivele_max_m']} m  ({dt:.1f}s)")
        # assertions de non-régression (validées à la main au S0)
        if attendu == "ouvert" and s["openness"] < 90:
            print("  ✗ ATTENDU ouvert mais ouverture basse"); ok = False
        if attendu == "encaissé" and s["openness"] > 50:
            print("  ✗ ATTENDU encaissé mais ouverture haute"); ok = False
        if attendu == "plat" and s["openness"] < 95:
            print("  ✗ ATTENDU plat mais ouverture basse"); ok = False
    print("\n" + ("✓ self-test OK" if ok else "✗ self-test ÉCHOUÉ"))
