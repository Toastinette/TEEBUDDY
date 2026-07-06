/* ============================================================================
   TEEBUDDY — LOGIQUE APPLICATIVE
   Navigation, Firebase, salon, scores. La "mécanique" de l'app.
   Les données (parcours, modes, config Firebase) sont dans config.js.
   Le design est dans style.css.
============================================================================ */

/* ── Firebase init (protégé) ───────────────────────────────────────────── */
var DB = null, FB_OK = false;
try {
  firebase.initializeApp(window.FIREBASE_CONFIG);
  DB = firebase.firestore();
  FB_OK = true;
} catch (e) { console.error("Firebase init:", e); }

/* Raccourcis vers la config */
var COURSES = window.COURSES || [];
var MODES   = window.MODES || {};
var TEE_COLORS = {
  blanc: { label: 'Blanc' },
  jaune: { label: 'Jaune' },
  bleu:  { label: 'Bleu' },
  rouge: { label: 'Rouge' }
};

/* ── État global ────────────────────────────────────────────────────────── */
var S = {
  player: null,       // { prenom, nom, index, teeColor, pid, avatar? }
  game:   null,       // document Firestore de la partie
  gameId: null,       // identifiant du document (code court)
  hole:   0,
  hist:   ['s-home'],
  extras: [],         // joueurs ajoutés manuellement (1 seul téléphone)
  unsub:  null,       // listener partie en cours
  unsubList: null,    // listener liste des parties ouvertes
  notified: {},
  started: false,
  spectating: false,  // true si on regarde une partie sans y jouer
  hbTimer: null,      // battement de cœur spectateur
  myPids: [],         // pids des joueurs gérés sur CE téléphone (proprio + ajoutés)
  editable: [],       // unités de score modifiables sur ce téléphone (joueurs ou équipes)
  activeKey: null,    // clé de l'unité de score actuellement saisie
  local: {},          // copie locale des scores par clé d'unité { key: [18] }
  writeTs: {},        // horodatage des dernières écritures (anti-écrasement)
  netView: false,     // affichage des cartes en net (coups rendus) au lieu de brut
  settings: { vibration: true }
};
var selCourse = (COURSES[0] && COURSES[0].id) || null;

/* ── Banque de messages (variés, marrants, tirés au hasard) ────────────── */
var MSG = {
  condor:    ['{n} entre dans la LÉGENDE 🐉', 'Un condor ?! {n}, c\'est irréel', '{n} vient de défier les lois du golf 🤯'],
  albatross: ['ALBATROS pour {n} ! 🦅 chapeau bas', '{n} signe un albatros, respect total', 'Inarrêtable, {n} plante un albatros'],
  eagle:     ['🦅 EAGLE ! {n} est en feu', 'Quel eagle {n}, magnifique', '{n} plante un eagle de patron', 'Eagle ! {n} régale tout le monde'],
  birdie:    ['🐦 Birdie pour {n} !', 'Joli birdie {n} 👏', '{n} gratte un birdie, la classe', 'Birdie tranquille pour {n} 🔥', '{n} pose un birdie comme un pro'],
  par:       ['Par solide {n} 🟢', '{n} fait le job, par', 'Tranquille, {n} assure le par', 'Par carré pour {n} 👌'],
  parComeback: ['Enfin te revoilà dans la course {n} ! 💪', 'Ouf, un par {n}, ça repart', '{n} stoppe l\'hémorragie avec un par 😅', 'Le par du soulagement pour {n}', 'Bon retour parmi les vivants {n} ⛳'],
  bogey:     ['Bogey pour {n}, on se rattrape', '{n} lâche un bogey, rien de grave', 'Petit bogey {n}, focus 🎯', '{n} concède un bogey, la suite sera meilleure'],
  double:    ['Double bogey {n}... ça arrive 😬', 'Aïe, +2 pour {n}', '{n} prend un double, on respire et on repart', 'Pas le trou de {n} 🙈'],
  triple:    ['Triple bogey {n}... le trou était piégé 😵', 'Ouch, +3 pour {n}, on efface', '{n} a laissé des plumes sur ce trou 🪶', 'Trou compliqué pour {n}, on tourne la page'],
  worse:     ['Trou cauchemar pour {n} 🙈 on oublie', '{n}... ce trou restera entre nous 🤐', 'Gros carton pour {n}, la revanche au prochain', 'Aïe aïe aïe {n}, on respire un coup'],
  croix:     ['Croix pour {n} ❌ on passe à autre chose', '{n} ramasse, croix sur le trou', 'Balle perdue ? Croix pour {n}, suivant ! 🏌️', '{n} fait une croix, ça nettoie la tête']
};
function pickMsg(type, name) {
  var arr = MSG[type] || MSG.par;
  return arr[Math.floor(Math.random() * arr.length)].replace(/\{n\}/g, name || '');
}

/* ── Boot ───────────────────────────────────────────────────────────────── */
function boot() {
  applyLogos();
  addFooters();
  loadLocalSettings();
  initSheetGestures();
  if (!FB_OK) { showScreen('s-home'); toast('⚠️ Connexion Firebase indisponible'); }

  var p = lget('tb_player');
  if (p) { S.player = p; updatePlayerUI(); showScreen('s-home'); }
  else showScreen('s-onboard');

  var sess = lget('tb_session');
  if (sess && sess.id) {
    S.gameId = sess.id;
    S.hole   = sess.hole || 0;
    S.myPids = sess.myPids || (S.player ? [S.player.pid] : []);
    S.started = true;
    if (FB_OK) attachGameListener(sess.id);
  }

  buildCourseList();
  renderPlayerList();
  renderHomeParties();
  if (FB_OK) { attachOpenGamesListener(); loadCoursesFromDB(); loadAppSettings(); }
  // Rafraîchit l'affichage des compteurs de spectateurs (retire les inactifs)
  setInterval(function () { if (S.game) updateViewerDisplays(); }, 15000);
}
function applyLogos() {
  var l = document.querySelectorAll('img.logo');
  for (var i = 0; i < l.length; i++) l[i].src = 'logo.png';
}

/* Ajoute le footer « Powered by Hook & Slice » au bas de chaque écran */
function addFooters() {
  var html = '<img src="hs-logo.png" class="hs-logo" alt=""><img src="hs-text.png" class="hs-text" alt="Powered by Hook & Slice">';
  var screens = document.querySelectorAll('.screen');
  for (var i = 0; i < screens.length; i++) {
    if (screens[i].id === 's-game') continue;
    var f = document.createElement('div');
    f.className = 'footer';
    f.innerHTML = html;
    screens[i].appendChild(f);
  }
}

/* Menu contextuel : masque les options de partie quand on n'est dans aucune partie */
function updateMenu() {
  var inGame = !!S.gameId;
  ['menu-scores', 'menu-settings', 'menu-sep', 'menu-end'].forEach(function (id) {
    var el = document.getElementById(id);
    if (el) el.style.display = inGame ? '' : 'none';
  });
}

/* ════════════════════════════════════════════════════════════════════════
   SCORING — unités de score (joueur ou équipe), accès, croix, match play
   Une "unité" = ce dont on remplit la carte : un joueur (Stroke), ou une
   équipe (Scramble/MMB, et Match Play en 2v2). Match Play 1v1 = 2 joueurs.
════════════════════════════════════════════════════════════════════════ */

/* true si le mode se joue par équipes (carte partagée) */
function teamBased(game) {
  if (!game) return false;
  var m = MODES[game.mode] || {};
  if (m.teams) return true;                       // scramble, mmb
  if (m.matchplay && (game.teams || []).length >= 2) return true; // match play 2v2
  return false;
}

/* Liste des unités de score de la partie (pour le classement et la saisie) */
function scoringUnits(game) {
  game = game || S.game;
  if (!game) return [];
  if (teamBased(game)) {
    return (game.teams || []).map(function (t, i) {
      var p0 = t.players[0], p1 = t.players[1];
      return {
        type: 'team', key: t.id || ('team' + i),
        label: (p0 ? p0.prenom : '?') + ' & ' + (p1 ? p1.prenom : '?'),
        players: t.players.filter(Boolean), team: t, p: p0
      };
    });
  }
  return (game.players || []).map(function (p) {
    return { type: 'player', key: p.pid, label: p.prenom + (p.nom ? ' ' + p.nom[0] + '.' : ''), players: [p], player: p, p: p };
  });
}

/* Recalcule les unités modifiables sur ce téléphone + l'unité active + cache local */
function syncScoringState() {
  if (!S.game) return;
  var units = scoringUnits(S.game);
  S.editable = units.filter(function (u) {
    return u.players.some(function (p) { return S.myPids.indexOf(p.pid) >= 0; });
  });
  if (!S.activeKey || !S.editable.some(function (u) { return u.key === S.activeKey; })) {
    S.activeKey = S.editable[0] ? S.editable[0].key : null;
  }
  // Synchronise le cache local depuis Firestore, sauf écritures très récentes
  var scores = S.game.scores || {};
  S.editable.forEach(function (u) {
    var k = u.key;
    if (Date.now() - (S.writeTs[k] || 0) < 2500) return;
    S.local[k] = (scores[k] ? scores[k].slice() : Array(18).fill(null));
  });
}

/* Scores d'une unité : cache local prioritaire (pour les unités qu'on édite),
   sinon valeur Firestore */
function getScores(key) {
  if (key && S.local[key]) return S.local[key];
  if (S.game && S.game.scores && S.game.scores[key]) return S.game.scores[key];
  return Array(18).fill(null);
}

/* Un trou est "décidé" s'il a un chiffre ou une croix */
function isDecided(v) { return typeof v === 'number' || v === 'X'; }
function countPlayed(arr) { return arr.filter(function (s) { return s !== null && s !== undefined; }).length; }

/* Valeur de croix de la partie (par + cette valeur en Stroke Play) */
/* Valeur de croix : réglage GLOBAL de l'app (modifiable dans l'admin),
   chargé au démarrage. Par défaut 4. */
var APP_CROIX = 4;
function gCroixVal() { return (typeof APP_CROIX === 'number') ? APP_CROIX : 4; }
/* Valeur en coups d'un trou : chiffre, ou par+croix si croix, ou null si pas joué */
function holeVal(v, par, croixV) {
  if (typeof v === 'number') return v;
  if (v === 'X') return par + (typeof croixV === 'number' ? croixV : 4);
  return null;
}
/* Total brut (la croix compte comme par + valeur) */
function totalStrokes(scores, pars, croixV) {
  var t = 0; for (var i = 0; i < scores.length; i++) { var hv = holeVal(scores[i], pars[i], croixV); if (hv !== null) t += hv; } return t;
}
/* Somme des pars des trous joués (chiffre ou croix) */
function parPlayed(scores, pars) {
  var s = 0; for (var i = 0; i < scores.length; i++) { if (scores[i] !== null && scores[i] !== undefined) s += pars[i]; } return s;
}
/* Conservé pour compat (somme des seuls chiffres) */
function sumNums(arr) { return arr.reduce(function (a, b) { return a + (typeof b === 'number' ? b : 0); }, 0); }

/* ── Handicap : coups rendus ───────────────────────────────────────────── */
/* Handicap (difficulté 1-18) des trous de la partie, ou null si non renseigné */
function gameHcp() {
  return (S.game && S.game.courseHcp && S.game.courseHcp.length === 18) ? S.game.courseHcp : null;
}
function validTeeColor(c) {
  return TEE_COLORS[c] ? c : 'jaune';
}
function teeLabel(c) {
  c = validTeeColor(c);
  return TEE_COLORS[c].label;
}
function selectTeeColor(prefix, color) {
  color = validTeeColor(color);
  Object.keys(TEE_COLORS).forEach(function (c) {
    var el = document.getElementById(prefix + '-tee-' + c);
    if (el) el.classList.toggle('active', c === color);
  });
  var hidden = document.getElementById(prefix + '-tee');
  if (hidden) hidden.value = color;
}
function courseHandicap(index, player) {
  var ix = parseFloat(index) || 0;
  var color = validTeeColor(player && player.teeColor);
  var ratings = S.game && S.game.teeRatings ? S.game.teeRatings[color] : null;
  var slope = ratings && parseFloat(ratings.slope);
  var cr = ratings && parseFloat(ratings.courseRating || ratings.rating || ratings.cr);
  var par = ratings && parseFloat(ratings.par || S.game.parTotal);
  if (isFinite(slope) && isFinite(cr) && isFinite(par) && slope > 0) {
    return Math.max(0, Math.round(ix * slope / 113 + (cr - par)));
  }
  return Math.max(0, Math.round(ix));
}
/* Tableau (18) des coups rendus par trou pour un index donné.
   Coups = handicap de parcours, réparti du trou le plus dur (hcp 1) au plus facile,
   avec 2e tour si le joueur reçoit plus de 18 coups. */
function strokesArray(index, player) {
  var arr = Array(18).fill(0);
  var hcp = gameHcp(); if (!hcp) return arr;
  var recv = courseHandicap(index, player);
  var base = Math.floor(recv / 18), r = recv % 18;
  for (var i = 0; i < 18; i++) { arr[i] = base + (hcp[i] <= r ? 1 : 0); }
  return arr;
}
/* Totaux d'une unité, en brut ou net */
function unitTotals(scores, pars, strokes, croixV, net) {
  var tot = 0, n = 0, parP = 0;
  for (var i = 0; i < 18; i++) {
    var v = scores[i]; if (v === null || v === undefined) continue;
    n++; parP += pars[i];
    var gross = holeVal(v, pars[i], croixV);
    tot += net ? (gross - (strokes ? strokes[i] : 0)) : gross;
  }
  return { n: n, total: tot, ecart: n > 0 ? tot - parP : 9999 };
}
/* Le mode courant peut-il afficher le net ? (Stroke Play uniquement, hcp dispo) */
function netAvailable() {
  return S.game && S.game.mode === 'stroke' && !!gameHcp();
}

/* ── Stableford ────────────────────────────────────────────────────────── */
/* Points d'un trou : 2 - (net - par), plancher 0. Croix/double+ = 0. */
function holeStableford(v, par, st, croixV) {
  if (v === null || v === undefined) return null;
  var net = holeVal(v, par, croixV) - (st || 0);
  return Math.max(0, 2 - (net - par));
}
function stablefordTotal(scores, pars, strokes, croixV) {
  var t = 0, n = 0;
  for (var i = 0; i < 18; i++) {
    var p = holeStableford(scores[i], pars[i], strokes ? strokes[i] : 0, croixV);
    if (p !== null) { t += p; n++; }
  }
  return { total: t, n: n };
}

/* Match Play : différence de trous gagnés (positif = A mène) */
function matchPlayDiff(aScores, bScores, pars) {
  var aWins = 0, bWins = 0;
  for (var h = 0; h < 18; h++) {
    var sa = aScores[h], sb = bScores[h];
    if (!isDecided(sa) || !isDecided(sb)) continue;   // trou pas encore joué par les deux
    if (sa === 'X' && sb === 'X') continue;            // les deux abandonnent → partagé
    if (sa === 'X') { bWins++; continue; }
    if (sb === 'X') { aWins++; continue; }
    if (sa < sb) aWins++; else if (sb < sa) bWins++;   // égalité = partagé
  }
  return aWins - bWins;
}
function mpLabel(diff) {
  if (diff === 0) return 'ALL SQUARE';
  return Math.abs(diff) + (diff > 0 ? ' UP' : ' DOWN');
}

/* Charge les réglages généraux (valeur de croix) et écoute les changements */
function loadAppSettings() {
  DB.collection('settings').doc('general').onSnapshot(function (snap) {
    if (snap.exists) {
      var s = snap.data();
      if (typeof s.croixValue === 'number') {
        APP_CROIX = s.croixValue;
        if (isActive('s-scores')) refreshScores();
        if (isActive('s-game')) refreshGameUI();
      }
    }
  }, function (e) { console.error('settings', e); });
}

/* Charge les parcours depuis Firestore (gérés via la page admin).
   Fusionne avec ceux de config.js : Firestore prioritaire. */
function loadCoursesFromDB() {
  DB.collection('courses').get().then(function (snap) {
    var dbCourses = [];
    snap.forEach(function (doc) { var d = doc.data(); d.id = doc.id; dbCourses.push(d); });
    if (dbCourses.length > 0) {
      var ids = dbCourses.map(function (c) { return c.id; });
      var fromConfig = (window.COURSES || []).filter(function (c) { return ids.indexOf(c.id) < 0; });
      COURSES = dbCourses.concat(fromConfig);
      COURSES.sort(function (a, b) { return (a.nom || '').localeCompare(b.nom || ''); });
      buildCourseList();
    }
  }).catch(function (e) { console.error('courses', e); });
}
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
else boot();

/* ── Navigation ─────────────────────────────────────────────────────────── */
function showScreen(id) {
  var sc = document.querySelectorAll('.screen');
  for (var i = 0; i < sc.length; i++) sc[i].classList.remove('active');
  var el = document.getElementById(id);
  if (el) { el.classList.add('active'); el.scrollTop = 0; }
  updateSheetDock(id);
  if (S.hist[S.hist.length - 1] !== id) S.hist.push(id);
  if (id === 's-scores') refreshScores();
  if (id === 's-game')   refreshGameUI();
  if (id === 's-profil') fillProfilForm();
  if (id === 's-salon')  renderSalon();
  if (id === 's-settings') renderSettings();
  if (id === 's-menu')   updateMenu();
}
function go(id) { showScreen(id); }
function back() {
  if (S.hist.length > 1) {
    S.hist.pop();
    var prev = S.hist[S.hist.length - 1];
    var sc = document.querySelectorAll('.screen');
    for (var i = 0; i < sc.length; i++) sc[i].classList.remove('active');
    var el = document.getElementById(prev);
    if (el) { el.classList.add('active'); el.scrollTop = 0; }
    updateSheetDock(prev);
    if (prev === 's-game')   refreshGameUI();
    if (prev === 's-scores') refreshScores();
    if (prev === 's-salon')  renderSalon();
  } else go('s-home');
}

/* ── Avatar (compression côté navigateur) ──────────────────────────────── */
function onAvatarPick(input) {
  var file = input.files && input.files[0];
  if (!file) return;
  if (file.type.indexOf('image/') !== 0) { toast('Choisis une image'); return; }
  var reader = new FileReader();
  reader.onload = function (e) {
    var img = new Image();
    img.onload = function () {
      var size = 128;
      var cv = document.createElement('canvas'); cv.width = size; cv.height = size;
      var ctx = cv.getContext('2d');
      var min = Math.min(img.width, img.height);
      var sx = (img.width - min) / 2, sy = (img.height - min) / 2;
      ctx.drawImage(img, sx, sy, min, min, 0, 0, size, size);
      var q = 0.6, url = cv.toDataURL('image/jpeg', q);
      while (url.length > 16000 && q > 0.3) { q -= 0.1; url = cv.toDataURL('image/jpeg', q); }
      if (!S.player) S.player = {};
      S.player.avatar = url;
      lset('tb_player', S.player);
      updatePlayerUI(); fillProfilForm();
      toast('Photo ajoutée ✓', true);
    };
    img.src = e.target.result;
  };
  reader.readAsDataURL(file);
}
function removeAvatar() {
  if (S.player) { delete S.player.avatar; lset('tb_player', S.player); updatePlayerUI(); fillProfilForm(); toast('Photo retirée'); }
}
function avatarHTML(p, size, bg, col) {
  size = size || 34; bg = bg || 'var(--green)'; col = col || '#fff';
  if (p && p.avatar) {
    return '<div style="width:' + size + 'px;height:' + size + 'px;border-radius:50%;overflow:hidden;flex-shrink:0;background:#eee;"><img src="' + p.avatar + '" style="width:100%;height:100%;object-fit:cover;display:block;" alt=""></div>';
  }
  var ini = ((p && p.prenom) ? p.prenom[0] : '?').toUpperCase();
  return '<div class="av" style="width:' + size + 'px;height:' + size + 'px;font-size:' + Math.round(size * 0.44) + 'px;background:' + bg + ';color:' + col + ';">' + ini + '</div>';
}
function setAvatar(id, p, bg) {
  var el = document.getElementById(id); if (!el) return;
  if (p && p.avatar) {
    el.style.background = 'transparent'; el.style.overflow = 'hidden';
    el.innerHTML = '<img src="' + p.avatar + '" style="width:100%;height:100%;object-fit:cover;border-radius:50%;display:block;" alt="">';
  } else {
    el.style.background = bg || 'var(--green)';
    el.innerHTML = ((p && p.prenom) ? p.prenom[0] : '?').toUpperCase();
  }
}

/* ── Onboarding ─────────────────────────────────────────────────────────── */
function saveOnboard() {
  var pr = trim('ob-prenom'), no = trim('ob-nom'), ix = parseFloat(val('ob-index')) || 0;
  var tee = validTeeColor(val('ob-tee') || 'jaune');
  if (!pr) { toast('Entre ton prénom 👋'); return; }
  S.player = { prenom: pr, nom: no, index: ix, teeColor: tee, pid: 'p_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6) };
  lset('tb_player', S.player); updatePlayerUI();
  toast('Bienvenue ' + pr + ' ! ⛳', true);
  setTimeout(function () { go('s-home'); }, 600);
}

/* ── Profil ─────────────────────────────────────────────────────────────── */
function fillProfilForm() {
  if (!S.player) return;
  setv('pf-prenom', S.player.prenom || '');
  setv('pf-nom', S.player.nom || '');
  setv('pf-index', S.player.index || '');
  selectTeeColor('pf', S.player.teeColor || 'jaune');
  setAvatar('pf-av', S.player, 'var(--green)');
  txt('pf-name', fullname(S.player));
  txt('pf-idx', (S.player.index || '—') + ' · ' + teeLabel(S.player.teeColor));
  var rm = document.getElementById('pf-remove-av');
  if (rm) rm.style.display = S.player.avatar ? 'block' : 'none';
  fillSettingsForm();
}
function saveProfil() {
  var pr = trim('pf-prenom'), no = trim('pf-nom'), ix = parseFloat(val('pf-index')) || 0;
  var tee = validTeeColor(val('pf-tee') || 'jaune');
  if (!pr) { toast('Entre ton prénom'); return; }
  S.player = Object.assign({}, S.player, { prenom: pr, nom: no, index: ix, teeColor: tee });
  lset('tb_player', S.player); updatePlayerUI(); fillProfilForm();
  syncPlayerProfileToGame();
  toast('Profil mis à jour ✓', true);
  setTimeout(back, 700);
}
function loadLocalSettings() {
  var st = lget('tb_settings') || {};
  S.settings = Object.assign({ vibration: true }, st);
}
function saveLocalSettings() {
  lset('tb_settings', S.settings || { vibration: true });
}
function fillSettingsForm() {
  var vib = document.getElementById('set-vibration');
  if (vib) vib.checked = !S.settings || S.settings.vibration !== false;
  setVibrationStatus('');
}
function setVibrationStatus(msg, bad) {
  var el = document.getElementById('set-vibration-status'); if (!el) return;
  el.textContent = msg || '';
  el.className = bad ? 'setting-status bad' : 'setting-status';
}
function toggleVibration(input) {
  if (!S.settings) S.settings = { vibration: true };
  S.settings.vibration = !!input.checked;
  saveLocalSettings();
  if (!S.settings.vibration) {
    setVibrationStatus('Vibration désactivée sur ce téléphone.');
    return;
  }
  testVibration(true);
}
function testVibration(fromToggle) {
  if (S.settings && S.settings.vibration === false) {
    setVibrationStatus('Active la vibration pour lancer un test.');
    return false;
  }
  if (!navigator.vibrate) {
    setVibrationStatus('Vibration non disponible sur cet appareil ou ce navigateur.', true);
    return false;
  }
  var ok = buzz(70, true);
  if (ok) setVibrationStatus(fromToggle ? 'Vibration activée.' : 'Test envoyé.');
  else setVibrationStatus('Vibration refusée ou désactivée par le système.', true);
  return ok;
}
function syncPlayerProfileToGame() {
  if (!FB_OK || !S.game || !S.player || !S.gameId) return;
  var changed = false;
  var players = (S.game.players || []).map(function (p) {
    if (p.pid !== S.player.pid) return p;
    changed = true;
    var np = Object.assign({}, p, { prenom: S.player.prenom, nom: S.player.nom || '', index: S.player.index, teeColor: validTeeColor(S.player.teeColor) });
    if (S.player.avatar) np.avatar = S.player.avatar;
    else delete np.avatar;
    return np;
  });
  if (!changed) return;
  DB.collection('games').doc(S.gameId).update({ players: players, updatedAt: firebase.firestore.FieldValue.serverTimestamp() });
}
function updatePlayerUI() {
  if (!S.player) return;
  setAvatar('hb-av', S.player, 'rgba(255,255,255,.3)');
  txt('hb-nom', fullname(S.player).toUpperCase());
  txt('hb-idx', S.player.index || '—');
  setAvatar('g-av', S.player, 'var(--green)');
  txt('g-name', S.player.prenom.toUpperCase());
}

/* ── Création de partie ─────────────────────────────────────────────────── */
function buildCourseList() {
  var el = document.getElementById('list-parcours'); if (!el) return;
  if (!COURSES || COURSES.length === 0) {
    el.innerHTML = '<div class="hint">Aucun parcours disponible. Ajoute-en un via la page admin.</div>';
    return;
  }
  if (!selCourse || !COURSES.find(function (c) { return c.id === selCourse; })) selCourse = COURSES[0].id;
  var opts = COURSES.map(function (c) {
    return '<option value="' + esc(c.id) + '"' + (c.id === selCourse ? ' selected' : '') + '>' +
           esc(c.nom) + ' · ' + c.trous + ' trous · Par ' + c.parTotal + '</option>';
  }).join('');
  el.innerHTML = '<div class="select-wrap"><select class="select" id="course-select" onchange="onCourseChange(this.value)">' + opts + '</select></div>';
}
function onCourseChange(id) { selCourse = id; }
function showAddPlayer() { document.getElementById('form-add').style.display = 'block'; document.getElementById('add-prenom').focus(); }
function hideAddPlayer() { document.getElementById('form-add').style.display = 'none'; }
function addPlayer() {
  var pr = trim('add-prenom'), ix = parseFloat(val('add-index')) || 0;
  if (!pr) { toast('Entre un prénom'); return; }
  S.extras.push({ prenom: pr, index: ix, teeColor: validTeeColor(S.player && S.player.teeColor), id: 'x' + Date.now(), pid: 'x_' + Date.now() + '_' + Math.random().toString(36).slice(2, 5) });
  setv('add-prenom', ''); setv('add-index', '');
  hideAddPlayer(); renderPlayerList();
}
function removePlayerExtra(id) { S.extras = S.extras.filter(function (j) { return j.id !== id; }); renderPlayerList(); }
function renderPlayerList() {
  var el = document.getElementById('list-joueurs'); if (!el) return; el.innerHTML = '';
  var all = S.player ? [Object.assign({}, S.player, { self: true, id: 'self' })] : [];
  all = all.concat(S.extras);
  all.forEach(function (j) {
    var d = document.createElement('div');
    d.style.cssText = 'display:flex;align-items:center;gap:10px;padding:12px 14px;background:#fff;border-radius:14px;';
    d.innerHTML = avatarHTML(j, 34) +
      '<div style="flex:1;font-family:\'Barlow Condensed\',sans-serif;font-weight:700;font-size:15px;text-transform:uppercase;">' + fullname(j) + '</div>' +
      '<div style="font-size:12px;color:var(--muted);">Idx ' + j.index + ' · ' + teeLabel(j.teeColor) + '</div>' +
      (j.self ? '<span style="font-size:11px;color:var(--green);font-family:\'Barlow Condensed\',sans-serif;font-weight:700;flex-shrink:0;">MOI</span>'
              : '<button onclick="removePlayerExtra(\'' + j.id + '\')" class="x-btn">×</button>');
    el.appendChild(d);
  });
}

/* Génère un identifiant de partie court à 4 chiffres, non déjà pris */
function newGameId() {
  return String(Math.floor(1000 + Math.random() * 9000));
}
function setPrivacy(priv) {
  var cb = document.getElementById('new-private'); if (cb) cb.checked = priv;
  var bPub = document.getElementById('priv-public'), bPriv = document.getElementById('priv-private');
  if (bPub) bPub.className = 'btn ' + (priv ? 'B-pill-out' : 'B-pill');
  if (bPriv) bPriv.className = 'btn ' + (priv ? 'B-pill' : 'B-pill-out');
  bPub.style.flex = '1'; bPriv.style.flex = '1';
  var note = document.getElementById('priv-note');
  if (note) note.textContent = priv
    ? 'Privée : visible dans la liste, mais il faut le code (affiché dans ton salon) pour rejoindre.'
    : 'Publique : visible et rejoignable par tous depuis l\'accueil.';
}

function createGame() {
  if (!S.player) { toast('Crée ton profil d\'abord 👆'); go('s-profil'); return; }
  if (!FB_OK) { toast('⚠️ Firebase indisponible'); return; }
  var course = COURSES.find(function (c) { return c.id === selCourse; });
  if (!course) { toast('Sélectionne un parcours'); return; }
  var nom = trim('new-name') || ('Partie de ' + S.player.prenom);

  var me = { prenom: S.player.prenom, nom: S.player.nom || '', index: S.player.index, teeColor: validTeeColor(S.player.teeColor), pid: S.player.pid };
  if (S.player.avatar) me.avatar = S.player.avatar;
  var players = [me].concat(S.extras.map(function (e) { return { prenom: e.prenom, index: e.index, teeColor: validTeeColor(e.teeColor), pid: e.pid }; }));

  var id = newGameId();
  var scores = {}; players.forEach(function (j) { scores[j.pid] = Array(18).fill(null); });
  var isPrivate = !!(document.getElementById('new-private') && document.getElementById('new-private').checked);

  var data = {
    name: nom,
    courseId: course.id, courseName: course.nom,
    coursePars: course.pars,
    courseHcp: course.hcp || null,
    teeRatings: course.teeRatings || null,
    parTotal: course.parTotal,
    croixValue: (typeof course.croixValue === 'number' ? course.croixValue : 4),
    mode: 'stroke', host: S.player.pid,
    isPrivate: isPrivate,
    code: isPrivate ? String(Math.floor(1000 + Math.random() * 9000)) : null,
    players: players, teams: [], scores: scores,
    status: 'lobby',
    createdAt: firebase.firestore.FieldValue.serverTimestamp(),
    updatedAt: firebase.firestore.FieldValue.serverTimestamp()
  };

  toast('Création...');
  DB.collection('games').doc(id).set(data).then(function () {
    S.game = data; S.gameId = id; S.hole = 0; S.started = false;
    S.myPids = players.map(function (p) { return p.pid; });   // proprio + joueurs ajoutés
    S.local = {}; S.writeTs = {}; S.activeKey = null; S.notified = {};
    lset('tb_session', { id: id, hole: 0, myPids: S.myPids });
    attachGameListener(id);
    S.extras = []; renderPlayerList();
    setv('new-name', '');
    go('s-salon'); renderHomeParties();
  }).catch(function (e) { console.error(e); toast('Erreur création'); });
}

/* ── Rejoindre depuis la liste de l'accueil ─────────────────────────────── */
function joinGameById(id) {
  if (!FB_OK) { toast('⚠️ Firebase indisponible'); return; }
  DB.collection('games').doc(id).get().then(function (snap) {
    if (!snap.exists) { toast('Cette partie n\'existe plus'); return; }
    var data = snap.data();
    var myPid = S.player.pid;
    var inGame = data.players.some(function (p) { return p.pid === myPid; });
    var chain = Promise.resolve();
    if (!inGame) {
      var me = { prenom: S.player.prenom, nom: S.player.nom || '', index: S.player.index, teeColor: validTeeColor(S.player.teeColor), pid: myPid };
      if (S.player.avatar) me.avatar = S.player.avatar;
      var np = data.players.concat([me]);
      var ns = Object.assign({}, data.scores); ns[myPid] = Array(18).fill(null);
      chain = DB.collection('games').doc(id).update({ players: np, scores: ns, updatedAt: firebase.firestore.FieldValue.serverTimestamp() });
    }
    chain.then(function () {
      S.gameId = id; S.hole = 0; S.started = (data.status === 'playing');
      S.myPids = [myPid];          // sur ce téléphone, je ne gère que moi
      S.local = {}; S.writeTs = {}; S.activeKey = null; S.notified = {};
      lset('tb_session', { id: id, hole: 0, myPids: S.myPids });
      attachGameListener(id);
      if (data.status === 'playing') { S.started = true; buildHolePicker(); go('s-game'); }
      else go('s-salon');
      renderHomeParties();
      toast('Partie rejointe ! 🎉', true);
    });
  }).catch(function (e) { console.error(e); toast('Erreur connexion'); });
}

/* ── Listener : liste des parties ouvertes (accueil) ───────────────────── */
function attachOpenGamesListener() {
  if (S.unsubList) S.unsubList();
  S.unsubList = DB.collection('games').onSnapshot(function (snap) {
    var games = [];
    snap.forEach(function (doc) {
      var d = doc.data(); d._id = doc.id;
      games.push(d);
    });
    S._openGames = games;
    renderOpenGames(games);
  }, function (err) { console.error('open games', err); });
}
function refreshOpenGames() { if (S._openGames) renderOpenGames(S._openGames); }
function renderOpenGames(games) {
  var box = document.getElementById('open-games');
  var empty = document.getElementById('open-empty');
  if (!box) return;

  // Exclure la partie où je suis déjà (affichée dans "ma partie en cours")
  var others = games.filter(function (g) {
    if (g._id === S.gameId) return false;
    // Ne montrer que les parties non vides
    return g.players && g.players.length > 0;
  });
  // Trier par date de création récente
  others.sort(function (a, b) {
    var ta = a.createdAt && a.createdAt.seconds ? a.createdAt.seconds : 0;
    var tb = b.createdAt && b.createdAt.seconds ? b.createdAt.seconds : 0;
    return tb - ta;
  });

  if (others.length === 0) {
    box.innerHTML = '';
    if (empty) empty.style.display = 'block';
    return;
  }
  if (empty) empty.style.display = 'none';

  box.innerHTML = '';
  others.forEach(function (g) {
    var statusTxt = g.status === 'playing' ? 'en cours' : 'salon ouvert';
    var mode = (MODES[g.mode] || { label: '' }).label;
    var host = (g.players.find(function (p) { return p.pid === g.host; }) || {}).prenom || '';
    var avatars = g.players.slice(0, 4).map(function (p) { return avatarHTML(p, 28, 'var(--bg)', 'var(--text)'); }).join('');
    var more = g.players.length > 4 ? '<span style="font-size:11px;color:var(--muted);margin-left:4px;">+' + (g.players.length - 4) + '</span>' : '';
    var nViewers = countViewers(g);
    var viewerBadge = nViewers > 0 ? '<span style="font-size:11px;color:var(--muted);margin-left:8px;">👁 ' + nViewers + '</span>' : '';
    var lock = g.isPrivate ? '<span title="Privée" style="margin-right:5px;">🔒</span>' : '';

    var card = document.createElement('div');
    card.className = 'card';
    card.innerHTML =
      '<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:10px;gap:10px;">' +
        '<div style="min-width:0;"><div style="font-family:\'Barlow Condensed\',sans-serif;font-weight:900;font-size:17px;text-transform:uppercase;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">' + lock + esc(g.name || g.courseName) + '</div>' +
        '<div style="font-size:12px;color:var(--muted);">' + esc(g.courseName) + ' · ' + mode + ' · ' + statusTxt + '</div></div>' +
        '<div style="display:flex;align-items:center;gap:8px;flex-shrink:0;">' +
          '<button class="eye-btn" title="Regarder"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="var(--text)" stroke-width="2"><path d="M1 12s4-7 11-7 11 7 11 7-4 7-11 7-11-7-11-7z"/><circle cx="12" cy="12" r="3"/></svg></button>' +
          '<div class="join-pill" style="background:var(--green);color:#fff;font-family:\'Barlow Condensed\',sans-serif;font-weight:800;font-size:12px;padding:8px 14px;border-radius:20px;cursor:pointer;">Rejoindre</div>' +
        '</div>' +
      '</div>' +
      '<div style="display:flex;align-items:center;gap:4px;">' + avatars + more +
        '<span style="font-size:12px;color:var(--muted);margin-left:8px;">' + g.players.length + ' joueur' + (g.players.length > 1 ? 's' : '') + (host ? ' · hôte ' + esc(host) : '') + '</span>' + viewerBadge +
      '</div>';
    // Clics (parties privées : code requis)
    card.querySelector('.join-pill').onclick = function (ev) { ev.stopPropagation(); gateThen(g, function () { joinGameById(g._id); }); };
    card.querySelector('.eye-btn').onclick = function (ev) { ev.stopPropagation(); gateThen(g, function () { spectateGame(g._id); }); };
    box.appendChild(card);
  });
}
/* Pour les parties privées : demande le code (sauf si on est déjà dedans) */
function gateThen(g, cb) {
  if (!g.isPrivate) { cb(); return; }
  if (g.players && g.players.some(function (p) { return p.pid === S.player.pid; })) { cb(); return; }
  var code = prompt('🔒 Partie privée « ' + (g.name || '') + ' »\n\nEntre le code à 4 chiffres :');
  if (code === null) return;
  if (String(code).trim() === String(g.code)) cb();
  else toast('Code incorrect ❌');
}

/* ── Listener : partie en cours ────────────────────────────────────────── */
function attachGameListener(id) {
  if (S.unsub) S.unsub();
  S.unsub = DB.collection('games').doc(id).onSnapshot(function (snap) {
    if (!snap.exists) {
      if (S.gameId === id) {
        toast(S.spectating ? 'La partie est terminée' : 'La partie a été clôturée');
        stopHeartbeat();
        S.spectating = false;
        clearSessionLocal();
        go('s-home');
      }
      return;
    }
    S.game = snap.data();
    pulseLive();
    // Détecter si on a été retiré de la partie par l'hôte
    if (!S.spectating && S.myPids.length && (S.game.players || []).length &&
        !S.myPids.some(function (pid) { return S.game.players.some(function (p) { return p.pid === pid; }); })) {
      toast('Tu as été retiré de la partie');
      clearSessionLocal();
      go('s-home');
      return;
    }
    if (!S.spectating) syncScoringState();
    // Notifications DF (résultat de vote) pour tout le monde
    if (S.game.lastDF && S.game.lastDF.at !== S._lastDFat) {
      var fresh = Date.now() - S.game.lastDF.at < 10000;
      S._lastDFat = S.game.lastDF.at;
      if (S.started && fresh) toast('⛳ DF confirmé pour ' + S.game.lastDF.name + ' ! (×1)', true);
    }
    if (S.game.lastDFCancel && S.game.lastDFCancel.at !== S._lastDFCancelAt) {
      var fresh2 = Date.now() - S.game.lastDFCancel.at < 10000;
      S._lastDFCancelAt = S.game.lastDFCancel.at;
      if (S.started && fresh2) toast('Vote DF annulé (pas de majorité)');
    }
    if (!S.spectating && S.game.status === 'playing' && !S.started) {
      S.started = true; buildHolePicker(); go('s-game');
      toast('La partie commence ! ⛳', true);
      return;
    }
    if (!S.spectating) renderHomeParties();
    updateViewerDisplays();
    if (isActive('s-salon'))    renderSalon();
    if (isActive('s-scores'))   refreshScores();
    if (isActive('s-settings')) renderSettings();
    if (isActive('s-game'))     { updateSheetDock('s-game'); refreshGameUI(); }
    if (S.sheetOpen) renderSheet();
  }, function (err) { console.error('game', err); });
}
function isActive(id) { var e = document.getElementById(id); return e && e.classList.contains('active'); }
function pulseLive() {
  var d = document.getElementById('live-dot'); if (!d) return;
  d.style.opacity = '1'; clearTimeout(window._pl);
  window._pl = setTimeout(function () { d.style.opacity = '.4'; }, 400);
}

/* ── Salon ──────────────────────────────────────────────────────────────── */
function renderSalon() {
  var g = S.game; if (!g) return;
  var isHost = g.host === S.player.pid;
  txt('sl-name', g.name || g.courseName);
  txt('sl-parcours', g.courseName);
  var pv = document.getElementById('sl-private');
  if (pv) {
    if (g.isPrivate && g.code) { pv.style.display = 'block'; txt('sl-code', g.code); }
    else pv.style.display = 'none';
  }

  var jl = document.getElementById('sl-joueurs'); jl.innerHTML = '';
  (g.players || []).forEach(function (j) {
    var me = j.pid === S.player.pid;
    var crown = j.pid === g.host ? ' <span style="font-size:10px;">👑</span>' : '';
    var canKick = isHost && j.pid !== g.host;   // l'hôte peut retirer les autres
    var d = document.createElement('div');
    d.style.cssText = 'display:flex;align-items:center;gap:10px;padding:12px 14px;background:#fff;border-radius:14px;box-shadow:0 1px 6px rgba(0,0,0,.05);' + (me ? 'border:2px solid var(--green);' : '');
    d.innerHTML = avatarHTML(j, 34, 'var(--green)') +
      '<div style="font-family:\'Barlow Condensed\',sans-serif;font-weight:700;font-size:15px;text-transform:uppercase;color:var(--text);">' + j.prenom + crown + (me ? ' <span style="font-size:11px;color:var(--green);">(moi)</span>' : '') + '</div>' +
      '<div style="margin-left:auto;font-size:12px;color:var(--muted);">Index ' + j.index + ' · ' + teeLabel(j.teeColor) + '</div>' +
      (canKick ? '<button class="x-btn" title="Retirer" style="margin-left:8px;" onclick="kickPlayer(\'' + j.pid + '\',\'' + esc(j.prenom).replace(/'/g, "\\'") + '\')">×</button>' : '');
    jl.appendChild(d);
  });
  txt('sl-count', (g.players || []).length);

  renderModeButtons('sl-mode-buttons', isHost);
  document.getElementById('sl-mode-hint').style.display = isHost ? 'none' : 'block';

  var ew = document.getElementById('sl-equipes-wrap');
  var showTeams = MODES[g.mode].teams || MODES[g.mode].matchplay;
  if (showTeams) {
    ew.style.display = 'block';
    var note = document.getElementById('sl-equipes-note');
    if (note) note.textContent = MODES[g.mode].matchplay
      ? 'Match Play : laisse vide pour du 1 contre 1, ou forme 2 équipes pour du 2 contre 2.'
      : 'Forme les équipes de 2.';
    renderTeams('sl-equipes', isHost);
    document.getElementById('sl-shuffle').style.display = isHost ? 'block' : 'none';
  } else ew.style.display = 'none';

  var launchBtn = document.getElementById('sl-launch');
  var waitMsg = document.getElementById('sl-wait');
  if (isHost) { launchBtn.style.display = 'block'; waitMsg.style.display = 'none'; }
  else {
    launchBtn.style.display = 'none'; waitMsg.style.display = 'block';
    var hn = (g.players.find(function (p) { return p.pid === g.host; }) || {}).prenom || 'l\'hôte';
    txt('sl-wait-txt', 'En attente du lancement par ' + hn + '...');
  }
}

/* Boutons de mode réutilisables (salon + réglages) */
function renderModeButtons(containerId, editable) {
  var wrap = document.getElementById(containerId); if (!wrap) return; wrap.innerHTML = '';
  Object.keys(MODES).forEach(function (m) {
    var active = S.game.mode === m;
    var b = document.createElement('button');
    b.className = 'btn ' + (active ? 'B-pill' : 'B-pill-out');
    b.style.cssText = 'justify-content:flex-start;gap:8px;width:100%;' + (editable ? '' : 'opacity:' + (active ? '1' : '.5') + ';');
    b.textContent = MODES[m].icon + ' ' + MODES[m].label;
    if (editable) b.onclick = function () { changeMode(m); };
    else b.disabled = true;
    wrap.appendChild(b);
  });
}
/* Zone d'équipes interactive : cartouches joueurs (libres) + équipes formées.
   interactive = true → l'hôte peut glisser pour fusionner et séparer (×). */
function renderTeams(containerId, interactive) {
  var el = document.getElementById(containerId); if (!el) return;
  var teams = S.game.teams || [];
  var inTeam = {};
  teams.forEach(function (t) { t.players.forEach(function (p) { if (p) inTeam[p.pid] = true; }); });
  var free = (S.game.players || []).filter(function (p) { return !inTeam[p.pid]; });

  el.innerHTML = '';
  el.style.cssText = 'display:flex;flex-wrap:wrap;gap:10px;';

  teams.forEach(function (t, i) {
    var p0 = t.players[0], p1 = t.players[1];
    var ix = ((p0 ? p0.index : 0) + (p1 ? p1.index : 0)).toFixed(1);
    var d = document.createElement('div');
    d.className = 'team-cartouche';
    d.innerHTML =
      '<div style="display:flex;align-items:center;gap:6px;">' +
        avatarHTML(p0, 26, 'var(--green)') + avatarHTML(p1, 26, 'var(--green)') +
        '<div style="margin-left:2px;"><div style="font-family:\'Barlow Condensed\',sans-serif;font-weight:800;font-size:14px;text-transform:uppercase;color:#fff;line-height:1;">' + esc(p0 ? p0.prenom : '?') + ' &amp; ' + esc(p1 ? p1.prenom : '?') + '</div>' +
        '<div style="font-size:10px;color:rgba(255,255,255,.8);">Idx ' + ix + '</div></div>' +
      '</div>' +
      (interactive ? '<button class="split-btn" data-tid="' + t.id + '" title="Séparer">×</button>' : '');
    el.appendChild(d);
  });

  free.forEach(function (p) {
    var d = document.createElement('div');
    d.className = 'player-cartouche' + (interactive ? ' draggable' : '');
    d.setAttribute('data-pid', p.pid);
    d.innerHTML = avatarHTML(p, 28, 'var(--green)') +
      '<span style="font-family:\'Barlow Condensed\',sans-serif;font-weight:700;font-size:14px;text-transform:uppercase;">' + esc(p.prenom) + '</span>';
    el.appendChild(d);
  });

  if (interactive) {
    el.querySelectorAll('.split-btn').forEach(function (b) {
      b.onclick = function () { splitTeam(b.getAttribute('data-tid')); };
    });
    attachDragHandlers(el);
    if (free.length > 1) {
      var hint = document.createElement('div');
      hint.style.cssText = 'width:100%;font-size:12px;color:var(--muted);margin-top:2px;';
      hint.textContent = '👆 Glisse un joueur sur un autre pour former une équipe.';
      el.appendChild(hint);
    }
  }
}

/* ── Drag & drop tactile pour former les équipes ───────────────────────── */
var DRAG = { active: false, srcPid: null, ghost: null, container: null, srcEl: null };
function attachDragHandlers(container) {
  DRAG.container = container;
  container.querySelectorAll('.player-cartouche.draggable').forEach(function (el) {
    el.addEventListener('touchstart', function (e) { startDrag(e, el, true); }, { passive: false });
    el.addEventListener('mousedown', function (e) { startDrag(e, el, false); });
  });
}
function dragPoint(e, touch) {
  if (touch) { var t = e.touches[0] || e.changedTouches[0]; return { x: t.clientX, y: t.clientY }; }
  return { x: e.clientX, y: e.clientY };
}
function startDrag(e, el, touch) {
  if (DRAG.active) return;
  e.preventDefault();
  DRAG.active = true; DRAG.srcPid = el.getAttribute('data-pid'); DRAG.srcEl = el;
  var p = dragPoint(e, touch);
  DRAG.ghost = el.cloneNode(true);
  DRAG.ghost.style.cssText = 'position:fixed;z-index:99999;pointer-events:none;opacity:.92;box-shadow:0 8px 24px rgba(0,0,0,.25);';
  document.body.appendChild(DRAG.ghost);
  moveGhost(p);
  el.style.opacity = '.3';
  var moveH = function (ev) { if (!DRAG.active) return; ev.preventDefault(); var pp = dragPoint(ev, touch); moveGhost(pp); highlightTarget(pp); };
  var endH = function (ev) {
    var pp = dragPoint(ev, touch); endDrag(pp);
    if (touch) { document.removeEventListener('touchmove', moveH); document.removeEventListener('touchend', endH); document.removeEventListener('touchcancel', endH); }
    else { document.removeEventListener('mousemove', moveH); document.removeEventListener('mouseup', endH); }
  };
  if (touch) { document.addEventListener('touchmove', moveH, { passive: false }); document.addEventListener('touchend', endH); document.addEventListener('touchcancel', endH); }
  else { document.addEventListener('mousemove', moveH); document.addEventListener('mouseup', endH); }
}
function moveGhost(p) { if (DRAG.ghost) { DRAG.ghost.style.left = (p.x - 50) + 'px'; DRAG.ghost.style.top = (p.y - 22) + 'px'; } }
function dragTargetAt(p) {
  if (DRAG.ghost) DRAG.ghost.style.display = 'none';
  var el = document.elementFromPoint(p.x, p.y);
  if (DRAG.ghost) DRAG.ghost.style.display = '';
  while (el && !(el.classList && el.classList.contains('player-cartouche'))) el = el.parentElement;
  if (el && el.getAttribute('data-pid') && el.getAttribute('data-pid') !== DRAG.srcPid) return el;
  return null;
}
function highlightTarget(p) {
  if (DRAG.container) DRAG.container.querySelectorAll('.player-cartouche').forEach(function (c) { c.classList.remove('drop-target'); });
  var t = dragTargetAt(p); if (t) t.classList.add('drop-target');
}
function endDrag(p) {
  var t = dragTargetAt(p);
  if (DRAG.ghost) { DRAG.ghost.remove(); DRAG.ghost = null; }
  if (DRAG.srcEl) DRAG.srcEl.style.opacity = '';
  if (DRAG.container) DRAG.container.querySelectorAll('.player-cartouche').forEach(function (c) { c.classList.remove('drop-target'); });
  var src = DRAG.srcPid; DRAG.active = false; DRAG.srcPid = null; DRAG.srcEl = null;
  if (t) mergePlayers(src, t.getAttribute('data-pid'));
}
function mergePlayers(aPid, bPid) {
  if (!FB_OK || !S.game) return;
  if (S.game.host !== S.player.pid) { toast('Seul l\'hôte forme les équipes'); return; }
  var pa = S.game.players.find(function (p) { return p.pid === aPid; });
  var pb = S.game.players.find(function (p) { return p.pid === bPid; });
  if (!pa || !pb) return;
  var teams = (S.game.teams || []).slice();
  teams.push({ id: 'tm_' + Date.now() + '_' + Math.random().toString(36).slice(2, 5), players: [pa, pb] });
  DB.collection('games').doc(S.gameId).update({ teams: teams, updatedAt: firebase.firestore.FieldValue.serverTimestamp() })
    .then(function () { toast('Équipe formée 🤝', true); });
}
function splitTeam(tid) {
  if (!FB_OK || !S.game || S.game.host !== S.player.pid) return;
  var teams = (S.game.teams || []).filter(function (t) { return t.id !== tid; });
  DB.collection('games').doc(S.gameId).update({ teams: teams, updatedAt: firebase.firestore.FieldValue.serverTimestamp() })
    .then(function () { toast('Équipe séparée', true); });
}
function freePlayers() {
  var inTeam = {};
  (S.game.teams || []).forEach(function (t) { t.players.forEach(function (p) { if (p) inTeam[p.pid] = true; }); });
  return (S.game.players || []).filter(function (p) { return !inTeam[p.pid]; });
}

function changeMode(m) {
  if (!FB_OK || !S.game) return;
  if (S.game.host !== S.player.pid) { toast('Seul l\'hôte peut changer le mode'); return; }
  // Changement de mode : on repart de joueurs libres (à répartir à la main ou via le bouton équilibrer)
  var upd = { mode: m, teams: [], updatedAt: firebase.firestore.FieldValue.serverTimestamp() };
  DB.collection('games').doc(S.gameId).update(upd);
}
/* Répartition équilibrée : on appaire le meilleur index avec le moins bon,
   etc., pour que les index cumulés des équipes soient le plus proches possible. */
function autoTeams(players) {
  var sorted = (players || []).slice().sort(function (a, b) { return (a.index || 0) - (b.index || 0); });
  var teams = [], i = 0, j = sorted.length - 1, n = 0;
  while (i < j) {
    teams.push({ id: 'tm_' + Date.now() + '_' + (n++) + '_' + Math.random().toString(36).slice(2, 5), players: [sorted[i], sorted[j]] });
    i++; j--;
  }
  if (i === j) { // joueur impair seul
    teams.push({ id: 'tm_' + Date.now() + '_' + (n++) + '_' + Math.random().toString(36).slice(2, 5), players: [sorted[i], null] });
  }
  return teams;
}
/* L'hôte retire un ou plusieurs joueurs (et les clés de score associées) */
function kickPids(pids, extraScoreKeys, label) {
  if (!FB_OK || !S.game) return;
  if (S.game.host !== S.player.pid) { toast('Seul l\'hôte peut retirer un joueur'); return; }
  var remaining = (S.game.players || []).filter(function (p) { return pids.indexOf(p.pid) < 0; });
  if (remaining.length === 0) {
    if (!confirm('Cela retirerait le dernier joueur et supprimera la partie. Continuer ?')) return;
    DB.collection('games').doc(S.gameId).delete();
    return;
  }
  var ns = Object.assign({}, S.game.scores);
  pids.forEach(function (pid) { delete ns[pid]; });
  (extraScoreKeys || []).forEach(function (k) { delete ns[k]; });
  var newHost = S.game.host;
  if (pids.indexOf(S.game.host) >= 0) newHost = remaining[0].pid;
  var teams = (S.game.teams || []).map(function (t) {
    return { id: t.id, players: t.players.filter(function (pp) { return pp && pids.indexOf(pp.pid) < 0; }) };
  }).filter(function (t) { return t.players.length > 0; });
  DB.collection('games').doc(S.gameId).update({
    players: remaining, scores: ns, host: newHost, teams: teams,
    updatedAt: firebase.firestore.FieldValue.serverTimestamp()
  }).then(function () { toast((label || 'Joueur') + ' retiré', true); }).catch(function (e) { console.error(e); });
}
/* L'hôte retire un joueur (depuis le salon) */
function kickPlayer(pid, prenom) {
  if (!confirm('Retirer ' + prenom + ' de la partie ?')) return;
  kickPids([pid], [pid], prenom);
}
/* L'hôte retire une unité (joueur ou équipe) depuis les cartes de score */
function removeEntity(key) {
  if (!S.game || S.game.host !== S.player.pid) return;
  var u = scoringUnits(S.game).find(function (x) { return x.key === key; });
  if (!u) return;
  var pids = u.players.map(function (p) { return p.pid; });
  if (pids.indexOf(S.player.pid) >= 0) { toast('Tu ne peux pas te retirer ici'); return; }
  if (!confirm((u.type === 'team' ? 'Retirer l\'équipe ' : 'Retirer ') + u.label + ' de la partie ?')) return;
  kickPids(pids, [u.key], u.label);
}

function shuffleTeams() {
  if (!FB_OK || S.game.host !== S.player.pid) return;
  DB.collection('games').doc(S.gameId).update({ teams: autoTeams(S.game.players) }).then(function () {
    toast('Équipes équilibrées ⚖️', true);
  });
}
function launchGame() {
  if (!FB_OK || !S.game) return;
  if (S.game.host !== S.player.pid) { toast('Seul l\'hôte peut lancer'); return; }
  var mode = MODES[S.game.mode] || {};
  if (mode.matchplay) {
    if (teamBased(S.game)) {
      if (freePlayers().length > 0) { toast('Glisse chaque joueur dans une équipe'); return; }
      if ((S.game.teams || []).length !== 2) { toast('Match Play 2v2 : exactement 2 équipes'); return; }
    } else {
      if ((S.game.players || []).length !== 2) { toast('Match Play : 2 joueurs (1v1), ou forme 2 équipes (2v2)'); return; }
    }
  } else if (mode.teams) {
    var n = (S.game.players || []).length;
    if (n < 2) { toast('Ajoute au moins 2 joueurs'); return; }
    if (freePlayers().length > 0) { toast('Glisse chaque joueur dans une équipe 🤝'); return; }
    if (!S.game.teams || S.game.teams.length === 0) { toast('Forme les équipes d\'abord'); return; }
  }
  DB.collection('games').doc(S.gameId).update({ status: 'playing', updatedAt: firebase.firestore.FieldValue.serverTimestamp() });
}

/* ── Réglages en cours de partie ───────────────────────────────────────── */
function renderSettings() {
  var g = S.game; if (!g) return;
  var isHost = g.host === S.player.pid;
  txt('set-name', g.name || g.courseName);
  document.getElementById('set-host-only').style.display = isHost ? 'block' : 'none';
  document.getElementById('set-not-host').style.display = isHost ? 'none' : 'block';
  if (isHost) {
    renderModeButtons('set-mode-buttons', true);
    var ew = document.getElementById('set-equipes-wrap');
    if (MODES[g.mode].teams || MODES[g.mode].matchplay) { ew.style.display = 'block'; renderTeams('set-equipes', isHost); }
    else ew.style.display = 'none';
  }
}

/* ── Jeu : saisie ───────────────────────────────────────────────────────── */

/* Barre de sélection : joueurs/équipes gérés sur ce téléphone */
function renderUnitBar() {
  var bar = document.getElementById('g-unitbar'); if (!bar) return;
  syncScoringState();
  if (!S.editable || S.editable.length <= 1) { bar.style.display = 'none'; bar.innerHTML = ''; return; }
  bar.style.display = 'flex';
  bar.innerHTML = '';
  S.editable.forEach(function (u) {
    var active = u.key === S.activeKey;
    var chip = document.createElement('button');
    chip.className = 'unit-chip' + (active ? ' active' : '');
    chip.innerHTML = (u.type === 'team' ? '👥 ' : '') + esc(u.label);
    chip.onclick = function () { setActiveEntity(u.key); };
    bar.appendChild(chip);
  });
}
function setActiveEntity(key) {
  leaveHole();
  S.activeKey = key;
  updateGameHeader();
  refreshGameUI();
  renderUnitBar();
}
/* Cliquer le profil en haut à gauche = passer au joueur/équipe suivant */
function cycleActive() {
  if (!S.editable || S.editable.length <= 1) return;
  var idx = 0;
  for (var i = 0; i < S.editable.length; i++) if (S.editable[i].key === S.activeKey) idx = i;
  var next = S.editable[(idx + 1) % S.editable.length];
  setActiveEntity(next.key);
  toast('Saisie : ' + next.label, true);
}
function updateGameHeader() {
  var u = (S.editable || []).find(function (x) { return x.key === S.activeKey; });
  if (!u) return;
  txt('g-name', u.label.toUpperCase());
  setAvatar('g-av', u.p || u.player, 'var(--green)');
}

function buildHolePicker() {
  var el = document.getElementById('g-holes'); if (!el) return; el.innerHTML = '';
  var sc = getScores(S.activeKey);
  for (var i = 0; i < 18; i++) {
    var c = document.createElement('button');
    c.className = 'hc' + (i === S.hole ? ' active' : '') + (sc[i] !== null && sc[i] !== undefined ? ' done' : '');
    c.textContent = i + 1;
    (function (idx) { c.onclick = function () { leaveHole(); S.hole = idx; refreshGameUI(); }; })(i);
    el.appendChild(c);
  }
}
function refreshGameUI() {
  if (!S.game) return;
  syncScoringState();
  updateGameHeader();
  var t = S.hole, par = S.game.coursePars[t], sc = getScores(S.activeKey)[t];
  txt('g-hn', t + 1); txt('g-par', par);
  // Repère coup(s) rendu(s) pour le joueur actif (individuel, hcp dispo)
  var gs = document.getElementById('g-stroke');
  if (gs) {
    var u = (S.editable || []).find(function (x) { return x.key === S.activeKey; });
    var st = 0;
    if (u && u.player && gameHcp()) { st = strokesArray(u.player.index, u.player)[t] || 0; }
    if (st > 0) { gs.style.display = 'inline'; gs.textContent = '· ' + (st >= 2 ? st + ' coups rendus' : '1 coup rendu') + ' ⛳'; }
    else gs.style.display = 'none';
  }
  var sEl = document.getElementById('g-score'), lEl = document.getElementById('g-slabel'), eEl = document.getElementById('g-ecart');
  var crossBtn = document.getElementById('g-cross');
  if (sc === 'X') {
    sEl.textContent = '✕'; sEl.style.color = 'var(--red)';
    lEl.textContent = 'CROIX'; lEl.style.color = 'var(--red)';
    eEl.textContent = 'Trou non comptabilisé'; eEl.style.color = 'var(--muted)';
    if (crossBtn) crossBtn.classList.add('active');
  } else if (sc === null || sc === undefined) {
    sEl.textContent = '—'; sEl.style.color = 'var(--muted)';
    lEl.textContent = ''; eEl.textContent = 'Appuie sur + ou − pour scorer'; eEl.style.color = 'var(--muted)';
    if (crossBtn) crossBtn.classList.remove('active');
  } else {
    var e = sc - par, info = scoreInfo(e);
    sEl.textContent = sc; sEl.style.color = info.color;
    lEl.textContent = info.label; lEl.style.color = info.color;
    eEl.textContent = e === 0 ? 'Égal au par' : (e > 0 ? '+' : '') + e + ' / Par ' + par;
    eEl.style.color = e <= 0 ? 'var(--green)' : 'var(--red)';
    if (crossBtn) crossBtn.classList.remove('active');
  }
  var pv = document.getElementById('g-prev'); if (pv) pv.style.opacity = t === 0 ? '.4' : '1';
  buildHolePicker();
  renderUnitBar();
  // Départ du joueur actif + box de vote DF
  var dEl = document.getElementById('g-depart');
  if (dEl) { var dp = (S.game.departs || {})[activePlayerPid()]; dEl.value = dp || ''; }
  renderVoteBox();
  updateViewerDisplays();
}
function scoreInfo(e) {
  if (e <= -3) return { label: 'ALBATROS 🦅', color: 'var(--gold)' };
  if (e === -2) return { label: 'EAGLE 🦅',   color: 'var(--gold)' };
  if (e === -1) return { label: 'BIRDIE 🐦',  color: 'var(--green)' };
  if (e === 0)  return { label: 'PAR',          color: 'var(--text)' };
  if (e === 1)  return { label: 'BOGEY',        color: 'var(--orange)' };
  if (e === 2)  return { label: 'DOUBLE BOGEY', color: 'var(--red)' };
  return          { label: 'TRIPLE BOGEY +',   color: '#8B0000' };
}
function activeArr() {
  if (!S.activeKey) return null;
  if (!S.local[S.activeKey]) S.local[S.activeKey] = getScores(S.activeKey).slice();
  return S.local[S.activeKey];
}
function chScore(d) {
  if (!S.game || !S.activeKey) return;
  var arr = activeArr(); if (!arr) return;
  var t = S.hole, par = S.game.coursePars[t], cur = arr[t];
  var nxt = (typeof cur === 'number') ? Math.max(1, cur + d) : (d > 0 ? par : Math.max(1, par - 1));
  arr[t] = nxt; S.notified[t] = false;
  buzz(12); popScore();
  saveScore(); refreshGameUI();
}
function setCross() {
  if (!S.game || !S.activeKey) return;
  var arr = activeArr(); if (!arr) return;
  var t = S.hole;
  var becomingCross = arr[t] !== 'X';
  arr[t] = becomingCross ? 'X' : null;
  S.notified[t] = true;       // pas de message birdie sur une croix
  buzz(becomingCross ? [15, 40, 15] : 12); popScore();
  if (becomingCross) {
    var u = (S.editable || []).find(function (x) { return x.key === S.activeKey; });
    gameMsg(pickMsg('croix', u ? u.label : ''), false);
  }
  saveScore(); refreshGameUI();
}
function saveScore() {
  if (!S.activeKey) return;
  S.writeTs[S.activeKey] = Date.now();
  lset('tb_session', { id: S.gameId, hole: S.hole, myPids: S.myPids });
  if (!FB_OK || !S.gameId) return;
  var upd = {}; upd['scores.' + S.activeKey] = S.local[S.activeKey];
  upd.updatedAt = firebase.firestore.FieldValue.serverTimestamp();
  DB.collection('games').doc(S.gameId).update(upd).catch(function (e) { console.error(e); });
}
function isComeback(t) {
  var sc = getScores(S.activeKey), over = 0, seen = 0;
  for (var i = t - 1; i >= 0 && seen < 2; i--) {
    var v = sc[i]; if (!isDecided(v)) continue;
    seen++;
    var ee = (v === 'X') ? 2 : (v - S.game.coursePars[i]);
    if (ee > 0) over++; else break;   // un par ou mieux casse la série
  }
  return over >= 2;
}
function leaveHole() {
  var t = S.hole, sc = getScores(S.activeKey)[t];
  if (!isDecided(sc) || sc === 'X' || S.notified[t]) return;   // la croix a son message dans setCross
  var u = (S.editable || []).find(function (x) { return x.key === S.activeKey; });
  var nom = u ? u.label : '';
  var e = sc - S.game.coursePars[t];
  var type, good = e <= 0;
  if (e <= -4) type = 'condor';
  else if (e === -3) type = 'albatross';
  else if (e === -2) type = 'eagle';
  else if (e === -1) type = 'birdie';
  else if (e === 0) type = isComeback(t) ? 'parComeback' : 'par';
  else if (e === 1) type = 'bogey';
  else if (e === 2) type = 'double';
  else if (e === 3) type = 'triple';
  else type = 'worse';
  // Le par "neutre" ne s'affiche pas systématiquement (sauf comeback)
  var show = true;
  if (type === 'par') show = Math.random() < 0.45;
  if (show) gameMsg(pickMsg(type, nom), good);
  S.notified[t] = true;
}
function prevH() { if (S.hole > 0) { leaveHole(); S.hole--; buzz(18); refreshGameUI(); } }
function nextH() {
  if (S.hole < 17) { leaveHole(); S.hole++; buzz(18); refreshGameUI(); }
  else {
    leaveHole();
    buzz(18);
    var done = countPlayed(getScores(S.activeKey));
    toast(done === 18 ? '🏆 18 trous joués ! Bravo !' : 'Dernier trou · ' + done + '/18', done === 18);
  }
}

/* ════════════════════════════════════════════════════════════════════════
   VOTE DF — chaque joueur saisit son numéro de départ ; un joueur peut lancer
   un vote contre un autre de SON départ ; majorité de Oui = +1 au compteur DF.
════════════════════════════════════════════════════════════════════════ */

/* pid dont on édite le départ : le joueur actif (si individuel), sinon moi */
function activePlayerPid() {
  var u = (S.editable || []).find(function (x) { return x.key === S.activeKey; });
  if (u && u.type === 'player' && u.player) return u.player.pid;
  return S.player ? S.player.pid : null;
}
function playerName(pid) {
  var p = (S.game.players || []).find(function (x) { return x.pid === pid; });
  return p ? p.prenom : '?';
}
function saveDepart() {
  if (!FB_OK || !S.game) return;
  var v = (document.getElementById('g-depart').value || '').trim();
  var pid = activePlayerPid(); if (!pid) return;
  var departs = Object.assign({}, S.game.departs || {});
  if (v === '') delete departs[pid]; else departs[pid] = String(v);
  DB.collection('games').doc(S.gameId).update({ departs: departs, updatedAt: firebase.firestore.FieldValue.serverTimestamp() });
}
/* Membres d'un départ (pids) */
function departMembers(dep) {
  var d = S.game.departs || {};
  return (S.game.players || []).filter(function (p) { return d[p.pid] === dep; }).map(function (p) { return p.pid; });
}
function openDF() {
  if (!S.game) return;
  var myPid = S.player.pid;
  var dep = (S.game.departs || {})[myPid];
  if (!dep) { toast('Indique d\'abord ton numéro de départ'); return; }
  if (S.game.vote) { toast('Un vote DF est déjà en cours'); return; }
  var mates = departMembers(dep).filter(function (pid) { return pid !== myPid; });
  if (mates.length === 0) { toast('Personne d\'autre dans ton départ ' + dep); return; }
  showDFPicker(mates);
}
function showDFPicker(mates) {
  var list = document.getElementById('df-picker-list'); list.innerHTML = '';
  mates.forEach(function (pid) {
    var p = (S.game.players || []).find(function (x) { return x.pid === pid; });
    var b = document.createElement('button');
    b.className = 'btn B-out';
    b.style.cssText = 'width:100%;justify-content:flex-start;gap:10px;';
    b.innerHTML = avatarHTML(p, 30, 'var(--orange)') + '<span style="font-family:\'Barlow Condensed\',sans-serif;font-weight:800;font-size:16px;text-transform:uppercase;">' + esc(p.prenom) + '</span>';
    b.onclick = function () { closeDFPicker(); createVote(pid); };
    list.appendChild(b);
  });
  document.getElementById('df-picker').style.display = 'flex';
}
function closeDFPicker() { document.getElementById('df-picker').style.display = 'none'; }

function createVote(targetPid) {
  if (!FB_OK || !S.game) return;
  var myPid = S.player.pid;
  var dep = (S.game.departs || {})[myPid];
  var votes = {}; votes[myPid] = true;          // l'initiateur vote Oui d'office
  var vote = {
    id: 'v_' + Date.now(),
    targetPid: targetPid, target: playerName(targetPid),
    byPid: myPid, by: playerName(myPid),
    depart: dep, votes: votes, createdAt: Date.now()
  };
  DB.collection('games').doc(S.gameId).update({ vote: vote, updatedAt: firebase.firestore.FieldValue.serverTimestamp() })
    .then(function () { toast('Vote DF lancé contre ' + vote.target + ' ⛳'); resolveVoteIfNeeded(); });
}
/* Suis-je éligible pour voter sur le vote en cours ? */
function voteEligible() {
  var v = S.game && S.game.vote; if (!v) return false;
  var myPid = S.player.pid;
  if (myPid === v.targetPid) return false;
  return (S.game.departs || {})[myPid] === v.depart;
}
function renderVoteBox() {
  var box = document.getElementById('g-vote'); if (!box) return;
  var v = S.game && S.game.vote;
  if (!v || !voteEligible() || (v.votes && v.votes[S.player.pid] !== undefined)) {
    box.style.display = 'none'; box.innerHTML = ''; return;
  }
  box.style.display = 'block';
  box.innerHTML =
    '<div style="background:#FFF6EC;border:2px solid var(--orange);border-radius:16px;padding:12px 14px;display:flex;align-items:center;gap:10px;">' +
      '<div style="flex:1;font-family:\'Barlow Condensed\',sans-serif;font-weight:800;font-size:15px;text-transform:uppercase;color:var(--text);">DF pour ' + esc(v.target) + ' ?<div style="font-size:11px;color:var(--muted);font-weight:600;text-transform:none;">Proposé par ' + esc(v.by) + '</div></div>' +
      '<button onclick="castVote(true)" style="background:var(--green);border:none;color:#fff;border-radius:30px;padding:8px 16px;font-family:\'Barlow Condensed\',sans-serif;font-weight:800;cursor:pointer;">Oui</button>' +
      '<button onclick="castVote(false)" style="background:#fff;border:2px solid var(--border);color:var(--muted);border-radius:30px;padding:8px 16px;font-family:\'Barlow Condensed\',sans-serif;font-weight:800;cursor:pointer;">Non</button>' +
    '</div>';
}
function castVote(yes) {
  if (!FB_OK || !S.game || !S.game.vote) return;
  var upd = {}; upd['vote.votes.' + S.player.pid] = !!yes;
  DB.collection('games').doc(S.gameId).update(upd).then(function () { resolveVoteIfNeeded(); });
}
/* Résolution : la majorité des éligibles (membres du départ sauf la cible) */
function resolveVoteIfNeeded() {
  var v = S.game && S.game.vote; if (!v) return;
  var eligible = departMembers(v.depart).filter(function (pid) { return pid !== v.targetPid; });
  var N = eligible.length; if (N === 0) return;
  var yes = 0, no = 0;
  eligible.forEach(function (pid) { var val = v.votes ? v.votes[pid] : undefined; if (val === true) yes++; else if (val === false) no++; });
  var need = Math.floor(N / 2) + 1;
  if (yes >= need) {
    var df = Object.assign({}, S.game.df || {});
    df[v.targetPid] = (df[v.targetPid] || 0) + 1;
    DB.collection('games').doc(S.gameId).update({
      df: df, vote: null,
      lastDF: { name: v.target, at: Date.now() },
      updatedAt: firebase.firestore.FieldValue.serverTimestamp()
    });
  } else if (no > N - need) {
    DB.collection('games').doc(S.gameId).update({
      vote: null, lastDFCancel: { name: v.target, at: Date.now() },
      updatedAt: firebase.firestore.FieldValue.serverTimestamp()
    });
  }
}

/* ── Scores + classement ────────────────────────────────────────────────── */
function buildScoreEntities() {
  var pars = S.game.coursePars;
  var units = scoringUnits(S.game);
  var isMatch = (MODES[S.game.mode] || {}).matchplay;
  var isHostDevice = !S.spectating && S.game.host === S.player.pid;

  var ents = units.map(function (u) {
    var editable = u.players.some(function (p) { return S.myPids.indexOf(p.pid) >= 0; }) && !S.spectating;
    var scores = (editable && S.local[u.key]) ? S.local[u.key] : getScores(u.key);
    var sub = u.type === 'team' ? 'Équipe' : ('Index ' + (u.player ? u.player.index : '—') + ' · ' + teeLabel(u.player && u.player.teeColor));
    var hasHost = u.players.some(function (p) { return p.pid === S.game.host; });
    return { label: u.label, sub: sub, p: u.p, scores: scores, key: u.key, editable: editable, me: editable, type: u.type, removable: isHostDevice && !hasHost, player: u.player };
  });

  var cv = gCroixVal();
  var useNet = S.netView && netAvailable();
  var isStab = (MODES[S.game.mode] || {}).stableford;
  ents.forEach(function (en) {
    // Coups rendus par trou (joueurs individuels uniquement)
    en.strokes = (en.type === 'player' && en.player) ? strokesArray(en.player.index, en.player) : null;
    en.hasNet = !!en.strokes;
    var gross = unitTotals(en.scores, pars, null, cv, false);
    var net = unitTotals(en.scores, pars, en.strokes, cv, true);
    en.n = gross.n;
    en.totalGross = gross.total; en.ecartGross = gross.ecart;
    en.totalNet = net.total; en.ecartNet = net.ecart;
    var showNet = useNet && en.hasNet;
    en.total = showNet ? net.total : gross.total;
    en.ecart = showNet ? net.ecart : gross.ecart;
    en.showNet = showNet;
    // Stableford
    if (isStab) {
      en.stableford = true;
      en.points = stablefordTotal(en.scores, pars, en.strokes, cv).total;
    }
  });

  if (isMatch && ents.length === 2) {
    var diff = matchPlayDiff(ents[0].scores, ents[1].scores, pars);
    ents[0].mp = mpLabel(diff);
    ents[1].mp = mpLabel(-diff);
    ents[0]._mpVal = diff;
    ents[1]._mpVal = -diff;
    ents.sort(function (a, b) { return b._mpVal - a._mpVal; });
  } else if (isStab) {
    // Stableford : le plus de points gagne (en attente = en bas)
    ents.sort(function (a, b) { if (a.n === 0 && b.n === 0) return 0; if (a.n === 0) return 1; if (b.n === 0) return -1; return b.points - a.points; });
  } else {
    ents.sort(function (a, b) { if (a.n === 0 && b.n === 0) return 0; if (a.n === 0) return 1; if (b.n === 0) return -1; return a.ecart - b.ecart; });
  }
  return ents;
}
function setNetView(net) {
  S.netView = net;
  var b = document.getElementById('sc-net-brut'), n = document.getElementById('sc-net-net');
  if (b) b.className = 'net-toggle' + (net ? '' : ' active');
  if (n) n.className = 'net-toggle' + (net ? ' active' : '');
  var sb = document.getElementById('sh-net-brut'), sn = document.getElementById('sh-net-net');
  if (sb) sb.className = 'net-toggle' + (net ? '' : ' active');
  if (sn) sn.className = 'net-toggle' + (net ? ' active' : '');
  refreshScores();
  if (S.sheetOpen) renderSheet();
}
function refreshScores() {
  var box = document.getElementById('sc-cards');
  if (!S.game) { box.innerHTML = '<div style="text-align:center;padding:40px;color:var(--muted);">Aucune partie en cours</div>'; return; }
  txt('sc-info', (S.game.name || S.game.courseName).toUpperCase() + ' · ' + MODES[S.game.mode].label.toUpperCase());
  document.getElementById('sc-spectator').style.display = S.spectating ? 'block' : 'none';
  // Bouton Brut/Net : seulement en Stroke Play avec handicap renseigné
  var nw = document.getElementById('sc-net-wrap');
  if (nw) nw.style.display = netAvailable() ? 'flex' : 'none';
  box.innerHTML = '';
  var pars = S.game.coursePars;
  buildScoreEntities().forEach(function (en, rank) { box.appendChild(scoreCard(en, rank, pars)); });
  updateViewerDisplays();
}
function scoreCard(en, rank, pars) {
  var medals = ['🥇', '🥈', '🥉'];
  var isMatch = !!en.mp;
  var pos = isMatch ? (en._mpVal > 0 ? '👑' : (en._mpVal < 0 ? '' : '=')) : (en.n > 0 ? (rank < 3 ? medals[rank] : '#' + (rank + 1)) : '–');
  var strokes = en.strokes || Array(18).fill(0);
  var showNet = en.showNet;
  var cv0 = gCroixVal();
  function std(s, par, holeIdx) {
    var st = strokes[holeIdx] || 0;
    var dots = st > 0 ? '<span style="color:var(--green);font-size:8px;vertical-align:super;letter-spacing:-1px;">' + (st >= 2 ? '••' : '•') + '</span>' : '';
    // Stableford : on affiche les points du trou
    if (en.stableford) {
      var pts = holeStableford(s, par, st, cv0);
      if (pts === null) return '<td style="color:#ccc;font-size:12px;">·' + dots + '</td>';
      var pc = pts === 0 ? 'var(--red)' : (pts === 1 ? 'var(--orange)' : (pts === 2 ? 'var(--text)' : 'var(--green)'));
      var pf = pts >= 3 ? '900' : '700';
      return '<td style="color:' + pc + ';font-weight:' + pf + ';">' + pts + dots + '</td>';
    }
    if (s === null || s === undefined) return '<td style="color:#ccc;font-size:12px;">·' + dots + '</td>';
    if (s === 'X') return '<td style="color:var(--red);font-weight:900;">✕' + dots + '</td>';
    var shown = showNet ? (s - st) : s;
    var e = shown - par, c = 'var(--text)', fw = '700';
    if (e <= -2) c = 'var(--gold)'; else if (e === -1) { c = 'var(--green)'; fw = '900'; }
    else if (e === 1) c = 'var(--orange)'; else if (e >= 2) { c = 'var(--red)'; fw = '900'; }
    return '<td style="color:' + c + ';font-weight:' + fw + ';">' + shown + dots + '</td>';
  }
  var al = en.scores.slice(0, 9), ret = en.scores.slice(9, 18);
  var pAl = pars.slice(0, 9).reduce(function (a, b) { return a + b; }, 0), pRet = pars.slice(9, 18).reduce(function (a, b) { return a + b; }, 0);
  var cv = gCroixVal();
  var tAl, tRet;
  if (en.stableford) {
    tAl = stablefordTotal(al, pars.slice(0, 9), strokes.slice(0, 9), cv).total;
    tRet = stablefordTotal(ret, pars.slice(9, 18), strokes.slice(9, 18), cv).total;
  } else {
    tAl = unitTotals(al, pars.slice(0, 9), strokes.slice(0, 9), cv, showNet).total;
    tRet = unitTotals(ret, pars.slice(9, 18), strokes.slice(9, 18), cv, showNet).total;
  }
  var ecTxt = en.n > 0 ? ((en.ecart >= 0 ? '+' : '') + en.ecart) : '';
  var ecCol = en.ecart <= 0 ? 'var(--green)' : 'var(--red)';
  var netTag = showNet ? ' <span style="font-size:10px;color:var(--green);">NET</span>' : '';

  // Bloc de droite : Match Play, Stableford, ou total classique
  var rightBlock;
  if (isMatch) {
    var mpCol = en._mpVal > 0 ? 'var(--green)' : (en._mpVal < 0 ? 'var(--red)' : 'var(--text)');
    rightBlock = '<div style="font-family:\'Barlow Condensed\',sans-serif;font-weight:900;font-size:24px;color:' + mpCol + ';">' + en.mp + '</div>' +
                 '<div style="font-size:11px;color:var(--muted);">' + (en.n > 0 ? en.total + ' coups' : 'en attente') + '</div>';
  } else if (en.stableford) {
    rightBlock = '<div style="font-family:\'Barlow Condensed\',sans-serif;font-weight:900;font-size:30px;color:var(--green);">' + (en.n > 0 ? en.points : '—') + '</div>' +
                 '<div style="font-size:11px;color:var(--muted);">' + (en.n > 0 ? 'points' : 'en attente') + '</div>';
  } else {
    rightBlock = '<div style="font-family:\'Barlow Condensed\',sans-serif;font-weight:900;font-size:30px;">' + (en.n > 0 ? en.total : '—') + netTag + '</div>' +
                 (en.n > 0 ? '<div style="font-size:12px;color:' + ecCol + ';font-weight:700;">' + ecTxt + ' / par</div>' : '<div style="font-size:11px;color:var(--muted);">en attente</div>');
  }

  var dfCount = (en.type === 'player' && en.player && S.game.df) ? (S.game.df[en.player.pid] || 0) : 0;
  var dfBadge = dfCount > 0 ? ' <span style="display:inline-block;background:var(--orange);color:#fff;font-size:10px;font-weight:800;padding:1px 7px;border-radius:20px;vertical-align:middle;">DF ×' + dfCount + '</span>' : '';
  var card = document.createElement('div'); card.className = 'card';
  card.style.border = en.me ? '2px solid var(--green)' : 'none';
  if (en.editable) {
    card.style.cursor = 'pointer';
    card.onclick = function () { setActiveEntity(en.key); go('s-game'); };
  }
  var removeBtn = en.removable
    ? '<button class="kick-card" title="Retirer" style="background:#FFF0F0;border:none;color:var(--red);width:30px;height:30px;border-radius:50%;font-size:18px;line-height:1;cursor:pointer;flex-shrink:0;-webkit-tap-highlight-color:transparent;">×</button>'
    : '';
  card.innerHTML =
    '<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:14px;gap:8px;">' +
      '<div style="display:flex;align-items:center;gap:10px;min-width:0;">' +
        '<div style="font-family:\'Barlow Condensed\',sans-serif;font-weight:900;font-size:18px;min-width:24px;text-align:center;">' + pos + '</div>' +
        avatarHTML(en.p, 34, en.me ? 'var(--green)' : 'var(--bg)', en.me ? '#fff' : 'var(--text)') +
        '<div style="min-width:0;"><div style="font-family:\'Barlow Condensed\',sans-serif;font-weight:800;font-size:16px;text-transform:uppercase;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">' + esc(en.label) + dfBadge + (en.editable ? ' <span style="font-size:10px;color:var(--green);">✎</span>' : '') + '</div>' +
        '<div style="font-size:11px;color:var(--muted);">' + esc(en.sub) + '</div></div>' +
      '</div>' +
      '<div style="display:flex;align-items:center;gap:8px;flex-shrink:0;"><div style="text-align:right;">' + rightBlock + '</div>' + removeBtn + '</div>' +
    '</div>' +
    '<div style="overflow-x:auto;-webkit-overflow-scrolling:touch;"><table class="st" style="min-width:100%;">' +
      '<tr><th></th>' + [1, 2, 3, 4, 5, 6, 7, 8, 9].map(function (n) { return '<th>' + n + '</th>'; }).join('') + '<th class="tot">Al.</th></tr>' +
      '<tr><td style="font-size:10px;color:var(--muted);">Par</td>' + pars.slice(0, 9).map(function (p) { return '<td style="font-size:10px;color:var(--muted);">' + p + '</td>'; }).join('') + '<td class="tot" style="font-size:10px;color:var(--muted);">' + pAl + '</td></tr>' +
      '<tr><td></td>' + al.map(function (s, i) { return std(s, pars[i], i); }).join('') + '<td class="tot">' + (tAl || '—') + '</td></tr>' +
      '<tr><td colspan="11" style="height:6px;"></td></tr>' +
      '<tr><th></th>' + [10, 11, 12, 13, 14, 15, 16, 17, 18].map(function (n) { return '<th>' + n + '</th>'; }).join('') + '<th class="tot">Ret.</th></tr>' +
      '<tr><td style="font-size:10px;color:var(--muted);">Par</td>' + pars.slice(9, 18).map(function (p) { return '<td style="font-size:10px;color:var(--muted);">' + p + '</td>'; }).join('') + '<td class="tot" style="font-size:10px;color:var(--muted);">' + pRet + '</td></tr>' +
      '<tr><td></td>' + ret.map(function (s, i) { return std(s, pars[9 + i], 9 + i); }).join('') + '<td class="tot">' + (tRet || '—') + '</td></tr>' +
    '</table></div>';
  if (en.removable) {
    var kb = card.querySelector('.kick-card');
    if (kb) kb.onclick = function (ev) { ev.stopPropagation(); removeEntity(en.key); };
  }
  return card;
}

/* ── Fin / quitter (avec suppression auto) ─────────────────────────────── */
function endGame() {
  if (!S.game) return; leaveHole(); closeSheet();
  txt('fin-sub', (S.game.name || S.game.courseName) + ' · ' + MODES[S.game.mode].label);
  var pars = S.game.coursePars;
  var ents = buildScoreEntities();
  var isMatch = (MODES[S.game.mode] || {}).matchplay;
  var isStab = (MODES[S.game.mode] || {}).stableford;
  var body = document.getElementById('fin-body');
  body.innerHTML = '';
  // Vainqueur en tête
  var top = ents[0];
  if (top && (top.n > 0 || isMatch)) {
    var winTxt = isMatch ? (top._mpVal > 0 ? top.label + ' gagne (' + top.mp + ')' : (top._mpVal === 0 ? 'Match nul' : '')) : top.label;
    var detail = '';
    if (isMatch) detail = '';
    else if (isStab) detail = '<div style="font-size:14px;color:rgba(255,255,255,.9);font-weight:700;">' + top.points + ' points</div>';
    else detail = '<div style="font-size:14px;color:rgba(255,255,255,.9);font-weight:700;">' + top.total + ' coups · ' + (top.ecart >= 0 ? '+' : '') + top.ecart + ' / par</div>';
    var head = document.createElement('div');
    head.className = 'card';
    head.style.cssText = 'text-align:center;background:var(--green);';
    head.innerHTML =
      '<div style="font-size:12px;color:rgba(255,255,255,.85);font-family:\'Barlow Condensed\',sans-serif;font-weight:700;text-transform:uppercase;letter-spacing:.05em;">🏆 ' + (isMatch ? 'Résultat' : 'Vainqueur') + '</div>' +
      '<div style="font-family:\'Barlow Condensed\',sans-serif;font-weight:900;font-size:26px;color:#fff;text-transform:uppercase;margin-top:4px;">' + esc(winTxt || top.label) + '</div>' +
      detail;
    body.appendChild(head);
  }
  // Toutes les cartes
  ents.forEach(function (en, rank) { body.appendChild(scoreCard(en, rank, pars)); });
  go('s-fin');
}
/* Quand on confirme la fin : on se retire de la partie. Le dernier supprime le doc. */
function confirmEnd() {
  leaveAndMaybeDelete(function () { clearSessionLocal(); go('s-home'); });
}
function quitGame() {
  if (!confirm('Quitter la partie ? Tu seras retiré de la liste des joueurs.')) return;
  leaveAndMaybeDelete(function () { clearSessionLocal(); go('s-home'); });
}
function leaveAndMaybeDelete(done) {
  if (!FB_OK || !S.gameId) { done(); return; }
  var id = S.gameId;
  var leaving = (S.myPids && S.myPids.length) ? S.myPids.slice() : [S.player.pid];
  DB.collection('games').doc(id).get().then(function (snap) {
    if (!snap.exists) { done(); return; }
    var data = snap.data();
    var remaining = (data.players || []).filter(function (p) { return leaving.indexOf(p.pid) < 0; });
    if (remaining.length === 0) {
      // plus personne → on supprime toute la partie
      DB.collection('games').doc(id).delete().then(done).catch(function (e) { console.error(e); done(); });
    } else {
      var ns = Object.assign({}, data.scores);
      leaving.forEach(function (pid) { delete ns[pid]; });
      // Transfert d'hôte si l'hôte part
      var newHost = data.host;
      if (leaving.indexOf(data.host) >= 0) newHost = remaining[0].pid;
      // Retirer des équipes (en conservant les id stables)
      var teams = (data.teams || []).map(function (t) {
        return { id: t.id, players: t.players.filter(function (pp) { return pp && leaving.indexOf(pp.pid) < 0; }) };
      }).filter(function (t) { return t.players.length > 0; });
      DB.collection('games').doc(id).update({
        players: remaining, scores: ns, host: newHost, teams: teams,
        updatedAt: firebase.firestore.FieldValue.serverTimestamp()
      }).then(done).catch(function (e) { console.error(e); done(); });
    }
  }).catch(function (e) { console.error(e); done(); });
}
function backHome() { confirmEnd(); }
function clearSessionLocal() {
  if (S.unsub) { S.unsub(); S.unsub = null; }
  stopHeartbeat();
  closeSheet();
  S.game = null; S.gameId = null; S.hole = 0; S.started = false; S.spectating = false;
  S.myPids = []; S.editable = []; S.activeKey = null; S.local = {}; S.writeTs = {};
  S.extras = []; S.notified = {};
  localStorage.removeItem('tb_session');
  renderPlayerList(); renderHomeParties();
}

/* ── Carte « ma partie en cours » (accueil) ────────────────────────────── */
function renderHomeParties() {
  var c = document.getElementById('home-mine'), e = document.getElementById('mine-empty');
  if (!c || !e) return;
  if (!S.gameId || S.spectating) { c.innerHTML = ''; e.style.display = 'block'; return; }
  e.style.display = 'none';
  var myScores = S.activeKey ? getScores(S.activeKey) : Array(18).fill(null);
  var n = countPlayed(myScores);
  var tot = totalStrokes(myScores, S.game ? S.game.coursePars : Array(18).fill(0), gCroixVal());
  var pct = Math.round(n / 18 * 100);
  var name = (S.game && (S.game.name || S.game.courseName)) || 'Partie';
  var mlabel = (S.game && MODES[S.game.mode]) ? MODES[S.game.mode].label : '';
  var status = (S.game && S.game.status === 'lobby') ? 'salon' : 'jeu';
  var target = status === 'salon' ? 's-salon' : 's-game';
  c.innerHTML =
    '<div class="card" style="cursor:pointer;border:2px solid var(--green);" onclick="resume(\'' + target + '\')">' +
    '<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:10px;">' +
      '<div><div style="font-family:\'Barlow Condensed\',sans-serif;font-weight:900;font-size:18px;text-transform:uppercase;">' + esc(name) + '</div>' +
      '<div style="font-size:12px;color:var(--muted);">' + mlabel + (status === 'salon' ? ' · en attente' : '') + '</div></div>' +
      '<div style="text-align:right;"><div style="font-family:\'Barlow Condensed\',sans-serif;font-weight:900;font-size:32px;">' + (tot || '0') + '</div>' +
      '<div style="font-size:11px;color:var(--muted);">' + n + '/18 trous</div></div></div>' +
    '<div style="height:5px;background:var(--bg);border-radius:3px;overflow:hidden;">' +
      '<div style="height:5px;background:var(--green);border-radius:3px;width:' + pct + '%;transition:width .3s;"></div></div>' +
    '<div style="font-size:11px;color:var(--muted);margin-top:6px;text-align:right;">Appuie pour reprendre →</div></div>';
}
function resume(target) {
  if (target === 's-game') { buildHolePicker(); go('s-game'); }
  else go('s-salon');
}

/* ── Mode spectateur ───────────────────────────────────────────────────── */
function spectateGame(id) {
  if (!S.player) { toast('Crée ton profil d\'abord 👆'); go('s-profil'); return; }
  if (!FB_OK) { toast('⚠️ Firebase indisponible'); return; }
  if (S.gameId && !S.spectating) { toast('Termine ta partie avant de regarder une autre'); return; }
  S.gameId = id; S.spectating = true; S.started = true;
  S.myPids = []; S.editable = []; S.activeKey = null; S.local = {};
  attachGameListener(id);
  registerViewer();
  startHeartbeat();
  go('s-scores');
  toast('Mode spectateur 👁', true);
}
function registerViewer() {
  if (!FB_OK || !S.gameId || !S.player || !S.spectating) return;
  var upd = {}; upd['viewers.' + S.player.pid] = Date.now();
  DB.collection('games').doc(S.gameId).update(upd).catch(function () {});
}
function startHeartbeat() { stopHeartbeat(); S.hbTimer = setInterval(registerViewer, 15000); }
function stopHeartbeat() { if (S.hbTimer) { clearInterval(S.hbTimer); S.hbTimer = null; } }
function removeViewer(done) {
  done = done || function () {};
  if (!FB_OK || !S.gameId || !S.player) { done(); return; }
  var upd = {}; upd['viewers.' + S.player.pid] = firebase.firestore.FieldValue.delete();
  DB.collection('games').doc(S.gameId).update(upd).then(done).catch(done);
}
function countViewers(game) {
  if (!game || !game.viewers) return 0;
  var now = Date.now(), n = 0;
  Object.keys(game.viewers).forEach(function (k) { if (now - game.viewers[k] < 30000) n++; });
  return n;
}
function updateViewerDisplays() {
  var n = countViewers(S.game);
  function setBadge(wrapId, numId) {
    var w = document.getElementById(wrapId), num = document.getElementById(numId);
    if (!w || !num) return;
    if (n > 0) { w.style.display = 'inline-flex'; num.textContent = n; }
    else w.style.display = 'none';
  }
  setBadge('sc-viewers', 'sc-viewers-n');
  setBadge('g-viewers', 'g-viewers-n');
}
function leaveSpectate() {
  stopHeartbeat();
  removeViewer(function () {
    if (S.unsub) { S.unsub(); S.unsub = null; }
    S.game = null; S.gameId = null; S.spectating = false; S.started = false;
    renderHomeParties(); refreshOpenGames(); go('s-home');
  });
}
function closeScores() {
  if (S.spectating) leaveSpectate();
  else go('s-game');
}

/* ── Export JPEG des cartes ────────────────────────────────────────────── */
function exportScores() {
  if (!S.game) { toast('Aucune partie'); return; }
  if (typeof html2canvas === 'undefined') { toast('Module export indisponible (connexion ?)'); return; }
  toast('Génération de l\'image...');
  var pars = S.game.coursePars;
  var ents = buildScoreEntities();

  var box = document.createElement('div');
  box.style.cssText = 'position:fixed;left:-9999px;top:0;width:440px;background:#F0F0EE;padding:26px 22px;font-family:Barlow,sans-serif;';
  box.innerHTML =
    '<div style="text-align:center;margin-bottom:18px;">' +
    '<div style="font-family:\'Barlow Condensed\',sans-serif;font-weight:900;font-size:28px;text-transform:uppercase;line-height:1;">' + esc(S.game.name || S.game.courseName) + '</div>' +
    '<div style="font-size:13px;color:#888;margin-top:4px;">' + esc(S.game.courseName) + ' · ' + MODES[S.game.mode].label + ' · ' + new Date().toLocaleDateString('fr-FR') + '</div></div>';
  var stack = document.createElement('div');
  stack.style.cssText = 'display:flex;flex-direction:column;gap:12px;';
  ents.forEach(function (en, rank) { stack.appendChild(scoreCard(en, rank, pars)); });
  box.appendChild(stack);
  var foot = document.createElement('div');
  foot.style.cssText = 'display:flex;align-items:center;justify-content:center;gap:8px;margin-top:18px;opacity:.5;';
  foot.innerHTML = '<img src="hs-logo.png" style="height:20px;"><img src="hs-text.png" style="height:11px;">';
  box.appendChild(foot);
  document.body.appendChild(box);

  html2canvas(box, { backgroundColor: '#F0F0EE', scale: 2, useCORS: true, logging: false }).then(function (canvas) {
    var url = canvas.toDataURL('image/jpeg', 0.92);
    var a = document.createElement('a');
    a.href = url;
    a.download = 'teebuddy-' + String(S.game.name || 'partie').replace(/[^a-z0-9]/gi, '-').toLowerCase() + '.jpg';
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
    if (box.parentNode) box.parentNode.removeChild(box);
    toast('Carte exportée ✓', true);
  }).catch(function (e) {
    console.error(e); if (box.parentNode) box.parentNode.removeChild(box);
    toast('Erreur lors de l\'export');
  });
}

/* ── Utils ──────────────────────────────────────────────────────────────── */
function val(id) { var e = document.getElementById(id); return e ? e.value : ''; }
function trim(id) { return val(id).trim(); }
function setv(id, v) { var e = document.getElementById(id); if (e) e.value = v; }
function txt(id, v) { var e = document.getElementById(id); if (e) e.textContent = v; }
function fullname(j) { return j.prenom + (j.nom ? ' ' + j.nom : ''); }
function esc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }
function lget(k) { try { return JSON.parse(localStorage.getItem(k)); } catch (e) { return null; } }
function lset(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} }
/* ════════════════════════════════════════════════════════════════════════
   LIVE SCORECARDS — calque qui monte par-dessus l'écran de saisie.
   Ouvert par : tap sur l'amorce, swipe vertical depuis l'amorce, ou bouton
   grille en haut. Fermé par : swipe vers le bas sur l'en-tête, ou bouton ⌄.
════════════════════════════════════════════════════════════════════════ */
function sheetEl() { return document.getElementById('live-sheet'); }
function updateSheetDock(id) {
  var el = sheetEl(); if (!el) return;
  var docked = id === 's-game' && !!S.game;
  el.classList.toggle('docked', docked);
  var game = document.getElementById('s-game');
  if (game) game.classList.toggle('sheet-docked', docked);
  if (!docked) closeSheet(true);
}
function openSheet() {
  if (!S.game) { toast('Aucune partie en cours'); return; }
  renderSheet();
  var el = sheetEl(); if (!el) return;
  el.classList.remove('dragging'); el.style.transform = '';
  el.classList.add('open');
  S.sheetOpen = true;
  buzz(18);
}
function closeSheet(silent) {
  var el = sheetEl(); if (!el) return;
  el.classList.remove('dragging'); el.style.transform = '';
  el.classList.remove('open');
  S.sheetOpen = false;
  if (!silent) buzz(12);
}
function renderSheet() {
  var box = document.getElementById('sheet-cards'); if (!box || !S.game) return;
  // Bascule Brut/Net (Stroke Play + handicap dispo uniquement)
  var nw = document.getElementById('sheet-net');
  if (nw) nw.style.display = netAvailable() ? 'flex' : 'none';
  var b = document.getElementById('sh-net-brut'), n = document.getElementById('sh-net-net');
  if (b) b.className = 'net-toggle' + (S.netView ? '' : ' active');
  if (n) n.className = 'net-toggle' + (S.netView ? ' active' : '');
  box.innerHTML = '';
  var pars = S.game.coursePars;
  buildScoreEntities().forEach(function (en, rank) {
    var card = scoreCard(en, rank, pars);
    if (en.editable) {
      // Dans le calque : choisir sa carte = passer en saisie dessus et refermer
      card.onclick = function () { setActiveEntity(en.key); closeSheet(); };
    }
    box.appendChild(card);
  });
}

/* Glisser : l'en-tête visible est la vraie amorce du calque live */
function initSheetGestures() {
  var sheet = sheetEl();
  var head = document.getElementById('sheet-head');
  if (!sheet || !head) return;
  var dockY = function () { return Math.max(0, sheet.offsetHeight - head.offsetHeight); };

  // En-tête/amorce : vers le haut pour ouvrir, vers le bas pour fermer.
  var hStart = null, hDragged = false;
  head.addEventListener('touchstart', function (e) {
    if (e.target.closest('button')) return;   // laisser vivre les boutons (⌄, Brut/Net)
    if (!S.game) return;
    renderSheet();
    hStart = e.touches[0].clientY; hDragged = false;
  }, { passive: true });
  head.addEventListener('touchmove', function (e) {
    if (hStart === null) return;
    var diff = e.touches[0].clientY - hStart; // >0 = vers le bas
    var pos = S.sheetOpen ? Math.max(0, diff) : Math.max(0, dockY() + diff);
    if (Math.abs(diff) > 6) {
      hDragged = true;
      sheet.classList.add('dragging');
      sheet.style.transform = 'translateY(' + pos + 'px)';
      e.preventDefault();
    }
  }, { passive: false });
  head.addEventListener('touchend', function (e) {
    if (hStart === null) return;
    var diff = e.changedTouches[0].clientY - hStart;
    hStart = null;
    if (!S.game) return;
    if (!hDragged) {
      if (!S.sheetOpen) openSheet();
      return;
    }
    if (S.sheetOpen && diff > 110) closeSheet();
    else if (!S.sheetOpen && diff < -90) openSheet();
    else { sheet.classList.remove('dragging'); sheet.style.transform = ''; }
  });
  head.addEventListener('click', function (e) {
    if (e.target.closest('button') || S.sheetOpen || !S.game) return;
    openSheet();
  });
}

function toast(msg, ok) {
  var el = document.getElementById('toast'); if (!el) return;
  el.textContent = msg; el.className = 'show' + (ok ? ' ok' : '');
  clearTimeout(window._tt); window._tt = setTimeout(function () { el.className = ''; }, 3200);
}

/* ── Feedback sensoriel ────────────────────────────────────────────────── */
/* Vibration (Android ; sans effet sur iPhone, le pop visuel prend le relais) */
function buzz(pattern) {
  try {
    if (S.settings && S.settings.vibration === false) return false;
    if (!navigator.vibrate) return false;
    var p = Array.isArray(pattern)
      ? pattern.map(function (v) { return Math.max(20, v); })
      : Math.max(20, pattern || 20);
    return navigator.vibrate(p);
  } catch (e) {}
  return false;
}
/* Petit "pop" du chiffre du score à chaque saisie */
function popScore() {
  var el = document.getElementById('g-score'); if (!el) return;
  el.classList.remove('pop');
  void el.offsetWidth;   // force le redémarrage de l'animation
  el.classList.add('pop');
}
/* Message de score affiché au-dessus de la ligne Trou · Par */
function gameMsg(msg, good) {
  var el = document.getElementById('g-msg'); if (!el) { toast(msg, good); return; }
  el.textContent = msg;
  el.style.color = good ? 'var(--green)' : 'var(--orange)';
  el.classList.add('show');
  clearTimeout(window._gm);
  window._gm = setTimeout(function () { el.classList.remove('show'); }, 4000);
}
