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

      map.on('load', () => {
        cityInput.value = currentCenter.label;
        topbar.classList.add('show-search');
        requestAnimationFrame(alignTopPanels);
        updateMetaLine();
        metaRun.textContent = 'Modèle arome-france : en attente';
        setMetaMessage('Choisis une zone pour lancer le chargement météo.');
        hideAppLoader(true);
      });
    }

    setupPrimaryControls();
    setupAppLifecycle();
