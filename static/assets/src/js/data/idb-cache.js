// Cache IndexedDB des créneaux AROME France (payloads niveau « render ») : au
// rechargement de l'app, les heures du dernier état connu s'affichent instantanément
// (zéro réseau, zéro JSON.parse — structured clone), puis sont revalidées en arrière-plan.
// Clé : "date|slotKey" (ex. "2026-06-12|h14"). Tout est best-effort : si IndexedDB est
// indisponible (navigation privée…), l'app fonctionne comme avant.
//
// Premier module ES de la Phase 3. Exporte ses fonctions ; le pont vers les anciennes
// globales (window.idbGetAromeSlot/idbPutAromeSlot) est fait dans main.js.

const DB_NAME = 'objectifoudre-arome';
const STORE = 'slots';
const MAX_DATES = 6; // on garde les 6 dernières dates (J-1..J+4, 6 × 24 créneaux max)

let dbPromise = null;
function openDb() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve) => {
    try {
      if (!('indexedDB' in window)) { resolve(null); return; }
      // v2 : le schéma de cellule a gagné CIN/MLCAPE/cisaillement (WCS). On wipe le
      // store à la montée de version pour ne pas servir d'anciennes cellules sans ces champs.
      const req = indexedDB.open(DB_NAME, 2);
      req.onupgradeneeded = () => {
        try {
          const db = req.result;
          if (db.objectStoreNames.contains(STORE)) db.deleteObjectStore(STORE);
          db.createObjectStore(STORE);
        } catch (_) {}
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
      req.onblocked = () => resolve(null);
    } catch (_) { resolve(null); }
  });
  return dbPromise;
}

export async function idbGetAromeSlot(dateIso, slotKey) {
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

export async function idbPutAromeSlot(dateIso, slotKey, payload) {
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

// ── Cache IndexedDB des FRAMES RADAR (isobandes GeoJSON) ──────────────────────
// DB SÉPARÉE (ne pas toucher au store des grilles : bumper la version de leur DB les
// effacerait). Une frame OBSERVÉE pour un `time` est immuable → le cache reste valide à
// vie ; au rechargement / après un déploiement Railway, le radar se réaffiche instantanément
// sans re-télécharger toutes les frames (le blend est versionné via sa clé blendGen/&g).
// Clé = frameShapesKey de chase.js. Best-effort. Pont window.* fait dans main.js.
const RDB_NAME = 'objectifoudre-radar';
const RSTORE = 'frames';
const R_MAX = 48; // borne du store (largement au-delà de la frise ~18-30 frames)
let rdbPromise = null;
function openRadarDb() {
  if (rdbPromise) return rdbPromise;
  rdbPromise = new Promise((resolve) => {
    try {
      if (!('indexedDB' in window)) { resolve(null); return; }
      const req = indexedDB.open(RDB_NAME, 1);
      req.onupgradeneeded = () => {
        try { const db = req.result; if (!db.objectStoreNames.contains(RSTORE)) db.createObjectStore(RSTORE); } catch (_) {}
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
      req.onblocked = () => resolve(null);
    } catch (_) { resolve(null); }
  });
  return rdbPromise;
}

export async function idbGetRadarFrame(key) {
  const db = await openRadarDb();
  if (!db) return null;
  return new Promise((resolve) => {
    try {
      const rq = db.transaction(RSTORE, 'readonly').objectStore(RSTORE).get(key);
      rq.onsuccess = () => resolve(rq.result ? rq.result.fc : null);
      rq.onerror = () => resolve(null);
    } catch (_) { resolve(null); }
  });
}

export async function idbPutRadarFrame(key, fc) {
  const db = await openRadarDb();
  if (!db) return;
  try { db.transaction(RSTORE, 'readwrite').objectStore(RSTORE).put({ storedAt: Date.now(), fc }, key); } catch (_) {}
  scheduleRadarPrune();
}

let rPruneTimer = null;
function scheduleRadarPrune() {
  if (rPruneTimer) return;
  rPruneTimer = setTimeout(async () => {
    rPruneTimer = null;
    const db = await openRadarDb();
    if (!db) return;
    try {
      const store = db.transaction(RSTORE, 'readonly').objectStore(RSTORE);
      const keysReq = store.getAllKeys();
      keysReq.onsuccess = () => {
        const keys = (keysReq.result || []).map(String);
        if (keys.length <= R_MAX) return;
        // Clés ~ "r:gN:<iso>" / "bK:gN:<iso>" : le tri lexical ≈ ordre temporel (par
        // préfixe) → on drope les plus anciennes pour borner le store.
        const drop = keys.sort().slice(0, keys.length - R_MAX);
        try { const rw = db.transaction(RSTORE, 'readwrite').objectStore(RSTORE); drop.forEach((k) => rw.delete(k)); } catch (_) {}
      };
    } catch (_) {}
  }, 4000);
}
