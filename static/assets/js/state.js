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
  setMapPaintIfLayer('boundary_state', 'line-color', 'rgba(165, 191, 220, 0.82)');
  setMapPaintIfLayer('boundary_state', 'line-width', ['interpolate', ['linear'], ['zoom'], 4, 0.75, 8, 1.25, 10, 1.7]);
  setMapPaintIfLayer('boundary_state', 'line-opacity', 0.88);

  [
    'tunnel_mot_fill',
    'tunnel_trunk_fill',
    'tunnel_pri_fill',
    'road_mot_fill_ramp',
    'road_mot_fill_noramp',
    'road_trunk_fill_ramp',
    'road_trunk_fill_noramp',
    'bridge_mot_fill',
    'bridge_trunk_fill',
    'bridge_pri_fill'
  ].forEach((id) => {
    setMapPaintIfLayer(id, 'line-color', 'rgba(178, 205, 232, 1)');
    setMapPaintIfLayer(id, 'line-opacity', 1);
    setMapPaintIfLayer(id, 'line-width', ['interpolate', ['linear'], ['zoom'], 5, 0.95, 7, 1.35, 9, 2.05, 12, 3.6, 15, 7.2, 18, 18]);
  });

  [
    'tunnel_mot_case',
    'tunnel_trunk_case',
    'tunnel_pri_case',
    'road_mot_case_ramp',
    'road_mot_case_noramp',
    'road_trunk_case_ramp',
    'road_trunk_case_noramp',
    'road_pri_case_ramp',
    'road_pri_case_noramp',
    'bridge_mot_case',
    'bridge_trunk_case',
    'bridge_pri_case'
  ].forEach((id) => {
    setMapPaintIfLayer(id, 'line-color', 'rgba(94, 127, 160, 0.98)');
    setMapPaintIfLayer(id, 'line-opacity', 1);
    setMapPaintIfLayer(id, 'line-width', ['interpolate', ['linear'], ['zoom'], 5, 0.8, 7, 1.15, 9, 1.7, 12, 4.4, 15, 8.6, 18, 20]);
  });

  [
    'tunnel_sec_fill',
    'road_pri_fill_ramp',
    'road_pri_fill_noramp',
    'road_sec_fill_noramp',
    'bridge_sec_fill'
  ].forEach((id) => {
    setMapPaintIfLayer(id, 'line-color', 'rgba(143, 174, 204, 0.98)');
    setMapPaintIfLayer(id, 'line-opacity', 1);
    setMapPaintIfLayer(id, 'line-width', ['interpolate', ['linear'], ['zoom'], 8, 0.75, 10, 1.25, 12, 2.05, 15, 5.6, 18, 14]);
  });

  [
    'tunnel_sec_case',
    'road_sec_case_noramp',
    'bridge_sec_case'
  ].forEach((id) => {
    setMapPaintIfLayer(id, 'line-color', 'rgba(74, 105, 137, 0.96)');
    setMapPaintIfLayer(id, 'line-opacity', 1);
  });

  [
    'tunnel_minor_fill',
    'tunnel_service_fill',
    'road_minor_fill',
    'road_service_fill',
    'bridge_minor_fill',
    'bridge_service_fill'
  ].forEach((id) => {
    setMapPaintIfLayer(id, 'line-color', 'rgba(103, 131, 159, 0.92)');
    setMapPaintIfLayer(id, 'line-opacity', 0.96);
  });

  [
    'tunnel_minor_case',
    'tunnel_service_case',
    'road_minor_case',
    'road_service_case',
    'bridge_minor_case',
    'bridge_service_case'
  ].forEach((id) => {
    setMapPaintIfLayer(id, 'line-color', 'rgba(47, 70, 96, 0.9)');
    setMapPaintIfLayer(id, 'line-opacity', 1);
  });

  [
    'roadname_major',
    'roadname_pri',
    'roadname_sec',
    'roadname_minor'
  ].forEach((id) => {
    setMapPaintIfLayer(id, 'text-color', 'rgba(226, 238, 252, 0.96)');
    setMapPaintIfLayer(id, 'text-halo-color', 'rgba(3, 8, 15, 0.96)');
    setMapPaintIfLayer(id, 'text-halo-width', 1.35);
    setMapPaintIfLayer(id, 'text-opacity', 1);
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

  setMapPaintIfLayer('water', 'fill-color', 'rgba(45, 67, 83, 1)');
  setMapPaintIfLayer('waterway', 'line-color', 'rgba(82, 120, 145, 0.92)');
}

function improveBasemapReadability() {
  improveCartoVectorReadability();
}
