const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

function loadApp() {
  function firestore() { return {}; }
  firestore.FieldValue = { serverTimestamp() { return {}; }, delete() { return {}; } };
  const context = {
    console,
    Math,
    Date,
    Promise,
    Array,
    Object,
    String,
    Number,
    RegExp,
    isFinite,
    parseFloat,
    parseInt,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    window: { FIREBASE_CONFIG: {}, COURSES: [], MODES: {} },
    firebase: { initializeApp() {}, firestore },
    document: { readyState: 'loading', addEventListener() {}, getElementById() { return null; }, querySelectorAll() { return []; } },
    localStorage: { getItem() { return null; }, setItem() {}, removeItem() {} }
  };
  vm.createContext(context);
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'app.js'), 'utf8'), context);
  context.S.game = {
    courseHcp: Array.from({ length: 18 }, (_, i) => i + 1),
    coursePars: Array(18).fill(4),
    parTotal: 72,
    teeRatings: null
  };
  return context;
}

test('accepte la notation officielle + et l’ancienne notation négative', () => {
  const app = loadApp();
  assert.equal(app.parseGolfIndex('+2,1'), -2.1);
  assert.equal(app.parseGolfIndex('-2.1'), -2.1);
  assert.equal(app.parseGolfIndex('12,4'), 12.4);
  assert.equal(app.formatGolfIndex(-2.1), '+2.1');
});

test('un handicap plus rend ses coups à partir du Stroke Index 18', () => {
  const app = loadApp();
  const strokes = Array.from(app.strokesArray('+2', { teeColor: 'jaune' }));
  assert.deepEqual(strokes.slice(0, 16), Array(16).fill(0));
  assert.deepEqual(strokes.slice(16), [-1, -1]);
});

test('le score net augmente pour un handicap plus', () => {
  const app = loadApp();
  const scores = Array(18).fill(4);
  const plusStrokes = app.strokesArray('+2', { teeColor: 'jaune' });
  const regularStrokes = app.strokesArray('2', { teeColor: 'jaune' });
  assert.equal(app.unitTotals(scores, app.S.game.coursePars, plusStrokes, 4, true).total, 74);
  assert.equal(app.unitTotals(scores, app.S.game.coursePars, regularStrokes, 4, true).total, 70);
});

test('les tours supplémentaires suivent aussi l’ordre inverse', () => {
  const app = loadApp();
  const strokes = Array.from(app.strokesArray('+20', { teeColor: 'jaune' }));
  assert.deepEqual(strokes.slice(0, 16), Array(16).fill(-1));
  assert.deepEqual(strokes.slice(16), [-2, -2]);
});

test('le nettoyage automatique ne supprime que les parties inactives depuis plus de 6 h', async () => {
  const app = loadApp();
  const deleted = [];
  const nowSeconds = Math.floor(Date.now() / 1000);
  const docs = [
    { id: 'ancienne', data: () => ({ updatedAt: { seconds: nowSeconds - 7 * 3600 } }) },
    { id: 'recente', data: () => ({ updatedAt: { seconds: nowSeconds - 5 * 3600 } }) },
    { id: 'courante', data: () => ({ updatedAt: { seconds: nowSeconds - 8 * 3600 } }) }
  ];
  app.DB = {
    collection() {
      return {
        get() { return Promise.resolve({ forEach(cb) { docs.forEach(cb); } }); },
        doc(id) { return { delete() { deleted.push(id); return Promise.resolve(); } }; }
      };
    }
  };
  app.FB_OK = true;
  app.S.gameId = 'courante';
  assert.equal(await app.purgeInactiveGames(), 1);
  assert.deepEqual(deleted, ['ancienne']);
});
