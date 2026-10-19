-- Phase 2: accounts, sessions, password resets.
create table users (
  id                  uuid primary key default gen_random_uuid(),
  email               text not null,
  display_name        text not null,
  password_hash       text not null,            -- argon2id PHC string; never the password
  failed_logins       integer not null default 0,
  locked_until        timestamptz,
  password_changed_at timestamptz not null default now(),
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  constraint users_email_lowercase check (email = lower(email)),
  constraint users_email_length check (char_length(email) between 3 and 254),
  constraint users_name_length check (char_length(display_name) between 1 and 60)
);
create unique index users_email_key on users (email);

-- Only a SHA-256 hash of the session token is stored, so a database leak cannot be replayed as logins.
create table sessions (
  token_hash   text primary key,
  user_id      uuid not null references users(id) on delete cascade,
  created_at   timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  expires_at   timestamptz not null,
  ip           text,
  user_agent   text
);
create index sessions_user_idx on sessions (user_id);
create index sessions_expires_idx on sessions (expires_at);

create table password_resets (
  token_hash text primary key,
  user_id    uuid not null references users(id) on delete cascade,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  used_at    timestamptz
);
create index password_resets_user_idx on password_resets (user_id, created_at desc);
