// Instrument catalogue. `provider` decides which adapter serves it; `ref` is the
// provider-specific id (Yahoo symbol or CoinGecko coin id).
const s = (sym, name, type, ref, dq) => ({ sym, name, type, provider: 'yahoo', ref, dq, currency: 'INR', market: 'NSE' });
const c = (sym, name, ref, dq) => ({ sym, name, type: 'crypto', provider: 'coingecko', ref, dq, currency: 'INR', market: 'CRYPTO' });

export const INSTRUMENTS = [
  s('RELIANCE', 'Reliance Industries', 'stock', 'RELIANCE.NS', 10),
  s('TCS', 'Tata Consultancy Services', 'stock', 'TCS.NS', 5),
  s('HDFCBANK', 'HDFC Bank', 'stock', 'HDFCBANK.NS', 15),
  s('INFY', 'Infosys', 'stock', 'INFY.NS', 10),
  s('ICICIBANK', 'ICICI Bank', 'stock', 'ICICIBANK.NS', 10),
  s('ITC', 'ITC', 'stock', 'ITC.NS', 50),
  s('SBIN', 'State Bank of India', 'stock', 'SBIN.NS', 20),
  s('LT', 'Larsen & Toubro', 'stock', 'LT.NS', 5),
  s('HINDUNILVR', 'Hindustan Unilever', 'stock', 'HINDUNILVR.NS', 5),
  s('BHARTIARTL', 'Bharti Airtel', 'stock', 'BHARTIARTL.NS', 10),
  s('KOTAKBANK', 'Kotak Mahindra Bank', 'stock', 'KOTAKBANK.NS', 10),
  s('AXISBANK', 'Axis Bank', 'stock', 'AXISBANK.NS', 15),
  s('SUNPHARMA', 'Sun Pharmaceutical', 'stock', 'SUNPHARMA.NS', 10),
  s('MARUTI', 'Maruti Suzuki', 'stock', 'MARUTI.NS', 1),
  s('BAJFINANCE', 'Bajaj Finance', 'stock', 'BAJFINANCE.NS', 10),
  s('ASIANPAINT', 'Asian Paints', 'stock', 'ASIANPAINT.NS', 5),
  s('NIFTYBEES', 'Nifty 50 ETF', 'etf', 'NIFTYBEES.NS', 50),
  s('BANKBEES', 'Bank Nifty ETF', 'etf', 'BANKBEES.NS', 20),
  s('GOLDBEES', 'Gold ETF', 'etf', 'GOLDBEES.NS', 100),
  s('NIFTY 50', 'Nifty 50 index', 'index', '^NSEI', 0),
  s('SENSEX', 'BSE Sensex', 'index', '^BSESN', 0),
  s('BANK NIFTY', 'Nifty Bank index', 'index', '^NSEBANK', 0),
  c('BTC', 'Bitcoin', 'bitcoin', 0.01),
  c('ETH', 'Ethereum', 'ethereum', 0.1),
  c('SOL', 'Solana', 'solana', 1),
  c('XRP', 'XRP', 'ripple', 100),
  c('DOGE', 'Dogecoin', 'dogecoin', 1000),
];
export const BY_SYM = new Map(INSTRUMENTS.map((i) => [i.sym, i]));
// Indices are not tradable in this app (cannot buy an index); ETFs are the proxy.
export const isTradable = (i) => i.type !== 'index';
