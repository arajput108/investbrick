import { log as rootLog } from '../logger.js';
import { randomUUID } from 'node:crypto';

/**
 * Background limit-order matcher. Runs inside the server process, independent of any browser.
 *
 * Safety does NOT depend on this loop being unique: every fill goes through service.runMatching(), which locks
 * the user's portfolio row, re-reads the order under a row lock, re-checks price/funds, and is backed by a
 * unique index (one fill per order). The lease below only stops several server copies from doing the same work.
 */
export function createMatcher({ db, service, intervalMs = 15000, idleRecheckMs = 1800e3, leaseMs, instance = `${process.pid}-${randomUUID().slice(0, 8)}`, now = () => Date.now(), log = rootLog, jitter = true }) {
  const lease = leaseMs ?? Math.max(intervalMs * 3, 30000);
  const state = { running: false, timer: null, inTick: null, stopped: true, ticks: 0, lastTickAt: null, lastOkAt: null, lastError: null, lastResult: null, consecutiveFailures: 0, leader: false, hasWork: true, lastCheckAt: 0, lastLoopAt: now() };

  async function takeLease() {
    // Insert, or take over only if the previous holder's lease ran out (or it is already ours).
    const r = await db.query(
      `insert into engine_leases (name, holder, expires_at, last_tick_at) values ('matcher', $1, now() + ($2 || ' milliseconds')::interval, now())
       on conflict (name) do update set holder = excluded.holder, expires_at = excluded.expires_at, last_tick_at = now()
       where engine_leases.holder = $1 or engine_leases.expires_at < now() returning holder`, [instance, String(lease)]);
    return r.rows.length > 0;
  }
  const record = (startedAt, res, note) => db.query(
    'insert into engine_runs (instance, started_at, symbols, candidates, filled, deferred, rejected, expired, errors, note) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)',
    [instance, new Date(startedAt).toISOString(), res.symbols, res.candidates, res.filled, res.deferred, res.rejected, res.expired, res.errors, note ?? null]);

  /** One pass. Never throws; never overlaps itself. */
  async function tick({ force = false } = {}) {
    if (state.inTick) return state.inTick;                       // overlap guard: a slow tick is never started twice
    state.lastLoopAt = now();
    // Idle mode: when the last pass found no open orders, do NOT touch the database (lets a serverless DB such as Neon's free plan
    // suspend). Placing an order calls wake(); a slow safety re-check still runs in case another server instance added one.
    if (!state.hasWork && !force && now() - state.lastCheckAt < idleRecheckMs) return { skipped: 'idle' };
    state.inTick = (async () => {
      const startedAt = now();
      state.lastCheckAt = startedAt;
      state.ticks++; state.lastTickAt = new Date(startedAt).toISOString();
      try {
        state.leader = await takeLease();
        if (!state.leader) { state.lastResult = { skipped: 'another instance holds the lease' }; return state.lastResult; }
        const res = await service.runMatching();
        state.lastResult = res;
        state.hasWork = res.candidates > 0;
        const busy = res.filled || res.rejected || res.expired || res.errors || res.feedError;
        if (busy) await record(startedAt, res, res.feedError ? `price feed error: ${res.feedError}` : null).catch(() => {});
        if (res.feedError) { state.lastError = `price feed: ${res.feedError}`; state.consecutiveFailures++; }
        else { state.lastOkAt = new Date(now()).toISOString(); state.lastError = null; state.consecutiveFailures = 0; }
        await db.query("update engine_leases set last_error=$1 where name='matcher' and holder=$2", [state.lastError, instance]).catch(() => {});
        return res;
      } catch (e) {
        state.lastError = String(e.message).slice(0, 300); state.consecutiveFailures++;
        log.error('matcher tick failed', e);
        await record(startedAt, { symbols: 0, candidates: 0, filled: 0, deferred: 0, rejected: 0, expired: 0, errors: 1 }, state.lastError).catch(() => {});
        return { error: state.lastError };
      } finally { state.inTick = null; }
    })();
    return state.inTick;
  }

  const nextDelay = () => {
    const backoff = Math.min(2 ** Math.min(state.consecutiveFailures, 5), 8);           // up to 8x slower while failing
    return intervalMs * backoff * (jitter ? 0.85 + Math.random() * 0.3 : 1);
  };
  function schedule(delay) {
    if (state.stopped) return;
    clearTimeout(state.timer);
    state.timer = setTimeout(async () => { await tick(); schedule(nextDelay()); }, delay);
    state.timer.unref?.();
  }
  /** Called when a limit order is placed on this server: leave idle mode and run soon. */
  function wake() {
    state.hasWork = true;
    if (state.stopped || state.inTick) return;
    clearTimeout(state.timer);
    schedule(200);
  }
  function start({ firstDelayMs = 2000 } = {}) {
    if (!state.stopped) return;
    state.stopped = false; schedule(firstDelayMs);
  }
  /** Stops scheduling, waits for a running tick, and releases the lease so another instance can take over at once. */
  async function stop() {
    state.stopped = true; clearTimeout(state.timer);
    await state.inTick?.catch(() => {});
    await db.query("update engine_leases set expires_at = now() where name='matcher' and holder=$1", [instance]).catch(() => {});
  }
  /** Liveness of the loop itself (not of the database): false if the loop has stopped ticking. */
  const alive = () => state.stopped ? false : now() - state.lastLoopAt < Math.max(intervalMs * 10, 120000);
  const status = () => ({ enabled: !state.stopped, alive: alive(), idle: !state.hasWork, instance, intervalSec: intervalMs / 1000, leader: state.leader, ticks: state.ticks, lastTickAt: state.lastTickAt, lastOkAt: state.lastOkAt, lastError: state.lastError, lastResult: state.lastResult });
  return { start, stop, tick, status, wake, alive, instance };
}
