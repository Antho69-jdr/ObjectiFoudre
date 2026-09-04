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


def _req(cookie: str | None = None, apercu: bool = False) -> types.SimpleNamespace:
    """Requête minimale : _account_current_user et _paywall_active ne lisent que les cookies."""
    ck = {}
    if cookie:
        ck[api_app._SESSION_COOKIE] = cookie
    if apercu:
        ck[api_app._PAYWALL_PREVIEW_COOKIE] = "1"
    return types.SimpleNamespace(cookies=ck)


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
        vue = _run(api_app._access_view(_req(), accounts.get_user(u["id"])))
        self.assertEqual(set(vue), {"paywall", "entitled", "source", "expires_utc",
                                    "trial_available", "offer"})
        self.assertFalse(vue["entitled"])
        accounts.grant_entitlement(u["id"], "manual")
        self.assertTrue(_run(api_app._access_view(_req(), accounts.get_user(u["id"])))["entitled"])
        accounts.delete_user(u["id"])


class ModeApercuTests(unittest.TestCase):
    """Le mode « aperçu » : essayer le périmètre en vrai SANS le mettre en service.

    Sans lui, la seule façon d'essayer serait de l'appliquer à tous les visiteurs d'un
    coup — c'est-à-dire de le lancer, pas de le tester.
    """

    def tearDown(self):
        os.environ.pop("OBJECTIFOUDRE_PAYWALL", None)

    def test_off_reste_off_meme_avec_le_cookie(self):
        """Le cookie ne peut RIEN allumer : c'est le serveur qui décide du mode."""
        os.environ.pop("OBJECTIFOUDRE_PAYWALL", None)
        self.assertFalse(api_app._paywall_active(_req(apercu=True)))
        self.assertIsNone(_run(api_app._require_access(_req(apercu=True), "history")))

    def test_apercu_ne_touche_que_la_session_qui_le_demande(self):
        os.environ["OBJECTIFOUDRE_PAYWALL"] = "preview"
        self.assertFalse(api_app._paywall_active(_req()), "un visiteur ordinaire ne doit rien voir")
        self.assertIsNone(_run(api_app._require_access(_req(), "history")),
                          "le visiteur ordinaire doit passer comme avant")
        self.assertTrue(api_app._paywall_active(_req(apercu=True)))
        with self.assertRaises(api_app.PaywallError):
            _run(api_app._require_access(_req(apercu=True), "history"))

    def test_on_s_applique_a_tout_le_monde(self):
        os.environ["OBJECTIFOUDRE_PAYWALL"] = "1"
        self.assertTrue(api_app._paywall_active(_req()))
        self.assertTrue(api_app._paywall_active(_req(apercu=True)))

    def test_l_etat_expose_au_front_suit_la_session(self):
        os.environ["OBJECTIFOUDRE_PAYWALL"] = "preview"
        self.assertFalse(_run(api_app._access_view(_req(), None))["paywall"])
        self.assertTrue(_run(api_app._access_view(_req(apercu=True), None))["paywall"])

    def test_le_dome_suit_aussi_la_session(self):
        os.environ["OBJECTIFOUDRE_PAYWALL"] = "preview"
        ech = {"ok": True, "cloud_low": [[1]], "moon": {"moonrise_utc": "x"}}
        self.assertIs(_run(api_app._stargaze_trim_for_access(_req(), ech)), ech,
                      "un visiteur ordinaire garde la réponse entière")
        coupe = _run(api_app._stargaze_trim_for_access(_req(apercu=True), ech))
        self.assertNotIn("cloud_low", coupe)

    def test_les_outils_de_test_sont_reserves_a_l_admin(self):
        """Ils accordent des droits : jamais accessibles sans compte administrateur, et
        jamais verrouillés par le périmètre (sinon on ne pourrait plus l'éteindre)."""
        chemins = {"/api/server/paywall", "/api/server/paywall/preview",
                   "/api/server/paywall/toggle", "/api/server/paywall/trial-reset"}
        vus = set()
        for r in api_app.app.routes:
            if getattr(r, "path", None) in chemins and hasattr(r, "dependencies"):
                vus.add(r.path)
                noms = [getattr(d.dependency, "__name__", "") for d in r.dependencies]
                self.assertIn("_admin_secret_dep", noms, f"{r.path} n'est pas réservé à l'admin")
                self.assertFalse(any(n.startswith("_paywall_") for n in noms),
                                 f"{r.path} ne doit pas être verrouillé par le périmètre lui-même")
        self.assertEqual(vus, chemins, "outils de test manquants : %s" % (chemins - vus))


class BasculesTests(unittest.TestCase):
    """Un seul bouton par bascule, et son libellé doit pouvoir dire l'état courant."""

    def test_la_telemetrie_porte_l_etat_du_perimetre(self):
        """La mosaïque de maintenance se repeint toutes les 15 s : les libellés à bascule
        lisent l'état DANS la télémétrie, sans requête supplémentaire."""
        u = accounts.register_local("bascule@example.com", "MotDePasse42")
        jeton = accounts.create_session(u["id"])
        etat = _run(api_app._paywall_state(_req(jeton)))
        for cle in ("mode", "apercu_actif_sur_cette_session", "perimetre_applique_ici", "mon_compte"):
            self.assertIn(cle, etat)
        self.assertFalse(etat["mon_compte"]["droit_actif"])
        accounts.grant_entitlement(u["id"], "manual")
        self.assertTrue(_run(api_app._paywall_state(_req(jeton)))["mon_compte"]["droit_actif"])
        accounts.delete_user(u["id"])

    def test_la_bascule_de_droit_va_dans_les_deux_sens(self):
        """C'est le comportement demandé : un bouton, pas une durée à choisir. Le droit
        accordé est SANS échéance — il se retire du même geste, pas en attendant 30 jours."""
        u = accounts.register_local("va-et-vient@example.com", "MotDePasse42")
        self.assertFalse(accounts.is_entitled(u["id"]))
        ent = accounts.grant_entitlement(u["id"], "manual", days=None)
        self.assertTrue(ent["active"])
        self.assertIsNone(ent["expires_utc"], "une bascule ne doit pas poser d'échéance")
        accounts.revoke_entitlement(u["id"])
        self.assertFalse(accounts.is_entitled(u["id"]))
        self.assertTrue(accounts.grant_entitlement(u["id"], "manual", days=None)["active"],
                        "on doit pouvoir re-basculer autant de fois qu'on veut")
        accounts.delete_user(u["id"])

    def test_l_apercu_s_inverse_sans_parametre(self):
        """Sans `on`, l'endpoint inverse l'état courant : c'est ce qui en fait une bascule."""
        source = __import__("inspect").getsource(api_app.server_paywall_preview)
        self.assertIn("if on is None", source)

    def test_les_boutons_de_maintenance_pointent_les_bons_endpoints(self):
        js = (__import__("pathlib").Path(api_app.STATIC_DIR)
              / "assets/js/maintenance.js").read_text(encoding="utf-8")
        for url in ("/api/server/paywall/toggle", "/api/server/paywall/preview",
                    "/api/server/paywall/trial-reset", "/api/server/paywall"):
            self.assertIn(url, js, f"{url} n'est plus câblé dans la page maintenance")
        for disparu in ("/api/server/paywall/grant", "/api/server/paywall/revoke"):
            self.assertNotIn(disparu, js, f"{disparu} a été remplacé par la bascule")
        self.assertIn("suitLeDroit", js, "les bascules doivent rafraîchir l'état après clic")


class CablageDuFrontTests(unittest.TestCase):
    """Le mur ne sert à rien s'il n'est pas RÉELLEMENT chargé par la page.

    Piège vécu le 2026-09-04 : le composant CSS avait été importé dans `index.css`
    (bundle `app.css`), qui ne sert QUE la page styleguide. La page réelle charge
    `dist/theme.css`. Les cadenas ne s'affichaient pas — la mesure au navigateur l'a
    montré, la relecture non.
    """

    STATIC = __import__("pathlib").Path(api_app.STATIC_DIR)

    def test_le_module_est_charge_avant_account_js(self):
        """account.js appelle OFPaywall.applyMe() : il doit être défini avant."""
        html = (self.STATIC / "index.html").read_text(encoding="utf-8")
        i_pw, i_acc = html.find("/assets/js/paywall.js"), html.find("/assets/js/account.js")
        self.assertNotEqual(i_pw, -1, "paywall.js n'est pas chargé par index.html")
        self.assertNotEqual(i_acc, -1, "account.js n'est plus chargé ?")
        self.assertLess(i_pw, i_acc, "paywall.js doit être chargé AVANT account.js")

    def test_le_css_est_dans_le_bundle_reellement_servi(self):
        """La page charge dist/theme.css — pas dist/app.css, réservé au styleguide."""
        html = (self.STATIC / "index.html").read_text(encoding="utf-8")
        self.assertIn("/assets/dist/theme.css", html)
        css = (self.STATIC / "assets/dist/theme.css").read_text(encoding="utf-8")
        for marqueur in (".pw-card", "objf-locked", ".account-plan-state"):
            # assertTrue et non assertIn : le bundle fait 200 Ko, on ne veut pas le voir
            # recraché dans le rapport d'échec.
            self.assertTrue(marqueur in css,
                            f"{marqueur} absent de theme.css : `node build.mjs` oublié, ou "
                            f"composant importé dans le mauvais bundle (index.css ne sert "
                            f"que le styleguide)")

    def test_les_cadenas_visent_des_ancres_qui_existent(self):
        """Les sélecteurs de cadenas suivent le DOM réel : ids du rail, data-nav de la
        barre du bas, data-plus de la feuille « Plus »."""
        css = (self.STATIC / "assets/dist/theme.css").read_text(encoding="utf-8")
        html = (self.STATIC / "index.html").read_text(encoding="utf-8")
        nav = (self.STATIC / "assets/js/bottom-nav.js").read_text(encoding="utf-8")
        for ancre in ("#historyPageBtn", "#spotsPageBtn"):
            self.assertTrue(ancre in css, f"{ancre} n'est plus ciblé par le CSS des cadenas")
            self.assertTrue('id="%s"' % ancre[1:] in html, f"{ancre} n'existe plus dans index.html")
        for ident in ("histo", "spots"):
            # esbuild déquote les sélecteurs d'attribut : [data-plus=histo].
            self.assertTrue(('data-plus="%s"' % ident) in css or ("data-plus=%s" % ident) in css,
                            f"la feuille « Plus » n'est plus ciblée pour {ident}")
            self.assertTrue("'%s'" % ident in nav, f"la destination {ident} a disparu du POOL")


if __name__ == "__main__":
    unittest.main()
