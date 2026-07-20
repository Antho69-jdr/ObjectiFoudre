/* stargaze.js — Mode « Chasse d'étoile » (IIFE, pattern chase.js).
   Overlay superposé à la carte de base : bouton rail droit → body.stargaze-mode.
   Peint le champ de qualité d'observation (obscurité × ciel dégagé AROME × Lune)
   HEURE PAR HEURE sur la nuit (frise) + top spots + « autour de moi » + badge astro.
   Source : /api/stargaze/tonight. Identité AMBRE/OR (jamais de bleu — vision nocturne). */
(function () {
  'use strict';
  const toggleBtn = document.getElementById('stargazePageBtn');
  const controls = document.getElementById('stargazeControls');
  if (!toggleBtn || !controls) return;

  const topInfo = document.getElementById('stargazeTopInfo');
  const moonIconEl = document.getElementById('sgMoonIcon');
  const moonEl = document.getElementById('sgMoon');
  const nightEl = document.getElementById('sgNight');
  const hourEl = document.getElementById('sgHour');
  const slotsEl = document.getElementById('stargazeSlots');
  const playBtn = document.getElementById('sgPlayBtn');
  const geoBtn = document.getElementById('sgGeoBtn');

  const QUALITY_SRC = 'sg-quality-src', QUALITY_LYR = 'sg-quality';
  const MASK_SRC = 'sg-mask-src', MASK_LYR = 'sg-mask';
  const TOP_SRC = 'sg-top-src', TOP_GLOW = 'sg-top-glow', TOP_LYR = 'sg-top';
  const BEFORE_ID = 'waterway_label';      // insérer SOUS les labels (villes visibles pour l'orientation)
  const NIGHT_DARK = '#0a0b10';            // hors France = nuit (neutre sombre, sans bleu saturé)
  const CELL_KM = 15, OVERLAP = 1.06;
  const EMPTY_FC = { type: 'FeatureCollection', features: [] };
  // Rampe V3 « ambre nuit » (opaque) : médiocre = sombre → excellent = or.
  const COLOR = ['interpolate', ['linear'], ['get', 'q'],
    12, '#0e0b08', 30, '#241408', 48, '#472810', 62, '#764715', 74, '#ad781b', 84, '#dcab3e', 92, '#f2d488'];

  let active = false, data = null, hours = [], cursor = 0;
  let playing = false, playTimer = null;
  let layersReady = false, loadToken = 0, clickBound = false;
  let popup = null, userMarker = null;
  const hourFcCache = new Map();
  let bestDark = null, bestDarkHour = null;   // meilleur score/heure sur les heures sombres, par cellule
  let railTrack = null, railMarks = [];

  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }
  function fmtHM(iso) { try { return new Date(iso).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' }); } catch (_) { return '--:--'; } }
  function fmtHMz(z) { // "2026-07-21T01:50Z" → heure locale
    if (!z) return '--:--';
    try { return new Date(z).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' }); } catch (_) { return '--:--'; }
  }
  function verdict(s) {
    if (s >= 75) return 'Excellent'; if (s >= 55) return 'Bon';
    if (s >= 35) return 'Moyen'; if (s >= 15) return 'Médiocre'; return 'Mauvais';
  }

  // ── Géométrie ──────────────────────────────────────────────────────────────
  function cellFeaturesForHour(hi) {
    if (hourFcCache.has(hi)) return hourFcCache.get(hi);
    const row = data.scores[hi];
    if (!row) { hourFcCache.set(hi, EMPTY_FC); return EMPTY_FC; }
    const cells = data.cells, feats = [];
    for (let i = 0; i < cells.length; i++) {
      const q = row[i];
      if (q == null) continue;
      const lon = cells[i].lon, lat = cells[i].lat;
      const hw = (CELL_KM / (111.32 * Math.cos(lat * Math.PI / 180))) / 2 * OVERLAP;
      const hh = (CELL_KM / 110.574) / 2 * OVERLAP;
      feats.push({ type: 'Feature', properties: { q },
        geometry: { type: 'Polygon', coordinates: [[
          [lon - hw, lat - hh], [lon + hw, lat - hh], [lon + hw, lat + hh], [lon - hw, lat + hh], [lon - hw, lat - hh]]] } });
    }
    const fc = { type: 'FeatureCollection', features: feats };
    hourFcCache.set(hi, fc);
    return fc;
  }

  function franceMaskFC() {
    // monde MOINS France (métropole + Corse en trous) → cache le débordement des
    // cellules hors des côtes + peint la nuit autour. Anneaux [[lon,lat],…] globaux.
    const world = [[-179, 80], [179, 80], [179, -80], [-179, -80], [-179, 80]];
    const rings = [world];
    try {
      if (typeof FRANCE_GRID_CLIP_RINGS !== 'undefined' && Array.isArray(FRANCE_GRID_CLIP_RINGS)) {
        FRANCE_GRID_CLIP_RINGS.forEach((r) => rings.push(r));
      } else {
        if (typeof FRANCE_GRID_CLIP_MAINLAND_RING !== 'undefined') rings.push(FRANCE_GRID_CLIP_MAINLAND_RING);
        if (typeof FRANCE_GRID_CLIP_CORSICA_RING !== 'undefined') rings.push(FRANCE_GRID_CLIP_CORSICA_RING);
      }
    } catch (_) {}
    return { type: 'FeatureCollection', features: [{ type: 'Feature', properties: {}, geometry: { type: 'Polygon', coordinates: rings } }] };
  }

  function topSpotsFC() {
    const top = (data && data.top_spots) || [];
    return { type: 'FeatureCollection', features: top.map((t, i) => ({ type: 'Feature',
      properties: { idx: i, score: t.score, hour: t.hour, darkness: t.darkness },
      geometry: { type: 'Point', coordinates: [t.lon, t.lat] } })) };
  }

  // ── Couches ────────────────────────────────────────────────────────────────
  function beforeId() { return map.getLayer(BEFORE_ID) ? BEFORE_ID : undefined; }

  function ensureLayers() {
    if (!map || !(map.isStyleLoaded && map.isStyleLoaded())) return false;
    const bid = beforeId();
    if (!map.getSource(QUALITY_SRC)) map.addSource(QUALITY_SRC, { type: 'geojson', data: EMPTY_FC });
    // fill-antialias FALSE : sinon MapLibre dessine un liseré 1px par cellule qui,
    // combiné au recouvrement, produit un « contour décalé » sur chaque carré.
    if (!map.getLayer(QUALITY_LYR)) map.addLayer({ id: QUALITY_LYR, type: 'fill', source: QUALITY_SRC,
      paint: { 'fill-color': COLOR, 'fill-opacity': 1, 'fill-antialias': false } }, bid);
    if (!map.getSource(MASK_SRC)) map.addSource(MASK_SRC, { type: 'geojson', data: franceMaskFC() });
    if (!map.getLayer(MASK_LYR)) map.addLayer({ id: MASK_LYR, type: 'fill', source: MASK_SRC,
      paint: { 'fill-color': NIGHT_DARK, 'fill-opacity': 1 } }, bid);
    if (!map.getSource(TOP_SRC)) map.addSource(TOP_SRC, { type: 'geojson', data: EMPTY_FC });
    if (!map.getLayer(TOP_GLOW)) map.addLayer({ id: TOP_GLOW, type: 'circle', source: TOP_SRC,
      paint: { 'circle-radius': 19, 'circle-color': '#e0ad3f', 'circle-blur': 1, 'circle-opacity': 0.45 } }, bid);
    if (!map.getLayer(TOP_LYR)) map.addLayer({ id: TOP_LYR, type: 'circle', source: TOP_SRC,
      paint: { 'circle-radius': 5, 'circle-color': '#f7dfa0', 'circle-stroke-color': '#2a1600', 'circle-stroke-width': 1.4, 'circle-opacity': 0.96 } }, bid);
    layersReady = true;
    return true;
  }

  function hideGrid(hide) {
    const layers = ((map.getStyle() || {}).layers) || [];
    for (const l of layers) {
      if (l.id && l.id.indexOf('grid') === 0) {
        try { map.setLayoutProperty(l.id, 'visibility', hide ? 'none' : 'visible'); } catch (_) {}
      }
    }
  }

  function setLayersVisible(on) {
    [QUALITY_LYR, MASK_LYR, TOP_GLOW, TOP_LYR].forEach((id) => {
      if (map.getLayer(id)) { try { map.setLayoutProperty(id, 'visibility', on ? 'visible' : 'none'); } catch (_) {} }
    });
  }

  function paintHour(hi) {
    if (!map.getSource(QUALITY_SRC)) return;
    try { map.getSource(QUALITY_SRC).setData(cellFeaturesForHour(hi)); } catch (_) {}
  }

  // ── Badge + frise ────────────────────────────────────────────────────────
  function renderBadge() {
    if (!data) return;
    const m = data.moon || {};
    if (moonIconEl) moonIconEl.style.setProperty('--sg-illum', String(m.illumination != null ? m.illumination : 0.5));
    if (moonEl) moonEl.textContent = 'Lune : ' + (m.phase_name || '—') + ' ' + Math.round((m.illumination || 0) * 100) + ' %';
    const n = data.night || {};
    if (nightEl) nightEl.textContent = (n.night_start_utc && n.night_end_utc)
      ? 'Nuit noire ' + fmtHMz(n.night_start_utc) + ' → ' + fmtHMz(n.night_end_utc)
      : 'Pas de nuit noire ce soir';
    updateHourBadge();
  }

  function updateHourBadge() {
    const h = hours[cursor];
    if (!hourEl || !h) return;
    hourEl.hidden = false;
    hourEl.textContent = fmtHM(h.iso) + (h.dark ? ' · nuit noire' : ' · crépuscule');
    hourEl.classList.toggle('is-twilight', !h.dark);
  }

  function railFrac(i) {
    if (!hours.length) return 0;
    const t0 = hours[0].epoch, t1 = hours[hours.length - 1].epoch;
    return Math.max(0, Math.min(100, ((hours[i].epoch - t0) / Math.max(1, t1 - t0)) * 100));
  }

  // Icônes de phase solaire (lever/coucher/nuit) — MÊME rendu que la frise de base
  // (timeline-solar.js), positionnées sur la fenêtre de la nuit.
  function addSolarIcons(track) {
    if (typeof timelinePhaseDefinitions !== 'function' || typeof timelinePhaseIconSvg !== 'function' || !hours.length) return;
    const t0 = hours[0].epoch, t1 = hours[hours.length - 1].epoch;
    const days = new Set();
    for (const e of [t0, t1]) {
      const d = new Date(e * 1000);
      days.add(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`);
    }
    for (const iso of days) {
      let defs; try { defs = timelinePhaseDefinitions(iso); } catch (_) { continue; }
      const [Y, M, D] = iso.split('-').map(Number);
      const midnight = new Date(Y, M - 1, D, 0, 0, 0).getTime() / 1000;
      for (const ph of defs) {
        const pct = ((midnight + ph.hour * 3600 - t0) / Math.max(1, t1 - t0)) * 100;
        if (pct <= 0 || pct >= 100) continue;
        const icon = document.createElement('span');
        icon.className = `timeline-light-icon timeline-light-icon-${ph.type}`;
        icon.style.left = pct + '%';
        icon.setAttribute('role', 'img');
        icon.setAttribute('aria-label', ph.label || ph.type);
        icon.innerHTML = timelinePhaseIconSvg(ph.type);
        track.appendChild(icon);
      }
    }
  }

  // Frise = MÊME structure/classes que la frise de base et du mode chasse
  // (.timeline-rail*, stylée par timeline.css ; recolorée ambre via --tl-accent).
  function buildFrise() {
    if (!slotsEl) return;
    slotsEl.innerHTML = '';
    railTrack = null; railMarks = [];
    if (!hours.length) return;
    const rail = document.createElement('div');
    rail.className = 'timeline-rail stargaze-rail';
    rail.setAttribute('role', 'slider');
    rail.setAttribute('aria-label', 'Heure de la nuit');
    rail.tabIndex = 0;
    const track = document.createElement('div');
    track.className = 'timeline-rail-track';
    addSolarIcons(track);
    const fill = document.createElement('div'); fill.className = 'timeline-rail-fill'; track.appendChild(fill);
    const cur = document.createElement('div'); cur.className = 'timeline-rail-cursor';
    cur.innerHTML = '<span></span>'; track.appendChild(cur);
    hours.forEach((h, i) => {
      const mark = document.createElement('div');
      // les heures de VRAIE nuit (sun < −18°) reçoivent un trait ambre marqué.
      mark.className = 'timeline-hour-mark' + (h.dark ? ' sg-dark-hour' : '') + (i === cursor ? ' active' : '');
      mark.style.left = railFrac(i) + '%';
      mark.dataset.idx = String(i);
      const line = document.createElement('span'); line.className = 'timeline-hour-line';
      const label = document.createElement('span'); label.className = 'timeline-hour-label';
      label.textContent = String(new Date(h.epoch * 1000).getHours()).padStart(2, '0');
      mark.appendChild(line); mark.appendChild(label);
      track.appendChild(mark);
      railMarks.push(mark);
    });
    rail.appendChild(track);
    railTrack = track;
    attachRailDrag(rail);
    slotsEl.appendChild(rail);
    updateCursorUI();
  }

  function updateCursorUI() {
    if (!railTrack) return;
    railTrack.style.setProperty('--timeline-active-pct', railFrac(cursor) + '%');
    const span = railTrack.querySelector('.timeline-rail-cursor span');
    if (span && hours[cursor]) span.textContent = fmtHM(hours[cursor].iso);
    railMarks.forEach((m, i) => m.classList.toggle('active', i === cursor));
    const rail = railTrack.parentElement;
    if (rail && hours[cursor]) rail.setAttribute('aria-valuetext', fmtHM(hours[cursor].iso));
  }

  function attachRailDrag(rail) {
    const pick = (clientX) => {
      const r = rail.getBoundingClientRect();
      const frac = Math.max(0, Math.min(1, (clientX - r.left) / Math.max(1, r.width)));
      const t0 = hours[0].epoch, t1 = hours[hours.length - 1].epoch;
      const target = t0 + frac * (t1 - t0);
      let best = 0, bd = Infinity;
      hours.forEach((h, i) => { const d = Math.abs(h.epoch - target); if (d < bd) { bd = d; best = i; } });
      return best;
    };
    let dragging = false;
    rail.addEventListener('pointerdown', (e) => { dragging = true; try { rail.setPointerCapture(e.pointerId); } catch (_) {} stop(); applyCursor(pick(e.clientX)); });
    rail.addEventListener('pointermove', (e) => { if (dragging) applyCursor(pick(e.clientX)); });
    rail.addEventListener('pointerup', () => { dragging = false; });
    rail.addEventListener('pointercancel', () => { dragging = false; });
    rail.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowLeft') { stop(); applyCursor(cursor - 1); e.preventDefault(); }
      else if (e.key === 'ArrowRight') { stop(); applyCursor(cursor + 1); e.preventDefault(); }
    });
  }

  function applyCursor(i) {
    if (!hours.length) return;
    cursor = Math.max(0, Math.min(hours.length - 1, i));
    paintHour(cursor);
    updateCursorUI();
    updateHourBadge();
  }

  function play() {
    if (playing) return stop();
    if (hours.length < 2) return;
    playing = true;
    if (playBtn) { playBtn.classList.add('active'); playBtn.setAttribute('aria-pressed', 'true'); }
    playTimer = window.setInterval(() => {
      let next = cursor + 1; if (next >= hours.length) next = 0;
      applyCursor(next);
    }, 900);
  }
  function stop() {
    if (!playing) return;
    playing = false;
    if (playTimer) { window.clearInterval(playTimer); playTimer = null; }
    if (playBtn) { playBtn.classList.remove('active'); playBtn.setAttribute('aria-pressed', 'false'); }
  }

  // ── Données ────────────────────────────────────────────────────────────────
  function computeBestDark() {
    const n = data.cells.length;
    bestDark = new Array(n).fill(-1); bestDarkHour = new Array(n).fill(null);
    const darkIdx = hours.map((h, i) => (h.dark ? i : -1)).filter((i) => i >= 0);
    const use = darkIdx.length ? darkIdx : hours.map((_, i) => i);
    for (const hi of use) {
      const row = data.scores[hi]; if (!row) continue;
      for (let i = 0; i < n; i++) { const s = row[i]; if (s != null && s > bestDark[i]) { bestDark[i] = s; bestDarkHour[i] = hours[hi].hour; } }
    }
  }

  function defaultCursor() {
    // heure sombre au meilleur score médian (sinon milieu de la nuit)
    let best = -1, bi = Math.floor(hours.length / 2);
    hours.forEach((h, i) => {
      const row = data.scores[i]; if (!h.dark || !row) return;
      let sum = 0, c = 0; for (const s of row) { if (s != null) { sum += s; c++; } }
      const med = c ? sum / c : 0; if (med > best) { best = med; bi = i; }
    });
    return bi;
  }

  async function loadData() {
    const token = ++loadToken;
    showHint('Calcul des conditions de la nuit…');
    let d = null;
    try { d = await (await fetch('/api/stargaze/tonight')).json(); } catch (_) {}
    if (token !== loadToken || !active) return;
    if (!d || !d.ok) {
      showHint((d && d.message) || 'Grille AROME de la nuit indisponible — réessaie plus tard.');
      return;
    }
    hideHint();
    data = d; hours = d.hours || []; hourFcCache.clear();
    computeBestDark();
    renderBadge();
    buildFrise();
    if (map.getSource(TOP_SRC)) try { map.getSource(TOP_SRC).setData(topSpotsFC()); } catch (_) {}
    cursor = defaultCursor();
    applyCursor(cursor);
  }

  let hintEl = null;
  function showHint(txt) {
    if (!hintEl) { hintEl = document.createElement('div'); hintEl.className = 'sg-empty-hint'; document.body.appendChild(hintEl); }
    hintEl.textContent = txt; hintEl.hidden = false;
  }
  function hideHint() { if (hintEl) hintEl.hidden = true; }

  // ── Interaction carte ───────────────────────────────────────────────────────
  function ensurePopup() {
    if (!popup) popup = new maplibregl.Popup({ className: 'stargaze-popup', closeButton: true, closeOnClick: true, maxWidth: '280px', offset: 12 });
    return popup;
  }

  function nearestCell(lng, lat) {
    let bi = -1, bd = Infinity; const cells = data.cells;
    const cl = Math.cos(lat * Math.PI / 180);
    for (let i = 0; i < cells.length; i++) {
      const dx = (cells[i].lon - lng) * cl, dy = (cells[i].lat - lat);
      const d = dx * dx + dy * dy; if (d < bd) { bd = d; bi = i; }
    }
    return bi;
  }

  function spotPopupHTML(score, hourH, darkness, cloud, title) {
    const v = verdict(score);
    let h = '';
    if (title) h += '<p class="sg-pop-title">' + esc(title) + '</p>';
    h += '<div class="sg-pop-verdict">' + esc(v) + '<span class="sg-pop-score">' + score + '/100</span></div>';
    h += '<ul class="sg-pop-list">';
    if (hourH != null) h += '<li>Meilleur créneau <strong>' + String(hourH).padStart(2, '0') + ' h</strong></li>';
    if (darkness != null) h += '<li>Obscurité du site <strong>' + darkness + '/100</strong></li>';
    if (cloud != null) h += '<li>Nuages (créneau) <strong>' + Math.round(cloud) + ' %</strong></li>';
    h += '</ul>';
    return h;
  }

  function onMapClick(e) {
    if (!data) return;
    // top spot ?
    const box = [[e.point.x - 8, e.point.y - 8], [e.point.x + 8, e.point.y + 8]];
    let feats = [];
    try { feats = map.queryRenderedFeatures(box, { layers: [TOP_LYR] }); } catch (_) {}
    if (feats.length) {
      const p = feats[0].properties;
      ensurePopup().setLngLat(feats[0].geometry.coordinates).setHTML(
        spotPopupHTML(+p.score, p.hour, +p.darkness, null, 'Top spot')).addTo(map);
      return;
    }
    // cellule sous le clic
    const i = nearestCell(e.lngLat.lng, e.lngLat.lat);
    if (i < 0) return;
    const sc = data.scores[cursor] ? data.scores[cursor][i] : null;
    if (sc == null) return;
    const cl = data.cloud[cursor] ? data.cloud[cursor][i] : null;
    ensurePopup().setLngLat([data.cells[i].lon, data.cells[i].lat]).setHTML(
      spotPopupHTML(sc, bestDarkHour ? bestDarkHour[i] : null, data.darkness[i], cl, null)).addTo(map);
  }

  // ── Autour de moi ────────────────────────────────────────────────────────
  function autourDeMoi() {
    if (!navigator.geolocation) { showHint('Géolocalisation indisponible.'); window.setTimeout(hideHint, 2500); return; }
    geoBtn && geoBtn.classList.add('active');
    navigator.geolocation.getCurrentPosition((pos) => {
      geoBtn && geoBtn.classList.remove('active');
      const lat = pos.coords.latitude, lng = pos.coords.longitude;
      if (userMarker) userMarker.remove();
      const el = document.createElement('div'); el.className = 'sg-user-dot';
      userMarker = new maplibregl.Marker({ element: el }).setLngLat([lng, lat]).addTo(map);
      // meilleurs spots dans ~120 km
      const cl = Math.cos(lat * Math.PI / 180);
      const cand = [];
      for (let i = 0; i < data.cells.length; i++) {
        if (bestDark[i] < 20) continue;
        const dx = (data.cells[i].lon - lng) * cl * 111.32, dy = (data.cells[i].lat - lat) * 110.574;
        const km = Math.sqrt(dx * dx + dy * dy);
        if (km <= 120) cand.push({ i, km, s: bestDark[i] });
      }
      cand.sort((a, b) => b.s - a.s || a.km - b.km);
      const picks = [];
      for (const c of cand) {
        if (picks.some((p) => { const a = data.cells[p.i], b = data.cells[c.i];
          return Math.abs(a.lat - b.lat) < 0.28 && Math.abs(a.lon - b.lon) * cl < 0.32; })) continue;
        picks.push(c); if (picks.length >= 5) break;
      }
      map.flyTo({ center: [lng, lat], zoom: 7.4, duration: 900 });
      let html = '<p class="sg-pop-title">Meilleurs coins près de toi</p>';
      if (!picks.length) html += '<p class="sg-pop-empty">Aucun bon spot à moins de 120 km ce soir.</p>';
      else {
        html += '<ul class="sg-pop-list">';
        picks.forEach((p) => {
          const c = data.cells[p.i];
          const brg = bearing(lat, lng, c.lat, c.lon);
          html += '<li><span>' + Math.round(p.km) + ' km ' + brg + ' · ' + String(bestDarkHour[p.i]).padStart(2, '0') + ' h</span><strong>' + p.s + '/100</strong></li>';
        });
        html += '</ul>';
      }
      ensurePopup().setLngLat([lng, lat]).setHTML(html).addTo(map);
    }, () => {
      geoBtn && geoBtn.classList.remove('active');
      showHint('Localisation refusée.'); window.setTimeout(hideHint, 2500);
    }, { enableHighAccuracy: false, timeout: 8000, maximumAge: 60000 });
  }

  function bearing(la1, lo1, la2, lo2) {
    const dLon = (lo2 - lo1) * Math.cos(((la1 + la2) / 2) * Math.PI / 180);
    const dLat = la2 - la1;
    const dirs = ['N', 'NE', 'E', 'SE', 'S', 'SO', 'O', 'NO'];
    const ang = (Math.atan2(dLon, dLat) * 180 / Math.PI + 360) % 360;
    return dirs[Math.round(ang / 45) % 8];
  }

  // ── Activation / désactivation ───────────────────────────────────────────
  async function activate() {
    if (active) return;
    // exclusion mutuelle avec le mode chasse
    if (document.body.classList.contains('chase-mode') && typeof window.toggleChaseMode === 'function') window.toggleChaseMode();
    active = true;
    toggleBtn.classList.add('active');
    toggleBtn.setAttribute('aria-pressed', 'true');
    controls.setAttribute('aria-hidden', 'false');
    if (topInfo) topInfo.setAttribute('aria-hidden', 'false');
    document.body.classList.add('stargaze-mode');
    if (ensureLayers()) { hideGrid(true); setLayersVisible(true); }
    else {
      const retry = () => { if (!active) return; if (ensureLayers()) { hideGrid(true); setLayersVisible(true); paintHour(cursor); } else window.setTimeout(retry, 250); };
      window.setTimeout(retry, 250);
    }
    if (!clickBound) { map.on('click', onMapClick); clickBound = true; }
    await loadData();
  }

  function deactivate() {
    if (!active) return;
    active = false;
    stop();
    toggleBtn.classList.remove('active');
    toggleBtn.setAttribute('aria-pressed', 'false');
    controls.setAttribute('aria-hidden', 'true');
    if (topInfo) topInfo.setAttribute('aria-hidden', 'true');
    document.body.classList.remove('stargaze-mode');
    setLayersVisible(false);
    try { map.getSource(QUALITY_SRC) && map.getSource(QUALITY_SRC).setData(EMPTY_FC); } catch (_) {}
    try { map.getSource(TOP_SRC) && map.getSource(TOP_SRC).setData(EMPTY_FC); } catch (_) {}
    if (layersReady) hideGrid(false);
    if (clickBound) { map.off('click', onMapClick); clickBound = false; }
    if (popup) { popup.remove(); }
    if (userMarker) { userMarker.remove(); userMarker = null; }
    hideHint();
  }

  toggleBtn.addEventListener('click', () => { active ? deactivate() : activate(); });
  playBtn && playBtn.addEventListener('click', play);
  geoBtn && geoBtn.addEventListener('click', autourDeMoi);
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && active) deactivate(); });

  window.toggleStargazeMode = () => { active ? deactivate() : activate(); };
  window.exitStargazeMode = () => { if (active) deactivate(); };
  window.__stargazeV = '1.3.45';
})();
