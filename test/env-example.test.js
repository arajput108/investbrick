import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { parse } from 'dotenv';

const root = path.join(path.dirname(new URL(import.meta.url).pathname), '..');
const read = (f) => fs.readFileSync(path.join(root, f), 'utf8');

test('.env.example exists, documents every variable needed for password-reset email, and contains placeholders only', () => {
  const text = read('.env.example');
  for (const k of ['APP_URL', 'DATABASE_URL', 'EMAIL_PROVIDER', 'BREVO_API_KEY', 'EMAIL_FROM', 'RESET_MAX_PER_HOUR', 'TRUST_PROXY']) {
    assert.match(text, new RegExp(`^#?\\s*${k}=`, 'm'), `${k} should be documented in .env.example`);
  }
  assert.doesNotMatch(text, /xkeysib-[A-Za-z0-9]{16,}/, 'looks like a real Brevo key');
  assert.doesNotMatch(text, /postgres(ql)?:\/\/[^:\s]+:(?!PASSWORD@)[^@\s]{6,}@/, 'looks like a real database URL with a password');
  const active = parse(text);                                       // uncommented lines must be valid and safe defaults
  assert.equal(active.EMAIL_PROVIDER, 'console');
  assert.notEqual(active.NODE_ENV, 'production');
  assert.equal(active.BREVO_API_KEY, undefined, 'secrets must stay commented out in the example');
  assert.equal(active.DATABASE_URL, undefined);
});

test('every secret-like environment variable the server reads is documented in .env.example', () => {
  const text = read('.env.example');
  const vars = new Set();
  for (const dir of ['server', 'scripts']) {
    for (const f of fs.readdirSync(path.join(root, dir), { recursive: true })) {
      if (!String(f).endsWith('.js')) continue;
      for (const m of read(path.join(dir, String(f))).matchAll(/env\.([A-Z][A-Z0-9_]+)/g)) vars.add(m[1]);
    }
  }
  const secretish = [...vars].filter((v) => /(KEY|SECRET|PASS|URL|FROM|PROVIDER)$/.test(v));
  assert.ok(secretish.length >= 5, 'scan should find the real variables');
  for (const v of secretish) assert.match(text, new RegExp(`^#?\\s*${v}=`, 'm'), `${v} is read by the code but missing from .env.example`);
});

test('no API key or credential is hardcoded anywhere in the repository, and none reaches browser code', () => {
  const files = [];
  const walk = (d) => { for (const e of fs.readdirSync(path.join(root, d), { withFileTypes: true })) {
    if (['node_modules', '.git', '.data', 'backups'].includes(e.name)) continue;
    const rel = path.join(d, e.name);
    e.isDirectory() ? walk(rel) : files.push(rel);
  } };
  walk('.');
  // Real Neon endpoints look like ep-cool-name-123456[-pooler].region.aws.neon.tech; fixtures such as "ep-x.neon.tech" do not match.
  const patterns = [/xkeysib-[A-Za-z0-9]{20,}/, /\bAKIA[0-9A-Z]{16}\b/, /postgres(ql)?:\/\/[^:\s'"`]+:(?!PASSWORD@|\$|\{|<|YOUR)[^@\s'"`]{6,}@ep-[a-z0-9]+-[a-z0-9]+-[0-9]{5,}[a-z0-9.-]*\.neon\.tech/i];
  for (const f of files.filter((x) => /\.(js|json|ya?ml|md|html|css|sh|ts|example)$/.test(x) || x.endsWith('Dockerfile'))) {
    const body = read(f);
    for (const p of patterns) assert.doesNotMatch(body, p, `${f} contains something that looks like a real secret (${p})`);
  }
  for (const f of files.filter((x) => x.startsWith('public' + path.sep))) {
    assert.doesNotMatch(read(f), /BREVO|api-key|brevo\.com/i, `${f}: email credentials/endpoints must stay server-side`);
  }
});
