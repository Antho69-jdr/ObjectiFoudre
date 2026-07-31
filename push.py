"""Notifications Web Push (Phase 4 — alertes orage par département).

Deux responsabilités, indépendantes du reste :
  1. Géométrie des départements (data/departements_fr.geojson) → `department_at(lon, lat)`
     et `list_departments()`, pour la sélection côté UI et le croisement cellule↔département
     du job d'alerte. Point-in-polygon pur Python (préfiltre bbox + ray casting, trous gérés).
  2. Envoi Web Push chiffré + signature VAPID via `pywebpush` (importé PARESSEUSEMENT).
     Dégradation gracieuse façon mailer.py : le module s'importe même sans la dépendance ni
     les clés ; `send_web_push` renvoie alors ('fail', 'vapid_not_configured'/'pywebpush_absent').

Le STOCKAGE des abonnements vit dans accounts.py (base comptes, cascade RGPD). Ici : pas d'état
persistant, juste de la géométrie en cache RAM et de l'envoi.
"""
from __future__ import annotations

import json
import os
from pathlib import Path
from typing import Any

HERE = Path(__file__).resolve().parent
_GEOJSON_PATH = HERE / "data" / "departements_fr.geojson"

# ── Géométrie des départements ───────────────────────────────────────────────
# Chargé une fois, gardé en RAM : liste de (code, nom, bbox, [polygones]) où chaque
# polygone est une liste d'anneaux [ [ (lon,lat), … ], … ] (extérieur puis trous).
_DEPTS: list[dict[str, Any]] | None = None


def _polys_of(geom: dict[str, Any]) -> list[list[list[tuple[float, float]]]]:
    """Normalise Polygon/MultiPolygon en liste de polygones (chacun = liste d'anneaux)."""
    t = geom.get("type")
    coords = geom.get("coordinates") or []
    if t == "Polygon":
        return [[[(pt[0], pt[1]) for pt in ring] for ring in coords]]
    if t == "MultiPolygon":
        return [[[(pt[0], pt[1]) for pt in ring] for ring in poly] for poly in coords]
    return []


def _load_departments() -> list[dict[str, Any]]:
    global _DEPTS
    if _DEPTS is not None:
        return _DEPTS
    out: list[dict[str, Any]] = []
    try:
        data = json.loads(_GEOJSON_PATH.read_text(encoding="utf-8"))
    except Exception:
        _DEPTS = []
        return _DEPTS
    for feat in data.get("features", []):
        props = feat.get("properties") or {}
        code = str(props.get("code") or "").strip().upper()
        if not code:
            continue
        polys = _polys_of(feat.get("geometry") or {})
        minx = miny = float("inf")
        maxx = maxy = float("-inf")
        for poly in polys:
            for ring in poly:
                for x, y in ring:
                    if x < minx: minx = x
                    if x > maxx: maxx = x
                    if y < miny: miny = y
                    if y > maxy: maxy = y
        out.append({"code": code, "nom": props.get("nom") or code,
                    "bbox": (minx, miny, maxx, maxy), "polys": polys})
    out.sort(key=lambda d: d["code"])
    _DEPTS = out
    return _DEPTS


def _point_in_polygon(x: float, y: float, poly: list[list[tuple[float, float]]]) -> bool:
    """Ray casting even-odd sur TOUS les anneaux (extérieur + trous) : un point dans un trou
    croise un nombre pair de segments → considéré dehors. `poly` = [anneau_ext, trou1, …]."""
    inside = False
    for ring in poly:
        n = len(ring)
        j = n - 1
        for i in range(n):
            xi, yi = ring[i]
            xj, yj = ring[j]
            if ((yi > y) != (yj > y)) and (x < (xj - xi) * (y - yi) / (yj - yi) + xi):
                inside = not inside
            j = i
    return inside


def department_at(lon: float, lat: float) -> str | None:
    """Code du département métropolitain contenant le point (lon/lat WGS84), ou None (mer/hors métropole)."""
    try:
        x = float(lon); y = float(lat)
    except (TypeError, ValueError):
        return None
    for dep in _load_departments():
        minx, miny, maxx, maxy = dep["bbox"]
        if x < minx or x > maxx or y < miny or y > maxy:
            continue
        for poly in dep["polys"]:
            if _point_in_polygon(x, y, poly):
                return dep["code"]
    return None


def list_departments() -> list[dict[str, str]]:
    """Liste [{code, nom}] triée, pour l'écran de sélection côté client (payload léger)."""
    return [{"code": d["code"], "nom": d["nom"]} for d in _load_departments()]


def valid_department_codes() -> set[str]:
    return {d["code"] for d in _load_departments()}


def department_name(code: str) -> str | None:
    """Nom du département depuis son code (ex. '69' → 'Rhône'), ou None si inconnu."""
    code = str(code or "").strip().upper()
    for d in _load_departments():
        if d["code"] == code:
            return d["nom"]
    return None


# ── Configuration VAPID ──────────────────────────────────────────────────────
def _vapid_public() -> str:
    return (os.environ.get("OBJECTIFOUDRE_VAPID_PUBLIC_KEY") or "").strip()


def _vapid_private() -> str:
    return (os.environ.get("OBJECTIFOUDRE_VAPID_PRIVATE_KEY") or "").strip()


def _vapid_subject() -> str:
    return (os.environ.get("OBJECTIFOUDRE_VAPID_SUBJECT") or "mailto:objectifoudre@outlook.com").strip()


def vapid_public_key() -> str:
    """Clé publique VAPID (base64url) exposée au client comme applicationServerKey."""
    return _vapid_public()


def push_configured() -> bool:
    """True si l'envoi push est possible (clés VAPID présentes). N'importe pas pywebpush."""
    return bool(_vapid_public() and _vapid_private())


# ── Envoi Web Push ───────────────────────────────────────────────────────────
_vapid_obj = None  # instance py-vapid mise en cache (construite depuis la clé brute)


def _build_vapid():
    """Construit une instance py-vapid depuis la clé privée brute base64url (32 octets)
    via `Vapid01.from_raw` (la clé publique est dérivée automatiquement). Lève si lib/clé manquent."""
    global _vapid_obj
    if _vapid_obj is not None:
        return _vapid_obj
    from py_vapid import Vapid01
    raw = _vapid_private()
    _vapid_obj = Vapid01.from_raw(raw.encode("utf-8") if isinstance(raw, str) else raw)
    return _vapid_obj


def send_web_push(subscription: dict[str, Any], payload: dict[str, Any], ttl: int = 1800) -> tuple[str, str]:
    """Envoie une notification Web Push chiffrée (aes128gcm) signée VAPID.
    Renvoie ('ok', '') | ('gone', code) si l'endpoint est mort (404/410, à purger)
    | ('fail', detail) sinon. N'élève jamais : l'appelant (job) reste robuste."""
    if not push_configured():
        return ("fail", "vapid_not_configured")
    try:
        from pywebpush import webpush, WebPushException
    except Exception as exc:  # dépendance pas encore installée/déployée
        return ("fail", f"pywebpush_absent:{exc}")
    sub_info = {
        "endpoint": subscription["endpoint"],
        "keys": {"p256dh": subscription["p256dh"], "auth": subscription["auth"]},
    }
    try:
        vapid = _build_vapid()
        webpush(
            subscription_info=sub_info,
            data=json.dumps(payload, ensure_ascii=False),
            vapid_private_key=vapid,
            vapid_claims={"sub": _vapid_subject()},
            ttl=ttl,
        )
        return ("ok", "")
    except WebPushException as exc:
        code = getattr(getattr(exc, "response", None), "status_code", None)
        if code in (404, 410):
            return ("gone", str(code))
        return ("fail", f"{code}:{exc}")
    except Exception as exc:
        return ("fail", str(exc))


# ── Self-test géométrie ──────────────────────────────────────────────────────
if __name__ == "__main__":
    cases = [
        ("Lyon", 4.8357, 45.7640, "69"),
        ("Paris", 2.3522, 48.8566, "75"),
        ("Marseille", 5.3698, 43.2965, "13"),
        # Corse-du-Sud : point intérieur (le littoral simplifié d'Ajaccio est trop grossier
        # pour un test au ras de l'eau — sans impact pour des cellules au-dessus des terres).
        ("Corse-du-Sud intérieur", 8.9000, 41.9000, "2A"),
        ("Bastia", 9.4509, 42.7028, "2B"),
        ("Brest", -4.4861, 48.3904, "29"),
        ("Strasbourg", 7.7521, 48.5734, "67"),
        ("pleine mer (Atlantique)", -8.0, 46.0, None),
    ]
    fails = 0
    for name, lon, lat, expected in cases:
        got = department_at(lon, lat)
        ok = got == expected
        fails += 0 if ok else 1
        print(("  ✓ " if ok else "  ✗ ") + f"{name}: {got} (attendu {expected})")
    print(f"\n{len(cases) - fails}/{len(cases)} OK")
    print("nb départements chargés:", len(list_departments()))
    raise SystemExit(1 if fails else 0)
