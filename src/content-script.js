(function initChatGptHelperOverlay() {
  "use strict";

  const contract = globalThis.ChatGPTHelperAnalysisContract;
  const workspaceContract = globalThis.ChatGPTHelperWorkspaceContract;
  const conversationContextModule = globalThis.ChatGPTHelperConversationContext;
  const commandRegistry = globalThis.ChatGPTHelperCommandRegistry;
  const analysisControllerModule = globalThis.ChatGPTHelperAnalysisController;
  const translationControllerModule = globalThis.ChatGPTHelperTranslationController;
  const analysisUiModule = globalThis.ChatGPTHelperAnalysisUi;
  const workspaceUiModule = globalThis.ChatGPTHelperWorkspaceUi;
  const templateTree = globalThis.ChatGPTHelperTemplateTree;
  const chatGptDom = globalThis.ChatGPTTemplateDom;
  const GLOBAL_KEY = "__chatgptHelperOverlayV1__";
  const HOST_ID = "chatgpt-helper-overlay-root";
  const TOGGLE_MESSAGE = contract.MESSAGE_TYPES.TOGGLE_PANEL;
  const RECENT_HOVER_DELAY_MS = 500;
  const RECENT_CLOSE_DELAY_MS = 120;
  const TEMPLATE_PREVIEW_OPEN_DELAY_MS = 350;
  const TEMPLATE_PREVIEW_CLOSE_DELAY_MS = 120;
  const TEMPLATE_FOLDER_AUTO_EXPAND_MS = 600;
  const TEMPLATE_EDITOR_ERROR_ID = "template-editor-error";
  const TEMPLATE_FOCUS_RETURN_ACTIONS = new Set([
    "add-template",
    "add-folder",
    "add-template-in-folder",
    "add-folder-in-folder",
    "edit-node",
    "ask-node-delete",
  ]);
  const TEMPLATE_TOOLBAR_FOCUS_ACTIONS = ["add-template", "add-folder", "toggle-delete-mode"];
  const SIDEBAR_MOTION_DURATION_MS = 200;
  const SIDEBAR_MOTION_FALLBACK_PADDING_MS = 50;
  const VALID_THEMES = new Set(workspaceContract.VALID_THEMES);
  const SECTION_TITLES = {
    templates: "Шаблоны",
    analysis: "Анализ текста",
    saved: "Сохранённое",
    settings: "Настройки",
  };

  if (window[GLOBAL_KEY]?.ensureMounted) {
    window[GLOBAL_KEY].ensureMounted();
    return;
  }

  const ICONS = {
    templates: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 3.75h12A2.25 2.25 0 0 1 20.25 6v12A2.25 2.25 0 0 1 18 20.25H6A2.25 2.25 0 0 1 3.75 18V6A2.25 2.25 0 0 1 6 3.75Zm1.5 4.5h9m-9 3.75h9m-9 3.75H13"/></svg>',
    analysis: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4.75 19.25V12.5m4.75 6.75V7.75m4.75 11.5v-4.5M19 19.25V4.75"/></svg>',
    saved: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 4.75h12A1.25 1.25 0 0 1 19.25 6v13.25L12 16l-7.25 3.25V6A1.25 1.25 0 0 1 6 4.75Z"/></svg>',
    settings: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 8.25A3.75 3.75 0 1 1 12 15.75 3.75 3.75 0 0 1 12 8.25Zm8 3.75-1.9-1.1.05-.9-1.7-2.95-.8.46-1.56-.9V5.7h-3.4v.91l-1.56.9-.8-.46L6.62 10l.79.46v1.8l-.79.46 1.7 2.95.8-.46 1.56.9v.91h3.4v-.91l1.56-.9.8.46 1.7-2.95-.79-.46v-1.8Z"/></svg>',
    plus: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg>',
    trash: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 7h14m-9-3h4l1 3H9l1-3Zm-3 3 1 13h8l1-13M10 10v6m4-6v6"/></svg>',
    play: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m8 5 11 7-11 7V5Z"/></svg>',
    chevron: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m7 9 5 5 5-5"/></svg>',
    drag: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 6h.01M15 6h.01M9 12h.01M15 12h.01M9 18h.01M15 18h.01"/></svg>',
    quick: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m6 4 13 8-13 8V4Z"/></svg>',
    opener: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m15 6-6 6 6 6"/></svg>',
  };

  const state = {
    activeSection: "templates",
    open: false,
    shellPhase: "closed",
    shellMotionReady: false,
    shellRestoreFocus: false,
    shellTransitionController: null,
    templates: [],
    templateTreeUiState: { collapsedFolderIds: [] },
    templateTreeError: "",
    settings: workspaceContract.normalizeActiveSettings(),
    recentTemplateIds: [],
    editing: null,
    editorError: "",
    editorReturnFocusTarget: null,
    deleteReturnFocusTarget: null,
    pendingTemplateFocusTarget: null,
    deleteMode: false,
    templateDeleteId: null,
    folderDelete: { nodeId: null, phase: "closed" },
    templateTreeDrag: {
      draggingNodeId: null,
      intent: null,
      hoverFolderId: null,
      hoverTimer: null,
      temporarilyExpandedFolderIds: [],
      invalidError: null,
    },
    busyTemplateId: null,
    quickBusy: false,
    status: { kind: "", text: "" },
    glossaryEntries: [],
    glossaryRequestedMode: "local",
    glossarySearch: "",
    glossaryDraggingId: null,
    savedEntries: [],
    savedRequestedMode: "local",
    savedSearch: "",
    savedDraggingId: null,
    workspaceDelete: workspaceUiModule.closedWorkspaceDeleteState(),
    workspaceContext: null,
    workspaceStatus: { status: "loading", context: null, errorCode: null, message: null },
    workspaceClient: null,
    contextClient: null,
    glossaryRequestToken: 0,
    savedRequestToken: 0,
    keyConfigured: false,
    keyChecking: true,
    sidebarResizing: false,
    sidebarResizeCleanup: null,
    sidebarPreferredWidth: workspaceContract.DEFAULT_ACTIVE_SETTINGS.layout.sidebarWidth,
    sidebarWidthCommitToken: 0,
    sidebarWidthCommitPending: false,
    analysisBusy: false,
    translationBusy: false,
    analysisController: null,
    translationController: null,
    analysisUi: null,
    pageUrl: location.href,
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
    host: null,
    shadow: null,
    shell: null,
    sidebarFrame: null,
    rail: null,
    panel: null,
    sidebarHandle: null,
    opener: null,
    recentPopup: null,
    recentHoverTimer: null,
    recentCloseTimer: null,
    preview: {
      phase: "closed",
      templateId: null,
      source: null,
      anchor: null,
      openTimer: null,
      closeTimer: null,
      pointerInside: false,
    },
    previewLayer: null,
    previewName: null,
    previewIcon: null,
    previewBreadcrumb: null,
    previewAutoSend: null,
    previewContent: null,
    quickAction: null,
    wallpaper: null,
    title: null,
    body: null,
  };

  function normalizeSettings(value) {
    return workspaceContract.normalizeActiveSettings(value);
  }

  function normalizeRecentTemplateIds(value) {
    return templateTree.normalizeRecentTemplateIds(value, state.templates);
  }

  function templateTreeFailureMessage(error) {
    const detail = typeof error?.message === "string" && error.message.trim()
      ? ` ${error.message}`
      : "";
    return `Сохранённое дерево шаблонов повреждено или несовместимо.${detail} Откройте настройки расширения для экспорта или восстановления данных.`;
  }

  function templateMutationErrorText(error) {
    if (error?.code === templateTree.ERROR_CODES.INVALID_STORED_STATE) {
      return templateTreeFailureMessage(error);
    }
    if ([templateTree.ERROR_CODES.INVALID_PARENT, templateTree.ERROR_CODES.INVALID_PLACEMENT]
      .includes(error?.code)) {
      return "Целевое расположение больше недоступно. Обновите выбор и повторите.";
    }
    if ([templateTree.ERROR_CODES.CYCLE, templateTree.ERROR_CODES.INVALID_MOVE]
      .includes(error?.code)) {
      return "Нельзя вложить папку в саму себя или в её дочернюю папку.";
    }
    if (error?.code === templateTree.ERROR_CODES.DEPTH_EXCEEDED) {
      return "Перемещение превысит максимальную глубину из шести папок.";
    }
    if (error?.code === templateTree.ERROR_CODES.NOT_FOUND) {
      return "Шаблон или папка больше не существует. Данные обновлены в другой вкладке.";
    }
    return error?.message || "Не удалось сохранить шаблоны.";
  }

  function preserveEditorAfterTreeChange() {
    if (!state.editing?.id || templateTree.findNode(state.templates, state.editing.id)) return;
    state.editing = {
      ...state.editing,
      id: null,
      original: null,
      targetParentId: templateTree.findNode(state.templates, state.editing.targetParentId)?.kind
        === templateTree.NODE_KINDS.FOLDER
        ? state.editing.targetParentId
        : null,
    };
    state.editorError = "Исходный элемент был удалён в другой вкладке. Сохранение создаст новый элемент из этого черновика.";
  }

  function applyStoredTemplateTree(value, uiStateValue) {
    const prepared = templateTree.prepareStoredNodes(value === undefined ? [] : value);
    if (!prepared.ok) {
      state.templateTreeError = templateTreeFailureMessage(prepared.error);
      return false;
    }
    state.templates = prepared.nodes;
    preserveEditorAfterTreeChange();
    state.templateTreeUiState = templateTree.normalizeTreeUiState(
      uiStateValue === undefined ? state.templateTreeUiState : uiStateValue,
      state.templates,
    );
    state.recentTemplateIds = templateTree.normalizeRecentTemplateIds(
      state.recentTemplateIds,
      state.templates,
    );
    state.templateTreeError = "";
    return true;
  }

  function applyTemplateMutationResponse(response) {
    const validation = templateTree.validateTypedNodes(response?.templates);
    if (!validation.ok) {
      state.templateTreeError = templateTreeFailureMessage(validation.error);
      return false;
    }
    state.templates = validation.nodes;
    preserveEditorAfterTreeChange();
    state.recentTemplateIds = templateTree.normalizeRecentTemplateIds(
      response.recentTemplateIds,
      state.templates,
    );
    state.templateTreeUiState = templateTree.normalizeTreeUiState(
      response.templateTreeUiState,
      state.templates,
    );
    state.templateTreeError = "";
    reconcileTemplateDeleteState();
    return true;
  }

  function escapeHtml(value) {
    return String(value)
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#039;");
  }

  const TEMPLATE_ICON_TITLES = Object.freeze({
    folder: "Папка",
    document: "Документ",
    code: "Код",
    terminal: "Терминал",
    database: "База данных",
    checklist: "Список задач",
    chart: "Диаграмма",
    globe: "Глобус",
    translate: "Перевод",
    brain: "Идея",
    spark: "Искра",
    shield: "Защита",
    bug: "Ошибка",
    bookmark: "Закладка",
    rocket: "Запуск",
  });

  function trustedTemplateIcon(nodeOrIconKey, kindValue) {
    const node = nodeOrIconKey && typeof nodeOrIconKey === "object" ? nodeOrIconKey : null;
    return workspaceUiModule.trustedTemplateIcon(
      node ? node.iconKey : nodeOrIconKey,
      node ? node.kind : kindValue,
    );
  }

  function templateBreadcrumbNames(nodeId, includeNode) {
    return templateTree.breadcrumbs(state.templates, nodeId, { includeNode: includeNode === true })
      .map((node) => node.name);
  }

  function templateLocationLabel(nodeId) {
    const names = templateBreadcrumbNames(nodeId, false);
    return names.length ? `Корень / ${names.join(" / ")}` : "Корень";
  }

  function closedFolderDeleteState() {
    return { nodeId: null, phase: "closed" };
  }

  function reconcileTemplateDeleteState() {
    if (state.templateDeleteId
      && !templateTree.findNode(state.templates, state.templateDeleteId)) {
      state.templateDeleteId = null;
    }
    if (state.folderDelete.nodeId
      && !templateTree.findNode(state.templates, state.folderDelete.nodeId)) {
      state.folderDelete = closedFolderDeleteState();
    }
  }

  function clearTemplateDropIndicators() {
    state.shadow?.querySelectorAll(
      ".template-node-slot.is-drop-before, .template-node-slot.is-drop-after, .template-node-slot.is-drop-inside, .template-root-drop.is-drop-inside",
    ).forEach((element) => {
      element.classList.remove("is-drop-before", "is-drop-after", "is-drop-inside");
    });
  }

  function setTemplateRootDropZoneVisible(visible) {
    const rootTarget = state.shadow?.querySelector("[data-template-root-target]");
    if (visible === true) {
      state.body?.classList.add("is-template-tree-dragging");
      rootTarget?.classList.add("is-template-drag-visible");
      return;
    }
    state.body?.classList.remove("is-template-tree-dragging");
    rootTarget?.classList.remove("is-template-drag-visible", "is-drop-inside");
  }

  function clearTemplateHoverTimer() {
    if (state.templateTreeDrag.hoverTimer !== null) {
      clearTimeout(state.templateTreeDrag.hoverTimer);
    }
    state.templateTreeDrag.hoverTimer = null;
    state.templateTreeDrag.hoverFolderId = null;
  }

  function cleanupTemplateTreeDrag(options) {
    const preserveTemporary = options?.preserveTemporary === true;
    clearTemplateHoverTimer();
    clearTemplateDropIndicators();
    setTemplateRootDropZoneVisible(false);
    state.shadow?.querySelectorAll(".template-card.is-dragging")
      .forEach((element) => element.classList.remove("is-dragging"));
    state.templateTreeDrag.draggingNodeId = null;
    state.templateTreeDrag.intent = null;
    state.templateTreeDrag.invalidError = null;
    if (!preserveTemporary) {
      removeTemporaryTemplateExpansionMarkup();
      state.templateTreeDrag.temporarilyExpandedFolderIds = [];
    }
  }

  function effectiveCollapsedFolderIds() {
    const temporarilyExpanded = new Set(state.templateTreeDrag.temporarilyExpandedFolderIds);
    return state.templateTreeUiState.collapsedFolderIds
      .filter((id) => !temporarilyExpanded.has(id));
  }

  function editorOpen() {
    return state.editing !== null;
  }

  function setStatus(kind, text) {
    state.status = { kind: kind || "", text: text || "" };
    renderSection();
  }

  function setStatusInPlace(kind, text) {
    state.status = { kind: kind || "", text: text || "" };
    const statusView = state.body?.querySelector(".status");
    if (!statusView) {
      renderSection();
      return;
    }
    statusView.className = ["status", state.status.kind].filter(Boolean).join(" ");
    statusView.textContent = state.status.text;
  }

  function resetCopyFeedback(button) {
    if (!button) return;
    clearTimeout(button.copyFeedbackTimer);
    button.copyFeedbackTimer = null;
    button.classList.remove("is-copied");
    button.title = "Скопировать сохранённый текст";
    button.setAttribute("aria-label", "Скопировать сохранённый текст");
  }

  function showCopyFeedback(button) {
    resetCopyFeedback(button);
    button.classList.add("is-copied");
    button.title = "Скопировано";
    button.setAttribute("aria-label", "Скопировано");
    button.copyFeedbackTimer = setTimeout(function clearCopyFeedback() {
      if (button.isConnected) resetCopyFeedback(button);
    }, 1500);
  }

  function clearStatus() {
    state.status = { kind: "", text: "" };
  }

  function workspaceEntries(kind) {
    return kind === "glossary" ? state.glossaryEntries : state.savedEntries;
  }

  function workspaceMode(kind) {
    return workspaceUiModule.activeSearchMode(
      kind === "glossary" ? state.glossaryRequestedMode : state.savedRequestedMode,
    );
  }

  function findWorkspaceDeleteTrigger(kind, entryId) {
    return [...(state.body?.querySelectorAll('[data-action="workspace-delete-toggle"]') || [])]
      .find((button) => button.dataset.kind === kind && button.dataset.id === entryId) || null;
  }

  function closeWorkspaceDelete() {
    if (!workspaceUiModule.workspaceDeleteMenuOpen(state.workspaceDelete)
      && state.workspaceDelete.phase === "closed") return false;
    const wasOpen = workspaceUiModule.workspaceDeleteMenuOpen(state.workspaceDelete);
    state.workspaceDelete = workspaceUiModule.transitionWorkspaceDelete(
      state.workspaceDelete,
      { type: "close" },
    );
    return wasOpen;
  }

  function settleWorkspaceDelete() {
    state.workspaceDelete = workspaceUiModule.transitionWorkspaceDelete(
      state.workspaceDelete,
      { type: "settle" },
    );
  }

  function closeWorkspaceDeleteAndRender(restoreFocus) {
    const { kind, entryId } = state.workspaceDelete;
    if (!closeWorkspaceDelete()) return false;
    renderSection();
    if (restoreFocus) {
      const trigger = findWorkspaceDeleteTrigger(kind, entryId);
      if (trigger?.isConnected && !trigger.disabled) trigger.focus();
    }
    return true;
  }

  function reconcileWorkspaceDeleteEntry() {
    const deletion = state.workspaceDelete;
    if (deletion.phase === "closed" || !deletion.kind || !deletion.entryId) return;
    if (!workspaceUiModule.workspaceDeleteEntryPresent(deletion, workspaceEntries(deletion.kind))) {
      closeWorkspaceDelete();
    }
  }

  function handleUiError(error) {
    console.warn("ChatGPT Templates UI action failed.", error);
    setStatus("error", error?.message || "Не удалось выполнить действие.");
  }

  function styles() {
    return [
      ":host {",
      "  --sidebar-effective-width: 360px;",
      "  --rail-width: 48px;",
      "  --sidebar-motion-duration: 200ms;",
      "  --sidebar-motion-easing: cubic-bezier(.22, .8, .25, 1);",
      "  all: initial;",
      "  position: fixed;",
      "  inset: 0 0 auto auto;",
      "  z-index: 2147483646;",
      "  color-scheme: light dark;",
      "  pointer-events: none;",
      "}",
      "* { box-sizing: border-box; }",
      "button, input, textarea, select { font: inherit; }",
      "button { color: inherit; }",
      "[hidden] { display: none !important; }",
      ".shell {",
      "  --bg: #f5f7fa;",
      "  --surface: #ffffff;",
      "  --surface-hover: #eef2f6;",
      "  --text: #172033;",
      "  --muted: #667085;",
      "  --border: #d5dbe4;",
      "  --accent: #167b72;",
      "  --accent-contrast: #ffffff;",
      "  --danger: #b42318;",
      "  --scrollbar-track: color-mix(in srgb, var(--bg) 85%, transparent);",
      "  --scrollbar-thumb: color-mix(in srgb, var(--muted) 58%, transparent);",
      "  --scrollbar-thumb-hover: color-mix(in srgb, var(--muted) 82%, transparent);",
      "  --scrollbar-corner: var(--bg);",
      "  --separator-muted: color-mix(in srgb, var(--border) 65%, transparent);",
      "  --shadow: 0 18px 45px rgb(15 23 42 / 24%);",
      "  position: fixed;",
      "  top: 0;",
      "  right: 0;",
      "  bottom: 0;",
      "  z-index: 2;",
      "  width: var(--sidebar-effective-width);",
      "  min-width: 0;",
      "  font: 13px/1.45 system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;",
      "  color: var(--text);",
      "  pointer-events: none;",
      "}",
      ".sidebar-frame {",
      "  position: absolute;",
      "  inset: 0;",
      "  z-index: 2;",
      "  display: flex;",
      "  width: 100%;",
      "  min-width: 0;",
      "  transform: translateX(100%);",
      "  transition: transform var(--sidebar-motion-duration) var(--sidebar-motion-easing);",
      "  pointer-events: none;",
      "  will-change: transform;",
      "}",
      ".shell.phase-opening .sidebar-frame, .shell.phase-open .sidebar-frame { transform: translateX(0); }",
      ".shell.phase-open .sidebar-frame { box-shadow: var(--shadow); pointer-events: auto; }",
      ".shell.motion-disabled .sidebar-frame, .shell.is-resizing .sidebar-frame { transition: none !important; }",
      ".theme-graphite { --bg: #15171c; --surface: #1d2129; --surface-hover: #272d37; --text: #e8edf3; --muted: #a7b0bd; --border: #3a414d; --accent: #69d6c5; --accent-contrast: #11161c; --danger: #ff8b82; --scrollbar-track: #171a20; --scrollbar-thumb: #596271; --scrollbar-thumb-hover: #778394; --scrollbar-corner: #15171c; --separator-muted: #303641; }",
      ".theme-navy { --bg: #0b1220; --surface: #111c2e; --surface-hover: #182740; --text: #e5eefc; --muted: #9fb0ca; --border: #2a3c55; --accent: #55b7ff; --accent-contrast: #07111e; --danger: #ff8f8f; --scrollbar-track: #0d1727; --scrollbar-thumb: #425d7c; --scrollbar-thumb-hover: #5f7fa3; --scrollbar-corner: #0b1220; --separator-muted: #22344c; }",
      ".theme-violet { --bg: #14101d; --surface: #20162e; --surface-hover: #2d2040; --text: #f4edff; --muted: #b9aacb; --border: #4d3a67; --accent: #b58cff; --accent-contrast: #160e22; --danger: #ff96a8; --scrollbar-track: #181121; --scrollbar-thumb: #66517d; --scrollbar-thumb-hover: #8669a4; --scrollbar-corner: #14101d; --separator-muted: #3b2e4d; }",
      ".theme-gold { --bg: #0b0b0b; --surface: #202020; --surface-hover: #2b2b2b; --text: #f4f4f0; --muted: #bdb9a6; --border: rgb(219 201 0 / 48%); --accent: rgba(219, 201, 0, 1); --accent-contrast: #090909; --danger: #ff8f85; --scrollbar-track: #11110d; --scrollbar-thumb: #746d36; --scrollbar-thumb-hover: #9b9141; --scrollbar-corner: #0b0b0b; --separator-muted: rgb(219 201 0 / 28%); }",
      ".rail {",
      "  position: relative;",
      "  z-index: 3;",
      "  display: flex;",
      "  height: 100%;",
      "  flex: 0 0 var(--rail-width);",
      "  padding: 10px 6px;",
      "  flex-direction: column;",
      "  align-items: center;",
      "  justify-content: center;",
      "  gap: 8px;",
      "  border-left: 1px solid var(--border);",
      "  background: color-mix(in srgb, var(--surface) 94%, transparent);",
      "  box-shadow: -4px 0 14px rgb(15 23 42 / 10%);",
      "  backdrop-filter: blur(10px);",
      "  pointer-events: none;",
      "}",
      ".icon-button, .rail-button, .compact-button, .quick-action, .panel-opener, .folder-toggle {",
      "  display: inline-grid;",
      "  place-items: center;",
      "  margin: 0;",
      "  padding: 0;",
      "  border: 1px solid transparent;",
      "  border-radius: 9px;",
      "  background: transparent;",
      "  cursor: pointer;",
      "}",
      ".rail-button { width: 36px; height: 36px; color: var(--muted); }",
      ".rail-button:hover, .icon-button:hover, .compact-button:hover, .folder-toggle:hover { background: var(--surface-hover); color: var(--text); }",
      ".rail-button.is-active { border-color: color-mix(in srgb, var(--accent) 60%, var(--border)); background: color-mix(in srgb, var(--accent) 15%, var(--surface)); color: var(--accent); }",
      "button:focus-visible, input:focus-visible, textarea:focus-visible, select:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }",
      "button:disabled { cursor: wait; opacity: .55; }",
      "svg { width: 18px; height: 18px; fill: none; stroke: currentColor; stroke-width: 1.8; stroke-linecap: round; stroke-linejoin: round; }",
      ".panel {",
      "  position: relative;",
      "  z-index: 2;",
      "  min-width: 0;",
      "  height: 100%;",
      "  flex: 1 1 auto;",
      "  overflow: hidden;",
      "  border-left: 1px solid var(--border);",
      "  background: var(--bg);",
      "  pointer-events: none;",
      "}",
      ".phase-open .rail, .phase-open .panel, .phase-open .panel-resize { pointer-events: auto; }",
      ".panel-resize { position: absolute; top: 0; bottom: 0; left: 0; z-index: 5; width: 10px; cursor: ew-resize; touch-action: none; outline: 0; pointer-events: none; }",
      ".panel-resize::after { content: ''; position: absolute; top: 0; bottom: 0; left: 0; width: 1px; background: transparent; transition: background 120ms ease; }",
      ".panel-resize:hover::after, .panel-resize:focus-visible::after, .panel-resize.is-resizing::after { background: var(--accent); }",
      ".panel-wallpaper, .panel-scrim { position: absolute; inset: 0; pointer-events: none; }",
      ".panel-wallpaper { background-position: center; background-size: cover; opacity: .58; }",
      ".panel-scrim { background: color-mix(in srgb, var(--bg) 90%, transparent); }",
      ".has-wallpaper .panel-scrim { background: color-mix(in srgb, var(--bg) 76%, transparent); backdrop-filter: blur(1px); }",
      ".panel-content { position: relative; z-index: 1; display: grid; min-width: 0; max-width: 100%; height: 100%; grid-template-rows: auto minmax(0, 1fr); }",
      ".panel-header { display: flex; min-height: 58px; padding: 16px 18px 12px; align-items: center; border-bottom: 1px solid var(--border); }",
      ".panel-title { margin: 0; font-size: 17px; font-weight: 680; letter-spacing: -.01em; }",
      ".panel-body { min-width: 0; max-width: 100%; min-height: 0; overflow: auto; padding: 16px; }",
      ".panel-body.is-template-tree-dragging { display: flex; flex-direction: column; }",
      ".panel-body, .recent-popup { scrollbar-width: thin; scrollbar-color: var(--scrollbar-thumb) var(--scrollbar-track); scrollbar-gutter: stable; }",
      ".panel-body::-webkit-scrollbar, .recent-popup::-webkit-scrollbar { width: 10px; height: 10px; }",
      ".panel-body::-webkit-scrollbar-track, .recent-popup::-webkit-scrollbar-track { background: var(--scrollbar-track); }",
      ".panel-body::-webkit-scrollbar-thumb, .recent-popup::-webkit-scrollbar-thumb { border: 2px solid var(--scrollbar-track); border-radius: 999px; background: var(--scrollbar-thumb); }",
      ".panel-body::-webkit-scrollbar-thumb:hover, .recent-popup::-webkit-scrollbar-thumb:hover { background: var(--scrollbar-thumb-hover); }",
      ".panel-body::-webkit-scrollbar-corner, .recent-popup::-webkit-scrollbar-corner { background: var(--scrollbar-corner); }",
      ".quick-action {",
      "  position: fixed;",
      "  right: 40px;",
      "  bottom: 33px;",
      "  z-index: 4;",
      "  width: 38px;",
      "  height: 38px;",
      "  border-color: color-mix(in srgb, var(--accent) 70%, transparent);",
      "  border-radius: 50%;",
      "  background: var(--accent);",
      "  color: var(--accent-contrast);",
      "  box-shadow: 0 6px 18px rgb(15 23 42 / 25%);",
      "  opacity: 0;",
      "  transform: scale(.8);",
      "  pointer-events: none;",
      "  transition: opacity var(--sidebar-motion-duration) var(--sidebar-motion-easing), transform var(--sidebar-motion-duration) var(--sidebar-motion-easing), background 120ms ease;",
      "}",
      ".phase-revealing-opener .quick-action, .phase-closed .quick-action { opacity: 1; transform: scale(1); }",
      ".phase-closed .quick-action { pointer-events: auto; }",
      ".motion-disabled .quick-action { transition: none !important; }",
      ".quick-action:hover { background: color-mix(in srgb, var(--accent) 86%, var(--text)); }",
      ".quick-action svg { width: 17px; height: 17px; fill: currentColor; stroke: none; margin-left: 2px; }",
      ".panel-opener {",
      "  position: fixed;",
      "  right: 0;",
      "  bottom: 92px;",
      "  z-index: 4;",
      "  width: 36px;",
      "  height: 44px;",
      "  border-color: color-mix(in srgb, var(--accent) 70%, transparent);",
      "  border-right: 0;",
      "  border-radius: 12px 0 0 12px;",
      "  background: var(--accent);",
      "  color: var(--accent-contrast);",
      "  box-shadow: -5px 5px 16px rgb(15 23 42 / 24%);",
      "  transform: translateX(100%);",
      "  transition: transform var(--sidebar-motion-duration) var(--sidebar-motion-easing), background 120ms ease;",
      "  pointer-events: none;",
      "}",
      ".phase-revealing-opener .panel-opener, .phase-closed .panel-opener { transform: translateX(0); }",
      ".phase-closed .panel-opener { pointer-events: auto; }",
      ".motion-disabled .panel-opener { transition: none !important; }",
      ".panel-opener:hover { background: color-mix(in srgb, var(--accent) 86%, var(--text)); }",
      ".panel-opener svg { width: 18px; height: 18px; stroke-width: 2.2; }",
      ".recent-popup {",
      "  position: fixed;",
      "  right: 36px;",
      "  bottom: 92px;",
      "  z-index: 5;",
      "  display: grid;",
      "  width: min(230px, calc(100vw - 52px));",
      "  padding: 6px;",
      "  gap: 3px;",
      "  border: 1px solid var(--border);",
      "  border-radius: 10px;",
      "  background: var(--surface);",
      "  box-shadow: var(--shadow);",
      "  pointer-events: auto;",
      "  animation: recent-popup-in 120ms ease-out;",
      "}",
      ".recent-template-button {",
      "  display: grid;",
      "  width: 100%;",
      "  min-height: 34px;",
      "  margin: 0;",
      "  padding: 7px 9px;",
      "  overflow: hidden;",
      "  border: 0;",
      "  border-radius: 7px;",
      "  background: transparent;",
      "  color: var(--text);",
      "  cursor: pointer;",
      "  font-weight: 600;",
      "  text-align: left;",
      "  grid-template-columns: auto minmax(0, 1fr);",
      "  align-items: center;",
      "  gap: 8px;",
      "}",
      ".recent-template-button:hover { background: var(--surface-hover); }",
      ".recent-template-icon, .template-node-icon, .template-preview-icon { display: grid; width: 20px; height: 20px; place-items: center; color: var(--accent); }",
      ".recent-template-icon svg, .template-node-icon svg, .template-preview-icon svg { width: 18px; height: 18px; }",
      ".recent-template-copy { min-width: 0; }",
      ".recent-template-name { display: block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }",
      ".recent-template-path { display: block; overflow: hidden; color: var(--muted); font-size: 10px; font-weight: 500; text-overflow: ellipsis; white-space: nowrap; }",
      "@keyframes recent-popup-in { from { opacity: 0; transform: translateX(4px); } }",
      ".template-preview {",
      "  position: fixed;",
      "  z-index: 7;",
      "  display: grid;",
      "  width: min(380px, calc(100vw - 24px));",
      "  max-width: calc(100vw - 24px);",
      "  max-height: min(420px, 60vh);",
      "  padding: 12px;",
      "  gap: 8px;",
      "  overflow: auto;",
      "  border: 1px solid var(--border);",
      "  border-radius: 10px;",
      "  background: var(--surface);",
      "  color: var(--text);",
      "  box-shadow: var(--shadow);",
      "  pointer-events: auto;",
      "}",
      ".template-preview-header { display: grid; min-width: 0; grid-template-columns: auto minmax(0, 1fr) auto; align-items: center; gap: 8px; }",
      ".template-preview-heading { min-width: 0; }",
      ".template-preview-name { display: block; min-width: 0; overflow-wrap: anywhere; }",
      ".template-preview-breadcrumb { display: block; overflow: hidden; color: var(--muted); font-size: 11px; text-overflow: ellipsis; white-space: nowrap; }",
      ".template-preview-auto { flex: 0 0 auto; padding: 2px 6px; border-radius: 999px; background: color-mix(in srgb, var(--accent) 16%, var(--surface)); color: var(--accent); font-size: 11px; font-weight: 700; }",
      ".template-preview-content { min-width: 0; margin: 0; overflow-wrap: anywhere; white-space: pre-wrap; }",
      ".section-toolbar { display: flex; margin-bottom: 14px; align-items: center; justify-content: space-between; gap: 10px; }",
      ".template-toolbar-actions { display: flex; min-width: 0; flex-wrap: wrap; gap: 7px; }",
      ".button {",
      "  display: inline-flex;",
      "  min-height: 34px;",
      "  padding: 7px 11px;",
      "  align-items: center;",
      "  justify-content: center;",
      "  gap: 7px;",
      "  border: 1px solid var(--border);",
      "  border-radius: 8px;",
      "  background: var(--surface);",
      "  color: var(--text);",
      "  cursor: pointer;",
      "}",
      ".button:hover { border-color: color-mix(in srgb, var(--accent) 55%, var(--border)); background: var(--surface-hover); }",
      ".button.primary { border-color: var(--accent); background: var(--accent); color: var(--accent-contrast); }",
      ".button.danger, .text-danger { color: var(--danger); }",
      ".button svg { width: 15px; height: 15px; }",
      ".compact-button { width: 34px; height: 34px; border-color: var(--border); background: var(--surface); }",
      ".compact-button.is-active { border-color: var(--danger); color: var(--danger); }",
      ".templates-list { display: grid; min-width: 0; max-width: 100%; gap: 9px; }",
      ".template-node-slot { --template-depth: 0; --template-indent: 0px; position: relative; display: grid; min-width: 0; margin-inline-start: var(--template-indent); gap: 7px; }",
      ".template-children { display: grid; min-width: 0; gap: 7px; }",
      ".template-card { min-width: 0; max-width: 100%; overflow: hidden; border: 1px solid var(--border); border-radius: 10px; background: color-mix(in srgb, var(--surface) 94%, transparent); }",
      ".template-card.is-dragging { opacity: .5; }",
      ".template-node-slot.is-drop-before::before, .template-node-slot.is-drop-after::after { content: ''; position: absolute; right: 0; left: 0; z-index: 3; height: 2px; border-radius: 999px; background: var(--accent); box-shadow: 0 0 0 1px color-mix(in srgb, var(--accent) 25%, transparent); }",
      ".template-node-slot.is-drop-before::before { top: -5px; }",
      ".template-node-slot.is-drop-after::after { bottom: -5px; }",
      ".template-node-slot.is-drop-inside > .template-card, .template-root-drop.is-drop-inside { border-color: var(--accent); background: color-mix(in srgb, var(--accent) 14%, var(--surface)); }",
      ".template-summary { display: grid; min-height: 48px; padding: 6px 7px; grid-template-columns: minmax(0, 1fr) auto; align-items: center; gap: 7px; }",
      ".template-preview-hotspot { display: grid; min-width: 0; min-height: 34px; grid-template-columns: auto minmax(0, 1fr); align-items: center; gap: 7px; }",
      ".template-title-wrap { display: grid; min-width: 0; grid-template-columns: auto minmax(0, 1fr); align-items: center; gap: 6px; }",
      ".folder-main { display: grid; min-width: 0; min-height: 34px; grid-template-columns: auto auto auto minmax(0, 1fr); align-items: center; gap: 6px; }",
      ".drag-handle { display: grid; width: 25px; height: 34px; place-items: center; color: var(--muted); cursor: grab; border-radius: 6px; }",
      ".drag-handle:active { cursor: grabbing; }",
      ".drag-handle svg { width: 16px; height: 16px; stroke-width: 3; }",
      ".template-name { overflow: hidden; font-weight: 620; text-overflow: ellipsis; white-space: nowrap; }",
      ".template-controls { display: flex; align-items: center; gap: 4px; }",
      ".folder-toggle { width: 26px; height: 31px; color: var(--muted); }",
      ".folder-toggle svg { transition: transform 120ms ease; }",
      ".folder-toggle[aria-expanded='true'] svg { transform: rotate(180deg); }",
      ".icon-button { width: 31px; height: 31px; color: var(--muted); }",
      ".icon-button svg { width: 16px; height: 16px; }",
      ".icon-button.run { color: var(--accent); }",
      ".icon-button.expanded svg { transform: rotate(180deg); }",
      ".auto-send { display: inline-flex; min-height: 31px; padding: 0 3px; align-items: center; gap: 4px; color: var(--muted); cursor: pointer; }",
      ".auto-send input { width: 15px; height: 15px; margin: 0; accent-color: var(--accent); }",
      ".auto-send span { font-size: 11px; }",
      ".editor { display: grid; min-width: 0; max-width: 100%; padding: 12px; gap: 10px; border-top: 1px solid var(--border); background: color-mix(in srgb, var(--bg) 74%, transparent); }",
      ".new-editor { margin-bottom: 12px; overflow: hidden; border: 1px solid var(--border); border-radius: 10px; }",
      ".field { display: grid; min-width: 0; max-width: 100%; gap: 5px; }",
      ".field > span { color: var(--muted); font-size: 12px; font-weight: 600; }",
      ".icon-picker { display: grid; grid-template-columns: repeat(5, minmax(0, 1fr)); gap: 6px; }",
      ".icon-option { display: grid; min-width: 0; min-height: 34px; padding: 5px; place-items: center; border: 1px solid var(--border); border-radius: 7px; background: var(--surface); color: var(--muted); cursor: pointer; }",
      ".icon-option[aria-pressed='true'] { border-color: var(--accent); background: color-mix(in srgb, var(--accent) 14%, var(--surface)); color: var(--accent); }",
      ".icon-option svg { width: 18px; height: 18px; }",
      ".location-select { min-height: 36px; padding: 7px 9px; }",
      ".editor-auto-send { display: inline-flex; align-items: center; gap: 7px; color: var(--text); }",
      ".input { width: 100%; min-width: 0; max-width: 100%; overflow-wrap: anywhere; border: 1px solid var(--border); border-radius: 7px; background: var(--surface); color: var(--text); }",
      "input.input { min-height: 36px; padding: 7px 9px; }",
      "textarea.input { min-height: 112px; padding: 8px 9px; resize: vertical; line-height: 1.45; }",
      ".editor-actions, .confirm-actions { display: flex; justify-content: flex-end; gap: 8px; }",
      ".inline-error, .status { min-height: 18px; margin: 0; font-size: 12px; overflow-wrap: anywhere; }",
      ".inline-error, .status.error { color: var(--danger); }",
      ".status.success { color: var(--accent); }",
      ".status { margin-top: 12px; color: var(--muted); }",
      ".delete-confirm { display: flex; padding: 8px 10px 11px; align-items: center; justify-content: space-between; gap: 10px; border-top: 1px solid var(--border); color: var(--muted); }",
      ".folder-delete-confirm { display: grid; gap: 9px; }",
      ".folder-delete-confirm .confirm-actions { flex-wrap: wrap; }",
      ".folder-delete-copy { margin: 0; font-size: 12px; }",
      ".folder-delete-stats { color: var(--text); font-weight: 650; }",
      ".delete-confirm .button { min-height: 29px; padding: 4px 9px; }",
      ".template-root-drop { display: none; min-width: 0; padding: 12px; align-items: center; justify-content: center; border: 1px dashed var(--border); border-radius: 8px; color: var(--muted); font-size: 12px; text-align: center; }",
      ".template-root-drop.is-template-drag-visible { display: flex; min-height: 96px; flex: 1 0 96px; }",
      ".template-tree-failure { display: grid; gap: 10px; }",
      ".empty-state, .placeholder { margin: 0; padding: 22px 14px; border: 1px dashed var(--border); border-radius: 10px; color: var(--muted); text-align: center; background: color-mix(in srgb, var(--surface) 70%, transparent); }",
      ".settings-group { display: grid; margin: 0; padding: 0 0 18px; gap: 9px; }",
      ".settings-group + .settings-group { padding-top: 18px; border-top: 1px solid var(--separator-muted); }",
      ".settings-group h3 { margin: 0; font-size: 14px; }",
      ".settings-group h4 { margin: 4px 0 0; font-size: 12px; color: var(--muted); }",
      ".command-list { display: grid; margin: 0; padding-left: 20px; gap: 5px; color: var(--text); }",
      ".theme-option { display: flex; min-height: 38px; padding: 8px 10px; align-items: center; gap: 9px; border: 1px solid var(--border); border-radius: 8px; background: color-mix(in srgb, var(--surface) 92%, transparent); cursor: pointer; }",
      ".theme-option input { margin: 0; accent-color: var(--accent); }",
      ".settings-help { margin: 0; color: var(--muted); font-size: 12px; }",
      ".setting-option { display: flex; min-height: 38px; padding: 8px 10px; align-items: center; gap: 9px; border: 1px solid var(--border); border-radius: 8px; background: color-mix(in srgb, var(--surface) 92%, transparent); cursor: pointer; }",
      ".setting-option input { margin: 0; accent-color: var(--accent); }",
      ".recent-count-option { justify-content: space-between; cursor: default; }",
      ".compact-select { min-width: 58px; min-height: 30px; padding: 3px 7px; border: 1px solid var(--border); border-radius: 7px; background: var(--surface); color: var(--text); }",
      ".file-input { width: 100%; color: var(--muted); }",
      ".file-input::file-selector-button { margin-right: 9px; padding: 7px 10px; border: 1px solid var(--border); border-radius: 7px; background: var(--surface); color: var(--text); cursor: pointer; }",
      "@media (prefers-color-scheme: dark) {",
      "  .theme-system { --bg: #17191d; --surface: #22262d; --surface-hover: #2c323b; --text: #edf1f7; --muted: #aab2bf; --border: #3c434e; --accent: #66cfc0; --accent-contrast: #101514; --danger: #ff938c; }",
      "}",
      "@media (prefers-reduced-motion: reduce) { .sidebar-frame, .panel-opener, .quick-action { transition: none; } .recent-popup { animation: none; } }",
      analysisUiModule.styles(),
      workspaceUiModule.styles(),
    ].join("\n");
  }

  function shellMarkup() {
    return [
      '<style>' + styles() + '</style>',
      '<div class="shell theme-system phase-closed motion-disabled">',
      '  <button class="quick-action" type="button" data-action="quick-next" title="Отправить «Далее», если поле пусто" aria-label="Отправить «Далее», если поле пусто">' + ICONS.quick + '</button>',
      '  <button class="panel-opener" type="button" data-action="open-panel" title="Открыть меню шаблонов" aria-label="Открыть меню шаблонов" aria-haspopup="menu" aria-expanded="false">' + ICONS.opener + '</button>',
      '  <div class="recent-popup" role="menu" aria-label="Последние запущенные шаблоны" hidden></div>',
      '  <aside class="template-preview" aria-label="Предпросмотр шаблона" hidden>',
      '    <div class="template-preview-header"><span class="template-preview-icon" aria-hidden="true"></span><span class="template-preview-heading"><strong class="template-preview-name"></strong><span class="template-preview-breadcrumb"></span></span><span class="template-preview-auto" hidden>Автоотправка</span></div>',
      '    <p class="template-preview-content"></p>',
      '  </aside>',
      '  <div class="sidebar-frame" aria-hidden="true">',
      '    <div class="panel-resize" role="separator" aria-label="Изменить ширину панели" aria-orientation="vertical" aria-valuemin="320" aria-valuemax="720" aria-valuenow="360" tabindex="-1" hidden></div>',
      '    <nav class="rail" aria-label="Разделы chatgpt-helper" hidden>',
      '    <button class="rail-button" type="button" data-section="templates" title="Шаблоны" aria-label="Шаблоны">' + ICONS.templates + '</button>',
      '    <button class="rail-button" type="button" data-section="analysis" title="Анализ текста" aria-label="Анализ текста">' + ICONS.analysis + '</button>',
      '    <button class="rail-button" type="button" data-section="saved" title="Сохранённое" aria-label="Сохранённое">' + ICONS.saved + '</button>',
      '    <button class="rail-button" type="button" data-section="settings" title="Настройки" aria-label="Настройки">' + ICONS.settings + '</button>',
      '    </nav>',
      '    <section class="panel" aria-label="chatgpt-helper" hidden>',
      '    <div class="panel-wallpaper" aria-hidden="true"></div>',
      '    <div class="panel-scrim" aria-hidden="true"></div>',
      '    <div class="panel-content">',
      '      <header class="panel-header"><h2 class="panel-title"></h2></header>',
      '      <main class="panel-body"></main>',
      '    </div>',
      '    </section>',
      '  </div>',
      '</div>',
    ].join("");
  }

  function applyShellState() {
    if (!state.shell) return;
    const phase = state.shellPhase;
    const frameVisible = phase === "opening" || phase === "open" || phase === "closing";
    const frameInteractive = phase === "open" && !state.sidebarResizing;
    state.open = phase !== "closed";
    const effectiveSidebarWidth = workspaceContract.effectiveWidth(
      "sidebarWidth",
      state.sidebarPreferredWidth,
      window.innerWidth,
    );
    state.host?.style.setProperty("--sidebar-effective-width", `${effectiveSidebarWidth}px`);
    if (state.sidebarHandle) {
      state.sidebarHandle.setAttribute("aria-valuenow", String(effectiveSidebarWidth));
    }
    state.shell.className = "shell theme-" + state.settings.theme
      + " phase-" + phase
      + (state.shellMotionReady ? "" : " motion-disabled")
      + (state.sidebarResizing ? " is-resizing" : "")
      + (state.settings.wallpaperDataUrl ? " has-wallpaper" : "");
    state.sidebarFrame?.setAttribute("aria-hidden", frameInteractive ? "false" : "true");
    if (state.sidebarFrame) state.sidebarFrame.inert = !frameInteractive;
    state.panel.hidden = !frameVisible;
    state.rail.hidden = !frameVisible;
    state.sidebarHandle.hidden = !frameVisible;
    state.panel.setAttribute("aria-hidden", frameInteractive ? "false" : "true");
    state.rail.setAttribute("aria-hidden", frameInteractive ? "false" : "true");
    state.sidebarHandle.tabIndex = frameInteractive ? 0 : -1;
    state.opener.tabIndex = phase === "closed" ? 0 : -1;
    state.opener.setAttribute("aria-expanded", phase === "opening" || phase === "open" ? "true" : "false");
    state.opener.setAttribute("aria-hidden", phase === "closed" ? "false" : "true");
    const quickActionState = workspaceUiModule.quickActionStateForPhase(phase);
    state.quickAction.hidden = !quickActionState.rendered;
    state.quickAction.tabIndex = quickActionState.interactive ? 0 : -1;
    state.quickAction.setAttribute("aria-hidden", quickActionState.interactive ? "false" : "true");
    state.title.textContent = SECTION_TITLES[state.activeSection];

    state.shadow.querySelectorAll("[data-section]").forEach(function updateNavigation(button) {
      const active = button.dataset.section === state.activeSection;
      button.classList.toggle("is-active", active);
      button.setAttribute("aria-current", active ? "page" : "false");
      button.setAttribute("aria-expanded", active && (phase === "opening" || phase === "open") ? "true" : "false");
    });

    state.wallpaper.style.backgroundImage = state.settings.wallpaperDataUrl
      ? "url(" + JSON.stringify(state.settings.wallpaperDataUrl) + ")"
      : "";
  }

  function completeShellMotion(expectedPhase) {
    if (state.shellPhase !== expectedPhase) return;
    const nextPhase = workspaceUiModule.nextSidebarPhase(expectedPhase, "complete");
    if (nextPhase === expectedPhase) return;
    state.shellPhase = nextPhase;
    applyShellState();
    if (nextPhase === "revealing-opener") {
      state.shellTransitionController?.run(state.opener, function openerRevealComplete() {
        completeShellMotion("revealing-opener");
      });
      return;
    }
    if (nextPhase === "closed" && state.shellRestoreFocus) {
      state.shellRestoreFocus = false;
      state.opener?.focus();
    }
  }

  function startShellMotion(nextPhase, restoreFocus) {
    closeTemplatePreview();
    closeRecentPopup();
    if (nextPhase === "closing") closeWorkspaceDelete();
    state.shellRestoreFocus = Boolean(restoreFocus);
    state.shellPhase = nextPhase;
    applyShellState();
    const movingElement = nextPhase === "revealing-opener" ? state.opener : state.sidebarFrame;
    state.shellTransitionController?.run(movingElement, function shellMotionComplete() {
      completeShellMotion(nextPhase);
    });
  }

  function enableShellMotionAfterMount() {
    const mountedHost = state.host;
    requestAnimationFrame(function establishInitialClosedFrame() {
      requestAnimationFrame(function enableMotionOnFollowingFrame() {
        if (state.host !== mountedHost || !mountedHost?.isConnected) return;
        state.shellMotionReady = true;
        applyShellState();
      });
    });
  }

  function setSidebarWidthPreview(preferredWidth) {
    const effective = workspaceContract.effectiveWidth("sidebarWidth", preferredWidth, window.innerWidth);
    state.host?.style.setProperty("--sidebar-effective-width", `${effective}px`);
    state.sidebarHandle?.setAttribute("aria-valuenow", String(effective));
    return effective;
  }

  async function persistSidebarWidth(preferredWidth) {
    const width = workspaceContract.clampPreferredWidth("sidebarWidth", preferredWidth);
    const token = ++state.sidebarWidthCommitToken;
    state.sidebarPreferredWidth = width;
    setSidebarWidthPreview(width);
    if (width === state.settings.layout.sidebarWidth && !state.sidebarWidthCommitPending) {
      state.sidebarWidthCommitPending = false;
      return true;
    }
    state.sidebarWidthCommitPending = true;
    try {
      const response = await chrome.runtime.sendMessage({
        type: workspaceContract.MESSAGE_TYPES.SETTINGS_UPDATE,
        patch: { layout: { sidebarWidth: width } },
      });
      if (!response?.ok) throw new Error(response?.error?.message || "Не удалось сохранить ширину панели.");
      if (token !== state.sidebarWidthCommitToken) return true;
      state.settings = normalizeSettings(response.settings);
      state.sidebarWidthCommitPending = false;
      state.sidebarPreferredWidth = state.settings.layout.sidebarWidth;
      applyShellState();
      setStatus("success", "Ширина панели сохранена.");
      return true;
    } catch (error) {
      if (token !== state.sidebarWidthCommitToken) return false;
      state.sidebarWidthCommitPending = false;
      state.sidebarPreferredWidth = state.settings.layout.sidebarWidth;
      applyShellState();
      setStatus("error", error?.message || "Не удалось сохранить ширину панели.");
      return false;
    }
  }

  function installSidebarResizer(handle) {
    let drag = null;
    let previousUserSelect = "";

    function cleanupDrag() {
      if (!drag) return;
      try {
        if (handle.hasPointerCapture?.(drag.pointerId)) handle.releasePointerCapture(drag.pointerId);
      } catch (_) {}
      document.documentElement.style.userSelect = previousUserSelect;
      handle.classList.remove("is-resizing");
      state.sidebarResizing = false;
      state.shell?.classList.remove("is-resizing");
      drag = null;
    }

    function finishDrag(commit) {
      if (!drag) return;
      const width = drag.width;
      cleanupDrag();
      if (commit) void persistSidebarWidth(width);
      else applyShellState();
    }

    handle.addEventListener("pointerdown", (event) => {
      if (event.button !== 0 || drag || state.shellPhase !== "open") return;
      event.preventDefault();
      closeTemplatePreview();
      previousUserSelect = document.documentElement.style.userSelect;
      document.documentElement.style.userSelect = "none";
      drag = {
        pointerId: event.pointerId,
        startX: event.clientX,
        startWidth: state.sidebarPreferredWidth,
        width: state.sidebarPreferredWidth,
      };
      state.sidebarResizing = true;
      handle.classList.add("is-resizing");
      state.shell?.classList.add("is-resizing");
      handle.setPointerCapture?.(event.pointerId);
    });
    handle.addEventListener("pointermove", (event) => {
      if (!drag || event.pointerId !== drag.pointerId) return;
      drag.width = workspaceContract.resizePreferredWidth(
        "sidebarWidth",
        drag.startWidth,
        event.clientX - drag.startX,
        "left",
      );
      setSidebarWidthPreview(drag.width);
    });
    handle.addEventListener("pointerup", (event) => {
      if (drag && event.pointerId === drag.pointerId) finishDrag(true);
    });
    handle.addEventListener("pointercancel", () => finishDrag(false));
    handle.addEventListener("lostpointercapture", () => { if (drag) finishDrag(true); });
    handle.addEventListener("dblclick", (event) => {
      if (state.shellPhase !== "open") return;
      event.preventDefault();
      void persistSidebarWidth(workspaceContract.LAYOUT.sidebarWidth.default);
    });
    handle.addEventListener("keydown", (event) => {
      if (state.shellPhase !== "open") return;
      const current = state.sidebarPreferredWidth;
      const step = event.shiftKey ? 50 : 10;
      let next = null;
      if (event.key === "ArrowLeft") next = current + step;
      else if (event.key === "ArrowRight") next = current - step;
      else if (event.key === "Home") next = workspaceContract.LAYOUT.sidebarWidth.min;
      else if (event.key === "End") next = workspaceContract.LAYOUT.sidebarWidth.max;
      else if (event.key === "Enter") next = current;
      if (next === null) return;
      event.preventDefault();
      void persistSidebarWidth(next);
    });
    return cleanupDrag;
  }

  function clearRecentHoverTimer() {
    if (state.recentHoverTimer === null) return;
    clearTimeout(state.recentHoverTimer);
    state.recentHoverTimer = null;
  }

  function clearRecentCloseTimer() {
    if (state.recentCloseTimer === null) return;
    clearTimeout(state.recentCloseTimer);
    state.recentCloseTimer = null;
  }

  function closeRecentPopup() {
    clearRecentHoverTimer();
    clearRecentCloseTimer();
    if (state.recentPopup) {
      state.recentPopup.hidden = true;
      state.recentPopup.replaceChildren();
    }
    if (state.preview.source === "recent") closeTemplatePreview();
  }

  function getAvailableRecentTemplates() {
    return workspaceUiModule.recentTemplatesForDisplay(
      state.recentTemplateIds,
      state.templates,
      state.settings.recentTemplatesHoverCount,
    );
  }

  function showRecentPopup() {
    clearRecentHoverTimer();
    if (!state.recentPopup || state.open || state.busyTemplateId || !state.settings.recentTemplatesHoverEnabled) {
      closeRecentPopup();
      return;
    }

    const templates = getAvailableRecentTemplates();
    if (!templates.length) {
      closeRecentPopup();
      return;
    }

    state.recentPopup.innerHTML = templates.map(function recentTemplateMarkup(template) {
      const path = templateLocationLabel(template.id);
      return [
        '<button class="recent-template-button" type="button" role="menuitem" data-action="run-recent-template" data-id="' + escapeHtml(template.id) + '" data-preview-anchor data-preview-id="' + escapeHtml(template.id) + '" data-preview-source="recent" title="' + escapeHtml(template.name) + '" aria-label="Запустить шаблон: ' + escapeHtml(template.name) + '">',
        '  <span class="recent-template-icon" aria-hidden="true">' + trustedTemplateIcon(template) + '</span>',
        '  <span class="recent-template-copy"><span class="recent-template-name">' + escapeHtml(template.name) + '</span><span class="recent-template-path">' + escapeHtml(path) + '</span></span>',
        '</button>',
      ].join("");
    }).join("");
    state.recentPopup.hidden = false;
  }

  function scheduleRecentPopup() {
    clearRecentCloseTimer();
    clearRecentHoverTimer();
    if (state.open || state.busyTemplateId || !state.settings.recentTemplatesHoverEnabled || !getAvailableRecentTemplates().length) return;
    state.recentHoverTimer = setTimeout(function openRecentPopupAfterDelay() {
      state.recentHoverTimer = null;
      showRecentPopup();
    }, RECENT_HOVER_DELAY_MS);
  }

  function scheduleRecentPopupClose() {
    clearRecentHoverTimer();
    clearRecentCloseTimer();
    state.recentCloseTimer = setTimeout(function closeRecentPopupAfterDelay() {
      state.recentCloseTimer = null;
      if (state.preview.source === "recent" && state.preview.pointerInside) return;
      closeRecentPopup();
    }, RECENT_CLOSE_DELAY_MS);
  }

  function onOpenerPointerEnter() {
    if (state.recentPopup && !state.recentPopup.hidden) clearRecentCloseTimer();
    else scheduleRecentPopup();
  }

  function onOpenerPointerLeave() {
    scheduleRecentPopupClose();
  }

  function onRecentPopupPointerEnter() {
    clearRecentCloseTimer();
  }

  function onRecentPopupPointerLeave(event) {
    if (state.previewLayer?.contains(event.relatedTarget)) {
      clearRecentCloseTimer();
      return;
    }
    scheduleRecentPopupClose();
  }

  function clearPreviewOpenTimer() {
    if (state.preview.openTimer === null) return;
    clearTimeout(state.preview.openTimer);
    state.preview.openTimer = null;
  }

  function clearPreviewCloseTimer() {
    if (state.preview.closeTimer === null) return;
    clearTimeout(state.preview.closeTimer);
    state.preview.closeTimer = null;
  }

  function closeTemplatePreview() {
    const consumed = state.preview.phase !== "closed";
    clearPreviewOpenTimer();
    clearPreviewCloseTimer();
    state.preview.phase = "closed";
    state.preview.templateId = null;
    state.preview.source = null;
    state.preview.anchor = null;
    state.preview.pointerInside = false;
    if (state.previewLayer) {
      state.previewLayer.hidden = true;
      state.previewLayer.style.removeProperty("left");
      state.previewLayer.style.removeProperty("top");
    }
    if (state.previewName) state.previewName.textContent = "";
    if (state.previewIcon) state.previewIcon.replaceChildren();
    if (state.previewBreadcrumb) state.previewBreadcrumb.textContent = "";
    if (state.previewContent) state.previewContent.textContent = "";
    if (state.previewAutoSend) state.previewAutoSend.hidden = true;
    return consumed;
  }

  function previewSurfaceAvailable(source) {
    if (source === "main") return state.shellPhase === "open";
    return source === "recent"
      && state.shellPhase === "closed"
      && state.recentPopup
      && !state.recentPopup.hidden;
  }

  function previewSuppressed(templateId, source, anchor) {
    return !previewSurfaceAvailable(source)
      || state.templateTreeDrag.draggingNodeId !== null
      || state.busyTemplateId === templateId
      || state.editing?.id === templateId
      || state.templateDeleteId === templateId
      || state.folderDelete.nodeId === templateId
      || !anchor?.isConnected;
  }

  function positionTemplatePreview(anchor) {
    if (!state.previewLayer || !anchor?.isConnected) return false;
    const position = workspaceUiModule.previewPosition(
      anchor.getBoundingClientRect(),
      state.previewLayer.getBoundingClientRect(),
      { width: window.innerWidth, height: window.innerHeight, gap: 10, padding: 12 },
    );
    state.previewLayer.style.left = `${position.left}px`;
    state.previewLayer.style.top = `${position.top}px`;
    return true;
  }

  function openTemplatePreview(anchor, templateId, source) {
    clearPreviewOpenTimer();
    clearPreviewCloseTimer();
    if (previewSuppressed(templateId, source, anchor)) {
      closeTemplatePreview();
      return;
    }
    const template = state.templates.find((item) => item.id === templateId);
    if (!template || template.kind !== templateTree.NODE_KINDS.TEMPLATE || !state.previewLayer) {
      closeTemplatePreview();
      return;
    }
    state.preview.phase = "open";
    state.preview.templateId = templateId;
    state.preview.source = source;
    state.preview.anchor = anchor;
    state.previewName.textContent = template.name;
    state.previewIcon.innerHTML = trustedTemplateIcon(template);
    state.previewBreadcrumb.textContent = templateLocationLabel(template.id);
    state.previewContent.textContent = template.content;
    state.previewAutoSend.hidden = template.autoSend !== true;
    state.previewLayer.hidden = false;
    if (!positionTemplatePreview(anchor)) closeTemplatePreview();
  }

  function scheduleTemplatePreview(anchor, templateId, source, immediate) {
    clearPreviewCloseTimer();
    if (previewSuppressed(templateId, source, anchor)) {
      closeTemplatePreview();
      return;
    }
    if (state.preview.phase === "open"
      && state.preview.templateId === templateId
      && state.preview.anchor === anchor) return;
    clearPreviewOpenTimer();
    state.preview.phase = "waiting";
    state.preview.templateId = templateId;
    state.preview.source = source;
    state.preview.anchor = anchor;
    if (immediate) {
      openTemplatePreview(anchor, templateId, source);
      return;
    }
    state.preview.openTimer = setTimeout(function openTemplatePreviewAfterDelay() {
      state.preview.openTimer = null;
      openTemplatePreview(anchor, templateId, source);
    }, TEMPLATE_PREVIEW_OPEN_DELAY_MS);
  }

  function scheduleTemplatePreviewClose() {
    clearPreviewOpenTimer();
    clearPreviewCloseTimer();
    if (state.preview.phase === "closed") return;
    state.preview.closeTimer = setTimeout(function closeTemplatePreviewAfterGrace() {
      state.preview.closeTimer = null;
      closeTemplatePreview();
    }, TEMPLATE_PREVIEW_CLOSE_DELAY_MS);
  }

  function onShadowPointerOver(event) {
    const anchor = workspaceUiModule.previewAnchorFromTarget(event.target);
    if (!anchor || anchor.contains(event.relatedTarget)) return;
    scheduleTemplatePreview(anchor, anchor.dataset.previewId, anchor.dataset.previewSource, false);
  }

  function onShadowPointerOut(event) {
    const anchor = workspaceUiModule.previewAnchorFromTarget(event.target);
    if (!anchor || anchor.contains(event.relatedTarget) || state.previewLayer?.contains(event.relatedTarget)) return;
    scheduleTemplatePreviewClose();
  }

  function onShadowFocusIn(event) {
    const anchor = workspaceUiModule.previewAnchorFromTarget(event.target);
    if (!anchor) return;
    scheduleTemplatePreview(anchor, anchor.dataset.previewId, anchor.dataset.previewSource, true);
  }

  function onShadowFocusOut(event) {
    const anchor = workspaceUiModule.previewAnchorFromTarget(event.target);
    if (!anchor || anchor.contains(event.relatedTarget) || state.previewLayer?.contains(event.relatedTarget)) return;
    closeTemplatePreview();
  }

  function onPreviewPointerEnter() {
    state.preview.pointerInside = true;
    clearPreviewCloseTimer();
    if (state.preview.source === "recent") clearRecentCloseTimer();
  }

  function onPreviewPointerLeave(event) {
    state.preview.pointerInside = false;
    if (state.preview.anchor?.contains(event.relatedTarget)) return;
    scheduleTemplatePreviewClose();
    if (state.preview.source === "recent"
      && !state.recentPopup?.contains(event.relatedTarget)
      && !state.opener?.contains(event.relatedTarget)) {
      scheduleRecentPopupClose();
    }
  }

  function statusMarkup() {
    if (!state.status.text) return '<p class="status" role="status" aria-live="polite"></p>';
    return '<p class="status ' + escapeHtml(state.status.kind) + '" role="status" aria-live="polite">' + escapeHtml(state.status.text) + '</p>';
  }

  function iconPickerMarkup(editor, describedBy) {
    const buttons = templateTree.VALID_ICON_KEYS.map(function iconOption(iconKey) {
      const title = TEMPLATE_ICON_TITLES[iconKey] || iconKey;
      const selected = editor.iconKey === iconKey;
      return [
        '<button class="icon-option" type="button" data-action="select-editor-icon" data-icon-key="' + escapeHtml(iconKey) + '"',
        ' title="' + escapeHtml(title) + '" aria-label="Иконка: ' + escapeHtml(title) + '" aria-pressed="' + (selected ? "true" : "false") + '">',
        trustedTemplateIcon(iconKey, editor.kind),
        '</button>',
      ].join("");
    }).join("");
    return '<div class="icon-picker" role="group" aria-label="Иконка"' + describedBy + '>' + buttons + '</div>';
  }

  function parentOptionsForEditor(editor) {
    let options = templateTree.parentPickerOptions(state.templates, editor.id);
    if (editor.kind === templateTree.NODE_KINDS.FOLDER && editor.id === null) {
      options = options.filter((option) => option.id === null
        || templateTree.folderDepth(state.templates, option.id) < templateTree.MAX_FOLDER_DEPTH);
    }
    return options;
  }

  function locationPickerMarkup(editor, describedBy) {
    const options = parentOptionsForEditor(editor);
    const selectedExists = options.some((option) => option.id === editor.targetParentId);
    const markup = options.map(function parentOption(option) {
      const value = option.id || "";
      const label = option.id === null ? "Корень" : option.breadcrumbs.join(" / ");
      return '<option value="' + escapeHtml(value) + '"' + (option.id === editor.targetParentId ? " selected" : "") + '>' + escapeHtml(label) + '</option>';
    }).join("");
    const stale = !selectedExists && editor.targetParentId
      ? '<option value="' + escapeHtml(editor.targetParentId) + '" selected disabled>Расположение больше недоступно</option>'
      : "";
    const label = editor.kind === templateTree.NODE_KINDS.FOLDER
      ? "Родительская папка"
      : "Расположение";
    return '<label class="field"><span>' + label + '</span><select class="input location-select" data-field="parentId"' + describedBy + '>' + stale + markup + '</select></label>';
  }

  function editorMarkup(editor, extraClass) {
    const isTemplate = editor.kind === templateTree.NODE_KINDS.TEMPLATE;
    const describedBy = state.editorError
      ? ' aria-describedby="' + TEMPLATE_EDITOR_ERROR_ID + '"'
      : "";
    return [
      '<div class="editor ' + (extraClass || "") + '" data-editor data-editor-id="' + escapeHtml(editor.id || "") + '" data-editor-kind="' + escapeHtml(editor.kind) + '">',
      '  <label class="field"><span>Название</span><input class="input" type="text" data-field="name" value="' + escapeHtml(editor.name) + '" maxlength="120"' + describedBy + '></label>',
      isTemplate ? '  <label class="field"><span>Текст шаблона</span><textarea class="input" data-field="content" maxlength="200000"' + describedBy + '>' + escapeHtml(editor.content) + '</textarea></label>' : "",
      '  <div class="field"><span>Иконка</span>' + iconPickerMarkup(editor, describedBy) + '</div>',
      locationPickerMarkup(editor, describedBy),
      isTemplate ? '  <label class="editor-auto-send"><input type="checkbox" data-field="autoSend"' + (editor.autoSend ? " checked" : "") + describedBy + '><span>Автоотправка</span></label>' : "",
      state.editorError ? '  <p class="inline-error" id="' + TEMPLATE_EDITOR_ERROR_ID + '" role="alert">' + escapeHtml(state.editorError) + '</p>' : "",
      '  <div class="editor-actions">',
      '    <button class="button" type="button" data-action="cancel-edit">Отмена</button>',
      '    <button class="button primary" type="button" data-action="save-edit"' + describedBy + '>Сохранить</button>',
      '  </div>',
      '</div>',
    ].join("");
  }

  function templateDeleteMarkup(template) {
    if (state.templateDeleteId !== template.id) return "";
    return [
      '  <div class="delete-confirm">',
      '    <span>Удалить шаблон?</span>',
      '    <div class="confirm-actions">',
      '      <button class="button" type="button" data-action="cancel-node-delete">Нет</button>',
      '      <button class="button danger" type="button" data-action="confirm-template-delete" data-id="' + escapeHtml(template.id) + '">Да</button>',
      '    </div>',
      '  </div>',
    ].join("");
  }

  function folderDeleteMarkup(folder) {
    if (state.folderDelete.nodeId !== folder.id) return "";
    const stats = templateTree.subtreeStats(state.templates, folder.id);
    const statistics = stats.folderCount + " папок, " + stats.templateCount + " шаблонов";
    if (state.folderDelete.phase === "confirm-subtree") {
      return [
        '<div class="delete-confirm folder-delete-confirm">',
        '  <p class="folder-delete-copy"><span class="folder-delete-stats">' + escapeHtml(statistics) + '.</span> Папка и всё содержимое будут удалены безвозвратно.</p>',
        '  <div class="confirm-actions">',
        '    <button class="button" type="button" data-action="cancel-node-delete">Отмена</button>',
        '    <button class="button danger" type="button" data-action="confirm-folder-subtree-delete" data-id="' + escapeHtml(folder.id) + '">Безвозвратно удалить</button>',
        '  </div>',
        '</div>',
      ].join("");
    }
    return [
      '<div class="delete-confirm folder-delete-confirm">',
      '  <p class="folder-delete-copy"><span class="folder-delete-stats">' + escapeHtml(statistics) + '.</span> При удалении только папки её элементы поднимутся на один уровень.</p>',
      '  <div class="confirm-actions">',
      '    <button class="button" type="button" data-action="cancel-node-delete">Отмена</button>',
      '    <button class="button" type="button" data-action="confirm-folder-promote-delete" data-id="' + escapeHtml(folder.id) + '">Удалить только папку</button>',
      '    <button class="button danger" type="button" data-action="ask-folder-subtree-delete" data-id="' + escapeHtml(folder.id) + '">Удалить папку и содержимое</button>',
      '  </div>',
      '</div>',
    ].join("");
  }

  function templateCardMarkup(template) {
    const editing = state.editing?.id === template.id;
    const busy = state.busyTemplateId === template.id;
    return [
      '<article class="template-card" data-template-node-id="' + escapeHtml(template.id) + '" data-node-kind="template">',
      '  <div class="template-summary">',
      '    <div class="template-preview-hotspot" data-preview-anchor data-preview-id="' + escapeHtml(template.id) + '" data-preview-source="main">',
      '      <span class="drag-handle" draggable="true" data-template-drag-id="' + escapeHtml(template.id) + '" title="Перетащить шаблон" aria-label="Перетащить шаблон">' + ICONS.drag + '</span>',
      '      <span class="template-title-wrap"><span class="template-node-icon" aria-hidden="true">' + trustedTemplateIcon(template) + '</span><span class="template-name" title="' + escapeHtml(template.name) + '">' + escapeHtml(template.name) + '</span></span>',
      '    </div>',
      '    <div class="template-controls">',
      '      <button class="icon-button run" type="button" data-action="run-template" data-id="' + escapeHtml(template.id) + '" title="Запустить шаблон" aria-label="Запустить шаблон"' + (busy ? " disabled" : "") + '>' + ICONS.play + '</button>',
      '      <button class="icon-button' + (editing ? " expanded" : "") + '" type="button" data-action="edit-node" data-id="' + escapeHtml(template.id) + '" title="Редактировать шаблон" aria-label="Редактировать шаблон" aria-expanded="' + (editing ? "true" : "false") + '">' + ICONS.chevron + '</button>',
      '      <label class="auto-send" title="После вставки сразу отправить"><input type="checkbox" data-action="auto-send" data-id="' + escapeHtml(template.id) + '"' + (template.autoSend ? " checked" : "") + '><span>Авто</span></label>',
      state.deleteMode ? '      <button class="icon-button text-danger" type="button" data-action="ask-node-delete" data-id="' + escapeHtml(template.id) + '" title="Удалить шаблон" aria-label="Удалить шаблон">' + ICONS.trash + '</button>' : "",
      '    </div>',
      '  </div>',
      editing ? editorMarkup(state.editing, "") : "",
      templateDeleteMarkup(template),
      '</article>',
    ].join("");
  }

  function folderCardMarkup(folder, projection) {
    const editing = state.editing?.id === folder.id;
    return [
      '<article class="template-card folder-card" data-template-node-id="' + escapeHtml(folder.id) + '" data-node-kind="folder">',
      '  <div class="template-summary">',
      '    <div class="folder-main">',
      '      <span class="drag-handle" draggable="true" data-template-drag-id="' + escapeHtml(folder.id) + '" title="Перетащить папку" aria-label="Перетащить папку">' + ICONS.drag + '</span>',
      '      <button class="folder-toggle" type="button" data-action="toggle-folder" data-id="' + escapeHtml(folder.id) + '" title="' + (projection.collapsed ? "Развернуть папку" : "Свернуть папку") + '" aria-label="' + (projection.collapsed ? "Развернуть папку" : "Свернуть папку") + '" aria-expanded="' + (projection.collapsed ? "false" : "true") + '">' + ICONS.chevron + '</button>',
      '      <span class="template-node-icon" aria-hidden="true">' + trustedTemplateIcon(folder) + '</span>',
      '      <span class="template-name" title="' + escapeHtml(folder.name) + '">' + escapeHtml(folder.name) + '</span>',
      '    </div>',
      '    <div class="template-controls">',
      '      <button class="icon-button" type="button" data-action="add-template-in-folder" data-id="' + escapeHtml(folder.id) + '" title="Добавить шаблон в папку" aria-label="Добавить шаблон в папку">' + ICONS.plus + '</button>',
      '      <button class="icon-button" type="button" data-action="add-folder-in-folder" data-id="' + escapeHtml(folder.id) + '" title="Создать вложенную папку" aria-label="Создать вложенную папку">' + trustedTemplateIcon("folder", "folder") + '</button>',
      '      <button class="icon-button' + (editing ? " expanded" : "") + '" type="button" data-action="edit-node" data-id="' + escapeHtml(folder.id) + '" title="Редактировать папку" aria-label="Редактировать папку" aria-expanded="' + (editing ? "true" : "false") + '">' + ICONS.chevron + '</button>',
      state.deleteMode ? '      <button class="icon-button text-danger" type="button" data-action="ask-node-delete" data-id="' + escapeHtml(folder.id) + '" title="Удалить папку" aria-label="Удалить папку">' + ICONS.trash + '</button>' : "",
      '    </div>',
      '  </div>',
      editing ? editorMarkup(state.editing, "") : "",
      folderDeleteMarkup(folder),
      '</article>',
    ].join("");
  }

  function templateProjectionById() {
    const projection = templateTree.visibleProjection(state.templates, effectiveCollapsedFolderIds());
    return new Map(projection.map((entry) => [entry.node.id, entry]));
  }

  function treeChildrenMarkup(parentId, visibleById, root, temporaryParentId) {
    const rows = templateTree.childrenOf(state.templates, parentId).flatMap(function renderNode(node) {
      const entry = visibleById.get(node.id);
      if (!entry) return [];
      const card = node.kind === templateTree.NODE_KINDS.FOLDER
        ? folderCardMarkup(node, entry)
        : templateCardMarkup(node);
      const nested = node.kind === templateTree.NODE_KINDS.FOLDER && !entry.collapsed
        ? treeChildrenMarkup(node.id, visibleById, false, null)
        : "";
      return [[
        '<div class="template-node-slot" role="listitem" data-template-slot-id="' + escapeHtml(node.id) + '" style="--template-depth:' + Math.min(entry.depth, templateTree.MAX_FOLDER_DEPTH) + ';--template-indent:' + (entry.depth > 0 ? 14 : 0) + 'px">',
        card,
        nested,
        '</div>',
      ].join("")];
    }).join("");
    if (root) return '<div class="templates-list" role="list" aria-label="Шаблоны и папки">' + rows + '</div>';
    const temporary = temporaryParentId
      ? ' data-temporary-expanded-for="' + escapeHtml(temporaryParentId) + '"'
      : "";
    return rows ? '<div class="template-children" role="list" aria-label="Содержимое папки"' + temporary + '>' + rows + '</div>' : "";
  }

  function treeRowsMarkup() {
    return treeChildrenMarkup(null, templateProjectionById(), true, null);
  }

  function templatesMarkup() {
    if (state.templateTreeError) {
      return [
        '<div class="template-tree-failure" role="alert">',
        '  <p class="empty-state">' + escapeHtml(state.templateTreeError) + '</p>',
        '  <button class="button" type="button" data-action="open-extension-options">Открыть настройки расширения</button>',
        '</div>',
        statusMarkup(),
      ].join("");
    }
    const rows = treeRowsMarkup();
    return [
      '<div class="section-toolbar">',
      '  <div class="template-toolbar-actions">',
      '    <button class="button primary" type="button" data-action="add-template">' + ICONS.plus + '<span>Добавить шаблон</span></button>',
      '    <button class="button" type="button" data-action="add-folder">' + trustedTemplateIcon("folder", "folder") + '<span>Создать папку</span></button>',
      '  </div>',
      '  <button class="compact-button' + (state.deleteMode ? " is-active" : "") + '" type="button" data-action="toggle-delete-mode" title="Режим удаления" aria-label="Режим удаления" aria-pressed="' + (state.deleteMode ? "true" : "false") + '">' + ICONS.trash + '</button>',
      '</div>',
      state.editing?.id === null ? editorMarkup(state.editing, "new-editor") : "",
      state.templates.length ? rows : '<p class="empty-state">Добавьте первый шаблон или создайте папку.</p>',
      statusMarkup(),
      '<div class="template-root-drop" data-template-root-target><span>Переместить в корень</span></div>',
    ].join("");
  }

  function analysisMarkup() {
    return workspaceUiModule.glossaryMarkup(state) + statusMarkup();
  }

  function savedMarkup() {
    return workspaceUiModule.savedMarkup(state) + statusMarkup();
  }

  function settingsMarkup() {
    const themes = [
      ["system", "System / Neutral"],
      ["graphite", "Graphite"],
      ["navy", "Deep Navy"],
      ["violet", "Neon Violet"],
      ["gold", "Codex Gold"],
    ];
    const themeOptions = themes.map(function themeOption(theme) {
      return '<label class="theme-option"><input type="radio" name="overlay-theme" data-action="theme" value="' + theme[0] + '"' + (state.settings.theme === theme[0] ? " checked" : "") + '><span>' + theme[1] + '</span></label>';
    }).join("");
    const recentCountOptions = Array.from(
      { length: workspaceContract.RECENT_TEMPLATES_HOVER_COUNT.max },
      function recentCountOption(_, index) {
        const value = index + workspaceContract.RECENT_TEMPLATES_HOVER_COUNT.min;
        return '<option value="' + value + '"' + (state.settings.recentTemplatesHoverCount === value ? " selected" : "") + '>' + value + '</option>';
      },
    ).join("");
    return [
      '<section class="settings-group">',
      '  <h3>Внешний вид</h3>',
      themeOptions,
      '  <h4>Обои панели</h4>',
      '  <p class="settings-help">Локальное изображение применяется только к раскрытой панели. Максимум 6 МБ.</p>',
      '  <input class="file-input" type="file" accept="image/*" data-action="wallpaper">',
      state.settings.wallpaperDataUrl ? '  <button class="button danger" type="button" data-action="remove-wallpaper">Удалить обои</button>' : "",
      analysisUiModule.settingsMarkup(state),
      '  <button class="button" type="button" data-action="reset-interface-sizes">Сбросить размеры интерфейса</button>',
      '</section>',
      '<section class="settings-group">',
      '  <h3>Поведение панели</h3>',
      '  <label class="setting-option"><input type="checkbox" data-action="close-panel-after-run"' + (state.settings.closePanelAfterRun ? " checked" : "") + '><span>Закрывать панель после запуска шаблона</span></label>',
      '  <label class="setting-option"><input type="checkbox" data-action="close-panel-on-outside-click"' + (state.settings.closePanelOnOutsideClick ? " checked" : "") + '><span>Закрывать панель при клике вне неё</span></label>',
      '  <label class="setting-option"><input type="checkbox" data-action="recent-templates-hover"' + (state.settings.recentTemplatesHoverEnabled ? " checked" : "") + '><span>Показывать последние шаблоны при наведении</span></label>',
      state.settings.recentTemplatesHoverEnabled
        ? '  <label class="setting-option recent-count-option"><span>Количество шаблонов</span><select class="compact-select" data-action="recent-templates-count">' + recentCountOptions + '</select></label>'
        : "",
      '</section>',
      '<section class="settings-group">',
      '  <h3>Горячие клавиши</h3>',
      '  <p class="settings-help">Сочетания назначаются на странице горячих клавиш расширений браузера.</p>',
      '  <ul class="command-list"><li>Активировать расширение</li><li>Анализировать выделенный текст</li><li>Сохранить выделенный текст</li><li>Нормализовать пустые строки</li></ul>',
      '</section>',
      '<section class="settings-group">',
      '  <h3>Настройки расширения</h3>',
      '  <p class="settings-help">Ключ OpenRouter, импорт и экспорт настроек и данных.</p>',
      '  <button class="button" type="button" data-action="open-extension-options">Открыть настройки расширения</button>',
      '</section>',
      statusMarkup(),
    ].join("");
  }

  function boundedTemplateFocusTarget(value) {
    const action = value?.action;
    if (!TEMPLATE_FOCUS_RETURN_ACTIONS.has(action)) return null;
    const nodeId = typeof value?.nodeId === "string" && value.nodeId ? value.nodeId : null;
    if (action === "add-template" || action === "add-folder") {
      return nodeId === null ? { action, nodeId: null } : null;
    }
    return nodeId ? { action, nodeId } : null;
  }

  function templateFocusTargetFromAction(actionButton) {
    return boundedTemplateFocusTarget({
      action: actionButton?.dataset?.action,
      nodeId: actionButton?.dataset?.id || null,
    });
  }

  function queuePendingTemplateFocus(value) {
    state.pendingTemplateFocusTarget = boundedTemplateFocusTarget(value)
      || { action: "add-template", nodeId: null };
  }

  function usableTemplateFocusControl(element) {
    return Boolean(element?.isConnected && !element.disabled && typeof element.focus === "function");
  }

  function findTemplateFocusControl(target) {
    const controls = Array.from(state.body?.querySelectorAll("[data-action]") || []);
    const original = controls.find((element) => element.dataset.action === target.action
      && (target.nodeId === null
        ? !element.dataset.id
        : element.dataset.id === target.nodeId));
    if (usableTemplateFocusControl(original)) return original;
    for (const action of TEMPLATE_TOOLBAR_FOCUS_ACTIONS) {
      const fallback = controls.find((element) => element.dataset.action === action);
      if (usableTemplateFocusControl(fallback)) return fallback;
    }
    return null;
  }

  function restorePendingTemplateFocus() {
    if (!state.pendingTemplateFocusTarget || state.activeSection !== "templates") return false;
    const target = state.pendingTemplateFocusTarget;
    state.pendingTemplateFocusTarget = null;
    const control = findTemplateFocusControl(target);
    if (!control) return false;
    control.focus();
    return true;
  }

  function renderSection(options) {
    if (!state.body) return;
    if (!options?.preserveTemplateDrag
      && (state.templateTreeDrag.draggingNodeId
        || state.templateTreeDrag.temporarilyExpandedFolderIds.length)) {
      cleanupTemplateTreeDrag();
    }
    reconcileWorkspaceDeleteEntry();
    applyShellState();
    if (state.activeSection === "templates") state.body.innerHTML = templatesMarkup();
    else if (state.activeSection === "analysis") state.body.innerHTML = analysisMarkup();
    else if (state.activeSection === "saved") state.body.innerHTML = savedMarkup();
    else state.body.innerHTML = settingsMarkup();
    if (state.preview.anchor && !state.preview.anchor.isConnected) closeTemplatePreview();
    if (state.activeSection === "templates") restorePendingTemplateFocus();
  }

  function openSection(section, options) {
    if (!SECTION_TITLES[section]) return;
    if (!["closed", "open"].includes(state.shellPhase)) return;
    closeTemplatePreview();
    closeRecentPopup();
    if (state.activeSection !== section) closeWorkspaceDelete();
    state.activeSection = section;
    if (!options?.preserveStatus) clearStatus();
    renderSection();
    if (state.shellPhase === "closed") {
      startShellMotion(workspaceUiModule.nextSidebarPhase("closed", "open"), false);
    }
    if (section === "analysis" || section === "settings") void refreshKeyStatus();
    if (section === "analysis") void refreshGlossary().catch(handleUiError);
    if (section === "saved") void refreshSaved().catch(handleUiError);
  }

  function closePanel(restoreFocus) {
    if (state.shellPhase !== "open" || state.sidebarResizing) return;
    startShellMotion(workspaceUiModule.nextSidebarPhase("open", "close"), restoreFocus);
  }

  function togglePanel() {
    if (state.shellPhase === "closed") openSection(state.activeSection);
    else if (state.shellPhase === "open") closePanel(false);
  }

  async function saveTemplateMutation(message) {
    if (state.templateTreeError) {
      setStatus("error", state.templateTreeError);
      return false;
    }
    try {
      const response = await chrome.runtime.sendMessage(message);
      if (!response?.ok) {
        if (response?.error?.code === templateTree.ERROR_CODES.INVALID_STORED_STATE) {
          state.templateTreeError = templateTreeFailureMessage(response.error);
        }
        throw new Error(templateMutationErrorText(response?.error));
      }
      if (!applyTemplateMutationResponse(response)) {
        throw new Error(state.templateTreeError);
      }
      return true;
    } catch (error) {
      setStatus("error", error?.message || "Не удалось сохранить шаблоны.");
      return false;
    }
  }

  async function saveSettings(nextSettings, successText, failureText) {
    const normalizedSettings = normalizeSettings(nextSettings);
    const patch = workspaceContract.createActiveSettingsPatch(state.settings, normalizedSettings);
    if (!Object.keys(patch).length) return true;
    try {
      const response = await chrome.runtime.sendMessage({
        type: workspaceContract.MESSAGE_TYPES.SETTINGS_UPDATE,
        patch,
      });
      if (!response?.ok) throw new Error(response?.error?.message || "Не удалось сохранить настройки.");
      state.settings = normalizeSettings(response.settings);
      if (!state.sidebarWidthCommitPending && !state.sidebarResizing) {
        state.sidebarPreferredWidth = state.settings.layout.sidebarWidth;
      }
      if (!state.settings.recentTemplatesHoverEnabled) closeRecentPopup();
      applyShellState();
      setStatus("success", successText || "Настройки сохранены.");
      return true;
    } catch (error) {
      applyShellState();
      renderSection();
      setStatus("error", failureText || error?.message || "Не удалось сохранить настройки.");
      return false;
    }
  }

  async function refreshKeyStatus() {
    if (!state.analysisController) return;
    state.keyChecking = true;
    if (state.open && state.activeSection === "analysis") renderSection();
    try {
      const configured = await state.analysisController.getKeyStatus();
      updateKeyStatus(configured);
    } catch (_) {
      state.keyConfigured = false;
    } finally {
      state.keyChecking = false;
      if (state.open && state.activeSection === "analysis") renderSection();
    }
  }

  function updateKeyStatus(configured) {
    if (typeof configured !== "boolean" || state.keyConfigured === configured) return;
    state.keyConfigured = configured;
    state.keyChecking = false;
    if (state.open && (state.activeSection === "analysis" || state.activeSection === "settings")) renderSection();
  }

  function refreshKeyStatusWhenVisible() {
    if (document.visibilityState === "visible") void refreshKeyStatus();
  }

  function retryWorkspaceWhenVisible() {
    if (document.visibilityState === "visible" && state.workspaceStatus.status === "unavailable") {
      void state.contextClient?.retry();
    }
  }

  function updateGlossaryEntries(value) {
    state.glossaryEntries = workspaceUiModule.normalizeGlossaryEntries(value);
    if (state.workspaceDelete.kind === "glossary") closeWorkspaceDelete();
    if (state.open && state.activeSection === "analysis") renderSection();
  }

  function updateSavedEntries(value) {
    state.savedEntries = workspaceUiModule.normalizeSavedEntries(value);
    if (state.workspaceDelete.kind === "saved") closeWorkspaceDelete();
    if (state.open && state.activeSection === "saved") renderSection();
  }

  async function refreshGlossary() {
    if (!state.workspaceClient || !state.workspaceContext) return;
    const token = ++state.glossaryRequestToken;
    const requestedMode = workspaceUiModule.activeSearchMode(state.glossaryRequestedMode);
    const query = state.glossarySearch;
    const response = await state.workspaceClient.queryGlossary(requestedMode, query);
    if (!workspaceUiModule.isCurrentWorkspaceRequest(token, state.glossaryRequestToken)) return;
    if (!response?.ok) throw new Error(response?.error?.message || "Не удалось загрузить словарь.");
    updateGlossaryEntries(response.entries);
  }

  async function refreshSaved() {
    if (!state.workspaceClient || !state.workspaceContext) return;
    const token = ++state.savedRequestToken;
    const requestedMode = workspaceUiModule.activeSearchMode(state.savedRequestedMode);
    const query = state.savedSearch;
    const response = await state.workspaceClient.querySaved(requestedMode, query);
    if (!workspaceUiModule.isCurrentWorkspaceRequest(token, state.savedRequestToken)) return;
    if (!response?.ok) throw new Error(response?.error?.message || "Не удалось загрузить сохранённое.");
    updateSavedEntries(response.entries);
  }

  function aiOperationBusy() {
    return state.analysisBusy || state.translationBusy;
  }

  function inlineSelectionSignature() {
    const selection = window.getSelection?.();
    if (!selection) return "";
    return JSON.stringify([
      String(selection.toString?.() || ""),
      selection.isCollapsed === true,
      Number(selection.anchorOffset) || 0,
      Number(selection.focusOffset) || 0,
    ]);
  }

  function inlineSnapshotCurrent(snapshot) {
    return Boolean(snapshot
      && snapshot.pageUrl === location.href
      && snapshot.anchorNode?.isConnected === true);
  }

  function inlineGlossarySnapshotCurrent(snapshot) {
    return Boolean(inlineSnapshotCurrent(snapshot)
      && workspaceContract.isScopeKey(snapshot.conversationScope)
      && state.workspaceContext?.scopeKey === snapshot.conversationScope
      && state.workspaceStatus.status === "ready");
  }

  function cancelInlineGestureSettle() {
    const gesture = state.inlineGesture;
    if (gesture.pendingFrame !== null) {
      if (typeof window.cancelAnimationFrame === "function") {
        window.cancelAnimationFrame(gesture.pendingFrame);
      } else {
        clearTimeout(gesture.pendingFrame);
      }
    }
    if (gesture.pendingTask !== null) clearTimeout(gesture.pendingTask);
    gesture.pendingFrame = null;
    gesture.pendingTask = null;
  }

  function invalidateInlineGesture() {
    cancelInlineGestureSettle();
    state.inlineGesture = {
      generation: state.inlineGesture.generation + 1,
      pointerId: null,
      pointerType: null,
      keyboardActive: false,
      shiftHeld: false,
      selectionKeys: [],
      startSignature: "",
      changed: false,
      pendingFrame: null,
      pendingTask: null,
    };
  }

  function closeInlineGlossary() {
    const current = state.inlineGlossary;
    const consumed = current.phase !== "closed";
    invalidateInlineGesture();
    state.inlineGlossary = {
      phase: "closed",
      selectionToken: current.selectionToken + 1,
      requestToken: current.requestToken + 1,
      snapshot: null,
      result: null,
      error: null,
    };
    state.analysisUi?.closeInline();
    return consumed;
  }

  function inlineUiHandlers() {
    return {
      onActivate() { void activateInlineGlossary(); },
      onTranslate() { void translateInlineSelection(); },
      onAnalyzeSelection() { void analyzeInlineSelection(); },
      onClose() { closeInlineGlossary(); },
      onRetry() { void retryInlineGlossary(); },
      onAnalyze(candidate) { void analyzeInlineGlossaryCandidate(candidate); },
    };
  }

  function showInlineOffer(snapshot) {
    const current = state.inlineGlossary;
    state.inlineGlossary = {
      phase: "offering",
      selectionToken: current.selectionToken + 1,
      requestToken: current.requestToken + 1,
      snapshot,
      result: null,
      error: null,
    };
    if (!state.analysisUi?.showInlineOffer(snapshot, inlineUiHandlers(), {
      glossaryEnabled: state.workspaceStatus.status === "ready" && Boolean(state.workspaceContext),
    })) {
      closeInlineGlossary();
      return false;
    }
    return true;
  }

  function inlineLookupOwns(requestToken, selectionToken, snapshot) {
    const current = state.inlineGlossary;
    return current.phase === "loading"
      && current.requestToken === requestToken
      && current.selectionToken === selectionToken
      && current.snapshot === snapshot
      && current.snapshot?.text === snapshot.text
      && current.snapshot?.pageUrl === snapshot.pageUrl
      && current.snapshot?.conversationScope === snapshot.conversationScope
      && inlineGlossarySnapshotCurrent(snapshot);
  }

  async function performInlineGlossaryLookup(snapshot, selectionToken) {
    if (!inlineGlossarySnapshotCurrent(snapshot)) {
      closeInlineGlossary();
      return { ok: false, ignored: true };
    }
    const current = state.inlineGlossary;
    const requestToken = current.requestToken + 1;
    state.inlineGlossary = {
      ...current,
      phase: "loading",
      requestToken,
      snapshot,
      result: null,
      error: null,
    };
    if (!state.analysisUi?.showInlineLoading(snapshot, inlineUiHandlers())) {
      closeInlineGlossary();
      return { ok: false, ignored: true };
    }

    let response;
    try {
      response = await state.workspaceClient.lookupGlossarySelection(snapshot.text);
    } catch (error) {
      response = { ok: false, error: { message: error?.message || "Не удалось открыть словарь." } };
    }
    if (!inlineLookupOwns(requestToken, selectionToken, snapshot)) {
      return { ok: false, ignored: true };
    }
    if (!response?.ok) {
      const error = {
        code: typeof response?.error?.code === "string" ? response.error.code : "WORKSPACE_OPERATION_FAILED",
        message: typeof response?.error?.message === "string" ? response.error.message : "Не удалось открыть словарь.",
      };
      state.inlineGlossary = { ...state.inlineGlossary, phase: "error", error };
      if (!state.analysisUi?.showInlineError(snapshot, error, inlineUiHandlers())) {
        closeInlineGlossary();
        return { ok: false, ignored: true };
      }
      return response || { ok: false, error };
    }

    state.inlineGlossary = {
      ...state.inlineGlossary,
      phase: "showing",
      result: response,
      error: null,
    };
    if (!state.analysisUi?.showInlineResult(snapshot, response, inlineUiHandlers())) {
      closeInlineGlossary();
      return { ok: false, ignored: true };
    }
    return response;
  }

  function activateInlineGlossary() {
    const current = state.inlineGlossary;
    const offer = current.snapshot;
    const scope = state.workspaceContext?.scopeKey;
    if (current.phase !== "offering" || !offer
      || state.workspaceStatus.status !== "ready"
      || !workspaceContract.isScopeKey(scope)) {
      closeInlineGlossary();
      return Promise.resolve({ ok: false, ignored: true });
    }
    const snapshot = Object.freeze({
      text: offer.text,
      anchorRect: offer.anchorRect,
      anchorNode: offer.anchorNode,
      pageUrl: offer.pageUrl,
      conversationScope: scope,
    });
    state.inlineGlossary = { ...current, snapshot };
    return performInlineGlossaryLookup(snapshot, current.selectionToken);
  }

  function translateInlineSelection() {
    const current = state.inlineGlossary;
    const snapshot = current.snapshot;
    if (current.phase !== "offering" || !inlineSnapshotCurrent(snapshot)) {
      closeInlineGlossary();
      return Promise.resolve({ ok: false, ignored: true });
    }
    const text = snapshot.text;
    const pageUrl = snapshot.pageUrl;
    closeInlineGlossary();
    return runTranslation("inline-assistant", text, pageUrl);
  }

  function analyzeInlineSelection() {
    const current = state.inlineGlossary;
    const snapshot = current.snapshot;
    if (current.phase !== "offering" || !inlineSnapshotCurrent(snapshot)) {
      closeInlineGlossary();
      return Promise.resolve({ ok: false, ignored: true });
    }
    const text = snapshot.text;
    const pageUrl = snapshot.pageUrl;
    closeInlineGlossary();
    return runAnalysis("inline-assistant", text, pageUrl);
  }

  function retryInlineGlossary() {
    const current = state.inlineGlossary;
    if (current.phase !== "error" || !current.snapshot) {
      return Promise.resolve({ ok: false, ignored: true });
    }
    return performInlineGlossaryLookup(current.snapshot, current.selectionToken);
  }

  function inlineResultContainsCandidate(result, candidate) {
    if (!result || !candidate || typeof candidate.normalizedKey !== "string") return false;
    const candidates = [
      ...(Array.isArray(result.groups) ? result.groups.map((group) => group?.candidate) : []),
      ...(Array.isArray(result.missing) ? result.missing : []),
    ];
    return candidates.some((item) => (
      item?.normalizedKey === candidate.normalizedKey
      && item?.displayTerm === candidate.displayTerm
    ));
  }

  async function analyzeInlineGlossaryCandidate(candidate) {
    const current = state.inlineGlossary;
    if (current.phase !== "showing" || !current.snapshot
      || !inlineResultContainsCandidate(current.result, candidate)) {
      return { ok: false, ignored: true };
    }
    const snapshot = current.snapshot;
    if (!inlineGlossarySnapshotCurrent(snapshot)) {
      closeInlineGlossary();
      return { ok: false, ignored: true };
    }
    const displayTerm = candidate.displayTerm;
    const pageUrl = snapshot.pageUrl;
    closeInlineGlossary();
    return runAnalysis("inline-assistant", displayTerm, pageUrl);
  }

  function captureInlineGlossarySelection(generation) {
    if (state.inlineGesture.generation !== generation) return false;
    if (aiOperationBusy()
      || !conversationContextModule.isSupportedPage(location.href)) {
      closeInlineGlossary();
      return false;
    }
    if (typeof chatGptDom.captureInlineGlossarySelection !== "function") {
      closeInlineGlossary();
      return false;
    }
    const captured = chatGptDom.captureInlineGlossarySelection({
      pageUrl: location.href,
      extensionRoot: state.host,
    });
    if (!captured?.ok) {
      closeInlineGlossary();
      return false;
    }
    return showInlineOffer(captured);
  }

  function beginInlineGesture(kind, value) {
    closeInlineGlossary();
    const generation = state.inlineGesture.generation + 1;
    state.inlineGesture = {
      generation,
      pointerId: kind === "pointer" ? value.pointerId : null,
      pointerType: kind === "pointer" ? String(value.pointerType || "") : null,
      keyboardActive: kind === "keyboard",
      shiftHeld: kind === "keyboard" && value.shiftKey === true,
      selectionKeys: kind === "keyboard" ? [value.key] : [],
      startSignature: inlineSelectionSignature(),
      changed: false,
      pendingFrame: null,
      pendingTask: null,
    };
    return generation;
  }

  function markInlineGestureSelectionChanged() {
    if (state.inlineGesture.pointerId === null && !state.inlineGesture.keyboardActive) return;
    state.inlineGesture.changed = true;
  }

  function scheduleInlineGestureSettle(generation) {
    if (state.inlineGesture.generation !== generation) return;
    cancelInlineGestureSettle();
    const frame = typeof window.requestAnimationFrame === "function"
      ? window.requestAnimationFrame.bind(window)
      : (callback) => setTimeout(callback, 0);
    state.inlineGesture.pendingFrame = frame(() => {
      if (state.inlineGesture.generation !== generation) return;
      state.inlineGesture.pendingFrame = null;
      state.inlineGesture.pendingTask = setTimeout(() => {
        if (state.inlineGesture.generation !== generation
          || state.inlineGesture.pointerId !== null
          || state.inlineGesture.keyboardActive) return;
        state.inlineGesture.pendingTask = null;
        const changed = state.inlineGesture.changed
          || state.inlineGesture.startSignature !== inlineSelectionSignature();
        state.inlineGesture.changed = false;
        if (changed) captureInlineGlossarySelection(generation);
      }, 0);
    });
  }

  function finishInlineKeyboardGestureIfReady() {
    const gesture = state.inlineGesture;
    if (!gesture.keyboardActive
      || gesture.shiftHeld
      || gesture.selectionKeys.length !== 0) return false;
    const generation = gesture.generation;
    gesture.keyboardActive = false;
    scheduleInlineGestureSettle(generation);
    return true;
  }

  function inlineEventPath(event) {
    return typeof event?.composedPath === "function" ? event.composedPath() : [];
  }

  function inlineInternalEvent(event) {
    return state.analysisUi?.inlineContainsPath(inlineEventPath(event)) === true;
  }

  function supportedInlineSelectionKey(event) {
    if (!event?.shiftKey || event.altKey) return false;
    if ((event.ctrlKey || event.metaKey)
      && !["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(event.key)) {
      return false;
    }
    return ["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End", "PageUp", "PageDown"]
      .includes(event.key);
  }

  function inlineCopyShortcut(event) {
    return (event?.ctrlKey || event?.metaKey)
      && !event.altKey
      && String(event.key || "").toLowerCase() === "c";
  }

  function handleInlinePointerDown(event, path) {
    if (state.analysisUi?.inlineContainsPath(path)) return;
    closeInlineGlossary();
    if (event?.button !== 0 || event?.isPrimary === false || path.includes(state.host)) return;
    beginInlineGesture("pointer", event);
  }

  function handleInlinePointerUp(event) {
    const gesture = state.inlineGesture;
    if (gesture.pointerId === null || gesture.pointerId !== event?.pointerId) return;
    const generation = gesture.generation;
    gesture.pointerId = null;
    gesture.pointerType = null;
    scheduleInlineGestureSettle(generation);
  }

  function cancelInlinePointerGesture(event) {
    if (state.inlineGesture.pointerId === null
      || (Number.isFinite(event?.pointerId)
        && event.pointerId !== state.inlineGesture.pointerId)) return;
    closeInlineGlossary();
  }

  function handleInlineKeyDown(event) {
    if (inlineInternalEvent(event)) return;
    if (event?.key === "Escape" && state.inlineGlossary.phase !== "closed") return;
    if (event?.key === "Shift") {
      if (state.inlineGesture.keyboardActive) state.inlineGesture.shiftHeld = true;
      else closeInlineGlossary();
      return;
    }
    if (inlineCopyShortcut(event)) {
      scheduleInlineGlossaryCloseAfterEvent();
      return;
    }
    if (!supportedInlineSelectionKey(event)) {
      closeInlineGlossary();
      return;
    }
    if (state.inlineGesture.keyboardActive) {
      state.inlineGesture.shiftHeld = true;
      if (!state.inlineGesture.selectionKeys.includes(event.key)) {
        state.inlineGesture.selectionKeys.push(event.key);
      }
      return;
    }
    beginInlineGesture("keyboard", event);
  }

  function handleInlineKeyUp(event) {
    const gesture = state.inlineGesture;
    if (!gesture.keyboardActive) return;
    if (event?.key === "Shift") {
      gesture.shiftHeld = false;
      finishInlineKeyboardGestureIfReady();
      return;
    }
    if (!gesture.selectionKeys.includes(event?.key)) return;
    gesture.selectionKeys = gesture.selectionKeys.filter((key) => key !== event.key);
    gesture.shiftHeld = event?.shiftKey === true;
    finishInlineKeyboardGestureIfReady();
  }

  function closeInlineGlossaryOutsidePath(pathValue) {
    const path = Array.isArray(pathValue) ? pathValue : [];
    if (state.analysisUi?.inlineContainsPath(path)) return false;
    return closeInlineGlossary();
  }

  function handleInlineFocusIn(event) {
    return closeInlineGlossaryOutsidePath(inlineEventPath(event));
  }

  function scheduleInlineGlossaryCloseAfterEvent() {
    const generation = state.inlineGesture.generation;
    setTimeout(() => {
      if (state.inlineGesture.generation !== generation) return;
      closeInlineGlossary();
    }, 0);
  }

  function handleInlineCopy() {
    scheduleInlineGlossaryCloseAfterEvent();
  }

  function handleInlineExternalAction() {
    return closeInlineGlossary();
  }

  function closeInlineGlossaryForInvalidation(entityFamily) {
    if (![workspaceContract.ENTITY_FAMILIES.ALL, workspaceContract.ENTITY_FAMILIES.GLOSSARY]
      .includes(entityFamily)) return false;
    return closeInlineGlossary();
  }

  function handleWorkspaceContextChange(context) {
    closeInlineGlossary();
    closeWorkspaceDelete();
    state.workspaceContext = context;
    state.glossaryRequestedMode = "local";
    state.glossarySearch = "";
    state.savedRequestedMode = "local";
    state.savedSearch = "";
    state.glossaryEntries = [];
    state.savedEntries = [];
    if (state.open && ["analysis", "saved"].includes(state.activeSection)) renderSection();
    void Promise.all([refreshGlossary(), refreshSaved()]).catch(handleUiError);
  }

  function handleWorkspaceStatusChange(status) {
    const previous = state.workspaceStatus;
    state.workspaceStatus = status;
    if (status.status === "unavailable") {
      if (state.inlineGlossary.phase === "offering" && state.inlineGlossary.snapshot) {
        state.analysisUi?.showInlineOffer(
          state.inlineGlossary.snapshot,
          inlineUiHandlers(),
          { glossaryEnabled: false },
        );
      } else {
        closeInlineGlossary();
      }
      closeWorkspaceDelete();
      state.workspaceContext = null;
      state.glossaryEntries = [];
      state.savedEntries = [];
    } else if (status.status === "ready"
      && state.inlineGlossary.phase === "offering"
      && state.inlineGlossary.snapshot) {
      state.analysisUi?.showInlineOffer(
        state.inlineGlossary.snapshot,
        inlineUiHandlers(),
        { glossaryEnabled: Boolean(state.workspaceContext) },
      );
    }
    if (state.open && ["analysis", "saved"].includes(state.activeSection)
      && (previous.status !== status.status || previous.message !== status.message)) {
      renderSection();
    }
  }

  async function deleteWorkspaceEntry(kind, id, scope) {
    if (!workspaceUiModule.workspaceDeleteOwns(state.workspaceDelete, kind, id)
      || state.workspaceDelete.phase !== "choosing") return;
    const entry = workspaceEntries(kind).find((item) => item.id === id);
    if (!entry) {
      settleWorkspaceDelete();
      renderSection();
      return;
    }
    if (scope === "local" && !workspaceUiModule.workspaceDeleteLocalAvailable(workspaceMode(kind), entry)) return;
    const operation = workspaceUiModule.workspaceDeleteOperation(kind, scope);
    if (!operation || typeof state.workspaceClient?.[operation] !== "function") return;

    state.workspaceDelete = workspaceUiModule.transitionWorkspaceDelete(
      state.workspaceDelete,
      { type: "begin", scope },
    );
    renderSection();
    try {
      const response = await state.workspaceClient[operation](id);
      if (!response?.ok) {
        const fallback = kind === "glossary"
          ? contract.ERROR_MESSAGES.GLOSSARY_STORAGE_FAILED
          : "Не удалось удалить сохранённый текст.";
        throw new Error(response?.error?.message || fallback);
      }
      if (kind === "glossary") await refreshGlossary();
      else await refreshSaved();
      settleWorkspaceDelete();
      const success = kind === "glossary"
        ? (scope === "local" ? "Термин удалён из этого чата." : "Термин удалён везде.")
        : (scope === "local" ? "Текст удалён из этого чата." : "Текст удалён везде.");
      setStatus("success", success);
    } catch (error) {
      settleWorkspaceDelete();
      setStatus("error", error?.message || "Не удалось удалить запись.");
    }
  }

  async function reorderGlossaryEntries(sourceId, beforeEntryId) {
    const effectiveMode = workspaceUiModule.activeSearchMode(state.glossaryRequestedMode, state.glossarySearch);
    if (!sourceId || sourceId === beforeEntryId || state.glossarySearch.trim() || effectiveMode !== "local") return;
    const response = await state.workspaceClient?.moveGlossary(sourceId, beforeEntryId);
    if (!response?.ok) {
      setStatus("error", response?.error?.message || contract.ERROR_MESSAGES.GLOSSARY_STORAGE_FAILED);
      return;
    }
    await refreshGlossary();
    setStatus("success", "Порядок терминов сохранён.");
  }

  async function reorderSavedEntries(sourceId, beforeItemId) {
    const effectiveMode = workspaceUiModule.activeSearchMode(state.savedRequestedMode, state.savedSearch);
    if (!sourceId || sourceId === beforeItemId || state.savedSearch.trim() || effectiveMode !== "local") return;
    const response = await state.workspaceClient?.moveSaved(sourceId, beforeItemId);
    if (!response?.ok) throw new Error(response?.error?.message || "Не удалось изменить порядок.");
    await refreshSaved();
    setStatus("success", "Порядок сохранённого обновлён.");
  }

  function readSelectedTextSnapshot(fallbackValue) {
    const fallback = typeof fallbackValue === "string"
      ? fallbackValue
      : String(window.getSelection?.().toString() || "");
    const structured = chatGptDom.readSelectionText?.(fallback);
    return typeof structured === "string" ? structured : fallback;
  }

  async function saveSelectionSnapshot(text, successText) {
    const snapshot = String(text || "");
    if (state.workspaceStatus.status === "unavailable") {
      const response = {
        ok: false,
        error: { code: "WORKSPACE_MIGRATION_FAILED", message: "Workspace недоступен. Выделение не было сохранено." },
      };
      state.analysisUi?.showHint(response.error.message);
      return response;
    }
    let response;
    try {
      response = await state.workspaceClient?.saveSelection(snapshot);
    } catch (error) {
      response = { ok: false, error: { message: error?.message || "Контекст чата ещё не готов." } };
    }
    if (!response?.ok) {
      state.analysisUi?.showHint(response?.error?.message || "Не удалось сохранить выделенный текст.");
      return response;
    }
    await refreshSaved();
    state.analysisUi?.showHint(successText || (response.changed ? "Выделенный текст сохранён." : "Этот текст уже сохранён в текущем чате."));
    return response;
  }

  async function runAnalysis(trigger, selectionText, pageUrl) {
    closeInlineGlossary();
    const snapshot = typeof selectionText === "string" ? selectionText : String(window.getSelection?.().toString() || "");
    const response = await state.analysisController?.start(snapshot, trigger, pageUrl || location.href);
    if (response?.mutationBusy) state.analysisUi?.showHint("Импорт выполняется. Повторите сохранение терминов позже.");
    return response;
  }

  async function runTranslation(trigger, selectionText, pageUrl) {
    closeInlineGlossary();
    const snapshot = readSelectedTextSnapshot(selectionText);
    return state.translationController?.start(snapshot, trigger, pageUrl || location.href);
  }

  async function runSaveSelection(trigger, selectionText, pageUrl) {
    if (!new Set(["browser-command", "context-menu"]).has(trigger)) return { ok: false };
    const snapshot = readSelectedTextSnapshot(selectionText);
    await state.contextClient?.sync(pageUrl || location.href);
    return saveSelectionSnapshot(snapshot);
  }

  function runNormalizeComposer(trigger) {
    if (!new Set(["browser-command", "context-menu"]).has(trigger)) return { ok: false };
    const result = chatGptDom.normalizeComposer({ requireFocus: true });
    state.analysisUi?.showHint(result.ok
      ? (result.changed ? "Пустые строки нормализованы." : "Изменений не требуется.")
      : result.error);
    return result;
  }

  async function recordRecentTemplate(id) {
    const previous = state.recentTemplateIds;
    try {
      const response = await chrome.runtime.sendMessage({
        type: workspaceContract.MESSAGE_TYPES.RECENT_TEMPLATE_TOUCH,
        templateId: id,
      });
      if (!response?.ok) throw new Error(response?.error?.message || "Не удалось обновить историю шаблонов.");
      if (!applyTemplateMutationResponse(response)) throw new Error(state.templateTreeError);
    } catch (error) {
      state.recentTemplateIds = previous;
      throw error;
    }
  }

  function showTemplateRunError(text) {
    closeRecentPopup();
    state.activeSection = "templates";
    state.status = { kind: "error", text: text || "Не удалось выполнить шаблон." };
    if (state.shellPhase === "closed") openSection("templates", { preserveStatus: true });
    else if (state.shellPhase === "open") renderSection();
  }

  async function runTemplate(id) {
    const template = state.templates.find(function findTemplate(item) { return item.id === id; });
    if (!template || template.kind !== templateTree.NODE_KINDS.TEMPLATE || state.busyTemplateId) return;
    state.busyTemplateId = id;
    clearStatus();
    if (state.open) renderSection();
    try {
      const adapter = window.ChatGPTTemplateDom;
      const result = adapter?.executeTemplate
        ? await adapter.executeTemplate(template.content, template.autoSend)
        : { ok: false, error: "Адаптер ChatGPT недоступен." };
      const execution = workspaceContract.interpretTemplateExecutionResult(result, {
        requireSent: template.autoSend === true,
      });
      if (execution.insertionFailed) {
        showTemplateRunError(result?.error || "Не удалось выполнить шаблон.");
        return;
      }

      try {
        await recordRecentTemplate(id);
      } catch (error) {
        console.warn("ChatGPT Templates recent history update failed.", error);
        showTemplateRunError("Шаблон выполнен, но не удалось обновить историю запусков.");
        return;
      }

      if (execution.verificationFailed) {
        showTemplateRunError(result.error || "Шаблон вставлен, но не удалось подтвердить содержимое.");
        return;
      }
      if (execution.sendFailed) {
        showTemplateRunError(result.error || "Шаблон вставлен, но не удалось отправить.");
        return;
      }

      state.status = {
        kind: "success",
        text: result.sent ? "Шаблон вставлен и отправлен." : "Шаблон вставлен.",
      };
      if (state.open) renderSection();
      if (state.settings.closePanelAfterRun) closePanel();
    } catch (error) {
      showTemplateRunError(error?.message || "Не удалось выполнить шаблон.");
    } finally {
      state.busyTemplateId = null;
      if (state.open) renderSection();
    }
  }

  async function runQuickAction(button) {
    if (state.quickBusy) return;
    const adapter = window.ChatGPTTemplateDom;
    const composerState = adapter?.readComposer ? adapter.readComposer() : null;
    if (composerState?.ok && !composerState.empty) return;

    state.quickBusy = true;
    button.disabled = true;
    try {
      const result = adapter?.executeNextQuickAction
        ? await adapter.executeNextQuickAction()
        : { ok: false };
      const execution = workspaceContract.interpretTemplateExecutionResult(result, { requireSent: true });
      if (!execution.accepted && !execution.noop) {
        console.warn("ChatGPT Templates quick action failed.", result?.error || "Unknown error");
      }
    } catch (error) {
      console.warn("ChatGPT Templates quick action failed.", error);
    } finally {
      state.quickBusy = false;
      button.disabled = false;
    }
  }

  function openNodeEditor(kind, targetParentId, nodeId, returnFocusTarget) {
    if (state.editing) {
      captureEditorInputs();
      state.status = {
        kind: "error",
        text: "Сохраните или отмените открытый редактор перед другим действием.",
      };
      return false;
    }
    const node = nodeId ? templateTree.findNode(state.templates, nodeId) : null;
    if (nodeId && !node) return false;
    const nodeKind = node?.kind || kind;
    const isTemplate = nodeKind === templateTree.NODE_KINDS.TEMPLATE;
    const template = isTemplate ? node : null;
    const templateOriginalEnvelope = template
      ? { original: { name: template.name, content: template.content } }
      : null;
    const values = {
      id: node?.id || null,
      kind: nodeKind,
      name: node?.name || "",
      iconKey: node?.iconKey || (isTemplate
        ? templateTree.DEFAULT_TEMPLATE_ICON
        : templateTree.DEFAULT_FOLDER_ICON),
      content: isTemplate ? (node?.content || "") : "",
      autoSend: isTemplate ? node?.autoSend === true : false,
      targetParentId: node ? node.parentId : (targetParentId || null),
    };
    state.editorReturnFocusTarget = boundedTemplateFocusTarget(returnFocusTarget)
      || { action: "add-template", nodeId: null };
    state.editing = {
      ...values,
      original: node ? {
        ...(templateOriginalEnvelope?.original || { name: values.name }),
        iconKey: values.iconKey,
        autoSend: values.autoSend,
        parentId: values.targetParentId,
      } : null,
    };
    state.editorError = "";
    state.templateDeleteId = null;
    state.folderDelete = closedFolderDeleteState();
    state.deleteReturnFocusTarget = null;
    return true;
  }

  function captureEditorInputs() {
    const editorElement = state.shadow.querySelector("[data-editor]");
    if (!editorElement || !state.editing) return false;
    const name = editorElement.querySelector('[data-field="name"]');
    const content = editorElement.querySelector('[data-field="content"]');
    const autoSend = editorElement.querySelector('[data-field="autoSend"]');
    const parentId = editorElement.querySelector('[data-field="parentId"]');
    state.editing = {
      ...state.editing,
      name: name?.value ?? state.editing.name,
      content: content?.value ?? state.editing.content,
      autoSend: autoSend ? autoSend.checked : state.editing.autoSend,
      targetParentId: parentId ? (parentId.value || null) : state.editing.targetParentId,
    };
    return true;
  }

  function dismissTemplateEditorAndRender() {
    if (!state.editing) return false;
    queuePendingTemplateFocus(state.editorReturnFocusTarget);
    state.editorReturnFocusTarget = null;
    state.editing = null;
    state.editorError = "";
    renderSection();
    return true;
  }

  function dismissTemplateNodeDeleteAndRender() {
    if (state.templateDeleteId === null && state.folderDelete.nodeId === null) return false;
    queuePendingTemplateFocus(state.deleteReturnFocusTarget);
    state.deleteReturnFocusTarget = null;
    state.templateDeleteId = null;
    state.folderDelete = closedFolderDeleteState();
    renderSection();
    return true;
  }

  async function saveEditor() {
    if (!captureEditorInputs()) return;
    const editor = state.editing;
    const isTemplate = editor.kind === templateTree.NODE_KINDS.TEMPLATE;
    if (!editor.name.trim() || (isTemplate && !editor.content.trim())) {
      state.editorError = isTemplate
        ? "Заполните название и текст шаблона."
        : "Заполните название папки.";
      renderSection();
      return;
    }

    if (editor.id === null) {
      const draft = {
        kind: editor.kind,
        name: editor.name,
        iconKey: editor.iconKey,
        ...(isTemplate ? { content: editor.content, autoSend: editor.autoSend } : {}),
      };
      if (await saveTemplateMutation({
        type: workspaceContract.MESSAGE_TYPES.TEMPLATE_NODE_CREATE,
        draft,
        targetParentId: editor.targetParentId,
        beforeNodeId: null,
      })) {
        state.editing = null;
        state.editorError = "";
        state.editorReturnFocusTarget = null;
        setStatus("success", isTemplate ? "Шаблон сохранён." : "Папка создана.");
      }
      return;
    }

    const name = editor.name;
    const content = editor.content;
    const patch = isTemplate
      ? workspaceContract.createTemplatePatch(state.editing.original, { name, content })
      : {};
    const fields = isTemplate ? ["iconKey", "autoSend"] : ["name", "iconKey"];
    fields.forEach((field) => {
      if (!Object.is(editor.original[field], editor[field])) patch[field] = editor[field];
    });
    const placement = editor.original.parentId === editor.targetParentId
      ? undefined
      : { targetParentId: editor.targetParentId, beforeNodeId: null };
    if (!Object.keys(patch).length && !placement) {
      state.editing = null;
      state.editorError = "";
      state.editorReturnFocusTarget = null;
      setStatus("success", "Изменений нет.");
      return;
    }
    if (await saveTemplateMutation({
      type: workspaceContract.MESSAGE_TYPES.TEMPLATE_NODE_UPDATE,
      nodeId: editor.id,
      patch,
      ...(placement ? { placement } : {}),
    })) {
      state.editing = null;
      state.editorError = "";
      state.editorReturnFocusTarget = null;
      setStatus("success", isTemplate ? "Шаблон сохранён." : "Папка сохранена.");
    }
  }

  async function deleteTemplateNode(id, mode) {
    const node = templateTree.findNode(state.templates, id);
    if (!node) return;
    if (await saveTemplateMutation({
      type: workspaceContract.MESSAGE_TYPES.TEMPLATE_NODE_DELETE,
      nodeId: id,
      mode,
    })) {
      if (state.editing?.id === id) state.editing = null;
      state.templateDeleteId = null;
      state.folderDelete = closedFolderDeleteState();
      state.deleteReturnFocusTarget = null;
      const text = node.kind === templateTree.NODE_KINDS.TEMPLATE
        ? "Шаблон удалён."
        : (mode === "subtree" ? "Папка и содержимое удалены." : "Папка удалена, содержимое перемещено выше.");
      setStatus("success", text);
    }
  }

  async function toggleFolderCollapse(folderId) {
    const folder = templateTree.findNode(state.templates, folderId);
    if (!folder || folder.kind !== templateTree.NODE_KINDS.FOLDER) return;
    const collapsed = new Set(state.templateTreeUiState.collapsedFolderIds);
    const willCollapse = !collapsed.has(folderId);
    if (willCollapse) collapsed.add(folderId);
    else collapsed.delete(folderId);
    if (willCollapse) {
      const hiddenIds = new Set(templateTree.descendantsOf(state.templates, folderId).map((node) => node.id));
      if (hiddenIds.has(state.preview.templateId)) closeTemplatePreview();
      if (hiddenIds.has(state.templateDeleteId)) state.templateDeleteId = null;
      if (hiddenIds.has(state.folderDelete.nodeId)) state.folderDelete = closedFolderDeleteState();
    }
    if (await saveTemplateMutation({
      type: workspaceContract.MESSAGE_TYPES.TEMPLATE_TREE_UI_UPDATE,
      templateTreeUiState: { collapsedFolderIds: [...collapsed] },
    })) {
      renderSection();
    }
  }

  function fileToDataUrl(file) {
    return new Promise(function readFile(resolve, reject) {
      const reader = new FileReader();
      reader.addEventListener("load", function loaded() { resolve(reader.result); }, { once: true });
      reader.addEventListener("error", function failed() { reject(reader.error || new Error("Не удалось прочитать изображение.")); }, { once: true });
      reader.readAsDataURL(file);
    });
  }

  async function updateWallpaper(input) {
    const file = input.files?.[0];
    if (!file) return;
    const validation = workspaceContract.validateWallpaperSourceFile(file);
    if (!validation.ok) {
      setStatus("error", validation.message);
      return;
    }
    try {
      const dataUrl = await fileToDataUrl(file);
      if (typeof dataUrl !== "string" || !dataUrl.startsWith("data:image/")) {
        setStatus("error", "Не удалось подготовить изображение.");
        return;
      }
      await saveSettings(
        { ...state.settings, wallpaperDataUrl: dataUrl },
        "Обои сохранены.",
        "Не удалось сохранить обои: хранилище недоступно или переполнено.",
      );
    } catch (error) {
      setStatus("error", error?.message || "Не удалось сохранить обои.");
    }
  }

  async function onShadowClick(event) {
    const sectionButton = event.target.closest("[data-section]");
    if (sectionButton) {
      openSection(sectionButton.dataset.section);
      return;
    }

    const actionButton = event.target.closest("[data-action]");
    if (!actionButton) return;
    const action = actionButton.dataset.action;
    const id = actionButton.dataset.id;
    const kind = actionButton.dataset.kind;
    closeTemplatePreview();

    if (action === "open-analysis-options") {
      await state.analysisController?.openOptions();
    } else if (action === "open-extension-options") {
      await state.analysisController?.openOptions();
    } else if (action === "reset-interface-sizes") {
      await saveSettings({
        ...state.settings,
        layout: {
          sidebarWidth: workspaceContract.LAYOUT.sidebarWidth.default,
          analysisDialogWidth: workspaceContract.LAYOUT.analysisDialogWidth.default,
        },
      }, "Размеры интерфейса сброшены.");
    } else if (action === "reset-analysis-appearance") {
      await saveSettings({
        ...state.settings,
        analysis: {
          ...state.settings.analysis,
          termColorMode: contract.DEFAULT_ANALYSIS_SETTINGS.termColorMode,
          customTermColor: contract.DEFAULT_ANALYSIS_SETTINGS.customTermColor,
          glossaryTextSize: contract.DEFAULT_ANALYSIS_SETTINGS.glossaryTextSize,
        },
      }, "Вид словаря сброшен.");
    } else if (action === "glossary-mode-local") {
      closeWorkspaceDelete();
      state.glossaryRequestedMode = "local";
      state.glossaryEntries = [];
      renderSection();
      await refreshGlossary();
    } else if (action === "glossary-mode-global") {
      closeWorkspaceDelete();
      state.glossaryRequestedMode = "global";
      state.glossaryEntries = [];
      renderSection();
      await refreshGlossary();
      state.body.querySelector('[data-action="glossary-search"]')?.focus();
    } else if (action === "attach-glossary") {
      const response = await state.workspaceClient?.attachGlossary(id);
      if (!response?.ok) throw new Error(response?.error?.message || "Не удалось добавить термин в чат.");
      await refreshGlossary();
      setStatus("success", "Термин добавлен в текущий чат.");
    } else if (action === "saved-mode-local") {
      closeWorkspaceDelete();
      state.savedRequestedMode = "local";
      state.savedEntries = [];
      renderSection();
      await refreshSaved();
    } else if (action === "saved-mode-global") {
      closeWorkspaceDelete();
      state.savedRequestedMode = "global";
      state.savedEntries = [];
      renderSection();
      await refreshSaved();
      state.body.querySelector('[data-action="saved-search"]')?.focus();
    } else if (action === "retry-workspace") {
      await state.contextClient?.retry();
    } else if (action === "copy-saved") {
      const entry = state.savedEntries.find((item) => item.id === id);
      if (!entry) throw new Error("Сохранённый текст не найден.");
      if (!navigator.clipboard || typeof navigator.clipboard.writeText !== "function") {
        throw new Error("Копирование в буфер обмена недоступно.");
      }
      resetCopyFeedback(actionButton);
      try {
        await navigator.clipboard.writeText(entry.text);
      } catch (_error) {
        throw new Error("Не удалось скопировать сохранённый текст.");
      }
      showCopyFeedback(actionButton);
      setStatusInPlace("success", "Сохранённый текст скопирован.");
    } else if (action === "attach-saved") {
      const entry = state.savedEntries.find((item) => item.id === id);
      if (!entry) throw new Error("Сохранённый текст не найден.");
      await saveSelectionSnapshot(entry.text, "Текст добавлен в текущий чат.");
    } else if (action === "workspace-delete-toggle") {
      state.workspaceDelete = workspaceUiModule.transitionWorkspaceDelete(
        state.workspaceDelete,
        { type: "trigger", kind, entryId: id },
      );
      renderSection();
    } else if (action === "workspace-delete-local") {
      await deleteWorkspaceEntry(kind, id, "local");
    } else if (action === "workspace-delete-global") {
      await deleteWorkspaceEntry(kind, id, "global");
    } else if (action === "open-panel") {
      closeRecentPopup();
      openSection(state.activeSection);
    }
    else if (action === "quick-next") await runQuickAction(actionButton);
    else if (action === "add-template") {
      openNodeEditor(
        templateTree.NODE_KINDS.TEMPLATE,
        null,
        null,
        templateFocusTargetFromAction(actionButton),
      );
      renderSection();
    } else if (action === "add-folder") {
      openNodeEditor(
        templateTree.NODE_KINDS.FOLDER,
        null,
        null,
        templateFocusTargetFromAction(actionButton),
      );
      renderSection();
    } else if (action === "add-template-in-folder") {
      openNodeEditor(
        templateTree.NODE_KINDS.TEMPLATE,
        id,
        null,
        templateFocusTargetFromAction(actionButton),
      );
      renderSection();
    } else if (action === "add-folder-in-folder") {
      if (templateTree.folderDepth(state.templates, id) >= templateTree.MAX_FOLDER_DEPTH) {
        setStatus("error", "Достигнута максимальная глубина папок.");
      } else {
        openNodeEditor(
          templateTree.NODE_KINDS.FOLDER,
          id,
          null,
          templateFocusTargetFromAction(actionButton),
        );
        renderSection();
      }
    } else if (action === "select-editor-icon") {
      if (!state.editing) return;
      captureEditorInputs();
      state.editing = {
        ...state.editing,
        iconKey: templateTree.normalizeIconKey(state.editing.kind, actionButton.dataset.iconKey),
      };
      renderSection();
      Array.from(state.body.querySelectorAll("[data-icon-key]"))
        .find((element) => element.dataset.iconKey === state.editing.iconKey)
        ?.focus();
    } else if (action === "toggle-folder") {
      await toggleFolderCollapse(id);
    } else if (action === "toggle-delete-mode") {
      state.deleteMode = !state.deleteMode;
      if (!state.deleteMode) {
        state.templateDeleteId = null;
        state.folderDelete = closedFolderDeleteState();
        state.deleteReturnFocusTarget = null;
      }
      renderSection();
    } else if (action === "run-template") {
      await runTemplate(id);
    } else if (action === "run-recent-template") {
      closeRecentPopup();
      await runTemplate(id);
    } else if (action === "edit-node") {
      if (state.editing) {
        captureEditorInputs();
        state.status = {
          kind: "error",
          text: "Сохраните или отмените открытый редактор перед другим действием.",
        };
      } else {
        const node = templateTree.findNode(state.templates, id);
        if (node) {
          openNodeEditor(
            node.kind,
            node.parentId,
            node.id,
            templateFocusTargetFromAction(actionButton),
          );
        }
      }
      state.editorError = "";
      state.templateDeleteId = null;
      state.folderDelete = closedFolderDeleteState();
      state.deleteReturnFocusTarget = null;
      renderSection();
    } else if (action === "cancel-edit") {
      dismissTemplateEditorAndRender();
    } else if (action === "save-edit") await saveEditor();
    else if (action === "ask-node-delete") {
      if (state.editing) {
        captureEditorInputs();
        state.status = {
          kind: "error",
          text: "Сохраните или отмените открытый редактор перед удалением.",
        };
        renderSection();
        return;
      }
      const node = templateTree.findNode(state.templates, id);
      if (!node) return;
      state.deleteReturnFocusTarget = templateFocusTargetFromAction(actionButton)
        || { action: "add-template", nodeId: null };
      state.templateDeleteId = node?.kind === templateTree.NODE_KINDS.TEMPLATE ? id : null;
      state.folderDelete = node?.kind === templateTree.NODE_KINDS.FOLDER
        ? { nodeId: id, phase: "choice" }
        : closedFolderDeleteState();
      renderSection();
    } else if (action === "cancel-node-delete") {
      dismissTemplateNodeDeleteAndRender();
    } else if (action === "confirm-template-delete") {
      await deleteTemplateNode(id, "node");
    } else if (action === "confirm-folder-promote-delete") {
      await deleteTemplateNode(id, "promote-children");
    } else if (action === "ask-folder-subtree-delete") {
      if (state.folderDelete.nodeId === id) {
        state.folderDelete = { nodeId: id, phase: "confirm-subtree" };
        renderSection();
      }
    } else if (action === "confirm-folder-subtree-delete") {
      await deleteTemplateNode(id, "subtree");
    }
    else if (action === "remove-wallpaper") {
      await saveSettings({ ...state.settings, wallpaperDataUrl: null }, "Обои удалены.");
    }
  }

  async function onShadowChange(event) {
    const action = event.target.dataset.action;
    if (action) closeTemplatePreview();
    if (action === "auto-send") {
      const id = event.target.dataset.id;
      const template = state.templates.find((item) => item.id === id);
      if (template?.kind === templateTree.NODE_KINDS.TEMPLATE && await saveTemplateMutation({
        type: workspaceContract.MESSAGE_TYPES.TEMPLATE_NODE_UPDATE,
        nodeId: id,
        patch: { autoSend: event.target.checked },
      })) setStatus("success", "Автоотправка сохранена.");
      else renderSection();
    } else if (state.editing && event.target.matches("[data-field]")) {
      captureEditorInputs();
    } else if (action === "theme") {
      const theme = event.target.value;
      if (VALID_THEMES.has(theme)) {
        await saveSettings({ ...state.settings, theme: theme }, "Тема сохранена.");
      }
    } else if (action === "close-panel-after-run") {
      await saveSettings({ ...state.settings, closePanelAfterRun: event.target.checked }, "Настройка запуска сохранена.");
    } else if (action === "close-panel-on-outside-click") {
      await saveSettings({ ...state.settings, closePanelOnOutsideClick: event.target.checked }, "Настройка закрытия панели сохранена.");
    } else if (action === "recent-templates-hover") {
      await saveSettings({ ...state.settings, recentTemplatesHoverEnabled: event.target.checked }, "Настройка последних шаблонов сохранена.");
    } else if (action === "recent-templates-count") {
      await saveSettings({
        ...state.settings,
        recentTemplatesHoverCount: Number(event.target.value),
      }, "Количество последних шаблонов сохранено.");
    } else if (action === "analysis-term-color-mode") {
      await saveSettings({
        ...state.settings,
        analysis: { ...state.settings.analysis, termColorMode: event.target.value === "custom" ? "custom" : "theme" },
      }, "Цвет терминов сохранён.");
    } else if (action === "analysis-custom-term-color") {
      await saveSettings({
        ...state.settings,
        analysis: { ...state.settings.analysis, customTermColor: event.target.value },
      }, "Цвет терминов сохранён.");
    } else if (action === "analysis-text-size") {
      await saveSettings({
        ...state.settings,
        analysis: { ...state.settings.analysis, glossaryTextSize: event.target.value },
      }, "Размер текста сохранён.");
    } else if (action === "wallpaper") {
      await updateWallpaper(event.target);
    }
  }

  function onShadowInput(event) {
    if (event.target.dataset.action === "analysis-custom-term-color" && /^#[0-9a-f]{6}$/i.test(event.target.value)) {
      state.body.querySelector(".glossary-preview")?.style.setProperty("--term-color", event.target.value);
      return;
    }
    if (event.target.dataset.action === "glossary-search") {
      const menuClosed = closeWorkspaceDelete();
      state.glossarySearch = event.target.value;
      const cursor = event.target.selectionStart;
      if (menuClosed || (workspaceMode("glossary") === "global" && !state.glossarySearch.trim())) {
        renderSection();
        const search = state.body.querySelector('[data-action="glossary-search"]');
        search?.focus();
        if (Number.isInteger(cursor)) search?.setSelectionRange(cursor, cursor);
      }
      void refreshGlossary().then(() => {
        const search = state.body.querySelector('[data-action="glossary-search"]');
        search?.focus();
        if (Number.isInteger(cursor)) search?.setSelectionRange(cursor, cursor);
      }).catch(handleUiError);
      return;
    }
    if (event.target.dataset.action === "saved-search") {
      const menuClosed = closeWorkspaceDelete();
      state.savedSearch = event.target.value;
      const cursor = event.target.selectionStart;
      if (menuClosed || (workspaceMode("saved") === "global" && !state.savedSearch.trim())) {
        renderSection();
        const search = state.body.querySelector('[data-action="saved-search"]');
        search?.focus();
        if (Number.isInteger(cursor)) search?.setSelectionRange(cursor, cursor);
      }
      void refreshSaved().then(() => {
        const search = state.body.querySelector('[data-action="saved-search"]');
        search?.focus();
        if (Number.isInteger(cursor)) search?.setSelectionRange(cursor, cursor);
      }).catch(handleUiError);
      return;
    }
    if (!state.editing || !event.target.matches("[data-field]")) return;
    const field = event.target.dataset.field;
    if (field === "name" || field === "content") {
      state.editing = { ...state.editing, [field]: event.target.value };
    } else if (field === "autoSend") {
      state.editing = { ...state.editing, autoSend: event.target.checked };
    } else if (field === "parentId") {
      state.editing = { ...state.editing, targetParentId: event.target.value || null };
    }
  }

  function nextTemplateSiblingId(node) {
    const siblings = templateTree.childrenOf(state.templates, node.parentId);
    const index = siblings.findIndex((candidate) => candidate.id === node.id);
    return index >= 0 ? (siblings[index + 1]?.id || null) : null;
  }

  function isTemplateRootDropTarget(target) {
    return Boolean(target?.closest?.("[data-template-root-target]"));
  }

  function templateDropIntent(event) {
    const draggingNodeId = state.templateTreeDrag.draggingNodeId;
    if (!draggingNodeId) return null;
    state.templateTreeDrag.invalidError = null;
    const card = event.target.closest("[data-template-node-id]");
    let intent;
    if (!card) {
      if (!isTemplateRootDropTarget(event.target)) return null;
      intent = {
        zone: "inside",
        targetNodeId: null,
        targetParentId: null,
        beforeNodeId: null,
        root: true,
      };
    } else {
      const target = templateTree.findNode(state.templates, card.dataset.templateNodeId);
      if (!target) return null;
      const rect = card.getBoundingClientRect();
      const ratio = rect.height > 0 ? (event.clientY - rect.top) / rect.height : 0;
      const zone = workspaceUiModule.templateDropZone(target.kind, ratio);
      if (zone === "inside") {
        intent = {
          zone,
          targetNodeId: target.id,
          targetParentId: target.id,
          beforeNodeId: null,
          root: false,
        };
      } else if (zone === "before") {
        intent = {
          zone,
          targetNodeId: target.id,
          targetParentId: target.parentId,
          beforeNodeId: target.id,
          root: false,
        };
      } else {
        intent = {
          zone,
          targetNodeId: target.id,
          targetParentId: target.parentId,
          beforeNodeId: nextTemplateSiblingId(target),
          root: false,
        };
      }
    }
    const dryRun = templateTree.moveNode(state.templates, {
      nodeId: draggingNodeId,
      targetParentId: intent.targetParentId,
      beforeNodeId: intent.beforeNodeId,
    });
    if (!dryRun.ok) {
      state.templateTreeDrag.invalidError = dryRun.error;
      return null;
    }
    return intent;
  }

  function showTemplateDropIntent(intent) {
    clearTemplateDropIndicators();
    if (!intent) return;
    if (intent.root) {
      state.shadow.querySelector("[data-template-root-target]")?.classList.add("is-drop-inside");
      return;
    }
    const slot = Array.from(state.shadow.querySelectorAll("[data-template-slot-id]"))
      .find((element) => element.dataset.templateSlotId === intent.targetNodeId);
    if (slot) slot.classList.add("is-drop-" + intent.zone);
  }

  function removeTemporaryTemplateExpansionMarkup() {
    state.shadow?.querySelectorAll("[data-temporary-expanded-for]").forEach((group) => {
      group.remove();
    });
    state.templateTreeDrag.temporarilyExpandedFolderIds.forEach((folderId) => {
      const card = Array.from(state.shadow.querySelectorAll("[data-template-node-id]"))
        .find((element) => element.dataset.templateNodeId === folderId);
      const toggle = card?.querySelector('[data-action="toggle-folder"]');
      if (toggle) {
        toggle.setAttribute("aria-expanded", "false");
        toggle.title = "Развернуть папку";
        toggle.setAttribute("aria-label", "Развернуть папку");
      }
    });
  }

  function setTemporaryTemplateExpansions(folderIds) {
    const next = [...new Set(Array.isArray(folderIds) ? folderIds : [])];
    const current = state.templateTreeDrag.temporarilyExpandedFolderIds;
    if (current.length === next.length
      && current.every((folderId, index) => folderId === next[index])) return false;
    removeTemporaryTemplateExpansionMarkup();
    state.templateTreeDrag.temporarilyExpandedFolderIds = next;
    renderTemporaryTemplateExpansion();
    return true;
  }

  function renderTemporaryTemplateExpansion() {
    removeTemporaryTemplateExpansionMarkup();
    const visibleById = templateProjectionById();
    const temporaryFolderIds = state.templateTreeDrag.temporarilyExpandedFolderIds;
    const temporarySet = new Set(temporaryFolderIds);
    const temporaryRoots = temporaryFolderIds.filter((folderId) => !templateTree
      .ancestorsOf(state.templates, folderId)
      .some((ancestor) => temporarySet.has(ancestor.id)));
    temporaryRoots.forEach((folderId) => {
      const slot = Array.from(state.shadow.querySelectorAll("[data-template-slot-id]"))
        .find((element) => element.dataset.templateSlotId === folderId);
      if (!slot) return;
      const nested = treeChildrenMarkup(folderId, visibleById, false, folderId);
      if (nested) slot.insertAdjacentHTML("beforeend", nested);
    });
    temporaryFolderIds.forEach((folderId) => {
      const slot = Array.from(state.shadow.querySelectorAll("[data-template-slot-id]"))
        .find((element) => element.dataset.templateSlotId === folderId);
      const toggle = slot?.querySelector(
        ':scope > [data-template-node-id] [data-action="toggle-folder"]',
      );
      if (toggle) {
        toggle.setAttribute("aria-expanded", "true");
        toggle.title = "Свернуть папку";
        toggle.setAttribute("aria-label", "Свернуть папку");
      }
    });
    showTemplateDropIntent(state.templateTreeDrag.intent);
  }

  function clearTemplateDragIntent(revertTemporary) {
    clearTemplateHoverTimer();
    state.templateTreeDrag.intent = null;
    clearTemplateDropIndicators();
    if (revertTemporary && state.templateTreeDrag.temporarilyExpandedFolderIds.length) {
      setTemporaryTemplateExpansions([]);
    }
  }

  function templateIntentFolderPath(intent) {
    if (!intent || intent.root || !intent.targetNodeId) return new Set();
    const target = templateTree.findNode(state.templates, intent.targetNodeId);
    if (!target) return new Set();
    const path = new Set(
      templateTree.ancestorsOf(state.templates, target.id)
        .filter((ancestor) => ancestor.kind === templateTree.NODE_KINDS.FOLDER)
        .map((ancestor) => ancestor.id),
    );
    if (intent.zone === "inside" && target.kind === templateTree.NODE_KINDS.FOLDER) {
      path.add(target.id);
    }
    return path;
  }

  function scheduleTemplateFolderAutoExpand(intent) {
    const relevantPath = templateIntentFolderPath(intent);
    setTemporaryTemplateExpansions(
      state.templateTreeDrag.temporarilyExpandedFolderIds
        .filter((folderId) => relevantPath.has(folderId)),
    );
    const collapsed = new Set(state.templateTreeUiState.collapsedFolderIds);
    const targetId = intent?.zone === "inside" ? intent.targetNodeId : null;
    if (!targetId || !collapsed.has(targetId)) {
      clearTemplateHoverTimer();
      return;
    }
    if (state.templateTreeDrag.temporarilyExpandedFolderIds.includes(targetId)) {
      clearTemplateHoverTimer();
      return;
    }
    if (state.templateTreeDrag.hoverFolderId === targetId
      && state.templateTreeDrag.hoverTimer !== null) return;
    clearTemplateHoverTimer();
    state.templateTreeDrag.hoverFolderId = targetId;
    state.templateTreeDrag.hoverTimer = setTimeout(function temporarilyExpandFolder() {
      state.templateTreeDrag.hoverTimer = null;
      state.templateTreeDrag.hoverFolderId = null;
      if (!state.templateTreeDrag.draggingNodeId
        || state.templateTreeDrag.intent?.targetNodeId !== targetId
        || state.templateTreeDrag.intent?.zone !== "inside") return;
      setTemporaryTemplateExpansions([
        ...state.templateTreeDrag.temporarilyExpandedFolderIds,
        targetId,
      ]);
    }, TEMPLATE_FOLDER_AUTO_EXPAND_MS);
  }

  async function moveTemplateNode(intent) {
    const nodeId = state.templateTreeDrag.draggingNodeId;
    if (!nodeId || !intent) return;
    const keepExpandedIds = intent.zone === "inside" && intent.targetNodeId
      ? [...new Set([
        ...state.templateTreeDrag.temporarilyExpandedFolderIds,
        intent.targetNodeId,
      ])]
      : [];
    const moved = await saveTemplateMutation({
      type: workspaceContract.MESSAGE_TYPES.TEMPLATE_NODE_MOVE,
      nodeId,
      targetParentId: intent.targetParentId,
      beforeNodeId: intent.beforeNodeId,
    });
    if (!moved) {
      cleanupTemplateTreeDrag();
      renderSection();
      return;
    }
    if (keepExpandedIds.length) {
      const keepExpandedSet = new Set(keepExpandedIds);
      const collapsedFolderIds = state.templateTreeUiState.collapsedFolderIds
        .filter((id) => !keepExpandedSet.has(id));
      const expansionSaved = await saveTemplateMutation({
        type: workspaceContract.MESSAGE_TYPES.TEMPLATE_TREE_UI_UPDATE,
        templateTreeUiState: { collapsedFolderIds },
      });
      if (!expansionSaved) {
        cleanupTemplateTreeDrag();
        state.status = {
          kind: "error",
          text: "Перемещение сохранено, но раскрытие папки сохранить не удалось.",
        };
        renderSection();
        return;
      }
    }
    cleanupTemplateTreeDrag();
    setStatus("success", "Расположение сохранено.");
  }

  function onDragStart(event) {
    closeTemplatePreview();
    setTemplateRootDropZoneVisible(false);
    if (state.sidebarResizing) {
      event.preventDefault();
      return;
    }
    const glossaryHandle = event.target.closest("[data-glossary-drag-id]");
    if (glossaryHandle) {
      if (state.glossarySearch.trim()
        || workspaceUiModule.activeSearchMode(state.glossaryRequestedMode, state.glossarySearch) !== "local") {
        event.preventDefault();
        return;
      }
      state.glossaryDraggingId = glossaryHandle.dataset.glossaryDragId;
      event.dataTransfer.effectAllowed = "move";
      event.dataTransfer.setData("text/plain", state.glossaryDraggingId);
      glossaryHandle.closest(".glossary-card")?.classList.add("is-dragging");
      return;
    }
    const savedHandle = event.target.closest("[data-saved-drag-id]");
    if (savedHandle) {
      if (state.savedSearch.trim()
        || workspaceUiModule.activeSearchMode(state.savedRequestedMode, state.savedSearch) !== "local") {
        event.preventDefault();
        return;
      }
      state.savedDraggingId = savedHandle.dataset.savedDragId;
      event.dataTransfer.effectAllowed = "move";
      event.dataTransfer.setData("text/plain", state.savedDraggingId);
      savedHandle.closest(".saved-card")?.classList.add("is-dragging");
      return;
    }
    const handle = event.target.closest("[data-template-drag-id]");
    if (!handle) return;
    if (editorOpen()) {
      event.preventDefault();
      state.status = { kind: "error", text: "Сохраните или отмените открытый редактор перед перемещением." };
      renderSection();
      return;
    }
    closeRecentPopup();
    state.templateDeleteId = null;
    state.folderDelete = closedFolderDeleteState();
    state.shadow.querySelectorAll(".delete-confirm").forEach((element) => element.remove());
    state.templateTreeDrag.draggingNodeId = handle.dataset.templateDragId;
    state.templateTreeDrag.intent = null;
    state.templateTreeDrag.invalidError = null;
    state.templateTreeDrag.temporarilyExpandedFolderIds = [];
    event.dataTransfer.effectAllowed = "move";
    event.dataTransfer.setData("text/plain", state.templateTreeDrag.draggingNodeId);
    handle.closest(".template-card")?.classList.add("is-dragging");
    setTemplateRootDropZoneVisible(true);
  }

  function onDragEnd(event) {
    event.target.closest(".glossary-card")?.classList.remove("is-dragging");
    state.glossaryDraggingId = null;
    event.target.closest(".saved-card")?.classList.remove("is-dragging");
    state.savedDraggingId = null;
    if (state.templateTreeDrag.draggingNodeId
      || state.templateTreeDrag.temporarilyExpandedFolderIds.length) {
      cleanupTemplateTreeDrag();
      renderSection();
    }
  }

  function onDragOver(event) {
    if (state.glossaryDraggingId && event.target.closest("[data-glossary-id]")) {
      event.preventDefault();
      event.dataTransfer.dropEffect = "move";
      return;
    }
    if (state.savedDraggingId && event.target.closest("[data-saved-id]")) {
      event.preventDefault();
      event.dataTransfer.dropEffect = "move";
      return;
    }
    if (!state.templateTreeDrag.draggingNodeId) return;
    const intent = templateDropIntent(event);
    if (!intent) {
      clearTemplateDragIntent(true);
      return;
    }
    event.preventDefault();
    event.dataTransfer.dropEffect = "move";
    state.templateTreeDrag.intent = intent;
    showTemplateDropIntent(intent);
    scheduleTemplateFolderAutoExpand(intent);
  }

  function onDragLeave(event) {
    if (!state.templateTreeDrag.draggingNodeId) return;
    if (event.relatedTarget && state.shadow.contains(event.relatedTarget)) return;
    clearTemplateDragIntent(true);
  }

  function onDrop(event) {
    const glossaryTarget = event.target.closest("[data-glossary-id]");
    if (glossaryTarget && state.glossaryDraggingId) {
      event.preventDefault();
      const sourceId = state.glossaryDraggingId;
      const cards = Array.from(state.body.querySelectorAll("[data-glossary-id]"));
      const targetIndex = cards.indexOf(glossaryTarget);
      const afterTarget = event.clientY > glossaryTarget.getBoundingClientRect().top + glossaryTarget.getBoundingClientRect().height / 2;
      const beforeEntryId = afterTarget ? (cards[targetIndex + 1]?.dataset.glossaryId || null) : glossaryTarget.dataset.glossaryId;
      state.glossaryDraggingId = null;
      void reorderGlossaryEntries(sourceId, beforeEntryId).catch(handleUiError);
      return;
    }
    const savedTarget = event.target.closest("[data-saved-id]");
    if (savedTarget && state.savedDraggingId) {
      event.preventDefault();
      const sourceId = state.savedDraggingId;
      const cards = Array.from(state.body.querySelectorAll("[data-saved-id]"));
      const targetIndex = cards.indexOf(savedTarget);
      const afterTarget = event.clientY > savedTarget.getBoundingClientRect().top + savedTarget.getBoundingClientRect().height / 2;
      const beforeItemId = afterTarget ? (cards[targetIndex + 1]?.dataset.savedId || null) : savedTarget.dataset.savedId;
      state.savedDraggingId = null;
      void reorderSavedEntries(sourceId, beforeItemId).catch(handleUiError);
      return;
    }
    if (!state.templateTreeDrag.draggingNodeId) return;
    const intent = templateDropIntent(event);
    if (!intent) {
      const errorText = state.templateTreeDrag.invalidError
        ? templateMutationErrorText(state.templateTreeDrag.invalidError)
        : "";
      cleanupTemplateTreeDrag();
      if (errorText) state.status = { kind: "error", text: errorText };
      renderSection();
      return;
    }
    event.preventDefault();
    setTemplateRootDropZoneVisible(false);
    clearTemplateDropIndicators();
    clearTemplateHoverTimer();
    void moveTemplateNode(intent).catch(function handleTemplateMoveError(error) {
      cleanupTemplateTreeDrag();
      renderSection();
      handleUiError(error);
    });
  }

  function mount() {
    state.shellTransitionController?.cancel();
    cleanupTemplateTreeDrag();
    closeInlineGlossary();
    closeTemplatePreview();
    closeRecentPopup();
    closeWorkspaceDelete();
    state.sidebarResizeCleanup?.();
    state.analysisUi?.closeDialog(false);
    document.getElementById(HOST_ID)?.remove();
    const host = document.createElement("div");
    host.id = HOST_ID;
    host.setAttribute("data-chatgpt-templates-overlay", "v1");
    const shadow = host.attachShadow({ mode: "open" });
    shadow.innerHTML = shellMarkup();
    document.documentElement.appendChild(host);

    state.host = host;
    state.shadow = shadow;
    state.shell = shadow.querySelector(".shell");
    state.sidebarFrame = shadow.querySelector(".sidebar-frame");
    state.rail = shadow.querySelector(".rail");
    state.panel = shadow.querySelector(".panel");
    state.sidebarHandle = shadow.querySelector(".panel-resize");
    state.opener = shadow.querySelector(".panel-opener");
    state.recentPopup = shadow.querySelector(".recent-popup");
    state.previewLayer = shadow.querySelector(".template-preview");
    state.previewName = shadow.querySelector(".template-preview-name");
    state.previewIcon = shadow.querySelector(".template-preview-icon");
    state.previewBreadcrumb = shadow.querySelector(".template-preview-breadcrumb");
    state.previewAutoSend = shadow.querySelector(".template-preview-auto");
    state.previewContent = shadow.querySelector(".template-preview-content");
    state.quickAction = shadow.querySelector(".quick-action");
    state.wallpaper = shadow.querySelector(".panel-wallpaper");
    state.title = shadow.querySelector(".panel-title");
    state.body = shadow.querySelector(".panel-body");
    state.shellPhase = "closed";
    state.open = false;
    state.shellMotionReady = false;
    state.shellRestoreFocus = false;
    state.shellTransitionController = workspaceUiModule.createTransformTransitionController({
      duration: SIDEBAR_MOTION_DURATION_MS,
      fallbackPadding: SIDEBAR_MOTION_FALLBACK_PADDING_MS,
      prefersReducedMotion: function prefersReducedMotion() {
        return !state.shellMotionReady
          || window.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches === true;
      },
    });
    if (!state.workspaceClient) {
      state.workspaceClient = workspaceUiModule.createClient({
        getContext: function getWorkspaceContext() { return state.workspaceContext; },
        getStatus: function getWorkspaceStatus() { return state.workspaceStatus; },
        send: function sendWorkspaceMessage(message) { return chrome.runtime.sendMessage(message); },
      });
    }
    state.analysisUi = analysisUiModule.create({
      getShell: function getShell() { return state.shell; },
      getSettings: function getSettings() { return state.settings; },
      onOpenOptions: function openAnalysisOptions() { return state.analysisController?.openOptions(); },
      onReplace: function replaceGlossaryEntry(command) { return state.workspaceClient?.replaceGlossary(command); },
      onGlossaryEntries: function refreshWorkspaceGlossary() { void refreshGlossary().catch(handleUiError); },
      onDialogWidthChange: function persistDialogWidth(width) {
        return saveSettings({
          ...state.settings,
          layout: { ...state.settings.layout, analysisDialogWidth: width },
        }, "Ширина окна анализа сохранена.");
      },
    });
    state.sidebarResizeCleanup = installSidebarResizer(state.sidebarHandle);

    shadow.addEventListener("click", function handleClick(event) { void onShadowClick(event).catch(handleUiError); });
    shadow.addEventListener("change", function handleChange(event) { void onShadowChange(event).catch(handleUiError); });
    shadow.addEventListener("input", onShadowInput);
    shadow.addEventListener("pointerover", onShadowPointerOver);
    shadow.addEventListener("pointerout", onShadowPointerOut);
    shadow.addEventListener("focusin", onShadowFocusIn);
    shadow.addEventListener("focusout", onShadowFocusOut);
    shadow.addEventListener("dragstart", onDragStart);
    shadow.addEventListener("dragend", onDragEnd);
    shadow.addEventListener("dragover", onDragOver);
    shadow.addEventListener("dragleave", onDragLeave);
    shadow.addEventListener("drop", onDrop);
    state.opener.addEventListener("pointerenter", onOpenerPointerEnter);
    state.opener.addEventListener("pointerleave", onOpenerPointerLeave);
    state.recentPopup.addEventListener("pointerenter", onRecentPopupPointerEnter);
    state.recentPopup.addEventListener("pointerleave", onRecentPopupPointerLeave);
    state.previewLayer.addEventListener("pointerenter", onPreviewPointerEnter);
    state.previewLayer.addEventListener("pointerleave", onPreviewPointerLeave);
    state.body.addEventListener("scroll", closeTemplatePreview, { passive: true });
    renderSection();
    enableShellMotionAfterMount();
  }

  function ensureMounted() {
    if (state.pageUrl !== location.href) {
      state.pageUrl = location.href;
      state.translationController?.cancel();
      closeInlineGlossary();
    }
    if (state.inlineGlossary.phase !== "closed"
      && !state.inlineGlossary.snapshot?.anchorNode?.isConnected) {
      closeInlineGlossary();
    }
    if (!state.host?.isConnected) mount();
  }

  async function loadStorage() {
    try {
      const stored = await chrome.storage.local.get([
        "templates",
        "settings",
        "recentTemplateIds",
        "templateTreeUiState",
      ]);
      state.recentTemplateIds = Array.isArray(stored.recentTemplateIds)
        ? stored.recentTemplateIds
        : [];
      applyStoredTemplateTree(stored.templates, stored.templateTreeUiState);
      state.settings = normalizeSettings(stored.settings);
      state.sidebarPreferredWidth = state.settings.layout.sidebarWidth;
      state.recentTemplateIds = normalizeRecentTemplateIds(stored.recentTemplateIds);
      renderSection();
      await refreshKeyStatus();
      await state.contextClient?.sync(location.href);
    } catch (error) {
      setStatus("error", error?.message || "Не удалось загрузить данные расширения.");
    }
  }

  document.addEventListener("keydown", function handleEscape(event) {
    if (event.key !== "Escape") return;
    if (state.analysisUi?.handleEscape()) {
      event.preventDefault();
      event.stopPropagation();
      return;
    }
    if (state.analysisUi?.handleInlineEscape()) {
      event.preventDefault();
      event.stopPropagation();
      return;
    }
    if (closeWorkspaceDeleteAndRender(true)) {
      event.preventDefault();
      event.stopPropagation();
      return;
    }
    if (closeTemplatePreview()) {
      event.preventDefault();
      event.stopPropagation();
      return;
    }
    if (state.recentPopup && !state.recentPopup.hidden) {
      closeRecentPopup();
      event.preventDefault();
      event.stopPropagation();
      return;
    }
    if (state.shellPhase !== "open") return;
    if (state.folderDelete.phase === "confirm-subtree") {
      state.folderDelete = { ...state.folderDelete, phase: "choice" };
      renderSection();
    } else if (state.templateDeleteId !== null || state.folderDelete.nodeId !== null) {
      dismissTemplateNodeDeleteAndRender();
    } else if (state.editing) {
      dismissTemplateEditorAndRender();
    } else {
      closePanel(true);
    }
    event.preventDefault();
    event.stopPropagation();
  });

  document.addEventListener("pointerdown", function handleOutsidePointer(event) {
    const path = event.composedPath();
    handleInlinePointerDown(event, path);
    if (state.sidebarResizing) return;
    if (workspaceUiModule.workspaceDeleteMenuOpen(state.workspaceDelete)) {
      const insideActiveCard = workspaceUiModule.workspaceDeletePointerInside(state.workspaceDelete, path);
      if (!insideActiveCard && closeWorkspaceDelete()) {
        setTimeout(function renderAfterOutsidePointer() {
          if (state.body) renderSection();
        }, 0);
      }
    }
    if (state.host && !path.includes(state.host)) {
      if (state.open && state.settings.closePanelOnOutsideClick) closePanel();
      else closeRecentPopup();
    }
  }, { capture: true });
  document.addEventListener("focusin", handleInlineFocusIn, { capture: true });
  document.addEventListener("copy", handleInlineCopy, { capture: true });
  document.addEventListener("cut", handleInlineExternalAction, { capture: true });
  document.addEventListener("paste", handleInlineExternalAction, { capture: true });
  document.addEventListener("beforeinput", handleInlineExternalAction, { capture: true });
  document.addEventListener("selectionchange", markInlineGestureSelectionChanged);
  document.addEventListener("pointerup", handleInlinePointerUp, { capture: true });
  document.addEventListener("pointercancel", cancelInlinePointerGesture, { capture: true });
  document.addEventListener("lostpointercapture", cancelInlinePointerGesture, { capture: true });
  document.addEventListener("keydown", handleInlineKeyDown, { capture: true });
  document.addEventListener("keyup", handleInlineKeyUp, { capture: true });
  document.addEventListener("scroll", function handlePageScroll(event) {
    const path = typeof event.composedPath === "function" ? event.composedPath() : [];
    closeInlineGlossaryOutsidePath(path);
  }, { capture: true, passive: true });

  window.addEventListener("focus", function handleWindowFocus() {
    void refreshKeyStatus();
    if (state.workspaceStatus.status === "unavailable") void state.contextClient?.retry();
  });
  window.addEventListener("blur", function handleWindowBlur() {
    closeInlineGlossary();
  });
  document.addEventListener("visibilitychange", function handleVisibilityChange() {
    refreshKeyStatusWhenVisible();
    retryWorkspaceWhenVisible();
    if (document.visibilityState !== "visible") closeInlineGlossary();
  });
  window.addEventListener("resize", function handleWindowResize() {
    closeInlineGlossary();
    closeTemplatePreview();
    applyShellState();
  });

  chrome.runtime.onMessage.addListener(function handleRuntimeMessage(message, _sender, sendResponse) {
    if (message?.type === TOGGLE_MESSAGE) {
      closeInlineGlossary();
      ensureMounted();
      togglePanel();
      sendResponse({ ok: true, open: state.shellPhase === "opening" || state.shellPhase === "open" });
      return false;
    }
    if (message?.type === commandRegistry.CONTENT_MESSAGE_TYPES.ANALYZE
      || message?.type === contract.MESSAGE_TYPES.CONTEXT_MENU_SELECTION) {
      const trigger = message.type === commandRegistry.CONTENT_MESSAGE_TYPES.ANALYZE ? "browser-command" : "context-menu";
      const selectionText = trigger === "context-menu" ? String(message.selectionText || "") : String(window.getSelection?.().toString() || "");
      const eligible = commandRegistry.selectionEligible({
        supportedPage: conversationContextModule.isSupportedPage(location.href),
        selectionText,
        isEditable: commandRegistry.isTextEntryTarget(document.activeElement),
      });
      if (!eligible) {
        state.analysisUi?.showHint("Выделите текст вне поля ввода ChatGPT.");
        sendResponse({ ok: false });
        return false;
      }
      void runAnalysis(trigger, selectionText, message.pageUrl || location.href)
        .then((response) => sendResponse(response || { ok: false }))
        .catch(() => sendResponse({ ok: false }));
      return true;
    }
    if (message?.type === commandRegistry.CONTENT_MESSAGE_TYPES.TRANSLATE) {
      const trigger = message.trigger === "context-menu" ? "context-menu" : "browser-command";
      const currentSelection = readSelectedTextSnapshot(String(window.getSelection?.().toString() || ""));
      const currentValidation = contract.validateSelection(currentSelection);
      const selectionText = trigger === "context-menu" && !currentValidation.ok
        ? readSelectedTextSnapshot(String(message.selectionText || ""))
        : currentSelection;
      const eligible = commandRegistry.selectionEligible({
        supportedPage: conversationContextModule.isSupportedPage(location.href),
        selectionText,
        isEditable: commandRegistry.isTextEntryTarget(document.activeElement),
      });
      if (!eligible) {
        state.analysisUi?.showHint("Выделите текст вне поля ввода ChatGPT.");
        sendResponse({ ok: false });
        return false;
      }
      void runTranslation(trigger, selectionText, message.pageUrl || location.href)
        .then((response) => sendResponse(response || { ok: false }))
        .catch(() => sendResponse({ ok: false }));
      return true;
    }
    if (message?.type === commandRegistry.CONTENT_MESSAGE_TYPES.SAVE
      || message?.type === workspaceContract.MESSAGE_TYPES.CONTEXT_MENU_SAVE_SELECTION) {
      const trigger = message.type === commandRegistry.CONTENT_MESSAGE_TYPES.SAVE ? "browser-command" : "context-menu";
      const selectionText = trigger === "context-menu" ? String(message.selectionText || "") : String(window.getSelection?.().toString() || "");
      const eligible = commandRegistry.selectionEligible({
        supportedPage: conversationContextModule.isSupportedPage(location.href),
        selectionText,
        isEditable: commandRegistry.isTextEntryTarget(document.activeElement),
      });
      if (!eligible) {
        state.analysisUi?.showHint("Выделите текст вне поля ввода ChatGPT.");
        sendResponse({ ok: false });
        return false;
      }
      void runSaveSelection(trigger, selectionText, message.pageUrl || location.href)
        .then((response) => sendResponse(response || { ok: false }))
        .catch((error) => sendResponse({ ok: false, error: { message: error?.message || "Не удалось сохранить текст." } }));
      return true;
    }
    if (message?.type === commandRegistry.CONTENT_MESSAGE_TYPES.NORMALIZE
      || message?.type === workspaceContract.MESSAGE_TYPES.CONTEXT_MENU_NORMALIZE_COMPOSER) {
      const trigger = message.type === commandRegistry.CONTENT_MESSAGE_TYPES.NORMALIZE ? "browser-command" : "context-menu";
      const result = runNormalizeComposer(trigger);
      sendResponse(result);
      return false;
    }
    if (message?.type === workspaceContract.MESSAGE_TYPES.CHANGED) {
      if (!workspaceContract.validateInvalidation({
        entityFamily: message.entityFamily,
        conversationScope: message.conversationScope,
        revision: message.revision,
      })) return false;
      closeInlineGlossaryForInvalidation(message.entityFamily);
      const deletionClosed = closeWorkspaceDelete();
      if (message.entityFamily === workspaceContract.ENTITY_FAMILIES.ALL) {
        state.glossaryEntries = [];
        state.savedEntries = [];
        if (state.open && ["analysis", "saved"].includes(state.activeSection)) renderSection();
        void state.contextClient?.sync(location.href).then(() => {
          if (!state.open) return;
          if (state.activeSection === "analysis") return refreshGlossary();
          if (state.activeSection === "saved") return refreshSaved();
          return null;
        }).catch(handleUiError);
        return false;
      }
      if (deletionClosed && state.open && ["analysis", "saved"].includes(state.activeSection)) renderSection();
      const currentScope = state.workspaceContext?.scopeKey;
      const relevantScope = message.conversationScope === null || message.conversationScope === currentScope;
      if (message.entityFamily === workspaceContract.ENTITY_FAMILIES.GLOSSARY
        && (relevantScope
          || workspaceUiModule.activeSearchMode(state.glossaryRequestedMode, state.glossarySearch) === "global")) {
        void refreshGlossary().catch(handleUiError);
      }
      if (message.entityFamily === workspaceContract.ENTITY_FAMILIES.SAVED
        && (relevantScope
          || workspaceUiModule.activeSearchMode(state.savedRequestedMode, state.savedSearch) === "global")) {
        void refreshSaved().catch(handleUiError);
      }
      if (message.entityFamily === workspaceContract.ENTITY_FAMILIES.CONVERSATIONS) {
        void state.contextClient?.sync(location.href).catch(handleUiError);
      }
      return false;
    }
    return false;
  });

  chrome.storage.onChanged.addListener(function handleStorageChange(changes, areaName) {
    if (areaName !== "local") return;
    closeTemplatePreview();
    cleanupTemplateTreeDrag();
    if (changes.templates) {
      applyStoredTemplateTree(
        changes.templates.newValue,
        changes.templateTreeUiState?.newValue ?? state.templateTreeUiState,
      );
    } else if (changes.templateTreeUiState) {
      state.templateTreeUiState = templateTree.normalizeTreeUiState(
        changes.templateTreeUiState.newValue,
        state.templates,
      );
    }
    if (changes.settings) {
      state.settings = normalizeSettings(changes.settings.newValue);
      if (!state.sidebarWidthCommitPending && !state.sidebarResizing) {
        state.sidebarPreferredWidth = state.settings.layout.sidebarWidth;
      }
    }
    if (changes.recentTemplateIds) {
      state.recentTemplateIds = normalizeRecentTemplateIds(changes.recentTemplateIds.newValue);
    }
    closeRecentPopup();
    renderSection();
  });

  const mountObserver = new MutationObserver(ensureMounted);
  mountObserver.observe(document.documentElement, { childList: true, subtree: true });

  window[GLOBAL_KEY] = { ensureMounted: ensureMounted };
  ensureMounted();
  state.analysisController = analysisControllerModule.create({
    onHint: function showAnalysisHint(text) { state.analysisUi?.showHint(text); },
    onLoading: function showAnalysisLoading() { state.analysisUi?.showLoading(); },
    onLoadingEnd: function hideAnalysisLoading() { state.analysisUi?.hideLoading(); },
    onBusyChange: function setAnalysisBusy(value) {
      state.analysisBusy = value;
      if (aiOperationBusy()) closeInlineGlossary();
    },
    onKeyStatusChanged: updateKeyStatus,
    onError: function showAnalysisError(error) {
      if (["API_KEY_MISSING", "API_KEY_INVALID"].includes(error?.code)) state.keyConfigured = false;
      state.analysisUi?.showError(error);
    },
    onResult: function showAnalysisResult(response) {
      void refreshGlossary().catch(handleUiError);
      state.analysisUi?.showResult(response);
    },
  });
  state.translationController = translationControllerModule.create({
    onHint: function showTranslationHint(text) { state.analysisUi?.showHint(text); },
    onLoading: function showTranslationLoading() { state.analysisUi?.showTranslationLoading(); },
    onLoadingEnd: function hideTranslationLoading() { state.analysisUi?.hideLoading(); },
    onBusyChange: function setTranslationBusy(value) {
      state.translationBusy = value;
      if (aiOperationBusy()) closeInlineGlossary();
    },
    onError: function showTranslationError(error) {
      if (["API_KEY_MISSING", "API_KEY_INVALID"].includes(error?.code)) state.keyConfigured = false;
      state.analysisUi?.showTranslationError(error);
    },
    onResult: function showTranslationResult(response) {
      state.analysisUi?.showTranslationResult(response.translatedText);
    },
  });
  state.contextClient = conversationContextModule.createClient({
    send: function sendContextMessage(message) { return chrome.runtime.sendMessage(message); },
    onChange: handleWorkspaceContextChange,
    onStatusChange: handleWorkspaceStatusChange,
  });
  state.contextClient.start();
  void loadStorage();
})();
