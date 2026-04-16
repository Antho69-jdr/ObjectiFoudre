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
      updateBestCellsButton();

      map.on('click', (e) => {
        const features = map.getLayer('grid-fill') ? map.queryRenderedFeatures(e.point, { layers: ['grid-fill'] }) : [];
        if (!features.length && !detailsModal.classList.contains('visible')) closeSelection();
        if (!features.length) {
          closeTopPanels();
          closeInfoDrawer();
        }
      });

      registerPWA();
      setupRightRailTouchShield();

      map.on('move', () => {
        if (selectionCard.classList.contains('visible')) requestAnimationFrame(positionSelectionCard);
      });

      map.on('load', () => {
        debugLog('map:load', { center: currentCenter, selectedBaseDate, styleLoaded: map.isStyleLoaded() });
        ensureGridScaffolding();
        ensureLoaderScaffolding();
        cityInput.value = currentCenter.label;
        topbar.classList.add('show-search');
        requestAnimationFrame(alignTopPanels);
        updateMetaLine();
        metaRun.textContent = 'Modèle arome-france : en attente';
        setMetaMessage('Choisis une zone pour lancer le chargement météo.');
        hideAppLoader(true);
      });
    }

    updateDataModeUi();
    setupPrimaryControls();
    setupAppLifecycle();


// PATCH v0.6.14

function updateSelectionFollow(map) {
  const selection = document.getElementById("selectionCard");
  if (!selection || !map) return;

  const rect = map.getCanvas().getBoundingClientRect();
  const centerX = rect.left + rect.width / 2;

  const spaceLeft = centerX - rect.left;
  const spaceRight = rect.right - centerX;

  selection.style.top = "50%";
  selection.style.transform = "translateY(-50%)";

  if (spaceRight > spaceLeft) {
    selection.style.left = "auto";
    selection.style.right = "20px";
  } else {
    selection.style.right = "auto";
    selection.style.left = "20px";
  }
}

function initSelectionFollow(map) {
  function update() {
    updateSelectionFollow(map);
  }
  window.addEventListener("resize", update);
  if (map) {
    map.on("move", update);
    map.on("zoom", update);
  }
  update();
}

