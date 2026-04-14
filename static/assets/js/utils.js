    function getTodayIsoDate() {
      const now = new Date();
      const year = now.getFullYear();
      const month = String(now.getMonth() + 1).padStart(2, '0');
      const day = String(now.getDate()).padStart(2, '0');
      return `${year}-${month}-${day}`;
    }

    function normalizeDateIso(value) {
      if (typeof value !== 'string') return getTodayIsoDate();
      return /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : getTodayIsoDate();
    }

    function syncDateControls() {
      const nextDate = normalizeDateIso(selectedBaseDate);
      selectedBaseDate = nextDate;
      if (dateInput) dateInput.value = nextDate;
    }

    function isCoarsePointerDevice() {
      try {
        return window.matchMedia('(hover: none), (pointer: coarse)').matches;
      } catch (_) {
        return false;
      }
    }

    function prefersReducedGridMotion(cells = []) {
      const hasManyCells = Array.isArray(cells) && cells.length >= GRID_ANIMATION_MAX_CELLS;
      return isCoarsePointerDevice() || hasManyCells;
    }

    function applySelectedDate(nextDate, { force = true, loadingMessage = 'Chargement de la date…' } = {}) {
      const normalized = normalizeDateIso(nextDate);
      if (normalized === selectedBaseDate && !force) return;
      selectedBaseDate = normalized;
      syncDateControls();
      selectedDayKey = null;
      selectedSlotKey = null;
      closeSelection();
      closeDetails();
      refreshCurrentData(force, loadingMessage);
    }

    function colorFromScore(score) {
      const s = Math.max(0, Math.min(100, Number(score) || 0));
      const stops = [
        { at: 0, c: [37, 99, 235] },
        { at: 35, c: [34, 197, 94] },
        { at: 65, c: [245, 158, 11] },
        { at: 85, c: [239, 68, 68] },
      ];
      let a = stops[0], b = stops[1];
      if (s >= 65) { a = stops[2]; b = stops[3]; }
      else if (s >= 35) { a = stops[1]; b = stops[2]; }
      const t = (s - a.at) / Math.max(1, (b.at - a.at));
      const r = Math.round(a.c[0] + (b.c[0] - a.c[0]) * t);
      const g = Math.round(a.c[1] + (b.c[1] - a.c[1]) * t);
      const b2 = Math.round(a.c[2] + (b.c[2] - a.c[2]) * t);
      return `rgb(${r}, ${g}, ${b2})`;
    }

    function getCellMetricValue(cell, metric = selectedColorMetric) {
      if (!cell) return 0;
      return Number(cell?.[metric] ?? cell?.score_global ?? 0) || 0;
    }

    function getCellFillColor(cell) {
      return colorFromScore(getCellMetricValue(cell));
    }

    function syncLayerModeUI() {
      document.querySelectorAll('.layer-option').forEach((btn) => {
        btn.classList.toggle('active', btn.dataset.layerMetric === selectedColorMetric);
      });
      if (layerModeBtn) layerModeBtn.classList.toggle('active', selectedColorMetric !== 'score_global');
    }

    function opacityFromConfidence(confidence) {
      const c = Math.max(0, Math.min(100, Number(confidence) || 0));
      return 0.12 + (c / 100) * 0.48;
    }

    function getDays() {
      return (payload?.days || []).slice().sort((a, b) => a.day_index - b.day_index);
    }

    function getCurrentDay() {
      return getDays().find(d => d.day_key === selectedDayKey) || null;
    }

    function getCurrentSlot() {
      return getCurrentDay()?.slots?.find(s => s.slot_key === selectedSlotKey) || null;
    }

    function sanitizeCenter(center) {
      const lat = Number(center?.lat);
      const lon = Number(center?.lon);
      const label = String(center?.label || '').trim();
      if (!Number.isFinite(lat) || !Number.isFinite(lon) || !label) return { ...DEFAULT_CENTER };
      return { lat, lon, label };
    }

    function loadStoredCenter() {
      try {
        const raw = localStorage.getItem('storm_center');
        if (!raw) return { ...DEFAULT_CENTER };
        return sanitizeCenter(JSON.parse(raw));
      } catch (_) {
        return { ...DEFAULT_CENTER };
      }
    }

    function saveCurrentCenter() {
      try {
        localStorage.setItem('storm_center', JSON.stringify(currentCenter));
      } catch (_) {}
    }

    function formatFrenchRun(dateString) {
      if (!dateString) return '—';
      const parsed = new Date(dateString);
      if (Number.isNaN(parsed.getTime())) return String(dateString);
      const formatted = new Intl.DateTimeFormat('fr-FR', {
        timeZone: 'Europe/Paris', year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit', hour12: false
      }).format(parsed).replace(',', '');
      const tzPart = new Intl.DateTimeFormat('fr-FR', {
        timeZone: 'Europe/Paris', timeZoneName: 'shortOffset', hour: '2-digit'
      }).formatToParts(parsed).find(part => part.type === 'timeZoneName')?.value || 'GMT+2';
      return `${formatted} ${tzPart}`;
    }

    async function geocodeCity(query, signal) {
      const q = query.trim();
      if (!q) throw new Error('Ville vide');
      const variants = Array.from(new Set([
        q,
        q.normalize('NFD').replace(/[̀-ͯ]/g, ''),
        q.replace(/[-_]+/g, ' ')
      ].map(v => v.trim()).filter(Boolean)));
      const attempts = [];
      for (const variant of variants) {
        attempts.push(`https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(variant)}&count=8&language=fr&countryCode=FR&format=json`);
        attempts.push(`https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(variant)}&count=8&language=fr&format=json`);
      }
      let lastErr = null;
      for (const url of attempts) {
        try {
          const response = await fetch(url, { cache: 'no-store', signal });
          if (!response.ok) throw new Error(`Geocoding HTTP ${response.status}`);
          const data = await response.json();
          const results = Array.isArray(data?.results) ? data.results : [];
          if (!results.length) continue;
          const exact = results.find(r => String(r.name || '').toLowerCase() === q.toLowerCase());
          const first = exact || results[0];
          const labelParts = [first.name, first.admin1, first.country].filter(Boolean);
          return { lat: Number(first.latitude), lon: Number(first.longitude), label: labelParts.join(', ') || first.name };
        } catch (err) {
          if (err?.name === 'AbortError') throw err;
          lastErr = err;
        }
      }
      throw lastErr || new Error('Aucun résultat');
    }

    function stageCenterChange(center, options = {}) {
      const localToken = ++centerChangeToken;
      currentCenter = sanitizeCenter(center);
      saveCurrentCenter();
      cityInput.value = currentCenter.label;
      selectedFeature = null;
      closeSelection();
      closeDetails();
      fadeOutCurrentGridForReload();
      animateCameraToCenter(currentCenter, Number.isFinite(options.zoom) ? options.zoom : null);
      showLoadingGrid(currentCenter);
      if (options.showMarker) showCurrentMarker(currentCenter.lon, currentCenter.lat);
      closeTopPanels();
      return localToken;
    }

    async function applyCenter(center, options = {}) {
      const localToken = stageCenterChange(center, options);
      try {
        await loadData(options.force === true, localToken);
      } catch (err) {
        removeLoaderLayers();
        if (!hasCompletedInitialLoad) hideAppLoader(true);
        throw err;
      }
    }
