    function renderDayButtons() {
      const allDays = getDays();
      const days = allDays.filter((day) => getRenderableSlots(day).length > 0);
      dayButtons.innerHTML = '';
      if (!days.length) return;
      if (!selectedDayKey || !days.some(d => d.day_key === selectedDayKey)) selectedDayKey = days[0].day_key;
      for (const day of days) {
        const btn = document.createElement('button');
        btn.textContent = day.day_label;
        btn.className = day.day_key === selectedDayKey ? 'active' : '';
        btn.onclick = () => {
          const renderableSlots = getRenderableSlots(day);
          selectedDayKey = day.day_key;
          selectedSlotKey = renderableSlots[0]?.slot_key || null;
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
      const slots = getRenderableSlots(day);
      if (!slots.length) return;
      if (!selectedSlotKey || !slots.some(s => s.slot_key === selectedSlotKey)) selectedSlotKey = slots[0].slot_key;
      for (const slot of slots) {
        const btn = document.createElement('button');
        btn.textContent = slot.slot_label;
        btn.className = `slot-pill ${slot.slot_key === selectedSlotKey ? 'active' : ''}`.trim();
        btn.onclick = () => {
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
