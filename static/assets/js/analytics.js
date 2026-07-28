/* analytics.js — mesure d'audience COOKIELESS (RGPD-clean, sans consentement).
   AUCUN identifiant n'est stocké sur l'appareil : un simple ping au chargement.
   Le serveur compte les VISITEURS UNIQUES DU JOUR via un hash quotidien salé
   (IP + User-Agent), jamais conservés. Non bloquant, best-effort. */
(function () {
  'use strict';
  function isPWA() {
    try {
      return (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches)
        || window.navigator.standalone === true;
    } catch (e) { return false; }
  }
  function ping() {
    var url = '/api/analytics/hit' + (isPWA() ? '?pwa=1' : '');
    try {
      if (navigator.sendBeacon) { navigator.sendBeacon(url); }
      else { fetch(url, { method: 'POST', keepalive: true }).catch(function () {}); }
    } catch (e) {}
  }
  // après le chargement, sans bloquer le rendu (le serveur dédoublonne par jour).
  if (document.readyState === 'complete') window.setTimeout(ping, 1500);
  else window.addEventListener('load', function () { window.setTimeout(ping, 1500); });
})();
