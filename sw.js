// Service worker — mise à jour AUTOMATIQUE + hors-ligne.
// Stratégie : "network-first" (en ligne => toujours la dernière version au rechargement ;
// hors-ligne => repli sur le cache). Et skipWaiting()/clients.claim() pour que la nouvelle
// version prenne le contrôle immédiatement, sans intervention.
// Incrémenter CACHE à chaque publication (garde le hors-ligne propre).
const CACHE = 'autotelemetry-v20';

const ASSETS = [
  './',
  './index.html',
  './app.js',
  './obd/transport.js',
  './obd/decoder.js',
  './replay.js',
  './manifest.webmanifest',
  './icon.svg',
];

self.addEventListener('install', (e) => {
  self.skipWaiting(); // active la nouvelle version tout de suite
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(ASSETS)));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

// network-first : on tente le réseau, on met à jour le cache, et on retombe sur le cache hors-ligne.
self.addEventListener('fetch', (e) => {
  if (e.request.method !== 'GET') return;
  // no-store : on ne sert jamais depuis le cache HTTP du navigateur (GitHub Pages met en
  // cache 10 min) — on va toujours chercher la dernière version au réseau, repli cache SW hors-ligne.
  e.respondWith(
    fetch(e.request, { cache: 'no-store' })
      .then((res) => {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(e.request, copy));
        return res;
      })
      .catch(() => caches.match(e.request)),
  );
});
