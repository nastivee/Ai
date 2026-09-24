-- =========================================================
-- NATTER AI, THE SPEND PAGE
--
-- Run this once in the Supabase SQL editor.
--
-- Two small boxes on the settings row. They hold a credit
-- top up an admin typed in, so the admin page can show what
-- is left. OpenAI publishes no way to read the remaining
-- balance, so this is the only honest way to show it.
-- =========================================================

alter table public.app_settings
  add column if not exists credit_topup_usd numeric not null default 0;

alter table public.app_settings
  add column if not exists credit_topup_at text not null default '';


-- The spend page counts rows by date, so give it an index
-- to count them with rather than reading the whole table.
create index if not exists credit_events_created_at_idx
  on public.credit_events (created_at desc);

create index if not exists messages_created_at_idx
  on public.messages (created_at desc);
