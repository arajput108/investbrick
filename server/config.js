import 'dotenv/config';
import { log } from './logger.js';

const env = process.env;
const nodeEnv = env.NODE_ENV || 'development';
const isProd = nodeEnv === 'production';
const port = Number(env.PORT) || 3000;
const int = (v, d) => (Number.isFinite(Number(v)) && v !== undefined && v !== '' ? Number(v) : d);

export const config = {
  nodeEnv, isProd, port,
  coingeckoKey: env.COINGECKO_API_KEY || '',
  trustProxy: env.TRUST_PROXY ? Number(env.TRUST_PROXY) : 0, // set 1 behind Render/Railway/nginx
  // Public base URL used in password-reset links. Must be your real https address in production.
  appUrl: (env.APP_URL || `http://localhost:${port}`).replace(/\/+$/, ''),
  db: {
    driver: env.DB_DRIVER || 'pg',          // 'pg' (Postgres/Neon) or 'pglite' (dev-only, zero setup)
    url: env.DATABASE_URL || '',
    pgliteDir: env.PGLITE_DIR || '.data/pglite',
    poolMax: Math.min(Math.max(int(env.DB_POOL_MAX, 10), 2), 50),
    statementTimeoutMs: Math.max(1000, int(env.DB_STATEMENT_TIMEOUT_MS, 20000)),
  },
  email: {
    // 'none' = no email service: sign-up and login work, password reset by email reports itself as unavailable (never pretends to send).
    // In production a missing SMTP_HOST therefore means 'none' (with a startup warning), not a crash.
    // 'brevo-api' sends over HTTPS (port 443), which works on hosts that block SMTP ports (Render's free plan).
    provider: (() => {
      const p = env.EMAIL_PROVIDER || (isProd ? (env.BREVO_API_KEY ? 'brevo-api' : 'smtp') : 'console');
      if (isProd && p === 'smtp' && !env.SMTP_HOST) return 'none';
      if (isProd && p === 'brevo-api' && !env.BREVO_API_KEY) return 'none';
      return p;
    })(),
    brevoApiKey: env.BREVO_API_KEY || '',
    from: env.EMAIL_FROM || 'InvestBrick <no-reply@localhost>',
    smtp: { host: env.SMTP_HOST || '', port: int(env.SMTP_PORT, 587), user: env.SMTP_USER || '', pass: env.SMTP_PASS || '', secure: env.SMTP_SECURE === 'true' },
  },
  cronSecret: env.CRON_SECRET || '',   // lets an outside scheduler wake the server and run one matching pass (see README); unset = endpoint does not exist
  matcher: { enabled: env.MATCHER_ENABLED !== 'false', intervalSec: Math.max(5, int(env.MATCHER_INTERVAL_SEC, 15)), idleRecheckSec: Math.max(30, int(env.MATCHER_IDLE_RECHECK_SEC, 1800)) },
  migrateOnStart: env.MIGRATE_ON_START !== 'false',      // false = never change the schema at boot; refuse to start if migrations are pending (run `npm run migrate` as a deploy step)
  shutdownGraceMs: Math.max(1000, int(env.SHUTDOWN_GRACE_SEC, 25) * 1000),
  orderTtlDays: Math.min(Math.max(int(env.ORDER_TTL_DAYS, 30), 1), 365),
  auth: {
    argon: { memoryCost: int(env.ARGON_MEMORY_KIB, 19456), timeCost: int(env.ARGON_TIME_COST, 2), parallelism: 1 },
    sessionDays: int(env.SESSION_DAYS, 30), idleDays: int(env.SESSION_IDLE_DAYS, 7),
    resetMaxPerHour: Math.min(Math.max(int(env.RESET_MAX_PER_HOUR, 3), 1), 20),   // reset emails per account per hour (mail-bombing guard)
  },
};

/** Returns a list of problems that must block a production start. */
export function productionProblems(c = config) {
  const p = [];
  if (!c.db.url) p.push('DATABASE_URL is required (use your Neon connection string).');
  if (c.db.driver !== 'pg') p.push('DB_DRIVER must be "pg" in production.');
  if (!/^https:\/\//.test(c.appUrl)) p.push('APP_URL must be your public https:// address (it is used in password-reset emails).');
  if (!['smtp', 'brevo-api', 'none'].includes(c.email.provider)) p.push('EMAIL_PROVIDER must be "brevo-api", "smtp" or "none" (run without email) in production.');
  else if (c.email.provider === 'brevo-api' && !c.email.brevoApiKey) p.push('BREVO_API_KEY is required when EMAIL_PROVIDER=brevo-api.');
  else if (c.email.provider === 'smtp' && !c.email.smtp.host) p.push('SMTP_HOST (and usually SMTP_USER / SMTP_PASS) are required for password-reset emails.');
  if (/^https:\/\/(localhost|127\.|0\.0\.0\.0)/.test(c.appUrl)) p.push('APP_URL points at localhost. Use your public https:// address.');
  if (c.db.url && !/^postgres(ql)?:\/\/[^/]*(localhost|127\.0\.0\.1)/.test(c.db.url) && !/[?&](sslmode=(require|verify-ca|verify-full)|ssl=true)/.test(c.db.url)) p.push('DATABASE_URL needs ?sslmode=require for a hosted database (Neon connection strings already include it).');
  if (!c.trustProxy) p.push('TRUST_PROXY=1 is needed behind a hosting proxy so rate limits and secure cookies see the real client.');
  return p;
}
if (isProd && config.email.provider === 'none') log.warn('No email service configured: password reset by email is UNAVAILABLE (registration and login still work). Set BREVO_API_KEY (works on Render free) or SMTP_HOST/SMTP_USER/SMTP_PASS to enable it.');
if (isProd && !config.coingeckoKey) log.warn('COINGECKO_API_KEY not set: crypto requests use the unkeyed public tier (stricter limits).');
