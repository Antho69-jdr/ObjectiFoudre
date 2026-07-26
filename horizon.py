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


# ── Obstruction PROCHE (arbres / bâti) via MNS LiDAR HD ──────────────────────
# Le relief (RGE ALTI) ne voit ni les arbres ni les bâtiments. Le MNS (surface =
# sol + végétation + bâti) les voit. Accès : WMS GetMap GeoTIFF float32 (pas de
# valeur ponctuelle). On tire UNE dalle ~400 m autour du spot et on l'échantillonne.
# Dé-risqué et validé main : .h_collect/mns_s0_obstruction.py (forêt +45°, ville +38°).
_MNS_WMS = "https://data.geopf.fr/wms-r/wms"
_MNS_LAYER = "IGNF_LIDAR-HD_MNS_ELEVATION.ELEVATIONGRIDCOVERAGE.LAMB93"
_NEAR_M = 400.0            # portée de l'obstruction proche (m)
_NEAR_STEP = 4.0          # pas d'échantillonnage le long d'un rayon (m)
_NEAR_IGNORE = 8.0        # ignore l'immédiat (< 8 m ; le point lui-même)
_MNS_COVER_MIN = 0.30     # fraction min de valeurs valides → dalle "couverte"


def _fetch_mns(lon: float, lat: float, half_m: float = _NEAR_M + 40.0):
    """Dalle MNS autour du point → (array float32, bbox) ou None (pas de couverture LiDAR
    HD, deps absentes, ou échec réseau — non-fatal : on retombe sur le relief seul)."""
    try:
        import io
        import numpy as np
        from PIL import Image
    except Exception:
        return None
    dlat = half_m / 111320.0
    dlon = half_m / (111320.0 * math.cos(math.radians(lat)))
    minlon, maxlon = lon - dlon, lon + dlon
    minlat, maxlat = lat - dlat, lat + dlat
    px = min(1000, max(256, int(2 * half_m)))     # ~1 m/px, plafonné 1000
    params = {
        "SERVICE": "WMS", "VERSION": "1.3.0", "REQUEST": "GetMap", "LAYERS": _MNS_LAYER,
        "STYLES": "", "CRS": "EPSG:4326",
        "BBOX": f"{minlat},{minlon},{maxlat},{maxlon}",   # WMS 1.3.0 / EPSG:4326 → axes lat,lon
        "WIDTH": px, "HEIGHT": px, "FORMAT": "image/geotiff",
    }
    url = f"{_MNS_WMS}?" + urllib.parse.urlencode(params)
    try:
        req = urllib.request.Request(url, headers={"User-Agent": _UA})
        with urllib.request.urlopen(req, timeout=40) as r:
            raw = r.read()
        arr = np.asarray(Image.open(io.BytesIO(raw)), dtype=float)
    except Exception:
        return None
    valid = arr[(arr > -100) & (arr < 5000)]
    if arr.size == 0 or valid.size / arr.size < _MNS_COVER_MIN:
        return None      # pas (ou trop peu) de couverture LiDAR HD ici
    return arr, (minlon, minlat, maxlon, maxlat)


def _mns_sample(arr, bbox, lon: float, lat: float):
    """Valeur MNS au plus proche voisin (None hors dalle / nodata). row 0 = haut = maxlat."""
    minlon, minlat, maxlon, maxlat = bbox
    hgt, wid = arr.shape
    col = int(round((lon - minlon) / (maxlon - minlon) * (wid - 1)))
    row = int(round((maxlat - lat) / (maxlat - minlat) * (hgt - 1)))
    if 0 <= row < hgt and 0 <= col < wid:
        z = arr[row, col]
        if -100 < z < 5000:
            return float(z)
    return None


def _near_obstruction(lon: float, lat: float, az: float, z_eye: float, mns,
                      start_m: float = _NEAR_IGNORE) -> tuple[float, float]:
    """Angle d'élévation max (deg) de la surface proche le long d'un azimut + sa distance (m),
    en IGNORANT tout ce qui est plus proche que start_m (mode donut : l'objet central dans le
    trou n'est pas compté). Renvoie (-90, 0) si rien vu. Courbure négligeable sur < 400 m."""
    arr, bbox = mns
    best_ang, best_d = -90.0, 0.0
    d = max(_NEAR_IGNORE, start_m)
    while d <= _NEAR_M:
        lon1, lat1 = _dest_point(lon, lat, az, d)
        z = _mns_sample(arr, bbox, lon1, lat1)
        if z is not None:
            ang = math.degrees(math.atan2(z - z_eye, d))
            if ang > best_ang:
                best_ang, best_d = ang, d
        d += _NEAR_STEP
    return best_ang, best_d


def horizon_scan(lon: float, lat: float, *, n_az: int = DEF_N_AZ, dist_km: float = DEF_DIST_KM,
                 samples: int = DEF_SAMPLES, eye_h: float = DEF_EYE_H,
                 inner_radius_m: float = 0.0) -> dict:
    """Scan d'horizon 360° d'un spot. Renvoie z0, openness (0..100), mean/max_horizon_deg,
    pct_below_*, denivele_max_m, mns_available, near_blocked_pct, inner_radius_m,
    azimuths [{az, cardinal, horizon_deg, dist_km, blocker, near_*}].

    Mode DONUT (inner_radius_m > 0) : on observe depuis le centre mais on IGNORE toute
    obstruction proche située à moins de inner_radius (l'objet central — chapelle, antenne —
    est « rangé » dans le trou et ne bloque jamais, comme si on faisait le tour). Les alentours
    au-delà du trou gardent leur vraie distance au centre, donc les arbres périphériques ne
    sont pas artificiellement rapprochés.
    Lève HorizonError en cas d'échec réseau (à traiter en enrichissement non-fatal)."""
    inner_radius_m = max(0.0, min(300.0, float(inner_radius_m or 0.0)))
    z0 = point_elevation(lon, lat)
    z_eye = z0 + eye_h
    dist_m = dist_km * 1000.0
    azimuths = [360.0 * i / n_az for i in range(n_az)]
    mns = _fetch_mns(lon, lat)      # dalle d'obstruction proche (None si pas de couverture)

    # Mode DONUT : on observe depuis le centre mais on IGNORE tout obstacle plus proche que
    # inner_radius (l'objet central « rangé » dans le trou : chapelle, antenne…). Les alentours
    # gardent leur vraie distance au centre → on n'exagère pas les arbres périphériques.
    near_start = max(_NEAR_IGNORE, inner_radius_m)

    def one(az: float) -> dict:
        r = _ray(lon, lat, az, dist_m, samples)
        ter_ang, ter_dist = _horizon_angle(z_eye, r["d"], r["z"])          # relief lointain (m)
        near_ang, near_dist = (-90.0, 0.0)
        if mns is not None:
            near_ang, near_dist = _near_obstruction(lon, lat, az, z_eye, mns, start_m=near_start)
        if near_ang > ter_ang:
            hz, hd, blocker = near_ang, near_dist, "near"
        else:
            hz, hd, blocker = ter_ang, ter_dist, "far"
        return {"az": az, "hz": hz, "hd": hd, "blocker": blocker,
                "near_deg": near_ang, "near_dist": near_dist, "den": r["denivele_pos"]}

    with ThreadPoolExecutor(max_workers=_MAX_WORKERS) as ex:
        rows = sorted(ex.map(one, azimuths), key=lambda x: x["az"])

    angles = [r["hz"] for r in rows]
    denivele_max = max((r["den"] for r in rows), default=0.0)
    mean_ang = sum(angles) / len(angles)
    openness = max(0.0, min(100.0, 100.0 - 4.0 * mean_ang))
    near_blocked = sum(1 for r in rows if r["blocker"] == "near" and r["hz"] > 5.0)
    return {
        "lon": lon, "lat": lat, "z0": round(z0, 1),
        "openness": round(openness, 1),
        "mean_horizon_deg": round(mean_ang, 2),
        "max_horizon_deg": round(max(angles), 2),
        "pct_below_5deg": round(100.0 * sum(1 for a in angles if a < 5.0) / len(angles)),
        "pct_below_2deg": round(100.0 * sum(1 for a in angles if a < 2.0) / len(angles)),
        "denivele_max_m": round(denivele_max),
        "mns_available": mns is not None,
        "near_blocked_pct": round(100.0 * near_blocked / len(rows)),
        "inner_radius_m": round(inner_radius_m),
        "azimuths": [{"az": round(r["az"], 1), "cardinal": cardinal(r["az"]),
                      "horizon_deg": round(r["hz"], 2), "dist_km": round(r["hd"] / 1000.0, 3),
                      "blocker": r["blocker"],
                      "near_deg": (round(r["near_deg"], 2) if r["near_deg"] > -90 else None),
                      "near_dist_m": (round(r["near_dist"]) if r["near_deg"] > -90 else None)}
                     for r in rows],
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


def _cache_key(lon: float, lat: float, inner_radius_m: float = 0.0) -> str:
    # ~11 m de résolution (5 décimales) : deux spots à <11 m partagent leur horizon (OK).
    # Le rayon de donut fait partie de la clé (même point, donut différent = scan différent).
    base = f"{lat:.5f}_{lon:.5f}"
    return f"{base}_r{round(float(inner_radius_m or 0))}" if inner_radius_m else base


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
    path = _cache_dir() / f"{_cache_key(lon, lat, kw.get('inner_radius_m', 0))}.json"
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


def clear_cached(lon: float, lat: float) -> bool:
    """Supprime les entrées de cache d'un point (base + variantes donut _r*) → force un
    recalcul complet au prochain scan (ex. après ajout de l'obstruction proche / du donut)."""
    try:
        base = _cache_key(lon, lat)                       # "lat_lon"
        for p in _cache_dir().glob(base + "*.json"):      # base + "…_r15.json"
            p.unlink(missing_ok=True)
        return True
    except Exception:
        return False


# --- self-test standalone ----------------------------------------------------
if __name__ == "__main__":
    # Cas couvrant les 3 régimes : dégagé+MNS, bloqué par obstruction proche, terrain
    # seul (hors couverture MNS → repli). Validés à la main (S0 relief + S0 MNS).
    SPOTS = {
        "ZI les Rochers (dégagé, MNS)":     (1.354299, 46.906442, "ouvert"),   # champ + éoliennes
        "Table Messimy (arbres proches)":   (4.654292, 45.709948, "bloqué"),   # cerné d'arbres <20 m
        "Beauce (hors couverture MNS)":     (1.5000, 48.3000, "plat"),         # terrain seul
    }
    ok = True
    for name, (lon, lat, attendu) in SPOTS.items():
        t0 = time.time()
        s = horizon_scan(lon, lat)
        dt = time.time() - t0
        print(f"\n=== {name} — attendu: {attendu} ===")
        print(f"  z0={s['z0']} m  ouverture={s['openness']}/100  MNS={s['mns_available']}  "
              f"proche_bloqué={s['near_blocked_pct']}%  horizon moy={s['mean_horizon_deg']:+.2f}°  ({dt:.1f}s)")
        if attendu == "ouvert" and s["openness"] < 80:
            print("  ✗ ATTENDU ouvert mais ouverture basse"); ok = False
        if attendu == "bloqué" and s["openness"] > 40:
            print("  ✗ ATTENDU bloqué (arbres proches) mais ouverture haute"); ok = False
        if attendu == "plat" and (s["openness"] < 95 or s["mns_available"]):
            print("  ✗ ATTENDU plat sans couverture MNS"); ok = False
    print("\n" + ("✓ self-test OK" if ok else "✗ self-test ÉCHOUÉ"))
