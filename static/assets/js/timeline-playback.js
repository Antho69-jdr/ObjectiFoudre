// timeline-playback.js — issu du découpage de timeline.js (Phase 3).
// Lecture animée de la frise (icônes, UI, planification des pas). Chargé 1er.
    function timelinePlaybackIcon(isRunning) {
      return isRunning
        ? '<svg class="icon-svg" viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"></circle><rect x="9" y="8.3" width="2.2" height="7.4" rx="0.6" fill="currentColor" stroke="none"></rect><rect x="12.8" y="8.3" width="2.2" height="7.4" rx="0.6" fill="currentColor" stroke="none"></rect></svg>'
        : '<svg class="icon-svg" viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"></circle><path d="M10 8.2 16.3 12 10 15.8Z" fill="currentColor" stroke="none"></path></svg>';
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

