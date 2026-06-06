// Écran Historique — vue dédiée, séparée de la carte temps réel.
// Rejoue une journée archivée en ANIMATION 24 h, façon export vidéo/GIF :
// fond France + grille colorée, rendue en haute qualité puis encodée en frames
// JPEG (légères) via le moteur global de controls.js (drawGridAnimationFrame).
// Alimenté par /api/history/* — aucun couplage avec le modèle de données live.
(function () {
  const historyPage = document.getElementById('historyPage');
  if (!historyPage) return;

  const openBtn = document.getElementById('historyPageBtn');
  const closeBtn = document.getElementById('historyPageCloseBtn');
  const dateListEl = document.getElementById('historyDateList');
  const frameEl = document.getElementById('historyFrame');
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

  const FRAME_SIZE = 3840;     // 4K (carré) — chaque frame est lourde à générer
  const JPEG_QUALITY = 0.9;    // léger mais net
  const FRAME_MS = 420;        // ≈ 2,4 images/s

  let historyDate = null;
  let frames = [];             // [{ slotKey, hour, dataUrl }]
  let frameIndex = 0;
  let playing = false;
  let timer = null;
  let loadToken = 0;
  const framesByDate = new Map(); // cache des frames générées, par (date, overlay)
  let showFlashes = false;        // overlay des impacts de foudre observés
  let dayFlashPoints = [];        // points [lat, lon] de la date courante
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
      frames = [];
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
  // AROME : on borne chaque tentative et on réessaie (le cache serveur rend les
  // retries quasi instantanés une fois une connexion obtenue).
  async function fetchDay(date, token, attempt = 1) {
    const controller = new AbortController();
    const timer = window.setTimeout(() => controller.abort(), 12000);
    try {
      const response = await fetch(`/api/history/day?date=${encodeURIComponent(date)}`, { signal: controller.signal });
      window.clearTimeout(timer);
      return await response.json().catch(() => ({}));
    } catch (_) {
      window.clearTimeout(timer);
      if (token === loadToken && attempt < 4) {
        setHint(`Chargement de la grille archivée… (tentative ${attempt + 1})`);
        await new Promise((resolve) => window.setTimeout(resolve, 800));
        if (token !== loadToken) return {};
        return fetchDay(date, token, attempt + 1);
      }
      return {};
    }
  }

  async function selectDate(date) {
    historyDate = date;
    highlightActiveDate();
    pause();
    const token = ++loadToken;
    loadVerification(date);  // indépendant de la génération de l'animation
    // les points de foudre doivent être prêts AVANT de cuire l'overlay dans les frames
    if (showFlashes) { await ensureFlashPoints(date); if (token !== loadToken) return; }
    else { ensureFlashPoints(date); }
    // Frames 4K déjà générées pour cette (date, overlay) -> réaffichage instantané.
    const cacheKey = `${date}|${showFlashes ? 'f' : 'n'}`;
    const cached = framesByDate.get(cacheKey);
    if (cached && cached.frames.length) {
      frames = cached.frames;
      setupPlayer(cached.analysisHtml);
      return;
    }
    setHint('Chargement de la grille archivée…');
    try {
      const data = await fetchDay(date, token);
      if (token !== loadToken) return;
      const day = data?.payload?.days?.[0] || null;
      if (!data?.ok || !day) {
        frames = [];
        setHint(data?.message || 'Aucune grille archivée pour cette date.');
        if (analysisEl) analysisEl.textContent = data?.message || 'Aucune grille archivée pour cette date.';
        return;
      }
      const built = await buildFrames(day, token);
      if (token !== loadToken) return;
      frames = built;
      if (!frames.length) {
        setHint('Aucune cellule exploitable pour cette journée.');
        return;
      }
      const analysisHtml = computeAnalysisHtml(day);
      framesByDate.set(cacheKey, { frames: built, analysisHtml });
      while (framesByDate.size > 6) framesByDate.delete(framesByDate.keys().next().value);
      setupPlayer(analysisHtml);
    } catch (_) {
      if (token === loadToken) setHint('Erreur de chargement de l’historique.');
    }
  }

  // Rend chaque créneau via le moteur d'export (fond France + grille colorée +
  // bandeau timeline) puis encode en JPEG 4K. Chaque frame est lourde : on affiche
  // la progression et on cède la main à CHAQUE frame pour ne pas figer l'UI.
  async function buildFrames(day, token) {
    if (typeof drawGridAnimationFrame !== 'function') return [];
    const slots = (typeof getRenderableSlots === 'function')
      ? getRenderableSlots(day)
      : (Array.isArray(day?.slots) ? day.slots : []);
    if (!slots.length) return [];
    const canvas = document.createElement('canvas');
    canvas.width = FRAME_SIZE;
    canvas.height = FRAME_SIZE;
    const ctx = canvas.getContext('2d');
    const out = [];
    setHint(`Génération de l’animation 4K… 0/${slots.length}`);
    await new Promise((resolve) => requestAnimationFrame(resolve));
    for (let i = 0; i < slots.length; i += 1) {
      const slotHour = (typeof gifSlotHour === 'function') ? gifSlotHour(slots[i], i) : i;
      try {
        drawGridAnimationFrame(ctx, slots[i], day, i, slots.length, slots, { labels: false, footer: false, title: false });
        if (showFlashes && dayFlashPoints.length) drawFlashOverlay(ctx, slotHour);
      } catch (_) {
        continue;
      }
      out.push({
        slotKey: slots[i].slot_key,
        hour: slotHour,
        dataUrl: canvas.toDataURL('image/jpeg', JPEG_QUALITY),
      });
      setHint(`Génération de l’animation 4K… ${out.length}/${slots.length}`);
      await new Promise((resolve) => requestAnimationFrame(resolve));
      if (token !== loadToken) return [];
    }
    return out;
  }

  function setupPlayer(analysisHtml) {
    frameIndex = 0;
    if (scrubber) { scrubber.min = 0; scrubber.max = Math.max(0, frames.length - 1); scrubber.value = 0; }
    if (controlsEl) controlsEl.hidden = false;
    if (emptyHintEl) emptyHintEl.hidden = true;
    if (frameEl) frameEl.hidden = false;
    if (titleEl) titleEl.textContent = 'Historique · animation 24 h';
    if (subtitleEl) {
      const fps = (1000 / FRAME_MS).toFixed(1);
      subtitleEl.textContent = `${historyDate ? formatDateLabel(historyDate) : ''} · ${frames.length} h animées · 4K · ${fps} img/s`;
    }
    if (analysisEl) analysisEl.innerHTML = analysisHtml || 'Pas de synthèse disponible pour cette journée.';
    showFrame(0);
    play();
  }

  function showFrame(index) {
    if (!frames.length) return;
    frameIndex = ((index % frames.length) + frames.length) % frames.length;
    const frame = frames[frameIndex];
    if (frameEl && frame) {
      frameEl.src = frame.dataUrl;
      frameEl.alt = `Grille ${historyDate || ''} à ${hourText(frame.hour)}`;
    }
    if (scrubber) scrubber.value = String(frameIndex);
    if (hourLabel && frame) hourLabel.textContent = hourText(frame.hour);
  }

  function tick() {
    showFrame(frameIndex + 1);
  }

  function play() {
    if (playing || frames.length < 2) return;
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
  // Retourne le HTML pour qu'il soit mis en cache avec les frames.
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
      loadVerification(date);
    } catch (_) {
      if (token === verifToken) verifEl.innerHTML = '<div class="history-verif-empty">Collecte impossible.</div>';
    }
  }

  // --- Overlay des impacts de foudre observés (MTG-LI) sur la carte ---
  async function ensureFlashPoints(date) {
    if (flashPointsDate === date) return;
    flashPointsDate = date;
    dayFlashPoints = [];
    const controller = new AbortController();
    const timer = window.setTimeout(() => controller.abort(), 10000);
    try {
      const response = await fetch(`/api/history/lightning?date=${encodeURIComponent(date)}`, { signal: controller.signal });
      const data = await response.json().catch(() => ({}));
      if (flashPointsDate === date && data && data.ok && Array.isArray(data.points)) {
        dayFlashPoints = data.points;
      }
    } catch (_) { /* timeout/abort : overlay vide, on ne bloque pas le build */ }
    finally { window.clearTimeout(timer); }
  }

  // Dessine les impacts de l'HEURE donnée sur le canvas d'une frame, en réutilisant
  // EXACTEMENT la projection France du moteur GIF (mêmes marges que
  // drawGridAnimationFrame) -> la foudre est synchronisée à l'animation.
  function drawFlashOverlay(ctx, hour) {
    if (typeof buildGifFranceProjection !== 'function') return;
    const W = ctx.canvas.width;
    const H = ctx.canvas.height;
    const top = Math.round(H * 0.02); // doit matcher le mode minimal (titre masqué)
    const bottom = Math.round(H * 0.03); // doit matcher le mode minimal (footer masqué)
    const side = Math.round(W * 0.03);
    const mapRect = { left: side, top, width: W - side * 2, height: H - top - bottom };
    const proj = buildGifFranceProjection(mapRect);
    if (!proj || typeof proj.project !== 'function') return;
    const core = Math.max(1.5, W / 900);
    ctx.save();
    ctx.beginPath();
    ctx.rect(mapRect.left, mapRect.top, mapRect.width, mapRect.height);
    ctx.clip();
    for (const pt of dayFlashPoints) {
      if (pt[2] !== hour) continue; // seulement les flashs de cette heure
      const p = proj.project(pt[1], pt[0]); // project(lon, lat), pt = [lat, lon]
      if (!p) continue;
      ctx.beginPath();
      ctx.fillStyle = 'rgba(255, 255, 255, 0.28)'; // halo blanc
      ctx.arc(p.x, p.y, core * 2.4, 0, Math.PI * 2);
      ctx.fill();
      ctx.beginPath();
      ctx.fillStyle = 'rgba(255, 255, 255, 0.98)'; // cœur blanc
      ctx.arc(p.x, p.y, core, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();
  }

  function updateFlashBtn() {
    if (!flashBtn) return;
    flashBtn.classList.toggle('active', showFlashes);
    flashBtn.setAttribute('aria-pressed', showFlashes ? 'true' : 'false');
  }

  if (playBtn) playBtn.addEventListener('click', () => (playing ? pause() : play()));
  if (scrubber) scrubber.addEventListener('input', () => { pause(); showFrame(Number(scrubber.value) || 0); });
  if (downloadBtn) downloadBtn.addEventListener('click', () => {
    const frame = frames[frameIndex];
    if (!frame) return;
    const link = document.createElement('a');
    link.href = frame.dataUrl;
    link.download = `objectifoudre-historique-${historyDate || ''}-${String(frame.hour).padStart(2, '0')}h.jpg`;
    link.click();
  });

  if (flashBtn) flashBtn.addEventListener('click', () => {
    showFlashes = !showFlashes;
    updateFlashBtn();
    if (historyDate) selectDate(historyDate); // régénère les frames (avec/sans overlay, mis en cache)
  });

  function openHistoryPage() {
    historyPage.setAttribute('aria-hidden', 'false');
    document.body.classList.add('history-open');
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
