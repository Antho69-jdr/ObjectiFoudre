    function setupRightRailTouchShield() {
      if (!rightRailScroll) return;

      const swallow = (event) => {
        event.stopPropagation();
      };

      ['pointerdown', 'pointerup', 'pointercancel', 'click', 'wheel', 'touchstart', 'touchmove', 'touchend'].forEach((type) => {
        rightRailScroll.addEventListener(type, swallow, { passive: true });
      });
    }

    function setupAppLifecycle() {
      window.addEventListener('resize', () => {
        if (!isMobileLayout()) closeTopPanels();
        requestAnimationFrame(() => {
          alignTopPanels();
          positionSelectionCard();
        });
      });

      document.addEventListener('visibilitychange', maybeRefreshOnReturn);
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible' && typeof pollMeteoFranceServerAutomationStatus === 'function') {
          pollMeteoFranceServerAutomationStatus({ immediate: true, quiet: true });
        }
      });
      updateBestCellsButton();
      if (typeof startCurrentTimeBadge === 'function') startCurrentTimeBadge();

      // Remontés AVANT la garde `map` : ni l'un ni l'autre ne dépend de la carte, et
      // ils doivent continuer à s'exécuter quand elle n'a pas pu démarrer.
      registerPWA();
      setupRightRailTouchShield();

      // La carte n'a pas démarré (WebGL refusé, MapLibre absent) : showMapFailure()
      // affiche déjà l'écran d'erreur. Tout ce qui suit s'accroche à `map` — on s'arrête
      // ici plutôt que de jeter et d'emporter le reste de l'amorçage avec soi.
      if (!map) return;

      map.on('click', (e) => {
        const features = map.getLayer('grid-fill') ? map.queryRenderedFeatures(e.point, { layers: ['grid-fill'] }) : [];
        if (!features.length && !detailsModal.classList.contains('visible')) closeSelection();
        if (!features.length) {
          closeTopPanels();
          closeInfoDrawer();
        }
      });

      map.on('move', () => {
        if (selectionCard.classList.contains('visible')) requestAnimationFrame(positionSelectionCard);
      });

      let mapReadyHandled = false;
      const handleMapReady = () => {
        if (mapReadyHandled) return;
        mapReadyHandled = true;
        debugLog('map:load', { center: currentCenter, selectedBaseDate, styleLoaded: map.isStyleLoaded() });
        improveBasemapReadability();
        ensureGridScaffolding();
        ensureLoaderScaffolding();
        if (cityInput) cityInput.value = currentCenter.label;
        requestAnimationFrame(alignTopPanels);
        updateMetaLine();
        if (typeof setupMetaRunScroller === 'function') setupMetaRunScroller();
        if (typeof setMetaRunText === 'function') setMetaRunText('AROME France : en attente');
        setMetaMessage('Chargement AROME France…');
        window.setTimeout(() => {
          // Affichage instantané du dernier état connu (IndexedDB) pendant que le
          // statut serveur et le réseau arrivent.
          if (typeof hydrateMeteoFranceGribFranceDayFromCache === 'function') {
            hydrateMeteoFranceGribFranceDayFromCache({ force: false });
          }
          refreshCurrentData(false, 'Chargement AROME France…');
          if (typeof pollMeteoFranceServerAutomationStatus === 'function') {
            pollMeteoFranceServerAutomationStatus({ immediate: true, quiet: true });
          }
        }, 0);
        // Le loader d'ouverture reste affiché jusqu'à l'hydratation de la journée
        // (24 créneaux en cache) ; cf. loadAromeFranceData. On arme juste le repli
        // pour qu'il ne bloque jamais l'app si les données n'arrivent pas.
        armAppLoaderFailsafe();
      };

      map.on('load', handleMapReady);
      if ((typeof map.loaded === 'function' && map.loaded()) || map.isStyleLoaded()) {
        requestAnimationFrame(handleMapReady);
      }
    }

    setupPrimaryControls();
    if (typeof setupSearchAutocomplete === "function") setupSearchAutocomplete();
    setupAppLifecycle();
