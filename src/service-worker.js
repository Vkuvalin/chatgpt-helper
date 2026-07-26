/* global chrome, importScripts */
"use strict";

importScripts(
  "workspace-contract.js",
  "conversation-context.js",
  "command-registry.js",
  "import-export.js",
  "workspace-store.js",
  "analysis-contract.js",
  "glossary-store.js",
  "secret-store.js",
  "openrouter-client.js",
);

const contract = globalThis.ChatGPTHelperAnalysisContract;
const workspaceContract = globalThis.ChatGPTHelperWorkspaceContract;
const conversationContext = globalThis.ChatGPTHelperConversationContext;
const commandRegistry = globalThis.ChatGPTHelperCommandRegistry;
const importExport = globalThis.ChatGPTHelperImportExport;
const workspaceStoreModule = globalThis.ChatGPTHelperWorkspaceStore;
const glossaryStore = globalThis.ChatGPTHelperGlossaryStore;
const secretStore = globalThis.ChatGPTHelperSecretStore;
const openRouterClient = globalThis.ChatGPTHelperOpenRouterClient;
const MESSAGES = contract.MESSAGE_TYPES;
const WORKSPACE_MESSAGES = workspaceContract.MESSAGE_TYPES;
const SUPPORTED_PATTERNS = Object.freeze(["https://chatgpt.com/*", "https://chat.openai.com/*"]);
const CONTEXT_MENUS = Object.freeze([
  Object.freeze({
    id: commandRegistry.COMMANDS.analyzeSelection.contextMenuId,
    title: "Разобрать английские термины",
    contexts: ["selection"],
    documentUrlPatterns: SUPPORTED_PATTERNS,
  }),
  Object.freeze({
    id: commandRegistry.COMMANDS.saveSelection.contextMenuId,
    title: "Сохранить выделенный текст",
    contexts: ["selection"],
    documentUrlPatterns: SUPPORTED_PATTERNS,
  }),
  Object.freeze({
    id: commandRegistry.COMMANDS.normalizeComposer.contextMenuId,
    title: "Нормализовать пустые строки",
    contexts: ["editable"],
    documentUrlPatterns: SUPPORTED_PATTERNS,
  }),
]);
const LOCK_KEY_PREFIX = "chatgpt-helper:analysis-lock:";
const TEMP_CONTEXT_KEY_PREFIX = "chatgpt-helper:temporary-context:";
const IMPORT_LOCK_KEY = "chatgpt-helper:import-lock";
const IMPORT_LOCK_TTL_MS = 10 * 60 * 1000;
const DEFERRED_ORPHAN_TABS_KEY = "chatgpt-helper:deferred-orphan-tabs";
const MAX_DEFERRED_ORPHAN_TABS = 1000;
const IMPORT_MARKERS = Object.freeze({ settings: "settingsImportOperation", data: "dataImportOperation" });
const OPTIONS_ONLY_MESSAGES = new Set([
  WORKSPACE_MESSAGES.EXPORT_SETTINGS,
  WORKSPACE_MESSAGES.IMPORT_SETTINGS_PREVIEW,
  WORKSPACE_MESSAGES.IMPORT_SETTINGS_APPLY,
  WORKSPACE_MESSAGES.EXPORT_DATA,
  WORKSPACE_MESSAGES.IMPORT_DATA_PREVIEW,
  WORKSPACE_MESSAGES.IMPORT_DATA_APPLY,
]);
const LOCAL_MUTATION_MESSAGES = new Set([
  WORKSPACE_MESSAGES.TEMPLATE_CREATE,
  WORKSPACE_MESSAGES.TEMPLATE_UPDATE,
  WORKSPACE_MESSAGES.TEMPLATE_DELETE,
  WORKSPACE_MESSAGES.TEMPLATE_REORDER,
  WORKSPACE_MESSAGES.RECENT_TEMPLATE_TOUCH,
  WORKSPACE_MESSAGES.SETTINGS_UPDATE,
]);
const WORKSPACE_MUTATION_MESSAGES = new Set([
  WORKSPACE_MESSAGES.GET_CONTEXT,
  WORKSPACE_MESSAGES.REBIND_CONVERSATION,
  WORKSPACE_MESSAGES.ATTACH_GLOSSARY_SENSE,
  WORKSPACE_MESSAGES.MOVE_GLOSSARY_LINK,
  WORKSPACE_MESSAGES.UNLINK_GLOSSARY,
  WORKSPACE_MESSAGES.DELETE_GLOSSARY_SENSE,
  WORKSPACE_MESSAGES.REPLACE_GLOSSARY_SENSE,
  WORKSPACE_MESSAGES.SAVE_SELECTION,
  WORKSPACE_MESSAGES.MOVE_SAVED_LINK,
  WORKSPACE_MESSAGES.UNLINK_SAVED,
  WORKSPACE_MESSAGES.DELETE_SAVED_ITEM,
]);
const activeRequests = new Map();
const normalizationCommandAt = new Map();
let migrationPromise = null;
let workspaceInstance = null;
let contextMenuRegistrationQueue = Promise.resolve();
const contextResolutionQueues = new Map();
let activeImport = null;
const activeUserMutations = new Set();
let localMutationQueue = Promise.resolve();
let pendingLocalMutations = 0;
const deferredOrphanTabIds = new Set();
let deferredOrphanLoadPromise = null;
let deferredOrphanPersistence = Promise.resolve();
let deferredOrphanFlushPromise = null;
let workspaceRecoveryRequired = false;

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
  return workspaceContract.normalizeActiveSettings(value);
}

function normalizeRecentTemplateIds(value) {
  return workspaceContract.normalizeRecentTemplateIds(value);
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
  if (!storageValuesEqual(stored.recentTemplateIds, normalizedRecentTemplateIds)) changes.recentTemplateIds = normalizedRecentTemplateIds;

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

function getWorkspace() {
  if (!workspaceInstance) workspaceInstance = workspaceStoreModule.create();
  return workspaceInstance;
}

async function migrateWorkspace() {
  const workspace = getWorkspace();
  await recoverPendingImports(workspace);
  const legacy = await chrome.storage.local.get(["glossarySchemaVersion", "glossaryEntries"]);
  if (Number.isInteger(legacy.glossarySchemaVersion) && legacy.glossarySchemaVersion > glossaryStore.SCHEMA_VERSION) {
    throw new Error("Unsupported future glossary schema.");
  }
  let migration;
  try {
    migration = await workspace.migrateLegacyGlossary(
      Array.isArray(legacy.glossaryEntries) ? legacy.glossaryEntries : [],
    );
  } catch (error) {
    if (error?.message === "GLOSSARY_INVARIANT_VIOLATION") {
      workspaceRecoveryRequired = true;
    }
    throw error;
  }
  await workspace.initialize();
  return migration;
}

function ensureMigrated() {
  if (!migrationPromise) {
    migrationPromise = migrateWorkspace()
      .then(() => migrateStorage())
      .catch((error) => {
        migrationPromise = null;
        throw error;
      });
  }
  return migrationPromise;
}

function updateOrCreateContextMenu(menu) {
  return new Promise((resolve) => {
    const { id, ...options } = menu;
    chrome.contextMenus.update(id, options, () => {
      const updateError = chrome.runtime.lastError;
      if (!updateError) {
        resolve();
        return;
      }
      chrome.contextMenus.create({ id, ...options }, () => {
        void chrome.runtime.lastError;
        resolve();
      });
    });
  });
}

function registerContextMenu() {
  const operation = contextMenuRegistrationQueue.then(async () => {
    for (const menu of CONTEXT_MENUS) await updateOrCreateContextMenu(menu);
  });
  contextMenuRegistrationQueue = operation.catch(() => {});
  return operation;
}

function contentSender(sender) {
  const url = sender?.tab?.url || sender?.url || "";
  return Number.isInteger(sender?.tab?.id) && contract.isSupportedUrl(url);
}

function optionsSender(sender) {
  let expected;
  try {
    expected = new URL(chrome.runtime.getURL("src/options.html"));
  } catch (_) {
    return false;
  }
  const compatible = (value) => {
    if (typeof value !== "string" || !value) return false;
    try {
      const candidate = new URL(value);
      return candidate.protocol === expected.protocol
        && candidate.host === expected.host
        && candidate.username === ""
        && candidate.password === ""
        && candidate.pathname === expected.pathname
        && candidate.search === ""
        && (candidate.hash === "" || /^#[A-Za-z][A-Za-z0-9_-]*$/.test(candidate.hash));
    } catch (_) {
      return false;
    }
  };
  return compatible(sender?.url) && (!sender?.tab || compatible(sender.tab.url));
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

function temporaryContextKey(tabId) {
  return `${TEMP_CONTEXT_KEY_PREFIX}${tabId}`;
}

async function sessionValue(key) {
  const stored = await chrome.storage.session.get(key);
  return stored[key];
}

async function acquireAnalysisLock(tabId, requestId) {
  if (activeRequests.has(tabId)) return false;
  activeRequests.set(tabId, requestId);
  try {
    const key = sessionLockKey(tabId);
    const current = await sessionValue(key);
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
  const current = await sessionValue(key).catch(() => null);
  if (current?.requestId === requestId) await chrome.storage.session.remove(key).catch(() => {});
}

async function supportedTabs() {
  try {
    const tabs = await chrome.tabs.query({ url: SUPPORTED_PATTERNS });
    return (Array.isArray(tabs) ? tabs : []).filter((tab) => Number.isInteger(tab?.id) && contract.isSupportedUrl(tab.url || ""));
  } catch (_) {
    return [];
  }
}

async function broadcastToSupportedTabs(message) {
  const tabs = await supportedTabs();
  await Promise.all(tabs.map((tab) => chrome.tabs.sendMessage(tab.id, message).catch(() => {})));
}

async function broadcastKeyStatus(configured) {
  return broadcastToSupportedTabs({ type: MESSAGES.KEY_STATUS_CHANGED, configured });
}

async function synchronizeKeyStatusToContentTabs() {
  return broadcastKeyStatus(await secretStore.hasKey());
}

async function broadcastWorkspaceChange(entityFamily, conversationScope, revision) {
  const invalidation = workspaceContract.createInvalidation(entityFamily, conversationScope, revision);
  if (!invalidation) return;
  return broadcastToSupportedTabs({ type: WORKSPACE_MESSAGES.CHANGED, ...invalidation });
}

function importError(code, message) {
  return { code, message: message || "Не удалось выполнить операцию резервного копирования." };
}

function stableWorkspaceError(error, fallbackCode, fallbackMessage) {
  const code = error?.message;
  if (code === "GLOSSARY_INVARIANT_VIOLATION" || code === "GLOSSARY_IMPORT_CONFLICT") {
    return workspaceError(code);
  }
  return workspaceError(fallbackCode || "WORKSPACE_OPERATION_FAILED", fallbackMessage);
}

function stableImportError(error, fallbackCode, fallbackMessage) {
  const code = error?.message;
  if (code === "GLOSSARY_INVARIANT_VIOLATION" || code === "GLOSSARY_IMPORT_CONFLICT") {
    return importError(code);
  }
  return importError(fallbackCode, fallbackMessage || code);
}

function mutationBusyError() {
  return workspaceError(
    workspaceRecoveryRequired ? "RECOVERY_REQUIRED" : "MUTATION_BUSY",
    workspaceRecoveryRequired
      ? "Workspace временно заблокирован до восстановления импорта."
      : "Импорт данных выполняется. Повторите изменение позже.",
  );
}

function beginUserMutation(kind) {
  if (activeImport || workspaceRecoveryRequired) return null;
  const token = { id: contract.createId("mutation"), kind: String(kind || "workspace") };
  activeUserMutations.add(token);
  return token;
}

function endUserMutation(token) {
  activeUserMutations.delete(token);
  if (!activeImport && activeUserMutations.size === 0 && pendingLocalMutations === 0 && deferredOrphanTabIds.size) {
    void flushDeferredOrphans();
  }
}

async function runUserMutation(kind, operation) {
  const token = beginUserMutation(kind);
  if (!token) return { acquired: false, error: mutationBusyError() };
  try {
    return { acquired: true, value: await operation() };
  } finally {
    endUserMutation(token);
  }
}

function runLocalMutation(operation) {
  if (activeImport || workspaceRecoveryRequired) {
    return Promise.resolve({ acquired: false, error: mutationBusyError() });
  }
  pendingLocalMutations += 1;
  const queued = localMutationQueue.then(async () => {
    const token = beginUserMutation("local-storage");
    if (!token) return { acquired: false, error: mutationBusyError() };
    try {
      return { acquired: true, value: await operation() };
    } finally {
      endUserMutation(token);
    }
  });
  const settled = queued.finally(() => {
    pendingLocalMutations -= 1;
    if (!activeImport && activeUserMutations.size === 0 && pendingLocalMutations === 0 && deferredOrphanTabIds.size) {
      void flushDeferredOrphans();
    }
  });
  localMutationQueue = settled.then(() => undefined, () => undefined);
  return settled;
}

async function currentSettings() {
  const stored = await chrome.storage.local.get("settings");
  return normalizeSettings(stored.settings);
}

async function currentDataState() {
  const [workspace, stored] = await Promise.all([
    getWorkspace().snapshotUserData(),
    chrome.storage.local.get(["templates", "recentTemplateIds"]),
  ]);
  return {
    templates: normalizeTemplates(stored.templates),
    recentTemplateIds: normalizeRecentTemplateIds(stored.recentTemplateIds),
    ...workspace,
  };
}

function validTemplateRecord(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  if (!workspaceContract.validEntityId(value.id)
    || typeof value.name !== "string" || !value.name.trim()
    || typeof value.content !== "string" || !value.content.trim()
    || value.content.length > workspaceContract.MAX_TEMPLATE_LENGTH
    || typeof value.autoSend !== "boolean") return null;
  return { id: value.id, name: value.name, content: value.content, autoSend: value.autoSend };
}

async function handleLocalMutation(message) {
  const guarded = await runLocalMutation(async () => {
    if (message.type === WORKSPACE_MESSAGES.SETTINGS_UPDATE) {
      const applied = workspaceContract.applyActiveSettingsPatch(await currentSettings(), message.patch);
      if (!applied.ok) return { ok: false, error: workspaceError("INVALID_SETTINGS_PATCH") };
      const settings = applied.settings;
      await chrome.storage.local.set({ settings });
      return { ok: true, settings };
    }

    const stored = await chrome.storage.local.get(["templates", "recentTemplateIds"]);
    const templates = normalizeTemplates(stored.templates);
    let recentTemplateIds = normalizeRecentTemplateIds(stored.recentTemplateIds)
      .filter((id) => templates.some((template) => template.id === id));

    if (message.type === WORKSPACE_MESSAGES.TEMPLATE_CREATE) {
      const template = validTemplateRecord(message.template);
      if (!template || templates.some((item) => item.id === template.id)) {
        return { ok: false, error: workspaceError("INVALID_TEMPLATE") };
      }
      templates.push(template);
    } else if (message.type === WORKSPACE_MESSAGES.TEMPLATE_UPDATE) {
      const validated = workspaceContract.validateTemplatePatch(message.patch);
      const index = workspaceContract.validEntityId(message.templateId)
        ? templates.findIndex((item) => item.id === message.templateId)
        : -1;
      const template = validated.ok && index >= 0
        ? validTemplateRecord({ ...templates[index], ...validated.patch })
        : null;
      if (!template) return { ok: false, error: workspaceError("INVALID_TEMPLATE_PATCH") };
      templates[index] = template;
    } else if (message.type === WORKSPACE_MESSAGES.TEMPLATE_DELETE) {
      if (!workspaceContract.validEntityId(message.templateId)) {
        return { ok: false, error: workspaceError("INVALID_TEMPLATE") };
      }
      const index = templates.findIndex((item) => item.id === message.templateId);
      if (index < 0) return { ok: false, error: workspaceError("INVALID_TEMPLATE") };
      templates.splice(index, 1);
      recentTemplateIds = recentTemplateIds.filter((id) => id !== message.templateId);
    } else if (message.type === WORKSPACE_MESSAGES.TEMPLATE_REORDER) {
      const ids = Array.isArray(message.templateIds) ? message.templateIds : [];
      if (ids.length !== templates.length || new Set(ids).size !== ids.length
        || ids.some((id) => !workspaceContract.validEntityId(id))
        || ids.some((id) => !templates.some((template) => template.id === id))) {
        return { ok: false, error: workspaceError("INVALID_TEMPLATE_ORDER") };
      }
      const byId = new Map(templates.map((template) => [template.id, template]));
      templates.splice(0, templates.length, ...ids.map((id) => byId.get(id)));
    } else if (message.type === WORKSPACE_MESSAGES.RECENT_TEMPLATE_TOUCH) {
      if (!workspaceContract.validEntityId(message.templateId)
        || !templates.some((template) => template.id === message.templateId)) {
        return { ok: false, error: workspaceError("INVALID_TEMPLATE") };
      }
      recentTemplateIds = normalizeRecentTemplateIds([message.templateId, ...recentTemplateIds]);
    } else {
      return { ok: false, error: workspaceError("INVALID_LOCAL_MUTATION") };
    }

    await chrome.storage.local.set({ templates, recentTemplateIds });
    return { ok: true, templates, recentTemplateIds };
  });
  return guarded.acquired ? guarded.value : { ok: false, error: guarded.error };
}

async function durableImportMarker() {
  const workspace = getWorkspace();
  const [data, settings] = await Promise.all([
    workspace.getMetaValue(IMPORT_MARKERS.data),
    workspace.getMetaValue(IMPORT_MARKERS.settings),
  ]);
  return data ? { kind: "data", marker: data } : (settings ? { kind: "settings", marker: settings } : null);
}

async function acquireImportLock(kind) {
  const operationId = contract.createId("import");
  const startedAt = Date.now();
  const token = { operationId, kind, startedAt, expiresAt: startedAt + IMPORT_LOCK_TTL_MS };
  if (activeImport || activeUserMutations.size || pendingLocalMutations > 0) return null;
  activeImport = token;
  try {
    if (await durableImportMarker()) {
      workspaceRecoveryRequired = true;
      activeImport = null;
      return null;
    }
    const stored = await chrome.storage.session.get(IMPORT_LOCK_KEY);
    const current = stored[IMPORT_LOCK_KEY];
    if (current && Number(current.expiresAt) > Date.now()) {
      activeImport = null;
      return null;
    }
    if (current) await chrome.storage.session.remove(IMPORT_LOCK_KEY).catch(() => {});
    await chrome.storage.session.set({ [IMPORT_LOCK_KEY]: token });
    return token;
  } catch (error) {
    if (activeImport?.operationId === token.operationId) activeImport = null;
    throw error;
  }
}

async function releaseImportLock(token) {
  const stored = await chrome.storage.session.get(IMPORT_LOCK_KEY).catch(() => ({}));
  if (stored[IMPORT_LOCK_KEY]?.operationId === token?.operationId) {
    await chrome.storage.session.remove(IMPORT_LOCK_KEY).catch(() => {});
  }
  if (activeImport?.operationId === token?.operationId) activeImport = null;
  if (activeUserMutations.size === 0 && pendingLocalMutations === 0 && deferredOrphanTabIds.size) {
    void flushDeferredOrphans();
  }
}

async function clearOrphanedImportSessionLock() {
  if (activeImport) return false;
  if (await durableImportMarker()) return false;
  const stored = await chrome.storage.session.get(IMPORT_LOCK_KEY);
  if (!stored[IMPORT_LOCK_KEY]) return false;
  await chrome.storage.session.remove(IMPORT_LOCK_KEY);
  return true;
}

async function rollbackSettingsBackup() {
  const workspace = getWorkspace();
  const backup = await workspace.getImportBackup("settings");
  if (!backup?.payload) throw new Error("SETTINGS_BACKUP_MISSING");
  const settings = normalizeSettings(backup.payload);
  await chrome.storage.local.set({ settings });
  const readBack = await currentSettings();
  if (!storageValuesEqual(settings, readBack)) throw new Error("SETTINGS_ROLLBACK_VERIFICATION_FAILED");
  await workspace.deleteMetaValue(IMPORT_MARKERS.settings);
  workspaceRecoveryRequired = false;
  return true;
}

function assertDataBackupValid(backup) {
  const payload = backup?.payload;
  const workspace = payload?.workspace;
  if (!payload || !workspace || !Array.isArray(payload.templates)
    || !Array.isArray(payload.recentTemplateIds)
    || workspaceStoreModule.USER_STORE_NAMES.some((name) => !Array.isArray(workspace[name]))) {
    throw new Error("DATA_BACKUP_MISSING");
  }
  workspaceStoreModule.assertGlossaryInvariant(workspace);
  if (!storageValuesEqual(payload.templates, normalizeTemplates(payload.templates))
    || !storageValuesEqual(
      payload.recentTemplateIds,
      normalizeRecentTemplateIds(payload.recentTemplateIds),
    )) {
    throw new Error("DATA_BACKUP_INVALID");
  }
  try {
    const portable = importExport.createDataExport(
      { templates: payload.templates, ...workspace },
      {
        datasetId: "00000000-0000-4000-8000-000000000000",
        exportedAt: "2000-01-01T00:00:00.000Z",
      },
    );
    const validated = importExport.validateDataText(portable.text);
    if (!validated.ok) throw new Error(validated.errors[0]?.code || "DATA_BACKUP_INVALID");
  } catch (_) {
    throw new Error("DATA_BACKUP_INVALID");
  }

  const conversationIds = new Set();
  const conversationScopes = new Set();
  workspace.conversations.forEach((conversation) => {
    const descriptor = conversation?.kind === "stable"
      ? workspaceStoreModule.stableDescriptor(conversation)
      : workspaceStoreModule.temporaryDescriptor(
        conversation?.scopeKey,
        conversation?.host,
      );
    if (!descriptor || descriptor.scopeKey !== conversation.scopeKey
      || descriptor.canonicalUrl !== conversation.canonicalUrl
      || conversationIds.has(conversation.id)
      || conversationScopes.has(conversation.scopeKey)) {
      throw new Error("DATA_BACKUP_INVALID");
    }
    conversationIds.add(conversation.id);
    conversationScopes.add(conversation.scopeKey);
  });

  const savedKeys = new Set();
  workspace.savedItems.forEach((item) => {
    const normalizedKey = workspaceContract.normalizeSavedTextKey(item?.text);
    if (!normalizedKey || item.normalizedTextKey !== normalizedKey
      || savedKeys.has(normalizedKey)) {
      throw new Error("DATA_BACKUP_INVALID");
    }
    savedKeys.add(normalizedKey);
  });

  [
    ["glossaryLinks", "senseId"],
    ["savedItemLinks", "itemId"],
  ].forEach(([family, entityField]) => {
    const identities = new Set();
    const orders = new Set();
    workspace[family].forEach((link) => {
      const identity = `${link?.[entityField]}\u001f${link?.conversationId}`;
      const order = `${link?.conversationId}\u001f${link?.localOrder}`;
      if (link?.linkKey !== identity || identities.has(identity) || orders.has(order)) {
        throw new Error("DATA_BACKUP_INVALID");
      }
      identities.add(identity);
      orders.add(order);
    });
  });
  return true;
}

async function rollbackDataBackup(shouldBroadcast) {
  const workspace = getWorkspace();
  const backup = await workspace.getImportBackup("data");
  assertDataBackupValid(backup);
  const restored = await workspace.replaceUserData(backup.payload.workspace);
  await chrome.storage.local.set({
    templates: normalizeTemplates(backup.payload.templates),
    recentTemplateIds: normalizeRecentTemplateIds(backup.payload.recentTemplateIds),
  });
  const readBack = await currentDataState();
  const expected = { templates: normalizeTemplates(backup.payload.templates), ...backup.payload.workspace };
  if (!importExport.canonicalDataEqual(expected, readBack)
    || !storageValuesEqual(
      normalizeRecentTemplateIds(backup.payload.recentTemplateIds),
      readBack.recentTemplateIds,
    )) {
    throw new Error("DATA_ROLLBACK_VERIFICATION_FAILED");
  }
  await workspace.deleteMetaValue(IMPORT_MARKERS.data);
  workspaceRecoveryRequired = false;
  if (shouldBroadcast && restored.changed) {
    await broadcastWorkspaceChange(
      workspaceContract.ENTITY_FAMILIES.ALL,
      null,
      restored.revision,
    );
  }
  return true;
}

async function recoverPendingImports(workspace) {
  if (activeImport) return;
  const recoveryToken = {
    operationId: contract.createId("recovery"),
    kind: "recovery",
    startedAt: Date.now(),
  };
  activeImport = recoveryToken;
  let recovered = false;
  try {
    const dataMarker = await workspace.getMetaValue(IMPORT_MARKERS.data);
    if (dataMarker) {
      try {
        await rollbackDataBackup(true);
      } catch (error) {
        workspaceRecoveryRequired = true;
        throw error;
      }
    }
    const settingsMarker = await workspace.getMetaValue(IMPORT_MARKERS.settings);
    if (settingsMarker) {
      try {
        await rollbackSettingsBackup();
      } catch (error) {
        workspaceRecoveryRequired = true;
        throw error;
      }
    }
    workspaceRecoveryRequired = false;
    recovered = true;
  } finally {
    if (activeImport?.operationId === recoveryToken.operationId) activeImport = null;
  }
  if (recovered) {
    await clearOrphanedImportSessionLock();
    await loadDeferredOrphanTabs();
    await flushDeferredOrphans();
  }
}

async function exportSettings() {
  const result = importExport.createSettingsExport(await currentSettings(), {
    extensionVersion: chrome.runtime.getManifest().version,
  });
  return { ok: true, filename: result.filename, text: result.text };
}

async function previewSettingsImport(message) {
  const validated = importExport.validateSettingsText(message.text);
  if (!validated.ok) return { ok: false, error: importError(validated.errors[0]?.code, "Файл настроек не прошёл проверку."), details: validated.errors };
  const plan = importExport.buildSettingsPlan(await currentSettings(), validated, message.mode);
  return {
    ok: true,
    preview: {
      metadata: { format: validated.envelope.format, schemaVersion: validated.envelope.schemaVersion, exportedAt: validated.envelope.exportedAt },
      ...plan.preview,
      warnings: validated.warnings,
    },
  };
}

async function applySettingsImport(message) {
  const token = await acquireImportLock("settings");
  if (!token) return { ok: false, recoveryRequired: workspaceRecoveryRequired, error: importError("IMPORT_LOCKED", "Другой импорт или восстановление уже выполняется.") };
  let markerCreated = false;
  try {
    const validated = importExport.validateSettingsText(message.text);
    if (!validated.ok) return { ok: false, error: importError(validated.errors[0]?.code, "Файл настроек не прошёл повторную проверку.") };
    const current = await currentSettings();
    const plan = importExport.buildSettingsPlan(current, validated, message.mode);
    await getWorkspace().putImportBackup("settings", current);
    const marker = { operationId: token.operationId, kind: "settings", mode: plan.mode, phase: "prepared", startedAt: token.startedAt };
    await getWorkspace().setMetaValue(IMPORT_MARKERS.settings, marker);
    markerCreated = true;
    await chrome.storage.local.set({ settings: plan.settings });
    const readBack = await currentSettings();
    if (!storageValuesEqual(plan.settings, readBack)) throw new Error("SETTINGS_IMPORT_VERIFICATION_FAILED");
    await getWorkspace().setMetaValue("lastImportAt", Date.now());
    await getWorkspace().deleteMetaValue(IMPORT_MARKERS.settings);
    workspaceRecoveryRequired = false;
    return { ok: true, preview: plan.preview };
  } catch (error) {
    if (!markerCreated) return { ok: false, error: importError("SETTINGS_IMPORT_FAILED", error?.message) };
    try {
      await rollbackSettingsBackup();
      return { ok: false, rolledBack: true, error: importError("SETTINGS_IMPORT_FAILED", "Импорт настроек отменён; исходные настройки восстановлены.") };
    } catch (_) {
      workspaceRecoveryRequired = true;
      return { ok: false, recoveryRequired: true, error: importError("RECOVERY_REQUIRED", "Не удалось восстановить настройки. Повторный импорт заблокирован.") };
    }
  } finally {
    await releaseImportLock(token);
  }
}

async function exportData() {
  const current = await currentDataState();
  const result = importExport.createDataExport(current, {
    datasetId: crypto.randomUUID(),
    extensionVersion: chrome.runtime.getManifest().version,
  });
  return { ok: true, filename: result.filename, text: result.text };
}

async function previewDataImport(message) {
  if (workspaceRecoveryRequired) return { ok: false, recoveryRequired: true, error: importError("RECOVERY_REQUIRED") };
  const validated = importExport.validateDataText(message.text);
  if (!validated.ok) return { ok: false, error: importError(validated.errors[0]?.code, "Файл данных не прошёл проверку."), details: validated.errors };
  let plan;
  try {
    plan = await importExport.buildDataPlan(
      await currentDataState(),
      validated,
      message.mode,
      crypto,
    );
  } catch (error) {
    return { ok: false, error: stableImportError(error, "DATA_IMPORT_FAILED") };
  }
  return {
    ok: true,
    preview: {
      metadata: { format: validated.envelope.format, schemaVersion: validated.envelope.schemaVersion, workspaceSchemaVersion: validated.envelope.workspaceSchemaVersion, datasetId: validated.envelope.datasetId, exportedAt: validated.envelope.exportedAt },
      ...plan.preview,
      warnings: validated.warnings,
    },
  };
}

async function applyDataImport(message) {
  const token = await acquireImportLock("data");
  if (!token) return { ok: false, recoveryRequired: workspaceRecoveryRequired, error: importError("IMPORT_LOCKED", "Другой импорт или восстановление уже выполняется.") };
  let markerCreated = false;
  try {
    const validated = importExport.validateDataText(message.text);
    if (!validated.ok) return { ok: false, error: importError(validated.errors[0]?.code, "Файл данных не прошёл повторную проверку.") };
    const current = await currentDataState();
    const plan = await importExport.buildDataPlan(current, validated, message.mode, crypto);
    await getWorkspace().putImportBackup("data", {
      templates: current.templates,
      recentTemplateIds: current.recentTemplateIds,
      workspace: Object.fromEntries(workspaceStoreModule.USER_STORE_NAMES.map((name) => [name, current[name]])),
    });
    const marker = { operationId: token.operationId, kind: "data", mode: plan.mode, datasetId: validated.envelope.datasetId, phase: "prepared", startedAt: token.startedAt };
    await getWorkspace().setMetaValue(IMPORT_MARKERS.data, marker);
    markerCreated = true;
    const workspaceResult = plan.mode === "replace"
      ? await getWorkspace().replaceUserData(plan.state)
      : await getWorkspace().mergeUserData(plan.state);
    await getWorkspace().setMetaValue(IMPORT_MARKERS.data, { ...marker, phase: "workspace-applied" });
    const localUpdate = { templates: normalizeTemplates(plan.state.templates) };
    if (plan.mode === "replace") localUpdate.recentTemplateIds = [];
    const localChanged = !storageValuesEqual(current.templates, localUpdate.templates)
      || (Object.prototype.hasOwnProperty.call(localUpdate, "recentTemplateIds")
        && !storageValuesEqual(current.recentTemplateIds, localUpdate.recentTemplateIds));
    await chrome.storage.local.set(localUpdate);
    await getWorkspace().setMetaValue(IMPORT_MARKERS.data, { ...marker, phase: "templates-applied" });
    const readBack = await currentDataState();
    const expectedRecentTemplateIds = plan.mode === "replace"
      ? []
      : current.recentTemplateIds;
    if (!importExport.canonicalDataEqual(plan.expectedCanonical, readBack)
      || !storageValuesEqual(expectedRecentTemplateIds, readBack.recentTemplateIds)) {
      throw new Error("DATA_IMPORT_VERIFICATION_FAILED");
    }
    await getWorkspace().setMetaValue("lastImportAt", Date.now());
    await getWorkspace().deleteMetaValue(IMPORT_MARKERS.data);
    workspaceRecoveryRequired = false;
    if (workspaceResult.changed || localChanged) {
      await broadcastWorkspaceChange(
        workspaceContract.ENTITY_FAMILIES.ALL,
        null,
        Math.max(1, Number(workspaceResult.revision || 0)),
      );
    }
    return { ok: true, preview: plan.preview };
  } catch (error) {
    if (!markerCreated) {
      return { ok: false, error: stableImportError(error, "DATA_IMPORT_FAILED") };
    }
    try {
      await rollbackDataBackup(true);
      return { ok: false, rolledBack: true, error: importError("DATA_IMPORT_FAILED", "Импорт данных отменён; исходные данные восстановлены.") };
    } catch (_) {
      workspaceRecoveryRequired = true;
      return { ok: false, recoveryRequired: true, error: importError("RECOVERY_REQUIRED", "Автоматический rollback не завершён. Workspace и импорт заблокированы.") };
    }
  } finally {
    await releaseImportLock(token);
  }
}

function workspaceError(code, message) {
  return { code, message: message || "Не удалось обновить рабочее пространство." };
}

function contextResponse(record) {
  return {
    id: record.id,
    scopeKey: record.scopeKey,
    kind: record.kind,
    host: record.host,
    remoteConversationId: record.remoteConversationId,
    canonicalUrl: record.canonicalUrl,
  };
}

async function resolveConversationContext(pageUrl, sender) {
  if (!contentSender(sender) || !isSupportedAnalysisPageTransition(pageUrl, sender.tab.url || sender.url || "")) {
    throw new Error("UNSUPPORTED_PAGE");
  }
  const tabId = sender.tab.id;
  const stable = conversationContext.extractStableConversation(pageUrl);
  const key = temporaryContextKey(tabId);
  const mapping = await sessionValue(key);
  const workspace = getWorkspace();

  if (stable) {
    if (workspaceContract.isScopeKey(mapping?.scopeKey) && mapping.scopeKey.startsWith("temporary:")) {
      const rebound = await workspace.rebindConversation(mapping.scopeKey, stable);
      await chrome.storage.session.remove(key);
      if (rebound.rebound) {
        await Promise.all([
          broadcastWorkspaceChange(workspaceContract.ENTITY_FAMILIES.CONVERSATIONS, stable.scopeKey, rebound.revision || 1),
          rebound.glossaryLinksMoved ? broadcastWorkspaceChange(workspaceContract.ENTITY_FAMILIES.GLOSSARY, stable.scopeKey, rebound.revision || 1) : null,
          rebound.savedLinksMoved ? broadcastWorkspaceChange(workspaceContract.ENTITY_FAMILIES.SAVED, stable.scopeKey, rebound.revision || 1) : null,
        ]);
      }
      return rebound.context;
    }
    return (await workspace.ensureConversation(stable)).context;
  }

  const host = new URL(pageUrl).hostname.toLocaleLowerCase("en-US");
  let scopeKey = workspaceContract.isScopeKey(mapping?.scopeKey) && mapping.scopeKey.startsWith("temporary:")
    ? mapping.scopeKey
    : null;
  if (!scopeKey) {
    scopeKey = `temporary:${contract.createId("conversation")}`;
    await chrome.storage.session.set({ [key]: { scopeKey, host } });
  }
  return (await workspace.ensureConversation({ kind: "temporary", host, scopeKey })).context;
}

function resolveConversationContextSerialized(pageUrl, sender) {
  const tabId = sender?.tab?.id;
  if (!Number.isInteger(tabId)) return Promise.reject(new Error("UNSUPPORTED_PAGE"));
  const previous = contextResolutionQueues.get(tabId) || Promise.resolve();
  const operation = previous.catch(() => {}).then(() => resolveConversationContext(pageUrl, sender));
  contextResolutionQueues.set(tabId, operation);
  operation.finally(() => {
    if (contextResolutionQueues.get(tabId) === operation) contextResolutionQueues.delete(tabId);
  }).catch(() => {});
  return operation;
}

async function senderOwnsScope(sender, scopeKey) {
  if (!contentSender(sender) || !workspaceContract.isScopeKey(scopeKey)) return false;
  if (scopeKey.startsWith("stable:")) {
    return conversationContext.extractStableConversation(sender.tab.url || sender.url || "")?.scopeKey === scopeKey;
  }
  const mapping = await sessionValue(temporaryContextKey(sender.tab.id));
  return mapping?.scopeKey === scopeKey;
}

async function mergeAnalysisTerms(terms, conversationScope) {
  try {
    const guarded = await runUserMutation("analysis-persistence", async () => {
      const merged = await getWorkspace().addAnalysisTerms(terms, conversationScope);
      if (merged.changed) {
        await broadcastWorkspaceChange(workspaceContract.ENTITY_FAMILIES.GLOSSARY, conversationScope, merged.revision);
      }
      return { results: merged.results, storageWarning: false, mutationBusy: false };
    });
    if (!guarded.acquired) {
      return {
        results: terms.map((term) => ({ ...term, status: "unsaved" })),
        storageWarning: true,
        mutationBusy: true,
      };
    }
    return guarded.value;
  } catch (error) {
    if (error?.message === "GLOSSARY_INVARIANT_VIOLATION") throw error;
    return {
      results: terms.map((term) => ({ ...term, status: "unsaved" })),
      storageWarning: true,
      mutationBusy: false,
    };
  }
}

async function handleAnalysis(message, sender, workspaceAvailable) {
  const tabId = sender.tab.id;
  const snapshot = message?.snapshot;
  const senderUrl = sender?.tab?.url || sender?.url || "";
  if (!snapshot || !validRequestId(snapshot.requestId)
    || !["browser-command", "context-menu", "inline-assistant"].includes(snapshot.trigger)
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
    let context = null;
    let workspaceUnavailable = workspaceAvailable === false;
    let mutationBusy = false;
    if (!workspaceUnavailable) {
      try {
        const guardedContext = await runUserMutation(
          "analysis-context",
          () => resolveConversationContextSerialized(snapshot.pageUrl, sender),
        );
        if (guardedContext.acquired) context = guardedContext.value;
        else mutationBusy = true;
      } catch (_) {
        workspaceUnavailable = true;
      }
    }
    const apiKey = await secretStore.getKey();
    if (!apiKey) return contract.errorEnvelope(snapshot.requestId, "API_KEY_MISSING");
    const analyzed = await openRouterClient.analyze(selection.text, apiKey);
    if (!analyzed.ok) return { ok: false, requestId: snapshot.requestId, error: analyzed.error };
    const glossary = context
      ? await mergeAnalysisTerms(analyzed.terms, context.scopeKey)
      : { results: analyzed.terms.map((term) => ({ ...term, status: "unsaved" })), storageWarning: true };
    return {
      ok: true,
      requestId: snapshot.requestId,
      terms: glossary.results,
      storageWarning: glossary.storageWarning,
      workspaceUnavailable: workspaceUnavailable || glossary.storageWarning,
      mutationBusy: mutationBusy || glossary.mutationBusy === true,
    };
  } catch (error) {
    if (error?.message === "GLOSSARY_INVARIANT_VIOLATION") {
      return {
        ok: false,
        requestId: snapshot.requestId,
        error: workspaceError("GLOSSARY_INVARIANT_VIOLATION"),
      };
    }
    return contract.errorEnvelope(snapshot.requestId, "PROVIDER_ERROR");
  } finally {
    await releaseAnalysisLock(tabId, snapshot.requestId);
  }
}

async function mutateAndBroadcast(operation, family, scope) {
  const response = await operation();
  if (response?.changed) await broadcastWorkspaceChange(family, scope, response.revision);
  return { ok: true, ...response };
}

async function handleWorkspaceMessage(message, sender) {
  if (message.type === WORKSPACE_MESSAGES.GET_CONTEXT) {
    if (typeof message.pageUrl !== "string") return { ok: false, error: workspaceError("INVALID_CONTEXT") };
    const context = await resolveConversationContextSerialized(message.pageUrl, sender);
    return { ok: true, context: contextResponse(context) };
  }

  if (message.type === WORKSPACE_MESSAGES.REBIND_CONVERSATION) {
    const stable = conversationContext.extractStableConversation(message.pageUrl);
    const key = temporaryContextKey(sender.tab.id);
    const mapping = await sessionValue(key);
    if (!stable || mapping?.scopeKey !== message.temporaryScope
      || !workspaceContract.isScopeKey(message.temporaryScope)
      || conversationContext.extractStableConversation(sender.tab.url || sender.url || "")?.scopeKey !== stable.scopeKey) {
      return { ok: false, error: workspaceError("INVALID_REBIND") };
    }
    const rebound = await getWorkspace().rebindConversation(message.temporaryScope, stable);
    await chrome.storage.session.remove(key);
    if (rebound.rebound) {
      await Promise.all([
        broadcastWorkspaceChange(workspaceContract.ENTITY_FAMILIES.CONVERSATIONS, stable.scopeKey, rebound.revision || 1),
        rebound.glossaryLinksMoved ? broadcastWorkspaceChange(workspaceContract.ENTITY_FAMILIES.GLOSSARY, stable.scopeKey, rebound.revision || 1) : null,
        rebound.savedLinksMoved ? broadcastWorkspaceChange(workspaceContract.ENTITY_FAMILIES.SAVED, stable.scopeKey, rebound.revision || 1) : null,
      ]);
    }
    return { ok: true, context: contextResponse(rebound.context), rebound: rebound.rebound };
  }

  if (!await senderOwnsScope(sender, message.conversationScope)) {
    return { ok: false, error: workspaceError("INVALID_CONVERSATION_SCOPE") };
  }
  const scope = message.conversationScope;
  const workspace = getWorkspace();

  if (message.type === WORKSPACE_MESSAGES.QUERY_GLOSSARY) {
    if (typeof message.query !== "string" || !["local", "global"].includes(message.mode)) {
      return { ok: false, error: workspaceError("INVALID_QUERY") };
    }
    return { ok: true, entries: await workspace.queryGlossary({
      conversationScope: scope,
      mode: message.mode,
      query: message.query,
      limit: workspaceContract.boundedLimit(message.limit),
    }) };
  }
  if (message.type === WORKSPACE_MESSAGES.LOOKUP_GLOSSARY_SELECTION) {
    const selection = workspaceContract.validateInlineSelectionText(message.text);
    if (!selection.ok) {
      return { ok: false, error: workspaceError(selection.error || "INVALID_GLOSSARY_SELECTION") };
    }
    const result = await workspace.lookupGlossarySelection({
      conversationScope: scope,
      text: selection.text,
    });
    return { ok: true, ...result };
  }
  if (message.type === WORKSPACE_MESSAGES.ATTACH_GLOSSARY_SENSE && workspaceContract.validEntityId(message.senseId)) {
    return mutateAndBroadcast(
      () => workspace.attachGlossarySense(message.senseId, scope),
      workspaceContract.ENTITY_FAMILIES.GLOSSARY,
      scope,
    );
  }
  if (message.type === WORKSPACE_MESSAGES.MOVE_GLOSSARY_LINK
    && workspaceContract.validEntityId(message.senseId)
    && (message.beforeSenseId === null || workspaceContract.validEntityId(message.beforeSenseId))) {
    return mutateAndBroadcast(
      () => workspace.moveGlossaryLink(message.senseId, message.beforeSenseId, scope),
      workspaceContract.ENTITY_FAMILIES.GLOSSARY,
      scope,
    );
  }
  if (message.type === WORKSPACE_MESSAGES.UNLINK_GLOSSARY && workspaceContract.validEntityId(message.senseId)) {
    return mutateAndBroadcast(
      () => workspace.unlinkGlossary(message.senseId, scope),
      workspaceContract.ENTITY_FAMILIES.GLOSSARY,
      scope,
    );
  }
  if (message.type === WORKSPACE_MESSAGES.DELETE_GLOSSARY_SENSE && workspaceContract.validEntityId(message.senseId)) {
    return mutateAndBroadcast(
      () => workspace.deleteGlossarySense(message.senseId),
      workspaceContract.ENTITY_FAMILIES.GLOSSARY,
      null,
    );
  }
  if (message.type === WORKSPACE_MESSAGES.REPLACE_GLOSSARY_SENSE) {
    const commandKeys = message.command && typeof message.command === "object"
      ? Object.keys(message.command).sort()
      : [];
    const replacementKeys = message.command?.replacement
      && typeof message.command.replacement === "object"
      ? Object.keys(message.command.replacement).sort()
      : [];
    if (JSON.stringify(commandKeys) !== JSON.stringify([
      "expectedUpdatedAt",
      "replacement",
      "senseId",
    ])
      || JSON.stringify(replacementKeys) !== JSON.stringify(["definition", "translation"])
      || !workspaceContract.validEntityId(message.command?.senseId)
      || !Number.isFinite(message.command?.expectedUpdatedAt)
      || !workspaceContract.normalizeMeaning(message.command?.replacement?.translation, 200)
      || !workspaceContract.normalizeMeaning(message.command?.replacement?.definition, 500)) {
      return { ok: false, error: contract.makeError("REQUEST_CONTRACT_ERROR") };
    }
    const result = await workspace.replaceGlossarySense(message.command, scope);
    if (!result.ok && result.stale) {
      return { ok: false, error: contract.makeError("GLOSSARY_ENTRY_CHANGED"), current: result.current };
    }
    if (result.ok && result.changed) {
      await broadcastWorkspaceChange(
        workspaceContract.ENTITY_FAMILIES.GLOSSARY,
        scope,
        result.revision,
      );
    }
    return result;
  }
  if (message.type === WORKSPACE_MESSAGES.SAVE_SELECTION) {
    const validated = workspaceContract.validateSavedText(message.text);
    if (!validated.ok) return { ok: false, error: workspaceError(validated.error) };
    return mutateAndBroadcast(
      () => workspace.saveSelection(message.text, scope),
      workspaceContract.ENTITY_FAMILIES.SAVED,
      scope,
    );
  }
  if (message.type === WORKSPACE_MESSAGES.QUERY_SAVED) {
    if (typeof message.query !== "string" || !["local", "global"].includes(message.mode)) {
      return { ok: false, error: workspaceError("INVALID_QUERY") };
    }
    return { ok: true, entries: await workspace.querySaved({
      conversationScope: scope,
      mode: message.mode,
      query: message.query,
      limit: workspaceContract.boundedLimit(message.limit),
    }) };
  }
  if (message.type === WORKSPACE_MESSAGES.MOVE_SAVED_LINK
    && workspaceContract.validEntityId(message.itemId)
    && (message.beforeItemId === null || workspaceContract.validEntityId(message.beforeItemId))) {
    return mutateAndBroadcast(
      () => workspace.moveSavedLink(message.itemId, message.beforeItemId, scope),
      workspaceContract.ENTITY_FAMILIES.SAVED,
      scope,
    );
  }
  if (message.type === WORKSPACE_MESSAGES.UNLINK_SAVED && workspaceContract.validEntityId(message.itemId)) {
    return mutateAndBroadcast(
      () => workspace.unlinkSaved(message.itemId, scope),
      workspaceContract.ENTITY_FAMILIES.SAVED,
      scope,
    );
  }
  if (message.type === WORKSPACE_MESSAGES.DELETE_SAVED_ITEM && workspaceContract.validEntityId(message.itemId)) {
    return mutateAndBroadcast(
      () => workspace.deleteSavedItem(message.itemId),
      workspaceContract.ENTITY_FAMILIES.SAVED,
      null,
    );
  }
  return { ok: false, error: workspaceError("INVALID_WORKSPACE_MESSAGE") };
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
    if (message.type === WORKSPACE_MESSAGES.EXPORT_SETTINGS) return exportSettings();
    if (message.type === WORKSPACE_MESSAGES.IMPORT_SETTINGS_PREVIEW) return previewSettingsImport(message);
    if ([WORKSPACE_MESSAGES.IMPORT_SETTINGS_APPLY, WORKSPACE_MESSAGES.EXPORT_DATA,
      WORKSPACE_MESSAGES.IMPORT_DATA_PREVIEW, WORKSPACE_MESSAGES.IMPORT_DATA_APPLY].includes(message.type)) {
      try {
        await ensureMigrated();
      } catch (_) {
        return { ok: false, recoveryRequired: workspaceRecoveryRequired, error: importError("WORKSPACE_UNAVAILABLE", "Workspace недоступен; операция не выполнена.") };
      }
      if (activeImport && [WORKSPACE_MESSAGES.EXPORT_DATA, WORKSPACE_MESSAGES.IMPORT_DATA_PREVIEW].includes(message.type)) {
        return { ok: false, error: importError("IMPORT_LOCKED", "Импорт выполняется. Повторите операцию позже.") };
      }
      if (message.type === WORKSPACE_MESSAGES.IMPORT_SETTINGS_APPLY) return applySettingsImport(message);
      if (message.type === WORKSPACE_MESSAGES.EXPORT_DATA) return exportData();
      if (message.type === WORKSPACE_MESSAGES.IMPORT_DATA_PREVIEW) return previewDataImport(message);
      if (message.type === WORKSPACE_MESSAGES.IMPORT_DATA_APPLY) return applyDataImport(message);
    }
    return { ok: false, error: contract.makeError("REQUEST_FORBIDDEN") };
  }

  if (OPTIONS_ONLY_MESSAGES.has(message.type)) {
    return { ok: false, error: contract.makeError("REQUEST_FORBIDDEN") };
  }

  if (!contentSender(sender)) return { ok: false, error: contract.makeError("REQUEST_FORBIDDEN") };
  if (message.type === MESSAGES.OPEN_OPTIONS) {
    if (message.section === "backup") {
      await chrome.tabs.create({ url: chrome.runtime.getURL("src/options.html#backup") });
    } else {
      await chrome.runtime.openOptionsPage();
    }
    return { ok: true };
  }
  if (LOCAL_MUTATION_MESSAGES.has(message.type)) {
    try {
      await ensureMigrated();
    } catch (_) {
      try {
        if (await durableImportMarker()) workspaceRecoveryRequired = true;
      } catch (_) {}
      if (workspaceRecoveryRequired) return { ok: false, error: mutationBusyError() };
    }
    return handleLocalMutation(message);
  }
  if (workspaceRecoveryRequired) {
    return { ok: false, error: workspaceError("RECOVERY_REQUIRED", "Workspace временно заблокирован до восстановления импорта.") };
  }
  let workspaceAvailable = true;
  try {
    await ensureMigrated();
  } catch (error) {
    workspaceAvailable = false;
    if (message.type !== MESSAGES.ANALYZE_SELECTED_TERMS) {
      return {
        ok: false,
        error: stableWorkspaceError(
          error,
          "WORKSPACE_MIGRATION_FAILED",
          "Не удалось подготовить рабочее пространство. Данные словаря V1 не изменены.",
        ),
      };
    }
  }
  if (message.type === MESSAGES.ANALYZE_SELECTED_TERMS) return handleAnalysis(message, sender, workspaceAvailable);
  if (Object.values(WORKSPACE_MESSAGES).includes(message.type)
    && ![WORKSPACE_MESSAGES.CHANGED, WORKSPACE_MESSAGES.CONTEXT_MENU_SAVE_SELECTION,
      WORKSPACE_MESSAGES.CONTEXT_MENU_NORMALIZE_COMPOSER].includes(message.type)) {
    try {
      if (WORKSPACE_MUTATION_MESSAGES.has(message.type)) {
        const guarded = await runUserMutation("workspace", () => handleWorkspaceMessage(message, sender));
        return guarded.acquired ? guarded.value : { ok: false, error: guarded.error };
      }
      return await handleWorkspaceMessage(message, sender);
    } catch (error) {
      return { ok: false, error: stableWorkspaceError(error) };
    }
  }
  return { ok: false, error: contract.makeError("REQUEST_FORBIDDEN") };
}

function supportedCommandTab(tab) {
  return Number.isInteger(tab?.id) && contract.isSupportedUrl(tab.url || "");
}

async function commandTargetTab(eventTab) {
  if (supportedCommandTab(eventTab)) return eventTab;
  const tabs = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  const activeTab = Array.isArray(tabs) ? tabs[0] : null;
  return supportedCommandTab(activeTab) ? activeTab : null;
}

async function routeBrowserCommand(commandId, eventTab) {
  const command = commandRegistry.COMMAND_BY_ID[commandId];
  if (!command) return false;
  const tab = await commandTargetTab(eventTab);
  if (!tab) return false;
  if (command.id === commandRegistry.COMMANDS.normalizeComposer.id) {
    const previous = normalizationCommandAt.get(tab.id) || 0;
    const current = Date.now();
    if (current - previous < 400) return false;
    normalizationCommandAt.set(tab.id, current);
  }
  try {
    await chrome.tabs.sendMessage(tab.id, { type: command.messageType });
    return true;
  } catch (_) {
    return false;
  }
}

chrome.commands.onCommand.addListener((commandId, tab) => {
  void routeBrowserCommand(commandId, tab);
});

chrome.runtime.onInstalled.addListener(() => {
  void Promise.all([ensureMigrated(), registerContextMenu(), synchronizeKeyStatusToContentTabs()]).catch(() => {});
});

chrome.runtime.onStartup.addListener(() => {
  void Promise.all([ensureMigrated(), registerContextMenu(), synchronizeKeyStatusToContentTabs()]).catch(() => {});
});

chrome.action.onClicked.addListener((tab) => {
  if (!tab.id || !contract.isSupportedUrl(tab.url || "")) return;
  void chrome.tabs.sendMessage(tab.id, { type: MESSAGES.TOGGLE_PANEL }).catch(() => {});
});

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (!tab?.id || !contract.isSupportedUrl(tab.url || "")) return;
  if (info.menuItemId === commandRegistry.COMMANDS.analyzeSelection.contextMenuId) {
    void chrome.tabs.sendMessage(tab.id, {
      type: MESSAGES.CONTEXT_MENU_SELECTION,
      selectionText: typeof info.selectionText === "string" ? info.selectionText : "",
      pageUrl: tab.url,
    }).catch(() => {});
  } else if (info.menuItemId === commandRegistry.COMMANDS.saveSelection.contextMenuId) {
    void chrome.tabs.sendMessage(tab.id, {
      type: WORKSPACE_MESSAGES.CONTEXT_MENU_SAVE_SELECTION,
      selectionText: typeof info.selectionText === "string" ? info.selectionText : "",
      pageUrl: tab.url,
    }).catch(() => {});
  } else if (info.menuItemId === commandRegistry.COMMANDS.normalizeComposer.contextMenuId) {
    void chrome.tabs.sendMessage(tab.id, {
      type: WORKSPACE_MESSAGES.CONTEXT_MENU_NORMALIZE_COMPOSER,
      pageUrl: tab.url,
    }).catch(() => {});
  }
});

function normalizeDeferredOrphanTabIds(value) {
  const result = [];
  for (const tabId of Array.isArray(value) ? value : []) {
    if (!Number.isInteger(tabId) || tabId < 0 || result.includes(tabId)) continue;
    result.push(tabId);
    if (result.length === MAX_DEFERRED_ORPHAN_TABS) break;
  }
  return result;
}

function persistDeferredOrphanTabs() {
  const operation = deferredOrphanPersistence.then(async () => {
    const tabIds = normalizeDeferredOrphanTabIds([...deferredOrphanTabIds]);
    if (tabIds.length) await chrome.storage.session.set({ [DEFERRED_ORPHAN_TABS_KEY]: tabIds });
    else await chrome.storage.session.remove(DEFERRED_ORPHAN_TABS_KEY);
  });
  deferredOrphanPersistence = operation.then(() => undefined, () => undefined);
  return operation;
}

function loadDeferredOrphanTabs() {
  if (!deferredOrphanLoadPromise) {
    deferredOrphanLoadPromise = chrome.storage.session.get(DEFERRED_ORPHAN_TABS_KEY).then(async (stored) => {
      const raw = stored[DEFERRED_ORPHAN_TABS_KEY];
      const normalized = normalizeDeferredOrphanTabIds(raw);
      normalized.forEach((tabId) => deferredOrphanTabIds.add(tabId));
      if (!storageValuesEqual(raw, normalized)) await persistDeferredOrphanTabs();
    }).catch((error) => {
      deferredOrphanLoadPromise = null;
      throw error;
    });
  }
  return deferredOrphanLoadPromise;
}

async function deferOrphanTab(tabId, flushWhenAvailable) {
  if (!Number.isInteger(tabId) || tabId < 0) return;
  await loadDeferredOrphanTabs();
  if (!deferredOrphanTabIds.has(tabId) && deferredOrphanTabIds.size >= MAX_DEFERRED_ORPHAN_TABS) {
    deferredOrphanTabIds.delete(deferredOrphanTabIds.values().next().value);
  }
  deferredOrphanTabIds.add(tabId);
  await persistDeferredOrphanTabs();
  if (flushWhenAvailable && !activeImport && activeUserMutations.size === 0
    && pendingLocalMutations === 0 && !workspaceRecoveryRequired) {
    void flushDeferredOrphans();
  }
}

async function completeDeferredOrphanTab(tabId) {
  if (!deferredOrphanTabIds.delete(tabId)) return;
  await persistDeferredOrphanTabs();
}

async function orphanRemovedTab(tabId) {
  try {
    const guarded = await runUserMutation("orphan", async () => {
      const key = temporaryContextKey(tabId);
      const mapping = await sessionValue(key);
      if (!workspaceContract.isScopeKey(mapping?.scopeKey) || !mapping.scopeKey.startsWith("temporary:")) {
        await chrome.storage.session.remove(key).catch(() => {});
        return;
      }
      const result = await getWorkspace().orphanConversation(mapping.scopeKey);
      await chrome.storage.session.remove(key);
      if (result.orphaned) {
        await broadcastWorkspaceChange(workspaceContract.ENTITY_FAMILIES.CONVERSATIONS, mapping.scopeKey, result.revision);
      }
    });
    if (!guarded.acquired) {
      await deferOrphanTab(tabId, true);
      return false;
    }
    await completeDeferredOrphanTab(tabId);
    return true;
  } catch (_) {
    await deferOrphanTab(tabId, false);
    return false;
  }
}

function flushDeferredOrphans() {
  if (deferredOrphanFlushPromise) return deferredOrphanFlushPromise;
  if (activeImport || activeUserMutations.size || pendingLocalMutations > 0 || workspaceRecoveryRequired) {
    return Promise.resolve(false);
  }
  const operation = (async () => {
    await loadDeferredOrphanTabs();
    for (const tabId of [...deferredOrphanTabIds]) {
      if (activeImport || activeUserMutations.size || pendingLocalMutations > 0 || workspaceRecoveryRequired) break;
      await orphanRemovedTab(tabId);
    }
    return deferredOrphanTabIds.size === 0;
  })();
  deferredOrphanFlushPromise = operation.finally(() => { deferredOrphanFlushPromise = null; });
  return deferredOrphanFlushPromise;
}

chrome.tabs.onRemoved.addListener((tabId) => {
  normalizationCommandAt.delete(tabId);
  void orphanRemovedTab(tabId).catch(() => {});
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const allowed = new Set([...Object.values(MESSAGES), ...Object.values(WORKSPACE_MESSAGES)]);
  if (!message || !allowed.has(message.type)) return false;
  void handleMessage(message, sender)
    .then(sendResponse)
    .catch(() => sendResponse({ ok: false, error: contract.makeError("PROVIDER_ERROR") }));
  return true;
});

void ensureMigrated().catch(() => {});
