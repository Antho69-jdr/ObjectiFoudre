// Écran Historique — vue dédiée, séparée de la carte temps réel.
// Réutilise le moteur de rendu iso-contours de storm-forecast-image.js
// (fonctions globales : collectPredictionDailyCells / smoothPredictionCells /
// drawPredictionImage / predictionBuildAnalysisHtml / predictionPeriodConfig /
// predictionLayerScore), mais alimenté par /api/history/* — aucun couplage avec
// selectedBaseDate ni le modèle de données live.
(function () {
  const historyPage = document.getElementById('historyPage');
  if (!historyPage) return;

  const openBtn = document.getElementById('historyPageBtn');
  const closeBtn = document.getElementById('historyPageCloseBtn');
  const dateListEl = document.getElementById('historyDateList');
  const imageEl = document.getElementById('historyImage');
  const emptyHintEl = document.getElementById('historyEmptyHint');
  const analysisEl = document.getElementById('historyAnalysisText');
  const subtitleEl = document.getElementById('historyPageSubtitle');
  const titleEl = document.getElementById('historyPageTitle');
  const periodButtons = Array.from(historyPage.querySelectorAll('[data-history-period]'));

  let historyPeriodKey = 'day';
  let historyDay = null;
  let historyDate = null;
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

  function setHint(message) {
    if (imageEl) imageEl.hidden = true;
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
      historyDay = null;
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

  async function selectDate(date) {
    historyDate = date;
    highlightActiveDate();
    const token = ++loadToken;
    setHint('Chargement de la grille archivée…');
    try {
      const response = await fetch(`/api/history/day?date=${encodeURIComponent(date)}`);
      const data = await response.json().catch(() => ({}));
      if (token !== loadToken) return;
      const day = data?.payload?.days?.[0] || null;
      if (!data?.ok || !day) {
        historyDay = null;
        setHint(data?.message || 'Aucune grille archivée pour cette date.');
        if (analysisEl) analysisEl.textContent = data?.message || 'Aucune grille archivée pour cette date.';
        return;
      }
      historyDay = day;
      render();
    } catch (_) {
      if (token !== loadToken) return;
      setHint('Erreur de chargement de l’historique.');
    }
  }

  // Comme generatePredictionPageImage mais sans le verrou de complétude (08-08) :
  // on rend ce qui est archivé, même pour une journée partielle.
  function generateImage(day, periodKey) {
    if (typeof collectPredictionDailyCells !== 'function' || typeof drawPredictionImage !== 'function') {
      return { ok: false, message: 'Moteur de rendu indisponible.' };
    }
    const period = (typeof predictionPeriodConfig === 'function')
      ? predictionPeriodConfig(periodKey)
      : { key: periodKey, label: periodKey };
    let cells = collectPredictionDailyCells(day, period.key);
    if (typeof smoothPredictionCells === 'function') cells = smoothPredictionCells(cells);
    if (!cells || !cells.length) {
      return { ok: false, periodKey: period.key, periodLabel: period.label, message: `Aucune cellule archivée pour ${(period.label || '').toLowerCase()}.` };
    }
    const dataUrl = drawPredictionImage(day, cells, period.key);
    const analysisHtml = (typeof predictionBuildAnalysisHtml === 'function') ? predictionBuildAnalysisHtml(day, cells, period.key) : '';
    const maxScore = (typeof predictionLayerScore === 'function') ? Math.max(...cells.map((cell) => predictionLayerScore(cell)), 0) : 0;
    return { ok: true, periodKey: period.key, periodLabel: period.label, dataUrl, analysisHtml, maxScore };
  }

  function render() {
    updatePeriodTabs();
    if (!historyDay) return;
    const result = generateImage(historyDay, historyPeriodKey);
    const dateText = historyDate ? formatDateLabel(historyDate) : '';
    if (titleEl) {
      titleEl.textContent = result.periodKey === 'day'
        ? 'Historique · carte journalière'
        : `Historique · ${result.periodLabel || ''}`;
    }
    if (subtitleEl) {
      subtitleEl.textContent = result.ok
        ? `${dateText} · max ${Math.round(result.maxScore)}/100`
        : `${dateText} · ${result.message || ''}`;
    }
    if (result.ok && result.dataUrl) {
      if (imageEl) {
        imageEl.src = result.dataUrl;
        imageEl.alt = `Carte de risque archivée ${dateText}`;
        imageEl.hidden = false;
      }
      if (emptyHintEl) emptyHintEl.hidden = true;
      if (analysisEl) analysisEl.innerHTML = result.analysisHtml || '';
    } else {
      setHint(result.message || 'Carte indisponible pour cette période.');
      if (analysisEl) analysisEl.textContent = result.message || 'Carte indisponible pour cette période.';
    }
  }

  function updatePeriodTabs() {
    periodButtons.forEach((btn) => {
      const active = btn.dataset.historyPeriod === historyPeriodKey;
      btn.classList.toggle('active', active);
      btn.setAttribute('aria-selected', active ? 'true' : 'false');
    });
  }

  periodButtons.forEach((btn) => {
    btn.addEventListener('click', () => {
      historyPeriodKey = btn.dataset.historyPeriod || 'day';
      render();
    });
  });

  function openHistoryPage() {
    historyPage.setAttribute('aria-hidden', 'false');
    document.body.classList.add('history-open');
    loadDates();
  }

  function closeHistoryPage() {
    historyPage.setAttribute('aria-hidden', 'true');
    document.body.classList.remove('history-open');
  }

  if (openBtn) openBtn.addEventListener('click', openHistoryPage);
  if (closeBtn) closeBtn.addEventListener('click', closeHistoryPage);
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && historyPage.getAttribute('aria-hidden') === 'false') closeHistoryPage();
  });

  window.openHistoryPage = openHistoryPage;
})();
