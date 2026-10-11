#!/usr/bin/env python3
"""Prueba las políticas RLS y triggers de supabase/schema.sql contra un PostgreSQL real.
Simula lo que Supabase aporta (roles anon/authenticated, auth.users y auth.uid()).
Uso: python3 tests/rls_test.py <host_socket> <puerto>      (PostgreSQL 14+ vacío)
NOTA: valida la lógica SQL; no sustituye una prueba en tu proyecto real de Supabase."""
import subprocess,sys,os,json
H,PORT=sys.argv[1],sys.argv[2]
ROOT=os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
A,B='11111111-1111-1111-1111-111111111111','22222222-2222-2222-2222-222222222222'
def psql(sql,role=None,uid=None,db='cctest'):
    pre=''
    if role:pre+=f"set role {role};"
    if uid:pre+="select set_config('request.jwt.claims','"+json.dumps({"sub":uid,"role":role})+"',false) \\gset\n"
    p=subprocess.run(['psql','-h',H,'-p',PORT,'-U','postgres','-d',db,'-v','ON_ERROR_STOP=1','-tA','-q'],input=pre+sql,capture_output=True,text=True)
    return p.returncode==0,(p.stdout+p.stderr).strip()
ok_n=fail_n=0
def check(name,cond,detail=''):
    global ok_n,fail_n
    if cond:ok_n+=1;print('  ✔',name)
    else:fail_n+=1;print('  ✘',name,'→',detail)
subprocess.run(['psql','-h',H,'-p',PORT,'-U','postgres','-d','postgres','-qc','drop database if exists cctest'],capture_output=True)
subprocess.run(['psql','-h',H,'-p',PORT,'-U','postgres','-d','postgres','-qc','create database cctest'],check=True)
# --- entorno tipo Supabase
psql("""
do $$ begin
 if not exists(select 1 from pg_roles where rolname='anon') then create role anon nologin; end if;
 if not exists(select 1 from pg_roles where rolname='authenticated') then create role authenticated nologin; end if;
end $$;
create schema if not exists auth;
create table auth.users(id uuid primary key);
create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claims',true)::jsonb->>'sub','')::uuid $$;
grant usage on schema auth to anon, authenticated; grant execute on function auth.uid() to anon, authenticated;
grant usage on schema public to anon, authenticated;
insert into auth.users values ('%s'),('%s');
"""%(A,B))
schema=open(os.path.join(ROOT,'supabase/schema.sql')).read()
r=psql(schema);check('schema.sql se ejecuta sin errores',r[0],r[1])
r=psql(schema);check('schema.sql es idempotente (2ª ejecución)',r[0],r[1])
J="'{\"a\":1}'::jsonb"
print('user_state')
check('A inserta su fila (versión 1)',psql(f"insert into user_state(user_id,data,version) values('{A}',{J},1)",'authenticated',A)[0])
check('A NO puede insertar fila de B',not psql(f"insert into user_state(user_id,data,version) values('{B}',{J},1)",'authenticated',A)[0])
check('A NO puede insertar con versión 2',not psql(f"insert into user_state(user_id,data,version) values('{A}',{J},2)",'authenticated',A)[0])
check('B inserta su fila',psql(f"insert into user_state(user_id,data,version) values('{B}',{J},1)",'authenticated',B)[0])
r=psql("select count(*) from user_state",'authenticated',A);check('A solo ve 1 fila (la suya)',r[0] and r[1].splitlines()[-1]=='1',r[1])
r=psql(f"select count(*) from user_state where user_id='{B}'",'authenticated',A);check('A no ve la fila de B',r[0] and r[1].splitlines()[-1]=='0',r[1])
r=psql(f"with u as (update user_state set data='{{\"hack\":1}}'::jsonb, version=2 where user_id='{B}' returning 1) select count(*) from u",'authenticated',A)
check('A NO puede modificar la fila de B (0 filas)',r[0] and r[1].splitlines()[-1]=='0',r[1])
r=psql(f"with u as (update user_state set data='{{\"a\":2}}'::jsonb, version=2 where user_id='{A}' and version=1 returning version) select count(*) from u",'authenticated',A)
check('A actualiza lo suyo con versión correcta (1→2)',r[0] and r[1].splitlines()[-1]=='1',r[1])
r=psql(f"with u as (update user_state set data='{{\"a\":3}}'::jsonb, version=2 where user_id='{A}' and version=1 returning version) select count(*) from u",'authenticated',A)
check('Escritura con versión desactualizada afecta 0 filas (compare-and-set)',r[0] and r[1].splitlines()[-1]=='0',r[1])
r=psql(f"update user_state set version=5 where user_id='{A}'",'authenticated',A)
check('El servidor rechaza saltos de versión (40001)',not r[0] and 'version_conflict' in r[1],r[1])
r=psql(f"update user_state set user_id='{B}' where user_id='{A}'",'authenticated',A);check('A NO puede cambiar el dueño de su fila',not r[0],r[1])
r=psql(f"delete from user_state where user_id='{A}'",'authenticated',A);check('Nadie puede borrar user_state desde la app',not r[0] and 'permission denied' in r[1],r[1])
r=psql("select count(*) from user_state",'authenticated');check('Sin sesión (uid nulo) no se ve ninguna fila',r[0] and r[1].splitlines()[-1]=='0',r[1])
r=psql(f"insert into user_state(user_id,data,version) values('{A}',{J},1)",'authenticated');check('Sin sesión no se puede insertar',not r[0],r[1])
r=psql("select count(*) from user_state",'anon');check('Rol anon: acceso denegado a user_state',not r[0] and 'permission denied' in r[1],r[1])
r=psql("select count(*) from state_snapshots",'anon');check('Rol anon: acceso denegado a state_snapshots',not r[0] and 'permission denied' in r[1],r[1])
print('state_snapshots')
r=psql("select count(*)||':'||min(reason) from state_snapshots",'authenticated',A);check('La 1ª actualización creó 1 copia automática',r[0] and r[1].splitlines()[-1]=='1:auto',r[1])
r=psql(f"update user_state set data='{{\"a\":4}}'::jsonb, version=3 where user_id='{A}' and version=2; select count(*) from state_snapshots",'authenticated',A)
check('Una 2ª actualización el mismo día NO crea otra copia automática',r[0] and r[1].splitlines()[-1]=='1',r[1])
r=psql("select count(*) from state_snapshots",'authenticated',B);check('B no ve las copias de A',r[0] and r[1].splitlines()[-1]=='0',r[1])
check('A inserta una copia propia',psql(f"insert into state_snapshots(user_id,version,reason,data) values('{A}',3,'manual',{J})",'authenticated',A)[0])
check('A NO puede insertar copias a nombre de B',not psql(f"insert into state_snapshots(user_id,version,reason,data) values('{B}',1,'x',{J})",'authenticated',A)[0])
r=psql("update state_snapshots set reason='x'",'authenticated',A);check('Las copias no se pueden modificar',not r[0] and 'permission denied' in r[1],r[1])
r=psql(f"insert into state_snapshots(user_id,version,reason,data) select '{A}',1,'t'||g,{J} from generate_series(1,40) g; select count(*) from state_snapshots",'authenticated',A)
check('Se conservan como máximo 30 copias por usuario',r[0] and int(r[1].splitlines()[-1])==30,r[1])
r=psql("with d as (delete from state_snapshots returning 1) select count(*) from d",'authenticated',B);check('B no puede borrar copias de A (0 filas)',r[0] and r[1].splitlines()[-1]=='0',r[1])
r=psql("select count(*) from state_snapshots",'authenticated',A);check('A sigue teniendo sus copias tras el intento de B',r[0] and r[1].splitlines()[-1]=='30',r[1])
r=psql("insert into user_state(user_id,data,version) values('"+A+"','[]'::jsonb,1)",'authenticated',A);check('data debe ser un objeto JSON (rechaza arreglos)',not r[0],r[1])
print('ciclo de vida')
psql(f"delete from auth.users where id='{A}'")
r=psql(f"select (select count(*) from user_state where user_id='{A}')||':'||(select count(*) from state_snapshots where user_id='{A}')");check('Al borrar la cuenta se borran sus datos (cascade)',r[0] and r[1].splitlines()[-1]=='0:0',r[1])
r=psql(f"select count(*) from user_state where user_id='{B}'");check('Los datos de B no se ven afectados',r[0] and r[1].splitlines()[-1]=='1',r[1])
print(f"\n{ok_n} correctas, {fail_n} fallidas");sys.exit(1 if fail_n else 0)
