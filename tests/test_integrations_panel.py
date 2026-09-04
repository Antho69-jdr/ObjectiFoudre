"""Auto-tests du panneau « Clés & intégrations » de la page maintenance.

Le panneau existe pour répondre à « est-ce en place et est-ce que ça marche », SANS jamais
transporter un secret vers le navigateur. Le premier test est le plus important du fichier :
il échoue si une valeur de secret réapparaît un jour dans la sortie, quelle qu'en soit la
raison.
"""
import json
import os
import unittest
from unittest.mock import patch

import app


SECRET = "SUPER-SECRET-VALEUR-DE-TEST-8f2c19ab4d"


class AucuneFuiteTests(unittest.TestCase):
    def test_aucune_valeur_de_secret_dans_la_sortie(self):
        """LE test du fichier. On pose une valeur reconnaissable sur CHAQUE variable que
        le panneau sait lire, puis on cherche cette chaîne dans tout le JSON produit."""
        noms = set()
        for spec in app._INTEGRATIONS:
            noms.update(spec.get("env", ()))
            noms.update(spec.get("compagnon", ()))
        faux = {n: SECRET for n in noms}
        faux["OBJECTIFOUDRE_ADMIN_EMAILS"] = "moi@exemple.fr,toi@exemple.fr"
        with patch.dict(os.environ, faux, clear=False):
            sortie = json.dumps(app._integrations_status(), ensure_ascii=False)
        self.assertNotIn(SECRET, sortie, "une valeur de secret a fuité dans le panneau")
        # même tronquée : aucun fragment significatif ne doit apparaître
        for n in (8, 12, 16):
            self.assertNotIn(SECRET[:n], sortie, "un préfixe de secret a fuité")
            self.assertNotIn(SECRET[-n:], sortie, "un suffixe de secret a fuité")

    def test_les_adresses_admin_ne_sont_pas_empreintees(self):
        """Une adresse e-mail est devinable : une empreinte serait retrouvable par force
        brute sur un dictionnaire. On ne publie que le nombre."""
        with patch.dict(os.environ, {"OBJECTIFOUDRE_ADMIN_EMAILS": "moi@exemple.fr"}, clear=False):
            st = app._integrations_status()
        ligne = next(i for i in st["items"] if i["key"] == "admin_emails")
        self.assertIsNone(ligne["fingerprint"])
        self.assertEqual(ligne["detail"], "1 adresse")
        self.assertNotIn("moi@exemple.fr", json.dumps(st, ensure_ascii=False))


class EmpreinteTests(unittest.TestCase):
    def test_stable_et_discriminante(self):
        a = app._secret_fingerprint("cle-A")
        self.assertEqual(a, app._secret_fingerprint("cle-A"), "doit être reproductible")
        self.assertNotEqual(a, app._secret_fingerprint("cle-B"))
        self.assertEqual(len(a), 8)

    def test_insensible_aux_espaces_de_bord(self):
        """Un fichier de clé finit souvent par un retour à la ligne ; l'empreinte doit
        rester comparable à celle de la même clé posée en variable."""
        self.assertEqual(app._secret_fingerprint(" cle \n"), app._secret_fingerprint("cle"))

    def test_valeur_vide(self):
        self.assertIsNone(app._secret_fingerprint(None))
        self.assertIsNone(app._secret_fingerprint(""))


class MiroirDesAccesseursTests(unittest.TestCase):
    """Le panneau réimplémente la résolution des clés ; s'il dérive des accesseurs réels,
    il affichera « configurée » là où le serveur ne trouve rien. Ces tests l'interdisent."""

    def _panneau(self, cle):
        return next(i for i in app._integrations_status()["items"] if i["key"] == cle)

    def test_arome_pi_dit_la_meme_chose_que_laccesseur(self):
        self.assertEqual(self._panneau("arome_pi")["configured"], bool(app._aromepi_api_key()))

    def test_radar_dit_la_meme_chose_que_laccesseur(self):
        self.assertEqual(self._panneau("radar")["configured"], bool(app._fr_radar_api_key()))

    def test_radar_cible_dit_la_meme_chose_que_laccesseur(self):
        self.assertEqual(self._panneau("radar_cible")["configured"], bool(app._fr_radar_cible_api_key()))

    def test_la_variable_prime_sur_le_fichier(self):
        """Même précédence que les accesseurs : variable d'environnement d'abord."""
        with patch.dict(os.environ, {"METEOFRANCE_RADAR_API_KEY": SECRET}, clear=False):
            p = self._panneau("radar")
        self.assertTrue(p["configured"])
        self.assertEqual(p["source"], "env:METEOFRANCE_RADAR_API_KEY")


class SignalementTests(unittest.TestCase):
    def test_integration_incomplete_signalee(self):
        """Une clé sans son secret compagnon ne marchera pas : il faut le dire."""
        with patch.dict(os.environ, {"EUMETSAT_CONSUMER_KEY": SECRET,
                                     "EUMETSAT_CONSUMER_SECRET": "",
                                     "EUMDAC_SECRET": ""}, clear=False):
            p = next(i for i in app._integrations_status()["items"] if i["key"] == "eumetsat")
        self.assertTrue(p["configured"])
        self.assertIn("incomplète", p.get("warning", ""))

    def test_compte_et_total_coherents(self):
        st = app._integrations_status()
        self.assertEqual(st["total"], len(st["items"]))
        self.assertEqual(st["configured"], sum(1 for i in st["items"] if i["configured"]))


if __name__ == "__main__":
    unittest.main()
