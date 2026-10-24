-- Undo 004_indexes.sql. Drops only indexes; no data is touched.
drop index if exists transactions_user_page_idx;
drop index if exists idempotency_keys_created_idx;
drop index if exists orders_user_created_idx;
