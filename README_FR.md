# ObjectiFoudre

Application de chasse à l'orage : une grille France AROME (Météo-France) affiche une
**probabilité orageuse horaire** et une **confiance**, sur 24 heures. Le modèle se
**vérifie** contre la foudre réellement observée (MTG-LI / EUMETSAT) et peut
**s'auto-calibrer** à partir de cet écart.

## Contenu
- `app.py` : backend FastAPI (préchargement AROME, cache, automatisations, endpoints).
- `weather_logic.py` : logique météo et scoring (probabilité orage + confiance).
- `verification.py` : vérification prévu vs foudre observée (table de contingence, POD/FAR/CSI/HSS, voisinage).
- `learning.py` : auto-calibration en boucle fermée (calibration isotone, seuil optimal, poids de mélange ; pur, testable).
- `static/` : interface WebApp (`index.html` + `assets/`). Fichier maître pour l'UI.
- `render.yaml` : déploiement Render. `Procfile` : compatible Railway.

Tests rapides (chacun se lance seul) : `python verification.py`, `python learning.py`,
`python -m unittest tests.test_weather_logic`.

## Architecture en bref
1. **AROME France** : le serveur précharge les paquets GRIB Météo-France (SP1/SP2/SP3),
   décode les champs nationaux, les met en cache disque, puis matérialise 24 grilles
   horaires France. Tout passe par un cache pour limiter les appels (rate-limité).
2. **Scoring** (`weather_logic`) : chaque cellule reçoit un `trigger_score` 0-100 croisant
   CAPE, humidité de basse couche (Td/HR/VPD/bulbe humide recalculés), vapeur d'eau
   intégrée, chauffage de surface (rayonnement court, hauteur de couche limite, timing),
   convection prévue (précipitation, nébulosité, rafales) et convergence du vent 10 m.
3. **Foudre observée** (EUMETSAT MTG-LI) : une fois la journée écoulée, le serveur collecte
   les flashs et les archive par cellule.
4. **Vérification** (`verification`) : prévu (score ≥ seuil) vs observé (≥ 1 flash) →
   contingence et scores (POD/FAR/CSI/HSS), en **voisinage** (tolérance spatiale, par
   défaut 30 km) car un modèle d'environnement à ~15 km ne pointe pas la cellule exacte.
5. **Auto-calibration** (`learning`) : apprend de l'écart prévu/observé pour corriger le
   seuil (et, plus tard, les 4 poids de mélange). **Gated** (volumes minimaux) et
   **réversible** ; n'applique une correction que si elle bat la baseline en validation
   croisée temporelle.
6. **Historique** : grilles prévues et foudre observée sont archivées durablement
   (`history/`) pour rejouer une journée et la vérifier.

## Mode serveur local automatisé

Sert à tester le fonctionnement Render en local. Le serveur précharge les champs AROME
France, matérialise les 24 grilles horaires et conserve le cache sur disque. Les reprises
automatiques ne traitent que les heures encore absentes du cache (et reconstruisent sur
nouveau run AROME), sans relire inutilement ce qui est déjà prêt.

### Variables principales
- `METEOFRANCE_API_KEY` (ou `METEOFRANCE_API_TOKEN`) : clé API Météo-France côté serveur (AROME).
- `METEOFRANCE_ARPEGE_API_KEY` : clé API du produit ARPEGE (abonnement séparé sur le même
  portail). En local, à défaut de variable, le fichier `Clef API ARPEGE.txt` posé à côté
  d'`app.py` est lu automatiquement.
- `EUMETSAT_CONSUMER_KEY` / `EUMETSAT_CONSUMER_SECRET` : identifiants EUMDAC (compte EUMETSAT
  gratuit) pour la collecte foudre MTG-LI. Sans eux, le scoring et l'historique fonctionnent,
  mais pas la vérification ni l'auto-calibration.
- `OBJECTIFOUDRE_CACHE_DIR` : dossier de cache persistant (défaut `.cache/meteofrance`).
- `OBJECTIFOUDRE_AUTO_PRELOAD=1` : démarre l'automatisation AROME au lancement de FastAPI.
- `OBJECTIFOUDRE_AUTO_PRELOAD_DAYS=today,tomorrow` : jours à surveiller. Valeurs : `yesterday`,
  `today`, `tomorrow`, `day_after_tomorrow` ou dates ISO `aaaa-mm-jj`
  (défaut `yesterday,today,tomorrow,day_after_tomorrow`).
- `OBJECTIFOUDRE_AROME_GRID` : grille AROME forcée (défaut : auto, ex. `0.025`).
- `OBJECTIFOUDRE_TIMEZONE=Europe/Paris` : fuseau de référence.

### Cadence & rate-limiting AROME (le run sort toutes les 3 h)
- `OBJECTIFOUDRE_AROME_RUN_UPDATE_INTERVAL_SECONDS=10800` : rythme des runs AROME (3 h).
- `OBJECTIFOUDRE_AROME_RUN_AVAILABILITY_DELAY_SECONDS=600` : délai avant qu'un run soit publié.
- `OBJECTIFOUDRE_AROME_RUN_POLL_INTERVAL_SECONDS=600` : re-vérification si le run attendu manque.
- `OBJECTIFOUDRE_AUTO_PRELOAD_INTERVAL_SECONDS=300` : délai entre deux vérifications.
- `OBJECTIFOUDRE_METEOFRANCE_REQUEST_MIN_INTERVAL_SECONDS=6.0` : délai mini entre deux appels
  externes Météo-France (limiteur global anti-quota).
- `OBJECTIFOUDRE_METEOFRANCE_RETRY_BASE_DELAY_SECONDS=1.0` : base du délai de reprise réseau.
- `OBJECTIFOUDRE_PACKAGE_JSON_PARTIAL_TTL_SECONDS=300` : TTL court du JSON d'un run AROME
  encore en cours de publication (évite de figer une liste de groupes horaires incomplète).

### Cache, historique, foudre
- `OBJECTIFOUDRE_CACHE_RETENTION_HOURS=72` : conservation mini du cache persistant avant purge.
- `OBJECTIFOUDRE_CACHE_CLEANUP_INTERVAL_SECONDS=3600` : délai mini entre deux purges.
- `OBJECTIFOUDRE_HISTORY_ENABLED=1` / `OBJECTIFOUDRE_HISTORY_DIR=history` : archive durable.
- `OBJECTIFOUDRE_HISTORY_RETENTION_DAYS=180` : rétention de l'historique.
- `OBJECTIFOUDRE_LIGHTNING_AUTOMATION=1` : collecte automatique de la foudre des jours écoulés.
- `OBJECTIFOUDRE_LIGHTNING_AUTOMATION_INTERVAL_SECONDS=21600` : cadence de collecte (6 h).

### Pilotage manuel & legacy
- `OBJECTIFOUDRE_PRELOAD_SECRET` : secret obligatoire pour les endpoints de pilotage manuel.
- `OBJECTIFOUDRE_ENABLE_LEGACY_OPEN_METEO=1` : réactive les anciens endpoints Open-Meteo.
- `OBJECTIFOUDRE_ENABLE_LEGACY_LOCAL_AROME=1` : réactive les anciens endpoints AROME locaux.
- `OBJECTIFOUDRE_ENABLE_METEOFRANCE_DIAGNOSTICS=1` : réactive les endpoints de diagnostic.

### Exemple local
```bash
EUMETSAT_CONSUMER_KEY=... EUMETSAT_CONSUMER_SECRET=... \
OBJECTIFOUDRE_AUTO_PRELOAD=1 \
OBJECTIFOUDRE_AUTO_PRELOAD_DAYS=yesterday,today,tomorrow,day_after_tomorrow \
METEOFRANCE_API_KEY="$(cat 'Clef API.txt')" \
python -m uvicorn app:app --host 127.0.0.1 --port 8000
```

Statut lecture seule : `/api/server/arome-automation-status`. Il expose la couverture par
jour, les heures manquantes, le run AROME courant et sa complétude, le cooldown quota et
l'état du cache disque. Le front le consulte pour afficher le travail de l'automatisation
et hydrater le cache France déjà préparé.

Pilotage manuel (si `OBJECTIFOUDRE_PRELOAD_SECRET` est défini) :
`POST /api/server/arome-automation-start`, `-stop`, `arome-preload-now`. Corps JSON pour
`arome-preload-now` : `{"secret":"...","date":"2026-05-21"}`.

### Multi-modèles : AROME (J-1 → J+2) + ARPEGE (J+3/J+4)
Le pipeline paquets (catalogue → runs → produits GRIB → extraction nationale →
matérialisation) est paramétré par `NWP_MODEL_REGISTRY` dans `app.py`, lu via un
contextvar « modèle actif » (`_nwp_model_context`, défaut `arome` → comportement et
clés de cache historiques inchangés). Le modèle est choisi par la **date demandée**
(`_nwp_model_for_date` : au-delà de J+2 → ARPEGE) sur les endpoints slot-grid /
cell-details / cache-status — le front n'envoie rien de plus, et lit
`payload.meta.nwp_model_label` pour le badge.

ARPEGE 0,1° (sondé sur run réel) : runs toutes les **6 h**, groupes `000H012H` …
`097H102H` (horizon 102 h). **Résolution temporelle : horaire jusqu'à +48 h, puis
3-horaire** (échéances 51, 54, 57, 60…). Plan de champs
`METEOFRANCE_ARPEGE_GRIB_SLOT_GRID_SPECS` : comme AROME **sans SP3** — la vapeur
d'eau colonne est dans SP2 ; `shortwave_radiation` et `precipitation_rate`
n'existent qu'à h0 → absents (weather_logic dégrade proprement : chauffage = timing
seul, pas de pluie). L'automatisation précharge les jours
`OBJECTIFOUDRE_AUTO_PRELOAD_ARPEGE_DAYS` (défaut `j+2,j+3,j+4`, vide = désactivé) avec
la clé ARPEGE, ses propres runs et des clés de cache préfixées `arpege:`.
`GET /api/server/nwp-models?probe=true` sonde les catalogues des deux modèles.

**Relais AROME→ARPEGE par créneau** : le run AROME (~+51 h) ne couvre que le début de
J+2 → ARPEGE complète l'après-midi/soirée du **même jour**. `_nwp_models_for_date(date)`
renvoie une liste ordonnée (J+2 = `[arome, arpege]`) ; le service
(`_serve_france_slot_models_sync` sur slot-grid-cache / cell-details / day-cache) essaie
AROME puis ARPEGE et garde le premier qui a le créneau en cache. La couverture
(`arome-automation-status`) et `grib-france-cache-status` sont **fusionnées par date**
(union des heures dispo/en cache, détail `by_model`). Comme ARPEGE est 3-horaire au-delà
de +48 h, les heures locales sans échéance exacte sont **calées sur l'échéance voisine**
(`nearest_tolerance_hours=2`, ARPEGE uniquement — AROME reste strict pour une frontière
nette). J+4 reste partiel l'après-midi (bord de l'horizon ARPEGE).

### Tendance ECMWF (J+5 → J+10)
À ces échéances, seule la **tendance** de grande échelle a du sens : c'est un
sous-système séparé du pipeline paquets (Météo-France), pas un troisième « modèle »
du registre. ECMWF IFS **open data** (sans clé, licence CC-BY 4.0) : chaque fichier
GRIB2 a un `.index` (json-lines `_offset`/`_length`) → on **Range-fetch** seulement
les champs utiles (`mucape`, `2t`, `2d`, `tcwv`, `10fg3`, `10u`/`10v`). Maille 0,25°
(~28 km), grille **globale** : l'échantillonnage se fait par **index analytique**
(grille lat/lon régulière, O(1)/point) et non par `find_nearest` (trop lent sur
~1 M points). Un point **par jour** (échéance ≈ 12 UTC = pic d'instabilité). Le
scoring réutilise le même assemblage (`rows_for_grid_locations`/`group_for_output`) ;
les champs absents (rayonnement, taux de pluie, nébulosité, BLH, CIN) sont gérés en
`None`. Endpoints `GET /api/ecmwf/trend-status` (run + 6 jours) et
`POST /api/ecmwf/trend-day {date}` (build paresseux puis cache
`OBJECTIFOUDRE_ECMWF_TREND_CACHE_TTL_SECONDS`, 12 h). Aucune clé ni variable d'env requise.

### Page « Prévision & tendance » unifiée
La page de risque (`storm-forecast-image.js`, bouton éclair) a son **propre sélecteur
de date J0 → J+10**, indépendant de la grille de base, et un store de jours dédié
(`PREDICTION_DAY_STORE`). Jusqu'à J+4 : grille horaire AROME/ARPEGE via
`grib-france-day-cache?detail_level=render` (lot 24 h allégé), avec les périodes
Matinée/Après-midi/Soirée. De J+5 à J+10 : tendance ECMWF via `trend-day`, en
**zones lissées** comme le reste (pas de vue cellule) ; seul l'onglet « Journée »
est actif. Tous les jours sont **préchargés** en arrière-plan à l'ouverture
(`prewarmPredictionDates`). Garde-fou : la fenêtre 08h-08h d'un jour horaire dont le
lendemain n'a pas d'horaire (J+4 → nuit sur J+5 ECMWF) rend le tail nocturne optionnel.
L'ancienne page « Tendance » dédiée (vue cellule) a été retirée et fusionnée ici.

### Mode « En chasse » (AROME-PI + radar live)
Vue live dédiée (bouton goutte rouge → page `#chasePage`, `chase.js`, carte MapLibre
indépendante) pour accompagner une chasse sur le terrain. Combine :
- **Radar observé** : RainViewer (gratuit, sans clé, ~2 h passées, animé) — tuiles
  directes côté navigateur.
- **Nowcast AROME-PI** : prévision immédiate Météo-France (maille ~1,3 km, pas 15 min,
  run+15 min → +6 h). **AROME-PI = API WMS/WCS** (pas l'API paquets), clé dédiée
  `METEOFRANCE_AROME_PI_API_KEY` ou fichier `Clef API AROME PI.txt`. Le WMS exige la clé
  → **proxy serveur** `GET /api/aromepi/wms` (clé jamais exposée ; convertit le bbox 3857
  de MapLibre en 4326 ; tuile transparente sur échec). 6 couches : réflectivité (radar
  simulé), grêle, graupel, rafales 15 min, CAPE, MOCON. `GET /api/aromepi/status` (run +
  échéances), `POST /api/aromepi/point` (valeurs au point via WCS GeoTIFF → panneau
  « conditions à ta position »).
- **Géolocalisation** (`watchPosition`, contexte sécurisé requis : HTTPS ou localhost),
  curseur temps unifié -2 h observé → +6 h prévu, onglets de couche.

Particularités AROME-PI : WMS EPSG:4326 seulement, `styles=` vide ; MOCON est analyse-seule
en WCS (valeur au point indispo → couche carte) ; rafales/graupel sont des accumulations
(`_PT15M`…). Aucune donnée radar/nowcast ne s'affiche par temps calme (tuiles transparentes).

## Déploiement Render
`render.yaml` cible un Web Service starter avec disque persistant. Render Free sert à tester
le démarrage mais perd le cache au redéploiement/redémarrage/spin down ; le disque persistant
évite de refaire les préchargements AROME en boucle.
1. Mets ce dossier dans un dépôt GitHub.
2. Sur Render, crée un Blueprint ou un Web Service depuis le dépôt.
3. Renseigne `METEOFRANCE_API_KEY` (et `EUMETSAT_CONSUMER_KEY`/`_SECRET` pour la foudre) en secrets.
   Pour les modèles additionnels : `METEOFRANCE_ARPEGE_API_KEY` (J+3/J+4) et
   `METEOFRANCE_AROME_PI_API_KEY` (mode En chasse). Sans elles, ces fonctions se désactivent proprement.
4. Renseigne `OBJECTIFOUDRE_PRELOAD_SECRET` pour garder les commandes manuelles actives.
5. Le cache et l'historique doivent pointer sous le disque persistant (`/var/data`), ex.
   `OBJECTIFOUDRE_CACHE_DIR=/var/data/meteofrance`, `OBJECTIFOUDRE_HISTORY_DIR=/var/data/history`.

⚠️ La branche de déploiement Render est pointée via le **dashboard** (pas figée dans
`render.yaml`) : ne pas la renommer en bumpant la version.

## Déploiement Railway
1. Mets ce dossier dans un dépôt GitHub.
2. Sur Railway, crée un projet depuis ce dépôt.
3. Commande de démarrage : `uvicorn app:app --host 0.0.0.0 --port $PORT`

## Endpoints
**Grille & automatisation**
- `/` : WebApp.
- `/api/health` : test rapide.
- `/api/meteofrance/grib-france-slot-grid-cache` : grille horaire France depuis le cache serveur.
- `/api/meteofrance/grib-france-day-cache` : les 24 heures France en un lot.
- `/api/meteofrance/grib-preload-national-day` : préchargement France AROME sur 24 h.
- `/api/meteofrance/grib-preload-status` : suivi d'un préchargement en arrière-plan.
- `/api/server/arome-automation-status` : état de l'automatisation serveur.
- `/api/server/nwp-models[?probe=true]` : registre des modèles PNT (sonde catalogue optionnelle).

**Tendance ECMWF (J+5 → J+10)**
- `/api/ecmwf/trend-status` : dernier run open data + liste des 6 jours.
- `/api/ecmwf/trend-day` (POST `{date}`) : grille tendance quotidienne d'un jour.

**Historique & vérification**
- `/api/history/dates` : dates archivées. `/api/history/day` : une journée archivée.
- `/api/history/lightning` : foudre observée archivée. `/api/history/verification` : prévu vs observé.
- `/api/history/collect-lightning`, `/api/history/collect-pending-lightning` : collecte foudre.

**Auto-calibration**
- `/api/learning/status` : état (collecte/calibré, volumes, seuil, poids, skill).
- `/api/learning/retrain` : relance une évaluation. `/api/learning/revert` : revient au modèle de base.

**Legacy (désactivés par défaut, `410 Gone`)** : `/api/latest`, `/api/historical-analysis(.csv)`
(Open-Meteo) ; `/api/meteofrance/slot-grid`, `grib-slot-grid(-cache)`, `grib-cache-status`,
`grib-preload(-day)` (AROME local) ; `/api/meteofrance/test-key`, `sample-coverage`, `probe-*`
(diagnostic). Réactivables via les variables `OBJECTIFOUDRE_ENABLE_LEGACY_*` / `_DIAGNOSTICS`.

## Comportement
- Cache national AROME GRIB sur disque pour réutiliser les champs décodés ; cache métadonnées
  Météo-France sans stocker la clé brute dans la clé de cache.
- Matérialisation des 24 grilles horaires France depuis le cache national ; reprise
  automatique des journées partielles et reconstruction sur nouveau run.
- Frise horaire : 24 heures de 00 h à 23 h. Score : probabilité orage + confiance.
- Collecte quotidienne de la foudre MTG-LI des jours écoulés, puis vérification et
  réévaluation de l'auto-calibration (boucle fermée).

## Champs AROME utilisés (SP1/SP2/SP3, déjà téléchargés)
CAPE, température 2 m, point de rosée 2 m, humidité relative 2 m, vapeur d'eau intégrée,
flux net rayonnement court, taux de précipitation, nébulosité basse/moyenne/haute, rafales
10 m, vent 10 m (vitesse + direction), hauteur de couche limite. VPD et bulbe humide sont
recalculés ; la convergence de surface est dérivée du vent 10 m.

## Auto-calibration (learning.py)
- **Calibration** : courbe monotone `trigger_score → P(foudre)` (régression isotone/PAVA) +
  seuil de décision optimal (CSI max en voisinage). **Poids** (plus tard) : réapprend les 4
  poids de mélange (CAPE/humidité/chauffage/convergence) par recherche sur le simplexe.
- **Garde-fous de volume** : calibration ≥ 10 jours foudre-finale et ≥ 40 cellules orageuses ;
  poids ≥ 25 jours et ≥ 300. En-dessous : état « en collecte », rien n'est appliqué.
- **Activation** auto avec garde-fous : un candidat n'est activé que s'il bat la baseline sur
  un bloc de jours de test (CV temporelle). Tout est réversible (supprimer `history/learning/active.json`).
