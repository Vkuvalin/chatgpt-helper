(function initWorkspaceUi(root) {
  "use strict";

  if (root.ChatGPTHelperWorkspaceUi) return;

  const contract = root.ChatGPTHelperWorkspaceContract;
  const DRAG_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 6h.01M15 6h.01M9 12h.01M15 12h.01M9 18h.01M15 18h.01"/></svg>';
  const COPY_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 8.75h8.25A1.75 1.75 0 0 1 19 10.5v7.25a1.75 1.75 0 0 1-1.75 1.75H10a1.75 1.75 0 0 1-1.75-1.75V10.5A1.75 1.75 0 0 1 10 8.75Zm6.75 0V6.5A1.75 1.75 0 0 0 14 4.75H6.75A1.75 1.75 0 0 0 5 6.5v7.25a1.75 1.75 0 0 0 1.75 1.75h1.5"/></svg>';
  const CHECK_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m5 12.5 4.25 4.25L19 7"/></svg>';
  const TRASH_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 7h14m-9-3h4l1 3H9l1-3Zm-3 3 1 13h8l1-13M10 10v6m4-6v6"/></svg>';

  function escapeHtml(value) {
    return String(value ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#039;");
  }

  function normalizeGlossaryEntries(value) {
    if (!Array.isArray(value)) return [];
    return value.filter((item) => item && typeof item.id === "string"
      && typeof item.term === "string"
      && typeof item.translation === "string"
      && typeof item.definition === "string");
  }

  function normalizeSavedEntries(value) {
    if (!Array.isArray(value)) return [];
    return value.filter((item) => item && typeof item.id === "string" && typeof item.text === "string");
  }

  function modeToolbar(kind, mode, query) {
    const label = kind === "glossary" ? "словарю" : "сохранённому";
    return [
      '<div class="workspace-mode" role="group" aria-label="Область поиска">',
      `  <button class="workspace-mode-button${mode === "local" ? " is-active" : ""}" type="button" data-action="${kind}-mode-local" aria-pressed="${mode === "local"}">Локально</button>`,
      `  <button class="workspace-mode-button${mode === "global" ? " is-active" : ""}" type="button" data-action="${kind}-mode-global" aria-pressed="${mode === "global"}">Глобально</button>`,
      "</div>",
      '<div class="workspace-search-wrap">',
      `  <input class="workspace-search" type="search" data-action="${kind}-search" placeholder="Поиск по ${label}" value="${escapeHtml(query)}">`,
      "</div>",
    ].join("");
  }

  function unavailableMarkup(state) {
    if (state.workspaceStatus?.status !== "unavailable") return "";
    const message = state.workspaceStatus.message
      || "Workspace не удалось инициализировать или мигрировать. Данные словаря V1 не удалены. Перезагрузите страницу или повторите попытку. Новые изменения Workspace не применены.";
    return [
      '<div class="workspace-unavailable" role="alert">',
      "  <strong>Workspace недоступен</strong>",
      `  <p>${escapeHtml(message)}</p>`,
      '  <button class="button" type="button" data-action="retry-workspace">Повторить</button>',
      "</div>",
    ].join("");
  }

  function activeSearchMode(requestedMode) {
    return requestedMode === "global" ? "global" : "local";
  }

  function requestedModeAfterQueryInput(requestedMode) {
    return requestedMode === "global" ? "global" : "local";
  }

  function closedWorkspaceDeleteState() {
    return {
      phase: "closed",
      kind: null,
      entryId: null,
      scope: null,
      menuOpen: false,
    };
  }

  function workspaceDeleteOwns(value, kind, entryId) {
    return value?.phase !== "closed" && value?.kind === kind && value?.entryId === entryId;
  }

  function workspaceDeleteMenuOpen(value) {
    return value?.phase !== "closed" && value?.menuOpen !== false;
  }

  function transitionWorkspaceDelete(value, event) {
    const current = value?.phase ? value : closedWorkspaceDeleteState();
    if (event?.type === "settle") return closedWorkspaceDeleteState();
    if (event?.type === "close") {
      if (current.phase === "deleting") return { ...current, menuOpen: false };
      return closedWorkspaceDeleteState();
    }
    if (event?.type === "trigger") {
      if (current.phase === "deleting") return current;
      if (!["glossary", "saved"].includes(event.kind) || typeof event.entryId !== "string" || !event.entryId) {
        return current;
      }
      if (workspaceDeleteOwns(current, event.kind, event.entryId)) return closedWorkspaceDeleteState();
      return {
        phase: "choosing",
        kind: event.kind,
        entryId: event.entryId,
        scope: null,
        menuOpen: true,
      };
    }
    if (event?.type === "begin"
      && current.phase === "choosing"
      && ["local", "global"].includes(event.scope)) {
      return {
        ...current,
        phase: "deleting",
        scope: event.scope,
        menuOpen: true,
      };
    }
    return current;
  }

  function workspaceDeleteOperation(kind, scope) {
    if (kind === "glossary" && scope === "local") return "unlinkGlossary";
    if (kind === "glossary" && scope === "global") return "deleteGlossary";
    if (kind === "saved" && scope === "local") return "unlinkSaved";
    if (kind === "saved" && scope === "global") return "deleteSaved";
    return null;
  }

  function workspaceDeleteLocalAvailable(mode, entry) {
    return mode === "local" || entry?.attached === true;
  }

  function workspaceDeletePointerInside(value, pathValue) {
    if (value?.phase === "closed" || !Array.isArray(pathValue)) return false;
    return pathValue.some((item) => (
      item?.dataset?.workspaceDeleteKind === value.kind
      && item?.dataset?.workspaceDeleteId === value.entryId
    ));
  }

  function workspaceDeleteEntryPresent(value, entriesValue) {
    if (value?.phase === "closed") return true;
    return Array.isArray(entriesValue) && entriesValue.some((entry) => entry?.id === value?.entryId);
  }

  function isCurrentWorkspaceRequest(token, currentToken) {
    return token === currentToken;
  }

  function workspaceDeleteMarkup(state, kind, entry, mode) {
    const deletion = state.workspaceDelete || closedWorkspaceDeleteState();
    const owns = workspaceDeleteOwns(deletion, kind, entry.id);
    const menuOpen = owns && workspaceDeleteMenuOpen(deletion);
    const busy = deletion.phase === "deleting";
    const localAvailable = workspaceDeleteLocalAvailable(mode, entry);
    const localLabel = localAvailable ? "Удалить только из этого чата" : "Запись не добавлена в этот чат";
    const trash = [
      `<button class="icon-button workspace-trash-button${menuOpen ? " is-open" : ""}" type="button" data-action="workspace-delete-toggle" data-kind="${kind}" data-id="${escapeHtml(entry.id)}" title="Удалить запись" aria-label="Удалить запись" aria-expanded="${menuOpen}"${busy ? " disabled" : ""}>`,
      `  ${TRASH_ICON}`,
      "</button>",
    ].join("");
    const menu = menuOpen ? [
      `<div class="workspace-delete-menu" data-workspace-delete-menu="${kind}" role="group" aria-label="Удалить запись">`,
      '  <strong class="workspace-delete-title">Удалить запись</strong>',
      '  <div class="workspace-delete-actions">',
      `    <button class="button" type="button" data-action="workspace-delete-local" data-kind="${kind}" data-id="${escapeHtml(entry.id)}" title="${localLabel}" aria-label="${localLabel}"${!localAvailable || busy ? " disabled" : ""}>Из чата</button>`,
      `    <button class="button danger" type="button" data-action="workspace-delete-global" data-kind="${kind}" data-id="${escapeHtml(entry.id)}" title="Удалить запись везде" aria-label="Удалить запись везде"${busy ? " disabled" : ""}>Везде</button>`,
      "  </div>",
      "</div>",
    ].join("") : "";
    return { trash, menu };
  }

  function nextSidebarPhase(phase, action) {
    if (action === "open" && phase === "closed") return "opening";
    if (action === "close" && phase === "open") return "closing";
    if (action !== "complete") return phase;
    if (phase === "opening") return "open";
    if (phase === "closing") return "revealing-opener";
    if (phase === "revealing-opener") return "closed";
    return phase;
  }

  function quickActionStateForPhase(phase) {
    const visible = phase === "revealing-opener" || phase === "closed";
    return Object.freeze({
      rendered: phase === "closing" || visible,
      visible,
      interactive: phase === "closed",
    });
  }

  function createTransformTransitionController(options) {
    const duration = Number.isFinite(options?.duration) ? Math.max(0, options.duration) : 200;
    const fallbackPadding = Number.isFinite(options?.fallbackPadding) ? Math.max(0, options.fallbackPadding) : 50;
    const schedule = options?.setTimeout || root.setTimeout.bind(root);
    const cancelScheduled = options?.clearTimeout || root.clearTimeout.bind(root);
    const prefersReducedMotion = options?.prefersReducedMotion || (() => false);
    let generation = 0;
    let cleanup = null;

    function cancel() {
      generation += 1;
      cleanup?.();
      cleanup = null;
    }

    function run(element, onComplete) {
      cancel();
      const token = generation;
      let settled = false;
      let fallbackTimer = null;

      function finish() {
        if (settled || token !== generation) return false;
        settled = true;
        element?.removeEventListener?.("transitionend", onTransitionEnd);
        if (fallbackTimer !== null) cancelScheduled(fallbackTimer);
        if (cleanup === stop) cleanup = null;
        onComplete?.();
        return true;
      }

      function onTransitionEnd(event) {
        if (event?.target === element && event?.propertyName === "transform") finish();
      }

      function stop() {
        if (settled) return;
        settled = true;
        element?.removeEventListener?.("transitionend", onTransitionEnd);
        if (fallbackTimer !== null) cancelScheduled(fallbackTimer);
      }

      cleanup = stop;
      if (prefersReducedMotion()) {
        finish();
      } else {
        element?.addEventListener?.("transitionend", onTransitionEnd);
        fallbackTimer = schedule(finish, duration + fallbackPadding);
      }
      return token;
    }

    return Object.freeze({
      run,
      cancel,
      generation: () => generation,
    });
  }

  function recentTemplatesForDisplay(recentTemplateIds, templatesValue, countValue) {
    const templates = Array.isArray(templatesValue) ? templatesValue : [];
    const byId = new Map(templates.map((template) => [template?.id, template]));
    const count = contract.normalizeRecentTemplatesHoverCount(countValue);
    return contract.normalizeRecentTemplateIds(recentTemplateIds).flatMap((id) => {
      const template = byId.get(id);
      return template ? [template] : [];
    }).slice(0, count);
  }

  function previewPosition(anchorRectValue, previewRectValue, viewportValue) {
    const anchor = anchorRectValue || {};
    const preview = previewRectValue || {};
    const viewport = viewportValue || {};
    const gap = Number.isFinite(viewport.gap) ? viewport.gap : 10;
    const padding = Number.isFinite(viewport.padding) ? viewport.padding : 12;
    const viewportWidth = Math.max(0, Number(viewport.width) || 0);
    const viewportHeight = Math.max(0, Number(viewport.height) || 0);
    const previewWidth = Math.max(0, Number(preview.width) || 0);
    const previewHeight = Math.max(0, Number(preview.height) || 0);
    const maxLeft = Math.max(padding, viewportWidth - previewWidth - padding);
    const maxTop = Math.max(padding, viewportHeight - previewHeight - padding);
    const preferredLeft = (Number(anchor.left) || 0) - previewWidth - gap;
    const preferredTop = (Number(anchor.top) || 0) + previewHeight > viewportHeight - padding
      ? (Number(anchor.bottom) || 0) - previewHeight
      : (Number(anchor.top) || 0);
    return {
      left: Math.min(maxLeft, Math.max(padding, preferredLeft)),
      top: Math.min(maxTop, Math.max(padding, preferredTop)),
    };
  }

  function previewAnchorFromTarget(target) {
    return target?.closest?.("[data-preview-anchor]") || null;
  }

  function glossaryMarkup(state) {
    const query = String(state.glossarySearch || "");
    const requestedMode = state.glossaryRequestedMode === "global" ? "global" : "local";
    const mode = activeSearchMode(requestedMode, query);
    const globalEmpty = mode === "global" && !query.trim();
    const entries = globalEmpty ? [] : normalizeGlossaryEntries(state.glossaryEntries);
    const analysis = state.settings?.analysis || {};
    const termColor = analysis.termColorMode === "custom" ? analysis.customTermColor : "var(--accent)";
    const unavailable = unavailableMarkup(state);
    const cards = entries.map((entry) => {
      const local = mode === "local";
      const draggable = local && !query.trim();
      const action = local
        ? ""
        : entry.attached
          ? '<span class="workspace-attached">Уже в этом чате</span>'
          : `<button class="button workspace-card-action" type="button" data-action="attach-glossary" data-id="${escapeHtml(entry.id)}">Добавить в чат</button>`;
      const deletion = workspaceDeleteMarkup(state, "glossary", entry, mode);
      return [
        `<article class="workspace-card glossary-card" data-glossary-id="${escapeHtml(entry.id)}" data-workspace-delete-kind="glossary" data-workspace-delete-id="${escapeHtml(entry.id)}">`,
        '  <div class="workspace-card-main">',
        local ? `    <span class="drag-handle" ${draggable ? 'draggable="true"' : ""} data-glossary-drag-id="${escapeHtml(entry.id)}" title="${draggable ? "Перетащить термин" : "Порядок доступен без поиска"}">${DRAG_ICON}</span>` : "",
        '    <div class="workspace-card-copy">',
        `      <div><strong class="glossary-term">${escapeHtml(entry.term)}</strong> <em class="glossary-translation">(«${escapeHtml(entry.translation)}»)</em></div>`,
        `      <p class="glossary-definition">${escapeHtml(entry.definition)}</p>`,
        "    </div>",
        "  </div>",
        `  <div class="workspace-card-footer">${action}${deletion.trash}</div>`,
        deletion.menu,
        "</article>",
      ].join("");
    }).join("");

    let empty = "";
    if (globalEmpty) empty = '<p class="empty-state">Введите запрос для глобального поиска.</p>';
    else if (!entries.length && mode === "local") empty = '<p class="empty-state">В этом чате пока нет терминов. Запустите анализ выделенного текста или добавьте результат глобального поиска.</p>';
    else if (!entries.length) empty = '<p class="empty-state">По глобальному запросу ничего не найдено.</p>';
    const keyOnboarding = !state.keyChecking && !state.keyConfigured
      ? [
        '<div class="analysis-key-row">',
        '  <span class="analysis-key-state">OpenRouter не подключён</span>',
        '  <button class="button" type="button" data-action="open-analysis-options">Настроить</button>',
        "</div>",
      ].join("")
      : "";

    return [
      keyOnboarding,
      unavailable,
      unavailable ? "" : [
      '<div class="workspace-toolbar">',
      modeToolbar("glossary", requestedMode, query),
      `  <p class="analysis-counter">${entries.length} терминов</p>`,
      "</div>",
      cards ? `<div class="workspace-list glossary-list size-${escapeHtml(analysis.glossaryTextSize || "normal")}" style="--term-color:${escapeHtml(termColor)}">${cards}</div>` : empty,
      ].join(""),
    ].join("");
  }

  function savedMarkup(state) {
    const query = String(state.savedSearch || "");
    const requestedMode = state.savedRequestedMode === "global" ? "global" : "local";
    const mode = activeSearchMode(requestedMode, query);
    const globalEmpty = mode === "global" && !query.trim();
    const entries = globalEmpty ? [] : normalizeSavedEntries(state.savedEntries);
    const unavailable = unavailableMarkup(state);
    const cards = entries.map((entry) => {
      const local = mode === "local";
      const draggable = local && !query.trim();
      const action = local
        ? ""
        : entry.attached
          ? '<span class="workspace-attached">Уже в этом чате</span>'
          : `<button class="button workspace-card-action" type="button" data-action="attach-saved" data-id="${escapeHtml(entry.id)}">Добавить в чат</button>`;
      const deletion = workspaceDeleteMarkup(state, "saved", entry, mode);
      const copy = [
        `<button class="icon-button workspace-copy-button" type="button" data-action="copy-saved" data-id="${escapeHtml(entry.id)}" title="Скопировать сохранённый текст" aria-label="Скопировать сохранённый текст">`,
        `  <span class="workspace-copy-default">${COPY_ICON}</span>`,
        `  <span class="workspace-copy-success">${CHECK_ICON}</span>`,
        "</button>",
      ].join("");
      return [
        `<article class="workspace-card saved-card" data-saved-id="${escapeHtml(entry.id)}" data-workspace-delete-kind="saved" data-workspace-delete-id="${escapeHtml(entry.id)}">`,
        '  <div class="workspace-card-main">',
        local ? `    <span class="drag-handle" ${draggable ? 'draggable="true"' : ""} data-saved-drag-id="${escapeHtml(entry.id)}" title="${draggable ? "Перетащить" : "Порядок доступен без поиска"}">${DRAG_ICON}</span>` : "",
        `    <p class="saved-text">${escapeHtml(entry.text)}</p>`,
        "  </div>",
        `  <div class="workspace-card-footer saved-card-footer">${copy}<div class="workspace-card-actions">${action}${deletion.trash}</div></div>`,
        deletion.menu,
        "</article>",
      ].join("");
    }).join("");

    let empty = "";
    if (globalEmpty) empty = '<p class="empty-state">Введите запрос для глобального поиска.</p>';
    else if (!entries.length && mode === "local") empty = '<p class="empty-state">В этом чате пока нет сохранённого текста. Выделите текст и запустите назначенную в браузере команду «Сохранить выделенный текст» или используйте контекстное меню.</p>';
    else if (!entries.length) empty = '<p class="empty-state">По глобальному запросу ничего не найдено.</p>';

    return [
      unavailable,
      unavailable ? "" : [
      '<div class="workspace-toolbar">',
      modeToolbar("saved", requestedMode, query),
      `  <p class="analysis-counter">${entries.length} элементов</p>`,
      "</div>",
      cards ? `<div class="workspace-list saved-list">${cards}</div>` : empty,
      ].join(""),
    ].join("");
  }

  function styles() {
    return [
      ".workspace-toolbar { display: grid; margin-bottom: 12px; gap: 9px; }",
      ".workspace-mode { display: grid; grid-template-columns: 1fr 1fr; gap: 6px; }",
      ".workspace-mode-button { min-height: 32px; border: 1px solid var(--border); border-radius: 8px; background: var(--surface); color: var(--muted); cursor: pointer; }",
      ".workspace-mode-button.is-active { border-color: var(--accent); background: color-mix(in srgb, var(--accent) 14%, var(--surface)); color: var(--accent); }",
      ".workspace-search-wrap { position: relative; }",
      ".workspace-search { width: 100%; min-height: 36px; padding: 7px 34px 7px 9px; border: 1px solid var(--border); border-radius: 8px; background: var(--surface); color: var(--text); }",
      ".workspace-list { display: grid; gap: 9px; }",
      ".workspace-card { overflow: hidden; border: 1px solid var(--border); border-radius: 10px; background: color-mix(in srgb, var(--surface) 94%, transparent); }",
      ".workspace-card.is-dragging { opacity: .5; }",
      ".workspace-card-main { display: flex; padding: 10px; align-items: flex-start; gap: 6px; }",
      ".workspace-card-copy { min-width: 0; flex: 1; }",
      ".workspace-card-copy p { margin: 6px 0 0; }",
      ".workspace-card-footer { display: flex; padding: 0 10px 10px; align-items: center; justify-content: flex-end; flex-wrap: wrap; gap: 6px; }",
      ".saved-card-footer { align-items: flex-end; flex-wrap: nowrap; }",
      ".workspace-card-actions { display: flex; min-width: 0; margin-left: auto; align-items: center; justify-content: flex-end; flex-wrap: wrap; gap: 6px; }",
      ".workspace-card-action { min-height: 28px; padding: 4px 8px; font-size: 11px; }",
      ".workspace-attached { margin-right: auto; color: var(--muted); font-size: 11px; }",
      ".saved-card-footer .workspace-attached { margin-right: 0; }",
      ".workspace-copy-button { width: 28px; height: 28px; flex: 0 0 28px; border-color: var(--border); background: var(--surface); color: var(--muted); }",
      ".workspace-copy-button span { display: inline-grid; place-items: center; }",
      ".workspace-copy-button svg { width: 15px; height: 15px; }",
      ".workspace-copy-button .workspace-copy-success { display: none; }",
      ".workspace-copy-button.is-copied { border-color: color-mix(in srgb, var(--accent) 62%, var(--border)); background: color-mix(in srgb, var(--accent) 14%, var(--surface)); color: var(--accent); }",
      ".workspace-copy-button.is-copied .workspace-copy-default { display: none; }",
      ".workspace-copy-button.is-copied .workspace-copy-success { display: inline-grid; }",
      ".workspace-trash-button { width: 28px; height: 28px; flex: 0 0 28px; border-color: var(--border); background: var(--surface); color: var(--muted); }",
      ".workspace-trash-button svg { width: 15px; height: 15px; }",
      ".workspace-trash-button:hover, .workspace-trash-button:focus-visible, .workspace-trash-button.is-open { border-color: var(--danger); background: color-mix(in srgb, var(--danger) 10%, var(--surface)); color: var(--danger); }",
      ".workspace-delete-menu { display: grid; padding: 9px 10px 10px; gap: 7px; border-top: 1px solid var(--border); }",
      ".workspace-delete-title { color: var(--text); font-size: 12px; }",
      ".workspace-delete-actions { display: flex; justify-content: flex-end; gap: 6px; }",
      ".workspace-delete-actions .button { min-height: 28px; padding: 4px 9px; font-size: 11px; }",
      ".workspace-unavailable { display: grid; margin-bottom: 12px; padding: 10px; gap: 8px; border: 1px solid var(--danger); border-radius: 9px; background: color-mix(in srgb, var(--danger) 10%, var(--surface)); }",
      ".workspace-unavailable p { margin: 0; color: var(--text); font-size: 12px; }",
      ".saved-text { min-width: 0; margin: 0; flex: 1; overflow-wrap: anywhere; white-space: pre-wrap; }",
    ].join("\n");
  }

  function createClient(options) {
    function scope() {
      const value = options.getContext?.()?.scopeKey;
      if (!contract.isScopeKey(value)) throw new Error("Контекст чата ещё не готов.");
      return value;
    }

    function send(type, payload) {
      if (options.getStatus?.()?.status === "unavailable") {
        return Promise.resolve({
          ok: false,
          error: {
            code: "WORKSPACE_MIGRATION_FAILED",
            message: "Workspace недоступен. Новое изменение не применено.",
          },
        });
      }
      return options.send({ type, conversationScope: scope(), ...(payload || {}) });
    }

    function replaceGlossary(command) {
      const translation = contract.normalizeMeaning(
        command?.replacement?.translation ?? command?.proposed?.translation,
        200,
      );
      const definition = contract.normalizeMeaning(
        command?.replacement?.definition ?? command?.proposed?.definition,
        500,
      );
      const normalized = {
        senseId: command?.senseId || command?.entryId,
        expectedUpdatedAt: command?.expectedUpdatedAt,
        replacement: { translation, definition },
      };
      if (!contract.validEntityId(normalized.senseId)
        || !Number.isFinite(normalized.expectedUpdatedAt)
        || !translation
        || !definition) {
        return Promise.resolve({
          ok: false,
          error: { code: "REQUEST_CONTRACT_ERROR", message: "Запрос замены устарел или повреждён." },
        });
      }
      return send(contract.MESSAGE_TYPES.REPLACE_GLOSSARY_SENSE, { command: normalized });
    }

    return Object.freeze({
      queryGlossary: (mode, query) => send(contract.MESSAGE_TYPES.QUERY_GLOSSARY, { mode, query, limit: contract.MAX_QUERY_RESULTS }),
      lookupGlossarySelection: (text) => send(
        contract.MESSAGE_TYPES.LOOKUP_GLOSSARY_SELECTION,
        { text },
      ),
      attachGlossary: (senseId) => send(contract.MESSAGE_TYPES.ATTACH_GLOSSARY_SENSE, { senseId }),
      moveGlossary: (senseId, beforeSenseId) => send(contract.MESSAGE_TYPES.MOVE_GLOSSARY_LINK, { senseId, beforeSenseId }),
      unlinkGlossary: (senseId) => send(contract.MESSAGE_TYPES.UNLINK_GLOSSARY, { senseId }),
      deleteGlossary: (senseId) => send(contract.MESSAGE_TYPES.DELETE_GLOSSARY_SENSE, { senseId }),
      replaceGlossary,
      saveSelection: (text) => send(contract.MESSAGE_TYPES.SAVE_SELECTION, { text }),
      querySaved: (mode, query) => send(contract.MESSAGE_TYPES.QUERY_SAVED, { mode, query, limit: contract.MAX_QUERY_RESULTS }),
      moveSaved: (itemId, beforeItemId) => send(contract.MESSAGE_TYPES.MOVE_SAVED_LINK, { itemId, beforeItemId }),
      unlinkSaved: (itemId) => send(contract.MESSAGE_TYPES.UNLINK_SAVED, { itemId }),
      deleteSaved: (itemId) => send(contract.MESSAGE_TYPES.DELETE_SAVED_ITEM, { itemId }),
    });
  }

  root.ChatGPTHelperWorkspaceUi = Object.freeze({
    escapeHtml,
    normalizeGlossaryEntries,
    normalizeSavedEntries,
    unavailableMarkup,
    activeSearchMode,
    requestedModeAfterQueryInput,
    closedWorkspaceDeleteState,
    workspaceDeleteOwns,
    workspaceDeleteMenuOpen,
    transitionWorkspaceDelete,
    workspaceDeleteOperation,
    workspaceDeleteLocalAvailable,
    workspaceDeletePointerInside,
    workspaceDeleteEntryPresent,
    isCurrentWorkspaceRequest,
    nextSidebarPhase,
    quickActionStateForPhase,
    createTransformTransitionController,
    recentTemplatesForDisplay,
    previewPosition,
    previewAnchorFromTarget,
    glossaryMarkup,
    savedMarkup,
    styles,
    createClient,
  });
  if (typeof module === "object" && module.exports) module.exports = root.ChatGPTHelperWorkspaceUi;
})(typeof globalThis !== "undefined" ? globalThis : this);
