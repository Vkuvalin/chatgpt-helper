(function initAnalysisContract(root) {
  "use strict";

  const MAX_SELECTION_LENGTH = 20000;
  const MAX_RESPONSE_BYTES = 256 * 1024;
  const MAX_TERMS = 40;
  const ACTIVE_LOCK_TTL_MS = 45000;
  const DEFAULT_SHORTCUT = Object.freeze({
    enabled: true,
    code: "KeyD",
    ctrl: true,
    shift: false,
    alt: false,
    meta: false,
  });
  const DEFAULT_ANALYSIS_SETTINGS = Object.freeze({
    shortcut: DEFAULT_SHORTCUT,
    termColorMode: "theme",
    customTermColor: "#69d6c5",
    glossaryTextSize: "normal",
  });

  const MESSAGE_TYPES = Object.freeze({
    TOGGLE_PANEL: "chatgpt-helper:toggle-panel",
    CONTEXT_MENU_SELECTION: "chatgpt-helper:context-menu-selection",
    ANALYZE_SELECTED_TERMS: "chatgpt-helper:analyze-selected-terms",
    TRANSLATE_SELECTED_TEXT: "chatgpt-helper:translate-selected-text",
    GET_KEY_STATUS: "chatgpt-helper:get-openrouter-key-status",
    KEY_STATUS_CHANGED: "chatgpt-helper:openrouter-key-status-changed",
    OPEN_OPTIONS: "chatgpt-helper:open-options",
    SET_KEY: "chatgpt-helper:set-openrouter-key",
    VERIFY_KEY: "chatgpt-helper:verify-openrouter-key",
    DELETE_KEY: "chatgpt-helper:delete-openrouter-key",
    REPLACE_GLOSSARY_ENTRY: "chatgpt-helper:replace-glossary-entry",
    MOVE_GLOSSARY_ENTRY: "chatgpt-helper:move-glossary-entry",
    DELETE_GLOSSARY_ENTRY: "chatgpt-helper:delete-glossary-entry",
  });

  const ERROR_MESSAGES = Object.freeze({
    EMPTY_SELECTION: "Сначала выделите текст.",
    SELECTION_TOO_LARGE: "Выделенный текст слишком длинный. Максимум: 20 000 символов.",
    ANALYSIS_ALREADY_RUNNING: "Анализ уже выполняется.",
    AI_OPERATION_ALREADY_RUNNING: "Другая AI-операция уже выполняется.",
    UNSUPPORTED_PAGE: "Анализ доступен только на поддерживаемой странице ChatGPT.",
    API_KEY_MISSING: "Ключ OpenRouter не настроен.",
    API_KEY_INVALID: "Ключ OpenRouter недействителен.",
    INSUFFICIENT_BALANCE: "Недостаточно средств либо исчерпан лимит API-ключа OpenRouter.",
    REQUEST_TIMEOUT: "OpenRouter не ответил за 25 секунд.",
    NETWORK_ERROR: "Не удалось подключиться к OpenRouter.",
    PROVIDER_TIMEOUT: "Провайдер модели не ответил вовремя.",
    RATE_LIMITED: "OpenRouter временно ограничил частоту запросов.",
    PROVIDER_OVERLOADED: "Провайдер модели временно перегружен.",
    MODEL_UNAVAILABLE: "Модель временно недоступна.",
    NO_PROVIDER_AVAILABLE: "Для модели сейчас нет доступного провайдера.",
    CONTENT_BLOCKED: "Провайдер отклонил выбранный текст по правилам безопасности.",
    REQUEST_FORBIDDEN: "OpenRouter запретил этот запрос.",
    REQUEST_CONTRACT_ERROR: "OpenRouter отклонил параметры запроса.",
    MODEL_NOT_FOUND: "Настроенная модель OpenRouter не найдена.",
    REQUEST_TOO_LARGE: "Выбранный текст слишком велик для провайдера.",
    PROVIDER_ERROR: "OpenRouter вернул ошибку.",
    OUTPUT_TRUNCATED: "Ответ модели был обрезан.",
    EMPTY_RESPONSE: "Модель вернула пустой ответ.",
    INVALID_RESPONSE_FORMAT: "Модель вернула ответ в неожиданном формате.",
    GLOSSARY_STORAGE_FAILED: "Не удалось сохранить изменения словаря.",
    GLOSSARY_ENTRY_CHANGED: "Сохранённая версия термина изменилась. Проверьте её и повторите действие.",
  });

  const ZERO_WIDTH_RE = /[\u200B-\u200D\u2060\uFEFF]/g;
  const OUTER_DECORATION_RE = /^[\s`*_~"'“”„‘’«»]+|[\s`*_~"'“”„‘’«»]+$/g;
  const TEXT_SIZES = new Set(["compact", "normal", "large"]);
  const MODIFIER_CODES = new Set([
    "ControlLeft", "ControlRight", "ShiftLeft", "ShiftRight",
    "AltLeft", "AltRight", "MetaLeft", "MetaRight",
  ]);

  function normalizeUnicode(value) {
    try {
      return String(value ?? "").normalize("NFKC");
    } catch (_) {
      return String(value ?? "");
    }
  }

  function normalizeSelection(value) {
    return String(value ?? "")
      .replace(/\r\n?/g, "\n")
      .replace(/\u00A0/g, " ")
      .replace(ZERO_WIDTH_RE, "")
      .trim();
  }

  function validateSelection(value) {
    const text = normalizeSelection(value);
    if (!text) return { ok: false, error: makeError("EMPTY_SELECTION") };
    if (text.length > MAX_SELECTION_LENGTH) {
      return { ok: false, error: makeError("SELECTION_TOO_LARGE") };
    }
    return { ok: true, text };
  }

  function normalizeDashesAndQuotes(value) {
    return value
      .replace(/[‐‑‒–—―−]/g, "-")
      .replace(/[’‘‛]/g, "'")
      .replace(/[“”„«»]/g, '"');
  }

  function normalizeTerm(value) {
    let term = normalizeDashesAndQuotes(normalizeUnicode(value).replace(ZERO_WIDTH_RE, "").trim());
    let previous;
    do {
      previous = term;
      term = term.replace(OUTER_DECORATION_RE, "").trim();
    } while (term !== previous);
    return term
      .replace(/\s*\/\s*/g, "/")
      .replace(/\s*-\s*/g, "-")
      .replace(/\s+/g, " ")
      .toLocaleLowerCase("en-US");
  }

  function normalizeComparable(value) {
    return normalizeDashesAndQuotes(normalizeUnicode(value).replace(ZERO_WIDTH_RE, ""))
      .replace(/\s+/g, " ")
      .trim()
      .toLocaleLowerCase("ru-RU");
  }

  function normalizeSearchText(value) {
    return normalizeComparable(value)
      .replace(/ё/g, "е")
      .replace(/["'«»]/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  }

  function matchesGlossarySearch(entry, query) {
    const tokens = normalizeSearchText(query).split(" ").filter(Boolean);
    if (!tokens.length) return true;
    const index = normalizeSearchText(`${entry?.term || ""} ${entry?.translation || ""} ${entry?.definition || ""}`);
    return tokens.every((token) => index.includes(token));
  }

  function sourceComparable(value) {
    return normalizeDashesAndQuotes(normalizeUnicode(value).replace(ZERO_WIDTH_RE, ""))
      .replace(/[`*_~]/g, "")
      .replace(/["'«»]/g, "")
      .replace(/\s*\/\s*/g, "/")
      .replace(/\s*-\s*/g, "-")
      .replace(/\s+/g, " ")
      .trim()
      .toLocaleLowerCase("en-US");
  }

  function normalizeField(value, maxLength, definition) {
    if (typeof value !== "string") return null;
    let normalized = normalizeUnicode(value).replace(ZERO_WIDTH_RE, "");
    if (definition) normalized = normalized.replace(/\r\n?|\n/g, " ");
    normalized = normalized.replace(/\s+/g, " ").trim();
    if (!normalized || normalized.length > maxLength) return null;
    if (definition && !/[.!?…]$/u.test(normalized)) normalized += ".";
    return normalized.length <= maxLength ? normalized : null;
  }

  function normalizeModelEntry(value, sourceText) {
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    const term = normalizeField(value.term, 160, false);
    const translation = normalizeField(value.translation, 200, false);
    const definition = normalizeField(value.definition, 500, true);
    if (!term || !translation || !definition) return null;
    if (!/[A-Za-z]/.test(term) || !normalizeTerm(term)) return null;
    if (!sourceComparable(sourceText).includes(sourceComparable(term))) return null;
    return { term, normalizedTerm: normalizeTerm(term), translation, definition };
  }

  function validateTermsPayload(payload, sourceText) {
    if (!payload || typeof payload !== "object" || Array.isArray(payload)
      || Object.keys(payload).some((key) => key !== "terms")
      || !Array.isArray(payload.terms)) {
      return { ok: false, error: makeError("INVALID_RESPONSE_FORMAT") };
    }
    const seen = new Set();
    const terms = [];
    for (const candidate of payload.terms.slice(0, MAX_TERMS)) {
      const term = normalizeModelEntry(candidate, sourceText);
      if (!term || seen.has(term.normalizedTerm)) continue;
      seen.add(term.normalizedTerm);
      terms.push(term);
    }
    return { ok: true, terms };
  }

  function isSupportedUrl(value) {
    try {
      const url = new URL(value);
      return url.protocol === "https:" && (url.hostname === "chatgpt.com" || url.hostname === "chat.openai.com");
    } catch (_) {
      return false;
    }
  }

  function createId(prefix) {
    if (typeof root.crypto?.randomUUID === "function") return root.crypto.randomUUID();
    return `${prefix || "id"}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  }

  function makeError(code, message, retryAfterSeconds) {
    const error = { code, message: message || ERROR_MESSAGES[code] || ERROR_MESSAGES.PROVIDER_ERROR };
    if (Number.isFinite(retryAfterSeconds) && retryAfterSeconds > 0) {
      error.retryAfterSeconds = Math.min(300, Math.ceil(retryAfterSeconds));
    }
    return error;
  }

  function errorEnvelope(requestId, code, message, retryAfterSeconds) {
    return { ok: false, requestId: typeof requestId === "string" ? requestId : "", error: makeError(code, message, retryAfterSeconds) };
  }

  function normalizeShortcut(value) {
    const shortcut = value && typeof value === "object" ? value : {};
    const code = typeof shortcut.code === "string" && shortcut.code.trim() && !MODIFIER_CODES.has(shortcut.code)
      ? shortcut.code.trim()
      : DEFAULT_SHORTCUT.code;
    const normalized = {
      enabled: shortcut.enabled !== false,
      code,
      ctrl: shortcut.ctrl === true,
      shift: shortcut.shift === true,
      alt: shortcut.alt === true,
      meta: shortcut.meta === true,
    };
    if (!normalized.ctrl && !normalized.shift && !normalized.alt && !normalized.meta) {
      return { ...DEFAULT_SHORTCUT, enabled: normalized.enabled };
    }
    return normalized;
  }

  function validateShortcutCandidate(value) {
    const candidate = value && typeof value === "object" ? value : {};
    if (typeof candidate.code !== "string" || !candidate.code.trim() || MODIFIER_CODES.has(candidate.code)) {
      return { ok: false, reason: "Нажмите основную клавишу вместе с модификатором." };
    }
    if (candidate.ctrl !== true && candidate.shift !== true && candidate.alt !== true && candidate.meta !== true) {
      return { ok: false, reason: "Добавьте Ctrl, Shift, Alt или Meta." };
    }
    const shortcut = normalizeShortcut(candidate);
    if (shortcut.code === "F5"
      || (shortcut.ctrl && shortcut.code === "KeyR")
      || (shortcut.ctrl && shortcut.code === "KeyW")
      || (shortcut.alt && shortcut.code === "F4")) {
      return { ok: false, reason: "Эта комбинация зарезервирована для управления браузером." };
    }
    return { ok: true, shortcut };
  }

  function shortcutMatches(event, shortcutValue) {
    const shortcut = normalizeShortcut(shortcutValue);
    return shortcut.enabled
      && event.code === shortcut.code
      && event.ctrlKey === shortcut.ctrl
      && event.shiftKey === shortcut.shift
      && event.altKey === shortcut.alt
      && event.metaKey === shortcut.meta;
  }

  function formatShortcut(shortcutValue) {
    const shortcut = normalizeShortcut(shortcutValue);
    if (!shortcut.enabled) return "Отключено";
    const parts = [];
    if (shortcut.ctrl) parts.push("Ctrl");
    if (shortcut.shift) parts.push("Shift");
    if (shortcut.alt) parts.push("Alt");
    if (shortcut.meta) parts.push("Meta");
    parts.push(shortcut.code.replace(/^Key/, "").replace(/^Digit/, ""));
    return parts.join(" + ");
  }

  function normalizeAnalysisSettings(settingsValue) {
    const settings = settingsValue && typeof settingsValue === "object" ? settingsValue : {};
    const analysis = settings.analysis && typeof settings.analysis === "object" ? settings.analysis : {};
    return {
      ...settings,
      analysis: {
        ...analysis,
        shortcut: normalizeShortcut(analysis.shortcut),
        termColorMode: analysis.termColorMode === "custom" ? "custom" : "theme",
        customTermColor: /^#[0-9a-f]{6}$/i.test(analysis.customTermColor || "")
          ? analysis.customTermColor.toLowerCase()
          : DEFAULT_ANALYSIS_SETTINGS.customTermColor,
        glossaryTextSize: TEXT_SIZES.has(analysis.glossaryTextSize) ? analysis.glossaryTextSize : "normal",
      },
    };
  }

  const api = Object.freeze({
    MAX_SELECTION_LENGTH,
    MAX_RESPONSE_BYTES,
    MAX_TERMS,
    ACTIVE_LOCK_TTL_MS,
    DEFAULT_SHORTCUT,
    DEFAULT_ANALYSIS_SETTINGS,
    MESSAGE_TYPES,
    ERROR_MESSAGES,
    MODIFIER_CODES,
    normalizeSelection,
    validateSelection,
    normalizeTerm,
    normalizeComparable,
    normalizeSearchText,
    matchesGlossarySearch,
    normalizeModelEntry,
    validateTermsPayload,
    isSupportedUrl,
    createId,
    makeError,
    errorEnvelope,
    normalizeShortcut,
    validateShortcutCandidate,
    shortcutMatches,
    formatShortcut,
    normalizeAnalysisSettings,
  });

  root.ChatGPTHelperAnalysisContract = api;
  if (typeof module === "object" && module.exports) module.exports = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
