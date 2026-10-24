// npm run migrate : apply pending database migrations (also runs automatically at server start).
import { config } from '../server/config.js';
import { createDb } from '../server/db/index.js';
import { migrate, rollbackLast } from '../server/db/migrate.js';
const db = await createDb({ driver: config.db.driver, url: config.db.url, pgliteDir: config.db.pgliteDir, isProd: config.isProd });
if (process.argv.includes('--down')) {
  if (!process.argv.includes('--yes')) { console.error('This undoes the newest migration (only possible for additive ones). Re-run with --yes to confirm:  npm run migrate:down -- --yes'); await db.close(); process.exit(2); }
  try { console.log('Rolled back:', await rollbackLast(db, { log: console.log })); } catch (e) { console.error(e.message); await db.close(); process.exit(1); }
  await db.close(); process.exit(0);
}
const applied = await migrate(db, { log: (m) => console.log(m) });
console.log(applied.length ? `Done: ${applied.length} migration(s) applied.` : 'Database already up to date.');
await db.close();
