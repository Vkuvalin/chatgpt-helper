(function initTemplateTree(root) {
  "use strict";

  if (root.ChatGPTHelperTemplateTree) {
    if (typeof module === "object" && module.exports) {
      module.exports = root.ChatGPTHelperTemplateTree;
    }
    return;
  }

  const NODE_KINDS = Object.freeze({
    FOLDER: "folder",
    TEMPLATE: "template",
  });
  const MAX_FOLDER_DEPTH = 6;
  const VALID_ICON_KEYS = Object.freeze([
    "folder",
    "document",
    "code",
    "terminal",
    "database",
    "checklist",
    "chart",
    "globe",
    "translate",
    "brain",
    "spark",
    "shield",
    "bug",
    "bookmark",
    "rocket",
  ]);
  const DEFAULT_FOLDER_ICON = "folder";
  const DEFAULT_TEMPLATE_ICON = "document";
  const MAX_NODE_NAME_LENGTH = 120;
  const MAX_TEMPLATE_CONTENT_LENGTH = 200000;
  const VALID_ICON_SET = new Set(VALID_ICON_KEYS);
  const FOLDER_KEYS = Object.freeze(["id", "kind", "parentId", "name", "iconKey"]);
  const TEMPLATE_KEYS = Object.freeze([
    "id",
    "kind",
    "parentId",
    "name",
    "iconKey",
    "content",
    "autoSend",
  ]);
  const LEGACY_TEMPLATE_KEYS = Object.freeze(["id", "name", "content", "autoSend"]);

  const ERROR_CODES = Object.freeze({
    INVALID_STORED_STATE: "TEMPLATE_TREE_INVALID_STORED_STATE",
    INVALID_NODE: "INVALID_TEMPLATE_NODE",
    INVALID_PATCH: "INVALID_TEMPLATE_PATCH",
    INVALID_PARENT: "INVALID_TEMPLATE_PARENT",
    INVALID_PLACEMENT: "INVALID_TEMPLATE_PLACEMENT",
    INVALID_MOVE: "INVALID_TEMPLATE_MOVE",
    INVALID_DELETE_MODE: "INVALID_TEMPLATE_DELETE_MODE",
    CYCLE: "TEMPLATE_TREE_CYCLE",
    DEPTH_EXCEEDED: "TEMPLATE_TREE_DEPTH_EXCEEDED",
    NOT_FOUND: "TEMPLATE_NODE_NOT_FOUND",
    RELOAD_REQUIRED: "TEMPLATE_TREE_RELOAD_REQUIRED",
  });

  function failure(code, message) {
    return { ok: false, error: { code, message } };
  }

  function success(nodes, changed, extra) {
    return Object.assign({ ok: true, nodes, changed }, extra || {});
  }

  function isRecord(value) {
    return Boolean(value) && typeof value === "object" && !Array.isArray(value);
  }

  function validEntityId(value) {
    return typeof value === "string"
      && value.length >= 1
      && value.length <= 200
      && !/[\u0000-\u001f]/.test(value);
  }

  function sameKeys(value, expected) {
    const keys = Object.keys(value).sort();
    const wanted = [...expected].sort();
    return keys.length === wanted.length && keys.every((key, index) => key === wanted[index]);
  }

  function validName(value) {
    return typeof value === "string"
      && value.trim().length > 0
      && value.length <= MAX_NODE_NAME_LENGTH;
  }

  function validContent(value) {
    return typeof value === "string"
      && value.trim().length > 0
      && value.length <= MAX_TEMPLATE_CONTENT_LENGTH;
  }

  function defaultIconForKind(kind) {
    return kind === NODE_KINDS.FOLDER ? DEFAULT_FOLDER_ICON : DEFAULT_TEMPLATE_ICON;
  }

  function normalizeIconKey(kind, iconKey) {
    return VALID_ICON_SET.has(iconKey) ? iconKey : defaultIconForKind(kind);
  }

  function cloneNode(node) {
    if (node.kind === NODE_KINDS.FOLDER) {
      return {
        id: node.id,
        kind: NODE_KINDS.FOLDER,
        parentId: node.parentId,
        name: node.name,
        iconKey: node.iconKey,
      };
    }
    return {
      id: node.id,
      kind: NODE_KINDS.TEMPLATE,
      parentId: node.parentId,
      name: node.name,
      iconKey: node.iconKey,
      content: node.content,
      autoSend: node.autoSend,
    };
  }

  function nodesEqual(left, right) {
    if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) return false;
    return left.every((node, index) => {
      const other = right[index];
      if (!isRecord(node) || !isRecord(other) || node.kind !== other.kind) return false;
      const keys = node.kind === NODE_KINDS.FOLDER ? FOLDER_KEYS : TEMPLATE_KEYS;
      return keys.every((key) => node[key] === other[key]);
    });
  }

  function isLegacyTemplateRecord(value) {
    return isRecord(value)
      && !Object.prototype.hasOwnProperty.call(value, "kind")
      && sameKeys(value, LEGACY_TEMPLATE_KEYS)
      && validEntityId(value.id)
      && validName(value.name)
      && validContent(value.content)
      && typeof value.autoSend === "boolean";
  }

  function detectLegacyFlatRecords(value) {
    return Array.isArray(value) && value.length > 0 && value.every(isLegacyTemplateRecord);
  }

  function classifyStoredNodes(value) {
    if (value === undefined || (Array.isArray(value) && value.length === 0)) {
      return "empty";
    }
    if (!Array.isArray(value)) return "invalid";
    let legacyCount = 0;
    let typedCount = 0;
    for (const node of value) {
      if (isLegacyTemplateRecord(node)) {
        legacyCount += 1;
      } else if (isRecord(node) && Object.prototype.hasOwnProperty.call(node, "kind")) {
        typedCount += 1;
      } else {
        return "invalid";
      }
    }
    if (legacyCount && typedCount) return "mixed";
    return legacyCount ? "legacy" : "typed";
  }

  function migrateLegacyTemplates(value) {
    if (!Array.isArray(value)) {
      return failure(ERROR_CODES.INVALID_NODE, "Legacy templates must be an array.");
    }
    if (!value.every(isLegacyTemplateRecord)) {
      return failure(ERROR_CODES.INVALID_NODE, "Legacy template storage contains an invalid record.");
    }
    const ids = new Set();
    const nodes = [];
    for (const template of value) {
      if (ids.has(template.id)) {
        return failure(ERROR_CODES.INVALID_NODE, "Template node IDs must be unique.");
      }
      ids.add(template.id);
      nodes.push({
        id: template.id,
        kind: NODE_KINDS.TEMPLATE,
        parentId: null,
        name: template.name,
        iconKey: DEFAULT_TEMPLATE_ICON,
        content: template.content,
        autoSend: template.autoSend,
      });
    }
    return success(nodes, nodes.length > 0, { migrated: nodes.length > 0 });
  }

  function normalizeTypedShape(value) {
    if (!Array.isArray(value)) {
      return failure(ERROR_CODES.INVALID_NODE, "Template tree must be an array.");
    }
    const normalized = [];
    for (const raw of value) {
      if (!isRecord(raw) || (raw.kind !== NODE_KINDS.FOLDER && raw.kind !== NODE_KINDS.TEMPLATE)) {
        return failure(ERROR_CODES.INVALID_NODE, "Every template-tree record must have a valid kind.");
      }
      const requiredKeys = raw.kind === NODE_KINDS.FOLDER ? FOLDER_KEYS : TEMPLATE_KEYS;
      if (!sameKeys(raw, requiredKeys)) {
        return failure(ERROR_CODES.INVALID_NODE, "Template-tree records contain invalid persisted fields.");
      }
      if (!validEntityId(raw.id) || !validName(raw.name)) {
        return failure(ERROR_CODES.INVALID_NODE, "Template-tree record identity or name is invalid.");
      }
      if (raw.parentId !== null && !validEntityId(raw.parentId)) {
        return failure(ERROR_CODES.INVALID_PARENT, "Template-tree parent ID is invalid.");
      }
      if (raw.kind === NODE_KINDS.TEMPLATE
        && (!validContent(raw.content) || typeof raw.autoSend !== "boolean")) {
        return failure(ERROR_CODES.INVALID_NODE, "Template content or auto-send value is invalid.");
      }
      if (!VALID_ICON_SET.has(raw.iconKey)) {
        return failure(ERROR_CODES.INVALID_NODE, "Template-tree icon key is not trusted.");
      }
      normalized.push(raw.kind === NODE_KINDS.FOLDER
        ? {
          id: raw.id,
          kind: NODE_KINDS.FOLDER,
          parentId: raw.parentId,
          name: raw.name,
          iconKey: normalizeIconKey(raw.kind, raw.iconKey),
        }
        : {
          id: raw.id,
          kind: NODE_KINDS.TEMPLATE,
          parentId: raw.parentId,
          name: raw.name,
          iconKey: normalizeIconKey(raw.kind, raw.iconKey),
          content: raw.content,
          autoSend: raw.autoSend,
        });
    }
    return { ok: true, nodes: normalized, changed: !nodesEqual(value, normalized) };
  }

  function indexNodes(nodes) {
    return new Map(nodes.map((node) => [node.id, node]));
  }

  function graphValidation(nodes) {
    const byId = new Map();
    for (const node of nodes) {
      if (byId.has(node.id)) {
        return failure(ERROR_CODES.INVALID_NODE, "Template-tree node IDs must be globally unique.");
      }
      byId.set(node.id, node);
    }

    for (const node of nodes) {
      if (node.parentId === node.id) {
        return failure(ERROR_CODES.CYCLE, "A template-tree node cannot be its own parent.");
      }
      if (node.parentId !== null) {
        const parent = byId.get(node.parentId);
        if (!parent || parent.kind !== NODE_KINDS.FOLDER) {
          return failure(ERROR_CODES.INVALID_PARENT, "Every non-root node must reference an existing folder.");
        }
      }
    }

    const folderDepthById = new Map();
    function resolveFolderDepth(folder, visiting) {
      if (folderDepthById.has(folder.id)) return { ok: true, depth: folderDepthById.get(folder.id) };
      if (visiting.has(folder.id)) {
        return failure(ERROR_CODES.CYCLE, "Template-tree folders must not contain cycles.");
      }
      visiting.add(folder.id);
      let depth = 1;
      if (folder.parentId !== null) {
        const parentResult = resolveFolderDepth(byId.get(folder.parentId), visiting);
        if (!parentResult.ok) return parentResult;
        depth = parentResult.depth + 1;
      }
      visiting.delete(folder.id);
      if (depth > MAX_FOLDER_DEPTH) {
        return failure(
          ERROR_CODES.DEPTH_EXCEEDED,
          `Folder depth must not exceed ${MAX_FOLDER_DEPTH}.`
        );
      }
      folderDepthById.set(folder.id, depth);
      return { ok: true, depth };
    }

    for (const node of nodes) {
      if (node.kind !== NODE_KINDS.FOLDER) continue;
      const depthResult = resolveFolderDepth(node, new Set());
      if (!depthResult.ok) return depthResult;
    }
    return { ok: true, byId, folderDepthById };
  }

  function canonicalizeValidatedNodes(nodes) {
    const byParent = new Map();
    for (const node of nodes) {
      const key = node.parentId;
      if (!byParent.has(key)) byParent.set(key, []);
      byParent.get(key).push(node);
    }
    const result = [];
    const seen = new Set();
    function visit(parentId) {
      for (const child of byParent.get(parentId) || []) {
        if (seen.has(child.id)) continue;
        seen.add(child.id);
        result.push(cloneNode(child));
        if (child.kind === NODE_KINDS.FOLDER) visit(child.id);
      }
    }
    visit(null);
    if (seen.size !== nodes.length) {
      return failure(ERROR_CODES.CYCLE, "Template-tree contains a disconnected cycle.");
    }
    return { ok: true, nodes: result, changed: !nodesEqual(nodes, result) };
  }

  function canonicalizeNodes(value) {
    const shape = normalizeTypedShape(value);
    if (!shape.ok) return shape;
    const graph = graphValidation(shape.nodes);
    if (!graph.ok) return graph;
    const canonical = canonicalizeValidatedNodes(shape.nodes);
    if (!canonical.ok) return canonical;
    canonical.changed = shape.changed || canonical.changed;
    return canonical;
  }

  function validateTypedNodes(value, options) {
    const shape = normalizeTypedShape(value);
    if (!shape.ok) return shape;
    const graph = graphValidation(shape.nodes);
    if (!graph.ok) return graph;
    const canonical = canonicalizeValidatedNodes(shape.nodes);
    if (!canonical.ok) return canonical;
    const requireCanonical = !options || options.requireCanonical !== false;
    const sameOrder = shape.nodes.length === canonical.nodes.length
      && shape.nodes.every((node, index) => node.id === canonical.nodes[index].id);
    if (requireCanonical && !sameOrder) {
      return failure(
        ERROR_CODES.INVALID_NODE,
        "Persisted template-tree nodes must be in canonical preorder."
      );
    }
    return {
      ok: true,
      nodes: canonical.nodes,
      changed: shape.changed || canonical.changed,
    };
  }

  function prepareStoredNodes(value) {
    const classification = classifyStoredNodes(value);
    if (classification === "empty") {
      return success([], false, { migrated: false });
    }
    if (classification === "legacy") {
      const migration = migrateLegacyTemplates(value);
      return migration.ok
        ? migration
        : failure(ERROR_CODES.INVALID_STORED_STATE, migration.error.message);
    }
    if (classification === "mixed") {
      return failure(
        ERROR_CODES.INVALID_STORED_STATE,
        "Legacy and typed template records cannot be mixed."
      );
    }
    if (classification === "invalid") {
      return failure(ERROR_CODES.INVALID_STORED_STATE, "Stored template data is invalid.");
    }
    const validation = validateTypedNodes(value);
    if (!validation.ok) {
      return failure(ERROR_CODES.INVALID_STORED_STATE, validation.error.message);
    }
    return success(validation.nodes, validation.changed, { migrated: false });
  }

  function findNode(nodes, nodeId) {
    return (Array.isArray(nodes) ? nodes : []).find((node) => node.id === nodeId) || null;
  }

  function childrenOf(nodes, parentId) {
    return (Array.isArray(nodes) ? nodes : [])
      .filter((node) => node.parentId === parentId)
      .map(cloneNode);
  }

  function ancestorsOf(nodes, nodeId) {
    const byId = indexNodes(Array.isArray(nodes) ? nodes : []);
    const node = byId.get(nodeId);
    if (!node) return [];
    const result = [];
    const seen = new Set();
    let parentId = node.parentId;
    while (parentId !== null && byId.has(parentId) && !seen.has(parentId)) {
      seen.add(parentId);
      const parent = byId.get(parentId);
      result.unshift(cloneNode(parent));
      parentId = parent.parentId;
    }
    return result;
  }

  function descendantIds(nodes, nodeId) {
    const byParent = new Map();
    for (const node of Array.isArray(nodes) ? nodes : []) {
      if (!byParent.has(node.parentId)) byParent.set(node.parentId, []);
      byParent.get(node.parentId).push(node);
    }
    const result = [];
    function visit(parentId) {
      for (const child of byParent.get(parentId) || []) {
        result.push(child.id);
        if (child.kind === NODE_KINDS.FOLDER) visit(child.id);
      }
    }
    visit(nodeId);
    return result;
  }

  function descendantsOf(nodes, nodeId) {
    const ids = new Set(descendantIds(nodes, nodeId));
    return (Array.isArray(nodes) ? nodes : []).filter((node) => ids.has(node.id)).map(cloneNode);
  }

  function subtreeOf(nodes, nodeId) {
    const node = findNode(nodes, nodeId);
    if (!node) return [];
    const ids = new Set([nodeId, ...descendantIds(nodes, nodeId)]);
    return nodes.filter((candidate) => ids.has(candidate.id)).map(cloneNode);
  }

  function folderDepth(nodes, folderId) {
    const node = findNode(nodes, folderId);
    if (!node || node.kind !== NODE_KINDS.FOLDER) return null;
    return ancestorsOf(nodes, folderId).length + 1;
  }

  function subtreeMaximumRelativeDepth(nodes, folderId) {
    const node = findNode(nodes, folderId);
    if (!node || node.kind !== NODE_KINDS.FOLDER) return null;
    const baseDepth = folderDepth(nodes, folderId);
    let relative = 0;
    for (const descendant of descendantsOf(nodes, folderId)) {
      if (descendant.kind !== NODE_KINDS.FOLDER) continue;
      relative = Math.max(relative, folderDepth(nodes, descendant.id) - baseDepth);
    }
    return relative;
  }

  function normalizeRecentTemplateIds(value, nodes) {
    const templateIds = new Set(
      (Array.isArray(nodes) ? nodes : [])
        .filter((node) => node.kind === NODE_KINDS.TEMPLATE)
        .map((node) => node.id)
    );
    const seen = new Set();
    const result = [];
    for (const id of Array.isArray(value) ? value : []) {
      if (typeof id !== "string" || seen.has(id) || !templateIds.has(id)) continue;
      seen.add(id);
      result.push(id);
    }
    return result;
  }

  function normalizeTreeUiState(value, nodes) {
    const folderIds = new Set(
      (Array.isArray(nodes) ? nodes : [])
        .filter((node) => node.kind === NODE_KINDS.FOLDER)
        .map((node) => node.id)
    );
    const source = isRecord(value) && Array.isArray(value.collapsedFolderIds)
      ? value.collapsedFolderIds
      : [];
    const seen = new Set();
    const collapsedFolderIds = [];
    for (const id of source) {
      if (typeof id !== "string" || seen.has(id) || !folderIds.has(id)) continue;
      seen.add(id);
      collapsedFolderIds.push(id);
    }
    return { collapsedFolderIds };
  }

  function visibleProjection(nodes, collapsedFolderIds) {
    const collapsed = new Set(
      Array.isArray(collapsedFolderIds)
        ? collapsedFolderIds
        : normalizeTreeUiState(collapsedFolderIds, nodes).collapsedFolderIds
    );
    const hiddenParents = new Set();
    const result = [];
    for (const node of Array.isArray(nodes) ? nodes : []) {
      const ancestors = ancestorsOf(nodes, node.id);
      const hidden = ancestors.some((parent) => hiddenParents.has(parent.id) || collapsed.has(parent.id));
      if (hidden) continue;
      const directChildren = childrenOf(nodes, node.id);
      result.push({
        node: cloneNode(node),
        depth: ancestors.length,
        collapsed: node.kind === NODE_KINDS.FOLDER && collapsed.has(node.id),
        hasChildren: node.kind === NODE_KINDS.FOLDER && directChildren.length > 0,
      });
      if (node.kind === NODE_KINDS.FOLDER && collapsed.has(node.id)) hiddenParents.add(node.id);
    }
    return result;
  }

  function breadcrumbs(nodes, nodeId, options) {
    const node = findNode(nodes, nodeId);
    if (!node) return [];
    const includeNode = Boolean(options && options.includeNode);
    const result = ancestorsOf(nodes, nodeId);
    if (includeNode || node.kind === NODE_KINDS.FOLDER) result.push(cloneNode(node));
    return result;
  }

  function placementValidation(nodes, targetParentId, beforeNodeId) {
    if (targetParentId !== null) {
      const parent = findNode(nodes, targetParentId);
      if (!parent || parent.kind !== NODE_KINDS.FOLDER) {
        return failure(ERROR_CODES.INVALID_PARENT, "Target parent must be an existing folder or root.");
      }
    }
    if (beforeNodeId !== null) {
      const before = findNode(nodes, beforeNodeId);
      if (!before || before.parentId !== targetParentId) {
        return failure(
          ERROR_CODES.INVALID_PLACEMENT,
          "The before node must be a direct child of the target parent."
        );
      }
    }
    return { ok: true };
  }

  function insertionIndex(nodes, targetParentId, beforeNodeId) {
    if (beforeNodeId !== null) return nodes.findIndex((node) => node.id === beforeNodeId);
    if (targetParentId === null) return nodes.length;
    const targetIndex = nodes.findIndex((node) => node.id === targetParentId);
    if (targetIndex < 0) return nodes.length;
    const descendants = new Set(descendantIds(nodes, targetParentId));
    let index = targetIndex + 1;
    while (index < nodes.length && descendants.has(nodes[index].id)) index += 1;
    return index;
  }

  function validateMoveDepth(nodes, node, targetParentId) {
    if (node.kind !== NODE_KINDS.FOLDER) return { ok: true };
    const parentDepth = targetParentId === null ? 0 : folderDepth(nodes, targetParentId);
    const relativeDepth = subtreeMaximumRelativeDepth(nodes, node.id);
    if (parentDepth + 1 + relativeDepth > MAX_FOLDER_DEPTH) {
      return failure(
        ERROR_CODES.DEPTH_EXCEEDED,
        `Moving this subtree would exceed folder depth ${MAX_FOLDER_DEPTH}.`
      );
    }
    return { ok: true };
  }

  function moveNode(value, command) {
    const validation = validateTypedNodes(value);
    if (!validation.ok) return validation;
    const nodes = validation.nodes;
    if (!isRecord(command) || !validEntityId(command.nodeId)) {
      return failure(ERROR_CODES.INVALID_MOVE, "A valid node ID is required.");
    }
    const node = findNode(nodes, command.nodeId);
    if (!node) return failure(ERROR_CODES.NOT_FOUND, "Template-tree node was not found.");
    const targetParentId = command.targetParentId === undefined ? null : command.targetParentId;
    const beforeNodeId = command.beforeNodeId === undefined ? null : command.beforeNodeId;
    const placement = placementValidation(nodes, targetParentId, beforeNodeId);
    if (!placement.ok) return placement;
    if (beforeNodeId === node.id) return success(nodes.map(cloneNode), false);
    if (node.kind === NODE_KINDS.FOLDER) {
      const descendantSet = new Set(descendantIds(nodes, node.id));
      if (targetParentId === node.id || descendantSet.has(targetParentId)) {
        return failure(ERROR_CODES.CYCLE, "A folder cannot move into itself or its descendant.");
      }
    }
    const depth = validateMoveDepth(nodes, node, targetParentId);
    if (!depth.ok) return depth;

    const movingIds = new Set([node.id, ...descendantIds(nodes, node.id)]);
    const moving = nodes
      .filter((candidate) => movingIds.has(candidate.id))
      .map((candidate) => candidate.id === node.id
        ? Object.assign(cloneNode(candidate), { parentId: targetParentId })
        : cloneNode(candidate));
    const remaining = nodes.filter((candidate) => !movingIds.has(candidate.id)).map(cloneNode);
    const index = insertionIndex(remaining, targetParentId, beforeNodeId);
    if (index < 0) {
      return failure(ERROR_CODES.INVALID_PLACEMENT, "Move placement is stale.");
    }
    const result = [...remaining.slice(0, index), ...moving, ...remaining.slice(index)];
    return success(result, !nodesEqual(nodes, result));
  }

  function createNode(value, command) {
    const validation = validateTypedNodes(value);
    if (!validation.ok) return validation;
    const nodes = validation.nodes;
    if (!isRecord(command) || !validEntityId(command.id) || !isRecord(command.draft)) {
      return failure(ERROR_CODES.INVALID_NODE, "A valid node ID and draft are required.");
    }
    if (findNode(nodes, command.id)) {
      return failure(ERROR_CODES.INVALID_NODE, "Template-tree node ID already exists.");
    }
    const draft = command.draft;
    if (draft.kind !== NODE_KINDS.FOLDER && draft.kind !== NODE_KINDS.TEMPLATE) {
      return failure(ERROR_CODES.INVALID_NODE, "Node kind must be folder or template.");
    }
    const targetParentId = command.targetParentId === undefined ? null : command.targetParentId;
    const beforeNodeId = command.beforeNodeId === undefined ? null : command.beforeNodeId;
    const placement = placementValidation(nodes, targetParentId, beforeNodeId);
    if (!placement.ok) return placement;
    if (!validName(draft.name)) {
      return failure(ERROR_CODES.INVALID_NODE, "Node name must be non-empty and at most 120 characters.");
    }
    if (draft.kind === NODE_KINDS.FOLDER) {
      const depth = targetParentId === null ? 1 : folderDepth(nodes, targetParentId) + 1;
      if (depth > MAX_FOLDER_DEPTH) {
        return failure(
          ERROR_CODES.DEPTH_EXCEEDED,
          `Folder depth must not exceed ${MAX_FOLDER_DEPTH}.`
        );
      }
    } else if (!validContent(draft.content) || typeof draft.autoSend !== "boolean") {
      return failure(ERROR_CODES.INVALID_NODE, "Template content and auto-send values are required.");
    }
    const node = draft.kind === NODE_KINDS.FOLDER
      ? {
        id: command.id,
        kind: NODE_KINDS.FOLDER,
        parentId: targetParentId,
        name: draft.name,
        iconKey: normalizeIconKey(draft.kind, draft.iconKey),
      }
      : {
        id: command.id,
        kind: NODE_KINDS.TEMPLATE,
        parentId: targetParentId,
        name: draft.name,
        iconKey: normalizeIconKey(draft.kind, draft.iconKey),
        content: draft.content,
        autoSend: draft.autoSend,
      };
    const index = insertionIndex(nodes, targetParentId, beforeNodeId);
    const result = [...nodes.slice(0, index).map(cloneNode), node, ...nodes.slice(index).map(cloneNode)];
    return success(result, true, { createdNodeId: node.id });
  }

  function validatePatch(node, patch) {
    if (!isRecord(patch)) {
      return failure(ERROR_CODES.INVALID_PATCH, "Template patch must be an object.");
    }
    const allowed = node.kind === NODE_KINDS.FOLDER
      ? new Set(["name", "iconKey"])
      : new Set(["name", "iconKey", "content", "autoSend"]);
    for (const key of Object.keys(patch)) {
      if (!allowed.has(key)) {
        return failure(ERROR_CODES.INVALID_PATCH, `Template patch field is not allowed: ${key}.`);
      }
    }
    if (Object.prototype.hasOwnProperty.call(patch, "name") && !validName(patch.name)) {
      return failure(ERROR_CODES.INVALID_PATCH, "Node name must be non-empty and at most 120 characters.");
    }
    if (Object.prototype.hasOwnProperty.call(patch, "content") && !validContent(patch.content)) {
      return failure(ERROR_CODES.INVALID_PATCH, "Template content must be non-empty and valid.");
    }
    if (Object.prototype.hasOwnProperty.call(patch, "autoSend")
      && typeof patch.autoSend !== "boolean") {
      return failure(ERROR_CODES.INVALID_PATCH, "Template auto-send must be boolean.");
    }
    return { ok: true };
  }

  function updateNode(value, command) {
    const validation = validateTypedNodes(value);
    if (!validation.ok) return validation;
    const nodes = validation.nodes;
    if (!isRecord(command) || !validEntityId(command.nodeId)) {
      return failure(ERROR_CODES.INVALID_PATCH, "A valid node ID is required.");
    }
    const node = findNode(nodes, command.nodeId);
    if (!node) return failure(ERROR_CODES.NOT_FOUND, "Template-tree node was not found.");
    const patch = command.patch === undefined ? {} : command.patch;
    const patchValidation = validatePatch(node, patch);
    if (!patchValidation.ok) return patchValidation;
    const patched = nodes.map((candidate) => {
      if (candidate.id !== node.id) return cloneNode(candidate);
      const result = cloneNode(candidate);
      for (const key of Object.keys(patch)) {
        result[key] = key === "iconKey"
          ? normalizeIconKey(candidate.kind, patch[key])
          : patch[key];
      }
      return result;
    });
    if (command.placement !== undefined) {
      if (!isRecord(command.placement)) {
        return failure(ERROR_CODES.INVALID_PLACEMENT, "Template placement must be an object.");
      }
      const moved = moveNode(patched, {
        nodeId: node.id,
        targetParentId: command.placement.targetParentId === undefined
          ? null
          : command.placement.targetParentId,
        beforeNodeId: command.placement.beforeNodeId === undefined
          ? null
          : command.placement.beforeNodeId,
      });
      if (!moved.ok) return moved;
      return success(moved.nodes, !nodesEqual(nodes, moved.nodes));
    }
    return success(patched, !nodesEqual(nodes, patched));
  }

  function subtreeStats(nodes, nodeId) {
    const subtree = subtreeOf(nodes, nodeId);
    return {
      folderCount: subtree.filter((node) => node.kind === NODE_KINDS.FOLDER).length,
      templateCount: subtree.filter((node) => node.kind === NODE_KINDS.TEMPLATE).length,
    };
  }

  function deleteNode(value, command) {
    const validation = validateTypedNodes(value);
    if (!validation.ok) return validation;
    const nodes = validation.nodes;
    if (!isRecord(command) || !validEntityId(command.nodeId)) {
      return failure(ERROR_CODES.NOT_FOUND, "A valid node ID is required.");
    }
    const node = findNode(nodes, command.nodeId);
    if (!node) return failure(ERROR_CODES.NOT_FOUND, "Template-tree node was not found.");
    if (node.kind === NODE_KINDS.TEMPLATE && command.mode !== "node") {
      return failure(ERROR_CODES.INVALID_DELETE_MODE, "Templates must use node delete mode.");
    }
    if (node.kind === NODE_KINDS.FOLDER
      && command.mode !== "promote-children"
      && command.mode !== "subtree") {
      return failure(
        ERROR_CODES.INVALID_DELETE_MODE,
        "Folders must use promote-children or subtree delete mode."
      );
    }

    if (node.kind === NODE_KINDS.FOLDER && command.mode === "promote-children") {
      const result = nodes
        .filter((candidate) => candidate.id !== node.id)
        .map((candidate) => {
          const clone = cloneNode(candidate);
          if (clone.parentId === node.id) clone.parentId = node.parentId;
          return clone;
        });
      return success(result, true, {
        removedFolderCount: 1,
        removedTemplateCount: 0,
        removedNodeIds: [node.id],
      });
    }

    const removedIds = node.kind === NODE_KINDS.FOLDER
      ? new Set([node.id, ...descendantIds(nodes, node.id)])
      : new Set([node.id]);
    const stats = subtreeStats(nodes, node.id);
    const result = nodes.filter((candidate) => !removedIds.has(candidate.id)).map(cloneNode);
    return success(result, true, {
      removedFolderCount: stats.folderCount,
      removedTemplateCount: stats.templateCount,
      removedNodeIds: [...removedIds],
    });
  }

  function parentPickerOptions(nodes, movingNodeId) {
    const validation = validateTypedNodes(nodes);
    if (!validation.ok) return [];
    const moving = movingNodeId ? findNode(validation.nodes, movingNodeId) : null;
    const excluded = new Set();
    if (moving && moving.kind === NODE_KINDS.FOLDER) {
      excluded.add(moving.id);
      descendantIds(validation.nodes, moving.id).forEach((id) => excluded.add(id));
    }
    const relativeDepth = moving && moving.kind === NODE_KINDS.FOLDER
      ? subtreeMaximumRelativeDepth(validation.nodes, moving.id)
      : 0;
    const options = [{ id: null, name: "Root", depth: 0, breadcrumbs: [] }];
    for (const folder of validation.nodes) {
      if (folder.kind !== NODE_KINDS.FOLDER || excluded.has(folder.id)) continue;
      if (moving && moving.kind === NODE_KINDS.FOLDER
        && folderDepth(validation.nodes, folder.id) + 1 + relativeDepth > MAX_FOLDER_DEPTH) {
        continue;
      }
      const path = breadcrumbs(validation.nodes, folder.id, { includeNode: true });
      options.push({
        id: folder.id,
        name: folder.name,
        depth: folderDepth(validation.nodes, folder.id),
        breadcrumbs: path.map((node) => node.name),
      });
    }
    return options;
  }

  const api = Object.freeze({
    NODE_KINDS,
    MAX_FOLDER_DEPTH,
    VALID_ICON_KEYS,
    DEFAULT_FOLDER_ICON,
    DEFAULT_TEMPLATE_ICON,
    ERROR_CODES,
    normalizeIconKey,
    isLegacyTemplateRecord,
    detectLegacyFlatRecords,
    classifyStoredNodes,
    migrateLegacyTemplates,
    validateTypedNodes,
    prepareStoredNodes,
    canonicalizeNodes,
    findNode,
    childrenOf,
    ancestorsOf,
    descendantsOf,
    subtreeOf,
    folderDepth,
    subtreeMaximumRelativeDepth,
    visibleProjection,
    breadcrumbs,
    parentPickerOptions,
    createNode,
    updateNode,
    moveNode,
    deleteNode,
    subtreeStats,
    normalizeRecentTemplateIds,
    normalizeTreeUiState,
    nodesEqual,
  });

  root.ChatGPTHelperTemplateTree = api;
  if (typeof module === "object" && module.exports) module.exports = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
