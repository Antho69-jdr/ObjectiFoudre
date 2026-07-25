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
  const auroraSepEl = document.getElementById('sgAuroraSep');
  const auroraEl = document.getElementById('sgAurora');
  const hourEl = document.getElementById('sgHour');
  const slotsEl = document.getElementById('stargazeSlots');
  const nightPrevBtn = document.getElementById('sgNightPrev');
  const nightNextBtn = document.getElementById('sgNightNext');
  const playBtn = document.getElementById('sgPlayBtn');
  const geoBtn = document.getElementById('sgGeoBtn');
  const PLAY_SVG = '<svg class="icon-svg" viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"></circle><path d="M10 8.2 16.3 12 10 15.8Z" fill="currentColor" stroke="none"></path></svg>';
  const PAUSE_SVG = '<svg class="icon-svg" viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"></circle><rect x="9" y="8.3" width="2.2" height="7.4" rx="0.6" fill="currentColor" stroke="none"></rect><rect x="12.8" y="8.3" width="2.2" height="7.4" rx="0.6" fill="currentColor" stroke="none"></rect></svg>';

  const QUALITY_SRC = 'sg-quality-src', QUALITY_LYR = 'sg-quality';
  const TOP_SRC = 'sg-top-src', TOP_GLOW = 'sg-top-glow', TOP_LYR = 'sg-top';
  // Calque SATELLITE nuages live (EUMETSAT View Service, WMS public sans clé) : carte
  // IR 10.8 µm globale (nuages jour ET nuit). MapLibre charge les tuiles WMS en <img>
  // (aucun souci CORS). Inséré SOUS les top spots (jamais masqués).
  const SAT_SRC = 'sg-sat-src', SAT_LYR = 'sg-sat';
  const SAT_WMS = 'https://view.eumetsat.int/geoserver/wms?service=WMS&version=1.3.0'
    + '&request=GetMap&layers=mumi:worldcloudmap_ir108&styles=&crs=EPSG:3857'
    + '&bbox={bbox-epsg-3857}&width=256&height=256&format=image/png&transparent=true';
  const satBtn = document.getElementById('sgSatBtn');
  let satOn = false;
  // Champ inséré SOUS la couche 'water' → la mer rogne le débordement des cellules au
  // littoral et le RESTE DU MONDE reste visible (comme la carte de base / mode chasse).
  const FIELD_BEFORE = 'water';
  const CELL_KM = 15, OVERLAP = 1.06;
  const EMPTY_FC = { type: 'FeatureCollection', features: [] };
  // Rampe V3 « ambre nuit » (opaque) : médiocre = sombre → excellent = or.
  const COLOR_STOPS = [12, '#0e0b08', 30, '#241408', 48, '#472810', 62, '#764715', 74, '#ad781b', 84, '#dcab3e', 92, '#f2d488'];
  // Recoloration NUIT de la carte de base (comme setChaseMapTint) : les surroundings
  // restent VISIBLES, juste assombris/réchauffés (jamais de bleu). [layer, prop, nuit, normal]
  const STARGAZE_MAP_TINT = [
    ['background', 'background-color', '#080a10', '#08101c'],
    ['water', 'fill-color', 'rgba(16, 20, 28, 1)', 'rgba(38, 56, 72, 1)'],
    ['landuse_residential', 'fill-color', 'rgba(26, 22, 14, 0.72)', 'rgba(17, 28, 42, 0.72)'],
    ['waterway', 'line-color', 'rgba(90, 80, 58, 0.55)', 'rgba(70, 100, 124, 0.55)'],
    ['france-department-lines', 'line-color', 'rgba(184, 150, 92, 0.5)', 'rgba(120, 145, 175, 0.5)'],
    ['france-region-lines', 'line-color', 'rgba(212, 178, 120, 0.62)', 'rgba(150, 176, 208, 0.62)'],
  ];

  let active = false, data = null, hours = [], cursor = 0;
  let playing = false, playTimer = null;
  let layersReady = false, loadToken = 0, clickBound = false;
  let popup = null, userMarker = null;
  let degraded = false, retryTimer = null;     // repli « obscurité seule » quand la météo AROME manque
  let qualityFC = null;                        // géométrie des cellules construite UNE fois (scores q0..qN en props)
  let clippedCells = null;                     // coords de chaque cellule ROGNÉE à la France (statique → cache)
  let bestDark = null, bestDarkHour = null;   // meilleur score/heure sur les heures sombres, par cellule
  let railTrack = null, railMarks = [];
  // Prévision nébulosité des prochaines nuits (ECMWF) : « ce soir » (index 0, /tonight,
  // AROME horaire) + nuits futures (index ≥1, /outlook, une carte par nuit).
  let tonightData = null, outlookData = null, viewNight = 0, outlookLoading = false;

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
  // Rogne chaque cellule à la silhouette France en RÉUTILISANT la fonction officielle
  // de la carte de base : `clippedFranceCellGeometry` (grid-clip-geometry.js) — la même
  // que la grille de score. → clip IDENTIQUE (mer + frontières terrestres), gère les
  // MultiPolygon et écarte les slivers. Grille + France statiques → cache.
  function computeClippedCells() {
    if (clippedCells && clippedCells._n === data.cells.length) return clippedCells;
    const canClip = (typeof clippedFranceCellGeometry === 'function');
    const out = [];
    for (let i = 0; i < data.cells.length; i++) {
      const lon = data.cells[i].lon, lat = data.cells[i].lat;
      const hw = (CELL_KM / (111.32 * Math.cos(lat * Math.PI / 180))) / 2 * OVERLAP;
      const hh = (CELL_KM / 110.574) / 2 * OVERLAP;
      const minx = lon - hw, maxx = lon + hw, miny = lat - hh, maxy = lat + hh;
      let geom = null;
      if (canClip) {
        try { geom = clippedFranceCellGeometry(minx, miny, maxx, maxy); } catch (_) {}
        if (!geom) continue;   // aucune part en France → on n'affiche pas la cellule
      } else {
        geom = { type: 'Polygon', coordinates: [[[minx, miny], [maxx, miny], [maxx, maxy], [minx, maxy], [minx, miny]]] };
      }
      out.push({ i, geom });
    }
    out._n = data.cells.length;
    clippedCells = out;
    return out;
  }

  // UNE seule FeatureCollection : chaque cellule (rognée à la France) porte son score
  // à CHAQUE heure (props q0, q1, …). Le changement d'heure ne touche QUE l'expression
  // de couleur (setPaintProperty) → aucune re-génération de géométrie, quasi-instantané.
  function buildQualityFC() {
    const clipped = computeClippedCells(), nH = hours.length, feats = [];
    for (const c of clipped) {
      const i = c.i;
      const dk = (data.darkness && data.darkness[i] != null) ? data.darkness[i] : null;
      const props = { idx: i };
      if (dk != null) props.dk = dk;   // obscurité (statique) → repli quand la météo manque
      let any = dk != null;
      for (let h = 0; h < nH; h++) {
        const row = data.scores[h];
        const q = row ? row[i] : null;
        if (q != null) { props['q' + h] = q; any = true; }
      }
      if (!any) continue;
      feats.push({ type: 'Feature', properties: props, geometry: c.geom });
    }
    return { type: 'FeatureCollection', features: feats };
  }

  // Expression fill-color pour l'heure hi : cellule sans score à cette heure → transparente.
  function colorExpr(hi) {
    const prop = 'q' + hi;
    return ['case',
      ['<', ['coalesce', ['get', prop], -1], 0], 'rgba(0,0,0,0)',
      ['interpolate', ['linear'], ['get', prop]].concat(COLOR_STOPS)];
  }
  // Repli « obscurité seule » (météo AROME non chargée) : couleur par obscurité du site.
  function colorExprDk() {
    return ['interpolate', ['linear'], ['coalesce', ['get', 'dk'], 0]].concat(COLOR_STOPS);
  }

  function topSpotsFC() {
    const top = (data && data.top_spots) || [];
    return { type: 'FeatureCollection', features: top.map((t, i) => ({ type: 'Feature',
      properties: { idx: i, score: t.score, hour: t.hour, darkness: t.darkness },
      geometry: { type: 'Point', coordinates: [t.lon, t.lat] } })) };
  }

  // ── Couches ────────────────────────────────────────────────────────────────
  function ensureLayers() {
    if (!map || !(map.isStyleLoaded && map.isStyleLoaded())) return false;
    const fieldBefore = map.getLayer(FIELD_BEFORE) ? FIELD_BEFORE : undefined;
    // Champ de qualité SOUS 'water' → littoral rogné, monde visible. fill-antialias
    // FALSE (sinon liseré 1px par cellule = « contour décalé »).
    if (!map.getSource(QUALITY_SRC)) map.addSource(QUALITY_SRC, { type: 'geojson', data: EMPTY_FC });
    if (!map.getLayer(QUALITY_LYR)) map.addLayer({ id: QUALITY_LYR, type: 'fill', source: QUALITY_SRC,
      paint: { 'fill-color': 'rgba(0,0,0,0)', 'fill-opacity': 1, 'fill-antialias': false } }, fieldBefore);
    // Top spots AU-DESSUS de tout (jamais masqués).
    if (!map.getSource(TOP_SRC)) map.addSource(TOP_SRC, { type: 'geojson', data: EMPTY_FC });
    if (!map.getLayer(TOP_GLOW)) map.addLayer({ id: TOP_GLOW, type: 'circle', source: TOP_SRC,
      paint: { 'circle-radius': 19, 'circle-color': '#e0ad3f', 'circle-blur': 1, 'circle-opacity': 0.45 } });
    if (!map.getLayer(TOP_LYR)) map.addLayer({ id: TOP_LYR, type: 'circle', source: TOP_SRC,
      paint: { 'circle-radius': 5, 'circle-color': '#f7dfa0', 'circle-stroke-color': '#2a1600', 'circle-stroke-width': 1.4, 'circle-opacity': 0.96 } });
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
    [QUALITY_LYR, TOP_GLOW, TOP_LYR].forEach((id) => {
      if (map.getLayer(id)) { try { map.setLayoutProperty(id, 'visibility', on ? 'visible' : 'none'); } catch (_) {} }
    });
  }

  // Changement d'heure = SEULEMENT l'expression de couleur → quasi-instantané.
  function paintHour(hi) {
    if (!map.getLayer(QUALITY_LYR)) return;
    try { map.setPaintProperty(QUALITY_LYR, 'fill-color', degraded ? colorExprDk() : colorExpr(hi)); } catch (_) {}
  }

  // Recoloration nuit de la carte de base (surroundings visibles), comme le mode chasse.
  function setStargazeMapTint(on) {
    if (!map) return;
    const apply = () => {
      for (const [layer, prop, nightVal, normalVal] of STARGAZE_MAP_TINT) {
        if (map.getLayer(layer)) { try { map.setPaintProperty(layer, prop, on ? nightVal : normalVal); } catch (_) {} }
      }
    };
    if (map.isStyleLoaded && map.isStyleLoaded()) apply();
    else map.once('idle', apply);
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
    // Aurore boréale (Kp NOAA SWPC, servi par /tonight) : silencieux tant que le ciel
    // géomagnétique est calme (level 0 ou données indisponibles) ; gras ambre dès
    // « possible au nord » (level ≥ 2, Kp ≥ 7).
    if (auroraEl && auroraSepEl) {
      const a = data.aurora || null;
      const show = !!(a && a.level >= 1);
      auroraSepEl.hidden = !show;
      auroraEl.hidden = !show;
      if (show) {
        auroraEl.textContent = 'Aurore ' + (a.label || '') + ' (Kp ' + (a.kp_max_24h != null ? a.kp_max_24h : '?') + ')';
        auroraEl.classList.toggle('is-strong', a.level >= 2);
        auroraSepEl.classList.toggle('is-strong', a.level >= 2);
      }
    }
    updateHourBadge();
  }

  function updateHourBadge() {
    if (!hourEl) return;
    if (viewNight > 0) { hourEl.hidden = true; return; }   // nuit future : libellé dans la frise
    if (degraded) {
      hourEl.hidden = false;
      hourEl.textContent = 'obscurité seule · météo en cours';
      hourEl.classList.add('is-twilight');
      return;
    }
    const h = hours[cursor];
    if (!h) { hourEl.hidden = true; return; }
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
    if (playBtn) { playBtn.classList.add('active'); playBtn.setAttribute('aria-pressed', 'true'); playBtn.setAttribute('aria-label', 'Pause'); playBtn.title = 'Pause'; playBtn.innerHTML = PAUSE_SVG; }
    playTimer = window.setInterval(() => {
      let next = cursor + 1; if (next >= hours.length) next = 0;
      applyCursor(next);
    }, 900);
  }
  function stop() {
    if (!playing) return;
    playing = false;
    if (playTimer) { window.clearInterval(playTimer); playTimer = null; }
    if (playBtn) { playBtn.classList.remove('active'); playBtn.setAttribute('aria-pressed', 'false'); playBtn.setAttribute('aria-label', 'Faire défiler la nuit'); playBtn.title = 'Faire défiler la nuit'; playBtn.innerHTML = PLAY_SVG; }
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
    // repli « obscurité seule » : à défaut de météo, on classe sur l'obscurité du site.
    if (degraded || !hours.length) {
      for (let i = 0; i < n; i++) if (data.darkness && data.darkness[i] != null) bestDark[i] = data.darkness[i];
    }
  }

  function defaultCursor() {
    // Toujours ouvrir sur une heure QUI A DES DONNÉES (préchargement parfois partiel),
    // en priorisant la vraie nuit puis le meilleur score médian.
    let best = -Infinity, bi = -1;
    hours.forEach((h, i) => {
      const row = data.scores[i]; if (!row) return;
      let sum = 0, c = 0; for (const s of row) { if (s != null) { sum += s; c++; } }
      if (!c) return;                                   // heure sans aucune cellule → ignorée
      const score = (sum / c) + (h.dark ? 1000 : 0);    // priorité à la nuit noire
      if (score > best) { best = score; bi = i; }
    });
    if (bi < 0) bi = hours.findIndex((_, i) => data.scores[i]);   // 1re heure avec un tableau
    return bi < 0 ? 0 : bi;
  }

  async function loadData() {
    const token = ++loadToken;
    if (retryTimer) { window.clearTimeout(retryTimer); retryTimer = null; }
    showHint('Calcul des conditions de la nuit…');
    let d = null;
    try { d = await (await fetch('/api/stargaze/tonight')).json(); } catch (_) {}
    if (token !== loadToken || !active) return;
    // sans cellules du tout = échec total ; sinon on sert AU MOINS l'obscurité (repli).
    if (!d || !Array.isArray(d.cells) || !d.cells.length || !Array.isArray(d.darkness)) {
      showHint((d && d.message) || 'Conditions indisponibles — réessaie plus tard.');
      return;
    }
    hideHint();
    tonightData = d;
    viewNight = 0;
    renderTonight();
    buildNightSelector();
    loadOutlook();
  }

  // Rendu de « ce soir » (données /tonight, AROME horaire) — extrait de loadData pour
  // pouvoir y revenir depuis le sélecteur de nuit.
  function renderTonight() {
    if (!tonightData) return;
    if (retryTimer) { window.clearTimeout(retryTimer); retryTimer = null; }
    degraded = !tonightData.ok;             // météo AROME absente → obscurité seule
    data = tonightData; hours = degraded ? [] : (data.hours || []);
    if (slotsEl) slotsEl.classList.remove('sg-night-static');
    if (playBtn) playBtn.style.display = '';   // ce soir : lecture des heures dispo
    computeBestDark();
    qualityFC = buildQualityFC();
    if (map.getSource(QUALITY_SRC)) try { map.getSource(QUALITY_SRC).setData(qualityFC); } catch (_) {}
    renderBadge();
    buildFrise();
    if (map.getSource(TOP_SRC)) try { map.getSource(TOP_SRC).setData(degraded ? EMPTY_FC : topSpotsFC()); } catch (_) {}
    if (degraded) {
      paintHour(0);
      // la grille AROME se précharge (ou l'API est momentanément indispo) → on réessaie.
      retryTimer = window.setTimeout(() => { if (active && viewNight === 0) loadData(); }, 90000);
    } else {
      cursor = defaultCursor();
      applyCursor(cursor);
    }
  }

  // ── Prévision nébulosité des prochaines nuits (ECMWF, /api/stargaze/outlook) ──
  function loadOutlook() {
    if (outlookData) { buildNightSelector(); return; }
    if (outlookLoading) return;
    outlookLoading = true;
    fetch('/api/stargaze/outlook').then((r) => r.json()).then((d) => {
      outlookLoading = false;
      if (d && d.ok && Array.isArray(d.nights) && d.nights.some((n) => n.available)) {
        outlookData = d; buildNightSelector();
      }
    }).catch(() => { outlookLoading = false; });
  }

  function nightLabel(dateIso) {   // "2026-07-25" → "Ven. 25" (soir de la nuit)
    try {
      const dt = new Date(dateIso + 'T12:00:00');
      const wd = dt.toLocaleDateString('fr-FR', { weekday: 'short' }).replace('.', '');
      return wd.charAt(0).toUpperCase() + wd.slice(1) + ' ' + dt.getDate();
    } catch (_) { return dateIso; }
  }

  // Ordre de navigation : « ce soir » (0) puis les nuits ECMWF disponibles (index 1..N).
  function nightOrder() {
    const nights = (outlookData && outlookData.nights) || [];
    return [0].concat(nights.map((n, i) => (n.available ? i + 1 : -1)).filter((k) => k > 0));
  }

  function buildNightSelector() {   // flèches préc/suiv sur la ligne de la frise
    if (!nightPrevBtn || !nightNextBtn) return;
    const order = nightOrder();
    const show = order.length > 1;   // au moins une nuit future disponible
    nightPrevBtn.hidden = !show;
    nightNextBtn.hidden = !show;
    if (!show) return;
    const pos = Math.max(0, order.indexOf(viewNight));
    nightPrevBtn.disabled = pos <= 0;
    nightNextBtn.disabled = pos >= order.length - 1;
  }

  function stepNight(dir) {
    const order = nightOrder();
    const pos = order.indexOf(viewNight);
    const next = pos + dir;
    if (pos < 0 || next < 0 || next >= order.length) return;
    selectNight(order[next]);
  }

  function selectNight(k) {
    if (k === viewNight) return;
    stop();
    viewNight = k;
    if (k === 0) renderTonight();
    else renderFutureNight(k);
    buildNightSelector();   // maj libellé + flèches
  }

  // Nuit future : dataset synthétique « une heure » → réutilise tout le pipeline de
  // rendu (buildQualityFC/paintHour/topSpotsFC/renderBadge) sans le dupliquer.
  function renderFutureNight(k) {
    const ngt = outlookData && outlookData.nights[k - 1];
    if (!ngt || !ngt.available) { viewNight = 0; renderTonight(); return; }
    if (retryTimer) { window.clearTimeout(retryTimer); retryTimer = null; }
    degraded = false;
    const epoch = Math.floor(new Date(ngt.date + 'T23:00:00').getTime() / 1000);
    data = {
      ok: true, cells: outlookData.cells, darkness: outlookData.darkness,
      scores: [ngt.scores], cloud: [ngt.cloud], moon: ngt.moon, night: ngt.night,
      top_spots: ngt.top_spots, hours: [{ iso: ngt.date + 'T23:00Z', epoch, dark: true }],
    };
    hours = data.hours; cursor = 0;
    if (playBtn) playBtn.style.display = 'none';   // nuit future : une seule valeur, rien à faire défiler
    computeBestDark();
    qualityFC = buildQualityFC();
    if (map.getSource(QUALITY_SRC)) try { map.getSource(QUALITY_SRC).setData(qualityFC); } catch (_) {}
    renderBadge();
    if (slotsEl) {
      slotsEl.innerHTML = '';
      slotsEl.classList.add('sg-night-static');
      const lab = document.createElement('div');
      lab.className = 'sg-night-static-label';
      lab.textContent = 'Nuit du ' + nightLabel(ngt.date) + ' · prévision ECMWF';
      slotsEl.appendChild(lab);
    }
    paintHour(0);
    if (map.getSource(TOP_SRC)) try { map.getSource(TOP_SRC).setData(topSpotsFC()); } catch (_) {}
  }

  // ── Calque satellite nuages (rail gauche) ────────────────────────────────────
  function setSat(on) {
    satOn = on;
    if (satBtn) { satBtn.classList.toggle('active', on); satBtn.setAttribute('aria-pressed', on ? 'true' : 'false'); }
    if (!map) return;
    if (on) {
      if (!map.getSource(SAT_SRC)) {
        map.addSource(SAT_SRC, { type: 'raster', tiles: [SAT_WMS], tileSize: 256,
          attribution: 'Nuages : EUMETSAT' });
      }
      if (!map.getLayer(SAT_LYR)) {
        const before = map.getLayer(TOP_GLOW) ? TOP_GLOW : undefined;   // sous les top spots
        try { map.addLayer({ id: SAT_LYR, type: 'raster', source: SAT_SRC, paint: { 'raster-opacity': 0.82 } }, before); } catch (_) {}
      } else {
        try { map.setLayoutProperty(SAT_LYR, 'visibility', 'visible'); } catch (_) {}
      }
    } else if (map.getLayer(SAT_LYR)) {
      try { map.setLayoutProperty(SAT_LYR, 'visibility', 'none'); } catch (_) {}
    }
  }
  satBtn && satBtn.addEventListener('click', () => setSat(!satOn));

  let hintEl = null;
  function showHint(txt) {
    if (!hintEl) { hintEl = document.createElement('div'); hintEl.className = 'sg-empty-hint'; document.body.appendChild(hintEl); }
    hintEl.textContent = txt; hintEl.hidden = false;
  }
  function hideHint() { if (hintEl) hintEl.hidden = true; }

  // ── Tooltip de survol de cellule (identique à la carte de base : .grid-cell-tooltip) ──
  let sgTipEl = null;
  function ensureSgTip() {
    if (sgTipEl && sgTipEl.isConnected) return sgTipEl;
    const el = document.createElement('div');
    el.className = 'grid-cell-tooltip';
    el.setAttribute('aria-hidden', 'true');
    (map.getContainer() || document.body).appendChild(el);
    sgTipEl = el;
    return el;
  }
  function sgRampColor(q) {
    if (q <= COLOR_STOPS[0]) return COLOR_STOPS[1];
    for (let i = 2; i < COLOR_STOPS.length; i += 2) { if (q <= COLOR_STOPS[i]) return COLOR_STOPS[i + 1]; }
    return COLOR_STOPS[COLOR_STOPS.length - 1];
  }
  function onSgEnter() { if (!sgIsTouch()) map.getCanvas().style.cursor = 'pointer'; }
  function onSgLeave() { if (map.getCanvas()) map.getCanvas().style.cursor = ''; if (sgTipEl) sgTipEl.classList.remove('is-visible'); }
  function sgIsTouch() { try { return window.matchMedia('(hover: none), (pointer: coarse)').matches; } catch (_) { return false; } }
  // Rend + positionne le tooltip cellule (design .grid-cell-tooltip de la carte de base)
  // pour la cellule i, au point écran pt. Utilisé au SURVOL (desktop) et au TAP (tactile).
  function showSgTip(i, pt) {
    if (!(i >= 0) || !data || !data.cells[i]) { onSgLeave(); return; }
    const el = ensureSgTip();
    if (degraded) {
      const dk = data.darkness[i], col = sgRampColor(dk);
      el.style.setProperty('--gct-score', col);
      el.innerHTML =
        '<span class="gct-head"><b>Obscurité</b><strong style="color:' + col + '">' + dk + '</strong></span>' +
        '<span class="gct-row"><b>Pollution lum.</b><span class="gct-val">' + (100 - dk) + '<span class="gct-unit">/100</span></span></span>';
    } else {
      const sc = data.scores[cursor] ? data.scores[cursor][i] : null;
      if (sc == null) { onSgLeave(); return; }
      const cl = data.cloud[cursor] ? data.cloud[cursor][i] : null;
      const bh = bestDarkHour ? bestDarkHour[i] : null;
      const col = sgRampColor(sc);
      el.style.setProperty('--gct-score', col);
      el.innerHTML =
        '<span class="gct-head"><b>Qualité</b><strong style="color:' + col + '">' + sc + '</strong></span>' +
        '<span class="gct-row"><b>Obscurité</b><span class="gct-val">' + data.darkness[i] + '<span class="gct-unit">/100</span></span></span>' +
        '<span class="gct-row"><b>Nuages</b><span class="gct-val">' + (cl != null ? Math.round(cl) : '—') + '<span class="gct-unit"> %</span></span></span>' +
        '<span class="gct-row"><b>Meilleur créneau</b><span class="gct-val">' + (bh != null ? String(bh).padStart(2, '0') + '<span class="gct-unit"> h</span>' : '—') + '</span></span>';
    }
    const cont = map.getContainer();
    const cw = cont ? cont.clientWidth : 0, ch = cont ? cont.clientHeight : 0;
    const tw = el.offsetWidth || 140, th = el.offsetHeight || 74;
    const left = (pt.x + 16 + tw > cw) ? pt.x - 16 - tw : pt.x + 16;
    const top = (pt.y + 16 + th > ch) ? pt.y - 16 - th : pt.y + 16;
    el.style.left = Math.max(4, left) + 'px';
    el.style.top = Math.max(4, top) + 'px';
    el.classList.add('is-visible');
  }
  // Desktop : SURVOL → tooltip. (Au tactile, rien au mousemove — cf. tap.)
  function onSgMove(e) {
    if (sgIsTouch() || !data) return;
    const f = e.features && e.features[0];
    const i = f ? Number(f.properties.idx) : -1;
    if (!(i >= 0) || !data.cells[i]
        || (typeof pointInFranceGridMask === 'function' && e.lngLat && !pointInFranceGridMask(e.lngLat.lng, e.lngLat.lat))) {
      onSgLeave();
      return;
    }
    showSgTip(i, e.point || { x: 0, y: 0 });
  }

  // ── Interaction carte ───────────────────────────────────────────────────────
  function ensurePopup() {
    if (!popup) popup = new maplibregl.Popup({ className: 'stargaze-popup', closeButton: true, closeOnClick: true, maxWidth: '280px', offset: 12 });
    return popup;
  }

  // Mobile/tablette : TAP sur une cellule → tooltip (le survol n'existe pas au tactile).
  // Le popup de clic .stargaze-popup est RETIRÉ (item Trello UI/UX) : l'info de cellule
  // passe UNIQUEMENT par le tooltip .grid-cell-tooltip (survol desktop / tap tactile).
  function onSgTap(e) {
    if (!sgIsTouch() || !data) return;
    const box = [[e.point.x - 12, e.point.y - 12], [e.point.x + 12, e.point.y + 12]];
    let feats = [];
    try { feats = map.queryRenderedFeatures(box, { layers: [QUALITY_LYR] }); } catch (_) {}
    const i = feats.length ? Number(feats[0].properties.idx) : -1;
    if (i >= 0) showSgTip(i, e.point); else onSgLeave();
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
          const bh = bestDarkHour[p.i];
          const hourTxt = (bh != null) ? ' · ' + String(bh).padStart(2, '0') + ' h' : '';
          html += '<li><span>' + Math.round(p.km) + ' km ' + brg + hourTxt + '</span><strong>' + p.s + '/100</strong></li>';
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
    setStargazeMapTint(true);
    if (ensureLayers()) { hideGrid(true); setLayersVisible(true); }
    else {
      const retry = () => { if (!active) return; if (ensureLayers()) { hideGrid(true); setLayersVisible(true); paintHour(cursor); } else window.setTimeout(retry, 250); };
      window.setTimeout(retry, 250);
    }
    if (!clickBound) {
      map.on('click', onSgTap);
      map.on('mousemove', QUALITY_LYR, onSgMove);
      map.on('mouseenter', QUALITY_LYR, onSgEnter);
      map.on('mouseleave', QUALITY_LYR, onSgLeave);
      clickBound = true;
    }
    await loadData();
  }

  function deactivate() {
    if (!active) return;
    active = false;
    stop();
    viewNight = 0;
    setSat(false);
    if (nightPrevBtn) nightPrevBtn.hidden = true;
    if (nightNextBtn) nightNextBtn.hidden = true;
    if (slotsEl) slotsEl.classList.remove('sg-night-static');
    if (retryTimer) { window.clearTimeout(retryTimer); retryTimer = null; }
    degraded = false;
    toggleBtn.classList.remove('active');
    toggleBtn.setAttribute('aria-pressed', 'false');
    controls.setAttribute('aria-hidden', 'true');
    if (topInfo) topInfo.setAttribute('aria-hidden', 'true');
    document.body.classList.remove('stargaze-mode');
    setStargazeMapTint(false);
    setLayersVisible(false);
    try { map.getSource(QUALITY_SRC) && map.getSource(QUALITY_SRC).setData(EMPTY_FC); } catch (_) {}
    try { map.getSource(TOP_SRC) && map.getSource(TOP_SRC).setData(EMPTY_FC); } catch (_) {}
    if (layersReady) hideGrid(false);
    if (clickBound) {
      map.off('click', onSgTap);
      map.off('mousemove', QUALITY_LYR, onSgMove);
      map.off('mouseenter', QUALITY_LYR, onSgEnter);
      map.off('mouseleave', QUALITY_LYR, onSgLeave);
      clickBound = false;
    }
    onSgLeave();
    if (popup) { popup.remove(); }
    if (userMarker) { userMarker.remove(); userMarker = null; }
    hideAgenda();
    hideHint();
  }

  // ── Agenda astro de l'année (item Trello) ─────────────────────────────────
  // Almanach mensuel navigable : lever/coucher Soleil + Lune + phase par jour
  // calendaire local (centre France). Données /api/stargaze/agenda, chargées au
  // premier appui puis gardées (statiques pour l'année).
  const agendaBtn = document.getElementById('sgAgendaBtn');
  const agendaPanel = document.getElementById('sgAgendaPanel');
  const agendaTitle = document.getElementById('sgAgendaTitle');
  const agendaBody = document.getElementById('sgAgendaBody');
  const agendaPrev = document.getElementById('sgAgendaPrev');
  const agendaNext = document.getElementById('sgAgendaNext');
  const agendaCloseBtn = document.getElementById('sgAgendaClose');
  const MONTHS_FR = ['janvier', 'février', 'mars', 'avril', 'mai', 'juin', 'juillet',
    'août', 'septembre', 'octobre', 'novembre', 'décembre'];
  let agendaData = null, agendaMonth = new Date().getMonth(), agendaLoading = false;

  function agendaOpenState() { return !!(agendaPanel && !agendaPanel.hidden); }
  function fmtEvent(z) { return z ? fmtHMz(z) : '—'; }

  function renderAgenda() {
    if (!agendaData || !agendaTitle || !agendaBody) return;
    const y = agendaData.year;
    agendaTitle.textContent = MONTHS_FR[agendaMonth].charAt(0).toUpperCase() + MONTHS_FR[agendaMonth].slice(1) + ' ' + y;
    if (agendaPrev) agendaPrev.disabled = agendaMonth <= 0;
    if (agendaNext) agendaNext.disabled = agendaMonth >= 11;
    const now = new Date();
    const todayIso = now.getFullYear() + '-' + String(now.getMonth() + 1).padStart(2, '0') + '-' + String(now.getDate()).padStart(2, '0');
    const mm = String(agendaMonth + 1).padStart(2, '0');
    const rows = [];
    for (const d of agendaData.days) {
      if (!d.date || !d.date.startsWith(y + '-' + mm)) continue;
      const wd = new Date(d.date + 'T12:00:00').toLocaleDateString('fr-FR', { weekday: 'short' });
      const cls = 'sg-a-row' + (d.date === todayIso ? ' is-today' : '')
        + (d.moon_illumination <= 0.05 ? ' is-newmoon' : '');
      rows.push('<div class="' + cls + '">'
        + '<span class="sg-a-day">' + esc(wd) + ' ' + Number(d.date.slice(8)) + '</span>'
        + '<span>' + fmtEvent(d.sunrise_utc) + '</span><span>' + fmtEvent(d.sunset_utc) + '</span>'
        + '<span>' + fmtEvent(d.moonrise_utc) + '</span><span>' + fmtEvent(d.moonset_utc) + '</span>'
        + '<span class="sg-a-phase" title="' + esc(d.moon_phase) + '">'
        + '<span class="sg-moon-icon sg-a-moonicon" style="--sg-illum:' + Number(d.moon_illumination || 0) + '"></span>'
        + Math.round((d.moon_illumination || 0) * 100) + ' %</span>'
        + '</div>');
    }
    agendaBody.innerHTML = rows.join('');
    const t = agendaBody.querySelector('.is-today');
    if (t) t.scrollIntoView({ block: 'center' });
    else agendaBody.scrollTop = 0;
  }

  async function toggleAgenda() {
    if (!agendaPanel) return;
    if (agendaOpenState()) { hideAgenda(); return; }
    agendaPanel.hidden = false;
    agendaBtn && agendaBtn.setAttribute('aria-expanded', 'true');
    if (!agendaData) {
      agendaBody.innerHTML = '<div class="sg-a-loading">Calcul de l’éphéméride…</div>';
      if (!agendaLoading) {
        agendaLoading = true;
        try {
          const d = await (await fetch('/api/stargaze/agenda')).json();
          if (d && d.ok && Array.isArray(d.days)) agendaData = d;
        } catch (_) {}
        agendaLoading = false;
      }
      if (!agendaData) { agendaBody.innerHTML = '<div class="sg-a-loading">Agenda indisponible.</div>'; return; }
      agendaMonth = new Date().getMonth();
    }
    renderAgenda();
  }

  function hideAgenda() {
    if (!agendaPanel || agendaPanel.hidden) return;
    agendaPanel.hidden = true;
    agendaBtn && agendaBtn.setAttribute('aria-expanded', 'false');
  }

  nightPrevBtn && nightPrevBtn.addEventListener('click', () => stepNight(-1));
  nightNextBtn && nightNextBtn.addEventListener('click', () => stepNight(1));
  agendaBtn && agendaBtn.addEventListener('click', toggleAgenda);
  agendaCloseBtn && agendaCloseBtn.addEventListener('click', hideAgenda);
  agendaPrev && agendaPrev.addEventListener('click', () => { if (agendaMonth > 0) { agendaMonth--; renderAgenda(); } });
  agendaNext && agendaNext.addEventListener('click', () => { if (agendaMonth < 11) { agendaMonth++; renderAgenda(); } });

  toggleBtn.addEventListener('click', () => { active ? deactivate() : activate(); });
  playBtn && playBtn.addEventListener('click', play);
  geoBtn && geoBtn.addEventListener('click', autourDeMoi);
  // Poignée de repli de la frise (réutilise le helper générique défini par chase.js).
  if (typeof window.setupFriseCollapse === 'function') {
    window.setupFriseCollapse(controls, document.getElementById('stargazeToggleBtn'), 'storm_stargaze_collapsed');
  }
  // Échap : ferme d'abord l'agenda s'il est ouvert, sinon quitte le mode.
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape' || !active) return;
    if (agendaOpenState()) { hideAgenda(); return; }
    deactivate();
  });

  window.toggleStargazeMode = () => { active ? deactivate() : activate(); };
  window.exitStargazeMode = () => { if (active) deactivate(); };
  window.__stargazeV = '1.3.63';
})();
