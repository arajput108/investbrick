// npm run migrate : apply pending database migrations (also runs automatically at server start).
import { config } from '../server/config.js';
import { createDb } from '../server/db/index.js';
import { migrate } from '../server/db/migrate.js';
const db = await createDb({ driver: config.db.driver, url: config.db.url, pgliteDir: config.db.pgliteDir, isProd: config.isProd });
const applied = await migrate(db, { log: (m) => console.log(m) });
console.log(applied.length ? `Done: ${applied.length} migration(s) applied.` : 'Database already up to date.');
await db.close();
