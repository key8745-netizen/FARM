// 農務小幫手 Service Worker — 自我銷毀（kill-switch）
// 目的：徹底解除舊版 cache-first SW 造成的「更新看不到」問題。
// 這支 SW 一啟用就清掉所有快取、卸載自己、並強制重新載入所有分頁，
// 之後頁面不再被 SW 攔截，一律走網路取最新。離線快取暫時停用，
// 待 App 穩定後可再以「檔名雜湊 + 版本控管」方式重新導入。
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (e) => {
  e.waitUntil((async () => {
    try {
      const keys = await caches.keys();
      await Promise.all(keys.map(k => caches.delete(k)));
    } catch (_) {}
    try { await self.clients.claim(); } catch (_) {}
    try { await self.registration.unregister(); } catch (_) {}
    try {
      const cs = await self.clients.matchAll({ type: "window" });
      cs.forEach(c => c.navigate(c.url));
    } catch (_) {}
  })());
});
// 不攔截 fetch：所有請求直接走網路
