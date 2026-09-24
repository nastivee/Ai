-- Atla: a bucket for generated images
--
-- Run in Supabase > SQL Editor.

insert into storage.buckets (id, name, public)
values ('images', 'images', true)
on conflict (id) do update set public = true;

drop policy if exists "images read" on storage.objects;
create policy "images read"
  on storage.objects for select
  using (bucket_id = 'images');

drop policy if exists "images write own" on storage.objects;
create policy "images write own"
  on storage.objects for insert to authenticated
  with check (
    bucket_id = 'images'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

drop policy if exists "images delete own" on storage.objects;
create policy "images delete own"
  on storage.objects for delete to authenticated
  using (
    bucket_id = 'images'
    and (storage.foldername(name))[1] = auth.uid()::text
  );
