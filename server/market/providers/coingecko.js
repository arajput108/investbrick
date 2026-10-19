// CoinGecko official API. Verified Demo plan limits: 100 calls/min, 10,000 credits/month.
import { getJson, num } from './http.js';

const DAYS = { '1M': 30, '3M': 90, '6M': 180, '1Y': 365 };

export function createCoinGecko({ fetchImpl = fetch, apiKey = '', monthlyBudget = 9000, now = () => new Date() } = {}) {
  let month = '', used = 0;
  const spend = () => {
    const m = now().toISOString().slice(0, 7);
    if (m !== month) { month = m; used = 0; }
    if (used >= monthlyBudget) throw new Error('CoinGecko monthly call budget reached');
    used++;
  };
  const headers = apiKey ? { 'x-cg-demo-api-key': apiKey } : {};
  const base = 'https://api.coingecko.com/api/v3';
  return {
    name: 'CoinGecko',
    delayed: false,
    ranges: Object.keys(DAYS),
    usage: () => ({ month, used, monthlyBudget }),
    async quotes(insts) {
      spend();
      const ids = insts.map((i) => i.ref).join(',');
      const j = await getJson(fetchImpl, `${base}/simple/price?ids=${ids}&vs_currencies=inr&include_24hr_change=true&include_last_updated_at=true`, { headers });
      const out = {};
      for (const i of insts) {
        const d = j?.[i.ref];
        const price = num(d?.inr);
        if (price === null || price <= 0) continue;
        const ch = num(d.inr_24h_change);
        out[i.sym] = {
          price,
          prevClose: ch !== null && ch > -100 ? price / (1 + ch / 100) : null,
          asOf: num(d.last_updated_at) ? new Date(d.last_updated_at * 1000).toISOString() : null,
        };
      }
      return out;
    },
    async candles(inst, range) {
      spend();
      const days = DAYS[range] || 180;
      const j = await getJson(fetchImpl, `${base}/coins/${inst.ref}/ohlc?vs_currency=inr&days=${days}`, { headers });
      if (!Array.isArray(j)) throw new Error('bad ohlc response');
      const candles = j.filter((r) => Array.isArray(r) && r.length >= 5 && r.slice(0, 5).every(num))
        .map(([t, o, h, l, c]) => ({ t, o, h, l, c, v: 0 }));
      if (!candles.length) throw new Error('no candles');
      return { interval: days <= 30 ? '4h' : '1d', candles };
    },
  };
}
