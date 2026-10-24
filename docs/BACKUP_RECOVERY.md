# InvestBrick backup and recovery (Neon PostgreSQL)

Status: the commands below are standard PostgreSQL/Neon tooling, but **none were run against your real Neon
project** (the build sandbox cannot reach Neon). `scripts/backup.sh` was only syntax-checked. Do one practice
restore into a throwaway Neon branch before you depend on any of this.

## Two layers of protection
1. **Neon point-in-time restore** (built in). The Free plan keeps roughly 6 hours of history (check
   neon.com/pricing, it can change). Good for "I just broke something". Useless for a problem noticed next week.
2. **Your own dump** (`scripts/backup.sh`). Good for anything older. You must run it yourself; nothing here
   schedules it for you.

## Before every deploy that includes a migration
- Neon console -> your project -> Branches -> create a branch from `production` (a free, instant copy).
  Name it `pre-deploy-YYYYMMDD`. Delete it once the deploy is confirmed healthy (free plans limit branches).
- Or run `./scripts/backup.sh` (needs `pg_dump`; on Mac: `brew install libpq` then add it to PATH).

## Taking a dump
    DATABASE_URL='postgres://...neon.tech/neondb?sslmode=require' ./scripts/backup.sh
Use the **direct** (non-pooler) connection string for dumps. Keep the file private; it contains user emails and
password hashes. Weekly is reasonable for a learning site.

## Restoring
Never restore on top of production first. Rehearse:
1. Create an empty Neon branch (or a new project) and copy its connection string.
2. `pg_restore --no-owner --no-privileges --dbname "$TARGET_URL" backups/<file>.dump`
3. Point a local copy of the app at `$TARGET_URL` (`npm run verify:deploy` / `npm start`) and check you can log in
   and see portfolios.
4. Only when certain, either (a) promote the restored branch / change `DATABASE_URL` in Render to it, or
   (b) use Neon's "Restore" on the production branch to a timestamp.
After any restore, restart the Render service so pooled connections reconnect.

## Migrations and rollback
- Migrations apply automatically at boot, in a transaction, under an advisory lock. Migration 004 only adds indexes.
- To undo the newest migration: `DATABASE_URL=... npm run migrate:down -- --yes`. It refuses if there is no
  `migrations/down/<name>.sql` (001-003 deliberately have none, they create the money tables).
- Rolling back code without rolling back migration 004 is safe: extra indexes are harmless.

## What is NOT covered
No automatic offsite backups, no alerting if a backup fails, no tested restore time. Those are open risks.
