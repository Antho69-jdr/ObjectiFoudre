
    const STYLE = 'https://basemaps.cartocdn.com/gl/dark-matter-gl-style/style.json';
    const CENTER = [4.8357, 45.7640];

    const metaCenter = document.getElementById('metaCenter');
    const metaRun = document.getElementById('metaRun');
    const dayButtons = document.getElementById('dayButtons');
    const slotButtons = document.getElementById('slotButtons');
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
    const closeDrawerBtn = document.getElementById('closeDrawerBtn');
    const locateBtn = document.getElementById('locateBtn');
    const refreshBtn = document.getElementById('refreshBtn');
    const installBtn = document.getElementById('installBtn');
    const installChip = document.getElementById('installChip');

    let deferredInstallPrompt = null;
    let isFetchingData = false;
    let lastFetchSignature = '';
    let lastFetchAt = 0;
    let gridAnimationToken = 0;
    let loaderPulseFrame = null;
    let loaderPulseStart = 0;
    let bestCellsMode = false;
    let dataFetchController = null;
    let centerChangeToken = 0;
    let geocodeController = null;
    let activeFetchToken = 0;
    const LOADER_GRID_SIZE = 7;
    const LOADER_CELL_SIZE_KM = 6.5;
    const GRID_ANIMATION_TOTAL_MS = 300;
    const GRID_ANIMATION_CELL_MS = 220;
    const GRID_ANIMATION_STAGGER_SPAN_MS = 70;
    const VISIBILITY_REFRESH_MS = 10 * 60 * 1000;
    let userLocationMarker = null;
    const DEFAULT_CENTER = { lat: 45.7640, lon: 4.8357, label: 'Lyon' };
    let currentCenter = loadStoredCenter();

    let payload = null;
    let selectedDayKey = null;
    let selectedSlotKey = null;
    let selectedFeature = null;

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

    function toggleTopPanel(panel) {
      if (!isMobileLayout()) return;
      const searchOpen = topbar.classList.contains('show-search');
      const calendarOpen = topbar.classList.contains('show-calendar');
      closeTopPanels();
      if (panel === 'search' && !searchOpen) topbar.classList.add('show-search');
      if (panel === 'calendar' && !calendarOpen) topbar.classList.add('show-calendar');
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
      if (map.getLayer('grid-loader-fill')) {
        map.setPaintProperty('grid-loader-fill', 'fill-opacity', 0.10);
      }
    }

    function startLoaderPulse() {
      stopLoaderPulse();
      if (!map.getLayer('grid-loader-fill')) return;
      loaderPulseStart = performance.now();
      const tick = (now) => {
        if (!map.getLayer('grid-loader-fill')) {
          stopLoaderPulse();
          return;
        }
        const t = (now - loaderPulseStart) / 1000;
        const wave = (Math.sin(t * Math.PI * 1.25) + 1) / 2;
        const fillOpacity = 0.05 + wave * 0.04;
        map.setPaintProperty('grid-loader-fill', 'fill-opacity', fillOpacity);
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
    }

    async function geocodeCity(query, signal) {
      const q = query.trim();
      if (!q) throw new Error('Ville vide');
      const url = `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(q)}&count=1&language=fr&format=json`;
      const response = await fetch(url, { cache: 'no-store', signal });
      if (!response.ok) throw new Error(`Geocoding HTTP ${response.status}`);
      const data = await response.json();
      const first = data?.results?.[0];
      if (!first) throw new Error('Aucun résultat');
      const labelParts = [first.name, first.admin1, first.country].filter(Boolean);
      return { lat: Number(first.latitude), lon: Number(first.longitude), label: labelParts.join(', ') || first.name };
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
      await loadData(options.force === true, localToken);
    }

    function renderDayButtons() {
      const days = getDays();
      dayButtons.innerHTML = '';
      if (!days.length) return;
      if (!selectedDayKey || !days.some(d => d.day_key === selectedDayKey)) selectedDayKey = days[0].day_key;
      for (const day of days) {
        const btn = document.createElement('button');
        btn.textContent = day.day_label;
        btn.className = day.day_key === selectedDayKey ? 'active' : '';
        btn.onclick = () => {
          selectedDayKey = day.day_key;
          const firstSlot = getCurrentDay()?.slots?.[0];
          if (firstSlot) selectedSlotKey = firstSlot.slot_key;
          closeSelection();
          closeDetails();
          renderDayButtons();
          renderSlotButtons();
          refreshMap();
        };
        dayButtons.appendChild(btn);
      }
    }

    function renderSlotButtons() {
      const day = getCurrentDay();
      slotButtons.innerHTML = '';
      const slots = day?.slots || [];
      if (!slots.length) return;
      if (!selectedSlotKey || !slots.some(s => s.slot_key === selectedSlotKey)) selectedSlotKey = slots[0].slot_key;
      for (const slot of slots) {
        const btn = document.createElement('button');
        btn.textContent = slot.slot_label;
        btn.className = slot.slot_key === selectedSlotKey ? 'active' : '';
        btn.onclick = () => {
          selectedSlotKey = slot.slot_key;
          closeSelection();
          closeDetails();
          renderSlotButtons();
          refreshMap();
        };
        slotButtons.appendChild(btn);
      }
    }

    function kmToDegLat(km) {
      return km / 111;
    }

    function kmToDegLon(km, lat) {
      return km / (111 * Math.cos((lat * Math.PI) / 180));
    }

    function buildLoaderCells(center) {
      const cells = [];
      const latStep = kmToDegLat(LOADER_CELL_SIZE_KM);
      const lonStep = kmToDegLon(LOADER_CELL_SIZE_KM, center.lat);
      const half = Math.floor(LOADER_GRID_SIZE / 2);
      let idx = 0;
      for (let row = -half; row <= half; row += 1) {
        for (let col = -half; col <= half; col += 1) {
          cells.push({
            zone: `loader-${idx++}`,
            lat: center.lat + row * latStep,
            lon: center.lon + col * lonStep,
            cell_height_deg: latStep,
            cell_width_deg: lonStep,
            score_global: 18 + ((row + half + col + half) % 5) * 5,
            confidence_score: 42,
            chase_quality_score: 55,
            is_loader: true,
          });
        }
      }
      return cells;
    }

    function buildLoaderGeoJSON(center) {
      return buildGeoJSON(buildLoaderCells(center));
    }

    function computeBestZoneSet(cells) {
      const ranked = [...cells].sort((a, b) => {
        const scoreDiff = Number(b.score_global || 0) - Number(a.score_global || 0);
        if (Math.abs(scoreDiff) > 0.001) return scoreDiff;
        return Number(b.confidence_score || 0) - Number(a.confidence_score || 0);
      });
      if (!ranked.length) return new Set();
      const topCount = Math.max(3, Math.min(10, Math.ceil(ranked.length * 0.12)));
      const strong = ranked.filter(cell => Number(cell.score_global || 0) >= 70 || (Number(cell.score_global || 0) >= 62 && Number(cell.confidence_score || 0) >= 62));
      const picked = strong.length ? strong.slice(0, Math.max(topCount, Math.min(12, strong.length))) : ranked.slice(0, topCount);
      return new Set(picked.map(cell => cell.zone));
    }

    function cellToFeature(cell, bestZones, entering = null) {
      const baseOpacity = opacityFromConfidence(cell.confidence_score);
      const isBest = bestZones.has(cell.zone);
      const fillOpacity = entering
        ? Math.max(0, Math.min(1, entering.opacity))
        : (bestCellsMode && !cell.is_loader
            ? (isBest ? Math.min(0.9, Math.max(baseOpacity, 0.58)) : Math.max(0.06, baseOpacity * 0.22))
            : baseOpacity);
      const latOffset = entering ? entering.latOffset : 0;
      const lonOffset = entering ? entering.lonOffset : 0;
      const lat = Number(cell.lat) + latOffset;
      const lon = Number(cell.lon) + lonOffset;
      const h = Number(cell.cell_height_deg) / 2;
      const w = Number(cell.cell_width_deg) / 2;
      return {
        type: 'Feature',
        geometry: { type: 'Polygon', coordinates: [[[lon - w, lat - h],[lon + w, lat - h],[lon + w, lat + h],[lon - w, lat + h],[lon - w, lat - h]]] },
        properties: { ...cell, is_best: isBest ? 1 : 0, fill_color: colorFromScore(cell.score_global), fill_opacity: fillOpacity },
      };
    }

    function buildGeoJSON(cells, options = {}) {
      const bestZones = computeBestZoneSet(cells);
      const progressByZone = options.progressByZone || null;
      const features = cells.map(cell => {
        if (!progressByZone) return cellToFeature(cell, bestZones);
        const progress = Math.max(0, Math.min(1, progressByZone.get(cell.zone) ?? 1));
        return cellToFeature(cell, bestZones, {
          opacity: opacityFromConfidence(cell.confidence_score) * Math.pow(progress, 0.86),
          latOffset: cell.cell_height_deg * (1 - progress) * 0.82,
          lonOffset: -cell.cell_width_deg * (1 - progress) * 0.34,
        });
      });
      return { type: 'FeatureCollection', features };
    }

    function sortCellsForReveal(cells) {
      return [...cells].sort((a, b) => {
        const keyA = (-Number(a.lat) * 1000) + (Number(a.lon) * 1000);
        const keyB = (-Number(b.lat) * 1000) + (Number(b.lon) * 1000);
        if (Math.abs(keyA - keyB) > 0.001) return keyA - keyB;
        const latDiff = Number(b.lat) - Number(a.lat);
        if (Math.abs(latDiff) > 0.0001) return latDiff;
        return Number(a.lon) - Number(b.lon);
      });
    }

    function animateRevealToSource(sourceId, cells, geojsonBuilder = buildGeoJSON, onStep = null, onComplete = null) {
      const token = ++gridAnimationToken;
      const orderedCells = sortCellsForReveal(cells);
      const source = map.getSource(sourceId);
      if (!source) return;
      const start = performance.now();
      const progressByZone = new Map();
      const staggerSpan = GRID_ANIMATION_STAGGER_SPAN_MS;
      const count = Math.max(1, orderedCells.length - 1);
      const easeOutQuart = (t) => 1 - Math.pow(1 - t, 4);
      const frame = (now) => {
        if (token !== gridAnimationToken) return;
        const elapsed = now - start;
        let finished = 0;
        progressByZone.clear();
        for (let i = 0; i < orderedCells.length; i += 1) {
          const begin = (i / count) * staggerSpan;
          const raw = Math.max(0, Math.min(1, (elapsed - begin) / GRID_ANIMATION_CELL_MS));
          const eased = raw <= 0 ? 0 : easeOutQuart(raw);
          progressByZone.set(orderedCells[i].zone, eased);
          if (raw >= 1) finished += 1;
        }
        source.setData(geojsonBuilder(orderedCells, { progressByZone }));
        if (typeof onStep === 'function') onStep();
        if (finished < orderedCells.length) {
          requestAnimationFrame(frame);
        } else if (typeof onComplete === 'function') {
          onComplete();
        }
      };
      requestAnimationFrame(frame);
    }

    function animateGridReveal(cells) {
      stopLoaderPulse();
      animateRevealToSource('grid', cells, buildGeoJSON, updateHighlight, () => {
        if (map.getLayer('grid-loader-fill')) {
          const currentOpacity = map.getPaintProperty('grid-loader-fill', 'fill-opacity');
          const from = typeof currentOpacity === 'number' ? currentOpacity : 0.06;
          animateLayerPaintNumber('grid-loader-fill', 'fill-opacity', from, 0, 180, removeLoaderLayers);
        } else {
          removeLoaderLayers();
        }
      });
    }

    function ensureSource(id, data) {
      if (map.getSource(id)) map.getSource(id).setData(data);
      else map.addSource(id, { type: 'geojson', data });
    }

    function removeLoaderLayers() {
      gridAnimationToken += 1;
      stopLoaderPulse();
      if (map.getLayer('grid-loader-fill')) map.removeLayer('grid-loader-fill');
      if (map.getSource('grid-loader')) map.removeSource('grid-loader');
    }

    function showLoadingGrid(center) {
      if (!map.isStyleLoaded()) return;
      removeLoaderLayers();
      const cells = buildLoaderCells(center);
      ensureSource('grid-loader', buildGeoJSON(cells));
      map.addLayer({
        id: 'grid-loader-fill',
        type: 'fill',
        source: 'grid-loader',
        paint: {
          'fill-color': '#7dd3fc',
          'fill-opacity': 0,
        }
      });
      animateLayerPaintNumber('grid-loader-fill', 'fill-opacity', 0, 0.09, 220, startLoaderPulse);
    }

    function removeLayers(keepLoader = false) {
      gridAnimationToken += 1;
      removeLoaderLayers();
      if (map.getLayer('grid-highlight')) map.removeLayer('grid-highlight');
      if (map.getLayer('grid-fill')) map.removeLayer('grid-fill');
      if (map.getSource('grid')) map.removeSource('grid');
      map.off('click', 'grid-fill', onGridClick);
      map.off('mouseenter', 'grid-fill', onGridEnter);
      map.off('mouseleave', 'grid-fill', onGridLeave);
    }

    function addLayers(data) {
      ensureSource('grid', data);
      map.addLayer({
        id: 'grid-fill',
        type: 'fill',
        source: 'grid',
        paint: {
          'fill-color': ['get', 'fill_color'],
          'fill-opacity': ['*', ['get', 'fill_opacity'], 0],
        }
      });
      map.addLayer({
        id: 'grid-highlight',
        type: 'line',
        source: 'grid',
        paint: {
          'line-color': '#ffffff',
          'line-width': 2.2,
          'line-opacity': ['case', ['==', ['get', 'zone'], selectedFeature?.zone || ''], 1, 0],
        }
      });

      map.on('click', 'grid-fill', onGridClick);
      map.on('mouseenter', 'grid-fill', onGridEnter);
      map.on('mouseleave', 'grid-fill', onGridLeave);
      animateGridFillFactor(0, 1, 180, updateHighlight);
    }

    function onGridEnter() {
      map.getCanvas().style.cursor = 'pointer';
    }

    function onGridLeave() {
      map.getCanvas().style.cursor = '';
    }

    function onGridClick(e) {
      const p = e.features?.[0]?.properties;
      if (!p) return;
      selectedFeature = p;
      showSelection(p);
      updateHighlight();
    }

    function updateHighlight() {
      if (!map.getLayer('grid-highlight')) return;
      map.setPaintProperty('grid-highlight', 'line-opacity', ['case', ['==', ['get', 'zone'], selectedFeature?.zone || ''], 1, 0]);
    }

    function updateBestCellsButton() {
      if (!bestCellsBtn) return;
      bestCellsBtn.classList.toggle('active', bestCellsMode);
    }

    function applyBestCellsModeToCurrentMap() {
      const slot = getCurrentSlot();
      const cells = slot?.cells || [];
      if (!map.isStyleLoaded() || !map.getSource('grid') || !cells.length) {
        updateBestCellsButton();
        return;
      }
      map.getSource('grid').setData(buildGeoJSON(cells));
      updateHighlight();
      updateBestCellsButton();
    }

    function toggleBestCellsMode() {
      bestCellsMode = !bestCellsMode;
      applyBestCellsModeToCurrentMap();
    }

    function mean(values) {
      if (!values.length) return 0;
      return Math.round(values.reduce((a, b) => a + b, 0) / values.length);
    }

    function refreshStats(cells, slot) {
      return { cells, slot };
    }

    function refreshMap() {
      const slot = getCurrentSlot();
      const cells = slot?.cells || [];
      refreshStats(cells, slot);
      if (!map.isStyleLoaded()) return;
      removeLayers(true);
      if (!cells.length) {
        removeLoaderLayers();
        return;
      }
      stopLoaderPulse();
      addLayers(buildGeoJSON(cells));
      animateGridReveal(cells);
    }

    function safe(value, suffix = '') {
      if (value === undefined || value === null || value === '') return '-';
      return `${value}${suffix}`;
    }

    const METRIC_INFO = {
      score_global: {
        label: 'Score global',
        explain: 'Synthèse du potentiel de la cellule. Il combine le déclenchement, l’organisation et la qualité de chasse. Plus la valeur est haute, plus la zone mérite de l’attention, sans garantir à elle seule un orage.'
      },
      confidence_score: {
        label: 'Confiance',
        explain: 'Indice de robustesse du signal. Il augmente quand plusieurs paramètres vont dans le même sens. Une confiance élevée signifie un signal plus cohérent, pas forcément un risque plus fort.'
      },
      trigger_score: {
        label: 'Déclenchement',
        explain: 'Estime la facilité à lancer de la convection. Il repose surtout sur l’instabilité disponible, l’humidité en basse couche, le VPD, le point de rosée et le bulbe humide.'
      },
      structure_score: {
        label: 'Organisation',
        explain: 'Mesure le potentiel d’organisation des cellules. Il repose principalement sur le cisaillement vertical approximé et la dynamique de surface via les rafales.'
      },
      chase_quality_score: {
        label: 'Qualité chasse',
        explain: 'Cherche à dire si la zone est exploitable sur le terrain. Il prend en compte surtout la nébulosité et l’environnement visuel, pour éviter les secteurs prometteurs mais peu lisibles.'
      },
      mucape: {
        label: 'CAPE',
        explain: 'Convective Available Potential Energy. C’est l’énergie disponible pour les ascendances. Plus elle est élevée, plus l’environnement peut soutenir des développements convectifs intenses si un déclenchement se produit.'
      },
      shear_ms: {
        label: 'Shear',
        explain: 'Cisaillement vertical du vent, ici approché entre 10 m et 100 m. Il aide à l’organisation des cellules et peut favoriser des structures plus durables ou mieux organisées.'
      },
      relative_humidity_2m: {
        label: 'Humidité 2 m',
        explain: 'Humidité relative près du sol. Une basse couche plus humide favorise généralement l’alimentation convective et limite le mélange trop sec.'
      },
      vapour_pressure_deficit: {
        label: 'VPD',
        explain: 'Vapour Pressure Deficit, un indicateur de sécheresse de l’air. Un VPD trop élevé traduit souvent une basse couche plus sèche et moins favorable au déclenchement.'
      },
      wet_bulb_temperature_2m: {
        label: 'Bulbe humide',
        explain: 'Température humide théorique de l’air près du sol. Elle aide à lire le contenu thermo-hygrométrique de la basse couche et le caractère plus ou moins favorable à la convection.'
      },
      dewpoint_c: {
        label: 'Point de rosée',
        explain: 'Température à laquelle l’air deviendrait saturé. Un point de rosée plus élevé signale souvent une meilleure charge en humidité pour alimenter la convection.'
      },
      temp_c: {
        label: 'Température',
        explain: 'Température de surface. Elle agit avec l’humidité et l’insolation sur l’instabilité, mais sa lecture seule ne suffit jamais à conclure.'
      },
      wind_gusts_10m: {
        label: 'Rafales 10 m',
        explain: 'Rafales prévues près du sol. Elles servent ici surtout à qualifier un minimum de dynamique de surface dans l’environnement.'
      },
      cloud_cover_low: {
        label: 'Nuages bas',
        explain: 'Nébulosité basse couche. Trop de nuages bas peut freiner l’insolation et rendre la zone moins agréable ou moins lisible pour la chasse.'
      },
      cloud_cover_mid: {
        label: 'Nuages moyens',
        explain: 'Nébulosité de moyenne couche. Une couverture importante peut signaler une masse d’air moins propre ou un potentiel de chauffage diurne réduit.'
      },
      cloud_cover_high: {
        label: 'Nuages hauts',
        explain: 'Voile d’altitude. Des nuages hauts étendus peuvent limiter le rayonnement solaire et rendre la lecture du ciel moins nette.'
      },
      selected_hour: {
        label: 'Heure retenue',
        explain: 'Heure jugée la plus favorable dans le créneau sélectionné pour cette cellule, selon le score calculé par le script.'
      }
    };

    function toNumber(value) {
      if (value === undefined || value === null || value === '') return null;
      const n = Number(value);
      return Number.isFinite(n) ? n : null;
    }

    function rangeLine(label, text) {
      return `<div><strong>${label} :</strong> ${text}</div>`;
    }

    function operationalGuide(metricKey, rawValue) {
      const value = toNumber(rawValue);
      if (metricKey === 'selected_hour') {
        return {
          state: 'Lecture',
          guide: [
            rangeLine('Usage', 'ce n’est pas un score, mais l’heure jugée la plus favorable dans le créneau affiché.'),
            rangeLine('Terrain', 'à confronter au radar, aux observations visuelles et à l’évolution réelle de la convection.')
          ].join('')
        };
      }
      if (value === null) {
        return { state: 'Valeur indisponible', guide: rangeLine('Lecture', 'aucune interprétation fiable tant que la donnée n’est pas chargée.') };
      }

      switch (metricKey) {
        case 'score_global':
        case 'trigger_score':
        case 'structure_score':
        case 'chase_quality_score': {
          const state = value < 35 ? 'Faible' : value < 65 ? 'Modéré' : value < 85 ? 'Élevé' : 'Très élevé';
          return {
            state,
            guide: [
              rangeLine('Faible', '0–34 : peu prioritaire.'),
              rangeLine('Modéré', '35–64 : à surveiller.'),
              rangeLine('Élevé', '65–84 : zone intéressante.'),
              rangeLine('Très élevé', '85–100 : cible prioritaire si le reste confirme.')
            ].join('')
          };
        }
        case 'confidence_score': {
          const state = value < 35 ? 'Fragile' : value < 65 ? 'Moyenne' : value < 85 ? 'Bonne' : 'Très bonne';
          return {
            state,
            guide: [
              rangeLine('Fragile', '0–34 : signal instable ou peu cohérent.'),
              rangeLine('Moyenne', '35–64 : lecture possible, mais prudence.'),
              rangeLine('Bonne', '65–84 : plusieurs signaux convergent.'),
              rangeLine('Très bonne', '85–100 : signal solide pour la cellule.')
            ].join('')
          };
        }
        case 'mucape': {
          const state = value < 200 ? 'Très faible' : value < 800 ? 'Faible' : value < 1500 ? 'Correcte' : value < 2500 ? 'Forte' : 'Très forte';
          return {
            state,
            guide: [
              rangeLine('Très faible', '< 200 J/kg : peu d’énergie.'),
              rangeLine('Faible', '200–799 J/kg : convection limitée.'),
              rangeLine('Correcte', '800–1499 J/kg : base exploitable.'),
              rangeLine('Forte', '1500–2499 J/kg : bon carburant convectif.'),
              rangeLine('Très forte', '≥ 2500 J/kg : environnement potentiellement explosif si déclenchement.')
            ].join('')
          };
        }
        case 'shear_ms': {
          const state = value < 10 ? 'Faible' : value < 15 ? 'Correct' : value <= 25 ? 'Favorable' : 'Très dynamique';
          return {
            state,
            guide: [
              rangeLine('Faible', '< 10 m/s : organisation limitée.'),
              rangeLine('Correct', '10–14.9 m/s : amélioration possible.'),
              rangeLine('Favorable', '15–25 m/s : bon créneau pour des structures mieux organisées.'),
              rangeLine('Très dynamique', '> 25 m/s : environnement très cisaillé, à interpréter avec le reste.')
            ].join('')
          };
        }
        case 'relative_humidity_2m': {
          const state = value < 50 ? 'Sèche' : value < 65 ? 'Moyenne' : value < 75 ? 'Humide' : 'Très humide';
          return {
            state,
            guide: [
              rangeLine('Sèche', '< 50 % : basse couche souvent défavorable.'),
              rangeLine('Moyenne', '50–64 % : mitigé.'),
              rangeLine('Humide', '65–74 % : plutôt favorable.'),
              rangeLine('Très humide', '≥ 75 % : bonne alimentation en humidité.')
            ].join('')
          };
        }
        case 'vapour_pressure_deficit': {
          const state = value <= 0.8 ? 'Très favorable' : value <= 1.4 ? 'Favorable' : value <= 2.2 ? 'Moyen' : 'Sec';
          return {
            state,
            guide: [
              rangeLine('Très favorable', '≤ 0.8 : basse couche bien humide.'),
              rangeLine('Favorable', '0.81–1.4 : encore bon.'),
              rangeLine('Moyen', '1.41–2.2 : vigilance.'),
              rangeLine('Sec', '> 2.2 : air trop sec pour un bon déclenchement.')
            ].join('')
          };
        }
        case 'wet_bulb_temperature_2m': {
          const state = value < 12 ? 'Basse' : value < 16 ? 'Moyenne' : 'Favorable';
          return {
            state,
            guide: [
              rangeLine('Basse', '< 12 °C : contenu humide limité.'),
              rangeLine('Moyenne', '12–15.9 °C : situation intermédiaire.'),
              rangeLine('Favorable', '≥ 16 °C : basse couche plus propice à la convection.')
            ].join('')
          };
        }
        case 'dewpoint_c': {
          const state = value < 8 ? 'Bas' : value < 12 ? 'Correct' : value < 16 ? 'Humide' : 'Très humide';
          return {
            state,
            guide: [
              rangeLine('Bas', '< 8 °C : humidité limitée.'),
              rangeLine('Correct', '8–11.9 °C : acceptable selon le contexte.'),
              rangeLine('Humide', '12–15.9 °C : alimentation correcte.'),
              rangeLine('Très humide', '≥ 16 °C : bonne réserve d’humidité.')
            ].join('')
          };
        }
        case 'temp_c': {
          const state = value < 18 ? 'Limitée' : value < 24 ? 'Correcte' : value < 30 ? 'Chaude' : 'Très chaude';
          return {
            state,
            guide: [
              rangeLine('Limitée', '< 18 °C : faible chauffage.'),
              rangeLine('Correcte', '18–23.9 °C : contexte exploitable.'),
              rangeLine('Chaude', '24–29.9 °C : bon soutien au chauffage diurne.'),
              rangeLine('Très chaude', '≥ 30 °C : à lire avec l’humidité, car chaleur seule ne suffit pas.')
            ].join('')
          };
        }
        case 'wind_gusts_10m': {
          const state = value < 12 ? 'Faibles' : value < 18 ? 'Présentes' : 'Dynamiques';
          return {
            state,
            guide: [
              rangeLine('Faibles', '< 12 m/s : peu de dynamique de surface.'),
              rangeLine('Présentes', '12–17.9 m/s : contribution utile.'),
              rangeLine('Dynamiques', '≥ 18 m/s : surface plus active.')
            ].join('')
          };
        }
        case 'cloud_cover_low':
        case 'cloud_cover_mid': {
          const state = value <= 55 ? 'Favorables' : value <= 75 ? 'Acceptables' : 'Pénalisants';
          return {
            state,
            guide: [
              rangeLine('Favorables', '0–55 % : chauffage diurne plutôt préservé.'),
              rangeLine('Acceptables', '56–75 % : impact possible.'),
              rangeLine('Pénalisants', '> 75 % : ciel encombré, chasse moins lisible.')
            ].join('')
          };
        }
        case 'cloud_cover_high': {
          const state = value <= 70 ? 'Limités' : value < 90 ? 'Présents' : 'Envahissants';
          return {
            state,
            guide: [
              rangeLine('Limités', '0–70 % : impact réduit.'),
              rangeLine('Présents', '71–89 % : voile notable.'),
              rangeLine('Envahissants', '≥ 90 % : fort écran d’altitude.')
            ].join('')
          };
        }
        default:
          return { state: 'Lecture', guide: rangeLine('Valeur', 'interprétation contextuelle, à croiser avec le reste.') };
      }
    }

    function openMetricInfo(metricKey, currentValue) {
      const meta = METRIC_INFO[metricKey];
      if (!meta) return;
      const op = operationalGuide(metricKey, currentValue);
      infoMetricLabel.textContent = `${meta.label} · ${op.state}`;
      infoMetricValue.textContent = currentValue || '—';
      infoExplanation.innerHTML = `<div>${meta.explain}</div><div style="margin-top:10px;"><strong>Lecture terrain</strong></div><div style="margin-top:6px; display:grid; gap:6px;">${op.guide}</div>`;
      infoBackdrop.classList.add('visible');
      infoModal.classList.add('visible');
    }

    function closeMetricInfo() {
      infoBackdrop.classList.remove('visible');
      infoModal.classList.remove('visible');
    }

    function metricTone(metricKey, rawValue) {
      const value = Number(rawValue);
      if (!Number.isFinite(value)) return 'neutral';
      switch (metricKey) {
        case 'score_global':
        case 'confidence_score':
        case 'trigger_score':
        case 'structure_score':
        case 'chase_quality_score':
          return value >= 60 ? 'positive' : value <= 35 ? 'negative' : 'neutral';
        case 'mucape':
          return value >= 800 ? 'positive' : value < 300 ? 'negative' : 'neutral';
        case 'shear_ms':
          return value >= 14 ? 'positive' : value < 8 ? 'negative' : 'neutral';
        case 'relative_humidity_2m':
          return value >= 65 ? 'positive' : value < 45 ? 'negative' : 'neutral';
        case 'vapour_pressure_deficit':
          return value <= 1.5 ? 'positive' : value > 2.2 ? 'negative' : 'neutral';
        case 'wet_bulb_temperature_2m':
          return value >= 15 ? 'positive' : value < 10 ? 'negative' : 'neutral';
        case 'dewpoint_c':
          return value >= 15 ? 'positive' : value < 10 ? 'negative' : 'neutral';
        case 'temp_c':
          return value >= 20 && value <= 30 ? 'positive' : value < 15 || value > 34 ? 'negative' : 'neutral';
        case 'wind_gusts_10m':
          return value >= 12 ? 'positive' : value < 6 ? 'negative' : 'neutral';
        case 'cloud_cover_low':
        case 'cloud_cover_mid':
          return value <= 55 ? 'positive' : value > 75 ? 'negative' : 'neutral';
        case 'cloud_cover_high':
          return value <= 70 ? 'positive' : value >= 90 ? 'negative' : 'neutral';
        default:
          return 'neutral';
      }
    }

    function applyMetricTone(element, metricKey, rawValue) {
      if (!element) return;
      element.classList.remove('metric-value-positive', 'metric-value-negative', 'metric-value-neutral');
      const tone = metricTone(metricKey, rawValue);
      element.classList.add(`metric-value-${tone}`);
    }

    function showSelection(p) {
      selectionTitle.textContent = p.zone || 'Zone';
      selectionSubtitle.textContent = `${p.day_label || '—'} · ${p.slot_label || '—'} · ${p.selected_hour || '—'}`;
      selectionScore.textContent = safe(p.score_global);
      selectionPotential.textContent = p.potentiel || '—';
      selectionConfidence.textContent = safe(p.confidence_score);
      selectionConfidenceLabel.textContent = p.confiance || '—';
      selectionTrigger.textContent = safe(p.trigger_score);
      selectionStructure.textContent = safe(p.structure_score);
      selectionQuality.textContent = safe(p.chase_quality_score);
      applyMetricTone(selectionScore, 'score_global', p.score_global);
      applyMetricTone(selectionConfidence, 'confidence_score', p.confidence_score);
      applyMetricTone(selectionTrigger, 'trigger_score', p.trigger_score);
      applyMetricTone(selectionStructure, 'structure_score', p.structure_score);
      applyMetricTone(selectionQuality, 'chase_quality_score', p.chase_quality_score);
      selectionSummary.textContent = p.summary || 'Aucun résumé disponible.';
      selectionCard.classList.add('visible');
    }

    function closeSelection() {
      selectionCard.classList.remove('visible');
      selectedFeature = null;
      updateHighlight();
    }

    function openDetails() {
      if (!selectedFeature) return;
      const p = selectedFeature;
      detailsSubtitle.textContent = `${p.zone || 'Zone'} · ${p.day_label || '—'} · ${p.slot_label || '—'}`;
      detailsSummary.textContent = p.summary || 'Aucun résumé disponible.';
      const dCape = document.getElementById('dCape');
      const dShear = document.getElementById('dShear');
      const dRh = document.getElementById('dRh');
      const dVpd = document.getElementById('dVpd');
      const dWetbulb = document.getElementById('dWetbulb');
      const dDewpoint = document.getElementById('dDewpoint');
      const dTemp = document.getElementById('dTemp');
      const dGusts = document.getElementById('dGusts');
      const dCloudLow = document.getElementById('dCloudLow');
      const dCloudMid = document.getElementById('dCloudMid');
      const dCloudHigh = document.getElementById('dCloudHigh');
      const dHour = document.getElementById('dHour');
      dCape.textContent = safe(p.mucape);
      dShear.textContent = safe(p.shear_ms, ' m/s');
      dRh.textContent = safe(p.relative_humidity_2m, ' %');
      dVpd.textContent = safe(p.vapour_pressure_deficit);
      dWetbulb.textContent = safe(p.wet_bulb_temperature_2m, ' °C');
      dDewpoint.textContent = safe(p.dewpoint_c, ' °C');
      dTemp.textContent = safe(p.temp_c, ' °C');
      dGusts.textContent = safe(p.wind_gusts_10m, ' m/s');
      dCloudLow.textContent = safe(p.cloud_cover_low, ' %');
      dCloudMid.textContent = safe(p.cloud_cover_mid, ' %');
      dCloudHigh.textContent = safe(p.cloud_cover_high, ' %');
      dHour.textContent = safe(p.selected_hour);
      applyMetricTone(dCape, 'mucape', p.mucape);
      applyMetricTone(dShear, 'shear_ms', p.shear_ms);
      applyMetricTone(dRh, 'relative_humidity_2m', p.relative_humidity_2m);
      applyMetricTone(dVpd, 'vapour_pressure_deficit', p.vapour_pressure_deficit);
      applyMetricTone(dWetbulb, 'wet_bulb_temperature_2m', p.wet_bulb_temperature_2m);
      applyMetricTone(dDewpoint, 'dewpoint_c', p.dewpoint_c);
      applyMetricTone(dTemp, 'temp_c', p.temp_c);
      applyMetricTone(dGusts, 'wind_gusts_10m', p.wind_gusts_10m);
      applyMetricTone(dCloudLow, 'cloud_cover_low', p.cloud_cover_low);
      applyMetricTone(dCloudMid, 'cloud_cover_mid', p.cloud_cover_mid);
      applyMetricTone(dCloudHigh, 'cloud_cover_high', p.cloud_cover_high);
      applyMetricTone(dHour, 'selected_hour', NaN);
      modalBackdrop.classList.add('visible');
      detailsModal.classList.add('visible');
    }

    function closeDetails() {
      modalBackdrop.classList.remove('visible');
      detailsModal.classList.remove('visible');
    }


    function updateInstallUI() {
      const installable = !!deferredInstallPrompt;
      installBtn.style.display = installable ? 'inline-grid' : 'none';
      installChip.classList.toggle('visible', installable);
    }

    async function installApp() {
      if (!deferredInstallPrompt) return;
      deferredInstallPrompt.prompt();
      try { await deferredInstallPrompt.userChoice; } catch (_) {}
      deferredInstallPrompt = null;
      updateInstallUI();
    }

    function locateUser() {
      if (!navigator.geolocation) {
        setMetaMessage('Géolocalisation non disponible sur cet appareil.');
        return;
      }
      setLoadingState(true, 'Recherche de votre position…');
      navigator.geolocation.getCurrentPosition(
        async ({ coords }) => {
          try {
            await applyCenter({ lat: coords.latitude, lon: coords.longitude, label: 'Autour de moi' }, { showMarker: true, zoom: 8.8 });
          } catch (error) {
            console.warn(error);
            setMetaMessage('Impossible de recalculer la zone autour de vous.');
          } finally {
            setLoadingState(false);
          }
        },
        () => {
          setMetaMessage('Position refusée ou indisponible.');
          setLoadingState(false);
        },
        { enableHighAccuracy: true, timeout: 10000, maximumAge: 60000 }
      );
    }

    function registerPWA() {
      if ('serviceWorker' in navigator) {
        navigator.serviceWorker.register('./sw.js').catch(() => {});
      }
      window.addEventListener('beforeinstallprompt', (event) => {
        event.preventDefault();
        deferredInstallPrompt = event;
        updateInstallUI();
      });
      window.addEventListener('appinstalled', () => {
        deferredInstallPrompt = null;
        updateInstallUI();
      });
      updateInstallUI();
    }

    async function loadData(force = false, centerToken = centerChangeToken) {
      const signature = `${currentCenter.lat}|${currentCenter.lon}|${currentCenter.label}`;
      if (!force && payload && signature === lastFetchSignature) return payload;

      if (dataFetchController) dataFetchController.abort();
      const controller = new AbortController();
      dataFetchController = controller;
      const fetchToken = ++activeFetchToken;
      isFetchingData = true;
      const params = new URLSearchParams({ lat: String(currentCenter.lat), lon: String(currentCenter.lon), label: currentCenter.label });
      if (force) params.set('force', 'true');
      try {
        const response = await fetch(`/api/latest?${params.toString()}`, { cache: 'no-store', signal: controller.signal });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const nextPayload = await response.json();
        if (fetchToken != activeFetchToken || centerToken !== centerChangeToken) return payload;
        payload = nextPayload;
        lastFetchSignature = signature;
        lastFetchAt = Date.now();
        const days = getDays();
        selectedDayKey = days.find(d => d.day_key === selectedDayKey)?.day_key || days[0]?.day_key || null;
        const currentDay = getCurrentDay();
        selectedSlotKey = currentDay?.slots?.find(s => s.slot_key === selectedSlotKey)?.slot_key || currentDay?.slots?.[0]?.slot_key || null;
        cityInput.value = payload?.meta?.center?.label || currentCenter.label;
        currentCenter = sanitizeCenter(payload?.meta?.center || currentCenter);
        saveCurrentCenter();
        updateMetaLine();
        renderDayButtons();
        renderSlotButtons();
        refreshMap();
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
        await applyCenter(target, { zoom: 8.4 });
      } catch (error) {
        if (error.name !== 'AbortError') {
          console.warn(error);
          setMetaMessage('Ville introuvable ou service indisponible.');
        }
      } finally {
        geocodeController = null;
        setLoadingState(false);
      }
    }

    function openInfoDrawer() {
      infoDrawer.classList.add('visible');
      drawerBackdrop.classList.add('visible');
    }

    function closeInfoDrawer() {
      infoDrawer.classList.remove('visible');
      drawerBackdrop.classList.remove('visible');
    }

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
    aroundMeBtn.addEventListener('click', locateUser);
    searchCityBtn.addEventListener('click', handleCitySearch);
    cityInput.addEventListener('keydown', (event) => { if (event.key === 'Enter') handleCitySearch(); });
    installBtn.addEventListener('click', installApp);
    installChip.addEventListener('click', installApp);
    window.addEventListener('resize', () => { if (!isMobileLayout()) closeTopPanels(); });
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

    map.on('load', async () => {
      cityInput.value = currentCenter.label;
      await loadData().catch(err => {
        console.warn(err);
        setMetaMessage('Impossible de charger la zone initiale.');
      });
    });
  