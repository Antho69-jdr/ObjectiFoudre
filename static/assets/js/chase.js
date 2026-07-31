// Mode « En chasse » — superposé À LA CARTE DE BASE (plus de fenêtre dédiée).
// Un bouton bascule la vue : la grille de score est masquée et on affiche le RADAR OBSERVÉ
// (mosaïque réflectivité Météo-France 1 km, ~2 h de passé, une image par échéance) prolongé
// par le BLEND (advection radar 0-30 min, calcul serveur). Barre de contrôle (frise +
// bouton direct) et popup « conditions au point » au clic. Réutilise la carte `map` (state.js).
// AROME-PI SUPPRIMÉ (décision Anthony 2026-07-19, « pas efficace ») : plus de nowcast
// modèle, plus de pont, plus de couches grêle/graupel/rafales/CAPE/MOCON.
(function () {
  if (typeof maplibregl === 'undefined' || typeof map === 'undefined' || !map) return;
  const controls = document.getElementById('chaseControls');
  const toggleBtn = document.getElementById('chasePageBtn');
  if (!controls || !toggleBtn) return;

  const geoBtn = document.getElementById('chaseGeoBtn');
  const playBtn = document.getElementById('chasePlayBtn');
  const PLAY_SVG = '<svg class="icon-svg" viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"></circle><path d="M10 8.2 16.3 12 10 15.8Z" fill="currentColor" stroke="none"></path></svg>';
  const PAUSE_SVG = '<svg class="icon-svg" viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"></circle><rect x="9" y="8.3" width="2.2" height="7.4" rx="0.6" fill="currentColor" stroke="none"></rect><rect x="12.8" y="8.3" width="2.2" height="7.4" rx="0.6" fill="currentColor" stroke="none"></rect></svg>';
  const liveBtn = document.getElementById('chaseLiveBtn');
  const exportBtn = document.getElementById('chaseExportBtn');
  const slotStrip = document.getElementById('chaseSlots');
  const timeLabel = document.getElementById('chaseTimeLabel');
  const emptyHint = document.getElementById('chaseEmptyHint');
  const activityEl = document.getElementById('chaseActivity');
  const nowEl = document.getElementById('chaseNow');             // horloge (badge haut-centre)
  const metaRunEl = document.getElementById('metaRun');          // ligne meta-stack (attribution)
  let recording = false;
  let nowTimer = null;
  let savedMetaRun = null;

  // Radar observé = mosaïque réflectivité Météo-France 1 km (décodée/reprojetée serveur,
  // ring buffer ~2 h). AFFICHAGE VECTORIEL (v1.3.43, demande Anthony « bords lisses et
  // nets ») : le serveur sert les ZONES en GeoJSON (isobandes lissées, /api/radar/fr/
  // shapes) et MapLibre les dessine au GPU → net à TOUS les zooms, fini le raster qui
  // pixélise (nearest) ou floute (linear). UNE source geojson + un fill par bande (match),
  // setData par frame (pattern des cellules) + cache JS des FeatureCollections.
  const RADAR_POLY_SRC = 'chase-radar-poly';
  const RADAR_BAND_COLORS = ['#3ca0ff', '#28d2dc', '#3cdc6e', '#fae63c', '#faa028', '#f0462d', '#c828a0', '#ffffff'];
  // alphas de la palette raster (160→255) × l'ex raster-opacity 0.7 → même densité visuelle
  const RADAR_BAND_OPACITY = [0.44, 0.52, 0.58, 0.63, 0.66, 0.69, 0.70, 0.70];
  const EMPTY_FC = { type: 'FeatureCollection', features: [] };

  let active = false;
  let layersReady = false;
  let chaseClickBound = false;
  let frames = [];             // timeline unifiée : [{kind:'radar'|'blend', epoch, iso}]
  let cursor = 0;
  let playing = false;
  let playTimer = null;
  const shapeCache = new Map();   // clé frame → FeatureCollection (zones vectorielles)
  let shapeToken = 0;             // invalide un setData différé (fetch en cours au scrub)
  let cursorRaf = 0;              // rAF de coalescence des couches (scrub fluide)
  let cursorDirty = false;        // une frame reste à appliquer (dernière position demandée)
  // Rendu radar SANS re-tessellation : UNE couche fill PAR frame, triangulée une seule fois,
  // puis on bascule juste la VISIBILITÉ au changement d'horaire (instantané). clé frame → {srcId,layerId}.
  const radarLayers = new Map();
  let visibleRadarKey = null;     // clé de la couche-frame radar actuellement visible
  let radarPaint = null;          // paint (couleur/opacité par bande) partagé par toutes les couches-frames
  let symbolAnchorId = null;   // 1er calque symbol du style : les couches chasse s'insèrent dessous
  let frRadarTimes = [];       // échéances mosaïque France dispo (ISO, ~2 h)
  let frBlend = { times: [], speed_kmh: 0, advected: false };  // nowcast par advection radar (0-30 min)
  let frCells = { time: null, cells: [] };   // cellules suivies (moteur objets serveur)
  let cellsVisible = true;                    // toggle overlay cellules (bouton rail gauche)
  let liveLightning = { flashes: [] };        // foudre live MTG-LI ([lon,lat,epoch], ~30 min)
  let lightningVisible = true;                // toggle overlay foudre (bouton rail gauche)
  let prefetchGen = 0;          // jeton pour annuler un préchargement en cours
  let prefetchKick = null;      // timer de (re)lancement différé
  let loadToken = 0;
  let userPos = null;
  let userMarker = null;
  let follow = false;
  let watchId = null;
  let pointTimer = null;
  let refreshTimer = null;
  let atLiveEdge = true;       // l'utilisateur suit le « live » (dernière frame observée)
  let popup = null;
  let popupLngLat = null;

  function fmtClock(epoch) {
    const d = new Date(epoch * 1000);
    return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
  }

  // Génération du blend = epoch de l'obs source (base_time). Contrairement aux mosaïques
  // observées (URL figée), une échéance blend est RECALCULÉE toutes les 5 min avec un
  // contenu différent → la génération versionne la clé de cache ET l'URL (cache-buster),
  // sinon la géométrie d'origine reste affichée jusqu'au F5 (bug vécu sur les textures).
  let blendGen = 0;
  function frameShapesUrl(fr) {
    return fr.kind === 'blend'
      ? '/api/radar/fr/blend/shapes?time=' + encodeURIComponent(fr.iso) + '&v=' + blendGen
      : '/api/radar/fr/shapes?time=' + encodeURIComponent(fr.iso);
  }
  function frameShapesKey(fr) { return (fr.kind === 'blend' ? 'b' + blendGen + ':' : 'r:') + fr.iso; }
  // « observé/extrapolé » = radar réel OU frame advectée (blend) : mêmes domaine, palette et
  // rendu (par frame).
  function isRadarLike(fr) { return fr && (fr.kind === 'radar' || fr.kind === 'blend'); }

  // ── Préchargement (navigation fluide) ───────────────────────────────────────
  // Clé API limitée à 50 req/min → préchargement LENT (file séquentielle) et dédupliqué ;
  // le cache serveur (long) rend les revisites gratuites. Priorités : (1) couche active
  // sur toute la frise, (2) échéance courante des autres onglets. (Les tuiles radar sont
  // préchargées par MapLibre lui-même : couches par frame visibles à opacité 0.)
  async function runPrefetch(gen) {
    // Toutes les frames de la frise → zones en cache + COUCHE-FRAME pré-créée (cachée), pour une
    // révélation instantanée au scrub/lecture (triangulation payée une fois, ici, hors interaction).
    for (const fr of frames.filter(isRadarLike)) {
      if (gen !== prefetchGen || !active) return;
      const key = frameShapesKey(fr);
      let fc = shapeCache.get(key);
      if (!fc) {
        try { fc = await fetchFrameShapes(fr); } catch (_) { fc = null; }
        await new Promise((f) => setTimeout(f, 250));  // débit doux (serveur cache après 1er rendu)
        if (gen !== prefetchGen || !active) return;
      }
      if (fc && layersReady) { try { ensureRadarFrameLayer(fr, fc); } catch (_) {} }
    }
  }

  function schedulePrefetch() {
    if (!active) return;
    const gen = ++prefetchGen;                          // annule le préchargement en cours
    if (prefetchKick) clearTimeout(prefetchKick);
    prefetchKick = setTimeout(() => { if (gen === prefetchGen) runPrefetch(gen); }, 500);
  }

  // ── Couche RADAR VECTORIELLE (zones GeoJSON) ────────────────────────────────
  // ensureLayers repère l'ancre d'insertion (sous les libellés villes) ET crée UNE fois la
  // source geojson + le fill par bande (couleur/opacité via `match` sur la propriété `b`).
  // Isobandes non chevauchantes → un seul fill suffit (pas d'empilement d'alphas).
  function ensureLayers() {
    if (layersReady) return true;
    if (!map.isStyleLoaded || !map.isStyleLoaded()) return false;
    const sym = ((map.getStyle() || {}).layers || []).find((l) => l.type === 'symbol');
    symbolAnchorId = sym ? sym.id : null;
    // Paint partagé (couleur + opacité par bande `b`) réutilisé pour CHAQUE couche-frame radar.
    const colorMatch = ['match', ['get', 'b']];
    const opMatch = ['match', ['get', 'b']];
    for (let b = 1; b <= RADAR_BAND_COLORS.length; b += 1) {
      colorMatch.push(b, RADAR_BAND_COLORS[b - 1]);
      opMatch.push(b, RADAR_BAND_OPACITY[b - 1]);
    }
    colorMatch.push('#3ca0ff'); opMatch.push(0.5);   // défaut
    radarPaint = { 'fill-color': colorMatch, 'fill-opacity': opMatch, 'fill-antialias': true };
    layersReady = true;
    return true;
  }

  // FeatureCollection d'une frame (cache JS, fetch dédupliqué). Le serveur cache par échéance
  // (1er rendu ~0,5 s puis instantané) ; ici on garde les FC en mémoire pour un scrub fluide.
  async function fetchFrameShapes(fr) {
    const key = frameShapesKey(fr);
    const hit = shapeCache.get(key);
    if (hit) return hit;
    const fc = await (await fetch(frameShapesUrl(fr), { cache: 'force-cache' })).json();
    shapeCache.set(key, fc);
    // purge : ne garder que les frames encore dans la frise (+ générations blend courantes).
    if (shapeCache.size > 64) {
      const live = new Set(frames.filter(isRadarLike).map(frameShapesKey));
      for (const k of Array.from(shapeCache.keys())) if (!live.has(k)) shapeCache.delete(k);
    }
    return fc;
  }

  // Pose la géométrie de la frame `fr` sur la source (immédiat si en cache, sinon fetch ;
  // `tok` invalide un setData différé quand l'utilisateur a bougé entre-temps).
  function radarFrameIds(fr) {
    const base = RADAR_POLY_SRC + '-' + frameShapesKey(fr).replace(/[^a-z0-9]/gi, '_');
    return { srcId: base, layerId: base + '-fill' };
  }

  // Crée (si besoin) la couche fill de la frame : la géométrie est TRIANGULÉE ICI, une fois.
  function ensureRadarFrameLayer(fr, fc) {
    const key = frameShapesKey(fr);
    const existing = radarLayers.get(key);
    if (existing && map.getLayer(existing.layerId)) return existing;   // déjà là (et pas purgée par un reload de style)
    const { srcId, layerId } = radarFrameIds(fr);
    try {
      if (!map.getSource(srcId)) map.addSource(srcId, { type: 'geojson', data: fc });
      if (!map.getLayer(layerId)) {
        const before = (symbolAnchorId && map.getLayer(symbolAnchorId)) ? symbolAnchorId : undefined;
        map.addLayer({ id: layerId, type: 'fill', source: srcId,
          layout: { visibility: 'none' }, paint: radarPaint }, before);
      }
    } catch (_) { return null; }
    const rec = { srcId, layerId };
    radarLayers.set(key, rec);
    return rec;
  }

  function revealRadar(rec, key) {
    if (visibleRadarKey === key && map.getLayer(rec.layerId)) return;
    try { map.setLayoutProperty(rec.layerId, 'visibility', 'visible'); } catch (_) {}
    if (visibleRadarKey && visibleRadarKey !== key) {
      const prev = radarLayers.get(visibleRadarKey);
      if (prev) { try { map.setLayoutProperty(prev.layerId, 'visibility', 'none'); } catch (_) {} }
    }
    visibleRadarKey = key;
  }

  // Affiche la frame `fr` : INSTANTANÉ si sa couche existe (bascule de visibilité), sinon
  // charge ses zones (cache→immédiat, sinon fetch) PUIS l'affiche — en gardant la frame
  // courante pendant l'attente. `tok` annule une révélation périmée si on a bougé au scrub.
  function showRadarFrame(fr) {
    const key = frameShapesKey(fr);
    const rec = radarLayers.get(key);
    if (rec && map.getLayer(rec.layerId)) { revealRadar(rec, key); return; }
    const cached = shapeCache.get(key);
    if (cached) { const r = ensureRadarFrameLayer(fr, cached); if (r) revealRadar(r, key); return; }
    const tok = ++shapeToken;
    fetchFrameShapes(fr).then((fc) => {
      if (tok !== shapeToken || !active) return;   // frame changée entre-temps → abandon
      const r = ensureRadarFrameLayer(fr, fc);
      if (r) revealRadar(r, key);
    }).catch(() => {});
  }

  // Purge les couches-frames absentes de la frise (réactualisation, changement de génération
  // blend) → borne la mémoire GPU. Appelé après chaque (re)construction de la timeline.
  function pruneRadarFrameLayers() {
    const live = new Set(frames.filter(isRadarLike).map(frameShapesKey));
    for (const [key, rec] of Array.from(radarLayers.entries())) {
      if (live.has(key)) continue;
      if (key === visibleRadarKey) visibleRadarKey = null;
      try { if (map.getLayer(rec.layerId)) map.removeLayer(rec.layerId); } catch (_) {}
      try { if (map.getSource(rec.srcId)) map.removeSource(rec.srcId); } catch (_) {}
      radarLayers.delete(key);
    }
  }

  // Retire TOUTES les couches-frames radar (sortie du mode chasse).
  function clearRadarFrameLayers() {
    for (const rec of radarLayers.values()) {
      try { if (map.getLayer(rec.layerId)) map.removeLayer(rec.layerId); } catch (_) {}
      try { if (map.getSource(rec.srcId)) map.removeSource(rec.srcId); } catch (_) {}
    }
    radarLayers.clear();
    visibleRadarKey = null;
  }

  // ── Overlay CELLULES SUIVIES (moteur objets serveur) ──────────────────────────
  // Donnée vectorielle /api/radar/fr/cells : le champ image reste au blend (mesuré meilleur),
  // les cellules apportent la SÉMANTIQUE — trajectoire passée (trait plein), prévue +30 min
  // (pointillés), point coloré par TENDANCE (rouge=croissance, bleu=décroissance) + vitesse.
  const CELLS_SRC = 'chase-cells';
  const CELL_TREND = { grow: '#ff5a3c', decay: '#4ea0ff', steady: '#e6e05f' };
  const CARDINALS = ['N', 'NE', 'E', 'SE', 'S', 'SO', 'O', 'NO'];
  function bearingCard(b) { return CARDINALS[Math.round(((b % 360) + 360) % 360 / 45) % 8]; }

  // Position d'une cellule À L'HEURE t (epoch s) : interpolation sur la piste passée
  // (points [lon,lat,epoch]), extrapolation linéaire au-delà de la dernière observation
  // (vecteur dérivé des points `future`, bornée à +45 min), null avant la naissance de la
  // piste (la cellule n'existait pas) ou au-delà de l'horizon d'extrapolation → masquée.
  function cellPosAt(c, t) {
    const past = Array.isArray(c.past) ? c.past : [];
    if (!past.length || !Number.isFinite(t)) return [c.lon, c.lat];
    const born = past[0][2], lastT = past[past.length - 1][2];
    if (t < born - 300) return null;                       // pas encore née (marge 5 min)
    if (t <= lastT) {
      let i = 0;
      while (i < past.length - 1 && past[i + 1][2] <= t) i += 1;
      if (i >= past.length - 1) return [past[past.length - 1][0], past[past.length - 1][1]];
      const a = past[i], b = past[i + 1];
      const f = (b[2] > a[2]) ? Math.max(0, Math.min(1, (t - a[2]) / (b[2] - a[2]))) : 0;
      return [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f];
    }
    const dt = t - lastT;
    if (dt > 45 * 60) return null;                          // extrapolation bornée à +45 min
    const fut = Array.isArray(c.future) ? c.future : [];
    if (!fut.length) return [c.lon, c.lat];
    const fin = fut[fut.length - 1];
    const span = Math.max(1, fin[2] - lastT);
    return [c.lon + (fin[0] - c.lon) / span * dt, c.lat + (fin[1] - c.lat) / span * dt];
  }

  function cellsGeojson() {
    const feats = [];
    const fr = frames[cursor];
    const t = fr ? fr.epoch : (Date.now() / 1000);          // heure de la frame sélectionnée
    for (let ci = 0; ci < (frCells.cells || []).length; ci += 1) {
      const c = frCells.cells[ci];
      const color = CELL_TREND[c.trend] || CELL_TREND.steady;
      const pos = cellPosAt(c, t);
      if (!pos) continue;                                    // pas née / au-delà de l'horizon
      const past = Array.isArray(c.past) ? c.past : [];
      // au-delà de la dernière OBSERVATION radar → position extrapolée (dead reckoning) :
      // marquée « estimé » + point atténué, pour ne pas la vendre comme une détection.
      const est = past.length ? (t > past[past.length - 1][2] + 60) : false;
      // trace passée : les points de piste antérieurs à t, raccordés à la position affichée.
      const trail = past.filter((p) => p[2] <= t).map((p) => [p[0], p[1]]);
      trail.push(pos);
      if (trail.length > 1) {
        feats.push({ type: 'Feature', properties: { kind: 'past', color }, geometry: { type: 'LineString', coordinates: trail } });
      }
      // trajectoire prévue : +30 min DEPUIS la position affichée (vecteur constant).
      if (c.speed_kmh > 5) {
        const p30 = cellPosAt(c, t + 30 * 60);
        if (p30) {
          feats.push({ type: 'Feature', properties: { kind: 'future', color }, geometry: { type: 'LineString', coordinates: [pos, p30] } });
        }
      }
      // POINT CENTRAL translucide posé sur le CŒUR (plus de polygone de zone, demande
      // Anthony 2026-07-19) : anneau net + remplissage léger → la COULEUR RADAR du cœur
      // reste lisible sous le point. `id` séquentiel stable = clé du feature-state hover.
      feats.push({ type: 'Feature', id: ci, properties: { kind: 'core', color, cellIdx: ci, est: est ? 1 : 0 }, geometry: { type: 'Point', coordinates: pos } });
      const arrow = c.trend === 'grow' ? ' ▲' : (c.trend === 'decay' ? ' ▼' : '');
      const zap = (c.flashes_10min > 0) ? '⚡ ' : '';   // électriquement active (foudre live)
      const label = zap + (c.speed_kmh > 5 ? `${c.speed_kmh} km/h ${bearingCard(c.bearing)}${arrow}` : `statique${arrow}`) + (est ? ' · estimé' : '');
      // libellé AU-DESSUS du point (offset) pour ne pas recouvrir la couleur du cœur.
      feats.push({ type: 'Feature', properties: { kind: 'lbl', color, label, cellIdx: ci, est: est ? 1 : 0 }, geometry: { type: 'Point', coordinates: pos } });
    }
    return { type: 'FeatureCollection', features: feats };
  }

  function syncCellsOverlay() {
    if (!layersReady || !active) return;
    const gj = cellsGeojson();
    const src = map.getSource(CELLS_SRC);
    if (src) {
      try { src.setData(gj); } catch (_) {}
    } else {
      try {
        map.addSource(CELLS_SRC, { type: 'geojson', data: gj });
        // au-dessus de tout (labels villes inclus) : c'est l'info de décision, elle prime.
        // POINT CENTRAL translucide au cœur : anneau net (teinte tendance) + remplissage
        // LÉGER → la couleur radar du cœur reste visible dessous ; densifié au survol.
        map.addLayer({ id: CELLS_SRC + '-core', type: 'circle', source: CELLS_SRC,
          filter: ['==', ['get', 'kind'], 'core'],
          paint: {
            'circle-radius': ['interpolate', ['linear'], ['zoom'], 5.5, 5, 9, 10],
            'circle-color': ['get', 'color'],
            'circle-opacity': ['case', ['boolean', ['feature-state', 'hover'], false], 0.32,
              ['case', ['==', ['get', 'est'], 1], 0.08, 0.15]],
            'circle-stroke-color': ['get', 'color'],
            'circle-stroke-width': ['case', ['boolean', ['feature-state', 'hover'], false], 2.4, 1.6],
            'circle-stroke-opacity': ['case', ['==', ['get', 'est'], 1], 0.5, 0.9],
          } });
        map.addLayer({ id: CELLS_SRC + '-past', type: 'line', source: CELLS_SRC,
          filter: ['==', ['get', 'kind'], 'past'],
          paint: { 'line-color': ['get', 'color'], 'line-width': 1.5, 'line-opacity': 0.55 } });
        map.addLayer({ id: CELLS_SRC + '-traj', type: 'line', source: CELLS_SRC,
          filter: ['==', ['get', 'kind'], 'future'],
          paint: { 'line-color': ['get', 'color'], 'line-width': 2, 'line-opacity': 0.9, 'line-dasharray': [2, 2] } });
        // libellé vitesse/cap AU-DESSUS du point (le cœur reste dégagé).
        map.addLayer({ id: CELLS_SRC + '-lbl', type: 'symbol', source: CELLS_SRC,
          filter: ['==', ['get', 'kind'], 'lbl'],
          layout: { 'text-field': ['get', 'label'], 'text-font': ['Montserrat Medium', 'Open Sans Bold'],
                    'text-size': 10.5, 'text-anchor': 'bottom', 'text-offset': [0, -1.1], 'text-allow-overlap': false },
          paint: { 'text-color': ['get', 'color'], 'text-halo-color': '#0b0f14', 'text-halo-width': 1.4,
                   'text-opacity': ['case', ['==', ['get', 'est'], 1], 0.6, 0.95] } });
        bindCellHover();
      } catch (_) {}
    }
    applyCellsVisibility();
  }

  // Survol/tap d'une ZONE de cellule → remplissage plus dense (feature-state) + tooltip
  // (fiche cellule). Tablette : pas de survol → le tap ouvre le tooltip (épinglé).
  let hoverCellId = null;
  function setCellHover(id) {
    if (hoverCellId === id) return;
    if (hoverCellId != null) { try { map.setFeatureState({ source: CELLS_SRC, id: hoverCellId }, { hover: false }); } catch (_) {} }
    hoverCellId = id;
    if (id != null) { try { map.setFeatureState({ source: CELLS_SRC, id }, { hover: true }); } catch (_) {} }
  }
  function bindCellHover() {
    const SHAPE = CELLS_SRC + '-core';
    // Le survol ne fait QUE curseur + surbrillance : plus d'aperçu popup au survol.
    // Le menu de cellule s'ouvre au CLIC (épinglé) et ne doit PAS se fermer quand la
    // souris bouge pour aller cliquer une option → aucun close au mouseleave.
    map.on('mousemove', SHAPE, (e) => {
      const f = e.features && e.features[0];
      if (!f) return;
      map.getCanvas().style.cursor = 'pointer';
      setCellHover(f.id);
    });
    map.on('mouseleave', SHAPE, () => {
      map.getCanvas().style.cursor = '';
      setCellHover(null);
    });
  }

  function applyCellsVisibility() {
    const vis = (active && cellsVisible) ? 'visible' : 'none';
    for (const suf of ['-core', '-past', '-traj', '-lbl']) {
      try { if (map.getLayer(CELLS_SRC + suf)) map.setLayoutProperty(CELLS_SRC + suf, 'visibility', vis); } catch (_) {}
    }
  }

  // ── Overlay FOUDRE LIVE (MTG-LI) : impacts des 30 min PRÉCÉDANT l'heure de la frise
  // (au « live » : maintenant, pour montrer les flashs plus frais que la mosaïque radar),
  // fondu par âge (<5 min vif, 5-15 atténué, >15 discret). Sous les cellules.
  const LIGHTNING_SRC = 'chase-lightning';

  function lightningGeojson() {
    const now = Date.now() / 1000;
    const fr = frames[cursor];
    const t = (atLiveEdge || !fr) ? now : fr.epoch;   // référence temporelle = frise
    const feats = [];
    for (const f of (liveLightning.flashes || [])) {
      const age = t - f[2];
      if (age < 0 || age > 30 * 60) continue;
      const cls = age < 5 * 60 ? 0 : (age < 15 * 60 ? 1 : 2);
      feats.push({ type: 'Feature', properties: { a: cls }, geometry: { type: 'Point', coordinates: [f[0], f[1]] } });
    }
    return { type: 'FeatureCollection', features: feats };
  }

  function syncLightningOverlay() {
    if (!layersReady || !active) return;
    const gj = lightningGeojson();
    const src = map.getSource(LIGHTNING_SRC);
    if (src) {
      try { src.setData(gj); } catch (_) {}
    } else {
      try {
        map.addSource(LIGHTNING_SRC, { type: 'geojson', data: gj });
        // halo lumineux dessous (les points seuls étaient quasi invisibles sur le radar)
        map.addLayer({ id: LIGHTNING_SRC + '-glow', type: 'circle', source: LIGHTNING_SRC,
          paint: {
            'circle-radius': ['interpolate', ['linear'], ['zoom'],
              5, ['match', ['get', 'a'], 0, 8, 1, 5.5, 3.5],
              9, ['match', ['get', 'a'], 0, 15, 1, 10, 6]],
            'circle-color': ['match', ['get', 'a'], 0, '#ffe14d', 1, '#f0b93a', '#a8842e'],
            'circle-blur': 1.1,
            'circle-opacity': ['match', ['get', 'a'], 0, 0.6, 1, 0.32, 0.14],
          } });
        map.addLayer({ id: LIGHTNING_SRC + '-pt', type: 'circle', source: LIGHTNING_SRC,
          paint: {
            'circle-radius': ['interpolate', ['linear'], ['zoom'],
              5, ['match', ['get', 'a'], 0, 3.6, 1, 2.6, 1.8],
              9, ['match', ['get', 'a'], 0, 6, 1, 4.4, 3]],
            'circle-color': ['match', ['get', 'a'], 0, '#fffbe0', 1, '#ffd54a', '#c49a3f'],
            'circle-opacity': ['match', ['get', 'a'], 0, 1, 1, 0.75, 0.4],
            'circle-stroke-color': '#7a5a10',
            'circle-stroke-width': ['match', ['get', 'a'], 0, 1, 0.5],
          } });
        // les cellules restent AU-DESSUS de la foudre : re-hisser leurs couches si présentes.
        for (const suf of ['-core', '-past', '-traj', '-lbl']) {
          try { if (map.getLayer(CELLS_SRC + suf)) map.moveLayer(CELLS_SRC + suf); } catch (_) {}
        }
      } catch (_) {}
    }
    applyLightningVisibility();
  }

  function applyLightningVisibility() {
    const vis = (active && lightningVisible) ? 'visible' : 'none';
    for (const suf of ['-glow', '-pt']) {
      try { if (map.getLayer(LIGHTNING_SRC + suf)) map.setLayoutProperty(LIGHTNING_SRC + suf, 'visibility', vis); } catch (_) {}
    }
  }

  // Menace pour un point (popup position) : cellule dont la trajectoire passe à < 15 km,
  // ETA = instant d'approche minimale (approx plate carrée locale, largement suffisant).
  function cellThreat(lat, lon) {
    let best = null;
    for (const c of (frCells.cells || [])) {
      if (!(c.speed_kmh > 8)) continue;
      const br = c.bearing * Math.PI / 180;
      const vN = c.speed_kmh * Math.cos(br), vE = c.speed_kmh * Math.sin(br);
      const dN = (lat - c.lat) * 111.0;
      const dE = (lon - c.lon) * 111.0 * Math.cos(lat * Math.PI / 180);
      const v2 = vN * vN + vE * vE;
      const tStar = (dN * vN + dE * vE) / v2;          // heures avant approche minimale
      if (tStar <= 0 || tStar > 1.5) continue;          // s'éloigne, ou > 90 min
      const cN = dN - vN * tStar, cE = dE - vE * tStar;
      const dMin = Math.hypot(cN, cE);
      if (dMin > 15) continue;
      const eta = Math.max(1, Math.round(tStar * 60));
      if (!best || eta < best.eta) best = { eta, cell: c };
    }
    return best;
  }

  function setVis(id, on) {
    if (map.getLayer(id)) map.setLayoutProperty(id, 'visibility', on ? 'visible' : 'none');
  }

  // Masquer / réafficher la grille de score (toutes les couches `grid*`). La visibilité
  // persiste aux mises à jour de données (setData), donc régler une fois à la bascule suffit.
  function hideGrid(hide) {
    const layers = ((map.getStyle() || {}).layers) || [];
    for (const l of layers) {
      if (l.id && l.id.indexOf('grid') === 0) {
        try { map.setLayoutProperty(l.id, 'visibility', hide ? 'none' : 'visible'); } catch (_) {}
      }
    }
  }

  async function fetchSources(token) {
    let fr = null;
    try { fr = await (await fetch('/api/radar/fr/status')).json(); } catch (_) {}
    let bl = null;
    try { bl = await (await fetch('/api/radar/fr/blend/status')).json(); } catch (_) {}
    let ce = null;
    try { ce = await (await fetch('/api/radar/fr/cells')).json(); } catch (_) {}
    let li = null;
    try { li = await (await fetch('/api/lightning/live')).json(); } catch (_) {}
    if (token !== loadToken) return;
    frRadarTimes = (fr && fr.ok && Array.isArray(fr.times)) ? fr.times : [];
    frBlend = (bl && bl.ok) ? bl : { times: [], speed_kmh: 0, advected: false };
    blendGen = frBlend.base_time ? Math.floor(new Date(frBlend.base_time).getTime() / 1000) : 0;
    frCells = (ce && ce.ok && Array.isArray(ce.cells)) ? ce : { time: null, cells: [] };
    liveLightning = (li && li.ok && Array.isArray(li.flashes)) ? li : { flashes: [] };
    syncCellsOverlay();
    syncLightningOverlay();
    buildTimeline();
  }

  async function loadData() {
    const token = ++loadToken;
    if (emptyHint) { emptyHint.hidden = false; emptyHint.textContent = 'Chargement du radar…'; }
    await fetchSources(token);
    if (token !== loadToken) return;
    // attribution dans la meta-stack (ligne #metaRun, restaurée à la sortie)
    if (metaRunEl) metaRunEl.textContent = 'Radar : Météo-France 1 km · Extrapolation : advection radar';
    if (!frames.length) {
      if (emptyHint) { emptyHint.hidden = false; emptyHint.textContent = 'Aucune donnée radar disponible.'; }
      return;
    }
    if (emptyHint) emptyHint.hidden = true;
    atLiveEdge = true;
    cursor = liveIndex();
    updateLiveBtn();
    renderFrise();
    applyCursor();
    schedulePrefetch();
  }

  // Rafraîchissement périodique : nouvelles frames radar + run AROME-PI éventuel, en
  // conservant la position temporelle (ou en suivant le « live » si on y était).
  async function refreshData() {
    if (!active || !frames.length) return;
    const token = ++loadToken;
    const prevEpoch = frames[cursor] ? frames[cursor].epoch : null;
    const wasLive = atLiveEdge;
    await fetchSources(token);
    if (token !== loadToken || !frames.length) return;
    if (wasLive || prevEpoch == null) {
      cursor = liveIndex();
    } else {
      let best = 0, bestD = Infinity;
      frames.forEach((f, i) => { const dd = Math.abs(f.epoch - prevEpoch); if (dd < bestD) { bestD = dd; best = i; } });
      cursor = best;
    }
    atLiveEdge = cursor >= liveIndex();
    updateLiveBtn();
    renderFrise();
    applyCursor();
    schedulePrefetch();
  }

  function buildTimeline() {
    const nowSec = Date.now() / 1000;
    const out = [];
    // PASSÉ observé = mosaïques réflectivité MF (ring buffer ~2 h), toute l'amplitude.
    for (const iso of frRadarTimes) {
      const epoch = Math.floor(new Date(iso).getTime() / 1000);
      if (Number.isFinite(epoch)) out.push({ kind: 'radar', epoch, iso });
    }
    // BLEND : frames advectées (radar extrapolé) qui comblent le trou de latence et le
    // 0-30 min à venir, ancrées sur l'observation. Si le mouvement n'est PAS fiable
    // (persistance), les frames FUTURES seraient identiques à la dernière mosaïque →
    // on ne garde que le comblement du trou jusqu'à ~maintenant.
    const blendTimes = (frBlend && Array.isArray(frBlend.times)) ? frBlend.times : [];
    const blendAdvected = !!(frBlend && frBlend.advected);
    for (const iso of blendTimes) {
      const epoch = Math.floor(new Date(iso).getTime() / 1000);
      if (!Number.isFinite(epoch)) continue;
      if (!blendAdvected && epoch > nowSec + 60) continue;   // persistance : pas de futur identique
      out.push({ kind: 'blend', epoch, iso });
    }
    out.sort((a, b) => a.epoch - b.epoch);
    frames = out;
    if (layersReady) pruneRadarFrameLayers();   // retire les couches-frames sorties de la frise
  }

  function applyCursor() {
    if (!active || !layersReady || !frames.length) return;
    const fr = frames[cursor];
    if (!fr) return;
    const isBlend = fr.kind === 'blend';
    if (timeLabel) {
      const d = new Date(fr.epoch * 1000);
      const date = String(d.getDate()).padStart(2, '0') + '/' + String(d.getMonth() + 1).padStart(2, '0');
      timeLabel.textContent = date + ' ' + fmtClock(fr.epoch) + (isBlend ? ' · extrapolé' : ' · observé');
      timeLabel.classList.toggle('is-future', isBlend);
    }
    updateActive();
    // badge : « MF 1 km » (observé) / « extrapolé · N km/h » (advection réelle) /
    // « obs. maintenue » (persistance, mouvement non fiable → comblement du trou).
    if (activityEl) {
      if (isBlend) { activityEl.textContent = frBlend.advected ? ('extrapolé · ' + frBlend.speed_kmh + ' km/h') : 'obs. maintenue'; activityEl.className = 'chase-activity lvl-low'; }
      else { activityEl.textContent = 'MF 1 km'; activityEl.className = 'chase-activity lvl-low'; }
    }
    // RADAR : simple bascule de visibilité (aucune re-triangulation) → SYNCHRONE, instantané,
    // suit le doigt au scrub. Les overlays plus lourds (cellules + foudre, setData) restent
    // coalescés sur rAF : on n'applique que la DERNIÈRE frame demandée, une fois par frame max.
    showRadarFrame(fr);
    cursorDirty = true;
    if (!cursorRaf) cursorRaf = requestAnimationFrame(flushCursorLayers);
  }

  function flushCursorLayers() {
    cursorRaf = 0;
    if (!cursorDirty || !active || !layersReady || !frames.length) return;
    cursorDirty = false;
    const fr = frames[cursor];
    if (!fr) return;
    syncCellsOverlay();       // repositionne les cellules à l'heure de la frame (setData léger)
    syncLightningOverlay();   // refiltre les impacts sur [t−30 min, t] de la frame
    schedulePointForCurrent();
  }

  function liveIndex() {
    let last = -1;
    for (let i = 0; i < frames.length; i += 1) if (frames[i].kind === 'radar') last = i;
    return last < 0 ? 0 : last;
  }

  function setCursor(i) {
    cursor = Math.min(frames.length - 1, Math.max(0, i));
    atLiveEdge = cursor >= liveIndex();
    updateLiveBtn();
    applyCursor();
  }

  // Le bouton « direct » s'allume (rouge, comme play) quand on est sur l'heure la plus
  // proche du présent (dernière frame observée). Cliquer = y revenir.
  function updateLiveBtn() {
    if (!liveBtn) return;
    liveBtn.classList.toggle('active', atLiveEdge);
    liveBtn.setAttribute('aria-pressed', atLiveEdge ? 'true' : 'false');
  }

  function goLive() {
    if (!frames.length) return;
    stop();
    atLiveEdge = true;
    setCursor(liveIndex());
    syncWheelToCursor(true);
  }

  // ── Frise = RAIL (desktop/tablette) + MOLETTE tactile (mobile), identiques à la frise de
  // base. Le rail (.timeline-rail*) et la molette (.timeline-wheel*) réutilisent les classes
  // CSS de timeline.js ; le CSS de base bascule l'un/l'autre selon body.mobile-ui + largeur
  // (cf. responsive.css). Recolorés en rouge (cf. components.css). Les fonctions de phase
  // solaire globales de timeline.js (jour/nuit/lever/coucher) sont mappées sur la fenêtre chase.
  let railTrack = null;
  let railMarks = [];
  let wheelScroller = null;
  let wheelItems = [];
  let wheelProgrammatic = false;   // scroll piloté par le code → ignore le handler de scroll
  let wheelSnapTimer = null;
  let wheelRafId = null;
  const WHEEL_VISIBLE = 5;         // nb d'items visibles (≈ --timeline-wheel-visible-hours CSS)

  function railFrac(epoch) {
    if (!frames.length) return 0;
    const t0 = frames[0].epoch, t1 = frames[frames.length - 1].epoch;
    return Math.max(0, Math.min(100, ((epoch - t0) / Math.max(1, t1 - t0)) * 100));
  }

  function addChasePhaseIcons(track) {
    if (typeof timelinePhaseDefinitions !== 'function' || typeof timelinePhaseIconSvg !== 'function') return;
    const t0 = frames[0].epoch, t1 = frames[frames.length - 1].epoch;
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
        const pct = railFrac(midnight + ph.hour * 3600);
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

  // Pour la molette : associe chaque phase solaire à l'index de frame le plus proche.
  function chasePhaseFrameMap() {
    const out = new Map();
    if (typeof timelinePhaseDefinitions !== 'function' || typeof timelinePhaseIconSvg !== 'function' || !frames.length) return out;
    const t0 = frames[0].epoch, t1 = frames[frames.length - 1].epoch;
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
        const tph = midnight + ph.hour * 3600;
        if (tph < t0 || tph > t1) continue;
        let best = -1, bd = Infinity;
        frames.forEach((f, i) => { const d = Math.abs(f.epoch - tph); if (d < bd) { bd = d; best = i; } });
        if (best >= 0 && !out.has(best)) out.set(best, ph);
      }
    }
    return out;
  }

  function buildRail() {
    const rail = document.createElement('div');
    rail.className = 'timeline-rail chase-rail';
    rail.setAttribute('role', 'slider');
    rail.setAttribute('aria-label', 'Échéance radar');
    rail.tabIndex = 0;
    const track = document.createElement('div');
    track.className = 'timeline-rail-track';
    addChasePhaseIcons(track);
    const fill = document.createElement('div'); fill.className = 'timeline-rail-fill'; track.appendChild(fill);
    const cur = document.createElement('div'); cur.className = 'timeline-rail-cursor';
    cur.innerHTML = `<span>${fmtClock(frames[cursor].epoch)}</span>`; track.appendChild(cur);
    let prevHour = null;
    frames.forEach((fr, i) => {
      const mark = document.createElement('div');
      mark.className = 'timeline-hour-mark' + (i === cursor ? ' active' : '');
      mark.style.left = railFrac(fr.epoch) + '%';
      mark.dataset.idx = String(i);
      const line = document.createElement('span'); line.className = 'timeline-hour-line';
      const label = document.createElement('span'); label.className = 'timeline-hour-label';
      const h = new Date(fr.epoch * 1000).getHours();
      if (h !== prevHour) { label.textContent = String(h).padStart(2, '0'); prevHour = h; }
      mark.appendChild(line); mark.appendChild(label);
      track.appendChild(mark);
      railMarks.push(mark);
    });
    rail.appendChild(track);
    railTrack = track;
    attachRailDrag(rail);
    return rail;
  }

  // Molette tactile : MÊME structure DOM/classes que la frise de base mobile (timeline.js),
  // donc le CSS mobile (responsive.css) la stylise à l'identique. Pilotée par `frames`/`cursor`.
  function buildWheel(phaseMap) {
    const wheel = document.createElement('div');
    wheel.className = 'timeline-wheel chase-wheel';
    wheel.setAttribute('aria-hidden', 'false');
    const scroller = document.createElement('div');
    scroller.className = 'timeline-wheel-scroller';
    scroller.setAttribute('role', 'listbox');
    scroller.setAttribute('aria-label', 'Échéance radar');
    let prevHour = null;
    frames.forEach((fr, i) => {
      const d = new Date(fr.epoch * 1000);
      const time = fmtClock(fr.epoch);
      const sparse = (d.getHours() !== prevHour) ? String(d.getHours()).padStart(2, '0') : '';
      prevHour = d.getHours();
      const item = document.createElement('button');
      item.type = 'button';
      item.className = 'timeline-wheel-item' + (i === cursor ? ' active' : '');
      item.dataset.idx = String(i);
      item.dataset.time = time;
      item.dataset.sparse = sparse;
      item.setAttribute('role', 'option');
      item.setAttribute('aria-selected', i === cursor ? 'true' : 'false');
      item.setAttribute('aria-label', time + (fr.kind === 'blend' ? ' (extrapolé)' : ' (observé)'));
      const ph = phaseMap.get(i);
      if (ph) {
        const icon = document.createElement('span');
        icon.className = `timeline-wheel-light-icon timeline-wheel-light-icon-${ph.type}`;
        icon.dataset.tooltip = ph.label || ph.type;
        icon.innerHTML = timelinePhaseIconSvg(ph.type);
        item.appendChild(icon);
      }
      const line = document.createElement('span'); line.className = 'timeline-wheel-line';
      const label = document.createElement('span'); label.className = 'timeline-wheel-label';
      label.textContent = (i === cursor) ? time : sparse;
      item.appendChild(line); item.appendChild(label);
      item.addEventListener('click', (e) => {
        e.preventDefault(); e.stopPropagation();
        if (wheelSnapTimer) { clearTimeout(wheelSnapTimer); wheelSnapTimer = null; }
        stop(); setCursor(i); wheelScrollTo(i, true);
      });
      scroller.appendChild(item);
      wheelItems.push(item);
    });
    // Pendant le scroll : seule la mise en évidence de l'item centré (pas de chargement).
    scroller.addEventListener('scroll', () => {
      if (wheelProgrammatic || wheelRafId) return;
      wheelRafId = requestAnimationFrame(() => {
        wheelRafId = null;
        if (!scroller.isConnected) return;
        const iw = scroller.clientWidth / WHEEL_VISIBLE;
        if (!iw) return;
        setWheelActive(Math.max(0, Math.min(Math.round(scroller.scrollLeft / iw), wheelItems.length - 1)));
      });
    }, { passive: true });
    scroller.addEventListener('scrollend', () => {
      if (wheelProgrammatic) return;
      if (wheelSnapTimer) { clearTimeout(wheelSnapTimer); wheelSnapTimer = null; }
      wheelCommit();
    }, { passive: true });
    // l'utilisateur prend la main → on arrête la lecture (sinon la molette est pilotée par play)
    scroller.addEventListener('pointerdown', () => stop());
    scroller.addEventListener('touchend', () => wheelScheduleSnap(600), { passive: true });
    scroller.addEventListener('pointercancel', () => wheelScheduleSnap(600));
    scroller.addEventListener('wheel', (e) => {
      e.preventDefault();
      const delta = Math.abs(e.deltaY) > Math.abs(e.deltaX) ? e.deltaY : e.deltaX;
      if (!delta) return;
      scroller.scrollBy({ left: delta, behavior: 'auto' });
      wheelScheduleSnap(150);
    }, { passive: false });
    wheel.appendChild(scroller);
    wheelScroller = scroller;
    return wheel;
  }

  function setWheelActive(idx) {
    wheelItems.forEach((it, i) => {
      const on = i === idx;
      it.classList.toggle('active', on);
      it.setAttribute('aria-selected', on ? 'true' : 'false');
      const lab = it.querySelector('.timeline-wheel-label');
      if (lab) { const want = on ? it.dataset.time : it.dataset.sparse; if (lab.textContent !== want) lab.textContent = want; }
    });
  }

  function wheelScrollTo(idx, smooth, tries) {
    if (!wheelScroller) return;
    if (wheelScroller.offsetParent === null) return;        // molette masquée (desktop) → rien
    const iw = wheelScroller.clientWidth / WHEEL_VISIBLE;
    if (!iw) { if ((tries || 0) < 6) requestAnimationFrame(() => wheelScrollTo(idx, smooth, (tries || 0) + 1)); return; }
    const target = idx * iw;
    wheelProgrammatic = true;
    if (smooth && typeof wheelScroller.scrollTo === 'function') {
      wheelScroller.scrollTo({ left: target, behavior: 'smooth' });
      setTimeout(() => { wheelProgrammatic = false; }, 380);
    } else {
      wheelScroller.scrollLeft = target;
      requestAnimationFrame(() => { wheelProgrammatic = false; });
    }
  }

  function wheelCommit() {
    if (!wheelScroller || playing) return;                   // en lecture, c'est play qui pilote
    const iw = wheelScroller.clientWidth / WHEEL_VISIBLE;
    if (!iw) return;
    const idx = Math.max(0, Math.min(Math.round(wheelScroller.scrollLeft / iw), wheelItems.length - 1));
    if (idx === cursor) return;                              // déjà sur la bonne frame → pas de recharge
    stop(); setCursor(idx); wheelScrollTo(idx, true);
  }

  function wheelScheduleSnap(delay) {
    if (wheelSnapTimer) clearTimeout(wheelSnapTimer);
    wheelSnapTimer = setTimeout(() => { wheelSnapTimer = null; wheelCommit(); }, delay);
  }

  function syncWheelToCursor(smooth) { if (wheelScroller) wheelScrollTo(cursor, smooth); }

  function renderFrise() {
    if (!slotStrip) return;
    slotStrip.innerHTML = '';
    railTrack = null; railMarks = [];
    wheelScroller = null; wheelItems = [];
    if (!frames.length) return;
    const phaseMap = chasePhaseFrameMap();
    slotStrip.appendChild(buildWheel(phaseMap));   // molette (mobile)
    slotStrip.appendChild(buildRail());            // rail (desktop/tablette)
    requestAnimationFrame(() => syncWheelToCursor(false));
  }

  // Met à jour l'état visuel actif (rail + molette) sans déclencher de chargement.
  function updateActive() {
    if (!frames.length) return;
    if (railTrack) {
      railTrack.style.setProperty('--timeline-active-pct', railFrac(frames[cursor].epoch) + '%');
      const cur = railTrack.querySelector('.timeline-rail-cursor span');
      if (cur) cur.textContent = fmtClock(frames[cursor].epoch);
      railMarks.forEach((m, i) => m.classList.toggle('active', i === cursor));
    }
    if (wheelItems.length) setWheelActive(cursor);
  }

  function attachRailDrag(rail) {
    const pickIndex = (clientX) => {
      const r = rail.getBoundingClientRect();
      const frac = Math.max(0, Math.min(1, (clientX - r.left - 7) / Math.max(1, r.width - 14)));
      const t0 = frames[0].epoch, t1 = frames[frames.length - 1].epoch;
      const target = t0 + frac * (t1 - t0);
      let best = 0, bd = Infinity;
      frames.forEach((f, i) => { const d = Math.abs(f.epoch - target); if (d < bd) { bd = d; best = i; } });
      return best;
    };
    let dragging = false;
    rail.addEventListener('pointerdown', (e) => { dragging = true; try { rail.setPointerCapture(e.pointerId); } catch (_) {} stop(); setCursor(pickIndex(e.clientX)); });
    rail.addEventListener('pointermove', (e) => { if (dragging) setCursor(pickIndex(e.clientX)); });
    rail.addEventListener('pointerup', () => { dragging = false; });
    rail.addEventListener('pointercancel', () => { dragging = false; });
    rail.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowLeft') { stop(); setCursor(cursor - 1); e.preventDefault(); }
      else if (e.key === 'ArrowRight') { stop(); setCursor(cursor + 1); e.preventDefault(); }
    });
  }

  function play() {
    if (playing) return stop();
    if (!frames.length) return;
    playing = true;
    if (playBtn) { playBtn.classList.add('active'); playBtn.setAttribute('aria-pressed', 'true'); playBtn.setAttribute('aria-label', 'Pause'); playBtn.title = 'Pause'; playBtn.innerHTML = PAUSE_SVG; }
    playTimer = window.setInterval(() => {
      let next = cursor + 1;
      if (next >= frames.length) next = 0;
      setCursor(next);
      syncWheelToCursor(true);   // la molette (mobile) suit la lecture
    }, 700);
  }
  function stop() {
    playing = false;
    if (playBtn) { playBtn.classList.remove('active'); playBtn.setAttribute('aria-pressed', 'false'); playBtn.setAttribute('aria-label', "Lecture de l'animation"); playBtn.title = "Lecture de l'animation"; playBtn.innerHTML = PLAY_SVG; }
    if (playTimer) { window.clearInterval(playTimer); playTimer = null; }
  }

  // ── Export animation (vidéo WebM via MediaRecorder sur le canvas de la carte) ──
  async function exportAnimation() {
    if (recording || !frames.length || !window.MediaRecorder) return;
    const canvas = map.getCanvas();
    let stream;
    try { stream = canvas.captureStream(25); } catch (_) { return; }
    const mime = ['video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm'].find((m) => MediaRecorder.isTypeSupported(m)) || 'video/webm';
    let rec;
    try { rec = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: 6000000 }); } catch (_) { return; }
    const chunks = [];
    rec.ondataavailable = (e) => { if (e.data && e.data.size) chunks.push(e.data); };
    const done = new Promise((res) => { rec.onstop = res; });
    recording = true; stop();
    if (exportBtn) { exportBtn.classList.add('active'); exportBtn.disabled = true; exportBtn.title = 'Enregistrement de l’animation…'; }
    const wasCursor = cursor;
    rec.start();
    for (let i = 0; i < frames.length; i += 1) {
      if (!active) break;
      setCursor(i);
      try { map.triggerRepaint(); } catch (_) {}
      await new Promise((f) => setTimeout(f, 550));   // laisse l'image se rendre (frames préchargées)
    }
    await new Promise((f) => setTimeout(f, 300));
    try { rec.stop(); } catch (_) {}
    await done;
    recording = false;
    if (exportBtn) { exportBtn.classList.remove('active'); exportBtn.disabled = false; exportBtn.title = "Exporter l'animation (vidéo WebM)"; }
    setCursor(wasCursor);
    if (chunks.length) {
      const blob = new Blob(chunks, { type: 'video/webm' });
      const url = URL.createObjectURL(blob);
      const stamp = new Date().toISOString().slice(0, 16).replace(/[-:T]/g, '');
      const a = document.createElement('a');
      a.href = url; a.download = `chasse_radar_${stamp}.webm`;
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 8000);
    }
  }

  // ── Conditions à un point (popup) ───────────────────────────────────────────
  function currentFrameIso() {
    const fr = frames[cursor];
    return fr ? fr.iso : null;
  }

  function schedulePointForCurrent() {
    // ne re-interroge que si un popup est ouvert (sur le point cliqué / la position suivie).
    if (!popup || !popup.isOpen() || !popupLngLat) return;
    if (pointTimer) window.clearTimeout(pointTimer);
    pointTimer = window.setTimeout(() => queryPoint(popupLngLat.lat, popupLngLat.lon, false), 250);
  }

  function showPopup(lat, lon, html) {
    popupLngLat = { lat, lon };
    if (!popup) popup = new maplibregl.Popup({ closeButton: true, closeOnClick: false, className: 'chase-popup', maxWidth: '250px', offset: 12 });
    popup.setLngLat([lon, lat]).setHTML(html).addTo(map);
  }

  // ── Tooltip CELLULE (survol desktop / tap tablette) ─────────────────────────
  // Popup de cellule (menu au clic, cf. showCellMenu). Épinglé (closeButton, reste
  // jusqu'au × ou au prochain clic ailleurs) ; ne suit pas la souris.
  let cellPopup = null;
  let cellPopupIdx = -1;
  let cellPopupPinned = false;
  function closeCellPopup() {
    cellPopupPinned = false;
    cellPopupIdx = -1;
    if (cellPopup && cellPopup.isOpen()) cellPopup.remove();
    // ferme aussi la mise en avant « spots viables » liée à la cellule (Phase 1).
    if (window.ObjectiFoudreSpots && window.ObjectiFoudreSpots.clearStormHighlight) {
      try { window.ObjectiFoudreSpots.clearStormHighlight(); } catch (_) {}
    }
  }

  // ── Menu de cellule (clic) : petite modale d'options — Voir les spots / Détails ──
  const CCM_PIN = '<svg class="ccm-ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 21s-6-5.2-6-10a6 6 0 1 1 12 0c0 4.8-6 10-6 10Z"></path><circle cx="12" cy="11" r="2.2"></circle></svg>';
  const CCM_INFO = '<svg class="ccm-ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"></circle><path d="M12 11.2v4.6"></path><path d="M12 7.7h.01" stroke-width="2.4"></path></svg>';
  function cellMenuHTML(c) {
    const mv = c.speed_kmh > 5 ? `${c.speed_kmh} km/h ${bearingCard(c.bearing)}` : 'quasi statique';
    const dbz = c.peak_dbz != null ? ` · ${Math.round(c.peak_dbz)} dBZ` : '';
    const hasSpots = !!(window.ObjectiFoudreSpots && window.ObjectiFoudreSpots.highlightStorm);
    return `<div class="chase-cell-menu">`
      + `<div class="ccm-head">⛈ Cellule suivie<span class="ccm-sub">${mv}${dbz}</span></div>`
      + (hasSpots ? `<button type="button" class="ccm-opt ccm-opt-spots" data-act="spots">${CCM_PIN}<span>Voir les spots viables</span></button>` : '')
      + `<button type="button" class="ccm-opt" data-act="details">${CCM_INFO}<span>Détails de la cellule</span></button>`
      + `</div>`;
  }
  function cellDetailsHTML(c) {
    return `<button type="button" class="ccm-back" data-act="back">‹ Options</button>` + renderCellHTML(c);
  }
  function wireCellMenu(c) {
    const root = cellPopup && cellPopup.getElement();
    if (!root) return;
    root.querySelectorAll('.ccm-opt').forEach((btn) => {
      btn.addEventListener('click', () => {
        if (btn.dataset.act === 'spots') {
          if (window.ObjectiFoudreSpots && window.ObjectiFoudreSpots.highlightStorm) {
            try { window.ObjectiFoudreSpots.highlightStorm(c); } catch (_) {}
          }
          // ferme le menu SANS passer par closeCellPopup (qui effacerait le highlight)
          cellPopupPinned = false;
          if (cellPopup) cellPopup.remove();
        } else if (btn.dataset.act === 'details') {
          cellPopup.setHTML(cellDetailsHTML(c));
          wireCellBack(c);
        }
      });
    });
  }
  function wireCellBack(c) {
    const root = cellPopup && cellPopup.getElement();
    if (!root) return;
    const b = root.querySelector('.ccm-back');
    if (b) b.addEventListener('click', () => { cellPopup.setHTML(cellMenuHTML(c)); wireCellMenu(c); });
  }
  // Clic cellule → ouvre le MENU (épinglé). Le survol desktop garde l'aperçu détails.
  function showCellMenu(c) {
    if (!cellPopup) cellPopup = new maplibregl.Popup({ closeButton: true, closeOnClick: false, className: 'chase-popup chase-cell-popup', maxWidth: '250px', offset: 14 });
    cellPopupIdx = (frCells.cells || []).indexOf(c);
    cellPopupPinned = true;
    const t = frames[cursor] ? frames[cursor].epoch : (Date.now() / 1000);
    const pos = cellPosAt(c, t) || [c.lon, c.lat];
    cellPopup.setLngLat(pos).setHTML(cellMenuHTML(c)).addTo(map);
    wireCellMenu(c);
    cellPopup.once('close', () => { cellPopupPinned = false; cellPopupIdx = -1; });
  }

  async function queryPoint(lat, lon, fromTap) {
    const t = currentFrameIso();
    if (!t) return;
    if (fromTap) { userPos = userPos || { lat, lon }; }
    showPopup(lat, lon, '<div class="chase-pop-loading">Lecture radar…</div>');
    const token = ++loadToken;
    let obs = null;
    try {
      // valeurs OBSERVÉES (mosaïque radar MF) au point — plus de nowcast modèle.
      if (frRadarTimes.length) obs = await (await fetch('/api/radar/fr/point?lat=' + lat + '&lon=' + lon)).json();
    } catch (_) {}
    if (token !== loadToken) return;
    if (!popup || !popup.isOpen()) return;        // popup fermé entre-temps
    if (!obs || !obs.ok || !obs.in_domain) { showPopup(lat, lon, '<div class="chase-pop-empty">Conditions indisponibles ici.</div>'); return; }
    showPopup(lat, lon, renderPositionHTML(t, obs, { lat, lon }));
  }

  function renderPositionHTML(t, obs, pos) {
    // verdict = l'écho MESURÉ (dBZ radar) — le nowcast modèle a été retiré.
    const obsV = obs && obs.values || {};
    const echo = (typeof obsV.reflectivity === 'number') ? Math.max(0, obsV.reflectivity) : null;
    let verdict, cls;
    if (echo !== null && echo >= 45) { verdict = '⛈ Cellule active'; cls = 'sev-high'; }
    else if (echo !== null && echo >= 20) { verdict = '🌧 Précipitations'; cls = 'sev-mid'; }
    else { verdict = '🌤 Calme'; cls = 'sev-low'; }
    let html = `<div class="chase-verdict ${cls}">${verdict}<span class="chase-verdict-time">${fmtClock(Math.floor(new Date(t).getTime() / 1000))}</span></div>`;
    // Alerte d'approche (moteur cellules) : trajectoire passant à < 15 km de ce point.
    const threat = pos ? cellThreat(pos.lat, pos.lon) : null;
    if (threat) {
      const tc = threat.cell;
      const trendTxt = tc.trend === 'grow' ? 'en intensification' : (tc.trend === 'decay' ? 'en affaiblissement' : 'stable');
      html += `<div class="chase-pos-eta">⚠ Cellule en approche · ~${threat.eta} min · ${tc.speed_kmh} km/h ${bearingCard(tc.bearing)} · ${trendTxt}</div>`;
    }
    // Bloc OBSERVÉ (radar MF) — les valeurs mesurées au sol.
    const obsRows = [
      ['Réflectivité', typeof obsV.reflectivity === 'number' ? Math.round(Math.max(0, obsV.reflectivity)) : '—', ' dBZ'],
      ['Sommet d’écho', typeof obsV.echo_top_km === 'number' ? obsV.echo_top_km.toFixed(1) : '—', ' km'],
      ['Proba pluie', typeof obsV.rain_prob === 'number' ? obsV.rain_prob : '—', ' %'],
    ];
    const obsClock = fmtClock(Math.floor(new Date(obs.time).getTime() / 1000));
    html += `<div class="chase-pos-head">Observé · radar MF <span>${obsClock}</span></div>`;
    html += '<ul class="chase-pos-list">' + obsRows.map((r) => `<li><span>${r[0]}</span><strong>${r[1]}${(r[2] && r[1] !== '—') ? `<span class="chase-unit">${r[2]}</span>` : ''}</strong></li>`).join('') + '</ul>';
    return html;
  }

  function placeUserMarker() {
    if (!userPos) return;
    if (!userMarker) {
      const el = document.createElement('div');
      el.className = 'chase-user-dot';
      userMarker = new maplibregl.Marker({ element: el });
    }
    userMarker.setLngLat([userPos.lon, userPos.lat]).addTo(map);
  }

  function toggleFollow() {
    follow = !follow;
    geoBtn.classList.toggle('active', follow);
    geoBtn.setAttribute('aria-pressed', follow ? 'true' : 'false');
    // bouton icône → on ne touche PAS au contenu (SVG) : juste la classe active + le titre.
    if (follow) {
      if (!navigator.geolocation) { geoBtn.title = 'Géoloc indisponible'; follow = false; geoBtn.classList.remove('active'); return; }
      geoBtn.title = 'Suivi actif (cliquer pour arrêter)';
      let firstFix = true;
      watchId = navigator.geolocation.watchPosition((pos) => {
        userPos = { lat: pos.coords.latitude, lon: pos.coords.longitude };
        placeUserMarker();
        if (follow) {
          if (firstFix) {
            // premier point : on cadre une fois (zoom mini 8 uniquement si très dézoomé).
            map.easeTo({ center: [userPos.lon, userPos.lat], zoom: Math.max(map.getZoom(), 8) });
            firstFix = false;
          } else {
            // suivis : recentrer SANS toucher au zoom, et seulement si on a bougé notablement.
            const c = map.getCenter();
            if (Math.abs(c.lng - userPos.lon) + Math.abs(c.lat - userPos.lat) > 0.0015) {
              map.easeTo({ center: [userPos.lon, userPos.lat] });
            }
          }
        }
        schedulePointForCurrent();
      }, () => { geoBtn.title = 'Géoloc refusée'; follow = false; geoBtn.classList.remove('active'); }, { enableHighAccuracy: true, maximumAge: 15000, timeout: 12000 });
    } else {
      geoBtn.title = 'Me suivre';
      if (watchId != null && navigator.geolocation) navigator.geolocation.clearWatch(watchId);
      watchId = null;
    }
  }

  // Légende par couche. Gradient EXACT (couleurs = ce qui est peint sur la carte) pour la
  // réflectivité (notre palette dBZ) et la CAPE (style MF calibré vs WCS). Pour les autres
  // (rafales/grêle/graupel/mocon), on ne peut pas calibrer l'échelle complète sur données
  // faibles → gradient indicatif + SEUIL CHASSE (l'info actionnable ; les valeurs exactes
  // au point sont dans le popup au clic).
  // Légende unique : réflectivité radar (les couches AROME-PI ont été retirées).
  const REFLECTIVITY_LEGEND = { title: 'Réflectivité', grad: ['#3ca0ff', '#28d2dc', '#3cdc6e', '#fae63c', '#faa028', '#f0462d', '#c828a0'], scale: ['8 dBZ', '32', '56+'], note: 'Cellule active > 45 dBZ' };
  function renderLegend() {
    const cfg = REFLECTIVITY_LEGEND;
    const titleEl = document.getElementById('chaseLegendTitle');
    const barEl = document.getElementById('chaseLegendBar');
    const scaleEl = document.getElementById('chaseLegendScale');
    const noteEl = document.getElementById('chaseLegendNote');
    if (titleEl) titleEl.textContent = cfg.title;
    if (barEl) barEl.style.background = 'linear-gradient(90deg, ' + cfg.grad.join(', ') + ')';
    if (scaleEl) scaleEl.innerHTML = cfg.scale.map((s) => `<span>${s}</span>`).join('');
    if (noteEl) { noteEl.textContent = cfg.note || ''; noteEl.hidden = !cfg.note; }
  }

  function onChaseClick(e) {
    // PRIORITÉ à une ZONE de cellule sous le clic : tap tablette → tooltip cellule ÉPINGLÉ
    // (le survol n'existe pas au tactile). La couche peut être absente (overlay off / pas
    // de données). Un clic AILLEURS ferme le tooltip épinglé et fait le popup position.
    try {
      if (cellsVisible && map.getLayer(CELLS_SRC + '-core')) {
        // boîte élargie autour du tap : le point est petit, la cible tactile ne l'est pas.
        const bb = [[e.point.x - 14, e.point.y - 14], [e.point.x + 14, e.point.y + 14]];
        const hits = map.queryRenderedFeatures(bb, { layers: [CELLS_SRC + '-core'] });
        if (hits && hits.length) {
          const idx = hits[0].properties && hits[0].properties.cellIdx;
          const c = (frCells.cells || [])[idx];
          if (c) { setCellHover(hits[0].id); showCellMenu(c); return; }
        }
      }
    } catch (_) {}
    // Popup « conditions au point » (.chase-popup) RETIRÉ — item Trello UI/UX (info jugée
    // inutile). On ne garde que le popup de CELLULE suivie (ci-dessus). Un clic ailleurs
    // ferme simplement le popup cellule épinglé.
    closeCellPopup();
  }

  // Fiche CELLULE (clic sur un point de l'overlay) : identité + cinématique + tendance,
  // et si la géoloc est active, l'approche vers TA position (même math que cellThreat).
  function renderCellHTML(c) {
    const color = CELL_TREND[c.trend] || CELL_TREND.steady;
    const trendTxt = c.trend === 'grow' ? 'En intensification' : (c.trend === 'decay' ? 'En affaiblissement' : 'Stable');
    const trendCls = c.trend === 'grow' ? 'sev-high' : (c.trend === 'decay' ? 'sev-mid' : 'sev-watch');
    const upd = c.epoch ? fmtClock(c.epoch) : '—';
    let html = `<div class="chase-verdict ${trendCls}" style="border-color:${color}">⛈ Cellule suivie · ${trendTxt}<span class="chase-verdict-time">${upd}</span></div>`;
    const flashTrendTxt = c.flash_trend === 'up' ? ' (en hausse)' : (c.flash_trend === 'down' ? ' (en baisse)' : '');
    const rows = [
      ['Déplacement', c.speed_kmh > 5 ? `${c.speed_kmh} km/h ${bearingCard(c.bearing)}` : 'quasi statique', ''],
      ['Pic mesuré', c.peak_dbz != null ? Math.round(c.peak_dbz) : '—', ' dBZ'],
      ['Étendue', c.area_km2 != null ? c.area_km2.toLocaleString('fr-FR') : '—', ' km²'],
      ['Évolution', (typeof c.growth_pct_10min === 'number' && c.growth_pct_10min !== 0) ? `${c.growth_pct_10min > 0 ? '+' : ''}${c.growth_pct_10min} %/10 min` : 'stable', ''],
      ['⚡ Foudre', (c.flashes_10min > 0) ? `${c.flashes_10min} écl./10 min${flashTrendTxt}` : 'aucune détectée', ''],
    ];
    if (typeof c.age_min === 'number' && c.age_min > 0) {
      rows.push(['Âge', `${c.age_open ? '> ' : '~'}${c.age_min} min`, '']);
    }
    // pronostic de dissipation : seulement quand il est SIGNIFICATIF — cellule en déclin,
    // ou pronostic court (une « stable » au plafond de 120 min = bruit, pas une info).
    if (typeof c.life_min === 'number' && (c.trend === 'decay' || c.life_min <= 60)) {
      rows.push(['Dissipation estimée', `~${Math.max(5, c.life_min)} min`, '']);
    }
    html += '<ul class="chase-pos-list">' + rows.map((r) => `<li><span>${r[0]}</span><strong>${r[1]}${(r[2] && r[1] !== '—') ? `<span class="chase-unit">${r[2]}</span>` : ''}</strong></li>`).join('') + '</ul>';
    // approche vers la position suivie (si géoloc active)
    if (userPos && c.speed_kmh > 8) {
      const br = c.bearing * Math.PI / 180;
      const vN = c.speed_kmh * Math.cos(br), vE = c.speed_kmh * Math.sin(br);
      const dN = (userPos.lat - c.lat) * 111.0;
      const dE = (userPos.lon - c.lon) * 111.0 * Math.cos(userPos.lat * Math.PI / 180);
      const v2 = vN * vN + vE * vE;
      const tStar = (dN * vN + dE * vE) / v2;
      const dMin = Math.hypot(dN - vN * tStar, dE - vE * tStar);
      if (tStar > 0 && tStar <= 1.5 && dMin <= 15) {
        html += `<div class="chase-pos-eta">⚠ Sur ta position dans ~${Math.max(1, Math.round(tStar * 60))} min (passe à ${Math.round(dMin)} km)</div>`;
      } else {
        html += `<div class="chase-pos-head">Ne se dirige pas vers ta position</div>`;
      }
    }
    return html;
  }

  function updateNow() {
    if (!nowEl) return;
    const d = new Date();
    nowEl.textContent = String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0') + ':' + String(d.getSeconds()).padStart(2, '0');
  }

  // ── Recolor ROUGE de la carte de base en mode chasse ─────────────────────────
  // Teinte terres + mers/océans + tracés régions/départements en rouge (identité
  // chasse). Le radar et la grille de score ne sont PAS touchés (autres couches).
  // Valeurs NORMALES = celles posées par improveCartoVectorReadability (state.js).
  const CHASE_MAP_TINT = [
    ['background', 'background-color', '#160a0c', '#08101c'],
    ['water', 'fill-color', 'rgba(58, 30, 34, 1)', 'rgba(38, 56, 72, 1)'],
    ['landuse_residential', 'fill-color', 'rgba(38, 20, 22, 0.72)', 'rgba(17, 28, 42, 0.72)'],
    ['waterway', 'line-color', 'rgba(120, 70, 74, 0.55)', 'rgba(70, 100, 124, 0.55)'],
    ['france-department-lines', 'line-color', 'rgba(180, 120, 124, 0.5)', 'rgba(120, 145, 175, 0.5)'],
    ['france-region-lines', 'line-color', 'rgba(208, 150, 154, 0.62)', 'rgba(150, 176, 208, 0.62)'],
  ];
  function setChaseMapTint(on) {
    if (!map) return;
    const apply = () => {
      for (const [layer, prop, chaseVal, normalVal] of CHASE_MAP_TINT) {
        if (map.getLayer(layer)) {
          try { map.setPaintProperty(layer, prop, on ? chaseVal : normalVal); } catch (_) {}
        }
      }
    };
    if (map.isStyleLoaded && map.isStyleLoaded()) apply();
    else map.once('idle', apply);
  }

  // ── Activation / désactivation (bascule sur la carte de base) ────────────────
  async function activate() {
    if (active) return;
    // exclusion mutuelle avec le mode chasse d'étoile
    if (typeof window.exitStargazeMode === 'function') window.exitStargazeMode();
    active = true;
    toggleBtn.classList.add('active');
    toggleBtn.setAttribute('aria-pressed', 'true');
    controls.setAttribute('aria-hidden', 'false');
    document.body.classList.add('chase-mode');
    setChaseMapTint(true);
    renderLegend();   // légende réflectivité (seule couche restante)
    // on garde la meta-stack visible : sa ligne #metaRun reçoit l'attribution (sauvegarde
    // pour restauration à la sortie). Badge haut-centre : horloge live.
    savedMetaRun = metaRunEl ? metaRunEl.textContent : null;
    updateNow();
    if (nowTimer) window.clearInterval(nowTimer);
    nowTimer = window.setInterval(updateNow, 1000);
    if (ensureLayers()) {
      hideGrid(true);
    } else {
      // Style pas encore prêt. ⚠️ PAS un simple once('idle') : isStyleLoaded() repasse à
      // false à chaque chargement de la carte de base (grille en cours de matérialisation
      // → setData périodiques), et un retry unique peut retomber pile à un mauvais moment
      // → mode chasse SANS AUCUNE couche, définitivement (vécu). On réessaie en boucle
      // tant que le mode est actif.
      const retryLayers = () => {
        if (!active) return;
        if (ensureLayers()) { hideGrid(true); applyCursor(); return; }
        window.setTimeout(retryLayers, 250);
      };
      window.setTimeout(retryLayers, 250);
    }
    if (!chaseClickBound) { map.on('click', onChaseClick); chaseClickBound = true; }
    if (refreshTimer) window.clearInterval(refreshTimer);
    // 60 s (au lieu de 120) : le radar MF publie une échéance /5 min avec ~13 min de
    // latence de production ; un refresh plus prompt fait suivre le « direct » au plus
    // près de la dernière mosaïque ingérée (status = JSON léger, coût négligeable).
    refreshTimer = window.setInterval(refreshData, 60000);
    await loadData();
  }

  function deactivate() {
    if (!active) return;
    active = false;
    stop();
    toggleBtn.classList.remove('active');
    toggleBtn.setAttribute('aria-pressed', 'false');
    controls.setAttribute('aria-hidden', 'true');
    document.body.classList.remove('chase-mode');
    setChaseMapTint(false);
    if (nowTimer) { window.clearInterval(nowTimer); nowTimer = null; }
    if (metaRunEl && savedMetaRun != null) { metaRunEl.textContent = savedMetaRun; savedMetaRun = null; }
    // retirer toutes les couches-frames radar (libère la mémoire GPU hors mode chasse).
    clearRadarFrameLayers();
    shapeToken++;
    applyCellsVisibility();              // masque l'overlay cellules (active=false)
    applyLightningVisibility();          // masque l'overlay foudre (active=false)
    if (layersReady) hideGrid(false);   // réafficher la grille de score
    if (refreshTimer) { window.clearInterval(refreshTimer); refreshTimer = null; }
    prefetchGen++;
    if (prefetchKick) { window.clearTimeout(prefetchKick); prefetchKick = null; }
    if (chaseClickBound) { map.off('click', onChaseClick); chaseClickBound = false; }
    if (popup) { popup.remove(); }
    closeCellPopup();                     // ferme la fiche cellule + la mise en avant spots
    if (follow) toggleFollow();          // coupe le suivi géoloc
    if (userMarker) { userMarker.remove(); userMarker = null; }
  }

  toggleBtn.addEventListener('click', () => { active ? deactivate() : activate(); });
  playBtn?.addEventListener('click', play);
  liveBtn?.addEventListener('click', goLive);
  exportBtn?.addEventListener('click', exportAnimation);
  geoBtn?.addEventListener('click', toggleFollow);
  const cellsBtn = document.getElementById('chaseCellsBtn');
  cellsBtn?.addEventListener('click', () => {
    cellsVisible = !cellsVisible;
    cellsBtn.classList.toggle('active', cellsVisible);
    cellsBtn.setAttribute('aria-pressed', cellsVisible ? 'true' : 'false');
    applyCellsVisibility();
  });
  const lightningBtn = document.getElementById('chaseLightningBtn');
  lightningBtn?.addEventListener('click', () => {
    lightningVisible = !lightningVisible;
    lightningBtn.classList.toggle('active', lightningVisible);
    lightningBtn.setAttribute('aria-pressed', lightningVisible ? 'true' : 'false');
    applyLightningVisibility();
  });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && active) deactivate(); });
  // Remplacer vite l'image/les tuiles d'une source (scrub rapide / export) annule le
  // chargement en cours → AbortError, que MapLibre journalise directement via console.error
  // (vérifié) — bruit bénin. On filtre ce seul message. On avale aussi un éventuel rejet de
  // promesse AbortError, par sécurité.
  const _consoleError = console.error.bind(console);
  console.error = function (...args) {
    for (const a of args) { if (a && /abort/i.test([a.name, a.message, a].map(String).join(' '))) return; }
    return _consoleError(...args);
  };
  window.addEventListener('unhandledrejection', (e) => {
    const r = e && e.reason;
    if (r && /abort/i.test(String(r.name || r.message || r))) e.preventDefault();
  });

  // Poignée de repli RÉUTILISABLE (comme timelineToggleBtn de la frise de base) :
  // clic → bascule .collapsed sur le dock ; swipe vertical en tactile ; persistée.
  // Exposée en global → réutilisée par le mode chasse d'étoile.
  window.setupFriseCollapse = function (dock, btn, storageKey) {
    if (!dock || !btn) return;
    const icon = btn.querySelector('.timeline-toggle-icon');
    const isTouch = () => { try { return window.matchMedia('(hover: none), (pointer: coarse)').matches; } catch (_) { return false; } };
    function apply(collapsed) {
      dock.classList.toggle('collapsed', !!collapsed);
      if (icon) icon.textContent = collapsed ? '↑' : '↓';
      btn.setAttribute('aria-label', collapsed ? 'Afficher la frise' : 'Masquer la frise');
      btn.setAttribute('aria-expanded', collapsed ? 'false' : 'true');
      try { localStorage.setItem(storageKey, collapsed ? '1' : '0'); } catch (_) {}
    }
    const toggle = () => apply(!dock.classList.contains('collapsed'));
    try { apply(localStorage.getItem(storageKey) === '1'); } catch (_) {}
    let pid = null, startY = 0, dragging = false, triggered = false; const TH = 18;
    btn.addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); if (isTouch()) { if (!dragging && !triggered) toggle(); triggered = false; return; } toggle(); });
    btn.addEventListener('pointerdown', (e) => { if (!isTouch() || e.pointerType === 'mouse') return; pid = e.pointerId; startY = e.clientY; dragging = true; triggered = false; btn.classList.add('is-dragging'); try { btn.setPointerCapture(e.pointerId); } catch (_) {} e.preventDefault(); }, { passive: false });
    btn.addEventListener('pointermove', (e) => {
      if (!dragging || e.pointerId !== pid) return;
      const dy = e.clientY - startY, col = dock.classList.contains('collapsed');
      if (!col && dy > TH) { apply(true); triggered = true; dragging = false; }
      else if (col && dy < -TH) { apply(false); triggered = true; dragging = false; }
      if (triggered) { btn.classList.remove('is-dragging'); try { btn.releasePointerCapture(e.pointerId); } catch (_) {} e.preventDefault(); }
    }, { passive: false });
    const end = (e) => { if (pid !== null && e.pointerId !== undefined && e.pointerId !== pid) return; btn.classList.remove('is-dragging'); if (pid !== null) { try { btn.releasePointerCapture(pid); } catch (_) {} } pid = null; dragging = false; requestAnimationFrame(() => { triggered = false; }); };
    btn.addEventListener('pointerup', end);
    btn.addEventListener('pointercancel', end);
  };
  window.setupFriseCollapse(controls, document.getElementById('chaseToggleBtn'), 'storm_chase_collapsed');

  window.toggleChaseMode = () => { active ? deactivate() : activate(); };
  window.__chaseV = '1.3.103';   // marqueur : vérifier que CE chase.js est servi (piège cache SW)
})();
