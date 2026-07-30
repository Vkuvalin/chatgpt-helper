(function initImportExport(root) {
  "use strict";

  if (root.ChatGPTHelperImportExport) return;
  const contract = root.ChatGPTHelperWorkspaceContract
    || (typeof require === "function" ? require("./workspace-contract.js") : null);
  const templateTree = root.ChatGPTHelperTemplateTree
    || (typeof require === "function" ? require("./template-tree.js") : null);

  const SETTINGS_FORMAT = "chatgpt-helper-settings";
  const DATA_FORMAT = "chatgpt-helper-data";
  const SETTINGS_SCHEMA_VERSION = 1;
  const DATA_SCHEMA_VERSION = 2;
  const SUPPORTED_DATA_SCHEMA_VERSIONS = Object.freeze([1, DATA_SCHEMA_VERSION]);
  const SETTINGS_MAX_BYTES = 10 * 1024 * 1024;
  const DATA_MAX_BYTES = 25 * 1024 * 1024;
  const MAX_TEMPLATE_LENGTH = 200000;
  const DATA_ARRAYS = Object.freeze([
    "templates", "conversations", "glossaryConcepts", "glossarySenses",
    "glossaryLinks", "savedItems", "savedItemLinks",
  ]);

  function plain(value) {
    return Boolean(value) && typeof value === "object" && !Array.isArray(value);
  }

  function clone(value) {
    if (typeof structuredClone === "function") return structuredClone(value);
    return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
  }

  function byteLength(value) {
    const text = String(value ?? "");
    return typeof TextEncoder === "function" ? new TextEncoder().encode(text).byteLength : unescape(encodeURIComponent(text)).length;
  }

  function ordered(value) {
    if (Array.isArray(value)) return value.map(ordered);
    if (!plain(value)) return value;
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, ordered(value[key])]));
  }

  function canonicalStringify(value) {
    return `${JSON.stringify(ordered(value), null, 2)}\n`;
  }

  function validIsoTimestamp(value) {
    return typeof value === "string" && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
  }

  function validTimestamp(value) {
    return Number.isSafeInteger(value) && value >= 0;
  }

  function validUuid(value) {
    return typeof value === "string"
      && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
  }

  function unknownWarnings(value, allowed, path, warnings) {
    if (!plain(value)) return;
    Object.keys(value).filter((key) => !allowed.includes(key)).sort().forEach((key) => {
      warnings.push({ code: "UNKNOWN_FIELD", path: `${path}.${key}` });
    });
  }

  function parseText(textValue, maximum, expectedFormat, supportedVersions) {
    const text = String(textValue ?? "");
    if (byteLength(text) > maximum) return { ok: false, errors: [{ code: "FILE_TOO_LARGE" }], warnings: [] };
    let value;
    try {
      value = JSON.parse(text);
    } catch (_) {
      return { ok: false, errors: [{ code: "INVALID_JSON" }], warnings: [] };
    }
    if (!plain(value)) return { ok: false, errors: [{ code: "INVALID_ENVELOPE" }], warnings: [] };
    if (value.format !== expectedFormat) return { ok: false, errors: [{ code: "INVALID_FORMAT" }], warnings: [] };
    const supported = Array.isArray(supportedVersions) ? supportedVersions : [supportedVersions];
    const maximumSupported = Math.max(...supported);
    if (!supported.includes(value.schemaVersion)) {
      return { ok: false, errors: [{ code: value.schemaVersion > maximumSupported ? "FUTURE_SCHEMA" : "UNSUPPORTED_SCHEMA" }], warnings: [] };
    }
    if (!validIsoTimestamp(value.exportedAt)) return { ok: false, errors: [{ code: "INVALID_EXPORTED_AT" }], warnings: [] };
    return { ok: true, value, warnings: [], errors: [] };
  }

  function validateSettingsPayload(payloadValue, inheritedWarnings) {
    const warnings = inheritedWarnings || [];
    const errors = [];
    const payload = plain(payloadValue) ? payloadValue : null;
    if (!payload) return { ok: false, errors: [{ code: "INVALID_SETTINGS_PAYLOAD" }], warnings };
    const allowed = [
      "theme", "wallpaperDataUrl", "closePanelAfterRun", "closePanelOnOutsideClick",
      "recentTemplatesHoverEnabled", "recentTemplatesHoverCount", "analysis", "layout",
    ];
    unknownWarnings(payload, allowed, "payload", warnings);
    const imported = {};
    if (Object.prototype.hasOwnProperty.call(payload, "theme")) {
      if (!contract.VALID_THEMES.includes(payload.theme)) errors.push({ code: "INVALID_THEME", path: "payload.theme" });
      else imported.theme = payload.theme;
    }
    if (Object.prototype.hasOwnProperty.call(payload, "wallpaperDataUrl")) {
      if (!contract.isAllowedWallpaperDataUrl(payload.wallpaperDataUrl)) errors.push({ code: "INVALID_WALLPAPER", path: "payload.wallpaperDataUrl" });
      else imported.wallpaperDataUrl = payload.wallpaperDataUrl;
    }
    ["closePanelAfterRun", "closePanelOnOutsideClick", "recentTemplatesHoverEnabled"].forEach((key) => {
      if (!Object.prototype.hasOwnProperty.call(payload, key)) return;
      if (typeof payload[key] !== "boolean") errors.push({ code: "INVALID_BOOLEAN", path: `payload.${key}` });
      else imported[key] = payload[key];
    });
    if (Object.prototype.hasOwnProperty.call(payload, "recentTemplatesHoverCount")) {
      const count = payload.recentTemplatesHoverCount;
      if (!Number.isInteger(count)
        || count < contract.RECENT_TEMPLATES_HOVER_COUNT.min
        || count > contract.RECENT_TEMPLATES_HOVER_COUNT.max) {
        errors.push({ code: "INVALID_RECENT_TEMPLATES_HOVER_COUNT", path: "payload.recentTemplatesHoverCount" });
      } else {
        imported.recentTemplatesHoverCount = count;
      }
    }
    if (Object.prototype.hasOwnProperty.call(payload, "analysis")) {
      if (!plain(payload.analysis)) errors.push({ code: "INVALID_ANALYSIS_SETTINGS", path: "payload.analysis" });
      else {
        unknownWarnings(payload.analysis, ["termColorMode", "customTermColor", "glossaryTextSize"], "payload.analysis", warnings);
        imported.analysis = {};
        if (Object.prototype.hasOwnProperty.call(payload.analysis, "termColorMode")) {
          if (!["theme", "custom"].includes(payload.analysis.termColorMode)) errors.push({ code: "INVALID_TERM_COLOR_MODE", path: "payload.analysis.termColorMode" });
          else imported.analysis.termColorMode = payload.analysis.termColorMode;
        }
        if (Object.prototype.hasOwnProperty.call(payload.analysis, "customTermColor")) {
          if (!/^#[0-9a-f]{6}$/i.test(payload.analysis.customTermColor || "")) errors.push({ code: "INVALID_TERM_COLOR", path: "payload.analysis.customTermColor" });
          else imported.analysis.customTermColor = payload.analysis.customTermColor.toLowerCase();
        }
        if (Object.prototype.hasOwnProperty.call(payload.analysis, "glossaryTextSize")) {
          if (!["compact", "normal", "large"].includes(payload.analysis.glossaryTextSize)) errors.push({ code: "INVALID_TEXT_SIZE", path: "payload.analysis.glossaryTextSize" });
          else imported.analysis.glossaryTextSize = payload.analysis.glossaryTextSize;
        }
      }
    }
    if (Object.prototype.hasOwnProperty.call(payload, "layout")) {
      if (!plain(payload.layout)) errors.push({ code: "INVALID_LAYOUT", path: "payload.layout" });
      else {
        unknownWarnings(payload.layout, ["sidebarWidth", "analysisDialogWidth"], "payload.layout", warnings);
        imported.layout = {};
        ["sidebarWidth", "analysisDialogWidth"].forEach((key) => {
          if (!Object.prototype.hasOwnProperty.call(payload.layout, key)) return;
          if (!Number.isFinite(payload.layout[key])) {
            errors.push({ code: "INVALID_WIDTH", path: `payload.layout.${key}` });
            return;
          }
          const clamped = contract.clampPreferredWidth(key, payload.layout[key]);
          imported.layout[key] = clamped;
          if (clamped !== payload.layout[key]) warnings.push({ code: "CLAMPED_WIDTH", path: `payload.layout.${key}`, value: clamped });
        });
      }
    }
    return { ok: errors.length === 0, errors, warnings, imported };
  }

  function validateSettingsText(text) {
    const parsed = parseText(
      text,
      SETTINGS_MAX_BYTES,
      SETTINGS_FORMAT,
      SETTINGS_SCHEMA_VERSION
    );
    if (!parsed.ok) return parsed;
    unknownWarnings(parsed.value, ["format", "schemaVersion", "exportedAt", "extensionVersion", "payload"], "envelope", parsed.warnings);
    const validated = validateSettingsPayload(parsed.value.payload, parsed.warnings);
    return validated.ok ? { ...validated, envelope: { ...parsed.value, payload: validated.imported } } : validated;
  }

  function mergeImported(baseValue, imported) {
    const base = clone(baseValue);
    Object.keys(imported).forEach((key) => {
      if (key === "analysis" || key === "layout") base[key] = { ...base[key], ...imported[key] };
      else base[key] = imported[key];
    });
    return base;
  }

  function previewSettings(current, result, mode, warnings, imported) {
    const currentFlat = ordered(current);
    const resultFlat = ordered(result);
    const changed = [];
    const preserved = [];
    const reset = [];
    const visit = (left, right, path) => {
      Object.keys(right).forEach((key) => {
        const nextPath = path ? `${path}.${key}` : key;
        if (plain(right[key])) visit(left?.[key] || {}, right[key], nextPath);
        else if (JSON.stringify(left?.[key]) !== JSON.stringify(right[key])) changed.push(nextPath);
        else preserved.push(nextPath);
      });
    };
    visit(currentFlat, resultFlat, "");
    if (mode === "replace") {
      const defaults = contract.DEFAULT_ACTIVE_SETTINGS;
      const importedPaths = new Set();
      const collect = (value, path) => Object.keys(value || {}).forEach((key) => {
        const next = path ? `${path}.${key}` : key;
        if (plain(value[key])) collect(value[key], next); else importedPaths.add(next);
      });
      collect(imported, "");
      const atPath = (value, path) => path.split(".").reduce((cursor, key) => cursor?.[key], value);
      const collectReset = (value, path) => Object.keys(value || {}).forEach((key) => {
        const next = path ? `${path}.${key}` : key;
        if (plain(value[key])) collectReset(value[key], next);
        else if (!importedPaths.has(next) && JSON.stringify(atPath(current, next)) !== JSON.stringify(atPath(defaults, next))) reset.push(next);
      });
      collectReset(defaults, "");
    }
    return {
      changed, preserved, reset,
      ignored: warnings.filter((item) => item.code === "UNKNOWN_FIELD").map((item) => item.path),
      clamped: warnings.filter((item) => item.code === "CLAMPED_WIDTH").map((item) => ({ path: item.path, value: item.value })),
      values: { current: redactSettings(current), result: redactSettings(result) },
    };
  }

  function redactSettings(value) {
    const result = clone(value);
    if (typeof result?.wallpaperDataUrl === "string") result.wallpaperDataUrl = `[data:image, ${byteLength(result.wallpaperDataUrl)} bytes]`;
    return result;
  }

  function buildSettingsPlan(currentValue, validatedValue, modeValue) {
    const mode = modeValue === "replace" ? "replace" : "merge";
    const current = contract.normalizeActiveSettings(currentValue);
    const imported = validatedValue?.envelope?.payload || validatedValue?.imported || {};
    const base = mode === "replace" ? contract.normalizeActiveSettings() : current;
    const settings = contract.normalizeActiveSettings(mergeImported(base, imported));
    return { mode, settings, preview: previewSettings(current, settings, mode, validatedValue?.warnings || [], imported) };
  }

  function createSettingsExport(settingsValue, metadata) {
    const envelope = {
      format: SETTINGS_FORMAT,
      schemaVersion: SETTINGS_SCHEMA_VERSION,
      exportedAt: metadata?.exportedAt || new Date().toISOString(),
      ...(metadata?.extensionVersion ? { extensionVersion: String(metadata.extensionVersion) } : {}),
      payload: contract.normalizeActiveSettings(settingsValue),
    };
    return { filename: "chatgpt-helper-settings.json", envelope, text: canonicalStringify(envelope) };
  }

  function recordBase(record, fields) {
    return Object.fromEntries(fields.filter((key) => Object.prototype.hasOwnProperty.call(record, key)).map((key) => [key, record[key]]));
  }

  function portableTemplateNode(item) {
    return item?.kind === templateTree.NODE_KINDS.FOLDER
      ? recordBase(item, ["id", "kind", "parentId", "name", "iconKey"])
      : recordBase(item, ["id", "kind", "parentId", "name", "iconKey", "content", "autoSend"]);
  }

  function portablePayloadFromState(value) {
    const source = plain(value) ? value : {};
    return {
      templates: (Array.isArray(source.templates) ? source.templates : []).map(portableTemplateNode),
      conversations: (Array.isArray(source.conversations) ? source.conversations : []).map((item) => recordBase(item, ["id", "kind", "host", "remoteConversationId", "createdAt", "lastSeenAt", "orphanedAt"])),
      glossaryConcepts: (Array.isArray(source.glossaryConcepts) ? source.glossaryConcepts : []).map((item) => recordBase(item, ["id", "displayTerm", "createdAt", "updatedAt"])),
      glossarySenses: (Array.isArray(source.glossarySenses) ? source.glossarySenses : []).map((item) => recordBase(item, ["id", "conceptId", "translation", "definition", "createdAt", "updatedAt"])),
      glossaryLinks: (Array.isArray(source.glossaryLinks) ? source.glossaryLinks : []).map((item) => recordBase(item, ["id", "senseId", "conversationId", "localOrder", "firstSeenAt", "lastSeenAt"])),
      savedItems: (Array.isArray(source.savedItems) ? source.savedItems : []).map((item) => recordBase(item, ["id", "text", "createdAt", "updatedAt"])),
      savedItemLinks: (Array.isArray(source.savedItemLinks) ? source.savedItemLinks : []).map((item) => recordBase(item, ["id", "itemId", "conversationId", "localOrder", "firstSeenAt", "lastSeenAt"])),
    };
  }

  function dataRecordDefinitions(schemaVersion) {
    return {
      templates: {
        fields: schemaVersion === 1
          ? ["id", "name", "content", "autoSend"]
          : ["id", "kind", "parentId", "name", "iconKey", "content", "autoSend"],
      },
      conversations: { fields: ["id", "kind", "host", "remoteConversationId", "createdAt", "lastSeenAt", "orphanedAt"] },
      glossaryConcepts: { fields: ["id", "displayTerm", "createdAt", "updatedAt"] },
      glossarySenses: { fields: ["id", "conceptId", "translation", "definition", "createdAt", "updatedAt"] },
      glossaryLinks: { fields: ["id", "senseId", "conversationId", "localOrder", "firstSeenAt", "lastSeenAt"] },
      savedItems: { fields: ["id", "text", "createdAt", "updatedAt"] },
      savedItemLinks: { fields: ["id", "itemId", "conversationId", "localOrder", "firstSeenAt", "lastSeenAt"] },
    };
  }

  function sanitizeDataPayload(payloadValue, warnings, schemaVersion) {
    const payload = {};
    const definitions = dataRecordDefinitions(schemaVersion);
    unknownWarnings(payloadValue, DATA_ARRAYS, "payload", warnings);
    for (const family of DATA_ARRAYS) {
      if (!Array.isArray(payloadValue?.[family])) return { ok: false, errors: [{ code: "MISSING_ARRAY", path: `payload.${family}` }], warnings };
      const ids = new Set();
      payload[family] = [];
      for (let index = 0; index < payloadValue[family].length; index += 1) {
        const raw = payloadValue[family][index];
        const path = `payload.${family}[${index}]`;
        if (!plain(raw)) return { ok: false, errors: [{ code: "INVALID_RECORD", path }], warnings };
        unknownWarnings(raw, definitions[family].fields, path, warnings);
        const item = family === "templates" && schemaVersion === DATA_SCHEMA_VERSION
          ? clone(raw)
          : recordBase(raw, definitions[family].fields);
        if (!contract.validEntityId(item.id) || ids.has(item.id)) return { ok: false, errors: [{ code: ids.has(item.id) ? "DUPLICATE_ID" : "INVALID_ID", path: `${path}.id` }], warnings };
        ids.add(item.id);
        payload[family].push(item);
      }
    }
    return { ok: true, payload, warnings };
  }

  function normalizePortableTemplates(payload, schemaVersion, warnings) {
    const normalized = schemaVersion === 1
      ? templateTree.migrateLegacyTemplates(payload.templates)
      : templateTree.validateTypedNodes(payload.templates);
    if (!normalized.ok) {
      return {
        ok: false,
        errors: [{
          code: normalized.error?.code || "INVALID_TEMPLATE_NODE",
          path: "payload.templates",
        }],
        warnings,
      };
    }
    return {
      ok: true,
      payload: { ...payload, templates: normalized.nodes },
      warnings,
    };
  }

  function validatePortableRecords(payload, warnings) {
    const errors = [];
    const templateValidation = templateTree.validateTypedNodes(payload.templates);
    if (!templateValidation.ok) {
      errors.push({
        code: templateValidation.error?.code || "INVALID_TEMPLATE_NODE",
        path: "payload.templates",
      });
    }
    payload.conversations.forEach((item, index) => {
      const stable = item.kind === "stable" && contract.isSupportedHost(item.host)
        && typeof item.remoteConversationId === "string" && /^[A-Za-z0-9_-]{1,200}$/.test(item.remoteConversationId);
      const temporary = item.kind === "temporary" && contract.isSupportedHost(item.host) && item.remoteConversationId === null;
      if ((!stable && !temporary) || !validTimestamp(item.createdAt) || !validTimestamp(item.lastSeenAt) || item.lastSeenAt < item.createdAt
        || (item.orphanedAt !== null && (!validTimestamp(item.orphanedAt) || item.orphanedAt < item.createdAt))) {
        errors.push({ code: "INVALID_CONVERSATION", path: `payload.conversations[${index}]` });
      }
    });
    payload.glossaryConcepts.forEach((item, index) => {
      if (!contract.canonicalizeTerm(item.displayTerm) || !validTimestamp(item.createdAt) || !validTimestamp(item.updatedAt) || item.updatedAt < item.createdAt) errors.push({ code: "INVALID_CONCEPT", path: `payload.glossaryConcepts[${index}]` });
    });
    payload.glossarySenses.forEach((item, index) => {
      if (!contract.validEntityId(item.conceptId) || !contract.normalizeMeaning(item.translation, 200) || !contract.normalizeMeaning(item.definition, 500)
        || !validTimestamp(item.createdAt) || !validTimestamp(item.updatedAt) || item.updatedAt < item.createdAt) errors.push({ code: "INVALID_SENSE", path: `payload.glossarySenses[${index}]` });
    });
    payload.savedItems.forEach((item, index) => {
      if (!contract.validateSavedText(item.text).ok || !validTimestamp(item.createdAt) || !validTimestamp(item.updatedAt) || item.updatedAt < item.createdAt) errors.push({ code: "INVALID_SAVED_ITEM", path: `payload.savedItems[${index}]` });
    });
    [
      ["glossaryLinks", "senseId"], ["savedItemLinks", "itemId"],
    ].forEach(([family, entityField]) => payload[family].forEach((item, index) => {
      if (!contract.validEntityId(item[entityField]) || !contract.validEntityId(item.conversationId)
        || !Number.isSafeInteger(item.localOrder) || item.localOrder < 0
        || !validTimestamp(item.firstSeenAt) || !validTimestamp(item.lastSeenAt) || item.lastSeenAt < item.firstSeenAt) {
        errors.push({ code: "INVALID_LINK", path: `payload.${family}[${index}]` });
      }
    }));
    const ids = Object.fromEntries(DATA_ARRAYS.map((family) => [family, new Set(payload[family].map((item) => item.id))]));
    payload.glossarySenses.forEach((item) => { if (!ids.glossaryConcepts.has(item.conceptId)) errors.push({ code: "BROKEN_REFERENCE", path: `sense:${item.id}` }); });
    const senseCounts = new Map();
    payload.glossarySenses.forEach((item) => {
      const count = (senseCounts.get(item.conceptId) || 0) + 1;
      senseCounts.set(item.conceptId, count);
      if (count > 1) {
        errors.push({
          code: "GLOSSARY_INVARIANT_VIOLATION",
          path: `concept:${item.conceptId}`,
        });
      }
    });
    payload.glossaryLinks.forEach((item) => {
      if (!ids.glossarySenses.has(item.senseId) || !ids.conversations.has(item.conversationId)) errors.push({ code: "BROKEN_REFERENCE", path: `glossaryLink:${item.id}` });
    });
    payload.savedItemLinks.forEach((item) => {
      if (!ids.savedItems.has(item.itemId) || !ids.conversations.has(item.conversationId)) errors.push({ code: "BROKEN_REFERENCE", path: `savedItemLink:${item.id}` });
    });
    return { ok: errors.length === 0, errors, warnings, payload };
  }

  function assertOneSensePerConcept(value) {
    const concepts = Array.isArray(value?.glossaryConcepts) ? value.glossaryConcepts : [];
    const senses = Array.isArray(value?.glossarySenses) ? value.glossarySenses : [];
    const conceptIds = new Set();
    const normalizedTerms = new Set();
    concepts.forEach((concept) => {
      const normalizedKey = concept?.normalizedKey
        || contract.canonicalizeTerm(concept?.displayTerm || "")?.normalizedKey;
      if (!contract.validEntityId(concept?.id) || !normalizedKey
        || conceptIds.has(concept.id) || normalizedTerms.has(normalizedKey)) {
        throw new Error("GLOSSARY_INVARIANT_VIOLATION");
      }
      conceptIds.add(concept.id);
      normalizedTerms.add(normalizedKey);
    });
    const counts = new Map();
    const senseIds = new Set();
    senses.forEach((sense) => {
      const count = (counts.get(sense?.conceptId) || 0) + 1;
      if (!contract.validEntityId(sense?.id) || senseIds.has(sense.id)
        || !conceptIds.has(sense?.conceptId) || count > 1) {
        throw new Error("GLOSSARY_INVARIANT_VIOLATION");
      }
      senseIds.add(sense.id);
      counts.set(sense.conceptId, count);
    });
    return true;
  }

  function canonicalChoice(left, right) {
    const leftCreated = left.createdAt ?? left.firstSeenAt ?? 0;
    const rightCreated = right.createdAt ?? right.firstSeenAt ?? 0;
    if (leftCreated !== rightCreated) return leftCreated < rightCreated ? left : right;
    const leftUpdated = left.updatedAt ?? left.lastSeenAt ?? 0;
    const rightUpdated = right.updatedAt ?? right.lastSeenAt ?? 0;
    if (leftUpdated !== rightUpdated) return leftUpdated > rightUpdated ? left : right;
    return String(left.id).localeCompare(String(right.id)) <= 0 ? left : right;
  }

  function canonicalizeDataPayload(payloadValue) {
    const source = portablePayloadFromState(payloadValue);
    const templateCanonical = templateTree.canonicalizeNodes(source.templates);
    if (!templateCanonical.ok) {
      throw new Error(templateCanonical.error?.code || "INVALID_TEMPLATE_NODE");
    }
    source.templates = templateCanonical.nodes;
    const remaps = {
      templates: new Map(),
      conversations: new Map(),
      glossaryConcepts: new Map(),
      glossarySenses: new Map(),
      savedItems: new Map(),
      glossaryLinks: new Map(),
      savedItemLinks: new Map(),
    };
    const deduplicatedByFamily = Object.fromEntries(DATA_ARRAYS.map((family) => [family, 0]));
    let deduplicated = 0;
    function groupFamily(family, identity, mergeWinner) {
      const groups = new Map();
      source[family].forEach((item) => {
        const key = identity(item);
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(item);
      });
      return [...groups.values()].map((items) => {
        const winner = items.reduce((selected, item) => canonicalChoice(selected, item));
        items.forEach((item) => remaps[family].set(item.id, winner.id));
        const duplicateCount = items.length - 1;
        deduplicated += duplicateCount;
        deduplicatedByFamily[family] += duplicateCount;
        if (mergeWinner) mergeWinner(winner, items);
        return winner;
      });
    }
    source.conversations = groupFamily("conversations", (item) => item.kind === "stable" ? `stable:${item.host}:${item.remoteConversationId}` : `temporary:${item.id}`);
    source.glossaryConcepts = groupFamily("glossaryConcepts", (item) => contract.canonicalizeTerm(item.displayTerm).normalizedKey);
    source.glossarySenses.forEach((item) => { item.conceptId = remaps.glossaryConcepts.get(item.conceptId) || item.conceptId; });
    const canonicalSenseCounts = new Map();
    source.glossarySenses.forEach((item) => {
      const count = (canonicalSenseCounts.get(item.conceptId) || 0) + 1;
      if (count > 1) throw new Error("GLOSSARY_INVARIANT_VIOLATION");
      canonicalSenseCounts.set(item.conceptId, count);
    });
    source.glossarySenses = groupFamily("glossarySenses", (item) => contract.createSenseNaturalKey(item.conceptId, item.translation, item.definition));
    source.savedItems = groupFamily("savedItems", (item) => contract.normalizeSavedTextKey(item.text));
    source.glossaryLinks.forEach((item) => {
      item.senseId = remaps.glossarySenses.get(item.senseId) || item.senseId;
      item.conversationId = remaps.conversations.get(item.conversationId) || item.conversationId;
    });
    source.savedItemLinks.forEach((item) => {
      item.itemId = remaps.savedItems.get(item.itemId) || item.itemId;
      item.conversationId = remaps.conversations.get(item.conversationId) || item.conversationId;
    });
    const mergeLinks = (family, entityField) => {
      source[family] = groupFamily(
        family,
        (item) => `${item[entityField]}\u0000${item.conversationId}`,
        (winner, items) => {
          let localOrder = winner.localOrder;
          let firstSeenAt = winner.firstSeenAt;
          let lastSeenAt = winner.lastSeenAt;
          for (const item of items) {
            localOrder = Math.min(localOrder, item.localOrder);
            firstSeenAt = Math.min(firstSeenAt, item.firstSeenAt);
            lastSeenAt = Math.max(lastSeenAt, item.lastSeenAt);
          }
          winner.localOrder = localOrder;
          winner.firstSeenAt = firstSeenAt;
          winner.lastSeenAt = lastSeenAt;
        },
      );
    };
    mergeLinks("glossaryLinks", "senseId");
    mergeLinks("savedItemLinks", "itemId");
    const conceptsWithSenses = new Set(source.glossarySenses.map((item) => item.conceptId));
    const beforeConcepts = source.glossaryConcepts.length;
    source.glossaryConcepts = source.glossaryConcepts.filter((item) => conceptsWithSenses.has(item.id));
    const skipped = beforeConcepts - source.glossaryConcepts.length;
    ["conversations", "glossaryConcepts", "glossarySenses", "savedItems"].forEach((family) => source[family].sort((a, b) => a.id.localeCompare(b.id)));
    ["glossaryLinks", "savedItemLinks"].forEach((family) => source[family].sort((a, b) => a.conversationId.localeCompare(b.conversationId) || a.localOrder - b.localOrder || a.id.localeCompare(b.id)));
    return { payload: source, remaps, deduplicated, deduplicatedByFamily, skipped };
  }

  function validateDataText(text) {
    const parsed = parseText(
      text,
      DATA_MAX_BYTES,
      DATA_FORMAT,
      SUPPORTED_DATA_SCHEMA_VERSIONS
    );
    if (!parsed.ok) return parsed;
    unknownWarnings(parsed.value, ["format", "schemaVersion", "workspaceSchemaVersion", "datasetId", "exportedAt", "extensionVersion", "payload"], "envelope", parsed.warnings);
    if (parsed.value.workspaceSchemaVersion !== contract.WORKSPACE_SCHEMA_VERSION) return { ok: false, errors: [{ code: "UNSUPPORTED_WORKSPACE_SCHEMA" }], warnings: parsed.warnings };
    if (!validUuid(parsed.value.datasetId)) return { ok: false, errors: [{ code: "INVALID_DATASET_ID" }], warnings: parsed.warnings };
    const sanitized = sanitizeDataPayload(
      parsed.value.payload,
      parsed.warnings,
      parsed.value.schemaVersion
    );
    if (!sanitized.ok) return sanitized;
    const normalizedTemplates = normalizePortableTemplates(
      sanitized.payload,
      parsed.value.schemaVersion,
      sanitized.warnings
    );
    if (!normalizedTemplates.ok) return normalizedTemplates;
    const validated = validatePortableRecords(
      normalizedTemplates.payload,
      normalizedTemplates.warnings
    );
    if (!validated.ok) return validated;
    let canonical;
    try {
      assertOneSensePerConcept(validated.payload);
      canonical = canonicalizeDataPayload(validated.payload);
      assertOneSensePerConcept(canonical.payload);
    } catch (error) {
      if (error?.message !== "GLOSSARY_INVARIANT_VIOLATION") throw error;
      return {
        ok: false,
        errors: [{ code: "GLOSSARY_INVARIANT_VIOLATION", path: "payload.glossarySenses" }],
        warnings: validated.warnings,
      };
    }
    if (canonical.skipped) validated.warnings.push({ code: "CONCEPT_WITHOUT_SENSE_SKIPPED", count: canonical.skipped });
    const canonicalValidation = validatePortableRecords(canonical.payload, validated.warnings);
    if (!canonicalValidation.ok) return canonicalValidation;
    return { ok: true, errors: [], warnings: validated.warnings, envelope: { ...parsed.value, payload: canonical.payload }, canonical };
  }

  async function sha256Hex(value, cryptoValue) {
    const cryptoApi = cryptoValue || root.crypto;
    if (!cryptoApi?.subtle?.digest) throw new Error("WEB_CRYPTO_UNAVAILABLE");
    const bytes = new TextEncoder().encode(String(value));
    const digest = await cryptoApi.subtle.digest("SHA-256", bytes);
    return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
  }

  async function deterministicRemapId(datasetId, entityKind, originalId, attempt, cryptoValue) {
    const digest = await sha256Hex(`${datasetId}\n${entityKind}\n${originalId}\n${attempt}`, cryptoValue);
    return `${entityKind}-${digest.slice(0, 32)}`;
  }

  async function hydratePortable(payloadValue, datasetId, cryptoValue) {
    const payload = clone(payloadValue);
    const conversations = [];
    for (const item of payload.conversations) {
      conversations.push({
        ...item,
        scopeKey: item.kind === "stable"
          ? `stable:${item.host}:${item.remoteConversationId}`
          : `temporary:import-${await deterministicRemapId(datasetId, "temporary-provenance", item.id, 0, cryptoValue)}`,
        canonicalUrl: item.kind === "stable" ? `https://${item.host}/c/${item.remoteConversationId}` : null,
        orphanedAt: item.kind === "temporary" ? (item.orphanedAt ?? item.lastSeenAt) : item.orphanedAt,
      });
    }
    payload.conversations = conversations;
    payload.glossaryConcepts = payload.glossaryConcepts.map((item) => {
      const term = contract.canonicalizeTerm(item.displayTerm);
      return { ...item, canonicalTerm: term.canonicalTerm, normalizedKey: term.normalizedKey };
    });
    payload.glossarySenses = payload.glossarySenses.map((item) => ({
      ...item,
      normalizedTranslation: contract.normalizeMeaning(item.translation, 200).toLocaleLowerCase("ru-RU"),
      normalizedDefinition: contract.normalizeMeaning(item.definition, 500).toLocaleLowerCase("ru-RU"),
      naturalKey: contract.createSenseNaturalKey(item.conceptId, item.translation, item.definition),
    }));
    payload.savedItems = payload.savedItems.map((item) => ({ ...item, normalizedTextKey: contract.normalizeSavedTextKey(item.text) }));
    payload.glossaryLinks = payload.glossaryLinks.map((item) => ({ ...item, linkKey: `${item.senseId}\u001f${item.conversationId}` }));
    payload.savedItemLinks = payload.savedItemLinks.map((item) => ({ ...item, linkKey: `${item.itemId}\u001f${item.conversationId}` }));
    return payload;
  }

  async function buildDataPlan(currentValue, validatedValue, modeValue, cryptoValue) {
    const mode = modeValue === "replace" ? "replace" : "merge";
    const datasetId = validatedValue.envelope.datasetId;
    const source = await hydratePortable(validatedValue.envelope.payload, datasetId, cryptoValue);
    const sourceTemplates = templateTree.validateTypedNodes(source.templates);
    const currentTemplates = templateTree.validateTypedNodes(
      Array.isArray(currentValue?.templates) ? currentValue.templates : []
    );
    if (!sourceTemplates.ok || (mode !== "replace" && !currentTemplates.ok)) {
      throw new Error(
        sourceTemplates.error?.code
        || currentTemplates.error?.code
        || "INVALID_TEMPLATE_NODE"
      );
    }
    source.templates = sourceTemplates.nodes;
    assertOneSensePerConcept(source);
    assertOneSensePerConcept(currentValue);
    const currentForPreview = {
      ...currentValue,
      templates: currentTemplates.ok ? currentTemplates.nodes : [],
    };
    if (mode === "replace") {
      normalizeLinkOrders(source.glossaryLinks);
      normalizeLinkOrders(source.savedItemLinks);
      const preview = dataPreview(currentForPreview, source, mode, validatedValue.canonical);
      return { mode, state: source, preview, expectedCanonical: clone(source) };
    }
    const target = clone({
      templates: currentTemplates.nodes,
      conversations: Array.isArray(currentValue.conversations) ? currentValue.conversations : [],
      glossaryConcepts: Array.isArray(currentValue.glossaryConcepts) ? currentValue.glossaryConcepts : [],
      glossarySenses: Array.isArray(currentValue.glossarySenses) ? currentValue.glossarySenses : [],
      glossaryLinks: Array.isArray(currentValue.glossaryLinks) ? currentValue.glossaryLinks : [],
      savedItems: Array.isArray(currentValue.savedItems) ? currentValue.savedItems : [],
      savedItemLinks: Array.isArray(currentValue.savedItemLinks) ? currentValue.savedItemLinks : [],
    });
    const used = Object.fromEntries(DATA_ARRAYS.map((family) => [family, new Set(target[family].map((item) => item.id))]));
    const remapCount = { value: 0 };
    async function allocate(family, originalId) {
      if (!used[family].has(originalId)) { used[family].add(originalId); return originalId; }
      for (let attempt = 0; attempt < 1000; attempt += 1) {
        const candidate = await deterministicRemapId(datasetId, family, originalId, attempt, cryptoValue);
        if (!used[family].has(candidate)) { used[family].add(candidate); remapCount.value += 1; return candidate; }
      }
      throw new Error("ID_REMAP_EXHAUSTED");
    }
    const maps = {
      templates: new Map(),
      conversations: new Map(),
      glossaryConcepts: new Map(),
      glossarySenses: new Map(),
      savedItems: new Map(),
    };
    for (const item of source.templates) {
      maps.templates.set(item.id, await allocate("templates", item.id));
    }
    const incomingTemplates = source.templates.map((item) => ({
      ...item,
      id: maps.templates.get(item.id),
      parentId: item.parentId === null ? null : maps.templates.get(item.parentId),
    }));
    const mergedTemplates = templateTree.canonicalizeNodes([
      ...target.templates,
      ...incomingTemplates,
    ]);
    if (!mergedTemplates.ok) {
      throw new Error(mergedTemplates.error?.code || "INVALID_TEMPLATE_NODE");
    }
    target.templates = mergedTemplates.nodes;
    const conversationIdentity = new Map(target.conversations.filter((item) => item.kind === "stable").map((item) => [`${item.host}\u0000${item.remoteConversationId}`, item]));
    const temporaryIdentity = new Map(target.conversations.filter((item) => item.kind === "temporary" && typeof item.scopeKey === "string")
      .map((item) => [item.scopeKey, item]));
    for (const item of source.conversations) {
      const existing = item.kind === "stable"
        ? conversationIdentity.get(`${item.host}\u0000${item.remoteConversationId}`)
        : temporaryIdentity.get(item.scopeKey);
      if (existing) {
        maps.conversations.set(item.id, existing.id);
        if (item.kind === "stable") {
          existing.createdAt = Math.min(existing.createdAt, item.createdAt);
          existing.lastSeenAt = Math.max(existing.lastSeenAt, item.lastSeenAt);
          existing.orphanedAt = null;
        }
        continue;
      }
      const id = await allocate("conversations", item.id);
      const added = { ...item, id };
      target.conversations.push(added); maps.conversations.set(item.id, id);
      if (item.kind === "stable") conversationIdentity.set(`${item.host}\u0000${item.remoteConversationId}`, added);
      else temporaryIdentity.set(item.scopeKey, added);
    }
    const conceptIdentity = new Map(target.glossaryConcepts.map((item) => [item.normalizedKey, item]));
    for (const item of source.glossaryConcepts) {
      const existing = conceptIdentity.get(item.normalizedKey);
      if (existing) {
        maps.glossaryConcepts.set(item.id, existing.id);
        continue;
      }
      const id = await allocate("glossaryConcepts", item.id);
      const added = { ...item, id }; target.glossaryConcepts.push(added); conceptIdentity.set(item.normalizedKey, added); maps.glossaryConcepts.set(item.id, id);
    }
    const senseByConcept = new Map(target.glossarySenses.map((item) => [item.conceptId, item]));
    for (const original of source.glossarySenses) {
      const conceptId = maps.glossaryConcepts.get(original.conceptId) || original.conceptId;
      const key = contract.createSenseNaturalKey(conceptId, original.translation, original.definition);
      const existing = senseByConcept.get(conceptId);
      if (existing) {
        const normalizedTranslation = contract.normalizeMeaning(
          original.translation,
          200,
        ).toLocaleLowerCase("ru-RU");
        const normalizedDefinition = contract.normalizeMeaning(
          original.definition,
          500,
        ).toLocaleLowerCase("ru-RU");
        const existingTranslation = contract.normalizeMeaning(
          existing.translation,
          200,
        )?.toLocaleLowerCase("ru-RU");
        const existingDefinition = contract.normalizeMeaning(
          existing.definition,
          500,
        )?.toLocaleLowerCase("ru-RU");
        if (existingTranslation !== normalizedTranslation
          || existingDefinition !== normalizedDefinition) {
          throw new Error("GLOSSARY_IMPORT_CONFLICT");
        }
        maps.glossarySenses.set(original.id, existing.id);
        continue;
      }
      const id = await allocate("glossarySenses", original.id);
      const added = { ...original, id, conceptId, naturalKey: key };
      target.glossarySenses.push(added);
      senseByConcept.set(conceptId, added);
      maps.glossarySenses.set(original.id, id);
    }
    const savedIdentity = new Map(target.savedItems.map((item) => [contract.normalizeSavedTextKey(item.text), item]));
    for (const item of source.savedItems) {
      const key = contract.normalizeSavedTextKey(item.text);
      const existing = savedIdentity.get(key);
      if (existing) {
        maps.savedItems.set(item.id, existing.id);
        existing.createdAt = Math.min(existing.createdAt, item.createdAt);
        existing.updatedAt = Math.max(existing.updatedAt, item.updatedAt);
        continue;
      }
      const id = await allocate("savedItems", item.id);
      const added = { ...item, id, normalizedTextKey: key }; target.savedItems.push(added); savedIdentity.set(key, added); maps.savedItems.set(item.id, id);
    }
    async function mergeLinks(family, entityField, entityMap) {
      const identity = new Map(target[family].map((item) => [`${item[entityField]}\u0000${item.conversationId}`, item]));
      const nextOrder = new Map();
      target[family].forEach((item) => nextOrder.set(item.conversationId, Math.max(nextOrder.get(item.conversationId) || 0, item.localOrder + 1)));
      for (const original of source[family]) {
        const entityId = entityMap.get(original[entityField]) || original[entityField];
        const conversationId = maps.conversations.get(original.conversationId) || original.conversationId;
        const key = `${entityId}\u0000${conversationId}`;
        const existing = identity.get(key);
        if (existing) {
          existing.firstSeenAt = Math.min(existing.firstSeenAt, original.firstSeenAt);
          existing.lastSeenAt = Math.max(existing.lastSeenAt, original.lastSeenAt);
          continue;
        }
        const id = await allocate(family, original.id);
        const localOrder = nextOrder.get(conversationId) || 0;
        nextOrder.set(conversationId, localOrder + 1);
        const added = { ...original, id, [entityField]: entityId, conversationId, localOrder, linkKey: `${entityId}\u001f${conversationId}` };
        target[family].push(added);
        identity.set(key, added);
      }
    }
    await mergeLinks("glossaryLinks", "senseId", maps.glossarySenses);
    await mergeLinks("savedItemLinks", "itemId", maps.savedItems);
    assertOneSensePerConcept(target);
    const preview = dataPreview(currentValue, target, mode, validatedValue.canonical, remapCount.value);
    return { mode, state: target, preview, expectedCanonical: clone(target) };
  }

  function normalizeLinkOrders(links) {
    const groups = new Map();
    links.forEach((item) => {
      if (!groups.has(item.conversationId)) groups.set(item.conversationId, []);
      groups.get(item.conversationId).push(item);
    });
    groups.forEach((items) => items.sort((a, b) => a.localOrder - b.localOrder || a.id.localeCompare(b.id)).forEach((item, index) => { item.localOrder = index; }));
  }

  function canonicalDataState(value) {
    const payload = portablePayloadFromState(value);
    const templates = templateTree.canonicalizeNodes(payload.templates);
    if (!templates.ok) {
      throw new Error(templates.error?.code || "INVALID_TEMPLATE_NODE");
    }
    payload.templates = templates.nodes;
    ["conversations", "glossaryConcepts", "glossarySenses", "savedItems"].forEach((family) => payload[family].sort((a, b) => a.id.localeCompare(b.id)));
    ["glossaryLinks", "savedItemLinks"].forEach((family) => payload[family].sort((a, b) => a.conversationId.localeCompare(b.conversationId) || a.localOrder - b.localOrder || a.id.localeCompare(b.id)));
    return payload;
  }

  function canonicalDataEqual(left, right) {
    const verificationState = (value) => {
      const payload = canonicalDataState(value);
      const conversations = new Map((Array.isArray(value?.conversations) ? value.conversations : [])
        .map((item) => [item.id, item]));
      payload.conversations = payload.conversations.map((item) => item.kind === "temporary"
        ? { ...item, provenanceScopeKey: conversations.get(item.id)?.scopeKey || null }
        : item);
      return payload;
    };
    return canonicalStringify(verificationState(left)) === canonicalStringify(verificationState(right));
  }

  function identitySets(value) {
    const state = plain(value) ? value : {};
    const arrays = Object.fromEntries(DATA_ARRAYS.map((family) => [family, Array.isArray(state[family]) ? state[family] : []]));
    const conversationById = new Map(arrays.conversations.map((item) => [item.id, item.kind === "stable"
      ? `stable:${item.host}:${item.remoteConversationId}`
      : `temporary:${item.scopeKey || item.id}`]));
    const conceptById = new Map(arrays.glossaryConcepts.map((item) => [item.id,
      item.normalizedKey || contract.canonicalizeTerm(item.displayTerm)?.normalizedKey || item.id]));
    const senseById = new Map(arrays.glossarySenses.map((item) => [item.id, JSON.stringify([
      conceptById.get(item.conceptId) || item.conceptId,
      contract.normalizeMeaning(item.translation, 200).toLocaleLowerCase("ru-RU"),
      contract.normalizeMeaning(item.definition, 500).toLocaleLowerCase("ru-RU"),
    ])]));
    const savedById = new Map(arrays.savedItems.map((item) => [item.id,
      item.normalizedTextKey || contract.normalizeSavedTextKey(item.text)]));
    return {
      templates: new Set(arrays.templates.map((item) => JSON.stringify([
        item.id,
        item.kind,
        item.parentId,
        item.name,
        item.iconKey,
        item.kind === templateTree.NODE_KINDS.TEMPLATE ? item.content : null,
        item.kind === templateTree.NODE_KINDS.TEMPLATE ? item.autoSend === true : null,
      ]))),
      conversations: new Set(conversationById.values()),
      glossaryConcepts: new Set(conceptById.values()),
      glossarySenses: new Set(senseById.values()),
      glossaryLinks: new Set(arrays.glossaryLinks.map((item) => JSON.stringify([
        senseById.get(item.senseId) || item.senseId,
        conversationById.get(item.conversationId) || item.conversationId,
      ]))),
      savedItems: new Set(savedById.values()),
      savedItemLinks: new Set(arrays.savedItemLinks.map((item) => JSON.stringify([
        savedById.get(item.itemId) || item.itemId,
        conversationById.get(item.conversationId) || item.conversationId,
      ]))),
    };
  }

  function dataPreview(currentValue, resultValue, mode, canonical, remapped) {
    const incoming = Object.fromEntries(DATA_ARRAYS.map((family) => [family, canonical?.payload?.[family]?.length || 0]));
    const current = Object.fromEntries(DATA_ARRAYS.map((family) => [family, Array.isArray(currentValue?.[family]) ? currentValue[family].length : 0]));
    const resulting = Object.fromEntries(DATA_ARRAYS.map((family) => [family, Array.isArray(resultValue?.[family]) ? resultValue[family].length : 0]));
    const currentIdentities = identitySets(currentValue);
    const resultIdentities = identitySets(resultValue);
    const retained = Object.fromEntries(DATA_ARRAYS.map((family) => [family,
      [...resultIdentities[family]].filter((identity) => currentIdentities[family].has(identity)).length]));
    const created = Object.fromEntries(DATA_ARRAYS.map((family) => [family,
      [...resultIdentities[family]].filter((identity) => !currentIdentities[family].has(identity)).length]));
    const removed = Object.fromEntries(DATA_ARRAYS.map((family) => [family, mode === "replace"
      ? [...currentIdentities[family]].filter((identity) => !resultIdentities[family].has(identity)).length
      : 0]));
    const currentTemplateOrder = (currentValue?.templates || []).map((item) => item.id);
    const resultTemplateOrder = (resultValue?.templates || []).map((item) => item.id);
    return {
      mode, incoming, current, retained, created, removed, resulting,
      new: created,
      remapped: Number(remapped || 0),
      deduplicated: { ...Object.fromEntries(DATA_ARRAYS.map((family) => [family, 0])), ...(canonical?.deduplicatedByFamily || {}) },
      deduplicatedTotal: Number(canonical?.deduplicated || 0),
      skipped: Number(canonical?.skipped || 0),
      temporaryOrphans: (resultValue.conversations || []).filter((item) => item.kind === "temporary").length,
      orderChanged: { templates: JSON.stringify(currentTemplateOrder) !== JSON.stringify(resultTemplateOrder) },
      aggregateOnly: true,
    };
  }

  function createDataExport(stateValue, metadata) {
    const envelope = {
      format: DATA_FORMAT,
      schemaVersion: DATA_SCHEMA_VERSION,
      workspaceSchemaVersion: contract.WORKSPACE_SCHEMA_VERSION,
      datasetId: metadata?.datasetId || root.crypto?.randomUUID?.(),
      exportedAt: metadata?.exportedAt || new Date().toISOString(),
      ...(metadata?.extensionVersion ? { extensionVersion: String(metadata.extensionVersion) } : {}),
      payload: canonicalDataState(stateValue),
    };
    if (!validUuid(envelope.datasetId)) throw new Error("DATASET_ID_REQUIRED");
    const text = canonicalStringify(envelope);
    const validation = validateDataText(text);
    if (!validation.ok) throw new Error(validation.errors[0]?.code || "INVALID_GENERATED_EXPORT");
    return { filename: "chatgpt-helper-data.json", envelope, text };
  }

  const api = Object.freeze({
    SETTINGS_FORMAT, DATA_FORMAT, SETTINGS_SCHEMA_VERSION, DATA_SCHEMA_VERSION,
    SETTINGS_MAX_BYTES, DATA_MAX_BYTES,
    MAX_TEMPLATE_LENGTH, DATA_ARRAYS, byteLength, canonicalStringify, validIsoTimestamp, validUuid,
    validateSettingsPayload, validateSettingsText, buildSettingsPlan, createSettingsExport, redactSettings,
    portablePayloadFromState, validateDataText, canonicalizeDataPayload, deterministicRemapId,
    buildDataPlan, canonicalDataState, canonicalDataEqual, createDataExport,
  });

  root.ChatGPTHelperImportExport = api;
  if (typeof module === "object" && module.exports) module.exports = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
