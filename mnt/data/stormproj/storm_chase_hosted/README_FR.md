# Storm Chase WebApp hébergée

## Contenu
- `app.py` : backend FastAPI
- `weather_logic.py` : logique météo et scoring V2
- `static/index.html` : interface WebApp
- `render.yaml` : déploiement Render
- `Procfile` : compatible Railway

## Déploiement Render
1. Mets ce dossier dans un dépôt GitHub.
2. Sur Render, crée un **Web Service** depuis le dépôt.
3. Render peut lire `render.yaml` automatiquement.
4. L'app sera disponible sur une URL publique.

## Déploiement Railway
1. Mets ce dossier dans un dépôt GitHub.
2. Sur Railway, crée un projet depuis ce dépôt.
3. Commande de démarrage : `uvicorn app:app --host 0.0.0.0 --port $PORT`

## Endpoints
- `/` : WebApp
- `/api/latest` : JSON météo calculé côté serveur
- `/api/health` : test rapide

## Comportement
- cache serveur 15 min
- si un refresh échoue, le backend renvoie la dernière version en cache si elle existe

## Source front officielle
- `static/index.html` : interface active et fichier maître pour l'UI
- `_archive/script.js` et `_archive/check.js` : anciennes versions conservées hors circuit

## Correctifs inclus dans cette version
- manifeste PWA réaligné sur l'application actuelle (`start_url: /`)
- service worker nettoyé et versionné (`storm-chase-v2`)
- UI d'installation affichable aussi sur desktop si l'installation est disponible
- `forecast_hours` synchronisé avec `FORECAST_HOURS` dans `weather_logic.py`
