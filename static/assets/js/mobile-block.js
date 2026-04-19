(function () {
  const blockScreen = document.getElementById("mobileBlockScreen");
  const appRoot = document.getElementById("app");
  if (!blockScreen || !appRoot) return;

  function getDimensions() {
    const viewportWidth = Math.min(window.innerWidth || Infinity, window.visualViewport?.width || Infinity);
    const viewportHeight = Math.min(window.innerHeight || Infinity, window.visualViewport?.height || Infinity);
    const width = Number.isFinite(viewportWidth) ? viewportWidth : (window.innerWidth || 0);
    const height = Number.isFinite(viewportHeight) ? viewportHeight : (window.innerHeight || 0);
    const shortSide = Math.min(width, height);
    const longSide = Math.max(width, height);
    return { shortSide, longSide, width, height };
  }

  function isBlockedSmartphone() {
    const { shortSide, longSide } = getDimensions();
    return shortSide <= 600 && longSide <= 1100;
  }

  function applyBlockState() {
    const blocked = isBlockedSmartphone();
    blockScreen.hidden = !blocked;
    document.body.classList.toggle("mobile-blocked", blocked);
    appRoot.setAttribute("aria-hidden", blocked ? "true" : "false");
  }

  applyBlockState();
  window.addEventListener("resize", applyBlockState, { passive: true });
  window.visualViewport?.addEventListener("resize", applyBlockState, { passive: true });
  window.addEventListener("orientationchange", applyBlockState, { passive: true });
})();
