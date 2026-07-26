(function initWorkspaceContract(root) {
  "use strict";

  if (root.ChatGPTHelperWorkspaceContract) return;

  const DB_NAME = "chatgpt-helper-workspace";
  const DB_VERSION = 1;
  const WORKSPACE_SCHEMA_VERSION = 2;
  const MAX_QUERY_RESULTS = 200;
  const MAX_INLINE_SELECTION_LENGTH = 2000;
  const MAX_INLINE_SELECTION_LINES = 40;
  const MAX_INLINE_CANDIDATES = 64;
  const MAX_INLINE_CANDIDATE_LENGTH = 80;
  const MAX_INLINE_NGRAM_TOKENS = 4;
  const MAX_INLINE_RESULT_ENTRIES = 100;
  const MAX_SAVED_ITEM_LENGTH = 200000;
  const MAX_TEMPLATE_LENGTH = 200000;
  const MAX_WALLPAPER_SOURCE_BYTES = 6 * 1024 * 1024;
  const ZERO_WIDTH_RE = /[\u200B-\u200D\u2060\uFEFF]/g;
  const OUTER_FORMATTING_RE = /^[\s`*_~"'“”„‘’«»]+|[\s`*_~"'“”„‘’«»]+$/gu;
  const SUPPORTED_HOSTS = Object.freeze(["chatgpt.com", "chat.openai.com"]);
  const VALID_THEMES = Object.freeze(["system", "graphite", "navy", "violet", "gold"]);
  const RECENT_TEMPLATES_HOVER_COUNT = Object.freeze({ default: 3, min: 1, max: 8 });
  const LAYOUT = Object.freeze({
    sidebarWidth: Object.freeze({ default: 360, min: 320, max: 720, viewportRatio: 0.8 }),
    analysisDialogWidth: Object.freeze({ default: 560, min: 360, max: 960, viewportRatio: 0.92 }),
  });
  const DEFAULT_ACTIVE_SETTINGS = Object.freeze({
    theme: "system",
    wallpaperDataUrl: null,
    closePanelAfterRun: true,
    closePanelOnOutsideClick: true,
    recentTemplatesHoverEnabled: true,
    recentTemplatesHoverCount: RECENT_TEMPLATES_HOVER_COUNT.default,
    analysis: Object.freeze({
      termColorMode: "theme",
      customTermColor: "#69d6c5",
      glossaryTextSize: "normal",
    }),
    layout: Object.freeze({
      sidebarWidth: LAYOUT.sidebarWidth.default,
      analysisDialogWidth: LAYOUT.analysisDialogWidth.default,
    }),
  });

  const STORE_NAMES = Object.freeze({
    META: "meta",
    CONVERSATIONS: "conversations",
    GLOSSARY_CONCEPTS: "glossaryConcepts",
    GLOSSARY_SENSES: "glossarySenses",
    GLOSSARY_LINKS: "glossaryLinks",
    SAVED_ITEMS: "savedItems",
    SAVED_ITEM_LINKS: "savedItemLinks",
    IMPORT_BACKUPS: "importBackups",
  });

  const STORE_DEFINITIONS = Object.freeze({
    meta: Object.freeze({ keyPath: "key", indexes: Object.freeze([]) }),
    conversations: Object.freeze({
      keyPath: "id",
      indexes: Object.freeze([
        Object.freeze({ name: "scopeKey", keyPath: "scopeKey", unique: true }),
        Object.freeze({ name: "remoteConversationId", keyPath: "remoteConversationId", unique: false }),
        Object.freeze({ name: "kind", keyPath: "kind", unique: false }),
        Object.freeze({ name: "lastSeenAt", keyPath: "lastSeenAt", unique: false }),
      ]),
    }),
    glossaryConcepts: Object.freeze({
      keyPath: "id",
      indexes: Object.freeze([
        Object.freeze({ name: "normalizedKey", keyPath: "normalizedKey", unique: true }),
        Object.freeze({ name: "updatedAt", keyPath: "updatedAt", unique: false }),
      ]),
    }),
    glossarySenses: Object.freeze({
      keyPath: "id",
      indexes: Object.freeze([
        Object.freeze({ name: "conceptId", keyPath: "conceptId", unique: false }),
        Object.freeze({ name: "naturalKey", keyPath: "naturalKey", unique: true }),
        Object.freeze({ name: "updatedAt", keyPath: "updatedAt", unique: false }),
      ]),
    }),
    glossaryLinks: Object.freeze({
      keyPath: "id",
      indexes: Object.freeze([
        Object.freeze({ name: "linkKey", keyPath: "linkKey", unique: true }),
        Object.freeze({ name: "senseId", keyPath: "senseId", unique: false }),
        Object.freeze({ name: "conversationId", keyPath: "conversationId", unique: false }),
        Object.freeze({ name: "conversationIdLocalOrder", keyPath: ["conversationId", "localOrder"], unique: false }),
      ]),
    }),
    savedItems: Object.freeze({
      keyPath: "id",
      indexes: Object.freeze([
        Object.freeze({ name: "normalizedTextKey", keyPath: "normalizedTextKey", unique: true }),
        Object.freeze({ name: "updatedAt", keyPath: "updatedAt", unique: false }),
      ]),
    }),
    savedItemLinks: Object.freeze({
      keyPath: "id",
      indexes: Object.freeze([
        Object.freeze({ name: "linkKey", keyPath: "linkKey", unique: true }),
        Object.freeze({ name: "itemId", keyPath: "itemId", unique: false }),
        Object.freeze({ name: "conversationId", keyPath: "conversationId", unique: false }),
        Object.freeze({ name: "conversationIdLocalOrder", keyPath: ["conversationId", "localOrder"], unique: false }),
      ]),
    }),
    importBackups: Object.freeze({ keyPath: "kind", indexes: Object.freeze([]) }),
  });

  const MESSAGE_TYPES = Object.freeze({
    GET_CONTEXT: "chatgpt-helper:workspace-get-context",
    REBIND_CONVERSATION: "chatgpt-helper:workspace-rebind-conversation",
    QUERY_GLOSSARY: "chatgpt-helper:workspace-query-glossary",
    LOOKUP_GLOSSARY_SELECTION: "chatgpt-helper:workspace-lookup-glossary-selection",
    ATTACH_GLOSSARY_SENSE: "chatgpt-helper:workspace-attach-glossary-sense",
    MOVE_GLOSSARY_LINK: "chatgpt-helper:workspace-move-glossary-link",
    UNLINK_GLOSSARY: "chatgpt-helper:workspace-unlink-glossary",
    DELETE_GLOSSARY_SENSE: "chatgpt-helper:workspace-delete-glossary-sense",
    REPLACE_GLOSSARY_SENSE: "chatgpt-helper:workspace-replace-glossary-sense",
    SAVE_SELECTION: "chatgpt-helper:workspace-save-selection",
    QUERY_SAVED: "chatgpt-helper:workspace-query-saved",
    MOVE_SAVED_LINK: "chatgpt-helper:workspace-move-saved-link",
    UNLINK_SAVED: "chatgpt-helper:workspace-unlink-saved",
    DELETE_SAVED_ITEM: "chatgpt-helper:workspace-delete-saved-item",
    TEMPLATE_CREATE: "chatgpt-helper:template-create",
    TEMPLATE_UPDATE: "chatgpt-helper:template-update",
    TEMPLATE_DELETE: "chatgpt-helper:template-delete",
    TEMPLATE_REORDER: "chatgpt-helper:template-reorder",
    RECENT_TEMPLATE_TOUCH: "chatgpt-helper:recent-template-touch",
    SETTINGS_UPDATE: "chatgpt-helper:settings-update",
    CHANGED: "chatgpt-helper:workspace-changed",
    CONTEXT_MENU_SAVE_SELECTION: "chatgpt-helper:context-menu-save-selection",
    CONTEXT_MENU_NORMALIZE_COMPOSER: "chatgpt-helper:context-menu-normalize-composer",
    EXPORT_SETTINGS: "EXPORT_SETTINGS",
    IMPORT_SETTINGS_PREVIEW: "IMPORT_SETTINGS_PREVIEW",
    IMPORT_SETTINGS_APPLY: "IMPORT_SETTINGS_APPLY",
    EXPORT_DATA: "EXPORT_DATA",
    IMPORT_DATA_PREVIEW: "IMPORT_DATA_PREVIEW",
    IMPORT_DATA_APPLY: "IMPORT_DATA_APPLY",
  });

  const ENTITY_FAMILIES = Object.freeze({
    CONVERSATIONS: "conversations",
    GLOSSARY: "glossary",
    SAVED: "savedItems",
    ALL: "all",
  });

  function normalizeUnicode(value) {
    try {
      return String(value ?? "").normalize("NFKC");
    } catch (_) {
      return String(value ?? "");
    }
  }

  function compareText(leftValue, rightValue) {
    const left = String(leftValue ?? "");
    const right = String(rightValue ?? "");
    return left < right ? -1 : (left > right ? 1 : 0);
  }

  function normalizeDashesAndQuotes(value) {
    return String(value)
      .replace(/[‐‑‒–—―−]/g, "-")
      .replace(/[’‘‛]/g, "'")
      .replace(/[“”„«»]/g, '"');
  }

  function stripOuterFormatting(value) {
    let result = String(value).trim();
    let previous;
    do {
      previous = result;
      result = result.replace(OUTER_FORMATTING_RE, "").trim();
    } while (result !== previous);
    return result;
  }

  function canonicalizeTerm(value) {
    const displayTerm = stripOuterFormatting(normalizeDashesAndQuotes(
      normalizeUnicode(value).replace(ZERO_WIDTH_RE, ""),
    ));
    if (!displayTerm || displayTerm.length > 160) return null;
    const canonicalTerm = displayTerm
      .replace(/([\p{Ll}\d])(\p{Lu})/gu, "$1 $2")
      .replace(/(\p{Lu}+)(\p{Lu}\p{Ll})/gu, "$1 $2")
      .replace(/\s*\/\s*/g, "/")
      .replace(/\s*-\s*/g, "-")
      .replace(/\s+/g, " ")
      .trim();
    if (!canonicalTerm) return null;
    return Object.freeze({
      displayTerm,
      canonicalTerm,
      normalizedKey: canonicalTerm.toLocaleLowerCase("en-US"),
    });
  }

  function stripInlineOuterPairs(value) {
    const pairs = new Map([
      ["(", ")"],
      ["[", "]"],
      ["{", "}"],
      ['"', '"'],
      ["'", "'"],
      ["“", "”"],
      ["„", "“"],
      ["‘", "’"],
      ["«", "»"],
    ]);
    let result = String(value || "").trim();
    let changed = true;
    while (changed && result.length >= 2) {
      changed = false;
      const closing = pairs.get(result[0]);
      if (closing && result.at(-1) === closing) {
        result = result.slice(1, -1).trim();
        changed = true;
      }
    }
    return result;
  }

  function stripInlineOuterMarkdown(value) {
    let result = String(value || "").trim();
    let changed = true;
    const markers = ["**", "__", "~~", "`", "*", "_", "~"];
    while (changed) {
      changed = false;
      for (const marker of markers) {
        if (result.length > marker.length * 2
          && result.startsWith(marker)
          && result.endsWith(marker)) {
          result = result.slice(marker.length, -marker.length).trim();
          changed = true;
          break;
        }
      }
    }
    return result;
  }

  function cleanInlineGlossaryTerm(value) {
    if (typeof value !== "string") return "";
    let result = normalizeUnicode(value)
      .replace(ZERO_WIDTH_RE, "")
      .replace(/\u00a0/g, " ")
      .trim();
    let previous;
    do {
      previous = result;
      result = stripInlineOuterMarkdown(stripInlineOuterPairs(result));
      result = result.replace(/[.,;:!?…]+$/u, "").trim();
    } while (result !== previous);
    return result.replace(/[\t\f\v ]+/g, " ").trim();
  }

  function normalizeInlineSelectionText(value) {
    if (typeof value !== "string") return "";
    return normalizeUnicode(value)
      .replace(/\r\n?/g, "\n")
      .replace(/\u00a0/g, " ")
      .replace(ZERO_WIDTH_RE, "")
      .trim();
  }

  function validateInlineSelectionText(value) {
    if (typeof value !== "string") return { ok: false, error: "INVALID_GLOSSARY_SELECTION" };
    const text = normalizeInlineSelectionText(value);
    if (!text) return { ok: false, error: "INVALID_GLOSSARY_SELECTION" };
    if (text.length > MAX_INLINE_SELECTION_LENGTH) {
      return { ok: false, error: "GLOSSARY_SELECTION_TOO_LARGE" };
    }
    const lineCount = text.split("\n").length;
    if (lineCount > MAX_INLINE_SELECTION_LINES) {
      return { ok: false, error: "GLOSSARY_SELECTION_TOO_MANY_LINES" };
    }
    return { ok: true, text, lineCount };
  }

  function inlineLexemes(value, baseIndex) {
    const source = String(value || "");
    const lexemes = [];
    const pattern = /[A-Za-z0-9_+#-]+(?:\.(?=[A-Za-z0-9_+#-])[A-Za-z0-9_+#-]+)*/g;
    let match;
    while ((match = pattern.exec(source)) !== null) {
      const display = match[0];
      lexemes.push({
        display,
        start: Number(baseIndex || 0) + match.index,
        end: Number(baseIndex || 0) + match.index + display.length,
        technical: /[A-Za-z]/.test(display),
      });
    }
    return lexemes;
  }

  function tokenizeGlossaryTerm(value) {
    const term = canonicalizeTerm(value);
    if (!term) return [];
    return inlineLexemes(term.displayTerm, 0)
      .filter((item) => item.technical)
      .map((item) => item.display.toLocaleLowerCase("en-US"));
  }

  function inlineTechnicalGroups(text) {
    const groups = [];
    let lineStart = 0;
    String(text || "").split("\n").forEach((line) => {
      const lexemes = inlineLexemes(line, lineStart);
      let group = [];
      let previous = null;
      lexemes.forEach((lexeme) => {
        const localStart = lexeme.start - lineStart;
        const gap = previous
          ? line.slice(previous.end - lineStart, localStart)
          : line.slice(0, localStart);
        if (!lexeme.technical) {
          if (group.length) groups.push(group);
          group = [];
          previous = lexeme;
          return;
        }
        if (group.length && (!previous?.technical || !/^\s*$/u.test(gap))) {
          groups.push(group);
          group = [];
        }
        group.push(lexeme);
        previous = lexeme;
      });
      if (group.length) groups.push(group);
      lineStart += line.length + 1;
    });
    return groups;
  }

  function hasInlineListItemBoundary(value) {
    return /^\s*(?:[•*+-]|\d+[.)])\s+/u.test(String(value || ""));
  }

  function createInlineCandidate(displayValue, firstIndex, source, visibility) {
    const displayTerm = String(displayValue || "").replace(/\s+/gu, " ").trim();
    if (!displayTerm || displayTerm.length > MAX_INLINE_CANDIDATE_LENGTH) return null;
    const term = canonicalizeTerm(displayTerm);
    if (!term) return null;
    const tokens = tokenizeGlossaryTerm(term.displayTerm);
    if (!tokens.length || tokens.length > MAX_INLINE_NGRAM_TOKENS) return null;
    return {
      displayTerm,
      normalizedKey: term.normalizedKey,
      tokens,
      tokenCount: tokens.length,
      firstIndex,
      occurrences: 1,
      source,
      visibility,
    };
  }

  function extractInlineGlossaryCandidates(value) {
    const validated = validateInlineSelectionText(value);
    if (!validated.ok) return validated;
    const text = validated.text;
    const groups = inlineTechnicalGroups(text);
    const byKey = new Map();
    const cleanedWhole = text.includes("\n") ? "" : cleanInlineGlossaryTerm(text);
    const hasListItemBoundary = hasInlineListItemBoundary(text);
    const wholeGroups = cleanedWhole ? inlineTechnicalGroups(cleanedWhole) : [];
    const wholeLexemes = cleanedWhole ? inlineLexemes(cleanedWhole, 0) : [];
    const technicalCount = wholeLexemes.filter((item) => item.technical).length;
    const termMode = Boolean(
      cleanedWhole
      && cleanedWhole.length <= MAX_INLINE_CANDIDATE_LENGTH
      && !hasListItemBoundary
      && !/(?![A-Za-z])\p{L}/u.test(cleanedWhole)
      && wholeGroups.length === 1
      && technicalCount === wholeLexemes.length
      && technicalCount > 0
      && technicalCount <= MAX_INLINE_NGRAM_TOKENS
    );

    function add(candidate) {
      if (!candidate) return;
      const occurrenceKey = `${candidate.firstIndex}\u001f${candidate.displayTerm}`;
      const existing = byKey.get(candidate.normalizedKey);
      if (!existing) {
        byKey.set(candidate.normalizedKey, {
          ...candidate,
          _occurrences: new Set([occurrenceKey]),
        });
        return;
      }
      existing._occurrences.add(occurrenceKey);
      existing.occurrences = existing._occurrences.size;
      if (candidate.visibility === "primary") existing.visibility = "primary";
      if (candidate.firstIndex < existing.firstIndex) {
        existing.displayTerm = candidate.displayTerm;
        existing.firstIndex = candidate.firstIndex;
        existing.source = candidate.source;
      } else if (candidate.firstIndex === existing.firstIndex
        && candidate.source === "selected-whole") {
        existing.displayTerm = candidate.displayTerm;
        existing.source = candidate.source;
      }
    }

    if (termMode) {
      const first = groups[0]?.[0]?.start || 0;
      add(createInlineCandidate(cleanedWhole, first, "selected-whole", "primary"));
    }

    groups.forEach((group) => {
      group.forEach((lexeme, startIndex) => {
        add(createInlineCandidate(
          lexeme.display,
          lexeme.start,
          "token",
          termMode ? "lookup-only" : "primary",
        ));
        const maximum = Math.min(MAX_INLINE_NGRAM_TOKENS, group.length - startIndex);
        for (let size = 2; size <= maximum; size += 1) {
          const last = group[startIndex + size - 1];
          const display = text.slice(lexeme.start, last.end);
          add(createInlineCandidate(display, lexeme.start, "ngram", "lookup-only"));
        }
      });
    });

    const candidates = [...byKey.values()]
      .map((candidate) => {
        const { _occurrences, ...publicCandidate } = candidate;
        return Object.freeze({
          ...publicCandidate,
          tokens: Object.freeze([...publicCandidate.tokens]),
          occurrences: _occurrences.size,
        });
      })
      .sort((left, right) => (
        (left.visibility === "primary" ? 0 : 1)
        - (right.visibility === "primary" ? 0 : 1)
        || left.firstIndex - right.firstIndex
        || (left.visibility === "lookup-only" && right.visibility === "lookup-only"
          ? right.tokenCount - left.tokenCount
          : 0)
        || compareText(left.normalizedKey, right.normalizedKey)
      ));
    const candidateCountBeforeLimit = candidates.length;
    const limited = candidates.slice(0, MAX_INLINE_CANDIDATES);
    return {
      ok: true,
      text,
      candidates: limited,
      candidateCountBeforeLimit,
      candidateCountReturned: limited.length,
      candidateTruncated: limited.length < candidateCountBeforeLimit,
    };
  }

  function normalizeMeaning(value, maxLength) {
    const normalized = normalizeDashesAndQuotes(normalizeUnicode(value).replace(ZERO_WIDTH_RE, ""))
      .replace(/\s+/g, " ")
      .trim();
    const limit = Number.isInteger(maxLength) ? maxLength : 500;
    return normalized && normalized.length <= limit ? normalized : "";
  }

  function createSenseNaturalKey(conceptId, translation, definition) {
    return JSON.stringify([
      String(conceptId || ""),
      normalizeMeaning(translation, 200).toLocaleLowerCase("ru-RU"),
      normalizeMeaning(definition, 500).toLocaleLowerCase("ru-RU"),
    ]);
  }

  function normalizeSelectedPlainText(value) {
    return String(value ?? "")
      .replace(/\r\n?/g, "\n")
      .replace(/\u00a0/g, " ");
  }

  function normalizeSavedTextKey(value) {
    return normalizeUnicode(normalizeSelectedPlainText(value))
      .split("\n")
      .map((line) => line.replace(/[\t ]+$/g, ""))
      .join("\n")
      .trim();
  }

  function validateSavedText(value) {
    if (typeof value !== "string") return { ok: false, error: "EMPTY_SAVED_TEXT" };
    const text = normalizeSelectedPlainText(value);
    const normalizedTextKey = normalizeSavedTextKey(text);
    if (!normalizedTextKey) return { ok: false, error: "EMPTY_SAVED_TEXT" };
    if (text.length > MAX_SAVED_ITEM_LENGTH) return { ok: false, error: "SAVED_TEXT_TOO_LARGE" };
    return { ok: true, text, normalizedTextKey };
  }

  function validateWallpaperSourceFile(file) {
    if (!file || typeof file !== "object" || typeof file.type !== "string" || !file.type.startsWith("image/")) {
      return { ok: false, error: "WALLPAPER_INVALID_TYPE", message: "Выберите файл изображения." };
    }
    if (!Number.isFinite(file.size) || file.size < 0 || file.size > MAX_WALLPAPER_SOURCE_BYTES) {
      return { ok: false, error: "WALLPAPER_FILE_TOO_LARGE", message: "Изображение превышает лимит 6 МБ." };
    }
    return { ok: true };
  }

  function normalizeSearchQuery(value) {
    return normalizeUnicode(value)
      .replace(ZERO_WIDTH_RE, "")
      .replace(/ё/g, "е")
      .replace(/["'«»]/g, " ")
      .replace(/\s+/g, " ")
      .trim()
      .toLocaleLowerCase("ru-RU");
  }

  function matchesAllTokens(value, query) {
    const tokens = normalizeSearchQuery(query).split(" ").filter(Boolean);
    if (!tokens.length) return true;
    const haystack = normalizeSearchQuery(value);
    return tokens.every((token) => haystack.includes(token));
  }

  function isSupportedHost(value) {
    return SUPPORTED_HOSTS.includes(String(value || "").toLocaleLowerCase("en-US"));
  }

  function isScopeKey(value) {
    if (typeof value !== "string" || value.length > 320) return false;
    if (/^temporary:[A-Za-z0-9_-]{8,200}$/.test(value)) return true;
    const match = /^stable:([^:]+):([A-Za-z0-9_-]{1,200})$/.exec(value);
    return Boolean(match && isSupportedHost(match[1]));
  }

  function validEntityId(value) {
    return typeof value === "string" && value.length >= 1 && value.length <= 200 && !/[\u0000-\u001f]/.test(value);
  }

  function boundedLimit(value) {
    return Number.isInteger(value) && value > 0 ? Math.min(value, MAX_QUERY_RESULTS) : MAX_QUERY_RESULTS;
  }

  function normalizeMode(value) {
    return value === "global" ? "global" : "local";
  }

  function createInvalidation(entityFamily, conversationScope, revision) {
    if (!Object.values(ENTITY_FAMILIES).includes(entityFamily)) return null;
    if (conversationScope !== null && !isScopeKey(conversationScope)) return null;
    if (!Number.isSafeInteger(revision) || revision < 1) return null;
    return Object.freeze({ entityFamily, conversationScope, revision });
  }

  function validateInvalidation(value) {
    if (!value || typeof value !== "object" || Array.isArray(value)) return false;
    if (Object.keys(value).some((key) => !["entityFamily", "conversationScope", "revision"].includes(key))) return false;
    return Boolean(createInvalidation(value.entityFamily, value.conversationScope, value.revision));
  }

  function isAllowedWallpaperDataUrl(value) {
    return value === null || (typeof value === "string"
      && /^data:image\/(?:png|jpe?g|gif|webp);base64,[A-Za-z0-9+/=\s]+$/i.test(value));
  }

  function clampPreferredWidth(name, value) {
    const bounds = LAYOUT[name];
    if (!bounds) return 0;
    const numeric = Number(value);
    if (!Number.isFinite(numeric)) return bounds.default;
    return Math.round(Math.min(bounds.max, Math.max(bounds.min, numeric)));
  }

  function effectiveWidth(name, preferredValue, viewportWidth) {
    const bounds = LAYOUT[name];
    if (!bounds) return 0;
    const preferred = clampPreferredWidth(name, preferredValue);
    const viewportMaximum = Math.max(0, Math.floor(Number(viewportWidth) * bounds.viewportRatio));
    return Math.max(0, Math.min(preferred, bounds.max, viewportMaximum));
  }

  function resizePreferredWidth(name, startWidth, deltaX, edge) {
    const signedDelta = edge === "right" ? Number(deltaX) : -Number(deltaX);
    return clampPreferredWidth(name, Number(startWidth) + (Number.isFinite(signedDelta) ? signedDelta : 0));
  }

  function normalizeRecentTemplatesHoverCount(value) {
    if (typeof value !== "number" || !Number.isFinite(value)) {
      return RECENT_TEMPLATES_HOVER_COUNT.default;
    }
    return Math.round(Math.min(
      RECENT_TEMPLATES_HOVER_COUNT.max,
      Math.max(RECENT_TEMPLATES_HOVER_COUNT.min, value),
    ));
  }

  function normalizeRecentTemplateIds(value) {
    if (!Array.isArray(value)) return [];
    const result = [];
    const seen = new Set();
    for (const item of value) {
      if (typeof item !== "string") continue;
      const id = item.trim();
      if (!id || seen.has(id)) continue;
      seen.add(id);
      result.push(id);
    }
    return result;
  }

  function normalizeActiveSettings(value) {
    const input = value && typeof value === "object" && !Array.isArray(value) ? value : {};
    const analysis = input.analysis && typeof input.analysis === "object" && !Array.isArray(input.analysis)
      ? input.analysis
      : {};
    const layout = input.layout && typeof input.layout === "object" && !Array.isArray(input.layout)
      ? input.layout
      : {};
    return {
      theme: VALID_THEMES.includes(input.theme) ? input.theme : DEFAULT_ACTIVE_SETTINGS.theme,
      wallpaperDataUrl: isAllowedWallpaperDataUrl(input.wallpaperDataUrl) ? input.wallpaperDataUrl : null,
      closePanelAfterRun: typeof input.closePanelAfterRun === "boolean"
        ? input.closePanelAfterRun
        : DEFAULT_ACTIVE_SETTINGS.closePanelAfterRun,
      closePanelOnOutsideClick: typeof input.closePanelOnOutsideClick === "boolean"
        ? input.closePanelOnOutsideClick
        : DEFAULT_ACTIVE_SETTINGS.closePanelOnOutsideClick,
      recentTemplatesHoverEnabled: typeof input.recentTemplatesHoverEnabled === "boolean"
        ? input.recentTemplatesHoverEnabled
        : DEFAULT_ACTIVE_SETTINGS.recentTemplatesHoverEnabled,
      recentTemplatesHoverCount: normalizeRecentTemplatesHoverCount(input.recentTemplatesHoverCount),
      analysis: {
        termColorMode: analysis.termColorMode === "custom" ? "custom" : "theme",
        customTermColor: /^#[0-9a-f]{6}$/i.test(analysis.customTermColor || "")
          ? analysis.customTermColor.toLowerCase()
          : DEFAULT_ACTIVE_SETTINGS.analysis.customTermColor,
        glossaryTextSize: ["compact", "normal", "large"].includes(analysis.glossaryTextSize)
          ? analysis.glossaryTextSize
          : DEFAULT_ACTIVE_SETTINGS.analysis.glossaryTextSize,
      },
      layout: {
        sidebarWidth: clampPreferredWidth("sidebarWidth", layout.sidebarWidth),
        analysisDialogWidth: clampPreferredWidth("analysisDialogWidth", layout.analysisDialogWidth),
      },
    };
  }

  function validateActiveSettingsPatch(value) {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      return { ok: false, error: "INVALID_SETTINGS_PATCH" };
    }
    const topLevel = [
      "theme", "wallpaperDataUrl", "closePanelAfterRun", "closePanelOnOutsideClick",
      "recentTemplatesHoverEnabled", "recentTemplatesHoverCount", "analysis", "layout",
    ];
    const keys = Object.keys(value);
    if (!keys.length || keys.some((key) => !topLevel.includes(key))) {
      return { ok: false, error: "INVALID_SETTINGS_PATCH" };
    }

    const patch = {};
    if (Object.prototype.hasOwnProperty.call(value, "theme")) {
      if (!VALID_THEMES.includes(value.theme)) return { ok: false, error: "INVALID_SETTINGS_PATCH" };
      patch.theme = value.theme;
    }
    if (Object.prototype.hasOwnProperty.call(value, "wallpaperDataUrl")) {
      if (!isAllowedWallpaperDataUrl(value.wallpaperDataUrl)) return { ok: false, error: "INVALID_SETTINGS_PATCH" };
      patch.wallpaperDataUrl = value.wallpaperDataUrl;
    }
    for (const key of ["closePanelAfterRun", "closePanelOnOutsideClick", "recentTemplatesHoverEnabled"]) {
      if (!Object.prototype.hasOwnProperty.call(value, key)) continue;
      if (typeof value[key] !== "boolean") return { ok: false, error: "INVALID_SETTINGS_PATCH" };
      patch[key] = value[key];
    }
    if (Object.prototype.hasOwnProperty.call(value, "recentTemplatesHoverCount")) {
      if (!Number.isInteger(value.recentTemplatesHoverCount)
        || value.recentTemplatesHoverCount < RECENT_TEMPLATES_HOVER_COUNT.min
        || value.recentTemplatesHoverCount > RECENT_TEMPLATES_HOVER_COUNT.max) {
        return { ok: false, error: "INVALID_SETTINGS_PATCH" };
      }
      patch.recentTemplatesHoverCount = value.recentTemplatesHoverCount;
    }

    if (Object.prototype.hasOwnProperty.call(value, "analysis")) {
      const analysis = value.analysis;
      const allowed = ["termColorMode", "customTermColor", "glossaryTextSize"];
      if (!analysis || typeof analysis !== "object" || Array.isArray(analysis)
        || !Object.keys(analysis).length || Object.keys(analysis).some((key) => !allowed.includes(key))) {
        return { ok: false, error: "INVALID_SETTINGS_PATCH" };
      }
      const normalized = {};
      if (Object.prototype.hasOwnProperty.call(analysis, "termColorMode")) {
        if (!["theme", "custom"].includes(analysis.termColorMode)) return { ok: false, error: "INVALID_SETTINGS_PATCH" };
        normalized.termColorMode = analysis.termColorMode;
      }
      if (Object.prototype.hasOwnProperty.call(analysis, "customTermColor")) {
        if (!/^#[0-9a-f]{6}$/i.test(analysis.customTermColor || "")) return { ok: false, error: "INVALID_SETTINGS_PATCH" };
        normalized.customTermColor = analysis.customTermColor.toLowerCase();
      }
      if (Object.prototype.hasOwnProperty.call(analysis, "glossaryTextSize")) {
        if (!["compact", "normal", "large"].includes(analysis.glossaryTextSize)) return { ok: false, error: "INVALID_SETTINGS_PATCH" };
        normalized.glossaryTextSize = analysis.glossaryTextSize;
      }
      patch.analysis = normalized;
    }

    if (Object.prototype.hasOwnProperty.call(value, "layout")) {
      const layout = value.layout;
      const allowed = ["sidebarWidth", "analysisDialogWidth"];
      if (!layout || typeof layout !== "object" || Array.isArray(layout)
        || !Object.keys(layout).length || Object.keys(layout).some((key) => !allowed.includes(key))) {
        return { ok: false, error: "INVALID_SETTINGS_PATCH" };
      }
      const normalized = {};
      for (const key of allowed) {
        if (!Object.prototype.hasOwnProperty.call(layout, key)) continue;
        if (typeof layout[key] !== "number" || !Number.isFinite(layout[key])) {
          return { ok: false, error: "INVALID_SETTINGS_PATCH" };
        }
        normalized[key] = clampPreferredWidth(key, layout[key]);
      }
      patch.layout = normalized;
    }
    return { ok: true, patch };
  }

  function applyActiveSettingsPatch(currentValue, patchValue) {
    const validated = validateActiveSettingsPatch(patchValue);
    if (!validated.ok) return validated;
    const current = normalizeActiveSettings(currentValue);
    return {
      ok: true,
      settings: normalizeActiveSettings({
        ...current,
        ...validated.patch,
        analysis: { ...current.analysis, ...(validated.patch.analysis || {}) },
        layout: { ...current.layout, ...(validated.patch.layout || {}) },
      }),
    };
  }

  function createActiveSettingsPatch(previousValue, nextValue) {
    const previous = normalizeActiveSettings(previousValue);
    const next = normalizeActiveSettings(nextValue);
    const patch = {};
    for (const key of [
      "theme", "wallpaperDataUrl", "closePanelAfterRun", "closePanelOnOutsideClick",
      "recentTemplatesHoverEnabled", "recentTemplatesHoverCount",
    ]) {
      if (!Object.is(previous[key], next[key])) patch[key] = next[key];
    }
    for (const group of ["analysis", "layout"]) {
      const changed = {};
      for (const key of Object.keys(next[group])) {
        if (!Object.is(previous[group][key], next[group][key])) changed[key] = next[group][key];
      }
      if (Object.keys(changed).length) patch[group] = changed;
    }
    return patch;
  }

  function newlineTokenAt(text, offset) {
    if (text[offset] === "\r") return text[offset + 1] === "\n" ? "\r\n" : "\r";
    return text[offset] === "\n" ? "\n" : null;
  }

  function validateTemplatePatch(value) {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      return { ok: false, error: "INVALID_TEMPLATE_PATCH" };
    }
    const allowed = ["name", "content", "autoSend"];
    const keys = Object.keys(value);
    if (!keys.length || keys.some((key) => !allowed.includes(key))) {
      return { ok: false, error: "INVALID_TEMPLATE_PATCH" };
    }
    const patch = {};
    if (Object.prototype.hasOwnProperty.call(value, "name")) {
      if (typeof value.name !== "string" || !value.name.trim()) {
        return { ok: false, error: "INVALID_TEMPLATE_PATCH" };
      }
      patch.name = value.name;
    }
    if (Object.prototype.hasOwnProperty.call(value, "content")) {
      if (typeof value.content !== "string" || !value.content.trim() || value.content.length > MAX_TEMPLATE_LENGTH) {
        return { ok: false, error: "INVALID_TEMPLATE_PATCH" };
      }
      patch.content = value.content;
    }
    if (Object.prototype.hasOwnProperty.call(value, "autoSend")) {
      if (typeof value.autoSend !== "boolean") return { ok: false, error: "INVALID_TEMPLATE_PATCH" };
      patch.autoSend = value.autoSend;
    }
    return { ok: true, patch };
  }

  function createTemplatePatch(previousValue, nextValue) {
    const previous = previousValue && typeof previousValue === "object" ? previousValue : {};
    const next = nextValue && typeof nextValue === "object" ? nextValue : {};
    const patch = {};
    for (const key of ["name", "content", "autoSend"]) {
      if (Object.prototype.hasOwnProperty.call(next, key) && !Object.is(previous[key], next[key])) {
        patch[key] = next[key];
      }
    }
    return patch;
  }

  function interpretTemplateExecutionResult(value, optionsValue) {
    const result = value && typeof value === "object" && !Array.isArray(value) ? value : {};
    const options = optionsValue && typeof optionsValue === "object" && !Array.isArray(optionsValue)
      ? optionsValue
      : {};
    const noop = result.noop === true;
    const insertionSucceeded = result.inserted === true || result.unchanged === true;
    const insertionFailed = !noop && (result.failed === true || !insertionSucceeded);
    const verificationFailed = !noop && !insertionFailed
      && (result.verificationFailed === true || result.verified !== true);
    const sendFailed = !noop && !insertionFailed && !verificationFailed
      && (result.sendFailed === true || (options.requireSent === true
        && (result.sendAttempted !== true || result.sent !== true)));
    return Object.freeze({
      accepted: noop || (!insertionFailed && !verificationFailed && !sendFailed),
      noop,
      insertionSucceeded: !noop && insertionSucceeded && !insertionFailed,
      insertionFailed,
      verificationFailed,
      sendFailed,
    });
  }

  function normalizeComposerPlainText(value) {
    const source = String(value ?? "");
    const edits = [];
    let cursor = 0;
    while (cursor < source.length) {
      const firstToken = newlineTokenAt(source, cursor);
      if (!firstToken) {
        cursor += 1;
        continue;
      }
      const start = cursor;
      let end = cursor + firstToken.length;
      let count = 1;
      cursor = end;
      while (cursor < source.length) {
        let candidate = cursor;
        while (source[candidate] === " " || source[candidate] === "\t") candidate += 1;
        const token = newlineTokenAt(source, candidate);
        if (!token) break;
        count += 1;
        cursor = candidate + token.length;
        end = cursor;
      }
      if (count >= 2) {
        const replacement = firstToken + firstToken;
        if (source.slice(start, end) !== replacement) edits.push({ start, end, replacement });
      }
      cursor = end;
    }
    if (!edits.length) return { text: source, changed: false, edits: [] };
    let result = "";
    let previous = 0;
    edits.forEach((edit) => {
      result += source.slice(previous, edit.start) + edit.replacement;
      previous = edit.end;
    });
    result += source.slice(previous);
    return { text: result, changed: true, edits };
  }

  const normalizeComposerText = normalizeComposerPlainText;

  function mapOffsetThroughEdits(offsetValue, editsValue) {
    const offset = Math.max(0, Number.isFinite(offsetValue) ? Math.floor(offsetValue) : 0);
    let delta = 0;
    for (const edit of Array.isArray(editsValue) ? editsValue : []) {
      if (offset < edit.start) break;
      if (offset <= edit.end) {
        return edit.start + delta + Math.min(edit.replacement.length, Math.max(0, offset - edit.start));
      }
      delta += edit.replacement.length - (edit.end - edit.start);
    }
    return offset + delta;
  }

  const api = Object.freeze({
    DB_NAME,
    DB_VERSION,
    WORKSPACE_SCHEMA_VERSION,
    MAX_QUERY_RESULTS,
    MAX_INLINE_SELECTION_LENGTH,
    MAX_INLINE_SELECTION_LINES,
    MAX_INLINE_CANDIDATES,
    MAX_INLINE_CANDIDATE_LENGTH,
    MAX_INLINE_NGRAM_TOKENS,
    MAX_INLINE_RESULT_ENTRIES,
    MAX_SAVED_ITEM_LENGTH,
    MAX_TEMPLATE_LENGTH,
    MAX_WALLPAPER_SOURCE_BYTES,
    SUPPORTED_HOSTS,
    VALID_THEMES,
    RECENT_TEMPLATES_HOVER_COUNT,
    LAYOUT,
    DEFAULT_ACTIVE_SETTINGS,
    STORE_NAMES,
    STORE_DEFINITIONS,
    MESSAGE_TYPES,
    ENTITY_FAMILIES,
    normalizeUnicode,
    canonicalizeTerm,
    cleanInlineGlossaryTerm,
    normalizeInlineSelectionText,
    validateInlineSelectionText,
    tokenizeGlossaryTerm,
    extractInlineGlossaryCandidates,
    normalizeMeaning,
    createSenseNaturalKey,
    normalizeSelectedPlainText,
    normalizeSavedTextKey,
    validateSavedText,
    validateWallpaperSourceFile,
    normalizeSearchQuery,
    matchesAllTokens,
    isSupportedHost,
    isScopeKey,
    validEntityId,
    boundedLimit,
    normalizeMode,
    createInvalidation,
    validateInvalidation,
    isAllowedWallpaperDataUrl,
    clampPreferredWidth,
    effectiveWidth,
    resizePreferredWidth,
    normalizeRecentTemplatesHoverCount,
    normalizeRecentTemplateIds,
    normalizeActiveSettings,
    validateActiveSettingsPatch,
    applyActiveSettingsPatch,
    createActiveSettingsPatch,
    validateTemplatePatch,
    createTemplatePatch,
    interpretTemplateExecutionResult,
    normalizeComposerPlainText,
    normalizeComposerText,
    mapOffsetThroughEdits,
  });

  root.ChatGPTHelperWorkspaceContract = api;
  if (typeof module === "object" && module.exports) module.exports = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
