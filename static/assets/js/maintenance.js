// maintenance.js — Page « Télémétrie & maintenance » (admin uniquement).
// Panneau de contrôle en mosaïque : santé des sources temps réel, auto-calibration,
// mémoire, historique, préchargement AROME/ARPEGE par jour. Lecture seule (incrément 1) ;
// logs + actions + mini-terminal viendront en incrément 2.
(function () {
  const page = document.getElementById('maintenancePage');
  if (!page) return;
  const openBtn = document.getElementById('maintenancePageBtn');
  const closeBtn = document.getElementById('maintenancePageCloseBtn');
  const grid = document.getElementById('maintenanceGrid');
  const refreshEl = document.getElementById('maintenanceRefresh');
  let timer = null;
  let token = 0;

  // Admin = compte connecté (cookie de session, envoyé d'office). Plus de secret d'URL.
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }

  let logTimer = null;
  function isAdmin() { try { return document.documentElement.classList.contains('objf-admin'); } catch (e) { return false; } }
  function openPage() {
    if (!isAdmin()) return;   // défense : la page maintenance n'est accessible qu'en compte admin
    page.setAttribute('aria-hidden', 'false');
    load();
    loadLogs();
    if (timer) clearInterval(timer);
    timer = window.setInterval(load, 15000);
    if (logTimer) clearInterval(logTimer);
    logTimer = window.setInterval(loadLogs, 8000);
  }
  function closePage() {
    page.setAttribute('aria-hidden', 'true');
    if (timer) { clearInterval(timer); timer = null; }
    if (logTimer) { clearInterval(logTimer); logTimer = null; }
  }
  openBtn?.addEventListener('click', openPage);
  closeBtn?.addEventListener('click', closePage);
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && page.getAttribute('aria-hidden') === 'false') closePage(); });
  // Perte de l'accès admin (déconnexion) → fermer la page maintenance si elle est ouverte.
  document.addEventListener('of-admin-changed', (e) => { if (!(e.detail && e.detail.admin)) closePage(); });

  async function load() {
    const mine = ++token;
    try {
      const r = await fetch(`/api/server/telemetry`);
      if (mine !== token) return;
      if (!r.ok) {
        grid.innerHTML = card('Accès refusé', `<div class="mnt-err">Télémétrie inaccessible (HTTP ${r.status}). Connecte-toi avec ton compte administrateur pour accéder à la maintenance.</div>`, 'bad');
        if (refreshEl) refreshEl.textContent = '';
        return;
      }
      const d = await r.json();
      if (mine !== token) return;
      render(d);
      if (refreshEl) refreshEl.textContent = 'à jour · ' + new Date().toLocaleTimeString('fr-FR');
    } catch (_) {
      if (refreshEl) refreshEl.textContent = 'hors ligne';
    }
  }

  // ── Helpers de rendu ────────────────────────────────────────────────────────
  function dot(level) { return `<span class="mnt-dot mnt-dot-${level}"></span>`; }
  function card(title, body, level, extra) {
    return `<section class="mnt-card${level ? ' mnt-card-' + level : ''}${extra ? ' ' + extra : ''}"><h3 class="mnt-card-title">${level ? dot(level) : ''}${esc(title)}</h3>${body}</section>`;
  }
  function rows(pairs) {
    return '<ul class="mnt-rows">' + pairs.filter(Boolean).map(([k, v, cls]) =>
      `<li><span>${esc(k)}</span><strong${cls ? ` class="${cls}"` : ''}>${v == null || v === '' ? '—' : esc(v)}</strong></li>`).join('') + '</ul>';
  }
  function bar(ok, total) {
    const pct = total > 0 ? Math.round((ok / total) * 100) : 0;
    const lvl = pct >= 100 ? 'ok' : (pct > 0 ? 'warn' : 'idle');
    return `<div class="mnt-bar mnt-bar-${lvl}" title="${ok}/${total}"><i style="width:${pct}%"></i></div>`;
  }
  function freshLevel(min, warnAt, badAt) {
    if (min == null) return 'idle';
    if (min > badAt) return 'bad';
    if (min > warnAt) return 'warn';
    return 'ok';
  }
  function fmtMin(min) { return min == null ? '—' : (min < 60 ? `${min} min` : `${(min / 60).toFixed(1)} h`); }
  function skillCsi(s) {
    if (s == null) return '—';
    if (typeof s !== 'object') return String(s);
    const b = s.baseline && s.baseline.csi;
    const a = (s.active && s.active.csi) ?? (s.candidate && s.candidate.csi);
    if (a != null && b != null) return `CSI ${(+a).toFixed(3)} vs base ${(+b).toFixed(3)}`;
    if (b != null) return `CSI ${(+b).toFixed(3)} (base)`;
    return '—';
  }

  // ── Outils admin : les URL que je donne à ouvrir à la main ─────────────────
  // Uniquement des LECTURES (GET) : rien ici ne modifie l'état du serveur. Les actions
  // (purge mémoire, réentraînement, préchargement) restent où elles sont.
  const OUTILS = [
    { id: 'shadow-rebase', label: 'Ré-ancrage p90', url: '/api/server/shadow-rebase', lent: true,
      desc: 'Courbe quantile→quantile + seuil, depuis le mode ombre. C\'est ce JSON qu\'il faut me coller le jour de la bascule.' },
    { id: 'shadow-rebase-rapide', label: 'Ré-ancrage p90 (sans le seuil)', url: '/api/server/shadow-rebase?threshold=0',
      desc: 'Même chose en sautant la partie lente : utile pour vérifier où en est la collecte.' },
    { id: 'gii-shadow', label: 'Ombre GII', url: '/api/server/gii-shadow',
      desc: 'Le trou de couverture satellite devance-t-il le premier écho radar ?' },
    { id: 'memory-status', label: 'Mémoire serveur (détail)', url: '/api/server/memory-status',
      desc: 'Occupation détaillée, au-delà du résumé affiché plus haut.' },
    { id: 'history-inventory', label: 'Inventaire de l\'historique', url: '/api/history/inventory',
      desc: 'Ce que contient réellement le volume durable, jour par jour.' },
    { id: 'nwp-models', label: 'Modèles numériques', url: '/api/server/nwp-models',
      desc: 'État des modèles disponibles et de leurs échéances.' },
    { id: 'accounts', label: 'Comptes', url: '/api/server/accounts',
      desc: 'Liste des comptes créés (sans mot de passe, évidemment).' },
    { id: 'spots-pending', label: 'Spots en attente', url: '/api/spots/pending',
      desc: 'Les propositions de spots qui attendent ta modération.' },
  ];

  // ⚠️ La mosaïque est REPEINTE toutes les 15 s (`grid.innerHTML = …`). Le résultat d'un
  // outil serait donc effacé aussitôt, et un outil lent verrait sa sortie disparaître en
  // plein vol. On garde donc l'état hors du DOM et on le REPEINT après chaque rendu.
  let outilEtat = null;   // { label, etat, texte, ok }

  function peindreOutil() {
    const zone = document.getElementById('mntOutilOut');
    if (!zone) return;
    if (!outilEtat) { zone.hidden = true; zone.innerHTML = ''; return; }
    const e = outilEtat;
    zone.hidden = false;
    zone.innerHTML = `<div class="mnt-tool-head"><strong>${esc(e.label)}</strong>`
      + `<span class="mnt-tool-state${e.ok === false ? ' mnt-bad' : ''}">${esc(e.etat)}</span>`
      + (e.texte ? '<button type="button" class="mnt-action" id="mntOutilCopy">Copier</button>'
                 + '<button type="button" class="mnt-action" id="mntOutilClose">Fermer</button>' : '')
      + '</div>'
      + (e.texte ? `<pre class="mnt-tool-pre">${esc(e.texte)}</pre>` : '');
    document.getElementById('mntOutilClose')?.addEventListener('click', () => { outilEtat = null; peindreOutil(); });
    document.getElementById('mntOutilCopy')?.addEventListener('click', async () => {
      const b = document.getElementById('mntOutilCopy');
      try {
        await navigator.clipboard.writeText(e.texte);
        b.textContent = 'Copié';
      } catch (_) {
        // Presse-papier refusé (contexte non sécurisé, permission) : on sélectionne le
        // texte pour que Ctrl+C fonctionne quand même.
        const pre = zone.querySelector('.mnt-tool-pre');
        const sel = window.getSelection(); const rg = document.createRange();
        rg.selectNodeContents(pre); sel.removeAllRanges(); sel.addRange(rg);
        b.textContent = 'sélectionné — Ctrl+C';
      }
      setTimeout(() => { b.textContent = 'Copier'; }, 2500);
    });
  }

  async function lancerOutil(id) {
    const o = OUTILS.find(x => x.id === id);
    if (!o) return;
    outilEtat = { label: o.label, texte: '', ok: null,
      etat: 'en cours…' + (o.lent ? ' (cet outil relit des journées entières, sois patient)' : '') };
    peindreOutil();
    const t0 = performance.now();
    let texte, ok = false;
    try {
      const r = await fetch(o.url);
      const brut = await r.text();
      ok = r.ok;
      try { texte = JSON.stringify(JSON.parse(brut), null, 2); } catch (_) { texte = brut; }
      if (!ok) texte = `HTTP ${r.status}\n\n${texte}`;
    } catch (e) {
      texte = 'Échec réseau : ' + (e && e.message ? e.message : String(e));
    }
    const ms = Math.round(performance.now() - t0);
    outilEtat = { label: o.label, texte, ok,
      etat: `${ok ? 'ok' : 'échec'} · ${ms} ms · ${texte.length.toLocaleString('fr-FR')} caractères` };
    peindreOutil();
  }

  // ── Rendu de la mosaïque ────────────────────────────────────────────────────
  function render(d) {
    const cards = [];

    // Audience (carte Trello « nombre d'utilisateurs différents ») — cookieless, RGPD-clean :
    // visiteurs uniques par jour (un visiteur récurrent est compté une fois PAR jour).
    const u = d.users || {};
    if (u.error) {
      cards.push(card('Audience', `<div class="mnt-err">${esc(u.error)}</div>`, 'bad'));
    } else {
      cards.push(card('Audience · visiteurs uniques', rows([
        ["Aujourd'hui", u.today, 'mnt-strong'],
        ['Hier', u.yesterday],
        ['7 derniers jours', u.last_7d],
        ['30 derniers jours', u.last_30d],
        ['Moyenne / jour (30 j)', u.avg_30d],
        ['Meilleur jour', u.peak_day],
        ['Installés PWA (auj.)', u.installed_today],
      ]), 'ok'));
    }

    // Radar
    const rd = d.radar || {};
    const rLvl = rd.error ? 'bad' : freshLevel(rd.freshness_min, 12, 20);
    cards.push(card('Radar Météo-France', rows([
      ['Canal', rd.source === 'ciblee' ? 'ciblé (5 min)' : (rd.source === 'paquet' ? 'paquet (¼ h)' : rd.source)],
      ['Mosaïques en mémoire', rd.frames],
      ['Fraîcheur du direct', fmtMin(rd.freshness_min)],
      ['Mode chasse actif', rd.chase_active == null ? '—' : (rd.chase_active ? 'oui (orage)' : 'non (veille)')],
      rd.error ? ['Erreur', rd.error, 'mnt-bad'] : null,
    ]), rLvl));

    // AROME-PI + Nowcast
    const ap = d.aromepi || {};
    const nc = d.nowcast || {};
    const apLvl = !ap.configured ? 'idle' : (ap.ok ? 'ok' : 'bad');
    cards.push(card('AROME-PI & nowcast', rows([
      ['AROME-PI', ap.configured ? (ap.ok ? 'en ligne' : 'erreur') : 'non configuré', ap.ok ? 'mnt-ok' : (ap.configured ? 'mnt-bad' : '')],
      ['Run', ap.run],
      ['Échéances', ap.leads],
      ['Blend / Pont', `${(nc.blend || {}).frames ?? '—'} / ${(nc.bridge || {}).frames ?? '—'} frames`],
      ['Pont (calcul)', (nc.bridge || {}).compute_s != null ? (nc.bridge.compute_s + ' s · ' + ((nc.bridge.morph_blocks || 0) + ' blocs')) : '—'],
      ['Cellules suivies', (nc.cells || {}).count],
    ]), apLvl));

    // Foudre
    const li = d.lightning || {};
    const liLvl = !li.configured ? 'idle' : (li.error ? 'bad' : freshLevel(li.freshness_min, 15, 40));
    cards.push(card('Foudre live (MTG-LI)', rows([
      ['Statut', li.configured ? (li.ok ? 'en ligne' : 'en attente') : 'non configuré'],
      ['Impacts / 30 min', li.count_30min],
      ['Buffer', li.buffer ? li.buffer + ' impacts' : '—'],
      ['Fraîcheur', fmtMin(li.freshness_min)],
    ]), liLvl));

    // Auto-calibration
    const lg = d.learning || {};
    const dta = lg.data || {};
    const gates = lg.gates || {};
    const stLabel = { active: 'Modèle appris actif', baseline: 'Base (aucun gain)', collecting: 'Collecte en cours' }[lg.state] || lg.state;
    const lgLvl = lg.error ? 'bad' : (lg.state === 'active' ? 'ok' : (lg.state === 'baseline' ? 'ok' : 'warn'));
    cards.push(card('Auto-calibration du modèle', rows([
      ['État', stLabel, 'mnt-strong'],
      ['Jours collectés', `${dta.days ?? '—'}${gates.calib_min_days ? ' / ' + gates.calib_min_days + ' requis' : ''}`],
      ['Journées orageuses', `${dta.positives ?? '—'}${gates.calib_min_positives ? ' / ' + gates.calib_min_positives : ''}`],
      ['Skill (CSI)', skillCsi(lg.skill)],
      ['Calibré le', lg.fitted_at ? String(lg.fitted_at).slice(0, 16).replace('T', ' ') : '—'],
    ]), lgLvl));

    // Mémoire
    const mem = d.memory || {};
    const budget = mem.budget_mb || 1;
    const memLvl = mem.rss_mb == null ? 'idle' : (mem.rss_mb > 2200 ? 'bad' : (mem.rss_mb > 1600 ? 'warn' : 'ok'));
    cards.push(card('Mémoire serveur', rows([
      ['RSS process', mem.rss_mb != null ? mem.rss_mb + ' Mo' : '—', memLvl === 'bad' ? 'mnt-bad' : ''],
      ['Cache RAM', `${mem.cache_mb ?? '—'} / ${budget} Mo`],
      ['Entrées en cache', mem.cache_entries],
    ]) + bar(Math.min(budget, mem.cache_mb || 0), budget), memLvl));

    // Historique
    const h = d.history || {};
    cards.push(card('Historique & foudre observée', rows([
      ['Dates archivées', h.date_count],
      ['Plage', h.oldest && h.latest ? `${h.oldest} → ${h.latest}` : '—'],
      ['Foudre finalisée (récent)', h.past_considered ? `${h.lightning_final_recent} / ${h.past_considered} j` : '—'],
    ]), 'ok'));

    // Préchargement par jour (barres)
    const pl = d.preload || {};
    const cov = pl.coverage || [];
    let plBody;
    if (pl.error) {
      plBody = `<div class="mnt-err">${esc(pl.error)}</div>`;
    } else if (!cov.length) {
      plBody = '<div class="mnt-muted">Aucun jour préchargé (clé AROME absente ?).</div>';
    } else {
      plBody = '<ul class="mnt-preload">' + cov.map((c) =>
        `<li><span class="mnt-pl-date">${esc(c.date)}<em>${esc((c.model || '').toUpperCase())}</em></span>${bar(c.ok, c.total)}<span class="mnt-pl-count">${c.ok}/${c.total} h</span></li>`).join('') + '</ul>';
    }
    if (pl.quota_cooldown_s > 0) plBody += `<div class="mnt-muted">Quota AROME en pause : ${Math.ceil(pl.quota_cooldown_s)} s.</div>`;
    cards.push(card('Préchargement des grilles (par jour)', plBody, 'ok'));

    // Rapports de bugs / plantages (incrément 3) — résumé + bouton d'ouverture
    const rep = d.reports || {};
    const repLvl = rep.error ? 'bad' : ((rep.last_24h || 0) > 0 ? 'warn' : 'ok');
    cards.push(card('Rapports de bugs / plantages', rows([
      ['Total reçus', rep.total ?? 0],
      ['Dernières 24 h', rep.last_24h ?? 0, (rep.last_24h || 0) > 0 ? 'mnt-bad' : ''],
      ['Dernier', rep.last_at ? new Date(rep.last_at * 1000).toLocaleString('fr-FR') : '—'],
      rep.error ? ['Erreur', rep.error, 'mnt-bad'] : null,
    ]) + `<div class="mnt-actions"><button type="button" class="mnt-action" id="maintenanceReportsOpen">Voir les rapports</button></div>`, repLvl));

    // ── Clés & intégrations ──────────────────────────────────────────────────
    // ⚠️ Aucune VALEUR de secret n'arrive ici et il ne faut jamais en faire arriver :
    // le serveur ne publie que présence, provenance et empreinte (SHA-256 tronqué). Un
    // secret affiché survivrait dans l'onglet Réseau des devtools, dans une capture
    // d'écran et dans toute extension ayant accès au site.
    const integ = d.integrations || {};
    if (integ.error) {
      cards.push(card('Clés & intégrations', `<div class="mnt-err">${esc(integ.error)}</div>`, 'bad'));
    } else if (Array.isArray(integ.items)) {
      const manquantes = integ.items.filter(i => !i.configured).length;
      const incompletes = integ.items.filter(i => i.warning).length;
      const lvl = incompletes ? 'bad' : (manquantes ? 'warn' : 'ok');
      const lignes = integ.items.map(i => {
        const src = i.source
          ? (i.source.startsWith('env:')
              ? `<span class="mnt-src">${esc(i.source.slice(4))}</span>`
              : `<span class="mnt-src mnt-src-file">fichier local</span>`)
          : '<span class="mnt-src mnt-src-off">absente</span>';
        const emp = i.fingerprint ? `<code class="mnt-fp">${esc(i.fingerprint)}</code>` : '';
        const det = i.detail ? `<span class="mnt-src">${esc(i.detail)}</span>` : '';
        const warn = i.warning ? `<span class="mnt-bad"> · ${esc(i.warning)}</span>` : '';
        return `<li><span>${dot(i.configured ? (i.warning ? 'warn' : 'ok') : 'idle')}${esc(i.label)}${warn}</span>`
             + `<strong>${src}${det}${emp}</strong></li>`;
      }).join('');
      const reg = integ.reglages || {};
      const regLignes = Object.keys(reg).map(k =>
        `<li><span>${esc(k)}</span><strong>${esc(String(reg[k]))}</strong></li>`).join('');
      cards.push(card('Clés & intégrations',
        `<ul class="mnt-rows mnt-integ">${lignes}</ul>`
        + bar(integ.configured || 0, integ.total || 0)
        + (regLignes ? `<div class="mnt-subhead">Réglages</div><ul class="mnt-rows">${regLignes}</ul>` : '')
        + `<p class="mnt-note">${esc(integ.note || '')}</p>`
        + `<p class="mnt-note">Comparer une clé locale à celle de Railway, sans la révéler :<br>`
        + `<code>printf %s "$(cat 'Clef API RADAR.txt')" | sha256sum | cut -c1-8</code></p>`,
        lvl));
    }

    // ── Outils & diagnostics ─────────────────────────────────────────────────
    // Les endpoints admin que je demande d'ouvrir à la main au fil des sessions
    // (ré-ancrage p90, ombre GII, inventaire…). Un bouton par outil, le résultat
    // affiché sur place et COPIABLE — c'est ce dernier point qui compte : le JSON
    // se colle ensuite dans la conversation.
    cards.push(card('Outils & diagnostics',
      '<ul class="mnt-tools">' + OUTILS.map(o =>
        `<li><div class="mnt-tool-t"><strong>${esc(o.label)}</strong>`
        + (o.lent ? '<span class="mnt-tool-slow">lent</span>' : '')
        + `<span class="mnt-tool-d">${esc(o.desc)}</span>`
        + `<code class="mnt-tool-u">${esc(o.url)}</code></div>`
        + `<button type="button" class="mnt-action" data-outil="${esc(o.id)}">Lancer</button></li>`
      ).join('') + '</ul>'
      + '<div class="mnt-tool-out" id="mntOutilOut" hidden></div>', null, 'mnt-actions-card'));

    // Pied : version + horodatage serveur
    cards.push(card('Serveur', rows([
      ['Version', d.version],
      ['Horodatage', d.at ? new Date(d.at * 1000).toLocaleString('fr-FR') : '—'],
    ])));

    grid.innerHTML = cards.join('');
    document.getElementById('maintenanceReportsOpen')?.addEventListener('click', openReports);
    grid.querySelectorAll('[data-outil]').forEach(b =>
      b.addEventListener('click', () => lancerOutil(b.getAttribute('data-outil'))));
    peindreOutil();   // la mosaïque vient d'être repeinte : on restitue le résultat en cours
  }

  // ── Console : actions + terminal + logs ─────────────────────────────────────
  const termOut = document.getElementById('maintenanceTermOut');
  const termForm = document.getElementById('maintenanceTermForm');
  const termInput = document.getElementById('maintenanceTermInput');
  const logsBody = document.getElementById('maintenanceLogsBody');
  const logsErrors = document.getElementById('maintenanceLogsErrors');
  const history = [];
  let histPos = -1;

  function termPrint(lines, cls) {
    if (!termOut) return;
    const div = document.createElement('div');
    if (cls) div.className = cls;
    div.textContent = Array.isArray(lines) ? lines.join('\n') : String(lines);
    termOut.appendChild(div);
    termOut.scrollTop = termOut.scrollHeight;
  }

  async function runCommand(cmd, echo) {
    if (echo !== false) termPrint('› ' + cmd, 'mnt-term-cmd');
    try {
      const r = await fetch(`/api/server/command`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ cmd }),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) { termPrint(`(HTTP ${r.status}) accès refusé — mode admin requis.`, 'mnt-term-err'); return; }
      termPrint(d.lines || (d.ok ? ['ok'] : ['(pas de sortie)']), d.ok ? '' : 'mnt-term-err');
      load();       // rafraîchir la télémétrie après une action (cache/mémoire…)
      loadLogs();
    } catch (_) {
      termPrint('erreur réseau.', 'mnt-term-err');
    }
  }

  document.getElementById('maintenanceActions')?.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-cmd]');
    if (btn) runCommand(btn.dataset.cmd);
  });

  termForm?.addEventListener('submit', (e) => {
    e.preventDefault();
    const cmd = (termInput.value || '').trim();
    if (!cmd) return;
    history.push(cmd); histPos = history.length;
    termInput.value = '';
    runCommand(cmd);
  });
  termInput?.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowUp' && histPos > 0) { histPos -= 1; termInput.value = history[histPos]; e.preventDefault(); }
    else if (e.key === 'ArrowDown') { histPos = Math.min(history.length, histPos + 1); termInput.value = history[histPos] || ''; e.preventDefault(); }
  });

  const LOG_CLS = { ERROR: 'mnt-log-err', CRITICAL: 'mnt-log-err', WARNING: 'mnt-log-warn' };
  async function loadLogs() {
    if (!logsBody) return;
    const lvl = logsErrors && logsErrors.checked ? 'errors' : 'all';
    try {
      const r = await fetch(`/api/server/logs?limit=200&level=${lvl}`);
      if (!r.ok) { logsBody.innerHTML = `<div class="mnt-err">Logs inaccessibles (HTTP ${r.status}).</div>`; return; }
      const d = await r.json();
      const stick = logsBody.scrollTop + logsBody.clientHeight >= logsBody.scrollHeight - 20;
      logsBody.innerHTML = (d.logs || []).map((e) => {
        const t = new Date(e.t * 1000).toLocaleTimeString('fr-FR');
        return `<div class="mnt-log ${LOG_CLS[e.level] || ''}"><span class="mnt-log-t">${t}</span>${esc(e.msg)}</div>`;
      }).join('') || '<div class="mnt-muted">Aucune ligne.</div>';
      if (stick) logsBody.scrollTop = logsBody.scrollHeight;
    } catch (_) { /* garder l'affichage précédent */ }
  }
  logsErrors?.addEventListener('change', loadLogs);

  // ── Rapports de bugs / plantages (incrément 3) ──────────────────────────────
  const reportsPanel = document.getElementById('maintenanceReports');
  const reportsList = document.getElementById('maintenanceReportsList');
  const reportsClose = document.getElementById('maintenanceReportsClose');
  const reportsClear = document.getElementById('maintenanceReportsClear');
  const REPORT_TYPE = { crash: '💥 plantage', error: '⚠️ erreur', manual: '📝 signalé' };

  async function openReports() {
    if (!reportsPanel) return;
    reportsPanel.setAttribute('aria-hidden', 'false');
    await loadReports();
  }
  function closeReports() { reportsPanel?.setAttribute('aria-hidden', 'true'); }

  async function loadReports() {
    if (!reportsList) return;
    reportsList.innerHTML = '<div class="mnt-muted">Chargement…</div>';
    try {
      const r = await fetch(`/api/server/reports?limit=200`);
      if (!r.ok) { reportsList.innerHTML = `<div class="mnt-err">Inaccessible (HTTP ${r.status}).</div>`; return; }
      const d = await r.json();
      const items = d.reports || [];
      if (!items.length) { reportsList.innerHTML = '<div class="mnt-muted">Aucun rapport reçu. 🎉</div>'; return; }
      reportsList.innerHTML = items.map((e) => {
        const t = new Date((e.at || 0) * 1000).toLocaleString('fr-FR');
        const cnt = (e.count || 1) > 1 ? `<span class="mnt-rep-count">×${e.count}</span>` : '';
        const stack = e.stack ? `<pre class="mnt-rep-stack">${esc(e.stack)}</pre>` : '';
        return `<div class="mnt-rep">
          <div class="mnt-rep-head"><span class="mnt-rep-type">${REPORT_TYPE[e.type] || e.type}</span>${cnt}
            <span class="mnt-rep-ver">v${esc(e.version || '?')}</span><span class="mnt-rep-t">${t}</span></div>
          <div class="mnt-rep-msg">${esc(e.message)}</div>
          <div class="mnt-rep-meta">${esc(e.page || '')} · ${esc((e.ua || '').slice(0, 90))}</div>
          ${stack}</div>`;
      }).join('');
    } catch (_) { reportsList.innerHTML = '<div class="mnt-err">Erreur réseau.</div>'; }
  }

  reportsClose?.addEventListener('click', closeReports);
  reportsClear?.addEventListener('click', async () => {
    if (!window.confirm('Vider tous les rapports de bugs/plantages ?')) return;
    try {
      await fetch(`/api/server/reports/clear`, { method: 'POST' });
      await loadReports();
      load();
    } catch (_) { /* ignore */ }
  });
  reportsPanel?.addEventListener('click', (e) => { if (e.target === reportsPanel) closeReports(); });
})();
