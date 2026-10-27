'use strict';

const express = require('express');
const { validateMatch, todayISO, toArray } = require('../services/validate');
const svc = require('../services/matches');

const MAX_ROWS = 8;
const MIN_ROWS = 2;

module.exports = (db) => {
  const router = express.Router();

  // ---- Hilfsfunktionen ----------------------------------------------------
  const activeModes = (extraId) =>
    db
      .prepare('SELECT id, name FROM game_modes WHERE aktiv = 1 OR id = ? ORDER BY name')
      .all(extraId ?? -1);

  const selectableUsers = (extraIds = []) => {
    const all = db.prepare('SELECT id, name, aktiv FROM users ORDER BY name').all();
    return all.filter((u) => u.aktiv || extraIds.includes(u.id));
  };

  /** Zeilen aus dem abgeschickten Formular rekonstruieren (inkl. leerer Zeilen). */
  function rowsFromBody(body) {
    const ids = toArray(body.user_id);
    const rounds = toArray(body.rounds);
    const turns = toArray(body.turns);
    const n180 = toArray(body.n180);
    const n = Math.min(MAX_ROWS, Math.max(MIN_ROWS, ids.length));
    return Array.from({ length: n }, (_, i) => ({
      user_id: String(ids[i] ?? ''),
      rounds: String(rounds[i] ?? ''),
      turns: String(turns[i] ?? ''),
      n180: String(n180[i] ?? ''),
    }));
  }

  function renderForm(res, { status = 200, action, title, match, rows, winner, errors = [], canDelete = false }) {
    const playerIds = rows.map((r) => Number.parseInt(r.user_id, 10)).filter(Number.isInteger);
    res.status(status).render('match-form', {
      action,
      title,
      match,
      rows,
      winner,
      errors,
      canDelete,
      modes: activeModes(match.game_mode_id),
      users: selectableUsers(playerIds),
      maxRows: MAX_ROWS,
    });
  }

  // Express 5: IDs über router.param prüfen
  router.param('id', (req, res, next, raw) => {
    const id = Number.parseInt(raw, 10);
    if (!/^\d+$/.test(raw) || !Number.isInteger(id)) return next('route');
    const match = svc.getMatch(db, id);
    if (!match) {
      return res.status(404).render('error', { title: 'Nicht gefunden', message: 'Dieses Spiel gibt es nicht.' });
    }
    req.match = match;
    next();
  });

  // ---- Spielverlauf --------------------------------------------------------
  router.get('/', (req, res) => {
    const me = req.session.user;
    const modeId = Number.parseInt(req.query.mode, 10) || null;
    const onlyMine = req.query.mine === '1';
    const page = Number.parseInt(req.query.page, 10) || 1;

    const result = svc.listMatches(db, { modeId, userId: onlyMine ? me.id : null, page });
    result.rows = result.rows.map((m) => ({ ...m, editable: svc.canEdit(me, m) }));

    const query = new URLSearchParams();
    if (modeId) query.set('mode', modeId);
    if (onlyMine) query.set('mine', '1');

    res.vary('HX-Request');
    const view = req.get('HX-Request') ? 'partials/match-list' : 'matches';
    res.render(view, {
      ...result,
      modeId,
      onlyMine,
      queryBase: query.toString(),
      modes: db.prepare('SELECT id, name FROM game_modes ORDER BY aktiv DESC, name').all(),
    });
  });

  // ---- Neues Spiel ----------------------------------------------------------
  router.get('/new', (req, res) => {
    const me = req.session.user;
    const firstMode = db.prepare('SELECT id FROM game_modes WHERE aktiv = 1 ORDER BY name').get();
    const rows = [
      { user_id: String(me.id), rounds: '', turns: '', n180: '' },
      { user_id: '', rounds: '', turns: '', n180: '' },
    ];
    renderForm(res, {
      action: '/matches',
      title: 'Spiel erfassen',
      match: { datum: todayISO(), game_mode_id: firstMode ? firstMode.id : null },
      rows,
      winner: -1,
    });
  });

  // htmx: weitere Spielerzeile nachladen
  router.get('/row', (req, res) => {
    const i = Number.parseInt(req.query.i, 10);
    if (!Number.isInteger(i) || i < MIN_ROWS || i >= MAX_ROWS) return res.status(204).end();
    res.render('partials/player-row', {
      i,
      row: { user_id: '', rounds: '', turns: '', n180: '' },
      winner: -1,
      users: selectableUsers(),
      maxRows: MAX_ROWS,
      withOob: true,
    });
  });

  router.post('/', (req, res) => {
    const me = req.session.user;
    const { errors, data } = validateMatch(req.body, db);
    const rows = rowsFromBody(req.body);
    const winner = Number.parseInt(req.body.winner, 10);

    if (errors.length) {
      return renderForm(res, {
        status: 422,
        action: '/matches',
        title: 'Spiel erfassen',
        match: { datum: String(req.body.datum || ''), game_mode_id: Number.parseInt(req.body.game_mode_id, 10) || null },
        rows,
        winner: Number.isInteger(winner) ? winner : -1,
        errors,
      });
    }

    svc.createMatch(db, data, me.id);
    req.session.flash = { type: 'ok', text: 'Spiel gespeichert.' };
    res.redirect('/matches?mine=1');
  });

  // ---- Korrektur --------------------------------------------------------------
  router.get('/:id/edit', (req, res) => {
    const me = req.session.user;
    const m = req.match;
    if (!svc.canEdit(me, m)) {
      return res.status(403).render('error', {
        title: 'Kein Zugriff',
        message: `Spiele kann nur ein Admin ändern, oder du selbst in den ersten ${svc.EDIT_WINDOW_MIN} Minuten nach dem Speichern.`,
      });
    }
    const rows = m.players.map((p) => ({
      user_id: String(p.user_id),
      rounds: String(p.rounds),
      turns: p.turns.join(' '),
      n180: p.n180 ? String(p.n180) : '',
    }));
    while (rows.length < MIN_ROWS) rows.push({ user_id: '', rounds: '', turns: '', n180: '' });
    renderForm(res, {
      action: `/matches/${m.id}`,
      title: `Spiel #${m.id} ändern`,
      match: m,
      rows,
      winner: m.players.findIndex((p) => p.won),
      canDelete: me.role === 'admin',
    });
  });

  router.post('/:id', (req, res) => {
    const me = req.session.user;
    const m = req.match;
    if (!svc.canEdit(me, m)) {
      return res.status(403).render('error', { title: 'Kein Zugriff', message: 'Du darfst dieses Spiel nicht ändern.' });
    }
    const { errors, data } = validateMatch(req.body, db, { allowInactiveModeId: m.game_mode_id });
    if (errors.length) {
      const winner = Number.parseInt(req.body.winner, 10);
      return renderForm(res, {
        status: 422,
        action: `/matches/${m.id}`,
        title: `Spiel #${m.id} ändern`,
        match: { ...m, datum: String(req.body.datum || ''), game_mode_id: Number.parseInt(req.body.game_mode_id, 10) || m.game_mode_id },
        rows: rowsFromBody(req.body),
        winner: Number.isInteger(winner) ? winner : -1,
        errors,
        canDelete: me.role === 'admin',
      });
    }
    svc.updateMatch(db, m.id, data);
    req.session.flash = { type: 'ok', text: `Spiel #${m.id} aktualisiert.` };
    res.redirect('/matches');
  });

  router.post('/:id/delete', (req, res) => {
    const me = req.session.user;
    if (me.role !== 'admin') {
      return res.status(403).render('error', { title: 'Kein Zugriff', message: 'Nur Admins dürfen Spiele löschen.' });
    }
    svc.deleteMatch(db, req.match.id);
    req.session.flash = { type: 'ok', text: `Spiel #${req.match.id} gelöscht.` };
    res.redirect('/matches');
  });

  return router;
};
