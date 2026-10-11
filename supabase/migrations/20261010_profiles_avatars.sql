-- =====================================================================
-- Mi Centro de Control · migración: foto de perfil (tabla profiles + bucket "avatars")
-- NO destructiva: no toca user_state ni state_snapshots. Es segura de volver a ejecutar.
-- Ejecutar en: Supabase > SQL Editor > New query > pegar > Run
-- (Pruébala primero en un proyecto/rama de Supabase de pruebas si puedes.)
-- =====================================================================

-- 1) Perfil: una fila por usuario con la RUTA (no la URL) de su foto en Storage.
create table if not exists public.profiles (
  user_id     uuid primary key references auth.users (id) on delete cascade,
  avatar_path text check (avatar_path is null or (char_length(avatar_path) <= 200 and avatar_path like user_id::text || '/%')),
  updated_at  timestamptz not null default now()
);

alter table public.profiles enable row level security;
revoke all on public.profiles from anon;
revoke all on public.profiles from authenticated;
grant select, insert, update on public.profiles to authenticated;

drop policy if exists profiles_select on public.profiles;
drop policy if exists profiles_insert on public.profiles;
drop policy if exists profiles_update on public.profiles;
create policy profiles_select on public.profiles
  for select to authenticated using (user_id = (select auth.uid()));
create policy profiles_insert on public.profiles
  for insert to authenticated with check (user_id = (select auth.uid()));
create policy profiles_update on public.profiles
  for update to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
-- (sin política de DELETE: quitar la foto = poner avatar_path en null)

create or replace function public.profiles_touch()
returns trigger language plpgsql set search_path = '' as $$
begin
  if tg_op = 'UPDATE' and new.user_id <> old.user_id then
    raise exception 'user_id no se puede cambiar' using errcode = '42501';
  end if;
  new.updated_at := now();
  return new;
end $$;
drop trigger if exists profiles_touch on public.profiles;
create trigger profiles_touch before insert or update on public.profiles
  for each row execute function public.profiles_touch();

-- 2) Bucket PRIVADO "avatars": 2 MB máx., solo JPEG/PNG/WebP. La app usa URLs firmadas (1 h).
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('avatars', 'avatars', false, 2097152, array['image/jpeg','image/png','image/webp'])
on conflict (id) do update
  set public = false, file_size_limit = 2097152,
      allowed_mime_types = array['image/jpeg','image/png','image/webp'];

-- 3) Políticas de Storage: cada usuario solo opera dentro de su carpeta "<su user_id>/..."
drop policy if exists avatars_select on storage.objects;
drop policy if exists avatars_insert on storage.objects;
drop policy if exists avatars_update on storage.objects;
drop policy if exists avatars_delete on storage.objects;
create policy avatars_select on storage.objects
  for select to authenticated
  using (bucket_id = 'avatars' and (storage.foldername(name))[1] = (select auth.uid())::text);
create policy avatars_insert on storage.objects
  for insert to authenticated
  with check (bucket_id = 'avatars' and (storage.foldername(name))[1] = (select auth.uid())::text);
create policy avatars_update on storage.objects
  for update to authenticated
  using (bucket_id = 'avatars' and (storage.foldername(name))[1] = (select auth.uid())::text)
  with check (bucket_id = 'avatars' and (storage.foldername(name))[1] = (select auth.uid())::text);
create policy avatars_delete on storage.objects
  for delete to authenticated
  using (bucket_id = 'avatars' and (storage.foldername(name))[1] = (select auth.uid())::text);
