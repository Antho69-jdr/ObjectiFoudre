#!/usr/bin/env python3
"""POC isolé : client WCS GetCoverage Météo-France (GRIB + eccodes).

Valide le pipeline AVANT toute intégration au score :
  1. ARPEGE WCS  -> u/v isobare 500 hPa  -> cisaillement 0-6 km (|V500 - V10m|)
  2. AROME  WCS  -> CAPE_INS / CIN surface (absents des paquets GRIB)

Ne touche PAS app.py. Décodage via eccodes (déjà présent).
Clés lues dans les fichiers 'Clef API MODEL AROME.txt' / 'Clef API MODEL ARPEGE.txt'.
"""
import math
import sys
import tempfile
import urllib.parse
import urllib.request
from pathlib import Path

import eccodes

HERE = Path(__file__).resolve().parent
LYON = (45.7640, 4.8357)  # (lat, lon) point de contrôle

ARPEGE_BASE = "https://public-api.meteofrance.fr/public/arpege/1.0/wcs/MF-NWP-GLOBAL-ARPEGE-01-EUROPE-WCS"
AROME_BASE = "https://public-api.meteofrance.fr/public/arome/1.0/wcs/MF-NWP-HIGHRES-AROME-001-FRANCE-WCS"


def _key(name: str) -> str:
    return (HERE / name).read_text().strip()


def get_coverage(base: str, key: str, coverage_id: str, *, subsets: list[str]) -> bytes:
    params = {
        "service": "WCS",
        "version": "2.0.1",
        "coverageId": coverage_id,
        "format": "application/wmo-grib",
    }
    url = f"{base}/GetCoverage?" + urllib.parse.urlencode(params)
    for s in subsets:
        url += "&subset=" + urllib.parse.quote(s, safe="(),.:\"")
    req = urllib.request.Request(url, headers={"apikey": key, "Authorization": f"Bearer {key}"})
    with urllib.request.urlopen(req, timeout=90) as resp:
        return resp.read()


def sample_grib(raw: bytes, lat: float, lon: float) -> dict:
    """Décode le 1er message GRIB et renvoie la valeur au point le plus proche."""
    with tempfile.NamedTemporaryFile(suffix=".grib", delete=False) as fh:
        fh.write(raw)
        path = fh.name
    out = {}
    with open(path, "rb") as f:
        gid = eccodes.codes_grib_new_from_file(f)
        if gid is None:
            raise RuntimeError("pas de message GRIB décodable")
        try:
            out["shortName"] = eccodes.codes_get(gid, "shortName")
            out["level"] = eccodes.codes_get(gid, "level")
            out["typeOfLevel"] = eccodes.codes_get(gid, "typeOfLevel")
            out["Ni"] = eccodes.codes_get(gid, "Ni")
            out["Nj"] = eccodes.codes_get(gid, "Nj")
            nearest = eccodes.codes_grib_find_nearest(gid, lat, lon)[0]
            out["value"] = nearest.value
            out["grid_lat"] = nearest.lat
            out["grid_lon"] = nearest.lon
        finally:
            eccodes.codes_release(gid)
    Path(path).unlink(missing_ok=True)
    return out


def main() -> int:
    run = sys.argv[1] if len(sys.argv) > 1 else "2026-06-22T12.00.00Z"   # dans le CoverageId (points)
    valid = sys.argv[2] if len(sys.argv) > 2 else "2026-06-22T15:00:00Z"  # subset time (deux-points, SANS guillemets)
    bbox = ["long(3,7)", "lat(44,47)"]  # petite zone autour de Lyon
    lat, lon = LYON

    print(f"== POC WCS == run={run} valid={valid} point=Lyon{LYON}\n")

    # --- 1. ARPEGE isobare 500 hPa : u et v ---
    ak = _key("Clef API MODEL ARPEGE.txt")
    res = {}
    for comp, cov in (("u", "U_COMPONENT_OF_WIND__ISOBARIC_SURFACE"),
                      ("v", "V_COMPONENT_OF_WIND__ISOBARIC_SURFACE")):
        cid = f"{cov}___{run}"
        raw = get_coverage(ARPEGE_BASE, ak, cid, subsets=[f"time({valid})", "pressure(500)"] + bbox)
        s = sample_grib(raw, lat, lon)
        res[comp] = s["value"]
        print(f"ARPEGE {comp}@500hPa : {s['value']:+.2f} m/s  "
              f"({len(raw)} o, grille {s['Ni']}x{s['Nj']}, {s['typeOfLevel']} {s['level']}, "
              f"pt {s['grid_lat']:.3f},{s['grid_lon']:.3f})")
    spd500 = math.hypot(res["u"], res["v"])
    print(f"  -> vent 500 hPa = {spd500:.1f} m/s ({spd500*3.6:.0f} km/h)\n")

    # --- 2. AROME surface : CAPE_INS et CIN ---
    mk = _key("Clef API MODEL AROME.txt")
    for label, cov in (("CAPE_INS", "CAPE_INS__GROUND"), ("CIN", "CIN__GROUND")):
        cid = f"{cov}___{run}"
        try:
            raw = get_coverage(AROME_BASE, mk, cid, subsets=[f"time({valid})"] + bbox)
            s = sample_grib(raw, lat, lon)
            print(f"AROME {label} : {s['value']:.1f}  ({len(raw)} o, {s['shortName']}, {s['typeOfLevel']})")
        except Exception as e:  # noqa: BLE001
            print(f"AROME {label} : ECHEC -> {e}")

    print("\n== cisaillement 0-6 km (à brancher) = |V(500hPa) - V(10m)| ; V10m vient déjà du paquet SP ==")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
