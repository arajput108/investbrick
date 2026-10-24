import test from 'node:test';
import assert from 'node:assert/strict';
import { nseStatus } from '../server/market/calendar.js';
import { Cache } from '../server/market/cache.js';
import { createYahoo } from '../server/market/providers/yahoo.js';
import { createCoinGecko } from '../server/market/providers/coingecko.js';
import { createMarketService } from '../server/market/service.js';
import { createApp } from '../server/app.js';

const ist = (s) => new Date(s + '+05:30');
const resp = (body, status = 200) => ({ ok: status < 300, status, json: async () => body });

const yahooBody = (price, closes = [100, 110, price], t = 1760000000) => ({ chart: { result: [{
  meta: { regularMarketPrice: price, regularMarketTime: t },
  timestamp: [t - 172800, t - 86400, t],
  indicators: { quote: [{ open: [1, 2, null], high: [2, 3, 4], low: [1, 1, 1], close: closes, volume: [10, 20, 30] }] } }] } });

test('calendar: open, pre-open, closed, weekend, holiday', () => {
  assert.equal(nseStatus(ist('2026-10-16T10:00:00')).state, 'open');          // Fri
  assert.equal(nseStatus(ist('2026-10-16T09:05:00')).state, 'pre-open');
  assert.equal(nseStatus(ist('2026-10-16T15:30:00')).state, 'closed');
  assert.equal(nseStatus(ist('2026-10-16T15:29:59')).state, 'open');
  assert.equal(nseStatus(ist('2026-10-17T11:00:00')).reason, 'weekend');
  assert.equal(nseStatus(ist('2026-10-20T11:00:00')).reason, 'holiday');
});

test('cache: single-flight, ttl, stale-on-error flagged', async () => {
  let t = 0, calls = 0, fail = false;
  const c = new Cache({ now: () => t });
  const f = async () => { calls++; if (fail) throw new Error('boom'); return calls; };
  const [a, b] = await Promise.all([c.get('k', 1000, f), c.get('k', 1000, f)]);
  assert.equal(calls, 1); assert.equal(a.value, b.value);
  t = 500; assert.equal((await c.get('k', 1000, f)).value, 1);
  t = 2000; fail = true;
  const s = await c.get('k', 1000, f);
  assert.equal(s.stale, true); assert.equal(s.value, 1);
  await assert.rejects(new Cache({ now: () => t }).get('x', 1, f)); // no prior value -> error, never invented
});

test('yahoo: skips null bars, previous close from prior daily bar', async () => {
  const y = createYahoo({ fetchImpl: async () => resp(yahooBody(120)) });
  const q = await y.quote({ ref: 'X.NS' });
  assert.equal(q.price, 120); assert.equal(q.prevClose, 110);
  const c = await y.candles({ ref: 'X.NS' }, '3M');
  assert.equal(c.candles.length, 2);
});

test('yahoo: rejects bad payloads and HTTP errors', async () => {
  await assert.rejects(createYahoo({ fetchImpl: async () => resp({ chart: { result: null, error: { description: 'nope' } } }) }).quote({ ref: 'X' }));
  await assert.rejects(createYahoo({ fetchImpl: async () => resp({}, 429) }).quote({ ref: 'X' }), /429/);
  await assert.rejects(createYahoo({ fetchImpl: async () => resp(yahooBody(0)) }).quote({ ref: 'X' }));
});

test('coingecko: parses prices, sends key header, enforces budget', async () => {
  let seen;
  const g = createCoinGecko({ apiKey: 'k', monthlyBudget: 1, fetchImpl: async (u, o) => { seen = o.headers; return resp({ bitcoin: { inr: 9000000, inr_24h_change: 10, last_updated_at: 1760000000 } }); } });
  const q = await g.quotes([{ sym: 'BTC', ref: 'bitcoin' }, { sym: 'ETH', ref: 'ethereum' }]);
  assert.equal(seen['x-cg-demo-api-key'], 'k');
  assert.ok(Math.abs(q.BTC.prevClose - 9000000 / 1.1) < 1e-6);
  assert.equal(q.ETH, undefined);
  await assert.rejects(g.quotes([{ sym: 'BTC', ref: 'bitcoin' }]), /budget/);
});

function svc(over = {}) {
  return createMarketService({
    now: () => ist('2026-10-16T11:00:00').getTime(),
    yahoo: { name: 'Y', delayed: true, ranges: ['6M'], quote: async () => ({ price: 100, prevClose: 99, asOf: null }), candles: async () => ({ interval: '1d', candles: [] }), ...over.yahoo },
    coingecko: { name: 'C', delayed: false, ranges: ['6M'], quotes: async () => ({ BTC: { price: 5, prevClose: 4, asOf: null } }), candles: async () => ({ interval: '1d', candles: [] }), ...over.cg },
  });
}

test('service: labels delayed vs live, never fabricates on failure', async () => {
  const s = svc({ yahoo: { quote: async () => { throw new Error('blocked'); } } });
  const r = await s.quotes(['RELIANCE', 'BTC']);
  assert.equal(r.quotes.RELIANCE, undefined); assert.ok(r.errors.RELIANCE);
  assert.equal(r.quotes.BTC.dataState, 'live'); assert.equal(r.quotes.BTC.delayed, false);
  const r2 = await svc().quotes(['TCS']);
  assert.equal(r2.quotes.TCS.dataState, 'delayed'); assert.ok(Math.abs(r2.quotes.TCS.changePct - (100 / 99 - 1) * 100) < 1e-9);
});

test('service: closed market reports last-close', async () => {
  const s = createMarketService({ now: () => ist('2026-10-17T11:00:00').getTime(), yahoo: svc().quotes && { name: 'Y', delayed: true, ranges: [], quote: async () => ({ price: 1, prevClose: 1, asOf: null }) }, coingecko: { name: 'C', delayed: false, ranges: [], quotes: async () => ({}) } });
  assert.equal((await s.quotes(['TCS'])).quotes.TCS.dataState, 'last-close');
});

test('api: routes, validation, unknown symbol', async () => {
  const app = createApp({ market: svc(), config: { isProd: false, trustProxy: 0 } });
  const server = app.listen(0); const base = `http://127.0.0.1:${server.address().port}`;
  try {
    assert.equal((await fetch(base + '/healthz')).status, 200);
    const q = await (await fetch(base + '/api/market/quotes?symbols=TCS,NOPE')).json();
    assert.ok(q.quotes.TCS); assert.equal(q.quotes.NOPE, undefined);
    assert.equal((await fetch(base + '/api/market/candles/NOPE')).status, 404);
    assert.equal((await fetch(base + '/api/market/candles/TCS?range=9Y')).status, 400);
    assert.equal((await fetch(base + '/api/market/status')).status, 200);
    assert.equal((await fetch(base + '/api/nothing')).status, 404);
  } finally { server.close(); }
});

const chartResp = (price) => resp(yahooBody(price, [100, 110, price]));
const inst = (ref, sym = ref) => ({ sym, ref, provider: 'yahoo', market: 'NSE', type: 'stock' });

test('breaker: symbols with no data never pause the provider; real outages (5xx) do', async () => {
  const { createMarketService: mk } = await import('../server/market/service.js');
  let mode = 'nodata';
  const fetchImpl = async (url) => {
    if (mode === 'outage') return resp({}, 503);
    if (/RELIANCE/.test(url)) return chartResp(1000);
    return resp({ chart: { result: null, error: { description: 'No data found, symbol may be delisted' } } });   // unknown symbol
  };
  const m = mk({ yahoo: createYahoo({ fetchImpl }), coingecko: createCoinGecko({ fetchImpl: async () => resp({}) }) });
  for (let i = 0; i < 4; i++) {
    const r = await m.quotes(['TCS', 'INFY', 'HDFCBANK', 'RELIANCE']);               // three symbols fail every time
    assert.ok(r.quotes.RELIANCE, 'healthy symbol still served on round ' + i);
    assert.equal(Object.keys(r.errors).length, 3);
  }
  assert.equal(m.status().providers.yahoo.breakerOpen, false);
  mode = 'outage';
  await m.quotes(['ITC', 'SBIN', 'LT']);
  assert.equal(m.status().providers.yahoo.breakerOpen, true);
});

test('HTTP 429 with Retry-After opens the breaker for at least that long, then recovers; no upstream calls while paused', async () => {
  const { createMarketService: mk } = await import('../server/market/service.js');
  let t = 1_000_000, calls = 0, limited = true;
  const fetchImpl = async () => { calls++; return limited ? { ok: false, status: 429, headers: { get: (h) => (h.toLowerCase() === 'retry-after' ? '120' : null) }, json: async () => ({}) } : chartResp(500); };
  const m = mk({ yahoo: createYahoo({ fetchImpl }), coingecko: createCoinGecko({ fetchImpl: async () => resp({}) }), now: () => t, ttl: { eqOpen: 1, eqClosed: 1 } });
  await m.quotes(['RELIANCE']);
  assert.equal(m.status().providers.yahoo.breakerOpen, true);
  const before = calls; t += 60_000;
  const paused = await m.quotes(['RELIANCE']);
  assert.equal(calls, before); assert.match(paused.errors.RELIANCE, /paused/);
  limited = false; t += 61_000;                                       // 121 s after the 429: past Retry-After
  assert.ok((await m.quotes(['RELIANCE'])).quotes.RELIANCE);
});
