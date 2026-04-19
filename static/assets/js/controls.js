    function syncSlotSelection(nextSlotKey) {
      const currentDay = getCurrentDay();
      const nextSlot = currentDay?.slots?.find(s => s.slot_key === nextSlotKey);
      if (!nextSlot) return;
      selectedSlotKey = nextSlot.slot_key;
      closeSelection();
      closeDetails();
      renderSlotButtons();
      requestAnimationFrame(alignTopPanels);
      refreshMap();
    }

    function shiftSelectedDate(daysDelta, loadingMessage) {
      const base = new Date(`${normalizeDateIso(selectedBaseDate)}T12:00:00`);
      base.setDate(base.getDate() + daysDelta);
      applySelectedDate(base.toISOString().slice(0, 10), { force: true, loadingMessage });
    }

    function setupLayerModeControls() {
      if (!layerModeBtn || !layerPanel) return;
      const positionLayerPanel = () => {
        const rect = layerModeBtn.getBoundingClientRect();
        const panelWidth = layerPanel.offsetWidth || 220;
        const gap = 12;
        const top = Math.max(12, Math.min(rect.top + (rect.height / 2) - ((layerPanel.offsetHeight || 260) / 2), window.innerHeight - (layerPanel.offsetHeight || 260) - 12));
        const left = Math.max(12, rect.left - panelWidth - gap);
        layerPanel.style.top = `${Math.round(top)}px`;
        layerPanel.style.left = `${Math.round(left)}px`;
        layerPanel.style.right = 'auto';
      };
      layerModeBtn.addEventListener('click', (event) => {
        event.stopPropagation();
        const nextVisible = !layerPanel.classList.contains('visible');
        layerPanel.classList.toggle('visible', nextVisible);
        layerPanel.setAttribute('aria-hidden', nextVisible ? 'false' : 'true');
        if (nextVisible) requestAnimationFrame(positionLayerPanel);
      });
      window.addEventListener('resize', () => {
        if (layerPanel.classList.contains('visible')) positionLayerPanel();
      });
      layerPanel.addEventListener('click', (event) => event.stopPropagation());
      document.querySelectorAll('.layer-option').forEach((btn) => {
        btn.addEventListener('click', () => {
          selectedColorMetric = btn.dataset.layerMetric || 'trigger_score';
          syncLayerModeUI();
          refreshGridColors();
        });
      });
      document.addEventListener('click', () => {
        layerPanel.classList.remove('visible');
        layerPanel.setAttribute('aria-hidden', 'true');
      });
      syncLayerModeUI();
    }

    function setupSlotButtonsDrag() {
      if (!slotButtons) return;
      let activePointerId = null;
      let dragStartX = 0;
      let dragStartY = 0;
      let dragStartScrollLeft = 0;
      let dragStartScrollTop = 0;
      let dragDistance = 0;
      let hasDragged = false;
      let suppressNextClick = false;
      const DRAG_THRESHOLD = 6;

      const useVerticalTimeline = () => window.matchMedia('(max-width: 640px)').matches;
      const useTouchDrag = () => {
        try {
          return window.matchMedia('(hover: none), (pointer: coarse)').matches;
        } catch (_) {
          return false;
        }
      };

      slotButtons.addEventListener('wheel', (event) => {
        if (useVerticalTimeline()) return;
        if (Math.abs(event.deltaY) > Math.abs(event.deltaX)) {
          slotButtons.scrollLeft += event.deltaY;
          event.preventDefault();
        }
      }, { passive: false });

      const stopDrag = (event) => {
        if (activePointerId === null) return;
        if (event?.pointerId !== undefined && event.pointerId !== activePointerId) return;
        try { slotButtons.releasePointerCapture(activePointerId); } catch (_) {}
        activePointerId = null;
        slotButtons.classList.remove('dragging');
        requestAnimationFrame(() => {
          dragDistance = 0;
          hasDragged = false;
          suppressNextClick = false;
        });
      };

      slotButtons.addEventListener('pointerdown', (event) => {
        if (!useTouchDrag()) return;
        if (event.pointerType === 'mouse') return;
        if (event.button !== undefined && event.button !== 0) return;
        activePointerId = event.pointerId;
        dragStartX = event.clientX;
        dragStartY = event.clientY;
        dragStartScrollLeft = slotButtons.scrollLeft;
        dragStartScrollTop = slotButtons.scrollTop;
        dragDistance = 0;
        hasDragged = false;
        suppressNextClick = false;
        try { slotButtons.setPointerCapture(event.pointerId); } catch (_) {}
      });

      window.addEventListener('pointermove', (event) => {
        if (activePointerId === null || event.pointerId !== activePointerId) return;
        const deltaX = event.clientX - dragStartX;
        const deltaY = event.clientY - dragStartY;
        dragDistance = Math.max(dragDistance, Math.abs(useVerticalTimeline() ? deltaY : deltaX));

        if (!hasDragged && dragDistance > DRAG_THRESHOLD) {
          hasDragged = true;
          suppressNextClick = true;
          slotButtons.classList.add('dragging');
        }

        if (!hasDragged) return;

        if (useVerticalTimeline()) {
          slotButtons.scrollTop = dragStartScrollTop - deltaY;
        } else {
          slotButtons.scrollLeft = dragStartScrollLeft - deltaX;
        }
        event.preventDefault();
      }, { passive: false });

      slotButtons.addEventListener('click', (event) => {
        if (!useTouchDrag()) return;
        if (suppressNextClick) {
          event.preventDefault();
          event.stopPropagation();
          suppressNextClick = false;
        }
      }, true);

      slotButtons.addEventListener('pointerup', stopDrag);
      slotButtons.addEventListener('pointercancel', stopDrag);
      slotButtons.addEventListener('lostpointercapture', stopDrag);
      window.addEventListener('pointerup', stopDrag);
      window.addEventListener('pointercancel', stopDrag);
    }


    function loadTimelineCollapsedPreference() {
      try {
        return localStorage.getItem('storm_timeline_collapsed') === '1';
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
        localStorage.setItem('storm_timeline_collapsed', collapsed ? '1' : '0');
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

    function setupMetricInfoTriggers() {
      document.querySelectorAll('[data-metric]').forEach((btn) => {
        btn.addEventListener('click', () => {
          const metricKey = btn.dataset.metric;
          const valueEl = btn.querySelector('.value');
          openMetricInfo(metricKey, valueEl?.textContent?.trim() || '—');
        });
      });
    }


    function downloadHistoricalCsv(params, filenameHint = '') {
      const query = new URLSearchParams(params);
      const url = `/api/historical-analysis.csv?${query.toString()}`;
      const link = document.createElement('a');
      link.href = url;
      if (filenameHint) link.download = filenameHint;
      document.body.appendChild(link);
      link.click();
      link.remove();
    }

    function exportCurrentSlotCsv() {
      const slotKey = selectedFeature?.slot_key || selectedSlotKey;
      if (!slotKey) {
        setMetaMessage('Sélectionne d’abord un créneau historical pour exporter le CSV.');
        return;
      }
      downloadHistoricalCsv({
        lat: String(currentCenter.lat),
        lon: String(currentCenter.lon),
        label: currentCenter.label,
        date: selectedBaseDate,
        slot: slotKey,
      }, `storm-chase-${selectedBaseDate}-${slotKey}.csv`);
      setMetaMessage(`Export CSV du créneau ${slotKey} lancé.`);
    }

    function exportSelectedCellDayCsv() {
      if (!selectedFeature?.zone) {
        setMetaMessage('Sélectionne d’abord une cellule pour exporter sa journée complète.');
        return;
      }
      downloadHistoricalCsv({
        lat: String(currentCenter.lat),
        lon: String(currentCenter.lon),
        label: currentCenter.label,
        date: selectedBaseDate,
        zone: selectedFeature.zone,
      }, `storm-chase-${selectedBaseDate}-${selectedFeature.zone}.csv`);
      setMetaMessage(`Export CSV de la cellule ${selectedFeature.zone} lancé.`);
    }

    function setupPrimaryControls() {
      toggleSearchBtn.addEventListener('click', (event) => {
        event.preventDefault();
        event.stopPropagation();
        const shouldOpen = !topbar.classList.contains('show-search');
        closeTopPanels();
        if (cityInput) {
          cityInput.value = '';
          cityInput.placeholder = 'Tape une ville, un secteur ou un point de départ…';
        }
        if (shouldOpen) {
          topbar.classList.add('show-search');
          requestAnimationFrame(() => cityInput?.focus({ preventScroll: true }));
        }
        requestAnimationFrame(alignTopPanels);
      });
      closeSelectionBtn?.addEventListener('click', closeSelection);
      openDetailsBtn?.addEventListener('click', openDetails);
      recenterBtn?.addEventListener('click', () => {
        if (!selectedFeature) return;
        map.easeTo({ center: [Number(selectedFeature.lon), Number(selectedFeature.lat)], duration: 700, zoom: Math.max(map.getZoom(), 10.2) });
      });
      closeDetailsBtn?.addEventListener('click', closeDetails);
      exportSlotCsvBtn?.addEventListener('click', exportCurrentSlotCsv);
      exportDayCellCsvBtn?.addEventListener('click', exportSelectedCellDayCsv);
      modalBackdrop?.addEventListener('click', closeDetails);
      closeInfoBtn?.addEventListener('click', closeMetricInfo);
      infoBackdrop?.addEventListener('click', closeMetricInfo);
      infoDrawerBtn?.addEventListener('click', () => infoDrawer.classList.contains('visible') ? closeInfoDrawer() : openInfoDrawer());
      closeDrawerBtn?.addEventListener('click', closeInfoDrawer);
      drawerBackdrop?.addEventListener('click', closeInfoDrawer);
      locateBtn?.addEventListener('click', locateUser);
      refreshBtn?.addEventListener('click', () => refreshCurrentData(true));
      bestCellsBtn?.addEventListener('click', toggleBestCellsMode);
      gridLinesBtn?.addEventListener('click', toggleGridLines);
      if (typeof aroundMeBtn !== 'undefined' && aroundMeBtn) aroundMeBtn.addEventListener('click', locateUser);
      searchCityBtn?.addEventListener('click', handleCitySearch);
      cityInput?.addEventListener('keydown', (event) => { if (event.key === 'Enter') handleCitySearch(); });
      mockModeBtn?.addEventListener('click', async (event) => {
        event.preventDefault();
        event.stopPropagation();
        selectedDataMode = selectedDataMode === 'mock' ? 'real' : 'mock';
        saveStoredDataMode(selectedDataMode);
        updateDataModeUi();
        await refreshCurrentData(true, selectedDataMode === 'mock' ? 'Chargement des données mock…' : 'Chargement des données réelles…');
      });

      document.addEventListener('click', (event) => {
        if (!topbar.contains(event.target)) closeTopPanels();
      });


      if (todayBtn) {
        todayBtn.addEventListener('click', () => applySelectedDate(getTodayIsoDate(), { force: true, loadingMessage: 'Chargement de la date du jour…' }));
      }
      if (dateInput) {
        dateInput.addEventListener('change', (event) => {
          const nextDate = normalizeDateIso(event.target?.value);
          applySelectedDate(nextDate, { force: true, loadingMessage: 'Chargement de la date…' });
        });
      }
      if (prevDayBtn) {
        prevDayBtn.addEventListener('click', () => {
          shiftSelectedDate(-1, 'Chargement du jour précédent…');
        });
      }
      if (nextDayBtn) {
        nextDayBtn.addEventListener('click', () => {
          shiftSelectedDate(1, 'Chargement du jour suivant…');
        });
      }

      setupLayerModeControls();
      setupSlotButtonsDrag();
      setupMetricInfoTriggers();
      setupTimelineToggle();
      setupBottomUiLayoutSync();

      installChip?.addEventListener('click', installApp);
    }
