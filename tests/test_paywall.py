"""Périmètre gratuit / payant — étape 1 : les droits, sans paiement, drapeau éteint.

Ce que ces tests protègent, dans l'ordre d'importance :

1. LE DRAPEAU ÉTEINT NE CHANGE RIEN. Tant que OBJECTIFOUDRE_PAYWALL n'est pas posé,
   aucune route ne refuse quoi que ce soit et aucune lecture de base n'est faite.
2. LE CÂBLAGE. Toute route d'une famille payante porte réellement la dépendance : c'est
   le test qui casse le jour où une route est ajoutée sans verrou (le vrai risque de
   régression, un masquage front ne protégeant rien — tout le JS est public).
3. L'HORIZON. La carte gratuite et la page Risque payante passent par LA MÊME route
   (data.js:187 / storm-forecast-data.js:213) : le droit se juge sur la date demandée.
4. L'ESSAI NE SE RECYCLE PAS en recréant un compte.

Pas de httpx dans l'environnement → pas de TestClient : on teste aux coutures (politique
pure, helpers, table de routage réelle de FastAPI) plutôt que par des requêtes HTTP.
"""
import asyncio
import os
import tempfile
import types
import unittest
from datetime import date as Date, timedelta

os.environ["OBJECTIFOUDRE_ACCOUNTS_FILE"] = os.path.join(tempfile.mkdtemp(), "accounts-test.db")
os.environ.pop("OBJECTIFOUDRE_PAYWALL", None)

import access
import accounts
import app as api_app

accounts.init_db()   # créée au démarrage du serveur, pas à l'import


def _req(cookie: str | None = None) -> types.SimpleNamespace:
    """Requête minimale : _account_current_user ne lit que les cookies."""
    return types.SimpleNamespace(cookies=({api_app._SESSION_COOKIE: cookie} if cookie else {}))


def _run(coro):
    return asyncio.run(coro)


class PaywallFlagTests(unittest.TestCase):
    """Le drapeau éteint est l'état de la production aujourd'hui : rien ne doit bouger."""

    def setUp(self):
        os.environ.pop("OBJECTIFOUDRE_PAYWALL", None)

    def test_drapeau_eteint_laisse_tout_passer(self):
        for key in access.FEATURES:
            self.assertIsNone(
                _run(api_app._require_access(_req(), key, horizon=10)),
                f"{key} refusé alors que le périmètre est éteint")

    def test_drapeau_eteint_ne_lit_pas_la_base(self):
        """Coût du verrou en production aujourd'hui : zéro requête SQLite, zéro session."""
        appels = {"n": 0}
        vrai = accounts.is_entitled
        accounts.is_entitled = lambda uid: appels.__setitem__("n", appels["n"] + 1) or False
        try:
            _run(api_app._require_access(_req(), "history"))
        finally:
            accounts.is_entitled = vrai
        self.assertEqual(appels["n"], 0, "le drapeau éteint ne doit rien interroger")

    def test_le_drapeau_s_allume_et_s_eteint(self):
        for valeur, attendu in (("1", True), ("on", True), ("true", True),
                                ("0", False), ("", False), ("off", False)):
            os.environ["OBJECTIFOUDRE_PAYWALL"] = valeur
            self.assertIs(access.paywall_enabled(), attendu, f"OBJECTIFOUDRE_PAYWALL={valeur!r}")
        os.environ.pop("OBJECTIFOUDRE_PAYWALL", None)


class HorizonTests(unittest.TestCase):
    """La frontière gratuit/payant de la carte est une DATE, pas un chemin d'URL."""

    def test_aujourdhui_demain_apres_demain(self):
        today = Date.today()
        self.assertEqual(api_app._horizon_days(today.isoformat()), 0)
        self.assertEqual(api_app._horizon_days((today + timedelta(days=1)).isoformat()), 1)
        self.assertEqual(api_app._horizon_days((today + timedelta(days=7)).isoformat()), 7)
        self.assertEqual(api_app._horizon_days((today - timedelta(days=1)).isoformat()), -1)

    def test_date_absente_vaut_maintenant(self):
        self.assertEqual(api_app._horizon_days(None), 0)
        self.assertEqual(api_app._horizon_days(""), 0)

    def test_date_illisible_ferme_au_lieu_d_ouvrir(self):
        """Échec FERMÉ : une date qu'on ne sait pas lire ne doit pas ouvrir le payant."""
        for mauvais in ("pas-une-date", "2026-13-45", "; DROP TABLE", "9999999"):
            self.assertFalse(access.is_allowed("base_map", horizon=api_app._horizon_days(mauvais),
                                               enabled=True),
                             f"date illisible acceptée : {mauvais!r}")

    def test_objet_date_accepte(self):
        """`payload.date` est un objet date côté Pydantic, pas une chaîne."""
        self.assertEqual(api_app._horizon_days(Date.today()), 0)


class PerimetreTests(unittest.TestCase):
    """Le périmètre validé le 2026-09-04 (dosage B, « aujourd'hui en entier »)."""

    def setUp(self):
        os.environ["OBJECTIFOUDRE_PAYWALL"] = "1"

    def tearDown(self):
        os.environ.pop("OBJECTIFOUDRE_PAYWALL", None)

    def test_le_gratuit_repond_a_ce_soir(self):
        self.assertTrue(access.is_allowed("base_map", horizon=0))
        self.assertTrue(access.is_allowed("base_map", horizon=1))
        self.assertTrue(access.is_allowed("cell_detail", horizon=0))
        self.assertTrue(access.is_allowed("radar_live"))
        self.assertTrue(access.is_allowed("stargaze_map"))

    def test_le_payant_commence_a_demain_plus_un(self):
        self.assertFalse(access.is_allowed("base_map", horizon=2))
        self.assertFalse(access.is_allowed("cell_detail", horizon=1))
        for key in ("forecast_long", "chase_cells", "stargaze_deep", "spots", "history", "alerts"):
            self.assertFalse(access.is_allowed(key), f"{key} devrait être payant")

    def test_402_porte_l_offre_et_rien_d_interne(self):
        with self.assertRaises(api_app.PaywallError) as ctx:
            _run(api_app._require_access(_req(), "history"))
        corps = ctx.exception.payload
        self.assertFalse(corps["ok"])
        self.assertEqual(corps["paywall"]["feature"], "history")
        self.assertEqual(corps["paywall"]["offer"]["monthly"]["amount_eur"], 3.0)
        self.assertEqual(corps["paywall"]["offer"]["yearly"]["amount_eur"], 30.0)
        self.assertNotIn("user_id", str(corps))

    def test_un_droit_actif_ouvre_tout(self):
        u = accounts.register_local("perimetre@example.com", "MotDePasse42")
        accounts.grant_entitlement(u["id"], "manual")
        jeton = accounts.create_session(u["id"])
        for key in access.FEATURES:
            self.assertIsNotNone(_run(api_app._require_access(_req(jeton), key, horizon=10)),
                                 f"{key} refusé à un compte avec droit actif")
        accounts.delete_user(u["id"])

    def test_un_droit_expire_ne_donne_rien(self):
        u = accounts.register_local("expire@example.com", "MotDePasse42")
        accounts.grant_entitlement(u["id"], "manual", days=-1)
        jeton = accounts.create_session(u["id"])
        with self.assertRaises(api_app.PaywallError):
            _run(api_app._require_access(_req(jeton), "history"))
        accounts.delete_user(u["id"])


class CablageDesRoutesTests(unittest.TestCase):
    """La barrière est côté SERVEUR : elle doit être posée sur les vraies routes.

    Ce test casse volontairement si une route d'une famille payante est ajoutée plus tard
    sans verrou — c'est le seul garde-fou contre l'oubli, un masquage front ne protégeant
    rien (tout le JS est public, la console suffit à le contourner).
    """

    # Routes de ces familles qui restent VOLONTAIREMENT ouvertes, avec la raison.
    OUVERTES_A_DESSEIN = {
        "/api/push/vapid-public-key": "clé publique, nécessaire avant même de proposer l'abonnement",
        "/api/push/unsubscribe": "on ne met JAMAIS un péage devant l'arrêt des notifications",
        "/api/history/collect-pending-lightning": "tâche de collecte serveur, pas une page",
    }
    PREFIXES_PAYANTS = ("/api/history/", "/api/spots", "/api/push/")

    def _routes(self):
        for r in api_app.app.routes:
            if hasattr(r, "path") and hasattr(r, "dependencies"):
                yield r

    @staticmethod
    def _a_verrou(route) -> bool:
        return any(getattr(d.dependency, "__name__", "").startswith("_paywall_")
                   for d in route.dependencies)

    @staticmethod
    def _est_admin(route) -> bool:
        return any(getattr(d.dependency, "__name__", "") == "_admin_secret_dep"
                   for d in route.dependencies)

    def test_toute_route_payante_porte_un_verrou(self):
        manquantes = [
            r.path for r in self._routes()
            if r.path.startswith(self.PREFIXES_PAYANTS)
            and r.path not in self.OUVERTES_A_DESSEIN
            and not self._est_admin(r) and not self._a_verrou(r)
        ]
        self.assertEqual(manquantes, [], "routes payantes SANS verrou : %s" % manquantes)

    def test_les_routes_nommement_payantes_sont_verrouillees(self):
        attendues = {
            "/api/history/dates", "/api/history/day", "/api/history/verification",
            "/api/history/lightning", "/api/spots", "/api/spots/mine",
            "/api/spots/discover", "/api/horizon", "/api/push/subscribe", "/api/push/me",
            "/api/stargaze/agenda", "/api/stargaze/outlook",
            "/api/radar/fr/cells", "/api/radar/fr/point", "/api/ecmwf/trend-day",
        }
        verrouillees = {r.path for r in self._routes() if self._a_verrou(r)}
        self.assertEqual(attendues - verrouillees, set(),
                         "routes attendues payantes et non verrouillées : %s"
                         % (attendues - verrouillees))

    def test_les_routes_gratuites_restent_libres(self):
        """Le gratuit doit répondre à « chez moi, ce soir » : radar, foudre, géométrie,
        étoiles de ce soir, forum et compte n'ont AUCUN verrou de route."""
        libres = {
            "/api/radar/fr/status", "/api/radar/fr/image", "/api/radar/fr/shapes",
            "/api/radar/fr/blend/shapes", "/api/radar/fr/blend/image", "/api/lightning/live",
            "/api/meteofrance/france-grid-geometry", "/api/stargaze/tonight",
            "/api/forum/categories", "/api/forum/recent", "/api/account/me",
            "/api/push/unsubscribe", "/api/health",
        }
        fautives = [r.path for r in self._routes() if r.path in libres and self._a_verrou(r)]
        self.assertEqual(fautives, [], "routes gratuites verrouillées par erreur : %s" % fautives)

    def test_les_handlers_a_horizon_recoivent_la_requete(self):
        """Les verrous d'horizon vivent DANS le handler : sans `request` en signature, la
        vérification ne peut pas lire la session."""
        for nom in ("meteofrance_grib_france_day_compact", "meteofrance_grib_france_day_cache",
                    "meteofrance_grib_france_slot_grid_cache", "meteofrance_grib_france_cell_details",
                    "meteofrance_grib_france_wind_profile"):
            fn = getattr(api_app, nom)
            self.assertIn("request", fn.__code__.co_varnames[:fn.__code__.co_argcount],
                          f"{nom} ne reçoit pas la requête : son verrou d'horizon est mort")


class DomeEtoilesTests(unittest.TestCase):
    """La carte des étoiles est gratuite, le dôme non — or les deux sortent du même appel."""

    ECHANTILLON = {
        "ok": True, "scores": [[10, 20]], "cells": [{"lon": 2.0, "lat": 46.0}],
        "darkness": [3], "cloud": [[10, 20]],
        "cloud_low": [[1, 2]], "cloud_mid": [[3, 4]], "cloud_high": [[5, 6]],
        "aurora": {"level": 2}, "hours": [{"hour": 22}],
        "moon": {"illumination": 0.4, "moonrise_utc": "2026-09-04T20:00Z", "moonset_utc": None},
    }

    def tearDown(self):
        os.environ.pop("OBJECTIFOUDRE_PAYWALL", None)

    def test_drapeau_eteint_la_reponse_est_intacte(self):
        os.environ.pop("OBJECTIFOUDRE_PAYWALL", None)
        self.assertIs(_run(api_app._stargaze_trim_for_access(_req(), self.ECHANTILLON)),
                      self.ECHANTILLON)

    def test_sans_droit_le_detail_du_dome_saute_mais_pas_la_carte(self):
        os.environ["OBJECTIFOUDRE_PAYWALL"] = "1"
        out = _run(api_app._stargaze_trim_for_access(_req(), self.ECHANTILLON))
        for champ in ("cloud_low", "cloud_mid", "cloud_high", "aurora"):
            self.assertNotIn(champ, out, f"{champ} sert au dôme et ne devrait pas être servi")
        for champ in ("scores", "cells", "darkness", "cloud", "hours"):
            self.assertIn(champ, out, f"{champ} colore la carte GRATUITE : il doit rester")
        self.assertNotIn("moonrise_utc", out["moon"])
        self.assertTrue(out["dome_locked"])

    def test_le_cache_n_est_jamais_mutile(self):
        """_stargaze_tonight renvoie son cache PAR RÉFÉRENCE : le trim doit copier, sinon
        le premier visiteur non abonné ampute la réponse de tous les autres."""
        os.environ["OBJECTIFOUDRE_PAYWALL"] = "1"
        _run(api_app._stargaze_trim_for_access(_req(), self.ECHANTILLON))
        self.assertIn("cloud_low", self.ECHANTILLON)
        self.assertIn("moonrise_utc", self.ECHANTILLON["moon"])


class EssaiTests(unittest.TestCase):
    """L'essai de 7 jours se déclenche AU MUR et ne se recycle pas."""

    def tearDown(self):
        os.environ.pop("OBJECTIFOUDRE_PAYWALL", None)

    def test_le_402_propose_l_essai_puis_ne_le_propose_plus(self):
        os.environ["OBJECTIFOUDRE_PAYWALL"] = "1"
        u = accounts.register_local("mur@example.com", "MotDePasse42")
        accounts.verify_email_token(accounts.issue_email_token(u["id"], "verify", "mur@example.com"))
        jeton = accounts.create_session(u["id"])
        with self.assertRaises(api_app.PaywallError) as ctx:
            _run(api_app._require_access(_req(jeton), "history"))
        self.assertEqual(ctx.exception.payload["paywall"]["reason"], "trial_available")
        self.assertEqual(ctx.exception.payload["paywall"]["trial_days"], 7)

        accounts.start_trial(u["id"], "mur@example.com")
        self.assertIsNotNone(_run(api_app._require_access(_req(jeton), "history")))

        accounts.grant_entitlement(u["id"], "trial", days=-1)      # l'essai s'achève
        with self.assertRaises(api_app.PaywallError) as ctx2:
            _run(api_app._require_access(_req(jeton), "history"))
        self.assertEqual(ctx2.exception.payload["paywall"]["reason"], "subscription_required")
        accounts.delete_user(u["id"])

    def test_essai_refuse_a_un_e_mail_non_verifie(self):
        u = accounts.register_local("nonverifie@example.com", "MotDePasse42")
        self.assertFalse(_run(api_app._trial_available_for(accounts.get_user(u["id"]))))
        accounts.delete_user(u["id"])

    def test_visiteur_anonyme_pas_d_essai_a_proposer(self):
        self.assertFalse(_run(api_app._trial_available_for(None)))

    def test_l_etat_expose_au_compte_ne_sert_qu_a_l_affichage(self):
        u = accounts.register_local("etat@example.com", "MotDePasse42")
        vue = _run(api_app._access_view(accounts.get_user(u["id"])))
        self.assertEqual(set(vue), {"paywall", "entitled", "source", "expires_utc",
                                    "trial_available", "offer"})
        self.assertFalse(vue["entitled"])
        accounts.grant_entitlement(u["id"], "manual")
        self.assertTrue(_run(api_app._access_view(accounts.get_user(u["id"])))["entitled"])
        accounts.delete_user(u["id"])


if __name__ == "__main__":
    unittest.main()
