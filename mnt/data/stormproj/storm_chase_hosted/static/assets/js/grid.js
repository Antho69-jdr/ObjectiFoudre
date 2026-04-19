    function updateGridLinesButton() {
      if (!gridLinesBtn) return;
      gridLinesBtn.classList.toggle('active', showGridLines);
    }

    function applyGridLinesVisibility() {
      if (map.getLayer('grid-borders')) {
        map.setPaintProperty('grid-borders', 'line-opacity', showGridLines ? (isCoarsePointerDevice() ? 0.32 : 0.5) : 0);
      }
      if (map.getLayer('grid-outline')) {
        map.setPaintProperty('grid-outline', 'line-opacity', showGridLines ? 0.7 : 0.42);
      }
      updateGridLinesButton();
    }

    function toggleGridLines() {
      showGridLines = !showGridLines;
      applyGridLinesVisibility();
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
        updateGridLinesButton();
        return;
      }
      map.getSource('grid').setData(buildGeoJSON(cells));
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
      });
      if (!map) return;
      const rerender = () => {
        debugLog('retryRefreshWhenStyleReady:run', {
          reason,
          styleLoaded: !!(map && map.isStyleLoaded && map.isStyleLoaded()),
        });
        refreshMap();
      };
      if (map.isStyleLoaded && map.isStyleLoaded()) {
        requestAnimationFrame(rerender);
        return;
      }
      map.once('idle', rerender);
      map.once('styledata', rerender);
    }

    function refreshMap() {
      if (!map.isStyleLoaded()) return;
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
        return;
      }

      const slot = getCurrentSlot();
      const cells = Array.isArray(slot?.cells) ? slot.cells : [];
      debugLog('refreshMap:slot', { slotKey: slot?.slot_key || null, slotLabel: slot?.slot_label || null, cellCount: cells.length, selectedDayKey, selectedSlotKey });
      if (!cells.length) {
        clearGridRevealFailsafe();
        removeLayers(true);
        return;
      }

      lastGridTemplate = deriveGridTemplate(cells) || lastGridTemplate;
      refreshStats(cells, slot);
      clearGridRevealFailsafe();
      stopLoaderPulse();
      const gridGeoJSON = buildGeoJSON(cells);
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
          if (!hasCompletedInitialLoad) {
            hasCompletedInitialLoad = true;
            hideAppLoader();
          }
        });
      } else {
        setGridFillFactor(1);
        removeLoaderLayers();
        updateHighlight();
      }

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
