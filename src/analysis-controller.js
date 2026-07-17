(function initAnalysisController(root) {
  "use strict";

  if (root.ChatGPTHelperAnalysisController) return;
  const contract = root.ChatGPTHelperAnalysisContract;
  const MESSAGES = contract.MESSAGE_TYPES;
  const TEXT_ENTRY_SELECTOR = "input, textarea, select, [contenteditable='true'], [contenteditable=''], [role='textbox']";

  function isTextEntryTarget(target) {
    if (!target || typeof target.closest !== "function") return false;
    try {
      return Boolean(target.closest(TEXT_ENTRY_SELECTOR));
    } catch (_) {
      return false;
    }
  }

  function isTextEntryEvent(event) {
    if (typeof event?.composedPath === "function") {
      try {
        const path = event.composedPath();
        if (Array.isArray(path) && path.some(isTextEntryTarget)) return true;
      } catch (_) {
        // Fall through to the retargeted event target when the path cannot be read.
      }
    }
    return isTextEntryTarget(event?.target);
  }

  function shortcutFromEvent(event) {
    return {
      enabled: true,
      code: event.code,
      ctrl: event.ctrlKey,
      shift: event.shiftKey,
      alt: event.altKey,
      meta: event.metaKey,
    };
  }

  function create(options) {
    let activeRequestId = null;
    let shortcutRecording = false;

    function setShortcutRecording(value) {
      shortcutRecording = value === true;
    }

    async function send(message) {
      return chrome.runtime.sendMessage(message);
    }

    async function start(rawText, trigger, pageUrl) {
      if (activeRequestId) {
        options.onHint?.(contract.ERROR_MESSAGES.ANALYSIS_ALREADY_RUNNING);
        return { ok: false, error: contract.makeError("ANALYSIS_ALREADY_RUNNING") };
      }
      const selection = contract.validateSelection(rawText);
      if (!selection.ok) {
        options.onHint?.(selection.error.message);
        return { ok: false, error: selection.error };
      }
      const snapshot = Object.freeze({
        requestId: contract.createId("analysis"),
        trigger,
        text: selection.text,
        pageUrl: String(pageUrl || root.location.href),
        createdAt: Date.now(),
      });
      activeRequestId = snapshot.requestId;
      options.onBusyChange?.(true);
      options.onLoading?.();
      try {
        const response = await send({ type: MESSAGES.ANALYZE_SELECTED_TERMS, snapshot });
        if (snapshot.requestId !== activeRequestId || response?.requestId !== activeRequestId) {
          return { ok: false, ignored: true };
        }
        if (!response?.ok) {
          options.onError?.(response?.error || contract.makeError("PROVIDER_ERROR"));
          return response;
        }
        options.onResult?.(response);
        return response;
      } catch (_) {
        const error = contract.makeError("NETWORK_ERROR");
        if (snapshot.requestId === activeRequestId) options.onError?.(error);
        return { ok: false, requestId: snapshot.requestId, error };
      } finally {
        if (snapshot.requestId === activeRequestId) {
          activeRequestId = null;
          options.onBusyChange?.(false);
          options.onLoadingEnd?.();
        }
      }
    }

    function handleKeydown(event) {
      if (shortcutRecording) {
        if (event.key === "Escape") {
          event.preventDefault();
          event.stopPropagation();
          shortcutRecording = false;
          options.onShortcutRecordingCancelled?.();
          return;
        }
        if (contract.MODIFIER_CODES.has(event.code)) return;
        event.preventDefault();
        event.stopPropagation();
        const validation = contract.validateShortcutCandidate(shortcutFromEvent(event));
        if (!validation.ok) {
          options.onShortcutCandidate?.(validation);
          return;
        }
        shortcutRecording = false;
        options.onShortcutCandidate?.(validation);
        return;
      }

      if (event.key === "Escape" && options.handleEscapeLayer?.()) {
        event.preventDefault();
        event.stopPropagation();
        return;
      }
      if (event.repeat || isTextEntryEvent(event)) return;
      const shortcut = options.getShortcut?.();
      if (!contract.shortcutMatches(event, shortcut)) return;
      event.preventDefault();
      event.stopPropagation();
      if (activeRequestId) {
        options.onHint?.(contract.ERROR_MESSAGES.ANALYSIS_ALREADY_RUNNING);
        return;
      }
      void start(root.getSelection?.().toString() || "", "shortcut", root.location.href);
    }

    function handleMessage(message, _sender, sendResponse) {
      if (message?.type === MESSAGES.KEY_STATUS_CHANGED) {
        if (typeof message.configured === "boolean") options.onKeyStatusChanged?.(message.configured);
        return false;
      }
      if (message?.type !== MESSAGES.CONTEXT_MENU_SELECTION) return false;
      if (!contract.isSupportedUrl(message.pageUrl || "")) {
        sendResponse({ ok: false });
        return false;
      }
      void start(message.selectionText, "context-menu", message.pageUrl);
      sendResponse({ ok: true });
      return false;
    }

    async function getKeyStatus() {
      const response = await send({ type: MESSAGES.GET_KEY_STATUS });
      return response?.ok ? response.configured === true : false;
    }

    async function openOptions() {
      return send({ type: MESSAGES.OPEN_OPTIONS });
    }

    async function replaceGlossaryEntry(command) {
      return send({ type: MESSAGES.REPLACE_GLOSSARY_ENTRY, command });
    }

    async function moveGlossaryEntry(entryId, beforeEntryId) {
      return send({ type: MESSAGES.MOVE_GLOSSARY_ENTRY, entryId, beforeEntryId });
    }

    async function deleteGlossaryEntry(entryId) {
      return send({ type: MESSAGES.DELETE_GLOSSARY_ENTRY, entryId });
    }

    document.addEventListener("keydown", handleKeydown, true);
    chrome.runtime.onMessage.addListener(handleMessage);

    return Object.freeze({
      start,
      isActive: () => Boolean(activeRequestId),
      setShortcutRecording,
      getKeyStatus,
      openOptions,
      replaceGlossaryEntry,
      moveGlossaryEntry,
      deleteGlossaryEntry,
    });
  }

  root.ChatGPTHelperAnalysisController = Object.freeze({
    TEXT_ENTRY_SELECTOR,
    create,
    isTextEntryTarget,
    isTextEntryEvent,
    shortcutFromEvent,
  });
})(globalThis);
