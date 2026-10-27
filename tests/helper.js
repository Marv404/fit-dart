'use strict';

const session = require('express-session');
const bcrypt = require('bcrypt');
const request = require('supertest');
const { openDb, seed } = require('../db');
const { createApp } = require('../app');

const ROUNDS = 4; // schnell für Tests
const PASSWORD = 'geheim-12345';

function addUser(db, name, role = 'player', aktiv = 1, password = PASSWORD) {
  const hash = bcrypt.hashSync(password, ROUNDS);
  return Number(
    db.prepare('INSERT INTO users (name, password_hash, role, aktiv) VALUES (?, ?, ?, ?)').run(name, hash, role, aktiv)
      .lastInsertRowid
  );
}

function makeDb() {
  const db = openDb(':memory:');
  seed(db, { rounds: ROUNDS }); // nur Beispielmodi, kein Admin
  return db;
}

function makeApp(db, extra = {}) {
  return createApp({
    db,
    secret: 'x'.repeat(40),
    sessionStore: new session.MemoryStore(),
    bcryptRounds: ROUNDS,
    ...extra,
  });
}

const tokenFrom = (html) => (/name="_csrf" value="([a-f0-9]+)"/.exec(html) || [])[1];

/** Meldet einen Agent an und gibt ihn zurück. */
async function loginAs(app, name, password = PASSWORD) {
  const agent = request.agent(app);
  const page = await agent.get('/login');
  const res = await agent.post('/login').type('form').send({ name, password, _csrf: tokenFrom(page.text) });
  if (res.status !== 302) throw new Error(`Login fehlgeschlagen (${res.status})`);
  return agent;
}

/** Aktuelles CSRF-Token einer angemeldeten Session (aus dem Erfassen-Formular). */
async function csrf(agent) {
  const res = await agent.get('/account');
  return tokenFrom(res.text);
}

/**
 * POST mit frischem CSRF-Token. Das Token wird VOR dem Erzeugen der Anfrage geholt:
 * supertest teilt sich beim Agent einen Server, eine zweite Anfrage mitten im Aufbau schliesst ihn.
 * body: Objekt oder fertiger Form-String (ohne _csrf).
 */
async function post(agent, url, body = {}, { withToken = true } = {}) {
  const token = withToken ? await csrf(agent) : null;
  if (typeof body === 'string') {
    return agent.post(url).type('form').send(withToken ? `_csrf=${token}&${body}` : body);
  }
  return agent.post(url).type('form').send(withToken ? { _csrf: token, ...body } : body);
}

/** Direkt ein Spiel in die DB schreiben: players = [[userId, rounds, won, turns?], ...] */
function addMatch(db, { modeId = 1, datum = '2026-10-01', by, players }) {
  const { lastInsertRowid } = db
    .prepare('INSERT INTO matches (datum, game_mode_id, erfasst_von) VALUES (?, ?, ?)')
    .run(datum, modeId, by);
  const ins = db.prepare('INSERT INTO match_players (match_id, user_id, rounds, won, n180) VALUES (?, ?, ?, ?, ?)');
  const insTurn = db.prepare('INSERT INTO turns (match_player_id, rundennummer, punkte) VALUES (?, ?, ?)');
  for (const [u, r, w, turns, n180] of players) {
    const count = n180 ?? (turns || []).filter((p) => p === 180).length;
    const mp = ins.run(lastInsertRowid, u, r, w ? 1 : 0, count).lastInsertRowid;
    (turns || []).forEach((p, i) => insTurn.run(mp, i + 1, p));
  }
  return Number(lastInsertRowid);
}

module.exports = { makeDb, makeApp, addUser, loginAs, csrf, post, tokenFrom, addMatch, PASSWORD };
