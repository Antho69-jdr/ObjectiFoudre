"""Balayage de seuil en voisinage : la version rapide doit dire EXACTEMENT la même chose.

`best_threshold_neighborhood` appelait `skill_neighborhood` 99 fois, et chaque appel refaisait
l'appariement complet prévu × observé. Mesuré sur 42 journées réelles : **363 s** pour un seul
balayage — et `evaluate_and_select` en déclenche **huit** par réentraînement, toutes les 6 h.

La version actuelle sort les invariants (le maximum de score du voisinage d'une cellule
foudroyée, et le fait qu'une cellule ait ou non de la foudre à proximité, ne dépendent pas du
seuil) et ramène le balayage à deux recherches dichotomiques. Mesuré : **0,70 s**.

CE QUE CES TESTS PROTÈGENT, dans l'ordre :

1. **L'ÉGALITÉ.** Une optimisation qui change le résultat d'un cheveu déplacerait le seuil
   appris, donc la page Vérification et les décisions d'activation du modèle. On compare donc
   à une implémentation de RÉFÉRENCE — la définition écrite dans la docstring, à savoir
   `verification.compute_verification` jour par jour — sur **tous** les seuils, aux deux
   rayons, et sur des jeux tirés au sort. La référence vit ici, dans le test : c'est la
   spécification, pas un souvenir du code précédent.
2. **LA SIGNATURE.** `skill_neighborhood` rend toujours brier/csi/hss et la table complète :
   `evaluate_and_select` en dépend.
3. **LES BORDS.** Aucun positif, que des positifs, une seule journée, des cellules sans
   coordonnées — autant de cas où une division par zéro ou un `max()` sur du vide casserait
   un réentraînement nocturne sans que personne ne le voie.
"""
import random
import unittest

import learning
import verification


# ── Implémentation de RÉFÉRENCE : la définition, pas l'ancien code ────────────
def reference_table(examples, scores, threshold, *, neighborhood_km, flash_threshold=1):
    """« Regrouper par jour, appeler verification.compute_verification, sommer. »"""
    by_date = {}
    for ex, sc in zip(examples, scores):
        by_date.setdefault(ex["date"], []).append((ex, float(sc)))
    H = M = FA = CN = 0
    for items in by_date.values():
        cells = [{"lat": ex.get("lat"), "lon": ex.get("lon"), "trigger_score": sc}
                 for ex, sc in items]
        fpc = {
            verification.cell_key(ex["lat"], ex["lon"]): 1.0
            for ex, _sc in items
            if ex.get("lat") is not None and ex["label"] >= flash_threshold
        }
        c = verification.compute_verification(
            cells, fpc, score_threshold=threshold, flash_threshold=flash_threshold,
            neighborhood_km=neighborhood_km)["contingency"]
        H += c["hits"]; M += c["misses"]; FA += c["false_alarms"]; CN += c["correct_negatives"]
    return H, M, FA, CN


def _table(skill):
    return (skill["hits"], skill["misses"], skill["false_alarms"], skill["correct_negatives"])


def jeu(rng, *, jours=2, cote=12, part_foudre=0.25):
    """Grille régulière façon France (0,135° × 0,18°) + une tache de foudre décalée."""
    examples, scores = [], []
    for j in range(jours):
        date = f"2026-06-{10 + j:02d}"
        centre_i = rng.randrange(cote)
        centre_j = rng.randrange(cote)
        rayon_tache = max(1, int(cote * part_foudre))
        for i in range(cote):
            for k in range(cote):
                lat = 45.0 + i * 0.135
                lon = 2.0 + k * 0.18
                score = rng.randrange(0, 101)
                touche = abs(i - centre_i) <= rayon_tache and abs(k - centre_j) <= rayon_tache
                examples.append({"date": date, "lat": lat, "lon": lon,
                                 "label": 1 if touche else 0, "trigger": score})
                scores.append(float(score))
    return examples, scores


class EgaliteAvecLaReference(unittest.TestCase):
    """Le cœur : même table de contingence, tous seuils, tous rayons."""

    def _compare(self, examples, scores, rayon, message=""):
        for thr in range(1, 100):
            attendu = reference_table(examples, scores, thr, neighborhood_km=rayon)
            obtenu = _table(learning.skill_neighborhood(
                examples, scores, thr, neighborhood_km=rayon))
            self.assertEqual(obtenu, attendu,
                             f"{message} rayon {rayon} km, seuil {thr}")

    def test_voisinage_30_km_les_99_seuils(self):
        rng = random.Random(20260909)
        self._compare(*jeu(rng), 30.0)

    def test_cellule_exacte_les_99_seuils(self):
        """Rayon nul : le voisinage se réduit à la cellule. Chemin de code distinct."""
        rng = random.Random(20260909)
        self._compare(*jeu(rng), 0.0)

    def test_plusieurs_jeux_tires_au_sort(self):
        for graine in (1, 7, 42, 2026):
            rng = random.Random(graine)
            examples, scores = jeu(rng, jours=3, cote=9,
                                   part_foudre=rng.choice([0.1, 0.3, 0.5]))
            self._compare(examples, scores, 30.0, message=f"graine {graine} :")

    def test_rayon_large_toutes_les_cellules_se_voient(self):
        rng = random.Random(3)
        self._compare(*jeu(rng, jours=1, cote=8), 500.0)

    def test_le_seuil_retenu_est_le_meme_que_par_la_reference(self):
        rng = random.Random(11)
        examples, scores = jeu(rng, jours=3, cote=10)
        meilleur_thr, meilleur_csi = learning.BASELINE_THRESHOLD, -1.0
        for thr in range(1, 100):
            H, M, FA, _CN = reference_table(examples, scores, thr, neighborhood_km=30.0)
            csi = round(H / (H + M + FA), 4) if (H + M + FA) else 0.0
            if csi > meilleur_csi + 1e-9 or (abs(csi - meilleur_csi) <= 1e-9 and thr > meilleur_thr):
                meilleur_csi, meilleur_thr = csi, thr
        self.assertEqual(learning.best_threshold_neighborhood(examples, scores),
                         (meilleur_thr, round(meilleur_csi, 4)))


class LaSignatureNeBougePas(unittest.TestCase):
    """`evaluate_and_select` lit csi, hss, brier ET la table : rien ne doit disparaître."""

    def setUp(self):
        self.examples, self.scores = jeu(random.Random(5), jours=2, cote=10)

    def test_toutes_les_cles_sont_la(self):
        skill = learning.skill_neighborhood(self.examples, self.scores, 50)
        self.assertEqual(set(skill), {"csi", "hss", "brier", "hits", "misses",
                                      "false_alarms", "correct_negatives"})

    def test_le_brier_est_toujours_calcule(self):
        """Il a été retiré du BALAYAGE (il ne dépend pas du seuil), pas de la fonction."""
        skill = learning.skill_neighborhood(self.examples, self.scores, 50)
        attendu = sum((min(max(s / 100.0, 0.0), 1.0) - ex["label"]) ** 2
                      for ex, s in zip(self.examples, self.scores)) / len(self.scores)
        self.assertAlmostEqual(skill["brier"], round(attendu, 4), places=4)

    def test_le_brier_ne_depend_pas_du_seuil(self):
        valeurs = {learning.skill_neighborhood(self.examples, self.scores, t)["brier"]
                   for t in (1, 25, 50, 75, 99)}
        self.assertEqual(len(valeurs), 1)

    def test_reutiliser_la_preparation_donne_le_meme_resultat(self):
        prepare = learning._prepare_neighborhood(self.examples, self.scores,
                                                 neighborhood_km=30.0)
        for thr in (10, 40, 60, 90):
            sans = learning.skill_neighborhood(self.examples, self.scores, thr)
            avec = learning.skill_neighborhood(self.examples, self.scores, thr,
                                               prepared=prepare)
            self.assertEqual(sans, avec, f"seuil {thr}")


class LesBords(unittest.TestCase):

    def test_aucun_exemple(self):
        skill = learning.skill_neighborhood([], [], 50)
        self.assertEqual(_table(skill), (0, 0, 0, 0))
        self.assertEqual(skill["csi"], 0.0)
        self.assertEqual(skill["brier"], 0.0)
        # Tous les seuils donnent CSI 0 → le départage « seuil le plus haut » rend 99.
        # C'est bien ce que faisait l'ancienne implémentation : le seuil de repli
        # BASELINE_THRESHOLD n'est jamais rendu, il est écrasé dès la première itération.
        self.assertEqual(learning.best_threshold_neighborhood([], []), (99, 0.0))

    def test_aucune_foudre_observee(self):
        ex, sc = jeu(random.Random(2), jours=1, cote=8)
        for e in ex:
            e["label"] = 0
        for thr in (1, 50, 99):
            self.assertEqual(_table(learning.skill_neighborhood(ex, sc, thr)),
                             reference_table(ex, sc, thr, neighborhood_km=30.0))

    def test_toutes_les_cellules_foudroyees(self):
        ex, sc = jeu(random.Random(2), jours=1, cote=8)
        for e in ex:
            e["label"] = 1
        for thr in (1, 50, 99):
            self.assertEqual(_table(learning.skill_neighborhood(ex, sc, thr)),
                             reference_table(ex, sc, thr, neighborhood_km=30.0))

    def test_une_cellule_sans_coordonnees_est_ignoree_pas_devinee(self):
        ex, sc = jeu(random.Random(2), jours=1, cote=6)
        ex.append({"date": ex[0]["date"], "lat": None, "lon": None, "label": 1, "trigger": 90})
        sc.append(90.0)
        skill = learning.skill_neighborhood(ex, sc, 50)
        total = sum(_table(skill))
        self.assertEqual(total, len(ex) - 1, "la cellule sans coordonnées a été comptée")

    def test_une_seule_journee(self):
        ex, sc = jeu(random.Random(9), jours=1, cote=10)
        for thr in range(1, 100, 7):
            self.assertEqual(_table(learning.skill_neighborhood(ex, sc, thr)),
                             reference_table(ex, sc, thr, neighborhood_km=30.0))

    def test_les_journees_restent_separees(self):
        """Deux journées au même endroit ne doivent pas s'apparier entre elles."""
        ex, sc = [], []
        for date in ("2026-06-10", "2026-06-11"):
            for i in range(6):
                ex.append({"date": date, "lat": 45.0 + i * 0.135, "lon": 2.0,
                           "label": 1 if (i < 3 and date == "2026-06-10") else 0,
                           "trigger": 80 if (i >= 3 and date == "2026-06-11") else 10})
                sc.append(float(ex[-1]["trigger"]))
        for thr in range(1, 100, 5):
            self.assertEqual(_table(learning.skill_neighborhood(ex, sc, thr)),
                             reference_table(ex, sc, thr, neighborhood_km=30.0),
                             f"seuil {thr}")


class LeBalayage(unittest.TestCase):

    def test_a_egalite_le_seuil_le_plus_haut_gagne(self):
        """Comportement historique : il rend la prévision plus sélective à skill égal."""
        ex = [{"date": "2026-06-10", "lat": 45.0, "lon": 2.0, "label": 0, "trigger": 0}]
        sc = [0.0]
        thr, csi = learning.best_threshold_neighborhood(ex, sc)
        self.assertEqual(csi, 0.0)
        self.assertEqual(thr, 99)

    def test_le_seuil_rendu_est_dans_la_plage_balayee(self):
        ex, sc = jeu(random.Random(4), jours=2, cote=9)
        thr, _ = learning.best_threshold_neighborhood(ex, sc)
        self.assertTrue(1 <= thr <= 99, thr)


if __name__ == "__main__":
    unittest.main(verbosity=2)
