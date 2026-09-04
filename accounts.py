"""accounts.py — Comptes utilisateurs (carte Trello « Système de compte »).

Couche données SQLite ISOLÉE (pattern spots.py) : base `accounts.db` sur le volume
durable (OBJECTIFOUDRE_HISTORY_DIR). app.py gère le flux OAuth/e-mail et pose une session.

Phase 3 : identités multiples (plusieurs fournisseurs OAuth + mot de passe) par compte.
  users(id, created_utc, updated_utc, google_sub[legacy], email, email_verified,
        pseudo UNIQUE(NOCASE), prefs JSON, password_hash)
  identities(provider, sub, user_id, created_utc, PK(provider, sub))  ← Google, Microsoft…
  email_tokens(token_hash PK, user_id, kind, email, created_utc, expires_utc)  ← verify/reset
  sessions(token_hash PK, user_id, created_utc, expires_utc, last_seen_utc)

Phase 5 : droits d'accès (abonnement/essai) — la POLITIQUE est dans access.py, ici le stockage.
  entitlements(user_id PK → users, plan, source, status, started/expires_utc, external_ref)
  trial_claims(claim_hash PK, claimed_utc, user_id)   ← SANS cascade : survit à la suppression
                                                        du compte, sinon l'essai se recycle.
  ⚠️ `push_subscriptions` (plus bas) = alertes orage, AUCUN rapport avec le paiement.

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

import access                      # politique gratuit/payant (module pur, sans état)

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
            -- Phase 4 : abonnements Web Push (alertes orage). Compte obligatoire →
            -- FK vers users avec suppression en cascade (droit RGPD à l'effacement).
            CREATE TABLE IF NOT EXISTS push_subscriptions (
                id           TEXT PRIMARY KEY,
                user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                endpoint     TEXT NOT NULL UNIQUE,
                p256dh       TEXT NOT NULL,
                auth         TEXT NOT NULL,
                created_utc  TEXT NOT NULL,
                updated_utc  TEXT NOT NULL,
                last_ok_utc  TEXT,
                fail_count   INTEGER NOT NULL DEFAULT 0,
                ua           TEXT
            );
            CREATE INDEX IF NOT EXISTS idx_push_user ON push_subscriptions (user_id);
            -- Départements suivis par un abonnement (normalisé pour la requête "abonnés du dépt X").
            CREATE TABLE IF NOT EXISTS push_departments (
                subscription_id TEXT NOT NULL REFERENCES push_subscriptions(id) ON DELETE CASCADE,
                dept            TEXT NOT NULL,
                PRIMARY KEY (subscription_id, dept)
            );
            CREATE INDEX IF NOT EXISTS idx_push_dept ON push_departments (dept);
            -- Phase 5 : DROITS D'ACCÈS (abonnement/essai). ⚠️ NE PAS confondre avec
            -- push_subscriptions ci-dessus, qui sont les alertes orage : le mot
            -- « subscription » est déjà pris, d'où « entitlements ».
            -- Le droit ne vit JAMAIS dans users.prefs : /api/account/prefs est patchable
            -- par l'utilisateur lui-même, ce serait lui offrir l'abonnement.
            CREATE TABLE IF NOT EXISTS entitlements (
                user_id      TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
                plan         TEXT NOT NULL,            -- 'sub' (accès complet)
                source       TEXT NOT NULL,            -- 'trial' | 'manual' | prestataire (plus tard)
                status       TEXT NOT NULL,            -- 'active' | 'canceled'
                started_utc  TEXT NOT NULL,
                expires_utc  TEXT,                     -- NULL = sans échéance
                updated_utc  TEXT NOT NULL,
                external_ref TEXT                      -- id prestataire ; vide à l'étape 1
            );
            CREATE INDEX IF NOT EXISTS idx_entitlements_expiry ON entitlements (expires_utc);
            -- Anti-recyclage de l'essai : cette table SURVIT à la suppression du compte,
            -- sinon l'essai de 7 jours se renouvelle en recréant un compte. D'où l'absence
            -- VOLONTAIRE de clé étrangère et de cascade. On n'y stocke pas l'e-mail mais
            -- son empreinte sha256 : la donnée est minimisée, jamais lisible en clair.
            CREATE TABLE IF NOT EXISTS trial_claims (
                claim_hash  TEXT PRIMARY KEY,
                claimed_utc TEXT NOT NULL,
                user_id     TEXT                       -- indicatif : le compte peut avoir disparu
            );
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


def avatars_for(user_ids: Any) -> dict[str, str]:
    """Résolution par lot id→avatar (preset choisi dans prefs). Ignore les comptes
    sans avatar (→ initiales côté client). Pour afficher l'avatar des auteurs du forum."""
    ids = [str(i) for i in (user_ids or []) if i]
    ids = list(dict.fromkeys(ids))
    if not ids:
        return {}
    out: dict[str, str] = {}
    with _db() as c:
        for i in range(0, len(ids), 400):
            chunk = ids[i:i + 400]
            ph = ",".join("?" * len(chunk))
            for row in c.execute(f"SELECT id, prefs FROM users WHERE id IN ({ph})", chunk):
                try:
                    prefs = json.loads(row["prefs"] or "{}")
                except (json.JSONDecodeError, TypeError):
                    prefs = {}
                av = prefs.get("avatar") if isinstance(prefs, dict) else None
                if av:
                    out[row["id"]] = av
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
    if "bottom_nav" in patch:
        # Ordre des onglets épinglés de la barre du bas (refonte mobile). On ne
        # stocke qu'une liste d'IDs courts et sûrs (le front valide contre son pool) ;
        # None/[] = réinitialisation au défaut.
        bn = patch["bottom_nav"]
        if not bn:
            clean["bottom_nav"] = None
        elif isinstance(bn, list):
            seen: list[str] = []
            for x in bn:
                s = str(x).strip().lower()
                if re.fullmatch(r"[a-z0-9_-]{1,24}", s) and s not in seen:
                    seen.append(s)
                if len(seen) >= 6:
                    break
            clean["bottom_nav"] = seen or None
        else:
            raise AccountError("Configuration de barre invalide.")
    if "tour_done" in patch:
        # Visite guidée du premier lancement déjà effectuée. Miroir du localStorage,
        # pour ne pas relancer la visite quand l'utilisateur change d'appareil.
        clean["tour_done"] = True if patch["tour_done"] else None
    if "avatar" in patch:
        # Avatar de compte (refonte mobile). ID court d'un preset de la galerie ;
        # 'ini'/absent/invalide → None (= initiales colorées). Le front valide.
        av = patch["avatar"]
        if av and isinstance(av, str) and av != "ini" and re.fullmatch(r"[a-z0-9_-]{1,16}", av):
            clean["avatar"] = av
        else:
            clean["avatar"] = None
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


# ── Notifications push (abonnements Web Push, Phase 4) ───────────────────────
def _clean_departments(raw: Any) -> list[str]:
    """Normalise/dédoublonne une liste de codes département en conservant l'ordre (ex. ['69','01','2A'])."""
    out: list[str] = []
    for d in (raw or []):
        code = str(d).strip().upper()
        if code and code not in out:
            out.append(code)
    return out


def _depts_of(c: sqlite3.Connection, sub_id: str) -> list[str]:
    return [r["dept"] for r in c.execute(
        "SELECT dept FROM push_departments WHERE subscription_id = ? ORDER BY dept", (sub_id,)).fetchall()]


def save_push_subscription(user_id: str, endpoint: str, p256dh: str, auth: str,
                           departments: Any, ua: str | None = None) -> dict[str, Any]:
    """Crée ou met à jour (par endpoint) un abonnement push et REMPLACE ses départements suivis.
    L'endpoint push d'un appareil est unique et stable → sert de clé d'upsert (ré-abonnement propre)."""
    endpoint = str(endpoint or "").strip()
    if not (user_id and endpoint and p256dh and auth):
        raise AccountError("Abonnement push incomplet.")
    depts = _clean_departments(departments)
    now = _now_iso()
    ua_val = (str(ua or "")[:200]) or None
    with _lock, _db() as c:
        row = c.execute("SELECT id FROM push_subscriptions WHERE endpoint = ?", (endpoint,)).fetchone()
        if row is None:
            sub_id = secrets.token_hex(8)
            c.execute(
                "INSERT INTO push_subscriptions (id, user_id, endpoint, p256dh, auth, created_utc, updated_utc, ua) "
                "VALUES (?,?,?,?,?,?,?,?)",
                (sub_id, user_id, endpoint, p256dh, auth, now, now, ua_val),
            )
        else:
            sub_id = row["id"]
            c.execute(
                "UPDATE push_subscriptions SET user_id=?, p256dh=?, auth=?, updated_utc=?, fail_count=0, ua=? WHERE id=?",
                (user_id, p256dh, auth, now, ua_val, sub_id),
            )
        c.execute("DELETE FROM push_departments WHERE subscription_id = ?", (sub_id,))
        for d in depts:
            c.execute("INSERT OR IGNORE INTO push_departments (subscription_id, dept) VALUES (?,?)", (sub_id, d))
    return {"id": sub_id, "endpoint": endpoint, "departments": depts}


def push_subscriptions_for_user(user_id: str) -> list[dict[str, Any]]:
    """Abonnements (appareils) d'un utilisateur + leurs départements, pour l'écran de gestion."""
    if not user_id:
        return []
    with _db() as c:
        rows = c.execute(
            "SELECT id, endpoint, created_utc, updated_utc, ua FROM push_subscriptions "
            "WHERE user_id = ? ORDER BY created_utc", (user_id,)).fetchall()
        return [{"id": r["id"], "endpoint": r["endpoint"], "created_utc": r["created_utc"],
                 "updated_utc": r["updated_utc"], "ua": r["ua"], "departments": _depts_of(c, r["id"])}
                for r in rows]


def delete_push_subscription(user_id: str, endpoint: str) -> bool:
    """Désinscription d'un appareil (par endpoint), restreinte à son propriétaire."""
    if not (user_id and endpoint):
        return False
    with _lock, _db() as c:
        cur = c.execute("DELETE FROM push_subscriptions WHERE user_id = ? AND endpoint = ?",
                        (user_id, str(endpoint).strip()))
    return cur.rowcount > 0


def push_subscribers_for_dept(dept: str) -> list[dict[str, Any]]:
    """[job] Tous les abonnements suivant un département donné (id, user_id, endpoint, clés) pour l'envoi."""
    dept = str(dept or "").strip().upper()
    if not dept:
        return []
    with _db() as c:
        rows = c.execute(
            "SELECT s.id, s.user_id, s.endpoint, s.p256dh, s.auth FROM push_departments d "
            "JOIN push_subscriptions s ON s.id = d.subscription_id WHERE d.dept = ?", (dept,)).fetchall()
    return [dict(r) for r in rows]


def push_send_targets_for_user(user_id: str) -> list[dict[str, Any]]:
    """[test] Abonnements d'un utilisateur AVEC les clés (id, endpoint, p256dh, auth), pour lui
    envoyer une notification de test sur ses propres appareils."""
    if not user_id:
        return []
    with _db() as c:
        rows = c.execute(
            "SELECT id, endpoint, p256dh, auth FROM push_subscriptions WHERE user_id = ?", (user_id,)).fetchall()
    return [dict(r) for r in rows]


def watched_departments() -> set[str]:
    """[job] Départements suivis par au moins un abonné (borne le calcul du job d'alerte)."""
    with _db() as c:
        return {r["dept"] for r in c.execute("SELECT DISTINCT dept FROM push_departments").fetchall()}


def mark_push_ok(subscription_id: str) -> None:
    with _lock, _db() as c:
        c.execute("UPDATE push_subscriptions SET last_ok_utc = ?, fail_count = 0 WHERE id = ?",
                  (_now_iso(), subscription_id))


def mark_push_failure(subscription_id: str, gone: bool = False, max_fail: int = 8) -> bool:
    """Enregistre un échec d'envoi. Supprime l'abonnement si l'endpoint est mort (410/404 → gone=True)
    ou après trop d'échecs consécutifs. Renvoie True si l'abonnement a été supprimé."""
    with _lock, _db() as c:
        if gone:
            c.execute("DELETE FROM push_subscriptions WHERE id = ?", (subscription_id,))
            return True
        c.execute("UPDATE push_subscriptions SET fail_count = fail_count + 1 WHERE id = ?", (subscription_id,))
        row = c.execute("SELECT fail_count FROM push_subscriptions WHERE id = ?", (subscription_id,)).fetchone()
        if row and row["fail_count"] >= max_fail:
            c.execute("DELETE FROM push_subscriptions WHERE id = ?", (subscription_id,))
            return True
    return False


# ── Droits d'accès : abonnement et essai (Phase 5) ───────────────────────────
# La POLITIQUE (quelle fonction est gratuite, jusqu'à quel horizon) vit dans access.py ;
# ici, uniquement le stockage. Un droit n'est JAMAIS écrit dans users.prefs.
def _claim_hash(email: str) -> str:
    """Empreinte de l'e-mail normalisé — la seule chose qu'on garde après la suppression
    d'un compte, pour que l'essai ne se renouvelle pas en recréant un compte."""
    return hashlib.sha256(f"trial:{email.strip().lower()}".encode("utf-8")).hexdigest()


def _entitlement_view(row: sqlite3.Row | None) -> dict[str, Any] | None:
    if row is None:
        return None
    exp = row["expires_utc"]
    active = row["status"] == "active" and (not exp or exp > _now_iso())
    return {
        "plan": row["plan"], "source": row["source"], "status": row["status"],
        "started_utc": row["started_utc"], "expires_utc": exp,
        "updated_utc": row["updated_utc"], "external_ref": row["external_ref"],
        "active": active,
    }


def entitlement_for(user_id: str) -> dict[str, Any] | None:
    """Droit du compte, ou None s'il n'en a jamais eu. `active` dit s'il vaut aujourd'hui."""
    if not user_id:
        return None
    with _db() as c:
        row = c.execute("SELECT * FROM entitlements WHERE user_id = ?", (user_id,)).fetchone()
    return _entitlement_view(row)


def is_entitled(user_id: str) -> bool:
    """Le compte a-t-il un droit ACTIF (abonnement en cours ou essai non expiré) ?"""
    ent = entitlement_for(user_id)
    return bool(ent and ent["active"])


def grant_entitlement(user_id: str, source: str, *, days: float | None = None,
                      plan: str = "sub", external_ref: str | None = None) -> dict[str, Any]:
    """Ouvre (ou prolonge) un droit. `days=None` = sans échéance — réservé à un abonnement
    récurrent vivant, dont c'est le prestataire qui dira l'arrêt via son webhook signé."""
    if not user_id:
        raise AccountError("Compte inconnu.")
    now = _now_iso()
    expires = None
    if days is not None:
        expires = datetime.fromtimestamp(time.time() + float(days) * 86400,
                                         timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    with _lock, _db() as c:
        if c.execute("SELECT 1 FROM users WHERE id = ?", (user_id,)).fetchone() is None:
            raise AccountError("Compte inconnu.")
        c.execute(
            "INSERT INTO entitlements (user_id, plan, source, status, started_utc, expires_utc,"
            " updated_utc, external_ref) VALUES (?,?,?,'active',?,?,?,?)"
            " ON CONFLICT(user_id) DO UPDATE SET plan=excluded.plan, source=excluded.source,"
            " status='active', expires_utc=excluded.expires_utc, updated_utc=excluded.updated_utc,"
            " external_ref=COALESCE(excluded.external_ref, entitlements.external_ref)",
            (user_id, plan, source, now, expires, now, external_ref),
        )
        row = c.execute("SELECT * FROM entitlements WHERE user_id = ?", (user_id,)).fetchone()
    return _entitlement_view(row)


def revoke_entitlement(user_id: str) -> dict[str, Any] | None:
    """Coupe le droit sans effacer la trace (on garde de quoi comprendre l'historique)."""
    now = _now_iso()
    with _lock, _db() as c:
        c.execute("UPDATE entitlements SET status = 'canceled', updated_utc = ? WHERE user_id = ?",
                  (now, user_id))
        row = c.execute("SELECT * FROM entitlements WHERE user_id = ?", (user_id,)).fetchone()
    return _entitlement_view(row)


def trial_claimed(email: str) -> bool:
    """L'essai a-t-il déjà été pris par cette adresse — même si le compte a été supprimé
    depuis ? C'est tout l'intérêt de la table."""
    email = str(email or "").strip()
    if not email:
        return False
    with _db() as c:
        return c.execute("SELECT 1 FROM trial_claims WHERE claim_hash = ?",
                         (_claim_hash(email),)).fetchone() is not None


def start_trial(user_id: str, email: str, days: float | None = None) -> dict[str, Any]:
    """Démarre l'essai de 7 jours. Verrouillé sur l'ADRESSE E-MAIL, pas sur le compte :
    sans ça, il suffit de recréer un compte pour recommencer. Une empreinte est conservée
    après suppression du compte — à mentionner dans la page confidentialité le jour de
    l'ouverture. Le passage à une empreinte de moyen de paiement (plus solide encore,
    mais impossible sans prestataire) sera une colonne de plus, pas une refonte."""
    email = str(email or "").strip()
    if not email:
        raise AccountError("Un e-mail est nécessaire pour démarrer l'essai.")
    if days is None:
        days = access.TRIAL_DAYS
    if trial_claimed(email):
        raise AccountError("L'essai a déjà été utilisé avec cette adresse e-mail.")
    ent = grant_entitlement(user_id, "trial", days=days)
    with _lock, _db() as c:
        c.execute("INSERT OR IGNORE INTO trial_claims (claim_hash, claimed_utc, user_id) VALUES (?,?,?)",
                  (_claim_hash(email), _now_iso(), user_id))
    return ent


def entitlement_stats() -> dict[str, Any]:
    """Compteurs pour la télémétrie admin (droits d'accès)."""
    now = _now_iso()
    with _db() as c:
        rows = c.execute("SELECT source, status, expires_utc FROM entitlements").fetchall()
        claims = c.execute("SELECT COUNT(*) AS n FROM trial_claims").fetchone()["n"]
    active = [r for r in rows if r["status"] == "active" and (not r["expires_utc"] or r["expires_utc"] > now)]
    return {
        "total": len(rows),
        "active": len(active),
        "active_trials": sum(1 for r in active if r["source"] == "trial"),
        "active_paid": sum(1 for r in active if r["source"] != "trial"),
        "expired_or_canceled": len(rows) - len(active),
        "trials_ever_claimed": claims,
    }


def push_stats() -> dict[str, Any]:
    """Compteurs pour la télémétrie admin (abonnements push)."""
    with _db() as c:
        subs = c.execute("SELECT COUNT(*) AS n FROM push_subscriptions").fetchone()["n"]
        users = c.execute("SELECT COUNT(DISTINCT user_id) AS n FROM push_subscriptions").fetchone()["n"]
        depts = c.execute("SELECT COUNT(DISTINCT dept) AS n FROM push_departments").fetchone()["n"]
    return {"subscriptions": subs, "users": users, "departments_watched": depts}


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

    # ── Push (Phase 4) : abonnements Web Push ──
    sub = save_push_subscription(u2["id"], "https://push.example/ep1", "p256key", "authkey", ["69", "01", "69"])
    check("save_push_subscription dédoublonne les dépts", sub["departments"] == ["69", "01"])
    check("push_subscriptions_for_user", len(push_subscriptions_for_user(u2["id"])) == 1)
    check("watched_departments", watched_departments() == {"69", "01"})
    check("push_subscribers_for_dept(69)", len(push_subscribers_for_dept("69")) == 1)
    save_push_subscription(u2["id"], "https://push.example/ep1", "p256key", "authkey", ["34"])
    check("upsert par endpoint (pas de doublon d'appareil)", len(push_subscriptions_for_user(u2["id"])) == 1)
    check("dépts remplacés au ré-abonnement", watched_departments() == {"34"})
    check("push_stats", push_stats()["subscriptions"] == 1 and push_stats()["users"] == 1)
    check("mark_push_failure(gone) supprime l'abonnement", mark_push_failure(sub["id"], gone=True) is True)
    check("abonnement supprimé", push_subscriptions_for_user(u2["id"]) == [])
    save_push_subscription(u2["id"], "https://push.example/ep2", "k", "a", ["75"])
    delete_user(u2["id"])
    check("push : cascade RGPD à la suppression du compte", push_subscribers_for_dept("75") == [])

    # ── Droits d'accès (Phase 5) : abonnement et essai ──
    print("=== droits d'accès (Phase 5) ===")
    ue = register_local("essai@example.com", "MotDePasse42")
    check("compte neuf = aucun droit", entitlement_for(ue["id"]) is None and not is_entitled(ue["id"]))
    check("droit inexistant sur un id inconnu", entitlement_for("inconnu") is None)

    g = grant_entitlement(ue["id"], "manual")
    check("droit accordé sans échéance → actif", g["active"] and g["expires_utc"] is None)
    check("is_entitled suit", is_entitled(ue["id"]) is True)
    r = revoke_entitlement(ue["id"])
    check("révocation coupe le droit", r["active"] is False and r["status"] == "canceled")
    check("révocation garde la trace", entitlement_for(ue["id"]) is not None)

    t = start_trial(ue["id"], "essai@example.com")
    check("essai démarré → actif", t["active"] and t["source"] == "trial")
    check("essai daté à 7 jours", t["expires_utc"] is not None and t["expires_utc"] > _now_iso())
    try:
        start_trial(ue["id"], "essai@example.com"); check("essai non renouvelable", False)
    except AccountError:
        check("essai non renouvelable sur la même adresse", True)
    check("casse et espaces ignorés dans l'adresse", trial_claimed("  Essai@Example.COM  ") is True)
    check("adresse jamais vue → essai disponible", trial_claimed("jamais-vu@example.com") is False)
    try:
        start_trial(ue["id"], ""); check("essai sans e-mail refusé", False)
    except AccountError:
        check("essai sans e-mail refusé", True)

    check("droit expiré = inactif", grant_entitlement(ue["id"], "manual", days=-1)["active"] is False)
    try:
        grant_entitlement("compte-fantome", "manual"); check("droit sur compte inexistant refusé", False)
    except AccountError:
        check("droit sur compte inexistant refusé", True)

    # Le piège annoncé par l'audit : un droit ne doit JAMAIS être atteignable via prefs,
    # que l'utilisateur peut patcher lui-même (/api/account/prefs).
    forge = set_prefs(ue["id"], {"entitled": True, "plan": "sub", "default_map": "chase"})
    check("prefs ne peut pas forger un droit", "entitled" not in forge["prefs"] and "plan" not in forge["prefs"])
    check("prefs légitimes toujours acceptées", forge["prefs"].get("default_map") == "chase")

    st_ent = entitlement_stats()
    check("entitlement_stats compte les essais réclamés", st_ent["trials_ever_claimed"] >= 1)
    check("entitlement_stats : droit expiré non compté actif", st_ent["active"] == 0 and st_ent["total"] == 1)

    # RGPD : le droit tombe avec le compte, l'empreinte d'essai SURVIT (sinon l'essai se
    # renouvelle en recréant un compte) — c'est le seul reliquat volontaire.
    delete_user(ue["id"])
    check("droits : cascade RGPD à la suppression du compte", entitlement_for(ue["id"]) is None)
    check("empreinte d'essai conservée après suppression (anti-recyclage)",
          trial_claimed("essai@example.com") is True)
    ue2 = register_local("essai@example.com", "MotDePasse42")
    try:
        start_trial(ue2["id"], "essai@example.com")
        check("recréer le compte ne redonne pas l'essai", False)
    except AccountError:
        check("recréer le compte ne redonne pas l'essai", True)

    print(f"\n{ok['n'] - ok['fail']}/{ok['n']} OK" + ("" if ok["fail"] == 0 else f" — {ok['fail']} ÉCHEC(S)"))
    raise SystemExit(1 if ok["fail"] else 0)
