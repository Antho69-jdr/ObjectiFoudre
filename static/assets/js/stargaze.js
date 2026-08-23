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
  const bestBtn = document.getElementById('sgBestBtn');
  const layersBtn = document.getElementById('sgLayersBtn');
  const layersPanel = document.getElementById('sgLayersPanel');
  const legendEl = document.getElementById('stargazeLegend');   // ruban légende (rail gauche)
  const PLAY_SVG = '<svg class="icon-svg" viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"></circle><path d="M10 8.2 16.3 12 10 15.8Z" fill="currentColor" stroke="none"></path></svg>';
  const PAUSE_SVG = '<svg class="icon-svg" viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"></circle><rect x="9" y="8.3" width="2.2" height="7.4" rx="0.6" fill="currentColor" stroke="none"></rect><rect x="12.8" y="8.3" width="2.2" height="7.4" rx="0.6" fill="currentColor" stroke="none"></rect></svg>';

  const QUALITY_SRC = 'sg-quality-src', QUALITY_LYR = 'sg-quality';
  // « Meilleures cellules » de l'HEURE affichée : liseré ambre pulsatile qui souligne
  // les cellules les mieux notées au créneau courant (suit le curseur, plus « meilleure
  // heure de la nuit »). Remplace les anciens points « top spots ». On/off via #sgBestBtn.
  const BEST_SRC = 'sg-best-src', BEST_GLOW = 'sg-best-glow', BEST_LINE = 'sg-best-line';
  // « Autour de moi » (item 3) : anneau de rayon + surlignage des meilleures cellules dans le rayon.
  const GEO_RING_SRC = 'sg-geo-ring-src', GEO_RING_FILL = 'sg-geo-ring-fill', GEO_RING_LINE = 'sg-geo-ring-line';
  const GEO_HI_SRC = 'sg-geo-hi-src', GEO_HI_GLOW = 'sg-geo-hi-glow', GEO_HI_LINE = 'sg-geo-hi-line';
  const BEST_SEP_DEG = 0.33;    // dédoublonnage spatial (spots distincts) ≈ 35 km
  // Sensibilité du liseré (item 1) : presets pilotant le seuil RELATIF (pts sous le meilleur du
  // créneau), le seuil ABSOLU et le NB MAX de cellules. Réglable (panneau Couches), persisté.
  const SG_BEST_PRESETS = {
    strict: { rel: 8,  min: 30, max: 6 },
    normal: { rel: 15, min: 20, max: 12 },
    large:  { rel: 25, min: 12, max: 20 },
  };
  let bestSensKey = 'normal';
  try { const _bs = localStorage.getItem('sg_best_sens'); if (_bs && SG_BEST_PRESETS[_bs]) bestSensKey = _bs; } catch (_) {}
  // ── « Couches » (item Trello « masques ») : le champ de qualité SE RECOLORE selon le
  //    score des SEULS critères cochés (multi-sélection superposable). Rien coché = score
  //    global. Critères : pollution lumineuse (obscurité) · Lune (selon lever/coucher) ·
  //    nébulosité par couche (basses/moyennes/hautes). Bouton #sgLayersBtn → #sgLayersPanel.
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
  // Rampe « pollution lumineuse » (INVERSÉE v1.3.175, mockup validé par Anthony) : médiocre =
  // ambre pâle incandescent (halo de ville) → excellent = noir profond (ciel noir). La logique
  // colle à une carte de pollution lumineuse : ce qui « brille » = mauvais coin d'observation.
  const COLOR_STOPS = [12, '#fdf3d0', 30, '#f4cf6b', 48, '#e0a52f', 62, '#b0741a', 74, '#6e4512', 84, '#2e1e0c', 92, '#100c08'];
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
  // « Autour de moi » : position géolocalisée + rayon (persisté) + refs DOM de la feuille.
  let geoPos = null, geoRadius = 50, geoSheetEls = null;
  try { const _gr = parseInt(localStorage.getItem('sg_geo_radius'), 10); if (_gr >= 20 && _gr <= 150) geoRadius = _gr; } catch (_) {}
  let degraded = false, retryTimer = null;     // repli « obscurité seule » quand la météo AROME manque
  let qualityFC = null;                        // géométrie des cellules construite UNE fois (scores q0..qN en props)
  let clippedCells = null;                     // coords de chaque cellule ROGNÉE à la France (statique → cache)
  let bestDark = null, bestDarkHour = null;   // meilleur score/heure sur les heures sombres, par cellule
  let bestCellsOn = true;                     // liseré « meilleures cellules » du créneau (on/off)
  let cellGeomByIdx = null;                   // idx cellule → géométrie rognée (pour le liseré)
  let pulseRAF = null, pulseLast = 0;         // animation du liseré pulsatile
  let layerSel = { light: false, moon: false, cloudLo: false, cloudMi: false, cloudHi: false };
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
  function indexCellGeom(cells) {   // idx cellule → géométrie rognée (liseré meilleures cellules)
    cellGeomByIdx = {};
    for (const c of cells) cellGeomByIdx[c.i] = c.geom;
  }
  function computeClippedCells() {
    if (clippedCells && clippedCells._n === data.cells.length) {
      if (!cellGeomByIdx) indexCellGeom(clippedCells);
      return clippedCells;
    }
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
    indexCellGeom(out);
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
        // nébulosité par couche (couches « Couches ») — recoloration par critères cochés
        const lo = (data.cloud_low && data.cloud_low[h]) ? data.cloud_low[h][i] : null;
        const mi = (data.cloud_mid && data.cloud_mid[h]) ? data.cloud_mid[h][i] : null;
        const hg = (data.cloud_high && data.cloud_high[h]) ? data.cloud_high[h][i] : null;
        if (lo != null) props['clo' + h] = lo;
        if (mi != null) props['cmi' + h] = mi;
        if (hg != null) props['chi' + h] = hg;
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

  // ── « Couches » : recolore le champ selon le score des SEULS critères cochés ──
  function anyLayer() {
    const s = layerSel;
    return s.light || s.moon || s.cloudLo || s.cloudMi || s.cloudHi;
  }
  // Score des critères cochés (multi-sélection superposable = PRODUIT des facteurs),
  // même rampe de couleur que le champ global. Facteurs : site (obscurité), Lune (phase,
  // uniforme), ciel dégagé = 1 − nébulosité des couches cochées (cirrus pondéré 0,60).
  function factorScoreColorExpr(hi) {
    const s = layerSel;
    const site = s.light ? ['/', ['coalesce', ['get', 'dk'], 0], 100] : 1;
    // Facteur Lune SELON L'HEURE (lever/coucher) : la Lune ne pollue que levée. Intensité =
    // illumination × présence au-dessus de l'horizon → couchée = 1 (aucun impact), pleine
    // lune haute ≈ 0,55. moon_alt fourni par /tonight (hours[].moon_alt).
    let moon = 1;
    if (s.moon) {
      const h = hours[hi];
      const illum = (data.moon && data.moon.illumination != null) ? data.moon.illumination : 0.5;
      const alt = (h && h.moon_alt != null) ? h.moon_alt : -90;
      const presence = Math.max(0, Math.min(1, (alt + 2) / 22));   // 0 sous l'horizon → 1 haut dans le ciel
      moon = 1 - 0.45 * illum * presence;
    }
    const cloudTerms = [];
    if (s.cloudLo) cloudTerms.push(['coalesce', ['get', 'clo' + hi], 0]);
    if (s.cloudMi) cloudTerms.push(['coalesce', ['get', 'cmi' + hi], 0]);
    if (s.cloudHi) cloudTerms.push(['*', ['coalesce', ['get', 'chi' + hi], 0], 0.6]);
    let clear = 1;
    if (cloudTerms.length === 1) clear = ['-', 1, ['/', cloudTerms[0], 100]];
    else if (cloudTerms.length > 1) clear = ['-', 1, ['/', ['max'].concat(cloudTerms), 100]];
    const score = ['max', 0, ['min', 100, ['*', 100, site, clear, moon]]];
    return ['interpolate', ['linear'], score].concat(COLOR_STOPS);
  }

  function applyLayers() { paintHour(cursor); syncLayersUI(); }
  function toggleLayer(key) { layerSel[key] = !layerSel[key]; applyLayers(); }
  function openLayersPanel(open) {
    if (!layersPanel) return;
    layersPanel.hidden = !open;
    if (layersBtn) layersBtn.setAttribute('aria-expanded', open ? 'true' : 'false');
  }
  function syncLayersUI() {
    if (layersBtn) { const on = anyLayer(); layersBtn.classList.toggle('active', on); layersBtn.setAttribute('aria-pressed', on ? 'true' : 'false'); }
    if (!layersPanel) return;
    const set = (id, on) => { const el = document.getElementById(id); if (el) { el.classList.toggle('is-checked', on); el.setAttribute('aria-checked', on ? 'true' : 'false'); } };
    set('sgLayerLight', layerSel.light);
    set('sgLayerMoon', layerSel.moon);
    set('sgLayerCloudLo', layerSel.cloudLo);
    set('sgLayerCloudMi', layerSel.cloudMi);
    set('sgLayerCloudHi', layerSel.cloudHi);
    set('sgLayerCloud', layerSel.cloudLo || layerSel.cloudMi || layerSel.cloudHi);
  }

  // Meilleures cellules DE L'HEURE hi : géométries rognées à souligner d'un liseré.
  // Sélection : cellules à moins de BEST_REL_DROP pts du meilleur score du créneau (et
  // ≥ BEST_MIN_ABS), triées, dédoublonnées spatialement → une poignée de spots distincts.
  function bestCellsFC(hi) {
    if (degraded || !data || !data.scores || !data.scores[hi] || !cellGeomByIdx) return EMPTY_FC;
    const row = data.scores[hi];
    let mx = 0;
    for (const s of row) { if (s != null && s > mx) mx = s; }
    const P = SG_BEST_PRESETS[bestSensKey] || SG_BEST_PRESETS.normal;
    const floor = Math.max(P.min, mx - P.rel);
    const cand = [];
    for (let i = 0; i < row.length; i++) {
      const s = row[i];
      if (s == null || s < floor || !cellGeomByIdx[i] || !data.cells[i]) continue;
      cand.push({ i, s, lon: data.cells[i].lon, lat: data.cells[i].lat });
    }
    if (!cand.length) return EMPTY_FC;
    cand.sort((a, b) => b.s - a.s);
    const picks = [];
    for (const c of cand) {
      const cl = Math.cos(c.lat * Math.PI / 180);
      if (picks.some((p) => Math.abs(p.lat - c.lat) < BEST_SEP_DEG && Math.abs(p.lon - c.lon) * cl < BEST_SEP_DEG)) continue;
      picks.push(c);
      if (picks.length >= P.max) break;
    }
    return { type: 'FeatureCollection', features: picks.map((p) => ({
      type: 'Feature', properties: { idx: p.i, score: p.s }, geometry: cellGeomByIdx[p.i] })) };
  }

  // (Re)peuple la source du liseré pour le curseur courant (vidée si off/dégradé).
  function updateBestLayer() {
    if (!map || !map.getSource(BEST_SRC)) return;
    const fc = (bestCellsOn && !degraded) ? bestCellsFC(cursor) : EMPTY_FC;
    try { map.getSource(BEST_SRC).setData(fc); } catch (_) {}
  }

  // Liseré PULSATILE : anime opacité/épaisseur en sinus tant que le mode est actif.
  // Throttlé ~22 fps (le battement n'a pas besoin de 60 fps → carte plus au repos).
  function pulseTick(t) {
    if (!active || !bestCellsOn) { pulseRAF = null; return; }
    if (t - pulseLast >= 45) {
      pulseLast = t;
      const k = 0.5 + 0.5 * Math.sin(t / 1000 * 2.2);   // battement ~1,4 s
      try {
        if (map.getLayer(BEST_GLOW)) {
          map.setPaintProperty(BEST_GLOW, 'line-opacity', 0.24 + 0.44 * k);
          map.setPaintProperty(BEST_GLOW, 'line-width', 6.5 + 6.5 * k);
        }
        if (map.getLayer(BEST_LINE)) map.setPaintProperty(BEST_LINE, 'line-opacity', 0.68 + 0.32 * k);
      } catch (_) {}
    }
    pulseRAF = requestAnimationFrame(pulseTick);
  }
  function startPulse() { if (pulseRAF == null) { pulseLast = 0; pulseRAF = requestAnimationFrame(pulseTick); } }
  function stopPulse() { if (pulseRAF != null) { cancelAnimationFrame(pulseRAF); pulseRAF = null; } }

  function setBestCells(on) {
    bestCellsOn = on;
    if (bestBtn) { bestBtn.classList.toggle('active', on); bestBtn.setAttribute('aria-pressed', on ? 'true' : 'false'); }
    [BEST_GLOW, BEST_LINE].forEach((id) => {
      if (map.getLayer(id)) { try { map.setLayoutProperty(id, 'visibility', (on && active) ? 'visible' : 'none'); } catch (_) {} }
    });
    updateBestLayer();
    if (on && active) startPulse(); else stopPulse();
  }
  // Sensibilité du liseré (presets strict/normal/large) : persiste + re-rend le liseré.
  function setBestSens(key) {
    if (!SG_BEST_PRESETS[key]) return;
    bestSensKey = key;
    try { localStorage.setItem('sg_best_sens', key); } catch (_) {}
    syncBestSensUI();
    updateBestLayer();
  }
  function syncBestSensUI() {
    const box = document.getElementById('sgBestSens');
    if (!box) return;
    box.querySelectorAll('.sg-sens-chip').forEach((c) => {
      const on = c.getAttribute('data-sens') === bestSensKey;
      c.classList.toggle('is-on', on);
      c.setAttribute('aria-pressed', on ? 'true' : 'false');
    });
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
    // Liseré « meilleures cellules » AU-DESSUS de tout : halo large flou + trait net.
    // line sur des polygones = contour de la cellule (MapLibre trace les anneaux).
    if (!map.getSource(BEST_SRC)) map.addSource(BEST_SRC, { type: 'geojson', data: EMPTY_FC });
    if (!map.getLayer(BEST_GLOW)) map.addLayer({ id: BEST_GLOW, type: 'line', source: BEST_SRC,
      layout: { 'line-join': 'round', 'line-cap': 'round' },
      paint: { 'line-color': '#f5b942', 'line-width': 9, 'line-blur': 6, 'line-opacity': 0.5 } });
    if (!map.getLayer(BEST_LINE)) map.addLayer({ id: BEST_LINE, type: 'line', source: BEST_SRC,
      layout: { 'line-join': 'round', 'line-cap': 'round' },
      paint: { 'line-color': '#ffe9b0', 'line-width': 2.4, 'line-opacity': 0.95 } });
    // « Autour de moi » : anneau de rayon (cyan) + surlignage des meilleures cellules dans le rayon.
    if (!map.getSource(GEO_RING_SRC)) map.addSource(GEO_RING_SRC, { type: 'geojson', data: EMPTY_FC });
    if (!map.getLayer(GEO_RING_FILL)) map.addLayer({ id: GEO_RING_FILL, type: 'fill', source: GEO_RING_SRC,
      paint: { 'fill-color': '#7dd3fc', 'fill-opacity': 0.06 } });
    if (!map.getLayer(GEO_RING_LINE)) map.addLayer({ id: GEO_RING_LINE, type: 'line', source: GEO_RING_SRC,
      paint: { 'line-color': '#7dd3fc', 'line-width': 2, 'line-dasharray': [2, 2], 'line-opacity': 0.9 } });
    if (!map.getSource(GEO_HI_SRC)) map.addSource(GEO_HI_SRC, { type: 'geojson', data: EMPTY_FC });
    if (!map.getLayer(GEO_HI_GLOW)) map.addLayer({ id: GEO_HI_GLOW, type: 'line', source: GEO_HI_SRC,
      layout: { 'line-join': 'round', 'line-cap': 'round' },
      paint: { 'line-color': '#f5b942', 'line-width': 9, 'line-blur': 6, 'line-opacity': 0.5 } });
    if (!map.getLayer(GEO_HI_LINE)) map.addLayer({ id: GEO_HI_LINE, type: 'line', source: GEO_HI_SRC,
      layout: { 'line-join': 'round', 'line-cap': 'round' },
      paint: { 'line-color': '#ffe9b0', 'line-width': 2.4, 'line-opacity': 0.95 } });
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
    if (map.getLayer(QUALITY_LYR)) { try { map.setLayoutProperty(QUALITY_LYR, 'visibility', on ? 'visible' : 'none'); } catch (_) {} }
    const bestVis = on && bestCellsOn;   // le liseré ne s'affiche que si le toggle est ON
    [BEST_GLOW, BEST_LINE].forEach((id) => {
      if (map.getLayer(id)) { try { map.setLayoutProperty(id, 'visibility', bestVis ? 'visible' : 'none'); } catch (_) {} }
    });
  }

  // Changement d'heure = SEULEMENT l'expression de couleur → quasi-instantané.
  // Des couches cochées → score des critères sélectionnés ; sinon score global.
  function paintHour(hi) {
    if (!map.getLayer(QUALITY_LYR)) return;
    const expr = degraded ? colorExprDk() : (anyLayer() ? factorScoreColorExpr(hi) : colorExpr(hi));
    try { map.setPaintProperty(QUALITY_LYR, 'fill-color', expr); } catch (_) {}
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
    paintHour(cursor);   // (recoloré selon les couches cochées, cf. paintHour)
    updateBestLayer();   // le liseré « meilleures cellules » suit le créneau affiché
    updateCursorUI();
    updateHourBadge();
    // NB : la modale « dôme » a son PROPRE curseur (domeFrac) → la carte ne bouge pas quand on
    // scrube la mini-frise, et inversement (choix Anthony).
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
    if (degraded) {
      updateBestLayer();   // vide (pas de scores en repli obscurité) → pas de liseré
      stopPulse();
      paintHour(0);
      // la grille AROME se précharge (ou l'API est momentanément indispo) → on réessaie.
      retryTimer = window.setTimeout(() => { if (active && viewNight === 0) loadData(); }, 90000);
    } else {
      cursor = defaultCursor();
      applyCursor(cursor);   // peint l'heure + peuple le liseré
      if (bestCellsOn) startPulse();
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
  // rendu (buildQualityFC/paintHour/updateBestLayer/renderBadge) sans le dupliquer.
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
    updateBestLayer();
    if (bestCellsOn) startPulse(); else stopPulse();
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
        const before = map.getLayer(BEST_GLOW) ? BEST_GLOW : undefined;   // sous le liseré
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
  // Couleur SÉMANTIQUE du chiffre de score (tooltip) — vert/ambre/orange, mêmes seuils que le
  // dôme (paintDome), source de vérité unique. Découplée de la rampe carte : depuis l'inversion
  // (sombre = excellent), un bon score serait quasi-noir → illisible. On code le sens, pas la teinte.
  function sgScoreColor(s) {
    return (s >= 55) ? '#7ee0a6' : (s >= 35) ? '#f4d06a' : '#e8896a';
  }
  // Bortle (échelle pollution lumineuse) depuis la pollution 0..100 (= 100 − obscurité).
  // Source de vérité PARTAGÉE tooltip ↔ dôme (item 5) : mêmes chiffres/libellés partout.
  function sgBortle(poll) {
    const lvl = Math.min(8, Math.round(poll / 13) + 1);
    const label = ['—', 'Excellent', 'Très bon', 'Rural', 'Périurbain', 'Banlieue', 'Urbain', 'Ville'][Math.min(7, Math.round(poll / 14) + 1)];
    return { lvl, label };
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
      // Repli « obscurité seule » : pas de score/nuages → on montre la pollution du site.
      const dk = data.darkness[i], b = sgBortle(Math.max(0, Math.min(100, 100 - dk))), col = sgScoreColor(dk);
      el.style.setProperty('--gct-score', col);
      el.innerHTML =
        '<span class="gct-head"><b>Obscurité</b><strong style="color:' + col + '">' + dk + '</strong></span>' +
        '<span class="gct-row"><b>Pollution</b><span class="gct-val">Bortle ' + b.lvl + '</span></span>';
    } else {
      // Mini-dôme (item 5) : mêmes champs/valeurs que la modale dôme (Qualité, Pollution = Bortle, Nébulosité, Lune).
      const sc = data.scores[cursor] ? data.scores[cursor][i] : null;
      if (sc == null) { onSgLeave(); return; }
      const cl = data.cloud[cursor] ? data.cloud[cursor][i] : null;
      const b = sgBortle(Math.max(0, Math.min(100, 100 - (data.darkness[i] || 0))));
      const m = data.moon || {};
      const moonTxt = m.phase_name ? m.phase_name : (m.illumination != null ? Math.round(m.illumination * 100) + ' %' : '—');
      const col = sgScoreColor(sc);
      el.style.setProperty('--gct-score', col);
      el.innerHTML =
        '<span class="gct-head"><b>Qualité</b><strong style="color:' + col + '">' + sc + '</strong></span>' +
        '<span class="gct-row"><b>Pollution</b><span class="gct-val">Bortle ' + b.lvl + '</span></span>' +
        '<span class="gct-row"><b>Nébulosité</b><span class="gct-val">' + (cl != null ? Math.round(cl) : '—') + '<span class="gct-unit"> %</span></span></span>' +
        '<span class="gct-row"><b>Lune</b><span class="gct-val">' + moonTxt + '</span></span>';
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
    if (sgIsTouch() || !data || !e.lngLat) return;
    // Résolution DÉTERMINISTE : cellule dont le CENTRE est le plus proche du pointeur.
    // Les cellules se chevauchent de 6 % (OVERLAP) → e.features[0] est ambigu et « saute »
    // d'une cellule à l'autre dans une même case (tooltip incohérent / décalé). sgNearestCell
    // = une seule cellule par position, identique au clic → dôme (cf. bugs #2/#3).
    if (typeof pointInFranceGridMask === 'function' && !pointInFranceGridMask(e.lngLat.lng, e.lngLat.lat)) { onSgLeave(); return; }
    const i = sgNearestCell(e.lngLat.lat, e.lngLat.lng);
    if (!(i >= 0) || !data.cells[i]) { onSgLeave(); return; }
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
  // Clic sur une cellule (desktop OU tactile) → modale « dôme céleste ».
  function onSgTap(e) {
    if (!data || !e.lngLat) return;
    if (typeof pointInFranceGridMask === 'function' && !pointInFranceGridMask(e.lngLat.lng, e.lngLat.lat)) return;
    // Confirme qu'une cellule est bien sous le clic, puis résout la MÊME cellule que le survol
    // (centre le plus proche) → tooltip et dôme parlent toujours de la même cellule (cf. bug #2).
    let feats = [];
    try { feats = map.queryRenderedFeatures([[e.point.x - 8, e.point.y - 8], [e.point.x + 8, e.point.y + 8]], { layers: [QUALITY_LYR] }); } catch (_) {}
    if (!feats.length) return;
    const i = sgNearestCell(e.lngLat.lat, e.lngLat.lng);
    if (!(i >= 0) || !data.cells[i]) return;
    const c = data.cells[i];
    openDome(i, 'Point d\'observation', `${Number(c.lat).toFixed(2)}, ${Number(c.lon).toFixed(2)}`);
    if (sgIsTouch()) onSgLeave();   // referme le tooltip tactile
  }

  // ── Autour de moi (item 3) : feuille en bas → se géolocaliser + rayon réglable ─────────────
  function ensureGeoSheet() {
    if (geoSheetEls) return geoSheetEls;
    const q = (id) => document.getElementById(id);
    const sheet = q('sgGeoSheet');
    if (!sheet) return null;
    geoSheetEls = { sheet, step1: q('sgGeoStep1'), step2: q('sgGeoStep2'), pos: q('sgGeoPos'),
      rad: q('sgGeoRad'), radVal: q('sgGeoRadVal'), results: q('sgGeoResults') };
    q('sgGeoClose').addEventListener('click', closeGeoSheet);
    q('sgGeoLocate').addEventListener('click', geoLocate);
    q('sgGeoRelocate').addEventListener('click', geoLocate);
    geoSheetEls.rad.value = String(geoRadius);
    geoSheetEls.radVal.textContent = geoRadius + ' km';
    geoSheetEls.rad.addEventListener('input', (e) => {
      geoRadius = parseInt(e.target.value, 10) || 50;
      geoSheetEls.radVal.textContent = geoRadius + ' km';
      try { localStorage.setItem('sg_geo_radius', String(geoRadius)); } catch (_) {}
      geoApply();
    });
    return geoSheetEls;
  }
  // Le bouton géoloc ouvre D'ABORD la feuille (choix Anthony : layout « feuille en bas »).
  function autourDeMoi() {
    const e = ensureGeoSheet(); if (!e) return;
    e.sheet.hidden = false;
    e.step1.hidden = !!geoPos; e.step2.hidden = !geoPos;   // rouvre sur les résultats si déjà localisé
    if (geoPos) geoApply();
  }
  function closeGeoSheet() { if (geoSheetEls) geoSheetEls.sheet.hidden = true; geoClearMap(); }
  function geoClearMap() {
    try { map.getSource(GEO_RING_SRC) && map.getSource(GEO_RING_SRC).setData(EMPTY_FC); } catch (_) {}
    try { map.getSource(GEO_HI_SRC) && map.getSource(GEO_HI_SRC).setData(EMPTY_FC); } catch (_) {}
    if (userMarker) { userMarker.remove(); userMarker = null; }
  }
  function geoLocate() {
    if (!navigator.geolocation) { showHint('Géolocalisation indisponible.'); window.setTimeout(hideHint, 2500); return; }
    const cta = document.getElementById('sgGeoLocate'); cta && cta.classList.add('is-loading');
    geoBtn && geoBtn.classList.add('active');
    navigator.geolocation.getCurrentPosition((pos) => {
      geoBtn && geoBtn.classList.remove('active'); cta && cta.classList.remove('is-loading');
      geoPos = { lat: pos.coords.latitude, lng: pos.coords.longitude };
      const e = ensureGeoSheet();
      if (e) { e.step1.hidden = true; e.step2.hidden = false; e.pos.textContent = geoPos.lat.toFixed(3) + ', ' + geoPos.lng.toFixed(3); }
      map.flyTo({ center: [geoPos.lng, geoPos.lat], zoom: 7.4, duration: 900 });
      geoApply();
    }, () => {
      geoBtn && geoBtn.classList.remove('active'); cta && cta.classList.remove('is-loading');
      showHint('Localisation refusée.'); window.setTimeout(hideHint, 2500);
    }, { enableHighAccuracy: false, timeout: 8000, maximumAge: 60000 });
  }
  // Cercle GeoJSON (rayon km) autour d'un point — 64 sommets (formule grand-cercle).
  function geoCircle(lat, lng, km) {
    const pts = [], d = km / 6371, la = lat * Math.PI / 180, lo = lng * Math.PI / 180;
    for (let i = 0; i <= 64; i++) {
      const b = (i / 64) * 2 * Math.PI;
      const la2 = Math.asin(Math.sin(la) * Math.cos(d) + Math.cos(la) * Math.sin(d) * Math.cos(b));
      const lo2 = lo + Math.atan2(Math.sin(b) * Math.sin(d) * Math.cos(la), Math.cos(d) - Math.sin(la) * Math.sin(la2));
      pts.push([lo2 * 180 / Math.PI, la2 * 180 / Math.PI]);
    }
    return { type: 'FeatureCollection', features: [{ type: 'Feature', properties: {}, geometry: { type: 'Polygon', coordinates: [pts] } }] };
  }
  // Anneau + surlignage des meilleures cellules du rayon + liste (spots puis cellules).
  function geoApply() {
    if (!geoPos || !geoSheetEls) return;
    const lat = geoPos.lat, lng = geoPos.lng, cl = Math.cos(lat * Math.PI / 180);
    if (userMarker) userMarker.remove();
    const dot = document.createElement('div'); dot.className = 'sg-user-dot';
    userMarker = new maplibregl.Marker({ element: dot }).setLngLat([lng, lat]).addTo(map);
    try { map.getSource(GEO_RING_SRC) && map.getSource(GEO_RING_SRC).setData(geoCircle(lat, lng, geoRadius)); } catch (_) {}
    // meilleures cellules dans le rayon (bestDark = score robuste, marche aussi en dégradé)
    const cand = [];
    if (data && data.cells && bestDark) {
      for (let i = 0; i < data.cells.length; i++) {
        const s = bestDark[i]; if (s == null) continue;
        const dx = (data.cells[i].lon - lng) * cl * 111.32, dy = (data.cells[i].lat - lat) * 110.574;
        const km = Math.sqrt(dx * dx + dy * dy);
        if (km <= geoRadius) cand.push({ i, km, s });
      }
    }
    cand.sort((a, b) => b.s - a.s || a.km - b.km);
    const picks = [];
    for (const c of cand) {
      if (picks.some((p) => Math.abs(data.cells[p.i].lat - data.cells[c.i].lat) < 0.20 && Math.abs(data.cells[p.i].lon - data.cells[c.i].lon) * cl < 0.24)) continue;
      picks.push(c); if (picks.length >= 6) break;
    }
    const hiFeats = picks.filter((p) => p.s >= 55 && cellGeomByIdx && cellGeomByIdx[p.i])
      .map((p) => ({ type: 'Feature', properties: { idx: p.i }, geometry: cellGeomByIdx[p.i] }));
    try { map.getSource(GEO_HI_SRC) && map.getSource(GEO_HI_SRC).setData({ type: 'FeatureCollection', features: hiFeats }); } catch (_) {}
    // spots dans le rayon (cellules + spots = choix Anthony)
    let spots = [];
    try { spots = (window.ObjectiFoudreSpots && window.ObjectiFoudreSpots.list) ? window.ObjectiFoudreSpots.list() : []; } catch (_) {}
    const spotsIn = spots.filter((sp) => {
      const dx = (Number(sp.lon) - lng) * cl * 111.32, dy = (Number(sp.lat) - lat) * 110.574;
      sp._km = Math.sqrt(dx * dx + dy * dy); return isFinite(sp._km) && sp._km <= geoRadius;
    }).sort((a, b) => a._km - b._km);
    let html = '';
    if (!picks.length && !spotsIn.length) {
      html = '<p class="sg-geo-empty">Aucun bon coin dans ' + geoRadius + ' km — élargis le rayon.</p>';
    } else {
      html = '<div class="sg-geo-resh">Meilleurs coins &lt; ' + geoRadius + ' km</div>';
      spotsIn.slice(0, 4).forEach((sp) => {
        const brg = bearing(lat, lng, Number(sp.lat), Number(sp.lon));
        html += '<div class="sg-geo-res"><span class="sg-geo-rk">★</span><span class="sg-geo-meta"><span class="d">' + esc(sp.name || 'Spot') + '</span><span class="s"> · ' + Math.round(sp._km) + ' km ' + brg + ' · ton spot</span></span><span class="sg-geo-sc spot">spot</span></div>';
      });
      picks.forEach((p, k) => {
        const c = data.cells[p.i], brg = bearing(lat, lng, c.lat, c.lon), bh = bestDarkHour ? bestDarkHour[p.i] : null;
        const hourTxt = (bh != null) ? ' · vers ' + String(bh).padStart(2, '0') + ' h' : '';
        html += '<div class="sg-geo-res"><span class="sg-geo-rk">' + (k + 1) + '</span><span class="sg-geo-meta"><span class="d">' + Math.round(p.km) + ' km ' + brg + '</span><span class="s">' + hourTxt + '</span></span><span class="sg-geo-sc" style="color:' + sgScoreColor(p.s) + '">' + p.s + '</span></div>';
      });
    }
    geoSheetEls.results.innerHTML = html;
  }

  function bearing(la1, lo1, la2, lo2) {
    const dLon = (lo2 - lo1) * Math.cos(((la1 + la2) / 2) * Math.PI / 180);
    const dLat = la2 - la1;
    const dirs = ['N', 'NE', 'E', 'SE', 'S', 'SO', 'O', 'NO'];
    const ang = (Math.atan2(dLon, dLat) * 180 / Math.PI + 360) % 360;
    return dirs[Math.round(ang / 45) % 8];
  }

  // ── Activation / désactivation ───────────────────────────────────────────
  // ── Modale « dôme céleste » (clic cellule / spot) ───────────────────────────
  // Voûte en demi-cercles empilés : pollution lumineuse (ambre, ras d'horizon), 3 voiles de
  // nébulosité (gris), Lune argentée (au-dessus des nuages, masquée si sous l'horizon).
  // Mockup validé par Anthony (Artifact). Données réelles : darkness / cloud_low|mid|high /
  // scores / moon (illumination + moonrise/set) + hours[cursor].moon_alt.
  const DM_NS = 'http://www.w3.org/2000/svg';
  const DM_CX = 230, DM_CY = 205, DM_R = 188, DM_R_POLL = 58, DM_MOON_R = 174;
  const DM_BANDS = { low: [58, 92], mid: [92, 124], high: [124, 156] };
  function dmPt(deg, r) { const a = deg * Math.PI / 180; return [DM_CX - r * Math.cos(a), DM_CY - r * Math.sin(a)]; }
  function dmArc(a0, a1, r) { const p0 = dmPt(a0, r), p1 = dmPt(a1, r); const large = (a1 - a0) > 180 ? 1 : 0; return `M ${p0[0].toFixed(2)} ${p0[1].toFixed(2)} A ${r} ${r} 0 ${large} 1 ${p1[0].toFixed(2)} ${p1[1].toFixed(2)}`; }
  function dmBand(rIn, rOut) {
    const oo0 = dmPt(0, rOut), oo1 = dmPt(180, rOut), ii1 = dmPt(180, rIn), ii0 = dmPt(0, rIn);
    return `M ${oo0[0].toFixed(2)} ${oo0[1].toFixed(2)} A ${rOut} ${rOut} 0 0 1 ${oo1[0].toFixed(2)} ${oo1[1].toFixed(2)}`
      + ` L ${ii1[0].toFixed(2)} ${ii1[1].toFixed(2)} A ${rIn} ${rIn} 0 0 0 ${ii0[0].toFixed(2)} ${ii0[1].toFixed(2)} Z`;
  }
  function dmEl(t, a) { const e = document.createElementNS(DM_NS, t); for (const k in a) e.setAttribute(k, a[k]); return e; }

  function renderDome(svg, d) {
    svg.innerHTML = '';
    const pollTop = DM_R_POLL + (d.poll / 100) * (DM_R - DM_R_POLL);
    const defs = dmEl('defs', {});
    defs.innerHTML =
      `<clipPath id="sgDomeClip"><path d="${dmBand(0, DM_R)} M 0 0"/></clipPath>`
      + `<radialGradient id="sgSky" cx="50%" cy="100%" r="100%"><stop offset="0%" stop-color="#16223c"/><stop offset="55%" stop-color="#0d1526"/><stop offset="100%" stop-color="#0a0f1c"/></radialGradient>`
      + `<radialGradient id="sgPoll" gradientUnits="userSpaceOnUse" cx="${DM_CX}" cy="${DM_CY}" r="${pollTop.toFixed(1)}"><stop offset="0%" stop-color="#f7c35a"/><stop offset="52%" stop-color="#eda13a"/><stop offset="82%" stop-color="#e2892f"/><stop offset="100%" stop-color="#e2892f" stop-opacity="0"/></radialGradient>`
      + `<radialGradient id="sgMoonG" cx="38%" cy="32%" r="72%"><stop offset="0%" stop-color="#e6ecf4"/><stop offset="55%" stop-color="#c7d1de"/><stop offset="100%" stop-color="#8492a6"/></radialGradient>`
      + `<filter id="sgSoft" x="-40%" y="-40%" width="180%" height="180%"><feGaussianBlur stdDeviation="2.4"/></filter>`
      + `<filter id="sgSoft2" x="-60%" y="-60%" width="220%" height="220%"><feGaussianBlur stdDeviation="4.5"/></filter>`;
    svg.appendChild(defs);
    const g = dmEl('g', { 'clip-path': 'url(#sgDomeClip)' });
    svg.appendChild(g);
    g.appendChild(dmEl('path', { d: dmBand(0, DM_R), fill: 'url(#sgSky)' }));
    // étoiles atténuées par la couverture nuageuse totale
    const cover = Math.min(1, (d.cloud.low + d.cloud.mid + d.cloud.high) / 160);
    const starG = dmEl('g', { opacity: (0.9 - 0.72 * cover).toFixed(2) });
    let seed = 7; const rnd = () => { seed = (seed * 9301 + 49297) % 233280; return seed / 233280; };
    for (let s = 0; s < 70; s++) {
      const deg = 6 + rnd() * 168, rr = DM_R_POLL + rnd() * (DM_R - DM_R_POLL - 6), p = dmPt(deg, rr);
      starG.appendChild(dmEl('circle', { cx: p[0].toFixed(1), cy: p[1].toFixed(1), r: (rnd() * 1.1 + 0.35).toFixed(2), fill: '#cfe0ff', opacity: (0.3 + rnd() * 0.6).toFixed(2) }));
    }
    g.appendChild(starG);
    // pollution lumineuse (cercle égal, transparente)
    g.appendChild(dmEl('path', { d: dmBand(0, pollTop), fill: 'url(#sgPoll)', opacity: (0.2 + 0.34 * d.poll / 100).toFixed(2), filter: 'url(#sgSoft)' }));
    // 3 voiles de nébulosité
    for (const key of ['low', 'mid', 'high']) {
      const b = DM_BANDS[key], frac = d.cloud[key] / 100;
      g.appendChild(dmEl('path', { d: dmBand(b[0], b[1]), fill: '#8b96a8', opacity: (0.06 + 0.72 * frac).toFixed(2) }));
      g.appendChild(dmEl('path', { d: dmArc(0, 180, b[1]), fill: 'none', stroke: '#0a0f1c', 'stroke-width': 1, opacity: 0.5 }));
    }
    // arc de la Lune (fondu près de l'horizon ; masqué si sous l'horizon)
    const mf = d.moon.up ? (d.moon.fade != null ? d.moon.fade : 1) : 0;
    if (mf > 0.01) g.appendChild(dmEl('path', { d: dmArc(6, 174, DM_MOON_R), fill: 'none', stroke: '#93a2ba', 'stroke-width': 1.3, 'stroke-dasharray': '2 5', opacity: (0.42 * mf).toFixed(2) }));
    // horizon + repères E/O
    const hL = dmPt(0, DM_R)[0], hR = dmPt(180, DM_R)[0];
    svg.appendChild(dmEl('line', { x1: hL, y1: DM_CY, x2: hR, y2: DM_CY, stroke: '#22304a', 'stroke-width': 1.5 }));
    svg.appendChild(dmEl('line', { x1: hL, y1: DM_CY, x2: hR, y2: DM_CY, stroke: '#f4b94222', 'stroke-width': 6 }));
    const tE = dmEl('text', { x: hL + 2, y: DM_CY + 16, fill: '#6c7d97', 'font-size': 11, 'font-weight': 600 }); tE.textContent = 'E'; svg.appendChild(tE);
    const tO = dmEl('text', { x: hR - 12, y: DM_CY + 16, fill: '#6c7d97', 'font-size': 11, 'font-weight': 600 }); tO.textContent = 'O'; svg.appendChild(tO);
    // Lune : au-dessus de l'horizon, fondue à l'apparition/disparition (groupe opacité = mf).
    if (mf > 0.01) {
      const mp = dmPt(d.moon.deg, DM_MOON_R), mx = mp[0], my = mp[1], mr = 13;
      const md = dmEl('defs', {}); md.innerHTML = `<clipPath id="sgMClip"><circle cx="${mx}" cy="${my}" r="${mr}"/></clipPath>`; svg.appendChild(md);
      const mg = dmEl('g', { opacity: mf.toFixed(2) });
      mg.appendChild(dmEl('circle', { cx: mx, cy: my, r: mr + 7, fill: '#c7d1de', opacity: 0.11, filter: 'url(#sgSoft2)' }));
      mg.appendChild(dmEl('circle', { cx: mx, cy: my, r: mr, fill: 'url(#sgMoonG)', stroke: '#dbe3ee', 'stroke-width': 0.6 }));
      // Ombre = disque décalé, clippé au disque lunaire. Décalage ∝ illumination :
      //   illum=1 (pleine) → |off|=2·mr → ombre hors du disque → tout éclairé ;
      //   illum=0 (nouvelle) → off=0 → ombre sur tout le disque → tout noir.
      // Croissante (waning=false) : éclairée à DROITE → ombre à gauche (off négatif).
      const off = d.moon.illum * 2 * mr * (d.moon.waning ? 1 : -1);
      mg.appendChild(dmEl('circle', { cx: mx + off, cy: my, r: mr, fill: '#0c1322', opacity: 0.82, 'clip-path': 'url(#sgMClip)' }));
      const cg = dmEl('g', { 'clip-path': 'url(#sgMClip)', opacity: 0.35 });
      cg.appendChild(dmEl('circle', { cx: mx - 4, cy: my - 3, r: 2.4, fill: '#93a2ba' }));
      cg.appendChild(dmEl('circle', { cx: mx + 3, cy: my + 4, r: 1.7, fill: '#93a2ba' }));
      cg.appendChild(dmEl('circle', { cx: mx + 5, cy: my - 4, r: 1.1, fill: '#93a2ba' }));
      mg.appendChild(cg);
      svg.appendChild(mg);
    }
  }

  // Construit l'objet data du dôme pour la cellule i, INTERPOLÉ à la position continue
  // `domeFrac` (entre deux créneaux) → la lune glisse, les voiles se transforment, le score
  // évolue en douceur au scrub. Le curseur du dôme est INDÉPENDANT de la carte (cursor).
  function sgDomeData(i, title, sub) {
    const n = hours.length || 1;
    const h0 = Math.max(0, Math.min(n - 1, Math.floor(domeFrac)));
    const h1 = Math.min(n - 1, h0 + 1);
    const f = domeFrac - h0;
    const lerp = (a, b) => a + (b - a) * f;
    const clAt = (key, hh) => (data[key] && data[key][hh] && data[key][hh][i] != null) ? data[key][hh][i] : 0;
    const cl = (key) => Math.round(lerp(clAt(key, h0), clAt(key, h1)));
    const scAt = (hh) => (data.scores && data.scores[hh] && data.scores[hh][i] != null) ? data.scores[hh][i] : null;
    const s0 = scAt(h0), s1 = scAt(h1);
    const score = (s0 != null && s1 != null) ? Math.round(lerp(s0, s1)) : (s0 != null ? s0 : (s1 != null ? s1 : null));
    const m = data.moon || {};
    const altAt = (hh) => (hours[hh] && hours[hh].moon_alt != null) ? hours[hh].moon_alt : -90;
    const alt = lerp(altAt(h0), altAt(h1));
    const up = alt > 0;
    const fade = Math.max(0, Math.min(1, alt / 4));   // fondu doux sur les 4 premiers degrés
    const waning = (m.age_days != null) ? (m.age_days > 14.77) : false;
    let riseMs = m.moonrise_utc ? Date.parse(m.moonrise_utc) : null;
    let setMs = m.moonset_utc ? Date.parse(m.moonset_utc) : null;
    // Si UNE seule borne est connue (l'autre tombe hors de la fenêtre de scan, ex. la Lune se
    // couche après midi le lendemain → moonset_utc absent), on estime l'autre avec la durée
    // moyenne de présence (~12,4 h). Sinon la Lune restait bloquée au zénith (deg=90).
    const MOON_UP_MS = 12.4 * 3600 * 1000;
    if (riseMs && !setMs) setMs = riseMs + MOON_UP_MS;
    else if (setMs && !riseMs) riseMs = setMs - MOON_UP_MS;
    const t0 = (hours[h0] && hours[h0].iso) ? Date.parse(hours[h0].iso) : Date.now();
    const t1 = (hours[h1] && hours[h1].iso) ? Date.parse(hours[h1].iso) : t0;
    const nowMs = lerp(t0, t1);
    let deg = 90;
    if (riseMs && setMs && setMs > riseMs) { const fr = Math.max(0, Math.min(1, (nowMs - riseMs) / (setMs - riseMs))); deg = 6 + fr * 168; }
    return {
      title, sub,
      poll: Math.max(0, Math.min(100, 100 - (data.darkness ? (data.darkness[i] || 0) : 0))),
      cloud: { low: cl('cloud_low'), mid: cl('cloud_mid'), high: cl('cloud_high') },
      score, scoreLabel: (score != null ? verdict(score) : '—'),
      moon: {
        illum: (m.illumination != null ? m.illumination : 0), name: (m.phase_name || '—'),
        up, fade, waning, deg,
        rise: (m.moonrise_utc ? fmtHMz(m.moonrise_utc) : '—'),
        set: (m.moonset_utc ? fmtHMz(m.moonset_utc) : '—'),
      },
    };
  }

  // ── Astro (onglet « Ciel » du dôme, SPOTS uniquement) : positions des astres par la
  //    méthode de Schlyter, PUR JS, sans dépendance ni réseau. Cf. .h_collect/astro_s0_sky.py.
  const SKY_RAD = Math.PI / 180, SKY_DEG = 180 / Math.PI;
  const SKY_J2000 = Date.UTC(1999, 11, 31, 0, 0, 0);
  function skyDays(ms) { return (ms - SKY_J2000) / 86400000; }
  function skyLstDeg(ms, lon) {
    const d = skyDays(ms);
    const Ms = (356.0470 + 0.9856002585 * d) % 360, ws = (282.9404 + 0.0000470935 * d) % 360;
    const g0 = ((Ms + ws) + 180) % 360, dt = new Date(ms);
    const uth = dt.getUTCHours() + dt.getUTCMinutes() / 60 + dt.getUTCSeconds() / 3600;
    return (g0 + uth * 15 + lon) % 360;
  }
  function skyAltaz(ra, dec, ms, lat, lon) {
    const ha = (skyLstDeg(ms, lon) - ra) * SKY_RAD, la = lat * SKY_RAD, de = dec * SKY_RAD;
    const alt = Math.asin(Math.max(-1, Math.min(1, Math.sin(la) * Math.sin(de) + Math.cos(la) * Math.cos(de) * Math.cos(ha))));
    const az = Math.atan2(-Math.cos(de) * Math.sin(ha), Math.sin(de) * Math.cos(la) - Math.cos(de) * Math.sin(la) * Math.cos(ha));
    return { alt: alt * SKY_DEG, az: ((az * SKY_DEG) % 360 + 360) % 360 };
  }
  function skyKepler(M, e) {
    M = ((M % 360) + 360) % 360 * SKY_RAD;
    let E = M + e * Math.sin(M) * (1 + e * Math.cos(M));
    for (let k = 0; k < 6; k++) E = E - (E - e * Math.sin(E) - M) / (1 - e * Math.cos(E));
    return E;
  }
  function skySunEcl(d) {
    const ws = 282.9404 + 4.70935e-5 * d, e = 0.016709 - 1.151e-9 * d, M = 356.0470 + 0.9856002585 * d;
    const E = skyKepler(M, e), xv = Math.cos(E) - e, yv = Math.sqrt(1 - e * e) * Math.sin(E);
    const v = Math.atan2(yv, xv) * SKY_DEG, r = Math.hypot(xv, yv), lon = ((v + ws) % 360) * SKY_RAD;
    return [r * Math.cos(lon), r * Math.sin(lon)];
  }
  const SKY_PL = {
    'Mercure': { N: [48.3313, 3.24587e-5], i: [7.0047, 5e-8], w: [29.1241, 1.01444e-5], a: [0.387098, 0], e: [0.205635, 5.59e-10], M: [168.6562, 4.0923344368] },
    'Vénus':   { N: [76.6799, 2.4659e-5], i: [3.3946, 2.75e-8], w: [54.891, 1.38374e-5], a: [0.72333, 0], e: [0.006773, -1.302e-9], M: [48.0052, 1.6021302244] },
    'Mars':    { N: [49.5574, 2.11081e-5], i: [1.8497, -1.78e-8], w: [286.5016, 2.92961e-5], a: [1.523688, 0], e: [0.093405, 2.516e-9], M: [18.6021, 0.5240207766] },
    'Jupiter': { N: [100.4542, 2.76854e-5], i: [1.303, -1.557e-7], w: [273.8777, 1.64505e-5], a: [5.20256, 0], e: [0.048498, 4.469e-9], M: [19.895, 0.0830853001] },
    'Saturne': { N: [113.6634, 2.3898e-5], i: [2.4886, -1.081e-7], w: [339.3939, 2.97661e-5], a: [9.55475, 0], e: [0.055546, -9.499e-9], M: [316.967, 0.0334442282] },
  };
  function skyPlanetRadec(name, ms) {
    const p = SKY_PL[name], d = skyDays(ms), v = (k) => p[k][0] + p[k][1] * d;
    const N = v('N'), i = v('i'), w = v('w'), a = v('a'), e = v('e'), E = skyKepler(v('M'), e);
    const xv = a * (Math.cos(E) - e), yv = a * Math.sqrt(1 - e * e) * Math.sin(E);
    const vv = Math.atan2(yv, xv), r = Math.hypot(xv, yv), u = vv + w * SKY_RAD, Nr = N * SKY_RAD, ir = i * SKY_RAD;
    const xh = r * (Math.cos(Nr) * Math.cos(u) - Math.sin(Nr) * Math.sin(u) * Math.cos(ir));
    const yh = r * (Math.sin(Nr) * Math.cos(u) + Math.cos(Nr) * Math.sin(u) * Math.cos(ir));
    const zh = r * (Math.sin(u) * Math.sin(ir));
    const su = skySunEcl(d), xg = xh + su[0], yg = yh + su[1], zg = zh, eps = (23.4393 - 3.563e-7 * d) * SKY_RAD;
    const xe = xg, ye = yg * Math.cos(eps) - zg * Math.sin(eps), ze = yg * Math.sin(eps) + zg * Math.cos(eps);
    return { ra: ((Math.atan2(ye, xe) * SKY_DEG) % 360 + 360) % 360, dec: Math.atan2(ze, Math.hypot(xe, ye)) * SKY_DEG };
  }
  const SKY_NGP_RA = 192.85948, SKY_NGP_DEC = 27.12825, SKY_L_NCP = 122.93192;
  function skyGalToRadec(l, b) {   // plan galactique → équatorial (bande de la Voie lactée)
    const lr = l * SKY_RAD, br = b * SKY_RAD, dgp = SKY_NGP_DEC * SKY_RAD, lncp = SKY_L_NCP * SKY_RAD;
    const dec = Math.asin(Math.sin(dgp) * Math.sin(br) + Math.cos(dgp) * Math.cos(br) * Math.cos(lncp - lr));
    const ra = SKY_NGP_RA * SKY_RAD + Math.atan2(Math.cos(br) * Math.sin(lncp - lr), Math.cos(dgp) * Math.sin(br) - Math.sin(dgp) * Math.cos(br) * Math.cos(lncp - lr));
    return { ra: ((ra * SKY_DEG) % 360 + 360) % 360, dec: dec * SKY_DEG };
  }
  // Étoiles brillantes NOMMÉES [nom, RA° J2000, Dec°, mag, constellation].
  const SKY_STARS = [
    ['Sirius', 101.287, -16.716, -1.46, 'Grand Chien'], ['Arcturus', 213.915, 19.182, -0.05, 'Bouvier'],
    ['Véga', 279.234, 38.784, 0.03, 'Lyre'], ['Capella', 79.172, 45.998, 0.08, 'Cocher'],
    ['Rigel', 78.634, -8.202, 0.13, 'Orion'], ['Procyon', 114.826, 5.225, 0.34, 'Petit Chien'],
    ['Bételgeuse', 88.793, 7.407, 0.42, 'Orion'], ['Altaïr', 297.696, 8.868, 0.76, 'Aigle'],
    ['Aldébaran', 68.98, 16.509, 0.85, 'Taureau'], ['Spica', 201.298, -11.161, 0.97, 'Vierge'],
    ['Antarès', 247.352, -26.432, 1.06, 'Scorpion'], ['Pollux', 116.329, 28.026, 1.14, 'Gémeaux'],
    ['Fomalhaut', 344.413, -29.622, 1.16, 'Poisson austral'], ['Deneb', 310.358, 45.28, 1.25, 'Cygne'],
    ['Régulus', 152.093, 11.967, 1.35, 'Lion'], ['Castor', 113.649, 31.888, 1.58, 'Gémeaux'],
    ['Alkaïd', 206.885, 49.313, 1.85, 'Grande Ourse'], ['Dubhe', 165.932, 61.751, 1.79, 'Grande Ourse'],
    ['Schedar', 10.127, 56.537, 2.24, 'Cassiopée'], ['Polaris', 37.954, 89.264, 1.98, 'Petite Ourse'],
    ['α Centauri', 219.902, -60.834, -0.27, 'Centaure'],
  ];
  function skyNeverRises(dec, lat) { return dec < (lat - 90); }   // ne franchit jamais l'horizon
  // Horizon (°) du spot dans la direction az, interpolé entre les azimuts LiDAR (spot.horizon.azimuths).
  function skyHorizonAt(azimuths, az) {
    if (!azimuths || !azimuths.length) return 0;
    az = ((az % 360) + 360) % 360;
    let lo = null, hi = null;
    for (const a of azimuths) {
      const d = ((a.az - az + 540) % 360) - 180;   // écart signé [-180,180]
      const h = a.horizon_deg || 0;
      if (d <= 0 && (lo === null || d > lo.d)) lo = { d, h };
      if (d >= 0 && (hi === null || d < hi.d)) hi = { d, h };
    }
    if (!lo) return hi ? hi.h : 0;
    if (!hi || lo.d === hi.d) return lo.h;
    return lo.h + (hi.h - lo.h) * ((0 - lo.d) / (hi.d - lo.d));
  }
  // Instant (ms) correspondant au curseur fractionnaire du dôme (mêmes bornes que sgDomeData).
  function skyDomeMs() {
    const n = hours.length || 1;
    const h0 = Math.max(0, Math.min(n - 1, Math.floor(domeFrac))), h1 = Math.min(n - 1, h0 + 1);
    const t0 = (hours[h0] && hours[h0].iso) ? Date.parse(hours[h0].iso) : Date.now();
    const t1 = (hours[h1] && hours[h1].iso) ? Date.parse(hours[h1].iso) : t0;
    return t0 + (t1 - t0) * (domeFrac - h0);
  }

  let sgDomeEls = null, sgDomeCurrent = null, domeFrac = 0, domeTab = 'cond';
  function ensureDomeModal() {
    if (sgDomeEls) return sgDomeEls;
    const ov = document.createElement('div');
    ov.className = 'sg-dome-ov'; ov.setAttribute('aria-hidden', 'true');
    ov.innerHTML =
      '<div class="sg-dome" role="dialog" aria-label="Conditions d\'observation" aria-modal="true">'
      + '<div class="sg-dome-head"><div><p class="sg-dome-eyebrow">Chasse d\'étoiles · cette nuit</p>'
      + '<h2 class="sg-dome-title" id="sgDomeTitle">—</h2><p class="sg-dome-sub" id="sgDomeSub"></p></div>'
      + '<button class="sg-dome-close" type="button" aria-label="Fermer">✕</button></div>'
      + '<div class="sg-dome-tabs" id="sgDomeTabs" role="tablist" hidden>'
      + '<button class="sg-dome-tab is-on" id="sgTabCond" type="button" role="tab" aria-selected="true">Conditions</button>'
      + '<button class="sg-dome-tab" id="sgTabSky" type="button" role="tab" aria-selected="false">Ciel</button></div>'
      + '<div class="sg-dome-pane" id="sgDomeCond">'
      + '<div class="sg-dome-wrap"><svg class="sg-dome-svg" id="sgDomeSvg" viewBox="0 0 460 250" role="img" aria-label="Dôme des conditions d\'observation"></svg>'
      + '<div class="sg-dome-verdict"><div class="sg-dome-score" id="sgDomeScore">—</div><div class="sg-dome-scorelbl" id="sgDomeScoreLbl">observation</div></div></div>'
      + '<div class="sg-dome-legend">'
      + '<div class="sg-dome-leg full"><div class="sg-dome-legh"><span class="sg-dome-dot moon"></span><span class="sg-dome-legt">Lune</span><span class="sg-dome-legv" id="sgDomeMoonPct">—</span></div><div class="sg-dome-moonline" id="sgDomeMoonLine"></div></div>'
      + '<div class="sg-dome-leg"><div class="sg-dome-legh"><span class="sg-dome-dot cloud"></span><span class="sg-dome-legt">Nébulosité</span></div><div class="sg-dome-bars" id="sgDomeCloud"></div></div>'
      + '<div class="sg-dome-leg"><div class="sg-dome-legh"><span class="sg-dome-dot amber"></span><span class="sg-dome-legt">Pollution lumineuse</span></div>'
      + '<div class="sg-dome-amber"><span id="sgDomeBortle"></span><span class="sg-dome-track"><span class="sg-dome-fill amber" id="sgDomePollFill"></span></span></div></div>'
      + '</div></div>'
      + '<div class="sg-dome-pane sg-sky-pane" id="sgDomeSky" hidden>'
      + '<svg class="sg-sky-svg" id="sgSkySvg" viewBox="0 0 300 316" role="img" aria-label="Carte du ciel du spot selon son champ de vision"></svg>'
      + '<div class="sg-sky-summary" id="sgSkySummary"></div></div>'
      + '<div class="sg-dome-frise" id="sgDomeFrise" role="slider" aria-label="Heure de la nuit" style="display:none"></div>'
      + '</div>';
    document.body.appendChild(ov);
    const close = () => closeDome();
    ov.querySelector('.sg-dome-close').addEventListener('click', close);
    ov.addEventListener('click', (e) => { if (e.target === ov) close(); });
    sgDomeEls = {
      ov, svg: ov.querySelector('#sgDomeSvg'), title: ov.querySelector('#sgDomeTitle'), sub: ov.querySelector('#sgDomeSub'),
      score: ov.querySelector('#sgDomeScore'), scoreLbl: ov.querySelector('#sgDomeScoreLbl'),
      moonPct: ov.querySelector('#sgDomeMoonPct'), moonLine: ov.querySelector('#sgDomeMoonLine'),
      cloud: ov.querySelector('#sgDomeCloud'), bortle: ov.querySelector('#sgDomeBortle'), pollFill: ov.querySelector('#sgDomePollFill'),
      frise: ov.querySelector('#sgDomeFrise'),
      tabs: ov.querySelector('#sgDomeTabs'), tabCond: ov.querySelector('#sgTabCond'), tabSky: ov.querySelector('#sgTabSky'),
      paneCond: ov.querySelector('#sgDomeCond'), paneSky: ov.querySelector('#sgDomeSky'),
      skySvg: ov.querySelector('#sgSkySvg'), skySummary: ov.querySelector('#sgSkySummary'),
    };
    sgDomeEls.tabCond.addEventListener('click', () => setDomeTab('cond'));
    sgDomeEls.tabSky.addEventListener('click', () => setDomeTab('sky'));
    return sgDomeEls;
  }

  // Mini-frise dans la modale : scruter les heures de la nuit sans la fermer.
  function buildDomeFrise() {
    const e = ensureDomeModal(), f = e.frise;
    f.innerHTML = '';
    if (!hours || hours.length < 2) { f.style.display = 'none'; return; }
    f.style.display = '';
    const track = document.createElement('div'); track.className = 'sg-dome-frise-track';
    const prog = document.createElement('div'); prog.className = 'sg-dome-frise-prog';
    const thumb = document.createElement('div'); thumb.className = 'sg-dome-frise-thumb';
    track.appendChild(prog); track.appendChild(thumb); f.appendChild(track);
    const labs = document.createElement('div'); labs.className = 'sg-dome-frise-labs';
    hours.forEach((h) => {
      const s = document.createElement('span'); s.className = 'sg-dome-frise-lab';
      s.textContent = fmtHM(h.iso).slice(0, 2) + 'h';
      labs.appendChild(s);
    });
    f.appendChild(labs);
    e._friseTrack = track; e._friseProg = prog; e._friseThumb = thumb;
    const fracFromX = (clientX) => {
      const r = track.getBoundingClientRect();
      const p = Math.max(0, Math.min(1, (clientX - r.left) / Math.max(1, r.width)));
      return p * (hours.length - 1);
    };
    let dragging = false, moved = false;
    track.addEventListener('pointerdown', (ev) => { dragging = true; moved = false; try { track.setPointerCapture(ev.pointerId); } catch (_) {} });
    track.addEventListener('pointermove', (ev) => { if (!dragging) return; moved = true; setDomeFrac(fracFromX(ev.clientX), false); });
    const end = (ev) => { if (!dragging) return; dragging = false; if (!moved) setDomeFrac(fracFromX(ev.clientX), true); };   // tap = transition animée
    track.addEventListener('pointerup', end); track.addEventListener('pointercancel', () => { dragging = false; });
    updateDomeFriseActive();
  }
  function updateDomeFriseActive() {
    const e = sgDomeEls; if (!e || !e._friseTrack || !hours.length) return;
    const frac = domeFrac / Math.max(1, hours.length - 1);
    e._friseProg.style.width = (frac * 100).toFixed(1) + '%';
    e._friseThumb.style.left = (frac * 100).toFixed(1) + '%';
    const active = Math.round(domeFrac);
    const labs = e.frise.querySelectorAll('.sg-dome-frise-lab');
    for (let k = 0; k < labs.length; k++) labs[k].classList.toggle('active', k === active);
  }

  function paintDome(d) {
    const e = ensureDomeModal();
    e.title.textContent = d.title; e.sub.textContent = d.sub || '';
    renderDome(e.svg, d);
    e.score.textContent = (d.score != null ? d.score : '—');
    e.score.style.color = (d.score == null) ? '#9fb0c8' : sgScoreColor(d.score);
    e.scoreLbl.textContent = d.scoreLabel;
    e.moonPct.textContent = `${Math.round(d.moon.illum * 100)}% · ${d.moon.name}`;
    e.moonLine.innerHTML = `<span>Levée <b>${d.moon.rise}</b></span><span>Coucher <b>${d.moon.set}</b></span><span><b>${d.moon.up ? 'au-dessus' : 'sous'} l'horizon</b></span>`;
    e.cloud.innerHTML = '';
    [['Basse', 'low'], ['Moyenne', 'mid'], ['Haute', 'high']].forEach(([lbl, k]) => {
      const row = document.createElement('div'); row.className = 'sg-dome-bar';
      row.innerHTML = `<span class="k">${lbl}</span><span class="sg-dome-track"><span class="sg-dome-fill" style="width:${d.cloud[k]}%"></span></span><span class="v">${d.cloud[k]}%</span>`;
      e.cloud.appendChild(row);
    });
    const b = sgBortle(d.poll);
    e.bortle.textContent = `Bortle ${b.lvl} · ${b.label}`;
    e.pollFill.style.width = d.poll + '%';
    updateDomeFriseActive();
  }

  // Bascule d'onglet Conditions/Ciel (le Ciel n'existe que pour les spots).
  function setDomeTab(which) {
    const e = sgDomeEls; if (!e) return;
    domeTab = which;
    const sky = which === 'sky';
    e.paneCond.hidden = sky; e.paneSky.hidden = !sky;
    e.tabCond.classList.toggle('is-on', !sky); e.tabSky.classList.toggle('is-on', sky);
    e.tabCond.setAttribute('aria-selected', sky ? 'false' : 'true');
    e.tabSky.setAttribute('aria-selected', sky ? 'true' : 'false');
    paintDomeActive();
  }
  // Peint l'onglet ACTIF (évite de recalculer le panneau caché pendant le scrub).
  function paintDomeActive() {
    if (!sgDomeCurrent) return;
    if (domeTab === 'sky' && sgDomeCurrent.spot) paintSky();
    else paintDome(sgDomeData(sgDomeCurrent.i, sgDomeCurrent.title, sgDomeCurrent.sub));
  }
  // Planisphère du ciel du spot (zénith centre, horizon bord, N haut / E droite), croisé
  // avec le champ de vision LiDAR : ce qui est sous le relief est cerclé rouge + barré.
  function paintSky() {
    const e = sgDomeEls; if (!e || !e.skySvg) return;
    const spot = sgDomeCurrent && sgDomeCurrent.spot;
    if (!spot) { e.skySvg.innerHTML = ''; e.skySummary.innerHTML = ''; return; }
    const az0 = (spot.horizon && spot.horizon.azimuths) || [];
    const lat = Number(spot.lat), lon = Number(spot.lon), ms = skyDomeMs();
    const R = 132, CX = 150, CY = 150, rad = SKY_RAD;
    const hz = (az) => skyHorizonAt(az0, az);
    const proj = (alt, az) => { const r = (90 - alt) / 90 * R, a = az * rad; return [CX + r * Math.sin(a), CY - r * Math.cos(a)]; };
    const card = (az) => ['N', 'NE', 'E', 'SE', 'S', 'SO', 'O', 'NO'][Math.round((((az % 360) + 360) % 360) / 45) % 8];
    let s = '<defs><radialGradient id="sgSkyG" cx="50%" cy="50%" r="50%"><stop offset="0%" stop-color="#0c1a30"/><stop offset="70%" stop-color="#0a1120"/><stop offset="100%" stop-color="#070b14"/></radialGradient></defs>';
    s += '<circle cx="' + CX + '" cy="' + CY + '" r="' + R + '" fill="url(#sgSkyG)" stroke="rgba(155,182,232,.28)" stroke-width="1"/>';
    for (const alt of [30, 60]) { const rr = ((90 - alt) / 90 * R).toFixed(1); s += '<circle cx="' + CX + '" cy="' + CY + '" r="' + rr + '" fill="none" stroke="rgba(155,182,232,.12)" stroke-width="1"/>'; }
    // Voie lactée (plan galactique b=0), en segments continus au-dessus de l'horizon.
    let seg = [], gc = null;
    const flush = () => { if (seg.length > 1) { s += '<polyline points="' + seg.join(' ') + '" fill="none" stroke="#9bb6e8" stroke-width="13" stroke-linecap="round" stroke-linejoin="round" opacity="0.16"/>'; s += '<polyline points="' + seg.join(' ') + '" fill="none" stroke="#cfe0ff" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" opacity="0.3"/>'; } seg = []; };
    for (let l = 0; l <= 360; l += 4) {
      const g = skyGalToRadec(l, 0), aa = skyAltaz(g.ra, g.dec, ms, lat, lon);
      if (aa.alt > -2) { const p = proj(Math.max(0, aa.alt), aa.az); seg.push(p[0].toFixed(1) + ',' + p[1].toFixed(1)); if (l === 0) gc = { p, alt: aa.alt, az: aa.az }; }
      else flush();
    }
    flush();
    // Relief du spot (champ de vision) : anneau entre l'horizon vrai (0°) et le relief.
    let outer = [], inner = [];
    for (let az = 0; az <= 360; az += 4) { const p = proj(0, az); outer.push(p[0].toFixed(1) + ',' + p[1].toFixed(1)); }
    for (let az = 360; az >= 0; az -= 4) { const p = proj(Math.min(89, hz(az)), az); inner.push(p[0].toFixed(1) + ',' + p[1].toFixed(1)); }
    s += '<path d="M ' + outer.join(' L ') + ' L ' + inner.join(' L ') + ' Z" fill="rgba(251,191,36,.14)" stroke="rgba(251,191,36,.5)" stroke-width="1" stroke-dasharray="3 3"/>';
    for (const c of [['N', 0], ['E', 90], ['S', 180], ['O', 270]]) { const p = proj(-7, c[1]); s += '<text x="' + p[0].toFixed(1) + '" y="' + (p[1] + 4).toFixed(1) + '" text-anchor="middle" fill="#f2d488" font-size="12" font-weight="600">' + c[0] + '</text>'; }
    const vis = { stars: [], planets: [], never: [] };
    const drawObj = (name, ra, dec, isPlanet, mag) => {
      if (skyNeverRises(dec, lat)) { vis.never.push(name); return; }
      const aa = skyAltaz(ra, dec, ms, lat, lon); if (aa.alt < -1) return;
      const masked = aa.alt < hz(aa.az), p = proj(Math.max(0, aa.alt), aa.az), x = p[0], y = p[1];
      if (isPlanet) {
        const z = 4.5;
        s += '<rect x="' + (x - z).toFixed(1) + '" y="' + (y - z).toFixed(1) + '" width="' + (2 * z) + '" height="' + (2 * z) + '" transform="rotate(45 ' + x.toFixed(1) + ' ' + y.toFixed(1) + ')" fill="' + (masked ? 'none' : '#ffd27a') + '" stroke="' + (masked ? '#e8896a' : 'none') + '" stroke-width="1.4"/>';
        s += '<text x="' + (x + 7).toFixed(1) + '" y="' + (y + 3).toFixed(1) + '" fill="' + (masked ? '#e8896a' : '#ffe6b8') + '" font-size="9">' + name + '</text>';
        if (!masked) vis.planets.push(name);
      } else {
        const r0 = mag < 0.5 ? 3.6 : mag < 1.3 ? 2.9 : 2.2;
        s += '<circle cx="' + x.toFixed(1) + '" cy="' + y.toFixed(1) + '" r="' + r0 + '" fill="' + (masked ? 'none' : '#eaf2ff') + '" stroke="' + (masked ? '#e8896a' : 'none') + '" stroke-width="1.3"/>';
        if (mag < 1.5) s += '<text x="' + (x + 6).toFixed(1) + '" y="' + (y + 3).toFixed(1) + '" fill="' + (masked ? '#e8896a' : '#dbe6f7') + '" font-size="8.5">' + name + '</text>';
        if (masked) s += '<line x1="' + (x - 3.5).toFixed(1) + '" y1="' + y.toFixed(1) + '" x2="' + (x + 3.5).toFixed(1) + '" y2="' + y.toFixed(1) + '" stroke="#e8896a" stroke-width="1.1"/>';
        if (!masked && mag < 1.0) vis.stars.push(name);
      }
    };
    for (const st of SKY_STARS) drawObj(st[0], st[1], st[2], false, st[3]);
    for (const nm in SKY_PL) { const pr = skyPlanetRadec(nm, ms); drawObj(nm, pr.ra, pr.dec, true, -2); }
    if (gc) { const m = gc.alt < hz(gc.az); s += '<text x="' + gc.p[0].toFixed(1) + '" y="' + (gc.p[1] + 4).toFixed(1) + '" text-anchor="middle" fill="' + (m ? '#e8896a' : '#cfe0ff') + '" font-size="12">✦</text>'; }
    e.skySvg.innerHTML = s;
    let mw = 'sous l\'horizon';
    if (gc) mw = (gc.alt < hz(gc.az)) ? ('centre bas, gêné ' + card(gc.az)) : ('visible · ' + card(gc.az));
    let html = '<div class="sg-sky-row"><span>Voie lactée</span><b>' + mw + '</b></div>'
      + '<div class="sg-sky-row"><span>Planètes</span><b>' + (vis.planets.length ? vis.planets.join(', ') : '—') + '</b></div>'
      + '<div class="sg-sky-row"><span>Étoiles phares</span><b>' + (vis.stars.slice(0, 4).join(', ') || '—') + '</b></div>';
    if (vis.never.length) html += '<div class="sg-sky-row sg-sky-never"><span>Hors de portée</span><b>' + vis.never.join(', ') + '</b></div>';
    e.skySummary.innerHTML = html;
    updateDomeFriseActive();   // la frise partagée doit suivre le scrub aussi en onglet Ciel
  }
  function sgDomeIsOpen() { return !!(sgDomeEls && sgDomeEls.ov.classList.contains('open')); }
  function closeDome() { if (sgDomeEls) { sgDomeEls.ov.classList.remove('open'); sgDomeEls.ov.setAttribute('aria-hidden', 'true'); } sgDomeCurrent = null; }
  function openDome(i, title, sub, spot) {
    if (!data || !data.cells || !data.cells[i]) return;
    sgDomeCurrent = { i, title, sub, spot: spot || null };
    domeFrac = cursor;                 // démarre à l'heure affichée sur la carte, puis INDÉPENDANT
    if (sgDomeTweenRaf) { cancelAnimationFrame(sgDomeTweenRaf); sgDomeTweenRaf = null; }
    const e = ensureDomeModal();
    // Onglet « Ciel » réservé aux SPOTS (seuls porteurs d'un champ de vision LiDAR).
    const hasSky = !!(spot && spot.horizon && spot.horizon.azimuths && spot.horizon.azimuths.length);
    e.tabs.hidden = !hasSky;
    setDomeTab('cond');                // toujours démarrer sur Conditions (peint l'onglet actif)
    buildDomeFrise();
    e.ov.classList.add('open'); e.ov.setAttribute('aria-hidden', 'false');
  }
  // Re-rendu du dôme (coalescé en rAF pour un scrub fluide). N'affecte PAS la carte (curseur indépendant).
  let sgDomeRaf = null, sgDomeTweenRaf = null;
  function repaintDome() {
    if (!sgDomeIsOpen() || !sgDomeCurrent || sgDomeRaf) return;
    sgDomeRaf = requestAnimationFrame(() => {
      sgDomeRaf = null;
      if (sgDomeIsOpen() && sgDomeCurrent) paintDomeActive();
    });
  }
  // Positionne le curseur du dôme (fractionnaire). animate=true → transition douce (tap).
  function setDomeFrac(f, animate) {
    const max = Math.max(0, hours.length - 1);
    f = Math.max(0, Math.min(max, f));
    if (sgDomeTweenRaf) { cancelAnimationFrame(sgDomeTweenRaf); sgDomeTweenRaf = null; }
    if (!animate) { domeFrac = f; repaintDome(); return; }
    const from = domeFrac, to = f, dur = 420, t0 = performance.now();
    const ease = (x) => 1 - Math.pow(1 - x, 3);
    const step = (now) => {
      const k = Math.min(1, (now - t0) / dur);
      domeFrac = from + (to - from) * ease(k);
      if (sgDomeIsOpen() && sgDomeCurrent) paintDomeActive();
      if (k < 1) sgDomeTweenRaf = requestAnimationFrame(step); else { sgDomeTweenRaf = null; domeFrac = to; }
    };
    sgDomeTweenRaf = requestAnimationFrame(step);
  }

  // Cellule la plus proche d'un point (pour un spot).
  function sgNearestCell(lat, lon) {
    if (!data || !data.cells) return -1;
    const cl = Math.cos(lat * Math.PI / 180); let best = -1, bd = Infinity;
    for (let i = 0; i < data.cells.length; i++) {
      const dx = (data.cells[i].lon - lon) * cl, dy = data.cells[i].lat - lat, dd = dx * dx + dy * dy;
      if (dd < bd) { bd = dd; best = i; }
    }
    return best;
  }
  // Ouvre la modale pour un SPOT (hook appelé par spots.js en mode étoile). Renvoie true si géré.
  function openDomeForSpot(spot) {
    if (!active || !spot) return false;
    const i = sgNearestCell(Number(spot.lat), Number(spot.lon));
    if (i < 0) return false;
    openDome(i, spot.name || 'Spot', 'Spot de chasse', spot);
    return true;
  }

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
    if (bestBtn) { bestBtn.classList.toggle('active', bestCellsOn); bestBtn.setAttribute('aria-pressed', bestCellsOn ? 'true' : 'false'); }
    syncLayersUI();
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
    window.sgOnSpotClick = openDomeForSpot;   // clic spot → dôme (intercepté par spots.js)
    await loadData();
  }

  function deactivate() {
    if (!active) return;
    active = false;
    stop();
    stopPulse();
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
    try { map.getSource(BEST_SRC) && map.getSource(BEST_SRC).setData(EMPTY_FC); } catch (_) {}
    if (layersReady) hideGrid(false);
    if (clickBound) {
      map.off('click', onSgTap);
      map.off('mousemove', QUALITY_LYR, onSgMove);
      map.off('mouseenter', QUALITY_LYR, onSgEnter);
      map.off('mouseleave', QUALITY_LYR, onSgLeave);
      clickBound = false;
    }
    window.sgOnSpotClick = null; closeDome(); closeGeoSheet();
    onSgLeave();
    if (popup) { popup.remove(); }
    if (userMarker) { userMarker.remove(); userMarker = null; }
    hideAgenda();
    openLayersPanel(false);
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
  bestBtn && bestBtn.addEventListener('click', () => setBestCells(!bestCellsOn));
  // Légende (ruban vertical du rail) : survol = déplie (CSS) ; tap tactile / Entrée = bascule.
  if (legendEl) {
    const toggleLegend = () => {
      const open = legendEl.classList.toggle('open');
      legendEl.setAttribute('aria-expanded', open ? 'true' : 'false');
    };
    legendEl.addEventListener('click', toggleLegend);
    legendEl.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggleLegend(); }
      else if (e.key === 'Escape') { legendEl.classList.remove('open'); legendEl.setAttribute('aria-expanded', 'false'); }
    });
  }
  // Sensibilité des favoris (item 1) : chips strict/normal/large dans le panneau Couches.
  const bestSensBox = document.getElementById('sgBestSens');
  if (bestSensBox) {
    bestSensBox.addEventListener('click', (e) => {
      const chip = e.target.closest('.sg-sens-chip');
      if (chip) setBestSens(chip.getAttribute('data-sens'));
    });
    syncBestSensUI();
  }
  // « Couches » : ouverture de la modale + cases (multi-sélection superposable).
  layersBtn && layersBtn.addEventListener('click', () => openLayersPanel(layersPanel ? layersPanel.hidden : true));
  if (layersPanel) {
    const parent = document.getElementById('sgLayerCloud');
    const subs = document.getElementById('sgLayerSubs');
    const chev = parent && parent.querySelector('.sg-layer-chev');
    // Chevron : ouvre/ferme la sous-liste (basses/moyennes/hautes) SANS toucher aux couches.
    const toggleSubs = (e) => {
      if (e) e.stopPropagation();
      const open = subs && subs.classList.toggle('open');
      parent.setAttribute('aria-expanded', open ? 'true' : 'false');
    };
    chev && chev.addEventListener('click', toggleSubs);
    // « Nébulosité » (reste de la ligne) : coche/décoche les 3 couches nuages D'UN COUP
    // (item Trello). Coché si au moins une est active → un clic les éteint toutes ; sinon
    // les allume toutes. On déplie pour montrer le résultat.
    parent && parent.addEventListener('click', () => {
      const target = !(layerSel.cloudLo || layerSel.cloudMi || layerSel.cloudHi);
      layerSel.cloudLo = target; layerSel.cloudMi = target; layerSel.cloudHi = target;
      if (subs && !subs.classList.contains('open')) {
        subs.classList.add('open');
        parent.setAttribute('aria-expanded', 'true');
      }
      applyLayers();
    });
    const bind = (id, key) => { const el = document.getElementById(id); el && el.addEventListener('click', () => toggleLayer(key)); };
    bind('sgLayerCloudLo', 'cloudLo');
    bind('sgLayerCloudMi', 'cloudMi');
    bind('sgLayerCloudHi', 'cloudHi');
    bind('sgLayerLight', 'light');
    bind('sgLayerMoon', 'moon');
  }
  // Poignée de repli de la frise (réutilise le helper générique défini par chase.js).
  if (typeof window.setupFriseCollapse === 'function') {
    window.setupFriseCollapse(controls, document.getElementById('stargazeToggleBtn'), 'storm_stargaze_collapsed');
  }
  // Échap : ferme d'abord la modale « dôme », puis l'agenda, sinon quitte le mode.
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape' || !active) return;
    if (sgDomeIsOpen()) { closeDome(); return; }
    if (geoSheetEls && !geoSheetEls.sheet.hidden) { closeGeoSheet(); return; }
    if (agendaOpenState()) { hideAgenda(); return; }
    deactivate();
  });

  window.toggleStargazeMode = () => { active ? deactivate() : activate(); };
  window.exitStargazeMode = () => { if (active) deactivate(); };
  window.__stargazeV = '1.3.109';
})();
