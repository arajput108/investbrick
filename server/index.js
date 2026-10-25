import { config, productionProblems } from './config.js';
import { log } from './logger.js';
import { createApp } from './app.js';
import { createMarketService } from './market/service.js';
import { createYahoo } from './market/providers/yahoo.js';
import { createCoinGecko } from './market/providers/coingecko.js';
import { createDb } from './db/index.js';
import { migrate, migrationStatus } from './db/migrate.js';
import { createPasswords } from './auth/passwords.js';
import { createMailer } from './auth/mailer.js';
import { createAuthService } from './auth/service.js';
import { createAuth } from './auth/routes.js';
import { createPortfolioService } from './portfolio/service.js';
import { createPortfolioRouter } from './portfolio/routes.js';
import { createMatcher } from './portfolio/matcher.js';
import { createInternalRouter } from './portfolio/internal.js';

// A crash we cannot explain is logged, then the process exits so the platform restarts it cleanly. We never limp on in an unknown state.
process.on('unhandledRejection', (e) => { log.error('unhandled promise rejection: exiting', e instanceof Error ? e : { reason: String(e) }); setTimeout(() => process.exit(1), 100); });
process.on('uncaughtException', (e) => { log.error('uncaught exception: exiting', e); setTimeout(() => process.exit(1), 100); });

if (config.isProd) {
  const problems = productionProblems();
  if (problems.length) { log.error('refusing to start in production: fix the configuration', { problems }); setTimeout(() => process.exit(1), 100); await new Promise(() => {}); }
}

const market = createMarketService({
  yahoo: createYahoo(),
  coingecko: createCoinGecko({ apiKey: config.coingeckoKey }),
});

// Accounts need a database. Without one the site still serves market data and the guest paper account,
// and the auth endpoints answer 503 honestly: there is no fake login. In production a database problem stops the start.
let auth = null, db = null, service = null, portfolioRouter = null, portfolio = null, matcher = null;
if (config.db.url || config.db.driver === 'pglite') {
  try {
    db = await createDb({ driver: config.db.driver, url: config.db.url, pgliteDir: config.db.pgliteDir, isProd: config.isProd, poolMax: config.db.poolMax, statementTimeoutMs: config.db.statementTimeoutMs });
    let applied = [];
    if (config.migrateOnStart) applied = await migrate(db, { log: (m) => log.info('migration ' + m) });
    else {
      const st = await migrationStatus(db);
      if (st.unknown.length) log.warn('database has migrations this version does not know (a newer version may have run)', { unknown: st.unknown });
      if (st.pending.length) throw new Error(`MIGRATE_ON_START=false but ${st.pending.length} migration(s) are pending (${st.pending.join(', ')}). Run "npm run migrate" first.`);
    }
    portfolio = createPortfolioService({ db, market, orderTtlDays: config.orderTtlDays, onOrderOpened: () => matcher?.wake() });
    if (config.matcher.enabled) matcher = createMatcher({ db, service: portfolio, intervalMs: config.matcher.intervalSec * 1000, idleRecheckMs: config.matcher.idleRecheckSec * 1000 });
    service = createAuthService({
      db, config, onUserCreated: (t, userId) => portfolio.ensurePortfolio(t, userId), passwords: createPasswords(config.auth.argon),
      mailer: createMailer({ provider: config.email.provider, from: config.email.from, smtp: config.email.smtp, brevo: { apiKey: config.email.brevoApiKey }, isProd: config.isProd }),
    });
    auth = createAuth({ service, config });
    if (['brevo-api', 'smtp'].includes(config.email.provider) && /@localhost>?\s*$/.test(config.email.from)) {
      log.warn('EMAIL_FROM is not set (still the placeholder sender). Reset emails will be refused by the email provider until it is a verified sender address.');
    }
    portfolioRouter = createPortfolioRouter({ service: portfolio, auth, config });
    log.info('database connected', { driver: db.kind, migrationsApplied: applied.length });
  } catch (e) {
    log.error('could not start accounts', e);
    if (config.isProd) { setTimeout(() => process.exit(1), 100); await new Promise(() => {}); }
  }
} else {
  log.warn('No DATABASE_URL: accounts are disabled. See README (Neon setup) or run with DB_DRIVER=pglite for local development.');
}

// Public health info is deliberately minimal: no error text, no instance ids.
const health = () => ({ matcher: matcher ? { enabled: true, alive: matcher.alive() } : { enabled: false } });
const ready = async () => {
  const checks = {};
  if (db) {
    // Bounded: a database that is waking up (Neon free) or down must produce an answer, not a hung probe.
    try { await Promise.race([db.query('select 1'), new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 4000).unref())]); checks.database = 'ok'; }
    catch (e) { checks.database = e.message === 'timeout' ? 'timeout' : 'unreachable'; }
  }
  else checks.database = 'not configured';
  if (matcher) checks.matcher = matcher.alive() ? 'ok' : 'stalled';
  return { ok: Object.values(checks).every((v) => v === 'ok' || v === 'not configured'), checks };
};

const server = createApp({ market, config, auth, portfolioRouter, health, ready,
  internalRouter: db && config.cronSecret ? createInternalRouter({ secret: config.cronSecret, runPass: () => (matcher ? matcher.tick({ force: true }) : portfolio.runMatching()) }) : null }).listen(config.port, () => {
  log.info('listening', { port: config.port, env: config.nodeEnv, accounts: !!auth });
  if (matcher) { matcher.start(); log.info('background limit-order matcher started', { everySec: config.matcher.intervalSec, idleRecheckSec: config.matcher.idleRecheckSec }); }
  else if (portfolio) log.warn('MATCHER_ENABLED=false: limit orders only fill when their owner opens the app.');
});
// Longer than typical proxy idle timeouts (Render/nginx ~60s), so the proxy never reuses a connection we already closed.
server.keepAliveTimeout = 65e3; server.headersTimeout = 66e3; server.requestTimeout = 30e3;

const purge = service && setInterval(() => Promise.all([service.purgeExpired(), portfolio.purgeKeys()]).catch((e) => log.error('purge failed', e)), 3600e3);
purge?.unref();

let closing = false;
async function shutdown(sig) {
  if (closing) return; closing = true;
  log.info('shutting down', { signal: sig });
  const force = setTimeout(() => { log.error('graceful shutdown timed out: forcing exit'); process.exit(1); }, config.shutdownGraceMs); force.unref();
  try {
    await new Promise((r) => { server.close(r); server.closeIdleConnections?.(); });   // stop accepting; let in-flight requests finish
    await matcher?.stop();                                                             // finishes a running pass, releases the lease so a new instance takes over at once
    await service?.flushMail?.();                                                      // let reset emails already handed to the provider finish
    await db?.close();
    log.info('shutdown complete');
    process.exit(0);
  } catch (e) { log.error('error during shutdown', e); process.exit(1); }
}
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => shutdown(sig));
