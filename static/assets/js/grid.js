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

    function refreshMap() {
      if (!map.isStyleLoaded()) return;
      const selection = resolveRenderableSelection();
      const currentDay = getCurrentDay();
      const renderableSlots = getRenderableSlots(currentDay);

      renderDayButtons();
      renderSlotButtons();

      if (!selection.dayKey || !selection.slotKey || !renderableSlots.length) {
        clearGridRevealFailsafe();
        removeLayers(true);
        return;
      }

      const slot = getCurrentSlot();
      const cells = Array.isArray(slot?.cells) ? slot.cells : [];
      if (!cells.length) {
        clearGridRevealFailsafe();
        removeLayers(true);
        return;
      }

      lastGridTemplate = deriveGridTemplate(cells) || lastGridTemplate;
      refreshStats(cells, slot);
      clearGridRevealFailsafe();
      stopLoaderPulse();
      const gridRendered = addLayers(buildGeoJSON(cells), cells);
      if (!gridRendered) {
        console.error('Grid render aborted: scaffolding unavailable');
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
