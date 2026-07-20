(function initWorkspaceStore(root) {
  "use strict";

  if (root.ChatGPTHelperWorkspaceStore) return;

  const contract = root.ChatGPTHelperWorkspaceContract
    || (typeof require === "function" ? require("./workspace-contract.js") : null);
  const STORE_KEYS = Object.keys(contract.STORE_DEFINITIONS);
  const USER_STORE_NAMES = Object.freeze([
    contract.STORE_NAMES.CONVERSATIONS,
    contract.STORE_NAMES.GLOSSARY_CONCEPTS,
    contract.STORE_NAMES.GLOSSARY_SENSES,
    contract.STORE_NAMES.GLOSSARY_LINKS,
    contract.STORE_NAMES.SAVED_ITEMS,
    contract.STORE_NAMES.SAVED_ITEM_LINKS,
  ]);

  function clone(value) {
    return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
  }

  function nowValue(value) {
    return Number.isFinite(value) ? value : Date.now();
  }

  function createId(prefix) {
    if (typeof root.crypto?.randomUUID === "function") return root.crypto.randomUUID();
    return `${prefix || "workspace"}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  }

  function metaRecord(key, value, updatedAt) {
    return { key, value, updatedAt };
  }

  function createEmptyState(timestamp) {
    const now = nowValue(timestamp);
    return {
      meta: [
        metaRecord("workspaceSchemaVersion", contract.WORKSPACE_SCHEMA_VERSION, now),
        metaRecord("v1GlossaryMigrationState", null, now),
        metaRecord("lastMigrationAt", null, now),
        metaRecord("lastImportAt", null, now),
      ],
      conversations: [],
      glossaryConcepts: [],
      glossarySenses: [],
      glossaryLinks: [],
      savedItems: [],
      savedItemLinks: [],
      importBackups: [],
    };
  }

  function normalizeState(value, timestamp) {
    const state = createEmptyState(timestamp);
    const source = value && typeof value === "object" ? value : {};
    STORE_KEYS.forEach((name) => {
      if (Array.isArray(source[name])) state[name] = clone(source[name]);
    });
    ensureMeta(state, timestamp);
    return state;
  }

  function getMeta(state, key) {
    return state.meta.find((item) => item.key === key) || null;
  }

  function setMeta(state, key, value, timestamp) {
    const record = metaRecord(key, value, nowValue(timestamp));
    const index = state.meta.findIndex((item) => item.key === key);
    if (index < 0) state.meta.push(record);
    else state.meta[index] = record;
    return record;
  }

  function ensureMeta(state, timestamp) {
    const now = nowValue(timestamp);
    if (!getMeta(state, "workspaceSchemaVersion")) setMeta(state, "workspaceSchemaVersion", contract.WORKSPACE_SCHEMA_VERSION, now);
    if (!getMeta(state, "v1GlossaryMigrationState")) setMeta(state, "v1GlossaryMigrationState", null, now);
    if (!getMeta(state, "lastMigrationAt")) setMeta(state, "lastMigrationAt", null, now);
    if (!getMeta(state, "lastImportAt")) setMeta(state, "lastImportAt", null, now);
  }

  function bumpRevision(state, family, timestamp) {
    const key = `revision:${family}`;
    const revision = Number(getMeta(state, key)?.value || 0) + 1;
    setMeta(state, key, revision, timestamp);
    return revision;
  }

  function validTimestamp(value, fallback) {
    return Number.isFinite(value) && value >= 0 ? value : fallback;
  }

  function conversationByScope(state, scopeKey) {
    return state.conversations.find((item) => item.scopeKey === scopeKey) || null;
  }

  function stableDescriptor(value) {
    if (!value || value.kind !== "stable" || !contract.isSupportedHost(value.host)
      || typeof value.remoteConversationId !== "string"
      || !/^[A-Za-z0-9_-]{1,200}$/.test(value.remoteConversationId)) return null;
    const host = value.host.toLocaleLowerCase("en-US");
    return {
      kind: "stable",
      host,
      remoteConversationId: value.remoteConversationId,
      scopeKey: `stable:${host}:${value.remoteConversationId}`,
      canonicalUrl: `https://${host}/c/${encodeURIComponent(value.remoteConversationId)}`,
    };
  }

  function temporaryDescriptor(scopeKey, host) {
    if (!contract.isScopeKey(scopeKey) || !scopeKey.startsWith("temporary:") || !contract.isSupportedHost(host)) return null;
    return {
      kind: "temporary",
      host: String(host).toLocaleLowerCase("en-US"),
      remoteConversationId: null,
      scopeKey,
      canonicalUrl: null,
    };
  }

  function ensureConversationInState(state, descriptorValue, timestamp, idFactory) {
    const now = nowValue(timestamp);
    const descriptor = descriptorValue?.kind === "stable"
      ? stableDescriptor(descriptorValue)
      : temporaryDescriptor(descriptorValue?.scopeKey, descriptorValue?.host);
    if (!descriptor) throw new Error("INVALID_CONVERSATION");
    const existing = conversationByScope(state, descriptor.scopeKey);
    if (existing) {
      existing.lastSeenAt = Math.max(validTimestamp(existing.lastSeenAt, now), now);
      if (existing.kind === "temporary") existing.orphanedAt = null;
      return existing;
    }
    const conversation = {
      id: idFactory("conversation"),
      scopeKey: descriptor.scopeKey,
      kind: descriptor.kind,
      host: descriptor.host,
      remoteConversationId: descriptor.remoteConversationId,
      canonicalUrl: descriptor.canonicalUrl,
      createdAt: now,
      lastSeenAt: now,
      orphanedAt: null,
    };
    state.conversations.push(conversation);
    return conversation;
  }

  function linkKey(entityId, conversationId) {
    return `${entityId}\u001f${conversationId}`;
  }

  function nextLocalOrder(links, conversationId) {
    const orders = links.filter((item) => item.conversationId === conversationId).map((item) => Number(item.localOrder));
    return orders.length ? Math.max(...orders.filter(Number.isFinite), -1) + 1 : 0;
  }

  function ensureLink(links, entityField, entityId, conversationId, timestamp, idFactory) {
    const key = linkKey(entityId, conversationId);
    const existing = links.find((item) => item.linkKey === key);
    const now = nowValue(timestamp);
    if (existing) {
      existing.lastSeenAt = Math.max(validTimestamp(existing.lastSeenAt, now), now);
      return { link: existing, created: false };
    }
    const item = {
      id: idFactory("link"),
      [entityField]: entityId,
      conversationId,
      linkKey: key,
      localOrder: nextLocalOrder(links, conversationId),
      firstSeenAt: now,
      lastSeenAt: now,
    };
    links.push(item);
    return { link: item, created: true };
  }

  function migrateLegacyInState(state, entriesValue, timestamp, idFactory) {
    const existingMarker = getMeta(state, "v1GlossaryMigrationState")?.value;
    if (existingMarker?.status === "complete") return { migrated: false, marker: clone(existingMarker) };
    const now = nowValue(timestamp);
    let migratedCount = 0;
    let skippedCount = 0;
    const entries = Array.isArray(entriesValue) ? entriesValue : [];

    entries.forEach((entry) => {
      const term = contract.canonicalizeTerm(entry?.term || entry?.normalizedTerm || "");
      const translation = contract.normalizeMeaning(entry?.translation, 200);
      const definition = contract.normalizeMeaning(entry?.definition, 500);
      if (!term || !translation || !definition) {
        skippedCount += 1;
        return;
      }
      const createdAt = validTimestamp(entry.createdAt, now);
      const updatedAt = Math.max(createdAt, validTimestamp(entry.updatedAt, createdAt));
      let concept = state.glossaryConcepts.find((item) => item.normalizedKey === term.normalizedKey);
      if (!concept) {
        concept = {
          id: idFactory("concept"),
          displayTerm: term.displayTerm,
          canonicalTerm: term.canonicalTerm,
          normalizedKey: term.normalizedKey,
          createdAt,
          updatedAt,
        };
        state.glossaryConcepts.push(concept);
      } else {
        concept.createdAt = Math.min(validTimestamp(concept.createdAt, createdAt), createdAt);
        concept.updatedAt = Math.max(validTimestamp(concept.updatedAt, updatedAt), updatedAt);
      }
      const naturalKey = contract.createSenseNaturalKey(concept.id, translation, definition);
      let sense = state.glossarySenses.find((item) => item.naturalKey === naturalKey);
      if (!sense) {
        sense = {
          id: idFactory("sense"),
          conceptId: concept.id,
          translation,
          definition,
          normalizedTranslation: contract.normalizeMeaning(translation, 200).toLocaleLowerCase("ru-RU"),
          normalizedDefinition: contract.normalizeMeaning(definition, 500).toLocaleLowerCase("ru-RU"),
          naturalKey,
          createdAt,
          updatedAt,
        };
        state.glossarySenses.push(sense);
      } else {
        sense.createdAt = Math.min(validTimestamp(sense.createdAt, createdAt), createdAt);
        sense.updatedAt = Math.max(validTimestamp(sense.updatedAt, updatedAt), updatedAt);
      }
      migratedCount += 1;
    });

    const marker = {
      status: "complete",
      sourceSchemaVersion: 1,
      sourceCount: entries.length,
      migratedCount,
      skippedCount,
    };
    setMeta(state, "v1GlossaryMigrationState", marker, now);
    setMeta(state, "lastMigrationAt", now, now);
    if (migratedCount) bumpRevision(state, contract.ENTITY_FAMILIES.GLOSSARY, now);
    return { migrated: true, marker: clone(marker) };
  }

  function mergeReboundLinks(links, entityField, temporaryId, stableId) {
    const sourceLinks = links.filter((item) => item.conversationId === temporaryId);
    sourceLinks.forEach((source) => {
      const entityId = source[entityField];
      const targetKey = linkKey(entityId, stableId);
      const target = links.find((item) => item.linkKey === targetKey);
      if (target) {
        target.localOrder = Math.min(Number(target.localOrder) || 0, Number(source.localOrder) || 0);
        target.firstSeenAt = Math.min(validTimestamp(target.firstSeenAt, source.firstSeenAt), validTimestamp(source.firstSeenAt, target.firstSeenAt));
        target.lastSeenAt = Math.max(validTimestamp(target.lastSeenAt, source.lastSeenAt), validTimestamp(source.lastSeenAt, target.lastSeenAt));
        links.splice(links.indexOf(source), 1);
      } else {
        source.conversationId = stableId;
        source.linkKey = targetKey;
      }
    });
    return sourceLinks.length;
  }

  function rebindInState(state, temporaryScope, stableValue, timestamp, idFactory) {
    const stable = ensureConversationInState(state, stableValue, timestamp, idFactory);
    const temporary = conversationByScope(state, temporaryScope);
    if (!temporary || temporary.kind !== "temporary") {
      return { context: clone(stable), rebound: false, glossaryLinksMoved: 0, savedLinksMoved: 0 };
    }
    const glossaryLinksMoved = mergeReboundLinks(state.glossaryLinks, "senseId", temporary.id, stable.id);
    const savedLinksMoved = mergeReboundLinks(state.savedItemLinks, "itemId", temporary.id, stable.id);
    state.conversations.splice(state.conversations.indexOf(temporary), 1);
    return { context: clone(stable), rebound: true, glossaryLinksMoved, savedLinksMoved };
  }

  function orphanInState(state, temporaryScope, timestamp) {
    const conversation = conversationByScope(state, temporaryScope);
    if (!conversation || conversation.kind !== "temporary") return { orphaned: false };
    if (conversation.orphanedAt === null) conversation.orphanedAt = nowValue(timestamp);
    return { orphaned: true, context: clone(conversation) };
  }

  function conceptAndSense(state, value, timestamp, idFactory) {
    const term = contract.canonicalizeTerm(value?.term || value?.displayTerm || "");
    const translation = contract.normalizeMeaning(value?.translation, 200);
    const definition = contract.normalizeMeaning(value?.definition, 500);
    if (!term || !translation || !definition) return null;
    const now = nowValue(timestamp);
    let concept = state.glossaryConcepts.find((item) => item.normalizedKey === term.normalizedKey);
    const conceptCreated = !concept;
    if (!concept) {
      concept = {
        id: idFactory("concept"),
        displayTerm: term.displayTerm,
        canonicalTerm: term.canonicalTerm,
        normalizedKey: term.normalizedKey,
        createdAt: now,
        updatedAt: now,
      };
      state.glossaryConcepts.push(concept);
    }
    const naturalKey = contract.createSenseNaturalKey(concept.id, translation, definition);
    let sense = state.glossarySenses.find((item) => item.naturalKey === naturalKey);
    const senseCreated = !sense;
    if (!sense) {
      sense = {
        id: idFactory("sense"),
        conceptId: concept.id,
        translation,
        definition,
        normalizedTranslation: translation.toLocaleLowerCase("ru-RU"),
        normalizedDefinition: definition.toLocaleLowerCase("ru-RU"),
        naturalKey,
        createdAt: now,
        updatedAt: now,
      };
      state.glossarySenses.push(sense);
      concept.updatedAt = Math.max(validTimestamp(concept.updatedAt, now), now);
    }
    return { concept, sense, conceptCreated, senseCreated };
  }

  function publicSense(state, sense, link) {
    const concept = state.glossaryConcepts.find((item) => item.id === sense.conceptId);
    if (!concept) return null;
    return {
      id: sense.id,
      senseId: sense.id,
      conceptId: concept.id,
      term: concept.displayTerm,
      canonicalTerm: concept.canonicalTerm,
      normalizedTerm: concept.normalizedKey,
      translation: sense.translation,
      definition: sense.definition,
      createdAt: sense.createdAt,
      updatedAt: sense.updatedAt,
      attached: Boolean(link),
      ...(link ? { linkId: link.id, localOrder: link.localOrder } : {}),
    };
  }

  function addGlossaryTermsInState(state, termsValue, conversationScope, timestamp, idFactory) {
    const conversation = conversationByScope(state, conversationScope);
    if (!conversation) throw new Error("CONVERSATION_NOT_FOUND");
    const results = [];
    let changed = false;
    (Array.isArray(termsValue) ? termsValue : []).forEach((termValue) => {
      const resolved = conceptAndSense(state, termValue, timestamp, idFactory);
      if (!resolved) return;
      const linked = ensureLink(state.glossaryLinks, "senseId", resolved.sense.id, conversation.id, timestamp, idFactory);
      changed = changed || resolved.conceptCreated || resolved.senseCreated || linked.created;
      const candidates = resolved.senseCreated
        ? state.glossarySenses.filter((item) => item.id !== resolved.sense.id
          && item.conceptId === resolved.concept.id
          && item.normalizedTranslation === resolved.sense.normalizedTranslation
          && item.normalizedDefinition !== resolved.sense.normalizedDefinition)
        : [];
      const candidate = candidates.length === 1 ? candidates[0] : null;
      const result = {
        ...publicSense(state, resolved.sense, linked.link),
        status: candidate ? "duplicate" : (resolved.senseCreated ? "new" : "alreadySaved"),
        savedEntry: publicSense(state, resolved.sense, linked.link),
      };
      if (candidate) {
        result.savedEntry = publicSense(state, candidate, null);
        result.replacementCandidate = {
          status: "single",
          targetSenseId: candidate.id,
          expectedUpdatedAt: candidate.updatedAt,
          newSenseId: resolved.sense.id,
          current: {
            translation: candidate.translation,
            definition: candidate.definition,
          },
        };
      } else if (candidates.length > 1) {
        result.replacementCandidate = { status: "multiple", count: candidates.length };
      }
      results.push(result);
    });
    const revision = changed ? bumpRevision(state, contract.ENTITY_FAMILIES.GLOSSARY, timestamp) : Number(getMeta(state, `revision:${contract.ENTITY_FAMILIES.GLOSSARY}`)?.value || 0);
    return { results, changed, revision };
  }

  function queryGlossaryInState(state, queryValue) {
    const request = queryValue || {};
    const mode = contract.normalizeMode(request.mode);
    const query = contract.normalizeSearchQuery(request.query);
    const limit = contract.boundedLimit(request.limit);
    const conversation = conversationByScope(state, request.conversationScope);
    if (!conversation) return [];
    if (mode === "global" && !query) return [];
    if (mode === "local") {
      return state.glossaryLinks
        .filter((link) => link.conversationId === conversation.id)
        .sort((left, right) => left.localOrder - right.localOrder || left.firstSeenAt - right.firstSeenAt)
        .map((link) => {
          const sense = state.glossarySenses.find((item) => item.id === link.senseId);
          return sense ? publicSense(state, sense, link) : null;
        })
        .filter((item) => item && contract.matchesAllTokens(`${item.term} ${item.translation} ${item.definition}`, query))
        .slice(0, limit);
    }
    return state.glossarySenses
      .map((sense) => publicSense(state, sense, state.glossaryLinks.find((link) => (
        link.senseId === sense.id && link.conversationId === conversation.id
      ))))
      .filter((item) => item && contract.matchesAllTokens(`${item.term} ${item.translation} ${item.definition}`, query))
      .sort((left, right) => right.updatedAt - left.updatedAt || left.term.localeCompare(right.term))
      .slice(0, limit);
  }

  function attachGlossaryInState(state, senseId, conversationScope, timestamp, idFactory) {
    const conversation = conversationByScope(state, conversationScope);
    const sense = state.glossarySenses.find((item) => item.id === senseId);
    if (!conversation || !sense) throw new Error("GLOSSARY_NOT_FOUND");
    const result = ensureLink(state.glossaryLinks, "senseId", senseId, conversation.id, timestamp, idFactory);
    const revision = result.created ? bumpRevision(state, contract.ENTITY_FAMILIES.GLOSSARY, timestamp) : Number(getMeta(state, `revision:${contract.ENTITY_FAMILIES.GLOSSARY}`)?.value || 0);
    return { changed: result.created, entry: publicSense(state, sense, result.link), revision };
  }

  function reorderLinks(links, entityField, entityId, beforeEntityId, conversationId) {
    const local = links.filter((item) => item.conversationId === conversationId)
      .sort((left, right) => left.localOrder - right.localOrder || left.firstSeenAt - right.firstSeenAt);
    const sourceIndex = local.findIndex((item) => item[entityField] === entityId);
    if (sourceIndex < 0) throw new Error("LINK_NOT_FOUND");
    const [moved] = local.splice(sourceIndex, 1);
    const targetIndex = beforeEntityId === null ? local.length : local.findIndex((item) => item[entityField] === beforeEntityId);
    if (targetIndex < 0) throw new Error("TARGET_LINK_NOT_FOUND");
    local.splice(targetIndex, 0, moved);
    local.forEach((item, index) => { item.localOrder = index; });
  }

  function moveGlossaryInState(state, senseId, beforeSenseId, conversationScope, timestamp) {
    const conversation = conversationByScope(state, conversationScope);
    if (!conversation) throw new Error("CONVERSATION_NOT_FOUND");
    reorderLinks(state.glossaryLinks, "senseId", senseId, beforeSenseId, conversation.id);
    return { changed: true, revision: bumpRevision(state, contract.ENTITY_FAMILIES.GLOSSARY, timestamp) };
  }

  function unlinkGlossaryInState(state, senseId, conversationScope, timestamp) {
    const conversation = conversationByScope(state, conversationScope);
    if (!conversation) throw new Error("CONVERSATION_NOT_FOUND");
    const index = state.glossaryLinks.findIndex((item) => item.senseId === senseId && item.conversationId === conversation.id);
    if (index < 0) return { changed: false, revision: Number(getMeta(state, `revision:${contract.ENTITY_FAMILIES.GLOSSARY}`)?.value || 0) };
    state.glossaryLinks.splice(index, 1);
    return { changed: true, revision: bumpRevision(state, contract.ENTITY_FAMILIES.GLOSSARY, timestamp) };
  }

  function deleteGlossarySenseInState(state, senseId, timestamp) {
    const index = state.glossarySenses.findIndex((item) => item.id === senseId);
    if (index < 0) return { changed: false, revision: Number(getMeta(state, `revision:${contract.ENTITY_FAMILIES.GLOSSARY}`)?.value || 0) };
    const [sense] = state.glossarySenses.splice(index, 1);
    state.glossaryLinks = state.glossaryLinks.filter((item) => item.senseId !== senseId);
    if (!state.glossarySenses.some((item) => item.conceptId === sense.conceptId)) {
      state.glossaryConcepts = state.glossaryConcepts.filter((item) => item.id !== sense.conceptId);
    }
    return { changed: true, revision: bumpRevision(state, contract.ENTITY_FAMILIES.GLOSSARY, timestamp) };
  }

  function replaceGlossarySenseInState(state, command, timestamp) {
    const sense = state.glossarySenses.find((item) => item.id === command?.senseId);
    if (!sense) throw new Error("GLOSSARY_NOT_FOUND");
    const current = publicSense(state, sense, null);
    if (!Number.isFinite(command?.expectedUpdatedAt)) throw new Error("INVALID_GLOSSARY_REPLACEMENT");
    if (command.expectedUpdatedAt !== sense.updatedAt) {
      return { ok: false, stale: true, current };
    }
    const source = state.glossarySenses.find((item) => item.id === command?.sourceSenseId);
    const concept = state.glossaryConcepts.find((item) => item.id === sense.conceptId);
    if (!concept || !source || source.id === sense.id || source.conceptId !== sense.conceptId
      || source.normalizedTranslation !== sense.normalizedTranslation
      || source.normalizedDefinition === sense.normalizedDefinition) {
      throw new Error("INVALID_GLOSSARY_REPLACEMENT");
    }
    const naturalKey = contract.createSenseNaturalKey(concept.id, source.translation, source.definition);
    if (state.glossarySenses.some((item) => item.id !== sense.id && item.naturalKey === naturalKey)) {
      if (source.naturalKey !== naturalKey) throw new Error("GLOSSARY_SENSE_CONFLICT");
    }
    const now = Math.max(nowValue(timestamp), Number(sense.updatedAt) + 1);
    const sourceLinks = state.glossaryLinks.filter((item) => item.senseId === source.id);
    sourceLinks.forEach((sourceLink) => {
      const targetKey = linkKey(sense.id, sourceLink.conversationId);
      const targetLink = state.glossaryLinks.find((item) => item.linkKey === targetKey);
      if (targetLink) {
        targetLink.localOrder = Math.min(Number(targetLink.localOrder) || 0, Number(sourceLink.localOrder) || 0);
        targetLink.firstSeenAt = Math.min(validTimestamp(targetLink.firstSeenAt, sourceLink.firstSeenAt), validTimestamp(sourceLink.firstSeenAt, targetLink.firstSeenAt));
        targetLink.lastSeenAt = Math.max(validTimestamp(targetLink.lastSeenAt, sourceLink.lastSeenAt), validTimestamp(sourceLink.lastSeenAt, targetLink.lastSeenAt));
        state.glossaryLinks.splice(state.glossaryLinks.indexOf(sourceLink), 1);
      } else {
        sourceLink.senseId = sense.id;
        sourceLink.linkKey = targetKey;
      }
    });
    state.glossarySenses.splice(state.glossarySenses.indexOf(source), 1);
    sense.translation = source.translation;
    sense.definition = source.definition;
    sense.normalizedTranslation = source.normalizedTranslation;
    sense.normalizedDefinition = source.normalizedDefinition;
    sense.naturalKey = naturalKey;
    sense.updatedAt = now;
    concept.updatedAt = Math.max(Number(concept.updatedAt) || 0, now);
    return { ok: true, entry: publicSense(state, sense, null), revision: bumpRevision(state, contract.ENTITY_FAMILIES.GLOSSARY, now) };
  }

  function publicSavedItem(item, link) {
    return {
      id: item.id,
      itemId: item.id,
      text: item.text,
      createdAt: item.createdAt,
      updatedAt: item.updatedAt,
      attached: Boolean(link),
      ...(link ? { linkId: link.id, localOrder: link.localOrder } : {}),
    };
  }

  function saveSelectionInState(state, textValue, conversationScope, timestamp, idFactory) {
    const conversation = conversationByScope(state, conversationScope);
    const validated = contract.validateSavedText(textValue);
    if (!conversation || !validated.ok) throw new Error(!conversation ? "CONVERSATION_NOT_FOUND" : validated.error);
    const now = nowValue(timestamp);
    let item = state.savedItems.find((value) => value.normalizedTextKey === validated.normalizedTextKey);
    const itemCreated = !item;
    if (!item) {
      item = {
        id: idFactory("saved"),
        text: validated.text,
        normalizedTextKey: validated.normalizedTextKey,
        createdAt: now,
        updatedAt: now,
      };
      state.savedItems.push(item);
    }
    const linked = ensureLink(state.savedItemLinks, "itemId", item.id, conversation.id, now, idFactory);
    const changed = itemCreated || linked.created;
    const revision = changed ? bumpRevision(state, contract.ENTITY_FAMILIES.SAVED, now) : Number(getMeta(state, `revision:${contract.ENTITY_FAMILIES.SAVED}`)?.value || 0);
    return { changed, item: publicSavedItem(item, linked.link), revision };
  }

  function querySavedInState(state, queryValue) {
    const request = queryValue || {};
    const mode = contract.normalizeMode(request.mode);
    const query = contract.normalizeSearchQuery(request.query);
    const limit = contract.boundedLimit(request.limit);
    const conversation = conversationByScope(state, request.conversationScope);
    if (!conversation) return [];
    if (mode === "global" && !query) return [];
    if (mode === "local") {
      return state.savedItemLinks
        .filter((link) => link.conversationId === conversation.id)
        .sort((left, right) => left.localOrder - right.localOrder || left.firstSeenAt - right.firstSeenAt)
        .map((link) => {
          const item = state.savedItems.find((value) => value.id === link.itemId);
          return item ? publicSavedItem(item, link) : null;
        })
        .filter((item) => item && contract.matchesAllTokens(item.text, query))
        .slice(0, limit);
    }
    return state.savedItems
      .map((item) => publicSavedItem(item, state.savedItemLinks.find((link) => (
        link.itemId === item.id && link.conversationId === conversation.id
      ))))
      .filter((item) => contract.matchesAllTokens(item.text, query))
      .sort((left, right) => right.updatedAt - left.updatedAt)
      .slice(0, limit);
  }

  function moveSavedInState(state, itemId, beforeItemId, conversationScope, timestamp) {
    const conversation = conversationByScope(state, conversationScope);
    if (!conversation) throw new Error("CONVERSATION_NOT_FOUND");
    reorderLinks(state.savedItemLinks, "itemId", itemId, beforeItemId, conversation.id);
    return { changed: true, revision: bumpRevision(state, contract.ENTITY_FAMILIES.SAVED, timestamp) };
  }

  function unlinkSavedInState(state, itemId, conversationScope, timestamp) {
    const conversation = conversationByScope(state, conversationScope);
    if (!conversation) throw new Error("CONVERSATION_NOT_FOUND");
    const index = state.savedItemLinks.findIndex((item) => item.itemId === itemId && item.conversationId === conversation.id);
    if (index < 0) return { changed: false, revision: Number(getMeta(state, `revision:${contract.ENTITY_FAMILIES.SAVED}`)?.value || 0) };
    state.savedItemLinks.splice(index, 1);
    return { changed: true, revision: bumpRevision(state, contract.ENTITY_FAMILIES.SAVED, timestamp) };
  }

  function deleteSavedInState(state, itemId, timestamp) {
    const index = state.savedItems.findIndex((item) => item.id === itemId);
    if (index < 0) return { changed: false, revision: Number(getMeta(state, `revision:${contract.ENTITY_FAMILIES.SAVED}`)?.value || 0) };
    state.savedItems.splice(index, 1);
    state.savedItemLinks = state.savedItemLinks.filter((item) => item.itemId !== itemId);
    return { changed: true, revision: bumpRevision(state, contract.ENTITY_FAMILIES.SAVED, timestamp) };
  }

  class WorkspaceOperations {
    constructor(options) {
      this.idFactory = options?.createId || createId;
      this.now = options?.now || (() => Date.now());
    }

    initialize() {
      return this._write(["meta"], (state) => {
        ensureMeta(state, this.now());
        return { ok: true };
      });
    }

    migrateLegacyGlossary(entries) {
      return this._write(["meta", "glossaryConcepts", "glossarySenses", "glossaryLinks"], (state) => (
        migrateLegacyInState(state, entries, this.now(), this.idFactory)
      ));
    }

    ensureConversation(descriptor) {
      return this._write(["meta", "conversations"], (state) => {
        const existing = conversationByScope(state, descriptor?.scopeKey);
        const context = ensureConversationInState(state, descriptor, this.now(), this.idFactory);
        const revision = existing ? Number(getMeta(state, `revision:${contract.ENTITY_FAMILIES.CONVERSATIONS}`)?.value || 0)
          : bumpRevision(state, contract.ENTITY_FAMILIES.CONVERSATIONS, this.now());
        return { context: clone(context), created: !existing, revision };
      });
    }

    rebindConversation(temporaryScope, stable) {
      return this._write(["meta", "conversations", "glossaryLinks", "savedItemLinks"], (state) => {
        const result = rebindInState(state, temporaryScope, stable, this.now(), this.idFactory);
        if (result.rebound) result.revision = bumpRevision(state, contract.ENTITY_FAMILIES.CONVERSATIONS, this.now());
        return result;
      });
    }

    orphanConversation(temporaryScope) {
      return this._write(["meta", "conversations"], (state) => {
        const result = orphanInState(state, temporaryScope, this.now());
        if (result.orphaned) result.revision = bumpRevision(state, contract.ENTITY_FAMILIES.CONVERSATIONS, this.now());
        return result;
      });
    }

    addAnalysisTerms(terms, conversationScope) {
      return this._write(["meta", "conversations", "glossaryConcepts", "glossarySenses", "glossaryLinks"], (state) => (
        addGlossaryTermsInState(state, terms, conversationScope, this.now(), this.idFactory)
      ));
    }

    queryGlossary(request) {
      return this._read(["conversations", "glossaryConcepts", "glossarySenses", "glossaryLinks"], (state) => (
        queryGlossaryInState(state, request)
      ));
    }

    attachGlossarySense(senseId, conversationScope) {
      return this._write(["meta", "conversations", "glossaryConcepts", "glossarySenses", "glossaryLinks"], (state) => (
        attachGlossaryInState(state, senseId, conversationScope, this.now(), this.idFactory)
      ));
    }

    moveGlossaryLink(senseId, beforeSenseId, conversationScope) {
      return this._write(["meta", "conversations", "glossaryLinks"], (state) => (
        moveGlossaryInState(state, senseId, beforeSenseId, conversationScope, this.now())
      ));
    }

    unlinkGlossary(senseId, conversationScope) {
      return this._write(["meta", "conversations", "glossaryLinks"], (state) => (
        unlinkGlossaryInState(state, senseId, conversationScope, this.now())
      ));
    }

    deleteGlossarySense(senseId) {
      return this._write(["meta", "glossaryConcepts", "glossarySenses", "glossaryLinks"], (state) => (
        deleteGlossarySenseInState(state, senseId, this.now())
      ));
    }

    replaceGlossarySense(command) {
      return this._write(["meta", "glossaryConcepts", "glossarySenses"], (state) => (
        replaceGlossarySenseInState(state, command, this.now())
      ));
    }

    saveSelection(text, conversationScope) {
      return this._write(["meta", "conversations", "savedItems", "savedItemLinks"], (state) => (
        saveSelectionInState(state, text, conversationScope, this.now(), this.idFactory)
      ));
    }

    querySaved(request) {
      return this._read(["conversations", "savedItems", "savedItemLinks"], (state) => querySavedInState(state, request));
    }

    moveSavedLink(itemId, beforeItemId, conversationScope) {
      return this._write(["meta", "conversations", "savedItemLinks"], (state) => (
        moveSavedInState(state, itemId, beforeItemId, conversationScope, this.now())
      ));
    }

    unlinkSaved(itemId, conversationScope) {
      return this._write(["meta", "conversations", "savedItemLinks"], (state) => (
        unlinkSavedInState(state, itemId, conversationScope, this.now())
      ));
    }

    deleteSavedItem(itemId) {
      return this._write(["meta", "savedItems", "savedItemLinks"], (state) => deleteSavedInState(state, itemId, this.now()));
    }

    getMetaValue(key) {
      return this._read(["meta"], (state) => clone(getMeta(state, key)?.value ?? null));
    }

    setMetaValue(key, value) {
      return this._write(["meta"], (state) => {
        setMeta(state, key, clone(value), this.now());
        return { ok: true };
      });
    }

    deleteMetaValue(key) {
      return this._write(["meta"], (state) => {
        const index = state.meta.findIndex((item) => item.key === key);
        if (index >= 0) state.meta.splice(index, 1);
        return { ok: true, changed: index >= 0 };
      });
    }

    snapshotUserData() {
      return this._read(USER_STORE_NAMES, (state) => Object.fromEntries(
        USER_STORE_NAMES.map((name) => [name, clone(state[name])]),
      ));
    }

    getImportBackup(kind) {
      return this._read(["importBackups"], (state) => clone(state.importBackups.find((item) => item.kind === kind) || null));
    }

    putImportBackup(kind, payload) {
      return this._write(["importBackups"], (state) => {
        const record = { kind, createdAt: this.now(), schemaVersion: 1, payload: clone(payload) };
        const index = state.importBackups.findIndex((item) => item.kind === kind);
        if (index < 0) state.importBackups.push(record); else state.importBackups[index] = record;
        return clone(record);
      });
    }

    replaceUserData(nextValue) {
      return this._write(["meta", ...USER_STORE_NAMES], (state) => {
        USER_STORE_NAMES.forEach((name) => { state[name] = clone(Array.isArray(nextValue?.[name]) ? nextValue[name] : []); });
        return { changed: true, revision: bumpRevision(state, contract.ENTITY_FAMILIES.ALL, this.now()) };
      });
    }

    mergeUserData(nextValue) {
      return this._write(["meta", ...USER_STORE_NAMES], (state) => {
        let changed = false;
        USER_STORE_NAMES.forEach((name) => {
          const byId = new Map(state[name].map((item) => [item.id, item]));
          (Array.isArray(nextValue?.[name]) ? nextValue[name] : []).forEach((item) => {
            const existing = byId.get(item.id);
            if (!existing) {
              const added = clone(item);
              state[name].push(added);
              byId.set(item.id, added);
              changed = true;
            } else if (JSON.stringify(existing) !== JSON.stringify(item)) {
              const index = state[name].findIndex((record) => record.id === item.id);
              state[name][index] = clone(item);
              byId.set(item.id, state[name][index]);
              changed = true;
            }
          });
        });
        const revisionRecord = state.meta.find((item) => item.key === "revision:all");
        return {
          changed,
          revision: changed
            ? bumpRevision(state, contract.ENTITY_FAMILIES.ALL, this.now())
            : Number(revisionRecord?.value || 0),
        };
      });
    }
  }

  class MemoryWorkspaceStore extends WorkspaceOperations {
    constructor(initialState, options) {
      super(options);
      this.state = normalizeState(initialState, this.now());
      this.failure = null;
    }

    failNextWrite(error) {
      this.failure = error || new Error("INJECTED_TRANSACTION_FAILURE");
    }

    async _read(_names, operation) {
      return clone(operation(clone(this.state)));
    }

    async _write(_names, operation) {
      const working = clone(this.state);
      const result = operation(working);
      if (this.failure) {
        const failure = this.failure;
        this.failure = null;
        throw failure;
      }
      this.state = normalizeState(working, this.now());
      return clone(result);
    }

    snapshot() {
      return clone(this.state);
    }
  }

  function openWorkspaceDatabase(indexedDbValue) {
    const indexedDb = indexedDbValue || root.indexedDB;
    if (!indexedDb?.open) return Promise.reject(new Error("INDEXEDDB_UNAVAILABLE"));
    return new Promise((resolve, reject) => {
      const request = indexedDb.open(contract.DB_NAME, contract.DB_VERSION);
      request.onupgradeneeded = () => {
        const database = request.result;
        Object.entries(contract.STORE_DEFINITIONS).forEach(([name, definition]) => {
          const store = database.objectStoreNames.contains(name)
            ? request.transaction.objectStore(name)
            : database.createObjectStore(name, { keyPath: definition.keyPath });
          definition.indexes.forEach((index) => {
            if (!store.indexNames.contains(index.name)) {
              store.createIndex(index.name, index.keyPath, { unique: index.unique });
            }
          });
        });
        const meta = request.transaction.objectStore(contract.STORE_NAMES.META);
        createEmptyState(Date.now()).meta.forEach((record) => meta.put(record));
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error || new Error("WORKSPACE_DATABASE_OPEN_FAILED"));
      request.onblocked = () => reject(new Error("WORKSPACE_DATABASE_BLOCKED"));
    });
  }

  function requestValue(request) {
    return new Promise((resolve, reject) => {
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error || new Error("INDEXEDDB_REQUEST_FAILED"));
    });
  }

  function orderedConversationRange(conversationId) {
    if (root.IDBKeyRange?.bound) return root.IDBKeyRange.bound([conversationId], [conversationId, []]);
    return { lower: [conversationId], upper: [conversationId, []] };
  }

  function cursorValues(source, query, direction, maximum) {
    const limit = Number.isFinite(maximum) ? Math.max(0, maximum) : Infinity;
    return new Promise((resolve, reject) => {
      const values = [];
      const request = source.openCursor(query, direction);
      request.onerror = () => reject(request.error || new Error("INDEXEDDB_CURSOR_FAILED"));
      request.onsuccess = () => {
        const cursor = request.result;
        if (!cursor || values.length >= limit) {
          resolve(values);
          return;
        }
        values.push(clone(cursor.value));
        if (values.length >= limit) resolve(values);
        else cursor.continue();
      };
    });
  }

  class IndexedDbWorkspaceStore extends WorkspaceOperations {
    constructor(options) {
      super(options);
      this.indexedDb = options?.indexedDB || root.indexedDB;
      this.databasePromise = null;
      this.writeQueue = Promise.resolve();
    }

    open() {
      if (!this.databasePromise) {
        this.databasePromise = openWorkspaceDatabase(this.indexedDb).catch((error) => {
          this.databasePromise = null;
          throw error;
        });
      }
      return this.databasePromise;
    }

    async _transaction(names, mode, operation) {
      const database = await this.open();
      const uniqueNames = [...new Set(names)];
      return new Promise((resolve, reject) => {
        const transaction = database.transaction(uniqueNames, mode);
        let result;
        let operationError = null;

        transaction.oncomplete = () => resolve(clone(result));
        transaction.onabort = () => reject(operationError || transaction.error || new Error("INDEXEDDB_TRANSACTION_ABORTED"));
        transaction.onerror = () => {
          if (!operationError) operationError = transaction.error || new Error("INDEXEDDB_TRANSACTION_FAILED");
        };

        let pending;
        try {
          pending = operation(transaction);
        } catch (error) {
          operationError = error;
          transaction.abort();
          return;
        }
        Promise.resolve(pending).then((value) => {
          result = value;
        }, (error) => {
          operationError = error;
          try {
            transaction.abort();
          } catch (_) {
            reject(error);
          }
        });
      });
    }

    _readTransaction(names, operation) {
      return this._transaction(names, "readonly", operation);
    }

    _writeTransaction(names, operation) {
      const run = () => this._transaction(names, "readwrite", operation);
      const result = this.writeQueue.then(run, run);
      this.writeQueue = result.catch(() => {});
      return result;
    }

    async _revision(transaction, family) {
      const record = await requestValue(transaction.objectStore(contract.STORE_NAMES.META).get(`revision:${family}`));
      return Number(record?.value || 0);
    }

    async _bumpRevision(transaction, family, timestamp) {
      const store = transaction.objectStore(contract.STORE_NAMES.META);
      const key = `revision:${family}`;
      const current = await requestValue(store.get(key));
      const revision = Number(current?.value || 0) + 1;
      await requestValue(store.put(metaRecord(key, revision, timestamp)));
      return revision;
    }

    _conversationByScope(transaction, scopeKey) {
      return requestValue(transaction.objectStore(contract.STORE_NAMES.CONVERSATIONS).index("scopeKey").get(scopeKey));
    }

    async _nextLocalOrder(transaction, linkStoreName, conversationId) {
      const links = await cursorValues(
        transaction.objectStore(linkStoreName).index("conversationId"),
        conversationId,
        "next",
      );
      return links.reduce((maximum, link) => Math.max(maximum, Number(link.localOrder) || 0), -1) + 1;
    }

    async _ensureTargetedLink(transaction, linkStoreName, entityField, entityId, conversationId, timestamp) {
      const store = transaction.objectStore(linkStoreName);
      const key = linkKey(entityId, conversationId);
      const existing = await requestValue(store.index("linkKey").get(key));
      if (existing) {
        const nextLastSeenAt = Math.max(validTimestamp(existing.lastSeenAt, timestamp), timestamp);
        if (nextLastSeenAt !== existing.lastSeenAt) {
          existing.lastSeenAt = nextLastSeenAt;
          await requestValue(store.put(existing));
        }
        return { link: existing, created: false };
      }
      const link = {
        id: this.idFactory("link"),
        [entityField]: entityId,
        conversationId,
        linkKey: key,
        localOrder: await this._nextLocalOrder(transaction, linkStoreName, conversationId),
        firstSeenAt: timestamp,
        lastSeenAt: timestamp,
      };
      await requestValue(store.add(link));
      return { link, created: true };
    }

    async _publicSense(transaction, sense, link, conceptCache) {
      const cache = conceptCache || new Map();
      if (!cache.has(sense.conceptId)) {
        cache.set(sense.conceptId, requestValue(
          transaction.objectStore(contract.STORE_NAMES.GLOSSARY_CONCEPTS).get(sense.conceptId),
        ));
      }
      const concept = await cache.get(sense.conceptId);
      if (!concept) return null;
      return {
        id: sense.id,
        senseId: sense.id,
        conceptId: concept.id,
        term: concept.displayTerm,
        canonicalTerm: concept.canonicalTerm,
        normalizedTerm: concept.normalizedKey,
        translation: sense.translation,
        definition: sense.definition,
        createdAt: sense.createdAt,
        updatedAt: sense.updatedAt,
        attached: Boolean(link),
        ...(link ? { linkId: link.id, localOrder: link.localOrder } : {}),
      };
    }

    initialize() {
      const required = createEmptyState(this.now()).meta;
      return this._readTransaction([contract.STORE_NAMES.META], async (transaction) => {
        const store = transaction.objectStore(contract.STORE_NAMES.META);
        const existing = await Promise.all(required.map((record) => requestValue(store.get(record.key))));
        return existing.every(Boolean);
      }).then((complete) => {
        if (complete) return { ok: true, changed: false };
        return this._writeTransaction([contract.STORE_NAMES.META], async (transaction) => {
          const store = transaction.objectStore(contract.STORE_NAMES.META);
          let changed = false;
          for (const record of required) {
            if (!await requestValue(store.get(record.key))) {
              await requestValue(store.put(record));
              changed = true;
            }
          }
          return { ok: true, changed };
        });
      });
    }

    async migrateLegacyGlossary(entriesValue) {
      const marker = await this._readTransaction([contract.STORE_NAMES.META], (transaction) => (
        requestValue(transaction.objectStore(contract.STORE_NAMES.META).get("v1GlossaryMigrationState"))
      ));
      if (marker?.value?.status === "complete") return { migrated: false, marker: clone(marker.value) };

      const timestamp = this.now();
      const source = Array.isArray(entriesValue) ? entriesValue : [];
      const plan = [];
      let skippedCount = 0;
      source.forEach((entry) => {
        const term = contract.canonicalizeTerm(entry?.term || entry?.normalizedTerm || "");
        const translation = contract.normalizeMeaning(entry?.translation, 200);
        const definition = contract.normalizeMeaning(entry?.definition, 500);
        if (!term || !translation || !definition) {
          skippedCount += 1;
          return;
        }
        const createdAt = validTimestamp(entry.createdAt, timestamp);
        plan.push({
          term,
          translation,
          definition,
          createdAt,
          updatedAt: Math.max(createdAt, validTimestamp(entry.updatedAt, createdAt)),
        });
      });

      return this._writeTransaction([
        contract.STORE_NAMES.META,
        contract.STORE_NAMES.GLOSSARY_CONCEPTS,
        contract.STORE_NAMES.GLOSSARY_SENSES,
      ], async (transaction) => {
        const meta = transaction.objectStore(contract.STORE_NAMES.META);
        const currentMarker = await requestValue(meta.get("v1GlossaryMigrationState"));
        if (currentMarker?.value?.status === "complete") {
          return { migrated: false, marker: clone(currentMarker.value) };
        }
        const concepts = transaction.objectStore(contract.STORE_NAMES.GLOSSARY_CONCEPTS);
        const senses = transaction.objectStore(contract.STORE_NAMES.GLOSSARY_SENSES);
        const conceptCache = new Map();
        const senseCache = new Map();
        for (const item of plan) {
          let concept = conceptCache.get(item.term.normalizedKey);
          if (!concept) {
            concept = await requestValue(concepts.index("normalizedKey").get(item.term.normalizedKey));
            if (!concept) {
              concept = {
                id: this.idFactory("concept"),
                displayTerm: item.term.displayTerm,
                canonicalTerm: item.term.canonicalTerm,
                normalizedKey: item.term.normalizedKey,
                createdAt: item.createdAt,
                updatedAt: item.updatedAt,
              };
              await requestValue(concepts.add(concept));
            }
            conceptCache.set(item.term.normalizedKey, concept);
          }
          const nextConceptCreatedAt = Math.min(validTimestamp(concept.createdAt, item.createdAt), item.createdAt);
          const nextConceptUpdatedAt = Math.max(validTimestamp(concept.updatedAt, item.updatedAt), item.updatedAt);
          if (nextConceptCreatedAt !== concept.createdAt || nextConceptUpdatedAt !== concept.updatedAt) {
            concept.createdAt = nextConceptCreatedAt;
            concept.updatedAt = nextConceptUpdatedAt;
            await requestValue(concepts.put(concept));
          }
          const naturalKey = contract.createSenseNaturalKey(concept.id, item.translation, item.definition);
          let sense = senseCache.get(naturalKey);
          if (!sense) {
            sense = await requestValue(senses.index("naturalKey").get(naturalKey));
            if (!sense) {
              sense = {
                id: this.idFactory("sense"),
                conceptId: concept.id,
                translation: item.translation,
                definition: item.definition,
                normalizedTranslation: item.translation.toLocaleLowerCase("ru-RU"),
                normalizedDefinition: item.definition.toLocaleLowerCase("ru-RU"),
                naturalKey,
                createdAt: item.createdAt,
                updatedAt: item.updatedAt,
              };
              await requestValue(senses.add(sense));
            }
            senseCache.set(naturalKey, sense);
          }
          const nextSenseCreatedAt = Math.min(validTimestamp(sense.createdAt, item.createdAt), item.createdAt);
          const nextSenseUpdatedAt = Math.max(validTimestamp(sense.updatedAt, item.updatedAt), item.updatedAt);
          if (nextSenseCreatedAt !== sense.createdAt || nextSenseUpdatedAt !== sense.updatedAt) {
            sense.createdAt = nextSenseCreatedAt;
            sense.updatedAt = nextSenseUpdatedAt;
            await requestValue(senses.put(sense));
          }
        }
        const completed = {
          status: "complete",
          sourceSchemaVersion: 1,
          sourceCount: source.length,
          migratedCount: plan.length,
          skippedCount,
        };
        await requestValue(meta.put(metaRecord("v1GlossaryMigrationState", completed, timestamp)));
        await requestValue(meta.put(metaRecord("lastMigrationAt", timestamp, timestamp)));
        if (plan.length) await this._bumpRevision(transaction, contract.ENTITY_FAMILIES.GLOSSARY, timestamp);
        return { migrated: true, marker: completed };
      });
    }

    ensureConversation(descriptorValue) {
      return this._writeTransaction([
        contract.STORE_NAMES.META,
        contract.STORE_NAMES.CONVERSATIONS,
      ], async (transaction) => {
        const now = this.now();
        const descriptor = descriptorValue?.kind === "stable"
          ? stableDescriptor(descriptorValue)
          : temporaryDescriptor(descriptorValue?.scopeKey, descriptorValue?.host);
        if (!descriptor) throw new Error("INVALID_CONVERSATION");
        const store = transaction.objectStore(contract.STORE_NAMES.CONVERSATIONS);
        const existing = await requestValue(store.index("scopeKey").get(descriptor.scopeKey));
        if (existing) {
          const nextLastSeenAt = Math.max(validTimestamp(existing.lastSeenAt, now), now);
          const shouldRestore = existing.kind === "temporary" && existing.orphanedAt !== null;
          if (nextLastSeenAt !== existing.lastSeenAt || shouldRestore) {
            existing.lastSeenAt = nextLastSeenAt;
            if (shouldRestore) existing.orphanedAt = null;
            await requestValue(store.put(existing));
          }
          return { context: existing, created: false, revision: await this._revision(transaction, contract.ENTITY_FAMILIES.CONVERSATIONS) };
        }
        const context = {
          id: this.idFactory("conversation"),
          scopeKey: descriptor.scopeKey,
          kind: descriptor.kind,
          host: descriptor.host,
          remoteConversationId: descriptor.remoteConversationId,
          canonicalUrl: descriptor.canonicalUrl,
          createdAt: now,
          lastSeenAt: now,
          orphanedAt: null,
        };
        await requestValue(store.add(context));
        const revision = await this._bumpRevision(transaction, contract.ENTITY_FAMILIES.CONVERSATIONS, now);
        return { context, created: true, revision };
      });
    }

    rebindConversation(temporaryScope, stableValue) {
      return this._writeTransaction([
        contract.STORE_NAMES.META,
        contract.STORE_NAMES.CONVERSATIONS,
        contract.STORE_NAMES.GLOSSARY_LINKS,
        contract.STORE_NAMES.SAVED_ITEM_LINKS,
      ], async (transaction) => {
        const now = this.now();
        const stable = stableDescriptor(stableValue);
        if (!stable || !contract.isScopeKey(temporaryScope) || !temporaryScope.startsWith("temporary:")) {
          throw new Error("INVALID_CONVERSATION");
        }
        const conversations = transaction.objectStore(contract.STORE_NAMES.CONVERSATIONS);
        let target = await requestValue(conversations.index("scopeKey").get(stable.scopeKey));
        if (!target) {
          target = {
            id: this.idFactory("conversation"),
            ...stable,
            createdAt: now,
            lastSeenAt: now,
            orphanedAt: null,
          };
          await requestValue(conversations.add(target));
        } else if (Math.max(validTimestamp(target.lastSeenAt, now), now) !== target.lastSeenAt) {
          target.lastSeenAt = Math.max(validTimestamp(target.lastSeenAt, now), now);
          await requestValue(conversations.put(target));
        }
        const temporary = await requestValue(conversations.index("scopeKey").get(temporaryScope));
        if (!temporary || temporary.kind !== "temporary") {
          return { context: target, rebound: false, glossaryLinksMoved: 0, savedLinksMoved: 0 };
        }

        const mergeLinks = async (storeName, entityField) => {
          const store = transaction.objectStore(storeName);
          const links = await cursorValues(store.index("conversationId"), temporary.id, "next");
          for (const source of links) {
            const targetKey = linkKey(source[entityField], target.id);
            const existing = await requestValue(store.index("linkKey").get(targetKey));
            if (existing) {
              existing.localOrder = Math.min(Number(existing.localOrder) || 0, Number(source.localOrder) || 0);
              existing.firstSeenAt = Math.min(validTimestamp(existing.firstSeenAt, source.firstSeenAt), validTimestamp(source.firstSeenAt, existing.firstSeenAt));
              existing.lastSeenAt = Math.max(validTimestamp(existing.lastSeenAt, source.lastSeenAt), validTimestamp(source.lastSeenAt, existing.lastSeenAt));
              await requestValue(store.put(existing));
              await requestValue(store.delete(source.id));
            } else {
              source.conversationId = target.id;
              source.linkKey = targetKey;
              await requestValue(store.put(source));
            }
          }
          return links.length;
        };
        const glossaryLinksMoved = await mergeLinks(contract.STORE_NAMES.GLOSSARY_LINKS, "senseId");
        const savedLinksMoved = await mergeLinks(contract.STORE_NAMES.SAVED_ITEM_LINKS, "itemId");
        await requestValue(conversations.delete(temporary.id));
        const revision = await this._bumpRevision(transaction, contract.ENTITY_FAMILIES.CONVERSATIONS, now);
        return { context: target, rebound: true, glossaryLinksMoved, savedLinksMoved, revision };
      });
    }

    orphanConversation(temporaryScope) {
      return this._writeTransaction([
        contract.STORE_NAMES.META,
        contract.STORE_NAMES.CONVERSATIONS,
      ], async (transaction) => {
        const conversation = await this._conversationByScope(transaction, temporaryScope);
        if (!conversation || conversation.kind !== "temporary") return { orphaned: false };
        if (conversation.orphanedAt === null) {
          conversation.orphanedAt = this.now();
          await requestValue(transaction.objectStore(contract.STORE_NAMES.CONVERSATIONS).put(conversation));
        }
        const revision = await this._bumpRevision(transaction, contract.ENTITY_FAMILIES.CONVERSATIONS, this.now());
        return { orphaned: true, context: conversation, revision };
      });
    }

    addAnalysisTerms(termsValue, conversationScope) {
      return this._writeTransaction([
        contract.STORE_NAMES.META,
        contract.STORE_NAMES.CONVERSATIONS,
        contract.STORE_NAMES.GLOSSARY_CONCEPTS,
        contract.STORE_NAMES.GLOSSARY_SENSES,
        contract.STORE_NAMES.GLOSSARY_LINKS,
      ], async (transaction) => {
        const conversation = await this._conversationByScope(transaction, conversationScope);
        if (!conversation) throw new Error("CONVERSATION_NOT_FOUND");
        const concepts = transaction.objectStore(contract.STORE_NAMES.GLOSSARY_CONCEPTS);
        const senses = transaction.objectStore(contract.STORE_NAMES.GLOSSARY_SENSES);
        const now = this.now();
        const results = [];
        let changed = false;
        for (const termValue of Array.isArray(termsValue) ? termsValue : []) {
          const term = contract.canonicalizeTerm(termValue?.term || termValue?.displayTerm || "");
          const translation = contract.normalizeMeaning(termValue?.translation, 200);
          const definition = contract.normalizeMeaning(termValue?.definition, 500);
          if (!term || !translation || !definition) continue;
          let concept = await requestValue(concepts.index("normalizedKey").get(term.normalizedKey));
          const conceptCreated = !concept;
          if (!concept) {
            concept = {
              id: this.idFactory("concept"),
              displayTerm: term.displayTerm,
              canonicalTerm: term.canonicalTerm,
              normalizedKey: term.normalizedKey,
              createdAt: now,
              updatedAt: now,
            };
            await requestValue(concepts.add(concept));
          }
          const naturalKey = contract.createSenseNaturalKey(concept.id, translation, definition);
          let sense = await requestValue(senses.index("naturalKey").get(naturalKey));
          const senseCreated = !sense;
          let candidates = [];
          if (!sense) {
            candidates = (await cursorValues(senses.index("conceptId"), concept.id, "next"))
              .filter((item) => item.normalizedTranslation === translation.toLocaleLowerCase("ru-RU")
                && item.normalizedDefinition !== definition.toLocaleLowerCase("ru-RU"));
            sense = {
              id: this.idFactory("sense"),
              conceptId: concept.id,
              translation,
              definition,
              normalizedTranslation: translation.toLocaleLowerCase("ru-RU"),
              normalizedDefinition: definition.toLocaleLowerCase("ru-RU"),
              naturalKey,
              createdAt: now,
              updatedAt: now,
            };
            await requestValue(senses.add(sense));
            if (!conceptCreated) {
              concept.updatedAt = Math.max(validTimestamp(concept.updatedAt, now), now);
              await requestValue(concepts.put(concept));
            }
          }
          const linked = await this._ensureTargetedLink(
            transaction,
            contract.STORE_NAMES.GLOSSARY_LINKS,
            "senseId",
            sense.id,
            conversation.id,
            now,
          );
          changed = changed || conceptCreated || senseCreated || linked.created;
          const result = {
            ...await this._publicSense(transaction, sense, linked.link),
            status: senseCreated ? "new" : "alreadySaved",
            savedEntry: await this._publicSense(transaction, sense, linked.link),
          };
          if (senseCreated && candidates.length === 1) {
            const candidate = candidates[0];
            result.status = "duplicate";
            result.savedEntry = await this._publicSense(transaction, candidate, null);
            result.replacementCandidate = {
              status: "single",
              targetSenseId: candidate.id,
              expectedUpdatedAt: candidate.updatedAt,
              newSenseId: sense.id,
              current: { translation: candidate.translation, definition: candidate.definition },
            };
          } else if (senseCreated && candidates.length > 1) {
            result.replacementCandidate = { status: "multiple", count: candidates.length };
          }
          results.push(result);
        }
        const revision = changed
          ? await this._bumpRevision(transaction, contract.ENTITY_FAMILIES.GLOSSARY, now)
          : await this._revision(transaction, contract.ENTITY_FAMILIES.GLOSSARY);
        return { results, changed, revision };
      });
    }

    _queryGlossaryInTransaction(transaction, requestValue_) {
      const request = requestValue_ || {};
      const mode = contract.normalizeMode(request.mode);
      const query = contract.normalizeSearchQuery(request.query);
      const limit = contract.boundedLimit(request.limit);
      return this._conversationByScope(transaction, request.conversationScope).then((conversation) => {
        if (!conversation || (mode === "global" && !query)) return [];
        const senses = transaction.objectStore(contract.STORE_NAMES.GLOSSARY_SENSES);
        const links = transaction.objectStore(contract.STORE_NAMES.GLOSSARY_LINKS);
        const conceptCache = new Map();
        const results = [];
        const source = mode === "local"
          ? links.index("conversationIdLocalOrder")
          : senses.index("updatedAt");
        const range = mode === "local" ? orderedConversationRange(conversation.id) : null;
        const direction = mode === "local" ? "next" : "prev";
        return new Promise((resolve, reject) => {
          const cursorRequest = source.openCursor(range, direction);
          cursorRequest.onerror = () => reject(cursorRequest.error || new Error("INDEXEDDB_CURSOR_FAILED"));
          cursorRequest.onsuccess = () => {
            const cursor = cursorRequest.result;
            if (!cursor || results.length >= limit) {
              resolve(results);
              return;
            }
            const link = mode === "local" ? cursor.value : null;
            const senseRequest = mode === "local" ? senses.get(link.senseId) : null;
            const handleSense = async (sense) => {
              if (sense) {
                const currentLink = link || await requestValue(links.index("linkKey").get(linkKey(sense.id, conversation.id)));
                const item = await this._publicSense(transaction, sense, currentLink, conceptCache);
                if (item && contract.matchesAllTokens(`${item.term} ${item.translation} ${item.definition}`, query)) results.push(item);
              }
              if (results.length >= limit) resolve(results);
              else cursor.continue();
            };
            if (senseRequest) {
              senseRequest.onerror = () => reject(senseRequest.error || new Error("INDEXEDDB_REQUEST_FAILED"));
              senseRequest.onsuccess = () => { void handleSense(senseRequest.result).catch(reject); };
            } else {
              void handleSense(cursor.value).catch(reject);
            }
          };
        });
      });
    }

    queryGlossary(request) {
      return this._readTransaction([
        contract.STORE_NAMES.CONVERSATIONS,
        contract.STORE_NAMES.GLOSSARY_CONCEPTS,
        contract.STORE_NAMES.GLOSSARY_SENSES,
        contract.STORE_NAMES.GLOSSARY_LINKS,
      ], (transaction) => this._queryGlossaryInTransaction(transaction, request));
    }

    attachGlossarySense(senseId, conversationScope) {
      return this._writeTransaction([
        contract.STORE_NAMES.META,
        contract.STORE_NAMES.CONVERSATIONS,
        contract.STORE_NAMES.GLOSSARY_CONCEPTS,
        contract.STORE_NAMES.GLOSSARY_SENSES,
        contract.STORE_NAMES.GLOSSARY_LINKS,
      ], async (transaction) => {
        const conversation = await this._conversationByScope(transaction, conversationScope);
        const sense = await requestValue(transaction.objectStore(contract.STORE_NAMES.GLOSSARY_SENSES).get(senseId));
        if (!conversation || !sense) throw new Error("GLOSSARY_NOT_FOUND");
        const linked = await this._ensureTargetedLink(transaction, contract.STORE_NAMES.GLOSSARY_LINKS, "senseId", senseId, conversation.id, this.now());
        const revision = linked.created
          ? await this._bumpRevision(transaction, contract.ENTITY_FAMILIES.GLOSSARY, this.now())
          : await this._revision(transaction, contract.ENTITY_FAMILIES.GLOSSARY);
        return { changed: linked.created, entry: await this._publicSense(transaction, sense, linked.link), revision };
      });
    }

    async _moveLink(storeName, entityField, entityId, beforeEntityId, conversationScope, family) {
      return this._writeTransaction([
        contract.STORE_NAMES.META,
        contract.STORE_NAMES.CONVERSATIONS,
        storeName,
      ], async (transaction) => {
        const conversation = await this._conversationByScope(transaction, conversationScope);
        if (!conversation) throw new Error("CONVERSATION_NOT_FOUND");
        const store = transaction.objectStore(storeName);
        const local = await cursorValues(store.index("conversationId"), conversation.id, "next");
        local.sort((left, right) => left.localOrder - right.localOrder || left.firstSeenAt - right.firstSeenAt);
        const sourceIndex = local.findIndex((item) => item[entityField] === entityId);
        if (sourceIndex < 0) throw new Error("LINK_NOT_FOUND");
        const [moved] = local.splice(sourceIndex, 1);
        const targetIndex = beforeEntityId === null ? local.length : local.findIndex((item) => item[entityField] === beforeEntityId);
        if (targetIndex < 0) throw new Error("TARGET_LINK_NOT_FOUND");
        local.splice(targetIndex, 0, moved);
        for (let index = 0; index < local.length; index += 1) {
          if (local[index].localOrder !== index) {
            local[index].localOrder = index;
            await requestValue(store.put(local[index]));
          }
        }
        return { changed: true, revision: await this._bumpRevision(transaction, family, this.now()) };
      });
    }

    moveGlossaryLink(senseId, beforeSenseId, conversationScope) {
      return this._moveLink(contract.STORE_NAMES.GLOSSARY_LINKS, "senseId", senseId, beforeSenseId, conversationScope, contract.ENTITY_FAMILIES.GLOSSARY);
    }

    async _unlink(storeName, entityField, entityId, conversationScope, family) {
      return this._writeTransaction([
        contract.STORE_NAMES.META,
        contract.STORE_NAMES.CONVERSATIONS,
        storeName,
      ], async (transaction) => {
        const conversation = await this._conversationByScope(transaction, conversationScope);
        if (!conversation) throw new Error("CONVERSATION_NOT_FOUND");
        const store = transaction.objectStore(storeName);
        const link = await requestValue(store.index("linkKey").get(linkKey(entityId, conversation.id)));
        if (!link) return { changed: false, revision: await this._revision(transaction, family) };
        await requestValue(store.delete(link.id));
        return { changed: true, revision: await this._bumpRevision(transaction, family, this.now()) };
      });
    }

    unlinkGlossary(senseId, conversationScope) {
      return this._unlink(contract.STORE_NAMES.GLOSSARY_LINKS, "senseId", senseId, conversationScope, contract.ENTITY_FAMILIES.GLOSSARY);
    }

    deleteGlossarySense(senseId) {
      return this._writeTransaction([
        contract.STORE_NAMES.META,
        contract.STORE_NAMES.GLOSSARY_CONCEPTS,
        contract.STORE_NAMES.GLOSSARY_SENSES,
        contract.STORE_NAMES.GLOSSARY_LINKS,
      ], async (transaction) => {
        const senses = transaction.objectStore(contract.STORE_NAMES.GLOSSARY_SENSES);
        const sense = await requestValue(senses.get(senseId));
        if (!sense) return { changed: false, revision: await this._revision(transaction, contract.ENTITY_FAMILIES.GLOSSARY) };
        const links = transaction.objectStore(contract.STORE_NAMES.GLOSSARY_LINKS);
        for (const link of await cursorValues(links.index("senseId"), senseId, "next")) {
          await requestValue(links.delete(link.id));
        }
        await requestValue(senses.delete(senseId));
        const remaining = await cursorValues(senses.index("conceptId"), sense.conceptId, "next", 1);
        if (!remaining.length) {
          await requestValue(transaction.objectStore(contract.STORE_NAMES.GLOSSARY_CONCEPTS).delete(sense.conceptId));
        }
        return { changed: true, revision: await this._bumpRevision(transaction, contract.ENTITY_FAMILIES.GLOSSARY, this.now()) };
      });
    }

    replaceGlossarySense(command) {
      return this._writeTransaction([
        contract.STORE_NAMES.META,
        contract.STORE_NAMES.GLOSSARY_CONCEPTS,
        contract.STORE_NAMES.GLOSSARY_SENSES,
        contract.STORE_NAMES.GLOSSARY_LINKS,
      ], async (transaction) => {
        if (!Number.isFinite(command?.expectedUpdatedAt)) throw new Error("INVALID_GLOSSARY_REPLACEMENT");
        const senses = transaction.objectStore(contract.STORE_NAMES.GLOSSARY_SENSES);
        const target = await requestValue(senses.get(command.senseId));
        if (!target) throw new Error("GLOSSARY_NOT_FOUND");
        const current = await this._publicSense(transaction, target, null);
        if (command.expectedUpdatedAt !== target.updatedAt) return { ok: false, stale: true, current };
        const source = await requestValue(senses.get(command.sourceSenseId));
        if (!source || source.id === target.id || source.conceptId !== target.conceptId
          || source.normalizedTranslation !== target.normalizedTranslation
          || source.normalizedDefinition === target.normalizedDefinition) {
          throw new Error("INVALID_GLOSSARY_REPLACEMENT");
        }
        const links = transaction.objectStore(contract.STORE_NAMES.GLOSSARY_LINKS);
        for (const sourceLink of await cursorValues(links.index("senseId"), source.id, "next")) {
          const targetKey = linkKey(target.id, sourceLink.conversationId);
          const targetLink = await requestValue(links.index("linkKey").get(targetKey));
          if (targetLink) {
            targetLink.localOrder = Math.min(Number(targetLink.localOrder) || 0, Number(sourceLink.localOrder) || 0);
            targetLink.firstSeenAt = Math.min(validTimestamp(targetLink.firstSeenAt, sourceLink.firstSeenAt), validTimestamp(sourceLink.firstSeenAt, targetLink.firstSeenAt));
            targetLink.lastSeenAt = Math.max(validTimestamp(targetLink.lastSeenAt, sourceLink.lastSeenAt), validTimestamp(sourceLink.lastSeenAt, targetLink.lastSeenAt));
            await requestValue(links.put(targetLink));
            await requestValue(links.delete(sourceLink.id));
          } else {
            sourceLink.senseId = target.id;
            sourceLink.linkKey = targetKey;
            await requestValue(links.put(sourceLink));
          }
        }
        await requestValue(senses.delete(source.id));
        const now = Math.max(this.now(), Number(target.updatedAt) + 1);
        target.translation = source.translation;
        target.definition = source.definition;
        target.normalizedTranslation = source.normalizedTranslation;
        target.normalizedDefinition = source.normalizedDefinition;
        target.naturalKey = source.naturalKey;
        target.updatedAt = now;
        await requestValue(senses.put(target));
        const concepts = transaction.objectStore(contract.STORE_NAMES.GLOSSARY_CONCEPTS);
        const concept = await requestValue(concepts.get(target.conceptId));
        concept.updatedAt = Math.max(Number(concept.updatedAt) || 0, now);
        await requestValue(concepts.put(concept));
        return {
          ok: true,
          entry: await this._publicSense(transaction, target, null),
          revision: await this._bumpRevision(transaction, contract.ENTITY_FAMILIES.GLOSSARY, now),
        };
      });
    }

    saveSelection(textValue, conversationScope) {
      return this._writeTransaction([
        contract.STORE_NAMES.META,
        contract.STORE_NAMES.CONVERSATIONS,
        contract.STORE_NAMES.SAVED_ITEMS,
        contract.STORE_NAMES.SAVED_ITEM_LINKS,
      ], async (transaction) => {
        const conversation = await this._conversationByScope(transaction, conversationScope);
        const validated = contract.validateSavedText(textValue);
        if (!conversation || !validated.ok) throw new Error(!conversation ? "CONVERSATION_NOT_FOUND" : validated.error);
        const items = transaction.objectStore(contract.STORE_NAMES.SAVED_ITEMS);
        let item = await requestValue(items.index("normalizedTextKey").get(validated.normalizedTextKey));
        const itemCreated = !item;
        const now = this.now();
        if (!item) {
          item = {
            id: this.idFactory("saved"),
            text: validated.text,
            normalizedTextKey: validated.normalizedTextKey,
            createdAt: now,
            updatedAt: now,
          };
          await requestValue(items.add(item));
        }
        const linked = await this._ensureTargetedLink(transaction, contract.STORE_NAMES.SAVED_ITEM_LINKS, "itemId", item.id, conversation.id, now);
        const changed = itemCreated || linked.created;
        const revision = changed
          ? await this._bumpRevision(transaction, contract.ENTITY_FAMILIES.SAVED, now)
          : await this._revision(transaction, contract.ENTITY_FAMILIES.SAVED);
        return { changed, item: publicSavedItem(item, linked.link), revision };
      });
    }

    _querySavedInTransaction(transaction, requestValue_) {
      const request = requestValue_ || {};
      const mode = contract.normalizeMode(request.mode);
      const query = contract.normalizeSearchQuery(request.query);
      const limit = contract.boundedLimit(request.limit);
      return this._conversationByScope(transaction, request.conversationScope).then((conversation) => {
        if (!conversation || (mode === "global" && !query)) return [];
        const items = transaction.objectStore(contract.STORE_NAMES.SAVED_ITEMS);
        const links = transaction.objectStore(contract.STORE_NAMES.SAVED_ITEM_LINKS);
        const results = [];
        const source = mode === "local" ? links.index("conversationIdLocalOrder") : items.index("updatedAt");
        const range = mode === "local" ? orderedConversationRange(conversation.id) : null;
        const direction = mode === "local" ? "next" : "prev";
        return new Promise((resolve, reject) => {
          const cursorRequest = source.openCursor(range, direction);
          cursorRequest.onerror = () => reject(cursorRequest.error || new Error("INDEXEDDB_CURSOR_FAILED"));
          cursorRequest.onsuccess = () => {
            const cursor = cursorRequest.result;
            if (!cursor || results.length >= limit) {
              resolve(results);
              return;
            }
            const link = mode === "local" ? cursor.value : null;
            const itemRequest = mode === "local" ? items.get(link.itemId) : null;
            const handleItem = async (item) => {
              if (item && contract.matchesAllTokens(item.text, query)) {
                const currentLink = link || await requestValue(links.index("linkKey").get(linkKey(item.id, conversation.id)));
                results.push(publicSavedItem(item, currentLink));
              }
              if (results.length >= limit) resolve(results);
              else cursor.continue();
            };
            if (itemRequest) {
              itemRequest.onerror = () => reject(itemRequest.error || new Error("INDEXEDDB_REQUEST_FAILED"));
              itemRequest.onsuccess = () => { void handleItem(itemRequest.result).catch(reject); };
            } else {
              void handleItem(cursor.value).catch(reject);
            }
          };
        });
      });
    }

    querySaved(request) {
      return this._readTransaction([
        contract.STORE_NAMES.CONVERSATIONS,
        contract.STORE_NAMES.SAVED_ITEMS,
        contract.STORE_NAMES.SAVED_ITEM_LINKS,
      ], (transaction) => this._querySavedInTransaction(transaction, request));
    }

    moveSavedLink(itemId, beforeItemId, conversationScope) {
      return this._moveLink(contract.STORE_NAMES.SAVED_ITEM_LINKS, "itemId", itemId, beforeItemId, conversationScope, contract.ENTITY_FAMILIES.SAVED);
    }

    unlinkSaved(itemId, conversationScope) {
      return this._unlink(contract.STORE_NAMES.SAVED_ITEM_LINKS, "itemId", itemId, conversationScope, contract.ENTITY_FAMILIES.SAVED);
    }

    deleteSavedItem(itemId) {
      return this._writeTransaction([
        contract.STORE_NAMES.META,
        contract.STORE_NAMES.SAVED_ITEMS,
        contract.STORE_NAMES.SAVED_ITEM_LINKS,
      ], async (transaction) => {
        const items = transaction.objectStore(contract.STORE_NAMES.SAVED_ITEMS);
        if (!await requestValue(items.get(itemId))) {
          return { changed: false, revision: await this._revision(transaction, contract.ENTITY_FAMILIES.SAVED) };
        }
        const links = transaction.objectStore(contract.STORE_NAMES.SAVED_ITEM_LINKS);
        for (const link of await cursorValues(links.index("itemId"), itemId, "next")) {
          await requestValue(links.delete(link.id));
        }
        await requestValue(items.delete(itemId));
        return { changed: true, revision: await this._bumpRevision(transaction, contract.ENTITY_FAMILIES.SAVED, this.now()) };
      });
    }

    getMetaValue(key) {
      return this._readTransaction([contract.STORE_NAMES.META], async (transaction) => {
        const record = await requestValue(transaction.objectStore(contract.STORE_NAMES.META).get(key));
        return clone(record?.value ?? null);
      });
    }

    setMetaValue(key, value) {
      return this._writeTransaction([contract.STORE_NAMES.META], async (transaction) => {
        await requestValue(transaction.objectStore(contract.STORE_NAMES.META).put(metaRecord(key, clone(value), this.now())));
        return { ok: true };
      });
    }

    deleteMetaValue(key) {
      return this._writeTransaction([contract.STORE_NAMES.META], async (transaction) => {
        const store = transaction.objectStore(contract.STORE_NAMES.META);
        const existing = await requestValue(store.get(key));
        if (existing) await requestValue(store.delete(key));
        return { ok: true, changed: Boolean(existing) };
      });
    }

    snapshotUserData() {
      return this._readTransaction(USER_STORE_NAMES, async (transaction) => {
        const entries = await Promise.all(USER_STORE_NAMES.map(async (name) => [
          name,
          await cursorValues(transaction.objectStore(name), null, "next"),
        ]));
        return Object.fromEntries(entries);
      });
    }

    getImportBackup(kind) {
      return this._readTransaction([contract.STORE_NAMES.IMPORT_BACKUPS], (transaction) => (
        requestValue(transaction.objectStore(contract.STORE_NAMES.IMPORT_BACKUPS).get(kind))
      ));
    }

    putImportBackup(kind, payload) {
      return this._writeTransaction([contract.STORE_NAMES.IMPORT_BACKUPS], async (transaction) => {
        const record = { kind, createdAt: this.now(), schemaVersion: 1, payload: clone(payload) };
        await requestValue(transaction.objectStore(contract.STORE_NAMES.IMPORT_BACKUPS).put(record));
        return record;
      });
    }

    replaceUserData(nextValue) {
      return this._writeTransaction([contract.STORE_NAMES.META, ...USER_STORE_NAMES], async (transaction) => {
        for (const name of USER_STORE_NAMES) {
          const store = transaction.objectStore(name);
          await requestValue(store.clear());
          for (const item of Array.isArray(nextValue?.[name]) ? nextValue[name] : []) {
            await requestValue(store.add(clone(item)));
          }
        }
        return { changed: true, revision: await this._bumpRevision(transaction, contract.ENTITY_FAMILIES.ALL, this.now()) };
      });
    }

    mergeUserData(nextValue) {
      return this._writeTransaction([contract.STORE_NAMES.META, ...USER_STORE_NAMES], async (transaction) => {
        let changed = false;
        for (const name of USER_STORE_NAMES) {
          const store = transaction.objectStore(name);
          for (const item of Array.isArray(nextValue?.[name]) ? nextValue[name] : []) {
            const existing = await requestValue(store.get(item.id));
            if (!existing) {
              await requestValue(store.add(clone(item)));
              changed = true;
            } else if (JSON.stringify(existing) !== JSON.stringify(item)) {
              await requestValue(store.put(clone(item)));
              changed = true;
            }
          }
        }
        const revision = changed
          ? await this._bumpRevision(transaction, contract.ENTITY_FAMILIES.ALL, this.now())
          : await this._revision(transaction, contract.ENTITY_FAMILIES.ALL);
        return { changed, revision };
      });
    }
  }

  const api = Object.freeze({
    createEmptyState,
    normalizeState,
    stableDescriptor,
    temporaryDescriptor,
    migrateLegacyInState,
    rebindInState,
    queryGlossaryInState,
    querySavedInState,
    USER_STORE_NAMES,
    MemoryWorkspaceStore,
    IndexedDbWorkspaceStore,
    openWorkspaceDatabase,
    create: (options) => new IndexedDbWorkspaceStore(options),
  });

  root.ChatGPTHelperWorkspaceStore = api;
  if (typeof module === "object" && module.exports) module.exports = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
