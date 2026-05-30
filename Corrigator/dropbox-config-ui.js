(function () {
  const DROPBOX_OAUTH_AUTHORIZE_ENDPOINT = "https://www.dropbox.com/oauth2/authorize";
  const DROPBOX_OAUTH_TOKEN_ENDPOINT = "https://api.dropboxapi.com/oauth2/token";
  const DROPBOX_PKCE_SESSION_KEY = "corrigator.dropbox.pkce";
  const DROPBOX_REDIRECT_URI = "https://oauth.pstmn.io/v1/callback";

  function bytesToBase64Url(bytes) {
    return btoa(String.fromCharCode(...bytes))
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/g, "");
  }

  async function sha256Base64Url(input) {
    const data = new TextEncoder().encode(input);
    const digest = await crypto.subtle.digest("SHA-256", data);
    return bytesToBase64Url(new Uint8Array(digest));
  }

  function randomUrlSafeString(byteLength) {
    const bytes = crypto.getRandomValues(new Uint8Array(byteLength));
    return bytesToBase64Url(bytes);
  }

  function extractCodeFromCallbackUrl(value) {
    const raw = String(value || "").trim();
    if (!raw) return { code: "", state: "", error: "URL vide" };

    try {
      const url = new URL(raw);
      return {
        code: String(url.searchParams.get("code") || ""),
        state: String(url.searchParams.get("state") || ""),
        error: String(url.searchParams.get("error_description") || url.searchParams.get("error") || ""),
      };
    } catch (_err) {
      return { code: "", state: "", error: "URL invalide" };
    }
  }

  async function startPkceOAuthFlow(appKey) {
    const cleanAppKey = String(appKey || "").trim();
    if (!cleanAppKey) throw new Error("App Key obligatoire pour l'assistant OAuth");

    const codeVerifier = randomUrlSafeString(64);
    const state = randomUrlSafeString(24);
    const codeChallenge = await sha256Base64Url(codeVerifier);

    sessionStorage.setItem(
      DROPBOX_PKCE_SESSION_KEY,
      JSON.stringify({
        appKey: cleanAppKey,
        state,
        codeVerifier,
        redirectUri: DROPBOX_REDIRECT_URI,
        createdAt: Date.now(),
      })
    );

    const authUrl = new URL(DROPBOX_OAUTH_AUTHORIZE_ENDPOINT);
    authUrl.searchParams.set("client_id", cleanAppKey);
    authUrl.searchParams.set("response_type", "code");
    authUrl.searchParams.set("token_access_type", "offline");
    authUrl.searchParams.set("code_challenge", codeChallenge);
    authUrl.searchParams.set("code_challenge_method", "S256");
    authUrl.searchParams.set("state", state);
    authUrl.searchParams.set("redirect_uri", DROPBOX_REDIRECT_URI);

    return authUrl.toString();
  }

  async function exchangePkceAuthorizationCode(callbackUrl, appKeyOverride) {
    const parsed = extractCodeFromCallbackUrl(callbackUrl);
    if (parsed.error) {
      throw new Error(`Dropbox a retourné une erreur: ${parsed.error}`);
    }
    if (!parsed.code) {
      throw new Error("Code OAuth introuvable dans l'URL de retour");
    }

    const rawSession = sessionStorage.getItem(DROPBOX_PKCE_SESSION_KEY);
    if (!rawSession) {
      throw new Error("Session OAuth introuvable. Clique d'abord sur 'Étape 1'.");
    }

    let pkce;
    try {
      pkce = JSON.parse(rawSession);
    } catch (_err) {
      throw new Error("Session OAuth corrompue. Recommence l'étape 1.");
    }

    const appKey = String(appKeyOverride || pkce.appKey || "").trim();
    if (!appKey) throw new Error("App Key manquante");
    if (!pkce.codeVerifier) throw new Error("Code verifier manquant. Recommence l'étape 1.");

    if (parsed.state && pkce.state && parsed.state !== pkce.state) {
      throw new Error("Le state OAuth ne correspond pas. Recommence l'étape 1.");
    }

    const form = new URLSearchParams();
    form.set("grant_type", "authorization_code");
    form.set("code", parsed.code);
    form.set("client_id", appKey);
    form.set("code_verifier", pkce.codeVerifier);
    form.set("redirect_uri", pkce.redirectUri || DROPBOX_REDIRECT_URI);

    const response = await fetch(DROPBOX_OAUTH_TOKEN_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: form.toString(),
    });

    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(data.error_description || data.error || `Échange OAuth impossible (${response.status})`);
    }

    sessionStorage.removeItem(DROPBOX_PKCE_SESSION_KEY);
    return {
      appKey,
      refreshToken: String(data.refresh_token || ""),
      accessToken: String(data.access_token || ""),
    };
  }

  async function initDropboxConfigUI() {
    if (typeof window.dropboxSync === "undefined") return;

    await window.dropboxSync.ensureCredentialsReady();

    const creds = window.dropboxSync.getCredentials();
    const isConfigured = Boolean(creds && (creds.token || creds.refreshToken));

    const navActions = document.querySelector(".nav-sync-actions");
    if (!navActions) return;

    if (isConfigured) {
      const pullBtn = document.getElementById("sync-pull-btn");
      const pushBtn = document.getElementById("sync-push-btn");
      if (pullBtn) pullBtn.style.display = "";
      if (pushBtn) pushBtn.style.display = "";
    }

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
        <strong>Consignes de configuration (dans l'ordre) :</strong>
        <ol style="margin: 0.5rem 0; padding-left: 1.5rem;">
          <li>Va sur <a href="https://www.dropbox.com/developers/apps" target="_blank" style="color: #1565c0;">dropbox.com/developers/apps</a></li>
          <li>Clique "Create app"</li>
          <li>Choisis "Scoped app" puis "App folder"</li>
          <li>Donne un nom (ex: Corrigator)</li>
          <li>Dans l'onglet Permissions, active <strong>files.content.read</strong>, <strong>files.content.write</strong> et <strong>account_info.read</strong></li>
          <li>Dans Settings, copie l'<strong>App Key</strong> et ajoute la Redirect URI <strong>${DROPBOX_REDIRECT_URI}</strong></li>
          <li>Reviens ici, remplis l'App Key, puis lance l'assistant refresh token</li>
          <li>Si tu modifies les permissions plus tard, regénère un nouveau token</li>
        </ol>
      </div>

      <div style="margin-bottom: 1rem;">
        <label style="display: block; font-weight: 600; margin-bottom: 0.5rem; color: #333;">1) App Key Dropbox</label>
        <input type="text" id="dropbox-app-key" placeholder="ex: abc123def456" value="${creds?.appKey || ""}" 
          style="width: 100%; padding: 0.6rem; border: 1px solid #ccc; border-radius: 4px; box-sizing: border-box;">
        <small style="color: #666;">Recommandée dans tous les cas, obligatoire pour le mode refresh token.</small>
      </div>

      <div style="background: #eef6ff; border: 1px solid #c8ddff; border-radius: 6px; padding: 0.9rem; margin-bottom: 1.2rem;">
        <div style="font-weight: 700; color: #0d47a1; margin-bottom: 0.5rem;">2) Assistant refresh token (recommandé)</div>
        <div style="font-size: 0.88rem; color: #204060; margin-bottom: 0.7rem;">Fais ces 2 étapes, puis clique sur "Enregistrer". Avec un refresh token, tu n'auras normalement plus à revenir ici.</div>
        <div style="display: flex; gap: 0.5rem; flex-wrap: wrap; margin-bottom: 0.6rem;">
          <button id="dropbox-oauth-start-btn" class="btn btn-neutral" style="padding: 0.5rem 0.9rem;">Étape 1: Autoriser Dropbox</button>
          <button id="dropbox-oauth-copy-redirect-btn" class="btn btn-neutral" style="padding: 0.5rem 0.9rem;">Copier Redirect URI</button>
        </div>
        <label style="display: block; font-weight: 600; margin-bottom: 0.35rem; color: #1b3f73;">Étape 2: Colle l'URL de retour complète</label>
        <input type="text" id="dropbox-oauth-callback-url" placeholder="https://localhost/callback?code=...&state=..." style="width: 100%; padding: 0.55rem; border: 1px solid #b8c7e6; border-radius: 4px; box-sizing: border-box; margin-bottom: 0.5rem;">
        <div style="display: flex; gap: 0.5rem; align-items: center;">
          <button id="dropbox-oauth-exchange-btn" class="btn btn-primary" style="padding: 0.5rem 0.9rem;">Échanger le code</button>
          <small id="dropbox-oauth-status" style="color: #365f95;"></small>
        </div>
      </div>

      <div style="margin-bottom: 1.5rem;">
        <label style="display: block; font-weight: 600; margin-bottom: 0.5rem; color: #333;">3) Token Dropbox (manuel, option de secours)</label>
        <input type="password" id="dropbox-token" placeholder="ex: sl.Bxxxxxxxx" value="${creds?.token || creds?.refreshToken || ""}" 
          style="width: 100%; padding: 0.6rem; border: 1px solid #ccc; border-radius: 4px; box-sizing: border-box;">
        <small style="color: #666;">Tu peux coller un access token ou un refresh token. L'assistant ci-dessus reste la méthode recommandée.</small>
        <br>
        <small style="color: #666;">Afficher le token</small>
        <input type="checkbox" id="toggle-token-visibility" style="margin-left: 0.5rem; cursor: pointer;">
      </div>

      <div id="dropbox-test-status" style="min-height: 1.2rem; margin-bottom: 1rem; font-size: 0.9rem; color: #555;"></div>

      <div style="display: flex; gap: 0.75rem; justify-content: flex-end;">
        <button id="dropbox-cancel-btn" class="btn btn-neutral" style="padding: 0.6rem 1.2rem;">Annuler</button>
        <button id="dropbox-test-btn" class="btn btn-neutral" style="padding: 0.6rem 1.2rem;">Tester la connexion</button>
        <button id="dropbox-save-btn" class="btn btn-primary" style="padding: 0.6rem 1.2rem;">Enregistrer</button>
        ${creds && (creds.appKey || creds.token || creds.refreshToken) ? `<button id="dropbox-clear-btn" class="btn btn-danger" style="padding: 0.6rem 1.2rem;">Oublier</button>` : ""}
      </div>
    `;

    modal.appendChild(card);
    document.body.appendChild(modal);

    const toggleVisibility = document.getElementById("toggle-token-visibility");
    const tokenInput = document.getElementById("dropbox-token");
    const appKeyInput = document.getElementById("dropbox-app-key");
    const testStatus = document.getElementById("dropbox-test-status");
    const oauthStatus = document.getElementById("dropbox-oauth-status");

    document.getElementById("dropbox-oauth-copy-redirect-btn").onclick = async () => {
      try {
        await navigator.clipboard.writeText(DROPBOX_REDIRECT_URI);
        oauthStatus.textContent = "Redirect URI copiée";
        oauthStatus.style.color = "#2e7d32";
      } catch (_err) {
        oauthStatus.textContent = `Copie impossible. Utilise: ${DROPBOX_REDIRECT_URI}`;
        oauthStatus.style.color = "#b26a00";
      }
    };

    document.getElementById("dropbox-oauth-start-btn").onclick = async () => {
      const appKey = appKeyInput.value.trim();
      if (!appKey) {
        oauthStatus.textContent = "Renseigne d'abord l'App Key";
        oauthStatus.style.color = "#b26a00";
        return;
      }

      try {
        const authUrl = await startPkceOAuthFlow(appKey);
        window.open(authUrl, "_blank", "noopener");
        oauthStatus.textContent = "Dropbox ouvert. Autorise puis colle l'URL de retour.";
        oauthStatus.style.color = "#1565c0";
      } catch (err) {
        oauthStatus.textContent = `Démarrage OAuth impossible: ${err.message}`;
        oauthStatus.style.color = "#c62828";
      }
    };

    document.getElementById("dropbox-oauth-exchange-btn").onclick = async () => {
      const callbackInput = document.getElementById("dropbox-oauth-callback-url");
      const callbackUrl = callbackInput.value.trim();
      const appKey = appKeyInput.value.trim();
      if (!callbackUrl) {
        oauthStatus.textContent = "Colle d'abord l'URL de retour Dropbox";
        oauthStatus.style.color = "#b26a00";
        return;
      }

      const exchangeBtn = document.getElementById("dropbox-oauth-exchange-btn");
      exchangeBtn.disabled = true;
      const oldText = exchangeBtn.textContent;
      exchangeBtn.textContent = "Échange en cours…";
      oauthStatus.textContent = "Échange OAuth en cours…";
      oauthStatus.style.color = "#1565c0";

      try {
        const tokens = await exchangePkceAuthorizationCode(callbackUrl, appKey);
        appKeyInput.value = tokens.appKey;
        tokenInput.value = tokens.refreshToken || tokens.accessToken;

        if (tokens.refreshToken) {
          oauthStatus.textContent = "Refresh token obtenu. Clique sur Enregistrer.";
          oauthStatus.style.color = "#2e7d32";
        } else {
          oauthStatus.textContent = "Pas de refresh token reçu. Vérifie token_access_type=offline.";
          oauthStatus.style.color = "#b26a00";
        }
      } catch (err) {
        oauthStatus.textContent = `Échange OAuth échoué: ${err.message}`;
        oauthStatus.style.color = "#c62828";
      } finally {
        exchangeBtn.disabled = false;
        exchangeBtn.textContent = oldText;
      }
    };

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

      let tokenTypeToSave = "auto";
      try {
        const info = await window.dropboxSync.testCredentials(appKey, token, "auto");
        tokenTypeToSave = info.modeUsed === "refresh" ? "refresh" : "access";

        if (tokenTypeToSave === "access") {
          const ok = window.confirm(
            "Ce token est un access token. Il expirera et tu devras reconfigurer Dropbox plus tard.\n\n"
            + "Pour ne plus toucher la config, utilise un refresh token (avec App Key).\n\n"
            + "Enregistrer quand même ?"
          );
          if (!ok) return;
        }
      } catch (err) {
        const ok = window.confirm(
          "Le test automatique du type de token a échoué.\n\n"
          + `Détail: ${err.message}\n\n`
          + "Enregistrer quand même la configuration ?"
        );
        if (!ok) return;
      }

      try {
        await window.dropboxSync.saveCredentials(appKey, token, tokenTypeToSave);
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
