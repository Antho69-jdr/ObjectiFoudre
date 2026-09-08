"""Lisibilité des commandes posées SUR la carte (rails gauches + recherche).

Le défaut : ces boutons étaient quasi transparents (`--fill-ghost`, 3 % de blanc). Le
`backdrop-filter` ne rattrape pas une cellule de grille vive derrière — mesuré, l'icône
tombait à **1,01:1 sur une cellule jaune** et 2,53:1 sur une rouge, très loin des 4,5:1
exigés. Pire, l'état ACTIF était le plus mauvais de tous (1,39:1 en mode étoiles) parce
qu'il posait une teinte translucide par-dessus.

Depuis : fond OPAQUE = la couleur des TERRES de la carte du moment, icône = accent du
mode. Ces tests gardent deux choses qu'un œil ne reverra pas tout seul :
  1. les tokens CSS suivent bien les tables de teinte JS (si la carte change de couleur,
     les boutons doivent suivre, sinon ils flottent dessus au lieu de s'y fondre) ;
  2. aucun fond de ces boutons ne redevient translucide.
"""
import re
import unittest
from pathlib import Path

import app


STATIC = Path(app.STATIC_DIR)
STYLES = STATIC / "assets/src/styles"
TOKENS = (STYLES / "tokens.css").read_text(encoding="utf-8")

# Portées visées : uniquement les BOUTONS posés sur la carte.
CIBLES = ("grid-focus-btn", "best-cells-rail-btn", "mobile-toggle-btn",
          "#toggleSearchBtn", "#cityInput")


def _lin(c):
    c /= 255
    return c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4


def _lum(h):
    h = h.lstrip("#")
    r, g, b = (int(h[i:i + 2], 16) for i in (0, 2, 4))
    return 0.2126 * _lin(r) + 0.7152 * _lin(g) + 0.0722 * _lin(b)


def contraste(a, b):
    la, lb = _lum(a), _lum(b)
    hi, lo = max(la, lb), min(la, lb)
    return (hi + 0.05) / (lo + 0.05)


def token(nom, portee=None):
    """Valeur d'un token, dans :root ou dans un bloc `body.<mode>`."""
    bloc = TOKENS
    if portee:
        i = TOKENS.index("body.%s {" % portee)
        bloc = TOKENS[i:TOKENS.index("}", i)]
    m = re.search(r"--%s:\s*([^;]+);" % nom, bloc)
    return m.group(1).strip() if m else None


class PaletteSuitLaCarteTests(unittest.TestCase):
    """Le fond des boutons EST la couleur des terres — pas une valeur voisine choisie
    à l'œil. Si une carte est repeinte, ces tests le disent."""

    def test_carte_de_base(self):
        js = (STATIC / "assets/js/state.js").read_text(encoding="utf-8")
        m = re.search(r"setMapPaintIfLayer\('background',\s*'background-color',\s*'(#[0-9a-fA-F]{6})'\)", js)
        self.assertIsNotNone(m, "la couleur de fond de la carte de base a changé de forme")
        self.assertEqual(token("map-ground").lower(), m.group(1).lower(),
                         "--map-ground ne suit plus le fond posé par state.js")

    def _fond_de_table(self, fichier, table):
        js = (STATIC / ("assets/js/%s" % fichier)).read_text(encoding="utf-8")
        i = js.index(table)
        bloc = js[i:js.index("];", i)]
        m = re.search(r"\['background',\s*'background-color',\s*'(#[0-9a-fA-F]{6})'", bloc)
        self.assertIsNotNone(m, "%s : fond introuvable" % table)
        return m.group(1).lower()

    def test_mode_chasse(self):
        self.assertEqual(token("map-ground", "chase-mode").lower(),
                         self._fond_de_table("chase.js", "CHASE_MAP_TINT"),
                         "--map-ground du mode chasse ne suit plus CHASE_MAP_TINT")

    def test_mode_etoiles(self):
        self.assertEqual(token("map-ground", "stargaze-mode").lower(),
                         self._fond_de_table("stargaze.js", "STARGAZE_MAP_TINT"),
                         "--map-ground du mode étoiles ne suit plus STARGAZE_MAP_TINT")


class ContrasteTests(unittest.TestCase):
    def test_icone_sur_fond_bien_au_dela_du_minimum(self):
        """4,5:1 est le minimum AA ; on est à 7+ partout, autant le garder."""
        for portee, nom in ((None, "prévisions"), ("chase-mode", "chasse"), ("stargaze-mode", "étoiles")):
            fond, accent = token("map-ground", portee), token("map-accent", portee)
            r = contraste(fond, accent)
            self.assertGreaterEqual(round(r, 2), 7.0,
                                    "%s : icône %s sur %s → %.2f:1" % (nom, accent, fond, r))

    def test_etat_actif_aussi(self):
        """C'était le plus mauvais des trois états avant correction."""
        for portee, icone in ((None, "#ffffff"), ("chase-mode", "#ffffff"), ("stargaze-mode", "#ffe9b0")):
            fond = token("map-ground-on", portee)
            self.assertIsNotNone(fond, "le fond de l'état actif a disparu")
            self.assertGreaterEqual(round(contraste(fond, icone), 2), 7.0)

    def test_les_fonds_de_survol_et_d_actif_sont_opaques(self):
        """Un fond translucide rouvre la fenêtre sur la grille : le contraste calculé
        serait un mensonge."""
        for portee in (None, "chase-mode", "stargaze-mode"):
            for nom in ("map-ground", "map-ground-hover", "map-ground-on"):
                v = token(nom, portee)
                self.assertRegex(v, r"^#[0-9a-fA-F]{6}$",
                                 "%s (%s) doit être une couleur OPAQUE" % (nom, portee or ":root"))


class AucunFondTranslucideTests(unittest.TestCase):
    def test_aucun_bouton_sur_carte_ne_redevient_transparent(self):
        fautifs = []
        fichiers = list((STYLES / "components").glob("*.css")) + [STYLES / "theme.css"]
        for f in fichiers:
            texte = f.read_text(encoding="utf-8")
            for m in re.finditer(r"(^|\n)([^\n{}]+)\{([^}]*)\}", texte):
                sel, corps = m.group(2).strip(), m.group(3)
                if not any(c in sel for c in CIBLES):
                    continue
                # Le bandeau desktop (#rightRailScroll) n'est PAS posé sur la carte : ses
                # boutons reposent sur #appHeaderBar, une bande de verre qui leur sert de
                # fond. Hors périmètre — sa translucidité est un choix visuel assumé.
                if "#rightRailScroll" in sel:
                    continue
                for bg in re.findall(r"background(?:-color)?:\s*(rgba\([^)]*\))", corps):
                    alpha = float(bg.rstrip(")").split(",")[-1])
                    if alpha < 1:
                        fautifs.append("%s → %s : %s" % (f.name, sel[:60], bg))
        self.assertEqual(fautifs, [],
                         "fond translucide sur un bouton posé sur la carte :\n  "
                         + "\n  ".join(fautifs))

    def test_le_css_est_dans_le_bundle_reellement_servi(self):
        css = (STATIC / "assets/dist/theme.css").read_text(encoding="utf-8")
        for marqueur in ("--map-ground", "--map-accent"):
            self.assertTrue(marqueur in css,
                            "%s absent de theme.css : `node build.mjs` oublié" % marqueur)


if __name__ == "__main__":
    unittest.main()
