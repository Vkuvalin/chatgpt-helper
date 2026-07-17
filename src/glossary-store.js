(function initGlossaryStore(root) {
  "use strict";

  const contract = root.ChatGPTHelperAnalysisContract
    || (typeof require === "function" ? require("./analysis-contract.js") : null);
  const SCHEMA_VERSION = 1;

  function normalizeEntry(value) {
    if (!value || typeof value !== "object") return null;
    const term = typeof value.term === "string" ? value.term.trim() : "";
    const normalizedTerm = contract.normalizeTerm(value.normalizedTerm || term);
    const translation = typeof value.translation === "string" ? value.translation.trim() : "";
    const definition = typeof value.definition === "string" ? value.definition.trim() : "";
    if (!term || !normalizedTerm || !translation || !definition) return null;
    const createdAt = Number.isFinite(value.createdAt) ? value.createdAt : Date.now();
    const updatedAt = Number.isFinite(value.updatedAt) ? value.updatedAt : createdAt;
    return {
      ...value,
      id: typeof value.id === "string" && value.id.trim() ? value.id : contract.createId("term"),
      term,
      normalizedTerm,
      translation,
      definition,
      createdAt,
      updatedAt,
    };
  }

  function normalizeEntries(value) {
    if (!Array.isArray(value)) return [];
    const ids = new Set();
    const terms = new Set();
    const result = [];
    for (const item of value) {
      const entry = normalizeEntry(item);
      if (!entry || ids.has(entry.id) || terms.has(entry.normalizedTerm)) continue;
      ids.add(entry.id);
      terms.add(entry.normalizedTerm);
      result.push(entry);
    }
    return result;
  }

  function mergeEntries(existingValue, termsValue, nowValue) {
    const entries = normalizeEntries(existingValue);
    const byTerm = new Map(entries.map((entry) => [entry.normalizedTerm, entry]));
    const seen = new Set();
    const results = [];
    const now = Number.isFinite(nowValue) ? nowValue : Date.now();

    for (const value of Array.isArray(termsValue) ? termsValue : []) {
      const normalizedTerm = contract.normalizeTerm(value?.normalizedTerm || value?.term || "");
      if (!normalizedTerm || seen.has(normalizedTerm)) continue;
      seen.add(normalizedTerm);
      const incoming = {
        term: String(value.term || "").trim(),
        normalizedTerm,
        translation: String(value.translation || "").trim(),
        definition: String(value.definition || "").trim(),
      };
      if (!incoming.term || !incoming.translation || !incoming.definition) continue;

      const saved = byTerm.get(normalizedTerm);
      if (!saved) {
        const entry = { ...incoming, id: contract.createId("term"), createdAt: now, updatedAt: now };
        entries.push(entry);
        byTerm.set(normalizedTerm, entry);
        results.push({ ...incoming, status: "new", savedEntry: entry });
        continue;
      }

      const exact = contract.normalizeComparable(saved.translation) === contract.normalizeComparable(incoming.translation)
        && contract.normalizeComparable(saved.definition) === contract.normalizeComparable(incoming.definition);
      results.push({ ...incoming, status: exact ? "alreadySaved" : "duplicate", savedEntry: saved });
    }
    return { entries, results };
  }

  function replaceEntry(existingValue, command, nowValue) {
    const entries = normalizeEntries(existingValue);
    const replacement = command?.replacement;
    const normalizedTerm = contract.normalizeTerm(replacement?.normalizedTerm || replacement?.term || "");
    if (!command || typeof command.entryId !== "string" || !replacement || !normalizedTerm) {
      return { ok: false, error: contract.makeError("GLOSSARY_STORAGE_FAILED") };
    }
    const nextReplacement = {
      term: String(replacement.term || "").trim(),
      normalizedTerm,
      translation: String(replacement.translation || "").trim(),
      definition: String(replacement.definition || "").trim(),
    };
    if (!nextReplacement.term || !nextReplacement.translation || !nextReplacement.definition) {
      return { ok: false, error: contract.makeError("GLOSSARY_STORAGE_FAILED") };
    }

    const index = entries.findIndex((entry) => entry.id === command.entryId);
    const now = Number.isFinite(nowValue) ? nowValue : Date.now();
    if (index < 0) {
      const recreated = { ...nextReplacement, id: contract.createId("term"), createdAt: now, updatedAt: now };
      entries.push(recreated);
      return { ok: true, entries, entry: recreated, recreated: true };
    }
    const current = entries[index];
    if (current.normalizedTerm !== normalizedTerm) {
      return { ok: false, error: contract.makeError("GLOSSARY_STORAGE_FAILED") };
    }
    if (Number.isFinite(command.expectedUpdatedAt) && command.expectedUpdatedAt !== current.updatedAt) {
      return { ok: false, error: contract.makeError("GLOSSARY_ENTRY_CHANGED"), current };
    }
    const updated = {
      ...current,
      ...nextReplacement,
      id: current.id,
      createdAt: current.createdAt,
      updatedAt: now > current.updatedAt ? now : current.updatedAt + 1,
    };
    entries[index] = updated;
    return { ok: true, entries, entry: updated, recreated: false };
  }

  function moveEntry(existingValue, entryId, beforeEntryId) {
    const entries = normalizeEntries(existingValue);
    const sourceIndex = entries.findIndex((entry) => entry.id === entryId);
    if (sourceIndex < 0) return { ok: false, error: contract.makeError("GLOSSARY_STORAGE_FAILED") };
    if (beforeEntryId === entryId) return { ok: true, entries };
    const moved = entries.splice(sourceIndex, 1)[0];
    const targetIndex = beforeEntryId === null
      ? entries.length
      : entries.findIndex((entry) => entry.id === beforeEntryId);
    if (targetIndex < 0) return { ok: false, error: contract.makeError("GLOSSARY_STORAGE_FAILED") };
    entries.splice(targetIndex, 0, moved);
    return { ok: true, entries };
  }

  function deleteEntry(existingValue, entryId) {
    const entries = normalizeEntries(existingValue);
    const next = entries.filter((entry) => entry.id !== entryId);
    return next.length === entries.length
      ? { ok: false, error: contract.makeError("GLOSSARY_STORAGE_FAILED") }
      : { ok: true, entries: next };
  }

  async function load() {
    const stored = await chrome.storage.local.get(["glossarySchemaVersion", "glossaryEntries"]);
    if (Number.isInteger(stored.glossarySchemaVersion) && stored.glossarySchemaVersion > SCHEMA_VERSION) {
      throw new Error("Unsupported future glossary schema.");
    }
    return { schemaVersion: SCHEMA_VERSION, entries: normalizeEntries(stored.glossaryEntries) };
  }

  async function save(entries) {
    await chrome.storage.local.set({ glossarySchemaVersion: SCHEMA_VERSION, glossaryEntries: normalizeEntries(entries) });
  }

  const api = Object.freeze({ SCHEMA_VERSION, normalizeEntry, normalizeEntries, mergeEntries, replaceEntry, moveEntry, deleteEntry, load, save });
  root.ChatGPTHelperGlossaryStore = api;
  if (typeof module === "object" && module.exports) module.exports = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
