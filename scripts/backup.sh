#!/usr/bin/env bash
# Logical backup of the InvestBrick database. Read-only: it never changes the database.
# Usage:  DATABASE_URL='postgres://...' ./scripts/backup.sh [output-dir]
# Needs the PostgreSQL client tools (pg_dump). Output files are secrets-adjacent (they hold user data and
# password hashes): keep them private and NEVER commit them (backups/ is git-ignored).
set -euo pipefail
: "${DATABASE_URL:?Set DATABASE_URL to your Neon connection string first}"
command -v pg_dump >/dev/null || { echo "pg_dump not found. Install the PostgreSQL client tools (see docs/BACKUP_RECOVERY.md)." >&2; exit 1; }
dir="${1:-backups}"; mkdir -p "$dir"; chmod 700 "$dir"
out="$dir/investbrick-$(date -u +%Y%m%dT%H%M%SZ).dump"
umask 077
pg_dump --format=custom --no-owner --no-privileges --file="$out" "$DATABASE_URL"
pg_restore --list "$out" >/dev/null     # proves the file is a readable archive
echo "Backup written: $out ($(du -h "$out" | cut -f1))"
