(function initAnalysisController(root) {
  "use strict";

  if (root.ChatGPTHelperAnalysisController) return;
  const contract = root.ChatGPTHelperAnalysisContract;
  const MESSAGES = contract.MESSAGE_TYPES;
  const ALLOWED_TRIGGERS = new Set(["browser-command", "context-menu", "inline-assistant"]);

  function create(options) {
    let activeRequestId = null;

    async function send(message) {
      return chrome.runtime.sendMessage(message);
    }

    async function start(rawText, trigger, pageUrl) {
      if (!ALLOWED_TRIGGERS.has(trigger)) {
        return { ok: false, error: contract.makeError("REQUEST_CONTRACT_ERROR") };
      }
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

    function handleMessage(message) {
      if (message?.type !== MESSAGES.KEY_STATUS_CHANGED) return false;
      if (typeof message.configured === "boolean") options.onKeyStatusChanged?.(message.configured);
      return false;
    }

    async function getKeyStatus() {
      const response = await send({ type: MESSAGES.GET_KEY_STATUS });
      return response?.ok ? response.configured === true : false;
    }

    async function openOptions(section) {
      return send({ type: MESSAGES.OPEN_OPTIONS, ...(section === "backup" ? { section: "backup" } : {}) });
    }

    chrome.runtime.onMessage.addListener(handleMessage);
    return Object.freeze({
      start,
      isActive: () => Boolean(activeRequestId),
      getKeyStatus,
      openOptions,
    });
  }

  root.ChatGPTHelperAnalysisController = Object.freeze({ ALLOWED_TRIGGERS, create });
})(globalThis);
