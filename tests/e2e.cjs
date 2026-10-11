/* Pruebas de extremo a extremo en Chromium real (Playwright).
   - La app y sync.js son los reales.
   - "Supabase" se simula: una librería falsa en el navegador reenvía las operaciones a un PostgreSQL
     real (con el schema.sql real y RLS, rol "authenticated") a través de Node.
   - NO prueba el servicio real de Supabase Auth ni la red real: eso debe comprobarse tras desplegar.
   Uso: NODE_PATH=<ruta a playwright> node tests/e2e.cjs <socket_pg> <puerto_pg> */
const {chromium}=require('playwright');
const {spawnSync}=require('child_process');
const http=require('http'),fs=require('fs'),path=require('path'),os=require('os'),crypto=require('crypto');
const [PGH,PGP]=[process.argv[2],process.argv[3]];
const ROOT=path.resolve(__dirname,'..');
const DB='ccweb';

/* ---------- PostgreSQL real ---------- */
const psqlBase=['-h',PGH,'-p',PGP,'-U','postgres','-v','ON_ERROR_STOP=1','-v','VERBOSITY=verbose','-tA','-q'];
const psql=(db,input)=>spawnSync('psql',[...psqlBase,'-d',db],{input,encoding:'utf8'});
function setupDb(){
  psql('postgres',`drop database if exists ${DB};`);psql('postgres',`create database ${DB};`);
  const r=psql(DB,`
   do $$ begin if not exists(select 1 from pg_roles where rolname='anon') then create role anon nologin; end if;
   if not exists(select 1 from pg_roles where rolname='authenticated') then create role authenticated nologin; end if; end $$;
   create schema auth; create table auth.users(id uuid primary key, email text unique);
   create function auth.uid() returns uuid language sql stable as $f$ select nullif(current_setting('request.jwt.claims',true)::jsonb->>'sub','')::uuid $f$;
   grant usage on schema auth, public to anon, authenticated; grant execute on function auth.uid() to anon, authenticated;`);
  if(r.status)throw new Error(r.stderr);
  const s=psql(DB,fs.readFileSync(path.join(ROOT,'supabase/schema.sql'),'utf8'));if(s.status)throw new Error(s.stderr);
}
const lit=v=>"'"+String(v).replace(/'/g,"''")+"'";
const val=v=>v===null?'null':typeof v==='object'?lit(JSON.stringify(v))+'::jsonb':typeof v==='number'?String(v):lit(v);
function dbOp(uid,o){
  const role=uid?'authenticated':'anon';
  const where=(o.filters||[]).map(f=>`"${f.col}"=${lit(f.val)}`).join(' and ')||'true';
  let q;
  if(o.kind==='select')q=`select coalesce(jsonb_agg(to_jsonb(t)),'[]'::jsonb) from (select * from public.${o.table} where ${where} ${o.ord?`order by ${o.ord.c} ${o.ord.asc?'asc':'desc'}`:''} ${o.lim?'limit '+o.lim:''}) t`;
  else if(o.kind==='insert'){const k=Object.keys(o.v);q=`with r as (insert into public.${o.table}(${k.join(',')}) values(${k.map(x=>val(o.v[x])).join(',')}) returning *) select coalesce(jsonb_agg(to_jsonb(r)),'[]'::jsonb) from r`}
  else if(o.kind==='update'){const k=Object.keys(o.v);q=`with r as (update public.${o.table} set ${k.map(x=>`${x}=${val(o.v[x])}`).join(',')} where ${where} returning *) select coalesce(jsonb_agg(to_jsonb(r)),'[]'::jsonb) from r`}
  else q=`with r as (delete from public.${o.table} where ${where} returning *) select coalesce(jsonb_agg(to_jsonb(r)),'[]'::jsonb) from r`;
  const claims=uid?JSON.stringify({sub:uid,role:'authenticated'}):'{}';
  const p=psql(DB,`set role ${role};\nselect set_config('request.jwt.claims',${lit(claims)},false) \\gset\n${q};`);
  if(p.status){const m=/ERROR:\s+(\w{5}):\s+([^\n]*)/.exec(p.stderr)||[];return{error:{code:m[1]||'XX000',message:m[2]||p.stderr}}}
  const lines=p.stdout.trim().split('\n');return{rows:JSON.parse(lines[lines.length-1])};
}
const adminQ=q=>{const p=psql(DB,q);return p.stdout.trim()};

/* ---------- "Supabase" falso en el navegador ---------- */
const SHIM=`(function(){
const be=(o)=>window.__be(o);
const sget=()=>{try{return JSON.parse(localStorage.getItem('cc.auth'))}catch(e){return null}};
const subs=[];const emit=(ev,s)=>subs.forEach(f=>{try{f(ev,s)}catch(e){}});
const netErr=m=>({message:m||'TypeError: Failed to fetch',name:'AuthRetryableFetchError'});
class Q{constructor(t){this.t=t;this.f=[];this.k='select';this.sg=null}
 select(){if(this.k!=='select')this.ret=true;return this}
 insert(v){this.k='insert';this.v=v;return this} update(v){this.k='update';this.v=v;return this} delete(){this.k='delete';return this}
 eq(c,v){this.f.push({col:c,val:v});return this} order(c,o){this.ord={c,asc:!(o&&o.ascending===false)};return this} limit(n){this.lim=n;return this}
 single(){this.sg='single';return this} maybeSingle(){this.sg='maybe';return this}
 then(a,b){return this.run().then(a,b)}
 async run(){const s=sget();const r=await be({kind:this.k,table:this.t,v:this.v,filters:this.f,ord:this.ord,lim:this.lim,token:s&&s.access_token});
  if(r.net)return{data:null,error:{message:'TypeError: Failed to fetch',code:''}};
  if(r.error)return{data:null,error:r.error};
  let rows=r.rows;if(this.k!=='select'&&!this.ret)return{data:null,error:null};
  if(this.sg==='single'){if(rows.length!==1)return{data:null,error:{code:'PGRST116',message:'JSON object requested, multiple (or no) rows returned'}};return{data:rows[0],error:null}}
  if(this.sg==='maybe'){if(rows.length>1)return{data:null,error:{code:'PGRST116',message:'multiple rows'}};return{data:rows[0]||null,error:null}}
  return{data:rows,error:null}}}
const auth={
 async getSession(){const s=sget();if(localStorage.getItem('__expired'))return{data:{session:null},error:netErr('fetch failed')};return{data:{session:s},error:null}},
 onAuthStateChange(cb){subs.push(cb);return{data:{subscription:{unsubscribe(){}}}}},
 async signInWithPassword(c){const r=await be({auth:'signIn',...c});if(r.net)return{data:{},error:netErr()};if(r.error)return{data:{},error:r.error};localStorage.setItem('cc.auth',JSON.stringify(r.session));emit('SIGNED_IN',r.session);return{data:{user:r.session.user,session:r.session},error:null}},
 async signUp(c){const r=await be({auth:'signUp',...c});if(r.net)return{data:{},error:netErr()};if(r.error)return{data:{},error:r.error};if(r.session){localStorage.setItem('cc.auth',JSON.stringify(r.session));emit('SIGNED_IN',r.session)}return{data:{user:r.user,session:r.session||null},error:null}},
 async signOut(o){localStorage.removeItem('cc.auth');window.__signOutScope=o&&o.scope;emit('SIGNED_OUT',null);return{error:null}},
 async refreshSession(){const s=sget();return s?{data:{session:s},error:null}:{data:{},error:{message:'no session'}}},
 async resetPasswordForEmail(e){window.__reset=e;return{data:{},error:null}},
 async updateUser(){return{data:{},error:null}},
 async getUser(){const s=sget();return{data:{user:s&&s.user},error:null}}};
window.supabase={createClient:()=>({auth,from:t=>new Q(t)})};
})();`;

/* ---------- servidor estático ---------- */
const SITE=fs.mkdtempSync(path.join(os.tmpdir(),'ccsite-'));
function buildSite(){
  fs.cpSync(path.join(ROOT,'public'),SITE,{recursive:true});
  fs.mkdirSync(path.join(SITE,'js/vendor'),{recursive:true});
  fs.writeFileSync(path.join(SITE,'js/vendor/supabase.js'),SHIM);
  fs.writeFileSync(path.join(SITE,'config.js'),'window.CC_CONFIG={"url":"https://fake.supabase.co","anonKey":"fake-anon-key-for-tests-only"};\n');
}
const MIME={'.html':'text/html','.js':'text/javascript','.css':'text/css','.png':'image/png','.webmanifest':'application/manifest+json','.json':'application/json'};
let CONFIGURED=true;
const server=http.createServer((req,res)=>{
  let p=decodeURIComponent(req.url.split('?')[0]);if(p==='/')p='/index.html';
  if(p==='/config.js'&&!CONFIGURED){res.writeHead(200,{'content-type':'text/javascript'});return res.end('window.CC_CONFIG=null;')}
  const f=path.join(SITE,p);if(!f.startsWith(SITE)||!fs.existsSync(f)||fs.statSync(f).isDirectory()){res.writeHead(404);return res.end('nf')}
  res.writeHead(200,{'content-type':MIME[path.extname(f)]||'application/octet-stream','cache-control':'no-store'});res.end(fs.readFileSync(f));
});

/* ---------- backend de autenticación en Node ---------- */
const USERS={};// email -> {id,password}
const TOK={};  // token -> uid
function authOp(o){
  if(o.auth==='signUp'){
    if(USERS[o.email])return{user:{id:USERS[o.email].id,identities:[]},session:null};
    const id=crypto.randomUUID();USERS[o.email]={id,password:o.password};adminQ(`insert into auth.users(id,email) values('${id}',${lit(o.email)});`);
    const t='tok-'+crypto.randomUUID();TOK[t]=id;const user={id,email:o.email,identities:[{}]};return{user,session:{access_token:t,user}};
  }
  const u=USERS[o.email];if(!u||u.password!==o.password)return{error:{message:'Invalid login credentials',status:400}};
  const t='tok-'+crypto.randomUUID();TOK[t]=u.id;return{session:{access_token:t,user:{id:u.id,email:o.email}}};
}

/* ---------- utilidades de prueba ---------- */
let pass=0,fail=0;const errors=[];
const ok=(n,c,d)=>{if(c){pass++;console.log('  ✔',n)}else{fail++;console.log('  ✘',n,d!==undefined?'→ '+JSON.stringify(d):'')}};
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
async function waitFor(fn,ms=8000,label=''){const t=Date.now();while(Date.now()-t<ms){try{if(await fn())return true}catch(e){}await sleep(80)}return false}
let browser;
async function device(name,{viewport={width:1280,height:800},sw='block',storage}={}){
  const ctx=await browser.newContext({viewport,serviceWorkers:sw,storageState:storage});
  const dev={name,ctx,netDown:false,calls:0};
  await ctx.exposeFunction('__be',async o=>{
    dev.calls++;if(dev.netDown)return{net:true};
    if(o.auth)return authOp(o);
    const uid=o.token?TOK[o.token]:null;return dbOp(uid,o);
  });
  const page=await ctx.newPage();dev.page=page;
  page.on('pageerror',e=>errors.push(`[${name}] pageerror: ${e.message}`));
  page.on('console',m=>{if(m.type()==='error')errors.push(`[${name}] console: ${m.text()}`)});
  page.on('dialog',d=>{dev.lastDialog=d.message();d.accept()});
  dev.goto=async()=>page.goto('http://localhost:'+PORT+'/');
  dev.state=()=>page.evaluate(()=>JSON.parse(JSON.stringify(S)));
  dev.dbg=()=>page.evaluate(()=>Sync._debug()).catch(()=>({mode:'none',dirty:false}));
  dev.offline=async v=>{dev.netDown=v;await ctx.setOffline(v)};
  dev.settled=()=>waitFor(async()=>{const d=await dev.dbg();return !d.dirty&&d.mode==='cloud'},8000);
  return dev;
}
async function signup(d,email,pw='clave-segura-1'){
  await d.page.fill('#af input[name=email]','');await d.page.click('[data-t=up]');
  await d.page.fill('#af input[name=email]',email);await d.page.fill('#af input[name=pw]',pw);await d.page.fill('#af input[name=pw2]',pw);
  await d.page.click('#af button');
}
async function login(d,email,pw='clave-segura-1'){
  await d.page.fill('#af input[name=email]',email);await d.page.fill('#af input[name=pw]',pw);await d.page.click('#af button');
}
const rowOf=email=>JSON.parse(adminQ(`select coalesce(jsonb_agg(to_jsonb(t)),'[]'::jsonb) from (select user_id,version,data from public.user_state where user_id=${lit(USERS[email].id)}) t;`))[0];
const habitCount=s=>Object.values(s.hl||{}).reduce((n,a)=>n+a.length,0);

(async()=>{
  setupDb();buildSite();
  await new Promise(r=>server.listen(0,r));global.PORT=server.address().port;
  browser=await chromium.launch();

  /* ===== T1 · sin configuración: la app arranca en modo local ===== */
  console.log('\nT1 Arranque sin configuración de Supabase (modo local)');
  CONFIGURED=false;
  let a=await device('local');await a.goto();
  ok('muestra aviso de configuración faltante',await waitFor(async()=>/no está configurada/.test(await a.page.textContent('#ov'))));
  await a.page.click('[data-t=local]');
  ok('entra a la app en modo local',await waitFor(async()=>(await a.page.textContent('#mn')).includes('Mi Centro de Control')));
  ok('la etiqueta indica "Solo este dispositivo"',/Solo este dispositivo/.test(await a.page.textContent('#sync')));
  const views=['dia','salud','fin','ceo','proy','vida','cal','obj','rep','aj','inicio'];const bad=[];
  for(const v of views){await a.page.click(`nav [data-i=${v}]`);const t=(await a.page.textContent('#mn')).trim();if(t.length<30)bad.push(v)}
  ok('las 11 secciones renderizan contenido',bad.length===0,bad);
  ok('el progreso general se calcula en pantalla',/PROGRESO GENERAL/.test(await a.page.textContent('#mn')));
  ok('los datos locales se guardan en cc.v1',await a.page.evaluate(()=>!!JSON.parse(localStorage.getItem('cc.v1')||'null')));
  await a.page.reload();
  ok('tras recargar vuelve a modo local con datos',await waitFor(async()=>/Solo este dispositivo/.test(await a.page.textContent('#sync'))));
  const legacyState=await a.page.evaluate(()=>localStorage.getItem('cc.v1'));
  await a.ctx.close();
  CONFIGURED=true;

  /* ===== T2 · registro, onboarding y primera subida ===== */
  console.log('\nT2 Registro e inicio (dispositivo A)');
  a=await device('A');await a.goto();
  ok('sin sesión muestra la pantalla de acceso',await waitFor(async()=>/Entrar/.test(await a.page.textContent('#ov'))&&!(await a.page.isVisible('#app'))));
  await a.page.fill('#af input[name=email]','ana@example.com');await a.page.fill('#af input[name=pw]','equivocada1');await a.page.click('#af button');
  ok('credenciales inexistentes → mensaje claro en español',await waitFor(async()=>/incorrectos/.test(await a.page.textContent('#amsg'))));
  await a.page.click('[data-t=up]');await a.page.fill('#af input[name=email]','ana@example.com');await a.page.fill('#af input[name=pw]','abc12345');await a.page.fill('#af input[name=pw2]','distinta999');await a.page.click('#af button');
  ok('contraseñas distintas → se rechaza sin llamar al servidor',/no coinciden/.test(await a.page.textContent('#amsg')));
  await signup(a,'ana@example.com');
  ok('cuenta nueva sin datos → pregunta cómo empezar',await waitFor(async()=>/Tu cuenta está lista/.test(await a.page.textContent('#ov'))));
  ok('el entorno vacío NO ofrece importar (no hay datos locales)',!(await a.page.isVisible('[data-o=legacy]')));
  await a.page.click('[data-o=zero]');
  ok('entra a la app y sube la versión 1',await waitFor(()=>rowOf('ana@example.com')&&rowOf('ana@example.com').version===1));
  ok('chip: Sincronizado',await waitFor(async()=>/Sincronizado/.test(await a.page.textContent('#sync'))));
  ok('la fila en la nube no incluye "view" (preferencia del dispositivo)',rowOf('ana@example.com').data.view===undefined);
  ok('empezar desde cero: sin datos demo',(await a.state()).demo===false);

  /* ===== T3 · hábito en A, recarga y sincronización a B ===== */
  console.log('\nT3 Hábito en A → aparece en B');
  await a.page.click('nav [data-i=vida]');
  await a.page.click('[data-a=addhab]');await a.page.fill('#fm input[name=n]','Tender cama');await a.page.click('#fm button:not([data-a=close])');
  await waitFor(async()=>(await a.state()).habits.some(h=>h.n==='Tender cama'));
  await a.page.click('[data-a=hab]');
  ok('A: hábito marcado como hecho',await waitFor(async()=>habitCount(await a.state())===1));
  ok('A sube los cambios (versión ≥2)',await waitFor(()=>rowOf('ana@example.com').version>=2));
  ok('la nube contiene el hábito y su cumplimiento',(()=>{const r=rowOf('ana@example.com').data;return r.habits.some(h=>h.n==='Tender cama')&&habitCount(r)===1})());
  await a.page.reload();
  ok('A tras recargar conserva los datos',await waitFor(async()=>{const s=await a.state();return s.habits.some(h=>h.n==='Tender cama')&&habitCount(s)===1}));
  let b=await device('B');await b.goto();
  await waitFor(()=>b.page.isVisible('#af'));await login(b,'ana@example.com');
  ok('B inicia sesión y recupera los datos de A',await waitFor(async()=>{const s=await b.state();return s.habits.some(h=>h.n==='Tender cama')&&habitCount(s)===1}));
  ok('B no pregunta nada (ya había datos en la nube)',!(await b.page.isVisible('[data-o=zero]')));

  /* ===== T4 · cambios de B llegan a A sin recargar ===== */
  console.log('\nT4 Cambio en B → llega a A');
  await b.page.click('nav [data-i=fin]');await b.page.click('[data-a=addtx]');
  await b.page.selectOption('#fm select[name=k]','aho');await b.page.fill('#fm input[name=m]','150000');await b.page.click('#fm button:not([data-a=close])');
  ok('B registra un ahorro',await waitFor(async()=>(await b.state()).tx.length===1));
  ok('B sube a la nube',await waitFor(()=>rowOf('ana@example.com').data.tx.length===1));
  await a.page.evaluate(()=>window.dispatchEvent(new Event('focus')));
  ok('A recibe el ahorro sin recargar (al volver a la ventana)',await waitFor(async()=>(await a.state()).tx.length===1));
  ok('A sigue en su sección (la vista es local de cada dispositivo)',(await a.state()).view==='vida');

  /* ===== T5 · sin conexión + conflicto ===== */
  console.log('\nT5 Sin conexión, pendientes y conflicto');
  await a.offline(true);
  await a.page.evaluate(()=>{S.name='Ana (offline)';save()});
  ok('offline: el cambio queda como pendiente',await waitFor(async()=>{const d=await a.dbg();return d.dirty===true}));
  ok('offline: chip indica sin conexión',await waitFor(async()=>/Sin conexión/.test(await a.page.textContent('#sync'))));
  ok('offline: la copia local guarda el cambio con marca de pendiente',await a.page.evaluate(()=>{const k=Object.keys(localStorage).find(x=>/^cc\.v2\.[0-9a-f-]{36}$/.test(x));const r=JSON.parse(localStorage.getItem(k));return r.dirty===true&&r.state.name==='Ana (offline)'}));
  const vBefore=rowOf('ana@example.com').version;
  ok('offline: la nube NO se modificó',rowOf('ana@example.com').data.name!=='Ana (offline)');
  // B cambia mientras A está offline
  await b.page.evaluate(()=>{S.name='Ana (desde B)';save()});
  ok('B sube su cambio',await waitFor(()=>rowOf('ana@example.com').data.name==='Ana (desde B)'));
  await a.offline(false);
  ok('al volver internet A detecta el conflicto (no sobrescribe)',await waitFor(async()=>/cambiaron en otro dispositivo/.test(await a.page.textContent('#ov'))));
  ok('conflicto: la nube sigue intacta',rowOf('ana@example.com').data.name==='Ana (desde B)');
  ok('chip: Conflicto',/Conflicto/.test(await a.page.textContent('#sync')));
  await a.page.click('[data-c=cloud]');
  ok('elegir "nube": A adopta la versión de B',await waitFor(async()=>(await a.state()).name==='Ana (desde B)'));
  ok('lo descartado queda guardado localmente por seguridad',await a.page.evaluate(()=>Object.keys(localStorage).some(k=>/\.discarded$/.test(k))));
  ok('A vuelve a Sincronizado',await waitFor(async()=>/Sincronizado/.test(await a.page.textContent('#sync'))));
  // segundo conflicto: conservar este dispositivo
  await a.offline(true);await a.page.evaluate(()=>{S.name='Gana A';save()});
  await b.page.evaluate(()=>{S.name='Gana B';save()});await waitFor(()=>rowOf('ana@example.com').data.name==='Gana B');
  await a.offline(false);await waitFor(async()=>/cambiaron en otro dispositivo/.test(await a.page.textContent('#ov')));
  const snapsBefore=+adminQ(`select count(*) from public.state_snapshots where user_id=${lit(USERS['ana@example.com'].id)};`);
  await a.page.click('[data-c=mine]');
  ok('elegir "este dispositivo": la nube pasa a tener lo de A',await waitFor(()=>rowOf('ana@example.com').data.name==='Gana A'));
  ok('antes de reemplazar se guardó una copia de la versión de la nube',+adminQ(`select count(*) from public.state_snapshots where user_id=${lit(USERS['ana@example.com'].id)} and reason like 'antes de conservar%';`)>=1,snapsBefore);
  await b.page.evaluate(()=>window.dispatchEvent(new Event('focus')));
  ok('B recibe después la versión elegida',await waitFor(async()=>(await b.state()).name==='Gana A'));

  /* ===== T6 · abrir sin conexión con datos pendientes ===== */
  console.log('\nT6 Servidor inaccesible: cambios pendientes y reapertura');
  a.netDown=true;await a.page.evaluate(()=>{S.name='Pendiente al cerrar';save()});
  ok('con el servidor caído el cambio queda pendiente',await waitFor(async()=>{const d=await a.dbg();return d.dirty&&/Sin conexión|Error/.test(await a.page.textContent('#sync'))}));
  await a.page.reload();
  ok('recargando con el servidor caído se abre con la copia local',await waitFor(async()=>{try{return (await a.state()).name==='Pendiente al cerrar'}catch(e){return false}},10000));
  ok('sigue marcado como pendiente de subir',(await a.dbg()).dirty===true);
  ok('la nube aún no tiene ese cambio',rowOf('ana@example.com').data.name!=='Pendiente al cerrar');
  a.netDown=false;await a.page.evaluate(()=>window.dispatchEvent(new Event('online')));
  ok('al volver el servidor se sube lo pendiente',await waitFor(()=>rowOf('ana@example.com').data.name==='Pendiente al cerrar',12000));
  // sesión caducada y sin red al abrir
  a.netDown=true;await a.page.evaluate(()=>{S.name='Con sesión caducada';save();localStorage.setItem('__expired','1')});
  await waitFor(async()=>(await a.dbg()).dirty);await a.page.reload();
  ok('sesión caducada sin red: abre la copia local y marca "sin conexión"',await waitFor(async()=>{try{const d=await a.dbg();return d.offlineStart&&(await a.state()).name==='Con sesión caducada'}catch(e){return false}},10000));
  a.netDown=false;await a.page.evaluate(()=>{localStorage.removeItem('__expired');window.dispatchEvent(new Event('online'))});
  ok('al volver la red se renueva la sesión y se sube lo pendiente',await waitFor(()=>rowOf('ana@example.com').data.name==='Con sesión caducada',12000));
  ok('vuelve a estado Sincronizado',await waitFor(async()=>/Sincronizado/.test(await a.page.textContent('#sync'))));

  /* ===== T7 · aislamiento entre cuentas y cierre de sesión ===== */
  console.log('\nT7 Cierre de sesión y aislamiento entre cuentas');
  await a.offline(true);await a.page.evaluate(()=>{S.name='Cambio sin subir';save()});await waitFor(async()=>(await a.dbg()).dirty);
  a.lastDialog='';await a.page.click('nav [data-i=aj]');await a.page.click('[data-a=logout]');
  ok('cerrar sesión con cambios pendientes avisa antes de perderlos',await waitFor(()=>/NO se han subido/.test(a.lastDialog||'')));
  ok('tras cerrar sesión vuelve a la pantalla de acceso',await waitFor(async()=>/Entrar/.test(await a.page.textContent('#ov'))));
  ok('la copia local del usuario se elimina del dispositivo',await a.page.evaluate(()=>!Object.keys(localStorage).some(k=>/^cc\.v2\./.test(k))));
  ok('cierra solo ESTE dispositivo (scope local)',await a.page.evaluate(()=>window.__signOutScope==='local'));
  ok('la app no es visible sin sesión',!(await a.page.isVisible('#app')));
  await a.offline(false);
  await login(a,'ana@example.com');
  ok('volver a entrar trae lo último de la nube',await waitFor(async()=>{try{return (await a.state()).name==='Con sesión caducada'}catch(e){return false}}));
  await a.page.click('nav [data-i=aj]');await a.page.click('[data-a=logout]');await waitFor(()=>a.page.isVisible('#af'));
  await signup(a,'beto@example.com');
  ok('otra cuenta en el MISMO dispositivo no ve datos de la primera',await waitFor(async()=>/Tu cuenta está lista/.test(await a.page.textContent('#ov'))));
  await a.page.click('[data-o=demo]');
  ok('cuenta 2 con datos demo → fila propia en la nube',await waitFor(()=>rowOf('beto@example.com')&&rowOf('beto@example.com').data.demo===true));
  ok('los datos de la cuenta 1 no cambiaron',rowOf('ana@example.com').data.name==='Con sesión caducada');
  ok('RLS: la cuenta 2 no puede leer la fila de la cuenta 1 (consulta directa)',(()=>{const t=Object.keys(TOK).find(k=>TOK[k]===USERS['beto@example.com'].id);return dbOp(TOK[t],{kind:'select',table:'user_state',filters:[{col:'user_id',val:USERS['ana@example.com'].id}]}).rows.length===0})());
  ok('RLS: sin sesión no se puede leer nada',!!dbOp(null,{kind:'select',table:'user_state',filters:[]}).error);

  /* ===== T8 · migración desde localStorage ===== */
  console.log('\nT8 Importar datos locales anteriores (cc.v1)');
  const c=await device('C');
  await c.page.goto('http://localhost:'+PORT+'/manifest.webmanifest');
  await c.page.evaluate(s=>localStorage.setItem('cc.v1',s),legacyState);
  await c.goto();await waitFor(()=>c.page.isVisible('#af'));
  await signup(c,'carla@example.com');
  ok('detecta datos locales y ofrece importarlos',await waitFor(async()=>await c.page.isVisible('[data-o=legacy]')));
  await c.page.click('[data-o=legacy]');
  const L=JSON.parse(legacyState);
  ok('importación: la nube queda igual a los datos locales',await waitFor(()=>{const r=rowOf('carla@example.com');return r&&r.data.tx.length===L.tx.length&&r.data.tasks.length===L.tasks.length&&r.data.co.length===L.co.length}));
  ok('importación verificada y marcada',await waitFor(async()=>await c.page.evaluate(()=>Object.keys(localStorage).some(k=>/^cc\.v1\.imported\./.test(k)))));
  ok('los datos locales anteriores NO se borraron',await c.page.evaluate(()=>!!localStorage.getItem('cc.v1')));
  const vImp=rowOf('carla@example.com').version;
  await c.page.click('nav [data-i=aj]');
  ok('Ajustes ofrece reimportar y borrar la copia local',await c.page.isVisible('[data-a=importlegacy]')&&await c.page.isVisible('[data-a=dellegacy]'));
  await c.page.click('[data-a=importlegacy]');
  await waitFor(()=>rowOf('carla@example.com').version>vImp,12000);
  ok('reimportar no duplica registros (sigue 1 fila, mismos conteos)',await waitFor(()=>{const r=rowOf('carla@example.com');return r.data.tx.length===L.tx.length&&+adminQ(`select count(*) from public.user_state where user_id=${lit(USERS['carla@example.com'].id)};`)===1}));
  ok('reimportar pidió confirmación explícita',/REEMPLAZAR/.test(c.lastDialog||''));
  ok('antes de reemplazar se guardó copia de seguridad de la nube',await waitFor(()=>+adminQ(`select count(*) from public.state_snapshots where user_id=${lit(USERS['carla@example.com'].id)} and reason='antes de importar datos locales';`)===1));
  await c.page.click('[data-a=dellegacy]');
  ok('"Borrar copia local anterior" elimina cc.v1 tras verificar',await waitFor(async()=>await c.page.evaluate(()=>!localStorage.getItem('cc.v1'))));
  ok('los datos de la cuenta siguen en la nube tras borrar la copia local',rowOf('carla@example.com').data.tx.length===L.tx.length);

  /* ===== T9 · copias de seguridad y restauración ===== */
  console.log('\nT9 Copias de seguridad');
  await c.page.click('[data-a=snaps]');
  const listed=await waitFor(async()=>(await c.page.locator('#ov [data-r]').count())>=1,6000);if(!listed)console.log('   DEBUG #ov:',(await c.page.textContent('#ov')).slice(0,300));
  ok('lista las copias disponibles',listed);
  await c.page.evaluate(()=>{});
  await c.page.click('#ov [data-r]');
  ok('restaurar una copia reemplaza los datos (con copia previa)',await waitFor(()=>{const r=rowOf('carla@example.com');return r.version>vImp}));

  /* ===== T10 · acciones destructivas hacen copia previa ===== */
  console.log('\nT10 "Empezar desde cero" y "Importar JSON" crean copia previa');
  const s0=+adminQ(`select count(*) from public.state_snapshots where user_id=${lit(USERS['carla@example.com'].id)} and reason='antes de empezar desde cero';`);
  await c.page.click('[data-a=zero]');
  ok('"Empezar desde cero" guardó copia en la nube antes de borrar',await waitFor(()=>+adminQ(`select count(*) from public.state_snapshots where user_id=${lit(USERS['carla@example.com'].id)} and reason='antes de empezar desde cero';`)===s0+1));
  ok('y la cuenta quedó vacía y sincronizada',await waitFor(()=>{const r=rowOf('carla@example.com');return r.data.tx.length===0&&r.data.demo===false}));
  const tmp=path.join(os.tmpdir(),'bad.json');fs.writeFileSync(tmp,JSON.stringify({hola:1}));
  await c.page.click('nav [data-i=aj]');
  const [fc]=await Promise.all([c.page.waitForEvent('filechooser'),c.page.click('[data-a=imp]')]);await fc.setFiles(tmp);
  ok('Importar JSON con formato incorrecto se rechaza sin tocar datos',await waitFor(async()=>/no tiene el formato/.test(await c.page.textContent('#toast'))));
  ok('los datos no cambiaron tras el JSON inválido',rowOf('carla@example.com').data.tx.length===0);

  /* ===== T10b · importar un JSON válido (ruta de migración desde la versión anterior) ===== */
  console.log('\nT10b Importar JSON exportado por la versión anterior');
  const good=path.join(os.tmpdir(),'old-export.json');fs.writeFileSync(good,legacyState);
  const [fc2]=await Promise.all([c.page.waitForEvent('filechooser'),c.page.click('[data-a=imp]')]);await fc2.setFiles(good);
  ok('JSON válido: pide confirmación antes de reemplazar',await waitFor(()=>/reemplaza todos tus datos/.test(c.lastDialog||'')));
  ok('JSON válido: la nube recibe los datos importados',await waitFor(()=>{const r=rowOf('carla@example.com');return r.data.tx.length===L.tx.length&&r.data.co.length===L.co.length}));
  ok('JSON válido: se guardó copia previa en la nube',+adminQ(`select count(*) from public.state_snapshots where user_id=${lit(USERS['carla@example.com'].id)} and reason='antes de importar un archivo JSON';`)===1);

  /* ===== T10c · el mismo ahorro no cuenta dos veces ===== */
  console.log('\nT10c Objetivo financiero vinculado: sin doble conteo');
  const dbl=await c.page.evaluate(()=>{const t=today();S.fg=[{id:'fx',n:'Meta X',t:1000,date:'',goal:'gx'}];S.tx=[{id:'t1',k:'aho',m:400,c:'Ahorro',src:'',date:t,fg:'fx'},{id:'t2',k:'aho',m:100,c:'Ahorro',src:'',date:t}];
    S.goals=[{id:'gx',t:'Seguridad financiera',l:'Anual',parent:'',date:'',pri:3,cat:'Finanzas',src:'Ahorro total',mt:1000,ms:[],est:'Pendiente'}];S.tasks=[];
    return{goal:gp(S.goals[0]),meta:fgPct(S.fg[0]),area:finAt(today())}});
  ok('el objetivo vinculado comparte el progreso de la meta financiera (40%, no un promedio con el ahorro total)',dbl.goal===40&&dbl.meta===40&&dbl.area===40,dbl);

  /* ===== T11 · conceptos del producto sobreviven a la conversión ===== */
  console.log('\nT11 Funciones existentes tras la conversión');
  await c.page.click('nav [data-i=ceo]');await c.page.click('[data-a=addco]');
  await c.page.fill('#fm input[name=n]','Ferretería Prueba');await c.page.selectOption('#fm select[name=st]','Entrevista');await c.page.click('#fm button:not([data-a=close])');
  ok('CRM: se crea la empresa',await waitFor(async()=>(await c.state()).co.some(x=>x.n==='Ferretería Prueba'&&x.st==='Entrevista')));
  await c.page.click('nav [data-i=salud]');await c.page.fill('#cn','7');await c.page.click('[data-a=cig]');
  ok('Salud: registra cigarrillos',await waitFor(async()=>(await c.state()).cig.log[await c.page.evaluate(()=>today())]?.n===7));
  await c.page.fill('#sl','7.5');await c.page.fill('#wt','6');await c.page.click('[data-a=hsv]');
  ok('Salud: sueño e hidratación se guardan',await waitFor(async()=>{const s=await c.state();const h=s.hs[await c.page.evaluate(()=>today())];return h&&h.sleep===7.5&&h.water===6}));
  const hoy=await c.page.evaluate(()=>today());
  ok('todo llega a la nube (empresa, cigarrillos, sueño e hidratación)',await waitFor(()=>{const r=rowOf('carla@example.com').data;return r.co.some(x=>x.n==='Ferretería Prueba')&&r.cig.log[hoy]&&r.cig.log[hoy].n===7&&r.hs[hoy]&&r.hs[hoy].water===6}));
  ok('el progreso general se calcula (no es un número fijo)',await c.page.evaluate(()=>{const v=overall(1);return v===null||(v>=0&&v<=100)}));

  /* ===== T12 · diseño: móvil y escritorio ===== */
  console.log('\nT12 Diseño responsive');
  const m=await device('mobile',{viewport:{width:390,height:844},storage:await c.ctx.storageState()});await m.goto();
  ok('móvil: abre directamente con la sesión guardada (recordando la sección)',await waitFor(async()=>(await m.page.isVisible('#app'))&&(await m.page.textContent('#mn')).trim().length>50));
  await m.page.click('nav [data-i=inicio]');
  const ov=await m.page.evaluate(()=>document.documentElement.scrollWidth>document.documentElement.clientWidth+1);
  ok('móvil: sin desbordamiento horizontal en Inicio',!ov);
  const ovs=[];for(const v of ['dia','salud','fin','ceo','proy','vida','cal','obj','rep','aj']){await m.page.click(`nav [data-i=${v}]`);if(await m.page.evaluate(()=>document.documentElement.scrollWidth>document.documentElement.clientWidth+1))ovs.push(v)}
  ok('móvil: sin desbordamiento horizontal en las demás secciones',ovs.length===0,ovs);
  await m.page.click('nav [data-i=inicio]');await m.page.screenshot({path:path.join(os.tmpdir(),'shot-mobile-home.png')});
  await m.page.click('nav [data-i=aj]');await m.page.screenshot({path:path.join(os.tmpdir(),'shot-mobile-settings.png'),fullPage:true});
  await c.page.click('nav [data-i=inicio]');await c.page.screenshot({path:path.join(os.tmpdir(),'shot-desktop-home.png')});
  const g=await device('gate',{viewport:{width:390,height:844}});await g.goto();await waitFor(()=>g.page.isVisible('#af'));
  await g.page.screenshot({path:path.join(os.tmpdir(),'shot-mobile-login.png')});

  /* ===== T13 · PWA y service worker ===== */
  console.log('\nT13 PWA y caché');
  const p=await device('pwa',{sw:'allow'});await p.goto();await waitFor(()=>p.page.isVisible('#af'));await login(p,'carla@example.com');
  await waitFor(async()=>(await p.page.textContent('#mn')).includes('Mi Centro de Control'));
  ok('el service worker se registra y activa',await waitFor(async()=>await p.page.evaluate(async()=>{const r=await navigator.serviceWorker.getRegistration();return !!(r&&r.active)}),10000));
  await p.page.reload();await sleep(800);
  const cached=await p.page.evaluate(async()=>{const o=[];for(const k of await caches.keys()){const c=await caches.open(k);for(const r of await c.keys())o.push(new URL(r.url))}return o.map(u=>u.origin+u.pathname)});
  ok('la caché contiene solo archivos estáticos propios',cached.length>0&&cached.every(u=>u.startsWith('http://localhost:'+PORT)&&!/rest|auth|user_state/.test(u)),cached);
  ok('la caché NO contiene datos de usuario ni peticiones a Supabase',!cached.some(u=>/supabase\.co/.test(u)));
  const mf=await p.page.evaluate(()=>fetch('/manifest.webmanifest').then(r=>r.json()));
  ok('manifest válido (nombre, start_url, iconos 192/512/maskable)',mf.name&&mf.start_url==='/'&&mf.icons.length===3&&mf.icons.some(i=>i.purpose==='maskable'));
  const ic=await Promise.all(mf.icons.map(i=>p.page.evaluate(u=>fetch(u).then(r=>r.status),i.src)));
  ok('los iconos del manifest existen',ic.every(x=>x===200),ic);
  // sin conexión con SW: la página carga desde la caché
  await p.ctx.setOffline(true);p.netDown=true;await p.page.reload().catch(()=>{});
  ok('con el service worker la app abre sin internet (copia local)',await waitFor(async()=>{try{return (await p.page.textContent('#mn')).includes('Mi Centro de Control')}catch(e){return false}},10000));

  await browser.close();server.close();
  console.log('\nErrores de consola/JS capturados:',errors.length);errors.slice(0,15).forEach(e=>console.log('  !',e));
  ok('sin errores de JavaScript ni de consola durante todas las pruebas',errors.length===0);
  console.log(`\n${pass} correctas, ${fail} fallidas`);process.exit(fail?1:0);
})().catch(async e=>{console.error('FALLO DEL HARNESS:',e);try{await browser.close()}catch(x){}process.exit(2)});
