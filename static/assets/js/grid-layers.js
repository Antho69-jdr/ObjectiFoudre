const EMPTY_FEATURE_COLLECTION = { type: 'FeatureCollection', features: [] };
let gridHandlersBound = false;
let pendingGridPayload = null;
let pendingGridRetryTimer = null;
let currentGridGeometrySignature = '';
let currentGridFeatureState = new Map();
let currentGridStateApplyToken = 0;

function ensureSource(id, data = EMPTY_FEATURE_COLLECTION, extra = null) {
  if (!map) return null;
  const existing = map.getSource(id);
  if (existing) return existing;
  try {
    map.addSource(id, { type: 'geojson', data, ...(extra || {}) });
  } catch (error) {
    console.warn(`ensureSource:${id}:add-failed`, error);
  }
  return map.getSource(id) || null;
}


function gridGeometrySignature(cells) {
  if (!Array.isArray(cells) || !cells.length) return '';
  return cells.map((cell) => [
    cell?.zone || '',
    Number(cell?.lat || 0).toFixed(5),
    Number(cell?.lon || 0).toFixed(5),
    Number(cell?.cell_height_deg || 0).toFixed(5),
    Number(cell?.cell_width_deg || 0).toFixed(5),
  ].join(':')).join('|');
}

function resetGridStableState() {
  currentGridGeometrySignature = '';
  currentGridFeatureState = new Map();
  currentGridStateApplyToken += 1;
}

function gridFeatureStateSignature(properties = {}) {
  const fillMetric = Number(properties.fill_metric ?? getCellMetricValue(properties)).toFixed(4);
  const fillOpacity = Number(properties.fill_opacity || 0).toFixed(5);
  const fillColor = String(properties.fill_color || '');
  const isBest = Number(properties.is_best || 0) ? 1 : 0;
  return `${fillMetric}|${fillOpacity}|${fillColor}|${isBest}`;
}

function applyGridFeatureStates(data, token = currentGridStateApplyToken) {
  if (token !== currentGridStateApplyToken) return 0;
  if (!map || !map.getSource('grid') || !Array.isArray(data?.features)) return 0;
  let applied = 0;
  for (const feature of data.features) {
    if (token !== currentGridStateApplyToken) return applied;
    const id = feature?.id ?? feature?.properties?.zone;
    if (id === undefined || id === null || String(id) === '') continue;
    const properties = feature.properties || {};
    const signature = gridFeatureStateSignature(properties);
    const key = String(id);
    if (currentGridFeatureState.get(key) === signature) continue;
    try {
      map.setFeatureState({ source: 'grid', id }, {
        fill_metric: Number(properties.fill_metric ?? getCellMetricValue(properties)),
        fill_color: String(properties.fill_color || ''),
        fill_opacity: Number(properties.fill_opacity || 0),
        is_best: Number(properties.is_best || 0) ? 1 : 0,
      });
      currentGridFeatureState.set(key, signature);
      applied += 1;
    } catch (error) {
      debugLog('applyGridFeatureStates:error', { id: key, message: String(error?.message || error) });
    }
  }
  try { map.triggerRepaint(); } catch (_) {}
  return applied;
}

function noteGridGeometryApplied(cells, data = null) {
  currentGridGeometrySignature = gridGeometrySignature(cells);
  currentGridFeatureState = new Map();
  currentGridStateApplyToken += 1;
}

function currentCellForRenderedFeature(properties = null) {
  if (!properties) return null;
  const zone = properties?.zone;
  if (!zone) return properties;
  const cells = getCurrentSlot()?.cells || [];
  return cells.find((cell) => String(cell?.zone) === String(zone)) || properties;
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
    map.on('mousemove', 'grid-fill', onGridMove);
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
    const safeData = data || EMPTY_FEATURE_COLLECTION;
    gridSource.setData(safeData);
    try { map.removeFeatureState({ source: 'grid' }); } catch (_) {}
    outlineSource.setData(buildGridOutlineGeoJSON(cells || []));
    currentGridGeometrySignature = gridGeometrySignature(cells || []);
    currentGridFeatureState = new Map();
    currentGridStateApplyToken += 1;
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
  // promoteId: les feature-states (couleur/opacité par heure) sont adressés par zone.
  const gridSource = map.getSource('grid') || ensureSource('grid', EMPTY_FEATURE_COLLECTION, { promoteId: 'zone' });
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
      'fill-color': gridFillColorExpression(),
      'fill-opacity': gridFillOpacityExpression(1),
      'fill-antialias': false,
    },
  });
  tryAddLayer('grid-outline', {
    id: 'grid-outline',
    type: 'line',
    source: 'grid-outline',
    paint: {
      'line-color': '#ffffff',
      'line-width': 0,
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
  // « Meilleures cellules » (item Trello) : même rendu que la carte du mode étoile —
  // liseré ambre PULSATILE (halo large flou + trait net) qui souligne les cellules les
  // mieux notées du créneau, PLUS l'intérieur rempli (item #5). Overlay AU-DESSUS de la
  // grille (populé/animé par grid.js, vide + masqué par défaut). Piloté par bestCellsMode.
  if (!map.getSource('grid-best')) ensureSource('grid-best', EMPTY_FEATURE_COLLECTION);
  tryAddLayer('grid-best-fill', {
    id: 'grid-best-fill',
    type: 'fill',
    source: 'grid-best',
    layout: { visibility: 'none' },
    paint: { 'fill-color': '#f5b942', 'fill-opacity': 0.18, 'fill-antialias': false },
  });
  tryAddLayer('grid-best-glow', {
    id: 'grid-best-glow',
    type: 'line',
    source: 'grid-best',
    layout: { 'line-join': 'round', 'line-cap': 'round', visibility: 'none' },
    paint: { 'line-color': '#f5b942', 'line-width': 9, 'line-blur': 6, 'line-opacity': 0.5 },
  });
  tryAddLayer('grid-best-line', {
    id: 'grid-best-line',
    type: 'line',
    source: 'grid-best',
    layout: { 'line-join': 'round', 'line-cap': 'round', visibility: 'none' },
    paint: { 'line-color': '#ffe9b0', 'line-width': 2.4, 'line-opacity': 0.95 },
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
  gridFillPaintAnimationToken += 1;
  const gridSource = map.getSource('grid');
  const outlineSource = map.getSource('grid-outline');
  if (gridSource) gridSource.setData(EMPTY_FEATURE_COLLECTION);
  if (outlineSource) outlineSource.setData(EMPTY_FEATURE_COLLECTION);
  const bestSource = map.getSource('grid-best');
  if (bestSource) bestSource.setData(EMPTY_FEATURE_COLLECTION);
  resetGridStableState();
  setGridFillFactor(1);
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
  const safeData = data || EMPTY_FEATURE_COLLECTION;
  const nextGeometrySignature = gridGeometrySignature(cells);
  const sameGeometry = Boolean(nextGeometrySignature && nextGeometrySignature === currentGridGeometrySignature);

  if (sameGeometry) {
    // Géométrie inchangée (bascule d'heure, autre date, mode best-cells…) : on ne
    // re-tessellise pas — seuls couleur/opacité changent, poussés en feature-state.
    currentGridStateApplyToken += 1;
    applyGridFeatureStates(safeData);
    applyGridLinesVisibility();
    updateHighlight();
    gridAnimationToken += 1;
    gridFillPaintAnimationToken += 1;
    shouldAnimateNextGrid = false;
    setGridFillFactor(1);
    removeLoaderLayers();
    debugLog('addLayers:feature-state-same-geometry', { featureCount: Array.isArray(safeData?.features) ? safeData.features.length : 0 });
    return true;
  }

  gridSource.setData(safeData);
  try { map.removeFeatureState({ source: 'grid' }); } catch (_) {}
  outlineSource.setData(buildGridOutlineGeoJSON(cells));
  currentGridGeometrySignature = nextGeometrySignature;
  currentGridFeatureState = new Map();
  currentGridStateApplyToken += 1;
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

// Bulle de rappel au survol (Desktop uniquement — handlers non liés sur pointeur grossier) :
// CAPE / Température / Point de rosée de la cellule survolée.
let gridCellTooltipEl = null;
function ensureGridCellTooltip() {
  if (gridCellTooltipEl && gridCellTooltipEl.isConnected) return gridCellTooltipEl;
  const el = document.createElement('div');
  el.className = 'grid-cell-tooltip';
  el.setAttribute('aria-hidden', 'true');
  (map.getContainer() || document.body).appendChild(el);
  gridCellTooltipEl = el;
  return el;
}
function fmtGridTip(value, suffix) {
  const n = Number(value);
  const inner = Number.isFinite(n)
    ? Math.round(n) + '<span class="gct-unit">' + suffix + '</span>'
    : '—';
  return '<span class="gct-val">' + inner + '</span>';
}
function onGridEnter() {
  map.getCanvas().style.cursor = 'pointer';
}
function onGridMove(e) {
  const feature = e.features && e.features[0];
  const p = feature ? currentCellForRenderedFeature(feature.properties) : null;
  if (!p || (shouldUseFranceGridClip() && e?.lngLat && !pointInFranceGridMask(Number(e.lngLat.lng), Number(e.lngLat.lat)))) {
    onGridLeave();
    return;
  }
  const el = ensureGridCellTooltip();
  const score = Number(p.trigger_score);
  const scoreColor = (typeof colorFromScore === 'function' && Number.isFinite(score)) ? colorFromScore(score) : '#7dd3fc';
  if (Number.isFinite(score)) { el.style.setProperty('--gct-score', scoreColor); }
  else { el.style.removeProperty('--gct-score'); }
  const head = Number.isFinite(score)
    ? '<span class="gct-head"><b>Probabilité</b><strong style="color:' + scoreColor + '">' + Math.round(score) + '</strong></span>'
    : '';
  el.innerHTML = head +
    '<span class="gct-row"><b>MLCAPE</b>' + fmtGridTip(p.mucape, ' J/kg') + '</span>' +
    '<span class="gct-row"><b>CIN</b>' + fmtGridTip(p.convective_inhibition, ' J/kg') + '</span>' +
    '<span class="gct-row"><b>Cisaill. 0-6km</b>' + fmtGridTip(p.shear_ms, ' m/s') + '</span>' +
    '<span class="gct-row"><b>Temp.</b>' + fmtGridTip(p.temp_c, ' °C') + '</span>' +
    '<span class="gct-row"><b>Pt rosée</b>' + fmtGridTip(p.dewpoint_c, ' °C') + '</span>';
  const pt = e.point || { x: 0, y: 0 };
  const cont = map.getContainer();
  const cw = cont ? cont.clientWidth : 0;
  const ch = cont ? cont.clientHeight : 0;
  const tw = el.offsetWidth || 130;
  const th = el.offsetHeight || 60;
  // bascule à gauche/au-dessus du curseur si on déborde du bord
  const left = (pt.x + 16 + tw > cw) ? pt.x - 16 - tw : pt.x + 16;
  const top = (pt.y + 16 + th > ch) ? pt.y - 16 - th : pt.y + 16;
  el.style.left = Math.max(4, left) + 'px';
  el.style.top = Math.max(4, top) + 'px';
  el.classList.add('is-visible');
}
function onGridLeave() {
  map.getCanvas().style.cursor = '';
  if (gridCellTooltipEl) gridCellTooltipEl.classList.remove('is-visible');
}

function onGridClick(e) {
  if (shouldUseFranceGridClip() && e?.lngLat && !pointInFranceGridMask(Number(e.lngLat.lng), Number(e.lngLat.lat))) return;
  const p = currentCellForRenderedFeature(e.features?.[0]?.properties);
  if (!p) return;
  selectedFeature = p;
  showSelection(p);
  updateHighlight();
}

function updateHighlight() {
  if (!map.getLayer('grid-highlight')) return;
  map.setPaintProperty('grid-highlight', 'line-opacity', ['case', ['==', ['get', 'zone'], selectedFeature?.zone || ''], 1, 0]);
}
