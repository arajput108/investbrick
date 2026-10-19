-- Phase 3: database-backed paper portfolios. Every row belongs to exactly one user.
-- Money is exact `numeric`; the database itself refuses negative cash and non-positive quantities.

create table portfolios (
  user_id         uuid primary key references users(id) on delete cascade,
  cash            numeric(18,2) not null default 1000000.00 check (cash >= 0),
  starting_cash   numeric(18,2) not null default 1000000.00 check (starting_cash > 0),
  realized_pnl    numeric(18,2) not null default 0,
  epoch           integer not null default 1,           -- bumped by an explicit "reset"; older epochs stay archived
  learning        jsonb not null default '{}'::jsonb,   -- completed lesson/video keys
  guest_import_at timestamptz,                          -- one-time import of guest watchlist/progress
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

create table positions (
  user_id    uuid not null references users(id) on delete cascade,
  symbol     text not null,
  qty        numeric(24,8) not null check (qty > 0),
  cost_basis numeric(18,2) not null check (cost_basis >= 0),   -- total paid for the open quantity; average = cost_basis / qty
  opened_at  timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (user_id, symbol)
);

create table orders (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references users(id) on delete cascade,
  epoch       integer not null,
  symbol      text not null,
  side        text not null check (side in ('buy','sell')),
  type        text not null check (type in ('market','limit')),
  qty         numeric(24,8) not null check (qty > 0),
  limit_price numeric(18,6) check (limit_price is null or limit_price > 0),
  status      text not null check (status in ('open','filled','cancelled')),
  note        text not null default '' check (char_length(note) <= 240),
  created_at  timestamptz not null default now(),
  closed_at   timestamptz,
  constraint orders_limit_matches_type check ((type = 'limit') = (limit_price is not null))
);
create index orders_open_idx on orders (user_id) where status = 'open';

create table transactions (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null references users(id) on delete cascade,
  epoch        integer not null,
  order_id     uuid references orders(id) on delete set null,
  symbol       text not null,
  side         text not null check (side in ('buy','sell')),
  qty          numeric(24,8) not null check (qty > 0),
  price        numeric(18,6) not null check (price > 0),     -- server-side market price at the moment of the fill
  amount       numeric(18,2) not null check (amount >= 0),   -- round(qty * price, 2): exactly what moved in/out of cash
  kind         text not null check (kind in ('Market','Limit','Basket')),
  realized     numeric(18,2),                                -- sells only
  note         text not null default '' check (char_length(note) <= 240),
  price_source text,
  price_as_of  timestamptz,
  created_at   timestamptz not null default now()
);
create index transactions_user_idx on transactions (user_id, epoch, created_at desc);

create table watchlists (
  user_id  uuid not null references users(id) on delete cascade,
  symbol   text not null,
  added_at timestamptz not null default now(),
  primary key (user_id, symbol)
);

create table portfolio_snapshots (
  id             bigserial primary key,
  user_id        uuid not null references users(id) on delete cascade,
  epoch          integer not null,
  taken_at       timestamptz not null default now(),
  cash           numeric(18,2) not null,
  holdings_value numeric(18,2) not null,
  total_value    numeric(18,2) not null,
  realized_pnl   numeric(18,2) not null,
  partial        boolean not null default false              -- true if some holding could not be priced and was valued at cost
);
create index portfolio_snapshots_user_idx on portfolio_snapshots (user_id, epoch, taken_at);

-- Makes retries and double clicks safe: the same key returns the original result instead of trading twice.
create table idempotency_keys (
  user_id    uuid not null references users(id) on delete cascade,
  key        uuid not null,
  result     jsonb not null,
  created_at timestamptz not null default now(),
  primary key (user_id, key)
);

-- Backfill for accounts created in Phase 2. ON CONFLICT DO NOTHING means this can be re-run safely and can
-- never reset an existing balance. Only genuinely new portfolios receive the default watchlist.
with created as (
  insert into portfolios (user_id) select id from users on conflict (user_id) do nothing returning user_id
)
insert into watchlists (user_id, symbol)
  select c.user_id, s from created c, unnest(array['RELIANCE','TCS','HDFCBANK','NIFTYBEES','NIFTY 50','BTC']) as s
  on conflict do nothing;
