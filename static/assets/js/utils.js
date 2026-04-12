    function getTodayIsoDate() {
      const now = new Date();
      const year = now.getFullYear();
      const month = String(now.getMonth() + 1).padStart(2, '0');
      const day = String(now.getDate()).padStart(2, '0');
      return `${year}-${month}-${day}`;
    }

    function normalizeDateIso(value) {
      if (typeof value !== 'string') return getTodayIsoDate();
      return /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : getTodayIsoDate();
    }

    function syncDateControls() {
      const nextDate = normalizeDateIso(selectedBaseDate);
      selectedBaseDate = nextDate;
      if (dateInput) dateInput.value = nextDate;
    }

    function applySelectedDate(nextDate, { force = true, loadingMessage = 'Chargement de la date…' } = {}) {
      const normalized = normalizeDateIso(nextDate);
      if (normalized === selectedBaseDate && !force) return;
      selectedBaseDate = normalized;
      syncDateControls();
      selectedDayKey = null;
      selectedSlotKey = null;
      closeSelection();
      closeDetails();
      refreshCurrentData(force, loadingMessage);
    }

    function colorFromScore(score) {
      const s = Math.max(0, Math.min(100, Number(score) || 0));
      const stops = [
        { at: 0, c: [37, 99, 235] },
        { at: 35, c: [34, 197, 94] },
        { at: 65, c: [245, 158, 11] },
        { at: 85, c: [239, 68, 68] },
      ];
      let a = stops[0], b = stops[1];
      if (s >= 65) { a = stops[2]; b = stops[3]; }
      else if (s >= 35) { a = stops[1]; b = stops[2]; }
      const t = (s - a.at) / Math.max(1, (b.at - a.at));
      const r = Math.round(a.c[0] + (b.c[0] - a.c[0]) * t);
      const g = Math.round(a.c[1] + (b.c[1] - a.c[1]) * t);
      const b2 = Math.round(a.c[2] + (b.c[2] - a.c[2]) * t);
      return `rgb(${r}, ${g}, ${b2})`;
    }

    function getCellMetricValue(cell, metric = selectedColorMetric) {
      if (!cell) return 0;
      return Number(cell?.[metric] ?? cell?.score_global ?? 0) || 0;
    }

    function getCellFillColor(cell) {
      return colorFromScore(getCellMetricValue(cell));
    }

    function syncLayerModeUI() {
      document.querySelectorAll('.layer-option').forEach((btn) => {
        btn.classList.toggle('active', btn.dataset.layerMetric === selectedColorMetric);
      });
      if (layerModeBtn) layerModeBtn.classList.toggle('active', selectedColorMetric !== 'score_global');
    }

    function opacityFromConfidence(confidence) {
      const c = Math.max(0, Math.min(100, Number(confidence) || 0));
      return 0.12 + (c / 100) * 0.48;
    }

    function getDays() {
      return (payload?.days || []).slice().sort((a, b) => a.day_index - b.day_index);
    }

    function getCurrentDay() {
      return getDays().find(d => d.day_key === selectedDayKey) || null;
    }

    function getCurrentSlot() {
      return getCurrentDay()?.slots?.find(s => s.slot_key === selectedSlotKey) || null;
    }

    function sanitizeCenter(center) {
      const lat = Number(center?.lat);
      const lon = Number(center?.lon);
      const label = String(center?.label || '').trim();
      if (!Number.isFinite(lat) || !Number.isFinite(lon) || !label) return { ...DEFAULT_CENTER };
      return { lat, lon, label };
    }

    function loadStoredCenter() {
      try {
        const raw = localStorage.getItem('storm_center');
        if (!raw) return { ...DEFAULT_CENTER };
        return sanitizeCenter(JSON.parse(raw));
      } catch (_) {
        return { ...DEFAULT_CENTER };
      }
    }

    function saveCurrentCenter() {
      try {
        localStorage.setItem('storm_center', JSON.stringify(currentCenter));
      } catch (_) {}
    }

    function formatFrenchRun(dateString) {
      if (!dateString) return '—';
      const parsed = new Date(dateString);
      if (Number.isNaN(parsed.getTime())) return String(dateString);
      const formatted = new Intl.DateTimeFormat('fr-FR', {
        timeZone: 'Europe/Paris', year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit', hour12: false
      }).format(parsed).replace(',', '');
      const tzPart = new Intl.DateTimeFormat('fr-FR', {
        timeZone: 'Europe/Paris', timeZoneName: 'shortOffset', hour: '2-digit'
      }).formatToParts(parsed).find(part => part.type === 'timeZoneName')?.value || 'GMT+2';
      return `${formatted} ${tzPart}`;
    }

    function updateMetaLine() {
      const centerLabel = payload?.meta?.center?.label || currentCenter.label || 'Zone';
      const generated = formatFrenchRun(payload?.meta?.generated_at || '');
      const model = payload?.meta?.model || 'arome_france';
      metaCenter.textContent = `Zone : ${centerLabel}`;
      metaRun.textContent = `Modèle arome-france : ${generated}`;
    }

    function setMetaMessage(message) {
      metaCenter.textContent = message;
    }

    function setLoadingState(isLoading, message) {
      searchCityBtn.disabled = isLoading;
      aroundMeBtn.disabled = isLoading;
      locateBtn.disabled = isLoading;
      refreshBtn.disabled = isLoading;
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

    function fadeOutCurrentGridForReload() {
      if (!map.isStyleLoaded()) return;
      if (map.getLayer('grid-fill')) {
        setGridFillFactor(1);
        animateGridFillFactor(1, 0, 180);
      }
      if (map.getLayer('grid-highlight')) {
        animateLayerPaintNumber('grid-highlight', 'line-opacity', 1, 0, 160);
      }
      if (map.getLayer('grid-borders')) {
        const currentOpacity = showGridLines ? 0.5 : 0;
        animateLayerPaintNumber('grid-borders', 'line-opacity', currentOpacity, 0, 160);
      }
    }

    async function geocodeCity(query, signal) {
      const q = query.trim();
      if (!q) throw new Error('Ville vide');
      const variants = Array.from(new Set([
        q,
        q.normalize('NFD').replace(/[̀-ͯ]/g, ''),
        q.replace(/[-_]+/g, ' ')
      ].map(v => v.trim()).filter(Boolean)));
      const attempts = [];
      for (const variant of variants) {
        attempts.push(`https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(variant)}&count=8&language=fr&countryCode=FR&format=json`);
        attempts.push(`https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(variant)}&count=8&language=fr&format=json`);
      }
      let lastErr = null;
      for (const url of attempts) {
        try {
          const response = await fetch(url, { cache: 'no-store', signal });
          if (!response.ok) throw new Error(`Geocoding HTTP ${response.status}`);
          const data = await response.json();
          const results = Array.isArray(data?.results) ? data.results : [];
          if (!results.length) continue;
          const exact = results.find(r => String(r.name || '').toLowerCase() === q.toLowerCase());
          const first = exact || results[0];
          const labelParts = [first.name, first.admin1, first.country].filter(Boolean);
          return { lat: Number(first.latitude), lon: Number(first.longitude), label: labelParts.join(', ') || first.name };
        } catch (err) {
          if (err?.name === 'AbortError') throw err;
          lastErr = err;
        }
      }
      throw lastErr || new Error('Aucun résultat');
    }

    async function applyCenter(center, options = {}) {
      const localToken = ++centerChangeToken;
      currentCenter = sanitizeCenter(center);
      saveCurrentCenter();
      cityInput.value = currentCenter.label;
      selectedFeature = null;
      closeSelection();
      closeDetails();
      fadeOutCurrentGridForReload();
      animateCameraToCenter(currentCenter, Number.isFinite(options.zoom) ? options.zoom : null);
      showLoadingGrid(currentCenter);
      if (options.showMarker) showCurrentMarker(currentCenter.lon, currentCenter.lat);
      closeTopPanels();
      try {
        await loadData(options.force === true, localToken);
      } catch (err) {
        removeLoaderLayers();
        if (!hasCompletedInitialLoad) hideAppLoader(true);
        throw err;
      }
    }
