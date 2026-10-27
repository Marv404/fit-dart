'use strict';

const express = require('express');
const { getRanking } = require('../services/ranking');

module.exports = (db) => {
  const router = express.Router();

  router.get('/', (req, res) => {
    const modes = db.prepare('SELECT id, name, aktiv FROM game_modes ORDER BY aktiv DESC, name').all();
    const wanted = Number.parseInt(req.query.mode, 10);
    const mode = modes.find((m) => m.id === wanted) || modes.find((m) => m.aktiv) || modes[0] || null;
    const ranking = mode ? getRanking(db, mode.id) : { ranked: [], unranked: [], minGames: 0 };
    res.render('ranking', { modes, mode, ranking });
  });

  return router;
};
