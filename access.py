"""access.py — Périmètre gratuit / payant (cartes Trello « Mode gratuit » + « Mode de paiement »).

POLITIQUE PURE, sans base de données ni FastAPI : une table de fonctions, une fonction de
décision, aucun effet de bord. La couche données est dans `accounts.py` (tables
`entitlements` / `trial_claims`), la couche HTTP dans `app.py` (dépendance `_paywall_dep`).

PÉRIMÈTRE VALIDÉ LE 2026-09-04 (dosage B, « aujourd'hui en entier ») :
  GRATUIT   carte de base J0/J+1 · fiche de cellule sur J0 · radar et foudre en direct ·
            carte des étoiles de ce soir
  OUVERT    forum, compte, confidentialité (jamais passés par ici)
  PAYANT    risque J+2→J+10 · mode chasse (suivi de cellules) · étoiles en profondeur
            (dôme, agenda, nuits à venir) · mes spots + découverte · historique et
            vérification · alertes par département

LA RÈGLE, en une phrase : gratuit = « maintenant, ici » ; payant = « plus tard, ailleurs,
plus profond — et prouvé ». Toute fonction future se range avec elle sans nouvel audit.

DEUX CONTRAINTES DU CODE, mesurées avant d'écrire une ligne (audit du 2026-09-04) :
  1. La carte gratuite et la page Risque payante passent par LA MÊME route
     `grib-france-day-compact` (data.js:187 et storm-forecast-data.js:213). Le droit se
     vérifie donc sur l'HORIZON demandé, pas sur le chemin — d'où l'argument `horizon`
     présent dès le premier jour.
  2. `/api/stargaze/tonight` colore la carte ET alimente tout le dôme, construit côté
     front (stargaze.js:743). Le verrou y est une charge utile réduite, pas un refus :
     voir `STARGAZE_DOME_FIELDS`.

DRAPEAU : tant que OBJECTIFOUDRE_PAYWALL ne vaut pas 1/on/true, `is_allowed()` répond
toujours oui et la production ne change pas d'un pixel. C'est l'étape 1 du plan en trois
temps — les droits sans le paiement, rien de visible ni d'engagé.
"""
from __future__ import annotations

import os
from dataclasses import dataclass
from typing import Any

# Gratuit quel que soit l'horizon demandé (radar en direct, étoiles de ce soir).
FREE_ALWAYS = 10 ** 6

TRIAL_DAYS = 7

# Grille arrêtée le 2026-09-04. Donnée d'affichage uniquement : AUCUN encaissement,
# aucun prestataire, aucune clé n'est câblé à ce stade.
OFFER = {
    "monthly": {"amount_eur": 3.0, "period": "month", "label": "3 €/mois, résiliable à tout moment"},
    "yearly": {"amount_eur": 30.0, "period": "year", "label": "30 €/an, paiement unique"},
    "trial_days": TRIAL_DAYS,
}


@dataclass(frozen=True)
class Feature:
    """Une fonction du produit et la profondeur à laquelle elle reste gratuite.

    `free_horizon` : None = jamais gratuite · n = gratuite pour un horizon ≤ J+n ·
    FREE_ALWAYS = gratuite sans condition d'horizon.
    """
    key: str
    label: str
    free_horizon: int | None
    why: str = ""

    @property
    def is_paid(self) -> bool:
        return self.free_horizon is None


FEATURES: dict[str, Feature] = {f.key: f for f in (
    # ── Gratuit : « maintenant, ici » ────────────────────────────────────────
    Feature("base_map", "Carte de base", 1,
            why="J0/J+1 — la France colorée, déjà bornée à J+1 côté front"),
    Feature("cell_detail", "Fiche de cellule", 0,
            why="J0 seulement — répond à « est-ce que ça va péter chez moi ce soir »"),
    Feature("radar_live", "Radar et foudre en direct", FREE_ALWAYS,
            why="l'habitude se prend pendant l'orage ; gratuit partout ailleurs de toute façon"),
    Feature("stargaze_map", "Carte des étoiles — ce soir", FREE_ALWAYS,
            why="coloration du champ et score de la nuit ; le détail horaire est retiré de la charge utile"),
    # ── Payant : « plus tard, ailleurs, plus profond — et prouvé » ───────────
    Feature("forecast_long", "Risque orageux J+2 → J+10", None,
            why="la planification, c'est ce qu'on paie"),
    Feature("chase_cells", "Mode chasse — suivi de cellules", None,
            why="ce que l'amateur sérieux vient chercher (trajectoire, lightning jump)"),
    Feature("stargaze_deep", "Étoiles en profondeur", None,
            why="dôme, agenda, nuits à venir — le versant hiver de l'abonnement"),
    Feature("spots", "Mes spots et découverte automatique", None,
            why="seule fonction à coût variable réel : IGN plafonné à 3 requêtes parallèles (horizon.py:42)"),
    Feature("history", "Historique et vérification", None,
            why="la preuve que le score dit vrai"),
    Feature("alerts", "Alertes par département", None,
            why="payant pour la promesse tenue, pas pour le coût"),
)}

# Champs de /api/stargaze/tonight qui alimentent le DÔME et lui seul — vérifié dans
# stargaze.js : les 3 étages de nébulosité ne sont lus qu'aux lignes 170-172 (construction
# du dôme), tandis que la coloration de la carte ne lit que `scores` (ligne 252). Les
# retirer d'un non-abonné ne touche donc pas la carte gratuite.
# LIMITE ASSUMÉE : c'est une charge utile réduite, pas une preuve — la nébulosité TOTALE
# reste servie (la carte en a besoin), donc un dôme approximatif reste calculable. Le
# verrou fort du versant étoiles porte sur les routes /agenda et /outlook.
STARGAZE_DOME_FIELDS = ("cloud_low", "cloud_mid", "cloud_high", "aurora")
# Lever/coucher de Lune : ajoutés au calcul POUR la modale du dôme (cf. app.py).
STARGAZE_DOME_MOON_FIELDS = ("moonrise_utc", "moonset_utc")


MODE_OFF, MODE_PREVIEW, MODE_ON = "off", "preview", "on"


def paywall_mode() -> str:
    """Trois états, lus à chaque appel (et non à l'import) pour rester testables et
    basculables sans redéploiement :

      off      (défaut)  — rien ne s'applique, à personne. État de la production.
      preview            — le périmètre ne s'applique qu'aux SESSIONS DÉSIGNÉES (un
                           administrateur s'y met lui-même depuis Outils & diagnostics).
                           Aucun visiteur n'est touché : c'est le mode pour ESSAYER en
                           vrai, sur les vraies données, sans rien mettre en service.
      on                 — le périmètre s'applique à tout le monde. C'est la mise en
                           service, pas un test.
    """
    raw = os.environ.get("OBJECTIFOUDRE_PAYWALL", "").strip().lower()
    if raw == "preview":
        return MODE_PREVIEW
    if raw in {"1", "true", "yes", "on"}:
        return MODE_ON
    return MODE_OFF


def paywall_enabled(*, preview_session: bool = False) -> bool:
    """Le périmètre s'applique-t-il à CETTE requête ? `preview_session` dit si la session
    a demandé l'aperçu (cookie posé par un administrateur)."""
    mode = paywall_mode()
    if mode == MODE_ON:
        return True
    if mode == MODE_PREVIEW:
        return bool(preview_session)
    return False


def feature(key: str) -> Feature | None:
    return FEATURES.get(key)


def is_allowed(key: str, *, horizon: int | None = 0, entitled: bool = False,
               enabled: bool | None = None) -> bool:
    """Le compte a-t-il le droit d'obtenir `key` à l'horizon demandé ?

    `horizon` : nombre de jours entre aujourd'hui et la date demandée (0 = aujourd'hui).
    `entitled` : le compte a un droit actif (abonnement ou essai en cours).
    `enabled` : force l'état du drapeau (tests) ; sinon on lit l'environnement.

    Une clé inconnue est traitée comme PAYANTE : une faute de frappe ferme la porte au
    lieu de l'ouvrir en grand.
    """
    if not (paywall_enabled() if enabled is None else enabled):
        return True
    if entitled:
        return True
    f = FEATURES.get(key)
    if f is None or f.free_horizon is None:
        return False
    h = 0 if horizon is None else int(horizon)
    if h < 0:                      # une date passée n'est pas de la prévision : c'est l'historique
        return False
    return h <= f.free_horizon


def denial(key: str, *, horizon: int | None = 0, trial_available: bool = False) -> dict[str, Any]:
    """Corps de réponse d'un refus (HTTP 402). Il porte de quoi construire le mur côté
    front : la fonction refusée, la raison, et l'offre. Jamais de détail interne."""
    f = FEATURES.get(key)
    return {
        "ok": False,
        "error": "Cette fonctionnalité fait partie de l'abonnement.",
        "paywall": {
            "feature": key,
            "label": f.label if f else key,
            "horizon": horizon,
            "reason": "trial_available" if trial_available else "subscription_required",
            "trial_days": TRIAL_DAYS if trial_available else 0,
            "offer": OFFER,
        },
    }


def public_catalog() -> list[dict[str, Any]]:
    """Le périmètre, tel qu'on peut l'afficher sur une page de tarifs ou dans la
    maintenance. Aucune donnée de compte."""
    return [
        {"key": f.key, "label": f.label, "paid": f.is_paid,
         "free_horizon": None if f.free_horizon is None else min(f.free_horizon, 10),
         "why": f.why}
        for f in FEATURES.values()
    ]


# ── Self-test ────────────────────────────────────────────────────────────────
if __name__ == "__main__":
    ok = {"n": 0, "fail": 0}

    def check(label: str, cond: bool) -> None:
        ok["n"] += 1
        ok["fail"] += 0 if cond else 1
        print(("  ✓ " if cond else "  ✗ ") + label)

    print("=== drapeau éteint : la production ne change pas ===")
    for key in FEATURES:
        if not is_allowed(key, horizon=10, entitled=False, enabled=False):
            check("drapeau éteint → %s ouvert" % key, False)
            break
    else:
        check("drapeau éteint → toutes les fonctions restent ouvertes, à tout horizon", True)

    print("=== drapeau allumé, visiteur sans droit ===")
    check("carte de base J0 gratuite", is_allowed("base_map", horizon=0, enabled=True))
    check("carte de base J+1 gratuite", is_allowed("base_map", horizon=1, enabled=True))
    check("carte de base J+2 refusée", not is_allowed("base_map", horizon=2, enabled=True))
    check("fiche de cellule J0 gratuite", is_allowed("cell_detail", horizon=0, enabled=True))
    check("fiche de cellule J+1 refusée", not is_allowed("cell_detail", horizon=1, enabled=True))
    check("radar en direct gratuit", is_allowed("radar_live", horizon=0, enabled=True))
    check("carte des étoiles gratuite", is_allowed("stargaze_map", enabled=True))
    for key in ("forecast_long", "chase_cells", "stargaze_deep", "spots", "history", "alerts"):
        check("%s refusé sans droit" % key, not is_allowed(key, horizon=0, enabled=True))
    check("date passée refusée (c'est de l'historique)", not is_allowed("base_map", horizon=-1, enabled=True))
    check("horizon absent = aujourd'hui", is_allowed("cell_detail", horizon=None, enabled=True))

    print("=== drapeau allumé, compte avec droit actif ===")
    for key in FEATURES:
        if not is_allowed(key, horizon=10, entitled=True, enabled=True):
            check("abonné → %s ouvert" % key, False)
            break
    else:
        check("abonné → tout ouvert, à tout horizon", True)

    print("=== défenses ===")
    check("clé inconnue refusée (échec fermé)", not is_allowed("nimportequoi", enabled=True))
    check("clé inconnue ouverte à l'abonné", is_allowed("nimportequoi", entitled=True, enabled=True))
    os.environ.pop("OBJECTIFOUDRE_PAYWALL", None)
    check("drapeau absent de l'environnement = éteint", not paywall_enabled())
    os.environ["OBJECTIFOUDRE_PAYWALL"] = "on"
    check("OBJECTIFOUDRE_PAYWALL=on allume", paywall_enabled())
    os.environ["OBJECTIFOUDRE_PAYWALL"] = "0"
    check("OBJECTIFOUDRE_PAYWALL=0 éteint", not paywall_enabled())
    os.environ["OBJECTIFOUDRE_PAYWALL"] = "preview"
    check("mode aperçu : rien pour une session ordinaire", not paywall_enabled())
    check("mode aperçu : appliqué à la session désignée", paywall_enabled(preview_session=True))
    check("mode aperçu reconnu", paywall_mode() == MODE_PREVIEW)
    os.environ["OBJECTIFOUDRE_PAYWALL"] = "on"
    check("mode on : appliqué même sans aperçu", paywall_enabled())
    check("mode on : l'aperçu ne change rien", paywall_enabled(preview_session=True))
    os.environ.pop("OBJECTIFOUDRE_PAYWALL", None)
    check("mode par défaut = off", paywall_mode() == MODE_OFF)
    check("mode off : l'aperçu ne l'allume PAS", not paywall_enabled(preview_session=True))

    print("=== refus et catalogue ===")
    d = denial("history", trial_available=True)
    check("refus : ok=False", d["ok"] is False)
    check("refus : porte la fonction refusée", d["paywall"]["feature"] == "history")
    check("refus : propose l'essai quand il est disponible", d["paywall"]["reason"] == "trial_available")
    check("refus : essai déjà consommé → abonnement requis",
          denial("history")["paywall"]["reason"] == "subscription_required")
    check("refus : porte la grille", d["paywall"]["offer"]["yearly"]["amount_eur"] == 30.0)
    check("refus : aucun détail interne", set(d["paywall"]) == {
        "feature", "label", "horizon", "reason", "trial_days", "offer"})
    cat = public_catalog()
    check("catalogue complet", len(cat) == len(FEATURES))
    check("catalogue : 6 fonctions payantes", sum(1 for f in cat if f["paid"]) == 6)
    check("catalogue : 4 fonctions gratuites", sum(1 for f in cat if not f["paid"]) == 4)
    check("catalogue : horizon gratuit borné à 10 j (pas de 10**6 affiché)",
          all((f["free_horizon"] is None or f["free_horizon"] <= 10) for f in cat))

    print(f"\n{ok['n'] - ok['fail']}/{ok['n']} OK" + ("" if ok["fail"] == 0 else f" — {ok['fail']} ÉCHEC(S)"))
    raise SystemExit(1 if ok["fail"] else 0)
