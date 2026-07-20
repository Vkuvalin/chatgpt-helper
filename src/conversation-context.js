(function initConversationContext(root) {
  "use strict";

  if (root.ChatGPTHelperConversationContext) return;

  const contract = root.ChatGPTHelperWorkspaceContract
    || (typeof require === "function" ? require("./workspace-contract.js") : null);

  function extractStableConversation(value) {
    try {
      const url = new URL(value);
      const host = url.hostname.toLocaleLowerCase("en-US");
      if (url.protocol !== "https:" || !contract.isSupportedHost(host)) return null;
      const segments = url.pathname.split("/").filter(Boolean);
      for (let index = 0; index < segments.length - 1; index += 1) {
        if (segments[index] !== "c") continue;
        let remoteConversationId;
        try {
          remoteConversationId = decodeURIComponent(segments[index + 1]);
        } catch (_) {
          return null;
        }
        if (!/^[A-Za-z0-9_-]{1,200}$/.test(remoteConversationId)) return null;
        return Object.freeze({
          kind: "stable",
          host,
          remoteConversationId,
          scopeKey: `stable:${host}:${remoteConversationId}`,
          canonicalUrl: `https://${host}/c/${encodeURIComponent(remoteConversationId)}`,
        });
      }
      return null;
    } catch (_) {
      return null;
    }
  }

  function isSupportedPage(value) {
    try {
      const url = new URL(value);
      return url.protocol === "https:" && contract.isSupportedHost(url.hostname);
    } catch (_) {
      return false;
    }
  }

  function contextChanged(previous, next) {
    return previous?.scopeKey !== next?.scopeKey;
  }

  function createClient(options) {
    let current = null;
    let lastUrl = "";
    let stopped = false;
    let intervalId = null;
    let requestToken = 0;
    let inFlight = null;
    let workspaceStatus = Object.freeze({
      status: "loading",
      context: null,
      errorCode: null,
      message: null,
    });

    const unavailableMessage = "Workspace не удалось инициализировать или мигрировать. Данные словаря V1 не удалены. Перезагрузите страницу или повторите попытку. Новые изменения Workspace не применены.";

    function publishStatus(nextValue) {
      const next = Object.freeze({
        status: ["ready", "loading", "unavailable"].includes(nextValue?.status) ? nextValue.status : "unavailable",
        context: contract.isScopeKey(nextValue?.context?.scopeKey) ? Object.freeze({ ...nextValue.context }) : null,
        errorCode: typeof nextValue?.errorCode === "string" ? nextValue.errorCode : null,
        message: typeof nextValue?.message === "string" ? nextValue.message : null,
      });
      const changed = next.status !== workspaceStatus.status
        || next.context?.scopeKey !== workspaceStatus.context?.scopeKey
        || next.errorCode !== workspaceStatus.errorCode
        || next.message !== workspaceStatus.message;
      workspaceStatus = next;
      if (changed) options.onStatusChange?.(next);
      return next;
    }

    function sync(urlValue) {
      const pageUrl = String(urlValue || root.location?.href || "");
      if (!isSupportedPage(pageUrl)) return Promise.resolve(null);
      lastUrl = pageUrl;
      if (inFlight?.pageUrl === pageUrl) return inFlight.promise;
      const token = ++requestToken;
      publishStatus({ status: "loading", context: current, errorCode: null, message: null });
      let sent;
      try {
        sent = options.send({ type: contract.MESSAGE_TYPES.GET_CONTEXT, pageUrl });
      } catch (_) {
        sent = Promise.reject(new Error("WORKSPACE_CONTEXT_SEND_FAILED"));
      }
      const promise = Promise.resolve(sent).then((response) => {
        if (token !== requestToken) return current;
        if (!response?.ok || !contract.isScopeKey(response.context?.scopeKey)) {
          current = null;
          publishStatus({
            status: "unavailable",
            context: null,
            errorCode: typeof response?.error?.code === "string" ? response.error.code : "WORKSPACE_MIGRATION_FAILED",
            message: unavailableMessage,
          });
          return null;
        }
        const next = Object.freeze({ ...response.context });
        const changed = contextChanged(current, next);
        current = next;
        publishStatus({ status: "ready", context: next, errorCode: null, message: null });
        if (changed) options.onChange?.(next);
        return next;
      }).catch(() => {
        if (token !== requestToken) return current;
        current = null;
        publishStatus({
          status: "unavailable",
          context: null,
          errorCode: "WORKSPACE_MIGRATION_FAILED",
          message: unavailableMessage,
        });
        return null;
      }).finally(() => {
        if (inFlight?.token === token) inFlight = null;
      });
      inFlight = { pageUrl, token, promise };
      return promise;
    }

    function checkLocation() {
      if (stopped) return;
      const href = String(root.location?.href || "");
      if (href !== lastUrl) void sync(href).catch(() => {});
    }

    function start() {
      if (intervalId !== null) return;
      stopped = false;
      void sync().catch(() => {});
      root.addEventListener?.("popstate", checkLocation);
      root.addEventListener?.("hashchange", checkLocation);
      intervalId = root.setInterval?.(checkLocation, 750) ?? null;
    }

    function stop() {
      stopped = true;
      root.removeEventListener?.("popstate", checkLocation);
      root.removeEventListener?.("hashchange", checkLocation);
      if (intervalId !== null) root.clearInterval?.(intervalId);
      intervalId = null;
    }

    return Object.freeze({
      start,
      stop,
      sync,
      retry: () => sync(root.location?.href || lastUrl),
      getCurrent: () => current,
      getStatus: () => workspaceStatus,
    });
  }

  const api = Object.freeze({ extractStableConversation, isSupportedPage, contextChanged, createClient });
  root.ChatGPTHelperConversationContext = api;
  if (typeof module === "object" && module.exports) module.exports = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
