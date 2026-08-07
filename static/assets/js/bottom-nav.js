/* bottom-nav.js — Barre de navigation du BAS (refonte mobile, Phase 1).
   Remplace le rail droit sur petit écran. PILOTÉE PAR CONFIG (BOTTOM_NAV) :
   changer/réordonner une destination = éditer le tableau ci-dessous. Chaque
   entrée DÉLÈGUE au bouton existant du rail (.click()) ou à un toggle global —
   aucune logique de mode réécrite. Onglet « Plus » → feuille des destinations
   secondaires. Avatar compte injecté en haut à droite (ouvre la modale compte).
   L'affichage (≤767px) + le masquage du rail sont gérés en CSS (bottom-nav.css). */
(function () {
  'use strict';

  var IC = {
    map:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 4L3 6.5v13L9 17l6 2.5 6-2.5v-13L15 6.5 9 4z"/><path d="M9 4v13M15 6.5v13"/></svg>',
    radar:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="4.5"/><path d="M12 12l7-3.4"/><circle cx="12" cy="12" r="1" fill="currentColor" stroke="none"/></svg>',
    star:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3l2.4 5 5.6.5-4.2 3.7 1.3 5.5L12 16.9l-5.1 3.1 1.3-5.5L4 8.5 9.6 8z"/></svg>',
    chat:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 11.5a8.4 8.4 0 0 1-8.5 8.5 8.6 8.6 0 0 1-3.8-.9L3 21l1.9-5.7A8.4 8.4 0 0 1 4 11.5 8.5 8.5 0 0 1 12.5 3 8.4 8.4 0 0 1 21 11.5z"/><path d="M8.5 12h.01M12 12h.01M15.5 12h.01"/></svg>',
    plus:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3.5" y="3.5" width="7" height="7" rx="1.6"/><rect x="13.5" y="3.5" width="7" height="7" rx="1.6"/><rect x="3.5" y="13.5" width="7" height="7" rx="1.6"/><rect x="13.5" y="13.5" width="7" height="7" rx="1.6"/></svg>',
    user:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="8" r="4"/><path d="M4 20.5c1.5-3.5 4.6-5 8-5s6.5 1.5 8 5"/></svg>',
    prev:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 16.5l4.5-5 3.5 2.6L16 7"/><path d="M13 7h3v3"/><path d="M3 21h18"/></svg>',
    pin:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 21s7-6.5 7-11a7 7 0 1 0-14 0c0 4.5 7 11 7 11z"/><circle cx="12" cy="10" r="2.6"/></svg>',
    clock:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M12 7.5V12l3.2 1.9"/></svg>',
    help:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M9.6 9.5a2.5 2.5 0 1 1 3.5 2.3c-.8.4-1.1.9-1.1 1.7"/><path d="M12 17h.01"/></svg>',
    sliders:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 7h16M4 17h16"/><circle cx="9" cy="7" r="2.5" fill="currentColor" stroke="none"/><circle cx="15" cy="17" r="2.5" fill="currentColor" stroke="none"/></svg>',
    gear:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19 12a7 7 0 0 0-.1-1l2-1.5-2-3.4-2.3 1a7 7 0 0 0-1.7-1l-.3-2.5H10.4l-.3 2.5a7 7 0 0 0-1.7 1l-2.3-1-2 3.4L6 11a7 7 0 0 0 0 2l-2 1.5 2 3.4 2.3-1a7 7 0 0 0 1.7 1l.3 2.5h3.2l.3-2.5a7 7 0 0 0 1.7-1l2.3 1 2-3.4-2-1.5a7 7 0 0 0 .1-1z"/></svg>',
    chev:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 6l6 6-6 6"/></svg>'
  };

  function el(id) { return document.getElementById(id); }
  function clickEl(id) { var e = el(id); if (e) e.click(); }
  function hasBody(c) { return document.body.classList.contains(c); }
  function inChase() { return hasBody('chase-mode'); }
  function inStar() { return hasBody('stargaze-mode'); }
  function forumOpen() { var p = el('forumPage'); return !!p && p.getAttribute('aria-hidden') === 'false'; }
  function isAdmin() { try { return document.documentElement.classList.contains('objf-admin'); } catch (e) { return false; } }

  // --- actions modes (délèguent aux toggles globaux / boutons du rail) ---
  function goCarte() {
    if (inChase() && window.toggleChaseMode) window.toggleChaseMode();
    if (inStar() && window.toggleStargazeMode) window.toggleStargazeMode();
  }
  function goRadar() {
    if (inChase()) return;
    if (inStar() && window.toggleStargazeMode) window.toggleStargazeMode();
    if (window.toggleChaseMode) window.toggleChaseMode(); else clickEl('chasePageBtn');
  }
  function goEtoiles() {
    if (inStar()) return;               // stargaze.activate() sort déjà du mode chasse
    if (window.toggleStargazeMode) window.toggleStargazeMode(); else clickEl('stargazePageBtn');
  }

  // ===== CONFIG : la barre du bas (Parti D). Change ici, c'est tout. =====
  var BOTTOM_NAV = [
    { id: 'carte',   label: 'Carte',   icon: 'map',   go: goCarte },
    { id: 'radar',   label: 'Radar',   icon: 'radar', go: goRadar },
    { id: 'etoiles', label: 'Étoiles', icon: 'star',  go: goEtoiles },
    { id: 'forum',   label: 'Forum',   icon: 'chat',  go: function () { clickEl('forumPageBtn'); } },
    { id: 'plus',    label: 'Plus',    icon: 'plus',  go: function () { togglePlus(); } }
  ];

  // ===== CONFIG : la feuille « Plus » (destinations secondaires) =====
  var PLUS_ITEMS = [
    { id: 'prev',  label: 'Prévisions orageuses',  icon: 'prev',    go: function () { clickEl('predictionPageBtn'); } },
    { id: 'spots', label: 'Mes spots',             icon: 'pin',     go: function () { clickEl('spotsPageBtn'); } },
    { id: 'histo', label: 'Historique',            icon: 'clock',   go: function () { clickEl('historyPageBtn'); } },
    { id: 'aide',  label: 'Aide & guide',          icon: 'help',    go: function () { clickEl('infoDrawerBtn'); } },
    { id: 'compte',label: 'Mon compte',            icon: 'user',    go: function () { clickEl('accountBtn'); } },
    { id: 'perso', label: 'Personnaliser la barre',icon: 'sliders', soon: true, go: function () { toast('Bientôt — personnalisation de la barre'); } },
    { id: 'admin', label: 'Télémétrie & maintenance', icon: 'gear', admin: true, go: function () { clickEl('maintenancePageBtn'); } }
  ];

  // --- DOM ---
  var bar, sheet, scrim, avatar, toastEl;

  function buildBar() {
    bar = document.createElement('nav');
    bar.id = 'bottomNav'; bar.className = 'bnav'; bar.setAttribute('aria-label', 'Navigation principale');
    bar.innerHTML = BOTTOM_NAV.map(function (t) {
      return '<button class="bnav-tab" type="button" data-nav="' + t.id + '" aria-label="' + t.label + '">' + IC[t.icon] + '<span>' + t.label + '</span></button>';
    }).join('');
    bar.addEventListener('click', function (e) {
      var b = e.target.closest('.bnav-tab'); if (!b) return;
      var item = findNav(b.getAttribute('data-nav')); if (!item) return;
      if (item.id !== 'plus') closePlus();
      try { item.go(); } catch (err) { /* non bloquant */ }
      window.setTimeout(updateActive, 60);
    });
  }
  function findNav(id) { for (var i = 0; i < BOTTOM_NAV.length; i++) if (BOTTOM_NAV[i].id === id) return BOTTOM_NAV[i]; return null; }

  function buildSheet() {
    scrim = document.createElement('div'); scrim.id = 'bnavScrim'; scrim.className = 'bnav-scrim';
    scrim.addEventListener('click', closePlus);
    sheet = document.createElement('div'); sheet.id = 'bnavSheet'; sheet.className = 'bnav-sheet'; sheet.setAttribute('role', 'menu');
    renderSheet();
    sheet.addEventListener('click', function (e) {
      var r = e.target.closest('.bnav-row'); if (!r) return;
      var item = findPlus(r.getAttribute('data-plus')); if (!item) return;
      closePlus();
      try { item.go(); } catch (err) { /* non bloquant */ }
    });
  }
  function findPlus(id) { for (var i = 0; i < PLUS_ITEMS.length; i++) if (PLUS_ITEMS[i].id === id) return PLUS_ITEMS[i]; return null; }
  function renderSheet() {
    var rows = PLUS_ITEMS.filter(function (it) { return !it.admin || isAdmin(); }).map(function (it) {
      var tail = it.soon ? '<span class="soon">Bientôt</span>' : '<span class="chev">' + IC.chev + '</span>';
      return '<button class="bnav-row" type="button" data-plus="' + it.id + '">' + IC[it.icon] + '<span>' + it.label + '</span>' + tail + '</button>';
    }).join('');
    sheet.innerHTML = '<div class="bnav-sheet-handle"></div><div class="bnav-sheet-title">Plus</div>' + rows;
  }

  function buildAvatar() {
    avatar = document.createElement('button');
    avatar.id = 'bnavAvatar'; avatar.className = 'bnav-avatar'; avatar.type = 'button';
    avatar.setAttribute('aria-label', 'Mon compte'); avatar.setAttribute('title', 'Mon compte');
    avatar.innerHTML = IC.user;   // Phase 2 : remplacera par l'avatar/initiales du compte
    avatar.addEventListener('click', function () { closePlus(); clickEl('accountBtn'); });
    var host = el('rightRailScroll');
    if (host) host.insertBefore(avatar, host.firstChild);
    else document.body.appendChild(avatar);
  }

  // --- feuille Plus : ouverture/fermeture ---
  function openPlus() { renderSheet(); sheet.classList.add('is-open'); scrim.classList.add('is-open'); setPlusActive(true); }
  function closePlus() { if (!sheet) return; sheet.classList.remove('is-open'); scrim.classList.remove('is-open'); setPlusActive(false); }
  function togglePlus() { (sheet.classList.contains('is-open') ? closePlus : openPlus)(); }
  function setPlusActive(on) {
    var t = bar.querySelector('.bnav-tab[data-nav="plus"]'); if (t) t.classList.toggle('is-active', on);
  }

  // --- toast ---
  function toast(msg) {
    if (!toastEl) { toastEl = document.createElement('div'); toastEl.className = 'bnav-toast'; document.body.appendChild(toastEl); }
    toastEl.textContent = msg; toastEl.classList.add('is-show');
    clearTimeout(toastEl._t); toastEl._t = window.setTimeout(function () { toastEl.classList.remove('is-show'); }, 1900);
  }

  // --- onglet actif = vue courante ---
  function currentView() {
    if (forumOpen()) return 'forum';
    if (inChase()) return 'radar';
    if (inStar()) return 'etoiles';
    return 'carte';
  }
  function updateActive() {
    if (sheet && sheet.classList.contains('is-open')) return;   // Plus prime tant qu'ouverte
    var v = currentView();
    var tabs = bar.querySelectorAll('.bnav-tab');
    for (var i = 0; i < tabs.length; i++) tabs[i].classList.toggle('is-active', tabs[i].getAttribute('data-nav') === v);
  }

  // --- init ---
  function init() {
    if (el('bottomNav')) return;
    var host = el('app') || document.body;
    buildBar(); buildSheet(); buildAvatar();
    host.appendChild(scrim); host.appendChild(sheet); host.appendChild(bar);
    updateActive();

    // sync de l'onglet actif quand le mode/la page change ailleurs
    try {
      var mo = new MutationObserver(function () { updateActive(); });
      mo.observe(document.body, { attributes: true, attributeFilter: ['class'] });
      var fp = el('forumPage'); if (fp) mo.observe(fp, { attributes: true, attributeFilter: ['aria-hidden'] });
    } catch (e) { /* pas d'observer → tant pis, MAJ au tap */ }

    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && sheet.classList.contains('is-open')) closePlus();
    });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
