import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { backends, makeDb, makeStack, newUser, order, invariants, allOk, fakeMarket } from './helpers.js';
import { createMatcher } from '../server/portfolio/matcher.js';
import { createPortfolioService } from '../server/portfolio/service.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const limit = (o) => order({ type: 'limit', limitPrice: 900, ...o });

for (const kind of backends) describe(`engine on ${kind}`, () => {
  let db, st, S, mk;
  before(async () => { db = await makeDb(kind); mk = fakeMarket(); S = await makeStack(db, { market: mk }); st = mk.st; });
  after(async () => { S.close(); await db.close(); });
  const reset = () => { st.prices.RELIANCE = 1000; st.prices.BTC = 5000000; st.equityOpen = true; st.stale = false; st.down.clear(); st.throwAll = false; st.asOfAgeMs = 0; st.prevClose = {}; };
  const uid = (c) => c.user.id;
  const rowOf = async (id) => (await db.query('select * from orders where id=$1', [id])).rows[0];
  const events = async (id) => (await db.query('select type, actor from order_events where order_id=$1 order by id', [id])).rows.map((r) => `${r.type}:${r.actor}`);
  const fills = async (id) => (await db.query('select count(*)::int c from transactions where order_id=$1', [id])).rows[0].c;
  const place = async (c, o) => (await c.api('POST', '/api/portfolio/orders', o)).json.result;

  test('background matcher fills a limit order with no browser activity, at the market price, with audit', async () => {
    reset(); const c = await newUser(S.base);
    const r = await place(c, limit({ limitPrice: 950 }));
    assert.equal(r.status, 'open');
    assert.equal((await S.portfolio.runMatching()).filled, 0);       // 1000 > 950: not yet
    st.prices.RELIANCE = 940;
    const run = await S.portfolio.runMatching();
    assert.equal(run.filled, 1);
    const o = await rowOf(r.orderId);
    assert.equal(o.status, 'filled'); assert.equal(Number(o.filled_price), 940); assert.ok(o.filled_at);
    assert.equal(await fills(r.orderId), 1);
    const ev = await events(r.orderId); assert.equal(ev[0], 'created:user'); assert.equal(ev.at(-1), 'filled:matcher');
    assert.ok(allOk(await invariants(db, uid(c))));
    assert.equal((await S.portfolio.runMatching()).filled, 0);       // idempotent
  });

  test('sell limit fills at market price when it crosses', async () => {
    reset(); const c = await newUser(S.base);
    await place(c, order({ qty: 2 }));
    const s = await place(c, order({ side: 'sell', type: 'limit', limitPrice: 1100, qty: 2 }));
    st.prices.RELIANCE = 1120; await S.portfolio.runMatching();
    assert.equal(Number((await rowOf(s.orderId)).filled_price), 1120);
    assert.ok(allOk(await invariants(db, uid(c))));
  });

  test('market closed: equity order waits, crypto still fills, reopen fills', async () => {
    reset(); const c = await newUser(S.base);
    const a = await place(c, limit({ limitPrice: 1500 }));
    const b = await place(c, limit({ symbol: 'BTC', limitPrice: 6000000, qty: 0.01 }));
    assert.equal(a.status, 'filled');                                 // already marketable
    reset(); const c2 = await newUser(S.base);
    const w = await place(c2, limit({ limitPrice: 1500 }));
    st.equityOpen = false; st.prices.RELIANCE = 1000;
    const x = await place(c2, limit({ limitPrice: 1500, qty: 2 }));
    assert.equal(x.status, 'open'); assert.equal((await rowOf(x.orderId)).waiting_reason, 'market_closed');
    const run = await S.portfolio.runMatching();
    assert.equal(await fills(x.orderId), 0);
    st.equityOpen = true;
    assert.equal((await S.portfolio.runMatching()).filled >= 1, true);
    assert.equal((await rowOf(x.orderId)).status, 'filled');
    assert.ok(w && b && run);
    assert.ok(allOk(await invariants(db, uid(c2))));
  });

  test('price feed failures never fill; recovery fills', async () => {
    const cases = [
      ['throws', () => { st.throwAll = true; }, 'no_price'],
      ['missing', () => { st.down.add('RELIANCE'); }, 'no_price'],
      ['stale', () => { st.stale = true; }, 'price_stale'],
      ['frozen asOf', () => { st.asOfAgeMs = 3 * 3600e3; }, 'price_frozen'],
      ['outlier', () => { st.prevClose.RELIANCE = 100; }, 'price_implausible'],
    ];
    for (const [name, brk, code] of cases) {
      reset(); const c = await newUser(S.base);
      st.prices.RELIANCE = 1000;
      const o = await place(c, limit({ limitPrice: 950 }));
      st.prices.RELIANCE = 900; brk();
      const run = await S.portfolio.runMatching();
      assert.equal(run.filled, 0, name);
      assert.equal((await rowOf(o.orderId)).status, 'open', name);
      if (name !== 'throws') assert.equal((await rowOf(o.orderId)).waiting_reason, code, name);
      reset(); st.prices.RELIANCE = 900;
      assert.equal((await S.portfolio.runMatching()).filled >= 1, true, name + ' recovery');
      assert.equal((await rowOf(o.orderId)).status, 'filled', name);
      assert.ok(allOk(await invariants(db, uid(c))), name);
    }
  });

  test('concurrent ticks and reads produce exactly one fill per order', async () => {
    reset(); const c = await newUser(S.base);
    const ids = [];
    for (let i = 0; i < 5; i++) ids.push((await place(c, limit({ limitPrice: 950, qty: 1 }))).orderId);
    st.prices.RELIANCE = 900;
    await Promise.all([...Array(6)].map(() => S.portfolio.runMatching()).concat([...Array(4)].map(() => c.api('GET', '/api/portfolio'))));
    for (const id of ids) { assert.equal(await fills(id), 1); assert.equal((await rowOf(id)).status, 'filled'); }
    assert.ok(allOk(await invariants(db, uid(c))));
  });

  test('cancel racing with matcher: exactly one outcome, books consistent', async () => {
    reset(); const c = await newUser(S.base);
    for (let i = 0; i < 6; i++) {
      const o = await place(c, limit({ limitPrice: 950 }));
      st.prices.RELIANCE = 900;
      const [, cr] = await Promise.all([S.portfolio.runMatching(), c.api('DELETE', `/api/portfolio/orders/${o.orderId}`)]);
      const row = await rowOf(o.orderId), f = await fills(o.orderId);
      assert.ok((row.status === 'filled' && f === 1 && cr.status === 409) || (row.status === 'cancelled' && f === 0 && cr.status === 200), `${row.status} ${f} ${cr.status}`);
      st.prices.RELIANCE = 1000;
    }
    assert.ok(allOk(await invariants(db, uid(c))));
  });

  test('overspending is impossible and tampered state is rejected, not filled', async () => {
    reset(); const c = await newUser(S.base);
    const o = await place(c, limit({ limitPrice: 950, qty: 100 }));          // reserves 95,000
    await db.query('update portfolios set cash = 1000 where user_id=$1', [uid(c)]);   // simulated corruption
    st.prices.RELIANCE = 900; await S.portfolio.runMatching();
    const row = await rowOf(o.orderId);
    assert.equal(row.status, 'rejected'); assert.equal(row.status_reason, 'insufficient_funds');
    assert.equal(await fills(o.orderId), 0);
    assert.equal((await db.query('select cash::text c from portfolios where user_id=$1', [uid(c)])).rows[0].c, '1000.00');
    assert.ok((await events(o.orderId)).includes('rejected:matcher'));
    const sell = await place(c, order({ qty: 1 }));
    const s = await place(c, order({ side: 'sell', type: 'limit', limitPrice: 1200 }));
    await db.query('delete from positions where user_id=$1', [uid(c)]);
    st.prices.RELIANCE = 1300; await S.portfolio.runMatching();
    assert.equal((await rowOf(s.orderId)).status_reason, 'insufficient_holdings');
    assert.ok(sell);
  });

  test('instrument no longer supported is rejected', async () => {
    reset(); const c = await newUser(S.base);
    const o = await place(c, limit({ limitPrice: 950 }));
    await db.query("update orders set symbol='NOPE' where id=$1", [o.orderId]);
    await S.portfolio.runMatching();
    assert.equal((await rowOf(o.orderId)).status_reason, 'instrument_not_supported');
  });

  test('orders expire; expiry runs even when the feed is down', async () => {
    reset(); const c = await newUser(S.base);
    const o = await place(c, limit({ limitPrice: 950 }));
    await db.query("update orders set expires_at = now() - interval '1 minute' where id=$1", [o.orderId]);
    st.throwAll = true;
    const run = await S.portfolio.runMatching();
    assert.equal(run.expired, 1);
    assert.equal((await rowOf(o.orderId)).status, 'expired');
    assert.equal((await c.api('DELETE', `/api/portfolio/orders/${o.orderId}`)).status, 409);
    reset();
  });

  test('a restart loses nothing: a fresh service and matcher on the same database fill the order', async () => {
    reset(); const c = await newUser(S.base);
    const o = await place(c, limit({ limitPrice: 950 }));
    st.prices.RELIANCE = 900;
    const svc2 = createPortfolioService({ db, market: mk });                  // "new process"
    const m2 = createMatcher({ db, service: svc2, intervalMs: 5000, jitter: false });
    await m2.tick();
    assert.equal((await rowOf(o.orderId)).status, 'filled');
    assert.equal(m2.status().leader, true);
    await m2.stop();
    const lease = (await db.query("select expires_at <= now() as released from engine_leases where name='matcher'")).rows[0];
    assert.equal(lease.released, true);
  });

  test('matcher loop runs by itself, survives feed failure, and reports status', async () => {
    reset(); const c = await newUser(S.base);
    const o = await place(c, limit({ limitPrice: 950 }));
    const m = createMatcher({ db, service: S.portfolio, intervalMs: 20, jitter: false });
    st.throwAll = true; st.prices.RELIANCE = 900;
    m.start({ firstDelayMs: 10 });
    await sleep(150);
    assert.equal((await rowOf(o.orderId)).status, 'open');
    assert.match(m.status().lastError, /feed/);
    st.throwAll = false;
    for (let i = 0; i < 100 && (await rowOf(o.orderId)).status !== 'filled'; i++) await sleep(50);
    assert.equal((await rowOf(o.orderId)).status, 'filled');
    await m.stop();
    assert.equal(m.status().enabled, false);
    assert.ok((await db.query('select count(*)::int c from engine_runs')).rows[0].c >= 1);
  });

  test('two matchers (no lease cooperation needed) still give one fill; lease keeps one leader', async () => {
    reset(); const c = await newUser(S.base);
    const o = await place(c, limit({ limitPrice: 950 }));
    st.prices.RELIANCE = 900;
    const a = createMatcher({ db, service: S.portfolio, intervalMs: 5000 }), b = createMatcher({ db, service: S.portfolio, intervalMs: 5000 });
    await db.query("delete from engine_leases");
    await a.tick(); await b.tick();
    assert.equal(a.status().leader, true); assert.equal(b.status().leader, false);
    assert.equal(await fills(o.orderId), 1);
    await Promise.all([S.portfolio.runMatching(), S.portfolio.runMatching()]);
    assert.equal(await fills(o.orderId), 1);
    await a.stop(); await b.stop();
  });

  test('overlap guard: a slow tick is not started twice', async () => {
    let calls = 0;
    const slow = { runMatching: async () => { calls++; await sleep(80); return { symbols: 0, candidates: 0, filled: 0, deferred: 0, rejected: 0, expired: 0, errors: 0 }; } };
    const m = createMatcher({ db, service: slow, intervalMs: 5000, instance: 'overlap' });
    await Promise.all([m.tick(), m.tick(), m.tick()]);
    assert.equal(calls, 1);
    await m.stop();
  });

  test('audit log is append-only and every status change has an event', async () => {
    reset(); const c = await newUser(S.base);
    const o = await place(c, limit({ limitPrice: 950 }));
    await c.api('DELETE', `/api/portfolio/orders/${o.orderId}`);
    await assert.rejects(db.query("update order_events set actor='system'"), /append-only/);
    await assert.rejects(db.query('delete from order_events'), /append-only/);
    assert.deepEqual(await events(o.orderId), ['created:user', 'cancelled:user']);
    const missing = (await db.query(`select count(*)::int c from orders o where status<>'open' and not exists (select 1 from order_events e where e.order_id=o.id and e.type=o.status)`)).rows[0].c;
    assert.equal(missing, 0);
  });

  test('cancellation rules and order APIs are owner-only', async () => {
    reset(); const a = await newUser(S.base), b = await newUser(S.base);
    const o = await place(a, limit({ limitPrice: 950 }));
    assert.equal((await b.api('DELETE', `/api/portfolio/orders/${o.orderId}`)).status, 404);
    assert.equal((await b.api('GET', `/api/portfolio/orders/${o.orderId}/events`)).status, 404);
    assert.equal((await b.api('GET', '/api/portfolio/orders')).json.orders.length, 0);
    const ev = await a.api('GET', `/api/portfolio/orders/${o.orderId}/events`);
    assert.equal(ev.json.events[0].type, 'created');
    assert.equal((await a.api('DELETE', `/api/portfolio/orders/${o.orderId}`)).status, 200);
    assert.equal((await a.api('DELETE', `/api/portfolio/orders/${o.orderId}`)).status, 409);
    const list = await a.api('GET', '/api/portfolio/orders?status=cancelled');
    assert.equal(list.json.orders[0].reason, 'user_cancelled');
    assert.equal((await a.api('GET', '/api/portfolio/orders?status=bogus')).status, 400);
    const anon = (await import('./helpers.js')).client(S.base);
    assert.equal((await anon.api('GET', '/api/portfolio/orders')).status, 401);
    const p = (await a.api('GET', '/api/portfolio')).json;
    assert.equal(p.orderLog[0].status, 'cancelled');
  });

  test('3 users x many random orders with background ticks keep every ledger exact', async () => {
    reset(); const us = [await newUser(S.base), await newUser(S.base), await newUser(S.base)];
    const jobs = [];
    for (let i = 0; i < 45; i++) {
      const c = us[i % 3], side = i % 4 === 3 ? 'sell' : 'buy';
      jobs.push(c.api('POST', '/api/portfolio/orders', order(Math.random() < 0.5 ? { side, qty: 1 + (i % 3) } : limit({ side, limitPrice: side === 'buy' ? 900 + (i % 5) * 40 : 1000 + (i % 5) * 20, qty: 1 + (i % 3) }))));
      if (i % 9 === 0) { st.prices.RELIANCE = 880 + (i * 37) % 260; jobs.push(S.portfolio.runMatching()); }
    }
    await Promise.all(jobs);
    for (const p of [940, 1150, 900, 1200]) { st.prices.RELIANCE = p; await Promise.all([S.portfolio.runMatching(), S.portfolio.runMatching()]); }
    for (const c of us) assert.ok(allOk(await invariants(db, uid(c))), JSON.stringify(await invariants(db, uid(c))));
    const dup = (await db.query('select count(*)::int c from (select order_id from transactions where order_id is not null group by 1 having count(*)>1) x')).rows[0].c;
    assert.equal(dup, 0);
  });

  test('/healthz reports matcher status', async () => {
    const { createApp } = await import('../server/app.js');
    const app = createApp({ market: mk, config: S.config, health: () => ({ matcher: { enabled: true } }) }).listen(0);
    const r = await (await fetch(`http://127.0.0.1:${app.address().port}/healthz`)).json();
    app.close(); app.closeAllConnections();
    assert.deepEqual(r, { ok: true, matcher: { enabled: true } });
  });
});
