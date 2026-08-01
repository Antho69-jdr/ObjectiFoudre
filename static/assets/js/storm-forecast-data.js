// storm-forecast-data.js — issu du découpage de storm-forecast-image.js (Phase 3).
// Constantes + helpers date/jour/fetch/score de la page Prévision. Script classique, chargé 1er.
const PREDICTION_IMAGE_RENDER_VERSION = 'iso-contour-atlas-v60-severity-amber-thicker';

const PREDICTION_IMAGE_CACHE = new Map();
const PREDICTION_IMAGE_PREWARMING = new Set();
const PREDICTION_DAY_START_HOUR = 8;
const PREDICTION_DAY_WINDOW_HOURS = Array.from({ length: 24 }, (_, index) => (PREDICTION_DAY_START_HOUR + index) % 24);

const PREDICTION_PERIODS = Object.freeze([
  { key: 'day', label: 'Journée', rangeLabel: '08-08h', hours: PREDICTION_DAY_WINDOW_HOURS },
  { key: 'morning', label: 'Matinée', rangeLabel: '08-13h', hours: [8, 9, 10, 11, 12, 13] },
  { key: 'afternoon', label: 'Après-midi', rangeLabel: '14-19h', hours: [14, 15, 16, 17, 18, 19] },
  { key: 'evening', label: 'Soirée / nuit', rangeLabel: '20-08h', hours: [20, 21, 22, 23, 0, 1, 2, 3, 4, 5, 6, 7] },
]);
let selectedPredictionPeriodKey = 'day';
let currentPredictionPageResult = null;

// --- Page Prévision/Tendance unifiée : sélecteur de date propre (J0 → J+10) ---
// La page ne dépend plus de la date de la grille de base. Elle a son propre store de
// jours hydratés (AROME/ARPEGE horaire J0→J+3 via day-cache ; ECMWF tendance J+4→J+10
// via trend-day). Le rendu reste les « zones lissées », y compris pour ECMWF.
const PREDICTION_ECMWF_MIN_OFFSET = 2;   // J+2 et au-delà = ECMWF (J+2/J+3 multi-créneaux 3-h ;
                                         // J+4+ tendance quotidienne). Remplace ARPEGE.
const PREDICTION_TREND_MIN_OFFSET = 4;   // J+4 et au-delà = tendance ECMWF 1-point/jour
const PREDICTION_MAX_OFFSET = 10;        // J+10
const PREDICTION_TREND_PROVIDER = 'ecmwf_ifs_trend';
const PREDICTION_ECMWF_SLOTS_PROVIDER = 'ecmwf_ifs';   // J+2/J+3 multi-créneaux (≠ tendance)
const PREDICTION_DAY_STORE = new Map();  // dateIso -> objet jour (hydraté pour cette page)
const PREDICTION_DAY_PENDING = new Map(); // dateIso -> Promise (déduplication fetch)
let predictionSelectedDate = null;       // dateIso affichée (indépendante de la grille)
let predictionPrewarmStarted = false;

function predictionTodayIso() {
  return (typeof getTodayIsoDate === 'function') ? getTodayIsoDate() : normalizeDateIso(new Date().toISOString().slice(0, 10));
}

function predictionDateOffset(dateIso) {
  const today = new Date(predictionTodayIso() + 'T12:00:00');
  const target = new Date(normalizeDateIso(dateIso) + 'T12:00:00');
  return Math.round((target - today) / 86400000);
}

function predictionDateIsTrend(dateIso) {
  return predictionDateOffset(dateIso) >= PREDICTION_TREND_MIN_OFFSET;
}

// J+2+ : servi par ECMWF (endpoint trend-day). J+2/J+3 = multi-créneaux (jours normaux),
// J+4+ = tendance 1-point. NB : « uses ECMWF » (fetch) ≠ « is trend » (UI 1-point).
function predictionDateUsesEcmwf(dateIso) {
  return predictionDateOffset(dateIso) >= PREDICTION_ECMWF_MIN_OFFSET;
}

function predictionSelectableDates() {
  const today = predictionTodayIso();
  const dates = [];
  for (let offset = 0; offset <= PREDICTION_MAX_OFFSET; offset += 1) {
    dates.push(predictionDateAddDays(today, offset));
  }
  return dates;
}

function predictionDateChipLabel(dateIso) {
  const offset = predictionDateOffset(dateIso);
  if (offset === 0) return "Auj.";
  return 'J+' + offset;
}

function predictionDayIsTrend(day) {
  if (!day) return false;
  if (day.__trend) return true;
  const slot = Array.isArray(day.slots) ? day.slots[0] : null;
  return Array.isArray(slot?.cells) && slot.cells.some((cell) => cell?.source_provider === PREDICTION_TREND_PROVIDER);
}

function predictionActiveDay() {
  if (!predictionSelectedDate) return null;
  return PREDICTION_DAY_STORE.get(predictionSelectedDate) || null;
}

// Cellules quotidiennes pour un jour de tendance ECMWF (un seul créneau / jour) :
// même forme que collectPredictionDailyCells, mais sans logique de période.
function predictionTrendDailyCells(day) {
  const slot = Array.isArray(day?.slots) ? day.slots[0] : null;
  const cells = Array.isArray(slot?.cells) ? slot.cells : [];
  const out = [];
  for (const cell of cells) {
    if (cell?.source_provider !== PREDICTION_TREND_PROVIDER) continue;
    const lat = Number(cell.lat);
    const lon = Number(cell.lon);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
    const score = clampScore(predictionCellScore(cell));
    const cape = Number(cell.mucape);
    const temperature = Number(cell.temp_c);
    const dewpoint = Number(cell.dewpoint_c);
    const gusts = Number(cell.wind_gusts_10m);
    out.push({
      id: predictionCellId(cell),
      zone: cell.zone || predictionCellId(cell),
      lat,
      lon,
      cellHeightDeg: Number(cell.cell_height_deg) || 0.18,
      cellWidthDeg: Number(cell.cell_width_deg) || 0.18,
      scores: [score],
      score,
      peak: score,
      topMean: score,
      mean: score,
      confidenceMean: Number.isFinite(Number(cell.confidence_score)) ? clampScore(Number(cell.confidence_score)) : 0,
      activeCount: score >= 60 ? 1 : 0,
      bestHours: [],
      meanCape: Number.isFinite(cape) ? cape : 0,
      meanTemperature: Number.isFinite(temperature) ? temperature : 0,
      meanDewpoint: Number.isFinite(dewpoint) ? dewpoint : 0,
      maxGusts: Number.isFinite(gusts) ? gusts : 0,
    });
  }
  return out;
}

async function predictionFetchHourlyDay(dateIso) {
  const iso = normalizeDateIso(dateIso);
  const baseBody = {
    lat: currentCenter?.lat ?? 46.65,
    lon: currentCenter?.lon ?? 2.45,
    label: currentCenter?.label || 'France entière',
    date: iso,
    detail_level: 'render',
    cache_only: true,
  };
  const body = typeof withMeteoFranceToken === 'function' ? withMeteoFranceToken(baseBody, '') : baseBody;
  try {
    const response = await fetch('/api/meteofrance/grib-france-day-cache', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const data = await response.json().catch(() => ({}));
    if (typeof syncMeteoFranceQuotaCooldown === 'function') syncMeteoFranceQuotaCooldown(data);
    const day = data?.payload?.days?.[0];
    if (!data?.ok || !day) return null;
    day.meta = data.payload.meta || {};
    PREDICTION_DAY_STORE.set(iso, day);
    return day;
  } catch (_) {
    return null;
  }
}

async function predictionFetchTrendDay(dateIso) {
  const iso = normalizeDateIso(dateIso);
  try {
    const response = await fetch('/api/ecmwf/trend-day', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ date: iso }),
    });
    const data = await response.json().catch(() => ({}));
    const day = data?.payload?.days?.[0];
    if (!data?.ok || !day) return null;
    day.__trend = predictionDateIsTrend(iso);   // 1-point trend UNIQUEMENT J+4+ ; J+2/J+3 = jours multi-créneaux
    day.meta = data.payload.meta || {};
    day.trend_step_hours = data.step_hours;
    PREDICTION_DAY_STORE.set(iso, day);
    return day;
  } catch (_) {
    return null;
  }
}

// Hydrate (et met en cache) le jour demandé. Pour un jour horaire, hydrate aussi le
// lendemain (la fenêtre 08h-08h tire ses heures 0-7h du jour suivant).
async function predictionEnsureDay(dateIso) {
  const iso = normalizeDateIso(dateIso);
  if (PREDICTION_DAY_STORE.has(iso)) return PREDICTION_DAY_STORE.get(iso);
  if (PREDICTION_DAY_PENDING.has(iso)) return PREDICTION_DAY_PENDING.get(iso);
  const task = (async () => {
    if (predictionDateUsesEcmwf(iso)) return predictionFetchTrendDay(iso);   // J+2/J+3 multi-créneaux ou J+4+ tendance
    const day = await predictionFetchHourlyDay(iso);
    const nextIso = predictionDateAddDays(iso, 1);
    if (!predictionDateUsesEcmwf(nextIso) && predictionDateOffset(nextIso) <= PREDICTION_MAX_OFFSET
      && !PREDICTION_DAY_STORE.has(nextIso) && !PREDICTION_DAY_PENDING.has(nextIso)) {
      await predictionFetchHourlyDay(nextIso);
    }
    return day;
  })();
  PREDICTION_DAY_PENDING.set(iso, task);
  try {
    return await task;
  } finally {
    PREDICTION_DAY_PENDING.delete(iso);
  }
}

// Rampe « radar / chaleur » sur fond ink : la France sombre s'allume par foyers,
// du calme (ink ≈ fond) au cyan/vert/ambre/rouge/magasin. Cohérent avec le radar
// de chargement. NB : la légende du tiroir (forecast-scales.css .legend-gradient)
// reprend ces mêmes teintes — les garder synchronisées.
const PREDICTION_RISK_LEVELS = Object.freeze([
  { key: 'below-threshold', label: 'Sous seuil', range: '0-59', min: 0, color: '#091321', stroke: '#16283c', text: 'signal inférieur au seuil cartographié' },
  { key: 'low', label: 'Faible', range: '60-70', min: 60, color: '#2e83a6', stroke: '#0b485c', text: 'signal faible, à surveiller localement' },
  { key: 'medium', label: 'Moyen', range: '71-80', min: 71, color: '#34d399', stroke: '#0f766e', text: 'signal moyen, environnement à suivre' },
  { key: 'elevated', label: 'Élevé', range: '81-89', min: 81, color: '#fbbf24', stroke: '#92580e', text: 'signal élevé à surveiller sérieusement' },
  { key: 'very-high', label: 'Très élevé', range: '90-95', min: 90, color: '#f43f5e', stroke: '#9f1239', text: 'signal très élevé, à contrôler finement' },
  { key: 'certain', label: 'Extrême', range: '96-100', min: 96, color: '#d946ef', stroke: '#86198f', text: 'signal maximal ou quasi maximal' },
]);

function predictionPeriodConfig(periodKey = selectedPredictionPeriodKey) {
  return PREDICTION_PERIODS.find((period) => period.key === periodKey) || PREDICTION_PERIODS[0];
}

function predictionSlotHour(slotKey) {
  const match = String(slotKey || '').match(/(\d{1,2})/);
  if (!match) return NaN;
  const hour = Number(match[1]);
  return Number.isFinite(hour) ? hour : NaN;
}

function predictionSlotKeyForHour(hour) {
  return 'h' + String(hour).padStart(2, '0');
}

function predictionHourWindowOffset(hour) {
  const cleanHour = Number(hour);
  if (!Number.isFinite(cleanHour)) return 999;
  return (cleanHour - PREDICTION_DAY_START_HOUR + 24) % 24;
}

function predictionSortWindowHours(hours) {
  return Array.from(new Set((Array.isArray(hours) ? hours : []).map(Number).filter(Number.isFinite)))
    .sort((a, b) => predictionHourWindowOffset(a) - predictionHourWindowOffset(b));
}

function predictionSlotInPeriod(slotKey, periodKey = selectedPredictionPeriodKey) {
  const period = predictionPeriodConfig(periodKey);
  if (!Array.isArray(period.hours)) return true;
  const hour = predictionSlotHour(slotKey);
  return period.hours.includes(hour);
}

const PREDICTION_REGIONS = [
  { name: 'Bretagne', box: [-5.4, -1.0, 47.1, 49.3] },
  { name: 'Normandie', box: [-1.9, 1.8, 48.3, 50.3] },
  { name: 'Hauts-de-France', box: [1.2, 4.4, 49.2, 51.2] },
  { name: 'Grand Est', box: [4.0, 8.4, 47.6, 50.2] },
  { name: 'Bassin parisien', box: [1.0, 4.3, 47.8, 49.5] },
  { name: 'Pays de la Loire', box: [-2.6, 0.5, 46.4, 48.4] },
  { name: 'Centre-Val de Loire', box: [0.0, 3.5, 46.4, 48.3] },
  { name: 'Bourgogne-Franche-Comté', box: [3.4, 7.1, 46.1, 48.5] },
  { name: 'Nouvelle-Aquitaine', box: [-2.2, 1.6, 43.0, 46.9] },
  { name: 'Massif central', box: [1.6, 4.4, 44.0, 46.9] },
  { name: 'Auvergne-Rhône-Alpes', box: [3.7, 7.7, 44.1, 46.8] },
  { name: 'Occitanie', box: [-0.5, 4.5, 42.4, 44.8] },
  { name: 'PACA', box: [4.3, 7.8, 43.0, 44.6] },
  { name: 'Corse', box: [8.45, 9.7, 41.25, 43.15] },
];

const PREDICTION_LITTORALS = [
  { name: 'Manche et mer du Nord', box: [-5.4, 4.3, 48.55, 51.2] },
  { name: 'Atlantique nord', box: [-5.4, -1.0, 46.15, 49.15] },
  { name: 'Atlantique sud', box: [-2.4, -0.55, 43.15, 46.55] },
  { name: 'Golfe du Lion', box: [2.6, 5.0, 42.3, 44.2] },
  { name: 'Provence et Côte d’Azur', box: [4.8, 7.8, 42.85, 44.45] },
  { name: 'Corse', box: [8.45, 9.7, 41.25, 43.15] },
];

const PREDICTION_DEPARTMENT_REGIONS = Object.freeze({
  'Ain': 'Auvergne-Rhône-Alpes', 'Allier': 'Auvergne-Rhône-Alpes', 'Ardèche': 'Auvergne-Rhône-Alpes', 'Cantal': 'Auvergne-Rhône-Alpes', 'Drôme': 'Auvergne-Rhône-Alpes', 'Isère': 'Auvergne-Rhône-Alpes', 'Loire': 'Auvergne-Rhône-Alpes', 'Haute-Loire': 'Auvergne-Rhône-Alpes', 'Puy-de-Dôme': 'Auvergne-Rhône-Alpes', 'Rhône': 'Auvergne-Rhône-Alpes', 'Savoie': 'Auvergne-Rhône-Alpes', 'Haute-Savoie': 'Auvergne-Rhône-Alpes',
  'Côte-d’Or': 'Bourgogne-Franche-Comté', 'Doubs': 'Bourgogne-Franche-Comté', 'Jura': 'Bourgogne-Franche-Comté', 'Nièvre': 'Bourgogne-Franche-Comté', 'Haute-Saône': 'Bourgogne-Franche-Comté', 'Saône-et-Loire': 'Bourgogne-Franche-Comté', 'Yonne': 'Bourgogne-Franche-Comté', 'Territoire de Belfort': 'Bourgogne-Franche-Comté',
  'Côtes-d’Armor': 'Bretagne', 'Côtes-d Armor': 'Bretagne', 'Finistère': 'Bretagne', 'Ille-et-Vilaine': 'Bretagne', 'Morbihan': 'Bretagne',
  'Cher': 'Centre-Val de Loire', 'Eure-et-Loir': 'Centre-Val de Loire', 'Indre': 'Centre-Val de Loire', 'Indre-et-Loire': 'Centre-Val de Loire', 'Loir-et-Cher': 'Centre-Val de Loire', 'Loiret': 'Centre-Val de Loire',
  'Corse-du-Sud': 'Corse', 'Haute-Corse': 'Corse',
  'Ardennes': 'Grand Est', 'Aube': 'Grand Est', 'Marne': 'Grand Est', 'Haute-Marne': 'Grand Est', 'Meurthe-et-Moselle': 'Grand Est', 'Meuse': 'Grand Est', 'Moselle': 'Grand Est', 'Bas-Rhin': 'Grand Est', 'Haut-Rhin': 'Grand Est', 'Vosges': 'Grand Est',
  'Aisne': 'Hauts-de-France', 'Nord': 'Hauts-de-France', 'Oise': 'Hauts-de-France', 'Pas-de-Calais': 'Hauts-de-France', 'Somme': 'Hauts-de-France',
  'Paris': 'Île-de-France', 'Seine-et-Marne': 'Île-de-France', 'Yvelines': 'Île-de-France', 'Essonne': 'Île-de-France', 'Hauts-de-Seine': 'Île-de-France', 'Seine-Saint-Denis': 'Île-de-France', 'Val-de-Marne': 'Île-de-France', 'Val-d’Oise': 'Île-de-France',
  'Calvados': 'Normandie', 'Eure': 'Normandie', 'Manche': 'Normandie', 'Orne': 'Normandie', 'Seine-Maritime': 'Normandie',
  'Charente': 'Nouvelle-Aquitaine', 'Charente-Maritime': 'Nouvelle-Aquitaine', 'Corrèze': 'Nouvelle-Aquitaine', 'Creuse': 'Nouvelle-Aquitaine', 'Dordogne': 'Nouvelle-Aquitaine', 'Gironde': 'Nouvelle-Aquitaine', 'Landes': 'Nouvelle-Aquitaine', 'Lot-et-Garonne': 'Nouvelle-Aquitaine', 'Pyrénées-Atlantiques': 'Nouvelle-Aquitaine', 'Deux-Sèvres': 'Nouvelle-Aquitaine', 'Vienne': 'Nouvelle-Aquitaine', 'Haute-Vienne': 'Nouvelle-Aquitaine',
  'Ariège': 'Occitanie', 'Aude': 'Occitanie', 'Aveyron': 'Occitanie', 'Gard': 'Occitanie', 'Haute-Garonne': 'Occitanie', 'Gers': 'Occitanie', 'Hérault': 'Occitanie', 'Lot': 'Occitanie', 'Lozère': 'Occitanie', 'Hautes-Pyrénées': 'Occitanie', 'Pyrénées-Orientales': 'Occitanie', 'Tarn': 'Occitanie', 'Tarn-et-Garonne': 'Occitanie',
  'Loire-Atlantique': 'Pays de la Loire', 'Maine-et-Loire': 'Pays de la Loire', 'Mayenne': 'Pays de la Loire', 'Sarthe': 'Pays de la Loire', 'Vendée': 'Pays de la Loire',
  'Alpes-de-Haute-Provence': 'Provence-Alpes-Côte d’Azur', 'Hautes-Alpes': 'Provence-Alpes-Côte d’Azur', 'Alpes-Maritimes': 'Provence-Alpes-Côte d’Azur', 'Bouches-du-Rhône': 'Provence-Alpes-Côte d’Azur', 'Var': 'Provence-Alpes-Côte d’Azur', 'Vaucluse': 'Provence-Alpes-Côte d’Azur',
});

const PREDICTION_DEPARTMENT_REGION_MAP = new Map(Object.entries(PREDICTION_DEPARTMENT_REGIONS)
  .map(([department, region]) => [predictionNormalizeAdministrativeName(department), region]));

function predictionNormalizeAdministrativeName(value) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-zA-Z0-9]+/g, '')
    .toLowerCase();
}

function predictionRegionForDepartmentName(department) {
  return PREDICTION_DEPARTMENT_REGION_MAP.get(predictionNormalizeAdministrativeName(department)) || '';
}

function predictionDayKey(day = getCurrentDay()) {
  return normalizeDateIso(day?.day_key || selectedBaseDate);
}

function predictionDateAddDays(dateIso, delta) {
  if (typeof addDaysIso === 'function') return addDaysIso(dateIso, delta);
  const date = new Date(normalizeDateIso(dateIso) + 'T12:00:00');
  date.setDate(date.getDate() + delta);
  return date.toISOString().slice(0, 10);
}

function predictionNextDayKey(day = getCurrentDay()) {
  return predictionDateAddDays(predictionDayKey(day), 1);
}

function predictionSlotDateKeyForHour(hour, day = getCurrentDay()) {
  const baseDayKey = predictionDayKey(day);
  return Number(hour) >= PREDICTION_DAY_START_HOUR ? baseDayKey : predictionDateAddDays(baseDayKey, 1);
}

function predictionWindowDateLabel(day = getCurrentDay()) {
  const startDate = predictionDayKey(day);
  const endDate = predictionNextDayKey(day);
  const format = typeof formatTimelineDateLabel === 'function' ? formatTimelineDateLabel : (value) => value;
  return format(startDate) + ' 08h à ' + format(endDate) + ' 08h';
}

function predictionAllDaySlotKeys() {
  return PREDICTION_DAY_WINDOW_HOURS.map(predictionSlotKeyForHour);
}

function predictionDayByKey(dayKey, preferredDay = getCurrentDay()) {
  const normalized = normalizeDateIso(dayKey);
  // Le store de la page Prévision (jours hydratés indépendamment de la grille) gagne.
  if (PREDICTION_DAY_STORE.has(normalized)) return PREDICTION_DAY_STORE.get(normalized);
  if (preferredDay?.day_key === normalized) return preferredDay;
  const payloadDay = typeof getDays === 'function'
    ? getDays().find((item) => normalizeDateIso(item?.day_key) === normalized)
    : null;
  if (payloadDay) return payloadDay;
  return typeof getCachedAromeFranceDay === 'function' ? getCachedAromeFranceDay(normalized) : null;
}

function predictionSlotHasAromeCells(slot) {
  return Array.isArray(slot?.cells)
    && slot.cells.some((cell) => cell?.source_provider === 'meteofrance_arome_grib');
}

function predictionSlotFromDay(dayKey, slotKey, preferredDay = getCurrentDay()) {
  const day = predictionDayByKey(dayKey, preferredDay);
  const slot = Array.isArray(day?.slots) ? day.slots.find((item) => item?.slot_key === slotKey) : null;
  if (!predictionSlotHasAromeCells(slot)) return null;
  const normalizedDayKey = normalizeDateIso(dayKey);
  return { ...slot, prediction_day_key: normalizedDayKey, prediction_window_key: normalizedDayKey + ':' + slotKey };
}

function predictionLoadedSlots(day = getCurrentDay()) {
  return predictionAllDaySlotKeys()
    .map((slotKey) => {
      const hour = predictionSlotHour(slotKey);
      return predictionSlotFromDay(predictionSlotDateKeyForHour(hour, day), slotKey, day);
    })
    .filter(Boolean);
}

function predictionPeriodSlotKeys(periodKey = selectedPredictionPeriodKey) {
  const period = predictionPeriodConfig(periodKey);
  if (!Array.isArray(period.hours)) return predictionAllDaySlotKeys();
  return period.hours.map(predictionSlotKeyForHour);
}

function predictionPeriodLoadedSlots(day = getCurrentDay(), periodKey = selectedPredictionPeriodKey) {
  return predictionLoadedSlots(day).filter((slot) => predictionSlotInPeriod(slot?.slot_key, periodKey));
}

function predictionPeriodStatus(day = getCurrentDay(), periodKey = selectedPredictionPeriodKey) {
  if (predictionDayIsTrend(day)) {
    const ready = predictionTrendDailyCells(day).length > 0;
    return { ready, loadedCount: ready ? 1 : 0, totalCount: 1, missingKeys: [] };
  }
  const expectedKeys = predictionRequiredSlotKeys(predictionPeriodSlotKeys(periodKey), day);
  const loadedKeys = new Set(predictionPeriodLoadedSlots(day, periodKey).map((slot) => slot.slot_key));
  return {
    ready: expectedKeys.every((key) => loadedKeys.has(key)),
    loadedCount: loadedKeys.size,
    totalCount: expectedKeys.length,
    missingKeys: expectedKeys.filter((key) => !loadedKeys.has(key)),
  };
}

// La fenêtre 08h-08h tire ses heures 0-7h du lendemain. Si le lendemain n'a pas de
// données horaires (jour de tendance ECMWF, ou au-delà de l'horizon), on ne peut pas
// compléter ce tail nocturne : on le rend optionnel pour que le jour reste affichable
// (ex. J+4, dont la nuit retombe sur J+5 ECMWF).
function predictionNextTailAvailable(day = getCurrentDay()) {
  const nextIso = predictionDateAddDays(predictionDayKey(day), 1);
  return !predictionDateIsTrend(nextIso) && predictionDateOffset(nextIso) <= PREDICTION_MAX_OFFSET;
}

function predictionRequiredSlotKeys(slotKeys, day = getCurrentDay()) {
  if (predictionNextTailAvailable(day)) return slotKeys;
  return slotKeys.filter((key) => predictionSlotHour(key) >= PREDICTION_DAY_START_HOUR);
}

function predictionDayStatus(day = getCurrentDay()) {
  if (predictionDayIsTrend(day)) {
    const ready = predictionTrendDailyCells(day).length > 0;
    return { ready, loadedCount: ready ? 1 : 0, totalCount: 1, missingKeys: [] };
  }
  const expectedKeys = predictionRequiredSlotKeys(predictionAllDaySlotKeys(), day);
  const loadedKeys = new Set(predictionLoadedSlots(day).map((slot) => slot.slot_key));
  return {
    ready: expectedKeys.every((key) => loadedKeys.has(key)),
    loadedCount: loadedKeys.size,
    totalCount: expectedKeys.length,
    missingKeys: expectedKeys.filter((key) => !loadedKeys.has(key)),
  };
}

function predictionStringHash(value) {
  let hash = 2166136261;
  const text = String(value || '');
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}

function predictionDaySignature(day = getCurrentDay()) {
  return predictionLoadedSlots(day).map((slot) => {
    const cells = Array.isArray(slot?.cells) ? slot.cells : [];
    const sample = cells.length ? [cells[0], cells[Math.floor(cells.length / 2)], cells[cells.length - 1]] : [];
    const sampleText = sample.map((cell) => `${Math.round(Number(cell?.trigger_score || 0))}:${Math.round(Number(cell?.confidence_score || 0))}:${Number(cell?.lat || 0).toFixed(2)}:${Number(cell?.lon || 0).toFixed(2)}`).join(',');
    return (slot?.prediction_day_key || predictionDayKey(day)) + ':' + (slot?.slot_key || '') + ':' + cells.length + ':' + Math.round(Number(slot?.summary?.max_score || 0)) + ':' + Math.round(Number(slot?.summary?.mean_score || 0)) + ':' + sampleText;
  }).join('|');
}

// Variant de légende selon le viewport. La légende est gravée dans le SVG (qui est
// mis en cache ET réutilisé pour l'export PNG), donc elle doit faire partie de la
// clé de cache : sans ça, une image générée à une largeur s'afficherait avec la
// mauvaise légende à une autre. Seuil aligné sur le breakpoint mobile CSS (768).
function predictionLegendVariant() {
  const w = (typeof window !== 'undefined' && window.innerWidth) ? window.innerWidth : 860;
  return w < 768 ? 'm' : 'd';
}

function predictionCacheKey(day = getCurrentDay(), periodKey = selectedPredictionPeriodKey) {
  const status = predictionDayStatus(day);
  const period = predictionPeriodConfig(periodKey);
  return `${predictionDayKey(day)}|${period.key}|${status.loadedCount}/${status.totalCount}|${predictionStringHash(predictionDaySignature(day))}|${PREDICTION_IMAGE_RENDER_VERSION}|${predictionLegendVariant()}|arome-france`;
}

function predictionMean(values) {
  if (!values.length) return 0;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function predictionTopMean(values, count) {
  if (!values.length) return 0;
  return predictionMean(values.slice().sort((a, b) => b - a).slice(0, Math.max(1, count)));
}

function predictionCellId(cell) {
  if (cell?.zone) return String(cell.zone);
  const lat = Number(cell?.lat || 0).toFixed(3);
  const lon = Number(cell?.lon || 0).toFixed(3);
  return `${lat}|${lon}`;
}

function predictionCellScore(cell) {
  if (!cell) return 0;
  // trigger_score est déjà la probabilité orageuse calibrée côté serveur :
  // confiance intégrée (v1.2.0) ET gating météo (CAPE/sécheresse/CIN…) appliqué
  // dans compute_initiation. On la prend telle quelle pour que la carte coïncide
  // avec le score de la fiche de détail — pas de ré-application client (qui
  // double-comptait la confiance) ni de re-plafonnement (qui dupliquait le gating).
  return Math.round(clampScore(cell.trigger_score));
}

// Score utilisé pour le rendu des couches : on prend le score lissé spatialement,
// mais on garde un plancher à 94 % du score brut de la cellule pour qu'un lissage
// trop diffusif n'efface pas un pic local réel.
function predictionLayerScore(cell) {
  if (!cell) return 0;
  const smooth = clampScore(cell.smoothedScore ?? cell.score ?? 0);
  const daily = clampScore(cell.score ?? smooth);
  return Math.round(clampScore(Math.max(smooth, daily * 0.94)));
}

// Journée entière = enveloppe des périodes : pour chaque cellule on prend son
// MEILLEUR score parmi matin / après-midi / soirée, au lieu de moyenner sur 24 h
// (ce qui diluait le signal avec les heures calmes et rendait la journée plus
// pauvre que l'après-midi seule — un paradoxe). Sens météo correct d'un risque
// journalier : « à un moment ou un autre de la journée, quel risque max ici ? ».
// La zone journée englobe ainsi toujours celles des périodes.
function predictionDayCellsFromPeriods(day) {
  const byId = new Map();
  ['morning', 'afternoon', 'evening'].forEach((periodKey) => {
    collectPredictionDailyCells(day, periodKey).forEach((cell) => {
      const existing = byId.get(cell.id);
      if (!existing || cell.score > existing.score) byId.set(cell.id, cell);
    });
  });
  return Array.from(byId.values());
}

