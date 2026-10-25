// Brevo integration tested over REAL HTTP: the mailer's own fetch() talks to a local mock of Brevo's API.
// This proves request formation, error mapping, timeouts and secret handling. It does NOT prove that Brevo accepts your key or sender.
import test, { before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createDb } from '../server/db/index.js';
import { migrate } from '../server/db/migrate.js';
import { createPasswords } from '../server/auth/passwords.js';
import { createMailer, resetEmail } from '../server/auth/mailer.js';
import { createAuthService } from '../server/auth/service.js';
import { createAuth } from '../server/auth/routes.js';
import { createApp } from '../server/app.js';

const KEY = 'test-brevo-key-0123456789abcdef';
const GOOD = 'Correct-Horse-7battery';
let mock, mockBase, calls, respond, db;

before(async () => {
  db = await createDb({ driver: 'pglite' }); await migrate(db);
  mock = http.createServer((req, res) => {
    let raw = ''; req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      let body = null; try { body = JSON.parse(raw); } catch { /* keep null */ }
      calls.push({ method: req.method, url: req.url, headers: req.headers, body });
      respond(res);
    });
  }).listen(0);
  await new Promise((r) => mock.once('listening', r));
  mockBase = `http://127.0.0.1:${mock.address().port}`;
});
after(async () => { mock.closeAllConnections(); mock.close(); await db.close(); });
beforeEach(() => { calls = []; respond = (res) => { res.writeHead(201, { 'content-type': 'application/json' }); res.end('{"messageId":"<1@brevo.test>"}'); }; });

const mailerFor = (extra = {}) => createMailer({ provider: 'brevo-api', isProd: true, from: 'InvestBrick <noreply@example.com>', brevo: { apiKey: KEY, url: `${mockBase}/v3/smtp/email`, ...extra } });
const mail = resetEmail({ name: 'Asha', link: 'https://investbrick.example/reset-password#token=abc_DEF-123', minutes: 60 });

test('request is exactly what Brevo documents: POST, api-key header, sender/to/subject/htmlContent/textContent', async () => {
  assert.deepEqual(await mailerFor().send({ to: 'asha@example.com', ...mail }), { delivered: true });
  assert.equal(calls.length, 1);
  const c = calls[0];
  assert.equal(c.method, 'POST'); assert.equal(c.url, '/v3/smtp/email');
  assert.equal(c.headers['api-key'], KEY);
  assert.match(c.headers['content-type'], /^application\/json/); assert.match(c.headers.accept, /application\/json/);
  assert.equal(c.headers.authorization, undefined);                              // the key is only in the api-key header
  assert.deepEqual(Object.keys(c.body).sort(), ['htmlContent', 'sender', 'subject', 'textContent', 'to']);
  assert.deepEqual(c.body.sender, { name: 'InvestBrick', email: 'noreply@example.com' });
  assert.deepEqual(c.body.to, [{ email: 'asha@example.com' }]);
  assert.equal(c.body.subject, 'Reset your InvestBrick password');
  assert.ok(c.body.htmlContent.includes('href="https://investbrick.example/reset-password#token=abc_DEF-123"'));
  assert.ok(c.body.textContent.includes('https://investbrick.example/reset-password#token=abc_DEF-123'));
  assert.ok(!JSON.stringify(c.body).includes(KEY));
});

test('a bare sender address (no display name) is sent as {email} only', async () => {
  await createMailer({ provider: 'brevo-api', isProd: true, from: 'noreply@example.com', brevo: { apiKey: KEY, url: `${mockBase}/v3/smtp/email` } }).send({ to: 'a@b.co', ...mail });
  assert.deepEqual(calls[0].body.sender, { email: 'noreply@example.com' });
});

test('email content escapes the user-controlled name and link (no HTML injection)', () => {
  const m = resetEmail({ name: '<img src=x onerror=alert(1)>', link: 'https://x.example/r#token=a"b<c', minutes: 60 });
  assert.ok(!m.html.includes('<img'));
  assert.ok(m.html.includes('&lt;img'));
  assert.ok(!/href="[^"]*"[^>]*"[^>]*<c/.test(m.html) && !m.html.includes('token=a"b<c'));
});

test('every Brevo failure becomes a short error with only the HTTP status and code: no key, no recipient, no provider message', async () => {
  const cases = [[400, '{"code":"invalid_parameter","message":"to asha@example.com is not valid"}'], [401, '{"code":"unauthorized","message":"Key not found"}'],
    [403, '{"code":"permission_denied"}'], [429, '{"code":"too_many_requests"}'], [500, '<html>boom asha@example.com</html>'], [502, '']];
  for (const [status, body] of cases) {
    respond = (res) => { res.writeHead(status, { 'content-type': body.startsWith('{') ? 'application/json' : 'text/html' }); res.end(body); };
    await assert.rejects(mailerFor().send({ to: 'asha@example.com', ...mail }), (e) => {
      assert.match(e.message, new RegExp(`^Brevo API refused the email \\(HTTP ${status}`));
      assert.ok(!e.message.includes(KEY) && !e.message.includes('asha@example.com') && !/boom|Key not found|not valid/.test(e.message), e.message);
      return true;
    });
  }
});

test('a Brevo server that never answers is abandoned after the timeout instead of hanging forever', async () => {
  respond = () => { /* never respond */ };
  const t0 = Date.now();
  await assert.rejects(mailerFor({ timeoutMs: 150 }).send({ to: 'asha@example.com', ...mail }), (e) => /timeout|abort/i.test(`${e.name} ${e.message}`));
  assert.ok(Date.now() - t0 < 3000);
});

test('Brevo unreachable (connection refused) rejects cleanly', async () => {
  await assert.rejects(createMailer({ provider: 'brevo-api', isProd: true, from: 'a@b.co', brevo: { apiKey: KEY, url: 'http://127.0.0.1:1/v3/smtp/email', timeoutMs: 2000 } }).send({ to: 'a@b.co', ...mail }));
});

function appWith(mailer) {
  const config = { isProd: false, trustProxy: 0, appUrl: 'https://investbrick.example', auth: { resetCooldownSec: 0 }, rateLimits: { loginIp: 1000, loginAcct: 1000, register: 1000, forgot: 1000, reset: 1000, change: 1000 } };
  const service = createAuthService({ db, config, mailer, passwords: createPasswords({ memoryCost: 1024, timeCost: 1 }) });
  const market = { status: () => ({}), instruments: () => [], quotes: async () => ({ quotes: {}, errors: {} }), candles: async () => ({}) };
  const server = createApp({ market, config, auth: createAuth({ service, config }) }).listen(0);
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = async (path, body) => { const r = await fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }); return { status: r.status, json: await r.json().catch(() => null) }; };
  return { service, post, close: () => { server.close(); server.closeAllConnections(); } };
}
let n = 0; const uniq = () => `brevo${Date.now()}${n++}@example.com`;

test('whole flow over real HTTP to the mock Brevo: forgot -> email -> reset -> login; link is single-use', async () => {
  const a = appWith(mailerFor()); const email = uniq();
  assert.equal((await a.post('/api/auth/register', { name: 'Asha Rao', email, password: GOOD })).status, 201);
  const unknown = await a.post('/api/auth/forgot-password', { email: uniq() });
  const known = await a.post('/api/auth/forgot-password', { email });
  await a.service.flushMail();
  assert.equal(known.status, 200); assert.deepEqual(known.json, unknown.json);
  assert.equal(calls.length, 1, 'only the real account gets an email');
  assert.deepEqual(calls[0].body.to, [{ email }]);
  const token = /#token=([A-Za-z0-9_-]+)/.exec(calls[0].body.textContent)[1];
  assert.ok(token.length >= 43, 'a 256-bit token is 43 base64url characters');
  const NEW = 'Brand-New-Passw0rd!';
  assert.equal((await a.post('/api/auth/reset-password', { token, password: NEW })).status, 200);
  assert.equal((await a.post('/api/auth/reset-password', { token, password: 'Another-Passw0rd!x' })).status, 400);
  assert.equal((await a.post('/api/auth/login', { email, password: NEW })).status, 200);
  assert.equal((await a.post('/api/auth/login', { email, password: GOOD })).status, 401);
  a.close();
});

test('when Brevo rejects the key the user sees the same generic answer, and the log shows the cause WITHOUT the key or the address', async () => {
  const a = appWith(mailerFor()); const email = uniq();
  await a.post('/api/auth/register', { name: 'Asha Rao', email, password: GOOD });
  respond = (res) => { res.writeHead(401, { 'content-type': 'application/json' }); res.end('{"code":"unauthorized","message":"Key not found"}'); };
  const lines = []; const orig = process.stdout.write.bind(process.stdout);
  process.stdout.write = (chunk, ...rest) => { lines.push(String(chunk)); return orig(chunk, ...rest); };
  let known, unknown;
  try {
    known = await a.post('/api/auth/forgot-password', { email });
    unknown = await a.post('/api/auth/forgot-password', { email: uniq() });
    await a.service.flushMail();
  } finally { process.stdout.write = orig; }
  assert.equal(known.status, 200); assert.deepEqual(known.json, unknown.json);
  const logged = lines.join('');
  assert.match(logged, /password reset email failed/); assert.match(logged, /HTTP 401/);
  assert.ok(!logged.includes(KEY), 'the API key must never appear in logs');
  assert.ok(!logged.includes(email), 'the user\'s email must never appear in logs');
  a.close();
});
