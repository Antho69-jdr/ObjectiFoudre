    function isMobileLayout() {
      return document.body.classList.contains('mobile-ui');
    }

    function applyResponsiveMode() {
      document.body.classList.add('mobile-ui');
    }

    function closeTopPanels() {
      topbar.classList.remove('show-search', 'show-calendar');
    }

    function hideAppLoader(force = false) {
      if (!appLoader || appLoader.classList.contains('hidden')) return;
      if (appLoaderFailsafe) { clearTimeout(appLoaderFailsafe); appLoaderFailsafe = null; }
      const remaining = force ? 0 : Math.max(0, APP_LOADER_MIN_MS - (performance.now() - appLoaderStartedAt));
      window.setTimeout(() => appLoader.classList.add('hidden'), remaining);
    }

    function positionPanelToButton(panel, button) {
      if (!panel || !button || (!topbar.classList.contains('show-search') && !topbar.classList.contains('show-calendar'))) return;
      panel.style.top = '0px';
      const buttonCenter = button.offsetTop + (button.offsetHeight / 2);
      const panelHeight = panel.offsetHeight || 0;
      const railHeight = topbar.offsetHeight || window.innerHeight;
      const rawTop = buttonCenter - (panelHeight / 2);
      const clampedTop = Math.max(0, Math.min(rawTop, Math.max(0, railHeight - panelHeight)));
      panel.style.top = `${Math.round(clampedTop)}px`;
    }

    function alignTopPanels() {
      if (topbar.classList.contains('show-search')) positionPanelToButton(document.querySelector('.search-panel'), toggleSearchBtn);
      if (topbar.classList.contains('show-calendar')) positionPanelToButton(document.querySelector('.calendar-panel'), toggleCalendarBtn);
    }

    function toggleTopPanel(panel) {
      if (!isMobileLayout()) return;
      const searchOpen = topbar.classList.contains('show-search');
      const calendarOpen = topbar.classList.contains('show-calendar');
      closeTopPanels();
      if (panel === 'search' && !searchOpen) topbar.classList.add('show-search');
      if (panel === 'calendar' && !calendarOpen) topbar.classList.add('show-calendar');
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
