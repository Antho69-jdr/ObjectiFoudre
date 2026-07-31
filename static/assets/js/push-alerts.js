/* push-alerts.js — Alertes orage par département (Web Push, Phase 4).
   Section rendue dans la modale compte (compte obligatoire). Gère : détection du support,
   permission navigateur, abonnement PushManager (clé VAPID), sélection multi-départements
   (recherche + cases + puces), mise à jour et désabonnement. IIFE, non bloquant.
   Exposé : window.ObjectiFoudrePush.renderSection(container, ctx) où ctx fournit les
   helpers de account.js { el, jget, jsend, toast, esc }. */
(function () {
  'use strict';
  var W = window;
  var cache = { vapid: null, departments: null };

  function supported() {
    return ('serviceWorker' in navigator) && ('PushManager' in W) && ('Notification' in W);
  }

  function urlB64ToUint8(base64) {
    var pad = '='.repeat((4 - (base64.length % 4)) % 4);
    var b64 = (base64 + pad).replace(/-/g, '+').replace(/_/g, '/');
    var raw = W.atob(b64), arr = new Uint8Array(raw.length);
    for (var i = 0; i < raw.length; i++) arr[i] = raw.charCodeAt(i);
    return arr;
  }

  function norm(s) { return String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, ''); }
  function getReg() { return navigator.serviceWorker.ready; }
  function currentSub() { return getReg().then(function (reg) { return reg.pushManager.getSubscription(); }); }

  function permissionMessage(e) {
    if (e && e.message === 'denied') return 'Notifications refusées. Autorise-les pour ce site dans les réglages du navigateur.';
    return 'Impossible d\'activer les alertes sur cet appareil.';
  }

  // ── Activation / mise à jour de l'abonnement ────────────────────────────────
  function enable(ctx, vapidKey, codes) {
    if (W.Notification && W.Notification.permission === 'denied') return Promise.reject(new Error('denied'));
    return W.Notification.requestPermission().then(function (perm) {
      if (perm !== 'granted') throw new Error('denied');
      return getReg();
    }).then(function (reg) {
      return reg.pushManager.getSubscription().then(function (sub) {
        return sub || reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlB64ToUint8(vapidKey) });
      });
    }).then(function (sub) {
      var j = sub.toJSON();
      return ctx.jsend('/api/push/subscribe', 'POST', {
        endpoint: sub.endpoint, keys: { p256dh: j.keys.p256dh, auth: j.keys.auth }, departments: codes
      });
    });
  }

  function disable(ctx) {
    return currentSub().then(function (sub) {
      if (!sub) return { ok: true };
      return ctx.jsend('/api/push/unsubscribe', 'POST', { endpoint: sub.endpoint }).then(function () {
        return sub.unsubscribe().catch(function () {}).then(function () { return { ok: true }; });
      });
    });
  }

  // ── Rendu ───────────────────────────────────────────────────────────────────
  function renderSection(container, ctx) {
    var el = ctx.el;
    container.appendChild(el('label', 'account-label', 'Alertes orage'));
    var wrap = el('div', 'account-alerts');
    container.appendChild(wrap);
    if (!supported()) {
      wrap.appendChild(el('div', 'account-hint', 'Ton navigateur ne gère pas les notifications push.'));
      return;
    }
    load(wrap, ctx);
  }

  function load(wrap, ctx) {
    var el = ctx.el, jget = ctx.jget;
    wrap.innerHTML = ''; wrap.appendChild(el('div', 'account-loading', 'Chargement…'));
    Promise.all([
      cache.vapid ? Promise.resolve(cache.vapid) : jget('/api/push/vapid-public-key'),
      cache.departments ? Promise.resolve(cache.departments) : jget('/api/push/departments'),
      jget('/api/push/me').catch(function () { return {}; }),
      currentSub().catch(function () { return null; })
    ]).then(function (res) {
      cache.vapid = res[0]; cache.departments = res[1];
      var vapid = res[0] || {}, deptData = res[1] || {}, mine = res[2] || {}, browserSub = res[3];
      wrap.innerHTML = '';
      if (!vapid.configured || !vapid.key) {
        wrap.appendChild(el('div', 'account-hint', 'Les alertes orage arrivent très bientôt. Reviens d\'ici peu !'));
        return;
      }
      var followed = [], isSub = false;
      if (browserSub && mine.subscriptions) {
        var m = mine.subscriptions.filter(function (s) { return s.endpoint === browserSub.endpoint; })[0];
        if (m) { isSub = true; followed = m.departments || []; }
      }
      buildUI(wrap, ctx, { departments: deptData.departments || [], vapidKey: vapid.key, followed: followed, isSubscribed: isSub });
    }, function () {
      wrap.innerHTML = ''; wrap.appendChild(el('div', 'account-hint', 'Alertes indisponibles pour le moment.'));
    });
  }

  function buildUI(wrap, ctx, opts) {
    var el = ctx.el, toast = ctx.toast;
    var selected = {};
    (opts.followed || []).forEach(function (c) { selected[c] = true; });
    var byCode = {};
    opts.departments.forEach(function (d) { byCode[d.code] = d; });

    wrap.appendChild(el('div', 'account-hint', opts.isSubscribed
      ? 'Cet appareil est abonné. Ajuste les départements suivis ci-dessous.'
      : 'Sois prévenu·e quand un orage est en cours ou approche l\'un de tes départements.'));

    var chips = el('div', 'alerts-chips'); wrap.appendChild(chips);
    var search = el('input', 'account-input alerts-search'); search.type = 'text';
    search.placeholder = 'Filtrer par nom ou n° de département…'; wrap.appendChild(search);
    var list = el('div', 'alerts-list'); wrap.appendChild(list);
    var err = el('div', 'account-err'); wrap.appendChild(err);

    function selectedCodes() { return Object.keys(selected).filter(function (c) { return selected[c]; }).sort(); }

    function renderChips() {
      chips.innerHTML = '';
      var codes = selectedCodes();
      if (!codes.length) { chips.appendChild(el('span', 'alerts-chips-empty', 'Aucun département sélectionné')); return; }
      codes.forEach(function (code) {
        var dep = byCode[code];
        var chip = el('span', 'alerts-chip'); chip.appendChild(el('span', 'alerts-chip-txt', dep ? (code + ' · ' + dep.nom) : code));
        var x = el('button', 'alerts-chip-x', '×'); x.type = 'button'; x.setAttribute('aria-label', 'Retirer ' + code);
        x.addEventListener('click', function () { selected[code] = false; renderChips(); syncChecks(); });
        chip.appendChild(x); chips.appendChild(chip);
      });
    }
    function renderList() {
      var q = norm(search.value.trim());
      list.innerHTML = '';
      opts.departments.filter(function (d) {
        if (!q) return true;
        return norm(d.code).indexOf(q) === 0 || norm(d.nom).indexOf(q) >= 0;
      }).forEach(function (d) {
        var row = el('label', 'alerts-item');
        var cb = document.createElement('input'); cb.type = 'checkbox'; cb.checked = !!selected[d.code]; cb.value = d.code;
        cb.addEventListener('change', function () { selected[d.code] = cb.checked; renderChips(); });
        row.appendChild(cb);
        row.appendChild(el('span', 'alerts-item-code', d.code));
        row.appendChild(el('span', 'alerts-item-name', d.nom));
        list.appendChild(row);
      });
    }
    function syncChecks() {
      var boxes = list.querySelectorAll('input[type=checkbox]');
      for (var i = 0; i < boxes.length; i++) boxes[i].checked = !!selected[boxes[i].value];
    }
    search.addEventListener('input', renderList);

    var actions = el('div', 'account-actions');
    var save = el('button', 'account-btn account-btn-full', opts.isSubscribed ? 'Mettre à jour' : 'Activer les alertes'); save.type = 'button';
    actions.appendChild(save);
    var off = null;
    if (opts.isSubscribed) { off = el('button', 'account-btn ghost', 'Désactiver'); off.type = 'button'; actions.appendChild(off); }
    wrap.appendChild(actions);

    if (opts.isSubscribed) {
      var test = el('button', 'account-link', 'Envoyer une notification de test'); test.type = 'button';
      test.addEventListener('click', function () {
        test.disabled = true;
        ctx.jsend('/api/push/test', 'POST').then(function (r) {
          test.disabled = false;
          if (r && r.ok && r.sent > 0) toast('Notification de test envoyée ✓');
          else toast((r && r.error) || 'Aucun appareil n\'a reçu le test.', 3200);
        }, function () { test.disabled = false; toast('Échec de l\'envoi du test.'); });
      });
      wrap.appendChild(test);
    }

    function resetSave() { save.disabled = false; save.textContent = opts.isSubscribed ? 'Mettre à jour' : 'Activer les alertes'; }

    save.addEventListener('click', function () {
      err.textContent = '';
      var codes = selectedCodes();
      if (!codes.length) { err.textContent = 'Choisis au moins un département.'; return; }
      save.disabled = true; save.textContent = '…';
      enable(ctx, opts.vapidKey, codes).then(function (r) {
        if (r && r.ok) { toast(opts.isSubscribed ? 'Alertes mises à jour ✓' : 'Alertes activées ✓'); load(wrap, ctx); }
        else { resetSave(); err.textContent = (r && r.error) || 'Échec de l\'activation.'; }
      }, function (e) { resetSave(); err.textContent = permissionMessage(e); });
    });
    if (off) off.addEventListener('click', function () {
      off.disabled = true;
      disable(ctx).then(function () { toast('Alertes désactivées'); load(wrap, ctx); }, function () { off.disabled = false; });
    });

    renderChips(); renderList();
  }

  W.ObjectiFoudrePush = { renderSection: renderSection, supported: supported };
})();
