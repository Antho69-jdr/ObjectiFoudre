    function computeBestZoneSet(cells) {
      const ranked = [...cells].sort((a, b) => {
        const scoreDiff = Number(b.score_global || 0) - Number(a.score_global || 0);
        if (Math.abs(scoreDiff) > 0.001) return scoreDiff;
        return Number(b.confidence_score || 0) - Number(a.confidence_score || 0);
      });
      if (!ranked.length) return new Set();
      const topCount = Math.max(3, Math.min(10, Math.ceil(ranked.length * 0.12)));
      const strong = ranked.filter(cell => Number(cell.score_global || 0) >= 70 || (Number(cell.score_global || 0) >= 62 && Number(cell.confidence_score || 0) >= 62));
      const picked = strong.length ? strong.slice(0, Math.max(topCount, Math.min(12, strong.length))) : ranked.slice(0, topCount);
      return new Set(picked.map(cell => cell.zone));
    }

    function cellToFeature(cell, bestZones, entering = null) {
      const baseOpacity = opacityFromConfidence(cell.confidence_score);
      const isBest = bestZones.has(cell.zone);
      const fillOpacity = entering
        ? Math.max(0, Math.min(1, entering.opacity))
        : (bestCellsMode && !cell.is_loader
            ? (isBest ? Math.min(0.9, Math.max(baseOpacity, 0.58)) : Math.max(0.06, baseOpacity * 0.22))
            : baseOpacity);
      const latOffset = entering ? entering.latOffset : 0;
      const lonOffset = entering ? entering.lonOffset : 0;
      const lat = Number(cell.lat) + latOffset;
      const lon = Number(cell.lon) + lonOffset;
      const h = Number(cell.cell_height_deg) / 2;
      const w = Number(cell.cell_width_deg) / 2;
      return {
        type: 'Feature',
        geometry: { type: 'Polygon', coordinates: [[[lon - w, lat - h],[lon + w, lat - h],[lon + w, lat + h],[lon - w, lat + h],[lon - w, lat - h]]] },
        properties: { ...cell, is_best: isBest ? 1 : 0, fill_color: getCellFillColor(cell), fill_opacity: fillOpacity },
      };
    }

    function buildGeoJSON(cells, options = {}) {
      const bestZones = computeBestZoneSet(cells);
      const progressByZone = options.progressByZone || null;
      const features = cells.map(cell => {
        if (!progressByZone) return cellToFeature(cell, bestZones);
        const progress = Math.max(0, Math.min(1, progressByZone.get(cell.zone) ?? 1));
        return cellToFeature(cell, bestZones, {
          opacity: opacityFromConfidence(cell.confidence_score) * Math.pow(progress, 0.86),
          latOffset: cell.cell_height_deg * (1 - progress) * 0.82,
          lonOffset: -cell.cell_width_deg * (1 - progress) * 0.34,
        });
      });
      return { type: 'FeatureCollection', features };
    }


    function refreshGridColors() {
      if (!map?.isStyleLoaded?.()) return;
      const cells = getCurrentSlot()?.cells || [];
      if (map.getSource('grid') && cells.length) {
        map.getSource('grid').setData(buildGeoJSON(cells));
        updateHighlight();
      }
    }

    function sortCellsForReveal(cells) {
      return [...cells].sort((a, b) => {
        const keyA = (-Number(a.lat) * 1000) + (Number(a.lon) * 1000);
        const keyB = (-Number(b.lat) * 1000) + (Number(b.lon) * 1000);
        if (Math.abs(keyA - keyB) > 0.001) return keyA - keyB;
        const latDiff = Number(b.lat) - Number(a.lat);
        if (Math.abs(latDiff) > 0.0001) return latDiff;
        return Number(a.lon) - Number(b.lon);
      });
    }

    function animateRevealToSource(sourceId, cells, geojsonBuilder = buildGeoJSON, onStep = null, onComplete = null) {
      const token = ++gridAnimationToken;
      const orderedCells = sortCellsForReveal(cells);
      const source = map.getSource(sourceId);
      if (!source) return;
      const start = performance.now();
      const progressByZone = new Map();
      const staggerSpan = GRID_ANIMATION_STAGGER_SPAN_MS * 1.28;
      const count = Math.max(1, orderedCells.length - 1);
      const easeOutQuart = (t) => 1 - Math.pow(1 - t, 4);
      const frame = (now) => {
        if (token !== gridAnimationToken) return;
        const elapsed = now - start;
        let finished = 0;
        progressByZone.clear();
        for (let i = 0; i < orderedCells.length; i += 1) {
          const begin = (i / count) * staggerSpan;
          const raw = Math.max(0, Math.min(1, (elapsed - begin) / (GRID_ANIMATION_CELL_MS * 1.22)));
          const eased = raw <= 0 ? 0 : easeOutQuart(raw);
          progressByZone.set(orderedCells[i].zone, eased);
          if (raw >= 1) finished += 1;
        }
        source.setData(geojsonBuilder(orderedCells, { progressByZone }));
        if (typeof onStep === 'function') onStep();
        if (finished < orderedCells.length) {
          requestAnimationFrame(frame);
        } else if (typeof onComplete === 'function') {
          onComplete();
        }
      };
      requestAnimationFrame(frame);
    }

    function animateGridReveal(cells, onDone = null) {
      stopLoaderPulse();
      animateRevealToSource('grid', cells, buildGeoJSON, updateHighlight, () => {
        const finish = () => { if (typeof onDone === 'function') onDone(); };
        if (map.getLayer('grid-loader-fill')) {
          const currentOpacity = map.getPaintProperty('grid-loader-fill', 'fill-opacity');
          const from = typeof currentOpacity === 'number' ? currentOpacity : 0.06;
          animateLayerPaintNumber('grid-loader-fill', 'fill-opacity', from, 0, 220, () => { removeLoaderLayers(); finish(); });
        } else {
          removeLoaderLayers();
          finish();
        }
      });
    }

    function ensureSource(id, data) {
      if (map.getSource(id)) map.getSource(id).setData(data);
      else map.addSource(id, { type: 'geojson', data });
    }

    function removeLoaderLayers() {
      clearGridRevealFailsafe();
      gridAnimationToken += 1;
      stopLoaderPulse();
      if (map.getLayer('grid-loader-fill')) map.removeLayer('grid-loader-fill');
      if (map.getSource('grid-loader')) map.removeSource('grid-loader');
    }

    function showLoadingGrid(center) {
      if (!map.isStyleLoaded()) return;
      removeLoaderLayers();
      const cells = buildLoaderCells(center);
      ensureSource('grid-loader', buildLoaderGeoJSON(cells, 0));
      map.addLayer({
        id: 'grid-loader-fill',
        type: 'fill',
        source: 'grid-loader',
        paint: {
          'fill-color': '#7dd3fc',
          'fill-opacity': ['get', 'fill_opacity'],
        }
      });
      startLoaderPulse();
    }

    function removeLayers(keepLoader = false) {
      clearGridRevealFailsafe();
      gridAnimationToken += 1;
      removeLoaderLayers();
      if (map.getLayer('grid-highlight')) map.removeLayer('grid-highlight');
      if (map.getLayer('grid-borders')) map.removeLayer('grid-borders');
      if (map.getLayer('grid-fill')) map.removeLayer('grid-fill');
      if (map.getSource('grid')) map.removeSource('grid');
      map.off('click', 'grid-fill', onGridClick);
      map.off('mouseenter', 'grid-fill', onGridEnter);
      map.off('mouseleave', 'grid-fill', onGridLeave);
    }

    function addLayers(data) {
      ensureSource('grid', data);
      map.addLayer({
        id: 'grid-fill',
        type: 'fill',
        source: 'grid',
        paint: {
          'fill-color': ['get', 'fill_color'],
          'fill-opacity': ['*', ['get', 'fill_opacity'], 0],
          'fill-antialias': false
        }
      });
      map.addLayer({
        id: 'grid-borders',
        type: 'line',
        source: 'grid',
        paint: {
          'line-color': '#ffffff',
          'line-width': 1,
          'line-opacity': showGridLines ? 0.5 : 0,
        }
      });
      map.addLayer({
        id: 'grid-highlight',
        type: 'line',
        source: 'grid',
        paint: {
          'line-color': '#ffffff',
          'line-width': 2.2,
          'line-opacity': ['case', ['==', ['get', 'zone'], selectedFeature?.zone || ''], 1, 0],
        }
      });

      map.on('click', 'grid-fill', onGridClick);
      map.on('mouseenter', 'grid-fill', onGridEnter);
      map.on('mouseleave', 'grid-fill', onGridLeave);
      animateGridFillFactor(0, 1, 260, () => { applyGridLinesVisibility(); updateHighlight(); });
    }

    function onGridEnter() {
      map.getCanvas().style.cursor = 'pointer';
    }

    function onGridLeave() {
      map.getCanvas().style.cursor = '';
    }

    function onGridClick(e) {
      const p = e.features?.[0]?.properties;
      if (!p) return;
      selectedFeature = p;
      showSelection(p);
      updateHighlight();
    }

    function updateHighlight() {
      if (!map.getLayer('grid-highlight')) return;
      map.setPaintProperty('grid-highlight', 'line-opacity', ['case', ['==', ['get', 'zone'], selectedFeature?.zone || ''], 1, 0]);
    }

    function updateGridLinesButton() {
      if (!gridLinesBtn) return;
      gridLinesBtn.classList.toggle('active', showGridLines);
    }

    function applyGridLinesVisibility() {
      if (map.getLayer('grid-borders')) {
        map.setPaintProperty('grid-borders', 'line-opacity', showGridLines ? 0.5 : 0);
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
      const slot = getCurrentSlot();
      const cells = slot?.cells || [];
      lastGridTemplate = deriveGridTemplate(cells) || lastGridTemplate;
      refreshStats(cells, slot);
      if (!map.isStyleLoaded()) return;
      clearGridRevealFailsafe();
      removeLayers(true);
      if (!cells.length) {
        removeLoaderLayers();
        return;
      }
      stopLoaderPulse();
      addLayers(buildGeoJSON(cells));
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
