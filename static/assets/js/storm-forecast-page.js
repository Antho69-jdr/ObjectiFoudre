// storm-forecast-page.js — issu du découpage de storm-forecast-image.js (Phase 3).
// Interaction/hover/export/ouverture page + init et exports window.* (exécution top-level → chargé en DERNIER).

// État du survol : throttle rAF + mémorisation du dernier département survolé, pour
// n'exécuter le hit-test complet + reconstruction highlight/infobulle (coûteux, avec
// recompose mix-blend) qu'au PASSAGE d'un département à l'autre (cf. processPredictionHover).
let predictionHoverRaf = 0;
let predictionHoverCoords = null;
let predictionLastDeptRing = null;

function updatePredictionPeriodTabs(periodKey = selectedPredictionPeriodKey) {
  const period = predictionPeriodConfig(periodKey);
  if (typeof predictionPeriodButtons === 'undefined' || !predictionPeriodButtons) return;
  predictionPeriodButtons.forEach((button) => {
    const active = button.dataset.predictionPeriod === period.key;
    button.classList.toggle('active', active);
    button.setAttribute('aria-selected', active ? 'true' : 'false');
  });
  if (typeof updatePredictionRibbon === 'function') updatePredictionRibbon();   // Frise 3 : sync période
}

function hidePredictionHover() {
  if (predictionHoverRaf) { cancelAnimationFrame(predictionHoverRaf); predictionHoverRaf = 0; }
  predictionHoverCoords = null;
  predictionLastDeptRing = null;
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

// Rectangle du CONTENU FRANCE de l'image (object-fit:contain → letterbox centré).
// ⚠️ L'image générée fait 860×svgHeight : la variante MOBILE de légende (isMobileSvg,
// cf. storm-forecast-render) empile la légende SOUS la France → svgHeight = 830+ ≠ 760.
// La France reste dans le HAUT 860×760. On letterbox donc l'image ENTIÈRE (dims
// naturelles) puis on restreint à la région France (haut), sinon en mobile la détection
// du survol ET le highlight sont scalés/décalés faux (bug remonté par Anthony).
function predictionImageContentRect() {
  const rect = predictionImage.getBoundingClientRect();
  if (!rect.width || !rect.height) return null;
  const nW = predictionImage.naturalWidth || 860;
  const nH = predictionImage.naturalHeight || 760;
  const scale = Math.min(rect.width / nW, rect.height / nH);   // contain sur l'image entière
  const cw = nW * scale;                       // largeur image contenue
  const chFull = nH * scale;                   // hauteur image contenue (France + légende)
  const chFrance = 760 * (nW / 860) * scale;   // hauteur de la SEULE région France (haut)
  return {
    left: rect.left + (rect.width - cw) / 2,
    top: rect.top + (rect.height - chFull) / 2,
    width: cw,
    height: chFrance,
  };
}

function predictionImagePointerGeo(event) {
  if (!predictionImage || predictionImage.hidden) return null;
  const rect = predictionImageContentRect();
  if (!rect || !rect.width || !rect.height) return null;
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

// Illumine le département survolé : dessine son polygone dans #predictionHighlight
// (mix-blend-mode:screen → ajoute de la lumière sur la carte). Même mapping plein-
// rect que predictionImagePointerGeo → cohérent avec la détection du survol.
function predictionDrawDepartmentHighlight(ring) {
  if (!predictionHighlight || !predictionImage || !Array.isArray(ring) || ring.length < 3) return;
  const project = predictionProjectionMetrics(860, 760).project;
  const d = ring.map((pt, i) => {
    const [x, y] = project(Number(pt[0]), Number(pt[1]));
    return `${i === 0 ? 'M' : 'L'}${x.toFixed(1)} ${y.toFixed(1)}`;
  }).join(' ') + ' Z';
  predictionHighlight.style.left = predictionImage.offsetLeft + 'px';
  predictionHighlight.style.top = predictionImage.offsetTop + 'px';
  predictionHighlight.style.width = predictionImage.offsetWidth + 'px';
  predictionHighlight.style.height = predictionImage.offsetHeight + 'px';
  // ⚠️ viewBox = 860×svgHeight de l'IMAGE (la légende mobile ajoute de la hauteur sous
  // la France, cf. predictionImageContentRect) → le tracé (coords 860×760, en HAUT) se
  // letterbox comme l'image (meet = object-fit:contain). Un viewBox 860×760 codé en dur
  // décalait/écrasait le département en vue mobile (svgHeight ≠ 760).
  const nW = predictionImage.naturalWidth || 860;
  const nH = predictionImage.naturalHeight || 760;
  const vbH = (860 * nH / nW).toFixed(1);   // = svgHeight de l'image
  predictionHighlight.innerHTML = `<svg viewBox="0 0 860 ${vbH}" preserveAspectRatio="xMidYMid meet" aria-hidden="true"><path d="${d}" fill="rgba(56,189,248,0.20)" stroke="rgba(125,211,252,0.92)" stroke-width="1.6" stroke-linejoin="round"/></svg>`;
  predictionHighlight.hidden = false;
}

// Handler brut : ne fait que mémoriser la dernière position et programmer un traitement
// au prochain frame (throttle rAF) → un seul traitement par frame max, quel que soit le
// débit de pointermove (souris PC = dizaines/s).
function movePredictionHover(event) {
  predictionHoverCoords = { clientX: event.clientX, clientY: event.clientY };
  if (predictionHoverRaf) return;
  predictionHoverRaf = requestAnimationFrame(processPredictionHover);
}

function processPredictionHover() {
  predictionHoverRaf = 0;
  const ev = predictionHoverCoords;
  if (!ev || !predictionHover || !currentPredictionPageResult?.ok) return;
  const point = predictionImagePointerGeo(ev);
  if (!point) { hidePredictionHover(); return; }
  const panelRect = predictionImage.parentElement.getBoundingClientRect();
  const x = Math.max(8, Math.min(panelRect.width - 270, ev.clientX - panelRect.left + 14));
  const y = Math.max(8, Math.min(panelRect.height - 136, ev.clientY - panelRect.top + 14));
  // Voie rapide : toujours dans le MÊME département → on repositionne seulement
  // l'infobulle. On évite ainsi le hit-test complet (scan des cellules), la
  // reconstruction du highlight SVG et de l'infobulle, et le recompose mix-blend —
  // qui ne sont nécessaires qu'au changement de département.
  if (predictionLastDeptRing && typeof pointInRing === 'function'
      && pointInRing(point.lon, point.lat, predictionLastDeptRing)) {
    predictionHover.style.left = `${x}px`;
    predictionHover.style.top = `${y}px`;
    return;
  }
  const zone = predictionHitZoneAtPoint(point);
  if (!zone) { hidePredictionHover(); return; }
  predictionLastDeptRing = zone.departmentRing;
  predictionDrawDepartmentHighlight(zone.departmentRing);
  predictionHover.innerHTML = predictionHoverHtml(zone);
  predictionHover.style.left = `${x}px`;
  predictionHover.style.top = `${y}px`;
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
  predictionLastDeptRing = null;   // données rafraîchies → forcer un re-hit-test au prochain survol
  if (typeof predictionDownloadBtn !== 'undefined' && predictionDownloadBtn) predictionDownloadBtn.disabled = !result?.ok;
  if (!result?.ok) hidePredictionHover();
  const period = predictionPeriodConfig(result?.periodKey || selectedPredictionPeriodKey);
  updatePredictionPeriodTabs(period.key);
  if (typeof predictionImageStatus !== 'undefined' && predictionImageStatus) {
    predictionImageStatus.textContent = result?.message || 'Préparation de la carte…';
    predictionImageStatus.classList.toggle('is-ready', !!result?.ok);
    predictionImageStatus.classList.toggle('is-waiting', !result?.ok);
  }
  const activeDay = predictionActiveDay();
  const activeIsTrend = predictionDayIsTrend(activeDay) || predictionDateIsTrend(predictionSelectedDate || predictionTodayIso());
  const activeDateLabel = (typeof formatShortDateLabel === 'function')
    ? formatShortDateLabel(predictionSelectedDate || predictionTodayIso())
    : (predictionSelectedDate || predictionTodayIso());
  if (typeof predictionPageTitle !== 'undefined' && predictionPageTitle) {
    if (activeIsTrend) {
      predictionPageTitle.textContent = 'Tendance orageuse · ' + activeDateLabel;
    } else {
      predictionPageTitle.textContent = period.key === 'day'
        ? 'Carte de risque journalier'
        : `Carte de risque · ${period.label}`;
    }
  }
  if (predictionPageSubtitle) {
    if (activeIsTrend) {
      const meta = activeDay?.meta || {};
      const reso = meta.resolution_label || '0,25° (~28 km)';
      predictionPageSubtitle.textContent = result?.ok
        ? `Tendance ECMWF · maille ${reso} · pic d'instabilité du jour · ${activeDateLabel}`
        : `Tendance ECMWF (maille ${reso}) · ${activeDateLabel}`;
    } else if (activeDay && predictionDayIsEcmwfSlots(activeDay)) {
      // J+2/J+3 : ECMWF multi-créneaux 3-horaires (remplace ARPEGE ; jour self-contained).
      const reso = (activeDay.meta || {}).resolution_label || '0,25° (~28 km)';
      const dateText = (typeof formatTimelineDateLabel === 'function' ? formatTimelineDateLabel(predictionDayKey(activeDay)) : predictionDayKey(activeDay));
      predictionPageSubtitle.textContent = result?.ok
        ? 'ECMWF · maille ' + reso + ' · créneaux 3 h · ' + dateText
        : 'En attente de la grille ECMWF · ' + dateText;
    } else {
      const dateText = period.key === 'day'
        ? predictionWindowDateLabel(activeDay || getCurrentDay())
        : (typeof formatTimelineDateLabel === 'function' ? formatTimelineDateLabel(predictionDayKey(activeDay || getCurrentDay())) : predictionDayKey(activeDay || getCurrentDay()));
      const periodText = period.key === 'day' ? 'fenêtre 08h-08h' : 'grilles ' + period.rangeLabel;
      const modelText = 'AROME France';
      predictionPageSubtitle.textContent = result?.ok
        ? 'Image générée depuis la ' + periodText + ' ' + modelText + ' en cache · ' + dateText
        : 'En attente des grilles ' + modelText + ' · ' + dateText;
    }
  }
  if (result?.ok && result.dataUrl) {
    // Hydratation : la France « vide » gagne ses couleurs sur le même élément image.
    predictionImage.src = result.dataUrl;
    predictionImage.alt = `Carte de prévision orageuse ${period.label.toLowerCase()} ${result.dayKey || ''}`.trim();
    predictionImage.hidden = false;
    predictionImage.closest('.prediction-map-panel')?.classList.remove('prediction-scanning');
    initPredictionHover();
    predictionAnalysisText.innerHTML = result.analysisHtml || '';
  } else {
    // Pas encore prête : on garde la France « vide » + le balayage radar.
    showPredictionScanning();
    predictionAnalysisText.textContent = result?.message || 'La synthèse sera disponible quand la fenêtre 08h-08h sera chargée.';
  }
}

function predictionDownloadFilename(result = currentPredictionPageResult) {
  const dayKey = result?.dayKey || predictionDayKey(getCurrentDay());
  const period = predictionPeriodConfig(result?.periodKey || selectedPredictionPeriodKey);
  return `objectifoudre-prevision-${dayKey}-${period.key}.png`;
}

function predictionExportLegendLevels() {
  return PREDICTION_RISK_LEVELS.filter((level) => Number(level.min) >= 60);
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
  const dayKey = result?.dayKey || predictionDayKey(day);
  const longDate = predictionLongDateLabel(dayKey);
  const isTrend = predictionDayIsTrend(day) || predictionDateIsTrend(dayKey);
  const cells = Array.isArray(result?.cells) ? result.cells : [];
  const maxScore = Math.round(Number(result?.maxScore ?? Math.max(...cells.map((cell) => predictionLayerScore(cell)), 0)) || 0);
  const level = predictionRiskLevel(maxScore);
  const sectors = predictionBuildDepartmentSummary(cells);
  const lead = sectors[0] || null;
  const watchSectors = sectors.filter((area) => area.score >= 60).slice(0, 6);
  return { period, longDate, isTrend, maxScore, level, sectors, lead, watchSectors };
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
  // Date mise en avant (à droite), format direct « 29 Juin 2026 » — sans le créneau verbeux.
  ctx.textAlign = 'right';
  ctx.fillStyle = 'rgba(167, 243, 208, 0.92)';
  ctx.font = '800 12px Inter, Arial, sans-serif';
  ctx.fillText((summary.isTrend ? 'Tendance ECMWF' : summary.period.label).toUpperCase(), width - 36, 34);
  ctx.fillStyle = '#f8fafc';
  ctx.font = '900 32px Inter, Arial, sans-serif';
  ctx.fillText(summary.longDate, width - 36, 68);
  ctx.textAlign = 'left';

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
  sectors.slice(0, 6).forEach((area) => {
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
  ctx.fillText(summary.isTrend
    ? 'Tendance ECMWF (open data, ~28 km), informative et non officielle.'
    : 'Synthèse automatique AROME / ARPEGE France, informative et non officielle.', sx, sidePanel.y + sidePanel.h - 14);

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
  if (!force && PREDICTION_IMAGE_CACHE.has(key)) {
    const cached = PREDICTION_IMAGE_CACHE.get(key);
    // LRU : réinsérer en fin de Map → marque « le plus récemment utilisé ».
    PREDICTION_IMAGE_CACHE.delete(key);
    PREDICTION_IMAGE_CACHE.set(key, cached);
    return cached;
  }
  const result = generatePredictionPageImage(day, period.key);
  if (result.ok) {
    PREDICTION_IMAGE_CACHE.set(key, result);
    // Éviction LRU : au-delà du plafond, retirer l'entrée la plus ancienne (1re clé de la Map).
    while (PREDICTION_IMAGE_CACHE.size > PREDICTION_IMAGE_CACHE_MAX) {
      PREDICTION_IMAGE_CACHE.delete(PREDICTION_IMAGE_CACHE.keys().next().value);
    }
  }
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

// Les périodes infra-journalières n'ont de sens que pour les jours horaires
// (AROME/ARPEGE). Un jour de tendance ECMWF = un seul point quotidien → seul
// l'onglet « Journée » est actif.
function predictionUpdatePeriodTabAvailability() {
  if (typeof predictionPeriodButtons === 'undefined' || !predictionPeriodButtons) return;
  const isTrend = predictionDateIsTrend(predictionSelectedDate || predictionTodayIso());
  // En tendance ECMWF (1 point par jour), les onglets de période n'ont aucun sens : on
  // masque tout le bloc plutôt que de les désactiver.
  if (typeof predictionPeriodTabs !== 'undefined' && predictionPeriodTabs) {
    predictionPeriodTabs.style.display = isTrend ? 'none' : '';
  }
  predictionPeriodButtons.forEach((button) => {
    const key = button.dataset.predictionPeriod || 'day';
    const disabled = isTrend && key !== 'day';
    button.disabled = disabled;
    button.classList.toggle('is-unavailable', disabled);
    button.title = disabled ? 'Indisponible en tendance ECMWF (un point par jour)' : '';
  });
}

function predictionDateStripEl() {
  return document.getElementById('predictionDateStrip');
}

function buildPredictionDateStrip() {
  const strip = predictionDateStripEl();
  if (!strip) return;
  strip.innerHTML = '';
  predictionSelectableDates().forEach((dateIso) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'prediction-date-chip';
    btn.dataset.predictionDate = dateIso;
    const trend = predictionDateIsTrend(dateIso);
    if (trend) btn.classList.add('is-trend');
    const shortDate = (typeof formatShortDateLabel === 'function') ? formatShortDateLabel(dateIso) : dateIso;
    btn.innerHTML = `<span class="prediction-chip-jx">${predictionDateChipLabel(dateIso)}</span><span class="prediction-chip-date">${shortDate}</span>`;
    btn.addEventListener('click', () => selectPredictionDate(dateIso));
    strip.appendChild(btn);
  });
  highlightPredictionDateChip();
}

function highlightPredictionDateChip() {
  if (typeof updatePredictionRibbon === 'function') updatePredictionRibbon();   // Frise 3 : sync date
  const strip = predictionDateStripEl();
  if (!strip) return;
  let activeBtn = null;
  strip.querySelectorAll('.prediction-date-chip').forEach((btn) => {
    const active = btn.dataset.predictionDate === predictionSelectedDate;
    btn.classList.toggle('active', active);
    btn.setAttribute('aria-current', active ? 'date' : 'false');
    if (active) activeBtn = btn;
  });
  // Carrousel mobile : amener le chip actif au centre quand la bande défile
  // horizontalement (téléphone). Sans effet si la bande n'est pas scrollable (desktop).
  if (activeBtn && strip.scrollWidth > strip.clientWidth + 4) {
    activeBtn.scrollIntoView({ block: 'nearest', inline: 'center', behavior: 'smooth' });
  }
}

// ── Auto-rafraîchissement : tant qu'un jour n'est pas prêt (grilles AROME en cours de
// matérialisation côté serveur), on re-sonde périodiquement et on ré-affiche dès que ça se
// remplit — sans que l'utilisateur ait à recharger. Le compteur « X/24 » monte en direct.
const PREDICTION_POLL_MS = 30000;   // 30 s
const PREDICTION_POLL_MAX = 60;     // ~30 min puis arrêt
let predictionPollTimer = null, predictionPollCount = 0;
function clearPredictionPollTimer() { if (predictionPollTimer) { clearTimeout(predictionPollTimer); predictionPollTimer = null; } }
function clearPredictionPoll() { clearPredictionPollTimer(); predictionPollCount = 0; }
function predictionPageOpen() { return predictionPage?.getAttribute('aria-hidden') === 'false'; }
function schedulePredictionPoll(dateIso) {
  clearPredictionPollTimer();
  if (predictionPollCount >= PREDICTION_POLL_MAX) return;
  predictionPollTimer = setTimeout(() => predictionPollTick(dateIso), PREDICTION_POLL_MS);
}
async function predictionPollTick(dateIso) {
  predictionPollTimer = null;
  if (!predictionPageOpen() || predictionSelectedDate !== dateIso) return;   // page fermée / date changée
  predictionPollCount += 1;
  try { await predictionRefetchDay(dateIso); } catch (_) {}
  if (!predictionPageOpen() || predictionSelectedDate !== dateIso) return;
  const day = predictionActiveDay();
  const result = day
    ? ensurePredictionPageImage(day, { periodKey: selectedPredictionPeriodKey })
    : { ok: false, periodKey: selectedPredictionPeriodKey, message: 'Grille indisponible pour ce jour : aucune donnée en cache serveur.' };
  renderPredictionPageResult(result);
  if (!result || result.ok !== true) schedulePredictionPoll(dateIso); else clearPredictionPoll();
}

async function renderActivePrediction() {
  const dateIso = predictionSelectedDate;
  if (!dateIso) return;
  clearPredictionPoll();   // nouvelle action utilisateur → on repart propre
  const isTrend = predictionDateIsTrend(dateIso);
  if (isTrend && selectedPredictionPeriodKey !== 'day') {
    selectedPredictionPeriodKey = 'day';
    updatePredictionPeriodTabs('day');
  }
  predictionUpdatePeriodTabAvailability();
  const period = predictionPeriodConfig(selectedPredictionPeriodKey);
  renderPredictionPageResult({ ok: false, periodKey: period.key, message: (isTrend ? 'Chargement de la tendance ' : 'Chargement de la prévision ') + (typeof formatShortDateLabel === 'function' ? formatShortDateLabel(dateIso) : dateIso) + '…' });
  await predictionEnsureDay(dateIso);
  if (predictionSelectedDate !== dateIso) return; // l'utilisateur a changé de date entre-temps
  const day = predictionActiveDay();
  if (!day) {
    renderPredictionPageResult({
      ok: false,
      periodKey: selectedPredictionPeriodKey,
      message: isTrend
        ? 'Tendance ECMWF indisponible pour ce jour (run open data pas encore publié).'
        : 'Grille indisponible pour ce jour : aucune donnée en cache serveur.',
    });
    schedulePredictionPoll(dateIso);   // le serveur peut recevoir la grille sous peu
    return;
  }
  const result = ensurePredictionPageImage(day, { periodKey: selectedPredictionPeriodKey });
  renderPredictionPageResult(result);
  if (!result || result.ok !== true) schedulePredictionPoll(dateIso);   // pas encore prêt → on re-sonde
}

async function selectPredictionDate(dateIso) {
  predictionSelectedDate = normalizeDateIso(dateIso);
  highlightPredictionDateChip();
  await renderActivePrediction();
}

async function setPredictionPeriod(periodKey = 'day') {
  const isTrend = predictionDateIsTrend(predictionSelectedDate || predictionTodayIso());
  const period = predictionPeriodConfig(isTrend ? 'day' : periodKey);
  selectedPredictionPeriodKey = period.key;
  updatePredictionPeriodTabs(period.key);
  if (predictionPage?.getAttribute('aria-hidden') === 'false') {
    await renderActivePrediction();
  }
}

function initPredictionPeriodTabs() {
  if (typeof predictionPeriodButtons === 'undefined' || !predictionPeriodButtons) return;
  predictionPeriodButtons.forEach((button) => {
    button.addEventListener('click', () => {
      if (button.disabled) return;
      setPredictionPeriod(button.dataset.predictionPeriod || 'day');
    });
  });
  updatePredictionPeriodTabs(selectedPredictionPeriodKey);
}

// Préchargement : hydrate en arrière-plan tous les jours sélectionnables (et calcule
// l'image « Journée »), pour que le changement de date soit quasi instantané.
async function prewarmPredictionDates() {
  if (predictionPrewarmStarted) return;
  predictionPrewarmStarted = true;
  for (const dateIso of predictionSelectableDates()) {
    if (predictionPage?.getAttribute('aria-hidden') !== 'false') break; // page fermée → on arrête
    if (PREDICTION_DAY_STORE.has(dateIso)) continue;
    try {
      await predictionEnsureDay(dateIso);
      const day = PREDICTION_DAY_STORE.get(dateIso);
      if (day) ensurePredictionPageImage(day, { periodKey: 'day' });
    } catch (_) {}
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
}

initPredictionPeriodTabs();
initPredictionHover();
if (typeof predictionDownloadBtn !== 'undefined' && predictionDownloadBtn) {
  predictionDownloadBtn.addEventListener('click', downloadPredictionPageImage);
}

// Chargement : pose la France « vide » (drawPredictionScopeImage) DANS
// #predictionImage + active le balayage (classe .prediction-scanning). On swap
// ensuite vers la version colorée → la France s'hydrate sur le MÊME élément
// image (transition sans couture, aucun décalage possible).
function showPredictionScanning() {
  if (!predictionImage || typeof drawPredictionScopeImage !== 'function') return;
  predictionImage.src = drawPredictionScopeImage();
  predictionImage.hidden = false;
  predictionImage.closest('.prediction-map-panel')?.classList.add('prediction-scanning');
  hidePredictionHover();
}

async function openPredictionPage(initialDate = null) {
  if (!predictionPage) return;
  predictionPage.setAttribute('aria-hidden', 'false');
  showPredictionScanning();
  buildPredictionDateStrip();
  if (typeof buildPredictionRibbon === 'function') buildPredictionRibbon();   // Frise 3
  // Date par défaut : celle demandée si dans la plage, sinon la date de la grille si
  // elle est dans J0→J+10, sinon aujourd'hui.
  let target = initialDate ? normalizeDateIso(initialDate) : null;
  if (!target) {
    const gridDate = normalizeDateIso(selectedBaseDate);
    const gridOffset = predictionDateOffset(gridDate);
    target = (gridOffset >= 0 && gridOffset <= PREDICTION_MAX_OFFSET) ? gridDate : predictionTodayIso();
  }
  predictionSelectedDate = target;
  // Frise 3 : le ruban sélectionne des sous-créneaux (Matin/Après-midi/Soir) sur les
  // jours horaires — plus de « Journée 08-08 » agrégée. Défaut = après-midi (pic
  // convectif), ou « jour » en tendance ; une sous-période déjà choisie est conservée.
  if (predictionDateIsTrend(target)) selectedPredictionPeriodKey = 'day';
  else if (selectedPredictionPeriodKey === 'day') selectedPredictionPeriodKey = 'afternoon';
  highlightPredictionDateChip();
  await renderActivePrediction();
  prewarmPredictionDates();
}

function closePredictionPage() {
  if (!predictionPage) return;
  predictionPage.setAttribute('aria-hidden', 'true');
  clearPredictionPoll();
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
