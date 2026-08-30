/* spots.js — « Mes spots » (IIFE, pattern chase.js/stargaze.js).
   Calque de spots de chasse PARTAGÉ sur la carte de base `map` (state.js) : visible dans
   les 3 modes (Prévision / Chasse / Étoiles). Clic sur un spot → fiche avec la rosace de
   champ de vision (vue de dessus, rayon = distance 30 km, crêtes à leur distance réelle).
   Source : GET /api/spots. Bouton rail droit (#spotsPageBtn) ouvre la page tableau.
   CSS dans components/spots.css (build esbuild → theme.css). Rien de bloquant :
   si /api/spots échoue, le reste de l'app n'en dépend pas. */
(function () {
  'use strict';

  // ── paramètres rosace (identiques à la maquette validée) ───────────────────
  var MAXKM = 30, RING_STEP = 5, BLOCK_DEG = 2;
  var COL = {
    sky: '#46c0e6', skySoft: 'rgba(29,151,196,.16)',
    relief: '#b8804f', reliefDeep: '#5a3d25',
    near: '#5aab6b',            // obstruction PROCHE (arbres/bâti, MNS) — distincte du relief
    line: '#22303f', ink: '#e9eff7', muted: '#8ba0b8', faint: '#7c93ad', surface: '#121a25',
    good: '#3fce97', warn: '#e3b34b', bad: '#e8725a',
  };
  var COMPASS = ['N','NNE','NE','ENE','E','ESE','SE','SSE','S','SSW','SW','WSW','W','WNW','NW','NNW'];
  function cardinal(az){ return COMPASS[Math.round(az / 22.5) % 16]; }
  function scoreColor(s){ return s >= 75 ? COL.good : s >= 40 ? COL.warn : COL.bad; }
  function scoreLabel(s){ return s >= 75 ? 'Dégagé' : s >= 40 ? 'Partiel' : 'Encaissé'; }
  function angColor(a){ var t = Math.max(0, Math.min(1, (a - BLOCK_DEG) / (30 - BLOCK_DEG))); return 'hsl(' + (42 - 36 * t).toFixed(0) + ' 78% 55%)'; }

  var NS = 'http://www.w3.org/2000/svg';
  function el(tag, attrs){ var e = document.createElementNS(NS, tag); for (var k in attrs) e.setAttribute(k, attrs[k]); return e; }
  function pt(cx, cy, R, km, az){ var r = R * Math.min(km, MAXKM) / MAXKM, a = (az - 90) * Math.PI / 180; return [cx + r * Math.cos(a), cy + r * Math.sin(a)]; }

  // ── rosace SVG (vue de dessus, rayon = distance) ───────────────────────────
  function makeRosace(azimuths, openness, size) {
    var S = size, cx = S / 2, cy = S / 2, R = S * 0.40, N = azimuths.length, step = 360 / N;
    var svg = el('svg', { viewBox: '0 0 ' + S + ' ' + S, width: S, height: S, role: 'img',
      'aria-label': 'Champ de vision, vue de dessus, ouverture ' + Math.round(openness) + ' sur 100' });
    var big = S > 200;
    svg.appendChild(el('circle', { cx: cx, cy: cy, r: R, fill: COL.skySoft, stroke: COL.line }));
    for (var km = RING_STEP; km <= MAXKM; km += RING_STEP) {
      svg.appendChild(el('circle', { cx: cx, cy: cy, r: R * km / MAXKM, fill: 'none',
        stroke: COL.line, 'stroke-dasharray': '2 4', opacity: km === MAXKM ? .9 : .55 }));
    }
    // sol visible (bassin) + relief (evenodd)
    var vis = '', i, o, x, y, rimPath = '';
    for (i = 0; i <= N; i++) {
      o = azimuths[i % N];
      var kmv = (o.horizon_deg >= BLOCK_DEG) ? o.dist_km : MAXKM;
      var p = pt(cx, cy, R, kmv, (i % N) * step); vis += (i ? 'L' : 'M') + p[0].toFixed(1) + ' ' + p[1].toFixed(1) + ' ';
      var pr = pt(cx, cy, R, MAXKM, (i % N) * step); rimPath += (i ? 'L' : 'M') + pr[0].toFixed(1) + ' ' + pr[1].toFixed(1) + ' ';
    }
    var defs = el('defs', {}), g = el('radialGradient', { id: 'ofrel' + size });
    g.innerHTML = '<stop offset="0%" stop-color="' + COL.relief + '"/><stop offset="100%" stop-color="' + COL.reliefDeep + '"/>';
    defs.appendChild(g); svg.appendChild(defs);
    svg.appendChild(el('path', { d: rimPath + 'Z ' + vis + 'Z', 'fill-rule': 'evenodd', fill: 'url(#ofrel' + size + ')', opacity: .9 }));
    svg.appendChild(el('path', { d: vis + 'Z', fill: 'none', stroke: COL.sky, 'stroke-width': 1.4, 'stroke-linejoin': 'round' }));
    // marqueurs de crête : relief (ocre, à sa distance) OU obstruction proche (vert, MNS)
    for (i = 0; i < N; i++) {
      o = azimuths[i]; if (o.horizon_deg < BLOCK_DEG) continue;
      var m = pt(cx, cy, R, o.dist_km, i * step);
      var isNear = o.blocker === 'near';
      svg.appendChild(el('circle', { cx: m[0], cy: m[1], r: big ? (2.4 + o.horizon_deg / 9) : (1.5 + o.horizon_deg / 16),
        fill: isNear ? COL.near : angColor(o.horizon_deg), stroke: COL.surface, 'stroke-width': 1.1 }));
    }
    // croix + cardinaux (halo) + graduations km
    ['N','E','S','W'].forEach(function (lbl, k) {
      var az = k * 90, oo = pt(cx, cy, R, MAXKM, az);
      svg.appendChild(el('line', { x1: cx, y1: cy, x2: oo[0], y2: oo[1], stroke: COL.line, 'stroke-width': 1 }));
      var off = big ? 15 : 11, tx = cx + (oo[0] - cx) * (1 + off / R), ty = cy + (oo[1] - cy) * (1 + off / R);
      var t = el('text', { x: tx, y: ty, 'text-anchor': 'middle', 'dominant-baseline': 'middle', fill: COL.ink,
        'font-family': 'ui-monospace,monospace', 'font-size': big ? 12 : 10, 'font-weight': 700,
        'paint-order': 'stroke', stroke: COL.surface, 'stroke-width': 3.2, 'stroke-linejoin': 'round' });
      t.textContent = lbl; svg.appendChild(t);
    });
    if (big) {
      for (var km2 = RING_STEP; km2 <= MAXKM; km2 += RING_STEP) {
        var rr = R * km2 / MAXKM, tk = el('text', { x: cx + 5, y: cy - rr, fill: COL.ink,
          'font-family': 'ui-monospace,monospace', 'font-size': 10.5, 'font-weight': 700, 'dominant-baseline': 'middle',
          'paint-order': 'stroke', stroke: COL.surface, 'stroke-width': 3.4, 'stroke-linejoin': 'round' });
        tk.textContent = (km2 === MAXKM ? km2 + ' km' : km2); svg.appendChild(tk);
      }
    }
    svg.appendChild(el('circle', { cx: cx, cy: cy, r: 2.4, fill: COL.ink }));
    return svg;
  }

  // ── fiche (contenu de popup) ───────────────────────────────────────────────
  function buildFiche(spot) {
    var h = spot.horizon || null;
    var wrap = document.createElement('div');
    wrap.className = 'ofspot-fiche';
    var head = document.createElement('div'); head.className = 'ofspot-head';
    var nm = document.createElement('div'); nm.className = 'ofspot-name'; nm.textContent = spot.name;
    head.appendChild(nm);
    if (h) {
      var badge = document.createElement('span'); badge.className = 'ofspot-badge';
      badge.style.color = scoreColor(h.openness); badge.style.background = scoreColor(h.openness) + '22';
      badge.textContent = Math.round(h.openness) + '/100 · ' + scoreLabel(h.openness);
      head.appendChild(badge);
    }
    wrap.appendChild(head);

    if (h && h.azimuths && h.azimuths.length) {
      var ros = document.createElement('div'); ros.className = 'ofspot-ros';
      ros.appendChild(makeRosace(h.azimuths, h.openness, 210));
      wrap.appendChild(ros);
      var innerR = Math.round(+(spot.inner_radius_m || h.inner_radius_m || 0));
      var stats = document.createElement('div'); stats.className = 'ofspot-stats';
      stats.innerHTML =
        statCell('Altitude', Math.round(h.z0) + ' m') +
        statCell('Horizon moyen', (h.mean_horizon_deg >= 0 ? '+' : '') + h.mean_horizon_deg + '°') +
        statCell('Ciel bas dégagé', h.pct_below_5deg + ' %') +
        (innerR > 0 ? statCell('Trou central', '⌀ ' + innerR + ' m')
                    : statCell('Relief autour', '+' + (h.denivele_max_m || 0) + ' m'));
      wrap.appendChild(stats);
      wrap.appendChild(buildNearLine(h));
    } else {
      var pend = document.createElement('div'); pend.className = 'ofspot-pending';
      pend.textContent = 'Champ de vision en cours de calcul…';
      wrap.appendChild(pend);
    }
    if (spot.notes) {
      var nt = document.createElement('div'); nt.className = 'ofspot-notes'; nt.textContent = spot.notes;
      wrap.appendChild(nt);
    }
    return wrap;
  }
  function statCell(k, v) {
    return '<div class="ofspot-stat"><span class="k">' + k + '</span><span class="v">' + v + '</span></div>';
  }

  // ligne « obstruction proche » (arbres/bâti, MNS LiDAR HD)
  function buildNearLine(h) {
    var el2 = document.createElement('div'); el2.className = 'ofspot-near';
    if (h.mns_available === false) {
      el2.classList.add('muted');
      el2.innerHTML = '<span class="ofspot-near-dot muted"></span>Obstruction proche : non couverte (LiDAR HD)';
    } else if (h.near_blocked_pct > 0) {
      var worst = null;
      (h.azimuths || []).forEach(function (a) {
        if (a.blocker === 'near' && a.near_deg != null && (!worst || a.near_deg > worst.near_deg)) worst = a;
      });
      var txt = 'Obstruction proche (arbres/bâti) : ' + h.near_blocked_pct + '% des directions';
      if (worst) txt += ' · gêne à ' + worst.near_dist_m + ' m au ' + worst.cardinal + ' (+' + Math.round(worst.near_deg) + '°)';
      el2.innerHTML = '<span class="ofspot-near-dot"></span>' + txt;
    } else {
      el2.innerHTML = '<span class="ofspot-near-dot"></span>Aucune obstruction proche';
    }
    return el2;
  }

  // ── marqueurs + calque ─────────────────────────────────────────────────────
  // spotsData = spots PUBLICS (calque commun + scoring orage + table « Publics »).
  // mineData  = MES spots (connecté) : perso privés + partagés (avec `status`).
  var markers = [], popup = null, visible = true, loaded = false, spotsData = [], mineData = [];
  var account = { loggedIn: false };
  var tableView = 'public';   // page tableau : 'public' | 'mine'

  // ── barre tri/filtre/vues de la page « Mes spots » (préférences persistées) ──
  var spotsView = 'gallery';    // 'gallery' | 'list'
  var spotsSort = 'score';      // 'score'|'near'|'far'|'az'|'za'|'dir'|'date'
  var spotsDirFilter = {};      // {N:true,…} : directions dégagées exigées (multi)
  var spotsMaxKm = 0;           // 0 = pas de filtre distance
  var myGeo = null;             // { lat, lon } de « ma position » (géoloc navigateur)
  var gpsMenuEl = null;         // menu déroulant « Y aller » ouvert (deep-links)
  try {
    var _spv = JSON.parse(localStorage.getItem('of_spots_view') || '{}');
    if (_spv.view) spotsView = _spv.view;
    if (_spv.sort) spotsSort = _spv.sort;
    if (typeof _spv.maxKm === 'number') spotsMaxKm = _spv.maxKm;
    if (_spv.dir && typeof _spv.dir === 'object') spotsDirFilter = _spv.dir;
  } catch (e) {}
  function saveSpotsPrefs() {
    try { localStorage.setItem('of_spots_view', JSON.stringify({ view: spotsView, sort: spotsSort, maxKm: spotsMaxKm, dir: spotsDirFilter })); } catch (e) {}
  }

  // Statut d'un spot possédé → libellé/couleur/aide (piloté les puces & actions propriétaire).
  function statusMeta(st) {
    return ({
      private:  { label: 'Privé',         cls: 'private',  hint: 'Visible de toi seul.' },
      pending:  { label: 'En validation', cls: 'pending',  hint: 'Proposé au public, en attente de modération.' },
      approved: { label: 'Public',        cls: 'approved', hint: 'Visible par tout le monde.' },
      rejected: { label: 'Refusé',        cls: 'rejected', hint: 'Non publié. Tu peux le reproposer.' },
    })[st] || { label: '', cls: '', hint: '' };
  }

  // Liste fusionnée pour l'affichage/scoring : spots publics + MES spots (dédoublonnés par id ;
  // ma version l'emporte et porte l'auteur=pseudo si le spot public m'appartient).
  function renderList() {
    var mineById = {};
    mineData.forEach(function (s) { s._mine = true; mineById[s.id] = s; });
    var out = [];
    spotsData.forEach(function (s) {
      if (mineById[s.id]) { if (s.author_pseudo) mineById[s.id].author_pseudo = s.author_pseudo; }
      else out.push(s);
    });
    mineData.forEach(function (s) { out.push(s); });
    return out;
  }

  // Marqueur = rose des vents des DIRECTIONS DE PRÉDILECTION : chaque branche pointe
  // vers une des 8 directions (N NE E SE S SO O NO) ; sa LONGUEUR/opacité encode
  // l'ouverture dans cette direction (branche longue = vue dégagée = direction de choix).
  var _DIRS8 = [0, 45, 90, 135, 180, 225, 270, 315];
  var _DIRLBL = ['N', 'NE', 'E', 'SE', 'S', 'SO', 'O', 'NO'];
  function dirRatios(h) {           // ouverture 0..1 par direction (1 = très dégagé)
    if (!h || !h.azimuths || !h.azimuths.length) return null;
    var MAXDEG = 18;                // horizon ≥18° ≈ direction bouchée (échelle visuelle)
    return _DIRS8.map(function (d) {
      var vals = h.azimuths.filter(function (a) { return Math.abs(((a.az - d + 180) % 360) - 180) <= 22.5; });
      if (!vals.length) return 0.5;
      var m = vals.reduce(function (s, a) { return s + (a.horizon_deg || 0); }, 0) / vals.length;
      return Math.max(0.1, Math.min(1, 1 - m / MAXDEG));
    });
  }
  function bestDirs(ratios) {       // 1-2 meilleures directions (pour l'aria/tooltip)
    if (!ratios) return [];
    return _DIRS8.map(function (d, i) { return { lbl: _DIRLBL[i], r: ratios[i] }; })
      .sort(function (a, b) { return b.r - a.r; }).slice(0, 3)
      .filter(function (x) { return x.r >= 0.62; }).map(function (x) { return x.lbl; });
  }
  var _CDIR_GOOD = '#3ee06a';        // vert vif = direction de prédilection
  function dirGreen(ratios) {        // quelles directions sont « de prédilection » (dégagées)
    var g = [false, false, false, false, false, false, false, false];
    if (!ratios) return g;
    var best = -1, bv = -1;
    for (var i = 0; i < 8; i++) { if (ratios[i] >= 0.62) g[i] = true; if (ratios[i] > bv) { bv = ratios[i]; best = i; } }
    if (best >= 0 && !g.some(function (x) { return x; })) g[best] = true;   // au moins la meilleure
    return g;
  }
  // Rose des vents = anneau « vue visible » SEUL (item Trello, choix Anthony 2026-08-01 :
  // remplace totalement les anciennes flèches de prédilection, qui pouvaient se contredire
  // avec l'anneau — plus lisible/représentatif de la zone). Couronne de 16 secteurs (22,5°) :
  // VERT = horizon dégagé (on voit loin) ; plus c'est bouché (relief/obstruction proche), plus
  // le secteur s'EFFACE (absence de couleur, on voit le disque sombre — choix Anthony, remplace
  // l'ancien rouge). Donnée = spot.horizon.azimuths[].horizon_deg (audit LiDAR).
  var RING_GREEN = 'hsl(140 68% 47%)';
  function openAlpha(op) {          // opacité du secteur = ouverture (bouché → transparent)
    return Math.max(0, Math.min(1, op));
  }
  function ringSectors(h) {         // 16 secteurs : ouverture moyenne + obstacle proche
    if (!h || !h.azimuths || !h.azimuths.length) return null;
    var K = 16, step = 22.5, MAXDEG = 18, BLOCK = 2, NEAR_KM = 5, out = [];
    for (var k = 0; k < K; k++) {
      var c = k * step;
      var vals = h.azimuths.filter(function (a) { return Math.abs(((a.az - c + 180) % 360) - 180) <= step / 2; });
      var m = vals.length ? vals.reduce(function (s, a) { return s + (a.horizon_deg || 0); }, 0) / vals.length : 0;
      // secteur bouché de PRÈS : un obstacle réel (horizon ≥ BLOCK°) à moins de 5 km (choix Anthony → noir).
      var near = vals.some(function (a) { return (a.horizon_deg || 0) >= BLOCK && a.dist_km != null && a.dist_km < NEAR_KM; });
      out.push({ c: c, op: Math.max(0, Math.min(1, 1 - m / MAXDEG)), near: near });
    }
    return out;
  }
  function ringPt(r, deg) { var a = (deg - 90) * Math.PI / 180; return [(20 + r * Math.cos(a)).toFixed(2), (20 + r * Math.sin(a)).toFixed(2)]; }
  function visionRingSVG(h) {
    var secs = ringSectors(h);
    if (!secs) return '';
    // Couronne épaisse (l'anneau EST la rose maintenant → il occupe le disque, trou central
    // pour le moyeu). Fin liseré sombre entre secteurs pour garder les 16 directions lisibles.
    // 3 états : NOIR = obstacle à < 5 km (« positif ») ; VERT (opacité = ouverture) = dégagé ;
    // transparent = bouché au loin (absence de couleur).
    var rIn = 6.6, rOut = 16.4, half = 11.25, segs = '';
    for (var i = 0; i < secs.length; i++) {
      var s = secs[i], a0 = s.c - half, a1 = s.c + half;
      var o0 = ringPt(rOut, a0), o1 = ringPt(rOut, a1), i1 = ringPt(rIn, a1), i0 = ringPt(rIn, a0);
      var fill = s.near ? '#000000' : RING_GREEN;
      var op = s.near ? 0.92 : openAlpha(s.op);
      segs += '<path d="M' + o0[0] + ' ' + o0[1] + ' A' + rOut + ' ' + rOut + ' 0 0 1 ' + o1[0] + ' ' + o1[1] +
        ' L' + i1[0] + ' ' + i1[1] + ' A' + rIn + ' ' + rIn + ' 0 0 0 ' + i0[0] + ' ' + i0[1] + ' Z" fill="' + fill +
        '" stroke="#0e1620" stroke-width="0.35" opacity="' + op.toFixed(2) + '"/>';
    }
    return '<g class="ofspot-compass-ring" opacity="0.95">' + segs + '</g>';
  }

  // Rose des vents = disque sombre + couronne « vue visible » colorée (ouverture par secteur)
  // + moyeu. Les anciennes flèches de prédilection sont retirées (choix Anthony) : l'anneau
  // seul représente la zone, sans se contredire avec des flèches. Nord = haut.
  function compassSVG(spot) {
    return '<svg viewBox="0 0 40 40" class="ofspot-compass" aria-hidden="true">' +
      '<circle cx="20" cy="20" r="16.5" class="ofspot-compass-bg"/>' +
      visionRingSVG(spot.horizon) +
      '<circle cx="20" cy="20" r="2.3" class="ofspot-compass-hub"/>' +
      '</svg>';
  }
  function pinEl(spot) {
    var h = spot.horizon, best = bestDirs(dirRatios(h));
    var label = 'Spot ' + spot.name +
      (h ? ', ouverture ' + Math.round(h.openness) + ' sur 100' + (best.length ? ', dégagé vers ' + best.join(' et ') : '') : '');
    var d = document.createElement('div');
    d.className = 'ofspot-pin';
    d.setAttribute('role', 'button');
    d.setAttribute('tabindex', '0');
    d.setAttribute('aria-label', label);
    d._ofLabel = label;
    d._ofTitle = spot.name + (best.length ? ' — dégagé vers ' + best.join(', ') : '');
    d.title = d._ofTitle;
    d.innerHTML = compassSVG(spot);
    return d;
  }

  // ── Cercle de vision GÉO imprimé sur la carte + panneau de stats ────────────
  var VIS_SRC = 'ofspot-vision', selectedSpotId = null, panelEl = null, visionWired = false;

  function destPoint(lon, lat, azDeg, distM) {   // destination géodésique (sphère)
    var R = 6371000, br = azDeg * Math.PI / 180, ad = distM / R;
    var la1 = lat * Math.PI / 180, lo1 = lon * Math.PI / 180;
    var la2 = Math.asin(Math.sin(la1) * Math.cos(ad) + Math.cos(la1) * Math.sin(ad) * Math.cos(br));
    var lo2 = lo1 + Math.atan2(Math.sin(br) * Math.sin(ad) * Math.cos(la1), Math.cos(ad) - Math.sin(la1) * Math.sin(la2));
    return [lo2 * 180 / Math.PI, la2 * 180 / Math.PI];
  }

  function geoDistM(lon1, lat1, lon2, lat2) {     // haversine (m)
    var R = 6371000, dLa = (lat2 - lat1) * Math.PI / 180, dLo = (lon2 - lon1) * Math.PI / 180;
    var a = Math.sin(dLa / 2) * Math.sin(dLa / 2) +
            Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLo / 2) * Math.sin(dLo / 2);
    return 2 * R * Math.asin(Math.min(1, Math.sqrt(a)));
  }

  function ensureVisionLayers() {
    if (typeof map === 'undefined' || typeof map.getSource !== 'function' || map.getSource(VIS_SRC)) return;
    map.addSource(VIS_SRC, { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
    map.addLayer({ id: VIS_SRC + '-basin', type: 'fill', source: VIS_SRC, filter: ['==', ['get', 'kind'], 'basin'],
      paint: { 'fill-color': '#46c0e6', 'fill-opacity': 0.16 } });
    map.addLayer({ id: VIS_SRC + '-rings', type: 'line', source: VIS_SRC, filter: ['==', ['get', 'kind'], 'ring'],
      paint: { 'line-color': '#9fbccb', 'line-opacity': 0.35, 'line-dasharray': [2, 3], 'line-width': 1 } });
    map.addLayer({ id: VIS_SRC + '-basinline', type: 'line', source: VIS_SRC, filter: ['==', ['get', 'kind'], 'basin'],
      paint: { 'line-color': '#46c0e6', 'line-width': 1.6 } });
    map.addLayer({ id: VIS_SRC + '-crete', type: 'circle', source: VIS_SRC, filter: ['==', ['get', 'kind'], 'crete'],
      paint: { 'circle-radius': ['interpolate', ['linear'], ['get', 'deg'], 2, 3, 45, 8],
        'circle-color': ['match', ['get', 'blocker'], 'near', '#5aab6b', '#b8804f'],
        'circle-stroke-color': '#0b1017', 'circle-stroke-width': 1 } });
    map.addLayer({ id: VIS_SRC + '-hole', type: 'fill', source: VIS_SRC, filter: ['==', ['get', 'kind'], 'hole'],
      paint: { 'fill-color': '#f0a54a', 'fill-opacity': 0.18 } });
    map.addLayer({ id: VIS_SRC + '-holeline', type: 'line', source: VIS_SRC, filter: ['==', ['get', 'kind'], 'hole'],
      paint: { 'line-color': '#f0a54a', 'line-width': 1.6, 'line-dasharray': [2, 2] } });
    map.addLayer({ id: VIS_SRC + '-center', type: 'circle', source: VIS_SRC, filter: ['==', ['get', 'kind'], 'center'],
      paint: { 'circle-radius': 4, 'circle-color': '#e9eff7', 'circle-stroke-color': '#0b1017', 'circle-stroke-width': 1.5 } });
    if (!visionWired) {   // clic sur le fond (hors marqueur) → referme le cercle
      map.on('click', function () { if (!addMode && selectedSpotId) clearVision(); });
      visionWired = true;
    }
  }

  function ringFeature(lon, lat, radM) {
    var pts = [];
    for (var a = 0; a <= 360; a += 8) pts.push(destPoint(lon, lat, a, radM));
    return { type: 'Feature', properties: { kind: 'ring' }, geometry: { type: 'LineString', coordinates: pts } };
  }

  function discFeature(lon, lat, radM, kind) {   // polygone plein (trou du donut)
    var pts = [];
    for (var a = 0; a <= 360; a += 6) pts.push(destPoint(lon, lat, a, radM));
    pts.push(pts[0]);
    return { type: 'Feature', properties: { kind: kind || 'hole' }, geometry: { type: 'Polygon', coordinates: [pts] } };
  }

  function visionFeatures(spot) {
    var h = spot.horizon, lon = spot.lon, lat = spot.lat, MAXM = 30000, feats = [];
    for (var km = 5; km <= 30; km += 5) feats.push(ringFeature(lon, lat, km * 1000));
    if (h && h.azimuths && h.azimuths.length) {
      var poly = [];
      h.azimuths.forEach(function (o) {
        var dm = (o.horizon_deg >= 2) ? Math.min(o.dist_km * 1000, MAXM) : MAXM;
        poly.push(destPoint(lon, lat, o.az, dm));
      });
      poly.push(poly[0]);
      feats.push({ type: 'Feature', properties: { kind: 'basin' }, geometry: { type: 'Polygon', coordinates: [poly] } });
      h.azimuths.forEach(function (o) {
        if (o.horizon_deg < 2) return;
        var dm = (o.blocker === 'near' && o.near_dist_m) ? o.near_dist_m : o.dist_km * 1000;
        feats.push({ type: 'Feature', properties: { kind: 'crete', blocker: o.blocker || 'far', deg: o.horizon_deg },
          geometry: { type: 'Point', coordinates: destPoint(lon, lat, o.az, dm) } });
      });
    }
    var innerR = +(spot.inner_radius_m || (h && h.inner_radius_m) || 0);
    if (innerR > 0.5) feats.push(discFeature(lon, lat, innerR, 'hole'));
    feats.push({ type: 'Feature', properties: { kind: 'center' }, geometry: { type: 'Point', coordinates: [lon, lat] } });
    return { type: 'FeatureCollection', features: feats };
  }

  function showVision(spot) {
    if (typeof map === 'undefined') return;
    clearStormHighlight();   // une seule fiche à la fois (spot vs orage)
    ensureVisionLayers();
    var src = map.getSource(VIS_SRC);
    if (src) src.setData(visionFeatures(spot));
    selectedSpotId = spot.id;
    showPanel(spot);
    try {
      var b = new maplibregl.LngLatBounds();
      [0, 90, 180, 270].forEach(function (a) { b.extend(destPoint(spot.lon, spot.lat, a, 30000)); });
      map.fitBounds(b, { padding: 70, duration: 700, maxZoom: 11 });
    } catch (e) {}
  }

  function clearVision() {
    if (typeof map !== 'undefined' && map.getSource && map.getSource(VIS_SRC)) {
      map.getSource(VIS_SRC).setData({ type: 'FeatureCollection', features: [] });
    }
    selectedSpotId = null;
    closeGpsMenu();
    if (panelEl) panelEl.classList.remove('show');
  }

  // ══ CHASSE : « spots viables pour CETTE cellule orageuse » ══════════════════
  // Appelé par chase.js au clic d'une cellule suivie (/api/radar/fr/cells). Croise la
  // position + le cap/vitesse de l'orage avec l'horizon DIRECTIONNEL de chaque spot :
  // un spot est viable s'il est à BONNE DISTANCE et DÉGAGÉ DANS LA DIRECTION de l'orage.
  var STORM_SRC = 'ofspot-storm', stormPanelEl = null, stormPulseRAF = null, stormPulseLast = 0, stormActive = false;
  var STORM_MAX = 6;   // nb max de spots mis en avant

  function escapeHtml(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }

  // horizon moyen (°) + crête la plus proche DANS le cap az (secteur ±22,5°).
  function horizonTowardAz(h, az) {
    if (!h || !h.azimuths || !h.azimuths.length) return { deg: 18, near: false, dist_km: 0 };
    var sep = function (a) { return Math.abs(((a.az - az + 180) % 360 + 360) % 360 - 180); };
    var vals = h.azimuths.filter(function (a) { return sep(a) <= 22.5; });
    if (!vals.length) {
      var best = null, bd = 1e9;
      h.azimuths.forEach(function (a) { var d = sep(a); if (d < bd) { bd = d; best = a; } });
      vals = best ? [best] : [];
    }
    if (!vals.length) return { deg: 18, near: false, dist_km: 0 };
    var deg = vals.reduce(function (s, a) { return s + (a.horizon_deg || 0); }, 0) / vals.length;
    var near = vals.some(function (a) { return a.blocker === 'near' && (a.horizon_deg || 0) > 5; });
    var dmin = Math.min.apply(null, vals.map(function (a) { return (a.dist_km != null ? a.dist_km : 30); }));
    return { deg: deg, near: near, dist_km: dmin };
  }

  // Approche : plus courte distance orage↔spot le long du vecteur de déplacement
  // (même math que le « ETA sur ta position » de chase.js). ETA en minutes si l'orage
  // se rapproche vraiment (t* dans le futur, à ≤ 2,5 h).
  function stormApproach(spot, cell) {
    if (!cell.speed_kmh || cell.speed_kmh <= 8 || cell.bearing == null) return { closing: false, etaMin: null, missKm: null };
    var br = cell.bearing * Math.PI / 180;
    var vN = cell.speed_kmh * Math.cos(br), vE = cell.speed_kmh * Math.sin(br);
    var dN = (spot.lat - cell.lat) * 111.0;
    var dE = (spot.lon - cell.lon) * 111.0 * Math.cos(spot.lat * Math.PI / 180);
    var v2 = vN * vN + vE * vE || 1e-9;
    var tStar = (dN * vN + dE * vE) / v2;                       // heures jusqu'au plus près
    var missKm = Math.hypot(dN - vN * tStar, dE - vE * tStar);
    // « se rapproche » = point le plus proche DEVANT (≤ 2,5 h) ET passage à ≤ 30 km
    // (sinon l'orage file à côté → pas d'ETA trompeur).
    var closing = tStar > 0 && tStar <= 2.5 && missKm <= 30;
    return { closing: closing, etaMin: closing ? Math.max(1, Math.round(tStar * 60)) : null, missKm: Math.round(missKm) };
  }

  function scoreSpotForStorm(spot, cell) {
    if (typeof spot.lon !== 'number' || typeof spot.lat !== 'number') return null;
    var clat = Math.cos(spot.lat * Math.PI / 180);
    var dE = (cell.lon - spot.lon) * 111.32 * clat;
    var dN = (cell.lat - spot.lat) * 110.574;
    var km = Math.sqrt(dE * dE + dN * dN);
    var az = (Math.atan2(dE, dN) * 180 / Math.PI + 360) % 360;  // cap spot → orage
    var clr = horizonTowardAz(spot.horizon, az);
    // fenêtre de distance : idéale ~15-40 km, nulle < 6 km (sous l'orage) ou > 70 km (trop loin)
    var distScore;
    if (km < 6 || km > 70) distScore = 0;
    else if (km <= 25) distScore = (km - 6) / 19;
    else distScore = Math.max(0, (70 - km) / 45);
    var clearScore = Math.max(0, Math.min(1, 1 - clr.deg / 18));
    var appr = stormApproach(spot, cell);
    var score = Math.round(100 * Math.max(0, Math.min(1, 0.56 * clearScore + 0.34 * distScore + (appr.closing ? 0.10 : 0))));
    // viable = à bonne distance ET dégagé vers l'orage (pas d'obstruction proche dans ce cap)
    var viable = distScore > 0 && clr.deg <= 11 && !clr.near;
    return { spot: spot, km: km, az: az, cardinal: cardinal(az), clearanceDeg: clr.deg,
             blockedNear: clr.near, approach: appr, score: score, viable: viable };
  }

  function ensureStormLayers() {
    if (typeof map === 'undefined' || typeof map.getSource !== 'function' || map.getSource(STORM_SRC)) return;
    map.addSource(STORM_SRC, { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
    map.addLayer({ id: STORM_SRC + '-link', type: 'line', source: STORM_SRC, filter: ['==', ['get', 'kind'], 'link'],
      layout: { 'line-cap': 'round' },
      paint: { 'line-color': '#ffb038', 'line-width': ['interpolate', ['linear'], ['get', 'score'], 0, 1.2, 100, 3.4],
               'line-opacity': 0.75, 'line-dasharray': [1.6, 1.2] } });
    map.addLayer({ id: STORM_SRC + '-glow', type: 'circle', source: STORM_SRC, filter: ['==', ['get', 'kind'], 'spot'],
      paint: { 'circle-radius': 15, 'circle-color': ['get', 'color'], 'circle-blur': 1, 'circle-opacity': 0.4 } });
    map.addLayer({ id: STORM_SRC + '-spot', type: 'circle', source: STORM_SRC, filter: ['==', ['get', 'kind'], 'spot'],
      paint: { 'circle-radius': 6.5, 'circle-color': ['get', 'color'], 'circle-stroke-color': '#0c1118', 'circle-stroke-width': 1.6, 'circle-opacity': 0.98 } });
    map.addLayer({ id: STORM_SRC + '-cellglow', type: 'circle', source: STORM_SRC, filter: ['==', ['get', 'kind'], 'cell'],
      paint: { 'circle-radius': 16, 'circle-color': '#ff4d4d', 'circle-blur': 1, 'circle-opacity': 0.45 } });
    map.addLayer({ id: STORM_SRC + '-cell', type: 'circle', source: STORM_SRC, filter: ['==', ['get', 'kind'], 'cell'],
      paint: { 'circle-radius': 6, 'circle-color': '#ff6a6a', 'circle-stroke-color': '#3a0000', 'circle-stroke-width': 1.6 } });
  }

  function stormPulseTick(t) {
    if (!stormActive) { stormPulseRAF = null; return; }
    if (t - stormPulseLast >= 45) {
      stormPulseLast = t;
      var k = 0.5 + 0.5 * Math.sin(t / 1000 * 2.4);
      try {
        if (map.getLayer(STORM_SRC + '-cellglow')) map.setPaintProperty(STORM_SRC + '-cellglow', 'circle-radius', 13 + 8 * k);
        if (map.getLayer(STORM_SRC + '-glow')) map.setPaintProperty(STORM_SRC + '-glow', 'circle-opacity', 0.22 + 0.32 * k);
      } catch (e) {}
    }
    stormPulseRAF = requestAnimationFrame(stormPulseTick);
  }
  function startStormPulse() { if (stormPulseRAF == null) { stormPulseLast = 0; stormPulseRAF = requestAnimationFrame(stormPulseTick); } }
  function stopStormPulse() { if (stormPulseRAF != null) { cancelAnimationFrame(stormPulseRAF); stormPulseRAF = null; } }

  function focusStormSpot(spot) {
    try { map.flyTo({ center: [spot.lon, spot.lat], zoom: Math.max(map.getZoom ? map.getZoom() : 8, 9), duration: 650 }); } catch (e) {}
  }

  function showStormPanel(cell, picks) {
    if (!stormPanelEl) { stormPanelEl = document.createElement('div'); stormPanelEl.className = 'ofspot-storm-panel'; stormPanelEl.id = 'ofspotStormPanel'; document.body.appendChild(stormPanelEl); }
    stormPanelEl.innerHTML = '';
    var close = document.createElement('button'); close.type = 'button'; close.className = 'ofspot-panel-close'; close.setAttribute('aria-label', 'Fermer'); close.textContent = '×';
    close.addEventListener('click', clearStormHighlight);
    stormPanelEl.appendChild(close);
    var head = document.createElement('div'); head.className = 'ofspot-storm-head';
    var mv = (cell.speed_kmh > 5) ? (cell.speed_kmh + ' km/h ' + cardinal(cell.bearing)) : 'quasi statique';
    head.innerHTML = '<span class="ofspot-storm-title">⛈ Spots pour cette cellule</span>' +
      '<span class="ofspot-storm-sub">' + mv + (cell.peak_dbz != null ? ' · ' + Math.round(cell.peak_dbz) + ' dBZ' : '') + '</span>';
    stormPanelEl.appendChild(head);
    if (!picks.length) {
      var empty = document.createElement('div'); empty.className = 'ofspot-storm-empty';
      empty.textContent = spotsData.length ? 'Aucun spot dégagé et bien placé pour cette cellule.' : 'Aucun spot enregistré pour l’instant.';
      stormPanelEl.appendChild(empty);
    } else {
      var list = document.createElement('div'); list.className = 'ofspot-storm-list';
      picks.forEach(function (p, i) {
        var col = scoreColor(p.score);
        var appr = (p.approach && p.approach.closing) ? (' · arrive ~' + p.approach.etaMin + ' min') : '';
        var clearTxt = p.clearanceDeg <= 4 ? 'très dégagé' : (p.clearanceDeg <= 8 ? 'dégagé' : 'passable');
        var row = document.createElement('button'); row.type = 'button'; row.className = 'ofspot-storm-row';
        // 2 lignes compactes (lisible même en colonnes étroites) : distance+cap / dégagement+ETA
        row.innerHTML = '<span class="ofspot-storm-rank" style="color:' + col + ';background:' + col + '22">' + (i + 1) + '</span>' +
          '<span class="ofspot-storm-info"><b>' + escapeHtml(p.spot.name) + '</b>' +
          '<small>' + Math.round(p.km) + ' km · ' + p.cardinal + '</small>' +
          '<small>' + clearTxt + appr + '</small></span>' +
          '<span class="ofspot-storm-score" style="color:' + col + '">' + p.score + '</span>';
        row.addEventListener('click', function () { focusStormSpot(p.spot); });
        list.appendChild(row);
      });
      stormPanelEl.appendChild(list);
    }
    stormPanelEl.classList.add('show');
  }

  // API publique appelée par chase.js au clic d'une cellule.
  function highlightStorm(cell) {
    if (!cell || typeof map === 'undefined' || typeof map.getSource !== 'function') return;
    clearVision();   // une seule fiche à la fois (spot vs orage)
    ensureStormLayers();
    var scored = [], pool = renderList();   // publics + mes spots (mes perso comptent aussi)
    for (var i = 0; i < pool.length; i++) {
      var r = scoreSpotForStorm(pool[i], cell);
      if (r && r.viable) scored.push(r);
    }
    scored.sort(function (a, b) { return b.score - a.score; });
    var picks = scored.slice(0, STORM_MAX);
    var feats = [{ type: 'Feature', properties: { kind: 'cell' }, geometry: { type: 'Point', coordinates: [cell.lon, cell.lat] } }];
    picks.forEach(function (p) {
      feats.push({ type: 'Feature', properties: { kind: 'link', score: p.score },
        geometry: { type: 'LineString', coordinates: [[p.spot.lon, p.spot.lat], [cell.lon, cell.lat]] } });
      feats.push({ type: 'Feature', properties: { kind: 'spot', score: p.score, color: scoreColor(p.score) },
        geometry: { type: 'Point', coordinates: [p.spot.lon, p.spot.lat] } });
    });
    var src = map.getSource(STORM_SRC);
    if (src) { try { src.setData({ type: 'FeatureCollection', features: feats }); } catch (e) {} }
    stormActive = true;
    startStormPulse();
    showStormPanel(cell, picks);
  }

  function clearStormHighlight() {
    stormActive = false;
    stopStormPulse();
    if (typeof map !== 'undefined' && map.getSource && map.getSource(STORM_SRC)) {
      try { map.getSource(STORM_SRC).setData({ type: 'FeatureCollection', features: [] }); } catch (e) {}
    }
    if (stormPanelEl) stormPanelEl.classList.remove('show');
  }

  // ── actions propriétaire (mes spots) ───────────────────────────────────────
  function jpost(path) {
    return fetch(path, { method: 'POST', credentials: 'same-origin' })
      .then(function (r) { return r.json().catch(function () { return { ok: false }; }); });
  }

  // Rafraîchit la carte + la fiche ouverte + la table après une action propriétaire.
  function afterOwnerChange(keepId) {
    return loadSpots().then(function () {
      renderTable();
      if (keepId) {
        var next = mineData.concat(spotsData).filter(function (s) { return s.id === keepId; })[0];
        if (next) { next._mine = mineData.some(function (m) { return m.id === keepId; }); showVision(next); }
        else clearVision();
      }
    });
  }

  function ownerActions(spot) {
    var wrap = document.createElement('div'); wrap.className = 'ofspot-owner';
    var st = spot.status;
    // Partager (perso/refusé) OU Rendre privé (en validation/public).
    var shareBtn = document.createElement('button'); shareBtn.type = 'button'; shareBtn.className = 'ofspot-owner-btn primary';
    if (st === 'private' || st === 'rejected') {
      shareBtn.textContent = 'Proposer au public';
      shareBtn.addEventListener('click', function () {
        shareBtn.disabled = true;
        jpost('/api/spots/' + spot.id + '/share').then(function (r) {
          if (r && r.ok) { toast('Spot proposé — en attente de validation ✓', 4200); afterOwnerChange(spot.id); }
          else { shareBtn.disabled = false; toast((r && r.error) || 'Échec du partage.'); }
        });
      });
    } else {
      shareBtn.textContent = (st === 'approved') ? 'Retirer du public' : 'Annuler la proposition';
      shareBtn.addEventListener('click', function () {
        shareBtn.disabled = true;
        jpost('/api/spots/' + spot.id + '/unshare').then(function (r) {
          if (r && r.ok) { toast('Spot redevenu privé ✓'); afterOwnerChange(spot.id); }
          else { shareBtn.disabled = false; toast((r && r.error) || 'Échec.'); }
        });
      });
    }
    var edit = document.createElement('button'); edit.type = 'button'; edit.className = 'ofspot-owner-btn';
    edit.textContent = 'Modifier';
    edit.addEventListener('click', function () { openEditForm(spot, { owner: true }); });
    var del = document.createElement('button'); del.type = 'button'; del.className = 'ofspot-owner-btn del';
    del.textContent = 'Supprimer';
    del.addEventListener('click', function () { ownerDeleteSpot(spot); });
    wrap.append(shareBtn, edit, del);
    return wrap;
  }

  function ownerDeleteSpot(spot) {
    if (!confirm('Supprimer le spot « ' + spot.name + ' » ? Cette action est définitive.')) return;
    fetch('/api/spots/' + spot.id + '/owner', { method: 'DELETE', credentials: 'same-origin' })
      .then(function (r) { return r.json().catch(function () { return { ok: false }; }); })
      .then(function (r) {
        if (r && r.ok) { clearVision(); toast('Spot supprimé ✓'); loadSpots().then(renderTable); }
        else toast((r && r.error) || 'Échec de la suppression.');
      }).catch(function () { toast('Réseau indisponible.'); });
  }

  // Horizon (°) du spot dans la direction az, interpolé entre les 24 azimuts LiDAR.
  function panoHorizonAt(azArr, az) {
    var n = azArr.length; if (!n) return 0;
    az = ((az % 360) + 360) % 360; var step = 360 / n;
    var i = Math.floor(az / step) % n, j = (i + 1) % n, f = (az - i * step) / step;
    var a = azArr[i].horizon_deg || 0, b = azArr[j].horizon_deg || 0;
    return a + (b - a) * f;
  }
  // Panorama 360° synthétisé du LiDAR (relief) + overlay astro (Voie lactée/Lune/planètes/étoiles,
  // via window.OFSky exposé par stargaze.js), avec curseur d'heure pour scruter la nuit.
  function renderSpotPanorama(spot) {
    var h = spot.horizon; if (!h || !h.azimuths || !h.azimuths.length) return null;
    var az = h.azimuths.slice().sort(function (a, b) { return a.az - b.az; });
    var W = 720, yB = 196, yTop = 16, MAXDEG = 45, lat = +spot.lat, lon = +spot.lon;
    var wrap = document.createElement('div'); wrap.className = 'ofspot-pano';
    var head = document.createElement('div'); head.className = 'ofspot-pano-h';
    head.innerHTML = '<span>Tour d’horizon 360°</span><span class="ofspot-pano-t" id="ofPanoT"></span>';
    wrap.appendChild(head);
    var svg = el('svg', { viewBox: '0 0 ' + W + ' 218', class: 'ofspot-pano-svg' }); wrap.appendChild(svg);
    var read = document.createElement('div'); read.className = 'ofspot-pano-read'; read.textContent = 'Survole le relief · glisse le curseur pour changer l’heure';
    wrap.appendChild(read);
    var sl = document.createElement('input'); sl.type = 'range'; sl.min = '0'; sl.max = '12'; sl.step = '1'; sl.value = '5'; sl.className = 'ofspot-pano-slider';
    sl.setAttribute('aria-label', 'Heure de la nuit'); wrap.appendChild(sl);
    function nightMs(idx) { var d = new Date(); d.setHours(18, 0, 0, 0); return d.getTime() + idx * 3600000; }
    function yOf(deg) { var dd = Math.max(0, Math.min(MAXDEG, deg)); return yB - dd / MAXDEG * (yB - yTop); }
    function drawAstro(ms) {
      var S = window.OFSky; if (!S) return;
      var seg = [];
      var flush = function () {
        if (seg.length > 1) {
          svg.appendChild(el('polyline', { points: seg.join(' '), fill: 'none', stroke: '#9bb6e8', 'stroke-width': 11, opacity: 0.13, 'stroke-linecap': 'round' }));
          svg.appendChild(el('polyline', { points: seg.join(' '), fill: 'none', stroke: '#cfe0ff', 'stroke-width': 2, opacity: 0.28, 'stroke-linecap': 'round' }));
        }
        seg = [];
      };
      for (var l = 0; l <= 360; l += 3) { var gr = S.galToRadec(l, 0), aa = S.altaz(gr.ra, gr.dec, ms, lat, lon); if (aa.alt > 0 && aa.alt < MAXDEG) seg.push((aa.az * 2).toFixed(1) + ',' + yOf(aa.alt).toFixed(1)); else flush(); }
      flush();
      var label = function (x, y, t, below) { var tx = el('text', { x: x + 5, y: y - 4, fill: below ? 'rgba(232,114,90,.75)' : 'rgba(207,224,255,.85)', 'font-size': 9, 'font-family': 'ui-monospace,monospace' }); tx.textContent = t; svg.appendChild(tx); };
      var plot = function (name, ra, dec, kind, mag) {
        var aa = S.altaz(ra, dec, ms, lat, lon); if (aa.alt <= 0 || aa.alt >= MAXDEG) return;
        var x = aa.az * 2, y = yOf(aa.alt), below = aa.alt < panoHorizonAt(az, aa.az);
        if (kind === 'moon') svg.appendChild(el('circle', { cx: x, cy: y, r: 6, fill: '#e6ecf4', opacity: below ? 0.4 : 0.95 }));
        else if (kind === 'sun') svg.appendChild(el('circle', { cx: x, cy: y, r: 7, fill: '#ffd36b', opacity: below ? 0.4 : 0.95 }));
        else if (kind === 'planet') { svg.appendChild(el('circle', { cx: x, cy: y, r: 3.2, fill: '#ffd9a0', opacity: below ? 0.35 : 0.95 })); label(x, y, name, below); }
        else { var r = Math.max(1, 2.6 - (mag || 1) * 0.5); svg.appendChild(el('circle', { cx: x, cy: y, r: r, fill: '#eaf2ff', opacity: below ? 0.25 : 0.9 })); if ((mag == null ? 9 : mag) < 0.5) label(x, y, name, below); }
        if (below) svg.appendChild(el('circle', { cx: x, cy: y, r: (kind === 'moon' || kind === 'sun') ? 8 : 4, fill: 'none', stroke: '#e8725a', 'stroke-width': 1, opacity: 0.5 }));
      };
      S.stars.forEach(function (s) { plot(s[0], s[1], s[2], 'star', s[3]); });
      S.planets.forEach(function (nm) { var pr = S.planetRadec(nm, ms); plot(nm, pr.ra, pr.dec, 'planet'); });
      var sr = S.sunRadec(ms); plot('Soleil', sr.ra, sr.dec, 'sun');
      var mo = S.moonRadec(ms); plot('Lune', mo.ra, mo.dec, 'moon');
    }
    function draw() {
      var ms = nightMs(+sl.value); svg.innerHTML = '';
      var defs = el('defs', {}), g = el('linearGradient', { id: 'ofpsky', x1: 0, y1: 0, x2: 0, y2: 1 });
      g.appendChild(el('stop', { offset: '0%', 'stop-color': '#0a1430' })); g.appendChild(el('stop', { offset: '100%', 'stop-color': '#16233a' }));
      defs.appendChild(g); svg.appendChild(defs);
      svg.appendChild(el('rect', { x: 0, y: 0, width: W, height: yB, fill: 'url(#ofpsky)' }));
      [15, 30].forEach(function (dd) { var y = yOf(dd); svg.appendChild(el('line', { x1: 0, y1: y, x2: W, y2: y, stroke: 'rgba(160,185,230,.14)', 'stroke-width': 1, 'stroke-dasharray': '2 5' })); });
      drawAstro(ms);
      var pts = az.map(function (p) { return { x: p.az * 2, y: yOf(p.horizon_deg), blk: p.blocker }; }); pts.push({ x: 720, y: pts[0].y, blk: pts[0].blk });
      var d = 'M 0 ' + yB; pts.forEach(function (p) { d += ' L ' + p.x.toFixed(1) + ' ' + p.y.toFixed(1); }); d += ' L ' + W + ' ' + yB + ' Z';
      svg.appendChild(el('path', { d: d, fill: '#070c14', opacity: 0.97 }));
      for (var k = 0; k < pts.length - 1; k++) { var col = pts[k].blk === 'near' ? '#5aab6b' : '#c79461'; svg.appendChild(el('line', { x1: pts[k].x.toFixed(1), y1: pts[k].y.toFixed(1), x2: pts[k + 1].x.toFixed(1), y2: pts[k + 1].y.toFixed(1), stroke: col, 'stroke-width': 2.2, 'stroke-linecap': 'round' })); }
      svg.appendChild(el('line', { x1: 0, y1: yB, x2: W, y2: yB, stroke: 'rgba(160,185,230,.3)', 'stroke-width': 1 }));
      [['N', 0], ['NE', 45], ['E', 90], ['SE', 135], ['S', 180], ['SO', 225], ['O', 270], ['NO', 315], ['N', 360]].forEach(function (c) {
        var x = c[1] * 2; svg.appendChild(el('line', { x1: x, y1: yB, x2: x, y2: yB + 6, stroke: 'rgba(160,185,230,.45)', 'stroke-width': 1 }));
        var tx = el('text', { x: x, y: yB + 18, fill: '#8ba0b8', 'font-size': 12, 'font-weight': 700, 'text-anchor': 'middle', 'font-family': 'ui-monospace,monospace' }); tx.textContent = c[0]; svg.appendChild(tx);
      });
      var hh = new Date(ms), t = wrap.querySelector('#ofPanoT'); if (t) t.textContent = ('0' + hh.getHours()).slice(-2) + 'h';
    }
    svg.addEventListener('mousemove', function (ev) {
      var r = svg.getBoundingClientRect(), xv = Math.max(0, Math.min(W, (ev.clientX - r.left) / r.width * W)), azd = xv / 2, deg = panoHorizonAt(az, azd);
      var cardn = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSO', 'SO', 'OSO', 'O', 'ONO', 'NO', 'NNO'][Math.round(azd / 22.5) % 16];
      read.textContent = cardn + ' (' + Math.round(azd) + '°) · ' + (deg <= 0 ? 'horizon dégagé' : 'relief à ' + deg.toFixed(0) + '°');
    });
    sl.addEventListener('input', draw);
    draw();
    return wrap;
  }

  function showPanel(spot) {
    var h = spot.horizon || null;
    if (!panelEl) { panelEl = document.createElement('div'); panelEl.className = 'ofspot-panel'; panelEl.id = 'ofspotPanel'; document.body.appendChild(panelEl); }
    panelEl.innerHTML = '';
    var close = document.createElement('button'); close.type = 'button'; close.className = 'ofspot-panel-close'; close.setAttribute('aria-label', 'Fermer'); close.textContent = '×';
    close.addEventListener('click', clearVision);
    panelEl.appendChild(close);
    var head = document.createElement('div'); head.className = 'ofspot-head';
    var nm = document.createElement('div'); nm.className = 'ofspot-name'; nm.textContent = spot.name; head.appendChild(nm);
    if (h) {
      var badge = document.createElement('span'); badge.className = 'ofspot-badge';
      badge.style.color = scoreColor(h.openness); badge.style.background = scoreColor(h.openness) + '22';
      badge.textContent = Math.round(h.openness) + '/100 · ' + scoreLabel(h.openness); head.appendChild(badge);
    }
    panelEl.appendChild(head);
    // Auteur (spot public d'un autre compte) ou statut (mon spot).
    if (spot._mine) {
      var sm = statusMeta(spot.status);
      var chip = document.createElement('div'); chip.className = 'ofspot-status ofspot-status--' + sm.cls;
      chip.innerHTML = '<b>' + sm.label + '</b><span>' + sm.hint + '</span>';
      panelEl.appendChild(chip);
    } else if (spot.author_pseudo) {
      var by = document.createElement('div'); by.className = 'ofspot-author';
      by.textContent = 'Proposé par ' + spot.author_pseudo;
      panelEl.appendChild(by);
    }
    if (h && h.azimuths) {
      var stats = document.createElement('div'); stats.className = 'ofspot-stats';
      stats.innerHTML = statCell('Altitude', Math.round(h.z0) + ' m') +
        statCell('Horizon moyen', (h.mean_horizon_deg >= 0 ? '+' : '') + h.mean_horizon_deg + '°') +
        statCell('Ciel bas dégagé', h.pct_below_5deg + ' %') +
        statCell('Relief autour', '+' + (h.denivele_max_m || 0) + ' m') +
        (accessFull(spot) ? statCell('Route carrossable', accessFull(spot)) : '');
      panelEl.appendChild(stats);
      panelEl.appendChild(buildNearLine(h));
      var leg = document.createElement('div'); leg.className = 'ofspot-panel-legend';
      leg.innerHTML = '<span><i style="background:#46c0e6"></i>ciel dégagé</span>' +
        '<span><i style="background:#b8804f"></i>relief</span>' +
        '<span><i style="background:#5aab6b"></i>obstruction proche</span>';
      panelEl.appendChild(leg);
      var pano = renderSpotPanorama(spot); if (pano) panelEl.appendChild(pano);
    } else {
      var pend = document.createElement('div'); pend.className = 'ofspot-pending';
      pend.textContent = 'Champ de vision en cours de calcul…'; panelEl.appendChild(pend);
    }
    if (spot.notes) { var nt = document.createElement('div'); nt.className = 'ofspot-notes'; nt.textContent = spot.notes; panelEl.appendChild(nt); }
    // « Y aller » (itinéraire GPS) + distance depuis ma position si géolocalisé.
    var pgo = document.createElement('div'); pgo.className = 'ofspot-panel-go';
    var pkm = spotKm(spot);
    if (pkm != null) { var pks = document.createElement('span'); pks.className = 'ofspot-panel-km'; pks.textContent = kmTxt(pkm) + ' de moi'; pgo.appendChild(pks); }
    pgo.appendChild(gpsButton(spot, 'ofspot-panel-go-btn'));
    panelEl.appendChild(pgo);
    if (spot._mine) panelEl.appendChild(ownerActions(spot));
    if (isAdmin()) {
      var acts = document.createElement('div'); acts.className = 'ofspot-panel-admin';
      var edit = document.createElement('button'); edit.type = 'button'; edit.className = 'ofspot-panel-abtn';
      edit.textContent = 'Modifier';
      edit.addEventListener('click', function () { openEditForm(spot); });
      var del = document.createElement('button'); del.type = 'button'; del.className = 'ofspot-panel-abtn del';
      del.textContent = 'Supprimer';
      del.addEventListener('click', function () { deleteSpot(spot); });
      acts.append(edit, del);
      panelEl.appendChild(acts);
    }
    panelEl.classList.add('show');
  }

  function clearMarkers() { markers.forEach(function (m) { m.remove(); }); markers = []; }

  function render(spots) {
    clearMarkers();
    if (typeof maplibregl === 'undefined' || typeof map === 'undefined') return;
    spots.forEach(function (spot) {
      if (typeof spot.lon !== 'number' || typeof spot.lat !== 'number') return;
      var e = pinEl(spot), lngLat = [spot.lon, spot.lat];
      // En mode étoile, le clic d'un spot ouvre la modale « dôme céleste » (hook stargaze.js).
      e.addEventListener('click', function (ev) { ev.stopPropagation(); if (typeof window.sgOnSpotClick === 'function' && window.sgOnSpotClick(spot)) return; showVision(spot); });
      e.addEventListener('keydown', function (ev) { if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); if (typeof window.sgOnSpotClick === 'function' && window.sgOnSpotClick(spot)) return; showVision(spot); } });
      if (spot._mine) {
        var sm = statusMeta(spot.status);
        e.classList.add('is-mine', 'is-' + sm.cls);
        e.setAttribute('data-status', spot.status || '');
        if (spot.status && spot.status !== 'approved') {   // perso/en validation → pastille de statut
          var dot = document.createElement('span'); dot.className = 'ofspot-pin-badge'; dot.setAttribute('aria-hidden', 'true');
          dot.textContent = spot.status === 'private' ? '★' : (spot.status === 'pending' ? '⏳' : '⌀');
          e.appendChild(dot);
        }
      }
      var mk = new maplibregl.Marker({ element: e, anchor: 'center' }).setLngLat(lngLat).addTo(map);
      // MapLibre force aria-label="Map marker" sur l'élément → on rétablit l'aria enrichi (avec directions)
      e.setAttribute('aria-label', (e._ofLabel || ('Spot ' + spot.name)) + (spot._mine ? ' (mon spot — ' + statusMeta(spot.status).label + ')' : ''));
      if (e._ofTitle) e.title = e._ofTitle + (spot._mine ? ' · ' + statusMeta(spot.status).label : '');
      e.setAttribute('data-spot-id', spot.id);
      markers.push(mk);
    });
    applyVisibility();
  }

  function applyVisibility() {
    markers.forEach(function (m) { m.getElement().style.display = visible ? '' : 'none'; });
  }

  function loadSpots() {
    var pub = fetch('/api/spots').then(function (r) { return r.json(); }).catch(function () { return null; });
    // Mes spots (privés + partagés) — 403/erreur si non connecté : silencieux, non bloquant.
    var mine = fetch('/api/spots/mine', { credentials: 'same-origin' })
      .then(function (r) { return r.json(); }).catch(function () { return null; });
    return Promise.all([pub, mine]).then(function (res) {
      var dp = res[0], dm = res[1];
      if (dp && dp.ok && Array.isArray(dp.spots)) { loaded = true; spotsData = dp.spots; }
      account.loggedIn = !!(dm && dm.ok);
      mineData = (dm && dm.ok && Array.isArray(dm.spots)) ? dm.spots : [];
      render(renderList());
      return dp;
    });
  }

  // ── page « Mes spots » (onglet rail, style page Historique) ────────────────
  function openSpotsPage() {
    var pg = document.getElementById('spotsListPage');
    if (!pg) return;
    pg.setAttribute('aria-hidden', 'false');
    document.body.classList.add('spots-open');
    discoverClearMarkers();                // repartir sans les pins d'une recherche précédente
    renderTable();                         // rendu immédiat avec les données courantes
    loadSpots().then(function () { renderTable(); });   // puis rafraîchi
  }

  function closeSpotsPage() {
    var pg = document.getElementById('spotsListPage');
    if (pg) pg.setAttribute('aria-hidden', 'true');
    document.body.classList.remove('spots-open');
    closeGpsMenu();
  }

  // admin : classe objf-admin posée par account.js selon /api/account/me (is_admin)
  function isAdmin() { try { return document.documentElement.classList.contains('objf-admin'); } catch (e) { return false; } }
  // Admin = compte connecté (classe objf-admin) ; requêtes authentifiées par le cookie de session.

  function moderate(spotId, action, row) {
    var qs = '?action=' + action;
    if (row) row.style.opacity = '.5';
    return fetch('/api/spots/' + spotId + '/moderate' + qs, { method: 'POST' })
      .then(function (r) { return r.json().catch(function () { return { ok: false }; }); })
      .then(function (res) {
        toast(res && res.ok ? (action === 'approve' ? 'Spot approuvé ✓' : action === 'reject' ? 'Spot rejeté' : 'Spot supprimé')
                            : ((res && res.error) || 'Action refusée.'));
        return loadSpots().then(function () { renderTable(); });
      })
      .catch(function () { if (row) row.style.opacity = ''; toast('Réseau indisponible.'); });
  }

  function renderModeration(container) {
    if (!isAdmin()) return;
    var sec = document.createElement('section'); sec.className = 'ofspot-mod';
    sec.setAttribute('aria-label', 'Modération des spots');
    sec.textContent = 'Chargement des spots en attente…';
    container.appendChild(sec);
    fetch('/api/spots/pending')
      .then(function (r) { return r.ok ? r.json() : { ok: false, status: r.status }; })
      .then(function (d) {
        sec.innerHTML = '';
        if (!d || !d.ok) { sec.className = 'ofspot-mod ofspot-mod-err'; sec.textContent = 'Modération inaccessible (secret admin invalide ?).'; return; }
        var pend = d.spots || [];
        var head = document.createElement('div'); head.className = 'ofspot-mod-head';
        var hl = document.createElement('span'); hl.className = 'ofspot-mod-title'; hl.textContent = 'Modération';
        var hb = document.createElement('span'); hb.className = 'ofspot-mod-badge'; hb.textContent = pend.length + ' en attente';
        var rec = document.createElement('button'); rec.type = 'button'; rec.className = 'ofspot-mod-btn ofspot-rec';
        rec.textContent = 'Recalculer'; rec.title = 'Recalculer l\'horizon de tous les spots (obstruction proche incluse)';
        rec.addEventListener('click', recomputeAll);
        var imp = document.createElement('button'); imp.type = 'button'; imp.className = 'ofspot-mod-btn ofspot-imp';
        imp.textContent = 'Importer un fichier';
        imp.addEventListener('click', openImportPicker);
        head.append(hl, hb, rec, imp);
        sec.appendChild(head);
        if (!pend.length) { var e = document.createElement('div'); e.className = 'ofspot-mod-empty'; e.textContent = 'Rien à valider pour l\'instant.'; sec.appendChild(e); return; }
        pend.forEach(function (s) { sec.appendChild(modRow(s)); });
      })
      .catch(function () { sec.className = 'ofspot-mod ofspot-mod-err'; sec.textContent = 'Modération indisponible.'; });
  }

  function modRow(s) {
    var row = document.createElement('div'); row.className = 'ofspot-mod-row';
    var info = document.createElement('div'); info.className = 'ofspot-mod-info';
    var nm = document.createElement('div'); nm.className = 'ofspot-mod-name'; nm.textContent = s.name;
    var meta = document.createElement('div'); meta.className = 'ofspot-mod-meta';
    meta.textContent = s.lat.toFixed(4) + ', ' + s.lon.toFixed(4) + (s.notes ? ' · ' + s.notes : '');
    info.append(nm, meta);
    var acts = document.createElement('div'); acts.className = 'ofspot-mod-acts';
    [['approve', 'Approuver'], ['reject', 'Rejeter'], ['delete', 'Supprimer']].forEach(function (a) {
      var b = document.createElement('button'); b.type = 'button'; b.className = 'ofspot-mod-btn mod-' + a[0];
      b.textContent = a[1];
      b.addEventListener('click', function () { moderate(s.id, a[0], row); });
      acts.appendChild(b);
    });
    row.append(info, acts);
    return row;
  }

  // recalcul de tous les horizons (admin) — ex. après ajout de l'obstruction proche
  function recomputeAll() {
    if (!confirm('Recalculer l\'horizon de tous les spots (obstruction proche incluse) ? Quelques minutes en arrière-plan.')) return;
    toast('Recalcul lancé…');
    fetch('/api/spots/recompute', { method: 'POST' })
      .then(function (r) { return r.ok ? r.json() : { ok: false }; })
      .then(function (res) { toast(res && res.ok ? (res.recomputing + ' spots en recalcul…') : 'Refusé (secret admin ?)', 4500); })
      .catch(function () { toast('Réseau indisponible.'); });
  }

  // import de fichier (admin) : JSON [{name,lon,lat,note}] ou {spots:[…]}
  function openImportPicker() {
    var inp = document.createElement('input');
    inp.type = 'file'; inp.accept = '.json,application/json';
    inp.addEventListener('change', function () { if (inp.files && inp.files[0]) handleImportFile(inp.files[0]); });
    inp.click();
  }

  function handleImportFile(file) {
    var reader = new FileReader();
    reader.onload = function () {
      var arr;
      try {
        var parsed = JSON.parse(reader.result);
        arr = Array.isArray(parsed) ? parsed : (parsed && Array.isArray(parsed.spots) ? parsed.spots : null);
      } catch (e) { toast('Fichier JSON illisible.'); return; }
      if (!arr || !arr.length) { toast('Aucun spot dans le fichier.'); return; }
      var payloadSpots = arr.map(function (p) {
        return { name: p.name, lon: Number(p.lon), lat: Number(p.lat), notes: (p.notes != null ? p.notes : (p.note || '')) };
      }).filter(function (p) { return p.name && Number.isFinite(p.lon) && Number.isFinite(p.lat); });
      if (!payloadSpots.length) { toast('Format non reconnu (attendu : name, lon, lat).'); return; }
      if (!confirm('Importer ' + payloadSpots.length + ' spot(s) comme APPROUVÉS (visibles publiquement) ?')) return;
      toast('Import en cours…');
      fetch('/api/spots/import', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ spots: payloadSpots, status: 'approved' }),
      }).then(function (r) { return r.ok ? r.json() : { ok: false, status: r.status }; })
        .then(function (res) {
          if (!res || !res.ok) { toast('Import refusé (secret admin ?).'); return; }
          var msg = res.created + ' spot(s) importé(s)';
          if (res.skipped && res.skipped.length) msg += ' · ' + res.skipped.length + ' ignoré(s)';
          toast(msg + '. Horizons en calcul…', 5200);
          loadSpots().then(function () { renderTable(); });
        }).catch(function () { toast('Réseau indisponible.'); });
    };
    reader.readAsText(file);
  }

  // ── « Y aller » : itinéraire vers le spot dans l'app GPS du choix (deep-links) ──
  // Zéro API/clé : on ouvre un lien d'itinéraire que l'app GPS (ou le navigateur sur PC)
  // intercepte. Le routage/ETA/trafic sont fournis par l'app GPS. Apple Plans → iOS only.
  function isIOS() {
    try { return /iP(hone|ad|od)/i.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1); }
    catch (e) { return false; }
  }
  function gpsTargets(spot) {
    var q = spot.lat + ',' + spot.lon;
    var t = [
      { label: 'Google Maps', url: 'https://www.google.com/maps/dir/?api=1&destination=' + q },
      { label: 'Waze', url: 'https://waze.com/ul?ll=' + q + '&navigate=yes' },
      { label: 'Mappy', url: 'https://fr.mappy.com/plan#/?q=' + encodeURIComponent(q) },
    ];
    if (isIOS()) t.push({ label: 'Plans (Apple)', url: 'https://maps.apple.com/?daddr=' + q });
    return t;
  }
  function closeGpsMenu() {
    if (gpsMenuEl) { gpsMenuEl.remove(); gpsMenuEl = null; document.removeEventListener('pointerdown', gpsMenuOutside, true); document.removeEventListener('keydown', gpsMenuKey, true); }
  }
  function gpsMenuOutside(ev) { if (gpsMenuEl && !gpsMenuEl.contains(ev.target)) closeGpsMenu(); }
  function gpsMenuKey(ev) { if (ev.key === 'Escape') closeGpsMenu(); }
  function openGpsMenu(spot, anchor) {
    if (gpsMenuEl) { closeGpsMenu(); return; }
    var menu = document.createElement('div'); menu.className = 'ofspot-gps-menu'; menu.setAttribute('role', 'menu');
    gpsTargets(spot).forEach(function (t) {
      var b = document.createElement('button'); b.type = 'button'; b.className = 'ofspot-gps-item'; b.setAttribute('role', 'menuitem');
      b.textContent = t.label;
      b.addEventListener('click', function (ev) { ev.stopPropagation(); window.open(t.url, '_blank', 'noopener'); closeGpsMenu(); });
      menu.appendChild(b);
    });
    document.body.appendChild(menu);
    gpsMenuEl = menu;
    var r = anchor.getBoundingClientRect(), mw = menu.offsetWidth, mh = menu.offsetHeight;
    var left = Math.max(8, Math.min(r.left, window.innerWidth - mw - 8));
    var top = (r.bottom + mh + 8 > window.innerHeight) ? (r.top - mh - 6) : (r.bottom + 6);
    menu.style.left = left + 'px'; menu.style.top = Math.max(8, top) + 'px';
    setTimeout(function () { document.addEventListener('pointerdown', gpsMenuOutside, true); document.addEventListener('keydown', gpsMenuKey, true); }, 0);
  }
  function gpsButton(spot, cls) {
    var b = document.createElement('button'); b.type = 'button'; b.className = cls || 'ofspot-gps-btn';
    b.innerHTML = '<span aria-hidden="true">➤</span> Y aller';
    b.setAttribute('aria-label', 'Itinéraire GPS vers ' + spot.name);
    b.addEventListener('click', function (ev) { ev.stopPropagation(); openGpsMenu(spot, b); });
    return b;
  }

  // ── « ma position » (géoloc) + distance/direction pour tri & filtres ──
  function locateMe(cb) {
    if (!navigator.geolocation) { toast('Géolocalisation indisponible sur cet appareil.'); return; }
    toast('Localisation…', 1400);
    navigator.geolocation.getCurrentPosition(
      function (p) { myGeo = { lat: p.coords.latitude, lon: p.coords.longitude }; if (cb) cb(); },
      function () { toast('Position refusée ou indisponible.'); if (cb) cb(); },
      { enableHighAccuracy: false, timeout: 8000, maximumAge: 300000 });
  }
  function spotKm(spot) {
    if (!myGeo || typeof spot.lon !== 'number' || typeof spot.lat !== 'number') return null;
    return geoDistM(myGeo.lon, myGeo.lat, spot.lon, spot.lat) / 1000;
  }
  function kmTxt(km) { return '~' + (km < 10 ? km.toFixed(1) : Math.round(km)) + ' km'; }
  function spotDirs(spot) { return bestDirs(dirRatios(spot.horizon)); }   // directions dégagées (labels FR)

  // Accès routier (route carrossable la plus proche, calculé côté serveur, best-effort).
  function accessDist(spot) {
    var a = spot && spot.access;
    if (!a || typeof a.road_dist_m !== 'number') return null;
    var d = a.road_dist_m;
    return d < 1000 ? (Math.round(d) + ' m') : ((d / 1000).toFixed(1) + ' km');
  }
  function accessFull(spot) {
    var a = spot && spot.access, ds = accessDist(spot);
    if (!ds) return null;
    var wm = a.walk_min;
    var w = (wm == null) ? '' : (wm < 1 ? ' · <1 min à pied' : ' · ~' + Math.round(wm) + ' min à pied');
    return ds + w;
  }

  // Applique le filtre (distance + direction) puis le tri courant à une liste de spots.
  function applySpotsSortFilter(list) {
    var out = list.slice();
    if (myGeo && spotsMaxKm > 0) out = out.filter(function (s) { var k = spotKm(s); return k == null || k <= spotsMaxKm; });
    var dsel = Object.keys(spotsDirFilter).filter(function (k) { return spotsDirFilter[k]; });
    if (dsel.length) out = out.filter(function (s) { var ds = spotDirs(s); return ds.some(function (d) { return spotsDirFilter[d]; }); });
    var order = { N: 0, NE: 1, E: 2, SE: 3, S: 4, SO: 5, O: 6, NO: 7 };
    out.sort(function (a, b) {
      switch (spotsSort) {
        case 'near': case 'far': {
          var ka = spotKm(a), kb = spotKm(b);
          if (ka == null && kb == null) return 0;
          if (ka == null) return 1; if (kb == null) return -1;
          return spotsSort === 'near' ? ka - kb : kb - ka;
        }
        case 'az': return String(a.name || '').localeCompare(String(b.name || ''), 'fr');
        case 'za': return String(b.name || '').localeCompare(String(a.name || ''), 'fr');
        case 'date': return String(b.created_utc || '').localeCompare(String(a.created_utc || ''));
        case 'dir': {
          var la = spotDirs(a)[0], lb = spotDirs(b)[0];
          return (la == null ? 9 : order[la]) - (lb == null ? 9 : order[lb]);
        }
        default: return (b.horizon ? b.horizon.openness : -1) - (a.horizon ? a.horizon.openness : -1);
      }
    });
    return out;
  }

  // Barre de contrôles (Vue · Tri · Distance · Direction) — persistée localStorage.
  function ctrlRow(label) {
    var row = document.createElement('div'); row.className = 'ofspot-ctrl-row';
    var l = document.createElement('span'); l.className = 'ofspot-ctrl-lab'; l.textContent = label;
    row.appendChild(l); return row;
  }
  function chipBtn(txt, on, fn) {
    var b = document.createElement('button'); b.type = 'button';
    b.className = 'ofspot-chip' + (on ? ' on' : ''); b.textContent = txt;
    if (on) b.setAttribute('aria-pressed', 'true');
    b.addEventListener('click', fn); return b;
  }
  function spotsControls() {
    var bar = document.createElement('div'); bar.className = 'ofspot-ctrls';

    var vrow = ctrlRow('Vue');
    var seg = document.createElement('div'); seg.className = 'ofspot-seg';
    [['gallery', '▦ Galerie'], ['list', '≡ Liste']].forEach(function (v) {
      var b = document.createElement('button'); b.type = 'button';
      b.className = 'ofspot-seg-btn' + (spotsView === v[0] ? ' on' : ''); b.textContent = v[1];
      b.addEventListener('click', function () { if (spotsView !== v[0]) { spotsView = v[0]; saveSpotsPrefs(); renderTable(); } });
      seg.appendChild(b);
    });
    vrow.appendChild(seg); bar.appendChild(vrow);

    var srow = ctrlRow('Tri');
    [['score', 'Score'], ['near', 'Le + proche'], ['far', 'Le - proche'], ['az', 'A → Z'], ['za', 'Z → A'], ['dir', 'Direction'], ['date', 'Date d\'ajout']].forEach(function (s) {
      var needGeo = (s[0] === 'near' || s[0] === 'far');
      var chip = chipBtn(s[1], spotsSort === s[0], function () {
        spotsSort = s[0]; saveSpotsPrefs();
        if (needGeo && !myGeo) locateMe(function () { renderTable(); });
        renderTable();
      });
      if (needGeo && !myGeo) chip.classList.add('needs-geo');
      srow.appendChild(chip);
    });
    bar.appendChild(srow);

    var grow = ctrlRow('Distance');
    var geoBtn = document.createElement('button'); geoBtn.type = 'button'; geoBtn.className = 'ofspot-geo-btn' + (myGeo ? ' on' : '');
    geoBtn.innerHTML = myGeo ? '📍 Ma position ✓' : '📍 Me localiser';
    geoBtn.addEventListener('click', function () { locateMe(function () { renderTable(); }); });
    grow.appendChild(geoBtn);
    if (myGeo) {
      var slider = document.createElement('input'); slider.type = 'range'; slider.min = '10'; slider.max = '300'; slider.step = '10';
      slider.value = String(spotsMaxKm > 0 ? spotsMaxKm : 300); slider.className = 'ofspot-dist-slider';
      slider.setAttribute('aria-label', 'Rayon de filtrage en km');
      var lbl = document.createElement('span'); lbl.className = 'ofspot-dist-lbl';
      var setLbl = function () { lbl.textContent = (Number(slider.value) >= 300 ? 'toutes distances' : '≤ ' + slider.value + ' km'); };
      setLbl();
      slider.addEventListener('input', setLbl);
      slider.addEventListener('change', function () { var v = Number(slider.value); spotsMaxKm = (v >= 300 ? 0 : v); saveSpotsPrefs(); renderTable(); });
      grow.append(slider, lbl);
    } else {
      var hint = document.createElement('span'); hint.className = 'ofspot-ctrl-hint'; hint.textContent = 'pour trier/filtrer par distance';
      grow.appendChild(hint);
    }
    bar.appendChild(grow);

    var drow = ctrlRow('Direction');
    _DIRLBL.forEach(function (d) {
      var chip = chipBtn(d, !!spotsDirFilter[d], function () {
        if (spotsDirFilter[d]) delete spotsDirFilter[d]; else spotsDirFilter[d] = true;
        saveSpotsPrefs(); renderTable();
      });
      chip.classList.add('dir');
      drow.appendChild(chip);
    });
    if (Object.keys(spotsDirFilter).some(function (k) { return spotsDirFilter[k]; })) {
      var clr = document.createElement('button'); clr.type = 'button'; clr.className = 'ofspot-chip clear'; clr.textContent = '✕ tout';
      clr.addEventListener('click', function () { spotsDirFilter = {}; saveSpotsPrefs(); renderTable(); });
      drow.appendChild(clr);
    }
    bar.appendChild(drow);
    return bar;
  }

  // Vue « Liste » : ligne compacte (score · nom · distance/direction · Y aller).
  function listRow(spot) {
    var h = spot.horizon;
    var row = document.createElement('div'); row.className = 'ofspot-lrow';
    var main = document.createElement('button'); main.type = 'button'; main.className = 'ofspot-lrow-main';
    main.setAttribute('aria-label', 'Voir ' + spot.name + ' sur la carte');
    var badge = document.createElement('span'); badge.className = 'ofspot-lrow-badge';
    if (h) { badge.style.color = scoreColor(h.openness); badge.style.background = scoreColor(h.openness) + '22'; badge.textContent = Math.round(h.openness); }
    else { badge.textContent = '…'; badge.classList.add('pending'); }
    var body = document.createElement('span'); body.className = 'ofspot-lrow-body';
    var nm = document.createElement('span'); nm.className = 'ofspot-lrow-name'; nm.textContent = spot.name;
    var meta = document.createElement('span'); meta.className = 'ofspot-lrow-meta';
    var parts = []; var km = spotKm(spot);
    if (km != null) parts.push(kmTxt(km));
    var ds = spotDirs(spot); if (ds.length) parts.push(ds.slice(0, 2).join('/'));
    else if (h) parts.push(scoreLabel(h.openness));
    var road = accessDist(spot); if (road) parts.push('🚗 ' + road);
    meta.textContent = parts.join(' · ');
    body.append(nm, meta);
    main.append(badge, body);
    main.addEventListener('click', function () { closeSpotsPage(); showVision(spot); });
    row.appendChild(main);
    row.appendChild(gpsButton(spot, 'ofspot-lrow-gps'));
    return row;
  }

  // ── Trouver des spots automatiquement (#9) : feuille géoloc+rayon → job de fond → résultats ──
  var discoverMarkers = [], discoverTimer = null, discoverSheet = null, discoverRadius = 50;
  function ensureDiscoverSheet() {
    if (discoverSheet) return discoverSheet;
    var s = document.createElement('div'); s.className = 'ofspot-discover-sheet'; s.id = 'ofspotDiscoverSheet'; s.setAttribute('hidden', '');
    document.body.appendChild(s); discoverSheet = s; return s;
  }
  function discoverClearMarkers() { discoverMarkers.forEach(function (m) { try { m.remove(); } catch (e) {} }); discoverMarkers = []; }
  function discoverClose() { if (discoverTimer) { clearTimeout(discoverTimer); discoverTimer = null; } discoverClearMarkers(); if (discoverSheet) discoverSheet.setAttribute('hidden', ''); }
  function discoverHead(title) { return '<div class="ofd-head"><span class="ofd-title">' + title + '</span><button type="button" class="ofd-close" aria-label="Fermer">×</button></div>'; }
  function discoverBind() { var c = discoverSheet.querySelector('.ofd-close'); if (c) c.addEventListener('click', discoverClose); }
  function openDiscover() { discoverClearMarkers(); ensureDiscoverSheet().removeAttribute('hidden'); discoverStepStart(); }
  function discoverStepStart() {
    discoverSheet.innerHTML = discoverHead('Trouver des spots')
      + '<p class="ofd-p">Autour de ta position : ciel sombre, horizon dégagé, point haut et proche d\'une route.</p>'
      + '<button type="button" class="ofd-btn primary" id="ofdLocate">📍 Se géolocaliser</button>';
    discoverBind();
    discoverSheet.querySelector('#ofdLocate').addEventListener('click', discoverLocate);
  }
  function discoverLocate() {
    var btn = discoverSheet.querySelector('#ofdLocate'); if (btn) { btn.disabled = true; btn.textContent = 'Localisation…'; }
    locateMe(function () {
      if (!myGeo) { if (btn) { btn.disabled = false; btn.textContent = '📍 Se géolocaliser'; } return; }
      discoverStepRadius();
    });
  }
  function discoverStepRadius() {
    discoverSheet.innerHTML = discoverHead('Rayon de recherche')
      + '<label class="ofd-rad">Rayon : <b id="ofdRadV">' + discoverRadius + ' km</b>'
      + '<input type="range" id="ofdRad" min="10" max="150" step="10" value="' + discoverRadius + '"></label>'
      + '<button type="button" class="ofd-btn primary" id="ofdRun">Lancer la recherche</button>'
      + '<p class="ofd-note">Le 1ᵉʳ balayage prend ~1–2 min (analyse de l\'horizon), puis c\'est instantané.</p>';
    discoverBind();
    var r = discoverSheet.querySelector('#ofdRad'), v = discoverSheet.querySelector('#ofdRadV');
    r.addEventListener('input', function () { discoverRadius = Number(r.value); v.textContent = discoverRadius + ' km'; });
    discoverSheet.querySelector('#ofdRun').addEventListener('click', discoverRun);
  }
  function discoverRun() {
    if (!myGeo) { discoverStepStart(); return; }
    discoverSheet.innerHTML = discoverHead('Recherche en cours')
      + '<div class="ofd-prog"><span class="ofd-prog-bar" id="ofdBar" style="width:5%"></span></div>'
      + '<p class="ofd-p" id="ofdProgTxt">Sélection des candidats…</p>';
    discoverBind();
    fetch('/api/spots/discover', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ lat: myGeo.lat, lon: myGeo.lon, radius_km: discoverRadius }) })
      .then(function (r) { return r.json(); })
      .then(function (d) { if (!d || !d.ok || !d.job) { discoverError(d && d.error); return; } discoverPoll(d.job); })
      .catch(function () { discoverError('Réseau indisponible.'); });
  }
  function discoverPoll(job) {
    fetch('/api/spots/discover/status?job=' + encodeURIComponent(job))
      .then(function (r) { return r.json(); })
      .then(function (d) {
        if (!d || !d.ok) { discoverError(d && d.error); return; }
        var tot = (d.progress && d.progress.total) || 0, done = (d.progress && d.progress.done) || 0;
        var bar = discoverSheet.querySelector('#ofdBar'); if (bar) bar.style.width = Math.max(5, tot ? Math.round(done / tot * 100) : 8) + '%';
        var txt = discoverSheet.querySelector('#ofdProgTxt'); if (txt) txt.textContent = tot ? (done + ' / ' + tot + ' points analysés…') : 'Sélection des candidats…';
        if (d.done) { if (d.error) { discoverError(null); } else { discoverRenderResults(d.results || []); } return; }
        discoverTimer = setTimeout(function () { discoverPoll(job); }, 1500);
      })
      .catch(function () { discoverTimer = setTimeout(function () { discoverPoll(job); }, 2500); });
  }
  function discoverError(msg) {
    discoverSheet.innerHTML = discoverHead('Recherche')
      + '<p class="ofd-p">' + (msg || 'La recherche a échoué. Réessaie.') + '</p>'
      + '<button type="button" class="ofd-btn" id="ofdRetry">Réessayer</button>';
    discoverBind();
    var b = discoverSheet.querySelector('#ofdRetry'); if (b) b.addEventListener('click', discoverStepRadius);
  }
  function discoverRenderResults(list) {
    discoverClearMarkers();
    if (!list.length) {
      discoverSheet.innerHTML = discoverHead('Aucun spot trouvé')
        + '<p class="ofd-p">Aucun point ne réunit tous les critères dans ce rayon. Essaie un rayon plus grand.</p>'
        + '<button type="button" class="ofd-btn" id="ofdAgain">Nouvelle recherche</button>';
      discoverBind(); var ba = discoverSheet.querySelector('#ofdAgain'); if (ba) ba.addEventListener('click', discoverStepStart); return;
    }
    var html = discoverHead(list.length + ' spot' + (list.length > 1 ? 's' : '') + ' trouvé' + (list.length > 1 ? 's' : '')) + '<div class="ofd-list">';
    list.forEach(function (r, i) {
      var km = spotKm({ lon: r.lon, lat: r.lat });
      html += '<div class="ofd-card" data-i="' + i + '"><div class="ofd-card-h"><span class="ofd-rk">' + (i + 1) + '</span>'
        + (r.access_kind ? '<span class="ofd-kind">📍 ' + r.access_kind + '</span>' : '')
        + '<span class="ofd-sc" style="color:' + scoreColor(r.score) + '">' + r.score + '</span></div>'
        + '<div class="ofd-meta">🌑 ' + r.darkness + ' · 🌄 ' + r.openness
        + (r.z0 != null ? ' · ⛰ ' + r.z0 + ' m' : '') + (km != null ? ' · ' + kmTxt(km) : '') + '</div>'
        + '<div class="ofd-acts"><button type="button" class="ofd-mini" data-act="see">Voir</button>'
        + '<button type="button" class="ofd-mini save" data-act="save">Enregistrer</button></div></div>';
    });
    html += '</div><button type="button" class="ofd-btn" id="ofdAgain">Nouvelle recherche</button>';
    discoverSheet.innerHTML = html; discoverBind();
    list.forEach(function (r) {
      try { var el = document.createElement('div'); el.className = 'ofspot-discover-pin'; var mk = new maplibregl.Marker({ element: el, anchor: 'center' }).setLngLat([r.lon, r.lat]).addTo(map); discoverMarkers.push(mk); } catch (e) {}
    });
    [].forEach.call(discoverSheet.querySelectorAll('.ofd-card'), function (card) {
      var r = list[Number(card.dataset.i)];
      card.querySelector('[data-act=see]').addEventListener('click', function () { discoverSee(r); });
      card.querySelector('[data-act=save]').addEventListener('click', function (e) { discoverSave(r, e.target); });
    });
    discoverSheet.querySelector('#ofdAgain').addEventListener('click', discoverStepStart);
  }
  function discoverSee(r) { if (discoverSheet) discoverSheet.setAttribute('hidden', ''); closeSpotsPage(); try { map.flyTo({ center: [r.lon, r.lat], zoom: Math.max(map.getZoom ? map.getZoom() : 9, 11), duration: 650 }); } catch (e) {} }
  function discoverSave(r, btn) {
    if (btn) { btn.disabled = true; btn.textContent = '…'; }
    var name = 'Spot auto ' + r.lat.toFixed(3) + ',' + r.lon.toFixed(3);
    var note = 'Trouvé automatiquement' + (r.access_kind ? ' · accès : ' + r.access_kind : '');
    submitSpot({ name: name, lon: r.lon, lat: r.lat, notes: note, share: false }).then(function (d) {
      if (d && d.ok) { if (btn) { btn.textContent = 'Enregistré ✓'; } toast('Spot enregistré dans « Mes spots » ✓', 3800); loadSpots().then(function () {}); }
      else { if (btn) { btn.disabled = false; btn.textContent = 'Enregistrer'; } toast((d && d.error) || 'Échec de l\'enregistrement.'); }
    });
  }

  function renderTable() {
    var body = document.getElementById('ofspotTableBody');
    if (!body) return;
    if (!account.loggedIn) tableView = 'public';
    closeGpsMenu();
    body.innerHTML = '';
    renderModeration(body);

    // Onglets Publics / Mes spots (uniquement connecté).
    if (account.loggedIn) {
      var tabs = document.createElement('div'); tabs.className = 'ofspot-tbl-tabs';
      [['public', 'Publics', spotsData.length], ['mine', 'Mes spots', mineData.length]].forEach(function (t) {
        var b = document.createElement('button'); b.type = 'button';
        b.className = 'ofspot-tbl-tab' + (tableView === t[0] ? ' active' : '');
        b.textContent = t[1] + ' (' + t[2] + ')';
        b.addEventListener('click', function () { tableView = t[0]; renderTable(); });
        tabs.appendChild(b);
      });
      body.appendChild(tabs);
    }

    var mine = tableView === 'mine';
    var list = mine ? mineData : spotsData;
    var bar = document.createElement('div'); bar.className = 'ofspot-tbl-bar';
    var count = document.createElement('span'); count.className = 'ofspot-tbl-count';
    count.textContent = list.length + ' spot' + (list.length > 1 ? 's' : '') + (mine ? '' : (' public' + (list.length > 1 ? 's' : '')));
    var actions = document.createElement('div'); actions.className = 'ofspot-tbl-actions';
    var findA = document.createElement('button'); findA.type = 'button'; findA.className = 'ofspot-tbl-find';
    findA.innerHTML = '<span aria-hidden="true">🔭</span> Trouver des spots';
    findA.addEventListener('click', openDiscover);
    var addA = document.createElement('button'); addA.type = 'button'; addA.className = 'ofspot-tbl-add';
    addA.innerHTML = '<span class="plus" aria-hidden="true">+</span> Ajouter un spot';
    addA.addEventListener('click', function () { closeSpotsPage(); enterAddMode(); });
    actions.append(findA, addA);
    bar.append(count, actions);
    body.appendChild(bar);
    if (!list.length) {
      var empty = document.createElement('div'); empty.className = 'ofspot-empty';
      empty.textContent = mine ? 'Tu n\'as pas encore de spot. Ajoute-en un — il reste privé tant que tu ne le proposes pas.'
                               : 'Aucun spot public pour l\'instant. Ajoute le tien !';
      body.appendChild(empty); return;
    }
    // Barre Vue/Tri/Distance/Direction + application du tri & des filtres courants.
    body.appendChild(spotsControls());
    var shown = applySpotsSortFilter(list);
    var filtered = shown.length !== list.length;
    count.textContent = (filtered ? shown.length + ' / ' + list.length : list.length) + ' spot' + (list.length > 1 ? 's' : '')
      + (mine ? '' : (' public' + (list.length > 1 ? 's' : ''))) + (filtered ? ' (filtrés)' : '');
    if (!shown.length) {
      var none = document.createElement('div'); none.className = 'ofspot-empty';
      none.textContent = 'Aucun spot ne correspond aux filtres. Élargis la distance ou les directions.';
      body.appendChild(none); return;
    }
    if (spotsView === 'list') {
      var lst = document.createElement('div'); lst.className = 'ofspot-tbl-list';
      shown.forEach(function (spot) { if (mine) spot._mine = true; lst.appendChild(listRow(spot)); });
      body.appendChild(lst);
    } else {
      var grid = document.createElement('div'); grid.className = 'ofspot-tbl-grid';
      shown.forEach(function (spot) { grid.appendChild(tableCard(spot, mine)); });
      body.appendChild(grid);
    }
  }

  function tableCard(spot, mine) {
    if (mine) spot._mine = true;
    var h = spot.horizon;
    var card = document.createElement('div'); card.className = 'ofspot-card' + (mine ? ' is-mine is-' + statusMeta(spot.status).cls : '');
    var main = document.createElement('button'); main.type = 'button'; main.className = 'ofspot-card-main';
    main.setAttribute('aria-label', 'Voir ' + spot.name + ' sur la carte');
    var ros = document.createElement('div'); ros.className = 'ofspot-card-ros';
    if (h && h.azimuths && h.azimuths.length) ros.appendChild(makeRosace(h.azimuths, h.openness, 92));
    var info = document.createElement('div'); info.className = 'ofspot-card-info';
    var nm = document.createElement('div'); nm.className = 'ofspot-card-name'; nm.textContent = spot.name;
    var meta = document.createElement('div'); meta.className = 'ofspot-card-meta';
    if (h) {
      meta.innerHTML = '<span class="ofspot-card-badge" style="color:' + scoreColor(h.openness) + ';background:' + scoreColor(h.openness) + '22">'
        + Math.round(h.openness) + '/100 · ' + scoreLabel(h.openness) + '</span>'
        + '<span>' + Math.round(h.z0) + ' m</span><span>relief +' + (h.denivele_max_m || 0) + ' m</span>'
        + (accessDist(spot) ? '<span class="ofspot-card-road">🚗 ' + accessDist(spot) + '</span>' : '');
    } else { meta.textContent = 'horizon en calcul…'; }
    info.append(nm, meta);
    if (mine) {
      var sm = statusMeta(spot.status);
      var sc = document.createElement('div'); sc.className = 'ofspot-card-status ofspot-status--' + sm.cls;
      sc.textContent = sm.label; info.appendChild(sc);
    } else if (spot.author_pseudo) {
      var au = document.createElement('div'); au.className = 'ofspot-card-author'; au.textContent = 'par ' + spot.author_pseudo; info.appendChild(au);
    }
    if (spot.notes) { var nt = document.createElement('div'); nt.className = 'ofspot-card-notes'; nt.textContent = spot.notes; info.appendChild(nt); }
    main.append(ros, info);
    main.addEventListener('click', function () {
      closeSpotsPage();
      showVision(spot);   // dessine le cercle de vision sur la carte + panneau
    });
    card.appendChild(main);
    // Bande « Y aller » (+ distance depuis ma position si géolocalisé) sur chaque carte.
    var go = document.createElement('div'); go.className = 'ofspot-card-go';
    var km = spotKm(spot);
    if (km != null) { var kd = document.createElement('span'); kd.className = 'ofspot-card-km'; kd.textContent = kmTxt(km); go.appendChild(kd); }
    go.appendChild(gpsButton(spot, 'ofspot-gps-btn'));
    card.appendChild(go);
    if (mine) {
      var oa = document.createElement('div'); oa.className = 'ofspot-card-admin';
      var st = spot.status;
      var sBtn = document.createElement('button'); sBtn.type = 'button'; sBtn.className = 'ofspot-card-abtn share';
      sBtn.textContent = (st === 'private' || st === 'rejected') ? 'Proposer' : (st === 'approved' ? 'Retirer' : 'Annuler');
      sBtn.addEventListener('click', function (e) {
        e.stopPropagation(); sBtn.disabled = true;
        var pub = (st === 'private' || st === 'rejected');
        jpost('/api/spots/' + spot.id + (pub ? '/share' : '/unshare')).then(function (r) {
          if (r && r.ok) { toast(pub ? 'Spot proposé ✓' : 'Spot redevenu privé ✓'); loadSpots().then(renderTable); }
          else { sBtn.disabled = false; toast((r && r.error) || 'Échec.'); }
        });
      });
      var edit = document.createElement('button'); edit.type = 'button'; edit.className = 'ofspot-card-abtn';
      edit.textContent = 'Modifier';
      edit.addEventListener('click', function (e) { e.stopPropagation(); openEditForm(spot, { owner: true }); });
      var del = document.createElement('button'); del.type = 'button'; del.className = 'ofspot-card-abtn del';
      del.textContent = 'Supprimer';
      del.addEventListener('click', function (e) { e.stopPropagation(); ownerDeleteSpot(spot); });
      oa.append(sBtn, edit, del);
      card.appendChild(oa);
    } else if (isAdmin()) {
      var acts = document.createElement('div'); acts.className = 'ofspot-card-admin';
      var edit = document.createElement('button'); edit.type = 'button'; edit.className = 'ofspot-card-abtn';
      edit.textContent = 'Modifier';
      edit.addEventListener('click', function (e) { e.stopPropagation(); openEditForm(spot); });
      var del = document.createElement('button'); del.type = 'button'; del.className = 'ofspot-card-abtn del';
      del.textContent = 'Supprimer';
      del.addEventListener('click', function (e) { e.stopPropagation(); deleteSpot(spot); });
      acts.append(edit, del);
      card.appendChild(acts);
    }
    return card;
  }

  function deleteSpot(spot) {
    if (!confirm('Supprimer le spot « ' + spot.name + ' » ? Cette action est définitive.')) return;
    clearVision();                 // ferme le panneau/cercle si ce spot était sélectionné
    moderate(spot.id, 'delete');   // moderate() rafraîchit table + marqueurs + toast
  }

  function openEditForm(spot, opts) {
    var owner = !!(opts && opts.owner);   // propriétaire (mes spots) vs admin
    var back = document.createElement('div'); back.className = 'ofspot-modal-back';
    var modal = document.createElement('div'); modal.className = 'ofspot-modal';
    modal.innerHTML =
      '<button type="button" class="ofspot-modal-close" aria-label="Fermer"><svg class="icon-svg icon-close" viewBox="0 0 40 40" aria-hidden="true" fill="none"><path d="M9 9L31 31M9 31L31 9" stroke="currentColor" stroke-width="5" stroke-linecap="round"/></svg></button>' +
      '<h4>Modifier le spot</h4>' +
      '<label>Nom<input class="e-name" maxlength="60"></label>' +
      '<label>Description<textarea class="e-notes" rows="3" maxlength="280"></textarea></label>' +
      '<div class="ofspot-modal-coords"><label>Latitude<input class="e-lat" inputmode="decimal"></label>' +
      '<label>Longitude<input class="e-lon" inputmode="decimal"></label></div>' +
      '<label class="f-inner-lbl">Trou central (donut) <span class="e-inner-val"></span>' +
      '<input type="range" class="e-inner" min="0" max="' + MAX_INNER + '" step="1"></label>' +
      '<div class="f-inner-help">0 = point simple. Sinon l\'obstacle central (chapelle…) est ignoré dans le trou.</div>' +
      '<div class="err" role="alert"></div>' +
      '<div class="ofspot-modal-row"><button type="button" class="del">Supprimer</button><span class="sp"></span>' +
      '<button type="button" class="cancel">Annuler</button><button type="button" class="save">Enregistrer</button></div>';
    back.appendChild(modal); document.body.appendChild(back);
    modal.querySelector('.e-name').value = spot.name || '';
    modal.querySelector('.e-notes').value = spot.notes || '';
    modal.querySelector('.e-lat').value = spot.lat;
    modal.querySelector('.e-lon').value = spot.lon;
    var innerEl = modal.querySelector('.e-inner'), innerVal = modal.querySelector('.e-inner-val');
    var curInner = Math.round(+(spot.inner_radius_m || 0));
    innerEl.value = curInner; innerVal.textContent = curInner + ' m';
    innerEl.addEventListener('input', function () { innerVal.textContent = Math.round(+innerEl.value || 0) + ' m'; });
    var err = modal.querySelector('.err');
    var close = function () { back.remove(); };
    modal.querySelector('.ofspot-modal-close').addEventListener('click', close);
    back.addEventListener('click', function (e) { if (e.target === back) close(); });
    document.addEventListener('keydown', function esc(e) { if (e.key === 'Escape') { close(); document.removeEventListener('keydown', esc); } });
    modal.querySelector('.cancel').addEventListener('click', close);
    modal.querySelector('.del').addEventListener('click', function () { close(); (owner ? ownerDeleteSpot : deleteSpot)(spot); });
    modal.querySelector('.save').addEventListener('click', function () {
      var name = modal.querySelector('.e-name').value.trim();
      var notes = modal.querySelector('.e-notes').value.trim();
      var lat = parseFloat(String(modal.querySelector('.e-lat').value).replace(',', '.'));
      var lon = parseFloat(String(modal.querySelector('.e-lon').value).replace(',', '.'));
      if (name.length < 2) { err.textContent = 'Nom : 2 caractères minimum.'; return; }
      if (!Number.isFinite(lat) || !Number.isFinite(lon)) { err.textContent = 'Coordonnées invalides.'; return; }
      var btn = modal.querySelector('.save'); btn.disabled = true; btn.textContent = '…';
      var url = owner ? ('/api/spots/' + spot.id + '/owner-update')
                      : ('/api/spots/' + spot.id + '/update');
      fetch(url, {
        method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: name, notes: notes, lat: lat, lon: lon, inner_radius_m: Math.round(+innerEl.value || 0) }),
      }).then(function (r) { return r.ok ? r.json() : { ok: false }; })
        .then(function (res) {
          if (res && res.ok) { close(); toast('Spot modifié ✓'); (owner ? afterOwnerChange(spot.id) : loadSpots().then(function () { renderTable(); })); }
          else { err.textContent = (res && res.error) || 'Échec de la modification.'; btn.disabled = false; btn.textContent = 'Enregistrer'; }
        }).catch(function () { err.textContent = 'Réseau indisponible.'; btn.disabled = false; btn.textContent = 'Enregistrer'; });
    });
  }

  // ── onglet rail : ouvre la page ────────────────────────────────────────────
  function wireRail() {
    var openBtn = document.getElementById('spotsPageBtn');
    var closeBtn = document.getElementById('spotsListCloseBtn');
    if (openBtn) openBtn.addEventListener('click', openSpotsPage);
    if (closeBtn) closeBtn.addEventListener('click', closeSpotsPage);
    document.addEventListener('keydown', function (e) {
      var pg = document.getElementById('spotsListPage');
      if (e.key === 'Escape' && pg && pg.getAttribute('aria-hidden') === 'false') closeSpotsPage();
    });
  }

  // ── ajout d'un spot (bouton + → presser-glisser sur la carte → formulaire) ──
  // Presser = poser le centre. Glisser (souris maintenue / doigt) = régler le trou
  // central (le « donut » : chapelle, antenne… qu'on contourne). Relâcher = formulaire.
  var addMode = false, formPopup = null;
  var MAX_INNER = 300;   // rayon max du trou (m), aligné sur le backend

  function clientToken() {
    var t = '';
    try {
      t = localStorage.getItem('ofspot_token') || '';
      if (!t) { t = 'anon-' + Math.random().toString(36).slice(2) + Date.now().toString(36); localStorage.setItem('ofspot_token', t); }
    } catch (e) {}
    return t;
  }

  function toast(msg, ms) {
    var t = document.createElement('div'); t.className = 'ofspot-toast'; t.textContent = msg;
    document.body.appendChild(t);
    requestAnimationFrame(function () { t.classList.add('show'); });
    setTimeout(function () { t.classList.remove('show'); setTimeout(function () { t.remove(); }, 260); }, ms || 3200);
  }

  // ── prévisualisation live du centre + trou pendant le geste (source dédiée) ──
  var PRE_SRC = 'ofspot-preview';
  function ensurePreviewLayers() {
    if (typeof map === 'undefined' || typeof map.getSource !== 'function' || map.getSource(PRE_SRC)) return;
    map.addSource(PRE_SRC, { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
    map.addLayer({ id: PRE_SRC + '-fill', type: 'fill', source: PRE_SRC, filter: ['==', ['get', 'kind'], 'hole'],
      paint: { 'fill-color': '#f0a54a', 'fill-opacity': 0.22 } });
    map.addLayer({ id: PRE_SRC + '-line', type: 'line', source: PRE_SRC, filter: ['==', ['get', 'kind'], 'hole'],
      paint: { 'line-color': '#f0a54a', 'line-width': 1.8, 'line-dasharray': [2, 2] } });
    map.addLayer({ id: PRE_SRC + '-center', type: 'circle', source: PRE_SRC, filter: ['==', ['get', 'kind'], 'center'],
      paint: { 'circle-radius': 5, 'circle-color': '#f0a54a', 'circle-stroke-color': '#0b1017', 'circle-stroke-width': 2 } });
  }
  function setPreview(lon, lat, radM) {
    ensurePreviewLayers();
    var s = map.getSource(PRE_SRC); if (!s) return;
    var feats = [{ type: 'Feature', properties: { kind: 'center' }, geometry: { type: 'Point', coordinates: [lon, lat] } }];
    if (radM > 0.5) feats.push(discFeature(lon, lat, radM, 'hole'));
    s.setData({ type: 'FeatureCollection', features: feats });
  }
  function clearPreview() {
    if (typeof map !== 'undefined' && map.getSource && map.getSource(PRE_SRC)) {
      map.getSource(PRE_SRC).setData({ type: 'FeatureCollection', features: [] });
    }
  }

  // ── badge live du rayon pendant le glisser ──────────────────────────────────
  var radBadge = null;
  function showRadiusBadge(r) {
    if (!radBadge) {
      radBadge = document.createElement('div'); radBadge.className = 'ofspot-radbadge';
      document.body.appendChild(radBadge);   // top-level : échappe au contexte d'empilement de la carte
    }
    radBadge.innerHTML = r >= 0.5
      ? 'Trou central <b>' + Math.round(r) + ' m</b>'
      : 'Point simple · <span class="hint">glisse pour un trou</span>';
    radBadge.classList.add('show');
  }
  function hideRadiusBadge() { if (radBadge) radBadge.classList.remove('show'); }

  // ── geste presser-glisser-relâcher (souris + tactile) ───────────────────────
  var pressing = false, pressCenter = null, pressRad = 0;

  function addPressStart(e) {
    if (!addMode) return;
    var oe = e.originalEvent;
    if (oe && oe.touches && oe.touches.length > 1) return;   // laisse le pinch-zoom
    if (oe && oe.preventDefault) oe.preventDefault();
    pressing = true; pressCenter = e.lngLat; pressRad = 0;
    map.dragPan.disable();
    setPreview(pressCenter.lng, pressCenter.lat, 0);
    showRadiusBadge(0);
    map.on('mousemove', addPressMove); map.on('touchmove', addPressMove);
    map.on('mouseup', addPressEnd); map.on('touchend', addPressEnd); map.on('touchcancel', addPressEnd);
  }
  function addPressMove(e) {
    if (!pressing || !pressCenter) return;
    var d = geoDistM(pressCenter.lng, pressCenter.lat, e.lngLat.lng, e.lngLat.lat);
    pressRad = Math.max(0, Math.min(MAX_INNER, d));
    setPreview(pressCenter.lng, pressCenter.lat, pressRad);
    showRadiusBadge(pressRad);
  }
  function addPressEnd() {
    if (!pressing) return;
    pressing = false;
    map.off('mousemove', addPressMove); map.off('touchmove', addPressMove);
    map.off('mouseup', addPressEnd); map.off('touchend', addPressEnd); map.off('touchcancel', addPressEnd);
    map.dragPan.enable();
    hideRadiusBadge();
    var c = pressCenter, r = Math.round(pressRad);
    exitAddMode();                     // sort du mode (garde la prévisu jusqu'au formulaire)
    setPreview(c.lng, c.lat, r);       // fige la prévisu sous le formulaire
    openAddForm(c, r);
  }

  // ── géolocalisation : poser un spot à ma position ───────────────────────────
  var geolocChip = null, geolocating = false;
  var GEO_SVG = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="7"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3"/><circle cx="12" cy="12" r="2.5" fill="currentColor" stroke="none"/></svg>';
  function ensureGeolocChip() {
    if (geolocChip) return geolocChip;
    var b = document.createElement('button'); b.type = 'button'; b.className = 'ofspot-geoloc-chip';
    b.setAttribute('aria-label', 'Créer un spot à ma position'); b.title = 'Créer un spot à ma position';
    b.innerHTML = GEO_SVG + '<span>Ma position</span>';
    b.addEventListener('click', geolocateAndAdd);
    document.body.appendChild(b); geolocChip = b;
    window.addEventListener('resize', positionGeolocChip);
    return b;
  }
  // colle la pastille juste à DROITE du bouton « Ajouter un spot » visible (du rail actif)
  function positionGeolocChip() {
    if (!geolocChip || !geolocChip.classList.contains('show')) return;
    var target = null;
    document.querySelectorAll('.spots-add-btn').forEach(function (b) {
      var r = b.getBoundingClientRect(); if (r.width > 0 && r.height > 0) target = b;
    });
    if (!target) return;
    var r = target.getBoundingClientRect();
    geolocChip.style.left = Math.round(r.right + 10) + 'px';
    geolocChip.style.top = Math.round(r.top + r.height / 2) + 'px';
  }
  function showGeolocChip() { ensureGeolocChip().classList.add('show'); positionGeolocChip(); }
  function hideGeolocChip() { if (geolocChip) geolocChip.classList.remove('show'); }
  function geolocateAndAdd() {
    if (!navigator.geolocation) { toast('Géolocalisation indisponible sur cet appareil.'); return; }
    if (geolocating) return;
    geolocating = true;
    var chip = geolocChip; if (chip) { chip.classList.add('loading'); chip.disabled = true; }
    navigator.geolocation.getCurrentPosition(function (pos) {
      geolocating = false; if (chip) { chip.classList.remove('loading'); chip.disabled = false; }
      var lngLat = { lng: pos.coords.longitude, lat: pos.coords.latitude };
      exitAddMode();
      try { map.flyTo({ center: [lngLat.lng, lngLat.lat], zoom: Math.max(map.getZoom(), 16), duration: 800 }); } catch (e) {}
      setPreview(lngLat.lng, lngLat.lat, 0);
      openAddForm(lngLat, 0);
    }, function (err) {
      geolocating = false; if (chip) { chip.classList.remove('loading'); chip.disabled = false; }
      var msg = (err && err.code === 1) ? 'Autorise la localisation pour poser un spot ici.'
              : (err && err.code === 3) ? 'Localisation trop longue, réessaie.'
              : 'Position indisponible.';
      toast(msg, 4200);
    }, { enableHighAccuracy: true, timeout: 10000, maximumAge: 30000 });
  }

  function enterAddMode() {
    if (typeof map === 'undefined') return;
    addMode = true;
    document.querySelectorAll('.spots-add-btn').forEach(function (b) { b.classList.add('active'); b.setAttribute('title', 'Presse la carte pour poser le spot'); });
    map.getCanvas().style.cursor = 'crosshair';
    ensurePreviewLayers();
    map.on('mousedown', addPressStart); map.on('touchstart', addPressStart);
    showGeolocChip();
    toast('Presse sur la carte (maintiens + glisse pour le trou central) — ou utilise « Ma position ».', 5000);
  }

  function exitAddMode() {
    addMode = false;
    hideGeolocChip();
    document.querySelectorAll('.spots-add-btn').forEach(function (b) { b.classList.remove('active'); b.setAttribute('title', 'Ajouter un spot'); });
    if (typeof map === 'undefined') return;
    map.getCanvas().style.cursor = '';
    map.off('mousedown', addPressStart); map.off('touchstart', addPressStart);
    map.off('mousemove', addPressMove); map.off('touchmove', addPressMove);
    map.off('mouseup', addPressEnd); map.off('touchend', addPressEnd); map.off('touchcancel', addPressEnd);
    if (pressing) { pressing = false; map.dragPan.enable(); hideRadiusBadge(); }
  }

  function submitSpot(payload) {
    return fetch('/api/spots', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) })
      .then(function (r) { return r.json().then(function (d) {
        return r.status === 422 ? { ok: false, error: 'Coordonnées hors France métropolitaine.' } : d;
      }); });
  }

  function openAddForm(lngLat, innerRadius) {
    innerRadius = Math.max(0, Math.min(MAX_INNER, Math.round(innerRadius || 0)));
    var form = document.createElement('div'); form.className = 'ofspot-form';
    // Connecté : choix de visibilité (perso privé par défaut vs proposition publique modérée).
    var visHtml = account.loggedIn ?
      ('<div class="f-vis-lbl">Visibilité</div>' +
       '<div class="ofspot-vis" role="group" aria-label="Visibilité du spot">' +
       '<button type="button" class="ofspot-vis-btn active" data-share="0"><b>Privé</b><small>Pour toi seul</small></button>' +
       '<button type="button" class="ofspot-vis-btn" data-share="1"><b>Public</b><small>Soumis à validation</small></button>' +
       '</div>') : '';
    form.innerHTML =
      '<h4>Nouveau spot</h4>' +
      '<label>Nom<input type="text" maxlength="60" placeholder="Belvédère du…" class="f-name"></label>' +
      '<label>Description (optionnel)<textarea rows="2" maxlength="280" placeholder="Vue dégagée vers l\'ouest…" class="f-notes"></textarea></label>' +
      '<label class="f-inner-lbl">Trou central (donut) <span class="f-inner-val">' + innerRadius + ' m</span>' +
      '<input type="range" class="f-inner" min="0" max="' + MAX_INNER + '" step="1" value="' + innerRadius + '"></label>' +
      '<div class="f-inner-help">Contourne un obstacle central (chapelle, antenne…) : il est ignoré dans le trou.</div>' +
      visHtml +
      '<div class="err" role="alert"></div>' +
      '<div class="row"><button type="button" class="cancel">Annuler</button><button type="button" class="save">Enregistrer</button></div>';
    if (!formPopup) formPopup = new maplibregl.Popup({ className: 'ofspot-popup', closeButton: true, closeOnClick: false, maxWidth: '260px', offset: 16 });
    formPopup.setLngLat(lngLat).setDOMContent(form).addTo(map);
    formPopup.off('close', clearPreview); formPopup.on('close', clearPreview);   // referme → efface la prévisu
    var nameEl = form.querySelector('.f-name'), notesEl = form.querySelector('.f-notes'), errEl = form.querySelector('.err');
    var innerEl = form.querySelector('.f-inner'), innerVal = form.querySelector('.f-inner-val');
    innerEl.addEventListener('input', function () {
      var v = Math.round(+innerEl.value || 0); innerVal.textContent = v + ' m';
      setPreview(lngLat.lng, lngLat.lat, v);
    });
    setTimeout(function () { try { nameEl.focus(); } catch (e) {} }, 60);
    // Sélecteur de visibilité (connecté).
    var share = false;
    var visBtns = form.querySelectorAll('.ofspot-vis-btn');
    Array.prototype.forEach.call(visBtns, function (b) {
      b.addEventListener('click', function () {
        Array.prototype.forEach.call(visBtns, function (x) { x.classList.remove('active'); });
        b.classList.add('active'); share = b.getAttribute('data-share') === '1';
      });
    });
    form.querySelector('.cancel').addEventListener('click', function () { formPopup.remove(); });
    form.querySelector('.save').addEventListener('click', function () {
      var name = nameEl.value.trim();
      if (name.length < 2) { errEl.textContent = 'Donne un nom (2 caractères minimum).'; nameEl.focus(); return; }
      var btn = form.querySelector('.save'); btn.disabled = true; btn.textContent = '…';
      var payload = { name: name, lon: lngLat.lng, lat: lngLat.lat, notes: notesEl.value.trim(),
                      inner_radius_m: Math.round(+innerEl.value || 0) };
      if (account.loggedIn) payload.share = share; else payload.author_token = clientToken();
      submitSpot(payload)
        .then(function (res) {
          if (res && res.ok) {
            formPopup.remove();
            if (account.loggedIn) toast(share ? 'Spot proposé — en attente de validation ✓' : 'Spot enregistré dans « Mes spots » ✓', 4200);
            else toast('Merci ! Ton spot est en attente de validation.', 4200);
            loadSpots().then(function () { renderTable(); });
          } else { errEl.textContent = (res && res.error) || 'Échec de l\'enregistrement.'; btn.disabled = false; btn.textContent = 'Enregistrer'; }
        })
        .catch(function () { errEl.textContent = 'Réseau indisponible, réessaie.'; btn.disabled = false; btn.textContent = 'Enregistrer'; });
    });
  }

  // ── rails GAUCHE : afficher/masquer les spots + ajouter (boutons icône) ──────
  // Présents dans le rail de base ET injectés dans les rails de calques chasse/étoile.
  var EYE_SVG = '<svg class="icon-svg" viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7Z"/><circle cx="12" cy="12" r="3"/></svg>';
  var ADD_SVG = '<svg class="icon-svg" viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 21s7-6.5 7-11a7 7 0 1 0-14 0c0 4.5 7 11 7 11Z"/><path d="M12 7v6M9 10h6"/></svg>';

  function injectRailButtons(railId) {
    var rail = document.getElementById(railId);
    if (!rail || rail.querySelector('.spots-toggle-btn')) return;
    var t = document.createElement('button'); t.type = 'button'; t.className = 'grid-focus-btn spots-toggle-btn';
    t.setAttribute('aria-label', 'Afficher / masquer les spots'); t.title = 'Afficher / masquer les spots'; t.innerHTML = EYE_SVG;
    var a = document.createElement('button'); a.type = 'button'; a.className = 'grid-focus-btn spots-add-btn';
    a.setAttribute('aria-label', 'Ajouter un spot'); a.title = 'Ajouter un spot'; a.innerHTML = ADD_SVG;
    rail.appendChild(t); rail.appendChild(a);
  }

  function syncToggleBtns() {
    document.querySelectorAll('.spots-toggle-btn').forEach(function (b) {
      b.classList.toggle('active', visible);
      b.setAttribute('aria-pressed', visible ? 'true' : 'false');
    });
  }

  function toggleSpots() {
    visible = !visible;
    applyVisibility();
    syncToggleBtns();
    if (!visible) clearVision();   // masque aussi le cercle de vision affiché
  }

  function wireLeftRail() {
    injectRailButtons('chaseLayerRail');
    injectRailButtons('stargazeLayerRail');
    document.querySelectorAll('.spots-toggle-btn').forEach(function (b) { b.addEventListener('click', toggleSpots); });
    document.querySelectorAll('.spots-add-btn').forEach(function (b) { b.addEventListener('click', function () { addMode ? exitAddMode() : enterAddMode(); }); });
    syncToggleBtns();
  }

  // ── init ───────────────────────────────────────────────────────────────────
  function init() {
    wireRail();
    wireLeftRail();
    if (typeof map === 'undefined') return;
    if (map.loaded()) { loadSpots(); ensureVisionLayers(); }
    else map.on('load', function () { loadSpots(); ensureVisionLayers(); });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();

  // exposé pour debug / rechargement après ajout
  // list() : spots publics + « mes spots » fusionnés/dédupliqués (pour « Autour de moi » du mode étoile).
  window.ObjectiFoudreSpots = { reload: loadSpots, highlightStorm: highlightStorm, clearStormHighlight: clearStormHighlight, list: function () { return renderList(); } };
})();
