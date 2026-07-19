/* ============================================================================
   TEEBUDDY — INTÉGRATION UI / FIRESTORE DU MODE « SYNDICAT »
============================================================================ */

function isSyndicat(game) { return !!((game || S.game) && (game || S.game).mode === 'syndicat'); }

function syndicatBaseStake(game) {
  game = game || S.game || {};
  return Math.max(100, Math.round(((game.syndicatSettings || {}).baseStakeCents || 200) / 100) * 100);
}

function syndicatEuro(amountCents) {
  var euros = Math.round((Number(amountCents) || 0) / 100);
  return euros.toLocaleString('fr-FR') + ' €';
}

function syndicatSignedEuro(amountCents) {
  var amount = Number(amountCents) || 0;
  if (amount === 0) return '0 €';
  return (amount > 0 ? '+' : '−') + syndicatEuro(Math.abs(amount));
}

function syndicatMoneyClass(amountCents) {
  return amountCents > 0 ? 'positive' : (amountCents < 0 ? 'negative' : 'neutral');
}

function syndicatPlayer(pid, game) {
  return ((game || S.game).players || []).find(function (player) { return player.pid === pid; });
}

function syndicatPlayerName(pid, game) {
  var player = syndicatPlayer(pid, game || S.game);
  return player ? player.prenom : '?';
}

function syndicatScoreLabel(relative) {
  if (relative === null || relative === undefined) return '—';
  if (relative <= -2) return 'Eagle ou mieux';
  if (relative === -1) return 'Birdie';
  if (relative === 0) return 'Par';
  if (relative === 1) return 'Bogey';
  if (relative === 2) return 'Double bogey';
  return 'Triple bogey';
}

function syndicatScoresForGame(game, preferLocal) {
  var scores = {};
  (game.players || []).forEach(function (player) {
    scores[player.pid] = preferLocal && typeof getScores === 'function'
      ? getScores(player.pid).slice()
      : ((game.scores && game.scores[player.pid]) || Array(18).fill(null)).slice();
  });
  return scores;
}

function syndicatRound(game, preferLocal) {
  game = game || S.game;
  if (!game || !window.SYNDICAT) return null;
  return SYNDICAT.calculateRound({
    players: game.players || [],
    pars: game.coursePars || Array(18).fill(4),
    scores: syndicatScoresForGame(game, preferLocal !== false),
    baseStakeCents: syndicatBaseStake(game),
    stakeSchedule: game.syndicatStakeSchedule || { 0: syndicatBaseStake(game) },
    jokers: game.syndicatJokers || {},
    validated: game.syndicatValidated || {}
  });
}

function syndicatRemoteHoleHasScore(game, holeIndex) {
  return (game.players || []).some(function (player) {
    var score = game.scores && game.scores[player.pid] && game.scores[player.pid][holeIndex];
    return score !== null && score !== undefined;
  });
}

function syndicatLiveHoleHasScore(holeIndex) {
  return (S.game.players || []).some(function (player) {
    var score = getScores(player.pid)[holeIndex];
    return score !== null && score !== undefined;
  });
}

function syndicatPreviousHolesValidated(game, holeIndex) {
  var validated = game.syndicatValidated || {};
  for (var hole = 0; hole < holeIndex; hole++) if (!validated[String(hole)]) return false;
  return true;
}

function syndicatFirstUnplayedHole(game) {
  var validated = game.syndicatValidated || {};
  for (var hole = 0; hole < 18; hole++) {
    if (!validated[String(hole)] && !syndicatRemoteHoleHasScore(game, hole)) return hole;
  }
  return -1;
}

function syndicatLatestStake(game) {
  var schedule = game.syndicatStakeSchedule || { 0: syndicatBaseStake(game) };
  var keys = Object.keys(schedule).map(Number).filter(isFinite).sort(function (a, b) { return a - b; });
  return keys.length ? schedule[String(keys[keys.length - 1])] : syndicatBaseStake(game);
}

function renderSyndicatConfig(containerId) {
  var box = document.getElementById(containerId); if (!box || !S.game) return;
  if (!isSyndicat()) { box.style.display = 'none'; box.innerHTML = ''; return; }
  var host = S.game.host === S.player.pid;
  var prefix = containerId.indexOf('sl-') === 0 ? 'sl' : 'set';
  var stake = Math.round(syndicatLatestStake(S.game) / 100);
  box.style.display = 'block';
  box.innerHTML =
    '<div class="syndicat-config-card">' +
      '<div class="L">💶 Paramètres Syndicat</div>' +
      '<div class="syndicat-stake-input"><input class="inp" id="' + prefix + '-syndicat-stake" type="number" min="1" step="1" inputmode="numeric" value="' + stake + '"' + (host ? '' : ' disabled') + '><span class="syndicat-euro">€</span></div>' +
      '<div style="font-size:12px;color:var(--muted);line-height:1.45;">Mise entière par trou, sans centimes. Birdie ×2 · Triple bogey pénalité ×2 · 1 joker par joueur.</div>' +
      (host ? '<button class="btn B-green" onclick="saveSyndicatStake(\'' + prefix + '\')" style="margin-top:12px;padding:12px;">Enregistrer la mise</button>' : '') +
      '<button class="syndicat-rule-link" onclick="openSyndicatRules()">Voir les règles</button>' +
    '</div>';
}

function saveSyndicatStake(prefix) {
  if (!FB_OK || !isSyndicat() || S.game.host !== S.player.pid) return;
  var input = document.getElementById(prefix + '-syndicat-stake');
  var euros = input ? Number(input.value) : 0;
  if (!isFinite(euros) || euros <= 0 || Math.floor(euros) !== euros) {
    toast('La mise doit être un nombre entier d’euros supérieur à zéro');
    if (input) input.focus();
    return;
  }
  var amount = euros * 100;
  var schedule = Object.assign({}, S.game.syndicatStakeSchedule || { 0: syndicatBaseStake(S.game) });
  var fromHole = 0;
  if (S.game.status === 'playing') {
    fromHole = syndicatFirstUnplayedHole(S.game);
    if (fromHole < 0) { toast('Tous les trous ont déjà été joués'); return; }
    if (!confirm('La nouvelle mise s’appliquera à partir du prochain trou non joué (trou ' + (fromHole + 1) + '). Les calculs précédents ne seront pas modifiés.')) return;
  }
  schedule[String(fromHole)] = amount;
  DB.collection('games').doc(S.gameId).update({
    syndicatSettings: {
      baseStakeCents: amount,
      maxScoreRelativeToPar: 3,
      birdieMultiplier: 2,
      tripleBogeyPenaltyMultiplier: 2,
      jokerMultiplier: 2,
      jokerPerPlayer: 1,
      grossScoreOnly: true
    },
    syndicatStakeSchedule: schedule,
    updatedAt: firebase.firestore.FieldValue.serverTimestamp()
  }).then(function () { toast('Mise enregistrée : ' + euros + ' € ✓', true); });
}

function openSyndicatRules() { var modal = document.getElementById('syndicat-rules'); if (modal) modal.classList.add('open'); }
function closeSyndicatRules() { var modal = document.getElementById('syndicat-rules'); if (modal) modal.classList.remove('open'); }
function closeSyndicatResult() { var modal = document.getElementById('syndicat-result'); if (modal) modal.classList.remove('open'); }

function syndicatJokerUsedBy(pid, game) {
  return game.syndicatJokerUsed && game.syndicatJokerUsed[pid] !== undefined;
}

function renderSyndicatGamePanel() {
  var box = document.getElementById('g-syndicat'); if (!box) return;
  if (!isSyndicat()) { box.style.display = 'none'; box.innerHTML = ''; return; }
  box.style.display = 'block';
  var round = syndicatRound(S.game, true), result = round && round.holes[S.hole];
  if (!result || result.unavailableUntilPreviousValidation) {
    box.innerHTML = '<div class="hint">🔒 Validez les trous précédents avant de jouer ce trou.</div>';
    return;
  }
  var activePid = activePlayerPid();
  var activeJoker = (S.game.syndicatJokers || {})[String(S.hole)];
  var jokerUsed = activePid ? syndicatJokerUsedBy(activePid, S.game) : true;
  var anyScore = syndicatLiveHoleHasScore(S.hole);
  var editableJoker = !S.spectating && activePid && !result.validated && !activeJoker && !jokerUsed && !anyScore;
  var scoreCount = (S.game.players || []).filter(function (player) {
    var score = getScores(player.pid)[S.hole]; return score !== null && score !== undefined;
  }).length;
  var breakdown = 'Mise de base : ' + syndicatEuro(result.baseStakeCents);
  if (result.carryInCents) breakdown += '<br>Reports cumulés : +' + syndicatEuro(result.carryInCents);
  if (activeJoker) breakdown += '<br>Joker ×2 activé par ' + esc(syndicatPlayerName(activeJoker.playerId));
  var jokerHtml = '';
  if (activeJoker) {
    jokerHtml = '<div class="syndicat-joker">🃏 <strong>JOKER ACTIF</strong><br>Activé par ' + esc(syndicatPlayerName(activeJoker.playerId)) + '.</div>';
  } else {
    var note = jokerUsed ? 'Votre joker a déjà été utilisé.' : (anyScore ? 'Le premier score est saisi : les jokers sont verrouillés.' : '1 utilisation disponible · double tous les montants du trou.');
    jokerHtml = '<button class="syndicat-joker-btn" onclick="activateSyndicatJoker()"' + (editableJoker ? '' : ' disabled') + '>🃏 Utiliser mon joker</button><div style="font-size:10px;color:rgba(255,255,255,.6);margin-top:5px;">' + note + '</div>';
  }
  var validation = '';
  var scoreRecap = '';
  if (result.complete && !result.validated) {
    scoreRecap = '<div class="syndicat-score-recap">' + (S.game.players || []).map(function (player) {
      return '<div><span>' + esc(player.prenom) + '</span><strong>' + syndicatScoreLabel(result.relativeScores[player.pid]) + '</strong></div>';
    }).join('') + '</div>';
  }
  if (result.validated) {
    validation = '<button class="btn B-green syndicat-validate" onclick="openSyndicatResult(' + S.hole + ')" style="padding:11px;">✓ Résultat validé · Voir le détail</button>';
  } else if (S.game.host === S.player.pid && result.complete) {
    validation = '<button class="btn B-green syndicat-validate" onclick="validateSyndicatHole()" style="padding:11px;">Valider et calculer les mises</button>';
  } else {
    validation = '<div style="font-size:11px;color:rgba(255,255,255,.65);margin-top:9px;text-align:center;">' + scoreCount + '/' + (S.game.players || []).length + ' scores · ' + (S.game.host === S.player.pid ? 'complétez les scores pour valider' : 'validation par l’hôte') + '</div>';
  }
  box.innerHTML =
    '<div class="syndicat-stake-card">' +
      '<div class="syndicat-stake-main"><div><div class="L" style="color:rgba(255,255,255,.6);">Mise du trou ' + (S.hole + 1) + '</div><div style="font-size:12px;color:rgba(255,255,255,.72);">Score brut · maximum triple bogey</div></div><div class="syndicat-stake-value">' + syndicatEuro(result.finalStakeCents) + '</div></div>' +
      '<div class="syndicat-breakdown">' + breakdown + '</div>' + jokerHtml + scoreRecap + validation +
    '</div>';
}

function activateSyndicatJoker() {
  if (!FB_OK || !isSyndicat() || S.spectating) return;
  var holeIndex = S.hole, pid = activePlayerPid(); if (!pid) return;
  if (!confirm('Activer votre joker sur ce trou ? Toutes les mises, primes et pénalités seront doublées. Cette action est définitive.')) return;
  var ref = DB.collection('games').doc(S.gameId);
  DB.runTransaction(function (transaction) {
    return transaction.get(ref).then(function (snapshot) {
      if (!snapshot.exists) throw new Error('Partie introuvable');
      var game = snapshot.data();
      if (game.mode !== 'syndicat') throw new Error('Le mode Syndicat n’est plus actif');
      if ((game.syndicatJokers || {})[String(holeIndex)]) throw new Error('Un joker est déjà actif sur ce trou');
      if (syndicatJokerUsedBy(pid, game)) throw new Error('Ce joker a déjà été utilisé');
      if (syndicatRemoteHoleHasScore(game, holeIndex)) throw new Error('Un score a déjà été saisi sur ce trou');
      if (!syndicatPreviousHolesValidated(game, holeIndex)) throw new Error('Les trous précédents doivent être validés');
      var jokers = Object.assign({}, game.syndicatJokers || {});
      var used = Object.assign({}, game.syndicatJokerUsed || {});
      jokers[String(holeIndex)] = { playerId: pid, playerName: syndicatPlayerName(pid, game), at: Date.now(), multiplier: 2 };
      used[pid] = holeIndex + 1;
      transaction.update(ref, { syndicatJokers: jokers, syndicatJokerUsed: used, updatedAt: firebase.firestore.FieldValue.serverTimestamp() });
    });
  }).then(function () { toast('Joker activé par ' + syndicatPlayerName(pid) + ' 🃏', true); })
    .catch(function (error) { toast(error.message || 'Impossible d’activer le joker'); });
}

function validateSyndicatHole() {
  if (!FB_OK || !isSyndicat() || S.game.host !== S.player.pid) return;
  var holeIndex = S.hole, ref = DB.collection('games').doc(S.gameId);
  DB.runTransaction(function (transaction) {
    return transaction.get(ref).then(function (snapshot) {
      if (!snapshot.exists) throw new Error('Partie introuvable');
      var game = snapshot.data();
      if (game.mode !== 'syndicat') throw new Error('Le mode Syndicat n’est plus actif');
      if (!syndicatPreviousHolesValidated(game, holeIndex)) throw new Error('Validez les trous précédents dans l’ordre');
      var complete = (game.players || []).every(function (player) {
        var value = game.scores && game.scores[player.pid] && game.scores[player.pid][holeIndex];
        return value !== null && value !== undefined;
      });
      if (!complete) throw new Error('Tous les joueurs doivent avoir un score');
      var validated = Object.assign({}, game.syndicatValidated || {});
      validated[String(holeIndex)] = { by: S.player.pid, at: Date.now() };
      transaction.update(ref, { syndicatValidated: validated, updatedAt: firebase.firestore.FieldValue.serverTimestamp() });
    });
  }).then(function () {
    if (!S.game.syndicatValidated) S.game.syndicatValidated = {};
    S.game.syndicatValidated[String(holeIndex)] = { by: S.player.pid, at: Date.now() };
    toast('Trou ' + (holeIndex + 1) + ' validé ✓', true);
    openSyndicatResult(holeIndex);
  }).catch(function (error) { toast(error.message || 'Impossible de valider le trou'); });
}

function syndicatDetailLabel(detail) {
  if (detail.type === 'triple_bogey_penalty') return 'pénalité triple bogey ×2';
  if (detail.reason === 'birdie_or_better') return 'meilleur score avec prime birdie ×2';
  return 'meilleur score';
}

function openSyndicatResult(holeIndex) {
  if (!isSyndicat()) return;
  var round = syndicatRound(S.game, true), result = round && round.holes[holeIndex];
  var content = document.getElementById('syndicat-result-content'), modal = document.getElementById('syndicat-result');
  if (!content || !modal || !result || !result.complete) { toast('Résultat encore incomplet'); return; }
  var html = '<div class="L">Résultat du trou ' + (holeIndex + 1) + '</div><div class="D" style="font-size:28px;margin:4px 0 16px;">Mise finale : ' + syndicatEuro(result.finalStakeCents) + '</div>';
  html += '<div class="syndicat-result-stake"><span>Mise de base <strong>' + syndicatEuro(result.baseStakeCents) + '</strong></span>';
  if (result.carryInCents) html += '<span>Reports cumulés <strong>+' + syndicatEuro(result.carryInCents) + '</strong></span>';
  if (result.joker) html += '<span>Joker ×2 <strong>' + esc(syndicatPlayerName(result.joker.playerId)) + '</strong></span>';
  html += '</div>';
  html += '<div class="card" style="box-shadow:none;background:var(--bg);margin-bottom:12px;">';
  (S.game.players || []).forEach(function (player) {
    html += '<div class="syndicat-balance-row"><div><strong>' + esc(player.prenom) + '</strong><div style="font-size:11px;color:var(--muted);">' + syndicatScoreLabel(result.relativeScores[player.pid]) + '</div></div><div class="syndicat-money ' + syndicatMoneyClass(result.balances[player.pid].netCents) + '">' + syndicatSignedEuro(result.balances[player.pid].netCents) + '</div></div>';
  });
  html += '</div>';
  if (result.isFullTie) {
    if (holeIndex === 17) html += '<div class="hint">Égalité générale au dernier trou. Le report de ' + syndicatEuro(result.cancelledCarryCents) + ' est annulé.</div>';
    else {
      var nextBase = SYNDICAT.stakeForHole(syndicatBaseStake(S.game), S.game.syndicatStakeSchedule || {}, holeIndex + 1);
      var nextStake = nextBase + result.carryInCents + result.generatedCarryCents;
      var birdieTie = Object.keys(result.relativeScores).length && Object.keys(result.relativeScores).every(function (pid) { return result.relativeScores[pid] <= -1; });
      html += '<div class="hint"><strong>' + (birdieTie ? 'Égalité générale au birdie ou mieux' : 'Égalité générale') + '</strong><br>Aucun paiement. ' + (birdieTie ? 'Prime birdie appliquée au report. ' : '') + syndicatEuro(result.generatedCarryCents) + ' sont ajoutés aux reports.<br><strong>Mise provisoire du trou ' + (holeIndex + 2) + ' : ' + syndicatEuro(nextStake) + '</strong></div>';
    }
  } else {
    html += '<div class="L" style="margin:16px 0 6px;">Transactions détaillées</div><div class="card" style="box-shadow:none;padding:10px 16px;">';
    result.transactions.forEach(function (tx) {
      html += '<div class="syndicat-tx"><strong>' + esc(syndicatPlayerName(tx.fromPlayerId)) + ' doit ' + syndicatEuro(tx.amountCents) + ' à ' + esc(syndicatPlayerName(tx.toPlayerId)) + '</strong>';
      tx.details.forEach(function (detail) { html += '<div class="syndicat-detail">— ' + syndicatEuro(detail.amountCents) + ' : ' + syndicatDetailLabel(detail) + '</div>'; });
      html += '</div>';
    });
    html += '</div>';
  }
  html += '<div style="font-size:11px;color:var(--green);text-align:center;margin-top:12px;">✓ Total équilibré : 0 €</div>';
  content.innerHTML = html; modal.classList.add('open');
}

function renderSyndicatDashboard(box) {
  var round = syndicatRound(S.game, true); if (!round) return;
  var players = (S.game.players || []).slice().sort(function (a, b) { return round.balances[b.pid].netCents - round.balances[a.pid].netCents; });
  var standings = document.createElement('div'); standings.className = 'card';
  var html = '<div class="L">Classement Syndicat</div><div class="D" style="font-size:24px;margin:4px 0 10px;">Soldes cumulés</div>';
  players.forEach(function (player, index) {
    var balance = round.balances[player.pid];
    html += '<div class="syndicat-balance-row"><div><strong>' + (index + 1) + '. ' + esc(player.prenom) + '</strong><div style="font-size:10px;color:var(--muted);">Reçu ' + syndicatEuro(balance.receivedCents) + ' · Payé ' + syndicatEuro(balance.paidCents) + '</div></div><div class="syndicat-money ' + syndicatMoneyClass(balance.netCents) + '">' + syndicatSignedEuro(balance.netCents) + '</div></div>';
  });
  standings.innerHTML = html; box.appendChild(standings);

  var title = document.createElement('div'); title.className = 'L'; title.style.margin = '4px 2px 0'; title.textContent = 'Historique des trous'; box.appendChild(title);
  var any = false;
  round.holes.forEach(function (result) {
    if (!result.validated || !result.complete) return;
    any = true;
    var card = document.createElement('div'); card.className = 'card syndicat-hole-card';
    var summary = result.isFullTie ? 'Égalité · report ' + syndicatEuro(result.generatedCarryCents || result.cancelledCarryCents) : (S.game.players || []).map(function (player) { return esc(player.prenom) + ' ' + syndicatSignedEuro(result.balances[player.pid].netCents); }).join(' · ');
    card.innerHTML = '<div style="display:flex;justify-content:space-between;gap:12px;"><div><div class="D" style="font-size:18px;">Trou ' + (result.holeIndex + 1) + '</div><div style="font-size:11px;color:var(--muted);margin-top:3px;line-height:1.4;">' + summary + '</div></div><div style="font-family:\'Barlow Condensed\',sans-serif;font-weight:900;color:var(--gold);white-space:nowrap;">' + syndicatEuro(result.finalStakeCents) + '</div></div>';
    card.onclick = function () { openSyndicatResult(result.holeIndex); };
    box.appendChild(card);
  });
  if (!any) {
    var empty = document.createElement('div'); empty.className = 'hint'; empty.textContent = 'Aucun trou validé pour le moment.'; box.appendChild(empty);
  }
}

function renderSyndicatFinal(body) {
  var round = syndicatRound(S.game, true); if (!round) return;
  var players = (S.game.players || []).slice().sort(function (a, b) { return round.balances[b.pid].netCents - round.balances[a.pid].netCents; });
  var card = document.createElement('div'); card.className = 'card';
  var html = '<div class="L">Bilan du Syndicat</div><div class="D" style="font-size:25px;margin:4px 0 10px;">Soldes finaux</div>';
  players.forEach(function (player) {
    var amount = round.balances[player.pid].netCents;
    html += '<div class="syndicat-balance-row"><strong>' + esc(player.prenom) + '</strong><div class="syndicat-money ' + syndicatMoneyClass(amount) + '">' + syndicatSignedEuro(amount) + '</div></div>';
  });
  card.innerHTML = html; body.appendChild(card);
  var payment = document.createElement('div'); payment.className = 'card';
  var payHtml = '<div class="L">Règlement final recommandé</div><div class="D" style="font-size:21px;margin:4px 0 10px;">Paiements simplifiés</div>';
  if (!round.settlements.length) payHtml += '<div class="hint">Tous les joueurs sont à l’équilibre.</div>';
  round.settlements.forEach(function (settlement) {
    payHtml += '<div class="syndicat-balance-row"><span><strong>' + esc(syndicatPlayerName(settlement.fromPlayerId)) + '</strong> paie <strong>' + esc(syndicatPlayerName(settlement.toPlayerId)) + '</strong></span><strong>' + syndicatEuro(settlement.amountCents) + '</strong></div>';
  });
  payment.innerHTML = payHtml; body.appendChild(payment);
  var validatedCount = round.holes.filter(function (hole) { return hole.validated && hole.complete; }).length;
  if (validatedCount < 18) {
    var warning = document.createElement('div'); warning.className = 'hint'; warning.textContent = 'Bilan provisoire : ' + validatedCount + '/18 trous validés.'; body.appendChild(warning);
  }
}

function prepareSyndicatScoreEdit() {
  if (!isSyndicat()) return true;
  if (!syndicatPreviousHolesValidated(S.game, S.hole)) { toast('Validez les trous précédents avant de scorer celui-ci'); return false; }
  var validated = !!((S.game.syndicatValidated || {})[String(S.hole)]);
  if (!validated) return true;
  var pid = activePlayerPid(), key = S.hole + ':' + pid;
  if (!S.syndicatEditConfirmed) S.syndicatEditConfirmed = {};
  if (S.syndicatEditConfirmed[key]) return true;
  if (!confirm('Modifier ce score recalculera les mises et les soldes de toute la partie à partir de ce trou. Continuer ?')) return false;
  S.syndicatEditConfirmed[key] = true;
  return true;
}
