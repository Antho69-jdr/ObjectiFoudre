(function () {
  function isSmartphone() {
    const ua = navigator.userAgent || '';
    const touchPhoneUA = /Android.+Mobile|iPhone|iPod|Windows Phone|Mobile/i.test(ua);
    const smallViewport = Math.min(window.innerWidth || 0, window.innerHeight || 0) <= 767;
    const narrowViewport = (window.innerWidth || 0) <= 767;
    let coarsePointer = false;
    try {
      coarsePointer = window.matchMedia('(hover: none), (pointer: coarse)').matches;
    } catch (_) {}
    return touchPhoneUA || (coarsePointer && (smallViewport || narrowViewport));
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
