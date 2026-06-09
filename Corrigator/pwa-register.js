(function () {
  const protocol = (window.location && window.location.protocol) || "";
  if (protocol !== "http:" && protocol !== "https:") return;
  if (!("serviceWorker" in navigator)) return;
  window.addEventListener("load", async function () {
    try {
      const reg = await navigator.serviceWorker.register("./sw.js?v=20260609c", { updateViaCache: "none" });

      // Force une verification de mise a jour au chargement.
      reg.update().catch(() => {});

      // Si un SW est deja en attente, on l'active immediatement.
      if (reg.waiting) {
        reg.waiting.postMessage({ type: "SKIP_WAITING" });
      }

      // Lorsqu'une nouvelle version est installee, on l'active sans attendre.
      reg.addEventListener("updatefound", () => {
        const installing = reg.installing;
        if (!installing) return;
        installing.addEventListener("statechange", () => {
          if (installing.state === "installed" && navigator.serviceWorker.controller) {
            if (reg.waiting) {
              reg.waiting.postMessage({ type: "SKIP_WAITING" });
            }
          }
        });
      });

      let reloaded = false;
      navigator.serviceWorker.addEventListener("controllerchange", () => {
        if (reloaded) return;
        reloaded = true;
        window.location.reload();
      });
    } catch (err) {
      console.warn("Service worker non enregistre:", err);
    }
  });
})();
