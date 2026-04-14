function ensureSource(id, data) {
      if (map.getSource(id)) map.getSource(id).setData(data);
      else map.addSource(id, { type: 'geojson', data });
    }


    function hideGridCornerMask() {
      activeGridMaskCells = [];
      if (!gridCornerMask) return;
      gridCornerMask.classList.remove('visible');
      gridCornerMask.style.width = '0px';
      gridCornerMask.style.height = '0px';
    }

    function projectGridEnvelopeBounds(cells) {
      const template = deriveGridTemplate(cells);
      if (!template || !Array.isArray(cells) || !cells.length || !map) return null;
      const lats = cells.map((cell) => Number(cell.lat)).filter(Number.isFinite);
      const lons = cells.map((cell) => Number(cell.lon)).filter(Number.isFinite);
      if (!lats.length || !lons.length) return null;
      const halfH = Number(template.cellHeightDeg || 0) / 2;
      const halfW = Number(template.cellWidthDeg || 0) / 2;
      const north = Math.max(...lats) + halfH;
      const south = Math.min(...lats) - halfH;
      const east = Math.max(...lons) + halfW;
      const west = Math.min(...lons) - halfW;
      const nw = map.project([west, north]);
      const se = map.project([east, south]);
      const left = Math.min(nw.x, se.x);
      const top = Math.min(nw.y, se.y);
      const width = Math.abs(se.x - nw.x);
      const height = Math.abs(se.y - nw.y);
      if (!Number.isFinite(left + top + width + height) || width < 20 || height < 20) return null;
      return { left, top, width, height };
    }

    function updateGridCornerMask(cells = activeGridMaskCells) {
      if (!gridCornerMask || !Array.isArray(cells) || !cells.length) {
        hideGridCornerMask();
        return;
      }
      const bounds = projectGridEnvelopeBounds(cells);
      if (!bounds) {
        hideGridCornerMask();
        return;
      }
      activeGridMaskCells = cells;
      const radius = Math.max(10, Math.min(28, Math.round(Math.min(bounds.width, bounds.height) * 0.085)));
      gridCornerMask.style.left = `${Math.round(bounds.left)}px`;
      gridCornerMask.style.top = `${Math.round(bounds.top)}px`;
      gridCornerMask.style.width = `${Math.round(bounds.width)}px`;
      gridCornerMask.style.height = `${Math.round(bounds.height)}px`;
      gridCornerMask.style.setProperty('--grid-mask-radius', `${radius}px`);
      gridCornerMask.classList.add('visible');
    }


    function buildGridOutlineGeoJSON(cells) {
      const template = deriveGridTemplate(cells);
      if (!template) return { type: 'FeatureCollection', features: [] };
      const lats = cells.map(cell => Number(cell.lat)).filter(Number.isFinite);
      const lons = cells.map(cell => Number(cell.lon)).filter(Number.isFinite);
      if (!lats.length || !lons.length) return { type: 'FeatureCollection', features: [] };
      const halfH = template.cellHeightDeg / 2;
      const halfW = template.cellWidthDeg / 2;
      const north = Math.max(...lats) + halfH;
      const south = Math.min(...lats) - halfH;
      const east = Math.max(...lons) + halfW;
      const west = Math.min(...lons) - halfW;
      return {
        type: 'FeatureCollection',
        features: [{
          type: 'Feature',
          properties: {},
          geometry: {
            type: 'Polygon',
            coordinates: [[[west, south], [east, south], [east, north], [west, north], [west, south]]],
          },
        }],
      };
    }

    function removeLoaderLayers() {
      clearGridRevealFailsafe();
      gridAnimationToken += 1;
      stopLoaderPulse();
      if (map.getLayer('grid-loader-fill')) map.removeLayer('grid-loader-fill');
      if (map.getLayer('grid-loader-outline')) map.removeLayer('grid-loader-outline');
      if (map.getSource('grid-loader')) map.removeSource('grid-loader');
      if (!getCurrentSlot()?.cells?.length) hideGridCornerMask();
    }

    function showLoadingGrid(center) {
      if (!map.isStyleLoaded()) return;
      removeLoaderLayers();
      const cells = buildLoaderCells(center);
      ensureSource('grid-loader', buildLoaderGeoJSON(cells, 0));
      updateGridCornerMask(cells);
      map.addLayer({
        id: 'grid-loader-fill',
        type: 'fill',
        source: 'grid-loader',
        paint: {
          'fill-color': '#7dd3fc',
          'fill-opacity': ['get', 'fill_opacity'],
        }
      });
      map.addLayer({
        id: 'grid-loader-outline',
        type: 'line',
        source: 'grid-loader',
        paint: {
          'line-color': 'rgba(255,255,255,0.22)',
          'line-width': 1.1,
          'line-opacity': 0.4,
        },
        layout: {
          'line-join': 'round',
          'line-cap': 'round',
        }
      });
      startLoaderPulse();
    }

    function removeLayers(keepLoader = false) {
      clearGridRevealFailsafe();
      gridAnimationToken += 1;
      removeLoaderLayers();
      if (map.getLayer('grid-highlight')) map.removeLayer('grid-highlight');
      if (map.getLayer('grid-outline')) map.removeLayer('grid-outline');
      if (map.getSource('grid-outline')) map.removeSource('grid-outline');
      if (map.getLayer('grid-borders')) map.removeLayer('grid-borders');
      if (map.getLayer('grid-fill')) map.removeLayer('grid-fill');
      if (map.getSource('grid')) map.removeSource('grid');
      hideGridCornerMask();
      map.off('click', 'grid-fill', onGridClick);
      map.off('mouseenter', 'grid-fill', onGridEnter);
      map.off('mouseleave', 'grid-fill', onGridLeave);
    }

    function addLayers(data, cells = []) {
      ensureSource('grid', data);
      ensureSource('grid-outline', buildGridOutlineGeoJSON(cells));
      map.addLayer({
        id: 'grid-fill',
        type: 'fill',
        source: 'grid',
        paint: {
          'fill-color': ['get', 'fill_color'],
          'fill-opacity': ['*', ['get', 'fill_opacity'], 0],
          'fill-antialias': false
        }
      });
      map.addLayer({
        id: 'grid-borders',
        type: 'line',
        source: 'grid',
        paint: {
          'line-color': '#ffffff',
          'line-width': isCoarsePointerDevice() ? 0.75 : 1,
          'line-opacity': showGridLines ? (isCoarsePointerDevice() ? 0.32 : 0.5) : 0,
        }
      });
      map.addLayer({
        id: 'grid-outline',
        type: 'line',
        source: 'grid-outline',
        paint: {
          'line-color': '#ffffff',
          'line-width': isCoarsePointerDevice() ? 1.6 : 1.85,
          'line-opacity': showGridLines ? 0.7 : 0.42,
        },
        layout: {
          'line-join': 'round',
          'line-cap': 'round',
        }
      });
      map.addLayer({
        id: 'grid-highlight',
        type: 'line',
        source: 'grid',
        paint: {
          'line-color': '#ffffff',
          'line-width': 2.2,
          'line-opacity': ['case', ['==', ['get', 'zone'], selectedFeature?.zone || ''], 1, 0],
        }
      });

      map.on('click', 'grid-fill', onGridClick);
      if (!isCoarsePointerDevice()) {
        map.on('mouseenter', 'grid-fill', onGridEnter);
        map.on('mouseleave', 'grid-fill', onGridLeave);
      }
      updateGridCornerMask(cells);
      animateGridFillFactor(0, 1, 260, () => { applyGridLinesVisibility(); updateHighlight(); updateGridCornerMask(cells); });
    }

    function onGridEnter() {
      map.getCanvas().style.cursor = 'pointer';
    }

    function onGridLeave() {
      map.getCanvas().style.cursor = '';
    }

    function onGridClick(e) {
      const p = e.features?.[0]?.properties;
      if (!p) return;
      selectedFeature = p;
      showSelection(p);
      updateHighlight();
    }

    function updateHighlight() {
      if (!map.getLayer('grid-highlight')) return;
      map.setPaintProperty('grid-highlight', 'line-opacity', ['case', ['==', ['get', 'zone'], selectedFeature?.zone || ''], 1, 0]);
    }
