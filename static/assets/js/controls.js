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
      layerModeBtn.addEventListener('click', (event) => {
        event.stopPropagation();
        layerPanel.classList.toggle('visible');
        layerPanel.setAttribute('aria-hidden', layerPanel.classList.contains('visible') ? 'false' : 'true');
      });
      layerPanel.addEventListener('click', (event) => event.stopPropagation());
      document.querySelectorAll('.layer-option').forEach((btn) => {
        btn.addEventListener('click', () => {
          selectedColorMetric = btn.dataset.layerMetric || 'score_global';
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
      let isPointerDown = false;
      let dragStartX = 0;
      let dragStartY = 0;
      let dragStartScrollLeft = 0;
      let dragStartScrollTop = 0;

      const useVerticalTimeline = () => window.matchMedia('(max-width: 640px)').matches;

      slotButtons.addEventListener('wheel', (event) => {
        if (useVerticalTimeline()) return;
        if (Math.abs(event.deltaY) > Math.abs(event.deltaX)) {
          slotButtons.scrollLeft += event.deltaY;
          event.preventDefault();
        }
      }, { passive: false });

      slotButtons.addEventListener('pointerdown', (event) => {
        isPointerDown = true;
        dragStartX = event.clientX;
        dragStartY = event.clientY;
        dragStartScrollLeft = slotButtons.scrollLeft;
        dragStartScrollTop = slotButtons.scrollTop;
        slotButtons.classList.add('dragging');
      });

      window.addEventListener('pointermove', (event) => {
        if (!isPointerDown) return;
        if (useVerticalTimeline()) {
          slotButtons.scrollTop = dragStartScrollTop - (event.clientY - dragStartY);
          return;
        }
        slotButtons.scrollLeft = dragStartScrollLeft - (event.clientX - dragStartX);
      });

      const stopDrag = () => {
        isPointerDown = false;
        slotButtons.classList.remove('dragging');
      };

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

    function applyTimelineCollapsedState(collapsed) {
      if (!timelineDock) return;
      timelineDock.classList.toggle('collapsed', !!collapsed);
      if (timelineToggleBtn) timelineToggleBtn.setAttribute('aria-expanded', collapsed ? 'false' : 'true');
      try {
        localStorage.setItem('storm_timeline_collapsed', collapsed ? '1' : '0');
      } catch (_) {}
    }

    function setupTimelineToggle() {
      if (!timelineDock || !timelineToggleBtn) return;
      applyTimelineCollapsedState(loadTimelineCollapsedPreference());
      timelineToggleBtn.addEventListener('click', (event) => {
        event.preventDefault();
        event.stopPropagation();
        applyTimelineCollapsedState(!timelineDock.classList.contains('collapsed'));
      });
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

    function setupPrimaryControls() {
      toggleSearchBtn.addEventListener('click', (event) => {
        event.preventDefault();
        event.stopPropagation();
        const shouldOpen = !topbar.classList.contains('show-search');
        closeTopPanels();
        if (shouldOpen) topbar.classList.add('show-search');
        requestAnimationFrame(alignTopPanels);
      });
      closeSelectionBtn.addEventListener('click', closeSelection);
      openDetailsBtn.addEventListener('click', openDetails);
      recenterBtn.addEventListener('click', () => {
        if (!selectedFeature) return;
        map.easeTo({ center: [Number(selectedFeature.lon), Number(selectedFeature.lat)], duration: 700, zoom: Math.max(map.getZoom(), 10.2) });
      });
      closeDetailsBtn.addEventListener('click', closeDetails);
      modalBackdrop.addEventListener('click', closeDetails);
      closeInfoBtn.addEventListener('click', closeMetricInfo);
      infoBackdrop.addEventListener('click', closeMetricInfo);
      infoDrawerBtn.addEventListener('click', () => infoDrawer.classList.contains('visible') ? closeInfoDrawer() : openInfoDrawer());
      closeDrawerBtn.addEventListener('click', closeInfoDrawer);
      drawerBackdrop.addEventListener('click', closeInfoDrawer);
      locateBtn.addEventListener('click', locateUser);
      refreshBtn.addEventListener('click', () => refreshCurrentData(true));
      bestCellsBtn.addEventListener('click', toggleBestCellsMode);
      gridLinesBtn.addEventListener('click', toggleGridLines);
      aroundMeBtn.addEventListener('click', locateUser);
      searchCityBtn.addEventListener('click', handleCitySearch);
      cityInput.addEventListener('keydown', (event) => { if (event.key === 'Enter') handleCitySearch(); });

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

      installChip.addEventListener('click', installApp);
    }
