'use strict';

const express = require('express');
const { getUserStats } = require('../services/ranking');
const { listMatches, canEdit } = require('../services/matches');

module.exports = (db) => {
  const router = express.Router();

  router.get('/', (req, res) => {
    const me = req.session.user;
    const stats = getUserStats(db, me.id);
    const { rows } = listMatches(db, { userId: me.id, page: 1 });
    const recent = rows.slice(0, 8).map((m) => ({ ...m, editable: canEdit(me, m) }));
    res.render('dashboard', { stats, recent });
  });

  return router;
};
