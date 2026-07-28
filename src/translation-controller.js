(function initTranslationController(root) {
  "use strict";

  if (root.ChatGPTHelperTranslationController) return;
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
        const error = contract.makeError("AI_OPERATION_ALREADY_RUNNING");
        options.onHint?.(error.message);
        return { ok: false, error };
      }
      const selection = contract.validateSelection(rawText);
      if (!selection.ok) {
        options.onHint?.(selection.error.message);
        return { ok: false, error: selection.error };
      }
      const snapshot = Object.freeze({
        requestId: contract.createId("translation"),
        trigger,
        text: selection.text,
        pageUrl: String(pageUrl || root.location.href),
        createdAt: Date.now(),
      });
      activeRequestId = snapshot.requestId;
      options.onBusyChange?.(true);
      options.onLoading?.();
      try {
        const response = await send({ type: MESSAGES.TRANSLATE_SELECTED_TEXT, snapshot });
        const currentPageUrl = String(root.location?.href || snapshot.pageUrl);
        if (snapshot.requestId !== activeRequestId
          || response?.requestId !== activeRequestId
          || currentPageUrl !== snapshot.pageUrl) {
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

    function cancel() {
      if (!activeRequestId) return false;
      activeRequestId = null;
      options.onBusyChange?.(false);
      options.onLoadingEnd?.();
      return true;
    }

    return Object.freeze({
      start,
      cancel,
      isActive: () => Boolean(activeRequestId),
    });
  }

  root.ChatGPTHelperTranslationController = Object.freeze({ ALLOWED_TRIGGERS, create });
})(globalThis);
