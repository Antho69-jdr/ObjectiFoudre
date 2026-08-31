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
      id: 'carte', ancre: 'map', feature: null,
      titre: 'La grille de probabilité',
      texte: "Chaque cellule couvre 15 km et porte une probabilité de déclenchement orageux, calculée à partir du modèle AROME de Météo-France. L'échelle va du bleu au rouge."
    },
    {
      id: 'cellule', ancre: 'cellule', feature: 'cell_detail',
      titre: 'Le détail d’une cellule',
      texte: "Ouvrez une cellule pour obtenir le détail horaire : instabilité, humidité, cisaillement, et la confiance associée au score."
    },
    {
      id: 'frise', ancre: 'frise', feature: null,
      titre: 'La frise horaire',
      texte: "La frise parcourt les créneaux de la journée. La carte est recalculée à chaque pas."
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
      id: 'compte', ancre: 'compte', feature: null,
      titre: 'Spots et alertes',
      texte: "Enregistrez des spots avec leur horizon dégagé, et recevez une alerte lorsqu’une cellule orageuse approche d’un département suivi.",
      action: 'compte'   // dernière étape : ouvre réellement la modale (choix validé)
    }
  ];

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
    carte: null, radar: 'chasePageBtn', etoiles: 'stargazePageBtn',
    forum: 'forumPageBtn', prev: 'predictionPageBtn', spots: 'spotsPageBtn',
    histo: 'historyPageBtn'
  };

  function resoudre(ancre) {
    if (ancre === 'map') return { el: document.getElementById('map'), plein: true };
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

    btnPrec.addEventListener('click', function () { if (pos > 0) { pos--; peindre(); } });
    btnSuiv.addEventListener('click', function () {
      if (pos >= actives.length - 1) { terminer(true); return; }
      pos++; peindre();
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
    if (!r.el) {                                   // ancre disparue en cours de route
      actives.splice(pos, 1);
      if (!actives.length) { terminer(false); return; }
      if (pos >= actives.length) pos = actives.length - 1;
      peindre(true);
      return;
    }
    var b = r.el.getBoundingClientRect();
    var marge = r.plein ? -Math.min(b.width, b.height) * 0.28 : (r.doux ? 4 : 8);
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

  // ── Cycle de vie ──────────────────────────────────────────────────────────
  function etapesActives() {
    var out = [];
    for (var i = 0; i < ETAPES.length; i++) {
      var e = ETAPES[i];
      if (!estAccessible(e.feature)) continue;      // fonction hors plan -> masquée
      if (!resoudre(e.ancre).el) continue;          // ancre absente -> masquée
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
    setTimeout(function () { try { btnSuiv.focus(); } catch (e) {} }, 40);
  }

  function terminer(jusquAuBout) {
    if (!ouvert) return;
    ouvert = false;
    scrim.classList.remove('visible');
    document.body.classList.remove('of-tour-ouvert');
    var cible = document.getElementById('ofTourCible');
    if (cible) cible.remove();
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
