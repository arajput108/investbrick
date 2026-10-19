import { describe, test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { migrate } from '../server/db/migrate.js';
import { createAuthService } from '../server/auth/service.js';
import { createPasswords } from '../server/auth/passwords.js';
import { backends, makeDb, makeStack, newUser, client, uuid, order, invariants, allOk, GOOD, uniqEmail } from './helpers.js';

const rnd = (seed) => () => { seed = (seed * 1664525 + 1013904223) % 4294967296; return seed / 4294967296; };

for (const kind of backends) {
  describe(`portfolio on ${kind}`, () => {
    let db, S;
    before(async () => { db = await makeDb(kind); S = await makeStack(db); });
    after(async () => { S.close(); await db.close(); });
    beforeEach(() => { Object.assign(S.market.st, { equityOpen: true, stale: false, prices: { ...S.market.st.prices, RELIANCE: 1000, TCS: 3000, INFY: 1500, BTC: 5000000 } }); S.market.st.down.clear(); });

    const get = async (c) => (await c.api('GET', '/api/portfolio')).json;
    const buy = (c, o = {}) => c.api('POST', '/api/portfolio/orders', order(o));
    const dbCash = async (c) => (await db.query('select cash::text c from portfolios where user_id=$1', [c.user.id])).rows[0].c;

    test('Phase 2 users get a portfolio by backfill, exactly once, and re-running never changes balances', async () => {
      const email = uniqEmail();
      const u = (await db.query("insert into users(email, display_name, password_hash) values ($1,'Old User','x') returning id", [email])).rows[0];
      const sql = (await fs.readFile(new URL('../migrations/002_portfolio.sql', import.meta.url), 'utf8'));
      const backfill = sql.slice(sql.indexOf('with created as'));
      await db.exec(backfill);
      let p = (await db.query('select cash::text c, epoch from portfolios where user_id=$1', [u.id])).rows;
      assert.equal(p.length, 1); assert.equal(p[0].c, '1000000.00');
      assert.equal((await db.query('select count(*)::int c from watchlists where user_id=$1', [u.id])).rows[0].c, 6);
      // simulate activity, then re-run everything that could possibly "reset" a balance
      await db.query("update portfolios set cash = 543210.55 where user_id=$1", [u.id]);
      await db.query("delete from watchlists where user_id=$1 and symbol='BTC'", [u.id]);
      await db.exec(backfill); await migrate(db);
      await Promise.all(Array.from({ length: 8 }, () => db.tx((t) => S.portfolio.ensurePortfolio(t, u.id))));
      p = (await db.query('select cash::text c from portfolios where user_id=$1', [u.id])).rows;
      assert.equal(p.length, 1); assert.equal(p[0].c, '543210.55');
      assert.equal((await db.query('select count(*)::int c from watchlists where user_id=$1', [u.id])).rows[0].c, 5);   // removed star not resurrected
    });

    test('registration creates ₹10,00,000 once, atomically; logging in never resets it', async () => {
      const c = await newUser(S.base);
      let p = await get(c);
      assert.equal(p.cash, 1000000); assert.equal(p.startingCash, 1000000); assert.equal(p.positions.length, 0); assert.equal(p.watchlist.length, 6);
      assert.equal((await db.query('select count(*)::int c from portfolios where user_id=$1', [c.user.id])).rows[0].c, 1);
      assert.equal((await buy(c, { qty: 10 })).status, 200);
      const email = (await db.query('select email from users where id=$1', [c.user.id])).rows[0].email;
      for (let i = 0; i < 3; i++) { const c2 = client(S.base); assert.equal((await c2.api('POST', '/api/auth/login', { email, password: GOOD })).status, 200); await get(c2); }
      p = await get(c); assert.equal(p.cash, 990000); assert.equal(p.positions[0].qty, 10);
      assert.ok(allOk(await invariants(db, c.user.id)));
    });

    test('registration is atomic: if portfolio creation fails, no account is left behind', async () => {
      const svc = createAuthService({ db, config: S.config, mailer: { send: async () => {} }, passwords: createPasswords({ memoryCost: 1024, timeCost: 1 }), onUserCreated: async () => { throw new Error('boom'); } });
      const email = uniqEmail();
      await assert.rejects(svc.register({ email, name: 'X Y', password: GOOD }), /boom/);
      assert.equal((await db.query('select count(*)::int c from users where email=$1', [email])).rows[0].c, 0);
    });

    test('exact money maths: weighted average, partial and full sells, realized P&L', async () => {
      const c = await newUser(S.base); const m = S.market.st.prices;
      m.RELIANCE = 1385.4; assert.equal((await buy(c, { qty: 10 })).status, 200);       // 13854.00
      m.RELIANCE = 1400.1; assert.equal((await buy(c, { qty: 5 })).status, 200);        // 7000.50
      let p = await get(c);
      assert.equal(p.cash, 979145.5); assert.equal(p.positions[0].qty, 15); assert.equal(p.positions[0].costBasis, 20854.5);
      assert.ok(Math.abs(p.positions[0].avgCost - 1390.3) < 1e-9);
      m.RELIANCE = 1500; let r = await buy(c, { side: 'sell', qty: 6 });                // proceeds 9000, cost 8341.80
      assert.equal(r.json.result.realized, 658.2);
      p = r.json.portfolio; assert.equal(p.positions[0].qty, 9); assert.equal(p.positions[0].costBasis, 12512.7);
      m.RELIANCE = 1300; r = await buy(c, { side: 'sell', qty: 9 });                    // proceeds 11700, cost 12512.70
      assert.equal(r.json.result.realized, -812.7);
      p = r.json.portfolio; assert.equal(p.positions.length, 0); assert.equal(p.realizedPnl, -154.5); assert.equal(p.cash, 999845.5);
      assert.equal(p.history.length, 4); assert.equal(p.history[0].side, 'sell');
      const inv = await invariants(db, c.user.id); assert.ok(allOk(inv), JSON.stringify(inv)); assert.equal(inv.cash, '999845.50');
    });

    test('fractional crypto: 6-decimal quantity, exact rounding to paise', async () => {
      const c = await newUser(S.base); S.market.st.prices.BTC = 9640000.37;
      const r = await buy(c, { symbol: 'BTC', qty: '0.012345' });
      assert.equal(r.status, 200); assert.equal(r.json.result.amount, 119005.8);   // 0.012345 x 9640000.37 = 119005.80456765, rounded to paise
      assert.ok(allOk(await invariants(db, c.user.id)));
      assert.equal((await buy(c, { symbol: 'BTC', side: 'sell', qty: '0.012345' })).status, 200);
      assert.equal((await get(c)).positions.length, 0);
      assert.ok(allOk(await invariants(db, c.user.id)));
    });

    test('rejects bad input and impossible trades without changing anything', async () => {
      const c = await newUser(S.base);
      const cases = [
        [{ qty: 0 }, 400], [{ qty: -5 }, 400], [{ qty: 'abc' }, 400], [{ qty: '1e3' }, 400], [{ qty: NaN }, 400], [{ qty: null }, 400], [{ qty: [1] }, 400], [{ qty: {} }, 400],
        [{ qty: 1.5 }, 400], [{ qty: '1.0000001' }, 400], [{ qty: 99999999999 }, 400], [{ symbol: 'BTC', qty: 0.00001 }, 400],
        [{ symbol: 'NOPE' }, 400], [{ symbol: 'NIFTY 50' }, 400], [{ symbol: 123 }, 400], [{ side: 'hold' }, 400], [{ type: 'stop' }, 400],
        [{ type: 'limit', limitPrice: 0 }, 400], [{ type: 'limit', limitPrice: -1 }, 400], [{ type: 'limit' }, 400], [{ type: 'limit', limitPrice: '12.123456' }, 400],
        [{ note: 'x'.repeat(241) }, 400], [{ note: 5 }, 400], [{ clientOrderId: 'not-a-uuid' }, 400], [{ clientOrderId: undefined }, 400],
        [{ qty: 1001 }, 422],            // 1,001 x ₹1,000 > cash
        [{ side: 'sell', qty: 1 }, 422], // nothing held
      ];
      for (const [o, status] of cases) { const r = await buy(c, o); assert.equal(r.status, status, JSON.stringify(o)); assert.ok(r.json.error); }
      const p = await get(c); assert.equal(p.cash, 1000000); assert.equal(p.positions.length, 0); assert.equal(p.history.length, 0);
      assert.ok(allOk(await invariants(db, c.user.id)));
      assert.equal((await buy(c, { qty: 100 })).status, 200);
      const r = await buy(c, { side: 'sell', qty: 101 }); assert.equal(r.status, 422); assert.match(r.json.error, /at most 100/);
      assert.equal((await c.api('POST', '/api/portfolio/orders', 'garbage')).status, 400);
    });

    test('the browser cannot choose the price, the balance or the user', async () => {
      const a = await newUser(S.base, 'Alice A'), b = await newUser(S.base, 'Bob B');
      const r = await a.api('POST', '/api/portfolio/orders', order({ qty: 10, price: 1, fillPrice: 1, amount: 1, cash: 1e12, userId: b.user.id, user_id: b.user.id, startingCash: 5 }));
      assert.equal(r.status, 200); assert.equal(r.json.result.price, 1000); assert.equal(r.json.portfolio.cash, 990000);
      assert.equal((await get(b)).cash, 1000000); assert.equal((await get(b)).history.length, 0);
      assert.equal((await a.api('GET', '/api/portfolio?userId=' + b.user.id)).json.history.length, 1);
      assert.equal((await a.api('PUT', '/api/portfolio/learning', { completed: { 'm-1': true }, userId: b.user.id })).status, 200);
      assert.deepEqual((await get(b)).learning, {});
    });

    test('market closed, stale or missing prices: market orders refused, nothing changes', async () => {
      const c = await newUser(S.base); const st = S.market.st;
      st.equityOpen = false; let r = await buy(c, { qty: 1 }); assert.equal(r.status, 409); assert.match(r.json.error, /closed/i);
      st.equityOpen = true; st.stale = true; r = await buy(c, { qty: 1 }); assert.equal(r.status, 409); assert.match(r.json.error, /out of date/);
      st.stale = false; st.down.add('RELIANCE'); r = await buy(c, { qty: 1 }); assert.equal(r.status, 409); assert.match(r.json.error, /No market price/);
      st.down.clear(); st.equityOpen = false;
      assert.equal((await buy(c, { symbol: 'BTC', qty: 0.01 })).status, 200);   // crypto trades 24x7
      assert.equal((await get(c)).history.length, 1);
      assert.ok(allOk(await invariants(db, c.user.id)));
    });

    test('limit orders: reserve cash, cannot double-book, fill from server prices on read, cancel releases', async () => {
      const c = await newUser(S.base); const m = S.market.st.prices;
      let r = await buy(c, { type: 'limit', limitPrice: 900, qty: 600 });             // reserves 540,000
      assert.equal(r.status, 200); assert.equal(r.json.result.status, 'open');
      assert.equal(r.json.portfolio.reserved, 540000); assert.equal(r.json.portfolio.available, 460000);
      r = await buy(c, { type: 'limit', limitPrice: 900, qty: 600 });                 // would need another 540,000
      assert.equal(r.status, 422); assert.match(r.json.error, /Not enough cash/);
      r = await buy(c, { qty: 500 });                                                 // market buy 500,000 > available 460,000
      assert.equal(r.status, 422);
      let p = await get(c); assert.equal(p.orders.length, 1); assert.equal(p.cash, 1000000);
      m.RELIANCE = 880;                                                                // price falls below the limit
      p = await get(c);                                                                // reading settles the order at the market price
      assert.equal(p.orders.length, 0); assert.equal(p.positions[0].qty, 600); assert.equal(p.cash, 1000000 - 528000);
      assert.equal(p.history[0].price, 880); assert.equal(p.history[0].kind, 'Limit'); assert.equal(p.reserved, 0);
      assert.ok(allOk(await invariants(db, c.user.id)));
      // sell limit and cancel
      m.RELIANCE = 1000;
      r = await buy(c, { side: 'sell', type: 'limit', limitPrice: 1200, qty: 400 }); assert.equal(r.json.result.status, 'open');
      assert.equal((await buy(c, { side: 'sell', qty: 201 })).status, 422);            // only 200 unreserved
      const id = r.json.portfolio.orders[0].id;
      r = await c.api('DELETE', '/api/portfolio/orders/' + id); assert.equal(r.status, 200); assert.equal(r.json.portfolio.orders.length, 0);
      assert.equal((await c.api('DELETE', '/api/portfolio/orders/' + id)).status, 409);
      assert.equal((await c.api('DELETE', '/api/portfolio/orders/' + uuid())).status, 404);
      assert.equal((await c.api('DELETE', '/api/portfolio/orders/nope')).status, 400);
      assert.equal((await buy(c, { side: 'sell', qty: 600 })).status, 200);            // reservation released
      assert.ok(allOk(await invariants(db, c.user.id)));
    });

    test('a marketable limit order fills at the market price, not the limit; closed market queues it', async () => {
      const c = await newUser(S.base);
      let r = await buy(c, { type: 'limit', limitPrice: 1100, qty: 10 });
      assert.equal(r.json.result.status, 'filled'); assert.equal(r.json.result.price, 1000); assert.equal(r.json.portfolio.cash, 990000);
      S.market.st.equityOpen = false;
      r = await buy(c, { type: 'limit', limitPrice: 1100, qty: 10 }); assert.equal(r.json.result.status, 'open');
      assert.equal((await get(c)).orders.length, 1);                                   // not filled while closed
      S.market.st.equityOpen = true;
      const p = await get(c); assert.equal(p.orders.length, 0); assert.equal(p.positions[0].qty, 20);
      assert.ok(allOk(await invariants(db, c.user.id)));
    });

    test('duplicate submissions (retries, double clicks) trade once', async () => {
      const c = await newUser(S.base); const o = order({ qty: 10 });
      const rs = await Promise.all(Array.from({ length: 6 }, () => c.api('POST', '/api/portfolio/orders', o)));
      assert.ok(rs.every((r) => r.status === 200)); assert.equal(new Set(rs.map((r) => r.json.result.transactionId)).size, 1);
      const again = await c.api('POST', '/api/portfolio/orders', o); assert.equal(again.json.result.duplicate, true);
      const p = await get(c); assert.equal(p.history.length, 1); assert.equal(p.cash, 990000); assert.equal(p.positions[0].qty, 10);
      assert.ok(allOk(await invariants(db, c.user.id)));
    });

    test('CONCURRENCY: 20 simultaneous buys against limited cash: exactly 10 succeed, cash ends at exactly 0, never negative', async () => {
      const c = await newUser(S.base);
      const rs = await Promise.all(Array.from({ length: 20 }, () => buy(c, { qty: 100 })));       // 100 x 1000 = 100,000 each
      assert.equal(rs.filter((r) => r.status === 200).length, 10);
      assert.equal(rs.filter((r) => r.status === 422).length, 10);
      const p = await get(c); assert.equal(p.cash, 0); assert.equal(p.positions[0].qty, 1000); assert.equal(p.history.length, 10);
      const inv = await invariants(db, c.user.id); assert.ok(allOk(inv), JSON.stringify(inv));
    });

    test('CONCURRENCY: simultaneous sells cannot sell more than is held', async () => {
      const c = await newUser(S.base); await buy(c, { qty: 100 });
      const rs = await Promise.all(Array.from({ length: 10 }, () => buy(c, { side: 'sell', qty: 30 })));
      assert.equal(rs.filter((r) => r.status === 200).length, 3);
      const p = await get(c); assert.equal(p.positions[0].qty, 10); assert.ok(allOk(await invariants(db, c.user.id)));
    });

    test('CONCURRENCY: mixed random orders, limits, cancels and reads across 3 users keep every ledger exact', async () => {
      const users = [await newUser(S.base, 'U One'), await newUser(S.base, 'U Two'), await newUser(S.base, 'U Three')];
      const R = rnd(42), syms = ['RELIANCE', 'TCS', 'INFY'], ops = [];
      for (let i = 0; i < 90; i++) {
        const c = users[Math.floor(R() * 3)], sym = syms[Math.floor(R() * 3)], k = R();
        const px = S.market.st.prices[sym];
        ops.push(async () => {
          if (k < 0.45) return buy(c, { symbol: sym, qty: 1 + Math.floor(R() * 200) });
          if (k < 0.7) return buy(c, { symbol: sym, side: 'sell', qty: 1 + Math.floor(R() * 120) });
          if (k < 0.85) return buy(c, { symbol: sym, side: R() < 0.5 ? 'buy' : 'sell', type: 'limit', limitPrice: (px * (0.9 + R() * 0.2)).toFixed(2), qty: 1 + Math.floor(R() * 80) });
          if (k < 0.93) { const p = await get(c); return p.orders[0] ? c.api('DELETE', '/api/portfolio/orders/' + p.orders[0].id) : p; }
          S.market.st.prices[sym] = Math.round(px * (0.97 + R() * 0.06)); return get(c);
        });
      }
      const res = await Promise.all(ops.map((f) => f()));
      assert.ok(res.every((r) => (r.status ?? 200) < 500), 'no server errors');
      for (const c of users) { await get(c); const inv = await invariants(db, c.user.id); assert.ok(allOk(inv), `${c.user.name}: ${JSON.stringify(inv)}`); }
    });

    test('ISOLATION: users never see or touch each other; unauthenticated access is refused', async () => {
      const a = await newUser(S.base, 'Alice A'), b = await newUser(S.base, 'Bob B'), g = client(S.base);
      await buy(a, { qty: 10 }); const lim = await buy(a, { type: 'limit', limitPrice: 500, qty: 5 });
      assert.equal((await get(b)).positions.length, 0); assert.equal((await get(b)).orders.length, 0);
      const orderId = lim.json.portfolio.orders[0].id;
      const steal = await b.api('DELETE', '/api/portfolio/orders/' + orderId); assert.equal(steal.status, 404);
      assert.equal((await get(a)).orders.length, 1);                                  // still there
      await a.api('DELETE', '/api/portfolio/watchlist/TCS'); assert.ok((await get(b)).watchlist.includes('TCS'));
      for (const [m, path] of [['GET', '/api/portfolio'], ['GET', '/api/portfolio/history'], ['POST', '/api/portfolio/orders'], ['DELETE', '/api/portfolio/orders/' + orderId], ['PUT', '/api/portfolio/watchlist/TCS'], ['POST', '/api/portfolio/reset'], ['POST', '/api/portfolio/basket']]) {
        assert.equal((await g.api(m, path, m === 'POST' ? order() : undefined)).status, 401, m + path);
      }
      const bogus = client(S.base); bogus.cookie = 'ib_session=' + 'A'.repeat(43); assert.equal((await bogus.api('GET', '/api/portfolio')).status, 401);
      assert.equal((await a.api('POST', '/api/portfolio/orders', order(), { origin: 'https://evil.example' })).status, 403);   // CSRF guard
      assert.equal((await a.api('POST', '/api/portfolio/reset', { confirm: 'RESET' }, { 'sec-fetch-site': 'cross-site' })).status, 403);
      assert.ok(allOk(await invariants(db, a.user.id)) && allOk(await invariants(db, b.user.id)));
    });

    test('RELOAD / NEW DEVICE / SERVER RESTART: the same portfolio comes back', async () => {
      const c = await newUser(S.base); await buy(c, { qty: 10 }); await buy(c, { symbol: 'TCS', qty: 3 }); await buy(c, { type: 'limit', limitPrice: 400, qty: 2 });
      await c.api('DELETE', '/api/portfolio/watchlist/BTC'); await c.api('PUT', '/api/portfolio/learning', { completed: { 'basics-0': true, 'v-abc': true } });
      const before = await get(c); delete before.serverTime;
      const email = (await db.query('select email from users where id=$1', [c.user.id])).rows[0].email;
      const phone = client(S.base); await phone.api('POST', '/api/auth/login', { email, password: GOOD });   // another device
      const onPhone = await get(phone); delete onPhone.serverTime; assert.deepEqual(onPhone, before);
      await c.api('POST', '/api/auth/logout', {}); assert.equal((await c.api('GET', '/api/portfolio')).status, 401);
      await c.api('POST', '/api/auth/login', { email, password: GOOD });
      const again = await get(c); delete again.serverTime; assert.deepEqual(again, before);
      const S2 = await makeStackOn(db, S.market);                                                          // "restart": brand-new app on the same database
      const c3 = client(S2.base); await c3.api('POST', '/api/auth/login', { email, password: GOOD });
      const afterRestart = await get(c3); delete afterRestart.serverTime; assert.deepEqual(afterRestart, before); S2.close();
    });

    test('watchlist: add, remove, idempotent, validated, per-user', async () => {
      const c = await newUser(S.base);
      assert.equal((await c.api('PUT', '/api/portfolio/watchlist/INFY')).json.portfolio.watchlist.filter((s) => s === 'INFY').length, 1);
      assert.equal((await c.api('PUT', '/api/portfolio/watchlist/INFY')).status, 200);
      assert.equal((await get(c)).watchlist.filter((s) => s === 'INFY').length, 1);
      assert.ok((await c.api('PUT', '/api/portfolio/watchlist/NIFTY%2050')).json.portfolio.watchlist.includes('NIFTY 50'));
      assert.equal((await c.api('PUT', '/api/portfolio/watchlist/NOPE')).status, 400);
      assert.equal((await c.api('DELETE', '/api/portfolio/watchlist/INFY')).json.portfolio.watchlist.includes('INFY'), false);
      assert.equal((await c.api('DELETE', '/api/portfolio/watchlist/INFY')).status, 200);
    });

    test('learning progress merges, never deletes, and rejects junk', async () => {
      const c = await newUser(S.base);
      await c.api('PUT', '/api/portfolio/learning', { completed: { 'a-1': true } });
      const r = await c.api('PUT', '/api/portfolio/learning', { completed: { 'b-2': true } });
      assert.deepEqual(r.json.portfolio.learning, { 'a-1': true, 'b-2': true });
      for (const bad of [{ completed: { 'A B': true } }, { completed: { x: false } }, { completed: { x: 'yes' } }, { completed: [] }, { completed: 'x' }, { completed: { '__proto__': true, '../x': true } },
        { completed: Object.fromEntries(Array.from({ length: 201 }, (_, i) => ['k' + i, true])) }]) assert.equal((await c.api('PUT', '/api/portfolio/learning', bad)).status, 400, JSON.stringify(bad).slice(0, 40));
      assert.deepEqual((await get(c)).learning, { 'a-1': true, 'b-2': true });
    });

    test('guest import: one time, merge-only, non-financial only; money fields are ignored', async () => {
      const c = await newUser(S.base);
      assert.equal((await get(c)).guestImportPending, true);
      const r = await c.api('POST', '/api/portfolio/import-guest', { watchlist: ['INFY', 'INFY', 'GOLDBEES', 'TCS'], completed: { 'x-1': true }, cash: 99999999, positions: { RELIANCE: { qty: 1e6, avg: 1 } }, history: [{ symbol: 'TCS' }] });
      assert.equal(r.status, 200); assert.equal(r.json.result.watchlistAdded, 2);
      const p = r.json.portfolio; assert.equal(p.cash, 1000000); assert.equal(p.positions.length, 0); assert.equal(p.history.length, 0);
      assert.equal(p.watchlist.filter((s) => s === 'TCS').length, 1); assert.deepEqual(p.learning, { 'x-1': true }); assert.equal(p.guestImportPending, false);
      assert.equal((await c.api('POST', '/api/portfolio/import-guest', { watchlist: ['BTC'] })).status, 409);       // not twice
      const d = await newUser(S.base); assert.equal((await d.api('POST', '/api/portfolio/import-guest', { watchlist: ['NOPE'] })).status, 400);
      assert.equal((await get(d)).guestImportPending, true);                                                         // a rejected import consumes nothing
      assert.equal((await d.api('POST', '/api/portfolio/import-guest/dismiss', {})).json.portfolio.guestImportPending, false);
      assert.ok(allOk(await invariants(db, c.user.id)));
    });

    test('reset needs explicit confirmation, restores cash, archives (not deletes) history, and starts a new epoch', async () => {
      const c = await newUser(S.base); await buy(c, { qty: 10 }); await buy(c, { type: 'limit', limitPrice: 100, qty: 1 });
      assert.equal((await c.api('POST', '/api/portfolio/reset', {})).status, 400);
      assert.equal((await c.api('POST', '/api/portfolio/reset', { confirm: 'yes' })).status, 400);
      assert.equal((await get(c)).positions.length, 1);
      const r = await c.api('POST', '/api/portfolio/reset', { confirm: 'RESET' }); assert.equal(r.status, 200);
      const p = r.json.portfolio; assert.equal(p.cash, 1000000); assert.equal(p.positions.length, 0); assert.equal(p.orders.length, 0); assert.equal(p.history.length, 0); assert.equal(p.epoch, 2); assert.equal(p.realizedPnl, 0);
      assert.equal((await db.query('select count(*)::int c from transactions where user_id=$1', [c.user.id])).rows[0].c, 1);   // archived, still stored
      assert.equal((await db.query("select count(*)::int c from orders where user_id=$1 and status='cancelled'", [c.user.id])).rows[0].c, 1);
      await buy(c, { qty: 5 }); assert.ok(allOk(await invariants(db, c.user.id)));
    });

    test('baskets: all-or-nothing, server prices, idempotent', async () => {
      const c = await newUser(S.base);
      const items = [{ symbol: 'NIFTYBEES', qty: 100 }, { symbol: 'GOLDBEES', qty: 50 }];
      const o = { clientOrderId: uuid(), name: 'Core and gold', items };
      const r = await c.api('POST', '/api/portfolio/basket', o); assert.equal(r.status, 200);
      assert.equal(r.json.portfolio.cash, 1000000 - 28000 - 4500); assert.equal(r.json.portfolio.history.filter((h) => h.kind === 'Basket').length, 2);
      assert.equal((await c.api('POST', '/api/portfolio/basket', o)).json.result.duplicate, true); assert.equal((await get(c)).history.length, 2);
      const tooBig = { clientOrderId: uuid(), name: 'Huge', items: [{ symbol: 'NIFTYBEES', qty: 10 }, { symbol: 'RELIANCE', qty: 5000 }] };
      const bad = await c.api('POST', '/api/portfolio/basket', tooBig); assert.equal(bad.status, 422);
      assert.equal((await get(c)).history.length, 2); assert.equal((await get(c)).positions.find((p) => p.symbol === 'NIFTYBEES').qty, 100);   // nothing partially bought
      for (const b of [{ ...o, clientOrderId: uuid(), items: [] }, { ...o, clientOrderId: uuid(), name: '' }, { ...o, clientOrderId: uuid(), items: [{ symbol: 'NIFTY 50', qty: 1 }] }, { ...o, clientOrderId: uuid(), items: [{ symbol: 'TCS', qty: 1 }, { symbol: 'TCS', qty: 1 }] }])
        assert.equal((await c.api('POST', '/api/portfolio/basket', b)).status, 400);
      S.market.st.equityOpen = false;
      assert.equal((await c.api('POST', '/api/portfolio/basket', { ...o, clientOrderId: uuid() })).status, 409);
      assert.ok(allOk(await invariants(db, c.user.id)));
    });

    test('portfolio history is recorded per user and values holdings at server prices', async () => {
      const c = await newUser(S.base); const other = await newUser(S.base, 'Other O');
      await buy(c, { qty: 10 }); S.market.st.prices.RELIANCE = 1100;
      await S.portfolio.snapshot(c.user.id);
      const h = (await c.api('GET', '/api/portfolio/history')).json.points;
      assert.ok(h.length >= 3); const last = h[h.length - 1];
      assert.equal(last.cash, 990000); assert.equal(last.holdings, 11000); assert.equal(last.total, 1001000); assert.equal(last.partial, false);
      S.market.st.down.add('RELIANCE'); await S.portfolio.snapshot(c.user.id);
      const h2 = (await c.api('GET', '/api/portfolio/history')).json.points; assert.equal(h2[h2.length - 1].partial, true); assert.equal(h2[h2.length - 1].holdings, 10000);
      assert.equal((await other.api('GET', '/api/portfolio/history')).json.points.length, 1);
    });

    test('the database itself refuses negative cash and non-positive quantities', async () => {
      const c = await newUser(S.base);
      await assert.rejects(db.query('update portfolios set cash = -0.01 where user_id=$1', [c.user.id]), /check|constraint|violat/i);
      await assert.rejects(db.query("insert into positions(user_id, symbol, qty, cost_basis) values ($1,'TCS',0,0)", [c.user.id]), /check|constraint|violat/i);
      await assert.rejects(db.query("insert into portfolios(user_id, cash) values ($1, 1)", [c.user.id]), /duplicate|unique|primary/i);
      assert.equal((await get(c)).cash, 1000000);
    });

    test('input and rate limits: per-user order limiter returns 429', async () => {
      const S2 = await makeStack(db, { market: S.market, portfolioLimits: { general: 1000, orders: 3 } });
      const c = await newUser(S2.base); const rs = [];
      for (let i = 0; i < 6; i++) rs.push(await c.api('POST', '/api/portfolio/orders', order({ qty: 1 })));
      assert.equal(rs.filter((r) => r.status === 429).length, 3); S2.close();
    });
  });
}

async function makeStackOn(db, market) { return makeStack(db, { market }); }
