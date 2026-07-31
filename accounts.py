"""accounts.py — Comptes utilisateurs (carte Trello « Système de compte »).

Couche données SQLite ISOLÉE (pattern spots.py) : base `accounts.db` sur le volume
durable (OBJECTIFOUDRE_HISTORY_DIR). app.py gère le flux OAuth/e-mail et pose une session.

Phase 3 : identités multiples (plusieurs fournisseurs OAuth + mot de passe) par compte.
  users(id, created_utc, updated_utc, google_sub[legacy], email, email_verified,
        pseudo UNIQUE(NOCASE), prefs JSON, password_hash)
  identities(provider, sub, user_id, created_utc, PK(provider, sub))  ← Google, Microsoft…
  email_tokens(token_hash PK, user_id, kind, email, created_utc, expires_utc)  ← verify/reset
  sessions(token_hash PK, user_id, created_utc, expires_utc, last_seen_utc)

Secrets : le mot de passe est stocké HACHÉ (PBKDF2-HMAC-SHA256, sel par utilisateur,
stdlib — aucune dépendance) ; les jetons de session et d'e-mail sont stockés HACHÉS
(sha256) — une fuite de la base n'expose ni mot de passe en clair ni session/lien vif.
Les cookies/liens portent le jeton brut. Aucun secret de fournisseur ici.
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
_EMAIL_RE = re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s]+$")
_DEFAULT_MAPS = {"forecast", "chase", "stargaze"}
SESSION_DAYS = 60
_PBKDF2_ROUNDS = 240_000          # coût du hachage de mot de passe (PBKDF2-HMAC-SHA256)
_PWD_MIN = 8                       # longueur minimale du mot de passe
_PWD_MAX = 200                     # borne haute (anti-DoS de hachage)
VERIFY_TOKEN_HOURS = 24           # durée de vie d'un lien de vérification e-mail
RESET_TOKEN_HOURS = 1             # durée de vie d'un lien de réinitialisation
_TOKEN_KINDS = {"verify", "reset"}


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
            -- Phase 3 : une identité externe (provider, sub) → un compte.
            CREATE TABLE IF NOT EXISTS identities (
                provider    TEXT NOT NULL,
                sub         TEXT NOT NULL,
                user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                created_utc TEXT NOT NULL,
                PRIMARY KEY (provider, sub)
            );
            CREATE INDEX IF NOT EXISTS idx_identities_user ON identities (user_id);
            -- Phase 3 : jetons e-mail (vérification / réinitialisation), stockés hashés.
            CREATE TABLE IF NOT EXISTS email_tokens (
                token_hash  TEXT PRIMARY KEY,
                user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                kind        TEXT NOT NULL,
                email       TEXT,
                created_utc TEXT NOT NULL,
                expires_utc TEXT NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_email_tokens_user ON email_tokens (user_id, kind);
            """
        )
        # Migration douce : colonne password_hash (ajoutée si absente).
        cols = {r["name"] for r in c.execute("PRAGMA table_info(users)")}
        if "password_hash" not in cols:
            c.execute("ALTER TABLE users ADD COLUMN password_hash TEXT")
        # Migration douce : backfill des identités Google historiques (google_sub) → table identities.
        now = _now_iso()
        for row in c.execute(
            "SELECT id, google_sub FROM users WHERE google_sub IS NOT NULL AND google_sub != '' "
            "AND id NOT IN (SELECT user_id FROM identities WHERE provider = 'google')"
        ).fetchall():
            c.execute(
                "INSERT OR IGNORE INTO identities (provider, sub, user_id, created_utc) VALUES ('google', ?, ?, ?)",
                (row["google_sub"], row["id"], now),
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


# ── E-mail & mot de passe ────────────────────────────────────────────────────
def clean_email(raw: Any) -> str:
    e = str(raw or "").strip().lower()
    if len(e) > 254 or not _EMAIL_RE.match(e):
        raise AccountError("Adresse e-mail invalide.")
    return e


def _check_password(pw: Any) -> str:
    pw = str(pw or "")
    if len(pw) < _PWD_MIN:
        raise AccountError(f"Mot de passe : {_PWD_MIN} caractères minimum.")
    if len(pw) > _PWD_MAX:
        raise AccountError("Mot de passe trop long.")
    return pw


def _hash_password(pw: str) -> str:
    salt = os.urandom(16)
    dk = hashlib.pbkdf2_hmac("sha256", pw.encode("utf-8"), salt, _PBKDF2_ROUNDS)
    return f"pbkdf2_sha256${_PBKDF2_ROUNDS}${salt.hex()}${dk.hex()}"


def _verify_password(pw: str, stored: str | None) -> bool:
    if not stored:
        return False
    try:
        algo, rounds, salt_hex, hash_hex = stored.split("$", 3)
        if algo != "pbkdf2_sha256":
            return False
        dk = hashlib.pbkdf2_hmac("sha256", pw.encode("utf-8"), bytes.fromhex(salt_hex), int(rounds))
    except (ValueError, TypeError):
        return False
    return secrets.compare_digest(dk.hex(), hash_hex)


# ── Vues ─────────────────────────────────────────────────────────────────────
def _row_to_user(row: sqlite3.Row) -> dict[str, Any]:
    try:
        prefs = json.loads(row["prefs"] or "{}")
    except (json.JSONDecodeError, TypeError):
        prefs = {}
    keys = row.keys()
    return {
        "id": row["id"], "created_utc": row["created_utc"], "updated_utc": row["updated_utc"],
        "google_sub": row["google_sub"], "email": row["email"],
        "email_verified": bool(row["email_verified"]), "pseudo": row["pseudo"],
        "prefs": prefs if isinstance(prefs, dict) else {},
        "has_password": bool(row["password_hash"]) if "password_hash" in keys else False,
    }


def private_view(user: dict[str, Any]) -> dict[str, Any]:
    """Vue renvoyée à l'utilisateur LUI-MÊME (avec e-mail + préférences + moyens de connexion)."""
    return {
        "id": user["id"], "pseudo": user["pseudo"], "email": user.get("email"),
        "email_verified": user.get("email_verified", False),
        "prefs": user.get("prefs") or {}, "created_utc": user.get("created_utc"),
        "has_password": user.get("has_password", False),
        "providers": list_providers(user["id"]),
    }


def list_providers(user_id: str) -> list[str]:
    """Fournisseurs OAuth liés à ce compte (ex. ['google', 'microsoft'])."""
    if not user_id:
        return []
    with _db() as c:
        rows = c.execute("SELECT provider FROM identities WHERE user_id = ? ORDER BY created_utc", (user_id,)).fetchall()
    return [r["provider"] for r in rows]


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


def pseudos_for(user_ids: Any) -> dict[str, str]:
    """Résolution par lot id→pseudo (pour afficher l'auteur des spots publics).
    Ignore les ids inconnus/vides. Retourne {} si rien à résoudre."""
    ids = [str(i) for i in (user_ids or []) if i]
    ids = list(dict.fromkeys(ids))  # dédoublonne en conservant l'ordre
    if not ids:
        return {}
    out: dict[str, str] = {}
    with _db() as c:
        # Découpe par paquets pour rester sous la limite de variables SQLite.
        for i in range(0, len(ids), 400):
            chunk = ids[i:i + 400]
            ph = ",".join("?" * len(chunk))
            for row in c.execute(f"SELECT id, pseudo FROM users WHERE id IN ({ph})", chunk):
                out[row["id"]] = row["pseudo"]
    return out


def _soft_email(raw: Any) -> str | None:
    e = str(raw or "").strip().lower()
    return e if e and _EMAIL_RE.match(e) else None


def upsert_oauth_user(provider: str, sub: str, email: str | None,
                      email_verified: bool, name: str | None) -> dict[str, Any]:
    """Connexion via un fournisseur OAuth (Google, Microsoft…).
    - Identité (provider, sub) déjà connue → renvoie le compte lié.
    - Sinon, si l'e-mail est **vérifié** et correspond à un compte existant (e-mail vérifié)
      → **rattache** l'identité à ce compte (un seul compte pour Google+Microsoft+e-mail).
    - Sinon → crée un nouveau compte (pseudo dérivé du nom/e-mail) et l'identité."""
    provider = str(provider or "").strip().lower()
    sub = str(sub or "").strip()
    if not provider or not sub:
        raise AccountError("Identité de connexion incomplète.")
    email = _soft_email(email)
    now = _now_iso()
    with _lock, _db() as c:
        link = c.execute("SELECT user_id FROM identities WHERE provider = ? AND sub = ?", (provider, sub)).fetchone()
        if link is not None:
            row = c.execute("SELECT * FROM users WHERE id = ?", (link["user_id"],)).fetchone()
            if row is not None and email and not row["email"]:   # complète l'e-mail si le compte n'en avait pas
                c.execute("UPDATE users SET email = ?, email_verified = ?, updated_utc = ? WHERE id = ?",
                          (email, 1 if email_verified else 0, now, row["id"]))
                row = c.execute("SELECT * FROM users WHERE id = ?", (row["id"],)).fetchone()
            if row is not None:
                return _row_to_user(row)
        # Rattachement à un compte existant par e-mail vérifié (des deux côtés).
        uid: str | None = None
        if email and email_verified:
            existing = c.execute("SELECT * FROM users WHERE email = ? AND email_verified = 1", (email,)).fetchone()
            if existing is not None:
                uid = existing["id"]
        if uid is None:                                          # nouveau compte
            base = name or (email.split("@")[0] if email else None) or "Chasseur"
            pseudo = _suggest_pseudo(c, base)
            uid = uuid.uuid4().hex[:16]
            c.execute(
                "INSERT INTO users (id, created_utc, updated_utc, email, email_verified, pseudo, prefs) "
                "VALUES (?,?,?,?,?,?,?)",
                (uid, now, now, email, 1 if (email and email_verified) else 0, pseudo, "{}"),
            )
        c.execute("INSERT OR IGNORE INTO identities (provider, sub, user_id, created_utc) VALUES (?,?,?,?)",
                  (provider, sub, uid, now))
        row = c.execute("SELECT * FROM users WHERE id = ?", (uid,)).fetchone()
    return _row_to_user(row)


def upsert_google_user(sub: str, email: str | None, email_verified: bool, name: str | None) -> dict[str, Any]:
    """Compat : Google est désormais un fournisseur OAuth parmi d'autres."""
    return upsert_oauth_user("google", sub, email, email_verified, name)


# ── Inscription / connexion par e-mail + mot de passe ────────────────────────
def _expires_in(hours: float) -> str:
    return datetime.fromtimestamp(time.time() + hours * 3600, timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def register_local(email: str, password: str, pseudo: str | None = None) -> dict[str, Any]:
    """Crée un compte e-mail/mot de passe **non vérifié** (l'appelant émet un jeton de
    vérification et envoie l'e-mail). Rejette si un compte **vérifié** utilise déjà cet e-mail ;
    réutilise une inscription non vérifiée (l'e-mail n'étant pas encore prouvé)."""
    email = clean_email(email)
    _check_password(password)
    now = _now_iso()
    with _lock, _db() as c:
        existing = c.execute("SELECT * FROM users WHERE email = ? ORDER BY email_verified DESC", (email,)).fetchone()
        want_pseudo = None
        if pseudo:
            want_pseudo = clean_pseudo(pseudo)
        if existing is not None and existing["email_verified"]:
            raise AccountError("Un compte existe déjà avec cet e-mail. Connecte-toi ou réinitialise ton mot de passe.")
        if existing is not None:                                # inscription non vérifiée → on réutilise la ligne
            uid = existing["id"]
            if want_pseudo and _pseudo_taken(c, want_pseudo, exclude_id=uid):
                raise AccountError("Ce pseudo est déjà pris.")
            c.execute("UPDATE users SET password_hash = ?, updated_utc = ? WHERE id = ?",
                      (_hash_password(password), now, uid))
            if want_pseudo:
                c.execute("UPDATE users SET pseudo = ? WHERE id = ?", (want_pseudo, uid))
        else:
            if want_pseudo and _pseudo_taken(c, want_pseudo):
                raise AccountError("Ce pseudo est déjà pris.")
            uid = uuid.uuid4().hex[:16]
            pseudo_final = want_pseudo or _suggest_pseudo(c, email.split("@")[0])
            c.execute(
                "INSERT INTO users (id, created_utc, updated_utc, email, email_verified, pseudo, prefs, password_hash) "
                "VALUES (?,?,?,?,0,?,?,?)",
                (uid, now, now, email, pseudo_final, "{}", _hash_password(password)),
            )
        row = c.execute("SELECT * FROM users WHERE id = ?", (uid,)).fetchone()
    return _row_to_user(row)


def issue_email_token(user_id: str, kind: str, email: str = "") -> str:
    """Émet un jeton e-mail (kind='verify'|'reset') à usage unique, stocké **hashé**.
    Un seul jeton actif par (compte, kind) : les précédents sont invalidés."""
    if kind not in _TOKEN_KINDS:
        raise AccountError("Type de jeton inconnu.")
    token = secrets.token_urlsafe(32)
    hours = VERIFY_TOKEN_HOURS if kind == "verify" else RESET_TOKEN_HOURS
    with _lock, _db() as c:
        if c.execute("SELECT 1 FROM users WHERE id = ?", (user_id,)).fetchone() is None:
            raise AccountError("Compte introuvable.")
        c.execute("DELETE FROM email_tokens WHERE user_id = ? AND kind = ?", (user_id, kind))
        c.execute(
            "INSERT INTO email_tokens (token_hash, user_id, kind, email, created_utc, expires_utc) VALUES (?,?,?,?,?,?)",
            (_hash_token(token), user_id, kind, email or "", _now_iso(), _expires_in(hours)),
        )
    return token


def _consume_email_token(c: sqlite3.Connection, token: str, kind: str) -> sqlite3.Row | None:
    """Valide + CONSOMME (usage unique) un jeton e-mail. Purge les expirés. Suppose le verrou tenu."""
    if not token:
        return None
    th = _hash_token(token)
    row = c.execute("SELECT * FROM email_tokens WHERE token_hash = ? AND kind = ?", (th, kind)).fetchone()
    if row is None:
        return None
    c.execute("DELETE FROM email_tokens WHERE token_hash = ?", (th,))   # usage unique
    if row["expires_utc"] <= _now_iso():
        return None
    return row


def verify_email_token(token: str) -> dict[str, Any] | None:
    """Valide un lien de vérification → marque l'e-mail vérifié. Renvoie le compte, sinon None."""
    with _lock, _db() as c:
        row = _consume_email_token(c, token, "verify")
        if row is None:
            return None
        target_email = row["email"] or None
        if target_email:
            c.execute("UPDATE users SET email = ?, email_verified = 1, updated_utc = ? WHERE id = ?",
                      (target_email, _now_iso(), row["user_id"]))
        else:
            c.execute("UPDATE users SET email_verified = 1, updated_utc = ? WHERE id = ?",
                      (_now_iso(), row["user_id"]))
        urow = c.execute("SELECT * FROM users WHERE id = ?", (row["user_id"],)).fetchone()
    return _row_to_user(urow) if urow else None


def authenticate_local(email: str, password: str) -> dict[str, Any] | None:
    """Vérifie e-mail + mot de passe. Renvoie le compte (l'appelant vérifie `email_verified`),
    sinon None (aucune distinction e-mail inconnu / mauvais mot de passe → anti-énumération)."""
    e = _soft_email(email)
    if not e:
        return None
    with _db() as c:
        row = c.execute(
            "SELECT * FROM users WHERE email = ? AND password_hash IS NOT NULL ORDER BY email_verified DESC",
            (e,),
        ).fetchone()
    if row is None or not _verify_password(str(password or ""), row["password_hash"]):
        return None
    return _row_to_user(row)


def find_local_by_email(email: str) -> dict[str, Any] | None:
    """Compte e-mail/mot de passe pour cet e-mail (pour émettre vérif/reset). None sinon."""
    e = _soft_email(email)
    if not e:
        return None
    with _db() as c:
        row = c.execute("SELECT * FROM users WHERE email = ? ORDER BY email_verified DESC", (e,)).fetchone()
    return _row_to_user(row) if row else None


def set_password(user_id: str, password: str) -> dict[str, Any]:
    """Définit/remplace le mot de passe (reset, ou ajout d'un mot de passe à un compte OAuth)."""
    _check_password(password)
    with _lock, _db() as c:
        cur = c.execute("UPDATE users SET password_hash = ?, updated_utc = ? WHERE id = ?",
                        (_hash_password(password), _now_iso(), user_id))
        if cur.rowcount == 0:
            raise AccountError("Compte introuvable.")
        row = c.execute("SELECT * FROM users WHERE id = ?", (user_id,)).fetchone()
    return _row_to_user(row)


def change_password(user_id: str, current: str, new: str) -> dict[str, Any]:
    """Change le mot de passe d'un compte connecté. Exige le mot de passe actuel s'il en a un."""
    _check_password(new)
    with _lock, _db() as c:
        row = c.execute("SELECT * FROM users WHERE id = ?", (user_id,)).fetchone()
        if row is None:
            raise AccountError("Compte introuvable.")
        if row["password_hash"] and not _verify_password(str(current or ""), row["password_hash"]):
            raise AccountError("Mot de passe actuel incorrect.")
        c.execute("UPDATE users SET password_hash = ?, updated_utc = ? WHERE id = ?",
                  (_hash_password(new), _now_iso(), user_id))
        row = c.execute("SELECT * FROM users WHERE id = ?", (user_id,)).fetchone()
    return _row_to_user(row)


def reset_password(token: str, new_password: str) -> dict[str, Any] | None:
    """Réinitialise le mot de passe via un lien de reset (prouve l'accès à l'e-mail → le vérifie
    aussi). Renvoie le compte, sinon None (lien invalide/expiré)."""
    _check_password(new_password)
    with _lock, _db() as c:
        row = _consume_email_token(c, token, "reset")
        if row is None:
            return None
        c.execute("UPDATE users SET password_hash = ?, email_verified = 1, updated_utc = ? WHERE id = ?",
                  (_hash_password(new_password), _now_iso(), row["user_id"]))
        urow = c.execute("SELECT * FROM users WHERE id = ?", (row["user_id"],)).fetchone()
    return _row_to_user(urow) if urow else None


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
    """Compteurs pour la télémétrie admin (répartition par moyen de connexion)."""
    with _db() as c:
        total = c.execute("SELECT COUNT(*) AS n FROM users").fetchone()["n"]
        by_provider = {r["provider"]: r["n"] for r in c.execute(
            "SELECT provider, COUNT(DISTINCT user_id) AS n FROM identities GROUP BY provider")}
        password = c.execute("SELECT COUNT(*) AS n FROM users WHERE password_hash IS NOT NULL").fetchone()["n"]
        verified = c.execute("SELECT COUNT(*) AS n FROM users WHERE email_verified = 1").fetchone()["n"]
        sess = c.execute("SELECT COUNT(*) AS n FROM sessions WHERE expires_utc > ?", (_now_iso(),)).fetchone()["n"]
    return {"total": total, "google": by_provider.get("google", 0), "microsoft": by_provider.get("microsoft", 0),
            "by_provider": by_provider, "password": password, "verified": verified, "active_sessions": sess}


def admin_list() -> list[dict[str, Any]]:
    """[admin] Liste complète des comptes pour la modération/nettoyage (JAMAIS exposée au public).
    Renvoie id, e-mail, pseudo, date, statut de vérif, moyens de connexion et nb de sessions actives."""
    now = _now_iso()
    with _db() as c:
        rows = c.execute("SELECT * FROM users ORDER BY created_utc").fetchall()
        provs: dict[str, list[str]] = {}
        for r in c.execute("SELECT user_id, provider FROM identities ORDER BY created_utc").fetchall():
            provs.setdefault(r["user_id"], []).append(r["provider"])
        sess: dict[str, int] = {}
        for r in c.execute(
            "SELECT user_id, COUNT(*) AS n FROM sessions WHERE expires_utc > ? GROUP BY user_id", (now,)
        ).fetchall():
            sess[r["user_id"]] = r["n"]
    out: list[dict[str, Any]] = []
    for row in rows:
        u = _row_to_user(row)
        out.append({
            "id": u["id"], "email": u["email"], "pseudo": u["pseudo"],
            "email_verified": u["email_verified"], "has_password": u["has_password"],
            "providers": provs.get(u["id"], []),
            "created_utc": u["created_utc"], "updated_utc": u["updated_utc"],
            "active_sessions": sess.get(u["id"], 0),
        })
    return out


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

    pmap = pseudos_for([u1["id"], u2["id"], "inconnu", ""])
    check("pseudos_for résout les ids connus", pmap.get(u1["id"]) == "AlpineChaser" and u2["id"] in pmap)
    check("pseudos_for ignore les ids inconnus/vides", "inconnu" not in pmap and "" not in pmap)
    check("pseudos_for([]) → {}", pseudos_for([]) == {})
    check("vue publique = pseudo seul (pas d'e-mail)", "email" not in public_view(u1))
    check("vue privée = avec e-mail", private_view(get_user(u1["id"])).get("email") == "alice@example.com")

    print("=== identités multiples (Phase 3) ===")
    check("Google → identité 'google'", list_providers(u1["id"]) == ["google"])
    # Microsoft avec le MÊME e-mail vérifié → rattaché au compte existant.
    um = upsert_oauth_user("microsoft", "ms-sub-1", "alice@example.com", True, "Alice")
    check("Microsoft (même e-mail vérifié) rattaché au compte Google", um["id"] == u1["id"])
    check("2 providers sur le compte", set(list_providers(u1["id"])) == {"google", "microsoft"})
    # Microsoft avec un autre e-mail → nouveau compte.
    um2 = upsert_oauth_user("microsoft", "ms-sub-2", "bob@example.com", True, "Bob")
    check("Microsoft (autre e-mail) → nouveau compte", um2["id"] != u1["id"])
    check("upsert Microsoft idempotent", upsert_oauth_user("microsoft", "ms-sub-2", "bob@example.com", True, "Bob")["id"] == um2["id"])

    print("=== e-mail + mot de passe (Phase 3) ===")
    try:
        register_local("pasunemail", "motdepasse123"); check("e-mail invalide refusé", False)
    except AccountError:
        check("e-mail invalide refusé", True)
    try:
        register_local("carol@example.com", "court"); check("mot de passe trop court refusé", False)
    except AccountError:
        check("mot de passe trop court refusé", True)
    uc = register_local("carol@example.com", "SuperSecret1", pseudo="Carol")
    check("register_local → non vérifié", uc["email_verified"] is False and uc["has_password"] is True)
    check("connexion refusée tant que non vérifié (côté endpoint) mais mot de passe OK",
          (authenticate_local("carol@example.com", "SuperSecret1") or {}).get("id") == uc["id"])
    check("mauvais mot de passe → None", authenticate_local("carol@example.com", "mauvais") is None)
    check("e-mail inconnu → None", authenticate_local("nobody@example.com", "SuperSecret1") is None)
    vtok = issue_email_token(uc["id"], "verify", "carol@example.com")
    check("jeton de vérif à usage unique", verify_email_token(vtok) is not None and verify_email_token(vtok) is None)
    check("e-mail vérifié après le lien", get_user(uc["id"])["email_verified"] is True)
    try:
        register_local("carol@example.com", "AutreMdp123"); check("réinscription refusée si déjà vérifié", False)
    except AccountError:
        check("réinscription refusée si déjà vérifié", True)
    rtok = issue_email_token(uc["id"], "reset")
    check("reset : mauvais jeton → None", reset_password("faux", "NouveauMdp1") is None)
    check("reset_password OK", (reset_password(rtok, "NouveauMdp1") or {}).get("id") == uc["id"])
    check("ancien mot de passe invalide après reset", authenticate_local("carol@example.com", "SuperSecret1") is None)
    check("nouveau mot de passe valide", (authenticate_local("carol@example.com", "NouveauMdp1") or {}).get("id") == uc["id"])
    # jeton expiré
    exp = issue_email_token(uc["id"], "verify")
    with _db() as c:
        c.execute("UPDATE email_tokens SET expires_utc = '2000-01-01T00:00:00Z' WHERE user_id = ?", (uc["id"],)); c.commit()
    check("jeton expiré → None", verify_email_token(exp) is None)
    # ajout d'un mot de passe à un compte OAuth pur (Bob), puis changement
    set_password(um2["id"], "BobPassword1")
    check("set_password sur compte OAuth", get_user(um2["id"])["has_password"] is True)
    try:
        change_password(um2["id"], "faux", "EncoreUnMdp1"); check("change_password exige l'actuel", False)
    except AccountError:
        check("change_password exige l'actuel", True)
    check("change_password OK", change_password(um2["id"], "BobPassword1", "EncoreUnMdp1")["has_password"] is True)

    st = stats()
    # google : u1, u2 (=2) · microsoft : u1, um2 (=2) · password : carol, bob (≥2)
    check("stats providers", st["google"] == 2 and st["microsoft"] == 2 and st["password"] >= 2)
    check("delete_user (RGPD) purge identités", delete_user(u1["id"]) and list_providers(u1["id"]) == [])

    print(f"\n{ok['n'] - ok['fail']}/{ok['n']} OK" + ("" if ok["fail"] == 0 else f" — {ok['fail']} ÉCHEC(S)"))
    raise SystemExit(1 if ok["fail"] else 0)
