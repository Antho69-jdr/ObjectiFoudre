(function () {
  function isSmartphone() {
    const ua = navigator.userAgent || '';
    const platform = navigator.platform || '';
    const maxTouchPoints = Number(navigator.maxTouchPoints || 0);

    const isIPhoneLike = /iPhone|iPod|Windows Phone/i.test(ua);
    const isIPad = /iPad/i.test(ua) || (platform === 'MacIntel' && maxTouchPoints > 1);
    const isAndroid = /Android/i.test(ua);
    const isAndroidTablet = isAndroid && (/Tablet/i.test(ua) || !/Mobile/i.test(ua));
    const isAndroidPhone = isAndroid && /Mobile/i.test(ua) && !/Tablet/i.test(ua);

    if (isIPad || isAndroidTablet) return false;
    return isIPhoneLike || isAndroidPhone;
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
