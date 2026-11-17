const CACHE_NAME = "xiaowu-zhili-v1097";
const ASSETS = [
  "/",
  "/index.html",
  "/style.css?v=1.097",
  "/app.js?v=1.097",
  "/config.js?v=1.097",
  "/android-bridge.js?v=1.097",
  "/icon-192.png",
  "/icon-512.png"
];

self.addEventListener("install", event => {
  self.skipWaiting();
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache => cache.addAll(ASSETS).catch(() => {}))
  );
});

self.addEventListener("activate", event => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", event => {
  const req = event.request;
  if (req.method !== "GET" || req.url.includes("/api/")) return;
  event.respondWith(
    fetch(req).catch(() => caches.match(req))
  );
});
