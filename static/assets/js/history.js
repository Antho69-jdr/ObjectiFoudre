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
  const analysisEl = document.getElementById('historyAnalysisText');
  const subtitleEl = document.getElementById('historyPageSubtitle');
  const titleEl = document.getElementById('historyPageTitle');

  const FRAME_SIZE = 1280;     // haute qualité
  const JPEG_QUALITY = 0.9;    // léger mais net
  const FRAME_MS = 420;        // ≈ 2,4 images/s

  let historyDate = null;
  let frames = [];             // [{ slotKey, hour, dataUrl }]
  let frameIndex = 0;
  let playing = false;
  let timer = null;
  let loadToken = 0;

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
      setHint('Génération de l’animation haute qualité…');
      const built = await buildFrames(day, token);
      if (token !== loadToken) return;
      frames = built;
      if (!frames.length) {
        setHint('Aucune cellule exploitable pour cette journée.');
        return;
      }
      setupPlayer(day);
    } catch (_) {
      if (token === loadToken) setHint('Erreur de chargement de l’historique.');
    }
  }

  // Rend chaque créneau via le moteur d'export (fond France + grille colorée +
  // bandeau timeline) puis encode en JPEG. Cède la main toutes les 4 frames pour
  // ne pas figer l'UI.
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
    for (let i = 0; i < slots.length; i += 1) {
      try {
        drawGridAnimationFrame(ctx, slots[i], day, i, slots.length, slots);
      } catch (_) {
        continue;
      }
      out.push({
        slotKey: slots[i].slot_key,
        hour: (typeof gifSlotHour === 'function') ? gifSlotHour(slots[i], i) : i,
        dataUrl: canvas.toDataURL('image/jpeg', JPEG_QUALITY),
      });
      if ((i & 3) === 3) {
        await new Promise((resolve) => requestAnimationFrame(resolve));
        if (token !== loadToken) return [];
      }
    }
    return out;
  }

  function setupPlayer(day) {
    frameIndex = 0;
    if (scrubber) { scrubber.min = 0; scrubber.max = Math.max(0, frames.length - 1); scrubber.value = 0; }
    if (controlsEl) controlsEl.hidden = false;
    if (emptyHintEl) emptyHintEl.hidden = true;
    if (frameEl) frameEl.hidden = false;
    if (titleEl) titleEl.textContent = 'Historique · animation 24 h';
    if (subtitleEl) {
      const fps = (1000 / FRAME_MS).toFixed(1);
      subtitleEl.textContent = `${historyDate ? formatDateLabel(historyDate) : ''} · ${frames.length} h animées · ${fps} img/s`;
    }
    renderAnalysis(day);
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
  function renderAnalysis(day) {
    if (!analysisEl) return;
    try {
      if (typeof collectPredictionDailyCells === 'function' && typeof predictionBuildAnalysisHtml === 'function') {
        let cells = collectPredictionDailyCells(day, 'day');
        if (typeof smoothPredictionCells === 'function') cells = smoothPredictionCells(cells);
        analysisEl.innerHTML = cells.length
          ? predictionBuildAnalysisHtml(day, cells, 'day')
          : 'Pas de synthèse disponible pour cette journée.';
      }
    } catch (_) {
      analysisEl.textContent = 'Synthèse indisponible.';
    }
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
