"""Ré-ancrage de l'agrégateur de cellule — la bascule p90 sans décaler la carte.

Ce que ces tests protègent, dans l'ordre d'importance :

1. **LE GARDE-FOU.** Servir le p90 SANS sa courbe décale toute la distribution vers le haut
   (mesuré en production sur 28 996 cellules-jours : 7,31 % → 11,54 % de cellules ≥ 60, soit
   +58 % de rouge sur la carte) alors qu'aucune prévision ne s'est améliorée à l'écran.
   « L'agrégateur et la courbe ensemble, jamais l'un sans l'autre » doit être une invariante
   de code, pas une consigne qu'on oublie un jour : si la courbe manque, l'agrégateur
   RETOMBE sur `nearest`.
2. **LES EX ÆQUO.** Une courbe quantile→quantile sur des scores entiers répète beaucoup
   d'abscisses (41 points, 29 abscisses distinctes sur la courbe réelle). Retenir le premier
   segment revient à prendre le y le plus BAS : mesuré, `30 → 23` alors que le plateau va de
   23 à 30. Biais systématique vers le bas, pile autour de la médiane.
3. **LA MONOTONIE.** Une correspondance de quantiles est croissante ; un score plus élevé ne
   doit JAMAIS ressortir plus bas.
4. **L'IDENTITÉ PAR DÉFAUT.** Sans courbe active, le moteur rend exactement le même score
   qu'avant — c'est ce qui rend la livraison sans risque tant que la bascule n'est pas faite.
"""
import json
import os
import tempfile
import unittest
from pathlib import Path

_TMP = tempfile.mkdtemp(prefix="objf-rebase-")
os.environ["OBJECTIFOUDRE_HISTORY_DIR"] = _TMP
os.environ["OBJECTIFOUDRE_ACCOUNTS_FILE"] = os.path.join(_TMP, "accounts-test.db")
os.environ["OBJECTIFOUDRE_LIGHTNING_AUTOMATION"] = "0"
os.environ["OBJECTIFOUDRE_PREWARM"] = "0"
# Cache DANS le dossier temporaire : sans ça les tests écriraient dans le .cache du dépôt.
os.environ["OBJECTIFOUDRE_CACHE_DIR"] = os.path.join(_TMP, "cache")

import asyncio

import weather_logic as wl
import app as api_app


# Extrait RÉEL de la courbe de production (GET /api/server/shadow-rebase, 09/09/2026) :
# les sept plateaux y sont, dont celui de 30 qui porte cinq valeurs de 23 à 30.
COURBE_REELLE = [
    [10, 6], [13, 12], [14, 12], [15, 13], [18, 14], [24, 15], [29, 17],
    [30, 23], [30, 26], [30, 29], [30, 30], [30, 30],
    [31, 30], [31, 30], [32, 30], [32, 30], [32, 31], [32, 31],
    [33, 32], [33, 32], [34, 32], [35, 32], [35, 33], [37, 33], [40, 34],
    [44, 35], [45, 35], [48, 36], [51, 40], [52, 44], [52, 47], [53, 51],
    [53, 52], [54, 52], [56, 53], [59, 54], [61, 56], [65, 59], [72, 63],
    [82, 73], [100, 100],
]


class LeGardeFou(unittest.TestCase):
    """Un p90 non ré-ancré ne doit JAMAIS être servi."""

    def test_l_agregateur_effectif_et_la_courbe_vont_toujours_ensemble(self):
        """L'invariante, dans les deux sens. Attention : la PRÉSENCE du fichier de courbe ne
        dit rien — c'est l'agrégateur EFFECTIF qui décide. En `nearest` ou en `shadow`, la
        courbe existe peut-être sur le disque mais ne doit surtout pas être active, sinon le
        mode ombre changerait la production alors que tout son intérêt est de ne rien changer."""
        effectif = api_app.METEOFRANCE_CELL_AGGREGATOR
        active = wl.get_active_cell_rebase_curve()
        if effectif in ("nearest", "shadow"):
            self.assertIsNone(active, f"courbe active alors que l'agrégateur est {effectif}")
        else:
            self.assertIsNotNone(active, f"agrégateur {effectif} servi SANS courbe de ré-ancrage")

    def test_sans_fichier_de_courbe_le_p90_est_refuse(self):
        """Le cœur du garde-fou : si le fichier disparaissait, p90 ne doit pas être servi."""
        self.assertIsNone(api_app._load_cell_rebase_curve("agregateur_inexistant"))

    def test_un_repli_ne_reste_jamais_silencieux(self):
        """Sinon un repli ressemblerait à une bascule réussie."""
        if api_app.CELL_REBASE_FALLBACK_REASON is not None:
            self.assertIn("repli", api_app.CELL_REBASE_FALLBACK_REASON)
            self.assertEqual(api_app.METEOFRANCE_CELL_AGGREGATOR, "nearest")

    def test_nearest_et_shadow_ne_cherchent_aucune_courbe(self):
        """Le mode ombre sert le plus proche voisin : lui coller une courbe changerait la
        production alors que tout l'intérêt du mode ombre est de ne rien changer."""
        self.assertIsNone(api_app._load_cell_rebase_curve("nearest"))
        self.assertIsNone(api_app._load_cell_rebase_curve("shadow"))

    def test_un_fichier_illisible_vaut_absence_pas_plantage(self):
        chemin = api_app.BASE_DIR / "data" / "cell_rebase_bidon.json"
        try:
            chemin.write_text("{ pas du json", encoding="utf-8")
            self.assertIsNone(api_app._load_cell_rebase_curve("bidon"))
        finally:
            chemin.unlink(missing_ok=True)

    def test_un_fichier_sans_courbe_vaut_absence(self):
        chemin = api_app.BASE_DIR / "data" / "cell_rebase_bidon.json"
        try:
            chemin.write_text(json.dumps({"schema": 1}), encoding="utf-8")
            self.assertIsNone(api_app._load_cell_rebase_curve("bidon"))
        finally:
            chemin.unlink(missing_ok=True)

    def test_le_jeton_de_cache_suit_l_agregateur_EFFECTIF(self):
        """Si le repli a joué, aucun cache ne doit être invalidé : la production n'a pas changé."""
        jeton = api_app._cell_aggregator_cache_token()
        if api_app.METEOFRANCE_CELL_AGGREGATOR in ("nearest", "shadow"):
            self.assertEqual(jeton, "")
        else:
            self.assertEqual(jeton, f":agg={api_app.METEOFRANCE_CELL_AGGREGATOR}")


class LesExAequo(unittest.TestCase):
    """Le défaut mesuré sur la courbe réelle : le premier segment retenait le y le plus bas."""

    def test_un_plateau_devient_la_moyenne_de_ses_valeurs(self):
        courbe = wl.normalize_rebase_curve(COURBE_REELLE)
        self.assertAlmostEqual(wl.rebase_score(courbe, 30), 27.6, places=3)

    def test_le_biais_vers_le_bas_a_disparu(self):
        """23 était l'ancienne réponse pour 30 : 4,6 points trop bas, juste autour de la médiane."""
        courbe = wl.normalize_rebase_curve(COURBE_REELLE)
        self.assertGreater(wl.rebase_score(courbe, 30), 23.0 + 1e-9)

    def test_chaque_abscisse_n_apparait_qu_une_fois(self):
        courbe = wl.normalize_rebase_curve(COURBE_REELLE)
        xs = [x for x, _ in courbe]
        self.assertEqual(len(xs), len(set(xs)))
        self.assertEqual(len(courbe), 29, "la courbe réelle a 29 abscisses distinctes")

    def test_les_sept_plateaux_sont_bien_moyennes(self):
        courbe = dict(wl.normalize_rebase_curve(COURBE_REELLE))
        for x, attendu in ((30, 27.6), (31, 30.0), (32, 30.5), (33, 32.0),
                           (35, 32.5), (52, 45.5), (53, 51.5)):
            self.assertAlmostEqual(courbe[x], attendu, places=3, msg=f"plateau x={x}")


class LaMonotonie(unittest.TestCase):

    def test_la_courbe_normalisee_est_croissante(self):
        courbe = wl.normalize_rebase_curve(COURBE_REELLE)
        ys = [y for _, y in courbe]
        self.assertEqual(ys, sorted(ys))

    def test_un_score_plus_eleve_ne_ressort_jamais_plus_bas(self):
        courbe = wl.normalize_rebase_curve(COURBE_REELLE)
        valeurs = [wl.rebase_score(courbe, s) for s in range(0, 101)]
        for a, b in zip(valeurs, valeurs[1:]):
            self.assertLessEqual(a, b + 1e-9)

    def test_une_courbe_bruitee_est_redressee(self):
        """Un creux d'échantillonnage ne doit pas produire une inversion de classement."""
        courbe = wl.normalize_rebase_curve([[10, 20], [20, 15], [30, 40]])
        ys = [y for _, y in courbe]
        self.assertEqual(ys, sorted(ys))

    def test_les_extremites_sont_plates(self):
        courbe = wl.normalize_rebase_curve(COURBE_REELLE)
        self.assertEqual(wl.rebase_score(courbe, -50), courbe[0][1])
        self.assertEqual(wl.rebase_score(courbe, 500), courbe[-1][1])


class LIdentiteParDefaut(unittest.TestCase):
    """Tant qu'aucune courbe n'est active, le moteur doit rendre le score d'avant, au bit près."""

    def setUp(self):
        self._sauvegarde = wl.get_active_cell_rebase_curve()

    def tearDown(self):
        wl.set_active_cell_rebase_curve(
            [list(p) for p in self._sauvegarde] if self._sauvegarde else None)

    def test_sans_courbe_le_score_est_inchange(self):
        wl.set_active_cell_rebase_curve(None)
        for score in range(0, 101):
            self.assertEqual(wl.apply_cell_rebase(score), score)

    def test_une_courbe_vide_ne_s_active_pas(self):
        for vide in (None, [], [[1, 2]], "pas une courbe"):
            wl.set_active_cell_rebase_curve(vide)
            self.assertIsNone(wl.get_active_cell_rebase_curve(), repr(vide))
            self.assertEqual(wl.apply_cell_rebase(73), 73)

    def test_les_points_illisibles_sont_ignores_pas_devines(self):
        courbe = wl.normalize_rebase_curve([[10, 6], ["a", "b"], [None, 3], [100, 100]])
        self.assertEqual(courbe, [(10.0, 6.0), (100.0, 100.0)])

    def test_avec_courbe_le_score_reste_borne_0_100(self):
        wl.set_active_cell_rebase_curve(COURBE_REELLE)
        for score in range(0, 101):
            valeur = wl.apply_cell_rebase(score)
            self.assertTrue(0 <= valeur <= 100, (score, valeur))
            self.assertIsInstance(valeur, int)


class LaCourbeLivree(unittest.TestCase):
    """Si une courbe est commitée, elle doit être exploitable — pas juste présente."""

    def test_la_courbe_p90_si_elle_existe_est_valide(self):
        payload = api_app._load_cell_rebase_curve("p90")
        if payload is None:
            self.skipTest("aucune courbe p90 livrée à ce stade")
        courbe = wl.normalize_rebase_curve(payload["curve"])
        self.assertIsNotNone(courbe)
        self.assertGreaterEqual(len(courbe), 20, "courbe trop grossière")
        ys = [y for _, y in courbe]
        self.assertEqual(ys, sorted(ys), "courbe non monotone")
        self.assertTrue(all(0 <= y <= 100 for y in ys), "valeurs hors de l'échelle 0-100")

    def test_la_courbe_porte_sa_provenance(self):
        payload = api_app._load_cell_rebase_curve("p90")
        if payload is None:
            self.skipTest("aucune courbe p90 livrée à ce stade")
        for cle in ("derived_at", "source", "pairs"):
            self.assertIn(cle, payload, f"provenance incomplète : {cle} manquant")


class LeRapportEtLaProductionDisentLaMemeChose(unittest.TestCase):
    """Le rapport de diagnostic annonce une distribution ré-ancrée. Si la production
    appliquait une AUTRE formule, ce chiffre ne vaudrait rien."""

    def test_une_seule_implementation(self):
        courbe = COURBE_REELLE
        normalisee = wl.normalize_rebase_curve(courbe)
        for score in (0, 12, 30, 32, 45, 52, 60, 66.75, 82, 100):
            self.assertAlmostEqual(
                api_app._apply_rebase_curve(courbe, score),
                wl.rebase_score(normalisee, score), places=9, msg=f"score {score}")

    def test_la_courbe_du_rapport_est_assez_fine(self):
        """41 points = pas de 2,5 % : la valeur qui décide du « ≥ 60 » tombait dans un
        intervalle contenant 2,5 % de la masse."""
        self.assertGreaterEqual(api_app.REBASE_CURVE_POINTS, 201)


class LeCalculEnTacheDeFond(unittest.TestCase):
    """Cloudflare coupe une requête à ~100 s. Le rapport de ré-ancrage dépasse ce délai dès
    que la collecte s'allonge : un 524 l'a prouvé en prod le 09/09/2026, exactement comme la
    collecte MTG-LI synchrone avant lui. Premier clic = lancement, second clic = rapport."""

    def setUp(self):
        with api_app._shadow_rebase_lock:
            api_app._shadow_rebase_state.clear()
            api_app._shadow_rebase_state.update({"etat": "jamais_lance"})
        chemin = api_app._meteofrance_persistent_cache_path(
            api_app._SHADOW_REBASE_NS, "rapport|seuil=1")
        if chemin.exists():
            chemin.unlink()

    @staticmethod
    def _appel(**kwargs):
        """⚠️ PIÈGE : appelée en direct, la coroutine reçoit les objets `Query(...)` comme
        valeurs par défaut — et un `Query(0)` est TRUTHY. Un test qui omet `refaire=0`
        emprunte donc la branche « recalcul » et croit à tort à un bug. On passe toujours
        TOUS les paramètres explicitement."""
        params = {"threshold": 1, "refaire": 0}
        params.update(kwargs)
        return asyncio.run(api_app.server_shadow_rebase(**params))

    def _attendre_fin(self, secondes: float = 5.0) -> None:
        import time
        limite = time.time() + secondes
        while time.time() < limite:
            with api_app._shadow_rebase_lock:
                if api_app._shadow_rebase_state.get("etat") in ("termine", "echec"):
                    return
            time.sleep(0.05)
        self.fail("le calcul de fond ne s'est jamais terminé")

    def test_l_endpoint_reste_reserve_a_l_administrateur(self):
        routes = [r for r in api_app.app.routes
                  if getattr(r, "path", None) == "/api/server/shadow-rebase"]
        self.assertTrue(routes)
        noms = {getattr(d.dependency, "__name__", "") for d in routes[0].dependencies}
        self.assertIn("_admin_secret_dep", noms)

    def test_le_premier_clic_lance_et_ne_bloque_pas(self):
        reponse = self._appel()
        self.assertTrue(reponse["etat_calcul"].get("lance"))
        self.assertIsNone(reponse["rapport"])
        self.assertIn("tâche de fond", reponse["message"])

    def test_le_second_clic_rend_le_rapport_sans_relancer(self):
        self._appel()
        self._attendre_fin()
        reponse = self._appel()
        self.assertIsNotNone(reponse["rapport"], "le rapport n'a pas été gardé")
        self.assertNotIn("lance", reponse["etat_calcul"],
                         "un second clic ne doit PAS relancer le calcul")
        self.assertIsNone(reponse.get("message"))

    def test_refaire_force_un_nouveau_calcul(self):
        self._appel()
        self._attendre_fin()
        reponse = self._appel(refaire=1)
        self.assertTrue(reponse["etat_calcul"].get("lance"))
        self._attendre_fin()

    def test_deux_clics_rapproches_ne_lancent_qu_un_calcul(self):
        """En local le rapport se calcule en 0 s : sans un calcul VOLONTAIREMENT lent, le
        second clic trouverait déjà le résultat et ne testerait pas la concurrence."""
        import time as _t
        vrai = api_app._shadow_rebase_report
        try:
            def _lent(**_kwargs):
                _t.sleep(0.6)
                return {"avertissements": [], "duree_s": 0.6}
            api_app._shadow_rebase_report = _lent
            premier = self._appel()
            second = self._appel()
            self.assertTrue(premier["etat_calcul"].get("lance"))
            self.assertFalse(second["etat_calcul"].get("lance"))
            self.assertIn("déjà en cours", second["message"])
            self._attendre_fin()
        finally:
            api_app._shadow_rebase_report = vrai

    def test_la_duree_est_toujours_rapportee(self):
        """Le rapport a dix sorties anticipées ; sans la durée sur chacune, on ne saurait pas
        laquelle a coûté un dépassement de délai."""
        rapport = api_app._shadow_rebase_report(with_threshold=False)
        self.assertIn("duree_s", rapport)
        self.assertIsInstance(rapport["duree_s"], float)

    def test_un_echec_de_calcul_ne_laisse_pas_l_etat_bloque_en_cours(self):
        """Sinon le bouton dirait « en cours » pour toujours et personne ne saurait pourquoi."""
        vrai = api_app._shadow_rebase_report
        try:
            def _casse(**_kwargs):
                raise RuntimeError("panne simulée")
            api_app._shadow_rebase_report = _casse
            self._appel()
            self._attendre_fin()
        finally:
            api_app._shadow_rebase_report = vrai
        with api_app._shadow_rebase_lock:
            etat = dict(api_app._shadow_rebase_state)
        self.assertEqual(etat["etat"], "echec")
        self.assertEqual(etat["raison"], "RuntimeError")


if __name__ == "__main__":
    unittest.main(verbosity=2)
