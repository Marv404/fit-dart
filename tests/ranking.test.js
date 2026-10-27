'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { makeDb, addUser, addMatch } = require('./helper');
const { getRanking, getUserStats } = require('../services/ranking');

/** Erzeugt n Spiele zwischen a und b; a gewinnt `aWins` davon mit `aRounds` Runden. */
function play(db, a, b, n, aWins, aRounds = 20, bRounds = 22, modeId = 1) {
  for (let i = 0; i < n; i++) {
    const aWon = i < aWins;
    addMatch(db, {
      modeId,
      by: a,
      players: [
        [a, aRounds, aWon],
        [b, bRounds, !aWon],
      ],
    });
  }
}

test('Siegquote bestimmt die Reihenfolge', () => {
  const db = makeDb();
  const anna = addUser(db, 'Anna');
  const ben = addUser(db, 'Ben');
  play(db, anna, ben, 10, 7); // Anna 7/10, Ben 3/10

  const { ranked } = getRanking(db, 1);
  assert.deepEqual(ranked.map((r) => r.name), ['Anna', 'Ben']);
  assert.equal(ranked[0].rank, 1);
  assert.equal(ranked[0].quote, 0.7);
  assert.equal(ranked[1].rank, 2);
});

test('Wer weniger als 5 Spiele hat, steht unter "unranked"', () => {
  const db = makeDb();
  const anna = addUser(db, 'Anna');
  const ben = addUser(db, 'Ben');
  const cara = addUser(db, 'Cara');
  play(db, anna, ben, 6, 4);
  play(db, anna, cara, 2, 2); // Cara hat nur 2 Spiele

  const { ranked, unranked } = getRanking(db, 1, 5);
  assert.deepEqual(ranked.map((r) => r.name).sort(), ['Anna', 'Ben']);
  assert.deepEqual(unranked.map((r) => r.name), ['Cara']);
});

test('Tiebreak: tieferer Rundendurchschnitt in gewonnenen Spielen', () => {
  const db = makeDb();
  const anna = addUser(db, 'Anna');
  const ben = addUser(db, 'Ben');
  const cara = addUser(db, 'Cara');
  // Anna und Ben je 3 Siege aus 6 Spielen gegen Cara, Ben gewinnt schneller
  play(db, anna, cara, 6, 3, 25, 30);
  play(db, ben, cara, 6, 3, 18, 30);

  const { ranked } = getRanking(db, 1);
  const names = ranked.map((r) => r.name);
  assert.ok(names.indexOf('Ben') < names.indexOf('Anna'));
  const anne = ranked.find((r) => r.name === 'Anna');
  const bens = ranked.find((r) => r.name === 'Ben');
  assert.equal(anne.quote, bens.quote);
  assert.notEqual(anne.rank, bens.rank);
});

test('Gleiche Quote und gleicher Schnitt teilen sich den Rang', () => {
  const db = makeDb();
  const anna = addUser(db, 'Anna');
  const ben = addUser(db, 'Ben');
  const cara = addUser(db, 'Cara');
  play(db, anna, cara, 6, 3, 20, 30);
  play(db, ben, cara, 6, 3, 20, 30);

  const { ranked } = getRanking(db, 1);
  const a = ranked.find((r) => r.name === 'Anna');
  const b = ranked.find((r) => r.name === 'Ben');
  assert.equal(a.rank, b.rank);
});

test('Deaktivierte User werden nicht gewertet', () => {
  const db = makeDb();
  const anna = addUser(db, 'Anna');
  const ben = addUser(db, 'Ben');
  play(db, anna, ben, 6, 3);
  db.prepare('UPDATE users SET aktiv = 0 WHERE id = ?').run(ben);

  const { ranked, unranked } = getRanking(db, 1);
  assert.deepEqual(ranked.map((r) => r.name), ['Anna']);
  assert.equal(unranked.length, 0);
});

test('Die Rangliste gilt nur für den gewählten Modus', () => {
  const db = makeDb();
  const anna = addUser(db, 'Anna');
  const ben = addUser(db, 'Ben');
  play(db, anna, ben, 6, 6, 20, 22, 1);
  play(db, anna, ben, 6, 0, 20, 22, 2);

  assert.equal(getRanking(db, 1).ranked[0].name, 'Anna');
  assert.equal(getRanking(db, 2).ranked[0].name, 'Ben');
});

test('Kurzstatistik eines Users', () => {
  const db = makeDb();
  const anna = addUser(db, 'Anna');
  const ben = addUser(db, 'Ben');
  play(db, anna, ben, 4, 3, 20, 25);

  const s = getUserStats(db, anna);
  assert.equal(s.games, 4);
  assert.equal(s.wins, 3);
  assert.equal(s.quote, 0.75);
  assert.equal(s.avg_win_rounds, 20);

  const none = getUserStats(db, addUser(db, 'Neu'));
  assert.equal(none.games, 0);
  assert.equal(none.avg_win_rounds, null);
});

test('Rangliste gilt standardmässig schon ab dem ersten Spiel', () => {
  const db = makeDb();
  const anna = addUser(db, 'Anna');
  const ben = addUser(db, 'Ben');
  play(db, anna, ben, 1, 1);

  const { ranked, unranked } = getRanking(db, 1);
  assert.deepEqual(ranked.map((r) => r.name), ['Anna', 'Ben']);
  assert.equal(unranked.length, 0);
});
