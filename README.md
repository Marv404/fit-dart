# Dart-App

Web-App für Dart-Resultate mit Login, Rangliste und Admin-Bereich. Node.js, Express, SQLite, EJS und htmx.

## Start

```bash
npm install
cp .env.example .env      # SESSION_SECRET, ADMIN_NAME und ADMIN_PASSWORD eintragen
npm start                 # http://localhost:3000
```

- `SESSION_SECRET`: mindestens 32 Zeichen, z. B. `openssl rand -hex 32`.
- `ADMIN_NAME` / `ADMIN_PASSWORD`: legen beim ersten Start den Admin an (Passwort mind. 10 Zeichen). Danach `ADMIN_PASSWORD` aus der `.env` löschen.
- Beim ersten Start werden drei Beispielmodi angelegt (501 Double Out, 301 Double In/Out, 501 Straight Out).

Entwicklung: `npm run dev` (Neustart bei Änderungen). Tests: `npm test`.

## Funktionen

- Login mit Rollen Player und Admin, Rate-Limit, CSRF-Schutz
- Spiel erfassen: Modus, Datum, 2 bis 8 Spieler mit Runden, ein Sieger
- Aufnahmen (optional): die Punkte jeder Runde pro Spieler, z. B. `60 100 140 180 21`. Bust zählt als 0. Der Sieger muss genau den Startscore erreichen und mit einem gültigen Finish enden (bei Double Out nur Doppel, Bogey-Finishes wie 162 werden abgelehnt), unmögliche Aufnahmen (z. B. 179) werden abgewiesen. Sind Aufnahmen eingetragen, darf «Runden» leer bleiben.
- Statistik: Average pro Aufnahme, 180er, höchstes Finish, bestes Leg, pro Modus filterbar, plus Übersicht aller Spieler. Average und 180er erscheinen auch auf Dashboard, Rangliste und im Spielverlauf. Gezählt werden nur Spiele mit erfassten Aufnahmen.
- Spielverlauf mit Filter nach Modus und «nur meine Spiele»
- Rangliste pro Modus: Siegquote, ab dem ersten Spiel gewertet, Tiebreak über den Rundendurchschnitt in gewonnenen Spielen
- Korrektur: Admin immer, der Ersteller 30 Minuten nach dem Speichern. Löschen nur Admin
- Admin: Spielmodi und User verwalten, Passwörter zurücksetzen, sperren, CSV-Export
- Eigenes Passwort ändern unter «Konto»

## Struktur

```
server.js        Start, Sessions in SQLite, sauberes Beenden
app.js           Express-App (Middleware, Login, CSRF), testbar
db.js            Schema und Seed
routes/          dashboard, matches, ranking, stats, account, admin
services/        ranking (Rangliste), stats (Average, 180er, Finish), matches (Speichern/Rechte), validate
views/           EJS-Templates, partials/
public/          style.css, htmx.min.js (lokal wegen CSP)
scripts/backup.js
tests/           node:test und Supertest
```

## Betrieb

Hinter einem Reverse Proxy mit HTTPS betreiben und `NODE_ENV=production` setzen (aktiviert `secure`-Cookies und `trust proxy`).

Caddy:

```
dart.example.ch {
    reverse_proxy 127.0.0.1:3000
}
```

systemd (`/etc/systemd/system/dart.service`):

```ini
[Unit]
Description=Dart-App
After=network.target

[Service]
WorkingDirectory=/opt/dart-app
EnvironmentFile=/opt/dart-app/.env
Environment=NODE_ENV=production
ExecStart=/usr/bin/node server.js
Restart=always
User=dart

[Install]
WantedBy=multi-user.target
```

Backup (täglich, 14 Stände bleiben):

```bash
node scripts/backup.js /var/backups/dart
# crontab: 15 3 * * * cd /opt/dart-app && node scripts/backup.js /var/backups/dart
```

Backup-Datei vor dem Livegang einmal zurückspielen (Datei nach `data/dart.db` kopieren, App starten).

Update: Backup, `git pull`, `npm ci`, Dienst neu starten.

## Später

- Checkout-Quote: braucht die Darts auf Doppel pro Runde, die nicht erfasst werden (stattdessen: höchstes Finish)
- weitere Modi (Cricket), Saisons, PWA

Bestehende Datenbanken werden beim Start automatisch um die Tabelle `turns` erweitert, vorhandene Spiele bleiben unverändert.
