// Cache IndexedDB des créneaux AROME France (payloads niveau « render ») : au
// rechargement de l'app, les heures du dernier état connu s'affichent instantanément
// (zéro réseau, zéro JSON.parse — structured clone), puis sont revalidées en arrière-plan.
// Clé : "date|slotKey" (ex. "2026-06-12|h14"). Tout est best-effort : si IndexedDB est
// indisponible (navigation privée…), l'app fonctionne comme avant.
(function () {
  'use strict';

  const DB_NAME = 'objectifoudre-arome';
  const STORE = 'slots';
  const MAX_DATES = 6; // on garde les 6 dernières dates (J-1..J+4, 6 × 24 créneaux max)

  let dbPromise = null;
  function openDb() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise((resolve) => {
      try {
        if (!('indexedDB' in window)) { resolve(null); return; }
        const req = indexedDB.open(DB_NAME, 1);
        req.onupgradeneeded = () => { try { req.result.createObjectStore(STORE); } catch (_) {} };
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => resolve(null);
        req.onblocked = () => resolve(null);
      } catch (_) { resolve(null); }
    });
    return dbPromise;
  }

  async function idbGetAromeSlot(dateIso, slotKey) {
    const db = await openDb();
    if (!db) return null;
    return new Promise((resolve) => {
      try {
        const rq = db.transaction(STORE, 'readonly').objectStore(STORE).get(`${dateIso}|${slotKey}`);
        rq.onsuccess = () => resolve(rq.result || null);
        rq.onerror = () => resolve(null);
      } catch (_) { resolve(null); }
    });
  }

  async function idbPutAromeSlot(dateIso, slotKey, payload) {
    const db = await openDb();
    if (!db) return;
    try {
      db.transaction(STORE, 'readwrite').objectStore(STORE).put({
        storedAt: Date.now(),
        generatedAt: String(payload?.meta?.generated_at || ''),
        payload,
      }, `${dateIso}|${slotKey}`);
    } catch (_) {}
    schedulePrune();
  }

  // Élagage par DATE (clés seules, sans lire les valeurs) : on ne garde que les
  // MAX_DATES dates les plus récentes.
  let pruneTimer = null;
  function schedulePrune() {
    if (pruneTimer) return;
    pruneTimer = setTimeout(async () => {
      pruneTimer = null;
      const db = await openDb();
      if (!db) return;
      try {
        const store = db.transaction(STORE, 'readwrite').objectStore(STORE);
        const keysReq = store.getAllKeys();
        keysReq.onsuccess = () => {
          const keys = keysReq.result || [];
          const dates = [...new Set(keys.map((k) => String(k).split('|')[0]))].sort();
          if (dates.length <= MAX_DATES) return;
          const drop = new Set(dates.slice(0, dates.length - MAX_DATES));
          try {
            const rw = db.transaction(STORE, 'readwrite').objectStore(STORE);
            keys.forEach((k) => { if (drop.has(String(k).split('|')[0])) rw.delete(k); });
          } catch (_) {}
        };
      } catch (_) {}
    }, 4000);
  }

  window.idbGetAromeSlot = idbGetAromeSlot;
  window.idbPutAromeSlot = idbPutAromeSlot;
})();
