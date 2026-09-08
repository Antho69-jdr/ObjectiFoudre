"""Réduction d'une surface en bulle flottante (minimize-bubble.js).

Le problème d'origine, mesuré en portrait 390×844 : la feuille « Autour de moi » du mode
étoiles occupait 386 px sur 844 (46 % de l'écran) et ne laissait que 306 px de carte — or
la carte EST le résultat (anneau du rayon, cellules et spots surlignés). Pire, le moindre
geste sur la carte fermait la feuille ET effaçait l'anneau (`closeGeoSheet` appelle
`geoClearMap`).

Depuis : la feuille se REPLIE en pastille déplaçable. Ces tests gardent le câblage, pas le
comportement au doigt — celui-là se vérifie au navigateur (fait : appui = rouvre, glissé =
déplace et mémorise, geste sur la carte = replie sans rien perdre).
"""
import re
import unittest
from pathlib import Path

import app


STATIC = Path(app.STATIC_DIR)
INDEX = (STATIC / "index.html").read_text(encoding="utf-8")
JS = (STATIC / "assets/js/minimize-bubble.js").read_text(encoding="utf-8")
STARGAZE = (STATIC / "assets/js/stargaze.js").read_text(encoding="utf-8")


class ChargementTests(unittest.TestCase):
    def test_le_module_est_charge_avant_stargaze(self):
        """stargaze.js appelle window.OFBubble : il doit exister à ce moment-là."""
        i_b = INDEX.find("/assets/js/minimize-bubble.js")
        i_s = INDEX.find("/assets/js/stargaze.js")
        self.assertNotEqual(i_b, -1, "minimize-bubble.js n'est pas chargé par index.html")
        self.assertLess(i_b, i_s, "minimize-bubble.js doit être chargé AVANT stargaze.js")

    def test_le_css_est_dans_le_bundle_reellement_servi(self):
        """index.css → dist/app.css ne sert QUE le styleguide ; la page charge theme.css."""
        css = (STATIC / "assets/dist/theme.css").read_text(encoding="utf-8")
        for marqueur in (".of-bubble", ".of-minimized", ".sg-geo-min"):
            self.assertTrue(marqueur in css,
                            f"{marqueur} absent de theme.css : `node build.mjs` oublié, ou "
                            f"composant importé dans le mauvais bundle")

    def test_le_bouton_reduire_existe(self):
        self.assertIn('id="sgGeoMin"', INDEX)
        self.assertIn("Réduire en bulle", INDEX)


class ComportementTests(unittest.TestCase):
    def test_un_geste_dehors_replie_au_lieu_de_fermer(self):
        """C'était LE défaut : déplacer la carte — le geste le plus naturel une fois
        localisé — fermait la feuille et effaçait l'anneau."""
        # stargaze.js enregistre PLUSIEURS surfaces auprès d'OFDismiss (bulles de la
        # frise solaire, feuille géoloc) : on vise celle de la feuille, pas la première.
        depart = STARGAZE.index("function ensureGeoSheet")
        bloc = STARGAZE[depart:]
        bloc = bloc[bloc.index("window.OFDismiss.register({"):]
        bloc = bloc[:bloc.index("});")]
        self.assertIn("minimize()", bloc,
                      "le tap dehors doit REPLIER la feuille, pas la fermer")
        self.assertNotIn("close: closeGeoSheet", bloc)

    def test_la_croix_ferme_toujours_pour_de_bon(self):
        self.assertIn("q('sgGeoClose').addEventListener('click', closeGeoSheet)", STARGAZE)

    def test_fermer_fait_tomber_la_bulle(self):
        """Sinon la pastille survivrait à une feuille fermée, sans rien derrière."""
        bloc = STARGAZE[STARGAZE.index("function closeGeoSheet()"):]
        bloc = bloc[:bloc.index("function geoClearMap")]
        self.assertIn("geoBubble.hide()", bloc)

    def test_le_bouton_du_rail_ramene_la_feuille_repliee(self):
        bloc = STARGAZE[STARGAZE.index("function autourDeMoi()"):]
        bloc = bloc[:bloc.index("function closeGeoSheet")]
        self.assertIn("geoBubble.restore()", bloc)

    def test_appui_et_glisse_sont_distingues(self):
        """Au doigt, un appui bouge toujours de un ou deux pixels : sans seuil, on ne
        pourrait jamais rouvrir la surface sans la déplacer."""
        m = re.search(r"SEUIL_GLISSE = (\d+)", JS)
        self.assertIsNotNone(m, "le seuil appui/glissé a disparu")
        self.assertGreaterEqual(int(m.group(1)), 4)
        self.assertIn("if (!aBouge) restore();", JS)

    def test_la_bulle_reste_attrapable(self):
        """Bornée au viewport, et re-bornée au redimensionnement (rotation, clavier)."""
        self.assertIn("function borner", JS)
        self.assertRegex(JS, r"addEventListener\('resize'")

    def test_le_doigt_deplace_la_bulle_et_ne_defile_pas(self):
        css = (STATIC / "assets/src/styles/components/bubble.css").read_text(encoding="utf-8")
        self.assertIn("touch-action: none", css)

    def test_la_position_est_memorisee(self):
        self.assertIn("localStorage.setItem(key", JS)
        self.assertIn("ofBubble:", JS)


if __name__ == "__main__":
    unittest.main()
