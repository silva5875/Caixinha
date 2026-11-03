// Service worker do Caixa — cache do app (offline) sem atrapalhar API/dados
const CACHE = 'caixa-v1';
const SHELL = ['/', '/index.html', '/manifest.json', '/icon-192.png', '/icon-512.png'];

self.addEventListener('install', (e) => {
  self.skipWaiting();
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).catch(() => {}));
});

self.addEventListener('activate', (e) => {
  self.clients.claim();
  e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== CACHE).map((k) => caches.delete(k)))));
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  // Só mexe no mesmo domínio; deixa Supabase, Gemini e CDNs passarem direto.
  if (url.origin !== location.origin) return;
  // Nunca cacheia chamadas de API (dados dinâmicos).
  if (url.pathname.startsWith('/api/')) return;
  // Network-first: tenta a rede, atualiza o cache, e cai pro cache se estiver offline.
  e.respondWith(
    fetch(req)
      .then((res) => { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(req, copy)); return res; })
      .catch(() => caches.match(req).then((r) => r || caches.match('/')))
  );
});
