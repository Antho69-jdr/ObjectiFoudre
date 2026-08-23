
    window.STORM_DEBUG = false;

    function debugLog(scope, payload = null) {
      if (!window.STORM_DEBUG) return;
      const ts = new Date().toISOString().slice(11, 23);
      if (payload === null || typeof payload === 'undefined') console.log(`[storm ${ts}] ${scope}`);
      else console.log(`[storm ${ts}] ${scope}`, payload);
    }

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

    function addDaysIso(dateIso, days) {
      const base = new Date(normalizeDateIso(dateIso) + 'T12:00:00');
      base.setDate(base.getDate() + days);
      return base.toISOString().slice(0, 10);
    }

    function getAromeSelectableDates(todayIso = getTodayIsoDate()) {
      const today = normalizeDateIso(todayIso);
      // J-1 n'est PLUS proposé dans la frise : la veille se consulte uniquement dans les
      // Archives (la grille du jour passé y est servie depuis l'archive durable).
      // J+2 et J+3 ont été RETIRÉS de la carte de base (« ces jours n'existent plus » sur la
      // grille cellules/score) : la grille de base s'arrête à demain (J+1). Les échéances
      // lointaines restent sur la carte « Risque orageux » (J0→J+10).
      return [
        { value: today, kind: 'today', label: 'Aujourd’hui' },
        { value: addDaysIso(today, 1), kind: 'next', label: 'Demain' },
      ];
    }

    function formatShortDateLabel(dateIso) {
      const value = normalizeDateIso(dateIso);
      const parsed = new Date(value + 'T12:00:00');
      if (Number.isNaN(parsed.getTime())) return value;
      try {
        return new Intl.DateTimeFormat('fr-FR', { weekday: 'short', day: '2-digit', month: '2-digit' })
          .format(parsed)
          .replace('.', '');
      } catch (_) {
        return value;
      }
    }

    function formatAromeDateLabel(dateIso) {
      const value = normalizeDateIso(dateIso);
      const match = getAromeSelectableDates().find((item) => item.value === value);
      const shortLabel = formatShortDateLabel(value);
      return match ? match.label + ' · ' + shortLabel : shortLabel;
    }
    function formatTimelineDateLabel(dateIso) {
      const value = normalizeDateIso(dateIso);
      const parts = value.split('-');
      if (parts.length !== 3) return value;
      const d = new Date(Number(parts[0]), Number(parts[1]) - 1, Number(parts[2]));
      if (Number.isNaN(d.getTime())) return parts[2] + '-' + parts[1] + '-' + parts[0];
      // Date française lisible : « mar. 1 juil. 2026 » (badge carte + frise).
      const label = d.toLocaleDateString('fr-FR', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' });
      return label.charAt(0).toUpperCase() + label.slice(1);
    }


    function getAromeDateSelectionStatus(dateIso = selectedBaseDate) {
      const selected = normalizeDateIso(dateIso);
      const dates = getAromeSelectableDates();
      const minDate = dates[0].value;
      const maxDate = dates[dates.length - 1].value;
      const ok = dates.some((item) => item.value === selected);
      const clampedDate = selected < minDate ? minDate : (selected > maxDate ? maxDate : getTodayIsoDate());
      return {
        ok,
        selected,
        minDate,
        maxDate,
        clampedDate,
        message: 'Jour non disponible : ' + selected + '. Choisis entre aujourd’hui et demain. La veille est dans les Archives.',
      };
    }

    function syncDateNavButtons(dateIso) {
      const selected = normalizeDateIso(dateIso || selectedBaseDate);
      const dates = getAromeSelectableDates();
      const minDate = dates[0].value;
      const maxDate = dates[dates.length - 1].value;
      // Boutons désactivés : PAS de tooltip (les explications longues « jour le
      // plus ancien / date la plus lointaine » encombraient le mode « révéler »).
      if (prevDayBtn) {
        prevDayBtn.disabled = selected <= minDate;
        if (prevDayBtn.disabled) { prevDayBtn.removeAttribute('title'); prevDayBtn.removeAttribute('data-tooltip'); }
        else prevDayBtn.title = 'Jour précédent';
      }
      if (nextDayBtn) {
        nextDayBtn.disabled = selected >= maxDate;
        if (nextDayBtn.disabled) { nextDayBtn.removeAttribute('title'); nextDayBtn.removeAttribute('data-tooltip'); }
        else nextDayBtn.title = 'Jour suivant';
      }
      if (todayBtn) {
        todayBtn.disabled = selected === getTodayIsoDate();
        todayBtn.title = todayBtn.disabled ? 'Aujourd’hui est déjà affiché' : 'Revenir à aujourd’hui';
      }
    }

    function syncDateControls() {
      let nextDate = normalizeDateIso(selectedBaseDate);
      const status = getAromeDateSelectionStatus(nextDate);
      if (!status.ok) nextDate = status.clampedDate;
      selectedBaseDate = nextDate;
      if (typeof timelineDateLabel !== 'undefined' && timelineDateLabel) {
        timelineDateLabel.textContent = formatTimelineDateLabel(nextDate);
        // Pas de title/tooltip : le badge affiche déjà la date en toutes lettres.
        timelineDateLabel.removeAttribute('data-tooltip');
      }
      if (dateInput) {
        if (dateInput.tagName === 'SELECT') {
          const options = getAromeSelectableDates();
          dateInput.innerHTML = '';
          for (const optionInfo of options) {
            const option = document.createElement('option');
            option.value = optionInfo.value;
            option.textContent = optionInfo.label + ' · ' + formatShortDateLabel(optionInfo.value);
            dateInput.appendChild(option);
          }
        } else {
          const dates = getAromeSelectableDates();
          dateInput.min = dates[0].value;
          dateInput.max = dates[dates.length - 1].value;
        }
        dateInput.value = nextDate;
        dateInput.title = 'Jours disponibles : aujourd’hui et demain. La veille est dans les Archives.';
      }
      syncDateNavButtons(nextDate);
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
      const dateStatus = getAromeDateSelectionStatus(normalized);
      if (!dateStatus.ok) {
        syncDateControls();
        if (typeof setMetaMessage === 'function') setMetaMessage(dateStatus.message);
        return;
      }
      if (normalized === selectedBaseDate && !force) return;
      const previousSlotKey = /^h\d{2}$/.test(String(selectedSlotKey || '')) ? selectedSlotKey : null;
      if (typeof stopTimelinePlayback === 'function') stopTimelinePlayback({ resetToStart: false });
      selectedBaseDate = normalized;
      syncDateControls();
      selectedDayKey = null;
      selectedSlotKey = previousSlotKey;
      closeSelection();
      closeDetails();
      refreshCurrentData(force, loadingMessage);
    }

    const STORM_FORECAST_METRIC = 'storm_forecast_probability';

    function clampScore(value) {
      return Math.max(0, Math.min(100, Number(value) || 0));
    }

    function colorFromScore(score) {
      const s = clampScore(score);
      const stops = [
        { at: 0, c: [12, 30, 64] },
        { at: 1, c: [37, 99, 235] },
        { at: 16, c: [14, 165, 233] },
        { at: 34, c: [34, 197, 94] },
        { at: 55, c: [245, 158, 11] },
        { at: 75, c: [239, 68, 68] },
        { at: 100, c: [168, 85, 247] },
      ];
      let a = stops[0];
      let b = stops[stops.length - 1];
      for (let i = 0; i < stops.length - 1; i += 1) {
        if (s >= stops[i].at && s <= stops[i + 1].at) {
          a = stops[i];
          b = stops[i + 1];
          break;
        }
      }
      const t = (s - a.at) / Math.max(1, (b.at - a.at));
      const eased = Math.max(0, Math.min(1, t));
      const r = Math.round(a.c[0] + (b.c[0] - a.c[0]) * eased);
      const g = Math.round(a.c[1] + (b.c[1] - a.c[1]) * eased);
      const b2 = Math.round(a.c[2] + (b.c[2] - a.c[2]) * eased);
      return `rgb(${r}, ${g}, ${b2})`;
    }

    function colorFromStormForecast(score) {
      const s = clampScore(score);
      // Rampe « radar/chaleur » sur ink (cohérente avec la carte de risque Prévision) :
      // calme = ink sombre (se fond dans le fond), puis cyan→vert→ambre→rouge→magenta.
      const stops = [
        { at: 0, c: [9, 19, 33] },
        { at: 26, c: [46, 131, 166] },
        { at: 46, c: [52, 211, 153] },
        { at: 66, c: [251, 191, 36] },
        { at: 83, c: [244, 63, 94] },
        { at: 100, c: [217, 70, 239] },
      ];
      let a = stops[0], b = stops[stops.length - 1];
      for (let i = 0; i < stops.length - 1; i += 1) {
        if (s >= stops[i].at && s <= stops[i + 1].at) {
          a = stops[i];
          b = stops[i + 1];
          break;
        }
      }
      const t = (s - a.at) / Math.max(1, (b.at - a.at));
      const r = Math.round(a.c[0] + (b.c[0] - a.c[0]) * t);
      const g = Math.round(a.c[1] + (b.c[1] - a.c[1]) * t);
      const b2 = Math.round(a.c[2] + (b.c[2] - a.c[2]) * t);
      return `rgb(${r}, ${g}, ${b2})`;
    }

    function colorFromMetricScore(score, metric = selectedColorMetric) {
      return metric === STORM_FORECAST_METRIC ? colorFromStormForecast(score) : colorFromScore(score);
    }

    function numericCellValue(cell, key, fallback = 0) {
      const value = Number(cell?.[key]);
      return Number.isFinite(value) ? value : fallback;
    }

    function stormForecastBaseScore(cell) {
      if (!cell) return 0;
      const trigger = clampScore(cell.trigger_score);
      const cape = numericCellValue(cell, 'mucape', NaN);
      const dewpoint = numericCellValue(cell, 'dewpoint_c', NaN);
      const rh = numericCellValue(cell, 'relative_humidity_2m', NaN);
      const vpd = numericCellValue(cell, 'vapour_pressure_deficit', NaN);
      let score = trigger;
      if (Number.isFinite(cape) && cape < 100) score = Math.min(score, 18);
      else if (Number.isFinite(cape) && cape < 300) score = Math.min(score, 34);
      if (trigger < 18) score = Math.min(score, 20);
      else if (trigger < 35) score = Math.min(score, 42);
      if (Number.isFinite(dewpoint) && dewpoint < 7) score = Math.min(score, 32);
      if (Number.isFinite(rh) && rh < 45) score = Math.min(score, 38);
      if (Number.isFinite(vpd) && vpd > 2.6) score = Math.min(score, 42);
      return Math.round(clampScore(score));
    }

    function getCellMetricValue(cell, metric = selectedColorMetric) {
      if (!cell) return 0;
      if (metric === STORM_FORECAST_METRIC) return Number(cell?.[metric] ?? stormForecastBaseScore(cell)) || 0;
      return Number(cell?.[metric] ?? 0) || 0;
    }

    function getCellFillColor(cell, metricValue = null) {
      const score = metricValue === null || metricValue === undefined ? getCellMetricValue(cell) : metricValue;
      return colorFromMetricScore(score);
    }

    function opacityFromScoreGlobal(score) {
      const s = Math.max(0, Math.min(100, Number(score) || 0));
      if (s <= 0) return 0.035;
      if (s <= 5) return 0.18 + (s / 5) * 0.05;
      if (s <= 10) return 0.23 + ((s - 5) / 5) * 0.04;
      return 0.27 + ((s - 10) / 90) * 0.29;
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


    function getRenderableSlots(day) {
      const slots = Array.isArray(day?.slots) ? day.slots : [];
      return slots.filter((slot) => (Array.isArray(slot?.cells) && slot.cells.length > 0) || slot?.arome_placeholder === true);
    }

    function normalizeSlotKeyList(keys = []) {
      return Array.from(new Set((Array.isArray(keys) ? keys : [])
        .map((key) => String(key || ''))
        .filter((key) => /^h\d{2}$/.test(key))));
    }

    function rememberMeteoFranceGribAvailabilityStatus(dateIso = selectedBaseDate, keys = null) {
      if (typeof aromeFranceAvailabilityStatusMemory === 'undefined' || !(aromeFranceAvailabilityStatusMemory instanceof Map)) return false;
      const dayKey = normalizeDateIso(dateIso);
      if (!Array.isArray(keys)) {
        aromeFranceAvailabilityStatusMemory.delete(dayKey);
        return false;
      }
      aromeFranceAvailabilityStatusMemory.set(dayKey, new Set(normalizeSlotKeyList(keys)));
      while (aromeFranceAvailabilityStatusMemory.size > 8) {
        const oldestKey = aromeFranceAvailabilityStatusMemory.keys().next().value;
        if (!oldestKey) break;
        aromeFranceAvailabilityStatusMemory.delete(oldestKey);
      }
      return true;
    }

    function restoreMeteoFranceGribAvailabilityStatus(dateIso = selectedBaseDate) {
      if (typeof meteoFranceGribAvailableSlotKeys === 'undefined') return false;
      if (typeof aromeFranceAvailabilityStatusMemory === 'undefined' || !(aromeFranceAvailabilityStatusMemory instanceof Map)) {
        meteoFranceGribAvailableSlotKeys = null;
        return false;
      }
      const cachedKeys = aromeFranceAvailabilityStatusMemory.get(normalizeDateIso(dateIso));
      if (!cachedKeys) {
        meteoFranceGribAvailableSlotKeys = null;
        return false;
      }
      meteoFranceGribAvailableSlotKeys = new Set(cachedKeys);
      return true;
    }

    function meteoFranceAvailabilitySetForDay(day = null) {
      const dayKey = normalizeDateIso(day?.day_key || selectedDayKey || selectedBaseDate);
      if (typeof aromeFranceAvailabilityStatusMemory !== 'undefined' && aromeFranceAvailabilityStatusMemory instanceof Map) {
        const remembered = aromeFranceAvailabilityStatusMemory.get(dayKey);
        if (remembered instanceof Set) return remembered;
      }
      if (dayKey === normalizeDateIso(selectedBaseDate) && typeof meteoFranceGribAvailableSlotKeys !== 'undefined' && meteoFranceGribAvailableSlotKeys instanceof Set) {
        return meteoFranceGribAvailableSlotKeys;
      }
      return null;
    }

    function isMeteoFranceSlotUnavailable(slot, day = null) {
      const slotKey = String(slot?.slot_key || '');
      if (!/^h\d{2}$/.test(slotKey)) return false;
      const availability = meteoFranceAvailabilitySetForDay(day);
      if (!(availability instanceof Set)) return false;
      return !availability.has(slotKey);
    }

    function getSelectableSlots(day) {
      return getRenderableSlots(day).filter((slot) => !isMeteoFranceSlotUnavailable(slot, day));
    }

    function nearestSelectableSlotForIndex(slots, targetIndex, day = null) {
      const allSlots = Array.isArray(slots) ? slots : [];
      if (!allSlots.length) return null;
      const clampedIndex = Math.max(0, Math.min(allSlots.length - 1, Number(targetIndex) || 0));
      const isSelectable = (slot) => slot && !isMeteoFranceSlotUnavailable(slot, day);
      if (isSelectable(allSlots[clampedIndex])) return allSlots[clampedIndex];
      for (let offset = 1; offset < allSlots.length; offset += 1) {
        const left = clampedIndex - offset;
        const right = clampedIndex + offset;
        if (left >= 0 && isSelectable(allSlots[left])) return allSlots[left];
        if (right < allSlots.length && isSelectable(allSlots[right])) return allSlots[right];
      }
      return null;
    }

    function findFirstRenderableSelection(days, preferredDayKey = null, preferredSlotKey = null) {
      const orderedDays = Array.isArray(days) ? days : [];
      const candidateDays = preferredDayKey
        ? [
            ...orderedDays.filter((day) => day?.day_key === preferredDayKey),
            ...orderedDays.filter((day) => day?.day_key !== preferredDayKey),
          ]
        : orderedDays;
      for (const day of candidateDays) {
        const renderableSlots = getRenderableSlots(day);
        if (!renderableSlots.length) continue;
        const selectableSlots = getSelectableSlots(day);
        const preferredSlot = preferredSlotKey
          ? selectableSlots.find((slot) => slot?.slot_key === preferredSlotKey)
          : null;
        const slot = preferredSlot || selectableSlots[0] || renderableSlots[0];
        return { dayKey: day.day_key, slotKey: slot.slot_key };
      }
      return { dayKey: orderedDays[0]?.day_key || null, slotKey: null };
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
        localStorage.removeItem('storm_center');
      } catch (_) {}
      return { ...DEFAULT_CENTER };
    }

    function saveCurrentCenter() {
      try {
        localStorage.removeItem('storm_center');
      } catch (_) {}
    }

    async function geocodeCity(query, signal) {
      const q = query.trim();
      if (!q) throw new Error('Ville vide');
      // Coordonnées directes ("45.77, 2.96", "45.77N 2.96E"…) → pas de géocodage
      const coord = (typeof parseCoordinates === 'function') ? parseCoordinates(q) : null;
      if (coord) return { lat: coord.lat, lon: coord.lon, label: coord.label };
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
      lastFetchSignature = '';
      closeSelection();
      closeDetails();
      animateCameraToCenter(currentCenter, Number.isFinite(options.zoom) ? options.zoom : null);
      if (options.showMarker) showCurrentMarker(currentCenter.lon, currentCenter.lat);
      closeTopPanels();
      shouldAnimateNextGrid = false;
      updateMetaLine();
      if (typeof renderSlotButtons === 'function') requestAnimationFrame(renderSlotButtons);
      return localToken;
    }

    async function applyCenter(center, options = {}) {
      stageCenterChange(center, options);
      requestAnimationFrame(() => {
        refreshMap();
        const cells = getCurrentSlot()?.cells || [];
        if (cells.length) forceGridVisible(cells);
      });
    }
