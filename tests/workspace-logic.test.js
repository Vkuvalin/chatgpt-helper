"use strict";

const assert = require("node:assert/strict");
const { webcrypto } = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const analysis = require("../src/analysis-contract.js");
const workspace = require("../src/workspace-contract.js");
const conversations = require("../src/conversation-context.js");
const commands = require("../src/command-registry.js");
const workspaceStore = require("../src/workspace-store.js");
const workspaceUi = require("../src/workspace-ui.js");
const templateTree = require("../src/template-tree.js");
const importExport = require("../src/import-export.js");
const asyncBoundaryTests = [];
const serviceWorkerSource = fs.readFileSync(path.join(__dirname, "../src/service-worker.js"), "utf8");
const contentScriptSource = fs.readFileSync(path.join(__dirname, "../src/content-script.js"), "utf8");
const importExportSource = fs.readFileSync(path.join(__dirname, "../src/import-export.js"), "utf8");
const workspaceUiSource = fs.readFileSync(path.join(__dirname, "../src/workspace-ui.js"), "utf8");
const optionsHtmlSource = fs.readFileSync(path.join(__dirname, "../src/options.html"), "utf8");
const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, "../manifest.json"), "utf8"));
const packageLock = JSON.parse(fs.readFileSync(path.join(__dirname, "../package-lock.json"), "utf8"));
const OBSERVED_WALLPAPER_DATA_URL = "data:image/jpeg;base64,iVBORw0KGgo"
  + "A".repeat(8_146_944 - "iVBORw0KGgo".length);
const WALLPAPER_COMPATIBILITY_FIXTURE = "DaTa:ImAgE/JpEg;BaSe64,=\u00a0A===Z";
const ECMASCRIPT_WHITESPACE = "\u0009\u000a\u000b\u000c\u000d\u0020\u00a0\u1680"
  + "\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200a"
  + "\u2028\u2029\u202f\u205f\u3000\ufeff";

const translationHandlerSource = serviceWorkerSource.slice(
  serviceWorkerSource.indexOf("async function handleTranslation"),
  serviceWorkerSource.indexOf("async function mutateAndBroadcast"),
);
const contentMessageRouterSource = serviceWorkerSource.slice(
  serviceWorkerSource.indexOf("async function handleMessage"),
  serviceWorkerSource.indexOf("function supportedCommandTab"),
);
assert.equal(
  analysis.MESSAGE_TYPES.TRANSLATE_SELECTED_TEXT,
  "chatgpt-helper:translate-selected-text",
);
assert.equal(
  contentMessageRouterSource.indexOf("message.type === MESSAGES.OPEN_OPTIONS")
    < contentMessageRouterSource.indexOf("message.type === MESSAGES.TRANSLATE_SELECTED_TEXT"),
  true,
);
assert.equal(
  contentMessageRouterSource.indexOf("message.type === MESSAGES.TRANSLATE_SELECTED_TEXT")
    < contentMessageRouterSource.indexOf("LOCAL_MUTATION_MESSAGES.has(message.type)"),
  true,
);
assert.equal(
  contentMessageRouterSource.indexOf("message.type === MESSAGES.TRANSLATE_SELECTED_TEXT")
    < contentMessageRouterSource.indexOf("if (workspaceRecoveryRequired)"),
  true,
);
assert.doesNotMatch(
  translationHandlerSource,
  /ensureMigrated|getWorkspace|resolveConversationContext|handleWorkspaceMessage|broadcastWorkspaceChange|chrome\.storage\.local/,
);

function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function createContentStorageListenerHarness(initialSettings) {
  let storageListener = null;
  const calls = [];
  const state = {
    settings: workspace.normalizeActiveSettings(initialSettings),
    templates: [],
    templateTreeUiState: { collapsedFolderIds: [] },
    recentTemplateIds: [],
    sidebarWidthCommitPending: false,
    sidebarResizing: false,
    sidebarPreferredWidth: null,
  };
  const chrome = {
    storage: {
      onChanged: {
        addListener(listener) { storageListener = listener; },
      },
    },
  };
  const context = vm.createContext({
    chrome,
    state,
    workspaceContract: workspace,
    templateTree,
    closeTemplatePreview() { calls.push("closeTemplatePreview"); },
    cleanupTemplateTreeDrag() { calls.push("cleanupTemplateTreeDrag"); },
    applyStoredTemplateTree() { calls.push("applyStoredTemplateTree"); },
    normalizeRecentTemplateIds() { calls.push("normalizeRecentTemplateIds"); return []; },
    closeRecentPopup() { calls.push("closeRecentPopup"); },
    renderSection() { calls.push("renderSection"); },
  });
  const normalizeSettingsSource = contentScriptSource.slice(
    contentScriptSource.indexOf("function normalizeSettings"),
    contentScriptSource.indexOf("function normalizeRecentTemplateIds"),
  );
  const listenerSource = contentScriptSource.slice(
    contentScriptSource.indexOf("chrome.storage.onChanged.addListener"),
    contentScriptSource.indexOf("const mountObserver"),
  );
  assert.equal(normalizeSettingsSource.trim().length > 0, true);
  assert.equal(listenerSource.trim().length > 0, true);
  vm.runInContext(`${normalizeSettingsSource}\n${listenerSource}`, context, {
    filename: "content-script-storage-listener.test.js",
  });
  assert.equal(typeof storageListener, "function");
  return {
    state,
    calls,
    handleStorageChange(changes, areaName = "local") {
      return storageListener(changes, areaName);
    },
  };
}

function folderNode(id, name, parentId = null, iconKey = templateTree.DEFAULT_FOLDER_ICON) {
  return { id, kind: templateTree.NODE_KINDS.FOLDER, parentId, name, iconKey };
}

function templateNode(
  id,
  name,
  content,
  autoSend = false,
  parentId = null,
  iconKey = templateTree.DEFAULT_TEMPLATE_ICON,
) {
  return {
    id,
    kind: templateTree.NODE_KINDS.TEMPLATE,
    parentId,
    name,
    iconKey,
    content,
    autoSend,
  };
}

function createTemplateMutationRuntime(initialStorage) {
  const storage = clone(initialStorage);
  const setCalls = [];
  const forbiddenCalls = [];
  let nextId = 0;
  const chrome = {
    storage: {
      local: {
        async get(keysValue) {
          const keys = Array.isArray(keysValue) ? keysValue : [keysValue];
          return Object.fromEntries(keys
            .filter((key) => Object.prototype.hasOwnProperty.call(storage, key))
            .map((key) => [key, clone(storage[key])]));
        },
        async set(changes) {
          const copied = clone(changes);
          setCalls.push(copied);
          Object.assign(storage, copied);
        },
      },
    },
  };
  const context = vm.createContext({
    chrome,
    contract: {
      createId(prefix) {
        nextId += 1;
        return `${prefix}-runtime-${nextId}`;
      },
    },
    templateTree,
    workspaceContract: workspace,
    WORKSPACE_MESSAGES: workspace.MESSAGE_TYPES,
    activeImport: null,
    workspaceRecoveryRequired: false,
    pendingLocalMutations: 0,
    localMutationQueue: Promise.resolve(),
    activeUserMutations: new Set(),
    deferredOrphanTabIds: new Set(),
    beginUserMutation() { return {}; },
    endUserMutation() {},
    mutationBusyError() { return { code: "MUTATION_BUSY" }; },
    flushDeferredOrphans() { return Promise.resolve(); },
    workspaceError(code, message) {
      return { code, message: message || "Workspace must remain untouched." };
    },
    getWorkspace() {
      forbiddenCalls.push("workspace");
      throw new Error("WORKSPACE_FORBIDDEN");
    },
    broadcastWorkspaceChange() {
      forbiddenCalls.push("broadcast");
      throw new Error("BROADCAST_FORBIDDEN");
    },
    openRouterClient: new Proxy({}, {
      get() {
        forbiddenCalls.push("provider");
        throw new Error("PROVIDER_FORBIDDEN");
      },
    }),
  });
  const sourceParts = [
    serviceWorkerSource.slice(
      serviceWorkerSource.indexOf("function createStableId"),
      serviceWorkerSource.indexOf("function normalizeSettings"),
    ),
    serviceWorkerSource.slice(
      serviceWorkerSource.indexOf("function storageValuesEqual"),
      serviceWorkerSource.indexOf("function buildStorageMigrationPatch"),
    ),
    serviceWorkerSource.slice(
      serviceWorkerSource.indexOf("function runLocalMutation"),
      serviceWorkerSource.indexOf("function runLocalStorageMigration"),
    ),
    serviceWorkerSource.slice(
      serviceWorkerSource.indexOf("function invalidStoredTreeResponse"),
      serviceWorkerSource.indexOf("async function durableImportMarker"),
    ),
  ];
  assert.equal(sourceParts.every((part) => part.trim().length > 0), true);
  vm.runInContext(
    `${sourceParts.join("\n")}\nglobalThis.__templateMutationRuntime = { handleLocalMutation };`,
    context,
  );
  return {
    handle: context.__templateMutationRuntime.handleLocalMutation,
    storage,
    setCalls,
    forbiddenCalls,
  };
}

function createTemplateDropIntentRuntime(templates, draggingNodeId) {
  const state = {
    templates: clone(templates),
    templateTreeDrag: {
      draggingNodeId,
      invalidError: null,
    },
  };
  const context = vm.createContext({
    state,
    templateTree,
    workspaceUiModule: workspaceUi,
  });
  const source = contentScriptSource.slice(
    contentScriptSource.indexOf("function nextTemplateSiblingId"),
    contentScriptSource.indexOf("function showTemplateDropIntent"),
  );
  assert.equal(source.trim().length > 0, true);
  vm.runInContext(
    `${source}\nglobalThis.__templateDropIntent = templateDropIntent;`,
    context,
  );
  return function evaluateTemplateDropIntent(event) {
    return clone(context.__templateDropIntent(event));
  };
}

function createTestClassList(initialValues) {
  const values = new Set(initialValues || []);
  return {
    add(...names) {
      names.forEach((name) => values.add(name));
    },
    remove(...names) {
      names.forEach((name) => values.delete(name));
    },
    contains(name) {
      return values.has(name);
    },
  };
}

function createTemplateDragUiRuntime(templates) {
  const rootTarget = {
    classList: createTestClassList(),
    closest(selector) {
      return selector === "[data-template-root-target]" ? this : null;
    },
  };
  const rootChild = {
    closest(selector) {
      return selector === "[data-template-root-target]" ? rootTarget : null;
    },
  };
  const rootList = {
    closest(selector) {
      return selector === ".templates-list" ? this : null;
    },
  };
  const slot = {
    classList: createTestClassList(),
    dataset: { templateSlotId: "drop-template" },
  };
  const templateCard = { classList: createTestClassList() };
  const savedCard = { classList: createTestClassList() };
  const glossaryCard = { classList: createTestClassList() };
  const body = { classList: createTestClassList() };
  const state = {
    activeSection: "templates",
    body,
    shadow: null,
    sidebarResizing: false,
    glossarySearch: "",
    glossaryRequestedMode: "local",
    glossaryDraggingId: null,
    savedSearch: "",
    savedRequestedMode: "local",
    savedDraggingId: null,
    editing: null,
    status: { kind: "", text: "" },
    templateDeleteId: null,
    folderDelete: { nodeId: null, phase: "closed" },
    preview: { anchor: null },
    movedIntent: null,
    templates: clone(templates),
    templateTreeDrag: {
      draggingNodeId: null,
      intent: null,
      hoverFolderId: null,
      hoverTimer: null,
      temporarilyExpandedFolderIds: [],
      invalidError: null,
    },
  };
  state.shadow = {
    querySelector(selector) {
      return selector === "[data-template-root-target]" ? rootTarget : null;
    },
    querySelectorAll(selector) {
      if (selector === "[data-template-slot-id]") return [slot];
      if (selector === ".template-card.is-dragging") return [templateCard];
      if (selector === ".delete-confirm") return [];
      if (selector.includes(".template-node-slot.is-drop-before")) return [slot, rootTarget];
      return [];
    },
  };
  const context = vm.createContext({
    state,
    templateTree,
    workspaceUiModule: workspaceUi,
    clearTimeout() {},
    removeTemporaryTemplateExpansionMarkup() {},
    closeTemplatePreview() {},
    closeRecentPopup() {},
    closedFolderDeleteState() {
      return { nodeId: null, phase: "closed" };
    },
    editorOpen() {
      return state.editing !== null;
    },
    setTemporaryTemplateExpansions(folderIds) {
      state.templateTreeDrag.temporarilyExpandedFolderIds = [...folderIds];
    },
    scheduleTemplateFolderAutoExpand() {},
    reconcileWorkspaceDeleteEntry() {},
    applyShellState() {},
    templatesMarkup() {
      return "<div></div>";
    },
    analysisMarkup() {
      return "";
    },
    savedMarkup() {
      return "";
    },
    settingsMarkup() {
      return "";
    },
    restorePendingTemplateFocus() {},
    moveTemplateNode(intent) {
      state.movedIntent = intent;
      return Promise.resolve();
    },
    reorderGlossaryEntries() {
      return Promise.resolve();
    },
    reorderSavedEntries() {
      return Promise.resolve();
    },
    templateMutationErrorText(error) {
      return error?.message || "";
    },
    handleUiError() {},
  });
  const sourceParts = [
    contentScriptSource.slice(
      contentScriptSource.indexOf("function clearTemplateDropIndicators"),
      contentScriptSource.indexOf("function effectiveCollapsedFolderIds"),
    ),
    contentScriptSource.slice(
      contentScriptSource.indexOf("function nextTemplateSiblingId"),
      contentScriptSource.indexOf("function removeTemporaryTemplateExpansionMarkup"),
    ),
    contentScriptSource.slice(
      contentScriptSource.indexOf("function clearTemplateDragIntent"),
      contentScriptSource.indexOf("function templateIntentFolderPath"),
    ),
    contentScriptSource.slice(
      contentScriptSource.indexOf("function renderSection"),
      contentScriptSource.indexOf("function openSection"),
    ),
    contentScriptSource.slice(
      contentScriptSource.indexOf("function onDragStart"),
      contentScriptSource.indexOf("function onDragEnd"),
    ),
    contentScriptSource.slice(
      contentScriptSource.indexOf("function onDragEnd"),
      contentScriptSource.indexOf("function onDragOver"),
    ),
    contentScriptSource.slice(
      contentScriptSource.indexOf("function onDragOver"),
      contentScriptSource.indexOf("function onDragLeave"),
    ),
    contentScriptSource.slice(
      contentScriptSource.indexOf("function onDrop"),
      contentScriptSource.indexOf("function mount"),
    ),
  ];
  assert.equal(sourceParts.every((part) => part.trim().length > 0), true);
  vm.runInContext(
    `${sourceParts.join("\n")}
      globalThis.__templateDragUiRuntime = {
        cleanupTemplateTreeDrag,
        onDragEnd,
        onDragOver,
        onDragStart,
        onDrop,
        renderSection,
        setTemplateRootDropZoneVisible,
        showTemplateDropIntent,
      };`,
    context,
  );

  function dragStart(kind) {
    const structural = kind === "template" || kind === "folder";
    const handle = {
      dataset: structural
        ? { templateDragId: kind === "folder" ? "drop-folder" : "drop-drag" }
        : kind === "saved"
          ? { savedDragId: "saved-drag" }
          : { glossaryDragId: "glossary-drag" },
      closest(selector) {
        if (structural && selector === ".template-card") return templateCard;
        if (kind === "saved" && selector === ".saved-card") return savedCard;
        if (kind === "glossary" && selector === ".glossary-card") return glossaryCard;
        return null;
      },
    };
    let prevented = false;
    const dataTransfer = {
      dropEffect: "none",
      effectAllowed: "none",
      values: {},
      setData(type, value) {
        this.values[type] = value;
      },
    };
    const event = {
      dataTransfer,
      preventDefault() {
        prevented = true;
      },
      target: {
        closest(selector) {
          if (structural && selector === "[data-template-drag-id]") return handle;
          if (kind === "saved" && selector === "[data-saved-drag-id]") return handle;
          if (kind === "glossary" && selector === "[data-glossary-drag-id]") return handle;
          return null;
        },
      },
    };
    context.__templateDragUiRuntime.onDragStart(event);
    return { dataTransfer, prevented };
  }

  function dragOver(target) {
    let prevented = false;
    const dataTransfer = { dropEffect: "none" };
    context.__templateDragUiRuntime.onDragOver({
      dataTransfer,
      target,
      preventDefault() {
        prevented = true;
      },
    });
    return {
      dataTransfer,
      intent: clone(state.templateTreeDrag.intent),
      prevented,
    };
  }

  function dragEnd() {
    context.__templateDragUiRuntime.onDragEnd({
      target: {
        closest() {
          return null;
        },
      },
    });
  }

  function drop(target) {
    let prevented = false;
    context.__templateDragUiRuntime.onDrop({
      clientY: 0,
      dataTransfer: { dropEffect: "none" },
      target,
      preventDefault() {
        prevented = true;
      },
    });
    return {
      intent: clone(state.movedIntent),
      prevented,
    };
  }

  return {
    body,
    cleanup() {
      context.__templateDragUiRuntime.cleanupTemplateTreeDrag();
    },
    dragEnd,
    dragOver,
    dragStart,
    drop,
    glossaryCard,
    rootChild,
    rootList,
    rootTarget,
    savedCard,
    render() {
      context.__templateDragUiRuntime.renderSection();
    },
    show(intent) {
      context.__templateDragUiRuntime.showTemplateDropIntent(intent);
    },
    slot,
    state,
    templateCard,
  };
}

function createTemplateFocusRuntime(controls) {
  const state = {
    activeSection: "templates",
    pendingTemplateFocusTarget: null,
    body: {
      querySelectorAll(selector) {
        return selector === "[data-action]" ? controls : [];
      },
    },
  };
  const context = vm.createContext({
    state,
    TEMPLATE_FOCUS_RETURN_ACTIONS: new Set([
      "add-template",
      "add-folder",
      "add-template-in-folder",
      "add-folder-in-folder",
      "edit-node",
      "ask-node-delete",
    ]),
    TEMPLATE_TOOLBAR_FOCUS_ACTIONS: ["add-template", "add-folder", "toggle-delete-mode"],
  });
  const source = contentScriptSource.slice(
    contentScriptSource.indexOf("function boundedTemplateFocusTarget"),
    contentScriptSource.indexOf("function renderSection"),
  );
  assert.equal(source.trim().length > 0, true);
  vm.runInContext(
    `${source}\nglobalThis.__templateFocusRuntime = {
      boundedTemplateFocusTarget,
      templateFocusTargetFromAction,
      queuePendingTemplateFocus,
      restorePendingTemplateFocus,
    };`,
    context,
  );
  return {
    state,
    bounded(value) {
      return clone(context.__templateFocusRuntime.boundedTemplateFocusTarget(value));
    },
    fromAction(element) {
      return clone(context.__templateFocusRuntime.templateFocusTargetFromAction(element));
    },
    queue(value) {
      context.__templateFocusRuntime.queuePendingTemplateFocus(value);
    },
    restore() {
      return context.__templateFocusRuntime.restorePendingTemplateFocus();
    },
  };
}

function renderTemplateEditorMarkup(editor, editorError) {
  const context = vm.createContext({
    state: {
      templates: [],
      editorError,
    },
    templateTree,
    TEMPLATE_EDITOR_ERROR_ID: "template-editor-error",
    TEMPLATE_ICON_TITLES: Object.freeze({}),
    escapeHtml(value) { return String(value ?? ""); },
    trustedTemplateIcon() { return "<svg></svg>"; },
  });
  const source = contentScriptSource.slice(
    contentScriptSource.indexOf("function iconPickerMarkup"),
    contentScriptSource.indexOf("function templateDeleteMarkup"),
  );
  assert.equal(source.trim().length > 0, true);
  vm.runInContext(
    `${source}\nglobalThis.__renderTemplateEditorMarkup = editorMarkup;`,
    context,
  );
  return context.__renderTemplateEditorMarkup(editor, "");
}

function createTemplateDismissRuntime(controls) {
  const state = {
    activeSection: "templates",
    pendingTemplateFocusTarget: null,
    editorReturnFocusTarget: null,
    deleteReturnFocusTarget: null,
    editing: null,
    editorError: "",
    templateDeleteId: null,
    folderDelete: { nodeId: null, phase: "closed" },
    body: {
      querySelectorAll(selector) {
        return selector === "[data-action]" ? controls : [];
      },
    },
  };
  const context = vm.createContext({
    state,
    TEMPLATE_FOCUS_RETURN_ACTIONS: new Set([
      "add-template",
      "add-folder",
      "add-template-in-folder",
      "add-folder-in-folder",
      "edit-node",
      "ask-node-delete",
    ]),
    TEMPLATE_TOOLBAR_FOCUS_ACTIONS: ["add-template", "add-folder", "toggle-delete-mode"],
    closedFolderDeleteState() {
      return { nodeId: null, phase: "closed" };
    },
  });
  const focusSource = contentScriptSource.slice(
    contentScriptSource.indexOf("function boundedTemplateFocusTarget"),
    contentScriptSource.indexOf("function renderSection"),
  );
  const dismissSource = contentScriptSource.slice(
    contentScriptSource.indexOf("function dismissTemplateEditorAndRender"),
    contentScriptSource.indexOf("async function saveEditor"),
  );
  assert.equal(focusSource.trim().length > 0 && dismissSource.trim().length > 0, true);
  vm.runInContext(
    `${focusSource}
    ${dismissSource}
    globalThis.__templateDismissRenderCount = 0;
    function renderSection() {
      globalThis.__templateDismissRenderCount += 1;
      restorePendingTemplateFocus();
    }
    globalThis.__templateDismissRuntime = {
      templateFocusTargetFromAction,
      dismissTemplateEditorAndRender,
      dismissTemplateNodeDeleteAndRender,
    };`,
    context,
  );
  return {
    state,
    capture(element) {
      return clone(context.__templateDismissRuntime.templateFocusTargetFromAction(element));
    },
    dismissEditor() {
      return context.__templateDismissRuntime.dismissTemplateEditorAndRender();
    },
    dismissDelete() {
      return context.__templateDismissRuntime.dismissTemplateNodeDeleteAndRender();
    },
    renderCount() {
      return context.__templateDismissRenderCount;
    },
  };
}

assert.equal(workspace.DB_NAME, "chatgpt-helper-workspace");
assert.equal(workspace.DB_VERSION, 1);
assert.equal(workspace.WORKSPACE_SCHEMA_VERSION, 2);
assert.equal(workspace.MAX_INLINE_SELECTION_LENGTH, 5000);
assert.equal(workspace.MAX_INLINE_SELECTION_LINES, 40);
assert.equal(workspace.MAX_INLINE_CANDIDATES, 64);
assert.equal(workspace.MAX_INLINE_CANDIDATE_LENGTH, 80);
assert.equal(workspace.MAX_INLINE_NGRAM_TOKENS, 4);
assert.equal(workspace.MAX_INLINE_RESULT_ENTRIES, 100);
assert.equal(
  workspace.MESSAGE_TYPES.LOOKUP_GLOSSARY_SELECTION,
  "chatgpt-helper:workspace-lookup-glossary-selection",
);
assert.deepEqual({
  TEMPLATE_NODE_CREATE: workspace.MESSAGE_TYPES.TEMPLATE_NODE_CREATE,
  TEMPLATE_NODE_UPDATE: workspace.MESSAGE_TYPES.TEMPLATE_NODE_UPDATE,
  TEMPLATE_NODE_MOVE: workspace.MESSAGE_TYPES.TEMPLATE_NODE_MOVE,
  TEMPLATE_NODE_DELETE: workspace.MESSAGE_TYPES.TEMPLATE_NODE_DELETE,
  TEMPLATE_TREE_UI_UPDATE: workspace.MESSAGE_TYPES.TEMPLATE_TREE_UI_UPDATE,
}, {
  TEMPLATE_NODE_CREATE: "chatgpt-helper:template-node-create",
  TEMPLATE_NODE_UPDATE: "chatgpt-helper:template-node-update",
  TEMPLATE_NODE_MOVE: "chatgpt-helper:template-node-move",
  TEMPLATE_NODE_DELETE: "chatgpt-helper:template-node-delete",
  TEMPLATE_TREE_UI_UPDATE: "chatgpt-helper:template-tree-ui-update",
});
assert.deepEqual({
  TEMPLATE_CREATE: workspace.MESSAGE_TYPES.TEMPLATE_CREATE,
  TEMPLATE_UPDATE: workspace.MESSAGE_TYPES.TEMPLATE_UPDATE,
  TEMPLATE_DELETE: workspace.MESSAGE_TYPES.TEMPLATE_DELETE,
  TEMPLATE_REORDER: workspace.MESSAGE_TYPES.TEMPLATE_REORDER,
}, {
  TEMPLATE_CREATE: "chatgpt-helper:template-create",
  TEMPLATE_UPDATE: "chatgpt-helper:template-update",
  TEMPLATE_DELETE: "chatgpt-helper:template-delete",
  TEMPLATE_REORDER: "chatgpt-helper:template-reorder",
});
assert.deepEqual(Object.keys(workspace.STORE_DEFINITIONS), [
  "meta",
  "conversations",
  "glossaryConcepts",
  "glossarySenses",
  "glossaryLinks",
  "savedItems",
  "savedItemLinks",
  "importBackups",
]);
assert.equal(workspace.STORE_DEFINITIONS.conversations.indexes.find((item) => item.name === "scopeKey").unique, true);
assert.deepEqual(
  workspace.STORE_DEFINITIONS.glossaryLinks.indexes.find((item) => item.name === "conversationIdLocalOrder").keyPath,
  ["conversationId", "localOrder"],
);

assert.deepEqual(workspace.canonicalizeTerm("WorkflowOrchestrator"), {
  displayTerm: "WorkflowOrchestrator",
  canonicalTerm: "Workflow Orchestrator",
  normalizedKey: "workflow orchestrator",
});
assert.equal(workspace.canonicalizeTerm("XMLHttpRequest").normalizedKey, "xml http request");
assert.equal(workspace.canonicalizeTerm("PascalCase").normalizedKey, "pascal case");
for (const technicalTerm of ["C++", "C#", ".NET", "GPT-4.1", "API/SDK", "client-side"]) {
  assert.equal(workspace.canonicalizeTerm(technicalTerm).canonicalTerm, technicalTerm);
}
assert.equal(workspace.canonicalizeTerm(" **‘Workflow–Runner’** ").normalizedKey, "workflow-runner");
assert.deepEqual(workspace.validateInlineSelectionText(" OpenAPI\r\nGraphRAG "), {
  ok: true,
  text: "OpenAPI\nGraphRAG",
  lineCount: 2,
});
assert.equal(workspace.validateInlineSelectionText("x".repeat(5000)).ok, true);
assert.equal(workspace.validateInlineSelectionText("x".repeat(5001)).error, "GLOSSARY_SELECTION_TOO_LARGE");
assert.equal(
  workspace.validateInlineSelectionText(Array.from({ length: 41 }, () => "API").join("\n")).error,
  "GLOSSARY_SELECTION_TOO_MANY_LINES",
);
const extractedInline = workspace.extractInlineGlossaryCandidates(
  "1. OpenAPI client / RAG pipeline\nРусский текст GraphRAG",
);
assert.equal(extractedInline.ok, true);
assert.ok(extractedInline.candidates.some((item) => item.displayTerm === "OpenAPI client"));
assert.ok(extractedInline.candidates.some((item) => item.displayTerm === "RAG pipeline"));
assert.ok(extractedInline.candidates.some((item) => item.displayTerm === "GraphRAG"));
assert.ok(extractedInline.candidates.every((item) => item.tokenCount <= workspace.MAX_INLINE_NGRAM_TOKENS));
assert.ok(extractedInline.candidates.length <= workspace.MAX_INLINE_CANDIDATES);
assert.ok(
  extractedInline.candidates
    .filter((item) => item.source === "token")
    .every((item) => item.visibility === "primary"),
);
assert.ok(
  extractedInline.candidates
    .filter((item) => item.source === "ngram")
    .every((item) => item.visibility === "lookup-only"),
);
assert.deepEqual(workspace.tokenizeGlossaryTerm("OpenAPI response"), ["openapi", "response"]);
const termModeInline = workspace.extractInlineGlossaryCandidates("OpenAPI client");
assert.deepEqual(
  termModeInline.candidates
    .filter((item) => item.visibility === "primary")
    .map((item) => [item.displayTerm, item.source]),
  [["OpenAPI client", "selected-whole"]],
);
assert.deepEqual(
  termModeInline.candidates
    .filter((item) => item.visibility === "lookup-only")
    .map((item) => item.displayTerm),
  ["OpenAPI", "client"],
);
const fragmentModeInline = workspace.extractInlineGlossaryCandidates("route handler короткий");
assert.deepEqual(
  fragmentModeInline.candidates
    .filter((item) => item.visibility === "primary")
    .map((item) => item.displayTerm),
  ["route", "handler"],
);
assert.deepEqual(
  fragmentModeInline.candidates
    .filter((item) => item.visibility === "lookup-only")
    .map((item) => item.displayTerm),
  ["route handler"],
);
for (const listItem of [
  "• route handler",
  "* route handler",
  "- route handler",
  "+ route handler",
  "1. route handler",
  "1) route handler",
]) {
  assert.deepEqual(
    workspace.extractInlineGlossaryCandidates(listItem).candidates
      .map((item) => [item.displayTerm, item.source, item.visibility]),
    [
      ["route", "token", "primary"],
      ["handler", "token", "primary"],
      ["route handler", "ngram", "lookup-only"],
    ],
    `a leading list marker forces fragment mode without entering a candidate: ${listItem}`,
  );
}
for (const technicalTerm of ["C++", "GPT-5", "Pydantic.v2"]) {
  assert.deepEqual(
    workspace.extractInlineGlossaryCandidates(technicalTerm).candidates
      .filter((item) => item.visibility === "primary")
      .map((item) => [item.displayTerm, item.source]),
    [[technicalTerm, "selected-whole"]],
    `technical punctuation does not create a list-item boundary: ${technicalTerm}`,
  );
}
for (const [input, expectedPrimary] of [
  ["OpenAPIпример", ["OpenAPI"]],
  ["примерOpenAPI", ["OpenAPI"]],
  ["RAGрусскийGraphRAG", ["RAG", "GraphRAG"]],
]) {
  const adjacentMixed = workspace.extractInlineGlossaryCandidates(input);
  assert.deepEqual(
    adjacentMixed.candidates
      .filter((item) => item.visibility === "primary")
      .map((item) => item.displayTerm),
    expectedPrimary,
    `adjacent Cyrillic is a hard boundary: ${input}`,
  );
  assert.equal(
    adjacentMixed.candidates.some((item) => /[А-Яа-яЁё]/u.test(item.displayTerm)),
    false,
  );
  assert.equal(
    adjacentMixed.candidates.some((item) => item.displayTerm === "RAG GraphRAG"),
    false,
  );
}
const normalizedInline = workspace.extractInlineGlossaryCandidates(
  "  ＯpenAPI\u00a0client\u200B  ",
);
assert.equal(normalizedInline.text, "OpenAPI client");
assert.deepEqual(
  normalizedInline.candidates.find((item) => item.normalizedKey === "open api").tokens,
  ["openapi"],
);
const punctuationInline = workspace.extractInlineGlossaryCandidates(
  "Pydantic.v2 C++ C# snake_case long-running",
);
for (const term of ["Pydantic.v2", "C++", "C#", "snake_case", "long-running"]) {
  const candidate = punctuationInline.candidates.find((item) => item.displayTerm === term);
  assert.ok(candidate, `technical token is extracted: ${term}`);
  assert.equal(candidate.tokenCount, 1);
}
const ngramInline = workspace.extractInlineGlossaryCandidates("Alpha Beta Gamma Delta Epsilon");
for (const [term, tokenCount] of [
  ["Alpha Beta", 2],
  ["Alpha Beta Gamma", 3],
  ["Alpha Beta Gamma Delta", 4],
]) {
  const candidate = ngramInline.candidates.find((item) => item.displayTerm === term);
  assert.ok(candidate, `contiguous ${tokenCount}-gram is extracted`);
  assert.equal(candidate.tokenCount, tokenCount);
}
assert.equal(
  ngramInline.candidates.some((item) => item.displayTerm === "Alpha Beta Gamma Delta Epsilon"),
  false,
);
const boundaryInline = workspace.extractInlineGlossaryCandidates(
  "API client. SDK server\n- DTO mapper\nRAG русский GraphRAG\nrequest/response",
);
for (const forbiddenPhrase of [
  "client SDK",
  "server DTO",
  "RAG GraphRAG",
  "request response",
]) {
  assert.equal(
    boundaryInline.candidates.some((item) => item.displayTerm === forbiddenPhrase),
    false,
    `phrase does not cross a hard boundary: ${forbiddenPhrase}`,
  );
}
for (const expectedTerm of ["API client", "SDK server", "DTO mapper", "request", "response"]) {
  assert.ok(
    boundaryInline.candidates.some((item) => item.displayTerm === expectedTerm),
    `candidate survives its local boundary: ${expectedTerm}`,
  );
}
const repeatedInline = workspace.extractInlineGlossaryCandidates("OpenAPI OpenAPI");
const repeatedOpenApi = repeatedInline.candidates.find((item) => item.normalizedKey === "open api");
assert.equal(repeatedOpenApi.displayTerm, "OpenAPI");
assert.equal(repeatedOpenApi.firstIndex, 0);
assert.equal(repeatedOpenApi.occurrences, 2);
assert.equal(repeatedOpenApi.tokenCount, 1);
const candidateLimitedInline = workspace.extractInlineGlossaryCandidates(
  Array.from({ length: 70 }, (_, index) => `Api${index}`).join(" "),
);
assert.equal(candidateLimitedInline.candidateCountBeforeLimit > workspace.MAX_INLINE_CANDIDATES, true);
assert.equal(candidateLimitedInline.candidateCountReturned, workspace.MAX_INLINE_CANDIDATES);
assert.equal(candidateLimitedInline.candidateTruncated, true);
assert.equal(
  candidateLimitedInline.candidates.every((candidate) => candidate.visibility === "primary"),
  true,
  "lookup-only n-grams cannot displace primary candidates from the budget",
);
assert.deepEqual(
  candidateLimitedInline.candidates.map((candidate) => candidate.displayTerm),
  Array.from({ length: workspace.MAX_INLINE_CANDIDATES }, (_, index) => `Api${index}`),
);
const workspaceMutationClassification = serviceWorkerSource.slice(
  serviceWorkerSource.indexOf("const WORKSPACE_MUTATION_MESSAGES"),
  serviceWorkerSource.indexOf("const activeRequests"),
);
assert.doesNotMatch(workspaceMutationClassification, /LOOKUP_GLOSSARY_SELECTION/);
const workerLookupRoute = serviceWorkerSource.slice(
  serviceWorkerSource.indexOf("if (message.type === WORKSPACE_MESSAGES.LOOKUP_GLOSSARY_SELECTION)"),
  serviceWorkerSource.indexOf("if (message.type === WORKSPACE_MESSAGES.ATTACH_GLOSSARY_SENSE"),
);
assert.match(workerLookupRoute, /validateInlineSelectionText\(message\.text\)/);
assert.match(workerLookupRoute, /workspace\.lookupGlossarySelection/);
assert.doesNotMatch(workerLookupRoute, /runUserMutation|broadcastWorkspaceChange|mutateAndBroadcast|openRouterClient/);

assert.equal(manifest.version, "1.2.0");
assert.deepEqual(manifest.permissions, ["storage", "contextMenus"]);
assert.deepEqual(manifest.host_permissions, [
  "https://chatgpt.com/*",
  "https://chat.openai.com/*",
  "https://openrouter.ai/*",
]);
assert.deepEqual(manifest.content_scripts[0].js, [
  "src/workspace-contract.js",
  "src/template-tree.js",
  "src/conversation-context.js",
  "src/command-registry.js",
  "src/chatgpt-dom.js",
  "src/analysis-contract.js",
  "src/analysis-controller.js",
  "src/translation-controller.js",
  "src/analysis-ui.js",
  "src/workspace-ui.js",
  "src/content-script.js",
]);
const workerImportScripts = serviceWorkerSource
  .slice(serviceWorkerSource.indexOf("importScripts("), serviceWorkerSource.indexOf(");", serviceWorkerSource.indexOf("importScripts(")))
  .match(/"([^"]+\.js)"/g)
  .map((value) => value.slice(1, -1));
assert.deepEqual(workerImportScripts.slice(0, 5), [
  "workspace-contract.js",
  "template-tree.js",
  "conversation-context.js",
  "command-registry.js",
  "import-export.js",
]);
const optionsScriptSources = [...optionsHtmlSource.matchAll(/<script src="([^"]+)"><\/script>/g)]
  .map((match) => match[1]);
assert.deepEqual(optionsScriptSources, [
  "workspace-contract.js",
  "template-tree.js",
  "import-export.js",
  "analysis-contract.js",
  "options.js",
]);
assert.deepEqual(packageLock.packages, {});
assert.equal(packageLock.lockfileVersion, 3);

assert.match(serviceWorkerSource, /const templateTree = globalThis\.ChatGPTHelperTemplateTree;/);
assert.match(contentScriptSource, /const templateTree = globalThis\.ChatGPTHelperTemplateTree;/);
assert.match(importExportSource, /root\.ChatGPTHelperTemplateTree[\s\S]*require\("\.\/template-tree\.js"\)/);
assert.match(workspaceUiSource, /root\.ChatGPTHelperTemplateTree[\s\S]*require\("\.\/template-tree\.js"\)/);
for (const [owner, source] of [
  ["service worker", serviceWorkerSource],
  ["content script", contentScriptSource],
  ["import/export", importExportSource],
  ["workspace UI", workspaceUiSource],
]) {
  assert.doesNotMatch(source, /\bnormalizeTemplates\b/, `${owner} must use shared template-tree ownership`);
}

const migrateStorageSource = serviceWorkerSource.slice(
  serviceWorkerSource.indexOf("async function migrateStorage"),
  serviceWorkerSource.indexOf("function storageValuesEqual"),
);
assert.match(migrateStorageSource, /runLocalStorageMigration\(async \(\) =>/);
assert.doesNotMatch(migrateStorageSource, /runLocalMutation\(async \(\) =>/);
const storageMigrationSource = serviceWorkerSource.slice(
  serviceWorkerSource.indexOf("function buildStorageMigrationPatch"),
  serviceWorkerSource.indexOf("function getWorkspace"),
);
assert.match(storageMigrationSource, /templateTree\.prepareStoredNodes\(stored\.templates\)/);
assert.match(storageMigrationSource, /templateTree\.normalizeRecentTemplateIds/);
assert.match(storageMigrationSource, /templateTree\.normalizeTreeUiState/);
assert.match(storageMigrationSource, /changes\.templateTreeUiState = normalizedTreeUiState/);

const localQueueSource = serviceWorkerSource.slice(
  serviceWorkerSource.indexOf("function runLocalMutation"),
  serviceWorkerSource.indexOf("async function currentSettings"),
);
assert.match(localQueueSource, /const queued = localMutationQueue\.then\(async \(\) =>/);
assert.match(localQueueSource, /localMutationQueue = settled\.then\(\(\) => undefined, \(\) => undefined\)/);
const localMutationSource = serviceWorkerSource.slice(
  serviceWorkerSource.indexOf("async function handleLocalMutation"),
  serviceWorkerSource.indexOf("async function durableImportMarker"),
);
assert.match(localMutationSource, /const guarded = await runLocalMutation\(async \(\) =>/);
assert.doesNotMatch(localMutationSource, /getWorkspace|broadcastWorkspaceChange|ensureMigrated|ENTITY_FAMILIES/);
const localTreeTransactionSource = localMutationSource.slice(
  localMutationSource.indexOf("const stored = await chrome.storage.local.get"),
);
assert.match(
  localTreeTransactionSource,
  /chrome\.storage\.local\.get\(\[\s*"templates",\s*"recentTemplateIds",\s*"templateTreeUiState",?\s*\]\)/,
);
assert.equal(
  (localTreeTransactionSource.match(/chrome\.storage\.local\.set\(/g) || []).length,
  1,
  "a tree mutation performs at most one atomic local-storage set",
);
assert.match(localTreeTransactionSource, /chrome\.storage\.local\.set\(changes\)/);
assert.doesNotMatch(localTreeTransactionSource, /broadcastWorkspaceChange|workspaceInstance|getWorkspace/);
assert.match(localMutationSource, /message\.type === WORKSPACE_MESSAGES\.TEMPLATE_CREATE/);
assert.match(localMutationSource, /message\.type === WORKSPACE_MESSAGES\.TEMPLATE_UPDATE/);
assert.match(localMutationSource, /message\.type === WORKSPACE_MESSAGES\.TEMPLATE_DELETE/);
assert.match(localMutationSource, /message\.type === WORKSPACE_MESSAGES\.TEMPLATE_REORDER/);
assert.match(
  localMutationSource,
  /draft:\s*\{\s*kind: templateTree\.NODE_KINDS\.TEMPLATE,[\s\S]*iconKey: templateTree\.DEFAULT_TEMPLATE_ICON,[\s\S]*targetParentId: null,[\s\S]*beforeNodeId: null/,
);
assert.match(localMutationSource, /current\.kind !== templateTree\.NODE_KINDS\.TEMPLATE/);
assert.match(localMutationSource, /workspaceContract\.validateTemplatePatch\(message\.patch\)/);
assert.match(localMutationSource, /mode: "node"/);
assert.match(localMutationSource, /const reordered = ids\.map\(\(id\) => byId\.get\(id\)\)/);
assert.match(localMutationSource, /templates\.some\(\(node\) => node\.kind === templateTree\.NODE_KINDS\.FOLDER\)/);
assert.match(localMutationSource, /code: templateTree\.ERROR_CODES\.RELOAD_REQUIRED/);
assert.match(localMutationSource, /message\.type === WORKSPACE_MESSAGES\.RECENT_TEMPLATE_TOUCH/);
assert.match(localMutationSource, /current\.kind !== templateTree\.NODE_KINDS\.TEMPLATE/);

const localMessageRouteSource = contentMessageRouterSource.slice(
  contentMessageRouterSource.indexOf("if (LOCAL_MUTATION_MESSAGES.has(message.type))"),
  contentMessageRouterSource.indexOf("let workspaceAvailable"),
);
assert.match(localMessageRouteSource, /message\.type === WORKSPACE_MESSAGES\.SETTINGS_UPDATE/);
assert.match(localMessageRouteSource, /return handleLocalMutation\(message\)/);
assert.equal(
  localMessageRouteSource.indexOf("return handleLocalMutation(message)")
    < localMessageRouteSource.lastIndexOf("if (workspaceRecoveryRequired)"),
  true,
  "tree mutations return through the local queue before Workspace recovery/migration routing",
);

const storageListenerSource = contentScriptSource.slice(
  contentScriptSource.indexOf("chrome.storage.onChanged.addListener"),
  contentScriptSource.indexOf("const mountObserver"),
);
assert.match(storageListenerSource, /changes\.templateTreeUiState/);
assert.match(storageListenerSource, /applyStoredTemplateTree/);
assert.match(storageListenerSource, /closeTemplatePreview\(\)/);
assert.match(storageListenerSource, /closeRecentPopup\(\)/);
const contentStorageHarness = createContentStorageListenerHarness();
const observedStorageSettings = {
  ...workspace.DEFAULT_ACTIVE_SETTINGS,
  theme: "gold",
  wallpaperDataUrl: OBSERVED_WALLPAPER_DATA_URL,
  recentTemplatesHoverCount: 7.6,
};
assert.doesNotThrow(() => contentStorageHarness.handleStorageChange({
  settings: {
    oldValue: workspace.DEFAULT_ACTIVE_SETTINGS,
    newValue: observedStorageSettings,
  },
}));
assert.equal(contentStorageHarness.state.settings.theme, "gold");
assert.equal(contentStorageHarness.state.settings.wallpaperDataUrl, OBSERVED_WALLPAPER_DATA_URL);
assert.equal(contentStorageHarness.state.settings.recentTemplatesHoverCount, 8);
assert.equal(
  contentStorageHarness.state.sidebarPreferredWidth,
  workspace.DEFAULT_ACTIVE_SETTINGS.layout.sidebarWidth,
);
assert.deepEqual(contentStorageHarness.calls, [
  "closeTemplatePreview",
  "cleanupTemplateTreeDrag",
  "closeRecentPopup",
  "renderSection",
]);
const templateEditorMarkupSource = contentScriptSource.slice(
  contentScriptSource.indexOf("function iconPickerMarkup"),
  contentScriptSource.indexOf("function templateDeleteMarkup"),
);
const templateEditorFixture = {
  id: null,
  kind: templateTree.NODE_KINDS.TEMPLATE,
  name: "Draft",
  iconKey: templateTree.DEFAULT_TEMPLATE_ICON,
  content: "Draft body",
  autoSend: false,
  targetParentId: null,
};
const editorWithoutErrorMarkup = renderTemplateEditorMarkup(templateEditorFixture, "");
assert.doesNotMatch(editorWithoutErrorMarkup, /aria-describedby=|id="template-editor-error"/);
const editorWithErrorMarkup = renderTemplateEditorMarkup(
  templateEditorFixture,
  "Заполните название и текст шаблона.",
);
assert.match(
  editorWithErrorMarkup,
  /<input[^>]*data-field="name"[^>]*aria-describedby="template-editor-error"/,
);
assert.match(
  editorWithErrorMarkup,
  /<textarea[^>]*data-field="content"[^>]*aria-describedby="template-editor-error"/,
);
assert.match(
  editorWithErrorMarkup,
  /<div[^>]*class="icon-picker"[^>]*aria-describedby="template-editor-error"/,
);
assert.match(
  editorWithErrorMarkup,
  /<select[^>]*data-field="parentId"[^>]*aria-describedby="template-editor-error"/,
);
assert.match(
  editorWithErrorMarkup,
  /<input[^>]*data-field="autoSend"[^>]*aria-describedby="template-editor-error"/,
);
assert.match(
  editorWithErrorMarkup,
  /<button[^>]*data-action="save-edit"[^>]*aria-describedby="template-editor-error"/,
);
assert.match(
  editorWithErrorMarkup,
  /<p class="inline-error" id="template-editor-error" role="alert">/,
);
assert.equal(
  (editorWithErrorMarkup.match(/aria-describedby="template-editor-error"/g) || []).length,
  6,
  "only the six relevant editor controls/groups reference the active error",
);
assert.match(contentScriptSource, /const TEMPLATE_EDITOR_ERROR_ID = "template-editor-error"/);
assert.match(
  templateEditorMarkupSource,
  /const describedBy = state\.editorError[\s\S]*aria-describedby="[\s\S]*TEMPLATE_EDITOR_ERROR_ID/,
  "an active editor error enables a stable aria-describedby token",
);
assert.match(
  templateEditorMarkupSource,
  /data-field="name"[\s\S]*maxlength="120"' \+ describedBy/,
  "the editor name control references the active error",
);
assert.match(
  templateEditorMarkupSource,
  /data-field="content"[\s\S]*maxlength="200000"' \+ describedBy/,
  "the editor content control references the active error",
);
assert.match(
  templateEditorMarkupSource,
  /class="icon-picker"[\s\S]*aria-label="Иконка"' \+ describedBy/,
  "the icon control group references the active error",
);
assert.match(
  templateEditorMarkupSource,
  /data-field="parentId"' \+ describedBy/,
  "the location control references the active error",
);
assert.match(
  templateEditorMarkupSource,
  /data-field="autoSend"[\s\S]*\+ describedBy \+/,
  "the auto-send control references the active error",
);
assert.match(
  templateEditorMarkupSource,
  /class="inline-error" id="' \+ TEMPLATE_EDITOR_ERROR_ID \+ '" role="alert"/,
  "the active inline editor error renders the stable ID",
);
const templateFocusLifecycleSource = contentScriptSource.slice(
  contentScriptSource.indexOf("function boundedTemplateFocusTarget"),
  contentScriptSource.indexOf("function openSection"),
);
assert.match(
  templateFocusLifecycleSource,
  /state\.pendingTemplateFocusTarget = boundedTemplateFocusTarget\(value\)/,
  "pending focus targets pass through the bounded allowlist",
);
assert.match(
  templateFocusLifecycleSource,
  /for \(const action of TEMPLATE_TOOLBAR_FOCUS_ACTIONS\)[\s\S]*controls\.find/,
  "a missing original control falls back to a Templates toolbar action",
);
assert.match(
  templateFocusLifecycleSource,
  /function restorePendingTemplateFocus[\s\S]*state\.pendingTemplateFocusTarget = null[\s\S]*control\.focus\(\)/,
  "pending focus is consumed and restored after rerender",
);
assert.equal(
  templateFocusLifecycleSource.indexOf("state.body.innerHTML = templatesMarkup()")
    < templateFocusLifecycleSource.indexOf(
      'if (state.activeSection === "templates") restorePendingTemplateFocus();',
    ),
  true,
  "Templates rerender precedes focus restoration",
);
const restoreTemplateFocusSource = templateFocusLifecycleSource.slice(
  templateFocusLifecycleSource.indexOf("function restorePendingTemplateFocus"),
  templateFocusLifecycleSource.indexOf("function renderSection"),
);
assert.doesNotMatch(
  restoreTemplateFocusSource,
  /state\.editing\s*=|captureEditorInputs/,
  "focus restoration does not mutate or discard an editor draft",
);
let originalTemplateFocusCount = 0;
let toolbarTemplateFocusCount = 0;
const templateFocusRuntime = createTemplateFocusRuntime([
  {
    dataset: { action: "add-template-in-folder", id: "focus-folder" },
    isConnected: true,
    disabled: false,
    focus() { originalTemplateFocusCount += 1; },
  },
  {
    dataset: { action: "add-template" },
    isConnected: true,
    disabled: false,
    focus() { toolbarTemplateFocusCount += 1; },
  },
]);
assert.deepEqual(
  templateFocusRuntime.fromAction({
    dataset: { action: "add-folder", id: undefined },
  }),
  { action: "add-folder", nodeId: null },
  "root creation captures its specific toolbar action with a null node ID",
);
assert.equal(
  templateFocusRuntime.bounded({ action: "run-template", nodeId: "unsafe" }),
  null,
  "unapproved actions cannot become pending focus targets",
);
templateFocusRuntime.queue({
  action: "add-template-in-folder",
  nodeId: "focus-folder",
});
assert.equal(templateFocusRuntime.restore(), true);
assert.equal(originalTemplateFocusCount, 1);
assert.equal(toolbarTemplateFocusCount, 0);
assert.equal(templateFocusRuntime.state.pendingTemplateFocusTarget, null);
templateFocusRuntime.queue({ action: "edit-node", nodeId: "deleted-node" });
const draftBeforeFocusRestoration = {
  id: "editing-node",
  name: "Unsaved draft",
  content: "Unsaved content",
};
templateFocusRuntime.state.editing = clone(draftBeforeFocusRestoration);
assert.equal(templateFocusRuntime.restore(), true);
assert.equal(
  toolbarTemplateFocusCount,
  1,
  "a stale/deleted original control restores focus to the Templates toolbar",
);
assert.deepEqual(
  templateFocusRuntime.state.editing,
  draftBeforeFocusRestoration,
  "focus restoration leaves an active draft byte-for-byte unchanged",
);
const dismissFocusCounts = new Map();
function dismissFocusControl(action, nodeId) {
  const key = `${action}:${nodeId || "root"}`;
  dismissFocusCounts.set(key, 0);
  return {
    dataset: { action, ...(nodeId ? { id: nodeId } : {}) },
    isConnected: true,
    disabled: false,
    focus() {
      dismissFocusCounts.set(key, dismissFocusCounts.get(key) + 1);
    },
  };
}
const templateDismissRuntime = createTemplateDismissRuntime([
  dismissFocusControl("add-template", null),
  dismissFocusControl("add-folder", null),
  dismissFocusControl("add-template-in-folder", "dismiss-folder"),
  dismissFocusControl("edit-node", "dismiss-template"),
  dismissFocusControl("ask-node-delete", "dismiss-template"),
]);
function dismissEditorFrom(action, nodeId) {
  templateDismissRuntime.state.editing = {
    id: nodeId || null,
    name: "Intentional cancel draft",
  };
  templateDismissRuntime.state.editorReturnFocusTarget = templateDismissRuntime.capture({
    dataset: { action, ...(nodeId ? { id: nodeId } : {}) },
  });
  assert.equal(templateDismissRuntime.dismissEditor(), true);
  assert.equal(templateDismissRuntime.state.pendingTemplateFocusTarget, null);
}
dismissEditorFrom("add-folder", null);
dismissEditorFrom("add-template-in-folder", "dismiss-folder");
dismissEditorFrom("edit-node", "dismiss-template");
templateDismissRuntime.state.templateDeleteId = "dismiss-template";
templateDismissRuntime.state.deleteReturnFocusTarget = templateDismissRuntime.capture({
  dataset: { action: "ask-node-delete", id: "dismiss-template" },
});
assert.equal(templateDismissRuntime.dismissDelete(), true);
assert.equal(templateDismissRuntime.state.pendingTemplateFocusTarget, null);
assert.equal(dismissFocusCounts.get("add-folder:root"), 1);
assert.equal(dismissFocusCounts.get("add-template-in-folder:dismiss-folder"), 1);
assert.equal(dismissFocusCounts.get("edit-node:dismiss-template"), 1);
assert.equal(dismissFocusCounts.get("ask-node-delete:dismiss-template"), 1);
assert.equal(templateDismissRuntime.renderCount(), 4);
const templateEditorActionsSource = contentScriptSource.slice(
  contentScriptSource.indexOf("function openNodeEditor"),
  contentScriptSource.indexOf("async function onShadowChange"),
);
assert.match(
  templateEditorActionsSource,
  /function openNodeEditor[\s\S]*if \(state\.editing\)[\s\S]*captureEditorInputs\(\)[\s\S]*return false/,
  "opening another node editor must preserve the existing draft",
);
assert.match(
  templateEditorActionsSource,
  /action === "ask-node-delete"[\s\S]*if \(state\.editing\)[\s\S]*captureEditorInputs\(\)[\s\S]*return/,
  "opening delete confirmation must not discard an existing draft",
);
assert.doesNotMatch(
  templateEditorActionsSource.slice(
    templateEditorActionsSource.indexOf('action === "ask-node-delete"'),
    templateEditorActionsSource.indexOf('action === "cancel-node-delete"'),
  ),
  /state\.editing = null/,
);
assert.equal(
  templateEditorActionsSource.indexOf("state.editorReturnFocusTarget = boundedTemplateFocusTarget")
    < templateEditorActionsSource.indexOf("state.editing = {"),
  true,
  "the editor trigger action/node target is captured before the editor opens",
);
assert.match(
  templateEditorActionsSource,
  /function dismissTemplateEditorAndRender[\s\S]*queuePendingTemplateFocus\(state\.editorReturnFocusTarget\)[\s\S]*renderSection\(\)/,
  "Cancel/Escape places the bounded editor return target before rerender",
);
assert.match(
  templateEditorActionsSource,
  /function dismissTemplateNodeDeleteAndRender[\s\S]*queuePendingTemplateFocus\(state\.deleteReturnFocusTarget\)[\s\S]*renderSection\(\)/,
  "delete dismissal places the bounded delete return target before rerender",
);
assert.match(
  templateEditorActionsSource,
  /action === "add-template"[\s\S]*templateFocusTargetFromAction\(actionButton\)[\s\S]*action === "add-folder"[\s\S]*templateFocusTargetFromAction\(actionButton\)/,
  "root creation retains its corresponding toolbar trigger",
);
assert.match(
  templateEditorActionsSource,
  /action === "add-template-in-folder"[\s\S]*templateFocusTargetFromAction\(actionButton\)[\s\S]*action === "add-folder-in-folder"[\s\S]*templateFocusTargetFromAction\(actionButton\)/,
  "folder-context creation retains its row trigger and node ID",
);
assert.match(
  templateEditorActionsSource,
  /action === "cancel-edit"[\s\S]*dismissTemplateEditorAndRender\(\)/,
  "editor Cancel uses bounded pending focus restoration",
);
assert.match(
  templateEditorActionsSource,
  /action === "ask-node-delete"[\s\S]*state\.deleteReturnFocusTarget = templateFocusTargetFromAction\(actionButton\)[\s\S]*action === "cancel-node-delete"[\s\S]*dismissTemplateNodeDeleteAndRender\(\)/,
  "delete choice captures its trigger and Cancel restores through the pending target",
);

const dropIntentTemplates = [
  folderNode("drop-folder", "Folder"),
  templateNode("drop-nested", "Nested", "Nested body", false, "drop-folder"),
  templateNode("drop-template", "Template", "Template body"),
  folderNode("drop-folder-after", "Folder after"),
  templateNode("drop-drag", "Dragged", "Dragged body"),
];
const evaluateTemplateDropIntent = createTemplateDropIntentRuntime(
  dropIntentTemplates,
  "drop-drag",
);
const rootAppendIntent = {
  zone: "inside",
  targetNodeId: null,
  targetParentId: null,
  beforeNodeId: null,
  root: true,
};
const explicitRootTarget = {
  closest(selector) {
    return selector === "[data-template-root-target]" ? this : null;
  },
};
const explicitRootDescendant = {
  closest(selector) {
    return selector === "[data-template-root-target]" ? explicitRootTarget : null;
  },
};
assert.deepEqual(
  evaluateTemplateDropIntent({ target: explicitRootTarget }),
  rootAppendIntent,
  "the explicit root target itself accepts root append intent",
);
assert.deepEqual(
  evaluateTemplateDropIntent({ target: explicitRootDescendant }),
  rootAppendIntent,
  "a child of the explicit root target accepts the same root append intent",
);
const rootListTarget = {
  closest(selector) {
    return selector === ".templates-list" ? this : null;
  },
};
assert.equal(
  evaluateTemplateDropIntent({ target: rootListTarget }),
  null,
  "the direct root-list background is not a root target",
);
const nestedChildListTarget = {
  closest(selector) {
    if (selector === ".template-children") return this;
    return selector === ".templates-list" ? rootListTarget : null;
  },
};
assert.equal(
  evaluateTemplateDropIntent({ target: nestedChildListTarget }),
  null,
  "nested child-list background is not a root target",
);
const nestedSlotTarget = {};
const nestedGapTarget = {
  closest(selector) {
    if (selector === "[data-template-slot-id]") return nestedSlotTarget;
    return selector === ".templates-list" ? rootListTarget : null;
  },
};
assert.equal(
  evaluateTemplateDropIntent({ target: nestedGapTarget }),
  null,
  "nested slot or descendant whitespace is not a root target",
);
function templateCardDropEvent(nodeId, clientY) {
  const card = {
    dataset: { templateNodeId: nodeId },
    getBoundingClientRect() {
      return { top: 0, height: 100 };
    },
  };
  return {
    clientY,
    target: {
      closest(selector) {
        return selector === "[data-template-node-id]" ? card : null;
      },
    },
  };
}
assert.deepEqual(
  evaluateTemplateDropIntent(templateCardDropEvent("drop-template", 20)),
  {
    zone: "before",
    targetNodeId: "drop-template",
    targetParentId: null,
    beforeNodeId: "drop-template",
    root: false,
  },
  "template-card upper zone keeps before semantics",
);
assert.deepEqual(
  evaluateTemplateDropIntent(templateCardDropEvent("drop-template", 80)),
  {
    zone: "after",
    targetNodeId: "drop-template",
    targetParentId: null,
    beforeNodeId: "drop-folder-after",
    root: false,
  },
  "template-card lower zone keeps after semantics",
);
assert.deepEqual(
  evaluateTemplateDropIntent(templateCardDropEvent("drop-folder", 10)),
  {
    zone: "before",
    targetNodeId: "drop-folder",
    targetParentId: null,
    beforeNodeId: "drop-folder",
    root: false,
  },
  "folder-card upper zone keeps before semantics",
);
assert.deepEqual(
  evaluateTemplateDropIntent(templateCardDropEvent("drop-folder", 50)),
  {
    zone: "inside",
    targetNodeId: "drop-folder",
    targetParentId: "drop-folder",
    beforeNodeId: null,
    root: false,
  },
  "folder-card middle zone keeps inside semantics",
);
assert.deepEqual(
  evaluateTemplateDropIntent(templateCardDropEvent("drop-folder", 90)),
  {
    zone: "after",
    targetNodeId: "drop-folder",
    targetParentId: null,
    beforeNodeId: "drop-template",
    root: false,
  },
  "folder-card lower zone keeps after semantics after the complete subtree",
);

const idleTemplateDragUi = createTemplateDragUiRuntime(dropIntentTemplates);
const templateCardDragMarkupSource = contentScriptSource.slice(
  contentScriptSource.indexOf("function templateCardMarkup"),
  contentScriptSource.indexOf("function folderCardMarkup"),
);
const folderCardDragMarkupSource = contentScriptSource.slice(
  contentScriptSource.indexOf("function folderCardMarkup"),
  contentScriptSource.indexOf("function templateProjectionById"),
);
assert.match(
  templateCardDragMarkupSource,
  /class="drag-handle" draggable="true" data-template-drag-id="' \+ escapeHtml\(template\.id\)/,
  "template markup wires its native draggable handle to the structural drag handler",
);
assert.match(
  folderCardDragMarkupSource,
  /class="drag-handle" draggable="true" data-template-drag-id="' \+ escapeHtml\(folder\.id\)/,
  "folder markup wires its native draggable handle to the structural drag handler",
);
assert.equal(
  idleTemplateDragUi.rootTarget.classList.contains("is-template-drag-visible"),
  false,
  "idle root target has no visible drag class",
);
assert.equal(
  idleTemplateDragUi.body.classList.contains("is-template-tree-dragging"),
  false,
  "idle Templates body has no drag geometry class",
);

const templateDragUi = createTemplateDragUiRuntime(dropIntentTemplates);
const templateDragStart = templateDragUi.dragStart("template");
assert.equal(templateDragStart.prevented, false);
assert.equal(templateDragStart.dataTransfer.effectAllowed, "move");
assert.equal(
  templateDragUi.rootTarget.classList.contains("is-template-drag-visible"),
  true,
  "a successful structural template drag reveals the explicit root target",
);
assert.equal(
  templateDragUi.body.classList.contains("is-template-tree-dragging"),
  true,
  "a successful structural template drag enables remaining-space flex geometry",
);
assert.equal(
  templateDragUi.templateCard.classList.contains("is-dragging"),
  true,
  "the structural drag source keeps its existing drag class",
);

const folderDragUi = createTemplateDragUiRuntime(dropIntentTemplates);
const folderDragStart = folderDragUi.dragStart("folder");
assert.equal(folderDragStart.prevented, false);
assert.equal(folderDragUi.state.templateTreeDrag.draggingNodeId, "drop-folder");
assert.equal(
  folderDragUi.rootTarget.classList.contains("is-template-drag-visible"),
  true,
  "a successful structural folder drag reveals the explicit root target",
);

const blockedTemplateDragUi = createTemplateDragUiRuntime(dropIntentTemplates);
blockedTemplateDragUi.state.editing = { id: "drop-template" };
const blockedTemplateDragStart = blockedTemplateDragUi.dragStart("template");
assert.equal(blockedTemplateDragStart.prevented, true);
assert.equal(blockedTemplateDragUi.state.templateTreeDrag.draggingNodeId, null);
assert.equal(
  blockedTemplateDragUi.rootTarget.classList.contains("is-template-drag-visible"),
  false,
  "a blocked structural drag leaves the root target hidden",
);

const savedDragUi = createTemplateDragUiRuntime(dropIntentTemplates);
savedDragUi.dragStart("saved");
assert.equal(
  savedDragUi.rootTarget.classList.contains("is-template-drag-visible"),
  false,
  "saved-entry drag does not reveal the Templates root target",
);
assert.equal(savedDragUi.state.savedDraggingId, "saved-drag");

const glossaryDragUi = createTemplateDragUiRuntime(dropIntentTemplates);
glossaryDragUi.dragStart("glossary");
assert.equal(
  glossaryDragUi.rootTarget.classList.contains("is-template-drag-visible"),
  false,
  "glossary drag does not reveal the Templates root target",
);
assert.equal(glossaryDragUi.state.glossaryDraggingId, "glossary-drag");

const rootTargetDragOver = templateDragUi.dragOver(templateDragUi.rootTarget);
assert.equal(rootTargetDragOver.prevented, true);
assert.equal(rootTargetDragOver.dataTransfer.dropEffect, "move");
assert.deepEqual(rootTargetDragOver.intent, rootAppendIntent);
const rootChildDragOver = templateDragUi.dragOver(templateDragUi.rootChild);
assert.equal(rootChildDragOver.prevented, true);
assert.equal(rootChildDragOver.dataTransfer.dropEffect, "move");
assert.deepEqual(
  rootChildDragOver.intent,
  rootAppendIntent,
  "root target descendants keep the same valid move dragover contract",
);

const rootListTransitionUi = createTemplateDragUiRuntime(dropIntentTemplates);
rootListTransitionUi.dragStart("template");
rootListTransitionUi.show(rootAppendIntent);
const rootListTransition = rootListTransitionUi.dragOver(rootListTransitionUi.rootList);
assert.equal(rootListTransition.prevented, false);
assert.equal(rootListTransition.dataTransfer.dropEffect, "none");
assert.equal(rootListTransition.intent, null);
assert.equal(
  rootListTransitionUi.rootTarget.classList.contains("is-drop-inside"),
  false,
  "moving from root intent onto root-list whitespace clears the stale root highlight",
);
assert.equal(
  rootListTransitionUi.rootTarget.classList.contains("is-template-drag-visible"),
  true,
  "invalid whitespace keeps the structural-drag root zone visible but neutral",
);

const nestedGapTransitionUi = createTemplateDragUiRuntime(dropIntentTemplates);
const nestedGapTransitionTarget = {
  closest(selector) {
    return selector === ".templates-list" ? nestedGapTransitionUi.rootList : null;
  },
};
nestedGapTransitionUi.dragStart("template");
nestedGapTransitionUi.show(rootAppendIntent);
const nestedGapTransition = nestedGapTransitionUi.dragOver(nestedGapTransitionTarget);
assert.equal(nestedGapTransition.prevented, false);
assert.equal(nestedGapTransition.intent, null);
assert.equal(
  nestedGapTransitionUi.rootTarget.classList.contains("is-drop-inside"),
  false,
  "moving from root intent onto nested gap whitespace clears the stale root highlight",
);

templateDragUi.show(rootAppendIntent);
assert.equal(
  templateDragUi.rootTarget.classList.contains("is-drop-inside"),
  true,
  "root intent applies the root active highlight",
);
templateDragUi.show({
  zone: "before",
  targetNodeId: "drop-template",
  targetParentId: null,
  beforeNodeId: "drop-template",
  root: false,
});
assert.equal(
  templateDragUi.rootTarget.classList.contains("is-drop-inside"),
  false,
  "card intent clears and does not reapply the root active highlight",
);
assert.equal(
  templateDragUi.slot.classList.contains("is-drop-before"),
  true,
  "card intent renders only its insertion line",
);
templateDragUi.show(rootAppendIntent);
templateDragUi.cleanup();
assert.equal(
  templateDragUi.rootTarget.classList.contains("is-template-drag-visible"),
  false,
  "cleanup removes root target visibility",
);
assert.equal(
  templateDragUi.rootTarget.classList.contains("is-drop-inside"),
  false,
  "cleanup removes root active highlight",
);
assert.equal(
  templateDragUi.body.classList.contains("is-template-tree-dragging"),
  false,
  "cleanup removes remaining-space drag geometry",
);
assert.equal(templateDragUi.templateCard.classList.contains("is-dragging"), false);
assert.equal(templateDragUi.state.templateTreeDrag.draggingNodeId, null);

const dragEndUi = createTemplateDragUiRuntime(dropIntentTemplates);
dragEndUi.dragStart("template");
dragEndUi.show(rootAppendIntent);
dragEndUi.dragEnd();
assert.equal(dragEndUi.rootTarget.classList.contains("is-template-drag-visible"), false);
assert.equal(dragEndUi.rootTarget.classList.contains("is-drop-inside"), false);
assert.equal(dragEndUi.body.classList.contains("is-template-tree-dragging"), false);
assert.equal(dragEndUi.state.templateTreeDrag.draggingNodeId, null);

const rootDropUi = createTemplateDragUiRuntime(dropIntentTemplates);
rootDropUi.dragStart("template");
rootDropUi.show(rootAppendIntent);
const rootDrop = rootDropUi.drop(rootDropUi.rootChild);
assert.equal(rootDrop.prevented, true);
assert.deepEqual(rootDrop.intent, rootAppendIntent);
assert.equal(
  rootDropUi.rootTarget.classList.contains("is-template-drag-visible"),
  false,
  "drop on a child of the explicit target hides the zone before async mutation",
);
assert.equal(rootDropUi.rootTarget.classList.contains("is-drop-inside"), false);

const invalidRootMoveUi = createTemplateDragUiRuntime(dropIntentTemplates);
invalidRootMoveUi.dragStart("template");
invalidRootMoveUi.state.templateTreeDrag.draggingNodeId = "missing-node";
invalidRootMoveUi.show(rootAppendIntent);
const templatesBeforeInvalidRootMove = clone(invalidRootMoveUi.state.templates);
const invalidRootDrop = invalidRootMoveUi.drop(invalidRootMoveUi.rootTarget);
assert.equal(invalidRootDrop.prevented, false);
assert.equal(invalidRootDrop.intent, null);
assert.deepEqual(invalidRootMoveUi.state.templates, templatesBeforeInvalidRootMove);
assert.equal(invalidRootMoveUi.state.status.kind, "error");
assert.equal(
  invalidRootMoveUi.rootTarget.classList.contains("is-template-drag-visible"),
  false,
  "an invalid root move reports the existing error without mutating the tree or leaving the zone visible",
);

const rerenderCleanupUi = createTemplateDragUiRuntime(dropIntentTemplates);
rerenderCleanupUi.dragStart("template");
rerenderCleanupUi.show(rootAppendIntent);
rerenderCleanupUi.render();
assert.equal(
  rerenderCleanupUi.rootTarget.classList.contains("is-template-drag-visible"),
  false,
  "real renderSection cleanup hides an active root zone before DOM replacement",
);
assert.equal(rerenderCleanupUi.state.templateTreeDrag.draggingNodeId, null);

const templateDragSource = contentScriptSource.slice(
  contentScriptSource.indexOf("function nextTemplateSiblingId"),
  contentScriptSource.indexOf("function mount"),
);
assert.doesNotMatch(
  templateDragSource,
  /closest\?\.\("\.templates-list"\)|target === rootList/,
  "root append classification has no implicit root-list background path",
);
assert.match(
  templateDragSource,
  /function showTemplateDropIntent\(intent\)[\s\S]*clearTemplateDropIndicators\(\);[\s\S]*if \(!intent\) return;/,
  "every indicator update clears stale drop classes before applying the current intent",
);
assert.match(
  templateDragSource,
  /if \(intent\.root\)[\s\S]*querySelector\("\[data-template-root-target\]"\)[\s\S]*classList\.add\("is-drop-inside"\)/,
  "root intent renders only the explicit root indicator",
);
assert.match(
  templateDragSource,
  /function onDragStart\(event\)[\s\S]*setTemplateRootDropZoneVisible\(false\)[\s\S]*dataTransfer\.setData[\s\S]*setTemplateRootDropZoneVisible\(true\)/,
  "the root zone becomes visible only after the structural drag is initialized",
);
assert.match(
  contentScriptSource,
  /function cleanupTemplateTreeDrag[\s\S]*setTemplateRootDropZoneVisible\(false\)/,
  "central drag cleanup always hides the root zone",
);
assert.match(
  templateDragSource,
  /event\.preventDefault\(\);\s*setTemplateRootDropZoneVisible\(false\);\s*clearTemplateDropIndicators\(\);\s*clearTemplateHoverTimer\(\);/,
  "a valid drop hides the root zone synchronously before the async move",
);
assert.match(
  templateDragSource,
  /const intent = templateDropIntent\(event\);[\s\S]*if \(!intent\) \{[\s\S]*clearTemplateDragIntent\(true\);[\s\S]*return;/,
  "nested whitespace with no intent clears indicators and temporary expansion",
);
assert.match(templateDragSource, /function setTemporaryTemplateExpansions/);
assert.match(
  templateDragSource,
  /temporaryRoots = temporaryFolderIds\.filter[\s\S]*ancestorsOf/,
  "nested temporary expansion renders only topmost roots",
);
assert.match(
  templateDragSource,
  /temporarilyExpandedFolderIds[\s\S]*filter\(\(folderId\) => relevantPath\.has\(folderId\)\)/,
  "revealed descendants retain their temporarily expanded ancestor chain",
);
assert.match(
  templateDragSource,
  /setTemporaryTemplateExpansions\(\[\s*\.\.\.state\.templateTreeDrag\.temporarilyExpandedFolderIds,\s*targetId,/,
  "nested auto-expand appends instead of replacing its ancestor chain",
);
assert.match(
  templateDragSource,
  /const expansionSaved = await saveTemplateMutation[\s\S]*if \(!expansionSaved\)[\s\S]*Перемещение сохранено, но раскрытие папки сохранить не удалось/,
  "inside-drop must not report full success after expansion persistence fails",
);
const templateRootVisibilitySource = contentScriptSource.slice(
  contentScriptSource.indexOf("function setTemplateRootDropZoneVisible"),
  contentScriptSource.indexOf("function clearTemplateHoverTimer"),
);
assert.doesNotMatch(
  templateRootVisibilitySource,
  /renderSection\(/,
  "root-zone visibility uses bounded DOM classes without rerendering the native drag",
);
assert.match(
  contentScriptSource,
  /function renderSection\(options\)[\s\S]*if \(!options\?\.preserveTemplateDrag[\s\S]*cleanupTemplateTreeDrag\(\)/,
  "any section rerender cleans an active structural drag before replacing DOM",
);
assert.match(
  contentScriptSource,
  /\.panel-body\.is-template-tree-dragging \{ display: flex; flex-direction: column; \}/,
  "Templates drag makes the scroll body a column flex container",
);
assert.match(
  contentScriptSource,
  /\.template-root-drop \{ display: none;[\s\S]*border: 1px dashed var\(--border\)/,
  "the idle root target is display-none while retaining neutral dashed drag styling",
);
assert.match(
  contentScriptSource,
  /\.template-root-drop\.is-template-drag-visible \{ display: flex; min-height: 96px; flex: 1 0 96px; \}/,
  "the visible root target grows through remaining panel space and retains a 96px minimum",
);
assert.match(
  contentScriptSource,
  /state\.templates\.length \? rows[\s\S]*statusMarkup\(\),\s*'<div class="template-root-drop" data-template-root-target><span>Переместить в корень<\/span>/,
  "the explicit root target and its real child element are the final surface after root nodes and status",
);
const templateMountSource = contentScriptSource.slice(
  contentScriptSource.indexOf("function mount"),
  contentScriptSource.indexOf("function ensureMounted"),
);
assert.match(
  templateMountSource,
  /function mount\(\)[\s\S]*cleanupTemplateTreeDrag\(\)/,
  "remount starts by cleaning any structural drag and root-zone classes",
);
[
  ["dragstart", "onDragStart"],
  ["dragend", "onDragEnd"],
  ["dragover", "onDragOver"],
  ["dragleave", "onDragLeave"],
  ["drop", "onDrop"],
].forEach(([eventName, handlerName]) => {
  assert.match(
    templateMountSource,
    new RegExp(`shadow\\.addEventListener\\("${eventName}", ${handlerName}\\)`),
    `${eventName} remains wired to ${handlerName} on remount`,
  );
});
assert.match(
  contentScriptSource,
  /\.panel-opener, \.folder-toggle \{[\s\S]*\.folder-toggle:hover/,
  "folder toggle uses the shared themed button reset",
);

const dataBackupValidationSource = serviceWorkerSource.slice(
  serviceWorkerSource.indexOf("function assertDataBackupValid"),
  serviceWorkerSource.indexOf("async function rollbackDataBackup"),
);
assert.match(dataBackupValidationSource, /payload\.templateTreeUiState/);
assert.match(dataBackupValidationSource, /templateTree\.normalizeTreeUiState/);
assert.match(
  dataBackupValidationSource,
  /Object\.prototype\.hasOwnProperty\.call\(payload, "templateTreeUiState"\)/,
  "backup validation distinguishes rolling Stage-10 backups from Stage-11 backups",
);
assert.match(dataBackupValidationSource, /const rollingLegacyBackup = !hasTreeUiState/);
assert.match(
  dataBackupValidationSource,
  /!rollingLegacyBackup[\s\S]*storageValuesEqual\(payload\.recentTemplateIds, normalizedRecentTemplateIds\)/,
  "legacy backups may normalize stale recent IDs while Stage-11 backups remain strict",
);
assert.match(
  dataBackupValidationSource,
  /hasTreeUiState[\s\S]*storageValuesEqual\(payload\.templateTreeUiState, normalizedTreeUiState\)/,
  "a present Stage-11 UI state must exactly match its normalized form",
);
assert.match(dataBackupValidationSource, /templateTreeUiState: normalizedTreeUiState/);
const dataRollbackSource = serviceWorkerSource.slice(
  serviceWorkerSource.indexOf("async function rollbackDataBackup"),
  serviceWorkerSource.indexOf("async function recoverPendingImports"),
);
assert.match(
  dataRollbackSource,
  /chrome\.storage\.local\.set\(\{\s*templates: normalizedBackup\.templates,\s*recentTemplateIds: normalizedBackup\.recentTemplateIds,\s*templateTreeUiState: normalizedBackup\.templateTreeUiState,\s*\}\)/,
);
assert.match(dataRollbackSource, /DATA_ROLLBACK_VERIFICATION_FAILED/);
const dataApplySource = serviceWorkerSource.slice(
  serviceWorkerSource.indexOf("async function applyDataImport"),
  serviceWorkerSource.indexOf("function workspaceError"),
);
assert.match(
  dataApplySource,
  /templateTreeUiState: invalidCurrentTemplateTree[\s\S]*: currentTreeUiState/,
);
assert.match(dataApplySource, /plan\.mode === "replace"\s*\?\s*\[\]/);
assert.match(dataApplySource, /plan\.mode === "replace"\s*\?\s*\{ collapsedFolderIds: \[\] \}/);

assert.equal(
  workspace.normalizeSavedTextKey("  First  \r\n\r\nSecond\t \rThird  "),
  "First\n\nSecond\nThird",
);
assert.equal(workspace.normalizeSavedTextKey("First\n\nSecond"), "First\n\nSecond");
assert.equal(workspace.validateSavedText("  ").ok, false);
assert.equal(workspace.validateSavedText("A\n\nB").ok, true);
assert.equal(workspace.normalizeSelectedPlainText("One\r\n\r\n  Two\rThree"), "One\n\n  Two\nThree");
assert.equal(workspace.validateSavedText("One\r\n\r\n  Two").text, "One\n\n  Two");
assert.equal(workspace.MAX_WALLPAPER_SOURCE_BYTES, 6 * 1024 * 1024);
assert.deepEqual(workspace.validateWallpaperSourceFile({ type: "image/png", size: 6 * 1024 * 1024 }), { ok: true });
assert.deepEqual(workspace.validateWallpaperSourceFile({ type: "image/png", size: (6 * 1024 * 1024) + 1 }), {
  ok: false,
  error: "WALLPAPER_FILE_TOO_LARGE",
  message: "Изображение превышает лимит 6 МБ.",
});
assert.deepEqual(workspace.validateWallpaperSourceFile({ type: "text/plain", size: 10 }), {
  ok: false,
  error: "WALLPAPER_INVALID_TYPE",
  message: "Выберите файл изображения.",
});

assert.deepEqual(conversations.extractStableConversation("https://chatgpt.com/g/g-test/c/abc_123?x=1"), {
  kind: "stable",
  host: "chatgpt.com",
  remoteConversationId: "abc_123",
  scopeKey: "stable:chatgpt.com:abc_123",
  canonicalUrl: "https://chatgpt.com/c/abc_123",
});
assert.equal(conversations.extractStableConversation("https://chat.openai.com/c/old-chat").scopeKey, "stable:chat.openai.com:old-chat");
assert.equal(conversations.extractStableConversation("https://chatgpt.com/") , null);
assert.equal(conversations.extractStableConversation("https://example.com/c/abc"), null);
assert.equal(conversations.extractStableConversation("not a URL"), null);
assert.equal(conversations.contextChanged({ scopeKey: "stable:chatgpt.com:a" }, { scopeKey: "stable:chatgpt.com:b" }), true);

assert.deepEqual(Object.keys(commands.COMMAND_BY_ID), [
  "analyze-selection",
  "translate-selection",
  "save-selection",
  "normalize-composer",
]);
assert.equal(commands.COMMANDS.analyzeSelection.messageType, "RUN_ANALYSIS_COMMAND");
assert.equal(commands.COMMANDS.translateSelection.messageType, "RUN_TRANSLATE_SELECTION_COMMAND");
assert.equal(commands.COMMANDS.saveSelection.messageType, "RUN_SAVE_SELECTION_COMMAND");
assert.equal(commands.COMMANDS.normalizeComposer.messageType, "RUN_NORMALIZE_COMPOSER_COMMAND");
assert.equal(commands.selectionEligible({ supportedPage: true, isEditable: false, selectionText: "save me" }), true);
assert.equal(commands.selectionEligible({ supportedPage: true, isEditable: true, selectionText: "save me" }), false);
assert.equal(commands.composerEligible({ supportedPage: true, isComposer: true }), true);
assert.equal(commands.composerEligible({ supportedPage: true, isComposer: false }), false);

assert.deepEqual(workspace.normalizeComposerText("A\nB"), { text: "A\nB", changed: false, edits: [] });
assert.equal(workspace.normalizeComposerText("A\n\nB").text, "A\n\nB");
assert.equal(workspace.normalizeComposerText("A\n\n\nB").text, "A\n\nB");
assert.equal(workspace.normalizeComposerText(workspace.normalizeComposerText("A\n\n\nB").text).text, "A\n\nB");
assert.equal(workspace.normalizeComposerText("A\r\n \n\t\rB").text, "A\r\n\r\nB");
assert.equal(workspace.normalizeComposerText("A\n \n\tB").text, "A\n\n\tB");
const mappedNormalization = workspace.normalizeComposerText("A\n \n\tB");
assert.equal(workspace.mapOffsetThroughEdits(6, mappedNormalization.edits), 5);
for (const source of ["A\nB", "A\n\nB", "A\n\n\nB", "A\r\n \n\t\rB", "\n \n\nB"]) {
  const once = workspace.normalizeComposerPlainText(source).text;
  assert.equal(workspace.normalizeComposerPlainText(once).text, once, `composer normalization is idempotent for ${JSON.stringify(source)}`);
}
const largeNormalizerInput = "\n \n\nB".repeat(40000);
assert.equal(largeNormalizerInput.length, 200000);
const normalizerStartedAt = Date.now();
assert.equal(workspace.normalizeComposerText(largeNormalizerInput).text.length > 0, true);
assert.equal(Date.now() - normalizerStartedAt < 2000, true, "200k composer normalization remains linear-time in the sanity fixture");

assert.equal(
  OBSERVED_WALLPAPER_DATA_URL.length - "data:image/jpeg;base64,".length,
  8_146_944,
);
assert.doesNotThrow(() => {
  assert.equal(workspace.isAllowedWallpaperDataUrl(OBSERVED_WALLPAPER_DATA_URL), true);
});
assert.doesNotThrow(() => {
  const invalidAtEnd = `${OBSERVED_WALLPAPER_DATA_URL.slice(0, -1)}!`;
  assert.equal(workspace.isAllowedWallpaperDataUrl(invalidAtEnd), false);
});
for (const mime of ["png", "jpg", "jpeg", "gif", "webp"]) {
  assert.equal(workspace.isAllowedWallpaperDataUrl(`data:image/${mime};base64,A`), true);
}
assert.equal(workspace.isAllowedWallpaperDataUrl("DaTa:ImAgE/WeBp;BaSe64,A"), true);
assert.equal(workspace.isAllowedWallpaperDataUrl(null), true);
for (const nonStringValue of [undefined, false, 0, {}, []]) {
  assert.equal(workspace.isAllowedWallpaperDataUrl(nonStringValue), false);
}
assert.equal(workspace.isAllowedWallpaperDataUrl("data:image/png;base64,"), false);
assert.equal(workspace.isAllowedWallpaperDataUrl("data:image/bmp;base64,A"), false);
assert.equal(workspace.isAllowedWallpaperDataUrl("data:image/png;base64,!A"), false);
assert.equal(workspace.isAllowedWallpaperDataUrl("data:image/png;base64,A!A"), false);
assert.equal(workspace.isAllowedWallpaperDataUrl("data:image/png;base64,AA!"), false);
assert.equal(
  workspace.isAllowedWallpaperDataUrl(`data:image/png;base64,A${ECMASCRIPT_WHITESPACE}Z`),
  true,
);
assert.equal(
  workspace.isAllowedWallpaperDataUrl(`data:image/png;base64,${ECMASCRIPT_WHITESPACE}`),
  true,
);
assert.equal(workspace.isAllowedWallpaperDataUrl("data:image/png;base64,A"), true);
assert.equal(workspace.isAllowedWallpaperDataUrl("data:image/png;base64,=A====B=="), true);
assert.equal(workspace.isAllowedWallpaperDataUrl("data:image/png;base64,AA==MORE"), true);
assert.equal(workspace.isAllowedWallpaperDataUrl("data:image/png;base64,A+/="), true);
assert.equal(workspace.isAllowedWallpaperDataUrl("data:image/jpeg;base64,iVBORw0KGgo"), true);
assert.equal(workspace.isAllowedWallpaperDataUrl(WALLPAPER_COMPATIBILITY_FIXTURE), true);
assert.equal(
  workspace.normalizeActiveSettings({ wallpaperDataUrl: WALLPAPER_COMPATIBILITY_FIXTURE }).wallpaperDataUrl,
  WALLPAPER_COMPATIBILITY_FIXTURE,
);
assert.deepEqual(
  workspace.validateActiveSettingsPatch({ wallpaperDataUrl: WALLPAPER_COMPATIBILITY_FIXTURE }),
  { ok: true, patch: { wallpaperDataUrl: WALLPAPER_COMPATIBILITY_FIXTURE } },
);
assert.equal(
  workspace.normalizeActiveSettings({ wallpaperDataUrl: "data:image/png;base64,A!" }).wallpaperDataUrl,
  null,
);
assert.equal(
  workspace.validateActiveSettingsPatch({ wallpaperDataUrl: "data:image/png;base64,A!" }).ok,
  false,
);

assert.deepEqual(workspace.normalizeActiveSettings({
  theme: "gold",
  closePanelAfterRun: false,
  recentTemplatesHoverEnabled: false,
  recentTemplatesHoverCount: 7.6,
  analysis: { termColorMode: "custom", customTermColor: "#ABCDEF", glossaryTextSize: "large", shortcut: { code: "KeyX" } },
  layout: { sidebarWidth: 999, analysisDialogWidth: 100 },
  commands: { injected: true },
  keyStatus: "configured",
}), {
  theme: "gold",
  wallpaperDataUrl: null,
  closePanelAfterRun: false,
  closePanelOnOutsideClick: true,
  recentTemplatesHoverEnabled: false,
  recentTemplatesHoverCount: 8,
  analysis: { termColorMode: "custom", customTermColor: "#abcdef", glossaryTextSize: "large" },
  layout: { sidebarWidth: 720, analysisDialogWidth: 360 },
});
assert.deepEqual(workspace.validateActiveSettingsPatch({
  wallpaperDataUrl: null,
  closePanelOnOutsideClick: false,
  analysis: { customTermColor: "#ABCDEF" },
  layout: { sidebarWidth: 999 },
  recentTemplatesHoverCount: 8,
}), {
  ok: true,
  patch: {
    wallpaperDataUrl: null,
    closePanelOnOutsideClick: false,
    recentTemplatesHoverCount: 8,
    analysis: { customTermColor: "#abcdef" },
    layout: { sidebarWidth: 720 },
  },
});
assert.deepEqual(workspace.RECENT_TEMPLATES_HOVER_COUNT, { default: 3, min: 1, max: 8 });
assert.deepEqual(
  [undefined, "6", null, NaN, Infinity, -4, 1.49, 7.6, 99]
    .map((value) => workspace.normalizeRecentTemplatesHoverCount(value)),
  [3, 3, 3, 3, 3, 1, 1, 8, 8],
);
assert.deepEqual(workspace.normalizeRecentTemplateIds([
  "one", " two ", "one", "", null, "three", "four", "five", "six", "seven", "eight",
]), ["one", "two", "three", "four", "five", "six", "seven", "eight"]);
for (const invalidPatch of [
  {},
  { unknown: true },
  { wallpaperDataUrl: undefined },
  { analysis: {} },
  { analysis: { shortcut: "KeyX" } },
  { layout: { sidebarWidth: "420" } },
  { recentTemplatesHoverCount: "3" },
  { recentTemplatesHoverCount: null },
  { recentTemplatesHoverCount: 1.5 },
  { recentTemplatesHoverCount: 0 },
  { recentTemplatesHoverCount: 9 },
]) assert.equal(workspace.validateActiveSettingsPatch(invalidPatch).ok, false);
for (const recentTemplatesHoverCount of [1, 3, 8]) {
  assert.deepEqual(workspace.validateActiveSettingsPatch({ recentTemplatesHoverCount }), {
    ok: true,
    patch: { recentTemplatesHoverCount },
  });
}
const patchedSettings = workspace.applyActiveSettingsPatch({
  ...workspace.DEFAULT_ACTIVE_SETTINGS,
  theme: "navy",
  layout: { sidebarWidth: 410, analysisDialogWidth: 610 },
}, { theme: "gold", layout: { sidebarWidth: 420 } });
assert.equal(patchedSettings.ok, true);
assert.equal(patchedSettings.settings.theme, "gold");
assert.deepEqual(patchedSettings.settings.layout, { sidebarWidth: 420, analysisDialogWidth: 610 });
assert.deepEqual(workspace.createActiveSettingsPatch(
  { ...workspace.DEFAULT_ACTIVE_SETTINGS, theme: "navy" },
  {
    ...workspace.DEFAULT_ACTIVE_SETTINGS,
    theme: "navy",
    wallpaperDataUrl: null,
    recentTemplatesHoverCount: 6,
    layout: { sidebarWidth: 420, analysisDialogWidth: 560 },
  },
), { recentTemplatesHoverCount: 6, layout: { sidebarWidth: 420 } });
assert.deepEqual(workspace.validateTemplatePatch({ name: "New", content: "A\n\n\nB" }), {
  ok: true,
  patch: { name: "New", content: "A\n\n\nB" },
});
assert.deepEqual(workspace.validateTemplatePatch({ autoSend: true }), { ok: true, patch: { autoSend: true } });
const originalTemplateLeaves = { name: "Old name", content: "Old content", autoSend: false };
assert.deepEqual(workspace.createTemplatePatch(originalTemplateLeaves, {
  name: "New name", content: "Old content", autoSend: false,
}), { name: "New name" });
assert.deepEqual(workspace.createTemplatePatch(originalTemplateLeaves, {
  name: "Old name", content: "New content", autoSend: false,
}), { content: "New content" });
assert.deepEqual(workspace.createTemplatePatch(originalTemplateLeaves, {
  name: "New name", content: "New content", autoSend: false,
}), { name: "New name", content: "New content" });
assert.deepEqual(workspace.createTemplatePatch(originalTemplateLeaves, originalTemplateLeaves), {});
assert.deepEqual(workspace.interpretTemplateExecutionResult({
  ok: true,
  inserted: true,
  unchanged: false,
  failed: false,
  verified: true,
  verificationFailed: false,
  sendAttempted: false,
  sent: false,
  sendFailed: false,
}), {
  accepted: true,
  noop: false,
  insertionSucceeded: true,
  insertionFailed: false,
  verificationFailed: false,
  sendFailed: false,
}, "ordinary verified template insertion remains successful without a required send");
assert.deepEqual(workspace.interpretTemplateExecutionResult({
  ok: true,
  inserted: true,
  failed: false,
  verified: true,
  verificationFailed: false,
  sendAttempted: true,
  sent: true,
  sendFailed: false,
}, { requireSent: true }), {
  accepted: true,
  noop: false,
  insertionSucceeded: true,
  insertionFailed: false,
  verificationFailed: false,
  sendFailed: false,
}, "verified insertion plus successful send is accepted");
assert.deepEqual(workspace.interpretTemplateExecutionResult({
  ok: true, inserted: true, failed: false, verified: false, verificationFailed: true,
  sendAttempted: false, sent: false, sendFailed: false,
}, { requireSent: true }), {
  accepted: false,
  noop: false,
  insertionSucceeded: true,
  insertionFailed: false,
  verificationFailed: true,
  sendFailed: false,
}, "an overloaded ok cannot hide verification failure");
assert.deepEqual(workspace.interpretTemplateExecutionResult({
  ok: false, inserted: false, unchanged: false, failed: true, verified: false,
  verificationFailed: false, sendAttempted: false, sent: false, sendFailed: false,
}, { requireSent: true }), {
  accepted: false,
  noop: false,
  insertionSucceeded: false,
  insertionFailed: true,
  verificationFailed: false,
  sendFailed: false,
}, "actual insertion failure stays distinguishable");
assert.deepEqual(workspace.interpretTemplateExecutionResult({
  ok: true, inserted: true, failed: false, verified: true, verificationFailed: false,
  sendAttempted: true, sent: false, sendFailed: true,
}, { requireSent: true }), {
  accepted: false,
  noop: false,
  insertionSucceeded: true,
  insertionFailed: false,
  verificationFailed: false,
  sendFailed: true,
}, "send failure stays distinguishable");
assert.equal(workspace.interpretTemplateExecutionResult({
  ok: true, inserted: true, failed: false, verified: true, verificationFailed: false,
  sendAttempted: false, sent: false, sendFailed: false,
}, { requireSent: true }).sendFailed, true, "every required but unsent non-noop result is rejected");
assert.equal(workspace.interpretTemplateExecutionResult({ ok: true }, { requireSent: true }).insertionFailed, true,
  "a legacy ok-only result cannot be silently accepted");
assert.deepEqual(workspace.interpretTemplateExecutionResult({ ok: true, noop: true }, { requireSent: true }), {
  accepted: true,
  noop: true,
  insertionSucceeded: false,
  insertionFailed: false,
  verificationFailed: false,
  sendFailed: false,
}, "non-empty composer noop remains accepted");
for (const invalidTemplatePatch of [
  {},
  { unknown: true },
  { name: "" },
  { content: "   " },
  { autoSend: "true" },
]) assert.equal(workspace.validateTemplatePatch(invalidTemplatePatch).ok, false);
assert.equal(workspace.effectiveWidth("sidebarWidth", 720, 500), 400);
assert.equal(workspace.clampPreferredWidth("sidebarWidth", 720), 720);
assert.equal(workspace.resizePreferredWidth("sidebarWidth", 360, -40, "left"), 400);
assert.equal(workspaceUi.nextSidebarPhase("closed", "open"), "opening");
assert.equal(workspaceUi.nextSidebarPhase("opening", "open"), "opening");
assert.equal(workspaceUi.nextSidebarPhase("opening", "close"), "opening");
assert.equal(workspaceUi.nextSidebarPhase("opening", "complete"), "open");
assert.equal(workspaceUi.nextSidebarPhase("open", "close"), "closing");
assert.equal(workspaceUi.nextSidebarPhase("closing", "open"), "closing");
assert.equal(workspaceUi.nextSidebarPhase("closing", "complete"), "revealing-opener");
assert.equal(workspaceUi.nextSidebarPhase("revealing-opener", "close"), "revealing-opener");
assert.equal(workspaceUi.nextSidebarPhase("revealing-opener", "complete"), "closed");
assert.deepEqual(workspaceUi.quickActionStateForPhase("closing"), {
  rendered: true,
  visible: false,
  interactive: false,
});
assert.deepEqual(workspaceUi.quickActionStateForPhase("revealing-opener"), {
  rendered: true,
  visible: true,
  interactive: false,
});
assert.deepEqual(workspaceUi.quickActionStateForPhase("closed"), {
  rendered: true,
  visible: true,
  interactive: true,
});
for (const phase of ["opening", "open"]) {
  assert.deepEqual(workspaceUi.quickActionStateForPhase(phase), {
    rendered: false,
    visible: false,
    interactive: false,
  });
}

function createFakeTransitionElement() {
  const listeners = new Set();
  return {
    listeners,
    addEventListener(type, listener) { if (type === "transitionend") listeners.add(listener); },
    removeEventListener(type, listener) { if (type === "transitionend") listeners.delete(listener); },
    dispatch(propertyName, target) {
      [...listeners].forEach((listener) => listener({ propertyName, target: target || this }));
    },
  };
}

let transitionTimerId = 0;
const transitionTimers = new Map();
const transitionElement = createFakeTransitionElement();
const transitionCompletions = [];
const transitionController = workspaceUi.createTransformTransitionController({
  duration: 200,
  fallbackPadding: 50,
  setTimeout(callback, delay) {
    transitionTimerId += 1;
    transitionTimers.set(transitionTimerId, { callback, delay });
    return transitionTimerId;
  },
  clearTimeout(id) { transitionTimers.delete(id); },
  prefersReducedMotion: () => false,
});
transitionController.run(transitionElement, () => transitionCompletions.push("transition"));
assert.equal([...transitionTimers.values()][0].delay, 250);
transitionElement.dispatch("opacity");
transitionElement.dispatch("transform", {});
assert.deepEqual(transitionCompletions, []);
transitionElement.dispatch("transform");
assert.deepEqual(transitionCompletions, ["transition"]);
assert.equal(transitionTimers.size, 0);

transitionController.run(transitionElement, () => transitionCompletions.push("fallback"));
const fallbackTimer = [...transitionTimers.values()][0];
fallbackTimer.callback();
assert.deepEqual(transitionCompletions, ["transition", "fallback"]);
assert.equal(transitionElement.listeners.size, 0);

transitionController.run(transitionElement, () => transitionCompletions.push("stale"));
const staleListener = [...transitionElement.listeners][0];
transitionController.run(transitionElement, () => transitionCompletions.push("current"));
staleListener({ propertyName: "transform", target: transitionElement });
assert.equal(transitionCompletions.includes("stale"), false);
transitionElement.dispatch("transform");
assert.equal(transitionCompletions.at(-1), "current");

let reducedMotionTimerCalls = 0;
const reducedMotionController = workspaceUi.createTransformTransitionController({
  setTimeout() { reducedMotionTimerCalls += 1; return 1; },
  clearTimeout() {},
  prefersReducedMotion: () => true,
});
let reducedMotionCompleted = false;
reducedMotionController.run(createFakeTransitionElement(), () => { reducedMotionCompleted = true; });
assert.equal(reducedMotionCompleted, true);
assert.equal(reducedMotionTimerCalls, 0);
let reducedClosePhase = "closing";
reducedMotionController.run(createFakeTransitionElement(), () => {
  reducedClosePhase = workspaceUi.nextSidebarPhase(reducedClosePhase, "complete");
  reducedMotionController.run(createFakeTransitionElement(), () => {
    reducedClosePhase = workspaceUi.nextSidebarPhase(reducedClosePhase, "complete");
  });
});
assert.equal(reducedClosePhase, "closed");

const recentHistoryFixture = ["missing", ...Array.from({ length: 8 }, (_, index) => `recent-${index + 1}`)];
const recentTemplatesFixture = Array.from({ length: 8 }, (_, index) => ({
  id: `recent-${index + 1}`,
  kind: "template",
  parentId: null,
  name: `Recent ${index + 1}`,
  iconKey: "document",
  content: `Content ${index + 1}`,
  autoSend: false,
}));
recentTemplatesFixture.splice(2, 0, folderNode("recent-folder", "Recent folder"));
assert.deepEqual(
  workspaceUi.recentTemplatesForDisplay(
    ["recent-folder", ...recentHistoryFixture],
    recentTemplatesFixture,
    3,
  ).map((item) => item.id),
  ["recent-1", "recent-2", "recent-3"],
);
assert.deepEqual(
  workspaceUi.recentTemplatesForDisplay(recentHistoryFixture, recentTemplatesFixture, 6).map((item) => item.id),
  ["recent-1", "recent-2", "recent-3", "recent-4", "recent-5", "recent-6"],
);
assert.equal(recentHistoryFixture.length, 9);
assert.deepEqual(Object.keys(workspaceUi.TEMPLATE_ICON_SVGS), templateTree.VALID_ICON_KEYS);
for (const iconKey of templateTree.VALID_ICON_KEYS) {
  const svg = workspaceUi.TEMPLATE_ICON_SVGS[iconKey];
  assert.equal(typeof svg, "string", `trusted SVG exists for ${iconKey}`);
  assert.match(svg, /^<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" aria-hidden="true">/);
  assert.doesNotMatch(svg, /(?:script|style|on\w+=|href=|url\(|data:|<foreignObject)/i);
}
assert.equal(
  workspaceUi.trustedTemplateIcon("untrusted-icon", templateTree.NODE_KINDS.FOLDER),
  workspaceUi.TEMPLATE_ICON_SVGS.folder,
);
assert.equal(
  workspaceUi.trustedTemplateIcon(undefined, templateTree.NODE_KINDS.FOLDER),
  workspaceUi.TEMPLATE_ICON_SVGS.folder,
);
assert.equal(
  workspaceUi.trustedTemplateIcon("<svg onload=alert(1)>", templateTree.NODE_KINDS.TEMPLATE),
  workspaceUi.TEMPLATE_ICON_SVGS.document,
);
assert.equal(
  workspaceUi.trustedTemplateIcon(undefined, templateTree.NODE_KINDS.TEMPLATE),
  workspaceUi.TEMPLATE_ICON_SVGS.document,
);
assert.deepEqual([
  workspaceUi.templateDropZone("folder", 0.24),
  workspaceUi.templateDropZone("folder", 0.25),
  workspaceUi.templateDropZone("folder", 0.74),
  workspaceUi.templateDropZone("folder", 0.75),
  workspaceUi.templateDropZone("template", 0.49),
  workspaceUi.templateDropZone("template", 0.5),
], ["before", "inside", "inside", "after", "before", "after"]);
assert.deepEqual(
  workspaceUi.previewPosition(
    { left: 700, top: 500, bottom: 540 },
    { width: 380, height: 300 },
    { width: 1000, height: 700, gap: 10, padding: 12 },
  ),
  { left: 310, top: 240 },
);
assert.deepEqual(
  workspaceUi.previewPosition(
    { left: 20, top: 5, bottom: 35 },
    { width: 380, height: 420 },
    { width: 360, height: 500, gap: 10, padding: 12 },
  ),
  { left: 12, top: 12 },
);

function createPreviewTarget(parent, previewAnchor) {
  return {
    parent,
    previewAnchor: previewAnchor === true,
    closest(selector) {
      assert.equal(selector, "[data-preview-anchor]");
      let current = this;
      while (current) {
        if (current.previewAnchor) return current;
        current = current.parent;
      }
      return null;
    },
  };
}

const templateSummarySafeZone = createPreviewTarget(null, false);
const templatePreviewHotspot = createPreviewTarget(templateSummarySafeZone, true);
const templateDragHandle = createPreviewTarget(templatePreviewHotspot, false);
const templateName = createPreviewTarget(templatePreviewHotspot, false);
const templateControlsSafeZone = createPreviewTarget(templateSummarySafeZone, false);
const templateRun = createPreviewTarget(templateControlsSafeZone, false);
const templateEdit = createPreviewTarget(templateControlsSafeZone, false);
const templateAutoSend = createPreviewTarget(templateControlsSafeZone, false);
const templateDelete = createPreviewTarget(templateControlsSafeZone, false);
const recentTemplateButton = createPreviewTarget(null, true);

assert.equal(workspaceUi.previewAnchorFromTarget(templatePreviewHotspot), templatePreviewHotspot);
assert.equal(workspaceUi.previewAnchorFromTarget(templateName), templatePreviewHotspot);
assert.equal(workspaceUi.previewAnchorFromTarget(templateDragHandle), templatePreviewHotspot,
  "keyboard focus on the hotspot's drag handle keeps immediate preview available");
assert.equal(workspaceUi.previewAnchorFromTarget(recentTemplateButton), recentTemplateButton,
  "recent-template buttons remain preview anchors");
for (const [name, target] of [
  ["Run", templateRun],
  ["Edit", templateEdit],
  ["autoSend", templateAutoSend],
  ["Delete", templateDelete],
  ["controls-side whitespace", templateControlsSafeZone],
  ["summary padding", templateSummarySafeZone],
]) {
  assert.equal(workspaceUi.previewAnchorFromTarget(target), null, `${name} stays outside the preview hotspot`);
}
let previewOpenTimersArmed = 0;
function simulatePreviewPointerOver(target) {
  if (workspaceUi.previewAnchorFromTarget(target)) previewOpenTimersArmed += 1;
}
[
  templateRun,
  templateControlsSafeZone,
  templateEdit,
  templateControlsSafeZone,
  templateAutoSend,
  templateControlsSafeZone,
  templateDelete,
  templateSummarySafeZone,
].forEach(simulatePreviewPointerOver);
assert.equal(previewOpenTimersArmed, 0,
  "moving between controls and adjacent safe-zone space cannot arm preview");
simulatePreviewPointerOver(templateName);
assert.equal(previewOpenTimersArmed, 1, "the content hotspot can arm preview");

assert.equal(workspaceUi.activeSearchMode("global", ""), "global");
assert.equal(workspaceUi.activeSearchMode("global", "   "), "global");
assert.equal(workspaceUi.activeSearchMode("global", "query"), "global");
assert.equal(workspaceUi.activeSearchMode("local", "query"), "local");
assert.equal(workspaceUi.requestedModeAfterQueryInput("global", "   "), "global");
assert.equal(workspaceUi.requestedModeAfterQueryInput("global", "q"), "global");
assert.equal(workspaceUi.requestedModeAfterQueryInput("global", ""), "global");
assert.equal(workspaceUi.requestedModeAfterQueryInput("local", "query"), "local");

const nativeSearchMarkup = workspaceUi.savedMarkup({
  savedEntries: [],
  savedSearch: "query",
  savedRequestedMode: "global",
  workspaceStatus: { status: "ready" },
});
assert.match(nativeSearchMarkup, /<input class="workspace-search" type="search"/);
assert.doesNotMatch(nativeSearchMarkup, /workspace-search-clear|clear-saved-search/);
assert.doesNotMatch(workspaceUi.styles(), /workspace-search-clear/);

for (const kind of ["glossary", "saved"]) {
  let requestedMode = "local";
  requestedMode = "global";
  assert.equal(workspaceUi.activeSearchMode(requestedMode, ""), "global", `${kind} keeps the explicit global mode`);
  requestedMode = workspaceUi.requestedModeAfterQueryInput(requestedMode, "q");
  assert.equal(workspaceUi.activeSearchMode(requestedMode, "q"), "global", `${kind} keeps global with a query`);
  requestedMode = workspaceUi.requestedModeAfterQueryInput(requestedMode, "");
  assert.equal(requestedMode, "global", `${kind} clearing search preserves the requested mode`);
  requestedMode = "local";
  requestedMode = workspaceUi.requestedModeAfterQueryInput(requestedMode, "");
  assert.equal(requestedMode, "local", `${kind} clearing a local query preserves local mode`);
}

const closedWorkspaceDelete = workspaceUi.closedWorkspaceDeleteState();
assert.deepEqual(closedWorkspaceDelete, {
  phase: "closed",
  kind: null,
  entryId: null,
  scope: null,
  menuOpen: false,
});
let workspaceDeleteState = workspaceUi.transitionWorkspaceDelete(closedWorkspaceDelete, {
  type: "trigger",
  kind: "glossary",
  entryId: "sense-a",
});
assert.deepEqual(workspaceDeleteState, {
  phase: "choosing",
  kind: "glossary",
  entryId: "sense-a",
  scope: null,
  menuOpen: true,
});
assert.equal(workspaceUi.workspaceDeleteOwns(workspaceDeleteState, "glossary", "sense-a"), true);
assert.equal(workspaceUi.workspaceDeleteMenuOpen(workspaceDeleteState), true);
assert.deepEqual(
  workspaceUi.transitionWorkspaceDelete(workspaceDeleteState, {
    type: "trigger",
    kind: "glossary",
    entryId: "sense-a",
  }),
  closedWorkspaceDelete,
  "the same trash trigger toggles the shared menu closed",
);
workspaceDeleteState = workspaceUi.transitionWorkspaceDelete(workspaceDeleteState, {
  type: "trigger",
  kind: "saved",
  entryId: "saved-b",
});
assert.equal(workspaceDeleteState.kind, "saved");
assert.equal(workspaceDeleteState.entryId, "saved-b");
assert.equal(workspaceDeleteState.phase, "choosing", "another record receives the one shared menu");
workspaceDeleteState = workspaceUi.transitionWorkspaceDelete(workspaceDeleteState, { type: "begin", scope: "local" });
assert.equal(workspaceDeleteState.phase, "deleting");
assert.equal(workspaceDeleteState.scope, "local");
assert.strictEqual(
  workspaceUi.transitionWorkspaceDelete(workspaceDeleteState, {
    type: "trigger",
    kind: "glossary",
    entryId: "sense-c",
  }),
  workspaceDeleteState,
  "a deleting state blocks another deletion trigger",
);
const hiddenBusyDelete = workspaceUi.transitionWorkspaceDelete(workspaceDeleteState, { type: "close" });
assert.equal(hiddenBusyDelete.phase, "deleting", "lifecycle cleanup keeps the mutation busy");
assert.equal(hiddenBusyDelete.menuOpen, false, "lifecycle cleanup hides the active menu");
assert.deepEqual(
  workspaceUi.transitionWorkspaceDelete(hiddenBusyDelete, { type: "settle" }),
  closedWorkspaceDelete,
  "success or failure settles the shared state",
);

assert.deepEqual([
  ["glossary", "local"],
  ["glossary", "global"],
  ["saved", "local"],
  ["saved", "global"],
].map(([kind, scope]) => workspaceUi.workspaceDeleteOperation(kind, scope)), [
  "unlinkGlossary",
  "deleteGlossary",
  "unlinkSaved",
  "deleteSaved",
]);
assert.equal(workspaceUi.workspaceDeleteOperation("saved", "unknown"), null);
assert.equal(workspaceUi.workspaceDeleteLocalAvailable("local", { attached: false }), true);
assert.equal(workspaceUi.workspaceDeleteLocalAvailable("global", { attached: true }), true);
assert.equal(workspaceUi.workspaceDeleteLocalAvailable("global", { attached: false }), false);
const activeDeleteCard = { dataset: { workspaceDeleteKind: "saved", workspaceDeleteId: "saved-b" } };
const otherDeleteCard = { dataset: { workspaceDeleteKind: "glossary", workspaceDeleteId: "sense-a" } };
assert.equal(workspaceUi.workspaceDeletePointerInside(workspaceDeleteState, [activeDeleteCard]), true);
assert.equal(workspaceUi.workspaceDeletePointerInside(workspaceDeleteState, [otherDeleteCard]), false);
assert.equal(workspaceUi.workspaceDeletePointerInside(closedWorkspaceDelete, [activeDeleteCard]), false);
assert.equal(workspaceUi.workspaceDeleteEntryPresent(workspaceDeleteState, [{ id: "saved-b" }]), true);
assert.equal(workspaceUi.workspaceDeleteEntryPresent(workspaceDeleteState, [{ id: "saved-other" }]), false);
assert.equal(workspaceUi.workspaceDeleteEntryPresent(closedWorkspaceDelete, []), true);

const deletionCalls = [];
const deletionClient = {
  unlinkGlossary(id) { deletionCalls.push(["unlinkGlossary", id]); },
  deleteGlossary(id) { deletionCalls.push(["deleteGlossary", id]); },
  unlinkSaved(id) { deletionCalls.push(["unlinkSaved", id]); },
  deleteSaved(id) { deletionCalls.push(["deleteSaved", id]); },
};
[
  ["glossary", "local", "sense-local"],
  ["glossary", "global", "sense-global"],
  ["saved", "local", "saved-local"],
  ["saved", "global", "saved-global"],
].forEach(([kind, scope, id]) => {
  const operation = workspaceUi.workspaceDeleteOperation(kind, scope);
  deletionClient[operation](id);
});
assert.deepEqual(deletionCalls, [
  ["unlinkGlossary", "sense-local"],
  ["deleteGlossary", "sense-global"],
  ["unlinkSaved", "saved-local"],
  ["deleteSaved", "saved-global"],
]);

for (const kind of ["glossary", "saved"]) {
  asyncBoundaryTests.push((async () => {
    let currentToken = 0;
    let resolveStale;
    const rendered = [];
    async function applyResult(token, promise) {
      const value = await promise;
      if (workspaceUi.isCurrentWorkspaceRequest(token, currentToken)) rendered.push(value);
    }
    const stale = applyResult(++currentToken, new Promise((resolve) => { resolveStale = resolve; }));
    const current = applyResult(++currentToken, Promise.resolve(`${kind}-current`));
    await current;
    resolveStale(`${kind}-stale`);
    await stale;
    assert.deepEqual(rendered, [`${kind}-current`], `${kind} ignores a stale query completion`);
  })());
}

const workspaceQueryMessages = [];
const workspaceClient = workspaceUi.createClient({
  getContext: () => ({ scopeKey: "stable:chatgpt.com:armed-global" }),
  getStatus: () => ({ status: "ready" }),
  async send(message) {
    workspaceQueryMessages.push(clone(message));
    return { ok: true, entries: [] };
  },
});
void workspaceClient.queryGlossary(workspaceUi.activeSearchMode("global", "q"), "q");
void workspaceClient.querySaved(workspaceUi.activeSearchMode("global", "q"), "q");
void workspaceClient.queryGlossary(workspaceUi.activeSearchMode("global", "   "), "   ");
void workspaceClient.querySaved(workspaceUi.activeSearchMode("global", "   "), "   ");
const structuredSavedText = "Paragraph\n\n1. Numbered\n• Bullet\n  indented";
void workspaceClient.saveSelection(structuredSavedText);
assert.equal(workspaceQueryMessages[0].mode, "global");
assert.equal(workspaceQueryMessages[1].mode, "global");
assert.equal(workspaceQueryMessages[2].mode, "global");
assert.equal(workspaceQueryMessages[3].mode, "global");
assert.equal(workspaceQueryMessages[4].text, structuredSavedText);
void workspaceClient.lookupGlossarySelection("State and OpenAPI");
assert.deepEqual(workspaceQueryMessages[5], {
  type: workspace.MESSAGE_TYPES.LOOKUP_GLOSSARY_SELECTION,
  conversationScope: "stable:chatgpt.com:armed-global",
  text: "State and OpenAPI",
});
assert.match(contentScriptSource, /await navigator\.clipboard\.writeText\(entry\.text\);/);
assert.doesNotMatch(contentScriptSource, /navigator\.clipboard\.writeText\([^)]*(?:innerText|textContent)/);
assert.match(contentScriptSource, /TEMPLATE_PREVIEW_OPEN_DELAY_MS = 350/);
assert.match(contentScriptSource, /TEMPLATE_PREVIEW_CLOSE_DELAY_MS = 120/);
assert.equal((contentScriptSource.match(/<aside class="template-preview"/g) || []).length, 1);
assert.match(contentScriptSource, /data-preview-source="main"/);
assert.match(contentScriptSource, /data-preview-source="recent"/);
assert.match(contentScriptSource, /class="template-preview-hotspot" data-preview-anchor data-preview-id=/);
assert.doesNotMatch(contentScriptSource, /class="template-summary" data-preview-/);
assert.match(contentScriptSource, /state\.previewContent\.textContent = template\.content/);
assert.doesNotMatch(contentScriptSource, /state\.previewContent\.innerHTML/);
assert.match(contentScriptSource, /white-space: pre-wrap/);
assert.match(contentScriptSource, /overflow-wrap: anywhere/);
assert.match(contentScriptSource, /patch: \{ layout: \{ sidebarWidth: width \} \}/);
assert.match(contentScriptSource, /state\.sidebarPreferredWidth = width/);
assert.match(contentScriptSource, /phase-revealing-opener \.panel-opener/);
assert.match(contentScriptSource, /\.phase-revealing-opener \.quick-action, \.phase-closed \.quick-action \{ opacity: 1; transform: scale\(1\); \}/);
assert.match(contentScriptSource, /\.phase-closed \.quick-action \{ pointer-events: auto; \}/);
assert.match(contentScriptSource, /\.motion-disabled \.quick-action \{ transition: none !important; \}/);
assert.match(contentScriptSource, /state\.quickAction\.tabIndex = quickActionState\.interactive \? 0 : -1/);
assert.match(contentScriptSource, /state\.quickAction\.setAttribute\("aria-hidden", quickActionState\.interactive \? "false" : "true"\)/);
assert.match(contentScriptSource, /state\.body\.addEventListener\("scroll", closeTemplatePreview/);
assert.match(contentScriptSource, /recent-templates-count/);
assert.match(contentScriptSource, /state\.settings\.recentTemplatesHoverEnabled\s*\?\s*'  <label class="setting-option recent-count-option"/);
assert.match(contentScriptSource, /--sidebar-motion-duration: 200ms/);
assert.match(contentScriptSource, /--sidebar-motion-easing: cubic-bezier\(\.22, \.8, \.25, 1\)/);
assert.match(contentScriptSource, /\.panel-opener \{[\s\S]*transition: transform var\(--sidebar-motion-duration\) var\(--sidebar-motion-easing\), background 120ms ease;/);
assert.match(contentScriptSource, /\.quick-action \{[\s\S]*transition: opacity var\(--sidebar-motion-duration\) var\(--sidebar-motion-easing\), transform var\(--sidebar-motion-duration\) var\(--sidebar-motion-easing\), background 120ms ease;/);
assert.match(contentScriptSource, /\.sidebar-frame \{[\s\S]*transform: translateX\(100%\);[\s\S]*transition: transform/);
assert.match(contentScriptSource, /\.shell\.phase-opening \.sidebar-frame, \.shell\.phase-open \.sidebar-frame \{ transform: translateX\(0\); \}/);
assert.match(contentScriptSource, /if \(!\["closed", "open"\]\.includes\(state\.shellPhase\)\) return;/);
assert.match(contentScriptSource, /state\.shellPhase !== "open" \|\| state\.sidebarResizing/);
const shellMarkupSource = contentScriptSource.slice(
  contentScriptSource.indexOf("function shellMarkup"),
  contentScriptSource.indexOf("function applyShellState"),
);
assert.match(shellMarkupSource, /class="shell theme-system phase-closed motion-disabled"/);
assert.equal((shellMarkupSource.match(/class="sidebar-frame"/g) || []).length, 1);
assert.equal(shellMarkupSource.indexOf("panel-resize") < shellMarkupSource.indexOf("<nav class=\"rail\""), true);
assert.equal(shellMarkupSource.indexOf("<nav class=\"rail\"") < shellMarkupSource.indexOf("<section class=\"panel\""), true);
const widthCommitSource = contentScriptSource.slice(
  contentScriptSource.indexOf("async function persistSidebarWidth"),
  contentScriptSource.indexOf("function installSidebarResizer"),
);
assert.equal((widthCommitSource.match(/SETTINGS_UPDATE/g) || []).length, 1);
assert.match(widthCommitSource, /patch: \{ layout: \{ sidebarWidth: width \} \}/);
const editorActionSource = contentScriptSource.slice(
  contentScriptSource.indexOf('else if (action === "add-template")'),
  contentScriptSource.indexOf('else if (action === "remove-wallpaper")'),
);
assert.doesNotMatch(editorActionSource, /SETTINGS_UPDATE|layout:/);
const previewLifecycleSource = contentScriptSource.slice(
  contentScriptSource.indexOf("function clearPreviewOpenTimer"),
  contentScriptSource.indexOf("function statusMarkup"),
);
assert.match(previewLifecycleSource, /setTimeout\(function openTemplatePreviewAfterDelay/);
assert.match(previewLifecycleSource, /setTimeout\(function closeTemplatePreviewAfterGrace/);
assert.match(previewLifecycleSource, /state\.templateTreeDrag\.draggingNodeId !== null/);
assert.match(previewLifecycleSource, /state\.editing\?\.id === templateId/);
assert.match(previewLifecycleSource, /state\.templateDeleteId === templateId/);
assert.match(previewLifecycleSource, /state\.folderDelete\.nodeId === templateId/);
assert.match(previewLifecycleSource, /workspaceUiModule\.previewAnchorFromTarget\(event\.target\)/);
assert.match(previewLifecycleSource, /state\.previewLayer\?\.contains\(event\.relatedTarget\)/);
assert.match(previewLifecycleSource, /scheduleTemplatePreview\(anchor, anchor\.dataset\.previewId, anchor\.dataset\.previewSource, true\)/);
const escapeLifecycleSource = contentScriptSource.slice(
  contentScriptSource.indexOf('document.addEventListener("keydown", function handleEscape'),
  contentScriptSource.indexOf('document.addEventListener("pointerdown", function handleOutsidePointer'),
);
assert.equal(escapeLifecycleSource.indexOf("state.analysisUi?.handleEscape()") < escapeLifecycleSource.indexOf("closeWorkspaceDeleteAndRender(true)"), true);
assert.equal(escapeLifecycleSource.indexOf("closeWorkspaceDeleteAndRender(true)") < escapeLifecycleSource.indexOf("closeTemplatePreview()"), true);
assert.equal(escapeLifecycleSource.indexOf("closeTemplatePreview()") < escapeLifecycleSource.indexOf("state.editing"), true);
assert.equal(escapeLifecycleSource.indexOf("state.editing") < escapeLifecycleSource.indexOf("closePanel(true)"), true);
assert.equal(
  escapeLifecycleSource.indexOf('state.folderDelete.phase === "confirm-subtree"')
    < escapeLifecycleSource.indexOf("dismissTemplateNodeDeleteAndRender()"),
  true,
  "Escape steps a subtree confirmation back to the delete choice before dismissing it",
);
assert.match(
  escapeLifecycleSource,
  /state\.templateDeleteId !== null \|\| state\.folderDelete\.nodeId !== null[\s\S]*dismissTemplateNodeDeleteAndRender\(\)/,
  "Escape dismissal restores the original delete trigger through the pending target",
);
assert.match(
  escapeLifecycleSource,
  /else if \(state\.editing\)[\s\S]*dismissTemplateEditorAndRender\(\)/,
  "Escape dismissal restores the original editor trigger through the pending target",
);
const outsideWorkspaceDeleteSource = contentScriptSource.slice(
  contentScriptSource.indexOf('document.addEventListener("pointerdown", function handleOutsidePointer'),
  contentScriptSource.indexOf('window.addEventListener("focus", function handleWindowFocus'),
);
assert.match(outsideWorkspaceDeleteSource, /workspaceDeleteMenuOpen\(state\.workspaceDelete\)/);
assert.match(outsideWorkspaceDeleteSource, /workspaceDeletePointerInside\(state\.workspaceDelete, path\)/);
assert.match(outsideWorkspaceDeleteSource, /setTimeout\(function renderAfterOutsidePointer/);
const workspaceDeleteMutationSource = contentScriptSource.slice(
  contentScriptSource.indexOf("async function deleteWorkspaceEntry"),
  contentScriptSource.indexOf("async function reorderGlossaryEntries"),
);
assert.match(workspaceDeleteMutationSource, /workspaceDeleteOperation\(kind, scope\)/);
assert.match(workspaceDeleteMutationSource, /state\.workspaceDelete\.phase !== "choosing"/);
assert.match(workspaceDeleteMutationSource, /\{ type: "begin", scope \}/);
assert.match(workspaceDeleteMutationSource, /await state\.workspaceClient\[operation\]\(id\)/);
assert.equal(
  workspaceDeleteMutationSource.indexOf('{ type: "begin", scope }')
    < workspaceDeleteMutationSource.indexOf("await state.workspaceClient[operation](id)"),
  true,
  "busy state is entered before the mutation can yield",
);
assert.doesNotMatch(workspaceDeleteMutationSource, /splice|filter|workspaceEntries\(kind\)\s*=/,
  "deletion does not optimistically remove a record");
const workspaceSearchInputSource = contentScriptSource.slice(
  contentScriptSource.indexOf("function onShadowInput"),
  contentScriptSource.indexOf("function onDragStart"),
);
assert.doesNotMatch(workspaceSearchInputSource, /glossaryRequestedMode\s*=/);
assert.doesNotMatch(workspaceSearchInputSource, /savedRequestedMode\s*=/);
assert.match(workspaceSearchInputSource, /closeWorkspaceDelete\(\)/);
for (const lifecycleSource of [
  "function startShellMotion",
  "function openSection",
  "function updateGlossaryEntries",
  "function updateSavedEntries",
  "function handleWorkspaceContextChange",
  "function handleWorkspaceStatusChange",
  "function mount",
]) {
  const start = contentScriptSource.indexOf(lifecycleSource);
  const nextFunction = contentScriptSource.indexOf("\n  function ", start + lifecycleSource.length);
  const nextAsyncFunction = contentScriptSource.indexOf("\n  async function ", start + lifecycleSource.length);
  const candidates = [nextFunction, nextAsyncFunction].filter((index) => index > start);
  const end = candidates.length ? Math.min(...candidates) : contentScriptSource.length;
  assert.match(contentScriptSource.slice(start, end), /closeWorkspaceDelete\(\)/, `${lifecycleSource} closes the shared menu`);
}

const unsafeSavedMarkup = workspaceUi.savedMarkup({
  savedRequestedMode: "local",
  savedSearch: "",
  savedEntries: [{ id: "unsafe", text: '<img src=x onerror="alert(1)">\nNext line', attached: true }],
});
assert.match(unsafeSavedMarkup, /&lt;img src=x onerror=&quot;alert\(1\)&quot;&gt;\nNext line/);
assert.equal(unsafeSavedMarkup.includes('<img src=x onerror="alert(1)">'), false);
assert.match(workspaceUi.styles(), /\.saved-text \{[^}]*white-space: pre-wrap;/);
const emptyGlobalSavedMarkup = workspaceUi.savedMarkup({
  savedRequestedMode: "global",
  savedSearch: "",
  savedEntries: [{ id: "hidden", text: "must not render" }],
});
assert.equal(emptyGlobalSavedMarkup.includes("must not render"), false);
assert.match(emptyGlobalSavedMarkup, /data-action="saved-mode-global" aria-pressed="true"/);
assert.match(emptyGlobalSavedMarkup, /Введите запрос для глобального поиска\./);
assert.equal(emptyGlobalSavedMarkup.includes("По глобальному запросу ничего не найдено."), false);
const emptyGlobalGlossaryMarkup = workspaceUi.glossaryMarkup({
  glossaryRequestedMode: "global",
  glossarySearch: "   ",
  glossaryEntries: [{ id: "hidden", term: "hidden", translation: "скрыто", definition: "Не показывать.", attached: true }],
  settings: { analysis: { glossaryTextSize: "normal" } },
  keyConfigured: true,
});
assert.equal(emptyGlobalGlossaryMarkup.includes("Не показывать."), false);
assert.match(emptyGlobalGlossaryMarkup, /Введите запрос для глобального поиска\./);
for (const zeroGlobalMarkup of [
  workspaceUi.glossaryMarkup({
    glossaryRequestedMode: "global",
    glossarySearch: "missing",
    glossaryEntries: [],
    settings: { analysis: { glossaryTextSize: "normal" } },
    keyConfigured: true,
  }),
  workspaceUi.savedMarkup({
    savedRequestedMode: "global",
    savedSearch: "missing",
    savedEntries: [],
  }),
]) {
  assert.match(zeroGlobalMarkup, /По глобальному запросу ничего не найдено\./);
  assert.equal(zeroGlobalMarkup.includes("Введите запрос для глобального поиска."), false);
}
const localGlossaryMarkup = workspaceUi.glossaryMarkup({
  glossaryRequestedMode: "local",
  glossarySearch: "",
  glossaryEntries: [{ id: "sense", term: "state", translation: "состояние", definition: "Описание.", attached: true }],
  settings: { analysis: { glossaryTextSize: "normal" } },
  keyConfigured: true,
});
assert.match(localGlossaryMarkup, /draggable="true"/);
assert.equal((localGlossaryMarkup.match(/data-action="workspace-delete-toggle"/g) || []).length, 1);
assert.match(localGlossaryMarkup, /title="Удалить запись" aria-label="Удалить запись" aria-expanded="false"/);
assert.doesNotMatch(localGlossaryMarkup, /Убрать из чата|Удалить глобально во всех чатах/);
assert.equal(localGlossaryMarkup.includes("OpenRouter"), false);
const localGlossaryDeleteMenu = workspaceUi.glossaryMarkup({
  glossaryRequestedMode: "local",
  glossarySearch: "",
  workspaceDelete: workspaceUi.transitionWorkspaceDelete(
    workspaceUi.closedWorkspaceDeleteState(),
    { type: "trigger", kind: "glossary", entryId: "sense" },
  ),
  glossaryEntries: [{ id: "sense", term: "state", translation: "состояние", definition: "Описание.", attached: true }],
  settings: { analysis: { glossaryTextSize: "normal" } },
  keyConfigured: true,
});
assert.match(localGlossaryDeleteMenu, /data-action="workspace-delete-local"[^>]*aria-label="Удалить только из этого чата">Из чата/);
const armedGlobalGlossaryMarkup = workspaceUi.glossaryMarkup({
  glossaryRequestedMode: "global",
  glossarySearch: "",
  glossaryEntries: [{ id: "sense", term: "state", translation: "состояние", definition: "Описание.", attached: true }],
  settings: { analysis: { glossaryTextSize: "normal" } },
  keyConfigured: true,
});
assert.match(armedGlobalGlossaryMarkup, /data-action="glossary-mode-global" aria-pressed="true"/);
assert.equal(armedGlobalGlossaryMarkup.includes('draggable="true"'), false);
assert.equal(armedGlobalGlossaryMarkup.includes("Описание."), false);
assert.match(armedGlobalGlossaryMarkup, /Введите запрос для глобального поиска\./);
const globalGlossaryMarkup = workspaceUi.glossaryMarkup({
  glossaryRequestedMode: "global",
  glossarySearch: "state",
  glossaryEntries: [{ id: "sense", term: "state", translation: "состояние", definition: "Описание.", attached: false }],
  settings: { analysis: { glossaryTextSize: "normal" } },
  keyConfigured: true,
});
assert.equal(globalGlossaryMarkup.includes('draggable="true"'), false);
assert.match(globalGlossaryMarkup, /data-action="attach-glossary"/);
assert.match(globalGlossaryMarkup, /data-action="workspace-delete-toggle"/);
const choosingGlobalGlossaryDelete = workspaceUi.transitionWorkspaceDelete(
  workspaceUi.closedWorkspaceDeleteState(),
  { type: "trigger", kind: "glossary", entryId: "sense" },
);
const unattachedGlobalGlossaryMenu = workspaceUi.glossaryMarkup({
  glossaryRequestedMode: "global",
  glossarySearch: "state",
  workspaceDelete: choosingGlobalGlossaryDelete,
  glossaryEntries: [{ id: "sense", term: "state", translation: "состояние", definition: "Описание.", attached: false }],
  settings: { analysis: { glossaryTextSize: "normal" } },
  keyConfigured: true,
});
assert.equal((unattachedGlobalGlossaryMenu.match(/class="workspace-delete-menu"/g) || []).length, 1);
assert.match(unattachedGlobalGlossaryMenu, />Удалить запись</);
assert.match(unattachedGlobalGlossaryMenu, /data-action="workspace-delete-local"[^>]*title="Запись не добавлена в этот чат"[^>]*aria-label="Запись не добавлена в этот чат" disabled>Из чата/);
assert.match(unattachedGlobalGlossaryMenu, /data-action="workspace-delete-global"[^>]*aria-label="Удалить запись везде">Везде/);
const attachedGlobalGlossaryMenu = workspaceUi.glossaryMarkup({
  glossaryRequestedMode: "global",
  glossarySearch: "state",
  workspaceDelete: choosingGlobalGlossaryDelete,
  glossaryEntries: [{ id: "sense", term: "state", translation: "состояние", definition: "Описание.", attached: true }],
  settings: { analysis: { glossaryTextSize: "normal" } },
  keyConfigured: true,
});
assert.match(attachedGlobalGlossaryMenu, /Уже в этом чате/);
assert.match(attachedGlobalGlossaryMenu, /data-action="workspace-delete-local"[^>]*aria-label="Удалить только из этого чата">Из чата/);
const localSavedMarkup = workspaceUi.savedMarkup({
  savedRequestedMode: "local",
  savedSearch: "",
  savedEntries: [{ id: "saved", text: "Text", attached: true }],
});
assert.equal((localSavedMarkup.match(/data-action="copy-saved"/g) || []).length, 1);
assert.match(localSavedMarkup, /class="icon-button workspace-copy-button"/);
assert.match(localSavedMarkup, /title="Скопировать сохранённый текст" aria-label="Скопировать сохранённый текст"/);
assert.match(localSavedMarkup, /class="workspace-card-footer saved-card-footer">.*data-action="copy-saved".*class="workspace-card-actions">.*data-action="workspace-delete-toggle"/);
assert.doesNotMatch(localSavedMarkup, /Убрать из чата|unlink-saved|ask-global-saved-delete/);
const localSavedDeleteMenu = workspaceUi.savedMarkup({
  savedRequestedMode: "local",
  savedSearch: "",
  workspaceDelete: workspaceUi.transitionWorkspaceDelete(
    workspaceUi.closedWorkspaceDeleteState(),
    { type: "trigger", kind: "saved", entryId: "saved" },
  ),
  savedEntries: [{ id: "saved", text: "Text", attached: true }],
});
assert.match(localSavedDeleteMenu, /data-action="workspace-delete-local"[^>]*aria-label="Удалить только из этого чата">Из чата/);
const choosingGlobalSavedDelete = workspaceUi.transitionWorkspaceDelete(
  workspaceUi.closedWorkspaceDeleteState(),
  { type: "trigger", kind: "saved", entryId: "saved" },
);
const globalSavedMarkup = workspaceUi.savedMarkup({
  savedRequestedMode: "global",
  savedSearch: "text",
  workspaceDelete: choosingGlobalSavedDelete,
  savedEntries: [{ id: "saved", text: "Text", attached: false }],
});
assert.equal((globalSavedMarkup.match(/data-action="copy-saved"/g) || []).length, 1);
assert.match(globalSavedMarkup, /class="workspace-card-footer saved-card-footer">.*data-action="copy-saved".*class="workspace-card-actions">.*data-action="attach-saved".*data-action="workspace-delete-toggle"/);
assert.equal((globalSavedMarkup.match(/class="workspace-delete-menu"/g) || []).length, 1);
assert.match(globalSavedMarkup, /data-action="workspace-delete-local"[^>]*disabled>Из чата/);
assert.match(globalSavedMarkup, /data-action="workspace-delete-global"[^>]*>Везде/);
const attachedGlobalSavedMarkup = workspaceUi.savedMarkup({
  savedRequestedMode: "global",
  savedSearch: "text",
  workspaceDelete: choosingGlobalSavedDelete,
  savedEntries: [{ id: "saved", text: "Text", attached: true }],
});
assert.match(attachedGlobalSavedMarkup, /Уже в этом чате/);
assert.match(attachedGlobalSavedMarkup, /data-action="workspace-delete-local"[^>]*aria-label="Удалить только из этого чата">Из чата/);
assert.equal(workspaceUi.glossaryMarkup({
  glossaryRequestedMode: "local",
  glossarySearch: "",
  workspaceDelete: choosingGlobalSavedDelete,
  glossaryEntries: [{ id: "sense", term: "state", translation: "состояние", definition: "Описание.", attached: true }],
  settings: { analysis: { glossaryTextSize: "normal" } },
  keyConfigured: true,
}).includes('class="workspace-delete-menu"'), false, "one shared state cannot render a second kind's menu");
const deletingSavedMarkup = workspaceUi.savedMarkup({
  savedRequestedMode: "local",
  savedSearch: "",
  workspaceDelete: workspaceUi.transitionWorkspaceDelete(choosingGlobalSavedDelete, { type: "begin", scope: "global" }),
  savedEntries: [{ id: "saved", text: "Text", attached: true }, { id: "saved-other", text: "Other", attached: true }],
});
assert.equal((deletingSavedMarkup.match(/data-action="workspace-delete-toggle"[^>]* disabled/g) || []).length, 2);
assert.equal((deletingSavedMarkup.match(/data-action="workspace-delete-(?:local|global)"[^>]* disabled/g) || []).length, 2);
assert.match(workspaceUi.styles(), /\.workspace-copy-button\.is-copied/);
assert.match(workspaceUi.styles(), /\.workspace-trash-button/);
assert.match(workspaceUi.styles(), /\.workspace-delete-menu/);
const unavailableGlossaryMarkup = workspaceUi.glossaryMarkup({
  workspaceStatus: { status: "unavailable", message: "Данные словаря V1 не удалены. Новые изменения Workspace не применены." },
  glossaryRequestedMode: "local",
  glossarySearch: "",
  glossaryEntries: [],
  settings: { analysis: { glossaryTextSize: "normal" } },
  keyConfigured: true,
});
assert.match(unavailableGlossaryMarkup, /Workspace недоступен/);
assert.match(unavailableGlossaryMarkup, /Данные словаря V1 не удалены/);
assert.equal(unavailableGlossaryMarkup.includes("OpenRouter"), false);
assert.equal(unavailableGlossaryMarkup.includes("В этом чате пока нет терминов"), false);
const missingKeyGlossaryMarkup = workspaceUi.glossaryMarkup({
  glossaryRequestedMode: "local",
  glossarySearch: "",
  glossaryEntries: [],
  settings: { analysis: { glossaryTextSize: "normal" } },
  keyChecking: false,
  keyConfigured: false,
});
assert.match(missingKeyGlossaryMarkup, /OpenRouter не подключён/);
assert.match(missingKeyGlossaryMarkup, /data-action="open-analysis-options"/);
const checkingKeyGlossaryMarkup = workspaceUi.glossaryMarkup({
  glossaryRequestedMode: "local",
  glossarySearch: "",
  glossaryEntries: [],
  settings: { analysis: { glossaryTextSize: "normal" } },
  keyChecking: true,
  keyConfigured: false,
});
assert.equal(checkingKeyGlossaryMarkup.includes("OpenRouter"), false);
const unavailableSavedMarkup = workspaceUi.savedMarkup({
  workspaceStatus: { status: "unavailable", message: "Данные словаря V1 не удалены. Новые изменения Workspace не применены." },
  savedRequestedMode: "local",
  savedSearch: "",
  savedEntries: [],
});
assert.match(unavailableSavedMarkup, /Workspace недоступен/);
assert.equal(unavailableSavedMarkup.includes("В этом чате пока нет сохранённого текста"), false);

{
  let inputEvents = 0;
  let clicks = 0;
  let composerAvailable = true;
  let sendButtonAvailable = true;
  let clearComposerOnSend = true;
  let forcedReadbackText = null;
  class FakeTextarea {
    constructor() {
      this.tagName = "TEXTAREA";
      this.isConnected = true;
      this._value = "A\n \n\t\nB";
      this.selectionStart = this._value.length;
      this.selectionEnd = this._value.length;
    }
    get value() { return this._value; }
    set value(value) { this._value = value; }
    getBoundingClientRect() { return { width: 300, height: 80 }; }
    dispatchEvent(event) {
      if (event.type === "input") {
        inputEvents += 1;
        if (typeof forcedReadbackText === "string") this._value = forcedReadbackText;
      }
      return true;
    }
    setSelectionRange(start, end) { this.selectionStart = start; this.selectionEnd = end; }
    contains(target) { return target === this; }
    closest(selector) { return selector === "form" ? form : null; }
  }
  const textarea = new FakeTextarea();
  const sendButton = {
    isConnected: true,
    disabled: false,
    dataset: { testid: "send-button" },
    textContent: "Send",
    getBoundingClientRect() { return { width: 30, height: 30 }; },
    getAttribute(name) {
      if (name === "aria-label") return "Send message";
      if (name === "aria-disabled") return "false";
      return null;
    },
    click() {
      clicks += 1;
      if (clearComposerOnSend) textarea.value = "";
    },
  };
  const form = { querySelectorAll() { return sendButtonAvailable ? [sendButton] : []; } };
  const windowObject = {
    ChatGPTHelperWorkspaceContract: workspace,
    HTMLTextAreaElement: FakeTextarea,
    getComputedStyle() { return { display: "block", visibility: "visible" }; },
    getSelection() { return null; },
  };
  const documentObject = {
    activeElement: textarea,
    querySelectorAll() { return composerAvailable ? [textarea] : []; },
    createRange() { throw new Error("textarea normalization must not use a DOM range"); },
  };
  class FakeEvent { constructor(type) { this.type = type; } }
  const context = vm.createContext({
    window: windowObject,
    document: documentObject,
    Event: FakeEvent,
    InputEvent: FakeEvent,
    Node: { TEXT_NODE: 3 },
    NodeFilter: { SHOW_TEXT: 4 },
    setTimeout(callback) { callback(); return 0; },
    clearTimeout,
  });
  vm.runInContext(fs.readFileSync(path.join(__dirname, "../src/chatgpt-dom.js"), "utf8"), context);
  const normalized = windowObject.ChatGPTTemplateDom.normalizeComposer({ requireFocus: true });
  assert.deepEqual({ ok: normalized.ok, changed: normalized.changed, text: normalized.text }, {
    ok: true,
    changed: true,
    text: "A\n\nB",
  });
  assert.equal(textarea.value, "A\n\nB");
  assert.equal(inputEvents, 1);
  assert.equal(clicks, 0);
  assert.equal(windowObject.ChatGPTTemplateDom.normalizeComposer({ requireFocus: true }).changed, false);
  assert.equal(inputEvents, 1);
  textarea.value = "A\n\n\nB";
  documentObject.activeElement = {};
  assert.equal(windowObject.ChatGPTTemplateDom.normalizeComposer({ requireFocus: true }).ok, false);
  assert.equal(textarea.value, "A\n\n\nB");
  documentObject.activeElement = textarea;
  asyncBoundaryTests.push((async () => {
    const cases = [
      { existing: "", template: "One line", expected: "One line" },
      { existing: "", template: "First\nSecond", expected: "First\nSecond" },
      { existing: "", template: "  A\n\n\n\tB  ", expected: "  A\n\n\n\tB  " },
      { existing: "Existing", template: "One line", expected: "Existing\n\nOne line" },
      { existing: "Existing\nline", template: "First\nSecond", expected: "Existing\nline\n\nFirst\nSecond" },
    ];
    for (const scenario of cases) {
      for (const autoSend of [false, true]) {
        textarea.value = scenario.existing;
        textarea.selectionStart = scenario.existing.length;
        textarea.selectionEnd = scenario.existing.length;
        clearComposerOnSend = true;
        forcedReadbackText = null;
        const beforeClicks = clicks;
        const result = await windowObject.ChatGPTTemplateDom.executeTemplate(scenario.template, autoSend);
        assert.equal(result.ok, true);
        assert.equal(result.inserted, true);
        assert.equal(result.unchanged, false);
        assert.equal(result.failed, false);
        assert.equal(result.verified, true);
        assert.equal(result.verificationFailed, false);
        assert.equal(result.sendAttempted, autoSend);
        assert.equal(result.sent, autoSend);
        assert.equal(result.sendFailed, false);
        assert.equal(result.text, scenario.expected);
        assert.equal(textarea.value, autoSend ? "" : scenario.expected);
        assert.equal(clicks - beforeClicks, autoSend ? 1 : 0);
      }
    }

    textarea.value = "";
    clearComposerOnSend = false;
    const sendFailed = await windowObject.ChatGPTTemplateDom.executeTemplate("Send failure", true);
    assert.equal(sendFailed.inserted, true);
    assert.equal(sendFailed.failed, false);
    assert.equal(sendFailed.sendAttempted, true);
    assert.equal(sendFailed.sent, false);
    assert.equal(sendFailed.sendFailed, true);
    assert.match(sendFailed.error, /Шаблон вставлен/);
    assert.doesNotMatch(sendFailed.error, /Не удалось вставить/);

    textarea.value = "";
    clearComposerOnSend = true;
    forcedReadbackText = "Framework-adjusted value";
    const clicksBeforeVerification = clicks;
    const unverified = await windowObject.ChatGPTTemplateDom.executeTemplate("Written value", true);
    assert.equal(unverified.ok, true);
    assert.equal(unverified.inserted, true);
    assert.equal(unverified.failed, false);
    assert.equal(unverified.verified, false);
    assert.equal(unverified.verificationFailed, true);
    assert.equal(unverified.sendAttempted, false);
    assert.equal(unverified.sendFailed, false);
    assert.equal(clicks, clicksBeforeVerification);
    assert.doesNotMatch(unverified.error, /Не удалось вставить/);
    forcedReadbackText = null;

    composerAvailable = false;
    const insertionFailed = await windowObject.ChatGPTTemplateDom.executeTemplate("Cannot write", false);
    assert.equal(insertionFailed.ok, false);
    assert.equal(insertionFailed.inserted, false);
    assert.equal(insertionFailed.failed, true);
    assert.equal(insertionFailed.sendAttempted, false);

    const quickInsertionFailed = await windowObject.ChatGPTTemplateDom.executeNextQuickAction();
    assert.equal(quickInsertionFailed.ok, false);
    assert.equal(quickInsertionFailed.inserted, false);
    assert.equal(quickInsertionFailed.failed, true);
    assert.equal(quickInsertionFailed.verificationFailed, false);
    assert.equal(quickInsertionFailed.sendAttempted, false);
    assert.equal(quickInsertionFailed.sendFailed, false);

    composerAvailable = true;
    sendButtonAvailable = true;

    textarea.value = "";
    clearComposerOnSend = true;
    forcedReadbackText = null;
    const clicksBeforeQuickSuccess = clicks;
    const quickSuccess = await windowObject.ChatGPTTemplateDom.executeNextQuickAction();
    assert.equal(quickSuccess.ok, true);
    assert.equal(quickSuccess.inserted, true);
    assert.equal(quickSuccess.failed, false);
    assert.equal(quickSuccess.verified, true);
    assert.equal(quickSuccess.verificationFailed, false);
    assert.equal(quickSuccess.sendAttempted, true);
    assert.equal(quickSuccess.sent, true);
    assert.equal(quickSuccess.sendFailed, false);
    assert.equal(clicks - clicksBeforeQuickSuccess, 1);

    textarea.value = "";
    clearComposerOnSend = true;
    forcedReadbackText = "Framework-adjusted quick value";
    const clicksBeforeQuickVerification = clicks;
    const quickUnverified = await windowObject.ChatGPTTemplateDom.executeNextQuickAction();
    assert.equal(quickUnverified.ok, true);
    assert.equal(quickUnverified.inserted, true);
    assert.equal(quickUnverified.failed, false);
    assert.equal(quickUnverified.verified, false);
    assert.equal(quickUnverified.verificationFailed, true);
    assert.equal(quickUnverified.sendAttempted, false);
    assert.equal(quickUnverified.sent, false);
    assert.equal(quickUnverified.sendFailed, false);
    assert.equal(clicks, clicksBeforeQuickVerification);

    textarea.value = "";
    clearComposerOnSend = false;
    forcedReadbackText = null;
    const quickSendFailed = await windowObject.ChatGPTTemplateDom.executeNextQuickAction();
    assert.equal(quickSendFailed.ok, true);
    assert.equal(quickSendFailed.inserted, true);
    assert.equal(quickSendFailed.failed, false);
    assert.equal(quickSendFailed.verified, true);
    assert.equal(quickSendFailed.sendAttempted, true);
    assert.equal(quickSendFailed.sent, false);
    assert.equal(quickSendFailed.sendFailed, true);
    assert.match(quickSendFailed.error, /Шаблон вставлен/);

    textarea.value = "Existing composer text";
    const clicksBeforeQuickNoop = clicks;
    const quickNoop = await windowObject.ChatGPTTemplateDom.executeNextQuickAction();
    assert.equal(quickNoop.ok, true);
    assert.equal(quickNoop.noop, true);
    assert.equal(textarea.value, "Existing composer text");
    assert.equal(clicks, clicksBeforeQuickNoop);
  })());
}

{
  let inputEvents = 0;
  let activeRange = null;
  class FakeNode {
    constructor(type) {
      this.nodeType = type;
      this.childNodes = [];
      this.parentNode = null;
      this.isConnected = true;
    }
    appendChild(node) {
      node.parentNode = this;
      this.childNodes.push(node);
      return node;
    }
    contains(target) {
      return target === this || this.childNodes.some((child) => child.contains?.(target));
    }
    get textContent() { return this.childNodes.map((child) => child.textContent || "").join(""); }
  }
  class FakeText extends FakeNode {
    constructor(data) { super(3); this.data = data; }
    get textContent() { return this.data; }
  }
  class FakeElement extends FakeNode {
    constructor(tagName) { super(1); this.tagName = tagName.toUpperCase(); this.attributes = {}; }
    get innerText() {
      if (this.tagName === "DIV") return this.childNodes.map((child) => child.textContent || "").join("\n\n");
      return this.textContent;
    }
    getBoundingClientRect() { return { width: 300, height: 80 }; }
    replaceChildren(fragment) {
      this.childNodes = fragment.childNodes.slice();
      this.childNodes.forEach((child) => { child.parentNode = this; });
    }
    dispatchEvent(event) { if (event.type === "input") inputEvents += 1; return true; }
    focus() { documentObject.activeElement = this; }
    closest() { return null; }
    getAttribute(name) { return Object.prototype.hasOwnProperty.call(this.attributes, name) ? this.attributes[name] : null; }
    setAttribute(name, value) { this.attributes[name] = String(value); }
  }
  class FakeRange {
    selectNodeContents() {}
    setEnd(container, offset) { this.endContainer = container; this.endOffset = offset; }
    setStart(container, offset) { this.startContainer = container; this.startOffset = offset; }
    cloneContents() { return this.fragment || new FakeNode(11); }
    toString() { return ""; }
  }
  const editor = new FakeElement("div");
  const selectionObject = {
    get rangeCount() { return activeRange ? 1 : 0; },
    getRangeAt() { return activeRange; },
    removeAllRanges() { activeRange = null; },
    addRange(range) { activeRange = range; },
  };
  const documentObject = {
    activeElement: editor,
    querySelectorAll() { return [editor]; },
    createDocumentFragment() { return new FakeNode(11); },
    createElement(tagName) { return new FakeElement(tagName); },
    createTextNode(text) { return new FakeText(text); },
    createTreeWalker(root) {
      const nodes = [];
      const visit = (node) => {
        if (node.nodeType === 3) nodes.push(node);
        else node.childNodes.forEach(visit);
      };
      visit(root);
      let index = 0;
      return { nextNode() { return nodes[index++] || null; } };
    },
    createRange() { return new FakeRange(); },
  };
  const windowObject = {
    ChatGPTHelperWorkspaceContract: workspace,
    HTMLTextAreaElement: class FakeTextarea {},
    getComputedStyle() { return { display: "block", visibility: "visible" }; },
    getSelection() { return selectionObject; },
  };
  class FakeEvent { constructor(type) { this.type = type; } }
  const context = vm.createContext({
    window: windowObject,
    document: documentObject,
    Event: FakeEvent,
    InputEvent: FakeEvent,
    NodeFilter: { SHOW_TEXT: 4 },
    setTimeout,
    clearTimeout,
  });
  vm.runInContext(fs.readFileSync(path.join(__dirname, "../src/chatgpt-dom.js"), "utf8"), context);

  function setEditorBlocks(blocks) {
    const fragment = new FakeNode(11);
    blocks.forEach(({ tag = "p", text = "" }) => {
      const block = new FakeElement(tag);
      if (text) block.appendChild(new FakeText(text));
      else block.appendChild(new FakeElement("br"));
      fragment.appendChild(block);
    });
    editor.replaceChildren(fragment);
  }

  function setEditorLines(lines) {
    setEditorBlocks(lines.map((text) => ({ tag: "p", text })));
  }

  function setSelection(startContainer, startOffset, endContainer = startContainer, endOffset = startOffset) {
    const range = new FakeRange();
    range.setStart(startContainer, startOffset);
    range.setEnd(endContainer, endOffset);
    activeRange = range;
  }

  function selectionNode(tag, children, attributes) {
    const node = new FakeElement(tag);
    Object.entries(attributes || {}).forEach(([name, value]) => node.setAttribute(name, value));
    (children || []).forEach((child) => node.appendChild(typeof child === "string" ? new FakeText(child) : child));
    return node;
  }

  function readSelectionFragment(nodes, fallback = "") {
    const fragment = new FakeNode(11);
    nodes.forEach((node) => fragment.appendChild(typeof node === "string" ? new FakeText(node) : node));
    const range = new FakeRange();
    range.fragment = fragment;
    activeRange = range;
    return windowObject.ChatGPTTemplateDom.readSelectionText(fallback);
  }

  assert.equal(readSelectionFragment(["One line"]), "One line");
  assert.equal(readSelectionFragment([
    selectionNode("div", ["Adjacent"]),
    selectionNode("div", ["line"]),
  ], "Adjacent line"), "Adjacent\nline");
  assert.equal(readSelectionFragment([selectionNode("div", ["Current selection"])], "Immutable snapshot"), "Immutable snapshot");
  assert.equal(readSelectionFragment([
    selectionNode("p", ["First paragraph"]),
    selectionNode("p", [selectionNode("strong", ["Second"]), " paragraph"]),
  ]), "First paragraph\n\nSecond paragraph");
  assert.equal(readSelectionFragment([
    selectionNode("div", ["Before"]),
    selectionNode("div", [selectionNode("br")]),
    selectionNode("div", ["After"]),
  ]), "Before\n\nAfter");
  assert.equal(readSelectionFragment([
    selectionNode("ol", [
      selectionNode("li", ["Numbered one"]),
      selectionNode("li", ["Numbered two", selectionNode("ul", [
        selectionNode("li", ["Nested bullet"]),
      ])]),
    ], { start: 3 }),
  ]), "3. Numbered one\n4. Numbered two\n  • Nested bullet");
  const sourceOrderedList = selectionNode("ol", [
    selectionNode("li", ["First"]),
    selectionNode("li", ["Second"]),
    selectionNode("li", ["Third"]),
  ], { start: 3 });
  const partialOrderedFragment = new FakeNode(11);
  partialOrderedFragment.appendChild(selectionNode("ol", [selectionNode("li", ["Third"])]));
  const partialOrderedRange = new FakeRange();
  partialOrderedRange.startContainer = sourceOrderedList.childNodes[2].childNodes[0];
  partialOrderedRange.fragment = partialOrderedFragment;
  activeRange = partialOrderedRange;
  assert.equal(windowObject.ChatGPTTemplateDom.readSelectionText("Third"), "5. Third");
  assert.equal(readSelectionFragment([
    selectionNode("pre", ["  indented\n    code"]),
  ]), "  indented\n    code");

  function pointSignature(container, offset) {
    if (container === editor) return `editor:${offset}`;
    let topLevel = container;
    while (topLevel?.parentNode && topLevel.parentNode !== editor) topLevel = topLevel.parentNode;
    const lineIndex = editor.childNodes.indexOf(topLevel);
    if (container.nodeType === 3) return `line:${lineIndex}:text:${offset}`;
    return `line:${lineIndex}:${container.tagName || container.nodeType}:${offset}`;
  }

  const roundTripCases = [
    "A\nB",
    "A\n\nB",
    "\nA",
    "A\n",
    "\nA\n",
    "A\n\n",
  ];
  roundTripCases.forEach((text) => {
    const write = windowObject.ChatGPTTemplateDom.replaceComposerText(text, { start: text.length, end: text.length });
    assert.equal(write.ok, true);
    assert.equal(windowObject.ChatGPTTemplateDom.readComposer().text, text, `contenteditable round-trip for ${JSON.stringify(text)}`);
  });

  setEditorBlocks([{ tag: "p", text: "A" }, { tag: "div", text: "B" }]);
  assert.equal(editor.innerText, "A\n\nB", "the fake models Chromium-style rendered block separation");
  assert.equal(windowObject.ChatGPTTemplateDom.readComposer().text, "A\nB");
  assert.equal(windowObject.ChatGPTTemplateDom.normalizeComposer({ requireFocus: true }).changed, false);
  assert.equal(editor.childNodes.length, 2, "canonical adjacent blocks are not rewritten into a blank line");

  const selectionCases = [
    {
      name: "editor offset zero",
      select() { setSelection(editor, 0); },
      expectedStart: "line:0:text:0",
      expectedEnd: "line:0:text:0",
    },
    {
      name: "intermediate child boundary",
      select() { setSelection(editor, 1); },
      expectedStart: "line:1:P:0",
      expectedEnd: "line:1:P:0",
    },
    {
      name: "blank block",
      select() { setSelection(editor.childNodes[1], 0); },
      expectedStart: "line:1:P:0",
      expectedEnd: "line:1:P:0",
    },
    {
      name: "final boundary",
      select() { setSelection(editor, editor.childNodes.length); },
      expectedStart: "line:2:text:1",
      expectedEnd: "line:2:text:1",
    },
    {
      name: "selection across blocks",
      select() { setSelection(editor, 1, editor, editor.childNodes.length); },
      expectedStart: "line:1:P:0",
      expectedEnd: "line:2:text:1",
    },
  ];
  selectionCases.forEach((scenario) => {
    setEditorLines(["A", "", "", "B"]);
    scenario.select();
    const normalized = windowObject.ChatGPTTemplateDom.normalizeComposer({ requireFocus: true });
    assert.equal(normalized.ok, true, scenario.name);
    assert.equal(normalized.changed, true, scenario.name);
    assert.equal(normalized.text, "A\n\nB", scenario.name);
    assert.equal(windowObject.ChatGPTTemplateDom.readComposer().text, "A\n\nB", scenario.name);
    assert.equal(pointSignature(activeRange.startContainer, activeRange.startOffset), scenario.expectedStart, scenario.name);
    assert.equal(pointSignature(activeRange.endContainer, activeRange.endOffset), scenario.expectedEnd, scenario.name);
  });
  assert.equal(windowObject.ChatGPTTemplateDom.normalizeComposer({ requireFocus: true }).changed, false);
  assert.equal(editor.childNodes.length, 3);
  assert.equal(editor.childNodes[1].childNodes[0].tagName, "BR");
  assert.equal(inputEvents > 0, true);

  asyncBoundaryTests.push((async () => {
    const cases = [
      { existingLines: [""], template: "One line", expected: "One line" },
      { existingLines: [""], template: "First\nSecond", expected: "First\nSecond" },
      { existingLines: ["Existing"], template: "One line", expected: "Existing\n\nOne line" },
      { existingLines: ["Existing", "line"], template: "First\nSecond", expected: "Existing\nline\n\nFirst\nSecond" },
    ];
    for (const scenario of cases) {
      setEditorLines(scenario.existingLines);
      setSelection(editor, editor.childNodes.length);
      const result = await windowObject.ChatGPTTemplateDom.executeTemplate(scenario.template, false);
      assert.equal(result.ok, true);
      assert.equal(result.inserted, true);
      assert.equal(result.failed, false);
      assert.equal(result.verified, true);
      assert.equal(result.verificationFailed, false);
      assert.equal(result.sendAttempted, false);
      assert.equal(result.text, scenario.expected);
      assert.equal(windowObject.ChatGPTTemplateDom.readComposer().text, scenario.expected);
    }
  })());
}

assert.deepEqual(workspace.createInvalidation("glossary", "stable:chatgpt.com:abc", 3), {
  entityFamily: "glossary",
  conversationScope: "stable:chatgpt.com:abc",
  revision: 3,
});
assert.equal(workspace.validateInvalidation({
  entityFamily: "glossary",
  conversationScope: "stable:chatgpt.com:abc",
  revision: 3,
  dataset: [],
}), false);

function createInstrumentedDatabase(initialState) {
  const definitions = workspace.STORE_DEFINITIONS;
  const data = {};
  const instrumentation = { transactions: [], calls: [] };
  Object.keys(definitions).forEach((name) => {
    data[name] = new Map();
    (initialState?.[name] || []).forEach((record) => {
      data[name].set(record[definitions[name].keyPath], clone(record));
    });
  });

  function equalKey(left, right) {
    return JSON.stringify(left) === JSON.stringify(right);
  }

  function indexKey(record, keyPath) {
    return Array.isArray(keyPath) ? keyPath.map((key) => record[key]) : record[keyPath];
  }

  function compareKey(left, right) {
    if (Array.isArray(left) && Array.isArray(right)) {
      for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
        if (left[index] === right[index]) continue;
        if (left[index] === undefined) return -1;
        if (right[index] === undefined) return 1;
        return compareKey(left[index], right[index]);
      }
      return 0;
    }
    if (left === right) return 0;
    return left < right ? -1 : 1;
  }

  function matchesQuery(key, query) {
    if (query === null || query === undefined) return true;
    if (query && Array.isArray(query.lower) && Array.isArray(query.upper)) {
      return Array.isArray(key) && key[0] === query.lower[0];
    }
    return equalKey(key, query);
  }

  function transaction(storeNames, mode) {
    const names = [...storeNames];
    const working = Object.fromEntries(names.map((name) => [name, new Map(
      [...data[name].entries()].map(([key, value]) => [key, clone(value)]),
    )]));
    const record = { storeNames: names, mode };
    instrumentation.transactions.push(record);
    let pending = 0;
    let completionTimer = null;
    let aborted = false;
    let completed = false;

    const tx = {
      error: null,
      oncomplete: null,
      onabort: null,
      onerror: null,
      objectStore(name) {
        if (!working[name]) throw new Error(`Store ${name} is outside this transaction.`);
        return makeStore(name);
      },
      abort() {
        if (aborted || completed) return;
        aborted = true;
        clearTimeout(completionTimer);
        setTimeout(() => tx.onabort?.(), 0);
      },
    };

    function scheduleComplete() {
      clearTimeout(completionTimer);
      completionTimer = setTimeout(() => {
        if (aborted || completed || pending) return;
        completed = true;
        if (mode === "readwrite") names.forEach((name) => { data[name] = working[name]; });
        tx.oncomplete?.();
      }, 0);
    }

    function beginRequest() {
      pending += 1;
      clearTimeout(completionTimer);
    }

    function finishRequest() {
      pending -= 1;
      if (!pending) scheduleComplete();
    }

    function makeRequest(storeName, operation, callback, detail) {
      const request = { result: undefined, error: null, onsuccess: null, onerror: null };
      instrumentation.calls.push({ store: storeName, operation, mode, ...(detail || {}) });
      beginRequest();
      setTimeout(() => {
        if (aborted) {
          finishRequest();
          return;
        }
        try {
          request.result = callback();
          request.onsuccess?.();
        } catch (error) {
          request.error = error;
          tx.error = error;
          request.onerror?.();
          tx.onerror?.();
        } finally {
          finishRequest();
        }
      }, 0);
      return request;
    }

    function assertUnique(storeName, candidate, primaryKey) {
      for (const index of definitions[storeName].indexes.filter((item) => item.unique)) {
        const candidateKey = indexKey(candidate, index.keyPath);
        for (const [key, recordValue] of working[storeName]) {
          if (key !== primaryKey && equalKey(indexKey(recordValue, index.keyPath), candidateKey)) {
            throw new Error(`Unique index ${index.name} rejected a duplicate.`);
          }
        }
      }
    }

    function makeCursor(storeName, indexName, query, direction) {
      const request = { result: undefined, error: null, onsuccess: null, onerror: null };
      const definition = indexName
        ? definitions[storeName].indexes.find((item) => item.name === indexName)
        : { keyPath: definitions[storeName].keyPath };
      const rows = [...working[storeName].values()]
        .filter((value) => matchesQuery(indexKey(value, definition.keyPath), query))
        .sort((left, right) => compareKey(indexKey(left, definition.keyPath), indexKey(right, definition.keyPath)));
      if (direction === "prev") rows.reverse();
      let position = 0;
      const deliver = () => {
        beginRequest();
        setTimeout(() => {
          if (aborted) {
            finishRequest();
            return;
          }
          const value = rows[position];
          if (value === undefined) request.result = null;
          else {
            instrumentation.calls.push({ store: storeName, operation: "cursor", index: indexName, mode });
            request.result = {
              value: clone(value),
              continue() {
                position += 1;
                deliver();
              },
            };
          }
          request.onsuccess?.();
          finishRequest();
        }, 0);
      };
      instrumentation.calls.push({ store: storeName, operation: "openCursor", index: indexName, mode });
      deliver();
      return request;
    }

    function makeStore(storeName) {
      const keyPath = definitions[storeName].keyPath;
      return {
        get(key) {
          return makeRequest(storeName, "get", () => clone(working[storeName].get(key)), { key });
        },
        add(value) {
          return makeRequest(storeName, "add", () => {
            const recordValue = clone(value);
            const key = recordValue[keyPath];
            if (working[storeName].has(key)) throw new Error("Duplicate primary key.");
            assertUnique(storeName, recordValue, key);
            working[storeName].set(key, recordValue);
            return key;
          }, { key: value[keyPath] });
        },
        put(value) {
          return makeRequest(storeName, "put", () => {
            const recordValue = clone(value);
            const key = recordValue[keyPath];
            assertUnique(storeName, recordValue, key);
            working[storeName].set(key, recordValue);
            return key;
          }, { key: value[keyPath] });
        },
        delete(key) {
          return makeRequest(storeName, "delete", () => { working[storeName].delete(key); }, { key });
        },
        clear() {
          return makeRequest(storeName, "clear", () => { working[storeName].clear(); });
        },
        openCursor(query, direction) {
          return makeCursor(storeName, null, query, direction);
        },
        index(name) {
          const definition = definitions[storeName].indexes.find((item) => item.name === name);
          if (!definition) throw new Error(`Unknown index ${name}.`);
          return {
            get(key) {
              return makeRequest(storeName, "index.get", () => clone(
                [...working[storeName].values()].find((value) => equalKey(indexKey(value, definition.keyPath), key)),
              ), { index: name, key });
            },
            openCursor(query, direction) {
              return makeCursor(storeName, name, query, direction);
            },
          };
        },
      };
    }

    scheduleComplete();
    return tx;
  }

  return {
    database: { transaction },
    instrumentation,
    snapshot() {
      return Object.fromEntries(Object.keys(definitions).map((name) => [name, [...data[name].values()].map(clone)]));
    },
    resetInstrumentation() {
      instrumentation.transactions.length = 0;
      instrumentation.calls.length = 0;
    },
  };
}

async function runStoreTests() {
  await Promise.all(asyncBoundaryTests);
  const templateRuntime = createTemplateMutationRuntime({
    templates: [],
    recentTemplateIds: [],
    templateTreeUiState: { collapsedFolderIds: [] },
  });
  const [createdFolder, createdTemplate] = await Promise.all([
    templateRuntime.handle({
      type: workspace.MESSAGE_TYPES.TEMPLATE_NODE_CREATE,
      draft: {
        kind: templateTree.NODE_KINDS.FOLDER,
        name: "Runtime folder",
        iconKey: "folder",
      },
      targetParentId: null,
      beforeNodeId: null,
    }),
    templateRuntime.handle({
      type: workspace.MESSAGE_TYPES.TEMPLATE_NODE_CREATE,
      draft: {
        kind: templateTree.NODE_KINDS.TEMPLATE,
        name: "Runtime template",
        iconKey: "document",
        content: "Runtime content",
        autoSend: false,
      },
      targetParentId: null,
      beforeNodeId: null,
    }),
  ]);
  assert.equal(createdFolder.ok, true);
  assert.equal(createdTemplate.ok, true);
  assert.equal(createdFolder.createdNodeId, "folder-runtime-1");
  assert.equal(createdTemplate.createdNodeId, "template-runtime-2");
  assert.deepEqual(
    templateRuntime.storage.templates.map((node) => node.id),
    [createdFolder.createdNodeId, createdTemplate.createdNodeId],
    "concurrent creates serialize against the latest stored tree",
  );
  const collapsedRuntimeFolder = await templateRuntime.handle({
    type: workspace.MESSAGE_TYPES.TEMPLATE_TREE_UI_UPDATE,
    templateTreeUiState: { collapsedFolderIds: [createdFolder.createdNodeId] },
  });
  const movedRuntimeTemplate = await templateRuntime.handle({
    type: workspace.MESSAGE_TYPES.TEMPLATE_NODE_MOVE,
    nodeId: createdTemplate.createdNodeId,
    targetParentId: createdFolder.createdNodeId,
    beforeNodeId: null,
  });
  const touchedRuntimeTemplate = await templateRuntime.handle({
    type: workspace.MESSAGE_TYPES.RECENT_TEMPLATE_TOUCH,
    templateId: createdTemplate.createdNodeId,
  });
  const deletedRuntimeSubtree = await templateRuntime.handle({
    type: workspace.MESSAGE_TYPES.TEMPLATE_NODE_DELETE,
    nodeId: createdFolder.createdNodeId,
    mode: "subtree",
  });
  for (const response of [
    createdFolder,
    createdTemplate,
    collapsedRuntimeFolder,
    movedRuntimeTemplate,
    touchedRuntimeTemplate,
    deletedRuntimeSubtree,
  ]) {
    assert.equal(response.ok, true);
    assert.equal(response.changed, true);
    assert.equal(Array.isArray(response.templates), true);
    assert.equal(Array.isArray(response.recentTemplateIds), true);
    assert.equal(Array.isArray(response.templateTreeUiState.collapsedFolderIds), true);
  }
  assert.equal(deletedRuntimeSubtree.removedFolderCount, 1);
  assert.equal(deletedRuntimeSubtree.removedTemplateCount, 1);
  assert.deepEqual(templateRuntime.storage.templates, []);
  assert.deepEqual(templateRuntime.storage.recentTemplateIds, []);
  assert.deepEqual(templateRuntime.storage.templateTreeUiState, {
    collapsedFolderIds: [],
  });
  assert.equal(templateRuntime.setCalls.length, 6);
  assert.deepEqual(
    Object.keys(templateRuntime.setCalls.at(-1)).sort(),
    ["recentTemplateIds", "templateTreeUiState", "templates"],
    "subtree delete cleans all local keys in one atomic set",
  );
  assert.deepEqual(templateRuntime.forbiddenCalls, []);

  const coalescedResponses = [];
  const workspaceStatuses = [];
  let coalescedCalls = 0;
  const coalescedClient = conversations.createClient({
    send() {
      coalescedCalls += 1;
      return new Promise((resolve) => coalescedResponses.push(resolve));
    },
    onStatusChange(status) { workspaceStatuses.push(status); },
  });
  const coalescedFirst = coalescedClient.sync("https://chatgpt.com/");
  const coalescedSecond = coalescedClient.sync("https://chatgpt.com/");
  assert.equal(coalescedFirst, coalescedSecond);
  assert.equal(coalescedCalls, 1);
  coalescedResponses[0]({
    ok: false,
    error: { code: "WORKSPACE_MIGRATION_FAILED", message: "raw database detail must not escape" },
  });
  assert.equal(await coalescedFirst, null);
  assert.equal(coalescedClient.getStatus().status, "unavailable");
  assert.equal(coalescedClient.getStatus().errorCode, "WORKSPACE_MIGRATION_FAILED");
  assert.match(coalescedClient.getStatus().message, /Данные словаря V1 не удалены/);
  assert.equal(coalescedClient.getStatus().message.includes("raw database detail"), false);
  const retry = coalescedClient.retry();
  assert.equal(coalescedCalls, 2);
  coalescedResponses[1]({ ok: true, context: {
    id: "recovered",
    kind: "temporary",
    host: "chatgpt.com",
    scopeKey: "temporary:recovered-context",
    remoteConversationId: null,
  } });
  assert.equal((await retry).scopeKey, "temporary:recovered-context");
  assert.equal(coalescedClient.getStatus().status, "ready");
  assert.equal(workspaceStatuses.some((status) => status.status === "unavailable"), true);
  assert.equal(workspaceStatuses.at(-1).status, "ready");

  let workspaceClientSends = 0;
  const blockedWorkspaceClient = workspaceUi.createClient({
    getContext: () => null,
    getStatus: () => ({ status: "unavailable" }),
    send: async () => { workspaceClientSends += 1; return { ok: true }; },
  });
  assert.equal((await blockedWorkspaceClient.saveSelection("preserve me")).ok, false);
  assert.equal(workspaceClientSends, 0);
  const malformedReplacementClient = workspaceUi.createClient({
    getContext: () => ({ scopeKey: "stable:chatgpt.com:client-validation" }),
    getStatus: () => ({ status: "ready" }),
    send: async () => { workspaceClientSends += 1; return { ok: true }; },
  });
  assert.equal((await malformedReplacementClient.replaceGlossary({
    senseId: "target",
    expectedUpdatedAt: 1,
  })).error.code, "REQUEST_CONTRACT_ERROR");
  assert.equal(workspaceClientSends, 0);

  const pendingContexts = [];
  const observedContexts = [];
  const contextClient = conversations.createClient({
    send(message) {
      return new Promise((resolve) => pendingContexts.push({ message, resolve }));
    },
    onChange(context) { observedContexts.push(context.scopeKey); },
  });
  const firstSync = contextClient.sync("https://chatgpt.com/c/first-race");
  const secondSync = contextClient.sync("https://chatgpt.com/c/second-race");
  pendingContexts[1].resolve({ ok: true, context: {
    id: "second",
    kind: "stable",
    host: "chatgpt.com",
    scopeKey: "stable:chatgpt.com:second-race",
    remoteConversationId: "second-race",
  } });
  await secondSync;
  pendingContexts[0].resolve({ ok: true, context: {
    id: "first",
    kind: "stable",
    host: "chatgpt.com",
    scopeKey: "stable:chatgpt.com:first-race",
    remoteConversationId: "first-race",
  } });
  await firstSync;
  assert.equal(contextClient.getCurrent().scopeKey, "stable:chatgpt.com:second-race");
  assert.deepEqual(observedContexts, ["stable:chatgpt.com:second-race"]);

  let nextId = 0;
  let clock = 1000;
  const createStore = (initialState) => new workspaceStore.MemoryWorkspaceStore(initialState, {
    createId(prefix) { nextId += 1; return `${prefix}-${nextId}`; },
    now() { clock += 1; return clock; },
  });
  const stable = (id) => ({
    kind: "stable",
    host: "chatgpt.com",
    remoteConversationId: id,
    scopeKey: `stable:chatgpt.com:${id}`,
  });
  const temporary = (id) => ({ kind: "temporary", host: "chatgpt.com", scopeKey: `temporary:${id}` });

  assert.equal(importExport.SETTINGS_SCHEMA_VERSION, 1);
  assert.equal(importExport.DATA_SCHEMA_VERSION, 2);
  assert.equal(importExport.SCHEMA_VERSION, undefined);
  const settingsExport = importExport.createSettingsExport({
    theme: "navy",
    wallpaperDataUrl: "data:image/png;base64,AA==",
    closePanelAfterRun: true,
    closePanelOnOutsideClick: false,
    recentTemplatesHoverEnabled: false,
    recentTemplatesHoverCount: 7,
    analysis: { termColorMode: "custom", customTermColor: "#abcdef", glossaryTextSize: "large" },
    layout: { sidebarWidth: 515, analysisDialogWidth: 745 },
    commands: { mustNotExport: true },
    openRouterKey: "must-not-export",
  }, { exportedAt: "2026-07-18T10:00:00.000Z", extensionVersion: "2.0.0" });
  assert.equal(settingsExport.envelope.schemaVersion, importExport.SETTINGS_SCHEMA_VERSION);
  assert.equal(settingsExport.text, importExport.canonicalStringify(settingsExport.envelope));
  assert.equal(settingsExport.text.endsWith("\n"), true);
  assert.equal(settingsExport.text.includes("must-not-export"), false);
  const validSettings = importExport.validateSettingsText(settingsExport.text);
  assert.equal(validSettings.ok, true);
  assert.equal(validSettings.imported.recentTemplatesHoverCount, 7);
  const compatibilitySettingsExport = importExport.createSettingsExport({
    ...workspace.DEFAULT_ACTIVE_SETTINGS,
    wallpaperDataUrl: WALLPAPER_COMPATIBILITY_FIXTURE,
  }, { exportedAt: "2026-07-18T10:00:00.000Z", extensionVersion: "2.0.0" });
  const compatibilitySettingsValidation = importExport.validateSettingsText(
    compatibilitySettingsExport.text,
  );
  assert.equal(compatibilitySettingsValidation.ok, true);
  assert.equal(
    compatibilitySettingsValidation.imported.wallpaperDataUrl,
    WALLPAPER_COMPATIBILITY_FIXTURE,
  );
  assert.equal(
    importExport.buildSettingsPlan(
      workspace.DEFAULT_ACTIVE_SETTINGS,
      compatibilitySettingsValidation,
      "merge",
    ).settings.wallpaperDataUrl,
    WALLPAPER_COMPATIBILITY_FIXTURE,
  );
  const invalidWallpaperImport = JSON.parse(compatibilitySettingsExport.text);
  invalidWallpaperImport.payload.wallpaperDataUrl = "data:image/png;base64,A!";
  assert.equal(
    importExport.validateSettingsText(JSON.stringify(invalidWallpaperImport)).errors[0].code,
    "INVALID_WALLPAPER",
  );
  const settingsMerge = importExport.buildSettingsPlan(workspace.DEFAULT_ACTIVE_SETTINGS, validSettings, "merge");
  assert.equal(settingsMerge.settings.theme, "navy");
  assert.equal(settingsMerge.settings.closePanelOnOutsideClick, false);
  assert.equal(settingsMerge.settings.recentTemplatesHoverCount, 7);
  assert.equal(settingsMerge.preview.values.current.wallpaperDataUrl, null);
  assert.match(settingsMerge.preview.values.result.wallpaperDataUrl, /^\[data:image,/);
  const partialSettings = JSON.parse(settingsExport.text);
  partialSettings.payload = { theme: "graphite", layout: { sidebarWidth: 99999 }, unknownSetting: true };
  partialSettings.unknownEnvelope = true;
  const partialValidation = importExport.validateSettingsText(JSON.stringify(partialSettings));
  assert.equal(partialValidation.ok, true);
  assert.equal(partialValidation.warnings.filter((item) => item.code === "UNKNOWN_FIELD").length, 2);
  assert.equal(partialValidation.warnings.some((item) => item.code === "CLAMPED_WIDTH"), true);
  const mergePartialSettings = importExport.buildSettingsPlan(settingsMerge.settings, partialValidation, "merge");
  assert.equal(mergePartialSettings.settings.recentTemplatesHoverCount, 7);
  const replaceSettings = importExport.buildSettingsPlan(settingsMerge.settings, partialValidation, "replace");
  assert.equal(replaceSettings.settings.layout.sidebarWidth, workspace.LAYOUT.sidebarWidth.max);
  assert.equal(replaceSettings.settings.analysis.glossaryTextSize, workspace.DEFAULT_ACTIVE_SETTINGS.analysis.glossaryTextSize);
  assert.equal(replaceSettings.settings.recentTemplatesHoverCount, 3);
  assert.equal(replaceSettings.preview.reset.includes("analysis.glossaryTextSize"), true);
  assert.equal(replaceSettings.preview.reset.includes("recentTemplatesHoverCount"), true);
  const invalidSettings = JSON.parse(settingsExport.text);
  invalidSettings.payload.theme = 17;
  assert.equal(importExport.validateSettingsText(JSON.stringify(invalidSettings)).errors[0].code, "INVALID_THEME");
  for (const invalidRecentTemplatesHoverCount of ["3", null, 1.5, 0, 9]) {
    const invalidCountSettings = JSON.parse(settingsExport.text);
    invalidCountSettings.payload.recentTemplatesHoverCount = invalidRecentTemplatesHoverCount;
    assert.equal(
      importExport.validateSettingsText(JSON.stringify(invalidCountSettings)).errors[0].code,
      "INVALID_RECENT_TEMPLATES_HOVER_COUNT",
    );
  }
  const futureSettings = JSON.parse(settingsExport.text);
  futureSettings.schemaVersion += 1;
  assert.equal(importExport.validateSettingsText(JSON.stringify(futureSettings)).errors[0].code, "FUTURE_SCHEMA");
  assert.equal(importExport.validateSettingsText("x".repeat(importExport.SETTINGS_MAX_BYTES + 1)).errors[0].code, "FILE_TOO_LARGE");

  const portableState = {
    templates: [templateNode("template-one", "Шаблон", "Проверь текст")],
    conversations: [{ id: "conversation-one", kind: "stable", host: "chatgpt.com", remoteConversationId: "conversation-one", createdAt: 10, lastSeenAt: 20, orphanedAt: null }],
    glossaryConcepts: [{ id: "concept-one", displayTerm: "Workflow", createdAt: 10, updatedAt: 20 }],
    glossarySenses: [{ id: "sense-one", conceptId: "concept-one", translation: "процесс", definition: "Последовательность действий.", createdAt: 10, updatedAt: 20 }],
    glossaryLinks: [{ id: "glossary-link-one", senseId: "sense-one", conversationId: "conversation-one", localOrder: 0, firstSeenAt: 10, lastSeenAt: 20 }],
    savedItems: [{ id: "saved-one", text: "Сохранённый текст", createdAt: 10, updatedAt: 20 }],
    savedItemLinks: [{ id: "saved-link-one", itemId: "saved-one", conversationId: "conversation-one", localOrder: 0, firstSeenAt: 10, lastSeenAt: 20 }],
  };
  const dataMetadata = { datasetId: "11111111-2222-4333-8444-555555555555", exportedAt: "2026-07-18T10:00:00.000Z", extensionVersion: "2.0.0" };
  const dataExport = importExport.createDataExport(portableState, dataMetadata);
  assert.equal(dataExport.envelope.schemaVersion, importExport.DATA_SCHEMA_VERSION);
  assert.equal(dataExport.text, importExport.canonicalStringify(dataExport.envelope));
  assert.equal(dataExport.text.includes("closePanelOnOutsideClick"), false);
  assert.equal(dataExport.text.includes("recentTemplatesHoverCount"), false);
  assert.equal(dataExport.text.includes("recentTemplateIds"), false);
  assert.equal(dataExport.text.includes("templateTreeUiState"), false);
  assert.deepEqual(dataExport.envelope.payload.templates, portableState.templates);
  const sortedExport = importExport.createDataExport({
    ...portableState,
    templates: [
      templateNode("template-z", "Z", "Z"),
      templateNode("template-a", "A", "A"),
    ],
  }, dataMetadata);
  assert.deepEqual(sortedExport.envelope.payload.templates.map((item) => item.id), ["template-z", "template-a"]);
  assert.deepEqual(
    importExport.validateDataText(sortedExport.text).envelope.payload.templates.map((item) => item.id),
    ["template-z", "template-a"],
  );
  const orderedValidation = importExport.validateDataText(sortedExport.text);
  const orderedCurrent = {
    templates: [templateNode("template-current", "Current", "Current")],
    conversations: [], glossaryConcepts: [], glossarySenses: [], glossaryLinks: [], savedItems: [], savedItemLinks: [],
  };
  const orderedMerge = await importExport.buildDataPlan(orderedCurrent, orderedValidation, "merge", webcrypto);
  assert.deepEqual(orderedMerge.state.templates.map((item) => item.id), ["template-current", "template-z", "template-a"]);
  const orderedRepeatedMerge = await importExport.buildDataPlan(orderedMerge.state, orderedValidation, "merge", webcrypto);
  assert.equal(orderedRepeatedMerge.state.templates.length, 5);
  assert.deepEqual(
    orderedRepeatedMerge.state.templates.map((item) => item.name),
    ["Current", "Z", "A", "Z", "A"],
    "tree merge never deduplicates nodes by name or content",
  );
  assert.equal(new Set(orderedRepeatedMerge.state.templates.map((item) => item.id)).size, 5);
  const orderedReplace = await importExport.buildDataPlan(orderedCurrent, orderedValidation, "replace", webcrypto);
  assert.deepEqual(orderedReplace.state.templates.map((item) => item.id), ["template-z", "template-a"]);
  assert.equal(dataExport.text.includes("scopeKey"), false);
  assert.equal(dataExport.text.includes("normalizedTextKey"), false);
  const validData = importExport.validateDataText(dataExport.text);
  assert.equal(validData.ok, true);
  const workspaceOnlyData = importExport.validateDataText(importExport.createDataExport({
    ...portableState,
    templates: [],
  }, dataMetadata).text);
  const replaceData = await importExport.buildDataPlan({}, validData, "replace", webcrypto);
  assert.equal(replaceData.preview.aggregateOnly, true);
  assert.equal(replaceData.state.conversations[0].scopeKey, "stable:chatgpt.com:conversation-one");
  assert.equal(replaceData.state.savedItems[0].normalizedTextKey, workspace.normalizeSavedTextKey("Сохранённый текст"));
  const collisionCurrent = {
    ...workspaceStore.createEmptyState(1),
    templates: [templateNode("template-one", "Локальный", "Не заменять", true)],
    conversations: [{ id: "conversation-one", kind: "stable", host: "chatgpt.com", remoteConversationId: "local-conversation", scopeKey: "stable:chatgpt.com:local-conversation", canonicalUrl: "https://chatgpt.com/c/local-conversation", createdAt: 1, lastSeenAt: 2, orphanedAt: null }],
  };
  const firstMerge = await importExport.buildDataPlan(collisionCurrent, validData, "merge", webcrypto);
  assert.equal(firstMerge.preview.remapped >= 2, true);
  assert.equal(collisionCurrent.templates[0].content, "Не заменять");
  const repeatedMerge = await importExport.buildDataPlan(firstMerge.state, validData, "merge", webcrypto);
  assert.equal(importExport.canonicalDataEqual(firstMerge.state, repeatedMerge.state), false);
  assert.equal(repeatedMerge.preview.new.templates, 1);
  assert.equal(repeatedMerge.state.templates.length, 3);
  assert.equal(
    await importExport.deterministicRemapId(dataMetadata.datasetId, "templates", "template-one", 0, webcrypto),
    await importExport.deterministicRemapId(dataMetadata.datasetId, "templates", "template-one", 0, webcrypto),
  );

  const v1Envelope = clone(dataExport.envelope);
  v1Envelope.schemaVersion = 1;
  v1Envelope.payload.templates = [
    { id: "legacy-z", name: "Legacy Z", content: "Z", autoSend: false },
    { id: "legacy-a", name: "Legacy A", content: "A", autoSend: true },
  ];
  const validV1Data = importExport.validateDataText(JSON.stringify(v1Envelope));
  assert.equal(validV1Data.ok, true);
  assert.deepEqual(validV1Data.envelope.payload.templates, [
    templateNode("legacy-z", "Legacy Z", "Z"),
    templateNode("legacy-a", "Legacy A", "A", true),
  ]);

  function validateV2TemplateFixture(nodes) {
    const envelope = clone(dataExport.envelope);
    envelope.schemaVersion = importExport.DATA_SCHEMA_VERSION;
    envelope.payload.templates = nodes;
    return importExport.validateDataText(JSON.stringify(envelope));
  }

  for (const [name, nodes, code] of [
    ["unknown kind", [{ id: "bad-kind", kind: "other", parentId: null, name: "Bad", iconKey: "document" }], "INVALID_TEMPLATE_NODE"],
    ["invalid icon", [templateNode("bad-icon", "Bad", "Bad", false, null, "raw-svg")], "INVALID_TEMPLATE_NODE"],
    ["duplicate ID", [
      templateNode("duplicate-node", "First", "First"),
      templateNode("duplicate-node", "Second", "Second"),
    ], "DUPLICATE_ID"],
    ["missing parent", [templateNode("orphan-node", "Orphan", "Orphan", false, "missing-folder")], "INVALID_TEMPLATE_PARENT"],
    ["template parent", [
      templateNode("parent-template", "Parent", "Parent"),
      templateNode("child-template", "Child", "Child", false, "parent-template"),
    ], "INVALID_TEMPLATE_PARENT"],
    ["folder cycle", [
      folderNode("cycle-a", "Cycle A", "cycle-b"),
      folderNode("cycle-b", "Cycle B", "cycle-a"),
    ], "TEMPLATE_TREE_CYCLE"],
    ["depth seven", Array.from({ length: 7 }, (_, index) => folderNode(
      `depth-${index + 1}`,
      `Depth ${index + 1}`,
      index === 0 ? null : `depth-${index}`,
    )), "TEMPLATE_TREE_DEPTH_EXCEEDED"],
    ["persisted unsafe field", [{ ...templateNode("unsafe-node", "Unsafe", "Unsafe"), rawSvg: "<svg/>" }], "INVALID_TEMPLATE_NODE"],
    ["non-canonical preorder", [
      folderNode("ordered-folder", "Folder"),
      templateNode("unrelated-root", "Root", "Root"),
      templateNode("ordered-child", "Child", "Child", false, "ordered-folder"),
    ], "INVALID_TEMPLATE_NODE"],
  ]) {
    const validation = validateV2TemplateFixture(nodes);
    assert.equal(validation.ok, false, `${name} must be rejected by strict data-v2 validation`);
    assert.equal(validation.errors[0].code, code, name);
  }

  const incomingCollisionTree = [
    folderNode("shared-folder", "Same folder"),
    templateNode("shared-child", "Same template", "Same content", false, "shared-folder"),
  ];
  const collisionTreeValidation = importExport.validateDataText(importExport.createDataExport({
    ...workspaceStore.createEmptyState(1),
    templates: incomingCollisionTree,
  }, dataMetadata).text);
  const collisionTreeCurrent = {
    ...workspaceStore.createEmptyState(1),
    templates: [
      folderNode("shared-folder", "Same folder"),
      templateNode("shared-child", "Same template", "Same content", false, "shared-folder"),
      templateNode("local-root", "Local root", "Local root"),
    ],
  };
  const collisionTreeMerge = await importExport.buildDataPlan(
    collisionTreeCurrent,
    collisionTreeValidation,
    "merge",
    webcrypto,
  );
  const remappedFolderId = await importExport.deterministicRemapId(
    dataMetadata.datasetId,
    "templates",
    "shared-folder",
    0,
    webcrypto,
  );
  const remappedChildId = await importExport.deterministicRemapId(
    dataMetadata.datasetId,
    "templates",
    "shared-child",
    0,
    webcrypto,
  );
  assert.deepEqual(collisionTreeMerge.state.templates.map((node) => node.id), [
    "shared-folder",
    "shared-child",
    "local-root",
    remappedFolderId,
    remappedChildId,
  ]);
  assert.equal(
    collisionTreeMerge.state.templates.find((node) => node.id === remappedChildId).parentId,
    remappedFolderId,
    "two-pass ID allocation rewrites the incoming child parent",
  );
  assert.equal(collisionTreeMerge.preview.remapped, 2);

  const duplicateGraph = {
    templates: [
      templateNode("template-z", "Z", "Z"),
      templateNode("template-a", "A", "A"),
    ],
    conversations: [
      { id: "conversation-a", kind: "stable", host: "chatgpt.com", remoteConversationId: "duplicate", createdAt: 30, lastSeenAt: 31, orphanedAt: null },
      { id: "conversation-b", kind: "stable", host: "chatgpt.com", remoteConversationId: "duplicate", createdAt: 20, lastSeenAt: 40, orphanedAt: null },
      { id: "conversation-c", kind: "stable", host: "chatgpt.com", remoteConversationId: "duplicate", createdAt: 10, lastSeenAt: 50, orphanedAt: null },
    ],
    glossaryConcepts: [
      { id: "concept-a", displayTerm: "Workflow", createdAt: 30, updatedAt: 31 },
      { id: "concept-b", displayTerm: "workflow", createdAt: 20, updatedAt: 40 },
      { id: "concept-c", displayTerm: "WORKFLOW", createdAt: 10, updatedAt: 50 },
    ],
    glossarySenses: [
      { id: "sense-a", conceptId: "concept-a", translation: "процесс", definition: "Действия.", createdAt: 30, updatedAt: 31 },
      { id: "sense-b", conceptId: "concept-b", translation: "процесс", definition: "Действия.", createdAt: 20, updatedAt: 40 },
      { id: "sense-c", conceptId: "concept-c", translation: "процесс", definition: "Действия.", createdAt: 10, updatedAt: 50 },
    ],
    glossaryLinks: [
      { id: "glossary-link-a", senseId: "sense-a", conversationId: "conversation-a", localOrder: 2, firstSeenAt: 30, lastSeenAt: 31 },
      { id: "glossary-link-b", senseId: "sense-b", conversationId: "conversation-b", localOrder: 1, firstSeenAt: 20, lastSeenAt: 40 },
      { id: "glossary-link-c", senseId: "sense-c", conversationId: "conversation-c", localOrder: 0, firstSeenAt: 10, lastSeenAt: 50 },
    ],
    savedItems: [
      { id: "saved-a", text: "Один текст", createdAt: 30, updatedAt: 31 },
      { id: "saved-b", text: "Один текст", createdAt: 20, updatedAt: 40 },
      { id: "saved-c", text: "Один текст", createdAt: 10, updatedAt: 50 },
    ],
    savedItemLinks: [
      { id: "saved-link-a", itemId: "saved-a", conversationId: "conversation-a", localOrder: 2, firstSeenAt: 30, lastSeenAt: 31 },
      { id: "saved-link-b", itemId: "saved-b", conversationId: "conversation-b", localOrder: 1, firstSeenAt: 20, lastSeenAt: 40 },
      { id: "saved-link-c", itemId: "saved-c", conversationId: "conversation-c", localOrder: 0, firstSeenAt: 10, lastSeenAt: 50 },
    ],
  };
  const duplicateEnvelope = {
    format: importExport.DATA_FORMAT,
    schemaVersion: importExport.DATA_SCHEMA_VERSION,
    workspaceSchemaVersion: workspace.WORKSPACE_SCHEMA_VERSION,
    datasetId: dataMetadata.datasetId,
    exportedAt: dataMetadata.exportedAt,
    payload: duplicateGraph,
  };
  const duplicateValidation = importExport.validateDataText(JSON.stringify(duplicateEnvelope));
  assert.equal(duplicateValidation.ok, false);
  assert.equal(duplicateValidation.errors[0].code, "GLOSSARY_INVARIANT_VIOLATION");
  const rawWinnerSelectionEnvelope = {
    ...duplicateEnvelope,
    payload: {
      templates: [],
      conversations: [],
      glossaryConcepts: [
        { id: "raw-winner-a", displayTerm: "OpenAPI", createdAt: 1, updatedAt: 2 },
        { id: "raw-winner-b", displayTerm: "open api", createdAt: 3, updatedAt: 4 },
      ],
      glossarySenses: [{
        id: "raw-winner-sense",
        conceptId: "raw-winner-a",
        translation: "спецификация",
        definition: "Описание API.",
        createdAt: 1,
        updatedAt: 2,
      }],
      glossaryLinks: [],
      savedItems: [],
      savedItemLinks: [],
    },
  };
  const rawWinnerSelectionValidation = importExport.validateDataText(
    JSON.stringify(rawWinnerSelectionEnvelope),
  );
  assert.equal(rawWinnerSelectionValidation.ok, false);
  assert.equal(
    rawWinnerSelectionValidation.errors[0].code,
    "GLOSSARY_INVARIANT_VIOLATION",
  );

  const temporaryPortable = {
    templates: [],
    conversations: [{ id: "temporary-source", kind: "temporary", host: "chatgpt.com", remoteConversationId: null, createdAt: 10, lastSeenAt: 20, orphanedAt: 20 }],
    glossaryConcepts: [{ id: "temporary-concept", displayTerm: "Context", createdAt: 10, updatedAt: 20 }],
    glossarySenses: [
      { id: "temporary-sense", conceptId: "temporary-concept", translation: "контекст", definition: "Окружение.", createdAt: 10, updatedAt: 20 },
    ],
    glossaryLinks: [{ id: "temporary-glossary-link", senseId: "temporary-sense", conversationId: "temporary-source", localOrder: 0, firstSeenAt: 10, lastSeenAt: 20 }],
    savedItems: [
      { id: "temporary-saved", text: "Временный текст", createdAt: 10, updatedAt: 20 },
      { id: "global-saved", text: "Глобальный текст", createdAt: 11, updatedAt: 21 },
    ],
    savedItemLinks: [{ id: "temporary-saved-link", itemId: "temporary-saved", conversationId: "temporary-source", localOrder: 0, firstSeenAt: 10, lastSeenAt: 20 }],
  };
  const temporaryValidation = importExport.validateDataText(importExport.createDataExport(temporaryPortable, dataMetadata).text);
  const occupiedTemporaryCurrent = {
    ...workspaceStore.createEmptyState(1),
    templates: [],
    conversations: [{ id: "temporary-source", kind: "stable", host: "chatgpt.com", remoteConversationId: "occupied", scopeKey: "stable:chatgpt.com:occupied", canonicalUrl: "https://chatgpt.com/c/occupied", createdAt: 1, lastSeenAt: 2, orphanedAt: null }],
  };
  const temporaryFirst = await importExport.buildDataPlan(occupiedTemporaryCurrent, temporaryValidation, "merge", webcrypto);
  const temporarySecond = await importExport.buildDataPlan(temporaryFirst.state, temporaryValidation, "merge", webcrypto);
  const temporaryThird = await importExport.buildDataPlan(temporarySecond.state, temporaryValidation, "merge", webcrypto);
  assert.equal(importExport.canonicalDataEqual(temporaryFirst.state, temporarySecond.state), true);
  assert.equal(importExport.canonicalDataEqual(temporarySecond.state, temporaryThird.state), true);
  assert.equal(temporaryThird.state.conversations.filter((item) => item.kind === "temporary").length, 1);
  assert.equal(temporaryThird.state.glossaryLinks.length, 1);
  assert.equal(temporaryThird.state.savedItemLinks.length, 1);
  assert.equal(temporaryThird.state.glossarySenses.length, 1);
  assert.equal(temporaryThird.state.savedItems.length, 2);
  assert.match(
    temporaryThird.state.conversations.find((item) => item.kind === "temporary").scopeKey,
    /^temporary:import-temporary-provenance-[0-9a-f]{32}$/,
  );
  const wrongTemporaryScope = structuredClone(temporaryThird.state);
  wrongTemporaryScope.conversations.find((item) => item.kind === "temporary").scopeKey = "temporary:import-wrong-provenance";
  assert.equal(importExport.canonicalDataEqual(temporaryThird.state, wrongTemporaryScope), false);
  const otherDatasetMetadata = { ...dataMetadata, datasetId: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee" };
  const otherTemporaryValidation = importExport.validateDataText(importExport.createDataExport(temporaryPortable, otherDatasetMetadata).text);
  const otherTemporaryMerge = await importExport.buildDataPlan(temporaryThird.state, otherTemporaryValidation, "merge", webcrypto);
  assert.equal(otherTemporaryMerge.state.conversations.filter((item) => item.kind === "temporary").length, 2);
  assert.equal(otherTemporaryMerge.state.glossaryLinks.length, 2);
  assert.equal(otherTemporaryMerge.state.savedItemLinks.length, 2);

  const timestampCurrent = {
    templates: [],
    conversations: [{ id: "current-conversation", kind: "stable", host: "chatgpt.com", remoteConversationId: "conversation-one", scopeKey: "stable:chatgpt.com:conversation-one", canonicalUrl: "https://chatgpt.com/c/conversation-one", createdAt: 15, lastSeenAt: 18, orphanedAt: 17 }],
    glossaryConcepts: [{ id: "current-concept", displayTerm: "WORKFLOW", canonicalTerm: "WORKFLOW", normalizedKey: "workflow", createdAt: 15, updatedAt: 18 }],
    glossarySenses: [{ id: "current-sense", conceptId: "current-concept", translation: "Процесс", definition: "Последовательность действий.", normalizedTranslation: "процесс", normalizedDefinition: "последовательность действий.", naturalKey: workspace.createSenseNaturalKey("current-concept", "Процесс", "Последовательность действий."), createdAt: 15, updatedAt: 18 }],
    glossaryLinks: [{ id: "current-glossary-link", senseId: "current-sense", conversationId: "current-conversation", linkKey: "current-sense\u001fcurrent-conversation", localOrder: 7, firstSeenAt: 15, lastSeenAt: 18 }],
    savedItems: [{ id: "current-saved", text: "Сохранённый текст", normalizedTextKey: "Сохранённый текст", createdAt: 15, updatedAt: 18 }],
    savedItemLinks: [{ id: "current-saved-link", itemId: "current-saved", conversationId: "current-conversation", linkKey: "current-saved\u001fcurrent-conversation", localOrder: 9, firstSeenAt: 15, lastSeenAt: 18 }],
  };
  const timestampMerge = await importExport.buildDataPlan(timestampCurrent, workspaceOnlyData, "merge", webcrypto);
  assert.deepEqual(timestampMerge.state.conversations.find((item) => item.id === "current-conversation"), {
    ...timestampCurrent.conversations[0], createdAt: 10, lastSeenAt: 20, orphanedAt: null,
  });
  assert.equal(timestampMerge.state.glossaryConcepts.find((item) => item.id === "current-concept").displayTerm, "WORKFLOW");
  assert.equal(timestampMerge.state.glossaryConcepts.find((item) => item.id === "current-concept").createdAt, 15);
  assert.equal(timestampMerge.state.glossaryConcepts.find((item) => item.id === "current-concept").updatedAt, 18);
  assert.equal(timestampMerge.state.glossarySenses.find((item) => item.id === "current-sense").translation, "Процесс");
  assert.equal(timestampMerge.state.glossarySenses.find((item) => item.id === "current-sense").createdAt, 15);
  assert.equal(timestampMerge.state.glossarySenses.find((item) => item.id === "current-sense").updatedAt, 18);
  assert.equal(timestampMerge.state.savedItems.find((item) => item.id === "current-saved").id, "current-saved");
  assert.equal(timestampMerge.state.savedItems.find((item) => item.id === "current-saved").createdAt, 10);
  assert.equal(timestampMerge.state.savedItems.find((item) => item.id === "current-saved").updatedAt, 20);
  assert.deepEqual(
    timestampMerge.state.glossaryLinks.find((item) => item.id === "current-glossary-link"),
    { ...timestampCurrent.glossaryLinks[0], firstSeenAt: 10, lastSeenAt: 20 },
  );
  assert.deepEqual(
    timestampMerge.state.savedItemLinks.find((item) => item.id === "current-saved-link"),
    { ...timestampCurrent.savedItemLinks[0], firstSeenAt: 10, lastSeenAt: 20 },
  );
  const currentWithoutDerivedMeaningFields = clone(timestampCurrent);
  delete currentWithoutDerivedMeaningFields.glossarySenses[0].normalizedTranslation;
  delete currentWithoutDerivedMeaningFields.glossarySenses[0].normalizedDefinition;
  const normalizedContentMerge = await importExport.buildDataPlan(
    currentWithoutDerivedMeaningFields,
    workspaceOnlyData,
    "merge",
    webcrypto,
  );
  assert.equal(
    normalizedContentMerge.state.glossarySenses.find((item) => item.id === "current-sense").id,
    "current-sense",
  );
  assert.equal(
    normalizedContentMerge.state.glossarySenses.some((item) => item.id === "sense-one"),
    false,
  );
  const conflictingPortableState = clone(portableState);
  conflictingPortableState.glossarySenses[0].definition = "Другая версия.";
  const conflictingValidation = importExport.validateDataText(
    importExport.createDataExport(conflictingPortableState, dataMetadata).text,
  );
  const timestampBeforeConflict = clone(timestampCurrent);
  await assert.rejects(
    importExport.buildDataPlan(timestampCurrent, conflictingValidation, "merge", webcrypto),
    /GLOSSARY_IMPORT_CONFLICT/,
  );
  assert.deepEqual(timestampCurrent, timestampBeforeConflict);
  const timestampRepeated = await importExport.buildDataPlan(timestampMerge.state, workspaceOnlyData, "merge", webcrypto);
  assert.equal(importExport.canonicalDataEqual(timestampMerge.state, timestampRepeated.state), true);
  const timestampReplace = await importExport.buildDataPlan(timestampCurrent, validData, "replace", webcrypto);
  assert.equal(timestampReplace.state.glossaryConcepts[0].id, "concept-one");
  assert.equal(timestampReplace.state.glossaryConcepts[0].displayTerm, "Workflow");
  assert.equal(timestampReplace.state.glossaryLinks[0].localOrder, 0);

  const previewCurrent = {
    templates: [
      templateNode("template-a", "A", "A"),
      templateNode("template-b", "B", "B"),
    ],
    conversations: [], glossaryConcepts: [], glossarySenses: [], glossaryLinks: [], savedItems: [], savedItemLinks: [],
  };
  const previewIncoming = {
    ...previewCurrent,
    templates: [
      templateNode("template-b", "B", "B"),
      templateNode("template-c", "C", "C"),
    ],
  };
  const previewValidation = importExport.validateDataText(importExport.createDataExport(previewIncoming, dataMetadata).text);
  const identityReplace = await importExport.buildDataPlan(previewCurrent, previewValidation, "replace", webcrypto);
  assert.equal(identityReplace.preview.current.templates, 2);
  assert.equal(identityReplace.preview.incoming.templates, 2);
  assert.equal(identityReplace.preview.retained.templates, 1);
  assert.equal(identityReplace.preview.created.templates, 1);
  assert.equal(identityReplace.preview.removed.templates, 1);
  assert.equal(identityReplace.preview.resulting.templates, 2);
  const orderOnlyValidation = importExport.validateDataText(importExport.createDataExport({
    ...previewCurrent,
    templates: [...previewCurrent.templates].reverse(),
  }, dataMetadata).text);
  const orderOnlyReplace = await importExport.buildDataPlan(previewCurrent, orderOnlyValidation, "replace", webcrypto);
  assert.equal(orderOnlyReplace.preview.retained.templates, 2);
  assert.equal(orderOnlyReplace.preview.created.templates, 0);
  assert.equal(orderOnlyReplace.preview.removed.templates, 0);
  assert.equal(orderOnlyReplace.preview.orderChanged.templates, true);
  assert.equal(importExport.canonicalDataEqual(previewCurrent, orderOnlyReplace.state), false);
  for (const changedTemplate of [
    { ...previewCurrent.templates[0], content: "Changed content" },
    { ...previewCurrent.templates[0], name: "Changed name" },
    { ...previewCurrent.templates[0], autoSend: true },
  ]) {
    const changedInPlace = importExport.validateDataText(importExport.createDataExport({
      ...previewCurrent,
      templates: [changedTemplate, previewCurrent.templates[1]],
    }, dataMetadata).text);
    assert.equal((await importExport.buildDataPlan(previewCurrent, changedInPlace, "replace", webcrypto)).preview.orderChanged.templates, false);
  }
  const reorderAndContentValidation = importExport.validateDataText(importExport.createDataExport({
    ...previewCurrent,
    templates: [previewCurrent.templates[1], { ...previewCurrent.templates[0], content: "Changed while reordered" }],
  }, dataMetadata).text);
  assert.equal((await importExport.buildDataPlan(previewCurrent, reorderAndContentValidation, "replace", webcrypto)).preview.orderChanged.templates, true);
  assert.equal(identityReplace.preview.orderChanged.templates, true);
  const mergeReorder = await importExport.buildDataPlan(previewCurrent, orderOnlyValidation, "merge", webcrypto);
  assert.equal(mergeReorder.preview.orderChanged.templates, true);
  assert.deepEqual(
    mergeReorder.state.templates.map((node) => node.name),
    ["A", "B", "B", "A"],
  );
  const emptyValidation = importExport.validateDataText(importExport.createDataExport({
    templates: [], conversations: [], glossaryConcepts: [], glossarySenses: [], glossaryLinks: [], savedItems: [], savedItemLinks: [],
  }, dataMetadata).text);
  assert.equal((await importExport.buildDataPlan(previewCurrent, emptyValidation, "replace", webcrypto)).preview.removed.templates, 2);
  assert.equal((await importExport.buildDataPlan(previewCurrent, emptyValidation, "replace", webcrypto)).preview.orderChanged.templates, true);
  assert.equal((await importExport.buildDataPlan({}, emptyValidation, "replace", webcrypto)).preview.orderChanged.templates, false);
  assert.equal((await importExport.buildDataPlan({}, previewValidation, "replace", webcrypto)).preview.created.templates, 2);
  assert.equal(importExport.canonicalDataEqual(previewCurrent, {
    ...previewCurrent,
    templates: [{ ...previewCurrent.templates[0], iconKey: "code" }, previewCurrent.templates[1]],
  }), false);
  const canonicalFolderState = {
    ...previewCurrent,
    templates: [
      folderNode("canonical-folder", "Canonical folder"),
      templateNode("template-a", "A", "A", false, "canonical-folder"),
      previewCurrent.templates[1],
    ],
  };
  assert.equal(importExport.canonicalDataEqual(canonicalFolderState, {
    ...canonicalFolderState,
    templates: [
      folderNode("canonical-folder", "Canonical folder"),
      previewCurrent.templates[0],
      previewCurrent.templates[1],
    ],
  }), false);
  const changedKindState = {
    ...canonicalFolderState,
    templates: [
      folderNode("canonical-folder", "Canonical folder"),
      folderNode("template-a", "A", "canonical-folder"),
      previewCurrent.templates[1],
    ],
  };
  assert.equal(importExport.canonicalDataEqual(canonicalFolderState, changedKindState), false);

  const brokenReference = JSON.parse(dataExport.text);
  brokenReference.payload.glossaryLinks[0].senseId = "missing-sense";
  assert.equal(importExport.validateDataText(JSON.stringify(brokenReference)).errors.some((item) => item.code === "BROKEN_REFERENCE"), true);
  const duplicateId = JSON.parse(dataExport.text);
  duplicateId.payload.savedItems.push({ ...duplicateId.payload.savedItems[0] });
  assert.equal(importExport.validateDataText(JSON.stringify(duplicateId)).errors[0].code, "DUPLICATE_ID");
  const futureData = JSON.parse(dataExport.text);
  futureData.schemaVersion += 1;
  assert.equal(importExport.validateDataText(JSON.stringify(futureData)).errors[0].code, "FUTURE_SCHEMA");
  const largePortable = {
    ...portableState,
    templates: Array.from(
      { length: 1000 },
      (_, index) => templateNode(`template-${index}`, `Шаблон ${index}`, `Текст ${index}`),
    ),
  };
  const largeValidation = importExport.validateDataText(importExport.createDataExport(largePortable, dataMetadata).text);
  const plannerStartedAt = performance.now();
  assert.equal((await importExport.buildDataPlan({}, largeValidation, "merge", webcrypto)).state.templates.length, 1000);
  assert.equal(performance.now() - plannerStartedAt < 5000, true);

  const largeDuplicateLinkPayload = {
    templates: [],
    conversations: [{ id: "large-conversation", kind: "stable", host: "chatgpt.com", remoteConversationId: "large", createdAt: 1, lastSeenAt: 2, orphanedAt: null }],
    glossaryConcepts: [],
    glossarySenses: [],
    glossaryLinks: [],
    savedItems: [{ id: "large-item", text: "Large duplicate item", createdAt: 1, updatedAt: 2 }],
    savedItemLinks: Array.from({ length: 20000 }, (_, index) => ({
      id: `large-link-${String(index).padStart(5, "0")}`,
      itemId: "large-item",
      conversationId: "large-conversation",
      localOrder: 20000 - index,
      firstSeenAt: 30000 - index,
      lastSeenAt: 40000 + index,
    })),
  };
  assert.equal(importExport.byteLength(JSON.stringify(largeDuplicateLinkPayload)) < importExport.DATA_MAX_BYTES, true);
  const largeDuplicateStartedAt = performance.now();
  const largeDuplicateCanonical = importExport.canonicalizeDataPayload(largeDuplicateLinkPayload);
  assert.equal(largeDuplicateCanonical.payload.savedItemLinks.length, 1);
  assert.deepEqual({
    localOrder: largeDuplicateCanonical.payload.savedItemLinks[0].localOrder,
    firstSeenAt: largeDuplicateCanonical.payload.savedItemLinks[0].firstSeenAt,
    lastSeenAt: largeDuplicateCanonical.payload.savedItemLinks[0].lastSeenAt,
  }, { localOrder: 1, firstSeenAt: 10001, lastSeenAt: 59999 });
  assert.equal(largeDuplicateCanonical.deduplicatedByFamily.savedItemLinks, 19999);
  assert.equal(performance.now() - largeDuplicateStartedAt < 5000, true);

  const temporaryConversationState = {
    templates: [],
    conversations: Array.from({ length: 500 }, (_, index) => ({
      id: `temporary-${String(index).padStart(4, "0")}`,
      kind: "temporary",
      host: "chatgpt.com",
      remoteConversationId: null,
      createdAt: index + 1,
      lastSeenAt: index + 2,
      orphanedAt: index + 2,
    })),
    glossaryConcepts: [], glossarySenses: [], glossaryLinks: [], savedItems: [], savedItemLinks: [],
  };
  const largeTemporaryValidation = importExport.validateDataText(importExport.createDataExport(temporaryConversationState, dataMetadata).text);
  let activeDigests = 0;
  let maximumDigests = 0;
  let digestCalls = 0;
  const instrumentedCrypto = {
    subtle: {
      async digest(...args) {
        activeDigests += 1;
        maximumDigests = Math.max(maximumDigests, activeDigests);
        digestCalls += 1;
        try {
          await Promise.resolve();
          return await webcrypto.subtle.digest(...args);
        } finally {
          activeDigests -= 1;
        }
      },
    },
  };
  const temporaryPlanStartedAt = performance.now();
  const manyTemporaryPlan = await importExport.buildDataPlan({}, largeTemporaryValidation, "replace", instrumentedCrypto);
  const repeatedTemporaryPlan = await importExport.buildDataPlan({}, largeTemporaryValidation, "replace", webcrypto);
  assert.equal(digestCalls, 500);
  assert.equal(maximumDigests, 1);
  assert.deepEqual(
    manyTemporaryPlan.state.conversations.map((item) => item.scopeKey),
    repeatedTemporaryPlan.state.conversations.map((item) => item.scopeKey),
  );
  assert.equal(performance.now() - temporaryPlanStartedAt < 5000, true);

  const importStore = createStore();
  const userData = Object.fromEntries(workspaceStore.USER_STORE_NAMES.map((name) => [name, replaceData.state[name]]));
  await importStore.putImportBackup("data", await importStore.snapshotUserData());
  await importStore.setMetaValue("pendingDataImport", { phase: "applying", createdAt: 1 });
  await importStore.replaceUserData(userData);
  assert.equal((await importStore.snapshotUserData()).savedItems.length, 1);
  assert.equal((await importStore.getImportBackup("data")).kind, "data");
  assert.equal((await importStore.getMetaValue("pendingDataImport")).phase, "applying");
  await importStore.deleteMetaValue("pendingDataImport");
  assert.equal(await importStore.getMetaValue("pendingDataImport"), null);

  const migrationStore = createStore();
  const conflictingLegacy = [
    {
      id: "legacy-1",
      term: "WorkflowOrchestrator",
      translation: "оркестратор workflow",
      definition: "Координирует шаги.",
      createdAt: 10,
      updatedAt: 20,
    },
    {
      id: "legacy-2",
      term: "workflow orchestrator",
      translation: "оркестратор workflow",
      definition: "Координирует шаги.",
      createdAt: 5,
      updatedAt: 30,
    },
    {
      id: "legacy-3",
      term: "Workflow Orchestrator",
      translation: "отдельное значение",
      definition: "Другой смысл.",
      createdAt: 15,
      updatedAt: 25,
    },
    { id: "broken", term: "", translation: "x", definition: "y" },
  ];
  await assert.rejects(
    migrationStore.migrateLegacyGlossary(conflictingLegacy),
    /GLOSSARY_INVARIANT_VIOLATION/,
  );
  assert.equal(migrationStore.snapshot().glossaryConcepts.length, 0);
  assert.equal(
    migrationStore.snapshot().meta.find((item) => item.key === "v1GlossaryMigrationState").value,
    null,
  );
  const migration = await migrationStore.migrateLegacyGlossary(
    conflictingLegacy.filter((item) => ["legacy-1", "broken"].includes(item.id)),
  );
  assert.equal(migration.migrated, true);
  assert.deepEqual(migration.marker, {
    status: "complete",
    sourceSchemaVersion: 1,
    sourceCount: 2,
    migratedCount: 1,
    skippedCount: 1,
  });
  const migratedState = migrationStore.snapshot();
  assert.equal(migratedState.glossaryConcepts.length, 1);
  assert.equal(migratedState.glossaryConcepts[0].createdAt, 10);
  assert.equal(migratedState.glossaryConcepts[0].updatedAt, 20);
  assert.equal(migratedState.glossarySenses.length, 1);
  assert.equal(migratedState.glossaryLinks.length, 0);
  assert.equal((await migrationStore.migrateLegacyGlossary([])).migrated, false);
  assert.equal(migrationStore.snapshot().glossarySenses.length, 1);

  const rollbackStore = createStore();
  rollbackStore.failNextWrite(new Error("simulated abort"));
  await assert.rejects(
    rollbackStore.migrateLegacyGlossary([{ term: "state", translation: "состояние", definition: "Состояние системы." }]),
    /simulated abort/,
  );
  assert.equal(rollbackStore.snapshot().glossaryConcepts.length, 0);
  assert.equal(rollbackStore.snapshot().meta.find((item) => item.key === "v1GlossaryMigrationState").value, null);
  assert.equal((await rollbackStore.migrateLegacyGlossary([
    { term: "state", translation: "состояние", definition: "Состояние системы." },
  ])).migrated, true);

  const store = createStore();
  const tempScope = "temporary:aaaaaaaa-bbbb-cccc";
  const firstTemp = await store.ensureConversation(temporary("aaaaaaaa-bbbb-cccc"));
  const reusedTemp = await store.ensureConversation(temporary("aaaaaaaa-bbbb-cccc"));
  assert.equal(firstTemp.context.id, reusedTemp.context.id);
  assert.equal(reusedTemp.created, false);

  const stableOne = await store.ensureConversation(stable("one"));
  const stableOneAgain = await store.ensureConversation(stable("one"));
  const stableTwo = await store.ensureConversation(stable("two"));
  assert.equal(stableOne.context.id, stableOneAgain.context.id);
  assert.notEqual(stableOne.context.id, stableTwo.context.id);

  const firstTerms = await store.addAnalysisTerms([
    { term: "state", translation: "состояние", definition: "Состояние workflow." },
    { term: "state", translation: "государство", definition: "Политическое образование." },
  ], tempScope);
  assert.equal(firstTerms.results.length, 2);
  assert.deepEqual(firstTerms.results.map((item) => item.status), [
    "new",
    "replacementAvailable",
  ]);
  assert.equal(store.snapshot().glossarySenses.length, 1);
  const exactAttach = await store.addAnalysisTerms([
    { term: "State", translation: "состояние", definition: "Состояние workflow." },
  ], tempScope);
  assert.equal(exactAttach.results[0].status, "alreadySaved");
  assert.equal((await store.queryGlossary({ conversationScope: tempScope, mode: "local", query: "" })).length, 1);
  assert.equal((await store.queryGlossary({ conversationScope: tempScope, mode: "global", query: "" })).length, 0);
  assert.equal((await store.queryGlossary({ conversationScope: tempScope, mode: "global", query: "state" })).length, 1);

  const exactLookupScope = "stable:chatgpt.com:inline-lookup";
  const exactLookupState = workspaceStore.createEmptyState(1);
  exactLookupState.conversations.push({
    id: "conversation-inline-lookup",
    scopeKey: exactLookupScope,
    kind: "stable",
    host: "chatgpt.com",
    remoteConversationId: "inline-lookup",
    canonicalUrl: "https://chatgpt.com/c/inline-lookup",
    createdAt: 1,
    lastSeenAt: 1,
    orphanedAt: null,
  });
  function addLookupConcept(state, id, term, translation, definition, updatedAt) {
    const canonical = workspace.canonicalizeTerm(term);
    state.glossaryConcepts.push({
      id: `concept-${id}`,
      displayTerm: term,
      canonicalTerm: canonical.canonicalTerm,
      normalizedKey: canonical.normalizedKey,
      createdAt: 1,
      updatedAt,
    });
    state.glossarySenses.push({
      id: `sense-${id}`,
      conceptId: `concept-${id}`,
      translation,
      definition,
      normalizedTranslation: translation.toLocaleLowerCase("ru-RU"),
      normalizedDefinition: definition.toLocaleLowerCase("ru-RU"),
      naturalKey: workspace.createSenseNaturalKey(`concept-${id}`, translation, definition),
      createdAt: 1,
      updatedAt,
    });
  }
  addLookupConcept(exactLookupState, "state", "state", "состояние", "Состояние системы.", 10);
  addLookupConcept(exactLookupState, "state-machine", "state machine", "конечный автомат", "Модель состояний.", 20);
  addLookupConcept(exactLookupState, "statement", "statement", "утверждение", "Отдельное слово.", 30);
  exactLookupState.glossaryLinks.push({
    id: "link-inline-attached",
    senseId: "sense-state",
    conversationId: "conversation-inline-lookup",
    linkKey: "sense-state\u001fconversation-inline-lookup",
    localOrder: 0,
    firstSeenAt: 1,
    lastSeenAt: 1,
  });
  const exactLookupStore = createStore(exactLookupState);
  const exactLookupBefore = exactLookupStore.snapshot();
  const exactLookup = await exactLookupStore.lookupGlossarySelection({
    conversationScope: exactLookupScope,
    text: "State machine / unknown",
  });
  assert.deepEqual(
    exactLookup.groups.flatMap((group) => group.entries.map((entry) => entry.id)),
    ["sense-state-machine", "sense-state"],
  );
  assert.equal(
    exactLookup.groups.find((group) => group.candidate.normalizedKey === "state machine")
      .entries[0].matchClass,
    "exact",
  );
  assert.equal(
    exactLookup.groups.find((group) => group.candidate.normalizedKey === "state")
      .entries[0].attached,
    true,
  );
  assert.ok(exactLookup.missing.some((candidate) => candidate.normalizedKey === "unknown"));
  const termModeMissing = await exactLookupStore.lookupGlossarySelection({
    conversationScope: exactLookupScope,
    text: "route handler",
  });
  assert.deepEqual(
    termModeMissing.missing.map((candidate) => [
      candidate.displayTerm,
      candidate.source,
      candidate.visibility,
    ]),
    [["route handler", "selected-whole", "primary"]],
  );
  const fragmentModeMissing = await exactLookupStore.lookupGlossarySelection({
    conversationScope: exactLookupScope,
    text: "route handler короткий",
  });
  assert.deepEqual(
    fragmentModeMissing.missing.map((candidate) => candidate.displayTerm),
    ["route", "handler"],
  );
  assert.equal(
    fragmentModeMissing.missing.some((candidate) => candidate.displayTerm === "route handler"),
    false,
    "unmatched lookup-only phrases stay out of the visible missing list",
  );
  const phraseCoverageState = clone(exactLookupState);
  addLookupConcept(
    phraseCoverageState,
    "route-handler",
    "route handler",
    "обработчик маршрута",
    "Обрабатывает маршрут.",
    40,
  );
  const phraseCoverageLookup = await createStore(phraseCoverageState)
    .lookupGlossarySelection({
      conversationScope: exactLookupScope,
      text: "route handler короткий",
    });
  assert.deepEqual(phraseCoverageLookup.missing, []);
  assert.equal(phraseCoverageLookup.groups.length, 1);
  assert.equal(phraseCoverageLookup.groups[0].candidate.displayTerm, "route handler");
  assert.equal(phraseCoverageLookup.groups[0].candidate.visibility, "lookup-only");
  assert.equal(phraseCoverageLookup.groups[0].entries[0].matchClass, "exact");
  assert.equal(phraseCoverageLookup.totals.matchedCandidateCount, 3);
  const relatedLookup = await exactLookupStore.lookupGlossarySelection({
    conversationScope: exactLookupScope,
    text: "state",
  });
  assert.deepEqual(
    relatedLookup.groups.flatMap((group) => group.entries.map((entry) => [
      entry.id,
      entry.matchClass,
    ])),
    [["sense-state", "exact"], ["sense-state-machine", "contiguous"]],
  );
  assert.equal(
    relatedLookup.groups.some((group) => (
      group.entries.some((entry) => entry.id === "sense-statement")
    )),
    false,
    "substring-only matches are excluded",
  );
  const exactMissingLookup = await exactLookupStore.lookupGlossarySelection({
    conversationScope: exactLookupScope,
    text: "machine",
  });
  assert.equal(exactMissingLookup.groups.length, 1);
  assert.equal(exactMissingLookup.groups[0].exactMissing, true);
  assert.equal(exactMissingLookup.groups[0].matchClass, "contiguous");
  assert.equal(exactMissingLookup.groups[0].entries[0].id, "sense-state-machine");
  const reorderedCandidate = workspace.extractInlineGlossaryCandidates("response OpenAPI")
    .candidates.find((candidate) => candidate.normalizedKey === "response open api");
  const openApiResponse = workspace.canonicalizeTerm("OpenAPI response");
  assert.equal(workspaceStore.inlineMatchClass(reorderedCandidate, {
    displayTerm: openApiResponse.displayTerm,
    canonicalTerm: openApiResponse.canonicalTerm,
    normalizedKey: openApiResponse.normalizedKey,
  }), "full-token");
  await assert.rejects(
    exactLookupStore.lookupGlossarySelection({ conversationScope: exactLookupScope, text: "" }),
    /INVALID_GLOSSARY_LOOKUP/,
  );
  await assert.rejects(
    exactLookupStore.lookupGlossarySelection({ conversationScope: "invalid", text: "state" }),
    /INVALID_GLOSSARY_LOOKUP/,
  );
  assert.deepEqual(exactLookupStore.snapshot(), exactLookupBefore, "batch Memory lookup is read-only");

  const truncatedState = clone(exactLookupState);
  truncatedState.glossaryConcepts = [];
  truncatedState.glossarySenses = [];
  truncatedState.glossaryLinks = [];
  for (let index = 0; index < 101; index += 1) {
    const term = `API component ${index}`;
    const canonical = workspace.canonicalizeTerm(term);
    truncatedState.glossaryConcepts.push({
      id: `concept-api-${index}`,
      displayTerm: term,
      canonicalTerm: canonical.canonicalTerm,
      normalizedKey: canonical.normalizedKey,
      createdAt: 1,
      updatedAt: index,
    });
    truncatedState.glossarySenses.push({
      id: `sense-api-${index}`,
      conceptId: `concept-api-${index}`,
      translation: `компонент ${index}`,
      definition: `Определение ${index}.`,
      normalizedTranslation: `компонент ${index}`,
      normalizedDefinition: `определение ${index}.`,
      naturalKey: workspace.createSenseNaturalKey(
        `concept-api-${index}`,
        `компонент ${index}`,
        `Определение ${index}.`,
      ),
      createdAt: 1,
      updatedAt: index,
    });
  }
  const truncatedLookup = await createStore(truncatedState).lookupGlossarySelection({
    conversationScope: exactLookupScope,
    text: "API",
  });
  assert.equal(truncatedLookup.totals.matchedEntryCountBeforeLimit, 101);
  assert.equal(truncatedLookup.totals.matchedEntryCountReturned, 100);
  assert.equal(truncatedLookup.truncated.entries, true);
  const fairTruncationState = clone(truncatedState);
  addLookupConcept(
    fairTruncationState,
    "dto",
    "DTO",
    "объект передачи данных",
    "Структура передачи данных.",
    200,
  );
  const fairTruncationLookup = await createStore(fairTruncationState)
    .lookupGlossarySelection({
      conversationScope: exactLookupScope,
      text: "API / DTO",
    });
  assert.equal(fairTruncationLookup.totals.matchedEntryCountBeforeLimit, 102);
  assert.equal(fairTruncationLookup.totals.matchedEntryCountReturned, 100);
  assert.equal(
    fairTruncationLookup.groups.some((group) => (
      group.candidate.normalizedKey === "dto"
      && group.entries.some((entry) => entry.id === "sense-dto")
    )),
    true,
    "entry truncation reserves a visible result for a later matched candidate",
  );

  const corruptLookupState = clone(exactLookupState);
  corruptLookupState.glossarySenses.push({
    ...corruptLookupState.glossarySenses[0],
    id: "sense-state-corrupt",
  });
  await assert.rejects(
    createStore(corruptLookupState).lookupGlossarySelection({
      conversationScope: exactLookupScope,
      text: "state",
    }),
    /GLOSSARY_INVARIANT_VIOLATION/,
  );
  const zeroSenseLookupState = clone(exactLookupState);
  zeroSenseLookupState.glossarySenses = zeroSenseLookupState.glossarySenses
    .filter((sense) => sense.conceptId !== "concept-state");
  await assert.rejects(
    createStore(zeroSenseLookupState).lookupGlossarySelection({
      conversationScope: exactLookupScope,
      text: "state",
    }),
    /GLOSSARY_INVARIANT_VIOLATION/,
  );
  const deterministicLookupState = workspaceStore.createEmptyState(1);
  deterministicLookupState.conversations.push(clone(exactLookupState.conversations[0]));
  addLookupConcept(
    deterministicLookupState,
    "api-z",
    "API zeta",
    "зета",
    "Глобальная запись.",
    50,
  );
  addLookupConcept(
    deterministicLookupState,
    "api-a",
    "API alpha",
    "альфа",
    "Глобальная запись.",
    50,
  );
  addLookupConcept(
    deterministicLookupState,
    "api-attached",
    "API attached",
    "локальная",
    "Локальная запись.",
    10,
  );
  deterministicLookupState.glossaryLinks.push({
    id: "link-api-attached",
    senseId: "sense-api-attached",
    conversationId: "conversation-inline-lookup",
    linkKey: "sense-api-attached\u001fconversation-inline-lookup",
    localOrder: 0,
    firstSeenAt: 1,
    lastSeenAt: 1,
  });
  const deterministicLookup = await createStore(deterministicLookupState)
    .lookupGlossarySelection({ conversationScope: exactLookupScope, text: "API" });
  assert.equal(deterministicLookup.groups[0].exactMissing, true);
  assert.deepEqual(
    deterministicLookup.groups[0].entries.map((entry) => entry.id),
    ["sense-api-attached", "sense-api-a", "sense-api-z"],
  );
  await store.addAnalysisTerms([{
    term: "workflow",
    translation: "рабочий процесс",
    definition: "Последовательность действий.",
  }], tempScope);
  const localBeforeMove = await store.queryGlossary({ conversationScope: tempScope, mode: "local", query: "" });
  await store.moveGlossaryLink(localBeforeMove[1].id, localBeforeMove[0].id, tempScope);
  const localAfterMove = await store.queryGlossary({ conversationScope: tempScope, mode: "local", query: "" });
  assert.deepEqual(localAfterMove.map((item) => item.id), [localBeforeMove[1].id, localBeforeMove[0].id]);

  await store.attachGlossarySense(localAfterMove[0].id, stableOne.context.scopeKey);
  assert.equal((await store.queryGlossary({ conversationScope: stableOne.context.scopeKey, mode: "local", query: "" })).length, 1);
  await store.unlinkGlossary(localAfterMove[0].id, stableOne.context.scopeKey);
  assert.equal((await store.queryGlossary({ conversationScope: stableOne.context.scopeKey, mode: "local", query: "" })).length, 0);
  assert.equal((await store.queryGlossary({ conversationScope: stableOne.context.scopeKey, mode: "global", query: "state" })).length, 1);

  const replacementStore = createStore();
  const replacementOne = await replacementStore.ensureConversation(stable("replacement-one"));
  const replacementTwo = await replacementStore.ensureConversation(stable("replacement-two"));
  const originalReplacement = await replacementStore.addAnalysisTerms([{
    term: "state",
    translation: "состояние",
    definition: "Старое определение.",
  }], replacementOne.context.scopeKey);
  const candidateReplacement = await replacementStore.addAnalysisTerms([{
    term: "State",
    translation: "состояние",
    definition: "Исправленное определение.",
  }], replacementTwo.context.scopeKey);
  assert.equal(candidateReplacement.results[0].status, "replacementAvailable");
  assert.equal(candidateReplacement.results[0].replacementCandidate.targetSenseId, originalReplacement.results[0].id);
  assert.equal(candidateReplacement.results[0].savedEntry.definition, "Старое определение.");
  assert.equal(replacementStore.snapshot().glossarySenses.length, 1);
  assert.equal((await replacementStore.addAnalysisTerms([{
    term: "state",
    translation: "состояние",
    definition: "Исправленное определение.",
  }], replacementOne.context.scopeKey)).results[0].status, "replacementAvailable");
  await assert.rejects(
    replacementStore.replaceGlossarySense({
      senseId: originalReplacement.results[0].id,
    }, replacementOne.context.scopeKey),
    /INVALID_GLOSSARY_REPLACEMENT/,
  );
  await assert.rejects(
    replacementStore.replaceGlossarySense({
      senseId: originalReplacement.results[0].id,
      expectedUpdatedAt: "1000",
      replacement: { translation: "состояние", definition: "Исправленное определение." },
    }, replacementOne.context.scopeKey),
    /INVALID_GLOSSARY_REPLACEMENT/,
  );
  const stale = await replacementStore.replaceGlossarySense({
    senseId: originalReplacement.results[0].id,
    expectedUpdatedAt: -1,
    replacement: { translation: "состояние", definition: "Исправленное определение." },
  }, replacementOne.context.scopeKey);
  assert.equal(stale.ok, false);
  assert.equal(stale.stale, true);
  assert.equal(replacementStore.snapshot().glossaryLinks.length, 2);
  const beforeReplacement = replacementStore.snapshot();
  const replaced = await replacementStore.replaceGlossarySense({
    senseId: originalReplacement.results[0].id,
    expectedUpdatedAt: candidateReplacement.results[0].replacementCandidate.expectedUpdatedAt,
    replacement: candidateReplacement.results[0].replacementCandidate.proposed,
  }, replacementOne.context.scopeKey);
  assert.equal(replaced.ok, true);
  assert.equal(replaced.changed, true);
  assert.equal(replaced.entry.id, originalReplacement.results[0].id);
  assert.equal(replaced.entry.definition, "Исправленное определение.");
  const replacementState = replacementStore.snapshot();
  assert.equal(replacementState.glossarySenses.length, 1);
  assert.equal(replacementState.glossaryLinks.length, 2);
  assert.equal(new Set(replacementState.glossaryLinks.map((link) => link.conversationId)).size, 2);
  assert.equal(
    replacementState.glossarySenses[0].createdAt,
    beforeReplacement.glossarySenses[0].createdAt,
  );
  assert.deepEqual(
    replacementState.glossaryLinks,
    beforeReplacement.glossaryLinks,
    "in-place replacement preserves links and local order",
  );
  const idempotentReplacement = await replacementStore.replaceGlossarySense({
    senseId: originalReplacement.results[0].id,
    expectedUpdatedAt: replaced.entry.updatedAt,
    replacement: { translation: "состояние", definition: "Исправленное определение." },
  }, replacementOne.context.scopeKey);
  assert.equal(idempotentReplacement.changed, false);

  const firstSaved = await store.saveSelection("First line\n\nSecond line", tempScope);
  const duplicateSaved = await store.saveSelection("First line  \r\n\r\nSecond line", tempScope);
  assert.equal(firstSaved.item.id, duplicateSaved.item.id);
  assert.equal(duplicateSaved.changed, false);
  assert.equal(firstSaved.item.text, "First line\n\nSecond line");
  const secondSaved = await store.saveSelection("Another item", tempScope);
  assert.equal((await store.querySaved({ conversationScope: tempScope, mode: "local", query: "" })).length, 2);
  assert.equal((await store.querySaved({ conversationScope: tempScope, mode: "global", query: "" })).length, 0);
  assert.equal((await store.querySaved({ conversationScope: tempScope, mode: "global", query: "second" })).length, 1);
  await store.moveSavedLink(secondSaved.item.id, firstSaved.item.id, tempScope);
  assert.deepEqual(
    (await store.querySaved({ conversationScope: tempScope, mode: "local", query: "" })).map((item) => item.id),
    [secondSaved.item.id, firstSaved.item.id],
  );

  await store.addAnalysisTerms([
    { term: "state", translation: "состояние", definition: "Состояние workflow." },
  ], stableOne.context.scopeKey);
  await store.saveSelection("First line\n\nSecond line", stableOne.context.scopeKey);
  const rebound = await store.rebindConversation(tempScope, stable("one"));
  assert.equal(rebound.rebound, true);
  assert.equal(rebound.glossaryLinksMoved, 2);
  assert.equal(rebound.savedLinksMoved, 2);
  assert.equal((await store.rebindConversation(tempScope, stable("one"))).rebound, false);
  const reboundState = store.snapshot();
  assert.equal(reboundState.conversations.some((item) => item.scopeKey === tempScope), false);
  assert.equal(new Set(reboundState.glossaryLinks.map((item) => item.linkKey)).size, reboundState.glossaryLinks.length);
  assert.equal(new Set(reboundState.savedItemLinks.map((item) => item.linkKey)).size, reboundState.savedItemLinks.length);

  const stableOneLocal = await store.queryGlossary({ conversationScope: stableOne.context.scopeKey, mode: "local", query: "" });
  assert.equal(stableOneLocal.length, 2);
  assert.equal((await store.queryGlossary({ conversationScope: stableTwo.context.scopeKey, mode: "local", query: "" })).length, 0);

  const orphanScope = "temporary:orphaned-context";
  await store.ensureConversation(temporary("orphaned-context"));
  const orphanSaved = await store.saveSelection("Orphaned but global", orphanScope);
  const orphaned = await store.orphanConversation(orphanScope);
  assert.equal(orphaned.orphaned, true);
  assert.equal(orphaned.context.orphanedAt > 0, true);
  assert.equal((await store.querySaved({ conversationScope: stableTwo.context.scopeKey, mode: "global", query: "orphaned" }))[0].id, orphanSaved.item.id);
  assert.equal((await store.querySaved({ conversationScope: stableTwo.context.scopeKey, mode: "local", query: "" })).length, 0);

  const savedLocal = await store.querySaved({ conversationScope: stableOne.context.scopeKey, mode: "local", query: "" });
  const anotherSaved = savedLocal.find((item) => item.text === "Another item");
  await store.unlinkSaved(anotherSaved.id, stableOne.context.scopeKey);
  assert.equal((await store.querySaved({ conversationScope: stableOne.context.scopeKey, mode: "global", query: "another" })).length, 1);
  await store.deleteSavedItem(anotherSaved.id);
  assert.equal((await store.querySaved({ conversationScope: stableOne.context.scopeKey, mode: "global", query: "another" })).length, 0);

  const deleteSenseId = stableOneLocal[0].id;
  await store.deleteGlossarySense(deleteSenseId);
  assert.equal((await store.queryGlossary({ conversationScope: stableOne.context.scopeKey, mode: "global", query: "новое" })).length, 0);

  let adapterId = 0;
  let adapterClock = 5000;
  function createProductionAdapter(initialState) {
    const fake = createInstrumentedDatabase(initialState);
    const adapter = new workspaceStore.IndexedDbWorkspaceStore({
      createId(prefix) { adapterId += 1; return `${prefix}-adapter-${adapterId}`; },
      now() { adapterClock += 1; return adapterClock; },
    });
    adapter.databasePromise = Promise.resolve(fake.database);
    return { adapter, fake };
  }
  function conversationRecord(id, scopeKey) {
    return {
      id,
      scopeKey,
      kind: scopeKey.startsWith("temporary:") ? "temporary" : "stable",
      host: "chatgpt.com",
      remoteConversationId: scopeKey.startsWith("stable:") ? scopeKey.split(":").at(-1) : null,
      canonicalUrl: scopeKey.startsWith("stable:") ? `https://chatgpt.com/c/${scopeKey.split(":").at(-1)}` : null,
      createdAt: 1,
      lastSeenAt: 1,
      orphanedAt: null,
    };
  }

  function importBoundaryState() {
    const state = workspaceStore.createEmptyState(1);
    state.conversations.push(
      conversationRecord("conversation-import-primary", "stable:chatgpt.com:import-primary"),
    );
    const term = workspace.canonicalizeTerm("State");
    state.glossaryConcepts.push({
      id: "concept-import-state",
      displayTerm: term.displayTerm,
      canonicalTerm: term.canonicalTerm,
      normalizedKey: term.normalizedKey,
      createdAt: 10,
      updatedAt: 20,
    });
    state.glossarySenses.push({
      id: "sense-import-state",
      conceptId: "concept-import-state",
      translation: "состояние",
      definition: "Состояние системы.",
      normalizedTranslation: "состояние",
      normalizedDefinition: "состояние системы.",
      naturalKey: workspace.createSenseNaturalKey(
        "concept-import-state",
        "состояние",
        "Состояние системы.",
      ),
      createdAt: 10,
      updatedAt: 20,
    });
    return state;
  }

  function userStoresFrom(state) {
    return Object.fromEntries(
      workspaceStore.USER_STORE_NAMES.map((name) => [name, clone(state[name])]),
    );
  }

  async function assertImportFinalBoundary(label, adapter, snapshot) {
    const initial = clone(snapshot());
    const initialUserData = userStoresFrom(initial);
    const initialRevision = initial.meta.find((item) => item.key === "revision:all")?.value || 0;

    const duplicateSenseId = clone(initialUserData);
    const secondTerm = workspace.canonicalizeTerm("Route");
    duplicateSenseId.glossaryConcepts.push({
      id: "concept-import-route",
      displayTerm: secondTerm.displayTerm,
      canonicalTerm: secondTerm.canonicalTerm,
      normalizedKey: secondTerm.normalizedKey,
      createdAt: 10,
      updatedAt: 20,
    });
    duplicateSenseId.glossarySenses.push({
      ...clone(duplicateSenseId.glossarySenses[0]),
      conceptId: "concept-import-route",
      naturalKey: workspace.createSenseNaturalKey(
        "concept-import-route",
        "состояние",
        "Состояние системы.",
      ),
    });
    await assert.rejects(
      async () => adapter.replaceUserData(duplicateSenseId),
      /GLOSSARY_INVARIANT_VIOLATION/,
      `${label} rejects duplicate sense ids`,
    );
    assert.deepEqual(snapshot(), initial, `${label} duplicate-sense rejection is atomic`);

    const multipleSenses = clone(initialUserData);
    multipleSenses.glossarySenses.push({
      id: "sense-import-state-second",
      conceptId: "concept-import-state",
      translation: "режим",
      definition: "Другая версия состояния.",
      normalizedTranslation: "режим",
      normalizedDefinition: "другая версия состояния.",
      naturalKey: workspace.createSenseNaturalKey(
        "concept-import-state",
        "режим",
        "Другая версия состояния.",
      ),
      createdAt: 10,
      updatedAt: 20,
    });
    await assert.rejects(
      async () => adapter.replaceUserData(multipleSenses),
      /GLOSSARY_INVARIANT_VIOLATION/,
      `${label} Replace rejects two senses for one concept`,
    );
    assert.deepEqual(snapshot(), initial, `${label} multiplicity Replace is atomic`);
    await assert.rejects(
      async () => adapter.mergeUserData(multipleSenses),
      /GLOSSARY_INVARIANT_VIOLATION/,
      `${label} Merge rejects two senses for one concept`,
    );
    assert.deepEqual(snapshot(), initial, `${label} multiplicity Merge is atomic`);

    const forgedIdentity = clone(initialUserData);
    forgedIdentity.glossaryConcepts[0].normalizedKey = "forged-state";
    await assert.rejects(
      async () => adapter.replaceUserData(forgedIdentity),
      /GLOSSARY_INVARIANT_VIOLATION/,
      `${label} rejects forged canonical identity`,
    );
    assert.deepEqual(snapshot(), initial, `${label} forged-identity rejection is atomic`);

    const noOpReplace = await adapter.replaceUserData(initialUserData);
    assert.equal(noOpReplace.changed, false, `${label} identical Replace is a no-op`);
    assert.equal(noOpReplace.revision, initialRevision);
    assert.deepEqual(snapshot(), initial, `${label} identical Replace writes nothing`);

    const conflictingMerge = userStoresFrom(workspaceStore.createEmptyState(1));
    conflictingMerge.glossaryConcepts = [clone(initial.glossaryConcepts[0])];
    conflictingMerge.glossarySenses = [{
      ...clone(initial.glossarySenses[0]),
      definition: "Другая версия.",
      normalizedDefinition: "другая версия.",
      naturalKey: workspace.createSenseNaturalKey(
        "concept-import-state",
        "состояние",
        "Другая версия.",
      ),
    }];
    await assert.rejects(
      async () => adapter.mergeUserData(conflictingMerge),
      /GLOSSARY_IMPORT_CONFLICT/,
      `${label} rejects a conflicting Merge`,
    );
    assert.deepEqual(snapshot(), initial, `${label} conflicting Merge is atomic`);

    const equalLinksOnlyMerge = userStoresFrom(workspaceStore.createEmptyState(1));
    equalLinksOnlyMerge.conversations = [
      conversationRecord("conversation-import-second", "stable:chatgpt.com:import-second"),
    ];
    equalLinksOnlyMerge.glossaryConcepts = [{
      ...clone(initial.glossaryConcepts[0]),
      createdAt: 1,
      updatedAt: 999,
    }];
    equalLinksOnlyMerge.glossarySenses = [{
      ...clone(initial.glossarySenses[0]),
      createdAt: 1,
      updatedAt: 999,
    }];
    equalLinksOnlyMerge.glossaryLinks = [{
      id: "link-import-second",
      senseId: "sense-import-state",
      conversationId: "conversation-import-second",
      linkKey: "sense-import-state\u001fconversation-import-second",
      localOrder: 0,
      firstSeenAt: 30,
      lastSeenAt: 30,
    }];
    const equalMerge = await adapter.mergeUserData(equalLinksOnlyMerge);
    assert.equal(equalMerge.changed, true, `${label} equal-content Merge adds links`);
    const afterEqualMerge = snapshot();
    assert.deepEqual(
      afterEqualMerge.glossaryConcepts[0],
      initial.glossaryConcepts[0],
      `${label} preserves the local concept record`,
    );
    assert.deepEqual(
      afterEqualMerge.glossarySenses[0],
      initial.glossarySenses[0],
      `${label} preserves the local sense record`,
    );
    assert.equal(
      afterEqualMerge.glossaryLinks.some((link) => link.id === "link-import-second"),
      true,
      `${label} adds only the planned link`,
    );
  }

  const memoryImportBoundary = createStore(importBoundaryState());
  await assertImportFinalBoundary(
    "Memory",
    memoryImportBoundary,
    () => memoryImportBoundary.snapshot(),
  );
  const indexedImportFinalBoundary = createProductionAdapter(importBoundaryState());
  await assertImportFinalBoundary(
    "IndexedDB",
    indexedImportFinalBoundary.adapter,
    () => indexedImportFinalBoundary.fake.snapshot(),
  );

  const insertState = workspaceStore.createEmptyState(1);
  insertState.conversations.push(conversationRecord("conversation-local", "stable:chatgpt.com:adapter-local"));
  const insertBoundary = createProductionAdapter(insertState);
  const insertedItem = await insertBoundary.adapter.saveSelection("Targeted adapter item", "stable:chatgpt.com:adapter-local");
  assert.equal(insertedItem.ok, undefined);
  assert.equal(insertedItem.changed, true);
  assert.equal(insertBoundary.fake.instrumentation.calls.some((call) => call.operation === "clear"), false);
  assert.equal(insertBoundary.fake.instrumentation.calls.some((call) => call.operation === "getAll"), false);
  assert.deepEqual(
    [...new Set(insertBoundary.fake.instrumentation.calls
      .filter((call) => ["add", "put", "delete"].includes(call.operation))
      .map((call) => call.store))].sort(),
    ["meta", "savedItemLinks", "savedItems"],
  );

  const moveState = workspaceStore.createEmptyState(1);
  moveState.conversations.push(
    conversationRecord("conversation-move", "stable:chatgpt.com:adapter-move"),
    conversationRecord("conversation-unrelated", "stable:chatgpt.com:adapter-unrelated"),
  );
  moveState.savedItems.push(
    { id: "saved-a", text: "A", normalizedTextKey: "A", createdAt: 1, updatedAt: 1 },
    { id: "saved-b", text: "B", normalizedTextKey: "B", createdAt: 1, updatedAt: 1 },
    { id: "saved-unrelated", text: "U", normalizedTextKey: "U", createdAt: 1, updatedAt: 1 },
  );
  moveState.savedItemLinks.push(
    { id: "link-a", itemId: "saved-a", conversationId: "conversation-move", linkKey: "saved-a\u001fconversation-move", localOrder: 0, firstSeenAt: 1, lastSeenAt: 1 },
    { id: "link-b", itemId: "saved-b", conversationId: "conversation-move", linkKey: "saved-b\u001fconversation-move", localOrder: 1, firstSeenAt: 1, lastSeenAt: 1 },
    { id: "link-unrelated", itemId: "saved-unrelated", conversationId: "conversation-unrelated", linkKey: "saved-unrelated\u001fconversation-unrelated", localOrder: 0, firstSeenAt: 1, lastSeenAt: 1 },
  );
  const moveBoundary = createProductionAdapter(moveState);
  await moveBoundary.adapter.moveSavedLink("saved-b", "saved-a", "stable:chatgpt.com:adapter-move");
  const moveWrites = moveBoundary.fake.instrumentation.calls.filter((call) => ["put", "delete", "add"].includes(call.operation));
  assert.equal(moveWrites.some((call) => call.store === "savedItems" || call.store === "glossaryLinks"), false);
  assert.equal(moveWrites.some((call) => call.key === "link-unrelated"), false);
  assert.deepEqual(
    moveBoundary.fake.snapshot().savedItemLinks
      .filter((link) => link.conversationId === "conversation-move")
      .sort((left, right) => left.localOrder - right.localOrder)
      .map((link) => link.itemId),
    ["saved-b", "saved-a"],
  );

  const completedMigrationState = workspaceStore.createEmptyState(1);
  completedMigrationState.meta.find((item) => item.key === "v1GlossaryMigrationState").value = {
    status: "complete",
    sourceSchemaVersion: 1,
    sourceCount: 0,
    migratedCount: 0,
    skippedCount: 0,
  };
  const migrationBoundary = createProductionAdapter(completedMigrationState);
  assert.deepEqual(await migrationBoundary.adapter.initialize(), { ok: true, changed: false });
  assert.equal((await migrationBoundary.adapter.migrateLegacyGlossary([])).migrated, false);
  assert.deepEqual(migrationBoundary.fake.instrumentation.transactions.map((transaction) => ({
    storeNames: transaction.storeNames,
    mode: transaction.mode,
  })), [
    { storeNames: ["meta"], mode: "readonly" },
    { storeNames: ["meta", "glossaryConcepts", "glossarySenses"], mode: "readonly" },
  ]);
  assert.equal(migrationBoundary.fake.instrumentation.calls.some((call) => ["put", "add", "delete", "clear"].includes(call.operation)), false);
  const corruptCompletedMigrationState = clone(completedMigrationState);
  const corruptCompletedTerm = workspace.canonicalizeTerm("State");
  corruptCompletedMigrationState.glossaryConcepts.push({
    id: "concept-completed-corrupt",
    displayTerm: corruptCompletedTerm.displayTerm,
    canonicalTerm: corruptCompletedTerm.canonicalTerm,
    normalizedKey: corruptCompletedTerm.normalizedKey,
    createdAt: 1,
    updatedAt: 1,
  });
  for (const id of ["sense-completed-corrupt-a", "sense-completed-corrupt-b"]) {
    corruptCompletedMigrationState.glossarySenses.push({
      id,
      conceptId: "concept-completed-corrupt",
      translation: "состояние",
      definition: id.endsWith("-a") ? "Первая версия." : "Другая версия.",
      normalizedTranslation: "состояние",
      normalizedDefinition: id.endsWith("-a") ? "первая версия." : "другая версия.",
      naturalKey: workspace.createSenseNaturalKey(
        "concept-completed-corrupt",
        "состояние",
        id.endsWith("-a") ? "Первая версия." : "Другая версия.",
      ),
      createdAt: 1,
      updatedAt: 1,
    });
  }
  await assert.rejects(
    createStore(corruptCompletedMigrationState).migrateLegacyGlossary([]),
    /GLOSSARY_INVARIANT_VIOLATION/,
  );
  const indexedCorruptCompletedMigration = createProductionAdapter(
    corruptCompletedMigrationState,
  );
  await assert.rejects(
    indexedCorruptCompletedMigration.adapter.migrateLegacyGlossary([]),
    /GLOSSARY_INVARIANT_VIOLATION/,
  );
  assert.equal(indexedCorruptCompletedMigration.fake.instrumentation.calls.some((call) => (
    ["put", "add", "delete", "clear"].includes(call.operation)
  )), false);

  const queryState = workspaceStore.createEmptyState(1);
  queryState.conversations.push(conversationRecord("conversation-query", "stable:chatgpt.com:adapter-query"));
  queryState.glossaryConcepts.push({ id: "concept-query", displayTerm: "query", canonicalTerm: "query", normalizedKey: "query", createdAt: 1, updatedAt: 1 });
  queryState.glossarySenses.push({ id: "sense-query", conceptId: "concept-query", translation: "запрос", definition: "Описание.", normalizedTranslation: "запрос", normalizedDefinition: "описание.", naturalKey: workspace.createSenseNaturalKey("concept-query", "запрос", "Описание."), createdAt: 1, updatedAt: 1 });
  queryState.glossaryLinks.push({ id: "glossary-link-query", senseId: "sense-query", conversationId: "conversation-query", linkKey: "sense-query\u001fconversation-query", localOrder: 0, firstSeenAt: 1, lastSeenAt: 1 });
  const localQueryBoundary = createProductionAdapter(queryState);
  assert.equal((await localQueryBoundary.adapter.queryGlossary({
    conversationScope: "stable:chatgpt.com:adapter-query",
    mode: "local",
    query: "",
    limit: 2,
  })).length, 1);
  assert.equal(localQueryBoundary.fake.instrumentation.calls.some((call) => call.store === "savedItems" || call.store === "savedItemLinks" || call.store === "importBackups"), false);
  assert.equal(localQueryBoundary.fake.instrumentation.calls.some((call) => call.operation === "getAll"), false);

  const exactLookupBoundary = createProductionAdapter(exactLookupState);
  const indexedExactLookup = await exactLookupBoundary.adapter.lookupGlossarySelection({
    conversationScope: exactLookupScope,
    text: "State machine / unknown",
  });
  assert.deepEqual(indexedExactLookup, exactLookup);
  assert.deepEqual(
    indexedExactLookup.groups.flatMap((group) => group.entries.map((entry) => entry.id)),
    ["sense-state-machine", "sense-state"],
  );
  assert.deepEqual(
    exactLookupBoundary.fake.instrumentation.transactions.map((transaction) => transaction.mode),
    ["readonly"],
  );
  assert.equal(exactLookupBoundary.fake.instrumentation.calls.some((call) => (
    ["add", "put", "delete", "clear"].includes(call.operation)
  )), false);
  assert.equal(exactLookupBoundary.fake.instrumentation.calls.some((call) => (
    ["savedItems", "savedItemLinks", "importBackups", "meta"].includes(call.store)
  )), false);
  const indexedUnknown = await exactLookupBoundary.adapter.lookupGlossarySelection({
    conversationScope: exactLookupScope,
    text: "unknown",
  });
  assert.equal(indexedUnknown.groups.length, 0);
  assert.equal(indexedUnknown.missing[0].normalizedKey, "unknown");
  const indexedCandidateLimited = await exactLookupBoundary.adapter.lookupGlossarySelection({
    conversationScope: exactLookupScope,
    text: Array.from({ length: 70 }, (_, index) => `Api${index}`).join(" "),
  });
  const memoryCandidateLimited = await exactLookupStore.lookupGlossarySelection({
    conversationScope: exactLookupScope,
    text: Array.from({ length: 70 }, (_, index) => `Api${index}`).join(" "),
  });
  assert.deepEqual(indexedCandidateLimited, memoryCandidateLimited);
  assert.equal(indexedCandidateLimited.truncated.candidates, true);

  const indexedTruncatedBoundary = createProductionAdapter(truncatedState);
  const indexedTruncatedLookup = await indexedTruncatedBoundary.adapter.lookupGlossarySelection({
    conversationScope: exactLookupScope,
    text: "API",
  });
  assert.deepEqual(indexedTruncatedLookup, truncatedLookup);
  const indexedFairTruncation = createProductionAdapter(fairTruncationState);
  assert.deepEqual(
    await indexedFairTruncation.adapter.lookupGlossarySelection({
      conversationScope: exactLookupScope,
      text: "API / DTO",
    }),
    fairTruncationLookup,
  );

  const indexedCorruptBoundary = createProductionAdapter(corruptLookupState);
  await assert.rejects(
    indexedCorruptBoundary.adapter.lookupGlossarySelection({
      conversationScope: exactLookupScope,
      text: "state",
    }),
    /GLOSSARY_INVARIANT_VIOLATION/,
  );
  const indexedZeroSenseBoundary = createProductionAdapter(zeroSenseLookupState);
  await assert.rejects(
    indexedZeroSenseBoundary.adapter.lookupGlossarySelection({
      conversationScope: exactLookupScope,
      text: "state",
    }),
    /GLOSSARY_INVARIANT_VIOLATION/,
  );

  const indexedPersistenceState = workspaceStore.createEmptyState(1);
  const indexedPersistenceScope = "stable:chatgpt.com:indexed-persistence";
  indexedPersistenceState.conversations.push(
    conversationRecord("conversation-indexed-persistence", indexedPersistenceScope),
  );
  const indexedPersistence = createProductionAdapter(indexedPersistenceState);
  const indexedNew = await indexedPersistence.adapter.addAnalysisTerms([{
    term: "route",
    translation: "маршрут",
    definition: "Старое определение.",
  }], indexedPersistenceScope);
  const indexedProposal = await indexedPersistence.adapter.addAnalysisTerms([{
    term: "Route",
    translation: "маршрут",
    definition: "Новое определение.",
  }], indexedPersistenceScope);
  assert.equal(indexedNew.results[0].status, "new");
  assert.equal(indexedProposal.results[0].status, "replacementAvailable");
  assert.equal(indexedPersistence.fake.snapshot().glossarySenses.length, 1);
  const indexedBeforeReplacement = indexedPersistence.fake.snapshot();
  const indexedReplaced = await indexedPersistence.adapter.replaceGlossarySense({
    senseId: indexedNew.results[0].senseId,
    expectedUpdatedAt: indexedProposal.results[0].replacementCandidate.expectedUpdatedAt,
    replacement: indexedProposal.results[0].replacementCandidate.proposed,
  }, indexedPersistenceScope);
  assert.equal(indexedReplaced.changed, true);
  const indexedAfterReplacement = indexedPersistence.fake.snapshot();
  assert.equal(indexedAfterReplacement.glossarySenses.length, 1);
  assert.equal(indexedAfterReplacement.glossarySenses[0].id, indexedBeforeReplacement.glossarySenses[0].id);
  assert.equal(indexedAfterReplacement.glossarySenses[0].createdAt, indexedBeforeReplacement.glossarySenses[0].createdAt);
  assert.deepEqual(indexedAfterReplacement.glossaryLinks, indexedBeforeReplacement.glossaryLinks);
  const indexedIdempotent = await indexedPersistence.adapter.replaceGlossarySense({
    senseId: indexedNew.results[0].senseId,
    expectedUpdatedAt: indexedReplaced.entry.updatedAt,
    replacement: indexedProposal.results[0].replacementCandidate.proposed,
  }, indexedPersistenceScope);
  assert.equal(indexedIdempotent.changed, false);

  const globalQueryState = workspaceStore.createEmptyState(1);
  globalQueryState.conversations.push(conversationRecord("conversation-global", "stable:chatgpt.com:adapter-global"));
  for (let index = 0; index < 6; index += 1) {
    globalQueryState.savedItems.push({
      id: `global-${index}`,
      text: `matching item ${index}`,
      normalizedTextKey: `matching item ${index}`,
      createdAt: index + 1,
      updatedAt: index + 1,
    });
  }
  const globalQueryBoundary = createProductionAdapter(globalQueryState);
  assert.equal((await globalQueryBoundary.adapter.querySaved({
    conversationScope: "stable:chatgpt.com:adapter-global",
    mode: "global",
    query: "matching",
    limit: 2,
  })).length, 2);
  assert.equal(globalQueryBoundary.fake.instrumentation.calls.filter((call) => call.store === "savedItems" && call.operation === "cursor").length, 2);

  const glossaryLimitState = workspaceStore.createEmptyState(1);
  glossaryLimitState.conversations.push(conversationRecord("conversation-glossary-limit", "stable:chatgpt.com:adapter-glossary-limit"));
  for (let index = 0; index < 6; index += 1) {
    const conceptId = `concept-limit-${index}`;
    glossaryLimitState.glossaryConcepts.push({
      id: conceptId,
      displayTerm: `matching term ${index}`,
      canonicalTerm: `matching term ${index}`,
      normalizedKey: `matching term ${index}`,
      createdAt: index + 1,
      updatedAt: index + 1,
    });
    glossaryLimitState.glossarySenses.push({
      id: `sense-limit-${index}`,
      conceptId,
      translation: `перевод ${index}`,
      definition: `Описание ${index}.`,
      normalizedTranslation: `перевод ${index}`,
      normalizedDefinition: `описание ${index}.`,
      naturalKey: workspace.createSenseNaturalKey(conceptId, `перевод ${index}`, `Описание ${index}.`),
      createdAt: index + 1,
      updatedAt: index + 1,
    });
  }
  const glossaryLimitBoundary = createProductionAdapter(glossaryLimitState);
  assert.equal((await glossaryLimitBoundary.adapter.queryGlossary({
    conversationScope: "stable:chatgpt.com:adapter-glossary-limit",
    mode: "global",
    query: "matching",
    limit: 2,
  })).length, 2);
  assert.equal(glossaryLimitBoundary.fake.instrumentation.calls
    .filter((call) => call.store === "glossarySenses" && call.operation === "cursor").length, 2);

  const sparseGlobalState = workspaceStore.createEmptyState(1);
  sparseGlobalState.conversations.push(conversationRecord("conversation-sparse", "stable:chatgpt.com:adapter-sparse"));
  function addSparseGlossary(id, term, updatedAt) {
    const conceptId = `concept-${id}`;
    sparseGlobalState.glossaryConcepts.push({
      id: conceptId,
      displayTerm: term,
      canonicalTerm: term,
      normalizedKey: term,
      createdAt: updatedAt,
      updatedAt,
    });
    sparseGlobalState.glossarySenses.push({
      id: `sense-${id}`,
      conceptId,
      translation: `перевод ${id}`,
      definition: `Описание ${id}.`,
      normalizedTranslation: `перевод ${id}`,
      normalizedDefinition: `описание ${id}.`,
      naturalKey: workspace.createSenseNaturalKey(conceptId, `перевод ${id}`, `Описание ${id}.`),
      createdAt: updatedAt,
      updatedAt,
    });
  }
  for (let index = 0; index < 25; index += 1) {
    addSparseGlossary(`recent-${index}`, `unrelated term ${index}`, 1000 - index);
    sparseGlobalState.savedItems.push({
      id: `saved-recent-${index}`,
      text: `unrelated saved item ${index}`,
      normalizedTextKey: `unrelated saved item ${index}`,
      createdAt: 1000 - index,
      updatedAt: 1000 - index,
    });
  }
  addSparseGlossary("older-match-a", "needle glossary a", 2);
  addSparseGlossary("older-match-b", "needle glossary b", 1);
  addSparseGlossary("oldest-unrelated", "oldest unrelated glossary", 0);
  sparseGlobalState.savedItems.push(
    { id: "saved-older-match-a", text: "needle saved a", normalizedTextKey: "needle saved a", createdAt: 2, updatedAt: 2 },
    { id: "saved-older-match-b", text: "needle saved b", normalizedTextKey: "needle saved b", createdAt: 1, updatedAt: 1 },
    { id: "saved-oldest-unrelated", text: "oldest unrelated saved", normalizedTextKey: "oldest unrelated saved", createdAt: 0, updatedAt: 0 },
  );

  const emptyGlobalBoundary = createProductionAdapter(sparseGlobalState);
  assert.deepEqual(await emptyGlobalBoundary.adapter.queryGlossary({
    conversationScope: "stable:chatgpt.com:adapter-sparse",
    mode: "global",
    query: "   ",
    limit: 2,
  }), []);
  assert.deepEqual(await emptyGlobalBoundary.adapter.querySaved({
    conversationScope: "stable:chatgpt.com:adapter-sparse",
    mode: "global",
    query: "",
    limit: 2,
  }), []);
  assert.equal(emptyGlobalBoundary.fake.instrumentation.calls.some((call) => (
    ["glossarySenses", "savedItems"].includes(call.store) && call.operation === "openCursor"
  )), false);

  const sparseGlobalBoundary = createProductionAdapter(sparseGlobalState);
  const sparseGlossaryResults = await sparseGlobalBoundary.adapter.queryGlossary({
    conversationScope: "stable:chatgpt.com:adapter-sparse",
    mode: "global",
    query: "needle",
    limit: 2,
  });
  const sparseSavedResults = await sparseGlobalBoundary.adapter.querySaved({
    conversationScope: "stable:chatgpt.com:adapter-sparse",
    mode: "global",
    query: "needle",
    limit: 2,
  });
  assert.deepEqual(sparseGlossaryResults.map((item) => item.id), ["sense-older-match-a", "sense-older-match-b"]);
  assert.deepEqual(sparseSavedResults.map((item) => item.id), ["saved-older-match-a", "saved-older-match-b"]);
  assert.equal(sparseGlobalBoundary.fake.instrumentation.calls
    .filter((call) => call.store === "glossarySenses" && call.operation === "cursor").length, 27);
  assert.equal(sparseGlobalBoundary.fake.instrumentation.calls
    .filter((call) => call.store === "savedItems" && call.operation === "cursor").length, 27);

  const rebindState = workspaceStore.createEmptyState(1);
  rebindState.conversations.push(
    conversationRecord("conversation-temp", "temporary:adapter-temp"),
    conversationRecord("conversation-target", "stable:chatgpt.com:adapter-target"),
    conversationRecord("conversation-other", "stable:chatgpt.com:adapter-other"),
  );
  rebindState.glossaryLinks.push(
    { id: "rebind-glossary", senseId: "sense-rebind", conversationId: "conversation-temp", linkKey: "sense-rebind\u001fconversation-temp", localOrder: 1, firstSeenAt: 2, lastSeenAt: 3 },
    { id: "other-glossary", senseId: "sense-other", conversationId: "conversation-other", linkKey: "sense-other\u001fconversation-other", localOrder: 0, firstSeenAt: 1, lastSeenAt: 1 },
  );
  rebindState.savedItemLinks.push(
    { id: "rebind-saved", itemId: "saved-rebind", conversationId: "conversation-temp", linkKey: "saved-rebind\u001fconversation-temp", localOrder: 1, firstSeenAt: 2, lastSeenAt: 3 },
    { id: "other-saved", itemId: "saved-other", conversationId: "conversation-other", linkKey: "saved-other\u001fconversation-other", localOrder: 0, firstSeenAt: 1, lastSeenAt: 1 },
  );
  const rebindBoundary = createProductionAdapter(rebindState);
  const reboundAdapter = await rebindBoundary.adapter.rebindConversation("temporary:adapter-temp", stable("adapter-target"));
  assert.equal(reboundAdapter.rebound, true);
  const rebindWrites = rebindBoundary.fake.instrumentation.calls.filter((call) => ["put", "delete", "add"].includes(call.operation));
  assert.equal(rebindWrites.some((call) => ["other-glossary", "other-saved", "conversation-other"].includes(call.key)), false);
  assert.equal(rebindBoundary.fake.snapshot().conversations.some((conversation) => conversation.id === "conversation-temp"), false);
  assert.equal(rebindBoundary.fake.snapshot().glossaryLinks.find((link) => link.id === "rebind-glossary").conversationId, "conversation-target");
  assert.equal(rebindBoundary.fake.snapshot().savedItemLinks.find((link) => link.id === "rebind-saved").conversationId, "conversation-target");

  const importBoundary = createProductionAdapter(workspaceStore.createEmptyState(1));
  const indexedUserData = Object.fromEntries(workspaceStore.USER_STORE_NAMES.map((name) => [name, []]));
  indexedUserData.savedItems = [{ id: "indexed-import", text: "Indexed import", normalizedTextKey: "indexed import", createdAt: 1, updatedAt: 1 }];
  await importBoundary.adapter.putImportBackup("data", { workspace: indexedUserData, templates: [] });
  assert.equal((await importBoundary.adapter.getImportBackup("data")).kind, "data");
  assert.equal(importBoundary.fake.instrumentation.transactions.some((transaction) => (
    transaction.mode === "readwrite" && transaction.storeNames.length === 1 && transaction.storeNames[0] === "importBackups"
  )), true);
  importBoundary.fake.resetInstrumentation();
  const indexedMerge = await importBoundary.adapter.mergeUserData(indexedUserData);
  assert.equal(indexedMerge.changed, true);
  assert.equal(importBoundary.fake.instrumentation.calls.some((call) => call.operation === "clear"), false);
  assert.equal(importBoundary.fake.snapshot().savedItems.length, 1);
  assert.deepEqual(importBoundary.fake.instrumentation.transactions[0].storeNames, [
    "meta", "conversations", "glossaryConcepts", "glossarySenses", "glossaryLinks", "savedItems", "savedItemLinks",
  ]);
  importBoundary.fake.resetInstrumentation();
  const repeatedIndexedMerge = await importBoundary.adapter.mergeUserData(indexedUserData);
  assert.equal(repeatedIndexedMerge.changed, false);
  assert.equal(importBoundary.fake.instrumentation.calls.some((call) => ["add", "put", "clear", "delete"].includes(call.operation)), false);
  importBoundary.fake.resetInstrumentation();
  const timestampIndexedData = clone(indexedUserData);
  timestampIndexedData.savedItems[0].updatedAt = 2;
  const timestampIndexedMerge = await importBoundary.adapter.mergeUserData(timestampIndexedData);
  assert.equal(timestampIndexedMerge.changed, true);
  assert.deepEqual(
    importBoundary.fake.instrumentation.calls.filter((call) => ["add", "put", "clear", "delete"].includes(call.operation))
      .map((call) => [call.operation, call.store, call.key]),
    [["put", "savedItems", "indexed-import"], ["put", "meta", "revision:all"]],
  );
  importBoundary.fake.resetInstrumentation();
  const replacementUserData = Object.fromEntries(workspaceStore.USER_STORE_NAMES.map((name) => [name, []]));
  replacementUserData.savedItems = [{ id: "indexed-replace", text: "Indexed replace", normalizedTextKey: "indexed replace", createdAt: 2, updatedAt: 2 }];
  await importBoundary.adapter.replaceUserData(replacementUserData);
  assert.equal(importBoundary.fake.instrumentation.calls.filter((call) => call.operation === "clear").length, 6);
  assert.equal(importBoundary.fake.instrumentation.calls.some((call) => call.store === "importBackups"), false);
  assert.deepEqual(importBoundary.fake.snapshot().savedItems.map((item) => item.id), ["indexed-replace"]);
}

runStoreTests()
  .then(() => console.log("workspace logic ok"))
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
