(function initAnalysisUi(root) {
  "use strict";

  if (root.ChatGPTHelperAnalysisUi) return;
  const contract = root.ChatGPTHelperAnalysisContract;
  const workspaceContract = root.ChatGPTHelperWorkspaceContract;
  const DIALOG_HEADING_ID = "chatgpt-helper-analysis-dialog-title";
  const INLINE_POPOVER_ID = "chatgpt-helper-inline-glossary-popover";
  const INLINE_VIEWPORT_MARGIN = 8;
  const INLINE_ANCHOR_GAP = 6;
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

  function normalizeInlineGlossaryEntries(value) {
    if (!Array.isArray(value)) return [];
    return value.flatMap((entry) => {
      if (!entry || typeof entry !== "object"
        || typeof entry.id !== "string" || !entry.id
        || typeof entry.term !== "string"
        || typeof entry.translation !== "string"
        || typeof entry.definition !== "string") return [];
      return [{
        id: entry.id,
        senseId: typeof entry.senseId === "string" ? entry.senseId : entry.id,
        conceptId: typeof entry.conceptId === "string" ? entry.conceptId : "",
        term: entry.term,
        canonicalTerm: typeof entry.canonicalTerm === "string" ? entry.canonicalTerm : entry.term,
        normalizedTerm: typeof entry.normalizedTerm === "string" ? entry.normalizedTerm : "",
        translation: entry.translation,
        definition: entry.definition,
        matchClass: ["exact", "contiguous", "full-token"].includes(entry.matchClass)
          ? entry.matchClass
          : "exact",
        attached: entry.attached === true,
        createdAt: Number(entry.createdAt) || 0,
        updatedAt: Number(entry.updatedAt) || 0,
      }];
    });
  }

  function normalizeInlineCandidate(value) {
    if (!value || typeof value !== "object"
      || typeof value.displayTerm !== "string" || !value.displayTerm.trim()
      || typeof value.normalizedKey !== "string" || !value.normalizedKey) return null;
    return {
      displayTerm: value.displayTerm.trim(),
      normalizedKey: value.normalizedKey,
      firstIndex: Number.isInteger(value.firstIndex) ? value.firstIndex : 0,
      tokenCount: Number.isInteger(value.tokenCount) ? value.tokenCount : 1,
      occurrences: Number.isInteger(value.occurrences) ? value.occurrences : 1,
      source: typeof value.source === "string" ? value.source : "token",
      visibility: value.visibility === "primary" ? "primary" : "lookup-only",
    };
  }

  function normalizeInlineGlossaryResult(value) {
    const result = value && typeof value === "object" ? value : {};
    const groups = (Array.isArray(result.groups) ? result.groups : []).flatMap((group) => {
      const candidate = normalizeInlineCandidate(group?.candidate);
      const entries = normalizeInlineGlossaryEntries(group?.entries);
      if (!candidate || !entries.length) return [];
      return [{
        candidate,
        matchClass: ["exact", "contiguous", "full-token"].includes(group.matchClass)
          ? group.matchClass
          : entries[0].matchClass,
        exactMissing: group.exactMissing === true,
        entries,
      }];
    });
    const missing = (Array.isArray(result.missing) ? result.missing : [])
      .map(normalizeInlineCandidate)
      .filter(Boolean);
    const totals = result.totals && typeof result.totals === "object" ? result.totals : {};
    return {
      groups,
      missing,
      totals: {
        candidateCountBeforeLimit: Math.max(
          groups.length + missing.length,
          Number(totals.candidateCountBeforeLimit) || 0,
        ),
        candidateCountReturned: Math.max(
          groups.length + missing.length,
          Number(totals.candidateCountReturned) || 0,
        ),
        matchedCandidateCount: Math.max(groups.length, Number(totals.matchedCandidateCount) || 0),
        matchedEntryCountBeforeLimit: Math.max(
          groups.reduce((sum, group) => sum + group.entries.length, 0),
          Number(totals.matchedEntryCountBeforeLimit) || 0,
        ),
        matchedEntryCountReturned: groups.reduce(
          (sum, group) => sum + group.entries.length,
          0,
        ),
      },
      truncated: {
        candidates: result.truncated?.candidates === true,
        entries: result.truncated?.entries === true,
      },
    };
  }

  function clampInlineCoordinate(value, minimum, maximum) {
    return Math.min(Math.max(value, minimum), Math.max(minimum, maximum));
  }

  function inlinePopoverPosition(anchorRectValue, surfaceSizeValue, viewportValue) {
    const anchorRect = anchorRectValue || {};
    const surfaceSize = surfaceSizeValue || {};
    const viewport = viewportValue || {};
    const viewportWidth = Math.max(0, Number(viewport.width) || 0);
    const viewportHeight = Math.max(0, Number(viewport.height) || 0);
    const preferredWidth = Math.max(0, Number(surfaceSize.width) || 360);
    const width = Math.max(0, Math.min(preferredWidth, viewportWidth - (INLINE_VIEWPORT_MARGIN * 2)));
    const maxHeight = Math.max(0, Math.min(420, viewportHeight * 0.6));
    const height = Math.max(0, Math.min(Number(surfaceSize.height) || 0, maxHeight));
    const left = clampInlineCoordinate(
      Number(anchorRect.left) || 0,
      INLINE_VIEWPORT_MARGIN,
      viewportWidth - INLINE_VIEWPORT_MARGIN - width,
    );
    const below = (Number(anchorRect.bottom) || 0) + INLINE_ANCHOR_GAP;
    const above = (Number(anchorRect.top) || 0) - INLINE_ANCHOR_GAP - height;
    let top;
    let placement;
    if (below + height <= viewportHeight - INLINE_VIEWPORT_MARGIN) {
      top = below;
      placement = "below";
    } else if (above >= INLINE_VIEWPORT_MARGIN) {
      top = above;
      placement = "above";
    } else {
      top = clampInlineCoordinate(
        below,
        INLINE_VIEWPORT_MARGIN,
        viewportHeight - INLINE_VIEWPORT_MARGIN - height,
      );
      placement = "clamped";
    }
    return Object.freeze({ left, top, width, maxHeight, placement });
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
    const proposed = candidate?.proposed || {
      translation: term?.translation,
      definition: term?.definition,
    };
    if (term?.status !== "replacementAvailable"
      || typeof candidate.targetSenseId !== "string" || !candidate.targetSenseId
      || !Number.isFinite(candidate.expectedUpdatedAt)
      || typeof proposed.translation !== "string" || !proposed.translation.trim()
      || typeof proposed.definition !== "string" || !proposed.definition.trim()) return null;
    return Object.freeze({
      senseId: candidate.targetSenseId,
      expectedUpdatedAt: candidate.expectedUpdatedAt,
      replacement: Object.freeze({
        translation: proposed.translation,
        definition: proposed.definition,
      }),
    });
  }

  function normalizedReplacementContent(value) {
    const translation = workspaceContract?.normalizeMeaning?.(value?.translation, 200);
    const definition = workspaceContract?.normalizeMeaning?.(value?.definition, 500);
    if (!translation || !definition) return null;
    return {
      translation: translation.toLocaleLowerCase("ru-RU"),
      definition: definition.toLocaleLowerCase("ru-RU"),
    };
  }

  function refreshReplacementCandidate(term, current) {
    if (current && typeof current === "object") term.savedEntry = current;
    const candidate = term?.replacementCandidate;
    const proposed = candidate?.proposed || {
      translation: term?.translation,
      definition: term?.definition,
    };
    const currentSenseId = typeof current?.senseId === "string" && current.senseId
      ? current.senseId
      : current?.id;
    const currentContent = normalizedReplacementContent(current);
    const proposedContent = normalizedReplacementContent(proposed);
    if (typeof currentSenseId !== "string" || !currentSenseId
      || !Number.isFinite(current?.updatedAt)
      || !currentContent || !proposedContent) {
      term.status = "conflict";
      return "conflict";
    }
    if (currentContent.translation === proposedContent.translation
      && currentContent.definition === proposedContent.definition) {
      term.status = "alreadySaved";
      term.replacementCandidate = null;
      return "alreadySaved";
    }
    term.status = "replacementAvailable";
    term.replacementCandidate = {
      ...candidate,
      targetSenseId: currentSenseId,
      expectedUpdatedAt: current.updatedAt,
      current: {
        translation: current.translation,
        definition: current.definition,
      },
      proposed: {
        translation: proposed.translation,
        definition: proposed.definition,
      },
    };
    return "replacementAvailable";
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
      return { status: refreshReplacementCandidate(term, response.current), response };
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
      ".inline-glossary-root { position: fixed; inset: 0; z-index: 10; color: var(--text); pointer-events: none; }",
      ".inline-glossary-live { position: absolute; width: 1px; height: 1px; margin: -1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; }",
      ".inline-glossary-trigger { position: fixed; display: inline-grid; width: 36px; height: 36px; min-height: 36px; padding: 0; place-items: center; border: 1px solid var(--border); border-radius: 50%; background: var(--surface); color: var(--text); box-shadow: var(--shadow); cursor: pointer; font: inherit; line-height: 0; pointer-events: auto; }",
      ".inline-glossary-trigger:hover { border-color: var(--accent); background: var(--surface-hover); }",
      ".inline-glossary-trigger:focus-visible, .inline-glossary-close:focus-visible, .inline-glossary-action:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }",
      ".inline-glossary-trigger svg { display: block; width: 18px; height: 18px; fill: none; stroke: currentColor; stroke-width: 1.8; stroke-linecap: round; stroke-linejoin: round; }",
      ".inline-glossary-popover { position: fixed; display: grid; width: min(360px, calc(100vw - 16px)); max-height: min(420px, 60vh); grid-template-rows: auto minmax(0, 1fr); overflow: hidden; border: 1px solid var(--border); border-radius: 12px; background: var(--bg); color: var(--text); box-shadow: var(--shadow); pointer-events: auto; }",
      ".inline-glossary-header { display: flex; padding: 9px 10px; align-items: center; justify-content: space-between; gap: 8px; border-bottom: 1px solid var(--border); }",
      ".inline-glossary-title { min-width: 0; overflow-wrap: anywhere; }",
      ".inline-glossary-close { display: inline-grid; width: 28px; height: 28px; flex: 0 0 28px; padding: 0; place-items: center; border: 0; border-radius: 7px; background: transparent; color: var(--muted); cursor: pointer; font: inherit; font-size: 18px; }",
      ".inline-glossary-close:hover { background: var(--surface-hover); color: var(--text); }",
      ".inline-glossary-body { min-height: 0; overflow-y: auto; overscroll-behavior: contain; padding: 10px; scrollbar-width: thin; scrollbar-color: var(--scrollbar-thumb) var(--scrollbar-track); }",
      ".inline-glossary-status, .inline-glossary-message, .inline-glossary-truncation { margin: 0; overflow-wrap: anywhere; }",
      ".inline-glossary-status, .inline-glossary-truncation { color: var(--muted); font-size: 12px; }",
      ".inline-glossary-list { display: grid; gap: 8px; }",
      ".inline-glossary-popover.is-many { width: min(420px, calc(100vw - 16px)); }",
      ".inline-glossary-group { display: grid; gap: 7px; padding: 9px; border: 1px solid var(--border); border-radius: 10px; background: color-mix(in srgb, var(--surface) 92%, transparent); }",
      ".inline-glossary-group-header { display: flex; align-items: baseline; justify-content: space-between; gap: 8px; }",
      ".inline-glossary-group-label { min-width: 0; overflow-wrap: anywhere; }",
      ".inline-glossary-match { flex: 0 0 auto; color: var(--muted); font-size: 11px; }",
      ".inline-glossary-section-title { display: block; color: var(--muted); font-size: 11px; }",
      ".inline-glossary-exact-missing { margin: 0; color: var(--muted); font-size: 12px; }",
      ".inline-glossary-missing-section { display: grid; gap: 7px; }",
      ".inline-glossary-missing { display: flex; padding: 8px 9px; align-items: center; justify-content: space-between; gap: 8px; border: 1px dashed var(--border); border-radius: 9px; }",
      ".inline-glossary-missing-label { min-width: 0; overflow-wrap: anywhere; }",
      ".inline-glossary-sense { padding: 9px; border: 1px solid var(--border); border-radius: 9px; background: var(--surface); overflow-wrap: anywhere; }",
      ".inline-glossary-sense p { margin: 5px 0 0; }",
      ".inline-glossary-scope { display: inline-block; margin-top: 7px; color: var(--muted); font-size: 11px; font-weight: 650; }",
      ".inline-glossary-truncation { margin-top: 9px; }",
      ".inline-glossary-actions { display: flex; margin-top: 10px; flex-wrap: wrap; justify-content: flex-end; gap: 7px; }",
      ".inline-glossary-action { min-height: 32px; padding: 6px 10px; border: 1px solid var(--border); border-radius: 8px; background: var(--surface); color: var(--text); cursor: pointer; font: inherit; font-size: 12px; }",
      ".inline-glossary-action.primary { border-color: var(--accent); background: var(--accent); color: var(--accent-contrast); }",
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
    let inlineRoot = null;
    let inlineTrigger = null;
    let inlinePopover = null;
    let inlineBody = null;
    let inlineTitle = null;
    let inlineClose = null;
    let inlineLive = null;
    let inlineSnapshot = null;
    let inlineHandlers = {};
    let inlinePhase = "closed";

    function shell() {
      return options.getShell();
    }

    function focusWithoutScroll(element) {
      if (!element?.isConnected || typeof element.focus !== "function") return;
      try {
        element.focus({ preventScroll: true });
      } catch (_) {
        element.focus();
      }
    }

    function ensureInlineRoot(snapshot, handlers) {
      inlineSnapshot = snapshot;
      inlineHandlers = handlers || {};
      if (inlineRoot?.isConnected) return inlineRoot;
      inlineRoot = document.createElement("div");
      inlineRoot.className = "inline-glossary-root";
      inlineRoot.setAttribute("data-inline-glossary-root", "");
      inlineTrigger = document.createElement("button");
      inlineTrigger.type = "button";
      inlineTrigger.className = "inline-glossary-trigger";
      inlineTrigger.setAttribute("aria-label", "Открыть словарь по выделению");
      inlineTrigger.setAttribute("title", "Словарь");
      inlineTrigger.setAttribute("aria-expanded", "false");
      inlineTrigger.setAttribute("aria-controls", INLINE_POPOVER_ID);
      const icon = document.createElementNS("http://www.w3.org/2000/svg", "svg");
      icon.setAttribute("viewBox", "0 0 24 24");
      icon.setAttribute("width", "18");
      icon.setAttribute("height", "18");
      icon.setAttribute("fill", "none");
      icon.setAttribute("stroke", "currentColor");
      icon.setAttribute("stroke-width", "1.8");
      icon.setAttribute("stroke-linecap", "round");
      icon.setAttribute("stroke-linejoin", "round");
      icon.setAttribute("aria-hidden", "true");
      icon.setAttribute("focusable", "false");
      const leftPage = document.createElementNS("http://www.w3.org/2000/svg", "path");
      leftPage.setAttribute("d", "M3.5 5.5c3-1.1 5.8-.5 8.5 1.4v11c-2.7-1.9-5.5-2.5-8.5-1.4v-11Z");
      const rightPage = document.createElementNS("http://www.w3.org/2000/svg", "path");
      rightPage.setAttribute("d", "M20.5 5.5c-3-1.1-5.8-.5-8.5 1.4v11c2.7-1.9 5.5-2.5 8.5-1.4v-11Z");
      icon.append(leftPage, rightPage);
      inlineTrigger.appendChild(icon);
      inlineTrigger.addEventListener("pointerdown", (event) => {
        if (event.button === 0) event.preventDefault();
      });
      inlineTrigger.addEventListener("click", () => {
        if (inlinePhase === "offering") inlineHandlers.onActivate?.();
      });
      inlineLive = document.createElement("span");
      inlineLive.className = "inline-glossary-live";
      inlineLive.setAttribute("role", "status");
      inlineLive.setAttribute("aria-live", "polite");
      inlineLive.setAttribute("aria-atomic", "true");
      inlineRoot.append(inlineTrigger, inlineLive);
      shell()?.appendChild(inlineRoot);
      return inlineRoot;
    }

    function ensureInlinePopover() {
      if (inlinePopover?.isConnected) return inlinePopover;
      inlinePopover = document.createElement("section");
      inlinePopover.id = INLINE_POPOVER_ID;
      inlinePopover.className = "inline-glossary-popover";
      inlinePopover.setAttribute("role", "region");
      inlinePopover.setAttribute("aria-label", "Словарь");
      const header = document.createElement("header");
      header.className = "inline-glossary-header";
      inlineTitle = document.createElement("strong");
      inlineTitle.className = "inline-glossary-title";
      inlineClose = document.createElement("button");
      inlineClose.type = "button";
      inlineClose.className = "inline-glossary-close";
      inlineClose.setAttribute("aria-label", "Закрыть словарь");
      inlineClose.textContent = "×";
      inlineClose.addEventListener("click", () => inlineHandlers.onClose?.());
      inlineBody = document.createElement("div");
      inlineBody.className = "inline-glossary-body";
      header.append(inlineTitle, inlineClose);
      inlinePopover.append(header, inlineBody);
      inlineRoot?.appendChild(inlinePopover);
      return inlinePopover;
    }

    function positionInline() {
      if (!inlineSnapshot?.anchorNode?.isConnected || !inlineSnapshot.anchorRect || !inlineTrigger) return false;
      const viewport = { width: window.innerWidth, height: window.innerHeight };
      const triggerRect = inlineTrigger.getBoundingClientRect?.() || { width: 36, height: 36 };
      const triggerVerticalPosition = inlinePopoverPosition(
        inlineSnapshot.anchorRect,
        { height: triggerRect.height || 36 },
        viewport,
      );
      const triggerPosition = {
        ...triggerVerticalPosition,
        left: clampInlineCoordinate(
          Number(inlineSnapshot.anchorRect.left) || 0,
          INLINE_VIEWPORT_MARGIN,
          viewport.width - INLINE_VIEWPORT_MARGIN - (triggerRect.width || 0),
        ),
      };
      inlineTrigger.style.left = `${triggerPosition.left}px`;
      inlineTrigger.style.top = `${triggerPosition.top}px`;
      if (inlinePopover && !inlinePopover.hidden) {
        const popoverRect = inlinePopover.getBoundingClientRect?.() || { height: 0 };
        const triggerAnchor = {
          top: triggerPosition.top,
          bottom: triggerPosition.top + (triggerRect.height || 36),
          left: triggerPosition.left,
        };
        const popoverPosition = inlinePopoverPosition(
          triggerAnchor,
          {
            height: popoverRect.height,
            width: inlinePopover.className.includes("is-many") ? 420 : 360,
          },
          viewport,
        );
        inlinePopover.style.left = `${popoverPosition.left}px`;
        inlinePopover.style.top = `${popoverPosition.top}px`;
        inlinePopover.style.width = `${popoverPosition.width}px`;
        inlinePopover.style.maxHeight = `${popoverPosition.maxHeight}px`;
        inlinePopover.dataset.placement = popoverPosition.placement;
      }
      return true;
    }

    function closeInline() {
      const consumed = inlinePhase !== "closed" || Boolean(inlineRoot);
      inlineRoot?.remove();
      inlineRoot = null;
      inlineTrigger = null;
      inlinePopover = null;
      inlineBody = null;
      inlineTitle = null;
      inlineClose = null;
      inlineLive = null;
      inlineSnapshot = null;
      inlineHandlers = {};
      inlinePhase = "closed";
      return consumed;
    }

    function showInlineOffer(snapshot, handlers) {
      ensureInlineRoot(snapshot, handlers);
      inlinePhase = "offering";
      inlineRoot.dataset.phase = inlinePhase;
      inlineTrigger.setAttribute("aria-expanded", "false");
      if (inlinePopover) inlinePopover.hidden = true;
      return positionInline();
    }

    function prepareInlineExpanded(snapshot, phase, handlers) {
      ensureInlineRoot(snapshot, handlers);
      ensureInlinePopover();
      inlinePhase = phase;
      inlineRoot.dataset.phase = phase;
      inlineTrigger.setAttribute("aria-expanded", "true");
      inlinePopover.className = "inline-glossary-popover";
      inlinePopover.hidden = false;
      inlineTitle.textContent = "Словарь по выделению";
      inlineBody.replaceChildren();
      return {
        finish() {
          return positionInline();
        },
      };
    }

    function appendInlineAction(container, text, className, action) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = `inline-glossary-action${className ? ` ${className}` : ""}`;
      button.textContent = text;
      button.addEventListener("click", action);
      container.appendChild(button);
      return button;
    }

    function showInlineLoading(snapshot, handlers) {
      const render = prepareInlineExpanded(snapshot, "loading", handlers);
      const status = document.createElement("p");
      status.className = "inline-glossary-status";
      status.setAttribute("role", "status");
      status.textContent = "Ищем в словаре…";
      inlineBody.appendChild(status);
      if (inlineLive) inlineLive.textContent = status.textContent;
      return render.finish();
    }

    function inlineSenseCard(entry) {
      const card = document.createElement("article");
      card.className = "inline-glossary-sense";
      const line = document.createElement("div");
      const term = document.createElement("strong");
      term.className = "glossary-term";
      term.textContent = entry.term;
      const translation = document.createElement("em");
      translation.className = "glossary-translation";
      translation.textContent = ` «${entry.translation}»`;
      line.append(term, translation);
      const definition = document.createElement("p");
      definition.textContent = entry.definition;
      const scope = document.createElement("span");
      scope.className = "inline-glossary-scope";
      scope.textContent = entry.attached ? "В этом чате" : "Общий словарь";
      card.append(line, definition, scope);
      return card;
    }

    function appendCandidateAction(container, candidate) {
      const button = appendInlineAction(
        container,
        "Разобрать",
        "primary",
        () => inlineHandlers.onAnalyze?.(candidate),
      );
      button.setAttribute("aria-label", `Разобрать ${candidate.displayTerm}`);
      return button;
    }

    function showInlineResult(snapshot, resultValue, handlers) {
      const render = prepareInlineExpanded(snapshot, "showing", handlers);
      const result = normalizeInlineGlossaryResult(resultValue);
      const candidateCount = result.groups.length + result.missing.length;
      inlinePopover.className = `inline-glossary-popover${candidateCount > 6 ? " is-many" : ""}`;
      const list = document.createElement("div");
      list.className = "inline-glossary-list";
      result.groups.forEach((group) => {
        const section = document.createElement("section");
        section.className = "inline-glossary-group";
        const header = document.createElement("div");
        header.className = "inline-glossary-group-header";
        const label = document.createElement("strong");
        label.className = "inline-glossary-group-label";
        label.textContent = group.candidate.displayTerm;
        const match = document.createElement("span");
        match.className = "inline-glossary-match";
        match.textContent = group.exactMissing ? "Связанное совпадение" : "Точное совпадение";
        header.append(label, match);
        const exactEntries = group.entries.filter((entry) => entry.matchClass === "exact");
        const relatedEntries = group.entries.filter((entry) => entry.matchClass !== "exact");
        const appendEntrySection = (titleText, entries) => {
          if (!entries.length) return;
          const title = document.createElement("strong");
          title.className = "inline-glossary-section-title";
          title.textContent = titleText;
          const senses = document.createElement("div");
          senses.className = "inline-glossary-list";
          entries.forEach((entry) => senses.appendChild(inlineSenseCard(entry)));
          section.append(title, senses);
        };
        const actions = group.candidate.visibility === "primary" && exactEntries.length === 0
          ? document.createElement("div")
          : null;
        if (actions) {
          actions.className = "inline-glossary-actions";
          appendCandidateAction(actions, group.candidate);
        }
        section.appendChild(header);
        appendEntrySection("Точное значение", exactEntries);
        appendEntrySection("Связанные записи", relatedEntries);
        if (group.exactMissing) {
          const missingExact = document.createElement("p");
          missingExact.className = "inline-glossary-exact-missing";
          missingExact.textContent = `Точного значения «${group.candidate.displayTerm}» нет.`;
          section.appendChild(missingExact);
        }
        if (actions) section.appendChild(actions);
        list.appendChild(section);
      });
      if (result.missing.length) {
        const missingSection = document.createElement("section");
        missingSection.className = "inline-glossary-missing-section";
        const missingTitle = document.createElement("strong");
        missingTitle.className = "inline-glossary-section-title";
        missingTitle.textContent = "Не найдено";
        missingSection.appendChild(missingTitle);
        result.missing.forEach((candidate) => {
          const row = document.createElement("div");
          row.className = "inline-glossary-missing";
          const label = document.createElement("span");
          label.className = "inline-glossary-missing-label";
          label.textContent = candidate.displayTerm;
          row.appendChild(label);
          if (candidate.visibility === "primary") {
            const actions = document.createElement("div");
            actions.className = "inline-glossary-actions";
            appendCandidateAction(actions, candidate);
            row.appendChild(actions);
          }
          missingSection.appendChild(row);
        });
        list.appendChild(missingSection);
      }
      if (!candidateCount) {
        const message = document.createElement("p");
        message.className = "inline-glossary-message";
        message.textContent = "В выделении не найдено английских технических терминов.";
        list.appendChild(message);
      }
      inlineBody.appendChild(list);
      if (result.truncated.candidates) {
        const truncation = document.createElement("p");
        truncation.className = "inline-glossary-truncation";
        truncation.textContent = `Показано ${result.totals.candidateCountReturned} из ${result.totals.candidateCountBeforeLimit} кандидатов.`;
        inlineBody.appendChild(truncation);
      }
      if (result.truncated.entries) {
        const truncation = document.createElement("p");
        truncation.className = "inline-glossary-truncation";
        truncation.textContent = `Показано ${result.totals.matchedEntryCountReturned} из ${result.totals.matchedEntryCountBeforeLimit} совпадений.`;
        inlineBody.appendChild(truncation);
      }
      if (inlineLive) {
        inlineLive.textContent = candidateCount
          ? `Словарь готов: ${result.groups.length} совпадений, ${result.missing.length} без совпадений.`
          : "Словарь готов: технические термины не найдены.";
      }
      return render.finish();
    }

    function showInlineError(snapshot, error, handlers) {
      const render = prepareInlineExpanded(snapshot, "error", handlers);
      const message = document.createElement("p");
      message.className = "inline-glossary-message";
      message.textContent = "Не удалось открыть словарь.";
      inlineBody.appendChild(message);
      if (typeof error?.message === "string" && error.message.trim()) {
        const detail = document.createElement("p");
        detail.className = "inline-glossary-status";
        detail.textContent = error.message;
        inlineBody.appendChild(detail);
      }
      const actions = document.createElement("div");
      actions.className = "inline-glossary-actions";
      appendInlineAction(actions, "Повторить", "", () => inlineHandlers.onRetry?.());
      inlineBody.appendChild(actions);
      if (inlineLive) inlineLive.textContent = "Не удалось открыть словарь.";
      return render.finish();
    }

    function handleInlineEscape() {
      if (inlinePhase === "closed") return false;
      inlineHandlers.onClose?.();
      return true;
    }

    function inlineSurfaceContains(surface, value) {
      if (!surface || !value) return false;
      if (surface === value) return true;
      if (typeof value.nodeType !== "number") return false;
      return surface.contains?.(value) === true;
    }

    function inlineContainsPath(pathValue) {
      const path = Array.isArray(pathValue) ? pathValue : [];
      return [inlineTrigger, inlinePopover].some((surface) => (
        surface
        && path.some((value) => inlineSurfaceContains(surface, value))
      ));
    }

    function inlineOwnsFocus() {
      const rootNode = shell()?.getRootNode?.();
      const activeElement = rootNode?.activeElement || document.activeElement || null;
      return Boolean(activeElement && [inlineTrigger, inlinePopover].some(
        (surface) => surface?.contains?.(activeElement),
      ));
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
      closeInline();
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
      closeInline();
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
      const labels = {
        new: "Добавлено",
        alreadySaved: "Уже сохранено",
        replacementAvailable: "Есть другая версия",
        unsaved: "Не сохранено",
        replaced: "Заменено",
        conflict: "Сохранённая версия изменилась. Проверьте её перед новой попыткой.",
      };
      status.textContent = labels[term.status] || "";
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
          } else if (outcome.status === "replacementAvailable") {
            status.textContent = labels.replacementAvailable;
            updateTooltip(tooltip, term.savedEntry);
            replace.disabled = false;
          } else if (outcome.status === "alreadySaved") {
            status.textContent = labels.alreadySaved;
            replace.remove();
            tooltip.remove();
            if (openTooltip === tooltip) openTooltip = null;
          } else if (outcome.status === "conflict" || outcome.status === "invalid") {
            status.textContent = labels.conflict;
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

    return Object.freeze({
      showLoading,
      hideLoading,
      showHint,
      showResult,
      showError,
      closeDialog,
      handleEscape,
      showInlineOffer,
      showInlineLoading,
      showInlineResult,
      showInlineError,
      closeInline,
      handleInlineEscape,
      inlineContainsPath,
      inlineOwnsFocus,
      positionInline,
    });
  }

  root.ChatGPTHelperAnalysisUi = Object.freeze({
    DIALOG_HEADING_ID,
    INLINE_POPOVER_ID,
    styles,
    analysisMarkup,
    settingsMarkup,
    normalizeGlossaryEntries,
    normalizeInlineGlossaryEntries,
    normalizeInlineGlossaryResult,
    inlinePopoverPosition,
    glossaryTextSizeClass,
    nextFocusableIndex,
    replacementCommandForTerm,
    refreshReplacementCandidate,
    runReplacementAction,
    create,
  });
})(globalThis);
