    function safe(value, suffix = '') {
      if (value === undefined || value === null || value === '') return '-';
      return `${value}${suffix}`;
    }

    const METRIC_INFO = {
      score_global: {
        label: 'Score global',
        explain: 'Synthèse du potentiel de la cellule. Il combine le déclenchement, l’organisation et la qualité de chasse. Plus la valeur est haute, plus la zone mérite de l’attention, sans garantir à elle seule un orage.'
      },
      confidence_score: {
        label: 'Confiance',
        explain: 'Indice de robustesse du signal. Il augmente quand plusieurs paramètres vont dans le même sens. Une confiance élevée signifie un signal plus cohérent, pas forcément un risque plus fort.'
      },
      trigger_score: {
        label: 'Déclenchement',
        explain: 'Estime la facilité à lancer de la convection. Il repose surtout sur l’instabilité disponible, l’humidité en basse couche, le VPD, le point de rosée et le bulbe humide.'
      },
      structure_score: {
        label: 'Organisation',
        explain: 'Mesure le potentiel d’organisation des cellules. Il repose principalement sur le cisaillement vertical approximé et la dynamique de surface via les rafales.'
      },
      chase_quality_score: {
        label: 'Lisibilité',
        explain: 'Cherche à dire si la zone est exploitable sur le terrain. Il prend en compte surtout la nébulosité et l’environnement visuel, pour éviter les secteurs prometteurs mais peu lisibles.'
      },
      stability_score: {
        label: 'Stabilité',
        explain: 'Mesure la tenue horaire du signal autour du créneau retenu. Une bonne stabilité signifie que le potentiel ne repose pas sur une seule heure isolée et fragile.'
      },
      mucape: {
        label: 'CAPE',
        explain: 'Convective Available Potential Energy. C’est l’énergie disponible pour les ascendances. Plus elle est élevée, plus l’environnement peut soutenir des développements convectifs intenses si un déclenchement se produit.'
      },
      shear_ms: {
        label: 'Shear',
        explain: 'Cisaillement vertical du vent, ici approché entre 10 m et 100 m. Il aide à l’organisation des cellules et peut favoriser des structures plus durables ou mieux organisées.'
      },
      relative_humidity_2m: {
        label: 'Humidité 2 m',
        explain: 'Humidité relative près du sol. Une basse couche plus humide favorise généralement l’alimentation convective et limite le mélange trop sec.'
      },
      vapour_pressure_deficit: {
        label: 'VPD',
        explain: 'Vapour Pressure Deficit, un indicateur de sécheresse de l’air. Un VPD trop élevé traduit souvent une basse couche plus sèche et moins favorable au déclenchement.'
      },
      wet_bulb_temperature_2m: {
        label: 'Bulbe humide',
        explain: 'Température humide théorique de l’air près du sol. Elle aide à lire le contenu thermo-hygrométrique de la basse couche et le caractère plus ou moins favorable à la convection.'
      },
      dewpoint_c: {
        label: 'Point de rosée',
        explain: 'Température à laquelle l’air deviendrait saturé. Un point de rosée plus élevé signale souvent une meilleure charge en humidité pour alimenter la convection.'
      },
      temp_c: {
        label: 'Température',
        explain: 'Température de surface. Elle agit avec l’humidité et l’insolation sur l’instabilité, mais sa lecture seule ne suffit jamais à conclure.'
      },
      wind_gusts_10m: {
        label: 'Rafales 10 m',
        explain: 'Rafales prévues près du sol. Elles servent ici surtout à qualifier un minimum de dynamique de surface dans l’environnement.'
      },
      cloud_cover_low: {
        label: 'Nuages bas',
        explain: 'Nébulosité basse couche. Trop de nuages bas peut freiner l’insolation et rendre la zone moins agréable ou moins lisible pour la chasse.'
      },
      cloud_cover_mid: {
        label: 'Nuages moyens',
        explain: 'Nébulosité de moyenne couche. Une couverture importante peut signaler une masse d’air moins propre ou un potentiel de chauffage diurne réduit.'
      },
      cloud_cover_high: {
        label: 'Nuages hauts',
        explain: 'Voile d’altitude. Des nuages hauts étendus peuvent limiter le rayonnement solaire et rendre la lecture du ciel moins nette.'
      },
      selected_hour: {
        label: 'Heure retenue',
        explain: 'Heure jugée la plus favorable dans le créneau sélectionné pour cette cellule, selon le score calculé par le script.'
      }
    };

    function toNumber(value) {
      if (value === undefined || value === null || value === '') return null;
      const n = Number(value);
      return Number.isFinite(n) ? n : null;
    }

    function rangeLine(label, text) {
      return `<div><strong>${label} :</strong> ${text}</div>`;
    }

    function scaleCard(title, text) {
      return `<div class="metric-info-scale-card"><strong>${title}</strong><div>${text}</div></div>`;
    }

    function scoreConstruction(metricKey) {
      switch (metricKey) {
        case 'score_global':
          return [
            scaleCard('Construction du score global', 'Le score global est une moyenne pondérée de quatre sous-scores sur 100 : déclenchement 35 %, organisation 30 %, lisibilité 20 % et stabilité 15 %.'),
            scaleCard('Lecture directe', '0–34 faible, 35–64 modéré, 65–84 élevé, 85–100 très élevé.')
          ].join('');
        case 'trigger_score':
          return [
            scaleCard('Métriques utilisées', 'CAPE, humidité 2 m, point de rosée, bulbe humide, VPD et température de surface.'),
            scaleCard('Lecture du sous-score', '0–34 déclenchement faible, 35–64 signal exploitable, 65–84 déclenchement favorable, 85–100 déclenchement très favorable.')
          ].join('');
        case 'structure_score':
          return [
            scaleCard('Métriques utilisées', 'Shear approximé et rafales 10 m, pour estimer l’organisation potentielle de la convection.'),
            scaleCard('Lecture du sous-score', '0–34 peu organisée, 35–64 organisation moyenne, 65–84 environnement structurant, 85–100 organisation très favorable.')
          ].join('');
        case 'chase_quality_score':
          return [
            scaleCard('Métriques utilisées', 'Nuages bas, moyens et hauts, avec une logique terrain orientée lisibilité et chauffage.'),
            scaleCard('Lecture du sous-score', '0–34 lisibilité faible, 35–64 correcte, 65–84 bonne, 85–100 excellente visibilité tactique.')
          ].join('');
        case 'stability_score':
          return [
            scaleCard('Métriques utilisées', 'Cohérence du signal autour de l’heure retenue, avant et après le créneau optimal.'),
            scaleCard('Lecture du sous-score', '0–34 fenêtre fragile, 35–64 correcte, 65–84 bonne tenue, 85–100 très bonne persistance.')
          ].join('');
        case 'confidence_score':
          return [
            scaleCard('Ce que mesure la confiance', 'Elle ne remplace pas le score global : elle indique à quel point les métriques vont dans le même sens.'),
            scaleCard('Lecture du sous-score', '0–34 fragile, 35–64 moyenne, 65–84 bonne, 85–100 très bonne cohérence du signal.')
          ].join('');
        case 'mucape':
          return [
            scaleCard('Barème utilisé', '< 200 J/kg très faible · 200–799 faible · 800–1499 correcte · 1500–2499 forte · ≥ 2500 très forte.')
          ].join('');
        case 'shear_ms':
          return [
            scaleCard('Barème utilisé', '< 10 m/s faible · 10–14.9 correct · 15–25 favorable · > 25 très dynamique.')
          ].join('');
        case 'relative_humidity_2m':
          return [
            scaleCard('Barème utilisé', '< 50 % sèche · 50–64 moyenne · 65–74 humide · ≥ 75 très humide.')
          ].join('');
        case 'vapour_pressure_deficit':
          return [
            scaleCard('Barème utilisé', '≤ 0.8 très favorable · 0.81–1.4 favorable · 1.41–2.2 moyen · > 2.2 sec.')
          ].join('');
        case 'wet_bulb_temperature_2m':
          return [
            scaleCard('Barème utilisé', '< 12 °C basse · 12–15.9 °C moyenne · ≥ 16 °C favorable.')
          ].join('');
        case 'dewpoint_c':
          return [
            scaleCard('Barème utilisé', '< 8 °C bas · 8–11.9 °C correct · 12–15.9 °C humide · ≥ 16 °C très humide.')
          ].join('');
        case 'temp_c':
          return [
            scaleCard('Barème utilisé', '< 18 °C limitée · 18–23.9 °C correcte · 24–29.9 °C chaude · ≥ 30 °C très chaude.')
          ].join('');
        case 'wind_gusts_10m':
          return [
            scaleCard('Barème utilisé', '< 12 m/s faibles · 12–17.9 m/s présentes · ≥ 18 m/s dynamiques.')
          ].join('');
        case 'cloud_cover_low':
        case 'cloud_cover_mid':
          return [
            scaleCard('Barème utilisé', '0–55 % favorables · 56–75 % acceptables · > 75 % pénalisants.')
          ].join('');
        case 'cloud_cover_high':
          return [
            scaleCard('Barème utilisé', '0–70 % limités · 71–89 % présents · ≥ 90 % envahissants.')
          ].join('');
        case 'selected_hour':
          return [
            scaleCard('Lecture', 'Il ne s’agit pas d’un score : c’est l’heure retenue comme optimum local pour la cellule.')
          ].join('');
        default:
          return '';
      }
    }
    function operationalGuide(metricKey, rawValue) {
      const value = toNumber(rawValue);
      if (metricKey === 'selected_hour') {
        return {
          state: 'Lecture',
          guide: [
            rangeLine('Usage', 'ce n’est pas un score, mais l’heure jugée la plus favorable dans le créneau affiché.'),
            rangeLine('Terrain', 'à confronter au radar, aux observations visuelles et à l’évolution réelle de la convection.')
          ].join('')
        };
      }
      if (value === null) {
        return { state: 'Valeur indisponible', guide: rangeLine('Lecture', 'aucune interprétation fiable tant que la donnée n’est pas chargée.') };
      }

      switch (metricKey) {
        case 'score_global':
        case 'trigger_score':
        case 'structure_score':
        case 'chase_quality_score':
        case 'stability_score': {
          const state = value < 35 ? 'Faible' : value < 65 ? 'Modéré' : value < 85 ? 'Élevé' : 'Très élevé';
          return {
            state,
            guide: [
              rangeLine('Faible', '0–34 : peu prioritaire.'),
              rangeLine('Modéré', '35–64 : à surveiller.'),
              rangeLine('Élevé', '65–84 : zone intéressante.'),
              rangeLine('Très élevé', '85–100 : cible prioritaire si le reste confirme.')
            ].join('')
          };
        }
        case 'confidence_score': {
          const state = value < 35 ? 'Fragile' : value < 65 ? 'Moyenne' : value < 85 ? 'Bonne' : 'Très bonne';
          return {
            state,
            guide: [
              rangeLine('Fragile', '0–34 : signal instable ou peu cohérent.'),
              rangeLine('Moyenne', '35–64 : lecture possible, mais prudence.'),
              rangeLine('Bonne', '65–84 : plusieurs signaux convergent.'),
              rangeLine('Très bonne', '85–100 : signal solide pour la cellule.')
            ].join('')
          };
        }
        case 'mucape': {
          const state = value < 200 ? 'Très faible' : value < 800 ? 'Faible' : value < 1500 ? 'Correcte' : value < 2500 ? 'Forte' : 'Très forte';
          return {
            state,
            guide: [
              rangeLine('Très faible', '< 200 J/kg : peu d’énergie.'),
              rangeLine('Faible', '200–799 J/kg : convection limitée.'),
              rangeLine('Correcte', '800–1499 J/kg : base exploitable.'),
              rangeLine('Forte', '1500–2499 J/kg : bon carburant convectif.'),
              rangeLine('Très forte', '≥ 2500 J/kg : environnement potentiellement explosif si déclenchement.')
            ].join('')
          };
        }
        case 'shear_ms': {
          const state = value < 10 ? 'Faible' : value < 15 ? 'Correct' : value <= 25 ? 'Favorable' : 'Très dynamique';
          return {
            state,
            guide: [
              rangeLine('Faible', '< 10 m/s : organisation limitée.'),
              rangeLine('Correct', '10–14.9 m/s : amélioration possible.'),
              rangeLine('Favorable', '15–25 m/s : bon créneau pour des structures mieux organisées.'),
              rangeLine('Très dynamique', '> 25 m/s : environnement très cisaillé, à interpréter avec le reste.')
            ].join('')
          };
        }
        case 'relative_humidity_2m': {
          const state = value < 50 ? 'Sèche' : value < 65 ? 'Moyenne' : value < 75 ? 'Humide' : 'Très humide';
          return {
            state,
            guide: [
              rangeLine('Sèche', '< 50 % : basse couche souvent défavorable.'),
              rangeLine('Moyenne', '50–64 % : mitigé.'),
              rangeLine('Humide', '65–74 % : plutôt favorable.'),
              rangeLine('Très humide', '≥ 75 % : bonne alimentation en humidité.')
            ].join('')
          };
        }
        case 'vapour_pressure_deficit': {
          const state = value <= 0.8 ? 'Très favorable' : value <= 1.4 ? 'Favorable' : value <= 2.2 ? 'Moyen' : 'Sec';
          return {
            state,
            guide: [
              rangeLine('Très favorable', '≤ 0.8 : basse couche bien humide.'),
              rangeLine('Favorable', '0.81–1.4 : encore bon.'),
              rangeLine('Moyen', '1.41–2.2 : vigilance.'),
              rangeLine('Sec', '> 2.2 : air trop sec pour un bon déclenchement.')
            ].join('')
          };
        }
        case 'wet_bulb_temperature_2m': {
          const state = value < 12 ? 'Basse' : value < 16 ? 'Moyenne' : 'Favorable';
          return {
            state,
            guide: [
              rangeLine('Basse', '< 12 °C : contenu humide limité.'),
              rangeLine('Moyenne', '12–15.9 °C : situation intermédiaire.'),
              rangeLine('Favorable', '≥ 16 °C : basse couche plus propice à la convection.')
            ].join('')
          };
        }
        case 'dewpoint_c': {
          const state = value < 8 ? 'Bas' : value < 12 ? 'Correct' : value < 16 ? 'Humide' : 'Très humide';
          return {
            state,
            guide: [
              rangeLine('Bas', '< 8 °C : humidité limitée.'),
              rangeLine('Correct', '8–11.9 °C : acceptable selon le contexte.'),
              rangeLine('Humide', '12–15.9 °C : alimentation correcte.'),
              rangeLine('Très humide', '≥ 16 °C : bonne réserve d’humidité.')
            ].join('')
          };
        }
        case 'temp_c': {
          const state = value < 18 ? 'Limitée' : value < 24 ? 'Correcte' : value < 30 ? 'Chaude' : 'Très chaude';
          return {
            state,
            guide: [
              rangeLine('Limitée', '< 18 °C : faible chauffage.'),
              rangeLine('Correcte', '18–23.9 °C : contexte exploitable.'),
              rangeLine('Chaude', '24–29.9 °C : bon soutien au chauffage diurne.'),
              rangeLine('Très chaude', '≥ 30 °C : à lire avec l’humidité, car chaleur seule ne suffit pas.')
            ].join('')
          };
        }
        case 'wind_gusts_10m': {
          const state = value < 12 ? 'Faibles' : value < 18 ? 'Présentes' : 'Dynamiques';
          return {
            state,
            guide: [
              rangeLine('Faibles', '< 12 m/s : peu de dynamique de surface.'),
              rangeLine('Présentes', '12–17.9 m/s : contribution utile.'),
              rangeLine('Dynamiques', '≥ 18 m/s : surface plus active.')
            ].join('')
          };
        }
        case 'cloud_cover_low':
        case 'cloud_cover_mid': {
          const state = value <= 55 ? 'Favorables' : value <= 75 ? 'Acceptables' : 'Pénalisants';
          return {
            state,
            guide: [
              rangeLine('Favorables', '0–55 % : chauffage diurne plutôt préservé.'),
              rangeLine('Acceptables', '56–75 % : impact possible.'),
              rangeLine('Pénalisants', '> 75 % : ciel encombré, chasse moins lisible.')
            ].join('')
          };
        }
        case 'cloud_cover_high': {
          const state = value <= 70 ? 'Limités' : value < 90 ? 'Présents' : 'Envahissants';
          return {
            state,
            guide: [
              rangeLine('Limités', '0–70 % : impact réduit.'),
              rangeLine('Présents', '71–89 % : voile notable.'),
              rangeLine('Envahissants', '≥ 90 % : fort écran d’altitude.')
            ].join('')
          };
        }
        default:
          return { state: 'Lecture', guide: rangeLine('Valeur', 'interprétation contextuelle, à croiser avec le reste.') };
      }
    }

    function openMetricInfo(metricKey, currentValue) {
      const meta = METRIC_INFO[metricKey];
      if (!meta) return;
      const op = operationalGuide(metricKey, currentValue);
      infoMetricLabel.textContent = `${meta.label} · ${op.state}`;
      infoMetricValue.textContent = currentValue || '—';
      infoExplanation.innerHTML = `
        <div class="metric-info-explain">${meta.explain}</div>
        <div class="metric-info-heading"><strong>Barème utilisé</strong></div>
        <div class="metric-info-scales">${scoreConstruction(metricKey)}</div>
        <div class="metric-info-heading"><strong>Lecture terrain</strong></div>
        <div class="metric-info-guide">${op.guide}</div>
      `;
      infoBackdrop.classList.add('visible');
      infoModal.classList.add('visible');
    }

    function closeMetricInfo() {
      infoBackdrop.classList.remove('visible');
      infoModal.classList.remove('visible');
    }

    function metricTone(metricKey, rawValue) {
      const value = Number(rawValue);
      if (!Number.isFinite(value)) return 'neutral';
      switch (metricKey) {
        case 'score_global':
        case 'confidence_score':
        case 'trigger_score':
        case 'structure_score':
        case 'chase_quality_score':
        case 'stability_score':
          return value >= 60 ? 'positive' : value <= 35 ? 'negative' : 'neutral';
        case 'mucape':
          return value >= 800 ? 'positive' : value < 300 ? 'negative' : 'neutral';
        case 'shear_ms':
          return value >= 14 ? 'positive' : value < 8 ? 'negative' : 'neutral';
        case 'relative_humidity_2m':
          return value >= 65 ? 'positive' : value < 45 ? 'negative' : 'neutral';
        case 'vapour_pressure_deficit':
          return value <= 1.5 ? 'positive' : value > 2.2 ? 'negative' : 'neutral';
        case 'wet_bulb_temperature_2m':
          return value >= 15 ? 'positive' : value < 10 ? 'negative' : 'neutral';
        case 'dewpoint_c':
          return value >= 15 ? 'positive' : value < 10 ? 'negative' : 'neutral';
        case 'temp_c':
          return value >= 20 && value <= 30 ? 'positive' : value < 15 || value > 34 ? 'negative' : 'neutral';
        case 'wind_gusts_10m':
          return value >= 12 ? 'positive' : value < 6 ? 'negative' : 'neutral';
        case 'cloud_cover_low':
        case 'cloud_cover_mid':
          return value <= 55 ? 'positive' : value > 75 ? 'negative' : 'neutral';
        case 'cloud_cover_high':
          return value <= 70 ? 'positive' : value >= 90 ? 'negative' : 'neutral';
        default:
          return 'neutral';
      }
    }

    function applyMetricTone(element, metricKey, rawValue) {
      if (!element) return;
      element.classList.remove('metric-value-positive', 'metric-value-negative', 'metric-value-neutral');
      const tone = metricTone(metricKey, rawValue);
      element.classList.add(`metric-value-${tone}`);
    }

