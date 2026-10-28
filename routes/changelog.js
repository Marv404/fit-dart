'use strict';

const express = require('express');
const { CHANGELOG } = require('../services/changelog');

module.exports = () => {
  const router = express.Router();
  router.get('/', (req, res) => res.render('changelog', { entries: CHANGELOG }));
  return router;
};
