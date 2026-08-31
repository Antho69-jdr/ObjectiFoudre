// tour.js — visite guidée du premier lancement (carte Trello « Guide interactif »).
//
// Principes, validés sur maquette avant écriture :
//  - ANCRAGE PAR FONCTION, jamais par position. La barre du bas est personnalisable
//    (4 épinglés max, le reste dans « Plus ») : viser « le 3e onglet » serait faux dès
//    qu'un utilisateur réorganise sa barre. Chaque étape résout son ancre au moment de
//    s'afficher, et se rabat sur « Plus » si la destination visée est repliée.
//  - ÉTAPES ADAPTABLES. Une étape dont l'ancre est absente, ou dont la fonctionnalité
//    n'est pas accessible au compte courant, est SAUTÉE — pas éclairée dans le vide.
//    Prépare le mode gratuit : `estAccessible()` est le seul point à brancher le jour
//    où les droits par plan existeront.
//  - AUCUNE DÉPENDANCE. Le projecteur est une box-shadow de très grand rayon.
(function () {
  'use strict';

  var LS_VU = 'objfTourVu';
  var DUREE_ANIM = 380;

  // ── Étapes ────────────────────────────────────────────────────────────────
  // `ancre` : 'map' | 'cellule' | 'frise' | 'compte' | 'nav:<id>' (id du pool de la
  //           barre du bas, qui sert aussi de clé pour le bandeau desktop).
  // `feature` : clé fonctionnelle, consommée par estAccessible(). null = toujours là.
  var ETAPES = [
    {
      // Le point de départ : la carte de base et le bouton qui y ramène. En bandeau
      // desktop c'est #forecastPageBtn, en mobile l'onglet `carte`.
      id: 'accueil', ancre: 'nav:carte', feature: null,
      titre: 'Prévisions, la carte de base',
      texte: "C'est la vue qui s'ouvre au lancement. Ce bouton y ramène depuis n'importe quelle page ou n'importe quel mode."
    },
    {
      // La carte se recadre sur la France et le projecteur épouse le pays : on montre
      // le périmètre couvert avant de parler de son contenu.
      id: 'carte', ancre: 'france', feature: null,
      titre: 'La France, maillée en cellules de 15 km',
      texte: "Chaque cellule porte une probabilité de déclenchement orageux, calculée à partir du modèle AROME de Météo-France. L'échelle va du bleu au rouge.",
      entrer: function () { memoriserCamera(); cadrerFrance(900); }
    },
    {
      // On zoome sur la cellule la plus active et on l'ACTIVE réellement : le
      // projecteur se pose ensuite sur la fiche obtenue, c'est-à-dire la réponse.
      id: 'cellule', ancre: 'selection', feature: 'cell_detail',
      titre: 'Ouvrir une cellule',
      texte: "Un appui sur une cellule affiche sa probabilité et sa confiance. Le détail complet — instabilité, humidité, cisaillement — s'obtient depuis cette fiche.",
      entrer: function () { activerCellule(); },
      sortir: function () { fermerSelection(); cadrerFrance(700); }
    },
    {
      id: 'frise', ancre: 'frise', feature: null,
      titre: 'La frise horaire',
      texte: "La frise parcourt les créneaux de la journée. La carte est recalculée à chaque pas."
    },
    {
      // Le rail gauche n'est pas UN élément mais TROIS, un par carte : #spotsRail
      // (Prévisions), #chaseLayerRail (Radar), #stargazeLayerRail (Étoiles).
      // L'ancre prend celui qui est visible, d'où le message « il change ».
      id: 'rail', ancre: 'rail', feature: null,
      titre: 'Les outils de la carte, à gauche',
      texte: "Ce rail regroupe les outils de la carte affichée : spots et meilleures cellules ici. Son contenu CHANGE avec la carte — le radar y expose ses couches, le mode étoiles ses filtres de ciel."
    },
    {
      id: 'prev', ancre: 'nav:prev', feature: 'horizon_long',
      titre: 'Risque orageux J+0 → J+10',
      texte: "AROME jusqu’à J+1, ECMWF au-delà, avec une tendance à partir de J+4. C’est la vue d’anticipation."
    },
    {
      id: 'radar', ancre: 'nav:radar', feature: 'chase',
      titre: 'Radar et suivi de cellules',
      texte: "Réflectivité Météo-France, cellules suivies avec trajectoire et vitesse, et impacts de foudre MTG-LI des 30 dernières minutes."
    },
    {
      id: 'etoiles', ancre: 'nav:etoiles', feature: 'stargaze',
      titre: 'Qualité du ciel nocturne',
      texte: "Pollution lumineuse, nébulosité par étage, phase et hauteur de la Lune. La seconde lecture de la même grille, hors saison orageuse."
    },
    {
      id: 'cartes', ancre: 'cartes', feature: null,
      titre: 'Trois cartes, une même grille',
      texte: "Prévisions, Radar et Étoiles lisent la même maille de 15 km sous trois angles : ce qui est prévu, ce qui est observé, et la qualité du ciel nocturne. Celle qui s'ouvre au lancement se choisit dans votre compte."
    },
    {
      id: 'compte', ancre: 'compte', feature: null,
      titre: 'Spots et alertes',
      texte: "Enregistrez des spots avec leur horizon dégagé, et recevez une alerte lorsqu’une cellule orageuse approche d’un département suivi.",
      action: 'compte'   // dernière étape : ouvre réellement la modale (choix validé)
    }
  ];

  // ── Pilotage de la carte ──────────────────────────────────────────────────
  // `map` est un `const` de state.js : un binding lexical GLOBAL, visible depuis les
  // scripts classiques chargés ensuite — mais PAS sur window (piège connu du projet).
  function laCarte() {
    try {
      return (typeof map !== 'undefined' && map && map.getCanvas && map.project) ? map : null;
    } catch (e) { return null; }
  }

  // Mêmes bornes que la grille France du serveur (METEOFRANCE_FRANCE_GRID_BOUNDS).
  var FRANCE_BB = [[-5.25, 41.25], [9.65, 51.15]];
  var cameraInitiale = null;

  function memoriserCamera() {
    var m = laCarte();
    if (!m || cameraInitiale) return;
    try {
      cameraInitiale = { center: m.getCenter(), zoom: m.getZoom(),
                         bearing: m.getBearing(), pitch: m.getPitch() };
    } catch (e) { cameraInitiale = null; }
  }

  function restaurerCamera() {
    var m = laCarte();
    if (!m || !cameraInitiale) return;
    try { m.easeTo({ center: cameraInitiale.center, zoom: cameraInitiale.zoom,
                     bearing: cameraInitiale.bearing, pitch: cameraInitiale.pitch,
                     duration: 600 }); } catch (e) {}
    cameraInitiale = null;
  }

  function cadrerFrance(duree) {
    var m = laCarte();
    if (!m) return;
    var haut = 40, bas = 40;
    try {
      var fr = document.getElementById('timelineDock');
      if (fr && visible(fr)) bas = Math.min(160, fr.getBoundingClientRect().height + 30);
      var bn = document.querySelector('.bnav');
      if (bn && visible(bn)) bas += bn.getBoundingClientRect().height;
    } catch (e) {}
    try {
      m.fitBounds(FRANCE_BB, {
        padding: { top: haut, bottom: bas, left: 30, right: 30 },
        duration: duree === 0 ? 0 : (duree || 800)
      });
    } catch (e) {}
  }

  // Rectangle écran occupé par la France : sert de forme au projecteur de l'étape 1.
  function rectFrance() {
    var m = laCarte();
    if (!m) return null;
    try {
      var a = m.project([FRANCE_BB[0][0], FRANCE_BB[1][1]]);   // ouest / nord
      var b = m.project([FRANCE_BB[1][0], FRANCE_BB[0][1]]);   // est / sud
      var x = Math.min(a.x, b.x), y = Math.min(a.y, b.y);
      var w = Math.abs(b.x - a.x), h = Math.abs(b.y - a.y);
      if (!(w > 40 && h > 40)) return null;
      return { x: x, y: y, width: w, height: h };
    } catch (e) { return null; }
  }

  // La cellule la plus « parlante » visible : le meilleur score de déclenchement.
  function choisirCellule() {
    var m = laCarte();
    if (!m || !m.queryRenderedFeatures) return null;
    try {
      if (!m.getLayer('grid-fill')) return null;
      var feats = m.queryRenderedFeatures({ layers: ['grid-fill'] });
      if (!feats || !feats.length) return null;
      var meilleure = null, meilleurScore = -1;
      for (var i = 0; i < feats.length; i++) {
        var pr = feats[i].properties || {};
        var sc = Number(pr.trigger_score);
        if (!isFinite(sc)) sc = 0;
        if (sc > meilleurScore) { meilleurScore = sc; meilleure = feats[i]; }
      }
      if (!meilleure) meilleure = feats[Math.floor(feats.length / 2)];
      // Les features rendues ne portent PAS lon/lat (vérifié en production : seulement
      // zone, trigger_score, confidence_score et les propriétés de rendu) — on calcule
      // donc le centre depuis la géométrie, et non depuis un coin du polygone.
      var minLon = Infinity, maxLon = -Infinity, minLat = Infinity, maxLat = -Infinity;
      (function parcourir(c) {
        if (!c) return;
        if (typeof c[0] === 'number' && typeof c[1] === 'number') {
          if (c[0] < minLon) minLon = c[0];
          if (c[0] > maxLon) maxLon = c[0];
          if (c[1] < minLat) minLat = c[1];
          if (c[1] > maxLat) maxLat = c[1];
          return;
        }
        for (var k = 0; k < c.length; k++) parcourir(c[k]);
      })(meilleure.geometry && meilleure.geometry.coordinates);
      if (!isFinite(minLon) || !isFinite(minLat)) return null;
      return { lon: (minLon + maxLon) / 2, lat: (minLat + maxLat) / 2,
               zone: (meilleure.properties || {}).zone,
               score: (meilleure.properties || {}).trigger_score };
    } catch (e) { return null; }
  }

  // Zoome sur la cellule puis l'ACTIVE réellement : on dispatche un vrai clic sur le
  // canvas, pour que MapLibre fasse son propre calcul de features et déclenche le
  // gestionnaire de la couche `grid-fill` comme un utilisateur l'aurait fait.
  var celluleActivee = null;
  function activerCellule() {
    var m = laCarte();
    if (!m) return;
    var c = choisirCellule();
    if (!c) return;
    celluleActivee = c;
    try {
      m.easeTo({ center: [c.lon, c.lat], zoom: Math.max(m.getZoom(), 7.6), duration: 900 });
      m.once('moveend', function () {
        try {
          var pt = m.project([c.lon, c.lat]);
          var cible = m.getCanvasContainer();
          var box = cible.getBoundingClientRect();
          var cx = box.left + pt.x, cy = box.top + pt.y;
          ['mousedown', 'mouseup', 'click'].forEach(function (type) {
            cible.dispatchEvent(new MouseEvent(type, {
              bubbles: true, cancelable: true, view: window,
              clientX: cx, clientY: cy, button: 0
            }));
          });
        } catch (e) {}
        setTimeout(function () { replacer(); }, 120);
      });
    } catch (e) {}
  }

  function fermerSelection() {
    var c = document.getElementById('selectionCard');
    if (c) c.classList.remove('visible');
    celluleActivee = null;
  }

  // ── Accessibilité fonctionnelle (mode gratuit à venir) ────────────────────
  // Aujourd'hui tout est accessible. Le jour où les droits par plan existeront, ce
  // sera le SEUL endroit à brancher : renvoyer false masque l'étape et renumérote la
  // visite automatiquement.
  function estAccessible(feature) {
    if (!feature) return true;
    var droits = window.OFDroits;                       // posé plus tard par le gating
    if (!droits || typeof droits.autorise !== 'function') return true;
    try { return droits.autorise(feature) !== false; } catch (e) { return true; }
  }

  // ── Résolution d'ancre ────────────────────────────────────────────────────
  function visible(el) {
    if (!el) return false;
    var cs = getComputedStyle(el);
    if (cs.display === 'none' || cs.visibility === 'hidden' || cs.opacity === '0') return false;
    var r = el.getBoundingClientRect();
    return r.width > 2 && r.height > 2 && r.bottom > 0 && r.top < innerHeight;
  }

  // Bandeau desktop : la clé du pool -> l'identifiant du bouton réel.
  var BTN_DESKTOP = {
    carte: 'forecastPageBtn', radar: 'chasePageBtn', etoiles: 'stargazePageBtn',
    forum: 'forumPageBtn', prev: 'predictionPageBtn', spots: 'spotsPageBtn',
    histo: 'historyPageBtn'
  };

  function resoudre(ancre) {
    if (ancre === 'map') return { el: document.getElementById('map'), plein: true };
    if (ancre === 'france') {
      var rf = rectFrance();
      if (rf) return { rect: rf, doux: true };
      return { el: document.getElementById('map'), plein: true };   // repli sûr
    }
    if (ancre === 'selection') {
      var sc = document.getElementById('selectionCard');
      if (visible(sc)) return { el: sc };
      // la fiche n'est pas (encore) là : on éclaire la cellule visée, sinon le centre
      var m = laCarte();
      if (m && celluleActivee) {
        try {
          var pt = m.project([celluleActivee.lon, celluleActivee.lat]);
          var bx = m.getCanvasContainer().getBoundingClientRect();
          return { rect: { x: bx.left + pt.x - 46, y: bx.top + pt.y - 34, width: 92, height: 68 }, doux: true };
        } catch (e) {}
      }
      return { el: celluleAuCentre(), doux: true };
    }
    if (ancre === 'frise') {
      var f = document.getElementById('timelineDock');
      return { el: visible(f) ? f : null };
    }
    if (ancre === 'cellule') return { el: celluleAuCentre(), doux: true };
    if (ancre === 'compte') {
      var av = document.getElementById('bnavAvatar');
      if (visible(av)) return { el: av };
      var ab = document.getElementById('accountBtn');
      return { el: visible(ab) ? ab : null };
    }
    if (ancre === 'rail') {
      // Le premier rail gauche visible : chaque carte a le sien.
      var rails = ['spotsRail', 'chaseLayerRail', 'stargazeLayerRail'];
      for (var i = 0; i < rails.length; i++) {
        var el = document.getElementById(rails[i]);
        if (visible(el)) return { el: el, large: true };
      }
      return { el: null };
    }
    if (ancre === 'cartes') {
      // Union des entrées de navigation des trois cartes principales. En bandeau
      // desktop il n'y a pas de bouton « Prévisions » (c'est la carte par défaut,
      // affichée quand aucune page n'est ouverte) : on unit ce qu'on trouve.
      var sels = ['.bnav-tab[data-nav="carte"]', '.bnav-tab[data-nav="radar"]',
                  '.bnav-tab[data-nav="etoiles"]',
                  '#forecastPageBtn', '#chasePageBtn', '#stargazePageBtn'];
      var x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity, n = 0;
      for (var k = 0; k < sels.length; k++) {
        var e2 = document.querySelector(sels[k]);
        if (!visible(e2)) continue;
        var rr = e2.getBoundingClientRect();
        x0 = Math.min(x0, rr.left); y0 = Math.min(y0, rr.top);
        x1 = Math.max(x1, rr.right); y1 = Math.max(y1, rr.bottom);
        n++;
      }
      if (n < 2) return { el: null };          // pas de quoi parler de « trois cartes »
      return { rect: { x: x0, y: y0, width: x1 - x0, height: y1 - y0 } };
    }
    if (ancre.indexOf('nav:') === 0) {
      var cle = ancre.slice(4);
      // 1) barre du bas : l'onglet s'il est épinglé, sinon « Plus » qui le contient
      var onglet = document.querySelector('.bnav-tab[data-nav="' + cle + '"]');
      if (visible(onglet)) return { el: onglet };
      var plus = document.querySelector('.bnav-tab[data-nav="plus"]');
      if (visible(plus)) return { el: plus, repli: true };
      // 2) bandeau desktop
      var id = BTN_DESKTOP[cle];
      var b = id && document.getElementById(id);
      if (visible(b)) return { el: b };
    }
    return { el: null };
  }

  // La grille n'expose pas de noeud par cellule : on éclaire une zone au centre de la
  // carte, là où l'utilisateur ira naturellement cliquer.
  function celluleAuCentre() {
    var m = document.getElementById('map');
    if (!m) return null;
    var r = m.getBoundingClientRect();
    var faux = document.getElementById('ofTourCible');
    if (!faux) {
      faux = document.createElement('div');
      faux.id = 'ofTourCible';
      faux.className = 'of-tour-cible';
      document.body.appendChild(faux);
    }
    var w = Math.min(120, r.width * 0.22), h = Math.min(96, r.height * 0.16);
    faux.style.left = (r.x + r.width / 2 - w / 2) + 'px';
    faux.style.top = (r.y + r.height / 2 - h / 2) + 'px';
    faux.style.width = w + 'px';
    faux.style.height = h + 'px';
    return faux;
  }

  // ── État ──────────────────────────────────────────────────────────────────
  var actives = [], pos = 0, ouvert = false;
  var scrim, trou, bulle, elNum, elTitre, elTexte, elPoints, btnPrec, btnSuiv, btnPasser;
  var dernierFocus = null;

  function construire() {
    if (scrim) return;
    scrim = document.createElement('div');
    scrim.className = 'of-tour';
    scrim.innerHTML =
      '<div class="of-tour-trou" id="ofTourTrou"></div>' +
      '<div class="of-tour-bulle" id="ofTourBulle" role="dialog" aria-modal="true" aria-labelledby="ofTourTitre">' +
        '<div class="of-tour-num" id="ofTourNum"></div>' +
        '<h2 class="of-tour-titre" id="ofTourTitre"></h2>' +
        '<p class="of-tour-texte" id="ofTourTexte" aria-live="polite"></p>' +
        '<div class="of-tour-points" id="ofTourPoints" aria-hidden="true"></div>' +
        '<div class="of-tour-actions">' +
          '<button type="button" class="of-tour-btn" id="ofTourPrec">Précédent</button>' +
          '<button type="button" class="of-tour-btn of-tour-btn-primaire" id="ofTourSuiv">Suivant</button>' +
          '<button type="button" class="of-tour-passer" id="ofTourPasser">Passer</button>' +
        '</div>' +
      '</div>';
    document.body.appendChild(scrim);
    trou = document.getElementById('ofTourTrou');
    bulle = document.getElementById('ofTourBulle');
    elNum = document.getElementById('ofTourNum');
    elTitre = document.getElementById('ofTourTitre');
    elTexte = document.getElementById('ofTourTexte');
    elPoints = document.getElementById('ofTourPoints');
    btnPrec = document.getElementById('ofTourPrec');
    btnSuiv = document.getElementById('ofTourSuiv');
    btnPasser = document.getElementById('ofTourPasser');

    btnPrec.addEventListener('click', function () { if (pos > 0) { allerA(pos - 1); } });
    btnSuiv.addEventListener('click', function () {
      if (pos >= actives.length - 1) { terminer(true); return; }
      allerA(pos + 1);
    });
    btnPasser.addEventListener('click', function () { terminer(false); });
    scrim.addEventListener('pointerdown', function (ev) {
      if (bulle.contains(ev.target)) return;
      // Cliquer l'élément mis en avant est le geste NATUREL : il fait avancer la visite
      // plutôt que de la fermer. Fermer sur ce clic-là serait vécu comme un raté.
      var t = trou.getBoundingClientRect();
      if (ev.clientX >= t.left && ev.clientX <= t.right &&
          ev.clientY >= t.top && ev.clientY <= t.bottom) {
        btnSuiv.click();
        return;
      }
      terminer(false);                                   // clic ailleurs = sortie
    });
    document.addEventListener('keydown', auClavier, true);
    addEventListener('resize', replacer, { passive: true });
    addEventListener('orientationchange', replacer, { passive: true });
  }

  function auClavier(ev) {
    if (!ouvert) return;
    if (ev.key === 'Escape') { ev.preventDefault(); terminer(false); return; }
    if (ev.key === 'ArrowRight') { ev.preventDefault(); btnSuiv.click(); return; }
    if (ev.key === 'ArrowLeft') { ev.preventDefault(); btnPrec.click(); return; }
    if (ev.key === 'Tab') {                              // focus piégé dans la bulle
      var f = bulle.querySelectorAll('button:not([disabled])');
      if (!f.length) return;
      var prem = f[0], der = f[f.length - 1];
      if (ev.shiftKey && document.activeElement === prem) { ev.preventDefault(); der.focus(); }
      else if (!ev.shiftKey && document.activeElement === der) { ev.preventDefault(); prem.focus(); }
    }
  }

  var replaceRaf = 0;
  function replacer() {
    if (!ouvert) return;
    cancelAnimationFrame(replaceRaf);
    replaceRaf = requestAnimationFrame(function () { peindre(true); });
  }

  // ── Rendu ─────────────────────────────────────────────────────────────────
  function peindre(sansAnim) {
    var e = actives[pos];
    if (!e) { terminer(false); return; }
    var r = resoudre(e.ancre);
    if (!r.el && !r.rect) {                        // ancre disparue en cours de route
      actives.splice(pos, 1);
      if (!actives.length) { terminer(false); return; }
      if (pos >= actives.length) pos = actives.length - 1;
      peindre(true);
      return;
    }
    var b = r.rect || r.el.getBoundingClientRect();
    var marge = r.plein ? -Math.min(b.width, b.height) * 0.28
              : (r.large ? 16 : (r.doux ? 4 : 8));
    var x = b.x - marge, y = b.y - marge, w = b.width + marge * 2, h = b.height + marge * 2;

    if (sansAnim) trou.style.transition = 'none';
    trou.style.left = x + 'px'; trou.style.top = y + 'px';
    trou.style.width = w + 'px'; trou.style.height = h + 'px';
    if (sansAnim) { void trou.offsetWidth; trou.style.transition = ''; }

    elNum.textContent = 'Étape ' + (pos + 1) + ' sur ' + actives.length;
    elTitre.textContent = e.titre;
    elTexte.textContent = e.texte + (r.repli ? ' — accessible depuis « Plus ».' : '');
    var pts = '';
    for (var i = 0; i < actives.length; i++) pts += '<i class="' + (i === pos ? 'on' : '') + '"></i>';
    elPoints.innerHTML = pts;
    btnPrec.disabled = pos === 0;
    btnSuiv.textContent = pos === actives.length - 1 ? 'Terminer' : 'Suivant';

    // Placement de la bulle : dessous, sinon dessus, sinon SUR LE CÔTÉ. Le côté est
    // indispensable en téléphone paysage (~390 px de haut) où ni dessous ni dessus ne
    // tiennent : sans lui la bulle finissait par recouvrir l'élément qu'elle décrit.
    var bw = bulle.offsetWidth || 300, bh = bulle.offsetHeight || 170, m = 12;
    var bx, by;
    if (r.plein) {
      bx = innerWidth / 2 - bw / 2;
      by = innerHeight / 2 - bh / 2;
    } else if (y + h + m + bh <= innerHeight - m) {          // dessous
      bx = x + w / 2 - bw / 2; by = y + h + m;
    } else if (y - m - bh >= m) {                            // dessus
      bx = x + w / 2 - bw / 2; by = y - bh - m;
    } else if (x + w + m + bw <= innerWidth - m) {           // à droite
      bx = x + w + m; by = y + h / 2 - bh / 2;
    } else if (x - m - bw >= m) {                            // à gauche
      bx = x - bw - m; by = y + h / 2 - bh / 2;
    } else {                                                 // dernier recours
      bx = x + w / 2 - bw / 2; by = y + h + m;
    }
    bulle.style.left = Math.max(m, Math.min(bx, innerWidth - bw - m)) + 'px';
    bulle.style.top = Math.max(m, Math.min(by, innerHeight - bh - m)) + 'px';
  }

  // Changement d'étape : on quitte proprement l'étape courante (une étape a pu
  // modifier la carte) avant d'entrer dans la suivante.
  function allerA(n) {
    var courante = actives[pos];
    if (courante && typeof courante.sortir === 'function') {
      try { courante.sortir(); } catch (e) {}
    }
    pos = n;
    var suivante = actives[pos];
    peindre();
    if (suivante && typeof suivante.entrer === 'function') {
      try { suivante.entrer(); } catch (e) {}
    }
  }

  // ── Cycle de vie ──────────────────────────────────────────────────────────
  function etapesActives() {
    var out = [];
    for (var i = 0; i < ETAPES.length; i++) {
      var e = ETAPES[i];
      if (!estAccessible(e.feature)) continue;      // fonction hors plan -> masquée
      var a = resoudre(e.ancre);
      if (!a.el && !a.rect) continue;               // ancre absente -> masquée
      out.push(e);
    }
    return out;
  }

  function demarrer() {
    if (ouvert) return;
    actives = etapesActives();
    if (actives.length < 2) return;                 // rien à montrer : on n'ouvre pas
    construire();
    dernierFocus = document.activeElement;
    pos = 0; ouvert = true;
    document.body.classList.add('of-tour-ouvert');
    scrim.classList.add('visible');
    peindre(true);
    if (actives[0] && typeof actives[0].entrer === 'function') {
      try { actives[0].entrer(); } catch (e) {}
    }
    // La carte bouge pendant ~900 ms : on resuit l'ancre le temps du recadrage.
    var t0 = Date.now();
    (function suivre() {
      if (!ouvert || Date.now() - t0 > 1400) return;
      peindre(true);
      requestAnimationFrame(suivre);
    })();
    setTimeout(function () { try { btnSuiv.focus(); } catch (e) {} }, 40);
  }

  function terminer(jusquAuBout) {
    if (!ouvert) return;
    ouvert = false;
    scrim.classList.remove('visible');
    document.body.classList.remove('of-tour-ouvert');
    var cible = document.getElementById('ofTourCible');
    if (cible) cible.remove();
    // Une étape a pu zoomer la carte ou ouvrir une fiche : on rend l'application
    // dans l'état où on l'a trouvée, quelle que soit l'étape de sortie.
    fermerSelection();
    restaurerCamera();
    marquerVu();
    try { if (dernierFocus && dernierFocus.focus) dernierFocus.focus(); } catch (e) {}
    // Choix validé : la visite peut se terminer sur une demande.
    if (jusquAuBout) {
      var b = document.getElementById('bnavAvatar') || document.getElementById('accountBtn');
      if (b) setTimeout(function () { b.click(); }, 220);
    }
  }

  // ── Mémorisation ──────────────────────────────────────────────────────────
  function dejaVu() {
    try { if (localStorage.getItem(LS_VU) === '1') return true; } catch (e) {}
    return false;
  }
  function marquerVu() {
    try { localStorage.setItem(LS_VU, '1'); } catch (e) {}
    // Miroir côté compte : ne pas relancer la visite d'un appareil à l'autre.
    // On ne POST QUE si l'utilisateur est connecté : sinon /prefs répond 401 et
    // remplit la console de tous les visiteurs anonymes — c'est-à-dire la majorité.
    fetch('/api/account/me', { credentials: 'same-origin' })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (d) {
        if (!d || !d.authenticated) return null;
        return fetch('/api/account/prefs', {
          method: 'POST', credentials: 'same-origin',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ tour_done: true })
        });
      })
      .catch(function () {});
  }

  // ── Démarrage automatique ─────────────────────────────────────────────────
  // Jamais pendant le splash : on attend que le loader ait disparu ET que la carte
  // ait une taille réelle, sinon le projecteur éclairerait un écran de chargement.
  function pret(cb) {
    var essais = 0;
    (function boucle() {
      var loader = document.getElementById('appLoader');
      var chargement = loader && getComputedStyle(loader).display !== 'none'
        && loader.getAttribute('aria-hidden') !== 'true';
      var m = document.getElementById('map');
      var carteOk = m && m.getBoundingClientRect().width > 200;
      if (!chargement && carteOk) { cb(); return; }
      if (++essais > 100) return;                   // ~20 s : on renonce en silence
      setTimeout(boucle, 200);
    })();
  }

  // Le compte fait autorité sur le localStorage : un utilisateur qui a fait la visite
  // sur son téléphone ne doit pas la reprendre sur sa tablette.
  function dejaVuCompte(cb) {
    fetch('/api/account/me', { credentials: 'same-origin' })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (d) {
        var p = d && d.user && d.user.prefs;
        cb(!!(p && p.tour_done));
      })
      .catch(function () { cb(false); });
  }

  function auto() {
    if (dejaVu()) return;
    dejaVuCompte(function (vu) {
      if (vu) { try { localStorage.setItem(LS_VU, '1'); } catch (e) {} return; }
      pret(function () { setTimeout(demarrer, 500); });
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', auto);
  } else {
    auto();
  }

  // Bouton « Revoir la visite » du tiroir d'aide : on ferme le tiroir d'abord, sinon
  // il resterait au-dessus de la nappe et masquerait les ancres.
  document.addEventListener('click', function (ev) {
    var b = ev.target && ev.target.closest && ev.target.closest('#replayTourBtn');
    if (!b) return;
    ev.preventDefault();
    var fermer = document.getElementById('closeDrawerBtn');
    if (fermer) fermer.click();
    setTimeout(function () { pos = 0; demarrer(); }, 260);
  });

  // API publique : « Revoir la visite » depuis le tiroir d'aide.
  window.OFTour = {
    demarrer: function () { pos = 0; demarrer(); },
    reinitialiser: function () { try { localStorage.removeItem(LS_VU); } catch (e) {} },
    dejaVu: dejaVu
  };
})();
