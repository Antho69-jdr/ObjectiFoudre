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
      // L'écran d'erreur a pris la place du splash : le masquer laisserait une app
      // vide et muette, exactement ce qu'on vient de corriger.
      if (appLoader.classList.contains('is-failed')) return;
      if (appLoaderFailsafe) { clearTimeout(appLoaderFailsafe); appLoaderFailsafe = null; }
      const remaining = force ? 0 : Math.max(0, APP_LOADER_MIN_MS - (performance.now() - appLoaderStartedAt));
      window.setTimeout(() => {
        appLoader.classList.add('hidden');
        appLoader.setAttribute('aria-hidden', 'true');
      }, remaining);
    }

    // La carte n'a PAS pu démarrer (WebGL indisponible, ou maplibre-gl.js absent).
    // Le splash devient un écran d'erreur au lieu de tourner indéfiniment sur
    // « Chargement de la situation convective… » : mesuré avant correction, il restait
    // affiché pour toujours, sans le moindre message. On ne le masque donc PAS — on
    // change son état, c'est la seule surface déjà visible à ce moment-là.
    function showMapFailure(err) {
      if (!appLoader) return;
      if (appLoaderFailsafe) { clearTimeout(appLoaderFailsafe); appLoaderFailsafe = null; }
      const brut = String((err && err.message) || err || '');
      const estWebgl = /webgl/i.test(brut);
      const why = document.getElementById('appLoaderFailWhy');
      if (why) {
        why.textContent = estWebgl
          ? "Ton navigateur n'a pas pu ouvrir de contexte WebGL, la technologie qui dessine la carte."
          : "Le moteur de carte n'a pas pu être chargé.";
      }
      // Le conseil suit la CAUSE : parler d'accélération matérielle sur un fichier
      // manquant enverrait l'utilisateur chercher au mauvais endroit.
      const hint = document.getElementById('appLoaderFailHint');
      if (hint) {
        hint.textContent = estWebgl
          ? "Vérifie que l'accélération matérielle est activée dans les réglages de ton navigateur, ou essaie un autre navigateur."
          : "C'est le plus souvent passager. Recharge la page ; si ça persiste, vérifie ta connexion.";
      }
      const retry = document.getElementById('appLoaderRetry');
      if (retry) retry.addEventListener('click', () => { window.location.reload(); });
      appLoader.classList.remove('hidden');
      appLoader.classList.add('is-failed');
      appLoader.setAttribute('aria-hidden', 'false');
      appLoader.setAttribute('role', 'alert');
    }

    // Arme le repli : le loader d'ouverture reste affiché tant que la grille de la
    // journée (24 créneaux) n'est pas hydratée, mais ne doit jamais bloquer l'app
    // si les données n'arrivent pas (réseau lent, quota, erreur serveur).
    function armAppLoaderFailsafe() {
      if (!appLoader || appLoader.classList.contains('hidden')) return;
      if (appLoaderFailsafe) clearTimeout(appLoaderFailsafe);
      appLoaderFailsafe = window.setTimeout(() => hideAppLoader(true), APP_LOADER_FAILSAFE_MS);
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

    function openInfoDrawer() {
      infoDrawer.classList.add('visible');
      drawerBackdrop.classList.add('visible');
    }

    function closeInfoDrawer() {
      infoDrawer.classList.remove('visible');
      drawerBackdrop.classList.remove('visible');
    }
