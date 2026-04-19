function openMetricInfo(metricKey, currentValue) {
      const meta = METRIC_INFO[metricKey];
      if (!meta) return;
      const featureValue = selectedFeature && Object.prototype.hasOwnProperty.call(selectedFeature, metricKey)
        ? selectedFeature[metricKey]
        : currentValue;
      const displayValue = featureValue === undefined || featureValue === null || featureValue === '' ? (currentValue || '—') : featureValue;
      const op = operationalGuide(metricKey, featureValue);
      infoMetricLabel.textContent = `${meta.label} · ${op.state}`;
      infoMetricValue.textContent = displayValue || '—';
      infoExplanation.innerHTML = `
        <div class="metric-info-explain">${meta.explain}</div>
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

