'use strict';

const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const bcrypt = require('bcrypt');

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS users (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    name          TEXT NOT NULL UNIQUE COLLATE NOCASE,
    password_hash TEXT NOT NULL,
    role          TEXT NOT NULL DEFAULT 'player' CHECK (role IN ('admin', 'player')),
    aktiv         INTEGER NOT NULL DEFAULT 1,
    erstellt_am   TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS game_modes (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    name         TEXT NOT NULL UNIQUE COLLATE NOCASE,
    start_score  INTEGER NOT NULL CHECK (start_score > 0),
    double_in    INTEGER NOT NULL DEFAULT 0,
    double_out   INTEGER NOT NULL DEFAULT 0,
    aktiv        INTEGER NOT NULL DEFAULT 1
  );

  CREATE TABLE IF NOT EXISTS matches (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    datum        TEXT NOT NULL,
    game_mode_id INTEGER NOT NULL REFERENCES game_modes(id),
    erfasst_von  INTEGER NOT NULL REFERENCES users(id),
    erstellt_am  TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS match_players (
    id        INTEGER PRIMARY KEY AUTOINCREMENT,
    match_id  INTEGER NOT NULL REFERENCES matches(id) ON DELETE CASCADE,
    user_id   INTEGER NOT NULL REFERENCES users(id),
    rounds    INTEGER NOT NULL CHECK (rounds > 0 AND rounds < 100),
    won       INTEGER NOT NULL DEFAULT 0,
    n180      INTEGER NOT NULL DEFAULT 0 CHECK (n180 BETWEEN 0 AND 99),
    UNIQUE (match_id, user_id)
  );

  -- Einzelne Aufnahmen (Punkte pro Runde), optional pro Spieler
  CREATE TABLE IF NOT EXISTS turns (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    match_player_id INTEGER NOT NULL REFERENCES match_players(id) ON DELETE CASCADE,
    rundennummer    INTEGER NOT NULL CHECK (rundennummer >= 1),
    punkte          INTEGER NOT NULL CHECK (punkte BETWEEN 0 AND 180),
    UNIQUE (match_player_id, rundennummer)
  );

  CREATE INDEX IF NOT EXISTS idx_matches_mode ON matches(game_mode_id, datum);
  CREATE INDEX IF NOT EXISTS idx_mp_user ON match_players(user_id);
`;

/** Ältere Datenbanken: Spalte n180 nachrüsten und aus vorhandenen Aufnahmen befüllen. */
function migrate(db) {
  const cols = db.prepare("PRAGMA table_info('match_players')").all();
  if (cols.some((c) => c.name === 'n180')) return;
  db.transaction(() => {
    db.exec('ALTER TABLE match_players ADD COLUMN n180 INTEGER NOT NULL DEFAULT 0 CHECK (n180 BETWEEN 0 AND 99)');
    db.exec(
      'UPDATE match_players SET n180 = (SELECT COUNT(*) FROM turns t WHERE t.match_player_id = match_players.id AND t.punkte = 180)'
    );
  })();
}

function openDb(file) {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new Database(file);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.exec(SCHEMA);
  migrate(db);
  return db;
}

/**
 * Beispielmodi und ersten Admin anlegen, falls die Tabellen leer sind.
 * Gibt eine kurze Statusmeldung zurück (oder null).
 */
function seed(db, { adminName, adminPassword, rounds = 12 } = {}) {
  const messages = [];

  if (db.prepare('SELECT COUNT(*) AS n FROM game_modes').get().n === 0) {
    const ins = db.prepare(
      'INSERT INTO game_modes (name, start_score, double_in, double_out) VALUES (?, ?, ?, ?)'
    );
    ins.run('501 Double Out', 501, 0, 1);
    ins.run('301 Double In/Out', 301, 1, 1);
    ins.run('501 Straight Out', 501, 0, 0);
    messages.push('Beispielmodi angelegt.');
  }

  if (db.prepare('SELECT COUNT(*) AS n FROM users').get().n === 0) {
    if (!adminName || !adminPassword || adminPassword.length < 10) {
      messages.push('Kein Admin angelegt: ADMIN_NAME und ADMIN_PASSWORD (mind. 10 Zeichen) setzen.');
    } else {
      const hash = bcrypt.hashSync(adminPassword, rounds);
      db.prepare("INSERT INTO users (name, password_hash, role) VALUES (?, ?, 'admin')").run(
        adminName,
        hash
      );
      messages.push(`Admin "${adminName}" angelegt. ADMIN_PASSWORD danach aus der .env entfernen.`);
    }
  }
  return messages;
}

module.exports = { openDb, seed };
