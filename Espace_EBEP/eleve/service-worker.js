const CACHE_NAME = 'memo-eleve-v94';
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
        caches.open(CACHE_NAME).then((cache) =>
            // { cache: 'reload' } force le navigateur à re-télécharger chaque
            // fichier sur le réseau plutôt que de réutiliser une copie déjà
            // présente dans le cache HTTP standard — sinon, même une nouvelle
            // version de ce fichier peut récupérer un app.js/index.html périmé
            // et l'app reste bloquée sur l'ancienne version malgré le nouveau
            // CACHE_NAME.
            Promise.all(
                FICHIERS_A_METTRE_EN_CACHE.map((url) =>
                    fetch(url, { cache: 'reload' }).then((reponse) => cache.put(url, reponse))
                )
            )
        )
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

// Permet à la page de forcer l'activation immédiate d'un nouveau SW en attente
// (déclenché depuis app.js après détection d'une mise à jour).
self.addEventListener('message', (event) => {
    if (event.data === 'skipWaiting') self.skipWaiting();
});
