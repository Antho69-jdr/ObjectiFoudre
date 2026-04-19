    function isHistoricalSlot(day, slot) {
      const dayKey = normalizeDateIso(day?.day_key);
      const todayKey = getTodayIsoDate();
      if (dayKey && dayKey < todayKey) return true;
      const selectedIso = slot?.cells?.[0]?.selected_time_iso;
      if (!selectedIso) return false;
      const ts = Date.parse(selectedIso);
      return Number.isFinite(ts) && ts < Date.now();
    }

    function syncTimelinePlaybackUi() {
      if (!playTimelineBtn) return;
      const isRunning = !!timelinePlaybackRunning;
      playTimelineBtn.classList.toggle('active', isRunning);
      playTimelineBtn.setAttribute('aria-pressed', isRunning ? 'true' : 'false');
      playTimelineBtn.textContent = isRunning ? '❚❚' : '▶';
      playTimelineBtn.setAttribute('aria-label', isRunning ? 'Mettre en pause la lecture des horaires' : 'Lire les horaires du jour');
      playTimelineBtn.title = isRunning ? 'Mettre en pause la lecture des horaires' : 'Lire les horaires du jour';
      const hasPlayableSlots = getRenderableSlots(getCurrentDay()).length > 1;
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
        const slots = getRenderableSlots(currentDay);
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
        const slots = getRenderableSlots(currentDay);
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
        scheduleTimelinePlaybackStep();
      }, TIMELINE_PLAYBACK_STEP_MS);
    }

    function toggleTimelinePlayback() {
      const currentDay = getCurrentDay();
      const slots = getRenderableSlots(currentDay);
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
          selectedDayKey = day.day_key;
          selectedSlotKey = renderableSlots[0]?.slot_key || null;
          closeSelection();
          closeDetails();
          renderDayButtons();
          renderSlotButtons();
          requestAnimationFrame(alignTopPanels);
          debugLog('renderDayButtons:click', { selectedDayKey, selectedSlotKey });
          debugLog('renderSlotButtons:click', { selectedDayKey, selectedSlotKey });
          refreshMap();
        };
        dayButtons.appendChild(btn);
      }
      syncTimelinePlaybackUi();
    }

    function renderSlotButtons() {
      const day = getCurrentDay();
      slotButtons.innerHTML = '';
      const slots = getRenderableSlots(day);
      debugLog('renderSlotButtons', slots.map(slot => ({ slotKey: slot?.slot_key, label: slot?.slot_label, cells: Array.isArray(slot?.cells) ? slot.cells.length : 0 })));
      if (!slots.length) {
        syncTimelinePlaybackUi();
        return;
      }
      if (!selectedSlotKey || !slots.some(s => s.slot_key === selectedSlotKey)) selectedSlotKey = slots[0].slot_key;
      let activeButton = null;
      for (const slot of slots) {
        const btn = document.createElement('button');
        btn.textContent = slot.slot_label;
        const historicalClass = isHistoricalSlot(day, slot) ? 'is-historical' : '';
        const isActive = slot.slot_key === selectedSlotKey;
        btn.className = `slot-pill ${isActive ? 'active' : ''} ${historicalClass}`.trim();
        if (isActive) activeButton = btn;
        btn.onclick = () => {
          if (typeof stopTimelinePlayback === 'function') stopTimelinePlayback({ resetToStart: false });
          selectedSlotKey = slot.slot_key;
          closeSelection();
          closeDetails();
          renderSlotButtons();
          requestAnimationFrame(alignTopPanels);
          refreshMap();
        };
        slotButtons.appendChild(btn);
      }
      if (activeButton) {
        requestAnimationFrame(() => {
          try { activeButton.scrollIntoView({ behavior: timelinePlaybackRunning ? 'smooth' : 'auto', inline: 'center', block: 'nearest' }); } catch (_) {}
        });
      }
      syncTimelinePlaybackUi();
    }
