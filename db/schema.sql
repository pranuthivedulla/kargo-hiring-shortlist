-- Kargo hiring shortlist — schema (Postgres / Neon)
--
-- Run once against your Neon database:
--   psql "$DATABASE_URL" -f db/schema.sql
-- or paste into the Neon console's SQL Editor.
--
-- Three tables, matching the three things the app writes at runtime. The CVs,
-- job descriptions and calibration profiles are NOT here: they never change
-- while the app runs, so they ship read-only inside the repo.
--
-- There is no end-user auth. Access is through DATABASE_URL from route
-- handlers only; that connection string must never reach the browser.

-- ---------------------------------------------------------------------------
-- candidates — the ingestion cache (parsed CV text, keyed by source file)
-- ---------------------------------------------------------------------------
create table if not exists candidates (
  id           text primary key,
  name         text        not null,
  role         text        not null check (role in ('PM', 'SPM')),
  file         text        not null,
  format       text        not null,
  chars        integer     not null default 0,
  text         text        not null default '',
  parse_error  text,
  ingested_at  timestamptz not null default now()
);

create index if not exists candidates_role_idx on candidates (role);

-- ---------------------------------------------------------------------------
-- runs — one row per batch run, holding the full structured model response
-- ---------------------------------------------------------------------------
create table if not exists runs (
  run_id         text primary key,
  role           text        not null check (role in ('PM', 'SPM')),
  created_at     timestamptz not null default now(),
  model          text        not null,
  batch_total    integer     not null,
  candidate_ids  jsonb       not null default '{}'::jsonb,
  shortlist      jsonb       not null default '[]'::jsonb,
  not_advancing  jsonb       not null default '[]'::jsonb
);

-- The dashboard always wants the newest run for a role.
create index if not exists runs_role_created_idx on runs (role, created_at desc);

-- ---------------------------------------------------------------------------
-- decisions — Arjun's advance/reject record. The audit trail.
-- ---------------------------------------------------------------------------
create table if not exists decisions (
  candidate_id  text primary key,
  candidate     text        not null,
  role          text        not null check (role in ('PM', 'SPM')),
  run_id        text        not null,
  status        text        not null check (status in ('advanced', 'rejected')),
  decided_at    timestamptz not null default now(),
  email         text,
  comms         jsonb       not null default '{"state":"pending"}'::jsonb,
  updated_at    timestamptz not null default now()
);

create index if not exists decisions_role_idx on decisions (role);

create or replace function touch_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists decisions_touch_updated_at on decisions;
create trigger decisions_touch_updated_at
  before update on decisions
  for each row execute function touch_updated_at();
