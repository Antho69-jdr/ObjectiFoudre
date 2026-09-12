"""Les heures de la frise se DÉRIVENT du créneau, jamais du seul `slot_label`.

Le payload compact du serveur n'émet que `slot_key` (`h07`) : il n'y a pas de raison
d'envoyer deux fois la même information. `slot_label` (`07h`) n'existe donc que sur la
« coquille » fabriquée côté front (`buildAromeFranceShellPayload`, data.js), c'est-à-dire
seulement pour le jour déjà hydraté.

Conséquence mesurée en prod (v1.3.282) sur le jour SUIVANT :
  - rail desktop : les 24 `.timeline-hour-label` recevaient une chaîne vide, donc une
    hauteur de 0 px — aucune heure visible sous la frise ;
  - les 48 infobulles (rail + molette) annonçaient « undefined · AROME GRIB chargé ».
La molette, elle, passait déjà par `timelineSlotHourLabel()` et s'en sortait : c'est ce
helper qui est le point de vérité, parce qu'il replie sur `slot_key`.
"""
import re
import unittest
from pathlib import Path

import app


JS = Path(app.STATIC_DIR) / "assets" / "js"
WHEEL = JS / "timeline-wheel.js"
SOLAR = JS / "timeline-solar.js"


def sans_commentaires(source: str) -> str:
    """Retire les commentaires : un `slot_label` cité dans une explication n'est pas un bug."""
    source = re.sub(r"/\*.*?\*/", "", source, flags=re.S)
    return re.sub(r"^\s*//.*$", "", source, flags=re.M)


class TimelineHourLabelTests(unittest.TestCase):
    def test_le_helper_replie_sur_slot_key(self):
        """`timelineSlotHourLabel` est le seul point de vérité : il doit lire les deux champs."""
        corps = re.search(r"function timelineSlotHourLabel\(slot\)\s*\{(.*?)\n\s*\}",
                          SOLAR.read_text(encoding="utf-8"), re.S)
        self.assertIsNotNone(corps, "timelineSlotHourLabel a disparu de timeline-solar.js")
        self.assertIn("slot_label", corps.group(1))
        self.assertIn("slot_key", corps.group(1),
                      "le repli sur slot_key a sauté : les heures redeviendraient vides "
                      "sur tout jour servi par le payload compact")

    def test_aucune_lecture_de_slot_label_sans_repli(self):
        """Dans la frise, tout `slot_label` lu doit être suivi d'un repli sur `slot_key`."""
        source = sans_commentaires(WHEEL.read_text(encoding="utf-8"))
        nus = []
        for m in re.finditer(r"slot_label", source):
            debut_ligne = source.rfind("\n", 0, m.start()) + 1
            fin_ligne = source.find("\n", m.start())
            ligne = source[debut_ligne:fin_ligne if fin_ligne != -1 else len(source)]
            # Un dump de diagnostic liste volontairement les deux champs pour montrer
            # lequel manque : ce n'est pas un rendu, rien ne s'affiche à l'utilisateur.
            if "debugLog" in ligne:
                continue
            fenetre = source[m.start():m.start() + 80]
            if not re.search(r"slot_label\s*\|\|\s*[\w.?]*slot[_.]?key", fenetre, re.I):
                nus.append(ligne.strip()[:110])
        self.assertEqual(nus, [], "slot_label lu SANS repli sur slot_key : %s" % nus)

    def test_le_libelle_du_rail_passe_par_le_helper(self):
        """Le rail desktop doit dériver l'heure comme la molette, pas la relire à sa façon."""
        source = sans_commentaires(WHEEL.read_text(encoding="utf-8"))
        pose = re.search(r"label\.className\s*=\s*['\"]timeline-hour-label['\"]\s*;(.{0,220})",
                         source, re.S)
        self.assertIsNotNone(pose, "la pose du libellé d'heure du rail est introuvable")
        self.assertIn("timelineSlotHourLabel", pose.group(1),
                      "le rail n'utilise plus le helper partagé : c'est exactement la "
                      "divergence qui avait vidé les 24 heures du jour suivant")

    def test_l_infobulle_derive_aussi_l_heure(self):
        """Les infobulles partagées molette+rail ne doivent pas interpoler `slot_label` brut."""
        source = sans_commentaires(WHEEL.read_text(encoding="utf-8"))
        etat = re.search(r"function timelineSlotRenderState\(slot, day\)\s*\{(.*?)\n\s{4}\}",
                         source, re.S)
        self.assertIsNotNone(etat, "timelineSlotRenderState est introuvable")
        self.assertNotIn("${slot.slot_label}", etat.group(1),
                         "slot_label interpolé brut : les infobulles rediraient "
                         "« undefined · AROME GRIB chargé » dès le jour suivant")
        self.assertIn("timelineSlotHourLabel", etat.group(1))


if __name__ == "__main__":
    unittest.main(verbosity=2)
