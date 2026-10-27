'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { makeDb, addUser } = require('./helper');
const { validateMatch, validateNewUser, validateMode, isValidDate } = require('../services/validate');

function setup() {
  const db = makeDb();
  const a = addUser(db, 'Anna');
  const b = addUser(db, 'Ben');
  return { db, a, b };
}

const ok = (a, b, extra = {}) => ({
  datum: '2026-10-01',
  game_mode_id: '1',
  user_id: [String(a), String(b)],
  rounds: ['18', '22'],
  winner: '0',
  ...extra,
});

test('gültiges Spiel wird akzeptiert', () => {
  const { db, a, b } = setup();
  const { errors, data } = validateMatch(ok(a, b), db);
  assert.deepEqual(errors, []);
  assert.equal(data.players.length, 2);
  assert.equal(data.players[0].won, 1);
  assert.equal(data.players[1].won, 0);
});

test('leere Zeilen werden ignoriert, Gewinnerindex bleibt an der Zeile', () => {
  const { db, a, b } = setup();
  const body = ok(a, b, { user_id: [String(a), '', String(b)], rounds: ['18', '', '22'], winner: '2' });
  const { errors, data } = validateMatch(body, db);
  assert.deepEqual(errors, []);
  assert.equal(data.players.find((p) => p.user_id === b).won, 1);
});

test('mindestens zwei Spieler', () => {
  const { db, a } = setup();
  const { errors } = validateMatch(ok(a, ''), db);
  assert.ok(errors.some((e) => /zwei Spieler/.test(e)));
});

test('ein Gewinner ist Pflicht', () => {
  const { db, a, b } = setup();
  const { errors } = validateMatch(ok(a, b, { winner: undefined }), db);
  assert.ok(errors.some((e) => /Gewinner/.test(e)));
});

test('Runden müssen 1 bis 99 sein', () => {
  const { db, a, b } = setup();
  for (const bad of ['0', '100', '-3', 'abc', '', '1.5']) {
    const { errors } = validateMatch(ok(a, b, { rounds: ['18', bad] }), db);
    assert.ok(errors.some((e) => /Runden/.test(e)), `"${bad}" müsste abgelehnt werden`);
  }
});

test('doppelte Spieler werden abgelehnt', () => {
  const { db, a } = setup();
  const { errors } = validateMatch(ok(a, a), db);
  assert.ok(errors.some((e) => /doppelt/.test(e)));
});

test('Datum: ungültig oder in der Zukunft', () => {
  const { db, a, b } = setup();
  assert.ok(validateMatch(ok(a, b, { datum: '2026-02-30' }), db).errors.some((e) => /Datum/.test(e)));
  assert.ok(validateMatch(ok(a, b, { datum: '2999-01-01' }), db).errors.some((e) => /Zukunft/.test(e)));
  assert.equal(isValidDate('2026-10-27'), true);
  assert.equal(isValidDate('27.10.2026'), false);
});

test('unbekannter oder deaktivierter Modus', () => {
  const { db, a, b } = setup();
  assert.ok(validateMatch(ok(a, b, { game_mode_id: '999' }), db).errors.some((e) => /Spielmodus/.test(e)));
  db.prepare('UPDATE game_modes SET aktiv = 0 WHERE id = 1').run();
  assert.ok(validateMatch(ok(a, b), db).errors.some((e) => /deaktiviert/.test(e)));
  // beim Ändern eines alten Spiels bleibt der inaktive Modus erlaubt
  assert.deepEqual(validateMatch(ok(a, b), db, { allowInactiveModeId: 1 }).errors, []);
});

test('Spieler-ID, die es nicht gibt, wird abgelehnt', () => {
  const { db, a } = setup();
  const { errors } = validateMatch(ok(a, '9999'), db);
  assert.ok(errors.some((e) => /ungültig/.test(e)));
});

test('einzelne Werte statt Arrays (ein Feld im Body) brechen nichts', () => {
  const { db, a } = setup();
  const { errors } = validateMatch({ datum: '2026-10-01', game_mode_id: '1', user_id: String(a), rounds: '10', winner: '0' }, db);
  assert.ok(errors.some((e) => /zwei Spieler/.test(e)));
});

test('User-Validierung', () => {
  assert.deepEqual(validateNewUser({ name: 'Anna', password: '1234567890', role: 'player' }).errors, []);
  assert.equal(validateNewUser({ name: 'A', password: '1234567890', role: 'player' }).errors.length, 1);
  assert.equal(validateNewUser({ name: 'Anna', password: 'kurz', role: 'player' }).errors.length, 1);
  assert.equal(validateNewUser({ name: 'Anna', password: '1234567890', role: 'root' }).errors.length, 1);
});

test('Modus-Validierung', () => {
  assert.deepEqual(validateMode({ name: '701', start_score: '701', double_out: '1' }).errors, []);
  assert.equal(validateMode({ name: '701', start_score: '0' }).errors.length, 1);
  assert.equal(validateMode({ name: '', start_score: '301' }).errors.length, 1);
  assert.equal(validateMode({ name: '301', start_score: '301', double_out: '1' }).data.double_out, 1);
});
