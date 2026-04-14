const STYLE = 'https://basemaps.cartocdn.com/gl/dark-matter-gl-style/style.json';

let deferredInstallPrompt = null;
let isFetchingData = false;
let lastFetchSignature = '';
let lastFetchAt = 0;
let gridAnimationToken = 0;
let loaderPulseFrame = null;
let loaderPulseStart = 0;
let gridRevealFailsafeTimer = null;
let appLoaderFailsafe = null;
let bestCellsMode = false;
let showGridLines = true;
let dataFetchController = null;
let centerChangeToken = 0;
let geocodeController = null;
let activeFetchToken = 0;
const LOADER_GRID_SIZE = 9;
const LOADER_CELL_SIZE_KM = 5.0;
const GRID_ANIMATION_TOTAL_MS = 520;
const GRID_ANIMATION_CELL_MS = 340;
const GRID_ANIMATION_STAGGER_SPAN_MS = 170;
const VISIBILITY_REFRESH_MS = 10 * 60 * 1000;
const APP_LOADER_MIN_MS = 0;
const GRID_ANIMATION_MAX_CELLS = 140;
let userLocationMarker = null;
let shouldAnimateNextGrid = true;
let hasCompletedInitialLoad = false;
const DEFAULT_CENTER = { lat: 45.7640, lon: 4.8357, label: 'Lyon' };
let currentCenter = loadStoredCenter();
const appLoaderStartedAt = performance.now();

let payload = null;
let selectedDayKey = null;
let selectedSlotKey = null;
let selectedFeature = null;
let selectedBaseDate = getTodayIsoDate();
let selectedColorMetric = 'score_global';
let lastGridTemplate = null;
let activeGridMaskCells = [];

syncDateControls();

const map = new maplibregl.Map({
  container: 'map',
  style: STYLE,
  center: [currentCenter.lon, currentCenter.lat],
  zoom: 9.4,
  maxZoom: 12.5,
});
applyResponsiveMode();
window.addEventListener('resize', applyResponsiveMode);
window.addEventListener('orientationchange', applyResponsiveMode);
