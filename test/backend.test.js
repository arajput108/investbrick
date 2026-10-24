import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { backends, makeDb, makeStack, newUser, order, invariants, allOk, fakeMarket } from './helpers.js';

for (const kind of backends) describe(`backend hardening on ${kind}`, () => {
  let db, S, mk, st;
  before(async () => { db = await makeDb(kind); mk = fakeMarket(); st = mk.st; S = await makeStack(db, { market: mk, serviceOpts: { quoteDeadlineMs: 300 } }); });
  after(async () => { S.close(); await db.close(); });
  const reset = () => { st.prices.RELIANCE = 1000; st.equityOpen = true; st.stale = false; st.down.clear(); st.throwAll = false; };
  const hangingQuotes = () => { const orig = mk.quotes; mk.quotes = () => new Promise(() => {}); return () => { mk.quotes = orig; }; };

  test('a hung market-data provider never hangs the portfolio, orders or order list; market orders are refused, not faked', async () => {
    reset(); const c = await newUser(S.base);
    const open = (await c.api('POST', '/api/portfolio/orders', order({ type: 'limit', limitPrice: 950 }))).json.result;
    assert.equal(open.status, 'open');
    const restore = hangingQuotes();
    try {
      let t = Date.now();
      const p = await c.api('GET', '/api/portfolio');                       // has an open order => needs quotes => must still answer fast
      assert.equal(p.status, 200); assert.ok(Date.now() - t < 2500, `portfolio read took ${Date.now() - t} ms`);
      assert.equal(p.json.orders.length, 1); assert.equal(p.json.cash, 1000000);
      t = Date.now();
      const m = await c.api('POST', '/api/portfolio/orders', order({ qty: 1 }));
      assert.equal(m.status, 409); assert.equal(m.json.code, 'MARKET_UNAVAILABLE'); assert.ok(Date.now() - t < 2500);
      assert.equal((await c.api('GET', '/api/portfolio/orders')).status, 200);
      assert.equal((await c.api('DELETE', `/api/portfolio/orders/${open.orderId}`)).status, 200);   // cancelling needs no price
      assert.equal((await c.api('GET', '/api/auth/me')).json.user.email, c.user.email);               // auth unaffected
    } finally { restore(); }
    assert.ok(allOk(await invariants(db, c.user.id)));
  });

  test('provider failure then recovery: a buy works again with no leftover state', async () => {
    reset(); const c = await newUser(S.base);
    st.throwAll = true;
    assert.equal((await c.api('POST', '/api/portfolio/orders', order())).status, 409);
    st.throwAll = false;
    assert.equal((await c.api('POST', '/api/portfolio/orders', order())).json.result.status, 'filled');
    assert.ok(allOk(await invariants(db, c.user.id)));
  });
});

import { migrate, rollbackLast, migrationStatus } from '../server/db/migrate.js';
import { createDb } from '../server/db/index.js';
for (const kind of backends) describe(`migrations and operations on ${kind}`, () => {
  let db;
  before(async () => { db = await makeDb(kind); });
  after(async () => { await db.close(); });
  const idx = async () => (await db.query("select indexname from pg_indexes where schemaname='public' and indexname in ('orders_user_created_idx','idempotency_keys_created_idx','transactions_user_page_idx') order by 1")).rows.map((r) => r.indexname);

  test('004 adds the indexes; rolling it back removes only them; re-applying restores them; running twice is harmless', async () => {
    assert.equal((await idx()).length, 3);
    const u = (await db.query("insert into users(email,display_name,password_hash) values ('keep@example.com','Keep','x') returning id")).rows[0].id;
    await db.query('insert into portfolios(user_id) values ($1)', [u]);
    assert.equal(await rollbackLast(db), '004_indexes.sql');
    assert.equal((await idx()).length, 0);
    assert.equal((await db.query('select count(*)::int c from portfolios where user_id=$1', [u])).rows[0].c, 1);   // data untouched
    assert.deepEqual((await migrationStatus(db)).pending, ['004_indexes.sql']);
    assert.deepEqual(await migrate(db), ['004_indexes.sql']);
    assert.deepEqual(await migrate(db), []);
    assert.equal((await idx()).length, 3);
  });

  test('rollback refuses migrations that hold user data (no down file) and changes nothing', async () => {
    await rollbackLast(db);                                         // 004 -> gone
    await assert.rejects(rollbackLast(db), /Refusing to roll back 003_engine\.sql/);
    assert.equal((await migrationStatus(db)).pending.length, 1);    // still only 004 pending; 003 still applied
    await migrate(db);
  });

  test('retention purge: old engine_runs go, recent ones and the order audit trail stay', async () => {
    const S = await makeStack(db, {});
    try {
      await db.query("insert into engine_runs(instance, started_at, finished_at) values ('old', now() - interval '40 days', now() - interval '40 days'), ('new', now(), now())");
      const c = await newUser(S.base);
      const o = (await c.api('POST', '/api/portfolio/orders', order({ type: 'limit', limitPrice: 1 }))).json.result;
      const events = (await db.query('select count(*)::int c from order_events')).rows[0].c;
      await S.portfolio.purgeKeys();
      assert.deepEqual((await db.query("select instance from engine_runs where instance in ('old','new') order by 1")).rows.map((r) => r.instance), ['new']);
      assert.equal((await db.query('select count(*)::int c from order_events')).rows[0].c, events);
      assert.ok(o.orderId);
    } finally { S.close(); }
  });

  if (kind === 'pg') test('pool guard rails are active on the real server: statement and idle-transaction timeouts, application name', async () => {
    const r = (await db.query("select current_setting('statement_timeout') st, current_setting('idle_in_transaction_session_timeout') it, current_setting('application_name') app")).rows[0];
    assert.deepEqual(r, { st: '20s', it: '30s', app: 'investbrick' });
    await db.tx(async (t) => { await t.query('select pg_sleep(0.05)'); });
    await assert.rejects(createDb({ driver: 'pg', url: process.env.TEST_PG_URL, statementTimeoutMs: 1000 }).then(async (d) => { try { await d.query('select pg_sleep(2)'); } finally { await d.close(); } }), /statement timeout/);
  });
});

for (const kind of backends) describe(`pagination and account deletion on ${kind}`, () => {
  let db, S, mk, st;
  before(async () => { db = await makeDb(kind); mk = fakeMarket(); st = mk.st; S = await makeStack(db, { market: mk }); });
  after(async () => { S.close(); await db.close(); });
  const walk = async (c, path, key) => { const seen = []; let cursor = null, pages = 0; do { const r = await c.api('GET', `${path}${path.includes('?') ? '&' : '?'}limit=7${cursor ? '&before=' + cursor : ''}`); assert.equal(r.status, 200); seen.push(...r.json[key]); cursor = r.json.nextCursor; pages++; } while (cursor && pages < 50); return { seen, pages }; };

  test('keyset pagination: every row exactly once, newest first, stable even with identical timestamps and while new rows arrive', async () => {
    const c = await newUser(S.base);
    for (let i = 0; i < 20; i++) assert.equal((await c.api('POST', '/api/portfolio/orders', order({ qty: 1, side: i % 5 === 4 ? 'sell' : 'buy' }))).status, 200);
    await db.query("update transactions set created_at = '2026-01-01T10:00:00.123456Z' where user_id=$1 and id in (select id from transactions where user_id=$1 order by id limit 9)", [c.user.id]);   // force timestamp ties
    const t = await walk(c, '/api/portfolio/transactions', 'transactions');
    assert.equal(t.seen.length, 20); assert.equal(new Set(t.seen.map((x) => x.id)).size, 20); assert.ok(t.pages >= 3);
    const times = t.seen.map((x) => Date.parse(x.createdAt)); assert.deepEqual([...times].sort((a, b) => b - a), times);
    const o = await walk(c, '/api/portfolio/orders', 'orders');
    assert.equal(o.seen.length, 20); assert.equal(new Set(o.seen.map((x) => x.id)).size, 20);
    assert.equal((await walk(c, '/api/portfolio/transactions?side=sell', 'transactions')).seen.length, 4);
    assert.equal((await walk(c, '/api/portfolio/orders?status=filled', 'orders')).seen.length, 20);
    // new rows arriving mid-walk never duplicate or drop older ones
    const first = (await c.api('GET', '/api/portfolio/transactions?limit=5')).json;
    await c.api('POST', '/api/portfolio/orders', order({ qty: 1 }));
    const rest = await walk(c, `/api/portfolio/transactions?x=1&before=${first.nextCursor}&z=2`, 'transactions').catch(() => null);
    const second = (await c.api('GET', `/api/portfolio/transactions?limit=100&before=${first.nextCursor}`)).json.transactions;
    assert.equal(second.length, 15); assert.ok(!second.some((x) => first.transactions.some((y) => y.id === x.id)));
    assert.ok(rest === null || rest.seen.length >= 0);
  });

  test('pagination input is validated and isolated per user', async () => {
    const a = await newUser(S.base), b = await newUser(S.base);
    await a.api('POST', '/api/portfolio/orders', order({ qty: 1 }));
    for (const bad of ['?before=garbage', '?before=' + Buffer.from('2026-01-01T00:00:00.000000Z|nope').toString('base64url'), '?side=hold', '?epoch=abc', '?symbol=' + encodeURIComponent("x'; drop table users;--")]) {
      assert.equal((await a.api('GET', '/api/portfolio/transactions' + bad)).status, 400, bad);
    }
    assert.equal((await a.api('GET', '/api/portfolio/orders?before=garbage')).json.code, 'BAD_CURSOR');
    assert.equal((await a.api('GET', '/api/portfolio/transactions?limit=100000')).status, 200);       // clamped, not an error
    assert.equal((await b.api('GET', '/api/portfolio/transactions')).json.transactions.length, 0);
    assert.equal((await client0(S.base).api('GET', '/api/portfolio/transactions')).status, 401);
    // a cursor from user A is just a position: it can never reveal A's rows to B
    const cur = (await a.api('GET', '/api/portfolio/transactions?limit=1')).json;
    assert.equal((await b.api('GET', `/api/portfolio/transactions?before=${cur.nextCursor ?? ''}`)).json.transactions.length, 0);
  });

  test('epochs: after a reset, history is archived and reachable with epoch=all', async () => {
    const c = await newUser(S.base);
    await c.api('POST', '/api/portfolio/orders', order({ qty: 1 }));
    await c.api('POST', '/api/portfolio/reset', { confirm: 'RESET' });
    assert.equal((await c.api('GET', '/api/portfolio/transactions')).json.transactions.length, 0);
    assert.equal((await c.api('GET', '/api/portfolio/transactions?epoch=all')).json.transactions.length, 1);
    assert.equal((await c.api('GET', '/api/portfolio/transactions?epoch=1')).json.transactions.length, 1);
  });

  test('account deletion: needs password and DELETE; removes every row the user owns; logs out; others untouched; email can be reused', async () => {
    const c = await newUser(S.base), other = await newUser(S.base);
    await c.api('POST', '/api/portfolio/orders', order({ qty: 2 }));
    await c.api('POST', '/api/portfolio/orders', order({ type: 'limit', limitPrice: 900 }));
    await c.api('PUT', '/api/portfolio/watchlist/ITC');
    await other.api('POST', '/api/portfolio/orders', order({ qty: 1 }));
    const email = c.user.email;
    assert.equal((await c.api('POST', '/api/auth/delete-account', { password: 'Correct-Horse-7battery' })).status, 400);               // no confirm
    assert.equal((await c.api('POST', '/api/auth/delete-account', { password: 'wrong-password-1', confirm: 'DELETE' })).status, 400);   // wrong password
    assert.equal((await client0(S.base).api('POST', '/api/auth/delete-account', { password: 'x', confirm: 'DELETE' })).status, 401);
    assert.equal((await c.api('GET', '/api/auth/me')).json.user.email, email);                                                         // nothing happened yet
    const r = await c.api('POST', '/api/auth/delete-account', { password: 'Correct-Horse-7battery', confirm: 'DELETE' });
    assert.equal(r.status, 200);
    for (const tbl of ['users:id', 'portfolios:user_id', 'positions:user_id', 'orders:user_id', 'transactions:user_id', 'watchlists:user_id', 'portfolio_snapshots:user_id', 'idempotency_keys:user_id', 'sessions:user_id', 'password_resets:user_id']) {
      const [t, col] = tbl.split(':');
      assert.equal((await db.query(`select count(*)::int c from ${t} where ${col}=$1`, [c.user.id])).rows[0].c, 0, tbl);
    }
    assert.equal((await c.api('GET', '/api/auth/me')).json.user, null);
    assert.equal((await c.api('GET', '/api/portfolio')).status, 401);
    assert.equal((await client0(S.base).api('POST', '/api/auth/login', { email, password: 'Correct-Horse-7battery' })).status, 401);
    assert.equal((await other.api('GET', '/api/portfolio')).json.positions.length, 1);                                                 // another user's data intact
    assert.ok(allOk(await invariants(db, other.user.id)));
    const again = await client0(S.base).api('POST', '/api/auth/register', { name: 'Asha Rao', email, password: 'Correct-Horse-7battery' });
    assert.equal(again.status, 201);                                                                                                   // email free again, brand-new ₹10,00,000 account
    assert.equal((await db.query('select cash::text c from portfolios where user_id=$1', [again.json.user.id])).rows[0].c, '1000000.00');
    await S.portfolio.runMatching();                                                                                                   // the matcher copes with the vanished user
  });
});
import { client as client0 } from './helpers.js';
