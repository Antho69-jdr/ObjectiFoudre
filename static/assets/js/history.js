// Écran Historique — vue dédiée, séparée de la carte temps réel.
// Rejoue une journée archivée en ANIMATION 24 h en SVG VECTORIEL : grille de
// cellules <rect> colorées (clippées à la France) + contours de départements,
// animées en JS sur la frise (mise à jour des couleurs par heure). Zoom net via
// viewBox. Foudre observée (MTG-LI) en <circle> blancs synchronisés à l'heure.
// Réutilise les globales de controls.js / france-admin-lines.js / utils.js.
(function () {
  const historyPage = document.getElementById('historyPage');
  if (!historyPage) return;

  const openBtn = document.getElementById('historyPageBtn');
  const closeBtn = document.getElementById('historyPageCloseBtn');
  const dateListEl = document.getElementById('historyDateList');
  const frameEl = document.getElementById('historyFrame'); // <svg>
  const emptyHintEl = document.getElementById('historyEmptyHint');
  const controlsEl = document.getElementById('historyPlayerControls');
  const playBtn = document.getElementById('historyPlayBtn');
  const scrubber = document.getElementById('historyScrubber');
  const hourLabel = document.getElementById('historyHourLabel');
  const downloadBtn = document.getElementById('historyDownloadBtn');
  const flashBtn = document.getElementById('historyFlashBtn');
  const analysisEl = document.getElementById('historyAnalysisText');
  const verifEl = document.getElementById('historyVerification');
  const subtitleEl = document.getElementById('historyPageSubtitle');
  const titleEl = document.getElementById('historyPageTitle');

  const SVGNS = 'http://www.w3.org/2000/svg';
  const VB = 1000;           // taille logique du viewBox (carré)
  const FRAME_MS = 420;      // ≈ 2,4 images/s
  const Z_MAX = 8;

  let historyDate = null;
  let slotFrames = [];       // [{ hour, colors:[...] }] par créneau
  let cellEls = [];          // <rect> des cellules
  let curColors = [];        // couleurs appliquées (diff pour limiter les écritures DOM)
  let flashLayer = null;     // <g> des impacts
  let projection = null;     // buildGifFranceProjection(...)
  let frameIndex = 0;
  let playing = false;
  let timer = null;
  let loadToken = 0;
  let showFlashes = false;
  let dayFlashPoints = [];
  let flashPointsDate = null;

  function formatDateLabel(iso) {
    try {
      const parsed = new Date(`${iso}T12:00:00`);
      if (Number.isNaN(parsed.getTime())) return iso;
      return new Intl.DateTimeFormat('fr-FR', { weekday: 'short', day: '2-digit', month: '2-digit', year: 'numeric' })
        .format(parsed).replace('.', '');
    } catch (_) {
      return iso;
    }
  }

  function hourText(hour) {
    const value = Number.isFinite(hour) ? hour : 0;
    return `${String(value).padStart(2, '0')}:00`;
  }

  function setHint(message) {
    if (controlsEl) controlsEl.hidden = true;
    if (frameEl) frameEl.hidden = true;
    if (emptyHintEl) { emptyHintEl.hidden = false; emptyHintEl.textContent = message; }
  }

  async function loadDates() {
    if (!dateListEl) return;
    try {
      const response = await fetch('/api/history/dates');
      const data = await response.json().catch(() => ({}));
      renderDateList(Array.isArray(data?.dates) ? data.dates : []);
    } catch (_) {
      dateListEl.innerHTML = '<div class="history-dates-empty">Historique indisponible.</div>';
    }
  }

  function renderDateList(dates) {
    if (!dateListEl) return;
    if (!dates.length) {
      dateListEl.innerHTML = '<div class="history-dates-empty">Aucune date archivée pour l’instant.</div>';
      slotFrames = [];
      setHint('L’historique se remplira au fil des préchargements AROME.');
      if (analysisEl) analysisEl.textContent = 'Aucune grille archivée pour l’instant.';
      return;
    }
    dateListEl.innerHTML = '';
    dates.forEach((item) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'history-date-btn';
      btn.dataset.date = item.date;
      const day = document.createElement('span');
      day.className = 'history-date-day';
      day.textContent = formatDateLabel(item.date);
      const count = document.createElement('span');
      count.className = 'history-date-count';
      count.textContent = `${item.slot_count}/24`;
      btn.append(day, count);
      btn.addEventListener('click', () => selectDate(item.date));
      dateListEl.appendChild(btn);
    });
    if (!historyDate || !dates.some((item) => item.date === historyDate)) {
      selectDate(dates[0].date);
    } else {
      highlightActiveDate();
    }
  }

  function highlightActiveDate() {
    if (!dateListEl) return;
    dateListEl.querySelectorAll('.history-date-btn').forEach((btn) => {
      btn.classList.toggle('active', btn.dataset.date === historyDate);
    });
  }

  // L'app live peut saturer les connexions du navigateur pendant un préchargement
  // AROME : on borne chaque tentative et on réessaie.
  async function fetchDay(date, token, attempt = 1) {
    const controller = new AbortController();
    const t = window.setTimeout(() => controller.abort(), 12000);
    try {
      const response = await fetch(`/api/history/day?date=${encodeURIComponent(date)}`, { signal: controller.signal });
      window.clearTimeout(t);
      return await response.json().catch(() => ({}));
    } catch (_) {
      window.clearTimeout(t);
      if (token === loadToken && attempt < 4) {
        setHint(`Chargement de la grille archivée… (tentative ${attempt + 1})`);
        await new Promise((resolve) => window.setTimeout(resolve, 800));
        if (token !== loadToken) return {};
        return fetchDay(date, token, attempt + 1);
      }
      return {};
    }
  }

  const cellKey = (cell) => `${(+cell.lat).toFixed(3)}|${(+cell.lon).toFixed(3)}`;

  function projectCellRect(cell, proj) {
    const halfH = (Number(cell.cell_height_deg) || 0.135) / 2;
    const halfW = (Number(cell.cell_width_deg) || 0.18) / 2;
    const nw = proj.project(Number(cell.lon) - halfW, Number(cell.lat) + halfH);
    const se = proj.project(Number(cell.lon) + halfW, Number(cell.lat) - halfH);
    if (!nw || !se) return null;
    const x = Math.min(nw.x, se.x);
    const y = Math.min(nw.y, se.y);
    const w = Math.abs(se.x - nw.x);
    const h = Math.abs(se.y - nw.y);
    return { x, y, w: w + 0.5, h: h + 0.5 }; // léger overlap anti-couture
  }

  function ringsToPath(rings, proj) {
    let d = '';
    for (const ring of rings) {
      if (!Array.isArray(ring) || ring.length < 2) continue;
      for (let j = 0; j < ring.length; j += 1) {
        const p = proj.project(Number(ring[j][0]), Number(ring[j][1])); // ring point = [lon, lat]
        if (!p) continue;
        d += (j === 0 ? 'M' : 'L') + p.x.toFixed(1) + ' ' + p.y.toFixed(1);
      }
      d += 'Z';
    }
    return d;
  }

  // Construit le SVG (DOM) une fois pour la journée + retourne les couleurs par créneau.
  function buildSvg(day) {
    if (!frameEl || typeof buildGifFranceProjection !== 'function') return null;
    const slots = (typeof getRenderableSlots === 'function')
      ? getRenderableSlots(day)
      : (Array.isArray(day?.slots) ? day.slots : []);
    if (!slots.length) return null;
    const proj = buildGifFranceProjection({ left: 0, top: 0, width: VB, height: VB });
    projection = proj;
    const color = (typeof gifScoreColor === 'function') ? gifScoreColor : ((s) => (typeof colorFromScore === 'function' ? colorFromScore(s) : '#3a6'));
    const baseColor = color(0);

    // 1) géométrie : union des cellules sur tous les créneaux
    const idxByKey = new Map();
    const geom = [];
    for (const slot of slots) {
      for (const cell of (slot.cells || [])) {
        if (!cell || cell.source_provider !== 'meteofrance_arome_grib' || cell.lat == null || cell.lon == null) continue;
        const key = cellKey(cell);
        if (!idxByKey.has(key)) {
          const g = projectCellRect(cell, proj);
          if (g) { idxByKey.set(key, geom.length); geom.push(g); }
        }
      }
    }
    if (!geom.length) return null;
    const n = geom.length;

    // 2) couleurs par créneau
    const frames = slots.map((slot, i) => {
      const colors = new Array(n).fill(baseColor);
      for (const cell of (slot.cells || [])) {
        if (!cell || cell.source_provider !== 'meteofrance_arome_grib') continue;
        const idx = idxByKey.get(cellKey(cell));
        if (idx != null) colors[idx] = color(Number(cell.trigger_score) || 0);
      }
      return { hour: (typeof gifSlotHour === 'function') ? gifSlotHour(slot, i) : i, colors };
    });

    // 3) DOM SVG
    const clipRings = (typeof FRANCE_GRID_CLIP_RINGS !== 'undefined' && Array.isArray(FRANCE_GRID_CLIP_RINGS) && FRANCE_GRID_CLIP_RINGS.length)
      ? FRANCE_GRID_CLIP_RINGS
      : ((typeof FRANCE_DEPARTMENT_RINGS !== 'undefined' && Array.isArray(FRANCE_DEPARTMENT_RINGS)) ? FRANCE_DEPARTMENT_RINGS : []);
    const deptRings = (typeof FRANCE_DEPARTMENT_RINGS !== 'undefined' && Array.isArray(FRANCE_DEPARTMENT_RINGS)) ? FRANCE_DEPARTMENT_RINGS : clipRings;
    const clipPathData = clipRings.length ? ringsToPath(clipRings, proj) : '';
    const bordersData = deptRings.length ? ringsToPath(deptRings, proj) : '';

    while (frameEl.firstChild) frameEl.removeChild(frameEl.firstChild);
    frameEl.setAttribute('viewBox', `0 0 ${VB} ${VB}`);
    frameEl.setAttribute('preserveAspectRatio', 'xMidYMid meet');

    if (clipPathData) {
      const defs = document.createElementNS(SVGNS, 'defs');
      const clip = document.createElementNS(SVGNS, 'clipPath');
      clip.setAttribute('id', 'historyFranceClip');
      const cp = document.createElementNS(SVGNS, 'path');
      cp.setAttribute('d', clipPathData);
      clip.appendChild(cp);
      defs.appendChild(clip);
      frameEl.appendChild(defs);
    }
    const bg = document.createElementNS(SVGNS, 'rect');
    bg.setAttribute('x', '0'); bg.setAttribute('y', '0');
    bg.setAttribute('width', String(VB)); bg.setAttribute('height', String(VB));
    bg.setAttribute('fill', '#070f1c');
    frameEl.appendChild(bg);

    if (clipPathData) {
      const base = document.createElementNS(SVGNS, 'path');
      base.setAttribute('d', clipPathData);
      base.setAttribute('fill', baseColor);
      frameEl.appendChild(base);
    }

    const cellsG = document.createElementNS(SVGNS, 'g');
    if (clipPathData) cellsG.setAttribute('clip-path', 'url(#historyFranceClip)');
    cellEls = geom.map((g) => {
      const r = document.createElementNS(SVGNS, 'rect');
      r.setAttribute('x', g.x.toFixed(2));
      r.setAttribute('y', g.y.toFixed(2));
      r.setAttribute('width', g.w.toFixed(2));
      r.setAttribute('height', g.h.toFixed(2));
      r.setAttribute('fill', baseColor);
      cellsG.appendChild(r);
      return r;
    });
    frameEl.appendChild(cellsG);
    curColors = new Array(n).fill(baseColor);

    if (bordersData) {
      const borders = document.createElementNS(SVGNS, 'path');
      borders.setAttribute('d', bordersData);
      borders.setAttribute('fill', 'none');
      borders.setAttribute('stroke', 'rgba(148,163,184,0.32)');
      borders.setAttribute('stroke-width', '0.7');
      borders.setAttribute('vector-effect', 'non-scaling-stroke');
      frameEl.appendChild(borders);
    }

    flashLayer = document.createElementNS(SVGNS, 'g');
    frameEl.appendChild(flashLayer);
    return frames;
  }

  async function selectDate(date) {
    historyDate = date;
    highlightActiveDate();
    pause();
    resetZoom();
    const token = ++loadToken;
    loadVerification(date);
    ensureFlashPoints(date); // couche SVG séparée -> pas besoin d'attendre
    setHint('Chargement de la grille archivée…');
    try {
      const data = await fetchDay(date, token);
      if (token !== loadToken) return;
      const day = data?.payload?.days?.[0] || null;
      if (!data?.ok || !day) {
        slotFrames = [];
        setHint(data?.message || 'Aucune grille archivée pour cette date.');
        if (analysisEl) analysisEl.textContent = data?.message || 'Aucune grille archivée pour cette date.';
        return;
      }
      const frames = buildSvg(day);
      if (token !== loadToken) return;
      if (!frames || !frames.length) {
        setHint('Aucune cellule exploitable pour cette journée.');
        return;
      }
      setupPlayer(frames, computeAnalysisHtml(day));
    } catch (_) {
      if (token === loadToken) setHint('Erreur de chargement de l’historique.');
    }
  }

  function setupPlayer(frames, analysisHtml) {
    slotFrames = frames;
    frameIndex = 0;
    if (scrubber) { scrubber.min = 0; scrubber.max = Math.max(0, frames.length - 1); scrubber.value = 0; }
    if (controlsEl) controlsEl.hidden = false;
    if (emptyHintEl) emptyHintEl.hidden = true;
    if (frameEl) frameEl.hidden = false;
    if (titleEl) titleEl.textContent = 'Historique · animation 24 h';
    if (subtitleEl) {
      const fps = (1000 / FRAME_MS).toFixed(1);
      subtitleEl.textContent = `${historyDate ? formatDateLabel(historyDate) : ''} · ${frames.length} h animées · SVG · ${fps} img/s`;
    }
    if (analysisEl) analysisEl.innerHTML = analysisHtml || 'Pas de synthèse disponible pour cette journée.';
    showHour(0);
    play();
  }

  function showHour(index) {
    if (!slotFrames.length) return;
    frameIndex = ((index % slotFrames.length) + slotFrames.length) % slotFrames.length;
    const colors = slotFrames[frameIndex].colors;
    for (let k = 0; k < cellEls.length; k += 1) {
      if (colors[k] !== curColors[k]) {
        cellEls[k].setAttribute('fill', colors[k]);
        curColors[k] = colors[k];
      }
    }
    renderFlashHour(slotFrames[frameIndex].hour);
    if (scrubber) scrubber.value = String(frameIndex);
    if (hourLabel) hourLabel.textContent = hourText(slotFrames[frameIndex].hour);
  }

  function tick() { showHour(frameIndex + 1); }

  function play() {
    if (playing || slotFrames.length < 2) return;
    playing = true;
    if (playBtn) { playBtn.textContent = '⏸'; playBtn.setAttribute('aria-label', 'Pause'); }
    timer = window.setInterval(tick, FRAME_MS);
  }

  function pause() {
    playing = false;
    if (playBtn) { playBtn.textContent = '▶'; playBtn.setAttribute('aria-label', 'Lecture'); }
    if (timer) { window.clearInterval(timer); timer = null; }
  }

  // Synthèse textuelle de la journée (réutilise le résumé iso-contours « jour »).
  function computeAnalysisHtml(day) {
    try {
      if (typeof collectPredictionDailyCells === 'function' && typeof predictionBuildAnalysisHtml === 'function') {
        let cells = collectPredictionDailyCells(day, 'day');
        if (typeof smoothPredictionCells === 'function') cells = smoothPredictionCells(cells);
        if (cells.length) return predictionBuildAnalysisHtml(day, cells, 'day');
      }
    } catch (_) { /* ignore */ }
    return 'Pas de synthèse disponible pour cette journée.';
  }

  // --- Vérification prévision vs réalité (foudre MTG-LI observée) ---
  let verifToken = 0;

  function fidelityTone(data) {
    if (!data || data.fidelity == null || data.low_signal) return 'muted';
    const f = data.fidelity;
    if (f >= 70) return 'good';
    if (f >= 45) return 'ok';
    if (f >= 20) return 'mid';
    return 'low';
  }

  const asPct = (x) => (x == null ? '—' : `${Math.round(x * 100)} %`);
  const asNum = (x) => (x == null ? '—' : x);

  async function loadVerification(date) {
    if (!verifEl) return;
    const token = ++verifToken;
    verifEl.innerHTML = '<div class="history-verif-empty">Calcul du score de vérification…</div>';
    try {
      const response = await fetch(`/api/history/verification?date=${encodeURIComponent(date)}`);
      const data = await response.json().catch(() => ({}));
      if (token !== verifToken || date !== historyDate) return;
      renderVerification(data, date);
    } catch (_) {
      if (token === verifToken) verifEl.innerHTML = '<div class="history-verif-empty">Score indisponible.</div>';
    }
  }

  function renderVerification(data, date) {
    if (!verifEl) return;
    if (!data || !data.ok) {
      if (data && data.reason === 'no_observation') {
        verifEl.innerHTML = '<div class="history-verif-empty">Pas encore de foudre observée archivée pour ce jour.</div>'
          + '<button class="history-collect-btn" id="historyCollectBtn" type="button">Collecter la foudre observée (≈ 1 min)</button>';
        const btn = document.getElementById('historyCollectBtn');
        if (btn) btn.addEventListener('click', () => collectLightning(date));
      } else {
        verifEl.innerHTML = `<div class="history-verif-empty">${(data && data.message) || 'Score indisponible.'}</div>`;
      }
      return;
    }
    const tone = fidelityTone(data);
    const c = data.contingency || {};
    const s = data.scores || {};
    const csi = s.csi == null ? '—' : Number(s.csi).toFixed(2);
    verifEl.innerHTML = `
      <div class="history-verif-score tone-${tone}">
        <div class="history-verif-fidelity">${data.fidelity == null ? '—' : data.fidelity}<span>/100</span></div>
        <div class="history-verif-label">${data.label || ''}</div>
      </div>
      <div class="history-verif-metrics">
        <div><span>Détection (POD)</span><b>${asPct(s.pod)}</b></div>
        <div><span>Précision</span><b>${asPct(s.success_ratio)}</b></div>
        <div><span>Succès (CSI)</span><b>${csi}</b></div>
      </div>
      <div class="history-verif-counts">
        <div><b>${asNum(data.forecast_cells)}</b><span>zones prévues</span></div>
        <div><b>${asNum(data.observed_cells)}</b><span>zones observées</span></div>
        <div><b>${asNum(data.flash_total)}</b><span>flashs</span></div>
      </div>
      <div class="history-verif-cont">✔ ${asNum(c.hits)} bonnes · ✘ ${asNum(c.misses)} ratées · ⚠ ${asNum(c.false_alarms)} fausses alertes</div>`;
  }

  async function collectLightning(date) {
    if (!verifEl) return;
    const token = ++verifToken;
    verifEl.innerHTML = '<div class="history-verif-empty">Collecte de la foudre observée… (téléchargement satellite MTG-LI, ≈ 1 min)</div>';
    try {
      const response = await fetch(`/api/history/collect-lightning?date=${encodeURIComponent(date)}`, { method: 'POST' });
      const data = await response.json().catch(() => ({}));
      if (token !== verifToken || date !== historyDate) return;
      if (!data || !data.ok) {
        verifEl.innerHTML = `<div class="history-verif-empty">Collecte impossible : ${(data && data.reason) || 'erreur'}.</div>`;
        return;
      }
      flashPointsDate = null; // forcer le rechargement des points
      ensureFlashPoints(date);
      loadVerification(date);
    } catch (_) {
      if (token === verifToken) verifEl.innerHTML = '<div class="history-verif-empty">Collecte impossible.</div>';
    }
  }

  // --- Foudre observée : points + overlay SVG par heure ---
  async function ensureFlashPoints(date) {
    if (flashPointsDate === date) return;
    flashPointsDate = date;
    dayFlashPoints = [];
    const controller = new AbortController();
    const t = window.setTimeout(() => controller.abort(), 10000);
    try {
      const response = await fetch(`/api/history/lightning?date=${encodeURIComponent(date)}`, { signal: controller.signal });
      const data = await response.json().catch(() => ({}));
      if (flashPointsDate === date && data && data.ok && Array.isArray(data.points)) {
        dayFlashPoints = data.points;
        if (showFlashes && slotFrames.length) renderFlashHour(slotFrames[frameIndex].hour);
      }
    } catch (_) { /* timeout/abort : overlay vide */ }
    finally { window.clearTimeout(t); }
  }

  function renderFlashHour(hour) {
    if (!flashLayer) return;
    while (flashLayer.firstChild) flashLayer.removeChild(flashLayer.firstChild);
    if (!showFlashes || !dayFlashPoints.length || !projection) return;
    const r = VB / 360;
    for (const pt of dayFlashPoints) {
      if (pt[2] !== hour) continue;
      const p = projection.project(pt[1], pt[0]); // project(lon, lat), pt = [lat, lon]
      if (!p) continue;
      const halo = document.createElementNS(SVGNS, 'circle');
      halo.setAttribute('cx', p.x.toFixed(1)); halo.setAttribute('cy', p.y.toFixed(1));
      halo.setAttribute('r', (r * 2.2).toFixed(1)); halo.setAttribute('fill', 'rgba(255,255,255,0.28)');
      flashLayer.appendChild(halo);
      const core = document.createElementNS(SVGNS, 'circle');
      core.setAttribute('cx', p.x.toFixed(1)); core.setAttribute('cy', p.y.toFixed(1));
      core.setAttribute('r', r.toFixed(1)); core.setAttribute('fill', 'rgba(255,255,255,0.98)');
      flashLayer.appendChild(core);
    }
  }

  function updateFlashBtn() {
    if (!flashBtn) return;
    flashBtn.classList.toggle('active', showFlashes);
    flashBtn.setAttribute('aria-pressed', showFlashes ? 'true' : 'false');
  }

  // Export PNG (rasterise le SVG de l'heure courante, France entière).
  function downloadCurrent() {
    if (!frameEl || !slotFrames.length) return;
    const clone = frameEl.cloneNode(true);
    clone.setAttribute('viewBox', `0 0 ${VB} ${VB}`);
    clone.setAttribute('width', String(VB));
    clone.setAttribute('height', String(VB));
    const xml = new XMLSerializer().serializeToString(clone);
    const url = URL.createObjectURL(new Blob([xml], { type: 'image/svg+xml;charset=utf-8' }));
    const img = new Image();
    img.onload = () => {
      const canvas = document.createElement('canvas');
      canvas.width = VB; canvas.height = VB;
      const ctx = canvas.getContext('2d');
      ctx.fillStyle = '#070f1c';
      ctx.fillRect(0, 0, VB, VB);
      ctx.drawImage(img, 0, 0);
      URL.revokeObjectURL(url);
      const link = document.createElement('a');
      link.href = canvas.toDataURL('image/png');
      const h = String(slotFrames[frameIndex].hour).padStart(2, '0');
      link.download = `objectifoudre-historique-${historyDate || ''}-${h}h.png`;
      link.click();
    };
    img.onerror = () => URL.revokeObjectURL(url);
    img.src = url;
  }

  if (playBtn) playBtn.addEventListener('click', () => (playing ? pause() : play()));
  if (scrubber) scrubber.addEventListener('input', () => { pause(); showHour(Number(scrubber.value) || 0); });
  if (downloadBtn) downloadBtn.addEventListener('click', downloadCurrent);
  if (flashBtn) flashBtn.addEventListener('click', () => {
    showFlashes = !showFlashes;
    updateFlashBtn();
    if (slotFrames.length) renderFlashHour(slotFrames[frameIndex].hour);
  });

  // --- Zoom / pan via viewBox SVG (net à tout niveau) ---
  const vb = { x: 0, y: 0, w: VB, h: VB };

  function applyViewBox() {
    if (frameEl) frameEl.setAttribute('viewBox', `${vb.x.toFixed(2)} ${vb.y.toFixed(2)} ${vb.w.toFixed(2)} ${vb.h.toFixed(2)}`);
  }
  function resetZoom() {
    vb.x = 0; vb.y = 0; vb.w = VB; vb.h = VB;
    applyViewBox();
    if (frameEl) frameEl.style.cursor = '';
  }
  function clampVb() {
    vb.w = Math.min(VB, Math.max(VB / Z_MAX, vb.w));
    vb.h = vb.w;
    vb.x = Math.min(VB - vb.w, Math.max(0, vb.x));
    vb.y = Math.min(VB - vb.h, Math.max(0, vb.y));
  }
  function userAt(clientX, clientY) {
    try {
      const ctm = frameEl.getScreenCTM();
      if (ctm) {
        const pt = frameEl.createSVGPoint();
        pt.x = clientX; pt.y = clientY;
        const u = pt.matrixTransform(ctm.inverse());
        return { x: u.x, y: u.y, ax: ctm.a, ay: ctm.d };
      }
    } catch (_) { /* fallback */ }
    const r = frameEl.getBoundingClientRect();
    return { x: vb.x + ((clientX - r.left) / r.width) * vb.w, y: vb.y + ((clientY - r.top) / r.height) * vb.h, ax: r.width / vb.w, ay: r.height / vb.h };
  }
  function zoomAtClient(clientX, clientY, factor) {
    const u = userAt(clientX, clientY);
    const newW = Math.min(VB, Math.max(VB / Z_MAX, vb.w / factor));
    const k = newW / vb.w;
    vb.x = u.x - (u.x - vb.x) * k; // garde le point sous le curseur fixe
    vb.y = u.y - (u.y - vb.y) * k;
    vb.w = newW; vb.h = newW;
    clampVb();
    applyViewBox();
    if (frameEl) frameEl.style.cursor = vb.w < VB ? 'grab' : '';
  }

  if (frameEl) {
    frameEl.addEventListener('wheel', (event) => {
      event.preventDefault();
      zoomAtClient(event.clientX, event.clientY, event.deltaY < 0 ? 1.18 : 1 / 1.18);
    }, { passive: false });
    frameEl.addEventListener('dblclick', resetZoom);

    let dragging = false;
    let lastX = 0;
    let lastY = 0;
    frameEl.addEventListener('mousedown', (event) => {
      if (vb.w >= VB) return;
      dragging = true; lastX = event.clientX; lastY = event.clientY;
      frameEl.style.cursor = 'grabbing';
      event.preventDefault();
    });
    window.addEventListener('mousemove', (event) => {
      if (!dragging) return;
      const u = userAt(event.clientX, event.clientY);
      vb.x -= (event.clientX - lastX) / u.ax;
      vb.y -= (event.clientY - lastY) / u.ay;
      lastX = event.clientX; lastY = event.clientY;
      clampVb(); applyViewBox();
    });
    window.addEventListener('mouseup', () => {
      if (dragging) { dragging = false; frameEl.style.cursor = vb.w < VB ? 'grab' : ''; }
    });

    const touchDist = (t) => Math.hypot(t[0].clientX - t[1].clientX, t[0].clientY - t[1].clientY);
    let mode = null;
    let startDist = 0;
    let lastTouch = null;
    frameEl.addEventListener('touchstart', (event) => {
      if (event.touches.length === 2) {
        mode = 'pinch'; startDist = touchDist(event.touches);
      } else if (event.touches.length === 1 && vb.w < VB) {
        mode = 'pan'; lastTouch = { x: event.touches[0].clientX, y: event.touches[0].clientY };
      } else {
        mode = null;
      }
    }, { passive: false });
    frameEl.addEventListener('touchmove', (event) => {
      if (mode === 'pinch' && event.touches.length === 2) {
        event.preventDefault();
        const d = touchDist(event.touches);
        const factor = d / Math.max(1, startDist);
        startDist = d;
        const cx = (event.touches[0].clientX + event.touches[1].clientX) / 2;
        const cy = (event.touches[0].clientY + event.touches[1].clientY) / 2;
        zoomAtClient(cx, cy, factor);
      } else if (mode === 'pan' && event.touches.length === 1) {
        event.preventDefault();
        const t = event.touches[0];
        const u = userAt(t.clientX, t.clientY);
        vb.x -= (t.clientX - lastTouch.x) / u.ax;
        vb.y -= (t.clientY - lastTouch.y) / u.ay;
        lastTouch = { x: t.clientX, y: t.clientY };
        clampVb(); applyViewBox();
      }
    }, { passive: false });
    frameEl.addEventListener('touchend', (event) => { if (event.touches.length === 0) mode = null; });
  }

  function openHistoryPage() {
    historyPage.setAttribute('aria-hidden', 'false');
    document.body.classList.add('history-open');
    resetZoom();
    loadDates();
  }

  function closeHistoryPage() {
    historyPage.setAttribute('aria-hidden', 'true');
    document.body.classList.remove('history-open');
    pause();
  }

  if (openBtn) openBtn.addEventListener('click', openHistoryPage);
  if (closeBtn) closeBtn.addEventListener('click', closeHistoryPage);
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && historyPage.getAttribute('aria-hidden') === 'false') closeHistoryPage();
  });

  window.openHistoryPage = openHistoryPage;
})();
