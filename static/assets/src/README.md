# Frontend `src/` — build local

Ce dossier contient **la source** du frontend ObjectiFoudre (CSS design-system + modules JS ES).
Le build est **local uniquement** (esbuild). Render est `runtime: python` et n'a pas de node :
on **committe** donc la sortie `assets/dist/`.

## Commandes (depuis `static/`)

```sh
npm install      # une fois : installe esbuild en devDependency
npm run build    # produit assets/dist/app.js + app.css
npm run watch    # rebuild auto pendant le dev
```

## Arborescence

```
src/
  styles/
    tokens.css        # SOURCE UNIQUE de la direction artistique (couleurs, espacements, rayons, ombres, typo, z-index)
    base.css          # reset + typographie de base
    layout.css        # app shell + grilles + breakpoints
    components/*.css   # une primitive par fichier (button, panel, input, chip, modal, rail, timeline…)
    index.css         # ordre des couches (tokens → base → layout → components)
  js/
    core/             # boot, registre de components, état partagé, helpers DOM
    data/             # data, services, cache idb, chargement grille
    map/              # carte, couches grille
    features/         # prévision, historique, chasse, timeline, sélection
    components/        # AppShell, SearchDock, RightRail, TimelineDock, SelectionCard, DetailsModal, Loader, MapBadges, MobileBlock
    main.js           # entrée du bundle
```

## Discipline cache PWA

Après un build qui change le rendu, bumper **ensemble** : `index.html` (`?v=`), `sw.js` (`CACHE_NAME` + `ASSETS`), `app.py` (`APP_VERSION`).
