"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { webcrypto } = require("node:crypto");
const contract = require("../src/analysis-contract.js");
const workspaceContract = require("../src/workspace-contract.js");
const templateTree = require("../src/template-tree.js");
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
const chatGptDomSource = fs.readFileSync(path.join(__dirname, "../src/chatgpt-dom.js"), "utf8");
const analysisUiSource = fs.readFileSync(path.join(__dirname, "../src/analysis-ui.js"), "utf8");
const analysisControllerSource = fs.readFileSync(path.join(__dirname, "../src/analysis-controller.js"), "utf8");
const optionsHtmlSource = fs.readFileSync(path.join(__dirname, "../src/options.html"), "utf8");
const optionsScriptSource = fs.readFileSync(path.join(__dirname, "../src/options.js"), "utf8");
const optionsStylesSource = fs.readFileSync(path.join(__dirname, "../src/options.css"), "utf8");
const manifestSource = fs.readFileSync(path.join(__dirname, "../manifest.json"), "utf8");

function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function typedTemplate(id, name, content, autoSend = false, parentId = null, iconKey = "document") {
  return {
    id,
    kind: "template",
    parentId,
    name,
    iconKey,
    content,
    autoSend,
  };
}

function createInlineSelectionCaptureHarness() {
  const documentValue = {
    activeElement: null,
    querySelectorAll() { return []; },
  };
  const windowValue = {
    ChatGPTHelperWorkspaceContract: workspaceContract,
    document: documentValue,
    innerWidth: 1280,
    innerHeight: 720,
    location: { href: "https://chatgpt.com/c/inline-test" },
    getComputedStyle() { return { display: "block", visibility: "visible" }; },
    getSelection() { return null; },
  };
  windowValue.window = windowValue;
  const context = vm.createContext({
    console,
    URL,
    document: documentValue,
    window: windowValue,
  });
  vm.runInContext(chatGptDomSource, context, { filename: "chatgpt-dom.js" });
  return windowValue.ChatGPTTemplateDom;
}

function inlineSelectionElement(options) {
  const value = options || {};
  const attributes = { ...(value.attributes || {}) };
  return {
    nodeType: 1,
    tagName: value.tagName || "P",
    isConnected: value.isConnected !== false,
    isContentEditable: value.isContentEditable === true,
    parentElement: value.parentElement || null,
    parentNode: value.parentElement || null,
    getAttribute(name) {
      return Object.prototype.hasOwnProperty.call(attributes, name) ? attributes[name] : null;
    },
    getRootNode() { return value.rootNode || null; },
  };
}

function inlineSelectionTextNode(text) {
  return { nodeType: 3, data: String(text || ""), textContent: String(text || ""), parentNode: null };
}

function inlineSelectionFragmentElement(tagName, children, attributes) {
  const values = { ...(attributes || {}) };
  const node = {
    nodeType: 1,
    tagName: String(tagName || "DIV").toUpperCase(),
    childNodes: Array.isArray(children) ? children : [],
    parentNode: null,
    getAttribute(name) {
      return Object.prototype.hasOwnProperty.call(values, name) ? values[name] : null;
    },
    setAttribute(name, value) { values[name] = String(value); },
  };
  node.childNodes.forEach((child) => { child.parentNode = node; });
  Object.defineProperty(node, "textContent", {
    get() { return node.childNodes.map((child) => child.textContent || child.data || "").join(""); },
  });
  return node;
}

function inlineSelectionFixture(options) {
  const value = options || {};
  const anchor = value.anchor || inlineSelectionElement();
  const startContainer = value.startContainer || anchor;
  const endContainer = value.endContainer || anchor;
  const startOffset = Number.isInteger(value.startOffset) ? value.startOffset : 0;
  const endOffset = Number.isInteger(value.endOffset) ? value.endOffset : String(value.text || "").length;
  const range = {
    commonAncestorContainer: anchor,
    startContainer,
    startOffset,
    endContainer,
    endOffset,
    collapsed: value.collapsed === true,
    getClientRects() { return value.rects || []; },
    cloneContents() { return value.fragment || null; },
    toString() { return String(value.text || ""); },
  };
  const backward = value.direction === "backward";
  const endpointsKnown = value.direction !== "unknown";
  const selection = {
    rangeCount: value.rangeCount === undefined ? 1 : value.rangeCount,
    isCollapsed: value.collapsed === true,
    anchorNode: endpointsKnown ? (backward ? endContainer : startContainer) : null,
    anchorOffset: endpointsKnown ? (backward ? endOffset : startOffset) : -1,
    focusNode: endpointsKnown ? (backward ? startContainer : endContainer) : null,
    focusOffset: endpointsKnown ? (backward ? startOffset : endOffset) : -1,
    getRangeAt() { return range; },
    toString() { return String(value.text || ""); },
  };
  return { anchor, range, selection };
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
    templates: [{
      id: "template-1",
      kind: "template",
      parentId: null,
      name: "Template",
      iconKey: "document",
      content: "Content",
      autoSend: true,
    }],
    settings,
    recentTemplateIds: ["template-1"],
    templateTreeUiState: { collapsedFolderIds: [] },
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
  const initializeWorkspace = memoryWorkspace.initialize.bind(memoryWorkspace);
  let workspaceInitializeCalls = 0;
  let contextResolutionFailures = Number(options.contextResolutionFailures || 0);
  memoryWorkspace.initialize = async (...args) => {
    workspaceInitializeCalls += 1;
    return initializeWorkspace(...args);
  };
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
    ChatGPTHelperTemplateTree: templateTree,
    ChatGPTHelperConversationContext: conversationContext,
    ChatGPTHelperCommandRegistry: commandRegistry,
    ChatGPTHelperImportExport: importExport,
    ChatGPTHelperWorkspaceStore: {
      create() { return memoryWorkspace; },
      USER_STORE_NAMES: workspaceStore.USER_STORE_NAMES,
      assertGlossaryInvariant: workspaceStore.assertGlossaryInvariant,
      stableDescriptor: workspaceStore.stableDescriptor,
      temporaryDescriptor: workspaceStore.temporaryDescriptor,
    },
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
    workspaceInitializeCalls() { return workspaceInitializeCalls; },
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

function createDeferredPromise() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function createOptionsElement(options) {
  const value = options || {};
  const listeners = {};
  return {
    tagName: value.tagName || "DIV",
    dataset: { ...(value.dataset || {}) },
    hidden: value.hidden === true,
    disabled: false,
    textContent: value.textContent || "",
    title: "",
    value: value.value || "",
    files: [],
    className: value.className || "",
    addEventListener(type, listener) { listeners[type] = listener; },
    focus() {},
    closest(selector) {
      if (selector === "[data-backup-action]" && this.dataset.backupAction) return this;
      if (selector === "[data-action]" && this.dataset.action) return this;
      return null;
    },
    listeners,
  };
}

function createOptionsPageHarness(harnessOptions) {
  const options = harnessOptions || {};
  const documentListeners = {};
  const storageListeners = {};
  const sendCalls = [];
  let sendHandler = options.sendMessage || (async (message) => {
    if (message.type === contract.MESSAGE_TYPES.GET_KEY_STATUS) return { ok: true, configured: false };
    if ([workspaceContract.MESSAGE_TYPES.IMPORT_SETTINGS_PREVIEW, workspaceContract.MESSAGE_TYPES.IMPORT_DATA_PREVIEW].includes(message.type)) {
      return { ok: true, preview: { metadata: { format: "test" }, warnings: [] } };
    }
    return { ok: true };
  });
  const rootClasses = new Set(options.rootClasses || ["theme-system", "theme-pending", "service-ready"]);
  const documentElement = {
    classList: {
      add(...names) { names.forEach((name) => rootClasses.add(name)); },
      remove(...names) { names.forEach((name) => rootClasses.delete(name)); },
      contains(name) { return rootClasses.has(name); },
    },
  };
  const form = createOptionsElement({ tagName: "FORM" });
  const input = createOptionsElement({ tagName: "INPUT" });
  const statusView = createOptionsElement();
  const message = createOptionsElement();
  const deleteConfirm = createOptionsElement();
  const cancelReplace = createOptionsElement({ tagName: "BUTTON", dataset: { action: "cancel-replace" } });
  const backupSection = createOptionsElement();
  backupSection.scrollIntoView = () => {};
  const byId = new Map([
    ["key-form", form],
    ["api-key", input],
    ["status-view", statusView],
    ["message", message],
    ["delete-confirm", deleteConfirm],
    ["backup", backupSection],
  ]);
  const bySelector = new Map([
    ['[data-action="cancel-replace"]', cancelReplace],
  ]);
  const groups = {};
  for (const kind of ["settings", "data"]) {
    const preview = createOptionsElement({ tagName: "PRE", textContent: "Файл не выбран." });
    const result = createOptionsElement({ tagName: "P" });
    const apply = createOptionsElement({ tagName: "BUTTON", dataset: { backupAction: "apply", kind } });
    const selectedFile = createOptionsElement({ hidden: true });
    const selectedFilename = createOptionsElement({ tagName: "SPAN" });
    const exportButton = createOptionsElement({ tagName: "BUTTON", dataset: { backupAction: "export", kind } });
    const fileInput = createOptionsElement({ tagName: "INPUT", dataset: { backupAction: "file", kind } });
    const mergeMode = createOptionsElement({ tagName: "INPUT", dataset: { backupAction: "mode", kind }, value: "merge" });
    const replaceMode = createOptionsElement({ tagName: "INPUT", dataset: { backupAction: "mode", kind }, value: "replace" });
    const cancel = createOptionsElement({ tagName: "BUTTON", dataset: { backupAction: "cancel", kind } });
    const actions = [exportButton, fileInput, mergeMode, replaceMode, cancel, apply];
    groups[kind] = {
      preview,
      result,
      apply,
      selectedFile,
      selectedFilename,
      exportButton,
      fileInput,
      mergeMode,
      replaceMode,
      cancel,
      actions,
    };
    bySelector.set(`[data-backup-preview="${kind}"]`, preview);
    bySelector.set(`[data-backup-result="${kind}"]`, result);
    bySelector.set(`[data-backup-action="apply"][data-kind="${kind}"]`, apply);
    bySelector.set(`[data-backup-selected-file="${kind}"]`, selectedFile);
    bySelector.set(`[data-backup-filename="${kind}"]`, selectedFilename);
    bySelector.set(`[data-backup-action="file"][data-kind="${kind}"]`, fileInput);
  }
  const document = {
    documentElement,
    body: { appendChild() {} },
    getElementById(id) { return byId.get(id) || null; },
    querySelector(selector) { return bySelector.get(selector) || null; },
    querySelectorAll(selector) {
      if (selector === "[data-action], #api-key") return [input, cancelReplace];
      const match = selector.match(/^\[data-backup-kind="(settings|data)"\] \[data-backup-action\]$/);
      return match ? groups[match[1]].actions : [];
    },
    addEventListener(type, listener) { documentListeners[type] = listener; },
    createElement() { return createOptionsElement(); },
  };
  const chrome = {
    storage: {
      local: {
        async get() {
          if (options.storageError) throw options.storageError;
          return { settings: options.settings };
        },
      },
      onChanged: {
        addListener(listener) { storageListeners.changed = listener; },
      },
    },
    runtime: {
      async sendMessage(messageValue) {
        sendCalls.push(messageValue);
        return sendHandler(messageValue);
      },
    },
  };
  const instrumentedSource = optionsScriptSource.replace(
    /\}\)\(\);\s*$/,
    `globalThis.__optionsPageTest = Object.freeze({
      backup, clearBackupSelection, readBackupFile, renderBackup, renderBackups, applyBackup, applyTheme, loadTheme
    });
  })();`,
  );
  const context = vm.createContext({
    console,
    Blob,
    URL,
    setTimeout,
    clearTimeout,
    chrome,
    document,
    location: { hash: "" },
    window: { confirm: () => true },
    ChatGPTHelperAnalysisContract: contract,
    ChatGPTHelperWorkspaceContract: workspaceContract,
    ChatGPTHelperImportExport: importExport,
  });
  vm.runInContext(instrumentedSource, context, { filename: "options.js" });
  return {
    state: context.__optionsPageTest.backup,
    api: context.__optionsPageTest,
    groups,
    input,
    rootClasses,
    sendCalls,
    setSendHandler(handler) { sendHandler = handler; },
    emitStorageChange(changes, areaName) { storageListeners.changed(changes, areaName || "local"); },
    async clickBackup(kind, action) {
      const target = groups[kind].actions.find((element) => element.dataset.backupAction === action);
      return documentListeners.click({ target });
    },
    changeFile(kind, file) {
      groups[kind].fileInput.files = file ? [file] : [];
      documentListeners.change({ target: groups[kind].fileInput });
    },
    async settle() {
      await Promise.resolve();
      await new Promise((resolve) => setImmediate(resolve));
      await Promise.resolve();
    },
  };
}

function fakeElement(selectorFragment) {
  return {
    closest(selector) {
      return selector.includes(selectorFragment) ? this : null;
    },
  };
}

function createInlineUiHarness() {
  const rootNode = { activeElement: null };
  const documentValue = {
    nodeType: 9,
    activeElement: null,
    createElement(tagName) { return new InlineFakeElement(tagName); },
    createElementNS(_namespace, tagName) { return new InlineFakeElement(tagName); },
  };

  class InlineFakeElement {
    constructor(tagName) {
      this.tagName = String(tagName || "div").toUpperCase();
      this.nodeType = 1;
      this.parentNode = null;
      this.children = [];
      this.attributes = new Map();
      this.dataset = {};
      this.style = {
        setProperty(name, value) { this[name] = value; },
      };
      this.className = "";
      this.id = "";
      this.type = "";
      this.hidden = false;
      this.isConnected = false;
      this.listeners = new Map();
      this._textContent = "";
    }

    set textContent(value) {
      this.children.forEach((child) => child._setConnected(false));
      this.children = [];
      this._textContent = String(value ?? "");
    }

    get textContent() {
      return this._textContent + this.children.map((child) => child.textContent).join("");
    }

    set innerHTML(_value) {
      throw new Error("INLINE_RENDERER_MUST_NOT_USE_INNER_HTML");
    }

    get innerHTML() {
      return "";
    }

    _setConnected(value) {
      this.isConnected = value === true;
      this.children.forEach((child) => child._setConnected(this.isConnected));
    }

    append(...nodes) {
      nodes.forEach((node) => this.appendChild(node));
    }

    appendChild(node) {
      node.parentNode?.children?.splice(node.parentNode.children.indexOf(node), 1);
      node.parentNode = this;
      this.children.push(node);
      node._setConnected(this.isConnected);
      return node;
    }

    replaceChildren(...nodes) {
      this.children.forEach((child) => child._setConnected(false));
      this.children = [];
      this._textContent = "";
      this.append(...nodes);
    }

    remove() {
      if (this.parentNode) {
        const index = this.parentNode.children.indexOf(this);
        if (index >= 0) this.parentNode.children.splice(index, 1);
      }
      this.parentNode = null;
      this._setConnected(false);
    }

    contains(node) {
      if (node !== null && typeof node?.nodeType !== "number") {
        throw new TypeError("INLINE_FAKE_CONTAINS_REQUIRES_NODE");
      }
      return node === this || this.children.some((child) => child.contains(node));
    }

    setAttribute(name, value) {
      this.attributes.set(name, String(value));
      if (name === "id") this.id = String(value);
    }

    getAttribute(name) {
      return this.attributes.has(name) ? this.attributes.get(name) : null;
    }

    addEventListener(type, listener) {
      const listeners = this.listeners.get(type) || [];
      listeners.push(listener);
      this.listeners.set(type, listeners);
    }

    dispatch(type, eventValue) {
      const event = {
        button: 0,
        preventDefault() {},
        ...eventValue,
      };
      (this.listeners.get(type) || []).forEach((listener) => listener(event));
    }

    click() {
      this.dispatch("click");
    }

    focus() {
      documentValue.activeElement = this;
      rootNode.activeElement = this;
    }

    getRootNode() {
      return rootNode;
    }

    getBoundingClientRect() {
      if (this.className === "inline-selection-actions") {
        if (this.hidden) {
          return { top: 0, right: 0, bottom: 0, left: 0, width: 0, height: 0 };
        }
        return { top: 0, right: 120, bottom: 36, left: 0, width: 120, height: 36 };
      }
      if (this.className.startsWith("inline-glossary-popover")) {
        const width = this.className.includes("is-many") ? 420 : 360;
        return { top: 0, right: width, bottom: 180, left: 0, width, height: 180 };
      }
      return { top: 0, right: 0, bottom: 0, left: 0, width: 0, height: 0 };
    }
  }

  const shell = new InlineFakeElement("div");
  shell._setConnected(true);
  const previousDocument = globalThis.document;
  const previousWindow = globalThis.window;
  const windowValue = {
    innerWidth: 400,
    innerHeight: 300,
    addEventListener() {},
    removeEventListener() {},
  };
  windowValue.window = windowValue;
  globalThis.document = documentValue;
  globalThis.window = windowValue;
  const ui = analysisUi.create({
    getShell() { return shell; },
    getSettings() { return workspaceContract.DEFAULT_ACTIVE_SETTINGS; },
  });
  return {
    ui,
    shell,
    rootNode,
    documentValue,
    windowValue,
    restore() {
      if (previousDocument === undefined) delete globalThis.document;
      else globalThis.document = previousDocument;
      if (previousWindow === undefined) delete globalThis.window;
      else globalThis.window = previousWindow;
    },
  };
}

function inlineDescendants(element) {
  return [element, ...element.children.flatMap((child) => inlineDescendants(child))];
}

function createInlineContentHarness(harnessOptions) {
  const options = harnessOptions || {};
  const uiCalls = [];
  const lookupCalls = [];
  const analysisCalls = [];
  const translationCalls = [];
  const timers = new Map();
  const frames = new Map();
  let timerId = 0;
  let frameId = 0;
  let captureValue = null;
  let selectionText = "";
  let lookupImplementation = async () => ({
    ok: true,
    groups: [],
    missing: [],
    totals: {
      candidateCountBeforeLimit: 0,
      candidateCountReturned: 0,
      matchedCandidateCount: 0,
      matchedEntryCountBeforeLimit: 0,
      matchedEntryCountReturned: 0,
    },
    truncated: { candidates: false, entries: false },
  });
  const state = {
    analysisBusy: false,
    translationBusy: false,
    workspaceStatus: { status: "ready" },
    workspaceContext: { scopeKey: "stable:chatgpt.com:inline-content" },
    inlineGesture: {
      generation: 0,
      pointerId: null,
      pointerType: null,
      keyboardActive: false,
      shiftHeld: false,
      selectionKeys: [],
      startSignature: "",
      changed: false,
      pendingFrame: null,
      pendingTask: null,
    },
    inlineGlossary: {
      phase: "closed",
      selectionToken: 0,
      requestToken: 0,
      snapshot: null,
      result: null,
      error: null,
    },
    host: { id: "extension-root" },
    analysisUi: {
      showInlineOffer(snapshot, handlers, offerOptions) {
        uiCalls.push({ phase: "offering", snapshot, handlers, offerOptions });
        return snapshot.anchorNode?.isConnected === true;
      },
      showInlineLoading(snapshot, handlers) {
        uiCalls.push({ phase: "loading", snapshot, handlers });
        return snapshot.anchorNode?.isConnected === true;
      },
      showInlineResult(snapshot, result, handlers) {
        uiCalls.push({ phase: "showing", snapshot, result, handlers });
        return snapshot.anchorNode?.isConnected === true;
      },
      showInlineError(snapshot, error, handlers) {
        uiCalls.push({ phase: "error", snapshot, error, handlers });
        return snapshot.anchorNode?.isConnected === true;
      },
      closeInline() {
        uiCalls.push({ phase: "closed" });
        return true;
      },
      inlineContainsPath(path) {
        if (typeof options.inlineContainsPath === "function") {
          return options.inlineContainsPath(path);
        }
        return Array.isArray(path)
          && (path.includes("inline-trigger") || path.includes("inline-popover"));
      },
    },
    workspaceClient: {
      async lookupGlossarySelection(text) {
        lookupCalls.push(text);
        return lookupImplementation(text);
      },
    },
  };
  const inlineSource = contentScriptSource.slice(
    contentScriptSource.indexOf("function aiOperationBusy"),
    contentScriptSource.indexOf("async function deleteWorkspaceEntry"),
  );
  const context = vm.createContext({
    console,
    __state: state,
    __workspaceContract: workspaceContract,
    __capture() { return captureValue; },
    __analysisCalls: analysisCalls,
    __translationCalls: translationCalls,
    __timers: timers,
    __frames: frames,
    __nextTimerId() { timerId += 1; return timerId; },
    __nextFrameId() { frameId += 1; return frameId; },
    __selectionText() { return selectionText; },
    __location: { href: "https://chatgpt.com/c/inline-content" },
  });
  vm.runInContext(`
    (function createInlineContentTestApi() {
      "use strict";
      const state = globalThis.__state;
      const workspaceContract = globalThis.__workspaceContract;
      const location = globalThis.__location;
      const conversationContextModule = { isSupportedPage() { return true; } };
      const chatGptDom = {
        captureInlineGlossarySelection() { return globalThis.__capture(); },
      };
      const setTimeout = (callback, delay) => {
        const id = globalThis.__nextTimerId();
        globalThis.__timers.set(id, { callback, delay });
        return id;
      };
      const clearTimeout = (id) => { globalThis.__timers.delete(id); };
      const window = {
        getSelection() {
          const text = globalThis.__selectionText();
          return {
            toString() { return text; },
            isCollapsed: !text,
            anchorOffset: 0,
            focusOffset: text.length,
          };
        },
        requestAnimationFrame(callback) {
          const id = globalThis.__nextFrameId();
          globalThis.__frames.set(id, callback);
          return id;
        },
        cancelAnimationFrame(id) { globalThis.__frames.delete(id); },
      };
      const closeWorkspaceDelete = () => false;
      const renderSection = () => {};
      const refreshGlossary = async () => {};
      const refreshSaved = async () => {};
      const handleUiError = () => {};
      const runAnalysis = async (...args) => {
        globalThis.__analysisCalls.push({
          args,
          phaseAtStart: state.inlineGlossary.phase,
        });
        return { ok: true, requestId: "analysis-inline-content" };
      };
      const runTranslation = async (...args) => {
        globalThis.__translationCalls.push({
          args,
          phaseAtStart: state.inlineGlossary.phase,
        });
        return { ok: true, requestId: "translation-inline-content" };
      };
      ${inlineSource}
      globalThis.__inlineContentApi = Object.freeze({
        closeInlineGlossary,
        inlineSnapshotCurrent,
        showInlineOffer,
        activateInlineGlossary,
        translateInlineSelection,
        analyzeInlineSelection,
        retryInlineGlossary,
        analyzeInlineGlossaryCandidate,
        captureInlineGlossarySelection,
        beginInlineGesture,
        markInlineGestureSelectionChanged,
        scheduleInlineGestureSettle,
        finishInlineKeyboardGestureIfReady,
        handleInlinePointerDown,
        handleInlinePointerUp,
        cancelInlinePointerGesture,
        handleInlineKeyDown,
        handleInlineKeyUp,
        closeInlineGlossaryOutsidePath,
        handleInlineFocusIn,
        scheduleInlineGlossaryCloseAfterEvent,
        handleInlineCopy,
        handleInlineExternalAction,
        closeInlineGlossaryForInvalidation,
        handleWorkspaceContextChange,
        handleWorkspaceStatusChange,
      });
    })();
  `, context, { filename: "content-script-inline-session.test.js" });
  return {
    api: context.__inlineContentApi,
    state,
    uiCalls,
    lookupCalls,
    analysisCalls,
    translationCalls,
    timers,
    frames,
    setCapture(value) {
      captureValue = value;
      if (value?.ok && typeof value.text === "string") selectionText = value.text;
    },
    setSelectionText(value) { selectionText = String(value || ""); },
    setLookupImplementation(value) { lookupImplementation = value; },
    setLocationHref(value) { context.__location.href = value; },
    runTimers() {
      const pending = [...timers.values()];
      timers.clear();
      pending.forEach(({ callback }) => callback());
    },
    runFrames() {
      const pending = [...frames.values()];
      frames.clear();
      pending.forEach((callback) => callback());
    },
    settleGesture() {
      this.runFrames();
      this.runTimers();
    },
  };
}

function inlineContentSnapshot(term, offset) {
  const value = String(term || "State");
  const position = Number(offset) || 0;
  return Object.freeze({
    ok: true,
    text: value,
    anchorRect: Object.freeze({
      top: 20 + position,
      right: 100 + position,
      bottom: 40 + position,
      left: 20 + position,
      width: 80,
      height: 20,
    }),
    anchorNode: { isConnected: true },
    pageUrl: "https://chatgpt.com/c/inline-content",
  });
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

const inlineSelectionDom = createInlineSelectionCaptureHarness();
const captureInlineGlossarySelection = inlineSelectionDom.captureInlineGlossarySelection;
const visibleInlineRects = [
  { top: -40, right: -10, bottom: -10, left: -40, width: 30, height: 30 },
  { top: 90, right: 160, bottom: 110, left: 100, width: 60, height: 20 },
  { top: 120, right: 210, bottom: 142, left: 140, width: 70, height: 22 },
];
const successfulInlineSelection = inlineSelectionFixture({
  text: " **«State.»** ",
  rects: visibleInlineRects,
});
const capturedInlineSelection = captureInlineGlossarySelection({
  pageUrl: "https://chatgpt.com/c/inline-test",
  selection: successfulInlineSelection.selection,
  viewportWidth: 800,
  viewportHeight: 600,
});
assert.equal(capturedInlineSelection.ok, true);
assert.equal(capturedInlineSelection.text, " **«State.»** ");
assert.equal(Object.prototype.hasOwnProperty.call(capturedInlineSelection, "displayTerm"), false);
assert.equal(Object.prototype.hasOwnProperty.call(capturedInlineSelection, "canonicalTerm"), false);
assert.equal(Object.prototype.hasOwnProperty.call(capturedInlineSelection, "normalizedKey"), false);
assert.equal(capturedInlineSelection.anchorNode, successfulInlineSelection.anchor);
assert.equal(capturedInlineSelection.anchorSide, "right");
assert.deepEqual(
  { ...capturedInlineSelection.anchorRect },
  { top: 120, right: 210, bottom: 142, left: 140, width: 70, height: 22 },
);
assert.equal(capturedInlineSelection.pageUrl, "https://chatgpt.com/c/inline-test");
assert.equal(Object.isFrozen(capturedInlineSelection), true);
assert.equal(Object.isFrozen(capturedInlineSelection.anchorRect), true);
assert.equal(Object.prototype.hasOwnProperty.call(capturedInlineSelection, "range"), false);
assert.equal(Object.prototype.hasOwnProperty.call(capturedInlineSelection, "selection"), false);

const backwardInlineSelection = inlineSelectionFixture({
  text: "Backward State",
  rects: visibleInlineRects,
  direction: "backward",
});
const capturedBackwardInlineSelection = captureInlineGlossarySelection({
  pageUrl: "https://chatgpt.com/c/inline-test",
  selection: backwardInlineSelection.selection,
  viewportWidth: 800,
  viewportHeight: 600,
});
assert.equal(capturedBackwardInlineSelection.ok, true);
assert.equal(capturedBackwardInlineSelection.anchorSide, "left");
assert.deepEqual(
  { ...capturedBackwardInlineSelection.anchorRect },
  { top: 90, right: 160, bottom: 110, left: 100, width: 60, height: 20 },
);

const unknownDirectionSelection = inlineSelectionFixture({
  text: "Fallback State",
  rects: visibleInlineRects,
  direction: "unknown",
});
const capturedUnknownDirectionSelection = captureInlineGlossarySelection({
  pageUrl: "https://chatgpt.com/c/inline-test",
  selection: unknownDirectionSelection.selection,
  viewportWidth: 800,
  viewportHeight: 600,
});
assert.equal(capturedUnknownDirectionSelection.anchorSide, "right");
assert.deepEqual(
  { ...capturedUnknownDirectionSelection.anchorRect },
  { top: 120, right: 210, bottom: 142, left: 140, width: 70, height: 22 },
);

const singleStructuredListFragment = {
  nodeType: 11,
  childNodes: [
    inlineSelectionFragmentElement("UL", [
      inlineSelectionFragmentElement("LI", [inlineSelectionTextNode("route handler")]),
    ]),
  ],
};
const singleStructuredListFixture = inlineSelectionFixture({
  text: "route handler",
  fragment: singleStructuredListFragment,
  rects: [{ top: 20, right: 180, bottom: 40, left: 20, width: 160, height: 20 }],
});
const capturedSingleStructuredList = captureInlineGlossarySelection({
  pageUrl: "https://chatgpt.com/c/inline-test",
  selection: singleStructuredListFixture.selection,
  viewportWidth: 800,
  viewportHeight: 600,
});
assert.equal(capturedSingleStructuredList.ok, true);
assert.equal(capturedSingleStructuredList.text, "• route handler");
assert.deepEqual(
  workspaceContract.extractInlineGlossaryCandidates(capturedSingleStructuredList.text)
    .candidates.map((candidate) => [
      candidate.displayTerm,
      candidate.source,
      candidate.visibility,
    ]),
  [
    ["route", "token", "primary"],
    ["handler", "token", "primary"],
    ["route handler", "ngram", "lookup-only"],
  ],
);

const structuredListFragment = {
  nodeType: 11,
  childNodes: [
    inlineSelectionFragmentElement("UL", [
      inlineSelectionFragmentElement("LI", [inlineSelectionTextNode("API client")]),
      inlineSelectionFragmentElement("LI", [inlineSelectionTextNode("SDK server")]),
    ]),
  ],
};
const structuredListFixture = inlineSelectionFixture({
  text: "API client SDK server",
  fragment: structuredListFragment,
  rects: [{ top: 20, right: 180, bottom: 60, left: 20, width: 160, height: 40 }],
});
const capturedStructuredList = captureInlineGlossarySelection({
  pageUrl: "https://chatgpt.com/c/inline-test",
  selection: structuredListFixture.selection,
  viewportWidth: 800,
  viewportHeight: 600,
});
assert.equal(capturedStructuredList.ok, true);
assert.equal(capturedStructuredList.text, "• API client\n• SDK server");
const structuredListCandidates = workspaceContract.extractInlineGlossaryCandidates(
  capturedStructuredList.text,
);
assert.equal(
  structuredListCandidates.candidates.some((candidate) => (
    candidate.displayTerm === "client SDK"
  )),
  false,
);

const structuredTableFragment = {
  nodeType: 11,
  childNodes: [
    inlineSelectionFragmentElement("TABLE", [
      inlineSelectionFragmentElement("TBODY", [
        inlineSelectionFragmentElement("TR", [
          inlineSelectionFragmentElement("TD", [inlineSelectionTextNode("API")]),
          inlineSelectionFragmentElement("TD", [inlineSelectionTextNode("client")]),
        ]),
        inlineSelectionFragmentElement("TR", [
          inlineSelectionFragmentElement("TD", [inlineSelectionTextNode("SDK")]),
          inlineSelectionFragmentElement("TD", [inlineSelectionTextNode("server")]),
        ]),
      ]),
    ]),
  ],
};
const structuredTableFixture = inlineSelectionFixture({
  text: "API\tclient\nSDK\tserver",
  fragment: structuredTableFragment,
  rects: [{ top: 20, right: 200, bottom: 80, left: 20, width: 180, height: 60 }],
});
assert.equal(
  inlineSelectionDom.readSelectionText(
    structuredTableFixture.selection.toString(),
    structuredTableFixture.selection,
  ),
  "API\nclient\nSDK\nserver",
);
const capturedStructuredTable = captureInlineGlossarySelection({
  pageUrl: "https://chatgpt.com/c/inline-test",
  selection: structuredTableFixture.selection,
  viewportWidth: 800,
  viewportHeight: 600,
});
assert.equal(capturedStructuredTable.ok, true);
assert.equal(capturedStructuredTable.text, "API\nclient\nSDK\nserver");
assert.equal(
  workspaceContract.extractInlineGlossaryCandidates(capturedStructuredTable.text)
    .candidates.some((candidate) => candidate.tokenCount > 1),
  false,
);

function inlineCaptureReason(options) {
  const fixture = inlineSelectionFixture({
    text: "State",
    rects: [{ top: 20, right: 80, bottom: 40, left: 20, width: 60, height: 20 }],
    ...(options || {}),
  });
  return captureInlineGlossarySelection({
    pageUrl: "https://chatgpt.com/c/inline-test",
    selection: fixture.selection,
    viewportWidth: 800,
    viewportHeight: 600,
    extensionRoot: options?.extensionRoot,
  }).reason;
}

assert.equal(inlineCaptureReason({ collapsed: true }), "empty");
assert.equal(inlineCaptureReason({ rangeCount: 2 }), "multiple-ranges");
assert.equal(inlineCaptureReason({ text: "line one\nline two" }), undefined);
assert.equal(inlineCaptureReason({ text: "a".repeat(5000) }), undefined);
assert.equal(
  inlineCaptureReason({ text: "a".repeat(5001) }),
  "GLOSSARY_SELECTION_TOO_LARGE",
);
assert.equal(
  inlineCaptureReason({ text: Array.from({ length: 41 }, () => "API").join("\n") }),
  "GLOSSARY_SELECTION_TOO_MANY_LINES",
);
assert.equal(inlineCaptureReason({ text: "только кириллица" }), "no-latin");
assert.equal(inlineCaptureReason({
  rects: [{ top: 20, right: 20, bottom: 20, left: 20, width: 0, height: 0 }],
}), "no-geometry");
assert.equal(inlineCaptureReason({
  anchor: inlineSelectionElement({ isConnected: false }),
}), "disconnected");
const editableInlineParent = inlineSelectionElement({
  tagName: "DIV",
  attributes: { contenteditable: "true" },
});
assert.equal(inlineCaptureReason({
  anchor: inlineSelectionElement({ parentElement: editableInlineParent }),
}), "editable");
assert.equal(inlineCaptureReason({
  anchor: inlineSelectionElement({
    tagName: "DIV",
    attributes: { contenteditable: "plaintext-only" },
  }),
}), "editable");
assert.equal(inlineCaptureReason({
  anchor: inlineSelectionElement({ isContentEditable: true }),
}), "editable");
const extensionInlineAnchor = inlineSelectionElement();
assert.equal(inlineCaptureReason({
  anchor: extensionInlineAnchor,
  extensionRoot: { contains(node) { return node === extensionInlineAnchor; } },
}), "extension-ui");
assert.equal(inlineCaptureReason({ text: "one two three four five six seven eight nine" }), undefined);
assert.equal(inlineCaptureReason({ text: "API/SDK client-side" }), undefined);
assert.equal(captureInlineGlossarySelection({
  pageUrl: "https://example.com/",
  selection: successfulInlineSelection.selection,
  viewportWidth: 800,
  viewportHeight: 600,
}).ok, false);

const inlineBelowPosition = analysisUi.inlinePopoverPosition(
  { top: 20, bottom: 40, left: 390 },
  { height: 100 },
  { width: 400, height: 300 },
);
assert.deepEqual(inlineBelowPosition, {
  left: 32,
  top: 46,
  width: 360,
  maxHeight: 180,
  placement: "below",
});
assert.equal(analysisUi.inlinePopoverPosition(
  { top: 260, bottom: 280, left: 20 },
  { height: 100 },
  { width: 400, height: 300 },
).placement, "above");
assert.deepEqual(analysisUi.inlinePopoverPosition(
  { top: 20, bottom: 40, left: 700 },
  { height: 100, width: 420 },
  { width: 800, height: 600 },
), {
  left: 372,
  top: 46,
  width: 420,
  maxHeight: 360,
  placement: "below",
});
assert.deepEqual(analysisUi.inlinePopoverPosition(
  { top: 30, bottom: 40, left: -20 },
  { height: 200 },
  { width: 300, height: 100 },
), {
  left: 8,
  top: 32,
  width: 284,
  maxHeight: 60,
  placement: "clamped",
});
assert.equal(analysisUi.normalizeInlineGlossaryEntries([
  { id: "sense-1", term: "State", translation: "состояние", definition: "Определение", attached: true },
  null,
  { id: "", term: "ignored", translation: "x", definition: "y" },
]).length, 1);

const inlineUiHarness = createInlineUiHarness();
try {
  const inlineAnchor = { isConnected: true };
  const inlineSnapshot = Object.freeze({
    text: "<State> and OpenAPI",
    anchorSide: "right",
    anchorNode: inlineAnchor,
    anchorRect: Object.freeze({
      top: 20,
      right: 400,
      bottom: 40,
      left: 390,
      width: 10,
      height: 20,
    }),
  });
  let retryCount = 0;
  let analyzeCount = 0;
  let analyzedCandidate = null;
  let activateCount = 0;
  let translateCount = 0;
  let analyzeSelectionCount = 0;
  let closeCount = 0;
  let inlineUi;
  const handlers = {
    onActivate() { activateCount += 1; },
    onTranslate() { translateCount += 1; },
    onAnalyzeSelection() { analyzeSelectionCount += 1; },
    onRetry() { retryCount += 1; },
    onAnalyze(candidate) { analyzeCount += 1; analyzedCandidate = candidate; },
    onClose() {
      closeCount += 1;
      inlineUi.closeInline();
    },
  };
  inlineUi = inlineUiHarness.ui;
  assert.equal(inlineUi.showInlineOffer(inlineSnapshot, handlers), true);
  const inlineRoot = inlineUiHarness.shell.children[0];
  const inlineOffer = inlineRoot.children[0];
  const [inlineTrigger, inlineTranslate, inlineAnalyze] = inlineOffer.children;
  assert.equal(inlineOffer.getAttribute("role"), "group");
  assert.equal(inlineOffer.getAttribute("aria-label"), "Действия с выделенным текстом");
  assert.equal(inlineOffer.children.length, 3);
  assert.equal(inlineTrigger.tagName, "BUTTON");
  assert.equal(inlineTrigger.type, "button");
  assert.equal(inlineTrigger.getAttribute("aria-label"), "Словарь");
  assert.equal(inlineTrigger.getAttribute("title"), "Словарь");
  assert.equal(inlineTranslate.getAttribute("aria-label"), "Перевести текст");
  assert.equal(inlineTranslate.getAttribute("title"), "Перевести текст");
  assert.equal(inlineAnalyze.getAttribute("aria-label"), "Анализировать текст");
  assert.equal(inlineAnalyze.getAttribute("title"), "Анализировать текст");
  assert.equal(inlineTrigger.getAttribute("aria-expanded"), "false");
  assert.equal(
    inlineTrigger.getAttribute("aria-controls"),
    analysisUi.INLINE_POPOVER_ID,
  );
  assert.equal(inlineTrigger.textContent, "");
  assert.equal(inlineTrigger.children.length, 1);
  const inlineTriggerIcon = inlineTrigger.children[0];
  assert.equal(inlineTriggerIcon.tagName, "SVG");
  assert.equal(inlineTriggerIcon.getAttribute("viewBox"), "0 0 24 24");
  assert.equal(inlineTriggerIcon.getAttribute("fill"), "none");
  assert.equal(inlineTriggerIcon.getAttribute("stroke"), "currentColor");
  assert.equal(inlineTriggerIcon.getAttribute("aria-hidden"), "true");
  assert.equal(inlineTriggerIcon.children.length, 2);
  assert.equal(inlineTriggerIcon.children.every((element) => element.tagName === "PATH"), true);
  assert.equal(inlineOffer.style.left, "272px");
  const backwardUiSnapshot = Object.freeze({
    ...inlineSnapshot,
    anchorSide: "left",
    anchorRect: Object.freeze({
      top: 50,
      right: 150,
      bottom: 70,
      left: 80,
      width: 70,
      height: 20,
    }),
  });
  assert.equal(inlineUi.showInlineOffer(backwardUiSnapshot, handlers, { glossaryEnabled: true }), true);
  assert.equal(inlineOffer.style.left, "80px");
  const forwardUiSnapshot = Object.freeze({
    ...inlineSnapshot,
    anchorSide: "right",
    anchorRect: Object.freeze({
      top: 50,
      right: 250,
      bottom: 70,
      left: 180,
      width: 70,
      height: 20,
    }),
  });
  assert.equal(inlineUi.showInlineOffer(forwardUiSnapshot, handlers, { glossaryEnabled: true }), true);
  assert.equal(inlineOffer.style.left, "130px");
  assert.equal(inlineUi.showInlineOffer(inlineSnapshot, handlers, { glossaryEnabled: true }), true);
  assert.equal(inlineOffer.style.left, "272px");
  assert.equal(inlineUi.inlineContainsPath([inlineTrigger]), true);
  assert.equal(inlineUi.inlineContainsPath([inlineRoot]), false);
  assert.equal(inlineUiHarness.rootNode.activeElement, null);
  inlineTrigger.click();
  assert.equal(activateCount, 1);
  inlineTranslate.click();
  inlineAnalyze.click();
  assert.equal(translateCount, 1);
  assert.equal(analyzeSelectionCount, 1);
  assert.equal(inlineUi.showInlineOffer(inlineSnapshot, handlers, { glossaryEnabled: false }), true);
  assert.equal(inlineTrigger.disabled, true);
  assert.equal(inlineTrigger.getAttribute("title"), "Словарь временно недоступен");
  assert.notEqual(inlineTranslate.disabled, true);
  assert.notEqual(inlineAnalyze.disabled, true);
  assert.equal(inlineUi.showInlineOffer(inlineSnapshot, handlers, { glossaryEnabled: true }), true);
  assert.equal(inlineTrigger.disabled, false);

  assert.equal(inlineUi.showInlineLoading(inlineSnapshot, handlers), true);
  const inlineLive = inlineRoot.children[1];
  const inlinePopover = inlineRoot.children[2];
  assert.equal(inlineOffer.hidden, true);
  assert.equal(inlinePopover.getAttribute("role"), "region");
  assert.equal(inlinePopover.getAttribute("aria-modal"), null);
  assert.equal(inlineTrigger.getAttribute("aria-expanded"), "true");
  assert.equal(inlinePopover.hidden, false);
  assert.equal(inlinePopover.style.left, "32px");
  assert.equal(inlinePopover.style.top, "46px");
  assert.equal(inlineUi.inlineContainsPath([inlinePopover]), true);
  assert.equal(inlineUi.inlineContainsPath([inlinePopover.children[0]]), true);
  const externalBrowserPath = [
    inlineUiHarness.documentValue.createElement("main"),
    inlineUiHarness.documentValue,
    inlineUiHarness.windowValue,
  ];
  assert.throws(
    () => inlineTrigger.contains(inlineUiHarness.windowValue),
    /INLINE_FAKE_CONTAINS_REQUIRES_NODE/,
    "the fake must reject Window-like values like native Node.contains()",
  );
  assert.doesNotThrow(() => inlineUi.inlineContainsPath(externalBrowserPath));
  assert.equal(inlineUi.inlineContainsPath(externalBrowserPath), false);
  assert.equal(inlineUi.inlineContainsPath([
    inlinePopover.children[0],
    inlineUiHarness.documentValue,
    inlineUiHarness.windowValue,
  ]), true);

  const productionPathOwner = (path) => inlineUi.inlineContainsPath(path);
  const samePagePointerHarness = createInlineContentHarness({
    inlineContainsPath: productionPathOwner,
  });
  samePagePointerHarness.api.showInlineOffer(inlineContentSnapshot("State", 0));
  samePagePointerHarness.api.handleInlinePointerDown({
    button: 0,
    isPrimary: true,
    pointerId: 91,
    pointerType: "mouse",
  }, externalBrowserPath);
  assert.equal(samePagePointerHarness.state.inlineGlossary.phase, "closed");
  assert.equal(samePagePointerHarness.state.inlineGlossary.snapshot, null);
  assert.equal(samePagePointerHarness.state.inlineGlossary.result, null);
  assert.equal(samePagePointerHarness.state.inlineGlossary.error, null);
  assert.equal(samePagePointerHarness.uiCalls.at(-1).phase, "closed");

  const samePageFocusHarness = createInlineContentHarness({
    inlineContainsPath: productionPathOwner,
  });
  samePageFocusHarness.api.showInlineOffer(inlineContentSnapshot("State", 0));
  assert.equal(samePageFocusHarness.api.handleInlineFocusIn({
    composedPath() { return externalBrowserPath; },
  }), true);
  assert.equal(samePageFocusHarness.state.inlineGlossary.phase, "closed");
  assert.equal(samePageFocusHarness.state.inlineGlossary.snapshot, null);
  assert.equal(samePageFocusHarness.state.inlineGlossary.result, null);
  assert.equal(samePageFocusHarness.state.inlineGlossary.error, null);
  assert.equal(samePageFocusHarness.uiCalls.at(-1).phase, "closed");
  assert.match(inlinePopover.textContent, /Ищем в словаре/);
  assert.match(inlineLive.textContent, /Ищем в словаре/);
  assert.equal(inlineUi.inlineOwnsFocus(), false);
  const inlineCloseButton = inlinePopover.children[0].children[1];
  assert.equal(inlineCloseButton.className, "inline-glossary-close");
  assert.equal(inlineUiHarness.rootNode.activeElement, null);
  inlineTrigger.click();
  assert.equal(activateCount, 1);
  assert.equal(inlinePopover.hidden, false);

  assert.equal(inlineUi.showInlineOffer(inlineSnapshot, handlers, { glossaryEnabled: true }), true);
  assert.equal(inlineOffer.hidden, false);
  assert.equal(inlineOffer.children.length, 3);
  assert.equal(inlinePopover.hidden, true);
  assert.equal(inlineUi.showInlineLoading(inlineSnapshot, handlers), true);
  assert.equal(inlineOffer.hidden, true);

  const stateCandidate = {
    displayTerm: "State",
    normalizedKey: "state",
    firstIndex: 0,
    tokenCount: 1,
    occurrences: 1,
    source: "token",
    visibility: "primary",
  };
  assert.equal(inlineUi.showInlineResult(inlineSnapshot, {
    groups: [{
      candidate: stateCandidate,
      matchClass: "exact",
      exactMissing: false,
      entries: [{
        id: "sense-one",
        term: "State",
        translation: "состояние",
        definition: "Одно значение.",
        attached: true,
        matchClass: "exact",
      }],
    }],
    missing: [],
    totals: {
      candidateCountBeforeLimit: 1,
      candidateCountReturned: 1,
      matchedCandidateCount: 1,
      matchedEntryCountBeforeLimit: 1,
      matchedEntryCountReturned: 1,
    },
    truncated: { candidates: false, entries: false },
  }, handlers), true);
  assert.equal(inlineOffer.hidden, true);
  assert.match(inlinePopover.textContent, /Одно значение\./);
  assert.match(inlinePopover.textContent, /Точное совпадение/);
  assert.match(inlinePopover.textContent, /Точное значение/);
  assert.doesNotMatch(inlinePopover.textContent, /Показано \d+ из \d+/);
  assert.equal(
    inlineDescendants(inlineRoot)
      .some((element) => element.tagName === "BUTTON" && element.textContent === "Разобрать"),
    false,
    "an exact saved primary candidate does not expose a provider action",
  );

  const openApiCandidate = {
    displayTerm: "OpenAPI",
    normalizedKey: "open api",
    firstIndex: 12,
    tokenCount: 1,
    occurrences: 1,
    source: "token",
    visibility: "primary",
  };
  assert.equal(inlineUi.showInlineResult(inlineSnapshot, {
    groups: [{
      candidate: stateCandidate,
      matchClass: "contiguous",
      exactMissing: true,
      entries: [
        {
          id: "sense-attached",
          term: "<img src=x onerror=alert(1)>",
          translation: "<svg/onload=alert(1)>",
          definition: "<script>alert(1)</script>",
          attached: true,
          matchClass: "contiguous",
        },
        {
          id: "sense-global",
          term: "State",
          translation: "режим",
          definition: "Глобальное значение.",
          attached: false,
          matchClass: "full-token",
        },
      ],
    }],
    missing: [openApiCandidate],
    totals: {
      candidateCountBeforeLimit: 3,
      candidateCountReturned: 2,
      matchedCandidateCount: 1,
      matchedEntryCountBeforeLimit: 3,
      matchedEntryCountReturned: 2,
    },
    truncated: { candidates: true, entries: true },
  }, handlers), true);
  assert.match(inlinePopover.textContent, /<img src=x onerror=alert\(1\)>/);
  assert.match(inlinePopover.textContent, /<script>alert\(1\)<\/script>/);
  assert.match(inlinePopover.textContent, /В этом чате/);
  assert.match(inlinePopover.textContent, /Общий словарь/);
  assert.match(inlinePopover.textContent, /Связанное совпадение/);
  assert.match(inlinePopover.textContent, /Связанные записи/);
  assert.match(inlinePopover.textContent, /Точного значения «State» нет\./);
  assert.match(inlinePopover.textContent, /Не найдено/);
  assert.match(inlinePopover.textContent, /OpenAPI/);
  assert.match(inlinePopover.textContent, /Показано 2 из 3 кандидатов\./);
  assert.match(inlinePopover.textContent, /Показано 2 из 3 совпадений\./);
  assert.equal(inlineDescendants(inlineRoot).some((element) => element.tagName === "IMG"), false);
  assert.equal(inlineDescendants(inlineRoot).some((element) => element.tagName === "SCRIPT"), false);
  const candidateActions = inlineDescendants(inlineRoot)
    .filter((element) => element.tagName === "BUTTON" && element.textContent === "Разобрать");
  assert.deepEqual(
    candidateActions.map((element) => element.getAttribute("aria-label")),
    ["Разобрать State", "Разобрать OpenAPI"],
  );
  const analyzeOpenApi = candidateActions.at(-1);
  analyzeOpenApi.click();
  assert.equal(analyzeCount, 1);
  assert.equal(analyzedCandidate.normalizedKey, "open api");

  const lookupOnlyCandidate = {
    displayTerm: "route handler",
    normalizedKey: "route handler",
    firstIndex: 0,
    tokenCount: 2,
    occurrences: 1,
    source: "ngram",
    visibility: "lookup-only",
  };
  assert.equal(inlineUi.showInlineResult(inlineSnapshot, {
    groups: [{
      candidate: lookupOnlyCandidate,
      matchClass: "exact",
      exactMissing: false,
      entries: [{
        id: "sense-route-handler",
        term: "route handler",
        translation: "обработчик маршрута",
        definition: "Обрабатывает маршрут.",
        attached: false,
        matchClass: "exact",
      }],
    }],
    missing: [],
    totals: {
      candidateCountBeforeLimit: 3,
      candidateCountReturned: 3,
      matchedCandidateCount: 3,
      matchedEntryCountBeforeLimit: 1,
      matchedEntryCountReturned: 1,
    },
    truncated: { candidates: false, entries: false },
  }, handlers), true);
  assert.match(inlinePopover.textContent, /route handler/);
  assert.equal(
    inlineDescendants(inlineRoot)
      .some((element) => element.tagName === "BUTTON" && element.textContent === "Разобрать"),
    false,
    "matched lookup-only groups do not expose provider actions",
  );

  const manyMissingCandidates = Array.from({ length: 7 }, (_, index) => ({
    displayTerm: `Candidate${index}`,
    normalizedKey: `candidate${index}`,
    firstIndex: index,
    tokenCount: 1,
    occurrences: 1,
    source: "token",
    visibility: "primary",
  }));
  assert.equal(inlineUi.showInlineResult(inlineSnapshot, {
    groups: [],
    missing: manyMissingCandidates,
    totals: {
      candidateCountBeforeLimit: 7,
      candidateCountReturned: 7,
      matchedCandidateCount: 0,
      matchedEntryCountBeforeLimit: 0,
      matchedEntryCountReturned: 0,
    },
    truncated: { candidates: false, entries: false },
  }, handlers), true);
  assert.equal(inlinePopover.className, "inline-glossary-popover is-many");
  assert.equal(inlinePopover.style.width, "384px");
  assert.match(inlineLive.textContent, /0 совпадений, 7 без совпадений/);
  assert.equal(inlineUi.showInlineLoading(inlineSnapshot, handlers), true);
  assert.equal(inlineOffer.hidden, true);
  assert.equal(inlinePopover.className, "inline-glossary-popover");
  assert.equal(inlinePopover.style.width, "360px");
  assert.match(inlineLive.textContent, /Ищем в словаре/);

  assert.equal(inlineUi.showInlineError(
    inlineSnapshot,
    { message: "<unsafe workspace error>" },
    handlers,
  ), true);
  assert.equal(inlineOffer.hidden, true);
  const errorElements = inlineDescendants(inlineRoot);
  errorElements.find((element) => element.tagName === "BUTTON" && element.textContent === "Повторить").click();
  assert.equal(retryCount, 1);
  assert.equal(analyzeCount, 1);
  assert.equal(
    errorElements.some((element) => element.tagName === "BUTTON" && element.textContent === "Разобрать"),
    false,
  );
  assert.match(inlinePopover.textContent, /<unsafe workspace error>/);
  assert.equal(inlineLive.textContent, "Не удалось открыть словарь.");
  assert.equal(inlineUi.handleInlineEscape(), true);
  assert.equal(closeCount, 1);
  assert.equal(inlineRoot.isConnected, false);
  assert.equal(inlineUi.handleInlineEscape(), false);

  inlineUi.showResult({
    terms: [{
      term: "State",
      translation: "режим",
      definition: "Новая версия.",
      status: "replacementAvailable",
      savedEntry: {
        id: "saved-state",
        translation: "состояние",
        definition: "Сохранённая версия.",
      },
      replacementCandidate: {
        targetSenseId: "saved-state",
        expectedUpdatedAt: 42,
        proposed: {
          translation: "режим",
          definition: "Новая версия.",
        },
      },
    }],
  });
  const replacementElements = inlineDescendants(inlineUiHarness.shell);
  assert.match(inlineUiHarness.shell.textContent, /Есть другая версия/);
  const replacementArrow = replacementElements.find(
    (element) => element.className === "analysis-replace",
  );
  assert.ok(replacementArrow);
  assert.equal(replacementArrow.getAttribute("aria-label"), "Заменить сохранённую версию");
  assert.equal(replacementArrow.children[0].tagName, "SVG");
  const replacementTooltip = replacementElements.find(
    (element) => element.className === "analysis-duplicate-tooltip",
  );
  assert.equal(replacementTooltip.getAttribute("role"), "tooltip");
  assert.match(replacementTooltip.textContent, /Сохранено сейчас/);
  replacementArrow.dispatch("pointerenter");
  assert.equal(replacementTooltip.hidden, false);
  replacementArrow.dispatch("pointerleave");
  assert.equal(replacementTooltip.hidden, true);

  inlineUi.showResult({
    terms: [{
      term: "State",
      translation: "состояние",
      definition: "Сохранённая версия.",
      status: "alreadySaved",
    }],
  });
  assert.match(inlineUiHarness.shell.textContent, /Уже сохранено/);
  assert.equal(
    inlineDescendants(inlineUiHarness.shell)
      .some((element) => element.className === "analysis-replace"),
    false,
  );
} finally {
  inlineUiHarness.restore();
}

assert.equal(analysisUi.glossaryTextSizeClass("analysis-result-list", { analysis: { glossaryTextSize: "compact" } }), "analysis-result-list size-compact");
assert.equal(analysisUi.glossaryTextSizeClass("analysis-result-list", { analysis: { glossaryTextSize: "normal" } }), "analysis-result-list size-normal");
assert.equal(analysisUi.glossaryTextSizeClass("analysis-result-list", { analysis: { glossaryTextSize: "large" } }), "analysis-result-list size-large");
assert.equal(analysisUi.nextFocusableIndex(0, 3, true), 2);
assert.equal(analysisUi.nextFocusableIndex(2, 3, false), 0);
assert.equal(analysisUi.nextFocusableIndex(-1, 3, false), 0);
assert.equal(analysisUi.nextFocusableIndex(-1, 3, true), 2);
assert.equal(analysisUi.nextFocusableIndex(0, 0, false), -1);
const deterministicReplacementTerm = {
  status: "replacementAvailable",
  translation: "новый перевод",
  definition: "Новое определение.",
  replacementCandidate: {
    targetSenseId: "target-sense",
    expectedUpdatedAt: 42,
    proposed: {
      translation: "новый перевод",
      definition: "Новое определение.",
    },
  },
};
assert.deepEqual(analysisUi.replacementCommandForTerm(deterministicReplacementTerm), {
  senseId: "target-sense",
  expectedUpdatedAt: 42,
  replacement: {
    translation: "новый перевод",
    definition: "Новое определение.",
  },
});
assert.equal(analysisUi.replacementCommandForTerm({
  ...deterministicReplacementTerm,
  status: "new",
}), null);
assert.equal(analysisUi.replacementCommandForTerm({ status: "new" }), null);
assert.doesNotMatch(contentScriptSource, /chrome\.storage\.local\.set\s*\(/);
assert.doesNotMatch(contentScriptSource, /\bindexedDB\b/);
assert.doesNotMatch(contentScriptSource, /chrome\.storage\.local\.(?:remove|clear)\s*\(/);
assert.match(optionsHtmlSource, /<html lang="ru" class="theme-system theme-pending">/);
assert.match(optionsHtmlSource, /<h1>Настройки расширения<\/h1>/);
assert.match(optionsHtmlSource, /<section id="backup"[\s\S]*<h2 id="backup-title">Импорт и экспорт<\/h2>/);
assert.match(optionsHtmlSource, /Файлы создаются и обрабатываются локально\.<br>API key никогда не включается в экспорт\./);
assert.equal([...optionsHtmlSource.matchAll(/data-backup-action="export"[^>]*>Экспорт<\/button>/g)].length, 2);
assert.equal([...optionsHtmlSource.matchAll(/<label class="file-button">Импорт<input type="file"/g)].length, 2);
assert.doesNotMatch(optionsHtmlSource, /Экспортировать настройки|Экспортировать данные|Выбрать файл/);
assert.match(optionsHtmlSource, /data-backup-selected-file="settings"[\s\S]*data-backup-filename="settings"[\s\S]*aria-label="Отменить выбор файла настроек"/);
assert.match(optionsHtmlSource, /data-backup-selected-file="data"[\s\S]*data-backup-filename="data"[\s\S]*aria-label="Отменить выбор файла данных"/);
assert.match(optionsHtmlSource, />Применить настройки<\/button>/);
assert.match(optionsHtmlSource, />Применить данные<\/button>/);
assert.match(optionsStylesSource, /html\.theme-pending body \{ visibility: hidden; \}/);
assert.match(optionsStylesSource, /@media \(prefers-color-scheme: dark\) \{\s*:root\.theme-system \{/);
assert.doesNotMatch(optionsStylesSource, /@media \(prefers-color-scheme: dark\) \{\s*:root\s*\{/);
assert.match(optionsStylesSource, /\.selected-file-name \{[^}]*overflow: hidden;[^}]*text-overflow: ellipsis;[^}]*white-space: nowrap;/);
assert.match(optionsStylesSource, /\.file-button \{[^}]*font-weight: inherit;/);
assert.doesNotMatch(optionsScriptSource, /document\.documentElement\.className\s*=/);
assert.match(optionsScriptSource, /function clearBackupSelection\(kind\)/);
assert.match(contentScriptSource, /<h3>Настройки расширения<\/h3>/);
assert.match(contentScriptSource, /Ключ OpenRouter, импорт и экспорт настроек и данных\./);
assert.match(contentScriptSource, /data-action="open-extension-options">Открыть настройки расширения<\/button>/);
assert.match(contentScriptSource, /action === "open-extension-options"\) \{\s*await state\.analysisController\?\.openOptions\(\);/);
assert.doesNotMatch(contentScriptSource, /open-backup-options/);
assert.match(analysisControllerSource, /async function openOptions\(section\)[\s\S]*section === "backup"[\s\S]*section: "backup"/);
assert.match(serviceWorkerSource, /message\.section === "backup"[\s\S]*src\/options\.html#backup/);
assert.equal(JSON.parse(manifestSource).options_ui.page, "src/options.html");
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
  < workspaceEscapeSource.indexOf("state.analysisUi?.handleInlineEscape()"), true);
assert.equal(workspaceEscapeSource.indexOf("state.analysisUi?.handleInlineEscape()")
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

const inlineCaptureSource = chatGptDomSource.slice(
  chatGptDomSource.indexOf("function captureInlineGlossarySelection"),
  chatGptDomSource.indexOf("function normalizeComposerPlainText"),
);
assert.match(inlineCaptureSource, /selection\.rangeCount !== 1/);
assert.match(inlineCaptureSource, /inlineEditableElement/);
assert.match(inlineCaptureSource, /inlineExtensionElement/);
assert.match(inlineCaptureSource, /getClientRects/);
assert.match(inlineCaptureSource, /\.at\(-1\)/);
assert.match(inlineCaptureSource, /Object\.freeze\(\{\s*top: rect\.top/);
assert.doesNotMatch(inlineCaptureSource, /cloneRange|removeAllRanges|addRange|insertNode|surroundContents/);
assert.doesNotMatch(inlineCaptureSource, /\b(?:range|selection)\s*[:,]\s*(?:range|selection)\b/);

const inlineUiRendererSource = analysisUiSource.slice(
  analysisUiSource.indexOf("function inlineActionButton"),
  analysisUiSource.indexOf("function removeToast"),
);
assert.match(inlineUiRendererSource, /document\.createElement\("button"\)/);
assert.match(inlineUiRendererSource, /button\.type = "button"/);
assert.match(inlineUiRendererSource, /shell\(\)\?\.appendChild\(inlineRoot\)/);
assert.match(inlineUiRendererSource, /setAttribute\("role", "region"\)/);
assert.doesNotMatch(inlineUiRendererSource, /aria-modal|innerHTML/);
assert.match(inlineUiRendererSource, /"Словарь"/);
assert.match(inlineUiRendererSource, /"Перевести текст"/);
assert.match(inlineUiRendererSource, /"Анализировать текст"/);
assert.match(inlineUiRendererSource, /inlineOffer\.append\(inlineTrigger, inlineTranslate, inlineAnalyze\)/);
assert.match(inlineUiRendererSource, /glossaryEnabled \? "Словарь" : "Словарь временно недоступен"/);
assert.match(inlineUiRendererSource, /createElementNS\("http:\/\/www\.w3\.org\/2000\/svg", "svg"\)/);
assert.match(inlineUiRendererSource, /setAttribute\("aria-hidden", "true"\)/);
assert.doesNotMatch(inlineUiRendererSource, /📖|label\.textContent = "Словарь"/);
assert.match(inlineUiRendererSource, /textContent = entry\.term/);
assert.match(inlineUiRendererSource, /textContent = entry\.definition/);
assert.match(inlineUiRendererSource, /"В этом чате" : "Общий словарь"/);
assert.match(inlineUiRendererSource, /result\.totals\.candidateCountReturned/);
assert.match(inlineUiRendererSource, /result\.totals\.matchedEntryCountReturned/);
assert.match(inlineUiRendererSource, /inlineLive\.textContent/);
assert.match(inlineUiRendererSource, /aria-live/);
assert.match(inlineUiRendererSource, /"Повторить"/);
assert.match(inlineUiRendererSource, /"Разобрать"/);
assert.match(
  inlineUiRendererSource,
  /group\.candidate\.visibility === "primary" && exactEntries\.length === 0/,
);
const inlineErrorRendererSource = inlineUiRendererSource.slice(
  inlineUiRendererSource.indexOf("function showInlineError"),
  inlineUiRendererSource.indexOf("function handleInlineEscape"),
);
assert.doesNotMatch(inlineErrorRendererSource, /onAnalyze|Разобрать/);
assert.doesNotMatch(
  inlineUiRendererSource,
  /onReplace|attachGlossary|unlinkGlossary|deleteGlossary|reorderGlossary|persist/i,
);
const providerLoadingOwnerSource = analysisUiSource.slice(
  analysisUiSource.indexOf("function showLoading()"),
  analysisUiSource.indexOf("function showHint"),
);
const providerDialogOwnerSource = analysisUiSource.slice(
  analysisUiSource.indexOf("function dialogFrame"),
  analysisUiSource.indexOf("function showResult"),
);
assert.match(providerLoadingOwnerSource, /function showLoading\(\) \{\s*closeInline\(\);/);
assert.match(providerDialogOwnerSource, /function dialogFrame\(title, variant\) \{\s*closeInline\(\);/);

const inlineSessionSource = contentScriptSource.slice(
  contentScriptSource.indexOf("function aiOperationBusy"),
  contentScriptSource.indexOf("function handleWorkspaceContextChange"),
);
const inlineOfferSource = inlineSessionSource.slice(
  inlineSessionSource.indexOf("function showInlineOffer"),
  inlineSessionSource.indexOf("function inlineLookupOwns"),
);
const inlineSnapshotCurrentSource = inlineSessionSource.slice(
  inlineSessionSource.indexOf("function inlineSnapshotCurrent"),
  inlineSessionSource.indexOf("function cancelInlineGestureSettle"),
);
const inlineOwnershipSource = inlineSessionSource.slice(
  inlineSessionSource.indexOf("function inlineLookupOwns"),
  inlineSessionSource.indexOf("async function performInlineGlossaryLookup"),
);
const inlineLookupDispatchSource = inlineSessionSource.slice(
  inlineSessionSource.indexOf("async function performInlineGlossaryLookup"),
  inlineSessionSource.indexOf("function activateInlineGlossary"),
);
const inlineFallbackSource = inlineSessionSource.slice(
  inlineSessionSource.indexOf("async function analyzeInlineGlossaryCandidate"),
  inlineSessionSource.indexOf("function captureInlineGlossarySelection"),
);
const inlineSessionCaptureSource = inlineSessionSource.slice(
  inlineSessionSource.indexOf("function captureInlineGlossarySelection"),
  inlineSessionSource.indexOf("function beginInlineGesture"),
);
const inlineGestureSource = inlineSessionSource.slice(
  inlineSessionSource.indexOf("function beginInlineGesture"),
);
assert.match(inlineSessionSource, /phase: "offering"/);
assert.match(inlineSessionSource, /phase: "loading"/);
assert.match(inlineSessionSource, /phase: "showing"/);
assert.match(inlineSessionSource, /phase: "error"/);
assert.doesNotMatch(inlineOfferSource, /lookupGlossarySelection|openRouter|runAnalysis|sendMessage/);
assert.match(inlineSessionSource, /const snapshot = Object\.freeze/);
assert.match(inlineOwnershipSource, /current\.requestToken === requestToken/);
assert.match(inlineOwnershipSource, /current\.selectionToken === selectionToken/);
assert.match(inlineOwnershipSource, /current\.snapshot === snapshot/);
assert.match(inlineOwnershipSource, /inlineGlossarySnapshotCurrent\(snapshot\)/);
assert.match(inlineSnapshotCurrentSource, /snapshot\.pageUrl === location\.href/);
assert.match(inlineSnapshotCurrentSource, /scopeKey === snapshot\.conversationScope/);
assert.match(inlineSnapshotCurrentSource, /snapshot\.anchorNode\?\.isConnected === true/);
assert.match(inlineSnapshotCurrentSource, /state\.workspaceStatus\.status === "ready"/);
assert.equal(
  inlineLookupDispatchSource.indexOf("inlineGlossarySnapshotCurrent(snapshot)")
    < inlineLookupDispatchSource.indexOf("lookupGlossarySelection(snapshot.text)"),
  true,
);
assert.doesNotMatch(contentScriptSource, /inlineSelectionSuppression|INLINE_SELECTION_DEBOUNCE_MS/);
assert.doesNotMatch(contentScriptSource, /function inlinePhaseCommitted/);
assert.doesNotMatch(inlineUiRendererSource, /function (?:collapseInline|showInlineEmpty)/);
assert.match(inlineSessionCaptureSource, /generation/);
assert.match(inlineFallbackSource, /current\.phase !== "showing"/);
assert.match(inlineFallbackSource, /inlineResultContainsCandidate/);
assert.match(inlineFallbackSource, /inlineGlossarySnapshotCurrent\(snapshot\)/);
assert.match(inlineFallbackSource, /const displayTerm = candidate\.displayTerm/);
assert.match(inlineFallbackSource, /const pageUrl = snapshot\.pageUrl/);
assert.equal(
  inlineFallbackSource.indexOf("closeInlineGlossary()")
    < inlineFallbackSource.indexOf('runAnalysis("inline-assistant", displayTerm, pageUrl)'),
  true,
);
assert.doesNotMatch(inlineFallbackSource, /openRouter|provider|context-menu|browser-command/);

assert.match(inlineGestureSource, /generation/);
assert.match(inlineGestureSource, /requestAnimationFrame/);
assert.match(inlineGestureSource, /pendingTask = setTimeout/);
assert.match(inlineGestureSource, /pointerId/);
assert.match(inlineGestureSource, /supportedInlineSelectionKey/);
assert.match(inlineGestureSource, /keyboardActive/);
assert.match(inlineGestureSource, /shiftHeld/);
assert.match(inlineGestureSource, /selectionKeys/);
assert.match(inlineGestureSource, /finishInlineKeyboardGestureIfReady/);
assert.match(contentScriptSource, /document\.addEventListener\("selectionchange", markInlineGestureSelectionChanged\)/);
assert.match(contentScriptSource, /document\.addEventListener\("pointerup", handleInlinePointerUp, \{ capture: true \}\)/);
assert.match(contentScriptSource, /document\.addEventListener\("keyup", handleInlineKeyUp, \{ capture: true \}\)/);
assert.match(contentScriptSource, /document\.addEventListener\("pointercancel", cancelInlinePointerGesture, \{ capture: true \}\)/);
assert.match(contentScriptSource, /document\.addEventListener\("focusin", handleInlineFocusIn, \{ capture: true \}\)/);
assert.match(contentScriptSource, /document\.addEventListener\("copy", handleInlineCopy, \{ capture: true \}\)/);
assert.match(contentScriptSource, /document\.addEventListener\("cut", handleInlineExternalAction, \{ capture: true \}\)/);
assert.match(contentScriptSource, /document\.addEventListener\("paste", handleInlineExternalAction, \{ capture: true \}\)/);
assert.match(contentScriptSource, /document\.addEventListener\("beforeinput", handleInlineExternalAction, \{ capture: true \}\)/);
assert.match(contentScriptSource, /window\.addEventListener\("blur"/);
const inlineOutsidePointerSource = contentScriptSource.slice(
  contentScriptSource.indexOf('document.addEventListener("pointerdown", function handleOutsidePointer'),
  contentScriptSource.indexOf('window.addEventListener("focus", function handleWindowFocus'),
);
assert.match(inlineSessionSource, /function closeInlineGlossaryOutsidePath[\s\S]*inlineContainsPath\(path\)/);
assert.match(inlineOutsidePointerSource, /handleInlinePointerDown\(event, path\)/);
assert.match(inlineOutsidePointerSource, /\}, \{ capture: true \}\);/);
assert.match(inlineOutsidePointerSource, /document\.addEventListener\("scroll"/);
assert.match(inlineOutsidePointerSource, /\{ capture: true, passive: true \}/);
const inlineExternalCloseSource = inlineSessionSource.slice(
  inlineSessionSource.indexOf("function handleInlineFocusIn"),
  inlineSessionSource.indexOf("function closeInlineGlossaryForInvalidation"),
);
assert.match(inlineExternalCloseSource, /function scheduleInlineGlossaryCloseAfterEvent[\s\S]*setTimeout/);
assert.doesNotMatch(inlineExternalCloseSource, /preventDefault|stopPropagation/);
const inlinePathOwnerSource = inlineUiRendererSource.slice(
  inlineUiRendererSource.indexOf("function inlineContainsPath"),
  inlineUiRendererSource.indexOf("function inlineOwnsFocus"),
);
assert.match(inlinePathOwnerSource, /\[inlineOffer, inlinePopover\]/);
assert.doesNotMatch(inlinePathOwnerSource, /path\.includes\(inlineRoot\)|inlineRoot\.contains/);
const inlineResizeSource = contentScriptSource.slice(
  contentScriptSource.indexOf('window.addEventListener("resize", function handleWindowResize'),
  contentScriptSource.indexOf("chrome.runtime.onMessage.addListener"),
);
assert.equal(
  inlineResizeSource.indexOf("closeInlineGlossary")
    < inlineResizeSource.indexOf("closeTemplatePreview"),
  true,
);
const inlineToggleMessageSource = contentScriptSource.slice(
  contentScriptSource.indexOf("if (message?.type === TOGGLE_MESSAGE)"),
  contentScriptSource.indexOf("if (message?.type === commandRegistry.CONTENT_MESSAGE_TYPES.ANALYZE"),
);
assert.equal(
  inlineToggleMessageSource.indexOf("closeInlineGlossary()")
    < inlineToggleMessageSource.indexOf("ensureMounted()"),
  true,
);
const inlineInvalidationStart = contentScriptSource.indexOf(
  "if (message?.type === workspaceContract.MESSAGE_TYPES.CHANGED)",
);
const inlineInvalidationSource = contentScriptSource.slice(
  inlineInvalidationStart,
  contentScriptSource.indexOf("    return false;\n  });", inlineInvalidationStart),
);
assert.match(inlineSessionSource, /ENTITY_FAMILIES\.ALL, workspaceContract\.ENTITY_FAMILIES\.GLOSSARY/);
assert.match(inlineInvalidationSource, /closeInlineGlossaryForInvalidation\(message\.entityFamily\)/);
assert.doesNotMatch(
  inlineInvalidationSource.slice(
    inlineInvalidationSource.indexOf("ENTITY_FAMILIES.SAVED"),
    inlineInvalidationSource.indexOf("ENTITY_FAMILIES.CONVERSATIONS"),
  ),
  /closeInlineGlossary/,
);
const inlineContextSource = contentScriptSource.slice(
  contentScriptSource.indexOf("function handleWorkspaceContextChange"),
  contentScriptSource.indexOf("async function deleteWorkspaceEntry"),
);
assert.match(
  inlineContextSource,
  /function handleWorkspaceContextChange[\s\S]*closeInlineGlossary\(\)/,
);
assert.match(
  inlineContextSource,
  /status\.status === "unavailable"[\s\S]*closeInlineGlossary\(\)/,
);
const inlineMountSource = contentScriptSource.slice(
  contentScriptSource.indexOf("function mount()"),
  contentScriptSource.indexOf("async function loadStorage"),
);
assert.match(
  inlineMountSource,
  /function mount\(\) \{[\s\S]*closeInlineGlossary\(\)/,
);
assert.match(inlineMountSource, /!state\.inlineGlossary\.snapshot\?\.anchorNode\?\.isConnected[\s\S]*closeInlineGlossary/);
const inlineAnalysisStartSource = contentScriptSource.slice(
  contentScriptSource.indexOf("async function runAnalysis"),
  contentScriptSource.indexOf("async function runSaveSelection"),
);
assert.match(inlineAnalysisStartSource, /closeInlineGlossary\(\)/);
assert.match(contentScriptSource, /const mountObserver = new MutationObserver\(ensureMounted\)/);

assert.equal(
  contract.MESSAGE_TYPES.KEY_STATUS_CHANGED,
  "chatgpt-helper:openrouter-key-status-changed",
);
const analysisStyles = analysisUi.styles();
assert.match(analysisStyles, /\.analysis-replace \{[^}]*display: inline-flex;[^}]*padding: 0;[^}]*align-items: center;[^}]*justify-content: center;[^}]*line-height: 0;/);
assert.match(analysisStyles, /\.analysis-replace svg \{[^}]*display: block;[^}]*width: 16px;[^}]*height: 16px;/);
assert.doesNotMatch(analysisStyles, /analysis-search-clear/);
assert.match(analysisStyles, /\.inline-glossary-root \{[^}]*position: fixed;[^}]*pointer-events: none;/);
assert.match(analysisStyles, /\.inline-selection-actions \{[^}]*position: fixed;[^}]*display: flex;[^}]*gap: 6px;[^}]*pointer-events: auto;/);
assert.match(analysisStyles, /\.inline-selection-action \{[^}]*width: 36px;[^}]*height: 36px;[^}]*border-radius: 50%;/);
assert.match(analysisStyles, /\.inline-selection-action svg \{[^}]*width: 18px;[^}]*height: 18px;[^}]*stroke-width: 1\.8;/);
assert.match(analysisStyles, /\.inline-glossary-popover \{[^}]*width: min\(360px, calc\(100vw - 16px\)\);[^}]*max-height: min\(420px, 60vh\);[^}]*grid-template-rows: auto minmax\(0, 1fr\);[^}]*overflow: hidden;/);
assert.match(analysisStyles, /\.inline-glossary-body \{[^}]*overflow-y: auto;[^}]*overscroll-behavior: contain;/);
assert.match(analysisStyles, /\.translation-result \{[^}]*white-space: pre-wrap;[^}]*overflow-wrap: anywhere;[^}]*user-select: text;/);
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

async function runOptionsPageBehaviorTests() {
  const knownThemeClasses = ["theme-system", "theme-graphite", "theme-navy", "theme-violet", "theme-gold"];
  const themeHarness = createOptionsPageHarness({ settings: { theme: "navy" } });
  await themeHarness.settle();
  assert.equal(themeHarness.rootClasses.has("theme-navy"), true);
  assert.equal(themeHarness.rootClasses.has("theme-pending"), false);
  assert.equal(themeHarness.rootClasses.has("service-ready"), true);
  assert.equal(knownThemeClasses.filter((name) => themeHarness.rootClasses.has(name)).length, 1);
  themeHarness.api.applyTheme({ theme: "violet" });
  assert.equal(themeHarness.rootClasses.has("theme-violet"), true);
  assert.equal(themeHarness.rootClasses.has("service-ready"), true);
  assert.equal(knownThemeClasses.filter((name) => themeHarness.rootClasses.has(name)).length, 1);
  themeHarness.api.applyTheme({ theme: "not-a-theme" });
  assert.equal(themeHarness.rootClasses.has("theme-system"), true);
  assert.equal(knownThemeClasses.filter((name) => themeHarness.rootClasses.has(name)).length, 1);
  themeHarness.emitStorageChange({ settings: { newValue: { theme: "gold" } } });
  assert.equal(themeHarness.rootClasses.has("theme-gold"), true);
  assert.equal(themeHarness.rootClasses.has("service-ready"), true);

  const failedThemeHarness = createOptionsPageHarness({ storageError: new Error("settings unavailable") });
  await failedThemeHarness.settle();
  assert.equal(failedThemeHarness.rootClasses.has("theme-system"), true);
  assert.equal(failedThemeHarness.rootClasses.has("theme-pending"), false);
  assert.equal(failedThemeHarness.rootClasses.has("service-ready"), true);

  const keyStatusDeferred = createDeferredPromise();
  const keyBusyHarness = createOptionsPageHarness({
    settings: { theme: "system" },
    sendMessage(messageValue) {
      if (messageValue.type === contract.MESSAGE_TYPES.GET_KEY_STATUS) return keyStatusDeferred.promise;
      return Promise.resolve({ ok: true });
    },
  });
  assert.equal(keyBusyHarness.input.disabled, true);
  assert.equal(keyBusyHarness.groups.settings.exportButton.disabled, false);
  assert.equal(keyBusyHarness.groups.data.exportButton.disabled, false);
  keyStatusDeferred.resolve({ ok: true, configured: false });
  await keyBusyHarness.settle();
  assert.equal(keyBusyHarness.input.disabled, false);

  for (const kind of ["settings", "data"]) {
    const otherKind = kind === "settings" ? "data" : "settings";
    const harness = createOptionsPageHarness({ settings: { theme: "system" } });
    await harness.settle();
    const file = {
      name: `<selected-${kind}>.json`,
      size: 128,
      lastModified: 10,
      async text() { return "{}"; },
    };
    const otherFile = {
      name: `${otherKind}.json`,
      size: 64,
      lastModified: 20,
      async text() { return "{}"; },
    };
    Object.assign(harness.state[kind], {
      state: "ready",
      file,
      fingerprint: `${file.name}:${file.size}:${file.lastModified}`,
      text: "{}",
      preview: { metadata: { format: "test" } },
      mode: "replace",
      result: "old result",
      error: true,
    });
    Object.assign(harness.state[otherKind], {
      state: "failed",
      file: otherFile,
      fingerprint: `${otherFile.name}:${otherFile.size}:${otherFile.lastModified}`,
      text: "other text",
      preview: { marker: "other preview" },
      mode: "replace",
      result: "other result",
      error: true,
    });
    harness.groups[kind].fileInput.value = "C:\\fakepath\\selected.json";
    harness.api.renderBackups();
    assert.equal(harness.groups[kind].selectedFile.hidden, false);
    assert.equal(harness.groups[kind].selectedFilename.textContent, file.name);
    assert.equal(harness.groups[kind].selectedFilename.title, file.name);
    assert.equal(harness.groups[kind].cancel.disabled, false);
    const sendCountBeforeCancel = harness.sendCalls.length;
    await harness.clickBackup(kind, "cancel");
    assert.equal(harness.sendCalls.length, sendCountBeforeCancel);
    assert.equal(harness.state[kind].state, "idle");
    assert.equal(harness.state[kind].file, null);
    assert.equal(harness.state[kind].fingerprint, null);
    assert.equal(harness.state[kind].text, null);
    assert.equal(harness.state[kind].preview, null);
    assert.equal(harness.state[kind].result, "");
    assert.equal(harness.state[kind].error, false);
    assert.equal(harness.state[kind].mode, "replace");
    assert.equal(harness.groups[kind].fileInput.value, "");
    assert.equal(harness.groups[kind].selectedFile.hidden, true);
    assert.equal(harness.groups[kind].preview.textContent, "Файл не выбран.");
    assert.equal(harness.state[otherKind].state, "failed");
    assert.equal(harness.state[otherKind].file, otherFile);
    assert.equal(harness.state[otherKind].text, "other text");
    assert.equal(harness.state[otherKind].preview.marker, "other preview");
    assert.equal(harness.state[otherKind].mode, "replace");
    assert.equal(harness.state[otherKind].result, "other result");
    assert.equal(harness.state[otherKind].error, true);
  }

  const delayedRead = createDeferredPromise();
  const readingHarness = createOptionsPageHarness({ settings: { theme: "system" } });
  await readingHarness.settle();
  const readingFile = {
    name: "delayed-settings.json",
    size: 100,
    lastModified: 30,
    text() { return delayedRead.promise; },
  };
  readingHarness.groups.settings.fileInput.value = "C:\\fakepath\\delayed-settings.json";
  const readingOperation = readingHarness.api.readBackupFile("settings", readingFile);
  assert.equal(readingHarness.state.settings.state, "reading");
  for (const action of ["exportButton", "fileInput", "mergeMode", "replaceMode", "apply"]) {
    assert.equal(readingHarness.groups.settings[action].disabled, true);
  }
  assert.equal(readingHarness.groups.settings.cancel.disabled, false);
  await readingHarness.clickBackup("settings", "cancel");
  delayedRead.resolve("{}");
  await readingOperation;
  assert.equal(readingHarness.state.settings.state, "idle");
  assert.equal(readingHarness.state.settings.file, null);
  assert.equal(readingHarness.groups.settings.preview.textContent, "Файл не выбран.");

  const rejectedRead = createDeferredPromise();
  const rejectedReadHarness = createOptionsPageHarness({ settings: { theme: "system" } });
  await rejectedReadHarness.settle();
  const rejectedReadFile = {
    name: "rejected-read.json",
    size: 100,
    lastModified: 31,
    text() { return rejectedRead.promise; },
  };
  const rejectedReadOperation = rejectedReadHarness.api.readBackupFile("settings", rejectedReadFile);
  await rejectedReadHarness.clickBackup("settings", "cancel");
  rejectedRead.reject(new Error("late read failure"));
  await rejectedReadOperation;
  assert.equal(rejectedReadHarness.state.settings.state, "idle");
  assert.equal(rejectedReadHarness.state.settings.result, "");
  assert.equal(rejectedReadHarness.state.settings.error, false);

  for (const validationOutcome of ["resolve", "reject"]) {
    const delayedValidation = createDeferredPromise();
    const validationHarness = createOptionsPageHarness({ settings: { theme: "system" } });
    await validationHarness.settle();
    validationHarness.setSendHandler((messageValue) => {
      if (messageValue.type === workspaceContract.MESSAGE_TYPES.IMPORT_DATA_PREVIEW) return delayedValidation.promise;
      return Promise.resolve({ ok: true, configured: false });
    });
    const validationFile = {
      name: `delayed-validation-${validationOutcome}.json`,
      size: 100,
      lastModified: validationOutcome === "resolve" ? 40 : 41,
      async text() { return "{}"; },
    };
    const validationOperation = validationHarness.api.readBackupFile("data", validationFile);
    await validationHarness.settle();
    assert.equal(validationHarness.state.data.state, "validating");
    for (const action of ["exportButton", "fileInput", "mergeMode", "replaceMode", "apply"]) {
      assert.equal(validationHarness.groups.data[action].disabled, true);
    }
    assert.equal(validationHarness.groups.data.cancel.disabled, false);
    await validationHarness.clickBackup("data", "cancel");
    if (validationOutcome === "resolve") {
      delayedValidation.resolve({ ok: true, preview: { metadata: { format: "test" } } });
    } else {
      delayedValidation.reject(new Error("late validation failure"));
    }
    await validationOperation;
    assert.equal(validationHarness.state.data.state, "idle");
    assert.equal(validationHarness.state.data.preview, null);
    assert.equal(validationHarness.state.data.result, "");
    assert.equal(validationHarness.state.data.error, false);
  }

  const retainedFileHarness = createOptionsPageHarness({ settings: { theme: "system" } });
  await retainedFileHarness.settle();
  for (const [kind, stateValue] of [["settings", "failed"], ["data", "recovery-required"]]) {
    const file = {
      name: `${stateValue}.json`,
      size: 80,
      lastModified: 50,
      async text() { return "{}"; },
    };
    Object.assign(retainedFileHarness.state[kind], {
      state: stateValue,
      file,
      fingerprint: `${file.name}:${file.size}:${file.lastModified}`,
      result: "retained error",
      error: true,
    });
  }
  retainedFileHarness.api.renderBackups();
  assert.equal(retainedFileHarness.groups.settings.cancel.disabled, false);
  assert.equal(retainedFileHarness.groups.data.cancel.disabled, false);

  const applyDeferred = createDeferredPromise();
  const applyingHarness = createOptionsPageHarness({ settings: { theme: "system" } });
  await applyingHarness.settle();
  for (const kind of ["settings", "data"]) {
    const file = {
      name: `${kind}-apply.json`,
      size: 120,
      lastModified: kind === "settings" ? 60 : 61,
      async text() { return "{}"; },
    };
    Object.assign(applyingHarness.state[kind], {
      state: "ready",
      file,
      fingerprint: `${file.name}:${file.size}:${file.lastModified}`,
      text: "{}",
      preview: { metadata: { format: "test" } },
      result: "",
      error: false,
    });
    applyingHarness.groups[kind].fileInput.value = `C:\\fakepath\\${file.name}`;
  }
  applyingHarness.api.renderBackups();
  applyingHarness.setSendHandler((messageValue) => {
    if (messageValue.type === workspaceContract.MESSAGE_TYPES.IMPORT_SETTINGS_APPLY) return applyDeferred.promise;
    return Promise.resolve({ ok: true });
  });
  const applyOperation = applyingHarness.api.applyBackup("settings");
  assert.equal(applyingHarness.state.settings.state, "applying");
  for (const kind of ["settings", "data"]) {
    for (const element of applyingHarness.groups[kind].actions) assert.equal(element.disabled, true);
  }
  applyingHarness.api.clearBackupSelection("settings");
  applyingHarness.api.clearBackupSelection("data");
  assert.equal(applyingHarness.state.settings.state, "applying");
  assert.notEqual(applyingHarness.state.settings.file, null);
  assert.notEqual(applyingHarness.state.data.file, null);
  applyDeferred.resolve({ ok: true });
  await applyOperation;
  assert.equal(applyingHarness.state.settings.state, "success");
  assert.equal(applyingHarness.state.settings.file, null);
  assert.equal(applyingHarness.state.settings.fingerprint, null);
  assert.equal(applyingHarness.state.settings.text, null);
  assert.equal(applyingHarness.state.settings.preview, null);
  assert.equal(applyingHarness.state.settings.result, "Импорт успешно применён.");
  assert.equal(applyingHarness.state.settings.error, false);
  assert.equal(applyingHarness.groups.settings.fileInput.value, "");
  assert.equal(applyingHarness.groups.settings.selectedFile.hidden, true);
  assert.equal(applyingHarness.groups.data.exportButton.disabled, false);
  assert.equal(applyingHarness.groups.data.cancel.disabled, false);

  const sameFileHarness = createOptionsPageHarness({ settings: { theme: "system" } });
  await sameFileHarness.settle();
  const sameFile = {
    name: "same-file.json",
    size: 100,
    lastModified: 70,
    async text() { return "{}"; },
  };
  sameFileHarness.groups.settings.fileInput.value = "C:\\fakepath\\same-file.json";
  sameFileHarness.changeFile("settings", sameFile);
  await sameFileHarness.settle();
  assert.equal(sameFileHarness.state.settings.state, "ready");
  await sameFileHarness.clickBackup("settings", "cancel");
  assert.equal(sameFileHarness.groups.settings.fileInput.value, "");
  sameFileHarness.groups.settings.fileInput.value = "C:\\fakepath\\same-file.json";
  sameFileHarness.changeFile("settings", sameFile);
  await sameFileHarness.settle();
  assert.equal(sameFileHarness.state.settings.state, "ready");
  assert.equal(sameFileHarness.state.settings.file, sameFile);
  assert.equal(sameFileHarness.groups.settings.selectedFile.hidden, false);

  const originalChrome = globalThis.chrome;
  const controllerMessages = [];
  globalThis.chrome = {
    runtime: {
      onMessage: { addListener() {} },
      async sendMessage(messageValue) {
        controllerMessages.push(messageValue);
        return { ok: true };
      },
    },
  };
  try {
    const controller = analysisController.create({});
    await controller.openOptions();
    await controller.openOptions("backup");
  } finally {
    globalThis.chrome = originalChrome;
  }
  assert.deepEqual(controllerMessages, [
    { type: contract.MESSAGE_TYPES.OPEN_OPTIONS },
    { type: contract.MESSAGE_TYPES.OPEN_OPTIONS, section: "backup" },
  ]);
}

async function runAsyncTests() {
  await runOptionsPageBehaviorTests();

  function inlineBatchResponse(candidate, entries) {
    const normalizedEntries = Array.isArray(entries) ? entries : [];
    return {
      ok: true,
      groups: normalizedEntries.length ? [{
        candidate,
        matchClass: normalizedEntries[0].matchClass || "exact",
        exactMissing: !normalizedEntries.some((entryValue) => entryValue.matchClass === "exact"),
        entries: normalizedEntries,
      }] : [],
      missing: normalizedEntries.length ? [] : [candidate],
      totals: {
        candidateCountBeforeLimit: 1,
        candidateCountReturned: 1,
        matchedCandidateCount: normalizedEntries.length ? 1 : 0,
        matchedEntryCountBeforeLimit: normalizedEntries.length,
        matchedEntryCountReturned: normalizedEntries.length,
      },
      truncated: { candidates: false, entries: false },
    };
  }

  const stateCandidate = {
    displayTerm: "State",
    normalizedKey: "state",
    firstIndex: 0,
    tokenCount: 1,
    occurrences: 1,
    source: "token",
    visibility: "primary",
  };
  const stateBatch = inlineBatchResponse(stateCandidate, [{
    id: "sense-state",
    senseId: "sense-state",
    conceptId: "concept-state",
    term: "State",
    canonicalTerm: "State",
    normalizedTerm: "state",
    translation: "состояние",
    definition: "Состояние системы.",
    attached: true,
    createdAt: 1,
    updatedAt: 2,
    matchClass: "exact",
  }]);

  const pointerGestureHarness = createInlineContentHarness();
  const pointerSnapshot = inlineContentSnapshot("State and OpenAPI", 0);
  pointerGestureHarness.setCapture(pointerSnapshot);
  pointerGestureHarness.api.markInlineGestureSelectionChanged();
  assert.equal(pointerGestureHarness.state.inlineGlossary.phase, "closed");
  pointerGestureHarness.api.handleInlinePointerDown({
    button: 0,
    isPrimary: true,
    pointerId: 7,
    pointerType: "mouse",
  }, []);
  for (let index = 0; index < 20; index += 1) {
    pointerGestureHarness.api.markInlineGestureSelectionChanged();
  }
  assert.equal(pointerGestureHarness.frames.size, 0);
  pointerGestureHarness.api.handleInlinePointerUp({ pointerId: 7 });
  assert.equal(pointerGestureHarness.frames.size, 1);
  assert.equal(pointerGestureHarness.state.inlineGlossary.phase, "closed");
  pointerGestureHarness.settleGesture();
  assert.equal(pointerGestureHarness.state.inlineGlossary.phase, "offering");
  assert.equal(
    pointerGestureHarness.uiCalls.filter((call) => call.phase === "offering").length,
    1,
    "a long drag produces exactly one offer after pointerup, RAF, and the bounded task",
  );

  const staleSettleHarness = createInlineContentHarness();
  staleSettleHarness.setCapture(inlineContentSnapshot("OldSelection", 0));
  staleSettleHarness.api.handleInlinePointerDown({
    button: 0,
    isPrimary: true,
    pointerId: 1,
    pointerType: "mouse",
  }, []);
  staleSettleHarness.api.markInlineGestureSelectionChanged();
  staleSettleHarness.api.handleInlinePointerUp({ pointerId: 1 });
  staleSettleHarness.setCapture(inlineContentSnapshot("NewSelection", 20));
  staleSettleHarness.api.handleInlinePointerDown({
    button: 0,
    isPrimary: true,
    pointerId: 2,
    pointerType: "mouse",
  }, []);
  staleSettleHarness.settleGesture();
  assert.equal(staleSettleHarness.state.inlineGlossary.phase, "closed");
  staleSettleHarness.api.cancelInlinePointerGesture({ pointerId: 2 });
  staleSettleHarness.api.handleInlinePointerUp({ pointerId: 2 });
  staleSettleHarness.settleGesture();
  assert.equal(staleSettleHarness.state.inlineGlossary.phase, "closed");

  const keyboardChordHarness = createInlineContentHarness();
  keyboardChordHarness.setCapture(inlineContentSnapshot("GraphRAG", 0));
  for (let cycle = 0; cycle < 2; cycle += 1) {
    keyboardChordHarness.api.handleInlineKeyDown({
      key: "ArrowRight",
      shiftKey: true,
      altKey: false,
      composedPath() { return []; },
    });
    keyboardChordHarness.api.markInlineGestureSelectionChanged();
    keyboardChordHarness.api.handleInlineKeyUp({ key: "ArrowRight", shiftKey: true });
    keyboardChordHarness.settleGesture();
    assert.equal(keyboardChordHarness.state.inlineGlossary.phase, "closed");
    assert.equal(keyboardChordHarness.frames.size, 0);
  }
  keyboardChordHarness.api.handleInlineKeyUp({ key: "Shift", shiftKey: false });
  assert.equal(keyboardChordHarness.frames.size, 1);
  keyboardChordHarness.settleGesture();
  assert.equal(keyboardChordHarness.state.inlineGlossary.phase, "offering");
  assert.equal(
    keyboardChordHarness.uiCalls.filter((call) => call.phase === "offering").length,
    1,
    "repeated selection-key cycles settle once after Shift is released",
  );
  keyboardChordHarness.api.handleInlineKeyDown({
    key: "c",
    ctrlKey: true,
    shiftKey: false,
    altKey: false,
    composedPath() { return []; },
  });
  assert.equal(keyboardChordHarness.state.inlineGlossary.phase, "offering");
  keyboardChordHarness.runTimers();
  assert.equal(keyboardChordHarness.state.inlineGlossary.phase, "closed");
  keyboardChordHarness.api.handleInlineKeyUp({ key: "ArrowRight", shiftKey: false });
  keyboardChordHarness.settleGesture();
  assert.equal(keyboardChordHarness.state.inlineGlossary.phase, "closed");

  const shiftFirstReleaseHarness = createInlineContentHarness();
  shiftFirstReleaseHarness.setCapture(inlineContentSnapshot("DTO", 0));
  shiftFirstReleaseHarness.api.handleInlineKeyDown({
    key: "ArrowLeft",
    shiftKey: true,
    altKey: false,
    composedPath() { return []; },
  });
  shiftFirstReleaseHarness.api.markInlineGestureSelectionChanged();
  shiftFirstReleaseHarness.api.handleInlineKeyUp({ key: "Shift", shiftKey: false });
  assert.equal(shiftFirstReleaseHarness.frames.size, 0);
  shiftFirstReleaseHarness.api.handleInlineKeyUp({ key: "ArrowLeft", shiftKey: false });
  shiftFirstReleaseHarness.settleGesture();
  assert.equal(shiftFirstReleaseHarness.state.inlineGlossary.phase, "offering");

  const supportedKeyboardGestures = [
    ...["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End", "PageUp", "PageDown"]
      .map((key) => ({ key })),
    ...["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"]
      .map((key) => ({ key, ctrlKey: true })),
    ...["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"]
      .map((key) => ({ key, metaKey: true })),
  ];
  for (const keyboard of supportedKeyboardGestures) {
    const harness = createInlineContentHarness();
    harness.setCapture(inlineContentSnapshot(`Selected ${keyboard.key}`, 0));
    harness.api.handleInlineKeyDown({
      ...keyboard,
      shiftKey: true,
      altKey: false,
      composedPath() { return []; },
    });
    harness.api.markInlineGestureSelectionChanged();
    harness.api.handleInlineKeyUp({ key: keyboard.key });
    harness.settleGesture();
    assert.equal(
      harness.state.inlineGlossary.phase,
      "offering",
      `supported keyboard gesture offers after keyup: ${JSON.stringify(keyboard)}`,
    );
  }
  for (const keyboard of [
    { key: "Home", ctrlKey: true },
    { key: "End", metaKey: true },
    { key: "PageUp", ctrlKey: true },
    { key: "PageDown", metaKey: true },
  ]) {
    const harness = createInlineContentHarness();
    harness.api.showInlineOffer(inlineContentSnapshot("State", 0));
    harness.api.handleInlineKeyDown({
      ...keyboard,
      shiftKey: true,
      altKey: false,
      composedPath() { return []; },
    });
    harness.api.handleInlineKeyUp({ key: keyboard.key });
    harness.settleGesture();
    assert.equal(harness.state.inlineGlossary.phase, "closed");
    assert.equal(
      harness.uiCalls.filter((call) => call.phase === "offering").length,
      1,
      `unsupported modified key cannot create a trailing offer: ${JSON.stringify(keyboard)}`,
    );
  }

  const ordinaryKeyTrailingHarness = createInlineContentHarness();
  ordinaryKeyTrailingHarness.setCapture(inlineContentSnapshot("State", 0));
  ordinaryKeyTrailingHarness.api.handleInlineKeyDown({
    key: "ArrowRight",
    shiftKey: true,
    altKey: false,
    composedPath() { return []; },
  });
  ordinaryKeyTrailingHarness.api.markInlineGestureSelectionChanged();
  ordinaryKeyTrailingHarness.api.handleInlineKeyDown({
    key: "x",
    shiftKey: false,
    ctrlKey: false,
    altKey: false,
    composedPath() { return []; },
  });
  ordinaryKeyTrailingHarness.api.handleInlineKeyUp({ key: "ArrowRight" });
  ordinaryKeyTrailingHarness.settleGesture();
  assert.equal(ordinaryKeyTrailingHarness.state.inlineGlossary.phase, "closed");
  assert.equal(
    ordinaryKeyTrailingHarness.uiCalls.some((call) => call.phase === "offering"),
    false,
  );

  const staleKeyboardSettleHarness = createInlineContentHarness();
  staleKeyboardSettleHarness.setCapture(inlineContentSnapshot("State", 0));
  staleKeyboardSettleHarness.api.handleInlineKeyDown({
    key: "ArrowRight",
    shiftKey: true,
    altKey: false,
    composedPath() { return []; },
  });
  staleKeyboardSettleHarness.api.markInlineGestureSelectionChanged();
  staleKeyboardSettleHarness.api.handleInlineKeyUp({ key: "ArrowRight", shiftKey: true });
  staleKeyboardSettleHarness.api.handleInlineKeyUp({ key: "Shift", shiftKey: false });
  assert.equal(staleKeyboardSettleHarness.frames.size, 1);
  staleKeyboardSettleHarness.api.closeInlineGlossaryOutsidePath(["composer"]);
  staleKeyboardSettleHarness.settleGesture();
  assert.equal(staleKeyboardSettleHarness.state.inlineGlossary.phase, "closed");
  assert.equal(
    staleKeyboardSettleHarness.uiCalls.some((call) => call.phase === "offering"),
    false,
    "outside close invalidates a pending keyboard settle",
  );

  for (const cancelEvent of [
    { pointerId: 41, kind: "pointercancel" },
    { pointerId: 42, kind: "lostpointercapture" },
    { kind: "blur" },
  ]) {
    const harness = createInlineContentHarness();
    const pointerId = cancelEvent.pointerId || 43;
    harness.setCapture(inlineContentSnapshot("State", 0));
    harness.api.handleInlinePointerDown({
      button: 0,
      isPrimary: true,
      pointerId,
      pointerType: "mouse",
    }, []);
    harness.api.markInlineGestureSelectionChanged();
    if (cancelEvent.kind === "blur") harness.api.closeInlineGlossary();
    else harness.api.cancelInlinePointerGesture({ pointerId });
    harness.api.handleInlinePointerUp({ pointerId });
    harness.settleGesture();
    assert.equal(harness.state.inlineGlossary.phase, "closed");
    assert.equal(
      harness.uiCalls.some((call) => call.phase === "offering"),
      false,
      `${cancelEvent.kind} cancels without a trailing offer`,
    );
  }

  const contextChangeHarness = createInlineContentHarness();
  contextChangeHarness.api.showInlineOffer(inlineContentSnapshot("State", 0));
  contextChangeHarness.api.handleWorkspaceContextChange({
    scopeKey: "stable:chatgpt.com:changed-context",
  });
  assert.equal(contextChangeHarness.state.inlineGlossary.phase, "closed");
  assert.equal(contextChangeHarness.state.inlineGlossary.snapshot, null);

  const workspaceUnavailableOfferHarness = createInlineContentHarness();
  workspaceUnavailableOfferHarness.api.showInlineOffer(inlineContentSnapshot("State", 0));
  workspaceUnavailableOfferHarness.api.handleWorkspaceStatusChange({
    status: "unavailable",
    context: null,
    errorCode: "RECOVERY_REQUIRED",
    message: "Unavailable",
  });
  assert.equal(workspaceUnavailableOfferHarness.state.inlineGlossary.phase, "offering");
  assert.equal(
    workspaceUnavailableOfferHarness.uiCalls.at(-1).offerOptions.glossaryEnabled,
    false,
  );

  const sameTermReselectionHarness = createInlineContentHarness();
  const sameSnapshot = inlineContentSnapshot("State", 0);
  sameTermReselectionHarness.setCapture(sameSnapshot);
  for (const pointerId of [11, 12]) {
    sameTermReselectionHarness.api.handleInlinePointerDown({
      button: 0,
      isPrimary: true,
      pointerId,
      pointerType: "mouse",
    }, []);
    sameTermReselectionHarness.api.markInlineGestureSelectionChanged();
    sameTermReselectionHarness.api.handleInlinePointerUp({ pointerId });
    sameTermReselectionHarness.settleGesture();
    assert.equal(sameTermReselectionHarness.state.inlineGlossary.phase, "offering");
    sameTermReselectionHarness.api.closeInlineGlossary();
  }
  assert.equal(
    sameTermReselectionHarness.uiCalls.filter((call) => call.phase === "offering").length,
    2,
    "an intentional same-term re-selection is not suppressed",
  );

  const fullSelectionText = "State and OpenAPI remain in the full selected fragment.";
  const translationActionHarness = createInlineContentHarness();
  translationActionHarness.api.showInlineOffer(inlineContentSnapshot(fullSelectionText, 0));
  assert.equal(
    translationActionHarness.uiCalls.find((call) => call.phase === "offering").offerOptions.glossaryEnabled,
    true,
  );
  const translatedSelection = await translationActionHarness.api.translateInlineSelection();
  assert.equal(translatedSelection.ok, true);
  assert.deepEqual(clone(translationActionHarness.translationCalls), [{
    args: ["inline-assistant", fullSelectionText, "https://chatgpt.com/c/inline-content"],
    phaseAtStart: "closed",
  }]);
  assert.deepEqual(translationActionHarness.lookupCalls, []);

  const analysisActionHarness = createInlineContentHarness();
  analysisActionHarness.api.showInlineOffer(inlineContentSnapshot(fullSelectionText, 0));
  const analyzedSelection = await analysisActionHarness.api.analyzeInlineSelection();
  assert.equal(analyzedSelection.ok, true);
  assert.deepEqual(clone(analysisActionHarness.analysisCalls), [{
    args: ["inline-assistant", fullSelectionText, "https://chatgpt.com/c/inline-content"],
    phaseAtStart: "closed",
  }]);
  assert.deepEqual(analysisActionHarness.lookupCalls, []);

  const unavailableQuickActionHarness = createInlineContentHarness();
  unavailableQuickActionHarness.state.workspaceStatus = { status: "unavailable" };
  unavailableQuickActionHarness.state.workspaceContext = null;
  unavailableQuickActionHarness.api.showInlineOffer(inlineContentSnapshot(fullSelectionText, 0));
  assert.equal(
    unavailableQuickActionHarness.uiCalls.find((call) => call.phase === "offering").offerOptions.glossaryEnabled,
    false,
  );
  assert.equal((await unavailableQuickActionHarness.api.activateInlineGlossary()).ignored, true);
  unavailableQuickActionHarness.api.showInlineOffer(inlineContentSnapshot(fullSelectionText, 0));
  assert.equal((await unavailableQuickActionHarness.api.translateInlineSelection()).ok, true);

  const lookupHarness = createInlineContentHarness();
  lookupHarness.api.showInlineOffer(inlineContentSnapshot("State and OpenAPI", 0));
  lookupHarness.setLookupImplementation(async () => stateBatch);
  await lookupHarness.api.activateInlineGlossary();
  assert.equal(lookupHarness.state.inlineGlossary.phase, "showing");
  assert.deepEqual(lookupHarness.lookupCalls, ["State and OpenAPI"]);
  assert.equal(
    lookupHarness.state.inlineGlossary.snapshot.conversationScope,
    "stable:chatgpt.com:inline-content",
  );
  assert.equal(
    lookupHarness.uiCalls.find((call) => call.phase === "showing").result,
    stateBatch,
  );
  const invalidCandidate = { ...stateCandidate, normalizedKey: "other" };
  assert.equal(
    (await lookupHarness.api.analyzeInlineGlossaryCandidate(invalidCandidate)).ignored,
    true,
  );
  const analyzed = await lookupHarness.api.analyzeInlineGlossaryCandidate(stateCandidate);
  assert.equal(analyzed.ok, true);
  assert.deepEqual(clone(lookupHarness.analysisCalls), [{
    args: ["inline-assistant", "State", "https://chatgpt.com/c/inline-content"],
    phaseAtStart: "closed",
  }]);

  const staleLookupHarness = createInlineContentHarness();
  const deferredLookup = createDeferredPromise();
  staleLookupHarness.api.showInlineOffer(inlineContentSnapshot("State", 0));
  staleLookupHarness.setLookupImplementation(() => deferredLookup.promise);
  const staleActivation = staleLookupHarness.api.activateInlineGlossary();
  staleLookupHarness.api.closeInlineGlossary();
  deferredLookup.resolve(stateBatch);
  assert.equal((await staleActivation).ignored, true);
  assert.equal(
    staleLookupHarness.uiCalls.some((call) => call.phase === "showing"),
    false,
  );

  const retryHarness = createInlineContentHarness();
  retryHarness.api.showInlineOffer(inlineContentSnapshot("State", 0));
  retryHarness.setLookupImplementation(async () => ({
    ok: false,
    error: { code: "WORKSPACE_OPERATION_FAILED", message: "Temporary failure" },
  }));
  await retryHarness.api.activateInlineGlossary();
  assert.equal(retryHarness.state.inlineGlossary.phase, "error");
  retryHarness.setLookupImplementation(async () => stateBatch);
  await retryHarness.api.retryInlineGlossary();
  assert.equal(retryHarness.state.inlineGlossary.phase, "showing");
  assert.deepEqual(retryHarness.lookupCalls, ["State", "State"]);

  for (const mutate of [
    (harness) => harness.setLocationHref("https://chatgpt.com/c/next"),
    (harness) => { harness.state.workspaceContext = null; },
    (harness) => { harness.state.inlineGlossary.snapshot.anchorNode.isConnected = false; },
  ]) {
    const ownershipHarness = createInlineContentHarness();
    ownershipHarness.api.showInlineOffer(inlineContentSnapshot("State", 0));
    mutate(ownershipHarness);
    const response = await ownershipHarness.api.activateInlineGlossary();
    assert.equal(response.ignored, true);
    assert.equal(ownershipHarness.lookupCalls.length, 0);
  }

  const internalPathHarness = createInlineContentHarness();
  internalPathHarness.api.showInlineOffer(inlineContentSnapshot("State", 0));
  internalPathHarness.api.handleInlinePointerDown({
    button: 0,
    isPrimary: true,
    pointerId: 9,
    pointerType: "mouse",
  }, ["inline-trigger"]);
  assert.equal(internalPathHarness.state.inlineGlossary.phase, "offering");
  assert.equal(internalPathHarness.api.closeInlineGlossaryOutsidePath(["inline-popover"]), false);
  assert.equal(internalPathHarness.api.handleInlineFocusIn({
    composedPath() { return ["inline-popover"]; },
  }), false);
  assert.equal(internalPathHarness.state.inlineGlossary.phase, "offering");
  assert.equal(
    internalPathHarness.api.closeInlineGlossaryOutsidePath(["inline-root"]),
    true,
    "the full-screen root is not an internal interaction surface",
  );

  for (const outsidePointer of [
    { label: "same-page free space", path(harness) { return ["page"]; }, startsPotentialGesture: true },
    { label: "composer", path(harness) { return ["composer"]; }, startsPotentialGesture: true },
    { label: "extension sidebar", path(harness) { return [harness.state.host, "sidebar"]; }, startsPotentialGesture: false },
  ]) {
    const harness = createInlineContentHarness();
    const snapshot = inlineContentSnapshot("State", 0);
    harness.setCapture(snapshot);
    harness.api.showInlineOffer(snapshot);
    const offerCount = harness.uiCalls.filter((call) => call.phase === "offering").length;
    harness.api.handleInlinePointerDown({
      button: 0,
      isPrimary: true,
      pointerId: 71,
      pointerType: "mouse",
    }, outsidePointer.path(harness));
    assert.equal(harness.state.inlineGlossary.phase, "closed", `${outsidePointer.label} closes`);
    assert.equal(
      harness.state.inlineGesture.pointerId !== null,
      outsidePointer.startsPotentialGesture,
      `${outsidePointer.label} pointer ownership`,
    );
    harness.api.handleInlinePointerUp({ pointerId: 71 });
    harness.settleGesture();
    assert.equal(harness.state.inlineGlossary.phase, "closed");
    assert.equal(
      harness.uiCalls.filter((call) => call.phase === "offering").length,
      offerCount,
      `${outsidePointer.label} cannot close-to-reoffer an unchanged selection`,
    );
  }

  const externalFocusHarness = createInlineContentHarness();
  externalFocusHarness.api.showInlineOffer(inlineContentSnapshot("State", 0));
  assert.equal(externalFocusHarness.api.handleInlineFocusIn({
    composedPath() { return ["composer"]; },
  }), true);
  assert.equal(externalFocusHarness.state.inlineGlossary.phase, "closed");

  const copyHarness = createInlineContentHarness();
  copyHarness.api.showInlineOffer(inlineContentSnapshot("State", 0));
  let copyPrevented = false;
  copyHarness.api.handleInlineCopy({
    preventDefault() { copyPrevented = true; },
  });
  assert.equal(copyPrevented, false);
  assert.equal(copyHarness.state.inlineGlossary.phase, "offering");
  copyHarness.runTimers();
  assert.equal(copyHarness.state.inlineGlossary.phase, "closed");

  for (const action of ["cut", "paste", "beforeinput"]) {
    const harness = createInlineContentHarness();
    harness.api.showInlineOffer(inlineContentSnapshot("State", 0));
    assert.equal(harness.api.handleInlineExternalAction({ type: action }), true);
    assert.equal(harness.state.inlineGlossary.phase, "closed", `${action} closes inline UI`);
  }

  const invalidationHarness = createInlineContentHarness();
  invalidationHarness.api.showInlineOffer(inlineContentSnapshot("State", 0));
  assert.equal(invalidationHarness.api.closeInlineGlossaryForInvalidation(
    workspaceContract.ENTITY_FAMILIES.SAVED,
  ), false);
  assert.equal(invalidationHarness.state.inlineGlossary.phase, "offering");
  assert.equal(invalidationHarness.api.closeInlineGlossaryForInvalidation(
    workspaceContract.ENTITY_FAMILIES.GLOSSARY,
  ), true);

  const conflictTerm = {
    status: "replacementAvailable",
    translation: "состояние",
    definition: "Новое определение.",
    replacementCandidate: {
      targetSenseId: "target-sense",
      expectedUpdatedAt: 42,
      current: { translation: "состояние", definition: "Старое определение." },
      proposed: { translation: "состояние", definition: "Новое определение." },
    },
  };
  const conflictRequests = [];
  const conflictOutcome = await analysisUi.runReplacementAction(conflictTerm, async (command) => {
    conflictRequests.push(clone(command));
    return {
      ok: false,
      error: contract.makeError("GLOSSARY_ENTRY_CHANGED"),
      current: {
        id: "current-sense",
        translation: "состояние",
        definition: "Текущее определение.",
        updatedAt: 84,
      },
    };
  });
  assert.equal(conflictOutcome.status, "replacementAvailable");
  assert.equal(conflictTerm.status, "replacementAvailable");
  assert.equal(conflictRequests.length, 1, "stale replacement is not retried automatically");
  assert.deepEqual(analysisUi.replacementCommandForTerm(conflictTerm), {
    senseId: "current-sense",
    expectedUpdatedAt: 84,
    replacement: {
      translation: "состояние",
      definition: "Новое определение.",
    },
  });
  assert.deepEqual(conflictTerm.savedEntry, {
    id: "current-sense",
    translation: "состояние",
    definition: "Текущее определение.",
    updatedAt: 84,
  });
  const reconfirmedOutcome = await analysisUi.runReplacementAction(conflictTerm, async (command) => {
    conflictRequests.push(clone(command));
    return {
      ok: true,
      changed: true,
      entry: {
        id: "current-sense",
        translation: "состояние",
        definition: "Новое определение.",
        updatedAt: 85,
      },
    };
  });
  assert.equal(reconfirmedOutcome.status, "replaced");
  assert.equal(conflictRequests.length, 2);
  assert.equal(conflictRequests[1].senseId, "current-sense");
  assert.equal(conflictRequests[1].expectedUpdatedAt, 84);

  const alreadySavedAfterStale = {
    status: "replacementAvailable",
    translation: "состояние",
    definition: "Новое определение.",
    replacementCandidate: {
      targetSenseId: "target-sense",
      expectedUpdatedAt: 42,
      current: { translation: "состояние", definition: "Старое определение." },
      proposed: { translation: "состояние", definition: "Новое определение." },
    },
  };
  const alreadySavedOutcome = await analysisUi.runReplacementAction(
    alreadySavedAfterStale,
    async () => ({
      ok: false,
      error: contract.makeError("GLOSSARY_ENTRY_CHANGED"),
      current: {
        id: "target-sense",
        translation: " Состояние ",
        definition: "Новое   определение.",
        updatedAt: 84,
      },
    }),
  );
  assert.equal(alreadySavedOutcome.status, "alreadySaved");
  assert.equal(alreadySavedAfterStale.status, "alreadySaved");
  assert.equal(alreadySavedAfterStale.replacementCandidate, null);
  assert.equal(analysisUi.replacementCommandForTerm(alreadySavedAfterStale), null);

  const successfulReplacementTerm = {
    status: "replacementAvailable",
    translation: "состояние",
    definition: "Новое определение.",
    replacementCandidate: {
      targetSenseId: "target-sense",
      expectedUpdatedAt: 42,
      proposed: { translation: "состояние", definition: "Новое определение." },
    },
  };
  const replacementRequests = [];
  const replacementOutcome = await analysisUi.runReplacementAction(
    successfulReplacementTerm,
    async (command) => {
      replacementRequests.push(clone(command));
      return {
        ok: true,
        changed: true,
        entry: { id: "target-sense", definition: "Новое определение." },
      };
    },
  );
  assert.equal(replacementOutcome.status, "replaced");
  assert.deepEqual(replacementRequests, [{
    senseId: "target-sense",
    expectedUpdatedAt: 42,
    replacement: { translation: "состояние", definition: "Новое определение." },
  }]);

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
          if (message.type === contract.MESSAGE_TYPES.ANALYZE_SELECTED_TERMS) {
            return { ok: true, requestId: message.snapshot.requestId, terms: [] };
          }
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
    const beforeInvalidTrigger = controllerMessages.length;
    const invalidTriggerResponse = await controller.start(
      "State",
      "arbitrary-trigger",
      "https://chatgpt.com/c/inline-controller",
    );
    assert.equal(invalidTriggerResponse.ok, false);
    assert.equal(invalidTriggerResponse.error.code, "REQUEST_CONTRACT_ERROR");
    assert.equal(controllerMessages.length, beforeInvalidTrigger);
    const inlineControllerResponse = await controller.start(
      "State",
      "inline-assistant",
      "https://chatgpt.com/c/inline-controller",
    );
    assert.equal(inlineControllerResponse.ok, true);
    assert.equal(controllerMessages[0].type, contract.MESSAGE_TYPES.ANALYZE_SELECTED_TERMS);
    assert.equal(controllerMessages[0].snapshot.trigger, "inline-assistant");
    assert.equal(controllerMessages[0].snapshot.text, "State");
    assert.equal(await controller.getKeyStatus(), true);
    assert.deepEqual(controllerMessages.at(-1), { type: contract.MESSAGE_TYPES.GET_KEY_STATUS });
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
    ["update", "chatgpt-helper-translate-selection"],
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

  const legacyTemplateMigration = createServiceWorkerHarness(validStorage({
    templates: [{
      id: "legacy-template",
      name: " Legacy name ",
      content: " Legacy content ",
      autoSend: true,
    }],
    recentTemplateIds: ["legacy-template", "stale-template"],
    templateTreeUiState: undefined,
  }));
  await legacyTemplateMigration.waitForMigration();
  assert.deepEqual(legacyTemplateMigration.storage.templates, [
    typedTemplate(
      "legacy-template",
      " Legacy name ",
      " Legacy content ",
      true,
    ),
  ]);
  assert.deepEqual(legacyTemplateMigration.storage.recentTemplateIds, ["legacy-template"]);
  assert.deepEqual(legacyTemplateMigration.storage.templateTreeUiState, {
    collapsedFolderIds: [],
  });
  assert.equal(legacyTemplateMigration.setCalls.filter(
    (changes) => Object.prototype.hasOwnProperty.call(changes, "templates"),
  ).length, 1);

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

  const completeRecentTemplates = Array.from({ length: 8 }, (_, index) => typedTemplate(
    `history-${index + 1}`,
    `History ${index + 1}`,
    `Content ${index + 1}`,
  ));
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

  const conflictingMigrationStorage = validStorage({
    glossarySchemaVersion: 1,
    glossaryEntries: [
      {
        id: "legacy-conflict-a",
        term: "WorkflowOrchestrator",
        translation: "оркестратор",
        definition: "Первая версия.",
        createdAt: 1,
        updatedAt: 2,
      },
      {
        id: "legacy-conflict-b",
        term: "workflow orchestrator",
        translation: "оркестратор",
        definition: "Первая версия.",
        createdAt: 3,
        updatedAt: 4,
      },
    ],
  });
  const conflictingMigrationHarness = createServiceWorkerHarness(conflictingMigrationStorage);
  await assert.rejects(
    conflictingMigrationHarness.waitForMigration(),
    /GLOSSARY_INVARIANT_VIOLATION/,
  );
  assert.deepEqual(conflictingMigrationHarness.setCalls, []);
  assert.deepEqual(
    conflictingMigrationHarness.storage.glossaryEntries,
    conflictingMigrationStorage.glossaryEntries,
  );
  assert.equal(
    conflictingMigrationHarness.storage.glossarySchemaVersion,
    conflictingMigrationStorage.glossarySchemaVersion,
  );
  assert.equal(conflictingMigrationHarness.memoryWorkspace.snapshot().glossaryConcepts.length, 0);
  assert.equal(conflictingMigrationHarness.memoryWorkspace.snapshot().glossarySenses.length, 0);
  assert.equal(
    await conflictingMigrationHarness.memoryWorkspace.getMetaValue("v1GlossaryMigrationState"),
    null,
  );
  assert.equal(conflictingMigrationHarness.workspaceInitializeCalls(), 0);
  assert.equal(conflictingMigrationHarness.evaluate("workspaceRecoveryRequired"), true);
  const conflictingMigrationBlocked = await conflictingMigrationHarness.handleMessage({
    type: workspaceContract.MESSAGE_TYPES.GET_CONTEXT,
    pageUrl: "https://chatgpt.com/c/migration-conflict",
  }, {
    tab: { id: 303, url: "https://chatgpt.com/c/migration-conflict" },
    url: "https://chatgpt.com/c/migration-conflict",
  });
  assert.equal(conflictingMigrationBlocked.ok, false);
  assert.equal(conflictingMigrationBlocked.error.code, "RECOVERY_REQUIRED");

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
    templates: [typedTemplate(
      "imported-template",
      "Импорт",
      "Импортированный шаблон",
    )],
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

  const invalidTypedTemplates = [
    typedTemplate(
      "broken-template",
      "Broken",
      "Broken",
      false,
      "missing-folder",
    ),
  ];
  const invalidTreeRecoveryHarness = createServiceWorkerHarness(validStorage({
    templates: invalidTypedTemplates,
    recentTemplateIds: ["broken-template", "stale-template"],
    templateTreeUiState: { collapsedFolderIds: ["missing-folder"] },
  }));
  await invalidTreeRecoveryHarness.waitForMigration();
  assert.deepEqual(invalidTreeRecoveryHarness.storage.templates, invalidTypedTemplates);
  assert.deepEqual(
    invalidTreeRecoveryHarness.storage.recentTemplateIds,
    ["broken-template", "stale-template"],
  );
  assert.deepEqual(invalidTreeRecoveryHarness.storage.templateTreeUiState, {
    collapsedFolderIds: ["missing-folder"],
  });
  const invalidTreeMutation = await invalidTreeRecoveryHarness.handleMessage({
    type: workspaceContract.MESSAGE_TYPES.TEMPLATE_NODE_UPDATE,
    nodeId: "broken-template",
    patch: { name: "Must not persist" },
  }, {
    tab: { id: 299, url: "https://chatgpt.com/c/invalid-tree" },
    url: "https://chatgpt.com/c/invalid-tree",
  });
  assert.equal(
    invalidTreeMutation.error.code,
    templateTree.ERROR_CODES.INVALID_STORED_STATE,
  );
  assert.deepEqual(invalidTreeRecoveryHarness.storage.templates, invalidTypedTemplates);
  const invalidTreeMergePreview = await invalidTreeRecoveryHarness.handleMessage({
    type: workspaceContract.MESSAGE_TYPES.IMPORT_DATA_PREVIEW,
    text: importedDataText,
    mode: "merge",
  }, optionsSender);
  assert.equal(
    invalidTreeMergePreview.error.code,
    templateTree.ERROR_CODES.INVALID_STORED_STATE,
  );
  const invalidTreeMergeApply = await invalidTreeRecoveryHarness.handleMessage(
    mergeDataMessage,
    optionsSender,
  );
  assert.equal(
    invalidTreeMergeApply.error.code,
    templateTree.ERROR_CODES.INVALID_STORED_STATE,
  );
  assert.deepEqual(invalidTreeRecoveryHarness.storage.templates, invalidTypedTemplates);
  const invalidTreeReplacePreview = await invalidTreeRecoveryHarness.handleMessage({
    type: workspaceContract.MESSAGE_TYPES.IMPORT_DATA_PREVIEW,
    text: importedDataText,
    mode: "replace",
  }, optionsSender);
  assert.equal(invalidTreeReplacePreview.ok, true);
  assert.equal(invalidTreeReplacePreview.recoveryAvailable, true);
  assert.equal(invalidTreeReplacePreview.preview.warnings.some(
    (warning) => warning.code === "CURRENT_TEMPLATE_TREE_INVALID"
      && warning.recovery === "replace",
  ), true);
  const invalidTreeExport = await invalidTreeRecoveryHarness.handleMessage({
    type: workspaceContract.MESSAGE_TYPES.EXPORT_DATA,
  }, optionsSender);
  assert.equal(invalidTreeExport.ok, false);
  assert.equal(
    invalidTreeExport.error.code,
    templateTree.ERROR_CODES.INVALID_STORED_STATE,
  );
  assert.equal(invalidTreeExport.recoveryAvailable, true);

  let invalidTreeApplyReadCount = 0;
  invalidTreeRecoveryHarness.injectLocalGetTransform(
    (names) => names.includes("templates") && ++invalidTreeApplyReadCount === 3,
    (result) => ({ ...result, templates: [] }),
  );
  const invalidTreeRollback = await invalidTreeRecoveryHarness.handleMessage(
    replaceDataMessage,
    optionsSender,
  );
  assert.equal(invalidTreeRollback.rolledBack, true);
  assert.deepEqual(invalidTreeRecoveryHarness.storage.templates, invalidTypedTemplates);
  assert.deepEqual(
    invalidTreeRecoveryHarness.storage.recentTemplateIds,
    ["broken-template", "stale-template"],
  );
  assert.deepEqual(invalidTreeRecoveryHarness.storage.templateTreeUiState, {
    collapsedFolderIds: ["missing-folder"],
  });
  const invalidTreeReplaceRecovery = await invalidTreeRecoveryHarness.handleMessage(
    replaceDataMessage,
    optionsSender,
  );
  assert.equal(invalidTreeReplaceRecovery.ok, true);
  assert.deepEqual(
    invalidTreeRecoveryHarness.storage.templates,
    importedDataState.templates,
  );
  assert.deepEqual(invalidTreeRecoveryHarness.storage.recentTemplateIds, []);
  assert.deepEqual(invalidTreeRecoveryHarness.storage.templateTreeUiState, {
    collapsedFolderIds: [],
  });

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

  const conflictingImportHarness = createServiceWorkerHarness(validStorage(), {
    tabs: [{ id: 304, url: "https://chatgpt.com/c/import-conflict" }],
  });
  await conflictingImportHarness.waitForMigration();
  const conflictingImportSender = {
    tab: { id: 304, url: "https://chatgpt.com/c/import-conflict" },
    url: "https://chatgpt.com/c/import-conflict",
  };
  const conflictingImportContext = await conflictingImportHarness.handleMessage({
    type: workspaceContract.MESSAGE_TYPES.GET_CONTEXT,
    pageUrl: conflictingImportSender.url,
  }, conflictingImportSender);
  await conflictingImportHarness.memoryWorkspace.addAnalysisTerms([{
    term: "State",
    translation: "состояние",
    definition: "Сохранённая версия.",
  }], conflictingImportContext.context.scopeKey);
  const conflictingImportText = importExport.createDataExport({
    templates: [],
    conversations: [],
    glossaryConcepts: [{
      id: "import-conflict-concept",
      displayTerm: "state",
      createdAt: 1,
      updatedAt: 2,
    }],
    glossarySenses: [{
      id: "import-conflict-sense",
      conceptId: "import-conflict-concept",
      translation: "состояние",
      definition: "Другая версия.",
      createdAt: 1,
      updatedAt: 2,
    }],
    glossaryLinks: [],
    savedItems: [],
    savedItemLinks: [],
  }, {
    datasetId: "10000000-2000-4000-8000-000000000001",
    exportedAt: "2026-07-25T12:00:00.000Z",
  }).text;
  let conflictingImportBackupCalls = 0;
  const originalConflictingPutBackup = conflictingImportHarness.memoryWorkspace
    .putImportBackup.bind(conflictingImportHarness.memoryWorkspace);
  conflictingImportHarness.memoryWorkspace.putImportBackup = async (...args) => {
    conflictingImportBackupCalls += 1;
    return originalConflictingPutBackup(...args);
  };
  const conflictingImportBefore = conflictingImportHarness.memoryWorkspace.snapshot();
  const conflictingImportSetCalls = conflictingImportHarness.setCalls.length;
  const conflictingImportMessages = conflictingImportHarness.tabMessages.length;
  for (const type of [
    workspaceContract.MESSAGE_TYPES.IMPORT_DATA_PREVIEW,
    workspaceContract.MESSAGE_TYPES.IMPORT_DATA_APPLY,
  ]) {
    const response = await conflictingImportHarness.handleMessage({
      type,
      text: conflictingImportText,
      mode: "merge",
    }, optionsSender);
    assert.equal(response.ok, false);
    assert.equal(response.error.code, "GLOSSARY_IMPORT_CONFLICT");
  }
  assert.equal(conflictingImportBackupCalls, 0);
  assert.equal(
    await conflictingImportHarness.memoryWorkspace.getMetaValue("dataImportOperation"),
    null,
  );
  assert.equal(await conflictingImportHarness.memoryWorkspace.getImportBackup("data"), null);
  assert.deepEqual(conflictingImportHarness.memoryWorkspace.snapshot(), conflictingImportBefore);
  assert.equal(conflictingImportHarness.setCalls.length, conflictingImportSetCalls);
  assert.equal(conflictingImportHarness.tabMessages.length, conflictingImportMessages);

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
      typedTemplate("queue-one", "One", "One"),
      typedTemplate("queue-two", "Two", "Two"),
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
      templates: [typedTemplate("patch-target", "Old name", "Old content")],
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
      kind: "template",
      parentId: null,
      name: "Edited name",
      iconKey: "document",
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
      templates: [typedTemplate("independent-edit", "Old name", "Old content")],
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
      kind: "template",
      parentId: null,
      name: "Name from tab A",
      iconKey: "document",
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
      typedTemplate("recent-a", "A", "A"),
      typedTemplate("recent-b", "B", "B"),
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
  assert.equal(rolledBackBarrier.rolledBack, true, JSON.stringify(rolledBackBarrier));
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
    (names) => names.includes("templates") && ++templateReadCount === 3,
    (result) => ({ ...result, templates: [] }),
  );
  const verificationFailure = await verificationFailureHarness.handleMessage(mergeDataMessage, optionsSender);
  assert.equal(verificationFailure.rolledBack, true);
  assert.deepEqual(verificationFailureHarness.storage.templates, validStorage().templates);

  const orderedTemplates = [
    {
      id: "folder-ordered",
      kind: "folder",
      parentId: null,
      name: "Ordered",
      iconKey: "folder",
    },
    typedTemplate("template-z", "Z", "Z", false, "folder-ordered"),
    typedTemplate("template-a", "A", "A"),
  ];
  const orderedRollbackHarness = createServiceWorkerHarness(validStorage({
    templates: orderedTemplates,
    recentTemplateIds: ["template-z"],
    templateTreeUiState: { collapsedFolderIds: ["folder-ordered"] },
  }));
  await orderedRollbackHarness.waitForMigration();
  const orderedExport = await orderedRollbackHarness.handleMessage({
    type: workspaceContract.MESSAGE_TYPES.EXPORT_DATA,
  }, optionsSender);
  const orderedPortableTemplates = JSON.parse(orderedExport.text).payload.templates;
  assert.deepEqual(orderedPortableTemplates.map((item) => item.id), [
    "folder-ordered",
    "template-z",
    "template-a",
  ]);
  assert.deepEqual(orderedPortableTemplates.map(
    ({ kind, parentId, iconKey }) => ({ kind, parentId, iconKey }),
  ), [
    { kind: "folder", parentId: null, iconKey: "folder" },
    { kind: "template", parentId: "folder-ordered", iconKey: "document" },
    { kind: "template", parentId: null, iconKey: "document" },
  ]);
  let orderedTemplateReadCount = 0;
  orderedRollbackHarness.injectLocalGetTransform(
    (names) => names.includes("templates") && ++orderedTemplateReadCount === 3,
    (result) => ({ ...result, templates: [] }),
  );
  const orderedRollback = await orderedRollbackHarness.handleMessage(replaceDataMessage, optionsSender);
  assert.equal(orderedRollback.rolledBack, true);
  assert.deepEqual(orderedRollbackHarness.storage.templates.map((item) => item.id), [
    "folder-ordered",
    "template-z",
    "template-a",
  ]);
  assert.deepEqual(orderedRollbackHarness.storage.recentTemplateIds, ["template-z"]);
  assert.deepEqual(orderedRollbackHarness.storage.templateTreeUiState, {
    collapsedFolderIds: ["folder-ordered"],
  });

  async function seedInterruptedDataImport(harness, phase, mutateTemplates) {
    const workspaceSnapshot = await harness.memoryWorkspace.snapshotUserData();
    await harness.memoryWorkspace.putImportBackup("data", {
      templates: clone(harness.storage.templates),
      recentTemplateIds: clone(harness.storage.recentTemplateIds),
      templateTreeUiState: clone(harness.storage.templateTreeUiState),
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
    if (mutateTemplates) {
      harness.storage.templates = clone(importedDataState.templates);
      harness.storage.recentTemplateIds = [];
      harness.storage.templateTreeUiState = { collapsedFolderIds: [] };
    }
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

  const invalidBackupHarness = createServiceWorkerHarness(validStorage(), {
    tabs: [{ id: 315, url: "https://chatgpt.com/c/invalid-backup" }],
  });
  await invalidBackupHarness.waitForMigration();
  const invalidBackupSender = {
    tab: { id: 315, url: "https://chatgpt.com/c/invalid-backup" },
    url: "https://chatgpt.com/c/invalid-backup",
  };
  await invalidBackupHarness.handleMessage({
    type: workspaceContract.MESSAGE_TYPES.GET_CONTEXT,
    pageUrl: invalidBackupSender.url,
  }, invalidBackupSender);
  const invalidBackupActiveData = await invalidBackupHarness.memoryWorkspace.snapshotUserData();
  const invalidBackupPayload = clone(invalidBackupActiveData);
  invalidBackupPayload.glossaryLinks.push({
    id: "invalid-backup-link",
    senseId: "missing-backup-sense",
    conversationId: invalidBackupPayload.conversations[0].id,
    linkKey: `missing-backup-sense\u001f${invalidBackupPayload.conversations[0].id}`,
    localOrder: 0,
    firstSeenAt: 1,
    lastSeenAt: 1,
  });
  await invalidBackupHarness.memoryWorkspace.putImportBackup("data", {
    templates: clone(invalidBackupHarness.storage.templates),
    recentTemplateIds: clone(invalidBackupHarness.storage.recentTemplateIds),
    templateTreeUiState: clone(invalidBackupHarness.storage.templateTreeUiState),
    workspace: invalidBackupPayload,
  });
  await invalidBackupHarness.memoryWorkspace.setMetaValue("dataImportOperation", {
    operationId: "invalid-historical-backup",
    kind: "data",
    mode: "replace",
    phase: "workspace-applied",
    startedAt: 1,
  });
  const invalidBackupStorageBefore = clone(invalidBackupHarness.storage);
  const invalidBackupMessagesBefore = invalidBackupHarness.tabMessages.length;
  await assert.rejects(
    invalidBackupHarness.recoverPendingImports(),
    /DATA_BACKUP_INVALID/,
  );
  assert.deepEqual(
    await invalidBackupHarness.memoryWorkspace.snapshotUserData(),
    invalidBackupActiveData,
  );
  assert.deepEqual(invalidBackupHarness.storage, invalidBackupStorageBefore);
  assert.notEqual(
    await invalidBackupHarness.memoryWorkspace.getMetaValue("dataImportOperation"),
    null,
  );
  assert.notEqual(await invalidBackupHarness.memoryWorkspace.getImportBackup("data"), null);
  assert.equal(invalidBackupHarness.evaluate("workspaceRecoveryRequired"), true);
  const invalidBackupBlocked = await invalidBackupHarness.handleMessage({
    type: workspaceContract.MESSAGE_TYPES.GET_CONTEXT,
    pageUrl: invalidBackupSender.url,
  }, invalidBackupSender);
  assert.equal(invalidBackupBlocked.ok, false);
  assert.equal(invalidBackupBlocked.error.code, "RECOVERY_REQUIRED");
  assert.equal(invalidBackupHarness.tabMessages.length, invalidBackupMessagesBefore);

  const successfulDataApplyHarness = createServiceWorkerHarness(validStorage(), {
    tabs: [{ id: 32, url: "https://chatgpt.com/c/import-broadcast" }],
  });
  await successfulDataApplyHarness.waitForMigration();
  const successfulDataApply = await successfulDataApplyHarness.handleMessage(mergeDataMessage, optionsSender);
  assert.equal(successfulDataApply.ok, true);
  assert.equal(successfulDataApplyHarness.storage.templates.some((item) => item.id === "imported-template"), true);
  assert.equal(successfulDataApplyHarness.tabMessages.filter((item) => item.message.entityFamily === workspaceContract.ENTITY_FAMILIES.ALL).length, 0);

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

  let inlineWorkerProviderCalls = 0;
  const inlineLookupHarness = createServiceWorkerHarness(validStorage(), {
    keyConfigured: true,
    openRouterClient: {
      async analyze() {
        inlineWorkerProviderCalls += 1;
        return { ok: true, terms: [] };
      },
    },
  });
  const inlineWorkerSender = {
    tab: { id: 59, url: "https://chatgpt.com/c/inline-worker" },
    url: "https://chatgpt.com/c/inline-worker",
  };
  const inlineWorkerContext = await inlineLookupHarness.handleMessage({
    type: workspaceContract.MESSAGE_TYPES.GET_CONTEXT,
    pageUrl: inlineWorkerSender.tab.url,
  }, inlineWorkerSender);
  assert.equal(inlineWorkerContext.ok, true);
  const inlineWorkerTerms = Array.from({ length: 22 }, (_, index) => ({
    term: `State component ${String(index).padStart(2, "0")}`,
    translation: `значение ${String(index).padStart(2, "0")}`,
    definition: `Связанное значение ${String(index).padStart(2, "0")}.`,
  }));
  await inlineLookupHarness.memoryWorkspace.addAnalysisTerms(
    inlineWorkerTerms,
    inlineWorkerContext.context.scopeKey,
  );
  const inlineWorkerStateBeforeLookup = inlineLookupHarness.memoryWorkspace.snapshot();
  const inlineWorkerSessionBeforeLookup = clone(inlineLookupHarness.sessionStorage);
  const inlineWorkerSetCallsBeforeLookup = inlineLookupHarness.setCalls.length;
  const inlineWorkerRemoveCallsBeforeLookup = inlineLookupHarness.removeCalls.length;
  const inlineWorkerTabMessagesBeforeLookup = inlineLookupHarness.tabMessages.length;
  const inlineWorkerAnalysisWritesBeforeLookup = inlineLookupHarness.analysisTermWriteCalls();
  const inlineWorkerGlossaryRevisionBeforeLookup = await inlineLookupHarness.memoryWorkspace
    .getMetaValue(`revision:${workspaceContract.ENTITY_FAMILIES.GLOSSARY}`);
  const pausedInlineWorkerLookup = inlineLookupHarness.pauseWorkspaceMethod("lookupGlossarySelection");
  const inlineWorkerLookupPromise = inlineLookupHarness.handleMessage({
    type: workspaceContract.MESSAGE_TYPES.LOOKUP_GLOSSARY_SELECTION,
    conversationScope: inlineWorkerContext.context.scopeKey,
    text: "State / UnknownTerm",
  }, inlineWorkerSender);
  await pausedInlineWorkerLookup.entered;
  assert.equal(pausedInlineWorkerLookup.calls(), 1);
  assert.equal(inlineLookupHarness.evaluate("activeUserMutations.size"), 0);
  assert.equal(inlineLookupHarness.evaluate("pendingLocalMutations"), 0);
  assert.equal(inlineLookupHarness.evaluate("activeImport"), null);
  assert.equal(inlineLookupHarness.evaluate("activeRequests.size"), 0);
  pausedInlineWorkerLookup.release();
  const inlineWorkerLookup = await inlineWorkerLookupPromise;
  assert.equal(inlineWorkerLookup.ok, true);
  assert.equal(inlineWorkerLookup.groups.length, 1);
  assert.equal(inlineWorkerLookup.groups[0].entries.length, 22);
  assert.equal(
    inlineWorkerLookup.groups[0].entries.every((item) => item.matchClass === "contiguous"),
    true,
  );
  assert.ok(inlineWorkerLookup.missing.some((candidate) => (
    candidate.normalizedKey === "unknown term"
  )));
  assert.equal(inlineWorkerProviderCalls, 0);
  assert.equal(inlineLookupHarness.setCalls.length, inlineWorkerSetCallsBeforeLookup);
  assert.equal(inlineLookupHarness.removeCalls.length, inlineWorkerRemoveCallsBeforeLookup);
  assert.equal(inlineLookupHarness.tabMessages.length, inlineWorkerTabMessagesBeforeLookup);
  assert.equal(inlineLookupHarness.analysisTermWriteCalls(), inlineWorkerAnalysisWritesBeforeLookup);
  assert.equal(inlineLookupHarness.evaluate("activeUserMutations.size"), 0);
  assert.deepEqual(inlineLookupHarness.sessionStorage, inlineWorkerSessionBeforeLookup);
  assert.deepEqual(inlineLookupHarness.memoryWorkspace.snapshot(), inlineWorkerStateBeforeLookup);
  assert.equal(
    await inlineLookupHarness.memoryWorkspace
      .getMetaValue(`revision:${workspaceContract.ENTITY_FAMILIES.GLOSSARY}`),
    inlineWorkerGlossaryRevisionBeforeLookup,
  );
  const inlineUnknownLookup = await inlineLookupHarness.handleMessage({
    type: workspaceContract.MESSAGE_TYPES.LOOKUP_GLOSSARY_SELECTION,
    conversationScope: inlineWorkerContext.context.scopeKey,
    text: "UnknownTerm",
  }, inlineWorkerSender);
  assert.equal(inlineUnknownLookup.ok, true);
  assert.equal(inlineUnknownLookup.groups.length, 0);
  assert.equal(inlineUnknownLookup.missing[0].normalizedKey, "unknown term");
  const inlineInvalidTermLookup = await inlineLookupHarness.handleMessage({
    type: workspaceContract.MESSAGE_TYPES.LOOKUP_GLOSSARY_SELECTION,
    conversationScope: inlineWorkerContext.context.scopeKey,
    text: "",
  }, inlineWorkerSender);
  assert.equal(inlineInvalidTermLookup.ok, false);
  assert.equal(inlineInvalidTermLookup.error.code, "INVALID_GLOSSARY_SELECTION");
  const inlineForeignScopeLookup = await inlineLookupHarness.handleMessage({
    type: workspaceContract.MESSAGE_TYPES.LOOKUP_GLOSSARY_SELECTION,
    conversationScope: "stable:chatgpt.com:another-conversation",
    text: "State",
  }, inlineWorkerSender);
  assert.equal(inlineForeignScopeLookup.ok, false);
  assert.equal(inlineForeignScopeLookup.error.code, "INVALID_CONVERSATION_SCOPE");
  assert.equal(inlineWorkerProviderCalls, 0);

  const rejectedWorkerTrigger = await inlineLookupHarness.handleMessage({
    type: contract.MESSAGE_TYPES.ANALYZE_SELECTED_TERMS,
    snapshot: {
      requestId: "analysis-inline-rejected-01",
      trigger: "arbitrary-trigger",
      text: "State",
      pageUrl: inlineWorkerSender.tab.url,
      createdAt: 1,
    },
  }, inlineWorkerSender);
  assert.equal(rejectedWorkerTrigger.ok, false);
  assert.equal(inlineWorkerProviderCalls, 0);
  const acceptedWorkerTrigger = await inlineLookupHarness.handleMessage({
    type: contract.MESSAGE_TYPES.ANALYZE_SELECTED_TERMS,
    snapshot: {
      requestId: "analysis-inline-accepted-01",
      trigger: "inline-assistant",
      text: "State",
      pageUrl: inlineWorkerSender.tab.url,
      createdAt: 2,
    },
  }, inlineWorkerSender);
  assert.equal(acceptedWorkerTrigger.ok, true);
  assert.equal(acceptedWorkerTrigger.requestId, "analysis-inline-accepted-01");
  assert.equal(inlineWorkerProviderCalls, 1);

  const invariantAnalysisHarness = createServiceWorkerHarness(validStorage(), {
    keyConfigured: true,
    analysisWriteError: new Error("GLOSSARY_INVARIANT_VIOLATION"),
    openRouterClient: {
      async analyze() {
        return {
          ok: true,
          terms: [{
            term: "State",
            translation: "состояние",
            definition: "Определение.",
          }],
        };
      },
    },
    tabs: [{ id: 64, url: "https://chatgpt.com/c/analysis-invariant" }],
  });
  const invariantAnalysisSender = {
    tab: { id: 64, url: "https://chatgpt.com/c/analysis-invariant" },
    url: "https://chatgpt.com/c/analysis-invariant",
  };
  await invariantAnalysisHarness.handleMessage({
    type: workspaceContract.MESSAGE_TYPES.GET_CONTEXT,
    pageUrl: invariantAnalysisSender.url,
  }, invariantAnalysisSender);
  const invariantAnalysisBefore = invariantAnalysisHarness.memoryWorkspace.snapshot();
  const invariantAnalysisGlossaryBefore = {
    concepts: clone(invariantAnalysisBefore.glossaryConcepts),
    senses: clone(invariantAnalysisBefore.glossarySenses),
    links: clone(invariantAnalysisBefore.glossaryLinks),
    revision: clone(invariantAnalysisBefore.meta.find(
      (item) => item.key === `revision:${workspaceContract.ENTITY_FAMILIES.GLOSSARY}`,
    )?.value),
  };
  const invariantAnalysisMessagesBefore = invariantAnalysisHarness.tabMessages.length;
  const invariantAnalysisResponse = await invariantAnalysisHarness.handleMessage({
    type: contract.MESSAGE_TYPES.ANALYZE_SELECTED_TERMS,
    snapshot: {
      requestId: "analysis-invariant-01",
      trigger: "inline-assistant",
      text: "State",
      pageUrl: invariantAnalysisSender.url,
      createdAt: 1,
    },
  }, invariantAnalysisSender);
  assert.equal(invariantAnalysisResponse.ok, false);
  assert.equal(invariantAnalysisResponse.requestId, "analysis-invariant-01");
  assert.equal(invariantAnalysisResponse.error.code, "GLOSSARY_INVARIANT_VIOLATION");
  assert.equal(invariantAnalysisHarness.analysisTermWriteCalls(), 1);
  const invariantAnalysisAfter = invariantAnalysisHarness.memoryWorkspace.snapshot();
  assert.deepEqual({
    concepts: invariantAnalysisAfter.glossaryConcepts,
    senses: invariantAnalysisAfter.glossarySenses,
    links: invariantAnalysisAfter.glossaryLinks,
    revision: invariantAnalysisAfter.meta.find(
      (item) => item.key === `revision:${workspaceContract.ENTITY_FAMILIES.GLOSSARY}`,
    )?.value,
  }, invariantAnalysisGlossaryBefore);
  assert.equal(invariantAnalysisHarness.tabMessages.length, invariantAnalysisMessagesBefore);

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
  assert.equal(candidateSense.results[0].status, "replacementAvailable");
  const replacementStateBefore = replacementHarness.memoryWorkspace.snapshot();
  assert.equal(replacementStateBefore.glossarySenses.length, 1);
  const replacementCommand = {
    senseId: originalSense.results[0].id,
    expectedUpdatedAt: candidateSense.results[0].replacementCandidate.expectedUpdatedAt,
    replacement: candidateSense.results[0].replacementCandidate.proposed,
  };
  const missingExpectedAt = await replacementHarness.handleMessage({
    type: workspaceContract.MESSAGE_TYPES.REPLACE_GLOSSARY_SENSE,
    conversationScope: replacementContext.context.scopeKey,
    command: {
      senseId: replacementCommand.senseId,
      replacement: replacementCommand.replacement,
    },
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
  const obsoleteSourceSense = await replacementHarness.handleMessage({
    type: workspaceContract.MESSAGE_TYPES.REPLACE_GLOSSARY_SENSE,
    conversationScope: replacementContext.context.scopeKey,
    command: { ...replacementCommand, sourceSenseId: "obsolete-source-sense" },
  }, replacementSender);
  assert.equal(obsoleteSourceSense.ok, false);
  assert.equal(obsoleteSourceSense.error.code, "REQUEST_CONTRACT_ERROR");
  assert.deepEqual(replacementHarness.memoryWorkspace.snapshot(), replacementStateBefore);
  const staleReplacement = await replacementHarness.handleMessage({
    type: workspaceContract.MESSAGE_TYPES.REPLACE_GLOSSARY_SENSE,
    conversationScope: replacementContext.context.scopeKey,
    command: { ...replacementCommand, expectedUpdatedAt: -1 },
  }, replacementSender);
  assert.equal(staleReplacement.ok, false);
  assert.equal(staleReplacement.error.code, "GLOSSARY_ENTRY_CHANGED");
  assert.equal(staleReplacement.current.id, replacementCommand.senseId);
  assert.equal(replacementHarness.memoryWorkspace.snapshot().glossarySenses.length, 1);
  const currentReplacement = await replacementHarness.handleMessage({
    type: workspaceContract.MESSAGE_TYPES.REPLACE_GLOSSARY_SENSE,
    conversationScope: replacementContext.context.scopeKey,
    command: replacementCommand,
  }, replacementSender);
  assert.equal(currentReplacement.ok, true);
  assert.equal(currentReplacement.changed, true);
  assert.equal(currentReplacement.entry.id, replacementCommand.senseId);
  const replacementStateAfter = replacementHarness.memoryWorkspace.snapshot();
  assert.equal(replacementStateAfter.glossarySenses.length, 1);
  assert.equal(
    replacementStateAfter.glossarySenses[0].createdAt,
    replacementStateBefore.glossarySenses[0].createdAt,
  );
  assert.deepEqual(replacementStateAfter.glossaryLinks, replacementStateBefore.glossaryLinks);
  const broadcastCountAfterReplacement = replacementHarness.tabMessages.length;
  const idempotentWorkerReplacement = await replacementHarness.handleMessage({
    type: workspaceContract.MESSAGE_TYPES.REPLACE_GLOSSARY_SENSE,
    conversationScope: replacementContext.context.scopeKey,
    command: {
      ...replacementCommand,
      expectedUpdatedAt: currentReplacement.entry.updatedAt,
    },
  }, replacementSender);
  assert.equal(idempotentWorkerReplacement.ok, true);
  assert.equal(idempotentWorkerReplacement.changed, false);
  assert.equal(replacementHarness.tabMessages.length, broadcastCountAfterReplacement);

  const commandHarness = createServiceWorkerHarness(validStorage(), {
    tabs: [{ id: 82, url: "https://chatgpt.com/c/active-fallback" }],
  });
  const commandTab = { id: 81, url: "https://chatgpt.com/c/event-tab" };
  await commandHarness.runCommand("analyze-selection", commandTab);
  await commandHarness.runCommand("translate-selection", commandTab);
  await commandHarness.runCommand("save-selection", commandTab);
  await commandHarness.runCommand("normalize-composer", commandTab);
  await commandHarness.runCommand("normalize-composer", commandTab);
  assert.deepEqual(commandHarness.tabMessages.map((item) => item.message.type), [
    commandRegistry.CONTENT_MESSAGE_TYPES.ANALYZE,
    commandRegistry.CONTENT_MESSAGE_TYPES.TRANSLATE,
    commandRegistry.CONTENT_MESSAGE_TYPES.SAVE,
    commandRegistry.CONTENT_MESSAGE_TYPES.NORMALIZE,
  ]);
  assert.equal(commandHarness.tabQueryCalls.length, 0);
  await commandHarness.runCommand("unsupported-command", commandTab);
  assert.equal(commandHarness.tabMessages.length, 4);
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
    menuItemId: "chatgpt-helper-translate-selection",
    selectionText: "Menu translation",
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
    commandRegistry.CONTENT_MESSAGE_TYPES.TRANSLATE,
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
