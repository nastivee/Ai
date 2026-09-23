-- =====================================================
-- EXPANDED: THE RECORD AND THE PRIVATE STORE
--
-- Run once in the Supabase SQL editor. Safe to run again.
--
-- Only the server (service role key) can read or write
-- these. Row level security is on with no policies, so the
-- app in the browser can never see them directly.
-- =====================================================

create table if not exists public.expanded_audit (
  id           uuid primary key default gen_random_uuid(),
  created_at   timestamptz not null default now(),
  user_id      uuid,
  email        text,
  prompt       text,
  stage        text not null check (stage in ('prompt', 'output', 'generated', 'error')),
  decision     text not null check (decision in ('allowed', 'blocked')),
  reason       text,
  image_path   text,
  image_hash   text,
  status       text not null default 'open' check (status in ('open', 'cleared', 'escalated')),
  reviewed_by  text,
  reviewed_at  timestamptz
);

create index if not exists expanded_audit_created on public.expanded_audit (created_at desc);
create index if not exists expanded_audit_status on public.expanded_audit (status);

alter table public.expanded_audit enable row level security;

-- the admin switch on the Expanded page. Starts off.
alter table public.app_settings
  add column if not exists expanded_on boolean not null default false;

-- a private bucket: no public links, only short-lived signed ones from the server
insert into storage.buckets (id, name, public)
values ('expanded-private', 'expanded-private', false)
on conflict (id) do update set public = false;
