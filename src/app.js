const express = require('express');
const session = require('express-session');
const helmet = require('helmet');
const BetterSqlite3Store = require('better-sqlite3-session-store')(session);
const config = require('./config');
const { getDb } = require('./db');
const healthRoutes = require('./routes/health');
const openaiRoutes = require('./routes/openai');
const adminRoutes = require('./routes/admin');
const studentPortalRoutes = require('./routes/studentPortal');
const { notFound, errorHandler } = require('./middleware/errorHandler');
const { apiError } = require('./utils/errors');
const { getSetting } = require('./services/settingsService');

if (!BetterSqlite3Store.prototype.__ietiIntervalPatched) {
  BetterSqlite3Store.prototype.startInterval = function startInterval() {
    this._clearExpiredInterval = setInterval(
      this.clearExpiredSessions.bind(this),
      this.expired.intervalMs
    );
    this._clearExpiredInterval.unref?.();
  };
  BetterSqlite3Store.prototype.close = function close() {
    if (this._clearExpiredInterval) clearInterval(this._clearExpiredInterval);
    this._clearExpiredInterval = null;
  };
  BetterSqlite3Store.prototype.__ietiIntervalPatched = true;
}

function createApp() {
  const app = express();
  const sessionStore = new BetterSqlite3Store({ client: getDb(), expired: { clear: true, intervalMs: 900000 } });

  app.disable('x-powered-by');
  app.set('trust proxy', true);
  app.locals.sessionStore = sessionStore;
  app.use(helmet({ contentSecurityPolicy: false }));
  app.use(express.json({ limit: Math.ceil((config.maxTotalImageBytes * 4) / 3) + 1048576 }));
  app.use(express.urlencoded({ extended: false, limit: '128kb' }));
  app.use(session({
    name: 'ieti_proxy_sid',
    secret: config.sessionSecret,
    store: sessionStore,
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      sameSite: 'lax',
      secure: false,
      maxAge: 8 * 60 * 60 * 1000
    }
  }));

  app.use((req, res, next) => {
    if (req.path.startsWith('/admin') || req.path === '/health' || req.path === '/' || req.path === '/login' || req.path.startsWith('/portal')) return next();
    if (getSetting('maintenance_mode', 'false') === 'true') {
      return next(apiError(503, 'maintenance_mode', 'Server is in maintenance mode.'));
    }
    next();
  });

  app.use(healthRoutes);
  app.use(studentPortalRoutes);
  app.use(adminRoutes);
  app.use(openaiRoutes);
  app.use(notFound);
  app.use(errorHandler);

  return app;
}

module.exports = { createApp };
