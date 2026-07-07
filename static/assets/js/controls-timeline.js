// controls-timeline.js — issu du découpage de controls.js (Phase 3).
// État partagé MeteoFrance + contrôles timeline/créneaux/UI bas. Script classique, chargé 1er.
    const METEOFRANCE_API_KEY_STORAGE_KEY = 'storm_meteofrance_api_key';
    const METEOFRANCE_WCS_MAX_DAYS_AHEAD = 1;
    const METEOFRANCE_PRELOAD_POLL_START_MS = 1200;
    const METEOFRANCE_PRELOAD_POLL_RUNNING_MS = 2500;
    const METEOFRANCE_PRELOAD_POLL_ERROR_MS = 5000;
    const METEOFRANCE_SERVER_POLL_RUNNING_MS = 10000;
    const METEOFRANCE_SERVER_POLL_IDLE_MS = 30000;
    const METEOFRANCE_SERVER_POLL_HIDDEN_MS = 60000;
    let mfPreloadPollTimer = null;
    let mfPreloadActiveJobKey = null;
    let mfPreloadClientStartedAtMs = 0;
    let mfPreloadUiTickTimer = null;
    let mfPreloadUiSnapshot = null;
    let mfCachedGribFetchToken = 0;
    let mfFranceDayHydrationToken = 0;
    let mfFranceDayHydrationKey = '';
    let mfFranceDayHydrationPromise = null;
    // generated_at du payload mergé par "date|slotKey" : évite de re-merger un créneau
    // identique lors de la revalidation réseau d'un hit IndexedDB.
    const mfAromeSlotGeneratedAt = new Map();
    let mfFranceDayMaterializeToken = 0;
    let mfFranceDayMaterializeKey = '';
    let mfFranceDayMaterializePromise = null;
    let mfAromeGeojsonPrewarmTimer = null;
    let mfQuotaCooldownTimer = null;
    let mfQuotaCooldownEndsAtMs = 0;
    let mfQuotaCooldownMessage = '';
    let mfQuotaCooldownSourceKey = '';
    let mfQuotaCooldownResumeTimer = null;
    let mfQuotaCooldownResumeDate = '';
    let mfQuotaCooldownResumeEndsAtMs = 0;
    let mfQuotaCooldownResumeSourceKey = '';
    let mfServerAutomationPollTimer = null;
    let mfServerAutomationFetchToken = 0;
    let mfServerAutomationLastCoverageKey = '';
    let mfServerAutomationLastMessage = '';
    let exportFormatMenu = null;

    function shiftSelectedDate(daysDelta, loadingMessage) {
      const base = new Date(`${normalizeDateIso(selectedBaseDate)}T12:00:00`);
      base.setDate(base.getDate() + daysDelta);
      applySelectedDate(base.toISOString().slice(0, 10), { force: true, loadingMessage });
    }

    function setupSlotButtonsDrag() {
      if (!slotButtons) return;
      let activePointerId = null;
      let lastWheelAt = 0;
      const WHEEL_THROTTLE_MS = 90;

      const timelineSlots = () => getRenderableSlots(getCurrentDay());
      const selectableTimelineSlots = () => (typeof getSelectableSlots === 'function' ? getSelectableSlots(getCurrentDay()) : timelineSlots());
      const selectedTimelineIndex = (slots = selectableTimelineSlots()) => Math.max(0, slots.findIndex((slot) => slot?.slot_key === selectedSlotKey));
      const isTimelineWheelTarget = (event) => !!event?.target?.closest?.('.timeline-wheel');
      const slotKeyAtClientX = (clientX) => {
        const day = getCurrentDay();
        const slots = timelineSlots();
        if (!slots.length) return null;
        const track = slotButtons.querySelector('.timeline-rail-track') || slotButtons;
        const rect = track.getBoundingClientRect();
        const ratio = rect.width > 0 ? (clientX - rect.left) / rect.width : 0;
        const index = Math.max(0, Math.min(slots.length - 1, Math.round(ratio * Math.max(1, slots.length - 1))));
        const slot = typeof nearestSelectableSlotForIndex === 'function' ? nearestSelectableSlotForIndex(slots, index, day) : slots[index];
        return slot?.slot_key || null;
      };
      const selectByDelta = (delta) => {
        const slots = selectableTimelineSlots();
        if (!slots.length) return false;
        const currentIndex = selectedTimelineIndex(slots);
        const nextIndex = Math.max(0, Math.min(slots.length - 1, currentIndex + delta));
        const nextKey = slots[nextIndex]?.slot_key;
        if (!nextKey || nextKey === selectedSlotKey) return false;
        if (typeof selectTimelineSlot === 'function') return selectTimelineSlot(nextKey);
        selectedSlotKey = nextKey;
        renderSlotButtons();
        refreshMap();
        return true;
      };

      slotButtons.addEventListener('wheel', (event) => {
        if (isTimelineWheelTarget(event)) return;
        const delta = Math.abs(event.deltaY) >= Math.abs(event.deltaX) ? event.deltaY : event.deltaX;
        if (!delta) return;
        event.preventDefault();
        const now = performance.now();
        if (now - lastWheelAt < WHEEL_THROTTLE_MS) return;
        lastWheelAt = now;
        selectByDelta(delta > 0 ? 1 : -1);
      }, { passive: false });

      // Drag du rail = APERÇU visuel pendant le glissé (curseur / remplissage /
      // marque active / aria mis à jour EN PLACE, sans reconstruire #slotButtons),
      // puis COMMIT unique au relâcher. Reconstruire le rail à chaque move
      // (renderSlotButtons via selectTimelineSlot) cassait la capture pointeur →
      // drag inopérant. La frise chasse fait pareil (setCursor léger).
      let pendingKey = null;
      const previewRailAt = (clientX) => {
        const rail = slotButtons.querySelector('.timeline-rail');
        const track = slotButtons.querySelector('.timeline-rail-track');
        if (!rail || !track) return;
        const slots = timelineSlots();
        const key = slotKeyAtClientX(clientX);
        if (!key) return;
        pendingKey = key;
        const index = slots.findIndex((s) => s?.slot_key === key);
        if (index < 0) return;
        const denom = Math.max(1, slots.length - 1);
        track.style.setProperty('--timeline-active-pct', `${(index / denom) * 100}%`);
        track.querySelectorAll('.timeline-hour-mark.active').forEach((m) => m.classList.remove('active'));
        const escKey = (window.CSS && CSS.escape) ? CSS.escape(key) : key;
        track.querySelector(`.timeline-hour-mark[data-slot-key="${escKey}"]`)?.classList.add('active');
        const slot = slots[index];
        const hour = String(slot?.slot_label || slot?.slot_key || '').replace(/^h/, '').replace('h', '');
        const span = track.querySelector('.timeline-rail-cursor span');
        if (span) span.textContent = `${String(hour).padStart(2, '0')}h`;
        rail.setAttribute('aria-valuenow', String(index));
        rail.setAttribute('aria-valuetext', slot?.slot_label || slot?.slot_key || '');
      };

      slotButtons.addEventListener('pointerdown', (event) => {
        if (isTimelineWheelTarget(event)) return;
        if (event.button !== undefined && event.button !== 0) return;
        activePointerId = event.pointerId;
        pendingKey = null;
        slotButtons.classList.add('dragging');
        try { slotButtons.querySelector('.timeline-rail')?.focus({ preventScroll: true }); } catch (_) {}
        try { slotButtons.setPointerCapture(event.pointerId); } catch (_) {}
        previewRailAt(event.clientX);
        event.preventDefault();
      }, { passive: false });

      slotButtons.addEventListener('pointermove', (event) => {
        if (activePointerId === null || event.pointerId !== activePointerId) return;
        previewRailAt(event.clientX);
        event.preventDefault();
      }, { passive: false });

      const stopDrag = (event) => {
        if (activePointerId === null) return;
        if (event?.pointerId !== undefined && event.pointerId !== activePointerId) return;
        try { slotButtons.releasePointerCapture(activePointerId); } catch (_) {}
        activePointerId = null;
        slotButtons.classList.remove('dragging');
        // Commit unique de la position finale (rebuild complet + carte). Si rien
        // n'a changé, on resynchronise juste le rail (aperçu → état réel).
        const key = pendingKey;
        pendingKey = null;
        if (key && key !== selectedSlotKey && typeof selectTimelineSlot === 'function') {
          selectTimelineSlot(key, { stopPlayback: true });
        } else if (typeof renderSlotButtons === 'function') {
          renderSlotButtons();
        }
      };

      slotButtons.addEventListener('pointerup', stopDrag);
      slotButtons.addEventListener('pointercancel', stopDrag);
      slotButtons.addEventListener('lostpointercapture', stopDrag);
      window.addEventListener('pointerup', stopDrag);
      window.addEventListener('pointercancel', stopDrag);

      slotButtons.addEventListener('keydown', (event) => {
        if (!['ArrowLeft', 'ArrowRight', 'Home', 'End', 'PageUp', 'PageDown'].includes(event.key)) return;
        const slots = selectableTimelineSlots();
        if (!slots.length) return;
        event.preventDefault();
        if (event.key === 'Home') {
          if (typeof selectTimelineSlot === 'function') selectTimelineSlot(slots[0].slot_key);
          return;
        }
        if (event.key === 'End') {
          if (typeof selectTimelineSlot === 'function') selectTimelineSlot(slots[slots.length - 1].slot_key);
          return;
        }
        const step = event.key === 'PageUp' || event.key === 'PageDown' ? 3 : 1;
        selectByDelta(event.key === 'ArrowLeft' || event.key === 'PageUp' ? -step : step);
      });
    }


    function loadTimelineCollapsedPreference() {
      try {
        return localStorage.getItem('storm_timeline_collapsed_v2') === '1';
      } catch (_) {
        return false;
      }
    }


    function syncTimelineToggleVisual(collapsed) {
      if (!timelineToggleBtn) return;
      const icon = timelineToggleBtn.querySelector('.timeline-toggle-icon');
      if (icon) icon.textContent = collapsed ? '↑' : '↓';
      timelineToggleBtn.setAttribute('aria-label', collapsed ? 'Afficher la frise' : 'Masquer la frise');
      timelineToggleBtn.setAttribute('title', collapsed ? 'Afficher la frise' : 'Masquer la frise');
      timelineToggleBtn.setAttribute('aria-expanded', collapsed ? 'false' : 'true');
    }

    function applyTimelineCollapsedState(collapsed) {
      if (!timelineDock) return;
      timelineDock.classList.toggle('collapsed', !!collapsed);
      syncTimelineToggleVisual(!!collapsed);
      try {
        localStorage.setItem('storm_timeline_collapsed_v2', collapsed ? '1' : '0');
      } catch (_) {}
    }

    function setupTimelineToggle() {
      if (!timelineDock || !timelineToggleBtn) return;

      const isTouchTimelineMode = () => {
        try {
          return window.matchMedia('(hover: none), (pointer: coarse)').matches;
        } catch (_) {
          return false;
        }
      };

      const toggleTimeline = () => {
        applyTimelineCollapsedState(!timelineDock.classList.contains('collapsed'));
        requestAnimationFrame(syncBottomUiLayout);
      };

      let gesturePointerId = null;
      let gestureStartY = 0;
      let gestureDragging = false;
      let gestureTriggered = false;
      const gestureThreshold = 18;

      applyTimelineCollapsedState(loadTimelineCollapsedPreference());
      requestAnimationFrame(syncBottomUiLayout);

      timelineToggleBtn.addEventListener('click', (event) => {
        event.preventDefault();
        event.stopPropagation();
        if (isTouchTimelineMode()) {
          if (!gestureDragging && !gestureTriggered) toggleTimeline();
          gestureTriggered = false;
          return;
        }
        toggleTimeline();
      });

      timelineToggleBtn.addEventListener('pointerdown', (event) => {
        if (!isTouchTimelineMode()) return;
        if (event.pointerType === 'mouse') return;
        gesturePointerId = event.pointerId;
        gestureStartY = event.clientY;
        gestureDragging = true;
        gestureTriggered = false;
        timelineToggleBtn.classList.add('is-dragging');
        try { timelineToggleBtn.setPointerCapture(event.pointerId); } catch (_) {}
        event.preventDefault();
      }, { passive: false });

      timelineToggleBtn.addEventListener('pointermove', (event) => {
        if (!gestureDragging || event.pointerId !== gesturePointerId) return;
        const deltaY = event.clientY - gestureStartY;
        const isCollapsed = timelineDock.classList.contains('collapsed');

        if (!isCollapsed && deltaY > gestureThreshold) {
          applyTimelineCollapsedState(true);
          requestAnimationFrame(syncBottomUiLayout);
          gestureTriggered = true;
          gestureDragging = false;
        } else if (isCollapsed && deltaY < -gestureThreshold) {
          applyTimelineCollapsedState(false);
          requestAnimationFrame(syncBottomUiLayout);
          gestureTriggered = true;
          gestureDragging = false;
        }

        if (gestureTriggered) {
          timelineToggleBtn.classList.remove('is-dragging');
          try { timelineToggleBtn.releasePointerCapture(event.pointerId); } catch (_) {}
          event.preventDefault();
        }
      }, { passive: false });

      const endGesture = (event) => {
        if (gesturePointerId !== null && event.pointerId !== undefined && event.pointerId !== gesturePointerId) return;
        timelineToggleBtn.classList.remove('is-dragging');
        if (gesturePointerId !== null) {
          try { timelineToggleBtn.releasePointerCapture(gesturePointerId); } catch (_) {}
        }
        gesturePointerId = null;
        gestureDragging = false;
        requestAnimationFrame(() => {
          gestureTriggered = false;
        });
      };

      timelineToggleBtn.addEventListener('pointerup', endGesture);
      timelineToggleBtn.addEventListener('pointercancel', endGesture);
    }


    function syncBottomUiLayout() {
      const root = document.documentElement;
      const metaHeight = metaCenter?.parentElement?.offsetHeight || document.querySelector('.meta-stack')?.offsetHeight || 0;
      const timelineHeight = timelineDock?.offsetHeight || 0;
      root.style.setProperty('--meta-height-px', `${Math.round(metaHeight)}px`);
      root.style.setProperty('--timeline-height-px', `${Math.round(timelineHeight)}px`);
    }

    function setupBottomUiLayoutSync() {
      const sync = () => requestAnimationFrame(syncBottomUiLayout);
      sync();
      window.addEventListener('resize', sync);
      window.addEventListener('orientationchange', sync);
      if (window.visualViewport) {
        window.visualViewport.addEventListener('resize', sync);
      }
      if (typeof ResizeObserver === 'function') {
        if (timelineDock) {
          const observer = new ResizeObserver(sync);
          observer.observe(timelineDock);
        }
        const metaStack = document.querySelector('.meta-stack');
        if (metaStack) {
          const observer = new ResizeObserver(sync);
          observer.observe(metaStack);
        }
      }
    }

    function setupMetricInfoTriggers() {}


