    function payloadHasUsableSlots(nextPayload, requestedDayKey) {
      const days = Array.isArray(nextPayload?.days) ? nextPayload.days : [];
      const requestedDay = days.find(day => day?.day_key === requestedDayKey);
      if (requestedDay) return getRenderableSlots(requestedDay).length > 0;
      return days.some(day => getRenderableSlots(day).length > 0);
    }

    async function loadData(force = false, centerToken = centerChangeToken) {
      const signature = `${currentCenter.lat}|${currentCenter.lon}|${currentCenter.label}|${selectedBaseDate}`;
      debugLog('loadData:start', { force, centerToken, activeCenterToken: centerChangeToken, signature, currentCenter, selectedBaseDate, hasPayload: Boolean(payload) });
      if (!force && payload && signature === lastFetchSignature) {
        shouldAnimateNextGrid = false;
        updateMetaLine();
        renderDayButtons();
        renderSlotButtons();
        refreshMap();
        return payload;
      }

      if (dataFetchController) dataFetchController.abort();
      const controller = new AbortController();
      dataFetchController = controller;
      const fetchToken = ++activeFetchToken;
      isFetchingData = true;
      const buildParams = (mode = 'auto') => {
        const effectiveMode = selectedDataMode === 'mock' ? 'mock' : mode;
        const params = new URLSearchParams({ lat: String(currentCenter.lat), lon: String(currentCenter.lon), label: currentCenter.label, date: selectedBaseDate, mode: effectiveMode });
        if (force) params.set('force', 'true');
        return params;
      };
      try {
        let response = await fetch(`/api/latest?${buildParams('auto').toString()}`, { cache: 'no-store', signal: controller.signal });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        let nextPayload = await response.json();
        debugLog('loadData:auto-response', { ok: response.ok, status: response.status, dayCount: Array.isArray(nextPayload?.days) ? nextPayload.days.length : 0, meta: nextPayload?.meta || null, selectedDataMode });
        const requestedDayKey = normalizeDateIso(selectedBaseDate);
        debugLog('loadData:requested-day', { requestedDayKey });
        if (selectedDataMode !== 'mock' && requestedDayKey === getTodayIsoDate() && !payloadHasUsableSlots(nextPayload, requestedDayKey)) {
          response = await fetch(`/api/latest?${buildParams('historical').toString()}`, { cache: 'no-store', signal: controller.signal });
          if (!response.ok) throw new Error(`HTTP ${response.status}`);
          nextPayload = await response.json();
          debugLog('loadData:historical-fallback-response', { ok: response.ok, status: response.status, dayCount: Array.isArray(nextPayload?.days) ? nextPayload.days.length : 0, meta: nextPayload?.meta || null });
        }
        if (selectedDataMode !== 'mock') {
          const warning = String(nextPayload?.meta?.warning || '').toLowerCase();
          if (warning.includes('mode mock') || warning.includes('mock aléatoire')) {
            selectedDataMode = 'mock';
            saveStoredDataMode(selectedDataMode);
            updateDataModeUi();
            debugLog('loadData:auto-mock-fallback', { warning: nextPayload?.meta?.warning || null });
          }
        }
        if (fetchToken != activeFetchToken || centerToken !== centerChangeToken) return payload;
        payload = nextPayload;
        lastFetchSignature = signature;
        shouldAnimateNextGrid = true;
        lastFetchAt = Date.now();
        cityInput.value = payload?.meta?.center?.label || currentCenter.label;
        currentCenter = sanitizeCenter(payload?.meta?.center || currentCenter);
        saveCurrentCenter();

        const days = getDays();
        debugLog('loadData:days-built', days.map(day => ({ dayKey: day?.day_key, slotCount: Array.isArray(day?.slots) ? day.slots.length : 0, renderableSlots: getRenderableSlots(day).length })));
        const selection = findFirstRenderableSelection(days, requestedDayKey || selectedDayKey, selectedSlotKey);
        debugLog('loadData:selection', selection);
        selectedDayKey = selection.dayKey;
        selectedSlotKey = selection.slotKey;
        selectedFeature = null;

        updateMetaLine();
        renderDayButtons();
        renderSlotButtons();
        requestAnimationFrame(() => {
          debugLog('loadData:raf-refreshMap', { selectedDayKey, selectedSlotKey });
          refreshMap();
        });
        return payload;
      } catch (err) {
        if (err.name == 'AbortError') { debugLog('loadData:abort'); return payload; }
        console.error('loadData:error', err);
        throw err;
      } finally {
        if (dataFetchController === controller) dataFetchController = null;
        isFetchingData = false;
      }
    }

    async function refreshCurrentData(force = true, loadingMessage = 'Actualisation…') {
      if (typeof stopTimelinePlayback === 'function') stopTimelinePlayback({ resetToStart: false });
      setLoadingState(true, loadingMessage);
      try {
        await loadData(force);
      } catch (err) {
        console.warn(err);
        setMetaMessage('Impossible d’actualiser la zone courante.');
        if (!hasCompletedInitialLoad) hideAppLoader();
      } finally {
        setLoadingState(false);
      }
    }

    function maybeRefreshOnReturn() {
      if (document.visibilityState !== 'visible') return;
      const isStale = !lastFetchAt || (Date.now() - lastFetchAt) >= VISIBILITY_REFRESH_MS;
      if (!isStale) return;
      refreshCurrentData(false, 'Vérification des données…');
    }

    async function handleCitySearch() {
      const query = cityInput.value.trim();
      if (!query) {
        setMetaMessage('Saisissez une ville avant de lancer la recherche.');
        return;
      }
      if (geocodeController) geocodeController.abort();
      geocodeController = new AbortController();
      setLoadingState(true, `Recherche de ${query}…`);
      try {
        const target = await geocodeCity(query, geocodeController.signal);
        try {
          stageCenterChange(target, { zoom: 8.4 });
        } catch (uiError) {
          console.warn('City found, but center staging hit a UI error.', uiError);
          currentCenter = sanitizeCenter(target);
          saveCurrentCenter();
          cityInput.value = currentCenter.label;
        }

        await new Promise((resolve) => requestAnimationFrame(() => resolve()));

        try {
          await loadData(true, centerChangeToken);
        } catch (firstLoadError) {
          console.warn('Initial city load failed, retrying with forced refresh.', firstLoadError);
          await refreshCurrentData(true, `Chargement météo pour ${target.label}…`);
        }
      } catch (error) {
        if (error.name !== 'AbortError') {
          console.warn(error);
          const message = String(error?.message || '');
          if (/Aucun résultat|Ville vide/i.test(message)) {
            setMetaMessage('Ville introuvable. Essaie un nom plus complet.');
          } else if (/Geocoding HTTP/i.test(message)) {
            setMetaMessage('Service de recherche de ville temporairement indisponible.');
          } else {
            setMetaMessage('La ville a été trouvée, mais les données météo n’ont pas pu être chargées.');
          }
          if (!hasCompletedInitialLoad) hideAppLoader(true);
        }
      } finally {
        geocodeController = null;
        setLoadingState(false);
      }
    }
