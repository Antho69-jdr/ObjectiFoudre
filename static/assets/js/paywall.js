/* paywall.js — le mur du périmètre gratuit/payant (IIFE, pattern push-alerts.js).

   CE MODULE NE PROTÈGE RIEN. La barrière est côté serveur (access.py + la dépendance
   _paywall_dep) : tout le JS est public, la console suffirait à contourner un masquage.
   Ici, on ne fait que RENDRE LISIBLE un refus déjà décidé par le serveur — cadenas,
   écran d'explication, bouton d'essai.

   TROIS PIÈCES :
   1. Un intercepteur de `fetch` : tout 402 portant un objet `paywall` ouvre le mur, une
      seule fois, sans toucher à la réponse rendue à l'appelant (chaque module garde son
      chemin d'erreur existant). Aucune reprise, aucun martèlement.
   2. L'état des droits, lu dans /api/account/me (bloc `access`) — servi par account.js
      qui fait déjà l'appel, donc ZÉRO requête supplémentaire au démarrage.
   3. Les cadenas, posés en CSS via la classe racine `objf-locked` (même idiome que
      `objf-admin`). En CSS et pas en JS PARCE QUE la barre du bas se repeint entièrement
      à chaque navigation : un cadenas peint en JS disparaîtrait au premier repaint.

   DRAPEAU ÉTEINT = ÉTAT ACTUEL DE LA PRODUCTION : `access.paywall` vaut false, la classe
   racine n'est jamais posée, aucun 402 n'arrive jamais, ce module est inerte. */
(function () {
  'use strict';
  var W = window, D = document;

  var state = {
    known: false,        // a-t-on déjà lu /api/account/me ?
    paywall: false,      // le périmètre est-il appliqué côté serveur ?
    entitled: false,
    authenticated: false,
    source: null,        // 'trial' | 'manual' | prestataire
    expires: null,
    trialAvailable: false,
    offer: null,
  };
  var modal = null, card = null, busy = false;

  function el(tag, cls, txt) {
    var e = D.createElement(tag);
    if (cls) e.className = cls;
    if (txt != null) e.textContent = txt;
    return e;
  }

  // ── État ──────────────────────────────────────────────────────────────────
  function applyMe(me) {
    var a = (me && me.access) || null;
    state.known = true;
    state.authenticated = !!(me && me.authenticated);
    state.paywall = !!(a && a.paywall);
    state.entitled = !!(a && a.entitled);
    state.source = a ? a.source : null;
    state.expires = a ? a.expires_utc : null;
    state.trialAvailable = !!(a && a.trial_available);
    state.offer = (a && a.offer) || state.offer;
    paint();
    return state;
  }

  function paint() {
    // Locked = le serveur applique le périmètre ET ce visiteur n'a pas de droit.
    D.documentElement.classList.toggle('objf-locked', state.paywall && !state.entitled);
  }

  function refresh() {
    return fetch('/api/account/me', { credentials: 'same-origin' })
      .then(function (r) { return r.json(); })
      .then(applyMe)
      .catch(function () { return state; });   // état inconnu = aucun cadenas, jamais de blocage d'UI
  }

  // ── Jours restants (essai) ────────────────────────────────────────────────
  function daysLeft() {
    if (!state.expires) return null;
    var t = Date.parse(state.expires);
    if (!t) return null;
    return Math.max(0, Math.ceil((t - Date.now()) / 86400000));
  }

  function statusLabel() {
    if (!state.entitled) return 'Accès gratuit';
    if (state.source === 'trial') {
      var d = daysLeft();
      return d == null ? 'Essai en cours' : ('Essai — ' + d + (d > 1 ? ' jours restants' : ' jour restant'));
    }
    return 'Abonnement actif';
  }

  // ── Le mur ────────────────────────────────────────────────────────────────
  function ensureModal() {
    if (modal) return;
    modal = el('div', 'pw-modal');
    modal.id = 'paywallModal';
    modal.setAttribute('role', 'dialog');
    modal.setAttribute('aria-modal', 'true');
    modal.setAttribute('aria-label', 'Abonnement');
    modal.setAttribute('aria-hidden', 'true');
    card = el('div', 'pw-card');
    modal.appendChild(card);
    D.body.appendChild(modal);
    modal.addEventListener('click', function (e) { if (e.target === modal) close(); });
    D.addEventListener('keydown', function (e) { if (e.key === 'Escape' && isOpen()) close(); });
    if (W.OFDismiss && W.OFDismiss.register) {
      W.OFDismiss.register({ el: card, isOpen: isOpen, close: close });
    }
  }

  function isOpen() { return !!(modal && modal.classList.contains('show')); }

  function close() {
    if (!modal) return;
    modal.classList.remove('show');
    modal.setAttribute('aria-hidden', 'true');
  }

  /** Ouvre le mur. `info` = l'objet `paywall` du 402, ou {feature, label}. */
  function open(info) {
    ensureModal();
    if (info && info.offer) state.offer = info.offer;
    render(info || {});
    modal.classList.add('show');
    modal.setAttribute('aria-hidden', 'false');
  }

  function offerLine(kind, fallback) {
    var o = state.offer && state.offer[kind];
    return (o && o.label) || fallback;
  }

  function render(info) {
    card.innerHTML = '';
    var head = el('div', 'pw-head');
    head.appendChild(el('span', 'pw-eyebrow', 'Abonnement ObjectiFoudre'));
    head.appendChild(el('h2', 'pw-title', info.label || 'Cette fonctionnalité fait partie de l’abonnement'));
    card.appendChild(head);

    card.appendChild(el('p', 'pw-lede',
      'La météo d’aujourd’hui et de demain, la fiche de cellule de la journée, le radar et '
      + 'la foudre en direct restent gratuits. L’abonnement ouvre les dix jours de prévision, '
      + 'l’historique qui prouve les scores, le mode chasse, le ciel en profondeur et tes spots.'));

    var grid = el('div', 'pw-offers');
    [['monthly', offerLine('monthly', '3 €/mois, résiliable à tout moment'), 'Sans engagement'],
     ['yearly', offerLine('yearly', '30 €/an, paiement unique'), 'Deux mois offerts']
    ].forEach(function (row) {
      var box = el('div', 'pw-offer' + (row[0] === 'yearly' ? ' is-best' : ''));
      box.appendChild(el('span', 'pw-offer-price', row[1]));
      box.appendChild(el('span', 'pw-offer-note', row[2]));
      grid.appendChild(box);
    });
    card.appendChild(grid);

    var actions = el('div', 'pw-actions');
    if (!state.authenticated) {
      var login = el('button', 'pw-btn pw-btn-primary', 'Créer un compte ou se connecter');
      login.type = 'button';
      login.addEventListener('click', function () {
        close();
        var b = D.getElementById('accountBtn');
        if (b) b.click();
      });
      actions.appendChild(login);
      card.appendChild(actions);
      card.appendChild(el('p', 'pw-foot', 'L’essai de 7 jours s’active depuis un compte.'));
    } else if (state.trialAvailable) {
      var trial = el('button', 'pw-btn pw-btn-primary', 'Activer mes 7 jours d’essai');
      trial.type = 'button';
      trial.addEventListener('click', function () { startTrial(trial); });
      actions.appendChild(trial);
      card.appendChild(actions);
      card.appendChild(el('p', 'pw-foot', 'Gratuit, sans carte bancaire, une seule fois par compte.'));
    } else {
      card.appendChild(el('p', 'pw-foot',
        'L’abonnement n’est pas encore ouvert : le paiement arrive bientôt. '
        + 'Ton essai a déjà été utilisé sur ce compte.'));
    }

    var dismiss = el('button', 'pw-close', '✕');
    dismiss.type = 'button';
    dismiss.setAttribute('aria-label', 'Fermer');
    dismiss.addEventListener('click', close);
    card.appendChild(dismiss);
  }

  function startTrial(btn) {
    if (busy) return;
    busy = true;
    if (btn) { btn.disabled = true; btn.textContent = 'Activation…'; }
    fetch('/api/account/trial', { method: 'POST', credentials: 'same-origin' })
      .then(function (r) { return r.json().catch(function () { return {}; }); })
      .then(function (d) {
        busy = false;
        if (d && d.ok) {
          applyMe({ authenticated: true, access: d.access });
          // Rechargement volontaire : plusieurs vues ont déjà encaissé un refus et
          // affichent une erreur. Repartir propre vaut mieux qu'une interface à moitié
          // morte — c'est une action unique, pas une boucle. On l'annonce d'abord :
          // une page qui se recharge sans prévenir passe pour un plantage.
          if (btn) btn.textContent = 'Essai activé ✓ — rechargement…';
          W.setTimeout(function () { W.location.reload(); }, 800);
          return;
        }
        if (btn) { btn.disabled = false; btn.textContent = 'Activer mes 7 jours d’essai'; }
        var msg = (d && d.error) || 'Activation impossible.';
        card.appendChild(el('p', 'pw-error', msg));
      })
      .catch(function () {
        // Échec réseau : on rend la main au lieu de laisser le bouton mort.
        busy = false;
        if (btn) { btn.disabled = false; btn.textContent = 'Réessayer'; }
      });
  }

  // ── Intercepteur central des 402 ──────────────────────────────────────────
  // Un seul point d'accroche pour 25 routes verrouillées et 5 verrous d'horizon.
  // La réponse est rendue INTACTE à l'appelant : aucun module existant ne change.
  //
  // MAIS : le mur ne s'ouvre QUE dans la foulée d'un geste de l'utilisateur. Sans cette
  // condition, la première requête de fond refusée le fait surgir tout seul — mesuré :
  // au chargement de la carte, /api/spots part sans que personne n'ait rien demandé et
  // ouvrait un mur intitulé « Mes spots » alors qu'on venait de cliquer sur Historique.
  // Un refus hors geste reste donc silencieux : la couche est simplement absente, et le
  // cadenas de la barre dit pourquoi.
  var lastGestureAt = 0;
  var GESTURE_WINDOW_MS = 2500;
  ['pointerdown', 'keydown'].forEach(function (evt) {
    D.addEventListener(evt, function () { lastGestureAt = Date.now(); }, true);
  });
  function suitUnGeste() { return (Date.now() - lastGestureAt) < GESTURE_WINDOW_MS; }

  var nativeFetch = W.fetch ? W.fetch.bind(W) : null;
  if (nativeFetch) {
    W.fetch = function (input, init) {
      return nativeFetch(input, init).then(function (res) {
        if (res && res.status === 402 && suitUnGeste() && !isOpen()) {
          try {
            res.clone().json().then(function (d) {
              if (d && d.paywall && !isOpen()) open(d.paywall);
            }).catch(function () {});   // corps illisible : on n'ouvre pas, on ne casse rien
          } catch (e) { /* clone indisponible : idem */ }
        }
        return res;
      });
    };
  }

  // ── Section de la modale Compte (appelée par account.js) ──────────────────
  function renderSection(container, ctx) {
    if (!state.paywall) return;          // drapeau éteint : rien à afficher
    var mk = (ctx && ctx.el) || el;
    container.appendChild(mk('label', 'account-label', 'Abonnement'));
    var wrap = mk('div', 'account-plan');
    var line = mk('div', 'account-plan-state', statusLabel());
    line.classList.add(state.entitled ? 'is-on' : 'is-off');
    wrap.appendChild(line);
    if (!state.entitled) {
      var b = mk('button', 'account-btn account-btn-full', state.trialAvailable
        ? 'Activer mes 7 jours d’essai' : 'Voir l’abonnement');
      b.type = 'button';
      b.addEventListener('click', function () { open({ label: 'Abonnement ObjectiFoudre' }); });
      wrap.appendChild(b);
    } else if (state.source === 'trial') {
      wrap.appendChild(mk('div', 'account-hint',
        'À la fin de l’essai, l’accès repasse au gratuit — rien n’est prélevé.'));
    }
    container.appendChild(wrap);
  }

  W.OFPaywall = {
    applyMe: applyMe, refresh: refresh, open: open, close: close,
    renderSection: renderSection, state: function () { return state; },
    statusLabel: statusLabel, daysLeft: daysLeft,
  };

  // Repli : si account.js n'a pas encore transmis /me (ordre de chargement, page
  // ouverte sans modale de compte), on lit l'état une fois, sans insister.
  W.setTimeout(function () { if (!state.known) refresh(); }, 2500);
})();
