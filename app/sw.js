// 農務小幫手 Service Worker — 離線快取（網路優先，確保更新即時生效）
const CACHE = "farm-assistant-v3";
const ASSETS = ["./", "./index.html", "./manifest.webmanifest", "./icon.svg"];

self.addEventListener("install", e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(ASSETS)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", e => {
  e.waitUntil(caches.keys().then(ks =>
    Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});

// 網路優先：線上取最新並更新快取；離線才回退快取。
self.addEventListener("fetch", e => {
  if (e.request.method !== "GET") return;
  // 只處理本站資源，外部（Firebase / AMIS 代理）直接放行
  if (new URL(e.request.url).origin !== self.location.origin) return;
  e.respondWith(
    fetch(e.request).then(resp => {
      const copy = resp.clone();
      caches.open(CACHE).then(c => c.put(e.request, copy)).catch(() => {});
      return resp;
    }).catch(() =>
      caches.match(e.request).then(r => r || caches.match("./index.html"))
    )
  );
});
