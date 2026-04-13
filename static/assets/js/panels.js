    function isMobileLayout() {
      return document.body.classList.contains('mobile-ui');
    }

    function applyResponsiveMode() {
      document.body.classList.add('mobile-ui');
    }

    function closeTopPanels() {
      topbar.classList.remove('show-search');
    }

    function hideAppLoader(force = false) {
      if (!appLoader || appLoader.classList.contains('hidden')) return;
      if (appLoaderFailsafe) { clearTimeout(appLoaderFailsafe); appLoaderFailsafe = null; }
      const remaining = force ? 0 : Math.max(0, APP_LOADER_MIN_MS - (performance.now() - appLoaderStartedAt));
      window.setTimeout(() => appLoader.classList.add('hidden'), remaining);
    }

    function positionPanelToButton(panel, button) {
      if (!panel || !button || !topbar.classList.contains('show-search')) return;
      const buttonRect = button.getBoundingClientRect();
      const panelHeight = panel.offsetHeight || 0;
      const viewportTopPadding = 12;
      const viewportBottomPadding = 12;
      const viewportHeight = window.innerHeight;
      const rawTop = buttonRect.top + (buttonRect.height / 2) - (panelHeight / 2);
      const maxTop = Math.max(viewportTopPadding, viewportHeight - panelHeight - viewportBottomPadding);
      const clampedTop = Math.max(viewportTopPadding, Math.min(rawTop, maxTop));
      panel.style.top = `${Math.round(clampedTop)}px`;
    }

    function alignTopPanels() {
      if (topbar.classList.contains('show-search')) positionPanelToButton(document.querySelector('.search-panel'), toggleSearchBtn);
    }

    function toggleTopPanel(panel) {
      const searchOpen = topbar.classList.contains('show-search');
      closeTopPanels();
      if (panel === 'search' && !searchOpen) topbar.classList.add('show-search');
      requestAnimationFrame(alignTopPanels);
    }

    function openInfoDrawer() {
      infoDrawer.classList.add('visible');
      drawerBackdrop.classList.add('visible');
    }

    function closeInfoDrawer() {
      infoDrawer.classList.remove('visible');
      drawerBackdrop.classList.remove('visible');
    }
