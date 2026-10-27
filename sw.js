// Service worker: guarda la app dentro del teléfono para que abra sin señal.
// Sube el número de versión cada vez que cambie algún archivo de la app.
const CACHE = 'midinero-v2.0.0';
const ASSETS = [
  './', './index.html', './styles.css', './app.js', './store.js', './sync.js', './config.js',
  './qrcode.js', './jsQR.js', './manifest.json', './icon-180.png', './icon-192.png', './icon-512.png'
];

self.addEventListener('install', event => {
  event.waitUntil(caches.open(CACHE).then(c => c.addAll(ASSETS)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

// Archivos de la app: primero red (para recibir versiones nuevas), si no hay señal, caché.
// Las llamadas a la nube (supabase) nunca pasan por el caché.
self.addEventListener('fetch', event => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  event.respondWith(
    fetch(req).then(res => {
      if (res && res.status === 200) { const copy = res.clone(); caches.open(CACHE).then(c => c.put(req, copy)); }
      return res;
    }).catch(() => caches.match(req).then(hit => hit || (req.mode === 'navigate' ? caches.match('./index.html') : undefined)))
  );
});
