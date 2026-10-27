'use strict';

const express = require('express');
const bcrypt = require('bcrypt');

module.exports = (db, rounds) => {
  const router = express.Router();

  router.get('/', (req, res) => {
    res.render('account', { errors: [] });
  });

  router.post('/password', async (req, res, next) => {
    try {
      const me = req.session.user;
      const body = req.body || {};
      const current = String(body.current || '');
      const next1 = String(body.password || '');
      const next2 = String(body.password2 || '');
      const errors = [];

      const row = db.prepare('SELECT password_hash FROM users WHERE id = ?').get(me.id);
      if (!(await bcrypt.compare(current, row.password_hash))) errors.push('Das aktuelle Passwort stimmt nicht.');
      if (next1.length < 10) errors.push('Das neue Passwort muss mindestens 10 Zeichen haben.');
      if (next1 !== next2) errors.push('Die beiden neuen Passwörter sind nicht gleich.');

      if (errors.length) return res.status(422).render('account', { errors });

      const hash = await bcrypt.hash(next1, rounds);
      db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hash, me.id);
      req.session.flash = { type: 'ok', text: 'Passwort geändert.' };
      res.redirect('/account');
    } catch (err) {
      next(err);
    }
  });

  return router;
};
