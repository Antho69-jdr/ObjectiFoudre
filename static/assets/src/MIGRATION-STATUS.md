# Statut de la refonte CSS

> ⚠️ Ce document a été réécrit le 2026-06-29 pour refléter la stratégie
> RÉELLEMENT suivie. L'ancien plan (« reconstruire toutes les surfaces dans
> `dist/app.css` puis bascule UNIQUE en retirant les 3 CSS legacy ») a été
> ABANDONNÉ : il butait sur le mur des `!important` legacy (un `!important`
> bat tout sélecteur sans `!important`, quel que soit l'ordre/la spécificité).

## Stratégie retenue : staging + cutover incrémental, surface par surface

1. `styles/theme.css` (→ `dist/theme.css`) est chargé EN DERNIER dans
   `index.html`, après les 3 CSS legacy (`main.css` + `components.css` +
   `responsive.css`). Il importe `tokens.css` (DA) puis les components.
2. Pour CHAQUE surface : on mesure le computed live (baseline), on écrit un
   component scopé aux valeurs exactes, on l'`@import` dans theme.css, on
   **purge le legacy correspondant** au niveau règle (`scratchpad/port_delete.py`,
   lossless md5, whitelist EXACTE + PROTECT chase/partagés), on valide la parité
   computed, on bump le cache (index.html + sw.js + APP_VERSION).
3. Le legacy n'est donc PAS retiré d'un coup : il est vidé progressivement.

Conventions : préfixe `of-` = primitives DS ; couleurs → tokens ; viser
0 `!important` dans les components (gagné par le scope + l'ordre de chargement,
une fois le legacy `!important` purgé). Pas de modif du HTML.

## Surfaces — LOOK componentisé (✅ TERMINÉ)

- [x] Timeline dock (rail + molette + toggle/collapse + nav/play/export) — `components/timeline.css`
- [x] Rail droit (boutons icône verre) — `components/rail.css`
- [x] Recherche (barre, input, loupe, dropdown autocomplete) — `components/search.css`
- [x] Carte de sélection — `components/selection.css`
- [x] Modale détails (header, inspecteur, content-grid, cards, chips, profil vent) — `components/details-modal.css`
- [x] Badges carte (horloge / date / quota) — `components/badges.css`
- [x] Bouton générique + conteneurs + contrôles maplibre — `components/button.css`
- [x] Légende proba — `components/forecast-scales.css`
- [x] Écrans système (loader/splash + blocage mobile) — `components/system-screens.css`
- [x] Page Prévision + Historique (coquille partagée + contenu data) — `components/prediction-page.css`
- [x] Frise-help (bouton aide mobile) — `components/frise-help.css`
- [x] Meta-stack (bandeau bas desktop : version | run + marquee | échelle) — `components/meta-stack.css`

## Reste (dette de fond, DIFFÉRÉ — voir mémoire `project_chantier_ui`)

Chaque cutover a migré le LOOK mais laissé le LAYOUT/POSITION en legacy
`!important` (choix « look séparable d'abord »). Les 3 CSS legacy survivent donc :

- [ ] **Layout/position** : positionnement fixed/inset, grilles plein-écran,
      compaction `body.mobile-ui` tactile. ~546 `!important` responsive.css +
      162 components.css restants (majoritairement position/dims, pas du look).
      → migrer pour pouvoir RETIRER les 3 CSS legacy et viser 0 `!important`.
- [ ] **Mode Chasse** (overlay radar/nowcast) : seule surface fonctionnelle non
      componentisée. ~101 refs `chase` dans components.css. Réutilise les
      components timeline/rail recolorés en rouge, mais son layout d'overlay
      reste legacy. → surface dédiée.

## Bascule finale (quand layout + chase seront faits)

1. `index.html` : retirer les 3 `<link>` legacy, ne garder que `theme.css`
   (ou fusionner dans `dist/app.css`).
2. Rebuild, recharger, screenshots desktop/tablette/mobile + modale/sélection/pages/chase.
3. Diff vs baselines → corriger surface par surface.
4. Bump cache (index.html + sw.js CACHE_NAME + APP_VERSION).
5. Supprimer `main.css`, `components.css`, `responsive.css`.
