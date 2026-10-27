'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { makeDb, makeApp, addUser, loginAs, post, addMatch } = require('./helper');
const { validateMatch, parseTurns, isValidFinish } = require('../services/validate');
const { getUserStats, getLeaders } = require('../services/stats');
const { getRanking } = require('../services/ranking');

// Modus 1 = 501 Double Out, 2 = 301 Double In/Out, 3 = 501 Straight Out (Seed)
const WIN = [180, 140, 100, 41, 40]; // 501, Finish 40 (D20)
const LOSE = [60, 60, 60, 45, 45]; // 270

function setup() {
  const db = makeDb();
  const a = addUser(db, 'Anna');
  const b = addUser(db, 'Ben');
  return { db, a, b };
}

const body = (a, b, ta, tb, extra = {}) => ({
  datum: '2026-10-01',
  game_mode_id: '1',
  user_id: [String(a), String(b)],
  rounds: ['', ''],
  turns: [ta, tb],
  winner: '0',
  ...extra,
});

// ---- Parsen und Finish ----------------------------------------------------------

test('parseTurns: Trenner, Grenzen, unmögliche Aufnahmen', () => {
  assert.deepEqual(parseTurns('60 100,140;180').list, [60, 100, 140, 180]);
  assert.deepEqual(parseTurns('  0  26 ').list, [0, 26]);
  for (const bad of ['181', '179', '178', '176', '175', '173', '172', '169', '166', '163', 'abc', '-5', '12.5', '1000']) {
    assert.ok(parseTurns(bad).error, `"${bad}" müsste abgelehnt werden`);
  }
  assert.ok(parseTurns('   ').error);
  assert.ok(parseTurns(Array(100).fill('1').join(' ')).error);
});

test('isValidFinish: Double Out und Straight Out', () => {
  for (const ok of [2, 40, 50, 100, 164, 167, 170]) assert.equal(isValidFinish(ok, 1), true, `${ok}`);
  for (const bad of [0, 1, 159, 162, 163, 165, 166, 168, 169, 171, 180]) assert.equal(isValidFinish(bad, 1), false, `${bad}`);
  assert.equal(isValidFinish(162, 0), true);
  assert.equal(isValidFinish(180, 0), true);
  assert.equal(isValidFinish(0, 0), false);
});

// ---- Validierung im Spiel ---------------------------------------------------------

test('Aufnahmen: gültig, Runden werden aus der Anzahl abgeleitet', () => {
  const { db, a, b } = setup();
  const { errors, data } = validateMatch(body(a, b, WIN.join(' '), LOSE.join(' ')), db);
  assert.deepEqual(errors, []);
  assert.equal(data.players[0].rounds, 5);
  assert.deepEqual(data.players[0].turns, WIN);
  assert.equal(data.players[1].won, 0);
});

test('Aufnahmen sind optional und dürfen gemischt sein', () => {
  const { db, a, b } = setup();
  const mixed = body(a, b, WIN.join(' '), '', { rounds: ['', '9'] });
  const { errors, data } = validateMatch(mixed, db);
  assert.deepEqual(errors, []);
  assert.equal(data.players[1].turns, null);
  assert.equal(data.players[1].rounds, 9);
});

test('Runden und Aufnahmen müssen zusammenpassen', () => {
  const { db, a, b } = setup();
  const { errors } = validateMatch(body(a, b, WIN.join(' '), '', { rounds: ['6', '7'] }), db);
  assert.ok(errors.some((e) => /5 Aufnahmen, aber 6 Runden/.test(e)));
});

test('Sieger muss genau den Startscore erreichen', () => {
  const { db, a, b } = setup();
  const short = validateMatch(body(a, b, '180 140 100 41', LOSE.join(' ')), db); // 461
  assert.ok(short.errors.some((e) => /genau 501 Punkte.*461/.test(e)));

  const over = validateMatch(body(a, b, '180 180 180 100', LOSE.join(' ')), db); // 640
  assert.ok(over.errors.some((e) => /mehr als 501/.test(e)));
});

test('Finish: bei Double Out nur gültige Doppel, bei Straight Out jeder Wurf', () => {
  const { db, a, b } = setup();
  const bogey = '180 159 162'; // 501, aber 162 ist kein Double-Out-Finish
  const d = validateMatch(body(a, b, bogey, LOSE.join(' ')), db);
  assert.ok(d.errors.some((e) => /kein gültiges Finish/.test(e)));

  const s = validateMatch(body(a, b, bogey, LOSE.join(' '), { game_mode_id: '3' }), db);
  assert.deepEqual(s.errors, []);
});

test('Verlierer darf den Startscore nicht erreichen', () => {
  const { db, a, b } = setup();
  const { errors } = validateMatch(body(a, b, WIN.join(' '), WIN.join(' ')), db);
  assert.ok(errors.some((e) => /nicht als Sieger gewählt/.test(e)));
});

test('unmögliche Aufnahme wird in der Zeile gemeldet', () => {
  const { db, a, b } = setup();
  const { errors } = validateMatch(body(a, b, '179 100', ''), db);
  assert.ok(errors.some((e) => /Zeile 1: 179 ist mit drei Darts nicht möglich/.test(e)));
});

// ---- Statistik ---------------------------------------------------------------------------

function seedStats() {
  const { db, a, b } = setup();
  // Spiel 1 (Modus 1): Anna gewinnt in 5 Runden mit Finish 40
  addMatch(db, { by: a, players: [[a, 5, true, WIN], [b, 5, false, LOSE]] });
  // Spiel 2 (Modus 1): Ben gewinnt in 3 Runden, Finish 170, eine 180
  addMatch(db, { by: a, players: [[a, 3, false, [100, 100, 100]], [b, 3, true, [180, 151, 170]]] });
  // Spiel 3 (Modus 2): ohne Aufnahmen
  addMatch(db, { modeId: 2, by: a, players: [[a, 9, true], [b, 10, false]] });
  return { db, a, b };
}

test('Kennzahlen: Average, 180er, Finish, bestes Leg', () => {
  const { db, a, b } = seedStats();

  const sa = getUserStats(db, a);
  assert.equal(sa.games, 3);
  assert.equal(sa.wins, 2);
  assert.equal(sa.visits, 8); // 5 + 3
  assert.equal(sa.avg, (501 + 300) / 8);
  assert.equal(sa.n180, 1);
  assert.equal(sa.best_finish, 40);
  assert.equal(sa.best_leg, 5);
  assert.equal(sa.legs_with_turns, 2);

  const sb = getUserStats(db, b);
  assert.equal(sb.n180, 1);
  assert.equal(sb.best_finish, 170);
  assert.equal(sb.best_leg, 3);
  assert.equal(sb.avg, (270 + 501) / 8);
});

test('Kennzahlen nach Modus gefiltert', () => {
  const { db, a } = seedStats();
  const m2 = getUserStats(db, a, 2);
  assert.equal(m2.games, 1);
  assert.equal(m2.visits, 0);
  assert.equal(m2.avg, null);
  assert.equal(m2.best_finish, null);
  assert.equal(m2.best_leg, 9);
});

test('Leaders: nach Average sortiert, nur Spiele mit Aufnahmen', () => {
  const { db, a, b } = seedStats();
  const l = getLeaders(db);
  // Anna: (501 + 300) / 8 = 100.1, Ben: (270 + 501) / 8 = 96.4
  assert.deepEqual(l.map((x) => x.name), ['Anna', 'Ben']);
  assert.equal(l[0].avg, (501 + 300) / 8);
  assert.equal(l[0].legs, 2);
  void a; void b;
  assert.deepEqual(getLeaders(db, 2), []); // Modus 2 hat keine Aufnahmen
});

test('Rangliste zeigt Average und 180er, Reihenfolge bleibt', () => {
  const { db, a, b } = setup();
  for (let i = 0; i < 5; i++) {
    addMatch(db, { by: a, players: [[a, 5, true, WIN], [b, 5, false, LOSE]] });
  }
  const r = getRanking(db, 1);
  assert.equal(r.hasTurns, true);
  assert.equal(r.ranked[0].name, 'Anna');
  assert.equal(r.ranked[0].avg, 100.2);
  assert.equal(r.ranked[0].n180, 5);
  assert.equal(r.ranked[1].avg, 54);
  assert.equal(r.ranked[1].n180, 0);
});

test('Rangliste ohne Aufnahmen: hasTurns ist false', () => {
  const { db, a, b } = setup();
  for (let i = 0; i < 5; i++) addMatch(db, { by: a, players: [[a, 20, true], [b, 22, false]] });
  const r = getRanking(db, 1);
  assert.equal(r.hasTurns, false);
  assert.equal(r.ranked[0].avg, null);
});

// ---- Ende zu Ende ----------------------------------------------------------------------------

test('Spiel mit Aufnahmen erfassen, in Statistik, Verlauf, Edit und CSV sehen', async () => {
  const db = makeDb();
  addUser(db, 'Admin', 'admin');
  const anna = addUser(db, 'Anna');
  const ben = addUser(db, 'Ben');
  const app = makeApp(db);
  const agent = await loginAs(app, 'Anna');

  const enc = encodeURIComponent;
  const res = await post(
    agent,
    '/matches',
    `datum=2026-10-20&game_mode_id=1&user_id=${anna}&rounds=&turns=${enc(WIN.join(' '))}` +
      `&user_id=${ben}&rounds=&turns=${enc(LOSE.join(' '))}&winner=0`
  );
  assert.equal(res.status, 302, res.text);

  const mp = db.prepare('SELECT COUNT(*) AS n FROM turns').get().n;
  assert.equal(mp, 10);

  const list = await agent.get('/matches');
  assert.match(list.text, /Ø 100\.2/);
  assert.match(list.text, /1×180/);

  const stats = await agent.get('/stats');
  assert.equal(stats.status, 200);
  assert.match(stats.text, /100\.2/);
  assert.match(stats.text, />40</); // höchstes Finish

  const home = await agent.get('/');
  assert.match(home.text, /Höchstes Finish/);

  const id = db.prepare('SELECT id FROM matches').get().id;
  const edit = await agent.get(`/matches/${id}/edit`);
  assert.match(edit.text, /value="180 140 100 41 40"/);

  // Korrektur mit neuen Aufnahmen ersetzt die alten (kein Rest in turns)
  const upd = await post(
    agent,
    `/matches/${id}`,
    `datum=2026-10-20&game_mode_id=1&user_id=${anna}&rounds=&turns=${enc('180 180 100 1')}` +
      `&user_id=${ben}&rounds=&turns=${enc('26 26')}&winner=1`
  );
  assert.equal(upd.status, 422); // Winner Ben hat nur 52 Punkte
  assert.match(upd.text, /genau 501 Punkte/);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM turns').get().n, 10); // unverändert

  const ok = await post(
    agent,
    `/matches/${id}`,
    `datum=2026-10-20&game_mode_id=1&user_id=${anna}&rounds=&turns=${enc('26 26')}` +
      `&user_id=${ben}&rounds=&turns=${enc('100 100 100 100 101')}&winner=1`
  );
  // Ben: 501 mit Finish 101 -> gültig; Anna 52 Punkte
  assert.equal(ok.status, 302, ok.text);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM turns').get().n, 7);

  const adm = await loginAs(app, 'Admin');
  const csv = await adm.get('/admin/export.csv');
  assert.match(csv.text, /gewonnen,aufnahmen/);
  assert.match(csv.text, /Ben,5,1,100 100 100 100 101/);
  assert.match(csv.text, /Anna,2,0,26 26/);

  // Löschen entfernt die Aufnahmen mit
  await post(adm, `/matches/${id}/delete`);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM turns').get().n, 0);
});

test('Statistik-Seite ohne Daten und mit Modusfilter lädt', async () => {
  const db = makeDb();
  addUser(db, 'Anna');
  const app = makeApp(db);
  const agent = await loginAs(app, 'Anna');
  const all = await agent.get('/stats');
  assert.equal(all.status, 200);
  assert.match(all.text, /Noch keine Aufnahmen erfasst/);
  const one = await agent.get('/stats?mode=2');
  assert.equal(one.status, 200);
  assert.match(one.text, /301 Double In\/Out/);
  assert.equal((await agent.get('/stats?mode=abc')).status, 200);
});

// ---- 180er ohne Aufnahmen --------------------------------------------------------------

test('180er direkt eintragen: gespeichert, ohne Aufnahmen', () => {
  const { db, a, b } = setup();
  const { errors, data } = validateMatch(
    { datum: '2026-10-01', game_mode_id: '1', user_id: [String(a), String(b)], rounds: ['10', '12'], n180: ['2', ''], winner: '0' },
    db
  );
  assert.deepEqual(errors, []);
  assert.deepEqual(data.players.map((p) => p.n180), [2, 0]);
});

test('180er: aus Aufnahmen berechnet, Widerspruch und Unsinn werden abgelehnt', () => {
  const { db, a, b } = setup();
  const ok = validateMatch(body(a, b, WIN.join(' '), LOSE.join(' ')), db);
  assert.equal(ok.data.players[0].n180, 1);
  const clash = validateMatch(body(a, b, WIN.join(' '), LOSE.join(' '), { n180: ['3', ''] }), db);
  assert.ok(clash.errors.some((e) => /Zeile 1: 1× 180 in den Aufnahmen, aber 3/.test(e)));
  const bad = validateMatch(body(a, b, '', '', { rounds: ['5', '5'], n180: ['x', ''] }), db);
  assert.ok(bad.errors.some((e) => /Zeile 1: 180er müssen/.test(e)));
  const many = validateMatch(body(a, b, '', '', { rounds: ['3', '5'], n180: ['4', ''] }), db);
  assert.ok(many.errors.some((e) => /Mehr 180er \(4\) als Runden \(3\)/.test(e)));
});

test('180er ohne Aufnahmen zählen in Statistik, Leaders und Rangliste', () => {
  const { db, a, b } = setup();
  addMatch(db, { by: a, players: [[a, 10, true, null, 3], [b, 12, false, null, 1]] });
  assert.equal(getUserStats(db, a).n180, 3);
  assert.equal(getUserStats(db, a).avg, null);
  const leaders = getLeaders(db);
  assert.deepEqual(leaders.map((l) => [l.name, l.n180]), [['Anna', 3], ['Ben', 1]]);
  const r = getRanking(db, 1, 1);
  assert.equal(r.hasTurns, true);
  assert.equal(r.ranked.find((x) => x.user_id === a).n180, 3);
});
