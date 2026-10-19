// npm run test:pg : runs the test suite against a REAL PostgreSQL (downloaded by the embedded-postgres dev dependency),
// which proves row locking and constraints on the same engine Neon uses. No manual database setup. Refuses to run as root.
import EmbeddedPostgres from 'embedded-postgres';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ib-pg-'));
const port = 54000 + Math.floor(Math.random() * 900);
const pg = new EmbeddedPostgres({ databaseDir: path.join(dir, 'db'), user: 'postgres', password: 'pw', port, persistent: false, onLog: () => {}, onError: () => {} });
let code = 1;
try {
  await pg.initialise(); await pg.start(); await pg.createDatabase('investbrick_test');
  const r = spawnSync(process.execPath, ['--test', '--test-force-exit', 'test/portfolio.test.js', 'test/engine.test.js'], {
    stdio: 'inherit', env: { ...process.env, TEST_PG_URL: `postgres://postgres:pw@127.0.0.1:${port}/investbrick_test` } });
  code = r.status ?? 1;
} catch (e) { console.error('Could not start the embedded PostgreSQL:', e.message); }
finally { await pg.stop().catch(() => {}); fs.rmSync(dir, { recursive: true, force: true }); }
process.exit(code);
