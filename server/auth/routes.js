import { log } from '../logger.js';
import express from 'express';
import { rateLimit, ipKeyGenerator } from 'express-rate-limit';
import { AuthError } from './service.js';
import { normalizeEmail } from './validate.js';

export function parseCookies(header = '') {
  const out = {};
  for (const part of String(header).split(';')) {
    const i = part.indexOf('=');
    if (i > 0) { try { out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim()); } catch { /* ignore malformed */ } }
  }
  return out;
}

export function createAuth({ service, config }) {
  const cookieName = config.isProd ? '__Host-ib_session' : 'ib_session';
  const L = { loginIp: 20, loginAcct: 5, register: 10, forgot: 5, reset: 10, change: 10, windowMs: 15 * 60e3, hourMs: 3600e3, ...config.rateLimits };
  const limit = (max, windowMs, keyFn, extra = {}) => rateLimit({
    windowMs, limit: max, standardHeaders: 'draft-7', legacyHeaders: false,
    keyGenerator: keyFn || ((req) => ipKeyGenerator(req.ip)),
    handler: (_req, res) => res.status(429).json({ error: 'Too many attempts. Please wait a few minutes and try again.', code: 'RATE_LIMITED' }),
    ...extra,
  });
  const byIpEmail = (req) => `${ipKeyGenerator(req.ip)}|${normalizeEmail(req.body?.email)}`;

  const setCookie = (res, s) => res.cookie(cookieName, s.token, { httpOnly: true, secure: config.isProd, sameSite: 'lax', path: '/', maxAge: s.maxAgeMs });
  const clearCookie = (res) => res.clearCookie(cookieName, { httpOnly: true, secure: config.isProd, sameSite: 'lax', path: '/' });
  const meta = (req) => ({ ip: req.ip, userAgent: req.get('user-agent') });

  /** Loads req.user from the session cookie (null for guests). A database outage degrades to guest, never to someone else's data. */
  async function sessionLoader(req, _res, next) {
    req.user = null; req.sessionToken = null;
    const tok = parseCookies(req.headers.cookie)[cookieName];
    if (tok) {
      try { req.user = await service.getSession(tok); if (req.user) req.sessionToken = tok; }
      catch (e) { log.error('session lookup failed', e); req.authError = true; }
    }
    next();
  }
  const requireAuth = (req, res, next) => (req.user ? next() : res.status(401).json({ error: 'Please log in to continue.', code: 'UNAUTHENTICATED' }));

  /** CSRF defence in depth: SameSite=Lax cookie + JSON-only bodies + Origin/Fetch-Metadata checks on state-changing requests. */
  function guardUnsafe(req, res, next) {
    if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
    const origin = req.get('origin');
    if (origin) {
      let ok = false;
      try { const o = new URL(origin); ok = o.host === req.get('host') || o.origin === new URL(config.appUrl).origin; } catch { /* bad origin */ }
      if (!ok) return res.status(403).json({ error: 'Cross-site request blocked.', code: 'BAD_ORIGIN' });
    }
    if (req.get('sec-fetch-site') === 'cross-site') return res.status(403).json({ error: 'Cross-site request blocked.', code: 'BAD_ORIGIN' });
    const hasBody = Number(req.get('content-length') || 0) > 0 || !!req.get('transfer-encoding');
    if (hasBody && !req.is('application/json')) return res.status(415).json({ error: 'Send JSON.', code: 'BAD_CONTENT_TYPE' });
    next();
  }

  const wrap = (fn) => async (req, res) => {
    try { await fn(req, res); }
    catch (e) {
      if (e instanceof AuthError) return res.status(e.status).json({ error: e.message, fields: e.fields, ...(e.code ? { code: e.code } : {}) });
      log.error('auth request failed', { err: e, requestId: req.id });
      res.status(500).json({ error: 'Something went wrong on our side. Please try again.' });
    }
  };

  const r = express.Router();
  r.use(guardUnsafe);
  r.get('/me', (req, res) => res.json({ user: req.user, enabled: true }));

  r.post('/register', limit(L.register, L.hourMs), wrap(async (req, res) => {
    const { user, session } = await service.register(req.body || {}, meta(req));
    setCookie(res, session); res.status(201).json({ user });
  }));

  r.post('/login', limit(L.loginIp, L.windowMs), limit(L.loginAcct, L.windowMs, byIpEmail, { skipSuccessfulRequests: true }), wrap(async (req, res) => {
    const { user, session } = await service.login(req.body || {}, meta(req));
    setCookie(res, session); res.json({ user });
  }));

  r.post('/logout', wrap(async (req, res) => {
    await service.logout(req.sessionToken); clearCookie(res); res.json({ ok: true });
  }));

  // Same response whether or not the account exists.
  r.post('/forgot-password', limit(L.forgot, L.hourMs), wrap(async (req, res) => {
    await service.requestReset(req.body || {});
    res.json({ ok: true, message: 'If an account exists for that email, a reset link is on its way. It stays valid for one hour.' });
  }));

  r.post('/reset-password', limit(L.reset, L.hourMs), wrap(async (req, res) => {
    await service.resetPassword(req.body || {}); clearCookie(res);
    res.json({ ok: true, message: 'Password updated. Log in with your new password.' });
  }));

  r.post('/change-password', requireAuth, limit(L.change, L.hourMs), wrap(async (req, res) => {
    await service.changePassword(req.user.id, req.body || {}, req.sessionToken);
    res.json({ ok: true, message: 'Password updated. Other devices were signed out.' });
  }));

  return { router: r, sessionLoader, requireAuth, guardUnsafe, cookieName };
}
