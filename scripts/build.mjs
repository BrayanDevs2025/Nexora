// Script de construcción (se ejecuta en Vercel con "npm run build").
//  1) Valida las variables de entorno públicas de Supabase y genera public/config.js
//  2) Copia la librería oficial @supabase/supabase-js a public/js/vendor/supabase.js
// Nunca se escriben secretos: solo la URL del proyecto y la clave pública (anon/publishable).
import { existsSync, mkdirSync, copyFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const pub = resolve(root, 'public');
const fail = (m) => { console.error('\n❌ ' + m + '\n'); process.exit(1); };

const allowNone = process.env.CC_ALLOW_NO_CONFIG === '1';
const url = (process.env.SUPABASE_URL || '').trim().replace(/\/+$/, '');
const key = (process.env.SUPABASE_ANON_KEY || process.env.SUPABASE_PUBLISHABLE_KEY || '').trim();

let cfg = null;
if (!url && !key && allowNone) {
  console.warn('⚠️  Sin SUPABASE_URL / SUPABASE_ANON_KEY: la app funcionará solo en modo local (sin cuentas ni sincronización).');
} else {
  if (!/^https:\/\/[^\s/]+$/.test(url)) fail('SUPABASE_URL falta o no es válida. Debe verse como https://xxxxxxxx.supabase.co (Supabase > Project Settings > API).');
  if (key.length < 20) fail('SUPABASE_ANON_KEY falta o es demasiado corta (Supabase > Project Settings > API > clave "anon" o "publishable").');
  if (key.startsWith('sb_secret_')) fail('Esa clave es SECRETA (sb_secret_...). Usa la clave pública "anon" / "publishable". Nunca pongas claves secretas en la web.');
  const parts = key.split('.');
  if (parts.length === 3) {
    try {
      const role = JSON.parse(Buffer.from(parts[1].replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8')).role;
      if (role === 'service_role') fail('Esa clave es "service_role" (SECRETA). Usa la clave "anon". Nunca pongas la service_role en la web.');
    } catch { /* clave con formato distinto: se acepta */ }
  }
  cfg = { url, anonKey: key };
}
mkdirSync(pub, { recursive: true });
writeFileSync(resolve(pub, 'config.js'), `/* generado por scripts/build.mjs — no editar ni subir a GitHub */\nwindow.CC_CONFIG=${JSON.stringify(cfg)};\n`);

const lib = resolve(root, 'node_modules/@supabase/supabase-js/dist/umd/supabase.js');
if (!existsSync(lib)) fail('No se encontró @supabase/supabase-js. Ejecuta "npm install" antes de "npm run build".');
mkdirSync(resolve(pub, 'js/vendor'), { recursive: true });
copyFileSync(lib, resolve(pub, 'js/vendor/supabase.js'));
console.log('✅ Build listo: public/config.js y public/js/vendor/supabase.js generados.');
