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

  function secret() { try { return localStorage.getItem('objfAdminSecret') || ''; } catch (_) { return ''; } }
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }

  function openPage() {
    page.setAttribute('aria-hidden', 'false');
    load();
    if (timer) clearInterval(timer);
    timer = window.setInterval(load, 15000);
  }
  function closePage() {
    page.setAttribute('aria-hidden', 'true');
    if (timer) { clearInterval(timer); timer = null; }
  }
  openBtn?.addEventListener('click', openPage);
  closeBtn?.addEventListener('click', closePage);
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && page.getAttribute('aria-hidden') === 'false') closePage(); });

  async function load() {
    const mine = ++token;
    try {
      const r = await fetch(`/api/server/telemetry?secret=${encodeURIComponent(secret())}`);
      if (mine !== token) return;
      if (!r.ok) {
        grid.innerHTML = card('Accès refusé', `<div class="mnt-err">Télémétrie inaccessible (HTTP ${r.status}). Le mode admin est requis : visite <code>/?admin=&lt;secret&gt;</code>.</div>`, 'bad');
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
  function card(title, body, level) {
    return `<section class="mnt-card${level ? ' mnt-card-' + level : ''}"><h3 class="mnt-card-title">${level ? dot(level) : ''}${esc(title)}</h3>${body}</section>`;
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

  // ── Rendu de la mosaïque ────────────────────────────────────────────────────
  function render(d) {
    const cards = [];

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

    // Pied : version + horodatage serveur
    cards.push(card('Serveur', rows([
      ['Version', d.version],
      ['Horodatage', d.at ? new Date(d.at * 1000).toLocaleString('fr-FR') : '—'],
    ])));

    grid.innerHTML = cards.join('');
  }
})();
