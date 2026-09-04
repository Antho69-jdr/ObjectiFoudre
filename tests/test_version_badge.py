"""Le numéro de version affiché doit venir d'APP_VERSION, jamais d'un littéral.

Il avait été écrit en dur dans index.html à trois endroits — bandeau visible,
`data-app-version` et version jointe à chaque rapport de plantage client. La procédure
de bump ne remplaçant que les `?v=`, il est resté figé sur 1.3.238 de la v1.3.239 à la
v1.3.258 : vingt versions de bandeau faux et de rapports d'erreur mal étiquetés.
"""
import re
import unittest
from pathlib import Path

import app


INDEX = Path(app.STATIC_DIR) / "index.html"


class VersionBadgeTests(unittest.TestCase):
    def test_aucune_version_en_dur_hors_cache_busting(self):
        """Les seuls numéros de version tolérés dans la source sont les `?v=`,
        que la procédure de déploiement remplace déjà."""
        source = INDEX.read_text(encoding="utf-8")
        sans_cache_bust = re.sub(r"\?v=\d+\.\d+\.\d+", "", source)
        en_dur = re.findall(r"\bv?\d+\.\d+\.\d{2,}\b", sans_cache_bust)
        self.assertEqual(
            en_dur, [],
            "version(s) écrite(s) en dur dans index.html : %s — utiliser "
            "__APP_VERSION__, injecté par _render_index_html()" % en_dur)

    def test_le_gabarit_porte_bien_le_marqueur(self):
        source = INDEX.read_text(encoding="utf-8")
        self.assertIn("__APP_VERSION__", source,
                      "le marqueur a disparu : le bandeau ne serait plus alimenté")

    def test_le_rendu_substitue_la_version(self):
        html = app._render_index_html()
        self.assertNotIn("__APP_VERSION__", html, "marqueur non substitué à la volée")
        self.assertIn(app.APP_VERSION, html)

    def test_le_bandeau_affiche_la_version_courante(self):
        html = app._render_index_html()
        badge = re.search(r'id="versionBadge"[^>]*>([^<]*)', html)
        self.assertIsNotNone(badge, "bandeau de version introuvable")
        self.assertIn(app.APP_VERSION, badge.group(1))

    def test_le_rapporteur_de_plantage_envoie_la_version_courante(self):
        """Sans ça, les rapports d'erreur sont inexploitables : ils désignent tous
        la même vieille version."""
        html = app._render_index_html()
        envoye = re.search(r"version: '([^']*)'", html)
        self.assertIsNotNone(envoye, "champ `version` du rapporteur introuvable")
        self.assertEqual(envoye.group(1), app.APP_VERSION)

    def test_le_rendu_est_mis_en_cache(self):
        """Une lecture disque par requête sur la page d'accueil serait du gaspillage."""
        a = app._render_index_html()
        b = app._render_index_html()
        self.assertIs(a, b)


if __name__ == "__main__":
    unittest.main()
