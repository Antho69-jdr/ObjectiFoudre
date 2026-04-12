    function renderDayButtons() {
      const days = getDays();
      dayButtons.innerHTML = '';
      if (!days.length) return;
      if (!selectedDayKey || !days.some(d => d.day_key === selectedDayKey)) selectedDayKey = days[0].day_key;
      for (const day of days) {
        const btn = document.createElement('button');
        btn.textContent = day.day_label;
        btn.className = day.day_key === selectedDayKey ? 'active' : '';
        btn.onclick = () => {
          selectedDayKey = day.day_key;
          const firstSlot = getCurrentDay()?.slots?.[0];
          if (firstSlot) selectedSlotKey = firstSlot.slot_key;
          closeSelection();
          closeDetails();
          renderDayButtons();
          renderSlotButtons();
          requestAnimationFrame(alignTopPanels);
          refreshMap();
        };
        dayButtons.appendChild(btn);
      }
    }

    function renderSlotButtons() {
      const day = getCurrentDay();
      slotButtons.innerHTML = '';
      const slots = day?.slots || [];
      if (slotSelect) slotSelect.innerHTML = '';
      if (!slots.length) {
        if (slotSelect) {
          const opt = document.createElement('option');
          opt.value = '';
          opt.textContent = 'Aucun créneau disponible';
          slotSelect.appendChild(opt);
          slotSelect.disabled = true;
        }
        return;
      }
      if (!selectedSlotKey || !slots.some(s => s.slot_key === selectedSlotKey)) selectedSlotKey = slots[0].slot_key;
      if (slotSelect) {
        slotSelect.disabled = false;
        for (const slot of slots) {
          const opt = document.createElement('option');
          opt.value = slot.slot_key;
          opt.textContent = slot.slot_label;
          opt.selected = slot.slot_key === selectedSlotKey;
          slotSelect.appendChild(opt);
        }
        slotSelect.value = selectedSlotKey;
      }
      const todayHour = new Date().getHours();
      const isToday = normalizeDateIso(selectedBaseDate) === getTodayIsoDate();
      for (const slot of slots) {
        const btn = document.createElement('button');
        const startHour = Number(String(slot.slot_key || '').split('-')[0]);
        const isPastForecastSlot = isToday && Number.isFinite(startHour) && startHour < todayHour;
        btn.textContent = slot.slot_label;
        btn.className = `slot-pill ${slot.slot_key === selectedSlotKey ? 'active' : ''} ${isPastForecastSlot ? 'is-disabled' : ''}`.trim();
        if (isPastForecastSlot) btn.disabled = true;
        btn.onclick = () => {
          if (isPastForecastSlot) return;
          selectedSlotKey = slot.slot_key;
          closeSelection();
          closeDetails();
          renderSlotButtons();
          requestAnimationFrame(alignTopPanels);
          refreshMap();
        };
        slotButtons.appendChild(btn);
      }
    }

    function kmToDegLat(km) {
      return km / 111;
    }

    function kmToDegLon(km, lat) {
      return km / (111 * Math.cos((lat * Math.PI) / 180));
    }

    function deriveGridTemplate(cells) {
      if (!Array.isArray(cells) || !cells.length) return null;
      const latValues = [...new Set(cells.map(cell => Number(cell.lat).toFixed(6)))].sort((a, b) => Number(b) - Number(a));
      const lonValues = [...new Set(cells.map(cell => Number(cell.lon).toFixed(6)))].sort((a, b) => Number(a) - Number(b));
      const sample = cells[0] || {};
      const cellHeightDeg = Number(sample.cell_height_deg);
      const cellWidthDeg = Number(sample.cell_width_deg);
      return {
        rows: Math.max(1, latValues.length),
        cols: Math.max(1, lonValues.length),
        cellHeightDeg: Number.isFinite(cellHeightDeg) && cellHeightDeg > 0 ? cellHeightDeg : kmToDegLat(LOADER_CELL_SIZE_KM),
        cellWidthDeg: Number.isFinite(cellWidthDeg) && cellWidthDeg > 0 ? cellWidthDeg : kmToDegLon(LOADER_CELL_SIZE_KM, Number(sample.lat) || currentCenter.lat),
      };
    }

    function getLoaderTemplate(center) {
      const currentCells = getCurrentSlot()?.cells || [];
      const derived = deriveGridTemplate(currentCells);
      if (derived) {
        lastGridTemplate = derived;
        return {
          rows: LOADER_GRID_SIZE,
          cols: LOADER_GRID_SIZE,
          cellHeightDeg: derived.cellHeightDeg,
          cellWidthDeg: derived.cellWidthDeg,
        };
      }
      if (lastGridTemplate) {
        return {
          rows: LOADER_GRID_SIZE,
          cols: LOADER_GRID_SIZE,
          cellHeightDeg: Number.isFinite(lastGridTemplate.cellHeightDeg) && lastGridTemplate.cellHeightDeg > 0
            ? lastGridTemplate.cellHeightDeg
            : kmToDegLat(LOADER_CELL_SIZE_KM),
          cellWidthDeg: Number.isFinite(lastGridTemplate.cellWidthDeg) && lastGridTemplate.cellWidthDeg > 0
            ? lastGridTemplate.cellWidthDeg
            : kmToDegLon(LOADER_CELL_SIZE_KM, center.lat),
        };
      }
      const latStep = kmToDegLat(LOADER_CELL_SIZE_KM);
      return {
        rows: LOADER_GRID_SIZE,
        cols: LOADER_GRID_SIZE,
        cellHeightDeg: latStep,
        cellWidthDeg: kmToDegLon(LOADER_CELL_SIZE_KM, center.lat),
      };
    }

    function buildLoaderCells(center) {
      const cells = [];
      const template = getLoaderTemplate(center);
      const latStep = template.cellHeightDeg;
      const lonStep = template.cellWidthDeg;
      const rowOffset = (template.rows - 1) / 2;
      const colOffset = (template.cols - 1) / 2;
      let idx = 0;
      for (let row = 0; row < template.rows; row += 1) {
        for (let col = 0; col < template.cols; col += 1) {
          const rowFromCenter = rowOffset - row;
          const colFromCenter = col - colOffset;
          cells.push({
            zone: `loader-${idx++}`,
            lat: center.lat + rowFromCenter * latStep,
            lon: center.lon + colFromCenter * lonStep,
            cell_height_deg: latStep,
            cell_width_deg: lonStep,
            score_global: 18 + ((row + col) % 5) * 5,
            confidence_score: 42,
            chase_quality_score: 55,
            is_loader: true,
          });
        }
      }
      return cells;
    }

    function buildLoaderGeoJSON(cells, elapsedMs = 0) {
      if (!Array.isArray(cells) || !cells.length) {
        return { type: 'FeatureCollection', features: [] };
      }
      const centerLat = cells.reduce((sum, cell) => sum + Number(cell.lat || 0), 0) / cells.length;
      const centerLon = cells.reduce((sum, cell) => sum + Number(cell.lon || 0), 0) / cells.length;
      const distances = cells.map(cell => {
        const dLat = Number(cell.lat || 0) - centerLat;
        const dLon = Number(cell.lon || 0) - centerLon;
        return Math.hypot(dLat, dLon);
      });
      const maxDist = Math.max(...distances, 1e-9);
      const seconds = elapsedMs / 1000;
      const period = 2.85;
      const phase = (seconds / period) * Math.PI * 2;
      const waveWidth = 0.15;
      const features = cells.map((cell, idx) => {
        const dist = distances[idx] / maxDist;
        const wave = 0.5 + 0.5 * Math.sin((1 - dist) * Math.PI * 1.08 - phase);
        const crest = Math.pow(wave, 2.35);
        const secondary = Math.pow(0.5 + 0.5 * Math.sin((1 - dist) * Math.PI * 1.08 - phase - Math.PI * 0.62), 3.2);
        const envelope = 0.72 + 0.28 * Math.cos(dist * Math.PI * 0.92);
        const rimLift = Math.exp(-Math.pow((dist - 0.58) / waveWidth, 2)) * 0.018;
        const opacity = 0.03 + crest * 0.072 * envelope + secondary * 0.028 + rimLift;
        const feature = cellToFeature(cell, new Set(), { opacity, latOffset: 0, lonOffset: 0 });
        feature.properties.fill_opacity = opacity;
        feature.properties.loader_dist = dist;
        return feature;
      });
      return { type: 'FeatureCollection', features };
    }

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
