/* Neku tablet service worker.
   Exists for two reasons: PWA installability, and receiving files shared
   straight from the drawing app (Web Share Target). No offline caching —
   the app is useless without a network connection anyway. */
'use strict';

self.addEventListener('install', () => self.skipWaiting());

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (event.request.method === 'POST' && url.pathname.endsWith('/share-target')) {
    event.respondWith(handleShare(event.request));
  }
  // everything else: straight to the network
});

async function handleShare(request) {
  try {
    const formData = await request.formData();
    const file = formData.get('sprite');
    if (file && typeof file.arrayBuffer === 'function') {
      const cache = await caches.open('neku-share');
      await cache.put(
        'shared-sprite',
        new Response(file, {
          headers: {
            'X-Name': encodeURIComponent(file.name || 'sprite.png'),
            'Content-Type': file.type || 'image/png',
          },
        })
      );
    }
  } catch (_) {
    // fall through — the app will just open without a preloaded file
  }
  // absolute against the SW scope so subpath hosting (e.g. GitHub Pages) works
  return Response.redirect(new URL('./?share-target=1', self.registration.scope).href, 303);
}
