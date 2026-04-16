(function () {
  const DROPBOX_API_ENDPOINT = "https://content.dropboxapi.com/2/files";
  const DROPBOX_TOKEN_ENDPOINT = "https://www.dropbox.com/oauth2/token";
  const DROPBOX_USERS_ENDPOINT = "https://api.dropboxapi.com/2/users/get_current_account";
  const DROPBOX_FILE_PATH = "/corrigator_db.json";
  const IDB_STORE_NAME = "corrigator.dropbox.config";
  const IDB_KEY_CREDENTIALS = "credentials";
  const ENCRYPTION_ALGO = "AES-GCM";
  const ENCRYPTION_IV_LENGTH = 12;
  const ENCRYPTION_TAG_LENGTH = 16;

  let cachedCredentials = null;
  let credentialsReadyPromise = null;
  let cachedAccessToken = null;
  let cachedAccessTokenExpiresAt = 0;

  function normalizeCredentials(input) {
    const raw = input || {};
    const appKey = String(raw.appKey || "").trim();
    const token = String(raw.token || raw.refreshToken || raw.accessToken || "").trim();
    const tokenType = raw.tokenType === "access" || raw.tokenType === "refresh" ? raw.tokenType : "auto";
    return { appKey, token, tokenType };
  }

  function notify(msg, duration) {
    if (typeof window.toast === "function") {
      window.toast(msg, duration);
      return;
    }
    window.alert(msg);
  }

  async function deriveKey() {
    const baseKey = await crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode("corrigator-master-key"),
      "PBKDF2",
      false,
      ["deriveBits"]
    );

    const bits = await crypto.subtle.deriveBits(
      {
        name: "PBKDF2",
        salt: new TextEncoder().encode("corrigator-" + (window.location.hostname || "localhost")),
        iterations: 100000,
        hash: "SHA-256",
      },
      baseKey,
      256
    );

    return crypto.subtle.importKey(
      "raw",
      bits,
      ENCRYPTION_ALGO,
      false,
      ["encrypt", "decrypt"]
    );
  }

  async function encryptCredentials(credentials) {
    const iv = crypto.getRandomValues(new Uint8Array(ENCRYPTION_IV_LENGTH));
    const key = await deriveKey();

    const plaintext = new TextEncoder().encode(JSON.stringify(credentials));
    const ciphertext = await crypto.subtle.encrypt(
      { name: ENCRYPTION_ALGO, iv },
      key,
      plaintext
    );

    const result = new Uint8Array(iv.length + ciphertext.byteLength);
    result.set(iv);
    result.set(new Uint8Array(ciphertext), iv.length);

    return btoa(String.fromCharCode(...result));
  }

  async function decryptCredentials(encrypted) {
    try {
      const data = new Uint8Array(atob(encrypted).split("").map((c) => c.charCodeAt(0)));
      const iv = data.slice(0, ENCRYPTION_IV_LENGTH);
      const ciphertext = data.slice(ENCRYPTION_IV_LENGTH);

      const key = await deriveKey();

      const plaintext = await crypto.subtle.decrypt(
        { name: ENCRYPTION_ALGO, iv },
        key,
        ciphertext
      );

      return JSON.parse(new TextDecoder().decode(plaintext));
    } catch (_err) {
      return null;
    }
  }

  function idbOpen() {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open("corrigator.dropbox", 1);
      request.onupgradeneeded = () => {
        const dbRef = request.result;
        if (!dbRef.objectStoreNames.contains(IDB_STORE_NAME)) {
          dbRef.createObjectStore(IDB_STORE_NAME, { keyPath: "key" });
        }
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }

  async function readCredentialsFromIdb() {
    try {
      const dbRef = await idbOpen();
      return new Promise((resolve, reject) => {
        const tx = dbRef.transaction(IDB_STORE_NAME, "readonly");
        const store = tx.objectStore(IDB_STORE_NAME);
        const req = store.get(IDB_KEY_CREDENTIALS);
        req.onsuccess = () => resolve(req.result ? req.result.value : null);
        req.onerror = () => reject(req.error);
        tx.oncomplete = () => dbRef.close();
      });
    } catch (_err) {
      return null;
    }
  }

  async function writeCredentialsToIdb(encrypted) {
    try {
      const dbRef = await idbOpen();
      return new Promise((resolve, reject) => {
        const tx = dbRef.transaction(IDB_STORE_NAME, "readwrite");
        const store = tx.objectStore(IDB_STORE_NAME);
        store.put({ key: IDB_KEY_CREDENTIALS, value: encrypted });
        tx.oncomplete = () => {
          dbRef.close();
          resolve();
        };
        tx.onerror = () => reject(tx.error);
      });
    } catch (_err) {
      throw _err;
    }
  }

  async function ensureCredentialsReady() {
    if (!credentialsReadyPromise) {
      credentialsReadyPromise = (async () => {
        const encrypted = await readCredentialsFromIdb();
        if (encrypted) {
          cachedCredentials = normalizeCredentials(await decryptCredentials(encrypted));
        }
      })();
    }
    return credentialsReadyPromise;
  }

  function getCredentials() {
    return cachedCredentials;
  }

  async function saveCredentials(appKey, token, tokenType) {
    const credentials = normalizeCredentials({ appKey, token, tokenType });
    if (!credentials.token) {
      throw new Error("Token Dropbox manquant");
    }
    if (credentials.tokenType === "refresh" && !credentials.appKey) {
      throw new Error("App Key requise pour un refresh token");
    }
    cachedCredentials = credentials;
    cachedAccessToken = null;
    cachedAccessTokenExpiresAt = 0;
    const encrypted = await encryptCredentials(credentials);
    await writeCredentialsToIdb(encrypted);
  }

  async function clearCredentials() {
    cachedCredentials = null;
    cachedAccessToken = null;
    cachedAccessTokenExpiresAt = 0;
    const dbRef = await idbOpen();
    return new Promise((resolve, reject) => {
      const tx = dbRef.transaction(IDB_STORE_NAME, "readwrite");
      const store = tx.objectStore(IDB_STORE_NAME);
      store.delete(IDB_KEY_CREDENTIALS);
      tx.oncomplete = () => {
        dbRef.close();
        resolve();
      };
      tx.onerror = () => reject(tx.error);
    });
  }

  async function exchangeRefreshToken(appKey, refreshToken, canUseCache) {
    if (canUseCache && cachedAccessToken && Date.now() < cachedAccessTokenExpiresAt - 30000) {
      return cachedAccessToken;
    }

    const form = new URLSearchParams();
    form.set("grant_type", "refresh_token");
    form.set("refresh_token", refreshToken);
    form.set("client_id", appKey);

    const response = await fetch(DROPBOX_TOKEN_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: form.toString(),
    });

    const data = await response.json().catch(() => ({}));
    if (!response.ok || !data.access_token) {
      throw new Error(data.error_description || data.error || `Token Dropbox invalide (${response.status})`);
    }

    if (canUseCache) {
      cachedAccessToken = data.access_token;
      const expiresInSec = Number(data.expires_in || 14400);
      cachedAccessTokenExpiresAt = Date.now() + expiresInSec * 1000;
      return cachedAccessToken;
    }

    return data.access_token;
  }

  async function requestAccessToken(overrideCredentials) {
    const creds = normalizeCredentials(overrideCredentials || getCredentials());
    if (!creds || !creds.token) {
      throw new Error("Dropbox non configuré");
    }

    const canUseCache = !overrideCredentials;
    if (creds.tokenType === "access") {
      return creds.token;
    }

    if (creds.tokenType === "refresh") {
      if (!creds.appKey) throw new Error("App Key requise pour un refresh token");
      return exchangeRefreshToken(creds.appKey, creds.token, canUseCache);
    }

    if (creds.appKey) {
      try {
        return await exchangeRefreshToken(creds.appKey, creds.token, canUseCache);
      } catch (_err) {
        // Fallback auto: le token saisi est peut-etre un access token direct.
      }
    }

    return creds.token;
  }

  async function readDropboxError(response, fallback) {
    const text = await response.text().catch(() => "");
    if (!text) return fallback;
    try {
      const parsed = JSON.parse(text);
      const errorSummary = String(parsed.error_summary || "");
      const reasonTag = parsed && parsed.error && parsed.error.reason && parsed.error.reason[".tag"];
      const requiredScope =
        parsed && parsed.error && parsed.error.reason &&
        (parsed.error.reason.required_scope || parsed.error.reason.scope);

      if (errorSummary.includes("missing_scope") || reasonTag === "missing_scope") {
        const scopeLabel = requiredScope ? ` (${requiredScope})` : "";
        return `Scope Dropbox manquant${scopeLabel}. Active les scopes files.content.read + files.content.write (+ account_info.read pour le test), puis regenere un nouveau token.`;
      }

      return parsed.error_summary || parsed.error || parsed.error_description || fallback;
    } catch (_err) {
      return text;
    }
  }

  async function dropboxUpload(fileContent) {
    const creds = normalizeCredentials(getCredentials());
    if (!creds || !creds.token) {
      throw new Error("Dropbox non configuré");
    }

    const accessToken = await requestAccessToken();

    const response = await fetch(`${DROPBOX_API_ENDPOINT}/upload`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Dropbox-API-Arg": JSON.stringify({
          path: DROPBOX_FILE_PATH,
          mode: "overwrite",
          autorename: false,
          mute: false,
        }),
        "Content-Type": "application/octet-stream",
      },
      body: fileContent,
    });

    if (!response.ok) {
      const errText = await readDropboxError(response, `Upload failed: ${response.status}`);
      throw new Error(errText);
    }

    return response.json();
  }

  async function dropboxDownload() {
    const creds = normalizeCredentials(getCredentials());
    if (!creds || !creds.token) {
      throw new Error("Dropbox non configuré");
    }

    const accessToken = await requestAccessToken();

    const response = await fetch(`${DROPBOX_API_ENDPOINT}/download`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Dropbox-API-Arg": JSON.stringify({
          path: DROPBOX_FILE_PATH,
        }),
      },
    });

    if (!response.ok) {
      const errText = await readDropboxError(response, `Download failed: ${response.status}`);
      if (response.status === 409) {
        throw new Error("Fichier non trouvé sur Dropbox");
      }
      throw new Error(errText);
    }

    return response.text();
  }

  async function fetchCurrentAccount(accessToken) {
    const response = await fetch(DROPBOX_USERS_ENDPOINT, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      body: "null",
    });

    if (!response.ok) {
      const errText = await readDropboxError(response, `Test impossible (${response.status})`);
      throw new Error(errText);
    }

    return response.json().catch(() => ({}));
  }

  async function testCredentials(appKey, token, tokenType) {
    const cleanAppKey = String(appKey || "").trim();
    const cleanToken = String(token || "").trim();
    const cleanTokenType = tokenType === "access" || tokenType === "refresh" ? tokenType : "auto";
    if (!cleanToken) {
      throw new Error("Token Dropbox obligatoire");
    }

    if (cleanTokenType === "refresh") {
      if (!cleanAppKey) throw new Error("App Key requise pour un refresh token");
      const accessToken = await exchangeRefreshToken(cleanAppKey, cleanToken, false);
      const account = await fetchCurrentAccount(accessToken);
      return {
        modeUsed: "refresh",
        accountId: account.account_id || "",
        displayName: (account.name && account.name.display_name) || "Compte Dropbox",
        email: account.email || "",
      };
    }

    if (cleanTokenType === "access") {
      const account = await fetchCurrentAccount(cleanToken);
      return {
        modeUsed: "access",
        accountId: account.account_id || "",
        displayName: (account.name && account.name.display_name) || "Compte Dropbox",
        email: account.email || "",
      };
    }

    if (cleanAppKey) {
      try {
        const accessToken = await exchangeRefreshToken(cleanAppKey, cleanToken, false);
        const account = await fetchCurrentAccount(accessToken);
        return {
          modeUsed: "refresh",
          accountId: account.account_id || "",
          displayName: (account.name && account.name.display_name) || "Compte Dropbox",
          email: account.email || "",
        };
      } catch (_err) {
        // Fallback sur access token
      }
    }

    const account = await fetchCurrentAccount(cleanToken);
    return {
      modeUsed: "access",
      accountId: account.account_id || "",
      displayName: (account.name && account.name.display_name) || "Compte Dropbox",
      email: account.email || "",
    };
  }

  window.dropboxSync = {
    ensureCredentialsReady,
    getCredentials,
    saveCredentials,
    clearCredentials,
    dropboxUpload,
    dropboxDownload,
    testCredentials,
    notify,
  };
})();
