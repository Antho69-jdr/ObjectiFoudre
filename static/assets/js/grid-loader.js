    function kmToDegLat(km) {
      return km / 111;
    }

    function kmToDegLon(km, referenceLat) {
      const cosLat = Math.max(0.2, Math.cos((Number(referenceLat || 0) * Math.PI) / 180));
      return km / (111 * cosLat);
    }

    function deriveGridTemplate(cells) {
      if (!Array.isArray(cells) || !cells.length) return null;
      const cellHeightDeg = Number(cells[0]?.cell_height_deg) || kmToDegLat(LOADER_CELL_SIZE_KM);
      const meanLat = cells.reduce((sum, cell) => sum + Number(cell.lat || 0), 0) / cells.length;
      const cellWidthDeg = Number(cells[0]?.cell_width_deg) || kmToDegLon(LOADER_CELL_SIZE_KM, meanLat);
      return {
        rows: LOADER_GRID_SIZE,
        cols: LOADER_GRID_SIZE,
        cellHeightDeg,
        cellWidthDeg,
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
      const referenceLat = Number(center?.lat) || currentCenter.lat;
      return {
        rows: LOADER_GRID_SIZE,
        cols: LOADER_GRID_SIZE,
        cellHeightDeg: kmToDegLat(LOADER_CELL_SIZE_KM),
        cellWidthDeg: kmToDegLon(LOADER_CELL_SIZE_KM, referenceLat),
      };
    }

    function buildLoaderCells(center) {
      const cells = [];
      if (!center || !Number.isFinite(Number(center.lat)) || !Number.isFinite(Number(center.lon))) return cells;
      const template = getLoaderTemplate(center);
      const rowOffset = (template.rows - 1) / 2;
      const colOffset = (template.cols - 1) / 2;
      let idx = 0;
      for (let row = 0; row < template.rows; row += 1) {
        const lat = Number(center.lat) + (rowOffset - row) * template.cellHeightDeg;
        for (let col = 0; col < template.cols; col += 1) {
          const lon = Number(center.lon) + (col - colOffset) * template.cellWidthDeg;
          cells.push({
            zone: `loader-${idx++}`,
            lat,
            lon,
            cell_height_deg: template.cellHeightDeg,
            cell_width_deg: template.cellWidthDeg,
            trigger_score: 18 + ((row + col) % 5) * 5,
            confidence_score: 42,
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
      const distances = cells.map((cell) => Math.hypot(Number(cell.lat || 0) - centerLat, Number(cell.lon || 0) - centerLon));
      const maxDist = Math.max(...distances, 1e-9);
      const phase = ((elapsedMs / 1000) / 2.8) * Math.PI * 2;
      const features = cells.map((cell, idx) => {
        const dist = distances[idx] / maxDist;
        const wave = 0.5 + 0.5 * Math.sin((1 - dist) * Math.PI * 1.1 - phase);
        const opacity = 0.035 + Math.pow(wave, 2.2) * 0.08;
        const feature = cellToFeature(cell, new Set(), { opacity, latOffset: 0, lonOffset: 0 });
        feature.properties.fill_opacity = opacity;
        return feature;
      });
      return { type: 'FeatureCollection', features };
    }
