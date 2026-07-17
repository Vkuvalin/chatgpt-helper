"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const contract = require("../src/analysis-contract.js");
const glossary = require("../src/glossary-store.js");
const secretStore = require("../src/secret-store.js");
const openRouter = require("../src/openrouter-client.js");
require("../src/analysis-controller.js");
require("../src/analysis-ui.js");

const analysisController = globalThis.ChatGPTHelperAnalysisController;
const analysisUi = globalThis.ChatGPTHelperAnalysisUi;
const serviceWorkerSource = fs.readFileSync(path.join(__dirname, "../src/service-worker.js"), "utf8");

function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function validStorage(overrides) {
  return {
    templates: [{ id: "template-1", name: "Template", content: "Content", autoSend: true }],
    settings: {
      theme: "system",
      wallpaperDataUrl: null,
      closePanelAfterRun: true,
      recentTemplatesHoverEnabled: true,
      analysis: {
        shortcut: { ...contract.DEFAULT_SHORTCUT },
        termColorMode: "theme",
        customTermColor: "#69d6c5",
        glossaryTextSize: "normal",
      },
    },
    recentTemplateIds: ["template-1"],
    glossarySchemaVersion: 1,
    glossaryEntries: [],
    ...(overrides || {}),
  };
}

function createServiceWorkerHarness(initialStorage, harnessOptions) {
  const options = harnessOptions || {};
  const storage = clone(initialStorage);
  const setCalls = [];
  const removeCalls = [];
  const contextMenuCalls = [];
  const tabQueryCalls = [];
  const tabMessages = [];
  const listeners = {};
  let keyConfigured = options.keyConfigured === true;
  const secretStoreHarness = {
    async getKey() { return keyConfigured ? "configured-test-key-value" : null; },
    async hasKey() { return keyConfigured; },
    async setKey() {
      if (options.setKeyError) throw options.setKeyError;
      const response = clone(options.setKeyResponse || { ok: true });
      if (response?.ok) keyConfigured = true;
      return response;
    },
    async deleteKey() {
      if (options.deleteKeyError) throw options.deleteKeyError;
      const response = clone(options.deleteKeyResponse || { ok: true });
      if (response?.ok) keyConfigured = false;
      return response;
    },
  };
  const chrome = {
    storage: {
      local: {
        async get(keys) {
          const names = Array.isArray(keys) ? keys : [keys];
          return Object.fromEntries(names.filter((key) => Object.prototype.hasOwnProperty.call(storage, key))
            .map((key) => [key, clone(storage[key])]));
        },
        async set(changes) {
          const copied = clone(changes);
          setCalls.push(copied);
          Object.assign(storage, copied);
        },
        async remove(keys) {
          const names = Array.isArray(keys) ? keys : [keys];
          removeCalls.push(...names);
          names.forEach((key) => { delete storage[key]; });
        },
      },
      session: {
        async get() { return {}; },
        async set() {},
        async remove() {},
      },
    },
    runtime: {
      lastError: null,
      getURL(value) { return `chrome-extension://test/${value}`; },
      async openOptionsPage() {},
      onInstalled: { addListener(listener) { listeners.onInstalled = listener; } },
      onStartup: { addListener(listener) { listeners.onStartup = listener; } },
      onMessage: { addListener(listener) { listeners.onMessage = listener; } },
    },
    action: { onClicked: { addListener(listener) { listeners.onAction = listener; } } },
    contextMenus: {
      update(id, options, callback) {
        contextMenuCalls.push({ operation: "update", id, options: clone(options) });
        callback();
      },
      create(options, callback) {
        contextMenuCalls.push({ operation: "create", id: options.id, options: clone(options) });
        callback();
      },
      onClicked: { addListener(listener) { listeners.onContextMenu = listener; } },
    },
    tabs: {
      async query(queryInfo) {
        tabQueryCalls.push(clone(queryInfo));
        if (options.tabQueryError) throw options.tabQueryError;
        return clone(options.tabs || []);
      },
      async sendMessage(tabId, message) {
        tabMessages.push({ tabId, message: clone(message) });
        if ((options.failingTabIds || []).includes(tabId)) throw new Error("No receiving end.");
      },
    },
  };
  const context = vm.createContext({
    console,
    URL,
    crypto: { randomUUID: () => "00000000-0000-4000-8000-000000000000" },
    importScripts() {},
    chrome,
    ChatGPTHelperAnalysisContract: contract,
    ChatGPTHelperGlossaryStore: { SCHEMA_VERSION: glossary.SCHEMA_VERSION },
    ChatGPTHelperSecretStore: secretStoreHarness,
    ChatGPTHelperOpenRouterClient: {},
  });
  vm.runInContext(serviceWorkerSource, context, { filename: "service-worker.js" });
  return {
    storage,
    setCalls,
    removeCalls,
    contextMenuCalls,
    tabQueryCalls,
    tabMessages,
    async waitForMigration() { await vm.runInContext("ensureMigrated()", context); },
    async runStartup() {
      listeners.onStartup();
      await vm.runInContext("contextMenuRegistrationQueue", context);
    },
    async handleMessage(message, sender) {
      context.__testMessage = clone(message);
      context.__testSender = clone(sender);
      return clone(await vm.runInContext("handleMessage(__testMessage, __testSender)", context));
    },
    evaluate(expression) { return vm.runInContext(expression, context); },
  };
}

function fakeElement(selectorFragment) {
  return {
    closest(selector) {
      return selector.includes(selectorFragment) ? this : null;
    },
  };
}

function entry(overrides) {
  return {
    id: "term-1",
    term: "source of truth",
    normalizedTerm: "source of truth",
    translation: "источник истины",
    definition: "Единственный авторитетный источник данных.",
    createdAt: 100,
    updatedAt: 100,
    ...overrides,
  };
}

assert.equal(
  contract.normalizeSelection(" \r\nFirst\u00a0line\r\n\r\nSecond\u200b line\r\n "),
  "First line\n\nSecond line",
);
assert.equal(contract.validateSelection(" ").error.code, "EMPTY_SELECTION");
assert.equal(contract.validateSelection("x".repeat(20001)).error.code, "SELECTION_TOO_LARGE");
assert.equal(contract.normalizeSelection("ＡＰＩ"), "ＡＰＩ");
assert.equal(contract.normalizeTerm(" **‘LIVE / REPLAY’** "), "live/replay");
assert.equal(contract.normalizeTerm("GPT–4.1"), "gpt-4.1");
assert.equal(contract.validateShortcutCandidate({ code: "KeyA", ctrl: false, shift: false, alt: false, meta: false }).ok, false);
assert.equal(contract.validateShortcutCandidate({ code: "KeyR", ctrl: true, shift: false, alt: false, meta: false }).ok, false);
assert.equal(contract.validateShortcutCandidate({ code: "KeyK", ctrl: true, shift: true, alt: false, meta: false }).ok, true);

const retargetedHost = fakeElement("not-a-text-entry");
["input", "textarea", "select", "[contenteditable='true']", "[contenteditable='']", "[role='textbox']"]
  .forEach((selectorFragment) => {
    assert.equal(analysisController.isTextEntryEvent({
      target: retargetedHost,
      composedPath: () => [fakeElement(selectorFragment), retargetedHost],
    }), true);
  });
assert.equal(analysisController.isTextEntryEvent({ target: fakeElement("textarea") }), true);
assert.equal(analysisController.isTextEntryEvent({
  target: retargetedHost,
  composedPath: () => [retargetedHost],
}), false);

assert.equal(analysisUi.glossaryTextSizeClass("analysis-result-list", { analysis: { glossaryTextSize: "compact" } }), "analysis-result-list size-compact");
assert.equal(analysisUi.glossaryTextSizeClass("analysis-result-list", { analysis: { glossaryTextSize: "normal" } }), "analysis-result-list size-normal");
assert.equal(analysisUi.glossaryTextSizeClass("analysis-result-list", { analysis: { glossaryTextSize: "large" } }), "analysis-result-list size-large");
assert.equal(analysisUi.nextFocusableIndex(0, 3, true), 2);
assert.equal(analysisUi.nextFocusableIndex(2, 3, false), 0);
assert.equal(analysisUi.nextFocusableIndex(-1, 3, false), 0);
assert.equal(analysisUi.nextFocusableIndex(-1, 3, true), 2);
assert.equal(analysisUi.nextFocusableIndex(0, 0, false), -1);

assert.equal(
  contract.MESSAGE_TYPES.KEY_STATUS_CHANGED,
  "chatgpt-helper:openrouter-key-status-changed",
);
const analysisStyles = analysisUi.styles();
assert.match(analysisStyles, /\.analysis-replace \{[^}]*display: inline-flex;[^}]*padding: 0;[^}]*align-items: center;[^}]*justify-content: center;[^}]*line-height: 0;/);
assert.match(analysisStyles, /\.analysis-replace svg \{[^}]*display: block;[^}]*width: 16px;[^}]*height: 16px;/);

const validated = contract.validateTermsPayload({
  terms: [
    { term: "source of truth", translation: "источник истины", definition: "Единый авторитетный источник" },
    { term: "SOURCE OF TRUTH", translation: "дубликат", definition: "Будет удалён" },
    { term: "absent term", translation: "нет", definition: "Нет в исходном тексте" },
    { term: "123", translation: "число", definition: "Не английский термин" },
  ],
}, "Use **source of truth** for configuration.");
assert.equal(validated.ok, true);
assert.equal(validated.terms.length, 1);
assert.equal(validated.terms[0].definition, "Единый авторитетный источник.");
assert.equal(contract.validateTermsPayload({ terms: [], commentary: "unexpected" }, "text").ok, false);

const initialMerge = glossary.mergeEntries([], [
  validated.terms[0],
  { ...validated.terms[0], translation: "поздний дубликат" },
], 200);
assert.equal(initialMerge.entries.length, 1);
assert.equal(initialMerge.results.length, 1);
assert.equal(initialMerge.results[0].status, "new");

const exactMerge = glossary.mergeEntries([entry({
  translation: validated.terms[0].translation,
  definition: validated.terms[0].definition,
  updatedAt: 101,
})], [validated.terms[0]], 300);
assert.equal(exactMerge.results[0].status, "alreadySaved");
assert.equal(exactMerge.entries[0].updatedAt, 101);

const duplicateMerge = glossary.mergeEntries([entry()], [{
  ...validated.terms[0],
  translation: "первоисточник",
}], 300);
assert.equal(duplicateMerge.results[0].status, "duplicate");
assert.equal(duplicateMerge.entries[0].translation, "источник истины");

const replacement = glossary.replaceEntry([entry(), entry({ id: "term-2", term: "API", normalizedTerm: "api" })], {
  entryId: "term-1",
  expectedUpdatedAt: 100,
  replacement: {
    term: "source of truth",
    normalizedTerm: "source of truth",
    translation: "первоисточник",
    definition: "Авторитетная версия данных.",
  },
}, 400);
assert.equal(replacement.ok, true);
assert.equal(replacement.entry.id, "term-1");
assert.equal(replacement.entry.createdAt, 100);
assert.equal(replacement.entries[0].translation, "первоисточник");
assert.equal(replacement.entries[1].id, "term-2");

const stale = glossary.replaceEntry([entry({ updatedAt: 150 })], {
  entryId: "term-1",
  expectedUpdatedAt: 100,
  replacement: validated.terms[0],
}, 400);
assert.equal(stale.ok, false);
assert.equal(stale.error.code, "GLOSSARY_ENTRY_CHANGED");
assert.equal(stale.current.updatedAt, 150);

const moved = glossary.moveEntry([
  entry({ id: "a", term: "Alpha", normalizedTerm: "alpha" }),
  entry({ id: "b", term: "Beta", normalizedTerm: "beta" }),
  entry({ id: "c", term: "Gamma", normalizedTerm: "gamma" }),
], "c", "a");
assert.deepEqual(moved.entries.map((item) => item.id), ["c", "a", "b"]);
assert.deepEqual(glossary.deleteEntry(moved.entries, "a").entries.map((item) => item.id), ["c", "b"]);

const settings = contract.normalizeAnalysisSettings({ futureField: 7, analysis: { futureAnalysisField: true } });
assert.equal(settings.futureField, 7);
assert.equal(settings.analysis.futureAnalysisField, true);
assert.deepEqual(settings.analysis.shortcut, contract.DEFAULT_SHORTCUT);

assert.equal(secretStore.validateKey("short").ok, false);
assert.equal(secretStore.validateKey("x".repeat(24)).ok, true);
assert.equal(secretStore.validateKey(`x${"y".repeat(20)} z`).ok, false);

const body = openRouter.requestBody("selected text");
assert.equal(body.model, "openai/gpt-4.1-mini");
assert.equal(body.temperature, 0);
assert.equal(body.stream, false);
assert.equal(body.provider.data_collection, "deny");
assert.equal(body.provider.require_parameters, true);
assert.equal(body.response_format.json_schema.strict, true);
assert.deepEqual(JSON.parse(body.messages[1].content), { source_text: "selected text" });
assert.equal(openRouter.providerErrorCode(401, {}), "API_KEY_INVALID");
assert.equal(openRouter.providerErrorCode(402, {}), "INSUFFICIENT_BALANCE");
assert.equal(openRouter.providerErrorCode(429, {}), "RATE_LIMITED");
assert.equal(openRouter.providerErrorCode(503, {}), "NO_PROVIDER_AVAILABLE");
assert.equal(openRouter.providerErrorCode(502, { error: { message: "No endpoints found" } }), "PROVIDER_ERROR");
assert.equal(openRouter.providerErrorCode(200, { error: { message: "No endpoints found" } }), "NO_PROVIDER_AVAILABLE");
assert.equal(openRouter.providerErrorCode(200, { error: { metadata: { error_type: "rate_limit_error" } } }), "RATE_LIMITED");

const canonicalProviderErrorTypes = [
  ["authentication", "API_KEY_INVALID"],
  ["permission_denied", "REQUEST_FORBIDDEN"],
  ["payment_required", "INSUFFICIENT_BALANCE"],
  ["rate_limit_exceeded", "RATE_LIMITED"],
  ["provider_overloaded", "PROVIDER_OVERLOADED"],
  ["provider_unavailable", "NO_PROVIDER_AVAILABLE"],
  ["timeout", "PROVIDER_TIMEOUT"],
  ["invalid_request", "REQUEST_CONTRACT_ERROR"],
  ["invalid_prompt", "REQUEST_CONTRACT_ERROR"],
  ["precondition_failed", "REQUEST_CONTRACT_ERROR"],
  ["unprocessable", "REQUEST_CONTRACT_ERROR"],
  ["not_found", "MODEL_NOT_FOUND"],
  ["payload_too_large", "REQUEST_TOO_LARGE"],
  ["context_length_exceeded", "REQUEST_TOO_LARGE"],
  ["string_too_long", "REQUEST_TOO_LARGE"],
  ["max_tokens_exceeded", "OUTPUT_TRUNCATED"],
  ["token_limit_exceeded", "OUTPUT_TRUNCATED"],
  ["content_policy_violation", "CONTENT_BLOCKED"],
  ["refusal", "CONTENT_BLOCKED"],
  ["server", "PROVIDER_ERROR"],
  ["unmapped", "PROVIDER_ERROR"],
];
canonicalProviderErrorTypes.forEach(([errorType, expectedCode]) => {
  assert.equal(
    openRouter.providerErrorCode(200, { error: { metadata: { error_type: errorType } } }),
    expectedCode,
    errorType,
  );
});

assert.equal(openRouter.metadataErrorCode("provider_overloaded"), "PROVIDER_OVERLOADED");
assert.equal(openRouter.metadataErrorCode("provider_unavailable"), "NO_PROVIDER_AVAILABLE");
assert.equal(openRouter.metadataErrorCode("model_unavailable"), "MODEL_UNAVAILABLE");
assert.equal(openRouter.metadataErrorCode("moderation_error"), "CONTENT_BLOCKED");
assert.equal(openRouter.metadataErrorCode("invalid_request_error"), "REQUEST_CONTRACT_ERROR");
assert.equal(openRouter.metadataErrorCode("provider_error"), "PROVIDER_ERROR");
assert.equal(openRouter.providerErrorCode(200, {
  error: {
    code: 401,
    message: "Insufficient balance",
    metadata: { error_type: "permission_denied" },
  },
}), "REQUEST_FORBIDDEN");
assert.equal(openRouter.providerErrorCode(200, {
  error: {
    message: "Invalid API key",
    metadata: { error_type: "payment_required" },
  },
}), "INSUFFICIENT_BALANCE");
assert.equal(openRouter.providerErrorCode(200, {
  error: { code: "401-invalid", message: "No endpoints found" },
}), "NO_PROVIDER_AVAILABLE");
assert.equal(openRouter.providerErrorCode(429, {
  error: { code: "not-a-number", message: "Unclassified provider failure" },
}), "RATE_LIMITED");

assert.equal(openRouter.extractStructuredContent({ error: { metadata: { error_type: "rate_limit_error" } } }).code, "RATE_LIMITED");
assert.equal(openRouter.extractStructuredContent({ error: { code: 401 } }).code, "API_KEY_INVALID");
assert.equal(openRouter.extractStructuredContent({ error: { code: "402" } }).code, "INSUFFICIENT_BALANCE");
assert.equal(openRouter.extractStructuredContent({ choices: [{ error: { code: 403 } }] }).code, "REQUEST_FORBIDDEN");
[
  [400, "REQUEST_CONTRACT_ERROR"],
  [408, "PROVIDER_TIMEOUT"],
  [413, "REQUEST_TOO_LARGE"],
  [422, "REQUEST_CONTRACT_ERROR"],
  [429, "RATE_LIMITED"],
  [502, "PROVIDER_ERROR"],
  [503, "NO_PROVIDER_AVAILABLE"],
].forEach(([providerCode, expectedCode]) => {
  assert.equal(openRouter.extractStructuredContent({ error: { code: providerCode } }).code, expectedCode);
});
assert.equal(openRouter.extractStructuredContent({
  choices: [{ finish_reason: "error", error: { metadata: { error_type: "provider_overloaded" } } }],
}).code, "PROVIDER_OVERLOADED");
assert.equal(openRouter.extractStructuredContent({ choices: [{ finish_reason: "error" }] }).code, "PROVIDER_ERROR");
assert.equal(openRouter.extractStructuredContent({ choices: [{ finish_reason: "length", message: { content: "{}" } }] }).code, "OUTPUT_TRUNCATED");
assert.equal(openRouter.extractStructuredContent({
  choices: [{ finish_reason: "content_filter", message: { content: "" } }],
}).code, "CONTENT_BLOCKED");

async function runAsyncTests() {
  const previousChrome = globalThis.chrome;
  const previousDocument = globalThis.document;
  const receivedKeyStatuses = [];
  const controllerMessages = [];
  let controllerRuntimeListener = null;
  try {
    globalThis.document = { addEventListener() {} };
    globalThis.chrome = {
      runtime: {
        async sendMessage(message) {
          controllerMessages.push(clone(message));
          return { ok: true, configured: true };
        },
        onMessage: { addListener(listener) { controllerRuntimeListener = listener; } },
      },
    };
    const controller = analysisController.create({
      onKeyStatusChanged(configured) { receivedKeyStatuses.push(configured); },
    });
    assert.equal(controllerRuntimeListener({
      type: contract.MESSAGE_TYPES.KEY_STATUS_CHANGED,
      configured: true,
    }, {}, () => {}), false);
    assert.equal(controllerRuntimeListener({
      type: contract.MESSAGE_TYPES.KEY_STATUS_CHANGED,
      configured: "true",
    }, {}, () => {}), false);
    assert.deepEqual(receivedKeyStatuses, [true]);
    assert.equal(await controller.getKeyStatus(), true);
    assert.deepEqual(controllerMessages, [{ type: contract.MESSAGE_TYPES.GET_KEY_STATUS }]);
  } finally {
    if (previousChrome === undefined) delete globalThis.chrome;
    else globalThis.chrome = previousChrome;
    if (previousDocument === undefined) delete globalThis.document;
    else globalThis.document = previousDocument;
  }

  const noOpMigration = createServiceWorkerHarness(validStorage({
    settings: {
      ...validStorage().settings,
      futureSettingsField: { enabled: true },
      analysis: { ...validStorage().settings.analysis, futureAnalysisField: "keep" },
    },
  }));
  await noOpMigration.waitForMigration();
  assert.deepEqual(noOpMigration.setCalls, []);
  assert.deepEqual(noOpMigration.removeCalls, []);
  assert.deepEqual(noOpMigration.contextMenuCalls, []);
  await noOpMigration.runStartup();
  assert.deepEqual(noOpMigration.contextMenuCalls.map((call) => [call.operation, call.id]), [
    ["update", "chatgpt-helper-analyze-selection"],
  ]);

  const preservedShortcut = {
    enabled: false,
    code: "KeyK",
    ctrl: true,
    shift: true,
    alt: false,
    meta: false,
  };
  const patchMigration = createServiceWorkerHarness(validStorage({
    settings: {
      theme: "violet",
      wallpaperDataUrl: "data:image/png;base64,AA==",
      closePanelAfterRun: false,
      recentTemplatesHoverEnabled: false,
      futureSettingsField: 7,
      analysis: {
        shortcut: preservedShortcut,
        termColorMode: "custom",
        customTermColor: "#abcdef",
        futureAnalysisField: true,
      },
    },
  }));
  await patchMigration.waitForMigration();
  assert.equal(patchMigration.setCalls.length, 1);
  assert.deepEqual(Object.keys(patchMigration.setCalls[0]), ["settings"]);
  assert.equal(patchMigration.storage.settings.futureSettingsField, 7);
  assert.equal(patchMigration.storage.settings.analysis.futureAnalysisField, true);
  assert.deepEqual(patchMigration.storage.settings.analysis.shortcut, preservedShortcut);
  assert.equal(patchMigration.storage.settings.analysis.termColorMode, "custom");
  assert.equal(patchMigration.storage.settings.analysis.customTermColor, "#abcdef");
  assert.equal(patchMigration.storage.settings.analysis.glossaryTextSize, "normal");
  assert.deepEqual(patchMigration.storage.templates, validStorage().templates);
  assert.deepEqual(patchMigration.storage.recentTemplateIds, validStorage().recentTemplateIds);

  const missingAnalysisMigration = createServiceWorkerHarness(validStorage({
    settings: {
      theme: "navy",
      wallpaperDataUrl: null,
      closePanelAfterRun: true,
      recentTemplatesHoverEnabled: true,
      futureSettingsField: "preserve",
    },
  }));
  await missingAnalysisMigration.waitForMigration();
  assert.deepEqual(missingAnalysisMigration.storage.settings.analysis, {
    shortcut: { ...contract.DEFAULT_SHORTCUT },
    termColorMode: contract.DEFAULT_ANALYSIS_SETTINGS.termColorMode,
    customTermColor: contract.DEFAULT_ANALYSIS_SETTINGS.customTermColor,
    glossaryTextSize: contract.DEFAULT_ANALYSIS_SETTINGS.glossaryTextSize,
  });
  assert.equal(missingAnalysisMigration.storage.settings.futureSettingsField, "preserve");

  const futureGlossary = { future: true, entries: [{ opaque: "value" }] };
  const futureSchemaMigration = createServiceWorkerHarness(validStorage({
    glossarySchemaVersion: 7,
    glossaryEntries: futureGlossary,
  }));
  await futureSchemaMigration.waitForMigration();
  assert.deepEqual(futureSchemaMigration.setCalls, []);
  assert.equal(futureSchemaMigration.storage.glossarySchemaVersion, 7);
  assert.deepEqual(futureSchemaMigration.storage.glossaryEntries, futureGlossary);

  assert.equal(noOpMigration.evaluate(
    'isSupportedAnalysisPageTransition("https://chatgpt.com/c/first", "https://chatgpt.com/c/second")',
  ), true);
  assert.equal(noOpMigration.evaluate(
    'isSupportedAnalysisPageTransition("https://chat.openai.com/c/first", "https://chatgpt.com/c/second")',
  ), true);
  assert.equal(noOpMigration.evaluate(
    'isSupportedAnalysisPageTransition("https://example.com/c/first", "https://chatgpt.com/c/second")',
  ), false);
  assert.equal(noOpMigration.evaluate(
    'isSupportedAnalysisPageTransition("not a url", "https://chatgpt.com/c/second")',
  ), false);

  const optionsSender = { url: "chrome-extension://test/src/options.html" };
  const saveBroadcast = createServiceWorkerHarness(validStorage(), {
    tabs: [
      { id: 11, url: "https://chatgpt.com/c/one" },
      { id: 12, url: "https://example.com/unsupported" },
    ],
  });
  assert.deepEqual(await saveBroadcast.handleMessage({
    type: contract.MESSAGE_TYPES.SET_KEY,
    apiKey: "owner-secret-api-key-value",
  }, optionsSender), { ok: true });
  assert.equal(saveBroadcast.tabQueryCalls.length, 1);
  assert.deepEqual(saveBroadcast.tabMessages, [{
    tabId: 11,
    message: { type: contract.MESSAGE_TYPES.KEY_STATUS_CHANGED, configured: true },
  }]);
  assert.equal(JSON.stringify(saveBroadcast.tabMessages).includes("owner-secret-api-key-value"), false);

  const deleteBroadcast = createServiceWorkerHarness(validStorage(), {
    keyConfigured: true,
    tabs: [{ id: 21, url: "https://chat.openai.com/c/two" }],
  });
  assert.deepEqual(await deleteBroadcast.handleMessage({
    type: contract.MESSAGE_TYPES.DELETE_KEY,
  }, optionsSender), { ok: true });
  assert.deepEqual(deleteBroadcast.tabMessages, [{
    tabId: 21,
    message: { type: contract.MESSAGE_TYPES.KEY_STATUS_CHANGED, configured: false },
  }]);

  const failedMutation = createServiceWorkerHarness(validStorage(), {
    setKeyResponse: { ok: false, error: { code: "API_KEY_INVALID", message: "invalid" } },
    tabs: [{ id: 31, url: "https://chatgpt.com/c/three" }],
  });
  assert.equal((await failedMutation.handleMessage({
    type: contract.MESSAGE_TYPES.SET_KEY,
    apiKey: "invalid-owner-key-value",
  }, optionsSender)).ok, false);
  assert.deepEqual(failedMutation.tabQueryCalls, []);
  assert.deepEqual(failedMutation.tabMessages, []);

  const rejectedTabSend = createServiceWorkerHarness(validStorage(), {
    tabs: [
      { id: 41, url: "https://chatgpt.com/c/four" },
      { id: 42, url: "https://chat.openai.com/c/five" },
    ],
    failingTabIds: [41],
  });
  assert.deepEqual(await rejectedTabSend.handleMessage({
    type: contract.MESSAGE_TYPES.SET_KEY,
    apiKey: "another-owner-secret-key",
  }, optionsSender), { ok: true });
  assert.deepEqual(rejectedTabSend.tabMessages.map((item) => item.tabId), [41, 42]);

  const pullStatus = createServiceWorkerHarness(validStorage(), { keyConfigured: true });
  assert.deepEqual(await pullStatus.handleMessage({
    type: contract.MESSAGE_TYPES.GET_KEY_STATUS,
  }, optionsSender), { ok: true, configured: true });
}

runAsyncTests()
  .then(() => console.log("analysis logic ok"))
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
