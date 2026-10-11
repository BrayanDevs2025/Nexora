// Pruebas de lógica (sin navegador ni Supabase): fechas de Colombia y "Mi día".
// Ejecutar: node --test tests/logic.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const src = readFileSync(resolve(root, 'public/js/app.js'), 'utf8');

// Crea un "navegador" mínimo con reloj controlable y ejecuta app.js dentro.
function boot(isoNow, tzEnv) {
  const RealDate = Date;
  let fake = new RealDate(isoNow).getTime();
  class FDate extends RealDate {
    constructor(...a) { a.length ? super(...a) : super(fake); }
    static now() { return fake; }
  }
  const el = () => new Proxy(function () {}, {
    get: (t, k) => k === 'classList' ? { add() {}, remove() {}, contains: () => false } : k === 'dataset' ? {} : el(),
    set: () => true, apply: () => el(),
  });
  const store = {}; let handlers;
  const ctx = vm.createContext({
    console, Math, JSON, Intl, Promise, Number, String, Array, Object, Set, Map, RegExp, Error, parseInt, parseFloat, isNaN, isFinite,
    setTimeout: () => 0, clearTimeout() {}, setInterval: () => 0, clearInterval() {},
    URL, Date: FDate, navigator: { onLine: true },
    localStorage: { getItem: k => store[k] ?? null, setItem: (k, v) => { store[k] = String(v); }, removeItem: k => { delete store[k]; } },
    document: { querySelector: () => el(), querySelectorAll: () => [], addEventListener() {}, createElement: () => el(), hidden: false },
    confirm: () => true, alert() {},
    Sync: { init(h) { handlers = h; }, touch() {}, persistLocal() {}, avatarInfo: () => ({ url: '', st: 'idle', cloud: false, email: '', busy: false }), avatarLoad() {}, avatarBroken() {}, cardInner: () => '', dataNote: () => '' },
  });
  ctx.window = ctx;
  vm.runInContext(src, ctx, { filename: 'app.js' });
  handlers.set(handlers.fresh('blank'));
  return { ctx, run: (c) => vm.runInContext(c, ctx), setNow: (iso) => { fake = new RealDate(iso).getTime(); } };
}

test('today() usa America/Bogota, no UTC (21:30 en Bogotá ya es el día siguiente en UTC)', () => {
  const b = boot('2026-10-12T02:30:00Z');             // = 2026-10-11 21:30 en Bogotá
  assert.equal(b.run('today()'), '2026-10-11');
  assert.equal(new Date('2026-10-12T02:30:00Z').toISOString().slice(0, 10), '2026-10-12'); // lo que daría UTC
  assert.equal(b.run('nowMin()'), 21 * 60 + 30);
});

test('cambio de día a las 00:00 de Bogotá (05:00 UTC)', () => {
  const b = boot('2026-10-11T04:59:00Z');
  assert.equal(b.run('today()'), '2026-10-10');
  b.setNow('2026-10-11T05:00:00Z');
  assert.equal(b.run('today()'), '2026-10-11');
  assert.equal(b.run('nowMin()'), 0);
});

test('día de la semana de Colombia (nowDow) y bloques programados', () => {
  const b = boot('2026-10-12T04:00:00Z');             // domingo 11 oct 23:00 en Bogotá (en UTC ya es lunes)
  assert.equal(b.run('nowDow()'), 0);
  assert.ok(!b.run('daySch().map(x=>x.t)').includes('Universidad'), 'Universidad (lun-sáb) no es domingo');
  b.setNow('2026-10-12T15:00:00Z');                   // lunes 12 oct 10:00
  assert.equal(b.run('nowDow()'), 1);
  assert.ok(b.run('daySch().map(x=>x.t)').includes('Universidad'));
  b.setNow('2026-10-11T03:00:00Z');                   // sábado 10 oct 22:00 en Bogotá (UTC ya es domingo)
  assert.equal(b.run('nowDow()'), 6);
});

const id = (b, t) => b.run(`S.sch.find(x=>x.t==='${t}').id`);

test('completar una actividad: sale de pendientes, queda en historial y no se duplica el progreso', () => {
  const b = boot('2026-10-12T11:00:00Z');             // lunes 06:00 Bogotá
  const cama = id(b, 'Tender cama');
  b.run(`A.dst('${cama}|done')`);
  assert.equal(b.run(`S.dl[today()]['${cama}']`), 'done');
  const html = b.run('P.dia()');
  const pend = html.split('Completadas hoy')[0];
  assert.ok(!pend.includes('Tender cama'), 'no debe estar en pendientes');
  assert.ok(html.split('Completadas hoy')[1].includes('Tender cama'), 'debe estar en completadas');
  // repetir ✓ (doble toque / recarga) no suma de nuevo
  const n1 = b.run('S.tasks.length + Object.values(S.hl).flat().length');
  b.run(`A.dst('${cama}|done')`); b.run(`A.dst('${cama}|done')`);
  assert.equal(b.run('S.tasks.length + Object.values(S.hl).flat().length'), n1);
  assert.equal(b.run('Object.values(S.dl[today()]).filter(v=>v==="done").length'), 1);
});

test('persistencia: el estado sobrevive a serializar/recargar (lo que viaja a Supabase)', () => {
  const b = boot('2026-10-12T11:00:00Z');
  const cama = id(b, 'Tender cama');
  b.run(`A.dst('${cama}|done')`);
  const json = b.run('JSON.stringify(S)');
  const b2 = boot('2026-10-12T11:30:00Z');            // "otro dispositivo"
  b2.run(`S=JSON.parse(${JSON.stringify(json)})`);
  assert.equal(b2.run(`S.dl[today()]['${cama}']`), 'done');
  assert.ok(!b2.run('P.dia()').split('Completadas hoy')[0].includes('Tender cama'));
});

test('día siguiente: la actividad recurrente vuelve a estar pendiente y el historial del lunes se conserva', () => {
  const b = boot('2026-10-12T10:30:00Z');             // lunes 05:30
  const des = id(b, 'Despertar');
  b.run(`A.dst('${des}|done')`);
  b.setNow('2026-10-13T10:30:00Z');                   // martes
  assert.equal(b.run('today()'), '2026-10-13');
  assert.equal(b.run(`(S.dl[today()]||{})['${des}']`), undefined);
  assert.ok(b.run('P.dia()').split('Completadas hoy')[0].includes('Despertar'));
  assert.equal(b.run(`S.dl['2026-10-12']['${des}']`), 'done');   // historial intacto
});

test('no completada: no se marca sola; pasa a "vencida" solo por la hora', () => {
  const b = boot('2026-10-12T12:00:00Z');             // lunes 07:00
  const des = id(b, 'Despertar');
  assert.equal(b.run(`(S.dl[today()]||{})['${des}']`), undefined);
  assert.ok(b.run('P.dia()').includes('st-vencida'));
  assert.equal(b.run('Object.values(S.dl[today()]||{}).filter(v=>v==="done").length'), 0);
});

test('reprogramar no duplica (doble toque) y deshacer retira la tarea creada', () => {
  const b = boot('2026-10-12T11:00:00Z');
  const cama = id(b, 'Tender cama');
  b.run(`A.dst('${cama}|resched')`); b.run(`A.dst('${cama}|resched')`);
  assert.equal(b.run(`S.tasks.filter(t=>t.rs==='${cama}'+today()).length`), 1);
  assert.equal(b.run(`S.tasks.find(t=>t.rs).due`), '2026-10-13');
  assert.equal(b.run(`S.tasks.find(t=>t.rs).orig`), '2026-10-12');
  const html = b.run('P.dia()');
  assert.ok(!html.split('Reprogramadas para mañana')[0].includes('Tender cama'));
  b.run(`A.dst('${cama}|reset')`);
  assert.equal(b.run(`S.tasks.filter(t=>t.rs).length`), 0);
  assert.equal(b.run(`(S.dl[today()]||{})['${cama}']`), undefined);
});

test('deshacer una completada revierte hábito y tarea automática (sin doble conteo)', () => {
  const b = boot('2026-10-12T11:00:00Z');
  const hab = b.run('S.habits[0].id');
  b.run(`S.sch.find(x=>x.t==='Tender cama').hab='${hab}'`);
  const cama = id(b, 'Tender cama');
  b.run(`A.dst('${cama}|done')`);
  assert.equal(b.run(`S.hl[today()].filter(x=>x==='${hab}').length`), 1);
  b.run(`A.dst('${cama}|done')`);
  assert.equal(b.run(`S.hl[today()].filter(x=>x==='${hab}').length`), 1);
  b.run(`A.dst('${cama}|reset')`);
  assert.equal(b.run(`(S.hl[today()]||[]).filter(x=>x==='${hab}').length`), 0);
});
