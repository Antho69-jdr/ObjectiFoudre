    function kmToDegLat(km) {
      return km / 111;
    }

    function kmToDegLon(km, lat) {
      return km / (111 * Math.cos((lat * Math.PI) / 180));
    }

    function deriveGridTemplate(cells) {
      if (!Array.isArray(cells) || !cells.length) return null;
      const latValues = [...new Set(cells.map(cell => Number(cell.lat).toFixed(6)))].sort((a, b) => Number(b) - Number(a));
      const lonValues = [...new Set(cells.map(cell => Number(cell.lon).toFixed(6)))].sort((a, b) => Number(a) - Number(b));
      const sample = cells[0] || {};
      const cellHeightDeg = Number(sample.cell_height_deg);
      const cellWidthDeg = Number(sample.cell_width_deg);
      return {
        rows: Math.max(1, latValues.length),
        cols: Math.max(1, lonValues.length),
        cellHeightDeg: Number.isFinite(cellHeightDeg) && cellHeightDeg > 0 ? cellHeightDeg : kmToDegLat(LOADER_CELL_SIZE_KM),
        cellWidthDeg: Number.isFinite(cellWidthDeg) && cellWidthDeg > 0 ? cellWidthDeg : kmToDegLon(LOADER_CELL_SIZE_KM, Number(sample.lat) || currentCenter.lat),
      };
    }

    function getLoaderTemplate(center) {
      const currentCells = getCurrentSlot()?.cells || [];
      const derived = deriveGridTemplate(currentCells);
      if (derived) {
        lastGridTemplate = derived;
        return {
          rows: LOADER_GRID_SIZE,
          cols: LOADER_GRID_SIZE,
          cellHeightDeg: derived.cellHeightDeg,
          cellWidthDeg: derived.cellWidthDeg,
        };
      }
      if (lastGridTemplate) {
        return {
          rows: LOADER_GRID_SIZE,
          cols: LOADER_GRID_SIZE,
          cellHeightDeg: Number.isFinite(lastGridTemplate.cellHeightDeg) && lastGridTemplate.cellHeightDeg > 0
            ? lastGridTemplate.cellHeightDeg
            : kmToDegLat(LOADER_CELL_SIZE_KM),
          cellWidthDeg: Number.isFinite(lastGridTemplate.cellWidthDeg) && lastGridTemplate.cellWidthDeg > 0
            ? lastGridTemplate.cellWidthDeg
            : kmToDegLon(LOADER_CELL_SIZE_KM, center.lat),
        };
      }
      const latStep = kmToDegLat(LOADER_CELL_SIZE_KM);
      return {
        rows: LOADER_GRID_SIZE,
        cols: LOADER_GRID_SIZE,
        cellHeightDeg: latStep,
        cellWidthDeg: kmToDegLon(LOADER_CELL_SIZE_KM, center.lat),
      };
    }

    function buildLoaderCells(center) {
      const cells = [];
      const template = getLoaderTemplate(center);
      const latStep = template.cellHeightDeg;
      const lonStep = template.cellWidthDeg;
      const rowOffset = (template.rows - 1) / 2;
      const colOffset = (template.cols - 1) / 2;
      let idx = 0;
      for (let row = 0; row < template.rows; row += 1) {
        for (let col = 0; col < template.cols; col += 1) {
          const rowFromCenter = rowOffset - row;
          const colFromCenter = col - colOffset;
          cells.push({
            zone: `loader-${idx++}`,
            lat: center.lat + rowFromCenter * latStep,
            lon: center.lon + colFromCenter * lonStep,
            cell_height_deg: latStep,
            cell_width_deg: lonStep,
            score_global: 18 + ((row + col) % 5) * 5,
            confidence_score: 42,
            chase_quality_score: 55,
            is_loader: true,
          });
        }
      }
      return cells;
    }

    function buildLoaderGeoJSON(cells, elapsedMs = 0) {
      if (!Array.isArray(cells) || !cells.length) {
        return { type: 'FeatureCollection', features: [] };
      }
      const centerLat = cells.reduce((sum, cell) => sum + Number(cell.lat || 0), 0) / cells.length;
      const centerLon = cells.reduce((sum, cell) => sum + Number(cell.lon || 0), 0) / cells.length;
      const distances = cells.map(cell => {
        const dLat = Number(cell.lat || 0) - centerLat;
        const dLon = Number(cell.lon || 0) - centerLon;
        return Math.hypot(dLat, dLon);
      });
      const maxDist = Math.max(...distances, 1e-9);
      const seconds = elapsedMs / 1000;
      const period = 2.85;
      const phase = (seconds / period) * Math.PI * 2;
      const waveWidth = 0.15;
      const features = cells.map((cell, idx) => {
        const dist = distances[idx] / maxDist;
        const wave = 0.5 + 0.5 * Math.sin((1 - dist) * Math.PI * 1.08 - phase);
        const crest = Math.pow(wave, 2.35);
        const secondary = Math.pow(0.5 + 0.5 * Math.sin((1 - dist) * Math.PI * 1.08 - phase - Math.PI * 0.62), 3.2);
        const envelope = 0.72 + 0.28 * Math.cos(dist * Math.PI * 0.92);
        const rimLift = Math.exp(-Math.pow((dist - 0.58) / waveWidth, 2)) * 0.018;
        const opacity = 0.03 + crest * 0.072 * envelope + secondary * 0.028 + rimLift;
        const feature = cellToFeature(cell, new Set(), { opacity, latOffset: 0, lonOffset: 0 });
        feature.properties.fill_opacity = opacity;
        feature.properties.loader_dist = dist;
        return feature;
      });
      return { type: 'FeatureCollection', features };
    }

