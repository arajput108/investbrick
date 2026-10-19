import express from 'express';
import helmet from 'helmet';
import compression from 'compression';
import rateLimit from 'express-rate-limit';
import path from 'node:path';
import fs from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { log as rootLog } from './logger.js';

const pub = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');

export function createApp({ market, config, auth = null, portfolioRouter = null, health = null, ready = null, log = rootLog }) {
  const app = express();
  app.disable('x-powered-by');
  if (config.trustProxy) app.set('trust proxy', config.trustProxy);

  // Request id (reuses the platform's, else makes one) + one structured log line per request. No query strings, cookies, bodies or IPs are logged.
  app.use((req, res, next) => {
    const inc = req.get('x-request-id');
    req.id = inc && /^[\w.-]{8,80}$/.test(inc) ? inc : randomUUID();
    res.set('X-Request-Id', req.id);
    const t0 = process.hrtime.bigint();
    res.on('finish', () => {
      if (req.path === '/healthz' || req.path === '/readyz') return;
      const ms = Math.round(Number(process.hrtime.bigint() - t0) / 1e6), status = res.statusCode;
      log[status >= 500 ? 'error' : status >= 400 ? 'warn' : 'info']('request', { requestId: req.id, method: req.method, path: req.originalUrl.split('?')[0], status, ms, userId: req.user?.id });
    });
    next();
  });
  // Production is HTTPS-only (the platform terminates TLS and tells us via X-Forwarded-Proto). Health checks are exempt.
  if (config.isProd) app.use((req, res, next) => {
    if (req.protocol === 'https' || req.path === '/healthz' || req.path === '/readyz') return next();
    if (req.method === 'GET' || req.method === 'HEAD') return res.redirect(308, `https://${req.get('host')}${req.originalUrl}`);
    return res.status(400).json({ error: 'Use https:// to reach this site.', code: 'HTTPS_REQUIRED' });
  });
  app.use(helmet({
    // The single-file front-end uses inline <style>/<script>; tighten once split into files.
    contentSecurityPolicy: { directives: {
      defaultSrc: ["'self'"], scriptSrc: ["'self'", "'unsafe-inline'"], styleSrc: ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
      fontSrc: ["'self'", 'https://fonts.gstatic.com'], imgSrc: ["'self'", 'data:', 'https://i.ytimg.com'],
      frameSrc: ['https://www.youtube-nocookie.com'], connectSrc: ["'self'"], objectSrc: ["'none'"], upgradeInsecureRequests: config.isProd ? [] : null,
    } },
    hsts: config.isProd,
  }));
  app.use(compression());
  app.use(express.json({ limit: '10kb' }));
  const needsSession = /^\/(api\/(auth|portfolio)(\/|$)|$|index\.html$|login$|register$|forgot-password$|reset-password$)/;
  if (auth) app.use((req, res, next) => (needsSession.test(req.path) ? auth.sessionLoader(req, res, next) : next()));

  // /healthz = liveness: is the process up? Deliberately does NOT touch the database (so platform health checks never keep a serverless DB awake).
  app.get('/healthz', (_req, res) => res.set('Cache-Control', 'no-store').json({ ok: true, ...(health ? health() : {}) }));
  // /readyz = readiness: can it actually serve? Checks the database and the matcher heartbeat. For uptime monitors, not for the platform health check.
  app.get('/readyz', async (_req, res) => {
    res.set('Cache-Control', 'no-store');
    if (!ready) return res.json({ ok: true, checks: {} });
    try { const r = await ready(); res.status(r.ok ? 200 : 503).json(r); }
    catch (e) { log.error('readiness check failed', e); res.status(503).json({ ok: false, checks: { error: 'readiness check failed' } }); }
  });

  const api = express.Router();
  // Broad per-IP safety net (market polling is ~3 requests/min per open tab). Generous because a whole campus can share one IP;
  // sensitive routes (login, orders) have their own tighter limits.
  api.use(rateLimit({ windowMs: 60e3, limit: config.apiLimit ?? 600, standardHeaders: 'draft-7', legacyHeaders: false,
    handler: (_req, res) => res.status(429).json({ error: 'Too many requests. Please slow down for a moment.', code: 'RATE_LIMITED' }) }));
  api.use((_req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });

  api.get('/market/status', (_req, res) => res.json(market.status()));
  api.get('/market/instruments', (_req, res) => res.json({ instruments: market.instruments() }));
  api.get('/market/quotes', async (req, res, next) => {
    try {
      const syms = String(req.query.symbols || '').split(',').map((s) => s.trim()).filter(Boolean).slice(0, 40);
      res.json(await market.quotes(syms));
    } catch (e) { next(e); }
  });
  api.get('/market/candles/:sym', async (req, res) => {
    try { res.json(await market.candles(decodeURIComponent(req.params.sym), String(req.query.range || '6M'))); }
    catch (e) { res.status(e.status || 502).json({ error: e.status ? e.message : 'Market data unavailable', detail: e.status ? undefined : e.message }); }
  });
  // ---- accounts (Phase 2) ----
  if (auth) api.use('/auth', auth.router);
  if (auth && portfolioRouter) api.use('/portfolio', portfolioRouter);
  else {
    api.get('/auth/me', (_req, res) => res.json({ user: null, enabled: false }));
    api.use('/auth', (_req, res) => res.status(503).json({ error: 'Accounts are not set up on this server yet.', code: 'AUTH_DISABLED' }));
  }
  api.use((_req, res) => res.status(404).json({ error: 'Not found' }));
  app.use('/api', api);


  // Pages. The home page is rendered with the visitor's session state so the browser knows
  // synchronously whether (and as whom) they are logged in. Only id/name/email of the visitor are embedded.
  const readTpl = (() => { let c; return async (f) => (config.isProd && c?.[f]) || ((c ||= {})[f] = await fs.readFile(path.join(pub, f), 'utf8')); })();
  const page = (file, render) => async (req, res, next) => {
    try {
      res.set('Cache-Control', 'no-store').type('html').send(render(await readTpl(file), req));
    } catch (e) { next(e); }
  };
  const boot = (req) => JSON.stringify({ user: req.user || null, authEnabled: !!auth }).replace(/</g, '\\u003c');
  app.get(['/', '/index.html'], page('index.html', (t, req) => t.replace('<!--IB_BOOT-->', `<script>window.__IB__=${boot(req)};</script>`)));
  const authPage = page('auth.html', (t) => t);
  app.get(['/login', '/register'], (req, res, next) => (req.user ? res.redirect('/') : authPage(req, res, next)));
  app.get(['/forgot-password', '/reset-password'], authPage);
  app.use(express.static(pub, { maxAge: config.isProd ? '1h' : 0, extensions: ['html'] }));
  app.use((err, req, res, _next) => { // eslint-disable-line no-unused-vars
    // Client mistakes from the body parser (bad JSON, body too large) are 4xx, not server faults.
    if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'The request body is not valid JSON.', code: 'BAD_JSON' });
    if (err.type === 'entity.too.large') return res.status(413).json({ error: 'The request is too large.', code: 'TOO_LARGE' });
    log.error('unhandled request error', { err, requestId: req.id, method: req.method, path: req.path });
    res.status(500).json({ error: 'Something went wrong on our side.', code: 'INTERNAL', requestId: req.id });
  });
  return app;
}
