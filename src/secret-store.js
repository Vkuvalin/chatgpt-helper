(function initSecretStore(root) {
  "use strict";

  const DB_NAME = "chatgpt-helper-private";
  const DB_VERSION = 1;
  const STORE_NAME = "secrets";
  const RECORD_ID = "openrouter-api-key";

  function validateKey(value) {
    const key = typeof value === "string" ? value.trim() : "";
    if (key.length < 20 || key.length > 512 || /[\s\x00-\x1F\x7F]/.test(key)) {
      return { ok: false, error: { code: "API_KEY_INVALID", message: "Введите корректный ключ OpenRouter длиной от 20 до 512 символов без пробелов." } };
    }
    return { ok: true, key };
  }

  function openDatabase() {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, DB_VERSION);
      request.addEventListener("upgradeneeded", () => {
        if (!request.result.objectStoreNames.contains(STORE_NAME)) {
          request.result.createObjectStore(STORE_NAME, { keyPath: "id" });
        }
      });
      request.addEventListener("success", () => resolve(request.result), { once: true });
      request.addEventListener("error", () => reject(request.error || new Error("IndexedDB unavailable.")), { once: true });
      request.addEventListener("blocked", () => reject(new Error("IndexedDB upgrade blocked.")), { once: true });
    });
  }

  async function withStore(mode, operation) {
    const database = await openDatabase();
    try {
      return await new Promise((resolve, reject) => {
        const transaction = database.transaction(STORE_NAME, mode);
        const store = transaction.objectStore(STORE_NAME);
        let result;
        transaction.addEventListener("complete", () => resolve(result), { once: true });
        transaction.addEventListener("abort", () => reject(transaction.error || new Error("Secret transaction aborted.")), { once: true });
        transaction.addEventListener("error", () => reject(transaction.error || new Error("Secret transaction failed.")), { once: true });
        result = operation(store, transaction);
      });
    } finally {
      database.close();
    }
  }

  async function getRecord() {
    return withStore("readonly", (store) => new Promise((resolve, reject) => {
      const request = store.get(RECORD_ID);
      request.addEventListener("success", () => resolve(request.result || null), { once: true });
      request.addEventListener("error", () => reject(request.error || new Error("Secret read failed.")), { once: true });
    }));
  }

  async function getKey() {
    const record = await getRecord();
    return typeof record?.value === "string" ? record.value : null;
  }

  async function hasKey() {
    return Boolean(await getKey());
  }

  async function setKey(value) {
    const validation = validateKey(value);
    if (!validation.ok) return validation;
    const existing = await getRecord();
    const now = Date.now();
    await withStore("readwrite", (store) => {
      store.put({ id: RECORD_ID, value: validation.key, createdAt: existing?.createdAt || now, updatedAt: now });
    });
    return { ok: true };
  }

  async function deleteKey() {
    await withStore("readwrite", (store) => { store.delete(RECORD_ID); });
    return { ok: true };
  }

  const api = Object.freeze({ DB_NAME, DB_VERSION, STORE_NAME, RECORD_ID, validateKey, getKey, hasKey, setKey, deleteKey });
  root.ChatGPTHelperSecretStore = api;
  if (typeof module === "object" && module.exports) module.exports = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
