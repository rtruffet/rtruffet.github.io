const CACHE_NAME = "corrigator-pwa-v6";
const APP_SHELL = [
  "./",
  "./index.html",
  "./aide.html",
  "./devoir.html",
  "./corriger.html",
  "./etudiants.html",
  "./style.css?v=20260609b",
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

self.addEventListener("message", (event) => {
  if (event.data && event.data.type === "SKIP_WAITING") {
    self.skipWaiting();
  }
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

    // Navigation HTML: reseau d'abord pour toujours recuperer la derniere version.
    if (req.mode === "navigate") {
      const url = new URL(req.url);
      const pathname = url.pathname;
      const page = pathname.split("/").pop() || "index.html";
      const target = page === "" ? "index.html" : page;

      try {
        const networkRes = await fetch(req);
        if (networkRes && networkRes.status === 200 && networkRes.type === "basic") {
          cache.put(`./${target}`, networkRes.clone());
        }
        return networkRes;
      } catch (_err) {
        const fallback = await cache.match(`./${target}`, { ignoreSearch: true })
          || await cache.match("./index.html", { ignoreSearch: true });
        return fallback || new Response("Offline", { status: 503, statusText: "Offline" });
      }
    }

    // JS/CSS: reseau d'abord pour diffuser les correctifs rapidement.
    if (req.destination === "script" || req.destination === "style" || req.destination === "worker") {
      try {
        const networkRes = await fetch(req);
        if (networkRes && networkRes.status === 200 && networkRes.type === "basic") {
          cache.put(req, networkRes.clone());
        }
        return networkRes;
      } catch (_err) {
        const cached = await cache.match(req, { ignoreSearch: true });
        return cached || new Response("Offline", { status: 503, statusText: "Offline" });
      }
    }

    const cached = await cache.match(req, { ignoreSearch: true });
    if (cached) {
      event.waitUntil((async () => {
        try {
          const networkRes = await fetch(req);
          if (networkRes && networkRes.status === 200 && networkRes.type === "basic") {
            await cache.put(req, networkRes.clone());
          }
        } catch (_err) {
          // Ignore echec reseau en tache de fond.
        }
      })());
      return cached;
    }

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
