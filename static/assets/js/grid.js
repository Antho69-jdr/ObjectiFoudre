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
      if (!map.isStyleLoaded() || !map.getSource('grid') || !cells.length) {
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

    function refreshMap() {
      if (!map.isStyleLoaded()) return;
      const currentDay = getCurrentDay();
      const renderableSlots = getRenderableSlots(currentDay);
      if (!renderableSlots.length) {
        clearGridRevealFailsafe();
        removeLayers(true);
        removeLoaderLayers();
        hideGridCornerMask();
        return;
      }
      if (!selectedSlotKey || !renderableSlots.some((slot) => slot.slot_key === selectedSlotKey)) {
        selectedSlotKey = renderableSlots[0].slot_key;
        renderSlotButtons();
      }
      const slot = getCurrentSlot();
      const cells = slot?.cells || [];
      if (!cells.length) {
        clearGridRevealFailsafe();
        removeLayers(true);
        removeLoaderLayers();
        hideGridCornerMask();
        return;
      }
      lastGridTemplate = deriveGridTemplate(cells) || lastGridTemplate;
      refreshStats(cells, slot);
      clearGridRevealFailsafe();
      removeLayers(true);
      stopLoaderPulse();
      addLayers(buildGeoJSON(cells), cells);
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
