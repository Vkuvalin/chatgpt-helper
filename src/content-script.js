(function initChatGptHelperOverlay() {
  "use strict";

  const contract = globalThis.ChatGPTHelperAnalysisContract;
  const workspaceContract = globalThis.ChatGPTHelperWorkspaceContract;
  const conversationContextModule = globalThis.ChatGPTHelperConversationContext;
  const commandRegistry = globalThis.ChatGPTHelperCommandRegistry;
  const analysisControllerModule = globalThis.ChatGPTHelperAnalysisController;
  const analysisUiModule = globalThis.ChatGPTHelperAnalysisUi;
  const workspaceUiModule = globalThis.ChatGPTHelperWorkspaceUi;
  const chatGptDom = globalThis.ChatGPTTemplateDom;
  const GLOBAL_KEY = "__chatgptHelperOverlayV1__";
  const HOST_ID = "chatgpt-helper-overlay-root";
  const TOGGLE_MESSAGE = contract.MESSAGE_TYPES.TOGGLE_PANEL;
  const RECENT_HOVER_DELAY_MS = 500;
  const RECENT_CLOSE_DELAY_MS = 120;
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
    templates: [],
    settings: workspaceContract.normalizeActiveSettings(),
    recentTemplateIds: [],
    editing: null,
    editorError: "",
    deleteMode: false,
    confirmingDeleteId: null,
    draggingId: null,
    busyTemplateId: null,
    quickBusy: false,
    status: { kind: "", text: "" },
    glossaryEntries: [],
    glossaryRequestedMode: "local",
    glossarySearch: "",
    glossaryDeleteMode: false,
    glossaryConfirmDeleteId: null,
    glossaryDraggingId: null,
    savedEntries: [],
    savedRequestedMode: "local",
    savedSearch: "",
    savedConfirmDeleteId: null,
    savedDraggingId: null,
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
    analysisBusy: false,
    analysisController: null,
    analysisUi: null,
    host: null,
    shadow: null,
    shell: null,
    rail: null,
    panel: null,
    sidebarHandle: null,
    opener: null,
    recentPopup: null,
    recentHoverTimer: null,
    recentCloseTimer: null,
    quickAction: null,
    wallpaper: null,
    title: null,
    body: null,
  };

  function createStableId() {
    if (typeof crypto?.randomUUID === "function") return crypto.randomUUID();
    return "template-" + Date.now() + "-" + Math.random().toString(36).slice(2);
  }

  function normalizeTemplates(value) {
    if (!Array.isArray(value)) return [];
    const usedIds = new Set();
    return value.flatMap(function normalizeTemplate(template) {
      if (!template || typeof template !== "object") return [];
      const name = typeof template.name === "string" ? template.name : "";
      const content = typeof template.content === "string" ? template.content : "";
      if (!name.trim() || !content.trim()) return [];

      let id = typeof template.id === "string" && template.id.trim() ? template.id : createStableId();
      if (usedIds.has(id)) id = createStableId();
      usedIds.add(id);
      return [{
        ...template,
        id: id,
        name: name,
        content: content,
        autoSend: template.autoSend === true,
      }];
    });
  }

  function normalizeSettings(value) {
    return workspaceContract.normalizeActiveSettings(value);
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

  function escapeHtml(value) {
    return String(value)
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#039;");
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

  function handleUiError(error) {
    console.warn("ChatGPT Templates UI action failed.", error);
    setStatus("error", error?.message || "Не удалось выполнить действие.");
  }

  function styles() {
    return [
      ":host {",
      "  --sidebar-effective-width: 360px;",
      "  --rail-width: 48px;",
      "  all: initial;",
      "  position: fixed;",
      "  inset: 0 0 auto auto;",
      "  z-index: 2147483646;",
      "  color-scheme: light dark;",
      "  pointer-events: none;",
      "}",
      "* { box-sizing: border-box; }",
      "button, input, textarea { font: inherit; }",
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
      "  display: flex;",
      "  width: var(--sidebar-effective-width);",
      "  min-width: 0;",
      "  font: 13px/1.45 system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;",
      "  color: var(--text);",
      "  pointer-events: none;",
      "}",
      ".shell.is-open { box-shadow: var(--shadow); }",
      ".shell.is-resizing, .shell.is-resizing .rail, .shell.is-resizing .panel { transition: none !important; }",
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
      "  pointer-events: auto;",
      "}",
      ".icon-button, .rail-button, .compact-button, .quick-action, .panel-opener {",
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
      ".rail-button:hover, .icon-button:hover, .compact-button:hover { background: var(--surface-hover); color: var(--text); }",
      ".rail-button.is-active { border-color: color-mix(in srgb, var(--accent) 60%, var(--border)); background: color-mix(in srgb, var(--accent) 15%, var(--surface)); color: var(--accent); }",
      "button:focus-visible, input:focus-visible, textarea:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }",
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
      "  pointer-events: auto;",
      "}",
      ".panel-resize { position: absolute; top: 0; bottom: 0; left: 0; z-index: 5; width: 10px; cursor: ew-resize; touch-action: none; outline: 0; pointer-events: auto; }",
      ".panel-resize::after { content: ''; position: absolute; top: 0; bottom: 0; left: 0; width: 1px; background: transparent; transition: background 120ms ease; }",
      ".panel-resize:hover::after, .panel-resize:focus-visible::after, .panel-resize.is-resizing::after { background: var(--accent); }",
      ".panel-wallpaper, .panel-scrim { position: absolute; inset: 0; pointer-events: none; }",
      ".panel-wallpaper { background-position: center; background-size: cover; opacity: .58; }",
      ".panel-scrim { background: color-mix(in srgb, var(--bg) 90%, transparent); }",
      ".has-wallpaper .panel-scrim { background: color-mix(in srgb, var(--bg) 76%, transparent); backdrop-filter: blur(1px); }",
      ".panel-content { position: relative; z-index: 1; display: grid; height: 100%; grid-template-rows: auto minmax(0, 1fr); }",
      ".panel-header { display: flex; min-height: 58px; padding: 16px 18px 12px; align-items: center; border-bottom: 1px solid var(--border); }",
      ".panel-title { margin: 0; font-size: 17px; font-weight: 680; letter-spacing: -.01em; }",
      ".panel-body { min-height: 0; overflow: auto; padding: 16px; }",
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
      "  pointer-events: auto;",
      "  transition: background 120ms ease, opacity 120ms ease;",
      "}",
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
      "  pointer-events: auto;",
      "}",
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
      "  display: block;",
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
      "  text-overflow: ellipsis;",
      "  white-space: nowrap;",
      "}",
      ".recent-template-button:hover { background: var(--surface-hover); }",
      "@keyframes recent-popup-in { from { opacity: 0; transform: translateX(4px); } }",
      ".section-toolbar { display: flex; margin-bottom: 14px; align-items: center; justify-content: space-between; gap: 10px; }",
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
      ".templates-list { display: grid; gap: 9px; }",
      ".template-card { overflow: hidden; border: 1px solid var(--border); border-radius: 10px; background: color-mix(in srgb, var(--surface) 94%, transparent); }",
      ".template-card.is-dragging { opacity: .5; }",
      ".template-summary { display: grid; min-height: 48px; padding: 6px 7px; grid-template-columns: auto minmax(0, 1fr) auto; align-items: center; gap: 7px; }",
      ".drag-handle { display: grid; width: 25px; height: 34px; place-items: center; color: var(--muted); cursor: grab; border-radius: 6px; }",
      ".drag-handle:active { cursor: grabbing; }",
      ".drag-handle svg { width: 16px; height: 16px; stroke-width: 3; }",
      ".template-name { overflow: hidden; font-weight: 620; text-overflow: ellipsis; white-space: nowrap; }",
      ".template-controls { display: flex; align-items: center; gap: 4px; }",
      ".icon-button { width: 31px; height: 31px; color: var(--muted); }",
      ".icon-button svg { width: 16px; height: 16px; }",
      ".icon-button.run { color: var(--accent); }",
      ".icon-button.expanded svg { transform: rotate(180deg); }",
      ".auto-send { display: inline-flex; min-height: 31px; padding: 0 3px; align-items: center; gap: 4px; color: var(--muted); cursor: pointer; }",
      ".auto-send input { width: 15px; height: 15px; margin: 0; accent-color: var(--accent); }",
      ".auto-send span { font-size: 11px; }",
      ".editor { display: grid; padding: 12px; gap: 10px; border-top: 1px solid var(--border); background: color-mix(in srgb, var(--bg) 74%, transparent); }",
      ".new-editor { margin-bottom: 12px; overflow: hidden; border: 1px solid var(--border); border-radius: 10px; }",
      ".field { display: grid; gap: 5px; }",
      ".field > span { color: var(--muted); font-size: 12px; font-weight: 600; }",
      ".input { width: 100%; border: 1px solid var(--border); border-radius: 7px; background: var(--surface); color: var(--text); }",
      "input.input { min-height: 36px; padding: 7px 9px; }",
      "textarea.input { min-height: 112px; padding: 8px 9px; resize: vertical; line-height: 1.45; }",
      ".editor-actions, .confirm-actions { display: flex; justify-content: flex-end; gap: 8px; }",
      ".inline-error, .status { min-height: 18px; margin: 0; font-size: 12px; overflow-wrap: anywhere; }",
      ".inline-error, .status.error { color: var(--danger); }",
      ".status.success { color: var(--accent); }",
      ".status { margin-top: 12px; color: var(--muted); }",
      ".delete-confirm { display: flex; padding: 8px 10px 11px; align-items: center; justify-content: space-between; gap: 10px; border-top: 1px solid var(--border); color: var(--muted); }",
      ".delete-confirm .button { min-height: 29px; padding: 4px 9px; }",
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
      ".file-input { width: 100%; color: var(--muted); }",
      ".file-input::file-selector-button { margin-right: 9px; padding: 7px 10px; border: 1px solid var(--border); border-radius: 7px; background: var(--surface); color: var(--text); cursor: pointer; }",
      "@media (prefers-color-scheme: dark) {",
      "  .theme-system { --bg: #17191d; --surface: #22262d; --surface-hover: #2c323b; --text: #edf1f7; --muted: #aab2bf; --border: #3c434e; --accent: #66cfc0; --accent-contrast: #101514; --danger: #ff938c; }",
      "}",
      "@media (prefers-reduced-motion: reduce) { .quick-action { transition: none; } .recent-popup { animation: none; } }",
      analysisUiModule.styles(),
      workspaceUiModule.styles(),
    ].join("\n");
  }

  function shellMarkup() {
    return [
      '<style>' + styles() + '</style>',
      '<div class="shell theme-system">',
      '  <button class="quick-action" type="button" data-action="quick-next" title="Отправить «Далее», если поле пусто" aria-label="Отправить «Далее», если поле пусто">' + ICONS.quick + '</button>',
      '  <button class="panel-opener" type="button" data-action="open-panel" title="Открыть меню шаблонов" aria-label="Открыть меню шаблонов" aria-haspopup="menu" aria-expanded="false">' + ICONS.opener + '</button>',
      '  <div class="recent-popup" role="menu" aria-label="Последние запущенные шаблоны" hidden></div>',
      '  <div class="panel-resize" role="separator" aria-label="Изменить ширину панели" aria-orientation="vertical" aria-valuemin="320" aria-valuemax="720" aria-valuenow="360" tabindex="0" hidden></div>',
      '  <nav class="rail" aria-label="Разделы chatgpt-helper" hidden>',
      '    <button class="rail-button" type="button" data-section="templates" title="Шаблоны" aria-label="Шаблоны">' + ICONS.templates + '</button>',
      '    <button class="rail-button" type="button" data-section="analysis" title="Анализ текста" aria-label="Анализ текста">' + ICONS.analysis + '</button>',
      '    <button class="rail-button" type="button" data-section="saved" title="Сохранённое" aria-label="Сохранённое">' + ICONS.saved + '</button>',
      '    <button class="rail-button" type="button" data-section="settings" title="Настройки" aria-label="Настройки">' + ICONS.settings + '</button>',
      '  </nav>',
      '  <section class="panel" aria-label="chatgpt-helper" hidden>',
      '    <div class="panel-wallpaper" aria-hidden="true"></div>',
      '    <div class="panel-scrim" aria-hidden="true"></div>',
      '    <div class="panel-content">',
      '      <header class="panel-header"><h2 class="panel-title"></h2></header>',
      '      <main class="panel-body"></main>',
      '    </div>',
      '  </section>',
      '</div>',
    ].join("");
  }

  function applyShellState() {
    if (!state.shell) return;
    const effectiveSidebarWidth = workspaceContract.effectiveWidth(
      "sidebarWidth",
      state.settings.layout.sidebarWidth,
      window.innerWidth,
    );
    state.host?.style.setProperty("--sidebar-effective-width", `${effectiveSidebarWidth}px`);
    if (state.sidebarHandle) {
      state.sidebarHandle.setAttribute("aria-valuenow", String(effectiveSidebarWidth));
    }
    state.shell.className = "shell theme-" + state.settings.theme
      + (state.open ? " is-open" : "")
      + (state.sidebarResizing ? " is-resizing" : "")
      + (state.settings.wallpaperDataUrl ? " has-wallpaper" : "");
    state.panel.hidden = !state.open;
    state.rail.hidden = !state.open;
    state.sidebarHandle.hidden = !state.open;
    state.opener.hidden = state.open;
    state.quickAction.hidden = state.open;
    state.title.textContent = SECTION_TITLES[state.activeSection];

    state.shadow.querySelectorAll("[data-section]").forEach(function updateNavigation(button) {
      const active = button.dataset.section === state.activeSection;
      button.classList.toggle("is-active", active);
      button.setAttribute("aria-current", active ? "page" : "false");
      button.setAttribute("aria-expanded", active && state.open ? "true" : "false");
    });

    state.wallpaper.style.backgroundImage = state.settings.wallpaperDataUrl
      ? "url(" + JSON.stringify(state.settings.wallpaperDataUrl) + ")"
      : "";
  }

  function setSidebarWidthPreview(preferredWidth) {
    const effective = workspaceContract.effectiveWidth("sidebarWidth", preferredWidth, window.innerWidth);
    state.host?.style.setProperty("--sidebar-effective-width", `${effective}px`);
    state.sidebarHandle?.setAttribute("aria-valuenow", String(effective));
    return effective;
  }

  async function persistSidebarWidth(preferredWidth) {
    const width = workspaceContract.clampPreferredWidth("sidebarWidth", preferredWidth);
    if (width === state.settings.layout.sidebarWidth) {
      setSidebarWidthPreview(width);
      return true;
    }
    return saveSettings({
      ...state.settings,
      layout: { ...state.settings.layout, sidebarWidth: width },
    }, "Ширина панели сохранена.");
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
      if (event.button !== 0 || drag) return;
      event.preventDefault();
      previousUserSelect = document.documentElement.style.userSelect;
      document.documentElement.style.userSelect = "none";
      drag = {
        pointerId: event.pointerId,
        startX: event.clientX,
        startWidth: state.settings.layout.sidebarWidth,
        width: state.settings.layout.sidebarWidth,
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
      event.preventDefault();
      void persistSidebarWidth(workspaceContract.LAYOUT.sidebarWidth.default);
    });
    handle.addEventListener("keydown", (event) => {
      const current = state.settings.layout.sidebarWidth;
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
    state.opener?.setAttribute("aria-expanded", "false");
  }

  function getAvailableRecentTemplates() {
    const templatesById = new Map(state.templates.map(function mapTemplate(template) {
      return [template.id, template];
    }));
    return state.recentTemplateIds.flatMap(function resolveTemplate(id) {
      const template = templatesById.get(id);
      return template ? [template] : [];
    });
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
      return '<button class="recent-template-button" type="button" role="menuitem" data-action="run-recent-template" data-id="' + escapeHtml(template.id) + '" title="' + escapeHtml(template.name) + '" aria-label="Запустить шаблон: ' + escapeHtml(template.name) + '">' + escapeHtml(template.name) + '</button>';
    }).join("");
    state.recentPopup.hidden = false;
    state.opener?.setAttribute("aria-expanded", "true");
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

  function onRecentPopupPointerLeave() {
    scheduleRecentPopupClose();
  }

  function statusMarkup() {
    if (!state.status.text) return '<p class="status" role="status" aria-live="polite"></p>';
    return '<p class="status ' + escapeHtml(state.status.kind) + '" role="status" aria-live="polite">' + escapeHtml(state.status.text) + '</p>';
  }

  function editorMarkup(editor, extraClass) {
    return [
      '<div class="editor ' + (extraClass || "") + '" data-editor data-editor-id="' + escapeHtml(editor.id || "") + '">',
      '  <label class="field"><span>Название</span><input class="input" type="text" data-field="name" value="' + escapeHtml(editor.name) + '" maxlength="120"></label>',
      '  <label class="field"><span>Текст шаблона</span><textarea class="input" data-field="content">' + escapeHtml(editor.content) + '</textarea></label>',
      state.editorError ? '  <p class="inline-error" role="alert">' + escapeHtml(state.editorError) + '</p>' : "",
      '  <div class="editor-actions">',
      '    <button class="button" type="button" data-action="cancel-edit">Отмена</button>',
      '    <button class="button primary" type="button" data-action="save-edit">Сохранить</button>',
      '  </div>',
      '</div>',
    ].join("");
  }

  function templateCardMarkup(template) {
    const editing = state.editing?.id === template.id;
    const confirming = state.confirmingDeleteId === template.id;
    const busy = state.busyTemplateId === template.id;
    return [
      '<article class="template-card" data-template-id="' + escapeHtml(template.id) + '">',
      '  <div class="template-summary">',
      '    <span class="drag-handle" draggable="true" data-drag-id="' + escapeHtml(template.id) + '" title="Перетащить шаблон" aria-label="Перетащить шаблон" tabindex="0">' + ICONS.drag + '</span>',
      '    <span class="template-name" title="' + escapeHtml(template.name) + '">' + escapeHtml(template.name) + '</span>',
      '    <div class="template-controls">',
      '      <button class="icon-button run" type="button" data-action="run-template" data-id="' + escapeHtml(template.id) + '" title="Запустить шаблон" aria-label="Запустить шаблон"' + (busy ? " disabled" : "") + '>' + ICONS.play + '</button>',
      '      <button class="icon-button' + (editing ? " expanded" : "") + '" type="button" data-action="edit-template" data-id="' + escapeHtml(template.id) + '" title="Развернуть или свернуть редактор" aria-label="Развернуть или свернуть редактор" aria-expanded="' + (editing ? "true" : "false") + '">' + ICONS.chevron + '</button>',
      '      <label class="auto-send" title="После вставки сразу отправить"><input type="checkbox" data-action="auto-send" data-id="' + escapeHtml(template.id) + '"' + (template.autoSend ? " checked" : "") + '><span>Авто</span></label>',
      state.deleteMode ? '      <button class="icon-button text-danger" type="button" data-action="ask-delete" data-id="' + escapeHtml(template.id) + '" title="Удалить шаблон" aria-label="Удалить шаблон">' + ICONS.trash + '</button>' : "",
      '    </div>',
      '  </div>',
      editing ? editorMarkup(state.editing, "") : "",
      confirming ? [
        '  <div class="delete-confirm">',
        '    <span>Удалить шаблон?</span>',
        '    <div class="confirm-actions">',
        '      <button class="button" type="button" data-action="cancel-delete">Нет</button>',
        '      <button class="button danger" type="button" data-action="confirm-delete" data-id="' + escapeHtml(template.id) + '">Да</button>',
        '    </div>',
        '  </div>',
      ].join("") : "",
      '</article>',
    ].join("");
  }

  function templatesMarkup() {
    const rows = state.templates.map(templateCardMarkup).join("");
    return [
      '<div class="section-toolbar">',
      '  <button class="button primary" type="button" data-action="add-template">' + ICONS.plus + '<span>Добавить шаблон</span></button>',
      '  <button class="compact-button' + (state.deleteMode ? " is-active" : "") + '" type="button" data-action="toggle-delete-mode" title="Режим удаления" aria-label="Режим удаления" aria-pressed="' + (state.deleteMode ? "true" : "false") + '">' + ICONS.trash + '</button>',
      '</div>',
      state.editing?.id === null ? editorMarkup(state.editing, "new-editor") : "",
      rows ? '<div class="templates-list">' + rows + '</div>' : '<p class="empty-state">Добавьте первый шаблон, чтобы вставлять его в ChatGPT.</p>',
      statusMarkup(),
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
      '</section>',
      '<section class="settings-group">',
      '  <h3>Горячие клавиши</h3>',
      '  <p class="settings-help">Сочетания назначаются на странице горячих клавиш расширений браузера.</p>',
      '  <ul class="command-list"><li>Активировать расширение</li><li>Анализировать выделенный текст</li><li>Сохранить выделенный текст</li><li>Нормализовать пустые строки</li></ul>',
      '</section>',
      '<section class="settings-group">',
      '  <h3>Резервное копирование</h3>',
      '  <button class="button" type="button" data-action="open-backup-options">Открыть резервное копирование</button>',
      '</section>',
      statusMarkup(),
    ].join("");
  }

  function renderSection() {
    if (!state.body) return;
    applyShellState();
    if (state.activeSection === "templates") state.body.innerHTML = templatesMarkup();
    else if (state.activeSection === "analysis") state.body.innerHTML = analysisMarkup();
    else if (state.activeSection === "saved") state.body.innerHTML = savedMarkup();
    else state.body.innerHTML = settingsMarkup();
  }

  function openSection(section) {
    if (!SECTION_TITLES[section]) return;
    closeRecentPopup();
    state.activeSection = section;
    state.open = true;
    clearStatus();
    renderSection();
    if (section === "analysis" || section === "settings") void refreshKeyStatus();
    if (section === "analysis") void refreshGlossary().catch(handleUiError);
    if (section === "saved") void refreshSaved().catch(handleUiError);
  }

  function closePanel() {
    closeRecentPopup();
    if (!state.open) return;
    state.open = false;
    applyShellState();
  }

  function togglePanel() {
    closeRecentPopup();
    state.open = !state.open;
    applyShellState();
    if (state.open) renderSection();
  }

  async function saveTemplateMutation(message) {
    try {
      const response = await chrome.runtime.sendMessage(message);
      if (!response?.ok) throw new Error(response?.error?.message || "Не удалось сохранить шаблоны.");
      state.templates = normalizeTemplates(response.templates);
      state.recentTemplateIds = normalizeRecentTemplateIds(response.recentTemplateIds);
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
    if (state.open && state.activeSection === "analysis") renderSection();
  }

  function updateSavedEntries(value) {
    state.savedEntries = workspaceUiModule.normalizeSavedEntries(value);
    if (state.open && state.activeSection === "saved") renderSection();
  }

  async function refreshGlossary() {
    if (!state.workspaceClient || !state.workspaceContext) return;
    const token = ++state.glossaryRequestToken;
    const effectiveMode = workspaceUiModule.activeSearchMode(state.glossaryRequestedMode, state.glossarySearch);
    const response = await state.workspaceClient.queryGlossary(effectiveMode, state.glossarySearch);
    if (token !== state.glossaryRequestToken) return;
    if (!response?.ok) throw new Error(response?.error?.message || "Не удалось загрузить словарь.");
    updateGlossaryEntries(response.entries);
  }

  async function refreshSaved() {
    if (!state.workspaceClient || !state.workspaceContext) return;
    const token = ++state.savedRequestToken;
    const effectiveMode = workspaceUiModule.activeSearchMode(state.savedRequestedMode, state.savedSearch);
    const response = await state.workspaceClient.querySaved(effectiveMode, state.savedSearch);
    if (token !== state.savedRequestToken) return;
    if (!response?.ok) throw new Error(response?.error?.message || "Не удалось загрузить сохранённое.");
    updateSavedEntries(response.entries);
  }

  function handleWorkspaceContextChange(context) {
    state.workspaceContext = context;
    state.glossaryRequestedMode = "local";
    state.glossarySearch = "";
    state.savedRequestedMode = "local";
    state.savedSearch = "";
    state.glossaryConfirmDeleteId = null;
    state.savedConfirmDeleteId = null;
    void Promise.all([refreshGlossary(), refreshSaved()]).catch(handleUiError);
  }

  function handleWorkspaceStatusChange(status) {
    const previous = state.workspaceStatus;
    state.workspaceStatus = status;
    if (status.status === "unavailable") {
      state.workspaceContext = null;
      state.glossaryEntries = [];
      state.savedEntries = [];
      state.glossaryConfirmDeleteId = null;
      state.savedConfirmDeleteId = null;
    }
    if (state.open && ["analysis", "saved"].includes(state.activeSection)
      && (previous.status !== status.status || previous.message !== status.message)) {
      renderSection();
    }
  }

  async function deleteGlossaryEntry(id) {
    const response = await state.workspaceClient?.deleteGlossary(id);
    if (!response?.ok) {
      setStatus("error", response?.error?.message || contract.ERROR_MESSAGES.GLOSSARY_STORAGE_FAILED);
      return;
    }
    state.glossaryConfirmDeleteId = null;
    await refreshGlossary();
    setStatus("success", "Значение удалено глобально.");
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
    const snapshot = typeof selectionText === "string" ? selectionText : String(window.getSelection?.().toString() || "");
    const response = await state.analysisController?.start(snapshot, trigger, pageUrl || location.href);
    if (response?.mutationBusy) state.analysisUi?.showHint("Импорт выполняется. Повторите сохранение терминов позже.");
    return response;
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
      state.templates = normalizeTemplates(response.templates);
      state.recentTemplateIds = normalizeRecentTemplateIds(response.recentTemplateIds);
    } catch (error) {
      state.recentTemplateIds = previous;
      throw error;
    }
  }

  function showTemplateRunError(text) {
    closeRecentPopup();
    state.activeSection = "templates";
    state.open = true;
    state.status = { kind: "error", text: text || "Не удалось выполнить шаблон." };
    renderSection();
  }

  async function runTemplate(id) {
    const template = state.templates.find(function findTemplate(item) { return item.id === id; });
    if (!template || state.busyTemplateId) return;
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

  async function saveEditor() {
    const editorElement = state.shadow.querySelector("[data-editor]");
    if (!editorElement || !state.editing) return;
    const name = editorElement.querySelector('[data-field="name"]').value;
    const content = editorElement.querySelector('[data-field="content"]').value;
    state.editing = { ...state.editing, name: name, content: content };
    if (!name.trim() || !content.trim()) {
      state.editorError = "Заполните название и текст шаблона.";
      renderSection();
      return;
    }

    if (state.editing.id === null) {
      if (await saveTemplateMutation({
        type: workspaceContract.MESSAGE_TYPES.TEMPLATE_CREATE,
        template: { id: createStableId(), name, content, autoSend: false },
      })) {
        state.editing = null;
        state.editorError = "";
        setStatus("success", "Шаблон сохранён.");
      }
    } else {
      const patch = workspaceContract.createTemplatePatch(state.editing.original, { name, content });
      if (!Object.keys(patch).length) {
        state.editing = null;
        state.editorError = "";
        setStatus("success", "Изменений нет.");
        return;
      }
      if (await saveTemplateMutation({
        type: workspaceContract.MESSAGE_TYPES.TEMPLATE_UPDATE,
        templateId: state.editing.id,
        patch,
      })) {
        state.editing = null;
        state.editorError = "";
        setStatus("success", "Шаблон сохранён.");
      }
    }
  }

  async function deleteTemplate(id) {
    if (await saveTemplateMutation({ type: workspaceContract.MESSAGE_TYPES.TEMPLATE_DELETE, templateId: id })) {
      if (state.editing?.id === id) state.editing = null;
      state.confirmingDeleteId = null;
      setStatus("success", "Шаблон удалён.");
    }
  }

  async function reorderTemplates(sourceId, targetId) {
    if (!sourceId || !targetId || sourceId === targetId) return;
    const sourceIndex = state.templates.findIndex(function findSource(template) { return template.id === sourceId; });
    const targetIndex = state.templates.findIndex(function findTarget(template) { return template.id === targetId; });
    if (sourceIndex < 0 || targetIndex < 0) return;
    const next = state.templates.slice();
    const moved = next.splice(sourceIndex, 1)[0];
    next.splice(targetIndex, 0, moved);
    if (await saveTemplateMutation({
      type: workspaceContract.MESSAGE_TYPES.TEMPLATE_REORDER,
      templateIds: next.map((template) => template.id),
    })) setStatus("success", "Порядок шаблонов сохранён.");
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

    if (action === "open-analysis-options") {
      await state.analysisController?.openOptions();
    } else if (action === "open-backup-options") {
      await state.analysisController?.openOptions("backup");
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
      state.glossaryRequestedMode = "local";
      await refreshGlossary();
      renderSection();
    } else if (action === "glossary-mode-global") {
      state.glossaryRequestedMode = "global";
      if (state.glossarySearch.trim()) {
        await refreshGlossary();
      }
      renderSection();
      state.body.querySelector('[data-action="glossary-search"]')?.focus();
    } else if (action === "attach-glossary") {
      const response = await state.workspaceClient?.attachGlossary(id);
      if (!response?.ok) throw new Error(response?.error?.message || "Не удалось добавить термин в чат.");
      await refreshGlossary();
      setStatus("success", "Термин добавлен в текущий чат.");
    } else if (action === "unlink-glossary") {
      const response = await state.workspaceClient?.unlinkGlossary(id);
      if (!response?.ok) throw new Error(response?.error?.message || "Не удалось убрать термин из чата.");
      await refreshGlossary();
      setStatus("success", "Термин убран только из текущего чата.");
    } else if (action === "ask-global-glossary-delete") {
      state.glossaryConfirmDeleteId = id;
      renderSection();
    } else if (action === "cancel-global-glossary-delete") {
      state.glossaryConfirmDeleteId = null;
      renderSection();
    } else if (action === "confirm-global-glossary-delete") {
      await deleteGlossaryEntry(id);
    } else if (action === "saved-mode-local") {
      state.savedRequestedMode = "local";
      await refreshSaved();
      renderSection();
    } else if (action === "saved-mode-global") {
      state.savedRequestedMode = "global";
      if (state.savedSearch.trim()) {
        await refreshSaved();
      }
      renderSection();
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
    } else if (action === "unlink-saved") {
      const response = await state.workspaceClient?.unlinkSaved(id);
      if (!response?.ok) throw new Error(response?.error?.message || "Не удалось убрать текст из чата.");
      await refreshSaved();
      setStatus("success", "Текст убран только из текущего чата.");
    } else if (action === "ask-global-saved-delete") {
      state.savedConfirmDeleteId = id;
      renderSection();
    } else if (action === "cancel-global-saved-delete") {
      state.savedConfirmDeleteId = null;
      renderSection();
    } else if (action === "confirm-global-saved-delete") {
      const response = await state.workspaceClient?.deleteSaved(id);
      if (!response?.ok) throw new Error(response?.error?.message || "Не удалось удалить сохранённый текст.");
      state.savedConfirmDeleteId = null;
      await refreshSaved();
      setStatus("success", "Сохранённый текст удалён глобально.");
    } else if (action === "open-panel") {
      closeRecentPopup();
      openSection(state.activeSection);
    }
    else if (action === "quick-next") await runQuickAction(actionButton);
    else if (action === "add-template") {
      state.editing = { id: null, name: "", content: "" };
      state.editorError = "";
      state.confirmingDeleteId = null;
      renderSection();
    } else if (action === "toggle-delete-mode") {
      state.deleteMode = !state.deleteMode;
      if (!state.deleteMode) state.confirmingDeleteId = null;
      renderSection();
    } else if (action === "run-template") {
      await runTemplate(id);
    } else if (action === "run-recent-template") {
      closeRecentPopup();
      await runTemplate(id);
    } else if (action === "edit-template") {
      if (state.editing?.id === id) state.editing = null;
      else {
        const template = state.templates.find(function findTemplate(item) { return item.id === id; });
        state.editing = template ? {
          id: template.id,
          name: template.name,
          content: template.content,
          original: { name: template.name, content: template.content },
        } : null;
      }
      state.editorError = "";
      state.confirmingDeleteId = null;
      renderSection();
    } else if (action === "cancel-edit") {
      state.editing = null;
      state.editorError = "";
      renderSection();
    } else if (action === "save-edit") await saveEditor();
    else if (action === "ask-delete") {
      state.confirmingDeleteId = id;
      renderSection();
    } else if (action === "cancel-delete") {
      state.confirmingDeleteId = null;
      renderSection();
    } else if (action === "confirm-delete") await deleteTemplate(id);
    else if (action === "remove-wallpaper") {
      await saveSettings({ ...state.settings, wallpaperDataUrl: null }, "Обои удалены.");
    }
  }

  async function onShadowChange(event) {
    const action = event.target.dataset.action;
    if (action === "auto-send") {
      const id = event.target.dataset.id;
      const template = state.templates.find((item) => item.id === id);
      if (template && await saveTemplateMutation({
        type: workspaceContract.MESSAGE_TYPES.TEMPLATE_UPDATE,
        templateId: id,
        patch: { autoSend: event.target.checked },
      })) setStatus("success", "Автоотправка сохранена.");
      else renderSection();
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
      state.glossarySearch = event.target.value;
      state.glossaryRequestedMode = workspaceUiModule.requestedModeAfterQueryInput(
        state.glossaryRequestedMode,
        state.glossarySearch,
      );
      const cursor = event.target.selectionStart;
      void refreshGlossary().then(() => {
        const search = state.body.querySelector('[data-action="glossary-search"]');
        search?.focus();
        if (Number.isInteger(cursor)) search?.setSelectionRange(cursor, cursor);
      }).catch(handleUiError);
      return;
    }
    if (event.target.dataset.action === "saved-search") {
      state.savedSearch = event.target.value;
      state.savedRequestedMode = workspaceUiModule.requestedModeAfterQueryInput(
        state.savedRequestedMode,
        state.savedSearch,
      );
      const cursor = event.target.selectionStart;
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
    }
  }

  function onDragStart(event) {
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
    const handle = event.target.closest("[data-drag-id]");
    if (!handle) return;
    state.draggingId = handle.dataset.dragId;
    event.dataTransfer.effectAllowed = "move";
    event.dataTransfer.setData("text/plain", state.draggingId);
    handle.closest(".template-card")?.classList.add("is-dragging");
  }

  function onDragEnd(event) {
    event.target.closest(".glossary-card")?.classList.remove("is-dragging");
    state.glossaryDraggingId = null;
    event.target.closest(".saved-card")?.classList.remove("is-dragging");
    state.savedDraggingId = null;
    event.target.closest(".template-card")?.classList.remove("is-dragging");
    state.draggingId = null;
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
    if (!state.draggingId || !event.target.closest("[data-template-id]")) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "move";
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
    const target = event.target.closest("[data-template-id]");
    if (!target || !state.draggingId) return;
    event.preventDefault();
    const sourceId = state.draggingId;
    state.draggingId = null;
    void reorderTemplates(sourceId, target.dataset.templateId).catch(handleUiError);
  }

  function mount() {
    closeRecentPopup();
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
    state.rail = shadow.querySelector(".rail");
    state.panel = shadow.querySelector(".panel");
    state.sidebarHandle = shadow.querySelector(".panel-resize");
    state.opener = shadow.querySelector(".panel-opener");
    state.recentPopup = shadow.querySelector(".recent-popup");
    state.quickAction = shadow.querySelector(".quick-action");
    state.wallpaper = shadow.querySelector(".panel-wallpaper");
    state.title = shadow.querySelector(".panel-title");
    state.body = shadow.querySelector(".panel-body");
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
    shadow.addEventListener("dragstart", onDragStart);
    shadow.addEventListener("dragend", onDragEnd);
    shadow.addEventListener("dragover", onDragOver);
    shadow.addEventListener("drop", onDrop);
    state.opener.addEventListener("pointerenter", onOpenerPointerEnter);
    state.opener.addEventListener("pointerleave", onOpenerPointerLeave);
    state.recentPopup.addEventListener("pointerenter", onRecentPopupPointerEnter);
    state.recentPopup.addEventListener("pointerleave", onRecentPopupPointerLeave);
    renderSection();
  }

  function ensureMounted() {
    if (!state.host?.isConnected) mount();
  }

  async function loadStorage() {
    try {
      const stored = await chrome.storage.local.get(["templates", "settings", "recentTemplateIds"]);
      state.templates = normalizeTemplates(stored.templates);
      state.settings = normalizeSettings(stored.settings);
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
    closePanel();
  });

  document.addEventListener("pointerdown", function handleOutsidePointer(event) {
    if (state.sidebarResizing) return;
    if (state.host && !event.composedPath().includes(state.host)) {
      if (state.open && state.settings.closePanelOnOutsideClick) closePanel();
      else closeRecentPopup();
    }
  });

  window.addEventListener("focus", function handleWindowFocus() {
    void refreshKeyStatus();
    if (state.workspaceStatus.status === "unavailable") void state.contextClient?.retry();
  });
  document.addEventListener("visibilitychange", function handleVisibilityChange() {
    refreshKeyStatusWhenVisible();
    retryWorkspaceWhenVisible();
  });
  window.addEventListener("resize", applyShellState);

  chrome.runtime.onMessage.addListener(function handleRuntimeMessage(message, _sender, sendResponse) {
    if (message?.type === TOGGLE_MESSAGE) {
      ensureMounted();
      togglePanel();
      sendResponse({ ok: true, open: state.open });
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
      if (message.entityFamily === workspaceContract.ENTITY_FAMILIES.ALL) {
        state.glossaryEntries = [];
        state.savedEntries = [];
        void state.contextClient?.sync(location.href).then(() => {
          if (!state.open) return;
          if (state.activeSection === "analysis") return refreshGlossary();
          if (state.activeSection === "saved") return refreshSaved();
          return null;
        }).catch(handleUiError);
        return false;
      }
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
    if (changes.templates) state.templates = normalizeTemplates(changes.templates.newValue);
    if (changes.settings) state.settings = normalizeSettings(changes.settings.newValue);
    if (changes.recentTemplateIds) state.recentTemplateIds = normalizeRecentTemplateIds(changes.recentTemplateIds.newValue);
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
    onBusyChange: function setAnalysisBusy(value) { state.analysisBusy = value; },
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
  state.contextClient = conversationContextModule.createClient({
    send: function sendContextMessage(message) { return chrome.runtime.sendMessage(message); },
    onChange: handleWorkspaceContextChange,
    onStatusChange: handleWorkspaceStatusChange,
  });
  state.contextClient.start();
  void loadStorage();
})();
