    function openMetricInfo(metricKey, currentValue) {
      const meta = METRIC_INFO[metricKey];
      if (!meta) return;
      const op = operationalGuide(metricKey, currentValue);
      infoMetricLabel.textContent = `${meta.label} · ${op.state}`;
      infoMetricValue.textContent = currentValue || '—';
      infoExplanation.innerHTML = `<div>${meta.explain}</div><div style="margin-top:10px;"><strong>Lecture terrain</strong></div><div style="margin-top:6px; display:grid; gap:6px;">${op.guide}</div>`;
      infoBackdrop.classList.add('visible');
      infoModal.classList.add('visible');
    }

    function closeMetricInfo() {
      infoBackdrop.classList.remove('visible');
      infoModal.classList.remove('visible');
    }

