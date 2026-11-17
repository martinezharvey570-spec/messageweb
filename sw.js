const CACHE_NAME = "xiaowu-zhili-v55";
const ASSETS = [
  "/",
  "/index.html",
  "/style.css?v=1.050",
  "/app.js?v=1.050",
  "/config.js?v=1.050",
  "/android-bridge.js?v=20261114_v44",
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
