// timeline-solar.js — issu du découpage de timeline.js (Phase 3).
// Boutons jour + sélection créneau + calculs solaires (jour/nuit, lever/coucher, phases).
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
      const loc = sunWindow.location || timelineSolarReferenceLocation();
      const normalized = normalizeDateIso(dateIso || selectedBaseDate || getTodayIsoDate());
      // Les nuits TRAVERSENT minuit : on ne clampe plus à 00:00 / 24:00.
      // - Nuit du matin : coucher de la VEILLE → lever du jour (ex. « 20:45-06:58 »).
      // - Nuit du soir : coucher du jour → lever du LENDEMAIN (ex. « 20:47-06:59 »).
      const morningNightEnd = sunWindow.sunrise;                              // lever du jour
      const prevSunset = timelineSolarEventHour(addDaysIso(normalized, -1), loc.lat, loc.lon, false); // coucher veille
      const eveningNightStart = sunWindow.sunset;                             // coucher du jour
      const nextSunrise = timelineSolarEventHour(addDaysIso(normalized, 1), loc.lat, loc.lon, true);  // lever lendemain
      const morningNightStartLabel = Number.isFinite(prevSunset) ? formatTimelineSunHour(prevSunset) : '00:00';
      const eveningNightEndLabel = Number.isFinite(nextSunrise) ? formatTimelineSunHour(nextSunrise) : '24:00';
      return [
        { type: 'night', hour: sunWindow.sunrise / 2, label: 'Nuit', tooltip: `Nuit · ${morningNightStartLabel}-${formatTimelineSunHour(morningNightEnd)}` },
        { type: 'sunrise', hour: sunWindow.sunrise, label: 'Lever' },
        { type: 'day', hour: sunWindow.noon, label: 'Journée', tooltip: `Journée · ${formatTimelineSunHour(sunWindow.sunrise)}-${formatTimelineSunHour(sunWindow.sunset)}` },
        { type: 'sunset', hour: sunWindow.sunset, label: 'Coucher' },
        { type: 'night', hour: sunWindow.sunset + ((24 - sunWindow.sunset) / 2), label: 'Nuit', tooltip: `Nuit · ${formatTimelineSunHour(eveningNightStart)}-${eveningNightEndLabel}` },
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

