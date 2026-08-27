/* avatar.js — Avatars de compte (refonte mobile, Phase 2). Module PARTAGÉ
   (window.OFAvatar) utilisé par le compte (choix), le forum (affichage) et la
   barre du bas. Au lancement : initiales colorées + galerie d'avatars prédéfinis
   (thème orage/étoiles). L'import d'image (URL/local) viendra plus tard.
   L'avatar choisi est stocké sur le compte (prefs.avatar) et visible par tous. */
(function () {
  'use strict';

  var GRAD = {
    cyan:'linear-gradient(135deg,#38bdf8,#0ea5e9)', amber:'linear-gradient(135deg,#fbbf24,#f59e0b)',
    green:'linear-gradient(135deg,#4ade80,#22c55e)', orange:'linear-gradient(135deg,#fb923c,#f97316)',
    violet:'linear-gradient(135deg,#a78bfa,#7c3aed)', indigo:'linear-gradient(135deg,#818cf8,#4f46e5)',
    teal:'linear-gradient(135deg,#2dd4bf,#0d9488)'
  };
  var ICON = {
    bolt:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M13 2L5 13h6l-1 9 9-12h-6z"/></svg>',
    storm:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M7 15a4 4 0 0 1 .4-8 5 5 0 0 1 9.4-1.1A3.6 3.6 0 0 1 17 15"/><path d="M11 14l-1.5 3H12l-1.5 3"/></svg>',
    star:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3l2.4 5 5.6.5-4.2 3.7 1.3 5.5L12 16.9l-5.1 3.1 1.3-5.5L4 8.5 9.6 8z"/></svg>',
    moon:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/></svg>',
    radar:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="4.5"/><path d="M12 12l7-3.4"/><circle cx="12" cy="12" r="1" fill="currentColor" stroke="none"/></svg>',
    pin:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 21s7-6.5 7-11a7 7 0 1 0-14 0c0 4.5 7 11 7 11z"/><circle cx="12" cy="10" r="2.6"/></svg>',
    sun:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="4.5"/><path d="M12 2v2M12 20v2M2 12h2M20 12h2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M19.1 4.9l-1.4 1.4M6.3 17.7l-1.4 1.4"/></svg>',
    user:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="8" r="4"/><path d="M4 20.5c1.5-3.5 4.6-5 8-5s6.5 1.5 8 5"/></svg>'
  };
  // Galerie (ordre d'affichage). 'ini' = initiales colorées (défaut).
  var PRESETS = [
    { id: 'ini',   type: 'ini' },
    { id: 'bolt',  grad: 'cyan',   icon: 'bolt' },
    { id: 'storm', grad: 'violet', icon: 'storm' },
    { id: 'star',  grad: 'amber',  icon: 'star' },
    { id: 'moon',  grad: 'indigo', icon: 'moon' },
    { id: 'radar', grad: 'teal',   icon: 'radar' },
    { id: 'pin',   grad: 'green',  icon: 'pin' },
    { id: 'sun',   grad: 'orange', icon: 'sun' }
  ];
  var BY_ID = {}; PRESETS.forEach(function (p) { BY_ID[p.id] = p; });
  var INI_PALETTE = ['cyan', 'amber', 'green', 'orange'];

  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (m) { return { '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[m]; }); }
  function initialOf(pseudo) {
    var s = String(pseudo || '?').replace(/[^A-Za-zÀ-ÿ0-9]/g, '');
    return (s.slice(0, 1) || '?').toUpperCase();
  }
  function hashGrad(pseudo) {
    var h = 0, s = String(pseudo || '');
    for (var i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
    return GRAD[INI_PALETTE[h % INI_PALETTE.length]];
  }
  // avatarId invalide/absent/'ini' → initiales. Sinon preset (dégradé + glyphe).
  function resolve(avatarId) {
    var p = avatarId && BY_ID[avatarId];
    return (p && p.icon) ? p : null;
  }
  function discHTML(avatarId, pseudo, size) {
    var p = resolve(avatarId);
    if (p) return '<span class="of-av" style="--sz:' + size + 'px;background:' + GRAD[p.grad] + '">' + ICON[p.icon] + '</span>';
    return '<span class="of-av" style="--sz:' + size + 'px;background:' + hashGrad(pseudo) + '">' + esc(initialOf(pseudo)) + '</span>';
  }
  // Applique un avatar à un <button>/élément existant (ex. avatar de la barre).
  function applyToButton(node, avatarId, pseudo) {
    if (!node) return;
    var p = resolve(avatarId);
    // Fond posé en inline !important : sur le bandeau desktop, la règle
    // `#rightRailScroll .grid-focus-btn{background:transparent!important}` écraserait un fond inline
    // simple (avatar tout noir). L'inline !important bat le !important auteur → le dégradé s'affiche.
    if (p) { node.style.setProperty('background', GRAD[p.grad], 'important'); node.innerHTML = ICON[p.icon]; node.classList.add('has-avatar'); }
    else if (pseudo) { node.style.setProperty('background', hashGrad(pseudo), 'important'); node.textContent = initialOf(pseudo); node.classList.add('has-avatar'); }
    else { node.style.removeProperty('background'); node.innerHTML = ICON.user; node.classList.remove('has-avatar'); }
  }
  // Sélecteur pour la modale compte (aperçu + galerie + import désactivé).
  function pickerHTML(selectedId, pseudo) {
    var sel = (selectedId && BY_ID[selectedId]) ? selectedId : 'ini';
    var cells = PRESETS.map(function (p) {
      return '<button class="of-avcell' + (p.id === sel ? ' is-sel' : '') + '" type="button" data-av="' + p.id + '" aria-label="' + (p.id === 'ini' ? 'Initiales' : p.id) + '">' + discHTML(p.id, pseudo, 46) + '</button>';
    }).join('');
    return '<div class="of-avpick">' +
      '<div class="of-avpick-big">' + discHTML(sel, pseudo, 84) + '</div>' +
      '<div class="of-avgrid">' + cells + '</div>' +
      '<div class="of-avimport" aria-disabled="true">' + ICON.user +
        '<span>Importer une image</span><span class="of-soon">Bientôt</span></div>' +
      '</div>';
  }

  window.OFAvatar = {
    discHTML: discHTML, applyToButton: applyToButton, pickerHTML: pickerHTML,
    initialOf: initialOf, isPreset: function (id) { return !!resolve(id); }
  };
})();
