(function () {
  const API_SYNC = "http://localhost:8000";
  let latestSyncStatus = null;
  let afterPullHandler = null;

  function notify(msg, duration) {
    if (typeof window.toast === "function") {
      window.toast(msg, duration);
      return;
    }
    console.log(msg);
  }

  function setSyncButtonsDisabled(disabled) {
    const pullBtn = document.getElementById("sync-pull-btn");
    const pushBtn = document.getElementById("sync-push-btn");
    if (pullBtn) pullBtn.disabled = disabled;
    if (pushBtn) pushBtn.disabled = disabled;
  }

  function fmtSize(size) {
    if (size == null) return "?";
    if (size < 1024) return `${size} o`;
    if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} Ko`;
    return `${(size / (1024 * 1024)).toFixed(2)} Mo`;
  }

  function fmtDate(iso) {
    if (!iso) return "-";
    try {
      return new Date(iso).toLocaleString("fr-FR");
    } catch (_err) {
      return iso;
    }
  }

  function relationText(relation) {
    switch (relation) {
      case "in-sync": return "A jour";
      case "local-newer": return "Local plus recent";
      case "cloud-newer": return "Cloud plus recent";
      case "missing-cloud": return "Cloud absent";
      case "missing-local": return "Local absent";
      case "both-missing": return "Aucune base";
      default: return "Inconnu";
    }
  }

  async function loadSyncStatus() {
    const zone = document.getElementById("sync-status");
    if (!zone) return null;

    try {
      const res = await fetch(`${API_SYNC}/sync/status`);
      if (!res.ok) throw new Error("status non disponible");
      const s = await res.json();
      latestSyncStatus = s;

      const local = s.local;
      const cloud = s.cloud;
      zone.textContent = relationText(s.relation);
      zone.title = `Local: ${local ? `${fmtSize(local.size)} — ${fmtDate(local.mtimeIso)}` : "absent"}\nCloud: ${cloud ? `${fmtSize(cloud.size)} — ${fmtDate(cloud.mtimeIso)}` : "absent"}\nChemin cloud: ${s.cloud_path || "-"}`;
      return s;
    } catch (err) {
      latestSyncStatus = null;
      zone.textContent = "Erreur sync";
      zone.title = err.message;
      return null;
    }
  }

  async function syncPush() {
    if (!latestSyncStatus) await loadSyncStatus();
    if (latestSyncStatus?.relation === "cloud-newer") {
      const ok = confirm("La base cloud est plus recente. Push ecrasera cette version. Continuer ?");
      if (!ok) return;
    }

    setSyncButtonsDisabled(true);
    try {
      let res = await fetch(`${API_SYNC}/sync/push`, { method: "POST" });
      const data = await res.json().catch(() => ({}));
      if (!res.ok && data?.require_force) {
        const confirmForce = confirm(`${data.detail}\n\nForcer le push quand meme ?`);
        if (!confirmForce) {
          await loadSyncStatus();
          return;
        }
        res = await fetch(`${API_SYNC}/sync/push`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ force: true }),
        });
        const retryData = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(retryData.detail || "push force impossible");
      } else if (!res.ok) {
        throw new Error(data.detail || "push impossible");
      }

      notify("Push termine", 2200);
      await loadSyncStatus();
    } catch (err) {
      notify(`Erreur push: ${err.message}`, 3500);
    } finally {
      setSyncButtonsDisabled(false);
    }
  }

  async function syncPull() {
    if (!latestSyncStatus) await loadSyncStatus();
    if (!confirm("Pull va remplacer la base locale par la version cloud. Continuer ?")) return;

    if (latestSyncStatus?.relation === "local-newer") {
      const ok = confirm("La base locale est plus recente. Pull peut ecraser des donnees recentes. Continuer ?");
      if (!ok) return;
    }

    setSyncButtonsDisabled(true);
    try {
      let res = await fetch(`${API_SYNC}/sync/pull`, { method: "POST" });
      const data = await res.json().catch(() => ({}));
      if (!res.ok && data?.require_force) {
        const confirmForce = confirm(`${data.detail}\n\nForcer le pull quand meme ?`);
        if (!confirmForce) {
          await loadSyncStatus();
          return;
        }
        res = await fetch(`${API_SYNC}/sync/pull`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ force: true }),
        });
        const retryData = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(retryData.detail || "pull force impossible");
      } else if (!res.ok) {
        throw new Error(data.detail || "pull impossible");
      }

      notify("Pull termine (base locale remplacee)", 2600);
      await loadSyncStatus();
      if (typeof afterPullHandler === "function") {
        await afterPullHandler();
      }
    } catch (err) {
      notify(`Erreur pull: ${err.message}`, 3500);
    } finally {
      setSyncButtonsDisabled(false);
    }
  }

  function initSyncNav(options = {}) {
    afterPullHandler = options.afterPull || null;
    loadSyncStatus();
  }

  window.loadSyncStatus = loadSyncStatus;
  window.syncPush = syncPush;
  window.syncPull = syncPull;
  window.initSyncNav = initSyncNav;
})();
