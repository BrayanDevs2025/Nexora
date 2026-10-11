/* Service worker seguro: solo guarda ARCHIVOS ESTÁTICOS PÚBLICOS de la app (HTML, CSS, JS, iconos).
   Nunca guarda respuestas de Supabase ni datos de ningún usuario, así que la caché no puede
   mostrar información privada de una sesión anterior. Las peticiones a otros dominios no se tocan. */
const CACHE = 'cc-shell-v5-avatar-bogota';
const SHELL = ['/', '/index.html', '/css/styles.css', '/js/app.js', '/js/sync.js', '/js/vendor/supabase.js', '/config.js', '/manifest.webmanifest', '/icons/icon-192.png', '/icons/icon-512.png'];
self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => Promise.all(SHELL.map((u) => c.add(u).catch(() => {})))).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', (e) => {
  const r = e.request, u = new URL(r.url);
  if (r.method !== 'GET' || u.origin !== self.location.origin) return;       // Supabase y demás: directo a la red
  e.respondWith(
    fetch(r).then((res) => {
      if (res.ok && res.type === 'basic') { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(r, copy)); }
      return res;
    }).catch(() => caches.match(r).then((m) => m || (r.mode === 'navigate' ? caches.match('/index.html') : Response.error())))
  );
});
