    function renderDayButtons() {
      const days = getDays();
      dayButtons.innerHTML = '';
      if (!days.length) return;
      if (!selectedDayKey || !days.some(d => d.day_key === selectedDayKey)) selectedDayKey = days[0].day_key;
      for (const day of days) {
        const btn = document.createElement('button');
        btn.textContent = day.day_label;
        btn.className = day.day_key === selectedDayKey ? 'active' : '';
        btn.onclick = () => {
          selectedDayKey = day.day_key;
          const firstSlot = getCurrentDay()?.slots?.[0];
          if (firstSlot) selectedSlotKey = firstSlot.slot_key;
          closeSelection();
          closeDetails();
          renderDayButtons();
          renderSlotButtons();
          requestAnimationFrame(alignTopPanels);
          refreshMap();
        };
        dayButtons.appendChild(btn);
      }
    }

    function renderSlotButtons() {
      const day = getCurrentDay();
      slotButtons.innerHTML = '';
      const slots = day?.slots || [];
      if (!slots.length) return;
      if (!selectedSlotKey || !slots.some(s => s.slot_key === selectedSlotKey)) selectedSlotKey = slots[0].slot_key;
      const todayHour = new Date().getHours();
      const isToday = normalizeDateIso(selectedBaseDate) === getTodayIsoDate();
      const forecastMode = String(payload?.meta?.analysis_type || '').toLowerCase() !== 'historical';
      for (const slot of slots) {
        const btn = document.createElement('button');
        const startHour = Number(String(slot.slot_key || '').split('-')[0]);
        const isPastForecastSlot = forecastMode && isToday && Number.isFinite(startHour) && startHour < todayHour;
        btn.textContent = slot.slot_label;
        btn.className = `slot-pill ${slot.slot_key === selectedSlotKey ? 'active' : ''} ${isPastForecastSlot ? 'is-disabled' : ''}`.trim();
        if (isPastForecastSlot) btn.disabled = true;
        btn.onclick = () => {
          if (isPastForecastSlot) return;
          selectedSlotKey = slot.slot_key;
          closeSelection();
          closeDetails();
          renderSlotButtons();
          requestAnimationFrame(alignTopPanels);
          refreshMap();
        };
        slotButtons.appendChild(btn);
      }
    }
