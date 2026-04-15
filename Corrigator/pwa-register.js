(function () {
  if (!("serviceWorker" in navigator)) return;
  window.addEventListener("load", async function () {
    try {
      await navigator.serviceWorker.register("./sw.js");
    } catch (err) {
      console.warn("Service worker non enregistre:", err);
    }
  });
})();
