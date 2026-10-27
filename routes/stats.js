'use strict';

const express = require('express');
const { getUserStats, getLeaders } = require('../services/stats');

module.exports = (db) => {
  const router = express.Router();

  router.get('/', (req, res) => {
    const me = req.session.user;
    const modes = db.prepare('SELECT id, name, aktiv FROM game_modes ORDER BY aktiv DESC, name').all();
    const wanted = Number.parseInt(req.query.mode, 10);
    const mode = modes.find((m) => m.id === wanted) || null; // null = alle Modi

    res.render('stats', {
      modes,
      mode,
      stats: getUserStats(db, me.id, mode ? mode.id : null),
      leaders: getLeaders(db, mode ? mode.id : null),
    });
  });

  return router;
};
