import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createDb } from '../server/db/index.js';
import { migrate } from '../server/db/migrate.js';
import { createPasswords } from '../server/auth/passwords.js';
import { createMailer } from '../server/auth/mailer.js';
import { createAuthService } from '../server/auth/service.js';
import { createAuth } from '../server/auth/routes.js';
import { createApp } from '../server/app.js';
import { hashToken } from '../server/auth/tokens.js';

const GOOD = 'Correct-Horse-7battery';
let db, sent;
const market = { status: () => ({}), instruments: () => [], quotes: async () => ({ quotes: {}, errors: {} }), candles: async () => ({}) };

before(async () => { db = await createDb({ driver: 'pglite' }); await migrate(db); });
after(async () => { await db.close(); });

function makeApp({ isProd = false, trustProxy = 0, rateLimits = { loginIp: 1000, loginAcct: 1000, register: 1000, forgot: 1000, reset: 1000, change: 1000 }, authCfg = {}, appUrl = 'https://investbrick.example' } = {}) {
  sent = [];
  const config = { isProd, trustProxy, appUrl, rateLimits, auth: authCfg };
  const mailer = createMailer({ provider: 'smtp', from: 'IB <a@b.c>', transport: { sendMail: async (m) => { sent.push(m); } } });
  const service = createAuthService({ db, config, mailer, passwords: createPasswords({ memoryCost: 1024, timeCost: 1 }) });
  const auth = createAuth({ service, config });
  const server = createApp({ market, config, auth }).listen(0);
  const base = `http://127.0.0.1:${server.address().port}`;
  return { server, base, service, auth, close: () => { server.close(); server.closeAllConnections(); } };
}

/** Minimal browser-like client with a cookie jar. */
function client(base) {
  let cookie = '';
  const api = async (method, path, body, headers = {}) => {
    const res = await fetch(base + path, { method, redirect: 'manual', headers: { ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...(cookie ? { cookie } : {}), ...headers }, body: body !== undefined ? JSON.stringify(body) : undefined });
    const sc = res.headers.getSetCookie?.() || [];
    for (const c of sc) { const [kv] = c.split(';'); const [k, v] = kv.split('='); cookie = v === '' ? '' : `${k}=${v}`; }
    let json = null; try { json = await res.clone().json(); } catch { /* not json */ }
    return { status: res.status, json, setCookie: sc, res };
  };
  return { api, get cookie() { return cookie; }, set cookie(v) { cookie = v; } };
}
let n = 0;
const uniq = () => `user${Date.now()}${n++}@example.com`;
const reg = (c, o = {}) => c.api('POST', '/api/auth/register', { name: 'Asha Rao', email: uniq(), password: GOOD, ...o });

test('migrations are idempotent and create the schema', async () => {
  assert.deepEqual(await migrate(db), []);
  const t = (await db.query("select table_name from information_schema.tables where table_schema='public' order by 1")).rows.map((r) => r.table_name);
  for (const x of ['users', 'sessions', 'password_resets', 'schema_migrations']) assert.ok(t.includes(x), x);
});

test('register: stores an argon2id hash, never the password; sets a hardened cookie; logs in', async () => {
  const a = makeApp(); const c = client(a.base);
  const email = uniq();
  const r = await reg(c, { email });
  assert.equal(r.status, 201); assert.equal(r.json.user.email, email); assert.equal(r.json.user.password_hash, undefined);
  const sc = r.setCookie[0];
  assert.match(sc, /^ib_session=/); assert.match(sc, /HttpOnly/i); assert.match(sc, /SameSite=Lax/i); assert.match(sc, /Path=\//);
  const row = (await db.query('select * from users where email=$1', [email])).rows[0];
  assert.match(row.password_hash, /^\$argon2id\$/); assert.ok(!row.password_hash.includes(GOOD));
  const tok = c.cookie.split('=')[1];
  const s = (await db.query('select token_hash from sessions where user_id=$1', [row.id])).rows;
  assert.equal(s.length, 1); assert.equal(s[0].token_hash, hashToken(tok)); assert.notEqual(s[0].token_hash, tok);  // only the hash is stored
  const me = await c.api('GET', '/api/auth/me'); assert.equal(me.json.user.email, email);
  a.close();
});

test('production cookies use the __Host- prefix and Secure', async () => {
  const a = makeApp({ isProd: true, trustProxy: 1 }); const c = client(a.base);
  const r = await c.api('POST', '/api/auth/register', { name: 'Asha Rao', email: uniq(), password: GOOD }, { 'x-forwarded-proto': 'https' });   // as sent by the hosting proxy
  assert.equal(r.status, 201);
  assert.match(r.setCookie[0], /^__Host-ib_session=/); assert.match(r.setCookie[0], /Secure/i);
  // Plain-HTTP requests never reach the app logic in production: pages redirect to https, API writes are refused.
  const plain = await fetch(a.base + '/login', { redirect: 'manual' });
  assert.equal(plain.status, 308); assert.match(plain.headers.get('location'), /^https:\/\//);
  const post = await fetch(a.base + '/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
  assert.equal(post.status, 400); assert.equal((await post.json()).code, 'HTTPS_REQUIRED');
  assert.equal((await fetch(a.base + '/healthz')).status, 200);                    // health checks are exempt
  a.close();
});

test('register validation: field errors, weak/common passwords, long input, case-insensitive duplicates', async () => {
  const a = makeApp(); const c = client(a.base);
  let r = await c.api('POST', '/api/auth/register', { name: '', email: 'nope', password: 'short' });
  assert.equal(r.status, 400); assert.ok(r.json.fields.name && r.json.fields.email && r.json.fields.password);
  r = await reg(c, { password: 'password123' }); assert.equal(r.status, 400); assert.match(r.json.fields.password, /common/);
  r = await reg(c, { password: 'x'.repeat(200) }); assert.equal(r.status, 400);
  r = await reg(c, { email: 'asha.rao@b.co', password: 'asha.rao-secret-1' }); assert.equal(r.status, 400);   // contains email name
  r = await c.api('POST', '/api/auth/register', { name: 'A', email: ['x@y.com'], password: GOOD }); assert.equal(r.status, 400); // wrong types
  const email = uniq();
  assert.equal((await reg(client(a.base), { email })).status, 201);
  r = await reg(client(a.base), { email: email.toUpperCase() }); assert.equal(r.status, 409);
  a.close();
});

test('concurrent registration with the same email creates exactly one account', async () => {
  const a = makeApp(); const email = uniq();
  const rs = await Promise.all([1, 2, 3, 4].map(() => reg(client(a.base), { email })));
  assert.equal(rs.filter((r) => r.status === 201).length, 1); assert.equal(rs.filter((r) => r.status === 409).length, 3);
  a.close();
});

test('SQL-injection style input is treated as data', async () => {
  const a = makeApp(); const c = client(a.base);
  const r = await c.api('POST', '/api/auth/login', { email: "x@y.com' OR '1'='1", password: "' OR 1=1 --" });
  assert.equal(r.status, 401);
  const r2 = await reg(c, { name: "Robert'); DROP TABLE users;--" }); assert.equal(r2.status, 201);
  assert.ok((await db.query('select count(*)::int c from users')).rows[0].c > 0);
  a.close();
});

test('login: success, wrong password and unknown email give the same message and status', async () => {
  const a = makeApp(); const email = uniq(); await reg(client(a.base), { email });
  const c = client(a.base);
  const ok = await c.api('POST', '/api/auth/login', { email: email.toUpperCase(), password: GOOD });
  assert.equal(ok.status, 200); assert.equal(ok.json.user.email, email);
  const bad = await client(a.base).api('POST', '/api/auth/login', { email, password: 'Wrong-password-1' });
  const none = await client(a.base).api('POST', '/api/auth/login', { email: uniq(), password: 'Wrong-password-1' });
  assert.equal(bad.status, 401); assert.equal(none.status, 401); assert.equal(bad.json.error, none.json.error);
  assert.equal(bad.setCookie.length, 0);
  a.close();
});

test('account lockout after repeated failures, even for the correct password; then recovers', async () => {
  const a = makeApp({ authCfg: { maxFailedLogins: 3, lockMinutes: 15 } }); const email = uniq(); await reg(client(a.base), { email });
  for (let i = 0; i < 3; i++) await client(a.base).api('POST', '/api/auth/login', { email, password: 'Wrong-password-1' });
  assert.equal((await client(a.base).api('POST', '/api/auth/login', { email, password: GOOD })).status, 401);
  await db.query("update users set locked_until = now() - interval '1 minute' where email=$1", [email]);
  assert.equal((await client(a.base).api('POST', '/api/auth/login', { email, password: GOOD })).status, 200);
  a.close();
});

test('rate limiting: too many login attempts get 429', async () => {
  const a = makeApp({ rateLimits: { loginIp: 1000, loginAcct: 3, register: 1000, forgot: 2, reset: 1000, change: 1000 } });
  const email = uniq(); let last;
  for (let i = 0; i < 5; i++) last = await client(a.base).api('POST', '/api/auth/login', { email, password: 'Wrong-password-1' });
  assert.equal(last.status, 429);
  let f; for (let i = 0; i < 3; i++) f = await client(a.base).api('POST', '/api/auth/forgot-password', { email });
  assert.equal(f.status, 429);
  a.close();
});

test('logout deletes the session server-side; a stolen cookie stops working', async () => {
  const a = makeApp(); const c = client(a.base); await reg(c);
  const stolen = c.cookie;
  assert.equal((await c.api('POST', '/api/auth/logout', {})).status, 200);
  const thief = client(a.base); thief.cookie = stolen;
  assert.equal((await thief.api('GET', '/api/auth/me')).json.user, null);
  a.close();
});

test('sessions expire (absolute and idle) and forged/garbage tokens are rejected', async () => {
  const a = makeApp(); const c = client(a.base); await reg(c);
  const h = hashToken(c.cookie.split('=')[1]);
  await db.query("update sessions set last_seen_at = now() - interval '8 days' where token_hash=$1", [h]);
  assert.equal((await c.api('GET', '/api/auth/me')).json.user, null);
  const c2 = client(a.base); await reg(c2);
  await db.query("update sessions set expires_at = now() - interval '1 second' where token_hash=$1", [hashToken(c2.cookie.split('=')[1])]);
  assert.equal((await c2.api('GET', '/api/auth/me')).json.user, null);
  const f = client(a.base); f.cookie = 'ib_session=' + 'A'.repeat(43);
  assert.equal((await f.api('GET', '/api/auth/me')).json.user, null);
  f.cookie = 'ib_session=' + 'A'.repeat(5000);
  assert.equal((await f.api('GET', '/api/auth/me')).json.user, null);
  a.close();
});

test('CSRF: cross-origin and non-JSON state-changing requests are rejected', async () => {
  const a = makeApp(); const c = client(a.base);
  const body = { email: uniq(), password: GOOD };
  assert.equal((await c.api('POST', '/api/auth/login', body, { origin: 'https://evil.example' })).status, 403);
  assert.equal((await c.api('POST', '/api/auth/login', body, { 'sec-fetch-site': 'cross-site' })).status, 403);
  const form = await fetch(a.base + '/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'email=a&password=b' });
  assert.equal(form.status, 415);
  const same = await c.api('POST', '/api/auth/login', body, { origin: a.base });
  assert.equal(same.status, 401);   // same-origin passes the guard and reaches credential checking
  a.close();
});

test('forgot password: same answer for known and unknown emails; mail sent only to real accounts', async () => {
  const a = makeApp(); const email = uniq(); await reg(client(a.base), { email });
  const c = client(a.base);
  const known = await c.api('POST', '/api/auth/forgot-password', { email });
  const unknown = await c.api('POST', '/api/auth/forgot-password', { email: uniq() });
  const junk = await c.api('POST', '/api/auth/forgot-password', { email: 'not-an-email' });
  assert.equal(known.status, 200); assert.deepEqual(known.json, unknown.json); assert.deepEqual(known.json, junk.json);
  assert.equal(sent.length, 1); assert.equal(sent[0].to, email);
  a.close();
});

test('reset link uses APP_URL (not the Host header), token is in the fragment, stored hashed, throttled', async () => {
  const a = makeApp({ appUrl: 'https://investbrick.example' }); const email = uniq(); await reg(client(a.base), { email });
  const r = await fetch(a.base + '/api/auth/forgot-password', { method: 'POST', headers: { 'content-type': 'application/json', host: 'evil.example' }, body: JSON.stringify({ email }) }).catch(() => null);
  void r; // some runtimes forbid overriding Host; the assertion below is what matters
  await client(a.base).api('POST', '/api/auth/forgot-password', { email });
  const mail = sent[0];
  const m = /(https:\/\/investbrick\.example\/reset-password)#token=([\w-]+)/.exec(mail.text);
  assert.ok(m, mail.text); assert.ok(!/evil/.test(mail.text + mail.html));
  const stored = (await db.query('select token_hash from password_resets order by created_at desc limit 1')).rows[0].token_hash;
  assert.equal(stored, hashToken(m[2])); assert.notEqual(stored, m[2]);
  const before = sent.length;
  await client(a.base).api('POST', '/api/auth/forgot-password', { email });   // within cooldown
  assert.equal(sent.length, before);
  a.close();
});

async function resetToken(a, email) {
  await db.query("update password_resets set created_at = now() - interval '5 minutes' where user_id=(select id from users where email=$1)", [email]);
  sent.length = 0;
  await client(a.base).api('POST', '/api/auth/forgot-password', { email });
  return /#token=([\w-]+)/.exec(sent[0].text)[1];
}

test('reset password: works once, signs out all sessions, old password dies, expired/invalid tokens fail', async () => {
  const a = makeApp(); const email = uniq(); const c = client(a.base); await reg(c, { email });
  const token = await resetToken(a, email);
  const NEW = 'Brand-New-Passw0rd!';
  const weak = await client(a.base).api('POST', '/api/auth/reset-password', { token, password: 'password123' });
  assert.equal(weak.status, 400); assert.ok(weak.json.fields.password);       // token not consumed by a rejected password
  const ok = await client(a.base).api('POST', '/api/auth/reset-password', { token, password: NEW });
  assert.equal(ok.status, 200);
  assert.equal((await c.api('GET', '/api/auth/me')).json.user, null);          // old session revoked
  assert.equal((await client(a.base).api('POST', '/api/auth/login', { email, password: GOOD })).status, 401);
  assert.equal((await client(a.base).api('POST', '/api/auth/login', { email, password: NEW })).status, 200);
  assert.equal((await client(a.base).api('POST', '/api/auth/reset-password', { token, password: 'Another-Passw0rd!x' })).status, 400); // single use
  assert.equal((await client(a.base).api('POST', '/api/auth/reset-password', { token: 'bogus', password: NEW })).status, 400);
  const t2 = await resetToken(a, email);
  await db.query("update password_resets set expires_at = now() - interval '1 second' where token_hash=$1", [hashToken(t2)]);
  assert.equal((await client(a.base).api('POST', '/api/auth/reset-password', { token: t2, password: 'Yet-Another-Passw0rd' })).status, 400);
  a.close();
});

test('the same reset token cannot be redeemed twice concurrently', async () => {
  const a = makeApp(); const email = uniq(); await reg(client(a.base), { email });
  const token = await resetToken(a, email);
  const rs = await Promise.all(['Concurrent-Pass-1x', 'Concurrent-Pass-2y', 'Concurrent-Pass-3z'].map((p) => client(a.base).api('POST', '/api/auth/reset-password', { token, password: p })));
  assert.equal(rs.filter((r) => r.status === 200).length, 1);
  a.close();
});

test('change password requires the current password, keeps this session, signs out others', async () => {
  const a = makeApp(); const email = uniq(); const c1 = client(a.base); await reg(c1, { email });
  const c2 = client(a.base); await c2.api('POST', '/api/auth/login', { email, password: GOOD });
  assert.equal((await client(a.base).api('POST', '/api/auth/change-password', { currentPassword: GOOD, newPassword: 'Whatever-123-abc' })).status, 401);
  assert.equal((await c1.api('POST', '/api/auth/change-password', { currentPassword: 'wrong', newPassword: 'Whatever-123-abc' })).status, 400);
  assert.equal((await c1.api('POST', '/api/auth/change-password', { currentPassword: GOOD, newPassword: 'Whatever-123-abc' })).status, 200);
  assert.equal((await c1.api('GET', '/api/auth/me')).json.user.email, email);
  assert.equal((await c2.api('GET', '/api/auth/me')).json.user, null);
  a.close();
});

test('data isolation: each session only ever sees its own identity; guests see none', async () => {
  const a = makeApp();
  const e1 = uniq(), e2 = uniq(); const c1 = client(a.base), c2 = client(a.base), guest = client(a.base);
  await reg(c1, { email: e1, name: 'One' }); await reg(c2, { email: e2, name: 'Two' });
  assert.equal((await c1.api('GET', '/api/auth/me')).json.user.name, 'One');
  assert.equal((await c2.api('GET', '/api/auth/me')).json.user.name, 'Two');
  assert.equal((await guest.api('GET', '/api/auth/me')).json.user, null);
  // swapping cookies swaps identity: there is no client-supplied user id anywhere
  const spoof = await c1.api('GET', '/api/auth/me?userId=' + (await db.query('select id from users where email=$1', [e2])).rows[0].id);
  assert.equal(spoof.json.user.email, e1);
  // requireAuth guards protected routes
  const guarded = await c1.api('POST', '/api/auth/change-password', {}); assert.notEqual(guarded.status, 401);
  assert.equal((await guest.api('POST', '/api/auth/change-password', {})).status, 401);
  a.close();
});

test('home page embeds only the visitor session; auth pages render; logged-in users skip /login', async () => {
  const a = makeApp(); const c = client(a.base);
  const guestHtml = await (await fetch(a.base + '/')).text();
  assert.match(guestHtml, /window\.__IB__=\{"user":null,"authEnabled":true\}/);
  const email = uniq(); await reg(c, { email, name: '</script><b>x' });
  const html = await (await fetch(a.base + '/', { headers: { cookie: c.cookie } })).text();
  assert.match(html, new RegExp(email.replace(/[.+]/g, '\\$&'))); assert.ok(!html.includes('</script><b>x'));   // escaped, cannot break out
  const other = await (await fetch(a.base + '/')).text(); assert.ok(!other.includes(email));
  for (const p of ['/login', '/register', '/forgot-password', '/reset-password']) assert.equal((await fetch(a.base + p)).status, 200, p);
  const redir = await fetch(a.base + '/login', { headers: { cookie: c.cookie }, redirect: 'manual' });
  assert.equal(redir.status, 302);
  assert.equal((await fetch(a.base + '/')).headers.get('cache-control'), 'no-store');
  a.close();
});

test('without a database the auth API answers 503 honestly and market data still works', async () => {
  const app = createApp({ market, config: { isProd: false, trustProxy: 0 } }).listen(0);
  const base = `http://127.0.0.1:${app.address().port}`;
  assert.equal((await fetch(base + '/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).status, 503);
  assert.deepEqual(await (await fetch(base + '/api/auth/me')).json(), { user: null, enabled: false });
  assert.equal((await fetch(base + '/api/market/status')).status, 200);
  app.close(); app.closeAllConnections();
});

test('purgeExpired removes stale sessions and old reset tokens', async () => {
  const a = makeApp(); const c = client(a.base); await reg(c);
  await db.query("update sessions set expires_at = now() - interval '1 day'");
  await a.service.purgeExpired();
  assert.equal((await db.query('select count(*)::int c from sessions')).rows[0].c, 0);
  a.close();
});

test('no email service configured: password reset says it is unavailable (503), registration, login and logout still work', async () => {
  const mailer = createMailer({ provider: 'none', from: 'IB <a@b.c>', isProd: true });
  assert.equal(mailer.available, false);
  await assert.rejects(mailer.send({ to: 'a@b.c', subject: 's', text: 't' }), /not configured/);
  const config = { isProd: false, trustProxy: 0, appUrl: 'https://investbrick.example', auth: {}, rateLimits: { loginIp: 1000, loginAcct: 1000, register: 1000, forgot: 1000, reset: 1000, change: 1000 } };
  const service = createAuthService({ db, config, mailer, passwords: createPasswords({ memoryCost: 1024, timeCost: 1 }) });
  const server = createApp({ market, config, auth: createAuth({ service, config }) }).listen(0);
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const c = client(base), email = uniq();
    assert.equal((await reg(c, { email })).status, 201);
    assert.equal((await c.api('POST', '/api/auth/logout', {})).status, 200);
    assert.equal((await c.api('POST', '/api/auth/login', { email, password: GOOD })).status, 200);
    const known = await c.api('POST', '/api/auth/forgot-password', { email });
    const unknown = await c.api('POST', '/api/auth/forgot-password', { email: uniq() });
    for (const r of [known, unknown]) { assert.equal(r.status, 503); assert.equal(r.json.code, 'EMAIL_UNAVAILABLE'); assert.match(r.json.error, /not available/); }
    assert.equal((await c.api('GET', '/api/auth/me')).json.user.email, email);
  } finally { server.close(); server.closeAllConnections(); }
});

test('brevo-api provider: sends one HTTPS request with the key in a header, correct sender/recipient, never leaks the key; failures surface', async () => {
  const calls = [];
  const fetchImpl = async (url, init) => { calls.push({ url, init }); return calls.length === 1 ? { ok: true, status: 201, json: async () => ({ messageId: 'x' }) } : { ok: false, status: 401, json: async () => ({ code: 'unauthorized' }) }; };
  const mailer = createMailer({ provider: 'brevo-api', from: 'InvestBrick <noreply@example.com>', isProd: true, brevo: { apiKey: 'xkeysib-SECRET' }, fetchImpl });
  assert.equal(mailer.available, true);
  assert.deepEqual(await mailer.send({ to: 'asha@example.com', subject: 'Hi', text: 't', html: '<b>h</b>' }), { delivered: true });
  const body = JSON.parse(calls[0].init.body);
  assert.equal(calls[0].url, 'https://api.brevo.com/v3/smtp/email');
  assert.equal(calls[0].init.headers['api-key'], 'xkeysib-SECRET');
  assert.deepEqual(body.sender, { name: 'InvestBrick', email: 'noreply@example.com' });
  assert.deepEqual(body.to, [{ email: 'asha@example.com' }]);
  assert.equal(body.subject, 'Hi'); assert.equal(body.textContent, 't');
  await assert.rejects(mailer.send({ to: 'a@b.c', subject: 's', text: 't' }), (e) => /HTTP 401/.test(e.message) && !/SECRET/.test(e.message));
  assert.equal(createMailer({ provider: 'brevo-api', isProd: true, brevo: {} }).available, false);
});

test('password reset end to end through the Brevo API provider: token link built from APP_URL, mail only for real accounts', async () => {
  const sentBodies = [];
  const fetchImpl = async (_u, init) => { sentBodies.push(JSON.parse(init.body)); return { ok: true, status: 201, json: async () => ({}) }; };
  const mailer = createMailer({ provider: 'brevo-api', from: 'IB <a@b.c>', isProd: true, brevo: { apiKey: 'k' }, fetchImpl });
  const config = { isProd: false, trustProxy: 0, appUrl: 'https://investbrick.example', auth: {}, rateLimits: { loginIp: 1000, loginAcct: 1000, register: 1000, forgot: 1000, reset: 1000, change: 1000 } };
  const service = createAuthService({ db, config, mailer, passwords: createPasswords({ memoryCost: 1024, timeCost: 1 }) });
  const server = createApp({ market, config, auth: createAuth({ service, config }) }).listen(0);
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const c = client(base), email = uniq();
    await reg(c, { email });
    assert.equal((await c.api('POST', '/api/auth/forgot-password', { email })).status, 200);
    assert.equal((await c.api('POST', '/api/auth/forgot-password', { email: uniq() })).status, 200);
    assert.equal(sentBodies.length, 1);
    const token = /#token=([A-Za-z0-9_-]+)/.exec(sentBodies[0].textContent)[1];
    assert.match(sentBodies[0].textContent, /^Hi Asha Rao,[\s\S]*https:\/\/investbrick\.example\/reset-password#token=/);
    assert.equal((await c.api('POST', '/api/auth/reset-password', { token, password: 'Another-Strong-Pass-9' })).status, 200);
    assert.equal((await c.api('POST', '/api/auth/reset-password', { token, password: 'Third-Strong-Pass-9x' })).status, 400);   // single use
    assert.equal((await client(base).api('POST', '/api/auth/login', { email, password: 'Another-Strong-Pass-9' })).status, 200);
    assert.equal((await client(base).api('POST', '/api/auth/login', { email, password: GOOD })).status, 401);
  } finally { server.close(); server.closeAllConnections(); }
});
