// Mode « En chasse » — superposé À LA CARTE DE BASE (plus de fenêtre dédiée).
// Un bouton bascule la vue : la grille de score est masquée et on affiche le RADAR OBSERVÉ
// (Météo-France lame d'eau sur la France + RainViewer en repli, animé) et le NOWCAST
// AROME-PI (réflectivité simulée, grêle, rafales, CAPE, MOCON ; 0–6 h, pas 15 min) servi
// via le proxy serveur (clé Météo-France côté serveur). Barre de contrôle compacte (onglets
// + frise) et popup « conditions au point » au clic. Réutilise la carte `map` (state.js).
(function () {
  if (typeof maplibregl === 'undefined' || typeof map === 'undefined' || !map) return;
  const controls = document.getElementById('chaseControls');
  const toggleBtn = document.getElementById('chasePageBtn');
  if (!controls || !toggleBtn) return;

  const geoBtn = document.getElementById('chaseGeoBtn');
  const playBtn = document.getElementById('chasePlayBtn');
  const exportBtn = document.getElementById('chaseExportBtn');
  const slotStrip = document.getElementById('chaseSlots');
  const timeLabel = document.getElementById('chaseTimeLabel');
  const emptyHint = document.getElementById('chaseEmptyHint');
  const layerTabs = document.getElementById('chaseLayerRail');   // rail vertical (gauche)
  const activityEl = document.getElementById('chaseActivity');
  const nowEl = document.getElementById('chaseNow');             // horloge (badge haut-centre)
  const metaRunEl = document.getElementById('metaRun');          // ligne meta-stack (attribution)
  let activityTimer = null;
  let recording = false;
  let nowTimer = null;
  let savedMetaRun = null;

  // Radar observé : UNE source/couche raster PAR frame (préfixe + epoch), toutes créées
  // visibility:visible à raster-opacity:0 → MapLibre charge les tuiles des frames même
  // invisibles, et le scrub n'est plus qu'un flip d'opacité (instantané). L'ancien modèle
  // (une source unique + setTiles) vidait le cache de tuiles à CHAQUE changement de frame
  // → ~1,3 s de carte vide mesurée, même tuiles déjà vues.
  const RADAR_SRC_PREFIX = 'chase-radar-f';
  const NOWCAST_SRC = 'chase-nowcast';
  const MFRADAR_SRC = 'chase-mfradar';   // radar observé Météo-France (lame d'eau), France
  const RAINVIEWER_INDEX = 'https://api.rainviewer.com/public/weather-maps.json';
  // Domaine de la mosaïque radar MF (métropole), coins source `image` MapLibre.
  const MFRADAR_CORNERS = [[-10, 53.7], [17.6, 53.7], [17.6, 37.4], [-10, 37.4]];
  const MFRADAR_TOLERANCE_S = 600;       // apparier une frame observée à une mosaïque MF (≤10 min)
  // Coins du domaine AROME-PI (lat 37.5–55.4, lon -12–16), ordre image source : HG, HD, BD, BG.
  const AROMEPI_CORNERS = [[-12, 55.4], [16, 55.4], [16, 37.5], [-12, 37.5]];
  // PNG 256×256 transparent : placeholder décodable pour les sources image/raster.
  const TRANSPARENT_TILE = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAQAAAAEACAYAAABccqhmAAABFUlEQVR4nO3BMQEAAADCoPVP7WsIoAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAeAMBPAABPO1TCQAAAABJRU5ErkJggg==';
  const TRANSPARENT_PX = TRANSPARENT_TILE;

  let active = false;
  let layersReady = false;
  let chaseClickBound = false;
  let status = null;          // /api/aromepi/status
  let radarHost = '';
  let radarFrames = [];        // [{time, path}]
  let frames = [];             // timeline unifiée : [{kind:'radar'|'nowcast', epoch, t, ...}]
  let cursor = 0;
  let activeLayer = 'reflectivity';
  let playing = false;
  let playTimer = null;
  let radarVisible = true;
  let lastNowcastUrl = null;   // évite les updateImage redondants (→ AbortError)
  let nowcastSwapToken = 0;    // annule le « masquer le radar une fois le nowcast décodé »
  const radarLayerIds = new Set();   // couches radar par frame actuellement sur la carte
  const radarLayerPaths = new Map(); // id de couche → path RainViewer (détecte un path changé)
  let mfRadarTimes = [];       // échéances radar MF dispo (ISO), dernier 1/4h
  let lastMfRadarUrl = null;
  const prefetched = new Set(); // URLs déjà préchargées (cache navigateur/serveur chaud)
  let prefetchGen = 0;          // jeton pour annuler un préchargement en cours
  let prefetchRun = null;       // run AROME-PI préchargé (réinit du set si le run change)
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

  function radarTileUrl(path) {
    // color 4 = lisible sur fond sombre ; options 1_1 = lissé + neige.
    return `${radarHost}${path}/256/{z}/{x}/{y}/4/1_1.png`;
  }

  function nowcastImageUrl(layerKey, timeIso, runIso) {
    // Image plein-domaine reprojetée Mercator (source `image`) : la passerelle WMS MF
    // préserve le ratio géographique, des tuiles carrées décaleraient la donnée au zoom.
    const params = new URLSearchParams({ layer: layerKey, time: timeIso });
    if (runIso) params.set('run', runIso);
    return '/api/aromepi/image?' + params.toString();
  }

  function mfRadarImageUrl(iso) { return '/api/radar/mf/image?time=' + encodeURIComponent(iso); }

  // Mosaïque MF la plus proche d'une échéance observée (≤ tolérance), sinon null.
  function nearestMfRadar(epoch) {
    let best = null, bestD = Infinity;
    for (const iso of mfRadarTimes) {
      const e = Math.floor(new Date(iso).getTime() / 1000);
      const d = Math.abs(e - epoch);
      if (d < bestD) { bestD = d; best = iso; }
    }
    return (best && bestD <= MFRADAR_TOLERANCE_S) ? best : null;
  }

  // ── Préchargement (navigation fluide) ───────────────────────────────────────
  // Clé API limitée à 50 req/min → préchargement LENT (file séquentielle) et dédupliqué ;
  // le cache serveur (long) rend les revisites gratuites. Priorités : (1) radar MF, (2)
  // couche active sur toute la frise, (3) échéance courante des autres onglets.
  function buildPrefetchList() {
    const out = [];
    const run = status && status.run;
    for (const iso of mfRadarTimes) out.push(mfRadarImageUrl(iso));
    const nowcast = frames.filter((f) => f.kind === 'nowcast');
    if (run) for (const f of nowcast) out.push(nowcastImageUrl(activeLayer, f.t, run));
    const keys = layerTabs ? Array.from(layerTabs.querySelectorAll('[data-chase-layer]')).map((b) => b.dataset.chaseLayer) : [];
    const cur = frames[cursor];
    if (run && cur && cur.kind === 'nowcast') for (const k of keys) if (k !== activeLayer) out.push(nowcastImageUrl(k, cur.t, run));
    return out;
  }

  async function runPrefetch(gen) {
    const list = buildPrefetchList();
    for (const u of list) {
      if (gen !== prefetchGen || !active) return;
      if (!u || prefetched.has(u)) continue;
      prefetched.add(u);
      try { const r = await fetch(u, { cache: 'force-cache' }); await r.blob(); }
      catch (_) { prefetched.delete(u); }
      await new Promise((f) => setTimeout(f, 500));  // débit doux (clé limitée à 50 req/min)
    }
  }

  function schedulePrefetch() {
    if (!active) return;
    const gen = ++prefetchGen;                          // annule le préchargement en cours
    if (prefetchKick) clearTimeout(prefetchKick);
    prefetchKick = setTimeout(() => { if (gen === prefetchGen) runPrefetch(gen); }, 500);
  }

  // ── Couches chasse sur la carte de base ─────────────────────────────────────
  function ensureLayers() {
    if (layersReady) return true;
    if (!map.isStyleLoaded || !map.isStyleLoaded()) return false;
    if (map.getSource(NOWCAST_SRC)) { layersReady = true; return true; }
    // insérer SOUS le premier calque de libellés → noms de villes/régions lisibles au-dessus.
    const sym = ((map.getStyle() || {}).layers || []).find((l) => l.type === 'symbol');
    const before = sym ? sym.id : undefined;
    map.addSource(NOWCAST_SRC, { type: 'image', url: TRANSPARENT_PX, coordinates: AROMEPI_CORNERS });
    map.addLayer({ id: NOWCAST_SRC, type: 'raster', source: NOWCAST_SRC, paint: { 'raster-opacity': 0.82 }, layout: { visibility: 'none' } }, before);
    // Radar MF (lame d'eau) au-dessus de RainViewer : prioritaire sur la France.
    // (Les couches radar par frame sont insérées SOUS cette couche, cf. syncRadarLayers.)
    map.addSource(MFRADAR_SRC, { type: 'image', url: TRANSPARENT_PX, coordinates: MFRADAR_CORNERS });
    map.addLayer({ id: MFRADAR_SRC, type: 'raster', source: MFRADAR_SRC, paint: { 'raster-opacity': 0.85 }, layout: { visibility: 'none' } }, before);
    layersReady = true;
    return true;
  }

  function radarLayerId(fr) { return RADAR_SRC_PREFIX + fr.epoch; }

  // Aligne les couches radar par frame sur `frames` : crée les nouvelles (tuiles chargées
  // en avance grâce à visibility:visible + opacity 0), retire celles des frames disparues
  // (fenêtre glissante du refresh), met à jour un path qui aurait changé. Idempotent.
  function syncRadarLayers() {
    if (!layersReady || !radarHost) return;
    const want = new Map();
    for (const fr of frames) if (fr.kind === 'radar') want.set(radarLayerId(fr), fr.path);
    for (const id of Array.from(radarLayerIds)) {
      if (want.has(id)) continue;
      try { if (map.getLayer(id)) map.removeLayer(id); } catch (_) {}
      try { if (map.getSource(id)) map.removeSource(id); } catch (_) {}
      radarLayerIds.delete(id); radarLayerPaths.delete(id);
    }
    const before = map.getLayer(MFRADAR_SRC) ? MFRADAR_SRC : undefined;
    for (const [id, path] of want) {
      if (radarLayerIds.has(id)) {
        if (radarLayerPaths.get(id) !== path) { safeSetTiles(id, radarTileUrl(path)); radarLayerPaths.set(id, path); }
        setVis(id, true);   // ré-activation du mode chasse : les couches restent en place
        continue;
      }
      try {
        map.addSource(id, { type: 'raster', tiles: [radarTileUrl(path)], tileSize: 256 });
        map.addLayer({ id, type: 'raster', source: id, paint: { 'raster-opacity': 0, 'raster-opacity-transition': { duration: 150 } }, layout: { visibility: 'visible' } }, before);
        radarLayerIds.add(id); radarLayerPaths.set(id, path);
      } catch (_) {}
    }
  }

  function setRadarFrameOpacity(activeId) {
    for (const id of radarLayerIds) {
      try { map.setPaintProperty(id, 'raster-opacity', id === activeId ? 0.7 : 0); } catch (_) {}
    }
  }

  // Appelle cb une fois la source (re)chargée — sert à ne masquer l'ancienne couche
  // qu'une fois la nouvelle image du nowcast décodée (sinon : trou visuel pendant le
  // fetch+decode, ~640 ms mesurés même en cache). Poll rAF : isSourceLoaded passe à
  // false dès l'updateImage, redevient true au décodage. Garde-fou 2,5 s.
  function whenSourceLoaded(id, cb) {
    const t0 = performance.now();
    const tick = () => {
      let ok = false;
      try { ok = map.isSourceLoaded(id); } catch (_) {}
      if (ok || performance.now() - t0 > 2500) { cb(); return; }
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }

  function setVis(id, on) {
    if (map.getLayer(id)) map.setLayoutProperty(id, 'visibility', on ? 'visible' : 'none');
  }

  // Changer la source vite (scrub rapide / export) annule le chargement en cours : MapLibre
  // lève une AbortError SYNCHRONE (via l'AbortSignal). La nouvelle valeur est quand même
  // posée → on avale l'erreur. (Le rejet de promesse éventuel est géré par unhandledrejection.)
  function safeSetTiles(id, url) { try { const s = map.getSource(id); if (s) s.setTiles([url]); } catch (_) {} }
  function safeUpdateImage(id, url) { try { const s = map.getSource(id); if (s) s.updateImage({ url }); } catch (_) {} }

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
    let st = null;
    try { st = await (await fetch('/api/aromepi/status')).json(); } catch (_) {}
    let rv = null;
    try { rv = await (await fetch(RAINVIEWER_INDEX, { cache: 'no-store' })).json(); } catch (_) {}
    let mf = null;
    try { mf = await (await fetch('/api/radar/mf/status')).json(); } catch (_) {}
    if (token !== loadToken) return;
    status = (st && st.ok) ? st : status;
    radarHost = (rv && rv.host) || radarHost;
    mfRadarTimes = (mf && mf.ok && Array.isArray(mf.times)) ? mf.times : [];
    if (status && status.run !== prefetchRun) { prefetched.clear(); prefetchRun = status.run; }
    if (rv && rv.radar && Array.isArray(rv.radar.past)) {
      // PASSÉ observé uniquement (RainViewer past) : le futur vient d'AROME-PI, sinon les
      // deux se chevaucheraient (même heure à la fois « observé » et « prévu »).
      radarFrames = rv.radar.past.slice();
    }
    buildTimeline();
  }

  async function loadData() {
    const token = ++loadToken;
    if (emptyHint) { emptyHint.hidden = false; emptyHint.textContent = 'Chargement du radar et du nowcast…'; }
    await fetchSources(token);
    if (token !== loadToken) return;
    // attribution dans la meta-stack (ligne #metaRun, restaurée à la sortie)
    if (metaRunEl) metaRunEl.textContent = 'Radar : ' + (mfRadarTimes.length ? 'Météo-France + RainViewer' : 'RainViewer') + ' · Nowcast : ' + ((status && status.attribution) || 'Météo-France AROME-PI');
    if (!frames.length) {
      if (emptyHint) { emptyHint.hidden = false; emptyHint.textContent = 'Aucune donnée radar / nowcast disponible.'; }
      return;
    }
    if (emptyHint) emptyHint.hidden = true;
    atLiveEdge = true;
    cursor = liveIndex();
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
    renderFrise();
    applyCursor();
    schedulePrefetch();
  }

  function buildTimeline() {
    const nowSec = Date.now() / 1000;
    const out = [];
    for (const fr of radarFrames) {
      if (fr && typeof fr.time === 'number' && fr.path) out.push({ kind: 'radar', epoch: fr.time, path: fr.path });
    }
    if (status && Array.isArray(status.forecast_times)) {
      for (const t of status.forecast_times) {
        const epoch = Math.floor(new Date(t).getTime() / 1000);
        // ne garder que les échéances RÉELLEMENT à venir (le run peut avoir ~1 h).
        if (Number.isFinite(epoch) && epoch > nowSec) out.push({ kind: 'nowcast', epoch, t });
      }
    }
    out.sort((a, b) => a.epoch - b.epoch);
    frames = out;
  }

  function applyCursor() {
    if (!active || !layersReady || !frames.length) return;
    const fr = frames[cursor];
    if (!fr) return;
    const isFuture = fr.kind === 'nowcast';
    if (timeLabel) {
      const d = new Date(fr.epoch * 1000);
      const date = String(d.getDate()).padStart(2, '0') + '/' + String(d.getMonth() + 1).padStart(2, '0');
      timeLabel.textContent = date + ' ' + fmtClock(fr.epoch) + (isFuture ? ' · prévu' : ' · observé');
      timeLabel.classList.toggle('is-future', isFuture);
    }
    updateActive();
    syncRadarLayers();
    if (fr.kind === 'radar') {
      nowcastSwapToken++;   // annule un « masquer le radar au décodage » en attente
      setRadarFrameOpacity(radarVisible ? radarLayerId(fr) : null);
      // Radar MF (lame d'eau) sur la France, par-dessus RainViewer, si une mosaïque MF
      // correspond à cette échéance (dernier 1/4h seulement).
      const mfIso = radarVisible ? nearestMfRadar(fr.epoch) : null;
      if (mfIso) {
        const mu = mfRadarImageUrl(mfIso);
        if (mu !== lastMfRadarUrl) { safeUpdateImage(MFRADAR_SRC, mu); lastMfRadarUrl = mu; }
        setVis(MFRADAR_SRC, true);
      } else {
        setVis(MFRADAR_SRC, false);
      }
      setVis(NOWCAST_SRC, false);
      // sur l'observé, le badge horaire dit déjà « observé » → on n'ajoute que la source MF.
      if (activityEl) { activityEl.textContent = mfIso ? 'MF' : ''; activityEl.className = mfIso ? 'chase-activity lvl-low' : 'chase-activity'; }
      schedulePointForCurrent();
    } else {
      if (status && status.run) {
        const u = nowcastImageUrl(activeLayer, fr.t, status.run);
        if (u !== lastNowcastUrl) { safeUpdateImage(NOWCAST_SRC, u); lastNowcastUrl = u; }
        setVis(NOWCAST_SRC, true);
        // Ne masquer le radar (et la mosaïque MF) qu'une fois la nouvelle image DÉCODÉE :
        // pendant le fetch+decode, l'ancienne couche reste affichée → plus de trou visuel
        // à la jonction observé→prévu. Jeton : un scrub qui repart sur du radar entre-temps
        // annule le masquage différé.
        const tok = ++nowcastSwapToken;
        whenSourceLoaded(NOWCAST_SRC, () => {
          if (tok !== nowcastSwapToken || !active) return;
          const cur = frames[cursor];
          if (!cur || cur.kind !== 'nowcast') return;
          setRadarFrameOpacity(null);
          setVis(MFRADAR_SRC, false);
        });
      } else {
        setRadarFrameOpacity(null);
        setVis(MFRADAR_SRC, false);
      }
      schedulePointForCurrent();
      updateActivity(fr);
    }
  }

  // Indicateur d'activité : part du domaine portant de la donnée → « rien / faible / … ».
  const ACTIVITY_LABELS = { none: 'rien à signaler', low: 'activité faible', moderate: 'activité modérée', high: 'activité forte' };
  function updateActivity(fr) {
    if (!activityEl || !status || !status.run) return;
    if (activityTimer) window.clearTimeout(activityTimer);
    activityEl.textContent = '…'; activityEl.className = 'chase-activity';
    const key = activeLayer, t = fr.t, run = status.run;
    activityTimer = window.setTimeout(async () => {
      try {
        const p = new URLSearchParams({ layer: key, time: t, run });
        const d = await (await fetch('/api/aromepi/activity?' + p.toString())).json();
        if (frames[cursor] !== fr || activeLayer !== key) return; // l'utilisateur a bougé
        if (d && d.ok) { activityEl.textContent = ACTIVITY_LABELS[d.level] || ''; activityEl.className = 'chase-activity lvl-' + d.level; }
        else { activityEl.textContent = ''; activityEl.className = 'chase-activity'; }
      } catch (_) { activityEl.textContent = ''; }
    }, 350);
  }

  function liveIndex() {
    let last = -1;
    for (let i = 0; i < frames.length; i += 1) if (frames[i].kind === 'radar') last = i;
    if (last < 0) last = frames.findIndex((f) => f.kind === 'nowcast');
    return last < 0 ? 0 : last;
  }

  function setCursor(i) {
    cursor = Math.min(frames.length - 1, Math.max(0, i));
    atLiveEdge = cursor >= liveIndex();
    applyCursor();
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
    rail.setAttribute('aria-label', 'Échéance radar / nowcast');
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
      mark.className = 'timeline-hour-mark' + (fr.kind === 'nowcast' ? ' is-fcst' : '') + (i === cursor ? ' active' : '');
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
    scroller.setAttribute('aria-label', 'Échéance radar / nowcast');
    let prevHour = null;
    frames.forEach((fr, i) => {
      const d = new Date(fr.epoch * 1000);
      const time = fmtClock(fr.epoch);
      const sparse = (d.getHours() !== prevHour) ? String(d.getHours()).padStart(2, '0') : '';
      prevHour = d.getHours();
      const item = document.createElement('button');
      item.type = 'button';
      item.className = 'timeline-wheel-item' + (fr.kind === 'nowcast' ? ' is-fcst' : '') + (i === cursor ? ' active' : '');
      item.dataset.idx = String(i);
      item.dataset.time = time;
      item.dataset.sparse = sparse;
      item.setAttribute('role', 'option');
      item.setAttribute('aria-selected', i === cursor ? 'true' : 'false');
      item.setAttribute('aria-label', time + (fr.kind === 'nowcast' ? ' (prévu)' : ' (observé)'));
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
    if (playBtn) { playBtn.classList.add('active'); playBtn.setAttribute('aria-pressed', 'true'); }
    playTimer = window.setInterval(() => {
      let next = cursor + 1;
      if (next >= frames.length) next = 0;
      setCursor(next);
      syncWheelToCursor(true);   // la molette (mobile) suit la lecture
    }, 700);
  }
  function stop() {
    playing = false;
    if (playBtn) { playBtn.classList.remove('active'); playBtn.setAttribute('aria-pressed', 'false'); }
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
      a.href = url; a.download = `chasse_${activeLayer}_${stamp}.webm`;
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 8000);
    }
  }

  // ── Conditions à un point (popup) ───────────────────────────────────────────
  function currentNowcastTime() {
    const fr = frames[cursor];
    if (fr && fr.kind === 'nowcast') return fr.t;
    const f = frames.find((x) => x.kind === 'nowcast');
    return f ? f.t : null;
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

  async function queryPoint(lat, lon, fromTap) {
    const t = currentNowcastTime();
    if (!t) return;
    if (fromTap) { userPos = userPos || { lat, lon }; }
    showPopup(lat, lon, '<div class="chase-pop-loading">Lecture AROME-PI…</div>');
    const token = ++loadToken;
    let data = null;
    try {
      const resp = await fetch('/api/aromepi/point', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ lat, lon, time: t, run: status && status.run, layers: ['reflectivity', 'cape', 'gusts', 'hail', 'graupel'] }),
      });
      data = await resp.json();
    } catch (_) {}
    if (token !== loadToken) return;
    if (!popup || !popup.isOpen()) return;        // popup fermé entre-temps
    if (!data || !data.ok) { showPopup(lat, lon, '<div class="chase-pop-empty">Conditions indisponibles ici.</div>'); return; }
    showPopup(lat, lon, renderPositionHTML(data.values || {}, t));
  }

  function renderPositionHTML(v, t) {
    const dbz = v.reflectivity, cape = v.cape, gust = v.gusts, hail = v.hail, graupel = v.graupel;
    const echo = (typeof dbz === 'number') ? Math.max(0, dbz) : null;
    let verdict, cls;
    if (echo !== null && echo >= 45) { verdict = '⛈ Cellule active'; cls = 'sev-high'; }
    else if (echo !== null && echo >= 20) { verdict = '🌧 Précipitations'; cls = 'sev-mid'; }
    else if (typeof cape === 'number' && cape >= 800) { verdict = '⚡ Air instable'; cls = 'sev-watch'; }
    else { verdict = '🌤 Calme'; cls = 'sev-low'; }
    const hailTxt = (typeof hail === 'number' && hail > 0.5) ? ' · grêle probable' : '';
    const rows = [
      ['Réflectivité', echo !== null ? Math.round(echo) : '—', ' dBZ'],
      ['CAPE', typeof cape === 'number' ? Math.round(cape) : '—', ' J/kg'],
      ['Rafales 15 min', typeof gust === 'number' ? Math.round(gust) : '—', ' km/h'],
      ['Grêle (diag)', typeof hail === 'number' ? (hail > 0.5 ? 'oui' : 'non') : '—', ''],
      ['Graupel', typeof graupel === 'number' ? graupel.toFixed(2) : '—', ''],
    ];
    return `<div class="chase-verdict ${cls}">${verdict}${hailTxt}<span class="chase-verdict-time">${fmtClock(Math.floor(new Date(t).getTime() / 1000))}</span></div>` +
      '<ul class="chase-pos-list">' + rows.map((r) => `<li><span>${r[0]}</span><strong>${r[1]}${(r[2] && r[1] !== '—') ? `<span class="chase-unit">${r[2]}</span>` : ''}</strong></li>`).join('') + '</ul>';
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

  function setLayer(key) {
    activeLayer = key;
    if (layerTabs) layerTabs.querySelectorAll('.chase-layer-btn').forEach((b) => {
      const on = b.dataset.chaseLayer === key;
      b.classList.toggle('active', on);
      b.setAttribute('aria-selected', on ? 'true' : 'false');
    });
    // La légende de réflectivité (palette en-app) n'est valable que pour cette
    // couche ; les autres (CAPE, rafales…) utilisent des palettes WMS Météo-France.
    const legendEl = document.getElementById('chaseLegend');
    if (legendEl) legendEl.classList.toggle('is-hidden', key !== 'reflectivity');
    applyCursor();
    schedulePrefetch();  // précharge la frise de la nouvelle couche active
  }

  function onChaseClick(e) {
    queryPoint(e.lngLat.lat, e.lngLat.lng, true);
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
    active = true;
    toggleBtn.classList.add('active');
    toggleBtn.setAttribute('aria-pressed', 'true');
    controls.setAttribute('aria-hidden', 'false');
    document.body.classList.add('chase-mode');
    setChaseMapTint(true);
    // on garde la meta-stack visible : sa ligne #metaRun reçoit l'attribution (sauvegarde
    // pour restauration à la sortie). Badge haut-centre : horloge live.
    savedMetaRun = metaRunEl ? metaRunEl.textContent : null;
    updateNow();
    if (nowTimer) window.clearInterval(nowTimer);
    nowTimer = window.setInterval(updateNow, 1000);
    if (ensureLayers()) {
      hideGrid(true);
    } else {
      // style pas encore prêt : on (ré)essaie une fois chargé.
      map.once('idle', () => { if (active && ensureLayers()) { hideGrid(true); applyCursor(); } });
    }
    if (!chaseClickBound) { map.on('click', onChaseClick); chaseClickBound = true; }
    if (refreshTimer) window.clearInterval(refreshTimer);
    refreshTimer = window.setInterval(refreshData, 120000);
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
    for (const id of [NOWCAST_SRC, MFRADAR_SRC]) setVis(id, false);
    // masquer AUSSI les couches radar par frame (sinon elles continueraient à charger
    // des tuiles à chaque déplacement de carte hors mode chasse).
    for (const id of radarLayerIds) setVis(id, false);
    nowcastSwapToken++;
    if (layersReady) hideGrid(false);   // réafficher la grille de score
    if (refreshTimer) { window.clearInterval(refreshTimer); refreshTimer = null; }
    prefetchGen++;
    if (prefetchKick) { window.clearTimeout(prefetchKick); prefetchKick = null; }
    if (chaseClickBound) { map.off('click', onChaseClick); chaseClickBound = false; }
    if (popup) { popup.remove(); }
    if (follow) toggleFollow();          // coupe le suivi géoloc
    if (userMarker) { userMarker.remove(); userMarker = null; }
  }

  toggleBtn.addEventListener('click', () => { active ? deactivate() : activate(); });
  playBtn?.addEventListener('click', play);
  exportBtn?.addEventListener('click', exportAnimation);
  geoBtn?.addEventListener('click', toggleFollow);
  layerTabs?.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-chase-layer]');
    if (btn) setLayer(btn.dataset.chaseLayer);
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

  window.toggleChaseMode = () => { active ? deactivate() : activate(); };
  window.__chaseV = '263';   // marqueur : vérifier que CE chase.js est servi (piège cache SW)
})();
