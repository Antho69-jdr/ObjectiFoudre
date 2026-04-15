    function payloadHasUsableSlots(nextPayload, requestedDayKey) {
      const days = Array.isArray(nextPayload?.days) ? nextPayload.days : [];
      const requestedDay = days.find(day => day?.day_key === requestedDayKey);
      if (requestedDay) return Array.isArray(requestedDay.slots) && requestedDay.slots.length > 0;
      return days.some(day => Array.isArray(day?.slots) && day.slots.length > 0);
    }

    async function loadData(force = false, centerToken = centerChangeToken) {
      const signature = `${currentCenter.lat}|${currentCenter.lon}|${currentCenter.label}|${selectedBaseDate}`;
      if (!force && payload && signature === lastFetchSignature) {
        shouldAnimateNextGrid = false;
        updateMetaLine();
        renderDayButtons();
        renderSlotButtons();
        requestAnimationFrame(() => {
          renderSlotButtons();
          refreshMap();
        });
        return payload;
      }

      if (dataFetchController) dataFetchController.abort();
      const controller = new AbortController();
      dataFetchController = controller;
      const fetchToken = ++activeFetchToken;
      isFetchingData = true;
      const buildParams = (mode = 'auto') => {
        const params = new URLSearchParams({ lat: String(currentCenter.lat), lon: String(currentCenter.lon), label: currentCenter.label, date: selectedBaseDate, mode });
        if (force) params.set('force', 'true');
        return params;
      };
      try {
        let response = await fetch(`/api/latest?${buildParams('auto').toString()}`, { cache: 'no-store', signal: controller.signal });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        let nextPayload = await response.json();
        const requestedDayKey = normalizeDateIso(selectedBaseDate);
        if (requestedDayKey === getTodayIsoDate() && !payloadHasUsableSlots(nextPayload, requestedDayKey)) {
          response = await fetch(`/api/latest?${buildParams('historical').toString()}`, { cache: 'no-store', signal: controller.signal });
          if (!response.ok) throw new Error(`HTTP ${response.status}`);
          nextPayload = await response.json();
        }
        if (fetchToken != activeFetchToken || centerToken !== centerChangeToken) return payload;
        const previousSignature = lastFetchSignature;
        const previousSelectedSlotKey = selectedSlotKey;
        payload = nextPayload;
        lastFetchSignature = signature;
        shouldAnimateNextGrid = true;
        lastFetchAt = Date.now();
        const days = getDays();
        const preferredDay = getPreferredDay(days, requestedDayKey);
        selectedDayKey = preferredDay?.day_key || null;
        const renderableSlots = getRenderableSlots(preferredDay);
        const canPreserveSlot = previousSignature === signature && !!previousSelectedSlotKey;
        selectedSlotKey = canPreserveSlot && renderableSlots.some(s => s.slot_key === previousSelectedSlotKey)
          ? previousSelectedSlotKey
          : (renderableSlots[0]?.slot_key || null);
        cityInput.value = payload?.meta?.center?.label || currentCenter.label;
        currentCenter = sanitizeCenter(payload?.meta?.center || currentCenter);
        saveCurrentCenter();
        updateMetaLine();
        renderDayButtons();
        renderSlotButtons();
        requestAnimationFrame(() => {
          renderSlotButtons();
          refreshMap();
        });
        return payload;
      } catch (err) {
        if (err.name == 'AbortError') return payload;
        throw err;
      } finally {
        if (dataFetchController === controller) dataFetchController = null;
        isFetchingData = false;
      }
    }

    async function refreshCurrentData(force = true, loadingMessage = 'Actualisation…') {
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
          await applyCenter(target, { zoom: 8.4, force: true });
        } catch (firstLoadError) {
          console.warn('Initial city load failed, retrying with forced refresh.', firstLoadError);
          currentCenter = sanitizeCenter(target);
          saveCurrentCenter();
          cityInput.value = currentCenter.label;
          stageCenterChange(target, { zoom: 8.4 });
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
