'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const { makeDb, makeApp, addUser, loginAs, post, tokenFrom, addMatch, PASSWORD } = require('./helper');

function setup() {
  const db = makeDb();
  const admin = addUser(db, 'Admin', 'admin');
  const anna = addUser(db, 'Anna');
  const ben = addUser(db, 'Ben');
  const app = makeApp(db);
  return { db, app, admin, anna, ben };
}

const matchBody = (anna, ben, { datum = '2026-10-20', ra = 18, rb = 22, winner = 0 } = {}) =>
  `datum=${datum}&game_mode_id=1&user_id=${anna}&rounds=${ra}&user_id=${ben}&rounds=${rb}&winner=${winner}`;

// ---- Zugriff und Login --------------------------------------------------------

test('ohne Login: Weiterleitung auf /login', async () => {
  const { app } = setup();
  for (const url of ['/', '/matches', '/matches/new', '/ranking', '/admin', '/admin/users']) {
    const res = await request(app).get(url);
    assert.equal(res.status, 302, url);
    assert.equal(res.headers.location, '/login', url);
  }
});

test('Login-Seite lädt und setzt Sicherheits-Header', async () => {
  const { app } = setup();
  const res = await request(app).get('/login');
  assert.equal(res.status, 200);
  assert.match(res.headers['content-security-policy'], /script-src 'self'/);
  assert.equal(res.headers['x-powered-by'], undefined);
});

test('Login: richtig, falsch, ohne CSRF-Token', async () => {
  const { app } = setup();

  const noToken = await request(app).post('/login').type('form').send({ name: 'Anna', password: PASSWORD });
  assert.equal(noToken.status, 403);

  const agent = request.agent(app);
  const page = await agent.get('/login');
  const token = tokenFrom(page.text);
  const bad = await agent.post('/login').type('form').send({ name: 'Anna', password: 'falsch-falsch', _csrf: token });
  assert.equal(bad.status, 401);
  assert.match(bad.text, /Name oder Passwort falsch/);

  const good = await loginAs(app, 'Anna');
  const home = await good.get('/');
  assert.equal(home.status, 200);
  assert.match(home.text, /Hallo Anna/);
});

test('gesperrter User kann sich nicht anmelden', async () => {
  const { app, db } = setup();
  addUser(db, 'Gesperrt', 'player', 0);
  await assert.rejects(() => loginAs(app, 'Gesperrt'), /Login fehlgeschlagen/);
});

test('Login-Rate-Limit greift', async () => {
  const db = makeDb();
  addUser(db, 'Anna');
  const app = makeApp(db, { loginLimit: 3 });
  const agent = request.agent(app);
  const page = await agent.get('/login');
  const token = tokenFrom(page.text);
  const codes = [];
  for (let i = 0; i < 5; i++) {
    const r = await agent.post('/login').type('form').send({ name: 'Anna', password: 'falsch-falsch', _csrf: token });
    codes.push(r.status);
  }
  assert.deepEqual(codes, [401, 401, 401, 429, 429]);
});

test('Player kommt nicht in den Admin-Bereich', async () => {
  const { app, db } = setup();
  const anna = await loginAs(app, 'Anna');
  for (const url of ['/admin', '/admin/users', '/admin/modes', '/admin/export.csv']) {
    const res = await anna.get(url);
    assert.equal(res.status, 403, url);
  }
  const res = await post(anna, '/admin/users', { name: 'Hacker', password: '1234567890', role: 'admin' });
  assert.equal(res.status, 403);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM users WHERE name = 'Hacker'").get().n, 0);
});

test('Logout beendet die Session', async () => {
  const { app } = setup();
  const anna = await loginAs(app, 'Anna');
  await post(anna, '/logout');
  const res = await anna.get('/');
  assert.equal(res.status, 302);
  assert.equal(res.headers.location, '/login');
});

test('Sperren wirkt sofort auf laufende Sessions', async () => {
  const { app, db, anna } = setup();
  const agent = await loginAs(app, 'Anna');
  assert.equal((await agent.get('/')).status, 200);
  db.prepare('UPDATE users SET aktiv = 0 WHERE id = ?').run(anna);
  const res = await agent.get('/');
  assert.equal(res.status, 302);
});

// ---- Spiel erfassen --------------------------------------------------------------

test('Spiel erfassen, im Verlauf sehen, Statistik wächst', async () => {
  const { app, anna, ben } = setup();
  const agent = await loginAs(app, 'Anna');

  assert.equal((await agent.get('/matches/new')).status, 200);

  const res = await post(agent, '/matches', matchBody(anna, ben));
  assert.equal(res.status, 302, res.text);

  const list = await agent.get('/matches?mine=1');
  assert.match(list.text, /501 Double Out/);
  assert.match(list.text, /20\.10\.2026/);
  assert.match(list.text, /18 Runden · Sieg/);

  const home = await agent.get('/');
  assert.match(home.text, /Hallo Anna/);
  assert.match(home.text, /501 Double Out/);
});

test('ungültiges Spiel: 422 mit Fehlermeldung, nichts gespeichert', async () => {
  const { app, db, anna, ben } = setup();
  const agent = await loginAs(app, 'Anna');
  const res = await post(agent, '/matches', matchBody(anna, ben, { ra: 0 }));
  assert.equal(res.status, 422);
  assert.match(res.text, /Runden müssen zwischen 1 und 99/);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM matches').get().n, 0);
});

test('Spiel ohne CSRF-Token wird abgelehnt', async () => {
  const { app, db, anna, ben } = setup();
  const agent = await loginAs(app, 'Anna');
  const res = await post(agent, '/matches', matchBody(anna, ben), { withToken: false });
  assert.equal(res.status, 403);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM matches').get().n, 0);
});

test('htmx: Spielerzeile nachladen und Grenzen', async () => {
  const { app } = setup();
  const agent = await loginAs(app, 'Anna');
  const ok = await agent.get('/matches/row?i=2');
  assert.equal(ok.status, 200);
  assert.match(ok.text, /id="row-2"/);
  assert.match(ok.text, /hx-get="\/matches\/row\?i=3"/);
  assert.equal((await agent.get('/matches/row?i=8')).status, 204);
  assert.equal((await agent.get('/matches/row?i=abc')).status, 204);
});

test('htmx: Verlauf liefert bei HX-Request nur das Fragment', async () => {
  const { app } = setup();
  const agent = await loginAs(app, 'Anna');
  const full = await agent.get('/matches');
  const part = await agent.get('/matches').set('HX-Request', 'true');
  assert.match(full.text, /<html/);
  assert.doesNotMatch(part.text, /<html/);
  assert.match(part.headers.vary, /HX-Request/);
});

// ---- Korrektur ----------------------------------------------------------------------

test('Ersteller darf 30 Minuten ändern, danach nicht mehr; Admin immer', async () => {
  const { app, db, anna, ben } = setup();
  const id = addMatch(db, { by: anna, players: [[anna, 18, true], [ben, 22, false]] });

  const a = await loginAs(app, 'Anna');
  assert.equal((await a.get(`/matches/${id}/edit`)).status, 200);

  db.prepare("UPDATE matches SET erstellt_am = datetime('now', '-2 hours') WHERE id = ?").run(id);
  assert.equal((await a.get(`/matches/${id}/edit`)).status, 403);
  const denied = await post(a, `/matches/${id}`, matchBody(anna, ben, { ra: 5, rb: 6 }));
  assert.equal(denied.status, 403);

  const adm = await loginAs(app, 'Admin');
  assert.equal((await adm.get(`/matches/${id}/edit`)).status, 200);
  const upd = await post(adm, `/matches/${id}`, matchBody(anna, ben, { datum: '2026-10-01', ra: 15, rb: 19, winner: 1 }));
  assert.equal(upd.status, 302, upd.text);

  const rows = db.prepare('SELECT user_id, rounds, won FROM match_players WHERE match_id = ? ORDER BY user_id').all(id);
  assert.deepEqual(rows, [
    { user_id: anna, rounds: 15, won: 0 },
    { user_id: ben, rounds: 19, won: 1 },
  ]);
});

test('fremdes Spiel kann ein Player nicht ändern', async () => {
  const { app, db, anna, ben } = setup();
  const id = addMatch(db, { by: ben, players: [[anna, 18, true], [ben, 22, false]] });
  const a = await loginAs(app, 'Anna');
  assert.equal((await a.get(`/matches/${id}/edit`)).status, 403);
});

test('Löschen: nur Admin', async () => {
  const { app, db, anna, ben } = setup();
  const id = addMatch(db, { by: anna, players: [[anna, 18, true], [ben, 22, false]] });

  const a = await loginAs(app, 'Anna');
  const no = await post(a, `/matches/${id}/delete`);
  assert.equal(no.status, 403);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM matches').get().n, 1);

  const adm = await loginAs(app, 'Admin');
  const yes = await post(adm, `/matches/${id}/delete`);
  assert.equal(yes.status, 302);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM matches').get().n, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM match_players').get().n, 0);
});

test('unbekannte Spiel-ID: 404', async () => {
  const { app } = setup();
  const a = await loginAs(app, 'Anna');
  assert.equal((await a.get('/matches/9999/edit')).status, 404);
});

// ---- Rangliste -------------------------------------------------------------------------

test('Rangliste-Seite zeigt gewertete Spieler', async () => {
  const { app, db, anna, ben } = setup();
  for (let i = 0; i < 6; i++) {
    addMatch(db, { by: anna, players: [[anna, 18, i < 4], [ben, 22, i >= 4]] });
  }
  const a = await loginAs(app, 'Anna');
  const res = await a.get('/ranking?mode=1');
  assert.equal(res.status, 200);
  assert.match(res.text, /Anna/);
  assert.match(res.text, /67 %/);
  assert.match(res.text, /33 %/);
});

// ---- Admin ---------------------------------------------------------------------------------

test('Admin legt User an, Duplikate und kurze Passwörter werden abgelehnt', async () => {
  const { app, db } = setup();
  const adm = await loginAs(app, 'Admin');

  assert.equal((await post(adm, '/admin/users', { name: 'Cara', password: '1234567890', role: 'player' })).status, 302);
  assert.equal((await post(adm, '/admin/users', { name: 'cara', password: '1234567890', role: 'player' })).status, 422);
  assert.equal((await post(adm, '/admin/users', { name: 'Dora', password: 'kurz', role: 'player' })).status, 422);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM users WHERE name = ?').get('Cara').n, 1);

  const cara = await loginAs(app, 'Cara', '1234567890');
  assert.equal((await cara.get('/')).status, 200);
});

test('Admin kann sich nicht selbst sperren und nicht herabstufen', async () => {
  const { app, db, admin } = setup();
  const adm = await loginAs(app, 'Admin');
  await post(adm, `/admin/users/${admin}/toggle`);
  assert.equal(db.prepare('SELECT aktiv FROM users WHERE id = ?').get(admin).aktiv, 1);
  await post(adm, `/admin/users/${admin}/role`, { role: 'player' });
  assert.equal(db.prepare('SELECT role FROM users WHERE id = ?').get(admin).role, 'admin');
});

test('der letzte aktive Admin bleibt erhalten', async () => {
  const { app, db, admin } = setup();
  const second = addUser(db, 'Admin2', 'admin');
  const adm = await loginAs(app, 'Admin');

  // Admin2 sperren geht, solange noch ein anderer aktiver Admin da ist
  await post(adm, `/admin/users/${second}/toggle`);
  assert.equal(db.prepare('SELECT aktiv FROM users WHERE id = ?').get(second).aktiv, 0);

  // Admin2 wieder aktiv, dann zum Player machen ist ebenfalls erlaubt
  await post(adm, `/admin/users/${second}/toggle`);
  await post(adm, `/admin/users/${second}/role`, { role: 'player' });
  assert.equal(db.prepare('SELECT role FROM users WHERE id = ?').get(second).role, 'player');
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM users WHERE role = 'admin' AND aktiv = 1").get().n, 1);
  void admin;
});

test('Passwort zurücksetzen und eigenes Passwort ändern', async () => {
  const { app, anna } = setup();
  const adm = await loginAs(app, 'Admin');
  const r = await post(adm, `/admin/users/${anna}/password`, { password: 'neues-passwort-1' });
  assert.equal(r.status, 302);
  await assert.rejects(() => loginAs(app, 'Anna', PASSWORD), /Login fehlgeschlagen/);

  const a = await loginAs(app, 'Anna', 'neues-passwort-1');
  const wrong = await post(a, '/account/password', {
    current: 'falsch',
    password: 'wieder-neu-123',
    password2: 'wieder-neu-123',
  });
  assert.equal(wrong.status, 422);
  const good = await post(a, '/account/password', {
    current: 'neues-passwort-1',
    password: 'wieder-neu-123',
    password2: 'wieder-neu-123',
  });
  assert.equal(good.status, 302);
  assert.ok(await loginAs(app, 'Anna', 'wieder-neu-123'));
});

test('Spielmodi: anlegen, Namenskonflikt, deaktivieren', async () => {
  const { app, db } = setup();
  const adm = await loginAs(app, 'Admin');

  assert.equal((await post(adm, '/admin/modes', { name: '701 Double Out', start_score: '701', double_out: '1' })).status, 302);
  assert.equal((await post(adm, '/admin/modes', { name: '701 double out', start_score: '701' })).status, 422);

  const id = db.prepare("SELECT id FROM game_modes WHERE name = '701 Double Out'").get().id;
  await post(adm, `/admin/modes/${id}/toggle`);
  assert.equal(db.prepare('SELECT aktiv FROM game_modes WHERE id = ?').get(id).aktiv, 0);
});

test('CSV-Export: Kopfzeile, Daten, Formel-Schutz', async () => {
  const { app, db, anna, ben } = setup();
  const evil = addUser(db, '=SUMME(A1)');
  addMatch(db, { by: anna, players: [[anna, 18, true], [ben, 22, false], [evil, 30, false]] });

  const adm = await loginAs(app, 'Admin');
  const res = await adm.get('/admin/export.csv');
  assert.equal(res.status, 200);
  assert.match(res.headers['content-type'], /text\/csv/);
  assert.match(res.headers['content-disposition'], /attachment/);
  assert.match(res.text, /match_id,datum,modus,spieler,runden,gewonnen/);
  assert.match(res.text, /Anna,18,1/);
  assert.match(res.text, /'=SUMME\(A1\)/);
});

test('404-Seite für unbekannte Pfade (angemeldet)', async () => {
  const { app } = setup();
  const a = await loginAs(app, 'Anna');
  const res = await a.get('/gibt-es-nicht');
  assert.equal(res.status, 404);
  assert.match(res.text, /Nicht gefunden/);
});
