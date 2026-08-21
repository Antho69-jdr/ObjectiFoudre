"""POC faisabilité item 4 — astres + Voie lactée en PUR PYTHON (méthode Schlyter,
même machinerie que la Lune de stargaze.py). Aucune dépendance, aucun réseau.
Calcule le ciel de CE SOIR au-dessus de Lyon + croise avec un champ de vision."""
import math
from datetime import datetime, timezone

rad, deg, sin, cos, atan2, asin, sqrt, hypot = (
    math.radians, math.degrees, math.sin, math.cos, math.atan2, math.asin, math.sqrt, math.hypot)

_J2000 = datetime(1999, 12, 31, 0, 0, tzinfo=timezone.utc)  # epoch d=0 de Schlyter


def _days(dt): return (dt - _J2000).total_seconds() / 86400.0


def _lst_deg(dt, lon):
    """Temps sidéral local (°) — shortcut Schlyter identique à stargaze._moon_alt_deg."""
    d = _days(dt)
    Ms = (356.0470 + 0.9856002585 * d) % 360.0
    ws = (282.9404 + 0.0000470935 * d) % 360.0
    gmst0 = ((Ms + ws) + 180.0) % 360.0
    ut_h = dt.hour + dt.minute / 60.0 + dt.second / 3600.0
    return (gmst0 + ut_h * 15.0 + lon) % 360.0


def altaz(ra, dec, dt, lat, lon):
    """(alt°, az°) d'un objet de RA/Dec fixes. az mesuré depuis le Nord, sens horaire."""
    ha = rad(_lst_deg(dt, lon) - ra)
    latr, decr = rad(lat), rad(dec)
    alt = asin(max(-1, min(1, sin(latr) * sin(decr) + cos(latr) * cos(decr) * cos(ha))))
    az = atan2(-cos(decr) * sin(ha), sin(decr) * cos(latr) - cos(decr) * sin(latr) * cos(ha))
    return deg(alt), deg(az) % 360.0


# ── Planètes (éléments Schlyter, d = jours depuis 1999-12-31) ────────────────
_PLANETS = {
    "Mercure": dict(N=(48.3313, 3.24587e-5), i=(7.0047, 5.00e-8), w=(29.1241, 1.01444e-5),
                    a=(0.387098, 0), e=(0.205635, 5.59e-10), M=(168.6562, 4.0923344368)),
    "Vénus":   dict(N=(76.6799, 2.46590e-5), i=(3.3946, 2.75e-8), w=(54.8910, 1.38374e-5),
                    a=(0.723330, 0), e=(0.006773, -1.302e-9), M=(48.0052, 1.6021302244)),
    "Mars":    dict(N=(49.5574, 2.11081e-5), i=(1.8497, -1.78e-8), w=(286.5016, 2.92961e-5),
                    a=(1.523688, 0), e=(0.093405, 2.516e-9), M=(18.6021, 0.5240207766)),
    "Jupiter": dict(N=(100.4542, 2.76854e-5), i=(1.3030, -1.557e-7), w=(273.8777, 1.64505e-5),
                    a=(5.20256, 0), e=(0.048498, 4.469e-9), M=(19.8950, 0.0830853001)),
    "Saturne": dict(N=(113.6634, 2.38980e-5), i=(2.4886, -1.081e-7), w=(339.3939, 2.97661e-5),
                    a=(9.55475, 0), e=(0.055546, -9.499e-9), M=(316.9670, 0.0334442282)),
}


def _kepler(M, e):
    M = rad(M % 360.0)
    E = M + e * sin(M) * (1 + e * cos(M))
    for _ in range(6):
        E = E - (E - e * sin(E) - M) / (1 - e * cos(E))
    return E


def _sun_ecl(d):
    ws = 282.9404 + 4.70935e-5 * d
    e = 0.016709 - 1.151e-9 * d
    M = 356.0470 + 0.9856002585 * d
    E = _kepler(M, e)
    xv, yv = cos(E) - e, sqrt(1 - e * e) * sin(E)
    v, r = deg(atan2(yv, xv)), hypot(xv, yv)
    lon = (v + ws) % 360.0
    return r * cos(rad(lon)), r * sin(rad(lon))   # xs, ys (ecliptique, zs=0)


def planet_radec(name, dt):
    p, d = _PLANETS[name], _days(dt)
    val = lambda k: p[k][0] + p[k][1] * d
    N, i, w, a, e = val("N"), val("i"), val("w"), val("a"), val("e")
    E = _kepler(val("M"), e)
    xv, yv = a * (cos(E) - e), a * sqrt(1 - e * e) * sin(E)
    v, r = atan2(yv, xv), hypot(xv, yv)
    u = v + rad(w)
    Nr, ir = rad(N), rad(i)
    xh = r * (cos(Nr) * cos(u) - sin(Nr) * sin(u) * cos(ir))
    yh = r * (sin(Nr) * cos(u) + cos(Nr) * sin(u) * cos(ir))
    zh = r * (sin(u) * sin(ir))
    xs, ys = _sun_ecl(d)
    xg, yg, zg = xh + xs, yh + ys, zh
    eps = rad(23.4393 - 3.563e-7 * d)
    xe = xg
    ye = yg * cos(eps) - zg * sin(eps)
    ze = yg * sin(eps) + zg * cos(eps)
    return deg(atan2(ye, xe)) % 360.0, deg(atan2(ze, hypot(xe, ye)))


# ── Étoiles brillantes (RA/Dec J2000, mag) ──────────────────────────────────
STARS = [
    ("Véga (Lyre)", 279.234, 38.784, 0.03),
    ("Deneb (Cygne)", 310.358, 45.280, 1.25),
    ("Altaïr (Aigle)", 297.696, 8.868, 0.76),
    ("Arcturus (Bouvier)", 213.915, 19.182, -0.05),
    ("Antarès (Scorpion)", 247.352, -26.432, 1.06),
    ("Capella (Cocher)", 79.172, 45.998, 0.08),
    ("Polaris (Pt Ourse)", 37.954, 89.264, 1.98),
    ("α Centauri", 219.902, -60.834, -0.27),   # jamais levée depuis la France
]

# ── Voie lactée : plan galactique b=0, échantillonné en longitude galactique ──
_NGP_RA, _NGP_DEC, _L_NCP = 192.85948, 27.12825, 122.93192


def galactic_to_radec(l, b):
    lr, br = rad(l), rad(b)
    dgp, lncp = rad(_NGP_DEC), rad(_L_NCP)
    dec = asin(sin(dgp) * sin(br) + cos(dgp) * cos(br) * cos(lncp - lr))
    ra = rad(_NGP_RA) + atan2(cos(br) * sin(lncp - lr),
                              cos(dgp) * sin(br) - sin(dgp) * cos(br) * cos(lncp - lr))
    return deg(ra) % 360.0, deg(dec)


def cardinal(az):
    return ["N", "NE", "E", "SE", "S", "SO", "O", "NO"][int((az + 22.5) % 360 // 45)]


def never_rises(dec, lat):
    return dec < (lat - 90.0)   # culmine sous l'horizon


if __name__ == "__main__":
    lat, lon = 45.76, 4.83                       # Lyon
    dt = datetime(2026, 8, 21, 21, 0, tzinfo=timezone.utc)   # 23:00 locale (UTC+2)
    # champ de vision d'exemple : dégagé partout SAUF une crête au Sud (12°)
    def horizon_at(az):
        return 12.0 if 135 <= az <= 225 else 2.0

    print(f"Ciel au-dessus de Lyon ({lat},{lon}) — {dt:%d/%m %H:%M} UTC (23h locale)\n")
    print(f"{'objet':22} {'alt°':>6} {'az°':>6} {'card':>4}  {'>horizon?':>10}  visible")
    print("-" * 74)

    def line(name, ra, dec, tag=""):
        if never_rises(dec, lat):
            print(f"{name:22} {'—':>6} {'—':>6} {'—':>4}  {'JAMAIS':>10}  ✗ hors de portée (lat)")
            return
        alt, az = altaz(ra, dec, dt, lat, lon)
        up = alt > 0
        clear = up and alt > horizon_at(az)
        vis = "✓ visible" if clear else ("△ sous obstruction" if up else "✗ sous l'horizon")
        print(f"{name:22} {alt:6.1f} {az:6.1f} {cardinal(az):>4}  {('%.0f' % horizon_at(az)):>9}°  {vis} {tag}")

    print("ÉTOILES BRILLANTES / CONSTELLATIONS")
    for n, ra, dec, mag in STARS:
        line(n, ra, dec, f"(mag {mag})")

    print("\nPLANÈTES")
    for n in _PLANETS:
        ra, dec = planet_radec(n, dt)
        line(n, ra, dec)

    print("\nVOIE LACTÉE (plan galactique b=0, par longitude galactique)")
    seg = []
    for l in range(0, 360, 30):
        ra, dec = galactic_to_radec(l, 0)
        if never_rises(dec, lat):
            continue
        alt, az = altaz(ra, dec, dt, lat, lon)
        if alt > 0:
            seg.append((l, alt, az))
    if seg:
        lo = min(seg, key=lambda s: s[1]); hi = max(seg, key=lambda s: s[1])
        print(f"  bande au-dessus de l'horizon : {len(seg)}/12 segments")
        print(f"  point le plus BAS  : l={lo[0]:3}° alt={lo[1]:5.1f}° az={lo[2]:5.1f}° ({cardinal(lo[2])})")
        print(f"  point le plus HAUT : l={hi[0]:3}° alt={hi[1]:5.1f}° az={hi[2]:5.1f}° ({cardinal(hi[2])})")
        # centre galactique = partie la plus spectaculaire (l≈0, Sagittaire)
        gc_ra, gc_dec = galactic_to_radec(0, 0)
        gc_alt, gc_az = altaz(gc_ra, gc_dec, dt, lat, lon)
        clear = gc_alt > horizon_at(gc_az)
        print(f"  CENTRE galactique (Sagittaire) : alt={gc_alt:.1f}° az={gc_az:.1f}° ({cardinal(gc_az)}) "
              f"→ {'✓ dégagé' if clear else '△ sous la crête Sud (12°)'}")
