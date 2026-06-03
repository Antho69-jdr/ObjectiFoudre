    function isHistoricalSlot(day, slot) {
      const dayKey = normalizeDateIso(day?.day_key);
      const todayKey = getTodayIsoDate();
      if (dayKey && dayKey < todayKey) return true;
      const selectedIso = slot?.cells?.[0]?.selected_time_iso;
      if (!selectedIso) return false;
      const ts = Date.parse(selectedIso);
      return Number.isFinite(ts) && ts < Date.now();
    }

    function timelinePlaybackIcon(isRunning) {
      return isRunning
        ? '<svg class="icon-svg" viewBox="0 0 24 24" aria-hidden="true" fill="currentColor"><path d="M7 5.5h3.5v13H7v-13Zm6.5 0H17v13h-3.5v-13Z"></path></svg>'
        : '<svg class="icon-svg" viewBox="0 0 24 24" aria-hidden="true" fill="currentColor"><path d="M8 5.5v13l10-6.5-10-6.5Z"></path></svg>';
    }

    function timelineSelectableSlots(day = getCurrentDay()) {
      return typeof getSelectableSlots === 'function' ? getSelectableSlots(day) : getRenderableSlots(day);
    }

    function timelineSlotIsUnavailable(slot, day = getCurrentDay()) {
      return typeof isMeteoFranceSlotUnavailable === 'function' && isMeteoFranceSlotUnavailable(slot, day);
    }

    function syncTimelinePlaybackUi() {
      if (!playTimelineBtn) return;
      const isRunning = !!timelinePlaybackRunning;
      playTimelineBtn.classList.toggle('active', isRunning);
      playTimelineBtn.setAttribute('aria-pressed', isRunning ? 'true' : 'false');
      playTimelineBtn.innerHTML = timelinePlaybackIcon(isRunning);
      playTimelineBtn.setAttribute('aria-label', isRunning ? 'Mettre en pause la lecture des horaires' : 'Lire les horaires du jour');
      playTimelineBtn.title = isRunning ? 'Mettre en pause la lecture des horaires' : 'Lire les horaires du jour';
      const hasPlayableSlots = timelineSelectableSlots(getCurrentDay()).length > 1;
      playTimelineBtn.disabled = !hasPlayableSlots;
    }

    function stopTimelinePlayback({ resetToStart = false } = {}) {
      if (timelinePlaybackTimer) {
        window.clearTimeout(timelinePlaybackTimer);
        timelinePlaybackTimer = null;
      }
      const wasRunning = !!timelinePlaybackRunning;
      timelinePlaybackRunning = false;
      if (resetToStart) {
        const currentDay = getCurrentDay();
        const slots = timelineSelectableSlots(currentDay);
        if (slots.length) selectedSlotKey = slots[0].slot_key;
      }
      if (wasRunning || resetToStart) {
        renderSlotButtons();
        requestAnimationFrame(alignTopPanels);
        refreshMap();
      }
      syncTimelinePlaybackUi();
    }

    function scheduleTimelinePlaybackStep() {
      if (!timelinePlaybackRunning) return;
      if (timelinePlaybackTimer) {
        window.clearTimeout(timelinePlaybackTimer);
        timelinePlaybackTimer = null;
      }
      timelinePlaybackTimer = window.setTimeout(() => {
        if (!timelinePlaybackRunning) return;
        const currentDay = getCurrentDay();
        const slots = timelineSelectableSlots(currentDay);
        if (slots.length <= 1) {
          stopTimelinePlayback({ resetToStart: false });
          return;
        }
        const currentIndex = Math.max(0, slots.findIndex((slot) => slot?.slot_key === selectedSlotKey));
        const nextIndex = currentIndex + 1;
        if (nextIndex >= slots.length) {
          stopTimelinePlayback({ resetToStart: false });
          return;
        }
        selectedSlotKey = slots[nextIndex].slot_key;
        closeSelection();
        closeDetails();
        renderSlotButtons();
        requestAnimationFrame(alignTopPanels);
        refreshMap();
        if (typeof maybeLoadCachedMeteoFranceGribForSelectedSlot === 'function') maybeLoadCachedMeteoFranceGribForSelectedSlot({ quiet: true });
        scheduleTimelinePlaybackStep();
      }, TIMELINE_PLAYBACK_STEP_MS);
    }

    function toggleTimelinePlayback() {
      const currentDay = getCurrentDay();
      const slots = timelineSelectableSlots(currentDay);
      if (slots.length <= 1) {
        timelinePlaybackRunning = false;
        syncTimelinePlaybackUi();
        return;
      }
      if (timelinePlaybackRunning) {
        stopTimelinePlayback({ resetToStart: false });
        return;
      }
      const currentIndex = slots.findIndex((slot) => slot?.slot_key === selectedSlotKey);
      if (currentIndex === -1 || currentIndex >= (slots.length - 1)) {
        selectedSlotKey = slots[0].slot_key;
        closeSelection();
        closeDetails();
        renderSlotButtons();
        requestAnimationFrame(alignTopPanels);
        refreshMap();
        if (typeof maybeLoadCachedMeteoFranceGribForSelectedSlot === 'function') maybeLoadCachedMeteoFranceGribForSelectedSlot({ quiet: true });
      }
      timelinePlaybackRunning = true;
      syncTimelinePlaybackUi();
      scheduleTimelinePlaybackStep();
    }

    function renderDayButtons() {
      const allDays = getDays();
      const days = allDays.filter((day) => getRenderableSlots(day).length > 0);
      dayButtons.innerHTML = '';
      debugLog('renderDayButtons', days.map(day => ({ dayKey: day?.day_key, label: day?.day_label, renderableSlots: getRenderableSlots(day).length })));
      if (!days.length) {
        syncTimelinePlaybackUi();
        return;
      }
      if (!selectedDayKey || !days.some(d => d.day_key === selectedDayKey)) selectedDayKey = days[0].day_key;
      for (const day of days) {
        const btn = document.createElement('button');
        btn.textContent = day.day_label;
        btn.className = day.day_key === selectedDayKey ? 'active' : '';
        btn.onclick = () => {
          if (typeof stopTimelinePlayback === 'function') stopTimelinePlayback({ resetToStart: false });
          const renderableSlots = getRenderableSlots(day);
          const selectableSlots = timelineSelectableSlots(day);
          selectedDayKey = day.day_key;
          selectedSlotKey = selectableSlots[0]?.slot_key || renderableSlots[0]?.slot_key || null;
          closeSelection();
          closeDetails();
          renderDayButtons();
          renderSlotButtons();
          requestAnimationFrame(alignTopPanels);
          debugLog('renderDayButtons:click', { selectedDayKey, selectedSlotKey });
          debugLog('renderSlotButtons:click', { selectedDayKey, selectedSlotKey });
          refreshMap();
          if (typeof maybeLoadCachedMeteoFranceGribForSelectedSlot === 'function') maybeLoadCachedMeteoFranceGribForSelectedSlot({ quiet: true });
        };
        dayButtons.appendChild(btn);
      }
      syncTimelinePlaybackUi();
    }

    function selectTimelineSlot(slotKey, { render = true, stopPlayback = true, loadCached = true } = {}) {
      const day = getCurrentDay();
      const slots = getRenderableSlots(day);
      const slot = slots.find((item) => item?.slot_key === slotKey);
      if (!slot) return false;
      if (timelineSlotIsUnavailable(slot, day)) {
        if (typeof setMetaMessage === 'function') setMetaMessage('Échéance AROME pas encore publiée pour ce run.');
        return false;
      }
      if (selectedSlotKey === slotKey) return false;
      if (stopPlayback && typeof stopTimelinePlayback === 'function') stopTimelinePlayback({ resetToStart: false });
      selectedSlotKey = slotKey;
      closeSelection();
      closeDetails();
      if (render) renderSlotButtons();
      requestAnimationFrame(alignTopPanels);
      refreshMap();
      if (loadCached && typeof maybeLoadCachedMeteoFranceGribForSelectedSlot === 'function') maybeLoadCachedMeteoFranceGribForSelectedSlot({ quiet: true });
      return true;
    }


    function clampTimelineHour(value, fallback = 0) {
      const numeric = Number(value);
      if (!Number.isFinite(numeric)) return fallback;
      return Math.max(0, Math.min(24, numeric));
    }

    function timelineHourPct(hour) {
      return Math.max(0, Math.min(100, (clampTimelineHour(hour) / 24) * 100));
    }

    function timelineDayOfYear(dateIso) {
      const normalized = normalizeDateIso(dateIso || selectedBaseDate || getTodayIsoDate());
      const date = new Date(`${normalized}T12:00:00Z`);
      if (!Number.isFinite(date.getTime())) return 172;
      const start = Date.UTC(date.getUTCFullYear(), 0, 0);
      return Math.max(1, Math.min(366, Math.floor((date.getTime() - start) / 86400000)));
    }

    function timelineDegreesToRadians(value) {
      return (Number(value) || 0) * Math.PI / 180;
    }

    function timelineRadiansToDegrees(value) {
      return (Number(value) || 0) * 180 / Math.PI;
    }

    function normalizeTimelineDegrees(value) {
      const numeric = Number(value);
      if (!Number.isFinite(numeric)) return 0;
      return ((numeric % 360) + 360) % 360;
    }

    function wrapTimelineHour(value) {
      const numeric = Number(value);
      if (!Number.isFinite(numeric)) return 0;
      return ((numeric % 24) + 24) % 24;
    }

    function timelineParisOffsetHours(dateIso) {
      const normalized = normalizeDateIso(dateIso || selectedBaseDate || getTodayIsoDate());
      const date = new Date(`${normalized}T12:00:00Z`);
      if (!Number.isFinite(date.getTime())) return 1;
      try {
        const parts = new Intl.DateTimeFormat('en-GB', {
          timeZone: 'Europe/Paris',
          year: 'numeric',
          month: '2-digit',
          day: '2-digit',
          hour: '2-digit',
          minute: '2-digit',
          second: '2-digit',
          hour12: false,
        }).formatToParts(date);
        const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
        const parisAsUtc = Date.UTC(
          Number(values.year),
          Number(values.month) - 1,
          Number(values.day),
          Number(values.hour),
          Number(values.minute),
          Number(values.second),
        );
        return Math.round((parisAsUtc - date.getTime()) / 3600000);
      } catch (_) {
        return -date.getTimezoneOffset() / 60;
      }
    }

    function timelineSolarReferenceLocation() {
      const lat = Number(currentCenter?.lat);
      const lon = Number(currentCenter?.lon);
      if (Number.isFinite(lat) && Number.isFinite(lon)) return { lat, lon };
      return { lat: DEFAULT_CENTER.lat, lon: DEFAULT_CENTER.lon };
    }

    function timelineSolarEventHour(dateIso, lat, lon, isSunrise) {
      const normalized = normalizeDateIso(dateIso || selectedBaseDate || getTodayIsoDate());
      const dayOfYear = timelineDayOfYear(normalized);
      const lngHour = lon / 15;
      const approximateTime = dayOfYear + (((isSunrise ? 6 : 18) - lngHour) / 24);
      const meanAnomaly = (0.9856 * approximateTime) - 3.289;
      const trueLongitude = normalizeTimelineDegrees(
        meanAnomaly
          + (1.916 * Math.sin(timelineDegreesToRadians(meanAnomaly)))
          + (0.020 * Math.sin(timelineDegreesToRadians(2 * meanAnomaly)))
          + 282.634,
      );
      let rightAscension = timelineRadiansToDegrees(Math.atan(0.91764 * Math.tan(timelineDegreesToRadians(trueLongitude))));
      rightAscension = normalizeTimelineDegrees(rightAscension);
      rightAscension += (Math.floor(trueLongitude / 90) * 90) - (Math.floor(rightAscension / 90) * 90);
      rightAscension /= 15;

      const sinDeclination = 0.39782 * Math.sin(timelineDegreesToRadians(trueLongitude));
      const cosDeclination = Math.cos(Math.asin(sinDeclination));
      const cosHourAngle = (
        Math.cos(timelineDegreesToRadians(90.833))
        - (sinDeclination * Math.sin(timelineDegreesToRadians(lat)))
      ) / (cosDeclination * Math.cos(timelineDegreesToRadians(lat)));
      if (cosHourAngle > 1 || cosHourAngle < -1) return null;

      let hourAngle = timelineRadiansToDegrees(Math.acos(cosHourAngle));
      if (isSunrise) hourAngle = 360 - hourAngle;
      hourAngle /= 15;
      const localMeanTime = hourAngle + rightAscension - (0.06571 * approximateTime) - 6.622;
      const utcHour = wrapTimelineHour(localMeanTime - lngHour);
      return wrapTimelineHour(utcHour + timelineParisOffsetHours(normalized));
    }

    function timelineSolarNoonHour(dateIso, lon) {
      const normalized = normalizeDateIso(dateIso || selectedBaseDate || getTodayIsoDate());
      const dayOfYear = timelineDayOfYear(normalized);
      const gamma = (2 * Math.PI / 365) * (dayOfYear - 1);
      const equationOfTime = 229.18 * (
        0.000075
        + (0.001868 * Math.cos(gamma))
        - (0.032077 * Math.sin(gamma))
        - (0.014615 * Math.cos(2 * gamma))
        - (0.040849 * Math.sin(2 * gamma))
      );
      const localMinutes = 720 - (4 * lon) - equationOfTime + (timelineParisOffsetHours(normalized) * 60);
      return wrapTimelineHour(localMinutes / 60);
    }

    function estimateTimelineSunWindow(dateIso) {
      const normalized = normalizeDateIso(dateIso || selectedBaseDate || getTodayIsoDate());
      const location = timelineSolarReferenceLocation();
      const sunrise = timelineSolarEventHour(normalized, location.lat, location.lon, true);
      const sunset = timelineSolarEventHour(normalized, location.lat, location.lon, false);
      const noon = timelineSolarNoonHour(normalized, location.lon);
      if (Number.isFinite(sunrise) && Number.isFinite(sunset) && Number.isFinite(noon)) {
        return { sunrise, sunset, noon, location };
      }
      return { sunrise: 7, sunset: 20, noon: 13.5, location };
    }

    function timelinePhaseIconSvg(type) {
      if (type === 'day') {
        return '<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="4"></circle><path d="M12 2.8v2.4M12 18.8v2.4M4.2 4.2l1.7 1.7M18.1 18.1l1.7 1.7M2.8 12h2.4M18.8 12h2.4M4.2 19.8l1.7-1.7M18.1 5.9l1.7-1.7"></path></svg>';
      }
      if (type === 'sunrise') {
        return '<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round"><path d="M4 17h16"></path><path d="M7 17a5 5 0 0 1 10 0"></path><path d="M12 4v7"></path><path d="m9.5 6.5 2.5-2.5 2.5 2.5"></path></svg>';
      }
      if (type === 'sunset') {
        return '<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round"><path d="M4 17h16"></path><path d="M7 17a5 5 0 0 1 10 0"></path><path d="M12 4v7"></path><path d="m9.5 8.5 2.5 2.5 2.5-2.5"></path></svg>';
      }
      return '<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round"><path d="M18.8 15.6A7.4 7.4 0 0 1 8.4 5.2 7.5 7.5 0 1 0 18.8 15.6Z"></path><path d="M17.8 4.2h.01M20.5 7.4h.01"></path></svg>';
    }

    function timelinePhaseDefinitions(dateIso) {
      const sunWindow = estimateTimelineSunWindow(dateIso);
      const morningNightEnd = sunWindow.sunrise;
      const eveningNightStart = sunWindow.sunset;
      return [
        { type: 'night', hour: sunWindow.sunrise / 2, label: 'Nuit', tooltip: `Nuit · 00:00-${formatTimelineSunHour(morningNightEnd)}` },
        { type: 'sunrise', hour: sunWindow.sunrise, label: 'Lever' },
        { type: 'day', hour: sunWindow.noon, label: 'Journée', tooltip: `Journée · ${formatTimelineSunHour(sunWindow.sunrise)}-${formatTimelineSunHour(sunWindow.sunset)}` },
        { type: 'sunset', hour: sunWindow.sunset, label: 'Coucher' },
        { type: 'night', hour: sunWindow.sunset + ((24 - sunWindow.sunset) / 2), label: 'Nuit', tooltip: `Nuit · ${formatTimelineSunHour(eveningNightStart)}-24:00` },
      ];
    }

    function addTimelinePhaseIcons(track, dateIso) {
      if (!track) return;
      const phases = timelinePhaseDefinitions(dateIso);
      const day = getCurrentDay();
      const slots = getRenderableSlots(day);
      for (const phase of phases) {
        const icon = document.createElement('span');
        const tooltip = phase.tooltip || `${phase.label} · ${formatTimelineSunHour(phase.hour)}`;
        const phaseHour = Math.max(0, Math.min(23, Math.round(clampTimelineHour(phase.hour))));
        const phaseSlotKey = `h${String(phaseHour).padStart(2, '0')}`;
        const phaseSlot = slots.find((slot) => slot?.slot_key === phaseSlotKey);
        const unavailable = phaseSlot ? timelineSlotIsUnavailable(phaseSlot, day) : false;
        icon.className = [
          `timeline-light-icon timeline-light-icon-${phase.type}`,
          unavailable ? 'is-arome-unavailable' : '',
        ].filter(Boolean).join(' ');
        icon.style.left = `${timelineHourPct(phase.hour)}%`;
        icon.dataset.tooltip = unavailable ? `${tooltip} · échéance non publiée` : tooltip;
        icon.setAttribute('role', 'img');
        icon.setAttribute('aria-label', icon.dataset.tooltip);
        icon.innerHTML = timelinePhaseIconSvg(phase.type);
        if (unavailable) {
          icon.addEventListener('pointerdown', (event) => { event.preventDefault(); event.stopPropagation(); });
          icon.addEventListener('click', (event) => { event.preventDefault(); event.stopPropagation(); });
        }
        track.appendChild(icon);
      }
    }


    function formatTimelineSunHour(value) {
      const hour = clampTimelineHour(value);
      const totalMinutes = Math.max(0, Math.min(24 * 60, Math.round(hour * 60)));
      const h = Math.floor(totalMinutes / 60);
      const m = totalMinutes % 60;
      return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
    }

    function timelineSlotHourLabel(slot) {
      return String(slot?.slot_label || slot?.slot_key || '').replace(/^h/, '').replace('h', '').padStart(2, '0');
    }

    function timelinePhaseMapForSlots(dateIso, slots, day) {
      const phases = timelinePhaseDefinitions(dateIso);
      const map = new Map();
      for (const phase of phases) {
        const tooltip = phase.tooltip || `${phase.label} · ${formatTimelineSunHour(phase.hour)}`;
        const phaseHour = Math.max(0, Math.min(23, Math.round(clampTimelineHour(phase.hour))));
        const phaseSlotKey = `h${String(phaseHour).padStart(2, '0')}`;
        const phaseSlot = slots.find((slot) => slot?.slot_key === phaseSlotKey);
        const unavailable = phaseSlot ? timelineSlotIsUnavailable(phaseSlot, day) : false;
        map.set(phaseSlotKey, {
          ...phase,
          tooltip: unavailable ? `${tooltip} · échéance non publiée` : tooltip,
          unavailable,
        });
      }
      return map;
    }

    // ── Wheel scroll state ──────────────────────────────────────────────────
    let wheelSnapTimer = null;
    let wheelProgrammatic = false;
    let wheelActiveSlotKey = null;

    // O(1) : trouve l'index de l'item centré via scrollLeft arithmétique
    function wheelCenteredIndex(scroller, itemWidth) {
      return Math.round(scroller.scrollLeft / itemWidth);
    }

    // Utilisé uniquement au commit (après scroll terminé), getBoundingClientRect fiable
    function wheelCenteredItem(scroller) {
      if (!scroller.isConnected) return null;
      const rect = scroller.getBoundingClientRect();
      const cx = rect.left + rect.width / 2;
      let best = null, bestDist = Infinity;
      for (const item of scroller.querySelectorAll('.timeline-wheel-item:not(:disabled)')) {
        const ir = item.getBoundingClientRect();
        const dist = Math.abs(ir.left + ir.width / 2 - cx);
        if (dist < bestDist) { best = item; bestDist = dist; }
      }
      return best;
    }

    // Met à jour uniquement les deux items concernés (ancien actif → nouveau)
    function wheelSetActive(scroller, slotKey) {
      if (slotKey === wheelActiveSlotKey) return;
      if (wheelActiveSlotKey) {
        const prev = scroller.querySelector(`[data-slot-key="${wheelActiveSlotKey}"]`);
        if (prev) { prev.classList.remove('active'); prev.setAttribute('aria-selected', 'false'); }
      }
      const next = scroller.querySelector(`[data-slot-key="${slotKey}"]`);
      if (next) { next.classList.add('active'); next.setAttribute('aria-selected', 'true'); }
      wheelActiveSlotKey = slotKey;
    }

    // Snap vers un slot — délégué au browser (GPU, hors main thread)
    function wheelScrollTo(scroller, slotKey, animated) {
      if (!scroller.isConnected) return;
      const item = scroller.querySelector(`[data-slot-key="${slotKey}"]`);
      if (!item) return;
      const sr = scroller.getBoundingClientRect();
      const ir = item.getBoundingClientRect();
      const target = Math.max(0, scroller.scrollLeft + ir.left - sr.left - sr.width / 2 + ir.width / 2);

      if (!animated || Math.abs(target - scroller.scrollLeft) < 1) {
        scroller.scrollLeft = target;
        return;
      }

      wheelProgrammatic = true;
      scroller.scrollTo({ left: target, behavior: 'smooth' });

      // Réinitialise wheelProgrammatic quand le scroll lisse se termine
      const onDone = () => {
        scroller.removeEventListener('scrollend', onDone);
        wheelProgrammatic = false;
      };
      scroller.addEventListener('scrollend', onDone, { passive: true, once: true });
      // Filet de sécurité si scrollend ne se déclenche pas
      setTimeout(() => { wheelProgrammatic = false; }, 600);
    }

    function wheelCommit(scroller) {
      if (!scroller.isConnected) return;
      const item = wheelCenteredItem(scroller);
      if (!item) return;
      const slotKey = item.dataset.slotKey;
      wheelSetActive(scroller, slotKey);
      wheelScrollTo(scroller, slotKey, true);
      if (slotKey !== selectedSlotKey && typeof selectTimelineSlot === 'function') {
        selectTimelineSlot(slotKey, { render: false, stopPlayback: true, loadCached: true });
      }
      if (typeof maybeLoadCachedMeteoFranceGribForSelectedSlot === 'function') {
        maybeLoadCachedMeteoFranceGribForSelectedSlot({ quiet: true });
      }
    }

    function wheelScheduleSnap(scroller, delay = 150) {
      if (wheelSnapTimer) clearTimeout(wheelSnapTimer);
      wheelSnapTimer = setTimeout(() => { wheelSnapTimer = null; wheelCommit(scroller); }, delay);
    }

    function syncTimelineWheelScrollToSelected({ smooth = false } = {}) {
      const scroller = slotButtons?.querySelector?.('.timeline-wheel-scroller');
      if (!scroller) return;
      wheelScrollTo(scroller, selectedSlotKey, smooth);
    }

    function buildTimelineWheel(slots, day) {
      wheelActiveSlotKey = selectedSlotKey || null;

      const wheel = document.createElement('div');
      wheel.className = 'timeline-wheel';
      wheel.setAttribute('aria-hidden', 'false');

      const scroller = document.createElement('div');
      scroller.className = 'timeline-wheel-scroller';
      scroller.setAttribute('role', 'listbox');
      scroller.setAttribute('aria-label', 'Heure affichée');

      const phases = timelinePhaseMapForSlots(day?.day_key || selectedBaseDate, slots, day);
      for (const slot of slots) {
        const hasAromeCache = typeof meteoFranceGribCachedSlotKeys !== 'undefined' && meteoFranceGribCachedSlotKeys.has(slot.slot_key);
        const isAromeLoaded = Array.isArray(slot.cells) && slot.cells.some((cell) => cell?.source_provider === 'meteofrance_arome_grib');
        const isUnavailable = timelineSlotIsUnavailable(slot, day);
        const hourText = timelineSlotHourLabel(slot);
        const phase = phases.get(slot.slot_key);
        const item = document.createElement('button');
        item.type = 'button';
        item.className = [
          'timeline-wheel-item',
          slot.slot_key === selectedSlotKey ? 'active' : '',
          hasAromeCache ? 'is-arome-cached' : '',
          isAromeLoaded ? 'is-arome-loaded' : '',
          isUnavailable ? 'is-arome-unavailable' : '',
        ].filter(Boolean).join(' ');
        item.dataset.slotKey = slot.slot_key;
        item.setAttribute('role', 'option');
        item.setAttribute('aria-selected', slot.slot_key === selectedSlotKey ? 'true' : 'false');
        item.setAttribute('aria-label', `${String(hourText).padStart(2, '0')}h`);
        item.title = isUnavailable
          ? `${slot.slot_label} · échéance non publiée par le run AROME`
          : (isAromeLoaded
            ? `${slot.slot_label} · AROME GRIB chargé`
            : (hasAromeCache ? `${slot.slot_label} · AROME GRIB en cache serveur` : slot.slot_label));
        if (isUnavailable) item.disabled = true;
        if (phase) {
          const phaseIcon = document.createElement('span');
          phaseIcon.className = [`timeline-wheel-light-icon`, `timeline-wheel-light-icon-${phase.type}`, phase.unavailable ? 'is-arome-unavailable' : ''].filter(Boolean).join(' ');
          phaseIcon.dataset.tooltip = phase.tooltip;
          phaseIcon.innerHTML = timelinePhaseIconSvg(phase.type);
          item.appendChild(phaseIcon);
        }
        const line = document.createElement('span');
        line.className = 'timeline-wheel-line';
        const label = document.createElement('span');
        label.className = 'timeline-wheel-label';
        label.textContent = hourText;
        item.appendChild(line);
        item.appendChild(label);
        item.addEventListener('click', (event) => {
          event.preventDefault();
          event.stopPropagation();
          if (isUnavailable) return;
          // Annule le snap en attente (évite snap sur ancien scroller après re-render)
          if (wheelSnapTimer) { clearTimeout(wheelSnapTimer); wheelSnapTimer = null; }
          if (typeof selectTimelineSlot === 'function') selectTimelineSlot(slot.slot_key, { stopPlayback: true });
        });
        scroller.appendChild(item);
      }

      // Mise à jour visuelle pendant le scroll — throttlée rAF, O(1) par index
      const visibleHours = 8;
      let scrollRafId = null;
      scroller.addEventListener('scroll', () => {
        if (wheelProgrammatic) return;
        if (scrollRafId) return;
        scrollRafId = requestAnimationFrame(() => {
          scrollRafId = null;
          if (!scroller.isConnected) return;
          const itemWidth = scroller.clientWidth / visibleHours;
          if (!itemWidth) return;
          const idx = Math.max(0, Math.min(
            Math.round(scroller.scrollLeft / itemWidth),
            scroller.querySelectorAll('.timeline-wheel-item').length - 1
          ));
          const items = scroller.querySelectorAll('.timeline-wheel-item');
          if (items[idx]) wheelSetActive(scroller, items[idx].dataset.slotKey);
        });
      }, { passive: true });

      // Primary: scrollend fire après que l'inertie soit terminée
      scroller.addEventListener('scrollend', () => {
        if (wheelProgrammatic) return;
        if (wheelSnapTimer) { clearTimeout(wheelSnapTimer); wheelSnapTimer = null; }
        wheelCommit(scroller);
      }, { passive: true });

      // Fallback long (inertie mobile ~300-500ms) pour navigateurs sans scrollend
      scroller.addEventListener('touchend', () => { wheelScheduleSnap(scroller, 600); }, { passive: true });
      scroller.addEventListener('pointercancel', () => { wheelScheduleSnap(scroller, 600); });

      // Molette souris
      scroller.addEventListener('wheel', (event) => {
        event.preventDefault();
        const delta = Math.abs(event.deltaY) > Math.abs(event.deltaX) ? event.deltaY : event.deltaX;
        if (!delta) return;
        scroller.scrollBy({ left: delta, behavior: 'auto' });
        wheelScheduleSnap(scroller, 150);
      }, { passive: false });

      wheel.appendChild(scroller);
      return wheel;
    }

    function renderSlotButtons() {
      const day = getCurrentDay();
      slotButtons.innerHTML = '';
      slotButtons.classList.add('timeline-slider');
      const slots = getRenderableSlots(day);
      const selectableSlots = timelineSelectableSlots(day);
      debugLog('renderSlotButtons', slots.map(slot => ({ slotKey: slot?.slot_key, label: slot?.slot_label, cells: Array.isArray(slot?.cells) ? slot.cells.length : 0, unavailable: timelineSlotIsUnavailable(slot, day) })));
      if (!slots.length) {
        syncTimelinePlaybackUi();
        return;
      }
      const selectedSlot = slots.find(s => s.slot_key === selectedSlotKey);
      if (!selectedSlotKey || !selectedSlot || timelineSlotIsUnavailable(selectedSlot, day)) {
        selectedSlotKey = selectableSlots[0]?.slot_key || slots[0].slot_key;
      }

      const activeIndex = Math.max(0, slots.findIndex((slot) => slot?.slot_key === selectedSlotKey));
      const denominator = Math.max(1, slots.length - 1);
      const activePct = (activeIndex / denominator) * 100;
      const activeSlot = slots[activeIndex] || slots[0];
      const activeHour = String(activeSlot?.slot_label || activeSlot?.slot_key || '').replace(/^h/, '').replace('h', '');

      const rail = document.createElement('div');
      rail.className = 'timeline-rail';
      rail.setAttribute('role', 'slider');
      rail.setAttribute('aria-label', 'Heure affichée');
      rail.setAttribute('aria-valuemin', '0');
      rail.setAttribute('aria-valuemax', String(slots.length - 1));
      rail.setAttribute('aria-valuenow', String(activeIndex));
      rail.setAttribute('aria-valuetext', activeSlot?.slot_label || activeSlot?.slot_key || '');
      rail.tabIndex = 0;

      const track = document.createElement('div');
      track.className = 'timeline-rail-track';
      track.style.setProperty('--timeline-active-pct', `${activePct}%`);
      addTimelinePhaseIcons(track, day?.day_key || selectedBaseDate);

      const fill = document.createElement('div');
      fill.className = 'timeline-rail-fill';
      track.appendChild(fill);

      const cursor = document.createElement('div');
      cursor.className = 'timeline-rail-cursor';
      cursor.innerHTML = `<span>${String(activeHour).padStart(2, '0')}h</span>`;
      track.appendChild(cursor);

      for (let index = 0; index < slots.length; index += 1) {
        const slot = slots[index];
        const pct = (index / denominator) * 100;
        const hasAromeCache = typeof meteoFranceGribCachedSlotKeys !== 'undefined' && meteoFranceGribCachedSlotKeys.has(slot.slot_key);
        const isAromeLoaded = Array.isArray(slot.cells) && slot.cells.some((cell) => cell?.source_provider === 'meteofrance_arome_grib');
        const isUnavailable = timelineSlotIsUnavailable(slot, day);
        const mark = document.createElement('div');
        mark.className = [
          'timeline-hour-mark',
          slot.slot_key === selectedSlotKey ? 'active' : '',
          hasAromeCache ? 'is-arome-cached' : '',
          isAromeLoaded ? 'is-arome-loaded' : '',
          isUnavailable ? 'is-arome-unavailable' : '',
        ].filter(Boolean).join(' ');
        mark.dataset.slotKey = slot.slot_key;
        mark.style.left = `${pct}%`;
        mark.title = isUnavailable
          ? `${slot.slot_label} · échéance non publiée par le run AROME`
          : (isAromeLoaded
            ? `${slot.slot_label} · AROME GRIB chargé`
            : (hasAromeCache ? `${slot.slot_label} · AROME GRIB en cache serveur` : slot.slot_label));

        const line = document.createElement('span');
        line.className = 'timeline-hour-line';
        const label = document.createElement('span');
        label.className = 'timeline-hour-label';
        label.textContent = String(slot.slot_label || '').replace('h', '');
        mark.appendChild(line);
        mark.appendChild(label);
        track.appendChild(mark);
      }

      const wheel = buildTimelineWheel(slots, day);
      slotButtons.appendChild(wheel);
      rail.appendChild(track);
      slotButtons.appendChild(rail);
      syncTimelinePlaybackUi();
      requestAnimationFrame(() => syncTimelineWheelScrollToSelected({ smooth: false }));
    }
