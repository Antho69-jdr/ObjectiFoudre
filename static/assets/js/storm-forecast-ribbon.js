// storm-forecast-ribbon.js — Frise 3 « ruban chronologique à curseur glissant »
// (parti retenu par Anthony). Remplace la bande de dates + les onglets de période
// par un seul ruban : chaque jour = une colonne ; J0→J+3 (horaire/ECMWF) = 3 sous-
// créneaux Matin/Après-midi/Soir ; J+4→J+10 (tendance ECMWF) = un seul « jour ».
// Le curseur (poignée ambre + bec, PAS de ligne sur le texte) s'aimante au créneau
// le plus proche ; glissé souris + tactile (Pointer Events) + clavier.
//
// Pilote la MÊME sélection que l'ancien UI : (predictionSelectedDate,
// selectedPredictionPeriodKey) → renderActivePrediction(). Script classique chargé
// après storm-forecast-page.js ; toutes ses dépendances sont des globals déjà définis.

const PREDICTION_RIBBON_SUBS = [
  { key: 'morning', ab: 'M', label: 'Matin' },
  { key: 'afternoon', ab: 'A', label: 'Après-midi' },
  { key: 'evening', ab: 'S', label: 'Soir' },
];

let predictionRibbonStops = [];   // [{ dateIso, periodKey, kind, el, dayEl }]
let predictionRibbonEls = null;   // { root, wrap, ribbon, cursor, grip }
let predictionRibbonActive = -1;
let predictionRibbonRO = null;
let predictionRibbonCenters = [];
let predictionRibbonDragging = false;
let predictionRibbonMode = 'journee';   // 'journee' (1 case/jour, 08-08) | 'detail' (M/A/S sur J0→J+3)
let predictionRibbonModeBtn = null;
let predictionRibbonWired = false;       // listeners pointeur du ruban attachés une seule fois

function predictionRibbonKind(dateIso) {
  if (typeof predictionDateIsTrend === 'function' && predictionDateIsTrend(dateIso)) return 'trend';
  if (typeof predictionDateUsesEcmwf === 'function' && predictionDateUsesEcmwf(dateIso)) return 'ecmwf';
  return 'hourly';
}

function predictionRibbonReduce() {
  return typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
}

function buildPredictionRibbon() {
  const root = document.getElementById('predictionRibbon');
  if (!root) return;
  predictionRibbonMode = 'journee';        // ouverture = vue d'ensemble (journée 08-08)
  predictionRibbonWired = false;
  root.innerHTML = '';

  // Rangée [bouton bascule][ruban] ; la barre de défilement occupe la largeur dessous.
  const rowEl = document.createElement('div');
  rowEl.className = 'pr-row';
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'pr-modebtn';
  btn.addEventListener('click', togglePredictionRibbonMode);
  rowEl.appendChild(btn);
  predictionRibbonModeBtn = btn;

  const wrap = document.createElement('div');
  wrap.className = 'pribbon-wrap';
  const ribbon = document.createElement('div');
  ribbon.className = 'pribbon';
  ribbon.tabIndex = -1;
  wrap.appendChild(ribbon);
  rowEl.appendChild(wrap);
  root.appendChild(rowEl);

  // Barre de défilement horizontale (surtout mobile portrait) : le ruban dépasse la
  // largeur d'écran et le swipe horizontal est capté par le curseur → J+6→J+10 seraient
  // inaccessibles. Ce pouce glissable pilote wrap.scrollLeft. Masqué s'il n'y a pas de
  // débordement (desktop / paysage).
  const scroll = document.createElement('div');
  scroll.className = 'pr-scroll';
  scroll.innerHTML = '<div class="pr-scroll-thumb" role="scrollbar" aria-label="Faire défiler la frise" aria-orientation="horizontal" tabindex="0"></div>';
  root.appendChild(scroll);

  predictionRibbonEls = {
    root, row: rowEl, wrap, ribbon,
    scroll, thumb: scroll.querySelector('.pr-scroll-thumb'),
    cursor: null, grip: null,
  };

  wrap.addEventListener('scroll', () => {
    positionPredictionCursor(predictionRibbonActive, false);
    updatePredictionScrollbar();
  }, { passive: true });
  if (predictionRibbonRO) predictionRibbonRO.disconnect();
  if (typeof ResizeObserver === 'function') {
    predictionRibbonRO = new ResizeObserver(() => {
      measurePredictionRibbon();
      positionPredictionCursor(predictionRibbonActive, false);
    });
    predictionRibbonRO.observe(root);       // suit les changements de largeur (viewport)
  }
  wirePredictionRibbonPointer();            // listeners pointeur sur le ruban : une seule fois
  wirePredictionScrollbar();                // pouce recréé à chaque build → listeners neufs
  populatePredictionRibbon();
}

// Pouce de défilement horizontal : drag → wrap.scrollLeft. Clic sur la piste = saut.
function wirePredictionScrollbar() {
  const els = predictionRibbonEls;
  if (!els || !els.thumb || !els.scroll || !els.wrap) return;
  const { wrap, scroll, thumb } = els;
  const maxScroll = () => Math.max(0, wrap.scrollWidth - wrap.clientWidth);
  const trackRange = () => Math.max(1, scroll.clientWidth - thumb.offsetWidth);
  let dragging = false, startX = 0, startScroll = 0;

  thumb.addEventListener('pointerdown', (e) => {
    dragging = true; startX = e.clientX; startScroll = wrap.scrollLeft;
    if (thumb.setPointerCapture) { try { thumb.setPointerCapture(e.pointerId); } catch (_) {} }
    e.preventDefault(); e.stopPropagation();
  });
  thumb.addEventListener('pointermove', (e) => {
    if (!dragging) return;
    const ratio = maxScroll() / trackRange();
    wrap.scrollLeft = startScroll + (e.clientX - startX) * ratio;
    e.preventDefault();
  });
  const end = () => { dragging = false; };
  thumb.addEventListener('pointerup', end);
  thumb.addEventListener('pointercancel', end);

  scroll.addEventListener('pointerdown', (e) => {
    if (e.target === thumb) return;
    const rect = scroll.getBoundingClientRect();
    const x = e.clientX - rect.left - thumb.offsetWidth / 2;
    wrap.scrollLeft = (x / trackRange()) * maxScroll();
  });
  thumb.addEventListener('keydown', (e) => {
    const step = wrap.clientWidth * 0.6;
    if (e.key === 'ArrowLeft') { wrap.scrollLeft -= step; e.preventDefault(); }
    else if (e.key === 'ArrowRight') { wrap.scrollLeft += step; e.preventDefault(); }
    else if (e.key === 'Home') { wrap.scrollLeft = 0; e.preventDefault(); }
    else if (e.key === 'End') { wrap.scrollLeft = maxScroll(); e.preventDefault(); }
  });
}

// Dimensionne/positionne le pouce et affiche la barre uniquement s'il y a débordement.
function updatePredictionScrollbar() {
  const els = predictionRibbonEls;
  if (!els || !els.wrap || !els.scroll || !els.thumb) return;
  const wrap = els.wrap;
  const overflow = wrap.scrollWidth - wrap.clientWidth;
  if (overflow <= 2) { els.root.classList.remove('has-scroll'); return; }
  els.root.classList.add('has-scroll');
  const trackW = els.scroll.clientWidth || wrap.clientWidth;
  const thumbW = Math.max(28, Math.round((wrap.clientWidth / wrap.scrollWidth) * trackW));
  els.thumb.style.width = thumbW + 'px';
  const left = Math.round((wrap.scrollLeft / overflow) * (trackW - thumbW));
  els.thumb.style.transform = 'translateX(' + left + 'px)';
}

// (Re)construit les colonnes-jours + le curseur selon le mode courant. Le ruban et ses
// listeners pointeur persistent (attachés une fois) ; seul son contenu est régénéré.
function populatePredictionRibbon() {
  if (!predictionRibbonEls) return;
  const ribbon = predictionRibbonEls.ribbon;
  ribbon.innerHTML = '';
  predictionRibbonStops = [];

  const dates = (typeof predictionSelectableDates === 'function') ? predictionSelectableDates() : [];
  dates.forEach((iso) => {
    const kind = predictionRibbonKind(iso);
    const offset = (typeof predictionDateOffset === 'function') ? predictionDateOffset(iso) : 0;
    const day = document.createElement('div');
    day.className = 'pr-day pr-' + kind + (offset === 0 ? ' pr-now' : '');
    if (typeof formatShortDateLabel === 'function') day.title = formatShortDateLabel(iso);

    const top = document.createElement('div');
    top.className = 'pr-top';
    top.textContent = (typeof predictionDateChipLabel === 'function') ? predictionDateChipLabel(iso) : iso;

    const cells = document.createElement('div');
    cells.className = 'pr-cells';
    const startIdx = predictionRibbonStops.length;
    // Mode « journée » (ou jour de tendance) = une seule case 08-08 ; mode « détail » =
    // Matin/Après-midi/Soir sur les jours horaires/ECMWF.
    if (predictionRibbonMode === 'journee' || kind === 'trend') {
      cells.appendChild(predictionRibbonCell(iso, 'day', kind, ''));
    } else {
      PREDICTION_RIBBON_SUBS.forEach((s) => cells.appendChild(predictionRibbonCell(iso, s.key, kind, s.ab)));
    }
    for (let i = startIdx; i < predictionRibbonStops.length; i += 1) predictionRibbonStops[i].dayEl = day;

    day.appendChild(top);
    day.appendChild(cells);
    ribbon.appendChild(day);
  });

  const cursor = document.createElement('div');
  cursor.className = 'pr-cursor';
  cursor.innerHTML = '<span class="pr-beak"></span>'
    + '<span class="pr-grip" tabindex="0" role="slider" aria-label="Créneau de prévision" '
    + 'aria-valuemin="0" aria-valuemax="' + Math.max(0, predictionRibbonStops.length - 1) + '"></span>';
  ribbon.appendChild(cursor);
  predictionRibbonEls.cursor = cursor;
  predictionRibbonEls.grip = cursor.querySelector('.pr-grip');
  wirePredictionRibbonGrip();               // le grip est recréé à chaque populate

  updatePredictionRibbonModeBtn();
  requestAnimationFrame(() => { measurePredictionRibbon(); updatePredictionRibbon(); });
}

function updatePredictionRibbonModeBtn() {
  if (!predictionRibbonModeBtn) return;
  const detail = predictionRibbonMode === 'detail';
  predictionRibbonModeBtn.textContent = detail ? 'Journée' : 'Détail';
  predictionRibbonModeBtn.title = detail
    ? 'Revenir à la vue journée entière (08-08)'
    : 'Voir le détail matin / après-midi / soir';
  predictionRibbonModeBtn.setAttribute('aria-pressed', detail ? 'true' : 'false');
  predictionRibbonModeBtn.classList.toggle('is-detail', detail);
}

// Bascule le mode + adapte la période sélectionnée au nouveau mode, puis re-rend.
function togglePredictionRibbonMode() {
  predictionRibbonMode = (predictionRibbonMode === 'journee') ? 'detail' : 'journee';
  const iso = predictionSelectedDate;
  const isTrend = (typeof predictionDateIsTrend === 'function') && predictionDateIsTrend(iso);
  const pk = (predictionRibbonMode === 'journee' || isTrend)
    ? 'day'
    : (selectedPredictionPeriodKey && selectedPredictionPeriodKey !== 'day' ? selectedPredictionPeriodKey : 'afternoon');
  populatePredictionRibbon();
  selectPredictionSlot(iso, pk);   // no-op si (iso,pk) inchangé (mode journée↔trend)
  updatePredictionRibbon();
}

function predictionRibbonCell(dateIso, periodKey, kind, label) {
  const c = document.createElement('button');
  c.type = 'button';
  c.className = 'pr-cell' + (kind === 'ecmwf' ? ' pr-ecmwf' : '') + (kind === 'trend' ? ' pr-trendcell' : '');
  c.textContent = label;
  c.dataset.i = predictionRibbonStops.length;
  predictionRibbonStops.push({ dateIso, periodKey, kind, el: c, dayEl: null });
  return c;
}

function measurePredictionRibbon() {
  if (!predictionRibbonEls) return;
  const rb = predictionRibbonEls.ribbon.getBoundingClientRect();
  predictionRibbonCenters = predictionRibbonStops.map((s) => {
    const r = s.el.getBoundingClientRect();
    return r.left - rb.left + r.width / 2;
  });
  updatePredictionScrollbar();
}

function positionPredictionCursor(i, animate) {
  if (!predictionRibbonEls || i < 0 || !predictionRibbonCenters.length) return;
  const cursor = predictionRibbonEls.cursor;
  cursor.classList.toggle('pr-animate', !!animate && !predictionRibbonReduce());
  cursor.style.left = predictionRibbonCenters[i] + 'px';
}

// Applique l'état visuel (surbrillance case, position curseur, aria) SANS déclencher
// de sélection — utilisé par la voie ruban (après selection) ET la voie externe.
function renderPredictionRibbonVisual(i, animate) {
  if (!predictionRibbonEls || i < 0) return;
  predictionRibbonStops.forEach((s, idx) => s.el.classList.toggle('on', idx === i));
  predictionRibbonStops.forEach((s) => s.dayEl && s.dayEl.classList.remove('pr-some-on'));
  const s = predictionRibbonStops[i];
  if (s && s.dayEl) s.dayEl.classList.add('pr-some-on');
  positionPredictionCursor(i, animate);
  const grip = predictionRibbonEls.grip;
  if (grip) {
    grip.setAttribute('aria-valuenow', i);
    const sub = PREDICTION_RIBBON_SUBS.find((p) => p.key === s.periodKey);
    const jx = (typeof predictionDateChipLabel === 'function') ? predictionDateChipLabel(s.dateIso) : s.dateIso;
    grip.setAttribute('aria-valuetext', jx + ' · ' + (sub ? sub.label : 'Journée'));
  }
}

// Voie RUBAN : l'utilisateur clique / glisse / tape sur un créneau.
function setPredictionRibbonStop(i, animate) {
  i = Math.max(0, Math.min(predictionRibbonStops.length - 1, i));
  if (i < 0) return;
  const changed = i !== predictionRibbonActive;
  predictionRibbonActive = i;
  renderPredictionRibbonVisual(i, animate);
  if (changed) {
    const s = predictionRibbonStops[i];
    selectPredictionSlot(s.dateIso, s.periodKey);   // fire-and-forget (rend en async)
  }
}

// Voie EXTERNE : la sélection a changé ailleurs (ouverture, etc.) → resynchronise
// le ruban sans re-déclencher de rendu.
function updatePredictionRibbon() {
  if (!predictionRibbonEls || !predictionRibbonStops.length) return;
  const iso = (typeof predictionSelectedDate !== 'undefined') ? predictionSelectedDate : null;
  const pk = (typeof selectedPredictionPeriodKey !== 'undefined') ? selectedPredictionPeriodKey : 'day';
  let idx = predictionRibbonStops.findIndex((s) => s.dateIso === iso && s.periodKey === pk);
  if (idx < 0) idx = predictionRibbonStops.findIndex((s) => s.dateIso === iso);   // 'day' sur jour horaire → 1re sous-case
  if (idx < 0) return;
  predictionRibbonActive = idx;
  renderPredictionRibbonVisual(idx, true);
}

// Applique (date, période) et rend une seule fois. Trend → forcé « jour ».
async function selectPredictionSlot(dateIso, periodKey) {
  const iso = (typeof normalizeDateIso === 'function') ? normalizeDateIso(dateIso) : dateIso;
  const isTrend = (typeof predictionDateIsTrend === 'function') && predictionDateIsTrend(iso);
  const pk = isTrend ? 'day' : (periodKey || 'day');
  if (iso === predictionSelectedDate && pk === selectedPredictionPeriodKey) return;
  predictionSelectedDate = iso;
  selectedPredictionPeriodKey = pk;
  if (typeof renderActivePrediction === 'function') await renderActivePrediction();
}

function predictionRibbonNearest(clientX) {
  if (!predictionRibbonEls || !predictionRibbonCenters.length) return 0;
  const rb = predictionRibbonEls.ribbon.getBoundingClientRect();
  const x = clientX - rb.left;
  let best = 0, bd = Infinity;
  for (let i = 0; i < predictionRibbonCenters.length; i += 1) {
    const d = Math.abs(predictionRibbonCenters[i] - x);
    if (d < bd) { bd = d; best = i; }
  }
  return best;
}

function wirePredictionRibbonPointer() {
  if (predictionRibbonWired || !predictionRibbonEls) return;
  predictionRibbonWired = true;
  const ribbon = predictionRibbonEls.ribbon;

  const down = (e) => {
    predictionRibbonDragging = true;
    if (ribbon.setPointerCapture) { try { ribbon.setPointerCapture(e.pointerId); } catch (_) {} }
    setPredictionRibbonStop(predictionRibbonNearest(e.clientX), true);
    e.preventDefault();
  };
  const move = (e) => {
    if (!predictionRibbonDragging) return;
    setPredictionRibbonStop(predictionRibbonNearest(e.clientX), false);
    e.preventDefault();
  };
  const up = () => {
    if (predictionRibbonDragging) {
      predictionRibbonDragging = false;
      positionPredictionCursor(predictionRibbonActive, true);
    }
  };
  ribbon.addEventListener('pointerdown', down);
  ribbon.addEventListener('pointermove', move);
  ribbon.addEventListener('pointerup', up);
  ribbon.addEventListener('pointercancel', up);

  // survol léger (souris)
  ribbon.addEventListener('pointermove', (e) => {
    if (predictionRibbonDragging) return;
    const n = predictionRibbonNearest(e.clientX);
    predictionRibbonStops.forEach((s, i) => s.el.classList.toggle('pr-hover', i === n && i !== predictionRibbonActive));
  });
  ribbon.addEventListener('pointerleave', () => predictionRibbonStops.forEach((s) => s.el.classList.remove('pr-hover')));
}

function wirePredictionRibbonGrip() {
  const grip = predictionRibbonEls && predictionRibbonEls.grip;
  if (!grip) return;
  grip.addEventListener('keydown', (e) => {
    let handled = true;
    if (e.key === 'ArrowLeft') setPredictionRibbonStop(predictionRibbonActive - 1, true);
    else if (e.key === 'ArrowRight') setPredictionRibbonStop(predictionRibbonActive + 1, true);
    else if (e.key === 'Home') setPredictionRibbonStop(0, true);
    else if (e.key === 'End') setPredictionRibbonStop(predictionRibbonStops.length - 1, true);
    else handled = false;
    if (handled) e.preventDefault();
  });
}
