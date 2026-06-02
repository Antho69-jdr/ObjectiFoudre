function metricTone(metricKey, rawValue) {
      const value = Number(rawValue);
      if (!Number.isFinite(value)) return 'neutral';
      switch (metricKey) {
        case 'trigger_score':
        case 'confidence_score':
          return value >= 60 ? 'positive' : value <= 35 ? 'negative' : 'neutral';
        case 'mucape':
          return value >= 800 ? 'positive' : value < 300 ? 'negative' : 'neutral';
        case 'precipitation_rate':
          return value >= 0.3 ? 'positive' : value < 0.05 ? 'negative' : 'neutral';
        case 'relative_humidity_2m':
          return value >= 65 ? 'positive' : value < 45 ? 'negative' : 'neutral';
        case 'precipitable_water':
          return value >= 30 ? 'positive' : value < 18 ? 'negative' : 'neutral';
        case 'shortwave_radiation':
          return value >= 400 ? 'positive' : value < 120 ? 'negative' : 'neutral';
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
        case 'surface_convergence_1e4s':
          return value >= 0.5 ? 'positive' : value < -0.5 ? 'negative' : 'neutral';
        case 'wind_speed_10m':
        case 'wind_direction_10m':
        case 'cloud_cover_low':
        case 'cloud_cover_mid':
        case 'cloud_cover_high':
          return 'neutral';
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
