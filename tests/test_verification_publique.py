"""Page de vérification publique — le câblage, pas les maths.

Les maths (agrégation, régions, fiabilité, sélection des cas) ont leur propre auto-test
dans `public_verification.py` : `python3 public_verification.py`. Ici on protège ce qui
casserait EN SILENCE, dans l'ordre d'importance :

1. LA PAGE RESTE PUBLIQUE. C'est tout l'argument : une page de crédibilité derrière un
   péage ne vaut rien. Le jour où OBJECTIFOUDRE_PAYWALL passe à `on`, ses routes doivent
   répondre exactement pareil. Ce test échoue si quelqu'un y pose un verrou — ou déplace
   la route sous /api/history/, où tests/test_paywall.py en EXIGE un.
2. AUCUN CHIFFRE INVENTÉ. Une valeur absente s'affiche « non calculé », jamais 0.
3. L'INSTANTANÉ J+1 NE SE RÉÉCRIT PAS. Il vaut « la dernière prévision faite avant que la
   journée commence » : une capture après coup le transformerait en analyse du jour même,
   c'est-à-dire en mesure fausse et invérifiable.
4. LE JOURNAL DES RUPTURES N'ENREGISTRE QUE LES RUPTURES.

Pas de httpx dans l'environnement → pas de TestClient : on teste aux coutures (table de
routage réelle de FastAPI, fonctions du module), comme test_paywall.py.
"""
import os
import tempfile
import unittest
from datetime import date as Date, timedelta

_TMP = tempfile.mkdtemp(prefix="objf-verif-pub-")
os.environ["OBJECTIFOUDRE_HISTORY_DIR"] = _TMP
os.environ["OBJECTIFOUDRE_ACCOUNTS_FILE"] = os.path.join(_TMP, "accounts-test.db")
os.environ["OBJECTIFOUDRE_LIGHTNING_AUTOMATION"] = "0"
os.environ["OBJECTIFOUDRE_PREWARM"] = "0"
os.environ.pop("OBJECTIFOUDRE_PAYWALL", None)

import public_verification as pv
import public_verification_page as page
import app as api_app


PUBLIC_ROUTES = ("/api/verification/publique", "/verification")


def _routes():
    for route in api_app.app.routes:
        if hasattr(route, "path") and hasattr(route, "dependencies"):
            yield route


def _deps(route) -> set[str]:
    return {getattr(d.dependency, "__name__", "") for d in route.dependencies}


class LaPageRestePublique(unittest.TestCase):
    """Le cœur du sujet : ces routes ne se verrouillent pas, jamais."""

    def test_les_routes_publiques_existent(self):
        paths = {r.path for r in _routes()}
        for path in PUBLIC_ROUTES:
            self.assertIn(path, paths, f"route publique disparue : {path}")

    def test_aucun_verrou_de_perimetre(self):
        for route in _routes():
            if route.path not in PUBLIC_ROUTES:
                continue
            verrous = {d for d in _deps(route) if d.startswith("_paywall_")}
            self.assertEqual(verrous, set(),
                             f"{route.path} a été verrouillé : la page de vérification "
                             f"doit rester lisible sans compte ({verrous})")

    def test_aucune_dependance_d_administration(self):
        for route in _routes():
            if route.path in PUBLIC_ROUTES:
                self.assertNotIn("_admin_secret_dep", _deps(route), route.path)

    def test_hors_du_prefixe_paye(self):
        """/api/history/ est le préfixe de la fonction PAYANTE `history`, et
        test_paywall.py exige un verrou sur chacune de ses routes : une route publique qui
        y atterrirait ferait échouer l'autre suite au lieu d'échouer ici."""
        for path in PUBLIC_ROUTES:
            self.assertFalse(path.startswith("/api/history/"), path)

    def test_la_regeneration_reste_reservee_a_l_administrateur(self):
        cible = [r for r in _routes() if r.path == "/api/server/verification-publique"]
        self.assertTrue(cible, "l'endpoint de régénération a disparu")
        self.assertIn("_admin_secret_dep", _deps(cible[0]))


class AucunChiffreInvente(unittest.TestCase):
    """« N'affiche jamais une métrique qui n'est pas réellement calculée. »"""

    @staticmethod
    def _report(**overrides):
        base = {
            "ok": True, "generated_at": "2026-09-08T20:00:00+02:00", "app_version": "test",
            "reference_date": "2026-09-07",
            "coverage": {"days_ready": 0, "days_total": 0, "days_pending": 0,
                         "pending_dates": [], "complete": True, "first_date": None,
                         "last_date": None, "retention_days": 180, "grid_cells": None},
            "method": {"threshold": 52, "baseline_threshold": 60, "neighborhood_km": 30.0,
                       "flash_threshold": 1.0, "cell_aggregator": "nearest", "weights": None,
                       "li_boost_gain": None, "app_version": "test", "lead_days": [1],
                       "min_positives_window": 30, "min_positives_region": 50,
                       "min_positives_case": 20, "min_n_reliability_bin": 100},
            "windows": pv.windows([], Date(2026, 9, 7)),
            "regions": [], "reliability": [], "cases": [], "lead_time": [],
            "changes": [], "daily": [],
        }
        base.update(overrides)
        return base

    def test_un_rapport_vide_se_rend_sans_planter(self):
        html = page.render(self._report())
        self.assertIn("<!doctype html>", html)
        self.assertIn("Prévu contre observé", html)

    def test_une_fenetre_sans_effectif_dit_non_calcule(self):
        html = page.render(self._report())
        self.assertIn("non calculé", html)
        self.assertNotIn(">0,000<", html)

    def test_une_valeur_absente_devient_un_tiret(self):
        self.assertEqual(page.num(None), "—")
        self.assertEqual(page.integer(None), "—")
        self.assertEqual(page.num("pas un nombre"), "—")
        self.assertEqual(page.date_fr(None), "—")

    def test_zero_reste_zero(self):
        """Le garde-fou ne doit pas non plus effacer un vrai zéro."""
        self.assertEqual(page.num(0.0, 3), "0,000")
        self.assertEqual(page.integer(0), "0")

    def test_l_echeance_non_mesuree_est_annoncee_comme_telle(self):
        html = page.render(self._report())
        self.assertIn("du jour même", html)
        self.assertNotIn("J+1</td>", html)

    def test_le_html_est_echappe(self):
        html = page.render(self._report(cases=[{
            "date": "2026-07-24", "reason": "pire_csi", "positives": 30, "csi": 0.1,
            "contingency": {"hits": 1, "misses": 2, "false_alarms": 3, "correct_negatives": 4},
            "scores": {"csi": 0.1, "pod": 0.3, "far": 0.7},
            "flash_total": 10, "forecast_cells": 3, "observed_cells": 3,
            "points": {"forecast": [], "observed": []},
        }], regions=[{"zone": "<script>alert(1)</script>", "cells": 1, "positives": 99,
                      "contingency": {}, "significant": False, "scores": {}, "reason": None}]))
        self.assertNotIn("<script>alert(1)</script>", html)
        self.assertIn("&lt;script&gt;", html)


class LesCartes(unittest.TestCase):

    def test_la_projection_place_la_france_dans_le_cadre(self):
        for lon, lat in ((-5.55, 51.45), (9.75, 41.05), (2.35, 48.86)):
            x, y = page._project(lon, lat)
            self.assertTrue(-0.01 <= x <= page.MAP_W + 0.01, (lon, lat, x))
            self.assertTrue(-0.01 <= y <= page.MAP_H + 0.01, (lon, lat, y))

    def test_le_nord_est_en_haut(self):
        _, y_nord = page._project(2.0, 51.0)
        _, y_sud = page._project(2.0, 42.0)
        self.assertLess(y_nord, y_sud)

    def test_les_longitudes_sont_redressees(self):
        """Sans le cosinus de la latitude, la France sort étirée d'un tiers en largeur."""
        self.assertAlmostEqual(page.MAP_W / page.MAP_H, 1.016, places=2)

    def test_le_contour_est_un_trace_unique_et_borne(self):
        path = page.france_outline_path()
        self.assertTrue(path.startswith("M"), path[:20])
        self.assertLess(len(path), 60_000, "contour trop lourd : augmenter OUTLINE_STEP")

    def test_une_couche_vide_ne_dessine_rien(self):
        self.assertEqual(page.cells_path([]), "")

    def test_une_cellule_donne_un_rectangle_ferme(self):
        d = page.cells_path([[46.0, 2.0]])
        self.assertTrue(d.startswith("M") and d.endswith("z"), d)
        self.assertEqual(d.count("z"), 1)


class InstantanéEcheance(unittest.TestCase):
    """L'instantané J+1 vaut « la dernière prévision faite AVANT que la journée commence »."""

    def test_une_date_passee_est_refusee(self):
        hier = Date.today() - timedelta(days=1)
        self.assertEqual(api_app._capture_lead_snapshot(hier, 1)["reason"], "date_non_future")

    def test_aujourdhui_est_refuse(self):
        """Le cas dangereux : capturer aujourd'hui transformerait une prévision de la veille
        en analyse du jour même, donc en score flatteur et invérifiable."""
        result = api_app._capture_lead_snapshot(Date.today(), 1)
        self.assertFalse(result["ok"])
        self.assertEqual(result["reason"], "date_non_future")

    def test_une_date_future_sans_grille_ne_fabrique_rien(self):
        demain = Date.today() + timedelta(days=1)
        result = api_app._capture_lead_snapshot(demain, 1)
        self.assertFalse(result["ok"])
        self.assertEqual(result["reason"], "no_forecast_archived")
        self.assertFalse(api_app._verif_lead_path(demain.isoformat(), 1).exists())

    def test_seule_l_echeance_j1_est_collectee(self):
        """J+2 et au-delà viennent d'ECMWF ~28 km : les collecter depuis la grille AROME
        produirait une mesure qui n'existe pas."""
        self.assertEqual(tuple(api_app.OBJECTIFOUDRE_VERIF_LEAD_DAYS), (1,))

    def test_les_cles_de_cellule_se_relisent_exactement(self):
        snapshot = {"scores": {"46.000|2.000": 61, "45.865|2.180": 12}}
        cells = api_app._cells_from_lead_snapshot(snapshot)
        self.assertEqual(len(cells), 2)
        self.assertIn({"lat": 46.0, "lon": 2.0, "trigger_score": 61.0}, cells)

    def test_une_cle_illisible_est_ignoree_pas_devinee(self):
        cells = api_app._cells_from_lead_snapshot({"scores": {"n'importe quoi": 50}})
        self.assertEqual(cells, [])


class JournalDesRuptures(unittest.TestCase):

    def setUp(self):
        path = api_app._verif_stamps_path()
        if path.exists():
            path.unlink()

    def test_la_premiere_methode_est_enregistree(self):
        stamps = api_app._verif_record_stamp()
        self.assertEqual(len(stamps), 1)
        self.assertEqual(stamps[0]["threshold"], api_app._active_score_threshold)

    def test_une_regeneration_sans_changement_n_ajoute_rien(self):
        api_app._verif_record_stamp()
        api_app._verif_record_stamp()
        self.assertEqual(len(api_app._verif_read_stamps()), 1)

    def test_un_simple_deploiement_n_est_pas_une_rupture(self):
        """Sinon la liste des ruptures devient un journal de mises en production, et le
        lecteur n'y distingue plus ce qui change réellement les chiffres."""
        api_app._verif_record_stamp()
        avant = api_app.APP_VERSION
        try:
            api_app.APP_VERSION = avant + "-suivante"
            stamps = api_app._verif_record_stamp()
        finally:
            api_app.APP_VERSION = avant
        self.assertEqual(len(stamps), 1)

    def test_un_changement_de_seuil_ajoute_une_ligne(self):
        api_app._verif_record_stamp()
        avant = api_app._active_score_threshold
        try:
            api_app._active_score_threshold = avant + 7
            stamps = api_app._verif_record_stamp()
        finally:
            api_app._active_score_threshold = avant
        self.assertEqual(len(stamps), 2)
        self.assertEqual(stamps[-1]["threshold"], avant + 7)

    def test_la_methode_courante_porte_ce_qui_bouge(self):
        stamp = api_app._verif_current_stamp()
        for key in ("threshold", "baseline_threshold", "neighborhood_km",
                    "flash_threshold", "cell_aggregator", "weights", "app_version"):
            self.assertIn(key, stamp)


class LeRapport(unittest.TestCase):

    def test_sans_archive_le_rapport_est_vide_mais_honnete(self):
        report = api_app._build_public_verification_report(budget=1)
        self.assertEqual(report["coverage"]["days_ready"], 0)
        self.assertEqual(report["cases"], [])
        self.assertIsNone(report["windows"]["7j"]["scores"]["csi"])
        self.assertFalse(report["windows"]["7j"]["significant"])

    def test_le_rapport_dit_sous_quelle_methode_il_a_ete_calcule(self):
        method = api_app._build_public_verification_report(budget=0)["method"]
        self.assertEqual(method["threshold"], api_app._active_score_threshold)
        self.assertEqual(method["neighborhood_km"], api_app.verification.DEFAULT_NEIGHBORHOOD_KM)

    def test_la_cle_de_cache_change_avec_le_seuil(self):
        """Un réentraînement doit invalider les journées déjà calculées, sinon la page
        servirait un mélange de deux méthodes sans le dire."""
        lightning = {"generated_at": "2026-09-07T01:00:00+02:00"}
        avant = api_app._verif_public_day_key("2026-09-06", lightning)
        old = api_app._active_score_threshold
        try:
            api_app._active_score_threshold = old + 1
            apres = api_app._verif_public_day_key("2026-09-06", lightning)
        finally:
            api_app._active_score_threshold = old
        self.assertNotEqual(avant, apres)

    def test_la_cle_de_cache_change_avec_l_observation(self):
        a = api_app._verif_public_day_key("2026-09-06", {"generated_at": "A"})
        b = api_app._verif_public_day_key("2026-09-06", {"generated_at": "B"})
        self.assertNotEqual(a, b)


if __name__ == "__main__":
    unittest.main(verbosity=2)
