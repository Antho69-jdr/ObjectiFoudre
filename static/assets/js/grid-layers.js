function ensureSource(id, data) {
      if (map.getSource(id)) map.getSource(id).setData(data);
      else map.addSource(id, { type: 'geojson', data });
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
    }

    function showLoadingGrid(center) {
      if (!map.isStyleLoaded()) return;
      removeLoaderLayers();
      const cells = buildLoaderCells(center);
      ensureSource('grid-loader', buildLoaderGeoJSON(cells, 0));
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
      animateGridFillFactor(0, 1, 260, () => { applyGridLinesVisibility(); updateHighlight(); });
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
