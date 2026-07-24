"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { webcrypto } = require("node:crypto");
const contract = require("../src/analysis-contract.js");
const workspaceContract = require("../src/workspace-contract.js");
const conversationContext = require("../src/conversation-context.js");
const commandRegistry = require("../src/command-registry.js");
const importExport = require("../src/import-export.js");
const workspaceStore = require("../src/workspace-store.js");
const glossary = require("../src/glossary-store.js");
const secretStore = require("../src/secret-store.js");
const openRouter = require("../src/openrouter-client.js");
require("../src/analysis-controller.js");
require("../src/analysis-ui.js");

const analysisController = globalThis.ChatGPTHelperAnalysisController;
const analysisUi = globalThis.ChatGPTHelperAnalysisUi;
const serviceWorkerSource = fs.readFileSync(path.join(__dirname, "../src/service-worker.js"), "utf8");
const contentScriptSource = fs.readFileSync(path.join(__dirname, "../src/content-script.js"), "utf8");

function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function validStorage(overrides) {
  const settings = workspaceContract.normalizeActiveSettings({
    theme: "system",
    wallpaperDataUrl: null,
    closePanelAfterRun: true,
    closePanelOnOutsideClick: true,
    recentTemplatesHoverEnabled: true,
    analysis: {
      termColorMode: "theme",
      customTermColor: "#69d6c5",
      glossaryTextSize: "normal",
    },
  });
  return {
    templates: [{ id: "template-1", name: "Template", content: "Content", autoSend: true }],
    settings,
    recentTemplateIds: ["template-1"],
    glossarySchemaVersion: 1,
    glossaryEntries: [],
    ...(overrides || {}),
  };
}

function createServiceWorkerHarness(initialStorage, harnessOptions) {
  const options = harnessOptions || {};
  const storage = options.sharedStorage || clone(initialStorage);
  const setCalls = [];
  const removeCalls = [];
  const contextMenuCalls = [];
  const tabQueryCalls = [];
  const tabMessages = [];
  const tabCreateCalls = [];
  const listeners = {};
  const sessionStorage = options.sharedSessionStorage || {};
  let localSetFailure = null;
  let localSetPause = null;
  let sessionSetPause = null;
  let sessionSetFailure = null;
  let localGetTransform = null;
  let workspaceId = 0;
  let workspaceClock = 1000;
  let uuidId = 0;
  let analysisTermWriteCalls = 0;
  const memoryWorkspace = options.sharedWorkspace || new workspaceStore.MemoryWorkspaceStore(null, {
    createId(prefix) { workspaceId += 1; return `${prefix}-${workspaceId}`; },
    now() { workspaceClock += 1; return workspaceClock; },
  });
  const ensureConversation = memoryWorkspace.ensureConversation.bind(memoryWorkspace);
  const addAnalysisTerms = memoryWorkspace.addAnalysisTerms.bind(memoryWorkspace);
  let contextResolutionFailures = Number(options.contextResolutionFailures || 0);
  memoryWorkspace.ensureConversation = async (...args) => {
    if (contextResolutionFailures > 0) {
      contextResolutionFailures -= 1;
      throw new Error("INJECTED_CONTEXT_RESOLUTION_FAILURE");
    }
    return ensureConversation(...args);
  };
  memoryWorkspace.addAnalysisTerms = async (...args) => {
    analysisTermWriteCalls += 1;
    if (options.analysisWriteError) throw options.analysisWriteError;
    return addAnalysisTerms(...args);
  };
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
  const openRouterHarness = options.openRouterClient || {
    async analyze() {
      return { ok: false, error: contract.makeError("PROVIDER_ERROR") };
    },
  };
  const chrome = {
    storage: {
      local: {
        async get(keys) {
          const names = Array.isArray(keys) ? keys : [keys];
          const result = Object.fromEntries(names.filter((key) => Object.prototype.hasOwnProperty.call(storage, key))
            .map((key) => [key, clone(storage[key])]));
          if (localGetTransform?.predicate(names, result)) {
            const transform = localGetTransform.transform;
            localGetTransform = null;
            return transform(clone(result));
          }
          return result;
        },
        async set(changes) {
          const copied = clone(changes);
          if (localSetPause?.predicate(copied)) {
            const pause = localSetPause;
            pause.enter();
            await pause.gate;
            localSetPause = null;
            if (pause.errorAfterRelease) throw pause.errorAfterRelease;
          }
          if (localSetFailure?.predicate(copied)) {
            const error = localSetFailure.error;
            localSetFailure = null;
            throw error;
          }
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
        async get(keys) {
          const names = Array.isArray(keys) ? keys : [keys];
          return Object.fromEntries(names.filter((key) => Object.prototype.hasOwnProperty.call(sessionStorage, key))
            .map((key) => [key, clone(sessionStorage[key])]));
        },
        async set(changes) {
          const copied = clone(changes);
          if (sessionSetPause?.predicate(copied)) {
            const pause = sessionSetPause;
            pause.enter();
            await pause.gate;
            sessionSetPause = null;
          }
          if (sessionSetFailure?.predicate(copied)) {
            const error = sessionSetFailure.error;
            sessionSetFailure = null;
            throw error;
          }
          Object.assign(sessionStorage, copied);
        },
        async remove(keys) {
          (Array.isArray(keys) ? keys : [keys]).forEach((key) => { delete sessionStorage[key]; });
        },
      },
      onChanged: { addListener(listener) { listeners.onStorageChanged = listener; } },
    },
    runtime: {
      lastError: null,
      getURL(value) { return `chrome-extension://test/${value}`; },
      getManifest() { return { version: "2.0.0" }; },
      async openOptionsPage() {},
      onInstalled: { addListener(listener) { listeners.onInstalled = listener; } },
      onStartup: { addListener(listener) { listeners.onStartup = listener; } },
      onMessage: { addListener(listener) { listeners.onMessage = listener; } },
    },
    action: { onClicked: { addListener(listener) { listeners.onAction = listener; } } },
    commands: { onCommand: { addListener(listener) { listeners.onCommand = listener; } } },
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
      async create(createProperties) {
        tabCreateCalls.push(clone(createProperties));
        return { id: 500, ...clone(createProperties) };
      },
      async query(queryInfo) {
        tabQueryCalls.push(clone(queryInfo));
        if (options.tabQueryError) throw options.tabQueryError;
        return clone(options.tabs || []);
      },
      async sendMessage(tabId, message) {
        tabMessages.push({ tabId, message: clone(message) });
        if ((options.failingTabIds || []).includes(tabId)) throw new Error("No receiving end.");
      },
      onRemoved: { addListener(listener) { listeners.onTabRemoved = listener; } },
    },
  };
  const context = vm.createContext({
    console,
    URL,
    TextEncoder,
    structuredClone,
    crypto: {
      subtle: webcrypto.subtle,
      randomUUID: () => {
        uuidId += 1;
        return `00000000-0000-4000-8000-${String(uuidId).padStart(12, "0")}`;
      },
    },
    importScripts() {},
    chrome,
    ChatGPTHelperAnalysisContract: contract,
    ChatGPTHelperWorkspaceContract: workspaceContract,
    ChatGPTHelperConversationContext: conversationContext,
    ChatGPTHelperCommandRegistry: commandRegistry,
    ChatGPTHelperImportExport: importExport,
    ChatGPTHelperWorkspaceStore: { create() { return memoryWorkspace; }, USER_STORE_NAMES: workspaceStore.USER_STORE_NAMES },
    ChatGPTHelperGlossaryStore: { SCHEMA_VERSION: glossary.SCHEMA_VERSION },
    ChatGPTHelperSecretStore: secretStoreHarness,
    ChatGPTHelperOpenRouterClient: openRouterHarness,
  });
  vm.runInContext(serviceWorkerSource, context, { filename: "service-worker.js" });
  return {
    storage,
    setCalls,
    removeCalls,
    contextMenuCalls,
    tabQueryCalls,
    tabMessages,
    tabCreateCalls,
    memoryWorkspace,
    sessionStorage,
    analysisTermWriteCalls() { return analysisTermWriteCalls; },
    injectWorkspaceFailure(method, error) {
      const original = memoryWorkspace[method].bind(memoryWorkspace);
      memoryWorkspace[method] = async (...args) => {
        memoryWorkspace[method] = original;
        throw error || new Error(`INJECTED_${method.toUpperCase()}_FAILURE`);
      };
    },
    pauseWorkspaceMethod(method, errorAfterRelease) {
      const original = memoryWorkspace[method].bind(memoryWorkspace);
      let enter;
      let release;
      let calls = 0;
      const entered = new Promise((resolve) => { enter = resolve; });
      const gate = new Promise((resolve) => { release = resolve; });
      memoryWorkspace[method] = async (...args) => {
        calls += 1;
        enter();
        await gate;
        memoryWorkspace[method] = original;
        if (errorAfterRelease) throw errorAfterRelease;
        return original(...args);
      };
      return { entered, release, calls: () => calls };
    },
    injectLocalSetFailure(predicate, error) {
      localSetFailure = { predicate, error: error || new Error("INJECTED_LOCAL_SET_FAILURE") };
    },
    pauseLocalSet(predicate, errorAfterRelease) {
      let enter;
      let release;
      let calls = 0;
      const entered = new Promise((resolve) => { enter = resolve; });
      const gate = new Promise((resolve) => { release = resolve; });
      localSetPause = {
        predicate(changes) {
          const matched = predicate(changes);
          if (matched) calls += 1;
          return matched;
        },
        enter,
        gate,
        errorAfterRelease,
      };
      return { entered, release, calls: () => calls };
    },
    pauseSessionSet(predicate) {
      let enter;
      let release;
      const entered = new Promise((resolve) => { enter = resolve; });
      const gate = new Promise((resolve) => { release = resolve; });
      sessionSetPause = { predicate, enter, gate };
      return { entered, release };
    },
    injectSessionSetFailure(predicate, error) {
      sessionSetFailure = { predicate, error: error || new Error("INJECTED_SESSION_SET_FAILURE") };
    },
    injectLocalGetTransform(predicate, transform) { localGetTransform = { predicate, transform }; },
    async waitForMigration() { await vm.runInContext("ensureMigrated()", context); },
    async runStartup() {
      listeners.onStartup();
      await vm.runInContext("contextMenuRegistrationQueue", context);
      await new Promise((resolve) => setTimeout(resolve, 0));
    },
    async handleMessage(message, sender) {
      context.__testMessage = clone(message);
      context.__testSender = clone(sender);
      return clone(await vm.runInContext("handleMessage(__testMessage, __testSender)", context));
    },
    async runContextMenu(info, tab) {
      listeners.onContextMenu(info, tab);
      await new Promise((resolve) => setTimeout(resolve, 0));
    },
    async runCommand(commandId, tab) {
      listeners.onCommand(commandId, clone(tab));
      await new Promise((resolve) => setTimeout(resolve, 0));
    },
    async runTabRemoved(tabId) {
      listeners.onTabRemoved(tabId);
      await new Promise((resolve) => setTimeout(resolve, 0));
    },
    async recoverPendingImports() { return vm.runInContext("recoverPendingImports(getWorkspace())", context); },
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
assert.equal(commandRegistry.selectionEligible({ supportedPage: true, isEditable: false, selectionText: "text" }), true);
assert.equal(commandRegistry.selectionEligible({ supportedPage: true, isEditable: true, selectionText: "text" }), false);
assert.equal(commandRegistry.composerEligible({ supportedPage: true, isComposer: true }), true);

assert.equal(analysisUi.glossaryTextSizeClass("analysis-result-list", { analysis: { glossaryTextSize: "compact" } }), "analysis-result-list size-compact");
assert.equal(analysisUi.glossaryTextSizeClass("analysis-result-list", { analysis: { glossaryTextSize: "normal" } }), "analysis-result-list size-normal");
assert.equal(analysisUi.glossaryTextSizeClass("analysis-result-list", { analysis: { glossaryTextSize: "large" } }), "analysis-result-list size-large");
assert.equal(analysisUi.nextFocusableIndex(0, 3, true), 2);
assert.equal(analysisUi.nextFocusableIndex(2, 3, false), 0);
assert.equal(analysisUi.nextFocusableIndex(-1, 3, false), 0);
assert.equal(analysisUi.nextFocusableIndex(-1, 3, true), 2);
assert.equal(analysisUi.nextFocusableIndex(0, 0, false), -1);
const deterministicReplacementTerm = {
  status: "duplicate",
  replacementCandidate: {
    status: "single",
    targetSenseId: "target-sense",
    newSenseId: "new-sense",
    expectedUpdatedAt: 42,
  },
};
assert.deepEqual(analysisUi.replacementCommandForTerm(deterministicReplacementTerm), {
  entryId: "target-sense",
  sourceSenseId: "new-sense",
  expectedUpdatedAt: 42,
});
assert.equal(analysisUi.replacementCommandForTerm({
  ...deterministicReplacementTerm,
  status: "new",
  replacementCandidate: { status: "multiple", count: 2 },
}), null);
assert.equal(analysisUi.replacementCommandForTerm({ status: "new" }), null);
assert.doesNotMatch(contentScriptSource, /chrome\.storage\.local\.set\s*\(/);
assert.doesNotMatch(contentScriptSource, /\bindexedDB\b/);
assert.doesNotMatch(contentScriptSource, /chrome\.storage\.local\.(?:remove|clear)\s*\(/);
assert.match(contentScriptSource, /\.shell \{[\s\S]*width: var\(--sidebar-effective-width\);[\s\S]*\.sidebar-frame \{[\s\S]*display: flex;/);
assert.match(contentScriptSource, /\.rail \{[\s\S]*position: relative;[\s\S]*flex: 0 0 var\(--rail-width\);/);
assert.match(contentScriptSource, /\.panel \{[\s\S]*position: relative;[\s\S]*flex: 1 1 auto;/);
assert.match(contentScriptSource, /\.panel-resize \{[^}]*left: 0;[^}]*width: 10px;/);
assert.match(contentScriptSource, /\.panel-resize::after \{[^}]*left: 0;[^}]*width: 1px;/);
assert.doesNotMatch(contentScriptSource, /\.panel-resize::after \{[^}]*left: 4px;/);
assert.doesNotMatch(contentScriptSource, /\.is-open \.rail/);
assert.match(contentScriptSource, /state\.settings\.closePanelOnOutsideClick/);
assert.match(contentScriptSource, /\.quick-action \{[\s\S]*opacity: 0;[\s\S]*transform: scale\(\.8\);[\s\S]*pointer-events: none;[\s\S]*opacity var\(--sidebar-motion-duration\) var\(--sidebar-motion-easing\), transform var\(--sidebar-motion-duration\) var\(--sidebar-motion-easing\)/);
assert.match(contentScriptSource, /\.phase-revealing-opener \.quick-action, \.phase-closed \.quick-action \{ opacity: 1; transform: scale\(1\); \}/);
assert.match(contentScriptSource, /const quickActionState = workspaceUiModule\.quickActionStateForPhase\(phase\)/);
assert.match(contentScriptSource, /state\.quickAction\.hidden = !quickActionState\.rendered/);
assert.match(contentScriptSource, /class="template-preview-hotspot" data-preview-anchor data-preview-id=/);
assert.doesNotMatch(contentScriptSource, /class="template-summary" data-preview-/);
assert.match(contentScriptSource, /\.template-summary \{[^}]*grid-template-columns: minmax\(0, 1fr\) auto;/);
assert.match(contentScriptSource, /\.template-preview-hotspot \{[^}]*grid-template-columns: auto minmax\(0, 1fr\);/);
assert.match(contentScriptSource, /workspaceUiModule\.previewAnchorFromTarget\(event\.target\)/);
assert.match(contentScriptSource, /createTemplatePatch\(state\.editing\.original, \{ name, content \}\)/);
assert.match(contentScriptSource, /original: \{ name: template\.name, content: template\.content \}/);
assert.match(contentScriptSource, /if \(!Object\.keys\(patch\)\.length\)/);
assert.doesNotMatch(contentScriptSource, /patch: \{ name, content \}/);
assert.match(contentScriptSource, /patch: \{ autoSend: event\.target\.checked \}/);
const ordinaryTemplateRunSource = contentScriptSource.slice(
  contentScriptSource.indexOf("async function runTemplate"),
  contentScriptSource.indexOf("async function runQuickAction"),
);
const quickActionRunSource = contentScriptSource.slice(
  contentScriptSource.indexOf("async function runQuickAction"),
  contentScriptSource.indexOf("async function saveEditor"),
);
assert.match(ordinaryTemplateRunSource, /interpretTemplateExecutionResult\(result, \{[\s\S]*requireSent: template\.autoSend === true/);
assert.match(ordinaryTemplateRunSource, /execution\.insertionFailed/);
assert.match(ordinaryTemplateRunSource, /execution\.verificationFailed/);
assert.match(ordinaryTemplateRunSource, /execution\.sendFailed/);
assert.match(quickActionRunSource, /interpretTemplateExecutionResult\(result, \{ requireSent: true \}\)/);
assert.match(quickActionRunSource, /!execution\.accepted && !execution\.noop/);
assert.doesNotMatch(quickActionRunSource, /!result\?\.ok/);
assert.doesNotMatch(contentScriptSource, /TEMPLATE_UPDATE,[\s\S]{0,180}template:/);
assert.match(contentScriptSource, /validateWallpaperSourceFile\(file\)/);
assert.match(contentScriptSource, /Максимум 6 МБ/);
assert.doesNotMatch(contentScriptSource, /clear-glossary-search|clear-saved-search/);
assert.doesNotMatch(contentScriptSource, /unlink-glossary|unlink-saved|ask-global-(?:glossary|saved)-delete|confirm-global-(?:glossary|saved)-delete/);
const workspaceRefreshSource = contentScriptSource.slice(
  contentScriptSource.indexOf("async function refreshGlossary"),
  contentScriptSource.indexOf("function handleWorkspaceContextChange"),
);
assert.match(workspaceRefreshSource, /const requestedMode = workspaceUiModule\.activeSearchMode\(state\.glossaryRequestedMode\)/);
assert.match(workspaceRefreshSource, /const requestedMode = workspaceUiModule\.activeSearchMode\(state\.savedRequestedMode\)/);
assert.match(workspaceRefreshSource, /isCurrentWorkspaceRequest\(token, state\.glossaryRequestToken\)/);
assert.match(workspaceRefreshSource, /isCurrentWorkspaceRequest\(token, state\.savedRequestToken\)/);
const workspaceInputSource = contentScriptSource.slice(
  contentScriptSource.indexOf("function onShadowInput"),
  contentScriptSource.indexOf("function onDragStart"),
);
assert.match(workspaceInputSource, /state\.glossarySearch = event\.target\.value/);
assert.match(workspaceInputSource, /state\.savedSearch = event\.target\.value/);
assert.doesNotMatch(workspaceInputSource, /glossaryRequestedMode\s*=/);
assert.doesNotMatch(workspaceInputSource, /savedRequestedMode\s*=/);
const workspaceDeleteSource = contentScriptSource.slice(
  contentScriptSource.indexOf("async function deleteWorkspaceEntry"),
  contentScriptSource.indexOf("async function reorderGlossaryEntries"),
);
assert.match(workspaceDeleteSource, /workspaceDeleteOperation\(kind, scope\)/);
assert.match(workspaceDeleteSource, /await state\.workspaceClient\[operation\]\(id\)/);
assert.match(workspaceDeleteSource, /if \(kind === "glossary"\) await refreshGlossary\(\)/);
assert.match(workspaceDeleteSource, /else await refreshSaved\(\)/);
assert.match(workspaceDeleteSource, /settleWorkspaceDelete\(\)/);
assert.doesNotMatch(workspaceDeleteSource, /glossaryRequestedMode\s*=|glossarySearch\s*=|savedRequestedMode\s*=|savedSearch\s*=/);
const workspaceEscapeSource = contentScriptSource.slice(
  contentScriptSource.indexOf('document.addEventListener("keydown", function handleEscape'),
  contentScriptSource.indexOf('document.addEventListener("pointerdown", function handleOutsidePointer'),
);
assert.equal(workspaceEscapeSource.indexOf("state.analysisUi?.handleEscape()")
  < workspaceEscapeSource.indexOf("closeWorkspaceDeleteAndRender(true)"), true);
assert.equal(workspaceEscapeSource.indexOf("closeWorkspaceDeleteAndRender(true)")
  < workspaceEscapeSource.indexOf("closeTemplatePreview()"), true);
assert.equal(workspaceEscapeSource.indexOf("closeTemplatePreview()")
  < workspaceEscapeSource.indexOf("closePanel(true)"), true);
const selectedTextReaderSource = contentScriptSource.slice(
  contentScriptSource.indexOf("function readSelectedTextSnapshot"),
  contentScriptSource.indexOf("async function saveSelectionSnapshot"),
);
const runSaveSelectionSource = contentScriptSource.slice(
  contentScriptSource.indexOf("async function runSaveSelection"),
  contentScriptSource.indexOf("function runNormalizeComposer"),
);
assert.match(selectedTextReaderSource, /chatGptDom\.readSelectionText/);
assert.match(runSaveSelectionSource, /readSelectedTextSnapshot\(selectionText\)/);
assert.doesNotMatch(runSaveSelectionSource, /window\.getSelection\?\.\(\)\.toString/);

assert.equal(
  contract.MESSAGE_TYPES.KEY_STATUS_CHANGED,
  "chatgpt-helper:openrouter-key-status-changed",
);
const analysisStyles = analysisUi.styles();
assert.match(analysisStyles, /\.analysis-replace \{[^}]*display: inline-flex;[^}]*padding: 0;[^}]*align-items: center;[^}]*justify-content: center;[^}]*line-height: 0;/);
assert.match(analysisStyles, /\.analysis-replace svg \{[^}]*display: block;[^}]*width: 16px;[^}]*height: 16px;/);
assert.doesNotMatch(analysisStyles, /analysis-search-clear/);
const keyMarkupState = {
  glossaryEntries: [],
  glossarySearch: "query",
  settings: { analysis: { glossaryTextSize: "normal" } },
};
const nativeAnalysisSearchMarkup = analysisUi.analysisMarkup({ ...keyMarkupState, keyChecking: true, keyConfigured: false });
assert.match(nativeAnalysisSearchMarkup, /<input class="analysis-search" type="search"/);
assert.doesNotMatch(nativeAnalysisSearchMarkup, /analysis-search-clear|clear-glossary-search/);
assert.equal(analysisUi.analysisMarkup({ ...keyMarkupState, keyChecking: true, keyConfigured: false }).includes("OpenRouter"), false);
assert.equal(analysisUi.analysisMarkup({ ...keyMarkupState, keyChecking: false, keyConfigured: true }).includes("OpenRouter"), false);
const missingKeyMarkup = analysisUi.analysisMarkup({ ...keyMarkupState, keyChecking: false, keyConfigured: false });
assert.match(missingKeyMarkup, /OpenRouter не подключён/);
assert.match(missingKeyMarkup, /data-action="open-analysis-options"/);

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
assert.equal(settings.analysis.termColorMode, "theme");

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
  const retryTerm = {
    status: "duplicate",
    conceptId: "concept-retry",
    translation: "состояние",
    definition: "Новое определение.",
    savedEntry: {
      id: "target-sense",
      conceptId: "concept-retry",
      translation: "состояние",
      definition: "Старое определение.",
      updatedAt: 42,
    },
    replacementCandidate: {
      status: "single",
      targetSenseId: "target-sense",
      newSenseId: "new-sense",
      expectedUpdatedAt: 42,
    },
  };
  const replacementRequests = [];
  const firstReplacement = await analysisUi.runReplacementAction(retryTerm, async (command) => {
    replacementRequests.push(clone(command));
    return {
      ok: false,
      error: contract.makeError("GLOSSARY_ENTRY_CHANGED"),
      current: {
        id: "target-sense-current",
        conceptId: "concept-retry",
        translation: "состояние",
        definition: "Текущее определение.",
        updatedAt: 84,
      },
    };
  });
  assert.equal(firstReplacement.status, "stale");
  assert.equal(replacementRequests.length, 1);
  assert.equal(replacementRequests[0].expectedUpdatedAt, 42);
  assert.equal(retryTerm.savedEntry.definition, "Текущее определение.");
  assert.equal(retryTerm.replacementCandidate.targetSenseId, "target-sense-current");
  assert.equal(retryTerm.replacementCandidate.newSenseId, "new-sense");
  assert.equal(retryTerm.replacementCandidate.expectedUpdatedAt, 84);
  const secondReplacement = await analysisUi.runReplacementAction(retryTerm, async (command) => {
    replacementRequests.push(clone(command));
    return { ok: true, entry: { id: command.entryId, definition: "Новое определение." } };
  });
  assert.equal(secondReplacement.status, "replaced");
  assert.equal(replacementRequests.length, 2);
  assert.equal(replacementRequests[1].entryId, "target-sense-current");
  assert.equal(replacementRequests[1].sourceSenseId, "new-sense");
  assert.equal(replacementRequests[1].expectedUpdatedAt, 84);
  assert.equal(retryTerm.status, "replaced");
  assert.equal(analysisUi.replacementCommandForTerm(retryTerm), null);

  for (const invalidCurrent of [
    null,
    {
      id: "target-sense",
      conceptId: "different-concept",
      translation: "состояние",
      definition: "Старое определение.",
      updatedAt: 84,
    },
    {
      id: "target-sense",
      conceptId: "concept-retry",
      translation: "состояние",
      definition: "Новое определение.",
      updatedAt: 84,
    },
  ]) {
    const invalidTerm = {
      status: "duplicate",
      conceptId: "concept-retry",
      translation: "состояние",
      definition: "Новое определение.",
      replacementCandidate: {
        status: "single",
        targetSenseId: "target-sense",
        newSenseId: "new-sense",
        expectedUpdatedAt: 42,
      },
    };
    let invalidRequests = 0;
    const invalidOutcome = await analysisUi.runReplacementAction(invalidTerm, async () => {
      invalidRequests += 1;
      return { ok: false, error: contract.makeError("GLOSSARY_ENTRY_CHANGED"), current: invalidCurrent };
    });
    assert.equal(invalidOutcome.status, "invalid");
    assert.equal(invalidRequests, 1);
    assert.equal(invalidTerm.replacementCandidate.newSenseId, "new-sense");
    assert.equal(analysisUi.replacementCommandForTerm(invalidTerm), null);
  }

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
  assert.equal(noOpMigration.setCalls.length, 1);
  assert.deepEqual(Object.keys(noOpMigration.setCalls[0]), ["settings"]);
  assert.equal(Object.prototype.hasOwnProperty.call(noOpMigration.storage.settings, "futureSettingsField"), false);
  assert.equal(Object.prototype.hasOwnProperty.call(noOpMigration.storage.settings.analysis, "futureAnalysisField"), false);
  assert.deepEqual(noOpMigration.removeCalls, []);
  assert.deepEqual(noOpMigration.contextMenuCalls, []);
  await noOpMigration.runStartup();
  assert.deepEqual(noOpMigration.contextMenuCalls.map((call) => [call.operation, call.id]), [
    ["update", "chatgpt-helper-analyze-selection"],
    ["update", "chatgpt-helper-save-selection"],
    ["update", "chatgpt-helper-normalize-composer"],
  ]);

  const patchMigration = createServiceWorkerHarness(validStorage({
    settings: {
      theme: "violet",
      wallpaperDataUrl: "data:image/png;base64,AA==",
      closePanelAfterRun: false,
      recentTemplatesHoverEnabled: false,
      futureSettingsField: 7,
      analysis: {
        shortcut: { legacy: true },
        termColorMode: "custom",
        customTermColor: "#abcdef",
        futureAnalysisField: true,
      },
    },
  }));
  await patchMigration.waitForMigration();
  assert.equal(patchMigration.setCalls.length, 1);
  assert.deepEqual(Object.keys(patchMigration.setCalls[0]), ["settings"]);
  assert.equal(Object.prototype.hasOwnProperty.call(patchMigration.storage.settings, "futureSettingsField"), false);
  assert.equal(Object.prototype.hasOwnProperty.call(patchMigration.storage.settings.analysis, "futureAnalysisField"), false);
  assert.equal(Object.prototype.hasOwnProperty.call(patchMigration.storage.settings.analysis, "shortcut"), false);
  assert.equal(patchMigration.storage.settings.analysis.termColorMode, "custom");
  assert.equal(patchMigration.storage.settings.analysis.customTermColor, "#abcdef");
  assert.equal(patchMigration.storage.settings.analysis.glossaryTextSize, "normal");
  assert.equal(patchMigration.storage.settings.recentTemplatesHoverCount, 3);
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
    termColorMode: contract.DEFAULT_ANALYSIS_SETTINGS.termColorMode,
    customTermColor: contract.DEFAULT_ANALYSIS_SETTINGS.customTermColor,
    glossaryTextSize: contract.DEFAULT_ANALYSIS_SETTINGS.glossaryTextSize,
  });
  assert.equal(Object.prototype.hasOwnProperty.call(missingAnalysisMigration.storage.settings, "futureSettingsField"), false);

  const completeRecentTemplates = Array.from({ length: 8 }, (_, index) => ({
    id: `history-${index + 1}`,
    name: `History ${index + 1}`,
    content: `Content ${index + 1}`,
    autoSend: false,
  }));
  const completeRecentHistory = completeRecentTemplates.map((template) => template.id);
  const completeHistoryMigration = createServiceWorkerHarness(validStorage({
    templates: completeRecentTemplates,
    recentTemplateIds: completeRecentHistory,
  }));
  await completeHistoryMigration.waitForMigration();
  assert.deepEqual(completeHistoryMigration.storage.recentTemplateIds, completeRecentHistory);

  const futureGlossary = { future: true, entries: [{ opaque: "value" }] };
  const futureSchemaMigration = createServiceWorkerHarness(validStorage({
    glossarySchemaVersion: 7,
    glossaryEntries: futureGlossary,
  }));
  await assert.rejects(futureSchemaMigration.waitForMigration(), /Unsupported future glossary schema/);
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
  const importedSettingsText = importExport.createSettingsExport({
    ...workspaceContract.DEFAULT_ACTIVE_SETTINGS,
    theme: "navy",
  }, { exportedAt: "2026-07-18T12:00:00.000Z", extensionVersion: "2.0.0" }).text;
  const importedDataState = {
    templates: [{ id: "imported-template", name: "Импорт", content: "Импортированный шаблон", autoSend: false }],
    conversations: [],
    glossaryConcepts: [],
    glossarySenses: [],
    glossaryLinks: [],
    savedItems: [],
    savedItemLinks: [],
  };
  const importedDataText = importExport.createDataExport(importedDataState, {
    datasetId: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
    exportedAt: "2026-07-18T12:00:00.000Z",
    extensionVersion: "2.0.0",
  }).text;
  const settingsMessage = { type: workspaceContract.MESSAGE_TYPES.IMPORT_SETTINGS_APPLY, text: importedSettingsText, mode: "merge" };
  const mergeDataMessage = { type: workspaceContract.MESSAGE_TYPES.IMPORT_DATA_APPLY, text: importedDataText, mode: "merge" };
  const replaceDataMessage = { ...mergeDataMessage, mode: "replace" };

  const optionsBoundaryHarness = createServiceWorkerHarness(validStorage());
  await optionsBoundaryHarness.waitForMigration();
  assert.equal((await optionsBoundaryHarness.handleMessage({
    type: contract.MESSAGE_TYPES.OPEN_OPTIONS,
    section: "backup",
  }, { tab: { id: 28, url: "https://chatgpt.com/c/options-link" }, url: "https://chatgpt.com/c/options-link" })).ok, true);
  assert.deepEqual(optionsBoundaryHarness.tabCreateCalls, [{ url: "chrome-extension://test/src/options.html#backup" }]);
  assert.equal((await optionsBoundaryHarness.handleMessage({
    type: workspaceContract.MESSAGE_TYPES.IMPORT_SETTINGS_PREVIEW,
    text: importedSettingsText,
    mode: "merge",
  }, optionsSender)).ok, true);
  assert.equal((await optionsBoundaryHarness.handleMessage({
    type: workspaceContract.MESSAGE_TYPES.IMPORT_DATA_PREVIEW,
    text: importedDataText,
    mode: "replace",
  }, optionsSender)).preview.aggregateOnly, true);
  assert.equal((await optionsBoundaryHarness.handleMessage({
    type: workspaceContract.MESSAGE_TYPES.EXPORT_SETTINGS,
  }, { tab: { id: 30, url: "https://chatgpt.com/c/content" }, url: "https://chatgpt.com/c/content" })).error.code, "REQUEST_FORBIDDEN");
  const exportedSettingsResponse = await optionsBoundaryHarness.handleMessage({
    type: workspaceContract.MESSAGE_TYPES.EXPORT_SETTINGS,
  }, optionsSender);
  assert.equal(exportedSettingsResponse.ok, true);
  assert.equal(exportedSettingsResponse.text.includes("apiKey"), false);
  for (const allowedSender of [
    { url: "chrome-extension://test/src/options.html#backup" },
    { url: "chrome-extension://test/src/options.html#local-section" },
    { url: "chrome-extension://test/src/options.html#backup", tab: { id: 301, url: "chrome-extension://test/src/options.html#backup" } },
  ]) {
    assert.equal((await optionsBoundaryHarness.handleMessage({
      type: workspaceContract.MESSAGE_TYPES.EXPORT_SETTINGS,
    }, allowedSender)).ok, true);
  }
  for (const rejectedSender of [
    { url: "chrome-extension://test/src/options.html?backup=1" },
    { url: "chrome-extension://user@test/src/options.html#backup" },
    { url: "chrome-extension://test/src/other.html#backup" },
    { url: "chrome-extension://other/src/options.html#backup" },
    { url: "https://chatgpt.com/src/options.html#backup", tab: { id: 302, url: "https://chatgpt.com/src/options.html#backup" } },
    {},
    { url: "not a url" },
    { url: "chrome-extension://test/src/options.html", tab: { id: 303, url: "chrome-extension://test/src/other.html" } },
    { url: "chrome-extension://test/src/other.html", tab: { id: 304, url: "chrome-extension://test/src/options.html" } },
  ]) {
    assert.equal((await optionsBoundaryHarness.handleMessage({
      type: workspaceContract.MESSAGE_TYPES.EXPORT_SETTINGS,
    }, rejectedSender)).error.code, "REQUEST_FORBIDDEN");
  }
  assert.equal((await optionsBoundaryHarness.handleMessage(settingsMessage, optionsSender)).ok, true);
  assert.equal(optionsBoundaryHarness.storage.settings.theme, "navy");

  const lockedImportHarness = createServiceWorkerHarness(validStorage());
  await lockedImportHarness.waitForMigration();
  lockedImportHarness.sessionStorage["chatgpt-helper:import-lock"] = { operationId: "other", expiresAt: Date.now() + 60_000 };
  assert.equal((await lockedImportHarness.handleMessage(mergeDataMessage, optionsSender)).error.code, "IMPORT_LOCKED");

  async function assertExclusiveImport(firstMessage, secondMessage) {
    const harness = createServiceWorkerHarness(validStorage());
    await harness.waitForMigration();
    const pausedBackup = harness.pauseWorkspaceMethod("putImportBackup");
    const first = harness.handleMessage(firstMessage, optionsSender);
    await pausedBackup.entered;
    const second = await harness.handleMessage(secondMessage, optionsSender);
    assert.equal(second.ok, false);
    assert.equal(second.error.code, "IMPORT_LOCKED");
    assert.equal(pausedBackup.calls(), 1);
    assert.equal(await harness.memoryWorkspace.getMetaValue("dataImportOperation"), null);
    assert.equal(await harness.memoryWorkspace.getMetaValue("settingsImportOperation"), null);
    pausedBackup.release();
    assert.equal((await first).ok, true);
    assert.equal(Object.prototype.hasOwnProperty.call(harness.sessionStorage, "chatgpt-helper:import-lock"), false);
  }
  await assertExclusiveImport(mergeDataMessage, mergeDataMessage);
  await assertExclusiveImport(settingsMessage, settingsMessage);
  await assertExclusiveImport(mergeDataMessage, settingsMessage);

  const staleSessionHarness = createServiceWorkerHarness(validStorage());
  await staleSessionHarness.waitForMigration();
  staleSessionHarness.sessionStorage["chatgpt-helper:import-lock"] = { operationId: "stale", expiresAt: Date.now() - 1 };
  assert.equal((await staleSessionHarness.handleMessage(settingsMessage, optionsSender)).ok, true);
  assert.equal(Object.prototype.hasOwnProperty.call(staleSessionHarness.sessionStorage, "chatgpt-helper:import-lock"), false);

  const markerPriorityHarness = createServiceWorkerHarness(validStorage());
  await markerPriorityHarness.waitForMigration();
  markerPriorityHarness.sessionStorage["chatgpt-helper:import-lock"] = { operationId: "expired", expiresAt: Date.now() - 1 };
  await markerPriorityHarness.memoryWorkspace.setMetaValue("dataImportOperation", { operationId: "durable", phase: "workspace-applied" });
  const markerPriority = await markerPriorityHarness.handleMessage(settingsMessage, optionsSender);
  assert.equal(markerPriority.ok, false);
  assert.equal(markerPriority.recoveryRequired, true);
  assert.equal(markerPriority.error.code, "IMPORT_LOCKED");
  assert.equal(markerPriorityHarness.sessionStorage["chatgpt-helper:import-lock"].operationId, "expired");

  const localMutationHarness = createServiceWorkerHarness(validStorage());
  await localMutationHarness.waitForMigration();
  const createdTemplate = { id: "template-created", name: "Создан", content: "Новый шаблон", autoSend: false };
  assert.equal((await localMutationHarness.handleMessage({
    type: workspaceContract.MESSAGE_TYPES.TEMPLATE_CREATE,
    template: createdTemplate,
  }, { tab: { id: 305, url: "https://chatgpt.com/c/local-mutations" }, url: "https://chatgpt.com/c/local-mutations" })).ok, true);
  assert.equal((await localMutationHarness.handleMessage({
    type: workspaceContract.MESSAGE_TYPES.TEMPLATE_UPDATE,
    templateId: createdTemplate.id,
    patch: { name: "Изменён" },
  }, { tab: { id: 305, url: "https://chatgpt.com/c/local-mutations" }, url: "https://chatgpt.com/c/local-mutations" })).ok, true);
  const reorderedTemplates = await localMutationHarness.handleMessage({
    type: workspaceContract.MESSAGE_TYPES.TEMPLATE_REORDER,
    templateIds: ["template-created", "template-1"],
  }, { tab: { id: 305, url: "https://chatgpt.com/c/local-mutations" }, url: "https://chatgpt.com/c/local-mutations" });
  assert.deepEqual(reorderedTemplates.templates.map((item) => item.id), ["template-created", "template-1"]);
  assert.equal((await localMutationHarness.handleMessage({
    type: workspaceContract.MESSAGE_TYPES.RECENT_TEMPLATE_TOUCH,
    templateId: "template-created",
  }, { tab: { id: 305, url: "https://chatgpt.com/c/local-mutations" }, url: "https://chatgpt.com/c/local-mutations" })).recentTemplateIds[0], "template-created");
  assert.equal((await localMutationHarness.handleMessage({
    type: workspaceContract.MESSAGE_TYPES.SETTINGS_UPDATE,
    patch: { theme: "gold" },
  }, { tab: { id: 305, url: "https://chatgpt.com/c/local-mutations" }, url: "https://chatgpt.com/c/local-mutations" })).settings.theme, "gold");
  assert.equal((await localMutationHarness.handleMessage({
    type: workspaceContract.MESSAGE_TYPES.SETTINGS_UPDATE,
    patch: { recentTemplatesHoverCount: 8 },
  }, { tab: { id: 305, url: "https://chatgpt.com/c/local-mutations" }, url: "https://chatgpt.com/c/local-mutations" })).settings.recentTemplatesHoverCount, 8);
  for (const invalidRecentTemplatesHoverCount of ["8", null, 2.5, 0, 9]) {
    assert.equal((await localMutationHarness.handleMessage({
      type: workspaceContract.MESSAGE_TYPES.SETTINGS_UPDATE,
      patch: { recentTemplatesHoverCount: invalidRecentTemplatesHoverCount },
    }, { tab: { id: 305, url: "https://chatgpt.com/c/local-mutations" }, url: "https://chatgpt.com/c/local-mutations" })).error.code, "INVALID_SETTINGS_PATCH");
  }
  assert.equal((await localMutationHarness.handleMessage({
    type: workspaceContract.MESSAGE_TYPES.TEMPLATE_DELETE,
    templateId: "template-created",
  }, { tab: { id: 305, url: "https://chatgpt.com/c/local-mutations" }, url: "https://chatgpt.com/c/local-mutations" })).ok, true);
  assert.deepEqual(localMutationHarness.storage.templates.map((item) => item.id), ["template-1"]);
  assert.equal(localMutationHarness.storage.recentTemplateIds.includes("template-created"), false);

  const completeHistoryMutation = createServiceWorkerHarness(validStorage({
    templates: completeRecentTemplates,
    recentTemplateIds: completeRecentHistory,
  }));
  await completeHistoryMutation.waitForMigration();
  const completeHistoryTouched = await completeHistoryMutation.handleMessage({
    type: workspaceContract.MESSAGE_TYPES.RECENT_TEMPLATE_TOUCH,
    templateId: "history-8",
  }, { tab: { id: 306, url: "https://chatgpt.com/c/complete-history" }, url: "https://chatgpt.com/c/complete-history" });
  assert.deepEqual(completeHistoryTouched.recentTemplateIds, [
    "history-8", "history-1", "history-2", "history-3",
    "history-4", "history-5", "history-6", "history-7",
  ]);

  const queueSender = { tab: { id: 308, url: "https://chatgpt.com/c/local-queue" }, url: "https://chatgpt.com/c/local-queue" };
  const createQueueHarness = createServiceWorkerHarness(validStorage());
  await createQueueHarness.waitForMigration();
  const createResults = await Promise.all([
    createQueueHarness.handleMessage({
      type: workspaceContract.MESSAGE_TYPES.TEMPLATE_CREATE,
      template: { id: "queue-a", name: "A", content: "A", autoSend: false },
    }, queueSender),
    createQueueHarness.handleMessage({
      type: workspaceContract.MESSAGE_TYPES.TEMPLATE_CREATE,
      template: { id: "queue-b", name: "B", content: "B", autoSend: false },
    }, queueSender),
  ]);
  assert.equal(createResults.every((response) => response.ok), true);
  assert.deepEqual(createQueueHarness.storage.templates.map((item) => item.id), ["template-1", "queue-a", "queue-b"]);
  assert.deepEqual(createResults[1].templates, createQueueHarness.storage.templates);

  const createDeleteHarness = createServiceWorkerHarness(validStorage());
  await createDeleteHarness.waitForMigration();
  await Promise.all([
    createDeleteHarness.handleMessage({
      type: workspaceContract.MESSAGE_TYPES.TEMPLATE_CREATE,
      template: { id: "queue-created", name: "Created", content: "Created", autoSend: false },
    }, queueSender),
    createDeleteHarness.handleMessage({ type: workspaceContract.MESSAGE_TYPES.TEMPLATE_DELETE, templateId: "template-1" }, queueSender),
  ]);
  assert.deepEqual(createDeleteHarness.storage.templates.map((item) => item.id), ["queue-created"]);
  assert.deepEqual(createDeleteHarness.storage.recentTemplateIds, []);

  const orderedQueueStorage = validStorage({
    templates: [
      { id: "queue-one", name: "One", content: "One", autoSend: false },
      { id: "queue-two", name: "Two", content: "Two", autoSend: false },
    ],
    recentTemplateIds: ["queue-one"],
  });
  const updateReorderHarness = createServiceWorkerHarness(orderedQueueStorage);
  await updateReorderHarness.waitForMigration();
  const updateReorder = await Promise.all([
    updateReorderHarness.handleMessage({
      type: workspaceContract.MESSAGE_TYPES.TEMPLATE_UPDATE,
      templateId: "queue-one",
      patch: { name: "One updated" },
    }, queueSender),
    updateReorderHarness.handleMessage({
      type: workspaceContract.MESSAGE_TYPES.TEMPLATE_REORDER,
      templateIds: ["queue-two", "queue-one"],
    }, queueSender),
  ]);
  assert.equal(updateReorder.every((response) => response.ok), true);
  assert.deepEqual(updateReorderHarness.storage.templates.map((item) => [item.id, item.name]), [
    ["queue-two", "Two"], ["queue-one", "One updated"],
  ]);

  for (const updates of [
    [
      { patch: { name: "Edited name", content: "Edited\n\n\ncontent" } },
      { patch: { autoSend: true } },
    ],
    [
      { patch: { autoSend: true } },
      { patch: { name: "Edited name", content: "Edited\n\n\ncontent" } },
    ],
  ]) {
    const templatePatchHarness = createServiceWorkerHarness(validStorage({
      templates: [{ id: "patch-target", name: "Old name", content: "Old content", autoSend: false }],
      recentTemplateIds: ["patch-target"],
    }));
    await templatePatchHarness.waitForMigration();
    const responses = await Promise.all(updates.map((update) => templatePatchHarness.handleMessage({
      type: workspaceContract.MESSAGE_TYPES.TEMPLATE_UPDATE,
      templateId: "patch-target",
      patch: update.patch,
    }, queueSender)));
    assert.equal(responses.every((response) => response.ok), true);
    assert.deepEqual(templatePatchHarness.storage.templates[0], {
      id: "patch-target",
      name: "Edited name",
      content: "Edited\n\n\ncontent",
      autoSend: true,
    });
    assert.deepEqual(responses.at(-1).templates, templatePatchHarness.storage.templates);
    assert.deepEqual(templatePatchHarness.storage.recentTemplateIds, ["patch-target"]);
  }

  const staleEditorOriginal = { name: "Old name", content: "Old content" };
  const independentEditorPatches = [
    workspaceContract.createTemplatePatch(staleEditorOriginal, { name: "Name from tab A", content: "Old content" }),
    workspaceContract.createTemplatePatch(staleEditorOriginal, { name: "Old name", content: "Content from tab B" }),
  ];
  assert.deepEqual(independentEditorPatches, [
    { name: "Name from tab A" },
    { content: "Content from tab B" },
  ]);
  for (const patches of [independentEditorPatches, independentEditorPatches.slice().reverse()]) {
    const independentEditorsHarness = createServiceWorkerHarness(validStorage({
      templates: [{ id: "independent-edit", name: "Old name", content: "Old content", autoSend: false }],
      recentTemplateIds: ["independent-edit"],
    }));
    await independentEditorsHarness.waitForMigration();
    const responses = await Promise.all(patches.map((patch) => independentEditorsHarness.handleMessage({
      type: workspaceContract.MESSAGE_TYPES.TEMPLATE_UPDATE,
      templateId: "independent-edit",
      patch,
    }, queueSender)));
    assert.equal(responses.every((response) => response.ok), true);
    assert.deepEqual(independentEditorsHarness.storage.templates[0], {
      id: "independent-edit",
      name: "Name from tab A",
      content: "Content from tab B",
      autoSend: false,
    });
    assert.deepEqual(responses.at(-1).templates, independentEditorsHarness.storage.templates);
  }

  for (const invalidUpdate of [
    { template: validStorage().templates[0] },
    { templateId: "template-1", patch: {} },
    { templateId: "template-1", patch: { unknown: true } },
    { templateId: "template-1", patch: { autoSend: "true" } },
    { templateId: "missing", patch: { autoSend: true } },
  ]) {
    const invalidResponse = await updateReorderHarness.handleMessage({
      type: workspaceContract.MESSAGE_TYPES.TEMPLATE_UPDATE,
      ...invalidUpdate,
    }, queueSender);
    assert.equal(invalidResponse.ok, false);
    assert.equal(invalidResponse.error.code, "INVALID_TEMPLATE_PATCH");
  }

  const reorderDeleteHarness = createServiceWorkerHarness(orderedQueueStorage);
  await reorderDeleteHarness.waitForMigration();
  await Promise.all([
    reorderDeleteHarness.handleMessage({
      type: workspaceContract.MESSAGE_TYPES.TEMPLATE_REORDER,
      templateIds: ["queue-two", "queue-one"],
    }, queueSender),
    reorderDeleteHarness.handleMessage({ type: workspaceContract.MESSAGE_TYPES.TEMPLATE_DELETE, templateId: "queue-two" }, queueSender),
  ]);
  assert.deepEqual(reorderDeleteHarness.storage.templates.map((item) => item.id), ["queue-one"]);

  const recentQueueHarness = createServiceWorkerHarness(validStorage({
    templates: [
      { id: "recent-a", name: "A", content: "A", autoSend: false },
      { id: "recent-b", name: "B", content: "B", autoSend: false },
    ],
    recentTemplateIds: [],
  }));
  await recentQueueHarness.waitForMigration();
  await Promise.all([
    recentQueueHarness.handleMessage({ type: workspaceContract.MESSAGE_TYPES.RECENT_TEMPLATE_TOUCH, templateId: "recent-a" }, queueSender),
    recentQueueHarness.handleMessage({ type: workspaceContract.MESSAGE_TYPES.RECENT_TEMPLATE_TOUCH, templateId: "recent-b" }, queueSender),
  ]);
  assert.deepEqual(recentQueueHarness.storage.recentTemplateIds, ["recent-b", "recent-a"]);
  await Promise.all([
    recentQueueHarness.handleMessage({
      type: workspaceContract.MESSAGE_TYPES.TEMPLATE_CREATE,
      template: { id: "recent-c", name: "C", content: "C", autoSend: false },
    }, queueSender),
    recentQueueHarness.handleMessage({ type: workspaceContract.MESSAGE_TYPES.RECENT_TEMPLATE_TOUCH, templateId: "recent-c" }, queueSender),
  ]);
  assert.equal(recentQueueHarness.storage.templates.some((item) => item.id === "recent-c"), true);
  assert.deepEqual(recentQueueHarness.storage.recentTemplateIds, ["recent-c", "recent-b", "recent-a"]);

  const settingsQueueHarness = createServiceWorkerHarness(validStorage({
    settings: { ...workspaceContract.DEFAULT_ACTIVE_SETTINGS, theme: "graphite", wallpaperDataUrl: "data:image/png;base64,AA==" },
  }));
  await settingsQueueHarness.waitForMigration();
  const independentSettings = await Promise.all([
    settingsQueueHarness.handleMessage({ type: workspaceContract.MESSAGE_TYPES.SETTINGS_UPDATE, patch: { theme: "gold" } }, queueSender),
    settingsQueueHarness.handleMessage({ type: workspaceContract.MESSAGE_TYPES.SETTINGS_UPDATE, patch: { layout: { sidebarWidth: 430 } } }, queueSender),
    settingsQueueHarness.handleMessage({ type: workspaceContract.MESSAGE_TYPES.SETTINGS_UPDATE, patch: { wallpaperDataUrl: null } }, queueSender),
    settingsQueueHarness.handleMessage({ type: workspaceContract.MESSAGE_TYPES.SETTINGS_UPDATE, patch: { closePanelAfterRun: false } }, queueSender),
    settingsQueueHarness.handleMessage({ type: workspaceContract.MESSAGE_TYPES.SETTINGS_UPDATE, patch: { closePanelOnOutsideClick: false } }, queueSender),
  ]);
  assert.equal(independentSettings.every((response) => response.ok), true);
  assert.equal(settingsQueueHarness.storage.settings.theme, "gold");
  assert.equal(settingsQueueHarness.storage.settings.layout.sidebarWidth, 430);
  assert.equal(settingsQueueHarness.storage.settings.wallpaperDataUrl, null);
  assert.equal(settingsQueueHarness.storage.settings.closePanelAfterRun, false);
  assert.equal(settingsQueueHarness.storage.settings.closePanelOnOutsideClick, false);
  assert.deepEqual(independentSettings.at(-1).settings, settingsQueueHarness.storage.settings);

  const wallpaperFailureHarness = createServiceWorkerHarness(validStorage({
    settings: {
      ...workspaceContract.DEFAULT_ACTIVE_SETTINGS,
      wallpaperDataUrl: "data:image/png;base64,PREVIOUS",
    },
  }));
  await wallpaperFailureHarness.waitForMigration();
  wallpaperFailureHarness.injectLocalSetFailure(
    (changes) => changes.settings?.wallpaperDataUrl === "data:image/png;base64,NEXT",
    new Error("QUOTA_BYTES quota exceeded"),
  );
  await assert.rejects(() => wallpaperFailureHarness.handleMessage({
    type: workspaceContract.MESSAGE_TYPES.SETTINGS_UPDATE,
    patch: { wallpaperDataUrl: "data:image/png;base64,NEXT" },
  }, queueSender), /quota exceeded/i);
  assert.equal(wallpaperFailureHarness.storage.settings.wallpaperDataUrl, "data:image/png;base64,PREVIOUS");

  const sameLeafResults = await Promise.all([
    settingsQueueHarness.handleMessage({ type: workspaceContract.MESSAGE_TYPES.SETTINGS_UPDATE, patch: { theme: "navy" } }, queueSender),
    settingsQueueHarness.handleMessage({ type: workspaceContract.MESSAGE_TYPES.SETTINGS_UPDATE, patch: { theme: "violet" } }, queueSender),
  ]);
  assert.equal(sameLeafResults[0].settings.theme, "navy");
  assert.equal(sameLeafResults[1].settings.theme, "violet");
  assert.equal(settingsQueueHarness.storage.settings.theme, "violet");
  assert.equal((await settingsQueueHarness.handleMessage({
    type: workspaceContract.MESSAGE_TYPES.SETTINGS_UPDATE,
    settings: { ...workspaceContract.DEFAULT_ACTIVE_SETTINGS, theme: "gold" },
  }, queueSender)).error.code, "INVALID_SETTINGS_PATCH");
  assert.equal((await settingsQueueHarness.handleMessage({
    type: workspaceContract.MESSAGE_TYPES.SETTINGS_UPDATE,
    patch: { analysis: { unknown: true } },
  }, queueSender)).error.code, "INVALID_SETTINGS_PATCH");

  const localBeforeImportHarness = createServiceWorkerHarness(validStorage());
  await localBeforeImportHarness.waitForMigration();
  const pausedLocalWriter = localBeforeImportHarness.pauseLocalSet((changes) => Object.prototype.hasOwnProperty.call(changes, "templates"));
  const localWriter = localBeforeImportHarness.handleMessage({
    type: workspaceContract.MESSAGE_TYPES.TEMPLATE_CREATE,
    template: { id: "before-import", name: "Before", content: "Before", autoSend: false },
  }, queueSender);
  await pausedLocalWriter.entered;
  const importBehindLocalWriter = await localBeforeImportHarness.handleMessage(mergeDataMessage, optionsSender);
  assert.equal(importBehindLocalWriter.ok, false);
  assert.equal(importBehindLocalWriter.error.code, "IMPORT_LOCKED");
  pausedLocalWriter.release();
  assert.equal((await localWriter).ok, true);

  const failedLocalWriterHarness = createServiceWorkerHarness(validStorage());
  await failedLocalWriterHarness.waitForMigration();
  failedLocalWriterHarness.injectLocalSetFailure(
    (changes) => changes.settings?.theme === "navy",
    new Error("queued local failure"),
  );
  const failureThenSuccess = await Promise.allSettled([
    failedLocalWriterHarness.handleMessage({ type: workspaceContract.MESSAGE_TYPES.SETTINGS_UPDATE, patch: { theme: "navy" } }, queueSender),
    failedLocalWriterHarness.handleMessage({ type: workspaceContract.MESSAGE_TYPES.SETTINGS_UPDATE, patch: { layout: { sidebarWidth: 440 } } }, queueSender),
  ]);
  assert.equal(failureThenSuccess[0].status, "rejected");
  assert.equal(failureThenSuccess[1].status, "fulfilled");
  assert.equal(failureThenSuccess[1].value.ok, true);
  assert.equal(failedLocalWriterHarness.storage.settings.theme, "system");
  assert.equal(failedLocalWriterHarness.storage.settings.layout.sidebarWidth, 440);

  const mutationFirstHarness = createServiceWorkerHarness(validStorage());
  await mutationFirstHarness.waitForMigration();
  const mutationFirstSender = { tab: { id: 307, url: "https://chatgpt.com/c/mutation-first" }, url: "https://chatgpt.com/c/mutation-first" };
  const mutationFirstContext = await mutationFirstHarness.handleMessage({
    type: workspaceContract.MESSAGE_TYPES.GET_CONTEXT,
    pageUrl: mutationFirstSender.url,
  }, mutationFirstSender);
  const pausedSave = mutationFirstHarness.pauseWorkspaceMethod("saveSelection");
  const savingBeforeImport = mutationFirstHarness.handleMessage({
    type: workspaceContract.MESSAGE_TYPES.SAVE_SELECTION,
    conversationScope: mutationFirstContext.context.scopeKey,
    text: "Мутация началась первой",
  }, mutationFirstSender);
  await pausedSave.entered;
  const importDuringMutation = await mutationFirstHarness.handleMessage(mergeDataMessage, optionsSender);
  assert.equal(importDuringMutation.ok, false);
  assert.equal(importDuringMutation.error.code, "IMPORT_LOCKED");
  assert.equal(await mutationFirstHarness.memoryWorkspace.getImportBackup("data"), null);
  pausedSave.release();
  assert.equal((await savingBeforeImport).ok, true);
  assert.equal(mutationFirstHarness.memoryWorkspace.snapshot().savedItems.some((item) => item.text === "Мутация началась первой"), true);

  const barrierHarness = createServiceWorkerHarness(validStorage(), {
    keyConfigured: true,
    openRouterClient: {
      async analyze() {
        return { ok: true, terms: [{ term: "state", normalizedTerm: "state", translation: "состояние", definition: "Состояние системы." }] };
      },
    },
  });
  await barrierHarness.waitForMigration();
  const barrierSender = { tab: { id: 306, url: "https://chatgpt.com/c/barrier" }, url: "https://chatgpt.com/c/barrier" };
  const barrierContext = await barrierHarness.handleMessage({
    type: workspaceContract.MESSAGE_TYPES.GET_CONTEXT,
    pageUrl: barrierSender.url,
  }, barrierSender);
  const barrierTerms = await barrierHarness.memoryWorkspace.addAnalysisTerms([{
    term: "barrier", translation: "барьер", definition: "Граница мутации.",
  }], barrierContext.context.scopeKey);
  await barrierHarness.handleMessage({
    type: workspaceContract.MESSAGE_TYPES.SAVE_SELECTION,
    conversationScope: barrierContext.context.scopeKey,
    text: "Исходный сохранённый текст",
  }, barrierSender);
  const beforeBarrierWorkspace = await barrierHarness.memoryWorkspace.snapshotUserData();
  const beforeBarrierStorage = clone(barrierHarness.storage);
  const pausedMerge = barrierHarness.pauseWorkspaceMethod("mergeUserData", new Error("forced merge rollback"));
  const applyingWithBarrier = barrierHarness.handleMessage(mergeDataMessage, optionsSender);
  await pausedMerge.entered;
  const blockedMutations = await Promise.all([
    barrierHarness.handleMessage({
      type: workspaceContract.MESSAGE_TYPES.ATTACH_GLOSSARY_SENSE,
      conversationScope: barrierContext.context.scopeKey,
      senseId: barrierTerms.results[0].id,
    }, barrierSender),
    barrierHarness.handleMessage({
      type: workspaceContract.MESSAGE_TYPES.SAVE_SELECTION,
      conversationScope: barrierContext.context.scopeKey,
      text: "Не должно сохраниться",
    }, barrierSender),
    barrierHarness.handleMessage({
      type: workspaceContract.MESSAGE_TYPES.TEMPLATE_CREATE,
      template: { id: "blocked-template", name: "Blocked", content: "Blocked", autoSend: false },
    }, barrierSender),
    barrierHarness.handleMessage({
      type: workspaceContract.MESSAGE_TYPES.TEMPLATE_UPDATE,
      templateId: "template-1",
      patch: { name: "Blocked edit" },
    }, barrierSender),
    barrierHarness.handleMessage({ type: workspaceContract.MESSAGE_TYPES.TEMPLATE_DELETE, templateId: "template-1" }, barrierSender),
    barrierHarness.handleMessage({ type: workspaceContract.MESSAGE_TYPES.TEMPLATE_REORDER, templateIds: ["template-1"] }, barrierSender),
    barrierHarness.handleMessage({ type: workspaceContract.MESSAGE_TYPES.RECENT_TEMPLATE_TOUCH, templateId: "template-1" }, barrierSender),
    barrierHarness.handleMessage({
      type: workspaceContract.MESSAGE_TYPES.SETTINGS_UPDATE,
      patch: { theme: "violet" },
    }, barrierSender),
  ]);
  assert.equal(blockedMutations.every((response) => response.ok === false && response.error.code === "MUTATION_BUSY"), true);
  assert.match(blockedMutations[0].error.message, /Повторите изменение позже/);
  const analysisWhileImporting = await barrierHarness.handleMessage({
    type: contract.MESSAGE_TYPES.ANALYZE_SELECTED_TERMS,
    snapshot: {
      requestId: "analysis-barrier-01",
      trigger: "browser-command",
      text: "state",
      pageUrl: barrierSender.url,
      createdAt: 1,
    },
  }, barrierSender);
  assert.equal(analysisWhileImporting.ok, true);
  assert.equal(analysisWhileImporting.mutationBusy, true);
  assert.equal(analysisWhileImporting.storageWarning, true);
  assert.equal(analysisWhileImporting.terms[0].status, "unsaved");
  assert.equal((await barrierHarness.handleMessage({
    type: contract.MESSAGE_TYPES.SET_KEY,
    apiKey: "barrier-safe-secret-value",
  }, optionsSender)).ok, true);
  assert.equal((await barrierHarness.handleMessage({
    type: workspaceContract.MESSAGE_TYPES.EXPORT_SETTINGS,
  }, optionsSender)).ok, true);
  assert.deepEqual(await barrierHarness.memoryWorkspace.snapshotUserData(), beforeBarrierWorkspace);
  assert.deepEqual(barrierHarness.storage.templates, beforeBarrierStorage.templates);
  assert.deepEqual(barrierHarness.storage.settings, beforeBarrierStorage.settings);
  pausedMerge.release();
  const rolledBackBarrier = await applyingWithBarrier;
  assert.equal(rolledBackBarrier.rolledBack, true);
  assert.deepEqual(await barrierHarness.memoryWorkspace.snapshotUserData(), beforeBarrierWorkspace);
  assert.deepEqual(barrierHarness.storage.templates, beforeBarrierStorage.templates);
  assert.deepEqual(barrierHarness.storage.settings, beforeBarrierStorage.settings);

  const backupFailureHarness = createServiceWorkerHarness(validStorage());
  await backupFailureHarness.waitForMigration();
  backupFailureHarness.injectWorkspaceFailure("putImportBackup", new Error("backup failure"));
  const backupFailure = await backupFailureHarness.handleMessage(mergeDataMessage, optionsSender);
  assert.equal(backupFailure.ok, false);
  assert.equal(backupFailure.error.code, "DATA_IMPORT_FAILED");
  assert.equal(await backupFailureHarness.memoryWorkspace.getMetaValue("dataImportOperation"), null);
  assert.deepEqual(backupFailureHarness.storage.templates, validStorage().templates);

  const markerFailureHarness = createServiceWorkerHarness(validStorage());
  await markerFailureHarness.waitForMigration();
  markerFailureHarness.injectWorkspaceFailure("setMetaValue", new Error("marker failure"));
  const markerFailure = await markerFailureHarness.handleMessage(mergeDataMessage, optionsSender);
  assert.equal(markerFailure.ok, false);
  assert.equal(markerFailure.error.code, "DATA_IMPORT_FAILED");
  assert.equal(markerFailureHarness.memoryWorkspace.snapshot().conversations.length, 0);
  assert.deepEqual(markerFailureHarness.storage.templates, validStorage().templates);

  const mergeFailureHarness = createServiceWorkerHarness(validStorage());
  await mergeFailureHarness.waitForMigration();
  mergeFailureHarness.injectWorkspaceFailure("mergeUserData", new Error("merge failure"));
  const mergeFailure = await mergeFailureHarness.handleMessage(mergeDataMessage, optionsSender);
  assert.equal(mergeFailure.rolledBack, true);
  assert.equal(await mergeFailureHarness.memoryWorkspace.getMetaValue("dataImportOperation"), null);
  assert.deepEqual(mergeFailureHarness.storage.templates, validStorage().templates);

  const replaceFailureHarness = createServiceWorkerHarness(validStorage());
  await replaceFailureHarness.waitForMigration();
  replaceFailureHarness.injectWorkspaceFailure("replaceUserData", new Error("replace failure"));
  const replaceFailure = await replaceFailureHarness.handleMessage(replaceDataMessage, optionsSender);
  assert.equal(replaceFailure.rolledBack, true);
  assert.equal(await replaceFailureHarness.memoryWorkspace.getMetaValue("dataImportOperation"), null);

  const templateFailureHarness = createServiceWorkerHarness(validStorage());
  await templateFailureHarness.waitForMigration();
  templateFailureHarness.injectLocalSetFailure((changes) => Object.prototype.hasOwnProperty.call(changes, "templates"), new Error("template failure"));
  const templateFailure = await templateFailureHarness.handleMessage(mergeDataMessage, optionsSender);
  assert.equal(templateFailure.rolledBack, true);
  assert.deepEqual(templateFailureHarness.storage.templates, validStorage().templates);
  assert.equal(await templateFailureHarness.memoryWorkspace.getMetaValue("dataImportOperation"), null);

  const verificationFailureHarness = createServiceWorkerHarness(validStorage());
  await verificationFailureHarness.waitForMigration();
  let templateReadCount = 0;
  verificationFailureHarness.injectLocalGetTransform(
    (names) => names.includes("templates") && ++templateReadCount === 2,
    (result) => ({ ...result, templates: [] }),
  );
  const verificationFailure = await verificationFailureHarness.handleMessage(mergeDataMessage, optionsSender);
  assert.equal(verificationFailure.rolledBack, true);
  assert.deepEqual(verificationFailureHarness.storage.templates, validStorage().templates);

  const orderedTemplates = [
    { id: "template-z", name: "Z", content: "Z", autoSend: false },
    { id: "template-a", name: "A", content: "A", autoSend: false },
  ];
  const orderedRollbackHarness = createServiceWorkerHarness(validStorage({ templates: orderedTemplates, recentTemplateIds: ["template-z"] }));
  await orderedRollbackHarness.waitForMigration();
  const orderedExport = await orderedRollbackHarness.handleMessage({
    type: workspaceContract.MESSAGE_TYPES.EXPORT_DATA,
  }, optionsSender);
  assert.deepEqual(JSON.parse(orderedExport.text).payload.templates.map((item) => item.id), ["template-z", "template-a"]);
  let orderedTemplateReadCount = 0;
  orderedRollbackHarness.injectLocalGetTransform(
    (names) => names.includes("templates") && ++orderedTemplateReadCount === 2,
    (result) => ({ ...result, templates: [] }),
  );
  const orderedRollback = await orderedRollbackHarness.handleMessage(mergeDataMessage, optionsSender);
  assert.equal(orderedRollback.rolledBack, true);
  assert.deepEqual(orderedRollbackHarness.storage.templates.map((item) => item.id), ["template-z", "template-a"]);
  assert.deepEqual(orderedRollbackHarness.storage.recentTemplateIds, ["template-z"]);

  async function seedInterruptedDataImport(harness, phase, mutateTemplates) {
    const workspaceSnapshot = await harness.memoryWorkspace.snapshotUserData();
    await harness.memoryWorkspace.putImportBackup("data", {
      templates: clone(harness.storage.templates),
      recentTemplateIds: clone(harness.storage.recentTemplateIds),
      workspace: workspaceSnapshot,
    });
    await harness.memoryWorkspace.setMetaValue("dataImportOperation", {
      operationId: `restart-${phase}`,
      kind: "data",
      mode: "replace",
      phase,
      startedAt: 1,
    });
    const interruptedWorkspace = clone(workspaceSnapshot);
    interruptedWorkspace.savedItems = [{ id: `interrupted-${phase}`, text: "partial", normalizedTextKey: "partial", createdAt: 1, updatedAt: 1 }];
    await harness.memoryWorkspace.replaceUserData(interruptedWorkspace);
    if (mutateTemplates) harness.storage.templates = clone(importedDataState.templates);
  }

  const workspacePhaseHarness = createServiceWorkerHarness(validStorage());
  await workspacePhaseHarness.waitForMigration();
  await seedInterruptedDataImport(workspacePhaseHarness, "workspace-applied", false);
  workspacePhaseHarness.sessionStorage["chatgpt-helper:import-lock"] = {
    operationId: "restart-workspace-applied",
    kind: "data",
    expiresAt: Date.now() + 60000,
  };
  await workspacePhaseHarness.recoverPendingImports();
  assert.equal(workspacePhaseHarness.memoryWorkspace.snapshot().savedItems.length, 0);
  assert.deepEqual(workspacePhaseHarness.storage.templates, validStorage().templates);
  assert.equal(await workspacePhaseHarness.memoryWorkspace.getMetaValue("dataImportOperation"), null);
  assert.equal(Object.prototype.hasOwnProperty.call(workspacePhaseHarness.sessionStorage, "chatgpt-helper:import-lock"), false);
  assert.equal((await workspacePhaseHarness.handleMessage(settingsMessage, optionsSender)).ok, true);

  const settingsRecoveryHarness = createServiceWorkerHarness(validStorage());
  await settingsRecoveryHarness.waitForMigration();
  await settingsRecoveryHarness.memoryWorkspace.putImportBackup("settings", clone(settingsRecoveryHarness.storage.settings));
  await settingsRecoveryHarness.memoryWorkspace.setMetaValue("settingsImportOperation", {
    operationId: "restart-settings",
    kind: "settings",
    phase: "prepared",
    startedAt: 1,
  });
  settingsRecoveryHarness.storage.settings = { ...settingsRecoveryHarness.storage.settings, theme: "gold" };
  settingsRecoveryHarness.sessionStorage["chatgpt-helper:import-lock"] = {
    operationId: "restart-settings",
    kind: "settings",
    expiresAt: Date.now() + 60000,
  };
  await settingsRecoveryHarness.recoverPendingImports();
  assert.equal(settingsRecoveryHarness.storage.settings.theme, "system");
  assert.equal(await settingsRecoveryHarness.memoryWorkspace.getMetaValue("settingsImportOperation"), null);
  assert.equal(Object.prototype.hasOwnProperty.call(settingsRecoveryHarness.sessionStorage, "chatgpt-helper:import-lock"), false);

  for (const lock of [
    { operationId: "startup-expired", expiresAt: Date.now() - 1 },
    { operationId: "startup-unexpired-orphan", expiresAt: Date.now() + 60000 },
  ]) {
    const orphanLockHarness = createServiceWorkerHarness(validStorage());
    orphanLockHarness.sessionStorage["chatgpt-helper:import-lock"] = lock;
    await orphanLockHarness.waitForMigration();
    assert.equal(Object.prototype.hasOwnProperty.call(orphanLockHarness.sessionStorage, "chatgpt-helper:import-lock"), false);
  }

  const unrelatedOwnerHarness = createServiceWorkerHarness(validStorage());
  await unrelatedOwnerHarness.waitForMigration();
  unrelatedOwnerHarness.sessionStorage["chatgpt-helper:import-lock"] = {
    operationId: "unrelated-live-owner",
    expiresAt: Date.now() + 60000,
  };
  unrelatedOwnerHarness.evaluate("activeImport = { operationId: 'unrelated-live-owner', kind: 'data' }");
  await unrelatedOwnerHarness.recoverPendingImports();
  assert.equal(unrelatedOwnerHarness.sessionStorage["chatgpt-helper:import-lock"].operationId, "unrelated-live-owner");
  unrelatedOwnerHarness.evaluate("activeImport = null");

  const deferReleaseRaceHarness = createServiceWorkerHarness(validStorage());
  await deferReleaseRaceHarness.waitForMigration();
  const deferReleaseSender = { tab: { id: 310, url: "https://chatgpt.com/" }, url: "https://chatgpt.com/" };
  const deferReleaseContext = await deferReleaseRaceHarness.handleMessage({
    type: workspaceContract.MESSAGE_TYPES.GET_CONTEXT,
    pageUrl: deferReleaseSender.url,
  }, deferReleaseSender);
  deferReleaseRaceHarness.evaluate("activeImport = { operationId: 'defer-release-race', kind: 'data' }");
  const pausedDeferredPersistence = deferReleaseRaceHarness.pauseSessionSet(
    (changes) => Object.prototype.hasOwnProperty.call(changes, "chatgpt-helper:deferred-orphan-tabs"),
  );
  await deferReleaseRaceHarness.runTabRemoved(deferReleaseSender.tab.id);
  await pausedDeferredPersistence.entered;
  deferReleaseRaceHarness.evaluate("activeImport = null");
  pausedDeferredPersistence.release();
  await deferReleaseRaceHarness.evaluate("deferredOrphanPersistence");
  const scheduledDeferredFlush = deferReleaseRaceHarness.evaluate("deferredOrphanFlushPromise");
  if (scheduledDeferredFlush) await scheduledDeferredFlush;
  assert.equal(deferReleaseRaceHarness.memoryWorkspace.snapshot().conversations.find(
    (item) => item.scopeKey === deferReleaseContext.context.scopeKey,
  ).orphanedAt > 0, true);
  assert.equal(Object.prototype.hasOwnProperty.call(
    deferReleaseRaceHarness.sessionStorage,
    "chatgpt-helper:deferred-orphan-tabs",
  ), false);

  const deferredPersistenceFailureHarness = createServiceWorkerHarness(validStorage());
  await deferredPersistenceFailureHarness.waitForMigration();
  const persistenceFailureSender = { tab: { id: 309, url: "https://chatgpt.com/" }, url: "https://chatgpt.com/" };
  const persistenceFailureContext = await deferredPersistenceFailureHarness.handleMessage({
    type: workspaceContract.MESSAGE_TYPES.GET_CONTEXT,
    pageUrl: persistenceFailureSender.url,
  }, persistenceFailureSender);
  deferredPersistenceFailureHarness.evaluate("activeImport = { operationId: 'deferred-persistence-failure', kind: 'data' }");
  deferredPersistenceFailureHarness.injectSessionSetFailure(
    (changes) => Object.prototype.hasOwnProperty.call(changes, "chatgpt-helper:deferred-orphan-tabs"),
    new Error("deferred session persistence failure"),
  );
  await deferredPersistenceFailureHarness.runTabRemoved(persistenceFailureSender.tab.id);
  await deferredPersistenceFailureHarness.evaluate("deferredOrphanPersistence");
  assert.deepEqual(
    deferredPersistenceFailureHarness.sessionStorage["chatgpt-helper:deferred-orphan-tabs"],
    [persistenceFailureSender.tab.id],
  );
  deferredPersistenceFailureHarness.evaluate("activeImport = null");
  await deferredPersistenceFailureHarness.evaluate("flushDeferredOrphans()");
  assert.equal(deferredPersistenceFailureHarness.memoryWorkspace.snapshot().conversations.find(
    (item) => item.scopeKey === persistenceFailureContext.context.scopeKey,
  ).orphanedAt > 0, true);
  assert.equal(Object.prototype.hasOwnProperty.call(
    deferredPersistenceFailureHarness.sessionStorage,
    "chatgpt-helper:deferred-orphan-tabs",
  ), false);

  const deferredRestartHarness = createServiceWorkerHarness(validStorage());
  await deferredRestartHarness.waitForMigration();
  const deferredSender = { tab: { id: 311, url: "https://chatgpt.com/" }, url: "https://chatgpt.com/" };
  const deferredContext = await deferredRestartHarness.handleMessage({
    type: workspaceContract.MESSAGE_TYPES.GET_CONTEXT,
    pageUrl: deferredSender.url,
  }, deferredSender);
  const pausedInterruptedImport = deferredRestartHarness.pauseWorkspaceMethod("mergeUserData");
  void deferredRestartHarness.handleMessage(mergeDataMessage, optionsSender);
  await pausedInterruptedImport.entered;
  await deferredRestartHarness.runTabRemoved(deferredSender.tab.id);
  await deferredRestartHarness.evaluate("deferredOrphanPersistence");
  assert.deepEqual(deferredRestartHarness.sessionStorage["chatgpt-helper:deferred-orphan-tabs"], [deferredSender.tab.id]);
  assert.equal(Object.prototype.hasOwnProperty.call(
    deferredRestartHarness.sessionStorage,
    `chatgpt-helper:temporary-context:${deferredSender.tab.id}`,
  ), true);

  const deferredReplayHarness = createServiceWorkerHarness(validStorage(), {
    sharedStorage: deferredRestartHarness.storage,
    sharedSessionStorage: deferredRestartHarness.sessionStorage,
    sharedWorkspace: deferredRestartHarness.memoryWorkspace,
  });
  deferredReplayHarness.injectWorkspaceFailure("orphanConversation", new Error("deferred orphan replay failure"));
  await deferredReplayHarness.waitForMigration();
  assert.deepEqual(deferredReplayHarness.sessionStorage["chatgpt-helper:deferred-orphan-tabs"], [deferredSender.tab.id]);
  assert.equal(deferredReplayHarness.memoryWorkspace.snapshot().conversations.find(
    (item) => item.scopeKey === deferredContext.context.scopeKey,
  ).orphanedAt, null);
  await deferredReplayHarness.evaluate("flushDeferredOrphans()");
  const replayedConversation = deferredReplayHarness.memoryWorkspace.snapshot().conversations.find(
    (item) => item.scopeKey === deferredContext.context.scopeKey,
  );
  assert.equal(replayedConversation.orphanedAt > 0, true);
  assert.equal(Object.prototype.hasOwnProperty.call(
    deferredReplayHarness.sessionStorage,
    `chatgpt-helper:temporary-context:${deferredSender.tab.id}`,
  ), false);
  assert.equal(Object.prototype.hasOwnProperty.call(
    deferredReplayHarness.sessionStorage,
    "chatgpt-helper:deferred-orphan-tabs",
  ), false);
  assert.equal(Object.prototype.hasOwnProperty.call(deferredReplayHarness.sessionStorage, "chatgpt-helper:import-lock"), false);

  const templatePhaseHarness = createServiceWorkerHarness(validStorage(), {
    tabs: [{ id: 29, url: "https://chatgpt.com/c/recovery-broadcast" }],
  });
  await templatePhaseHarness.waitForMigration();
  await seedInterruptedDataImport(templatePhaseHarness, "templates-applied", true);
  await templatePhaseHarness.recoverPendingImports();
  assert.equal(templatePhaseHarness.memoryWorkspace.snapshot().savedItems.length, 0);
  assert.deepEqual(templatePhaseHarness.storage.templates, validStorage().templates);
  assert.equal(await templatePhaseHarness.memoryWorkspace.getMetaValue("dataImportOperation"), null);
  assert.equal(templatePhaseHarness.tabMessages.some((item) => item.message.entityFamily === workspaceContract.ENTITY_FAMILIES.ALL), true);

  const workspaceRollbackFailureHarness = createServiceWorkerHarness(validStorage(), { keyConfigured: false });
  await workspaceRollbackFailureHarness.waitForMigration();
  await seedInterruptedDataImport(workspaceRollbackFailureHarness, "workspace-applied", false);
  workspaceRollbackFailureHarness.injectWorkspaceFailure("replaceUserData", new Error("rollback workspace failure"));
  workspaceRollbackFailureHarness.sessionStorage["chatgpt-helper:import-lock"] = {
    operationId: "restart-workspace-applied",
    expiresAt: Date.now() + 60000,
  };
  await assert.rejects(workspaceRollbackFailureHarness.recoverPendingImports(), /rollback workspace failure/);
  assert.notEqual(await workspaceRollbackFailureHarness.memoryWorkspace.getMetaValue("dataImportOperation"), null);
  assert.equal(workspaceRollbackFailureHarness.sessionStorage["chatgpt-helper:import-lock"].operationId, "restart-workspace-applied");
  const blockedNewImport = await workspaceRollbackFailureHarness.handleMessage(mergeDataMessage, optionsSender);
  assert.equal(blockedNewImport.recoveryRequired, true);
  assert.equal(blockedNewImport.error.code, "IMPORT_LOCKED");
  assert.equal((await workspaceRollbackFailureHarness.handleMessage({
    type: contract.MESSAGE_TYPES.SET_KEY,
    apiKey: "recovery-safe-secret-value",
  }, optionsSender)).ok, true);
  assert.equal((await workspaceRollbackFailureHarness.handleMessage({
    type: workspaceContract.MESSAGE_TYPES.EXPORT_SETTINGS,
  }, optionsSender)).ok, true);
  const blockedWorkspace = await workspaceRollbackFailureHarness.handleMessage({
    type: workspaceContract.MESSAGE_TYPES.GET_CONTEXT,
    pageUrl: "https://chatgpt.com/c/recovery-blocked",
  }, { tab: { id: 31, url: "https://chatgpt.com/c/recovery-blocked" }, url: "https://chatgpt.com/c/recovery-blocked" });
  assert.equal(blockedWorkspace.ok, false);
  assert.equal(blockedWorkspace.error.code, "RECOVERY_REQUIRED");

  const templateRollbackFailureHarness = createServiceWorkerHarness(validStorage());
  await templateRollbackFailureHarness.waitForMigration();
  await seedInterruptedDataImport(templateRollbackFailureHarness, "templates-applied", true);
  templateRollbackFailureHarness.injectLocalSetFailure((changes) => Object.prototype.hasOwnProperty.call(changes, "templates"), new Error("rollback template failure"));
  await assert.rejects(templateRollbackFailureHarness.recoverPendingImports(), /rollback template failure/);
  assert.notEqual(await templateRollbackFailureHarness.memoryWorkspace.getMetaValue("dataImportOperation"), null);

  const successfulDataApplyHarness = createServiceWorkerHarness(validStorage(), {
    tabs: [{ id: 32, url: "https://chatgpt.com/c/import-broadcast" }],
  });
  await successfulDataApplyHarness.waitForMigration();
  const successfulDataApply = await successfulDataApplyHarness.handleMessage(mergeDataMessage, optionsSender);
  assert.equal(successfulDataApply.ok, true);
  assert.equal(successfulDataApplyHarness.storage.templates.some((item) => item.id === "imported-template"), true);
  assert.equal(successfulDataApplyHarness.tabMessages.filter((item) => item.message.entityFamily === workspaceContract.ENTITY_FAMILIES.ALL).length, 1);

  const temporaryImportText = importExport.createDataExport({
    templates: [],
    conversations: [{ id: "portable-temporary", kind: "temporary", host: "chatgpt.com", remoteConversationId: null, createdAt: 1, lastSeenAt: 2, orphanedAt: 2 }],
    glossaryConcepts: [],
    glossarySenses: [],
    glossaryLinks: [],
    savedItems: [{ id: "portable-saved", text: "Portable saved", createdAt: 1, updatedAt: 2 }],
    savedItemLinks: [{ id: "portable-saved-link", itemId: "portable-saved", conversationId: "portable-temporary", localOrder: 0, firstSeenAt: 1, lastSeenAt: 2 }],
  }, {
    datasetId: "bbbbbbbb-cccc-4ddd-8eee-ffffffffffff",
    exportedAt: "2026-07-18T12:00:00.000Z",
  }).text;
  const temporaryImportMessage = {
    type: workspaceContract.MESSAGE_TYPES.IMPORT_DATA_APPLY,
    text: temporaryImportText,
    mode: "merge",
  };
  const temporaryImportHarness = createServiceWorkerHarness(validStorage());
  await temporaryImportHarness.waitForMigration();
  assert.equal((await temporaryImportHarness.handleMessage(temporaryImportMessage, optionsSender)).ok, true);
  assert.equal((await temporaryImportHarness.handleMessage(temporaryImportMessage, optionsSender)).ok, true);
  assert.equal((await temporaryImportHarness.handleMessage(temporaryImportMessage, optionsSender)).ok, true);
  assert.equal(temporaryImportHarness.memoryWorkspace.snapshot().conversations.filter((item) => item.kind === "temporary").length, 1);
  assert.equal(temporaryImportHarness.memoryWorkspace.snapshot().savedItemLinks.length, 1);
  assert.equal(Object.keys(temporaryImportHarness.sessionStorage).some((key) => key.includes("temporary-context")), false);

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

  const reconnectStatus = createServiceWorkerHarness(validStorage(), {
    keyConfigured: true,
    tabs: [{ id: 51, url: "https://chatgpt.com/c/reconnected" }],
  });
  await reconnectStatus.runStartup();
  assert.deepEqual(reconnectStatus.tabMessages, [{
    tabId: 51,
    message: { type: contract.MESSAGE_TYPES.KEY_STATUS_CHANGED, configured: true },
  }]);

  const migrationFailureDoesNotBlockKeyStatus = createServiceWorkerHarness(validStorage({
    glossarySchemaVersion: glossary.SCHEMA_VERSION + 1,
  }), { keyConfigured: true });
  assert.deepEqual(await migrationFailureDoesNotBlockKeyStatus.handleMessage({
    type: contract.MESSAGE_TYPES.GET_KEY_STATUS,
  }, optionsSender), { ok: true, configured: true });
  const unavailableSender = { tab: { id: 59, url: "https://chatgpt.com/" }, url: "https://chatgpt.com/" };
  const unavailableContext = await migrationFailureDoesNotBlockKeyStatus.handleMessage({
    type: workspaceContract.MESSAGE_TYPES.GET_CONTEXT,
    pageUrl: "https://chatgpt.com/",
  }, unavailableSender);
  assert.equal(unavailableContext.ok, false);
  assert.deepEqual(unavailableContext.error, {
    code: "WORKSPACE_MIGRATION_FAILED",
    message: "Не удалось подготовить рабочее пространство. Данные словаря V1 не изменены.",
  });
  assert.equal(migrationFailureDoesNotBlockKeyStatus.storage.glossarySchemaVersion, glossary.SCHEMA_VERSION + 1);
  const failedMigrationMarkerHarness = createServiceWorkerHarness(validStorage({
    glossarySchemaVersion: glossary.SCHEMA_VERSION + 1,
  }));
  await assert.rejects(failedMigrationMarkerHarness.waitForMigration(), /Unsupported future glossary schema/);
  await failedMigrationMarkerHarness.memoryWorkspace.setMetaValue("dataImportOperation", { operationId: "pending-recovery", phase: "workspace-applied" });
  const localMutationBehindMarker = await failedMigrationMarkerHarness.handleMessage({
    type: workspaceContract.MESSAGE_TYPES.SETTINGS_UPDATE,
    patch: { theme: "gold" },
  }, unavailableSender);
  assert.equal(localMutationBehindMarker.ok, false);
  assert.equal(localMutationBehindMarker.error.code, "RECOVERY_REQUIRED");
  const analysisDuringWorkspaceFailure = createServiceWorkerHarness(validStorage({
    glossarySchemaVersion: glossary.SCHEMA_VERSION + 1,
    glossaryEntries: [{ id: "legacy-kept" }],
  }), {
    keyConfigured: true,
    openRouterClient: {
      async analyze() {
        return { ok: true, terms: [{
          term: "state",
          normalizedTerm: "state",
          translation: "состояние",
          definition: "Состояние системы.",
        }] };
      },
    },
  });
  const unavailableAnalysis = await analysisDuringWorkspaceFailure.handleMessage({
    type: contract.MESSAGE_TYPES.ANALYZE_SELECTED_TERMS,
    snapshot: {
      requestId: "analysis-unavailable-01",
      trigger: "browser-command",
      text: "state",
      pageUrl: "https://chatgpt.com/",
      createdAt: 1,
    },
  }, unavailableSender);
  assert.equal(unavailableAnalysis.ok, true);
  assert.equal(unavailableAnalysis.workspaceUnavailable, true);
  assert.equal(unavailableAnalysis.storageWarning, true);
  assert.equal(unavailableAnalysis.terms[0].status, "unsaved");
  assert.deepEqual(analysisDuringWorkspaceFailure.storage.glossaryEntries, [{ id: "legacy-kept" }]);
  assert.equal(analysisDuringWorkspaceFailure.memoryWorkspace.snapshot().glossarySenses.length, 0);

  const analyzedTerms = [{
    term: "state",
    normalizedTerm: "state",
    translation: "состояние",
    definition: "Состояние системы.",
  }];
  let recoveredProviderCalls = 0;
  const contextFailureHarness = createServiceWorkerHarness(validStorage(), {
    keyConfigured: true,
    contextResolutionFailures: 1,
    openRouterClient: {
      async analyze() {
        recoveredProviderCalls += 1;
        return { ok: true, terms: clone(analyzedTerms) };
      },
    },
  });
  await contextFailureHarness.waitForMigration();
  const contextFailureSender = {
    tab: { id: 58, url: "https://chatgpt.com/c/context-recovery" },
    url: "https://chatgpt.com/c/context-recovery",
  };
  const contextUnavailableAnalysis = await contextFailureHarness.handleMessage({
    type: contract.MESSAGE_TYPES.ANALYZE_SELECTED_TERMS,
    snapshot: {
      requestId: "context-unavailable-01",
      trigger: "browser-command",
      text: "state",
      pageUrl: contextFailureSender.tab.url,
      createdAt: 1,
    },
  }, contextFailureSender);
  assert.equal(contextUnavailableAnalysis.ok, true);
  assert.equal(contextUnavailableAnalysis.workspaceUnavailable, true);
  assert.equal(contextUnavailableAnalysis.storageWarning, true);
  assert.equal(contextUnavailableAnalysis.terms[0].status, "unsaved");
  assert.equal(contextUnavailableAnalysis.error?.code, undefined);
  assert.equal(contextFailureHarness.analysisTermWriteCalls(), 0);
  assert.equal(recoveredProviderCalls, 1);
  assert.equal(contextFailureHarness.evaluate("activeRequests.size"), 0);
  assert.equal(Object.keys(contextFailureHarness.sessionStorage).some((key) => key.includes("analysis-lock")), false);

  const recoveredAnalysis = await contextFailureHarness.handleMessage({
    type: contract.MESSAGE_TYPES.ANALYZE_SELECTED_TERMS,
    snapshot: {
      requestId: "context-recovered-02",
      trigger: "browser-command",
      text: "state",
      pageUrl: contextFailureSender.tab.url,
      createdAt: 2,
    },
  }, contextFailureSender);
  assert.equal(recoveredAnalysis.ok, true);
  assert.equal(recoveredAnalysis.workspaceUnavailable, false);
  assert.equal(recoveredAnalysis.storageWarning, false);
  assert.equal(recoveredAnalysis.terms[0].status, "new");
  assert.equal(contextFailureHarness.analysisTermWriteCalls(), 1);
  assert.equal(recoveredProviderCalls, 2);
  assert.equal(contextFailureHarness.evaluate("activeRequests.size"), 0);

  const providerAfterContextFailure = createServiceWorkerHarness(validStorage(), {
    keyConfigured: true,
    contextResolutionFailures: 1,
    openRouterClient: {
      async analyze() {
        return { ok: false, error: contract.makeError("NETWORK_ERROR") };
      },
    },
  });
  await providerAfterContextFailure.waitForMigration();
  const providerFailureResponse = await providerAfterContextFailure.handleMessage({
    type: contract.MESSAGE_TYPES.ANALYZE_SELECTED_TERMS,
    snapshot: {
      requestId: "context-provider-failure-01",
      trigger: "browser-command",
      text: "state",
      pageUrl: contextFailureSender.tab.url,
      createdAt: 3,
    },
  }, contextFailureSender);
  assert.equal(providerFailureResponse.ok, false);
  assert.equal(providerFailureResponse.error.code, "NETWORK_ERROR");
  assert.equal(providerAfterContextFailure.analysisTermWriteCalls(), 0);
  assert.equal(providerAfterContextFailure.evaluate("activeRequests.size"), 0);

  let missingKeyProviderCalls = 0;
  const missingKeyAfterContextFailure = createServiceWorkerHarness(validStorage(), {
    contextResolutionFailures: 1,
    openRouterClient: {
      async analyze() {
        missingKeyProviderCalls += 1;
        return { ok: true, terms: clone(analyzedTerms) };
      },
    },
  });
  await missingKeyAfterContextFailure.waitForMigration();
  const missingKeyResponse = await missingKeyAfterContextFailure.handleMessage({
    type: contract.MESSAGE_TYPES.ANALYZE_SELECTED_TERMS,
    snapshot: {
      requestId: "context-key-missing-01",
      trigger: "browser-command",
      text: "state",
      pageUrl: contextFailureSender.tab.url,
      createdAt: 4,
    },
  }, contextFailureSender);
  assert.equal(missingKeyResponse.ok, false);
  assert.equal(missingKeyResponse.error.code, "API_KEY_MISSING");
  assert.equal(missingKeyProviderCalls, 0);
  assert.equal(missingKeyAfterContextFailure.analysisTermWriteCalls(), 0);
  assert.equal(missingKeyAfterContextFailure.evaluate("activeRequests.size"), 0);

  const workspaceHarness = createServiceWorkerHarness(validStorage(), {
    tabs: [
      { id: 61, url: "https://chatgpt.com/c/workspace-one" },
      { id: 62, url: "https://example.com/unsupported" },
      { id: 63, url: "https://chat.openai.com/c/workspace-two" },
    ],
    failingTabIds: [61],
  });
  const temporarySender = { tab: { id: 60, url: "https://chatgpt.com/" }, url: "https://chatgpt.com/" };
  const firstContext = await workspaceHarness.handleMessage({
    type: workspaceContract.MESSAGE_TYPES.GET_CONTEXT,
    pageUrl: "https://chatgpt.com/",
  }, temporarySender);
  const reusedContext = await workspaceHarness.handleMessage({
    type: workspaceContract.MESSAGE_TYPES.GET_CONTEXT,
    pageUrl: "https://chatgpt.com/",
  }, temporarySender);
  assert.equal(firstContext.ok, true);
  assert.match(firstContext.context.scopeKey, /^temporary:/);
  assert.equal(reusedContext.context.id, firstContext.context.id);

  const saved = await workspaceHarness.handleMessage({
    type: workspaceContract.MESSAGE_TYPES.SAVE_SELECTION,
    conversationScope: firstContext.context.scopeKey,
    text: "Immutable\n\nselection snapshot",
  }, temporarySender);
  assert.equal(saved.ok, true);
  assert.deepEqual(workspaceHarness.tabMessages.map((item) => item.tabId), [61, 63]);
  workspaceHarness.tabMessages.forEach((item) => {
    assert.deepEqual(Object.keys(item.message).sort(), ["conversationScope", "entityFamily", "revision", "type"]);
    assert.equal(item.message.type, workspaceContract.MESSAGE_TYPES.CHANGED);
    assert.equal(item.message.entityFamily, workspaceContract.ENTITY_FAMILIES.SAVED);
    assert.equal(JSON.stringify(item.message).includes("Immutable"), false);
  });

  const stableSender = {
    tab: { id: 60, url: "https://chatgpt.com/c/workspace-stable" },
    url: "https://chatgpt.com/c/workspace-stable",
  };
  const stableContext = await workspaceHarness.handleMessage({
    type: workspaceContract.MESSAGE_TYPES.GET_CONTEXT,
    pageUrl: stableSender.tab.url,
  }, stableSender);
  assert.equal(stableContext.context.scopeKey, "stable:chatgpt.com:workspace-stable");
  assert.equal(Object.keys(workspaceHarness.sessionStorage).some((key) => key.includes("temporary-context:60")), false);
  const stableSaved = await workspaceHarness.handleMessage({
    type: workspaceContract.MESSAGE_TYPES.QUERY_SAVED,
    conversationScope: stableContext.context.scopeKey,
    mode: "local",
    query: "",
  }, stableSender);
  assert.equal(stableSaved.entries.length, 1);
  assert.equal(stableSaved.entries[0].text, "Immutable\n\nselection snapshot");

  const secondStableSender = {
    tab: { id: 60, url: "https://chatgpt.com/c/workspace-second" },
    url: "https://chatgpt.com/c/workspace-second",
  };
  const secondStable = await workspaceHarness.handleMessage({
    type: workspaceContract.MESSAGE_TYPES.GET_CONTEXT,
    pageUrl: secondStableSender.tab.url,
  }, secondStableSender);
  assert.equal(secondStable.context.scopeKey, "stable:chatgpt.com:workspace-second");
  assert.equal((await workspaceHarness.handleMessage({
    type: workspaceContract.MESSAGE_TYPES.QUERY_SAVED,
    conversationScope: secondStable.context.scopeKey,
    mode: "local",
    query: "",
  }, secondStableSender)).entries.length, 0);

  const sameStableOtherTab = await workspaceHarness.handleMessage({
    type: workspaceContract.MESSAGE_TYPES.GET_CONTEXT,
    pageUrl: stableSender.tab.url,
  }, { tab: { id: 99, url: stableSender.tab.url }, url: stableSender.tab.url });
  assert.equal(sameStableOtherTab.context.id, stableContext.context.id);

  const concurrentContextHarness = createServiceWorkerHarness(validStorage());
  const concurrentSender = { tab: { id: 100, url: "https://chatgpt.com/" }, url: "https://chatgpt.com/" };
  const [concurrentFirst, concurrentSecond] = await Promise.all([
    concurrentContextHarness.handleMessage({
      type: workspaceContract.MESSAGE_TYPES.GET_CONTEXT,
      pageUrl: "https://chatgpt.com/",
    }, concurrentSender),
    concurrentContextHarness.handleMessage({
      type: workspaceContract.MESSAGE_TYPES.GET_CONTEXT,
      pageUrl: "https://chatgpt.com/",
    }, concurrentSender),
  ]);
  assert.equal(concurrentFirst.context.scopeKey, concurrentSecond.context.scopeKey);
  assert.equal(concurrentFirst.context.id, concurrentSecond.context.id);
  assert.equal(concurrentContextHarness.memoryWorkspace.snapshot().conversations.length, 1);
  assert.equal(Object.keys(concurrentContextHarness.sessionStorage)
    .filter((key) => key.includes("temporary-context:100")).length, 1);
  const [differentTabOne, differentTabTwo] = await Promise.all([
    concurrentContextHarness.handleMessage({
      type: workspaceContract.MESSAGE_TYPES.GET_CONTEXT,
      pageUrl: "https://chatgpt.com/",
    }, { tab: { id: 101, url: "https://chatgpt.com/" }, url: "https://chatgpt.com/" }),
    concurrentContextHarness.handleMessage({
      type: workspaceContract.MESSAGE_TYPES.GET_CONTEXT,
      pageUrl: "https://chatgpt.com/",
    }, { tab: { id: 102, url: "https://chatgpt.com/" }, url: "https://chatgpt.com/" }),
  ]);
  assert.notEqual(differentTabOne.context.scopeKey, differentTabTwo.context.scopeKey);
  const concurrentStableSender = {
    tab: { id: 100, url: "https://chatgpt.com/c/concurrent-stable" },
    url: "https://chatgpt.com/c/concurrent-stable",
  };
  const concurrentStable = await concurrentContextHarness.handleMessage({
    type: workspaceContract.MESSAGE_TYPES.GET_CONTEXT,
    pageUrl: concurrentStableSender.tab.url,
  }, concurrentStableSender);
  assert.equal(concurrentStable.context.scopeKey, "stable:chatgpt.com:concurrent-stable");
  assert.equal(concurrentContextHarness.memoryWorkspace.snapshot().conversations
    .some((conversation) => conversation.scopeKey === concurrentFirst.context.scopeKey), false);
  assert.equal(concurrentContextHarness.evaluate("contextResolutionQueues.size"), 0);

  const replacementHarness = createServiceWorkerHarness(validStorage());
  const replacementSender = {
    tab: { id: 103, url: "https://chatgpt.com/c/replacement-contract" },
    url: "https://chatgpt.com/c/replacement-contract",
  };
  const replacementContext = await replacementHarness.handleMessage({
    type: workspaceContract.MESSAGE_TYPES.GET_CONTEXT,
    pageUrl: replacementSender.tab.url,
  }, replacementSender);
  const originalSense = await replacementHarness.memoryWorkspace.addAnalysisTerms([{
    term: "state",
    translation: "состояние",
    definition: "Старое определение.",
  }], replacementContext.context.scopeKey);
  const candidateSense = await replacementHarness.memoryWorkspace.addAnalysisTerms([{
    term: "state",
    translation: "состояние",
    definition: "Исправленное определение.",
  }], replacementContext.context.scopeKey);
  const replacementCommand = {
    senseId: originalSense.results[0].id,
    sourceSenseId: candidateSense.results[0].id,
    expectedUpdatedAt: candidateSense.results[0].replacementCandidate.expectedUpdatedAt,
  };
  const missingExpectedAt = await replacementHarness.handleMessage({
    type: workspaceContract.MESSAGE_TYPES.REPLACE_GLOSSARY_SENSE,
    conversationScope: replacementContext.context.scopeKey,
    command: { senseId: replacementCommand.senseId, sourceSenseId: replacementCommand.sourceSenseId },
  }, replacementSender);
  assert.equal(missingExpectedAt.ok, false);
  assert.equal(missingExpectedAt.error.code, "REQUEST_CONTRACT_ERROR");
  const malformedExpectedAt = await replacementHarness.handleMessage({
    type: workspaceContract.MESSAGE_TYPES.REPLACE_GLOSSARY_SENSE,
    conversationScope: replacementContext.context.scopeKey,
    command: { ...replacementCommand, expectedUpdatedAt: "1001" },
  }, replacementSender);
  assert.equal(malformedExpectedAt.ok, false);
  assert.equal(malformedExpectedAt.error.code, "REQUEST_CONTRACT_ERROR");
  const staleReplacement = await replacementHarness.handleMessage({
    type: workspaceContract.MESSAGE_TYPES.REPLACE_GLOSSARY_SENSE,
    conversationScope: replacementContext.context.scopeKey,
    command: { ...replacementCommand, expectedUpdatedAt: -1 },
  }, replacementSender);
  assert.equal(staleReplacement.ok, false);
  assert.equal(staleReplacement.error.code, "GLOSSARY_ENTRY_CHANGED");
  assert.equal(staleReplacement.current.id, replacementCommand.senseId);
  assert.equal(replacementHarness.memoryWorkspace.snapshot().glossarySenses.length, 2);
  const currentReplacement = await replacementHarness.handleMessage({
    type: workspaceContract.MESSAGE_TYPES.REPLACE_GLOSSARY_SENSE,
    conversationScope: replacementContext.context.scopeKey,
    command: replacementCommand,
  }, replacementSender);
  assert.equal(currentReplacement.ok, true);
  assert.equal(currentReplacement.entry.id, replacementCommand.senseId);
  assert.equal(replacementHarness.memoryWorkspace.snapshot().glossarySenses.length, 1);

  const commandHarness = createServiceWorkerHarness(validStorage(), {
    tabs: [{ id: 82, url: "https://chatgpt.com/c/active-fallback" }],
  });
  const commandTab = { id: 81, url: "https://chatgpt.com/c/event-tab" };
  await commandHarness.runCommand("analyze-selection", commandTab);
  await commandHarness.runCommand("save-selection", commandTab);
  await commandHarness.runCommand("normalize-composer", commandTab);
  await commandHarness.runCommand("normalize-composer", commandTab);
  assert.deepEqual(commandHarness.tabMessages.map((item) => item.message.type), [
    commandRegistry.CONTENT_MESSAGE_TYPES.ANALYZE,
    commandRegistry.CONTENT_MESSAGE_TYPES.SAVE,
    commandRegistry.CONTENT_MESSAGE_TYPES.NORMALIZE,
  ]);
  assert.equal(commandHarness.tabQueryCalls.length, 0);
  await commandHarness.runCommand("unsupported-command", commandTab);
  assert.equal(commandHarness.tabMessages.length, 3);
  await commandHarness.runCommand("save-selection", { id: 90, url: "https://example.com/" });
  assert.deepEqual(commandHarness.tabQueryCalls.at(-1), { active: true, lastFocusedWindow: true });
  assert.equal(commandHarness.tabMessages.at(-1).tabId, 82);
  const failedCommandHarness = createServiceWorkerHarness(validStorage(), { failingTabIds: [83] });
  await failedCommandHarness.runCommand("analyze-selection", { id: 83, url: "https://chat.openai.com/c/failure" });
  assert.equal(failedCommandHarness.tabMessages.length, 1);

  const menuHarness = createServiceWorkerHarness(validStorage());
  await menuHarness.runContextMenu({
    menuItemId: "chatgpt-helper-analyze-selection",
    selectionText: "Menu analysis",
  }, { id: 71, url: "https://chatgpt.com/c/menu" });
  await menuHarness.runContextMenu({
    menuItemId: "chatgpt-helper-save-selection",
    selectionText: "Menu snapshot",
  }, { id: 71, url: "https://chatgpt.com/c/menu" });
  await menuHarness.runContextMenu({
    menuItemId: "chatgpt-helper-normalize-composer",
  }, { id: 71, url: "https://chatgpt.com/c/menu" });
  assert.deepEqual(menuHarness.tabMessages.map((item) => item.message.type), [
    contract.MESSAGE_TYPES.CONTEXT_MENU_SELECTION,
    workspaceContract.MESSAGE_TYPES.CONTEXT_MENU_SAVE_SELECTION,
    workspaceContract.MESSAGE_TYPES.CONTEXT_MENU_NORMALIZE_COMPOSER,
  ]);

  const orphanHarness = createServiceWorkerHarness(validStorage());
  const orphanContext = await orphanHarness.handleMessage({
    type: workspaceContract.MESSAGE_TYPES.GET_CONTEXT,
    pageUrl: "https://chatgpt.com/",
  }, { tab: { id: 72, url: "https://chatgpt.com/" }, url: "https://chatgpt.com/" });
  await orphanHarness.runTabRemoved(72);
  assert.equal(
    orphanHarness.memoryWorkspace.snapshot().conversations.find((item) => item.scopeKey === orphanContext.context.scopeKey).orphanedAt > 0,
    true,
  );

  const retryableOrphanHarness = createServiceWorkerHarness(validStorage());
  const retryableOrphan = await retryableOrphanHarness.handleMessage({
    type: workspaceContract.MESSAGE_TYPES.GET_CONTEXT,
    pageUrl: "https://chatgpt.com/",
  }, { tab: { id: 73, url: "https://chatgpt.com/" }, url: "https://chatgpt.com/" });
  retryableOrphanHarness.memoryWorkspace.failNextWrite(new Error("simulated orphan failure"));
  await retryableOrphanHarness.runTabRemoved(73);
  assert.equal(Object.keys(retryableOrphanHarness.sessionStorage).some((key) => key.includes("temporary-context:73")), true);
  assert.equal(
    retryableOrphanHarness.memoryWorkspace.snapshot().conversations
      .find((item) => item.scopeKey === retryableOrphan.context.scopeKey).orphanedAt,
    null,
  );
  await retryableOrphanHarness.runTabRemoved(73);
  assert.equal(Object.keys(retryableOrphanHarness.sessionStorage).some((key) => key.includes("temporary-context:73")), false);
  assert.equal(
    retryableOrphanHarness.memoryWorkspace.snapshot().conversations
      .find((item) => item.scopeKey === retryableOrphan.context.scopeKey).orphanedAt > 0,
    true,
  );
}

runAsyncTests()
  .then(() => console.log("analysis logic ok"))
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
