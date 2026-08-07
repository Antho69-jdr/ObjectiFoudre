/* bottom-nav.js — Barre de navigation du BAS (refonte mobile).
   Phase 1 : barre ≤767px qui remplace le rail droit ; délègue aux boutons du rail
   existant (.click()) / aux toggles globaux — aucune logique de mode réécrite.
   Phase 3 : barre PERSONNALISABLE — l'utilisateur choisit les onglets épinglés
   (max 4) ; le reste va dans la feuille « Plus ». Mémorisé par appareil
   (localStorage) + synchronisé au compte (prefs.bottom_nav) si connecté.
   Affichage/masquage du rail + décalage des frises = CSS (bottom-nav.css). */
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
    chev:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 6l6 6-6 6"/></svg>',
    check:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6L9 17l-5-5"/></svg>',
    add:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M12 5v14M5 12h14"/></svg>',
    close:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M6 6l12 12M18 6L6 18"/></svg>'
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
    if (inStar()) return;
    if (window.toggleStargazeMode) window.toggleStargazeMode(); else clickEl('stargazePageBtn');
  }

  // ===== POOL des destinations ÉPINGLABLES (barre) — modifiable/réordonnable =====
  var POOL = [
    { id: 'carte',   label: 'Carte',      icon: 'map',   go: goCarte },
    { id: 'radar',   label: 'Radar',      icon: 'radar', go: goRadar },
    { id: 'etoiles', label: 'Étoiles',    icon: 'star',  go: goEtoiles },
    { id: 'forum',   label: 'Forum',      icon: 'chat',  go: function () { clickEl('forumPageBtn'); } },
    { id: 'prev',    label: 'Prévisions', icon: 'prev',  go: function () { clickEl('predictionPageBtn'); } },
    { id: 'spots',   label: 'Mes spots',  icon: 'pin',   go: function () { clickEl('spotsPageBtn'); } },
    { id: 'histo',   label: 'Historique', icon: 'clock', go: function () { clickEl('historyPageBtn'); } }
  ];
  var POOL_IDS = POOL.map(function (p) { return p.id; });
  function poolById(id) { for (var i = 0; i < POOL.length; i++) if (POOL[i].id === id) return POOL[i]; return null; }

  // Destinations TOUJOURS dans « Plus » (non épinglables) — dont l'éditeur lui-même.
  var FIXED = [
    { id: 'aide',   label: 'Aide & guide',            icon: 'help',    go: function () { clickEl('infoDrawerBtn'); } },
    { id: 'compte', label: 'Mon compte',              icon: 'user',    go: function () { clickEl('accountBtn'); } },
    { id: 'perso',  label: 'Personnaliser la barre',  icon: 'sliders', accent: true, go: function () { openEditor(); } },
    { id: 'admin',  label: 'Télémétrie & maintenance', icon: 'gear',   admin: true, go: function () { clickEl('maintenancePageBtn'); } }
  ];

  var DEFAULT_PINNED = ['carte', 'radar', 'etoiles', 'forum'];
  var MAX_PINNED = 4, MIN_PINNED = 1, LS_KEY = 'objfBottomNav';

  function sanitize(arr) {
    var out = [];
    if (arr && arr.length) for (var i = 0; i < arr.length; i++) {
      var id = arr[i];
      if (POOL_IDS.indexOf(id) >= 0 && out.indexOf(id) < 0 && out.length < MAX_PINNED) out.push(id);
    }
    return out.length >= MIN_PINNED ? out : DEFAULT_PINNED.slice();
  }
  function loadLocal() { try { return sanitize(JSON.parse(localStorage.getItem(LS_KEY) || 'null')); } catch (e) { return DEFAULT_PINNED.slice(); } }
  function saveLocal() { try { localStorage.setItem(LS_KEY, JSON.stringify(pinned)); } catch (e) {} }
  function saveAccount() {
    if (!loggedIn) return;
    fetch('/api/account/prefs', { method: 'POST', credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ bottom_nav: pinned }) }).catch(function () {});
  }
  function persist() { saveLocal(); saveAccount(); }

  var pinned = loadLocal();
  var loggedIn = false;

  // --- DOM ---
  var bar, sheet, scrim, avatar, editor, toastEl;

  function tabHTML(p, active) {
    return '<button class="bnav-tab' + (active ? ' is-active' : '') + '" type="button" data-nav="' + p.id + '" aria-label="' + p.label + '">' + IC[p.icon] + '<span>' + p.label + '</span></button>';
  }
  function renderBar() {
    var v = currentView();
    var html = pinned.map(function (id) { var p = poolById(id); return p ? tabHTML(p, id === v) : ''; }).join('');
    html += '<button class="bnav-tab" type="button" data-nav="plus" aria-label="Plus">' + IC.plus + '<span>Plus</span></button>';
    bar.innerHTML = html;
  }
  function buildBar() {
    bar = document.createElement('nav');
    bar.id = 'bottomNav'; bar.className = 'bnav'; bar.setAttribute('aria-label', 'Navigation principale');
    bar.addEventListener('click', function (e) {
      var b = e.target.closest('.bnav-tab'); if (!b) return;
      var id = b.getAttribute('data-nav');
      if (id === 'plus') { togglePlus(); return; }
      closePlus();
      var p = poolById(id); if (p) { try { p.go(); } catch (err) {} }
      window.setTimeout(updateActive, 60);
    });
    renderBar();
  }

  // --- feuille « Plus » ---
  function sheetItems() {
    var pool = POOL.filter(function (p) { return pinned.indexOf(p.id) < 0; });
    var fixed = FIXED.filter(function (it) { return !it.admin || isAdmin(); });
    return pool.concat(fixed);
  }
  function itemById(id) {
    var p = poolById(id); if (p) return p;
    for (var i = 0; i < FIXED.length; i++) if (FIXED[i].id === id) return FIXED[i];
    return null;
  }
  function renderSheet() {
    var rows = sheetItems().map(function (it) {
      var tail = '<span class="chev">' + IC.chev + '</span>';
      return '<button class="bnav-row" type="button" data-plus="' + it.id + '">' + IC[it.icon] + '<span>' + it.label + '</span>' + tail + '</button>';
    }).join('');
    sheet.innerHTML = '<div class="bnav-sheet-handle"></div><div class="bnav-sheet-title">Plus</div>' + rows;
  }
  function buildSheet() {
    scrim = document.createElement('div'); scrim.id = 'bnavScrim'; scrim.className = 'bnav-scrim';
    scrim.addEventListener('click', closePlus);
    sheet = document.createElement('div'); sheet.id = 'bnavSheet'; sheet.className = 'bnav-sheet'; sheet.setAttribute('role', 'menu');
    sheet.addEventListener('click', function (e) {
      var r = e.target.closest('.bnav-row'); if (!r) return;
      var it = itemById(r.getAttribute('data-plus')); if (!it) return;
      closePlus();
      try { it.go(); } catch (err) {}
    });
    renderSheet();
  }
  function openPlus() { renderSheet(); sheet.classList.add('is-open'); scrim.classList.add('is-open'); setPlusActive(true); }
  function closePlus() { if (!sheet) return; sheet.classList.remove('is-open'); scrim.classList.remove('is-open'); setPlusActive(false); }
  function togglePlus() { (sheet.classList.contains('is-open') ? closePlus : openPlus)(); }
  function setPlusActive(on) { var t = bar.querySelector('.bnav-tab[data-nav="plus"]'); if (t) t.classList.toggle('is-active', on); }

  // --- avatar ---
  function buildAvatar() {
    avatar = document.createElement('button');
    avatar.id = 'bnavAvatar'; avatar.className = 'bnav-avatar'; avatar.type = 'button';
    avatar.setAttribute('aria-label', 'Mon compte'); avatar.setAttribute('title', 'Mon compte');
    avatar.innerHTML = IC.user;
    avatar.addEventListener('click', function () { closePlus(); clickEl('accountBtn'); });
    var host = el('rightRailScroll');
    if (host) host.insertBefore(avatar, host.firstChild); else document.body.appendChild(avatar);
  }
  function setAvatar(avatarId, pseudo) {
    if (!avatar) return;
    if (window.OFAvatar) { window.OFAvatar.applyToButton(avatar, avatarId, pseudo); return; }
    // repli sans le module partagé : initiale ou icône générique
    var s = String(pseudo || '').replace(/[^A-Za-zÀ-ÿ0-9]/g, '');
    if (s) avatar.textContent = s.slice(0, 1).toUpperCase(); else avatar.innerHTML = IC.user;
  }

  // --- éditeur « Personnaliser la barre » ---
  function previewTab(p) { return '<span class="be-ptab"><span class="be-pic">' + IC[p.icon] + '</span><span>' + p.label + '</span></span>'; }
  function editorItem(p, on) {
    return '<button class="be-item' + (on ? ' is-on' : '') + '" type="button" data-eid="' + p.id + '"><span class="be-ic">' + IC[p.icon] + '</span><span class="be-lbl">' + p.label + '</span><span class="be-pin">' + (on ? IC.check : IC.add) + '</span></button>';
  }
  function renderEditor() {
    var hidden = POOL.filter(function (p) { return pinned.indexOf(p.id) < 0; });
    el('beVisible').innerHTML = pinned.map(function (id) { return editorItem(poolById(id), true); }).join('');
    el('beHidden').innerHTML = hidden.map(function (p) { return editorItem(p, false); }).join('');
    el('beCount').textContent = pinned.length;
    var pv = pinned.map(function (id) { return previewTab(poolById(id)); }).join('') + previewTab({ icon: 'plus', label: 'Plus' });
    el('bePreview').innerHTML = pv;
  }
  function buildEditor() {
    editor = document.createElement('div');
    editor.id = 'bnavEditor'; editor.className = 'bnav-editor'; editor.setAttribute('aria-hidden', 'true');
    editor.setAttribute('role', 'dialog'); editor.setAttribute('aria-modal', 'true');
    editor.innerHTML =
      '<div class="be-shell">' +
        '<header class="be-head"><div><div class="be-eyebrow">Barre du bas</div><h2>Personnaliser</h2></div>' +
        '<button class="be-close" id="beClose" type="button" aria-label="Fermer">' + IC.close + '</button></header>' +
        '<div class="be-body">' +
          '<div class="be-preview-lbl">Aperçu de ta barre</div>' +
          '<div class="be-preview" id="bePreview"></div>' +
          '<div class="be-h">Dans la barre · <span id="beCount">4</span>/' + MAX_PINNED + ' <span class="be-hint" id="beHint"></span></div>' +
          '<div class="be-list" id="beVisible"></div>' +
          '<div class="be-h">Dans « Plus »</div>' +
          '<div class="be-list" id="beHidden"></div>' +
          '<p class="be-note">Mémorisé sur cet appareil, et synchronisé à ton compte si tu es connecté·e.</p>' +
        '</div>' +
      '</div>';
    editor.addEventListener('click', function (e) {
      if (e.target === editor) { closeEditor(); return; }             // clic hors panneau
      if (e.target.closest('#beClose')) { closeEditor(); return; }
      var it = e.target.closest('.be-item'); if (!it) return;
      var id = it.getAttribute('data-eid'); var i = pinned.indexOf(id);
      if (i >= 0) {
        if (pinned.length <= MIN_PINNED) { editorHint('Au moins un onglet'); return; }
        pinned.splice(i, 1);
      } else {
        if (pinned.length >= MAX_PINNED) { editorHint(MAX_PINNED + ' onglets maximum'); return; }
        pinned.push(id);
      }
      persist(); renderEditor(); renderBar(); renderSheet();
    });
  }
  function editorHint(msg) {
    var h = el('beHint'); if (!h) return; h.textContent = '— ' + msg; h.classList.add('show');
    clearTimeout(h._t); h._t = window.setTimeout(function () { h.classList.remove('show'); }, 1600);
  }
  function openEditor() { closePlus(); renderEditor(); editor.setAttribute('aria-hidden', 'false'); }
  function closeEditor() { editor.setAttribute('aria-hidden', 'true'); }

  // --- onglet actif ---
  function currentView() {
    if (forumOpen()) return 'forum';
    if (inChase()) return 'radar';
    if (inStar()) return 'etoiles';
    return 'carte';
  }
  function updateActive() {
    if (sheet && sheet.classList.contains('is-open')) return;
    var v = currentView(), tabs = bar.querySelectorAll('.bnav-tab');
    for (var i = 0; i < tabs.length; i++) tabs[i].classList.toggle('is-active', tabs[i].getAttribute('data-nav') === v);
  }

  // --- synchro compte (prefs.bottom_nav gagne si connecté) + initiale avatar ---
  function syncFromAccount() {
    fetch('/api/account/me', { credentials: 'same-origin' }).then(function (r) { return r.json(); }).then(function (d) {
      if (!d || !d.ok) return;
      loggedIn = !!d.authenticated;
      var prefs = d.user && d.user.prefs;
      if (loggedIn && prefs && prefs.bottom_nav && prefs.bottom_nav.length) {
        var acct = sanitize(prefs.bottom_nav);
        if (acct.join(',') !== pinned.join(',')) { pinned = acct; saveLocal(); renderBar(); renderSheet(); updateActive(); }
      }
      if (loggedIn && d.user) setAvatar(prefs && prefs.avatar, d.user.pseudo);
      else setAvatar(null, null);
    }).catch(function () {});
  }

  // --- init ---
  function init() {
    if (el('bottomNav')) return;
    var host = el('app') || document.body;
    buildBar(); buildSheet(); buildAvatar(); buildEditor();
    host.appendChild(scrim); host.appendChild(sheet); host.appendChild(bar); host.appendChild(editor);
    updateActive();
    syncFromAccount();

    try {
      var mo = new MutationObserver(function () { updateActive(); });
      mo.observe(document.body, { attributes: true, attributeFilter: ['class'] });
      var fp = el('forumPage'); if (fp) mo.observe(fp, { attributes: true, attributeFilter: ['aria-hidden'] });
    } catch (e) {}

    document.addEventListener('keydown', function (e) {
      if (e.key !== 'Escape') return;
      if (editor.getAttribute('aria-hidden') === 'false') closeEditor();
      else if (sheet.classList.contains('is-open')) closePlus();
    });

    // re-synchro quand le compte change (connexion/déconnexion via la modale)
    window.addEventListener('objf:account-changed', syncFromAccount);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
