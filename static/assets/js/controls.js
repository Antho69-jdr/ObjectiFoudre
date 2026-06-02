    const METEOFRANCE_API_KEY_STORAGE_KEY = 'storm_meteofrance_api_key';
    const METEOFRANCE_WCS_MAX_DAYS_AHEAD = 1;
    const METEOFRANCE_PRELOAD_POLL_START_MS = 1200;
    const METEOFRANCE_PRELOAD_POLL_RUNNING_MS = 2500;
    const METEOFRANCE_PRELOAD_POLL_ERROR_MS = 5000;
    const METEOFRANCE_SERVER_POLL_RUNNING_MS = 10000;
    const METEOFRANCE_SERVER_POLL_IDLE_MS = 30000;
    const METEOFRANCE_SERVER_POLL_HIDDEN_MS = 60000;
    let mfPreloadPollTimer = null;
    let mfPreloadActiveJobKey = null;
    let mfPreloadClientStartedAtMs = 0;
    let mfPreloadUiTickTimer = null;
    let mfPreloadUiSnapshot = null;
    let mfCachedGribFetchToken = 0;
    let mfFranceDayHydrationToken = 0;
    let mfFranceDayHydrationKey = '';
    let mfFranceDayHydrationPromise = null;
    let mfFranceDayMaterializeToken = 0;
    let mfFranceDayMaterializeKey = '';
    let mfFranceDayMaterializePromise = null;
    let mfAromeGeojsonPrewarmTimer = null;
    let mfQuotaCooldownTimer = null;
    let mfQuotaCooldownEndsAtMs = 0;
    let mfQuotaCooldownMessage = '';
    let mfQuotaCooldownSourceKey = '';
    let mfQuotaCooldownResumeTimer = null;
    let mfQuotaCooldownResumeDate = '';
    let mfQuotaCooldownResumeEndsAtMs = 0;
    let mfQuotaCooldownResumeSourceKey = '';
    let mfServerAutomationPollTimer = null;
    let mfServerAutomationFetchToken = 0;
    let mfServerAutomationLastCoverageKey = '';
    let mfServerAutomationLastMessage = '';
    let exportFormatMenu = null;

    function syncSlotSelection(nextSlotKey) {
      const currentDay = getCurrentDay();
      const nextSlot = currentDay?.slots?.find(s => s.slot_key === nextSlotKey);
      if (!nextSlot) return;
      selectedSlotKey = nextSlot.slot_key;
      closeSelection();
      closeDetails();
      renderSlotButtons();
      requestAnimationFrame(alignTopPanels);
      refreshMap();
      maybeLoadCachedMeteoFranceGribForSelectedSlot({ quiet: true });
    }

    function shiftSelectedDate(daysDelta, loadingMessage) {
      const base = new Date(`${normalizeDateIso(selectedBaseDate)}T12:00:00`);
      base.setDate(base.getDate() + daysDelta);
      applySelectedDate(base.toISOString().slice(0, 10), { force: true, loadingMessage });
    }

    function setupSlotButtonsDrag() {
      if (!slotButtons) return;
      let activePointerId = null;
      let lastWheelAt = 0;
      const WHEEL_THROTTLE_MS = 90;

      const timelineSlots = () => getRenderableSlots(getCurrentDay());
      const selectableTimelineSlots = () => (typeof getSelectableSlots === 'function' ? getSelectableSlots(getCurrentDay()) : timelineSlots());
      const selectedTimelineIndex = (slots = selectableTimelineSlots()) => Math.max(0, slots.findIndex((slot) => slot?.slot_key === selectedSlotKey));
      const isTimelineWheelTarget = (event) => !!event?.target?.closest?.('.timeline-wheel');
      const slotKeyAtClientX = (clientX) => {
        const day = getCurrentDay();
        const slots = timelineSlots();
        if (!slots.length) return null;
        const track = slotButtons.querySelector('.timeline-rail-track') || slotButtons;
        const rect = track.getBoundingClientRect();
        const ratio = rect.width > 0 ? (clientX - rect.left) / rect.width : 0;
        const index = Math.max(0, Math.min(slots.length - 1, Math.round(ratio * Math.max(1, slots.length - 1))));
        const slot = typeof nearestSelectableSlotForIndex === 'function' ? nearestSelectableSlotForIndex(slots, index, day) : slots[index];
        return slot?.slot_key || null;
      };
      const selectByDelta = (delta) => {
        const slots = selectableTimelineSlots();
        if (!slots.length) return false;
        const currentIndex = selectedTimelineIndex(slots);
        const nextIndex = Math.max(0, Math.min(slots.length - 1, currentIndex + delta));
        const nextKey = slots[nextIndex]?.slot_key;
        if (!nextKey || nextKey === selectedSlotKey) return false;
        if (typeof selectTimelineSlot === 'function') return selectTimelineSlot(nextKey);
        selectedSlotKey = nextKey;
        renderSlotButtons();
        refreshMap();
        return true;
      };
      const selectAtClientX = (clientX) => {
        const slotKey = slotKeyAtClientX(clientX);
        if (!slotKey) return false;
        if (typeof selectTimelineSlot === 'function') return selectTimelineSlot(slotKey, { stopPlayback: true });
        return false;
      };

      slotButtons.addEventListener('wheel', (event) => {
        if (isTimelineWheelTarget(event)) return;
        const delta = Math.abs(event.deltaY) >= Math.abs(event.deltaX) ? event.deltaY : event.deltaX;
        if (!delta) return;
        event.preventDefault();
        const now = performance.now();
        if (now - lastWheelAt < WHEEL_THROTTLE_MS) return;
        lastWheelAt = now;
        selectByDelta(delta > 0 ? 1 : -1);
      }, { passive: false });

      slotButtons.addEventListener('pointerdown', (event) => {
        if (isTimelineWheelTarget(event)) return;
        if (event.button !== undefined && event.button !== 0) return;
        activePointerId = event.pointerId;
        slotButtons.classList.add('dragging');
        try { slotButtons.querySelector('.timeline-rail')?.focus({ preventScroll: true }); } catch (_) {}
        try { slotButtons.setPointerCapture(event.pointerId); } catch (_) {}
        selectAtClientX(event.clientX);
        event.preventDefault();
      }, { passive: false });

      slotButtons.addEventListener('pointermove', (event) => {
        if (isTimelineWheelTarget(event)) return;
        if (activePointerId === null || event.pointerId !== activePointerId) return;
        selectAtClientX(event.clientX);
        event.preventDefault();
      }, { passive: false });

      const stopDrag = (event) => {
        if (activePointerId === null) return;
        if (event?.pointerId !== undefined && event.pointerId !== activePointerId) return;
        try { slotButtons.releasePointerCapture(activePointerId); } catch (_) {}
        activePointerId = null;
        slotButtons.classList.remove('dragging');
      };

      slotButtons.addEventListener('pointerup', stopDrag);
      slotButtons.addEventListener('pointercancel', stopDrag);
      slotButtons.addEventListener('lostpointercapture', stopDrag);
      window.addEventListener('pointerup', stopDrag);
      window.addEventListener('pointercancel', stopDrag);

      slotButtons.addEventListener('keydown', (event) => {
        if (!['ArrowLeft', 'ArrowRight', 'Home', 'End', 'PageUp', 'PageDown'].includes(event.key)) return;
        const slots = selectableTimelineSlots();
        if (!slots.length) return;
        event.preventDefault();
        if (event.key === 'Home') {
          if (typeof selectTimelineSlot === 'function') selectTimelineSlot(slots[0].slot_key);
          return;
        }
        if (event.key === 'End') {
          if (typeof selectTimelineSlot === 'function') selectTimelineSlot(slots[slots.length - 1].slot_key);
          return;
        }
        const step = event.key === 'PageUp' || event.key === 'PageDown' ? 3 : 1;
        selectByDelta(event.key === 'ArrowLeft' || event.key === 'PageUp' ? -step : step);
      });
    }


    function loadTimelineCollapsedPreference() {
      try {
        return localStorage.getItem('storm_timeline_collapsed_v2') === '1';
      } catch (_) {
        return false;
      }
    }


    function syncTimelineToggleVisual(collapsed) {
      if (!timelineToggleBtn) return;
      const icon = timelineToggleBtn.querySelector('.timeline-toggle-icon');
      if (icon) icon.textContent = collapsed ? '↑' : '↓';
      timelineToggleBtn.setAttribute('aria-label', collapsed ? 'Afficher la frise' : 'Masquer la frise');
      timelineToggleBtn.setAttribute('title', collapsed ? 'Afficher la frise' : 'Masquer la frise');
      timelineToggleBtn.setAttribute('aria-expanded', collapsed ? 'false' : 'true');
    }

    function applyTimelineCollapsedState(collapsed) {
      if (!timelineDock) return;
      timelineDock.classList.toggle('collapsed', !!collapsed);
      syncTimelineToggleVisual(!!collapsed);
      try {
        localStorage.setItem('storm_timeline_collapsed_v2', collapsed ? '1' : '0');
      } catch (_) {}
    }

    function setupTimelineToggle() {
      if (!timelineDock || !timelineToggleBtn) return;

      const isTouchTimelineMode = () => {
        try {
          return window.matchMedia('(hover: none), (pointer: coarse)').matches;
        } catch (_) {
          return false;
        }
      };

      const toggleTimeline = () => {
        applyTimelineCollapsedState(!timelineDock.classList.contains('collapsed'));
        requestAnimationFrame(syncBottomUiLayout);
      };

      let gesturePointerId = null;
      let gestureStartY = 0;
      let gestureDragging = false;
      let gestureTriggered = false;
      const gestureThreshold = 18;

      applyTimelineCollapsedState(loadTimelineCollapsedPreference());
      requestAnimationFrame(syncBottomUiLayout);

      timelineToggleBtn.addEventListener('click', (event) => {
        event.preventDefault();
        event.stopPropagation();
        if (isTouchTimelineMode()) {
          if (!gestureDragging && !gestureTriggered) toggleTimeline();
          gestureTriggered = false;
          return;
        }
        toggleTimeline();
      });

      timelineToggleBtn.addEventListener('pointerdown', (event) => {
        if (!isTouchTimelineMode()) return;
        if (event.pointerType === 'mouse') return;
        gesturePointerId = event.pointerId;
        gestureStartY = event.clientY;
        gestureDragging = true;
        gestureTriggered = false;
        timelineToggleBtn.classList.add('is-dragging');
        try { timelineToggleBtn.setPointerCapture(event.pointerId); } catch (_) {}
        event.preventDefault();
      }, { passive: false });

      timelineToggleBtn.addEventListener('pointermove', (event) => {
        if (!gestureDragging || event.pointerId !== gesturePointerId) return;
        const deltaY = event.clientY - gestureStartY;
        const isCollapsed = timelineDock.classList.contains('collapsed');

        if (!isCollapsed && deltaY > gestureThreshold) {
          applyTimelineCollapsedState(true);
          requestAnimationFrame(syncBottomUiLayout);
          gestureTriggered = true;
          gestureDragging = false;
        } else if (isCollapsed && deltaY < -gestureThreshold) {
          applyTimelineCollapsedState(false);
          requestAnimationFrame(syncBottomUiLayout);
          gestureTriggered = true;
          gestureDragging = false;
        }

        if (gestureTriggered) {
          timelineToggleBtn.classList.remove('is-dragging');
          try { timelineToggleBtn.releasePointerCapture(event.pointerId); } catch (_) {}
          event.preventDefault();
        }
      }, { passive: false });

      const endGesture = (event) => {
        if (gesturePointerId !== null && event.pointerId !== undefined && event.pointerId !== gesturePointerId) return;
        timelineToggleBtn.classList.remove('is-dragging');
        if (gesturePointerId !== null) {
          try { timelineToggleBtn.releasePointerCapture(gesturePointerId); } catch (_) {}
        }
        gesturePointerId = null;
        gestureDragging = false;
        requestAnimationFrame(() => {
          gestureTriggered = false;
        });
      };

      timelineToggleBtn.addEventListener('pointerup', endGesture);
      timelineToggleBtn.addEventListener('pointercancel', endGesture);
    }


    function syncBottomUiLayout() {
      const root = document.documentElement;
      const metaHeight = metaCenter?.parentElement?.offsetHeight || document.querySelector('.meta-stack')?.offsetHeight || 0;
      const timelineHeight = timelineDock?.offsetHeight || 0;
      root.style.setProperty('--meta-height-px', `${Math.round(metaHeight)}px`);
      root.style.setProperty('--timeline-height-px', `${Math.round(timelineHeight)}px`);
    }

    function setupBottomUiLayoutSync() {
      const sync = () => requestAnimationFrame(syncBottomUiLayout);
      sync();
      window.addEventListener('resize', sync);
      window.addEventListener('orientationchange', sync);
      if (window.visualViewport) {
        window.visualViewport.addEventListener('resize', sync);
      }
      if (typeof ResizeObserver === 'function') {
        if (timelineDock) {
          const observer = new ResizeObserver(sync);
          observer.observe(timelineDock);
        }
        const metaStack = document.querySelector('.meta-stack');
        if (metaStack) {
          const observer = new ResizeObserver(sync);
          observer.observe(metaStack);
        }
      }
    }

    function setupMetricInfoTriggers() {}


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
      const rgb = parseRgbColor(colorFromScore(score));
      if (!rgb) return colorFromScore(score);
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
        const baseColor = parseRgbColor(colorFromScore(score));
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

    function buildGifGridExtent(cells) {
      let north = -Infinity;
      let south = Infinity;
      let east = -Infinity;
      let west = Infinity;
      const validCells = [];
      for (const cell of cells) {
        const lat = Number(cell?.lat);
        const lon = Number(cell?.lon);
        const cellHeight = Number(cell?.cell_height_deg);
        const cellWidth = Number(cell?.cell_width_deg);
        if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
        if (!Number.isFinite(cellHeight) || !Number.isFinite(cellWidth) || cellHeight <= 0 || cellWidth <= 0) continue;
        validCells.push(cell);
        north = Math.max(north, lat + (cellHeight / 2));
        south = Math.min(south, lat - (cellHeight / 2));
        east = Math.max(east, lon + (cellWidth / 2));
        west = Math.min(west, lon - (cellWidth / 2));
      }
      if (!validCells.length || !Number.isFinite(north) || !Number.isFinite(south) || !Number.isFinite(east) || !Number.isFinite(west)) return null;
      return { north, south, east, west, validCells };
    }

    function gifCellOpacity(cell, bestZones, hasMapBackground = false) {
      const baseOpacity = opacityFromConfidence(cell?.confidence_score);
      if (hasMapBackground) {
        if (!bestCellsMode || !bestZones) return Math.max(0.24, Math.min(0.58, baseOpacity + 0.05));
        const isBest = bestZones.has(cell?.zone);
        return isBest ? Math.max(0.38, Math.min(0.68, baseOpacity + 0.1)) : Math.max(0.08, Math.min(0.18, baseOpacity * 0.25));
      }
      const lift = 0.18;
      if (!bestCellsMode || !bestZones) return Math.max(0.28, Math.min(0.9, baseOpacity + lift));
      const isBest = bestZones.has(cell?.zone);
      return isBest ? Math.max(0.68, Math.min(0.94, baseOpacity + lift)) : Math.max(0.12, baseOpacity * 0.35);
    }

    function waitForMapIdleForGif(timeoutMs = 900) {
      return new Promise((resolve) => {
        if (!map?.once) {
          resolve();
          return;
        }
        let done = false;
        const finish = () => {
          if (done) return;
          done = true;
          try { map.off('idle', finish); } catch (_) {}
          resolve();
        };
        try { map.once('idle', finish); } catch (_) { finish(); }
        window.setTimeout(finish, timeoutMs);
      });
    }

    async function captureGifMapBackground() {
      if (!map?.getCanvas || !map?.getStyle || !map?.isStyleLoaded?.()) return null;
      const gridLayerIds = (map.getStyle()?.layers || [])
        .map(layer => layer?.id)
        .filter(id => typeof id === 'string' && id.startsWith('grid-') && map.getLayer(id));
      const previousVisibility = gridLayerIds.map((id) => {
        let visibility = 'visible';
        try { visibility = map.getLayoutProperty(id, 'visibility') || 'visible'; } catch (_) {}
        return [id, visibility];
      });

      try {
        for (const id of gridLayerIds) {
          try { map.setLayoutProperty(id, 'visibility', 'none'); } catch (_) {}
        }
        try { map.triggerRepaint(); } catch (_) {}
        await waitForMapIdleForGif();
        await new Promise(resolve => requestAnimationFrame(resolve));

        const sourceCanvas = map.getCanvas();
        if (!sourceCanvas?.width || !sourceCanvas?.height) return null;
        const backgroundCanvas = document.createElement('canvas');
        backgroundCanvas.width = sourceCanvas.width;
        backgroundCanvas.height = sourceCanvas.height;
        const backgroundCtx = backgroundCanvas.getContext('2d', { willReadFrequently: true });
        backgroundCtx.drawImage(sourceCanvas, 0, 0);
        backgroundCtx.getImageData(0, 0, 1, 1);
        return {
          canvas: backgroundCanvas,
          width: backgroundCanvas.width,
          height: backgroundCanvas.height,
          pixelRatioX: backgroundCanvas.width / Math.max(1, sourceCanvas.clientWidth || backgroundCanvas.width),
          pixelRatioY: backgroundCanvas.height / Math.max(1, sourceCanvas.clientHeight || backgroundCanvas.height),
        };
      } catch (error) {
        console.warn('Export GIF : capture du fond de carte indisponible.', error);
        return null;
      } finally {
        for (const [id, visibility] of previousVisibility) {
          try { map.setLayoutProperty(id, 'visibility', visibility || 'visible'); } catch (_) {}
        }
        try { map.triggerRepaint(); } catch (_) {}
      }
    }

    function buildGifMapViewport(mapBackground, destLeft, destTop, destWidth, destHeight) {
      if (!mapBackground?.canvas || !destWidth || !destHeight) return null;
      const sourceAspect = mapBackground.width / Math.max(1, mapBackground.height);
      const destAspect = destWidth / Math.max(1, destHeight);
      let sx = 0;
      let sy = 0;
      let sw = mapBackground.width;
      let sh = mapBackground.height;
      if (sourceAspect > destAspect) {
        sw = Math.round(mapBackground.height * destAspect);
        sx = Math.round((mapBackground.width - sw) / 2);
      } else {
        sh = Math.round(mapBackground.width / destAspect);
        sy = Math.round((mapBackground.height - sh) / 2);
      }
      return {
        sx, sy, sw, sh,
        destLeft, destTop, destWidth, destHeight,
        scaleX: destWidth / Math.max(1, sw),
        scaleY: destHeight / Math.max(1, sh),
      };
    }

    function projectGifMapPoint(mapViewport, lon, lat, mapBackground) {
      if (!mapViewport || !map?.project) return null;
      try {
        const projected = map.project([lon, lat]);
        const sourceX = projected.x * mapBackground.pixelRatioX;
        const sourceY = projected.y * mapBackground.pixelRatioY;
        return {
          x: mapViewport.destLeft + ((sourceX - mapViewport.sx) * mapViewport.scaleX),
          y: mapViewport.destTop + ((sourceY - mapViewport.sy) * mapViewport.scaleY),
        };
      } catch (_) {
        return null;
      }
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

    function drawGifAdminLines(ctx, projection) {
      const departmentRings = getGifDepartmentRings();
      const clipRings = getGifClipRings();
      ctx.save();
      if (departmentRings.length && addGifRingsPath(ctx, departmentRings, projection)) {
        ctx.strokeStyle = 'rgba(226, 232, 240, 0.46)';
        ctx.lineWidth = Math.max(0.7, ctx.canvas.width / 1180);
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
        const rectX = Math.round(x);
        const rectY = Math.round(y);
        const rectW = Math.max(1, Math.round(x + w) - rectX);
        const rectH = Math.max(1, Math.round(y + h) - rectY);
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

    function drawGridAnimationFrame(ctx, slot, day, frameIndex, frameCount, slots = null) {
      const width = ctx.canvas.width;
      const height = ctx.canvas.height;
      const cells = Array.isArray(slot?.cells) ? slot.cells : [];
      const top = Math.round(height * 0.082);
      const bottom = Math.round(height * 0.17);
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
      ctx.fillStyle = '#0b1220';
      ctx.fillRect(0, 0, width, top - 10);
      ctx.fillStyle = '#0b1220';
      ctx.fillRect(0, height - bottom + 4, width, bottom - 4);

      drawGifFranceBase(ctx, projection, mapRect);
      drawGifFranceGridCells(ctx, cells, projection);
      drawGifAdminLines(ctx, projection);
      drawGifLabels(ctx, projection);

      ctx.save();
      ctx.strokeStyle = 'rgba(148, 163, 184, 0.3)';
      ctx.lineWidth = 1;
      ctx.strokeRect(Math.round(mapRect.left) + 0.5, Math.round(mapRect.top) + 0.5, Math.round(mapRect.width), Math.round(mapRect.height));
      ctx.restore();

      ctx.textBaseline = 'alphabetic';
      ctx.textAlign = 'left';
      ctx.fillStyle = '#f8fafc';
      ctx.font = `800 ${Math.max(24, Math.round(width / 38))}px system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif`;
      drawFittedText(ctx, 'ObjectiFoudre', side, Math.round(top * 0.4), width * 0.32);
      ctx.font = `650 ${Math.max(15, Math.round(width / 66))}px system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif`;
      ctx.fillStyle = '#cbd5e1';
      drawFittedText(ctx, title, side, Math.round(top * 0.72), width * 0.58);

      drawGifTimelineFooter(ctx, slot, frameIndex, frameCount, footerRect, slots);
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

    function setExportButtonBusy(active, title = 'Exporter animation') {
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

      const previousTitle = exportGifBtn?.getAttribute('title') || 'Exporter animation';
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

      const previousTitle = exportGifBtn?.getAttribute('title') || 'Exporter animation';
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

    function setMeteoFranceTestStatus(message, state = '') {
      if (!mfTestStatus) return;
      mfTestStatus.classList.remove('is-ok', 'is-error', 'is-waiting');
      if (state) mfTestStatus.classList.add(`is-${state}`);
      mfTestStatus.textContent = message;
    }

    function meteoFranceSlotKeyFromHour(hour) {
      const value = Number(hour);
      if (!Number.isFinite(value) || value < 0 || value > 23) return null;
      return `h${String(Math.trunc(value)).padStart(2, '0')}`;
    }

    function meteoFranceCoverageForSelectedDate(status) {
      const coverages = Array.isArray(status?.coverage) ? status.coverage : [];
      const selectedDate = normalizeDateIso(selectedBaseDate);
      return coverages.find((item) => normalizeDateIso(item?.date) === selectedDate) || null;
    }

    function meteoFranceCachedSlotKeysFromCoverage(coverage) {
      const hours = Array.isArray(coverage?.cached_hours) ? coverage.cached_hours : [];
      return hours.map(meteoFranceSlotKeyFromHour).filter(Boolean);
    }

    function meteoFranceAvailableSlotKeysFromCoverage(coverage) {
      const hours = Array.isArray(coverage?.available_hours) ? coverage.available_hours : null;
      if (!hours) return null;
      return hours.map(meteoFranceSlotKeyFromHour).filter(Boolean);
    }

    function updateMeteoFranceCacheStatusFromAutomation(status, { hydrate = true } = {}) {
      const coverages = Array.isArray(status?.coverage) ? status.coverage : [];
      for (const item of coverages) {
        const itemDate = normalizeDateIso(item?.date);
        const itemCachedKeys = meteoFranceCachedSlotKeysFromCoverage(item);
        const itemAvailableKeys = meteoFranceAvailableSlotKeysFromCoverage(item);
        if (typeof rememberMeteoFranceGribCacheStatus === 'function' && itemCachedKeys.length) {
          rememberMeteoFranceGribCacheStatus(itemDate, itemCachedKeys);
        }
        if (typeof rememberMeteoFranceGribAvailabilityStatus === 'function' && itemAvailableKeys) {
          rememberMeteoFranceGribAvailabilityStatus(itemDate, itemAvailableKeys);
        }
      }
      const coverage = meteoFranceCoverageForSelectedDate(status);
      if (!coverage) return false;
      const cachedKeys = meteoFranceCachedSlotKeysFromCoverage(coverage);
      const availableKeys = meteoFranceAvailableSlotKeysFromCoverage(coverage);
      const availabilityKey = availableKeys ? availableKeys.join(',') : 'unknown';
      const nextKey = `${normalizeDateIso(coverage.date)}|${cachedKeys.join(',')}|${availabilityKey}|${Number(coverage.ok_count || 0)}/${Number(coverage.hour_count || 24)}`;
      if (nextKey === mfServerAutomationLastCoverageKey) return false;
      mfServerAutomationLastCoverageKey = nextKey;
      meteoFranceGribCachedSlotKeys = new Set(cachedKeys);
      meteoFranceGribAvailableSlotKeys = availableKeys ? new Set(availableKeys) : null;
      if (typeof rememberMeteoFranceGribCacheStatus === 'function' && cachedKeys.length) {
        rememberMeteoFranceGribCacheStatus(normalizeDateIso(coverage.date), cachedKeys);
      }
      if (typeof rememberMeteoFranceGribAvailabilityStatus === 'function' && availableKeys) {
        rememberMeteoFranceGribAvailabilityStatus(normalizeDateIso(coverage.date), availableKeys);
      }
      const day = getCurrentDay();
      if (day && typeof isMeteoFranceSlotUnavailable === 'function') {
        const selectedSlot = getRenderableSlots(day).find((slot) => slot?.slot_key === selectedSlotKey);
        if (selectedSlot && isMeteoFranceSlotUnavailable(selectedSlot, day)) {
          selectedSlotKey = (typeof getSelectableSlots === 'function' ? getSelectableSlots(day)[0]?.slot_key : null) || selectedSlotKey;
          closeSelection();
          closeDetails();
        }
      }
      renderSlotButtons();
      if (hydrate && cachedKeys.length) {
        hydrateMeteoFranceGribFranceDayFromCache({ force: false });
        maybeLoadCachedMeteoFranceGribForSelectedSlot({ quiet: true, force: true, buildFromNationalCache: false });
      }
      return true;
    }

    function summarizeMeteoFranceAutomationStatus(status) {
      const state = status?.state || {};
      const coverage = meteoFranceCoverageForSelectedDate(status);
      const cooldownSeconds = Number(status?.quota_cooldown_seconds || state?.quota_cooldown_seconds || 0);
      const cache = status?.config?.cache_dir_status || {};
      const parts = [];
      if (coverage) {
        const ok = Number(coverage.ok_count || 0);
        const total = Number(coverage.hour_count || 24);
        const calendarTotal = Number(coverage.calendar_hour_count || 24);
        const missing = Array.isArray(coverage.missing_hours) ? coverage.missing_hours.length : Math.max(0, total - ok);
        const availabilityText = coverage.partial_availability ? ` · publié ${total}/${calendarTotal}h` : '';
        parts.push(`cache ${ok}/${total}h${missing ? `, ${missing} manquante(s)` : ''}${availabilityText}`);
      }
      if (cooldownSeconds > 0) parts.push(`quota ${formatMeteoFranceCooldown(cooldownSeconds)}`);
      if (state.running) parts.push('automation active');
      if (cache.writable === false) parts.push('cache disque non inscriptible');
      return parts.join(' · ');
    }

    function syncMeteoFranceServerAutomationStatus(status, { quiet = true } = {}) {
      if (!status?.ok) return false;
      syncMeteoFranceQuotaCooldown(status);
      const state = status.state || {};
      const currentJob = state.current_job && typeof state.current_job === 'object' ? state.current_job : null;
      if (currentJob?.job_key && currentJob.running) {
        trackMeteoFrancePreload({ progress: currentJob, already_running: true });
      } else if (currentJob?.job_key && !mfPreloadActiveJobKey) {
        renderMeteoFrancePreloadProgress(currentJob);
      }
      updateMeteoFranceCacheStatusFromAutomation(status, { hydrate: true });
      const summary = summarizeMeteoFranceAutomationStatus(status);
      const message = String(state.message || '').trim();
      const nextMessage = message && summary ? `${message} (${summary})` : (message || summary);
      if (!quiet && nextMessage) {
        setMeteoFranceTestStatus(nextMessage, state.running ? 'waiting' : '');
      } else if (nextMessage && nextMessage !== mfServerAutomationLastMessage && state.running && !mfPreloadActiveJobKey) {
        setMeteoFranceTestStatus(nextMessage, 'waiting');
      }
      if (nextMessage) mfServerAutomationLastMessage = nextMessage;
      return true;
    }

    function stopMeteoFranceServerAutomationPolling() {
      if (mfServerAutomationPollTimer) {
        window.clearTimeout(mfServerAutomationPollTimer);
        mfServerAutomationPollTimer = null;
      }
    }

    async function pollMeteoFranceServerAutomationStatus({ immediate = false, quiet = true } = {}) {
      stopMeteoFranceServerAutomationPolling();
      const fetchToken = ++mfServerAutomationFetchToken;
      try {
        const response = await fetch('/api/server/arome-automation-status', { cache: 'no-store' });
        const data = await response.json().catch(() => ({}));
        if (fetchToken !== mfServerAutomationFetchToken) return null;
        if (response.ok && data?.ok) syncMeteoFranceServerAutomationStatus(data, { quiet });
        const state = data?.state || {};
        const currentJob = state.current_job || {};
        const cooldownSeconds = Number(data?.quota_cooldown_seconds || state?.quota_cooldown_seconds || 0);
        const running = Boolean(state.running || currentJob.running || cooldownSeconds > 0);
        const nextDelay = document.visibilityState === 'visible'
          ? (running ? METEOFRANCE_SERVER_POLL_RUNNING_MS : METEOFRANCE_SERVER_POLL_IDLE_MS)
          : METEOFRANCE_SERVER_POLL_HIDDEN_MS;
        mfServerAutomationPollTimer = window.setTimeout(() => {
          pollMeteoFranceServerAutomationStatus({ quiet: true });
        }, nextDelay);
        return data;
      } catch (_) {
        if (fetchToken === mfServerAutomationFetchToken) {
          mfServerAutomationPollTimer = window.setTimeout(() => {
            pollMeteoFranceServerAutomationStatus({ quiet: true });
          }, immediate ? 10000 : 30000);
        }
        return null;
      }
    }

    function formatMeteoFranceCooldown(seconds) {
      const total = Math.max(0, Math.ceil(Number(seconds || 0)));
      const minutes = Math.floor(total / 60);
      const secs = total % 60;
      if (minutes >= 60) {
        const hours = Math.floor(minutes / 60);
        const remMinutes = minutes % 60;
        return `${hours}h ${String(remMinutes).padStart(2, '0')}m ${String(secs).padStart(2, '0')}s`;
      }
      return `${String(minutes).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
    }

    function meteoFranceQuotaCooldownRemainingSeconds() {
      if (!mfQuotaCooldownEndsAtMs) return 0;
      return Math.max(0, Math.ceil((mfQuotaCooldownEndsAtMs - Date.now()) / 1000));
    }

    function clearMeteoFranceQuotaCooldownBadge() {
      mfQuotaCooldownEndsAtMs = 0;
      mfQuotaCooldownMessage = '';
      mfQuotaCooldownSourceKey = '';
      if (mfQuotaCooldownTimer) {
        window.clearInterval(mfQuotaCooldownTimer);
        mfQuotaCooldownTimer = null;
      }
      if (typeof mfQuotaCooldownBadge !== 'undefined' && mfQuotaCooldownBadge) {
        mfQuotaCooldownBadge.hidden = true;
      }
    }

    function renderMeteoFranceQuotaCooldownBadge() {
      if (typeof mfQuotaCooldownBadge === 'undefined' || !mfQuotaCooldownBadge) return;
      const remainingMs = mfQuotaCooldownEndsAtMs - Date.now();
      if (remainingMs <= 0) {
        clearMeteoFranceQuotaCooldownBadge();
        return;
      }
      const remainingSeconds = Math.ceil(remainingMs / 1000);
      mfQuotaCooldownBadge.hidden = false;
      mfQuotaCooldownBadge.textContent = `Quota AROME : ${formatMeteoFranceCooldown(remainingSeconds)}`;
      mfQuotaCooldownBadge.title = mfQuotaCooldownMessage || 'Cooldown quota Météo-France actif côté serveur';
    }

    function meteoFranceQuotaCooldownSourceKey(data, progress) {
      const jobKey = data?.job_key || progress?.job_key || '';
      const scope = data?.quota_cooldown_scope || progress?.quota_cooldown_scope || 'meteofrance';
      const status = data?.status || progress?.status || 'quota';
      const date = progress?.date || selectedBaseDate || '';
      return `${scope}|${jobKey || date}|${status}`;
    }

    function startMeteoFranceQuotaCooldown(seconds, message = '', sourceKey = '') {
      const duration = Number(seconds || 0);
      if (!Number.isFinite(duration) || duration <= 0) return;
      const now = Date.now();
      const proposedEndsAtMs = now + Math.ceil(duration) * 1000;
      const activeRemainingMs = mfQuotaCooldownEndsAtMs - now;
      const sameSource = sourceKey && sourceKey === mfQuotaCooldownSourceKey;
      if (activeRemainingMs > 0 && sameSource && proposedEndsAtMs >= mfQuotaCooldownEndsAtMs - 1500) {
        mfQuotaCooldownMessage = String(message || mfQuotaCooldownMessage || 'Cooldown quota Météo-France actif côté serveur');
        renderMeteoFranceQuotaCooldownBadge();
        if (!mfQuotaCooldownTimer) mfQuotaCooldownTimer = window.setInterval(renderMeteoFranceQuotaCooldownBadge, 1000);
        return;
      }
      mfQuotaCooldownEndsAtMs = proposedEndsAtMs;
      mfQuotaCooldownMessage = String(message || 'Cooldown quota Météo-France actif côté serveur');
      mfQuotaCooldownSourceKey = sourceKey || mfQuotaCooldownSourceKey || 'meteofrance-quota';
      renderMeteoFranceQuotaCooldownBadge();
      if (mfQuotaCooldownTimer) window.clearInterval(mfQuotaCooldownTimer);
      mfQuotaCooldownTimer = window.setInterval(renderMeteoFranceQuotaCooldownBadge, 1000);
    }

    function syncMeteoFranceQuotaCooldown(data) {
      const progress = normalizeMeteoFrancePreloadProgress(data);
      const seconds = Number(data?.quota_cooldown_seconds || progress?.quota_cooldown_seconds || 0);
      if (Number.isFinite(seconds) && seconds > 0) {
        startMeteoFranceQuotaCooldown(
          seconds,
          data?.message || progress?.message || 'Quota Météo-France en cooldown serveur.',
          meteoFranceQuotaCooldownSourceKey(data, progress),
        );
        return true;
      }
      return false;
    }

    function cancelMeteoFranceQuotaAutoResume() {
      if (mfQuotaCooldownResumeTimer) {
        window.clearTimeout(mfQuotaCooldownResumeTimer);
        mfQuotaCooldownResumeTimer = null;
      }
      mfQuotaCooldownResumeDate = '';
      mfQuotaCooldownResumeEndsAtMs = 0;
      mfQuotaCooldownResumeSourceKey = '';
    }

    function scheduleMeteoFranceQuotaAutoResume(seconds, sourceKey = '') {
      const duration = Number(seconds || 0);
      if (!Number.isFinite(duration) || duration <= 0) return;
      const resumeDate = selectedBaseDate;
      const targetEndsAtMs = Date.now() + Math.ceil(duration) * 1000 + 900;
      const sameResume = mfQuotaCooldownResumeTimer
        && mfQuotaCooldownResumeDate === resumeDate
        && sourceKey
        && sourceKey === mfQuotaCooldownResumeSourceKey;
      if (sameResume && targetEndsAtMs >= mfQuotaCooldownResumeEndsAtMs - 1000) return;
      cancelMeteoFranceQuotaAutoResume();
      mfQuotaCooldownResumeDate = resumeDate;
      mfQuotaCooldownResumeEndsAtMs = targetEndsAtMs;
      mfQuotaCooldownResumeSourceKey = sourceKey || '';
      mfQuotaCooldownResumeTimer = window.setTimeout(() => {
        mfQuotaCooldownResumeTimer = null;
        mfQuotaCooldownResumeEndsAtMs = 0;
        mfQuotaCooldownResumeSourceKey = '';
        const shouldResume = selectedBaseDate === resumeDate
          && !!readMeteoFranceApiKey();
        if (!shouldResume) return;
        setMeteoFranceTestStatus('Cooldown quota terminé : attente de la reprise automatique serveur AROME…', 'waiting');
        refreshMeteoFranceGribCacheStatus({ force: true });
      }, Math.max(1000, Math.ceil(duration) * 1000 + 900));
    }

    function stopMeteoFrancePreloadPolling() {
      if (mfPreloadPollTimer) {
        clearTimeout(mfPreloadPollTimer);
        mfPreloadPollTimer = null;
      }
    }

    function normalizeMeteoFrancePreloadProgress(preload) {
      if (!preload) return null;
      return preload.progress || preload;
    }

    function stopMeteoFrancePreloadUiTick() {
      if (mfPreloadUiTickTimer) {
        window.clearInterval(mfPreloadUiTickTimer);
        mfPreloadUiTickTimer = null;
      }
    }

    function ensureMeteoFrancePreloadUiTick() {
      if (mfPreloadUiTickTimer) return;
      mfPreloadUiTickTimer = window.setInterval(() => {
        if (!mfPreloadUiSnapshot) {
          stopMeteoFrancePreloadUiTick();
          return;
        }
        renderMeteoFrancePreloadProgress(mfPreloadUiSnapshot);
      }, 1000);
    }

    function formatMeteoFranceHourLabel(hour) {
      const value = Number(hour);
      return Number.isFinite(value) ? `${String(value).padStart(2, '0')}h` : null;
    }

    function formatMeteoFranceDuration(ms) {
      const totalSeconds = Math.max(0, Math.round(Number(ms || 0) / 1000));
      const hours = Math.floor(totalSeconds / 3600);
      const minutes = Math.floor((totalSeconds % 3600) / 60);
      const seconds = totalSeconds % 60;
      if (hours > 0) return `${hours} h ${String(minutes).padStart(2, '0')} min ${String(seconds).padStart(2, '0')} s`;
      if (minutes > 0) return `${minutes} min ${String(seconds).padStart(2, '0')} s`;
      return `${seconds} s`;
    }

    function meteoFrancePreloadElapsedMs(progress) {
      const directElapsed = Number(progress?.elapsed_ms);
      if (Number.isFinite(directElapsed) && directElapsed > 0) return directElapsed;
      const clientStartedAt = Number(progress?.client_started_at_ms || 0);
      if (clientStartedAt > 0) return Date.now() - clientStartedAt;
      const jobStartedAt = Number(progress?.started_at);
      if (Number.isFinite(jobStartedAt) && jobStartedAt > 0) {
        const jobFinishedAt = Number(progress?.finished_at);
        const endAt = Number.isFinite(jobFinishedAt) && jobFinishedAt > 0 ? jobFinishedAt * 1000 : Date.now();
        return endAt - (jobStartedAt * 1000);
      }
      if (progress?.job_key && progress.job_key === mfPreloadActiveJobKey && mfPreloadClientStartedAtMs > 0) {
        return Date.now() - mfPreloadClientStartedAtMs;
      }
      return 0;
    }

    function renderMeteoFrancePreloadProgress(preload) {
      if (!mfPreloadProgress) return;
      const progress = normalizeMeteoFrancePreloadProgress(preload);
      if (!progress) {
        mfPreloadUiSnapshot = null;
        stopMeteoFrancePreloadUiTick();
        mfPreloadProgress.hidden = true;
        return;
      }
      if (progress.running || progress.indeterminate) {
        mfPreloadUiSnapshot = {
          ...progress,
          client_started_at_ms: progress.client_started_at_ms || mfPreloadClientStartedAtMs || Date.now(),
        };
        ensureMeteoFrancePreloadUiTick();
      } else {
        mfPreloadUiSnapshot = null;
        stopMeteoFrancePreloadUiTick();
      }
      const hourCount = Number(progress.hour_count || (Array.isArray(progress.hours) ? progress.hours.length : 0));
      const unitCount = Number(progress.unit_count || hourCount);
      const completedCount = Number(progress.completed_count || 0);
      const percentSource = Number(progress.percent);
      const percent = Math.max(0, Math.min(100, Number.isFinite(percentSource)
        ? percentSource
        : (unitCount > 0 ? Math.round((completedCount / unitCount) * 100) : 0)));
      const okCount = Number(progress.ok_count || 0);
      const failedCount = Number(progress.failed_count || 0);
      const rangeCount = Number(progress.total_range_request_count || 0);
      const packageCount = Number(progress.package_request_count || 0);
      const cachedPackageCount = Number(progress.cached_package_request_count || 0);
      const cachedRangeCount = Number(progress.cached_total_range_request_count || 0);
      const currentHour = formatMeteoFranceHourLabel(progress.current_hour);
      const lastHour = formatMeteoFranceHourLabel(progress.last_result?.hour);
      const running = Boolean(progress.running);
      const indeterminate = Boolean(progress.indeterminate);
      const isDayScope = progress.scope === 'day';
      const isNationalScope = progress.scope === 'national_day';
      const unitLabel = progress.unit_label || (isNationalScope ? 'champ(s)' : 'heure(s)');
      const title = progress.title || (isNationalScope
        ? (running ? 'Préchargement France en cours' : 'Préchargement France terminé')
        : (isDayScope
          ? (running ? 'Préchargement journée en cours' : 'Préchargement journée terminé')
          : (running ? 'Préchargement du bloc en cours' : 'Préchargement du bloc terminé')));
      const countText = progress.detail || (unitCount > 0
        ? `${Math.min(completedCount, unitCount)}/${unitCount} ${unitLabel}`
        : (isNationalScope ? 'Préparation France' : (isDayScope ? 'Préparation journée' : 'Préparation du bloc')));
      const fieldText = progress.current_field ? `${progress.current_field}` : '';
      const currentText = running && currentHour
        ? ` · ${isNationalScope && fieldText ? `${fieldText} ` : ''}${currentHour} en cours`
        : (lastHour ? ` · dernière heure ${lastHour}` : '');
      const failureText = failedCount > 0 ? ` · ${failedCount} échec(s)` : '';
      const rangeText = rangeCount > 0 ? ` · ${rangeCount} Range API` : '';
      const packageText = packageCount > 0 ? ` · ${packageCount} paquet(s)` : '';
      const cachedPackageText = cachedPackageCount > 0 ? ` · ${cachedPackageCount} paquet(s) cache` : '';
      const cacheText = cachedRangeCount > 0 ? ` · ${cachedRangeCount} Range évités` : '';
      const elapsedMs = meteoFrancePreloadElapsedMs(progress);
      const durationText = elapsedMs > 0
        ? ` · ${running ? 'depuis' : 'durée'} ${formatMeteoFranceDuration(elapsedMs)}`
        : '';

      mfPreloadProgress.hidden = false;
      mfPreloadProgress.classList.toggle('is-indeterminate', indeterminate);
      if (mfPreloadProgressLabel) mfPreloadProgressLabel.textContent = title;
      if (mfPreloadProgressValue) mfPreloadProgressValue.textContent = indeterminate ? '…' : `${percent}%`;
      if (mfPreloadProgressBar) mfPreloadProgressBar.style.width = indeterminate ? '' : `${percent}%`;
      if (mfPreloadProgressDetail) {
        mfPreloadProgressDetail.textContent = `${countText}${currentText} · ${okCount} OK${failureText}${rangeText}${packageText}${cachedPackageText}${cacheText}${durationText}`;
      }
    }

    async function pollMeteoFrancePreloadProgress(jobKey) {
      if (!jobKey || mfPreloadActiveJobKey !== jobKey) return;
      try {
        const response = await fetch(`/api/meteofrance/grib-preload-status?job_key=${encodeURIComponent(jobKey)}`);
        const data = await response.json().catch(() => ({}));
        if (!data?.ok) {
          stopMeteoFrancePreloadPolling();
          return;
        }
        const hasQuotaCooldown = syncMeteoFranceQuotaCooldown(data);
        renderMeteoFrancePreloadProgress(data);
        if (data.running && mfPreloadActiveJobKey === jobKey) {
          if (!hasQuotaCooldown) clearMeteoFranceQuotaCooldownBadge();
          mfPreloadPollTimer = setTimeout(() => pollMeteoFrancePreloadProgress(jobKey), METEOFRANCE_PRELOAD_POLL_RUNNING_MS);
        } else {
          stopMeteoFrancePreloadPolling();
          const duration = formatMeteoFranceDuration(meteoFrancePreloadElapsedMs(data));
          const okCount = Number(data.ok_count || 0);
          const hourCount = Number(data.hour_count || (Array.isArray(data.hours) ? data.hours.length : 0));
          const unitCount = Number(data.unit_count || hourCount);
          const unitLabel = data.unit_label || (data.scope === 'national_day' ? 'champ(s)' : 'heure(s)');
          const failedCount = Number(data.failed_count || 0);
          const rangeCount = Number(data.total_range_request_count || 0);
          const packageCount = Number(data.package_request_count || 0);
          const cachedPackageCount = Number(data.cached_package_request_count || 0);
          const cachedRangeCount = Number(data.cached_total_range_request_count || 0);
          const nationalCacheCount = Number(data.national_field_cache_hit_count || 0);
          const decodedFieldCount = Number(data.decoded_field_count || 0);
          const isDayScope = data.scope === 'day';
          const isNationalScope = data.scope === 'national_day';
          const resultLabel = failedCount > 0 ? 'terminé partiellement' : 'terminé';
          const scopeLabel = isNationalScope ? 'France AROME' : (isDayScope ? 'journée AROME' : 'bloc AROME');
          const cacheText = cachedRangeCount > 0 ? `, ${cachedRangeCount} Range évités` : '';
          const packageText = packageCount > 0 ? `, ${packageCount} paquet(s) complet(s)` : '';
          const cachedPackageText = cachedPackageCount > 0 ? `, ${cachedPackageCount} paquet(s) cache` : '';
          const nationalText = isNationalScope ? `, ${decodedFieldCount} champ(s) décodé(s), ${nationalCacheCount} déjà en cache national` : '';
          const rainText = '';
          const failedUnits = Array.isArray(data.failed_units) ? data.failed_units.slice(0, 5) : [];
          const failedUnitLabel = (item) => {
            const prefix = `${String(Number(item?.hour || 0)).padStart(2, '0')}h ${item?.field || 'champ'}`;
            const message = String(item?.message || '').replace(/\s+/g, ' ').trim();
            return message ? `${prefix} (${message.slice(0, 76)}${message.length > 76 ? '…' : ''})` : prefix;
          };
          const failedUnitText = isNationalScope && failedUnits.length
            ? ` Échecs visibles : ${failedUnits.map(failedUnitLabel).join(', ')}${failedCount > failedUnits.length ? '…' : ''}.`
            : '';
          let statusMessage = `Préchargement ${scopeLabel} ${resultLabel} en ${duration} : ${okCount}/${unitCount} ${unitLabel}, ${rangeCount} Range API${packageText}${cachedPackageText}${cacheText}${nationalText}${rainText}.${failedUnitText}`;
          const cooldownSeconds = Number(data.quota_cooldown_seconds || 0);
          if (hasQuotaCooldown && isNationalScope && failedCount > 0 && okCount < unitCount && cooldownSeconds > 0) {
            scheduleMeteoFranceQuotaAutoResume(cooldownSeconds, meteoFranceQuotaCooldownSourceKey(data, data));
            statusMessage += ` Reprise automatique dans ${formatMeteoFranceCooldown(cooldownSeconds)}.`;
          }
          setMeteoFranceTestStatus(statusMessage, failedCount > 0 ? 'waiting' : 'ok');
          await refreshMeteoFranceGribCacheStatus({ force: true });
          let materializedFromNationalFields = false;
          if (isNationalScope && okCount > 0 && unitCount > 0) {
            materializedFromNationalFields = await materializeMeteoFranceGribFranceDayFromNationalCache({ quiet: true });
            if (materializedFromNationalFields) await refreshMeteoFranceGribCacheStatus({ force: true });
          }
          const loadedFromSlotCache = await maybeLoadCachedMeteoFranceGribForSelectedSlot({ quiet: true, force: true });
          const loadedFromNationalFields = false;
          if (loadedFromSlotCache || loadedFromNationalFields || materializedFromNationalFields) {
            const loadedHours = typeof aromeFranceLoadedSlotKeys === 'function' ? aromeFranceLoadedSlotKeys().size : 0;
            statusMessage += materializedFromNationalFields
              ? ` ${loadedHours}/24 grille(s) horaires prêtes côté navigateur.`
              : ` Grille ${String(selectedMeteoFranceHour()).padStart(2, '0')}h affichée depuis le cache France.`;
            setMeteoFranceTestStatus(statusMessage, failedCount > 0 ? 'waiting' : 'ok');
          }
          if (!hasQuotaCooldown && failedCount === 0) {
            cancelMeteoFranceQuotaAutoResume();
            clearMeteoFranceQuotaCooldownBadge();
          }
        }
      } catch (_) {
        if (mfPreloadActiveJobKey === jobKey) {
          mfPreloadPollTimer = setTimeout(() => pollMeteoFrancePreloadProgress(jobKey), METEOFRANCE_PRELOAD_POLL_ERROR_MS);
        }
      }
    }

    function trackMeteoFrancePreload(preload) {
      const progress = normalizeMeteoFrancePreloadProgress(preload);
      const jobKey = progress?.job_key || preload?.job_key;
      if (!jobKey && !preload?.scheduled && !preload?.already_running && !preload?.already_done && !progress?.hour_count) return;
      renderMeteoFrancePreloadProgress(progress || preload);
      if (!jobKey) return;
      mfPreloadActiveJobKey = jobKey;
      stopMeteoFrancePreloadPolling();
      if (preload?.scheduled || preload?.already_running || progress?.running) {
        mfPreloadPollTimer = setTimeout(() => pollMeteoFrancePreloadProgress(jobKey), METEOFRANCE_PRELOAD_POLL_START_MS);
      } else if (preload?.already_done) {
        mfPreloadPollTimer = setTimeout(() => pollMeteoFrancePreloadProgress(jobKey), METEOFRANCE_PRELOAD_POLL_START_MS);
      }
    }

    function setMeteoFranceButtonsDisabled(disabled) {
      if (mfGribFullPackageProbeBtn) mfGribFullPackageProbeBtn.disabled = disabled;
    }

    function readMeteoFranceApiKey() {
      return mfTokenInput?.value?.trim() || '';
    }

    function withMeteoFranceToken(body, token = readMeteoFranceApiKey()) {
      const cleanToken = String(token || '').trim();
      if (cleanToken) return { token: cleanToken, ...body };
      return body;
    }

    function loadStoredMeteoFranceApiKey() {
      try {
        return localStorage.getItem(METEOFRANCE_API_KEY_STORAGE_KEY) || '';
      } catch (_) {
        return '';
      }
    }

    function saveStoredMeteoFranceApiKey(value) {
      try {
        if (value) localStorage.setItem(METEOFRANCE_API_KEY_STORAGE_KEY, value);
        else localStorage.removeItem(METEOFRANCE_API_KEY_STORAGE_KEY);
      } catch (_) {}
    }

    function persistCurrentMeteoFranceApiKey() {
      saveStoredMeteoFranceApiKey(readMeteoFranceApiKey());
    }

    function initializeMeteoFranceApiKeyField() {
      if (!mfTokenInput) return;
      const stored = loadStoredMeteoFranceApiKey();
      if (!stored || mfTokenInput.value) return;
      mfTokenInput.value = stored;
      setMeteoFranceTestStatus('Clé API restaurée depuis ce navigateur. Tu peux actualiser AROME France.', '');
    }

    function addDaysIso(dateIso, days) {
      const base = new Date(`${normalizeDateIso(dateIso)}T12:00:00`);
      base.setDate(base.getDate() + days);
      return base.toISOString().slice(0, 10);
    }

    function getMeteoFranceWcsDateStatus(dateIso = selectedBaseDate, { allowPreviousDay = false } = {}) {
      const selected = normalizeDateIso(dateIso);
      const today = getTodayIsoDate();
      const minDate = allowPreviousDay ? addDaysIso(today, -1) : today;
      const maxDaysAhead = allowPreviousDay ? 2 : METEOFRANCE_WCS_MAX_DAYS_AHEAD;
      const maxDate = addDaysIso(today, maxDaysAhead);
      if (selected < minDate) {
        return {
          ok: false,
          message: allowPreviousDay
            ? `AROME GRIB France peut être tenté de la veille à J+2 (${minDate} à ${maxDate}). Sélection actuelle : ${selected}.`
            : `La grille AROME WCS directe couvre seulement l’horizon prévisionnel courant (${today} à ${maxDate}). Pour ${selected}, garde la source historique.`,
        };
      }
      if (selected > maxDate) {
        return {
          ok: false,
          message: allowPreviousDay
            ? `AROME GRIB France peut être tenté de la veille à J+2 (${minDate} à ${maxDate}). Sélection actuelle : ${selected}.`
            : `La grille AROME WCS directe est limitée à aujourd’hui et demain (${today} à ${maxDate}). Sélection actuelle : ${selected}.`,
        };
      }
      return { ok: true, today, minDate, maxDate };
    }

    function selectedMeteoFranceHour() {
      const match = String(selectedSlotKey || '').match(/^h(\d{2})$/);
      if (match) return Number(match[1]);
      return new Date().getHours();
    }

    function slotKeyForMeteoFranceHour(hour) {
      return `h${String(Number(hour) || 0).padStart(2, '0')}`;
    }

    function currentSlotUsesMeteoFranceGrib() {
      const cells = getCurrentSlot()?.cells || [];
      return cells.some((cell) => cell?.source_provider === 'meteofrance_arome_grib');
    }

    function currentLatestPayloadSignature() {
      return `${currentCenter.lat}|${currentCenter.lon}|${currentCenter.label}|${selectedBaseDate}`;
    }

    function currentMeteoFranceGribCacheStatusSignature() {
      return `france|${selectedBaseDate}|server-cache`;
    }

    function fitMapToCells(cells, { maxZoom = 6.4, duration = 900 } = {}) {
      if (!map || !Array.isArray(cells) || !cells.length) return;
      let north = -Infinity;
      let south = Infinity;
      let east = -Infinity;
      let west = Infinity;
      for (const cell of cells) {
        const lat = Number(cell?.lat);
        const lon = Number(cell?.lon);
        if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
        const halfH = Math.max(0, Number(cell?.cell_height_deg || 0) / 2);
        const halfW = Math.max(0, Number(cell?.cell_width_deg || 0) / 2);
        north = Math.max(north, lat + halfH);
        south = Math.min(south, lat - halfH);
        east = Math.max(east, lon + halfW);
        west = Math.min(west, lon - halfW);
      }
      if (![north, south, east, west].every(Number.isFinite)) return;
      try {
        map.fitBounds([[west, south], [east, north]], {
          padding: { top: 72, right: 56, bottom: 96, left: 56 },
          duration,
          maxZoom,
          essential: true,
        });
      } catch (_) {}
    }

    async function refreshMeteoFranceGribCacheStatus({ force = false } = {}) {
      const token = "";
      const dateStatus = getMeteoFranceWcsDateStatus(selectedBaseDate, { allowPreviousDay: true });
      if (!dateStatus.ok) {
        if (meteoFranceGribCachedSlotKeys.size) {
          meteoFranceGribCachedSlotKeys = new Set();
          renderSlotButtons();
        }
        meteoFranceGribCacheStatusSignature = "";
        return null;
      }
      const signature = currentMeteoFranceGribCacheStatusSignature();
      if (!force && signature === meteoFranceGribCacheStatusSignature) {
        hydrateMeteoFranceGribFranceDayFromCache({ force: false });
        return { ok: true, cached_slot_keys: Array.from(meteoFranceGribCachedSlotKeys || []) };
      }
      const fetchToken = ++meteoFranceGribCacheStatusFetchToken;
      const body = withMeteoFranceToken({
        lat: currentCenter.lat,
        lon: currentCenter.lon,
        label: currentCenter.label,
        date: selectedBaseDate,
        detail_level: "core",
      }, token);
      const endpoints = [
        "/api/meteofrance/grib-france-cache-status",
      ];
      try {
        for (const endpoint of endpoints) {
          const response = await fetch(endpoint, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body),
          });
          const data = await response.json().catch(() => ({}));
          if (fetchToken !== meteoFranceGribCacheStatusFetchToken) return null;
          if (!data?.ok) continue;
          const cachedKeys = Array.isArray(data.cached_slot_keys) ? data.cached_slot_keys : [];
          const availableKeys = Array.isArray(data.available_slot_keys) ? data.available_slot_keys : null;
          if (!cachedKeys.length && endpoint.includes("france") && !availableKeys) continue;
          meteoFranceGribCacheStatusSignature = signature;
          meteoFranceGribCachedSlotKeys = new Set(cachedKeys);
          meteoFranceGribAvailableSlotKeys = availableKeys ? new Set(availableKeys) : meteoFranceGribAvailableSlotKeys;
          if (typeof rememberMeteoFranceGribCacheStatus === 'function' && cachedKeys.length) rememberMeteoFranceGribCacheStatus(selectedBaseDate, cachedKeys);
          if (typeof rememberMeteoFranceGribAvailabilityStatus === 'function' && availableKeys) rememberMeteoFranceGribAvailabilityStatus(selectedBaseDate, availableKeys);
          if (!force) renderSlotButtons();
          const hydrationPromise = hydrateMeteoFranceGribFranceDayFromCache({ force });
          if (force) await hydrationPromise;
          renderSlotButtons();
          return data;
        }
        if (fetchToken === meteoFranceGribCacheStatusFetchToken) {
          meteoFranceGribCacheStatusSignature = signature;
          meteoFranceGribCachedSlotKeys = new Set();
          renderSlotButtons();
        }
        return null;
      } catch (_) {
        return null;
      }
    }


    function meteoFranceProviderInfo(provider) {
      if (provider === 'meteofrance_arome_grib') {
        return {
          provider: 'meteofrance_arome_grib',
          bucket: 'meteofrance_grib',
          label: 'Météo-France AROME GRIB cache',
        };
      }
      return {
        provider: 'meteofrance_arome_grib',
        bucket: 'meteofrance_grib',
        label: 'Météo-France AROME GRIB cache',
      };
    }

    function normalizeMeteoFranceSlot(slot, incomingMeta = {}) {
      const providerInfo = meteoFranceProviderInfo(incomingMeta.provider || incomingMeta.source_provider || 'meteofrance_arome_grib');
      return {
        ...slot,
        cells: Array.isArray(slot?.cells)
          ? slot.cells.map((cell) => ({
              ...cell,
              source_provider: cell?.source_provider || providerInfo.provider,
              source_label: cell?.source_label || incomingMeta.source_label || providerInfo.label,
            }))
          : [],
      };
    }

    function meteoFranceGribPayloadHasRequiredFields(slotPayload) {
      const meta = slotPayload?.meta || {};
      const provider = meta.provider || meta.source_provider || '';
      if (provider !== 'meteofrance_arome_grib') return true;
      const requiredFields = ['cape', 'precipitable_water', 'shortwave_radiation', 'precipitation_rate', 'relative_humidity_2m', 'wind_speed_10m', 'wind_direction_10m', 'temperature_2m', 'dew_point_2m', 'cloud_cover_low', 'cloud_cover_mid', 'cloud_cover_high', 'wind_gusts_10m'];
      const missing = Array.isArray(meta.missing_fields) ? meta.missing_fields.map(String) : [];
      if (requiredFields.some((field) => missing.includes(field))) return false;
      const requests = Array.isArray(meta.field_requests) ? meta.field_requests : [];
      if (!requests.length) return false;
      return requiredFields.every((field) => requests.some((item) => item?.field === field && item?.ok === true));
    }

    function mergeMeteoFranceDayPayload(dayPayload, allowedSlotKeys = null) {
      const incomingDays = Array.isArray(dayPayload?.days) ? dayPayload.days : [];
      const incomingDay = incomingDays.find((day) => day?.day_key === normalizeDateIso(selectedBaseDate)) || incomingDays[0];
      const incomingSlots = getRenderableSlots(incomingDay);
      if (!incomingDay || !incomingSlots.length) return 0;
      const allowed = allowedSlotKeys instanceof Set ? allowedSlotKeys : null;
      let merged = 0;
      for (const slot of incomingSlots) {
        const slotKey = String(slot?.slot_key || '');
        if (!/^h\d{2}$/.test(slotKey)) continue;
        if (allowed && !allowed.has(slotKey)) continue;
        const hour = Number(slotKey.slice(1));
        const slotPayload = {
          meta: dayPayload?.meta || {},
          days: [{ ...incomingDay, slots: [slot] }],
        };
        if (mergeMeteoFranceSlotPayload(slotPayload, hour)) merged += 1;
      }
      return merged;
    }

    function mergeMeteoFranceSlotPayload(slotPayload, hour) {
      if (!meteoFranceGribPayloadHasRequiredFields(slotPayload)) return false;
      const targetDayKey = normalizeDateIso(selectedBaseDate);
      const targetSlotKey = `h${String(hour).padStart(2, '0')}`;
      const incomingDays = Array.isArray(slotPayload?.days) ? slotPayload.days : [];
      const incomingDay = incomingDays.find((day) => day?.day_key === targetDayKey) || incomingDays[0];
      const incomingSlots = getRenderableSlots(incomingDay);
      const incomingSlot = incomingSlots.find((slot) => slot?.slot_key === targetSlotKey) || incomingSlots[0];
      if (!incomingDay || !incomingSlot) return false;

      if (!payload || !Array.isArray(payload.days)) {
        payload = slotPayload;
      }

      const incomingMeta = slotPayload?.meta || {};
      const providerInfo = meteoFranceProviderInfo(incomingMeta.provider || incomingMeta.source_provider || 'meteofrance_arome_grib');
      const nextSlot = normalizeMeteoFranceSlot(incomingSlot, incomingMeta);
      const targetPayload = payload;
      const days = Array.isArray(targetPayload.days) ? targetPayload.days : [];
      targetPayload.days = days;
      let targetDay = days.find((day) => day?.day_key === incomingDay.day_key);
      if (!targetDay) {
        targetDay = {
          day_key: incomingDay.day_key,
          day_label: incomingDay.day_label,
          day_index: incomingDay.day_index,
          slots: [],
        };
        days.push(targetDay);
      }
      if (!Array.isArray(targetDay.slots)) targetDay.slots = [];
      const existingIndex = targetDay.slots.findIndex((slot) => slot?.slot_key === nextSlot.slot_key);
      if (existingIndex >= 0) targetDay.slots.splice(existingIndex, 1, nextSlot);
      else targetDay.slots.push(nextSlot);
      targetDay.slots.sort((a, b) => String(a?.slot_key || '').localeCompare(String(b?.slot_key || '')));
      targetPayload.days.sort((a, b) => Number(a?.day_index || 0) - Number(b?.day_index || 0));
      if (providerInfo.provider === 'meteofrance_arome_grib' && typeof rememberAromeFranceDay === 'function') {
        rememberAromeFranceDay(targetDay);
      }

      const previousMeta = targetPayload.meta || {};
      const sourceBucket = providerInfo.bucket;
      const previousSourceMeta = previousMeta[sourceBucket] || {};
      const trackedSlots = new Set(Array.isArray(previousSourceMeta?.slots) ? previousSourceMeta.slots : []);
      trackedSlots.add(`${incomingDay.day_key}:${nextSlot.slot_key}`);
      const nextProvider = providerInfo.provider;
      const nextSourceLabel = providerInfo.label;
      targetPayload.meta = {
        ...previousMeta,
        provider: nextProvider,
        source_provider: nextProvider,
        source_label: nextSourceLabel,
        time_targets: incomingMeta.time_targets || previousMeta.time_targets,
        arome_run_reference_times: incomingMeta.arome_run_reference_times || previousMeta.arome_run_reference_times,
        arome_run_latest_reference_time: incomingMeta.arome_run_latest_reference_time || previousMeta.arome_run_latest_reference_time,
        arome_run_api_updated_at: incomingMeta.arome_run_api_updated_at || previousMeta.arome_run_api_updated_at,
        [sourceBucket]: {
          ...previousSourceMeta,
          provider: providerInfo.provider,
          source_label: incomingMeta.source_label || providerInfo.label,
          last_day_key: incomingDay.day_key,
          last_slot_key: nextSlot.slot_key,
          last_updated_at: new Date().toISOString(),
          slots: Array.from(trackedSlots).sort(),
          detail_level: incomingMeta.detail_level,
          coverage_request_count: incomingMeta.coverage_request_count,
          field_request_count: incomingMeta.field_request_count,
          total_range_request_count: incomingMeta.total_range_request_count,
          grid_scope: incomingMeta.grid_scope,
          france_grid: incomingMeta.france_grid,
          country_mask: incomingMeta.country_mask,
          france_grid_cell_count: incomingMeta.france_grid_cell_count,
          time_targets: incomingMeta.time_targets,
          arome_run_reference_times: incomingMeta.arome_run_reference_times,
          arome_run_latest_reference_time: incomingMeta.arome_run_latest_reference_time,
          arome_run_api_updated_at: incomingMeta.arome_run_api_updated_at,
          index_range_request_count: incomingMeta.index_range_request_count,
          message_range_request_count: incomingMeta.message_range_request_count,
          optional_missing_fields: incomingMeta.optional_missing_fields,
          skipped_optional_fields: incomingMeta.skipped_optional_fields,
          wind_direction_ready: incomingMeta.wind_direction_ready,
          warning: incomingMeta.warning,
        },
      };
      if (providerInfo.provider === 'meteofrance_arome_grib' && typeof rememberAromeFranceDay === 'function') {
        rememberAromeFranceDay(targetDay);
      }
      return true;
    }

    function aromeFranceLoadedSlotKeys() {
      const day = getCurrentDay();
      const slots = Array.isArray(day?.slots) ? day.slots : [];
      return new Set(slots
        .filter((slot) => Array.isArray(slot?.cells) && slot.cells.some((cell) => cell?.source_provider === 'meteofrance_arome_grib'))
        .map((slot) => slot.slot_key));
    }

    function meteoFranceCacheHydrationSignature() {
      const cacheKeys = Array.from(meteoFranceGribCachedSlotKeys || []).sort().join(',');
      return `france-hydrate|${normalizeDateIso(selectedBaseDate)}|server-cache|${cacheKeys}`;
    }

    function meteoFranceAllDaySlotKeys() {
      return Array.from({ length: 24 }, (_, hour) => `h${String(hour).padStart(2, '0')}`);
    }

    function queueAromeFranceGeojsonPrewarm(slots = null) {
      if (typeof buildSlotGeoJSON !== 'function') return;
      const sourceSlots = Array.isArray(slots)
        ? slots
        : (Array.isArray(getCurrentDay()?.slots) ? getCurrentDay().slots : []);
      const queue = sourceSlots.filter((slot) => Array.isArray(slot?.cells) && slot.cells.length > 0);
      if (!queue.length) return;
      if (mfAromeGeojsonPrewarmTimer) {
        if (typeof cancelIdleCallback === 'function') cancelIdleCallback(mfAromeGeojsonPrewarmTimer);
        else clearTimeout(mfAromeGeojsonPrewarmTimer);
        mfAromeGeojsonPrewarmTimer = null;
      }
      const run = (deadline = null) => {
        mfAromeGeojsonPrewarmTimer = null;
        const startedAt = performance.now();
        while (queue.length) {
          const slot = queue.shift();
          try { buildSlotGeoJSON(slot, slot.cells); } catch (_) {}
          const hasTime = deadline && typeof deadline.timeRemaining === 'function' ? deadline.timeRemaining() > 8 : (performance.now() - startedAt) < 18;
          if (!hasTime) break;
        }
        if (queue.length) {
          mfAromeGeojsonPrewarmTimer = typeof requestIdleCallback === 'function'
            ? requestIdleCallback(run, { timeout: 600 })
            : setTimeout(run, 40);
        }
      };
      mfAromeGeojsonPrewarmTimer = typeof requestIdleCallback === 'function'
        ? requestIdleCallback(run, { timeout: 600 })
        : setTimeout(run, 40);
    }

    async function hydrateMeteoFranceGribFranceDayFromCache({ force = false } = {}) {
      const token = "";
      const dateStatus = getMeteoFranceWcsDateStatus(selectedBaseDate, { allowPreviousDay: true });
      if (!dateStatus.ok) return false;
      const hydrateKey = meteoFranceCacheHydrationSignature();
      if (!force && mfFranceDayHydrationPromise && hydrateKey === mfFranceDayHydrationKey) return mfFranceDayHydrationPromise;

      const loaded = aromeFranceLoadedSlotKeys();
      const cacheKeys = Array.from(meteoFranceGribCachedSlotKeys || []).filter((key) => /^h\d{2}$/.test(String(key)));
      // Important: this hydrator is only for slot grids already materialized by
      // the server. Rebuilding from national field caches here makes blue AROME
      // badges linger and slows timeline navigation.
      const targetKeys = cacheKeys
        .filter((key, index, arr) => arr.indexOf(key) === index)
        .filter((key) => force || !loaded.has(key));
      if (!targetKeys.length) return true;

      const hydrationToken = ++mfFranceDayHydrationToken;
      const startDate = selectedBaseDate;
      const startCenterToken = centerChangeToken;
      mfFranceDayHydrationKey = hydrateKey;
      mfFranceDayHydrationPromise = (async () => {
        let mergedCount = 0;
        const fetchDayCache = async () => {
          const body = withMeteoFranceToken({
            lat: currentCenter.lat,
            lon: currentCenter.lon,
            label: currentCenter.label,
            date: startDate,
            detail_level: 'core',
            cache_only: true,
          }, token);
          try {
            const response = await fetch('/api/meteofrance/grib-france-day-cache', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify(body),
            });
            const data = await response.json().catch(() => ({}));
            if (hydrationToken !== mfFranceDayHydrationToken || startCenterToken !== centerChangeToken || selectedBaseDate !== startDate) return 0;
            syncMeteoFranceQuotaCooldown(data);
            if (!data?.ok || !data?.payload) return 0;
            const merged = mergeMeteoFranceDayPayload(data.payload, new Set(targetKeys));
            mergedCount += merged;
            return merged;
          } catch (_) {
            return 0;
          }
        };
        const fetchSlot = async (slotKey, endpoint) => {
          const hour = Number(String(slotKey).slice(1));
          const body = withMeteoFranceToken({
            lat: currentCenter.lat,
            lon: currentCenter.lon,
            label: currentCenter.label,
            date: startDate,
            hour,
            detail_level: 'core',
            cache_only: true,
          }, token);
          try {
            const response = await fetch(endpoint, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify(body),
            });
            const data = await response.json().catch(() => ({}));
            if (hydrationToken !== mfFranceDayHydrationToken || startCenterToken !== centerChangeToken || selectedBaseDate !== startDate) return false;
            syncMeteoFranceQuotaCooldown(data);
            if (!data?.ok || !data?.payload) return false;
            if (!mergeMeteoFranceSlotPayload(data.payload, hour)) return false;
            mergedCount += 1;
            return true;
          } catch (_) {
            return false;
          }
        };
        const runHydrationBatch = async (keys, endpoint, maxWorkers) => {
          let cursor = 0;
          const workerCount = Math.min(maxWorkers, keys.length);
          if (!workerCount) return;
          const runWorker = async () => {
            while (cursor < keys.length) {
              const slotKey = keys[cursor];
              cursor += 1;
              await fetchSlot(slotKey, endpoint);
            }
          };
          await Promise.all(Array.from({ length: workerCount }, runWorker));
        };

        await fetchDayCache();
        const stillMissingKeys = targetKeys.filter((key) => !aromeFranceLoadedSlotKeys().has(key));
        if (stillMissingKeys.length) {
          await runHydrationBatch(stillMissingKeys, '/api/meteofrance/grib-france-slot-grid-cache', 4);
        }

        // Migration paquet complet : le front ne matérialise plus les heures manquantes une par une.
        // Les slots apparaissent uniquement quand le serveur les a produits depuis les paquets complets.
        if (hydrationToken === mfFranceDayHydrationToken && startCenterToken === centerChangeToken && selectedBaseDate === startDate) {
          lastFetchSignature = typeof currentAromeFrancePayloadSignature === 'function' ? currentAromeFrancePayloadSignature(startDate) : lastFetchSignature;
          renderDayButtons();
          renderSlotButtons();
          if (mergedCount > 0 && typeof updateMetaLine === 'function') updateMetaLine();
          if (currentSlotUsesMeteoFranceGrib()) {
            shouldAnimateNextGrid = false;
            scheduleLoadedGridSync(centerChangeToken, selectedDayKey, selectedSlotKey);
          }
          if (typeof maybePrecomputePredictionPageImage === 'function') maybePrecomputePredictionPageImage();
        }
        return mergedCount > 0;
      })();
      try {
        return await mfFranceDayHydrationPromise;
      } finally {
        if (hydrateKey === mfFranceDayHydrationKey) mfFranceDayHydrationPromise = null;
      }
    }

    async function materializeMeteoFranceGribFranceDayFromNationalCache({ force = false, quiet = true } = {}) {
      const token = "";
      const dateStatus = getMeteoFranceWcsDateStatus(selectedBaseDate, { allowPreviousDay: true });
      if (!dateStatus.ok) return false;
      const startDate = selectedBaseDate;
      const materializeKey = `france-materialize|${normalizeDateIso(startDate)}|server-cache`;
      if (!force && mfFranceDayMaterializePromise && mfFranceDayMaterializeKey === materializeKey) return mfFranceDayMaterializePromise;

      const loaded = aromeFranceLoadedSlotKeys();
      const selectedKey = /^h\d{2}$/.test(String(selectedSlotKey || '')) ? selectedSlotKey : null;
      const selectableKeys = typeof getSelectableSlots === 'function'
        ? getSelectableSlots(getCurrentDay()).map((slot) => slot?.slot_key).filter((key) => /^h\d{2}$/.test(String(key)))
        : [];
      const allKeys = selectableKeys.length ? selectableKeys : meteoFranceAllDaySlotKeys();
      const orderedKeys = selectedKey && allKeys.includes(selectedKey)
        ? [selectedKey, ...allKeys.filter((key) => key !== selectedKey)]
        : allKeys;
      const targetKeys = orderedKeys.filter((key) => force || !loaded.has(key));
      if (!targetKeys.length) {
        queueAromeFranceGeojsonPrewarm();
        if (typeof maybePrecomputePredictionPageImage === 'function') maybePrecomputePredictionPageImage();
        return true;
      }

      const materializeToken = ++mfFranceDayMaterializeToken;
      const startCenterToken = centerChangeToken;
      mfFranceDayMaterializeKey = materializeKey;
      mfFranceDayMaterializePromise = (async () => {
        let mergedCount = 0;
        let failedCount = 0;
        const fetchSlot = async (slotKey, endpoint) => {
          const hour = Number(String(slotKey).slice(1));
          const body = withMeteoFranceToken({
            lat: currentCenter.lat,
            lon: currentCenter.lon,
            label: currentCenter.label,
            date: startDate,
            hour,
            detail_level: 'core',
            cache_only: true,
          }, token);
          try {
            const response = await fetch(endpoint, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify(body),
            });
            const data = await response.json().catch(() => ({}));
            if (materializeToken !== mfFranceDayMaterializeToken || startCenterToken !== centerChangeToken || selectedBaseDate !== startDate) return false;
            syncMeteoFranceQuotaCooldown(data);
            if (!data?.ok || !data?.payload) {
              failedCount += 1;
              return false;
            }
            if (!mergeMeteoFranceSlotPayload(data.payload, hour)) {
              failedCount += 1;
              return false;
            }
            meteoFranceGribCachedSlotKeys.add(slotKey);
            mergedCount += 1;
            if (slotKey === selectedSlotKey) {
              shouldAnimateNextGrid = false;
              scheduleLoadedGridSync(centerChangeToken, selectedDayKey, selectedSlotKey);
            }
            return true;
          } catch (_) {
            failedCount += 1;
            return false;
          }
        };
        const runHydrationBatch = async (keys, endpoint, maxWorkers) => {
          let cursor = 0;
          const workerCount = Math.min(maxWorkers, keys.length);
          if (!workerCount) return;
          const runWorker = async () => {
            while (cursor < keys.length) {
              const slotKey = keys[cursor];
              cursor += 1;
              await fetchSlot(slotKey, endpoint);
            }
          };
          await Promise.all(Array.from({ length: workerCount }, runWorker));
        };

        await runHydrationBatch(targetKeys, '/api/meteofrance/grib-france-slot-grid-cache', 8);
        const stillMissingKeys = targetKeys.filter((key) => !aromeFranceLoadedSlotKeys().has(key));
        if (stillMissingKeys.length) failedCount += stillMissingKeys.length;
        if (materializeToken === mfFranceDayMaterializeToken && startCenterToken === centerChangeToken && selectedBaseDate === startDate) {
          const cachedKeys = Array.from(meteoFranceGribCachedSlotKeys || []);
          if (typeof rememberMeteoFranceGribCacheStatus === 'function') rememberMeteoFranceGribCacheStatus(startDate, cachedKeys);
          lastFetchSignature = typeof currentAromeFrancePayloadSignature === 'function' ? currentAromeFrancePayloadSignature(startDate) : lastFetchSignature;
          renderDayButtons();
          renderSlotButtons();
          if (mergedCount > 0 && typeof updateMetaLine === 'function') updateMetaLine();
          queueAromeFranceGeojsonPrewarm();
          if (typeof maybePrecomputePredictionPageImage === 'function') maybePrecomputePredictionPageImage();
          if (currentSlotUsesMeteoFranceGrib()) {
            shouldAnimateNextGrid = false;
            scheduleLoadedGridSync(centerChangeToken, selectedDayKey, selectedSlotKey);
          }
          if (!quiet && typeof setMeteoFranceTestStatus === 'function') {
            const totalLoaded = aromeFranceLoadedSlotKeys().size;
            const failedText = failedCount ? `, ${failedCount} heure(s) encore absente(s) du cache national` : '';
            setMeteoFranceTestStatus(`Grilles horaires France AROME matérialisées : ${totalLoaded}/24 prêtes côté navigateur${failedText}.`, failedCount ? 'waiting' : 'ok');
          }
        }
        return mergedCount > 0;
      })();
      try {
        return await mfFranceDayMaterializePromise;
      } finally {
        if (mfFranceDayMaterializeKey === materializeKey) mfFranceDayMaterializePromise = null;
      }
    }

    async function maybeLoadCachedMeteoFranceGribForSelectedSlot({ quiet = true, force = false, buildFromNationalCache = true } = {}) {
      const token = "";
      const dateStatus = getMeteoFranceWcsDateStatus(selectedBaseDate, { allowPreviousDay: true });
      if (!dateStatus.ok) return false;
      const hour = selectedMeteoFranceHour();
      const slotKey = slotKeyForMeteoFranceHour(hour);
      if (selectedSlotKey !== slotKey) return false;
      const currentDay = getCurrentDay();
      const currentSlot = currentDay?.slots?.find((slot) => slot?.slot_key === slotKey);
      if (currentSlot && typeof isMeteoFranceSlotUnavailable === 'function' && isMeteoFranceSlotUnavailable(currentSlot, currentDay)) return false;
      if (!force && currentSlotUsesMeteoFranceGrib()) return false;

      const requestToken = ++mfCachedGribFetchToken;
      const startCenterToken = centerChangeToken;
      const startDate = selectedBaseDate;
      const startCenter = { ...currentCenter };
      const body = withMeteoFranceToken({
        lat: startCenter.lat,
        lon: startCenter.lon,
        label: startCenter.label,
        date: startDate,
        hour,
        detail_level: 'core',
      }, token);
      const candidates = [
        { endpoint: '/api/meteofrance/grib-france-slot-grid-cache', france: true },
      ];

      for (const candidate of candidates) {
        try {
          const response = await fetch(candidate.endpoint, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
          });
          const data = await response.json().catch(() => ({}));
          if (requestToken !== mfCachedGribFetchToken || startCenterToken !== centerChangeToken || selectedBaseDate !== startDate || selectedSlotKey !== slotKey) {
            return false;
          }
          if (!data?.ok || !data?.payload) continue;
          if (!mergeMeteoFranceSlotPayload(data.payload, hour)) continue;

          lastFetchSignature = typeof currentAromeFrancePayloadSignature === 'function' ? currentAromeFrancePayloadSignature(startDate) : currentLatestPayloadSignature();
          shouldAnimateNextGrid = !quiet;
          lastFetchAt = Date.now();
          updateMetaLine();
          renderDayButtons();
          renderSlotButtons();
          scheduleLoadedGridSync(centerChangeToken, selectedDayKey, selectedSlotKey);
          const cells = getCurrentSlot()?.cells || [];
          const isFranceGrid = candidate.france || data.payload?.meta?.grid_scope === 'france' || data.payload?.meta?.france_grid;
          if (isFranceGrid) fitMapToCells(cells, { maxZoom: 6.2, duration: quiet ? 0 : 750 });
          if (!quiet) {
            const cellCount = Number(cells.length || 0);
            const scopeLabel = isFranceGrid ? 'France AROME GRIB' : 'AROME GRIB';
            setMeteoFranceTestStatus('Grille ' + scopeLabel + ' chargée automatiquement depuis le cache pour ' + String(hour).padStart(2, '0') + 'h : ' + cellCount + ' cellules, 0 Range API.', 'ok');
          }
          return true;
        } catch (_) {
          continue;
        }
      }
      if (buildFromNationalCache && !quiet && typeof setMeteoFranceTestStatus === 'function') {
        setMeteoFranceTestStatus('Heure absente du cache France matérialisé : attente du préchargement serveur par paquets complets.', 'waiting');
      }
      return false;
    }


    async function buildMeteoFranceGribFranceGridForSelectedSlot({ quiet = true } = {}) {
      if (!quiet && typeof setMeteoFranceTestStatus === 'function') {
        setMeteoFranceTestStatus('Matérialisation horaire directe désactivée : attente du préchargement serveur par paquets complets.', 'waiting');
      }
      return false;
    }


    async function preloadMeteoFranceGribNationalDay({ fromAutoResume = false } = {}) {
      if (!fromAutoResume) cancelMeteoFranceQuotaAutoResume();
      const token = readMeteoFranceApiKey();
      if (!token) {
        setMeteoFranceTestStatus('Colle une clé API Météo-France avant de précharger la France AROME.', 'error');
        return;
      }
      const dateStatus = getMeteoFranceWcsDateStatus(selectedBaseDate, { allowPreviousDay: true });
      if (!dateStatus.ok) {
        setMeteoFranceTestStatus(dateStatus.message.replace('WCS', 'GRIB'), 'error');
        return;
      }
      const localCooldownSeconds = meteoFranceQuotaCooldownRemainingSeconds();
      if (!fromAutoResume && localCooldownSeconds > 1) {
        const sourceKey = mfQuotaCooldownSourceKey || `local|${selectedBaseDate}|quota`;
        scheduleMeteoFranceQuotaAutoResume(localCooldownSeconds, sourceKey);
        renderMeteoFrancePreloadProgress({
          running: false,
          scope: 'national_day',
          title: 'Préchargement France suspendu',
          detail: 'Cooldown quota actif côté navigateur',
          unit_count: 72,
          completed_count: 0,
          ok_count: 0,
          failed_count: 0,
          quota_cooldown_seconds: localCooldownSeconds,
        });
        setMeteoFranceTestStatus(`Cooldown quota AROME actif : aucun nouvel appel de préchargement lancé. Reprise automatique dans ${formatMeteoFranceCooldown(localCooldownSeconds)}.`, 'waiting');
        return;
      }
      persistCurrentMeteoFranceApiKey();
      const hour = selectedMeteoFranceHour();
      const detailLevel = 'core';
      const preloadStartedAtMs = Date.now();
      mfPreloadClientStartedAtMs = preloadStartedAtMs;
      setMeteoFranceButtonsDisabled(true);
      setMeteoFranceTestStatus(`Préchargement France AROME demandé pour ${selectedBaseDate}…`, 'waiting');
      renderMeteoFrancePreloadProgress({
        running: true,
        indeterminate: true,
        scope: 'national_day',
        title: 'Préchargement France AROME',
        detail: '24 heures · champs nationaux · préparation du job serveur',
        current_hour: 0,
        client_started_at_ms: preloadStartedAtMs,
      });
      try {
        const response = await fetch('/api/meteofrance/grib-preload-national-day', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            token,
            lat: currentCenter.lat,
            lon: currentCenter.lon,
            label: currentCenter.label,
            date: selectedBaseDate,
            hour,
            detail_level: detailLevel,
            scope: 'day',
            max_hours: 24,
          }),
        });
        const data = await response.json().catch(() => ({}));
        if (!response.ok || (!data?.job_key && !data?.already_done)) {
          setMeteoFranceTestStatus(data?.message || `Préchargement France AROME impossible (HTTP ${response.status}).`, 'error');
          renderMeteoFrancePreloadProgress(null);
          return;
        }
        const hasQuotaCooldown = syncMeteoFranceQuotaCooldown(data);
        if (!hasQuotaCooldown && (data.scheduled || data.already_running || data.already_done)) {
          clearMeteoFranceQuotaCooldownBadge();
        }
        if (data.scheduled) mfPreloadClientStartedAtMs = preloadStartedAtMs;
        else mfPreloadClientStartedAtMs = 0;
        trackMeteoFrancePreload(data);
        const unitCount = Number(data.unit_count || 0);
        const cooldownSeconds = Number(data.quota_cooldown_seconds || 0);
        if (data.quota_cooldown && cooldownSeconds > 0 && !data.scheduled && !data.already_running && !data.already_done) {
          const cooldownMinutes = Math.max(1, Math.ceil(cooldownSeconds / 60));
          const progress = normalizeMeteoFrancePreloadProgress(data);
          const okCount = Number(progress?.ok_count || 0);
          const progressText = okCount > 0 ? ` Progression conservée : ${okCount}/${progress?.unit_count || unitCount || 72} champ(s).` : '';
          scheduleMeteoFranceQuotaAutoResume(cooldownSeconds, meteoFranceQuotaCooldownSourceKey(data, progress));
          setMeteoFranceTestStatus(`${data.message || `Quota Météo-France atteint : nouvel essai possible dans ${cooldownMinutes} min.`}${progressText} Reprise automatique dans ${formatMeteoFranceCooldown(cooldownSeconds)}.`, 'waiting');
        } else if (data.scheduled) {
          setMeteoFranceTestStatus(`Préchargement France AROME lancé en arrière-plan : ${unitCount || 192} champ(s).`, 'waiting');
        } else if (data.already_running) {
          setMeteoFranceTestStatus(`Préchargement France AROME déjà en cours : ${unitCount || 192} champ(s).`, 'waiting');
        } else if (data.already_done) {
          cancelMeteoFranceQuotaAutoResume();
          clearMeteoFranceQuotaCooldownBadge();
          setMeteoFranceTestStatus(`Préchargement France AROME déjà terminé : ${data.ok_count || 0}/${data.unit_count || unitCount || 192} champ(s).`, 'ok');
        }
      } catch (error) {
        setMeteoFranceTestStatus(`Erreur pendant le lancement du préchargement France AROME : ${error?.message || error}`, 'error');
        renderMeteoFrancePreloadProgress(null);
      } finally {
        setMeteoFranceButtonsDisabled(false);
      }
    }


    function setupPrimaryControls() {
      toggleSearchBtn.addEventListener('click', (event) => {
        event.preventDefault();
        event.stopPropagation();
        const shouldOpen = !topbar.classList.contains('show-search');
        closeTopPanels();
        if (cityInput) {
          cityInput.value = '';
          cityInput.placeholder = 'Tape une ville, un secteur ou un point de départ…';
        }
        if (shouldOpen) {
          topbar.classList.add('show-search');
          requestAnimationFrame(() => cityInput?.focus({ preventScroll: true }));
        }
        requestAnimationFrame(alignTopPanels);
      });
      closeSelectionBtn?.addEventListener('click', closeSelection);
      openDetailsBtn?.addEventListener('click', openDetails);
      recenterBtn?.addEventListener('click', () => {
        if (!selectedFeature) return;
        map.easeTo({ center: [Number(selectedFeature.lon), Number(selectedFeature.lat)], duration: 700, zoom: Math.max(map.getZoom(), 10.2) });
      });
      closeDetailsBtn?.addEventListener('click', closeDetails);
      modalBackdrop?.addEventListener('click', closeDetails);
      infoDrawerBtn?.addEventListener('click', () => infoDrawer.classList.contains('visible') ? closeInfoDrawer() : openInfoDrawer());
      closeDrawerBtn?.addEventListener('click', closeInfoDrawer);
      drawerBackdrop?.addEventListener('click', closeInfoDrawer);
      initializeMeteoFranceApiKeyField();
      if (typeof probeMeteoFranceGribFullPackage === 'function') {
        mfGribFullPackageProbeBtn?.addEventListener('click', probeMeteoFranceGribFullPackage);
      } else if (mfGribFullPackageProbeBtn) {
        mfGribFullPackageProbeBtn.hidden = true;
      }
      mfTokenInput?.addEventListener('input', persistCurrentMeteoFranceApiKey);
      locateBtn?.addEventListener('click', locateUser);
      bestCellsBtn?.addEventListener('click', toggleBestCellsMode);
      exportGifBtn?.addEventListener('click', toggleExportFormatMenu);
      predictionPageBtn?.addEventListener('click', () => {
        if (typeof openPredictionPage === 'function') openPredictionPage();
      });
      predictionPageCloseBtn?.addEventListener('click', () => {
        if (typeof closePredictionPage === 'function') closePredictionPage();
      });
      if (typeof aroundMeBtn !== 'undefined' && aroundMeBtn) aroundMeBtn.addEventListener('click', locateUser);
      searchCityBtn?.addEventListener('click', handleCitySearch);
      cityInput?.addEventListener('keydown', (event) => { if (event.key === 'Enter') handleCitySearch(); });
      document.addEventListener('click', (event) => {
        if (!topbar.contains(event.target)) closeTopPanels();
        if (exportFormatMenu?.classList.contains('visible')) {
          const target = event.target;
          if (!exportFormatMenu.contains(target) && !exportGifBtn?.contains(target)) closeExportFormatMenu();
        }
      });
      window.addEventListener('resize', closeExportFormatMenu);
      window.addEventListener('orientationchange', closeExportFormatMenu);


      if (todayBtn) {
        todayBtn.addEventListener('click', () => applySelectedDate(getTodayIsoDate(), { force: true, loadingMessage: 'Chargement de la date du jour…' }));
      }
      playTimelineBtn?.addEventListener('click', (event) => {
        event.preventDefault();
        event.stopPropagation();
        if (typeof toggleTimelinePlayback === 'function') toggleTimelinePlayback();
      });
      if (dateInput) {
        dateInput.addEventListener('change', (event) => {
          const nextDate = normalizeDateIso(event.target?.value);
          applySelectedDate(nextDate, { force: true, loadingMessage: 'Chargement de la date…' });
        });
      }
      if (prevDayBtn) {
        prevDayBtn.addEventListener('click', () => {
          shiftSelectedDate(-1, 'Chargement du jour précédent…');
        });
      }
      if (nextDayBtn) {
        nextDayBtn.addEventListener('click', () => {
          shiftSelectedDate(1, 'Chargement du jour suivant…');
        });
      }

      setupSlotButtonsDrag();
      setupMetricInfoTriggers();
      setupTimelineToggle();
      setupBottomUiLayoutSync();

      installChip?.addEventListener('click', installApp);
    }
