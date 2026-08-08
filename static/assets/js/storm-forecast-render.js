// storm-forecast-render.js — issu du découpage de storm-forecast-image.js (Phase 3).
// Géométrie, projection, contours marching-squares, sévérité, drawPredictionImage, SVG, analyse.
function collectPredictionDailyCells(day = getCurrentDay(), periodKey = 'day') {
  // Tendance ECMWF : un seul créneau quotidien, pas de logique de période.
  if (predictionDayIsTrend(day)) return predictionTrendDailyCells(day);
  if (periodKey === 'day') return predictionDayCellsFromPeriods(day);
  const grouped = new Map();
  const period = predictionPeriodConfig(periodKey);
  const slots = predictionPeriodLoadedSlots(day, period.key);
  slots.forEach((slot) => {
    const hour = Number(String(slot.slot_key || '').replace('h', ''));
    (slot.cells || []).forEach((cell) => {
      if (cell?.source_provider !== 'meteofrance_arome_grib' && cell?.source_provider !== PREDICTION_ECMWF_SLOTS_PROVIDER) return;
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
    const activeCount = entry.scores.filter((score) => score >= 60).length;
    const confidenceMean = predictionMean(entry.confidence);
    // Score PIC-DOMINANT : une carte de RISQUE doit refléter le pic atteint dans la
    // période (« quel est le pire moment ici ? »), pas une moyenne qui dilue les
    // pics brefs avec les heures calmes. topMean (meilleures heures) robustifie
    // contre un pic d'une seule heure isolée. Comme topMean ≤ pic, le score est
    // toujours ≤ pic : une cellule ne se colore que si son pic est réellement élevé.
    let score = (topMean * 0.65) + (peak * 0.35);
    // Petit bonus de persistance : un orage soutenu (≥ 3 h cartographiées) est plus
    // certain qu'un pic isolé.
    if (activeCount >= 3) score += Math.min(4, activeCount * 0.8);
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
  const radiusKm = 60;
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
      <g stroke="#020617" stroke-opacity="0.72" stroke-width="1.7">${paths}</g>
      <g stroke="#7dd3fc" stroke-opacity="0.42" stroke-width="0.62">${paths}</g>
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
    <g stroke="#020617" stroke-opacity="0.72" stroke-width="1.7">${paths}</g>
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
    <g stroke="#020617" stroke-opacity="0.72" stroke-width="2.8">${paths}</g>
    <g stroke="#7dd3fc" stroke-opacity="0.72" stroke-width="1.3">${paths}</g>
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
// ~60 km à sa valeur (combinés par max), PUIS en floutant le tout. Le disque large
// est un plateau robuste : le flou n'efface pas le signal mais arrondit ses bords,
// de sorte que le contour iso devient un ovale lisse façon atlas météo — au lieu de
// suivre les bords durs des disques (effet "carrés arrondis" à la résolution
// cellule). Les clusters réels survivent ; les cellules isolées limites s'effacent
// (bon filtrage de bruit, renforcé par le seuil d'aire des contours).
const PREDICTION_FIELD_RADIUS_KM = 60;
const PREDICTION_FIELD_SMOOTH_PASSES = 3;
// Subdivision : la grille de CONTOUR est plus fine que le maillage des données
// (15 km). On découple les deux : le champ reste dérivé du 15 km, mais on le trace
// sur une grille ~7,5 km → le contour a 2× plus de sommets, donc des courbes bien
// plus fluides et organiques (formes moins « chunky » à la résolution cellule).
const PREDICTION_FIELD_SUBDIV = 2;
// Masse minimale d'une zone : nombre de cellules réellement ≥ seuil qu'un contour
// doit contenir pour être dessiné. En-dessous, c'est une tache isolée non
// significative — un prévisionniste ne dessinerait jamais de zone autour. C'est ce
// critère (et non le rayon) qui distingue une zone d'orages cohérente d'un point.
const PREDICTION_MIN_ZONE_CELLS = 4;

function predictionGridBlur(grid, rows, cols, passes) {
  let src = grid;
  for (let p = 0; p < passes; p += 1) {
    const dst = Array.from({ length: rows }, () => new Float64Array(cols));
    for (let j = 0; j < rows; j += 1) {
      for (let i = 0; i < cols; i += 1) {
        let sum = 0;
        let n = 0;
        for (let dj = -1; dj <= 1; dj += 1) {
          for (let di = -1; di <= 1; di += 1) {
            const jj = j + dj;
            const ii = i + di;
            if (jj < 0 || jj >= rows || ii < 0 || ii >= cols) continue;
            sum += src[jj][ii];
            n += 1;
          }
        }
        dst[j][i] = n ? sum / n : 0;
      }
    }
    src = dst;
  }
  return src;
}

function predictionBuildScalarField(cells, valueFn = predictionLayerScore) {
  const b = predictionBounds();
  const cellW = predictionMedian(cells.map((c) => Number(c.cellWidthDeg || c.cell_width_deg))) || 0.16;
  const cellH = predictionMedian(cells.map((c) => Number(c.cellHeightDeg || c.cell_height_deg))) || 0.16;
  // Pas de la grille de contour = pas des données / subdivision (grille plus fine).
  const stepW = cellW / PREDICTION_FIELD_SUBDIV;
  const stepH = cellH / PREDICTION_FIELD_SUBDIV;
  const radiusNodes = Math.max(1.4, PREDICTION_FIELD_RADIUS_KM / (stepH * 111));
  const reach = Math.ceil(radiusNodes);
  // À grille plus fine, on multiplie les passes de flou par SUBDIV² pour conserver
  // le MÊME lissage en km (un flou de N nœuds couvre N×pas, donc moins de km si le
  // pas rétrécit).
  const blurPasses = PREDICTION_FIELD_SMOOTH_PASSES * PREDICTION_FIELD_SUBDIV * PREDICTION_FIELD_SUBDIV;
  // Bordure de zéros (padding ≥ portée des disques + flou) : garantit qu'aucune zone
  // ne touche le bord de la grille, donc tout contour se referme à l'intérieur. Sans
  // ça, une zone atteignant le nord de la France (~51,2°N = bord) restait ouverte
  // et était jetée → carte vide sur la journée entière.
  const pad = reach + blurPasses + 1;
  const cols = Math.max(2, Math.round((b.maxLon - b.minLon) / stepW) + 1) + pad * 2;
  const rows = Math.max(2, Math.round((b.maxLat - b.minLat) / stepH) + 1) + pad * 2;
  let grid = Array.from({ length: rows }, () => new Float64Array(cols));
  cells.forEach((cell) => {
    const cs = valueFn(cell);
    if (cs <= 0) return;
    const ci = Math.round((Number(cell.lon) - b.minLon) / stepW) + pad;
    const cj = Math.round((Number(cell.lat) - b.minLat) / stepH) + pad;
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
  grid = predictionGridBlur(grid, rows, cols, blurPasses);
  // On renvoie le PAS fin comme cellW/cellH : tout le reste (contour→lon/lat,
  // comptage de cellules) projette correctement depuis ce pas.
  return { grid, rows, cols, minLon: b.minLon, minLat: b.minLat, cellW: stepW, cellH: stepH, pad };
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

function predictionContourLevelMarkup(field, project, level, cells) {
  let rings = predictionMarchingSquaresRings(field, level.threshold)
    // anti-bruit : ignore les contours minuscules (< ~1,4 cellule de grille)
    .filter((ring) => predictionPolygonArea(ring) >= 1.4);
  if (!rings.length) return '';
  // Retire les anneaux internes (trous) : on ne veut pas affirmer « pas de risque
  // ici » au milieu d'une zone — la prévision orageuse est trop incertaine pour ça.
  const areas = rings.map(predictionPolygonArea);
  const centroids = rings.map(predictionRingCentroidPt);
  rings = rings.filter((ring, idx) => !rings.some((other, k) => k !== idx && areas[k] > areas[idx] && predictionRingContains(other, centroids[idx])));
  // Critère de signifiance (logique prévisionniste) : une zone n'est dessinée que si
  // elle contient au moins PREDICTION_MIN_ZONE_CELLS cellules réellement ≥ seuil.
  // En-dessous, c'est une tache isolée non significative — on ne la dessine pas.
  const sigPts = (Array.isArray(cells) ? cells : [])
    .filter((c) => predictionLayerScore(c) >= level.threshold)
    .map((c) => [(Number(c.lon) - field.minLon) / field.cellW + field.pad, (Number(c.lat) - field.minLat) / field.cellH + field.pad]);
  rings = rings.filter((ring) => {
    let minX = Infinity;
    let maxX = -Infinity;
    let minY = Infinity;
    let maxY = -Infinity;
    for (const p of ring) {
      if (p[0] < minX) minX = p[0];
      if (p[0] > maxX) maxX = p[0];
      if (p[1] < minY) minY = p[1];
      if (p[1] > maxY) maxY = p[1];
    }
    let count = 0;
    for (const s of sigPts) {
      if (s[0] < minX || s[0] > maxX || s[1] < minY || s[1] > maxY) continue;
      if (predictionRingContains(ring, s)) {
        count += 1;
        if (count >= PREDICTION_MIN_ZONE_CELLS) return true;
      }
    }
    return false;
  });
  if (!rings.length) return '';
  const paths = rings.map((ring) => {
    const smoothed = predictionChaikinClosed(ring, 2);   // perf : 2 passes suffisent (−28% de poids SVG, rendu identique à l'échelle d'affichage)
    const projected = smoothed.map(([gi, gj]) => project(field.minLon + (gi - field.pad) * field.cellW, field.minLat + (gj - field.pad) * field.cellH));
    return predictionClosedBezierPath(projected, 0.6);
  }).filter(Boolean).join(' ');
  if (!paths) return '';
  return `<g class="risk-level risk-${level.key}">
    <path d="${paths}" fill="${level.color}" fill-opacity="0.55" fill-rule="nonzero" stroke="${level.stroke}" stroke-opacity="0.85" stroke-width="1.4" stroke-linejoin="round"/>
  </g>`;
}

// --- Sévérité orageuse J0 : hachures (probabilité × intensité) ---
// La COULEUR de la carte rend la PROBABILITÉ orageuse. Les hachures ajoutent, pour
// la journée J0 uniquement, une lecture de la SÉVÉRITÉ : on ne hachure que les zones
// où le risque combine une forte probabilité ET une forte intensité potentielle
// (CAPE + rafales) — soit un orage potentiellement violent, distinct d'un simple
// orage probable mais mou. Décision produit : « combiné probabilité × intensité ».
const PREDICTION_SEVERITY_THRESHOLD = 52;   // indice combiné 0-100, seuil de hachurage (jours horaires AROME/ARPEGE)
// La tendance ECMWF (J+4+) a des CAPE quotidiennes plus généreuses sur grille plus large
// → seuil rehaussé pour ne hachurer que le vrai cœur sévère (sinon presque tout est hachuré).
const PREDICTION_SEVERITY_THRESHOLD_TREND = 75;
const PREDICTION_SEVERITY_MIN_PROB = 60;    // pas de sévérité sous le seuil orageux cartographié
// Couleur des hachures de sévérité : jaune/orange clair — clair (donc distinct des traits
// SOMBRES du territoire/des départements) et bien visible sur les zones colorées où les
// hachures apparaissent.
const PREDICTION_SEVERITY_HATCH_COLOR = '#fde68a';
function predictionCellSeverity(cell) {
  if (!cell) return 0;
  const prob = clampScore(predictionLayerScore(cell));
  if (prob < PREDICTION_SEVERITY_MIN_PROB) return 0; // orage peu probable → pas de sévérité
  // Intensité potentielle, normalisée en 0-100 :
  //  - CAPE : 2500 J/kg ≈ énergie convective très forte (potentiel grêle / forte pluie)
  //  - rafales 10 m : 40 km/h (base) → 100 km/h (rafale orageuse violente)
  const cape = Number(cell.meanCape);
  const gusts = Number(cell.maxGusts);
  const capeIdx = Number.isFinite(cape) ? clampScore((cape / 2500) * 100) : 0;
  const gustIdx = Number.isFinite(gusts) ? clampScore(((gusts - 40) / 60) * 100) : 0;
  const intensity = Math.max(capeIdx, gustIdx);
  // Moyenne géométrique probabilité × intensité : l'indice ne monte que si LES DEUX
  // sont élevées (sélectif), conformément à la décision « combiné ».
  return Math.round(Math.sqrt((prob / 100) * (intensity / 100)) * 100);
}

// Anneaux de sévérité → chemin SVG rempli d'un motif de hachures. Reprend la même
// chaîne marching-squares / lissage / signifiance que les zones de probabilité, mais
// sur le champ de sévérité et avec un seul seuil.
function predictionSeverityHatchMarkup(field, project, cells, threshold = PREDICTION_SEVERITY_THRESHOLD) {
  let rings = predictionMarchingSquaresRings(field, threshold)
    .filter((ring) => predictionPolygonArea(ring) >= 1.4);
  if (!rings.length) return '';
  const areas = rings.map(predictionPolygonArea);
  const centroids = rings.map(predictionRingCentroidPt);
  rings = rings.filter((ring, idx) => !rings.some((other, k) => k !== idx && areas[k] > areas[idx] && predictionRingContains(other, centroids[idx])));
  const sigPts = (Array.isArray(cells) ? cells : [])
    .filter((c) => predictionCellSeverity(c) >= threshold)
    .map((c) => [(Number(c.lon) - field.minLon) / field.cellW + field.pad, (Number(c.lat) - field.minLat) / field.cellH + field.pad]);
  rings = rings.filter((ring) => {
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    for (const p of ring) {
      if (p[0] < minX) minX = p[0];
      if (p[0] > maxX) maxX = p[0];
      if (p[1] < minY) minY = p[1];
      if (p[1] > maxY) maxY = p[1];
    }
    let count = 0;
    for (const s of sigPts) {
      if (s[0] < minX || s[0] > maxX || s[1] < minY || s[1] > maxY) continue;
      if (predictionRingContains(ring, s)) {
        count += 1;
        if (count >= PREDICTION_MIN_ZONE_CELLS) return true;
      }
    }
    return false;
  });
  if (!rings.length) return '';
  const paths = rings.map((ring) => {
    const smoothed = predictionChaikinClosed(ring, 2);   // perf : 2 passes suffisent (−28% de poids SVG, rendu identique à l'échelle d'affichage)
    const projected = smoothed.map(([gi, gj]) => project(field.minLon + (gi - field.pad) * field.cellW, field.minLat + (gj - field.pad) * field.cellH));
    return predictionClosedBezierPath(projected, 0.6);
  }).filter(Boolean).join(' ');
  if (!paths) return '';
  return `<g class="severity-hatch">
    <path d="${paths}" fill="url(#severityHatch)" fill-rule="nonzero" stroke="${PREDICTION_SEVERITY_HATCH_COLOR}" stroke-opacity="0.9" stroke-width="1.7" stroke-linejoin="round"/>
  </g>`;
}

function drawPredictionImage(day, cells, periodKey = selectedPredictionPeriodKey) {
  const width = 860;
  const height = 760;
  const metrics = predictionProjectionMetrics(width, height);
  const project = metrics.project;
  const francePath = predictionFranceSvgPath(project);
  const period = predictionPeriodConfig(periodKey);
  const titleDate = predictionDayIsTrend(day)
    ? ((typeof formatTimelineDateLabel === 'function' ? formatTimelineDateLabel(predictionDayKey(day)) : predictionDayKey(day)) + ' · tendance ECMWF')
    : (period.key === 'day'
      ? predictionWindowDateLabel(day)
      : (typeof formatTimelineDateLabel === 'function' ? formatTimelineDateLabel(predictionDayKey(day)) : predictionDayKey(day)));
  const levels = predictionLevelConfigs(cells);
  const field = predictionBuildScalarField(cells);
  const shapeMarkup = levels.map((level) => predictionContourLevelMarkup(field, project, level, cells)).join('');
  // Hachures de sévérité : tous les jours de prévision J0 → J+10, y compris la tendance
  // ECMWF (J+4+). Les cellules tendance portent CAPE (mucape) et rafales (wind_gusts_10m),
  // exposées comme meanCape/maxGusts par predictionTrendDailyCells → même calcul de
  // sévérité (probabilité × intensité) que les jours horaires AROME/ARPEGE.
  const severityOffset = predictionDateOffset(predictionDayKey(day));
  const isSeverityDay = severityOffset >= 0 && severityOffset <= PREDICTION_MAX_OFFSET;
  const severityThreshold = predictionDayIsTrend(day) ? PREDICTION_SEVERITY_THRESHOLD_TREND : PREDICTION_SEVERITY_THRESHOLD;
  const severityMarkup = isSeverityDay
    ? predictionSeverityHatchMarkup(predictionBuildScalarField(cells, predictionCellSeverity), project, cells, severityThreshold)
    : '';
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
      const x = index * 104;
      return `<g transform="translate(${x} 24)">
        <rect x="0" y="0" width="36" height="15" rx="7" fill="${level.color}" fill-opacity="0.92" stroke="#e2e8f0" stroke-opacity="0.16"/>
        <text x="45" y="12.5" fill="#cbd5e1" font-family="Inter, Arial, sans-serif" font-size="12.5" font-weight="800">${predictionEscapeXml(level.label)}</text>
      </g>`;
    }).join('');
    svgHeight = height;
    legendY = height - 66;
  }

  // Entrée de légende pour les hachures de sévérité (J0 uniquement).
  let severityLegendMarkup = '';
  if (severityMarkup) {
    if (isMobileSvg) {
      const rowsUsed = Math.ceil(predictionExportLegendLevels().length / 3);
      const yOff = rowsUsed * 52 + 30;
      severityLegendMarkup = `<g transform="translate(0 ${yOff})">
        <rect x="0" y="0" width="40" height="18" rx="6" fill="url(#severityHatch)" stroke="${PREDICTION_SEVERITY_HATCH_COLOR}" stroke-opacity="0.7"/>
        <text x="50" y="15" fill="#cbd5e1" font-family="Inter, Arial, sans-serif" font-size="22" font-weight="800">Hachures : orage potentiellement violent</text>
      </g>`;
      svgHeight = Math.max(svgHeight, legendY + yOff + 28);
    } else {
      severityLegendMarkup = `<g transform="translate(0 44)">
        <rect x="0" y="0" width="36" height="15" rx="4" fill="url(#severityHatch)" stroke="${PREDICTION_SEVERITY_HATCH_COLOR}" stroke-opacity="0.7"/>
        <text x="45" y="12.5" fill="#cbd5e1" font-family="Inter, Arial, sans-serif" font-size="12.5" font-weight="800">Hachures : orage potentiellement violent</text>
      </g>`;
    }
  }

  const legendTitleSize = isMobileSvg ? 24 : 12;
  const label = predictionEscapeXml(`${period.label} · ${titleDate}`);
  const svg = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${svgHeight}" width="${width}" height="${svgHeight}" role="img" aria-label="Prévision orageuse ${label}" shape-rendering="geometricPrecision">
  <defs>
    <clipPath id="franceClip" clipPathUnits="userSpaceOnUse"><path d="${francePath}"/></clipPath>
    <pattern id="severityHatch" patternUnits="userSpaceOnUse" width="9" height="9" patternTransform="rotate(45)">
      <line x1="0" y1="0" x2="0" y2="9" stroke="${PREDICTION_SEVERITY_HATCH_COLOR}" stroke-width="2.2" stroke-opacity="0.92"/>
    </pattern>
  </defs>
  <rect width="${width}" height="${svgHeight}" fill="#07111f"/>
  <g>
    <path d="${francePath}" fill="${PREDICTION_RISK_LEVELS[0].color}"/>
    <g clip-path="url(#franceClip)">${shapeMarkup}</g>
    <g clip-path="url(#franceClip)">${severityMarkup}</g>
    <g clip-path="url(#franceClip)">${adminMarkup}</g>
    <g clip-path="url(#franceClip)">${regionBoundaryMarkup}</g>
    <path d="${francePath}" fill="none" stroke="#020617" stroke-opacity="0.6" stroke-width="1.7" stroke-linejoin="round"/>
    <path d="${francePath}" fill="none" stroke="#7dd3fc" stroke-opacity="0.72" stroke-width="1.3" stroke-linejoin="round"/>
  </g>
  <g transform="translate(38 ${legendY})">
    <text x="0" y="0" fill="#dbeafe" fill-opacity="0.82" font-family="Inter, Arial, sans-serif" font-size="${legendTitleSize}" font-weight="900">PROBABILITÉ DE RISQUE ORAGEUX</text>
    ${legendMarkup}
    ${severityLegendMarkup}
  </g>
</svg>`;
  return `data:image/svg+xml;charset=UTF-8,${encodeURIComponent(svg)}`;
}

// France « base » (vide) pour le chargement : MÊME SVG que la carte (viewBox
// 860×760, même projection, même fond + dépts/régions + arête) mais SANS les
// couleurs de risque. Posée telle quelle dans #predictionImage pendant le
// chargement ; on swap ensuite vers la version colorée → la France « s'hydrate »
// sur le MÊME élément image (aucun décalage possible). Transition sans couture.
function drawPredictionScopeImage() {
  const width = 860;
  const height = 760;
  const project = predictionProjectionMetrics(width, height).project;
  const francePath = predictionFranceSvgPath(project);
  const adminMarkup = predictionAdminLineMarkup(project);
  const regionMarkup = predictionRegionBoundaryMarkup(project);
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" shape-rendering="geometricPrecision">
    <defs><clipPath id="scopeClip" clipPathUnits="userSpaceOnUse"><path d="${francePath}"/></clipPath></defs>
    <rect width="${width}" height="${height}" fill="#07111f"/>
    <path d="${francePath}" fill="#091321"/>
    <g clip-path="url(#scopeClip)">${adminMarkup}${regionMarkup}</g>
    <path d="${francePath}" fill="none" stroke="#020617" stroke-opacity="0.55" stroke-width="1.4" stroke-linejoin="round"/>
    <path d="${francePath}" fill="none" stroke="#7dd3fc" stroke-opacity="0.55" stroke-width="1.05" stroke-linejoin="round"/>
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

function predictionBuildRegionSummary(cells) {
  return predictionBuildAreaSummary(cells, PREDICTION_REGIONS, { topShare: 0.18 });
}

function predictionBuildLittoralSummary(cells) {
  return predictionBuildAreaSummary(cells, PREDICTION_LITTORALS, { topShare: 0.24 });
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

// Synthèse « Zones à surveiller » à la maille DÉPARTEMENT (et non région) : un point
// chaud localisé (ex. Haute-Saône en « Très élevé ») doit apparaître nommément, comme
// sur la carte. On n'agrège que les cellules cartographiées (score ≥ 60) — moins de
// recherches point-dans-polygone et un score qui reflète bien le foyer local.
function predictionBuildDepartmentSummary(cells) {
  const map = new Map();
  cells.forEach((cell) => {
    if (predictionLayerScore(cell) < 60) return;
    const info = predictionAdministrativeInfoForCell(cell);
    const name = info?.department;
    if (!name || name === 'Département') return;
    const entry = map.get(name) || { name, cells: [], scores: [], cape: [], temperature: [], dewpoint: [], gusts: [], hours: [] };
    entry.cells.push(cell);
    entry.scores.push(predictionLayerScore(cell));
    if (Number.isFinite(cell.meanCape)) entry.cape.push(cell.meanCape);
    if (Number.isFinite(cell.meanTemperature)) entry.temperature.push(cell.meanTemperature);
    if (Number.isFinite(cell.meanDewpoint)) entry.dewpoint.push(cell.meanDewpoint);
    if (Number.isFinite(cell.maxGusts)) entry.gusts.push(cell.maxGusts);
    entry.hours.push(...(cell.bestHours || []));
    map.set(name, entry);
  });
  return Array.from(map.values())
    .map((entry) => predictionAreaEntrySummary(entry, 0.34))
    .sort((a, b) => b.score - a.score);
}

// Date mise en avant, format « 21 Juin 2026 » (mois capitalisé).
function predictionLongDateLabel(dateIso) {
  const d = new Date(`${String(dateIso || '').slice(0, 10)}T12:00:00`);
  if (Number.isNaN(d.getTime())) return String(dateIso || '');
  const parts = d.toLocaleDateString('fr-FR', { day: 'numeric', month: 'long', year: 'numeric' }).split(' ');
  if (parts.length >= 2 && parts[1]) parts[1] = parts[1].charAt(0).toUpperCase() + parts[1].slice(1);
  return parts.join(' ');
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
  const isTrend = predictionDayIsTrend(day);
  const sectors = predictionBuildDepartmentSummary(cells);
  const maxScore = Math.round(Math.max(...cells.map((cell) => predictionLayerScore(cell)), 0));
  const activeLevel = predictionRiskLevel(maxScore);
  const longDate = predictionLongDateLabel(predictionDayKey(day));
  const kickerText = isTrend ? 'Tendance ECMWF' : period.label;
  const disclaimerText = isTrend
    ? 'Tendance ECMWF (open data, maille ~28 km), informative et non officielle. À cette échéance (J+5 à J+10), à lire comme « jours / régions à surveiller » — pas une localisation précise des orages.'
    : 'Synthèse automatique AROME / ARPEGE France, informative et non officielle. La couleur traduit la probabilité orageuse agrégée sur la période sélectionnée.';
  const activeSectors = sectors.filter((area) => area.score >= 60).slice(0, 6);
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
        </div>`;
      }).join('');
  return `<div class="prediction-summary-date">${predictionEscapeXml(longDate)}</div>
  <div class="prediction-summary-hero" style="--risk-color:${activeLevel.color};--risk-stroke:${activeLevel.stroke}">
    <div>
      <span class="prediction-summary-kicker">${predictionEscapeXml(kickerText)}</span>
      <strong>${predictionEscapeXml(activeLevel.label)}</strong>
      <em>${predictionEscapeXml(activeLevel.text)}</em>
    </div>
  </div>
  <div class="prediction-analysis-block">
    <div class="prediction-analysis-block-title">Zones à surveiller</div>
    <div class="prediction-sector-list">${quietText}</div>
  </div>
  <p class="prediction-analysis-disclaimer">${predictionEscapeXml(disclaimerText)}</p>`;
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
    return { ok: false, status, periodStatus, periodKey: period.key, message: 'Aucune cellule exploitable pour ' + period.label.toLowerCase() + '.' };
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

