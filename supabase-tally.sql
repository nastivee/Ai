-- =========================================================
-- NATTER AI, THE ALLOWANCE TALLY
--
-- Run this once in the Supabase SQL editor.
--
-- One box per profile holding how many messages and
-- searches have been used today and this month. It rolls
-- itself over, so nothing has to be reset on a schedule
-- and a dormant account costs nothing to keep.
--
-- The browser may read its own row but must never write
-- this column, or anybody could hand themselves an
-- unlimited account.
-- =========================================================

alter table public.profiles
  add column if not exists tally jsonb not null default '{}'::jsonb;

revoke update (tally) on public.profiles from anon, authenticated;
