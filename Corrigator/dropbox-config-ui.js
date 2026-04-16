(function () {
  async function initDropboxConfigUI() {
    if (typeof window.dropboxSync === "undefined") return;

    await window.dropboxSync.ensureCredentialsReady();

    const creds = window.dropboxSync.getCredentials();
    const isConfigured = Boolean(creds && (creds.token || creds.refreshToken));

    const navActions = document.querySelector(".nav-sync-actions");
    if (!navActions) return;

    const configBtn = document.createElement("button");
    configBtn.className = "btn btn-neutral btn-sm";
    configBtn.id = "dropbox-config-btn";
    configBtn.textContent = isConfigured ? "⚙️ Dropbox (✓)" : "⚙️ Dropbox";
    configBtn.style.cssText = isConfigured ? "color: #2e7d32; font-weight: 700;" : "";
    configBtn.onclick = openDropboxConfigModal;

    navActions.insertBefore(configBtn, navActions.firstChild);
  }

  async function openDropboxConfigModal() {
    const modal = document.createElement("div");
    modal.id = "dropbox-config-modal";
    modal.style.cssText = `
      position: fixed;
      top: 0;
      left: 0;
      width: 100%;
      height: 100%;
      background: rgba(0, 0, 0, 0.6);
      display: flex;
      align-items: center;
      justify-content: center;
      z-index: 9999;
    `;

    const card = document.createElement("div");
    card.style.cssText = `
      background: white;
      border-radius: 8px;
      padding: 2rem;
      max-width: 500px;
      max-height: 80vh;
      overflow-y: auto;
      box-shadow: 0 4px 6px rgba(0, 0, 0, 0.1);
    `;

    const creds = window.dropboxSync.getCredentials();

    card.innerHTML = `
      <h2 style="margin-top: 0; color: #1565c0;">Configuration Dropbox</h2>
      
      <div style="background: #f5f5f5; border-left: 4px solid #ff9800; padding: 1rem; border-radius: 4px; margin-bottom: 1.5rem; font-size: 0.9rem;">
        <strong>Instructions :</strong>
        <ol style="margin: 0.5rem 0; padding-left: 1.5rem;">
          <li>Va sur <a href="https://www.dropbox.com/developers/apps" target="_blank" style="color: #1565c0;">dropbox.com/developers/apps</a></li>
          <li>Clique "Create app"</li>
          <li>Choisir "Scoped app" → "App folder"</li>
          <li>Donne un nom (ex: "Corrigator")</li>
          <li>Copie l'<strong>App key</strong> depuis les Settings (utile pour refresh token)</li>
          <li>Dans Permissions, active au minimum <strong>files.content.read</strong> et <strong>files.content.write</strong> (et <strong>account_info.read</strong> pour le bouton test)</li>
          <li>Si tu modifies les permissions, <strong>regenere un nouveau token</strong> (l'ancien garde les anciens scopes)</li>
          <li>Tu peux coller un <strong>Access Token</strong> OU un <strong>Refresh Token</strong></li>
          <li>Tu peux reutiliser la meme App Dropbox depuis plusieurs navigateurs/appareils: chacun configure ses tokens localement</li>
          <li>Le test détecte automatiquement le type de token</li>
        </ol>
      </div>

      <div style="margin-bottom: 1rem;">
        <label style="display: block; font-weight: 600; margin-bottom: 0.5rem; color: #333;">App Key (optionnelle si Access Token)</label>
        <input type="text" id="dropbox-app-key" placeholder="ex: abc123def456" value="${creds?.appKey || ""}" 
          style="width: 100%; padding: 0.6rem; border: 1px solid #ccc; border-radius: 4px; box-sizing: border-box;">
      </div>

      <div style="margin-bottom: 1.5rem;">
        <label style="display: block; font-weight: 600; margin-bottom: 0.5rem; color: #333;">Token Dropbox (access ou refresh)</label>
        <input type="password" id="dropbox-token" placeholder="ex: sl.Bxxxxxxxx" value="${creds?.token || creds?.refreshToken || ""}" 
          style="width: 100%; padding: 0.6rem; border: 1px solid #ccc; border-radius: 4px; box-sizing: border-box;">
        <small style="color: #666;">Afficher le token</small>
        <input type="checkbox" id="toggle-token-visibility" style="margin-left: 0.5rem; cursor: pointer;">
      </div>

      <div id="dropbox-test-status" style="min-height: 1.2rem; margin-bottom: 1rem; font-size: 0.9rem; color: #555;"></div>

      <div style="display: flex; gap: 0.75rem; justify-content: flex-end;">
        <button id="dropbox-cancel-btn" class="btn btn-neutral" style="padding: 0.6rem 1.2rem;">Annuler</button>
        <button id="dropbox-test-btn" class="btn btn-neutral" style="padding: 0.6rem 1.2rem;">Tester la connexion</button>
        <button id="dropbox-save-btn" class="btn btn-primary" style="padding: 0.6rem 1.2rem;">Enregistrer</button>
        ${creds && creds.appKey ? `<button id="dropbox-clear-btn" class="btn btn-danger" style="padding: 0.6rem 1.2rem;">Oublier</button>` : ""}
      </div>
    `;

    modal.appendChild(card);
    document.body.appendChild(modal);

    const toggleVisibility = document.getElementById("toggle-token-visibility");
    const tokenInput = document.getElementById("dropbox-token");
    const appKeyInput = document.getElementById("dropbox-app-key");
    const testStatus = document.getElementById("dropbox-test-status");
    toggleVisibility.addEventListener("change", () => {
      tokenInput.type = toggleVisibility.checked ? "text" : "password";
    });

    document.getElementById("dropbox-cancel-btn").onclick = () => modal.remove();

    document.getElementById("dropbox-test-btn").onclick = async () => {
      const appKey = appKeyInput.value.trim();
      const token = tokenInput.value.trim();
      if (!token) {
        testStatus.textContent = "Renseigne un token Dropbox avant le test.";
        testStatus.style.color = "#b26a00";
        return;
      }

      const testBtn = document.getElementById("dropbox-test-btn");
      testBtn.disabled = true;
      const oldLabel = testBtn.textContent;
      testBtn.textContent = "Test en cours…";
      testStatus.textContent = "Vérification de la connexion Dropbox…";
      testStatus.style.color = "#1565c0";
      try {
        const info = await window.dropboxSync.testCredentials(appKey, token, "auto");
        const who = info.email ? `${info.displayName} (${info.email})` : info.displayName;
        const modeLabel = info.modeUsed === "refresh" ? "refresh token" : "access token";
        testStatus.textContent = `Connexion OK (${modeLabel}) : ${who}`;
        testStatus.style.color = "#2e7d32";
      } catch (err) {
        testStatus.textContent = `Échec du test : ${err.message}`;
        testStatus.style.color = "#c62828";
      } finally {
        testBtn.disabled = false;
        testBtn.textContent = oldLabel;
      }
    };

    document.getElementById("dropbox-save-btn").onclick = async () => {
      const appKey = appKeyInput.value.trim();
      const token = tokenInput.value.trim();

      if (!token) {
        window.alert("Token Dropbox obligatoire");
        return;
      }

      try {
        await window.dropboxSync.saveCredentials(appKey, token, "auto");
        window.dropboxSync.notify("Credentials Dropbox enregistrés !", 2200);
        modal.remove();
        window.location.reload();
      } catch (err) {
        window.alert(`Erreur: ${err.message}`);
      }
    };

    const clearBtn = document.getElementById("dropbox-clear-btn");
    if (clearBtn) {
      clearBtn.onclick = async () => {
        const ok = window.confirm("Oublier les credentials Dropbox ?");
        if (!ok) return;
        try {
          await window.dropboxSync.clearCredentials();
          window.dropboxSync.notify("Credentials oubliés", 2200);
          modal.remove();
          window.location.reload();
        } catch (err) {
          window.alert(`Erreur: ${err.message}`);
        }
      };
    }

    modal.onclick = (e) => {
      if (e.target === modal) modal.remove();
    };
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", initDropboxConfigUI);
  } else {
    initDropboxConfigUI();
  }

  window.openDropboxConfigModal = openDropboxConfigModal;
})();
