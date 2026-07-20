(function initAnalysisUi(root) {
  "use strict";

  if (root.ChatGPTHelperAnalysisUi) return;
  const contract = root.ChatGPTHelperAnalysisContract;
  const workspaceContract = root.ChatGPTHelperWorkspaceContract;
  const DIALOG_HEADING_ID = "chatgpt-helper-analysis-dialog-title";
  const FOCUSABLE_SELECTOR = [
    "a[href]", "button:not([disabled])", "input:not([disabled])", "select:not([disabled])",
    "textarea:not([disabled])", "[tabindex]:not([tabindex='-1'])", "[contenteditable='true']",
    "[contenteditable='']", "[role='textbox']",
  ].join(", ");
  const DRAG_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 6h.01M15 6h.01M9 12h.01M15 12h.01M9 18h.01M15 18h.01"/></svg>';
  const TRASH_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 7h14m-9-3h4l1 3H9l1-3Zm-3 3 1 13h8l1-13M10 10v6m4-6v6"/></svg>';

  function escapeHtml(value) {
    return String(value ?? "")
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#039;");
  }

  function normalizeGlossaryEntries(value) {
    if (!Array.isArray(value)) return [];
    const ids = new Set();
    const terms = new Set();
    return value.flatMap((entry) => {
      if (!entry || typeof entry !== "object") return [];
      const term = typeof entry.term === "string" ? entry.term.trim() : "";
      const normalizedTerm = contract.normalizeTerm(entry.normalizedTerm || term);
      const translation = typeof entry.translation === "string" ? entry.translation.trim() : "";
      const definition = typeof entry.definition === "string" ? entry.definition.trim() : "";
      const id = typeof entry.id === "string" ? entry.id : "";
      if (!id || !term || !normalizedTerm || !translation || !definition || ids.has(id) || terms.has(normalizedTerm)) return [];
      ids.add(id);
      terms.add(normalizedTerm);
      return [{ ...entry, id, term, normalizedTerm, translation, definition }];
    });
  }

  function glossaryTextSizeClass(baseClass, settingsValue) {
    const size = contract.normalizeAnalysisSettings(settingsValue).analysis.glossaryTextSize;
    return `${baseClass} size-${size}`;
  }

  function nextFocusableIndex(currentIndex, count, backwards) {
    if (!Number.isInteger(count) || count <= 0) return -1;
    if (!Number.isInteger(currentIndex) || currentIndex < 0 || currentIndex >= count) {
      return backwards ? count - 1 : 0;
    }
    return (currentIndex + (backwards ? -1 : 1) + count) % count;
  }

  function replacementCommandForTerm(term) {
    const candidate = term?.replacementCandidate;
    if (term?.status !== "duplicate" || candidate?.status !== "single"
      || typeof candidate.targetSenseId !== "string" || !candidate.targetSenseId
      || typeof candidate.newSenseId !== "string" || !candidate.newSenseId
      || !Number.isFinite(candidate.expectedUpdatedAt)) return null;
    return Object.freeze({
      entryId: candidate.targetSenseId,
      sourceSenseId: candidate.newSenseId,
      expectedUpdatedAt: candidate.expectedUpdatedAt,
    });
  }

  function comparableReplacementText(value) {
    return String(value ?? "").normalize("NFKC").trim().replace(/\s+/g, " ").toLowerCase();
  }

  function refreshReplacementCandidate(term, current) {
    const candidate = term?.replacementCandidate;
    const sourceSenseId = candidate?.newSenseId;
    const targetSenseId = current?.senseId || current?.id;
    const currentTranslation = comparableReplacementText(current?.translation);
    const sourceTranslation = comparableReplacementText(term?.translation);
    const currentDefinition = comparableReplacementText(current?.definition);
    const sourceDefinition = comparableReplacementText(term?.definition);
    const compatibleConcept = !term?.conceptId || !current?.conceptId || term.conceptId === current.conceptId;
    const valid = candidate?.status === "single"
      && typeof sourceSenseId === "string" && Boolean(sourceSenseId)
      && typeof targetSenseId === "string" && Boolean(targetSenseId)
      && targetSenseId !== sourceSenseId
      && Number.isFinite(current?.updatedAt)
      && compatibleConcept
      && Boolean(currentTranslation) && currentTranslation === sourceTranslation
      && Boolean(currentDefinition) && currentDefinition !== sourceDefinition;

    if (current && typeof current === "object") term.savedEntry = current;
    if (!valid) {
      term.replacementCandidate = {
        status: "invalid",
        ...(typeof sourceSenseId === "string" && sourceSenseId ? { newSenseId: sourceSenseId } : {}),
      };
      return false;
    }
    term.replacementCandidate = {
      status: "single",
      targetSenseId,
      newSenseId: sourceSenseId,
      expectedUpdatedAt: current.updatedAt,
      current: {
        translation: current.translation,
        definition: current.definition,
      },
    };
    return true;
  }

  async function runReplacementAction(term, onReplace) {
    const command = replacementCommandForTerm(term);
    if (!command || typeof onReplace !== "function") return { status: "invalid", response: null };
    const response = await Promise.resolve(onReplace(command)).catch(() => null);
    if (response?.ok) {
      term.status = "replaced";
      term.savedEntry = response.entry;
      return { status: "replaced", response };
    }
    if (response?.error?.code === "GLOSSARY_ENTRY_CHANGED") {
      return {
        status: refreshReplacementCandidate(term, response.current) ? "stale" : "invalid",
        response,
      };
    }
    return { status: "error", response };
  }

  function styles() {
    return [
      ".analysis-key-row { display: flex; margin-bottom: 12px; padding: 9px 10px; align-items: center; justify-content: space-between; gap: 8px; border: 1px solid var(--border); border-radius: 9px; background: color-mix(in srgb, var(--surface) 90%, transparent); }",
      ".analysis-key-state { color: var(--muted); font-size: 12px; font-weight: 650; }",
      ".analysis-toolbar { position: sticky; top: -16px; z-index: 1; display: grid; margin: -2px -2px 12px; padding: 2px 2px 9px; gap: 8px; background: color-mix(in srgb, var(--bg) 94%, transparent); backdrop-filter: blur(5px); }",
      ".analysis-search-row { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 7px; }",
      ".analysis-search-wrap { position: relative; }",
      ".analysis-search { width: 100%; min-height: 36px; padding: 7px 34px 7px 9px; border: 1px solid var(--border); border-radius: 8px; background: var(--surface); color: var(--text); }",
      ".analysis-counter { margin: 0; color: var(--muted); font-size: 12px; }",
      ".glossary-list { display: grid; gap: 9px; }",
      ".glossary-list.size-compact { font-size: 12px; }",
      ".glossary-list.size-large { font-size: 15px; }",
      ".glossary-card { overflow: visible; border: 1px solid var(--border); border-radius: 10px; background: color-mix(in srgb, var(--surface) 94%, transparent); }",
      ".glossary-card.is-dragging { opacity: .5; }",
      ".glossary-main { display: grid; padding: 10px; grid-template-columns: auto minmax(0, 1fr) auto; align-items: start; gap: 7px; }",
      ".glossary-copy { min-width: 0; overflow-wrap: anywhere; }",
      ".glossary-term { color: var(--term-color, var(--accent)); font-weight: 750; }",
      ".glossary-translation { font-style: italic; }",
      ".glossary-definition { margin: 5px 0 0; color: var(--text); }",
      ".glossary-delete-confirm { display: flex; padding: 8px 10px; align-items: center; justify-content: space-between; gap: 8px; border-top: 1px solid var(--border); color: var(--muted); }",
      ".appearance-grid { display: grid; gap: 8px; }",
      ".color-row, .size-row { display: flex; flex-wrap: wrap; align-items: center; gap: 9px; }",
      ".color-row input[type='color'] { width: 44px; height: 32px; padding: 2px; border: 1px solid var(--border); border-radius: 7px; background: var(--surface); }",
      ".size-row select { min-height: 34px; padding: 5px 8px; border: 1px solid var(--border); border-radius: 7px; background: var(--surface); color: var(--text); }",
      ".glossary-preview { padding: 10px; border: 1px solid var(--border); border-radius: 9px; background: var(--surface); }",
      ".glossary-preview.size-compact { font-size: 12px; }",
      ".glossary-preview.size-large { font-size: 15px; }",
      ".analysis-transient { position: fixed; top: 18px; left: 50%; z-index: 12; max-width: calc(100vw - 32px); transform: translateX(-50%); pointer-events: auto; }",
      ".analysis-loading, .analysis-toast { padding: 9px 13px; border: 1px solid var(--border); border-radius: 999px; background: var(--surface); color: var(--text); box-shadow: var(--shadow); font-weight: 650; }",
      ".analysis-loading::before { content: ''; display: inline-block; width: 9px; height: 9px; margin-right: 8px; border: 2px solid color-mix(in srgb, var(--accent) 35%, transparent); border-top-color: var(--accent); border-radius: 50%; animation: analysis-spin .8s linear infinite; }",
      "@keyframes analysis-spin { to { transform: rotate(360deg); } }",
      ".analysis-backdrop { position: fixed; inset: 0; z-index: 11; display: flex; padding: 32px 16px; align-items: flex-start; justify-content: center; background: color-mix(in srgb, var(--bg) 22%, transparent); pointer-events: auto; }",
      ".analysis-dialog { position: relative; width: var(--analysis-dialog-width, 560px); max-height: calc(100vh - 64px); overflow: hidden; border: 1px solid var(--border); border-radius: 14px; background: var(--bg); color: var(--text); box-shadow: var(--shadow); container-type: inline-size; }",
      ".analysis-dialog-wallpaper { position: absolute; inset: 0; border-radius: inherit; background-position: center; background-size: cover; opacity: .34; pointer-events: none; }",
      ".analysis-dialog-scrim { position: absolute; inset: 0; border-radius: inherit; background: color-mix(in srgb, var(--bg) 88%, transparent); pointer-events: none; }",
      ".analysis-dialog-content { position: relative; z-index: 1; max-height: calc(100vh - 66px); overflow-y: auto; padding: 16px; scrollbar-width: thin; scrollbar-color: var(--scrollbar-thumb) var(--scrollbar-track); scrollbar-gutter: stable; }",
      ".analysis-dialog-content::-webkit-scrollbar { width: 10px; height: 10px; }",
      ".analysis-dialog-content::-webkit-scrollbar-track { background: var(--scrollbar-track); }",
      ".analysis-dialog-content::-webkit-scrollbar-thumb { border: 2px solid var(--scrollbar-track); border-radius: 999px; background: var(--scrollbar-thumb); }",
      ".analysis-dialog-content::-webkit-scrollbar-thumb:hover { background: var(--scrollbar-thumb-hover); }",
      ".analysis-dialog-content::-webkit-scrollbar-corner { background: var(--scrollbar-corner); }",
      ".analysis-dialog-resize { position: absolute; top: 0; bottom: 0; z-index: 4; width: 10px; cursor: ew-resize; touch-action: none; outline: 0; }",
      ".analysis-dialog-resize.left { left: 0; }",
      ".analysis-dialog-resize.right { right: 0; }",
      ".analysis-dialog-resize::after { content: ''; position: absolute; top: 0; bottom: 0; left: 4px; width: 1px; background: transparent; }",
      ".analysis-dialog-resize:hover::after, .analysis-dialog-resize:focus-visible::after, .analysis-dialog-resize.is-resizing::after { background: var(--accent); }",
      ".analysis-dialog-header { display: flex; margin-bottom: 12px; align-items: center; justify-content: space-between; gap: 10px; }",
      ".analysis-dialog-title { margin: 0; font-size: 16px; }",
      ".analysis-dialog-close { width: 30px; height: 30px; border: 0; border-radius: 7px; background: transparent; color: var(--muted); cursor: pointer; }",
      ".analysis-dialog-close:hover { background: var(--surface-hover); color: var(--text); }",
      ".analysis-result-list { display: grid; gap: 9px; }",
      "@container (min-width: 680px) { .analysis-result-list { grid-template-columns: repeat(2, minmax(0, 1fr)); } }",
      ".analysis-result-list.size-compact { font-size: 12px; }",
      ".analysis-result-list.size-large { font-size: 15px; }",
      ".analysis-result-card { position: relative; padding: 10px; border: 1px solid var(--border); border-radius: 9px; background: color-mix(in srgb, var(--surface) 92%, transparent); }",
      ".analysis-result-card p { margin: 5px 0 0; overflow-wrap: anywhere; }",
      ".analysis-result-status { display: inline-block; margin-top: 7px; color: var(--muted); font-size: 11px; }",
      ".analysis-replace { position: absolute; top: 7px; right: 7px; display: inline-flex; width: 28px; height: 28px; padding: 0; align-items: center; justify-content: center; border: 1px solid var(--border); border-radius: 7px; background: var(--surface); color: var(--accent); cursor: pointer; font-weight: 800; line-height: 0; }",
      ".analysis-replace svg { display: block; width: 16px; height: 16px; }",
      ".analysis-duplicate-tooltip { position: absolute; top: 39px; right: 7px; z-index: 2; width: min(260px, calc(100vw - 64px)); padding: 9px; border: 1px solid var(--border); border-radius: 8px; background: var(--surface); color: var(--text); box-shadow: var(--shadow); font-size: 12px; }",
      ".analysis-warning { margin: 0 0 10px; color: var(--danger); font-size: 12px; }",
      ".analysis-dialog-message { margin: 0; color: var(--text); }",
      "@media (prefers-reduced-motion: reduce) { .analysis-loading::before { animation: none; } }",
    ].join("\n");
  }

  function analysisMarkup(state) {
    const entries = normalizeGlossaryEntries(state.glossaryEntries);
    const query = state.glossarySearch || "";
    const filtered = entries.filter((entry) => contract.matchesGlossarySearch(entry, query));
    const analysis = contract.normalizeAnalysisSettings(state.settings).analysis;
    const termColor = analysis.termColorMode === "custom" ? analysis.customTermColor : "var(--accent)";
    const count = query ? `Найдено: ${filtered.length} из ${entries.length}` : `${entries.length} терминов`;
    const keyOnboarding = !state.keyChecking && !state.keyConfigured
      ? [
        '<div class="analysis-key-row">',
        '  <span class="analysis-key-state">OpenRouter не подключён</span>',
        '  <button class="button" type="button" data-action="open-analysis-options">Настроить</button>',
        "</div>",
      ].join("")
      : "";
    const cards = filtered.map((entry) => {
      const confirming = state.glossaryConfirmDeleteId === entry.id;
      const dragTitle = query ? "Очистите поиск, чтобы изменить порядок" : "Перетащить термин";
      return [
        `<article class="glossary-card" data-glossary-id="${escapeHtml(entry.id)}">`,
        '  <div class="glossary-main">',
        `    <span class="drag-handle" ${query ? "" : 'draggable="true"'} data-glossary-drag-id="${escapeHtml(entry.id)}" title="${dragTitle}" aria-label="${dragTitle}" tabindex="0">${DRAG_ICON}</span>`,
        '    <div class="glossary-copy">',
        `      <div><strong class="glossary-term">${escapeHtml(entry.term)}</strong> <em class="glossary-translation">(«${escapeHtml(entry.translation)}»)</em></div>`,
        `      <p class="glossary-definition">${escapeHtml(entry.definition)}</p>`,
        "    </div>",
        state.glossaryDeleteMode ? `    <button class="icon-button text-danger" type="button" data-action="ask-glossary-delete" data-id="${escapeHtml(entry.id)}" title="Удалить термин" aria-label="Удалить термин">${TRASH_ICON}</button>` : "",
        "  </div>",
        confirming ? [
          '  <div class="glossary-delete-confirm">',
          "    <span>Удалить термин?</span>",
          '    <div class="confirm-actions">',
          '      <button class="button" type="button" data-action="cancel-glossary-delete">Нет</button>',
          `      <button class="button danger" type="button" data-action="confirm-glossary-delete" data-id="${escapeHtml(entry.id)}">Да</button>`,
          "    </div>",
          "  </div>",
        ].join("") : "",
        "</article>",
      ].join("");
    }).join("");

    let empty = "";
    if (!entries.length) {
      empty = '<p class="empty-state">Словарь пока пуст.<br><br>Выделите текст и используйте назначенную в браузере команду<br>или пункт «Разобрать английские термины» в контекстном меню.</p>';
    } else if (!filtered.length) {
      empty = '<p class="empty-state">По запросу ничего не найдено.</p>';
    }

    return [
      keyOnboarding,
      '<div class="analysis-toolbar">',
      '  <div class="analysis-search-row">',
      '    <div class="analysis-search-wrap">',
      `      <input class="analysis-search" type="search" data-action="glossary-search" placeholder="Поиск по словарю" value="${escapeHtml(query)}">`,
      "    </div>",
      `    <button class="compact-button${state.glossaryDeleteMode ? " is-active" : ""}" type="button" data-action="toggle-glossary-delete-mode" title="Режим удаления" aria-label="Режим удаления" aria-pressed="${state.glossaryDeleteMode ? "true" : "false"}">${TRASH_ICON}</button>`,
      "  </div>",
      `  <p class="analysis-counter">${count}</p>`,
      "</div>",
      cards ? `<div class="glossary-list size-${analysis.glossaryTextSize}" style="--term-color:${termColor}">${cards}</div>` : empty,
    ].join("");
  }

  function settingsMarkup(state) {
    const analysis = contract.normalizeAnalysisSettings(state.settings).analysis;
    const custom = analysis.termColorMode === "custom";
    return [
      '  <div class="appearance-grid">',
      '    <h4>Вид словаря</h4>',
      '    <div class="color-row">',
      `      <label><input type="radio" name="term-color-mode" data-action="analysis-term-color-mode" value="theme"${custom ? "" : " checked"}> Цвет темы</label>`,
      `      <label><input type="radio" name="term-color-mode" data-action="analysis-term-color-mode" value="custom"${custom ? " checked" : ""}> Свой цвет</label>`,
      `      <input type="color" data-action="analysis-custom-term-color" value="${analysis.customTermColor}" aria-label="Свой цвет термина"${custom ? "" : " disabled"}>`,
      "    </div>",
      '    <label class="size-row"><span>Размер текста</span><select data-action="analysis-text-size">',
      `      <option value="compact"${analysis.glossaryTextSize === "compact" ? " selected" : ""}>Компактный</option>`,
      `      <option value="normal"${analysis.glossaryTextSize === "normal" ? " selected" : ""}>Обычный</option>`,
      `      <option value="large"${analysis.glossaryTextSize === "large" ? " selected" : ""}>Крупный</option>`,
      "    </select></label>",
      `    <div class="glossary-preview size-${analysis.glossaryTextSize}" style="--term-color:${custom ? analysis.customTermColor : "var(--accent)"}"><strong class="glossary-term">source of truth</strong> <em class="glossary-translation">(«источник истины»)</em><p class="glossary-definition">Единственный авторитетный источник данных или правил.</p></div>`,
      '    <button class="button" type="button" data-action="reset-analysis-appearance">Сбросить вид словаря</button>',
      "  </div>",
    ].join("");
  }

  function create(options) {
    let loading = null;
    let toast = null;
    let backdrop = null;
    let openTooltip = null;
    let previouslyFocused = null;
    let toastTimer = null;
    let dialogCleanup = null;
    let dialogResizing = false;

    function shell() {
      return options.getShell();
    }

    function removeToast() {
      if (toastTimer) clearTimeout(toastTimer);
      toastTimer = null;
      toast?.remove();
      toast = null;
    }

    function hideLoading() {
      loading?.remove();
      loading = null;
    }

    function currentFocusedElement() {
      const rootNode = shell()?.getRootNode?.();
      return rootNode?.activeElement || document.activeElement || null;
    }

    function restorePreviousFocus() {
      const focusTarget = previouslyFocused;
      previouslyFocused = null;
      if (!focusTarget?.isConnected || focusTarget.disabled === true || typeof focusTarget.focus !== "function") return;
      try {
        focusTarget.focus({ preventScroll: true });
      } catch (_) {
        focusTarget.focus();
      }
    }

    function closeDialog(restoreFocus) {
      openTooltip = null;
      dialogCleanup?.();
      dialogCleanup = null;
      dialogResizing = false;
      backdrop?.remove();
      backdrop = null;
      if (restoreFocus !== false) restorePreviousFocus();
    }

    function closeTooltip() {
      if (!openTooltip) return false;
      openTooltip.hidden = true;
      openTooltip = null;
      return true;
    }

    function handleEscape() {
      if (closeTooltip()) return true;
      if (backdrop) {
        closeDialog();
        return true;
      }
      return false;
    }

    function showLoading() {
      closeDialog();
      removeToast();
      hideLoading();
      loading = document.createElement("div");
      loading.className = "analysis-transient analysis-loading";
      loading.setAttribute("role", "status");
      loading.textContent = "Анализируем выделенный текст…";
      shell()?.appendChild(loading);
    }

    function showHint(text) {
      removeToast();
      toast = document.createElement("div");
      toast.className = "analysis-transient analysis-toast";
      toast.setAttribute("role", "status");
      toast.textContent = text;
      shell()?.appendChild(toast);
      toastTimer = setTimeout(removeToast, 2800);
    }

    function installDialogResizers(dialog, handles) {
      let preferred = workspaceContract.clampPreferredWidth(
        "analysisDialogWidth",
        options.getSettings().layout?.analysisDialogWidth,
      );
      let drag = null;
      let previousUserSelect = "";

      function update() {
        const effective = workspaceContract.effectiveWidth("analysisDialogWidth", preferred, window.innerWidth);
        dialog.style.setProperty("--analysis-dialog-width", `${effective}px`);
        handles.forEach((handle) => handle.setAttribute("aria-valuenow", String(effective)));
      }

      function finish(commit) {
        if (!drag) return;
        const currentDrag = drag;
        drag = null;
        dialogResizing = false;
        document.documentElement.style.userSelect = previousUserSelect;
        currentDrag.handle.classList.remove("is-resizing");
        try {
          if (currentDrag.handle.hasPointerCapture?.(currentDrag.pointerId)) {
            currentDrag.handle.releasePointerCapture(currentDrag.pointerId);
          }
        } catch (_) {}
        if (!commit) preferred = currentDrag.startWidth;
        update();
        if (commit) void options.onDialogWidthChange?.(preferred);
      }

      handles.forEach((handle) => {
        handle.addEventListener("pointerdown", (event) => {
          if (event.button !== 0 || drag) return;
          event.preventDefault();
          previousUserSelect = document.documentElement.style.userSelect;
          document.documentElement.style.userSelect = "none";
          drag = {
            handle,
            edge: handle.dataset.edge,
            pointerId: event.pointerId,
            startX: event.clientX,
            startWidth: preferred,
          };
          dialogResizing = true;
          handle.classList.add("is-resizing");
          handle.setPointerCapture?.(event.pointerId);
        });
        handle.addEventListener("pointermove", (event) => {
          if (!drag || drag.handle !== handle || event.pointerId !== drag.pointerId) return;
          preferred = workspaceContract.resizePreferredWidth(
            "analysisDialogWidth",
            drag.startWidth,
            event.clientX - drag.startX,
            drag.edge,
          );
          update();
        });
        handle.addEventListener("pointerup", (event) => {
          if (drag?.handle === handle && event.pointerId === drag.pointerId) finish(true);
        });
        handle.addEventListener("pointercancel", () => finish(false));
        handle.addEventListener("lostpointercapture", () => { if (drag?.handle === handle) finish(true); });
        handle.addEventListener("dblclick", (event) => {
          event.preventDefault();
          preferred = workspaceContract.LAYOUT.analysisDialogWidth.default;
          update();
          void options.onDialogWidthChange?.(preferred);
        });
        handle.addEventListener("keydown", (event) => {
          const step = event.shiftKey ? 50 : 10;
          let next = null;
          if (event.key === "ArrowLeft") next = preferred - step;
          else if (event.key === "ArrowRight") next = preferred + step;
          else if (event.key === "Home") next = workspaceContract.LAYOUT.analysisDialogWidth.min;
          else if (event.key === "End") next = workspaceContract.LAYOUT.analysisDialogWidth.max;
          else if (event.key === "Enter") next = preferred;
          if (next === null) return;
          event.preventDefault();
          preferred = workspaceContract.clampPreferredWidth("analysisDialogWidth", next);
          update();
          void options.onDialogWidthChange?.(preferred);
        });
      });
      const onViewportResize = () => update();
      window.addEventListener("resize", onViewportResize);
      update();
      return () => {
        if (drag) finish(false);
        window.removeEventListener("resize", onViewportResize);
      };
    }

    function dialogFrame(title) {
      const focusOrigin = backdrop ? previouslyFocused : currentFocusedElement();
      closeDialog(false);
      previouslyFocused = focusOrigin;
      hideLoading();
      backdrop = document.createElement("div");
      backdrop.className = "analysis-backdrop";
      const dialog = document.createElement("section");
      dialog.className = "analysis-dialog";
      const analysisSettings = contract.normalizeAnalysisSettings(options.getSettings()).analysis;
      if (analysisSettings.termColorMode === "custom") {
        dialog.style.setProperty("--term-color", analysisSettings.customTermColor);
      }
      dialog.setAttribute("role", "dialog");
      dialog.setAttribute("aria-modal", "true");
      dialog.setAttribute("aria-labelledby", DIALOG_HEADING_ID);
      const resizeHandles = ["left", "right"].map((edge) => {
        const handle = document.createElement("div");
        handle.className = `analysis-dialog-resize ${edge}`;
        handle.dataset.edge = edge;
        handle.tabIndex = 0;
        handle.setAttribute("role", "separator");
        handle.setAttribute("aria-label", `Изменить ширину окна анализа (${edge === "left" ? "слева" : "справа"})`);
        handle.setAttribute("aria-orientation", "vertical");
        handle.setAttribute("aria-valuemin", String(workspaceContract.LAYOUT.analysisDialogWidth.min));
        handle.setAttribute("aria-valuemax", String(workspaceContract.LAYOUT.analysisDialogWidth.max));
        return handle;
      });
      const wallpaper = document.createElement("div");
      wallpaper.className = "analysis-dialog-wallpaper";
      const dataUrl = options.getSettings().wallpaperDataUrl;
      if (typeof dataUrl === "string" && dataUrl.startsWith("data:image/")) wallpaper.style.backgroundImage = `url(${JSON.stringify(dataUrl)})`;
      const scrim = document.createElement("div");
      scrim.className = "analysis-dialog-scrim";
      const content = document.createElement("div");
      content.className = "analysis-dialog-content";
      const header = document.createElement("header");
      header.className = "analysis-dialog-header";
      const heading = document.createElement("h2");
      heading.id = DIALOG_HEADING_ID;
      heading.className = "analysis-dialog-title";
      heading.textContent = title;
      const close = document.createElement("button");
      close.className = "analysis-dialog-close";
      close.type = "button";
      close.setAttribute("aria-label", "Закрыть");
      close.textContent = "×";
      close.addEventListener("click", closeDialog);
      const body = document.createElement("div");
      header.append(heading, close);
      content.append(header, body);
      dialog.append(wallpaper, scrim, ...resizeHandles, content);
      backdrop.appendChild(dialog);
      backdrop.addEventListener("pointerdown", (event) => { if (event.target === backdrop && !dialogResizing) closeDialog(); });
      dialog.addEventListener("keydown", (event) => {
        if (event.key !== "Tab") return;
        const focusable = Array.from(dialog.querySelectorAll(FOCUSABLE_SELECTOR)).filter((element) => (
          !element.hidden
          && element.getAttribute("aria-hidden") !== "true"
          && typeof element.focus === "function"
          && (typeof element.getClientRects !== "function" || element.getClientRects().length > 0)
        ));
        const activeElement = dialog.getRootNode()?.activeElement || document.activeElement;
        const nextIndex = nextFocusableIndex(focusable.indexOf(activeElement), focusable.length, event.shiftKey);
        if (nextIndex < 0) return;
        event.preventDefault();
        focusable[nextIndex].focus();
      });
      shell()?.appendChild(backdrop);
      dialogCleanup = installDialogResizers(dialog, resizeHandles);
      close.focus();
      return body;
    }

    function appendTermText(container, term) {
      const line = document.createElement("div");
      const strong = document.createElement("strong");
      strong.className = "glossary-term";
      strong.textContent = term.term;
      const translation = document.createElement("em");
      translation.className = "glossary-translation";
      translation.textContent = ` («${term.translation}»)`;
      line.append(strong, translation);
      const definition = document.createElement("p");
      definition.textContent = term.definition;
      container.append(line, definition);
    }

    function updateTooltip(tooltip, savedEntry) {
      tooltip.replaceChildren();
      const label = document.createElement("strong");
      label.textContent = "Сохранено сейчас";
      const translation = document.createElement("div");
      translation.textContent = `«${savedEntry?.translation || ""}»`;
      const definition = document.createElement("div");
      definition.textContent = savedEntry?.definition || "";
      tooltip.append(label, translation, definition);
    }

    function resultCard(term) {
      const card = document.createElement("article");
      card.className = "analysis-result-card";
      appendTermText(card, term);
      const status = document.createElement("span");
      status.className = "analysis-result-status";
      const labels = { new: "Добавлено", alreadySaved: "Уже сохранено", duplicate: "Есть другая версия", unsaved: "Не сохранено", replaced: "Заменено" };
      status.textContent = term.replacementCandidate?.status === "multiple"
        ? "Добавлено отдельно: найдено несколько вариантов"
        : (labels[term.status] || "");
      card.appendChild(status);

      if (replacementCommandForTerm(term) && term.savedEntry) {
        const replace = document.createElement("button");
        replace.type = "button";
        replace.className = "analysis-replace";
        replace.setAttribute("aria-label", "Заменить сохранённую версию");
        const arrow = document.createElementNS("http://www.w3.org/2000/svg", "svg");
        arrow.setAttribute("viewBox", "0 0 24 24");
        arrow.setAttribute("aria-hidden", "true");
        const arrowPath = document.createElementNS("http://www.w3.org/2000/svg", "path");
        arrowPath.setAttribute("d", "M5 12h13m-5-5 5 5-5 5");
        arrow.appendChild(arrowPath);
        replace.appendChild(arrow);
        const tooltip = document.createElement("div");
        tooltip.id = contract.createId("analysis-duplicate-tooltip");
        tooltip.className = "analysis-duplicate-tooltip";
        tooltip.hidden = true;
        tooltip.setAttribute("role", "tooltip");
        replace.setAttribute("aria-describedby", tooltip.id);
        updateTooltip(tooltip, term.savedEntry);
        const showTooltip = () => {
          if (openTooltip && openTooltip !== tooltip) openTooltip.hidden = true;
          tooltip.hidden = false;
          openTooltip = tooltip;
        };
        const hideTooltip = () => {
          tooltip.hidden = true;
          if (openTooltip === tooltip) openTooltip = null;
        };
        replace.addEventListener("pointerenter", showTooltip);
        replace.addEventListener("pointerleave", hideTooltip);
        replace.addEventListener("focus", showTooltip);
        replace.addEventListener("blur", hideTooltip);
        replace.addEventListener("click", async () => {
          if (replace.disabled) return;
          replace.disabled = true;
          const outcome = await runReplacementAction(term, options.onReplace);
          const response = outcome.response;
          if (outcome.status === "replaced") {
            status.textContent = labels.replaced;
            replace.remove();
            tooltip.remove();
            openTooltip = null;
            options.onGlossaryEntries?.(response.glossaryEntries);
          } else if (outcome.status === "stale") {
            updateTooltip(tooltip, response.current);
            status.textContent = response.error.message;
            replace.disabled = false;
            showTooltip();
          } else if (outcome.status === "invalid") {
            status.textContent = "Сохранённая версия изменилась. Быстрая замена больше недоступна.";
            replace.remove();
            tooltip.remove();
            if (openTooltip === tooltip) openTooltip = null;
          } else {
            status.textContent = response?.error?.message || contract.ERROR_MESSAGES.GLOSSARY_STORAGE_FAILED;
            replace.disabled = false;
          }
        });
        card.append(replace, tooltip);
      }
      return card;
    }

    function showResult(response) {
      const terms = Array.isArray(response.terms) ? response.terms : [];
      const body = dialogFrame(terms.length ? "Анализ текста" : "Результат анализа");
      if (response.storageWarning) {
        const warning = document.createElement("p");
        warning.className = "analysis-warning";
        warning.textContent = "Результат получен, но некоторые термины не удалось сохранить в словарь.";
        body.appendChild(warning);
      }
      if (!terms.length) {
        const empty = document.createElement("p");
        empty.className = "analysis-dialog-message";
        empty.textContent = "В выделенном тексте не найдено подходящих английских терминов.";
        body.appendChild(empty);
        return;
      }
      const list = document.createElement("div");
      list.className = glossaryTextSizeClass("analysis-result-list", options.getSettings());
      terms.forEach((term) => list.appendChild(resultCard(term)));
      body.appendChild(list);
    }

    function showError(error) {
      const body = dialogFrame("Не удалось выполнить анализ");
      const message = document.createElement("p");
      message.className = "analysis-dialog-message";
      message.textContent = error?.message || contract.ERROR_MESSAGES.PROVIDER_ERROR;
      body.appendChild(message);
      if (["API_KEY_MISSING", "API_KEY_INVALID"].includes(error?.code)) {
        const button = document.createElement("button");
        button.type = "button";
        button.className = "button primary";
        button.textContent = "Открыть настройки";
        button.addEventListener("click", () => { void options.onOpenOptions(); });
        body.appendChild(button);
      }
    }

    return Object.freeze({ showLoading, hideLoading, showHint, showResult, showError, closeDialog, handleEscape });
  }

  root.ChatGPTHelperAnalysisUi = Object.freeze({
    DIALOG_HEADING_ID,
    styles,
    analysisMarkup,
    settingsMarkup,
    normalizeGlossaryEntries,
    glossaryTextSizeClass,
    nextFocusableIndex,
    replacementCommandForTerm,
    refreshReplacementCandidate,
    runReplacementAction,
    create,
  });
})(globalThis);
