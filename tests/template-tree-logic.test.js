"use strict";

const assert = require("assert");
const fs = require("fs");
const vm = require("vm");
const tree = require("../src/template-tree.js");

const {
  NODE_KINDS,
  MAX_FOLDER_DEPTH,
  VALID_ICON_KEYS,
  DEFAULT_FOLDER_ICON,
  DEFAULT_TEMPLATE_ICON,
  ERROR_CODES,
} = tree;

function folder(id, parentId, name = id, iconKey = "folder") {
  return { id, kind: "folder", parentId, name, iconKey };
}

function template(id, parentId, name = id, content = `content:${id}`, autoSend = false, iconKey = "document") {
  return { id, kind: "template", parentId, name, iconKey, content, autoSend };
}

function legacy(id, name = id, content = `legacy:${id}`, autoSend = false) {
  return { id, name, content, autoSend };
}

function ids(nodes) {
  return nodes.map((node) => node.id);
}

function deepClone(value) {
  return JSON.parse(JSON.stringify(value));
}

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  Object.freeze(value);
  Object.values(value).forEach(deepFreeze);
  return value;
}

function assertError(result, code) {
  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.error.code, code);
}

function sampleTree() {
  return [
    folder("folder-a", null, "A", "code"),
    template("template-a1", "folder-a", "A1"),
    folder("folder-b", "folder-a", "B", "database"),
    template("template-b1", "folder-b", "B1", "B1 content", true, "checklist"),
    template("template-root", null, "Root"),
  ];
}

assert.deepStrictEqual(tree.prepareStoredNodes(undefined), {
  ok: true,
  nodes: [],
  changed: false,
  migrated: false,
});
assert.deepStrictEqual(tree.prepareStoredNodes([]), {
  ok: true,
  nodes: [],
  changed: false,
  migrated: false,
});
assertError(tree.prepareStoredNodes(null), ERROR_CODES.INVALID_STORED_STATE);

{
  const context = {};
  vm.runInNewContext(
    fs.readFileSync(require.resolve("../src/template-tree.js"), "utf8"),
    context,
  );
  assert.strictEqual(typeof context.ChatGPTHelperTemplateTree.moveNode, "function");
  assert.strictEqual(context.document, undefined);
  assert.strictEqual(context.chrome, undefined);
  assert.strictEqual(context.fetch, undefined);
}

{
  const source = [
    legacy("template-1", " Exact name ", " Exact content ", true),
    legacy("template-2", "Second", "Second content", false),
  ];
  const snapshot = deepClone(source);
  const migrated = tree.prepareStoredNodes(source);
  assert.strictEqual(migrated.ok, true);
  assert.strictEqual(migrated.migrated, true);
  assert.strictEqual(migrated.changed, true);
  assert.deepStrictEqual(source, snapshot);
  assert.deepStrictEqual(ids(migrated.nodes), ["template-1", "template-2"]);
  assert.deepStrictEqual(migrated.nodes[0], {
    id: "template-1",
    kind: "template",
    parentId: null,
    name: " Exact name ",
    iconKey: DEFAULT_TEMPLATE_ICON,
    content: " Exact content ",
    autoSend: true,
  });
  const idempotent = tree.prepareStoredNodes(migrated.nodes);
  assert.strictEqual(idempotent.ok, true);
  assert.strictEqual(idempotent.migrated, false);
  assert.strictEqual(idempotent.changed, false);
  assert.deepStrictEqual(idempotent.nodes, migrated.nodes);
}

assertError(
  tree.prepareStoredNodes([legacy("template-1"), template("template-2", null)]),
  ERROR_CODES.INVALID_STORED_STATE
);
assertError(
  tree.prepareStoredNodes([legacy("duplicate"), legacy("duplicate")]),
  ERROR_CODES.INVALID_STORED_STATE
);

{
  const valid = tree.validateTypedNodes(sampleTree());
  assert.strictEqual(valid.ok, true);
  assert.strictEqual(valid.changed, false);
  assert.deepStrictEqual(ids(valid.nodes), [
    "folder-a",
    "template-a1",
    "folder-b",
    "template-b1",
    "template-root",
  ]);
  assert.deepStrictEqual(Object.keys(valid.nodes[0]).sort(), [
    "iconKey", "id", "kind", "name", "parentId",
  ]);
  assert.deepStrictEqual(Object.keys(valid.nodes[1]).sort(), [
    "autoSend", "content", "iconKey", "id", "kind", "name", "parentId",
  ]);
}

{
  assertError(tree.validateTypedNodes([
    { id: "folder-a", kind: "folder", parentId: null, name: "A" },
    {
      id: "template-a",
      kind: "template",
      parentId: "folder-a",
      name: "T",
      iconKey: "<svg onload=alert(1)>",
      content: "content",
      autoSend: false,
    },
  ]), ERROR_CODES.INVALID_NODE);
  const fallbackCreate = tree.createNode([], {
    id: "folder-safe",
    draft: { kind: "folder", name: "Safe", iconKey: "<svg onload=alert(1)>" },
    targetParentId: null,
    beforeNodeId: null,
  });
  assert.strictEqual(fallbackCreate.ok, true);
  assert.strictEqual(fallbackCreate.nodes[0].iconKey, DEFAULT_FOLDER_ICON);
  assert.deepStrictEqual(VALID_ICON_KEYS, [
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
}

assertError(
  tree.validateTypedNodes([
    {
      ...folder("folder-extra", null),
      content: "<svg onload=alert(1)>",
    },
  ]),
  ERROR_CODES.INVALID_NODE
);
assertError(
  tree.validateTypedNodes([
    {
      id: "template-missing",
      kind: "template",
      parentId: null,
      name: "Missing",
      iconKey: "document",
      autoSend: false,
    },
  ]),
  ERROR_CODES.INVALID_NODE
);

assertError(
  tree.validateTypedNodes([folder("same", null), template("same", null)]),
  ERROR_CODES.INVALID_NODE
);
assertError(
  tree.validateTypedNodes([template("template-a", "missing")]),
  ERROR_CODES.INVALID_PARENT
);
assertError(
  tree.validateTypedNodes([
    template("template-parent", null),
    template("template-child", "template-parent"),
  ]),
  ERROR_CODES.INVALID_PARENT
);
assertError(
  tree.validateTypedNodes([folder("folder-self", "folder-self")]),
  ERROR_CODES.CYCLE
);
assertError(
  tree.validateTypedNodes([
    folder("folder-a", "folder-b"),
    folder("folder-b", "folder-a"),
  ]),
  ERROR_CODES.CYCLE
);

{
  const depthSix = [];
  let parentId = null;
  for (let depth = 1; depth <= MAX_FOLDER_DEPTH; depth += 1) {
    const id = `folder-${depth}`;
    depthSix.push(folder(id, parentId));
    parentId = id;
  }
  assert.strictEqual(tree.validateTypedNodes(depthSix).ok, true);
  assert.strictEqual(tree.folderDepth(depthSix, "folder-6"), 6);
  assert.strictEqual(tree.subtreeMaximumRelativeDepth(depthSix, "folder-1"), 5);
  const depthSeven = [...depthSix, folder("folder-7", "folder-6")];
  assertError(tree.validateTypedNodes(depthSeven), ERROR_CODES.DEPTH_EXCEEDED);
}

{
  const noncanonical = [
    template("template-child", "folder-parent"),
    folder("folder-parent", null),
  ];
  assertError(tree.validateTypedNodes(noncanonical), ERROR_CODES.INVALID_NODE);
  const canonical = tree.canonicalizeNodes(noncanonical);
  assert.strictEqual(canonical.ok, true);
  assert.deepStrictEqual(ids(canonical.nodes), ["folder-parent", "template-child"]);

  const disconnectedSubtree = [
    folder("folder-a", null),
    template("template-a", "folder-a"),
    template("template-root", null),
    folder("folder-b", "folder-a"),
  ];
  assertError(tree.validateTypedNodes(disconnectedSubtree), ERROR_CODES.INVALID_NODE);
  assert.deepStrictEqual(ids(tree.canonicalizeNodes(disconnectedSubtree).nodes), [
    "folder-a",
    "template-a",
    "folder-b",
    "template-root",
  ]);
}

{
  const source = sampleTree();
  const snapshot = deepClone(source);
  const rootCreate = tree.createNode(source, {
    id: "template-new",
    draft: {
      kind: NODE_KINDS.TEMPLATE,
      name: "New",
      content: "New content",
      autoSend: true,
      iconKey: "rocket",
    },
    targetParentId: null,
    beforeNodeId: "template-root",
  });
  assert.strictEqual(rootCreate.ok, true);
  assert.strictEqual(rootCreate.createdNodeId, "template-new");
  assert.deepStrictEqual(ids(rootCreate.nodes), [
    "folder-a",
    "template-a1",
    "folder-b",
    "template-b1",
    "template-new",
    "template-root",
  ]);
  assert.deepStrictEqual(source, snapshot);

  const nestedCreate = tree.createNode(rootCreate.nodes, {
    id: "folder-new",
    draft: { kind: NODE_KINDS.FOLDER, name: "New folder", iconKey: "bug" },
    targetParentId: "folder-b",
    beforeNodeId: null,
  });
  assert.strictEqual(nestedCreate.ok, true);
  assert.deepStrictEqual(ids(nestedCreate.nodes), [
    "folder-a",
    "template-a1",
    "folder-b",
    "template-b1",
    "folder-new",
    "template-new",
    "template-root",
  ]);

  const append = tree.createNode(nestedCreate.nodes, {
    id: "template-last",
    draft: {
      kind: NODE_KINDS.TEMPLATE,
      name: "Last",
      content: "Last content",
      autoSend: false,
    },
    targetParentId: "folder-a",
    beforeNodeId: null,
  });
  assert.strictEqual(append.ok, true);
  assert.deepStrictEqual(ids(tree.childrenOf(append.nodes, "folder-a")), [
    "template-a1",
    "folder-b",
    "template-last",
  ]);
}

{
  const source = sampleTree();
  const updated = tree.updateNode(source, {
    nodeId: "template-a1",
    patch: { name: "Renamed", iconKey: "spark", content: "Changed", autoSend: true },
  });
  assert.strictEqual(updated.ok, true);
  assert.deepStrictEqual(tree.findNode(updated.nodes, "template-a1"), {
    id: "template-a1",
    kind: "template",
    parentId: "folder-a",
    name: "Renamed",
    iconKey: "spark",
    content: "Changed",
    autoSend: true,
  });

  const atomic = tree.updateNode(source, {
    nodeId: "template-a1",
    patch: { name: "Moved and renamed" },
    placement: { targetParentId: null, beforeNodeId: "template-root" },
  });
  assert.strictEqual(atomic.ok, true);
  assert.strictEqual(tree.findNode(atomic.nodes, "template-a1").parentId, null);
  assert.deepStrictEqual(ids(atomic.nodes).slice(-2), ["template-a1", "template-root"]);

  const rejected = tree.updateNode(source, {
    nodeId: "template-a1",
    patch: { name: "Must not persist" },
    placement: { targetParentId: "missing", beforeNodeId: null },
  });
  assertError(rejected, ERROR_CODES.INVALID_PARENT);
  assert.strictEqual(tree.findNode(source, "template-a1").name, "A1");
  assertError(
    tree.updateNode(source, { nodeId: "folder-a", patch: { content: "forbidden" } }),
    ERROR_CODES.INVALID_PATCH
  );
}

{
  const source = sampleTree();
  const before = tree.moveNode(source, {
    nodeId: "template-root",
    targetParentId: null,
    beforeNodeId: "folder-a",
  });
  assert.strictEqual(before.ok, true);
  assert.deepStrictEqual(ids(before.nodes), [
    "template-root",
    "folder-a",
    "template-a1",
    "folder-b",
    "template-b1",
  ]);

  const inside = tree.moveNode(source, {
    nodeId: "template-root",
    targetParentId: "folder-b",
    beforeNodeId: null,
  });
  assert.strictEqual(inside.ok, true);
  assert.strictEqual(tree.findNode(inside.nodes, "template-root").parentId, "folder-b");
  assert.deepStrictEqual(ids(tree.childrenOf(inside.nodes, "folder-b")), [
    "template-b1",
    "template-root",
  ]);

  const root = tree.moveNode(inside.nodes, {
    nodeId: "template-root",
    targetParentId: null,
    beforeNodeId: null,
  });
  assert.strictEqual(root.ok, true);
  assert.deepStrictEqual(ids(root.nodes).slice(-1), ["template-root"]);

  const wholeSubtree = tree.moveNode(source, {
    nodeId: "folder-b",
    targetParentId: null,
    beforeNodeId: "template-root",
  });
  assert.strictEqual(wholeSubtree.ok, true);
  assert.deepStrictEqual(ids(wholeSubtree.nodes), [
    "folder-a",
    "template-a1",
    "folder-b",
    "template-b1",
    "template-root",
  ]);
  assert.strictEqual(tree.findNode(wholeSubtree.nodes, "folder-b").parentId, null);
  assert.strictEqual(tree.findNode(wholeSubtree.nodes, "template-b1").parentId, "folder-b");

  const afterFolder = tree.moveNode(source, {
    nodeId: "template-a1",
    targetParentId: null,
    beforeNodeId: "template-root",
  });
  assert.strictEqual(afterFolder.ok, true);
  assert.deepStrictEqual(ids(afterFolder.nodes), [
    "folder-a",
    "folder-b",
    "template-b1",
    "template-a1",
    "template-root",
  ]);

  assertError(
    tree.moveNode(source, {
      nodeId: "folder-a",
      targetParentId: "folder-b",
      beforeNodeId: null,
    }),
    ERROR_CODES.CYCLE
  );
  const noOp = tree.moveNode(source, {
    nodeId: "template-a1",
    targetParentId: "folder-a",
    beforeNodeId: "template-a1",
  });
  assert.strictEqual(noOp.ok, true);
  assert.strictEqual(noOp.changed, false);
  assert.deepStrictEqual(noOp.nodes, source);
  assertError(tree.moveNode(source, {
    nodeId: "template-a1",
    targetParentId: "missing",
    beforeNodeId: "template-a1",
  }), ERROR_CODES.INVALID_PARENT);
  assertError(tree.updateNode(source, {
    nodeId: "template-a1",
    patch: { name: "Atomic rejection" },
    placement: {
      targetParentId: "missing",
      beforeNodeId: "template-a1",
    },
  }), ERROR_CODES.INVALID_PARENT);
  assertError(tree.moveNode(source, {
    nodeId: "folder-a",
    targetParentId: "folder-a",
    beforeNodeId: null,
  }), ERROR_CODES.CYCLE);
}

{
  const deep = [];
  let parentId = null;
  for (let depth = 1; depth <= 5; depth += 1) {
    const id = `target-${depth}`;
    deep.push(folder(id, parentId));
    parentId = id;
  }
  deep.push(folder("moving-root", null));
  deep.push(folder("moving-child", "moving-root"));
  assertError(
    tree.moveNode(deep, {
      nodeId: "moving-root",
      targetParentId: "target-5",
      beforeNodeId: null,
    }),
    ERROR_CODES.DEPTH_EXCEEDED
  );
}

{
  const source = sampleTree();
  const templateDelete = tree.deleteNode(source, {
    nodeId: "template-a1",
    mode: "node",
  });
  assert.strictEqual(templateDelete.ok, true);
  assert.strictEqual(templateDelete.removedFolderCount, 0);
  assert.strictEqual(templateDelete.removedTemplateCount, 1);
  assert.strictEqual(tree.findNode(templateDelete.nodes, "template-a1"), null);

  const promote = tree.deleteNode(source, {
    nodeId: "folder-a",
    mode: "promote-children",
  });
  assert.strictEqual(promote.ok, true);
  assert.deepStrictEqual(ids(promote.nodes), [
    "template-a1",
    "folder-b",
    "template-b1",
    "template-root",
  ]);
  assert.strictEqual(tree.findNode(promote.nodes, "template-a1").parentId, null);
  assert.strictEqual(tree.findNode(promote.nodes, "folder-b").parentId, null);
  assert.strictEqual(tree.findNode(promote.nodes, "template-b1").parentId, "folder-b");

  const nestedPromotion = tree.deleteNode(source, {
    nodeId: "folder-b",
    mode: "promote-children",
  });
  assert.strictEqual(nestedPromotion.ok, true);
  assert.deepStrictEqual(ids(nestedPromotion.nodes), [
    "folder-a",
    "template-a1",
    "template-b1",
    "template-root",
  ]);
  assert.strictEqual(tree.findNode(nestedPromotion.nodes, "template-b1").parentId, "folder-a");

  const subtreeDelete = tree.deleteNode(source, {
    nodeId: "folder-a",
    mode: "subtree",
  });
  assert.strictEqual(subtreeDelete.ok, true);
  assert.strictEqual(subtreeDelete.removedFolderCount, 2);
  assert.strictEqual(subtreeDelete.removedTemplateCount, 2);
  assert.deepStrictEqual(ids(subtreeDelete.nodes), ["template-root"]);
  assertError(
    tree.deleteNode(source, { nodeId: "template-a1", mode: "subtree" }),
    ERROR_CODES.INVALID_DELETE_MODE
  );
  assertError(
    tree.deleteNode(source, { nodeId: "folder-a", mode: "node" }),
    ERROR_CODES.INVALID_DELETE_MODE
  );
  assertError(
    tree.deleteNode(source, { nodeId: "missing", mode: "node" }),
    ERROR_CODES.NOT_FOUND
  );
}

{
  const source = sampleTree();
  assert.deepStrictEqual(
    tree.normalizeRecentTemplateIds(
      ["template-b1", "folder-b", "missing", "template-b1", "template-root"],
      source
    ),
    ["template-b1", "template-root"]
  );
  assert.deepStrictEqual(
    tree.normalizeTreeUiState(
      { collapsedFolderIds: ["folder-b", "missing", "folder-b", "template-root", "folder-a"] },
      source
    ),
    { collapsedFolderIds: ["folder-b", "folder-a"] }
  );
  assert.deepStrictEqual(
    tree.normalizeTreeUiState({ collapsedFolderIds: ["folder-a"] }, [template("template-root", null)]),
    { collapsedFolderIds: [] }
  );

  const projection = tree.visibleProjection(source, ["folder-b"]);
  assert.deepStrictEqual(projection.map((entry) => [entry.node.id, entry.depth]), [
    ["folder-a", 0],
    ["template-a1", 1],
    ["folder-b", 1],
    ["template-root", 0],
  ]);
  assert.strictEqual(projection[2].collapsed, true);
  assert.strictEqual(projection[2].hasChildren, true);

  assert.deepStrictEqual(
    tree.breadcrumbs(source, "template-b1").map((node) => node.name),
    ["A", "B"]
  );
  assert.deepStrictEqual(
    tree.breadcrumbs(source, "folder-b", { includeNode: true }).map((node) => node.name),
    ["A", "B"]
  );

  const parentOptions = tree.parentPickerOptions(source, "folder-a");
  assert.deepStrictEqual(parentOptions.map((option) => option.id), [null]);
  const templateOptions = tree.parentPickerOptions(source, "template-root");
  assert.deepStrictEqual(templateOptions.map((option) => option.id), [
    null,
    "folder-a",
    "folder-b",
  ]);
  assert.deepStrictEqual(templateOptions[2].breadcrumbs, ["A", "B"]);
}

{
  const depthTree = [];
  let parentId = null;
  for (let depth = 1; depth <= 6; depth += 1) {
    const id = `depth-${depth}`;
    depthTree.push(folder(id, parentId));
    parentId = id;
  }
  depthTree.push(folder("moving-root", null));
  depthTree.push(folder("moving-child", "moving-root"));
  const options = tree.parentPickerOptions(depthTree, "moving-root");
  assert.strictEqual(options.some((option) => option.id === "depth-5"), false);
  assert.strictEqual(options.some((option) => option.id === "depth-4"), true);
}

{
  const frozen = deepFreeze(sampleTree());
  const canonical = tree.canonicalizeNodes(frozen);
  const updated = tree.updateNode(frozen, {
    nodeId: "template-a1",
    patch: { name: "Immutable update" },
  });
  const moved = tree.moveNode(frozen, {
    nodeId: "template-root",
    targetParentId: "folder-a",
    beforeNodeId: "template-a1",
  });
  const deleted = tree.deleteNode(frozen, {
    nodeId: "template-a1",
    mode: "node",
  });
  [canonical, updated, moved, deleted].forEach((result) => {
    assert.strictEqual(result.ok, true);
    assert.notStrictEqual(result.nodes, frozen);
  });
  assert.strictEqual(tree.findNode(frozen, "template-a1").name, "A1");
}

console.log("template tree logic ok");
