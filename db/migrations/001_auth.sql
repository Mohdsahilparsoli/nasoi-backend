-- NASOI · 001 · Login module
-- Run once in Supabase → SQL Editor (or `npm run db:migrate`).
-- Safe to re-run: every statement is idempotent.

create table if not exists users (
  id                   text primary key,                         -- DEO126, VR101, ADMIN …
  role                 text not null check (role in ('deo', 'verifier', 'admin')),
  name                 text not null,
  mobile               text unique check (mobile ~ '^[6-9][0-9]{9}$'),
  email                text,
  password_hash        text not null,                            -- bcrypt, never plain text
  status               text not null default 'active' check (status in ('active', 'blocked')),
  failed_login_count   integer not null default 0,
  locked_until         timestamptz,
  last_login_at        timestamptz,
  password_changed_at  timestamptz,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now()
);
create unique index if not exists users_id_lower_key    on users (lower(id));
create unique index if not exists users_email_lower_key on users (lower(email)) where email is not null;

create table if not exists auth_sessions (
  id               uuid primary key default gen_random_uuid(),
  user_id          text not null references users (id) on delete cascade,
  role             text not null check (role in ('deo', 'verifier', 'admin')),
  token_hash       text not null,                                -- sha256 of the refresh secret
  prev_token_hash  text,                                         -- previous one, to detect replay
  rotated_at       timestamptz,
  ip               text,
  user_agent       text,
  created_at       timestamptz not null default now(),
  last_used_at     timestamptz not null default now(),
  expires_at       timestamptz not null,
  revoked_at       timestamptz,
  revoke_reason    text
);
create index if not exists auth_sessions_user_idx on auth_sessions (user_id) where revoked_at is null;

create table if not exists audit_logs (
  id          bigint generated always as identity primary key,
  user_id     text references users (id) on delete set null,
  action      text not null,
  ip          text,
  user_agent  text,
  meta        jsonb not null default '{}'::jsonb,
  created_at  timestamptz not null default now()
);
create index if not exists audit_logs_user_idx on audit_logs (user_id, created_at desc);
create index if not exists audit_logs_action_idx on audit_logs (action, created_at desc);

create or replace function set_updated_at() returns trigger language plpgsql as $$
begin new.updated_at = now(); return new; end $$;
drop trigger if exists users_updated_at on users;
create trigger users_updated_at before update on users for each row execute function set_updated_at();

-- Supabase exposes the public schema through its REST API (anon / authenticated keys).
-- Only our backend may touch these tables: enable RLS with no policies and revoke access.
alter table users          enable row level security;
alter table auth_sessions  enable row level security;
alter table audit_logs     enable row level security;
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    revoke all on users, auth_sessions, audit_logs from anon, authenticated;
  end if;
end $$;
