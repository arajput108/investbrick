process.env.LOG_LEVEL ??= 'silent';   // keep test output readable; tests that check logging inject their own logger
import { createDb } from '../server/db/index.js';
import { migrate } from '../server/db/migrate.js';
import { createPasswords } from '../server/auth/passwords.js';
import { createMailer } from '../server/auth/mailer.js';
import { createAuthService } from '../server/auth/service.js';
import { createAuth } from '../server/auth/routes.js';
import { createPortfolioService } from '../server/portfolio/service.js';
import { createPortfolioRouter } from '../server/portfolio/routes.js';
import { createApp } from '../server/app.js';

/** Tests always run on PGlite (real Postgres in WASM). Set TEST_PG_URL to ALSO run on a real server. */
export const backends = ['pglite', ...(process.env.TEST_PG_URL ? ['pg'] : [])];

export async function makeDb(kind) {
  let db;
  if (kind === 'pg') {
    const url = process.env.TEST_PG_URL;
    if (!/\/[^/?]*test[^/?]*(\?|$)/i.test(url)) throw new Error('TEST_PG_URL must point at a database whose name contains "test": the tests DROP SCHEMA public.');
    db = await createDb({ driver: 'pg', url });
    await db.exec('drop schema public cascade; create schema public;');
  } else db = await createDb({ driver: 'pglite' });
  await migrate(db);
  return db;
}

/** Controllable price feed shaped like the real market service. */
export function fakeMarket(prices = {}) {
  const st = { prices: { RELIANCE: 1000, TCS: 3000, INFY: 1500, NIFTYBEES: 280, GOLDBEES: 90, BTC: 5000000, ETH: 300000, 'NIFTY 50': 24000, ...prices }, equityOpen: true, stale: false, down: new Set(), throwAll: false, asOfAgeMs: 0, prevClose: {} };
  const quote = (sym) => {
    if (st.down.has(sym) || st.prices[sym] == null) return null;
    const crypto = ['BTC', 'ETH', 'SOL', 'XRP', 'DOGE'].includes(sym);
    const open = crypto || st.equityOpen;
    return { sym, price: st.prices[sym], prevClose: st.prevClose[sym], fetchedAt: new Date().toISOString(), asOf: new Date(Date.now() - st.asOfAgeMs).toISOString(), stale: st.stale, source: 'TestFeed',
      market: { state: open ? 'open' : 'closed', reason: crypto ? '24x7' : open ? 'regular' : 'weekend', label: open ? 'Open' : 'NSE closed (weekend)' } };
  };
  return { st, status: () => ({}), instruments: () => [], candles: async () => ({}),
    quotes: async (syms = []) => { if (st.throwAll) throw new Error('feed down'); const quotes = {}, errors = {}; for (const s of syms) { const q = quote(s); if (q) quotes[s] = q; else errors[s] = 'no data'; } return { quotes, errors }; } };
}

export async function makeStack(db, { market = fakeMarket(), isProd = false, rateLimits, portfolioLimits, snapshotEveryMs, orderTtlDays, now, onOrderOpened } = {}) {
  const config = { isProd, trustProxy: 0, apiLimit: 1e6, appUrl: 'https://investbrick.example', auth: {},
    rateLimits: rateLimits || { loginIp: 1e6, loginAcct: 1e6, register: 1e6, forgot: 1e6, reset: 1e6, change: 1e6 },
    portfolioLimits: portfolioLimits || { general: 1e6, orders: 1e6 } };
  const portfolio = createPortfolioService({ db, market, snapshotEveryMs, orderTtlDays, ...(now ? { now } : {}), ...(onOrderOpened ? { onOrderOpened } : {}) });
  const mailer = createMailer({ provider: 'smtp', from: 'IB <a@b.c>', transport: { sendMail: async () => {} } });
  const service = createAuthService({ db, config, mailer, passwords: createPasswords({ memoryCost: 1024, timeCost: 1 }), onUserCreated: (t, id) => portfolio.ensurePortfolio(t, id) });
  const auth = createAuth({ service, config });
  const portfolioRouter = createPortfolioRouter({ service: portfolio, auth, config });
  const server = createApp({ market, config, auth, portfolioRouter }).listen(0);
  return { db, server, base: `http://127.0.0.1:${server.address().port}`, market, portfolio, service, config, close: () => { server.close(); server.closeAllConnections(); } };
}

/** Browser-like client with a cookie jar. */
export function client(base) {
  let cookie = '';
  const api = async (method, path, body, headers = {}) => {
    const res = await fetch(base + path, { method, redirect: 'manual', headers: { ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...(cookie ? { cookie } : {}), ...headers }, body: body !== undefined ? JSON.stringify(body) : undefined });
    for (const c of res.headers.getSetCookie?.() || []) { const [kv] = c.split(';'); const [k, v] = kv.split('='); cookie = v === '' ? '' : `${k}=${v}`; }
    let json = null; try { json = await res.json(); } catch { /* not json */ }
    return { status: res.status, json };
  };
  return { api, get cookie() { return cookie; }, set cookie(v) { cookie = v; } };
}
let n = 0;
export const uniqEmail = () => `pf${Date.now()}${n++}@example.com`;
export const GOOD = 'Correct-Horse-7battery';
export async function newUser(base, name = 'Asha Rao') {
  const c = client(base); const email = uniqEmail();
  const r = await c.api('POST', '/api/auth/register', { name, email, password: GOOD });
  if (r.status !== 201) throw new Error('register failed ' + JSON.stringify(r.json));
  c.user = r.json.user; return c;
}
export const uuid = () => crypto.randomUUID();
export const order = (o = {}) => ({ clientOrderId: uuid(), symbol: 'RELIANCE', side: 'buy', type: 'market', qty: 1, ...o });

/** Exact accounting identities, evaluated by Postgres numeric. Returns an object of booleans plus the numbers. */
export async function invariants(db, userId) {
  const r = (await db.query(`
    with p as (select * from portfolios where user_id=$1),
    pos as (select coalesce(sum(cost_basis),0) cb, count(*) filter (where qty <= 0) bad from positions where user_id=$1),
    tx as (select coalesce(sum(case when side='buy' then amount else -amount end),0) net,
                  coalesce(sum(realized),0) realized from transactions where user_id=$1 and epoch=(select epoch from p)),
    res as (select coalesce(sum(round(qty*limit_price,2)),0) r from orders where user_id=$1 and status='open' and side='buy')
    select (p.cash >= 0) as cash_ok,
           (p.cash + pos.cb - p.realized_pnl = p.starting_cash) as conserved,        -- cash + open cost - realized == starting cash
           (p.starting_cash - tx.net = p.cash) as cash_matches_ledger,
           (tx.realized = p.realized_pnl) as realized_matches_ledger,
           (pos.bad = 0) as qty_ok,
           (p.cash >= res.r) as reservations_covered,
           p.cash::text as cash, pos.cb::text as cost_basis, p.realized_pnl::text as realized
    from p, pos, tx, res`, [userId])).rows[0];
  const qtyMismatch = (await db.query(`
    select count(*)::int c from (
      select coalesce(t.symbol, x.symbol) s, coalesce(t.q,0) tq, coalesce(x.qty,0) pq from
        (select symbol, sum(case when side='buy' then qty else -qty end) q from transactions where user_id=$1 and epoch=(select epoch from portfolios where user_id=$1) group by symbol) t
        full join (select symbol, qty from positions where user_id=$1) x on x.symbol = t.symbol) z where tq <> pq`, [userId])).rows[0].c;
  return { ...r, qty_matches_ledger: qtyMismatch === 0 };
}
export const allOk = (inv) => ['cash_ok', 'conserved', 'cash_matches_ledger', 'realized_matches_ledger', 'qty_ok', 'reservations_covered', 'qty_matches_ledger'].every((k) => inv[k] === true);
