const EMPTY_FEATURE_COLLECTION = { type: 'FeatureCollection', features: [] };
let gridHandlersBound = false;
let pendingGridPayload = null;
let pendingGridRetryTimer = null;

function ensureSource(id, data = EMPTY_FEATURE_COLLECTION) {
  if (!map) return null;
  const existing = map.getSource(id);
  if (existing) return existing;
  try {
    map.addSource(id, { type: 'geojson', data });
  } catch (error) {
    console.warn(`ensureSource:${id}:add-failed`, error);
  }
  return map.getSource(id) || null;
}

function buildGridOutlineGeoJSON(cells) {
  if (!Array.isArray(cells) || !cells.length) return EMPTY_FEATURE_COLLECTION;
  const edges = cells.map((cell) => {
    const lat = Number(cell.lat || 0);
    const lon = Number(cell.lon || 0);
    const halfH = Number(cell.cell_height_deg || 0) / 2;
    const halfW = Number(cell.cell_width_deg || 0) / 2;
    return {
      north: lat + halfH,
      south: lat - halfH,
      east: lon + halfW,
      west: lon - halfW,
    };
  });
  const north = Math.max(...edges.map((edge) => edge.north));
  const south = Math.min(...edges.map((edge) => edge.south));
  const east = Math.max(...edges.map((edge) => edge.east));
  const west = Math.min(...edges.map((edge) => edge.west));
  return {
    type: 'FeatureCollection',
    features: [{
      type: 'Feature',
      properties: {},
      geometry: {
        type: 'Polygon',
        coordinates: [[[west, south], [east, south], [east, north], [west, north], [west, south]]],
      },
    }],
  };
}

function bindGridHandlersOnce() {
  if (gridHandlersBound) return;
  gridHandlersBound = true;
  map.on('click', 'grid-fill', onGridClick);
  if (!isCoarsePointerDevice()) {
    map.on('mouseenter', 'grid-fill', onGridEnter);
    map.on('mouseleave', 'grid-fill', onGridLeave);
  }
}


function scheduleDeferredGridApply(reason = 'deferred') {
  if (pendingGridRetryTimer) return false;
  pendingGridRetryTimer = setTimeout(() => {
    pendingGridRetryTimer = null;
    if (!pendingGridPayload || !map) return;
    const styleLoaded = !!(map && map.isStyleLoaded && map.isStyleLoaded());
    debugLog('scheduleDeferredGridApply:run', { reason, styleLoaded, hasPending: !!pendingGridPayload });
    if (!styleLoaded) {
      scheduleDeferredGridApply('style-not-ready');
      return;
    }
    if (!ensureGridScaffolding()) {
      scheduleDeferredGridApply('scaffolding-still-missing');
      return;
    }
    const gridSource = map.getSource('grid');
    const outlineSource = map.getSource('grid-outline');
    if (!gridSource || !outlineSource || !map.getLayer('grid-fill')) {
      scheduleDeferredGridApply('source-or-layer-missing');
      return;
    }
    const { data, cells } = pendingGridPayload;
    gridSource.setData(data || EMPTY_FEATURE_COLLECTION);
    outlineSource.setData(buildGridOutlineGeoJSON(cells || []));
    applyGridLinesVisibility();
    updateHighlight();
    removeLoaderLayers();
    debugLog('scheduleDeferredGridApply:applied', { featureCount: Array.isArray(data?.features) ? data.features.length : 0, cellCount: Array.isArray(cells) ? cells.length : 0 });
    pendingGridPayload = null;
  }, 120);
  return true;
}

function ensureGridScaffolding() {
  const styleLoaded = !!(map && map.isStyleLoaded && map.isStyleLoaded());
  const existingGridSource = !!(map && map.getSource && map.getSource('grid'));
  const existingOutlineSource = !!(map && map.getSource && map.getSource('grid-outline'));
  const existingFillLayer = !!(map && map.getLayer && map.getLayer('grid-fill'));
  debugLog('ensureGridScaffolding:start', { styleLoaded, existingGridSource, existingOutlineSource, existingFillLayer });
  if (!map) return false;
  const gridSource = map.getSource('grid') || ensureSource('grid');
  const outlineSource = map.getSource('grid-outline') || ensureSource('grid-outline');
  if (!gridSource || !outlineSource) return false;

  const tryAddLayer = (id, spec) => {
    if (map.getLayer(id)) return true;
    try {
      map.addLayer(spec);
    } catch (error) {
      console.warn(`ensureGridScaffolding:${id}:add-failed`, error);
      debugLog('ensureGridScaffolding:add-failed', { id, message: String(error?.message || error) });
    }
    return !!map.getLayer(id);
  };

  tryAddLayer('grid-fill', {
    id: 'grid-fill',
    type: 'fill',
    source: 'grid',
    paint: {
      'fill-color': ['get', 'fill_color'],
      'fill-opacity': ['get', 'fill_opacity'],
      'fill-antialias': false,
    },
  });
  tryAddLayer('grid-borders', {
    id: 'grid-borders',
    type: 'line',
    source: 'grid',
    paint: {
      'line-color': '#ffffff',
      'line-width': isCoarsePointerDevice() ? 0.75 : 1,
      'line-opacity': 0,
    },
  });
  tryAddLayer('grid-outline', {
    id: 'grid-outline',
    type: 'line',
    source: 'grid-outline',
    paint: {
      'line-color': '#ffffff',
      'line-width': isCoarsePointerDevice() ? 1.6 : 1.85,
      'line-opacity': 0,
    },
    layout: {
      'line-join': 'round',
      'line-cap': 'round',
    },
  });
  tryAddLayer('grid-highlight', {
    id: 'grid-highlight',
    type: 'line',
    source: 'grid',
    paint: {
      'line-color': '#ffffff',
      'line-width': 2.2,
      'line-opacity': 0,
    },
  });
  bindGridHandlersOnce();
  const ok = Boolean(map.getSource('grid') && map.getSource('grid-outline') && map.getLayer('grid-fill') && map.getLayer('grid-outline'));
  debugLog('ensureGridScaffolding:done', { ok, hasGridSource: !!map.getSource('grid'), hasOutlineSource: !!map.getSource('grid-outline'), hasFillLayer: !!map.getLayer('grid-fill'), hasOutlineLayer: !!map.getLayer('grid-outline') });
  return ok;
}

function ensureLoaderScaffolding() {
  const styleLoaded = !!(map && map.isStyleLoaded && map.isStyleLoaded());
  const existingLoaderSource = !!(map && map.getSource && map.getSource('grid-loader'));
  debugLog('ensureLoaderScaffolding:start', { styleLoaded, existingLoaderSource });
  if (!map) return false;
  const loaderSource = map.getSource('grid-loader') || ensureSource('grid-loader');
  if (!loaderSource) return false;
  const tryAddLayer = (id, spec) => {
    if (map.getLayer(id)) return true;
    try {
      map.addLayer(spec);
    } catch (error) {
      console.warn(`ensureLoaderScaffolding:${id}:add-failed`, error);
    }
    return !!map.getLayer(id);
  };
  tryAddLayer('grid-loader-fill', {
    id: 'grid-loader-fill',
    type: 'fill',
    source: 'grid-loader',
    paint: {
      'fill-color': '#7dd3fc',
      'fill-opacity': ['get', 'fill_opacity'],
    },
  });
  tryAddLayer('grid-loader-outline', {
    id: 'grid-loader-outline',
    type: 'line',
    source: 'grid-loader',
    paint: {
      'line-color': 'rgba(255,255,255,0.22)',
      'line-width': 1.1,
      'line-opacity': 0.4,
    },
    layout: {
      'line-join': 'round',
      'line-cap': 'round',
    },
  });
  const ok = Boolean(map.getSource('grid-loader') && map.getLayer('grid-loader-fill'));
  debugLog('ensureLoaderScaffolding:done', { ok, hasLoaderSource: !!map.getSource('grid-loader'), hasLoaderFill: !!map.getLayer('grid-loader-fill') });
  return ok;
}

function removeLoaderLayers() {
  clearGridRevealFailsafe();
  gridAnimationToken += 1;
  stopLoaderPulse();
  const loaderSource = map.getSource('grid-loader');
  if (loaderSource) loaderSource.setData(EMPTY_FEATURE_COLLECTION);
}

function showLoadingGrid(center) {
  debugLog('showLoadingGrid:start', center);
  if (!map || !map.isStyleLoaded()) return;
  if (!ensureLoaderScaffolding()) return;
  const cells = buildLoaderCells(center);
  const loaderSource = map.getSource('grid-loader');
  if (!loaderSource) return;
  const loaderGeoJSON = buildLoaderGeoJSON(cells, 0);
  debugLog('showLoadingGrid:data', { cellCount: Array.isArray(cells) ? cells.length : 0, featureCount: Array.isArray(loaderGeoJSON?.features) ? loaderGeoJSON.features.length : 0 });
  loaderSource.setData(loaderGeoJSON);
  startLoaderPulse();
}

function clearGridLayers() {
  if (!ensureGridScaffolding()) return;
  const gridSource = map.getSource('grid');
  const outlineSource = map.getSource('grid-outline');
  if (gridSource) gridSource.setData(EMPTY_FEATURE_COLLECTION);
  if (outlineSource) outlineSource.setData(EMPTY_FEATURE_COLLECTION);
  updateHighlight();
}

function removeLayers(keepLoader = false) {
  clearGridRevealFailsafe();
  gridAnimationToken += 1;
  clearGridLayers();
  if (!keepLoader) removeLoaderLayers();
  map.getCanvas().style.cursor = '';
}

function addLayers(data, cells = []) {
  debugLog('addLayers:start', { incomingFeatureCount: Array.isArray(data?.features) ? data.features.length : 0, cellCount: Array.isArray(cells) ? cells.length : 0 });
  const scaffoldingOk = ensureGridScaffolding();
  const gridSource = map.getSource('grid');
  const outlineSource = map.getSource('grid-outline');
  const hasFillLayer = !!map.getLayer('grid-fill');
  if (!scaffoldingOk || !gridSource || !outlineSource || !hasFillLayer) {
    pendingGridPayload = { data, cells };
    debugLog('addLayers:deferred', { scaffoldingOk, hasGridSource: !!gridSource, hasOutlineSource: !!outlineSource, hasFillLayer });
    scheduleDeferredGridApply('addLayers-false');
    return false;
  }
  debugLog('addLayers:setData-before', { hasGridSource: !!map.getSource('grid'), hasOutlineSource: !!map.getSource('grid-outline'), hasFillLayer: !!map.getLayer('grid-fill') });
  gridSource.setData(data || EMPTY_FEATURE_COLLECTION);
  outlineSource.setData(buildGridOutlineGeoJSON(cells));
  applyGridLinesVisibility();
  updateHighlight();
  animateGridFillFactor(0, 1, 220, () => {
    applyGridLinesVisibility();
    updateHighlight();
  });
  setTimeout(() => {
    try {
      if (!map.getLayer('grid-fill')) {
        debugLog('addLayers:post-render-no-layer');
        return;
      }
      const rendered = map.queryRenderedFeatures({ layers: ['grid-fill'] });
      debugLog('addLayers:post-render', { renderedFeatures: Array.isArray(rendered) ? rendered.length : 0 });
    } catch (error) {
      console.warn('addLayers:post-render:error', error);
    }
  }, 500);
  return true;
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
