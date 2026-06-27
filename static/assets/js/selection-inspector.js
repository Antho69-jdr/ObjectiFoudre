// selection-inspector.js — issu du découpage de selection.js (Phase 3).
// Inspecteur de calcul, détails de cellule, profil de vent.
    function detailCalcInfo(key, p) {
      const breakdown = parseDetailObject(p.category_breakdown);
      const probability = parseDetailObject(breakdown.probability);
      const confidence = parseDetailObject(breakdown.confidence);
      const scores = parseDetailObject(p.metric_scores);
      const support = detailSupportComponents(p).map(([, value]) => value);
      const floor = support.length ? Math.min(...support) : null;
      const mean = support.length ? support.reduce((sum, value) => sum + value, 0) / support.length : null;
      const spread = support.length ? Math.max(...support) - Math.min(...support) : null;
      const hasSurface = detailNumeric(probability.surface_trigger ?? scores.surface_trigger_score) !== null;
      const weightedFormula = hasSurface
        ? '0.44 × instabilité + 0.34 × humidité + 0.10 × timing/rayonnement + 0.12 × déclencheur surface, puis activité AROME et pénalités.'
        : '0.50 × instabilité + 0.40 × humidité + 0.10 × timing/rayonnement, puis activité AROME et pénalités.';
      const valueByKey = {
        probability_raw: probability.raw_initiation ?? p.trigger_score,
        probability_environment: probability.environment ?? scores.environment_score,
        probability_activity: probability.convective_activity ?? scores.convective_activity_score,
        probability_instability: probability.instability ?? scores.cape_score,
        probability_moisture: probability.moisture,
        probability_solar: probability.surface_heating ?? scores.surface_heating_score ?? scores.timing_score,
        probability_clouds: probability.cloud_support ?? scores.cloud_trigger_score,
        probability_timing: probability.timing ?? scores.timing_score,
        probability_surface: probability.surface_trigger ?? scores.surface_trigger_score,
        probability_penalty: probability.inhibition_penalty,
        confidence_consistency: confidence.consistency ?? scores.confidence_consistency_score,
        confidence_temporal: confidence.temporal_stability ?? scores.confidence_temporal_score,
        confidence_margin: confidence.margin ?? scores.confidence_margin_score,
        confidence_floor: floor,
        confidence_mean: mean,
        confidence_spread: spread,
      };
      const info = {
        probability_raw: {
          category: 'Probabilité orage',
          title: 'Score retenu',
          formula: "Score environnemental après pénalités thermodynamiques. Les champs non requis ne sont pas utilisés en mode strict.",
          text: 'C’est le score final affiché dans la grille. Il répond à la question : cette cellule mérite-t-elle une attention orageuse sur cette heure ?',
        },
        probability_environment: {
          category: 'Probabilité orage',
          title: 'Environnement',
          formula: weightedFormula,
          text: 'Ce score lit les ingrédients obligatoires AROME : instabilité, humidité, vapeur colonne, rayonnement, timing et déclenchement de surface si disponible.',
        },
        probability_activity: {
          category: 'Probabilité orage',
          title: 'Activité AROME',
          formula: `0.55 × précipitation + 0.25 × nébulosité convective + 0.20 × rafales. Précipitation ${formatDetailScore(probability.precipitation ?? scores.precipitation_score)}, nuages ${formatDetailScore(probability.cloud_support ?? scores.cloud_trigger_score)}, rafales ${formatDetailScore(probability.gust_potential ?? scores.gust_potential_score)}.`,
          text: 'Ce bloc sert de garde-fou nowcasting modèle : si AROME matérialise déjà pluie, nuages convectifs et rafales, le score peut remonter même avec une CAPE modérée.',
        },
        probability_instability: {
          category: 'Probabilité orage',
          title: 'Instabilité',
          formula: `Composant CAPE : ${formatDetailScore(scores.cape_score)} depuis CAPE ${formatDetailScore(p.mucape, ' J/kg')}.`,
          text: 'Ce bloc mesure le carburant disponible pour les ascendances. Une CAPE faible limite la probabilité sans la fermer totalement, car certains régimes forcés restent possibles.',
        },
        probability_moisture: {
          category: 'Probabilité orage',
          title: 'Humidité',
          formula: scores.precipitable_water_score !== undefined && scores.precipitable_water_score !== null
            ? `0.48 × point de rosée + 0.27 × déficit de saturation + 0.08 × bulbe humide + 0.17 × vapeur colonne, où déficit de saturation = 0.60 × VPD + 0.40 × humidité relative. Composants : Td ${formatDetailScore(scores.dewpoint_score)}, HR ${formatDetailScore(scores.humidity_score)}, VPD ${formatDetailScore(scores.vpd_score)}, Tw ${formatDetailScore(scores.wetbulb_score)}, colonne ${formatDetailScore(scores.precipitable_water_score)} (${formatDetailScore(p.precipitable_water, ' kg/m²')}).`
            : `0.65 × point de rosée + 0.35 × déficit de saturation, où déficit de saturation = 0.60 × VPD + 0.40 × humidité relative. Composants : Td ${formatDetailScore(scores.dewpoint_score)}, HR ${formatDetailScore(scores.humidity_score)}, VPD ${formatDetailScore(scores.vpd_score)}.`,
          text: 'Ce bloc lit l’alimentation humide. Le point de rosée domine ; HR et VPD sont fusionnés en un seul axe « déficit de saturation » pour ne pas compter deux fois l’écart à la saturation, et la vapeur d’eau intégrée ajoute la profondeur humide de la colonne.',
        },
        probability_solar: {
          category: 'Probabilité orage',
          title: 'Rayonnement',
          formula: `0.55 × timing + 0.45 × rayonnement court. Timing ${formatDetailScore(probability.timing ?? scores.timing_score)}, rayonnement ${formatDetailScore(scores.shortwave_radiation_score)} (${formatDetailScore(p.shortwave_radiation, ' W/m²')}), support ${formatDetailScore(probability.surface_heating ?? scores.surface_heating_score)}.`,
          text: 'Le flux net de rayonnement court devient un vrai ingrédient obligatoire du support diurne. Il ne remplace pas les observations, mais évite de lire le timing seul.',
        },
        probability_clouds: {
          category: 'Probabilité orage',
          title: 'Nébulosité',
          formula: `Support nuageux ${formatDetailScore(probability.cloud_support ?? scores.cloud_trigger_score)} · couverture convective ${formatDetailScore(probability.convective_cloud_cover, ' %')} · couverture totale ${formatDetailScore(probability.total_cloud_cover, ' %')}.`,
          text: 'La nébulosité AROME sert de contexte et d’activité matérialisée, pas de pénalité dure au ciel clair pré-convectif.',
        },
        probability_timing: {
          category: 'Probabilité orage',
          title: 'Timing',
          formula: `Score horaire brut ${formatDetailScore(probability.timing ?? scores.timing_score)} pour ${p.selected_hour || p.slot_label || 'l’heure active'}.`,
          text: 'Le timing reste un repère horaire ; le score final le combine maintenant au rayonnement court AROME obligatoire.',
        },
        probability_surface: {
          category: 'Probabilité orage',
          title: 'Déclencheur surface',
          formula: `Proxy de déclenchement de surface : ${formatDetailScore(probability.surface_trigger ?? scores.surface_trigger_score)}.`,
          text: 'Ce bloc ajoute un support quand un signal de convergence ou de déclenchement de surface est disponible. S’il vaut zéro, il ne soutient pas la probabilité.',
        },
        probability_penalty: {
          category: 'Probabilité orage',
          title: 'Freins',
          formula: 'Somme des freins appliqués après le score pondéré : CAPE faible ou nulle, basse couche sèche (point de rosée bas, VPD défavorable) et soutiens faibles (rayonnement, couche limite). La CIN réelle n’est pas fournie par AROME et n’entre pas dans le calcul.',
          text: 'Une valeur élevée indique un ingrédient limitant. Les freins évitent surtout les faux positifs liés à CAPE faible ou air sec ; les proxys non issus d’un champ AROME réel ne sont plus utilisés.',
        },
        confidence_consistency: {
          category: 'Confiance',
          title: 'Cohérence',
          formula: '100 - dispersion des ingrédients × 0.42, avec malus si la probabilité est correcte mais qu’un ingrédient clé reste très faible.',
          text: `Plus les ingrédients se tiennent entre eux, plus cette valeur monte. Composants lus : ${detailSupportSummary(p)}.`,
        },
        confidence_temporal: {
          category: 'Confiance',
          title: 'Stabilité horaire',
          formula: '92 - moyenne des écarts de probabilité avec les heures voisines × 0.85. Si aucun voisin n’est disponible : base 74.',
          text: 'Ce bloc mesure si le signal est isolé sur une heure ou s’il reste présent autour du créneau sélectionné.',
        },
        confidence_margin: {
          category: 'Confiance',
          title: 'Marge ingrédients',
          formula: 'Si probabilité ≥ 20 : 0.65 × plancher ingrédients + 0.35 × moyenne ingrédients. Si probabilité < 20 : 0.70 × verrou dominant + 0.30 × (100 − probabilité).',
          text: 'La marge est élevée quand l’ingrédient le plus faible n’est pas trop faible. Elle baisse si un seul verrou suffit à rendre la situation fragile.',
        },
        confidence_floor: {
          category: 'Confiance',
          title: 'Plancher ingrédients',
          formula: `Minimum des composants : ${detailSupportSummary(p)}.`,
          text: 'C’est l’ingrédient le plus faible de la maille. Un plancher bas tire la confiance vers le bas, même si la moyenne reste correcte.',
        },
        confidence_mean: {
          category: 'Confiance',
          title: 'Moyenne ingrédients',
          formula: `Moyenne des composants disponibles : ${detailSupportSummary(p)}.`,
          text: 'Cette moyenne donne le niveau de support global des ingrédients utilisés par la confiance.',
        },
        confidence_spread: {
          category: 'Confiance',
          title: 'Dispersion',
          formula: 'Maximum des composants - minimum des composants.',
          text: 'Plus la dispersion est forte, plus les ingrédients sont déséquilibrés. Une forte dispersion rend le signal moins robuste.',
        },
      };
      const fallback = { category: 'Calcul', title: 'Détail', formula: 'Information indisponible pour ce sous-score.', text: 'La maille ne contient pas le détail nécessaire.' };
      return { ...(info[key] || fallback), value: formatDetailScore(valueByKey[key]) };
    }

    function calcInspectorTone(key, value) {
      const number = detailNumeric(value);
      if (number === null) return "empty";
      if (key === "probability_penalty") return number > 0 ? "negative" : "neutral";
      if (key === "confidence_spread") {
        if (number > 45) return "negative";
        if (number > 25) return "warning";
        return "positive";
      }
      if (number < 25) return "negative";
      if (number < 55) return "neutral";
      return "positive";
    }

    function setDetailsCalcInspectorTone(tone) {
      if (!detailsCalcInspector) return;
      detailsCalcInspector.classList.remove("is-empty", "tone-empty", "tone-negative", "tone-warning", "tone-neutral", "tone-positive");
      detailsCalcInspector.classList.add("tone-" + (tone || "empty"));
      if (!tone || tone === "empty") detailsCalcInspector.classList.add("is-empty");
    }

    function hideDetailsCalcInspector() {
      if (!detailsCalcInspector) return;
      detailsModal?.classList?.remove("has-calc-inspector");
      detailsModal?.querySelectorAll?.(".details-calc-chip.is-active, .details-grid-values .metric-card.is-active").forEach(chip => chip.classList.remove("is-active"));
      clearRelatedValueHighlights();
      if (detailsCalcInspectorCategory) detailsCalcInspectorCategory.textContent = "Détail du calcul";
      if (detailsCalcInspectorTitle) detailsCalcInspectorTitle.textContent = "Sélectionne une valeur ou un sous-score";
      if (detailsCalcInspectorValue) detailsCalcInspectorValue.textContent = "—";
      if (detailsCalcInspectorFormula) detailsCalcInspectorFormula.textContent = "Le détail du calcul s’affichera ici.";
      if (detailsCalcInspectorText) detailsCalcInspectorText.textContent = "";
      setDetailsCalcInspectorTone("empty");
    }

    function showDetailsCalcInspector(key) {
      if (!detailsCalcInspector || !selectedFeature) return;
      detailsModal?.querySelectorAll?.(".details-grid-values .metric-card.is-active").forEach(card => card.classList.remove("is-active"));
      detailsModal?.querySelectorAll?.(".details-calc-chip").forEach(chip => {
        chip.classList.toggle("is-active", chip.dataset.calcKey === key);
      });
      setRelatedValueHighlights(relatedMetricsForCalcKey(key, selectedFeature));
      const info = detailCalcInfo(key, selectedFeature);
      if (detailsCalcInspectorCategory) detailsCalcInspectorCategory.textContent = info.category;
      if (detailsCalcInspectorTitle) detailsCalcInspectorTitle.textContent = info.title;
      if (detailsCalcInspectorValue) detailsCalcInspectorValue.textContent = info.value;
      if (detailsCalcInspectorFormula) detailsCalcInspectorFormula.textContent = info.formula;
      if (detailsCalcInspectorText) detailsCalcInspectorText.textContent = info.text;
      setDetailsCalcInspectorTone(calcInspectorTone(key, info.value));
      detailsModal?.classList?.add("has-calc-inspector");
    }

    function showDetailsValueInspector(card) {
      if (!detailsCalcInspector || !selectedFeature || !card) return;
      const valueElement = card.querySelector?.('.value[id]');
      const metricKey = DETAIL_VALUE_BY_ID[valueElement?.id];
      if (!metricKey) return;
      detailsModal?.querySelectorAll?.(".details-calc-chip.is-active").forEach(chip => chip.classList.remove("is-active"));
      clearRelatedValueHighlights();
      detailsModal?.querySelectorAll?.(".details-grid-values .metric-card").forEach(item => {
        item.classList.toggle("is-active", item === card);
      });
      const info = detailValueInfo(metricKey, selectedFeature);
      if (detailsCalcInspectorCategory) detailsCalcInspectorCategory.textContent = info.category;
      if (detailsCalcInspectorTitle) detailsCalcInspectorTitle.textContent = info.title;
      if (detailsCalcInspectorValue) detailsCalcInspectorValue.textContent = info.value;
      if (detailsCalcInspectorFormula) detailsCalcInspectorFormula.textContent = info.formula;
      if (detailsCalcInspectorText) detailsCalcInspectorText.textContent = info.text;
      const toneSource = info.score === null ? info.value : info.score;
      const tone = info.score === null ? metricTone(metricKey, selectedFeature[metricKey]) : calcInspectorTone(metricKey, toneSource);
      setDetailsCalcInspectorTone(tone);
      detailsModal?.classList?.add("has-calc-inspector");
    }

    function prepareDetailValueCards() {
      detailsModal?.querySelectorAll?.('.details-grid-values .metric-card').forEach(card => {
        const valueElement = card.querySelector?.('.value[id]');
        const metricKey = DETAIL_VALUE_BY_ID[valueElement?.id];
        if (!metricKey) return;
        card.dataset.metricKey = metricKey;
        card.classList.remove('is-active', 'is-related');
        card.setAttribute('role', 'button');
        card.setAttribute('tabindex', '0');
      });
    }

    // La grille est chargée en niveau « render » allégé (sans metric_scores/metrics_used/
    // diagnostics/category_breakdown/summary). Au tap d'une cellule, on récupère la
    // cellule COMPLÈTE à la demande et on l'injecte dans l'objet en mémoire (mutation :
    // toutes les vues — carte, card, modal — voient les détails arriver).
    const cellDetailsPending = new Map();
    async function ensureCellDetails(p) {
      if (!p || p.metric_scores || !p.zone || !p.slot_key) return false;
      const hour = Number(String(p.slot_key).slice(1));
      if (!Number.isFinite(hour)) return false;
      const dateIso = normalizeDateIso(p.day_key || selectedBaseDate);
      const key = `${dateIso}|${p.slot_key}|${p.zone}`;
      if (cellDetailsPending.has(key)) return cellDetailsPending.get(key);
      const job = (async () => {
        try {
          const response = await fetch('/api/meteofrance/grib-france-cell-details', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ date: dateIso, hour, zone: String(p.zone) }),
          });
          const data = await response.json().catch(() => ({}));
          if (!data?.ok || !data.cell) return false;
          Object.assign(p, data.cell);
          return true;
        } catch (_) {
          return false;
        } finally {
          cellDetailsPending.delete(key);
        }
      })();
      cellDetailsPending.set(key, job);
      return job;
    }

    // --- Profil vertical de vent (10 m + niveaux isobares, ARPEGE WCS à la demande) ---
    function windDirCardinal(deg) {
      const dirs = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSO', 'SO', 'OSO', 'O', 'ONO', 'NO', 'NNO'];
      return dirs[Math.round((((deg % 360) + 360) % 360) / 22.5) % 16];
    }
    function windProfileRowsHtml(p, levels) {
      const rows = [];
      const s10 = detailNumeric(p.wind_speed_10m);
      const d10 = detailNumeric(p.wind_direction_10m);
      if (s10 !== null) rows.push({ label: '10 m', speed: s10, dir: d10 });
      (levels || []).forEach((l) => rows.push({ label: l.level + ' hPa', speed: l.speed_ms, dir: l.dir_deg }));
      return rows.map((r) => {
        const speed = (r.speed === null || r.speed === undefined) ? '—' : Math.round(r.speed * 3.6) + ' km/h';
        const dir = (r.dir === null || r.dir === undefined) ? '—'
          : '<span class="wp-arrow" style="display:inline-block;transform:rotate(' + Math.round(r.dir) + 'deg)">↑</span> ' + Math.round(r.dir) + '° ' + windDirCardinal(r.dir);
        return '<div class="wp-row"><span class="wp-level">' + r.label + '</span><span class="wp-speed">' + speed + '</span><span class="wp-dir">' + dir + '</span></div>';
      }).join('');
    }
    const windProfilePending = new Map();
    async function loadWindProfile(p) {
      const section = document.getElementById('dWindProfileSection');
      const body = document.getElementById('dWindProfile');
      if (!section || !body || !p || !p.slot_key) return;
      const hour = Number(String(p.slot_key).slice(1));
      const dateIso = normalizeDateIso(p.day_key || selectedBaseDate);
      if (!Number.isFinite(hour) || p.lat === null || p.lon === undefined || p.lat === undefined || p.lon === null) { section.hidden = true; return; }
      section.hidden = false;
      body.innerHTML = windProfileRowsHtml(p, []) + '<div class="wp-loading">Niveaux d’altitude…</div>';
      const key = dateIso + '|' + hour + '|' + Number(p.lat).toFixed(1) + '|' + Number(p.lon).toFixed(1);
      try {
        let job = windProfilePending.get(key);
        if (!job) {
          job = fetch('/api/meteofrance/grib-france-wind-profile', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ date: dateIso, hour, lat: Number(p.lat), lon: Number(p.lon) }),
          }).then((r) => r.json()).catch(() => ({}));
          windProfilePending.set(key, job);
        }
        const data = await job;
        windProfilePending.delete(key);
        if (selectedFeature === p && data && data.ok) {
          body.innerHTML = windProfileRowsHtml(p, data.profile || []);
        }
      } catch (_) {
        body.innerHTML = windProfileRowsHtml(p, []);
      }
    }

    function selectionContextSummary(p) {
      const bits = [];
      const cape = detailNumeric(p.mucape);
      if (cape !== null) bits.push(`CAPE ${Math.round(cape)} J/kg`);
      const dew = detailNumeric(p.dewpoint_c);
      if (dew !== null) bits.push(`Pt rosée ${Math.round(dew)} °C`);
      const conv = detailNumeric(p.surface_convergence_1e4s);
      if (conv !== null) bits.push(`Conv. ${conv.toFixed(1)}`);
      return bits.join(' · ');
    }

