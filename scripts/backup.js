'use strict';

// Konsistentes Backup der SQLite-Datenbank (auch im laufenden Betrieb).
// Aufruf: node scripts/backup.js [Zielordner]   (Standard: ./backups, 14 Backups bleiben erhalten)

require('dotenv').config({ quiet: true });
const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

const KEEP = 14;
const dbPath = process.env.DB_PATH || path.join(__dirname, '..', 'data', 'dart.db');
const targetDir = path.resolve(process.argv[2] || path.join(__dirname, '..', 'backups'));

async function main() {
  if (!fs.existsSync(dbPath)) throw new Error(`Datenbank nicht gefunden: ${dbPath}`);
  fs.mkdirSync(targetDir, { recursive: true });

  const stamp = new Date().toISOString().replace(/[:T]/g, '-').slice(0, 19);
  const target = path.join(targetDir, `dart-${stamp}.db`);

  const db = new Database(dbPath, { readonly: true });
  await db.backup(target);
  db.close();

  // Kopie auf einen einzelnen File reduzieren (kein -wal/-shm daneben) und prüfen
  const check = new Database(target);
  check.pragma('journal_mode = DELETE');
  const ok = check.pragma('integrity_check', { simple: true });
  check.close();
  if (ok !== 'ok') throw new Error(`Backup defekt: ${ok}`);

  const old = fs
    .readdirSync(targetDir)
    .filter((f) => /^dart-.*\.db$/.test(f))
    .sort()
    .slice(0, -KEEP);
  for (const f of old) fs.unlinkSync(path.join(targetDir, f));

  console.log(`Backup erstellt: ${target}`);
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
