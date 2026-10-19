// Run on YOUR machine/server (needs internet): npm run smoke
// Calls the real providers and prints what came back, so you can verify live data works.
import { config } from '../server/config.js';
import { createMarketService } from '../server/market/service.js';
import { createYahoo } from '../server/market/providers/yahoo.js';
import { createCoinGecko } from '../server/market/providers/coingecko.js';

const m = createMarketService({ yahoo: createYahoo(), coingecko: createCoinGecko({ apiKey: config.coingeckoKey }) });
console.log('Market status:', JSON.stringify(m.status().nse));
const r = await m.quotes(['RELIANCE', 'TCS', 'NIFTY 50', 'SENSEX', 'BTC', 'ETH']);
for (const q of Object.values(r.quotes)) {
  console.log(`OK   ${q.sym.padEnd(10)} ${String(q.price).padStart(12)}  ${q.dataState.padEnd(10)} ${q.source}  asOf=${q.asOf}`);
}
for (const [s, e] of Object.entries(r.errors)) console.log(`FAIL ${s.padEnd(10)} ${e}`);
for (const s of ['RELIANCE', 'BTC']) {
  try { const c = await m.candles(s, '1M'); console.log(`OK   candles ${s}: ${c.candles.length} bars (${c.interval})`); }
  catch (e) { console.log(`FAIL candles ${s}: ${e.message}`); }
}
console.log(config.coingeckoKey ? 'CoinGecko key: set' : 'CoinGecko key: NOT set (public tier, stricter limits)');
process.exit(Object.keys(r.errors).length ? 1 : 0);
