# Audit faisabilité — Astres + Voie lactée selon le champ de vision (item 4, phase 1)

**Date** : 2026-08-21 · **Verdict : GO en pur-Python** (aucune dépendance, aucun réseau, aucun quota).
POC : `.h_collect/astro_s0_sky.py`. Artéfact (rapport lisible) :
`https://claude.ai/code/artifact/6034ec4d-a645-4524-9b3f-df9359b220d5`.

## Pourquoi pur-Python (pas skyfield)
La machinerie astro existe DÉJÀ dans `stargaze.py` : la Lune est calculée par la **méthode de Schlyter**
(`_moon_radec` = éléments orbitaux + perturbations → RA/Dec ; `_moon_alt_deg` = RA/Dec + GMST/hour-angle →
altitude ; `_crossings` = lever/coucher générique). Précision ~arcmin, très au-delà du besoin (le champ de
vision est résolu au degré : 24 azimuts). skyfield n'ajouterait que du poids (dépendance pip + éphéméride
`.bsp` ~17 Mo à embarquer sur Railway) pour une précision inutile ici.

## Faits techniques mesurés / validés (POC)
- **alt/az générique** : `altaz(ra, dec, dt, lat, lon)` = généralisation de `_moon_alt_deg` qui renvoie AUSSI
  l'azimut (`az = atan2(-cos(dec)·sin(ha), sin(dec)·cos(lat) − cos(dec)·sin(lat)·cos(ha))`, depuis le Nord,
  sens horaire). LST réutilise le shortcut Schlyter `gmst0 = ((Ms+ws)+180)%360`.
- **Étoiles brillantes / constellations** : table RA/Dec fixe (J2000) → réutilise alt/az. TRIVIAL. Constellations
  = + un fichier de segments d'astérisme (public, type Stellarium, ~Ko pour les majeures) → densité = déc. maquette.
- **Planètes** : éléments de Schlyter + Kepler → héliocentrique → +position du Soleil → géocentrique → RA/Dec.
  Même motif que la Lune. **Codé & validé dans le POC** (les 5 à l'œil nu : Mercure→Saturne).
- **Voie lactée** : plan galactique b=0, échantillonné en longitude galactique → rotation galactique→équatoriale.
  Formule **vérifiée sur le centre galactique** : l=0,b=0 → RA 266,42° / Dec −28,9° (attendu 266,4 / −29,0). ✓
  Constantes : NGP RA=192,85948° Dec=27,12825°, l_NCP=122,93192°.
- **Croisement champ de vision** : QUASI GRATUIT — `horizon.py` expose déjà `azimuths[]{az,horizon_deg,...}` +
  le helper `horizon_at(scan, az_deg)`. Un objet est observable si `alt > horizon_at(az)`. → feature
  surtout pertinente sur les **SPOTS** (qui ont un profil LiDAR ; une cellule quelconque n'a que l'horizon vrai 0°).
- **« Hors de portée » (α Centauri)** : `dec < latitude − 90` ⇒ ne se lève JAMAIS. α Cen (Dec −60,8°) depuis
  la France (lat ~46°) : culmine à −16,8° → message propre « hors de portée à cette latitude », pas un bug.

## Contrôle de validité du POC (ciel de Lyon, 2026-08-21 23 h locale)
- **Polaris culmine à 45,5°** ≈ latitude 45,76° → le calcul alt/az est juste (invariant classique).
- **Triangle d'été** correct : Véga 79° SO, Deneb 76° E, Altaïr 52° S.
- **Voie lactée** : centre galactique (Sagittaire) bas au S (alt 12,3°, az 201°) → bande montant à ~71° à l'E
  (Cygne). La plus belle partie est basse au Sud ⇒ l'**obstruction Sud** du spot prime.
- **Saturne** visible à l'E (6,5°) ; Jupiter/Vénus/Mars/Mercure sous l'horizon à 23 h (objets du matin en août).
- **α Cen** : correctement « hors de portée (latitude) ».

## Branchement proposé
- Backend : nouveau module isolé `skyobjects.py` (`altaz_from_radec`, catalogue étoiles, éléments planètes,
  polyligne Voie lactée, `visible_sky(dt,lat,lon,scan)`). Endpoint **à la demande par point+heure**
  `/api/stargaze/sky?lat&lon&t` (PAS par cellule → 2636× trop lourd), ou plié dans la fiche du spot.
- Front : dôme (le demi-dôme mappe déjà azimut E→O + altitude → poser objets + bande) + résumé compact
  dans le tooltip (⇒ recoupe l'item 5). Suit la mini-frise du dôme (comme la Lune).

## Décisions ouvertes pour la phase 2 (maquette)
1. Constellations : figures complètes (lignes) ou étoiles brillantes nommées + nom de constellation ?
2. Portée : spots seulement (champ de vision) ou aussi au clic cellule (horizon vrai 0°, sans obstruction) ?
3. Voie lactée : bande dessinée sur le dôme + verdict, ou verdict texte seul ?
4. Planètes : garder Mercure (rarement bien placée) ou les 4 principales ?
