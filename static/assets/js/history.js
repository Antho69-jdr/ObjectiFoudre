// Écran Historique — vue dédiée, séparée de la carte temps réel.
// Rejoue une journée archivée en ANIMATION 24 h en SVG VECTORIEL : grille de
// cellules <rect> colorées (clippées à la France) + contours de départements,
// animées en JS sur la frise (mise à jour des couleurs par heure). Zoom net via
// viewBox. Foudre observée (MTG-LI) en <circle> blancs synchronisés à l'heure.
// Réutilise les globales de controls.js / france-admin-lines.js / utils.js.
(function () {
  const historyPage = document.getElementById('historyPage');
  if (!historyPage) return;

  const openBtn = document.getElementById('historyPageBtn');
  const closeBtn = document.getElementById('historyPageCloseBtn');
  const dateListEl = document.getElementById('historyDateList');
  const frameEl = document.getElementById('historyFrame'); // <svg>
  const emptyHintEl = document.getElementById('historyEmptyHint');
  const controlsEl = document.getElementById('historyPlayerControls');
  const playBtn = document.getElementById('historyPlayBtn');
  const scrubber = document.getElementById('historyScrubber');
  const hourLabel = document.getElementById('historyHourLabel');
  const downloadBtn = document.getElementById('historyDownloadBtn');
  const flashBtn = document.getElementById('historyFlashBtn');
  const analysisEl = document.getElementById('historyAnalysisText');
  const verifEl = document.getElementById('historyVerification');
  const subtitleEl = document.getElementById('historyPageSubtitle');
  const titleEl = document.getElementById('historyPageTitle');
  const learningEl = document.getElementById('learningPanel');
  const learningRetrainBtn = document.getElementById('learningRetrainBtn');
  const learningRevertBtn = document.getElementById('learningRevertBtn');

  const SVGNS = 'http://www.w3.org/2000/svg';
  const VB = 1000;           // taille logique du viewBox (carré)
  const FRAME_MS = 420;      // ≈ 2,4 images/s
  const Z_MAX = 8;

  let historyDate = null;
  let slotFrames = [];       // [{ hour, colors:[...] }] par créneau
  // Cellules rendues sur un <canvas> (2636 rects SVG = trop lent à re-rastériser
  // par frame). Le canvas est posé SOUS le SVG (masque + frontières + foudre) et
  // calé au pixel sur sa boîte ; chacun sur sa propre couche → seul le canvas se
  // repeint par frame (fillRect en diff), les frontières restent en cache.
  let cellCanvas = null;     // <canvas> des cellules (sous le SVG)
  let cellCtx = null;        // contexte 2D
  let cellGeom = [];         // [{ x, y, w, h }] en unités viewBox
  let curColors = [];        // couleurs des cellules à l'heure courante
  let flashLayer = null;     // <g> des impacts
  let projection = null;     // buildGifFranceProjection(...)
  let frameIndex = 0;
  let playing = false;
  let timer = null;
  let loadToken = 0;
  let showFlashes = false;
  let dayFlashPoints = [];
  let flashPointsDate = null;

  function formatDateLabel(iso) {
    try {
      const parsed = new Date(`${iso}T12:00:00`);
      if (Number.isNaN(parsed.getTime())) return iso;
      return new Intl.DateTimeFormat('fr-FR', { weekday: 'short', day: '2-digit', month: '2-digit', year: 'numeric' })
        .format(parsed).replace('.', '');
    } catch (_) {
      return iso;
    }
  }

  function hourText(hour) {
    const value = Number.isFinite(hour) ? hour : 0;
    return `${String(value).padStart(2, '0')}:00`;
  }

  function setHint(message) {
    const p = frameEl && frameEl.closest('.prediction-map-panel'); if (p) p.classList.remove('prediction-scanning');
    if (controlsEl) controlsEl.hidden = true;
    if (frameEl) frameEl.hidden = true;
    if (cellCanvas) cellCanvas.style.display = 'none';
    if (emptyHintEl) { emptyHintEl.hidden = false; emptyHintEl.textContent = message; }
  }

  async function loadDates() {
    if (!dateListEl) return;
    try {
      const response = await fetch('/api/history/dates');
      const data = await response.json().catch(() => ({}));
      const all = Array.isArray(data?.dates) ? data.dates : [];
      // Archives = jours RÉVOLUS uniquement (strictement passés). Aujourd'hui (en cours)
      // et le futur sont des prévisions vivantes, pas des archives → on les exclut.
      const todayIso = (typeof getTodayIsoDate === 'function')
        ? getTodayIsoDate()
        : new Date().toISOString().slice(0, 10);
      renderDateList(all.filter((item) => String(item?.date || '') < todayIso));
    } catch (_) {
      dateListEl.innerHTML = '<div class="history-dates-empty">Historique indisponible.</div>';
    }
  }

  // --- Sélection de date sous forme de CALENDRIER mensuel : les jours archivés
  // s'« allument » (cliquables) au fil des préchargements ; un bouton montre/masque
  // le calendrier (replié par défaut sur mobile pour rester compact). --------------
  const CAL_MONTHS = ['Janvier', 'Février', 'Mars', 'Avril', 'Mai', 'Juin', 'Juillet', 'Août', 'Septembre', 'Octobre', 'Novembre', 'Décembre'];
  const CAL_WEEKDAYS = ['L', 'M', 'M', 'J', 'V', 'S', 'D'];
  let archivedDates = [];
  let calArchiveSet = new Map();   // dateIso -> slot_count
  let calMonth = null;             // Date au 1er du mois affiché

  function isMobileHistory() {
    try { return matchMedia('(max-width: 920px), (max-height: 600px)').matches; } catch (_) { return false; }
  }
  function datesPanelEl() { return dateListEl ? dateListEl.closest('.history-dates-panel') : null; }
  function updateCalToggleCurrent() {
    const cur = document.getElementById('historyCalCurrent');
    if (cur) cur.textContent = historyDate ? formatDateLabel(historyDate) : 'Aucune date';
  }

  function renderDateList(dates) {
    if (!dateListEl) return;
    archivedDates = Array.isArray(dates) ? dates : [];
    calArchiveSet = new Map(archivedDates.map((i) => [i.date, i.slot_count]));
    if (!archivedDates.length) {
      dateListEl.innerHTML = '<div class="history-dates-empty">Aucune date archivée pour l’instant.</div>';
      slotFrames = [];
      setHint('L’historique se remplira au fil des préchargements AROME.');
      if (analysisEl) analysisEl.textContent = 'Aucune grille archivée pour l’instant.';
      updateCalToggleCurrent();
      return;
    }
    const needSelect = !historyDate || !archivedDates.some((i) => i.date === historyDate);
    if (!calMonth) {
      const a = new Date(`${(needSelect ? archivedDates[0].date : historyDate)}T12:00:00`);
      calMonth = new Date(a.getFullYear(), a.getMonth(), 1);
    }
    renderCalendar();
    if (needSelect) selectDate(archivedDates[0].date);
    else highlightActiveDate();
  }

  function renderCalendar() {
    if (!dateListEl || !calMonth) return;
    const y = calMonth.getFullYear();
    const m = calMonth.getMonth();
    const isoList = archivedDates.map((i) => i.date).sort();
    const minIso = isoList[0];
    const maxIso = isoList[isoList.length - 1];
    const canPrev = !!minIso && new Date(`${minIso}T12:00:00`) < new Date(y, m, 1);
    const canNext = !!maxIso && new Date(`${maxIso}T12:00:00`) >= new Date(y, m + 1, 1);
    const startOffset = (new Date(y, m, 1).getDay() + 6) % 7; // lundi = 0
    const daysInMonth = new Date(y, m + 1, 0).getDate();
    let cells = '';
    for (let i = 0; i < startOffset; i += 1) cells += '<div class="history-cal-day is-blank"></div>';
    for (let d = 1; d <= daysInMonth; d += 1) {
      const iso = `${y}-${String(m + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
      const has = calArchiveSet.has(iso);
      const cls = ['history-cal-day', has ? 'has-archive' : 'is-empty'];
      if (iso === historyDate) cls.push('active');
      const attrs = has ? ` data-date="${iso}" role="button" tabindex="0" title="${formatDateLabel(iso)} · ${calArchiveSet.get(iso)}/24"` : '';
      cells += `<div class="${cls.join(' ')}"${attrs}><span class="cal-num">${d}</span></div>`;
    }
    dateListEl.innerHTML = `
      <div class="history-cal-head">
        <button class="history-cal-nav" type="button" data-cal-prev aria-label="Mois précédent"${canPrev ? '' : ' disabled'}>‹</button>
        <span class="history-cal-month">${CAL_MONTHS[m]} ${y}</span>
        <button class="history-cal-nav" type="button" data-cal-next aria-label="Mois suivant"${canNext ? '' : ' disabled'}>›</button>
      </div>
      <div class="history-cal-grid">
        ${CAL_WEEKDAYS.map((w) => `<div class="history-cal-wd">${w}</div>`).join('')}
        ${cells}
      </div>`;
    const prev = dateListEl.querySelector('[data-cal-prev]');
    const next = dateListEl.querySelector('[data-cal-next]');
    if (prev) prev.addEventListener('click', () => calShiftMonth(-1));
    if (next) next.addEventListener('click', () => calShiftMonth(1));
    dateListEl.querySelectorAll('.history-cal-day.has-archive').forEach((cell) => {
      const pick = () => {
        selectDate(cell.dataset.date);
        if (isMobileHistory()) {   // sur mobile : on referme le calendrier après le choix
          const p = datesPanelEl();
          if (p) p.classList.add('cal-collapsed');
          const t = document.getElementById('historyCalToggle');
          if (t) t.setAttribute('aria-expanded', 'false');
        }
      };
      cell.addEventListener('click', pick);
      cell.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); pick(); } });
    });
  }

  function calShiftMonth(delta) {
    if (!calMonth) return;
    calMonth = new Date(calMonth.getFullYear(), calMonth.getMonth() + delta, 1);
    renderCalendar();
  }

  function highlightActiveDate() {
    if (dateListEl) {
      if (historyDate && calMonth) {   // si la date active est dans un autre mois, on y saute
        const a = new Date(`${historyDate}T12:00:00`);
        if (a.getFullYear() !== calMonth.getFullYear() || a.getMonth() !== calMonth.getMonth()) {
          calMonth = new Date(a.getFullYear(), a.getMonth(), 1);
          renderCalendar();
        }
      }
      dateListEl.querySelectorAll('.history-cal-day').forEach((c) => {
        c.classList.toggle('active', c.dataset.date === historyDate);
      });
    }
    updateCalToggleCurrent();
  }

  // L'app live peut saturer les connexions du navigateur pendant un préchargement
  // AROME : on borne chaque tentative et on réessaie.
  async function fetchDay(date, token, attempt = 1) {
    const controller = new AbortController();
    const t = window.setTimeout(() => controller.abort(), 12000);
    try {
      const response = await fetch(`/api/history/day?date=${encodeURIComponent(date)}`, { signal: controller.signal });
      window.clearTimeout(t);
      return await response.json().catch(() => ({}));
    } catch (_) {
      window.clearTimeout(t);
      if (token === loadToken && attempt < 4) {
        setHint(`Chargement de la grille archivée… (tentative ${attempt + 1})`);
        await new Promise((resolve) => window.setTimeout(resolve, 800));
        if (token !== loadToken) return {};
        return fetchDay(date, token, attempt + 1);
      }
      return {};
    }
  }

  const cellKey = (cell) => `${(+cell.lat).toFixed(3)}|${(+cell.lon).toFixed(3)}`;

  function projectCellRect(cell, proj) {
    const halfH = (Number(cell.cell_height_deg) || 0.135) / 2;
    const halfW = (Number(cell.cell_width_deg) || 0.18) / 2;
    const nw = proj.project(Number(cell.lon) - halfW, Number(cell.lat) + halfH);
    const se = proj.project(Number(cell.lon) + halfW, Number(cell.lat) - halfH);
    if (!nw || !se) return null;
    const x = Math.min(nw.x, se.x);
    const y = Math.min(nw.y, se.y);
    const w = Math.abs(se.x - nw.x);
    const h = Math.abs(se.y - nw.y);
    return { x, y, w: w + 0.5, h: h + 0.5 }; // léger overlap anti-couture
  }

  function ringsToPath(rings, proj, step = 1) {
    let d = '';
    for (const ring of rings) {
      if (!Array.isArray(ring) || ring.length < 2) continue;
      const last = ring.length - 1;
      for (let j = 0; j <= last; j += step) {
        const k = j > last ? last : j;
        const p = proj.project(Number(ring[k][0]), Number(ring[k][1])); // ring point = [lon, lat]
        if (!p) continue;
        d += (j === 0 ? 'M' : 'L') + p.x.toFixed(1) + ' ' + p.y.toFixed(1);
      }
      d += 'Z';
    }
    return d;
  }

  // Frontières INTERNES de départements seulement : le long des limites de région/pays
  // (déjà tracées, plus nettement, par la couche régions), la limite de département
  // coïncidente est retirée → UNE SEULE ligne par frontière (plus de « double trait »).
  // Régions et départements venant de 2 GeoJSON IGN simplifiés différents (limites
  // partagées non coïncidentes au pixel), on teste la proximité (eps, unités viewBox) de
  // chaque point dept aux segments de région via une grille spatiale (O(1)/point, build).
  //
  // Finesse aux JONCTIONS : une limite interne qui vient buter sur une frontière de région
  // (jonction en T) ne doit PAS s'arrêter avant de la toucher. On ne coupe donc que les
  // points « intérieurs » d'un segment coïncident (leurs 2 voisins sont aussi proches) ;
  // les points de transition (un voisin est loin) sont GARDÉS et ACCROCHÉS exactement sur
  // le point le plus proche de la frontière de région → la limite touche pile la région.
  //
  // NB step=1 IMPÉRATIF : chaque limite interne est tracée par les 2 départements voisins ;
  // leurs sommets ne coïncident (→ trait unique) qu'en pleine résolution. Décimer (step>1)
  // échantillonne des points différents de part et d'autre → double trait « biscornu ».
  // Les régions sont propres pour la même raison (step 1).
  function deptInteriorPath(deptRings, regionRings, proj, step = 1, eps = 6) {
    if (!Array.isArray(regionRings) || !regionRings.length) return ringsToPath(deptRings, proj, step);
    const cell = Math.max(4, eps);
    const grid = new Map();
    const key = (gx, gy) => gx + ',' + gy;
    const addSeg = (ax, ay, bx, by) => {
      const minx = Math.min(ax, bx) - eps, maxx = Math.max(ax, bx) + eps;
      const miny = Math.min(ay, by) - eps, maxy = Math.max(ay, by) + eps;
      for (let gx = Math.floor(minx / cell); gx <= Math.floor(maxx / cell); gx += 1) {
        for (let gy = Math.floor(miny / cell); gy <= Math.floor(maxy / cell); gy += 1) {
          const k = key(gx, gy); let a = grid.get(k); if (!a) grid.set(k, a = []); a.push([ax, ay, bx, by]);
        }
      }
    };
    for (const ring of regionRings) {
      if (!Array.isArray(ring) || ring.length < 2) continue;
      let prev = null;
      for (let j = 0; j < ring.length; j += 1) {
        const p = proj.project(Number(ring[j][0]), Number(ring[j][1]));
        if (!p) continue;
        if (prev) addSeg(prev.x, prev.y, p.x, p.y);
        prev = p;
      }
    }
    const eps2 = eps * eps;
    // Point le plus proche sur une frontière de région (dans eps), sinon null.
    const snapToRegion = (px, py) => {
      const gx = Math.floor(px / cell), gy = Math.floor(py / cell);
      let best = eps2, bx = null, by = null;
      for (let ox = -1; ox <= 1; ox += 1) {
        for (let oy = -1; oy <= 1; oy += 1) {
          const a = grid.get(key(gx + ox, gy + oy)); if (!a) continue;
          for (const s of a) {
            const dx = s[2] - s[0], dy = s[3] - s[1], l2 = dx * dx + dy * dy;
            let t = l2 ? ((px - s[0]) * dx + (py - s[1]) * dy) / l2 : 0;
            t = t < 0 ? 0 : t > 1 ? 1 : t;
            const cx = s[0] + t * dx, cy = s[1] + t * dy, ex = px - cx, ey = py - cy, dd = ex * ex + ey * ey;
            if (dd <= best) { best = dd; bx = cx; by = cy; }
          }
        }
      }
      return bx == null ? null : { x: bx, y: by };
    };
    let d = '';
    for (const ring of deptRings) {
      if (!Array.isArray(ring) || ring.length < 2) continue;
      const pts = [];
      for (let j = 0; j < ring.length; j += step) {
        const p = proj.project(Number(ring[j][0]), Number(ring[j][1]));
        if (p) pts.push(p);
      }
      const n = pts.length;
      if (n < 2) continue;
      const sn = pts.map((p) => snapToRegion(p.x, p.y)); // null = loin d'une région
      let started = false;
      for (let i = 0; i < n; i += 1) {
        const near = !!sn[i];
        const transition = near && ((i > 0 && !sn[i - 1]) || (i < n - 1 && !sn[i + 1]));
        if (near && !transition) { started = false; continue; } // intérieur d'un segment coïncident → retiré
        const c = transition ? sn[i] : pts[i]; // jonction → accrochée pile sur la région
        d += (started ? 'L' : 'M') + c.x.toFixed(1) + ' ' + c.y.toFixed(1);
        started = true;
      }
    }
    return d;
  }

  // --- Canvas des cellules (perf) : posé sous le SVG, calé sur sa boîte --------------
  function ensureCellCanvas() {
    if (cellCanvas || !frameEl || !frameEl.parentElement) return cellCanvas;
    const panel = frameEl.parentElement;
    cellCanvas = document.createElement('canvas');
    cellCanvas.className = 'history-cell-canvas';
    const st = cellCanvas.style;
    st.position = 'absolute'; st.pointerEvents = 'none'; st.zIndex = '0';
    st.transform = 'translateZ(0)'; st.display = 'none';
    panel.insertBefore(cellCanvas, frameEl); // AVANT le SVG (donc dessous)
    // SVG (masque + frontières + foudre) au-dessus, fond transparent, sur SA propre
    // couche de compositing → n'est plus re-rastérisé quand les cellules changent.
    frameEl.style.position = 'relative';
    frameEl.style.zIndex = '1';
    frameEl.style.transform = 'translateZ(0)';
    frameEl.style.background = 'transparent';
    if (typeof ResizeObserver !== 'undefined') {
      try { new ResizeObserver(() => syncCellCanvas()).observe(panel); } catch (_) {}
    }
    window.addEventListener('resize', syncCellCanvas);
    return cellCanvas;
  }

  // Cale le canvas sur la boîte (carrée) du SVG et pré-calcule les rects en pixels du
  // backing (bords arrondis à l'entier → tuilage net sans couture, comme optimizeSpeed).
  function syncCellCanvas() {
    if (!cellCanvas || !frameEl || !frameEl.parentElement) return;
    const panel = frameEl.parentElement;
    const s = frameEl.getBoundingClientRect();
    if (s.width < 1) return;
    const p = panel.getBoundingClientRect();
    const pcs = getComputedStyle(panel);
    const bl = parseFloat(pcs.borderLeftWidth) || 0; // le top/left absolu est relatif au
    const bt = parseFloat(pcs.borderTopWidth) || 0;  // padding-box → on retire la bordure
    const dpr = window.devicePixelRatio || 1;
    cellCanvas.style.left = (s.left - p.left - bl) + 'px';
    cellCanvas.style.top = (s.top - p.top - bt) + 'px';
    cellCanvas.style.width = s.width + 'px';
    cellCanvas.style.height = s.height + 'px';
    cellCanvas.width = Math.max(1, Math.round(s.width * dpr));
    cellCanvas.height = Math.max(1, Math.round(s.height * dpr));
    cellCtx = cellCanvas.getContext('2d');
    redrawAllCells();
  }

  // Repeint tout le canvas (fond + cellules) EN SUIVANT le zoom/pan courant (vb) : le
  // transform mappe les coords viewBox → pixels du backing, exactement comme le viewBox
  // du SVG → cellules et frontières restent alignées à tout niveau de zoom. Redraw complet
  // à chaque frame/zoom/pan : sur canvas c'est ~1-3 ms (vs re-rastériser 2636 rects SVG).
  function redrawAllCells() {
    if (!cellCtx || !cellCanvas || !cellGeom.length) return;
    const bw = cellCanvas.width, bh = cellCanvas.height;
    cellCtx.setTransform(1, 0, 0, 1, 0, 0);
    cellCtx.fillStyle = '#070f1c';
    cellCtx.fillRect(0, 0, bw, bh);
    const sx = bw / vb.w, sy = bh / vb.h;
    cellCtx.setTransform(sx, 0, 0, sy, -vb.x * sx, -vb.y * sy);
    const inf = 0.6 / sx; // léger débord (~0,6 px) pour éviter les coutures entre cellules
    for (let k = 0; k < cellGeom.length; k += 1) {
      cellCtx.fillStyle = curColors[k] || '#070f1c';
      const g = cellGeom[k];
      cellCtx.fillRect(g.x, g.y, g.w + inf, g.h + inf);
    }
  }

  // Construit le SVG (DOM) une fois pour la journée + retourne les couleurs par créneau.
  function buildSvg(day) {
    if (!frameEl || typeof buildGifFranceProjection !== 'function') return null;
    const slots = (typeof getRenderableSlots === 'function')
      ? getRenderableSlots(day)
      : (Array.isArray(day?.slots) ? day.slots : []);
    if (!slots.length) return null;
    const proj = buildGifFranceProjection({ left: 0, top: 0, width: VB, height: VB });
    projection = proj;
    // Rampe « radar/chaleur » sur ink (cohérente avec la Carte de risque Prévision).
    const color = (typeof colorFromStormForecast === 'function') ? colorFromStormForecast
      : ((typeof gifScoreColor === 'function') ? gifScoreColor : ((s) => (typeof colorFromScore === 'function' ? colorFromScore(s) : '#3a6')));
    const baseColor = color(0);

    // 1) géométrie : union des cellules sur tous les créneaux
    const idxByKey = new Map();
    const geom = [];
    for (const slot of slots) {
      for (const cell of (slot.cells || [])) {
        if (!cell || cell.source_provider !== 'meteofrance_arome_grib' || cell.lat == null || cell.lon == null) continue;
        const key = cellKey(cell);
        if (!idxByKey.has(key)) {
          const g = projectCellRect(cell, proj);
          if (g) { idxByKey.set(key, geom.length); geom.push(g); }
        }
      }
    }
    if (!geom.length) return null;
    const n = geom.length;

    // 2) couleurs par créneau
    const frames = slots.map((slot, i) => {
      const colors = new Array(n).fill(baseColor);
      for (const cell of (slot.cells || [])) {
        if (!cell || cell.source_provider !== 'meteofrance_arome_grib') continue;
        const idx = idxByKey.get(cellKey(cell));
        if (idx != null) colors[idx] = color(Number(cell.trigger_score) || 0);
      }
      return { hour: (typeof gifSlotHour === 'function') ? gifSlotHour(slot, i) : i, colors };
    });

    // 3) DOM SVG — PAS de clipPath (les 2636 cellules sont déjà masquées France
    // côté serveur : leur union forme la France) ni de fond plein : énorme gain
    // de perf (le clip sur 2636 rects + un gros path se re-rasterisaient à chaque
    // frame). Contours de départements décimés. shape-rendering: optimizeSpeed.
    // Frontières IGN : départements fins (dessous) + régions nettes (dessus), comme
    // la carte de base. Décimation légère des départements pour garder l'animation fluide.
    const deptRings = (typeof FRANCE_DEPARTMENT_RINGS !== 'undefined' && Array.isArray(FRANCE_DEPARTMENT_RINGS)) ? FRANCE_DEPARTMENT_RINGS
      : ((typeof FRANCE_GRID_CLIP_RINGS !== 'undefined' && Array.isArray(FRANCE_GRID_CLIP_RINGS)) ? FRANCE_GRID_CLIP_RINGS : []);
    const regionRings = (typeof franceRegionRings === 'function') ? franceRegionRings() : [];
    // Départements : SEULEMENT leurs frontières internes (deptInteriorPath retire les
    // limites qui longent une région/le pays) → une seule ligne par frontière. Step 1
    // obligatoire (voir deptInteriorPath) sinon les limites inter-départements doublent.
    // Régions aussi en step 1 : traits « hero » (contour pays + régions), tracés une fois.
    const deptData = deptRings.length ? deptInteriorPath(deptRings, regionRings, proj, 1, 6) : '';
    const regionData = regionRings.length ? ringsToPath(regionRings, proj, 1) : '';

    while (frameEl.firstChild) frameEl.removeChild(frameEl.firstChild);
    frameEl.setAttribute('viewBox', `0 0 ${VB} ${VB}`);
    frameEl.setAttribute('preserveAspectRatio', 'xMidYMid meet');

    // Cellules : rendues sur le <canvas> sous le SVG (perf). Le SVG reste transparent
    // au fond (le canvas fournit fond + cellules) et ne porte plus que masque +
    // frontières + foudre. Le masque « hors-France » couvre le débord des cellules.
    ensureCellCanvas();
    cellGeom = geom;
    curColors = new Array(n).fill(baseColor);
    syncCellCanvas();
    if (cellCanvas) cellCanvas.style.display = '';

    // Masque « hors-France » : un seul path statique (rectangle troué de la France,
    // fill-rule evenodd) rempli du fond, posé SUR les cellules → couvre les carrés
    // de la grille qui dépassent la frontière, SANS clipPath (aucun coût par frame,
    // contrairement au clip sur 2636 rects que l'on évite).
    const clipRings = (typeof FRANCE_GRID_CLIP_RINGS !== 'undefined' && Array.isArray(FRANCE_GRID_CLIP_RINGS) && FRANCE_GRID_CLIP_RINGS.length)
      ? FRANCE_GRID_CLIP_RINGS : regionRings;
    const franceOutline = (clipRings && clipRings.length) ? ringsToPath(clipRings, proj, 2) : '';
    if (franceOutline) {
      const mask = document.createElementNS(SVGNS, 'path');
      mask.setAttribute('d', `M0 0 H${VB} V${VB} H0 Z ${franceOutline}`);
      mask.setAttribute('fill', '#070f1c');
      mask.setAttribute('fill-rule', 'evenodd');
      mask.setAttribute('pointer-events', 'none');
      // optimizeSpeed : ce grand fill plein écran (troué France) est re-rastérisé à
      // chaque frame ; couper l'anti-aliasing économise beaucoup de fill-rate sur mobile.
      // Le léger crénelage du littoral est masqué par le trait de région lissé posé dessus.
      mask.setAttribute('shape-rendering', 'optimizeSpeed');
      frameEl.appendChild(mask);
    }

    const addBorderPath = (d, stroke, width, dash) => {
      if (!d) return;
      const p = document.createElementNS(SVGNS, 'path');
      p.setAttribute('d', d);
      p.setAttribute('fill', 'none');
      p.setAttribute('stroke', stroke);
      p.setAttribute('stroke-width', String(width));
      if (dash) p.setAttribute('stroke-dasharray', dash);
      p.setAttribute('vector-effect', 'non-scaling-stroke');
      p.setAttribute('stroke-linejoin', 'round');
      p.setAttribute('stroke-linecap', 'round');
      p.setAttribute('pointer-events', 'none');
      frameEl.appendChild(p);
    };
    // UNE SEULE ligne par frontière (plus de « double trait ») : deptData ne contient
    // que les limites INTERNES de départements ; les limites région/pays sont tracées
    // uniquement par la couche régions. Départements en trait plein fin subordonné,
    // régions en trait plein cyan + casing sombre (frontière « hero »).
    // Ordre : dept dessous < halo région < cyan région.
    addBorderPath(deptData, 'rgba(120,145,175,0.5)', 0.9);
    addBorderPath(regionData, 'rgba(2,6,23,0.72)', 2.2);
    addBorderPath(regionData, 'rgba(125,211,252,0.72)', 1.2);

    flashLayer = document.createElementNS(SVGNS, 'g');
    frameEl.appendChild(flashLayer);
    return frames;
  }

  // France « vide » (ink + maillage cyan) dans #historyFrame pendant le chargement :
  // buildSvg videra ensuite le SVG et le reconstruira coloré → hydratation (comme
  // la Carte de risque Prévision). Régions remplies = silhouette France.
  function renderHistoryScope() {
    if (!frameEl || typeof buildGifFranceProjection !== 'function' || typeof franceRegionRings !== 'function') return false;
    const proj = buildGifFranceProjection({ left: 0, top: 0, width: VB, height: VB });
    const regionRings = franceRegionRings();
    const deptRings = (typeof FRANCE_DEPARTMENT_RINGS !== 'undefined' && Array.isArray(FRANCE_DEPARTMENT_RINGS)) ? FRANCE_DEPARTMENT_RINGS : [];
    const regionData = (regionRings && regionRings.length) ? ringsToPath(regionRings, proj, 1) : '';
    if (!regionData) return false;
    const deptData = deptRings.length ? deptInteriorPath(deptRings, regionRings, proj, 1, 6) : '';
    while (frameEl.firstChild) frameEl.removeChild(frameEl.firstChild);
    frameEl.setAttribute('viewBox', `0 0 ${VB} ${VB}`);
    frameEl.setAttribute('preserveAspectRatio', 'xMidYMid meet');
    const mk = (tag, attrs) => { const e = document.createElementNS(SVGNS, tag); for (const k in attrs) e.setAttribute(k, attrs[k]); return e; };
    frameEl.appendChild(mk('rect', { x: 0, y: 0, width: VB, height: VB, fill: '#070f1c' }));
    frameEl.appendChild(mk('path', { d: regionData, fill: '#091321' }));
    const border = (d, stroke, w, dash) => {
      if (!d) return;
      const a = { d, fill: 'none', stroke, 'stroke-width': String(w), 'vector-effect': 'non-scaling-stroke', 'stroke-linejoin': 'round', 'stroke-linecap': 'round' };
      if (dash) a['stroke-dasharray'] = dash;
      frameEl.appendChild(mk('path', a));
    };
    // Mêmes contours que buildSvg → aucun saut de style à l'hydratation (dépt internes
    // seuls en trait plein fin, régions plein cyan + casing ; une seule ligne/frontière).
    border(deptData, 'rgba(120,145,175,0.5)', 0.9);
    border(regionData, 'rgba(2,6,23,0.72)', 2.2);
    border(regionData, 'rgba(125,211,252,0.72)', 1.2);
    return true;
  }
  function historyPanel() { return frameEl && frameEl.closest('.prediction-map-panel'); }
  function showHistoryScanning() {
    renderHistoryScope();
    if (frameEl) frameEl.hidden = false;
    if (cellCanvas) cellCanvas.style.display = 'none'; // échafaudage = SVG opaque seul
    if (emptyHintEl) emptyHintEl.hidden = true;
    const p = historyPanel(); if (p) p.classList.add('prediction-scanning');
  }
  function hideHistoryScanning() {
    const p = historyPanel(); if (p) p.classList.remove('prediction-scanning');
  }

  async function selectDate(date) {
    historyDate = date;
    highlightActiveDate();
    pause();
    resetZoom();
    const token = ++loadToken;
    loadVerification(date);
    ensureFlashPoints(date); // couche SVG séparée -> pas besoin d'attendre
    showHistoryScanning();
    try {
      const data = await fetchDay(date, token);
      if (token !== loadToken) return;
      const day = data?.payload?.days?.[0] || null;
      if (!data?.ok || !day) {
        slotFrames = [];
        setHint(data?.message || 'Aucune grille archivée pour cette date.');
        if (analysisEl) analysisEl.textContent = data?.message || 'Aucune grille archivée pour cette date.';
        return;
      }
      const frames = buildSvg(day);
      if (token !== loadToken) return;
      if (!frames || !frames.length) {
        setHint('Aucune cellule exploitable pour cette journée.');
        return;
      }
      setupPlayer(frames, computeAnalysisHtml(day));
    } catch (_) {
      if (token === loadToken) setHint('Erreur de chargement de l’historique.');
    }
  }

  function setupPlayer(frames, analysisHtml) {
    hideHistoryScanning();
    slotFrames = frames;
    frameIndex = 0;
    if (scrubber) { scrubber.min = 0; scrubber.max = Math.max(0, frames.length - 1); scrubber.value = 0; }
    if (controlsEl) controlsEl.hidden = false;
    if (emptyHintEl) emptyHintEl.hidden = true;
    if (frameEl) frameEl.hidden = false;
    if (cellCanvas) { cellCanvas.style.display = ''; syncCellCanvas(); }
    if (titleEl) titleEl.textContent = 'Historique · animation 24 h';
    if (subtitleEl) {
      const fps = (1000 / FRAME_MS).toFixed(1);
      subtitleEl.textContent = `${historyDate ? formatDateLabel(historyDate) : ''} · ${frames.length} h animées · SVG · ${fps} img/s`;
    }
    if (analysisEl) analysisEl.innerHTML = analysisHtml || 'Pas de synthèse disponible pour cette journée.';
    showHour(0);
    play();
  }

  function showHour(index) {
    if (!slotFrames.length) return;
    frameIndex = ((index % slotFrames.length) + slotFrames.length) % slotFrames.length;
    curColors = slotFrames[frameIndex].colors;
    redrawAllCells(); // repeint le canvas avec le zoom/pan courant
    renderFlashHour(slotFrames[frameIndex].hour);
    if (scrubber) scrubber.value = String(frameIndex);
    if (hourLabel) hourLabel.textContent = hourText(slotFrames[frameIndex].hour);
  }

  function tick() { showHour(frameIndex + 1); }

  function play() {
    if (playing || slotFrames.length < 2) return;
    playing = true;
    if (playBtn) { playBtn.textContent = '⏸'; playBtn.setAttribute('aria-label', 'Pause'); }
    timer = window.setInterval(tick, FRAME_MS);
  }

  function pause() {
    playing = false;
    if (playBtn) { playBtn.textContent = '▶'; playBtn.setAttribute('aria-label', 'Lecture'); }
    if (timer) { window.clearInterval(timer); timer = null; }
  }

  // Synthèse textuelle de la journée (réutilise le résumé iso-contours « jour »).
  function computeAnalysisHtml(day) {
    try {
      if (typeof collectPredictionDailyCells === 'function' && typeof predictionBuildAnalysisHtml === 'function') {
        let cells = collectPredictionDailyCells(day, 'day');
        if (typeof smoothPredictionCells === 'function') cells = smoothPredictionCells(cells);
        if (cells.length) return predictionBuildAnalysisHtml(day, cells, 'day');
      }
    } catch (_) { /* ignore */ }
    return 'Pas de synthèse disponible pour cette journée.';
  }

  // --- Vérification prévision vs réalité (foudre MTG-LI observée) ---
  let verifToken = 0;

  function fidelityTone(data) {
    if (!data || data.fidelity == null || data.low_signal) return 'muted';
    const f = data.fidelity;
    if (f >= 70) return 'good';
    if (f >= 45) return 'ok';
    if (f >= 20) return 'mid';
    return 'low';
  }

  const asPct = (x) => (x == null ? '—' : `${Math.round(x * 100)} %`);
  const asNum = (x) => (x == null ? '—' : x);

  async function loadVerification(date) {
    if (!verifEl) return;
    const token = ++verifToken;
    verifEl.innerHTML = '<div class="history-verif-empty">Calcul du score de vérification…</div>';
    try {
      const response = await fetch(`/api/history/verification?date=${encodeURIComponent(date)}`);
      const data = await response.json().catch(() => ({}));
      if (token !== verifToken || date !== historyDate) return;
      renderVerification(data, date);
    } catch (_) {
      if (token === verifToken) verifEl.innerHTML = '<div class="history-verif-empty">Score indisponible.</div>';
    }
  }

  function renderVerification(data, date) {
    if (!verifEl) return;
    if (!data || !data.ok) {
      if (data && data.reason === 'no_observation') {
        verifEl.innerHTML = '<div class="history-verif-empty">Pas encore de foudre observée archivée pour ce jour.</div>'
          + '<button class="history-collect-btn" id="historyCollectBtn" type="button">Collecter la foudre observée (≈ 1 min)</button>';
        const btn = document.getElementById('historyCollectBtn');
        if (btn) btn.addEventListener('click', () => collectLightning(date));
      } else {
        verifEl.innerHTML = `<div class="history-verif-empty">${(data && data.message) || 'Score indisponible.'}</div>`;
      }
      return;
    }
    const tone = fidelityTone(data);
    const c = data.contingency || {};
    const s = data.scores || {};
    const csi = s.csi == null ? '—' : Number(s.csi).toFixed(2);
    verifEl.innerHTML = `
      <div class="history-verif-score tone-${tone}">
        <div class="history-verif-fidelity">${data.fidelity == null ? '—' : data.fidelity}<span>/100</span></div>
        <div class="history-verif-label">${data.label || ''}</div>
      </div>
      <div class="history-verif-metrics">
        <div><span>Détection (POD)</span><b>${asPct(s.pod)}</b></div>
        <div><span>Précision</span><b>${asPct(s.success_ratio)}</b></div>
        <div><span>Succès (CSI)</span><b>${csi}</b></div>
      </div>
      <div class="history-verif-counts">
        <div><b>${asNum(data.forecast_cells)}</b><span>zones prévues</span></div>
        <div><b>${asNum(data.observed_cells)}</b><span>zones observées</span></div>
        <div><b>${asNum(data.flash_total)}</b><span>flashs</span></div>
      </div>
      <div class="history-verif-cont">✔ ${asNum(c.hits)} bonnes · ✘ ${asNum(c.misses)} ratées · ⚠ ${asNum(c.false_alarms)} fausses alertes</div>`;
  }

  // --- Auto-calibration : statut + actions ---
  let learningToken = 0;
  const WEIGHT_LABELS = { cape: 'CAPE', humid: 'Humidité', heat: 'Chauffage', conv: 'Converg.' };
  const WEIGHT_COLORS = { cape: '#ef6f6f', humid: '#5b9bd5', heat: '#e0a04d', conv: '#6fcf97' };
  const WEIGHT_KEYS = ['cape', 'humid', 'heat', 'conv'];

  // Barre de chargement indéterminée (pas de progression réelle côté serveur).
  function progressHtml(label) {
    return `<div class="history-learning-progress">
      <div class="hl-progress"><i></i></div>
      <div class="hl-progress-label">${label}</div>
    </div>`;
  }

  // Normalise un jeu de poids en proportions (somme = 1) sur les 4 blocs.
  function weightShares(src) {
    const total = WEIGHT_KEYS.reduce((s, k) => s + (Number(src && src[k]) || 0), 0) || 1;
    const out = {};
    WEIGHT_KEYS.forEach((k) => { out[k] = (Number(src && src[k]) || 0) / total; });
    return out;
  }

  // Histogramme « proportion de chaque bloc dans le calcul du score ».
  // Toujours affiché : poids appris si calibré, sinon poids d'origine.
  function renderWeightHistogram(active, def, calibrated) {
    const learned = !!(active && active.enabled);
    const cur = weightShares(learned ? active : def);
    const orig = weightShares(def);
    const badge = learned
      ? '<em class="hl-w-badge on">appris</em>'
      : '<em class="hl-w-badge">d\'origine</em>';
    const stacked = WEIGHT_KEYS.map((k) => {
      const pct = (cur[k] * 100).toFixed(1);
      return `<i style="width:${pct}%;background:${WEIGHT_COLORS[k]}" title="${WEIGHT_LABELS[k]} ${Math.round(cur[k] * 100)}%"></i>`;
    }).join('');
    const rows = WEIGHT_KEYS.map((k) => {
      const pct = Math.round(cur[k] * 100);
      const op = Math.round(orig[k] * 100);
      const delta = learned ? pct - op : 0;
      const deltaTxt = (learned && delta !== 0)
        ? `<small class="hl-w-delta ${delta > 0 ? 'up' : 'down'}">${delta > 0 ? '+' : ''}${delta}</small>`
        : '<small class="hl-w-delta"></small>';
      const ghost = (learned && op !== pct)
        ? `<span class="hl-w-ghost" style="left:${op}%" title="origine ${op}%"></span>`
        : '';
      return `<div class="hl-w-row">
        <span class="hl-w-name" style="--hl-c:${WEIGHT_COLORS[k]}">${WEIGHT_LABELS[k]}</span>
        <span class="hl-w-track"><i style="width:${pct}%;background:${WEIGHT_COLORS[k]}"></i>${ghost}</span>
        <b class="hl-w-val">${pct}%</b>${deltaTxt}
      </div>`;
    }).join('');
    const hint = learned
      ? '<div class="hl-w-hint">Le repère clair marque la valeur d\'origine.</div>'
      : (calibrated
        ? '<div class="hl-w-hint">Poids d\'origine conservés — aucun mélange appris ne fait mieux pour l\'instant (seuil et calibration, eux, sont appris).</div>'
        : '<div class="hl-w-hint">Proportions d\'origine — affinées dès que la calibration s\'active.</div>');
    // Honnêteté : ces 4 proportions valent quand la convergence de surface est disponible.
    // Sinon (donnée absente), le modèle rebascule sur un barème à 3 blocs (part convergence
    // répartie sur CAPE / humidité / chauffage) — le score final applique aussi gates,
    // modificateurs et atténuation par la confiance.
    const convNote = '<div class="hl-w-hint hl-w-note">La convergence n\'entre que si elle est disponible ; sinon sa part est répartie sur les trois autres blocs.</div>';
    return `<div class="history-learning-hist">
      <div class="hl-w-head"><span>Poids dans le calcul du score</span>${badge}</div>
      <div class="hl-w-stack">${stacked}</div>
      ${rows}
      ${hint}
      ${convNote}
    </div>`;
  }

  function renderLearningStatus(st) {
    if (!learningEl) return;
    if (!st || !st.ok) { learningEl.innerHTML = '<div class="history-learning-muted">Indisponible.</div>'; return; }
    const d = st.data || {};
    const g = st.gates || {};
    const stateLabel = { collecting: 'En collecte', baseline: 'Modèle de base', active: 'Calibré' }[st.state] || st.state;
    const stateTone = { collecting: 'wait', baseline: 'base', active: 'on' }[st.state] || 'base';
    let html = `<div class="history-learning-state tone-${stateTone}">${stateLabel}</div>`;
    html += `<div class="history-learning-data">
      <div><b>${asNum(d.days)}</b><span>jours appris</span></div>
      <div><b>${asNum(d.storm_days)}</b><span>jours orageux</span></div>
      <div><b>${asNum(d.positives)}</b><span>cellules foudre</span></div>
    </div>`;
    if (st.state === 'collecting') {
      const dayPct = Math.min(100, Math.round(100 * (d.days || 0) / (g.calib_min_days || 10)));
      html += `<div class="history-learning-gauge"><span>Vers la 1re calibration</span>
        <div class="hl-bar"><i style="width:${dayPct}%"></i></div>
        <small>${asNum(d.days)}/${g.calib_min_days} jours · ${asNum(d.positives)}/${g.calib_min_positives} cellules orageuses</small></div>`;
      html += `<div class="history-learning-muted">Le modèle accumule des journées. Une correction ne sera appliquée que lorsqu'elle améliorera réellement le score sur des jours de test.</div>`;
    }
    const thr = st.threshold || {};
    const thrExtra = (thr.active !== thr.baseline) ? ` <i>(base ${asNum(thr.baseline)})</i>` : '';
    html += `<div class="history-learning-row"><span>Seuil « zones prévues »</span><b>${asNum(thr.active)}${thrExtra}</b></div>`;
    const wActive = (st.weights && st.weights.active) || null;
    const wDef = (st.weights && st.weights.default) || {};
    html += renderWeightHistogram(wActive, wDef, st.state === 'active');
    const sk = st.skill || null;
    if (sk && sk.baseline && sk.candidate) {
      html += `<div class="history-learning-skill"><span>Score CSI (test)</span><b>${Number(sk.baseline.csi).toFixed(2)} → ${Number(sk.candidate.csi).toFixed(2)}</b></div>`;
    }
    if (st.fitted_at) html += `<div class="history-learning-muted">Dernier ajustement : ${String(st.fitted_at).slice(0, 16).replace('T', ' ')}</div>`;
    learningEl.innerHTML = html;
  }

  async function loadLearningStatus() {
    if (!learningEl) return;
    const token = ++learningToken;
    learningEl.innerHTML = '<div class="history-learning-loading">Chargement…</div>';
    try {
      const response = await fetch('/api/learning/status');
      const data = await response.json().catch(() => ({}));
      if (token !== learningToken) return;
      renderLearningStatus(data);
    } catch (_) {
      if (token === learningToken) learningEl.innerHTML = '<div class="history-learning-muted">Indisponible.</div>';
    }
  }

  // Secret admin (mode admin : /?admin=<secret> une fois) — les commandes learning
  // sont refusées côté serveur sans lui ; les boutons sont masqués pour le public.
  function adminSecretQS() {
    try { const s = localStorage.getItem('objfAdminSecret'); return s ? `?secret=${encodeURIComponent(s)}` : ''; } catch (_) { return ''; }
  }

  async function retrainLearning() {
    if (!learningEl) return;
    const token = ++learningToken;
    if (learningRetrainBtn) learningRetrainBtn.disabled = true;
    learningEl.innerHTML = progressHtml('Réentraînement en cours… (lecture des archives)');
    try {
      const response = await fetch(`/api/learning/retrain${adminSecretQS()}`, { method: 'POST' });
      const data = await response.json().catch(() => ({}));
      if (token === learningToken) renderLearningStatus(data.status || null);
    } catch (_) {
      if (token === learningToken) learningEl.innerHTML = '<div class="history-learning-muted">Réentraînement impossible.</div>';
    } finally {
      if (learningRetrainBtn) learningRetrainBtn.disabled = false;
    }
  }

  async function revertLearning() {
    if (!learningEl) return;
    const token = ++learningToken;
    if (learningRevertBtn) learningRevertBtn.disabled = true;
    try {
      const response = await fetch(`/api/learning/revert${adminSecretQS()}`, { method: 'POST' });
      const data = await response.json().catch(() => ({}));
      if (token === learningToken) renderLearningStatus(data.status || null);
    } catch (_) {
      /* ignore */
    } finally {
      if (learningRevertBtn) learningRevertBtn.disabled = false;
    }
  }

  // Collecte ASYNCHRONE : le POST lance un job serveur (le téléchargement MTG-LI prend
  // plusieurs minutes — un appel synchrone mourait en timeout derrière le proxy), puis
  // on suit /api/history/collect-status jusqu'au verdict. La collecte est de toute façon
  // AUTOMATIQUE côté serveur (jour courant ~2 h, journées écoulées ~6 h) — ce bouton ne
  // sert qu'à rafraîchir tout de suite.
  async function collectLightning(date) {
    if (!verifEl) return;
    const token = ++verifToken;
    verifEl.innerHTML = '<div class="history-verif-empty">Collecte de la foudre observée lancée… (satellite MTG-LI, ≈ 1-3 min)</div>';
    try {
      const response = await fetch(`/api/history/collect-lightning?date=${encodeURIComponent(date)}`, { method: 'POST' });
      const data = await response.json().catch(() => ({}));
      if (token !== verifToken || date !== historyDate) return;
      if (!data || !data.ok) {
        verifEl.innerHTML = `<div class="history-verif-empty">Collecte impossible : ${(data && data.reason) || 'erreur'}.</div>`;
        return;
      }
      for (let i = 0; i < 40; i += 1) {
        await new Promise((r) => window.setTimeout(r, 8000));
        if (token !== verifToken || date !== historyDate) return;
        let st = null;
        try { st = await (await fetch(`/api/history/collect-status?date=${encodeURIComponent(date)}`)).json(); } catch (_) {}
        if (!st || st.state === 'running') continue;
        if (st.state === 'done') {
          flashPointsDate = null; // forcer le rechargement des points
          ensureFlashPoints(date);
          loadVerification(date);
        } else {
          verifEl.innerHTML = `<div class="history-verif-empty">Collecte impossible : ${st.reason || 'erreur'}.</div>`;
        }
        return;
      }
      if (token === verifToken && date === historyDate) {
        verifEl.innerHTML = '<div class="history-verif-empty">Collecte toujours en cours côté serveur — revenez dans quelques minutes.</div>';
      }
    } catch (_) {
      if (token === verifToken) verifEl.innerHTML = '<div class="history-verif-empty">Collecte impossible.</div>';
    }
  }

  // --- Foudre observée : points + overlay SVG par heure ---
  async function ensureFlashPoints(date) {
    if (flashPointsDate === date) return;
    flashPointsDate = date;
    dayFlashPoints = [];
    const controller = new AbortController();
    const t = window.setTimeout(() => controller.abort(), 10000);
    try {
      const response = await fetch(`/api/history/lightning?date=${encodeURIComponent(date)}`, { signal: controller.signal });
      const data = await response.json().catch(() => ({}));
      if (flashPointsDate === date && data && data.ok && Array.isArray(data.points)) {
        dayFlashPoints = data.points;
        if (showFlashes && slotFrames.length) renderFlashHour(slotFrames[frameIndex].hour);
      }
    } catch (_) { /* timeout/abort : overlay vide */ }
    finally { window.clearTimeout(t); }
  }

  function renderFlashHour(hour) {
    if (!flashLayer) return;
    while (flashLayer.firstChild) flashLayer.removeChild(flashLayer.firstChild);
    if (!showFlashes || !dayFlashPoints.length || !projection) return;
    const r = VB / 360;
    for (const pt of dayFlashPoints) {
      if (pt[2] !== hour) continue;
      const p = projection.project(pt[1], pt[0]); // project(lon, lat), pt = [lat, lon]
      if (!p) continue;
      const halo = document.createElementNS(SVGNS, 'circle');
      halo.setAttribute('cx', p.x.toFixed(1)); halo.setAttribute('cy', p.y.toFixed(1));
      halo.setAttribute('r', (r * 2.2).toFixed(1)); halo.setAttribute('fill', 'rgba(255,255,255,0.28)');
      flashLayer.appendChild(halo);
      const core = document.createElementNS(SVGNS, 'circle');
      core.setAttribute('cx', p.x.toFixed(1)); core.setAttribute('cy', p.y.toFixed(1));
      core.setAttribute('r', r.toFixed(1)); core.setAttribute('fill', 'rgba(255,255,255,0.98)');
      flashLayer.appendChild(core);
    }
  }

  function updateFlashBtn() {
    if (!flashBtn) return;
    flashBtn.classList.toggle('active', showFlashes);
    flashBtn.setAttribute('aria-pressed', showFlashes ? 'true' : 'false');
  }

  // Export PNG de l'heure courante (France entière) : cellules (canvas) + par-dessus le
  // SVG (masque + frontières + foudre), recomposés à la résolution du viewBox.
  function downloadCurrent() {
    if (!frameEl || !slotFrames.length) return;
    const out = document.createElement('canvas');
    out.width = VB; out.height = VB;
    const ctx = out.getContext('2d');
    ctx.fillStyle = '#070f1c';
    ctx.fillRect(0, 0, VB, VB);
    if (cellCanvas) ctx.drawImage(cellCanvas, 0, 0, VB, VB); // cellules (remises à l'échelle VB)
    const clone = frameEl.cloneNode(true);
    clone.setAttribute('viewBox', `0 0 ${VB} ${VB}`);
    clone.setAttribute('width', String(VB));
    clone.setAttribute('height', String(VB));
    clone.style.background = 'transparent';
    const xml = new XMLSerializer().serializeToString(clone);
    const url = URL.createObjectURL(new Blob([xml], { type: 'image/svg+xml;charset=utf-8' }));
    const img = new Image();
    img.onload = () => {
      ctx.drawImage(img, 0, 0, VB, VB); // masque + frontières + foudre par-dessus
      URL.revokeObjectURL(url);
      const link = document.createElement('a');
      link.href = out.toDataURL('image/png');
      const h = String(slotFrames[frameIndex].hour).padStart(2, '0');
      link.download = `objectifoudre-historique-${historyDate || ''}-${h}h.png`;
      link.click();
    };
    img.onerror = () => URL.revokeObjectURL(url);
    img.src = url;
  }

  if (playBtn) playBtn.addEventListener('click', () => (playing ? pause() : play()));
  if (scrubber) scrubber.addEventListener('input', () => { pause(); showHour(Number(scrubber.value) || 0); });
  if (downloadBtn) downloadBtn.addEventListener('click', downloadCurrent);
  if (flashBtn) flashBtn.addEventListener('click', () => {
    showFlashes = !showFlashes;
    updateFlashBtn();
    if (slotFrames.length) renderFlashHour(slotFrames[frameIndex].hour);
  });

  // --- Zoom / pan via viewBox SVG (net à tout niveau) ---
  const vb = { x: 0, y: 0, w: VB, h: VB };

  function applyViewBox() {
    if (frameEl) frameEl.setAttribute('viewBox', `${vb.x.toFixed(2)} ${vb.y.toFixed(2)} ${vb.w.toFixed(2)} ${vb.h.toFixed(2)}`);
    redrawAllCells(); // les cellules (canvas) suivent le même zoom/pan que les frontières (SVG)
  }
  function resetZoom() {
    vb.x = 0; vb.y = 0; vb.w = VB; vb.h = VB;
    applyViewBox();
    if (frameEl) frameEl.style.cursor = '';
  }
  function clampVb() {
    vb.w = Math.min(VB, Math.max(VB / Z_MAX, vb.w));
    vb.h = vb.w;
    vb.x = Math.min(VB - vb.w, Math.max(0, vb.x));
    vb.y = Math.min(VB - vb.h, Math.max(0, vb.y));
  }
  function userAt(clientX, clientY) {
    try {
      const ctm = frameEl.getScreenCTM();
      if (ctm) {
        const pt = frameEl.createSVGPoint();
        pt.x = clientX; pt.y = clientY;
        const u = pt.matrixTransform(ctm.inverse());
        return { x: u.x, y: u.y, ax: ctm.a, ay: ctm.d };
      }
    } catch (_) { /* fallback */ }
    const r = frameEl.getBoundingClientRect();
    return { x: vb.x + ((clientX - r.left) / r.width) * vb.w, y: vb.y + ((clientY - r.top) / r.height) * vb.h, ax: r.width / vb.w, ay: r.height / vb.h };
  }
  function zoomAtClient(clientX, clientY, factor) {
    const u = userAt(clientX, clientY);
    const newW = Math.min(VB, Math.max(VB / Z_MAX, vb.w / factor));
    const k = newW / vb.w;
    vb.x = u.x - (u.x - vb.x) * k; // garde le point sous le curseur fixe
    vb.y = u.y - (u.y - vb.y) * k;
    vb.w = newW; vb.h = newW;
    clampVb();
    applyViewBox();
    if (frameEl) frameEl.style.cursor = vb.w < VB ? 'grab' : '';
  }

  if (frameEl) {
    frameEl.addEventListener('wheel', (event) => {
      event.preventDefault();
      zoomAtClient(event.clientX, event.clientY, event.deltaY < 0 ? 1.18 : 1 / 1.18);
    }, { passive: false });
    frameEl.addEventListener('dblclick', resetZoom);

    let dragging = false;
    let lastX = 0;
    let lastY = 0;
    frameEl.addEventListener('mousedown', (event) => {
      if (vb.w >= VB) return;
      dragging = true; lastX = event.clientX; lastY = event.clientY;
      frameEl.style.cursor = 'grabbing';
      event.preventDefault();
    });
    window.addEventListener('mousemove', (event) => {
      if (!dragging) return;
      const u = userAt(event.clientX, event.clientY);
      vb.x -= (event.clientX - lastX) / u.ax;
      vb.y -= (event.clientY - lastY) / u.ay;
      lastX = event.clientX; lastY = event.clientY;
      clampVb(); applyViewBox();
    });
    window.addEventListener('mouseup', () => {
      if (dragging) { dragging = false; frameEl.style.cursor = vb.w < VB ? 'grab' : ''; }
    });

    const touchDist = (t) => Math.hypot(t[0].clientX - t[1].clientX, t[0].clientY - t[1].clientY);
    let mode = null;
    let startDist = 0;
    let lastTouch = null;
    frameEl.addEventListener('touchstart', (event) => {
      if (event.touches.length === 2) {
        mode = 'pinch'; startDist = touchDist(event.touches);
      } else if (event.touches.length === 1 && vb.w < VB) {
        mode = 'pan'; lastTouch = { x: event.touches[0].clientX, y: event.touches[0].clientY };
      } else {
        mode = null;
      }
    }, { passive: false });
    frameEl.addEventListener('touchmove', (event) => {
      if (mode === 'pinch' && event.touches.length === 2) {
        event.preventDefault();
        const d = touchDist(event.touches);
        const factor = d / Math.max(1, startDist);
        startDist = d;
        const cx = (event.touches[0].clientX + event.touches[1].clientX) / 2;
        const cy = (event.touches[0].clientY + event.touches[1].clientY) / 2;
        zoomAtClient(cx, cy, factor);
      } else if (mode === 'pan' && event.touches.length === 1) {
        event.preventDefault();
        const t = event.touches[0];
        const u = userAt(t.clientX, t.clientY);
        vb.x -= (t.clientX - lastTouch.x) / u.ax;
        vb.y -= (t.clientY - lastTouch.y) / u.ay;
        lastTouch = { x: t.clientX, y: t.clientY };
        clampVb(); applyViewBox();
      }
    }, { passive: false });
    frameEl.addEventListener('touchend', (event) => { if (event.touches.length === 0) mode = null; });
  }

  // Boutons de pilotage du modèle : ADMIN uniquement (masqués pour le public,
  // et refusés côté serveur sans le secret de toute façon).
  const isAdminUI = document.documentElement.classList.contains('objf-admin');
  if (learningRetrainBtn) { learningRetrainBtn.hidden = !isAdminUI; learningRetrainBtn.addEventListener('click', retrainLearning); }
  if (learningRevertBtn) { learningRevertBtn.hidden = !isAdminUI; learningRevertBtn.addEventListener('click', revertLearning); }

  const calToggleBtn = document.getElementById('historyCalToggle');
  if (calToggleBtn) {
    calToggleBtn.addEventListener('click', () => {
      // Desktop : agenda FIXE — le repli est neutralisé (le chevron est masqué en
      // CSS et l'en-tête devient un simple titre). Seul le mobile/paysage replie.
      if (!isMobileHistory()) return;
      const panel = datesPanelEl();
      if (!panel) return;
      const collapsed = panel.classList.toggle('cal-collapsed');
      calToggleBtn.setAttribute('aria-expanded', collapsed ? 'false' : 'true');
    });
  }

  function openHistoryPage() {
    historyPage.setAttribute('aria-hidden', 'false');
    document.body.classList.add('history-open');
    // calendrier replié par défaut sur mobile (compact), déplié sur desktop.
    const panel = datesPanelEl();
    if (panel) {
      const collapsed = isMobileHistory();
      panel.classList.toggle('cal-collapsed', collapsed);
      if (calToggleBtn) calToggleBtn.setAttribute('aria-expanded', collapsed ? 'false' : 'true');
    }
    resetZoom();
    loadDates();
    loadLearningStatus();
  }

  function closeHistoryPage() {
    historyPage.setAttribute('aria-hidden', 'true');
    document.body.classList.remove('history-open');
    pause();
  }

  if (openBtn) openBtn.addEventListener('click', openHistoryPage);
  if (closeBtn) closeBtn.addEventListener('click', closeHistoryPage);
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && historyPage.getAttribute('aria-hidden') === 'false') closeHistoryPage();
  });

  window.openHistoryPage = openHistoryPage;
})();
