(function () {
  function isSmartphoneByScreenSize() {
    const sw = window.screen && Number(window.screen.width || 0);
    const sh = window.screen && Number(window.screen.height || 0);
    const vw = Math.max(document.documentElement.clientWidth || 0, window.innerWidth || 0);
    const vh = Math.max(document.documentElement.clientHeight || 0, window.innerHeight || 0);

    const shortScreen = Math.min(sw || vw, sh || vh);
    const longScreen = Math.max(sw || vw, sh || vh);
    const shortViewport = Math.min(vw, vh);
    const longViewport = Math.max(vw, vh);

    return (shortScreen <= 430 && longScreen <= 950) || (shortViewport <= 430 && longViewport <= 950);
  }

  function applySmartphoneBlock() {
    const blocked = isSmartphoneByScreenSize();
    document.body.classList.toggle('smartphone-blocked', blocked);
    const gate = document.getElementById('smartphoneGate');
    if (gate) {
      gate.hidden = !blocked;
      gate.setAttribute('aria-hidden', blocked ? 'false' : 'true');
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', applySmartphoneBlock, { once: true });
  } else {
    applySmartphoneBlock();
  }
  window.addEventListener('resize', applySmartphoneBlock);
  window.addEventListener('orientationchange', applySmartphoneBlock);
})();
