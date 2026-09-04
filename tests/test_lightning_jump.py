"""Auto-tests du « lightning jump » (MTG-LI) et de l'interpolation de piste.

Le détecteur est un précurseur d'intensification : il doit se déclencher sur un vrai
changement de régime, et JAMAIS sur une croissance régulière, une décroissance, ou le
bruit de calcul. Ces trois pièges ont chacun été trouvés en écrivant ces tests.
"""
import math
import unittest

import app


BIN = 2.0   # minutes, cf. FR_CELLS_JUMP_BIN_SECONDS


class LightningJumpTests(unittest.TestCase):
    # Historique bruité mais stable, réutilisé par plusieurs cas.
    STABLE = [5.0, 5.4, 4.8, 5.1, 5.3, 4.9, 5.2, 5.0, 5.1, 4.95, 5.05, 5.0, 5.1]

    def test_activite_stable_pas_de_saut(self):
        self.assertFalse(app._lightning_jump(self.STABLE, bin_minutes=BIN)["jump"])

    def test_bond_franc_detecte(self):
        res = app._lightning_jump(self.STABLE + [14.0], bin_minutes=BIN)
        self.assertTrue(res["jump"])
        self.assertGreater(res["ratio"], app.FR_CELLS_JUMP_SIGMA)

    def test_bond_sous_le_taux_plancher_ignore(self):
        """Un « bond » de 0,05 à 0,6 éclair/min est du bruit, pas un orage."""
        petit = [0.0, 0.1, 0.0, 0.05, 0.0, 0.1, 0.0, 0.05, 0.1, 0.0, 0.05, 0.0, 0.6]
        res = app._lightning_jump(petit, bin_minutes=BIN)
        self.assertFalse(res["jump"])
        self.assertEqual(res["reason"], "below_min_rate")

    def test_mise_en_route_aucun_verdict(self):
        res = app._lightning_jump([1.0, 9.0, 20.0], bin_minutes=BIN)
        self.assertFalse(res["jump"])
        self.assertEqual(res["reason"], "insufficient")

    def test_decroissance_pas_de_saut(self):
        """Une cellule qui décline un peu MOINS vite qu'avant ne s'intensifie pas."""
        decro = [20.0, 18.0, 16.5, 15.0, 13.0, 11.5, 10.0, 8.5, 7.0, 6.0, 5.0, 4.0, 3.0]
        self.assertFalse(app._lightning_jump(decro, bin_minutes=BIN)["jump"])

    def test_allumage_sur_historique_plat(self):
        """Activité plate puis embrasement : c'est le cas d'école, il doit passer."""
        self.assertTrue(app._lightning_jump([3.0] * 12 + [12.0], bin_minutes=BIN)["jump"])

    def test_croissance_lineaire_nest_pas_un_saut(self):
        """Dérivée constante = rien de nouveau. C'est l'écart à l'article, assumé :
        la forme brute de Schultz signalerait cette cellule à chaque cycle."""
        lin = [2.0 + 1.5 * i for i in range(14)]
        self.assertFalse(app._lightning_jump(lin, bin_minutes=BIN)["jump"])

    def test_croissance_reguliere_nalerte_jamais_en_boucle(self):
        """Sans plancher sur σ, le bruit flottant faisait alerter 1 cycle sur 8."""
        alertes = sum(1 for fin in range(12, 24)
                      if app._lightning_jump([2.0 + 1.2 * i for i in range(fin)],
                                             bin_minutes=BIN)["jump"])
        self.assertEqual(alertes, 0)

    def test_cas_degeneres(self):
        self.assertFalse(app._lightning_jump([], bin_minutes=BIN)["jump"])
        self.assertFalse(app._lightning_jump(self.STABLE, bin_minutes=0)["jump"])


class CellPositionTests(unittest.TestCase):
    PISTE = [[2.0, 45.0, 1000.0], [2.1, 45.1, 1300.0], [2.2, 45.2, 1600.0]]

    def test_interpolation_au_milieu(self):
        lon, lat = app._cell_position_at(self.PISTE, 1150.0)
        self.assertAlmostEqual(lon, 2.05)
        self.assertAlmostEqual(lat, 45.05)

    def test_point_exact(self):
        self.assertEqual(app._cell_position_at(self.PISTE, 1300.0), (2.1, 45.1))

    def test_hors_piste_borne(self):
        self.assertEqual(app._cell_position_at(self.PISTE, 0.0), (2.0, 45.0))
        self.assertEqual(app._cell_position_at(self.PISTE, 9e9), (2.2, 45.2))

    def test_piste_vide(self):
        self.assertIsNone(app._cell_position_at([], 1000.0))

    def test_le_deplacement_justifie_tout_le_dispositif(self):
        """Une cellule à 60 km/h parcourt en 30 min DEUX fois le rayon de comptage :
        compter les éclairs anciens autour de sa position actuelle attribuerait à la
        cellule l'activité d'une zone qu'elle a déjà quittée."""
        t0 = 1_000_000.0
        dlon = 30.0 / (111.0 * math.cos(math.radians(45.0)))
        piste = [[2.0, 45.0, t0], [2.0 + dlon, 45.0, t0 + 1800.0]]
        a = app._cell_position_at(piste, t0)
        b = app._cell_position_at(piste, t0 + 1800.0)
        ecart_km = abs(b[0] - a[0]) * 111.0 * math.cos(math.radians(45.0))
        self.assertGreater(ecart_km, app.FR_CELLS_LI_RADIUS_KM)


class ScenarioCelluleMobileTests(unittest.TestCase):
    """Compose les deux briques comme le fait la boucle de production, sur une cellule
    QUI SE DÉPLACE. Une cellule file à ~60 km/h : en 30 min elle parcourt 30 km, soit
    DEUX fois le rayon de comptage. Compter les éclairs anciens autour de sa position
    ACTUELLE lui attribue donc l'activité d'une zone qu'elle a déjà quittée."""

    BIN_S = 120.0
    RAYON_KM = 15.0
    N_BINS = 15

    def _piste(self, t_end):
        lat = 45.0
        km_par_deg = 111.0 * math.cos(math.radians(lat))
        duree = self.N_BINS * self.BIN_S
        return [[3.0 - 30.0 / km_par_deg, lat, t_end - duree], [3.0, lat, t_end]]

    def _flashes(self, piste, t_end, par_bin):
        """Éclairs COLLÉS à la cellule, `par_bin(b)` par bin (b=0 → le plus récent)."""
        flashes = []
        for b in range(self.N_BINS - 1, -1, -1):
            t_mid = t_end - (b + 0.5) * self.BIN_S
            clon, clat = app._cell_position_at(piste, t_mid)
            for k in range(par_bin(b)):
                flashes.append((clon + 0.01 * (k % 3 - 1), clat + 0.01 * (k % 2), t_mid))
        return flashes

    def _serie(self, flashes, piste, t_end, *, suivre_la_piste):
        """Taux par bin. `suivre_la_piste=False` = méthode naïve : tout compter autour
        de la position ACTUELLE du cœur."""
        bin_min = self.BIN_S / 60.0
        taux = []
        for b in range(self.N_BINS - 1, -1, -1):
            t_mid = t_end - (b + 0.5) * self.BIN_S
            lon0, lat0 = (app._cell_position_at(piste, t_mid) if suivre_la_piste
                          else (piste[-1][0], piste[-1][1]))
            n = 0
            for flon, flat, fep in flashes:
                if not (t_end - (b + 1) * self.BIN_S <= fep < t_end - b * self.BIN_S):
                    continue
                dy = (flat - lat0) * 111.0
                dx = (flon - lon0) * 111.0 * math.cos(math.radians(lat0))
                if dy * dy + dx * dx <= self.RAYON_KM ** 2:
                    n += 1
            taux.append(n / bin_min)
        return taux

    def test_saut_reel_detecte_en_suivant_la_piste(self):
        """Activité plate puis embrasement sur le dernier bin : doit être vu."""
        t_end = 1_700_000_000.0
        piste = self._piste(t_end)
        flashes = self._flashes(piste, t_end, lambda b: 8 if b == 0 else 1)
        res = app._lightning_jump(
            self._serie(flashes, piste, t_end, suivre_la_piste=True), bin_minutes=2.0)
        self.assertTrue(res["jump"])

    def test_remanence_le_drapeau_reste_leve(self):
        """Le saut a eu lieu il y a deux bins : le drapeau doit TENIR, sinon il
        clignoterait d'un cycle de calcul à l'autre et le préavis serait inutilisable."""
        t_end = 1_700_000_000.0
        piste = self._piste(t_end)
        flashes = self._flashes(piste, t_end, lambda b: 8 if b <= 2 else 1)
        res = app._lightning_jump(
            self._serie(flashes, piste, t_end, suivre_la_piste=True), bin_minutes=2.0)
        self.assertTrue(res["jump"])
        self.assertIsNotNone(res["age_min"])
        self.assertGreater(res["age_min"], 0)

    def test_cellule_mobile_a_activite_constante_nalerte_pas(self):
        """LE cas qui justifie tout le dispositif. Activité rigoureusement CONSTANTE,
        cellule qui se déplace : il ne se passe rien, aucune alerte ne doit sortir.

        On compare les deux SÉRIES plutôt que les deux verdicts : le verdict de la
        méthode naïve dépend de l'instant où l'on regarde (la fausse alerte se produit
        au cycle où la cellule franchit le rayon), alors que la déformation de la série,
        elle, est là en permanence. C'est elle qu'on veut démontrer."""
        t_end = 1_700_000_000.0
        piste = self._piste(t_end)
        flashes = self._flashes(piste, t_end, lambda b: 6)

        serie_avec = self._serie(flashes, piste, t_end, suivre_la_piste=True)
        serie_sans = self._serie(flashes, piste, t_end, suivre_la_piste=False)

        # En suivant la piste : activité constante, donc série PLATE, donc aucun saut.
        self.assertEqual(max(serie_avec), min(serie_avec),
                         "activité constante suivie sur sa piste : la série doit être plate")
        self.assertFalse(app._lightning_jump(serie_avec, bin_minutes=2.0)["jump"],
                         "activité constante : aucun saut à signaler")

        # Sans suivre la piste : les bins anciens tombent hors du rayon et lisent zéro.
        # La méthode INVENTE une montée là où l'activité n'a jamais varié.
        self.assertEqual(serie_sans[0], 0.0,
                         "les bins anciens doivent être vides : la cellule était ailleurs")
        self.assertGreater(serie_sans[-1], 0.0)
        self.assertGreater(max(serie_sans) - min(serie_sans), 0.0,
                           "la méthode naïve doit bien déformer la série — sinon ce test "
                           "ne prouve rien")


if __name__ == "__main__":
    unittest.main()
