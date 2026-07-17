/* global chrome, importScripts */
"use strict";

importScripts("analysis-contract.js", "glossary-store.js", "secret-store.js", "openrouter-client.js");

const contract = globalThis.ChatGPTHelperAnalysisContract;
const glossaryStore = globalThis.ChatGPTHelperGlossaryStore;
const secretStore = globalThis.ChatGPTHelperSecretStore;
const openRouterClient = globalThis.ChatGPTHelperOpenRouterClient;
const MESSAGES = contract.MESSAGE_TYPES;
const MENU_ID = "chatgpt-helper-analyze-selection";
const MENU_OPTIONS = Object.freeze({
  title: "Разобрать английские термины",
  contexts: ["selection"],
  documentUrlPatterns: ["https://chatgpt.com/*", "https://chat.openai.com/*"],
});
const LOCK_KEY_PREFIX = "chatgpt-helper:analysis-lock:";
const VALID_THEMES = new Set(["system", "graphite", "navy", "violet", "gold"]);
const activeRequests = new Map();
let migrationPromise = null;
let glossaryMutationQueue = Promise.resolve();
let contextMenuRegistrationQueue = Promise.resolve();

function createStableId() {
  return contract.createId("template");
}

function normalizeTemplates(value) {
  if (!Array.isArray(value)) return [];
  const usedIds = new Set();
  return value.flatMap((template) => {
    if (!template || typeof template !== "object") return [];
    const name = typeof template.name === "string" ? template.name : "";
    const content = typeof template.content === "string" ? template.content : "";
    if (!name.trim() || !content.trim()) return [];
    let id = typeof template.id === "string" && template.id.trim() ? template.id : createStableId();
    if (usedIds.has(id)) id = createStableId();
    usedIds.add(id);
    return [{ ...template, id, name, content, autoSend: template.autoSend === true }];
  });
}

function normalizeSettings(value) {
  const settings = value && typeof value === "object" ? value : {};
  return contract.normalizeAnalysisSettings({
    ...settings,
    theme: VALID_THEMES.has(settings.theme) ? settings.theme : "system",
    wallpaperDataUrl: typeof settings.wallpaperDataUrl === "string" && settings.wallpaperDataUrl.startsWith("data:image/")
      ? settings.wallpaperDataUrl
      : null,
    closePanelAfterRun: settings.closePanelAfterRun !== false,
    recentTemplatesHoverEnabled: settings.recentTemplatesHoverEnabled !== false,
  });
}

function normalizeRecentTemplateIds(value) {
  if (!Array.isArray(value)) return [];
  const result = [];
  for (const item of value) {
    if (typeof item !== "string") continue;
    const id = item.trim();
    if (!id || result.includes(id)) continue;
    result.push(id);
    if (result.length === 3) break;
  }
  return result;
}

async function migrateStorage() {
  const stored = await chrome.storage.local.get([
    "templates", "settings", "selectedTemplate", "recentTemplateIds",
    "glossarySchemaVersion", "glossaryEntries",
  ]);
  const migration = buildStorageMigrationPatch(stored);
  if (Object.keys(migration.changes).length) await chrome.storage.local.set(migration.changes);
  if (migration.removeSelectedTemplate) await chrome.storage.local.remove("selectedTemplate");
  return migration;
}

function storageValuesEqual(left, right) {
  if (Object.is(left, right)) return true;
  if (Array.isArray(left) || Array.isArray(right)) {
    return Array.isArray(left)
      && Array.isArray(right)
      && left.length === right.length
      && left.every((value, index) => storageValuesEqual(value, right[index]));
  }
  if (!left || !right || typeof left !== "object" || typeof right !== "object") return false;
  const leftKeys = Object.keys(left);
  const rightKeys = Object.keys(right);
  return leftKeys.length === rightKeys.length
    && leftKeys.every((key) => Object.prototype.hasOwnProperty.call(right, key)
      && storageValuesEqual(left[key], right[key]));
}

function buildStorageMigrationPatch(storedValue) {
  const stored = storedValue && typeof storedValue === "object" ? storedValue : {};
  const changes = {};
  const normalizedTemplates = normalizeTemplates(stored.templates);
  const normalizedSettings = normalizeSettings(stored.settings);
  const normalizedRecentTemplateIds = normalizeRecentTemplateIds(stored.recentTemplateIds);

  if (!storageValuesEqual(stored.templates, normalizedTemplates)) changes.templates = normalizedTemplates;
  if (!storageValuesEqual(stored.settings, normalizedSettings)) changes.settings = normalizedSettings;
  if (!storageValuesEqual(stored.recentTemplateIds, normalizedRecentTemplateIds)) {
    changes.recentTemplateIds = normalizedRecentTemplateIds;
  }

  const futureGlossarySchema = Number.isInteger(stored.glossarySchemaVersion)
    && stored.glossarySchemaVersion > glossaryStore.SCHEMA_VERSION;
  if (!futureGlossarySchema) {
    if (!Array.isArray(stored.glossaryEntries)) changes.glossaryEntries = [];
    if (!Number.isInteger(stored.glossarySchemaVersion)
      || stored.glossarySchemaVersion < glossaryStore.SCHEMA_VERSION) {
      changes.glossarySchemaVersion = glossaryStore.SCHEMA_VERSION;
    }
  }

  return { changes, removeSelectedTemplate: stored.selectedTemplate !== undefined };
}

function ensureMigrated() {
  if (!migrationPromise) {
    migrationPromise = migrateStorage().catch((error) => {
      migrationPromise = null;
      throw error;
    });
  }
  return migrationPromise;
}

function registerContextMenu() {
  const operation = contextMenuRegistrationQueue.then(async () => {
    const updated = await new Promise((resolve) => {
      chrome.contextMenus.update(MENU_ID, MENU_OPTIONS, () => {
        const error = chrome.runtime.lastError;
        resolve(!error);
      });
    });
    if (updated) return;
    await new Promise((resolve) => {
      chrome.contextMenus.create({ id: MENU_ID, ...MENU_OPTIONS }, () => {
        // A concurrent or previous registration is already the desired outcome.
        void chrome.runtime.lastError;
        resolve();
      });
    });
  });
  contextMenuRegistrationQueue = operation.catch(() => {});
  return operation;
}

function contentSender(sender) {
  const url = sender?.tab?.url || sender?.url || "";
  return Number.isInteger(sender?.tab?.id) && contract.isSupportedUrl(url);
}

function optionsSender(sender) {
  const optionsUrl = chrome.runtime.getURL("src/options.html");
  return sender?.url === optionsUrl && (!sender.tab?.url || sender.tab.url === optionsUrl);
}

function validRequestId(value) {
  return typeof value === "string" && value.length >= 8 && value.length <= 160;
}

function isSupportedAnalysisPageTransition(snapshotUrl, senderUrl) {
  return contract.isSupportedUrl(snapshotUrl) && contract.isSupportedUrl(senderUrl);
}

function sessionLockKey(tabId) {
  return `${LOCK_KEY_PREFIX}${tabId}`;
}

async function acquireAnalysisLock(tabId, requestId) {
  if (activeRequests.has(tabId)) return false;
  activeRequests.set(tabId, requestId);
  try {
    const key = sessionLockKey(tabId);
    const stored = await chrome.storage.session.get(key);
    const current = stored[key];
    if (current && current.requestId !== requestId && Number(current.expiresAt) > Date.now()) {
      activeRequests.delete(tabId);
      return false;
    }
    const startedAt = Date.now();
    await chrome.storage.session.set({
      [key]: { requestId, startedAt, expiresAt: startedAt + contract.ACTIVE_LOCK_TTL_MS },
    });
    return true;
  } catch (error) {
    activeRequests.delete(tabId);
    throw error;
  }
}

async function releaseAnalysisLock(tabId, requestId) {
  if (activeRequests.get(tabId) === requestId) activeRequests.delete(tabId);
  const key = sessionLockKey(tabId);
  const stored = await chrome.storage.session.get(key).catch(() => ({}));
  if (stored[key]?.requestId === requestId) await chrome.storage.session.remove(key).catch(() => {});
}

function enqueueGlossaryMutation(operation) {
  const result = glossaryMutationQueue.then(operation, operation);
  glossaryMutationQueue = result.catch(() => {});
  return result;
}

async function mergeAnalysisTerms(terms) {
  return enqueueGlossaryMutation(async () => {
    let current;
    try {
      current = await glossaryStore.load();
    } catch (_) {
      return {
        entries: null,
        results: terms.map((term) => ({ ...term, status: "unsaved" })),
        storageWarning: true,
      };
    }
    const merged = glossaryStore.mergeEntries(current.entries, terms);
    if (!merged.results.some((result) => result.status === "new")) {
      return { entries: current.entries, results: merged.results, storageWarning: false };
    }
    try {
      await glossaryStore.save(merged.entries);
      return { entries: merged.entries, results: merged.results, storageWarning: false };
    } catch (_) {
      return {
        entries: current.entries,
        results: merged.results.map((result) => result.status === "new"
          ? { ...result, status: "unsaved", savedEntry: undefined }
          : result),
        storageWarning: true,
      };
    }
  });
}

async function handleAnalysis(message, sender) {
  const tabId = sender.tab.id;
  const snapshot = message?.snapshot;
  const senderUrl = sender?.tab?.url || sender?.url || "";
  if (!snapshot || !validRequestId(snapshot.requestId)
    || !["shortcut", "context-menu"].includes(snapshot.trigger)
    || typeof snapshot.createdAt !== "number"
    || !isSupportedAnalysisPageTransition(snapshot.pageUrl, senderUrl)) {
    return contract.errorEnvelope(snapshot?.requestId, "UNSUPPORTED_PAGE");
  }
  const selection = contract.validateSelection(snapshot.text);
  if (!selection.ok) return { ok: false, requestId: snapshot.requestId, error: selection.error };
  try {
    if (!await acquireAnalysisLock(tabId, snapshot.requestId)) {
      return contract.errorEnvelope(snapshot.requestId, "ANALYSIS_ALREADY_RUNNING");
    }
  } catch (_) {
    return contract.errorEnvelope(snapshot.requestId, "PROVIDER_ERROR");
  }

  try {
    const apiKey = await secretStore.getKey();
    if (!apiKey) return contract.errorEnvelope(snapshot.requestId, "API_KEY_MISSING");
    const analyzed = await openRouterClient.analyze(selection.text, apiKey);
    if (!analyzed.ok) return { ok: false, requestId: snapshot.requestId, error: analyzed.error };
    const glossary = await mergeAnalysisTerms(analyzed.terms);
    return {
      ok: true,
      requestId: snapshot.requestId,
      terms: glossary.results,
      ...(Array.isArray(glossary.entries) ? { glossaryEntries: glossary.entries } : {}),
      storageWarning: glossary.storageWarning,
    };
  } catch (_) {
    return contract.errorEnvelope(snapshot.requestId, "PROVIDER_ERROR");
  } finally {
    await releaseAnalysisLock(tabId, snapshot.requestId);
  }
}

async function handleGlossaryMutation(message) {
  if (message.type === MESSAGES.REPLACE_GLOSSARY_ENTRY) {
    return enqueueGlossaryMutation(async () => {
      const current = await glossaryStore.load();
      const result = glossaryStore.replaceEntry(current.entries, message.command);
      if (!result.ok) return result;
      await glossaryStore.save(result.entries);
      return { ok: true, entry: result.entry, recreated: result.recreated, glossaryEntries: result.entries };
    });
  }
  if (message.type === MESSAGES.MOVE_GLOSSARY_ENTRY) {
    return enqueueGlossaryMutation(async () => {
      const current = await glossaryStore.load();
      const entryId = typeof message.entryId === "string" ? message.entryId : "";
      const beforeEntryId = message.beforeEntryId === null || typeof message.beforeEntryId === "string"
        ? message.beforeEntryId
        : undefined;
      if (!entryId || beforeEntryId === undefined) return { ok: false, error: contract.makeError("GLOSSARY_STORAGE_FAILED") };
      const result = glossaryStore.moveEntry(current.entries, entryId, beforeEntryId);
      if (!result.ok) return result;
      await glossaryStore.save(result.entries);
      return { ok: true, glossaryEntries: result.entries };
    });
  }
  if (message.type === MESSAGES.DELETE_GLOSSARY_ENTRY) {
    return enqueueGlossaryMutation(async () => {
      const current = await glossaryStore.load();
      const result = glossaryStore.deleteEntry(current.entries, typeof message.entryId === "string" ? message.entryId : "");
      if (!result.ok) return result;
      await glossaryStore.save(result.entries);
      return { ok: true, glossaryEntries: result.entries };
    });
  }
  return { ok: false, error: contract.makeError("GLOSSARY_STORAGE_FAILED") };
}

async function broadcastKeyStatus(configured) {
  let tabs;
  try {
    tabs = await chrome.tabs.query({ url: MENU_OPTIONS.documentUrlPatterns });
  } catch (_) {
    return;
  }
  const message = { type: MESSAGES.KEY_STATUS_CHANGED, configured };
  await Promise.all((Array.isArray(tabs) ? tabs : [])
    .filter((tab) => Number.isInteger(tab?.id) && contract.isSupportedUrl(tab.url || ""))
    .map((tab) => chrome.tabs.sendMessage(tab.id, message).catch(() => {})));
}

async function handleKeyMutation(message) {
  const response = message.type === MESSAGES.SET_KEY
    ? await secretStore.setKey(message.apiKey)
    : await secretStore.deleteKey();
  if (response?.ok) await broadcastKeyStatus(message.type === MESSAGES.SET_KEY);
  return response;
}

async function handleMessage(message, sender) {
  if (!message || typeof message.type !== "string") return { ok: false, error: contract.makeError("REQUEST_CONTRACT_ERROR") };
  await ensureMigrated();

  if (message.type === MESSAGES.GET_KEY_STATUS) {
    if (!contentSender(sender) && !optionsSender(sender)) return { ok: false, error: contract.makeError("REQUEST_FORBIDDEN") };
    return { ok: true, configured: await secretStore.hasKey() };
  }

  if (optionsSender(sender)) {
    if (message.type === MESSAGES.SET_KEY || message.type === MESSAGES.DELETE_KEY) return handleKeyMutation(message);
    if (message.type === MESSAGES.VERIFY_KEY) {
      const apiKey = await secretStore.getKey();
      return apiKey ? openRouterClient.verifyKey(apiKey) : { ok: false, status: "missing", error: contract.makeError("API_KEY_MISSING") };
    }
    return { ok: false, error: contract.makeError("REQUEST_FORBIDDEN") };
  }

  if (!contentSender(sender)) return { ok: false, error: contract.makeError("REQUEST_FORBIDDEN") };
  if (message.type === MESSAGES.ANALYZE_SELECTED_TERMS) return handleAnalysis(message, sender);
  if (message.type === MESSAGES.OPEN_OPTIONS) {
    await chrome.runtime.openOptionsPage();
    return { ok: true };
  }
  if ([MESSAGES.REPLACE_GLOSSARY_ENTRY, MESSAGES.MOVE_GLOSSARY_ENTRY, MESSAGES.DELETE_GLOSSARY_ENTRY].includes(message.type)) {
    try {
      return await handleGlossaryMutation(message);
    } catch (_) {
      return { ok: false, error: contract.makeError("GLOSSARY_STORAGE_FAILED") };
    }
  }
  return { ok: false, error: contract.makeError("REQUEST_FORBIDDEN") };
}

chrome.runtime.onInstalled.addListener(() => {
  void Promise.all([ensureMigrated(), registerContextMenu()]).catch(() => {});
});

chrome.runtime.onStartup.addListener(() => {
  void Promise.all([ensureMigrated(), registerContextMenu()]).catch(() => {});
});

chrome.action.onClicked.addListener((tab) => {
  if (!tab.id || !contract.isSupportedUrl(tab.url || "")) return;
  void chrome.tabs.sendMessage(tab.id, { type: MESSAGES.TOGGLE_PANEL }).catch(() => {});
});

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId !== MENU_ID || !tab?.id || !contract.isSupportedUrl(tab.url || "")) return;
  void chrome.tabs.sendMessage(tab.id, {
    type: MESSAGES.CONTEXT_MENU_SELECTION,
    selectionText: typeof info.selectionText === "string" ? info.selectionText : "",
    pageUrl: tab.url,
  }).catch(() => {});
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const allowed = new Set(Object.values(MESSAGES));
  if (!message || !allowed.has(message.type)) return false;
  void handleMessage(message, sender)
    .then(sendResponse)
    .catch(() => sendResponse({ ok: false, error: contract.makeError("PROVIDER_ERROR") }));
  return true;
});

void ensureMigrated().catch(() => {});
