/* ============================================================================
   TEEBUDDY — MOTEUR DE CALCUL « SYNDICAT »
   Fonctions pures et déterministes. Aucun accès au DOM ni à Firebase.
============================================================================ */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.SYNDICAT = api;
})(typeof window !== 'undefined' ? window : globalThis, function () {
  'use strict';

  function cents(value) {
    var n = Number(value);
    return isFinite(n) ? Math.max(0, Math.round(n)) : 0;
  }

  function playerId(player) {
    return typeof player === 'string' ? player : player && (player.pid || player.id);
  }

  function relativeScore(score, par) {
    if (score === 'X') return 3;
    if (typeof score !== 'number' || !isFinite(score)) return null;
    return Math.max(-2, Math.min(3, Math.round(score - par)));
  }

  function zeroBalances(ids) {
    var result = {};
    ids.forEach(function (id) { result[id] = { paidCents: 0, receivedCents: 0, netCents: 0 }; });
    return result;
  }

  function mergeTransactions(items) {
    var merged = {}, order = [];
    items.forEach(function (item) {
      var key = item.fromPlayerId + '>' + item.toPlayerId;
      if (!merged[key]) {
        merged[key] = {
          fromPlayerId: item.fromPlayerId,
          toPlayerId: item.toPlayerId,
          amountCents: 0,
          details: []
        };
        order.push(key);
      }
      merged[key].amountCents += item.amountCents;
      merged[key].details.push(item.detail);
    });
    return order.map(function (key) { return merged[key]; });
  }

  function calculateHole(input) {
    input = input || {};
    var ids = (input.players || []).map(playerId).filter(Boolean);
    var par = Number(input.par) || 4;
    var baseStakeCents = cents(input.baseStakeCents);
    var carryInCents = cents(input.carryInCents);
    var effectiveStakeCents = baseStakeCents + carryInCents;
    var joker = input.joker && input.joker.playerId ? input.joker : null;
    var finalStakeCents = effectiveStakeCents * (joker ? 2 : 1);
    var rel = {}, complete = ids.length >= 2;
    ids.forEach(function (id) {
      rel[id] = relativeScore((input.scores || {})[id], par);
      if (rel[id] === null) complete = false;
    });

    var result = {
      complete: complete,
      baseStakeCents: baseStakeCents,
      carryInCents: carryInCents,
      effectiveStakeCents: effectiveStakeCents,
      finalStakeCents: finalStakeCents,
      joker: joker,
      relativeScores: rel,
      isFullTie: false,
      generatedCarryCents: 0,
      cancelledCarryCents: 0,
      transactions: [],
      balances: zeroBalances(ids),
      winners: []
    };
    if (!complete) return result;

    var values = ids.map(function (id) { return rel[id]; });
    var best = Math.min.apply(Math, values);
    result.winners = ids.filter(function (id) { return rel[id] === best; });
    result.isFullTie = values.every(function (value) { return value === values[0]; });

    if (result.isFullTie) {
      var generated = finalStakeCents * (values[0] <= -1 ? 2 : 1);
      if (input.isLastHole) result.cancelledCarryCents = generated;
      else result.generatedCarryCents = generated;
      return result;
    }

    var raw = [];
    for (var i = 0; i < ids.length; i++) {
      for (var j = i + 1; j < ids.length; j++) {
        var a = ids[i], b = ids[j];
        if (rel[a] === rel[b]) continue;
        var from = rel[a] > rel[b] ? a : b;
        var to = from === a ? b : a;
        // Le triple bogey règle les vainqueurs via sa pénalité dédiée ci-dessous.
        // Cette pénalité remplace (et ne complète pas) le paiement normal envers eux.
        if (rel[from] >= 3 && result.winners.indexOf(to) >= 0) continue;
        var multiplier = rel[to] <= -1 ? 2 : 1;
        raw.push({
          fromPlayerId: from,
          toPlayerId: to,
          amountCents: finalStakeCents * multiplier,
          detail: {
            type: 'better_score',
            baseAmountCents: finalStakeCents,
            multiplier: multiplier,
            amountCents: finalStakeCents * multiplier,
            reason: multiplier === 2 ? 'birdie_or_better' : 'better_score'
          }
        });
      }
    }

    ids.filter(function (id) { return rel[id] >= 3; }).forEach(function (tripleId) {
      result.winners.forEach(function (winnerId) {
        raw.push({
          fromPlayerId: tripleId,
          toPlayerId: winnerId,
          amountCents: finalStakeCents * 2,
          detail: {
            type: 'triple_bogey_penalty',
            baseAmountCents: finalStakeCents,
            multiplier: 2,
            amountCents: finalStakeCents * 2,
            reason: 'triple_bogey'
          }
        });
      });
    });

    result.transactions = mergeTransactions(raw);
    result.transactions.forEach(function (transaction) {
      result.balances[transaction.fromPlayerId].paidCents += transaction.amountCents;
      result.balances[transaction.toPlayerId].receivedCents += transaction.amountCents;
    });
    var control = 0;
    ids.forEach(function (id) {
      var balance = result.balances[id];
      balance.netCents = balance.receivedCents - balance.paidCents;
      control += balance.netCents;
    });
    if (control !== 0) throw new Error('Syndicat déséquilibré : ' + control + ' centime(s)');
    return result;
  }

  function stakeForHole(defaultStakeCents, schedule, holeIndex) {
    var stake = cents(defaultStakeCents);
    Object.keys(schedule || {}).map(function (key) { return parseInt(key, 10); })
      .filter(function (key) { return isFinite(key) && key <= holeIndex; })
      .sort(function (a, b) { return a - b; })
      .forEach(function (key) { stake = cents(schedule[String(key)]); });
    return stake;
  }

  function simplifyBalances(balances, ids) {
    var debtors = [], creditors = [];
    ids.forEach(function (id) {
      var net = balances[id] ? balances[id].netCents : 0;
      if (net < 0) debtors.push({ id: id, amount: -net });
      if (net > 0) creditors.push({ id: id, amount: net });
    });
    var transfers = [], d = 0, c = 0;
    while (d < debtors.length && c < creditors.length) {
      var amount = Math.min(debtors[d].amount, creditors[c].amount);
      if (amount > 0) transfers.push({ fromPlayerId: debtors[d].id, toPlayerId: creditors[c].id, amountCents: amount });
      debtors[d].amount -= amount; creditors[c].amount -= amount;
      if (debtors[d].amount === 0) d++;
      if (creditors[c].amount === 0) c++;
    }
    return transfers;
  }

  function calculateRound(input) {
    input = input || {};
    var ids = (input.players || []).map(playerId).filter(Boolean);
    var pars = input.pars || [];
    var validated = input.validated || {};
    var holes = [], carry = 0, chainOpen = true;
    var totals = zeroBalances(ids);

    for (var hole = 0; hole < 18; hole++) {
      var scores = {};
      ids.forEach(function (id) { scores[id] = input.scores && input.scores[id] ? input.scores[id][hole] : null; });
      var joker = input.jokers && input.jokers[String(hole)] ? input.jokers[String(hole)] : null;
      var base = stakeForHole(input.baseStakeCents, input.stakeSchedule, hole);
      var result = chainOpen ? calculateHole({
        players: ids,
        scores: scores,
        par: pars[hole],
        baseStakeCents: base,
        carryInCents: carry,
        joker: joker,
        isLastHole: hole === 17
      }) : {
        complete: false,
        unavailableUntilPreviousValidation: true,
        baseStakeCents: base,
        carryInCents: 0,
        effectiveStakeCents: base,
        finalStakeCents: base,
        joker: joker,
        relativeScores: {}, isFullTie: false, generatedCarryCents: 0,
        cancelledCarryCents: 0, transactions: [], balances: zeroBalances(ids), winners: []
      };
      result.holeIndex = hole;
      result.validated = !!validated[String(hole)];
      holes.push(result);

      if (chainOpen && result.validated && result.complete) {
        carry = result.isFullTie ? carry + result.generatedCarryCents : 0;
        ids.forEach(function (id) {
          totals[id].paidCents += result.balances[id].paidCents;
          totals[id].receivedCents += result.balances[id].receivedCents;
          totals[id].netCents += result.balances[id].netCents;
        });
      } else {
        chainOpen = false;
      }
    }

    var totalControl = ids.reduce(function (sum, id) { return sum + totals[id].netCents; }, 0);
    if (totalControl !== 0) throw new Error('Tour Syndicat déséquilibré : ' + totalControl + ' centime(s)');
    return {
      holes: holes,
      balances: totals,
      settlements: simplifyBalances(totals, ids),
      lastValidatedHole: holes.reduce(function (last, hole) { return hole.validated && hole.complete ? hole.holeIndex : last; }, -1)
    };
  }

  return {
    relativeScore: relativeScore,
    calculateHole: calculateHole,
    calculateRound: calculateRound,
    simplifyBalances: simplifyBalances,
    stakeForHole: stakeForHole
  };
});
