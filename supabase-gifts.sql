-- =========================================================
-- NATTER AI, GIFTS
--
-- Run this once in the Supabase SQL editor.
--
-- One box on each profile holding anything an admin has
-- given that has a last day on it: a plan, unlimited
-- pictures, the use of voice or video. Pictures and
-- minutes are not kept here, they go onto the balance
-- like a purchase and stay.
--
-- The browser may read its own row but may not write this
-- column, so nobody can hand themselves a plan.
-- =========================================================

alter table public.profiles
  add column if not exists gifts jsonb not null default '{}'::jsonb;

-- Writing stays with the server and its service role key.
revoke update (gifts) on public.profiles from anon, authenticated;
