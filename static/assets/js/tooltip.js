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

  function hide() {
    currentEl = null;
    tip.hidden = true;
    tip.style.opacity = '0';
  }

  document.addEventListener('pointerover', (e) => {
    const el = tooltipTarget(e.target);
    if (el && el !== currentEl) show(el);
  });
  document.addEventListener('pointerout', (e) => {
    if (!currentEl) return;
    if (!e.relatedTarget || !currentEl.contains(e.relatedTarget)) hide();
  });
  document.addEventListener('focusin', (e) => {
    const el = tooltipTarget(e.target);
    if (el) show(el);
  });
  document.addEventListener('focusout', hide);
  document.addEventListener('pointerdown', hide, true);
  window.addEventListener('scroll', hide, true);
  window.addEventListener('blur', hide);

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
  }
  function revealAll() {
    clearRevealed();
    hide();
    const vw = window.innerWidth, vh = window.innerHeight;
    document.querySelectorAll('[data-tooltip]').forEach((el) => {
      if (el.id === 'screenTooltipsBtn') return;
      if (el.classList.contains('timeline-light-icon') || el.classList.contains('timeline-wheel-light-icon')) return;
      if (isHourTarget(el)) return;  // pas de label par heure : encombrant et redondant
      const text = el.getAttribute('data-tooltip');
      if (!text) return;
      const r = el.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) return;                 // caché
      if (r.bottom <= 0 || r.top >= vh || r.right <= 0 || r.left >= vw) return; // hors écran
      const lbl = document.createElement('div');
      lbl.className = 'app-tooltip app-tooltip-revealed';
      lbl.setAttribute('role', 'tooltip');
      lbl.textContent = text;
      lbl.hidden = false;
      document.body.appendChild(lbl);
      const tw = lbl.offsetWidth, th = lbl.offsetHeight;
      const left = Math.max(4, Math.min(r.left + r.width / 2 - tw / 2, vw - tw - 4));
      let top = r.top - th - 6;
      if (top < 4) top = r.bottom + 6;
      top = Math.max(4, Math.min(top, vh - th - 4));
      lbl.style.left = Math.round(left) + 'px';
      lbl.style.top = Math.round(top) + 'px';
      lbl.style.opacity = '1';
      revealed.push(lbl);
    });
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
  // Fermer en touchant ailleurs / au défilement / au redimensionnement.
  document.addEventListener('pointerdown', (e) => {
    if (!revealed.length) return;
    if (e.target.closest && e.target.closest('#screenTooltipsBtn')) return;
    clearRevealed();
  }, true);
  window.addEventListener('scroll', clearRevealed, true);
  window.addEventListener('resize', clearRevealed);
})();
