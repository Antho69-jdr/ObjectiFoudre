"""mailer.py — Envoi d'e-mails transactionnels (vérification, réinitialisation).

Agnostique du fournisseur : SMTP standard (Brevo, Mailjet, SendGrid… fournissent tous
des identifiants SMTP). Configuré par variables d'environnement ; si non configuré,
l'envoi est un no-op « propre » (renvoie False) — l'inscription reste possible, et en
local le lien est écrit dans les logs pour tester sans serveur d'e-mail.

Variables :
  OBJECTIFOUDRE_SMTP_HOST   hôte SMTP (ex. smtp-relay.brevo.com)         [requis pour envoyer]
  OBJECTIFOUDRE_SMTP_PORT   port (défaut 587)
  OBJECTIFOUDRE_SMTP_USER   identifiant SMTP
  OBJECTIFOUDRE_SMTP_PASS   mot de passe / clé SMTP
  OBJECTIFOUDRE_SMTP_FROM   expéditeur (défaut "ObjectiFoudre <no-reply@objectifoudre.com>")
  OBJECTIFOUDRE_SMTP_SSL    "1" = SMTPS direct (port 465) ; sinon STARTTLS (587)
"""
from __future__ import annotations

import logging
import os
import smtplib
import ssl
from email.message import EmailMessage
from email.utils import formataddr, parseaddr

log = logging.getLogger("objectifoudre.mailer")

_DEFAULT_FROM = "ObjectiFoudre <no-reply@objectifoudre.com>"


def _cfg() -> dict[str, str]:
    return {
        "host": os.environ.get("OBJECTIFOUDRE_SMTP_HOST", "").strip(),
        "port": os.environ.get("OBJECTIFOUDRE_SMTP_PORT", "587").strip() or "587",
        "user": os.environ.get("OBJECTIFOUDRE_SMTP_USER", "").strip(),
        "password": os.environ.get("OBJECTIFOUDRE_SMTP_PASS", ""),
        "from": os.environ.get("OBJECTIFOUDRE_SMTP_FROM", "").strip() or _DEFAULT_FROM,
        "ssl": os.environ.get("OBJECTIFOUDRE_SMTP_SSL", "").strip() in ("1", "true", "yes"),
    }


def configured() -> bool:
    """True si le SMTP est configuré (au moins un hôte)."""
    return bool(_cfg()["host"])


def send_email(to: str, subject: str, text: str, html: str | None = None) -> bool:
    """Envoie un e-mail (texte + HTML optionnel). Non-fatal : renvoie False en cas d'échec
    ou de configuration absente. En dev (non configuré), écrit le contenu dans les logs."""
    to = (to or "").strip()
    if not to:
        return False
    cfg = _cfg()
    if not cfg["host"]:
        log.warning("[mailer] SMTP non configuré — e-mail NON envoyé à %s. Sujet: %s\n%s",
                    to, subject, text)
        return False

    msg = EmailMessage()
    from_name, from_addr = parseaddr(cfg["from"])
    msg["From"] = formataddr((from_name or "ObjectiFoudre", from_addr or cfg["from"]))
    msg["To"] = to
    msg["Subject"] = subject
    msg.set_content(text)
    if html:
        msg.add_alternative(html, subtype="html")

    try:
        port = int(cfg["port"])
    except ValueError:
        port = 587
    try:
        if cfg["ssl"] or port == 465:
            ctx = ssl.create_default_context()
            with smtplib.SMTP_SSL(cfg["host"], port, timeout=15, context=ctx) as s:
                if cfg["user"]:
                    s.login(cfg["user"], cfg["password"])
                s.send_message(msg)
        else:
            with smtplib.SMTP(cfg["host"], port, timeout=15) as s:
                s.ehlo()
                try:
                    s.starttls(context=ssl.create_default_context())
                    s.ehlo()
                except smtplib.SMTPException:
                    pass  # serveur sans STARTTLS (rare) : on continue en clair (réseau interne)
                if cfg["user"]:
                    s.login(cfg["user"], cfg["password"])
                s.send_message(msg)
        return True
    except Exception as exc:  # noqa: BLE001 - jamais fatal pour la requête HTTP
        log.warning("[mailer] échec d'envoi à %s : %s", to, exc)
        return False
