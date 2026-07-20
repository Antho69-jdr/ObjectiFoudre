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
  const TOP_SRC = 'sg-top-src', TOP_GLOW = 'sg-top-glow', TOP_LYR = 'sg-top';
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
  // Point dans un anneau [[lon,lat],…] (lancer de rayon).
  function pipRing(lon, lat, ring) {
    let inside = false;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const xi = ring[i][0], yi = ring[i][1], xj = ring[j][0], yj = ring[j][1];
      if (((yi > lat) !== (yj > lat)) && (lon < (xj - xi) * (lat - yi) / ((yj - yi) || 1e-12) + xi)) inside = !inside;
    }
    return inside;
  }
  // Sutherland-Hodgman : intersection d'un anneau (sujet, non convexe) avec un
  // RECTANGLE aligné (fenêtre convexe) → part de la France DANS la cellule.
  function clipRingToRect(ring, minx, miny, maxx, maxy) {
    function clip(poly, keep, cut) {
      const out = [], n = poly.length;
      for (let i = 0; i < n; i++) {
        const cur = poly[i], prev = poly[(i + n - 1) % n];
        const ci = keep(cur), pi = keep(prev);
        if (ci) { if (!pi) out.push(cut(prev, cur)); out.push(cur); }
        else if (pi) out.push(cut(prev, cur));
      }
      return out;
    }
    let p = ring;
    if (p.length > 1 && p[0][0] === p[p.length - 1][0] && p[0][1] === p[p.length - 1][1]) p = p.slice(0, -1);
    p = clip(p, q => q[0] >= minx, (a, b) => { const t = (minx - a[0]) / ((b[0] - a[0]) || 1e-12); return [minx, a[1] + t * (b[1] - a[1])]; }); if (p.length < 3) return p;
    p = clip(p, q => q[0] <= maxx, (a, b) => { const t = (maxx - a[0]) / ((b[0] - a[0]) || 1e-12); return [maxx, a[1] + t * (b[1] - a[1])]; }); if (p.length < 3) return p;
    p = clip(p, q => q[1] >= miny, (a, b) => { const t = (miny - a[1]) / ((b[1] - a[1]) || 1e-12); return [a[0] + t * (b[0] - a[0]), miny]; }); if (p.length < 3) return p;
    p = clip(p, q => q[1] <= maxy, (a, b) => { const t = (maxy - a[1]) / ((b[1] - a[1]) || 1e-12); return [a[0] + t * (b[0] - a[0]), maxy]; });
    return p;
  }
  // Coords de chaque cellule ROGNÉE à la silhouette France (mer ET frontières
  // terrestres). Grille + France statiques → calculé UNE fois puis mis en cache.
  function computeClippedCells() {
    if (clippedCells && clippedCells._n === data.cells.length) return clippedCells;
    const MAIN = (typeof FRANCE_GRID_CLIP_MAINLAND_RING !== 'undefined') ? FRANCE_GRID_CLIP_MAINLAND_RING : null;
    const CORS = (typeof FRANCE_GRID_CLIP_CORSICA_RING !== 'undefined') ? FRANCE_GRID_CLIP_CORSICA_RING : null;
    const out = [];
    for (let i = 0; i < data.cells.length; i++) {
      const lon = data.cells[i].lon, lat = data.cells[i].lat;
      const hw = (CELL_KM / (111.32 * Math.cos(lat * Math.PI / 180))) / 2 * OVERLAP;
      const hh = (CELL_KM / 110.574) / 2 * OVERLAP;
      const minx = lon - hw, maxx = lon + hw, miny = lat - hh, maxy = lat + hh;
      const square = [[minx, miny], [maxx, miny], [maxx, maxy], [minx, maxy], [minx, miny]];
      const ring = (MAIN && pipRing(lon, lat, MAIN)) ? MAIN : ((CORS && pipRing(lon, lat, CORS)) ? CORS : null);
      if (!ring) { out.push({ i, coords: square }); continue; }
      // cellule ENTIÈREMENT dans la France (4 coins) → carré tel quel (pas de clip coûteux)
      if (pipRing(minx, miny, ring) && pipRing(maxx, miny, ring) && pipRing(maxx, maxy, ring) && pipRing(minx, maxy, ring)) {
        out.push({ i, coords: square });
      } else {
        const clip = clipRingToRect(ring, minx, miny, maxx, maxy);
        if (clip.length >= 3) { clip.push(clip[0]); out.push({ i, coords: clip }); }
        else out.push({ i, coords: square });
      }
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
      feats.push({ type: 'Feature', properties: props,
        geometry: { type: 'Polygon', coordinates: [c.coords] } });
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
    updateHourBadge();
  }

  function updateHourBadge() {
    if (!hourEl) return;
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
    degraded = !d.ok;                       // météo AROME absente → obscurité seule
    data = d; hours = degraded ? [] : (d.hours || []);
    computeBestDark();
    qualityFC = buildQualityFC();
    if (map.getSource(QUALITY_SRC)) try { map.getSource(QUALITY_SRC).setData(qualityFC); } catch (_) {}
    renderBadge();
    buildFrise();
    if (map.getSource(TOP_SRC)) try { map.getSource(TOP_SRC).setData(degraded ? EMPTY_FC : topSpotsFC()); } catch (_) {}
    if (degraded) {
      paintHour(0);
      // la grille AROME se précharge (ou l'API est momentanément indispo) → on réessaie.
      retryTimer = window.setTimeout(() => { if (active) loadData(); }, 90000);
    } else {
      cursor = defaultCursor();
      applyCursor(cursor);
    }
  }

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
  function onSgEnter() { map.getCanvas().style.cursor = 'pointer'; }
  function onSgLeave() { if (map.getCanvas()) map.getCanvas().style.cursor = ''; if (sgTipEl) sgTipEl.classList.remove('is-visible'); }
  function onSgMove(e) {
    if (!data) { onSgLeave(); return; }
    const f = e.features && e.features[0];
    const i = f ? Number(f.properties.idx) : -1;
    if (!(i >= 0) || !data.cells[i]
        || (typeof pointInFranceGridMask === 'function' && e.lngLat && !pointInFranceGridMask(e.lngLat.lng, e.lngLat.lat))) {
      onSgLeave();
      return;
    }
    const el = ensureSgTip();
    if (degraded) {
      const dk = data.darkness[i];
      const col = sgRampColor(dk);
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
    const pt = e.point || { x: 0, y: 0 };
    const cont = map.getContainer();
    const cw = cont ? cont.clientWidth : 0, ch = cont ? cont.clientHeight : 0;
    const tw = el.offsetWidth || 140, th = el.offsetHeight || 74;
    const left = (pt.x + 16 + tw > cw) ? pt.x - 16 - tw : pt.x + 16;
    const top = (pt.y + 16 + th > ch) ? pt.y - 16 - th : pt.y + 16;
    el.style.left = Math.max(4, left) + 'px';
    el.style.top = Math.max(4, top) + 'px';
    el.classList.add('is-visible');
  }

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
    setStargazeMapTint(true);
    if (ensureLayers()) { hideGrid(true); setLayersVisible(true); }
    else {
      const retry = () => { if (!active) return; if (ensureLayers()) { hideGrid(true); setLayersVisible(true); paintHour(cursor); } else window.setTimeout(retry, 250); };
      window.setTimeout(retry, 250);
    }
    if (!clickBound) {
      map.on('click', onMapClick);
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
      map.off('click', onMapClick);
      map.off('mousemove', QUALITY_LYR, onSgMove);
      map.off('mouseenter', QUALITY_LYR, onSgEnter);
      map.off('mouseleave', QUALITY_LYR, onSgLeave);
      clickBound = false;
    }
    onSgLeave();
    if (popup) { popup.remove(); }
    if (userMarker) { userMarker.remove(); userMarker = null; }
    hideHint();
  }

  toggleBtn.addEventListener('click', () => { active ? deactivate() : activate(); });
  playBtn && playBtn.addEventListener('click', play);
  geoBtn && geoBtn.addEventListener('click', autourDeMoi);
  // Poignée de repli de la frise (réutilise le helper générique défini par chase.js).
  if (typeof window.setupFriseCollapse === 'function') {
    window.setupFriseCollapse(controls, document.getElementById('stargazeToggleBtn'), 'storm_stargaze_collapsed');
  }
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && active) deactivate(); });

  window.toggleStargazeMode = () => { active ? deactivate() : activate(); };
  window.exitStargazeMode = () => { if (active) deactivate(); };
  window.__stargazeV = '1.3.49';
})();
