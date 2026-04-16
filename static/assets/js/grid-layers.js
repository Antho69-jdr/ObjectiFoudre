    const EMPTY_FEATURE_COLLECTION = { type: 'FeatureCollection', features: [] };
    let gridHandlersBound = false;

    function ensureSource(id, data) {
      if (map.getSource(id)) {
        map.getSource(id).setData(data);
      } else {
        map.addSource(id, { type: 'geojson', data });
      }
    }

    function buildGridOutlineGeoJSON(cells) {
      if (!Array.isArray(cells) || !cells.length) return EMPTY_FEATURE_COLLECTION;
      const edges = cells.map((cell) => {
        const lat = Number(cell.lat || 0);
        const lon = Number(cell.lon || 0);
        const halfH = Number(cell.cell_height_deg || 0) / 2;
        const halfW = Number(cell.cell_width_deg || 0) / 2;
        return {
          north: lat + halfH,
          south: lat - halfH,
          east: lon + halfW,
          west: lon - halfW,
        };
      });
      const north = Math.max(...edges.map((edge) => edge.north));
      const south = Math.min(...edges.map((edge) => edge.south));
      const east = Math.max(...edges.map((edge) => edge.east));
      const west = Math.min(...edges.map((edge) => edge.west));
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

    function bindGridHandlersOnce() {
      if (gridHandlersBound) return;
      gridHandlersBound = true;
      map.on('click', 'grid-fill', onGridClick);
      if (!isCoarsePointerDevice()) {
        map.on('mouseenter', 'grid-fill', onGridEnter);
        map.on('mouseleave', 'grid-fill', onGridLeave);
      }
    }

    function ensureGridScaffolding() {
      if (!map.isStyleLoaded()) return;
      ensureSource('grid', EMPTY_FEATURE_COLLECTION);
      ensureSource('grid-outline', EMPTY_FEATURE_COLLECTION);
      if (!map.getLayer('grid-fill')) {
        map.addLayer({
          id: 'grid-fill',
          type: 'fill',
          source: 'grid',
          paint: {
            'fill-color': ['get', 'fill_color'],
            'fill-opacity': ['*', ['get', 'fill_opacity'], 0],
            'fill-antialias': false,
          },
        });
      }
      if (!map.getLayer('grid-borders')) {
        map.addLayer({
          id: 'grid-borders',
          type: 'line',
          source: 'grid',
          paint: {
            'line-color': '#ffffff',
            'line-width': isCoarsePointerDevice() ? 0.75 : 1,
            'line-opacity': 0,
          },
        });
      }
      if (!map.getLayer('grid-outline')) {
        map.addLayer({
          id: 'grid-outline',
          type: 'line',
          source: 'grid-outline',
          paint: {
            'line-color': '#ffffff',
            'line-width': isCoarsePointerDevice() ? 1.6 : 1.85,
            'line-opacity': 0,
          },
          layout: {
            'line-join': 'round',
            'line-cap': 'round',
          },
        });
      }
      if (!map.getLayer('grid-highlight')) {
        map.addLayer({
          id: 'grid-highlight',
          type: 'line',
          source: 'grid',
          paint: {
            'line-color': '#ffffff',
            'line-width': 2.2,
            'line-opacity': 0,
          },
        });
      }
      bindGridHandlersOnce();
    }

    function ensureLoaderScaffolding() {
      if (!map.isStyleLoaded()) return;
      ensureSource('grid-loader', EMPTY_FEATURE_COLLECTION);
      if (!map.getLayer('grid-loader-fill')) {
        map.addLayer({
          id: 'grid-loader-fill',
          type: 'fill',
          source: 'grid-loader',
          paint: {
            'fill-color': '#7dd3fc',
            'fill-opacity': ['get', 'fill_opacity'],
          },
        });
      }
      if (!map.getLayer('grid-loader-outline')) {
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
          },
        });
      }
    }

    function removeLoaderLayers() {
      clearGridRevealFailsafe();
      gridAnimationToken += 1;
      stopLoaderPulse();
      if (map.getSource('grid-loader')) {
        map.getSource('grid-loader').setData(EMPTY_FEATURE_COLLECTION);
      }
    }

    function showLoadingGrid(center) {
      if (!map.isStyleLoaded()) return;
      ensureLoaderScaffolding();
      const cells = buildLoaderCells(center);
      map.getSource('grid-loader').setData(buildLoaderGeoJSON(cells, 0));
      startLoaderPulse();
    }

    function clearGridLayers() {
      ensureGridScaffolding();
      map.getSource('grid').setData(EMPTY_FEATURE_COLLECTION);
      map.getSource('grid-outline').setData(EMPTY_FEATURE_COLLECTION);
      updateHighlight();
    }

    function removeLayers(keepLoader = false) {
      clearGridRevealFailsafe();
      gridAnimationToken += 1;
      clearGridLayers();
      if (!keepLoader) removeLoaderLayers();
      map.getCanvas().style.cursor = '';
    }

    function addLayers(data, cells = []) {
      ensureGridScaffolding();
      map.getSource('grid').setData(data);
      map.getSource('grid-outline').setData(buildGridOutlineGeoJSON(cells));
      applyGridLinesVisibility();
      updateHighlight();
      animateGridFillFactor(0, 1, 220, () => {
        applyGridLinesVisibility();
        updateHighlight();
      });
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
