    function applyGridLinesVisibility() {
      if (map.getLayer('grid-outline')) {
        map.setPaintProperty('grid-outline', 'line-opacity', 0);
      }
    }

    function updateBestCellsButton() {
      if (!bestCellsBtn) return;
      bestCellsBtn.classList.toggle('active', bestCellsMode);
      bestCellsBtn.setAttribute('aria-pressed', bestCellsMode ? 'true' : 'false');
    }

    // ── « Meilleures cellules » : overlay façon carte du mode étoile ────────────
    // Reprend le rendu du mode chasse d'étoiles : liseré ambre PULSATILE (halo large flou
    // + trait net) + intérieur rempli (item #5). Souligne TOUT l'amas orageux contigu des
    // cellules les mieux notées du créneau (à ≤ BEST_REL_DROP pts du meilleur trigger_score
    // et ≥ BEST_MIN_ABS) : intérieur rempli fondu en un bloc, liseré sur le PÉRIMÈTRE
    // seulement (pas de quadrillage). Remplace l'ancien mode « on estompe le reste ».
    const BEST_LAYERS = ['grid-best-fill', 'grid-best-glow', 'grid-best-line'];
    const BEST_MIN_ABS = 20;      // ne jamais souligner une cellule sous ce score
    const BEST_REL_DROP = 15;     // on garde les cellules à moins de 15 pts du meilleur

    // Toutes les cellules « chaudes » du créneau : à ≤ BEST_REL_DROP pts du meilleur
    // trigger_score et ≥ BEST_MIN_ABS. On ne dédoublonne PLUS : on veut voir TOUT
    // l'amas orageux contigu (choix Anthony), pas un point par spot.
    function selectBestCells(cells) {
      let mx = 0;
      for (const c of cells) { const s = Number(c?.trigger_score || 0); if (s > mx) mx = s; }
      const floor = Math.max(BEST_MIN_ABS, mx - BEST_REL_DROP);
      return cells.filter((c) => c && !c.is_loader && Number(c.trigger_score || 0) >= floor);
    }

    // FeatureCollection de l'overlay : intérieur REMPLI (un polygone par cellule chaude,
    // rognés à la France → ils se fondent en un bloc) + liseré seulement sur le PÉRIMÈTRE
    // de l'amas (les arêtes partagées entre deux cellules chaudes sont supprimées → pas de
    // quadrillage interne). Les polygones alimentent grid-best-fill ; les LineString de
    // périmètre alimentent grid-best-glow/-line (filtrés par type de géométrie).
    function computeBestCellsFC(cells) {
      if (!Array.isArray(cells) || !cells.length) return EMPTY_FEATURE_COLLECTION;
      const hot = selectBestCells(cells);
      if (!hot.length) return EMPTY_FEATURE_COLLECTION;
      const clip = typeof shouldUseFranceGridClip === 'function' ? shouldUseFranceGridClip(cells) : false;
      const cw = Number(hot[0].cell_width_deg) || 0.1;
      const ch = Number(hot[0].cell_height_deg) || 0.1;
      const idx = (lat, lon) => Math.round(lat / ch) + ':' + Math.round(lon / cw);
      const present = new Set(hot.map((c) => idx(Number(c.lat), Number(c.lon))));
      const feats = [];
      for (const cell of hot) {
        const lat = Number(cell.lat), lon = Number(cell.lon);
        const w = Number(cell.cell_width_deg) / 2, h = Number(cell.cell_height_deg) / 2;
        // intérieur rempli (géométrie rognée, comme la grille)
        const geom = typeof getCellGeometry === 'function'
          ? getCellGeometry(cell, lon - w, lat - h, lon + w, lat + h, clip)
          : null;
        if (geom) feats.push({ type: 'Feature', properties: { kind: 'fill', zone: cell.zone }, geometry: geom });
        // arêtes de périmètre : seulement les côtés SANS voisin chaud
        const gi = Math.round(lat / ch), gj = Math.round(lon / cw);
        const edges = [];
        if (!present.has((gi) + ':' + (gj + 1))) edges.push([[lon + w, lat - h], [lon + w, lat + h]]);   // est
        if (!present.has((gi) + ':' + (gj - 1))) edges.push([[lon - w, lat - h], [lon - w, lat + h]]);   // ouest
        if (!present.has((gi + 1) + ':' + (gj))) edges.push([[lon - w, lat + h], [lon + w, lat + h]]);   // nord
        if (!present.has((gi - 1) + ':' + (gj))) edges.push([[lon - w, lat - h], [lon + w, lat - h]]);   // sud
        for (const e of edges) feats.push({ type: 'Feature', properties: { kind: 'edge' }, geometry: { type: 'LineString', coordinates: e } });
      }
      return { type: 'FeatureCollection', features: feats };
    }

    // Liseré PULSATILE : bat opacité/épaisseur en sinus (~1,4 s), throttlé ~22 fps.
    let bestPulseRAF = null, bestPulseLast = 0;
    function bestPulseTick(t) {
      if (!bestCellsMode) { bestPulseRAF = null; return; }
      if (t - bestPulseLast >= 45) {
        bestPulseLast = t;
        const k = 0.5 + 0.5 * Math.sin(t / 1000 * 2.2);
        try {
          if (map.getLayer('grid-best-glow')) {
            map.setPaintProperty('grid-best-glow', 'line-opacity', 0.24 + 0.44 * k);
            map.setPaintProperty('grid-best-glow', 'line-width', 6.5 + 6.5 * k);
          }
          if (map.getLayer('grid-best-line')) map.setPaintProperty('grid-best-line', 'line-opacity', 0.68 + 0.32 * k);
          if (map.getLayer('grid-best-fill')) map.setPaintProperty('grid-best-fill', 'fill-opacity', 0.12 + 0.14 * k);
        } catch (_) {}
      }
      bestPulseRAF = requestAnimationFrame(bestPulseTick);
    }
    function startBestPulse() { if (bestPulseRAF == null) { bestPulseLast = 0; bestPulseRAF = requestAnimationFrame(bestPulseTick); } }
    function stopBestPulse() { if (bestPulseRAF != null) { cancelAnimationFrame(bestPulseRAF); bestPulseRAF = null; } }

    // (Re)peuple l'overlay pour le créneau courant + gère visibilité/pulsation.
    function updateBestCellsOverlay() {
      if (!map || !map.getSource || !map.getSource('grid-best')) return;
      const slot = getCurrentSlot();
      const cells = Array.isArray(slot?.cells) ? slot.cells : [];
      const fc = bestCellsMode ? computeBestCellsFC(cells) : EMPTY_FEATURE_COLLECTION;
      try { map.getSource('grid-best').setData(fc); } catch (_) {}
      const visible = bestCellsMode && fc.features.length > 0;
      BEST_LAYERS.forEach((id) => {
        if (map.getLayer(id)) { try { map.setLayoutProperty(id, 'visibility', visible ? 'visible' : 'none'); } catch (_) {} }
      });
      if (visible) startBestPulse(); else stopBestPulse();
    }

    function applyBestCellsModeToCurrentMap() {
      updateBestCellsButton();
      if (!map.isStyleLoaded() || !ensureGridScaffolding()) return;
      updateBestCellsOverlay();
    }

    function toggleBestCellsMode() {
      bestCellsMode = !bestCellsMode;
      applyBestCellsModeToCurrentMap();
    }

    function mean(values) {
      if (!values.length) return 0;
      return Math.round(values.reduce((a, b) => a + b, 0) / values.length);
    }

    function refreshStats(cells, slot) {
      return { cells, slot };
    }

    function resolveRenderableSelection() {
      const days = getDays();
      const selection = findFirstRenderableSelection(days, selectedDayKey, selectedSlotKey);
      selectedDayKey = selection.dayKey;
      selectedSlotKey = selection.slotKey;
      return selection;
    }


    function retryRefreshWhenStyleReady(reason = 'style-not-ready') {
      debugLog('retryRefreshWhenStyleReady:schedule', {
        reason,
        hasMap: !!map,
        styleLoaded: !!(map && map.isStyleLoaded && map.isStyleLoaded()),
        pending: refreshMapRetryPending,
      });
      if (!map) return;
      if (refreshMapRetryPending) return;
      refreshMapRetryPending = true;
      const rerender = () => {
        if (!refreshMapRetryPending) return;
        refreshMapRetryPending = false;
        debugLog('retryRefreshWhenStyleReady:run', {
          reason,
          styleLoaded: !!(map && map.isStyleLoaded && map.isStyleLoaded()),
        });
        requestAnimationFrame(refreshMap);
      };
      if (map.isStyleLoaded && map.isStyleLoaded()) {
        requestAnimationFrame(rerender);
        return;
      }
      map.once('idle', rerender);
      map.once('styledata', rerender);
      window.setTimeout(rerender, 700);
    }

    function refreshMap() {
      if (!map.isStyleLoaded()) {
        retryRefreshWhenStyleReady('refreshMap-style-not-ready');
        return;
      }
      const selection = resolveRenderableSelection();
      debugLog('refreshMap:selection', selection);
      const currentDay = getCurrentDay();
      const renderableSlots = getRenderableSlots(currentDay);

      renderDayButtons();
      renderSlotButtons();

      debugLog('refreshMap:renderable-slots', renderableSlots.map(slot => ({ slotKey: slot?.slot_key, cells: Array.isArray(slot?.cells) ? slot.cells.length : 0 })));
      if (!selection.dayKey || !selection.slotKey || !renderableSlots.length) {
        clearGridRevealFailsafe();
        removeLayers(true);
        updateBestCellsOverlay();   // rien à souligner → masque l'overlay + stoppe le pulse
        if (typeof updateGridSourceBadge === 'function') updateGridSourceBadge();
        return;
      }

      const slot = getCurrentSlot();
      const cells = Array.isArray(slot?.cells) ? slot.cells : [];
      debugLog('refreshMap:slot', { slotKey: slot?.slot_key || null, slotLabel: slot?.slot_label || null, cellCount: cells.length, selectedDayKey, selectedSlotKey });
      if (!cells.length) {
        clearGridRevealFailsafe();
        const shouldKeepPreviousAromeGrid = slot?.arome_placeholder
          && slot?.source_provider === 'meteofrance_arome_grib'
          && (map.getSource('grid') || map.getLayer('grid-fill'));
        if (!shouldKeepPreviousAromeGrid) {
          removeLayers(true);
        }
        updateBestCellsOverlay();   // rien à souligner → masque l'overlay + stoppe le pulse
        if (typeof updateGridSourceBadge === 'function') updateGridSourceBadge();
        return;
      }

      lastGridTemplate = deriveGridTemplate(cells) || lastGridTemplate;
      refreshStats(cells, slot);
      clearGridRevealFailsafe();
      stopLoaderPulse();
      const gridGeoJSON = buildSlotGeoJSON(slot, cells);
      debugLog('refreshMap:geojson', { featureCount: Array.isArray(gridGeoJSON?.features) ? gridGeoJSON.features.length : 0 });
      const gridRendered = addLayers(gridGeoJSON, cells);
      if (!gridRendered) {
        console.error('Grid render aborted: scaffolding unavailable');
        debugLog('refreshMap:render-aborted', {
          reason: 'scaffolding unavailable',
          styleLoaded: !!(map && map.isStyleLoaded && map.isStyleLoaded()),
          hasGridSource: !!(map && map.getSource && map.getSource('grid')),
          hasOutlineSource: !!(map && map.getSource && map.getSource('grid-outline')),
          hasGridFillLayer: !!(map && map.getLayer && map.getLayer('grid-fill')),
        });
        retryRefreshWhenStyleReady('addLayers-false');
        return;
      }

      if (shouldAnimateNextGrid) {
        scheduleGridRevealFailsafe(cells);
        animateGridReveal(cells, () => {
          clearGridRevealFailsafe();
          shouldAnimateNextGrid = false;
          // Loader d'ouverture fermé après l'hydratation de la journée, pas au
          // premier créneau rendu (cf. loadAromeFranceData).
          if (!hasCompletedInitialLoad) {
            hasCompletedInitialLoad = true;
          }
        });
      } else {
        setGridFillFactor(1);
        removeLoaderLayers();
        updateHighlight();
      }

      updateBestCellsOverlay();   // suit le créneau affiché si le mode est actif

      if (typeof updateMetaLine === 'function') updateMetaLine();
      else if (typeof updateGridSourceBadge === 'function') updateGridSourceBadge();
      if (typeof maybePrecomputePredictionPageImage === 'function') maybePrecomputePredictionPageImage();
      requestAnimationFrame(positionSelectionCard);
    }


    function debugRenderedGridFeatures() {
      if (!map || !map.isStyleLoaded()) return;
      if (!map.getLayer('grid-fill')) {
        debugLog('debugRenderedGridFeatures:no-layer');
        return;
      }
      try {
        const features = map.queryRenderedFeatures({ layers: ['grid-fill'] });
        debugLog('debugRenderedGridFeatures', { renderedFeatures: Array.isArray(features) ? features.length : 0 });
      } catch (error) {
        console.warn('debugRenderedGridFeatures:error', error);
      }
    }
