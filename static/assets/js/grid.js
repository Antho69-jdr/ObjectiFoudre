    function applyGridLinesVisibility() {
      if (map.getLayer('grid-outline')) {
        map.setPaintProperty('grid-outline', 'line-opacity', 0);
      }
    }

    function updateBestCellsButton() {
      if (!bestCellsBtn) return;
      bestCellsBtn.classList.toggle('active', bestCellsMode);
    }

    function applyBestCellsModeToCurrentMap() {
      const slot = getCurrentSlot();
      const cells = slot?.cells || [];
      if (!map.isStyleLoaded() || !ensureGridScaffolding() || !map.getSource('grid') || !cells.length) {
        updateBestCellsButton();
        return;
      }
      addLayers(buildSlotGeoJSON(slot, cells), cells);
      applyGridLinesVisibility();
      updateHighlight();
      updateBestCellsButton();
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
