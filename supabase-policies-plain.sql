alter table public.chats enable row level security;
alter table public.messages enable row level security;
alter table public.profiles enable row level security;

drop policy if exists "chats read own" on public.chats;
create policy "chats read own" on public.chats for select using (auth.uid() = user_id);

drop policy if exists "chats insert own" on public.chats;
create policy "chats insert own" on public.chats for insert with check (auth.uid() = user_id);

drop policy if exists "chats update own" on public.chats;
create policy "chats update own" on public.chats for update using (auth.uid() = user_id) with check (auth.uid() = user_id);

drop policy if exists "chats delete own" on public.chats;
create policy "chats delete own" on public.chats for delete using (auth.uid() = user_id);

drop policy if exists "messages read own" on public.messages;
create policy "messages read own" on public.messages for select using (auth.uid() = user_id);

drop policy if exists "messages insert own" on public.messages;
create policy "messages insert own" on public.messages for insert with check (auth.uid() = user_id);

drop policy if exists "messages delete own" on public.messages;
create policy "messages delete own" on public.messages for delete using (auth.uid() = user_id);

drop policy if exists "profiles read own" on public.profiles;
create policy "profiles read own" on public.profiles for select using (auth.uid() = id);

drop policy if exists "profiles insert own" on public.profiles;
create policy "profiles insert own" on public.profiles for insert with check (auth.uid() = id);

drop policy if exists "profiles update own" on public.profiles;
create policy "profiles update own" on public.profiles for update using (auth.uid() = id) with check (auth.uid() = id);
