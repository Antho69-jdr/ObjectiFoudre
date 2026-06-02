# ObjectiFoudre

## Contenu
- `app.py` : backend FastAPI
- `weather_logic.py` : logique météo et scoring ObjectiFoudre
- `static/index.html` : interface WebApp
- `render.yaml` : déploiement Render
- `Procfile` : compatible Railway


## Mode serveur local automatisé

Ce mode sert à tester le fonctionnement Render depuis la machine locale. Le serveur peut précharger les champs AROME France, matérialiser les 24 grilles horaires et conserver le cache sur disque. Les reprises automatiques ne traitent que les heures encore absentes du cache France afin d éviter de relire inutilement les heures déjà prêtes.

Variables utiles :
- METEOFRANCE_API_KEY ou METEOFRANCE_API_TOKEN : clé API Météo-France côté serveur.
- OBJECTIFOUDRE_CACHE_DIR : dossier de cache persistant, par défaut .cache/meteofrance.
- OBJECTIFOUDRE_GRIB_NATIONAL_FIELD_REGISTRY=1 : réutilise les champs nationaux déjà décodés pour générer les grilles horaires.
- OBJECTIFOUDRE_AUTO_PRELOAD=1 : démarre l automatisation au lancement de FastAPI.
- OBJECTIFOUDRE_AUTO_PRELOAD_DAYS=today,tomorrow : jours à surveiller, valeurs possibles veille, today, tomorrow ou dates ISO aaaa-mm-jj.
- OBJECTIFOUDRE_AUTO_PRELOAD_INTERVAL_SECONDS=300 : délai entre deux vérifications quand le cache est déjà prêt.
- OBJECTIFOUDRE_CACHE_RETENTION_HOURS=72 : conservation minimale des fichiers du cache persistant avant purge automatique.
- OBJECTIFOUDRE_CACHE_CLEANUP_INTERVAL_SECONDS=3600 : délai minimal entre deux nettoyages du cache persistant.
- OBJECTIFOUDRE_METEOFRANCE_REQUEST_MIN_INTERVAL_SECONDS=0.5 : délai minimal entre deux appels externes Météo-France, en secondes.
- OBJECTIFOUDRE_METEOFRANCE_RETRY_BASE_DELAY_SECONDS=1.0 : base du délai de reprise après erreur réseau transitoire.
- OBJECTIFOUDRE_PRELOAD_SECRET : secret obligatoire pour les endpoints de pilotage manuel.
- OBJECTIFOUDRE_ENABLE_LEGACY_OPEN_METEO=1 : réactive temporairement les anciens endpoints Open-Meteo désactivés par défaut pendant la migration AROME.
- OBJECTIFOUDRE_ENABLE_LEGACY_LOCAL_AROME=1 : réactive temporairement les anciens endpoints AROME locaux, remplacés par la grille France.
- OBJECTIFOUDRE_ENABLE_METEOFRANCE_DIAGNOSTICS=1 : reactive temporairement les endpoints de diagnostic Meteo-France test-key, sample-coverage et probe-*.

Exemple local :

```bash
METEOFRANCE_API_KEY=... OBJECTIFOUDRE_AUTO_PRELOAD=1 python -m uvicorn app:app --host 127.0.0.1 --port 8000
```

Statut lecture seule : /api/server/arome-automation-status. Il expose aussi la couverture par jour, les heures manquantes, le cooldown quota et l état du cache disque (taille estimée, espace libre, écriture possible). Le front le consulte périodiquement pour afficher le travail de l automatisation serveur et hydrater le cache France déjà préparé.

Pilotage manuel, uniquement si OBJECTIFOUDRE_PRELOAD_SECRET est défini :
- POST /api/server/arome-automation-start
- POST /api/server/arome-automation-stop
- POST /api/server/arome-preload-now

Exemple de corps JSON pour /api/server/arome-preload-now :

```json
{"secret":"...","date":"2026-05-21"}
```

## Déploiement Render

Le fichier render.yaml cible un Web Service payant starter avec disque persistant. Render Free reste utile pour tester le démarrage, mais il perd le cache au redéploiement, au redémarrage et au spin down. Pour ObjectiFoudre, le disque persistant est donc nécessaire pour ne pas refaire les préchargements AROME en boucle.

1. Mets ce dossier dans un dépôt GitHub.
2. Sur Render, crée un Blueprint ou un Web Service depuis le dépôt.
3. Renseigne METEOFRANCE_API_KEY dans les variables secrètes.
4. Renseigne OBJECTIFOUDRE_PRELOAD_SECRET si tu veux garder les commandes manuelles actives.
5. Le cache doit pointer vers /var/data/meteofrance, sous le disque persistant /var/data.

## Déploiement Railway
1. Mets ce dossier dans un dépôt GitHub.
2. Sur Railway, crée un projet depuis ce dépôt.
3. Commande de démarrage : `uvicorn app:app --host 0.0.0.0 --port $PORT`

## Endpoints
- `/` : WebApp
- `/api/meteofrance/grib-france-slot-grid` : grille horaire AROME GRIB France entière. En absence de token navigateur, ce endpoint utilise la clé serveur uniquement en mode cache-only.
- `/api/meteofrance/grib-preload-national-day` : préchargement France AROME sur 24 h
- `/api/meteofrance/grib-preload-status` : suivi d’un préchargement en arrière-plan
- `/api/server/arome-automation-status` : état de l’automatisation serveur
- `/api/health` : test rapide

Endpoints legacy Open-Meteo désactivés par défaut : `/api/latest`, `/api/historical-analysis`, `/api/historical-analysis.csv`. Ils répondent `410 Gone` sauf si `OBJECTIFOUDRE_ENABLE_LEGACY_OPEN_METEO=1` est défini.

Endpoints AROME locaux désactivés par défaut : `/api/meteofrance/slot-grid`, `/api/meteofrance/grib-slot-grid`, `/api/meteofrance/grib-slot-grid-cache`, `/api/meteofrance/grib-cache-status`, `/api/meteofrance/grib-preload`, `/api/meteofrance/grib-preload-day`. Ils répondent `410 Gone` sauf si `OBJECTIFOUDRE_ENABLE_LEGACY_LOCAL_AROME=1` est défini.

Endpoints de diagnostic Meteo-France desactives par defaut : /api/meteofrance/test-key, /api/meteofrance/sample-coverage et /api/meteofrance/probe-*. Ils repondent 410 Gone sauf si OBJECTIFOUDRE_ENABLE_METEOFRANCE_DIAGNOSTICS=1 est defini.

## Comportement
- cache serveur 60 min
- cache métadonnées Météo-France sans stocker la clé brute dans la clé de cache
- cache national AROME GRIB sur disque pour réutiliser les champs décodés
- matérialisation des 24 grilles horaires France depuis le cache national
- reprise automatique des journées partielles uniquement sur les heures manquantes
- frise horaire : 24 heures de 00h à 23h
- score simplifié : probabilité orage + confiance

## Source front officielle
- `static/index.html` : interface active et fichier maître pour l'UI
- `_archive/script.js` et `_archive/check.js` : anciennes versions conservées hors circuit

## Correctifs inclus dans cette version
- manifeste PWA réaligné sur l'application actuelle (`start_url: /`)
- service worker nettoyé et versionné (`objectifoudre-v1.1.38`)
- UI d'installation affichable aussi sur desktop si l'installation est disponible
- source réelle clarifiée : l'interface principale utilise désormais AROME France en journée complète
