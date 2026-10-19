// Yahoo Finance chart endpoint. UNOFFICIAL and keyless: no SLA, terms restrict
// redistribution, and cloud IPs are sometimes rate limited. Fine for a college
// demo; swap for a licensed vendor (see README) before commercial use.
import { getJson, num } from './http.js';

const RANGES = { '1M': ['1mo', '1d'], '3M': ['3mo', '1d'], '6M': ['6mo', '1d'], '1Y': ['1y', '1d'] };
const HOSTS = ['query1.finance.yahoo.com', 'query2.finance.yahoo.com'];

export function createYahoo({ fetchImpl = fetch } = {}) {
  async function chart(ref, range, interval) {
    let lastErr;
    for (const h of HOSTS) {
      try {
        const url = `https://${h}/v8/finance/chart/${encodeURIComponent(ref)}?range=${range}&interval=${interval}&includePrePost=false`;
        const j = await getJson(fetchImpl, url, { headers: { 'user-agent': 'Mozilla/5.0 InvestBrick-demo' } });
        const r = j?.chart?.result?.[0];
        if (!r) throw new Error(j?.chart?.error?.description || 'empty chart result');
        return r;
      } catch (e) { lastErr = e; }
    }
    throw lastErr;
  }
  return {
    name: 'Yahoo Finance',
    delayed: true,
    ranges: Object.keys(RANGES),
    async quote(inst) {
      const r = await chart(inst.ref, '5d', '1d');
      const m = r.meta || {};
      const price = num(m.regularMarketPrice);
      if (price === null || price <= 0) throw new Error('invalid price');
      let prev = num(m.chartPreviousClose) ?? num(m.previousClose);
      const closes = (r.indicators?.quote?.[0]?.close || []).filter((x) => num(x) !== null);
      // chartPreviousClose over a 5d range is the close BEFORE the range; use the last
      // completed daily close before today's bar instead when available.
      if (closes.length >= 2) prev = closes[closes.length - 2];
      const t = num(m.regularMarketTime);
      return { price, prevClose: prev && prev > 0 ? prev : null, asOf: t ? new Date(t * 1000).toISOString() : null };
    },
    async candles(inst, range) {
      const [rg, iv] = RANGES[range] || RANGES['6M'];
      const r = await chart(inst.ref, rg, iv);
      const ts = r.timestamp || [], q = r.indicators?.quote?.[0] || {};
      const out = [];
      for (let i = 0; i < ts.length; i++) {
        const o = num(q.open?.[i]), h = num(q.high?.[i]), l = num(q.low?.[i]), c = num(q.close?.[i]);
        if (o === null || h === null || l === null || c === null) continue; // skip null bars
        out.push({ t: ts[i] * 1000, o, h, l, c, v: num(q.volume?.[i]) ?? 0 });
      }
      if (!out.length) throw new Error('no candles');
      return { interval: iv, candles: out };
    },
  };
}
