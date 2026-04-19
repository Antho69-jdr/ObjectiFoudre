(function () {
  function isSmartphone() {
    const ua = navigator.userAgent || '';
    const platform = navigator.platform || '';
    const maxTouchPoints = Number(navigator.maxTouchPoints || 0);

    const isIPhoneLike = /iPhone|iPod|Windows Phone/i.test(ua);
    const isAndroidPhone = /Android/i.test(ua) && /Mobile/i.test(ua);
    const isIPad = /iPad/i.test(ua) || (platform === 'MacIntel' && maxTouchPoints > 1);
    const isAndroidTablet = /Android/i.test(ua) && !/Mobile/i.test(ua);

    let coarsePointer = false;
    try {
      coarsePointer = window.matchMedia('(hover: none) and (pointer: coarse)').matches;
    } catch (_) {}

    const width = window.innerWidth || 0;
    const height = window.innerHeight || 0;
    const smallestSide = Math.min(width, height);
    const fallbackPhoneViewport = coarsePointer && smallestSide > 0 && smallestSide <= 600;

    if (isIPad || isAndroidTablet) return false;
    if (isIPhoneLike || isAndroidPhone) return true;
    return fallbackPhoneViewport;
  }

  function applySmartphoneBlock() {
    const blocked = isSmartphone();
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
