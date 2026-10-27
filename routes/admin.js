'use strict';

const express = require('express');
const bcrypt = require('bcrypt');
const { validateMode, validateNewUser } = require('../services/validate');
const { exportRows } = require('../services/matches');

function csvCell(v) {
  let s = String(v ?? '');
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`; // Formel-Injection in Excel verhindern
  return /[",\n;]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

module.exports = (db, rounds) => {
  const router = express.Router();

  const flash = (req, type, text) => {
    req.session.flash = { type, text };
  };

  const activeAdminCount = () =>
    db.prepare("SELECT COUNT(*) AS n FROM users WHERE role = 'admin' AND aktiv = 1").get().n;

  router.param('id', (req, res, next, raw) => {
    if (!/^\d+$/.test(raw)) return next('route');
    req.targetId = Number.parseInt(raw, 10);
    next();
  });

  // ---- Übersicht -------------------------------------------------------------
  router.get('/', (req, res) => {
    const counts = {
      users: db.prepare('SELECT COUNT(*) AS n FROM users WHERE aktiv = 1').get().n,
      modes: db.prepare('SELECT COUNT(*) AS n FROM game_modes WHERE aktiv = 1').get().n,
      matches: db.prepare('SELECT COUNT(*) AS n FROM matches').get().n,
    };
    res.render('admin/index', { counts });
  });

  // ---- Spielmodi ---------------------------------------------------------------
  router.get('/modes', (req, res) => {
    const modes = db.prepare('SELECT * FROM game_modes ORDER BY aktiv DESC, name').all();
    res.render('admin/modes', { modes, errors: [], form: null });
  });

  router.post('/modes', (req, res) => {
    const { errors, data } = validateMode(req.body || {});
    const exists = db.prepare('SELECT 1 FROM game_modes WHERE name = ?').get(data.name);
    if (exists) errors.push('Einen Modus mit diesem Namen gibt es schon.');
    if (errors.length) {
      const modes = db.prepare('SELECT * FROM game_modes ORDER BY aktiv DESC, name').all();
      return res.status(422).render('admin/modes', { modes, errors, form: data });
    }
    db.prepare('INSERT INTO game_modes (name, start_score, double_in, double_out) VALUES (?, ?, ?, ?)').run(
      data.name,
      data.start_score,
      data.double_in,
      data.double_out
    );
    flash(req, 'ok', `Modus "${data.name}" angelegt.`);
    res.redirect('/admin/modes');
  });

  router.post('/modes/:id', (req, res) => {
    const { errors, data } = validateMode(req.body || {});
    const clash = db.prepare('SELECT 1 FROM game_modes WHERE name = ? AND id <> ?').get(data.name, req.targetId);
    if (clash) errors.push('Einen Modus mit diesem Namen gibt es schon.');
    if (errors.length) {
      flash(req, 'err', errors.join(' '));
      return res.redirect('/admin/modes');
    }
    db.prepare('UPDATE game_modes SET name = ?, start_score = ?, double_in = ?, double_out = ? WHERE id = ?').run(
      data.name,
      data.start_score,
      data.double_in,
      data.double_out,
      req.targetId
    );
    flash(req, 'ok', 'Modus gespeichert.');
    res.redirect('/admin/modes');
  });

  router.post('/modes/:id/toggle', (req, res) => {
    db.prepare('UPDATE game_modes SET aktiv = 1 - aktiv WHERE id = ?').run(req.targetId);
    flash(req, 'ok', 'Modus umgeschaltet.');
    res.redirect('/admin/modes');
  });

  // ---- User -----------------------------------------------------------------
  router.get('/users', (req, res) => {
    const users = db.prepare('SELECT id, name, role, aktiv, erstellt_am FROM users ORDER BY aktiv DESC, name').all();
    res.render('admin/users', { users, errors: [], form: null });
  });

  router.post('/users', async (req, res, next) => {
    try {
      const body = req.body || {};
      const { errors, name } = validateNewUser(body);
      if (!errors.length && db.prepare('SELECT 1 FROM users WHERE name = ?').get(name)) {
        errors.push('Diesen Namen gibt es schon.');
      }
      if (errors.length) {
        const users = db.prepare('SELECT id, name, role, aktiv, erstellt_am FROM users ORDER BY aktiv DESC, name').all();
        return res.status(422).render('admin/users', { users, errors, form: { name, role: body.role } });
      }
      const hash = await bcrypt.hash(String(body.password), rounds);
      db.prepare('INSERT INTO users (name, password_hash, role) VALUES (?, ?, ?)').run(name, hash, body.role);
      flash(req, 'ok', `User "${name}" angelegt.`);
      res.redirect('/admin/users');
    } catch (err) {
      next(err);
    }
  });

  router.post('/users/:id/password', async (req, res, next) => {
    try {
      const pw = String((req.body || {}).password || '');
      if (pw.length < 10) {
        flash(req, 'err', 'Das Passwort muss mindestens 10 Zeichen haben.');
        return res.redirect('/admin/users');
      }
      const hash = await bcrypt.hash(pw, rounds);
      const r = db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hash, req.targetId);
      flash(req, r.changes ? 'ok' : 'err', r.changes ? 'Passwort zurückgesetzt.' : 'User nicht gefunden.');
      res.redirect('/admin/users');
    } catch (err) {
      next(err);
    }
  });

  router.post('/users/:id/toggle', (req, res) => {
    const me = req.session.user;
    const target = db.prepare('SELECT id, role, aktiv FROM users WHERE id = ?').get(req.targetId);
    if (!target) {
      flash(req, 'err', 'User nicht gefunden.');
    } else if (target.id === me.id) {
      flash(req, 'err', 'Du kannst dich nicht selbst sperren.');
    } else if (target.aktiv && target.role === 'admin' && activeAdminCount() <= 1) {
      flash(req, 'err', 'Der letzte aktive Admin kann nicht gesperrt werden.');
    } else {
      db.prepare('UPDATE users SET aktiv = 1 - aktiv WHERE id = ?').run(target.id);
      flash(req, 'ok', target.aktiv ? 'User gesperrt.' : 'User wieder aktiviert.');
    }
    res.redirect('/admin/users');
  });

  router.post('/users/:id/role', (req, res) => {
    const me = req.session.user;
    const role = (req.body || {}).role;
    const target = db.prepare('SELECT id, role, aktiv FROM users WHERE id = ?').get(req.targetId);
    if (!target || !['admin', 'player'].includes(role)) {
      flash(req, 'err', 'Ungültige Anfrage.');
    } else if (target.id === me.id && role !== 'admin') {
      flash(req, 'err', 'Du kannst dir die Admin-Rolle nicht selbst entziehen.');
    } else if (target.role === 'admin' && role !== 'admin' && target.aktiv && activeAdminCount() <= 1) {
      flash(req, 'err', 'Es muss mindestens ein aktiver Admin bleiben.');
    } else {
      db.prepare('UPDATE users SET role = ? WHERE id = ?').run(role, target.id);
      flash(req, 'ok', 'Rolle geändert.');
    }
    res.redirect('/admin/users');
  });

  // ---- CSV-Export ---------------------------------------------------------------
  router.get('/export.csv', (req, res) => {
    const rows = exportRows(db);
    const head = ['match_id', 'datum', 'modus', 'spieler', 'runden', 'gewonnen', 'aufnahmen', 'n180'];
    const lines = [head.join(',')].concat(
      rows.map((r) =>
        [r.match_id, r.datum, r.modus, r.spieler, r.runden, r.gewonnen, r.aufnahmen, r.n180].map(csvCell).join(',')
      )
    );
    res.type('text/csv; charset=utf-8');
    res.set('Content-Disposition', 'attachment; filename="dart-resultate.csv"');
    res.send(`﻿${lines.join('\n')}\n`);
  });

  return router;
};
