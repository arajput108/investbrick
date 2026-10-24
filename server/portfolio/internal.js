import express from 'express';
import { rateLimit } from 'express-rate-limit';
import { createHash, timingSafeEqual } from 'node:crypto';

const digest = (s) => createHash('sha256').update(String(s)).digest();

/** POST /api/internal/match : lets an outside scheduler (for example a free GitHub Actions cron) wake a sleeping server and run
 *  one matching pass. Requires "Authorization: Bearer <CRON_SECRET>". Returns counts only, never user data.
 *  If CRON_SECRET is not configured the route does not exist (404). The pass uses the same locked, idempotent settlement
 *  code as the background matcher, so running it as often as you like can never double-fill an order. */
export function createInternalRouter({ secret, runPass }) {
  const r = express.Router();
  if (!secret) return r;
  r.post('/match', rateLimit({ windowMs: 60e3, limit: 20, standardHeaders: 'draft-7', legacyHeaders: false,
    handler: (_q, res) => res.status(429).json({ error: 'Too many requests.', code: 'RATE_LIMITED' }) }),
  async (req, res) => {
    const m = /^Bearer (.+)$/.exec(req.get('authorization') || '');
    if (!m || !timingSafeEqual(digest(m[1]), digest(secret))) return res.status(401).json({ error: 'Unauthorized.' });
    try {
      const out = await runPass();
      const pick = (o, ks) => Object.fromEntries(ks.filter((k) => o && o[k] !== undefined).map((k) => [k, o[k]]));
      res.json({ ok: !out?.error, ...pick(out, ['skipped', 'candidates', 'filled', 'rejected', 'expired', 'deferred', 'errors']), feedError: out?.feedError ? true : undefined });
    } catch { res.status(500).json({ ok: false, error: 'Matching pass failed.' }); }
  });
  return r;
}
