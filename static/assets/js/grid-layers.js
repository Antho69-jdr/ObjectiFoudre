function ensureSource(id, data) {
      if (map.getSource(id)) map.getSource(id).setData(data);
      else map.addSource(id, { type: 'geojson', data });
    }

    function removeLoaderLayers() {
      clearGridRevealFailsafe();
      gridAnimationToken += 1;
      stopLoaderPulse();
      if (map.getLayer('grid-loader-fill')) map.removeLayer('grid-loader-fill');
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
      startLoaderPulse();
    }

    function removeLayers(keepLoader = false) {
      clearGridRevealFailsafe();
      gridAnimationToken += 1;
      removeLoaderLayers();
      if (map.getLayer('grid-highlight')) map.removeLayer('grid-highlight');
      if (map.getLayer('grid-borders')) map.removeLayer('grid-borders');
      if (map.getLayer('grid-fill')) map.removeLayer('grid-fill');
      if (map.getSource('grid')) map.removeSource('grid');
      map.off('click', 'grid-fill', onGridClick);
      map.off('mouseenter', 'grid-fill', onGridEnter);
      map.off('mouseleave', 'grid-fill', onGridLeave);
    }

    function addLayers(data) {
      ensureSource('grid', data);
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
          'line-width': 1,
          'line-opacity': showGridLines ? 0.5 : 0,
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
      map.on('mouseenter', 'grid-fill', onGridEnter);
      map.on('mouseleave', 'grid-fill', onGridLeave);
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
