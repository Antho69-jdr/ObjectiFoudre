"""forum.py — Forum communautaire (catégories thématiques → sujets → messages).

Couche données SQLite ISOLÉE (pattern accounts.py) : base `forum.db` sur le volume
durable (OBJECTIFOUDRE_HISTORY_DIR). N'importe RIEN de app.py ni d'accounts.py
(testable seul). app.py branche l'auth (session → author_id compte) et résout les
pseudos publics (accounts.pseudos_for) ; ce module ne stocke qu'un `author_id` opaque.

Schéma :
  categories(id, position, emoji, name, description, tint)     ← thèmes FIXES (seed)
  topics(id, category_id, author_id, title, created/updated/last_post_utc,
         reply_count, view_count, pinned, locked, status)      ← status visible|hidden
  posts(id, topic_id, author_id, body, created/updated_utc, is_op, status, like_count)
  post_likes(post_id, user_id, created_utc, PK(post_id,user_id))

Modération (décidée avec Anthony) = POST-modération :
  - un compte vérifié poste et son message s'affiche IMMÉDIATEMENT ;
  - filtre AUTO à la création : anti-spam grossier (blocklist + trop de liens),
    caractères de contrôle, longueurs bornées, rate-limit par auteur ;
  - MANUELLE admin (secret serveur, côté app.py) : épingler / verrouiller /
    masquer un sujet, masquer un message. L'auteur peut supprimer les siens.

Seuls les sujets/messages `visible` sont exposés. La suppression est douce
(status='deleted'/'hidden') — rien n'est effacé physiquement (traçabilité).
"""
from __future__ import annotations

import os
import re
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

# --- Bornes de validation ---------------------------------------------------
_TITLE_MIN = 4
_TITLE_MAX = 140
_BODY_MIN = 1
_BODY_MAX = 5000
_MAX_LINKS = 3                     # au-delà = spam de liens → refus
_RATE_TOPICS_MAX = 5              # sujets max par auteur…
_RATE_POSTS_MAX = 20             # messages max par auteur…
_RATE_WINDOW_S = 3600.0          # …par heure glissante

# signaux de spam grossiers (blocklist volontairement minimale) + liens + contrôle
_SPAM_RE = re.compile(r"\b(viagra|cialis|casino|porn|xxx)\b", re.I)
_URL_RE = re.compile(r"https?://|www\.", re.I)
_CTRL_RE = re.compile(r"[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]")   # garde \t \n \r
_WS_RE = re.compile(r"[ \t ]+")

# Thèmes FIXES (validés avec Anthony). tint = nom de var CSS (liseré de carte).
_SEED_CATEGORIES = [
    ("chasse",  0, "⛈️", "Chasse d'orages",
     "Coordination en direct, comptes rendus, lecture des cellules", "var(--accent)"),
    ("photo",   1, "📷", "Photo & matériel",
     "Réglages foudre, boîtiers, trépieds, post-traitement", "var(--prob-3)"),
    ("ciel",    2, "⭐", "Ciel nocturne",
     "Observation d'étoiles, spots sombres, Lune & pollution lumineuse", "var(--accent-2)"),
    ("spots",   3, "📍", "Spots & repérage",
     "Bons lieux, accès, horizons dégagés, sécurité", "var(--prob-0)"),
    ("modeles", 4, "🛰️", "Prévision & modèles",
     "AROME, ECMWF, lecture des cartes de risque", "var(--accent-strong)"),
    ("commu",   5, "💬", "La communauté",
     "Présentations, retours sur l'app, hors-sujet", "var(--text-dim)"),
]
_CATEGORY_IDS = {c[0] for c in _SEED_CATEGORIES}


class ForumError(ValueError):
    """Refus « métier » (validation, verrou, autorisation) — message utilisateur."""


def _now_iso() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def _db_path() -> Path:
    env = os.environ.get("OBJECTIFOUDRE_FORUM_FILE")
    if env:
        return Path(env).expanduser()
    base = os.environ.get("OBJECTIFOUDRE_HISTORY_DIR") or (HERE / "history")
    return Path(base).expanduser() / "forum.db"


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
            CREATE TABLE IF NOT EXISTS categories (
                id          TEXT PRIMARY KEY,
                position    INTEGER NOT NULL,
                emoji       TEXT NOT NULL,
                name        TEXT NOT NULL,
                description TEXT NOT NULL,
                tint        TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS topics (
                id            TEXT PRIMARY KEY,
                category_id   TEXT NOT NULL REFERENCES categories(id),
                author_id     TEXT NOT NULL,
                title         TEXT NOT NULL,
                created_utc   TEXT NOT NULL,
                updated_utc   TEXT NOT NULL,
                last_post_utc TEXT NOT NULL,
                reply_count   INTEGER NOT NULL DEFAULT 0,
                view_count    INTEGER NOT NULL DEFAULT 0,
                pinned        INTEGER NOT NULL DEFAULT 0,
                locked        INTEGER NOT NULL DEFAULT 0,
                status        TEXT NOT NULL DEFAULT 'visible'
            );
            CREATE INDEX IF NOT EXISTS idx_topics_cat
                ON topics (category_id, status, pinned DESC, last_post_utc DESC);
            CREATE INDEX IF NOT EXISTS idx_topics_author ON topics (author_id, created_utc);
            CREATE TABLE IF NOT EXISTS posts (
                id          TEXT PRIMARY KEY,
                topic_id    TEXT NOT NULL REFERENCES topics(id) ON DELETE CASCADE,
                author_id   TEXT NOT NULL,
                body        TEXT NOT NULL,
                created_utc TEXT NOT NULL,
                updated_utc TEXT NOT NULL,
                is_op       INTEGER NOT NULL DEFAULT 0,
                status      TEXT NOT NULL DEFAULT 'visible',
                like_count  INTEGER NOT NULL DEFAULT 0
            );
            CREATE INDEX IF NOT EXISTS idx_posts_topic ON posts (topic_id, status, created_utc);
            CREATE INDEX IF NOT EXISTS idx_posts_author ON posts (author_id, created_utc);
            CREATE TABLE IF NOT EXISTS post_likes (
                post_id     TEXT NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
                user_id     TEXT NOT NULL,
                created_utc TEXT NOT NULL,
                PRIMARY KEY (post_id, user_id)
            );
            """
        )
        # Seed / mise à jour des thèmes fixes (libellés modifiables sans perte de données).
        for cid, pos, emoji, name, desc, tint in _SEED_CATEGORIES:
            c.execute(
                """INSERT INTO categories (id, position, emoji, name, description, tint)
                   VALUES (?, ?, ?, ?, ?, ?)
                   ON CONFLICT(id) DO UPDATE SET
                     position=excluded.position, emoji=excluded.emoji, name=excluded.name,
                     description=excluded.description, tint=excluded.tint""",
                (cid, pos, emoji, name, desc, tint),
            )


# --- Validation -------------------------------------------------------------
def _clean_title(raw: Any) -> str:
    t = _WS_RE.sub(" ", _CTRL_RE.sub("", str(raw or "")).replace("\n", " ")).strip()
    if len(t) < _TITLE_MIN:
        raise ForumError(f"Le titre doit faire au moins {_TITLE_MIN} caractères.")
    if len(t) > _TITLE_MAX:
        raise ForumError(f"Le titre est trop long (max {_TITLE_MAX}).")
    return t


def _clean_body(raw: Any) -> str:
    b = _CTRL_RE.sub("", str(raw or "")).strip()
    # normalise les fins de ligne, borne les sauts de ligne multiples
    b = re.sub(r"\r\n?", "\n", b)
    b = re.sub(r"\n{3,}", "\n\n", b)
    if len(b) < _BODY_MIN:
        raise ForumError("Le message est vide.")
    if len(b) > _BODY_MAX:
        raise ForumError(f"Le message est trop long (max {_BODY_MAX} caractères).")
    if _SPAM_RE.search(b):
        raise ForumError("Message refusé (contenu indésirable détecté).")
    if len(_URL_RE.findall(b)) > _MAX_LINKS:
        raise ForumError("Trop de liens — message refusé par le filtre anti-spam.")
    return b


def _rate_ok(c: sqlite3.Connection, table: str, author_id: str, limit: int) -> bool:
    since = datetime.now(timezone.utc).timestamp() - _RATE_WINDOW_S
    since_iso = datetime.fromtimestamp(since, timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    n = c.execute(
        f"SELECT COUNT(*) FROM {table} WHERE author_id = ? AND created_utc >= ?",
        (author_id, since_iso),
    ).fetchone()[0]
    return n < limit


# --- Vues -------------------------------------------------------------------
def _topic_view(r: sqlite3.Row) -> dict[str, Any]:
    return {
        "id": r["id"], "category_id": r["category_id"], "author_id": r["author_id"],
        "title": r["title"], "created_utc": r["created_utc"], "last_post_utc": r["last_post_utc"],
        "reply_count": r["reply_count"], "view_count": r["view_count"],
        "pinned": bool(r["pinned"]), "locked": bool(r["locked"]),
    }


def _post_view(r: sqlite3.Row) -> dict[str, Any]:
    return {
        "id": r["id"], "topic_id": r["topic_id"], "author_id": r["author_id"],
        "body": r["body"], "created_utc": r["created_utc"], "updated_utc": r["updated_utc"],
        "is_op": bool(r["is_op"]), "like_count": r["like_count"],
    }


# --- Lecture ----------------------------------------------------------------
def list_categories() -> list[dict[str, Any]]:
    """Thèmes + compteurs (sujets/messages visibles) + dernière activité (author_id brut)."""
    out: list[dict[str, Any]] = []
    with _db() as c:
        cats = c.execute("SELECT * FROM categories ORDER BY position").fetchall()
        for cat in cats:
            cid = cat["id"]
            topic_count = c.execute(
                "SELECT COUNT(*) FROM topics WHERE category_id = ? AND status = 'visible'",
                (cid,)).fetchone()[0]
            msg_count = c.execute(
                """SELECT COUNT(*) FROM posts p JOIN topics t ON t.id = p.topic_id
                   WHERE t.category_id = ? AND t.status = 'visible' AND p.status = 'visible'""",
                (cid,)).fetchone()[0]
            last = c.execute(
                """SELECT p.author_id, p.created_utc
                   FROM posts p JOIN topics t ON t.id = p.topic_id
                   WHERE t.category_id = ? AND t.status = 'visible' AND p.status = 'visible'
                   ORDER BY p.created_utc DESC LIMIT 1""",
                (cid,)).fetchone()
            out.append({
                "id": cid, "emoji": cat["emoji"], "name": cat["name"],
                "description": cat["description"], "tint": cat["tint"],
                "topic_count": topic_count, "message_count": msg_count,
                "last_author_id": last["author_id"] if last else None,
                "last_post_utc": last["created_utc"] if last else None,
            })
    return out


def recent_activity(limit: int = 8) -> list[dict[str, Any]]:
    """Derniers messages (tous thèmes) pour le fil d'activité de l'accueil."""
    limit = max(1, min(30, int(limit)))
    with _db() as c:
        rows = c.execute(
            """SELECT p.author_id, p.created_utc, p.is_op,
                      t.id AS topic_id, t.title, t.category_id
               FROM posts p JOIN topics t ON t.id = p.topic_id
               WHERE p.status = 'visible' AND t.status = 'visible'
               ORDER BY p.created_utc DESC LIMIT ?""",
            (limit,)).fetchall()
    return [{
        "author_id": r["author_id"], "created_utc": r["created_utc"], "is_op": bool(r["is_op"]),
        "topic_id": r["topic_id"], "topic_title": r["title"], "category_id": r["category_id"],
    } for r in rows]


def list_topics(category_id: str, limit: int = 60) -> list[dict[str, Any]]:
    """Sujets visibles d'un thème (épinglés d'abord, puis activité récente).
    Ajoute `last_author_id` (dernier posteur) pour l'affichage."""
    if category_id not in _CATEGORY_IDS:
        raise ForumError("Thème inconnu.")
    limit = max(1, min(200, int(limit)))
    with _db() as c:
        rows = c.execute(
            """SELECT * FROM topics WHERE category_id = ? AND status = 'visible'
               ORDER BY pinned DESC, last_post_utc DESC LIMIT ?""",
            (category_id, limit)).fetchall()
        out = []
        for r in rows:
            v = _topic_view(r)
            last = c.execute(
                """SELECT author_id FROM posts WHERE topic_id = ? AND status = 'visible'
                   ORDER BY created_utc DESC LIMIT 1""", (r["id"],)).fetchone()
            v["last_author_id"] = last["author_id"] if last else r["author_id"]
            out.append(v)
    return out


def get_category(category_id: str) -> dict[str, Any] | None:
    with _db() as c:
        r = c.execute("SELECT * FROM categories WHERE id = ?", (category_id,)).fetchone()
    if not r:
        return None
    return {"id": r["id"], "emoji": r["emoji"], "name": r["name"],
            "description": r["description"], "tint": r["tint"]}


def get_topic(topic_id: str, *, bump_view: bool = False) -> dict[str, Any] | None:
    """Sujet visible + ses messages visibles (ordre chrono). None si absent/masqué."""
    with _lock if bump_view else _nullctx(), _db() as c:
        t = c.execute("SELECT * FROM topics WHERE id = ? AND status = 'visible'",
                      (topic_id,)).fetchone()
        if not t:
            return None
        if bump_view:
            c.execute("UPDATE topics SET view_count = view_count + 1 WHERE id = ?", (topic_id,))
        posts = c.execute(
            """SELECT * FROM posts WHERE topic_id = ? AND status = 'visible'
               ORDER BY created_utc ASC, is_op DESC""", (topic_id,)).fetchall()
    topic = _topic_view(t)
    topic["view_count"] = topic["view_count"] + (1 if bump_view else 0)
    topic["posts"] = [_post_view(p) for p in posts]
    return topic


@contextmanager
def _nullctx() -> Iterator[None]:
    yield None


def liked_post_ids(user_id: str, post_ids: list[str]) -> set[str]:
    """Sous-ensemble des post_ids que `user_id` a aimés (pour marquer 👍 côté client)."""
    ids = [str(i) for i in (post_ids or []) if i]
    if not user_id or not ids:
        return set()
    out: set[str] = set()
    with _db() as c:
        for i in range(0, len(ids), 400):
            chunk = ids[i:i + 400]
            ph = ",".join("?" * len(chunk))
            for row in c.execute(
                f"SELECT post_id FROM post_likes WHERE user_id = ? AND post_id IN ({ph})",
                    [user_id, *chunk]):
                out.add(row["post_id"])
    return out


# --- Écriture ---------------------------------------------------------------
def create_topic(author_id: str, category_id: str, title: str, body: str) -> dict[str, Any]:
    if not author_id:
        raise ForumError("Connexion requise.")
    if category_id not in _CATEGORY_IDS:
        raise ForumError("Thème inconnu.")
    title = _clean_title(title)
    body = _clean_body(body)
    now = _now_iso()
    tid = uuid.uuid4().hex
    pid = uuid.uuid4().hex
    with _lock, _db() as c:
        if not _rate_ok(c, "topics", author_id, _RATE_TOPICS_MAX):
            raise ForumError("Trop de sujets créés récemment — réessayez plus tard.")
        c.execute(
            """INSERT INTO topics (id, category_id, author_id, title, created_utc, updated_utc,
                                   last_post_utc, reply_count, view_count, pinned, locked, status)
               VALUES (?, ?, ?, ?, ?, ?, ?, 0, 0, 0, 0, 'visible')""",
            (tid, category_id, author_id, title, now, now, now))
        c.execute(
            """INSERT INTO posts (id, topic_id, author_id, body, created_utc, updated_utc,
                                  is_op, status, like_count)
               VALUES (?, ?, ?, ?, ?, ?, 1, 'visible', 0)""",
            (pid, tid, author_id, body, now, now))
    return {"topic_id": tid, "post_id": pid}


def create_post(author_id: str, topic_id: str, body: str) -> dict[str, Any]:
    if not author_id:
        raise ForumError("Connexion requise.")
    body = _clean_body(body)
    now = _now_iso()
    pid = uuid.uuid4().hex
    with _lock, _db() as c:
        t = c.execute("SELECT locked, status FROM topics WHERE id = ?", (topic_id,)).fetchone()
        if not t or t["status"] != "visible":
            raise ForumError("Sujet introuvable.")
        if t["locked"]:
            raise ForumError("Ce sujet est verrouillé.")
        if not _rate_ok(c, "posts", author_id, _RATE_POSTS_MAX):
            raise ForumError("Trop de messages récents — réessayez plus tard.")
        c.execute(
            """INSERT INTO posts (id, topic_id, author_id, body, created_utc, updated_utc,
                                  is_op, status, like_count)
               VALUES (?, ?, ?, ?, ?, ?, 0, 'visible', 0)""",
            (pid, topic_id, author_id, body, now, now))
        c.execute(
            """UPDATE topics SET reply_count = reply_count + 1, last_post_utc = ?, updated_utc = ?
               WHERE id = ?""", (now, now, topic_id))
    return {"post_id": pid}


def toggle_like(post_id: str, user_id: str) -> dict[str, Any]:
    if not user_id:
        raise ForumError("Connexion requise.")
    now = _now_iso()
    with _lock, _db() as c:
        p = c.execute("SELECT status FROM posts WHERE id = ?", (post_id,)).fetchone()
        if not p or p["status"] != "visible":
            raise ForumError("Message introuvable.")
        exists = c.execute(
            "SELECT 1 FROM post_likes WHERE post_id = ? AND user_id = ?",
            (post_id, user_id)).fetchone()
        if exists:
            c.execute("DELETE FROM post_likes WHERE post_id = ? AND user_id = ?", (post_id, user_id))
            liked = False
        else:
            c.execute("INSERT INTO post_likes (post_id, user_id, created_utc) VALUES (?, ?, ?)",
                      (post_id, user_id, now))
            liked = True
        count = c.execute(
            "SELECT COUNT(*) FROM post_likes WHERE post_id = ?", (post_id,)).fetchone()[0]
        c.execute("UPDATE posts SET like_count = ? WHERE id = ?", (count, post_id))
    return {"liked": liked, "like_count": count}


def delete_post(post_id: str, user_id: str, *, is_admin: bool = False) -> dict[str, Any]:
    """Suppression douce. Auteur (ou admin). Supprimer le message d'origine masque le sujet."""
    with _lock, _db() as c:
        p = c.execute("SELECT * FROM posts WHERE id = ?", (post_id,)).fetchone()
        if not p or p["status"] != "visible":
            raise ForumError("Message introuvable.")
        if not is_admin and p["author_id"] != user_id:
            raise ForumError("Vous ne pouvez supprimer que vos propres messages.")
        now = _now_iso()
        c.execute("UPDATE posts SET status = 'deleted', updated_utc = ? WHERE id = ?", (now, post_id))
        if p["is_op"]:
            c.execute("UPDATE topics SET status = 'hidden', updated_utc = ? WHERE id = ?",
                      (now, p["topic_id"]))
            return {"topic_removed": True, "topic_id": p["topic_id"]}
        c.execute(
            """UPDATE topics SET reply_count = MAX(0, reply_count - 1), updated_utc = ?
               WHERE id = ?""", (now, p["topic_id"]))
        return {"topic_removed": False, "topic_id": p["topic_id"]}


# --- Modération admin -------------------------------------------------------
def moderate_topic(topic_id: str, action: str) -> dict[str, Any]:
    """action ∈ {pin, unpin, lock, unlock, hide}. Réservé admin (contrôlé côté app.py)."""
    now = _now_iso()
    field_val = {
        "pin": ("pinned", 1), "unpin": ("pinned", 0),
        "lock": ("locked", 1), "unlock": ("locked", 0),
    }
    with _lock, _db() as c:
        t = c.execute("SELECT id FROM topics WHERE id = ?", (topic_id,)).fetchone()
        if not t:
            raise ForumError("Sujet introuvable.")
        if action == "hide":
            c.execute("UPDATE topics SET status = 'hidden', updated_utc = ? WHERE id = ?", (now, topic_id))
        elif action in field_val:
            col, val = field_val[action]
            c.execute(f"UPDATE topics SET {col} = ?, updated_utc = ? WHERE id = ?", (val, now, topic_id))
        else:
            raise ForumError("Action de modération inconnue.")
    return {"ok": True, "action": action, "topic_id": topic_id}


def moderate_post_hide(post_id: str) -> dict[str, Any]:
    """Masque un message (admin). Décrémente le compteur si ce n'est pas le message d'origine."""
    return delete_post(post_id, user_id="", is_admin=True)
