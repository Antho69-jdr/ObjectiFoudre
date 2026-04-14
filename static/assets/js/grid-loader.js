    function kmToDegLat(km) {
      return km / 111;
    }

    function kmToDegLon(km, lat) {
      return km / (111 * Math.cos((lat * Math.PI) / 180));
    }

    function deriveGridTemplate(cells) {
      if (!Array.isArray(cells) || !cells.length) return null;
      const rowsByLat = new Map();
      for (const cell of cells) {
        const key = Number(cell.lat).toFixed(6);
        if (!rowsByLat.has(key)) rowsByLat.set(key, []);
        rowsByLat.get(key).push(cell);
      }
      const sortedRows = [...rowsByLat.entries()].sort((a, b) => Number(b[0]) - Number(a[0]));
      const rowTemplates = sortedRows.map(([latKey, rowCells]) => {
        const sorted = [...rowCells].sort((a, b) => Number(a.lon) - Number(b.lon));
        return {
          lat: Number(latKey),
          cols: sorted.length,
          cellWidthDeg: Number(sorted[0]?.cell_width_deg) || kmToDegLon(LOADER_CELL_SIZE_KM, Number(latKey)),
        };
      });
      return {
        rows: rowTemplates.length,
        cols: Math.max(...rowTemplates.map(row => row.cols), LOADER_GRID_SIZE),
        cellHeightDeg: Number(cells[0]?.cell_height_deg) || kmToDegLat(LOADER_CELL_SIZE_KM),
        rowTemplates,
      };
    }

    function getLoaderTemplate(center) {
      const currentCells = getCurrentSlot()?.cells || [];
      const derived = deriveGridTemplate(currentCells);
      if (derived) {
        lastGridTemplate = derived;
        return derived;
      }
      if (lastGridTemplate) return lastGridTemplate;
      const rows = Math.max(3, Math.round(GRID_SIDE_KM / LOADER_CELL_SIZE_KM) | 1);
      const cols = rows;
      const cellHeightDeg = kmToDegLat(LOADER_CELL_SIZE_KM);
      const rowOffset = (rows - 1) / 2;
      const rowTemplates = [];
      for (let row = 0; row < rows; row += 1) {
        const rowFromCenter = rowOffset - row;
        const lat = center.lat + rowFromCenter * cellHeightDeg;
        rowTemplates.push({ lat, cols, cellWidthDeg: kmToDegLon(LOADER_CELL_SIZE_KM, lat) });
      }
      return { rows, cols, cellHeightDeg, rowTemplates };
    }

    function buildLoaderCells(center) {
      const cells = [];
      if (!center || !Number.isFinite(Number(center.lat)) || !Number.isFinite(Number(center.lon))) return cells;
      const template = getLoaderTemplate(center);
      const rowOffset = (template.rows - 1) / 2;
      let idx = 0;
      template.rowTemplates.forEach((rowTemplate, row) => {
        const rowFromCenter = rowOffset - row;
        const lat = Number.isFinite(rowTemplate.lat) ? rowTemplate.lat : center.lat + rowFromCenter * template.cellHeightDeg;
        const cellWidthDeg = Number(rowTemplate.cellWidthDeg) || kmToDegLon(LOADER_CELL_SIZE_KM, lat);
        const colOffset = (rowTemplate.cols - 1) / 2;
        for (let col = 0; col < rowTemplate.cols; col += 1) {
          const colFromCenter = col - colOffset;
          cells.push({
            zone: `loader-${idx++}`,
            lat,
            lon: center.lon + colFromCenter * cellWidthDeg,
            cell_height_deg: template.cellHeightDeg,
            cell_width_deg: cellWidthDeg,
            score_global: 18 + ((row + col) % 5) * 5,
            confidence_score: 42,
            chase_quality_score: 55,
            is_loader: true,
          });
        }
      });
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

