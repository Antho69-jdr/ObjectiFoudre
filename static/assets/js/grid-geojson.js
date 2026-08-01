// grid-geojson.js — issu du découpage de grid-core.js (Phase 3).
// Cache géométrie + construction GeoJSON des cellules + animation de révélation.
    const GRID_GEOMETRY_CACHE_MAX = 2600;
    const gridGeometryCache = new Map();
    const slotGeoJSONCache = new WeakMap();

    function buildSlotGeoJSON(slot, cells) {
      const safeCells = Array.isArray(cells) ? cells : [];
      const cacheKey = `${selectedColorMetric}|${safeCells.length}`;
      if (slot && typeof slot === 'object') {
        const cached = slotGeoJSONCache.get(slot);
        if (cached && cached.cells === safeCells && cached.cacheKey === cacheKey) return cached.geojson;
      }
      const geojson = buildGeoJSON(safeCells);
      if (slot && typeof slot === 'object') slotGeoJSONCache.set(slot, { cells: safeCells, cacheKey, geojson });
      return geojson;
    }

    function gridGeometryCacheKey(cell, clipToFrance) {
      return [
        clipToFrance ? 'france' : 'rect',
        cell.zone || '',
        Number(cell.lat || 0).toFixed(5),
        Number(cell.lon || 0).toFixed(5),
        Number(cell.cell_height_deg || 0).toFixed(6),
        Number(cell.cell_width_deg || 0).toFixed(6),
      ].join('|');
    }

    function getCellGeometry(cell, minLon, minLat, maxLon, maxLat, clipToFrance) {
      const key = gridGeometryCacheKey(cell, clipToFrance);
      if (gridGeometryCache.has(key)) return gridGeometryCache.get(key);
      const geometry = clipToFrance
        ? clippedFranceCellGeometry(minLon, minLat, maxLon, maxLat)
        : { type: 'Polygon', coordinates: [rectangleRing(minLon, minLat, maxLon, maxLat)] };
      if (!geometry) return null;
      if (gridGeometryCache.size >= GRID_GEOMETRY_CACHE_MAX) {
        const firstKey = gridGeometryCache.keys().next().value;
        if (firstKey) gridGeometryCache.delete(firstKey);
      }
      gridGeometryCache.set(key, geometry);
      return geometry;
    }

    function computeBestZoneSet(cells) {
      const ranked = [...cells].sort((a, b) => {
        const scoreDiff = Number(b.trigger_score || 0) - Number(a.trigger_score || 0);
        if (Math.abs(scoreDiff) > 0.001) return scoreDiff;
        return Number(b.confidence_score || 0) - Number(a.confidence_score || 0);
      });
      if (!ranked.length) return new Set();
      const topCount = Math.max(3, Math.min(10, Math.ceil(ranked.length * 0.12)));
      const strong = ranked.filter(cell => Number(cell.trigger_score || 0) >= 70 || (Number(cell.trigger_score || 0) >= 62 && Number(cell.confidence_score || 0) >= 62));
      const picked = strong.length ? strong.slice(0, Math.max(topCount, Math.min(12, strong.length))) : ranked.slice(0, topCount);
      return new Set(picked.map(cell => cell.zone));
    }

    function gridFeatureId(cell) {
      return String(cell?.zone || `${Number(cell?.lat || 0).toFixed(5)}:${Number(cell?.lon || 0).toFixed(5)}`);
    }

    function compactGridFeatureProperties(cell, isBest, fillMetric, fillColor, fillOpacity) {
      return {
        zone: cell?.zone || gridFeatureId(cell),
        trigger_score: Number(cell?.trigger_score || 0),
        confidence_score: Number(cell?.confidence_score || 0),
        fill_metric: fillMetric,
        fill_color: fillColor,
        fill_opacity: fillOpacity,
        is_best: isBest ? 1 : 0,
      };
    }

    function fullGridFeatureProperties(cell, isBest, fillMetric, fillColor, fillOpacity) {
      return {
        ...cell,
        is_best: isBest ? 1 : 0,
        fill_metric: fillMetric,
        fill_color: fillColor,
        fill_opacity: fillOpacity,
      };
    }


    function cellToFeature(cell, bestZones, entering = null, clipToFrance = false) {
      const baseOpacity = opacityFromScoreGlobal(cell.trigger_score);
      const isBest = bestZones.has(cell.zone);
      // Le mode « meilleures cellules » n'estompe plus le reste : il souligne désormais
      // les meilleures cellules avec l'overlay ambre pulsatile (cf. grid.js). La grille
      // garde donc son opacité normale quel que soit le mode.
      const fillOpacity = entering
        ? Math.max(0, Math.min(1, entering.opacity))
        : baseOpacity;
      const fillMetric = getCellMetricValue(cell);
      const fillColor = getCellFillColor(cell);
      const latOffset = entering ? entering.latOffset : 0;
      const lonOffset = entering ? entering.lonOffset : 0;
      const lat = Number(cell.lat) + latOffset;
      const lon = Number(cell.lon) + lonOffset;
      const h = Number(cell.cell_height_deg) / 2;
      const w = Number(cell.cell_width_deg) / 2;
      const minLon = lon - w;
      const maxLon = lon + w;
      const minLat = lat - h;
      const maxLat = lat + h;
      const geometry = entering
        ? (clipToFrance
            ? clippedFranceCellGeometry(minLon, minLat, maxLon, maxLat)
            : { type: 'Polygon', coordinates: [rectangleRing(minLon, minLat, maxLon, maxLat)] })
        : getCellGeometry(cell, minLon, minLat, maxLon, maxLat, clipToFrance);
      if (!geometry) return null;
      const properties = clipToFrance
        ? compactGridFeatureProperties(cell, isBest, fillMetric, fillColor, fillOpacity)
        : fullGridFeatureProperties(cell, isBest, fillMetric, fillColor, fillOpacity);
      return {
        type: 'Feature',
        id: gridFeatureId(cell),
        geometry,
        properties,
      };
    }

    function buildGeoJSON(cells, options = {}) {
      const bestZones = computeBestZoneSet(cells);
      const progressByZone = options.progressByZone || null;
      const clipToFrance = shouldUseFranceGridClip(cells);
      const features = cells.map(cell => {
        if (!progressByZone) return cellToFeature(cell, bestZones, null, clipToFrance);
        const progress = Math.max(0, Math.min(1, progressByZone.get(cell.zone) ?? 1));
        return cellToFeature(cell, bestZones, {
          opacity: opacityFromScoreGlobal(cell.trigger_score) * Math.pow(progress, 0.86),
          latOffset: cell.cell_height_deg * (1 - progress) * 0.82,
          lonOffset: -cell.cell_width_deg * (1 - progress) * 0.34,
        }, clipToFrance);
      }).filter(Boolean);
      return { type: 'FeatureCollection', features };
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
      const source = map.getSource(sourceId);
      if (!source) return;
      if (prefersReducedGridMotion(cells)) {
        source.setData(geojsonBuilder(cells));
        if (typeof onStep === 'function') onStep();
        if (typeof onComplete === 'function') onComplete();
        return;
      }
      const token = ++gridAnimationToken;
      const orderedCells = sortCellsForReveal(cells);
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
