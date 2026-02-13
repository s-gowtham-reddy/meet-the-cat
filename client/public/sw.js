// Minimal service worker for PWA installability
self.addEventListener('install', (e) => {
    console.log('[Service Worker] Install');
});

self.addEventListener('fetch', (e) => {
    // Simple pass-through for now
    e.respondWith(fetch(e.request));
});
