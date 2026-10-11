-- =====================================================================
-- Mi Centro de Control · esquema de Supabase
-- Ejecutar UNA vez en: Supabase > SQL Editor > New query > pegar > Run
-- Es seguro volver a ejecutarlo (usa "if not exists" / "or replace").
-- =====================================================================

-- 1) Estado del usuario: un documento JSON por cuenta, con número de versión
create table if not exists public.user_state (
  user_id    uuid primary key references auth.users (id) on delete cascade,
  data       jsonb       not null check (jsonb_typeof(data) = 'object'),
  version    integer     not null default 1 check (version >= 1),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- 2) Copias de seguridad automáticas y previas a reemplazos
create table if not exists public.state_snapshots (
  id         bigint generated always as identity primary key,
  user_id    uuid        not null references auth.users (id) on delete cascade,
  version    integer     not null,
  reason     text        not null default 'auto',
  data       jsonb       not null check (jsonb_typeof(data) = 'object'),
  created_at timestamptz not null default now()
);
create index if not exists state_snapshots_user_created_idx
  on public.state_snapshots (user_id, created_at desc);

-- 3) Seguridad a nivel de fila (RLS): cada usuario solo ve y toca SUS filas
alter table public.user_state      enable row level security;
alter table public.state_snapshots enable row level security;

-- Sin sesión (rol anon) no hay acceso a nada
revoke all on public.user_state      from anon;
revoke all on public.state_snapshots from anon;
revoke all on public.user_state      from authenticated;
revoke all on public.state_snapshots from authenticated;
grant select, insert, update         on public.user_state      to authenticated;
grant select, insert, delete         on public.state_snapshots to authenticated;

drop policy if exists user_state_select on public.user_state;
drop policy if exists user_state_insert on public.user_state;
drop policy if exists user_state_update on public.user_state;
create policy user_state_select on public.user_state
  for select to authenticated using (user_id = (select auth.uid()));
create policy user_state_insert on public.user_state
  for insert to authenticated with check (user_id = (select auth.uid()) and version = 1);
create policy user_state_update on public.user_state
  for update to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
-- (no hay política de DELETE en user_state: nadie puede borrar su estado desde la app)

drop policy if exists snapshots_select on public.state_snapshots;
drop policy if exists snapshots_insert on public.state_snapshots;
drop policy if exists snapshots_delete on public.state_snapshots;
create policy snapshots_select on public.state_snapshots
  for select to authenticated using (user_id = (select auth.uid()));
create policy snapshots_insert on public.state_snapshots
  for insert to authenticated with check (user_id = (select auth.uid()));
create policy snapshots_delete on public.state_snapshots
  for delete to authenticated using (user_id = (select auth.uid()));
-- (no hay política de UPDATE en snapshots: las copias no se pueden modificar)

-- 4) Control de versión en el servidor + copia automática (máx. 1 cada 20 h)
create or replace function public.user_state_guard()
returns trigger language plpgsql set search_path = '' as $$
begin
  if new.user_id <> old.user_id then
    raise exception 'user_id no se puede cambiar' using errcode = '42501';
  end if;
  if new.version <> old.version + 1 then
    raise exception 'version_conflict: se esperaba %, llegó %', old.version + 1, new.version
      using errcode = '40001';
  end if;
  new.created_at := old.created_at;
  new.updated_at := now();
  if not exists (
    select 1 from public.state_snapshots s
    where s.user_id = old.user_id and s.reason = 'auto' and s.created_at > now() - interval '20 hours'
  ) then
    insert into public.state_snapshots (user_id, version, reason, data)
    values (old.user_id, old.version, 'auto', old.data);
  end if;
  return new;
end $$;

drop trigger if exists user_state_guard on public.user_state;
create trigger user_state_guard before update on public.user_state
  for each row execute function public.user_state_guard();

-- 5) Conservar solo las 30 copias más recientes por usuario
create or replace function public.snapshots_prune()
returns trigger language plpgsql set search_path = '' as $$
begin
  delete from public.state_snapshots
  where user_id = new.user_id
    and id not in (
      select id from public.state_snapshots
      where user_id = new.user_id order by created_at desc, id desc limit 30);
  return null;
end $$;

drop trigger if exists snapshots_prune on public.state_snapshots;
create trigger snapshots_prune after insert on public.state_snapshots
  for each row execute function public.snapshots_prune();
