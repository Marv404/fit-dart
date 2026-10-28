'use strict';

const path = require('path');
const crypto = require('crypto');
const express = require('express');
const session = require('express-session');
const bcrypt = require('bcrypt');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');

const BCRYPT_ROUNDS_DEFAULT = 12;

/**
 * Baut die Express-App. Alles Konfigurierbare kommt über `opts`,
 * damit Tests eine In-Memory-DB und einen Memory-Session-Store einsetzen können.
 *
 * opts: { db, sessionStore, secret, isProd, bcryptRounds, loginLimit }
 */
function createApp(opts) {
  const {
    db,
    sessionStore,
    secret,
    isProd = false,
    bcryptRounds = BCRYPT_ROUNDS_DEFAULT,
    loginLimit = 10,
  } = opts;

  const app = express();
  app.disable('x-powered-by');
  if (isProd) app.set('trust proxy', 1); // hinter Reverse Proxy (Caddy/nginx)

  app.set('view engine', 'ejs');
  app.set('views', path.join(__dirname, 'views'));

  app.locals.db = db;
  app.locals.bcryptRounds = bcryptRounds;

  // Helfer für die Templates
  app.locals.version = require('./package.json').version;
  app.locals.pct =(q) => `${Math.round((q || 0) * 100)} %`;
  app.locals.num1 = (n) => (n === null || n === undefined ? '–' : Number(n).toFixed(1));
  app.locals.num2 = (n) => (n === null || n === undefined ? '–' : Number(n).toFixed(2));
  app.locals.dateCH = (iso) => String(iso).split('-').reverse().join('.');
  app.locals.today = () => require('./services/validate').todayISO();

  app.use(helmet()); // Standard-CSP: nur eigene Skripte/Styles -> htmx liegt lokal in /public
  app.use(express.urlencoded({ extended: false, limit: '20kb' }));
  app.use(express.json({ limit: '20kb' }));
  app.use(express.static(path.join(__dirname, 'public'), { maxAge: isProd ? '7d' : 0 }));

  app.use(
    session({
      name: 'dart.sid',
      secret,
      resave: false,
      saveUninitialized: false,
      store: sessionStore,
      cookie: {
        httpOnly: true,
        secure: isProd,
        sameSite: 'lax',
        maxAge: 1000 * 60 * 60 * 24 * 14, // 14 Tage
      },
    })
  );

  // Gemeinsame Template-Variablen
  app.use((req, res, next) => {
    res.locals.user = req.session.user || null;
    res.locals.path = req.path;
    res.locals.flash = req.session.flash || null;
    delete req.session.flash;
    next();
  });

  // -------------------------------------------------------------------------
  // CSRF: Token in der Session, Prüfung bei allen unsicheren Methoden
  // -------------------------------------------------------------------------
  app.use((req, res, next) => {
    if (!req.session.csrf) req.session.csrf = crypto.randomBytes(32).toString('hex');
    res.locals.csrfToken = req.session.csrf;

    if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();

    const sent = String((req.body && req.body._csrf) || req.get('x-csrf-token') || '');
    const a = Buffer.from(sent);
    const b = Buffer.from(req.session.csrf);
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
      return res.status(403).render('error', {
        title: 'Ungültige Anfrage',
        message: 'Das Sicherheits-Token ist abgelaufen. Bitte die Seite neu laden und erneut versuchen.',
      });
    }
    next();
  });

  // -------------------------------------------------------------------------
  // Auth-Middleware
  // -------------------------------------------------------------------------
  function requireLogin(req, res, next) {
    if (!req.session.user) return res.redirect('/login');
    next();
  }

  function requireAdmin(req, res, next) {
    if (!req.session.user) return res.redirect('/login');
    if (req.session.user.role !== 'admin') {
      return res.status(403).render('error', { title: 'Kein Zugriff', message: 'Dafür brauchst du Admin-Rechte.' });
    }
    next();
  }

  // -------------------------------------------------------------------------
  // Login / Logout
  // -------------------------------------------------------------------------
  const DUMMY_HASH = bcrypt.hashSync(crypto.randomBytes(16).toString('hex'), bcryptRounds);

  const loginLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: loginLimit,
    standardHeaders: true,
    legacyHeaders: false,
    skipSuccessfulRequests: true,
    handler: (req, res) =>
      res.status(429).render('login', { error: 'Zu viele Versuche. Bitte in einigen Minuten erneut probieren.' }),
  });

  app.get('/login', (req, res) => {
    if (req.session.user) return res.redirect('/');
    res.render('login', { error: null });
  });

  app.post('/login', loginLimiter, async (req, res, next) => {
    try {
      const body = req.body || {};
      const name = String(body.name || '').trim();
      const password = String(body.password || '');

      const row = db
        .prepare('SELECT id, name, password_hash, role, aktiv FROM users WHERE name = ?')
        .get(name);

      // Immer vergleichen, damit die Antwortzeit nicht verrät, ob der Name existiert
      const ok = await bcrypt.compare(password, row ? row.password_hash : DUMMY_HASH);
      if (!row || !row.aktiv || !ok) {
        return res.status(401).render('login', { error: 'Name oder Passwort falsch.' });
      }

      // Neue Session-ID nach dem Login (gegen Session-Fixation)
      req.session.regenerate((err) => {
        if (err) return next(err);
        req.session.user = { id: row.id, name: row.name, role: row.role };
        req.session.csrf = crypto.randomBytes(32).toString('hex');
        req.session.save((err2) => (err2 ? next(err2) : res.redirect('/')));
      });
    } catch (err) {
      next(err);
    }
  });

  app.post('/logout', (req, res, next) => {
    req.session.destroy((err) => {
      if (err) return next(err);
      res.clearCookie('dart.sid');
      res.redirect('/login');
    });
  });

  // Gesperrte oder gelöschte User fliegen bei der nächsten Anfrage raus
  app.use((req, res, next) => {
    const u = req.session.user;
    if (!u) return next();
    const row = db.prepare('SELECT id, name, role, aktiv FROM users WHERE id = ?').get(u.id);
    if (!row || !row.aktiv) {
      return req.session.destroy(() => res.redirect('/login'));
    }
    // Rolle aus der DB übernehmen, falls sie geändert wurde
    req.session.user = { id: row.id, name: row.name, role: row.role };
    res.locals.user = req.session.user;
    next();
  });

  // -------------------------------------------------------------------------
  // Routen
  // -------------------------------------------------------------------------
  app.use('/', requireLogin, require('./routes/dashboard')(db));
  app.use('/matches', requireLogin, require('./routes/matches')(db));
  app.use('/ranking', requireLogin, require('./routes/ranking')(db));
  app.use('/stats', requireLogin, require('./routes/stats')(db));
  app.use('/changelog', requireLogin, require('./routes/changelog')());
  app.use('/account', requireLogin, require('./routes/account')(db, bcryptRounds));
  app.use('/admin', requireAdmin, require('./routes/admin')(db, bcryptRounds));

  // -------------------------------------------------------------------------
  // Fehlerbehandlung
  // -------------------------------------------------------------------------
  app.use((req, res) => {
    res.status(404).render('error', { title: 'Nicht gefunden', message: 'Diese Seite gibt es nicht.' });
  });

  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    console.error(err);
    res.status(500).render('error', { title: 'Fehler', message: 'Etwas ist schiefgelaufen.' });
  });

  return app;
}

module.exports = { createApp };
