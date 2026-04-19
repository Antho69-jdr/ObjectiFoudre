(function () {
  function collectDimensions() {
    const doc = document.documentElement || {};
    const vv = window.visualViewport || {};
    const candidates = [
      [window.screen?.width, window.screen?.height],
      [window.screen?.availWidth, window.screen?.availHeight],
      [window.innerWidth, window.innerHeight],
      [doc.clientWidth, doc.clientHeight],
      [vv.width, vv.height],
    ];

    const pairs = candidates
      .map(([w, h]) => [Number(w || 0), Number(h || 0)])
      .filter(([w, h]) => w > 0 && h > 0);

    const shortSides = pairs.map(([w, h]) => Math.min(w, h));
    const longSides = pairs.map(([w, h]) => Math.max(w, h));

    return {
      shortSide: shortSides.length ? Math.min(...shortSides) : 0,
      longSide: longSides.length ? Math.min(...longSides) : 0,
    };
  }

  function isSmartphoneByScreenSize() {
    const { shortSide, longSide } = collectDimensions();

    // Smartphone only:
    // - short side stays well below tablet portrait widths
    // - long side keeps foldables / very tall phones covered
    return shortSide > 0 && shortSide <= 540 && longSide <= 1200;
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
