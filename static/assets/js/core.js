    const STYLE = 'https://basemaps.cartocdn.com/gl/dark-matter-gl-style/style.json';
    const CENTER = [4.8357, 45.7640];

    const metaCenter = document.getElementById('metaCenter');
    const metaRun = document.getElementById('metaRun');
    const dayButtons = document.getElementById('dayButtons');
    const slotButtons = document.getElementById('slotButtons');
    const slotSelect = document.getElementById('slotSelect');
    const dateInput = document.getElementById('dateInput');
    const todayBtn = document.getElementById('todayBtn');
    const topbar = document.getElementById('topbar');
    const toggleCalendarBtn = document.getElementById('toggleCalendarBtn');
    const toggleSearchBtn = document.getElementById('toggleSearchBtn');
    const cityInput = document.getElementById('cityInput');
    const searchCityBtn = document.getElementById('searchCityBtn');
    const aroundMeBtn = document.getElementById('aroundMeBtn');

    const selectionCard = document.getElementById('selectionCard');
    const selectionTitle = document.getElementById('selectionTitle');
    const selectionSubtitle = document.getElementById('selectionSubtitle');
    const selectionScore = document.getElementById('selectionScore');
    const selectionPotential = document.getElementById('selectionPotential');
    const selectionConfidence = document.getElementById('selectionConfidence');
    const selectionConfidenceLabel = document.getElementById('selectionConfidenceLabel');
    const selectionTrigger = document.getElementById('selectionTrigger');
    const selectionStructure = document.getElementById('selectionStructure');
    const selectionQuality = document.getElementById('selectionQuality');
    const selectionStability = document.getElementById('selectionStability');
    const selectionStabilityLabel = document.getElementById('selectionStabilityLabel');
    const selectionSummary = document.getElementById('selectionSummary');
    const closeSelectionBtn = document.getElementById('closeSelectionBtn');
    const openDetailsBtn = document.getElementById('openDetailsBtn');
    const recenterBtn = document.getElementById('recenterBtn');
    const bestCellsBtn = document.getElementById('bestCellsBtn');

    const modalBackdrop = document.getElementById('modalBackdrop');
    const detailsModal = document.getElementById('detailsModal');
    const detailsSubtitle = document.getElementById('detailsSubtitle');
    const detailsSummary = document.getElementById('detailsSummary');
    const closeDetailsBtn = document.getElementById('closeDetailsBtn');
    const infoBackdrop = document.getElementById('infoBackdrop');
    const infoModal = document.getElementById('infoModal');
    const infoMetricLabel = document.getElementById('infoMetricLabel');
    const infoMetricValue = document.getElementById('infoMetricValue');
    const infoExplanation = document.getElementById('infoExplanation');
    const closeInfoBtn = document.getElementById('closeInfoBtn');
    const infoDrawer = document.getElementById('infoDrawer');
    const drawerBackdrop = document.getElementById('drawerBackdrop');
    const infoDrawerBtn = document.getElementById('infoDrawerBtn');
    const gridLinesBtn = document.getElementById('gridLinesBtn');
    const closeDrawerBtn = document.getElementById('closeDrawerBtn');
    const locateBtn = document.getElementById('locateBtn');
    const refreshBtn = document.getElementById('refreshBtn');
    const installBtn = document.getElementById('installBtn');
    const installChip = document.getElementById('installChip');
    const appLoader = document.getElementById('appLoader');

    let deferredInstallPrompt = null;
    let isFetchingData = false;
    let lastFetchSignature = '';
    let lastFetchAt = 0;
    let gridAnimationToken = 0;
    let loaderPulseFrame = null;
    let loaderPulseStart = 0;
    let gridRevealFailsafeTimer = null;
    let bestCellsMode = false;
    let showGridLines = true;
    let dataFetchController = null;
    let centerChangeToken = 0;
    let geocodeController = null;
    let activeFetchToken = 0;
    const LOADER_GRID_SIZE = 9;
    const LOADER_CELL_SIZE_KM = 5.0;
    const GRID_ANIMATION_TOTAL_MS = 520;
    const GRID_ANIMATION_CELL_MS = 340;
    const GRID_ANIMATION_STAGGER_SPAN_MS = 170;
    const VISIBILITY_REFRESH_MS = 10 * 60 * 1000;
    const APP_LOADER_MIN_MS = 0;
    let userLocationMarker = null;
    let shouldAnimateNextGrid = true;
    let hasCompletedInitialLoad = false;
    const DEFAULT_CENTER = { lat: 45.7640, lon: 4.8357, label: 'Lyon' };
    let currentCenter = loadStoredCenter();
    const appLoaderStartedAt = performance.now();

    let payload = null;
    let selectedDayKey = null;
    let selectedSlotKey = null;
    let selectedFeature = null;
    let selectedBaseDate = getTodayIsoDate();
    let selectedColorMetric = 'score_global';

    syncDateControls();

    const map = new maplibregl.Map({
      container: 'map',
      style: STYLE,
      center: [currentCenter.lon, currentCenter.lat],
      zoom: 9.4,
      maxZoom: 12.5,
    });
    map.addControl(new maplibregl.NavigationControl(), 'top-right');
    applyResponsiveMode();
    window.addEventListener('resize', applyResponsiveMode);
    window.addEventListener('orientationchange', applyResponsiveMode);

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

    function isMobileLayout() {
      return document.body.classList.contains('mobile-ui');
    }

    function applyResponsiveMode() {
      document.body.classList.add('mobile-ui');
    }

    function closeTopPanels() {
      topbar.classList.remove('show-search', 'show-calendar');
    }

    function hideAppLoader(force = false) {
      if (!appLoader || appLoader.classList.contains('hidden')) return;
      if (appLoaderFailsafe) { clearTimeout(appLoaderFailsafe); appLoaderFailsafe = null; }
      const remaining = force ? 0 : Math.max(0, APP_LOADER_MIN_MS - (performance.now() - appLoaderStartedAt));
      window.setTimeout(() => appLoader.classList.add('hidden'), remaining);
    }

    function positionPanelToButton(panel, button) {
      if (!panel || !button || (!topbar.classList.contains('show-search') && !topbar.classList.contains('show-calendar'))) return;
      panel.style.top = '0px';
      const buttonCenter = button.offsetTop + (button.offsetHeight / 2);
      const panelHeight = panel.offsetHeight || 0;
      const railHeight = topbar.offsetHeight || window.innerHeight;
      const rawTop = buttonCenter - (panelHeight / 2);
      const clampedTop = Math.max(0, Math.min(rawTop, Math.max(0, railHeight - panelHeight)));
      panel.style.top = `${Math.round(clampedTop)}px`;
    }

    function alignTopPanels() {
      if (topbar.classList.contains('show-search')) positionPanelToButton(document.querySelector('.search-panel'), toggleSearchBtn);
      if (topbar.classList.contains('show-calendar')) positionPanelToButton(document.querySelector('.calendar-panel'), toggleCalendarBtn);
    }

    function toggleTopPanel(panel) {
      if (!isMobileLayout()) return;
      const searchOpen = topbar.classList.contains('show-search');
      const calendarOpen = topbar.classList.contains('show-calendar');
      closeTopPanels();
      if (panel === 'search' && !searchOpen) topbar.classList.add('show-search');
      if (panel === 'calendar' && !calendarOpen) topbar.classList.add('show-calendar');
      requestAnimationFrame(alignTopPanels);
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

    function stopLoaderPulse() {
      if (loaderPulseFrame !== null) {
        cancelAnimationFrame(loaderPulseFrame);
        loaderPulseFrame = null;
      }
      loaderPulseStart = 0;
      if (map.getSource('grid-loader')) {
        map.getSource('grid-loader').setData(buildLoaderGeoJSON(buildLoaderCells(currentCenter), 0));
      }
    }

    function clearGridRevealFailsafe() {
      if (gridRevealFailsafeTimer !== null) {
        clearTimeout(gridRevealFailsafeTimer);
        gridRevealFailsafeTimer = null;
      }
    }

    function forceGridVisible(cells = getCurrentSlot()?.cells || []) {
      clearGridRevealFailsafe();
      if (!map.isStyleLoaded()) return;
      if (Array.isArray(cells) && cells.length && map.getSource('grid')) {
        map.getSource('grid').setData(buildGeoJSON(cells));
        setGridFillFactor(1);
        applyGridLinesVisibility();
        updateHighlight();
      }
      removeLoaderLayers();
      if (!hasCompletedInitialLoad) {
        hasCompletedInitialLoad = true;
        hideAppLoader();
      }
    }

    function scheduleGridRevealFailsafe(cells) {
      clearGridRevealFailsafe();
      const waitMs = Math.max(980, Math.round(GRID_ANIMATION_CELL_MS * 1.7 + GRID_ANIMATION_STAGGER_SPAN_MS * 1.55));
      gridRevealFailsafeTimer = window.setTimeout(() => {
        const liveCells = getCurrentSlot()?.cells || [];
        const nextCells = liveCells.length ? liveCells : cells;
        forceGridVisible(nextCells);
      }, waitMs);
    }

    function startLoaderPulse() {
      stopLoaderPulse();
      if (!map.getSource('grid-loader')) return;
      const loaderCells = buildLoaderCells(currentCenter);
      loaderPulseStart = performance.now();
      const tick = (now) => {
        if (!map.getSource('grid-loader')) {
          stopLoaderPulse();
          return;
        }
        const elapsedMs = now - loaderPulseStart;
        map.getSource('grid-loader').setData(buildLoaderGeoJSON(loaderCells, elapsedMs));
        loaderPulseFrame = requestAnimationFrame(tick);
      };
      loaderPulseFrame = requestAnimationFrame(tick);
    }

    function animateLayerPaintNumber(layerId, property, from, to, duration, done = null) {
      if (!map.getLayer(layerId)) {
        if (typeof done === 'function') done();
        return;
      }
      const start = performance.now();
      const tick = (now) => {
        if (!map.getLayer(layerId)) return;
        const t = Math.min(1, (now - start) / duration);
        const eased = t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
        map.setPaintProperty(layerId, property, from + (to - from) * eased);
        if (t < 1) requestAnimationFrame(tick);
        else if (typeof done === 'function') done();
      };
      requestAnimationFrame(tick);
    }

    function setGridFillFactor(factor) {
      if (!map.getLayer('grid-fill')) return;
      map.setPaintProperty('grid-fill', 'fill-opacity', ['*', ['get', 'fill_opacity'], factor]);
    }

    function animateGridFillFactor(from, to, duration, done = null) {
      const start = performance.now();
      const tick = (now) => {
        if (!map.getLayer('grid-fill')) return;
        const t = Math.min(1, (now - start) / duration);
        const eased = t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
        setGridFillFactor(from + (to - from) * eased);
        if (t < 1) requestAnimationFrame(tick);
        else if (typeof done === 'function') done();
      };
      requestAnimationFrame(tick);
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
