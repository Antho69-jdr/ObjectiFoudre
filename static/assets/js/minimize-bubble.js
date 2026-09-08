/* minimize-bubble.js — réduire une surface en BULLE FLOTTANTE déplaçable (IIFE).

   Le problème qu'il règle (mode étoiles, mobile en portrait) : la feuille « Autour de
   moi » occupe le bas de l'écran, il ne reste presque plus de carte visible — or la carte
   EST le résultat (anneau du rayon, cellules et spots surlignés) — et le moindre geste
   sur la carte fermait la feuille, effaçant le tout.

   La bulle résout les deux : la surface se replie en une pastille qu'on déplace où l'on
   veut, la carte redevient entière, et un appui la rouvre à l'identique. RIEN n'est perdu.

   Exposé : window.OFBubble.attach({ el, isOpen, label, icon, key, onMinimize, onRestore })
   → { minimize(), restore(), hide(), isMinimized() }

   Trois pièges traités ici, tous vérifiés à l'écran :
   - APPUI ou GLISSÉ : au doigt, un appui bouge toujours de un ou deux pixels. En dessous
     de 8 px on rouvre, au-delà on ne fait que déplacer.
   - La bulle doit rester ATTRAPABLE : bornée au viewport, et re-bornée à chaque
     redimensionnement (bascule portrait/paysage, clavier virtuel).
   - `touch-action: none` sur la bulle, sinon le doigt fait défiler la page au lieu de la
     déplacer (même règle que les frises).
*/
(function () {
  'use strict';
  var W = window, D = document;
  var SEUIL_GLISSE = 8;       // px : en deçà, c'est un appui
  var MARGE = 8;              // px : la bulle ne colle jamais au bord

  function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

  function attach(opts) {
    if (!opts || !opts.el) return null;
    var el = opts.el;
    var key = 'ofBubble:' + (opts.key || 'default');
    var minimise = false;

    var bulle = D.createElement('button');
    bulle.type = 'button';
    bulle.className = 'of-bubble';
    bulle.hidden = true;
    bulle.setAttribute('aria-label', 'Rouvrir ' + (opts.label || 'le panneau'));
    bulle.title = 'Rouvrir ' + (opts.label || 'le panneau') + ' — glisser pour déplacer';
    bulle.innerHTML = '<span class="of-bubble-ic" aria-hidden="true">' + (opts.icon || '▣') + '</span>'
      + (opts.label ? '<span class="of-bubble-lb">' + opts.label + '</span>' : '');
    D.body.appendChild(bulle);

    // ── Position : mémorisée, et TOUJOURS re-bornée au viewport ──────────────
    function taille() { var r = bulle.getBoundingClientRect(); return { w: r.width || 56, h: r.height || 44 }; }
    function borner(x, y) {
      var t = taille();
      return {
        x: clamp(x, MARGE, Math.max(MARGE, W.innerWidth - t.w - MARGE)),
        y: clamp(y, MARGE, Math.max(MARGE, W.innerHeight - t.h - MARGE)),
      };
    }
    function poser(x, y) {
      var p = borner(x, y);
      p.x = Math.round(p.x); p.y = Math.round(p.y);   // pixels entiers : rendu net, valeur mémorisée propre
      bulle.style.left = p.x + 'px';
      bulle.style.top = p.y + 'px';
      try { localStorage.setItem(key, p.x + ',' + p.y); } catch (_) {}
    }
    function positionInitiale() {
      var t = taille();
      try {
        var m = (localStorage.getItem(key) || '').split(',');
        if (m.length === 2 && m[0] !== '' && !isNaN(+m[0])) return { x: +m[0], y: +m[1] };
      } catch (_) {}
      // Défaut : bord DROIT, au-dessus de la frise et de la barre du bas. À gauche, elle
      // s'alignait sous le rail de couches et passait pour un bouton de plus.
      return { x: Math.max(MARGE, W.innerWidth - t.w - MARGE - 4), y: W.innerHeight - t.h - 150 };
    }

    // ── Glisser / appuyer ────────────────────────────────────────────────────
    var pointeur = null, depart = null, origine = null, aBouge = false;
    bulle.addEventListener('pointerdown', function (e) {
      pointeur = e.pointerId; aBouge = false;
      var r = bulle.getBoundingClientRect();
      depart = { x: e.clientX, y: e.clientY };
      origine = { x: r.left, y: r.top };
      try { bulle.setPointerCapture(pointeur); } catch (_) {}
      bulle.classList.add('is-dragging');
      // Le pointerdown ne doit pas remonter : OFDismiss écoute en capture et refermerait
      // des surfaces derrière, alors qu'on ne fait que saisir la bulle.
      e.stopPropagation();
    });
    bulle.addEventListener('pointermove', function (e) {
      if (pointeur === null || e.pointerId !== pointeur) return;
      var dx = e.clientX - depart.x, dy = e.clientY - depart.y;
      if (!aBouge && Math.abs(dx) + Math.abs(dy) > SEUIL_GLISSE) aBouge = true;
      if (aBouge) poser(origine.x + dx, origine.y + dy);
    });
    function finPointeur(e) {
      if (pointeur === null || (e && e.pointerId !== pointeur)) return;
      try { bulle.releasePointerCapture(pointeur); } catch (_) {}
      pointeur = null;
      bulle.classList.remove('is-dragging');
      if (!aBouge) restore();          // simple appui → on rouvre
    }
    bulle.addEventListener('pointerup', finPointeur);
    bulle.addEventListener('pointercancel', finPointeur);
    // Le clavier doit rouvrir aussi (la bulle est un vrai bouton).
    bulle.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); restore(); }
    });

    W.addEventListener('resize', function () {
      if (!minimise) return;
      var r = bulle.getBoundingClientRect();
      poser(r.left, r.top);            // re-bornage : rotation, clavier virtuel…
    });

    // ── API ──────────────────────────────────────────────────────────────────
    function minimize() {
      if (minimise) return;
      if (typeof opts.isOpen === 'function' && !opts.isOpen()) return;
      minimise = true;
      el.classList.add('of-minimized');
      var p = positionInitiale();
      bulle.hidden = false;
      poser(p.x, p.y);                 // après l'affichage : la taille est enfin connue
      if (typeof opts.onMinimize === 'function') { try { opts.onMinimize(); } catch (_) {} }
    }
    function restore() {
      if (!minimise) return;
      minimise = false;
      el.classList.remove('of-minimized');
      bulle.hidden = true;
      if (typeof opts.onRestore === 'function') { try { opts.onRestore(); } catch (_) {} }
    }
    /** La surface est fermée pour de bon : la bulle disparaît avec elle. */
    function hide() {
      minimise = false;
      el.classList.remove('of-minimized');
      bulle.hidden = true;
    }

    return { minimize: minimize, restore: restore, hide: hide,
             isMinimized: function () { return minimise; }, bulle: bulle };
  }

  W.OFBubble = { attach: attach };
})();
