    function updateMetaLine() {
      const centerLabel = payload?.meta?.center?.label || currentCenter.label || 'Zone';
      const generated = formatFrenchRun(payload?.meta?.generated_at || '');
      const model = payload?.meta?.model || 'arome_france';
      metaCenter.textContent = `Zone : ${centerLabel}`;
      metaRun.textContent = `Modèle arome-france : ${generated}`;
    }

    function setMetaMessage(message) {
      metaCenter.textContent = message;
    }

    function setLoadingState(isLoading, message) {
      searchCityBtn.disabled = isLoading;
      if (typeof aroundMeBtn !== 'undefined' && aroundMeBtn) aroundMeBtn.disabled = isLoading;
      locateBtn.disabled = isLoading;
      refreshBtn.disabled = isLoading;
      if (message) setMetaMessage(message);
    }

    function showCurrentMarker(lon, lat) {
      const lngLat = [lon, lat];
      if (!userLocationMarker) {
        const el = document.createElement('div');
        el.style.width = '16px';
        el.style.height = '16px';
        el.style.borderRadius = '999px';
        el.style.background = '#60a5fa';
        el.style.border = '3px solid white';
        el.style.boxShadow = '0 0 0 6px rgba(96,165,250,0.18)';
        userLocationMarker = new maplibregl.Marker({ element: el }).setLngLat(lngLat).addTo(map);
      } else {
        userLocationMarker.setLngLat(lngLat);
      }
    }

    function haversineKm(a, b) {
      const toRad = (deg) => (deg * Math.PI) / 180;
      const R = 6371;
      const dLat = toRad(b.lat - a.lat);
      const dLon = toRad(b.lon - a.lon);
      const lat1 = toRad(a.lat);
      const lat2 = toRad(b.lat);
      const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
      return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
    }

    function targetZoomForDistance(distanceKm) {
      if (distanceKm > 900) return 5.8;
      if (distanceKm > 600) return 6.2;
      if (distanceKm > 350) return 6.7;
      if (distanceKm > 180) return 7.1;
      if (distanceKm > 90) return 7.5;
      if (distanceKm > 40) return 7.9;
      return 8.3;
    }

    function minZoomForDistance(distanceKm, targetZoom) {
      const drop = distanceKm > 700 ? 0.75 : distanceKm > 300 ? 0.62 : distanceKm > 120 ? 0.5 : distanceKm > 50 ? 0.36 : 0.24;
      return Math.max(5.8, targetZoom - drop);
    }

    function durationForDistance(distanceKm) {
      if (isCoarsePointerDevice()) return Math.max(1200, Math.min(2600, 1400 + distanceKm * 1.8));
      return Math.max(2800, Math.min(6100, (3800 + distanceKm * 5.2) / 1.44));
    }

    function animateCameraToCenter(center, zoomOverride = null) {
      const current = map.getCenter();
      const from = { lat: current.lat, lon: current.lng };
      const to = { lat: center.lat, lon: center.lon };
      const distanceKm = haversineKm(from, to);
      const targetZoom = Number.isFinite(zoomOverride) ? zoomOverride : targetZoomForDistance(distanceKm);
      map.flyTo({
        center: [center.lon, center.lat],
        zoom: targetZoom,
        minZoom: minZoomForDistance(distanceKm, targetZoom),
        speed: 0.38,
        curve: 1.14,
        essential: true,
        duration: durationForDistance(distanceKm)
      });
    }

    function fadeOutCurrentGridForReload() {
      if (!map.isStyleLoaded()) return;
      if (prefersReducedGridMotion(getCurrentSlot()?.cells || [])) {
        removeLayers(true);
        return;
      }
      if (map.getLayer('grid-fill')) {
        setGridFillFactor(1);
        animateGridFillFactor(1, 0, 180);
      }
      if (map.getLayer('grid-highlight')) {
        animateLayerPaintNumber('grid-highlight', 'line-opacity', 1, 0, 160);
      }
      if (map.getLayer('grid-borders')) {
        const currentOpacity = showGridLines ? 0.5 : 0;
        animateLayerPaintNumber('grid-borders', 'line-opacity', currentOpacity, 0, 160);
      }
    }

