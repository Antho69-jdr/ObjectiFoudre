    function setupAppLifecycle() {
      window.addEventListener('resize', () => {
        if (!isMobileLayout()) closeTopPanels();
        requestAnimationFrame(() => {
          alignTopPanels();
          positionSelectionCard();
        });
      });

      document.addEventListener('visibilitychange', maybeRefreshOnReturn);
      updateBestCellsButton();

      map.on('click', (e) => {
        const features = map.queryRenderedFeatures(e.point, { layers: ['grid-fill'] });
        if (!features.length && !detailsModal.classList.contains('visible')) closeSelection();
        if (!features.length) {
          closeTopPanels();
          closeInfoDrawer();
        }
      });

      registerPWA();

      map.on('move', () => {
        if (selectionCard.classList.contains('visible')) requestAnimationFrame(positionSelectionCard);
      });

      map.on('load', async () => {
        cityInput.value = currentCenter.label;
        await loadData().catch(err => {
          console.warn(err);
          setMetaMessage('Impossible de charger la zone initiale.');
        });
      });
    }

    setupPrimaryControls();
    setupAppLifecycle();
