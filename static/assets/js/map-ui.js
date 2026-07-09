

    function formatCacheIndicator(cacheMeta) {
      if (!cacheMeta || typeof cacheMeta !== 'object') return 'Source : données fraîches';
      const isHit = cacheMeta.hit === true;
      const ageSeconds = Number(cacheMeta.age_seconds);
      if (isHit && Number.isFinite(ageSeconds)) {
        if (ageSeconds < 60) return 'Source : cache < 1 min';
        const ageMinutes = Math.max(1, Math.round(ageSeconds / 60));
        return `Source : cache ${ageMinutes} min`;
      }
      return 'Source : données fraîches';
    }

    function sourceProviderUi(provider) {
      if (provider === 'meteofrance_arome_grib') {
        return {
          badge: 'Source : AROME GRIB',
          lineLabel: 'Créneau actif : Météo-France AROME GRIB',
          title: 'Source du créneau actif : Météo-France AROME GRIB cache',
          className: 'source-grib',
        };
      }
      if (provider === 'meteofrance_arome_wcs') {
        return {
          badge: 'Source : AROME GRIB',
          lineLabel: 'Créneau actif : Météo-France AROME GRIB',
          title: 'Source du créneau actif : Météo-France AROME GRIB France',
          className: 'source-grib',
        };
      }
      if (
        provider === 'meteofrance_arome_mixed'
      ) {
        return {
          badge: 'Source : AROME GRIB',
          lineLabel: 'Créneau actif : Météo-France AROME GRIB',
          title: 'Source du créneau actif : Météo-France AROME GRIB France',
          className: 'source-grib',
        };
      }
      return {
        badge: 'Source : AROME',
        lineLabel: 'Créneau actif : Météo-France AROME',
        title: 'Source du créneau actif : Météo-France AROME France',
        className: 'source-grib',
      };
    }


    function formatCurrentClockTime(date = new Date()) {
      const h = String(date.getHours()).padStart(2, '0');
      const m = String(date.getMinutes()).padStart(2, '0');
      const s = String(date.getSeconds()).padStart(2, '0');
      return `${h}:${m}:${s}`;
    }

    let currentTimeBadgeTimer = null;

    function updateCurrentTimeBadge() {
      if (typeof gridSourceBadge === 'undefined' || !gridSourceBadge) return;
      gridSourceBadge.hidden = false;
      gridSourceBadge.className = 'grid-source-badge current-time-badge';
      gridSourceBadge.textContent = formatCurrentClockTime();
      // Pas de title/tooltip « Heure actuelle » : le contenu du badge EST l'info.
      gridSourceBadge.removeAttribute('data-tooltip');
    }

    function startCurrentTimeBadge() {
      updateCurrentTimeBadge();
      if (currentTimeBadgeTimer !== null) return;
      currentTimeBadgeTimer = window.setInterval(updateCurrentTimeBadge, 1000);
    }

    // Au-delà de J+2 la grille vient d'ARPEGE : badge basé sur le meta serveur
    // (payload.meta.nwp_model_label) avec repli sur la même règle de date que le
    // serveur (date sélectionnée > J+2 → ARPEGE), pour les caches d'avant le tag.
    function activeNwpModelLabel() {
      const fromMeta = String(payload?.meta?.nwp_model_label || '').toUpperCase();
      if (fromMeta) return fromMeta;
      try {
        const maxAromeDate = addDaysIso(getTodayIsoDate(), 2);
        if (normalizeDateIso(selectedBaseDate) > maxAromeDate) return 'ARPEGE';
      } catch (_) {}
      return 'AROME';
    }

    function applyNwpModelLabel(ui) {
      const modelLabel = activeNwpModelLabel();
      if (!modelLabel || modelLabel === 'AROME') return ui;
      return {
        ...ui,
        badge: ui.badge.replace('AROME', modelLabel),
        lineLabel: ui.lineLabel.replace('AROME', modelLabel),
        title: ui.title.replace('AROME', modelLabel),
      };
    }

    function currentSlotSourceInfo() {
      const slot = typeof getCurrentSlot === 'function' ? getCurrentSlot() : null;
      const cells = Array.isArray(slot?.cells) ? slot.cells : [];
      if (cells.length) {
        const providers = Array.from(new Set(cells.map((cell) => cell?.source_provider).filter(Boolean)));
        if (providers.length === 1) return applyNwpModelLabel(sourceProviderUi(providers[0]));
        return applyNwpModelLabel(sourceProviderUi('meteofrance_arome_grib'));
      }
      const provider = payload?.meta?.provider || payload?.meta?.source_provider || 'meteofrance_arome_grib';
      return applyNwpModelLabel(sourceProviderUi(provider));
    }

    function updateGridSourceBadge() {
      updateCurrentTimeBadge();
    }

    function updateMetaRunOverflow() {
      if (!metaRun) return;
      const content = metaRun.querySelector('.meta-run-content');
      if (!content) return;
      const travel = Math.max(0, content.scrollWidth - metaRun.clientWidth);
      metaRun.classList.toggle('meta-run-overflow', travel > 8);
      metaRun.style.setProperty('--meta-run-travel', travel > 8 ? `-${travel}px` : '0px');
      metaRun.style.setProperty('--meta-run-duration', `${Math.max(7, Math.min(22, travel / 22))}s`);
    }

    function setMetaRunText(message) {
      if (!metaRun) return;
      const text = String(message ?? '');
      metaRun.dataset.fullText = text;
      metaRun.title = text;
      metaRun.textContent = '';
      const content = document.createElement('span');
      content.className = 'meta-run-content';
      content.textContent = text;
      metaRun.appendChild(content);
      metaRun.scrollLeft = 0;
      requestAnimationFrame(updateMetaRunOverflow);
    }

    function setupMetaRunScroller() {
      if (!metaRun || metaRun.dataset.scrollerReady === '1') return;
      metaRun.dataset.scrollerReady = '1';
      metaRun.addEventListener('wheel', (event) => {
        if (!metaRun.classList.contains('meta-run-overflow')) return;
        const delta = Math.abs(event.deltaX) > Math.abs(event.deltaY) ? event.deltaX : event.deltaY;
        if (!delta) return;
        metaRun.scrollLeft += delta;
        event.preventDefault();
      }, { passive: false });
      window.addEventListener('resize', () => requestAnimationFrame(updateMetaRunOverflow));
    }

    function collectAromeApiReferenceTimes(meta = payload?.meta || {}) {
      const refs = new Set();
      const addRef = (value) => {
        const ref = String(value || '').trim();
        if (!ref) return;
        const parsed = new Date(ref);
        if (!Number.isFinite(parsed.getTime())) return;
        refs.add(parsed.toISOString());
      };
      const collectFromTargets = (targets) => {
        if (!targets || typeof targets !== 'object') return;
        Object.values(targets).forEach((target) => addRef(target?.reference_time));
      };
      [
        meta?.arome_run_latest_reference_time,
        meta?.arome_run_api_updated_at,
        meta?.meteofrance_grib?.arome_run_latest_reference_time,
        meta?.meteofrance_grib?.arome_run_api_updated_at,
      ].forEach(addRef);
      (Array.isArray(meta?.arome_run_reference_times) ? meta.arome_run_reference_times : []).forEach(addRef);
      (Array.isArray(meta?.meteofrance_grib?.arome_run_reference_times) ? meta.meteofrance_grib.arome_run_reference_times : []).forEach(addRef);
      collectFromTargets(meta?.time_targets);
      collectFromTargets(meta?.meteofrance_grib?.time_targets);
      return Array.from(refs).sort((a, b) => new Date(a).getTime() - new Date(b).getTime());
    }

    function formatAromeRunZulu(referenceIso) {
      const date = new Date(referenceIso);
      if (!Number.isFinite(date.getTime())) return '';
      const h = String(date.getUTCHours()).padStart(2, '0');
      const m = date.getUTCMinutes();
      if (m) return `${h}:${String(m).padStart(2, '0')}Z`;
      return `${h}Z`;
    }

    function formatAromeApiLocalTime(referenceIso) {
      const date = new Date(referenceIso);
      if (!Number.isFinite(date.getTime())) return '';
      try {
        return new Intl.DateTimeFormat('fr-FR', {
          timeZone: 'Europe/Paris',
          hour: '2-digit',
          minute: '2-digit',
          hour12: false,
        }).format(date);
      } catch (_) {
        return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
      }
    }

    function formatAromeApiRunInfo(meta = payload?.meta || {}) {
      const refs = collectAromeApiReferenceTimes(meta);
      if (!refs.length) return '';
      const modelLabel = String(meta?.nwp_model_label || '').toUpperCase() || activeNwpModelLabel();
      const latest = refs[refs.length - 1];
      const runLabels = Array.from(new Set(refs.map(formatAromeRunZulu).filter(Boolean)));
      const runText = runLabels.length > 1
        ? `Runs ${modelLabel} ${runLabels.join('/')}`
        : `Run ${modelLabel} ${runLabels[0] || formatAromeRunZulu(latest)}`;
      const updateTime = formatAromeApiLocalTime(latest);
      return `${runText} · MAJ API ${updateTime}`;
    }

    function updateMetaLine() {
      const runInfo = formatAromeApiRunInfo(payload?.meta || {});
      const sourceIndicator = formatCacheIndicator(payload?.meta?.cache);
      const slotSource = currentSlotSourceInfo();
      const wcsSlots = 0;
      const gribSlots = Array.isArray(payload?.meta?.meteofrance_grib?.slots) ? payload.meta.meteofrance_grib.slots.length : 0;
      const wcsText = '';
      const gribText = gribSlots ? ' · ' + gribSlots + ' créneau' + (gribSlots > 1 ? 'x' : '') + ' GRIB' : '';
      const runText = runInfo || `run ${activeNwpModelLabel()} API en attente`;
      if (metaRun) setMetaRunText(slotSource.lineLabel + ' : ' + runText + ' · ' + sourceIndicator + gribText + wcsText);
      updateGridSourceBadge();
    }

    function setMetaMessage(message) {
      if (metaCenter) {
        metaCenter.textContent = message;
        return;
      }
      setMetaRunText(message);
    }

    function setLoadingState(isLoading, message) {
      if (typeof searchCityBtn !== 'undefined' && searchCityBtn) searchCityBtn.disabled = isLoading;
      if (typeof aroundMeBtn !== 'undefined' && aroundMeBtn) aroundMeBtn.disabled = isLoading;
      if (typeof locateBtn !== 'undefined' && locateBtn) locateBtn.disabled = isLoading;
      if (message) setMetaMessage(message);
    }

    function showCurrentMarker(lon, lat) {
      const lngLat = [lon, lat];
      if (!userLocationMarker) {
        const el = document.createElement('div');
        el.style.width = '16px';
        el.style.height = '16px';
        el.style.borderRadius = '999px';
        el.style.background = '#60a5fa';
        el.style.border = '3px solid white';
        el.style.boxShadow = '0 0 0 6px rgba(96,165,250,0.18)';
        userLocationMarker = new maplibregl.Marker({ element: el }).setLngLat(lngLat).addTo(map);
      } else {
        userLocationMarker.setLngLat(lngLat);
      }
    }

    function haversineKm(a, b) {
      const toRad = (deg) => (deg * Math.PI) / 180;
      const R = 6371;
      const dLat = toRad(b.lat - a.lat);
      const dLon = toRad(b.lon - a.lon);
      const lat1 = toRad(a.lat);
      const lat2 = toRad(b.lat);
      const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
      return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
    }

    function targetZoomForDistance(distanceKm) {
      if (distanceKm > 900) return 5.8;
      if (distanceKm > 600) return 6.2;
      if (distanceKm > 350) return 6.7;
      if (distanceKm > 180) return 7.1;
      if (distanceKm > 90) return 7.5;
      if (distanceKm > 40) return 7.9;
      return 8.3;
    }

    function minZoomForDistance(distanceKm, targetZoom) {
      const drop = distanceKm > 700 ? 0.75 : distanceKm > 300 ? 0.62 : distanceKm > 120 ? 0.5 : distanceKm > 50 ? 0.36 : 0.24;
      return Math.max(5.8, targetZoom - drop);
    }

    function durationForDistance(distanceKm) {
      if (isCoarsePointerDevice()) return Math.max(1200, Math.min(2600, 1400 + distanceKm * 1.8));
      return Math.max(2800, Math.min(6100, (3800 + distanceKm * 5.2) / 1.44));
    }

    function animateCameraToCenter(center, zoomOverride = null) {
      const current = map.getCenter();
      const from = { lat: current.lat, lon: current.lng };
      const to = { lat: center.lat, lon: center.lon };
      const distanceKm = haversineKm(from, to);
      const targetZoom = Number.isFinite(zoomOverride) ? zoomOverride : targetZoomForDistance(distanceKm);
      map.flyTo({
        center: [center.lon, center.lat],
        zoom: targetZoom,
        minZoom: minZoomForDistance(distanceKm, targetZoom),
        speed: 0.38,
        curve: 1.14,
        essential: true,
        duration: durationForDistance(distanceKm)
      });
    }
