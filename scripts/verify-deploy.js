#!/usr/bin/env node
// Post-deployment verification. Run it AGAINST YOUR LIVE SITE from your own computer:
//   npm run verify:deploy -- https://your-site.example            (read-only checks)
//   npm run verify:deploy -- https://your-site.example --full     (also creates a TEST account and trades with it)
//   add  --matcher-test=10   to wait up to 10 minutes for the background matcher to fill a crypto limit order
//   add  --reset-email=you@gmail.com   to trigger a real password-reset email you then check by hand
// Every check ends as PASS, FAIL, SKIP (could not be tested, and why) or MANUAL (needs your eyes). Nothing is assumed: SKIP is not a pass.
const args = process.argv.slice(2);
const base = (args.find((a) => /^https?:\/\//.test(a)) || '').replace(/\/+$/, '');
const flag = (n) => args.find((a) => a === `--${n}` || a.startsWith(`--${n}=`));
const val = (n) => { const f = flag(n); return f && f.includes('=') ? f.split('=').slice(1).join('=') : null; };
if (!base) { console.error('Usage: npm run verify:deploy -- https://your-site.example [--full] [--matcher-test=10] [--reset-email=you@example.com]'); process.exit(2); }
const FULL = !!flag('full'), MATCHER_MIN = flag('matcher-test') ? Number(val('matcher-test') || 10) : 0, RESET_EMAIL = val('reset-email');
const FWD = val('forwarded-proto');                  // local rehearsal only: pretend to be the hosting proxy
const isHttps = base.startsWith('https://');

const rows = []; const rec = (status, name, detail = '') => { rows.push({ status, name, detail }); console.log(`${status.padEnd(6)} ${name}${detail ? '  ' + detail : ''}`); };
const pass = (n, d) => rec('PASS', n, d), fail = (n, d) => rec('FAIL', n, d), skip = (n, d) => rec('SKIP', n, d), manual = (n, d) => rec('MANUAL', n, d);
const check = (ok, n, d) => (ok ? pass(n) : fail(n, d));

let cookie = '';
async function call(method, path, body, { noCookie = false, headers = {} } = {}) {
  const res = await fetch(base + path, { method, redirect: 'manual', headers: { ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...(FWD ? { 'x-forwarded-proto': FWD } : {}), ...(method !== 'GET' ? { origin: base } : {}), ...(cookie && !noCookie ? { cookie } : {}), ...headers }, body: body !== undefined ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(30000) });
  const sc = res.headers.getSetCookie?.() || [];
  for (const c of sc) { const [kv] = c.split(';'); const i = kv.indexOf('='); const k = kv.slice(0, i), v = kv.slice(i + 1); cookie = v === '' ? '' : `${k}=${v}`; }
  let json = null; try { json = await res.json(); } catch { /* not JSON */ }
  return { status: res.status, json, headers: res.headers, setCookie: sc };
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const GOOD = 'Verify-Deploy-' + Math.random().toString(36).slice(2, 10) + '!9';

async function main() {
  console.log(`\nVerifying ${base}${FULL ? ' (full mode: a test account will be created)' : ' (read-only)'}\n`);

  // ---- 1. process, TLS, headers ----
  let r = await call('GET', '/healthz');
  check(r.status === 200 && r.json?.ok === true, 'liveness /healthz', `HTTP ${r.status}`);
  if (r.json?.matcher) check(r.json.matcher.enabled === true && r.json.matcher.alive === true, 'background matcher loop is running', JSON.stringify(r.json.matcher));
  else skip('background matcher loop', '/healthz reports no matcher information');
  r = await call('GET', '/readyz');
  check(r.status === 200 && r.json?.ok === true, 'readiness /readyz (database + matcher)', `HTTP ${r.status} ${JSON.stringify(r.json?.checks || {})}`);
  const h = r.headers;
  check(!h.get('x-powered-by'), 'no X-Powered-By header');
  check(h.get('x-content-type-options') === 'nosniff', 'X-Content-Type-Options: nosniff');
  check(/default-src 'self'/.test(h.get('content-security-policy') || ''), 'Content-Security-Policy present');
  if (isHttps) {
    check(/max-age=\d+/.test(h.get('strict-transport-security') || ''), 'HSTS header (HTTPS enforced)');
    try { const plain = await fetch(base.replace('https://', 'http://') + '/login', { redirect: 'manual', signal: AbortSignal.timeout(15000) }); check([301, 302, 307, 308].includes(plain.status) && /^https:/.test(plain.headers.get('location') || ''), 'plain http:// redirects to https://', `HTTP ${plain.status}`); }
    catch (e) { skip('plain http:// redirect', 'could not connect over http (' + e.message + '); many hosts simply close port 80, which is also acceptable'); }
  } else skip('HSTS and http->https redirect', 'URL is not https');

  // ---- 2. market data (real providers) ----
  r = await call('GET', '/api/market/quotes?symbols=RELIANCE,NIFTYBEES,BTC,ETH');
  const quotes = r.json?.quotes || {}, errs = r.json?.errors || {};
  for (const sym of ['RELIANCE', 'NIFTYBEES', 'BTC', 'ETH']) {
    const q = quotes[sym];
    if (q) check(q.price > 0 && q.source, `live quote ${sym}`, '');
    else fail(`live quote ${sym}`, `provider error: ${errs[sym] || 'missing'}`);
    if (q) console.log(`         ${sym}: ₹${q.price}  state=${q.dataState}  source=${q.source}  asOf=${q.asOf}  market=${q.market?.state}${q.delayed ? '  (delayed)' : ''}`);
  }
  r = await call('GET', '/api/market/candles/BTC?range=1M');
  check(r.status === 200 && r.json?.candles?.length > 5, 'chart data (BTC 1M candles)', `HTTP ${r.status}`);
  const eqOpen = quotes.NIFTYBEES?.market?.state === 'open', btc = quotes.BTC;

  // ---- 3. unauthenticated safety ----
  r = await call('GET', '/api/portfolio', undefined, { noCookie: true }); check(r.status === 401, 'portfolio refuses anonymous visitors', `HTTP ${r.status}`);
  r = await call('POST', '/api/auth/login', { email: 'a@b.co', password: 'x' }, { headers: { origin: 'https://evil.example' }, noCookie: true });
  check(r.status === 403, 'cross-site POST is blocked (CSRF guard)', `HTTP ${r.status}`);

  if (RESET_EMAIL) {
    r = await call('POST', '/api/auth/forgot-password', { email: RESET_EMAIL });
    if (r.status === 200) manual('password-reset email', `request accepted for ${RESET_EMAIL}. Open your inbox (and spam), click the link, set a new password. If nothing arrives within 2 minutes the SMTP settings are wrong: see Troubleshooting in the README`);
    else if (r.status === 503 && r.json?.code === 'EMAIL_UNAVAILABLE') skip('password-reset email', 'this server has no email service configured (SMTP_* not set), so it correctly reports reset as unavailable. Reset email is NOT verified');
    else fail('password-reset request', `HTTP ${r.status} ${JSON.stringify(r.json)}`);
  } else skip('password-reset email', 'pass --reset-email=you@example.com to send a real one (needs your inbox to confirm)');

  if (!FULL) { skip('registration, login, trading, persistence, logout', 'run again with --full'); return; }

  // ---- 4. account lifecycle ----
  const email = `verify.${Date.now()}@example.com`;
  r = await call('POST', '/api/auth/register', { name: 'Deploy Check', email, password: GOOD });
  check(r.status === 201, 'register a test account', `HTTP ${r.status} ${JSON.stringify(r.json)}`);
  if (r.status !== 201) return;
  const sc = r.setCookie[0] || '';
  check(/HttpOnly/i.test(sc), 'session cookie is HttpOnly'); check(/SameSite=Lax/i.test(sc), 'session cookie is SameSite=Lax');
  if (isHttps || FWD) { check(/;\s*Secure/i.test(sc), 'session cookie is Secure'); check(/^__Host-/.test(sc), 'session cookie uses the __Host- prefix'); } else skip('Secure cookie', 'URL is not https');
  r = await call('GET', '/api/auth/me'); check(r.json?.user?.email === email, 'session works (/api/auth/me)');
  r = await call('GET', '/api/portfolio'); check(r.status === 200 && r.json.cash === 1000000, 'new account has exactly ₹10,00,000', `cash=${r.json?.cash}`);

  // ---- 5. trading ----
  if (btc?.price > 0 && btc.dataState !== 'stale') {
    const cash0 = r.json.cash;
    const id = () => crypto.randomUUID();
    let o = await call('POST', '/api/portfolio/orders', { clientOrderId: id(), symbol: 'BTC', side: 'buy', type: 'market', qty: 0.001 });
    check(o.status === 200 && o.json?.result?.status === 'filled', 'market BUY filled at server price', `HTTP ${o.status} ${JSON.stringify(o.json)}`);
    if (o.json?.result?.status === 'filled') {
      const spent = o.json.result.amount; const p = o.json.portfolio;
      check(Math.abs(p.cash - (cash0 - spent)) < 0.005, 'cash dropped by exactly the trade amount', `cash ${p.cash}, expected ${cash0 - spent}`);
      check(p.positions.some((x) => x.symbol === 'BTC' && x.qty === 0.001) && p.history[0]?.symbol === 'BTC', 'holding and transaction history recorded');
      const k = id(); const a = await call('POST', '/api/portfolio/orders', { clientOrderId: k, symbol: 'BTC', side: 'sell', type: 'market', qty: 0.0005 });
      const b = await call('POST', '/api/portfolio/orders', { clientOrderId: k, symbol: 'BTC', side: 'sell', type: 'market', qty: 0.0005 });
      check(a.json?.result?.status === 'filled' && b.json?.result?.duplicate === true, 'market SELL works and a repeated submission does not trade twice');
    }
    // a limit order that cannot fill yet, then cancel
    o = await call('POST', '/api/portfolio/orders', { clientOrderId: id(), symbol: 'BTC', side: 'buy', type: 'limit', qty: 0.001, limitPrice: Math.round(btc.price * 0.5) });
    check(o.json?.result?.status === 'open', 'far-away limit order stays open', JSON.stringify(o.json));
    if (o.json?.result?.orderId) {
      const c = await call('DELETE', `/api/portfolio/orders/${o.json.result.orderId}`); check(c.status === 200, 'cancel releases the order');
      const ev = await call('GET', `/api/portfolio/orders/${o.json.result.orderId}/events`); check(ev.json?.events?.map((e) => e.type).join() === 'created,cancelled', 'audit trail recorded created + cancelled', JSON.stringify(ev.json));
    }
    if (MATCHER_MIN) await matcherTest(btc.price, id);
    else skip('background limit-order fill', 'pass --matcher-test=10 (crypto trades 24/7) or follow the manual checklist in the README');
  } else skip('trading checks', 'no fresh crypto price available (see the quote results above): not testable right now');
  if (!eqOpen) skip('equity market order', `NSE is ${quotes.NIFTYBEES?.market?.label || 'unknown'}; the refusal below is the expected safe behaviour`);
  r = await call('POST', '/api/portfolio/orders', { clientOrderId: crypto.randomUUID(), symbol: 'NIFTYBEES', side: 'buy', type: 'market', qty: 1 });
  if (!eqOpen) check(r.status === 409 && r.json?.code === 'MARKET_UNAVAILABLE', 'market order is refused while NSE is closed', `HTTP ${r.status}`);
  else check(r.status === 200, 'equity market order while NSE is open', `HTTP ${r.status} ${JSON.stringify(r.json)}`);

  // ---- 6. persistence, logout ----
  const before = (await call('GET', '/api/portfolio')).json;
  const oldCookie = cookie; cookie = '';
  r = await call('POST', '/api/auth/login', { email, password: GOOD }); check(r.status === 200, 'log in again from a "new device"', `HTTP ${r.status}`);
  const after = (await call('GET', '/api/portfolio')).json;
  check(after.cash === before.cash && JSON.stringify(after.positions) === JSON.stringify(before.positions) && after.history.length === before.history.length, 'portfolio is identical after a fresh login (stored in the database)');
  r = await call('POST', '/api/auth/logout', {}); check(r.status === 200, 'logout');
  r = await call('GET', '/api/portfolio'); check(r.status === 401, 'portfolio refused after logout');
  cookie = oldCookie; r = await call('GET', '/api/portfolio'); check(r.status === 200, 'a separate session stays valid (logout only ends its own session)'); await call('POST', '/api/auth/logout', {});
  manual('test account', `${email} remains in your database (harmless; delete it in the Neon SQL editor if you like: delete from users where email = '${email}';)`);
}

async function matcherTest(price, id) {
  const lim = Math.floor(price * 0.998);
  const o = await call('POST', '/api/portfolio/orders', { clientOrderId: id(), symbol: 'BTC', side: 'buy', type: 'limit', qty: 0.001, limitPrice: lim });
  if (o.json?.result?.status !== 'open') { skip('background fill', `order was ${o.json?.result?.status || 'rejected'} immediately; price moved before placement`); return; }
  const oid = o.json.result.orderId;
  console.log(`         waiting up to ${MATCHER_MIN} min for BTC to dip to ₹${lim} (0.2% below now). Close this tab if you like: the server does the filling.`);
  const end = Date.now() + MATCHER_MIN * 60e3;
  while (Date.now() < end) {
    await sleep(15000);
    const list = await call('GET', '/api/portfolio/orders?limit=20'); const mine = list.json?.orders?.find((x) => x.id === oid);
    if (mine && mine.status !== 'open') {
      const ev = (await call('GET', `/api/portfolio/orders/${oid}/events`)).json?.events || [];
      check(mine.status === 'filled' && ev.some((e) => e.type === 'filled' && e.actor === 'matcher'), 'limit order filled by the BACKGROUND matcher (actor=matcher)', `status=${mine.status} events=${ev.map((e) => e.type + ':' + e.actor).join(',')}`);
      return;
    }
  }
  await call('DELETE', `/api/portfolio/orders/${oid}`);
  skip('background fill', `price did not reach the limit within ${MATCHER_MIN} minutes; order was cancelled. Try again (crypto moves 0.2% most hours) or use the market-closed procedure in the README`);
}

try { await main(); } catch (e) { fail('verification crashed', e.message); }
const c = (s) => rows.filter((r) => r.status === s).length;
console.log(`\n${c('PASS')} passed, ${c('FAIL')} FAILED, ${c('SKIP')} skipped (NOT verified), ${c('MANUAL')} need you.`);
if (c('FAIL')) console.log('Failed checks mean the site is not fully working: see Troubleshooting in the README.');
process.exit(c('FAIL') ? 1 : 0);
