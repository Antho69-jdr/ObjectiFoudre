const STYLE = '/assets/vendor/carto/dark-matter-style.json?v=1.1.46';
const LOCAL_NAME_EXPRESSION = ['coalesce', ['get', 'name:fr'], ['get', 'name'], ['get', 'name_en'], ['get', 'name_int']];

let deferredInstallPrompt = null;
let isFetchingData = false;
let lastFetchSignature = '';
let lastFetchAt = 0;
let gridAnimationToken = 0;
let gridFillPaintAnimationToken = 0;
let refreshMapRetryPending = false;
let loaderPulseFrame = null;
let loaderPulseStart = 0;
let gridRevealFailsafeTimer = null;
let appLoaderFailsafe = null;
let bestCellsMode = false;
let dataFetchController = null;
let centerChangeToken = 0;
let geocodeController = null;
let activeFetchToken = 0;
const LOADER_GRID_SIZE = 13;
const LOADER_CELL_SIZE_KM = 15.0;
const GRID_SIDE_KM = 195.0;
const GRID_ANIMATION_TOTAL_MS = 520;
const GRID_ANIMATION_CELL_MS = 340;
const GRID_ANIMATION_STAGGER_SPAN_MS = 170;
const VISIBILITY_REFRESH_MS = 10 * 60 * 1000;
const APP_LOADER_MIN_MS = 0;
const GRID_ANIMATION_MAX_CELLS = 140;
let userLocationMarker = null;
let shouldAnimateNextGrid = true;
let hasCompletedInitialLoad = false;
const DEFAULT_CENTER = { lat: 46.65, lon: 2.45, label: 'France entière' };

let currentCenter = loadStoredCenter();
const appLoaderStartedAt = performance.now();

let payload = null;
let selectedDayKey = null;
let selectedSlotKey = null;
let selectedFeature = null;
let selectedBaseDate = getTodayIsoDate();
let selectedColorMetric = 'trigger_score';
let meteoFranceGribCachedSlotKeys = new Set();
let aromeFranceDayMemoryCache = new Map();
let aromeFranceDayMetaMemory = new Map();
let aromeFranceCacheStatusMemory = new Map();
let meteoFranceGribAvailableSlotKeys = null;
let aromeFranceAvailabilityStatusMemory = new Map();
let meteoFranceGribCacheStatusSignature = '';
let meteoFranceGribCacheStatusFetchToken = 0;
let lastGridTemplate = null;
let timelinePlaybackTimer = null;
let timelinePlaybackRunning = false;
const TIMELINE_PLAYBACK_STEP_MS = 450;

syncDateControls();

if (typeof maplibregl === 'undefined') {
  throw new Error('MapLibre GL JS local introuvable.');
}

const map = new maplibregl.Map({
  container: 'map',
  style: STYLE,
  center: [currentCenter.lon, currentCenter.lat],
  zoom: 5.55,
  maxZoom: 12.5,
  preserveDrawingBuffer: true,
});
if (typeof applyResponsiveMode === 'function') applyResponsiveMode();
window.addEventListener('resize', () => { if (typeof applyResponsiveMode === 'function') applyResponsiveMode(); });
window.addEventListener('orientationchange', () => { if (typeof applyResponsiveMode === 'function') applyResponsiveMode(); });

debugLog('state:init', { currentCenter, selectedBaseDate, selectedColorMetric, style: STYLE });

function setMapPaintIfLayer(layerId, property, value) {
  if (!map || !map.getLayer(layerId)) return;
  try {
    map.setPaintProperty(layerId, property, value);
  } catch (_) {}
}

function setMapLayoutIfLayer(layerId, property, value) {
  if (!map || !map.getLayer(layerId)) return;
  try {
    map.setLayoutProperty(layerId, property, value);
  } catch (_) {}
}

function improveCartoVectorReadability() {
  [
    'waterway_label',
    'watername_ocean',
    'watername_sea',
    'watername_lake',
    'watername_lake_line',
    'place_hamlet',
    'place_suburbs',
    'place_villages',
    'place_town',
    'place_country_2',
    'place_country_1',
    'place_state',
    'place_city_r6',
    'place_city_r5',
    'place_city_dot_r7',
    'place_city_dot_r4',
    'place_city_dot_r2',
    'place_city_dot_z7',
    'place_capital_dot_z7',
    'roadname_minor',
    'roadname_sec',
    'roadname_pri',
    'roadname_major'
  ].forEach((id) => {
    setMapLayoutIfLayer(id, 'text-field', LOCAL_NAME_EXPRESSION);
  });

  setMapPaintIfLayer('background', 'background-color', '#08101c');
  setMapPaintIfLayer('landuse_residential', 'fill-color', 'rgba(17, 28, 42, 0.72)');
  setMapPaintIfLayer('boundary_county', 'line-color', 'rgba(116, 142, 170, 0.72)');
  setMapPaintIfLayer('boundary_county', 'line-width', ['interpolate', ['linear'], ['zoom'], 5, 0.45, 8, 0.8, 10, 1.15]);
  setMapPaintIfLayer('boundary_county', 'line-opacity', 0.78);
  // Régions : la couche CARTO `boundary_state` a des tracés imprécis. On la masque
  // (applyFranceRegionBoundaries) au profit du tracé officiel IGN (FRANCE_REGIONS_GEOJSON).

  // --- Routes volontairement discrètes : moins de réseau routier sur la carte. ---
  // Grands axes (autoroutes + voies rapides) : fins, sobres, n'apparaissent qu'en zoom moyen.
  [
    'tunnel_mot_fill',
    'tunnel_trunk_fill',
    'road_mot_fill_ramp',
    'road_mot_fill_noramp',
    'road_trunk_fill_ramp',
    'road_trunk_fill_noramp',
    'bridge_mot_fill',
    'bridge_trunk_fill'
  ].forEach((id) => {
    setMapPaintIfLayer(id, 'line-color', 'rgba(96, 122, 150, 0.7)');
    setMapPaintIfLayer(id, 'line-opacity', ['interpolate', ['linear'], ['zoom'], 6, 0, 7.5, 0.5, 11, 0.7]);
    setMapPaintIfLayer(id, 'line-width', ['interpolate', ['linear'], ['zoom'], 7, 0.35, 10, 0.9, 13, 1.7, 16, 3.4]);
  });

  [
    'tunnel_mot_case',
    'tunnel_trunk_case',
    'road_mot_case_ramp',
    'road_mot_case_noramp',
    'road_trunk_case_ramp',
    'road_trunk_case_noramp',
    'bridge_mot_case',
    'bridge_trunk_case'
  ].forEach((id) => {
    setMapPaintIfLayer(id, 'line-color', 'rgba(40, 58, 80, 0.6)');
    setMapPaintIfLayer(id, 'line-opacity', ['interpolate', ['linear'], ['zoom'], 6, 0, 8, 0.45]);
    setMapPaintIfLayer(id, 'line-width', ['interpolate', ['linear'], ['zoom'], 7, 0.5, 10, 1.1, 13, 2.2, 16, 4.4]);
  });

  // Routes primaires / secondaires : encore plus discrètes, seulement en zoom rapproché.
  [
    'tunnel_pri_fill',
    'tunnel_sec_fill',
    'road_pri_fill_ramp',
    'road_pri_fill_noramp',
    'road_sec_fill_noramp',
    'bridge_pri_fill',
    'bridge_sec_fill'
  ].forEach((id) => {
    setMapPaintIfLayer(id, 'line-color', 'rgba(86, 110, 138, 0.6)');
    setMapPaintIfLayer(id, 'line-opacity', ['interpolate', ['linear'], ['zoom'], 8.5, 0, 10, 0.4, 13, 0.55]);
    setMapPaintIfLayer(id, 'line-width', ['interpolate', ['linear'], ['zoom'], 9, 0.3, 12, 0.9, 15, 2.1, 18, 4.6]);
  });

  [
    'tunnel_pri_case',
    'tunnel_sec_case',
    'road_pri_case_ramp',
    'road_pri_case_noramp',
    'road_sec_case_noramp',
    'bridge_pri_case',
    'bridge_sec_case'
  ].forEach((id) => {
    setMapPaintIfLayer(id, 'line-opacity', ['interpolate', ['linear'], ['zoom'], 8.5, 0, 11, 0.35]);
  });

  // Petites routes, voies de service, chemins, rampes mineures : masqués (clutter).
  [
    'tunnel_minor_fill',
    'tunnel_service_fill',
    'tunnel_path',
    'road_minor_fill',
    'road_service_fill',
    'road_path',
    'bridge_minor_fill',
    'bridge_service_fill',
    'bridge_path',
    'tunnel_minor_case',
    'tunnel_service_case',
    'road_minor_case',
    'road_service_case',
    'bridge_minor_case',
    'bridge_service_case'
  ].forEach((id) => {
    setMapLayoutIfLayer(id, 'visibility', 'none');
  });

  // Noms de routes : on masque les petites, et on garde les grands axes discrets.
  ['roadname_minor', 'roadname_sec'].forEach((id) => {
    setMapLayoutIfLayer(id, 'visibility', 'none');
  });
  ['roadname_major', 'roadname_pri'].forEach((id) => {
    setMapPaintIfLayer(id, 'text-color', 'rgba(190, 208, 228, 0.82)');
    setMapPaintIfLayer(id, 'text-halo-color', 'rgba(3, 8, 15, 0.9)');
    setMapPaintIfLayer(id, 'text-halo-width', 1.1);
    setMapPaintIfLayer(id, 'text-opacity', ['interpolate', ['linear'], ['zoom'], 9, 0, 11, 0.8]);
  });

  setMapPaintIfLayer('place_state', 'text-color', 'rgba(214, 235, 248, 0.68)');
  setMapPaintIfLayer('place_state', 'text-halo-color', 'rgba(2, 7, 13, 0.52)');
  setMapPaintIfLayer('place_state', 'text-halo-width', 0.85);
  setMapPaintIfLayer('place_state', 'text-opacity', 0.58);

  [
    'place_city_r6',
    'place_city_r5',
    'place_city_dot_r7',
    'place_city_dot_r4',
    'place_city_dot_r2',
    'place_city_dot_z7',
    'place_capital_dot_z7',
    'place_town',
    'place_villages',
    'place_suburbs',
    'place_hamlet'
  ].forEach((id) => {
    setMapPaintIfLayer(id, 'text-color', 'rgba(244, 249, 255, 0.98)');
    setMapPaintIfLayer(id, 'text-halo-color', 'rgba(2, 7, 13, 0.98)');
    setMapPaintIfLayer(id, 'text-halo-width', 1.55);
    setMapPaintIfLayer(id, 'text-opacity', 1);
    setMapPaintIfLayer(id, 'icon-opacity', 0.92);
  });

  setMapPaintIfLayer('water', 'fill-color', 'rgba(38, 56, 72, 1)');
  // Cours d'eau : discrets, seulement en zoom rapproché (moins de rivières sur la carte).
  setMapPaintIfLayer('waterway', 'line-color', 'rgba(70, 100, 124, 0.55)');
  setMapPaintIfLayer('waterway', 'line-opacity', ['interpolate', ['linear'], ['zoom'], 8, 0, 10, 0.4, 13, 0.6]);
  setMapPaintIfLayer('waterway', 'line-width', ['interpolate', ['linear'], ['zoom'], 8, 0.2, 11, 0.6, 14, 1.2, 17, 2.4]);
  setMapLayoutIfLayer('waterway_label', 'visibility', 'none');
}

// Départements officiels IGN (FRANCE_DEPARTMENT_RINGS) : traits fins pointillés,
// subordonnés aux régions, qui apparaissent dès le zoom moyen (~z6.5) au lieu de z9.
// Remplace la couche CARTO `boundary_county` (tracés imprécis).
function applyFranceDepartmentBoundaries() {
  if (!map || typeof FRANCE_DEPARTMENT_RINGS === 'undefined' || !Array.isArray(FRANCE_DEPARTMENT_RINGS)) return;
  try {
    if (!map.getSource('france-departments')) {
      map.addSource('france-departments', {
        type: 'geojson',
        data: {
          type: 'Feature',
          properties: {},
          geometry: { type: 'MultiLineString', coordinates: FRANCE_DEPARTMENT_RINGS },
        },
      });
    }
    if (!map.getLayer('france-department-lines')) {
      const beforeId = map.getLayer('waterway_label') ? 'waterway_label' : undefined;
      map.addLayer({
        id: 'france-department-lines',
        type: 'line',
        source: 'france-departments',
        layout: { 'line-join': 'round', 'line-cap': 'round' },
        paint: {
          'line-color': 'rgba(120, 145, 175, 0.5)',
          'line-dasharray': [2, 2],
          'line-width': ['interpolate', ['linear'], ['zoom'], 6, 0.3, 8, 0.6, 11, 1.0, 14, 1.6],
          'line-opacity': ['interpolate', ['linear'], ['zoom'], 6, 0, 6.8, 0.45, 9, 0.6],
        },
      }, beforeId);
    }
  } catch (_) {}
  // Couche départements CARTO imprécise -> masquée au profit du tracé IGN.
  setMapLayoutIfLayer('boundary_county', 'visibility', 'none');
}

// Découpage régional officiel IGN : couche vectorielle propre qui remplace la couche
// CARTO `boundary_state` (tracés imprécis). Insérée sous les labels, au-dessus des routes.
function applyFranceRegionBoundaries() {
  if (!map || typeof FRANCE_REGIONS_GEOJSON === 'undefined') return;
  try {
    if (!map.getSource('france-regions')) {
      map.addSource('france-regions', { type: 'geojson', data: FRANCE_REGIONS_GEOJSON });
    }
    if (!map.getLayer('france-region-lines')) {
      const beforeId = map.getLayer('waterway_label') ? 'waterway_label' : undefined;
      map.addLayer({
        id: 'france-region-lines',
        type: 'line',
        source: 'france-regions',
        layout: { 'line-join': 'round', 'line-cap': 'round' },
        paint: {
          'line-color': 'rgba(150, 176, 208, 0.62)',
          'line-width': ['interpolate', ['linear'], ['zoom'], 4, 0.6, 6, 1.0, 8, 1.5, 11, 2.4],
          'line-opacity': ['interpolate', ['linear'], ['zoom'], 4, 0.7, 8, 0.85],
        },
      }, beforeId);
    }
  } catch (_) {}
  // Couche régions CARTO imprécise -> masquée au profit du tracé IGN.
  setMapLayoutIfLayer('boundary_state', 'visibility', 'none');
}

function improveBasemapReadability() {
  improveCartoVectorReadability();
  // Départements d'abord (couche du dessous), puis régions par-dessus : hiérarchie visuelle.
  applyFranceDepartmentBoundaries();
  applyFranceRegionBoundaries();
}
