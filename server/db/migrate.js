import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'migrations');

/** Read-only check used when MIGRATE_ON_START=false: which migrations are pending, and which applied ones this code does not know. */
export async function migrationStatus(db) {
  const files = (await fs.readdir(dir)).filter((f) => f.endsWith('.sql')).sort();
  const has = (await db.query("select to_regclass('public.schema_migrations') as t")).rows[0].t;
  const done = has ? (await db.query('select name from schema_migrations')).rows.map((r) => r.name) : [];
  return { pending: files.filter((f) => !done.includes(f)), unknown: done.filter((d) => !files.includes(d)) };
}

/** Applies every pending migrations/*.sql file in name order, each in its own transaction. */
export async function migrate(db, { log = () => {} } = {}) {
  await db.exec('create table if not exists schema_migrations (name text primary key, applied_at timestamptz not null default now())');
  const files = (await fs.readdir(dir)).filter((f) => f.endsWith('.sql')).sort();
  const applied = [];
  for (const f of files) {
    await db.tx(async (t) => {
      // Serialise concurrent deploys (two instances starting at once) on Postgres.
      if (db.kind === 'pg') { await t.query('select pg_advisory_xact_lock(727274)'); await t.query('set local statement_timeout = 0'); }
      const done = await t.query('select 1 from schema_migrations where name = $1', [f]);
      if (done.rows.length) return;
      await t.exec(await fs.readFile(path.join(dir, f), 'utf8'));
      await t.query('insert into schema_migrations(name) values ($1)', [f]);
      applied.push(f); log(`applied ${f}`);
    });
  }
  return applied;
}

const downDir = path.join(dir, 'down');
/** Reverses the most recently applied migration, but ONLY if a matching migrations/down/<name> file exists (additive migrations such as
 *  004 have one; 001-003 create the core tables and deliberately have none, because rolling them back would delete user data). */
export async function rollbackLast(db, { log = () => {} } = {}) {
  const has = (await db.query("select to_regclass('public.schema_migrations') as t")).rows[0].t;
  if (!has) throw new Error('No migrations have been applied.');
  const last = (await db.query('select name from schema_migrations order by name desc limit 1')).rows[0]?.name;
  if (!last) throw new Error('No migrations have been applied.');
  let sql;
  try { sql = await fs.readFile(path.join(downDir, last), 'utf8'); }
  catch { throw new Error(`Refusing to roll back ${last}: it has no migrations/down/${last} file (it may hold user data). Restore from a Neon backup instead.`); }
  await db.tx(async (t) => {
    if (db.kind === 'pg') { await t.query('select pg_advisory_xact_lock(727274)'); await t.query('set local statement_timeout = 0'); }
    await t.exec(sql);
    await t.query('delete from schema_migrations where name = $1', [last]);
  });
  log(`rolled back ${last}`);
  return last;
}
