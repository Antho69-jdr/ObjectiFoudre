// controls-export.js — issu du découpage de controls.js (Phase 3).
// Export d'animation GIF/MP4 (palette, rendu canvas France, encodage). Script classique.
    function parseRgbColor(value) {
      const match = String(value || '').match(/rgba?\(([^)]+)\)/i);
      if (!match) return null;
      const parts = match[1].split(',').map(part => Number(part.trim()));
      if (parts.length < 3 || parts.slice(0, 3).some(part => !Number.isFinite(part))) return null;
      return parts.slice(0, 3).map(part => Math.max(0, Math.min(255, Math.round(part))));
    }

    function collectMapPaletteColors(mapBackground, maxColors = 132) {
      if (!mapBackground?.canvas) return [];
      try {
        const sampleCanvas = mapBackground.canvas;
        const sampleCtx = sampleCanvas.getContext('2d', { willReadFrequently: true });
        const imageData = sampleCtx.getImageData(0, 0, sampleCanvas.width, sampleCanvas.height);
        const counts = new Map();
        const step = Math.max(8, Math.floor(Math.sqrt((sampleCanvas.width * sampleCanvas.height) / 4500)));
        for (let y = 0; y < sampleCanvas.height; y += step) {
          for (let x = 0; x < sampleCanvas.width; x += step) {
            const offset = ((y * sampleCanvas.width) + x) * 4;
            if (imageData.data[offset + 3] < 8) continue;
            const r = Math.round(imageData.data[offset] / 12) * 12;
            const g = Math.round(imageData.data[offset + 1] / 12) * 12;
            const b = Math.round(imageData.data[offset + 2] / 12) * 12;
            const key = `${Math.max(0, Math.min(255, r))},${Math.max(0, Math.min(255, g))},${Math.max(0, Math.min(255, b))}`;
            counts.set(key, (counts.get(key) || 0) + 1);
          }
        }
        return [...counts.entries()]
          .sort((a, b) => b[1] - a[1])
          .slice(0, maxColors)
          .map(([key]) => key.split(',').map(Number));
      } catch (_) {
        return [];
      }
    }

    const GIF_SCORE_SOFT_MIX_RGB = Object.freeze([18, 34, 52]);

    function gifBlendRgb(source, target, targetAmount) {
      const amount = Math.max(0, Math.min(1, Number(targetAmount) || 0));
      return source.map((value, index) => Math.round((value * (1 - amount)) + (target[index] * amount)));
    }

    function gifScoreColor(score) {
      // Rampe « radar/chaleur » (comme la carte Historique live + Prévision).
      const ramp = (typeof colorFromStormForecast === 'function') ? colorFromStormForecast : colorFromScore;
      const rgb = parseRgbColor(ramp(score));
      if (!rgb) return ramp(score);
      const softened = gifBlendRgb(rgb, GIF_SCORE_SOFT_MIX_RGB, 0.18);
      return `rgb(${softened[0]}, ${softened[1]}, ${softened[2]})`;
    }

    function buildGifPalette(mapBackground = null) {
      const rawColors = [
        [9, 18, 31],
        [12, 20, 33],
        [15, 23, 42],
        [18, 28, 45],
        [10, 20, 34],
        [16, 35, 54],
        [21, 48, 73],
        [30, 41, 59],
        [51, 65, 85],
        [71, 85, 105],
        [100, 116, 139],
        [148, 163, 184],
        [203, 213, 225],
        [226, 232, 240],
        [248, 250, 252],
        [255, 255, 255],
      ];
      for (let grey = 0; grey <= 255; grey += 14) {
        rawColors.push([grey, grey, grey]);
      }
      rawColors.push(...collectMapPaletteColors(mapBackground));
      for (let score = 0; score <= 100; score += 1) {
        const baseColor = parseRgbColor((typeof colorFromStormForecast === 'function' ? colorFromStormForecast : colorFromScore)(score));
        const exportColor = parseRgbColor(gifScoreColor(score));
        if (baseColor) rawColors.push(baseColor);
        if (exportColor) rawColors.push(exportColor);
      }
      const seen = new Set();
      const colors = [];
      for (const color of rawColors) {
        const key = color.join(',');
        if (seen.has(key)) continue;
        seen.add(key);
        colors.push(color);
      }
      const activeCount = colors.length;
      while (colors.length < 256) colors.push([0, 0, 0]);
      return { colors: colors.slice(0, 256), activeCount: Math.min(activeCount, 256) };
    }

    function quantizeImageDataToPalette(imageData, paletteInfo) {
      const data = imageData.data;
      const palette = paletteInfo.colors;
      const activeCount = Math.max(1, paletteInfo.activeCount || palette.length);
      const indexes = new Uint8Array(imageData.width * imageData.height);
      const cache = new Map();
      for (let i = 0, pixel = 0; i < data.length; i += 4, pixel += 1) {
        const alpha = data[i + 3];
        if (alpha < 8) {
          indexes[pixel] = 0;
          continue;
        }
        const r = data[i];
        const g = data[i + 1];
        const b = data[i + 2];
        const key = (r << 16) | (g << 8) | b;
        const cached = cache.get(key);
        if (cached !== undefined) {
          indexes[pixel] = cached;
          continue;
        }
        let bestIndex = 0;
        let bestDistance = Infinity;
        for (let p = 0; p < activeCount; p += 1) {
          const color = palette[p];
          const dr = r - color[0];
          const dg = g - color[1];
          const db = b - color[2];
          const distance = (dr * dr) + (dg * dg) + (db * db);
          if (distance < bestDistance) {
            bestDistance = distance;
            bestIndex = p;
            if (distance === 0) break;
          }
        }
        cache.set(key, bestIndex);
        indexes[pixel] = bestIndex;
      }
      return indexes;
    }

    function encodeGifLzwIndexedPixels(indexes) {
      const minCodeSize = 8;
      const clearCode = 1 << minCodeSize;
      const endCode = clearCode + 1;
      const codeSize = minCodeSize + 1;
      const chunkPixelCount = 240;
      const bytes = [];
      let bitBuffer = 0;
      let bitCount = 0;

      const writeCode = (code) => {
        bitBuffer |= code << bitCount;
        bitCount += codeSize;
        while (bitCount >= 8) {
          bytes.push(bitBuffer & 255);
          bitBuffer >>= 8;
          bitCount -= 8;
        }
      };

      // Use short clear-code chunks instead of a growing dictionary. The GIF is
      // larger, but it avoids decoder drift on dense, anti-aliased canvas frames.
      for (let offset = 0; offset < indexes.length; offset += chunkPixelCount) {
        writeCode(clearCode);
        const end = Math.min(indexes.length, offset + chunkPixelCount);
        for (let i = offset; i < end; i += 1) {
          writeCode(indexes[i] || 0);
        }
      }
      writeCode(endCode);
      if (bitCount > 0) bytes.push(bitBuffer & 255);
      return bytes;
    }

    function createGifBlob(width, height, frames, paletteInfo, delayCs) {
      const bytes = [];
      const writeByte = (value) => bytes.push(value & 255);
      const writeWord = (value) => {
        writeByte(value);
        writeByte(value >> 8);
      };
      const writeAscii = (text) => {
        for (let i = 0; i < text.length; i += 1) writeByte(text.charCodeAt(i));
      };
      const writeSubBlocks = (data) => {
        for (let i = 0; i < data.length; i += 255) {
          const size = Math.min(255, data.length - i);
          writeByte(size);
          for (let j = 0; j < size; j += 1) writeByte(data[i + j]);
        }
        writeByte(0);
      };

      writeAscii('GIF89a');
      writeWord(width);
      writeWord(height);
      writeByte(0xf7);
      writeByte(0);
      writeByte(0);
      for (const color of paletteInfo.colors) {
        writeByte(color[0]);
        writeByte(color[1]);
        writeByte(color[2]);
      }
      writeByte(0x21);
      writeByte(0xff);
      writeByte(0x0b);
      writeAscii('NETSCAPE2.0');
      writeByte(0x03);
      writeByte(0x01);
      writeWord(0);
      writeByte(0);

      for (const frame of frames) {
        writeByte(0x21);
        writeByte(0xf9);
        writeByte(0x04);
        writeByte(0x08);
        writeWord(delayCs);
        writeByte(0);
        writeByte(0);
        writeByte(0x2c);
        writeWord(0);
        writeWord(0);
        writeWord(width);
        writeWord(height);
        writeByte(0);
        writeByte(8);
        writeSubBlocks(encodeGifLzwIndexedPixels(frame));
      }
      writeByte(0x3b);
      return new Blob([new Uint8Array(bytes)], { type: 'image/gif' });
    }

    function drawFittedText(ctx, text, x, y, maxWidth) {
      const source = String(text || '');
      if (ctx.measureText(source).width <= maxWidth) {
        ctx.fillText(source, x, y);
        return;
      }
      let trimmed = source;
      while (trimmed.length > 1 && ctx.measureText(`${trimmed}…`).width > maxWidth) {
        trimmed = trimmed.slice(0, -1);
      }
      ctx.fillText(`${trimmed}…`, x, y);
    }

    const GIF_FRANCE_EXTENT = Object.freeze({
      west: -5.55,
      east: 9.75,
      south: 41.05,
      north: 51.45,
    });

    const GIF_CITY_LABELS = Object.freeze([
      { label: 'Paris', lon: 2.35, lat: 48.86, anchor: 'left' },
      { label: 'Lille', lon: 3.06, lat: 50.63, anchor: 'left' },
      { label: 'Rouen', lon: 1.1, lat: 49.44, anchor: 'right' },
      { label: 'Rennes', lon: -1.68, lat: 48.11, anchor: 'left' },
      { label: 'Brest', lon: -4.49, lat: 48.39, anchor: 'left' },
      { label: 'Nantes', lon: -1.55, lat: 47.22, anchor: 'left' },
      { label: 'Bordeaux', lon: -0.58, lat: 44.84, anchor: 'left' },
      { label: 'Toulouse', lon: 1.44, lat: 43.6, anchor: 'left' },
      { label: 'Montpellier', lon: 3.88, lat: 43.61, anchor: 'left' },
      { label: 'Marseille', lon: 5.37, lat: 43.3, anchor: 'left' },
      { label: 'Nice', lon: 7.26, lat: 43.7, anchor: 'left' },
      { label: 'Lyon', lon: 4.84, lat: 45.76, anchor: 'left' },
      { label: 'Grenoble', lon: 5.72, lat: 45.19, anchor: 'left' },
      { label: 'Clermont-Ferrand', lon: 3.09, lat: 45.78, anchor: 'right' },
      { label: 'Dijon', lon: 5.04, lat: 47.32, anchor: 'left' },
      { label: 'Strasbourg', lon: 7.75, lat: 48.58, anchor: 'left' },
      { label: 'Nancy', lon: 6.18, lat: 48.69, anchor: 'left' },
      { label: 'Reims', lon: 4.03, lat: 49.26, anchor: 'left' },
      { label: 'Orleans', lon: 1.9, lat: 47.9, anchor: 'left' },
      { label: 'Tours', lon: 0.69, lat: 47.39, anchor: 'left' },
      { label: 'Limoges', lon: 1.26, lat: 45.83, anchor: 'left' },
      { label: 'Ajaccio', lon: 8.74, lat: 41.92, anchor: 'right' },
      { label: 'Bastia', lon: 9.45, lat: 42.7, anchor: 'left' },
    ]);

    function getGifDepartmentRings() {
      return (typeof FRANCE_DEPARTMENT_RINGS !== 'undefined' && Array.isArray(FRANCE_DEPARTMENT_RINGS))
        ? FRANCE_DEPARTMENT_RINGS
        : [];
    }

    function getGifClipRings() {
      if (typeof FRANCE_GRID_CLIP_RINGS !== 'undefined' && Array.isArray(FRANCE_GRID_CLIP_RINGS)) return FRANCE_GRID_CLIP_RINGS;
      return getGifDepartmentRings();
    }

    function buildGifFranceProjection(mapRect) {
      const extent = GIF_FRANCE_EXTENT;
      const midLat = (extent.north + extent.south) / 2;
      const lonFactor = Math.cos((midLat * Math.PI) / 180);
      const projectedWidth = Math.max(0.0001, (extent.east - extent.west) * lonFactor);
      const projectedHeight = Math.max(0.0001, extent.north - extent.south);
      const scale = Math.min(mapRect.width / projectedWidth, mapRect.height / projectedHeight);
      const drawWidth = projectedWidth * scale;
      const drawHeight = projectedHeight * scale;
      const left = mapRect.left + ((mapRect.width - drawWidth) / 2);
      const top = mapRect.top + ((mapRect.height - drawHeight) / 2);
      return {
        left,
        top,
        width: drawWidth,
        height: drawHeight,
        scale,
        lonFactor,
        extent,
        project(lon, lat) {
          return {
            x: left + ((Number(lon) - extent.west) * lonFactor * scale),
            y: top + ((extent.north - Number(lat)) * scale),
          };
        },
      };
    }

    function addGifRingsPath(ctx, rings, projection) {
      let count = 0;
      ctx.beginPath();
      for (const ring of rings || []) {
        if (!Array.isArray(ring) || ring.length < 3) continue;
        let moved = false;
        for (const point of ring) {
          const lon = Number(point?.[0]);
          const lat = Number(point?.[1]);
          if (!Number.isFinite(lon) || !Number.isFinite(lat)) continue;
          const projected = projection.project(lon, lat);
          if (!moved) {
            ctx.moveTo(projected.x, projected.y);
            moved = true;
          } else {
            ctx.lineTo(projected.x, projected.y);
          }
        }
        if (moved) {
          ctx.closePath();
          count += 1;
        }
      }
      return count;
    }

    function drawGifFranceBase(ctx, projection, mapRect) {
      const departmentRings = getGifDepartmentRings();
      ctx.save();
      ctx.fillStyle = '#071321';
      ctx.fillRect(mapRect.left, mapRect.top, mapRect.width, mapRect.height);
      if (departmentRings.length && addGifRingsPath(ctx, departmentRings, projection)) {
        ctx.fillStyle = '#10243a';
        ctx.fill();
      } else {
        ctx.fillStyle = '#10243a';
        ctx.fillRect(projection.left, projection.top, projection.width, projection.height);
      }
      ctx.restore();
    }

    function clipGifToFrance(ctx, projection) {
      const clipRings = getGifClipRings();
      if (!clipRings.length || !addGifRingsPath(ctx, clipRings, projection)) return false;
      ctx.clip();
      return true;
    }

    function getGifRegionRings() {
      return (typeof franceRegionRings === 'function') ? franceRegionRings() : [];
    }

    function drawGifAdminLines(ctx, projection) {
      const departmentRings = getGifDepartmentRings();
      const regionRings = getGifRegionRings();
      const clipRings = getGifClipRings();
      ctx.save();
      // départements (discrets, dessous)
      if (departmentRings.length && addGifRingsPath(ctx, departmentRings, projection)) {
        ctx.strokeStyle = 'rgba(200, 214, 232, 0.34)';
        ctx.lineWidth = Math.max(0.6, ctx.canvas.width / 1320);
        ctx.stroke();
      }
      // régions (nettes, dessus)
      if (regionRings.length && addGifRingsPath(ctx, regionRings, projection)) {
        ctx.strokeStyle = 'rgba(214, 228, 246, 0.7)';
        ctx.lineWidth = Math.max(1.0, ctx.canvas.width / 760);
        ctx.stroke();
      }
      if (clipRings.length && addGifRingsPath(ctx, clipRings, projection)) {
        ctx.strokeStyle = 'rgba(248, 250, 252, 0.82)';
        ctx.lineWidth = Math.max(1.4, ctx.canvas.width / 520);
        ctx.stroke();
      }
      ctx.restore();
    }

    function fitGifLabelText(ctx, text, maxWidth) {
      const source = String(text || '');
      if (!maxWidth || ctx.measureText(source).width <= maxWidth) return source;
      let trimmed = source;
      while (trimmed.length > 1 && ctx.measureText(`${trimmed}...`).width > maxWidth) trimmed = trimmed.slice(0, -1);
      return `${trimmed}...`;
    }

    function drawGifHaloText(ctx, text, x, y, maxWidth, options = {}) {
      const label = fitGifLabelText(ctx, text, maxWidth);
      ctx.save();
      ctx.textAlign = options.align || 'center';
      ctx.textBaseline = options.baseline || 'middle';
      ctx.lineJoin = 'round';
      ctx.lineWidth = options.strokeWidth || 4;
      ctx.strokeStyle = options.stroke || 'rgba(3, 7, 18, 0.92)';
      ctx.fillStyle = options.fill || '#f8fafc';
      ctx.strokeText(label, x, y);
      ctx.fillText(label, x, y);
      ctx.restore();
    }

    function gifBoxesOverlap(a, b, padding = 3) {
      return !(a.right + padding < b.left || a.left - padding > b.right || a.bottom + padding < b.top || a.top - padding > b.bottom);
    }

    function gifCityLabelBox(ctx, text, point, align, fontSize) {
      const offset = align === 'right' ? -8 : 8;
      const labelWidth = ctx.measureText(text).width;
      const x = point.x + offset;
      const y = point.y - 5;
      const left = align === 'right' ? x - labelWidth : x;
      const right = align === 'right' ? x : x + labelWidth;
      const halfHeight = fontSize * 0.62;
      return {
        left: left - 5,
        right: right + 5,
        top: y - halfHeight - 4,
        bottom: y + halfHeight + 4,
        x,
        y,
      };
    }

    function drawGifLabels(ctx, projection) {
      const cityFont = Math.max(12, Math.round(ctx.canvas.width / 82));
      const occupied = [];
      ctx.save();
      ctx.font = `750 ${cityFont}px system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif`;
      for (const item of GIF_CITY_LABELS) {
        const point = projection.project(item.lon, item.lat);
        const align = item.anchor === 'right' ? 'right' : 'left';
        const label = fitGifLabelText(ctx, item.label, ctx.canvas.width * 0.16);
        const box = gifCityLabelBox(ctx, label, point, align, cityFont);
        if (occupied.some(existing => gifBoxesOverlap(existing, box, 5))) continue;
        occupied.push(box);
        ctx.beginPath();
        ctx.fillStyle = '#f8fafc';
        ctx.strokeStyle = 'rgba(3, 7, 18, 0.95)';
        ctx.lineWidth = 3;
        ctx.arc(point.x, point.y, Math.max(2.4, ctx.canvas.width / 360), 0, Math.PI * 2);
        ctx.stroke();
        ctx.fill();
        drawGifHaloText(ctx, label, box.x, box.y, ctx.canvas.width * 0.16, {
          align,
          fill: '#f8fafc',
          stroke: 'rgba(3, 7, 18, 0.96)',
          strokeWidth: 4,
        });
      }
      ctx.restore();
    }

    function drawGifFranceGridCells(ctx, cells, projection) {
      const orderedCells = sortCellsForReveal(cells || []);
      ctx.save();
      clipGifToFrance(ctx, projection);
      for (const cell of orderedCells) {
        const lat = Number(cell?.lat);
        const lon = Number(cell?.lon);
        const cellHeightDeg = Number(cell?.cell_height_deg);
        const cellWidthDeg = Number(cell?.cell_width_deg);
        if (!Number.isFinite(lat) || !Number.isFinite(lon) || !Number.isFinite(cellHeightDeg) || !Number.isFinite(cellWidthDeg)) continue;
        const halfH = cellHeightDeg / 2;
        const halfW = cellWidthDeg / 2;
        const nw = projection.project(lon - halfW, lat + halfH);
        const se = projection.project(lon + halfW, lat - halfH);
        const x = Math.min(nw.x, se.x);
        const y = Math.min(nw.y, se.y);
        const w = Math.abs(se.x - nw.x);
        const h = Math.abs(se.y - nw.y);
        if (w <= 0 || h <= 0) continue;
        const score = Number(cell?.trigger_score ?? 0) || 0;
        // Arrondi VERS L'EXTÉRIEUR (floor/ceil) : les cellules se chevauchent d'au
        // plus 1px, ce qui supprime les coutures noires entre rangées dues au pas
        // de latitude non uniforme (0.1351 vs 0.1352°).
        const rectX = Math.floor(x);
        const rectY = Math.floor(y);
        const rectW = Math.max(1, Math.ceil(x + w) - rectX);
        const rectH = Math.max(1, Math.ceil(y + h) - rectY);
        ctx.globalAlpha = 1;
        ctx.fillStyle = gifScoreColor(score);
        ctx.fillRect(rectX, rectY, rectW, rectH);
      }
      ctx.restore();
      ctx.globalAlpha = 1;
    }

    function drawGifRoundRectPath(ctx, x, y, width, height, radius) {
      const r = Math.max(0, Math.min(radius, width / 2, height / 2));
      ctx.beginPath();
      ctx.moveTo(x + r, y);
      ctx.lineTo(x + width - r, y);
      ctx.quadraticCurveTo(x + width, y, x + width, y + r);
      ctx.lineTo(x + width, y + height - r);
      ctx.quadraticCurveTo(x + width, y + height, x + width - r, y + height);
      ctx.lineTo(x + r, y + height);
      ctx.quadraticCurveTo(x, y + height, x, y + height - r);
      ctx.lineTo(x, y + r);
      ctx.quadraticCurveTo(x, y, x + r, y);
      ctx.closePath();
    }

    function gifSlotHour(slot, fallbackIndex = 0) {
      const directHour = Number(slot?.hour ?? slot?.slot_hour ?? slot?.forecast_hour);
      if (Number.isFinite(directHour)) return Math.max(0, Math.min(23, Math.trunc(directHour)));
      const raw = String(slot?.slot_label || slot?.slot_key || '');
      const match = raw.match(/(\d{1,2})\s*h/i) || raw.match(/h(\d{1,2})/i) || raw.match(/(\d{1,2})/);
      if (match) {
        const parsed = Number(match[1]);
        if (Number.isFinite(parsed)) return Math.max(0, Math.min(23, Math.trunc(parsed)));
      }
      return Math.max(0, Math.min(23, Math.trunc(fallbackIndex)));
    }

    function gifLegendTextColor(score) {
      const rgb = parseRgbColor(gifScoreColor(score));
      if (!rgb) return '#f8fafc';
      const luminance = (0.299 * rgb[0]) + (0.587 * rgb[1]) + (0.114 * rgb[2]);
      return luminance > 142 ? '#07111f' : '#f8fafc';
    }

    function drawGifTimelineFooter(ctx, slot, frameIndex, frameCount, footerRect, slots = null) {
      const scale = ctx.canvas.width / 1080;
      const activeHour = gifSlotHour(slot, frameIndex);
      const panelX = footerRect.left;
      const panelY = footerRect.top + 10;
      const panelW = footerRect.width;
      const panelH = footerRect.height - 18;
      const railPadX = Math.round(56 * scale);
      const trackLeft = panelX + railPadX;
      const trackRight = panelX + panelW - railPadX;
      const trackTop = panelY + Math.round(20 * scale);
      const trackH = Math.max(30, Math.round(34 * scale));
      const trackRadius = Math.round(10 * scale);
      const trackY = trackTop + (trackH / 2);
      const count = Math.max(1, Number(frameCount) || 1);
      const denom = Math.max(1, count - 1);
      const activeIndex = Math.max(0, Math.min(count - 1, frameIndex));
      const activeX = trackLeft + ((trackRight - trackLeft) * (activeIndex / denom));

      ctx.save();
      drawGifRoundRectPath(ctx, panelX, panelY, panelW, panelH, 20 * scale);
      const panelGradient = ctx.createLinearGradient(0, panelY, 0, panelY + panelH);
      panelGradient.addColorStop(0, 'rgba(15, 23, 42, 0.98)');
      panelGradient.addColorStop(1, 'rgba(8, 17, 30, 0.96)');
      ctx.fillStyle = panelGradient;
      ctx.fill();
      ctx.strokeStyle = 'rgba(125, 211, 252, 0.22)';
      ctx.lineWidth = Math.max(1, 1.3 * scale);
      ctx.stroke();

      drawGifRoundRectPath(ctx, trackLeft, trackTop, trackRight - trackLeft, trackH, trackRadius);
      const trackGradient = ctx.createLinearGradient(0, trackTop, 0, trackTop + trackH);
      trackGradient.addColorStop(0, 'rgba(15, 23, 42, 0.95)');
      trackGradient.addColorStop(1, 'rgba(15, 23, 42, 0.82)');
      ctx.fillStyle = trackGradient;
      ctx.fill();
      ctx.save();
      drawGifRoundRectPath(ctx, trackLeft, trackTop, trackRight - trackLeft, trackH, trackRadius);
      ctx.clip();
      const railTint = ctx.createLinearGradient(trackLeft, 0, trackRight, 0);
      railTint.addColorStop(0, 'rgba(34, 211, 238, 0.045)');
      railTint.addColorStop(1, 'rgba(45, 212, 191, 0.060)');
      ctx.fillStyle = railTint;
      ctx.fillRect(trackLeft, trackTop, trackRight - trackLeft, trackH);
      ctx.restore();
      ctx.strokeStyle = 'rgba(226, 232, 240, 0.18)';
      ctx.lineWidth = Math.max(1, 1 * scale);
      ctx.stroke();

      if (activeX > trackLeft) {
        ctx.save();
        drawGifRoundRectPath(ctx, trackLeft, trackTop, Math.max(1, activeX - trackLeft), trackH, trackRadius);
        ctx.clip();
        const fillGradient = ctx.createLinearGradient(trackLeft, 0, activeX, 0);
        fillGradient.addColorStop(0, 'rgba(34, 211, 238, 0.22)');
        fillGradient.addColorStop(1, 'rgba(45, 212, 191, 0.36)');
        ctx.fillStyle = fillGradient;
        ctx.fillRect(trackLeft, trackTop, activeX - trackLeft, trackH);
        ctx.restore();
      }

      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      for (let i = 0; i < count; i += 1) {
        const x = trackLeft + ((trackRight - trackLeft) * (i / denom));
        const hour = gifSlotHour(Array.isArray(slots) ? slots[i] : null, i);
        const isActive = i === activeIndex;
        const isEven = i % 2 === 1;
        const lineTop = trackTop + Math.round((isActive ? 4 : (isEven ? 7 : 5)) * scale);
        const lineHeight = Math.round((isActive ? 26 : (isEven ? 20 : 24)) * scale);
        ctx.strokeStyle = isActive ? 'rgba(255, 255, 255, 0.70)' : (isEven ? 'rgba(148, 163, 184, 0.27)' : 'rgba(226, 232, 240, 0.36)');
        ctx.lineWidth = isActive ? Math.max(1.5, 2 * scale) : Math.max(1, 1 * scale);
        ctx.beginPath();
        ctx.moveTo(x, lineTop);
        ctx.lineTo(x, lineTop + lineHeight);
        ctx.stroke();
        if (!isActive) {
          ctx.font = `850 ${Math.max(9, Math.round(10.2 * scale))}px system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif`;
          ctx.fillStyle = 'rgba(226, 238, 252, 0.66)';
          ctx.fillText(String(hour).padStart(2, '0'), x, trackY + (0.5 * scale));
        }
      }

      const cursorR = Math.round(12 * scale);
      ctx.save();
      ctx.shadowColor = 'rgba(34, 211, 238, 0.36)';
      ctx.shadowBlur = Math.round(16 * scale);
      ctx.beginPath();
      ctx.arc(activeX, trackY, cursorR, 0, Math.PI * 2);
      ctx.strokeStyle = 'rgba(103, 232, 249, 0.98)';
      ctx.lineWidth = Math.max(2, 2 * scale);
      ctx.stroke();
      ctx.restore();

      const activeSize = Math.round(24 * scale);
      drawGifRoundRectPath(ctx, activeX - (activeSize / 2), trackY - (activeSize / 2), activeSize, activeSize, activeSize / 2);
      ctx.fillStyle = 'rgba(8, 17, 30, 0.74)';
      ctx.fill();
      ctx.strokeStyle = 'rgba(103, 232, 249, 0.40)';
      ctx.lineWidth = Math.max(1, 1 * scale);
      ctx.stroke();
      ctx.font = `950 ${Math.max(10, Math.round(11.2 * scale))}px system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif`;
      ctx.fillStyle = '#f8fafc';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(String(activeHour).padStart(2, '0'), activeX, trackY + (0.4 * scale));

      const scores = [0, 20, 40, 60, 80, 100];
      const gap = Math.max(8, Math.round(ctx.canvas.width / 125));
      const legendX = trackLeft;
      const legendW = trackRight - trackLeft;
      const legendTitleY = trackTop + trackH + Math.round(30 * scale);
      const legendH = Math.max(28, Math.round(30 * scale));
      const legendY = legendTitleY + Math.round(17 * scale);
      const boxW = (legendW - (gap * (scores.length - 1))) / scores.length;
      ctx.font = `900 ${Math.max(11, Math.round(12 * scale))}px system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif`;
      ctx.textBaseline = 'alphabetic';
      ctx.textAlign = 'left';
      ctx.fillStyle = 'rgba(226, 238, 252, 0.90)';
      ctx.fillText('Probabilité orageuse', legendX, legendTitleY);
      ctx.textAlign = 'right';
      ctx.fillStyle = 'rgba(148, 163, 184, 0.88)';
      ctx.fillText('score 0-100', legendX + legendW, legendTitleY);

      ctx.font = `900 ${Math.max(12, Math.round(13 * scale))}px system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif`;
      ctx.textBaseline = 'middle';
      for (let i = 0; i < scores.length; i += 1) {
        const score = scores[i];
        const x = legendX + (i * (boxW + gap));
        drawGifRoundRectPath(ctx, x, legendY, boxW, legendH, Math.round(7 * scale));
        ctx.fillStyle = gifScoreColor(score);
        ctx.fill();
        ctx.strokeStyle = 'rgba(248, 250, 252, 0.44)';
        ctx.lineWidth = Math.max(1, 1 * scale);
        ctx.stroke();
        ctx.fillStyle = gifLegendTextColor(score);
        ctx.textAlign = 'center';
        ctx.fillText(String(score), x + (boxW / 2), legendY + (legendH / 2) + 0.5);
      }
      ctx.restore();
    }

    function drawGridAnimationFrame(ctx, slot, day, frameIndex, frameCount, slots = null, options = null) {
      const width = ctx.canvas.width;
      const height = ctx.canvas.height;
      const showLabels = !options || options.labels !== false;
      const showFooter = !options || options.footer !== false;
      const showTitle = !options || options.title !== false;
      const cells = Array.isArray(slot?.cells) ? slot.cells : [];
      const top = Math.round(height * (showTitle ? 0.082 : 0.02));
      const bottom = Math.round(height * (showFooter ? 0.17 : 0.03));
      const side = Math.round(width * 0.03);
      const mapRect = {
        left: side,
        top,
        width: width - (side * 2),
        height: height - top - bottom,
      };
      const footerRect = {
        left: side,
        top: height - bottom,
        width: width - (side * 2),
        height: bottom,
      };
      const projection = buildGifFranceProjection(mapRect);
      const dayLabel = day?.day_label || day?.day_key || selectedBaseDate;
      const title = `France métropolitaine · ${dayLabel}`;

      ctx.clearRect(0, 0, width, height);
      ctx.globalAlpha = 1;
      ctx.fillStyle = '#050b14';
      ctx.fillRect(0, 0, width, height);
      if (showTitle) {
        ctx.fillStyle = '#0b1220';
        ctx.fillRect(0, 0, width, top - 10);
      }
      if (showFooter) {
        ctx.fillStyle = '#0b1220';
        ctx.fillRect(0, height - bottom + 4, width, bottom - 4);
      }

      drawGifFranceBase(ctx, projection, mapRect);
      drawGifFranceGridCells(ctx, cells, projection);
      drawGifAdminLines(ctx, projection);
      if (showLabels) drawGifLabels(ctx, projection);

      ctx.save();
      ctx.strokeStyle = 'rgba(148, 163, 184, 0.3)';
      ctx.lineWidth = 1;
      ctx.strokeRect(Math.round(mapRect.left) + 0.5, Math.round(mapRect.top) + 0.5, Math.round(mapRect.width), Math.round(mapRect.height));
      ctx.restore();

      if (showTitle) {
        ctx.textBaseline = 'alphabetic';
        ctx.textAlign = 'left';
        ctx.fillStyle = '#f8fafc';
        ctx.font = `800 ${Math.max(24, Math.round(width / 38))}px system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif`;
        drawFittedText(ctx, 'ObjectiFoudre', side, Math.round(top * 0.4), width * 0.32);
        ctx.font = `650 ${Math.max(15, Math.round(width / 66))}px system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif`;
        ctx.fillStyle = '#cbd5e1';
        drawFittedText(ctx, title, side, Math.round(top * 0.72), width * 0.58);
      }

      if (showFooter) drawGifTimelineFooter(ctx, slot, frameIndex, frameCount, footerRect, slots);
    }

    function sanitizeGifFilenamePart(value) {
      return String(value || 'zone')
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .replace(/[^a-z0-9]+/gi, '-')
        .replace(/^-+|-+$/g, '')
        .toLowerCase() || 'zone';
    }

    function downloadGifBlob(blob, filename) {
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = filename;
      document.body.appendChild(link);
      link.click();
      link.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 1500);
    }

    function exportCanvasSupported() {
      return !!(window.Blob && window.URL && document.createElement('canvas').getContext);
    }

    function selectMp4MimeType() {
      if (!window.MediaRecorder || typeof window.MediaRecorder.isTypeSupported !== 'function') return '';
      const candidates = [
        'video/mp4;codecs="avc1.64002A"',
        'video/mp4;codecs=avc1.64002A',
        'video/mp4;codecs="avc1.640028"',
        'video/mp4;codecs=avc1.640028',
        'video/mp4;codecs="avc1.4D402A"',
        'video/mp4;codecs=avc1.4D402A',
        'video/mp4;codecs="avc1.42E01E"',
        'video/mp4;codecs=avc1.42E01E',
        'video/mp4;codecs="h264"',
        'video/mp4;codecs=h264',
        'video/mp4',
      ];
      for (const type of candidates) {
        try {
          if (window.MediaRecorder.isTypeSupported(type)) return type;
        } catch (_) {}
      }
      return '';
    }

    function isMp4ExportSupported() {
      const canvas = document.createElement('canvas');
      return !!(exportCanvasSupported() && canvas.captureStream && selectMp4MimeType());
    }

    function setExportButtonBusy(active, title = 'Export Gif') {
      if (!exportGifBtn) return;
      exportGifBtn.disabled = !!active;
      exportGifBtn.classList.toggle('active', !!active);
      exportGifBtn.setAttribute('title', title);
      exportGifBtn.setAttribute('aria-expanded', 'false');
    }

    function ensureExportFormatMenu() {
      if (exportFormatMenu) return exportFormatMenu;
      const menu = document.createElement('div');
      menu.className = 'export-format-menu';
      menu.setAttribute('role', 'menu');
      menu.setAttribute('aria-label', 'Choisir le format d’export');
      menu.innerHTML = `
        <button class="export-format-option" type="button" role="menuitem" data-export-format="gif">
          <span class="export-format-main">GIF</span>
          <span class="export-format-sub">Animation légère</span>
        </button>
        <button class="export-format-option" type="button" role="menuitem" data-export-format="mp4">
          <span class="export-format-main">MP4</span>
          <span class="export-format-sub">Vidéo haute qualité</span>
        </button>
      `;
      menu.addEventListener('click', (event) => {
        const button = event.target?.closest?.('[data-export-format]');
        if (!button) return;
        event.preventDefault();
        event.stopPropagation();
        const format = button.dataset.exportFormat;
        closeExportFormatMenu();
        if (format === 'gif') exportGridAnimationGif();
        else if (format === 'mp4') exportGridAnimationMp4();
      });
      document.body.appendChild(menu);
      exportFormatMenu = menu;
      return menu;
    }

    function positionExportFormatMenu() {
      if (!exportFormatMenu || !exportGifBtn) return;
      const rect = exportGifBtn.getBoundingClientRect();
      const menuRect = exportFormatMenu.getBoundingClientRect();
      const margin = 10;
      const width = menuRect.width || 188;
      const height = menuRect.height || 116;
      let left = rect.right - width;
      left = Math.max(margin, Math.min(window.innerWidth - width - margin, left));
      let top = rect.top - height - 10;
      if (top < margin) top = rect.bottom + 10;
      exportFormatMenu.style.left = `${Math.round(left)}px`;
      exportFormatMenu.style.top = `${Math.round(top)}px`;
    }

    function refreshExportFormatMenuState() {
      if (!exportFormatMenu) return;
      const mp4Button = exportFormatMenu.querySelector('[data-export-format="mp4"]');
      const mp4Supported = isMp4ExportSupported();
      if (mp4Button) {
        mp4Button.disabled = !mp4Supported;
        mp4Button.title = mp4Supported
          ? 'Exporter une vidéo MP4'
          : 'MP4 indisponible dans ce navigateur : encodeur MediaRecorder MP4 absent';
      }
    }

    function openExportFormatMenu() {
      if (!exportGifBtn) return;
      const menu = ensureExportFormatMenu();
      refreshExportFormatMenuState();
      menu.classList.add('visible');
      exportGifBtn.classList.add('active');
      exportGifBtn.setAttribute('aria-expanded', 'true');
      requestAnimationFrame(positionExportFormatMenu);
    }

    function closeExportFormatMenu() {
      if (!exportFormatMenu) return;
      exportFormatMenu.classList.remove('visible');
      exportGifBtn?.classList.remove('active');
      exportGifBtn?.setAttribute('aria-expanded', 'false');
    }

    function toggleExportFormatMenu(event) {
      event?.preventDefault?.();
      event?.stopPropagation?.();
      if (exportFormatMenu?.classList.contains('visible')) closeExportFormatMenu();
      else openExportFormatMenu();
    }

    function exportBaseFilename(day) {
      const areaLabel = 'France métropolitaine';
      return `objectifoudre-${normalizeDateIso(day?.day_key || selectedBaseDate)}-probabilite-orage-${sanitizeGifFilenamePart(areaLabel)}`;
    }

    function waitExportFrame(ms) {
      return new Promise(resolve => window.setTimeout(resolve, ms));
    }

    async function exportGridAnimationGif() {
      const day = getCurrentDay() || getDays()[0];
      const slots = getRenderableSlots(day);
      if (!slots.length) {
        setMetaMessage('Aucune grille disponible à exporter en GIF.');
        return;
      }
      if (typeof stopTimelinePlayback === 'function') stopTimelinePlayback({ resetToStart: false });
      if (!exportCanvasSupported()) {
        setMetaMessage('Export GIF indisponible dans ce navigateur.');
        return;
      }

      const size = 1080;
      const canvas = document.createElement('canvas');
      canvas.width = size;
      canvas.height = size;
      const ctx = canvas.getContext('2d', { alpha: false, willReadFrequently: true });
      if (!ctx) {
        setMetaMessage('Export GIF impossible : canvas non disponible.');
        return;
      }

      const previousTitle = exportGifBtn?.getAttribute('title') || 'Export Gif';
      try {
        if (exportGifBtn) {
          exportGifBtn.disabled = true;
          exportGifBtn.classList.add('active');
          exportGifBtn.setAttribute('title', 'Export GIF en cours');
          exportGifBtn.setAttribute('aria-expanded', 'false');
        }
        setMetaMessage(`Préparation du GIF France métropolitaine : ${slots.length} heure${slots.length > 1 ? 's' : ''} à exporter…`);
        const paletteInfo = buildGifPalette();
        const frames = [];
        for (let index = 0; index < slots.length; index += 1) {
          drawGridAnimationFrame(ctx, slots[index], day, index, slots.length, slots);
          frames.push(quantizeImageDataToPalette(ctx.getImageData(0, 0, size, size), paletteInfo));
          if (index === 0 || index % 4 === 3 || index === slots.length - 1) {
            setMetaMessage(`Préparation du GIF : ${index + 1}/${slots.length} heure${slots.length > 1 ? 's' : ''}…`);
            await new Promise(resolve => window.setTimeout(resolve, 0));
          }
        }
        setMetaMessage('Encodage du GIF…');
        await new Promise(resolve => window.setTimeout(resolve, 0));
        const blob = createGifBlob(size, size, frames, paletteInfo, 55);
        downloadGifBlob(blob, `${exportBaseFilename(day)}.gif`);
        setMetaMessage(`GIF France métropolitaine exporté : ${slots.length} heure${slots.length > 1 ? 's' : ''}, probabilité orage.`);
      } catch (error) {
        console.error(error);
        setMetaMessage(`Export GIF impossible : ${error?.message || error}`);
      } finally {
        if (exportGifBtn) {
          exportGifBtn.disabled = false;
          exportGifBtn.classList.remove('active');
          exportGifBtn.setAttribute('title', previousTitle);
        }
      }
    }

    async function exportGridAnimationMp4() {
      const day = getCurrentDay() || getDays()[0];
      const slots = getRenderableSlots(day);
      if (!slots.length) {
        setMetaMessage('Aucune grille disponible à exporter en MP4.');
        return;
      }
      if (typeof stopTimelinePlayback === 'function') stopTimelinePlayback({ resetToStart: false });
      if (!exportCanvasSupported()) {
        setMetaMessage('Export MP4 indisponible dans ce navigateur.');
        return;
      }
      const mimeType = selectMp4MimeType();
      if (!window.MediaRecorder || !mimeType) {
        setMetaMessage('Export MP4 indisponible : ce navigateur ne fournit pas d’encodeur MP4. Utilise GIF ou un navigateur compatible MP4.');
        return;
      }

      const size = 1440;
      const canvas = document.createElement('canvas');
      canvas.width = size;
      canvas.height = size;
      const ctx = canvas.getContext('2d', { alpha: false, willReadFrequently: true });
      if (!ctx || !canvas.captureStream) {
        setMetaMessage('Export MP4 impossible : capture canvas non disponible.');
        return;
      }

      const previousTitle = exportGifBtn?.getAttribute('title') || 'Export Gif';
      let stream = null;
      try {
        setExportButtonBusy(true, 'Export MP4 en cours');
        setMetaMessage(`Préparation du MP4 France métropolitaine : ${slots.length} heure${slots.length > 1 ? 's' : ''} à exporter…`);
        const fps = 30;
        const frameDelayMs = 720;
        stream = canvas.captureStream(fps);
        const track = stream.getVideoTracks?.()[0] || null;
        const chunks = [];
        const recorder = new MediaRecorder(stream, {
          mimeType,
          videoBitsPerSecond: 24_000_000,
        });
        const stopped = new Promise((resolve, reject) => {
          recorder.ondataavailable = (event) => {
            if (event.data && event.data.size > 0) chunks.push(event.data);
          };
          recorder.onerror = (event) => reject(event.error || new Error('Erreur encodeur MP4'));
          recorder.onstop = resolve;
        });
        recorder.start(1000);
        await waitExportFrame(120);
        for (let index = 0; index < slots.length; index += 1) {
          drawGridAnimationFrame(ctx, slots[index], day, index, slots.length, slots);
          try { track?.requestFrame?.(); } catch (_) {}
          if (index === 0 || index % 4 === 3 || index === slots.length - 1) {
            setMetaMessage(`Préparation du MP4 : ${index + 1}/${slots.length} heure${slots.length > 1 ? 's' : ''}…`);
          }
          await waitExportFrame(frameDelayMs);
        }
        if (recorder.state !== 'inactive') recorder.stop();
        await stopped;
        if (!chunks.length) throw new Error('aucune image vidéo encodée');
        const blob = new Blob(chunks, { type: mimeType });
        downloadGifBlob(blob, `${exportBaseFilename(day)}.mp4`);
        setMetaMessage(`MP4 France métropolitaine exporté : ${slots.length} heure${slots.length > 1 ? 's' : ''}, probabilité orage.`);
      } catch (error) {
        console.error(error);
        setMetaMessage(`Export MP4 impossible : ${error?.message || error}`);
      } finally {
        try { stream?.getTracks?.().forEach(track => track.stop()); } catch (_) {}
        if (exportGifBtn) {
          exportGifBtn.disabled = false;
          exportGifBtn.classList.remove('active');
          exportGifBtn.setAttribute('title', previousTitle);
          exportGifBtn.setAttribute('aria-expanded', 'false');
        }
      }
    }

