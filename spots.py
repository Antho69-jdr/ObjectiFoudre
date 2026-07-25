"""« Mes spots » — store de spots de chasse partagés, JSON sur volume Railway.

Module isolé, pur stdlib, testable seul (n'importe RIEN de app.py). Persistance = un
fichier JSON unique, écritures atomiques sous verrou. Conçu **account-ready** : chaque spot
porte un `author {kind, id}` aujourd'hui anonyme (token client localStorage) qui deviendra un
compte, et un `status` de modération (pending/approved/rejected).

Modération = double filtre (décidé avec Anthony) :
  - AUTOMATIQUE, à la création : coordonnées en France, nom propre/non-spam, anti-doublon
    (~50 m), rate-limit par auteur → le spot naît `pending` (jamais public sans revue) et le
    spam évident est rejeté d'emblée.
  - MANUELLE, admin (secret serveur, côté app.py) : approuver / rejeter / supprimer.

Seuls les spots `approved` sont exposés au public (carte + tableau). L'horizon (module
`horizon.py`) est calculé/attaché séparément par app.py — ce store ne fait que le portage.
"""
from __future__ import annotations

import json
import math
import os
import re
import tempfile
import threading
import time
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

HERE = Path(__file__).resolve().parent

# France métropolitaine (mêmes bornes que wcs_client.FRANCE_BBOX)
_FR = (-5.5, 9.8, 41.0, 51.6)   # lon_min, lon_max, lat_min, lat_max
_NAME_MAX = 60
_NOTES_MAX = 280
_DUP_RADIUS_M = 50.0            # deux spots à <50 m = doublon
_RATE_MAX = 10                  # spots max par auteur…
_RATE_WINDOW_S = 3600.0         # …par heure glissante
_STATUSES = ("pending", "approved", "rejected")

# signaux de spam simples (liens/markup) + petit blocklist grossier
_SPAM_RE = re.compile(r"https?://|www\.|<[^>]+>|\[url|\bviagra\b|\bcasino\b|\bporn\b", re.I)
_CTRL_RE = re.compile(r"[\x00-\x1f\x7f]")

_lock = threading.RLock()


class SpotError(ValueError):
    """Refus de création (validation auto) ou action invalide — message utilisateur."""


def _now_iso() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def store_path() -> Path:
    """Fichier JSON des spots, sur le volume durable (pas le cache TTL)."""
    env = os.environ.get("OBJECTIFOUDRE_SPOTS_FILE")
    if env:
        return Path(env).expanduser()
    base = os.environ.get("OBJECTIFOUDRE_HISTORY_DIR") or (HERE / "history")
    return Path(base).expanduser() / "spots.json"


def _load() -> list[dict]:
    p = store_path()
    if not p.exists():
        return []
    try:
        data = json.loads(p.read_text())
        return data if isinstance(data, list) else []
    except Exception:
        return []   # fichier corrompu → on repart vide plutôt que crasher


def _save(spots: list[dict]) -> None:
    p = store_path()
    p.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile("w", dir=p.parent, suffix=".tmp", delete=False) as fh:
        json.dump(spots, fh, ensure_ascii=False)
        tmp = fh.name
    os.replace(tmp, p)   # atomique


def _haversine_m(lon1: float, lat1: float, lon2: float, lat2: float) -> float:
    r = 6371000.0
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dp = math.radians(lat2 - lat1)
    dl = math.radians(lon2 - lon1)
    a = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * r * math.asin(min(1.0, math.sqrt(a)))


# --- vue publique (champs sûrs seulement : pas de token auteur) --------------
def _public_view(s: dict) -> dict:
    return {
        "id": s["id"], "name": s["name"], "lon": s["lon"], "lat": s["lat"],
        "notes": s.get("notes", ""), "created_utc": s.get("created_utc"),
        "horizon": s.get("horizon"),
        "author_kind": (s.get("author") or {}).get("kind", "anon"),
    }


# --- validation automatique --------------------------------------------------
def _clean_text(v: Any, maxlen: int, label: str) -> str:
    t = _CTRL_RE.sub("", str(v or "")).strip()
    if _SPAM_RE.search(t):
        raise SpotError(f"{label} : contenu non autorisé (liens/spam).")
    if len(t) > maxlen:
        raise SpotError(f"{label} : trop long (max {maxlen}).")
    return t


def _validate_new(name: str, lon: float, lat: float, notes: str, existing: list[dict]) -> tuple[str, str]:
    try:
        lon = float(lon); lat = float(lat)
    except (TypeError, ValueError):
        raise SpotError("Coordonnées invalides.")
    if not (_FR[0] <= lon <= _FR[1] and _FR[2] <= lat <= _FR[3]):
        raise SpotError("Le spot doit être en France métropolitaine.")
    name = _clean_text(name, _NAME_MAX, "Nom")
    if len(name) < 2:
        raise SpotError("Nom : au moins 2 caractères.")
    notes = _clean_text(notes, _NOTES_MAX, "Description")
    for s in existing:
        if s.get("status") != "rejected" and _haversine_m(lon, lat, s["lon"], s["lat"]) < _DUP_RADIUS_M:
            raise SpotError("Un spot existe déjà à moins de 50 m.")
    return name, notes


def _rate_limit(existing: list[dict], author_token: str) -> None:
    if not author_token:
        return
    cutoff = time.time() - _RATE_WINDOW_S
    n = 0
    for s in existing:
        if (s.get("author") or {}).get("id") != author_token:
            continue
        try:
            ts = datetime.strptime(s["created_utc"], "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=timezone.utc).timestamp()
        except Exception:
            continue
        if ts >= cutoff:
            n += 1
    if n >= _RATE_MAX:
        raise SpotError("Trop de spots créés récemment. Réessaie plus tard.")


# --- API publique du store ---------------------------------------------------
def create_spot(name: str, lon: float, lat: float, *, author_token: str = "",
                notes: str = "", auto_approve: bool = False) -> dict:
    """Crée un spot (statut `pending` par défaut). Lève SpotError si la validation auto
    refuse. `auto_approve` réservé aux tests/admin ; en prod un spot passe par la revue."""
    with _lock:
        spots = _load()
        _rate_limit(spots, author_token)
        cname, cnotes = _validate_new(name, lon, lat, notes, spots)
        spot = {
            "id": uuid.uuid4().hex[:12],
            "name": cname, "lon": round(float(lon), 6), "lat": round(float(lat), 6),
            "notes": cnotes,
            "status": "approved" if auto_approve else "pending",
            "author": {"kind": "anon", "id": author_token or ""},  # → {kind:account,id} plus tard
            "created_utc": _now_iso(), "moderated_utc": None,
            "horizon": None,   # attaché par app.py via horizon.py
            "flags": [],
        }
        spots.append(spot)
        _save(spots)
        return spot


def import_spots(items: list[dict], *, status: str = "approved", author_token: str = "import") -> dict:
    """Import en masse (admin) : bypass le rate-limit, collapse/tronque les notes, dédoublonne
    (bbox + <50 m via _validate_new). items = [{name, lon, lat, notes|note}]. Renvoie
    {created:[spot…], skipped:[{name, reason}]}. status ∈ {approved, pending}."""
    if status not in ("approved", "pending"):
        raise SpotError(f"statut invalide : {status}")
    created, skipped = [], []
    with _lock:
        spots = _load()
        for it in items or []:
            try:
                name = it.get("name")
                lon = it.get("lon"); lat = it.get("lat")
                raw_note = str(it.get("notes") if it.get("notes") is not None else (it.get("note") or ""))
                note = re.sub(r"\s+", " ", raw_note).strip()[:_NOTES_MAX]   # une ligne, tronquée
                cname, cnote = _validate_new(name, lon, lat, note, spots)
                spot = {
                    "id": uuid.uuid4().hex[:12],
                    "name": cname, "lon": round(float(lon), 6), "lat": round(float(lat), 6),
                    "notes": cnote, "status": status,
                    "author": {"kind": "anon", "id": author_token},
                    "created_utc": _now_iso(),
                    "moderated_utc": _now_iso() if status == "approved" else None,
                    "horizon": None, "flags": [], "source": "import",
                }
                spots.append(spot)   # ajouté au fur et à mesure → dédoublonne dans le lot aussi
                created.append(spot)
            except SpotError as exc:
                skipped.append({"name": str(it.get("name"))[:60], "reason": str(exc)})
            except (TypeError, ValueError):
                skipped.append({"name": str(it.get("name"))[:60], "reason": "entrée invalide"})
        _save(spots)
    return {"created": created, "skipped": skipped}


def list_public() -> list[dict]:
    """Spots approuvés uniquement, vue publique (carte + tableau)."""
    with _lock:
        return [_public_view(s) for s in _load() if s.get("status") == "approved"]


def list_all(status: str | None = None) -> list[dict]:
    """Tous les spots (admin/modération). Filtrable par statut."""
    with _lock:
        return [s for s in _load() if status is None or s.get("status") == status]


def get(spot_id: str) -> dict | None:
    with _lock:
        return next((s for s in _load() if s["id"] == spot_id), None)


def moderate(spot_id: str, action: str) -> dict:
    """action ∈ {approve, reject, delete} (modération manuelle admin)."""
    if action not in ("approve", "reject", "delete"):
        raise SpotError(f"Action inconnue : {action}")
    with _lock:
        spots = _load()
        idx = next((i for i, s in enumerate(spots) if s["id"] == spot_id), None)
        if idx is None:
            raise SpotError("Spot introuvable.")
        if action == "delete":
            removed = spots.pop(idx)
            _save(spots)
            return {"deleted": removed["id"]}
        spots[idx]["status"] = "approved" if action == "approve" else "rejected"
        spots[idx]["moderated_utc"] = _now_iso()
        _save(spots)
        return spots[idx]


def attach_horizon(spot_id: str, horizon_summary: dict) -> dict | None:
    """Mémorise le résumé d'horizon calculé (openness, denivele…) sur le spot."""
    with _lock:
        spots = _load()
        idx = next((i for i, s in enumerate(spots) if s["id"] == spot_id), None)
        if idx is None:
            return None
        spots[idx]["horizon"] = horizon_summary
        _save(spots)
        return spots[idx]


# --- self-test standalone ----------------------------------------------------
if __name__ == "__main__":
    import shutil
    tmp = Path(tempfile.mkdtemp())
    os.environ["OBJECTIFOUDRE_SPOTS_FILE"] = str(tmp / "spots.json")
    ok = True

    def check(label, cond):
        global ok
        print(("  ✓ " if cond else "  ✗ ") + label); ok = ok and cond

    print("=== création + validation auto ===")
    s = create_spot("Belvédère test", 2.9646, 45.7723, author_token="tok1", notes="vue dégagée")
    check("spot créé en 'pending'", s["status"] == "pending")
    check("id présent", bool(s["id"]))
    check("non exposé si pending (list_public vide)", list_public() == [])

    try:
        create_spot("X", 20.0, 45.0)  # hors France
        check("hors-France rejeté", False)
    except SpotError:
        check("hors-France rejeté", True)
    try:
        create_spot("Voir https://spam.example", 3.0, 46.0)
        check("spam/lien rejeté", False)
    except SpotError:
        check("spam/lien rejeté", True)
    try:
        create_spot("Doublon", 2.96461, 45.77231)  # ~1 m du 1er
        check("doublon <50m rejeté", False)
    except SpotError:
        check("doublon <50m rejeté", True)

    print("=== modération manuelle ===")
    moderate(s["id"], "approve")
    pub = list_public()
    check("approuvé → visible public", len(pub) == 1 and pub[0]["id"] == s["id"])
    check("token auteur non exposé", "author" not in pub[0] and "token" not in pub[0])
    attach_horizon(s["id"], {"openness": 100.0, "denivele_max_m": 1762})
    check("horizon attaché", (get(s["id"])["horizon"] or {}).get("openness") == 100.0)
    moderate(s["id"], "reject")
    check("rejeté → retiré du public", list_public() == [])

    print("=== rate-limit ===")
    try:
        for i in range(_RATE_MAX + 2):
            create_spot(f"Spot {i}", 1.0 + i * 0.01, 47.0 + i * 0.01, author_token="flood")
        check("rate-limit déclenché", False)
    except SpotError:
        check("rate-limit déclenché", True)

    shutil.rmtree(tmp, ignore_errors=True)
    print("\n" + ("✓ self-test OK" if ok else "✗ self-test ÉCHOUÉ"))
