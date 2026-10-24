-- Backend hardening: supporting indexes. Additive only (no table is rewritten, no data changes), safe to run on production.
-- Rollback: migrations/down/004_indexes.sql   (npm run migrate:down -- --yes)

-- Order log, order list and cursor pagination read "this user's orders, newest first".
create index if not exists orders_user_created_idx on orders (user_id, created_at desc, id desc);
-- The hourly purge of old idempotency keys filters on created_at.
create index if not exists idempotency_keys_created_idx on idempotency_keys (created_at);
-- Transaction list pagination: newest first within the user's current epoch, with a stable tiebreak on id.
create index if not exists transactions_user_page_idx on transactions (user_id, epoch, created_at desc, id desc);
