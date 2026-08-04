// main.js — entrée du bundle JS ObjectiFoudre (modules ES, Phase 3).
//
// Le bundle s'exécute À CÔTÉ du code legacy (assets/js/*.js, scripts classiques)
// pendant la migration. Pont window.OF : on expose les modules migrés à la fois
// sur window.OF (nouvel espace) et sous leurs anciens noms globaux, pour que le
// code legacy non encore migré continue de fonctionner sans modification.
//
// Migration cluster par cluster, en partant des feuilles (modules sans
// dépendance entrante). Premier module migré : data/idb-cache.

import { idbGetAromeSlot, idbPutAromeSlot, idbGetRadarFrame, idbPutRadarFrame } from './data/idb-cache.js';

window.OF = window.OF || {};
window.OF.version = window.OF.version || '1.0.0-src';

// --- Pont legacy : cache IndexedDB AROME + frames radar ------------------
window.OF.idb = { idbGetAromeSlot, idbPutAromeSlot, idbGetRadarFrame, idbPutRadarFrame };
// Anciennes globales (consommées par controls.js / chase.js, toutes gardées par typeof) :
window.idbGetAromeSlot = idbGetAromeSlot;
window.idbPutAromeSlot = idbPutAromeSlot;
window.idbGetRadarFrame = idbGetRadarFrame;
window.idbPutRadarFrame = idbPutRadarFrame;
