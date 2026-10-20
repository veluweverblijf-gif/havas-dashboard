/* Service worker Havas dashboard
 * 1. Maakt het dashboard installeerbaar als app (telefoon/tablet/pc).
 * 2. Houdt de app-bestanden achter de hand als de verbinding even wegvalt.
 * 3. Serveert foto's (bonnen, maandregistraties, tanklijsten) via  _blob/<id>  vanuit de
 *    afgeschermde Supabase-opslag, met de inlog van de gebruiker.
 */
const VERSIE = 'havas-v1';
const SHELL = ['./', 'index.html', 'config.js', 'js/platform.js', 'manifest.webmanifest',
  'img/havas-volvo.jpg', 'img/icon-192.png', 'img/icon-512.png', 'img/apple-touch-icon.png'];

let AUTH = { token: null, base: null, anon: null };

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(VERSIE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil((async () => {
    for (const k of await caches.keys()) if (k !== VERSIE) await caches.delete(k);
    await self.clients.claim();
  })());
});
self.addEventListener('message', (e) => {
  if (e.data && e.data.type === 'auth') AUTH = { token: e.data.token, base: e.data.base, anon: e.data.anon };
});

// inlog opvragen bij een open venster (na herstart van de service worker is die kwijt)
async function vraagAuth() {
  const vensters = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
  for (const v of vensters) {
    const a = await new Promise((resolve) => {
      const ch = new MessageChannel();
      const t = setTimeout(() => resolve(null), 2000);
      ch.port1.onmessage = (m) => { clearTimeout(t); resolve(m.data); };
      v.postMessage({ type: 'need-auth' }, [ch.port2]);
    });
    if (a && a.token) { AUTH = { token: a.token, base: a.base, anon: a.anon }; return true; }
  }
  return false;
}

async function foto(id) {
  for (let poging = 0; poging < 2; poging++) {
    if (!AUTH.token || poging === 1) await vraagAuth();
    if (!AUTH.token) break;
    const pad = id.split('/').map(encodeURIComponent).join('/');
    const r = await fetch(`${AUTH.base}/storage/v1/object/authenticated/fotos/${pad}`, {
      headers: { Authorization: 'Bearer ' + AUTH.token, apikey: AUTH.anon },
    });
    if (r.ok) {
      const h = new Headers(r.headers);
      h.set('Cache-Control', 'private, max-age=86400');
      return new Response(r.body, { status: 200, headers: h });
    }
    if (r.status !== 400 && r.status !== 401 && r.status !== 403) return r;
  }
  return new Response('Foto niet beschikbaar', { status: 404 });
}

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (url.origin !== self.location.origin || e.request.method !== 'GET') return;
  const i = url.pathname.indexOf('/_blob/');
  if (i >= 0) { e.respondWith(foto(decodeURIComponent(url.pathname.slice(i + 7)))); return; }
  // app-bestanden: eerst netwerk (altijd de nieuwste versie), bij geen verbinding de kopie
  e.respondWith((async () => {
    try {
      const r = await fetch(e.request);
      if (r.ok && (r.type === 'basic')) { const c = await caches.open(VERSIE); c.put(e.request, r.clone()); }
      return r;
    } catch {
      const c = await caches.match(e.request, { ignoreSearch: true });
      if (c) return c;
      if (e.request.mode === 'navigate') return caches.match('index.html');
      throw new Error('offline');
    }
  })());
});
