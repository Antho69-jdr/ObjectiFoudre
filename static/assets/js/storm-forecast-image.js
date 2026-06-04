const PREDICTION_IMAGE_RENDER_VERSION = 'iso-contour-atlas-v43';

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

const PREDICTION_RISK_LEVELS = Object.freeze([
  { key: 'below-threshold', label: 'Sous seuil', range: '0-64', min: 0, color: '#e7edf1', stroke: '#586b7a', text: 'signal inférieur au seuil cartographié' },
  { key: 'low', label: 'Faible', range: '65-74', min: 65, color: '#4da6b4', stroke: '#123a42', text: 'signal faible, à surveiller localement' },
  { key: 'medium', label: 'Moyen', range: '75-84', min: 75, color: '#75a96d', stroke: '#253b25', text: 'signal moyen, environnement à suivre' },
  { key: 'elevated', label: 'Élevé', range: '85-89', min: 85, color: '#bf7d57', stroke: '#482b1a', text: 'signal élevé à surveiller sérieusement' },
  { key: 'very-high', label: 'Très élevé', range: '90-94', min: 90, color: '#bd5d66', stroke: '#4d1f27', text: 'signal très élevé, à contrôler finement' },
  { key: 'certain', label: 'Certain', range: '95-100', min: 95, color: '#9a72c8', stroke: '#33224d', text: 'signal maximal ou quasi maximal' },
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
  const expectedKeys = predictionPeriodSlotKeys(periodKey);
  const loadedKeys = new Set(predictionPeriodLoadedSlots(day, periodKey).map((slot) => slot.slot_key));
  return {
    ready: expectedKeys.every((key) => loadedKeys.has(key)),
    loadedCount: loadedKeys.size,
    totalCount: expectedKeys.length,
    missingKeys: expectedKeys.filter((key) => !loadedKeys.has(key)),
  };
}

function predictionDayStatus(day = getCurrentDay()) {
  const expectedKeys = predictionAllDaySlotKeys();
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

function collectPredictionDailyCells(day = getCurrentDay(), periodKey = 'day') {
  if (periodKey === 'day') return predictionDayCellsFromPeriods(day);
  const grouped = new Map();
  const period = predictionPeriodConfig(periodKey);
  const slots = predictionPeriodLoadedSlots(day, period.key);
  slots.forEach((slot) => {
    const hour = Number(String(slot.slot_key || '').replace('h', ''));
    (slot.cells || []).forEach((cell) => {
      if (cell?.source_provider !== 'meteofrance_arome_grib') return;
      const lat = Number(cell.lat);
      const lon = Number(cell.lon);
      if (!Number.isFinite(lat) || !Number.isFinite(lon)) return;
      const id = predictionCellId(cell);
      const entry = grouped.get(id) || {
        id,
        zone: cell.zone || id,
        lat,
        lon,
        cellHeightDeg: Number(cell.cell_height_deg) || 0.18,
        cellWidthDeg: Number(cell.cell_width_deg) || 0.18,
        scores: [],
        confidence: [],
        hours: [],
        cape: [],
        temperature: [],
        dewpoint: [],
        gusts: [],
      };
      const score = predictionCellScore(cell);
      entry.scores.push(score);
      const confidence = Number(cell.confidence_score);
      if (Number.isFinite(confidence)) entry.confidence.push(clampScore(confidence));
      if (Number.isFinite(hour)) entry.hours.push({ hour, score });
      const cape = Number(cell.mucape);
      const temperature = Number(cell.temp_c);
      const dewpoint = Number(cell.dewpoint_c);
      const gusts = Number(cell.wind_gusts_10m);
      if (Number.isFinite(cape)) entry.cape.push(cape);
      if (Number.isFinite(temperature)) entry.temperature.push(temperature);
      if (Number.isFinite(dewpoint)) entry.dewpoint.push(dewpoint);
      if (Number.isFinite(gusts)) entry.gusts.push(gusts);
      grouped.set(id, entry);
    });
  });
  return Array.from(grouped.values()).map((entry) => {
    const hourCount = Math.max(1, entry.scores.length);
    const topCount = Math.max(2, Math.min(5, Math.round(hourCount * 0.20)));
    const topMean = predictionTopMean(entry.scores, topCount);
    const mean = predictionMean(entry.scores);
    const peak = Math.max(...entry.scores, 0);
    const activeCount = entry.scores.filter((score) => score >= 65).length;
    const watchCount = entry.scores.filter((score) => score >= 45).length;
    const confidenceMean = predictionMean(entry.confidence);
    // Score journalier agrégé d'une cellule sur la fenêtre 24 h (poids = 1.0) :
    //  - topMean 0.58 : domine, reflète les meilleures heures (pic soutenu)
    //  - mean 0.18 : tient compte du fond de la journée
    //  - peak 0.18 : récompense un pic isolé fort
    //  - watchCount 0.06 : léger bonus de persistance (heures ≥ 45)
    let score = (topMean * 0.58) + (mean * 0.18) + (peak * 0.18) + (Math.min(100, watchCount * 14) * 0.06);
    if (activeCount <= 0 && peak < 68) score = Math.min(score, 64);   // aucune heure active → reste sous seuil
    if (activeCount === 1 && peak < 82) score = Math.min(score, peak - 2); // signal d'une seule heure → atténué
    if (activeCount >= 3) score += Math.min(8, activeCount * 1.2);     // persistance multi-heures → bonus plafonné
    // La confiance est déjà intégrée dans trigger_score (donc dans chaque score de
    // cellule) côté serveur — pas de ré-application ici. confidenceMean reste
    // calculé et exposé à titre diagnostique uniquement.
    score = Math.round(clampScore(score));
    const bestHourCandidates = entry.hours
      .filter((item) => item.score >= Math.max(28, peak - 10))
      .sort((a, b) => b.score - a.score)
      .slice(0, 4)
      .map((item) => item.hour);
    const bestHours = predictionSortWindowHours(bestHourCandidates);
    return {
      ...entry,
      score,
      peak,
      topMean,
      mean,
      confidenceMean,
      activeCount,
      bestHours,
      meanCape: predictionMean(entry.cape),
      meanTemperature: predictionMean(entry.temperature),
      meanDewpoint: predictionMean(entry.dewpoint),
      maxGusts: Math.max(...entry.gusts, 0),
    };
  });
}

function predictionDistanceKm(a, b) {
  const lat1 = Number(a.lat) * Math.PI / 180;
  const lat2 = Number(b.lat) * Math.PI / 180;
  const dLat = (Number(b.lat) - Number(a.lat)) * Math.PI / 180;
  const dLon = (Number(b.lon) - Number(a.lon)) * Math.PI / 180;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return 6371 * 2 * Math.atan2(Math.sqrt(h), Math.sqrt(Math.max(0, 1 - h)));
}

// Lissage spatial gaussien : adoucit la carte en mélangeant chaque cellule avec
// ses voisines dans un rayon de 78 km (~5 cellules AROME), pondération gaussienne.
// Le résultat est un mélange 56 % cellule / 44 % moyenne locale, de sorte que le
// pic propre de la cellule reste dominant tout en gommant le bruit isolé.
function smoothPredictionCells(cells) {
  if (!Array.isArray(cells) || !cells.length) return [];
  const radiusKm = 78;
  return cells.map((cell) => {
    let weighted = 0;
    let totalWeight = 0;
    for (const other of cells) {
      const distance = predictionDistanceKm(cell, other);
      if (distance > radiusKm) continue;
      const weight = Math.exp(-((distance / radiusKm) ** 2) * 2.15);
      weighted += other.score * weight;
      totalWeight += weight;
    }
    const localMean = totalWeight ? weighted / totalWeight : cell.score;
    let smoothedScore = clampScore(cell.score * 0.56 + localMean * 0.44);
    // Une cellule faible (< 54) ne doit pas être remontée au-dessus du seuil
    // cartographié (65) par le seul lissage de voisines plus actives.
    if (cell.score < 54 && smoothedScore >= 65) smoothedScore = 64;
    return {
      ...cell,
      smoothedScore: Math.round(smoothedScore),
    };
  });
}

function predictionBounds() {
  const rings = typeof FRANCE_GRID_CLIP_RINGS !== 'undefined' ? FRANCE_GRID_CLIP_RINGS : [];
  const points = rings.flat();
  return points.reduce((bounds, point) => ({
    minLon: Math.min(bounds.minLon, point[0]),
    maxLon: Math.max(bounds.maxLon, point[0]),
    minLat: Math.min(bounds.minLat, point[1]),
    maxLat: Math.max(bounds.maxLat, point[1]),
  }), { minLon: -5.4, maxLon: 9.7, minLat: 41.1, maxLat: 51.2 });
}

function predictionProjectionMetrics(width, height) {
  const bounds = predictionBounds();
  const referenceLat = (bounds.minLat + bounds.maxLat) / 2;
  const lonScale = Math.cos((referenceLat * Math.PI) / 180);
  const padX = 34;
  const padY = 30;
  const minX = bounds.minLon * lonScale;
  const maxX = bounds.maxLon * lonScale;
  const minY = bounds.minLat;
  const maxY = bounds.maxLat;
  const xSpan = Math.max(0.1, maxX - minX);
  const ySpan = Math.max(0.1, maxY - minY);
  const scale = Math.min((width - padX * 2) / xSpan, (height - padY * 2) / ySpan);
  const mapWidth = xSpan * scale;
  const mapHeight = ySpan * scale;
  const offsetX = (width - mapWidth) / 2;
  const offsetY = (height - mapHeight) / 2;
  const project = (lon, lat) => [offsetX + ((lon * lonScale) - minX) * scale, offsetY + (maxY - lat) * scale];
  const invert = (x, y) => ({
    lon: (((x - offsetX) / scale) + minX) / lonScale,
    lat: maxY - ((y - offsetY) / scale),
  });
  return { width, height, bounds, lonScale, scale, offsetX, offsetY, mapWidth, mapHeight, project, invert };
}

function predictionProjector(width, height) {
  return predictionProjectionMetrics(width, height).project;
}

function predictionHexToRgba(hex, alpha = 1) {
  const clean = String(hex || '').replace('#', '').trim();
  if (!/^[0-9a-fA-F]{6}$/.test(clean)) return `rgba(255,255,255,${alpha})`;
  const r = parseInt(clean.slice(0, 2), 16);
  const g = parseInt(clean.slice(2, 4), 16);
  const b = parseInt(clean.slice(4, 6), 16);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

function predictionRiskLevel(score) {
  const s = clampScore(score);
  let selected = PREDICTION_RISK_LEVELS[0];
  PREDICTION_RISK_LEVELS.forEach((level) => {
    if (s >= level.min) selected = level;
  });
  return selected;
}

function predictionRiskLabel(score) {
  return predictionRiskLevel(score).label;
}

function predictionFranceSvgPath(project) {
  const rings = typeof FRANCE_GRID_CLIP_RINGS !== 'undefined' ? FRANCE_GRID_CLIP_RINGS : [];
  return rings.map((ring) => {
    if (!Array.isArray(ring) || ring.length < 3) return '';
    return ring.map((point, index) => {
      const [x, y] = project(point[0], point[1]);
      return `${index === 0 ? 'M' : 'L'}${x.toFixed(1)} ${y.toFixed(1)}`;
    }).join(' ') + ' Z';
  }).filter(Boolean).join(' ');
}

function predictionProjectedBounds(project) {
  const rings = typeof FRANCE_GRID_CLIP_RINGS !== 'undefined' ? FRANCE_GRID_CLIP_RINGS : [];
  const points = rings.flat().map((point) => project(point[0], point[1]));
  return points.reduce((bounds, point) => ({
    minX: Math.min(bounds.minX, point[0]),
    maxX: Math.max(bounds.maxX, point[0]),
    minY: Math.min(bounds.minY, point[1]),
    maxY: Math.max(bounds.maxY, point[1]),
  }), { minX: 34, maxX: 826, minY: 30, maxY: 730 });
}

function predictionAdminLineMarkup(project) {
  const geoRings = typeof FRANCE_DEPARTMENT_RINGS !== 'undefined' ? FRANCE_DEPARTMENT_RINGS : null;
  if (Array.isArray(geoRings) && geoRings.length) {
    const paths = geoRings.map((ring) => {
      if (!Array.isArray(ring) || ring.length < 3) return '';
      const d = ring.map((point, index) => {
        const [x, y] = project(Number(point[0]), Number(point[1]));
        return `${index === 0 ? 'M' : 'L'}${x.toFixed(1)} ${y.toFixed(1)}`;
      }).join(' ');
      return `<path d="${d} Z"/>`;
    }).filter(Boolean).join('');
    if (!paths) return '';
    return `<g class="prediction-admin-lines" fill="none" stroke-linejoin="round" stroke-linecap="round">
      <g stroke="#020617" stroke-opacity="0.72" stroke-width="0.92">${paths}</g>
      <g stroke="#7dd3fc" stroke-opacity="0.18" stroke-width="0.24">${paths}</g>
    </g>`;
  }

  if (typeof FRANCE_ADMIN_POLYGONS_NORMALIZED === 'undefined' || !Array.isArray(FRANCE_ADMIN_POLYGONS_NORMALIZED)) return '';
  const bounds = predictionProjectedBounds(project);
  const outerWidth = Math.max(1, bounds.maxX - bounds.minX);
  const outerHeight = Math.max(1, bounds.maxY - bounds.minY);
  const sourceAspect = Number(typeof FRANCE_ADMIN_SOURCE_ASPECT !== 'undefined' ? FRANCE_ADMIN_SOURCE_ASPECT : outerWidth / outerHeight) || (outerWidth / outerHeight);
  let width = Math.min(outerWidth, outerHeight * sourceAspect);
  let height = width / sourceAspect;
  if (height > outerHeight) {
    height = outerHeight;
    width = height * sourceAspect;
  }
  const x0 = bounds.minX + (outerWidth - width) / 2;
  const y0 = bounds.minY + (outerHeight - height) / 2;
  const paths = FRANCE_ADMIN_POLYGONS_NORMALIZED.map((ring) => {
    if (!Array.isArray(ring) || ring.length < 3) return '';
    const d = ring.map((point, index) => {
      const x = x0 + Number(point[0]) * width;
      const y = y0 + Number(point[1]) * height;
      return `${index === 0 ? 'M' : 'L'}${x.toFixed(1)} ${y.toFixed(1)}`;
    }).join(' ');
    return `<path d="${d} Z"/>`;
  }).filter(Boolean).join('');
  if (!paths) return '';
  return `<g class="prediction-admin-lines" fill="none" stroke-linejoin="round" stroke-linecap="round">
    <g stroke="#020617" stroke-opacity="0.72" stroke-width="0.92">${paths}</g>
    <g stroke="#7dd3fc" stroke-opacity="0.18" stroke-width="0.24">${paths}</g>
  </g>`;
}

function predictionRingCentroid(ring) {
  if (!Array.isArray(ring) || !ring.length) return null;
  let sumLon = 0;
  let sumLat = 0;
  ring.forEach((point) => {
    sumLon += Number(point[0]) || 0;
    sumLat += Number(point[1]) || 0;
  });
  return { lon: sumLon / ring.length, lat: sumLat / ring.length };
}

function predictionNearestRegionForPoint(lon, lat) {
  const direct = predictionAreaForCell({ lon, lat }, PREDICTION_REGIONS);
  if (direct) return direct.name;
  let nearest = PREDICTION_REGIONS[0]?.name || 'France';
  let bestDistance = Infinity;
  PREDICTION_REGIONS.forEach((region) => {
    const [minLon, maxLon, minLat, maxLat] = region.box;
    const center = { lon: (minLon + maxLon) / 2, lat: (minLat + maxLat) / 2 };
    const distance = predictionDistanceKm({ lon, lat }, center);
    if (distance < bestDistance) {
      bestDistance = distance;
      nearest = region.name;
    }
  });
  return nearest;
}

function predictionPointKey(point) {
  return `${Number(point[0]).toFixed(3)},${Number(point[1]).toFixed(3)}`;
}

function predictionSegmentKey(a, b) {
  const ka = predictionPointKey(a);
  const kb = predictionPointKey(b);
  return ka < kb ? `${ka}|${kb}` : `${kb}|${ka}`;
}

function predictionRegionForDepartmentRing(ring) {
  const centroid = predictionRingCentroid(ring);
  if (!centroid) return '';
  const place = predictionKnownPlaceForDepartmentRing(ring, centroid);
  return predictionRegionForDepartmentName(place?.department) || predictionNearestRegionForPoint(centroid.lon, centroid.lat);
}

function predictionRegionBoundaryMarkup(project) {
  const rings = typeof FRANCE_DEPARTMENT_RINGS !== 'undefined' ? FRANCE_DEPARTMENT_RINGS : null;
  if (!Array.isArray(rings) || !rings.length) return '';
  const segmentMap = new Map();
  rings.forEach((ring) => {
    if (!Array.isArray(ring) || ring.length < 3) return;
    const region = predictionRegionForDepartmentRing(ring);
    if (!region) return;
    for (let index = 0; index < ring.length; index += 1) {
      const a = ring[index];
      const b = ring[(index + 1) % ring.length];
      const key = predictionSegmentKey(a, b);
      const entry = segmentMap.get(key) || { a, b, regions: new Set() };
      entry.regions.add(region);
      segmentMap.set(key, entry);
    }
  });
  const paths = Array.from(segmentMap.values())
    .filter((entry) => entry.regions.size > 1)
    .map((entry) => {
      const [x1, y1] = project(Number(entry.a[0]), Number(entry.a[1]));
      const [x2, y2] = project(Number(entry.b[0]), Number(entry.b[1]));
      return `<path d="M${x1.toFixed(1)} ${y1.toFixed(1)} L${x2.toFixed(1)} ${y2.toFixed(1)}"/>`;
    })
    .join('');
  if (!paths) return '';
  return `<g class="prediction-region-lines" fill="none" stroke-linejoin="round" stroke-linecap="round">
    <g stroke="#020617" stroke-opacity="0.82" stroke-width="1.72">${paths}</g>
    <g stroke="#9ddbd0" stroke-opacity="0.18" stroke-width="0.42">${paths}</g>
  </g>`;
}

function predictionEscapeXml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function predictionAllLevelConfigs() {
  // On exclut le niveau 0 ("sous seuil") : seuls les niveaux cartographiés (≥ 65).
  return PREDICTION_RISK_LEVELS.slice(1).map((level) => ({
    ...level,
    threshold: level.min,
  }));
}


function predictionLevelConfigs(cells) {
  const maxScore = Math.max(...cells.map((cell) => predictionLayerScore(cell)), 0);
  return predictionAllLevelConfigs().filter((level) => maxScore >= level.threshold);
}

function predictionLevelForScore(score, levels = predictionAllLevelConfigs()) {
  const s = predictionLayerScore({ score });
  let selected = null;
  levels.forEach((level) => {
    if (s >= level.threshold) selected = level;
  });
  return selected;
}

function predictionClosedBezierPath(points, tension = 0.82) {
  if (!Array.isArray(points) || points.length < 3) return '';
  const path = [`M${points[0][0].toFixed(1)} ${points[0][1].toFixed(1)}`];
  const scale = tension / 6;
  for (let index = 0; index < points.length; index += 1) {
    const p0 = points[(index - 1 + points.length) % points.length];
    const p1 = points[index];
    const p2 = points[(index + 1) % points.length];
    const p3 = points[(index + 2) % points.length];
    const c1 = [p1[0] + (p2[0] - p0[0]) * scale, p1[1] + (p2[1] - p0[1]) * scale];
    const c2 = [p2[0] - (p3[0] - p1[0]) * scale, p2[1] - (p3[1] - p1[1]) * scale];
    path.push(`C${c1[0].toFixed(1)} ${c1[1].toFixed(1)} ${c2[0].toFixed(1)} ${c2[1].toFixed(1)} ${p2[0].toFixed(1)} ${p2[1].toFixed(1)}`);
  }
  path.push('Z');
  return path.join(' ');
}

// ===== Rendu par iso-contours (style atlas météo, type Keraunos) =====
// On rasterise les scores des cellules sur une grille régulière, on la lisse, puis
// on extrait par "marching squares" le contour fermé de chaque seuil de risque.
// Résultat : une zone continue et arrondie qui épouse la forme réelle du signal
// (concavités possibles), au lieu de bulles par cellule ou d'un convex hull débordant.

function predictionMedian(values) {
  const arr = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!arr.length) return NaN;
  const mid = Math.floor(arr.length / 2);
  return arr.length % 2 ? arr[mid] : (arr[mid - 1] + arr[mid]) / 2;
}

// Construit le champ scalaire en "peignant" chaque cellule comme un disque plat de
// ~40 km à sa valeur (combinés par max). Pas de moyennage avec le vide (qui
// écraserait le signal) : le score est préservé, les cellules voisines fusionnent,
// et le contour iso épouse l'union des disques — d'où des zones rondes et fidèles.
const PREDICTION_FIELD_RADIUS_KM = 55;

function predictionBuildScalarField(cells) {
  const b = predictionBounds();
  const cellW = predictionMedian(cells.map((c) => Number(c.cellWidthDeg || c.cell_width_deg))) || 0.16;
  const cellH = predictionMedian(cells.map((c) => Number(c.cellHeightDeg || c.cell_height_deg))) || 0.16;
  const radiusNodes = Math.max(1.4, PREDICTION_FIELD_RADIUS_KM / (cellH * 111));
  const reach = Math.ceil(radiusNodes);
  // Bordure de zéros (padding ≥ portée des disques) : garantit qu'aucune zone ne
  // touche le bord de la grille, donc tout contour se referme à l'intérieur. Sans
  // ça, une zone atteignant le nord de la France (~51,2°N = bord) restait ouverte
  // et était jetée → carte vide sur la journée entière.
  const pad = reach + 1;
  const cols = Math.max(2, Math.round((b.maxLon - b.minLon) / cellW) + 1) + pad * 2;
  const rows = Math.max(2, Math.round((b.maxLat - b.minLat) / cellH) + 1) + pad * 2;
  const grid = Array.from({ length: rows }, () => new Float64Array(cols));
  cells.forEach((cell) => {
    const cs = predictionLayerScore(cell);
    if (cs <= 0) return;
    const ci = Math.round((Number(cell.lon) - b.minLon) / cellW) + pad;
    const cj = Math.round((Number(cell.lat) - b.minLat) / cellH) + pad;
    for (let dj = -reach; dj <= reach; dj += 1) {
      for (let di = -reach; di <= reach; di += 1) {
        const i = ci + di;
        const j = cj + dj;
        if (i < 0 || i >= cols || j < 0 || j >= rows) continue;
        if (Math.hypot(di, dj) > radiusNodes) continue;
        if (cs > grid[j][i]) grid[j][i] = cs;
      }
    }
  });
  return { grid, rows, cols, minLon: b.minLon, minLat: b.minLat, cellW, cellH, pad };
}

// Marching squares → anneaux fermés (points en coordonnées de grille fractionnaires).
function predictionMarchingSquaresRings(field, threshold) {
  const { grid, rows, cols } = field;
  const segments = [];
  const interp = (xa, ya, va, xb, yb, vb) => {
    const t = (va === vb) ? 0.5 : (threshold - va) / (vb - va);
    return [xa + (xb - xa) * t, ya + (yb - ya) * t];
  };
  for (let j = 0; j < rows - 1; j += 1) {
    for (let i = 0; i < cols - 1; i += 1) {
      const v0 = grid[j][i];
      const v1 = grid[j][i + 1];
      const v2 = grid[j + 1][i + 1];
      const v3 = grid[j + 1][i];
      let c = 0;
      if (v0 >= threshold) c |= 1;
      if (v1 >= threshold) c |= 2;
      if (v2 >= threshold) c |= 4;
      if (v3 >= threshold) c |= 8;
      if (c === 0 || c === 15) continue;
      const B = () => interp(i, j, v0, i + 1, j, v1);
      const R = () => interp(i + 1, j, v1, i + 1, j + 1, v2);
      const T = () => interp(i, j + 1, v3, i + 1, j + 1, v2);
      const L = () => interp(i, j, v0, i, j + 1, v3);
      switch (c) {
        case 1: segments.push([L(), B()]); break;
        case 2: segments.push([B(), R()]); break;
        case 3: segments.push([L(), R()]); break;
        case 4: segments.push([R(), T()]); break;
        case 5: segments.push([L(), B()]); segments.push([R(), T()]); break;
        case 6: segments.push([B(), T()]); break;
        case 7: segments.push([L(), T()]); break;
        case 8: segments.push([T(), L()]); break;
        case 9: segments.push([B(), T()]); break;
        case 10: segments.push([B(), R()]); segments.push([T(), L()]); break;
        case 11: segments.push([R(), T()]); break;
        case 12: segments.push([L(), R()]); break;
        case 13: segments.push([B(), R()]); break;
        case 14: segments.push([L(), B()]); break;
        default: break;
      }
    }
  }
  return predictionStitchSegments(segments);
}

function predictionStitchSegments(segments) {
  const key = (p) => `${p[0].toFixed(3)},${p[1].toFixed(3)}`;
  const adj = new Map();
  segments.forEach((seg, idx) => {
    const ka = key(seg[0]);
    const kb = key(seg[1]);
    if (!adj.has(ka)) adj.set(ka, []);
    if (!adj.has(kb)) adj.set(kb, []);
    adj.get(ka).push({ idx, to: seg[1], toKey: kb });
    adj.get(kb).push({ idx, to: seg[0], toKey: ka });
  });
  const used = new Array(segments.length).fill(false);
  const rings = [];
  segments.forEach((seg, startIdx) => {
    if (used[startIdx]) return;
    used[startIdx] = true;
    const ring = [seg[0], seg[1]];
    const startKey = key(seg[0]);
    let currentKey = key(seg[1]);
    let guard = 0;
    let closed = false;
    while (guard <= segments.length) {
      if (currentKey === startKey) { closed = true; break; }
      guard += 1;
      const next = (adj.get(currentKey) || []).find((l) => !used[l.idx]);
      if (!next) break;
      used[next.idx] = true;
      ring.push(next.to);
      currentKey = next.toKey;
    }
    // On ne garde que les anneaux qui se referment : un anneau ouvert serait fermé
    // par une corde droite (= le trait diagonal parasite vu sur la journée entière).
    if (closed && ring.length >= 3) rings.push(ring);
  });
  return rings;
}

function predictionPolygonArea(points) {
  let area = 0;
  for (let i = 0; i < points.length; i += 1) {
    const a = points[i];
    const b = points[(i + 1) % points.length];
    area += a[0] * b[1] - b[0] * a[1];
  }
  return Math.abs(area) / 2;
}

function predictionChaikinClosed(points, passes) {
  let out = points;
  for (let p = 0; p < passes; p += 1) {
    const next = [];
    for (let i = 0; i < out.length; i += 1) {
      const a = out[i];
      const b = out[(i + 1) % out.length];
      next.push([a[0] * 0.75 + b[0] * 0.25, a[1] * 0.75 + b[1] * 0.25]);
      next.push([a[0] * 0.25 + b[0] * 0.75, a[1] * 0.25 + b[1] * 0.75]);
    }
    out = next;
  }
  return out;
}

function predictionRingCentroidPt(ring) {
  let sx = 0;
  let sy = 0;
  ring.forEach((p) => { sx += p[0]; sy += p[1]; });
  return [sx / ring.length, sy / ring.length];
}

function predictionRingContains(ring, pt) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i][0];
    const yi = ring[i][1];
    const xj = ring[j][0];
    const yj = ring[j][1];
    if (((yi > pt[1]) !== (yj > pt[1])) && (pt[0] < ((xj - xi) * (pt[1] - yi)) / (yj - yi) + xi)) {
      inside = !inside;
    }
  }
  return inside;
}

function predictionContourLevelMarkup(field, project, level) {
  let rings = predictionMarchingSquaresRings(field, level.threshold)
    // anti-bruit : ignore les contours minuscules (< ~1,4 cellule de grille)
    .filter((ring) => predictionPolygonArea(ring) >= 1.4);
  if (!rings.length) return '';
  // Retire les anneaux internes (trous) : on ne veut pas affirmer « pas de risque
  // ici » au milieu d'une zone — la prévision orageuse est trop incertaine pour ça.
  const areas = rings.map(predictionPolygonArea);
  const centroids = rings.map(predictionRingCentroidPt);
  rings = rings.filter((ring, idx) => !rings.some((other, k) => k !== idx && areas[k] > areas[idx] && predictionRingContains(other, centroids[idx])));
  const paths = rings.map((ring) => {
    const smoothed = predictionChaikinClosed(ring, 3);
    const projected = smoothed.map(([gi, gj]) => project(field.minLon + (gi - field.pad) * field.cellW, field.minLat + (gj - field.pad) * field.cellH));
    return predictionClosedBezierPath(projected, 0.6);
  }).filter(Boolean).join(' ');
  if (!paths) return '';
  return `<g class="risk-level risk-${level.key}">
    <path d="${paths}" fill="${level.color}" fill-opacity="0.55" fill-rule="nonzero" stroke="${level.stroke}" stroke-opacity="0.85" stroke-width="1.4" stroke-linejoin="round"/>
  </g>`;
}

function drawPredictionImage(day, cells, periodKey = selectedPredictionPeriodKey) {
  const width = 860;
  const height = 760;
  const metrics = predictionProjectionMetrics(width, height);
  const project = metrics.project;
  const francePath = predictionFranceSvgPath(project);
  const period = predictionPeriodConfig(periodKey);
  const titleDate = period.key === 'day'
    ? predictionWindowDateLabel(day)
    : (typeof formatTimelineDateLabel === 'function' ? formatTimelineDateLabel(predictionDayKey(day)) : predictionDayKey(day));
  const levels = predictionLevelConfigs(cells);
  const field = predictionBuildScalarField(cells);
  const shapeMarkup = levels.map((level) => predictionContourLevelMarkup(field, project, level)).join('');
  const adminMarkup = predictionAdminLineMarkup(project);
  const regionBoundaryMarkup = predictionRegionBoundaryMarkup(project);
  const isMobileSvg = predictionLegendVariant() === 'm';

  let legendMarkup, svgHeight, legendY;
  if (isMobileSvg) {
    // 2 lignes de 3+2 items, fonts ×2.2 pour être lisibles à ~375px
    const levels = predictionExportLegendLevels();
    const perRow = 3;
    const colW = Math.floor((width - 76) / perRow);
    const rowH = 52;
    const rW = 40, rH = 18, rRx = 6, fSize = 22;
    legendMarkup = levels.map((level, i) => {
      const col = i % perRow;
      const row = Math.floor(i / perRow);
      return `<g transform="translate(${col * colW} ${row * rowH + 28})">
        <rect x="0" y="0" width="${rW}" height="${rH}" rx="${rRx}" fill="${level.color}" fill-opacity="0.92" stroke="#e2e8f0" stroke-opacity="0.16"/>
        <text x="${rW + 10}" y="${rH - 3}" fill="#cbd5e1" font-family="Inter, Arial, sans-serif" font-size="${fSize}" font-weight="800">${predictionEscapeXml(level.label)}</text>
      </g>`;
    }).join('');
    svgHeight = height + 70;
    legendY = height - 28;
  } else {
    legendMarkup = predictionExportLegendLevels().map((level, index) => {
      const x = index * 88;
      return `<g transform="translate(${x} 22)">
        <rect x="0" y="0" width="24" height="10" rx="5" fill="${level.color}" fill-opacity="0.92" stroke="#e2e8f0" stroke-opacity="0.16"/>
        <text x="31" y="9" fill="#cbd5e1" font-family="Inter, Arial, sans-serif" font-size="10.4" font-weight="800">${predictionEscapeXml(level.label)}</text>
      </g>`;
    }).join('');
    svgHeight = height;
    legendY = height - 62;
  }

  const legendTitleSize = isMobileSvg ? 24 : 11;
  const label = predictionEscapeXml(`${period.label} · ${titleDate}`);
  const svg = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${svgHeight}" width="${width}" height="${svgHeight}" role="img" aria-label="Prévision orageuse ${label}" shape-rendering="geometricPrecision">
  <defs>
    <clipPath id="franceClip" clipPathUnits="userSpaceOnUse"><path d="${francePath}"/></clipPath>
    <filter id="mapShadow" x="-14%" y="-14%" width="128%" height="128%" color-interpolation-filters="sRGB">
      <feDropShadow dx="0" dy="14" stdDeviation="14" flood-color="#000" flood-opacity="0.34"/>
    </filter>
  </defs>
  <rect width="${width}" height="${svgHeight}" fill="#07111f"/>
  <g filter="url(#mapShadow)">
    <path d="${francePath}" fill="${PREDICTION_RISK_LEVELS[0].color}"/>
    <g clip-path="url(#franceClip)">${shapeMarkup}</g>
    <g clip-path="url(#franceClip)">${adminMarkup}</g>
    <g clip-path="url(#franceClip)">${regionBoundaryMarkup}</g>
    <path d="${francePath}" fill="none" stroke="#020617" stroke-opacity="0.84" stroke-width="1.18" stroke-linejoin="round"/>
    <path d="${francePath}" fill="none" stroke="#7dd3fc" stroke-opacity="0.20" stroke-width="0.32" stroke-linejoin="round"/>
  </g>
  <g transform="translate(38 ${legendY})">
    <text x="0" y="0" fill="#dbeafe" fill-opacity="0.82" font-family="Inter, Arial, sans-serif" font-size="${legendTitleSize}" font-weight="900">PROBABILITÉ DE RISQUE ORAGEUX</text>
    ${legendMarkup}
  </g>
</svg>`;
  return `data:image/svg+xml;charset=UTF-8,${encodeURIComponent(svg)}`;
}

function predictionAreaForCell(cell, areas) {
  return (Array.isArray(areas) ? areas : []).find((area) => {
    const [minLon, maxLon, minLat, maxLat] = area.box;
    return cell.lon >= minLon && cell.lon <= maxLon && cell.lat >= minLat && cell.lat <= maxLat;
  }) || null;
}

function predictionAreaEntrySummary(entry, topShare = 0.18) {
  const score = Math.round(clampScore(predictionTopMean(entry.scores, Math.max(3, Math.round(entry.scores.length * topShare)))));
  const hourCounts = new Map();
  entry.hours.forEach((hour) => hourCounts.set(hour, (hourCounts.get(hour) || 0) + 1));
  const hours = predictionSortWindowHours(Array.from(hourCounts.entries()).sort((a, b) => b[1] - a[1]).slice(0, 4).map(([hour]) => hour));
  return {
    name: entry.name,
    score,
    category: predictionRiskLabel(score),
    cape: entry.cape.length ? Math.round(predictionMean(entry.cape)) : NaN,
    temperature: entry.temperature.length ? Math.round(predictionMean(entry.temperature) * 10) / 10 : NaN,
    dewpoint: entry.dewpoint.length ? Math.round(predictionMean(entry.dewpoint) * 10) / 10 : NaN,
    gusts: entry.gusts.length ? Math.round(Math.max(...entry.gusts, 0)) : NaN,
    hours,
  };
}

function predictionBuildAreaSummary(cells, areas, { topShare = 0.18 } = {}) {
  const map = new Map();
  cells.forEach((cell) => {
    const area = predictionAreaForCell(cell, areas);
    if (!area) return;
    const entry = map.get(area.name) || { name: area.name, cells: [], scores: [], cape: [], temperature: [], dewpoint: [], gusts: [], hours: [] };
    entry.cells.push(cell);
    entry.scores.push(predictionLayerScore(cell));
    if (Number.isFinite(cell.meanCape)) entry.cape.push(cell.meanCape);
    if (Number.isFinite(cell.meanTemperature)) entry.temperature.push(cell.meanTemperature);
    if (Number.isFinite(cell.meanDewpoint)) entry.dewpoint.push(cell.meanDewpoint);
    if (Number.isFinite(cell.maxGusts)) entry.gusts.push(cell.maxGusts);
    entry.hours.push(...(cell.bestHours || []));
    map.set(area.name, entry);
  });
  return Array.from(map.values())
    .map((entry) => predictionAreaEntrySummary(entry, topShare))
    .sort((a, b) => b.score - a.score);
}

function predictionRegionForCell(cell) {
  return predictionAreaForCell(cell, PREDICTION_REGIONS);
}

function predictionBuildRegionSummary(cells) {
  return predictionBuildAreaSummary(cells, PREDICTION_REGIONS, { topShare: 0.18 });
}

function predictionBuildLittoralSummary(cells) {
  return predictionBuildAreaSummary(cells, PREDICTION_LITTORALS, { topShare: 0.24 });
}

function predictionAreaBrief(area) {
  return `<strong>${area.name}</strong> ${area.category.toLowerCase()} (${area.score}/100, ${predictionHoursText(area.hours)})`;
}

function predictionBuildSectorSummary(cells) {
  const seen = new Set();
  return [
    ...predictionBuildRegionSummary(cells),
    ...predictionBuildLittoralSummary(cells),
  ]
    .sort((a, b) => b.score - a.score)
    .filter((area) => {
      const key = area.name.toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
}

function predictionBuildSectorHtml(sectors, periodText) {
  if (!sectors.length) return '';
  const active = sectors.filter((area) => area.score >= 65).slice(0, 5);
  if (!active.length) {
    return `<p><strong>Secteurs</strong> : signal très faible sur ${periodText}. Les meilleurs signaux restent ${sectors.slice(0, 4).map(predictionAreaBrief).join(', ')}.</p>`;
  }
  return `<p><strong>Secteurs</strong> : ${active.map(predictionAreaBrief).join(', ')}.</p>`;
}

function predictionHoursText(hours) {
  const sortedHours = predictionSortWindowHours(hours);
  if (!sortedHours.length) return 'horaire diffus';
  if (sortedHours.length === 1) return 'autour de ' + String(sortedHours[0]).padStart(2, '0') + 'h';
  return 'entre ' + String(sortedHours[0]).padStart(2, '0') + 'h et ' + String(sortedHours[sortedHours.length - 1]).padStart(2, '0') + 'h';
}

function predictionAreaIngredientText(area) {
  return [
    Number.isFinite(area.cape) && area.cape > 0 ? `CAPE ${area.cape} J/kg` : '',
    Number.isFinite(area.temperature) ? `T ${area.temperature} °C` : '',
    Number.isFinite(area.dewpoint) ? `rosée ${area.dewpoint} °C` : '',
    Number.isFinite(area.gusts) && area.gusts > 0 ? `rafales ${area.gusts} m/s` : '',
  ].filter(Boolean).join(' · ');
}

function predictionBuildAnalysisHtml(day, cells, periodKey = selectedPredictionPeriodKey) {
  const period = predictionPeriodConfig(periodKey);
  const sectors = predictionBuildSectorSummary(cells);
  const maxScore = Math.round(Math.max(...cells.map((cell) => predictionLayerScore(cell)), 0));
  const activeLevel = predictionRiskLevel(maxScore);
  const baseDateText = typeof formatTimelineDateLabel === 'function' ? formatTimelineDateLabel(predictionDayKey(day)) : predictionDayKey(day);
  const dateText = period.key === 'day' ? predictionWindowDateLabel(day) : baseDateText;
  const activeSectors = sectors.filter((area) => area.score >= 65).slice(0, 4);
  const quietText = !activeSectors.length
    ? 'Aucun secteur ne dépasse le seuil cartographié. La carte reste en fond très faible.'
    : activeSectors.map((area) => {
        const level = predictionRiskLevel(area.score);
        const ingredients = predictionAreaIngredientText(area);
        return `<div class="prediction-sector-chip" style="--risk-color:${level.color};--risk-stroke:${level.stroke}">
          <div>
            <strong>${predictionEscapeXml(area.name)}</strong>
            <span>${predictionEscapeXml(predictionHoursText(area.hours))}</span>
            ${ingredients ? `<em>${predictionEscapeXml(ingredients)}</em>` : ''}
          </div>
          <b>${Math.round(area.score)}</b>
        </div>`;
      }).join('');
  return `<div class="prediction-summary-hero" style="--risk-color:${activeLevel.color};--risk-stroke:${activeLevel.stroke}">
    <div>
      <span class="prediction-summary-kicker">${predictionEscapeXml(period.label)}</span>
      <strong>${predictionEscapeXml(activeLevel.label)}</strong>
      <em>${predictionEscapeXml(activeLevel.text)}</em>
    </div>
    <b>${maxScore}<small>/100</small></b>
  </div>
  <div class="prediction-analysis-block">
    <div class="prediction-analysis-block-title">Zones à surveiller</div>
    <div class="prediction-sector-list">${quietText}</div>
  </div>
  <p class="prediction-analysis-disclaimer">Synthèse automatique AROME France, informative et non officielle. La couleur traduit la probabilité orageuse agrégée sur la période sélectionnée.</p>`;
}

function generatePredictionPageImage(day = getCurrentDay(), periodKey = selectedPredictionPeriodKey) {
  const status = predictionDayStatus(day);
  const period = predictionPeriodConfig(periodKey);
  const periodStatus = predictionPeriodStatus(day, period.key);
  const requiredStatus = period.key === 'day' ? status : periodStatus;
  if (!requiredStatus.ready) {
    const scopeText = period.key === 'day' ? 'la fenêtre 08h-08h' : period.label.toLowerCase() + ' ' + period.rangeLabel;
    return { ok: false, status, periodStatus, periodKey: period.key, message: 'Image disponible quand ' + scopeText + ' AROME France est chargée : ' + requiredStatus.loadedCount + '/' + requiredStatus.totalCount + ' prêtes.' };
  }
  const cells = smoothPredictionCells(collectPredictionDailyCells(day, period.key));
  if (!cells.length) {
    return { ok: false, status, periodStatus, periodKey: period.key, message: 'Aucune cellule AROME France exploitable pour ' + period.label.toLowerCase() + '.' };
  }
  const dataUrl = drawPredictionImage(day, cells, period.key);
  const analysisHtml = predictionBuildAnalysisHtml(day, cells, period.key);
  const maxScore = Math.max(...cells.map((cell) => predictionLayerScore(cell)), 0);
  const sourceText = period.key === 'day'
    ? status.totalCount + '/24 heure(s) 08h-08h'
    : periodStatus.loadedCount + '/' + periodStatus.totalCount + ' heure(s) ' + period.rangeLabel;
  return {
    ok: true,
    status,
    periodStatus,
    periodKey: period.key,
    periodLabel: period.label,
    periodRange: period.rangeLabel,
    dayKey: predictionDayKey(day),
    dataUrl,
    analysisHtml,
    cells,
    maxScore,
    createdAt: new Date().toISOString(),
    message: 'Carte ' + period.label.toLowerCase() + ' prête · ' + sourceText + ' · max ' + Math.round(maxScore) + '/100.',
  };
}

function updatePredictionPeriodTabs(periodKey = selectedPredictionPeriodKey) {
  const period = predictionPeriodConfig(periodKey);
  if (typeof predictionPeriodButtons === 'undefined' || !predictionPeriodButtons) return;
  predictionPeriodButtons.forEach((button) => {
    const active = button.dataset.predictionPeriod === period.key;
    button.classList.toggle('active', active);
    button.setAttribute('aria-selected', active ? 'true' : 'false');
  });
}

function hidePredictionHover() {
  if (predictionHover) {
    predictionHover.hidden = true;
    predictionHover.innerHTML = '';
  }
  if (typeof predictionHighlight !== 'undefined' && predictionHighlight) {
    predictionHighlight.hidden = true;
    predictionHighlight.innerHTML = '';
  }
}

function predictionPointInsideFrance(lon, lat) {
  const rings = typeof FRANCE_GRID_CLIP_RINGS !== 'undefined' ? FRANCE_GRID_CLIP_RINGS : [];
  if (!rings.length || typeof pointInRing !== 'function') return true;
  return rings.some((ring) => pointInRing(lon, lat, ring));
}

function predictionImagePointerGeo(event) {
  if (!predictionImage || predictionImage.hidden) return null;
  const rect = predictionImage.getBoundingClientRect();
  if (!rect.width || !rect.height) return null;
  const x = ((event.clientX - rect.left) / rect.width) * 860;
  const y = ((event.clientY - rect.top) / rect.height) * 760;
  const metrics = predictionProjectionMetrics(860, 760);
  const geo = metrics.invert(x, y);
  if (!Number.isFinite(geo.lon) || !Number.isFinite(geo.lat)) return null;
  if (!predictionPointInsideFrance(geo.lon, geo.lat)) return null;
  return { ...geo, x, y, rect };
}

function predictionKnownPlaces() {
  return typeof SELECTION_CITY_REFERENCES !== 'undefined' && Array.isArray(SELECTION_CITY_REFERENCES)
    ? SELECTION_CITY_REFERENCES
    : [];
}

function predictionNearestKnownPlace(lat, lon) {
  const places = predictionKnownPlaces();
  let nearest = null;
  let nearestDistance = Infinity;
  places.forEach((place) => {
    const distance = predictionDistanceKm({ lat, lon }, place);
    if (distance < nearestDistance) {
      nearestDistance = distance;
      nearest = place;
    }
  });
  return nearest ? { ...nearest, distanceKm: nearestDistance } : null;
}

function predictionDepartmentRingForGeo(geo) {
  const rings = typeof FRANCE_DEPARTMENT_RINGS !== 'undefined' ? FRANCE_DEPARTMENT_RINGS : [];
  const lon = Number(geo?.lon);
  const lat = Number(geo?.lat);
  if (!Array.isArray(rings) || !rings.length || !Number.isFinite(lon) || !Number.isFinite(lat)) return null;
  if (typeof pointInRing === 'function') {
    const direct = rings.find((ring) => Array.isArray(ring) && pointInRing(lon, lat, ring));
    if (direct) return direct;
  }
  let nearest = null;
  let nearestDistance = Infinity;
  rings.forEach((ring) => {
    const centroid = predictionRingCentroid(ring);
    if (!centroid) return;
    const distance = predictionDistanceKm({ lon, lat }, centroid);
    if (distance < nearestDistance) {
      nearestDistance = distance;
      nearest = ring;
    }
  });
  return nearestDistance < 45 ? nearest : null;
}

function predictionKnownPlaceForDepartmentRing(ring, geo) {
  const places = predictionKnownPlaces();
  const lon = Number(geo?.lon);
  const lat = Number(geo?.lat);
  const candidates = typeof pointInRing === 'function'
    ? places.filter((place) => pointInRing(Number(place.lon), Number(place.lat), ring))
    : [];
  const pool = candidates.length ? candidates : places;
  let nearest = null;
  let nearestDistance = Infinity;
  pool.forEach((place) => {
    const distance = Number.isFinite(lon) && Number.isFinite(lat)
      ? predictionDistanceKm({ lon, lat }, place)
      : 0;
    if (distance < nearestDistance) {
      nearestDistance = distance;
      nearest = place;
    }
  });
  return nearest ? { ...nearest, distanceKm: nearestDistance, exactRing: candidates.length > 0 } : null;
}

function predictionDepartmentInfoForGeo(geo) {
  const ring = predictionDepartmentRingForGeo(geo);
  const nearest = ring ? predictionKnownPlaceForDepartmentRing(ring, geo) : predictionNearestKnownPlace(Number(geo?.lat), Number(geo?.lon));
  return {
    ring,
    department: nearest?.department || 'Département',
    city: nearest?.city || '',
    distanceKm: nearest?.distanceKm ?? Infinity,
    exactRing: !!nearest?.exactRing,
  };
}

function predictionAdministrativeInfoForCell(cell) {
  if (!cell) return predictionDepartmentInfoForGeo(null);
  if (!cell._predictionAdminInfo) cell._predictionAdminInfo = predictionDepartmentInfoForGeo(cell);
  return cell._predictionAdminInfo;
}

function predictionAdministrativeKey(info) {
  return `dept:${info?.department || 'departement'}`;
}

function predictionNearestCellToPoint(point, cells) {
  let nearest = null;
  let nearestDistance = Infinity;
  cells.forEach((cell) => {
    const distance = predictionDistanceKm(point, cell);
    if (distance < nearestDistance) {
      nearestDistance = distance;
      nearest = cell;
    }
  });
  return nearest ? { cell: nearest, distanceKm: nearestDistance } : null;
}

function predictionCellsForAdministrativeInfo(cells, targetInfo, point) {
  let selected = [];
  if (targetInfo?.ring && typeof pointInRing === 'function') {
    selected = cells.filter((cell) => pointInRing(Number(cell.lon), Number(cell.lat), targetInfo.ring));
    if (selected.length) return selected;
  }
  const targetKey = predictionAdministrativeKey(targetInfo);
  selected = cells.filter((cell) => predictionAdministrativeKey(predictionAdministrativeInfoForCell(cell)) === targetKey);
  if (selected.length >= 3) return selected;
  return cells
    .map((cell) => ({ cell, distance: predictionDistanceKm(point || cell, cell) }))
    .sort((a, b) => a.distance - b.distance)
    .slice(0, 8)
    .map((item) => item.cell);
}

function predictionSelectionLevelForScore(score) {
  const visualLevel = predictionLevelForScore(score, predictionAllLevelConfigs());
  if (visualLevel) return visualLevel;
  return {
    key: 'admin-below-threshold',
    label: predictionRiskLabel(score),
    threshold: 0,
    color: '#94a3b8',
    border: '#e2e8f0',
    margin: 28,
    blur: 4.2,
    expand: 1.16,
  };
}

function predictionHitZoneAtPoint(point, result = currentPredictionPageResult) {
  const cells = Array.isArray(result?.cells) ? result.cells : [];
  if (!cells.length || !point) return null;
  const nearest = predictionNearestCellToPoint(point, cells);
  const targetInfo = predictionDepartmentInfoForGeo(point);
  if (!targetInfo.ring) return null;
  const zoneCells = predictionCellsForAdministrativeInfo(cells, targetInfo, point);
  if (!zoneCells.length) return null;
  const scoreMax = Math.max(...zoneCells.map((cell) => predictionLayerScore(cell)), 0);
  const level = predictionSelectionLevelForScore(scoreMax);
  return {
    level,
    hit: nearest?.cell || zoneCells[0],
    hitIndex: 0,
    cells: zoneCells,
    admin: targetInfo,
    departmentRing: targetInfo.ring,
    selectionMode: 'department',
  };
}

function predictionMostCommonHours(cells) {
  const counts = new Map();
  cells.forEach((cell) => (cell.bestHours || []).forEach((hour) => counts.set(hour, (counts.get(hour) || 0) + 1)));
  const hours = Array.from(counts.entries())
    .sort((a, b) => b[1] - a[1] || predictionHourWindowOffset(a[0]) - predictionHourWindowOffset(b[0]))
    .slice(0, 4)
    .map(([hour]) => hour);
  return predictionSortWindowHours(hours);
}

function predictionZoneSummary(zone) {
  const cells = Array.isArray(zone?.cells) ? zone.cells : [];
  const scores = cells.map((cell) => predictionLayerScore(cell));
  const peaks = cells.map((cell) => Number(cell.peak)).filter(Number.isFinite);
  const means = cells.map((cell) => Number(cell.mean)).filter(Number.isFinite);
  const capes = cells.map((cell) => Number(cell.meanCape)).filter(Number.isFinite);
  const dews = cells.map((cell) => Number(cell.meanDewpoint)).filter(Number.isFinite);
  const scoreMax = Math.round(Math.max(...scores, 0));
  const admin = zone?.admin || {};
  return {
    department: admin.department || 'Département',
    city: admin.city || '',
    exactRing: !!admin.exactRing,
    levelLabel: predictionRiskLabel(scoreMax),
    cellCount: cells.length,
    scoreMean: Math.round(predictionMean(scores)),
    scoreMax,
    peakMean: Math.round(predictionMean(peaks)),
    dailyMean: Math.round(predictionMean(means)),
    capeMean: Math.round(predictionMean(capes)),
    dewMean: Math.round(predictionMean(dews) * 10) / 10,
    hours: predictionMostCommonHours(cells),
  };
}

function predictionHoverHtml(zone) {
  const summary = predictionZoneSummary(zone);
  const cityLine = summary.city ? `<div>Repère : ${predictionEscapeXml(summary.city)}</div>` : '';
  return `<div class="prediction-hover-title"><span>${predictionEscapeXml(summary.department)}</span><span class="prediction-hover-score">${summary.scoreMax}/100</span></div>
    <div class="prediction-hover-meta">
      <div><strong>${predictionEscapeXml(summary.levelLabel)}</strong> · maximum département (${summary.cellCount} cellule${summary.cellCount > 1 ? 's' : ''})</div>
      <div>Moyenne département ${summary.scoreMean}/100 · pic moyen ${summary.peakMean}/100 · moyenne jour ${summary.dailyMean}/100</div>
      <div>CAPE moyenne ${summary.capeMean || '-'} J/kg · rosée moyenne ${Number.isFinite(summary.dewMean) && summary.dewMean ? summary.dewMean + ' °C' : '-'}</div>
      <div>${predictionEscapeXml(predictionHoursText(summary.hours))}</div>
      ${cityLine}
    </div>`;
}

function predictionPositionOverlayToImage(element) {
  if (!element || !predictionImage) return;
  const panelRect = predictionImage.parentElement.getBoundingClientRect();
  const imageRect = predictionImage.getBoundingClientRect();
  element.style.left = `${imageRect.left - panelRect.left}px`;
  element.style.top = `${imageRect.top - panelRect.top}px`;
  element.style.width = `${imageRect.width}px`;
  element.style.height = `${imageRect.height}px`;
}

function predictionDepartmentRingPath(ring, project) {
  if (!Array.isArray(ring) || ring.length < 3) return '';
  return ring.map((point, index) => {
    const [x, y] = project(Number(point[0]), Number(point[1]));
    return `${index === 0 ? 'M' : 'L'}${x.toFixed(1)} ${y.toFixed(1)}`;
  }).join(' ') + ' Z';
}

function predictionHighlightSvg(zone) {
  const width = 860;
  const height = 760;
  const project = predictionProjector(width, height);
  const francePath = predictionFranceSvgPath(project);
  const departmentPath = predictionDepartmentRingPath(zone.departmentRing, project);
  if (!departmentPath) return '';
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" aria-hidden="true">
    <defs>
      <clipPath id="predictionHoverClip"><path d="${francePath}"/></clipPath>
      <filter id="predictionDeptGlow" x="-8%" y="-8%" width="116%" height="116%" color-interpolation-filters="sRGB">
        <feDropShadow dx="0" dy="0" stdDeviation="4" flood-color="#f8fafc" flood-opacity="0.46"/>
      </filter>
    </defs>
    <g clip-path="url(#predictionHoverClip)" filter="url(#predictionDeptGlow)">
      <path d="${departmentPath}" fill="${zone.level.color}" fill-opacity="0.22" stroke="#f8fafc" stroke-opacity="0.92" stroke-width="2.2" stroke-linejoin="round"/>
      <path d="${departmentPath}" fill="none" stroke="#020617" stroke-opacity="0.88" stroke-width="0.9" stroke-linejoin="round"/>
    </g>
  </svg>`;
}

function updatePredictionHighlight(zone) {
  if (typeof predictionHighlight === 'undefined' || !predictionHighlight) return;
  if (!zone || !zone.cells?.length) {
    predictionHighlight.hidden = true;
    predictionHighlight.innerHTML = '';
    return;
  }
  predictionPositionOverlayToImage(predictionHighlight);
  predictionHighlight.innerHTML = predictionHighlightSvg(zone);
  predictionHighlight.hidden = false;
}

function movePredictionHover(event) {
  if (!predictionHover || !currentPredictionPageResult?.ok) return;
  const point = predictionImagePointerGeo(event);
  const zone = point ? predictionHitZoneAtPoint(point) : null;
  if (!zone) {
    hidePredictionHover();
    return;
  }
  const panelRect = predictionImage.parentElement.getBoundingClientRect();
  const x = Math.max(8, Math.min(panelRect.width - 270, event.clientX - panelRect.left + 14));
  const y = Math.max(8, Math.min(panelRect.height - 136, event.clientY - panelRect.top + 14));
  predictionHover.style.left = `${x}px`;
  predictionHover.style.top = `${y}px`;
  predictionHover.innerHTML = predictionHoverHtml(zone);
  predictionHover.hidden = false;
}

function initPredictionHover() {
  if (!predictionImage || !predictionHover || predictionImage.dataset.hoverReady === '1') return;
  predictionImage.dataset.hoverReady = '1';
  predictionImage.addEventListener('pointermove', movePredictionHover);
  predictionImage.addEventListener('pointerleave', hidePredictionHover);
  predictionImage.addEventListener('pointercancel', hidePredictionHover);
}


function renderPredictionPageResult(result) {
  if (!predictionPage || !predictionAnalysisText || !predictionImage) return;
  currentPredictionPageResult = result?.ok ? result : null;
  if (typeof predictionDownloadBtn !== 'undefined' && predictionDownloadBtn) predictionDownloadBtn.disabled = !result?.ok;
  if (!result?.ok) hidePredictionHover();
  const period = predictionPeriodConfig(result?.periodKey || selectedPredictionPeriodKey);
  updatePredictionPeriodTabs(period.key);
  if (typeof predictionImageStatus !== 'undefined' && predictionImageStatus) {
    predictionImageStatus.textContent = result?.message || 'Préparation de la carte…';
    predictionImageStatus.classList.toggle('is-ready', !!result?.ok);
    predictionImageStatus.classList.toggle('is-waiting', !result?.ok);
  }
  if (typeof predictionPageTitle !== 'undefined' && predictionPageTitle) {
    predictionPageTitle.textContent = period.key === 'day'
      ? 'Carte de risque journalier'
      : `Carte de risque · ${period.label}`;
  }
  if (predictionPageSubtitle) {
    const dateText = period.key === 'day'
      ? predictionWindowDateLabel(getCurrentDay())
      : (typeof formatTimelineDateLabel === 'function' ? formatTimelineDateLabel(predictionDayKey(getCurrentDay())) : predictionDayKey(getCurrentDay()));
    const periodText = period.key === 'day' ? 'fenêtre 08h-08h AROME France' : 'grilles ' + period.rangeLabel + ' AROME France';
    predictionPageSubtitle.textContent = result?.ok
      ? 'Image générée depuis la ' + periodText + ' en cache · ' + dateText
      : 'En attente des grilles AROME France · ' + dateText;
  }
  if (result?.ok && result.dataUrl) {
    predictionImage.src = result.dataUrl;
    predictionImage.alt = `Carte de prévision orageuse ${period.label.toLowerCase()} ${result.dayKey || ''}`.trim();
    predictionImage.hidden = false;
    initPredictionHover();
    predictionAnalysisText.innerHTML = result.analysisHtml || '';
  } else {
    predictionImage.hidden = true;
    hidePredictionHover();
    predictionAnalysisText.textContent = result?.message || 'La synthèse sera disponible quand la fenêtre 08h-08h sera chargée.';
  }
}

function predictionDownloadFilename(result = currentPredictionPageResult) {
  const dayKey = result?.dayKey || predictionDayKey(getCurrentDay());
  const period = predictionPeriodConfig(result?.periodKey || selectedPredictionPeriodKey);
  return `objectifoudre-prevision-${dayKey}-${period.key}.png`;
}

function predictionExportLegendLevels() {
  return PREDICTION_RISK_LEVELS.filter((level) => Number(level.min) >= 65);
}

function predictionLoadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = src;
  });
}

function predictionCanvasRoundRect(ctx, x, y, width, height, radius = 16) {
  const r = Math.min(radius, width / 2, height / 2);
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + width, y, x + width, y + height, r);
  ctx.arcTo(x + width, y + height, x, y + height, r);
  ctx.arcTo(x, y + height, x, y, r);
  ctx.arcTo(x, y, x + width, y, r);
  ctx.closePath();
}

function predictionCanvasPanel(ctx, x, y, width, height, radius = 18, fill = '#07111f', stroke = 'rgba(148, 163, 184, 0.18)') {
  predictionCanvasRoundRect(ctx, x, y, width, height, radius);
  ctx.fillStyle = fill;
  ctx.fill();
  if (stroke) {
    ctx.strokeStyle = stroke;
    ctx.lineWidth = 1;
    ctx.stroke();
  }
}

function predictionCanvasWrapText(ctx, text, x, y, maxWidth, lineHeight, maxLines = Infinity) {
  const clean = String(text || '').replace(/\s+/g, ' ').trim();
  if (!clean) return y;
  const words = clean.split(' ');
  let line = '';
  let lines = [];
  words.forEach((word) => {
    const test = line ? line + ' ' + word : word;
    if (ctx.measureText(test).width > maxWidth && line) {
      lines.push(line);
      line = word;
    } else {
      line = test;
    }
  });
  if (line) lines.push(line);
  if (lines.length > maxLines) {
    lines = lines.slice(0, maxLines);
    lines[lines.length - 1] = lines[lines.length - 1].replace(/[,. ]+$/, '') + '...';
  }
  lines.forEach((item, index) => ctx.fillText(item, x, y + index * lineHeight));
  return y + lines.length * lineHeight;
}

function predictionExportSummary(result) {
  const period = predictionPeriodConfig(result?.periodKey || selectedPredictionPeriodKey);
  const day = predictionDayByKey(result?.dayKey || predictionDayKey(getCurrentDay())) || getCurrentDay();
  const titleDate = period.key === 'day'
    ? predictionWindowDateLabel(day)
    : (typeof formatTimelineDateLabel === 'function' ? formatTimelineDateLabel(result?.dayKey || predictionDayKey(day)) : (result?.dayKey || predictionDayKey(day)));
  const cells = Array.isArray(result?.cells) ? result.cells : [];
  const maxScore = Math.round(Number(result?.maxScore ?? Math.max(...cells.map((cell) => predictionLayerScore(cell)), 0)) || 0);
  const level = predictionRiskLevel(maxScore);
  const sectors = predictionBuildSectorSummary(cells);
  const lead = sectors[0] || null;
  const watchSectors = sectors.filter((area) => area.score >= 65).slice(0, 4);
  return { period, titleDate, maxScore, level, sectors, lead, watchSectors };
}

async function predictionBuildCompositePngBlob(result) {
  const mapImage = await predictionLoadImage(result.dataUrl);
  const scale = 2;
  const width = 1440;
  const height = 900;
  const canvas = document.createElement('canvas');
  canvas.width = width * scale;
  canvas.height = height * scale;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('canvas unavailable');
  ctx.scale(scale, scale);
  ctx.fillStyle = '#07111f';
  ctx.fillRect(0, 0, width, height);

  const summary = predictionExportSummary(result);
  ctx.fillStyle = '#f8fafc';
  ctx.font = '900 30px Inter, Arial, sans-serif';
  ctx.fillText('ObjectiFoudre', 36, 42);
  ctx.fillStyle = '#a7f3d0';
  ctx.font = '800 12px Inter, Arial, sans-serif';
  ctx.fillText('PRÉVISIONS ORAGEUSES', 36, 66);
  ctx.fillStyle = 'rgba(226, 232, 240, 0.78)';
  ctx.font = '600 16px Inter, Arial, sans-serif';
  ctx.fillText(`${summary.period.label} · ${summary.titleDate}`, 214, 66);

  const mapPanel = { x: 32, y: 92, w: 900, h: 760 };
  const sidePanel = { x: 956, y: 92, w: 452, h: 760 };
  predictionCanvasPanel(ctx, mapPanel.x, mapPanel.y, mapPanel.w, mapPanel.h, 18, '#081220', 'rgba(148, 163, 184, 0.22)');
  predictionCanvasPanel(ctx, sidePanel.x, sidePanel.y, sidePanel.w, sidePanel.h, 18, '#081220', 'rgba(148, 163, 184, 0.22)');

  const imageRatio = (mapImage.naturalWidth || 860) / (mapImage.naturalHeight || 760);
  const fitW = mapPanel.w - 28;
  const fitH = mapPanel.h - 28;
  let drawW = fitW;
  let drawH = drawW / imageRatio;
  if (drawH > fitH) {
    drawH = fitH;
    drawW = drawH * imageRatio;
  }
  const drawX = mapPanel.x + (mapPanel.w - drawW) / 2;
  const drawY = mapPanel.y + (mapPanel.h - drawH) / 2;
  predictionCanvasRoundRect(ctx, drawX, drawY, drawW, drawH, 16);
  ctx.save();
  ctx.clip();
  ctx.drawImage(mapImage, drawX, drawY, drawW, drawH);
  ctx.restore();

  let y = sidePanel.y + 32;
  const sx = sidePanel.x + 28;
  const sw = sidePanel.w - 56;
  ctx.fillStyle = '#a7f3d0';
  ctx.font = '900 14px Inter, Arial, sans-serif';
  ctx.fillText('SITUATION ATTENDUE', sx, y);
  y += 24;

  ctx.fillStyle = 'rgba(226, 232, 240, 0.78)';
  ctx.font = '700 14px Inter, Arial, sans-serif';
  predictionCanvasWrapText(ctx, `Synthèse ${summary.level.label.toLowerCase()} · ${summary.maxScore}/100. ${summary.level.text}`, sx, y, sw, 18, 3);
  y += 72;

  ctx.fillStyle = '#e2e8f0';
  ctx.font = '900 12px Inter, Arial, sans-serif';
  ctx.fillText('ZONES À SURVEILLER', sx, y);
  y += 18;
  const sectors = summary.watchSectors;
  sectors.slice(0, 4).forEach((area) => {
    const level = predictionRiskLevel(area.score);
    const ingredients = predictionAreaIngredientText(area);
    predictionCanvasPanel(ctx, sx, y, sw, 72, 12, predictionHexToRgba(level.color, 0.13), predictionHexToRgba(level.stroke, 0.62));
    ctx.fillStyle = '#f8fafc';
    ctx.font = '900 14px Inter, Arial, sans-serif';
    ctx.fillText(area.name, sx + 14, y + 21);
    ctx.fillStyle = 'rgba(203, 213, 225, 0.72)';
    ctx.font = '600 12px Inter, Arial, sans-serif';
    ctx.fillText(predictionHoursText(area.hours), sx + 14, y + 39);
    if (ingredients) {
      ctx.fillStyle = 'rgba(226, 232, 240, 0.68)';
      ctx.font = '700 11px Inter, Arial, sans-serif';
      predictionCanvasWrapText(ctx, ingredients, sx + 14, y + 57, sw - 84, 14, 1);
    }
    ctx.fillStyle = level.color;
    ctx.font = '900 22px Inter, Arial, sans-serif';
    ctx.textAlign = 'right';
    ctx.fillText(String(Math.round(area.score)), sx + sw - 14, y + 40);
    ctx.textAlign = 'left';
    y += 80;
  });
  if (!sectors.length) {
    ctx.fillStyle = 'rgba(203, 213, 225, 0.76)';
    ctx.font = '600 14px Inter, Arial, sans-serif';
    y = predictionCanvasWrapText(ctx, 'Aucune zone ne dépasse le seuil cartographié.', sx, y + 10, sw, 20, 2) + 18;
  }

  ctx.fillStyle = 'rgba(148, 163, 184, 0.72)';
  ctx.font = '600 11px Inter, Arial, sans-serif';
  ctx.fillText('Synthèse automatique AROME France, informative et non officielle.', sx, sidePanel.y + sidePanel.h - 14);

  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => blob ? resolve(blob) : reject(new Error('png export failed')), 'image/png', 0.96);
  });
}

async function downloadPredictionPageImage() {
  const result = currentPredictionPageResult;
  if (!result?.ok || !result.dataUrl) return;
  if (typeof predictionDownloadBtn !== 'undefined' && predictionDownloadBtn) predictionDownloadBtn.disabled = true;
  const finish = () => {
    if (typeof predictionDownloadBtn !== 'undefined' && predictionDownloadBtn) predictionDownloadBtn.disabled = false;
  };
  try {
    const blob = await predictionBuildCompositePngBlob(result);
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = predictionDownloadFilename(result);
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1500);
  } catch (_) {
    const link = document.createElement('a');
    link.href = result.dataUrl;
    link.download = predictionDownloadFilename(result).replace(/\.png$/, '.svg');
    document.body.appendChild(link);
    link.click();
    link.remove();
  } finally {
    finish();
  }
}

function ensurePredictionPageImage(day = getCurrentDay(), { force = false, periodKey = selectedPredictionPeriodKey } = {}) {
  const period = predictionPeriodConfig(periodKey);
  const key = predictionCacheKey(day, period.key);
  if (!force && PREDICTION_IMAGE_CACHE.has(key)) return PREDICTION_IMAGE_CACHE.get(key);
  const result = generatePredictionPageImage(day, period.key);
  if (result.ok) PREDICTION_IMAGE_CACHE.set(key, result);
  return result;
}

async function hydratePredictionPeriodFromServerCache(day = getCurrentDay(), periodKey = selectedPredictionPeriodKey) {
  const period = predictionPeriodConfig(periodKey);
  let status = period.key === 'day' ? predictionDayStatus(day) : predictionPeriodStatus(day, period.key);
  if (status.ready) return status;
  if (typeof fetch !== 'function' || typeof mergeMeteoFranceSlotPayload !== 'function') return status;
  const missingKeys = status.missingKeys.slice();
  const token = '';
  for (const slotKey of missingKeys) {
    const hour = predictionSlotHour(slotKey);
    if (!Number.isFinite(hour)) continue;
    const dateKey = predictionSlotDateKeyForHour(hour, day);
    const baseBody = {
      lat: currentCenter?.lat ?? 46.65,
      lon: currentCenter?.lon ?? 2.45,
      label: currentCenter?.label || 'France entière',
      date: dateKey,
      hour,
      detail_level: 'core',
      cache_only: true,
    };
    const body = typeof withMeteoFranceToken === 'function' ? withMeteoFranceToken(baseBody, token) : baseBody;
    try {
      const response = await fetch('/api/meteofrance/grib-france-slot-grid-cache', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const data = await response.json().catch(() => ({}));
      if (typeof syncMeteoFranceQuotaCooldown === 'function') syncMeteoFranceQuotaCooldown(data);
      if (!data?.ok || !data?.payload) continue;
      mergeMeteoFranceSlotPayload(data.payload, hour);
    } catch (_) {}
  }
  return period.key === 'day' ? predictionDayStatus(day) : predictionPeriodStatus(day, period.key);
}

async function setPredictionPeriod(periodKey = 'day') {
  const period = predictionPeriodConfig(periodKey);
  selectedPredictionPeriodKey = period.key;
  updatePredictionPeriodTabs(period.key);
  if (predictionPage?.getAttribute('aria-hidden') === 'false') {
    let day = getCurrentDay();
    renderPredictionPageResult({ ok: false, periodKey: period.key, message: 'Préparation de la synthèse ' + period.label.toLowerCase() + '…' });
    await hydratePredictionPeriodFromServerCache(day, period.key);
    day = getCurrentDay();
    renderPredictionPageResult(ensurePredictionPageImage(day, { periodKey: period.key }));
  }
}

function initPredictionPeriodTabs() {
  if (typeof predictionPeriodButtons === 'undefined' || !predictionPeriodButtons) return;
  predictionPeriodButtons.forEach((button) => {
    button.addEventListener('click', () => setPredictionPeriod(button.dataset.predictionPeriod || 'day'));
  });
  updatePredictionPeriodTabs(selectedPredictionPeriodKey);
}

initPredictionPeriodTabs();
initPredictionHover();
if (typeof predictionDownloadBtn !== 'undefined' && predictionDownloadBtn) {
  predictionDownloadBtn.addEventListener('click', downloadPredictionPageImage);
}

async function openPredictionPage() {
  if (!predictionPage) return;
  predictionPage.setAttribute('aria-hidden', 'false');
  renderPredictionPageResult({ ok: false, periodKey: selectedPredictionPeriodKey, message: 'Préparation de la synthèse Prédictions…' });
  let day = getCurrentDay();
  let status = predictionDayStatus(day);
  if (!status.ready && typeof materializeMeteoFranceGribFranceDayFromNationalCache === 'function') {
    renderPredictionPageResult({ ok: false, periodKey: selectedPredictionPeriodKey, message: 'Hydratation des grilles déjà en cache : ' + status.loadedCount + '/' + status.totalCount + ' prêtes…' });
    try { await materializeMeteoFranceGribFranceDayFromNationalCache({ force: false, quiet: true }); } catch (_) {}
    day = getCurrentDay();
    status = predictionDayStatus(day);
  }
  if (!predictionPeriodStatus(day, selectedPredictionPeriodKey).ready) {
    const period = predictionPeriodConfig(selectedPredictionPeriodKey);
    const periodStatus = predictionPeriodStatus(day, period.key);
    renderPredictionPageResult({ ok: false, periodKey: period.key, message: 'Hydratation cache serveur ' + period.rangeLabel + ' : ' + periodStatus.loadedCount + '/' + periodStatus.totalCount + ' prêtes…' });
    await hydratePredictionPeriodFromServerCache(day, period.key);
    day = getCurrentDay();
  }
  const result = ensurePredictionPageImage(day, { periodKey: selectedPredictionPeriodKey });
  renderPredictionPageResult(result);

}

function closePredictionPage() {
  if (!predictionPage) return;
  predictionPage.setAttribute('aria-hidden', 'true');
  hidePredictionHover();
}


function maybePrecomputePredictionPageImage(day = getCurrentDay()) {
  const status = predictionDayStatus(day);
  if (!status.ready) return;
  const pending = PREDICTION_PERIODS
    .map((period) => ({ period, key: predictionCacheKey(day, period.key) }))
    .filter((item) => !PREDICTION_IMAGE_CACHE.has(item.key) && !PREDICTION_IMAGE_PREWARMING.has(item.key));
  if (!pending.length) return;
  pending.forEach((item) => PREDICTION_IMAGE_PREWARMING.add(item.key));
  const run = () => {
    try {
      pending.forEach((item) => ensurePredictionPageImage(day, { periodKey: item.period.key }));
      if (predictionPage?.getAttribute('aria-hidden') === 'false') {
        renderPredictionPageResult(ensurePredictionPageImage(day, { periodKey: selectedPredictionPeriodKey }));
      }
    } finally {
      pending.forEach((item) => PREDICTION_IMAGE_PREWARMING.delete(item.key));
    }
  };
  if (typeof requestIdleCallback === 'function') requestIdleCallback(run, { timeout: 1200 });
  else setTimeout(run, 80);
}

// Si le viewport franchit le seuil mobile/desktop pendant que la carte est ouverte,
// la légende gravée dans le SVG ne correspond plus : on régénère (nouveau variant de
// clé → cache hit ou génération) et on réaffiche. Ne fait rien hors franchissement.
let predictionLegendVariantCurrent = predictionLegendVariant();
function handlePredictionViewportChange() {
  const variant = predictionLegendVariant();
  if (variant === predictionLegendVariantCurrent) return;
  predictionLegendVariantCurrent = variant;
  if (predictionPage?.getAttribute('aria-hidden') === 'false') {
    renderPredictionPageResult(ensurePredictionPageImage(getCurrentDay(), { periodKey: selectedPredictionPeriodKey }));
  }
}
window.addEventListener('resize', handlePredictionViewportChange, { passive: true });
window.addEventListener('orientationchange', handlePredictionViewportChange, { passive: true });

window.openPredictionPage = openPredictionPage;
window.closePredictionPage = closePredictionPage;
window.maybePrecomputePredictionPageImage = maybePrecomputePredictionPageImage;
window.setPredictionPeriod = setPredictionPeriod;
window.downloadPredictionPageImage = downloadPredictionPageImage;
