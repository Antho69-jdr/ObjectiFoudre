// selection-detail-data.js — issu du découpage de selection.js (Phase 3).
// Helpers de formatage + tables de métriques/valeurs/relations de la modale détails. Chargé 1er.
    
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
      const cin = Number(p.convective_inhibition);
      const prob = Number(p.trigger_score);
      if (Number.isFinite(cape) && cape < 50) return 'CAPE très faible, signal très conditionnel';
      if (Number.isFinite(cin) && Math.abs(cin) >= 125) return 'Inhibition directe forte';
      if (Number.isFinite(cape) && cape < 150) return 'Instabilité très marginale';
      if (Number.isFinite(td) && td < 8) return 'Humidité trop faible en basse couche';
      if (Number.isFinite(vpd) && vpd > 2.5) return 'Air trop sec en basse couche';
      if (Number.isFinite(cape) && cape >= 600 && Number.isFinite(td) && td >= 14) return 'Instabilité et humidité bien alignées';
      if (Number.isFinite(prob) && prob >= 70) return 'Potentiel orageux bien établi';
      return `${scoreBand(prob)} · équilibre instabilité / humidité`;
    }

    const SELECTION_CITY_REFERENCES = [
      { city: 'Paris', department: 'Paris', lat: 48.8566, lon: 2.3522 },
      { city: 'Lyon', department: 'Rhône', lat: 45.7640, lon: 4.8357 },
      { city: 'Marseille', department: 'Bouches-du-Rhône', lat: 43.2965, lon: 5.3698 },
      { city: 'Toulouse', department: 'Haute-Garonne', lat: 43.6047, lon: 1.4442 },
      { city: 'Nice', department: 'Alpes-Maritimes', lat: 43.7102, lon: 7.2620 },
      { city: 'Nantes', department: 'Loire-Atlantique', lat: 47.2184, lon: -1.5536 },
      { city: 'Montpellier', department: 'Hérault', lat: 43.6110, lon: 3.8767 },
      { city: 'Strasbourg', department: 'Bas-Rhin', lat: 48.5734, lon: 7.7521 },
      { city: 'Bordeaux', department: 'Gironde', lat: 44.8378, lon: -0.5792 },
      { city: 'Lille', department: 'Nord', lat: 50.6292, lon: 3.0573 },
      { city: 'Rennes', department: 'Ille-et-Vilaine', lat: 48.1173, lon: -1.6778 },
      { city: 'Reims', department: 'Marne', lat: 49.2583, lon: 4.0317 },
      { city: 'Saint-Étienne', department: 'Loire', lat: 45.4397, lon: 4.3872 },
      { city: 'Toulon', department: 'Var', lat: 43.1242, lon: 5.9280 },
      { city: 'Le Havre', department: 'Seine-Maritime', lat: 49.4944, lon: 0.1079 },
      { city: 'Grenoble', department: 'Isère', lat: 45.1885, lon: 5.7245 },
      { city: 'Dijon', department: 'Côte-d’Or', lat: 47.3220, lon: 5.0415 },
      { city: 'Angers', department: 'Maine-et-Loire', lat: 47.4784, lon: -0.5632 },
      { city: 'Nîmes', department: 'Gard', lat: 43.8367, lon: 4.3601 },
      { city: 'Clermont-Ferrand', department: 'Puy-de-Dôme', lat: 45.7772, lon: 3.0870 },
      { city: 'Le Mans', department: 'Sarthe', lat: 48.0061, lon: 0.1996 },
      { city: 'Aix-en-Provence', department: 'Bouches-du-Rhône', lat: 43.5297, lon: 5.4474 },
      { city: 'Brest', department: 'Finistère', lat: 48.3904, lon: -4.4861 },
      { city: 'Tours', department: 'Indre-et-Loire', lat: 47.3941, lon: 0.6848 },
      { city: 'Amiens', department: 'Somme', lat: 49.8941, lon: 2.2958 },
      { city: 'Limoges', department: 'Haute-Vienne', lat: 45.8336, lon: 1.2611 },
      { city: 'Annecy', department: 'Haute-Savoie', lat: 45.8992, lon: 6.1294 },
      { city: 'Perpignan', department: 'Pyrénées-Orientales', lat: 42.6887, lon: 2.8948 },
      { city: 'Metz', department: 'Moselle', lat: 49.1193, lon: 6.1757 },
      { city: 'Besançon', department: 'Doubs', lat: 47.2380, lon: 6.0241 },
      { city: 'Orléans', department: 'Loiret', lat: 47.9029, lon: 1.9093 },
      { city: 'Rouen', department: 'Seine-Maritime', lat: 49.4431, lon: 1.0993 },
      { city: 'Mulhouse', department: 'Haut-Rhin', lat: 47.7508, lon: 7.3359 },
      { city: 'Caen', department: 'Calvados', lat: 49.1829, lon: -0.3707 },
      { city: 'Nancy', department: 'Meurthe-et-Moselle', lat: 48.6921, lon: 6.1844 },
      { city: 'Avignon', department: 'Vaucluse', lat: 43.9493, lon: 4.8055 },
      { city: 'Poitiers', department: 'Vienne', lat: 46.5802, lon: 0.3404 },
      { city: 'Pau', department: 'Pyrénées-Atlantiques', lat: 43.2951, lon: -0.3708 },
      { city: 'La Rochelle', department: 'Charente-Maritime', lat: 46.1603, lon: -1.1511 },
      { city: 'Calais', department: 'Pas-de-Calais', lat: 50.9513, lon: 1.8587 },
      { city: 'Dunkerque', department: 'Nord', lat: 51.0344, lon: 2.3768 },
      { city: 'Chambéry', department: 'Savoie', lat: 45.5646, lon: 5.9178 },
      { city: 'Valence', department: 'Drôme', lat: 44.9334, lon: 4.8924 },
      { city: 'Bayonne', department: 'Pyrénées-Atlantiques', lat: 43.4933, lon: -1.4751 },
      { city: 'Tarbes', department: 'Hautes-Pyrénées', lat: 43.2329, lon: 0.0781 },
      { city: 'Albi', department: 'Tarn', lat: 43.9298, lon: 2.1480 },
      { city: 'Montauban', department: 'Tarn-et-Garonne', lat: 44.0221, lon: 1.3529 },
      { city: 'Carcassonne', department: 'Aude', lat: 43.2130, lon: 2.3491 },
      { city: 'Béziers', department: 'Hérault', lat: 43.3442, lon: 3.2158 },
      { city: 'Narbonne', department: 'Aude', lat: 43.1843, lon: 3.0031 },
      { city: 'Mende', department: 'Lozère', lat: 44.5181, lon: 3.4991 },
      { city: 'Aurillac', department: 'Cantal', lat: 44.9309, lon: 2.4447 },
      { city: 'Rodez', department: 'Aveyron', lat: 44.3494, lon: 2.5759 },
      { city: 'Cahors', department: 'Lot', lat: 44.4475, lon: 1.4419 },
      { city: 'Périgueux', department: 'Dordogne', lat: 45.1840, lon: 0.7211 },
      { city: 'Agen', department: 'Lot-et-Garonne', lat: 44.2049, lon: 0.6212 },
      { city: 'Mont-de-Marsan', department: 'Landes', lat: 43.8911, lon: -0.5006 },
      { city: 'Niort', department: 'Deux-Sèvres', lat: 46.3237, lon: -0.4648 },
      { city: 'La Roche-sur-Yon', department: 'Vendée', lat: 46.6705, lon: -1.4260 },
      { city: 'Saint-Nazaire', department: 'Loire-Atlantique', lat: 47.2735, lon: -2.2138 },
      { city: 'Vannes', department: 'Morbihan', lat: 47.6582, lon: -2.7608 },
      { city: 'Lorient', department: 'Morbihan', lat: 47.7483, lon: -3.3702 },
      { city: 'Quimper', department: 'Finistère', lat: 47.9975, lon: -4.0979 },
      { city: 'Saint-Brieuc', department: 'Côtes-d’Armor', lat: 48.5142, lon: -2.7658 },
      { city: 'Saint-Malo', department: 'Ille-et-Vilaine', lat: 48.6493, lon: -2.0257 },
      { city: 'Cherbourg-en-Cotentin', department: 'Manche', lat: 49.6337, lon: -1.6221 },
      { city: 'Alençon', department: 'Orne', lat: 48.4329, lon: 0.0913 },
      { city: 'Évreux', department: 'Eure', lat: 49.0270, lon: 1.1510 },
      { city: 'Beauvais', department: 'Oise', lat: 49.4300, lon: 2.0800 },
      { city: 'Laon', department: 'Aisne', lat: 49.5641, lon: 3.6245 },
      { city: 'Troyes', department: 'Aube', lat: 48.2973, lon: 4.0744 },
      { city: 'Chaumont', department: 'Haute-Marne', lat: 48.1113, lon: 5.1396 },
      { city: 'Épinal', department: 'Vosges', lat: 48.1744, lon: 6.4494 },
      { city: 'Colmar', department: 'Haut-Rhin', lat: 48.0794, lon: 7.3585 },
      { city: 'Belfort', department: 'Territoire de Belfort', lat: 47.6396, lon: 6.8638 },
      { city: 'Lons-le-Saunier', department: 'Jura', lat: 46.6753, lon: 5.5557 },
      { city: 'Mâcon', department: 'Saône-et-Loire', lat: 46.3069, lon: 4.8310 },
      { city: 'Bourg-en-Bresse', department: 'Ain', lat: 46.2052, lon: 5.2258 },
      { city: 'Privas', department: 'Ardèche', lat: 44.7353, lon: 4.5992 },
      { city: 'Gap', department: 'Hautes-Alpes', lat: 44.5596, lon: 6.0798 },
      { city: 'Digne-les-Bains', department: 'Alpes-de-Haute-Provence', lat: 44.0920, lon: 6.2369 },
      { city: 'Ajaccio', department: 'Corse-du-Sud', lat: 41.9192, lon: 8.7386 },
      { city: 'Bastia', department: 'Haute-Corse', lat: 42.6973, lon: 9.4509 },
      { city: 'Moulins', department: 'Allier', lat: 46.5646, lon: 3.3324 },
      { city: 'Le Puy-en-Velay', department: 'Haute-Loire', lat: 45.0437, lon: 3.8850 },
      { city: 'Nevers', department: 'Nièvre', lat: 46.9896, lon: 3.1590 },
      { city: 'Vesoul', department: 'Haute-Saône', lat: 47.6229, lon: 6.1557 },
      { city: 'Auxerre', department: 'Yonne', lat: 47.7982, lon: 3.5738 },
      { city: 'Bourges', department: 'Cher', lat: 47.0810, lon: 2.3988 },
      { city: 'Chartres', department: 'Eure-et-Loir', lat: 48.4439, lon: 1.4890 },
      { city: 'Châteauroux', department: 'Indre', lat: 46.8114, lon: 1.6868 },
      { city: 'Blois', department: 'Loir-et-Cher', lat: 47.5861, lon: 1.3359 },
      { city: 'Charleville-Mézières', department: 'Ardennes', lat: 49.7625, lon: 4.7247 },
      { city: 'Bar-le-Duc', department: 'Meuse', lat: 48.7726, lon: 5.1611 },
      { city: 'Melun', department: 'Seine-et-Marne', lat: 48.5399, lon: 2.6608 },
      { city: 'Versailles', department: 'Yvelines', lat: 48.8014, lon: 2.1301 },
      { city: 'Évry-Courcouronnes', department: 'Essonne', lat: 48.6298, lon: 2.4418 },
      { city: 'Nanterre', department: 'Hauts-de-Seine', lat: 48.8924, lon: 2.2153 },
      { city: 'Bobigny', department: 'Seine-Saint-Denis', lat: 48.9086, lon: 2.4397 },
      { city: 'Créteil', department: 'Val-de-Marne', lat: 48.7904, lon: 2.4556 },
      { city: 'Cergy', department: 'Val-d’Oise', lat: 49.0356, lon: 2.0603 },
      { city: 'Angoulême', department: 'Charente', lat: 45.6484, lon: 0.1562 },
      { city: 'Tulle', department: 'Corrèze', lat: 45.2670, lon: 1.7707 },
      { city: 'Guéret', department: 'Creuse', lat: 46.1700, lon: 1.8718 },
      { city: 'Foix', department: 'Ariège', lat: 42.9653, lon: 1.6069 },
      { city: 'Auch', department: 'Gers', lat: 43.6465, lon: 0.5867 },
      { city: 'Laval', department: 'Mayenne', lat: 48.0707, lon: -0.7706 },
    ];

    function selectionDistanceKm(lat, lon, ref) {
      const meanLat = ((lat + ref.lat) / 2) * Math.PI / 180;
      const dx = (lon - ref.lon) * 111.0 * Math.cos(meanLat);
      const dy = (lat - ref.lat) * 111.0;
      return Math.hypot(dx, dy);
    }

    function formatSelectionLocation(p) {
      const explicitDepartment = p.department || p.departement || p.dept || p.department_name || p.nom_departement;
      const explicitCity = p.city || p.ville || p.nearest_city || p.commune || p.location_name;
      if (explicitDepartment && explicitCity) return `${explicitDepartment} · ${explicitCity}`;
      const lat = Number(p.lat);
      const lon = Number(p.lon);
      if (Number.isFinite(lat) && Number.isFinite(lon)) {
        let nearest = null;
        let nearestDistance = Infinity;
        for (const ref of SELECTION_CITY_REFERENCES) {
          const distance = selectionDistanceKm(lat, lon, ref);
          if (distance < nearestDistance) {
            nearestDistance = distance;
            nearest = ref;
          }
        }
        if (nearest) return `${nearest.department} · ${nearest.city}`;
      }
      return p.zone && !String(p.zone).startsWith('Franceentière') ? p.zone : 'France · maille AROME';
    }

    function parseDetailObject(value) {
      if (!value) return {};
      if (typeof value === 'object') return value;
      if (typeof value === 'string') {
        try {
          const parsed = JSON.parse(value);
          return parsed && typeof parsed === 'object' ? parsed : {};
        } catch (_) {
          return {};
        }
      }
      return {};
    }

    function detailNumeric(value) {
      const number = Number(value);
      return Number.isFinite(number) ? number : null;
    }

    function formatDetailScore(value, suffix = '') {
      const number = detailNumeric(value);
      if (number === null) return '—';
      const rounded = Math.abs(number) >= 100 ? Math.round(number) : Math.round(number * 10) / 10;
      return `${rounded}${suffix}`;
    }

    function escapeDetailHtml(value) {
      return String(value ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
    }

    function detailChip(label, value, hint = '', options = {}) {
      const tone = options.tone ? ` details-calc-chip-${options.tone}` : '';
      const key = options.key || String(label).toLowerCase().replace(/\s+/g, '_');
      return `
        <button type="button" class="details-calc-chip${tone}" data-calc-key="${escapeDetailHtml(key)}" data-calc-label="${escapeDetailHtml(label)}" data-calc-value="${escapeDetailHtml(value)}">
          <span class="calc-label">${escapeDetailHtml(label)}</span>
          <strong class="calc-value">${escapeDetailHtml(value)}</strong>
          ${hint ? `<span class="calc-hint">${escapeDetailHtml(hint)}</span>` : ''}
        </button>
      `;
    }

    function setCalculationGrid(target, chips) {
      if (!target) return;
      target.innerHTML = chips.filter(Boolean).join('');
    }

    function probabilityBreakdownChips(p) {
      const breakdown = parseDetailObject(p.category_breakdown);
      const probability = parseDetailObject(breakdown.probability);
      const scores = parseDetailObject(p.metric_scores);
      const hasSurface = detailNumeric(probability.surface_trigger ?? scores.surface_trigger_score) !== null;
      return [
        detailChip('Score retenu', formatDetailScore(probability.raw_initiation ?? p.trigger_score), 'contexte inclus', { key: 'probability_raw' }),
        detailChip('Environnement', formatDetailScore(probability.environment ?? scores.environment_score), 'ingrédients seuls', { key: 'probability_environment' }),
        detailChip('Activité AROME', formatDetailScore(probability.convective_activity ?? scores.convective_activity_score), 'pluie/nuages/rafales', { key: 'probability_activity' }),
        detailChip('Instabilité', formatDetailScore(probability.instability ?? scores.cape_score), hasSurface ? 'poids 44 %' : 'poids 50 %', { key: 'probability_instability' }),
        detailChip('Humidité', formatDetailScore(probability.moisture), probability.precipitable_water !== undefined && probability.precipitable_water !== null ? 'inclut colonne' : (hasSurface ? 'poids 34 %' : 'poids 40 %'), { key: 'probability_moisture' }),
        detailChip('Rayonnement', formatDetailScore(probability.surface_heating ?? scores.surface_heating_score ?? scores.timing_score), 'poids 10 %', { key: 'probability_solar' }),
        detailChip('Nébulosité', formatDetailScore(probability.cloud_support ?? scores.cloud_trigger_score), 'contexte AROME', { key: 'probability_clouds' }),
        detailChip('Timing', formatDetailScore(probability.timing ?? scores.timing_score), 'heure seule', { key: 'probability_timing' }),
        hasSurface ? detailChip('Déclencheur surface', formatDetailScore(probability.surface_trigger ?? scores.surface_trigger_score), 'poids 12 %', { key: 'probability_surface' }) : '',
        detailChip('Freins', formatDetailScore(probability.inhibition_penalty), 'CAPE faible / air sec', { key: 'probability_penalty', tone: detailNumeric(probability.inhibition_penalty) > 0 ? 'negative' : 'neutral' }),
      ];
    }

    function confidenceBreakdownChips(p) {
      const breakdown = parseDetailObject(p.category_breakdown);
      const confidence = parseDetailObject(breakdown.confidence);
      const scores = parseDetailObject(p.metric_scores);
      const supportValues = detailSupportComponents(p).map(([, value]) => value);
      const supportFloor = supportValues.length ? Math.min(...supportValues) : null;
      const supportMean = supportValues.length ? supportValues.reduce((sum, value) => sum + value, 0) / supportValues.length : null;
      const spread = supportValues.length ? Math.max(...supportValues) - Math.min(...supportValues) : null;
      return [
        detailChip('Cohérence', formatDetailScore(confidence.consistency ?? scores.confidence_consistency_score), '35 % du score', { key: 'confidence_consistency' }),
        detailChip('Stabilité horaire', formatDetailScore(confidence.temporal_stability ?? scores.confidence_temporal_score), '30 % du score', { key: 'confidence_temporal' }),
        detailChip('Marge ingrédients', formatDetailScore(confidence.margin ?? scores.confidence_margin_score), '35 % du score', { key: 'confidence_margin' }),
        detailChip('Plancher ingrédients', formatDetailScore(supportFloor), 'ingrédient le plus faible', { key: 'confidence_floor' }),
        detailChip('Moyenne ingrédients', formatDetailScore(supportMean), 'support global', { key: 'confidence_mean' }),
        detailChip('Dispersion', formatDetailScore(spread), 'plus bas = plus cohérent', { key: 'confidence_spread', tone: detailNumeric(spread) > 45 ? 'negative' : 'neutral' }),
      ];
    }

    function confidenceHint(p) {
      const breakdown = parseDetailObject(p.category_breakdown);
      const confidence = parseDetailObject(breakdown.confidence);
      const consistency = detailNumeric(confidence.consistency);
      const temporal = detailNumeric(confidence.temporal_stability);
      const margin = detailNumeric(confidence.margin);
      if (consistency !== null && consistency < 45) return 'Signal contradictoire entre ingrédients';
      if (temporal !== null && temporal < 45) return 'Signal instable autour de l’heure';
      if (margin !== null && margin < 45) return 'Marge faible sur un ingrédient clé';
      return 'Cohérence des ingrédients et stabilité autour de l’heure';
    }

    function detailSupportComponents(p) {
      const scores = parseDetailObject(p.metric_scores);
      const components = [];
      const add = (label, rawValue, options = {}) => {
        const value = detailNumeric(rawValue);
        if (value === null) return;
        if (options.minActive !== undefined && value < options.minActive) return;
        components.push([label, value]);
      };
      add('CAPE', scores.cape_score);
      add('Point de rosée', scores.dewpoint_score);
      add('Humidité', scores.humidity_score);
      add('VPD', scores.vpd_score);
      add('Bulbe humide', scores.wetbulb_score);
      add('Vapeur colonne', scores.precipitable_water_score);
      add('Rayonnement', scores.surface_heating_score);
      add('CIN réel', scores.cin_actual_score);
      add('Précipitations actives', scores.precipitation_score, { minActive: 25 });
      add('Rafales actives', scores.gust_potential_score, { minActive: 25 });
      add('Activité AROME', scores.convective_activity_score, { minActive: 25 });
      return components;
    }

    function detailSupportSummary(p) {
      const parts = detailSupportComponents(p).map(([label, value]) => `${label} ${formatDetailScore(value)}`);
      return parts.length ? parts.join(' · ') : 'Détail des composants indisponible pour cette maille.';
    }

    const DETAIL_VALUE_BY_ID = {
      dCape: 'mucape',
      dRh: 'relative_humidity_2m',
      dPrecipitableWater: 'precipitable_water',
      dShortwave: 'shortwave_radiation',
      dPrecipRate: 'precipitation_rate',
      dDewpoint: 'dewpoint_c',
      dWetbulb: 'wet_bulb_temperature_2m',
      dVpd: 'vapour_pressure_deficit',
      dTemp: 'temp_c',
      dGusts: 'wind_gusts_10m',
      dWindSpeed: 'wind_speed_10m',
      dWindDirection: 'wind_direction_10m',
      dSurfaceConvergence: 'surface_convergence_1e4s',
      dCloudLow: 'cloud_cover_low',
      dCloudMid: 'cloud_cover_mid',
      dCloudHigh: 'cloud_cover_high',
    };

    const DETAIL_VALUE_META = {
      mucape: {
        label: 'CAPE', suffix: ' J/kg', scoreKey: 'cape_score',
        definition: 'Énergie potentielle disponible pour les ascendances convectives. Elle estime le carburant vertical disponible si une parcelle d’air peut se soulever.',
        scale: '< 50 très faible · 50-400 marginal · 400-800 modéré · 800-1500 favorable · > 1500 élevé.',
      },
      relative_humidity_2m: {
        label: 'Humidité 2 m', suffix: ' %', scoreKey: 'humidity_score',
        definition: 'Humidité relative près du sol. Elle aide à estimer si la basse couche peut alimenter durablement une convection.',
        scale: '< 45 % sec · 45-60 % moyen · 60-75 % favorable · > 75 % très humide.',
      },
      precipitable_water: {
        label: 'Vapeur colonne', suffix: ' kg/m²', scoreKey: 'precipitable_water_score',
        definition: 'Quantité totale de vapeur d’eau intégrée dans la colonne atmosphérique. Elle complète le point de rosée de surface.',
        scale: '< 18 pauvre · 18-28 utile · 28-38 humide · > 38 très chargé en vapeur.',
      },
      shortwave_radiation: {
        label: 'Rayonnement', suffix: ' W/m²', scoreKey: 'shortwave_radiation_score',
        definition: 'Flux net de rayonnement court prévu par AROME. Il sert de lecture du chauffage diurne réellement prévu.',
        scale: '< 120 faible · 120-250 limité · 250-400 correct · 400-600 favorable · > 600 fort.',
      },
      precipitation_rate: {
        label: 'Précipitation', suffix: ' mm/h', scoreKey: 'precipitation_score',
        definition: 'Taux de précipitations modèle sur l’heure. Dans ce score, c’est surtout un signal d’activité déjà matérialisée.',
        scale: '< 0.05 nul · 0.05-0.30 faible · 0.30-1.20 actif · 1.20-2.50 marqué · > 2.50 fort.',
      },
      dewpoint_c: {
        label: 'Point de rosée', suffix: ' °C', scoreKey: 'dewpoint_score',
        definition: 'Température de saturation de l’air. Plus elle est élevée, plus la basse couche contient d’humidité exploitable.',
        scale: '< 8 °C pauvre · 8-12 °C marginal · 12-16 °C favorable · > 16 °C très favorable.',
      },
      wet_bulb_temperature_2m: {
        label: 'Bulbe humide', suffix: ' °C', scoreKey: 'wetbulb_score',
        definition: 'Température humide théorique. Elle résume une partie du couple température/humidité en basse couche.',
        scale: '< 11 °C faible · 11-14 °C modéré · 14-17 °C favorable · > 17 °C très favorable.',
      },
      vapour_pressure_deficit: {
        label: 'VPD', suffix: '', scoreKey: 'vpd_score',
        definition: 'Déficit de pression de vapeur. Il mesure la sécheresse effective de l’air près du sol.',
        scale: '< 1.0 favorable · 1.0-1.8 correct · 1.8-2.5 sec · > 2.5 très défavorable.',
      },
      temp_c: {
        label: 'Température', suffix: ' °C', scoreKey: null,
        definition: 'Température de surface. Elle aide à lire le chauffage et le contraste avec le point de rosée, mais elle n’est pas un score direct.',
        scale: 'À lire avec point de rosée, VPD, rayonnement et CAPE. Seule, elle ne conclut pas sur le risque orageux.',
      },
      wind_gusts_10m: {
        label: 'Rafales', suffix: ' m/s', scoreKey: 'gust_potential_score',
        definition: 'Rafales prévues à 10 m. Elles servent surtout à détecter une activité ou une dynamique de surface déjà matérialisée.',
        scale: '< 7 m/s faible · 7-14 m/s présent · 14-24 m/s marqué · > 24 m/s fort.',
      },
      wind_speed_10m: {
        label: 'Vent 10 m', suffix: ' m/s', scoreKey: null,
        definition: 'Vitesse du vent moyen près du sol. Elle sert surtout à reconstruire la convergence de surface avec la direction du vent.',
        scale: 'Pas de score direct. La contribution apparaît via le déclencheur surface/convergence.',
      },
      wind_direction_10m: {
        label: 'Direction', suffix: ' °', scoreKey: null,
        definition: 'Direction du vent à 10 m. Elle indique d’où vient le vent et participe au calcul de convergence locale.',
        scale: '0/360 nord · 90 est · 180 sud · 270 ouest. Pas de score direct isolé.',
      },
      surface_convergence_1e4s: {
        label: 'Convergence', suffix: '', scoreKey: 'surface_trigger_score',
        definition: 'Proxy local de convergence de surface reconstruit à partir du vent 10 m des cellules voisines. Positif : air qui converge localement.',
        scale: '< -0.5 divergent · -0.5 à 0.5 neutre · 0.5-1 favorable · > 1 bon déclencheur.',
      },
      cloud_cover_low: {
        label: 'Nuages bas', suffix: ' %', scoreKey: 'cloud_trigger_score',
        definition: 'Nébulosité basse prévue. Elle est lue comme contexte ou signal matérialisé, pas comme un verrou automatique.',
        scale: '0-25 peu présent · 25-55 signal notable · 55-75 très nuageux · > 75 ciel encombré.',
      },
      cloud_cover_mid: {
        label: 'Nuages moyens', suffix: ' %', scoreKey: 'cloud_trigger_score',
        definition: 'Nébulosité de moyenne couche. Elle peut accompagner un développement convectif ou signaler un écran nuageux.',
        scale: '0-25 faible · 25-55 notable · 55-75 étendu · > 75 dominant.',
      },
      cloud_cover_high: {
        label: 'Nuages hauts', suffix: ' %', scoreKey: 'cloud_trigger_score',
        definition: 'Voile ou nébulosité d’altitude. À lire avec le rayonnement court pour juger l’impact sur le chauffage.',
        scale: '0-40 limité · 40-70 présent · 70-90 étendu · > 90 envahissant.',
      },
    };

    const DETAIL_CALC_VALUE_RELATIONS = {
      probability_raw: ['mucape', 'dewpoint_c', 'relative_humidity_2m', 'vapour_pressure_deficit', 'wet_bulb_temperature_2m', 'precipitable_water', 'shortwave_radiation', 'surface_convergence_1e4s', 'precipitation_rate', 'cloud_cover_low', 'cloud_cover_mid', 'cloud_cover_high', 'wind_gusts_10m'],
      probability_environment: ['mucape', 'dewpoint_c', 'relative_humidity_2m', 'vapour_pressure_deficit', 'wet_bulb_temperature_2m', 'precipitable_water', 'shortwave_radiation', 'surface_convergence_1e4s'],
      probability_activity: ['precipitation_rate', 'cloud_cover_low', 'cloud_cover_mid', 'cloud_cover_high', 'wind_gusts_10m'],
      probability_instability: ['mucape'],
      probability_moisture: ['dewpoint_c', 'relative_humidity_2m', 'vapour_pressure_deficit', 'wet_bulb_temperature_2m', 'precipitable_water'],
      probability_solar: ['shortwave_radiation'],
      probability_clouds: ['cloud_cover_low', 'cloud_cover_mid', 'cloud_cover_high'],
      probability_surface: ['wind_speed_10m', 'wind_direction_10m', 'surface_convergence_1e4s'],
      probability_penalty: ['mucape', 'dewpoint_c', 'vapour_pressure_deficit'],
    };

    const DETAIL_CONFIDENCE_COMPONENTS = [
      { scoreKey: 'cape_score', metrics: ['mucape'] },
      { scoreKey: 'dewpoint_score', metrics: ['dewpoint_c'] },
      { scoreKey: 'humidity_score', metrics: ['relative_humidity_2m'] },
      { scoreKey: 'vpd_score', metrics: ['vapour_pressure_deficit'] },
      { scoreKey: 'wetbulb_score', metrics: ['wet_bulb_temperature_2m'] },
      { scoreKey: 'precipitable_water_score', metrics: ['precipitable_water'] },
      { scoreKey: 'surface_heating_score', metrics: ['shortwave_radiation'] },
      { scoreKey: 'precipitation_score', metrics: ['precipitation_rate'], minActive: 25 },
      { scoreKey: 'gust_potential_score', metrics: ['wind_gusts_10m'], minActive: 25 },
      { scoreKey: 'convective_activity_score', metrics: ['precipitation_rate', 'cloud_cover_low', 'cloud_cover_mid', 'cloud_cover_high', 'wind_gusts_10m'], minActive: 25 },
    ];

    function confidenceMetricComponents(p) {
      const scores = parseDetailObject(p.metric_scores);
      return DETAIL_CONFIDENCE_COMPONENTS
        .map(component => ({ ...component, value: detailNumeric(scores[component.scoreKey]) }))
        .filter(component => component.value !== null && (component.minActive === undefined || component.value >= component.minActive));
    }

    function uniqueMetricKeys(keys) {
      return [...new Set((keys || []).filter(Boolean))];
    }

    function relatedMetricsForCalcKey(key, p) {
      if (DETAIL_CALC_VALUE_RELATIONS[key]) return DETAIL_CALC_VALUE_RELATIONS[key];
      const confidenceComponents = confidenceMetricComponents(p);
      if (key === 'confidence_floor') {
        if (!confidenceComponents.length) return [];
        const minValue = Math.min(...confidenceComponents.map(component => component.value));
        return uniqueMetricKeys(confidenceComponents.filter(component => component.value === minValue).flatMap(component => component.metrics));
      }
      if (key === 'confidence_spread') {
        if (!confidenceComponents.length) return [];
        const values = confidenceComponents.map(component => component.value);
        const minValue = Math.min(...values);
        const maxValue = Math.max(...values);
        return uniqueMetricKeys(confidenceComponents.filter(component => component.value === minValue || component.value === maxValue).flatMap(component => component.metrics));
      }
      if (key === 'confidence_consistency' || key === 'confidence_margin' || key === 'confidence_mean') {
        return uniqueMetricKeys(confidenceComponents.flatMap(component => component.metrics));
      }
      if (key === 'confidence_temporal') return [];
      return [];
    }

    function clearRelatedValueHighlights() {
      detailsModal?.querySelectorAll?.('.details-grid-values .metric-card.is-related').forEach(card => card.classList.remove('is-related'));
    }

    function setRelatedValueHighlights(metricKeys = []) {
      const wanted = new Set(metricKeys);
      detailsModal?.querySelectorAll?.('.details-grid-values .metric-card').forEach(card => {
        card.classList.toggle('is-related', wanted.has(card.dataset.metricKey));
      });
    }

    function valueScoreForMetric(metricKey, p) {
      const meta = DETAIL_VALUE_META[metricKey] || {};
      if (!meta.scoreKey) return null;
      const scores = parseDetailObject(p.metric_scores);
      return detailNumeric(scores[meta.scoreKey]);
    }

    function formatDetailValue(metricKey, p) {
      const meta = DETAIL_VALUE_META[metricKey] || {};
      const value = p?.[metricKey];
      if (value === undefined || value === null || value === '') return '—';
      return `${value}${meta.suffix || ''}`;
    }

    function detailValueInfo(metricKey, p) {
      const meta = DETAIL_VALUE_META[metricKey] || { label: 'Valeur météo', definition: 'Valeur brute utilisée par la cellule.', scale: 'Lecture contextuelle.' };
      const score = valueScoreForMetric(metricKey, p);
      const scoreText = score === null ? 'pas de score direct' : `score lié ${formatDetailScore(score)}/100`;
      return {
        category: 'Valeur météo utilisée',
        title: meta.label,
        value: formatDetailValue(metricKey, p),
        formula: `Récap : ${meta.label} = ${formatDetailValue(metricKey, p)} · ${scoreText}.`,
        text: `${meta.definition} Échelle : ${meta.scale}`,
        score,
      };
    }

