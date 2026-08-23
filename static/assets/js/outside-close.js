// outside-close.js — fermeture au clic/tap EN DEHORS, cohérente et TACTILE.
// Mécanisme unique (au lieu d'une logique ad-hoc par surface) : un seul écouteur
// `pointerdown` en phase de CAPTURE sur le document. Chaque surface dismissable
// s'enregistre via window.OFDismiss.register({el, isOpen, close, ignore, coarseOnly}).
// Au pointerdown : pour chaque surface OUVERTE, si la cible n'est ni dans la surface
// ni dans un de ses déclencheurs (ignore) → on la ferme.
//
// Pourquoi la capture ? Pour voir le tap même si un handler enfant stoppe la
// propagation. On ne fait JAMAIS preventDefault/stopPropagation → les gestes carte
// (pan/zoom) et le drag des frises (touch-action:none) ne sont pas affectés.
// Pas de course à l'ouverture : une surface s'ouvre au `click` (après pointerup),
// donc le pointerdown SUIVANT est un geste distinct ; et le déclencheur est dans
// `ignore` → le tap qui (re)bascule le déclencheur ne déclenche pas de fermeture.
(function () {
  var entries = [];

  function contains(node, target) {
    try { return !!(node && target && node.contains(target)); } catch (_) { return false; }
  }
  function isCoarse() {
    try { return window.matchMedia('(hover: none), (pointer: coarse)').matches; } catch (_) { return false; }
  }
  function onPointerDown(e) {
    if (!entries.length) return;
    var t = e.target;
    // Copie défensive : close() peut désinscrire pendant l'itération.
    entries.slice().forEach(function (en) {
      try {
        if (typeof en.isOpen === 'function' && !en.isOpen()) return;
        if (en.coarseOnly && !isCoarse()) return;
        if (contains(en.el, t)) return;
        var ign = en.ignore || [];
        for (var i = 0; i < ign.length; i++) {
          var g = typeof ign[i] === 'function' ? ign[i]() : ign[i];
          if (contains(g, t)) return;
        }
        en.close();
      } catch (_) {}
    });
  }

  document.addEventListener('pointerdown', onPointerDown, true);

  window.OFDismiss = {
    // Enregistre une surface. Retourne une fonction de désinscription.
    register: function (opts) {
      if (!opts || !opts.el || typeof opts.close !== 'function') return function () {};
      var en = {
        el: opts.el,
        isOpen: typeof opts.isOpen === 'function' ? opts.isOpen : function () { return true; },
        close: opts.close,
        ignore: Array.isArray(opts.ignore) ? opts.ignore : (opts.ignore ? [opts.ignore] : []),
        coarseOnly: !!opts.coarseOnly,
      };
      entries.push(en);
      return function () { var i = entries.indexOf(en); if (i >= 0) entries.splice(i, 1); };
    },
  };
})();
