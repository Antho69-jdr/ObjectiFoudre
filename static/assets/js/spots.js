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
    // marqueurs de crête
    for (i = 0; i < N; i++) {
      o = azimuths[i]; if (o.horizon_deg < BLOCK_DEG) continue;
      var m = pt(cx, cy, R, o.dist_km, i * step);
      svg.appendChild(el('circle', { cx: m[0], cy: m[1], r: big ? (2.4 + o.horizon_deg / 9) : (1.5 + o.horizon_deg / 16),
        fill: angColor(o.horizon_deg), stroke: COL.surface, 'stroke-width': 1.1 }));
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
      var stats = document.createElement('div'); stats.className = 'ofspot-stats';
      stats.innerHTML =
        statCell('Altitude', Math.round(h.z0) + ' m') +
        statCell('Horizon moyen', (h.mean_horizon_deg >= 0 ? '+' : '') + h.mean_horizon_deg + '°') +
        statCell('Ciel bas dégagé', h.pct_below_5deg + ' %') +
        statCell('Relief autour', '+' + (h.denivele_max_m || 0) + ' m');
      wrap.appendChild(stats);
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

  // ── marqueurs + calque ─────────────────────────────────────────────────────
  var markers = [], popup = null, visible = true, loaded = false, spotsData = [];

  function pinEl(spot) {
    var h = spot.horizon;
    var color = h ? scoreColor(h.openness) : COL.muted;
    var d = document.createElement('div');
    d.className = 'ofspot-pin';
    d.style.setProperty('--pin', color);
    d.setAttribute('role', 'button');
    d.setAttribute('tabindex', '0');
    d.setAttribute('aria-label', 'Spot ' + spot.name + (h ? ', ouverture ' + Math.round(h.openness) + ' sur 100' : ''));
    d.innerHTML = '<span class="ofspot-pin-dot"></span>';
    return d;
  }

  function openFiche(spot, lngLat) {
    if (typeof maplibregl === 'undefined' || typeof map === 'undefined') return;
    if (!popup) popup = new maplibregl.Popup({ className: 'ofspot-popup', closeButton: true, closeOnClick: true, maxWidth: '260px', offset: 16 });
    popup.setLngLat(lngLat).setDOMContent(buildFiche(spot)).addTo(map);
  }

  function clearMarkers() { markers.forEach(function (m) { m.remove(); }); markers = []; }

  function render(spots) {
    clearMarkers();
    if (typeof maplibregl === 'undefined' || typeof map === 'undefined') return;
    spots.forEach(function (spot) {
      if (typeof spot.lon !== 'number' || typeof spot.lat !== 'number') return;
      var e = pinEl(spot), lngLat = [spot.lon, spot.lat];
      e.addEventListener('click', function (ev) { ev.stopPropagation(); openFiche(spot, lngLat); });
      e.addEventListener('keydown', function (ev) { if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); openFiche(spot, lngLat); } });
      var mk = new maplibregl.Marker({ element: e, anchor: 'bottom' }).setLngLat(lngLat).addTo(map);
      // MapLibre force aria-label="Map marker" sur l'élément → on le rétablit après addTo
      var h = spot.horizon;
      e.setAttribute('aria-label', 'Spot ' + spot.name + (h ? ', ouverture ' + Math.round(h.openness) + ' sur 100' : ''));
      e.setAttribute('data-spot-id', spot.id);
      markers.push(mk);
    });
    applyVisibility();
  }

  function applyVisibility() {
    markers.forEach(function (m) { m.getElement().style.display = visible ? '' : 'none'; });
  }

  function loadSpots() {
    return fetch('/api/spots').then(function (r) { return r.json(); }).then(function (d) {
      if (d && d.ok && Array.isArray(d.spots)) { loaded = true; spotsData = d.spots; render(d.spots); }
      return d;
    }).catch(function () {/* non-fatal */});
  }

  // ── page « Mes spots » (onglet rail, style page Historique) ────────────────
  function openSpotsPage() {
    var pg = document.getElementById('spotsListPage');
    if (!pg) return;
    pg.setAttribute('aria-hidden', 'false');
    document.body.classList.add('spots-open');
    renderTable();                         // rendu immédiat avec les données courantes
    loadSpots().then(function () { renderTable(); });   // puis rafraîchi
  }

  function closeSpotsPage() {
    var pg = document.getElementById('spotsListPage');
    if (pg) pg.setAttribute('aria-hidden', 'true');
    document.body.classList.remove('spots-open');
  }

  // admin : réutilise le mécanisme existant (?admin=<secret> → classe objf-admin + objfAdminSecret)
  function isAdmin() { try { return document.documentElement.classList.contains('objf-admin'); } catch (e) { return false; } }
  function adminSecret() { try { return localStorage.getItem('objfAdminSecret') || ''; } catch (e) { return ''; } }

  function moderate(spotId, action, row) {
    var qs = '?secret=' + encodeURIComponent(adminSecret()) + '&action=' + action;
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
    fetch('/api/spots/pending?secret=' + encodeURIComponent(adminSecret()))
      .then(function (r) { return r.ok ? r.json() : { ok: false, status: r.status }; })
      .then(function (d) {
        sec.innerHTML = '';
        if (!d || !d.ok) { sec.className = 'ofspot-mod ofspot-mod-err'; sec.textContent = 'Modération inaccessible (secret admin invalide ?).'; return; }
        var pend = d.spots || [];
        var head = document.createElement('div'); head.className = 'ofspot-mod-head';
        var hl = document.createElement('span'); hl.className = 'ofspot-mod-title'; hl.textContent = 'Modération';
        var hb = document.createElement('span'); hb.className = 'ofspot-mod-badge'; hb.textContent = pend.length + ' en attente';
        var imp = document.createElement('button'); imp.type = 'button'; imp.className = 'ofspot-mod-btn ofspot-imp';
        imp.textContent = 'Importer un fichier';
        imp.addEventListener('click', openImportPicker);
        head.append(hl, hb, imp);
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
      fetch('/api/spots/import?secret=' + encodeURIComponent(adminSecret()), {
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

  function renderTable() {
    var body = document.getElementById('ofspotTableBody');
    if (!body) return;
    body.innerHTML = '';
    renderModeration(body);
    var bar = document.createElement('div'); bar.className = 'ofspot-tbl-bar';
    var count = document.createElement('span'); count.className = 'ofspot-tbl-count';
    count.textContent = spotsData.length + ' spot' + (spotsData.length > 1 ? 's' : '') + ' public' + (spotsData.length > 1 ? 's' : '');
    var addA = document.createElement('button'); addA.type = 'button'; addA.className = 'ofspot-tbl-add';
    addA.innerHTML = '<span class="plus" aria-hidden="true">+</span> Ajouter un spot';
    addA.addEventListener('click', function () { closeSpotsPage(); enterAddMode(); });
    bar.append(count, addA);
    body.appendChild(bar);
    if (!spotsData.length) {
      var empty = document.createElement('div'); empty.className = 'ofspot-empty';
      empty.textContent = 'Aucun spot public pour l\'instant. Ajoute le tien !';
      body.appendChild(empty); return;
    }
    var grid = document.createElement('div'); grid.className = 'ofspot-tbl-grid';
    spotsData.slice().sort(function (a, b) {
      return (b.horizon ? b.horizon.openness : -1) - (a.horizon ? a.horizon.openness : -1);
    }).forEach(function (spot) { grid.appendChild(tableCard(spot)); });
    body.appendChild(grid);
  }

  function tableCard(spot) {
    var h = spot.horizon;
    var card = document.createElement('div'); card.className = 'ofspot-card';
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
        + '<span>' + Math.round(h.z0) + ' m</span><span>relief +' + (h.denivele_max_m || 0) + ' m</span>';
    } else { meta.textContent = 'horizon en calcul…'; }
    info.append(nm, meta);
    if (spot.notes) { var nt = document.createElement('div'); nt.className = 'ofspot-card-notes'; nt.textContent = spot.notes; info.appendChild(nt); }
    main.append(ros, info);
    main.addEventListener('click', function () {
      closeSpotsPage();
      if (typeof map !== 'undefined') map.flyTo({ center: [spot.lon, spot.lat], zoom: 10 });
      setTimeout(function () { openFiche(spot, [spot.lon, spot.lat]); }, 700);
    });
    card.appendChild(main);
    if (isAdmin()) {
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
    moderate(spot.id, 'delete');   // moderate() rafraîchit table + marqueurs + toast
  }

  function openEditForm(spot) {
    var back = document.createElement('div'); back.className = 'ofspot-modal-back';
    var modal = document.createElement('div'); modal.className = 'ofspot-modal';
    modal.innerHTML =
      '<button type="button" class="ofspot-modal-close" aria-label="Fermer">×</button>' +
      '<h4>Modifier le spot</h4>' +
      '<label>Nom<input class="e-name" maxlength="60"></label>' +
      '<label>Description<textarea class="e-notes" rows="3" maxlength="280"></textarea></label>' +
      '<div class="ofspot-modal-coords"><label>Latitude<input class="e-lat" inputmode="decimal"></label>' +
      '<label>Longitude<input class="e-lon" inputmode="decimal"></label></div>' +
      '<div class="err" role="alert"></div>' +
      '<div class="ofspot-modal-row"><button type="button" class="del">Supprimer</button><span class="sp"></span>' +
      '<button type="button" class="cancel">Annuler</button><button type="button" class="save">Enregistrer</button></div>';
    back.appendChild(modal); document.body.appendChild(back);
    modal.querySelector('.e-name').value = spot.name || '';
    modal.querySelector('.e-notes').value = spot.notes || '';
    modal.querySelector('.e-lat').value = spot.lat;
    modal.querySelector('.e-lon').value = spot.lon;
    var err = modal.querySelector('.err');
    var close = function () { back.remove(); };
    modal.querySelector('.ofspot-modal-close').addEventListener('click', close);
    back.addEventListener('click', function (e) { if (e.target === back) close(); });
    document.addEventListener('keydown', function esc(e) { if (e.key === 'Escape') { close(); document.removeEventListener('keydown', esc); } });
    modal.querySelector('.cancel').addEventListener('click', close);
    modal.querySelector('.del').addEventListener('click', function () { close(); deleteSpot(spot); });
    modal.querySelector('.save').addEventListener('click', function () {
      var name = modal.querySelector('.e-name').value.trim();
      var notes = modal.querySelector('.e-notes').value.trim();
      var lat = parseFloat(String(modal.querySelector('.e-lat').value).replace(',', '.'));
      var lon = parseFloat(String(modal.querySelector('.e-lon').value).replace(',', '.'));
      if (name.length < 2) { err.textContent = 'Nom : 2 caractères minimum.'; return; }
      if (!Number.isFinite(lat) || !Number.isFinite(lon)) { err.textContent = 'Coordonnées invalides.'; return; }
      var btn = modal.querySelector('.save'); btn.disabled = true; btn.textContent = '…';
      fetch('/api/spots/' + spot.id + '/update?secret=' + encodeURIComponent(adminSecret()), {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: name, notes: notes, lat: lat, lon: lon }),
      }).then(function (r) { return r.ok ? r.json() : { ok: false }; })
        .then(function (res) {
          if (res && res.ok) { close(); toast('Spot modifié ✓'); loadSpots().then(function () { renderTable(); }); }
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

  // ── ajout d'un spot (bouton + → clic carte → formulaire) ───────────────────
  var addMode = false, addBtn = null, formPopup = null;

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

  function applyAddBtnVisibility() { if (addBtn) addBtn.classList.add('show'); }

  function enterAddMode() {
    if (typeof map === 'undefined') return;
    addMode = true;
    addBtn.classList.add('arming');
    addBtn.querySelector('.lbl').textContent = 'Clique sur la carte…';
    map.getCanvas().style.cursor = 'crosshair';
    map.on('click', onMapClickAdd);
    toast('Clique sur la carte pour poser ton spot');
  }

  function exitAddMode() {
    addMode = false;
    if (addBtn) { addBtn.classList.remove('arming'); addBtn.querySelector('.lbl').textContent = 'Ajouter un spot'; }
    if (typeof map !== 'undefined') { map.getCanvas().style.cursor = ''; map.off('click', onMapClickAdd); }
  }

  function onMapClickAdd(e) { if (!addMode) return; exitAddMode(); openAddForm(e.lngLat); }

  function submitSpot(payload) {
    return fetch('/api/spots', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) })
      .then(function (r) { return r.json().then(function (d) {
        return r.status === 422 ? { ok: false, error: 'Coordonnées hors France métropolitaine.' } : d;
      }); });
  }

  function openAddForm(lngLat) {
    var form = document.createElement('div'); form.className = 'ofspot-form';
    form.innerHTML =
      '<h4>Nouveau spot</h4>' +
      '<label>Nom<input type="text" maxlength="60" placeholder="Belvédère du…" class="f-name"></label>' +
      '<label>Description (optionnel)<textarea rows="2" maxlength="280" placeholder="Vue dégagée vers l\'ouest…" class="f-notes"></textarea></label>' +
      '<div class="err" role="alert"></div>' +
      '<div class="row"><button type="button" class="cancel">Annuler</button><button type="button" class="save">Enregistrer</button></div>';
    if (!formPopup) formPopup = new maplibregl.Popup({ className: 'ofspot-popup', closeButton: true, closeOnClick: false, maxWidth: '260px', offset: 16 });
    formPopup.setLngLat(lngLat).setDOMContent(form).addTo(map);
    var nameEl = form.querySelector('.f-name'), notesEl = form.querySelector('.f-notes'), errEl = form.querySelector('.err');
    setTimeout(function () { try { nameEl.focus(); } catch (e) {} }, 60);
    form.querySelector('.cancel').addEventListener('click', function () { formPopup.remove(); });
    form.querySelector('.save').addEventListener('click', function () {
      var name = nameEl.value.trim();
      if (name.length < 2) { errEl.textContent = 'Donne un nom (2 caractères minimum).'; nameEl.focus(); return; }
      var btn = form.querySelector('.save'); btn.disabled = true; btn.textContent = '…';
      submitSpot({ name: name, lon: lngLat.lng, lat: lngLat.lat, notes: notesEl.value.trim(), author_token: clientToken() })
        .then(function (res) {
          if (res && res.ok) { formPopup.remove(); toast('Merci ! Ton spot est en attente de validation.', 4200); }
          else { errEl.textContent = (res && res.error) || 'Échec de l\'enregistrement.'; btn.disabled = false; btn.textContent = 'Enregistrer'; }
        })
        .catch(function () { errEl.textContent = 'Réseau indisponible, réessaie.'; btn.disabled = false; btn.textContent = 'Enregistrer'; });
    });
  }

  function injectAddButton() {
    if (document.getElementById('ofspotAddBtn')) return;
    addBtn = document.createElement('button');
    addBtn.id = 'ofspotAddBtn'; addBtn.type = 'button'; addBtn.className = 'ofspot-add-btn';
    addBtn.setAttribute('aria-label', 'Ajouter un spot');
    addBtn.innerHTML = '<span class="plus" aria-hidden="true">+</span><span class="lbl">Ajouter un spot</span>';
    addBtn.addEventListener('click', function () { addMode ? exitAddMode() : enterAddMode(); });
    document.body.appendChild(addBtn);
    applyAddBtnVisibility();
  }

  // ── init ───────────────────────────────────────────────────────────────────
  function init() {
    wireRail();
    injectAddButton();
    if (typeof map === 'undefined') return;
    if (map.loaded()) loadSpots(); else map.on('load', loadSpots);
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();

  // exposé pour debug / rechargement après ajout
  window.ObjectiFoudreSpots = { reload: loadSpots };
})();
