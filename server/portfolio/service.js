import { log } from '../logger.js';
// Server-side paper portfolio. Everything that moves money happens here, inside one database transaction that
// first locks the user's `portfolios` row (SELECT ... FOR UPDATE). The browser never supplies a price, a balance
// or a user id: prices come from the market-data service, identity from the session.
// All money arithmetic is done by PostgreSQL `numeric`, never by JavaScript floats.
import { BY_SYM, isTradable } from '../market/instruments.js';

export const START_CASH = '1000000.00';
export const DEFAULT_WATCHLIST = ['RELIANCE', 'TCS', 'HDFCBANK', 'NIFTYBEES', 'NIFTY 50', 'BTC'];
export const MAX_WATCHLIST = 50;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const KEY_RE = /^[a-z0-9][a-z0-9_-]{0,47}$/;

export class PortfolioError extends Error {
  constructor(status, message, code) { super(message); this.status = status; this.code = code; }
}
const bad = (m, code = 'INVALID') => new PortfolioError(400, m, code);

// ---------- input validation ----------
function cleanNote(v) {
  if (v == null || v === '') return '';
  if (typeof v !== 'string') throw bad('Note must be text.');
  // eslint-disable-next-line no-control-regex
  const s = v.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '').trim();
  if (s.length > 240) throw bad('Keep the note under 240 characters.');
  return s;
}
function numText(v) {
  if (typeof v === 'number') return Number.isFinite(v) ? String(v) : '';
  return typeof v === 'string' ? v.trim() : '';
}
const trimZeros = (s) => (s.includes('.') ? s.replace(/0+$/, '').replace(/\.$/, '') : s);

export function parseQty(v, inst) {
  const s = numText(v);
  if (!/^\d{1,9}(\.\d{1,6})?$/.test(s)) throw bad('Enter a valid quantity.');
  const q = trimZeros(s);
  if (!(Number(q) > 0)) throw bad('Enter a quantity above zero.');
  if (inst.type === 'crypto') { if (Number(q) < 0.0001) throw bad('Minimum quantity is 0.0001.'); }
  else if (q.includes('.')) throw bad('Use whole numbers for shares and ETF units.');
  return q;
}
export function parseLimit(v) {
  const s = numText(v);
  if (!/^\d{1,9}(\.\d{1,4})?$/.test(s) || !(Number(s) > 0)) throw bad('Enter a limit price above zero.');
  return trimZeros(s);
}
function parseId(v, what = 'id') {
  if (typeof v !== 'string' || !UUID.test(v)) throw bad(`A valid ${what} is required.`);
  return v.toLowerCase();
}
function parseSymbol(v) {
  const inst = typeof v === 'string' ? BY_SYM.get(v) : null;
  if (!inst) throw bad('Unknown instrument.', 'UNKNOWN_SYMBOL');
  return inst;
}

export function createPortfolioService({
  db, market, now = () => Date.now(), snapshotEveryMs = 3600e3,
  maxAgeMs = { equity: 2 * 60e3, crypto: 6 * 60e3 },         // how old our cached copy of a quote may be
  tradeAgeMs = { equity: 45 * 60e3, crypto: 20 * 60e3 },     // how old the exchange's last trade time may be (NSE data is ~15 min delayed; older = frozen feed)
  maxMove = { equity: 0.4, crypto: 0.5 },                    // reject prices that jump further than this from the previous close (bad data)
  orderTtlDays = 30,
  quoteDeadlineMs = 4000,            // request paths (orders, portfolio reads) never wait longer than this for market data
  matcherQuoteDeadlineMs = 30000,    // the background matcher may wait longer; nobody is waiting on it
  onOrderOpened = () => {},                                   // lets the background matcher leave idle mode
}) {
  const ge = async (t, a, b) => (await t.query('select ($1::numeric) >= ($2::numeric) as ok', [a, b])).rows[0].ok;

  /** Server-side trade gate: is this price safe to execute against? Returns {code, message} or null.
   *  Used identically for market orders, limit orders and the background matcher. Never lets an order fill on a missing,
   *  stale, frozen, implausible or out-of-hours price. */
  function gateInfo(inst, q) {
    const crypto = inst.market === 'CRYPTO', kind = crypto ? 'crypto' : 'equity';
    if (!q || !Number.isFinite(q.price) || !(q.price > 0)) return { code: 'no_price', message: `No market price is available for ${inst.sym} right now. Orders are paused rather than filled at a guess.` };
    const age = now() - Date.parse(q.fetchedAt);
    if (q.stale || !(age < maxAgeMs[kind])) return { code: 'price_stale', message: `The latest price for ${inst.sym} is out of date, so orders are paused until fresh data arrives.` };
    if (q.asOf) {
      const tradeAge = now() - Date.parse(q.asOf);
      if (!(tradeAge < tradeAgeMs[kind])) return { code: 'price_frozen', message: `The latest trade price for ${inst.sym} is out of date (the data feed looks frozen), so orders are paused until it updates.` };
    }
    if (q.prevClose > 0 && Math.abs(q.price / q.prevClose - 1) > maxMove[kind]) return { code: 'price_implausible', message: `The latest price for ${inst.sym} moved more than ${Math.round(maxMove[kind] * 100)}% from the previous close, which looks like bad data, so orders are paused.` };
    if (q.market?.state !== 'open') return { code: 'market_closed', message: `${q.market?.label || 'Market closed'}. Market orders are paused; a limit order will wait and fill when the market is open and the price is reached.` };
    return null;
  }
  const gate = (inst, q) => gateInfo(inst, q)?.message ?? null;
  const crosses = (side, price, limit) => (side === 'buy' ? price <= Number(limit) : price >= Number(limit));

  // ---------- audit trail (append-only table; written in the same transaction as the change it records) ----------
  const event = (t, { orderId, userId, type, actor = 'user', detail = {} }) =>
    t.query('insert into order_events (order_id, user_id, type, actor, detail) values ($1,$2,$3,$4,$5::jsonb)', [orderId, userId, type, actor, JSON.stringify(detail)]);
  const quoteRaw = async (syms) => (await market.quotes(syms)).quotes || {};
  const withDeadline = (p, ms, what) => new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`${what} timed out after ${ms} ms`)), ms);
    p.then((v) => { clearTimeout(t); resolve(v); }, (e) => { clearTimeout(t); reject(e); });
  });
  /** Quotes for a user-facing request. Never throws and never waits past the deadline: a slow or failing provider means "no price"
   *  (orders are then refused or kept waiting, portfolio reads fall back to cost), not a hung request. The upstream call keeps running and fills the cache. */
  const quoteFor = async (syms) => {
    try { return await withDeadline(quoteRaw(syms), quoteDeadlineMs, 'market data'); }
    catch (e) { log.warn('market data unavailable for a request', { err: e.message }); return {}; }
  };

  // ---------- lifecycle ----------
  /** Creates the portfolio exactly once (₹10,00,000). If it already exists nothing is changed, ever. */
  async function ensurePortfolio(t, userId) {
    const ins = await t.query('insert into portfolios (user_id) values ($1) on conflict (user_id) do nothing returning user_id, epoch', [userId]);
    if (ins.rows.length) {
      for (const s of DEFAULT_WATCHLIST) await t.query('insert into watchlists (user_id, symbol) values ($1,$2) on conflict do nothing', [userId, s]);
      await t.query('insert into portfolio_snapshots (user_id, epoch, cash, holdings_value, total_value, realized_pnl) values ($1,$2,$3,0,$3,0)', [userId, ins.rows[0].epoch, START_CASH]);
    }
    return !!ins.rows.length;
  }
  /** Per-user mutex: every mutating transaction starts here. */
  async function lock(t, userId) {
    let r = (await t.query('select user_id, cash::text, epoch, starting_cash::text from portfolios where user_id=$1 for update', [userId])).rows[0];
    if (!r) { await ensurePortfolio(t, userId); r = (await t.query('select user_id, cash::text, epoch, starting_cash::text from portfolios where user_id=$1 for update', [userId])).rows[0]; }
    return r;
  }

  // ---------- core fill (caller holds the lock and has verified funds/holdings) ----------
  async function fill(t, p, f) {
    const px = Number(f.price).toFixed(6);
    const amount = (await t.query('select round($1::numeric * $2::numeric, 2)::text as a', [f.qty, px])).rows[0].a;
    let realized = null;
    if (f.side === 'buy') {
      await t.query('update portfolios set cash = cash - $2::numeric, updated_at = now() where user_id = $1', [p.user_id, amount]);
      await t.query(`insert into positions (user_id, symbol, qty, cost_basis) values ($1,$2,$3::numeric,$4::numeric)
        on conflict (user_id, symbol) do update set qty = positions.qty + excluded.qty, cost_basis = positions.cost_basis + excluded.cost_basis, updated_at = now()`,
      [p.user_id, f.inst.sym, f.qty, amount]);
    } else {
      const pos = (await t.query('select qty::text, cost_basis::text from positions where user_id=$1 and symbol=$2 for update', [p.user_id, f.inst.sym])).rows[0];
      const calc = (await t.query(
        `select (case when $1::numeric = $2::numeric then $3::numeric else round($3::numeric * $1::numeric / $2::numeric, 2) end)::text as cost_sold,
                ($2::numeric - $1::numeric)::text as left_qty`, [f.qty, pos.qty, pos.cost_basis])).rows[0];
      realized = (await t.query('select ($1::numeric - $2::numeric)::text as r', [amount, calc.cost_sold])).rows[0].r;
      if (Number(calc.left_qty) === 0) await t.query('delete from positions where user_id=$1 and symbol=$2', [p.user_id, f.inst.sym]);
      else await t.query('update positions set qty = $3::numeric, cost_basis = cost_basis - $4::numeric, updated_at = now() where user_id=$1 and symbol=$2', [p.user_id, f.inst.sym, calc.left_qty, calc.cost_sold]);
      await t.query('update portfolios set cash = cash + $2::numeric, realized_pnl = realized_pnl + $3::numeric, updated_at = now() where user_id = $1', [p.user_id, amount, realized]);
    }
    const tx = (await t.query(
      `insert into transactions (user_id, epoch, order_id, symbol, side, qty, price, amount, kind, realized, note, price_source, price_as_of)
       values ($1,$2,$3,$4,$5,$6::numeric,$7::numeric,$8::numeric,$9,$10::numeric,$11,$12,$13) returning id`,
      [p.user_id, p.epoch, f.orderId || null, f.inst.sym, f.side, f.qty, px, amount, f.kind, realized, f.note || '', f.q?.source || null, f.q?.asOf || f.q?.fetchedAt || null])).rows[0];
    if (f.orderId) {
      const done = await t.query("update orders set status='filled', closed_at=now(), filled_at=now(), filled_price=$2::numeric, waiting_reason=null where id=$1 and status in ('open','filled') returning id", [f.orderId, px]);
      if (!done.rows.length) throw new Error('order is not fillable');   // can never happen under the lock; aborts the fill if it somehow does
      await event(t, { orderId: f.orderId, userId: p.user_id, type: 'filled', actor: f.actor || 'user',
        detail: { side: f.side, qty: f.qty, price: Number(px), amount: Number(amount), transactionId: tx.id, source: f.q?.source || null, priceAsOf: f.q?.asOf || null, quoteFetchedAt: f.q?.fetchedAt || null } });
    }
    return { transactionId: tx.id, amount, realized };
  }

  const reservedCash = async (t, userId) => (await t.query(
    "select coalesce(sum(round(qty * limit_price, 2)), 0)::text as r from orders where user_id=$1 and status='open' and side='buy'", [userId])).rows[0].r;
  const reservedQty = async (t, userId, sym) => (await t.query(
    "select coalesce(sum(qty), 0)::text as r from orders where user_id=$1 and status='open' and side='sell' and symbol=$2", [userId, sym])).rows[0].r;
  const heldQty = async (t, userId, sym) => (await t.query('select qty::text as q from positions where user_id=$1 and symbol=$2', [userId, sym])).rows[0]?.q || '0';

  async function checkFunds(t, p, side, inst, qty, unitPrice) {
    if (side === 'buy') {
      const need = (await t.query('select round($1::numeric * $2::numeric, 2)::text as n', [qty, Number(unitPrice).toFixed(6)])).rows[0].n;
      const res = await reservedCash(t, p.user_id);
      const avail = (await t.query('select ($1::numeric - $2::numeric)::text as a', [p.cash, res])).rows[0].a;
      if (!(await ge(t, avail, need))) throw new PortfolioError(422, `Not enough cash. You have ₹${Number(avail).toLocaleString('en-IN', { minimumFractionDigits: 2 })} available.`, 'INSUFFICIENT_CASH');
    } else {
      const held = await heldQty(t, p.user_id, inst.sym), res = await reservedQty(t, p.user_id, inst.sym);
      const avail = (await t.query('select ($1::numeric - $2::numeric)::text as a', [held, res])).rows[0].a;
      if (!(await ge(t, avail, qty))) throw new PortfolioError(422, `You can sell at most ${trimZeros(avail)} ${inst.sym} right now.`, 'INSUFFICIENT_HOLDINGS');
    }
  }

  /** Runs fn in a transaction, mapping database constraint failures to clean errors. */
  async function mutate(userId, fn) {
    try {
      return await db.tx(async (t) => fn(t, await lock(t, userId)));
    } catch (e) {
      if (e.code === '23514') throw new PortfolioError(422, 'That trade would break an account rule (for example negative cash). Nothing was changed.', 'CONSTRAINT');
      throw e;
    }
  }
  /** Idempotency: returns the stored result for a key that already succeeded, else null and reserves the key. */
  async function claimKey(t, userId, key) {
    const ins = await t.query("insert into idempotency_keys (user_id, key, result) values ($1,$2,'{}'::jsonb) on conflict do nothing returning key", [userId, key]);
    if (ins.rows.length) return null;
    return (await t.query('select result from idempotency_keys where user_id=$1 and key=$2', [userId, key])).rows[0].result;
  }
  const saveKey = (t, userId, key, result) => t.query('update idempotency_keys set result=$3::jsonb where user_id=$1 and key=$2', [userId, key, JSON.stringify(result)]);

  // ---------- orders ----------
  async function placeOrder(userId, body = {}) {
    const key = parseId(body.clientOrderId, 'clientOrderId');
    const inst = parseSymbol(body.symbol);
    if (!isTradable(inst)) throw bad('Indices cannot be traded directly. Try an index ETF such as NIFTYBEES.', 'NOT_TRADABLE');
    if (body.side !== 'buy' && body.side !== 'sell') throw bad('Side must be buy or sell.');
    if (body.type !== 'market' && body.type !== 'limit') throw bad('Order type must be market or limit.');
    const qty = parseQty(body.qty, inst);
    const limit = body.type === 'limit' ? parseLimit(body.limitPrice) : null;
    const note = cleanNote(body.note);
    const q = (await quoteFor([inst.sym]))[inst.sym];
    const gi = gateInfo(inst, q), blocked = gi?.message || null;
    if (body.type === 'market' && blocked) throw new PortfolioError(409, blocked, 'MARKET_UNAVAILABLE');
    if (body.type === 'limit' && !(q?.price > 0)) throw new PortfolioError(409, blocked, 'MARKET_UNAVAILABLE');

    const out = await mutate(userId, async (t, p) => {
      const prior = await claimKey(t, userId, key);
      if (prior) return { ...prior, duplicate: true };
      await checkFunds(t, p, body.side, inst, qty, limit || q.price);
      const marketable = !blocked && (body.type === 'market' || crosses(body.side, q.price, limit));
      const waiting = marketable ? null : (gi?.code || 'price_not_reached');
      const order = (await t.query(
        `insert into orders (user_id, epoch, symbol, side, type, qty, limit_price, status, note, closed_at, waiting_reason, expires_at)
         values ($1,$2,$3,$4,$5,$6::numeric,$7::numeric,$8,$9,$10::timestamptz,$11, $12::timestamptz) returning id`,
        [userId, p.epoch, inst.sym, body.side, body.type, qty, limit, marketable ? 'filled' : 'open', note, marketable ? new Date(now()).toISOString() : null, waiting,
          marketable ? null : new Date(now() + orderTtlDays * 864e5).toISOString()])).rows[0];
      await event(t, { orderId: order.id, userId, type: 'created', actor: 'user', detail: { side: body.side, type: body.type, qty, limitPrice: limit, symbol: inst.sym, waiting } });
      let result;
      if (marketable) {
        const f = await fill(t, p, { inst, side: body.side, qty, price: q.price, kind: body.type === 'market' ? 'Market' : 'Limit', orderId: order.id, note, q, actor: 'user' });
        result = { orderId: order.id, status: 'filled', transactionId: f.transactionId, price: q.price, amount: Number(f.amount), realized: f.realized == null ? null : Number(f.realized) };
      } else result = { orderId: order.id, status: 'open' };
      await saveKey(t, userId, key, result);
      return result;
    });
    if (out.status === 'open' && !out.duplicate) { try { onOrderOpened(); } catch { /* never affects the order */ } }
    if (out.status === 'filled' && !out.duplicate) await snapshot(userId).catch((e) => log.error('snapshot failed', e));
    return out;
  }

  async function cancelOrder(userId, orderId) {
    const id = parseId(orderId, 'order id');
    return mutate(userId, async (t) => {
      const r = await t.query("update orders set status='cancelled', closed_at=now(), status_reason='user_cancelled', waiting_reason=null where id=$1 and user_id=$2 and status='open' returning id", [id, userId]);
      if (r.rows.length) { await event(t, { orderId: id, userId, type: 'cancelled', actor: 'user', detail: { reason: 'user_cancelled' } }); return { cancelled: true }; }
      const ex = (await t.query('select status from orders where id=$1 and user_id=$2', [id, userId])).rows[0];
      if (!ex) throw new PortfolioError(404, 'Order not found.', 'NOT_FOUND');
      throw new PortfolioError(409, `That order is already ${ex.status}.`, 'NOT_OPEN');
    });
  }

  // ---------- matching: ONE settlement path shared by the background matcher and the read-time fallback ----------
  const MAX_ATTEMPTS = 5;
  const setWaiting = async (t, o, userId, actor, code, price) => {
    if (o.waiting_reason === code) return false;
    await t.query('update orders set waiting_reason=$2 where id=$1', [o.id, code]);
    await event(t, { orderId: o.id, userId, type: 'deferred', actor, detail: { reason: code, price: price ?? null } });
    return true;
  };
  const closeOrder = async (t, o, userId, actor, status, reason, detail = {}) => {
    await t.query('update orders set status=$2, closed_at=now(), status_reason=$3, waiting_reason=null where id=$1 and status=\'open\'', [o.id, status, reason]);
    await event(t, { orderId: o.id, userId, type: status, actor, detail: { reason, ...detail } });
  };

  /** Settles one user's open orders in a single transaction. Takes the per-user lock first (same as every other money
   *  mover), re-reads the orders under row locks, and re-checks everything, so a second matcher, a page load or a
   *  cancel racing with this can never produce a double fill, an overdraft or a fill after cancellation.
   *  Each order runs inside its own SAVEPOINT: one bad order cannot block or roll back the others. */
  async function settleUser(userId, quotes, actor) {
    const out = { filled: 0, rejected: 0, expired: 0, deferred: 0, errors: 0 };
    await mutate(userId, async (t, p) => {
      const orders = (await t.query("select id, symbol, side, qty::text, limit_price::text, note, expires_at, waiting_reason, attempts from orders where user_id=$1 and status='open' order by created_at, id for update", [userId])).rows;
      for (const o of orders) {
        await t.query('savepoint ord');
        try {
          const inst = BY_SYM.get(o.symbol), q = quotes[o.symbol];
          if (o.expires_at && new Date(o.expires_at).getTime() <= now()) { await closeOrder(t, o, userId, actor, 'expired', 'expired'); out.expired++; }
          else if (!inst || !isTradable(inst)) { await closeOrder(t, o, userId, actor, 'rejected', 'instrument_not_supported'); out.rejected++; }
          else {
            const gi = gateInfo(inst, q);
            if (gi) { if (await setWaiting(t, o, userId, actor, gi.code, null)) out.deferred++; }
            else if (!crosses(o.side, q.price, o.limit_price)) { if (await setWaiting(t, o, userId, actor, 'price_not_reached', q.price)) out.deferred++; }
            else {
              const cur = (await t.query('select cash::text from portfolios where user_id=$1', [userId])).rows[0].cash;
              const amount = (await t.query('select round($1::numeric * $2::numeric, 2)::text as a', [o.qty, Number(q.price).toFixed(6)])).rows[0].a;
              if (o.side === 'buy' && !(await ge(t, cur, amount))) { await closeOrder(t, o, userId, actor, 'rejected', 'insufficient_funds', { needed: Number(amount), cash: Number(cur) }); out.rejected++; }
              else if (o.side === 'sell' && !(await ge(t, await heldQty(t, userId, o.symbol), o.qty))) { await closeOrder(t, o, userId, actor, 'rejected', 'insufficient_holdings', { needed: Number(o.qty) }); out.rejected++; }
              else { await fill(t, { ...p, cash: cur }, { inst, side: o.side, qty: trimZeros(o.qty), price: q.price, kind: 'Limit', orderId: o.id, note: o.note, q, actor }); out.filled++; }
            }
          }
          await t.query('release savepoint ord');
        } catch (e) {
          await t.query('rollback to savepoint ord');
          out.errors++;
          const attempts = o.attempts + 1;
          await t.query('update orders set attempts=$2, last_error=$3 where id=$1', [o.id, attempts, String(e.message).slice(0, 300)]);
          await event(t, { orderId: o.id, userId, type: 'fill_failed', actor, detail: { error: String(e.message).slice(0, 300), attempt: attempts } });
          if (attempts >= MAX_ATTEMPTS) { await closeOrder(t, o, userId, actor, 'rejected', 'repeated_errors'); out.rejected++; }
        }
      }
    });
    if (out.filled) await snapshot(userId).catch(() => {});
    return out;
  }

  /** Read-time fallback: settles this user's open orders using current prices. */
  async function matchOpenOrders(userId, actor = 'read') {
    const open = (await db.query("select symbol from orders where user_id=$1 and status='open'", [userId])).rows;
    if (!open.length) return 0;
    const quotes = await quoteFor([...new Set(open.map((o) => o.symbol))]).catch(() => ({}));
    return (await settleUser(userId, quotes, actor)).filled;
  }

  /** One background pass over every user's open orders. Safe to run from several processes at once.
   *  Quotes are fetched once per symbol; users are only locked when something can actually change for them. */
  async function runMatching() {
    const res = { candidates: 0, symbols: 0, users: 0, filled: 0, rejected: 0, expired: 0, deferred: 0, errors: 0, feedError: null };
    const open = (await db.query("select id, user_id, symbol, side, limit_price::text, expires_at, waiting_reason from orders where status='open' order by created_at, id")).rows;
    res.candidates = open.length;
    if (!open.length) return res;
    const syms = [...new Set(open.map((o) => o.symbol))];
    res.symbols = syms.length;
    let quotes = {};
    try { quotes = await withDeadline(quoteRaw(syms), matcherQuoteDeadlineMs, 'market data'); } catch (e) { res.feedError = String(e.message).slice(0, 200); }   // feed down: nothing fills, expiry still runs
    const needs = new Set();
    for (const o of open) {
      const inst = BY_SYM.get(o.symbol), q = quotes[o.symbol];
      if ((o.expires_at && new Date(o.expires_at).getTime() <= now()) || !inst || !isTradable(inst)) { needs.add(o.user_id); continue; }
      const gi = gateInfo(inst, q);
      const reason = gi ? gi.code : crosses(o.side, q.price, o.limit_price) ? null : 'price_not_reached';
      if (reason === null || reason !== o.waiting_reason) needs.add(o.user_id);
    }
    for (const userId of needs) {
      res.users++;
      try {
        const r = await settleUser(userId, quotes, 'matcher');
        for (const k of ['filled', 'rejected', 'expired', 'deferred', 'errors']) res[k] += r[k];
      } catch (e) { res.errors++; log.error('matcher user settle failed', e); }
    }
    return res;
  }

  async function placeBasket(userId, body = {}) {
    const key = parseId(body.clientOrderId, 'clientOrderId');
    const name = typeof body.name === 'string' ? body.name.trim().slice(0, 60) : '';
    if (!name) throw bad('Basket name is required.');
    if (!Array.isArray(body.items) || !body.items.length || body.items.length > 10) throw bad('A basket needs 1 to 10 holdings.');
    const seen = new Set(), items = body.items.map((it) => {
      const inst = parseSymbol(it?.symbol);
      if (!isTradable(inst)) throw bad(`${inst.sym} cannot be traded directly.`, 'NOT_TRADABLE');
      if (seen.has(inst.sym)) throw bad('Each holding can appear once.');
      seen.add(inst.sym);
      return { inst, qty: parseQty(it.qty, inst) };
    });
    const quotes = await quoteFor(items.map((i) => i.inst.sym));
    for (const it of items) { const m = gate(it.inst, quotes[it.inst.sym]); if (m) throw new PortfolioError(409, `Basket orders need fresh prices while the market is open. ${m}`, 'MARKET_UNAVAILABLE'); }
    const out = await mutate(userId, async (t, p) => {
      const prior = await claimKey(t, userId, key);
      if (prior) return { ...prior, duplicate: true };
      let total = '0';
      for (const it of items) {
        const a = (await t.query('select round($1::numeric * $2::numeric, 2)::text as a', [it.qty, Number(quotes[it.inst.sym].price).toFixed(6)])).rows[0].a;
        total = (await t.query('select ($1::numeric + $2::numeric)::text as s', [total, a])).rows[0].s;
      }
      const avail = (await t.query('select ($1::numeric - $2::numeric)::text as a', [p.cash, await reservedCash(t, userId)])).rows[0].a;
      if (!(await ge(t, avail, total))) throw new PortfolioError(422, `Not enough cash. This basket needs about ₹${Number(total).toLocaleString('en-IN', { minimumFractionDigits: 2 })} and you have ₹${Number(avail).toLocaleString('en-IN', { minimumFractionDigits: 2 })}.`, 'INSUFFICIENT_CASH');
      const txIds = [];
      for (const it of items) {
        const q = quotes[it.inst.sym];
        const o = (await t.query("insert into orders (user_id, epoch, symbol, side, type, qty, status, note, closed_at) values ($1,$2,$3,'buy','market',$4::numeric,'filled',$5,now()) returning id", [userId, p.epoch, it.inst.sym, it.qty, `Basket: ${name}`])).rows[0];
        await event(t, { orderId: o.id, userId, type: 'created', actor: 'user', detail: { side: 'buy', type: 'market', qty: it.qty, symbol: it.inst.sym, basket: name } });
        txIds.push((await fill(t, p, { inst: it.inst, side: 'buy', qty: it.qty, price: q.price, kind: 'Basket', orderId: o.id, note: `Basket: ${name}`, q, actor: 'user' })).transactionId);
      }
      const result = { status: 'filled', transactionIds: txIds, total: Number(total) };
      await saveKey(t, userId, key, result);
      return result;
    });
    if (!out.duplicate) await snapshot(userId).catch(() => {});
    return out;
  }

  // ---------- watchlist, learning, import, reset ----------
  async function addWatch(userId, sym) {
    const inst = parseSymbol(sym);
    return mutate(userId, async (t) => {
      const n = (await t.query('select count(*)::int c from watchlists where user_id=$1', [userId])).rows[0].c;
      const ex = (await t.query('select 1 from watchlists where user_id=$1 and symbol=$2', [userId, inst.sym])).rows.length;
      if (!ex && n >= MAX_WATCHLIST) throw new PortfolioError(422, `Your watchlist is full (${MAX_WATCHLIST} maximum).`, 'WATCHLIST_FULL');
      await t.query('insert into watchlists (user_id, symbol) values ($1,$2) on conflict do nothing', [userId, inst.sym]);
      return { ok: true };
    });
  }
  const removeWatch = (userId, sym) => mutate(userId, async (t) => {
    await t.query('delete from watchlists where user_id=$1 and symbol=$2', [userId, parseSymbol(sym).sym]); return { ok: true };
  });

  function cleanLearning(obj) {
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) throw bad('Progress must be an object.');
    const keys = Object.keys(obj);
    if (keys.length > 200) throw bad('Too many progress entries.');
    const out = {};
    for (const k of keys) { if (!KEY_RE.test(k) || obj[k] !== true) throw bad('Invalid progress entry.'); out[k] = true; }
    return out;
  }
  const mergeLearning = (t, userId, completed) => t.query('update portfolios set learning = learning || $2::jsonb, updated_at = now() where user_id=$1', [userId, JSON.stringify(completed)]);
  const setLearning = (userId, body = {}) => mutate(userId, async (t) => { await mergeLearning(t, userId, cleanLearning(body.completed)); return { ok: true }; });

  /** One-time, merge-only import of NON-financial guest data. Balances/holdings are never accepted from the browser. */
  async function importGuest(userId, body = {}) {
    const wl = Array.isArray(body.watchlist) ? body.watchlist : [];
    if (wl.length > MAX_WATCHLIST) throw bad('Too many watchlist entries.');
    const syms = [...new Set(wl.map((s) => parseSymbol(s).sym))];
    const completed = cleanLearning(body.completed ?? {});
    return mutate(userId, async (t) => {
      const done = (await t.query('select guest_import_at from portfolios where user_id=$1', [userId])).rows[0].guest_import_at;
      if (done) throw new PortfolioError(409, 'Guest data was already imported into this account.', 'ALREADY_IMPORTED');
      const have = new Set((await t.query('select symbol from watchlists where user_id=$1', [userId])).rows.map((r) => r.symbol));
      let added = 0;
      for (const s of syms) { if (have.size >= MAX_WATCHLIST) break; if (!have.has(s)) { await t.query('insert into watchlists (user_id, symbol) values ($1,$2) on conflict do nothing', [userId, s]); have.add(s); added++; } }
      await mergeLearning(t, userId, completed);
      await t.query('update portfolios set guest_import_at = now() where user_id=$1', [userId]);
      return { watchlistAdded: added, progressMerged: Object.keys(completed).length };
    });
  }
  /** Marks the one-time import as dismissed so the offer is not shown again. */
  const dismissGuestImport = (userId) => mutate(userId, async (t) => {
    await t.query('update portfolios set guest_import_at = coalesce(guest_import_at, now()) where user_id=$1', [userId]); return { ok: true };
  });

  async function reset(userId, body = {}) {
    if (body.confirm !== 'RESET') throw bad('Type RESET to confirm.', 'CONFIRM_REQUIRED');
    const r = await mutate(userId, async (t, p) => {
      const open = (await t.query("update orders set status='cancelled', closed_at=now(), status_reason='account_reset', waiting_reason=null where user_id=$1 and status='open' returning id", [userId])).rows;
      for (const o of open) await event(t, { orderId: o.id, userId, type: 'cancelled', actor: 'user', detail: { reason: 'account_reset' } });
      await t.query('delete from positions where user_id=$1', [userId]);
      const n = (await t.query('update portfolios set cash = starting_cash, realized_pnl = 0, epoch = epoch + 1, updated_at = now() where user_id=$1 returning epoch, starting_cash::text as sc', [userId])).rows[0];
      await t.query('insert into portfolio_snapshots (user_id, epoch, cash, holdings_value, total_value, realized_pnl) values ($1,$2,$3,0,$3,0)', [userId, n.epoch, n.sc]);
      return { epoch: n.epoch, previousEpoch: p.epoch };
    });
    return r;
  }

  // ---------- snapshots (portfolio history) ----------
  async function snapshot(userId) {
    const pre = (await db.query('select symbol from positions where user_id=$1', [userId])).rows.map((r) => r.symbol);
    const quotes = pre.length ? await quoteFor(pre).catch(() => ({})) : {};
    return mutate(userId, async (t, p) => {
      const pos = (await t.query('select symbol, qty::text, cost_basis::text from positions where user_id=$1', [userId])).rows;
      let partial = false, value = '0';
      for (const x of pos) {
        const px = quotes[x.symbol]?.price;
        let v;
        if (px > 0) v = (await t.query('select round($1::numeric * $2::numeric, 2)::text as v', [x.qty, Number(px).toFixed(6)])).rows[0].v;
        else { v = x.cost_basis; partial = true; }
        value = (await t.query('select ($1::numeric + $2::numeric)::text as s', [value, v])).rows[0].s;
      }
      const row = (await t.query('select cash::text, realized_pnl::text from portfolios where user_id=$1', [userId])).rows[0];
      const total = (await t.query('select ($1::numeric + $2::numeric)::text as s', [row.cash, value])).rows[0].s;
      await t.query('insert into portfolio_snapshots (user_id, epoch, cash, holdings_value, total_value, realized_pnl, partial) values ($1,$2,$3::numeric,$4::numeric,$5::numeric,$6::numeric,$7)',
        [userId, p.epoch, row.cash, value, total, row.realized_pnl, partial]);
      return { total };
    });
  }
  async function history(userId, limit = 300) {
    const n = Math.min(Math.max(parseInt(limit, 10) || 300, 1), 1000);
    const rows = (await db.query(
      `select taken_at, cash::float8 as cash, holdings_value::float8 as holdings, total_value::float8 as total, realized_pnl::float8 as realized, partial
       from portfolio_snapshots where user_id=$1 and epoch=(select epoch from portfolios where user_id=$1) order by taken_at desc, id desc limit $2`, [userId, n])).rows;
    return rows.reverse().map((r) => ({ t: new Date(r.taken_at).toISOString(), cash: r.cash, holdings: r.holdings, total: r.total, realized: r.realized, partial: r.partial }));
  }

  // ---------- read ----------
  const orderRow = (r) => ({ id: r.id, symbol: r.symbol, side: r.side, type: r.type, qty: Number(r.qty), limitPrice: r.limit_price == null ? null : Number(r.limit_price),
    status: r.status, reason: r.status_reason || null, waitingReason: r.status === 'open' ? r.waiting_reason || null : null, filledPrice: r.filled_price == null ? null : Number(r.filled_price),
    createdAt: new Date(r.created_at).toISOString(), closedAt: r.closed_at ? new Date(r.closed_at).toISOString() : null, expiresAt: r.expires_at ? new Date(r.expires_at).toISOString() : null });
  const STATUSES = ['open', 'filled', 'cancelled', 'rejected', 'expired'];
  // Keyset (cursor) pagination: stable while new rows arrive, and cheap at any depth (served by the (user, created_at, id) indexes).
  // The cursor carries the row's own timestamp as text with microsecond precision, so no row is skipped or repeated.
  const TS = (col) => `to_char(${col} at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;
  const encCursor = (ts, id) => Buffer.from(`${ts}|${id}`).toString('base64url');
  function decCursor(c) {
    if (c === undefined || c === null || c === '') return { ts: null, id: null };
    const [ts, id] = Buffer.from(String(c).slice(0, 200), 'base64url').toString().split('|');
    if (!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{6}Z$/.test(ts || '') || !UUID.test(id || '')) throw bad('That page cursor is not valid.', 'BAD_CURSOR');
    return { ts, id };
  }
  const pageSize = (limit, dflt, max) => Math.min(Math.max(parseInt(limit, 10) || dflt, 1), max);

  async function listOrders(userId, { status, limit, before } = {}) {
    if (status !== undefined && !STATUSES.includes(status)) throw bad('Unknown order status.');
    const n = pageSize(limit, 100, 500), cur = decCursor(before);
    const rows = (await db.query(`select id, symbol, side, type, qty::text, limit_price::text, status, status_reason, waiting_reason, filled_price::text, created_at, closed_at, expires_at, ${TS('created_at')} as cur_ts
      from orders where user_id=$1 and ($2::text is null or status=$2)
        and ($3::text is null or (created_at, id) < ($3::timestamptz, $4::uuid))
      order by created_at desc, id desc limit $5`, [userId, status ?? null, cur.ts, cur.id, n + 1])).rows;
    const page = rows.slice(0, n);
    return { orders: page.map(orderRow), nextCursor: rows.length > n ? encCursor(page[n - 1].cur_ts, page[n - 1].id) : null };
  }
  /** Filled trades, newest first. Defaults to the current account epoch (after a reset, older epochs stay available with epoch=all). */
  async function listTransactions(userId, { limit, before, symbol, side, epoch } = {}) {
    if (side !== undefined && side !== 'buy' && side !== 'sell') throw bad('Side must be buy or sell.');
    const sym = symbol === undefined ? null : parseSymbol(symbol).sym;
    if (epoch !== undefined && epoch !== 'all' && !/^\d{1,6}$/.test(String(epoch))) throw bad('Epoch must be a number or "all".');
    const n = pageSize(limit, 50, 200), cur = decCursor(before);
    const rows = (await db.query(`select id, order_id, symbol, side, qty::text, price::text, amount::text, kind, realized::text, note, price_source, epoch, created_at, ${TS('created_at')} as cur_ts
      from transactions where user_id=$1
        and ($2::text = 'all' or epoch = case when $2::text = '' then (select epoch from portfolios where user_id=$1) else $2::int end)
        and ($3::text is null or symbol=$3) and ($4::text is null or side=$4)
        and ($5::text is null or (created_at, id) < ($5::timestamptz, $6::uuid))
      order by created_at desc, id desc limit $7`, [userId, epoch === undefined ? '' : String(epoch), sym, side ?? null, cur.ts, cur.id, n + 1])).rows;
    const page = rows.slice(0, n);
    return { transactions: page.map((r) => ({ id: r.id, orderId: r.order_id, symbol: r.symbol, side: r.side, qty: Number(r.qty), price: Number(r.price), amount: Number(r.amount), kind: r.kind,
      realized: r.realized == null ? null : Number(r.realized), note: r.note, source: r.price_source, epoch: r.epoch, createdAt: new Date(r.created_at).toISOString() })),
    nextCursor: rows.length > n ? encCursor(page[n - 1].cur_ts, page[n - 1].id) : null };
  }
  /** The audit trail of one order. Only the owner can read it. */
  async function orderEvents(userId, orderId) {
    const id = parseId(orderId, 'order id');
    const o = (await db.query('select 1 from orders where id=$1 and user_id=$2', [id, userId])).rows[0];
    const ev = (await db.query('select id, at, type, actor, detail from order_events where order_id=$1 and user_id=$2 order by id', [id, userId])).rows;
    if (!o && !ev.length) throw new PortfolioError(404, 'Order not found.', 'NOT_FOUND');
    return ev.map((e) => ({ id: Number(e.id), at: new Date(e.at).toISOString(), type: e.type, actor: e.actor, detail: e.detail }));
  }
  async function view(userId) {
    const p = (await db.query('select cash::text, starting_cash::text, realized_pnl::text, epoch, learning, guest_import_at from portfolios where user_id=$1', [userId])).rows[0];
    const [pos, ord, txs, wl, res, log] = await Promise.all([
      db.query('select symbol, qty::text, cost_basis::text from positions where user_id=$1 order by symbol', [userId]),
      db.query("select id, symbol, side, type, qty::text, limit_price::text, note, created_at, waiting_reason, expires_at from orders where user_id=$1 and status='open' order by created_at, id", [userId]),
      db.query(`select id, symbol, side, qty::text, price::text, amount::text, kind, realized::text, note, price_source, created_at from transactions
                where user_id=$1 and epoch=$2 order by created_at desc, id desc limit 200`, [userId, p.epoch]),
      db.query('select symbol from watchlists where user_id=$1 order by added_at, symbol', [userId]),
      db.query(`select coalesce(sum(round(qty * limit_price, 2)),0)::text as c,
                       ((select cash from portfolios where user_id=$1) - coalesce(sum(round(qty * limit_price, 2)),0))::text as a
                from orders where user_id=$1 and status='open' and side='buy'`, [userId]),
      db.query(`select id, symbol, side, type, qty::text, limit_price::text, status, status_reason, waiting_reason, filled_price::text, created_at, closed_at, expires_at
                from orders where user_id=$1 and epoch=$2 order by created_at desc, id desc limit 100`, [userId, p.epoch]),
    ]);
    const reserved = res.rows[0].c;
    return {
      epoch: p.epoch, startingCash: Number(p.starting_cash), cash: Number(p.cash), reserved: Number(reserved),
      available: Number(res.rows[0].a),
      realizedPnl: Number(p.realized_pnl), guestImportPending: !p.guest_import_at, learning: p.learning || {},
      positions: pos.rows.map((r) => ({ symbol: r.symbol, qty: Number(r.qty), costBasis: Number(r.cost_basis), avgCost: Number(r.cost_basis) / Number(r.qty) })),
      orders: ord.rows.map((r) => ({ id: r.id, symbol: r.symbol, side: r.side, type: r.type, qty: Number(r.qty), limitPrice: Number(r.limit_price), note: r.note, createdAt: new Date(r.created_at).toISOString(), waitingReason: r.waiting_reason, expiresAt: r.expires_at ? new Date(r.expires_at).toISOString() : null })),
      orderLog: log.rows.map(orderRow),
      history: txs.rows.map((r) => ({ id: r.id, symbol: r.symbol, side: r.side, qty: Number(r.qty), price: Number(r.price), amount: Number(r.amount), kind: r.kind, realized: r.realized == null ? null : Number(r.realized), note: r.note, source: r.price_source, createdAt: new Date(r.created_at).toISOString() })),
      watchlist: wl.rows.map((r) => r.symbol),
      serverTime: new Date(now()).toISOString(),
    };
  }
  /** Reads the portfolio, first settling any open limit orders the current prices satisfy. Never fails the read. */
  async function getPortfolio(userId) {
    // Cheap existence check first: the creating transaction only runs for a brand-new user (ensurePortfolio is itself race-safe).
    if (!(await db.query('select 1 from portfolios where user_id=$1', [userId])).rows.length) await db.tx((t) => ensurePortfolio(t, userId));
    await matchOpenOrders(userId).catch((e) => log.error('order matching on read failed', e));
    const last = (await db.query('select max(taken_at) as t from portfolio_snapshots where user_id=$1 and epoch=(select epoch from portfolios where user_id=$1)', [userId])).rows[0].t;
    if (!last || now() - new Date(last).getTime() > snapshotEveryMs) await snapshot(userId).catch((e) => log.error('snapshot failed', e));
    return view(userId);
  }

  async function purgeKeys() {
    await db.query("delete from idempotency_keys where created_at < now() - interval '7 days'");
    await db.query("delete from engine_runs where started_at < now() - interval '30 days'");   // operational log only; the order audit trail is never purged
  }

  return { ensurePortfolio, placeOrder, cancelOrder, matchOpenOrders, placeBasket, addWatch, removeWatch, setLearning, importGuest, dismissGuestImport, reset, snapshot, history, getPortfolio, view, purgeKeys, gate, gateInfo, runMatching, listOrders, listTransactions, orderEvents, settleUser };
}
