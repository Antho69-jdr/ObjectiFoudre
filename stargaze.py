"""Mode « chasse d'étoile » — conditions d'observation astronomique.

Trouver le meilleur spot : le plus OBSCUR (faible pollution lumineuse), le CIEL le plus
DÉGAGÉ (couverture nuageuse AROME, câblée côté app.py), à la bonne heure de NUIT (astro).

Ce module = les 3 briques VALIDÉES hors ligne (cf. .h_collect/astro_prototype) :
- pollution lumineuse : loi de Walker (P·d^-2.5) sur les communes ≥1000 hab (statique →
  précalcul par cellule de grille, cache disque).
- astro : phase de Lune, altitude solaire, nuit astronomique (−18°). Calcul pur.
- score d'observation : combine obscurité × ciel dégagé × qualité de nuit.
"""
from __future__ import annotations
import json
import math
from datetime import datetime, timezone, timedelta
from pathlib import Path

# ── Pollution lumineuse (loi de Walker) ──────────────────────────────────────
_SOURCES = None          # np.ndarray (N,3) : lon, lat, pop
_SRC_LIST = None         # fallback pur-python
_D0 = 1.5                # km : atténuation au centre-ville (évite la singularité)
_EXP = 2.5               # exposant de Walker
# calibrage log10(b) → obscurité, mesuré sur les extrêmes RÉELS France (validation) :
#   Paris centre ≈ 5.66 → obscurité ~0 ; spot le plus sombre ≈ 1.8 → ~100.
_LOGB_BRIGHT = 5.7
_LOGB_DARK = 1.8


def _sources_path() -> Path:
    return Path(__file__).with_name("data") / "light_sources_fr.json"


def _load_sources():
    global _SOURCES, _SRC_LIST
    if _SRC_LIST is None:
        _SRC_LIST = json.load(open(_sources_path()))
        try:
            import numpy as np
            _SOURCES = np.asarray(_SRC_LIST, dtype=np.float64)
        except Exception:
            _SOURCES = None
    return _SRC_LIST


def _logb_to_darkness(logb: float) -> int:
    t = (logb - _LOGB_DARK) / (_LOGB_BRIGHT - _LOGB_DARK)
    return int(round(max(0.0, min(100.0, 100.0 * (1.0 - t)))))


def darkness_at(lon: float, lat: float) -> int:
    """Score d'obscurité 0..100 (100 = ciel le plus noir) en un point. Pur-python."""
    src = _load_sources()
    coslat = math.cos(math.radians(lat))
    b = 0.0
    for slon, slat, pop in src:
        dx = (slon - lon) * 111.0 * coslat
        dy = (slat - lat) * 111.0
        b += pop * (math.sqrt(dx * dx + dy * dy) + _D0) ** (-_EXP)
    return _logb_to_darkness(math.log10(max(b, 1e-6)))


def darkness_grid(cells: list[tuple[float, float]]) -> list[int]:
    """Obscurité pour une liste de (lon, lat) — numpy vectorisé (précalcul grille)."""
    _load_sources()
    try:
        import numpy as np
    except Exception:
        return [darkness_at(lon, lat) for lon, lat in cells]
    S = _SOURCES
    slon = S[:, 0]; slat = S[:, 1]; pop = S[:, 2]
    out = []
    for lon, lat in cells:
        coslat = math.cos(math.radians(lat))
        dx = (slon - lon) * 111.0 * coslat
        dy = (slat - lat) * 111.0
        d = np.sqrt(dx * dx + dy * dy)
        b = float((pop * (d + _D0) ** (-_EXP)).sum())
        out.append(_logb_to_darkness(math.log10(max(b, 1e-6))))
    return out


# ── Astronomie (phase de Lune, nuit astronomique) ────────────────────────────
_SYNODIC = 29.530588853
_NEW_MOON_REF = datetime(2000, 1, 6, 18, 14, tzinfo=timezone.utc)
_PHASE_NAMES = ["Nouvelle lune", "Premier croissant", "Premier quartier", "Gibbeuse croissante",
                "Pleine lune", "Gibbeuse décroissante", "Dernier quartier", "Dernier croissant"]


def moon_phase(dt: datetime) -> dict:
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    age = ((dt - _NEW_MOON_REF).total_seconds() / 86400.0) % _SYNODIC
    frac = (1 - math.cos(2 * math.pi * age / _SYNODIC)) / 2
    idx = int((age / _SYNODIC) * 8 + 0.5) % 8
    return {"age_days": round(age, 2), "illumination": round(frac, 3),
            "phase_name": _PHASE_NAMES[idx], "darkness": round(1.0 - frac, 3)}


def _sun_alt_deg(dt: datetime, lat: float, lon: float) -> float:
    doy = dt.timetuple().tm_yday
    fh = dt.hour + dt.minute / 60.0 + dt.second / 3600.0
    g = 2 * math.pi / 365.0 * (doy - 1 + (fh - 12) / 24.0)
    decl = (0.006918 - 0.399912 * math.cos(g) + 0.070257 * math.sin(g)
            - 0.006758 * math.cos(2 * g) + 0.000907 * math.sin(2 * g)
            - 0.002697 * math.cos(3 * g) + 0.00148 * math.sin(3 * g))
    eq = 229.18 * (0.000075 + 0.001868 * math.cos(g) - 0.032077 * math.sin(g)
                   - 0.014615 * math.cos(2 * g) - 0.040849 * math.sin(2 * g))
    tst = (fh * 60 + eq + 4 * lon) % 1440
    ha = math.radians(tst / 4.0 - 180.0)
    latr = math.radians(lat)
    s = math.sin(latr) * math.sin(decl) + math.cos(latr) * math.cos(decl) * math.cos(ha)
    return math.degrees(math.asin(max(-1.0, min(1.0, s))))


def astronomical_night(date_utc: datetime, lat: float, lon: float) -> dict:
    """Fenêtre de nuit astronomique (soleil < −18°) pour la nuit commençant ce jour."""
    base = date_utc.replace(hour=12, minute=0, second=0, microsecond=0, tzinfo=timezone.utc)
    start = end = None
    prev = None
    for i in range(0, 24 * 12 + 1):
        t = base + timedelta(minutes=5 * i)
        dark = _sun_alt_deg(t, lat, lon) < -18.0
        if prev is not None:
            if dark and not prev and start is None:
                start = t
            if not dark and prev and start is not None and end is None:
                end = t
        prev = dark
    dur = round((end - start).total_seconds() / 3600.0, 2) if (start and end) else 0.0
    return {"night_start_utc": start.strftime("%Y-%m-%dT%H:%MZ") if start else None,
            "night_end_utc": end.strftime("%Y-%m-%dT%H:%MZ") if end else None,
            "duration_h": dur}


# ── Agenda : lever/coucher du Soleil et de la Lune (item Trello « Agenda ») ──
# Position lunaire : méthode de Schlyter (éléments orbitaux + 12 perturbations en
# longitude, 5 en latitude — précision ~2 arcmin, largement sous la minute au
# lever/coucher). Validée contre l'éphéméride met.no (voir .h_collect).
_J2000 = datetime(1999, 12, 31, 0, 0, tzinfo=timezone.utc)   # epoch « d=0 » de Schlyter


def _moon_radec(dt: datetime) -> tuple[float, float, float]:
    """(RA°, Dec°, distance en rayons terrestres) géocentriques de la Lune."""
    d = (dt - _J2000).total_seconds() / 86400.0
    rad, deg = math.radians, math.degrees
    # éléments moyens (degrés)
    N = 125.1228 - 0.0529538083 * d          # long. du nœud ascendant
    i = 5.1454                                # inclinaison
    w = 318.0634 + 0.1643573223 * d           # argument du périgée
    a = 60.2666                               # demi-grand axe (rayons terrestres)
    e = 0.054900
    M = rad((115.3654 + 13.0649929509 * d) % 360.0)
    # Kepler (excentricité faible → 4 itérations suffisent)
    E = M + e * math.sin(M) * (1.0 + e * math.cos(M))
    for _ in range(4):
        E = E - (E - e * math.sin(E) - M) / (1.0 - e * math.cos(E))
    xv = a * (math.cos(E) - e)
    yv = a * math.sqrt(1.0 - e * e) * math.sin(E)
    v = math.atan2(yv, xv)
    r = math.hypot(xv, yv)
    # → écliptique géocentrique
    Nr, ir = rad(N % 360.0), rad(i)
    u = v + rad(w % 360.0)
    xe = r * (math.cos(Nr) * math.cos(u) - math.sin(Nr) * math.sin(u) * math.cos(ir))
    ye = r * (math.sin(Nr) * math.cos(u) + math.cos(Nr) * math.sin(u) * math.cos(ir))
    ze = r * (math.sin(u) * math.sin(ir))
    lon = deg(math.atan2(ye, xe)) % 360.0
    lat = deg(math.atan2(ze, math.hypot(xe, ye)))
    # perturbations (Soleil : anomalie et longitude moyennes)
    Ms = (356.0470 + 0.9856002585 * d) % 360.0
    ws = (282.9404 + 0.0000470935 * d) % 360.0
    Ls = (Ms + ws) % 360.0
    Lm = (N + w + deg(M)) % 360.0
    D = rad(Lm - Ls)
    F = rad(Lm - N)
    Mr, Msr = M, rad(Ms)
    lon += (-1.274 * math.sin(Mr - 2 * D) + 0.658 * math.sin(2 * D)
            - 0.186 * math.sin(Msr) - 0.059 * math.sin(2 * Mr - 2 * D)
            - 0.057 * math.sin(Mr - 2 * D + Msr) + 0.053 * math.sin(Mr + 2 * D)
            + 0.046 * math.sin(2 * D - Msr) + 0.041 * math.sin(Mr - Msr)
            - 0.035 * math.sin(D) - 0.031 * math.sin(Mr + Msr)
            - 0.015 * math.sin(2 * F - 2 * D) + 0.011 * math.sin(Mr - 4 * D))
    lat += (-0.173 * math.sin(F - 2 * D) - 0.055 * math.sin(Mr - F - 2 * D)
            - 0.046 * math.sin(Mr + F - 2 * D) + 0.033 * math.sin(F + 2 * D)
            + 0.017 * math.sin(2 * Mr + F))
    r += -0.58 * math.cos(Mr - 2 * D) - 0.46 * math.cos(2 * D)
    # → équatorial
    eps = rad(23.4393 - 3.563e-7 * d)
    lonr, latr = rad(lon), rad(lat)
    xg = math.cos(lonr) * math.cos(latr)
    yg = math.sin(lonr) * math.cos(latr)
    zg = math.sin(latr)
    xeq = xg
    yeq = yg * math.cos(eps) - zg * math.sin(eps)
    zeq = yg * math.sin(eps) + zg * math.cos(eps)
    ra = deg(math.atan2(yeq, xeq)) % 360.0
    dec = deg(math.atan2(zeq, math.hypot(xeq, yeq)))
    return ra, dec, r


def _moon_alt_deg(dt: datetime, lat: float, lon: float) -> float:
    """Altitude GÉOCENTRIQUE de la Lune (°). Le critère de lever/coucher +0,125°
    absorbe parallaxe (−0,95°), réfraction (+0,58°) et demi-diamètre (+0,25°)."""
    ra, dec, _r = _moon_radec(dt)
    d = (dt - _J2000).total_seconds() / 86400.0
    Ms = (356.0470 + 0.9856002585 * d) % 360.0
    ws = (282.9404 + 0.0000470935 * d) % 360.0
    gmst0 = ((Ms + ws) + 180.0) % 360.0          # temps sidéral de Greenwich à 0h UT (°)
    ut_h = dt.hour + dt.minute / 60.0 + dt.second / 3600.0
    lst = (gmst0 + ut_h * 15.0 + lon) % 360.0
    ha = math.radians(lst - ra)
    latr, decr = math.radians(lat), math.radians(dec)
    s = (math.sin(latr) * math.sin(decr)
         + math.cos(latr) * math.cos(decr) * math.cos(ha))
    return math.degrees(math.asin(max(-1.0, min(1.0, s))))


_MOON_RISESET_ALT = 0.125    # cf. _moon_alt_deg
_SUN_RISESET_ALT = -0.833    # réfraction + demi-diamètre solaire


def _crossings(alt_fn, day_start_utc: datetime, target: float, step_min: int = 5) -> tuple[datetime | None, datetime | None]:
    """(lever, coucher) = franchissements de `target` par alt_fn sur 24 h, interpolés
    linéairement entre deux pas (précision < 1 min). None si aucun ce jour-là."""
    rise = set_ = None
    prev_t = day_start_utc
    prev_a = alt_fn(prev_t)
    n = (24 * 60) // step_min
    for k in range(1, n + 1):
        t = day_start_utc + timedelta(minutes=step_min * k)
        a = alt_fn(t)
        if prev_a < target <= a and rise is None:
            f = (target - prev_a) / (a - prev_a)
            rise = prev_t + timedelta(minutes=step_min * f)
        if prev_a >= target > a and set_ is None:
            f = (prev_a - target) / (prev_a - a)
            set_ = prev_t + timedelta(minutes=step_min * f)
        prev_t, prev_a = t, a
    return rise, set_


def day_events(day_start_utc: datetime, lat: float, lon: float) -> dict:
    """Lever/coucher du Soleil et de la Lune sur les 24 h commençant à
    `day_start_utc` (minuit LOCAL exprimé en UTC) + phase de Lune à midi.
    Certains jours n'ont pas de lever OU de coucher de Lune (décalage ~50 min/j)."""
    sr, ss = _crossings(lambda t: _sun_alt_deg(t, lat, lon), day_start_utc, _SUN_RISESET_ALT)
    mr, ms = _crossings(lambda t: _moon_alt_deg(t, lat, lon), day_start_utc, _MOON_RISESET_ALT)
    moon = moon_phase(day_start_utc + timedelta(hours=12))
    iso = lambda t: t.strftime("%Y-%m-%dT%H:%MZ") if t else None
    return {"sunrise_utc": iso(sr), "sunset_utc": iso(ss),
            "moonrise_utc": iso(mr), "moonset_utc": iso(ms),
            "moon_illumination": moon["illumination"], "moon_phase": moon["phase_name"]}


def observation_score(darkness: int, cloud_total_pct: float, moon_darkness: float) -> int:
    """Score d'observation 0..100 : obscurité du site × ciel dégagé × phase de Lune.
    darkness 0..100 (site) ; cloud_total_pct 0..100 (couverture, AROME) ; moon_darkness 0..1.
    Le ciel dégagé est éliminatoire ; la Lune module ; l'obscurité du site pondère."""
    clear = max(0.0, 1.0 - cloud_total_pct / 100.0)
    moon_factor = 0.55 + 0.45 * moon_darkness       # pleine lune 0,55 → nouvelle 1,0
    site = darkness / 100.0
    return int(round(max(0.0, min(100.0, 100.0 * clear * moon_factor * site))))
