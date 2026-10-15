/* Service Worker لنظام مراقبة الشبكة — يعمل كاتصال احتياطي عند انقطاع الشبكة */
const CACHE = "netmon-v1";
const SHELL = ["/", "/api/overview"];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE).then((cache) => cache.addAll(SHELL).catch(() => undefined)).then(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((key) => key !== CACHE).map((key) => caches.delete(key))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith("/api/stream")) return;

  event.respondWith(
    fetch(request)
      .then((response) => {
        if (response && response.status === 200 && response.type === "basic") {
          const clone = response.clone();
          caches.open(CACHE).then((cache) => cache.put(request, clone)).catch(() => undefined);
        }
        return response;
      })
      .catch(async () => {
        const cached = await caches.match(request);
        if (cached) return cached;
        if (url.pathname.startsWith("/api/")) {
          return new Response(
            JSON.stringify({
              offline: true,
              message: "لا يوجد اتصال بالخادم — يتم العرض من الكاش المحلي",
              generatedAt: new Date().toISOString(),
              devices: [],
              alerts: [],
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          );
        }
        const shell = await caches.match("/");
        if (shell) return shell;
        return new Response("offline", { status: 503 });
      }),
  );
});
