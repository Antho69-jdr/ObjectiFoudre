    
    function scoreBand(score) {
      const s = Number(score);
      if (!Number.isFinite(s)) return 'Indéterminé';
      if (s < 20) return 'Très faible';
      if (s < 40) return 'Faible';
      if (s < 60) return 'Modéré';
      if (s < 80) return 'Bon';
      return 'Élevé';
    }

    function probabilityHint(p) {
      const cape = Number(p.mucape);
      const td = Number(p.dewpoint_c);
      const vpd = Number(p.vapour_pressure_deficit);
      const prob = Number(p.trigger_score);
      if (Number.isFinite(cape) && cape < 50) return 'Aucune instabilité exploitable';
      if (Number.isFinite(cape) && cape < 150) return 'Instabilité très marginale';
      if (Number.isFinite(td) && td < 8) return 'Humidité trop faible en basse couche';
      if (Number.isFinite(vpd) && vpd > 2.5) return 'Air trop sec, inhibition marquée';
      if (Number.isFinite(cape) && cape >= 600 && Number.isFinite(td) && td >= 14) return 'Instabilité et humidité bien alignées';
      if (Number.isFinite(prob) && prob >= 70) return 'Potentiel orageux bien établi';
      return `${scoreBand(prob)} · équilibre instabilité / humidité`;
    }

    function severityHint(p) {
      const cape = Number(p.mucape);
      const shear = Number(p.shear_ms);
      const sev = Number(p.structure_score);
      if (Number.isFinite(cape) && cape < 150) return 'Énergie trop faible pour des orages forts';
      if (Number.isFinite(shear) && shear < 8) return 'Organisation limitée par le shear';
      if (Number.isFinite(cape) && cape >= 800 && Number.isFinite(shear) && shear >= 16) return 'Bon couple énergie / organisation';
      if (Number.isFinite(sev) && sev >= 75) return 'Potentiel d’orages organisés ou forts';
      return `${scoreBand(sev)} · intensité encore conditionnelle`;
    }

    function chaseHint(p) {
      const low = Number(p.cloud_cover_low);
      const mid = Number(p.cloud_cover_mid);
      const high = Number(p.cloud_cover_high);
      const q = Number(p.chase_quality_score);
      if ([low, mid, high].some(Number.isFinite) && ((low >= 70) || (mid >= 80))) return 'Lisibilité dégradée par la nébulosité';
      if (Number.isFinite(q) && q >= 75) return 'Bonne lisibilité terrain et photo';
      return `${scoreBand(q)} · lisibilité du ciel et intérêt photo`;
    }

    function limitingFactor(p) {
      const cape = Number(p.mucape);
      const td = Number(p.dewpoint_c);
      const vpd = Number(p.vapour_pressure_deficit);
      const shear = Number(p.shear_ms);
      const low = Number(p.cloud_cover_low);
      const mid = Number(p.cloud_cover_mid);
      if (Number.isFinite(cape) && cape < 50) return 'Facteur limitant principal : CAPE quasi nulle.';
      if (Number.isFinite(td) && td < 8) return 'Facteur limitant principal : humidité basse couche insuffisante.';
      if (Number.isFinite(vpd) && vpd > 2.5) return 'Facteur limitant principal : air trop sec, inhibition probable.';
      if (Number.isFinite(shear) && shear < 8) return 'Facteur limitant principal : organisation limitée par le shear.';
      if ((Number.isFinite(low) && low > 70) || (Number.isFinite(mid) && mid > 80)) return 'Facteur limitant principal : lisibilité dégradée par la nébulosité.';
      return 'Facteur limitant principal : aucun verrou majeur, environnement plutôt cohérent.';
    }

    function showSelection(p) {
      selectionTitle.textContent = p.zone || 'Zone';
      selectionSubtitle.textContent = `${p.day_label || '—'} · ${p.slot_label || '—'} · ${p.selected_hour || '—'}`;
      if (selectionTrigger) selectionTrigger.textContent = safe(p.trigger_score);
      if (selectionStructure) selectionStructure.textContent = safe(p.structure_score);
      if (selectionQuality) selectionQuality.textContent = safe(p.chase_quality_score);
      if (selectionTrigger) applyMetricTone(selectionTrigger, 'trigger_score', p.trigger_score);
      if (selectionStructure) applyMetricTone(selectionStructure, 'structure_score', p.structure_score);
      if (selectionQuality) applyMetricTone(selectionQuality, 'chase_quality_score', p.chase_quality_score);
      const selectionTriggerHint = document.getElementById('selectionTriggerHint');
      const selectionStructureHint = document.getElementById('selectionStructureHint');
      const selectionQualityHint = document.getElementById('selectionQualityHint');
      if (selectionTriggerHint) selectionTriggerHint.textContent = probabilityHint(p);
      if (selectionStructureHint) selectionStructureHint.textContent = severityHint(p);
      if (selectionQualityHint) selectionQualityHint.textContent = chaseHint(p);
      selectionCard.classList.add('visible');
      requestAnimationFrame(positionSelectionCard);
    }

    function closeSelection() {
      selectionCard.classList.remove('visible');
      selectionCard.classList.remove('desktop-outside-grid');
      selectionCard.style.left = '';
      selectionCard.style.right = '';
      selectionCard.style.top = '';
      selectionCard.style.bottom = '';
      selectionCard.style.transform = '';
      selectedFeature = null;
      updateHighlight();
    }

    function getGridScreenBounds(cells) {
      if (!Array.isArray(cells) || !cells.length || !map) return null;
      let left = Infinity;
      let right = -Infinity;
      let top = Infinity;
      let bottom = -Infinity;
      for (const cell of cells) {
        const lat = Number(cell.lat);
        const lon = Number(cell.lon);
        const h = Number(cell.cell_height_deg) / 2;
        const w = Number(cell.cell_width_deg) / 2;
        if (![lat, lon, h, w].every(Number.isFinite)) continue;
        const corners = [
          map.project([lon - w, lat - h]),
          map.project([lon + w, lat - h]),
          map.project([lon + w, lat + h]),
          map.project([lon - w, lat + h]),
        ];
        for (const pt of corners) {
          left = Math.min(left, pt.x);
          right = Math.max(right, pt.x);
          top = Math.min(top, pt.y);
          bottom = Math.max(bottom, pt.y);
        }
      }
      if (![left, right, top, bottom].every(Number.isFinite)) return null;
      return { left, right, top, bottom, width: right - left, height: bottom - top };
    }

    function positionSelectionCard() {
      if (!selectionCard.classList.contains('visible')) return;
      const mobile = isMobileLayout() || window.innerWidth < 1100;
      if (mobile) {
        selectionCard.classList.remove('desktop-outside-grid');
        selectionCard.style.left = '';
        selectionCard.style.right = '';
        selectionCard.style.top = '';
        selectionCard.style.bottom = '';
        selectionCard.style.transform = '';
        return;
      }
      const cells = getCurrentSlot()?.cells || [];
      const bounds = getGridScreenBounds(cells);
      if (!bounds) {
        selectionCard.classList.remove('desktop-outside-grid');
        selectionCard.style.left = '';
        selectionCard.style.right = '';
        selectionCard.style.top = '';
        selectionCard.style.bottom = '';
        selectionCard.style.transform = '';
        return;
      }
      const margin = 16;
      const cardWidth = Math.min(380, window.innerWidth - 44);
      const cardHeight = selectionCard.offsetHeight || 320;
      const availableLeft = bounds.left - margin;
      const availableRight = window.innerWidth - bounds.right - margin - (Number.parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--right-rail-width')) || 46) - 20;
      let left = null;
      if (availableLeft >= cardWidth) {
        left = Math.max(12, bounds.left - cardWidth - margin);
      } else if (availableRight >= cardWidth) {
        left = Math.min(window.innerWidth - cardWidth - 76, bounds.right + margin);
      }
      if (left === null) {
        selectionCard.classList.remove('desktop-outside-grid');
        selectionCard.style.left = '';
        selectionCard.style.right = '';
        selectionCard.style.top = '';
        selectionCard.style.bottom = '';
        selectionCard.style.transform = '';
        return;
      }
      const top = Math.max(12, Math.min(bounds.top + ((bounds.height - cardHeight) / 2), window.innerHeight - cardHeight - 12));
      selectionCard.classList.add('desktop-outside-grid');
      selectionCard.style.left = `${Math.round(left)}px`;
      selectionCard.style.top = `${Math.round(top)}px`;
      selectionCard.style.right = 'auto';
      selectionCard.style.bottom = 'auto';
      selectionCard.style.transform = 'none';
    }

    function openDetails() {
      if (!selectedFeature) return;
      const p = selectedFeature;
      detailsSubtitle.textContent = `${p.zone || 'Zone'} · ${p.day_label || '—'} · ${p.slot_label || '—'}`;
      detailsSummary.textContent = `${p.summary || 'Lecture synthétique de la cellule.'} ${limitingFactor(p)}`;
      if (dTrigger) dTrigger.textContent = safe(p.trigger_score);
      if (dStructure) dStructure.textContent = safe(p.structure_score);
      if (dQuality) dQuality.textContent = safe(p.chase_quality_score);
      dCape.textContent = safe(p.mucape);
      dShear.textContent = safe(p.shear_ms, ' m/s');
      dRh.textContent = safe(p.relative_humidity_2m, ' %');
      dVpd.textContent = safe(p.vapour_pressure_deficit);
      dWetbulb.textContent = safe(p.wet_bulb_temperature_2m, ' °C');
      dDewpoint.textContent = safe(p.dewpoint_c, ' °C');
      dTemp.textContent = safe(p.temp_c, ' °C');
      dGusts.textContent = safe(p.wind_gusts_10m, ' m/s');
      dCloudLow.textContent = safe(p.cloud_cover_low, ' %');
      dCloudMid.textContent = safe(p.cloud_cover_mid, ' %');
      dCloudHigh.textContent = safe(p.cloud_cover_high, ' %');
      dHour.textContent = safe(p.selected_hour);
      if (dTrigger) applyMetricTone(dTrigger, 'trigger_score', p.trigger_score);
      if (dStructure) applyMetricTone(dStructure, 'structure_score', p.structure_score);
      if (dQuality) applyMetricTone(dQuality, 'chase_quality_score', p.chase_quality_score);
      const dTriggerHint = document.getElementById('dTriggerHint');
      const dStructureHint = document.getElementById('dStructureHint');
      const dQualityHint = document.getElementById('dQualityHint');
      if (dTriggerHint) dTriggerHint.textContent = probabilityHint(p);
      if (dStructureHint) dStructureHint.textContent = severityHint(p);
      if (dQualityHint) dQualityHint.textContent = chaseHint(p);
      applyMetricTone(dCape, 'mucape', p.mucape);
      applyMetricTone(dShear, 'shear_ms', p.shear_ms);
      applyMetricTone(dRh, 'relative_humidity_2m', p.relative_humidity_2m);
      applyMetricTone(dVpd, 'vapour_pressure_deficit', p.vapour_pressure_deficit);
      applyMetricTone(dWetbulb, 'wet_bulb_temperature_2m', p.wet_bulb_temperature_2m);
      applyMetricTone(dDewpoint, 'dewpoint_c', p.dewpoint_c);
      applyMetricTone(dTemp, 'temp_c', p.temp_c);
      applyMetricTone(dGusts, 'wind_gusts_10m', p.wind_gusts_10m);
      applyMetricTone(dCloudLow, 'cloud_cover_low', p.cloud_cover_low);
      applyMetricTone(dCloudMid, 'cloud_cover_mid', p.cloud_cover_mid);
      applyMetricTone(dCloudHigh, 'cloud_cover_high', p.cloud_cover_high);
      applyMetricTone(dHour, 'selected_hour', NaN);
      modalBackdrop.classList.add('visible');
      detailsModal.classList.add('visible');
    }

    function closeDetails() {
      modalBackdrop.classList.remove('visible');
      detailsModal.classList.remove('visible');
    }
