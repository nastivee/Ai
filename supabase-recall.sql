-- =========================================================
-- RECALL
--
-- A searchable copy of what was said, kept so the assistant
-- can remember a conversation from months ago without being
-- sent the whole history every time.
--
-- The text is sealed with a key that lives on the server, not
-- in the browser, so it is ciphertext at rest here. Only the
-- server can open it, and only to answer a question.
--
-- Nothing in this table is readable by the client. There is no
-- select policy, and row level security is on, so the anon and
-- authenticated keys see nothing at all. Only the service role
-- reaches it.
-- =========================================================

create extension if not exists vector;

create table if not exists public.recall (

  id          bigserial primary key,
  user_id     uuid not null references auth.users (id) on delete cascade,
  chat_id     uuid,

  -- what was said, AES-256-GCM, iv and tag carried in the text
  sealed      text not null,

  -- how long the plain text was, so we can budget a prompt
  -- without opening anything
  chars       integer not null default 0,

  embedding   vector(1536),

  created_at  timestamptz not null default now()

);

alter table public.recall enable row level security;

-- deliberately no policies: service role only

create index if not exists recall_user_idx
  on public.recall (user_id, created_at desc);

-- cosine distance, which is what the match function below uses
create index if not exists recall_vector_idx
  on public.recall
  using hnsw (embedding vector_cosine_ops);


-- =========================================================
-- THE SEARCH
--
-- Closest first, always inside one person's own rows. The
-- caller passes the user, so this can never reach across
-- accounts even if it is called wrongly.
-- =========================================================

create or replace function public.match_recall(
  who uuid,
  query_embedding vector(1536),
  wanted integer default 5,
  floor_score float default 0.3
)
returns table (
  id bigint,
  chat_id uuid,
  sealed text,
  created_at timestamptz,
  score float
)
language sql
stable
security definer
set search_path = public
as $$
  select
    r.id,
    r.chat_id,
    r.sealed,
    r.created_at,
    1 - (r.embedding <=> query_embedding) as score
  from public.recall r
  where r.user_id = who
    and r.embedding is not null
    and 1 - (r.embedding <=> query_embedding) > floor_score
  order by r.embedding <=> query_embedding
  limit least(greatest(wanted, 1), 20)
$$;

revoke all on function public.match_recall(uuid, vector, integer, float) from public;
revoke all on function public.match_recall(uuid, vector, integer, float) from anon;
revoke all on function public.match_recall(uuid, vector, integer, float) from authenticated;


-- =========================================================
-- FORGETTING
--
-- Deleting a chat should delete what was remembered from it,
-- and deleting an account already cascades above.
-- =========================================================

create index if not exists recall_chat_idx on public.recall (chat_id);


-- Deleting a chat should take its memories with it. Linked only
-- if the chats table's id is the matching type; if not, this
-- says so in a notice and leaves the table alone.
do $$
begin
  if not exists (
    select 1 from information_schema.table_constraints
    where constraint_name = 'recall_chat_fk'
  ) then
    begin
      alter table public.recall
        add constraint recall_chat_fk
        foreign key (chat_id) references public.chats (id) on delete cascade;
    exception when others then
      raise notice 'recall not linked to chats: %', sqlerrm;
    end;
  end if;
end $$;


-- =========================================================
-- THE PRICING MODEL
--
-- An admin's own working: what a user costs, what a pack
-- earns. It charges nobody and gates nothing.
-- =========================================================

alter table public.app_settings
  add column if not exists pricing_model jsonb;
