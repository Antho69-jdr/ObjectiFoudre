/* account.js — « Système de compte » (IIFE, pattern spots.js).
   Bouton compte (rail droit) → modale : connexion Google, pseudo, carte au lancement,
   déconnexion, suppression (RGPD). Applique la carte préférée à l'ouverture de l'app et
   rattache les spots anonymes du device au compte à la connexion. Non bloquant. */
(function () {
  'use strict';
  var btn = document.getElementById('accountBtn');
  var modal = document.getElementById('accountModal');
  var body = document.getElementById('accountBody');
  if (!btn || !modal || !body) return;

  var MAPS = [['forecast', 'Prévision'], ['chase', 'Chasse orage'], ['stargaze', 'Chasse étoiles']];
  var state = { user: null, googleConfigured: false, busy: false };

  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }
  function jget(path) { return fetch(path, { credentials: 'same-origin' }).then(function (r) { return r.json().catch(function () { return {}; }); }); }
  function jsend(path, method, data) {
    return fetch(path, { method: method, credentials: 'same-origin',
      headers: data ? { 'Content-Type': 'application/json' } : {},
      body: data ? JSON.stringify(data) : undefined }).then(function (r) { return r.json().catch(function () { return {}; }); });
  }
  function anonToken() { try { return localStorage.getItem('ofspot_token') || ''; } catch (e) { return ''; } }
  // Rafraîchit le calque des spots (perso privés apparaissent/disparaissent selon la session).
  function reloadSpots() { try { if (window.ObjectiFoudreSpots && window.ObjectiFoudreSpots.reload) window.ObjectiFoudreSpots.reload(); } catch (e) {} }
  function cacheMap(m) { try { if (m && m !== 'forecast') localStorage.setItem('objfDefaultMap', m); else localStorage.removeItem('objfDefaultMap'); } catch (e) {} }

  // ── Carte au lancement ─────────────────────────────────────────────────────
  var appliedDefault = false;
  function applyDefaultMap(map) {
    if (appliedDefault || !map || map === 'forecast') return;
    appliedDefault = true;
    var tries = 0;
    (function go() {
      var ready = (typeof window.map !== 'undefined');
      try {
        if (map === 'chase' && window.toggleChaseMode && !document.body.classList.contains('chase-mode') && !document.body.classList.contains('stargaze-mode')) { window.toggleChaseMode(); return; }
        if (map === 'stargaze' && window.toggleStargazeMode && !document.body.classList.contains('stargaze-mode') && !document.body.classList.contains('chase-mode')) { window.toggleStargazeMode(); return; }
      } catch (e) {}
      if (tries++ < 25 && !ready) window.setTimeout(go, 200);
    })();
  }

  // ── Rendu de la modale ──────────────────────────────────────────────────────
  function open() { modal.classList.add('show'); modal.setAttribute('aria-hidden', 'false'); render(); }
  function close() { modal.classList.remove('show'); modal.setAttribute('aria-hidden', 'true'); }

  var G_SVG = '<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path fill="#4285F4" d="M23.5 12.3c0-.8-.1-1.6-.2-2.3H12v4.5h6.5a5.6 5.6 0 0 1-2.4 3.6v3h3.9c2.3-2.1 3.5-5.2 3.5-8.8Z"/><path fill="#34A853" d="M12 24c3.2 0 6-1.1 8-3l-3.9-3a7.2 7.2 0 0 1-10.7-3.8H1.3v3.1A12 12 0 0 0 12 24Z"/><path fill="#FBBC05" d="M5.4 14.2a7.2 7.2 0 0 1 0-4.6V6.5H1.3a12 12 0 0 0 0 11l4.1-3.3Z"/><path fill="#EA4335" d="M12 4.8c1.8 0 3.4.6 4.6 1.8l3.5-3.5A12 12 0 0 0 1.3 6.5l4.1 3.1A7.2 7.2 0 0 1 12 4.8Z"/></svg>';

  function render() {
    body.innerHTML = '';
    var close_ = el('button', 'account-close', '×'); close_.setAttribute('aria-label', 'Fermer'); close_.type = 'button';
    close_.addEventListener('click', close); body.appendChild(close_);

    if (!state.user) {
      body.appendChild(el('div', 'account-title', 'Compte'));
      var sub = el('div', 'account-sub', 'Connecte-toi pour retrouver tes spots, ton pseudo et tes préférences sur tous tes appareils.');
      body.appendChild(sub);
      if (state.googleConfigured) {
        var g = el('button', 'account-google'); g.type = 'button';
        g.innerHTML = G_SVG + '<span>Se connecter avec Google</span>';
        g.addEventListener('click', function () { window.location.href = '/api/auth/google/login'; });
        body.appendChild(g);
      } else {
        body.appendChild(el('div', 'account-note', 'Connexion indisponible pour le moment.'));
      }
      appendPrivacy();
      return;
    }

    var u = state.user;
    body.appendChild(el('div', 'account-title', 'Mon compte'));
    var who = el('div', 'account-who');
    who.innerHTML = '<b>' + esc(u.pseudo) + '</b>' + (u.email ? '<small>' + esc(u.email) + '</small>' : '');
    body.appendChild(who);

    // Pseudo
    body.appendChild(el('label', 'account-label', 'Pseudo'));
    var prow = el('div', 'account-row');
    var pin = el('input', 'account-input'); pin.type = 'text'; pin.value = u.pseudo || ''; pin.maxLength = 24;
    var psave = el('button', 'account-btn', 'Enregistrer'); psave.type = 'button';
    var perr = el('div', 'account-err');
    psave.addEventListener('click', function () {
      perr.textContent = ''; psave.disabled = true;
      jsend('/api/account/pseudo', 'POST', { pseudo: pin.value.trim() }).then(function (r) {
        psave.disabled = false;
        if (r && r.ok) { state.user = r.user; who.innerHTML = '<b>' + esc(r.user.pseudo) + '</b>' + (r.user.email ? '<small>' + esc(r.user.email) + '</small>' : ''); toast('Pseudo mis à jour ✓'); refreshBtn(); }
        else { perr.textContent = (r && r.error) || 'Échec.'; }
      });
    });
    prow.append(pin, psave); body.append(prow, perr);

    // Carte au lancement
    body.appendChild(el('label', 'account-label', 'Carte à l\'ouverture de l\'app'));
    var seg = el('div', 'account-seg');
    var cur = (u.prefs && u.prefs.default_map) || 'forecast';
    MAPS.forEach(function (m) {
      var b = el('button', 'account-seg-btn' + (m[0] === cur ? ' active' : ''), m[1]); b.type = 'button';
      b.addEventListener('click', function () {
        seg.querySelectorAll('.account-seg-btn').forEach(function (x) { x.classList.remove('active'); });
        b.classList.add('active');
        jsend('/api/account/prefs', 'POST', { default_map: m[0] }).then(function (r) {
          if (r && r.ok) { state.user = r.user; cacheMap(m[0]); toast('Préférence enregistrée ✓'); }
        });
      });
      seg.appendChild(b);
    });
    body.appendChild(seg);

    // Actions
    var acts = el('div', 'account-actions');
    var out = el('button', 'account-btn ghost', 'Se déconnecter'); out.type = 'button';
    out.addEventListener('click', function () {
      jsend('/api/auth/logout', 'POST').then(function () { state.user = null; cacheMap(null); refreshBtn(); render(); reloadSpots(); toast('Déconnecté'); });
    });
    var del = el('button', 'account-btn del', 'Supprimer mon compte'); del.type = 'button';
    del.addEventListener('click', function () {
      if (!window.confirm('Supprimer définitivement ton compte ? (tes spots publics restent, dissociés)')) return;
      jsend('/api/account', 'DELETE').then(function () { state.user = null; cacheMap(null); refreshBtn(); render(); reloadSpots(); toast('Compte supprimé'); });
    });
    acts.append(out, del); body.appendChild(acts);
    appendPrivacy();
  }

  function appendPrivacy() {
    var p = el('a', 'account-privacy', 'Confidentialité & données');
    p.href = '/confidentialite'; p.target = '_blank'; p.rel = 'noopener';
    body.appendChild(p);
  }

  function el(tag, cls, txt) { var e = document.createElement(tag); if (cls) e.className = cls; if (txt != null) e.textContent = txt; return e; }
  function toast(msg) {
    var t = document.getElementById('accountToast');
    if (!t) { t = el('div', 'account-toast'); t.id = 'accountToast'; document.body.appendChild(t); }
    t.textContent = msg; t.classList.add('show');
    window.clearTimeout(t._h); t._h = window.setTimeout(function () { t.classList.remove('show'); }, 2600);
  }
  function refreshBtn() {
    var on = !!state.user;
    btn.classList.toggle('is-auth', on);
    btn.setAttribute('aria-label', on ? ('Compte : ' + (state.user.pseudo || '')) : 'Compte / connexion');
    btn.title = on ? ('Compte — ' + (state.user.pseudo || '')) : 'Compte / connexion';
  }

  // ── Init ────────────────────────────────────────────────────────────────────
  // Appliquer la carte préférée mémorisée AU PLUS TÔT (évite le flash), puis réconcilier.
  try { applyDefaultMap(localStorage.getItem('objfDefaultMap')); } catch (e) {}

  function loadMe() {
    return jget('/api/account/me').then(function (r) {
      state.user = (r && r.user) || null;
      state.googleConfigured = !!(r && r.google_configured);
      cacheMap(state.user && state.user.prefs ? state.user.prefs.default_map : null);
      applyDefaultMap(state.user && state.user.prefs ? state.user.prefs.default_map : null);
      refreshBtn();
    }).catch(function () {});
  }

  // Retour de connexion Google (?login=ok) : rattacher les spots anonymes puis nettoyer l'URL.
  function handleLoginReturn() {
    var q = window.location.search;
    if (q.indexOf('login=ok') >= 0) {
      var tok = anonToken();
      var done = function () {
        try { history.replaceState(null, '', window.location.pathname); } catch (e) {}
        loadMe().then(function () { reloadSpots(); open(); toast('Connecté ✓'); });
      };
      if (tok) jsend('/api/account/link-anon', 'POST', { token: tok }).then(done, done);
      else done();
      return true;
    }
    if (q.indexOf('login=error') >= 0) {
      try { history.replaceState(null, '', window.location.pathname); } catch (e) {}
      window.setTimeout(function () { toast('Connexion annulée ou échouée.'); }, 400);
    }
    return false;
  }

  btn.addEventListener('click', function () { if (modal.classList.contains('show')) close(); else open(); });
  modal.addEventListener('click', function (e) { if (e.target === modal) close(); });
  document.addEventListener('keydown', function (e) { if (e.key === 'Escape' && modal.classList.contains('show')) close(); });

  if (!handleLoginReturn()) loadMe();
})();
