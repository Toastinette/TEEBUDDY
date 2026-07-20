const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const S = require('../syndicat.js');

function hole(scores, options = {}) {
  const ids = Object.keys(scores);
  return S.calculateHole({
    players: ids,
    scores,
    par: options.par || 4,
    baseStakeCents: options.stake || 200,
    carryInCents: options.carry || 0,
    joker: options.joker || null,
    isLastHole: !!options.last
  });
}

function transactions(result) {
  return Object.fromEntries(result.transactions.map(t => [`${t.fromPlayerId}>${t.toPlayerId}`, t.amountCents]));
}

test('paiements par paire avec joueurs à égalité', () => {
  const result = hole({ A: 5, B: 4, C: 4 });
  assert.deepEqual(transactions(result), { 'A>B': 200, 'A>C': 200 });
  assert.deepEqual(result.balances, {
    A: { paidCents: 400, receivedCents: 0, netCents: -400 },
    B: { paidCents: 0, receivedCents: 200, netCents: 200 },
    C: { paidCents: 0, receivedCents: 200, netCents: 200 }
  });
});

test('chaque niveau de score paie tous les niveaux meilleurs', () => {
  const result = hole({ A: 6, B: 5, C: 4 });
  assert.deepEqual(transactions(result), { 'A>B': 200, 'A>C': 200, 'B>C': 200 });
});

test('birdie ou mieux double uniquement les paiements reçus par ce joueur', () => {
  const result = hole({ A: 5, B: 4, C: 3 });
  assert.deepEqual(transactions(result), { 'A>B': 200, 'A>C': 400, 'B>C': 400 });
});

test('la pénalité triple bogey remplace le paiement normal à chaque vainqueur', () => {
  const result = hole({ A: 7, B: 4, C: 4 });
  assert.deepEqual(transactions(result), { 'A>B': 400, 'A>C': 400 });
  assert.equal(result.balances.A.netCents, -800);
});

test('la pénalité remplace aussi le paiement normal lorsque le vainqueur fait birdie', () => {
  const result = hole({ A: 7, B: 4, C: 3 });
  assert.deepEqual(transactions(result), { 'A>B': 200, 'B>C': 400, 'A>C': 400 });
  assert.equal(result.balances.A.netCents, -600);
  assert.equal(result.balances.B.netCents, -200);
  assert.equal(result.balances.C.netCents, 800);
});

test('une égalité générale reporte la mise et une égalité au birdie la double', () => {
  const parTie = hole({ A: 4, B: 4, C: 4 });
  const birdieTie = hole({ A: 3, B: 3, C: 3 }, { stake: 400 });
  assert.equal(parTie.generatedCarryCents, 200);
  assert.equal(birdieTie.generatedCarryCents, 800);
  assert.deepEqual(parTie.transactions, []);
});

test('les reports consécutifs sont cumulatifs puis consommés', () => {
  const scores = { A: Array(18).fill(null), B: Array(18).fill(null) };
  scores.A[0] = scores.B[0] = 4;
  scores.A[1] = scores.B[1] = 4;
  scores.A[2] = 4; scores.B[2] = 5;
  const round = S.calculateRound({
    players: ['A', 'B'], pars: Array(18).fill(4), scores,
    baseStakeCents: 200, stakeSchedule: { 0: 200 },
    validated: { 0: true, 1: true, 2: true }, jokers: {}
  });
  assert.equal(round.holes[0].finalStakeCents, 200);
  assert.equal(round.holes[1].finalStakeCents, 400);
  assert.equal(round.holes[2].finalStakeCents, 800);
  assert.equal(round.holes[2].generatedCarryCents, 0);
  assert.equal(round.balances.A.netCents, 800);
});

test('le joker double mise, primes, pénalités et report', () => {
  const result = hole({ A: 7, B: 3 }, { stake: 200, carry: 400, joker: { playerId: 'B' } });
  assert.equal(result.finalStakeCents, 1200);
  assert.equal(transactions(result)['A>B'], 2400);
  const tie = hole({ A: 4, B: 4 }, { stake: 200, carry: 200, joker: { playerId: 'A' } });
  assert.equal(tie.generatedCarryCents, 800);
});

test('le report du trou 18 est annulé', () => {
  const result = hole({ A: 4, B: 4 }, { stake: 200, last: true });
  assert.equal(result.generatedCarryCents, 0);
  assert.equal(result.cancelledCarryCents, 200);
});

test('croix et scores au-delà du triple bogey sont plafonnés', () => {
  assert.equal(S.relativeScore('X', 4), 3);
  assert.equal(S.relativeScore(12, 4), 3);
  assert.equal(S.relativeScore(1, 4), -2);
});

test('une nouvelle mise entière s’applique à partir du trou choisi', () => {
  assert.equal(S.stakeForHole(100, { 0: 100, 5: 200 }, 4), 100);
  assert.equal(S.stakeForHole(100, { 0: 100, 5: 200 }, 5), 200);
  assert.equal(S.stakeForHole(100, { 0: 100, 5: 200 }, 17), 200);
});

test('la correction d’un ancien score recalcule les reports suivants', () => {
  const scores = { A: Array(18).fill(null), B: Array(18).fill(null) };
  scores.A[0] = scores.B[0] = 4;
  scores.A[1] = 4; scores.B[1] = 5;
  const input = {
    players: ['A', 'B'], pars: Array(18).fill(4), scores,
    baseStakeCents: 200, stakeSchedule: { 0: 200 },
    validated: { 0: true, 1: true }, jokers: {}
  };
  assert.equal(S.calculateRound(input).holes[1].finalStakeCents, 400);
  scores.B[0] = 5;
  const corrected = S.calculateRound(input);
  assert.equal(corrected.holes[1].finalStakeCents, 200);
  assert.equal(corrected.balances.A.netCents, 400);
});

test('un trou validé hors séquence reste exclu du bilan', () => {
  const scores = { A: Array(18).fill(null), B: Array(18).fill(null) };
  scores.A[1] = 4; scores.B[1] = 5;
  const round = S.calculateRound({
    players: ['A', 'B'], pars: Array(18).fill(4), scores,
    baseStakeCents: 100, stakeSchedule: { 0: 100 },
    validated: { 1: true }, jokers: {}
  });
  assert.equal(round.lastValidatedHole, -1);
  assert.equal(round.balances.A.netCents, 0);
  assert.equal(round.holes[1].unavailableUntilPreviousValidation, true);
});

test('les règlements finaux compensent les dettes', () => {
  const settlements = S.simplifyBalances({
    A: { netCents: -800 }, B: { netCents: -1600 }, C: { netCents: 2400 }
  }, ['A', 'B', 'C']);
  assert.deepEqual(settlements, [
    { fromPlayerId: 'A', toPlayerId: 'C', amountCents: 800 },
    { fromPlayerId: 'B', toPlayerId: 'C', amountCents: 1600 }
  ]);
});

test('invariant : la somme des soldes reste toujours égale à zéro', () => {
  for (let count = 2; count <= 7; count++) {
    for (let scenario = 0; scenario < 80; scenario++) {
      const scores = {};
      for (let p = 0; p < count; p++) scores[`P${p}`] = 2 + ((scenario * 7 + p * 3) % 6);
      const result = hole(scores, {
        stake: ((scenario % 5) + 1) * 100,
        carry: (scenario % 3) * 100,
        joker: scenario % 4 === 0 ? { playerId: 'P0' } : null
      });
      const total = Object.values(result.balances).reduce((sum, balance) => sum + balance.netCents, 0);
      assert.equal(total, 0);
    }
  }
});

test('le mode Syndicat est raccordé à l’interface avec une mise entière', () => {
  const root = path.join(__dirname, '..');
  const config = fs.readFileSync(path.join(root, 'config.js'), 'utf8');
  const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
  const app = fs.readFileSync(path.join(root, 'app.js'), 'utf8');
  const ui = fs.readFileSync(path.join(root, 'syndicat-ui.js'), 'utf8');
  assert.match(config, /syndicat:\s*\{[^\n]+label:\s*'Syndicat'/);
  assert.match(html, /id="sl-syndicat-config"/);
  assert.match(html, /id="g-syndicat-confirm"[^>]+confirmSyndicatScore/);
  assert.match(html, /id="g-prev"/);
  assert.match(html, /id="g-next"/);
  assert.match(html, /src="syndicat\.js"[\s\S]+src="syndicat-ui\.js"[\s\S]+src="app\.js"/);
  assert.match(ui, /type="number" min="1" step="1" inputmode="numeric"/);
  assert.match(app, /baseStakeCents:\s*200/);
  assert.match(app, /renderSyndicatGamePanel\(\)/);
  assert.match(app, /renderSyndicatFinal\(body\)/);
  assert.match(app, /syndicatNewlyValidatedHole/);
  assert.match(app, /openSyndicatResult\(newlyValidatedSyndicatHole\)/);
});

test('la dernière confirmation individuelle valide automatiquement le trou', async () => {
  const game = {
    mode: 'syndicat', host: 'A', coursePars: Array(18).fill(4),
    players: [{ pid: 'A', prenom: 'Alice' }, { pid: 'B', prenom: 'Bruno' }],
    scores: { A: [4].concat(Array(17).fill(null)), B: [5].concat(Array(17).fill(null)) },
    syndicatSettings: { baseStakeCents: 200 }, syndicatStakeSchedule: { 0: 200 },
    syndicatJokers: {}, syndicatValidated: {},
    syndicatScoreConfirmations: { 0: { B: { score: 5, at: 1 } } }
  };
  let written;
  const context = {
    console, window: { SYNDICAT: S }, SYNDICAT: S, FB_OK: true,
    S: { game, gameId: 'TEST', hole: 0, player: { pid: 'A' }, spectating: false, syndicatConfirmPending: false },
    DB: {
      collection: () => ({ doc: () => ({}) }),
      runTransaction: callback => callback({
        get: () => Promise.resolve({ exists: true, data: () => game }),
        update: (_ref, data) => { written = data; }
      })
    },
    firebase: { firestore: { FieldValue: { serverTimestamp: () => 'SERVER_TIME' } } },
    document: { getElementById: () => null },
    getScores: pid => game.scores[pid], activePlayerPid: () => 'A',
    toast: () => {}, confirm: () => true, esc: value => String(value)
  };
  vm.createContext(context);
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'syndicat-ui.js'), 'utf8'), context);
  context.confirmSyndicatScore();
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(written.syndicatScoreConfirmations['0'].A.score, 4);
  assert.equal(written.syndicatValidated['0'].by, 'all_players');
  assert.equal(written['scores.A'][0], 4);
  assert.equal(context.syndicatNewlyValidatedHole(
    { mode: 'syndicat', syndicatValidated: {} },
    { mode: 'syndicat', syndicatValidated: { 0: { by: 'all_players' } } }
  ), 0);
});
