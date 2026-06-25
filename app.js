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

/* ── État global ────────────────────────────────────────────────────────── */
var S = {
  player: null,       // { prenom, nom, index, pid, avatar? }
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
  writeTs: {}         // horodatage des dernières écritures (anti-écrasement)
};
var selCourse = (COURSES[0] && COURSES[0].id) || null;

/* ── Boot ───────────────────────────────────────────────────────────────── */
function boot() {
  applyLogos();
  addFooters();
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
  if (FB_OK) { attachOpenGamesListener(); loadCoursesFromDB(); }
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
function sumNums(arr) { return arr.reduce(function (a, b) { return a + (typeof b === 'number' ? b : 0); }, 0); }
function countPlayed(arr) { return arr.filter(function (s) { return s !== null && s !== undefined; }).length; }
function parForNumeric(scores, pars) { var s = 0; for (var i = 0; i < scores.length; i++) { if (typeof scores[i] === 'number') s += pars[i]; } return s; }

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
  if (!pr) { toast('Entre ton prénom 👋'); return; }
  S.player = { prenom: pr, nom: no, index: ix, pid: 'p_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6) };
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
  setAvatar('pf-av', S.player, 'var(--green)');
  txt('pf-name', fullname(S.player));
  txt('pf-idx', S.player.index || '—');
  var rm = document.getElementById('pf-remove-av');
  if (rm) rm.style.display = S.player.avatar ? 'block' : 'none';
}
function saveProfil() {
  var pr = trim('pf-prenom'), no = trim('pf-nom'), ix = parseFloat(val('pf-index')) || 0;
  if (!pr) { toast('Entre ton prénom'); return; }
  S.player = Object.assign({}, S.player, { prenom: pr, nom: no, index: ix });
  lset('tb_player', S.player); updatePlayerUI(); fillProfilForm();
  toast('Profil mis à jour ✓', true);
  setTimeout(back, 700);
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
  S.extras.push({ prenom: pr, index: ix, id: 'x' + Date.now(), pid: 'x_' + Date.now() + '_' + Math.random().toString(36).slice(2, 5) });
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
      '<div style="font-size:12px;color:var(--muted);">Idx ' + j.index + '</div>' +
      (j.self ? '<span style="font-size:11px;color:var(--green);font-family:\'Barlow Condensed\',sans-serif;font-weight:700;flex-shrink:0;">MOI</span>'
              : '<button onclick="removePlayerExtra(\'' + j.id + '\')" class="x-btn">×</button>');
    el.appendChild(d);
  });
}

/* Génère un identifiant de partie court à 4 chiffres, non déjà pris */
function newGameId() {
  return String(Math.floor(1000 + Math.random() * 9000));
}

function createGame() {
  if (!S.player) { toast('Crée ton profil d\'abord 👆'); go('s-profil'); return; }
  if (!FB_OK) { toast('⚠️ Firebase indisponible'); return; }
  var course = COURSES.find(function (c) { return c.id === selCourse; });
  if (!course) { toast('Sélectionne un parcours'); return; }
  var nom = trim('new-name') || ('Partie de ' + S.player.prenom);

  var me = { prenom: S.player.prenom, nom: S.player.nom || '', index: S.player.index, pid: S.player.pid };
  if (S.player.avatar) me.avatar = S.player.avatar;
  var players = [me].concat(S.extras.map(function (e) { return { prenom: e.prenom, index: e.index, pid: e.pid }; }));

  var id = newGameId();
  var scores = {}; players.forEach(function (j) { scores[j.pid] = Array(18).fill(null); });

  var data = {
    name: nom,
    courseId: course.id, courseName: course.nom,
    coursePars: course.pars, parTotal: course.parTotal,
    mode: 'stroke', host: S.player.pid,
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
      var me = { prenom: S.player.prenom, nom: S.player.nom || '', index: S.player.index, pid: myPid };
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

    var card = document.createElement('div');
    card.className = 'card';
    card.innerHTML =
      '<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:10px;gap:10px;">' +
        '<div style="min-width:0;"><div style="font-family:\'Barlow Condensed\',sans-serif;font-weight:900;font-size:17px;text-transform:uppercase;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">' + esc(g.name || g.courseName) + '</div>' +
        '<div style="font-size:12px;color:var(--muted);">' + esc(g.courseName) + ' · ' + mode + ' · ' + statusTxt + '</div></div>' +
        '<div style="display:flex;align-items:center;gap:8px;flex-shrink:0;">' +
          '<button class="eye-btn" title="Regarder"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="var(--text)" stroke-width="2"><path d="M1 12s4-7 11-7 11 7 11 7-4 7-11 7-11-7-11-7z"/><circle cx="12" cy="12" r="3"/></svg></button>' +
          '<div class="join-pill" style="background:var(--green);color:#fff;font-family:\'Barlow Condensed\',sans-serif;font-weight:800;font-size:12px;padding:8px 14px;border-radius:20px;cursor:pointer;">Rejoindre</div>' +
        '</div>' +
      '</div>' +
      '<div style="display:flex;align-items:center;gap:4px;">' + avatars + more +
        '<span style="font-size:12px;color:var(--muted);margin-left:8px;">' + g.players.length + ' joueur' + (g.players.length > 1 ? 's' : '') + (host ? ' · hôte ' + esc(host) : '') + '</span>' + viewerBadge +
      '</div>';
    // Clics
    card.querySelector('.join-pill').onclick = function (ev) { ev.stopPropagation(); joinGameById(g._id); };
    card.querySelector('.eye-btn').onclick = function (ev) { ev.stopPropagation(); spectateGame(g._id); };
    box.appendChild(card);
  });
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
    if (!S.spectating) syncScoringState();
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
    if (isActive('s-game'))     refreshGameUI();
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

  var jl = document.getElementById('sl-joueurs'); jl.innerHTML = '';
  (g.players || []).forEach(function (j) {
    var me = j.pid === S.player.pid;
    var crown = j.pid === g.host ? ' <span style="font-size:10px;">👑</span>' : '';
    var d = document.createElement('div');
    d.style.cssText = 'display:flex;align-items:center;gap:10px;padding:12px 14px;background:#fff;border-radius:14px;box-shadow:0 1px 6px rgba(0,0,0,.05);' + (me ? 'border:2px solid var(--green);' : '');
    d.innerHTML = avatarHTML(j, 34, 'var(--green)') +
      '<div style="font-family:\'Barlow Condensed\',sans-serif;font-weight:700;font-size:15px;text-transform:uppercase;color:var(--text);">' + j.prenom + crown + (me ? ' <span style="font-size:11px;color:var(--green);">(moi)</span>' : '') + '</div>' +
      '<div style="margin-left:auto;font-size:12px;color:var(--muted);">Index ' + j.index + '</div>';
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
    renderTeams('sl-equipes');
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
function renderTeams(containerId) {
  var el = document.getElementById(containerId); if (!el) return; el.innerHTML = '';
  var teams = S.game.teams || [];
  if (teams.length === 0) {
    el.innerHTML = '<div style="padding:14px;text-align:center;color:var(--muted);font-size:13px;">Appuie sur « Former les équipes » pour répartir les joueurs.</div>';
    return;
  }
  teams.forEach(function (t, i) {
    var d = document.createElement('div'); d.className = 'card';
    d.style.cssText = 'display:flex;align-items:center;gap:12px;';
    var n0 = t.players[0] ? t.players[0].prenom : '?';
    var n1 = t.players[1] ? t.players[1].prenom : '?';
    var ix = ((t.players[0] ? t.players[0].index : 0) + (t.players[1] ? t.players[1].index : 0)).toFixed(1);
    d.innerHTML = '<div style="font-family:\'Barlow Condensed\',sans-serif;font-weight:900;font-size:22px;color:var(--green);min-width:32px;">' + (i + 1) + '</div>' +
      '<div style="flex:1;"><div style="font-family:\'Barlow Condensed\',sans-serif;font-weight:800;font-size:16px;text-transform:uppercase;">' + n0 + ' &amp; ' + n1 + '</div>' +
      '<div style="font-size:12px;color:var(--muted);">Index cumulé : ' + ix + '</div></div>';
    el.appendChild(d);
  });
}
function changeMode(m) {
  if (!FB_OK || !S.game) return;
  if (S.game.host !== S.player.pid) { toast('Seul l\'hôte peut changer le mode'); return; }
  var upd = { mode: m, updatedAt: firebase.firestore.FieldValue.serverTimestamp() };
  // Scramble/MMB : équipes auto. Match Play : on laisse l'hôte choisir (1v1 ou 2v2). Autres : pas d'équipes.
  if (MODES[m].teams) upd.teams = autoTeams(S.game.players);
  else if (!MODES[m].matchplay) upd.teams = [];
  DB.collection('games').doc(S.gameId).update(upd);
}
function autoTeams(players) {
  var sh = (players || []).slice().sort(function () { return Math.random() - .5; });
  var teams = [];
  for (var i = 0; i < sh.length; i += 2) {
    teams.push({ id: 'tm_' + Date.now() + '_' + (i / 2) + '_' + Math.random().toString(36).slice(2, 5), players: [sh[i], sh[i + 1] || null] });
  }
  return teams;
}
function shuffleTeams() {
  if (!FB_OK || S.game.host !== S.player.pid) return;
  DB.collection('games').doc(S.gameId).update({ teams: autoTeams(S.game.players) }).then(function () {
    toast('Équipes mélangées 🔀', true);
  });
}
function launchGame() {
  if (!FB_OK || !S.game) return;
  if (S.game.host !== S.player.pid) { toast('Seul l\'hôte peut lancer'); return; }
  var mode = MODES[S.game.mode] || {};
  if (mode.matchplay) {
    var sides = scoringUnits(S.game).length;
    if (sides !== 2) { toast('Match Play : exactement 2 joueurs (1v1) ou 2 équipes (2v2)'); return; }
  } else if (mode.teams) {
    var n = (S.game.players || []).length;
    if (n < 2) { toast('Ajoute au moins 2 joueurs'); return; }
    if (n % 2) { toast('Nombre pair de joueurs requis'); return; }
    if (!S.game.teams || S.game.teams.length === 0) { toast('Forme les équipes d\'abord 🔀'); return; }
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
    if (MODES[g.mode].teams || MODES[g.mode].matchplay) { ew.style.display = 'block'; renderTeams('set-equipes'); }
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
  saveScore(); refreshGameUI();
}
function setCross() {
  if (!S.game || !S.activeKey) return;
  var arr = activeArr(); if (!arr) return;
  var t = S.hole;
  arr[t] = (arr[t] === 'X') ? null : 'X';
  S.notified[t] = true;       // pas de toast birdie sur une croix
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
function leaveHole() {
  var t = S.hole, sc = getScores(S.activeKey)[t];
  if (typeof sc !== 'number' || S.notified[t]) return;
  var u = (S.editable || []).find(function (x) { return x.key === S.activeKey; });
  var nom = u ? u.label : '';
  var e = sc - S.game.coursePars[t];
  if (e <= -2) { toast('🦅 Eagle ! Incroyable ' + nom + ' !', true); S.notified[t] = true; }
  else if (e === -1) { toast('🐦 Birdie ! Bien joué ' + nom + ' !', true); S.notified[t] = true; }
  else if (e >= 2) { toast('😅 Double bogey... ça arrive !'); S.notified[t] = true; }
}
function prevH() { if (S.hole > 0) { leaveHole(); S.hole--; refreshGameUI(); } }
function nextH() {
  if (S.hole < 17) { leaveHole(); S.hole++; refreshGameUI(); }
  else {
    leaveHole();
    var done = countPlayed(getScores(S.activeKey));
    toast(done === 18 ? '🏆 18 trous joués ! Bravo !' : 'Dernier trou · ' + done + '/18', done === 18);
  }
}

/* ── Scores + classement ────────────────────────────────────────────────── */
function buildScoreEntities() {
  var pars = S.game.coursePars;
  var units = scoringUnits(S.game);
  var isMatch = (MODES[S.game.mode] || {}).matchplay;

  var ents = units.map(function (u) {
    var editable = u.players.some(function (p) { return S.myPids.indexOf(p.pid) >= 0; }) && !S.spectating;
    var scores = (editable && S.local[u.key]) ? S.local[u.key] : getScores(u.key);
    var sub = u.type === 'team' ? 'Équipe' : ('Index ' + (u.player ? u.player.index : '—'));
    return { label: u.label, sub: sub, p: u.p, scores: scores, key: u.key, editable: editable, me: editable, type: u.type };
  });

  ents.forEach(function (en) {
    en.n = countPlayed(en.scores);
    en.total = sumNums(en.scores);
    en.ecart = en.n > 0 ? en.total - parForNumeric(en.scores, pars) : 9999;
  });

  if (isMatch && ents.length === 2) {
    var diff = matchPlayDiff(ents[0].scores, ents[1].scores, pars);
    ents[0].mp = mpLabel(diff);
    ents[1].mp = mpLabel(-diff);
    ents[0]._mpVal = diff;
    ents[1]._mpVal = -diff;
    // Classement : celui qui mène en premier
    ents.sort(function (a, b) { return b._mpVal - a._mpVal; });
  } else {
    ents.sort(function (a, b) { if (a.n === 0 && b.n === 0) return 0; if (a.n === 0) return 1; if (b.n === 0) return -1; return a.ecart - b.ecart; });
  }
  return ents;
}
function refreshScores() {
  var box = document.getElementById('sc-cards');
  if (!S.game) { box.innerHTML = '<div style="text-align:center;padding:40px;color:var(--muted);">Aucune partie en cours</div>'; return; }
  txt('sc-info', (S.game.name || S.game.courseName).toUpperCase() + ' · ' + MODES[S.game.mode].label.toUpperCase());
  document.getElementById('sc-spectator').style.display = S.spectating ? 'block' : 'none';
  box.innerHTML = '';
  var pars = S.game.coursePars;
  buildScoreEntities().forEach(function (en, rank) { box.appendChild(scoreCard(en, rank, pars)); });
  updateViewerDisplays();
}
function scoreCard(en, rank, pars) {
  var medals = ['🥇', '🥈', '🥉'];
  var isMatch = !!en.mp;
  var pos = isMatch ? (en._mpVal > 0 ? '👑' : (en._mpVal < 0 ? '' : '=')) : (en.n > 0 ? (rank < 3 ? medals[rank] : '#' + (rank + 1)) : '–');
  function std(s, par) {
    if (s === null || s === undefined) return '<td style="color:#ccc;font-size:12px;">·</td>';
    if (s === 'X') return '<td style="color:var(--red);font-weight:900;">✕</td>';
    var e = s - par, c = 'var(--text)', fw = '700';
    if (e <= -2) c = 'var(--gold)'; else if (e === -1) { c = 'var(--green)'; fw = '900'; }
    else if (e === 1) c = 'var(--orange)'; else if (e >= 2) { c = 'var(--red)'; fw = '900'; }
    return '<td style="color:' + c + ';font-weight:' + fw + ';">' + s + '</td>';
  }
  var al = en.scores.slice(0, 9), ret = en.scores.slice(9, 18);
  var pAl = pars.slice(0, 9).reduce(function (a, b) { return a + b; }, 0), pRet = pars.slice(9, 18).reduce(function (a, b) { return a + b; }, 0);
  var tAl = sumNums(al), tRet = sumNums(ret);
  var ecTxt = en.n > 0 ? ((en.ecart >= 0 ? '+' : '') + en.ecart) : '';
  var ecCol = en.ecart <= 0 ? 'var(--green)' : 'var(--red)';

  // Bloc de droite : Match Play (UP/DOWN) ou total classique
  var rightBlock;
  if (isMatch) {
    var mpCol = en._mpVal > 0 ? 'var(--green)' : (en._mpVal < 0 ? 'var(--red)' : 'var(--text)');
    rightBlock = '<div style="font-family:\'Barlow Condensed\',sans-serif;font-weight:900;font-size:24px;color:' + mpCol + ';">' + en.mp + '</div>' +
                 '<div style="font-size:11px;color:var(--muted);">' + (en.n > 0 ? en.total + ' coups' : 'en attente') + '</div>';
  } else {
    rightBlock = '<div style="font-family:\'Barlow Condensed\',sans-serif;font-weight:900;font-size:30px;">' + (en.n > 0 ? en.total : '—') + '</div>' +
                 (en.n > 0 ? '<div style="font-size:12px;color:' + ecCol + ';font-weight:700;">' + ecTxt + ' / par</div>' : '<div style="font-size:11px;color:var(--muted);">en attente</div>');
  }

  var card = document.createElement('div'); card.className = 'card';
  card.style.border = en.me ? '2px solid var(--green)' : 'none';
  if (en.editable) {
    card.style.cursor = 'pointer';
    card.onclick = function () { setActiveEntity(en.key); go('s-game'); };
  }
  card.innerHTML =
    '<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:14px;">' +
      '<div style="display:flex;align-items:center;gap:10px;min-width:0;">' +
        '<div style="font-family:\'Barlow Condensed\',sans-serif;font-weight:900;font-size:18px;min-width:24px;text-align:center;">' + pos + '</div>' +
        avatarHTML(en.p, 34, en.me ? 'var(--green)' : 'var(--bg)', en.me ? '#fff' : 'var(--text)') +
        '<div style="min-width:0;"><div style="font-family:\'Barlow Condensed\',sans-serif;font-weight:800;font-size:16px;text-transform:uppercase;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">' + esc(en.label) + (en.editable ? ' <span style="font-size:10px;color:var(--green);">✎</span>' : '') + '</div>' +
        '<div style="font-size:11px;color:var(--muted);">' + esc(en.sub) + '</div></div>' +
      '</div>' +
      '<div style="text-align:right;flex-shrink:0;">' + rightBlock + '</div>' +
    '</div>' +
    '<div style="overflow-x:auto;-webkit-overflow-scrolling:touch;"><table class="st" style="min-width:100%;">' +
      '<tr><th></th>' + [1, 2, 3, 4, 5, 6, 7, 8, 9].map(function (n) { return '<th>' + n + '</th>'; }).join('') + '<th class="tot">Al.</th></tr>' +
      '<tr><td style="font-size:10px;color:var(--muted);">Par</td>' + pars.slice(0, 9).map(function (p) { return '<td style="font-size:10px;color:var(--muted);">' + p + '</td>'; }).join('') + '<td class="tot" style="font-size:10px;color:var(--muted);">' + pAl + '</td></tr>' +
      '<tr><td></td>' + al.map(function (s, i) { return std(s, pars[i]); }).join('') + '<td class="tot">' + (tAl || '—') + '</td></tr>' +
      '<tr><td colspan="11" style="height:6px;"></td></tr>' +
      '<tr><th></th>' + [10, 11, 12, 13, 14, 15, 16, 17, 18].map(function (n) { return '<th>' + n + '</th>'; }).join('') + '<th class="tot">Ret.</th></tr>' +
      '<tr><td style="font-size:10px;color:var(--muted);">Par</td>' + pars.slice(9, 18).map(function (p) { return '<td style="font-size:10px;color:var(--muted);">' + p + '</td>'; }).join('') + '<td class="tot" style="font-size:10px;color:var(--muted);">' + pRet + '</td></tr>' +
      '<tr><td></td>' + ret.map(function (s, i) { return std(s, pars[9 + i]); }).join('') + '<td class="tot">' + (tRet || '—') + '</td></tr>' +
    '</table></div>';
  return card;
}

/* ── Fin / quitter (avec suppression auto) ─────────────────────────────── */
function endGame() {
  if (!S.game) return; leaveHole();
  txt('fin-sub', (S.game.name || S.game.courseName) + ' · ' + MODES[S.game.mode].label);
  var pars = S.game.coursePars;
  var ents = buildScoreEntities();
  var isMatch = (MODES[S.game.mode] || {}).matchplay;
  var body = document.getElementById('fin-body');
  body.innerHTML = '';
  // Vainqueur en tête
  var top = ents[0];
  if (top && (top.n > 0 || isMatch)) {
    var winTxt = isMatch ? (top._mpVal > 0 ? top.label + ' gagne (' + top.mp + ')' : (top._mpVal === 0 ? 'Match nul' : '')) : top.label;
    var head = document.createElement('div');
    head.className = 'card';
    head.style.cssText = 'text-align:center;background:var(--green);';
    head.innerHTML =
      '<div style="font-size:12px;color:rgba(255,255,255,.85);font-family:\'Barlow Condensed\',sans-serif;font-weight:700;text-transform:uppercase;letter-spacing:.05em;">🏆 ' + (isMatch ? 'Résultat' : 'Vainqueur') + '</div>' +
      '<div style="font-family:\'Barlow Condensed\',sans-serif;font-weight:900;font-size:26px;color:#fff;text-transform:uppercase;margin-top:4px;">' + esc(winTxt || top.label) + '</div>' +
      (isMatch ? '' : '<div style="font-size:14px;color:rgba(255,255,255,.9);font-weight:700;">' + top.total + ' coups · ' + (top.ecart >= 0 ? '+' : '') + top.ecart + ' / par</div>');
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
  var tot = sumNums(myScores);
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
function toast(msg, ok) {
  var el = document.getElementById('toast'); if (!el) return;
  el.textContent = msg; el.className = 'show' + (ok ? ' ok' : '');
  clearTimeout(window._tt); window._tt = setTimeout(function () { el.className = ''; }, 3200);
}
