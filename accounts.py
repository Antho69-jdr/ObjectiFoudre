"""accounts.py — Comptes utilisateurs (carte Trello « Système de compte »).

Couche données SQLite ISOLÉE (pattern spots.py) : base `accounts.db` sur le volume
durable (OBJECTIFOUDRE_HISTORY_DIR). Auth déléguée (Google OAuth d'abord — aucun mot
de passe stocké ici) ; app.py gère le flux OAuth et pose une session.

Tables :
  users(id, created_utc, updated_utc, google_sub UNIQUE, email, email_verified,
        pseudo UNIQUE(NOCASE), prefs JSON)
  sessions(token_hash PK, user_id, created_utc, expires_utc, last_seen_utc)

Le jeton de session est stocké HASHÉ (sha256) : une fuite de la base n'expose pas les
sessions vives. Le cookie porte le jeton brut. Aucun secret d'auth ici.
"""
from __future__ import annotations

import hashlib
import json
import os
import re
import secrets
import sqlite3
import threading
import time
import uuid
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterator

HERE = Path(__file__).resolve().parent

_lock = threading.Lock()
_PSEUDO_RE = re.compile(r"^[A-Za-z0-9](?:[A-Za-z0-9 ._-]{1,22}[A-Za-z0-9])$")  # 3..24, bornes alphanum
_DEFAULT_MAPS = {"forecast", "chase", "stargaze"}
SESSION_DAYS = 60


class AccountError(ValueError):
    """Erreur de validation « métier » (renvoyée proprement au client)."""


def _now_iso() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def _db_path() -> Path:
    env = os.environ.get("OBJECTIFOUDRE_ACCOUNTS_FILE")
    if env:
        return Path(env).expanduser()
    base = os.environ.get("OBJECTIFOUDRE_HISTORY_DIR") or (HERE / "history")
    return Path(base).expanduser() / "accounts.db"


@contextmanager
def _db() -> Iterator[sqlite3.Connection]:
    p = _db_path()
    p.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(str(p), timeout=10.0)
    conn.row_factory = sqlite3.Row
    try:
        conn.execute("PRAGMA journal_mode=WAL")
        conn.execute("PRAGMA busy_timeout=10000")
        conn.execute("PRAGMA foreign_keys=ON")
        yield conn
        conn.commit()
    finally:
        conn.close()


def init_db() -> None:
    with _lock, _db() as c:
        c.executescript(
            """
            CREATE TABLE IF NOT EXISTS users (
                id            TEXT PRIMARY KEY,
                created_utc   TEXT NOT NULL,
                updated_utc   TEXT NOT NULL,
                google_sub    TEXT UNIQUE,
                email         TEXT,
                email_verified INTEGER NOT NULL DEFAULT 0,
                pseudo        TEXT NOT NULL,
                prefs         TEXT NOT NULL DEFAULT '{}'
            );
            CREATE UNIQUE INDEX IF NOT EXISTS idx_users_pseudo ON users (pseudo COLLATE NOCASE);
            CREATE TABLE IF NOT EXISTS sessions (
                token_hash    TEXT PRIMARY KEY,
                user_id       TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                created_utc   TEXT NOT NULL,
                expires_utc   TEXT NOT NULL,
                last_seen_utc TEXT NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions (user_id);
            """
        )


# ── Pseudo ───────────────────────────────────────────────────────────────────
def clean_pseudo(raw: Any) -> str:
    p = re.sub(r"\s+", " ", str(raw or "")).strip()
    if not _PSEUDO_RE.match(p):
        raise AccountError("Pseudo : 3 à 24 caractères (lettres, chiffres, espace, . _ -), sans espace au bord.")
    return p


def _pseudo_taken(c: sqlite3.Connection, pseudo: str, exclude_id: str | None = None) -> bool:
    row = c.execute(
        "SELECT id FROM users WHERE pseudo = ? COLLATE NOCASE AND id IS NOT ?",
        (pseudo, exclude_id),
    ).fetchone()
    return row is not None


def _suggest_pseudo(c: sqlite3.Connection, base: Any) -> str:
    root = re.sub(r"[^A-Za-z0-9 ._-]", "", str(base or "").strip()) or "Chasseur"
    root = root[:20].strip() or "Chasseur"
    if len(root) < 2:
        root = "Chasseur"
    for attempt in range(0, 10000):
        candidate = root if attempt == 0 else f"{root}{attempt + 1}"
        candidate = candidate[:24]
        try:
            candidate_ok = clean_pseudo(candidate)
        except AccountError:
            candidate_ok = f"Chasseur{attempt + 1}"
        if not _pseudo_taken(c, candidate_ok):
            return candidate_ok
    return "Chasseur-" + uuid.uuid4().hex[:6]


# ── Vues ─────────────────────────────────────────────────────────────────────
def _row_to_user(row: sqlite3.Row) -> dict[str, Any]:
    try:
        prefs = json.loads(row["prefs"] or "{}")
    except (json.JSONDecodeError, TypeError):
        prefs = {}
    return {
        "id": row["id"], "created_utc": row["created_utc"], "updated_utc": row["updated_utc"],
        "google_sub": row["google_sub"], "email": row["email"],
        "email_verified": bool(row["email_verified"]), "pseudo": row["pseudo"],
        "prefs": prefs if isinstance(prefs, dict) else {},
    }


def private_view(user: dict[str, Any]) -> dict[str, Any]:
    """Vue renvoyée à l'utilisateur LUI-MÊME (avec e-mail + préférences)."""
    return {
        "id": user["id"], "pseudo": user["pseudo"], "email": user.get("email"),
        "email_verified": user.get("email_verified", False),
        "prefs": user.get("prefs") or {}, "created_utc": user.get("created_utc"),
        "auth": "google" if user.get("google_sub") else "local",
    }


def public_view(user: dict[str, Any]) -> dict[str, Any]:
    """Vue exposée aux AUTRES (auteur d'un spot public) : pseudo seulement, jamais l'e-mail."""
    return {"id": user["id"], "pseudo": user["pseudo"]}


# ── Utilisateurs ─────────────────────────────────────────────────────────────
def get_user(user_id: str) -> dict[str, Any] | None:
    if not user_id:
        return None
    with _db() as c:
        row = c.execute("SELECT * FROM users WHERE id = ?", (user_id,)).fetchone()
    return _row_to_user(row) if row else None


def upsert_google_user(sub: str, email: str | None, email_verified: bool, name: str | None) -> dict[str, Any]:
    """Trouve le compte par `google_sub`, sinon le crée (pseudo dérivé du nom/e-mail,
    unicité garantie). Met à jour l'e-mail si Google le fournit."""
    sub = str(sub or "").strip()
    if not sub:
        raise AccountError("Identité Google incomplète.")
    now = _now_iso()
    with _lock, _db() as c:
        row = c.execute("SELECT * FROM users WHERE google_sub = ?", (sub,)).fetchone()
        if row is not None:
            if email and email != row["email"]:
                c.execute("UPDATE users SET email = ?, email_verified = ?, updated_utc = ? WHERE id = ?",
                          (email, 1 if email_verified else 0, now, row["id"]))
                row = c.execute("SELECT * FROM users WHERE id = ?", (row["id"],)).fetchone()
            return _row_to_user(row)
        base = name or (email.split("@")[0] if email else None) or "Chasseur"
        pseudo = _suggest_pseudo(c, base)
        uid = uuid.uuid4().hex[:16]
        c.execute(
            "INSERT INTO users (id, created_utc, updated_utc, google_sub, email, email_verified, pseudo, prefs) "
            "VALUES (?,?,?,?,?,?,?,?)",
            (uid, now, now, sub, email, 1 if email_verified else 0, pseudo, "{}"),
        )
        row = c.execute("SELECT * FROM users WHERE id = ?", (uid,)).fetchone()
    return _row_to_user(row)


def set_pseudo(user_id: str, raw_pseudo: str) -> dict[str, Any]:
    pseudo = clean_pseudo(raw_pseudo)
    with _lock, _db() as c:
        if _pseudo_taken(c, pseudo, exclude_id=user_id):
            raise AccountError("Ce pseudo est déjà pris.")
        cur = c.execute("UPDATE users SET pseudo = ?, updated_utc = ? WHERE id = ?",
                        (pseudo, _now_iso(), user_id))
        if cur.rowcount == 0:
            raise AccountError("Compte introuvable.")
        row = c.execute("SELECT * FROM users WHERE id = ?", (user_id,)).fetchone()
    return _row_to_user(row)


def set_prefs(user_id: str, patch: dict[str, Any]) -> dict[str, Any]:
    """Fusionne les préférences (validées). MVP : `default_map` (forecast/chase/stargaze/null)."""
    if not isinstance(patch, dict):
        raise AccountError("Préférences invalides.")
    clean: dict[str, Any] = {}
    if "default_map" in patch:
        dm = patch["default_map"]
        if dm in (None, "", "auto"):
            clean["default_map"] = None
        elif dm in _DEFAULT_MAPS:
            clean["default_map"] = dm
        else:
            raise AccountError("Carte par défaut invalide.")
    with _lock, _db() as c:
        row = c.execute("SELECT prefs FROM users WHERE id = ?", (user_id,)).fetchone()
        if row is None:
            raise AccountError("Compte introuvable.")
        try:
            prefs = json.loads(row["prefs"] or "{}")
        except (json.JSONDecodeError, TypeError):
            prefs = {}
        prefs.update(clean)
        prefs = {k: v for k, v in prefs.items() if v is not None}
        c.execute("UPDATE users SET prefs = ?, updated_utc = ? WHERE id = ?",
                  (json.dumps(prefs, ensure_ascii=False), _now_iso(), user_id))
        row = c.execute("SELECT * FROM users WHERE id = ?", (user_id,)).fetchone()
    return _row_to_user(row)


def delete_user(user_id: str) -> bool:
    """Suppression du compte (droit RGPD à l'effacement) — les sessions tombent en cascade."""
    with _lock, _db() as c:
        cur = c.execute("DELETE FROM users WHERE id = ?", (user_id,))
    return cur.rowcount > 0


# ── Sessions (jeton opaque, stocké hashé) ────────────────────────────────────
def _hash_token(token: str) -> str:
    return hashlib.sha256(token.encode("utf-8")).hexdigest()


def create_session(user_id: str, days: int = SESSION_DAYS) -> str:
    token = secrets.token_urlsafe(32)
    now = time.time()
    with _lock, _db() as c:
        c.execute(
            "INSERT INTO sessions (token_hash, user_id, created_utc, expires_utc, last_seen_utc) VALUES (?,?,?,?,?)",
            (_hash_token(token), user_id, _now_iso(),
             datetime.fromtimestamp(now + days * 86400, timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
             _now_iso()),
        )
    return token


def user_by_session(token: str) -> dict[str, Any] | None:
    if not token:
        return None
    th = _hash_token(token)
    now = _now_iso()
    with _db() as c:
        row = c.execute(
            "SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id "
            "WHERE s.token_hash = ? AND s.expires_utc > ?",
            (th, now),
        ).fetchone()
        if row is None:
            return None
        c.execute("UPDATE sessions SET last_seen_utc = ? WHERE token_hash = ?", (now, th))
    return _row_to_user(row)


def delete_session(token: str) -> None:
    if not token:
        return
    with _lock, _db() as c:
        c.execute("DELETE FROM sessions WHERE token_hash = ?", (_hash_token(token),))


def purge_expired_sessions() -> int:
    with _lock, _db() as c:
        cur = c.execute("DELETE FROM sessions WHERE expires_utc <= ?", (_now_iso(),))
    return cur.rowcount


def stats() -> dict[str, Any]:
    """Compteurs pour la télémétrie admin."""
    with _db() as c:
        total = c.execute("SELECT COUNT(*) AS n FROM users").fetchone()["n"]
        google = c.execute("SELECT COUNT(*) AS n FROM users WHERE google_sub IS NOT NULL").fetchone()["n"]
        sess = c.execute("SELECT COUNT(*) AS n FROM sessions WHERE expires_utc > ?", (_now_iso(),)).fetchone()["n"]
    return {"total": total, "google": google, "active_sessions": sess}


# ── Self-test ────────────────────────────────────────────────────────────────
if __name__ == "__main__":
    import tempfile
    os.environ["OBJECTIFOUDRE_ACCOUNTS_FILE"] = os.path.join(tempfile.mkdtemp(), "accounts.db")
    ok = {"n": 0, "fail": 0}

    def check(label: str, cond: bool) -> None:
        ok["n"] += 1
        if not cond:
            ok["fail"] += 1
            print("  ✗", label)
        else:
            print("  ✓", label)

    init_db()
    u1 = upsert_google_user("google-sub-1", "alice@example.com", True, "Alice Météo")
    check("création Google → pseudo", bool(u1["pseudo"]))
    u1b = upsert_google_user("google-sub-1", "alice@example.com", True, "Alice Météo")
    check("upsert idempotent (même sub → même id)", u1b["id"] == u1["id"])
    u2 = upsert_google_user("google-sub-2", "alice2@example.com", True, "Alice Météo")
    check("pseudo dédupliqué si même nom", u2["pseudo"] != u1["pseudo"])

    tok = create_session(u1["id"])
    check("session → utilisateur", (user_by_session(tok) or {}).get("id") == u1["id"])
    check("mauvais jeton → None", user_by_session("faux-jeton") is None)
    delete_session(tok)
    check("logout invalide la session", user_by_session(tok) is None)

    su = set_pseudo(u1["id"], "AlpineChaser")
    check("set_pseudo", su["pseudo"] == "AlpineChaser")
    try:
        set_pseudo(u2["id"], "AlpineChaser"); check("pseudo unique refusé", False)
    except AccountError:
        check("pseudo unique refusé", True)
    try:
        clean_pseudo("a"); check("pseudo trop court refusé", False)
    except AccountError:
        check("pseudo trop court refusé", True)

    sp = set_prefs(u1["id"], {"default_map": "stargaze"})
    check("préférence carte par défaut", sp["prefs"].get("default_map") == "stargaze")
    try:
        set_prefs(u1["id"], {"default_map": "nope"}); check("carte défaut invalide refusée", False)
    except AccountError:
        check("carte défaut invalide refusée", True)
    sp2 = set_prefs(u1["id"], {"default_map": None})
    check("préférence réinitialisable (null)", "default_map" not in sp2["prefs"])

    check("vue publique = pseudo seul (pas d'e-mail)", "email" not in public_view(u1))
    check("vue privée = avec e-mail", private_view(get_user(u1["id"])).get("email") == "alice@example.com")
    st = stats()
    check("stats total", st["total"] == 2 and st["google"] == 2)
    check("delete_user (RGPD)", delete_user(u2["id"]) and get_user(u2["id"]) is None)

    print(f"\n{ok['n'] - ok['fail']}/{ok['n']} OK" + ("" if ok["fail"] == 0 else f" — {ok['fail']} ÉCHEC(S)"))
    raise SystemExit(1 if ok["fail"] else 0)
