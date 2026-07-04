const CACHE_NAME = 'memo-eleve-v34';
const FICHIERS_A_METTRE_EN_CACHE = [
    './',
    './index.html',
    './app.js',
    './manifest.json',
    './icon-192.png',
    './icon-512.png'
];

self.addEventListener('install', (event) => {
    event.waitUntil(
        caches.open(CACHE_NAME).then((cache) => cache.addAll(FICHIERS_A_METTRE_EN_CACHE))
    );
    self.skipWaiting();
});

self.addEventListener('activate', (event) => {
    event.waitUntil(
        caches.keys().then((noms) =>
            Promise.all(noms.filter((n) => n !== CACHE_NAME).map((n) => caches.delete(n)))
        )
    );
    self.clients.claim();
});

self.addEventListener('fetch', (event) => {
    if (event.request.method !== 'GET') return;
    event.respondWith(
        caches.match(event.request).then((reponseCache) => {
            if (reponseCache) return reponseCache;
            return fetch(event.request).then((reponseReseau) => {
                // Les pages d'exercices que l'élève crée restent en localStorage, pas besoin de les mettre en cache ici.
                return reponseReseau;
            }).catch(() => reponseCache);
        })
    );
});
