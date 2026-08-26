// selection-card.js — issu du découpage de selection.js (Phase 3).
// Carte de sélection (affichage/positionnement) + openDetails/closeDetails + init top-level (DERNIER).
    // Pose --score-band = couleur de la rampe carte (colorFromScore) sur la
    // carte-héros, pour le liseré de probabilité (cf. details-modal.css/selection.css).
    function setScoreBand(el, score) {
      if (!el) return;
      if (typeof colorFromScore === 'function' && score != null && score !== '' && !Number.isNaN(Number(score))) {
        el.style.setProperty('--score-band', colorFromScore(Number(score)));
      } else {
        el.style.removeProperty('--score-band');
      }
    }
    function showSelection(p) {
      selectionTitle.textContent = formatSelectionLocation(p);
      if (selectionConfidence) selectionConfidence.textContent = safe(p.confidence_score);
      if (selectionContext) selectionContext.textContent = selectionContextSummary(p);
      if (selectionTrigger) selectionTrigger.textContent = safe(p.trigger_score);
      if (selectionConfidence) applyMetricTone(selectionConfidence, 'confidence_score', p.confidence_score);
      if (selectionTrigger) applyMetricTone(selectionTrigger, 'trigger_score', p.trigger_score);
      if (selectionTrigger) setScoreBand(selectionTrigger.closest('.selection-score-trigger'), p.trigger_score);
      const selectionTriggerHint = document.getElementById('selectionTriggerHint');
      if (selectionTriggerHint) selectionTriggerHint.textContent = probabilityHint(p);
      selectionCard.classList.add('visible');
      requestAnimationFrame(positionSelectionCard);
      if (!p.metric_scores) {
        ensureCellDetails(p).then((ok) => { if (ok && selectedFeature === p) showSelection(p); });
      }
    }

    function closeSelection() {
      selectionCard.classList.remove('visible');
      selectionCard.classList.remove('desktop-outside-grid', 'tablet-follow-grid');
      selectionCard.style.left = '';
      selectionCard.style.right = '';
      selectionCard.style.top = '';
      selectionCard.style.bottom = '';
      selectionCard.style.transform = '';
      selectedFeature = null;
      updateHighlight();
    }

    function resetSelectionCardPosition() {
      selectionCard.classList.remove('desktop-outside-grid', 'tablet-follow-grid');
      selectionCard.style.left = '';
      selectionCard.style.right = '';
      selectionCard.style.top = '';
      selectionCard.style.bottom = '';
      selectionCard.style.transform = '';
    }

    function clampSelectionPosition(value, min, max) {
      if (max < min) return min;
      return Math.max(min, Math.min(value, max));
    }

    function getSelectedFeatureScreenBounds(feature, point) {
      const lat = Number(feature?.lat);
      const lon = Number(feature?.lon);
      const h = Number(feature?.cell_height_deg) / 2;
      const w = Number(feature?.cell_width_deg) / 2;
      if (![lat, lon, h, w].every(Number.isFinite) || h <= 0 || w <= 0) {
        return { left: point.x, right: point.x, top: point.y, bottom: point.y, width: 0, height: 0 };
      }
      const corners = [
        map.project([lon - w, lat - h]),
        map.project([lon + w, lat - h]),
        map.project([lon + w, lat + h]),
        map.project([lon - w, lat + h]),
      ];
      let left = Infinity;
      let right = -Infinity;
      let top = Infinity;
      let bottom = -Infinity;
      for (const corner of corners) {
        if (!corner || !Number.isFinite(corner.x) || !Number.isFinite(corner.y)) continue;
        left = Math.min(left, corner.x);
        right = Math.max(right, corner.x);
        top = Math.min(top, corner.y);
        bottom = Math.max(bottom, corner.y);
      }
      if (![left, right, top, bottom].every(Number.isFinite)) {
        return { left: point.x, right: point.x, top: point.y, bottom: point.y, width: 0, height: 0 };
      }
      return { left, right, top, bottom, width: right - left, height: bottom - top };
    }

    function rectOverlapArea(a, b) {
      const w = Math.max(0, Math.min(a.right, b.right) - Math.max(a.left, b.left));
      const h = Math.max(0, Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top));
      return w * h;
    }

    function positionSelectionCardNearFeature() {
      if (!selectedFeature || !map) return false;
      const lat = Number(selectedFeature.lat);
      const lon = Number(selectedFeature.lon);
      if (!Number.isFinite(lat) || !Number.isFinite(lon)) return false;
      const point = map.project([lon, lat]);
      if (!point || !Number.isFinite(point.x) || !Number.isFinite(point.y)) return false;
      const railWidth = Number.parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--right-rail-width")) || 46;
      const cardWidth = Math.min(340, window.innerWidth - railWidth - 42);
      const cardHeight = selectionCard.offsetHeight || 148;
      const timelineRect = timelineDock?.getBoundingClientRect?.() || null;
      const bottomLimit = timelineRect ? timelineRect.top - 12 : window.innerHeight - 12;
      const viewport = {
        left: 12,
        top: 12,
        right: window.innerWidth - railWidth - 16,
        bottom: Math.max(96, bottomLimit),
      };
      const cellBounds = getSelectedFeatureScreenBounds(selectedFeature, point);
      const gap = 18;
      const centeredLeft = point.x - cardWidth / 2;
      const centeredTop = point.y - cardHeight / 2;
      const candidates = [
        { rank: 0, left: centeredLeft, top: cellBounds.top - cardHeight - gap },
        { rank: 1, left: centeredLeft, top: cellBounds.bottom + gap },
        { rank: 2, left: cellBounds.left - cardWidth - gap, top: centeredTop },
        { rank: 3, left: cellBounds.right + gap, top: centeredTop },
      ];
      const fits = (candidate) => (
        candidate.left >= viewport.left
        && candidate.top >= viewport.top
        && candidate.left + cardWidth <= viewport.right
        && candidate.top + cardHeight <= viewport.bottom
      );
      let chosen = candidates.find(fits);
      if (!chosen) {
        chosen = candidates
          .map(candidate => {
            const left = clampSelectionPosition(candidate.left, viewport.left, viewport.right - cardWidth);
            const top = clampSelectionPosition(candidate.top, viewport.top, viewport.bottom - cardHeight);
            const rect = { left, top, right: left + cardWidth, bottom: top + cardHeight };
            const rawOverflow = Math.max(0, viewport.left - candidate.left)
              + Math.max(0, viewport.top - candidate.top)
              + Math.max(0, candidate.left + cardWidth - viewport.right)
              + Math.max(0, candidate.top + cardHeight - viewport.bottom);
            return {
              left,
              top,
              score: rectOverlapArea(rect, cellBounds) * 4 + rawOverflow * 8 + candidate.rank * 40,
            };
          })
          .sort((a, b) => a.score - b.score)[0];
      }
      const left = clampSelectionPosition(chosen.left, viewport.left, viewport.right - cardWidth);
      const top = clampSelectionPosition(chosen.top, viewport.top, viewport.bottom - cardHeight);
      selectionCard.classList.remove("desktop-outside-grid");
      selectionCard.classList.add("tablet-follow-grid");
      selectionCard.style.setProperty("left", `${Math.round(left)}px`, "important");
      selectionCard.style.setProperty("top", `${Math.round(top)}px`, "important");
      selectionCard.style.setProperty("right", "auto", "important");
      selectionCard.style.setProperty("bottom", "auto", "important");
      selectionCard.style.setProperty("transform", "none", "important");
      return true;
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
      const mobile = window.innerWidth < 768;
      const tabletPortrait = window.innerWidth >= 768 && window.innerWidth <= 1024 && window.innerHeight > window.innerWidth;
      if ((mobile || tabletPortrait) && positionSelectionCardNearFeature()) return;
      if (mobile) {
        resetSelectionCardPosition();
        return;
      }
      const cells = getCurrentSlot()?.cells || [];
      const bounds = getGridScreenBounds(cells);
      if (!bounds) {
        if (positionSelectionCardNearFeature()) return;
        resetSelectionCardPosition();
        return;
      }
      const margin = 16;
      const cardWidth = Math.min(340, window.innerWidth - 44);
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
        if (positionSelectionCardNearFeature()) return;
        resetSelectionCardPosition();
        return;
      }
      const timelineRect = timelineDock?.getBoundingClientRect?.() || null;
      const maxBottomEdge = timelineRect ? (timelineRect.top - 12) : (window.innerHeight - 12);
      const maxTop = Math.max(12, maxBottomEdge - cardHeight);
      const centeredTop = bounds.top + ((bounds.height - cardHeight) / 2);
      const top = Math.max(12, Math.min(centeredTop, maxTop));
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
      // Grille « render » allégée : la cellule complète (sous-scores, valeurs, breakdown)
      // arrive à la demande ; on rend tout de suite avec ce qu'on a, puis on re-rend.
      if (!p.metric_scores) {
        ensureCellDetails(p).then((ok) => {
          if (ok && selectedFeature === p && detailsModal.classList.contains('visible')) openDetails();
        });
      }
      hideDetailsCalcInspector();
      detailsSubtitle.textContent = `${formatSelectionLocation(p)} · ${p.selected_hour || p.slot_label || 'heure active'}`;
      if (dConfidence) dConfidence.textContent = safe(p.confidence_score);
      if (dTrigger) dTrigger.textContent = safe(p.trigger_score);
      if (dTrigger) setScoreBand(dTrigger.closest('.metric-card-score'), p.trigger_score);
      if (dCape) dCape.textContent = safe(p.mucape);
      if (dCin) dCin.textContent = safe(p.convective_inhibition, ' J/kg');
      if (dShear) dShear.textContent = safe(p.shear_ms, ' m/s');
      loadWindProfile(p);
      if (dRh) dRh.textContent = safe(p.relative_humidity_2m, ' %');
      if (dPrecipitableWater) dPrecipitableWater.textContent = safe(p.precipitable_water, ' kg/m²');
      // Garde-fou : les jours archivés AVANT l'ensoleillement estimé portent l'ancien flux net
      // AROME cumulé (J/m², ~million) — aberrant en W/m². On l'occulte plutôt que d'afficher un
      // mensonge. Les jours récents portent l'ensoleillement honnête (0-~900 W/m²).
      if (dShortwave) {
        const sw = (p.shortwave_radiation != null && p.shortwave_radiation > 1500) ? null : p.shortwave_radiation;
        dShortwave.textContent = safe(sw, ' W/m²');
      }
      if (typeof dPrecipRate !== 'undefined' && dPrecipRate) dPrecipRate.textContent = safe(p.precipitation_rate, ' mm/h');
      if (dVpd) dVpd.textContent = safe(p.vapour_pressure_deficit);
      if (dWetbulb) dWetbulb.textContent = safe(p.wet_bulb_temperature_2m, ' °C');
      if (dDewpoint) dDewpoint.textContent = safe(p.dewpoint_c, ' °C');
      if (dTemp) dTemp.textContent = safe(p.temp_c, ' °C');
      if (dGusts) dGusts.textContent = safe(p.wind_gusts_10m, ' m/s');
      if (dWindSpeed) dWindSpeed.textContent = safe(p.wind_speed_10m, ' m/s');
      if (dWindDirection) dWindDirection.textContent = safe(p.wind_direction_10m, ' °');
      if (dSurfaceConvergence) dSurfaceConvergence.textContent = safe(p.surface_convergence_1e4s);
      if (dCloudLow) dCloudLow.textContent = safe(p.cloud_cover_low, ' %');
      if (dCloudMid) dCloudMid.textContent = safe(p.cloud_cover_mid, ' %');
      if (dCloudHigh) dCloudHigh.textContent = safe(p.cloud_cover_high, ' %');
      if (dHour) dHour.textContent = safe(p.selected_hour);
      if (dTrigger) applyMetricTone(dTrigger, 'trigger_score', p.trigger_score);
      if (dConfidence) applyMetricTone(dConfidence, 'confidence_score', p.confidence_score);
      const dTriggerHint = document.getElementById('dTriggerHint');
      if (dTriggerHint) dTriggerHint.textContent = probabilityHint(p);
      if (dConfidenceHint) dConfidenceHint.textContent = confidenceHint(p);
      setCalculationGrid(dProbabilityBreakdown, probabilityBreakdownChips(p));
      setCalculationGrid(dConfidenceBreakdown, confidenceBreakdownChips(p));
      prepareDetailValueCards();
      if (dCape) applyMetricTone(dCape, 'mucape', p.mucape);
      if (dRh) applyMetricTone(dRh, 'relative_humidity_2m', p.relative_humidity_2m);
      if (dPrecipitableWater) applyMetricTone(dPrecipitableWater, 'precipitable_water', p.precipitable_water);
      if (dShortwave) applyMetricTone(dShortwave, 'shortwave_radiation', p.shortwave_radiation);
      if (typeof dPrecipRate !== 'undefined' && dPrecipRate) applyMetricTone(dPrecipRate, 'precipitation_rate', p.precipitation_rate);
      if (dVpd) applyMetricTone(dVpd, 'vapour_pressure_deficit', p.vapour_pressure_deficit);
      if (dWetbulb) applyMetricTone(dWetbulb, 'wet_bulb_temperature_2m', p.wet_bulb_temperature_2m);
      if (dDewpoint) applyMetricTone(dDewpoint, 'dewpoint_c', p.dewpoint_c);
      if (dTemp) applyMetricTone(dTemp, 'temp_c', p.temp_c);
      if (dGusts) applyMetricTone(dGusts, 'wind_gusts_10m', p.wind_gusts_10m);
      if (dWindSpeed) applyMetricTone(dWindSpeed, 'wind_speed_10m', p.wind_speed_10m);
      if (dWindDirection) applyMetricTone(dWindDirection, 'wind_direction_10m', NaN);
      if (dSurfaceConvergence) applyMetricTone(dSurfaceConvergence, 'surface_convergence_1e4s', p.surface_convergence_1e4s);
      if (dCloudLow) applyMetricTone(dCloudLow, 'cloud_cover_low', p.cloud_cover_low);
      if (dCloudMid) applyMetricTone(dCloudMid, 'cloud_cover_mid', p.cloud_cover_mid);
      if (dCloudHigh) applyMetricTone(dCloudHigh, 'cloud_cover_high', p.cloud_cover_high);
      if (dHour) applyMetricTone(dHour, 'selected_hour', NaN);
      modalBackdrop.classList.add('visible');
      detailsModal.classList.add('visible');
    }


    function closeDetails() {
      hideDetailsCalcInspector();
      modalBackdrop.classList.remove('visible');
      detailsModal.classList.remove('visible');
    }


    if (detailsModal && !detailsModal.dataset.calcInspectorBound) {
      detailsModal.dataset.calcInspectorBound = '1';
      detailsModal.addEventListener('click', (event) => {
        const chip = event.target?.closest?.('.details-calc-chip');
        if (chip && detailsModal.contains(chip)) {
          showDetailsCalcInspector(chip.dataset.calcKey);
          return;
        }
        const valueCard = event.target?.closest?.('.details-grid-values .metric-card');
        if (valueCard && detailsModal.contains(valueCard)) showDetailsValueInspector(valueCard);
      });
      detailsModal.addEventListener('keydown', (event) => {
        if (event.key !== 'Enter' && event.key !== ' ') return;
        const valueCard = event.target?.closest?.('.details-grid-values .metric-card');
        if (!valueCard || !detailsModal.contains(valueCard)) return;
        event.preventDefault();
        showDetailsValueInspector(valueCard);
      });
    }
    detailsCalcInspectorClose?.addEventListener('click', hideDetailsCalcInspector);
