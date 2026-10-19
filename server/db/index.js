import { log } from '../logger.js';
// Tiny database adapter so the app runs on PostgreSQL (Neon / any Postgres) in production
// and on PGlite (real Postgres compiled to WASM) for zero-setup local dev and automated tests.
// Interface: query(sql, params) -> {rows}; tx(fn) runs fn(client) in a transaction; exec(sql); close().

export async function createDb({ driver = 'pg', url = '', pgliteDir = '', isProd = false } = {}) {
  if (driver === 'pglite') {
    if (isProd) throw new Error('DB_DRIVER=pglite is for development and tests only. Use DATABASE_URL (Postgres) in production.');
    let PGlite;
    try { ({ PGlite } = await import('@electric-sql/pglite')); }
    catch { throw new Error('PGlite is not installed. Run `npm install` (it is a dev dependency).'); }
    const pg = pgliteDir ? new PGlite(pgliteDir) : new PGlite();
    await pg.waitReady;
    const wrap = (c) => ({ query: async (sql, params = []) => ({ rows: (await c.query(sql, params)).rows }), exec: (sql) => c.exec(sql) });
    return {
      kind: 'pglite', ...wrap(pg),
      tx: (fn) => pg.transaction((t) => fn(wrap(t))),
      close: () => pg.close(),
    };
  }
  if (!url) throw new Error('DATABASE_URL is not set');
  const { default: pgPkg } = await import('pg');
  const pool = new pgPkg.Pool({ connectionString: url, max: 10, idleTimeoutMillis: 30000, connectionTimeoutMillis: 10000 });
  pool.on('error', (e) => log.warn('db idle client error (connection will be replaced)', e));
  const wrap = (c) => ({ query: async (sql, params = []) => ({ rows: (await c.query(sql, params)).rows }), exec: (sql) => c.query(sql) });
  return {
    kind: 'pg', ...wrap(pool),
    async tx(fn) {
      const c = await pool.connect();
      try {
        await c.query('BEGIN');
        const out = await fn(wrap(c));
        await c.query('COMMIT');
        return out;
      } catch (e) { try { await c.query('ROLLBACK'); } catch { /* connection may be gone */ } throw e; }
      finally { c.release(); }
    },
    close: () => pool.end(),
  };
}
