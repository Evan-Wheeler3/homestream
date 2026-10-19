// Wheelhouse service worker: keeps the app opening without a network, and plays
// downloaded videos (see src/client/lib/downloads.ts) from Cache Storage, with
// seeking (Range requests).
const SHELL = 'wh-shell-v1';
const DOWNLOADS = 'wh-downloads';

self.addEventListener('install', (event) => {
  self.skipWaiting();
  event.waitUntil(
    caches
      .open(SHELL)
      .then((cache) => cache.add('/'))
      .catch(() => undefined),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      for (const name of await caches.keys()) {
        if (name.startsWith('wh-shell-') && name !== SHELL) await caches.delete(name);
      }
      await self.clients.claim();
    })(),
  );
});

/** A cached full response, cut to the requested byte range. */
async function withRange(request, cached) {
  const range = request.headers.get('range');
  if (!range) return cached;
  const blob = await cached.blob();
  const size = blob.size;
  const m = /bytes=(\d*)-(\d*)/.exec(range);
  if (!m) return cached;
  let start = m[1] ? Number(m[1]) : 0;
  let end = m[2] ? Number(m[2]) : size - 1;
  if (!m[1] && m[2]) {
    start = Math.max(0, size - Number(m[2]));
    end = size - 1;
  }
  end = Math.min(end, size - 1);
  if (start >= size || start > end) {
    return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${size}` } });
  }
  return new Response(blob.slice(start, end + 1), {
    status: 206,
    headers: {
      'Content-Type': cached.headers.get('Content-Type') || 'video/mp4',
      'Content-Range': `bytes ${start}-${end}/${size}`,
      'Content-Length': String(end - start + 1),
      'Accept-Ranges': 'bytes',
    },
  });
}

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  // Downloaded media (video, subtitles, posters) plays from the device.
  if (/^\/(api\/media|api\/mock|jf)\//.test(url.pathname)) {
    event.respondWith(
      (async () => {
        const cache = await caches.open(DOWNLOADS);
        const cached = await cache.match(request.url);
        if (cached) return withRange(request, cached);
        return fetch(request);
      })(),
    );
    return;
  }

  // Pages: the network first, the last copy when offline.
  if (request.mode === 'navigate') {
    event.respondWith(
      (async () => {
        try {
          const fresh = await fetch(request);
          if (fresh.ok) {
            const cache = await caches.open(SHELL);
            await cache.put('/', fresh.clone());
          }
          return fresh;
        } catch {
          const cache = await caches.open(SHELL);
          return (await cache.match('/')) || Response.error();
        }
      })(),
    );
    return;
  }

  if (url.pathname.startsWith('/api/')) return;

  // App files in /assets have their content hash in the name, so a cached copy is
  // always right; other files (icons, the manifest) come from the network when
  // it's there. Both are kept for when it isn't.
  const hashed = url.pathname.startsWith('/assets/');
  event.respondWith(
    (async () => {
      const cache = await caches.open(SHELL);
      if (hashed) {
        const cached = await cache.match(request);
        if (cached) return cached;
      }
      try {
        const fresh = await fetch(request);
        if (fresh.ok) await cache.put(request, fresh.clone());
        return fresh;
      } catch (error) {
        const cached = await cache.match(request);
        if (cached) return cached;
        throw error;
      }
    })(),
  );
});
