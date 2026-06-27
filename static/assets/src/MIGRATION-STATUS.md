# Phase 2 — Statut de la reconstruction CSS

## ⚑ STAGING LIVRÉ (v1.2.114) — DA d'abord, structure ensuite
Décision : appliquer la nouvelle DA SANS refondre le layout d'abord.
`styles/theme.css` (build → `dist/theme.css`) ne redéfinit QUE les tokens couleur
(--bg/--panel/--panel-2/--text/--muted/--border/--shadow/--accent/--accent-2/--glass-blur)
et est chargé EN DERNIER dans index.html, après les 3 CSS legacy. Résultat : toute
l'app passe à l'ink profond + cyan, layout 100% intact (validé desktop+mobile, 0 erreur).
NE PAS y mettre les variables structurelles (--rail-*, --timeline-*…) : responsive.css
les fait varier par breakpoint, on les écraserait.
Reste à fignoler : quelques couleurs en dur dans le legacy (ex. état .active du rail
= rose/bleu codé en dur, pas via token).

## Reconstruction structurelle complète (différée) — rebuild puis bascule unique

Mécanique validée : on reconstruit TOUTES les surfaces dans `src/styles/`, puis on remplace
les 3 CSS legacy (`main.css` + `components.css` + `responsive.css`) par le seul bundle
`dist/app.css` en UNE bascule, validée contre les baselines (desktop/tablette/mobile),
puis on corrige les régressions au screenshot.

Baselines capturées : `baseline-{desktop,tablet,mobile}-chrome.png` (loader masqué pour voir le chrome).

## Surfaces — état

- [x] Fondations : tokens, base (reset/typo), breakpoints + app-shell (`layout.css`)
- [x] Rail droit : positionnement (`layout.css`) + boutons icône (`components/rail.css`)
- [x] Badges carte : meta-stack, grid-source, quota (`components/badges.css`)
- [x] Carte de sélection : hero-score, quick-grid, summary, actions (`components/selection.css`)
- [x] Modale détails + tiroir info + chips flottants + KPIs (`components/details-modal.css`)
- [x] Primitives DS : button, panel, input, chip, modal, forecast-scales
- [ ] Timeline dock : dock, slot-pills (+ badges AROME), curseur, day-buttons, nav/play/export
- [ ] Recherche : search-dock, location-bar, location-input, #searchCityBtn, autocomplete dropdown
- [ ] Base `button` générique + `.ghost-btn` + `.button-row`
- [ ] Légende (legend-gradient/scale) + info-drawer contenu
- [ ] Loader (#appLoader) + mobile-block (#mobileBlockScreen)
- [ ] Page Prévision (controls.js) — overlay + sélecteur date + carte image + légende sévérité
- [ ] Page Historique (history.js) — overlay archive
- [ ] Mode Chasse (chase.js) — overlay radar/nowcast
- [ ] responsive.css (5008 l.) : passer en revue les overrides restants par surface (mobile/tablette/paysage)

## Bascule (à la fin seulement)

1. `index.html` : retirer les 3 `<link>` legacy, ajouter `<link href="/assets/dist/app.css?v=...">`.
2. Rebuild, recharger, screenshots desktop/tablette/mobile + ouverture modale/sélection/pages.
3. Diff vs baselines → corriger surface par surface.
4. Bump cache (index.html + sw.js CACHE_NAME + APP_VERSION) — discipline PWA.
5. Supprimer `main.css`, `components.css`, `responsive.css`, `responsive.css.bak`.

## Conventions

- Préfixe `of-` = primitives DS neuves ; on garde les classes/ids legacy pour le reste (pas de modif HTML en Phase 2).
- Zéro `!important` (sauf la règle a11y `prefers-reduced-motion`).
- Couleurs → tokens (`tokens.css`). Pas de hex en dur sauf nuances de statut ponctuelles.
