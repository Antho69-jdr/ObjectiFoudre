"""Auto-tests du journal d'ombre GII (étape 1 de l'audit MTG-LI).

Le journal existe pour répondre à UNE question : le trou de couverture GII devance-t-il
le premier écho radar ? Ces tests vérifient que le dispositif est inerte tant qu'on ne
l'active pas, que le comptage par maille est juste, et surtout que l'analyse retrouve un
basculement qu'on y a délibérément placé — c'est là que se cachent les décalages d'indice.
"""
import gzip
import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import app


class CleDeMailleTests(unittest.TestCase):
    def test_coin_sud_ouest(self):
        self.assertEqual(app._gii_cell_key(45.0, 3.0), "45.0|3.0")
        self.assertEqual(app._gii_cell_key(45.4, 3.7), "45.0|3.5")

    def test_longitudes_negatives(self):
        """math.floor sur un négatif descend : -0.01 doit tomber dans la maille -0.5,
        pas dans 0.0. Une erreur ici décalerait tout l'ouest de la France."""
        self.assertEqual(app._gii_cell_key(44.99, -0.01), "44.5|-0.5")
        self.assertEqual(app._gii_cell_key(43.0, -4.75), "43.0|-5.0")

    def test_bord_exact(self):
        self.assertEqual(app._gii_cell_key(45.5, 3.5), "45.5|3.5")


class InertieTests(unittest.TestCase):
    def test_desactive_par_defaut(self):
        """Rien ne doit partir sur le réseau tant qu'OBJECTIFOUDRE_GII_SHADOW n'est pas posé."""
        with patch.object(app, "OBJECTIFOUDRE_GII_SHADOW", False):
            self.assertEqual(app._gii_shadow_tick(), "disabled")

    def test_etat_lisible_meme_sans_journal(self):
        with tempfile.TemporaryDirectory() as d:
            with patch.object(app, "OBJECTIFOUDRE_HISTORY_DIR", Path(d)):
                etat = app._gii_shadow_status()
        self.assertFalse(etat["enabled"])
        self.assertEqual(etat["days"], 0)

    def test_un_echec_ne_relance_pas_toutes_les_deux_minutes(self):
        """La cadence normale est gardée par `last_tick`, qui n'avance qu'au SUCCÈS. Sans
        temporisation sur la dernière TENTATIVE, un échec ferait retenter la boucle toutes
        les 2 min pendant tout l'épisode — jusqu'à 30 tirs de 14 Mo par heure."""
        import time as _t
        with tempfile.TemporaryDirectory() as d:
            with patch.object(app, "OBJECTIFOUDRE_GII_SHADOW", True), \
                 patch.object(app, "OBJECTIFOUDRE_HISTORY_ENABLED", True), \
                 patch.object(app, "OBJECTIFOUDRE_HISTORY_DIR", Path(d)), \
                 patch.object(app, "_gii_shadow_radar_cells",
                              return_value={"45.0|3.0": {"n": 1, "age_min": 5}}), \
                 patch.object(app, "_gii_fetch_latest", side_effect=OSError("EUMETSAT KO")) as tir:
                app._gii_shadow_state.update(last_tick=0.0, last_active=_t.time(),
                                             last_attempt=0.0, failures=0)
                self.assertEqual(app._gii_shadow_tick(), "fetch_failed")
                self.assertEqual(app._gii_shadow_tick(), "backoff")
                self.assertEqual(app._gii_shadow_tick(), "backoff")
                self.assertEqual(tir.call_count, 1, "un seul tir réseau pour trois passages")
                self.assertEqual(app._gii_shadow_state["failures"], 1)

    def test_rien_les_jours_calmes(self):
        """Sans activité convective récente, le journal n'écrit pas — c'est ce qui rend
        le dispositif gratuit hors épisode orageux."""
        with tempfile.TemporaryDirectory() as d:
            with patch.object(app, "OBJECTIFOUDRE_GII_SHADOW", True), \
                 patch.object(app, "OBJECTIFOUDRE_HISTORY_ENABLED", True), \
                 patch.object(app, "OBJECTIFOUDRE_HISTORY_DIR", Path(d)), \
                 patch.object(app, "_gii_shadow_radar_cells", return_value={}):
                app._gii_shadow_state["last_active"] = 0.0
                self.assertEqual(app._gii_shadow_tick(), "calm")


class AnalyseTests(unittest.TestCase):
    """Journal synthétique : le radar voit la cellule au pas 8, et on a fait s'effondrer
    la couverture GII à partir du pas 6, soit 60 min avant. L'analyse doit le retrouver."""

    CIBLE = "45.0|3.0"
    PAS = 30 * 60
    T0 = 1_700_000_000

    def _journal(self, dossier):
        """Grille UNIFORME (couverture 10 partout), dans laquelle on creuse le voisinage
        de la cible à partir du pas 6. Uniforme = les témoins que l'analyse ira chercher
        d'elle-même ont tous la même couverture, donc le rapport attendu vaut exactement 1
        avant l'effondrement. Une grille clairsemée donnerait un rapport faussé par les
        mailles vides — c'est le piège qu'a révélé la première version de ce test."""
        d = app.GII_SHADOW_CELL_DEG
        mailles = ["%.1f|%.1f" % (42.0 + a * d, 0.0 + b * d)
                   for a in range(15) for b in range(15)]
        cible_bloc = {"%.1f|%.1f" % (45.0 + a * d, 3.0 + b * d)
                      for a in (-2, -1, 0, 1, 2) for b in (-2, -1, 0, 1, 2)}
        lignes = []
        for i in range(13):
            creuse = i >= 6
            gii = {m: (1 if (creuse and m in cible_bloc) else 10) for m in mailles}
            radar = {self.CIBLE: {"n": 1, "age_min": 5, "ouvert": False}} if i >= 8 else {}
            lignes.append({"schema": 1, "at": self.T0 + i * self.PAS, "gii_end": "",
                           "cell_deg": d, "gii": gii, "radar": radar})
        p = Path(dossier) / "gii_shadow" / "2026-08-27.jsonl.gz"
        p.parent.mkdir(parents=True, exist_ok=True)
        with gzip.open(p, "wt", encoding="utf-8") as fh:
            for l in lignes:
                fh.write(json.dumps(l) + "\n")

    def test_retrouve_le_basculement_pose(self):
        with tempfile.TemporaryDirectory() as d:
            self._journal(d)
            with patch.object(app, "OBJECTIFOUDRE_HISTORY_DIR", Path(d)):
                rap = app._gii_shadow_report()
        lignes = {l["minutes_avant_echo_radar"]: l for l in rap["avant_premier_echo_radar"]}
        self.assertEqual(rap["evenements_radar"], 1)
        # avant l'effondrement : couverture au niveau des témoins
        self.assertAlmostEqual(lignes[-120]["rapport"], 1.0, places=2)
        self.assertAlmostEqual(lignes[-90]["rapport"], 1.0, places=2)
        # après : effondrée à un dixième
        # après : effondrée. Le seuil est 0,5 et non 0,1 parce que les témoins les plus
        # proches (3 cases) voient leur propre bloc mordre sur le trou — une dilution
        # inhérente à la méthode, qui rend la mesure CONSERVATRICE.
        self.assertLess(lignes[-60]["rapport"], 0.5)
        self.assertLess(lignes[0]["rapport"], 0.5)

    def test_previent_quand_il_y_a_trop_peu_de_matiere(self):
        with tempfile.TemporaryDirectory() as d:
            self._journal(d)
            with patch.object(app, "OBJECTIFOUDRE_HISTORY_DIR", Path(d)):
                rap = app._gii_shadow_report()
        self.assertTrue(any("trop peu" in a for a in rap["avertissements"]),
                        "un seul événement doit être signalé comme insuffisant")


if __name__ == "__main__":
    unittest.main()
