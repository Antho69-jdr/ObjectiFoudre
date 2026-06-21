    function formatAromeShellDayLabel(dateIso) {
      const normalized = normalizeDateIso(dateIso);
      const parsed = new Date(`${normalized}T12:00:00`);
      if (Number.isNaN(parsed.getTime())) return normalized;
      return new Intl.DateTimeFormat('fr-FR', { weekday: 'short', day: '2-digit', month: '2-digit' }).format(parsed).replace('.', '');
    }

    function preferredAromeSlotKey() {
      if (/^h\d{2}$/.test(String(selectedSlotKey || ''))) return selectedSlotKey;
      const hour = normalizeDateIso(selectedBaseDate) === getTodayIsoDate() ? new Date().getHours() : 12;
      return `h${String(hour).padStart(2, '0')}`;
    }

    function currentAromeFrancePayloadSignature(dateIso = selectedBaseDate) {
      return `arome-france|${normalizeDateIso(dateIso)}`;
    }

    function aromeFranceSlotHasCells(slot) {
      return Array.isArray(slot?.cells) && slot.cells.some((cell) => cell?.source_provider === 'meteofrance_arome_grib');
    }

    function aromeFranceDayHasLoadedSlots(day) {
      return Array.isArray(day?.slots) && day.slots.some(aromeFranceSlotHasCells);
    }

    function normalizeAromeFranceDayForCache(day, dateIso = day?.day_key || selectedBaseDate) {
      if (!day || !aromeFranceDayHasLoadedSlots(day)) return null;
      const dayKey = normalizeDateIso(dateIso || day.day_key);
      return {
        ...day,
        day_key: dayKey,
        day_label: day.day_label || formatAromeShellDayLabel(dayKey),
        day_index: Number.isFinite(Number(day.day_index)) ? Number(day.day_index) : 0,
        slots: Array.isArray(day.slots) ? day.slots : [],
      };
    }

    function trimAromeFranceDayMemoryCache(maxDays = 5) {
      if (!(aromeFranceDayMemoryCache instanceof Map)) return;
      while (aromeFranceDayMemoryCache.size > maxDays) {
        const oldestKey = aromeFranceDayMemoryCache.keys().next().value;
        if (!oldestKey) break;
        aromeFranceDayMemoryCache.delete(oldestKey);
        if (aromeFranceDayMetaMemory instanceof Map) aromeFranceDayMetaMemory.delete(oldestKey);
        if (typeof aromeFranceAvailabilityStatusMemory !== 'undefined' && aromeFranceAvailabilityStatusMemory instanceof Map) aromeFranceAvailabilityStatusMemory.delete(oldestKey);
      }
    }

    function rememberAromeFranceDay(dayOrDate = selectedBaseDate) {
      const day = dayOrDate && typeof dayOrDate === 'object'
        ? dayOrDate
        : (Array.isArray(payload?.days) ? payload.days.find((item) => normalizeDateIso(item?.day_key) === normalizeDateIso(dayOrDate || selectedBaseDate)) : null);
      const cachedDay = normalizeAromeFranceDayForCache(day, day?.day_key || dayOrDate || selectedBaseDate);
      if (!cachedDay) return false;
      aromeFranceDayMemoryCache.set(cachedDay.day_key, cachedDay);
      if (aromeFranceDayMetaMemory instanceof Map && payload?.meta) {
        aromeFranceDayMetaMemory.set(cachedDay.day_key, { ...payload.meta });
      }
      trimAromeFranceDayMemoryCache();
      return true;
    }

    function rememberAromeFrancePayloadDays() {
      if (!Array.isArray(payload?.days)) return 0;
      let count = 0;
      for (const day of payload.days) {
        if (rememberAromeFranceDay(day)) count += 1;
      }
      return count;
    }

    function getCachedAromeFranceDay(dateIso = selectedBaseDate) {
      if (!(aromeFranceDayMemoryCache instanceof Map)) return null;
      return aromeFranceDayMemoryCache.get(normalizeDateIso(dateIso)) || null;
    }

    function buildAromeFrancePayloadFromMemory(dateIso = selectedBaseDate) {
      const dayKey = normalizeDateIso(dateIso);
      const cachedDay = getCachedAromeFranceDay(dayKey);
      if (!cachedDay) return null;
      const shell = buildAromeFranceShellPayload(dayKey);
      const cachedMeta = aromeFranceDayMetaMemory instanceof Map ? (aromeFranceDayMetaMemory.get(dayKey) || null) : null;
      const shellSlots = Array.isArray(shell.days?.[0]?.slots) ? shell.days[0].slots : [];
      const cachedSlots = Array.isArray(cachedDay.slots) ? cachedDay.slots : [];
      const cachedByKey = new Map(cachedSlots.filter((slot) => slot?.slot_key).map((slot) => [slot.slot_key, slot]));
      const mergedSlots = shellSlots.map((slot) => cachedByKey.get(slot.slot_key) || slot);
      for (const slot of cachedSlots) {
        if (slot?.slot_key && !mergedSlots.some((item) => item?.slot_key === slot.slot_key)) mergedSlots.push(slot);
      }
      mergedSlots.sort((a, b) => String(a?.slot_key || '').localeCompare(String(b?.slot_key || '')));
      const loadedSlots = mergedSlots.filter(aromeFranceSlotHasCells);
      const firstLoadedSlot = loadedSlots[0];
      shell.days[0] = {
        ...shell.days[0],
        ...cachedDay,
        day_key: dayKey,
        day_label: cachedDay.day_label || formatAromeShellDayLabel(dayKey),
        day_index: 0,
        slots: mergedSlots,
      };
      const cachedGribMeta = cachedMeta?.meteofrance_grib || {};
      shell.meta = {
        ...shell.meta,
        ...(cachedMeta || {}),
        generated_at: new Date().toISOString(),
        cache: { hit: true, backend: 'client-memory' },
        arome_shell: true,
        arome_memory_cache: true,
        meteofrance_grib: {
          ...cachedGribMeta,
          provider: 'meteofrance_arome_grib',
          source_label: 'Météo-France AROME GRIB cache',
          last_day_key: dayKey,
          last_slot_key: firstLoadedSlot?.slot_key || cachedGribMeta.last_slot_key || null,
          last_updated_at: new Date().toISOString(),
          slots: loadedSlots.map((slot) => `${dayKey}:${slot.slot_key}`),
          detail_level: cachedGribMeta.detail_level || 'core',
          grid_scope: 'france',
          france_grid: true,
          country_mask: 'france',
          france_grid_cell_count: Array.isArray(firstLoadedSlot?.cells) ? firstLoadedSlot.cells.length : cachedGribMeta.france_grid_cell_count,
          time_targets: cachedGribMeta.time_targets || cachedMeta?.time_targets,
          arome_run_reference_times: cachedGribMeta.arome_run_reference_times || cachedMeta?.arome_run_reference_times,
          arome_run_latest_reference_time: cachedGribMeta.arome_run_latest_reference_time || cachedMeta?.arome_run_latest_reference_time,
          arome_run_api_updated_at: cachedGribMeta.arome_run_api_updated_at || cachedMeta?.arome_run_api_updated_at,
        },
      };
      return shell;
    }

    function rememberMeteoFranceGribCacheStatus(dateIso = selectedBaseDate, keys = []) {
      if (!(aromeFranceCacheStatusMemory instanceof Map)) return false;
      const cleanKeys = Array.from(new Set((Array.isArray(keys) ? keys : []).filter((key) => /^h\d{2}$/.test(String(key)))));
      if (!cleanKeys.length) return false;
      aromeFranceCacheStatusMemory.set(normalizeDateIso(dateIso), new Set(cleanKeys));
      while (aromeFranceCacheStatusMemory.size > 7) {
        const oldestKey = aromeFranceCacheStatusMemory.keys().next().value;
        if (!oldestKey) break;
        aromeFranceCacheStatusMemory.delete(oldestKey);
      }
      return true;
    }

    function restoreMeteoFranceGribCacheStatus(dateIso = selectedBaseDate) {
      if (!(aromeFranceCacheStatusMemory instanceof Map)) return false;
      const cachedKeys = aromeFranceCacheStatusMemory.get(normalizeDateIso(dateIso));
      if (!cachedKeys) return false;
      meteoFranceGribCachedSlotKeys = new Set(cachedKeys);
      return true;
    }

    function buildAromeFranceShellPayload(dateIso) {
      const dayKey = normalizeDateIso(dateIso);
      const slots = Array.from({ length: 24 }, (_, hour) => {
        const slotKey = `h${String(hour).padStart(2, '0')}`;
        return {
          slot_key: slotKey,
          slot_label: `${String(hour).padStart(2, '0')}h`,
          selected_hour: `${String(hour).padStart(2, '0')}h`,
          cells: [],
          arome_placeholder: true,
          grid_scope: 'france',
          france_grid: true,
          country_mask: 'france',
          source_provider: 'meteofrance_arome_grib',
          source_label: 'Météo-France AROME GRIB cache',
        };
      });
      return {
        days: [{
          day_key: dayKey,
          day_label: formatAromeShellDayLabel(dayKey),
          day_index: 0,
          slots,
        }],
        meta: {
          mode: 'forecast',
          provider: 'meteofrance_arome_grib',
          source_provider: 'meteofrance_arome_grib',
          source_label: 'Météo-France AROME GRIB cache',
          generated_at: new Date().toISOString(),
          center: { lat: 46.65, lon: 2.45, label: 'France entière' },
          model: 'meteofrance_arome_grib_france',
          grid_scope: 'france',
          france_grid: true,
          arome_shell: true,
          cache: { hit: true, backend: 'client-shell' },
        },
      };
    }

    async function loadAromeFranceData(force = false, centerToken = centerChangeToken) {
      if (typeof rememberAromeFrancePayloadDays === 'function') rememberAromeFrancePayloadDays();
      const dateKey = normalizeDateIso(selectedBaseDate);
      const signature = currentAromeFrancePayloadSignature(dateKey);
      const restoredCacheStatus = typeof restoreMeteoFranceGribCacheStatus === 'function' && restoreMeteoFranceGribCacheStatus(dateKey);
      if (!restoredCacheStatus) meteoFranceGribCachedSlotKeys = new Set();
      if (typeof restoreMeteoFranceGribAvailabilityStatus === 'function') restoreMeteoFranceGribAvailabilityStatus(dateKey);
      debugLog('loadAromeFranceData:start', { force, centerToken, activeCenterToken: centerChangeToken, signature });
      if (!force && payload?.meta?.arome_shell && signature === lastFetchSignature) {
        shouldAnimateNextGrid = false;
        updateMetaLine();
        renderDayButtons();
        renderSlotButtons();
        refreshMap();
        window.setTimeout(() => {
          if (typeof refreshMeteoFranceGribCacheStatus === 'function') refreshMeteoFranceGribCacheStatus({ force: false });
          if (typeof hydrateMeteoFranceGribFranceDayFromCache === 'function') hydrateMeteoFranceGribFranceDayFromCache({ force: false });
          if (typeof maybeLoadCachedMeteoFranceGribForSelectedSlot === 'function') maybeLoadCachedMeteoFranceGribForSelectedSlot({ quiet: true });
        }, 0);
        return payload;
      }

      if (dataFetchController) dataFetchController.abort();
      activeFetchToken += 1;
      isFetchingData = true;
      try {
        if (centerToken !== centerChangeToken) return payload;
        const memoryPayload = typeof buildAromeFrancePayloadFromMemory === 'function' ? buildAromeFrancePayloadFromMemory(dateKey) : null;
        payload = memoryPayload || buildAromeFranceShellPayload(dateKey);
        lastFetchSignature = signature;
        shouldAnimateNextGrid = false;
        lastFetchAt = Date.now();
        selectedDayKey = dateKey;
        selectedSlotKey = preferredAromeSlotKey();
        selectedFeature = null;
        cityInput.value = currentCenter.label;
        saveCurrentCenter();

        updateMetaLine();
        renderDayButtons();
        renderSlotButtons();
        scheduleLoadedGridSync(centerToken, selectedDayKey, selectedSlotKey);
        window.setTimeout(async () => {
          if (centerToken !== centerChangeToken) return;
          if (typeof refreshMeteoFranceGribCacheStatus === 'function') {
            await refreshMeteoFranceGribCacheStatus({ force: true });
          }
          if (typeof materializeMeteoFranceGribFranceDayFromNationalCache === 'function') {
            materializeMeteoFranceGribFranceDayFromNationalCache({ quiet: true });
          }
          if (typeof maybeLoadCachedMeteoFranceGribForSelectedSlot === 'function') {
            const loaded = await maybeLoadCachedMeteoFranceGribForSelectedSlot({ quiet: true, force: true });
            if (!loaded) {
              const modelLabel = (typeof activeNwpModelLabel === 'function') ? activeNwpModelLabel() : 'AROME';
              setMetaMessage(`${modelLabel} France prêt : attente de la grille horaire matérialisée côté serveur.`);
            }
          }
        }, memoryPayload ? 0 : 20);
        return payload;
      } finally {
        isFetchingData = false;
      }
    }

    async function loadData(force = false, centerToken = centerChangeToken) {
      return loadAromeFranceData(force, centerToken);
    }

    function scheduleLoadedGridSync(centerToken, dayKey, slotKey) {
      const stillCurrent = () => centerToken === centerChangeToken && selectedDayKey === dayKey && selectedSlotKey === slotKey;
      const sync = (forceVisible = false) => {
        if (!stillCurrent()) return;
        debugLog('scheduleLoadedGridSync:run', { dayKey, slotKey, forceVisible });
        refreshMap();
        if (forceVisible) {
          const cells = getCurrentSlot()?.cells || [];
          if (cells.length) forceGridVisible(cells);
        }
      };
      requestAnimationFrame(() => sync(false));
      window.setTimeout(() => sync(true), 900);
      if (map?.once) map.once('idle', () => sync(true));
    }

    async function refreshCurrentData(force = true, loadingMessage = 'Actualisation…') {
      if (typeof stopTimelinePlayback === 'function') stopTimelinePlayback({ resetToStart: false });
      setLoadingState(true, loadingMessage);
      try {
        await loadData(force);
      } catch (err) {
        console.warn(err);
        setMetaMessage('Impossible d’actualiser les données AROME.');
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
      const query = cityInput?.value?.trim() || '';
      if (!query) {
        setMetaMessage('Saisissez une ville ou un secteur avant de lancer la recherche.');
        return;
      }
      if (geocodeController) geocodeController.abort();
      geocodeController = new AbortController();
      setLoadingState(true, `Recherche de ${query}…`);
      try {
        const target = await geocodeCity(query, geocodeController.signal);
        stageCenterChange(target, { zoom: 8.4 });
        await new Promise((resolve) => requestAnimationFrame(resolve));
        refreshMap();
        const cells = getCurrentSlot()?.cells || [];
        if (cells.length) forceGridVisible(cells);
        setMetaMessage(`Carte recentrée sur ${target.label}. Grille AROME France conservée.`);
      } catch (error) {
        if (error?.name !== 'AbortError') {
          console.warn(error);
          const message = String(error?.message || '');
          if (/Aucun résultat|Ville vide/i.test(message)) {
            setMetaMessage('Lieu introuvable. Essaie un nom plus complet.');
          } else if (/Geocoding HTTP/i.test(message)) {
            setMetaMessage('Service de recherche temporairement indisponible.');
          } else {
            setMetaMessage('Le lieu a été trouvé, mais la carte n’a pas pu être centrée.');
          }
          if (!hasCompletedInitialLoad) hideAppLoader(true);
        }
      } finally {
        geocodeController = null;
        setLoadingState(false);
      }
    }
