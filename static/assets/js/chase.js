// Mode « En chasse » — superposé À LA CARTE DE BASE (plus de fenêtre dédiée).
// Un bouton bascule la vue : la grille de score est masquée et on affiche le RADAR OBSERVÉ
// (mosaïque réflectivité Météo-France 1 km, ~2 h de passé, une image par échéance) et le
// NOWCAST AROME-PI (réflectivité simulée, grêle, rafales, CAPE, MOCON ; 0–6 h, pas 15 min)
// servi via le proxy serveur (clé Météo-France côté serveur). Barre de contrôle (frise +
// bouton direct) et popup « conditions au point » au clic. Réutilise la carte `map` (state.js).
(function () {
  if (typeof maplibregl === 'undefined' || typeof map === 'undefined' || !map) return;
  const controls = document.getElementById('chaseControls');
  const toggleBtn = document.getElementById('chasePageBtn');
  if (!controls || !toggleBtn) return;

  const geoBtn = document.getElementById('chaseGeoBtn');
  const playBtn = document.getElementById('chasePlayBtn');
  const liveBtn = document.getElementById('chaseLiveBtn');
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

  // Radar observé = mosaïque réflectivité Météo-France 1 km (décodée/reprojetée serveur,
  // ring buffer ~2 h). UNE source/couche `image` PAR frame (préfixe + epoch) : chaque
  // échéance a son PNG dédié. Les frames dans une FENÊTRE autour du curseur sont visibles
  // à raster-opacity:0 → MapLibre décode leur texture en avance, et le scrub proche n'est
  // qu'un flip d'opacité (instantané, sans trou). Les PNG viennent de NOTRE serveur
  // (/api/radar/fr/image, ~150 Ko, cache long) → pas de rate limit, chargement immédiat.
  // (RainViewer supprimé : plafonné z7 + données composite ~2 km ; la mosaïque MF 1 km
  // couvre désormais TOUTE l'amplitude passée de la frise.)
  const RADAR_SRC_PREFIX = 'chase-radar-f';
  const RADAR_EAGER_NEIGHBORS = 3;   // frames radar préchargées de part et d'autre du curseur
  // AROME-PI (nowcast) : MÊME modèle par-frame que le radar (source image par échéance,
  // texture pré-décodée → scrub instantané), mais MATÉRIALISÉ dans une fenêtre bornée
  // autour du curseur : une image AROME-PI ≈ 22 Mo décodée, ×22 frames = trop (surtout
  // mobile). On ne garde que ±NOWCAST_RADIUS frames matérialisées (créées à l'approche,
  // détruites en s'éloignant). L'id inclut la couche active → changer d'onglet reconstruit.
  const NOWCAST_PREFIX = 'chase-nc-';
  const NOWCAST_RADIUS = 3;          // frames nowcast matérialisées de part et d'autre du curseur
  const FRRADAR_CORNERS = [[-9.965, 53.67], [14.4, 53.67], [14.4, 39.4], [-9.965, 39.4]];
  // Coins du domaine AROME-PI (lat 37.5–55.4, lon -12–16), ordre image source : HG, HD, BD, BG.
  const AROMEPI_CORNERS = [[-12, 55.4], [16, 55.4], [16, 37.5], [-12, 37.5]];

  let active = false;
  let layersReady = false;
  let chaseClickBound = false;
  let status = null;          // /api/aromepi/status
  let frames = [];             // timeline unifiée : [{kind:'radar'|'nowcast', epoch, iso/t}]
  let cursor = 0;
  let activeLayer = 'reflectivity';
  let playing = false;
  let playTimer = null;
  let radarVisible = true;
  let swapToken = 0;           // invalide les bascules différées (masquage après décodage/chargement)
  const radarLayerIds = new Set();   // couches radar (mosaïque MF) par frame sur la carte
  const nowcastLayerIds = new Set(); // couches nowcast (AROME-PI) matérialisées (fenêtre)
  let symbolAnchorId = null;   // 1er calque symbol du style : les couches chasse s'insèrent dessous
  let frRadarTimes = [];       // échéances mosaïque France dispo (ISO, ~2 h)
  let frBlend = { times: [], speed_kmh: 0, advected: false };  // nowcast par advection radar (0-30 min)
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

  function nowcastImageUrl(layerKey, timeIso, runIso) {
    // Image plein-domaine reprojetée Mercator (source `image`) : la passerelle WMS MF
    // préserve le ratio géographique, des tuiles carrées décaleraient la donnée au zoom.
    const params = new URLSearchParams({ layer: layerKey, time: timeIso });
    if (runIso) params.set('run', runIso);
    return '/api/aromepi/image?' + params.toString();
  }

  function frRadarImageUrl(iso) { return '/api/radar/fr/image?time=' + encodeURIComponent(iso); }
  function frBlendImageUrl(iso) { return '/api/radar/fr/blend/image?time=' + encodeURIComponent(iso); }
  // « observé/extrapolé » = radar réel OU frame advectée (blend) : mêmes domaine, palette et
  // rendu (par frame), mutuellement exclusifs avec le nowcast AROME-PI à l'affichage.
  function isRadarLike(fr) { return fr && (fr.kind === 'radar' || fr.kind === 'blend'); }

  // ── Préchargement (navigation fluide) ───────────────────────────────────────
  // Clé API limitée à 50 req/min → préchargement LENT (file séquentielle) et dédupliqué ;
  // le cache serveur (long) rend les revisites gratuites. Priorités : (1) couche active
  // sur toute la frise, (2) échéance courante des autres onglets. (Les tuiles radar sont
  // préchargées par MapLibre lui-même : couches par frame visibles à opacité 0.)
  function buildPrefetchList() {
    const out = [];
    const run = status && status.run;
    for (const iso of frRadarTimes) out.push(frRadarImageUrl(iso));   // mosaïques France (serveur local, léger)
    for (const iso of (frBlend.times || [])) out.push(frBlendImageUrl(iso));   // frames advectées (blend)
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
  // Radar (mosaïque MF) ET nowcast (AROME-PI) sont désormais des couches `image` PAR
  // frame, créées à la demande (cf. syncRadarLayers / syncNowcastLayers). ensureLayers
  // ne fait que repérer l'ancre d'insertion (sous les libellés) une fois le style prêt.
  function ensureLayers() {
    if (layersReady) return true;
    if (!map.isStyleLoaded || !map.isStyleLoaded()) return false;
    const sym = ((map.getStyle() || {}).layers || []).find((l) => l.type === 'symbol');
    symbolAnchorId = sym ? sym.id : null;
    layersReady = true;
    return true;
  }

  function radarLayerId(fr) { return RADAR_SRC_PREFIX + fr.epoch; }
  function nowcastLayerId(fr) { return NOWCAST_PREFIX + activeLayer + '-' + fr.epoch; }

  // Aligne les couches radar (mosaïque MF, une source `image` par frame) sur `frames` :
  // crée les nouvelles (masquées ; c'est updateRadarWindow qui rend éagère la fenêtre
  // autour du curseur), retire celles des frames disparues (fenêtre glissante du ring
  // buffer serveur). L'URL d'une frame est fixe (epoch → mosaïque figée). Idempotent.
  function syncRadarLayers() {
    if (!layersReady) return;
    const want = new Map();   // id → URL (radar réel OU frame advectée du blend)
    for (const fr of frames) if (isRadarLike(fr)) want.set(radarLayerId(fr), fr.kind === 'blend' ? frBlendImageUrl(fr.iso) : frRadarImageUrl(fr.iso));
    for (const id of Array.from(radarLayerIds)) {
      if (want.has(id)) continue;
      try { if (map.getLayer(id)) map.removeLayer(id); } catch (_) {}
      try { if (map.getSource(id)) map.removeSource(id); } catch (_) {}
      radarLayerIds.delete(id);
    }
    const before = (symbolAnchorId && map.getLayer(symbolAnchorId)) ? symbolAnchorId : undefined;
    for (const [id, url] of want) {
      if (radarLayerIds.has(id)) continue;
      try {
        map.addSource(id, { type: 'image', url, coordinates: FRRADAR_CORNERS });
        // raster-resampling NEAREST : arêtes nettes des cellules.
        map.addLayer({ id, type: 'raster', source: id, paint: { 'raster-opacity': 0, 'raster-opacity-transition': { duration: 150 }, 'raster-resampling': 'nearest' }, layout: { visibility: 'none' } }, before);
        radarLayerIds.add(id);
      } catch (_) {}
    }
  }

  // Fenêtre de préchargement : la frame radar la plus proche du curseur ± N voisines
  // sont visibles (opacity 0 → texture décodée en avance, scrub proche instantané),
  // les autres masquées (borne le nombre de textures GPU actives).
  function updateRadarWindow() {
    if (!radarLayerIds.size) return;
    const radarIdx = [];
    frames.forEach((f, i) => { if (isRadarLike(f)) radarIdx.push(i); });
    if (!radarIdx.length) return;
    let pos = 0, bd = Infinity;
    radarIdx.forEach((fi, p) => { const d = Math.abs(fi - cursor); if (d < bd) { bd = d; pos = p; } });
    const keep = new Set();
    for (let p = Math.max(0, pos - RADAR_EAGER_NEIGHBORS); p <= Math.min(radarIdx.length - 1, pos + RADAR_EAGER_NEIGHBORS); p += 1) {
      keep.add(radarLayerId(frames[radarIdx[p]]));
    }
    for (const id of radarLayerIds) {
      // ne JAMAIS expulser la frame actuellement affichée (saut lointain : elle doit
      // rester visible jusqu'à ce que la cible soit chargée — l'éviction se fait à la
      // bascule, cf. reveal() dans applyCursor).
      let displayed = false;
      try { displayed = (map.getPaintProperty(id, 'raster-opacity') || 0) > 0.05; } catch (_) {}
      setVis(id, keep.has(id) || displayed);
    }
  }

  function setRadarFrameOpacity(activeId) {
    for (const id of radarLayerIds) {
      try { map.setPaintProperty(id, 'raster-opacity', id === activeId ? 0.7 : 0); } catch (_) {}
    }
  }

  // ── Nowcast AROME-PI : couches image par frame, fenêtre matérialisée bornée ──
  // Crée les frames nowcast DANS ±NOWCAST_RADIUS du curseur (couche active), visibles à
  // opacité 0 (texture décodée en avance → scrub instantané) ; retire celles hors fenêtre,
  // d'une autre couche ou d'un autre run — SAUF la frame actuellement affichée (gardée
  // jusqu'à la bascule pour ne pas laisser de trou). Idempotent.
  function syncNowcastLayers() {
    if (!layersReady) return;
    const run = status && status.run;
    // Fenêtre en INDEX GLOBAL (rien de matérialisé loin dans le radar ; près de la jonction,
    // les 1res frames nowcast sont prêtes). HYSTÉRÉSIS : on MATÉRIALISE ±NOWCAST_RADIUS mais
    // on ne RETIRE qu'au-delà de ±(NOWCAST_RADIUS+2) → moins de va-et-vient création/destruction
    // sur les petits mouvements.
    const want = new Map();   // à matérialiser (fenêtre serrée)
    const keep = new Set();   // à garder si déjà présent (fenêtre large)
    if (run) {
      for (let i = Math.max(0, cursor - NOWCAST_RADIUS - 2); i <= Math.min(frames.length - 1, cursor + NOWCAST_RADIUS + 2); i += 1) {
        const fr = frames[i];
        if (fr.kind !== 'nowcast') continue;
        const id = nowcastLayerId(fr);
        keep.add(id);
        if (Math.abs(i - cursor) <= NOWCAST_RADIUS) want.set(id, fr);
      }
    }
    for (const id of Array.from(nowcastLayerIds)) {
      if (keep.has(id)) continue;
      let displayed = false, loaded = true;
      try { displayed = (map.getPaintProperty(id, 'raster-opacity') || 0) > 0.05; } catch (_) {}
      try { loaded = !map.getSource(id) || map.isSourceLoaded(id); } catch (_) { loaded = true; }
      // ⚠ ne JAMAIS retirer une frame affichée (gardée jusqu'à la bascule) NI une source
      // encore en chargement (removeSource interromprait le fetch → « no source » à la fin).
      if (displayed || !loaded) continue;
      try { if (map.getLayer(id)) map.removeLayer(id); } catch (_) {}
      try { if (map.getSource(id)) map.removeSource(id); } catch (_) {}
      nowcastLayerIds.delete(id);
    }
    const before = (symbolAnchorId && map.getLayer(symbolAnchorId)) ? symbolAnchorId : undefined;
    for (const [id, fr] of want) {
      if (nowcastLayerIds.has(id)) { setVis(id, true); continue; }
      try {
        map.addSource(id, { type: 'image', url: nowcastImageUrl(activeLayer, fr.t, run), coordinates: AROMEPI_CORNERS });
        // raster-resampling NEAREST : arêtes nettes (cf. radar).
        map.addLayer({ id, type: 'raster', source: id, paint: { 'raster-opacity': 0, 'raster-opacity-transition': { duration: 150 }, 'raster-resampling': 'nearest' }, layout: { visibility: 'visible' } }, before);
        nowcastLayerIds.add(id);
      } catch (_) {}
    }
  }

  function setNowcastFrameOpacity(activeId) {
    for (const id of nowcastLayerIds) {
      try { map.setPaintProperty(id, 'raster-opacity', id === activeId ? 0.82 : 0); } catch (_) {}
    }
  }

  // Appelle cb une fois la source (re)chargée — sert à ne masquer l'ancienne couche
  // qu'une fois la nouvelle donnée décodée (sinon : trou visuel pendant le fetch+decode,
  // ~640 ms mesurés même en cache). Poll rAF : isSourceLoaded passe à false dès
  // l'updateImage, redevient true au décodage. Garde-fou 2,5 s. skipFrames : pour une
  // couche raster qui VIENT d'être rendue visible, isSourceLoaded répond true tant que
  // MapLibre n'a pas calculé les tuiles requises (aucune tuile demandée = « chargé ») —
  // sauter ~2 frames de rendu laisse l'état de chargement se poser (863 ms de trou
  // mesurés sans ça, au saut lointain).
  function whenSourceLoaded(id, cb, stableFrames) {
    const t0 = performance.now();
    const need = Math.max(1, stableFrames || 1);
    let okStreak = 0;
    const tick = () => {
      // Source retirée entre-temps (fenêtre nowcast glissante) → abandon SILENCIEUX.
      // ⚠ getSource ne lève PAS d'erreur pour un id absent (contrairement à isSourceLoaded,
      // qui émet en plus un event d'erreur loggé) → on teste l'existence AVANT.
      if (!map.getSource(id)) return;
      let ok = false;
      try { ok = map.isSourceLoaded(id); } catch (_) {}
      okStreak = ok ? okStreak + 1 : 0;   // un faux « chargé » précoce retombe à false → reset
      if (okStreak >= need || performance.now() - t0 > 2500) { cb(); return; }
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }

  // Frame « prête » = couche présente, visible, source chargée — SANS lever d'erreur
  // MapLibre (getLayer/getSource testés avant getLayoutProperty/isSourceLoaded).
  function frameReady(id) {
    try {
      return !!map.getLayer(id)
        && map.getLayoutProperty(id, 'visibility') === 'visible'
        && !!map.getSource(id) && map.isSourceLoaded(id);
    } catch (_) { return false; }
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
    let st = null;
    try { st = await (await fetch('/api/aromepi/status')).json(); } catch (_) {}
    let fr = null;
    try { fr = await (await fetch('/api/radar/fr/status')).json(); } catch (_) {}
    let bl = null;
    try { bl = await (await fetch('/api/radar/fr/blend/status')).json(); } catch (_) {}
    if (token !== loadToken) return;
    status = (st && st.ok) ? st : status;
    frRadarTimes = (fr && fr.ok && Array.isArray(fr.times)) ? fr.times : [];
    frBlend = (bl && bl.ok) ? bl : { times: [], speed_kmh: 0, advected: false };
    if (status && status.run !== prefetchRun) { prefetched.clear(); prefetchRun = status.run; }
    buildTimeline();
  }

  async function loadData() {
    const token = ++loadToken;
    if (emptyHint) { emptyHint.hidden = false; emptyHint.textContent = 'Chargement du radar et du nowcast…'; }
    await fetchSources(token);
    if (token !== loadToken) return;
    // attribution dans la meta-stack (ligne #metaRun, restaurée à la sortie)
    if (metaRunEl) metaRunEl.textContent = 'Radar : Météo-France 1 km · Nowcast : ' + ((status && status.attribution) || 'Météo-France AROME-PI');
    if (!frames.length) {
      if (emptyHint) { emptyHint.hidden = false; emptyHint.textContent = 'Aucune donnée radar / nowcast disponible.'; }
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
    // 0-30 min à venir, ancrées sur l'observation. Priment sur AROME-PI dans leur plage.
    // Si le mouvement n'est PAS fiable (persistance), les frames FUTURES seraient identiques
    // à la dernière mosaïque → on ne garde que le comblement du trou jusqu'à ~maintenant
    // (AROME-PI, qui a de la physique, couvre le proche futur).
    let lastBlendEpoch = 0;
    const blendTimes = (frBlend && Array.isArray(frBlend.times)) ? frBlend.times : [];
    const blendAdvected = !!(frBlend && frBlend.advected);
    for (const iso of blendTimes) {
      const epoch = Math.floor(new Date(iso).getTime() / 1000);
      if (!Number.isFinite(epoch)) continue;
      if (!blendAdvected && epoch > nowSec + 60) continue;   // persistance : pas de futur identique
      out.push({ kind: 'blend', epoch, iso }); lastBlendEpoch = Math.max(lastBlendEpoch, epoch);
    }
    if (status && Array.isArray(status.forecast_times)) {
      for (const t of status.forecast_times) {
        const epoch = Math.floor(new Date(t).getTime() / 1000);
        // à venir ET au-delà de la plage du blend (le blend prime sur le proche futur).
        if (Number.isFinite(epoch) && epoch > nowSec && epoch > lastBlendEpoch) out.push({ kind: 'nowcast', epoch, t });
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
    const isBlend = fr.kind === 'blend';
    if (timeLabel) {
      const d = new Date(fr.epoch * 1000);
      const date = String(d.getDate()).padStart(2, '0') + '/' + String(d.getMonth() + 1).padStart(2, '0');
      const suffix = isBlend ? ' · extrapolé' : (isFuture ? ' · prévu' : ' · observé');
      timeLabel.textContent = date + ' ' + fmtClock(fr.epoch) + suffix;
      timeLabel.classList.toggle('is-future', isFuture || isBlend);
    }
    updateActive();
    syncRadarLayers();
    syncNowcastLayers();
    if (isRadarLike(fr)) {
      const tok = ++swapToken;   // invalide toute bascule différée précédente
      const targetId = radarLayerId(fr);
      // « prête » = déjà éagère (visible AVANT le déplacement de la fenêtre) ET chargée.
      // ⚠️ isSourceLoaded seul ment pour une couche encore masquée → on capture la
      // visibilité avant updateRadarWindow.
      const ready = frameReady(targetId);
      updateRadarWindow();
      if (!radarVisible) {
        setRadarFrameOpacity(null);
        setNowcastFrameOpacity(null);
        if (activityEl) { activityEl.textContent = ''; activityEl.className = 'chase-activity'; }
      } else {
        const reveal = () => {
          if (tok !== swapToken || !active) return;
          const cur = frames[cursor];
          if (!isRadarLike(cur) || radarLayerId(cur) !== targetId) return;
          setRadarFrameOpacity(targetId);
          setNowcastFrameOpacity(null);   // masque le nowcast une fois le radar prêt
          updateRadarWindow();            // évince l'ancienne frame radar hors fenêtre
          syncNowcastLayers();            // libère les couches nowcast désormais masquées
        };
        // badge : « MF 1 km » (observé) / « extrapolé · N km/h » (advection réelle) /
        // « obs. maintenue » (persistance, mouvement non fiable → comblement du trou).
        if (activityEl) {
          if (isBlend) { activityEl.textContent = frBlend.advected ? ('extrapolé · ' + frBlend.speed_kmh + ' km/h') : 'obs. maintenue'; activityEl.className = 'chase-activity lvl-low'; }
          else { activityEl.textContent = 'MF 1 km'; activityEl.className = 'chase-activity lvl-low'; }
        }
        if (ready) {
          reveal();   // texture déjà décodée (fenêtre éagère) → flip immédiat
        } else {
          // frame hors fenêtre (saut lointain) : l'ancienne couche reste affichée le
          // temps que la texture de la cible se décode, puis on bascule. Pas de trou.
          whenSourceLoaded(targetId, reveal, 5);
        }
      }
      schedulePointForCurrent();
    } else {
      // NOWCAST (AROME-PI) : MÊME mécanique par-frame que le radar → scrub instantané
      // (texture pré-décodée dans la fenêtre) au lieu de l'updateImage ~434 ms d'avant.
      const tok = ++swapToken;
      const targetId = nowcastLayerId(fr);
      const ready = frameReady(targetId);
      updateRadarWindow();   // garde la fenêtre radar éagère près de la jonction
      if (status && status.run) {
        const reveal = () => {
          if (tok !== swapToken || !active) return;
          const cur = frames[cursor];
          if (!cur || cur.kind !== 'nowcast' || nowcastLayerId(cur) !== targetId) return;
          setNowcastFrameOpacity(targetId);
          setRadarFrameOpacity(null);
          syncNowcastLayers();   // évince les frames hors fenêtre / d'une autre couche
        };
        if (ready) {
          reveal();
        } else {
          // saut lointain / changement de couche : l'ancienne image reste affichée le
          // temps que la cible se décode (syncNowcastLayers l'a créée), puis bascule.
          whenSourceLoaded(targetId, reveal, 5);
        }
      } else {
        setRadarFrameOpacity(null);
        setNowcastFrameOpacity(null);
      }
      schedulePointForCurrent();
      updateActivity(fr);
    }
  }

  // Indicateur d'activité : part du domaine portant de la donnée → « rien / faible / … ».
  const ACTIVITY_LABELS = { none: 'rien à signaler', low: 'activité faible', moderate: 'activité modérée', high: 'activité forte' };
  function updateActivity(fr) {
    // garde-fou : l'activité n'a de sens que pour une VRAIE échéance AROME-PI (nowcast, qui
    // porte `.t`). Sans ça, une frame sans `.t` déclenche `activity?time=undefined` → 422.
    if (!activityEl || !status || !status.run || !fr || !fr.t) return;
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
    let data = null, obs = null;
    try {
      // valeurs prévues (AROME-PI) + valeurs OBSERVÉES (mosaïque radar MF) en parallèle
      const [rp, ro] = await Promise.all([
        fetch('/api/aromepi/point', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ lat, lon, time: t, run: status && status.run, layers: ['reflectivity', 'cape', 'gusts', 'hail', 'graupel'] }),
        }),
        frRadarTimes.length ? fetch('/api/radar/fr/point?lat=' + lat + '&lon=' + lon) : Promise.resolve(null),
      ]);
      data = await rp.json();
      if (ro) obs = await ro.json();
    } catch (_) {}
    if (token !== loadToken) return;
    if (!popup || !popup.isOpen()) return;        // popup fermé entre-temps
    if (!data || !data.ok) { showPopup(lat, lon, '<div class="chase-pop-empty">Conditions indisponibles ici.</div>'); return; }
    showPopup(lat, lon, renderPositionHTML(data.values || {}, t, (obs && obs.ok && obs.in_domain) ? obs : null));
  }

  function renderPositionHTML(v, t, obs) {
    const dbz = v.reflectivity, cape = v.cape, gust = v.gusts, hail = v.hail, graupel = v.graupel;
    // verdict : priorité à l'observé (dBZ mesuré) si disponible, sinon nowcast AROME-PI.
    const obsV = obs && obs.values || {};
    const echoObs = (typeof obsV.reflectivity === 'number') ? obsV.reflectivity : null;
    const echo = (echoObs !== null) ? echoObs : ((typeof dbz === 'number') ? Math.max(0, dbz) : null);
    let verdict, cls;
    if (echo !== null && echo >= 45) { verdict = '⛈ Cellule active'; cls = 'sev-high'; }
    else if (echo !== null && echo >= 20) { verdict = '🌧 Précipitations'; cls = 'sev-mid'; }
    else if (typeof cape === 'number' && cape >= 800) { verdict = '⚡ Air instable'; cls = 'sev-watch'; }
    else { verdict = '🌤 Calme'; cls = 'sev-low'; }
    const hailTxt = (typeof hail === 'number' && hail > 0.5) ? ' · grêle probable' : '';
    let html = `<div class="chase-verdict ${cls}">${verdict}${hailTxt}<span class="chase-verdict-time">${fmtClock(Math.floor(new Date(t).getTime() / 1000))}</span></div>`;
    // Bloc OBSERVÉ (radar MF) — les valeurs mesurées au sol, si la mosaïque couvre le point.
    if (obs && (typeof obsV.reflectivity === 'number' || typeof obsV.echo_top_km === 'number' || typeof obsV.rain_prob === 'number')) {
      const obsRows = [
        ['Réflectivité', typeof obsV.reflectivity === 'number' ? Math.round(Math.max(0, obsV.reflectivity)) : '—', ' dBZ'],
        ['Sommet d’écho', typeof obsV.echo_top_km === 'number' ? obsV.echo_top_km.toFixed(1) : '—', ' km'],
        ['Proba pluie', typeof obsV.rain_prob === 'number' ? obsV.rain_prob : '—', ' %'],
      ];
      const obsClock = fmtClock(Math.floor(new Date(obs.time).getTime() / 1000));
      html += `<div class="chase-pos-head">Observé · radar MF <span>${obsClock}</span></div>`;
      html += '<ul class="chase-pos-list">' + obsRows.map((r) => `<li><span>${r[0]}</span><strong>${r[1]}${(r[2] && r[1] !== '—') ? `<span class="chase-unit">${r[2]}</span>` : ''}</strong></li>`).join('') + '</ul>';
    }
    // Bloc PRÉVU (AROME-PI).
    const rows = [
      ['Réflectivité', echo !== null ? Math.round(echo) : '—', ' dBZ'],
      ['CAPE', typeof cape === 'number' ? Math.round(cape) : '—', ' J/kg'],
      ['Rafales 15 min', typeof gust === 'number' ? Math.round(gust) : '—', ' km/h'],
      ['Grêle (diag)', typeof hail === 'number' ? (hail > 0.5 ? 'oui' : 'non') : '—', ''],
      ['Graupel', typeof graupel === 'number' ? graupel.toFixed(2) : '—', ''],
    ];
    if (obs) html += '<div class="chase-pos-head">Prévu · AROME-PI</div>';
    html += '<ul class="chase-pos-list">' + rows.map((r) => `<li><span>${r[0]}</span><strong>${r[1]}${(r[2] && r[1] !== '—') ? `<span class="chase-unit">${r[2]}</span>` : ''}</strong></li>`).join('') + '</ul>';
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
  const LAYER_LEGENDS = {
    reflectivity: { title: 'Réflectivité', grad: ['#3ca0ff', '#28d2dc', '#3cdc6e', '#fae63c', '#faa028', '#f0462d', '#c828a0'], scale: ['8 dBZ', '32', '56+'], note: 'Cellule active > 45 dBZ' },
    cape: { title: 'CAPE · instabilité', grad: ['#00fe00', '#b1fe00', '#fefa00', '#e58700', '#e70d00', '#e00080', '#8c00c3'], scale: ['0', '1500', '3000+ J/kg'], note: 'Orages probables > 1000 J/kg' },
    gusts: { title: 'Rafales 15 min', grad: ['#00d7ff', '#38b6f2', '#8fd14b', '#fae63c', '#faa028', '#f0462d'], scale: ['faible', '', 'violente'], note: 'Rafale sévère > 90 km/h' },
    hail: { title: 'Grêle · diagnostic', grad: ['#3ca0ff', '#8fd14b', '#fae63c', '#f0462d'], scale: ['possible', '', 'probable'], note: 'Zones de grêle diagnostiquée' },
    graupel: { title: 'Graupel (grésil)', grad: ['#3ca0ff', '#28d2dc', '#8fd14b', '#fae63c'], scale: ['0', '', '+ kg/m²'], note: null },
    mocon: { title: 'Convergence humidité', grad: ['#5a6b8c', '#3cdc6e', '#fae63c', '#f0462d'], scale: ['−', '', '+'], note: 'Convergence (analyse du run)' },
  };
  function renderLegend(key) {
    const cfg = LAYER_LEGENDS[key] || LAYER_LEGENDS.reflectivity;
    const titleEl = document.getElementById('chaseLegendTitle');
    const barEl = document.getElementById('chaseLegendBar');
    const scaleEl = document.getElementById('chaseLegendScale');
    const noteEl = document.getElementById('chaseLegendNote');
    if (titleEl) titleEl.textContent = cfg.title;
    if (barEl) barEl.style.background = 'linear-gradient(90deg, ' + cfg.grad.join(', ') + ')';
    if (scaleEl) scaleEl.innerHTML = cfg.scale.map((s) => `<span>${s}</span>`).join('');
    if (noteEl) { noteEl.textContent = cfg.note || ''; noteEl.hidden = !cfg.note; }
  }

  function setLayer(key) {
    activeLayer = key;
    if (layerTabs) layerTabs.querySelectorAll('.chase-layer-btn').forEach((b) => {
      const on = b.dataset.chaseLayer === key;
      b.classList.toggle('active', on);
      b.setAttribute('aria-selected', on ? 'true' : 'false');
    });
    renderLegend(key);   // légende dynamique (toujours affichée)
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
    renderLegend(activeLayer);   // légende de la couche courante (réflectivité au départ)
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
    // masquer les couches radar par frame + libérer les couches nowcast (mémoire).
    for (const id of radarLayerIds) setVis(id, false);
    for (const id of Array.from(nowcastLayerIds)) {
      try { if (map.getLayer(id)) map.removeLayer(id); } catch (_) {}
      try { if (map.getSource(id)) map.removeSource(id); } catch (_) {}
      nowcastLayerIds.delete(id);
    }
    swapToken++;
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
  liveBtn?.addEventListener('click', goLive);
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
  window.__chaseV = '283';   // marqueur : vérifier que CE chase.js est servi (piège cache SW)
})();
