    function stopLoaderPulse() {
      if (loaderPulseFrame !== null) {
        cancelAnimationFrame(loaderPulseFrame);
        loaderPulseFrame = null;
      }
      loaderPulseStart = 0;
      if (map.getSource('grid-loader')) {
        map.getSource('grid-loader').setData(buildLoaderGeoJSON(buildLoaderCells(currentCenter), 0));
      }
    }

    function clearGridRevealFailsafe() {
      if (gridRevealFailsafeTimer !== null) {
        clearTimeout(gridRevealFailsafeTimer);
        gridRevealFailsafeTimer = null;
      }
    }

    function forceGridVisible(cells = getCurrentSlot()?.cells || []) {
      clearGridRevealFailsafe();
      if (!map.isStyleLoaded()) return;
      if (Array.isArray(cells) && cells.length && ensureGridScaffolding() && map.getSource('grid')) {
        const slot = typeof getCurrentSlot === 'function' ? getCurrentSlot() : null;
        const gridGeoJSON = typeof buildSlotGeoJSON === 'function' ? buildSlotGeoJSON(slot, cells) : buildGeoJSON(cells);
        map.getSource('grid').setData(gridGeoJSON);
        if (typeof noteGridGeometryApplied === 'function') noteGridGeometryApplied(cells, gridGeoJSON);
        setGridFillFactor(1);
        applyGridLinesVisibility();
        updateHighlight();
      }
      removeLoaderLayers();
      if (!hasCompletedInitialLoad) {
        hasCompletedInitialLoad = true;
        hideAppLoader();
      }
    }

    function scheduleGridRevealFailsafe(cells) {
      clearGridRevealFailsafe();
      const waitMs = Math.max(980, Math.round(GRID_ANIMATION_CELL_MS * 1.7 + GRID_ANIMATION_STAGGER_SPAN_MS * 1.55));
      gridRevealFailsafeTimer = window.setTimeout(() => {
        const liveCells = getCurrentSlot()?.cells || [];
        const nextCells = liveCells.length ? liveCells : cells;
        forceGridVisible(nextCells);
      }, waitMs);
    }

    function startLoaderPulse() {
      stopLoaderPulse();
      if (!map.getSource('grid-loader')) return;
      const loaderCells = buildLoaderCells(currentCenter);
      loaderPulseStart = performance.now();
      const tick = (now) => {
        if (!map.getSource('grid-loader')) {
          stopLoaderPulse();
          return;
        }
        const elapsedMs = now - loaderPulseStart;
        map.getSource('grid-loader').setData(buildLoaderGeoJSON(loaderCells, elapsedMs));
        loaderPulseFrame = requestAnimationFrame(tick);
      };
      loaderPulseFrame = requestAnimationFrame(tick);
    }

    function animateLayerPaintNumber(layerId, property, from, to, duration, done = null) {
      if (!map.getLayer(layerId)) {
        if (typeof done === 'function') done();
        return;
      }
      const start = performance.now();
      const tick = (now) => {
        if (!map.getLayer(layerId)) return;
        const t = Math.min(1, (now - start) / duration);
        const eased = t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
        map.setPaintProperty(layerId, property, from + (to - from) * eased);
        if (t < 1) requestAnimationFrame(tick);
        else if (typeof done === 'function') done();
      };
      requestAnimationFrame(tick);
    }

    // Le paint lit d'abord le feature-state (mis à jour à chaque bascule d'heure sans
    // setData ni re-tessellation), avec repli sur les properties du setData initial.
    function gridFillColorExpression() {
      return ['coalesce', ['feature-state', 'fill_color'], ['get', 'fill_color']];
    }

    function gridFillOpacityExpression(factor = 1) {
      return ['*', ['coalesce', ['feature-state', 'fill_opacity'], ['get', 'fill_opacity']], factor];
    }

    function setGridFillFactor(factor) {
      if (!map.getLayer('grid-fill')) return;
      map.setPaintProperty('grid-fill', 'fill-opacity', gridFillOpacityExpression(factor));
    }

    function animateGridFillFactor(from, to, duration, done = null) {
      const token = ++gridFillPaintAnimationToken;
      if (prefersReducedGridMotion(getCurrentSlot()?.cells || [])) {
        setGridFillFactor(to);
        if (typeof done === 'function') done();
        return;
      }
      const start = performance.now();
      const tick = (now) => {
        if (token !== gridFillPaintAnimationToken) return;
        if (!map.getLayer('grid-fill')) return;
        const t = Math.min(1, (now - start) / duration);
        const eased = t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
        setGridFillFactor(from + (to - from) * eased);
        if (t < 1) requestAnimationFrame(tick);
        else if (typeof done === 'function') done();
      };
      requestAnimationFrame(tick);
    }
