// timeline-wheel.js — molette de créneaux (mobile) + rail (desktop).
// ARCHITECTURE (alignée sur la frise chasse, qui est la référence de fluidité) :
// la frise est CONSTRUITE UNE FOIS par structure (jour + jeu de créneaux), puis
// MISE À JOUR EN PLACE pour tout le reste (sélection, GRIB chargé, cache, dispo).
// renderSlotButtons est appelé par de nombreux sites (chargements GRIB,
// hydratation, lecture…) : ces appels ne détruisent plus jamais le DOM que
// l'utilisateur manipule — ils basculent des classes sur les éléments existants.
// Le snap de la molette est le SCROLL-SNAP CSS NATIF (timeline.css) : le JS ne
// re-scrolle pas après un geste, il ne fait que VALIDER le créneau centré.
    // ── État ────────────────────────────────────────────────────────────────
    let wheelSnapTimer = null;
    let wheelProgrammatic = false;      // scroll déclenché par nous (à ignorer)
    let wheelActiveSlotKey = null;
    let wheelUserLastAt = 0;            // dernière manipulation utilisateur de la molette
    let wheelRenderRetryTimer = null;   // rebuild structurel différé pendant un geste
    let timelineStructureSig = null;    // jour + jeu de slot_keys du dernier BUILD

    function timelineWheelUserBusy() {
      return (performance.now() - wheelUserLastAt) < 700;
    }

    // ── État visuel d'un créneau (partagé molette + rail) ───────────────────
    function timelineSlotRenderState(slot, day) {
      const cached = typeof meteoFranceGribCachedSlotKeys !== 'undefined' && meteoFranceGribCachedSlotKeys.has(slot.slot_key);
      const loaded = Array.isArray(slot.cells) && slot.cells.some((cell) => cell?.source_provider === 'meteofrance_arome_grib');
      const unavailable = timelineSlotIsUnavailable(slot, day);
      const title = unavailable
        ? `${slot.slot_label} · échéance non publiée par le run AROME`
        : (loaded
          ? `${slot.slot_label} · AROME GRIB chargé`
          : (cached ? `${slot.slot_label} · AROME GRIB en cache serveur` : slot.slot_label));
      return { cached, loaded, unavailable, title };
    }

    function applyTimelineSlotState(el, st) {
      el.classList.toggle('is-arome-cached', st.cached);
      el.classList.toggle('is-arome-loaded', st.loaded);
      el.classList.toggle('is-arome-unavailable', st.unavailable);
      el.title = st.title;
    }

    // ── Molette : géométrie / sélection ─────────────────────────────────────
    // O(1) : item le plus proche du centre (au commit, après scroll terminé)
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

    // Centrage NATIF (scrollTo smooth, comme la chasse). Renvoie true si un
    // déplacement a réellement eu lieu. Si DÉJÀ centré (<1px) : NE RIEN écrire —
    // réécrire scrollLeft (même à l'identique) déclenche un `scrollend` sur
    // Firefox → commit → boucle de snap infinie.
    function wheelScrollTo(scroller, slotKey, animated) {
      if (!scroller.isConnected) return false;
      const item = scroller.querySelector(`[data-slot-key="${slotKey}"]`);
      if (!item) return false;
      const sr = scroller.getBoundingClientRect();
      const ir = item.getBoundingClientRect();
      const target = Math.max(0, scroller.scrollLeft + ir.left - sr.left - sr.width / 2 + ir.width / 2);
      if (Math.abs(target - scroller.scrollLeft) < 1) return false;

      wheelProgrammatic = true;
      if (animated && typeof scroller.scrollTo === 'function') {
        scroller.scrollTo({ left: target, behavior: 'smooth' });
        setTimeout(() => { wheelProgrammatic = false; }, 400);
      } else {
        scroller.scrollLeft = target;
        // 2 frames : absorbe le scrollend asynchrone de Firefox.
        requestAnimationFrame(() => requestAnimationFrame(() => { wheelProgrammatic = false; }));
      }
      return true;
    }

    // Valide le créneau centré après un geste. PAS de re-centrage JS : le
    // scroll-snap CSS natif a déjà arrêté le scroll pile sur un créneau (le
    // re-centrage JS bagarrait avec l'inertie → « rebond »).
    function wheelCommit(scroller) {
      if (!scroller.isConnected) return;
      const item = wheelCenteredItem(scroller);
      if (!item) return;
      const slotKey = item.dataset.slotKey;
      wheelSetActive(scroller, slotKey);
      if (slotKey === selectedSlotKey) return;
      if (typeof selectTimelineSlot === 'function') {
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
      wheelScrollTo(scroller, selectedSlotKey, smooth);
    }

    // ── Construction (une fois par structure) ───────────────────────────────
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
        const st = timelineSlotRenderState(slot, day);
        const hourText = timelineSlotHourLabel(slot);
        const phase = phases.get(slot.slot_key);
        const item = document.createElement('button');
        item.type = 'button';
        item.className = 'timeline-wheel-item' + (slot.slot_key === selectedSlotKey ? ' active' : '');
        item.dataset.slotKey = slot.slot_key;
        item.setAttribute('role', 'option');
        item.setAttribute('aria-selected', slot.slot_key === selectedSlotKey ? 'true' : 'false');
        item.setAttribute('aria-label', `${String(hourText).padStart(2, '0')}h`);
        applyTimelineSlotState(item, st);
        item.disabled = st.unavailable;
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
          // item.disabled (état COURANT, mis à jour en place) — pas la valeur du build
          if (item.disabled) return;
          if (wheelSnapTimer) { clearTimeout(wheelSnapTimer); wheelSnapTimer = null; }
          if (typeof selectTimelineSlot === 'function') selectTimelineSlot(slot.slot_key, { stopPlayback: true });
        });
        scroller.appendChild(item);
      }

      // Surbrillance de l'item centré pendant le scroll — throttlée rAF
      const visibleHours = 8;
      let scrollRafId = null;
      // Début de geste utilisateur (l'inertie qui suit compte aussi : le scroll
      // non programmatique rafraîchit l'horodatage).
      scroller.addEventListener('pointerdown', () => { wheelUserLastAt = performance.now(); }, { passive: true });
      scroller.addEventListener('touchstart', () => { wheelUserLastAt = performance.now(); }, { passive: true });

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

      // scrollend : fin de geste + inertie + snap CSS → valider le créneau centré
      scroller.addEventListener('scrollend', () => {
        if (wheelProgrammatic) return;
        if (wheelSnapTimer) { clearTimeout(wheelSnapTimer); wheelSnapTimer = null; }
        wheelCommit(scroller);
      }, { passive: true });

      // Fallback (navigateurs sans scrollend) : commit différé après l'inertie
      scroller.addEventListener('touchend', () => { wheelScheduleSnap(scroller, 600); }, { passive: true });
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

    function buildTimelineRail(slots, day) {
      const activeIndex = Math.max(0, slots.findIndex((slot) => slot?.slot_key === selectedSlotKey));
      const denominator = Math.max(1, slots.length - 1);
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
      track.style.setProperty('--timeline-active-pct', `${(activeIndex / denominator) * 100}%`);
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
        const mark = document.createElement('div');
        mark.className = 'timeline-hour-mark' + (slot.slot_key === selectedSlotKey ? ' active' : '');
        mark.dataset.slotKey = slot.slot_key;
        mark.style.left = `${pct}%`;
        applyTimelineSlotState(mark, timelineSlotRenderState(slot, day));

        const line = document.createElement('span');
        line.className = 'timeline-hour-line';
        const label = document.createElement('span');
        label.className = 'timeline-hour-label';
        label.textContent = String(slot.slot_label || '').replace('h', '');
        mark.appendChild(line);
        mark.appendChild(label);
        track.appendChild(mark);
      }

      rail.appendChild(track);
      return rail;
    }

    // ── Mise à jour EN PLACE (structure identique) ──────────────────────────
    function updateTimelineInPlace(slots, day) {
      const activeIndex = Math.max(0, slots.findIndex((slot) => slot?.slot_key === selectedSlotKey));
      const denominator = Math.max(1, slots.length - 1);
      const activeSlot = slots[activeIndex] || slots[0];

      // Molette : états par item ; sélection/centrage SEULEMENT hors geste (sinon
      // on écraserait la surbrillance de suivi du doigt).
      const scroller = slotButtons.querySelector('.timeline-wheel-scroller');
      if (scroller) {
        for (const slot of slots) {
          const item = scroller.querySelector(`[data-slot-key="${slot.slot_key}"]`);
          if (!item) continue;
          const st = timelineSlotRenderState(slot, day);
          applyTimelineSlotState(item, st);
          item.disabled = st.unavailable;
        }
        if (!timelineWheelUserBusy()) {
          wheelSetActive(scroller, selectedSlotKey);
          // Sélection venue d'ailleurs (lecture, clic, rail desktop) → suivre en
          // douceur, comme la chasse. No-op si déjà centré (<1px, rien n'est écrit).
          if (scroller.offsetParent !== null) wheelScrollTo(scroller, selectedSlotKey, true);
        }
      }

      // Rail : curseur / remplissage / aria / états des repères
      const rail = slotButtons.querySelector('.timeline-rail');
      const track = slotButtons.querySelector('.timeline-rail-track');
      if (rail && track) {
        track.style.setProperty('--timeline-active-pct', `${(activeIndex / denominator) * 100}%`);
        const hour = String(activeSlot?.slot_label || activeSlot?.slot_key || '').replace(/^h/, '').replace('h', '');
        const span = track.querySelector('.timeline-rail-cursor span');
        if (span) span.textContent = `${String(hour).padStart(2, '0')}h`;
        rail.setAttribute('aria-valuenow', String(activeIndex));
        rail.setAttribute('aria-valuetext', activeSlot?.slot_label || activeSlot?.slot_key || '');
        for (const slot of slots) {
          const mark = track.querySelector(`.timeline-hour-mark[data-slot-key="${slot.slot_key}"]`);
          if (!mark) continue;
          applyTimelineSlotState(mark, timelineSlotRenderState(slot, day));
          mark.classList.toggle('active', slot.slot_key === selectedSlotKey);
        }
      }
    }

    // ── Point d'entrée (appelé par toute l'app) ─────────────────────────────
    function renderSlotButtons() {
      const day = getCurrentDay();
      const slots = getRenderableSlots(day);
      if (!slots.length) {
        slotButtons.innerHTML = '';
        slotButtons.classList.add('timeline-slider');
        timelineStructureSig = null;
        syncTimelinePlaybackUi();
        return;
      }

      // Normaliser la sélection (créneau retiré / indisponible) avant tout rendu
      const selectableSlots = timelineSelectableSlots(day);
      const selectedSlot = slots.find((s) => s.slot_key === selectedSlotKey);
      if (!selectedSlotKey || !selectedSlot || timelineSlotIsUnavailable(selectedSlot, day)) {
        selectedSlotKey = selectableSlots[0]?.slot_key || slots[0].slot_key;
      }

      // Structure identique (même jour, mêmes créneaux) → MISE À JOUR EN PLACE.
      // C'est le chemin de ~tous les appels : rien n'est détruit, rien ne saute.
      const structSig = (day?.day_key || '') + '|' + slots.map((s) => s.slot_key).join(',');
      if (structSig === timelineStructureSig && slotButtons.querySelector('.timeline-wheel-scroller')) {
        updateTimelineInPlace(slots, day);
        syncTimelinePlaybackUi();
        return;
      }

      // REBUILD structurel (changement de jour / de jeu de créneaux) — rare.
      // Pendant un geste sur la molette : différer pour ne pas la détruire sous le doigt.
      const liveScroller = slotButtons.querySelector('.timeline-wheel-scroller');
      if (liveScroller && liveScroller.offsetParent !== null && timelineWheelUserBusy()) {
        if (!wheelRenderRetryTimer) {
          wheelRenderRetryTimer = setTimeout(() => { wheelRenderRetryTimer = null; renderSlotButtons(); }, 350);
        }
        return;
      }
      debugLog('renderSlotButtons(rebuild)', slots.map(slot => ({ slotKey: slot?.slot_key, label: slot?.slot_label, cells: Array.isArray(slot?.cells) ? slot.cells.length : 0, unavailable: timelineSlotIsUnavailable(slot, day) })));
      slotButtons.innerHTML = '';
      slotButtons.classList.add('timeline-slider');
      slotButtons.appendChild(buildTimelineWheel(slots, day));
      slotButtons.appendChild(buildTimelineRail(slots, day));
      timelineStructureSig = structSig;
      syncTimelinePlaybackUi();
      requestAnimationFrame(() => syncTimelineWheelScrollToSelected({ smooth: false }));
    }
