(function initChatGptHelperOverlay() {
  "use strict";

  const contract = globalThis.ChatGPTHelperAnalysisContract;
  const analysisControllerModule = globalThis.ChatGPTHelperAnalysisController;
  const analysisUiModule = globalThis.ChatGPTHelperAnalysisUi;
  const GLOBAL_KEY = "__chatgptHelperOverlayV1__";
  const HOST_ID = "chatgpt-helper-overlay-root";
  const TOGGLE_MESSAGE = contract.MESSAGE_TYPES.TOGGLE_PANEL;
  const MAX_WALLPAPER_BYTES = 3 * 1024 * 1024;
  const RECENT_HOVER_DELAY_MS = 500;
  const RECENT_CLOSE_DELAY_MS = 120;
  const VALID_THEMES = new Set(["system", "graphite", "navy", "violet", "gold"]);
  const SECTION_TITLES = {
    templates: "Шаблоны",
    analysis: "Анализ текста",
    settings: "Настройки",
  };

  if (window[GLOBAL_KEY]?.ensureMounted) {
    window[GLOBAL_KEY].ensureMounted();
    return;
  }

  const ICONS = {
    templates: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 3.75h12A2.25 2.25 0 0 1 20.25 6v12A2.25 2.25 0 0 1 18 20.25H6A2.25 2.25 0 0 1 3.75 18V6A2.25 2.25 0 0 1 6 3.75Zm1.5 4.5h9m-9 3.75h9m-9 3.75H13"/></svg>',
    analysis: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4.75 19.25V12.5m4.75 6.75V7.75m4.75 11.5v-4.5M19 19.25V4.75"/></svg>',
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
    settings: {
      theme: "system",
      wallpaperDataUrl: null,
      closePanelAfterRun: true,
      recentTemplatesHoverEnabled: true,
      analysis: contract.DEFAULT_ANALYSIS_SETTINGS,
    },
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
    glossarySearch: "",
    glossaryDeleteMode: false,
    glossaryConfirmDeleteId: null,
    glossaryDraggingId: null,
    keyConfigured: false,
    shortcutRecording: false,
    shortcutWarning: "",
    analysisBusy: false,
    analysisController: null,
    analysisUi: null,
    host: null,
    shadow: null,
    shell: null,
    rail: null,
    panel: null,
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
      "  --panel-width: min(360px, calc(100vw - 48px));",
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
      "  --shadow: 0 18px 45px rgb(15 23 42 / 24%);",
      "  font: 13px/1.45 system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;",
      "  color: var(--text);",
      "}",
      ".theme-graphite { --bg: #15171c; --surface: #1d2129; --surface-hover: #272d37; --text: #e8edf3; --muted: #a7b0bd; --border: #3a414d; --accent: #69d6c5; --accent-contrast: #11161c; --danger: #ff8b82; }",
      ".theme-navy { --bg: #0b1220; --surface: #111c2e; --surface-hover: #182740; --text: #e5eefc; --muted: #9fb0ca; --border: #2a3c55; --accent: #55b7ff; --accent-contrast: #07111e; --danger: #ff8f8f; }",
      ".theme-violet { --bg: #14101d; --surface: #20162e; --surface-hover: #2d2040; --text: #f4edff; --muted: #b9aacb; --border: #4d3a67; --accent: #b58cff; --accent-contrast: #160e22; --danger: #ff96a8; }",
      ".theme-gold { --bg: #0b0b0b; --surface: #202020; --surface-hover: #2b2b2b; --text: #f4f4f0; --muted: #bdb9a6; --border: rgb(219 201 0 / 48%); --accent: rgba(219, 201, 0, 1); --accent-contrast: #090909; --danger: #ff8f85; }",
      ".rail {",
      "  position: fixed;",
      "  top: 0;",
      "  right: 0;",
      "  bottom: 0;",
      "  z-index: 3;",
      "  display: flex;",
      "  width: var(--rail-width);",
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
      "  transition: right 160ms ease;",
      "}",
      ".is-open .rail { right: var(--panel-width); }",
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
      "  position: fixed;",
      "  top: 0;",
      "  right: 0;",
      "  bottom: 0;",
      "  z-index: 2;",
      "  width: var(--panel-width);",
      "  overflow: hidden;",
      "  border-left: 1px solid var(--border);",
      "  background: var(--bg);",
      "  box-shadow: var(--shadow);",
      "  pointer-events: auto;",
      "}",
      ".panel-wallpaper, .panel-scrim { position: absolute; inset: 0; pointer-events: none; }",
      ".panel-wallpaper { background-position: center; background-size: cover; opacity: .58; }",
      ".panel-scrim { background: color-mix(in srgb, var(--bg) 90%, transparent); }",
      ".has-wallpaper .panel-scrim { background: color-mix(in srgb, var(--bg) 76%, transparent); backdrop-filter: blur(1px); }",
      ".panel-content { position: relative; z-index: 1; display: grid; height: 100%; grid-template-rows: auto minmax(0, 1fr); }",
      ".panel-header { display: flex; min-height: 58px; padding: 16px 18px 12px; align-items: center; border-bottom: 1px solid var(--border); }",
      ".panel-title { margin: 0; font-size: 17px; font-weight: 680; letter-spacing: -.01em; }",
      ".panel-body { min-height: 0; overflow: auto; padding: 16px; }",
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
      ".settings-group { display: grid; margin-bottom: 20px; gap: 9px; }",
      ".settings-group h3 { margin: 0; font-size: 14px; }",
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
      "@media (prefers-reduced-motion: reduce) { .rail, .quick-action { transition: none; } .recent-popup { animation: none; } }",
      analysisUiModule.styles(),
    ].join("\n");
  }

  function shellMarkup() {
    return [
      '<style>' + styles() + '</style>',
      '<div class="shell theme-system">',
      '  <button class="quick-action" type="button" data-action="quick-next" title="Отправить «Далее», если поле пусто" aria-label="Отправить «Далее», если поле пусто">' + ICONS.quick + '</button>',
      '  <button class="panel-opener" type="button" data-action="open-panel" title="Открыть меню шаблонов" aria-label="Открыть меню шаблонов" aria-haspopup="menu" aria-expanded="false">' + ICONS.opener + '</button>',
      '  <div class="recent-popup" role="menu" aria-label="Последние запущенные шаблоны" hidden></div>',
      '  <nav class="rail" aria-label="Разделы chatgpt-helper" hidden>',
      '    <button class="rail-button" type="button" data-section="templates" title="Шаблоны" aria-label="Шаблоны">' + ICONS.templates + '</button>',
      '    <button class="rail-button" type="button" data-section="analysis" title="Анализ текста" aria-label="Анализ текста">' + ICONS.analysis + '</button>',
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
    state.shell.className = "shell theme-" + state.settings.theme + (state.open ? " is-open" : "") + (state.settings.wallpaperDataUrl ? " has-wallpaper" : "");
    state.panel.hidden = !state.open;
    state.rail.hidden = !state.open;
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
    return analysisUiModule.analysisMarkup(state) + statusMarkup();
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
      '  <h3>Тема</h3>',
      themeOptions,
      '</section>',
      '<section class="settings-group">',
      '  <h3>Поведение</h3>',
      '  <label class="setting-option"><input type="checkbox" data-action="close-panel-after-run"' + (state.settings.closePanelAfterRun ? " checked" : "") + '><span>Закрывать панель после запуска шаблона</span></label>',
      '  <label class="setting-option"><input type="checkbox" data-action="recent-templates-hover"' + (state.settings.recentTemplatesHoverEnabled ? " checked" : "") + '><span>Показывать последние шаблоны при наведении</span></label>',
      '</section>',
      '<section class="settings-group">',
      '  <h3>Обои панели</h3>',
      '  <p class="settings-help">Локальное изображение применяется только к раскрытой панели. Максимум 3 МБ.</p>',
      '  <input class="file-input" type="file" accept="image/*" data-action="wallpaper">',
      state.settings.wallpaperDataUrl ? '  <button class="button danger" type="button" data-action="remove-wallpaper">Удалить обои</button>' : "",
      '</section>',
      analysisUiModule.settingsMarkup(state),
      statusMarkup(),
    ].join("");
  }

  function renderSection() {
    if (!state.body) return;
    applyShellState();
    if (state.activeSection === "templates") state.body.innerHTML = templatesMarkup();
    else if (state.activeSection === "analysis") state.body.innerHTML = analysisMarkup();
    else state.body.innerHTML = settingsMarkup();
  }

  function openSection(section) {
    if (!SECTION_TITLES[section]) return;
    if (section !== "settings" && state.shortcutRecording) {
      state.shortcutRecording = false;
      state.analysisController?.setShortcutRecording(false);
      state.shortcutWarning = "Запись сочетания отменена.";
    }
    closeRecentPopup();
    state.activeSection = section;
    state.open = true;
    clearStatus();
    renderSection();
    if (section === "analysis" || section === "settings") void refreshKeyStatus();
  }

  function closePanel() {
    closeRecentPopup();
    if (!state.open) return;
    if (state.shortcutRecording) {
      state.shortcutRecording = false;
      state.analysisController?.setShortcutRecording(false);
      state.shortcutWarning = "Запись сочетания отменена.";
    }
    state.open = false;
    applyShellState();
  }

  function togglePanel() {
    closeRecentPopup();
    state.open = !state.open;
    applyShellState();
    if (state.open) renderSection();
  }

  async function saveTemplates(nextTemplates) {
    try {
      await chrome.storage.local.set({ templates: nextTemplates });
      state.templates = nextTemplates;
      return true;
    } catch (error) {
      setStatus("error", error?.message || "Не удалось сохранить шаблоны.");
      return false;
    }
  }

  async function saveSettings(nextSettings, successText) {
    const previous = state.settings;
    const normalizedSettings = normalizeSettings(nextSettings);
    state.settings = normalizedSettings;
    if (!normalizedSettings.recentTemplatesHoverEnabled) closeRecentPopup();
    applyShellState();
    try {
      await chrome.storage.local.set({ settings: normalizedSettings });
      setStatus("success", successText || "Настройки сохранены.");
      return true;
    } catch (error) {
      state.settings = previous;
      applyShellState();
      setStatus("error", error?.message || "Не удалось сохранить настройки.");
      return false;
    }
  }

  async function refreshKeyStatus() {
    if (!state.analysisController) return;
    try {
      const configured = await state.analysisController.getKeyStatus();
      updateKeyStatus(configured);
    } catch (_) {
      state.keyConfigured = false;
    }
  }

  function updateKeyStatus(configured) {
    if (typeof configured !== "boolean" || state.keyConfigured === configured) return;
    state.keyConfigured = configured;
    if (state.open && (state.activeSection === "analysis" || state.activeSection === "settings")) renderSection();
  }

  function refreshKeyStatusWhenVisible() {
    if (document.visibilityState === "visible") void refreshKeyStatus();
  }

  function updateGlossaryEntries(value) {
    state.glossaryEntries = analysisUiModule.normalizeGlossaryEntries(value);
    if (state.open && state.activeSection === "analysis") renderSection();
  }

  function likelyBrowserConflict(shortcut) {
    if (!shortcut.ctrl || shortcut.alt || shortcut.meta) return false;
    return new Set(["KeyD", "KeyF", "KeyL", "KeyN", "KeyP", "KeyS", "KeyT", "KeyU"]).has(shortcut.code);
  }

  function handleShortcutCandidate(validation) {
    if (!validation?.ok) {
      state.shortcutWarning = validation?.reason || "Не удалось записать сочетание.";
      if (state.open && state.activeSection === "settings") renderSection();
      return;
    }
    state.shortcutRecording = false;
    state.shortcutWarning = likelyBrowserConflict(validation.shortcut)
      ? "Сочетание сохранено, но может конфликтовать с командой браузера."
      : "Сочетание сохранено.";
    void saveSettings({
      ...state.settings,
      analysis: { ...state.settings.analysis, shortcut: validation.shortcut },
    }, state.shortcutWarning);
  }

  function cancelShortcutRecording() {
    state.shortcutRecording = false;
    state.shortcutWarning = "Запись сочетания отменена.";
    if (state.open && state.activeSection === "settings") renderSection();
  }

  async function deleteGlossaryEntry(id) {
    const response = await state.analysisController?.deleteGlossaryEntry(id);
    if (!response?.ok) {
      setStatus("error", response?.error?.message || contract.ERROR_MESSAGES.GLOSSARY_STORAGE_FAILED);
      return;
    }
    state.glossaryConfirmDeleteId = null;
    updateGlossaryEntries(response.glossaryEntries);
    setStatus("success", "Термин удалён.");
  }

  async function reorderGlossaryEntries(sourceId, beforeEntryId) {
    if (!sourceId || sourceId === beforeEntryId || state.glossarySearch) return;
    const response = await state.analysisController?.moveGlossaryEntry(sourceId, beforeEntryId);
    if (!response?.ok) {
      setStatus("error", response?.error?.message || contract.ERROR_MESSAGES.GLOSSARY_STORAGE_FAILED);
      return;
    }
    updateGlossaryEntries(response.glossaryEntries);
    setStatus("success", "Порядок терминов сохранён.");
  }

  async function recordRecentTemplate(id) {
    const previous = state.recentTemplateIds;
    const next = normalizeRecentTemplateIds([id].concat(previous));
    state.recentTemplateIds = next;
    try {
      await chrome.storage.local.set({ recentTemplateIds: next });
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
      if (!result?.ok) {
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
      if (!result?.ok && !result?.noop) {
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

    let next;
    if (state.editing.id === null) {
      next = state.templates.concat({
        id: createStableId(),
        name: name,
        content: content,
        autoSend: false,
      });
    } else {
      next = state.templates.map(function updateTemplate(template) {
        return template.id === state.editing.id ? { ...template, name: name, content: content } : template;
      });
    }
    if (await saveTemplates(next)) {
      state.editing = null;
      state.editorError = "";
      setStatus("success", "Шаблон сохранён.");
    }
  }

  async function deleteTemplate(id) {
    const next = state.templates.filter(function keepTemplate(template) { return template.id !== id; });
    if (await saveTemplates(next)) {
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
    if (await saveTemplates(next)) setStatus("success", "Порядок шаблонов сохранён.");
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
    if (!file.type.startsWith("image/")) {
      setStatus("error", "Выберите файл изображения.");
      return;
    }
    if (file.size > MAX_WALLPAPER_BYTES) {
      setStatus("error", "Изображение превышает лимит 3 МБ.");
      return;
    }
    try {
      const dataUrl = await fileToDataUrl(file);
      if (typeof dataUrl !== "string" || !dataUrl.startsWith("data:image/")) {
        setStatus("error", "Не удалось подготовить изображение.");
        return;
      }
      await saveSettings({ ...state.settings, wallpaperDataUrl: dataUrl }, "Обои сохранены.");
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
    } else if (action === "record-analysis-shortcut") {
      state.shortcutRecording = true;
      state.shortcutWarning = "Нажмите основную клавишу вместе с Ctrl, Shift, Alt или Meta. Esc отменяет запись.";
      state.analysisController?.setShortcutRecording(true);
      renderSection();
    } else if (action === "toggle-analysis-shortcut") {
      const shortcut = contract.normalizeShortcut(state.settings.analysis?.shortcut);
      await saveSettings({
        ...state.settings,
        analysis: { ...state.settings.analysis, shortcut: { ...shortcut, enabled: !shortcut.enabled } },
      }, shortcut.enabled ? "Сочетание отключено." : "Сочетание включено.");
    } else if (action === "reset-analysis-shortcut") {
      state.shortcutRecording = false;
      state.analysisController?.setShortcutRecording(false);
      state.shortcutWarning = "Сочетание сброшено на Ctrl + D.";
      await saveSettings({
        ...state.settings,
        analysis: { ...state.settings.analysis, shortcut: { ...contract.DEFAULT_SHORTCUT } },
      }, state.shortcutWarning);
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
    } else if (action === "clear-glossary-search") {
      state.glossarySearch = "";
      renderSection();
      state.body.querySelector('[data-action="glossary-search"]')?.focus();
    } else if (action === "toggle-glossary-delete-mode") {
      state.glossaryDeleteMode = !state.glossaryDeleteMode;
      if (!state.glossaryDeleteMode) state.glossaryConfirmDeleteId = null;
      renderSection();
    } else if (action === "ask-glossary-delete") {
      state.glossaryConfirmDeleteId = id;
      renderSection();
    } else if (action === "cancel-glossary-delete") {
      state.glossaryConfirmDeleteId = null;
      renderSection();
    } else if (action === "confirm-glossary-delete") {
      await deleteGlossaryEntry(id);
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
        state.editing = template ? { id: template.id, name: template.name, content: template.content } : null;
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
      const next = state.templates.map(function updateAutoSend(template) {
        return template.id === id ? { ...template, autoSend: event.target.checked } : template;
      });
      if (await saveTemplates(next)) setStatus("success", "Автоотправка сохранена.");
      else renderSection();
    } else if (action === "theme") {
      const theme = event.target.value;
      if (VALID_THEMES.has(theme)) {
        await saveSettings({ ...state.settings, theme: theme }, "Тема сохранена.");
      }
    } else if (action === "close-panel-after-run") {
      await saveSettings({ ...state.settings, closePanelAfterRun: event.target.checked }, "Настройка запуска сохранена.");
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
      const cursor = event.target.selectionStart;
      renderSection();
      const search = state.body.querySelector('[data-action="glossary-search"]');
      search?.focus();
      if (Number.isInteger(cursor)) search?.setSelectionRange(cursor, cursor);
      return;
    }
    if (!state.editing || !event.target.matches("[data-field]")) return;
    const field = event.target.dataset.field;
    if (field === "name" || field === "content") {
      state.editing = { ...state.editing, [field]: event.target.value };
    }
  }

  function onDragStart(event) {
    const glossaryHandle = event.target.closest("[data-glossary-drag-id]");
    if (glossaryHandle) {
      if (state.glossarySearch) {
        event.preventDefault();
        return;
      }
      state.glossaryDraggingId = glossaryHandle.dataset.glossaryDragId;
      event.dataTransfer.effectAllowed = "move";
      event.dataTransfer.setData("text/plain", state.glossaryDraggingId);
      glossaryHandle.closest(".glossary-card")?.classList.add("is-dragging");
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
    event.target.closest(".template-card")?.classList.remove("is-dragging");
    state.draggingId = null;
  }

  function onDragOver(event) {
    if (state.glossaryDraggingId && event.target.closest("[data-glossary-id]")) {
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
    const target = event.target.closest("[data-template-id]");
    if (!target || !state.draggingId) return;
    event.preventDefault();
    const sourceId = state.draggingId;
    state.draggingId = null;
    void reorderTemplates(sourceId, target.dataset.templateId).catch(handleUiError);
  }

  function mount() {
    closeRecentPopup();
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
    state.opener = shadow.querySelector(".panel-opener");
    state.recentPopup = shadow.querySelector(".recent-popup");
    state.quickAction = shadow.querySelector(".quick-action");
    state.wallpaper = shadow.querySelector(".panel-wallpaper");
    state.title = shadow.querySelector(".panel-title");
    state.body = shadow.querySelector(".panel-body");
    state.analysisUi = analysisUiModule.create({
      getShell: function getShell() { return state.shell; },
      getSettings: function getSettings() { return state.settings; },
      onOpenOptions: function openAnalysisOptions() { return state.analysisController?.openOptions(); },
      onReplace: function replaceGlossaryEntry(command) { return state.analysisController?.replaceGlossaryEntry(command); },
      onGlossaryEntries: updateGlossaryEntries,
    });

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
      const stored = await chrome.storage.local.get(["templates", "settings", "recentTemplateIds", "glossaryEntries"]);
      state.templates = normalizeTemplates(stored.templates);
      state.settings = normalizeSettings(stored.settings);
      state.recentTemplateIds = normalizeRecentTemplateIds(stored.recentTemplateIds);
      state.glossaryEntries = analysisUiModule.normalizeGlossaryEntries(stored.glossaryEntries);
      await chrome.storage.local.set({
        templates: state.templates,
        settings: state.settings,
        recentTemplateIds: state.recentTemplateIds,
      });
      renderSection();
      await refreshKeyStatus();
    } catch (error) {
      setStatus("error", error?.message || "Не удалось загрузить данные расширения.");
    }
  }

  document.addEventListener("keydown", function handleEscape(event) {
    if (event.key === "Escape") closePanel();
  });

  document.addEventListener("pointerdown", function handleOutsidePointer(event) {
    if (state.host && !event.composedPath().includes(state.host)) {
      if (state.open) closePanel();
      else closeRecentPopup();
    }
  });

  window.addEventListener("focus", function handleWindowFocus() { void refreshKeyStatus(); });
  document.addEventListener("visibilitychange", refreshKeyStatusWhenVisible);

  chrome.runtime.onMessage.addListener(function handleRuntimeMessage(message, _sender, sendResponse) {
    if (message?.type !== TOGGLE_MESSAGE) return false;
    ensureMounted();
    togglePanel();
    sendResponse({ ok: true, open: state.open });
    return false;
  });

  chrome.storage.onChanged.addListener(function handleStorageChange(changes, areaName) {
    if (areaName !== "local") return;
    if (changes.templates) state.templates = normalizeTemplates(changes.templates.newValue);
    if (changes.settings) state.settings = normalizeSettings(changes.settings.newValue);
    if (changes.recentTemplateIds) state.recentTemplateIds = normalizeRecentTemplateIds(changes.recentTemplateIds.newValue);
    if (changes.glossaryEntries) {
      state.glossaryDraggingId = null;
      state.glossaryEntries = analysisUiModule.normalizeGlossaryEntries(changes.glossaryEntries.newValue);
    }
    closeRecentPopup();
    renderSection();
  });

  const mountObserver = new MutationObserver(ensureMounted);
  mountObserver.observe(document.documentElement, { childList: true, subtree: true });

  window[GLOBAL_KEY] = { ensureMounted: ensureMounted };
  ensureMounted();
  state.analysisController = analysisControllerModule.create({
    getShortcut: function getShortcut() { return state.settings.analysis?.shortcut; },
    handleEscapeLayer: function handleEscapeLayer() { return state.analysisUi?.handleEscape() || false; },
    onShortcutCandidate: handleShortcutCandidate,
    onShortcutRecordingCancelled: cancelShortcutRecording,
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
      if (response.glossaryEntries) updateGlossaryEntries(response.glossaryEntries);
      state.analysisUi?.showResult(response);
    },
  });
  void loadStorage();
})();
