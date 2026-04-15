    function safe(value, suffix = '') {
      if (value === undefined || value === null || value === '') return '-';
      return `${value}${suffix}`;
    }

    const METRIC_INFO = {
      score_global: {
        label: 'Score global',
        explain: 'Synthèse v2 de l’intérêt réel de la cellule pour une chasse. Il combine Probabilité orage, Sévérité et Qualité de chasse. La Probabilité orage fusionne déjà initiation brute, fiabilité locale et pénalité de Bust Risk.'
      },
      confidence_score: {
        label: 'Bust Risk',
        explain: 'Risque qu’une cellule paraisse prometteuse mais produise peu ou rien sur le terrain. Ici, plus la valeur est haute, plus le risque de déplacement inutile augmente.'
      },
      trigger_score: {
        label: 'Probabilité orage',
        explain: 'Estime la probabilité réelle d’obtenir une convection exploitable. Le score fusionne l’initiation brute, la fiabilité locale du signal et une pénalité de Bust Risk pour éviter les faux positifs flatteurs.'
      },
      structure_score: {
        label: 'Sévérité',
        explain: 'Mesure le potentiel d’intensité et d’organisation si la convection part. Le score repose surtout sur le shear, la CAPE et la dynamique de surface.'
      },
      chase_quality_score: {
        label: 'Qualité de chasse',
        explain: 'Mesure l’intérêt terrain pour la chasse. Il combine visibilité, photogénie et confort relatif à partir de la nébulosité, du timing et d’un proxy de vent.'
      },
      stability_score: {
        label: 'Fiabilité',
        explain: 'Toujours calculée en interne, mais désormais réinjectée dans la Probabilité orage. Elle mesure la robustesse du signal via cohérence interne, stabilité locale et marge vis-à-vis des seuils.'
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
          const state = value < 20 ? 'Très faible' : value < 40 ? 'Faible' : value < 60 ? 'Modéré' : value < 80 ? 'Élevé' : 'Très élevé';
          return {
            state,
            guide: [
              rangeLine('Très faible', '0–19 : risque de bust contenu.'),
              rangeLine('Faible', '20–39 : déplacement assez défendable.'),
              rangeLine('Modéré', '40–59 : prudence, le signal peut décevoir.'),
              rangeLine('Élevé', '60–79 : risque de faux positif marqué.'),
              rangeLine('Très élevé', '80–100 : forte probabilité de déplacement peu rentable.')
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
