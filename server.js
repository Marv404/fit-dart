'use strict';

require('dotenv').config({ quiet: true });

const path = require('path');
const session = require('express-session');
const SqliteStore = require('better-sqlite3-session-store')(session);
const Database = require('better-sqlite3');

const { openDb, seed } = require('./db');
const { createApp } = require('./app');

const PORT = Number(process.env.PORT) || 3000;
const IS_PROD = process.env.NODE_ENV === 'production';
const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'data', 'dart.db');
const SESSION_DB_PATH = process.env.SESSION_DB_PATH || path.join(__dirname, 'data', 'sessions.db');

if (!process.env.SESSION_SECRET || process.env.SESSION_SECRET.length < 32) {
  console.error('SESSION_SECRET fehlt oder ist zu kurz (mind. 32 Zeichen). Siehe .env.example.');
  process.exit(1);
}

const db = openDb(DB_PATH);
for (const msg of seed(db, {
  adminName: process.env.ADMIN_NAME,
  adminPassword: process.env.ADMIN_PASSWORD,
})) {
  console.log(msg);
}

const sessionDb = new Database(SESSION_DB_PATH);
sessionDb.pragma('journal_mode = WAL');

const app = createApp({
  db,
  secret: process.env.SESSION_SECRET,
  isProd: IS_PROD,
  sessionStore: new SqliteStore({
    client: sessionDb,
    expired: { clear: true, intervalMs: 15 * 60 * 1000 },
  }),
});

const server = app.listen(PORT, () => {
  console.log(`Dart-App läuft auf http://localhost:${PORT}`);
});

function shutdown() {
  server.close(() => {
    db.close();
    sessionDb.close();
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 10_000).unref();
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
