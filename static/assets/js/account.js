/* account.js — « Système de compte » (IIFE, pattern spots.js).
   Bouton compte (rail droit) → modale : connexion (Google, Microsoft, e-mail/mot de passe),
   inscription, mot de passe oublié / réinitialisation, pseudo, carte au lancement,
   déconnexion, suppression (RGPD). Applique la carte préférée à l'ouverture de l'app et
   rattache les spots anonymes du device au compte à la connexion. Non bloquant. */
(function () {
  'use strict';
  var btn = document.getElementById('accountBtn');
  var modal = document.getElementById('accountModal');
  var body = document.getElementById('accountBody');
  if (!btn || !modal || !body) return;

  var MAPS = [['forecast', 'Prévision'], ['chase', 'Chasse orage'], ['stargaze', 'Chasse étoiles']];
  var state = { user: null, oauth: {}, emailEnabled: false, authMode: 'login', busy: false };

  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }
  function jget(path) { return fetch(path, { credentials: 'same-origin' }).then(function (r) { return r.json().catch(function () { return {}; }); }); }
  function jsend(path, method, data) {
    return fetch(path, { method: method, credentials: 'same-origin',
      headers: data ? { 'Content-Type': 'application/json' } : {},
      body: data ? JSON.stringify(data) : undefined }).then(function (r) { return r.json().catch(function () { return {}; }); });
  }
  function anonToken() { try { return localStorage.getItem('ofspot_token') || ''; } catch (e) { return ''; } }
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
  var MS_SVG = '<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><path fill="#F25022" d="M2 2h9.3v9.3H2z"/><path fill="#7FBA00" d="M12.7 2H22v9.3h-9.3z"/><path fill="#00A4EF" d="M2 12.7h9.3V22H2z"/><path fill="#FFB900" d="M12.7 12.7H22V22h-9.3z"/></svg>';

  function oauthBtn(id, label, svg) {
    var b = el('button', 'account-oauth account-oauth-' + id); b.type = 'button';
    b.innerHTML = svg + '<span>Continuer avec ' + label + '</span>';
    b.addEventListener('click', function () { window.location.href = '/api/auth/' + id + '/login'; });
    return b;
  }

  function render() {
    body.innerHTML = '';
    var close_ = el('button', 'account-close', '×'); close_.setAttribute('aria-label', 'Fermer'); close_.type = 'button';
    close_.addEventListener('click', close); body.appendChild(close_);
    if (!state.user) { renderLoggedOut(); } else { renderLoggedIn(); }
  }

  // ── Déconnecté : OAuth + e-mail/mot de passe ────────────────────────────────
  function renderLoggedOut() {
    var isReg = state.authMode === 'register';
    body.appendChild(el('div', 'account-title', isReg ? 'Créer un compte' : 'Se connecter'));
    body.appendChild(el('div', 'account-sub', 'Retrouve tes spots, ton pseudo et tes préférences sur tous tes appareils.'));

    var anyOauth = false;
    if (state.oauth.google) { body.appendChild(oauthBtn('google', 'Google', G_SVG)); anyOauth = true; }
    if (state.oauth.microsoft) { body.appendChild(oauthBtn('microsoft', 'Microsoft', MS_SVG)); anyOauth = true; }

    if (state.emailEnabled) {
      if (anyOauth) { var sep = el('div', 'account-sep'); sep.innerHTML = '<span>ou</span>'; body.appendChild(sep); }
      body.appendChild(buildEmailForm(isReg));
    } else if (!anyOauth) {
      body.appendChild(el('div', 'account-note', 'Connexion indisponible pour le moment.'));
    }
    appendPrivacy();
  }

  function buildEmailForm(isReg) {
    var wrap = el('form', 'account-form'); wrap.setAttribute('novalidate', 'novalidate');
    var email = el('input', 'account-input'); email.type = 'email'; email.placeholder = 'Adresse e-mail'; email.autocomplete = 'email'; email.required = true;
    var pass = el('input', 'account-input'); pass.type = 'password'; pass.placeholder = 'Mot de passe'; pass.autocomplete = isReg ? 'new-password' : 'current-password'; pass.required = true;
    var pseudo = null;
    wrap.append(email, pass);
    if (isReg) {
      pseudo = el('input', 'account-input'); pseudo.type = 'text'; pseudo.placeholder = 'Pseudo (optionnel)'; pseudo.maxLength = 24;
      wrap.appendChild(pseudo);
      var hint = el('div', 'account-hint', 'Mot de passe : 8 caractères minimum.'); wrap.appendChild(hint);
    }
    var err = el('div', 'account-err'); wrap.appendChild(err);
    var submit = el('button', 'account-btn account-btn-full', isReg ? 'Créer mon compte' : 'Se connecter'); submit.type = 'submit';
    wrap.appendChild(submit);

    wrap.addEventListener('submit', function (ev) {
      ev.preventDefault(); err.textContent = ''; err.className = 'account-err';
      var e = email.value.trim(), p = pass.value;
      if (!e || !p) { err.textContent = 'Renseigne ton e-mail et ton mot de passe.'; return; }
      submit.disabled = true; submit.textContent = '…';
      if (isReg) {
        jsend('/api/auth/register', 'POST', { email: e, password: p, pseudo: (pseudo && pseudo.value.trim()) || null }).then(function (r) {
          submit.disabled = false; submit.textContent = 'Créer mon compte';
          if (r && r.ok) { renderCheckEmail(e); }
          else { err.textContent = (r && r.error) || 'Échec de l\'inscription.'; }
        });
      } else {
        jsend('/api/auth/login', 'POST', { email: e, password: p }).then(function (r) {
          submit.disabled = false; submit.textContent = 'Se connecter';
          if (r && r.ok) { onAuthSuccess(); }
          else if (r && r.need_verification) { err.className = 'account-err account-info'; err.textContent = r.error || 'Confirme d\'abord ton adresse e-mail.'; }
          else { err.textContent = (r && r.error) || 'E-mail ou mot de passe incorrect.'; }
        });
      }
    });

    // Bascule connexion / inscription + mot de passe oublié.
    var foot = el('div', 'account-formfoot');
    var toggle = el('button', 'account-link'); toggle.type = 'button';
    toggle.textContent = isReg ? 'Déjà un compte ? Se connecter' : 'Pas de compte ? Créer un compte';
    toggle.addEventListener('click', function () { state.authMode = isReg ? 'login' : 'register'; render(); });
    foot.appendChild(toggle);
    if (!isReg) {
      var forgot = el('button', 'account-link'); forgot.type = 'button'; forgot.textContent = 'Mot de passe oublié ?';
      forgot.addEventListener('click', function () { doForgot(email.value.trim()); });
      foot.appendChild(forgot);
    }
    wrap.appendChild(foot);
    window.setTimeout(function () { try { email.focus(); } catch (e) {} }, 60);
    return wrap;
  }

  function renderCheckEmail(email) {
    body.innerHTML = '';
    var close_ = el('button', 'account-close', '×'); close_.type = 'button'; close_.setAttribute('aria-label', 'Fermer');
    close_.addEventListener('click', close); body.appendChild(close_);
    body.appendChild(el('div', 'account-title', 'Vérifie ta boîte mail'));
    var s = el('div', 'account-sub'); s.innerHTML = 'On a envoyé un lien de confirmation à <b>' + esc(email) + '</b>. Clique dessus pour activer ton compte (pense à vérifier les spams).';
    body.appendChild(s);
    var resend = el('button', 'account-btn ghost account-btn-full', 'Renvoyer l\'e-mail'); resend.type = 'button';
    resend.addEventListener('click', function () {
      resend.disabled = true; jsend('/api/auth/verify/resend', 'POST', { email: email }).then(function () { toast('E-mail renvoyé ✓'); window.setTimeout(function () { resend.disabled = false; }, 4000); });
    });
    body.appendChild(resend);
    var back = el('button', 'account-link', 'Retour'); back.type = 'button';
    back.addEventListener('click', function () { state.authMode = 'login'; render(); });
    body.appendChild(back);
    appendPrivacy();
  }

  function doForgot(prefill) {
    var email = window.prompt('Ton adresse e-mail pour réinitialiser le mot de passe :', prefill || '');
    if (email == null) return;
    email = email.trim(); if (!email) return;
    jsend('/api/auth/password/forgot', 'POST', { email: email }).then(function () {
      toast('Si un compte existe, un e-mail vient d\'être envoyé.', 4200);
    });
  }

  function onAuthSuccess() {
    loadMe().then(function () {
      reloadSpots();
      // rattache les spots anonymes du device au compte
      var tok = anonToken();
      if (tok) jsend('/api/account/link-anon', 'POST', { token: tok });
      render(); toast('Connecté ✓');
    });
  }

  // ── Réinitialisation via lien e-mail (?reset=token) ─────────────────────────
  function renderResetForm(token) {
    open();
    body.innerHTML = '';
    var close_ = el('button', 'account-close', '×'); close_.type = 'button'; close_.setAttribute('aria-label', 'Fermer');
    close_.addEventListener('click', close); body.appendChild(close_);
    body.appendChild(el('div', 'account-title', 'Nouveau mot de passe'));
    body.appendChild(el('div', 'account-sub', 'Choisis un nouveau mot de passe (8 caractères minimum).'));
    var form = el('form', 'account-form');
    var p1 = el('input', 'account-input'); p1.type = 'password'; p1.placeholder = 'Nouveau mot de passe'; p1.autocomplete = 'new-password';
    var p2 = el('input', 'account-input'); p2.type = 'password'; p2.placeholder = 'Confirme le mot de passe'; p2.autocomplete = 'new-password';
    var err = el('div', 'account-err');
    var submit = el('button', 'account-btn account-btn-full', 'Enregistrer'); submit.type = 'submit';
    form.append(p1, p2, err, submit);
    form.addEventListener('submit', function (ev) {
      ev.preventDefault(); err.textContent = '';
      if (p1.value.length < 8) { err.textContent = 'Mot de passe : 8 caractères minimum.'; return; }
      if (p1.value !== p2.value) { err.textContent = 'Les deux mots de passe diffèrent.'; return; }
      submit.disabled = true; submit.textContent = '…';
      jsend('/api/auth/password/reset', 'POST', { token: token, password: p1.value }).then(function (r) {
        if (r && r.ok) { loadMe().then(function () { reloadSpots(); render(); toast('Mot de passe mis à jour ✓'); }); }
        else { submit.disabled = false; submit.textContent = 'Enregistrer'; err.textContent = (r && r.error) || 'Lien invalide ou expiré.'; }
      });
    });
    body.appendChild(form);
    appendPrivacy();
  }

  // ── Connecté : profil + préférences + mot de passe + actions ────────────────
  function renderLoggedIn() {
    var u = state.user;
    body.appendChild(el('div', 'account-title', 'Mon compte'));
    var who = el('div', 'account-who');
    who.innerHTML = '<b>' + esc(u.pseudo) + '</b>' + (u.email ? '<small>' + esc(u.email) + (u.email_verified ? '' : ' · non confirmé') + '</small>' : '');
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

    // Alertes orage par département (Web Push) — module dédié push-alerts.js
    try {
      if (window.ObjectiFoudrePush) {
        window.ObjectiFoudrePush.renderSection(body, { el: el, jget: jget, jsend: jsend, toast: toast, esc: esc });
      }
    } catch (e) {}

    // Sécurité : mot de passe (définir/changer) — pliable
    if (state.emailEnabled) {
      body.appendChild(el('label', 'account-label', 'Mot de passe'));
      var pwToggle = el('button', 'account-btn ghost account-btn-full', u.has_password ? 'Changer le mot de passe' : 'Définir un mot de passe'); pwToggle.type = 'button';
      var pwBox = el('div', 'account-pwbox'); pwBox.style.display = 'none';
      pwToggle.addEventListener('click', function () { pwBox.style.display = pwBox.style.display === 'none' ? 'block' : 'none'; });
      buildPasswordChange(pwBox, u.has_password);
      body.append(pwToggle, pwBox);
    }

    // Moyens de connexion liés
    var methods = (u.providers || []).map(function (p) { return p === 'google' ? 'Google' : p === 'microsoft' ? 'Microsoft' : p; });
    if (u.has_password) methods.push('e-mail');
    if (methods.length) body.appendChild(el('div', 'account-methods', 'Connexion : ' + methods.join(', ')));

    // Actions
    var acts = el('div', 'account-actions');
    var out = el('button', 'account-btn ghost', 'Se déconnecter'); out.type = 'button';
    out.addEventListener('click', function () {
      jsend('/api/auth/logout', 'POST').then(function () { state.user = null; cacheMap(null); state.authMode = 'login'; refreshBtn(); render(); reloadSpots(); toast('Déconnecté'); });
    });
    var del = el('button', 'account-btn del', 'Supprimer mon compte'); del.type = 'button';
    del.addEventListener('click', function () {
      if (!window.confirm('Supprimer définitivement ton compte ? (tes spots publics restent, dissociés)')) return;
      jsend('/api/account', 'DELETE').then(function () { state.user = null; cacheMap(null); refreshBtn(); render(); reloadSpots(); toast('Compte supprimé'); });
    });
    acts.append(out, del); body.appendChild(acts);
    appendPrivacy();
  }

  function buildPasswordChange(box, hasPassword) {
    var form = el('form', 'account-form');
    var cur = null;
    if (hasPassword) { cur = el('input', 'account-input'); cur.type = 'password'; cur.placeholder = 'Mot de passe actuel'; cur.autocomplete = 'current-password'; form.appendChild(cur); }
    var np = el('input', 'account-input'); np.type = 'password'; np.placeholder = 'Nouveau mot de passe'; np.autocomplete = 'new-password';
    var err = el('div', 'account-err');
    var save = el('button', 'account-btn account-btn-full', 'Enregistrer'); save.type = 'submit';
    form.append(np, err, save);
    form.addEventListener('submit', function (ev) {
      ev.preventDefault(); err.textContent = '';
      if (np.value.length < 8) { err.textContent = 'Mot de passe : 8 caractères minimum.'; return; }
      save.disabled = true; save.textContent = '…';
      jsend('/api/account/password', 'POST', { current: cur ? cur.value : '', new: np.value }).then(function (r) {
        save.disabled = false; save.textContent = 'Enregistrer';
        if (r && r.ok) { state.user = r.user; box.style.display = 'none'; toast('Mot de passe enregistré ✓'); }
        else { err.textContent = (r && r.error) || 'Échec.'; }
      });
    });
    box.appendChild(form);
  }

  function appendPrivacy() {
    var p = el('a', 'account-privacy', 'Confidentialité & données');
    p.href = '/confidentialite'; p.target = '_blank'; p.rel = 'noopener';
    body.appendChild(p);
  }

  function el(tag, cls, txt) { var e = document.createElement(tag); if (cls) e.className = cls; if (txt != null) e.textContent = txt; return e; }
  function toast(msg, ms) {
    var t = document.getElementById('accountToast');
    if (!t) { t = el('div', 'account-toast'); t.id = 'accountToast'; document.body.appendChild(t); }
    t.textContent = msg; t.classList.add('show');
    window.clearTimeout(t._h); t._h = window.setTimeout(function () { t.classList.remove('show'); }, ms || 2600);
  }
  function refreshBtn() {
    var on = !!state.user;
    btn.classList.toggle('is-auth', on);
    btn.setAttribute('aria-label', on ? ('Compte : ' + (state.user.pseudo || '')) : 'Compte / connexion');
    btn.title = on ? ('Compte — ' + (state.user.pseudo || '')) : 'Compte / connexion';
  }

  // ── Init ────────────────────────────────────────────────────────────────────
  try { applyDefaultMap(localStorage.getItem('objfDefaultMap')); } catch (e) {}

  function loadMe() {
    return jget('/api/account/me').then(function (r) {
      state.user = (r && r.user) || null;
      state.oauth = (r && r.oauth) || (r && r.google_configured ? { google: true } : {});
      state.emailEnabled = !!(r && r.email_enabled);
      cacheMap(state.user && state.user.prefs ? state.user.prefs.default_map : null);
      applyDefaultMap(state.user && state.user.prefs ? state.user.prefs.default_map : null);
      refreshBtn();
    }).catch(function () {});
  }

  function cleanUrl() { try { history.replaceState(null, '', window.location.pathname); } catch (e) {} }

  // Retours par URL : ?login=ok|error (OAuth), ?verified=ok|error (e-mail), ?reset=token.
  function handleReturns() {
    var q = window.location.search;
    var params = new URLSearchParams(q);
    if (params.get('reset')) {
      var token = params.get('reset'); cleanUrl();
      loadMe().then(function () { renderResetForm(token); });
      return true;
    }
    if (params.get('verified') === 'ok') {
      cleanUrl();
      loadMe().then(function () { reloadSpots(); var tok = anonToken(); if (tok) jsend('/api/account/link-anon', 'POST', { token: tok }); open(); toast('Adresse confirmée ✓'); });
      return true;
    }
    if (params.get('verified') === 'error') {
      cleanUrl(); window.setTimeout(function () { toast('Lien de confirmation invalide ou expiré.', 4000); }, 400);
    }
    if (q.indexOf('login=ok') >= 0) {
      var tok2 = anonToken();
      var done = function () { cleanUrl(); loadMe().then(function () { reloadSpots(); open(); toast('Connecté ✓'); }); };
      if (tok2) jsend('/api/account/link-anon', 'POST', { token: tok2 }).then(done, done);
      else done();
      return true;
    }
    if (q.indexOf('login=error') >= 0) {
      cleanUrl(); window.setTimeout(function () { toast('Connexion annulée ou échouée.'); }, 400);
    }
    return false;
  }

  btn.addEventListener('click', function () { if (modal.classList.contains('show')) close(); else open(); });
  modal.addEventListener('click', function (e) { if (e.target === modal) close(); });
  document.addEventListener('keydown', function (e) { if (e.key === 'Escape' && modal.classList.contains('show')) close(); });

  if (!handleReturns()) loadMe();
})();
