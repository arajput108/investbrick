-- Phase 4: reliable order lifecycle, audit trail and background-matcher bookkeeping.

-- 1. Richer order states. 'rejected' = the engine refused to execute it (and says why); 'expired' = good-till-cancel limit elapsed.
alter table orders drop constraint if exists orders_status_check;
alter table orders add constraint orders_status_check check (status in ('open','filled','cancelled','rejected','expired'));
alter table orders
  add column status_reason  text,                                -- why it ended: user_cancelled, account_reset, expired, insufficient_funds, ...
  add column waiting_reason text,                                -- while open: why it has not filled yet (market_closed, price_stale, ...)
  add column expires_at     timestamptz,
  add column attempts       integer not null default 0,          -- failed execution attempts (database/engine errors)
  add column last_error     text,
  add column filled_at      timestamptz,
  add column filled_price   numeric(18,6);
update orders set filled_at = closed_at where status = 'filled' and filled_at is null;
update orders set expires_at = now() + interval '30 days' where status = 'open' and expires_at is null;   -- existing open orders get a fresh 30 days
update orders set status_reason = 'user_cancelled' where status = 'cancelled' and status_reason is null;
update orders o set filled_price = t.price from transactions t where t.order_id = o.id and o.status = 'filled' and o.filled_price is null;


-- 2. Database-level guarantee: one order can produce at most one fill, no matter what application code does.
create unique index transactions_one_fill_per_order on transactions (order_id) where order_id is not null;
create index orders_open_symbol_idx on orders (symbol) where status = 'open';

-- 3. Append-only audit log of everything that happens to an order. No foreign keys on purpose: the trail survives deletions.
create table order_events (
  id       bigserial primary key,
  order_id uuid not null,
  user_id  uuid not null,
  at       timestamptz not null default now(),
  type     text not null check (type in ('created','filled','cancelled','rejected','expired','deferred','fill_failed')),
  actor    text not null check (actor in ('user','matcher','read','system')),
  detail   jsonb not null default '{}'::jsonb
);
create index order_events_order_idx on order_events (order_id, id);
create index order_events_user_idx on order_events (user_id, id desc);

create function order_events_immutable() returns trigger language plpgsql as $$
begin
  raise exception 'order_events is append-only';
end $$;
create trigger order_events_no_update before update or delete on order_events
  for each row execute function order_events_immutable();

-- Give pre-Phase-4 orders a history in the audit trail (marked as backfilled). Runs once, with the migration.
insert into order_events (order_id, user_id, at, type, actor, detail)
  select id, user_id, created_at, 'created', 'system', jsonb_build_object('backfilled', true, 'side', side, 'type', type) from orders;
insert into order_events (order_id, user_id, at, type, actor, detail)
  select id, user_id, coalesce(closed_at, created_at), status, 'system', jsonb_build_object('backfilled', true) from orders where status in ('filled','cancelled');

-- 4. One row per matcher pass that did anything (or failed): the operational log.
create table engine_runs (
  id          bigserial primary key,
  instance    text not null,
  started_at  timestamptz not null,
  finished_at timestamptz not null default now(),
  symbols     integer not null default 0,
  candidates  integer not null default 0,
  filled      integer not null default 0,
  deferred    integer not null default 0,
  rejected    integer not null default 0,
  expired     integer not null default 0,
  errors      integer not null default 0,
  note        text
);
create index engine_runs_started_idx on engine_runs (started_at desc);

-- 5. Lease so that, with several server instances, one matcher leads at a time. Correctness never depends on it:
--    every fill is protected by row locks, a status check and the unique index above; the lease only avoids wasted work.
create table engine_leases (
  name         text primary key,
  holder       text not null,
  expires_at   timestamptz not null,
  last_tick_at timestamptz,
  last_error   text
);
