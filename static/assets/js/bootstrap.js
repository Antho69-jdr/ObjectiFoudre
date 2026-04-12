
    toggleCalendarBtn.addEventListener('click', () => toggleTopPanel('calendar'));
    toggleSearchBtn.addEventListener('click', () => toggleTopPanel('search'));
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
    if (todayBtn) {
      todayBtn.addEventListener('click', () => applySelectedDate(getTodayIsoDate(), { force: true, loadingMessage: 'Chargement de la date du jour…' }));
    }
    if (dateInput) {
      dateInput.addEventListener('change', (event) => {
        const nextDate = normalizeDateIso(event.target?.value);
        applySelectedDate(nextDate, { force: true, loadingMessage: 'Chargement de la date…' });
      });
    }
    if (slotSelect) {
      slotSelect.addEventListener('change', (event) => {
        const nextSlotKey = String(event.target?.value || '');
        const currentDay = getCurrentDay();
        const nextSlot = currentDay?.slots?.find(s => s.slot_key === nextSlotKey);
        if (!nextSlot) return;
        selectedSlotKey = nextSlot.slot_key;
        closeSelection();
        closeDetails();
        renderSlotButtons();
        requestAnimationFrame(alignTopPanels);
        refreshMap();
      });
    }

    if (prevDayBtn) {
      prevDayBtn.addEventListener('click', () => {
        const base = new Date(`${normalizeDateIso(selectedBaseDate)}T12:00:00`);
        base.setDate(base.getDate() - 1);
        applySelectedDate(base.toISOString().slice(0, 10), { force: true, loadingMessage: 'Chargement du jour précédent…' });
      });
    }
    if (nextDayBtn) {
      nextDayBtn.addEventListener('click', () => {
        const base = new Date(`${normalizeDateIso(selectedBaseDate)}T12:00:00`);
        base.setDate(base.getDate() + 1);
        applySelectedDate(base.toISOString().slice(0, 10), { force: true, loadingMessage: 'Chargement du jour suivant…' });
      });
    }
    if (layerModeBtn && layerPanel) {
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
    if (slotButtons) {
      let isPointerDown = false;
      let dragStartX = 0;
      let dragStartScroll = 0;
      slotButtons.addEventListener('wheel', (event) => {
        if (Math.abs(event.deltaY) > Math.abs(event.deltaX)) {
          slotButtons.scrollLeft += event.deltaY;
          event.preventDefault();
        }
      }, { passive: false });
      slotButtons.addEventListener('pointerdown', (event) => {
        isPointerDown = true;
        dragStartX = event.clientX;
        dragStartScroll = slotButtons.scrollLeft;
        slotButtons.classList.add('dragging');
      });
      window.addEventListener('pointermove', (event) => {
        if (!isPointerDown) return;
        slotButtons.scrollLeft = dragStartScroll - (event.clientX - dragStartX);
      });
      const stopDrag = () => {
        isPointerDown = false;
        slotButtons.classList.remove('dragging');
      };
      window.addEventListener('pointerup', stopDrag);
      window.addEventListener('pointercancel', stopDrag);
    }

    installChip.addEventListener('click', installApp);
    window.addEventListener('resize', () => {
      if (!isMobileLayout()) closeTopPanels();
      requestAnimationFrame(() => {
        alignTopPanels();
        positionSelectionCard();
      });
    });
    document.addEventListener('visibilitychange', maybeRefreshOnReturn);
    updateBestCellsButton();

    document.querySelectorAll('[data-metric]').forEach(btn => {
      btn.addEventListener('click', () => {
        const metricKey = btn.dataset.metric;
        const valueEl = btn.querySelector('.value');
        openMetricInfo(metricKey, valueEl?.textContent?.trim() || '—');
      });
    });

    map.on('click', (e) => {
      const features = map.queryRenderedFeatures(e.point, { layers: ['grid-fill'] });
      if (!features.length && !detailsModal.classList.contains('visible')) closeSelection();
      if (!features.length) { closeTopPanels(); closeInfoDrawer(); }
    });

    registerPWA();

    map.on('move', () => {
      if (selectionCard.classList.contains('visible')) requestAnimationFrame(positionSelectionCard);
    });

    map.on('load', async () => {
      cityInput.value = currentCenter.label;
      await loadData().catch(err => {
        console.warn(err);
        setMetaMessage('Impossible de charger la zone initiale.');
      });
    });
