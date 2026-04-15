const CACHE_NAME = "corrigator-pwa-v3";
const APP_SHELL = [
  "./",
  "./index.html",
  "./devoir.html",
  "./corriger.html",
  "./etudiants.html",
  "./style.css",
  "./sync-nav.js",
  "./local-api.js",
  "./pwa-register.js",
  "./manifest.webmanifest",
  "./corrigator_logo.png",
  "./corrigator_icon.png"
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(APP_SHELL))
  );
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys
          .filter((key) => key !== CACHE_NAME)
          .map((key) => caches.delete(key))
      )
    )
  );
  self.clients.claim();
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;

  const reqUrl = new URL(req.url);
  const isSameOrigin = reqUrl.origin === self.location.origin;
  if (!isSameOrigin) return;

  event.respondWith((async () => {
    const cache = await caches.open(CACHE_NAME);

    // Pour les navigations HTML (corriger.html?devoir=..., devoir.html?id=..., etc.),
    // on force la resolution par chemin sans query string.
    if (req.mode === "navigate") {
      const url = new URL(req.url);
      const pathname = url.pathname;
      const page = pathname.split("/").pop() || "index.html";
      const target = page === "" ? "index.html" : page;

      const cachedPage = await cache.match(`./${target}`, { ignoreSearch: true });
      if (cachedPage) return cachedPage;

      try {
        const networkRes = await fetch(req);
        if (networkRes && networkRes.status === 200 && networkRes.type === "basic") {
          cache.put(req, networkRes.clone());
        }
        return networkRes;
      } catch (_err) {
        const fallback = await cache.match("./index.html", { ignoreSearch: true });
        return fallback || new Response("Offline", { status: 503, statusText: "Offline" });
      }
    }

    const cached = await cache.match(req, { ignoreSearch: true });
    if (cached) return cached;

    try {
      const networkRes = await fetch(req);
      if (networkRes && networkRes.status === 200 && networkRes.type === "basic") {
        cache.put(req, networkRes.clone());
      }
      return networkRes;
    } catch (_err) {
      return new Response("Offline", { status: 503, statusText: "Offline" });
    }
  })());
});
