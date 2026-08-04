/* forum.js — Forum communautaire (par thèmes). Vanilla, chargé individuellement.
   Réutilise la coquille plein-écran .prediction-page (#forumPage). Trois vues :
   accueil (thèmes + derniers messages) → liste de sujets → fil de discussion.
   Lecture publique ; publier = compte connecté ; modération = admin (objf-admin). */
(function () {
  'use strict';

  var page = document.getElementById('forumPage');
  if (!page) return;

  var openBtn = document.getElementById('forumPageBtn');
  var closeBtn = document.getElementById('forumPageCloseBtn');
  var crumbsEl = document.getElementById('forumCrumbs');
  var mainEl = document.getElementById('forumMain');
  var bodyEl = document.getElementById('forumBody');

  // ---- État ----------------------------------------------------------------
  var categories = [];      // thèmes chargés (accueil)
  var recent = [];          // derniers messages (accueil)
  var me = null;            // {pseudo} si connecté, sinon null
  var currentCat = null;    // catégorie ouverte
  var currentTopicId = null;
  var currentView = 'home'; // 'home' | 'cat' | 'thread' (pour le bouton Retour)

  // ---- Utilitaires ---------------------------------------------------------
  function escapeHtml(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (m) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m];
    });
  }
  function cssTint(t) { return /^var\(--[a-z0-9-]+\)$/i.test(String(t || '')) ? t : 'var(--accent)'; }

  var AV_GRAD = {
    cyan: 'linear-gradient(135deg,#38bdf8,#0ea5e9)',
    amber: 'linear-gradient(135deg,#fbbf24,#f59e0b)',
    green: 'linear-gradient(135deg,#4ade80,#22c55e)',
    orange: 'linear-gradient(135deg,#fb923c,#f97316)'
  };
  var AV_KEYS = ['cyan', 'amber', 'green', 'orange'];
  function avatarGrad(name) {
    var h = 0, s = String(name || '');
    for (var i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
    return AV_GRAD[AV_KEYS[h % AV_KEYS.length]];
  }
  function initials(name) {
    var s = String(name || '?').replace(/[^A-Za-zÀ-ÿ0-9]/g, '');
    return (s.slice(0, 1) || '?').toUpperCase();
  }
  function avatar(name, sz) {
    return '<span class="forum-av" style="--sz:' + sz + 'px;background:' + avatarGrad(name) + '">'
      + escapeHtml(initials(name)) + '</span>';
  }
  function relTime(iso) {
    if (!iso) return '';
    var t = Date.parse(iso);
    if (isNaN(t)) return '';
    var s = Math.max(0, (Date.now() - t) / 1000);
    if (s < 60) return "à l'instant";
    var m = Math.floor(s / 60); if (m < 60) return 'il y a ' + m + ' min';
    var h = Math.floor(m / 60); if (h < 24) return 'il y a ' + h + ' h';
    var d = Math.floor(h / 24); if (d < 30) return 'il y a ' + d + ' j';
    var mo = Math.floor(d / 30); if (mo < 12) return 'il y a ' + mo + ' mois';
    return new Date(t).toLocaleDateString('fr-FR');
  }
  function isAdmin() {
    try { return document.documentElement.classList.contains('objf-admin'); } catch (e) { return false; }
  }
  function adminSecret() {
    try { return localStorage.getItem('objfAdminSecret') || ''; } catch (e) { return ''; }
  }
  function promptLogin() { var b = document.getElementById('accountBtn'); if (b) b.click(); }
  function scrollTop() { if (bodyEl) bodyEl.scrollTop = 0; }
  function scrollBottom() { if (bodyEl) bodyEl.scrollTop = bodyEl.scrollHeight; }

  // ---- API -----------------------------------------------------------------
  function apiGet(url) {
    return fetch(url, { credentials: 'same-origin', headers: { Accept: 'application/json' } })
      .then(function (r) { return r.json(); }).catch(function () { return null; });
  }
  function apiSend(url, method, body) {
    var opt = { method: method, credentials: 'same-origin', headers: { Accept: 'application/json' } };
    if (body !== undefined) { opt.headers['Content-Type'] = 'application/json'; opt.body = JSON.stringify(body); }
    return fetch(url, opt).then(function (r) { return r.json(); }).catch(function () { return null; });
  }

  function loadingHtml() {
    return '<div class="forum-empty"><div class="forum-empty__glyph">⛈️</div>Chargement…</div>';
  }
  function errHtml(msg) {
    return '<div class="forum-empty forum-toast-err"><div class="forum-empty__glyph">⚠️</div>'
      + escapeHtml(msg || 'Erreur de chargement.') + '</div>';
  }

  // ---- Fil d'ariane --------------------------------------------------------
  function setCrumbs(items) {
    crumbsEl.hidden = false;
    var back = '<button class="forum-back" data-back="1" aria-label="Revenir à la page précédente">'
      + '<span class="forum-back__chevron" aria-hidden="true">‹</span> Retour</button>';
    crumbsEl.innerHTML = back + items.map(function (it, i) {
      var sep = i > 0 ? '<span class="forum-crumb-sep">›</span>' : '';
      if (it.here) return sep + '<span class="forum-crumb-here">' + escapeHtml(it.here) + '</span>';
      var attr = it.go === 'cat'
        ? 'data-crumb-cat="' + escapeHtml(it.catId || '') + '"'
        : 'data-crumb-go="home"';
      return sep + '<button ' + attr + '>' + escapeHtml(it.label) + '</button>';
    }).join('');
  }

  // ---- Vue : accueil -------------------------------------------------------
  function renderFeed() {
    if (!recent.length) {
      return '<div class="forum-empty"><div class="forum-empty__glyph">💬</div>Pas encore de message. Ouvrez la discussion !</div>';
    }
    return recent.map(function (f) {
      var catObj = categories.filter(function (c) { return c.id === f.category_id; })[0] || {};
      var verb = f.is_op ? 'a ouvert' : 'a répondu dans';
      return '<button class="forum-feed__row" data-thread="' + escapeHtml(f.topic_id) + '">'
        + avatar(f.author.pseudo, 32)
        + '<span class="forum-feed__txt">'
        + '<span class="forum-feed__title">' + escapeHtml(f.topic_title) + '</span>'
        + '<span class="forum-feed__sub"><b>' + escapeHtml(f.author.pseudo) + '</b> ' + verb
        + ' <span class="forum-tag">' + escapeHtml(catObj.name || '') + '</span></span>'
        + '</span>'
        + '<span class="forum-feed__when">' + relTime(f.when) + '</span>'
        + '</button>';
    }).join('');
  }

  function renderHome() {
    currentCat = null; currentTopicId = null; currentView = 'home';
    crumbsEl.hidden = true;
    var cats = categories.map(function (c) {
      var last = c.last
        ? avatar(c.last.pseudo, 20) + '<span class="forum-who">' + escapeHtml(c.last.pseudo) + '</span> · ' + relTime(c.last.when)
        : "Aucun message pour l'instant";
      return '<button class="forum-cat" data-cat="' + escapeHtml(c.id) + '" style="--tint:' + cssTint(c.tint) + '">'
        + '<span class="forum-cat__glyph">' + c.emoji + '</span>'
        + '<span>'
        + '<span class="forum-cat__name">' + escapeHtml(c.name) + '</span>'
        + '<span class="forum-cat__desc">' + escapeHtml(c.description) + '</span>'
        + '<span class="forum-cat__meta"><span><b>' + c.topic_count + '</b> sujet' + (c.topic_count > 1 ? 's' : '') + '</span>'
        + '<span><b>' + c.message_count + '</b> message' + (c.message_count > 1 ? 's' : '') + '</span></span>'
        + '</span>'
        + '<span class="forum-cat__last ' + (c.last ? '' : 'is-empty') + '">' + last + '</span>'
        + '</button>';
    }).join('');
    mainEl.innerHTML = '<div class="forum-view">'
      + '<p class="forum-lede">Échangez avec la communauté ObjectiFoudre : coordination de chasse, '
      + 'comptes rendus, spots, matériel et ciel nocturne. Choisissez un thème pour parcourir les discussions.</p>'
      + '<div class="forum-cats">' + cats + '</div>'
      + '<div class="forum-section-title">Derniers messages</div>'
      + '<div class="forum-feed">' + renderFeed() + '</div>'
      + '</div>';
  }

  // ---- Vue : liste de sujets ----------------------------------------------
  function renderCategory(cat, topics) {
    currentCat = cat; currentTopicId = null; currentView = 'cat';
    setCrumbs([{ label: 'Forum', go: 'home' }, { here: cat.name }]);
    var rows = topics.length ? topics.map(function (t) {
      var flag = t.pinned ? '📌' : (t.locked ? '🔒' : '');
      var badge = t.pinned ? '<span class="forum-badge">Épinglé</span>'
        : (t.locked ? '<span class="forum-badge">Verrouillé</span>' : '');
      return '<button class="forum-topic" data-thread="' + escapeHtml(t.id) + '">'
        + '<span class="forum-topic__flag ' + (flag ? '' : 'is-blank') + '">' + (flag || '•') + '</span>'
        + '<span class="forum-topic__main">'
        + '<span class="forum-topic__title">' + escapeHtml(t.title) + badge + '</span>'
        + '<span class="forum-topic__by">' + avatar(t.author.pseudo, 18) + ' ' + escapeHtml(t.author.pseudo)
        + ' · ' + relTime(t.created_utc) + '</span>'
        + '</span>'
        + '<span class="forum-topic__stats">'
        + '<span class="forum-chip">' + t.reply_count + ' rép.</span>'
        + '<span class="forum-topic__last">dernier · ' + relTime(t.last_post_utc) + '</span>'
        + '</span>'
        + '</button>';
    }).join('') : '<div class="forum-empty"><div class="forum-empty__glyph">' + cat.emoji
      + '</div>Aucun sujet dans ce thème. Lancez le premier&nbsp;!</div>';

    mainEl.innerHTML = '<div class="forum-view">'
      + '<div class="forum-cat-head">'
      + '<span class="forum-cat__glyph" style="--tint:' + cssTint(cat.tint) + '">' + cat.emoji + '</span>'
      + '<div class="forum-cat-head__t"><h3>' + escapeHtml(cat.name) + '</h3><p>' + escapeHtml(cat.description) + '</p></div>'
      + '<button class="forum-btn forum-btn--accent" data-newtopic-toggle>✎ Nouveau sujet</button>'
      + '</div>'
      + '<form class="forum-newtopic" id="forumNewTopic" hidden>'
      + '<div><div class="forum-field-label">Titre</div>'
      + '<input class="forum-input" id="forumNtTitle" maxlength="140" placeholder="Titre de votre sujet…" autocomplete="off" /></div>'
      + '<div><div class="forum-field-label">Message</div>'
      + '<textarea class="forum-textarea" id="forumNtBody" maxlength="5000" placeholder="Décrivez, partagez, demandez…"></textarea></div>'
      + '<div class="forum-newtopic__actions">'
      + '<span class="forum-newtopic__err" id="forumNtErr"></span>'
      + '<button type="button" class="forum-btn forum-btn--ghost" data-newtopic-cancel>Annuler</button>'
      + '<button type="submit" class="forum-btn forum-btn--accent">Publier le sujet</button>'
      + '</div></form>'
      + '<div class="forum-topics">' + rows + '</div>'
      + '</div>';
  }

  // ---- Vue : fil de discussion --------------------------------------------
  function renderThread(data) {
    var t = data.topic;
    currentTopicId = t.id; currentView = 'thread';
    var cat = data.category || currentCat || { name: 'Forum', id: null };
    if (data.category) currentCat = (currentCat && currentCat.id === data.category.id) ? currentCat : data.category;
    setCrumbs([{ label: 'Forum', go: 'home' }, { label: cat.name, go: 'cat', catId: cat.id }, { here: t.title }]);

    var admin = isAdmin();
    var modBar = admin ? '<div class="forum-post__actions" style="margin-top:10px">'
      + '<button class="forum-mod-act" data-mod-topic="' + (t.pinned ? 'unpin' : 'pin') + '">'
      + (t.pinned ? '📌 Désépingler' : '📌 Épingler') + '</button>'
      + '<button class="forum-mod-act" data-mod-topic="' + (t.locked ? 'unlock' : 'lock') + '">'
      + (t.locked ? '🔓 Déverrouiller' : '🔒 Verrouiller') + '</button>'
      + '<button class="forum-mod-act forum-danger" data-mod-topic="hide">🚫 Masquer le sujet</button>'
      + '</div>' : '';

    var posts = data.posts.map(function (p) {
      var role = p.author.is_moderator ? '<span class="forum-post__role is-mod">Modérateur</span>'
        : (p.is_op_author ? '<span class="forum-post__role">Auteur</span>' : '');
      var actions = ['<button class="forum-like ' + (p.liked ? 'is-on' : '') + '" data-like="' + escapeHtml(p.id) + '">👍 <span>' + p.like_count + '</span></button>'];
      if (data.me && !t.locked) actions.push('<button data-reply="1">↩ Répondre</button>');
      if (p.mine) actions.push('<button class="forum-danger" data-del="' + escapeHtml(p.id) + '">🗑 Supprimer</button>');
      if (admin && !p.mine) actions.push('<button class="forum-mod-act" data-hide="' + escapeHtml(p.id) + '">🚫 Masquer</button>');
      return '<article class="forum-post ' + (p.is_op ? 'is-op' : '') + '">'
        + avatar(p.author.pseudo, 38)
        + '<div>'
        + '<header class="forum-post__head">'
        + '<span class="forum-post__who">' + escapeHtml(p.author.pseudo) + '</span>' + role
        + '<span class="forum-post__when">' + relTime(p.created_utc) + '</span>'
        + '</header>'
        + '<div class="forum-post__text">' + escapeHtml(p.body) + '</div>'
        + '<footer class="forum-post__actions">' + actions.join('') + '</footer>'
        + '</div></article>';
    }).join('');

    var composer;
    if (t.locked) {
      composer = '<div class="forum-locked-note">🔒 Ce sujet est verrouillé — vous ne pouvez plus y répondre.</div>';
    } else if (data.me) {
      composer = '<form class="forum-composer" id="forumReplyForm">'
        + avatar(data.me.pseudo, 34)
        + '<textarea id="forumReplyBody" maxlength="5000" placeholder="Écrire une réponse…  (connecté en tant que '
        + escapeHtml(data.me.pseudo) + ')"></textarea>'
        + '<button class="forum-btn forum-btn--accent" type="submit">Publier</button>'
        + '<div class="forum-composer__err" id="forumReplyErr"></div>'
        + '</form>';
    } else {
      composer = '<div class="forum-locked-note">Connectez-vous pour participer à la discussion.'
        + '<button class="forum-btn forum-btn--accent" data-login>Se connecter</button></div>';
    }

    mainEl.innerHTML = '<div class="forum-view">'
      + '<div class="forum-thread-head"><h3>' + escapeHtml(t.title) + '</h3>'
      + '<div class="forum-thread-meta">'
      + '<span class="forum-k">💬 ' + t.reply_count + (t.reply_count > 1 ? ' réponses' : ' réponse') + '</span>'
      + '<span class="forum-k">👁 ' + t.view_count + ' vues</span>'
      + '<span class="forum-k">🕑 dernier ' + relTime(t.last_post_utc) + '</span>'
      + (t.locked ? '<span class="forum-k forum-locked">🔒 Verrouillé</span>' : '')
      + '</div>' + modBar + '</div>'
      + '<div class="forum-posts">' + posts + '</div>'
      + composer
      + '</div>';
  }

  // ---- Chargements ---------------------------------------------------------
  function loadHome() {
    mainEl.innerHTML = loadingHtml();
    crumbsEl.hidden = true;
    return Promise.all([apiGet('/api/forum/categories'), apiGet('/api/forum/recent')])
      .then(function (r) {
        var c = r[0], rec = r[1];
        if (c && c.ok) { categories = c.categories || []; me = c.me; }
        recent = (rec && rec.ok) ? rec.items : [];
        if (c && c.ok) renderHome(); else mainEl.innerHTML = errHtml(c && c.error);
        scrollTop();
      });
  }
  function openCategory(catId) {
    if (!catId) { loadHome(); return; }
    mainEl.innerHTML = loadingHtml();
    apiGet('/api/forum/category/' + encodeURIComponent(catId) + '/topics').then(function (res) {
      if (!res || !res.ok) { mainEl.innerHTML = errHtml(res && res.error); return; }
      me = res.me;
      renderCategory(res.category, res.topics || []);
      scrollTop();
    });
  }
  function openThread(topicId, toBottom) {
    mainEl.innerHTML = loadingHtml();
    apiGet('/api/forum/topic/' + encodeURIComponent(topicId)).then(function (res) {
      if (!res || !res.ok) { mainEl.innerHTML = errHtml(res && res.error); return; }
      me = res.me;
      renderThread(res);
      if (toBottom) scrollBottom(); else scrollTop();
    });
  }

  function goBack() {
    // Remonte d'un niveau : discussion → thème → accueil.
    if (currentView === 'thread') { currentCat ? openCategory(currentCat.id) : loadHome(); }
    else { loadHome(); }
  }

  // ---- Actions -------------------------------------------------------------
  function submitNewTopic() {
    var titleEl = document.getElementById('forumNtTitle');
    var bodyIn = document.getElementById('forumNtBody');
    var err = document.getElementById('forumNtErr');
    if (!titleEl || !bodyIn) return;
    err.textContent = '';
    var title = titleEl.value.trim(), body = bodyIn.value.trim();
    if (!title || !body) { err.textContent = 'Titre et message requis.'; return; }
    apiSend('/api/forum/topic', 'POST', { category_id: currentCat.id, title: title, body: body }).then(function (res) {
      if (!res || !res.ok) { err.textContent = (res && res.error) || 'Échec de la publication.'; return; }
      openThread(res.topic_id);
    });
  }
  function submitReply() {
    var ta = document.getElementById('forumReplyBody');
    var err = document.getElementById('forumReplyErr');
    if (!ta) return;
    if (err) err.textContent = '';
    var body = ta.value.trim();
    if (!body) return;
    ta.disabled = true;
    apiSend('/api/forum/topic/' + encodeURIComponent(currentTopicId) + '/reply', 'POST', { body: body }).then(function (res) {
      if (!res || !res.ok) {
        ta.disabled = false;
        if (res && res.error === 'Connexion requise pour répondre.') { promptLogin(); return; }
        if (err) err.textContent = (res && res.error) || 'Échec de l’envoi.';
        return;
      }
      openThread(currentTopicId, true);
    });
  }
  function toggleLike(postId, btn) {
    apiSend('/api/forum/post/' + encodeURIComponent(postId) + '/like', 'POST', {}).then(function (res) {
      if (!res || !res.ok) { if (res && res.error === 'Connexion requise.') promptLogin(); return; }
      btn.classList.toggle('is-on', res.liked);
      var span = btn.querySelector('span'); if (span) span.textContent = res.like_count;
    });
  }
  function deletePost(postId) {
    if (!window.confirm('Supprimer ce message ?')) return;
    apiSend('/api/forum/post/' + encodeURIComponent(postId), 'DELETE').then(function (res) {
      if (!res || !res.ok) { return; }
      if (res.topic_removed) { currentCat ? openCategory(currentCat.id) : loadHome(); }
      else openThread(currentTopicId);
    });
  }
  function moderateTopic(action) {
    var url = '/api/forum/topic/' + encodeURIComponent(currentTopicId) + '/moderate?action='
      + encodeURIComponent(action) + '&secret=' + encodeURIComponent(adminSecret());
    apiSend(url, 'POST', {}).then(function (res) {
      if (!res || res.ok === false) { window.alert((res && res.error) || 'Échec de la modération.'); return; }
      if (action === 'hide') { currentCat ? openCategory(currentCat.id) : loadHome(); }
      else openThread(currentTopicId);
    });
  }
  function hidePost(postId) {
    var url = '/api/forum/post/' + encodeURIComponent(postId) + '/hide?secret=' + encodeURIComponent(adminSecret());
    apiSend(url, 'POST', {}).then(function (res) {
      if (!res || !res.ok) { window.alert((res && res.error) || 'Échec.'); return; }
      openThread(currentTopicId);
    });
  }

  // ---- Délégation clics / soumissions --------------------------------------
  page.addEventListener('click', function (e) {
    if (e.target === page) { closeForum(); return; }
    var el = e.target.closest('[data-back],[data-cat],[data-thread],[data-crumb-go],[data-crumb-cat],'
      + '[data-newtopic-toggle],[data-newtopic-cancel],[data-like],[data-del],[data-reply],'
      + '[data-login],[data-mod-topic],[data-hide]');
    if (!el) return;
    var d = el.dataset;
    if (d.back != null) { goBack(); }
    else if (d.cat != null) { openCategory(d.cat); }
    else if (d.thread != null) { openThread(d.thread); }
    else if (d.crumbGo != null) { loadHome(); }
    else if (d.crumbCat != null) { openCategory(d.crumbCat); }
    else if (d.newtopicToggle != null) {
      if (!me) { promptLogin(); return; }
      var f = document.getElementById('forumNewTopic');
      if (f) { f.hidden = !f.hidden; if (!f.hidden) { var ti = document.getElementById('forumNtTitle'); if (ti) ti.focus(); } }
    }
    else if (d.newtopicCancel != null) { var ff = document.getElementById('forumNewTopic'); if (ff) ff.hidden = true; }
    else if (d.like != null) { toggleLike(d.like, el); }
    else if (d.del != null) { deletePost(d.del); }
    else if (d.reply != null) { var ta = document.getElementById('forumReplyBody'); if (ta) { ta.focus(); } }
    else if (d.login != null) { promptLogin(); }
    else if (d.modTopic != null) { moderateTopic(d.modTopic); }
    else if (d.hide != null) { hidePost(d.hide); }
  });

  page.addEventListener('submit', function (e) {
    if (e.target.id === 'forumNewTopic') { e.preventDefault(); submitNewTopic(); }
    else if (e.target.id === 'forumReplyForm') { e.preventDefault(); submitReply(); }
  });

  // ---- Ouverture / fermeture ----------------------------------------------
  function openForum() {
    page.setAttribute('aria-hidden', 'false');
    document.body.classList.add('forum-open');
    loadHome();
  }
  function closeForum() {
    page.setAttribute('aria-hidden', 'true');
    document.body.classList.remove('forum-open');
  }
  if (openBtn) openBtn.addEventListener('click', openForum);
  if (closeBtn) closeBtn.addEventListener('click', closeForum);
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && page.getAttribute('aria-hidden') === 'false') closeForum();
  });

  // Expose l'ouverture (au cas où un autre point d'entrée voudrait l'appeler).
  window.openForumPage = openForum;
})();
