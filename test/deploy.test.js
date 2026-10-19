import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { backends, makeDb, makeStack, newUser, order, fakeMarket } from './helpers.js';
import { createLogger, scrubString } from '../server/logger.js';
import { createMatcher } from '../server/portfolio/matcher.js';
import { createApp } from '../server/app.js';
import { migrationStatus } from '../server/db/migrate.js';
import { productionProblems } from '../server/config.js';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const capture = () => { const lines = []; return { lines, log: createLogger({ write: (l) => lines.push(JSON.parse(l)), level: 'debug' }) }; };

describe('logging', () => {
  test('secrets and credentials never reach log lines', () => {
    const { lines, log } = capture();
    log.error('db failed postgres://neondb_owner:S3cretPw@ep-x.neon.tech/db?sslmode=require', { password: 'hunter2', cookie: 'ib=abc', nested: { api_key: 'k', DATABASE_URL: 'postgres://u:p@h/d', ok: 'fine' }, err: new Error('connect postgres://u:pw@h:5432/d failed') });
    const text = JSON.stringify(lines);
    for (const bad of ['S3cretPw', 'hunter2', 'ib=abc', 'postgres://u:p@h', ':pw@']) assert.ok(!text.includes(bad), bad);
    assert.equal(lines[0].nested.ok, 'fine'); assert.equal(lines[0].level, 'error'); assert.ok(lines[0].time);
    assert.equal(scrubString('https://user:pass@example.com/x'), 'https://***:***@example.com/x');
  });
  test('level filtering', () => {
    const { lines, log } = capture(); const quiet = createLogger({ write: (l) => lines.push(l), level: 'warn' });
    quiet.info('no'); quiet.warn('yes'); log.debug('x'); assert.equal(lines.filter((l) => typeof l === 'string').length, 1);
  });
});

for (const kind of backends) describe(`deploy readiness on ${kind}`, () => {
  let db, S, cap;
  before(async () => { db = await makeDb(kind); S = await makeStack(db, {}); cap = capture(); });
  after(async () => { S.close(); await db.close(); });

  test('request log lines carry an id, never query strings, cookies or bodies; client request id is honoured only if well-formed', async () => {
    const mk = fakeMarket(); const app = createApp({ market: mk, config: { isProd: false, trustProxy: 0, apiLimit: 1e6 }, log: cap.log }).listen(0);
    const base = `http://127.0.0.1:${app.address().port}`;
    const r = await fetch(`${base}/api/market/status?secret=abc123`, { headers: { cookie: 'ib_session=TOPSECRET', 'x-request-id': 'req-12345678' } });
    assert.equal(r.headers.get('x-request-id'), 'req-12345678');
    const bad = await fetch(`${base}/api/market/status`, { headers: { 'x-request-id': 'bad id with spaces <script>' } });
    assert.match(bad.headers.get('x-request-id'), /^[0-9a-f-]{36}$/);
    await fetch(`${base}/healthz`);
    app.close(); app.closeAllConnections();
    const text = JSON.stringify(cap.lines);
    assert.ok(!text.includes('abc123') && !text.includes('TOPSECRET'));
    const line = cap.lines.find((l) => l.msg === 'request'); assert.equal(line.path, '/api/market/status'); assert.equal(line.status, 200); assert.equal(typeof line.ms, 'number');
    assert.ok(!cap.lines.some((l) => l.path === '/healthz'), 'health checks are not logged');
  });

  test('unexpected errors: logged with request id (credentials scrubbed), generic 500 to the client', async () => {
    const mk = fakeMarket(); mk.quotes = async () => { throw new Error('boom connecting postgres://u:topsecret@db/x'); };
    const c2 = capture(); const app = createApp({ market: mk, config: { isProd: false, trustProxy: 0, apiLimit: 1e6 }, log: c2.log }).listen(0);
    const r = await fetch(`http://127.0.0.1:${app.address().port}/api/market/quotes?symbols=RELIANCE`);
    const body = await r.json(); app.close(); app.closeAllConnections();
    assert.equal(r.status, 500); assert.equal(body.code, 'INTERNAL'); assert.ok(body.requestId);
    assert.ok(!JSON.stringify(body).includes('boom') && !JSON.stringify(body).includes('topsecret'));
    const errLine = c2.lines.find((l) => l.msg === 'unhandled request error');
    assert.equal(errLine.requestId, body.requestId); assert.ok(!JSON.stringify(c2.lines).includes('topsecret'));
  });

  test('/healthz does not touch the database; /readyz does, and reports 503 when it is down or the matcher stalled', async () => {
    let queries = 0; const counting = { ...db, query: (...a) => { queries++; return db.query(...a); } };
    const mk = fakeMarket(); let dbUp = true, mUp = true;
    const ready = async () => { const checks = {}; try { if (!dbUp) throw new Error('x'); await counting.query('select 1'); checks.database = 'ok'; } catch { checks.database = 'unreachable'; } checks.matcher = mUp ? 'ok' : 'stalled'; return { ok: Object.values(checks).every((v) => v === 'ok'), checks }; };
    const app = createApp({ market: mk, config: { isProd: false, trustProxy: 0 }, health: () => ({ matcher: { enabled: true, alive: true } }), ready }).listen(0);
    const base = `http://127.0.0.1:${app.address().port}`;
    for (let i = 0; i < 5; i++) assert.equal((await fetch(base + '/healthz')).status, 200);
    assert.equal(queries, 0);
    assert.equal((await fetch(base + '/readyz')).status, 200); assert.equal(queries, 1);
    dbUp = false; let r = await fetch(base + '/readyz'); assert.equal(r.status, 503); assert.equal((await r.json()).checks.database, 'unreachable');
    dbUp = true; mUp = false; r = await fetch(base + '/readyz'); assert.equal(r.status, 503); assert.equal((await r.json()).checks.matcher, 'stalled');
    app.close(); app.closeAllConnections();
  });

  test('migration status reports nothing pending on a migrated database', async () => {
    const st = await migrationStatus(db); assert.deepEqual(st, { pending: [], unknown: [] });
    await db.query("insert into schema_migrations(name) values ('999_future.sql')");
    assert.deepEqual((await migrationStatus(db)).unknown, ['999_future.sql']);
    await db.query("delete from schema_migrations where name='999_future.sql'");
  });

  test('matcher idle mode: no database traffic while no orders are open; wake() resumes; slow re-check still happens', async () => {
    let n = 0; const counting = { ...db, query: (...a) => { n++; return db.query(...a); } };
    let candidates = 0; const stub = { runMatching: async () => ({ symbols: 0, candidates, filled: 0, deferred: 0, rejected: 0, expired: 0, errors: 0 }) };
    let clock = 1e9; const m = createMatcher({ db: counting, service: stub, intervalMs: 5000, idleRecheckMs: 60000, instance: 'idle-test', now: () => clock });
    await m.tick(); assert.equal(m.status().idle, true);
    const base = n;
    for (let i = 0; i < 10; i++) { clock += 5000; assert.deepEqual(await m.tick(), { skipped: 'idle' }); }
    assert.equal(n, base, 'idle ticks made no database calls');
    candidates = 2; m.wake(); await m.tick(); assert.ok(n > base); assert.equal(m.status().idle, false);
    candidates = 0; await m.tick(); assert.equal(m.status().idle, true);
    const n2 = n; clock += 61000; await m.tick(); assert.ok(n > n2, 'safety re-check ran after the idle window');
    await m.stop();
  });

  test('placing a limit order wakes the matcher hook; marketable orders and duplicates do not', async () => {
    let wakes = 0; const db2 = await makeDb(kind); const S2 = await makeStack(db2, { onOrderOpened: () => { wakes++; } });
    const c = await newUser(S2.base); const lim = order({ type: 'limit', limitPrice: 100 });
    await c.api('POST', '/api/portfolio/orders', lim); assert.equal(wakes, 1);
    await c.api('POST', '/api/portfolio/orders', lim); assert.equal(wakes, 1, 'duplicate submission');
    await c.api('POST', '/api/portfolio/orders', order()); assert.equal(wakes, 1, 'market order fills immediately');
    S2.close(); await db2.close();
  });

  test('FAILOVER: a leader that dies without releasing its lease is replaced after expiry; the standby never runs while the leader is alive; fills stay single', async () => {
    await db.query('delete from engine_leases');
    const c = await newUser(S.base);
    const o = (await c.api('POST', '/api/portfolio/orders', order({ type: 'limit', limitPrice: 950 }))).json.result;
    S.market.st.prices.RELIANCE = 900;
    let aRuns = 0, bRuns = 0;
    const wrap = (cnt) => ({ runMatching: async () => { cnt(); return S.portfolio.runMatching(); } });
    const a = createMatcher({ db, service: wrap(() => aRuns++), intervalMs: 5000, leaseMs: 400, instance: 'A' });
    const b = createMatcher({ db, service: wrap(() => bRuns++), intervalMs: 5000, leaseMs: 400, instance: 'B' });
    await a.tick({ force: true }); await b.tick({ force: true });
    assert.equal(a.status().leader, true); assert.equal(b.status().leader, false);
    assert.equal(aRuns, 1); assert.equal(bRuns, 0);
    assert.equal((await db.query('select status from orders where id=$1', [o.orderId])).rows[0].status, 'filled');
    await sleep(500);                                       // A "crashes": no more ticks, no stop(), lease lapses
    await b.tick({ force: true });
    assert.equal(b.status().leader, true); assert.equal(bRuns, 1);
    await a.tick({ force: true });                          // A "restarts" while B is leader: must stay standby
    assert.equal(a.status().leader, false); assert.equal(aRuns, 1);
    assert.equal((await db.query('select count(*)::int c from transactions where order_id=$1', [o.orderId])).rows[0].c, 1);
    await b.stop();                                         // graceful stop releases the lease immediately
    await a.tick({ force: true }); assert.equal(a.status().leader, true);
    await a.stop(); S.market.st.prices.RELIANCE = 1000;
  });

  test('many matcher instances racing for the lease: exactly one leader, every order filled once', async () => {
    await db.query('delete from engine_leases');
    const c = await newUser(S.base); const ids = [];
    for (let i = 0; i < 6; i++) ids.push((await c.api('POST', '/api/portfolio/orders', order({ type: 'limit', limitPrice: 950 }))).json.result.orderId);
    S.market.st.prices.RELIANCE = 900;
    const ms = [...Array(5)].map((_, i) => createMatcher({ db, service: S.portfolio, intervalMs: 5000, leaseMs: 5000, instance: 'M' + i }));
    await Promise.all(ms.map((m) => m.tick({ force: true })));
    assert.equal(ms.filter((m) => m.status().leader).length, 1);
    for (const id of ids) assert.equal((await db.query('select count(*)::int c from transactions where order_id=$1', [id])).rows[0].c, 1);
    for (const m of ms) await m.stop();
    S.market.st.prices.RELIANCE = 1000;
  });
});

describe('production configuration checks', () => {
  const good = { db: { driver: 'pg', url: 'postgres://u:p@ep-x.neon.tech/db?sslmode=require' }, appUrl: 'https://investbrick.example', email: { provider: 'smtp', smtp: { host: 'smtp.x' } }, trustProxy: 1 };
  test('good config passes; localhost URL and missing sslmode are blocked', () => {
    assert.deepEqual(productionProblems(good), []);
    assert.ok(productionProblems({ ...good, appUrl: 'https://localhost:3000' }).some((p) => /localhost/.test(p)));
    assert.ok(productionProblems({ ...good, db: { driver: 'pg', url: 'postgres://u:p@ep-x.neon.tech/db' } }).some((p) => /sslmode/.test(p)));
    assert.deepEqual(productionProblems({ ...good, db: { driver: 'pg', url: 'postgres://u:p@localhost:5432/db' } }), []);
  });
});

describe('real server process: restart, graceful shutdown, refusing bad production config', () => {
  const freePort = () => new Promise((res) => { const s = net.createServer().listen(0, () => { const p = s.address().port; s.close(() => res(p)); }); });
  function boot(env) {
    const child = spawn(process.execPath, ['server/index.js'], { cwd: root, env: { PATH: process.env.PATH, LOG_LEVEL: 'info', ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
    const out = []; let buf = '';
    child.stdout.on('data', (d) => { buf += d; let i; while ((i = buf.indexOf('\n')) >= 0) { try { out.push(JSON.parse(buf.slice(0, i))); } catch { /* ignore */ } buf = buf.slice(i + 1); } });
    child.stderr.on('data', (d) => out.push({ stderr: String(d) }));
    const exited = new Promise((r) => child.on('exit', (code, sig) => r({ code, sig })));
    const waitFor = async (pred, ms = 30000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { const f = out.find(pred); if (f) return f; await sleep(50); } throw new Error('timeout waiting for log line; got ' + JSON.stringify(out.slice(-5))); };
    return { child, out, exited, waitFor };
  }

  test('state survives a real process restart (session cookie + portfolio), SIGTERM exits 0 after a clean shutdown', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'ib-restart-')); const port = await freePort();
    const env = { PORT: String(port), DB_DRIVER: 'pglite', PGLITE_DIR: dir, MATCHER_INTERVAL_SEC: '5', ARGON_MEMORY_KIB: '1024', ARGON_TIME_COST: '1' };
    const base = `http://127.0.0.1:${port}`;
    let p = boot(env); await p.waitFor((l) => l.msg === 'listening');
    assert.equal((await (await fetch(base + '/healthz')).json()).ok, true);
    const rr = await fetch(base + '/api/auth/register', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'Rita Rao', email: `rita${Date.now()}@example.com`, password: 'Correct-Horse-7battery' }) });
    assert.equal(rr.status, 201);
    const cookie = rr.headers.getSetCookie()[0].split(';')[0];
    const before = await (await fetch(base + '/api/portfolio', { headers: { cookie } })).json();
    assert.equal(before.cash, 1000000);
    p.child.kill('SIGTERM'); const ex = await p.exited;
    assert.equal(ex.code, 0); assert.ok(p.out.some((l) => l.msg === 'shutdown complete'));
    assert.ok(!(await fetch(base + '/healthz').then(() => true, () => false)), 'server is really down');
    p = boot(env); await p.waitFor((l) => l.msg === 'listening');
    const after = await (await fetch(base + '/api/portfolio', { headers: { cookie } })).json();      // SAME cookie, new process
    assert.equal(after.cash, 1000000); assert.deepEqual(after.watchlist, before.watchlist);
    assert.ok(!JSON.stringify(p.out).includes('Correct-Horse'), 'password never logged');
    p.child.kill('SIGTERM'); assert.equal((await p.exited).code, 0);
    rmSync(dir, { recursive: true, force: true });
  });

  test('production start with missing configuration refuses to run and says why (no silent fallback)', async () => {
    const port = await freePort();
    const p = boot({ PORT: String(port), NODE_ENV: 'production', DATABASE_URL: '', APP_URL: 'http://x.com', EMAIL_PROVIDER: 'console' });
    const ex = await p.exited; assert.equal(ex.code, 1);
    const line = p.out.find((l) => /refusing to start/.test(l.msg || '')); assert.ok(line);
    assert.ok(line.problems.some((x) => /DATABASE_URL/.test(x)) && line.problems.some((x) => /APP_URL/.test(x)) && line.problems.some((x) => /TRUST_PROXY/.test(x)));
  });

  test('MIGRATE_ON_START=false refuses to boot on an unmigrated database instead of changing it', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'ib-nomig-')); const port = await freePort();
    const p = boot({ PORT: String(port), DB_DRIVER: 'pglite', PGLITE_DIR: dir, MIGRATE_ON_START: 'false' });
    await p.waitFor((l) => l.msg === 'could not start accounts');
    const line = p.out.find((l) => l.msg === 'could not start accounts'); assert.match(line.err.message, /pending/);
    p.child.kill('SIGTERM'); await p.exited; rmSync(dir, { recursive: true, force: true });
  });
});
