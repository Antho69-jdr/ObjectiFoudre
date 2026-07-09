// Tooltip applicatif : remplace les tooltips natifs (attribut `title`, laids et lents)
// par un tooltip flottant au même style que ceux des icônes de la frise.
// - Convertit tout `title` en `data-tooltip` puis supprime le `title` (tue le natif).
// - Affiche un seul élément flottant ancré au <body> (aucun clipping par les conteneurs).
// - Exclut les icônes de la frise, qui gardent leur tooltip CSS dédié (même apparence).
(function () {
  'use strict';

  function convertOne(el) {
    if (!el || el.nodeType !== 1 || !el.hasAttribute('title')) return;
    const t = el.getAttribute('title');
    if (t && !el.hasAttribute('data-tooltip')) el.setAttribute('data-tooltip', t);
    el.removeAttribute('title');
  }
  function convertTree(node) {
    if (!node || node.nodeType !== 1) return;
    convertOne(node);
    if (node.querySelectorAll) node.querySelectorAll('[title]').forEach(convertOne);
  }
  convertTree(document.documentElement);

  try {
    new MutationObserver((mutations) => {
      for (const m of mutations) {
        if (m.type === 'attributes') convertOne(m.target);
        else for (const n of m.addedNodes) convertTree(n);
      }
    }).observe(document.documentElement, {
      subtree: true, childList: true, attributes: true, attributeFilter: ['title'],
    });
  } catch (_) { /* MutationObserver indisponible : conversion initiale suffit */ }

  const tip = document.createElement('div');
  tip.className = 'app-tooltip';
  tip.setAttribute('role', 'tooltip');
  tip.hidden = true;
  function mount() { if (document.body && !tip.parentNode) document.body.appendChild(tip); }
  mount();
  document.addEventListener('DOMContentLoaded', mount);

  let currentEl = null;

  // Une pastille d'heure de la frise (roue mobile ou rail tablette/desktop).
  function isHourTarget(el) {
    return el.classList.contains('timeline-wheel-item') || el.classList.contains('timeline-hour-mark');
  }

  // Cible un porteur de data-tooltip, sauf les icônes de la frise (tooltip CSS dédié).
  function tooltipTarget(node) {
    if (!node || !node.closest) return null;
    const el = node.closest('[data-tooltip]');
    if (!el) return null;
    // Pastilles d'aide « ? » : clic UNIQUEMENT (pas de survol) → exclues du hover.
    if (el.classList.contains('app-help-dot')) return null;
    if (el.classList.contains('timeline-light-icon') || el.classList.contains('timeline-wheel-light-icon')) return null;
    // Sur tablette/mobile (≤1024px), pas de tooltip d'heure : il masque les info-bulles
    // des icônes jour/nuit de la frise (qu'on veut justement pouvoir lire).
    if (window.innerWidth <= 1024 && isHourTarget(el)) return null;
    return el;
  }

  function show(el) {
    const text = el.getAttribute('data-tooltip');
    if (!text) return;
    mount();
    currentEl = el;
    tip.textContent = text;
    tip.hidden = false;
    tip.style.opacity = '0';
    const r = el.getBoundingClientRect();
    const tw = tip.offsetWidth;
    const th = tip.offsetHeight;
    let left = r.left + r.width / 2 - tw / 2;
    left = Math.max(6, Math.min(left, window.innerWidth - tw - 6));
    let top = r.top - th - 8;            // au-dessus par défaut
    if (top < 6) top = r.bottom + 8;     // sinon en dessous (manque de place en haut)
    tip.style.left = Math.round(left) + 'px';
    tip.style.top = Math.round(top) + 'px';
    requestAnimationFrame(() => { if (currentEl === el) tip.style.opacity = '1'; });
  }

  // Tooltip « collant » (tap sur une icône jour/nuit de la roue mobile) : il résiste au
  // pointerout/focusout du tap et au recentrage automatique de la roue, et ne se ferme
  // qu'au tap suivant (ailleurs), à un vrai défilement plus tardif ou au blur.
  let stickyTooltip = false;
  let stickyShownAt = 0;

  function hide() {
    currentEl = null;
    stickyTooltip = false;
    tip.hidden = true;
    tip.style.opacity = '0';
  }

  document.addEventListener('pointerover', (e) => {
    const el = tooltipTarget(e.target);
    if (el && el !== currentEl) show(el);
  });
  document.addEventListener('pointerout', (e) => {
    if (!currentEl || stickyTooltip) return;
    if (!e.relatedTarget || !currentEl.contains(e.relatedTarget)) hide();
  });
  document.addEventListener('focusin', (e) => {
    const el = tooltipTarget(e.target);
    if (el) show(el);
  });
  document.addEventListener('focusout', () => { if (!stickyTooltip) hide(); });
  document.addEventListener('pointerdown', hide, true);
  window.addEventListener('scroll', () => {
    if (stickyTooltip && Date.now() - stickyShownAt < 900) return; // recentrage de la roue
    hide();
  }, true);
  window.addEventListener('blur', hide);

  // Icônes jour/nuit de la ROUE mobile : leur tooltip CSS est clippé par le scroller
  // (overflow-y hidden) → on affiche l'app-tooltip flottant (ancré au <body>, jamais
  // clippé) au tap. Le hide() en phase capture vient d'effacer l'ancien ; on ré-affiche
  // ensuite en mode collant.
  document.addEventListener('pointerdown', (e) => {
    const icon = e.target.closest && e.target.closest('.timeline-wheel-light-icon');
    if (!icon || !icon.getAttribute('data-tooltip')) return;
    show(icon);
    stickyTooltip = true;
    stickyShownAt = Date.now();
  });

  // --- Mode « révéler les info-bulles » (bouton ? tactile, tablette/mobile) ------
  // Affiche simultanément les info-bulles de tous les éléments [data-tooltip] visibles
  // à l'écran (sauf les icônes de frise, exclues). Bascule on/off ; se ferme dès qu'on
  // touche ailleurs, qu'on défile ou qu'on redimensionne.
  let revealed = [];
  function clearRevealed() {
    if (!revealed.length) return;
    revealed.forEach((el) => el.remove());
    revealed = [];
    const btn = document.getElementById('screenTooltipsBtn');
    if (btn) btn.setAttribute('aria-pressed', 'false');
    document.querySelectorAll('.app-help-dot[aria-pressed="true"]')
      .forEach((b) => b.setAttribute('aria-pressed', 'false'));
  }
  function revealAll() {
    clearRevealed();
    hide();
    const vw = window.innerWidth, vh = window.innerHeight;
    const M = 4;    // marge viewport
    const GAP = 8;  // écart bulle ↔ source

    // Part RÉELLEMENT visible d'un élément : son rect clippé par tous les
    // ancêtres à overflow non-visible (ex. le rail droit scrollable en mobile
    // paysage : les boutons sous le pli ne doivent pas révéler de bulle).
    function visibleRatio(el, r) {
      let left = r.left, top = r.top, right = r.right, bottom = r.bottom;
      let p = el.parentElement;
      while (p && p !== document.body) {
        const cs = getComputedStyle(p);
        if (/(auto|scroll|hidden|clip)/.test(cs.overflowX + cs.overflowY)) {
          const pr = p.getBoundingClientRect();
          left = Math.max(left, pr.left); top = Math.max(top, pr.top);
          right = Math.min(right, pr.right); bottom = Math.min(bottom, pr.bottom);
        }
        p = p.parentElement;
      }
      const area = Math.max(0, right - left) * Math.max(0, bottom - top);
      return area / Math.max(1, r.width * r.height);
    }

    // 1) Collecte des cibles visibles.
    const targets = [];
    document.querySelectorAll('[data-tooltip]').forEach((el) => {
      if (el.id === 'screenTooltipsBtn') return;
      if (el.classList.contains('timeline-light-icon') || el.classList.contains('timeline-wheel-light-icon')) return;
      if (isHourTarget(el)) return;  // pas de label par heure : encombrant et redondant
      const text = el.getAttribute('data-tooltip');
      if (!text) return;
      const r = el.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) return;                 // caché
      if (r.bottom <= 0 || r.top >= vh || r.right <= 0 || r.left >= vw) return; // hors écran
      if (visibleRatio(el, r) < 0.6) return;                       // rogné par un conteneur scrollable
      targets.push({ text, r });
    });

    // 2) Obstacles : une bulle ne doit couvrir NI un bouton source NI une autre
    //    bulle NI la frise (molette/rail des heures) NI le bouton « ? » lui-même
    //    (c'est lui qu'on re-tape pour fermer).
    const placed = targets.map(({ r }) => ({ left: r.left, top: r.top, right: r.right, bottom: r.bottom }));
    ['slotButtons', 'chaseSlots', 'screenTooltipsBtn'].forEach((id) => {
      const e = document.getElementById(id);
      if (!e) return;
      const r = e.getBoundingClientRect();
      if (r.width > 0 && r.height > 0) placed.push({ left: r.left, top: r.top, right: r.right, bottom: r.bottom });
    });
    const overlaps = (a, b) => !(a.right <= b.left || a.left >= b.right || a.bottom <= b.top || a.top >= b.bottom);
    const isFree = (rect) => rect.left >= M && rect.right <= vw - M && rect.top >= M && rect.bottom <= vh - M
      && !placed.some((p) => overlaps(rect, p));

    // Essaie une position. Latéral : strict (une bulle « sur le côté » reste
    // alignée à sa source, sinon candidat suivant). Dessus/dessous : glisse
    // horizontalement (±k pas) ET s'empile sur plusieurs rangées en s'éloignant
    // de la source (dir) — indispensable pour les zones denses (boutons de la
    // frise sur écran étroit : les libellés se rangent en 2-3 rangées).
    function probe(c, tw, th) {
      if (!c.slideX) {
        const rect = { left: c.left, top: c.top, right: c.left + tw, bottom: c.top + th };
        return isFree(rect) ? rect : null;
      }
      // Positions horizontales candidates : centrée sur la source, glissée par
      // pas de bulle, ET calées aux bords du viewport (indispensable pour les
      // bulles larges : le pas « une largeur de bulle » saute par-dessus la
      // seule fenêtre possible).
      const xs = [c.left];
      for (let k = 1; k <= 6; k++) { xs.push(c.left + k * (tw + 4), c.left - k * (tw + 4)); }
      xs.push(M, vw - tw - M);
      for (let row = 0; row <= 4; row++) {
        const top = c.top + c.dir * row * (th + 4);
        for (const left of xs) {
          const rect = { left, top, right: left + tw, bottom: top + th };
          if (isFree(rect)) return rect;
        }
      }
      return null;
    }

    // 3) Créer + mesurer toutes les bulles, puis placer les plus LARGES d'abord
    //    (elles ont le moins d'options ; les petites se logent ensuite sans
    //    fallback). Les éléments COLLÉS à un bord latéral (rails) ont leur bulle
    //    SUR LE CÔTÉ (vers le centre de l'écran), alignée à leur hauteur ; les
    //    autres au-dessus/en-dessous, décalées/empilées si voisines.
    const entries = targets.map(({ text, r }) => {
      const lbl = document.createElement('div');
      lbl.className = 'app-tooltip app-tooltip-revealed';
      lbl.setAttribute('role', 'tooltip');
      lbl.textContent = text;
      lbl.hidden = false;
      document.body.appendChild(lbl);
      let tw = lbl.offsetWidth, th = lbl.offsetHeight;
      // Libellé trop large pour l'écran (ex. « Aujourd'hui est le jour le plus
      // ancien (…) ») : passer en multi-ligne compacte, sinon aucune position
      // n'est possible et le fallback recouvre tout.
      if (tw > vw * 0.7) {
        lbl.classList.add('app-tooltip-help');
        tw = lbl.offsetWidth; th = lbl.offsetHeight;
      }
      return { lbl, tw, th, r };
    });
    entries.sort((a, b) => b.tw - a.tw);
    for (const { lbl, tw, th, r } of entries) {
      const cx = r.left + r.width / 2 - tw / 2;   // centré horizontalement
      const cy = r.top + r.height / 2 - th / 2;   // centré verticalement
      const sideRight = { left: r.right + GAP, top: cy, slideX: false };
      const sideLeft = { left: r.left - tw - GAP, top: cy, slideX: false };
      const above = { left: cx, top: r.top - th - GAP, slideX: true, dir: -1 };
      const below = { left: cx, top: r.bottom + GAP, slideX: true, dir: 1 };
      const nearEdge = Math.min(r.left, vw - r.right) <= 60;
      const sides = (vw - r.right) >= r.left ? [sideRight, sideLeft] : [sideLeft, sideRight];
      const candidates = nearEdge
        ? [sides[0], above, below, sides[1]]
        : [above, below, sides[0], sides[1]];
      let rect = null;
      for (const c of candidates) { rect = probe(c, tw, th); if (rect) break; }
      if (!rect) {
        // Dernier recours (zone saturée) : au-dessus, clampé au viewport.
        const l = Math.max(M, Math.min(cx, vw - tw - M));
        let t = r.top - th - 6; if (t < M) t = r.bottom + 6;
        t = Math.max(M, Math.min(t, vh - th - M));
        rect = { left: l, top: t, right: l + tw, bottom: t + th };
      }
      placed.push(rect);
      lbl.style.left = Math.round(rect.left) + 'px';
      lbl.style.top = Math.round(rect.top) + 'px';
      lbl.style.opacity = '1';
      revealed.push(lbl);
    }
    const btn = document.getElementById('screenTooltipsBtn');
    if (btn) btn.setAttribute('aria-pressed', revealed.length ? 'true' : 'false');
  }
  // Bouton (délégation : robuste quel que soit l'ordre de chargement).
  document.addEventListener('click', (e) => {
    const btn = e.target.closest && e.target.closest('#screenTooltipsBtn');
    if (!btn) return;
    e.preventDefault();
    e.stopPropagation();
    if (revealed.length) clearRevealed(); else revealAll();
  });
  // --- Pastille d'aide « ? » ponctuelle (.app-help-dot, ex. auto-calibration) --
  // Clic/tap = toggle de SA propre info-bulle (même rendu flottant que « révéler »,
  // ancré au <body>, jamais clippé). Utile au tactile (le survol ne suffit pas).
  function revealOne(el) {
    clearRevealed();
    hide();
    const text = el.getAttribute('data-tooltip');
    if (!text) return;
    const vw = window.innerWidth, vh = window.innerHeight;
    const r = el.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) return;
    const lbl = document.createElement('div');
    lbl.className = 'app-tooltip app-tooltip-revealed app-tooltip-help';
    lbl.setAttribute('role', 'tooltip');
    lbl.textContent = text;
    lbl.hidden = false;
    document.body.appendChild(lbl);
    const tw = lbl.offsetWidth, th = lbl.offsetHeight;
    const left = Math.max(4, Math.min(r.left + r.width / 2 - tw / 2, vw - tw - 4));
    let top = r.bottom + 8;                       // EN DESSOUS par défaut
    if (top + th > vh - 4) top = r.top - th - 8;  // au-dessus si pas de place
    top = Math.max(4, Math.min(top, vh - th - 4));
    lbl.style.left = Math.round(left) + 'px';
    lbl.style.top = Math.round(top) + 'px';
    lbl.style.opacity = '1';
    revealed.push(lbl);
    el.setAttribute('aria-pressed', 'true');
  }
  document.addEventListener('click', (e) => {
    const btn = e.target.closest && e.target.closest('.app-help-dot');
    if (!btn) return;
    e.preventDefault();
    e.stopPropagation();
    if (revealed.length) clearRevealed(); else revealOne(btn);
  });

  // Fermer en touchant ailleurs / au défilement / au redimensionnement.
  document.addEventListener('pointerdown', (e) => {
    if (!revealed.length) return;
    if (e.target.closest && (e.target.closest('#screenTooltipsBtn') || e.target.closest('.app-help-dot'))) return;
    clearRevealed();
  }, true);
  window.addEventListener('scroll', clearRevealed, true);
  window.addEventListener('resize', clearRevealed);
})();
