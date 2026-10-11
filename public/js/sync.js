/* sync.js — cuentas (Supabase Auth), copia local por usuario y sincronización en la nube.

   Modelo de datos: UN documento JSON por usuario (tabla public.user_state) con número de
   versión. Cada subida usa "compare-and-set": solo se acepta si la versión de la nube sigue
   siendo la que este dispositivo conocía. Si otro dispositivo cambió algo en medio, NO se
   sobrescribe nada: se muestra un aviso de conflicto y tú eliges qué versión conservar.
   Antes de cualquier reemplazo se guarda una copia en public.state_snapshots.            */
const Sync=(()=>{
'use strict';
const LEGACY='cc.v1',LAST='cc.lastuser',LASTMAIL='cc.lastemail',LOCALFLAG='cc.localmode',IMPORTED='cc.v1.imported.';
const $=s=>document.querySelector(s);
const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
let H=null,sb=null,cfg=null,user=null,mode='none';          // mode: none | cloud | local
let base=0,dirty=false,busy=false,pushT=null,retryT=null,retryMs=5000,pollT=null;
let status='idle',lastSync=0,lastErr='',conflictOpen=false,offlineStart=false,recovering=false,loggingOut=false,bound=false;

/* ---------- utilidades ---------- */
const clean=s=>{const o=JSON.parse(JSON.stringify(s));delete o.view;return o};   // "view" es solo del dispositivo
const deq=(a,b)=>{if(a===b)return true;if(!a||!b||typeof a!=='object'||typeof b!=='object'||Array.isArray(a)!==Array.isArray(b))return false;const ka=Object.keys(a);return ka.length===Object.keys(b).length&&ka.every(k=>deq(a[k],b[k]))};
const hhmm=t=>new Date(t).toLocaleTimeString('es-CO',{hour:'2-digit',minute:'2-digit'});
const fdate=t=>t?new Date(t).toLocaleString('es-CO',{dateStyle:'medium',timeStyle:'short'}):'—';
const sumTxt=o=>`${o.tasks.length} tareas · ${o.tx.length} movimientos · ${o.co.length} empresas · ${o.wk.length} entrenamientos`;
const kUser=id=>'cc.v2.'+id;
const isNet=e=>{const m=String((e&&e.message)||e||'');return !navigator.onLine||/failed to fetch|networkerror|network request failed|load failed|fetch failed|timeout|retryable/i.test(m)||!!(e&&e.name==='AuthRetryableFetchError')};
const isAuthErr=e=>!!e&&(e.status===401||e.code==='PGRST301'||/jwt expired|invalid jwt|jwt/i.test(e.message||''));
function tr(e){const m=String((e&&e.message)||e||'');
  if(/invalid login credentials/i.test(m))return 'Correo o contraseña incorrectos.';
  if(/email not confirmed/i.test(m))return 'Debes confirmar tu correo antes de entrar. Revisa tu bandeja de entrada y el spam.';
  if(/already registered|already been registered/i.test(m))return 'Ya existe una cuenta con ese correo. Usa "Entrar".';
  if(/password should|weak password|at least \d/i.test(m))return 'La contraseña es demasiado corta o débil (mínimo 8 caracteres).';
  if(/rate limit|too many|over_.*_rate/i.test(m)||(e&&e.status===429))return 'Demasiados intentos. Espera unos minutos e inténtalo de nuevo.';
  if(isNet(e))return 'Sin conexión con el servidor. Revisa tu internet.';
  if(/PGRST205|schema cache|does not exist/i.test(m))return 'Faltan las tablas en Supabase. Ejecuta el archivo supabase/schema.sql.';
  if(/row-level security|permission denied|42501/i.test(m))return 'El servidor rechazó la operación (permisos). Revisa que ejecutaste todo el SQL de Supabase.';
  return m||'Error desconocido.'}

/* ---------- almacenamiento local (por usuario) ---------- */
function readLocal(id){try{const r=JSON.parse(localStorage.getItem(kUser(id)));return r&&r.v===2&&H.valid(r.state)?r:null}catch(e){return null}}
function readLegacy(){try{const o=JSON.parse(localStorage.getItem(LEGACY));return H.valid(o)?o:null}catch(e){return null}}
function writeLocal(){
  try{
    if(mode==='cloud'&&user)localStorage.setItem(kUser(user.id),JSON.stringify({v:2,state:H.get(),base,dirty,saved:Date.now()}));
    else if(mode==='local')localStorage.setItem(LEGACY,JSON.stringify(H.get()));
    return true;
  }catch(e){lastErr='No se pudo guardar en este dispositivo (almacenamiento lleno o bloqueado).';setStatus('error');return false}
}
const persistLocal=()=>{if(H&&H.get())writeLocal()};

/* ---------- estado visible ---------- */
function calc(){return mode==='local'?'local':conflictOpen?'conflict':busy?'syncing':!navigator.onLine||offlineStart?'offline':dirty?'pending':'saved'}
function setStatus(s){status=s||calc();paint()}
const LBL={local:['💾','Solo este dispositivo'],saved:['☁️','Sincronizado'],syncing:['🔄','Sincronizando…'],pending:['⏳','Cambios sin subir'],offline:['📴','Sin conexión'],error:['⚠️','Error al sincronizar'],conflict:['⚠️','Conflicto: elige versión'],idle:['','']};
function statusText(){const l=LBL[status]||LBL.idle;return l[0]+' '+l[1]+(status==='saved'&&lastSync?' · '+hhmm(lastSync):'')+((status==='offline')&&dirty?' · cambios pendientes':'')}
function paint(){
  const c=$('#sync');
  if(c){c.className='chip sync-'+status;c.hidden=mode==='none';c.textContent=statusText();c.title=lastErr||''}
  const k=$('#sync-card');if(k)k.innerHTML=cardInner();
}

/* ---------- superposición (login, avisos, conflictos) ---------- */
function ov(html,hideApp){const o=$('#ov');o.innerHTML='<div class=box>'+html+'</div>';o.classList.add('on');if(hideApp)$('#app').classList.add('off')}
function ovClose(){const o=$('#ov');o.classList.remove('on');o.innerHTML=''}
const showApp=()=>{$('#app').classList.remove('off');ovClose()};

/* ---------- acceso: entrar / crear cuenta / recuperar ---------- */
function showAuth(msg,tab){
  tab=tab||'in';conflictOpen=false;mode=mode==='cloud'?'none':mode;paint();
  const cfgOK=!!sb;
  ov(`<div class=lg2>◎</div><h1>Mi Centro de Control</h1><p class=sub>Construyendo mi independencia y mi empresa</p>
  ${cfgOK?`<div class=tabs><button class="btn sm ${tab==='in'?'':'g'}" data-t=in type=button>Entrar</button><button class="btn sm ${tab==='up'?'':'g'}" data-t=up type=button>Crear cuenta</button></div>
  <form id=af><label>Correo</label><input name=email type=email autocomplete=email required>
  ${tab==='forgot'?'':`<label>Contraseña</label><input name=pw type=password minlength=8 autocomplete="${tab==='in'?'current-password':'new-password'}" required>`}
  ${tab==='up'?'<label>Repite la contraseña</label><input name=pw2 type=password minlength=8 autocomplete=new-password required>':''}
  <div id=amsg class=amsg role=alert>${esc(msg||'')}</div><button class=btn style="width:100%">${tab==='in'?'Entrar':tab==='up'?'Crear cuenta':'Enviar enlace'}</button></form>
  ${tab==='in'?'<button class="btn g sm lnk" data-t=forgot type=button>Olvidé mi contraseña</button>':''}`
  :`<div class=amsg role=alert>La sincronización no está configurada en este despliegue (faltan las variables SUPABASE_URL y SUPABASE_ANON_KEY al construir el proyecto). ${esc(msg||'')}</div>`}
  <button class="btn g sm lnk" data-t=local type=button>Usar sin cuenta (solo este dispositivo, sin sincronizar)</button>`,true);
  const f=$('#af');if(!f)return;
  f.onsubmit=async e=>{
    e.preventDefault();const fd=new FormData(f),email=String(fd.get('email')||'').trim(),pw=String(fd.get('pw')||''),say=t=>{const m=$('#amsg');if(m)m.textContent=t};
    if(tab==='up'&&pw!==fd.get('pw2'))return say('Las contraseñas no coinciden.');
    const b=f.querySelector('button');b.disabled=true;say('');
    try{
      if(tab==='in'){const{data,error}=await sb.auth.signInWithPassword({email,password:pw});if(error)throw error;await enter(data.user)}
      else if(tab==='up'){
        const{data,error}=await sb.auth.signUp({email,password:pw,options:{emailRedirectTo:location.origin}});if(error)throw error;
        if(data.user&&data.user.identities&&data.user.identities.length===0)throw new Error('User already registered');
        if(!data.session)return showAuth('✅ Cuenta creada. Te enviamos un correo de confirmación: ábrelo y luego vuelve aquí a entrar.','in');
        await enter(data.user);
      }else{
        const{error}=await sb.auth.resetPasswordForEmail(email,{redirectTo:location.origin});if(error)throw error;
        showAuth('Si el correo existe, recibirás un enlace para crear una contraseña nueva.','in');
      }
    }catch(err){say(tr(err));if(b)b.disabled=false}
  };
}
function showRecovery(){
  ov(`<div class=lg2>◎</div><h1>Nueva contraseña</h1><form id=rf><label>Nueva contraseña</label><input name=pw type=password minlength=8 autocomplete=new-password required><label>Repítela</label><input name=pw2 type=password minlength=8 autocomplete=new-password required><div id=amsg class=amsg role=alert></div><button class=btn style="width:100%">Guardar contraseña</button></form>`,true);
  $('#rf').onsubmit=async e=>{
    e.preventDefault();const fd=new FormData(e.target),say=t=>{$('#amsg').textContent=t};
    if(fd.get('pw')!==fd.get('pw2'))return say('Las contraseñas no coinciden.');
    const{error}=await sb.auth.updateUser({password:String(fd.get('pw'))});if(error)return say(tr(error));
    recovering=false;history.replaceState(null,'',location.pathname);
    const{data}=await sb.auth.getUser();if(data&&data.user)enter(data.user);else showAuth('Contraseña actualizada. Inicia sesión.','in');
  };
}

/* ---------- nube: lectura, escritura, copias ---------- */
async function fetchRemote(){
  const r=await sb.from('user_state').select('version,data,updated_at').eq('user_id',user.id).maybeSingle();
  if(r.error)throw r.error;return r.data||null;
}
async function saveSnapshot(version,data,reason){
  const r=await sb.from('state_snapshots').insert({user_id:user.id,version,reason,data});if(r.error)throw r.error;
}
async function backupOk(reason){
  if(mode!=='cloud')return true;
  try{
    if(!navigator.onLine)throw new Error('sin conexión');
    if(dirty&&!conflictOpen)await push();                    // sube primero lo pendiente para no perderlo
    const r=await fetchRemote();if(r)await saveSnapshot(r.version,r.data,reason);
    return true;
  }catch(e){return confirm('No se pudo guardar una copia de seguridad en la nube ('+tr(e)+').\n\n¿Continuar de todos modos? Podrías perder los datos actuales.')}
}

/* Subida con control de versión. Devuelve: ok | conflict | fail | skip */
async function push(){
  if(mode!=='cloud'||!user||!sb||busy||!dirty||conflictOpen||offlineStart)return 'skip';
  if(!navigator.onLine){setStatus('offline');return 'skip'}
  clearTimeout(pushT);busy=true;setStatus('syncing');
  const snap=clean(H.get()),sig=JSON.stringify(snap),sent=base;
  try{
    if(!H.valid(snap))throw new Error('El estado local no es válido: no se sube a la nube.');
    if(sig.length>4e6)throw new Error('Los datos superan el tamaño máximo permitido (4 MB). Exporta una copia y revisa el historial.');
    let row;
    if(sent===0){
      const r=await sb.from('user_state').insert({user_id:user.id,data:snap,version:1}).select('version').single();
      if(r.error){if(r.error.code==='23505'){busy=false;await divergence();return 'conflict'}throw r.error}
      row=r.data;
    }else{
      const r=await sb.from('user_state').update({data:snap,version:sent+1}).eq('user_id',user.id).eq('version',sent).select('version');
      if(r.error){if(r.error.code==='40001'){busy=false;await divergence();return 'conflict'}throw r.error}
      if(!r.data||!r.data.length){busy=false;await divergence();return 'conflict'}
      row=r.data[0];
    }
    base=row.version;dirty=JSON.stringify(clean(H.get()))!==sig;   // si cambió mientras subía, sigue pendiente
    lastSync=Date.now();lastErr='';retryMs=5000;busy=false;writeLocal();setStatus();
    if(dirty)schedulePush(400);
    return 'ok';
  }catch(e){busy=false;await handleErr(e);return 'fail'}
}
const schedulePush=ms=>{clearTimeout(pushT);pushT=setTimeout(push,ms||1500)};
function scheduleRetry(){clearTimeout(retryT);retryT=setTimeout(()=>{push();pull()},retryMs);retryMs=Math.min(retryMs*2,60000)}
async function handleErr(e){
  lastErr=tr(e);
  if(isAuthErr(e)&&sb){
    const r=await sb.auth.refreshSession().catch(x=>({error:x}));
    if(!r.error){schedulePush(500);return}
    if(!isNet(r.error))return sessionLost('Tu sesión expiró. Inicia sesión de nuevo; los cambios pendientes de este dispositivo se conservan.');
  }
  setStatus(isNet(e)?'offline':'error');scheduleRetry();
}

/* Descarga de cambios hechos en otro dispositivo */
async function pull(){
  if(mode!=='cloud'||!user||!sb||busy||conflictOpen||offlineStart||!navigator.onLine)return;
  try{
    const r=await sb.from('user_state').select('version').eq('user_id',user.id).maybeSingle();if(r.error)throw r.error;
    if(!r.data){if(base>0){dirty=true;base=0;writeLocal();schedulePush(300)}return}   // la fila fue borrada: se vuelve a crear con lo local
    if(r.data.version<=base){if(status==='error'||status==='offline')setStatus();return}
    if(dirty)return divergence();
    if(editing())return;                                       // no interrumpir mientras escribes; se reintenta en el próximo ciclo
    const f=await fetchRemote();if(!f||f.version<=base)return;
    if(dirty)return divergence();                              // cambió mientras descargaba
    adopt(f.data,f.version,false);lastSync=Date.now();setStatus();H.toast('☁️ Datos actualizados desde otro dispositivo');
  }catch(e){await handleErr(e)}
}
const editing=()=>{const a=document.activeElement;return $('#md').classList.contains('on')||$('#ov').classList.contains('on')||(a&&/^(INPUT|TEXTAREA|SELECT)$/.test(a.tagName))};
function adopt(state,v,d){H.set(JSON.parse(JSON.stringify(state)));base=v;dirty=d;writeLocal();showApp();H.render();setStatus()}

/* ---------- conflicto entre dispositivos ---------- */
async function divergence(){
  let remote;try{remote=await fetchRemote()}catch(e){return handleErr(e)}
  if(!remote){base=0;schedulePush(300);return}
  if(remote.version===base){schedulePush(300);return}
  conflictModal(clean(H.get()),remote);
}
function conflictModal(mine,remote){
  conflictOpen=true;setStatus();
  const box=(t,o,when)=>`<div class=cmp><h3>${t}</h3><div class=sub>${esc(when)}</div><div>${esc(sumTxt(o))}</div></div>`;
  ov(`<h2>⚠️ Tus datos cambiaron en otro dispositivo</h2><p class=sub>Este dispositivo y la nube tienen versiones distintas. No se ha sobrescrito nada. Elige cuál conservar (la otra se guarda como copia de seguridad cuando es posible).</p>
  <div class=cmpgrid>${box('Este dispositivo',mine,'cambios sin subir')}${box('Nube',remote.data,'actualizada '+fdate(remote.updated_at))}</div>
  <div class=stack><button class=btn data-c=cloud>Usar la versión de la nube</button><button class="btn g" data-c=mine>Conservar este dispositivo (reemplaza la nube)</button><button class="btn g" data-c=dl>Descargar copia de este dispositivo (JSON)</button></div>`,true);
  $('#ov').onclick=async e=>{
    const b=e.target.closest('[data-c]');if(!b)return;const c=b.dataset.c;
    if(c==='dl')return download(mine,'centro-de-control-este-dispositivo.json');
    if(c==='cloud'){
      if(!confirm('Los cambios de este dispositivo no subidos se descartarán. ¿Usar la versión de la nube?'))return;
      try{localStorage.setItem(kUser(user.id)+'.discarded',JSON.stringify({at:Date.now(),state:mine}))}catch(x){}
      conflictOpen=false;$('#ov').onclick=null;adopt(remote.data,remote.version,false);startLoops();
    }else{
      try{await saveSnapshot(remote.version,remote.data,'antes de conservar la versión de un dispositivo')}
      catch(x){if(!confirm('No se pudo guardar copia de la versión de la nube ('+tr(x)+'). ¿Reemplazarla de todos modos?'))return}
      H.set(JSON.parse(JSON.stringify(mine)));base=remote.version;dirty=true;conflictOpen=false;$('#ov').onclick=null;writeLocal();showApp();H.render();startLoops();push();
    }
  };
}
function download(obj,name){const b=new Blob([JSON.stringify(obj,null,1)],{type:'application/json'}),a=document.createElement('a');a.href=URL.createObjectURL(b);a.download=name;a.click();setTimeout(()=>URL.revokeObjectURL(a.href),2000)}

/* ---------- entrada a una cuenta ---------- */
async function enter(u,offline){
  user={id:u.id,email:u.email||localStorage.getItem(LASTMAIL)||''};mode='cloud';offlineStart=!!offline;
  localStorage.setItem(LAST,user.id);if(user.email)localStorage.setItem(LASTMAIL,user.email);localStorage.removeItem(LOCALFLAG);
  const L=readLocal(user.id);let remote=null,netFail=false;
  if(!offline){try{remote=await fetchRemote()}catch(e){if(isNet(e))netFail=true;else{lastErr=tr(e);return fatal(lastErr)}}}
  if(offline||netFail){
    if(L){offlineStart=true;adopt(L.state,L.base,L.dirty);startLoops();return}
    return fatal(netFail?'No hay conexión y este dispositivo no tiene una copia local de tus datos. Conéctate a internet e inténtalo de nuevo.':'Sin conexión.');
  }
  offlineStart=false;
  if(remote){
    if(L&&L.dirty){
      if(L.base===remote.version){adopt(L.state,L.base,true);startLoops();schedulePush(500)}
      else{H.set(L.state);base=L.base;dirty=true;conflictModal(clean(L.state),remote);startLoops()}   // conflicto: decide el usuario
    }else{adopt(remote.data,remote.version,false);lastSync=Date.now();setStatus();startLoops()}
    return;
  }
  if(L){adopt(L.state,0,true);startLoops();push();return}   // hay copia local pero aún no hay fila en la nube
  onboarding();
}
function fatal(msg){stopLoops();ov(`<h2>No se pudieron cargar tus datos</h2><div class=amsg role=alert>${esc(msg)}</div><div class=stack><button class=btn data-o=retry>Reintentar</button><button class="btn g" data-o=out>Cerrar sesión</button></div>`,true);
  $('#ov').onclick=e=>{const b=e.target.closest('[data-o]');if(!b)return;if(b.dataset.o==='retry')enter(user,false);else logout(true)}}
function onboarding(){
  const L=readLegacy();
  ov(`<h2>Tu cuenta está lista</h2><p class=sub>Todavía no tienes datos en la nube. ¿Cómo quieres empezar?</p><div class=stack>
  ${L?`<button class=btn data-o=legacy>Importar los datos de este navegador<br><small>${esc(sumTxt(L))}</small></button>`:''}
  <button class="btn ${L?'g':''}" data-o=zero>Empezar desde cero</button><button class="btn g" data-o=demo>Ver con datos de demostración</button></div>
  ${L?'<p class=sub>Tus datos locales NO se borran: se copian a la nube y se verifica la copia. Puedes borrarlos después desde Ajustes.</p>':''}`,true);
  $('#ov').onclick=async e=>{
    const b=e.target.closest('[data-o]');if(!b)return;const o=b.dataset.o;$('#ov').onclick=null;
    const st=o==='legacy'?JSON.parse(JSON.stringify(L)):H.fresh(o);
    ov('<h2>Guardando en la nube…</h2><p class=sub>No cierres esta ventana.</p>',true);
    H.set(st);base=0;dirty=true;writeLocal();
    const res=await push();
    if(res==='ok'){
      if(o==='legacy'){
        const r=await fetchRemote().catch(()=>null);
        if(r&&deq(clean(r.data),clean(H.get()))){localStorage.setItem(IMPORTED+user.id,new Date().toISOString());H.toast('✅ Importación verificada')}
        else alert('La importación no se pudo verificar. Tus datos locales anteriores NO se borraron.');
      }
      showApp();H.render();startLoops();
    }else if(res!=='conflict'){alert('No se pudo guardar en la nube: '+lastErr+'\nTus datos siguen guardados en este dispositivo y se reintentará automáticamente.');showApp();H.render();startLoops()}
  };
}

/* ---------- modo sin cuenta ---------- */
function startLocal(){
  mode='local';localStorage.setItem(LOCALFLAG,'1');
  const o=readLegacy();H.set(o||H.fresh('demo'));writeLocal();showApp();H.render();setStatus();
}
function showLogin(){localStorage.removeItem(LOCALFLAG);mode='none';paint();showAuth('','in')}

/* ---------- bucles, eventos, cierre de sesión ---------- */
function startLoops(){stopLoops();pollT=setInterval(()=>{if(document.visibilityState==='visible')pull()},20000);setStatus()}
function stopLoops(){clearInterval(pollT);clearTimeout(pushT);clearTimeout(retryT)}
function sessionLost(msg){stopLoops();conflictOpen=false;mode='none';user=null;paint();showAuth(msg,'in')}
async function logout(skipPush){
  if(mode!=='cloud')return;
  if(!skipPush&&dirty&&navigator.onLine)await push();
  const cache=user&&readLocal(user.id);
  if((dirty||(cache&&cache.dirty))&&!confirm('Hay cambios de este dispositivo que NO se han subido a la nube. Si cierras sesión se perderán.\n\n¿Cerrar sesión de todos modos?'))return;
  loggingOut=true;stopLoops();
  try{await sb.auth.signOut({scope:'local'})}catch(e){}
  try{localStorage.removeItem(kUser(user.id));localStorage.removeItem(kUser(user.id)+'.discarded');localStorage.removeItem(LAST);localStorage.removeItem(LASTMAIL)}catch(e){}
  user=null;mode='none';base=0;dirty=false;lastSync=0;loggingOut=false;paint();showAuth('Sesión cerrada.','in');
}
async function syncNow(){
  if(mode!=='cloud')return H.toast('Estás en modo sin cuenta: no hay nube a la que sincronizar.');
  if(!navigator.onLine)return H.toast('Sin conexión: se sincronizará al volver internet.');
  if(offlineStart)await retryAuth();
  await push();await pull();
  H.toast(status==='saved'?'☁️ Sincronizado':'No se pudo sincronizar del todo: '+(lastErr||statusText()));
}
async function retryAuth(){
  if(!offlineStart||!sb)return;
  const{data,error}=await sb.auth.getSession().catch(e=>({data:{},error:e}));
  if(data&&data.session){user={id:data.session.user.id,email:data.session.user.email||user.email};offlineStart=false;setStatus();pull();push();startLoops()}
  else if(!error)sessionLost('Tu sesión expiró. Inicia sesión de nuevo; los cambios pendientes de este dispositivo se conservan.');
}
function bindEvents(){
  if(bound)return;bound=true;
  window.addEventListener('online',()=>{setStatus();if(offlineStart)retryAuth();else{push();pull()}});
  window.addEventListener('offline',()=>setStatus());
  document.addEventListener('visibilitychange',()=>{if(document.visibilityState==='visible')pull();else push()});
  window.addEventListener('focus',()=>pull());
  $('#ov').addEventListener('click',e=>{
    const t=e.target.closest('[data-t]');if(t){const v=t.dataset.t;if(v==='local')return startLocal();return showAuth('',v)}
    if(e.target.closest('[data-x]'))ovClose();
  });
  if('serviceWorker' in navigator&&(location.protocol==='https:'||location.hostname==='localhost'))window.addEventListener('load',()=>navigator.serviceWorker.register('/sw.js').catch(()=>{}));
}

/* ---------- pantallas de cuenta ---------- */
function cardInner(){
  if(mode==='local')return `<h2>Cuenta y sincronización</h2><p class=sub>Estás usando la app <b>sin cuenta</b>: tus datos solo existen en este navegador y <b>no se sincronizan</b> con otros dispositivos.</p><button class=btn data-a=login>Iniciar sesión / crear cuenta</button>`;
  if(mode!=='cloud'||!user)return '';
  const L=readLegacy(),imp=localStorage.getItem(IMPORTED+user.id);
  return `<h2>Cuenta y sincronización</h2><div class=sub>Sesión: <b>${esc(user.email)}</b></div><div class=sub>Estado: ${esc(statusText())}</div>${lastErr?`<div class=sub style="color:var(--r)">${esc(lastErr)}</div>`:''}
  <div class=tabs style="margin-top:8px"><button class="btn g" data-a=syncnow>Sincronizar ahora</button><button class="btn g" data-a=snaps>Copias de seguridad</button>${L?'<button class="btn g" data-a=importlegacy>Importar datos locales anteriores</button>':''}${imp&&L?'<button class="btn g" data-a=dellegacy>Borrar copia local anterior</button>':''}<button class="btn g" data-a=logout>Cerrar sesión</button></div>`;
}
const dataNote=()=>mode==='cloud'?'Tus datos se guardan en tu cuenta (nube) y en una copia local de este dispositivo. "Exportar JSON" descarga una copia manual.':'Datos guardados solo en este navegador. Exporta una copia con frecuencia.';
function account(){ov(`<h2>Cuenta</h2>${cardInner()||'<p class=sub>Sin sesión.</p>'}<div class=stack style="margin-top:12px"><button class="btn g" data-x=1>Cerrar ventana</button></div>`,false)}

async function importLegacy(){
  if(mode!=='cloud')return;const L=readLegacy();if(!L)return H.toast('No hay datos locales anteriores en este navegador.');
  if(!confirm(`Se encontraron datos locales en este navegador (${sumTxt(L)}).\n\nSi continúas, REEMPLAZARÁN los datos actuales de tu cuenta en la nube. Antes se guardará una copia de seguridad de la nube.\n\n¿Importar?`))return;
  if(!await backupOk('antes de importar datos locales'))return;
  ov('<h2>Importando…</h2><p class=sub>No cierres esta ventana.</p>',false);
  H.set(JSON.parse(JSON.stringify(L)));dirty=true;writeLocal();H.render();
  const res=await push();let ok=false;
  if(res==='ok'){const r=await fetchRemote().catch(()=>null);ok=!!r&&deq(clean(r.data),clean(H.get()))}
  if(!conflictOpen)ovClose();
  if(ok){localStorage.setItem(IMPORTED+user.id,new Date().toISOString());H.toast('✅ Importación verificada. Tus datos locales anteriores siguen guardados.');paint()}
  else if(res!=='conflict')alert('No se pudo verificar la importación ('+(lastErr||'sin detalle')+'). Tus datos locales anteriores NO se borraron.');
}
function deleteLegacy(){
  if(!user||!localStorage.getItem(IMPORTED+user.id))return H.toast('Primero importa y verifica los datos locales.');
  if(!confirm('Se borrará la copia local ANTERIOR de este navegador (ya verificada en tu cuenta). ¿Borrar?'))return;
  localStorage.removeItem(LEGACY);paint();H.toast('Copia local anterior borrada');
}
async function snapshots(){
  if(mode!=='cloud')return;
  ov('<h2>Copias de seguridad</h2><p class=sub>Cargando…</p>',false);
  const r=await sb.from('state_snapshots').select('id,version,reason,created_at').eq('user_id',user.id).order('created_at',{ascending:false}).limit(15);
  if(r.error){ov(`<h2>Copias de seguridad</h2><div class=amsg>${esc(tr(r.error))}</div><div class=stack><button class="btn g" data-x=1>Cerrar</button></div>`,false);return}
  ov(`<h2>Copias de seguridad</h2><p class=sub>Se crean automáticamente (máx. una cada 20 h) y antes de reemplazar datos. Se conservan las últimas 30.</p>
  ${r.data.map(s=>`<div class=row><div>${esc(fdate(s.created_at))}<div class=sub>${esc(s.reason)} · versión ${s.version}</div></div><button class="btn g sm" data-r=${s.id}>Restaurar</button></div>`).join('')||'<p class=sub>Aún no hay copias.</p>'}
  <div class=stack style="margin-top:12px"><button class="btn g" data-x=1>Cerrar</button></div>`,false);
  $('#ov').onclick=async e=>{
    if(e.target.closest('[data-x]')){$('#ov').onclick=null;return ovClose()}
    const b=e.target.closest('[data-r]');if(!b)return;
    const q=await sb.from('state_snapshots').select('data').eq('id',b.dataset.r).single();
    if(q.error||!H.valid(q.data.data))return H.toast('No se pudo leer esa copia.');
    if(!confirm('Se reemplazarán tus datos actuales por esta copia (se guarda antes una copia de los actuales). ¿Restaurar?'))return;
    if(!await backupOk('antes de restaurar una copia'))return;
    $('#ov').onclick=null;H.set(q.data.data);dirty=true;writeLocal();ovClose();H.render();push();H.toast('Copia restaurada');
  };
}

/* ---------- foto de perfil: Supabase Storage (bucket privado "avatars") + public.profiles ----------
   La ruta de la foto vive en la nube (profiles.avatar_path), nunca solo en el navegador; así se
   sincroniza entre dispositivos. Se muestra con una URL firmada de 1 h que se renueva sola.
   Cada archivo tiene nombre único dentro de la carpeta "<user_id>/", y la foto anterior solo se
   borra DESPUÉS de que el perfil ya apunta a la nueva.                                           */
const AV_BUCKET='avatars',AV_TYPES=['image/jpeg','image/png','image/webp'],AV_IN_MAX=12*1024*1024,AV_OUT_MAX=2*1024*1024,AV_PX=512,AV_TTL=50*60e3;
let av={url:'',path:'',st:'idle',err:'',at:0},avUid='',avBusy=false,avRetry=false,avFail=0;
const avNotify=()=>{try{H&&H.avatar&&H.avatar()}catch(e){}};
function avErr(e){const m=String((e&&e.message)||e||'');
  if(isNet(e))return 'Sin conexión. Revisa tu internet e inténtalo de nuevo.';
  if(/PGRST205|schema cache|does not exist|bucket not found|not found/i.test(m))return 'Falta aplicar la migración de Supabase para la foto de perfil (supabase/migrations/20261010_profiles_avatars.sql).';
  if(/row-level security|permission denied|42501|not authorized|unauthorized/i.test(m))return 'El servidor rechazó la operación (permisos). Revisa las políticas de Storage y de la tabla profiles.';
  if(/payload too large|exceeded the maximum|too large|413/i.test(m))return 'La imagen es demasiado pesada (máximo 2 MB).';
  if(/mime|not supported|invalid/i.test(m))return 'Formato de imagen no permitido. Usa JPG, PNG o WebP.';
  return 'No se pudo completar la operación con la foto. Inténtalo de nuevo.'}
const avOk=()=>mode==='cloud'&&!!sb&&!!user;
function avatarInfo(){
  if(!avOk())return{url:'',st:'idle',err:'',cloud:false,email:'',busy:false};
  if(avUid!==user.id){av={url:'',path:'',st:'idle',err:'',at:0};avUid=user.id;avRetry=false}
  return{url:av.url,st:av.st,err:av.err,cloud:true,email:user.email||'',busy:avBusy}}
async function avatarLoad(force){
  if(!avOk())return avatarInfo();
  avatarInfo();
  if(av.st==='loading')return av;
  if(!force&&Date.now()-avFail<30e3)return av;   // tras un error, no insistir en cada pintado
  if(!force&&(av.st==='none'||(av.st==='ready'&&Date.now()-av.at<AV_TTL)))return av;
  const uid=user.id,prev=av;av={...av,st:'loading'};
  try{
    const r=await sb.from('profiles').select('avatar_path').eq('user_id',uid).maybeSingle();
    if(r.error)throw r.error;
    if(!user||user.id!==uid)return av;
    const pth=r.data&&r.data.avatar_path;
    if(!pth)av={url:'',path:'',st:'none',err:'',at:Date.now()};
    else{const g=await sb.storage.from(AV_BUCKET).createSignedUrl(pth,3600);if(g.error)throw g.error;av={url:g.data.signedUrl,path:pth,st:'ready',err:'',at:Date.now()}}
  }catch(e){avFail=Date.now();av={...prev,st:prev.url?'ready':'error',err:avErr(e)}}
  avNotify();return av;
}
function avatarBroken(){if(avRetry)return;avRetry=true;avatarLoad(true)}   // URL caducada: se renueva una sola vez
function avatarPrepare(file){   // valida, recorta al centro, reduce a 512 px y re-codifica (quita metadatos EXIF)
  return new Promise((ok,no)=>{
    if(!file)return no(new Error('No se seleccionó ninguna imagen.'));
    if(!AV_TYPES.includes(file.type))return no(new Error('Formato no permitido. Usa JPG, PNG o WebP.'));
    if(file.size>AV_IN_MAX)return no(new Error('La imagen es demasiado pesada (máximo 12 MB).'));
    const u=URL.createObjectURL(file),im=new Image();
    im.onerror=()=>{URL.revokeObjectURL(u);no(new Error('No se pudo leer la imagen. Prueba con otra.'))};
    im.onload=()=>{try{
      const w=im.naturalWidth,h=im.naturalHeight,sd=Math.min(w,h);if(!sd){URL.revokeObjectURL(u);return no(new Error('La imagen está vacía o dañada.'))}
      const c=document.createElement('canvas');c.width=c.height=AV_PX;const x=c.getContext('2d');
      x.fillStyle='#0a0e13';x.fillRect(0,0,AV_PX,AV_PX);x.imageSmoothingQuality='high';
      x.drawImage(im,(w-sd)/2,(h-sd)/2,sd,sd,0,0,AV_PX,AV_PX);URL.revokeObjectURL(u);
      c.toBlob(b=>{if(!b)return no(new Error('No se pudo procesar la imagen.'));if(b.size>AV_OUT_MAX)return no(new Error('La imagen es demasiado pesada (máximo 2 MB).'));ok({blob:b,url:URL.createObjectURL(b)})},'image/jpeg',.88);
    }catch(e){URL.revokeObjectURL(u);no(new Error('No se pudo procesar la imagen.'))}};
    im.src=u;
  });
}
async function avCleanup(keep){   // borra fotos antiguas de MI carpeta, nunca la vigente
  try{const l=await sb.storage.from(AV_BUCKET).list(user.id,{limit:100});if(l.error||!l.data)return;
    const old=l.data.filter(f=>f.name&&user.id+'/'+f.name!==keep).map(f=>user.id+'/'+f.name);
    if(old.length)await sb.storage.from(AV_BUCKET).remove(old)}catch(e){/* limpieza opcional */}
}
async function avatarSave(blob){
  if(!avOk())throw new Error('Inicia sesión con tu cuenta para guardar la foto.');
  if(!blob||!AV_TYPES.includes(blob.type)||blob.size>AV_OUT_MAX)throw new Error('Imagen no válida.');
  if(avBusy)throw new Error('Ya hay una operación con la foto en curso.');
  avBusy=true;avNotify();
  const uid=user.id,old=av.path,pth=uid+'/'+Date.now().toString(36)+Math.random().toString(36).slice(2,8)+'.jpg';
  try{
    const up=await sb.storage.from(AV_BUCKET).upload(pth,blob,{contentType:'image/jpeg',upsert:false,cacheControl:'3600'});
    if(up.error)throw up.error;
    const pr=await sb.from('profiles').upsert({user_id:uid,avatar_path:pth},{onConflict:'user_id'});
    if(pr.error){await sb.storage.from(AV_BUCKET).remove([pth]).catch(()=>{});throw pr.error}   // el perfil no cambió: conserva la foto anterior
    const g=await sb.storage.from(AV_BUCKET).createSignedUrl(pth,3600);
    av={url:g.error?'':g.data.signedUrl,path:pth,st:g.error?'error':'ready',err:'',at:Date.now()};avRetry=false;
    if(old&&old!==pth)sb.storage.from(AV_BUCKET).remove([old]).catch(()=>{});
    avCleanup(pth);
  }catch(e){throw new Error(avErr(e))}
  finally{avBusy=false;avNotify()}
}
async function avatarRemove(){
  if(!avOk())throw new Error('Inicia sesión con tu cuenta.');
  if(avBusy)throw new Error('Ya hay una operación con la foto en curso.');
  avBusy=true;avNotify();
  try{
    const pr=await sb.from('profiles').upsert({user_id:user.id,avatar_path:null},{onConflict:'user_id'});
    if(pr.error)throw pr.error;                      // primero se quita la referencia; luego el archivo
    av={url:'',path:'',st:'none',err:'',at:Date.now()};
    avCleanup('');
  }catch(e){throw new Error(avErr(e))}
  finally{avBusy=false;avNotify()}
}

/* ---------- arranque ---------- */
async function init(h){
  H=h;bindEvents();
  cfg=window.CC_CONFIG&&window.CC_CONFIG.url&&window.CC_CONFIG.anonKey?window.CC_CONFIG:null;
  recovering=/type=recovery/.test(location.hash);
  if(cfg&&window.supabase&&window.supabase.createClient){
    try{sb=window.supabase.createClient(cfg.url,cfg.anonKey,{auth:{persistSession:true,autoRefreshToken:true,detectSessionInUrl:true,storageKey:'cc.auth'}})}catch(e){sb=null}
  }
  if(sb)sb.auth.onAuthStateChange(ev=>{
    if(ev==='PASSWORD_RECOVERY'){recovering=true;setTimeout(showRecovery,0)}
    else if(ev==='SIGNED_OUT'&&mode==='cloud'&&!loggingOut)setTimeout(()=>sessionLost('Tu sesión se cerró. Inicia sesión de nuevo.'),0);
  });
  if(!sb){if(localStorage.getItem(LOCALFLAG)==='1')return startLocal();return showAuth(cfg?'No se pudo cargar la librería de Supabase.':'','in')}
  const{data,error}=await sb.auth.getSession().catch(e=>({data:{},error:e}));
  if(recovering)return showRecovery();
  if(data&&data.session)return enter(data.session.user);
  const last=localStorage.getItem(LAST);
  if(last&&(error||!navigator.onLine)&&readLocal(last))return enter({id:last,email:localStorage.getItem(LASTMAIL)||''},true);   // sin conexión: abrir la copia local
  if(localStorage.getItem(LOCALFLAG)==='1')return startLocal();
  showAuth(error&&isNet(error)?'Sin conexión con el servidor.':'','in');
}

return{init,avatarInfo,avatarLoad,avatarBroken,avatarPrepare,avatarSave,avatarRemove,touch(){if(mode==='cloud'){dirty=true;writeLocal();setStatus();schedulePush(1500)}else writeLocal()},persistLocal,backupOk,syncNow,logout,showLogin,account,cardInner,dataNote,importLegacy,deleteLegacy,snapshots,
  _debug:()=>({mode,base,dirty,status,lastErr,conflictOpen,offlineStart})};
})();
