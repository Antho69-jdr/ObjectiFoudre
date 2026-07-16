    function updateInstallUI() {
      const installable = !!deferredInstallPrompt;
      installChip.classList.toggle('visible', installable);
    }

    async function installApp() {
      if (!deferredInstallPrompt) return;
      deferredInstallPrompt.prompt();
      try { await deferredInstallPrompt.userChoice; } catch (_) {}
      deferredInstallPrompt = null;
      updateInstallUI();
    }

    function locateUser() {
      if (!navigator.geolocation) {
        setMetaMessage('Géolocalisation non disponible sur cet appareil.');
        return;
      }
      setLoadingState(true, 'Recherche de votre position…');
      navigator.geolocation.getCurrentPosition(
        async ({ coords }) => {
          try {
            await applyCenter({ lat: coords.latitude, lon: coords.longitude, label: 'Autour de moi' }, { showMarker: true, zoom: 8.8, force: true });
          } catch (error) {
            console.warn(error);
            setMetaMessage('Impossible de centrer la carte sur votre position.');
          } finally {
            setLoadingState(false);
          }
        },
        () => {
          setMetaMessage('Position refusée ou indisponible.');
          setLoadingState(false);
        },
        { enableHighAccuracy: true, timeout: 10000, maximumAge: 60000 }
      );
    }

    function registerPWA() {
      if ('serviceWorker' in navigator) {
        navigator.serviceWorker.register('/sw.js?v=1.3.10').catch(() => {});
      }
      window.addEventListener('beforeinstallprompt', (event) => {
        event.preventDefault();
        deferredInstallPrompt = event;
        updateInstallUI();
      });
      window.addEventListener('appinstalled', () => {
        deferredInstallPrompt = null;
        updateInstallUI();
      });
      updateInstallUI();
    }
