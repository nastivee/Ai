-- =========================================================
-- NASTIVEE AI, IMAGE CREDITS
--
-- Run this once in the Supabase SQL editor.
--
-- It adds the two columns the paywall needs and, just as
-- importantly, stops the browser from writing to them. The
-- only thing that may change a balance is the server, using
-- the service role key.
-- =========================================================

-- The memory box the My profile panel writes to. It was
-- never created, so the profile text has been going
-- nowhere. This puts it right.
alter table public.profiles
  add column if not exists memory text;

alter table public.profiles
  add column if not exists image_credits integer not null default 0;

alter table public.profiles
  add column if not exists unlimited boolean not null default false;

alter table public.profiles
  add column if not exists credits_updated_at timestamptz;


-- ---------------------------------------------------------
-- The browser may read its own row, and may write nothing
-- but its memory box.
--
-- Row level security says WHICH rows. Column grants say
-- WHICH columns. Both are needed, or a signed in user could
-- simply set their own balance to a million.
-- ---------------------------------------------------------

revoke update on public.profiles from anon, authenticated;
revoke insert on public.profiles from anon, authenticated;

grant insert (id, memory) on public.profiles to authenticated;
grant update (memory)     on public.profiles to authenticated;

grant select on public.profiles to authenticated;


-- ---------------------------------------------------------
-- A ledger, so every grant of credit can be accounted for
-- and a Stripe webhook that arrives twice only pays once.
-- ---------------------------------------------------------

create table if not exists public.credit_events (
  id            bigserial primary key,
  user_id       uuid not null references auth.users(id) on delete cascade,
  amount        integer not null,
  reason        text not null,
  reference     text unique,
  created_at    timestamptz not null default now()
);

alter table public.credit_events enable row level security;

drop policy if exists "credit events read own" on public.credit_events;
create policy "credit events read own"
  on public.credit_events for select
  using (auth.uid() = user_id);

create index if not exists credit_events_user_idx
  on public.credit_events (user_id, created_at desc);


-- ---------------------------------------------------------
-- Adding credit, all in one go, so two webhooks landing at
-- the same moment cannot lose one another's work.
-- ---------------------------------------------------------

create or replace function public.add_credits(
  p_user      uuid,
  p_amount    integer,
  p_reason    text,
  p_reference text
)
returns integer
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v_balance integer;
begin

  if p_reference is not null then

    insert into public.credit_events (user_id, amount, reason, reference)
    values (p_user, p_amount, p_reason, p_reference)
    on conflict (reference) do nothing;

    if not found then
      select image_credits into v_balance
      from public.profiles where id = p_user;
      return coalesce(v_balance, 0);
    end if;

  else

    insert into public.credit_events (user_id, amount, reason, reference)
    values (p_user, p_amount, p_reason, null);

  end if;

  insert into public.profiles (id, image_credits, credits_updated_at)
  values (p_user, greatest(p_amount, 0), now())
  on conflict (id) do update
    set image_credits = greatest(public.profiles.image_credits + p_amount, 0),
        credits_updated_at = now()
  returning image_credits into v_balance;

  return v_balance;

end;
$fn$;

revoke all on function public.add_credits(uuid, integer, text, text) from public, anon, authenticated;


-- ---------------------------------------------------------
-- Spending a credit. Returns the balance left, or -1 when
-- there was nothing to spend, so the server never has to
-- read and then write in two separate steps.
-- ---------------------------------------------------------

create or replace function public.spend_credit(p_user uuid)
returns integer
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v_unlimited boolean;
  v_balance   integer;
begin

  select unlimited, image_credits
    into v_unlimited, v_balance
  from public.profiles
  where id = p_user
  for update;

  if v_unlimited then
    return 999999;
  end if;

  if coalesce(v_balance, 0) < 1 then
    return -1;
  end if;

  update public.profiles
     set image_credits = image_credits - 1,
         credits_updated_at = now()
   where id = p_user
  returning image_credits into v_balance;

  insert into public.credit_events (user_id, amount, reason)
  values (p_user, -1, 'image');

  return v_balance;

end;
$fn$;

revoke all on function public.spend_credit(uuid) from public, anon, authenticated;


-- =========================================================
-- SETTINGS THE ADMIN PANEL CAN CHANGE
--
-- One row, read and written only by the server with the
-- service role key. No policies are added, so row level
-- security refuses everyone else by default.
-- =========================================================

create table if not exists public.app_settings (
  id                smallint primary key default 1,
  paywall_enabled   boolean  not null default true,
  pack_price_pence  integer  not null default 500,
  pack_images       integer  not null default 100,
  coupon_code       text     not null default 'Nasti100',
  starter_credits   integer  not null default 0,
  updated_at        timestamptz not null default now(),
  constraint app_settings_single check (id = 1)
);

insert into public.app_settings (id)
values (1)
on conflict (id) do nothing;

alter table public.app_settings enable row level security;

revoke all on public.app_settings from anon, authenticated;


-- =========================================================
-- END TO END ENCRYPTION, AND THE HOLDING PAGE
--
-- The wrapped data key lives on the user's own profile row.
-- Without their password it is noise, so it is safe to let
-- the browser write it.
-- =========================================================

alter table public.profiles
  add column if not exists key_salt text;

alter table public.profiles
  add column if not exists key_iv text;

alter table public.profiles
  add column if not exists key_wrapped text;

grant insert (id, memory, key_salt, key_iv, key_wrapped)
  on public.profiles to authenticated;

grant update (memory, key_salt, key_iv, key_wrapped)
  on public.profiles to authenticated;

alter table public.app_settings
  add column if not exists holding_mode boolean not null default true;


-- =========================================================
-- RECOVERY CODES, AND RE-SEALING OLD ROWS
-- =========================================================

alter table public.profiles add column if not exists key_recovery_salt text;
alter table public.profiles add column if not exists key_recovery_iv text;
alter table public.profiles add column if not exists key_recovery_wrapped text;

grant insert (id, memory, key_salt, key_iv, key_wrapped,
              key_recovery_salt, key_recovery_iv, key_recovery_wrapped)
  on public.profiles to authenticated;

grant update (memory, key_salt, key_iv, key_wrapped,
              key_recovery_salt, key_recovery_iv, key_recovery_wrapped)
  on public.profiles to authenticated;

-- the app rewrites old plain rows as ciphertext, so it needs this
drop policy if exists "messages update own" on public.messages;
create policy "messages update own" on public.messages for update
  using (auth.uid() = user_id) with check (auth.uid() = user_id);


-- =========================================================
-- PRIVATE PICTURES
-- =========================================================

-- Owners read their own folder and nobody else's.
drop policy if exists "images read own" on storage.objects;
create policy "images read own" on storage.objects for select to authenticated
  using (bucket_id = 'images'
         and (storage.foldername(name))[1] = auth.uid()::text);

-- Run on 21 September 2026, once 2026-09-21-04 was live. The
-- public URL route now answers "Bucket not found".
drop policy if exists "images read" on storage.objects;
update storage.buckets set public = false where id = 'images';


-- =========================================================
-- ALERTS AND THE DASHBOARD (run 21 September 2026)
-- =========================================================

-- Written by the server only. No policies, so the browser
-- cannot read or write a row.
create table if not exists public.app_alerts (
  id          bigserial primary key,
  kind        text not null,
  severity    text not null default 'medium',
  message     text not null,
  detail      text,
  count       integer not null default 1,
  first_at    timestamptz not null default now(),
  last_at     timestamptz not null default now(),
  resolved_at timestamptz
);

alter table public.app_alerts enable row level security;
revoke all on public.app_alerts from anon, authenticated;

create index if not exists app_alerts_open_idx
  on public.app_alerts (resolved_at, last_at desc);

-- What each purchase actually paid, so revenue is exact
-- even after the pack price changes.
alter table public.credit_events add column if not exists pence integer;

-- The dashboard counts by date.
create index if not exists messages_created_idx on public.messages (created_at);
create index if not exists credit_events_created_idx on public.credit_events (created_at);


-- =========================================================
-- ROBOT TIMER
-- How often the little robot peeks over the message box,
-- in seconds, for everyone. 0 switches him off. Set from
-- the admin panel (Test features).
-- =========================================================

alter table public.app_settings
  add column if not exists peek_seconds integer not null default 30;


-- =========================================================
-- NEW VIDEO AND VOICE: WHO GETS THEM
-- 'off' (nobody, admins included), 'admins', or 'everyone'.
-- Set from the admin panel (Test features).
-- =========================================================

alter table public.app_settings
  add column if not exists video_access text not null default 'admins';

alter table public.app_settings
  add column if not exists voice_access text not null default 'admins';


-- =========================================================
-- SAVED COMMENTS
-- Replies a user bookmarks, listed under their chats. The
-- content is sealed in the browser like messages are.
-- =========================================================

create table if not exists public.saved_comments (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references auth.users(id) on delete cascade,
  chat_id     text,
  content     text not null,
  created_at  timestamptz not null default now()
);

create index if not exists saved_comments_user_idx
  on public.saved_comments (user_id, created_at desc);

alter table public.saved_comments enable row level security;

drop policy if exists "saved own read" on public.saved_comments;
create policy "saved own read" on public.saved_comments
  for select using (auth.uid() = user_id);

drop policy if exists "saved own add" on public.saved_comments;
create policy "saved own add" on public.saved_comments
  for insert with check (auth.uid() = user_id);

drop policy if exists "saved own remove" on public.saved_comments;
create policy "saved own remove" on public.saved_comments
  for delete using (auth.uid() = user_id);

grant select, insert, delete on public.saved_comments to authenticated;


-- =========================================================
-- RULES
-- Word swaps applied before a request is processed. Set
-- from the admin panel (Rules).
-- =========================================================

alter table public.app_settings
  add column if not exists rules jsonb not null default '[]'::jsonb;


-- =========================================================
-- HOUSE LESSONS
-- General tips on answering well, suggested from retries and
-- saves, live once an admin approves them (admin, Lessons).
-- =========================================================

alter table public.app_settings
  add column if not exists lessons jsonb not null default '{"auto": true, "items": []}'::jsonb;


-- =========================================================
-- UPLOADS
-- A record of every photo uploaded, by signed in users (their
-- own rows) and guests (written by the server). Admins browse
-- them through the server with the service key.
-- =========================================================

create table if not exists public.uploads (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid references auth.users(id) on delete cascade,
  path        text not null,
  kind        text,
  created_at  timestamptz not null default now()
);

create index if not exists uploads_created_idx on public.uploads (created_at desc);
create index if not exists uploads_user_idx on public.uploads (user_id, created_at desc);

alter table public.uploads enable row level security;

drop policy if exists "uploads own read" on public.uploads;
create policy "uploads own read" on public.uploads
  for select using (auth.uid() = user_id);

drop policy if exists "uploads own add" on public.uploads;
create policy "uploads own add" on public.uploads
  for insert with check (auth.uid() = user_id);

grant select, insert on public.uploads to authenticated;

-- Site theme chosen in the admin page: standard, halloween or auto
alter table public.app_settings
  add column if not exists site_theme text not null default 'standard';

-- what admins see, so a celebration can be checked before everyone gets it
alter table public.app_settings
  add column if not exists admin_theme text not null default 'match';

-- Requests Natter turned down, shown in the admin page
create table if not exists public.refusals (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  user_id uuid,
  email text,
  request text,
  reply text,
  category text,
  rule text,
  avoid text,
  severity text not null default 'medium',
  seen_at timestamptz
);

alter table public.refusals enable row level security;

create index if not exists refusals_created_idx
  on public.refusals (created_at desc);


-- ============================================================
-- THINGS THAT BROKE
-- Separate from refusals: a refusal is us deciding not to do
-- something, this is us failing to. Recovered means the user
-- still got an answer, just not the way it was meant to work.
-- ============================================================

create table if not exists public.failures (
  id          uuid primary key default gen_random_uuid(),
  created_at  timestamptz not null default now(),
  user_id     uuid,
  email       text,
  name        text,
  area        text not null default 'chat',
  stage       text,
  status      text,
  model       text,
  detail      text,
  recovered   boolean not null default false,
  seen_at     timestamptz
);

create index if not exists failures_created_idx on public.failures (created_at desc);
create index if not exists failures_area_idx on public.failures (area, recovered);

alter table public.failures enable row level security;
-- no policies: only the service role writes and reads this table
