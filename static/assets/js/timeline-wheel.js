// timeline-wheel.js — issu du découpage de timeline.js (Phase 3).
// Molette de créneaux (scroll/snap/centrage) + buildTimelineWheel + renderSlotButtons.
    // ── Wheel scroll state ──────────────────────────────────────────────────
    let wheelSnapTimer = null;
    let wheelProgrammatic = false;
    let wheelActiveSlotKey = null;
    // Horodatage de la dernière manipulation UTILISATEUR de la molette (geste
    // tactile / scroll non programmatique). Tant que c'est récent, on DIFFÈRE
    // les rebuilds de renderSlotButtons : de nombreux chargements asynchrones
    // (GRIB, hydratation, lecture) re-render la frise, et le rAF de fin de
    // render re-scrolle la molette sur le slot sélectionné → en plein geste, la
    // molette « se téléporte » en arrière (aimantation excessive signalée sur
    // mobile). La frise chasse n'a pas ce problème : elle n'est jamais
    // reconstruite pendant le geste.
    let wheelUserLastAt = 0;
    let wheelRenderRetryTimer = null;
    let lastRenderSig = null;   // signature du dernier rendu (anti-rebuild inutile)
    function timelineWheelUserBusy() {
      return (performance.now() - wheelUserLastAt) < 700;
    }

    // ── Debug TEMPORAIRE (?frisedebug=1) : overlay à l'écran — diagnostic du
    // « rebond » signalé sur Firefox vue téléphone, que Chromium ne reproduit
    // pas. Enregistre EN SILENCE pendant le geste puis FIGE le log complet du
    // geste une fois l'accalmie venue (lisible, appui = copie presse-papier).
    // À RETIRER. ──
    const wheelDebugEl = (() => {
      try {
        if (!/frisedebug/.test(location.search)) return null;
        const el = document.createElement('div');
        el.style.cssText = 'position:fixed;left:4px;top:4px;z-index:99999;background:rgba(0,0,0,.9);color:#e2eefc;font:11px/1.55 monospace;padding:7px 9px;border-radius:8px;max-width:92vw;max-height:70vh;overflow:auto;white-space:pre;border:1px solid #7dd3fc;';
        el.textContent = 'frise-debug prêt — fais ton geste';
        el.addEventListener('click', () => {
          const txt = wheelDbgBuffer.join('\n');
          try { navigator.clipboard.writeText(txt); el.style.borderColor = '#4ade80'; setTimeout(() => { el.style.borderColor = '#7dd3fc'; }, 600); } catch (_) {}
        });
        (document.body || document.documentElement).appendChild(el);
        return el;
      } catch (_) { return null; }
    })();
    let wheelDbgBuffer = [];      // log du geste courant
    let wheelDbgFreezeTimer = null;
    let wheelDbgRecording = false;
    function wheelDbg(msg) {
      if (!wheelDebugEl) return;
      const t = (performance.now() / 1000).toFixed(2);
      // pointerdown/touchstart = début d'un NOUVEAU geste → on repart de zéro
      if (/^(pointerdown|touchstart)/.test(msg) && !wheelDbgRecording) {
        wheelDbgBuffer = [];
        wheelDbgRecording = true;
        wheelDebugEl.textContent = '⏺ enregistrement…';
      }
      wheelDbgBuffer.push(t + ' ' + msg);
      if (wheelDbgBuffer.length > 60) wheelDbgBuffer.shift();
      // On FIGE l'affichage 900 ms après le DERNIER événement (fin du geste +
      // inertie + snap) → texte stable, lisible.
      if (wheelDbgFreezeTimer) clearTimeout(wheelDbgFreezeTimer);
      wheelDbgFreezeTimer = setTimeout(() => {
        wheelDbgRecording = false;
        wheelDebugEl.textContent = '── geste (appui = copier) ──\n' + wheelDbgBuffer.join('\n');
      }, 900);
    }

    // O(1) : trouve l'index de l'item centré via scrollLeft arithmétique
    // Utilisé uniquement au commit (après scroll terminé), getBoundingClientRect fiable
    function wheelCenteredItem(scroller) {
      if (!scroller.isConnected) return null;
      const rect = scroller.getBoundingClientRect();
      const cx = rect.left + rect.width / 2;
      let best = null, bestDist = Infinity;
      for (const item of scroller.querySelectorAll('.timeline-wheel-item:not(:disabled)')) {
        const ir = item.getBoundingClientRect();
        const dist = Math.abs(ir.left + ir.width / 2 - cx);
        if (dist < bestDist) { best = item; bestDist = dist; }
      }
      return best;
    }

    // Met à jour uniquement les deux items concernés (ancien actif → nouveau)
    function wheelSetActive(scroller, slotKey) {
      if (slotKey === wheelActiveSlotKey) return;
      if (wheelActiveSlotKey) {
        const prev = scroller.querySelector(`[data-slot-key="${wheelActiveSlotKey}"]`);
        if (prev) { prev.classList.remove('active'); prev.setAttribute('aria-selected', 'false'); }
      }
      const next = scroller.querySelector(`[data-slot-key="${slotKey}"]`);
      if (next) { next.classList.add('active'); next.setAttribute('aria-selected', 'true'); }
      wheelActiveSlotKey = slotKey;
    }

    // Snap vers un slot — easeOutQuart (aimant : décélération rapide vers la cible)
    // Renvoie true si un déplacement a été (ou est) réellement effectué.
    function wheelScrollTo(scroller, slotKey, animated) {
      if (!scroller.isConnected) return false;
      const item = scroller.querySelector(`[data-slot-key="${slotKey}"]`);
      if (!item) return false;
      const sr = scroller.getBoundingClientRect();
      const ir = item.getBoundingClientRect();
      const target = Math.max(0, scroller.scrollLeft + ir.left - sr.left - sr.width / 2 + ir.width / 2);

      // DÉJÀ centré (<1px) : NE RIEN écrire. Réécrire scrollLeft (même une no-op)
      // déclenche un `scrollend` sur Firefox → wheelCommit → wheelScrollTo →
      // boucle infinie de snap (tremblement + molette bloquée sur l'heure
      // présélectionnée, cf. log Firefox : scrollend→commit en continu). Chromium
      // ne déclenche pas ce scrollend, d'où l'invisibilité du bug côté tests.
      if (Math.abs(target - scroller.scrollLeft) < 1) return false;

      if (!animated) {
        // Écriture instantanée gardée : le `scrollend` qui en découle doit être
        // ignoré (wheelProgrammatic) pour ne pas relancer un commit. Reset après
        // 2 frames pour couvrir le scrollend asynchrone de Firefox.
        wheelProgrammatic = true;
        scroller.scrollLeft = target;
        requestAnimationFrame(() => requestAnimationFrame(() => { wheelProgrammatic = false; }));
        return true;
      }

      const startLeft = scroller.scrollLeft;
      const distance = target - startLeft;
      const duration = 220;
      const startTime = performance.now();

      wheelProgrammatic = true;
      function step(now) {
        if (!scroller.isConnected) { wheelProgrammatic = false; return; }
        const t = Math.min((now - startTime) / duration, 1);
        const ease = 1 - Math.pow(1 - t, 4); // easeOutQuart
        scroller.scrollLeft = startLeft + distance * ease;
        if (t < 1) { requestAnimationFrame(step); }
        // Fin d'anim : garder le drapeau prog encore 2 frames pour absorber le
        // `scrollend` de fin (Firefox), sinon il relance un commit.
        else { scroller.scrollLeft = target; requestAnimationFrame(() => requestAnimationFrame(() => { wheelProgrammatic = false; })); }
      }
      requestAnimationFrame(step);
      return true;
    }

    function wheelCommit(scroller) {
      if (!scroller.isConnected) return;
      const item = wheelCenteredItem(scroller);
      if (!item) return;
      const slotKey = item.dataset.slotKey;
      wheelSetActive(scroller, slotKey);
      const moved = wheelScrollTo(scroller, slotKey, true);
      const changed = slotKey !== selectedSlotKey;
      wheelDbg('commit ' + slotKey + ' (sel=' + selectedSlotKey + ') moved=' + moved);
      // Rien n'a bougé ET déjà sur le bon créneau → NE RIEN relancer (ni select
      // ni chargement) : c'est le cas de la boucle scrollend résiduelle.
      if (!changed && !moved) return;
      if (changed && typeof selectTimelineSlot === 'function') {
        selectTimelineSlot(slotKey, { render: false, stopPlayback: true, loadCached: true });
      }
      if (typeof maybeLoadCachedMeteoFranceGribForSelectedSlot === 'function') {
        maybeLoadCachedMeteoFranceGribForSelectedSlot({ quiet: true });
      }
    }

    function wheelScheduleSnap(scroller, delay = 150) {
      if (wheelSnapTimer) clearTimeout(wheelSnapTimer);
      wheelSnapTimer = setTimeout(() => { wheelSnapTimer = null; wheelCommit(scroller); }, delay);
    }

    function syncTimelineWheelScrollToSelected({ smooth = false } = {}) {
      const scroller = slotButtons?.querySelector?.('.timeline-wheel-scroller');
      if (!scroller) return;
      wheelDbg('SYNC→' + selectedSlotKey);
      wheelScrollTo(scroller, selectedSlotKey, smooth);
    }

    function buildTimelineWheel(slots, day) {
      wheelActiveSlotKey = selectedSlotKey || null;

      const wheel = document.createElement('div');
      wheel.className = 'timeline-wheel';
      wheel.setAttribute('aria-hidden', 'false');

      const scroller = document.createElement('div');
      scroller.className = 'timeline-wheel-scroller';
      scroller.setAttribute('role', 'listbox');
      scroller.setAttribute('aria-label', 'Heure affichée');

      const phases = timelinePhaseMapForSlots(day?.day_key || selectedBaseDate, slots, day);
      for (const slot of slots) {
        const hasAromeCache = typeof meteoFranceGribCachedSlotKeys !== 'undefined' && meteoFranceGribCachedSlotKeys.has(slot.slot_key);
        const isAromeLoaded = Array.isArray(slot.cells) && slot.cells.some((cell) => cell?.source_provider === 'meteofrance_arome_grib');
        const isUnavailable = timelineSlotIsUnavailable(slot, day);
        const hourText = timelineSlotHourLabel(slot);
        const phase = phases.get(slot.slot_key);
        const item = document.createElement('button');
        item.type = 'button';
        item.className = [
          'timeline-wheel-item',
          slot.slot_key === selectedSlotKey ? 'active' : '',
          hasAromeCache ? 'is-arome-cached' : '',
          isAromeLoaded ? 'is-arome-loaded' : '',
          isUnavailable ? 'is-arome-unavailable' : '',
        ].filter(Boolean).join(' ');
        item.dataset.slotKey = slot.slot_key;
        item.setAttribute('role', 'option');
        item.setAttribute('aria-selected', slot.slot_key === selectedSlotKey ? 'true' : 'false');
        item.setAttribute('aria-label', `${String(hourText).padStart(2, '0')}h`);
        item.title = isUnavailable
          ? `${slot.slot_label} · échéance non publiée par le run AROME`
          : (isAromeLoaded
            ? `${slot.slot_label} · AROME GRIB chargé`
            : (hasAromeCache ? `${slot.slot_label} · AROME GRIB en cache serveur` : slot.slot_label));
        if (isUnavailable) item.disabled = true;
        if (phase) {
          const phaseIcon = document.createElement('span');
          phaseIcon.className = [`timeline-wheel-light-icon`, `timeline-wheel-light-icon-${phase.type}`, phase.unavailable ? 'is-arome-unavailable' : ''].filter(Boolean).join(' ');
          phaseIcon.dataset.tooltip = phase.tooltip;
          phaseIcon.innerHTML = timelinePhaseIconSvg(phase.type);
          item.appendChild(phaseIcon);
        }
        const line = document.createElement('span');
        line.className = 'timeline-wheel-line';
        const label = document.createElement('span');
        label.className = 'timeline-wheel-label';
        label.textContent = hourText;
        item.appendChild(line);
        item.appendChild(label);
        item.addEventListener('click', (event) => {
          event.preventDefault();
          event.stopPropagation();
          if (isUnavailable) return;
          // Annule le snap en attente (évite snap sur ancien scroller après re-render)
          if (wheelSnapTimer) { clearTimeout(wheelSnapTimer); wheelSnapTimer = null; }
          if (typeof selectTimelineSlot === 'function') selectTimelineSlot(slot.slot_key, { stopPlayback: true });
        });
        scroller.appendChild(item);
      }

      // Mise à jour visuelle pendant le scroll — throttlée rAF, O(1) par index
      const visibleHours = 8;
      let scrollRafId = null;
      // Marque le début de geste (le scroll seul ne suffit pas : il peut être
      // déclenché par l'inertie APRÈS relâcher, mais c'est voulu — l'inertie
      // fait partie du geste utilisateur).
      scroller.addEventListener('pointerdown', (e) => { wheelUserLastAt = performance.now(); wheelDbg('pointerdown ' + e.pointerType); }, { passive: true });
      scroller.addEventListener('touchstart', () => { wheelUserLastAt = performance.now(); wheelDbg('touchstart'); }, { passive: true });
      if (wheelDebugEl) {
        scroller.addEventListener('pointerup', (e) => wheelDbg('pointerup ' + e.pointerType), { passive: true });
        scroller.addEventListener('pointercancel', (e) => wheelDbg('pointercancel ' + e.pointerType), { passive: true });
        let dbgScrollRaf = 0;
        scroller.addEventListener('scroll', () => {
          if (dbgScrollRaf) return;
          dbgScrollRaf = requestAnimationFrame(() => { dbgScrollRaf = 0; wheelDbg('scroll sl=' + Math.round(scroller.scrollLeft) + (wheelProgrammatic ? ' (prog)' : '')); });
        }, { passive: true });
      }

      scroller.addEventListener('scroll', () => {
        if (wheelProgrammatic) return;
        wheelUserLastAt = performance.now();
        if (scrollRafId) return;
        scrollRafId = requestAnimationFrame(() => {
          scrollRafId = null;
          if (!scroller.isConnected) return;
          const itemWidth = scroller.clientWidth / visibleHours;
          if (!itemWidth) return;
          const idx = Math.max(0, Math.min(
            Math.round(scroller.scrollLeft / itemWidth),
            scroller.querySelectorAll('.timeline-wheel-item').length - 1
          ));
          const items = scroller.querySelectorAll('.timeline-wheel-item');
          if (items[idx]) wheelSetActive(scroller, items[idx].dataset.slotKey);
        });
      }, { passive: true });

      // Primary: scrollend fire après que l'inertie soit terminée
      scroller.addEventListener('scrollend', () => {
        wheelDbg('scrollend' + (wheelProgrammatic ? ' (prog)' : ''));
        if (wheelProgrammatic) return;
        if (wheelSnapTimer) { clearTimeout(wheelSnapTimer); wheelSnapTimer = null; }
        wheelCommit(scroller);
      }, { passive: true });

      // Fallback long (inertie mobile ~300-500ms) pour navigateurs sans scrollend
      scroller.addEventListener('touchend', () => { wheelDbg('touchend'); wheelScheduleSnap(scroller, 600); }, { passive: true });
      scroller.addEventListener('pointercancel', () => { wheelScheduleSnap(scroller, 600); });

      // Molette souris
      scroller.addEventListener('wheel', (event) => {
        event.preventDefault();
        const delta = Math.abs(event.deltaY) > Math.abs(event.deltaX) ? event.deltaY : event.deltaX;
        if (!delta) return;
        scroller.scrollBy({ left: delta, behavior: 'auto' });
        wheelScheduleSnap(scroller, 150);
      }, { passive: false });

      wheel.appendChild(scroller);
      return wheel;
    }

    function renderSlotButtons() {
      // Molette en cours de manipulation (mobile) : DIFFÉRER le rebuild.
      // Reconstruire détruirait le scroller sous le doigt et le rAF final
      // re-scrollerait sur le slot sélectionné → molette « aimantée » qui
      // combat le geste. On réessaie une fois le geste terminé.
      const liveScroller = slotButtons.querySelector('.timeline-wheel-scroller');
      if (liveScroller && liveScroller.offsetParent !== null && timelineWheelUserBusy()) {
        wheelDbg('render DIFFÉRÉ');
        if (!wheelRenderRetryTimer) {
          wheelRenderRetryTimer = setTimeout(() => {
            wheelRenderRetryTimer = null;
            renderSlotButtons();
          }, 350);
        }
        return;
      }
      const day = getCurrentDay();
      const slots = getRenderableSlots(day);
      // Signature du contenu : ne RECONSTRUIRE que si quelque chose de visible a
      // changé (créneaux / dispo / cache serveur / GRIB chargé / sélection / jour).
      // Sinon les nombreux appels de fond (polls serveur d'automation, cache GRIB)
      // rebuildaient la molette à vide puis la re-centraient en boucle → churn
      // permanent + « rollback »/tremblement pendant un geste sur mobile. La frise
      // chasse n'a pas ce souci (jamais reconstruite en arrière-plan).
      const wheelLive = slotButtons.querySelector('.timeline-wheel');
      const sig = (day?.day_key || '') + '|' + selectedSlotKey + '|' + slots.map((s) =>
        s.slot_key
        + (timelineSlotIsUnavailable(s, day) ? 'u' : '')
        + ((typeof meteoFranceGribCachedSlotKeys !== 'undefined' && meteoFranceGribCachedSlotKeys.has(s.slot_key)) ? 'c' : '')
        + ((Array.isArray(s.cells) && s.cells.some((c) => c?.source_provider === 'meteofrance_arome_grib')) ? 'L' : '')
      ).join(',');
      if (wheelLive && sig === lastRenderSig) {
        syncTimelinePlaybackUi();   // maj légère des boutons lecture, sans rebuild ni re-scroll
        return;
      }
      lastRenderSig = sig;
      if (wheelDebugEl && liveScroller && liveScroller.offsetParent !== null) wheelDbg('render RUN');
      slotButtons.innerHTML = '';
      slotButtons.classList.add('timeline-slider');
      const selectableSlots = timelineSelectableSlots(day);
      debugLog('renderSlotButtons', slots.map(slot => ({ slotKey: slot?.slot_key, label: slot?.slot_label, cells: Array.isArray(slot?.cells) ? slot.cells.length : 0, unavailable: timelineSlotIsUnavailable(slot, day) })));
      if (!slots.length) {
        syncTimelinePlaybackUi();
        return;
      }
      const selectedSlot = slots.find(s => s.slot_key === selectedSlotKey);
      if (!selectedSlotKey || !selectedSlot || timelineSlotIsUnavailable(selectedSlot, day)) {
        selectedSlotKey = selectableSlots[0]?.slot_key || slots[0].slot_key;
      }

      const activeIndex = Math.max(0, slots.findIndex((slot) => slot?.slot_key === selectedSlotKey));
      const denominator = Math.max(1, slots.length - 1);
      const activePct = (activeIndex / denominator) * 100;
      const activeSlot = slots[activeIndex] || slots[0];
      const activeHour = String(activeSlot?.slot_label || activeSlot?.slot_key || '').replace(/^h/, '').replace('h', '');

      const rail = document.createElement('div');
      rail.className = 'timeline-rail';
      rail.setAttribute('role', 'slider');
      rail.setAttribute('aria-label', 'Heure affichée');
      rail.setAttribute('aria-valuemin', '0');
      rail.setAttribute('aria-valuemax', String(slots.length - 1));
      rail.setAttribute('aria-valuenow', String(activeIndex));
      rail.setAttribute('aria-valuetext', activeSlot?.slot_label || activeSlot?.slot_key || '');
      rail.tabIndex = 0;

      const track = document.createElement('div');
      track.className = 'timeline-rail-track';
      track.style.setProperty('--timeline-active-pct', `${activePct}%`);
      addTimelinePhaseIcons(track, day?.day_key || selectedBaseDate);

      const fill = document.createElement('div');
      fill.className = 'timeline-rail-fill';
      track.appendChild(fill);

      const cursor = document.createElement('div');
      cursor.className = 'timeline-rail-cursor';
      cursor.innerHTML = `<span>${String(activeHour).padStart(2, '0')}h</span>`;
      track.appendChild(cursor);

      for (let index = 0; index < slots.length; index += 1) {
        const slot = slots[index];
        const pct = (index / denominator) * 100;
        const hasAromeCache = typeof meteoFranceGribCachedSlotKeys !== 'undefined' && meteoFranceGribCachedSlotKeys.has(slot.slot_key);
        const isAromeLoaded = Array.isArray(slot.cells) && slot.cells.some((cell) => cell?.source_provider === 'meteofrance_arome_grib');
        const isUnavailable = timelineSlotIsUnavailable(slot, day);
        const mark = document.createElement('div');
        mark.className = [
          'timeline-hour-mark',
          slot.slot_key === selectedSlotKey ? 'active' : '',
          hasAromeCache ? 'is-arome-cached' : '',
          isAromeLoaded ? 'is-arome-loaded' : '',
          isUnavailable ? 'is-arome-unavailable' : '',
        ].filter(Boolean).join(' ');
        mark.dataset.slotKey = slot.slot_key;
        mark.style.left = `${pct}%`;
        mark.title = isUnavailable
          ? `${slot.slot_label} · échéance non publiée par le run AROME`
          : (isAromeLoaded
            ? `${slot.slot_label} · AROME GRIB chargé`
            : (hasAromeCache ? `${slot.slot_label} · AROME GRIB en cache serveur` : slot.slot_label));

        const line = document.createElement('span');
        line.className = 'timeline-hour-line';
        const label = document.createElement('span');
        label.className = 'timeline-hour-label';
        label.textContent = String(slot.slot_label || '').replace('h', '');
        mark.appendChild(line);
        mark.appendChild(label);
        track.appendChild(mark);
      }

      const wheel = buildTimelineWheel(slots, day);
      slotButtons.appendChild(wheel);
      rail.appendChild(track);
      slotButtons.appendChild(rail);
      syncTimelinePlaybackUi();
      requestAnimationFrame(() => syncTimelineWheelScrollToSelected({ smooth: false }));
    }
