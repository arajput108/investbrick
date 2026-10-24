import { INSTRUMENTS, BY_SYM } from './instruments.js';
import { statusFor } from './calendar.js';
import { Cache, Breaker } from './cache.js';

async function pool(items, limit, fn) {
  const out = new Array(items.length); let i = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) { const k = i++; out[k] = await fn(items[k]).catch((e) => ({ __err: e })); }
  }));
  return out;
}

export function createMarketService({ yahoo, coingecko, now = () => Date.now(), ttl = {} } = {}) {
  const T = { eqOpen: 20e3, eqClosed: 600e3, crypto: 300e3, candles: 3600e3, ...ttl };
  const cache = new Cache({ now });
  const providers = { yahoo, coingecko };
  const breakers = { yahoo: new Breaker({ now }), coingecko: new Breaker({ now }) };
  const guard = async (name, fn) => {
    if (breakers[name].isOpen) throw new Error(`${name} temporarily paused after repeated errors`);
    try { const r = await fn(); breakers[name].ok(); return r; }
    catch (e) {
      // Only provider-level trouble counts against the breaker. "This symbol has no data" (dataError / HTTP 404) must not pause every other symbol.
      if (e.status === 429) breakers[name].trip(e.retryAfterMs);
      else if (!e.dataError && e.status !== 404) breakers[name].fail();
      throw e;
    }
  };

  function describe(inst, raw, meta) {
    const st = statusFor(inst, new Date(now()));
    const prov = providers[inst.provider];
    const q = {
      sym: inst.sym, name: inst.name, type: inst.type, price: raw.price, prevClose: raw.prevClose,
      change: raw.prevClose ? raw.price - raw.prevClose : null,
      changePct: raw.prevClose ? (raw.price / raw.prevClose - 1) * 100 : null,
      asOf: raw.asOf, fetchedAt: new Date(meta.fetchedAt).toISOString(),
      source: prov.name, delayed: prov.delayed, stale: meta.stale, market: st,
    };
    q.dataState = meta.stale ? 'stale' : st.state === 'closed' ? 'last-close' : prov.delayed ? 'delayed' : 'live';
    return q;
  }

  async function quotes(syms) {
    const want = (syms?.length ? syms : INSTRUMENTS.map((i) => i.sym)).map((s) => BY_SYM.get(s)).filter(Boolean);
    const result = {}, errors = {};
    const eq = want.filter((i) => i.provider === 'yahoo'), cr = want.filter((i) => i.provider === 'coingecko');
    await Promise.all([
      (async () => {
        const rs = await pool(eq, 4, async (inst) => {
          const open = statusFor(inst, new Date(now())).state !== 'closed';
          const m = await cache.get('q:' + inst.sym, open ? T.eqOpen : T.eqClosed, () => guard('yahoo', () => yahoo.quote(inst)));
          return { inst, m };
        });
        rs.forEach((r, k) => {
          if (r.__err) errors[eq[k].sym] = r.__err.message;
          else result[r.inst.sym] = describe(r.inst, r.m.value, r.m);
        });
      })(),
      (async () => {
        if (!cr.length) return;
        // One batched call for all coins; cached as a whole.
        try {
          const m = await cache.get('q:crypto', T.crypto, () => guard('coingecko', () => coingecko.quotes(INSTRUMENTS.filter((i) => i.provider === 'coingecko'))));
          for (const inst of cr) {
            if (m.value[inst.sym]) result[inst.sym] = describe(inst, m.value[inst.sym], m);
            else errors[inst.sym] = 'no price returned';
          }
        } catch (e) { cr.forEach((i) => { errors[i.sym] = e.message; }); }
      })(),
    ]);
    return { asOf: new Date(now()).toISOString(), quotes: result, errors };
  }

  async function candles(sym, range = '6M') {
    const inst = BY_SYM.get(sym);
    if (!inst) { const e = new Error('unknown symbol'); e.status = 404; throw e; }
    const prov = providers[inst.provider];
    if (!prov.ranges.includes(range)) { const e = new Error('unsupported range'); e.status = 400; throw e; }
    const m = await cache.get(`c:${sym}:${range}`, T.candles, () => guard(inst.provider, () => prov.candles(inst, range)));
    return { sym, range, interval: m.value.interval, source: prov.name, delayed: prov.delayed, stale: m.stale,
      fetchedAt: new Date(m.fetchedAt).toISOString(), candles: m.value.candles };
  }

  function status() {
    const d = new Date(now());
    return {
      asOf: d.toISOString(),
      nse: statusFor({ market: 'NSE' }, d),
      crypto: statusFor({ market: 'CRYPTO' }, d),
      providers: {
        yahoo: { name: yahoo.name, breakerOpen: breakers.yahoo.isOpen, note: 'Unofficial source, ~15 min delayed for NSE' },
        coingecko: { name: coingecko.name, breakerOpen: breakers.coingecko.isOpen, usage: coingecko.usage?.() },
      },
    };
  }
  return { quotes, candles, status, instruments: () => INSTRUMENTS.map(({ sym, name, type }) => ({ sym, name, type })) };
}
