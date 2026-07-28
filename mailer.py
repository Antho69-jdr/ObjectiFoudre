"""mailer.py — Envoi d'e-mails transactionnels (vérification, réinitialisation).

Deux tuyaux, dans cet ordre de priorité :
  1. API HTTP Brevo (HTTPS/443) si OBJECTIFOUDRE_BREVO_API_KEY est défini.
     → recommandé en prod : Railway (et beaucoup de PaaS) BLOQUENT les ports SMTP
       sortants (25/465/587), donc l'API HTTP est le seul tuyau fiable.
  2. SMTP standard (Brevo, Mailjet, SendGrid…) sinon, via OBJECTIFOUDRE_SMTP_*.

Non-fatal : si rien n'est configuré, l'envoi est un no-op « propre » (renvoie False) — en
local le contenu est écrit dans les logs pour tester sans serveur d'e-mail.

Variables :
  OBJECTIFOUDRE_BREVO_API_KEY   clé API Brevo v3 (SMTP & API → Clés API)   [tuyau prioritaire]
  OBJECTIFOUDRE_SMTP_FROM       expéditeur (défaut "ObjectiFoudre <no-reply@objectifoudre.com>")
  OBJECTIFOUDRE_SMTP_HOST       hôte SMTP (ex. smtp-relay.brevo.com)        [fallback SMTP]
  OBJECTIFOUDRE_SMTP_PORT       port (défaut 587)
  OBJECTIFOUDRE_SMTP_USER       identifiant SMTP
  OBJECTIFOUDRE_SMTP_PASS       mot de passe / clé SMTP
  OBJECTIFOUDRE_SMTP_SSL        "1" = SMTPS direct (465) ; sinon STARTTLS (587)
"""
from __future__ import annotations

import json
import logging
import os
import smtplib
import ssl
import urllib.error
import urllib.request
from email.message import EmailMessage
from email.utils import formataddr, parseaddr

log = logging.getLogger("objectifoudre.mailer")

_DEFAULT_FROM = "ObjectiFoudre <no-reply@objectifoudre.com>"
_BREVO_API_URL = "https://api.brevo.com/v3/smtp/email"


def _from() -> tuple[str, str]:
    """(nom, adresse) de l'expéditeur, depuis OBJECTIFOUDRE_SMTP_FROM."""
    raw = os.environ.get("OBJECTIFOUDRE_SMTP_FROM", "").strip() or _DEFAULT_FROM
    name, addr = parseaddr(raw)
    return (name or "ObjectiFoudre", addr or raw)


def _brevo_key() -> str:
    return os.environ.get("OBJECTIFOUDRE_BREVO_API_KEY", "").strip()


def _smtp_host() -> str:
    return os.environ.get("OBJECTIFOUDRE_SMTP_HOST", "").strip()


def configured() -> bool:
    """True si un tuyau d'envoi est configuré (API Brevo OU SMTP)."""
    return bool(_brevo_key() or _smtp_host())


def send_email(to: str, subject: str, text: str, html: str | None = None) -> bool:
    """Envoie un e-mail. API Brevo en priorité, sinon SMTP. Non-fatal : renvoie False
    en cas d'échec ou d'absence de configuration (le contenu est alors loggé en dev)."""
    to = (to or "").strip()
    if not to:
        return False
    if _brevo_key():
        return _send_via_brevo_api(to, subject, text, html)
    if _smtp_host():
        return _send_via_smtp(to, subject, text, html)
    log.warning("[mailer] aucun tuyau configuré — e-mail NON envoyé à %s. Sujet: %s\n%s", to, subject, text)
    return False


# ── API HTTP Brevo (HTTPS/443 — insensible au blocage SMTP de Railway) ────────
def _send_via_brevo_api(to: str, subject: str, text: str, html: str | None) -> bool:
    name, addr = _from()
    payload: dict = {
        "sender": {"name": name, "email": addr},
        "to": [{"email": to}],
        "subject": subject,
        "textContent": text,
    }
    if html:
        payload["htmlContent"] = html
    data = json.dumps(payload).encode("utf-8")
    req = urllib.request.Request(_BREVO_API_URL, data=data, method="POST", headers={
        "api-key": _brevo_key(),
        "Content-Type": "application/json",
        "Accept": "application/json",
    })
    try:
        with urllib.request.urlopen(req, timeout=15) as r:
            return 200 <= r.status < 300
    except urllib.error.HTTPError as exc:
        body = ""
        try:
            body = exc.read().decode("utf-8", "replace")[:300]
        except Exception:  # noqa: BLE001
            pass
        log.warning("[mailer] API Brevo → échec à %s : HTTP %s %s", to, exc.code, body)
        return False
    except Exception as exc:  # noqa: BLE001 - jamais fatal pour la requête HTTP
        log.warning("[mailer] API Brevo → échec à %s : %s", to, exc)
        return False


# ── SMTP standard (fallback ; ne marche pas si le PaaS bloque le port SMTP) ────
def _send_via_smtp(to: str, subject: str, text: str, html: str | None) -> bool:
    msg = EmailMessage()
    name, addr = _from()
    msg["From"] = formataddr((name, addr))
    msg["To"] = to
    msg["Subject"] = subject
    msg.set_content(text)
    if html:
        msg.add_alternative(html, subtype="html")

    host = _smtp_host()
    try:
        port = int(os.environ.get("OBJECTIFOUDRE_SMTP_PORT", "587").strip() or "587")
    except ValueError:
        port = 587
    user = os.environ.get("OBJECTIFOUDRE_SMTP_USER", "").strip()
    password = os.environ.get("OBJECTIFOUDRE_SMTP_PASS", "")
    use_ssl = os.environ.get("OBJECTIFOUDRE_SMTP_SSL", "").strip() in ("1", "true", "yes")
    try:
        if use_ssl or port == 465:
            with smtplib.SMTP_SSL(host, port, timeout=15, context=ssl.create_default_context()) as s:
                if user:
                    s.login(user, password)
                s.send_message(msg)
        else:
            with smtplib.SMTP(host, port, timeout=15) as s:
                s.ehlo()
                try:
                    s.starttls(context=ssl.create_default_context())
                    s.ehlo()
                except smtplib.SMTPException:
                    pass
                if user:
                    s.login(user, password)
                s.send_message(msg)
        return True
    except Exception as exc:  # noqa: BLE001 - jamais fatal pour la requête HTTP
        log.warning("[mailer] SMTP → échec à %s : %s", to, exc)
        return False
