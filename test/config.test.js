import test from 'node:test';
import assert from 'node:assert/strict';
import { productionProblems } from '../server/config.js';
import { createMailer } from '../server/auth/mailer.js';
import { createDb } from '../server/db/index.js';
import { validatePassword, validateEmail } from '../server/auth/validate.js';

const good = { db: { driver: 'pg', url: 'postgres://u:p@ep-x.neon.tech/db?sslmode=require' }, appUrl: 'https://investbrick.example', email: { provider: 'smtp', smtp: { host: 'smtp.x' } }, trustProxy: 1 };
test('production config: accepts a complete setup, rejects every unsafe default', () => {
  assert.deepEqual(productionProblems(good), []);
  assert.ok(productionProblems({ ...good, db: { driver: 'pg', url: '' } }).some((p) => /DATABASE_URL/.test(p)));
  assert.ok(productionProblems({ ...good, db: { driver: 'pglite', url: 'x' } }).some((p) => /DB_DRIVER/.test(p)));
  assert.ok(productionProblems({ ...good, appUrl: 'http://x.com' }).some((p) => /APP_URL/.test(p)));
  assert.ok(productionProblems({ ...good, email: { provider: 'console', smtp: {} } }).some((p) => /EMAIL_PROVIDER/.test(p)));
  assert.ok(productionProblems({ ...good, email: { provider: 'smtp', smtp: { host: '' } } }).some((p) => /SMTP_HOST/.test(p)));
  assert.ok(productionProblems({ ...good, trustProxy: 0 }).some((p) => /TRUST_PROXY/.test(p)));
});
test('dev-only drivers refuse to run in production', async () => {
  assert.throws(() => createMailer({ provider: 'console', isProd: true }), /not allowed in production/);
  await assert.rejects(createDb({ driver: 'pglite', isProd: true }), /development and tests only/);
  await assert.rejects(createDb({ driver: 'pg', url: '' }), /DATABASE_URL/);
});
test('password and email rules', () => {
  assert.ok(validatePassword('short1'));
  assert.ok(validatePassword('Password123'));
  assert.ok(validatePassword('aaaaaaaaaaaa'));
  assert.equal(validatePassword('Correct-Horse-7battery', { email: 'x@y.com' }), null);
  assert.equal(validatePassword('उपयोगकर्ता-पासवर्ड-12'), null);                 // unicode allowed
  assert.equal(validateEmail('a.b+c@sub.example.co.in'), null);
  for (const bad of ['', 'a@b', 'a b@c.com', '@x.com', 'a@@b.com', 'a@b..com']) assert.ok(validateEmail(bad), bad);
});
