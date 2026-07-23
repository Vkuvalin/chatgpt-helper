"use strict";

const assert = require("node:assert/strict");
const { webcrypto } = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const workspace = require("../src/workspace-contract.js");
const conversations = require("../src/conversation-context.js");
const commands = require("../src/command-registry.js");
const workspaceStore = require("../src/workspace-store.js");
const workspaceUi = require("../src/workspace-ui.js");
const importExport = require("../src/import-export.js");
const asyncBoundaryTests = [];

function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

assert.equal(workspace.DB_NAME, "chatgpt-helper-workspace");
assert.equal(workspace.DB_VERSION, 1);
assert.equal(workspace.WORKSPACE_SCHEMA_VERSION, 2);
assert.deepEqual(Object.keys(workspace.STORE_DEFINITIONS), [
  "meta",
  "conversations",
  "glossaryConcepts",
  "glossarySenses",
  "glossaryLinks",
  "savedItems",
  "savedItemLinks",
  "importBackups",
]);
assert.equal(workspace.STORE_DEFINITIONS.conversations.indexes.find((item) => item.name === "scopeKey").unique, true);
assert.deepEqual(
  workspace.STORE_DEFINITIONS.glossaryLinks.indexes.find((item) => item.name === "conversationIdLocalOrder").keyPath,
  ["conversationId", "localOrder"],
);

assert.deepEqual(workspace.canonicalizeTerm("WorkflowOrchestrator"), {
  displayTerm: "WorkflowOrchestrator",
  canonicalTerm: "Workflow Orchestrator",
  normalizedKey: "workflow orchestrator",
});
assert.equal(workspace.canonicalizeTerm("XMLHttpRequest").normalizedKey, "xml http request");
assert.equal(workspace.canonicalizeTerm("PascalCase").normalizedKey, "pascal case");
for (const technicalTerm of ["C++", "C#", ".NET", "GPT-4.1", "API/SDK", "client-side"]) {
  assert.equal(workspace.canonicalizeTerm(technicalTerm).canonicalTerm, technicalTerm);
}
assert.equal(workspace.canonicalizeTerm(" **‘Workflow–Runner’** ").normalizedKey, "workflow-runner");

assert.equal(
  workspace.normalizeSavedTextKey("  First  \r\n\r\nSecond\t \rThird  "),
  "First\n\nSecond\nThird",
);
assert.equal(workspace.normalizeSavedTextKey("First\n\nSecond"), "First\n\nSecond");
assert.equal(workspace.validateSavedText("  ").ok, false);
assert.equal(workspace.validateSavedText("A\n\nB").ok, true);
assert.equal(workspace.normalizeSelectedPlainText("One\r\n\r\n  Two\rThree"), "One\n\n  Two\nThree");
assert.equal(workspace.validateSavedText("One\r\n\r\n  Two").text, "One\n\n  Two");
assert.equal(workspace.MAX_WALLPAPER_SOURCE_BYTES, 6 * 1024 * 1024);
assert.deepEqual(workspace.validateWallpaperSourceFile({ type: "image/png", size: 6 * 1024 * 1024 }), { ok: true });
assert.deepEqual(workspace.validateWallpaperSourceFile({ type: "image/png", size: (6 * 1024 * 1024) + 1 }), {
  ok: false,
  error: "WALLPAPER_FILE_TOO_LARGE",
  message: "Изображение превышает лимит 6 МБ.",
});
assert.deepEqual(workspace.validateWallpaperSourceFile({ type: "text/plain", size: 10 }), {
  ok: false,
  error: "WALLPAPER_INVALID_TYPE",
  message: "Выберите файл изображения.",
});

assert.deepEqual(conversations.extractStableConversation("https://chatgpt.com/g/g-test/c/abc_123?x=1"), {
  kind: "stable",
  host: "chatgpt.com",
  remoteConversationId: "abc_123",
  scopeKey: "stable:chatgpt.com:abc_123",
  canonicalUrl: "https://chatgpt.com/c/abc_123",
});
assert.equal(conversations.extractStableConversation("https://chat.openai.com/c/old-chat").scopeKey, "stable:chat.openai.com:old-chat");
assert.equal(conversations.extractStableConversation("https://chatgpt.com/") , null);
assert.equal(conversations.extractStableConversation("https://example.com/c/abc"), null);
assert.equal(conversations.extractStableConversation("not a URL"), null);
assert.equal(conversations.contextChanged({ scopeKey: "stable:chatgpt.com:a" }, { scopeKey: "stable:chatgpt.com:b" }), true);

assert.deepEqual(Object.keys(commands.COMMAND_BY_ID), ["analyze-selection", "save-selection", "normalize-composer"]);
assert.equal(commands.COMMANDS.analyzeSelection.messageType, "RUN_ANALYSIS_COMMAND");
assert.equal(commands.COMMANDS.saveSelection.messageType, "RUN_SAVE_SELECTION_COMMAND");
assert.equal(commands.COMMANDS.normalizeComposer.messageType, "RUN_NORMALIZE_COMPOSER_COMMAND");
assert.equal(commands.selectionEligible({ supportedPage: true, isEditable: false, selectionText: "save me" }), true);
assert.equal(commands.selectionEligible({ supportedPage: true, isEditable: true, selectionText: "save me" }), false);
assert.equal(commands.composerEligible({ supportedPage: true, isComposer: true }), true);
assert.equal(commands.composerEligible({ supportedPage: true, isComposer: false }), false);

assert.deepEqual(workspace.normalizeComposerText("A\nB"), { text: "A\nB", changed: false, edits: [] });
assert.equal(workspace.normalizeComposerText("A\n\nB").text, "A\n\nB");
assert.equal(workspace.normalizeComposerText("A\n\n\nB").text, "A\n\nB");
assert.equal(workspace.normalizeComposerText(workspace.normalizeComposerText("A\n\n\nB").text).text, "A\n\nB");
assert.equal(workspace.normalizeComposerText("A\r\n \n\t\rB").text, "A\r\n\r\nB");
assert.equal(workspace.normalizeComposerText("A\n \n\tB").text, "A\n\n\tB");
const mappedNormalization = workspace.normalizeComposerText("A\n \n\tB");
assert.equal(workspace.mapOffsetThroughEdits(6, mappedNormalization.edits), 5);
for (const source of ["A\nB", "A\n\nB", "A\n\n\nB", "A\r\n \n\t\rB", "\n \n\nB"]) {
  const once = workspace.normalizeComposerPlainText(source).text;
  assert.equal(workspace.normalizeComposerPlainText(once).text, once, `composer normalization is idempotent for ${JSON.stringify(source)}`);
}
const largeNormalizerInput = "\n \n\nB".repeat(40000);
assert.equal(largeNormalizerInput.length, 200000);
const normalizerStartedAt = Date.now();
assert.equal(workspace.normalizeComposerText(largeNormalizerInput).text.length > 0, true);
assert.equal(Date.now() - normalizerStartedAt < 2000, true, "200k composer normalization remains linear-time in the sanity fixture");

assert.deepEqual(workspace.normalizeActiveSettings({
  theme: "gold",
  closePanelAfterRun: false,
  recentTemplatesHoverEnabled: false,
  recentTemplatesHoverCount: 7.6,
  analysis: { termColorMode: "custom", customTermColor: "#ABCDEF", glossaryTextSize: "large", shortcut: { code: "KeyX" } },
  layout: { sidebarWidth: 999, analysisDialogWidth: 100 },
  commands: { injected: true },
  keyStatus: "configured",
}), {
  theme: "gold",
  wallpaperDataUrl: null,
  closePanelAfterRun: false,
  closePanelOnOutsideClick: true,
  recentTemplatesHoverEnabled: false,
  recentTemplatesHoverCount: 8,
  analysis: { termColorMode: "custom", customTermColor: "#abcdef", glossaryTextSize: "large" },
  layout: { sidebarWidth: 720, analysisDialogWidth: 360 },
});
assert.deepEqual(workspace.validateActiveSettingsPatch({
  wallpaperDataUrl: null,
  closePanelOnOutsideClick: false,
  analysis: { customTermColor: "#ABCDEF" },
  layout: { sidebarWidth: 999 },
  recentTemplatesHoverCount: 8,
}), {
  ok: true,
  patch: {
    wallpaperDataUrl: null,
    closePanelOnOutsideClick: false,
    recentTemplatesHoverCount: 8,
    analysis: { customTermColor: "#abcdef" },
    layout: { sidebarWidth: 720 },
  },
});
assert.deepEqual(workspace.RECENT_TEMPLATES_HOVER_COUNT, { default: 3, min: 1, max: 8 });
assert.deepEqual(
  [undefined, "6", null, NaN, Infinity, -4, 1.49, 7.6, 99]
    .map((value) => workspace.normalizeRecentTemplatesHoverCount(value)),
  [3, 3, 3, 3, 3, 1, 1, 8, 8],
);
assert.deepEqual(workspace.normalizeRecentTemplateIds([
  "one", " two ", "one", "", null, "three", "four", "five", "six", "seven", "eight",
]), ["one", "two", "three", "four", "five", "six", "seven", "eight"]);
for (const invalidPatch of [
  {},
  { unknown: true },
  { wallpaperDataUrl: undefined },
  { analysis: {} },
  { analysis: { shortcut: "KeyX" } },
  { layout: { sidebarWidth: "420" } },
  { recentTemplatesHoverCount: "3" },
  { recentTemplatesHoverCount: null },
  { recentTemplatesHoverCount: 1.5 },
  { recentTemplatesHoverCount: 0 },
  { recentTemplatesHoverCount: 9 },
]) assert.equal(workspace.validateActiveSettingsPatch(invalidPatch).ok, false);
for (const recentTemplatesHoverCount of [1, 3, 8]) {
  assert.deepEqual(workspace.validateActiveSettingsPatch({ recentTemplatesHoverCount }), {
    ok: true,
    patch: { recentTemplatesHoverCount },
  });
}
const patchedSettings = workspace.applyActiveSettingsPatch({
  ...workspace.DEFAULT_ACTIVE_SETTINGS,
  theme: "navy",
  layout: { sidebarWidth: 410, analysisDialogWidth: 610 },
}, { theme: "gold", layout: { sidebarWidth: 420 } });
assert.equal(patchedSettings.ok, true);
assert.equal(patchedSettings.settings.theme, "gold");
assert.deepEqual(patchedSettings.settings.layout, { sidebarWidth: 420, analysisDialogWidth: 610 });
assert.deepEqual(workspace.createActiveSettingsPatch(
  { ...workspace.DEFAULT_ACTIVE_SETTINGS, theme: "navy" },
  {
    ...workspace.DEFAULT_ACTIVE_SETTINGS,
    theme: "navy",
    wallpaperDataUrl: null,
    recentTemplatesHoverCount: 6,
    layout: { sidebarWidth: 420, analysisDialogWidth: 560 },
  },
), { recentTemplatesHoverCount: 6, layout: { sidebarWidth: 420 } });
assert.deepEqual(workspace.validateTemplatePatch({ name: "New", content: "A\n\n\nB" }), {
  ok: true,
  patch: { name: "New", content: "A\n\n\nB" },
});
assert.deepEqual(workspace.validateTemplatePatch({ autoSend: true }), { ok: true, patch: { autoSend: true } });
const originalTemplateLeaves = { name: "Old name", content: "Old content", autoSend: false };
assert.deepEqual(workspace.createTemplatePatch(originalTemplateLeaves, {
  name: "New name", content: "Old content", autoSend: false,
}), { name: "New name" });
assert.deepEqual(workspace.createTemplatePatch(originalTemplateLeaves, {
  name: "Old name", content: "New content", autoSend: false,
}), { content: "New content" });
assert.deepEqual(workspace.createTemplatePatch(originalTemplateLeaves, {
  name: "New name", content: "New content", autoSend: false,
}), { name: "New name", content: "New content" });
assert.deepEqual(workspace.createTemplatePatch(originalTemplateLeaves, originalTemplateLeaves), {});
assert.deepEqual(workspace.interpretTemplateExecutionResult({
  ok: true,
  inserted: true,
  unchanged: false,
  failed: false,
  verified: true,
  verificationFailed: false,
  sendAttempted: false,
  sent: false,
  sendFailed: false,
}), {
  accepted: true,
  noop: false,
  insertionSucceeded: true,
  insertionFailed: false,
  verificationFailed: false,
  sendFailed: false,
}, "ordinary verified template insertion remains successful without a required send");
assert.deepEqual(workspace.interpretTemplateExecutionResult({
  ok: true,
  inserted: true,
  failed: false,
  verified: true,
  verificationFailed: false,
  sendAttempted: true,
  sent: true,
  sendFailed: false,
}, { requireSent: true }), {
  accepted: true,
  noop: false,
  insertionSucceeded: true,
  insertionFailed: false,
  verificationFailed: false,
  sendFailed: false,
}, "verified insertion plus successful send is accepted");
assert.deepEqual(workspace.interpretTemplateExecutionResult({
  ok: true, inserted: true, failed: false, verified: false, verificationFailed: true,
  sendAttempted: false, sent: false, sendFailed: false,
}, { requireSent: true }), {
  accepted: false,
  noop: false,
  insertionSucceeded: true,
  insertionFailed: false,
  verificationFailed: true,
  sendFailed: false,
}, "an overloaded ok cannot hide verification failure");
assert.deepEqual(workspace.interpretTemplateExecutionResult({
  ok: false, inserted: false, unchanged: false, failed: true, verified: false,
  verificationFailed: false, sendAttempted: false, sent: false, sendFailed: false,
}, { requireSent: true }), {
  accepted: false,
  noop: false,
  insertionSucceeded: false,
  insertionFailed: true,
  verificationFailed: false,
  sendFailed: false,
}, "actual insertion failure stays distinguishable");
assert.deepEqual(workspace.interpretTemplateExecutionResult({
  ok: true, inserted: true, failed: false, verified: true, verificationFailed: false,
  sendAttempted: true, sent: false, sendFailed: true,
}, { requireSent: true }), {
  accepted: false,
  noop: false,
  insertionSucceeded: true,
  insertionFailed: false,
  verificationFailed: false,
  sendFailed: true,
}, "send failure stays distinguishable");
assert.equal(workspace.interpretTemplateExecutionResult({
  ok: true, inserted: true, failed: false, verified: true, verificationFailed: false,
  sendAttempted: false, sent: false, sendFailed: false,
}, { requireSent: true }).sendFailed, true, "every required but unsent non-noop result is rejected");
assert.equal(workspace.interpretTemplateExecutionResult({ ok: true }, { requireSent: true }).insertionFailed, true,
  "a legacy ok-only result cannot be silently accepted");
assert.deepEqual(workspace.interpretTemplateExecutionResult({ ok: true, noop: true }, { requireSent: true }), {
  accepted: true,
  noop: true,
  insertionSucceeded: false,
  insertionFailed: false,
  verificationFailed: false,
  sendFailed: false,
}, "non-empty composer noop remains accepted");
for (const invalidTemplatePatch of [
  {},
  { unknown: true },
  { name: "" },
  { content: "   " },
  { autoSend: "true" },
]) assert.equal(workspace.validateTemplatePatch(invalidTemplatePatch).ok, false);
assert.equal(workspace.effectiveWidth("sidebarWidth", 720, 500), 400);
assert.equal(workspace.clampPreferredWidth("sidebarWidth", 720), 720);
assert.equal(workspace.resizePreferredWidth("sidebarWidth", 360, -40, "left"), 400);
assert.equal(workspaceUi.nextSidebarPhase("closed", "open"), "opening");
assert.equal(workspaceUi.nextSidebarPhase("opening", "open"), "opening");
assert.equal(workspaceUi.nextSidebarPhase("opening", "close"), "opening");
assert.equal(workspaceUi.nextSidebarPhase("opening", "complete"), "open");
assert.equal(workspaceUi.nextSidebarPhase("open", "close"), "closing");
assert.equal(workspaceUi.nextSidebarPhase("closing", "open"), "closing");
assert.equal(workspaceUi.nextSidebarPhase("closing", "complete"), "revealing-opener");
assert.equal(workspaceUi.nextSidebarPhase("revealing-opener", "close"), "revealing-opener");
assert.equal(workspaceUi.nextSidebarPhase("revealing-opener", "complete"), "closed");
assert.deepEqual(workspaceUi.quickActionStateForPhase("closing"), {
  rendered: true,
  visible: false,
  interactive: false,
});
assert.deepEqual(workspaceUi.quickActionStateForPhase("revealing-opener"), {
  rendered: true,
  visible: true,
  interactive: false,
});
assert.deepEqual(workspaceUi.quickActionStateForPhase("closed"), {
  rendered: true,
  visible: true,
  interactive: true,
});
for (const phase of ["opening", "open"]) {
  assert.deepEqual(workspaceUi.quickActionStateForPhase(phase), {
    rendered: false,
    visible: false,
    interactive: false,
  });
}

function createFakeTransitionElement() {
  const listeners = new Set();
  return {
    listeners,
    addEventListener(type, listener) { if (type === "transitionend") listeners.add(listener); },
    removeEventListener(type, listener) { if (type === "transitionend") listeners.delete(listener); },
    dispatch(propertyName, target) {
      [...listeners].forEach((listener) => listener({ propertyName, target: target || this }));
    },
  };
}

let transitionTimerId = 0;
const transitionTimers = new Map();
const transitionElement = createFakeTransitionElement();
const transitionCompletions = [];
const transitionController = workspaceUi.createTransformTransitionController({
  duration: 200,
  fallbackPadding: 50,
  setTimeout(callback, delay) {
    transitionTimerId += 1;
    transitionTimers.set(transitionTimerId, { callback, delay });
    return transitionTimerId;
  },
  clearTimeout(id) { transitionTimers.delete(id); },
  prefersReducedMotion: () => false,
});
transitionController.run(transitionElement, () => transitionCompletions.push("transition"));
assert.equal([...transitionTimers.values()][0].delay, 250);
transitionElement.dispatch("opacity");
transitionElement.dispatch("transform", {});
assert.deepEqual(transitionCompletions, []);
transitionElement.dispatch("transform");
assert.deepEqual(transitionCompletions, ["transition"]);
assert.equal(transitionTimers.size, 0);

transitionController.run(transitionElement, () => transitionCompletions.push("fallback"));
const fallbackTimer = [...transitionTimers.values()][0];
fallbackTimer.callback();
assert.deepEqual(transitionCompletions, ["transition", "fallback"]);
assert.equal(transitionElement.listeners.size, 0);

transitionController.run(transitionElement, () => transitionCompletions.push("stale"));
const staleListener = [...transitionElement.listeners][0];
transitionController.run(transitionElement, () => transitionCompletions.push("current"));
staleListener({ propertyName: "transform", target: transitionElement });
assert.equal(transitionCompletions.includes("stale"), false);
transitionElement.dispatch("transform");
assert.equal(transitionCompletions.at(-1), "current");

let reducedMotionTimerCalls = 0;
const reducedMotionController = workspaceUi.createTransformTransitionController({
  setTimeout() { reducedMotionTimerCalls += 1; return 1; },
  clearTimeout() {},
  prefersReducedMotion: () => true,
});
let reducedMotionCompleted = false;
reducedMotionController.run(createFakeTransitionElement(), () => { reducedMotionCompleted = true; });
assert.equal(reducedMotionCompleted, true);
assert.equal(reducedMotionTimerCalls, 0);
let reducedClosePhase = "closing";
reducedMotionController.run(createFakeTransitionElement(), () => {
  reducedClosePhase = workspaceUi.nextSidebarPhase(reducedClosePhase, "complete");
  reducedMotionController.run(createFakeTransitionElement(), () => {
    reducedClosePhase = workspaceUi.nextSidebarPhase(reducedClosePhase, "complete");
  });
});
assert.equal(reducedClosePhase, "closed");

const recentHistoryFixture = ["missing", ...Array.from({ length: 8 }, (_, index) => `recent-${index + 1}`)];
const recentTemplatesFixture = Array.from({ length: 8 }, (_, index) => ({
  id: `recent-${index + 1}`,
  name: `Recent ${index + 1}`,
  content: `Content ${index + 1}`,
  autoSend: false,
}));
assert.deepEqual(
  workspaceUi.recentTemplatesForDisplay(recentHistoryFixture, recentTemplatesFixture, 3).map((item) => item.id),
  ["recent-1", "recent-2", "recent-3"],
);
assert.deepEqual(
  workspaceUi.recentTemplatesForDisplay(recentHistoryFixture, recentTemplatesFixture, 6).map((item) => item.id),
  ["recent-1", "recent-2", "recent-3", "recent-4", "recent-5", "recent-6"],
);
assert.equal(recentHistoryFixture.length, 9);
assert.deepEqual(
  workspaceUi.previewPosition(
    { left: 700, top: 500, bottom: 540 },
    { width: 380, height: 300 },
    { width: 1000, height: 700, gap: 10, padding: 12 },
  ),
  { left: 310, top: 240 },
);
assert.deepEqual(
  workspaceUi.previewPosition(
    { left: 20, top: 5, bottom: 35 },
    { width: 380, height: 420 },
    { width: 360, height: 500, gap: 10, padding: 12 },
  ),
  { left: 12, top: 12 },
);

function createPreviewTarget(parent, previewAnchor) {
  return {
    parent,
    previewAnchor: previewAnchor === true,
    closest(selector) {
      assert.equal(selector, "[data-preview-anchor]");
      let current = this;
      while (current) {
        if (current.previewAnchor) return current;
        current = current.parent;
      }
      return null;
    },
  };
}

const templateSummarySafeZone = createPreviewTarget(null, false);
const templatePreviewHotspot = createPreviewTarget(templateSummarySafeZone, true);
const templateDragHandle = createPreviewTarget(templatePreviewHotspot, false);
const templateName = createPreviewTarget(templatePreviewHotspot, false);
const templateControlsSafeZone = createPreviewTarget(templateSummarySafeZone, false);
const templateRun = createPreviewTarget(templateControlsSafeZone, false);
const templateEdit = createPreviewTarget(templateControlsSafeZone, false);
const templateAutoSend = createPreviewTarget(templateControlsSafeZone, false);
const templateDelete = createPreviewTarget(templateControlsSafeZone, false);
const recentTemplateButton = createPreviewTarget(null, true);

assert.equal(workspaceUi.previewAnchorFromTarget(templatePreviewHotspot), templatePreviewHotspot);
assert.equal(workspaceUi.previewAnchorFromTarget(templateName), templatePreviewHotspot);
assert.equal(workspaceUi.previewAnchorFromTarget(templateDragHandle), templatePreviewHotspot,
  "keyboard focus on the hotspot's drag handle keeps immediate preview available");
assert.equal(workspaceUi.previewAnchorFromTarget(recentTemplateButton), recentTemplateButton,
  "recent-template buttons remain preview anchors");
for (const [name, target] of [
  ["Run", templateRun],
  ["Edit", templateEdit],
  ["autoSend", templateAutoSend],
  ["Delete", templateDelete],
  ["controls-side whitespace", templateControlsSafeZone],
  ["summary padding", templateSummarySafeZone],
]) {
  assert.equal(workspaceUi.previewAnchorFromTarget(target), null, `${name} stays outside the preview hotspot`);
}
let previewOpenTimersArmed = 0;
function simulatePreviewPointerOver(target) {
  if (workspaceUi.previewAnchorFromTarget(target)) previewOpenTimersArmed += 1;
}
[
  templateRun,
  templateControlsSafeZone,
  templateEdit,
  templateControlsSafeZone,
  templateAutoSend,
  templateControlsSafeZone,
  templateDelete,
  templateSummarySafeZone,
].forEach(simulatePreviewPointerOver);
assert.equal(previewOpenTimersArmed, 0,
  "moving between controls and adjacent safe-zone space cannot arm preview");
simulatePreviewPointerOver(templateName);
assert.equal(previewOpenTimersArmed, 1, "the content hotspot can arm preview");

assert.equal(workspaceUi.activeSearchMode("global", ""), "local");
assert.equal(workspaceUi.activeSearchMode("global", "   "), "local");
assert.equal(workspaceUi.activeSearchMode("global", "query"), "global");
assert.equal(workspaceUi.activeSearchMode("local", "query"), "local");
assert.equal(workspaceUi.requestedModeAfterQueryInput("global", "   "), "global");
assert.equal(workspaceUi.requestedModeAfterQueryInput("global", "q"), "global");
assert.equal(workspaceUi.requestedModeAfterQueryInput("global", ""), "local");

const nativeSearchMarkup = workspaceUi.savedMarkup({
  savedEntries: [],
  savedSearch: "query",
  savedRequestedMode: "global",
  workspaceStatus: { status: "ready" },
});
assert.match(nativeSearchMarkup, /<input class="workspace-search" type="search"/);
assert.doesNotMatch(nativeSearchMarkup, /workspace-search-clear|clear-saved-search/);
assert.doesNotMatch(workspaceUi.styles(), /workspace-search-clear/);

for (const kind of ["glossary", "saved"]) {
  let requestedMode = "local";
  requestedMode = "global";
  assert.equal(workspaceUi.activeSearchMode(requestedMode, ""), "local", `${kind} keeps local data while armed`);
  requestedMode = workspaceUi.requestedModeAfterQueryInput(requestedMode, "q");
  assert.equal(workspaceUi.activeSearchMode(requestedMode, "q"), "global", `${kind} activates on the first character`);
  requestedMode = workspaceUi.requestedModeAfterQueryInput(requestedMode, "");
  assert.equal(requestedMode, "local", `${kind} clearing search resets the requested mode`);
}

const workspaceQueryMessages = [];
const workspaceClient = workspaceUi.createClient({
  getContext: () => ({ scopeKey: "stable:chatgpt.com:armed-global" }),
  getStatus: () => ({ status: "ready" }),
  async send(message) {
    workspaceQueryMessages.push(clone(message));
    return { ok: true, entries: [] };
  },
});
void workspaceClient.queryGlossary(workspaceUi.activeSearchMode("global", "q"), "q");
void workspaceClient.querySaved(workspaceUi.activeSearchMode("global", "q"), "q");
void workspaceClient.queryGlossary(workspaceUi.activeSearchMode("global", "   "), "   ");
void workspaceClient.querySaved(workspaceUi.activeSearchMode("global", "   "), "   ");
const structuredSavedText = "Paragraph\n\n1. Numbered\n• Bullet\n  indented";
void workspaceClient.saveSelection(structuredSavedText);
assert.equal(workspaceQueryMessages[0].mode, "global");
assert.equal(workspaceQueryMessages[1].mode, "global");
assert.equal(workspaceQueryMessages[2].mode, "local");
assert.equal(workspaceQueryMessages[3].mode, "local");
assert.equal(workspaceQueryMessages[4].text, structuredSavedText);
const contentScriptSource = fs.readFileSync(path.join(__dirname, "../src/content-script.js"), "utf8");
assert.match(contentScriptSource, /await navigator\.clipboard\.writeText\(entry\.text\);/);
assert.doesNotMatch(contentScriptSource, /navigator\.clipboard\.writeText\([^)]*(?:innerText|textContent)/);
assert.match(contentScriptSource, /TEMPLATE_PREVIEW_OPEN_DELAY_MS = 350/);
assert.match(contentScriptSource, /TEMPLATE_PREVIEW_CLOSE_DELAY_MS = 120/);
assert.equal((contentScriptSource.match(/<aside class="template-preview"/g) || []).length, 1);
assert.match(contentScriptSource, /data-preview-source="main"/);
assert.match(contentScriptSource, /data-preview-source="recent"/);
assert.match(contentScriptSource, /class="template-preview-hotspot" data-preview-anchor data-preview-id=/);
assert.doesNotMatch(contentScriptSource, /class="template-summary" data-preview-/);
assert.match(contentScriptSource, /state\.previewContent\.textContent = template\.content/);
assert.doesNotMatch(contentScriptSource, /state\.previewContent\.innerHTML/);
assert.match(contentScriptSource, /white-space: pre-wrap/);
assert.match(contentScriptSource, /overflow-wrap: anywhere/);
assert.match(contentScriptSource, /patch: \{ layout: \{ sidebarWidth: width \} \}/);
assert.match(contentScriptSource, /state\.sidebarPreferredWidth = width/);
assert.match(contentScriptSource, /phase-revealing-opener \.panel-opener/);
assert.match(contentScriptSource, /\.phase-revealing-opener \.quick-action, \.phase-closed \.quick-action \{ opacity: 1; transform: scale\(1\); \}/);
assert.match(contentScriptSource, /\.phase-closed \.quick-action \{ pointer-events: auto; \}/);
assert.match(contentScriptSource, /\.motion-disabled \.quick-action \{ transition: none !important; \}/);
assert.match(contentScriptSource, /state\.quickAction\.tabIndex = quickActionState\.interactive \? 0 : -1/);
assert.match(contentScriptSource, /state\.quickAction\.setAttribute\("aria-hidden", quickActionState\.interactive \? "false" : "true"\)/);
assert.match(contentScriptSource, /state\.body\.addEventListener\("scroll", closeTemplatePreview/);
assert.match(contentScriptSource, /recent-templates-count/);
assert.match(contentScriptSource, /state\.settings\.recentTemplatesHoverEnabled\s*\?\s*'  <label class="setting-option recent-count-option"/);
assert.match(contentScriptSource, /--sidebar-motion-duration: 200ms/);
assert.match(contentScriptSource, /--sidebar-motion-easing: cubic-bezier\(\.22, \.8, \.25, 1\)/);
assert.match(contentScriptSource, /\.panel-opener \{[\s\S]*transition: transform var\(--sidebar-motion-duration\) var\(--sidebar-motion-easing\), background 120ms ease;/);
assert.match(contentScriptSource, /\.quick-action \{[\s\S]*transition: opacity var\(--sidebar-motion-duration\) var\(--sidebar-motion-easing\), transform var\(--sidebar-motion-duration\) var\(--sidebar-motion-easing\), background 120ms ease;/);
assert.match(contentScriptSource, /\.sidebar-frame \{[\s\S]*transform: translateX\(100%\);[\s\S]*transition: transform/);
assert.match(contentScriptSource, /\.shell\.phase-opening \.sidebar-frame, \.shell\.phase-open \.sidebar-frame \{ transform: translateX\(0\); \}/);
assert.match(contentScriptSource, /if \(!\["closed", "open"\]\.includes\(state\.shellPhase\)\) return;/);
assert.match(contentScriptSource, /state\.shellPhase !== "open" \|\| state\.sidebarResizing/);
const shellMarkupSource = contentScriptSource.slice(
  contentScriptSource.indexOf("function shellMarkup"),
  contentScriptSource.indexOf("function applyShellState"),
);
assert.match(shellMarkupSource, /class="shell theme-system phase-closed motion-disabled"/);
assert.equal((shellMarkupSource.match(/class="sidebar-frame"/g) || []).length, 1);
assert.equal(shellMarkupSource.indexOf("panel-resize") < shellMarkupSource.indexOf("<nav class=\"rail\""), true);
assert.equal(shellMarkupSource.indexOf("<nav class=\"rail\"") < shellMarkupSource.indexOf("<section class=\"panel\""), true);
const widthCommitSource = contentScriptSource.slice(
  contentScriptSource.indexOf("async function persistSidebarWidth"),
  contentScriptSource.indexOf("function installSidebarResizer"),
);
assert.equal((widthCommitSource.match(/SETTINGS_UPDATE/g) || []).length, 1);
assert.match(widthCommitSource, /patch: \{ layout: \{ sidebarWidth: width \} \}/);
const editorActionSource = contentScriptSource.slice(
  contentScriptSource.indexOf('else if (action === "add-template")'),
  contentScriptSource.indexOf('else if (action === "remove-wallpaper")'),
);
assert.doesNotMatch(editorActionSource, /SETTINGS_UPDATE|layout:/);
const previewLifecycleSource = contentScriptSource.slice(
  contentScriptSource.indexOf("function clearPreviewOpenTimer"),
  contentScriptSource.indexOf("function statusMarkup"),
);
assert.match(previewLifecycleSource, /setTimeout\(function openTemplatePreviewAfterDelay/);
assert.match(previewLifecycleSource, /setTimeout\(function closeTemplatePreviewAfterGrace/);
assert.match(previewLifecycleSource, /state\.draggingId !== null/);
assert.match(previewLifecycleSource, /state\.editing\?\.id === templateId/);
assert.match(previewLifecycleSource, /state\.confirmingDeleteId === templateId/);
assert.match(previewLifecycleSource, /workspaceUiModule\.previewAnchorFromTarget\(event\.target\)/);
assert.match(previewLifecycleSource, /state\.previewLayer\?\.contains\(event\.relatedTarget\)/);
assert.match(previewLifecycleSource, /scheduleTemplatePreview\(anchor, anchor\.dataset\.previewId, anchor\.dataset\.previewSource, true\)/);
const escapeLifecycleSource = contentScriptSource.slice(
  contentScriptSource.indexOf('document.addEventListener("keydown", function handleEscape'),
  contentScriptSource.indexOf('document.addEventListener("pointerdown", function handleOutsidePointer'),
);
assert.equal(escapeLifecycleSource.indexOf("closeTemplatePreview()") < escapeLifecycleSource.indexOf("state.editing"), true);
assert.equal(escapeLifecycleSource.indexOf("state.editing") < escapeLifecycleSource.indexOf("closePanel(true)"), true);

const unsafeSavedMarkup = workspaceUi.savedMarkup({
  savedRequestedMode: "local",
  savedSearch: "",
  savedConfirmDeleteId: null,
  savedEntries: [{ id: "unsafe", text: '<img src=x onerror="alert(1)">\nNext line', attached: true }],
});
assert.match(unsafeSavedMarkup, /&lt;img src=x onerror=&quot;alert\(1\)&quot;&gt;\nNext line/);
assert.equal(unsafeSavedMarkup.includes('<img src=x onerror="alert(1)">'), false);
assert.match(workspaceUi.styles(), /\.saved-text \{[^}]*white-space: pre-wrap;/);
const emptyGlobalSavedMarkup = workspaceUi.savedMarkup({
  savedRequestedMode: "global",
  savedSearch: "",
  savedEntries: [{ id: "hidden", text: "must not render" }],
});
assert.equal(emptyGlobalSavedMarkup.includes("must not render"), true);
assert.match(emptyGlobalSavedMarkup, /data-action="unlink-saved"/);
assert.match(emptyGlobalSavedMarkup, /data-action="saved-mode-global" aria-pressed="true"/);
assert.equal(emptyGlobalSavedMarkup.includes("ask-global-saved-delete"), false);
assert.equal(emptyGlobalSavedMarkup.includes("Глобальный поиск ожидает запрос"), false);
const localGlossaryMarkup = workspaceUi.glossaryMarkup({
  glossaryRequestedMode: "local",
  glossarySearch: "",
  glossaryEntries: [{ id: "sense", term: "state", translation: "состояние", definition: "Описание.", attached: true }],
  settings: { analysis: { glossaryTextSize: "normal" } },
  keyConfigured: true,
});
assert.match(localGlossaryMarkup, /draggable="true"/);
assert.match(localGlossaryMarkup, /data-action="unlink-glossary"/);
assert.equal(localGlossaryMarkup.includes("OpenRouter"), false);
assert.equal(localGlossaryMarkup.includes("ask-global-glossary-delete"), false);
const armedGlobalGlossaryMarkup = workspaceUi.glossaryMarkup({
  glossaryRequestedMode: "global",
  glossarySearch: "",
  glossaryEntries: [{ id: "sense", term: "state", translation: "состояние", definition: "Описание.", attached: true }],
  settings: { analysis: { glossaryTextSize: "normal" } },
  keyConfigured: true,
});
assert.match(armedGlobalGlossaryMarkup, /data-action="glossary-mode-global" aria-pressed="true"/);
assert.match(armedGlobalGlossaryMarkup, /draggable="true"/);
assert.match(armedGlobalGlossaryMarkup, /data-action="unlink-glossary"/);
assert.equal(armedGlobalGlossaryMarkup.includes("ask-global-glossary-delete"), false);
const globalGlossaryMarkup = workspaceUi.glossaryMarkup({
  glossaryRequestedMode: "global",
  glossarySearch: "state",
  glossaryEntries: [{ id: "sense", term: "state", translation: "состояние", definition: "Описание.", attached: false }],
  settings: { analysis: { glossaryTextSize: "normal" } },
  keyConfigured: true,
});
assert.equal(globalGlossaryMarkup.includes('draggable="true"'), false);
assert.match(globalGlossaryMarkup, /data-action="attach-glossary"/);
assert.match(globalGlossaryMarkup, /data-action="ask-global-glossary-delete"/);
const confirmedGlobalGlossaryMarkup = workspaceUi.glossaryMarkup({
  glossaryRequestedMode: "global",
  glossarySearch: "state",
  glossaryConfirmDeleteId: "sense",
  glossaryEntries: [{ id: "sense", term: "state", translation: "состояние", definition: "Описание.", attached: false }],
  settings: { analysis: { glossaryTextSize: "normal" } },
  keyConfigured: true,
});
assert.match(confirmedGlobalGlossaryMarkup, /confirm-global-glossary-delete/);
assert.match(confirmedGlobalGlossaryMarkup, /все его связи со всеми чатами/);
const localSavedMarkup = workspaceUi.savedMarkup({
  savedRequestedMode: "local",
  savedSearch: "",
  savedEntries: [{ id: "saved", text: "Text", attached: true }],
});
assert.equal((localSavedMarkup.match(/data-action="copy-saved"/g) || []).length, 1);
assert.match(localSavedMarkup, /class="icon-button workspace-copy-button"/);
assert.match(localSavedMarkup, /title="Скопировать сохранённый текст" aria-label="Скопировать сохранённый текст"/);
assert.match(localSavedMarkup, /class="workspace-card-footer saved-card-footer">.*data-action="copy-saved".*class="workspace-card-actions">.*data-action="unlink-saved"/);
assert.match(localSavedMarkup, /data-action="unlink-saved"/);
assert.equal(localSavedMarkup.includes("ask-global-saved-delete"), false);
const globalSavedMarkup = workspaceUi.savedMarkup({
  savedRequestedMode: "global",
  savedSearch: "text",
  savedConfirmDeleteId: "saved",
  savedEntries: [{ id: "saved", text: "Text", attached: false }],
});
assert.equal((globalSavedMarkup.match(/data-action="copy-saved"/g) || []).length, 1);
assert.match(globalSavedMarkup, /class="workspace-card-footer saved-card-footer">.*data-action="copy-saved".*class="workspace-card-actions">.*data-action="attach-saved".*data-action="ask-global-saved-delete"/);
assert.match(globalSavedMarkup, /data-action="ask-global-saved-delete"/);
assert.match(globalSavedMarkup, /confirm-global-saved-delete/);
assert.match(workspaceUi.styles(), /\.workspace-copy-button\.is-copied/);
const unavailableGlossaryMarkup = workspaceUi.glossaryMarkup({
  workspaceStatus: { status: "unavailable", message: "Данные словаря V1 не удалены. Новые изменения Workspace не применены." },
  glossaryRequestedMode: "local",
  glossarySearch: "",
  glossaryEntries: [],
  settings: { analysis: { glossaryTextSize: "normal" } },
  keyConfigured: true,
});
assert.match(unavailableGlossaryMarkup, /Workspace недоступен/);
assert.match(unavailableGlossaryMarkup, /Данные словаря V1 не удалены/);
assert.equal(unavailableGlossaryMarkup.includes("OpenRouter"), false);
assert.equal(unavailableGlossaryMarkup.includes("В этом чате пока нет терминов"), false);
const missingKeyGlossaryMarkup = workspaceUi.glossaryMarkup({
  glossaryRequestedMode: "local",
  glossarySearch: "",
  glossaryEntries: [],
  settings: { analysis: { glossaryTextSize: "normal" } },
  keyChecking: false,
  keyConfigured: false,
});
assert.match(missingKeyGlossaryMarkup, /OpenRouter не подключён/);
assert.match(missingKeyGlossaryMarkup, /data-action="open-analysis-options"/);
const checkingKeyGlossaryMarkup = workspaceUi.glossaryMarkup({
  glossaryRequestedMode: "local",
  glossarySearch: "",
  glossaryEntries: [],
  settings: { analysis: { glossaryTextSize: "normal" } },
  keyChecking: true,
  keyConfigured: false,
});
assert.equal(checkingKeyGlossaryMarkup.includes("OpenRouter"), false);
const unavailableSavedMarkup = workspaceUi.savedMarkup({
  workspaceStatus: { status: "unavailable", message: "Данные словаря V1 не удалены. Новые изменения Workspace не применены." },
  savedRequestedMode: "local",
  savedSearch: "",
  savedEntries: [],
});
assert.match(unavailableSavedMarkup, /Workspace недоступен/);
assert.equal(unavailableSavedMarkup.includes("В этом чате пока нет сохранённого текста"), false);

{
  let inputEvents = 0;
  let clicks = 0;
  let composerAvailable = true;
  let sendButtonAvailable = true;
  let clearComposerOnSend = true;
  let forcedReadbackText = null;
  class FakeTextarea {
    constructor() {
      this.tagName = "TEXTAREA";
      this.isConnected = true;
      this._value = "A\n \n\t\nB";
      this.selectionStart = this._value.length;
      this.selectionEnd = this._value.length;
    }
    get value() { return this._value; }
    set value(value) { this._value = value; }
    getBoundingClientRect() { return { width: 300, height: 80 }; }
    dispatchEvent(event) {
      if (event.type === "input") {
        inputEvents += 1;
        if (typeof forcedReadbackText === "string") this._value = forcedReadbackText;
      }
      return true;
    }
    setSelectionRange(start, end) { this.selectionStart = start; this.selectionEnd = end; }
    contains(target) { return target === this; }
    closest(selector) { return selector === "form" ? form : null; }
  }
  const textarea = new FakeTextarea();
  const sendButton = {
    isConnected: true,
    disabled: false,
    dataset: { testid: "send-button" },
    textContent: "Send",
    getBoundingClientRect() { return { width: 30, height: 30 }; },
    getAttribute(name) {
      if (name === "aria-label") return "Send message";
      if (name === "aria-disabled") return "false";
      return null;
    },
    click() {
      clicks += 1;
      if (clearComposerOnSend) textarea.value = "";
    },
  };
  const form = { querySelectorAll() { return sendButtonAvailable ? [sendButton] : []; } };
  const windowObject = {
    ChatGPTHelperWorkspaceContract: workspace,
    HTMLTextAreaElement: FakeTextarea,
    getComputedStyle() { return { display: "block", visibility: "visible" }; },
    getSelection() { return null; },
  };
  const documentObject = {
    activeElement: textarea,
    querySelectorAll() { return composerAvailable ? [textarea] : []; },
    createRange() { throw new Error("textarea normalization must not use a DOM range"); },
  };
  class FakeEvent { constructor(type) { this.type = type; } }
  const context = vm.createContext({
    window: windowObject,
    document: documentObject,
    Event: FakeEvent,
    InputEvent: FakeEvent,
    Node: { TEXT_NODE: 3 },
    NodeFilter: { SHOW_TEXT: 4 },
    setTimeout(callback) { callback(); return 0; },
    clearTimeout,
  });
  vm.runInContext(fs.readFileSync(path.join(__dirname, "../src/chatgpt-dom.js"), "utf8"), context);
  const normalized = windowObject.ChatGPTTemplateDom.normalizeComposer({ requireFocus: true });
  assert.deepEqual({ ok: normalized.ok, changed: normalized.changed, text: normalized.text }, {
    ok: true,
    changed: true,
    text: "A\n\nB",
  });
  assert.equal(textarea.value, "A\n\nB");
  assert.equal(inputEvents, 1);
  assert.equal(clicks, 0);
  assert.equal(windowObject.ChatGPTTemplateDom.normalizeComposer({ requireFocus: true }).changed, false);
  assert.equal(inputEvents, 1);
  textarea.value = "A\n\n\nB";
  documentObject.activeElement = {};
  assert.equal(windowObject.ChatGPTTemplateDom.normalizeComposer({ requireFocus: true }).ok, false);
  assert.equal(textarea.value, "A\n\n\nB");
  documentObject.activeElement = textarea;
  asyncBoundaryTests.push((async () => {
    const cases = [
      { existing: "", template: "One line", expected: "One line" },
      { existing: "", template: "First\nSecond", expected: "First\nSecond" },
      { existing: "", template: "  A\n\n\n\tB  ", expected: "  A\n\n\n\tB  " },
      { existing: "Existing", template: "One line", expected: "Existing\n\nOne line" },
      { existing: "Existing\nline", template: "First\nSecond", expected: "Existing\nline\n\nFirst\nSecond" },
    ];
    for (const scenario of cases) {
      for (const autoSend of [false, true]) {
        textarea.value = scenario.existing;
        textarea.selectionStart = scenario.existing.length;
        textarea.selectionEnd = scenario.existing.length;
        clearComposerOnSend = true;
        forcedReadbackText = null;
        const beforeClicks = clicks;
        const result = await windowObject.ChatGPTTemplateDom.executeTemplate(scenario.template, autoSend);
        assert.equal(result.ok, true);
        assert.equal(result.inserted, true);
        assert.equal(result.unchanged, false);
        assert.equal(result.failed, false);
        assert.equal(result.verified, true);
        assert.equal(result.verificationFailed, false);
        assert.equal(result.sendAttempted, autoSend);
        assert.equal(result.sent, autoSend);
        assert.equal(result.sendFailed, false);
        assert.equal(result.text, scenario.expected);
        assert.equal(textarea.value, autoSend ? "" : scenario.expected);
        assert.equal(clicks - beforeClicks, autoSend ? 1 : 0);
      }
    }

    textarea.value = "";
    clearComposerOnSend = false;
    const sendFailed = await windowObject.ChatGPTTemplateDom.executeTemplate("Send failure", true);
    assert.equal(sendFailed.inserted, true);
    assert.equal(sendFailed.failed, false);
    assert.equal(sendFailed.sendAttempted, true);
    assert.equal(sendFailed.sent, false);
    assert.equal(sendFailed.sendFailed, true);
    assert.match(sendFailed.error, /Шаблон вставлен/);
    assert.doesNotMatch(sendFailed.error, /Не удалось вставить/);

    textarea.value = "";
    clearComposerOnSend = true;
    forcedReadbackText = "Framework-adjusted value";
    const clicksBeforeVerification = clicks;
    const unverified = await windowObject.ChatGPTTemplateDom.executeTemplate("Written value", true);
    assert.equal(unverified.ok, true);
    assert.equal(unverified.inserted, true);
    assert.equal(unverified.failed, false);
    assert.equal(unverified.verified, false);
    assert.equal(unverified.verificationFailed, true);
    assert.equal(unverified.sendAttempted, false);
    assert.equal(unverified.sendFailed, false);
    assert.equal(clicks, clicksBeforeVerification);
    assert.doesNotMatch(unverified.error, /Не удалось вставить/);
    forcedReadbackText = null;

    composerAvailable = false;
    const insertionFailed = await windowObject.ChatGPTTemplateDom.executeTemplate("Cannot write", false);
    assert.equal(insertionFailed.ok, false);
    assert.equal(insertionFailed.inserted, false);
    assert.equal(insertionFailed.failed, true);
    assert.equal(insertionFailed.sendAttempted, false);

    const quickInsertionFailed = await windowObject.ChatGPTTemplateDom.executeNextQuickAction();
    assert.equal(quickInsertionFailed.ok, false);
    assert.equal(quickInsertionFailed.inserted, false);
    assert.equal(quickInsertionFailed.failed, true);
    assert.equal(quickInsertionFailed.verificationFailed, false);
    assert.equal(quickInsertionFailed.sendAttempted, false);
    assert.equal(quickInsertionFailed.sendFailed, false);

    composerAvailable = true;
    sendButtonAvailable = true;

    textarea.value = "";
    clearComposerOnSend = true;
    forcedReadbackText = null;
    const clicksBeforeQuickSuccess = clicks;
    const quickSuccess = await windowObject.ChatGPTTemplateDom.executeNextQuickAction();
    assert.equal(quickSuccess.ok, true);
    assert.equal(quickSuccess.inserted, true);
    assert.equal(quickSuccess.failed, false);
    assert.equal(quickSuccess.verified, true);
    assert.equal(quickSuccess.verificationFailed, false);
    assert.equal(quickSuccess.sendAttempted, true);
    assert.equal(quickSuccess.sent, true);
    assert.equal(quickSuccess.sendFailed, false);
    assert.equal(clicks - clicksBeforeQuickSuccess, 1);

    textarea.value = "";
    clearComposerOnSend = true;
    forcedReadbackText = "Framework-adjusted quick value";
    const clicksBeforeQuickVerification = clicks;
    const quickUnverified = await windowObject.ChatGPTTemplateDom.executeNextQuickAction();
    assert.equal(quickUnverified.ok, true);
    assert.equal(quickUnverified.inserted, true);
    assert.equal(quickUnverified.failed, false);
    assert.equal(quickUnverified.verified, false);
    assert.equal(quickUnverified.verificationFailed, true);
    assert.equal(quickUnverified.sendAttempted, false);
    assert.equal(quickUnverified.sent, false);
    assert.equal(quickUnverified.sendFailed, false);
    assert.equal(clicks, clicksBeforeQuickVerification);

    textarea.value = "";
    clearComposerOnSend = false;
    forcedReadbackText = null;
    const quickSendFailed = await windowObject.ChatGPTTemplateDom.executeNextQuickAction();
    assert.equal(quickSendFailed.ok, true);
    assert.equal(quickSendFailed.inserted, true);
    assert.equal(quickSendFailed.failed, false);
    assert.equal(quickSendFailed.verified, true);
    assert.equal(quickSendFailed.sendAttempted, true);
    assert.equal(quickSendFailed.sent, false);
    assert.equal(quickSendFailed.sendFailed, true);
    assert.match(quickSendFailed.error, /Шаблон вставлен/);

    textarea.value = "Existing composer text";
    const clicksBeforeQuickNoop = clicks;
    const quickNoop = await windowObject.ChatGPTTemplateDom.executeNextQuickAction();
    assert.equal(quickNoop.ok, true);
    assert.equal(quickNoop.noop, true);
    assert.equal(textarea.value, "Existing composer text");
    assert.equal(clicks, clicksBeforeQuickNoop);
  })());
}

{
  let inputEvents = 0;
  let activeRange = null;
  class FakeNode {
    constructor(type) {
      this.nodeType = type;
      this.childNodes = [];
      this.parentNode = null;
      this.isConnected = true;
    }
    appendChild(node) {
      node.parentNode = this;
      this.childNodes.push(node);
      return node;
    }
    contains(target) {
      return target === this || this.childNodes.some((child) => child.contains?.(target));
    }
    get textContent() { return this.childNodes.map((child) => child.textContent || "").join(""); }
  }
  class FakeText extends FakeNode {
    constructor(data) { super(3); this.data = data; }
    get textContent() { return this.data; }
  }
  class FakeElement extends FakeNode {
    constructor(tagName) { super(1); this.tagName = tagName.toUpperCase(); this.attributes = {}; }
    get innerText() {
      if (this.tagName === "DIV") return this.childNodes.map((child) => child.textContent || "").join("\n\n");
      return this.textContent;
    }
    getBoundingClientRect() { return { width: 300, height: 80 }; }
    replaceChildren(fragment) {
      this.childNodes = fragment.childNodes.slice();
      this.childNodes.forEach((child) => { child.parentNode = this; });
    }
    dispatchEvent(event) { if (event.type === "input") inputEvents += 1; return true; }
    focus() { documentObject.activeElement = this; }
    closest() { return null; }
    getAttribute(name) { return Object.prototype.hasOwnProperty.call(this.attributes, name) ? this.attributes[name] : null; }
    setAttribute(name, value) { this.attributes[name] = String(value); }
  }
  class FakeRange {
    selectNodeContents() {}
    setEnd(container, offset) { this.endContainer = container; this.endOffset = offset; }
    setStart(container, offset) { this.startContainer = container; this.startOffset = offset; }
    cloneContents() { return this.fragment || new FakeNode(11); }
    toString() { return ""; }
  }
  const editor = new FakeElement("div");
  const selectionObject = {
    get rangeCount() { return activeRange ? 1 : 0; },
    getRangeAt() { return activeRange; },
    removeAllRanges() { activeRange = null; },
    addRange(range) { activeRange = range; },
  };
  const documentObject = {
    activeElement: editor,
    querySelectorAll() { return [editor]; },
    createDocumentFragment() { return new FakeNode(11); },
    createElement(tagName) { return new FakeElement(tagName); },
    createTextNode(text) { return new FakeText(text); },
    createTreeWalker(root) {
      const nodes = [];
      const visit = (node) => {
        if (node.nodeType === 3) nodes.push(node);
        else node.childNodes.forEach(visit);
      };
      visit(root);
      let index = 0;
      return { nextNode() { return nodes[index++] || null; } };
    },
    createRange() { return new FakeRange(); },
  };
  const windowObject = {
    ChatGPTHelperWorkspaceContract: workspace,
    HTMLTextAreaElement: class FakeTextarea {},
    getComputedStyle() { return { display: "block", visibility: "visible" }; },
    getSelection() { return selectionObject; },
  };
  class FakeEvent { constructor(type) { this.type = type; } }
  const context = vm.createContext({
    window: windowObject,
    document: documentObject,
    Event: FakeEvent,
    InputEvent: FakeEvent,
    NodeFilter: { SHOW_TEXT: 4 },
    setTimeout,
    clearTimeout,
  });
  vm.runInContext(fs.readFileSync(path.join(__dirname, "../src/chatgpt-dom.js"), "utf8"), context);

  function setEditorBlocks(blocks) {
    const fragment = new FakeNode(11);
    blocks.forEach(({ tag = "p", text = "" }) => {
      const block = new FakeElement(tag);
      if (text) block.appendChild(new FakeText(text));
      else block.appendChild(new FakeElement("br"));
      fragment.appendChild(block);
    });
    editor.replaceChildren(fragment);
  }

  function setEditorLines(lines) {
    setEditorBlocks(lines.map((text) => ({ tag: "p", text })));
  }

  function setSelection(startContainer, startOffset, endContainer = startContainer, endOffset = startOffset) {
    const range = new FakeRange();
    range.setStart(startContainer, startOffset);
    range.setEnd(endContainer, endOffset);
    activeRange = range;
  }

  function selectionNode(tag, children, attributes) {
    const node = new FakeElement(tag);
    Object.entries(attributes || {}).forEach(([name, value]) => node.setAttribute(name, value));
    (children || []).forEach((child) => node.appendChild(typeof child === "string" ? new FakeText(child) : child));
    return node;
  }

  function readSelectionFragment(nodes, fallback = "") {
    const fragment = new FakeNode(11);
    nodes.forEach((node) => fragment.appendChild(typeof node === "string" ? new FakeText(node) : node));
    const range = new FakeRange();
    range.fragment = fragment;
    activeRange = range;
    return windowObject.ChatGPTTemplateDom.readSelectionText(fallback);
  }

  assert.equal(readSelectionFragment(["One line"]), "One line");
  assert.equal(readSelectionFragment([
    selectionNode("div", ["Adjacent"]),
    selectionNode("div", ["line"]),
  ], "Adjacent line"), "Adjacent\nline");
  assert.equal(readSelectionFragment([selectionNode("div", ["Current selection"])], "Immutable snapshot"), "Immutable snapshot");
  assert.equal(readSelectionFragment([
    selectionNode("p", ["First paragraph"]),
    selectionNode("p", [selectionNode("strong", ["Second"]), " paragraph"]),
  ]), "First paragraph\n\nSecond paragraph");
  assert.equal(readSelectionFragment([
    selectionNode("div", ["Before"]),
    selectionNode("div", [selectionNode("br")]),
    selectionNode("div", ["After"]),
  ]), "Before\n\nAfter");
  assert.equal(readSelectionFragment([
    selectionNode("ol", [
      selectionNode("li", ["Numbered one"]),
      selectionNode("li", ["Numbered two", selectionNode("ul", [
        selectionNode("li", ["Nested bullet"]),
      ])]),
    ], { start: 3 }),
  ]), "3. Numbered one\n4. Numbered two\n  • Nested bullet");
  const sourceOrderedList = selectionNode("ol", [
    selectionNode("li", ["First"]),
    selectionNode("li", ["Second"]),
    selectionNode("li", ["Third"]),
  ], { start: 3 });
  const partialOrderedFragment = new FakeNode(11);
  partialOrderedFragment.appendChild(selectionNode("ol", [selectionNode("li", ["Third"])]));
  const partialOrderedRange = new FakeRange();
  partialOrderedRange.startContainer = sourceOrderedList.childNodes[2].childNodes[0];
  partialOrderedRange.fragment = partialOrderedFragment;
  activeRange = partialOrderedRange;
  assert.equal(windowObject.ChatGPTTemplateDom.readSelectionText("Third"), "5. Third");
  assert.equal(readSelectionFragment([
    selectionNode("pre", ["  indented\n    code"]),
  ]), "  indented\n    code");

  function pointSignature(container, offset) {
    if (container === editor) return `editor:${offset}`;
    let topLevel = container;
    while (topLevel?.parentNode && topLevel.parentNode !== editor) topLevel = topLevel.parentNode;
    const lineIndex = editor.childNodes.indexOf(topLevel);
    if (container.nodeType === 3) return `line:${lineIndex}:text:${offset}`;
    return `line:${lineIndex}:${container.tagName || container.nodeType}:${offset}`;
  }

  const roundTripCases = [
    "A\nB",
    "A\n\nB",
    "\nA",
    "A\n",
    "\nA\n",
    "A\n\n",
  ];
  roundTripCases.forEach((text) => {
    const write = windowObject.ChatGPTTemplateDom.replaceComposerText(text, { start: text.length, end: text.length });
    assert.equal(write.ok, true);
    assert.equal(windowObject.ChatGPTTemplateDom.readComposer().text, text, `contenteditable round-trip for ${JSON.stringify(text)}`);
  });

  setEditorBlocks([{ tag: "p", text: "A" }, { tag: "div", text: "B" }]);
  assert.equal(editor.innerText, "A\n\nB", "the fake models Chromium-style rendered block separation");
  assert.equal(windowObject.ChatGPTTemplateDom.readComposer().text, "A\nB");
  assert.equal(windowObject.ChatGPTTemplateDom.normalizeComposer({ requireFocus: true }).changed, false);
  assert.equal(editor.childNodes.length, 2, "canonical adjacent blocks are not rewritten into a blank line");

  const selectionCases = [
    {
      name: "editor offset zero",
      select() { setSelection(editor, 0); },
      expectedStart: "line:0:text:0",
      expectedEnd: "line:0:text:0",
    },
    {
      name: "intermediate child boundary",
      select() { setSelection(editor, 1); },
      expectedStart: "line:1:P:0",
      expectedEnd: "line:1:P:0",
    },
    {
      name: "blank block",
      select() { setSelection(editor.childNodes[1], 0); },
      expectedStart: "line:1:P:0",
      expectedEnd: "line:1:P:0",
    },
    {
      name: "final boundary",
      select() { setSelection(editor, editor.childNodes.length); },
      expectedStart: "line:2:text:1",
      expectedEnd: "line:2:text:1",
    },
    {
      name: "selection across blocks",
      select() { setSelection(editor, 1, editor, editor.childNodes.length); },
      expectedStart: "line:1:P:0",
      expectedEnd: "line:2:text:1",
    },
  ];
  selectionCases.forEach((scenario) => {
    setEditorLines(["A", "", "", "B"]);
    scenario.select();
    const normalized = windowObject.ChatGPTTemplateDom.normalizeComposer({ requireFocus: true });
    assert.equal(normalized.ok, true, scenario.name);
    assert.equal(normalized.changed, true, scenario.name);
    assert.equal(normalized.text, "A\n\nB", scenario.name);
    assert.equal(windowObject.ChatGPTTemplateDom.readComposer().text, "A\n\nB", scenario.name);
    assert.equal(pointSignature(activeRange.startContainer, activeRange.startOffset), scenario.expectedStart, scenario.name);
    assert.equal(pointSignature(activeRange.endContainer, activeRange.endOffset), scenario.expectedEnd, scenario.name);
  });
  assert.equal(windowObject.ChatGPTTemplateDom.normalizeComposer({ requireFocus: true }).changed, false);
  assert.equal(editor.childNodes.length, 3);
  assert.equal(editor.childNodes[1].childNodes[0].tagName, "BR");
  assert.equal(inputEvents > 0, true);

  asyncBoundaryTests.push((async () => {
    const cases = [
      { existingLines: [""], template: "One line", expected: "One line" },
      { existingLines: [""], template: "First\nSecond", expected: "First\nSecond" },
      { existingLines: ["Existing"], template: "One line", expected: "Existing\n\nOne line" },
      { existingLines: ["Existing", "line"], template: "First\nSecond", expected: "Existing\nline\n\nFirst\nSecond" },
    ];
    for (const scenario of cases) {
      setEditorLines(scenario.existingLines);
      setSelection(editor, editor.childNodes.length);
      const result = await windowObject.ChatGPTTemplateDom.executeTemplate(scenario.template, false);
      assert.equal(result.ok, true);
      assert.equal(result.inserted, true);
      assert.equal(result.failed, false);
      assert.equal(result.verified, true);
      assert.equal(result.verificationFailed, false);
      assert.equal(result.sendAttempted, false);
      assert.equal(result.text, scenario.expected);
      assert.equal(windowObject.ChatGPTTemplateDom.readComposer().text, scenario.expected);
    }
  })());
}

assert.deepEqual(workspace.createInvalidation("glossary", "stable:chatgpt.com:abc", 3), {
  entityFamily: "glossary",
  conversationScope: "stable:chatgpt.com:abc",
  revision: 3,
});
assert.equal(workspace.validateInvalidation({
  entityFamily: "glossary",
  conversationScope: "stable:chatgpt.com:abc",
  revision: 3,
  dataset: [],
}), false);

function createInstrumentedDatabase(initialState) {
  const definitions = workspace.STORE_DEFINITIONS;
  const data = {};
  const instrumentation = { transactions: [], calls: [] };
  Object.keys(definitions).forEach((name) => {
    data[name] = new Map();
    (initialState?.[name] || []).forEach((record) => {
      data[name].set(record[definitions[name].keyPath], clone(record));
    });
  });

  function equalKey(left, right) {
    return JSON.stringify(left) === JSON.stringify(right);
  }

  function indexKey(record, keyPath) {
    return Array.isArray(keyPath) ? keyPath.map((key) => record[key]) : record[keyPath];
  }

  function compareKey(left, right) {
    if (Array.isArray(left) && Array.isArray(right)) {
      for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
        if (left[index] === right[index]) continue;
        if (left[index] === undefined) return -1;
        if (right[index] === undefined) return 1;
        return compareKey(left[index], right[index]);
      }
      return 0;
    }
    if (left === right) return 0;
    return left < right ? -1 : 1;
  }

  function matchesQuery(key, query) {
    if (query === null || query === undefined) return true;
    if (query && Array.isArray(query.lower) && Array.isArray(query.upper)) {
      return Array.isArray(key) && key[0] === query.lower[0];
    }
    return equalKey(key, query);
  }

  function transaction(storeNames, mode) {
    const names = [...storeNames];
    const working = Object.fromEntries(names.map((name) => [name, new Map(
      [...data[name].entries()].map(([key, value]) => [key, clone(value)]),
    )]));
    const record = { storeNames: names, mode };
    instrumentation.transactions.push(record);
    let pending = 0;
    let completionTimer = null;
    let aborted = false;
    let completed = false;

    const tx = {
      error: null,
      oncomplete: null,
      onabort: null,
      onerror: null,
      objectStore(name) {
        if (!working[name]) throw new Error(`Store ${name} is outside this transaction.`);
        return makeStore(name);
      },
      abort() {
        if (aborted || completed) return;
        aborted = true;
        clearTimeout(completionTimer);
        setTimeout(() => tx.onabort?.(), 0);
      },
    };

    function scheduleComplete() {
      clearTimeout(completionTimer);
      completionTimer = setTimeout(() => {
        if (aborted || completed || pending) return;
        completed = true;
        if (mode === "readwrite") names.forEach((name) => { data[name] = working[name]; });
        tx.oncomplete?.();
      }, 0);
    }

    function beginRequest() {
      pending += 1;
      clearTimeout(completionTimer);
    }

    function finishRequest() {
      pending -= 1;
      if (!pending) scheduleComplete();
    }

    function makeRequest(storeName, operation, callback, detail) {
      const request = { result: undefined, error: null, onsuccess: null, onerror: null };
      instrumentation.calls.push({ store: storeName, operation, mode, ...(detail || {}) });
      beginRequest();
      setTimeout(() => {
        if (aborted) {
          finishRequest();
          return;
        }
        try {
          request.result = callback();
          request.onsuccess?.();
        } catch (error) {
          request.error = error;
          tx.error = error;
          request.onerror?.();
          tx.onerror?.();
        } finally {
          finishRequest();
        }
      }, 0);
      return request;
    }

    function assertUnique(storeName, candidate, primaryKey) {
      for (const index of definitions[storeName].indexes.filter((item) => item.unique)) {
        const candidateKey = indexKey(candidate, index.keyPath);
        for (const [key, recordValue] of working[storeName]) {
          if (key !== primaryKey && equalKey(indexKey(recordValue, index.keyPath), candidateKey)) {
            throw new Error(`Unique index ${index.name} rejected a duplicate.`);
          }
        }
      }
    }

    function makeCursor(storeName, indexName, query, direction) {
      const request = { result: undefined, error: null, onsuccess: null, onerror: null };
      const definition = indexName
        ? definitions[storeName].indexes.find((item) => item.name === indexName)
        : { keyPath: definitions[storeName].keyPath };
      const rows = [...working[storeName].values()]
        .filter((value) => matchesQuery(indexKey(value, definition.keyPath), query))
        .sort((left, right) => compareKey(indexKey(left, definition.keyPath), indexKey(right, definition.keyPath)));
      if (direction === "prev") rows.reverse();
      let position = 0;
      const deliver = () => {
        beginRequest();
        setTimeout(() => {
          if (aborted) {
            finishRequest();
            return;
          }
          const value = rows[position];
          if (value === undefined) request.result = null;
          else {
            instrumentation.calls.push({ store: storeName, operation: "cursor", index: indexName, mode });
            request.result = {
              value: clone(value),
              continue() {
                position += 1;
                deliver();
              },
            };
          }
          request.onsuccess?.();
          finishRequest();
        }, 0);
      };
      instrumentation.calls.push({ store: storeName, operation: "openCursor", index: indexName, mode });
      deliver();
      return request;
    }

    function makeStore(storeName) {
      const keyPath = definitions[storeName].keyPath;
      return {
        get(key) {
          return makeRequest(storeName, "get", () => clone(working[storeName].get(key)), { key });
        },
        add(value) {
          return makeRequest(storeName, "add", () => {
            const recordValue = clone(value);
            const key = recordValue[keyPath];
            if (working[storeName].has(key)) throw new Error("Duplicate primary key.");
            assertUnique(storeName, recordValue, key);
            working[storeName].set(key, recordValue);
            return key;
          }, { key: value[keyPath] });
        },
        put(value) {
          return makeRequest(storeName, "put", () => {
            const recordValue = clone(value);
            const key = recordValue[keyPath];
            assertUnique(storeName, recordValue, key);
            working[storeName].set(key, recordValue);
            return key;
          }, { key: value[keyPath] });
        },
        delete(key) {
          return makeRequest(storeName, "delete", () => { working[storeName].delete(key); }, { key });
        },
        clear() {
          return makeRequest(storeName, "clear", () => { working[storeName].clear(); });
        },
        openCursor(query, direction) {
          return makeCursor(storeName, null, query, direction);
        },
        index(name) {
          const definition = definitions[storeName].indexes.find((item) => item.name === name);
          if (!definition) throw new Error(`Unknown index ${name}.`);
          return {
            get(key) {
              return makeRequest(storeName, "index.get", () => clone(
                [...working[storeName].values()].find((value) => equalKey(indexKey(value, definition.keyPath), key)),
              ), { index: name, key });
            },
            openCursor(query, direction) {
              return makeCursor(storeName, name, query, direction);
            },
          };
        },
      };
    }

    scheduleComplete();
    return tx;
  }

  return {
    database: { transaction },
    instrumentation,
    snapshot() {
      return Object.fromEntries(Object.keys(definitions).map((name) => [name, [...data[name].values()].map(clone)]));
    },
    resetInstrumentation() {
      instrumentation.transactions.length = 0;
      instrumentation.calls.length = 0;
    },
  };
}

async function runStoreTests() {
  await Promise.all(asyncBoundaryTests);
  const coalescedResponses = [];
  const workspaceStatuses = [];
  let coalescedCalls = 0;
  const coalescedClient = conversations.createClient({
    send() {
      coalescedCalls += 1;
      return new Promise((resolve) => coalescedResponses.push(resolve));
    },
    onStatusChange(status) { workspaceStatuses.push(status); },
  });
  const coalescedFirst = coalescedClient.sync("https://chatgpt.com/");
  const coalescedSecond = coalescedClient.sync("https://chatgpt.com/");
  assert.equal(coalescedFirst, coalescedSecond);
  assert.equal(coalescedCalls, 1);
  coalescedResponses[0]({
    ok: false,
    error: { code: "WORKSPACE_MIGRATION_FAILED", message: "raw database detail must not escape" },
  });
  assert.equal(await coalescedFirst, null);
  assert.equal(coalescedClient.getStatus().status, "unavailable");
  assert.equal(coalescedClient.getStatus().errorCode, "WORKSPACE_MIGRATION_FAILED");
  assert.match(coalescedClient.getStatus().message, /Данные словаря V1 не удалены/);
  assert.equal(coalescedClient.getStatus().message.includes("raw database detail"), false);
  const retry = coalescedClient.retry();
  assert.equal(coalescedCalls, 2);
  coalescedResponses[1]({ ok: true, context: {
    id: "recovered",
    kind: "temporary",
    host: "chatgpt.com",
    scopeKey: "temporary:recovered-context",
    remoteConversationId: null,
  } });
  assert.equal((await retry).scopeKey, "temporary:recovered-context");
  assert.equal(coalescedClient.getStatus().status, "ready");
  assert.equal(workspaceStatuses.some((status) => status.status === "unavailable"), true);
  assert.equal(workspaceStatuses.at(-1).status, "ready");

  let workspaceClientSends = 0;
  const blockedWorkspaceClient = workspaceUi.createClient({
    getContext: () => null,
    getStatus: () => ({ status: "unavailable" }),
    send: async () => { workspaceClientSends += 1; return { ok: true }; },
  });
  assert.equal((await blockedWorkspaceClient.saveSelection("preserve me")).ok, false);
  assert.equal(workspaceClientSends, 0);
  const malformedReplacementClient = workspaceUi.createClient({
    getContext: () => ({ scopeKey: "stable:chatgpt.com:client-validation" }),
    getStatus: () => ({ status: "ready" }),
    send: async () => { workspaceClientSends += 1; return { ok: true }; },
  });
  assert.equal((await malformedReplacementClient.replaceGlossary({
    entryId: "target",
    sourceSenseId: "source",
  })).error.code, "REQUEST_CONTRACT_ERROR");
  assert.equal(workspaceClientSends, 0);

  const pendingContexts = [];
  const observedContexts = [];
  const contextClient = conversations.createClient({
    send(message) {
      return new Promise((resolve) => pendingContexts.push({ message, resolve }));
    },
    onChange(context) { observedContexts.push(context.scopeKey); },
  });
  const firstSync = contextClient.sync("https://chatgpt.com/c/first-race");
  const secondSync = contextClient.sync("https://chatgpt.com/c/second-race");
  pendingContexts[1].resolve({ ok: true, context: {
    id: "second",
    kind: "stable",
    host: "chatgpt.com",
    scopeKey: "stable:chatgpt.com:second-race",
    remoteConversationId: "second-race",
  } });
  await secondSync;
  pendingContexts[0].resolve({ ok: true, context: {
    id: "first",
    kind: "stable",
    host: "chatgpt.com",
    scopeKey: "stable:chatgpt.com:first-race",
    remoteConversationId: "first-race",
  } });
  await firstSync;
  assert.equal(contextClient.getCurrent().scopeKey, "stable:chatgpt.com:second-race");
  assert.deepEqual(observedContexts, ["stable:chatgpt.com:second-race"]);

  let nextId = 0;
  let clock = 1000;
  const createStore = (initialState) => new workspaceStore.MemoryWorkspaceStore(initialState, {
    createId(prefix) { nextId += 1; return `${prefix}-${nextId}`; },
    now() { clock += 1; return clock; },
  });
  const stable = (id) => ({
    kind: "stable",
    host: "chatgpt.com",
    remoteConversationId: id,
    scopeKey: `stable:chatgpt.com:${id}`,
  });
  const temporary = (id) => ({ kind: "temporary", host: "chatgpt.com", scopeKey: `temporary:${id}` });

  const settingsExport = importExport.createSettingsExport({
    theme: "navy",
    wallpaperDataUrl: "data:image/png;base64,AA==",
    closePanelAfterRun: true,
    closePanelOnOutsideClick: false,
    recentTemplatesHoverEnabled: false,
    recentTemplatesHoverCount: 7,
    analysis: { termColorMode: "custom", customTermColor: "#abcdef", glossaryTextSize: "large" },
    layout: { sidebarWidth: 515, analysisDialogWidth: 745 },
    commands: { mustNotExport: true },
    openRouterKey: "must-not-export",
  }, { exportedAt: "2026-07-18T10:00:00.000Z", extensionVersion: "2.0.0" });
  assert.equal(settingsExport.text, importExport.canonicalStringify(settingsExport.envelope));
  assert.equal(settingsExport.text.endsWith("\n"), true);
  assert.equal(settingsExport.text.includes("must-not-export"), false);
  const validSettings = importExport.validateSettingsText(settingsExport.text);
  assert.equal(validSettings.ok, true);
  assert.equal(validSettings.imported.recentTemplatesHoverCount, 7);
  const settingsMerge = importExport.buildSettingsPlan(workspace.DEFAULT_ACTIVE_SETTINGS, validSettings, "merge");
  assert.equal(settingsMerge.settings.theme, "navy");
  assert.equal(settingsMerge.settings.closePanelOnOutsideClick, false);
  assert.equal(settingsMerge.settings.recentTemplatesHoverCount, 7);
  assert.equal(settingsMerge.preview.values.current.wallpaperDataUrl, null);
  assert.match(settingsMerge.preview.values.result.wallpaperDataUrl, /^\[data:image,/);
  const partialSettings = JSON.parse(settingsExport.text);
  partialSettings.payload = { theme: "graphite", layout: { sidebarWidth: 99999 }, unknownSetting: true };
  partialSettings.unknownEnvelope = true;
  const partialValidation = importExport.validateSettingsText(JSON.stringify(partialSettings));
  assert.equal(partialValidation.ok, true);
  assert.equal(partialValidation.warnings.filter((item) => item.code === "UNKNOWN_FIELD").length, 2);
  assert.equal(partialValidation.warnings.some((item) => item.code === "CLAMPED_WIDTH"), true);
  const mergePartialSettings = importExport.buildSettingsPlan(settingsMerge.settings, partialValidation, "merge");
  assert.equal(mergePartialSettings.settings.recentTemplatesHoverCount, 7);
  const replaceSettings = importExport.buildSettingsPlan(settingsMerge.settings, partialValidation, "replace");
  assert.equal(replaceSettings.settings.layout.sidebarWidth, workspace.LAYOUT.sidebarWidth.max);
  assert.equal(replaceSettings.settings.analysis.glossaryTextSize, workspace.DEFAULT_ACTIVE_SETTINGS.analysis.glossaryTextSize);
  assert.equal(replaceSettings.settings.recentTemplatesHoverCount, 3);
  assert.equal(replaceSettings.preview.reset.includes("analysis.glossaryTextSize"), true);
  assert.equal(replaceSettings.preview.reset.includes("recentTemplatesHoverCount"), true);
  const invalidSettings = JSON.parse(settingsExport.text);
  invalidSettings.payload.theme = 17;
  assert.equal(importExport.validateSettingsText(JSON.stringify(invalidSettings)).errors[0].code, "INVALID_THEME");
  for (const invalidRecentTemplatesHoverCount of ["3", null, 1.5, 0, 9]) {
    const invalidCountSettings = JSON.parse(settingsExport.text);
    invalidCountSettings.payload.recentTemplatesHoverCount = invalidRecentTemplatesHoverCount;
    assert.equal(
      importExport.validateSettingsText(JSON.stringify(invalidCountSettings)).errors[0].code,
      "INVALID_RECENT_TEMPLATES_HOVER_COUNT",
    );
  }
  const futureSettings = JSON.parse(settingsExport.text);
  futureSettings.schemaVersion += 1;
  assert.equal(importExport.validateSettingsText(JSON.stringify(futureSettings)).errors[0].code, "FUTURE_SCHEMA");
  assert.equal(importExport.validateSettingsText("x".repeat(importExport.SETTINGS_MAX_BYTES + 1)).errors[0].code, "FILE_TOO_LARGE");

  const portableState = {
    templates: [{ id: "template-one", name: "Шаблон", content: "Проверь текст", autoSend: false }],
    conversations: [{ id: "conversation-one", kind: "stable", host: "chatgpt.com", remoteConversationId: "conversation-one", createdAt: 10, lastSeenAt: 20, orphanedAt: null }],
    glossaryConcepts: [{ id: "concept-one", displayTerm: "Workflow", createdAt: 10, updatedAt: 20 }],
    glossarySenses: [{ id: "sense-one", conceptId: "concept-one", translation: "процесс", definition: "Последовательность действий.", createdAt: 10, updatedAt: 20 }],
    glossaryLinks: [{ id: "glossary-link-one", senseId: "sense-one", conversationId: "conversation-one", localOrder: 0, firstSeenAt: 10, lastSeenAt: 20 }],
    savedItems: [{ id: "saved-one", text: "Сохранённый текст", createdAt: 10, updatedAt: 20 }],
    savedItemLinks: [{ id: "saved-link-one", itemId: "saved-one", conversationId: "conversation-one", localOrder: 0, firstSeenAt: 10, lastSeenAt: 20 }],
  };
  const dataMetadata = { datasetId: "11111111-2222-4333-8444-555555555555", exportedAt: "2026-07-18T10:00:00.000Z", extensionVersion: "2.0.0" };
  const dataExport = importExport.createDataExport(portableState, dataMetadata);
  assert.equal(dataExport.text, importExport.canonicalStringify(dataExport.envelope));
  assert.equal(dataExport.text.includes("closePanelOnOutsideClick"), false);
  assert.equal(dataExport.text.includes("recentTemplatesHoverCount"), false);
  const sortedExport = importExport.createDataExport({
    ...portableState,
    templates: [
      { id: "template-z", name: "Z", content: "Z", autoSend: false },
      { id: "template-a", name: "A", content: "A", autoSend: false },
    ],
  }, dataMetadata);
  assert.deepEqual(sortedExport.envelope.payload.templates.map((item) => item.id), ["template-z", "template-a"]);
  assert.deepEqual(
    importExport.validateDataText(sortedExport.text).envelope.payload.templates.map((item) => item.id),
    ["template-z", "template-a"],
  );
  const orderedValidation = importExport.validateDataText(sortedExport.text);
  const orderedCurrent = {
    templates: [{ id: "template-current", name: "Current", content: "Current", autoSend: false }],
    conversations: [], glossaryConcepts: [], glossarySenses: [], glossaryLinks: [], savedItems: [], savedItemLinks: [],
  };
  const orderedMerge = await importExport.buildDataPlan(orderedCurrent, orderedValidation, "merge", webcrypto);
  assert.deepEqual(orderedMerge.state.templates.map((item) => item.id), ["template-current", "template-z", "template-a"]);
  const orderedRepeatedMerge = await importExport.buildDataPlan(orderedMerge.state, orderedValidation, "merge", webcrypto);
  assert.deepEqual(orderedRepeatedMerge.state.templates.map((item) => item.id), ["template-current", "template-z", "template-a"]);
  const orderedReplace = await importExport.buildDataPlan(orderedCurrent, orderedValidation, "replace", webcrypto);
  assert.deepEqual(orderedReplace.state.templates.map((item) => item.id), ["template-z", "template-a"]);
  assert.equal(dataExport.text.includes("scopeKey"), false);
  assert.equal(dataExport.text.includes("normalizedTextKey"), false);
  const validData = importExport.validateDataText(dataExport.text);
  assert.equal(validData.ok, true);
  const replaceData = await importExport.buildDataPlan({}, validData, "replace", webcrypto);
  assert.equal(replaceData.preview.aggregateOnly, true);
  assert.equal(replaceData.state.conversations[0].scopeKey, "stable:chatgpt.com:conversation-one");
  assert.equal(replaceData.state.savedItems[0].normalizedTextKey, workspace.normalizeSavedTextKey("Сохранённый текст"));
  const collisionCurrent = {
    ...workspaceStore.createEmptyState(1),
    templates: [{ id: "template-one", name: "Локальный", content: "Не заменять", autoSend: true }],
    conversations: [{ id: "conversation-one", kind: "stable", host: "chatgpt.com", remoteConversationId: "local-conversation", scopeKey: "stable:chatgpt.com:local-conversation", canonicalUrl: "https://chatgpt.com/c/local-conversation", createdAt: 1, lastSeenAt: 2, orphanedAt: null }],
  };
  const firstMerge = await importExport.buildDataPlan(collisionCurrent, validData, "merge", webcrypto);
  assert.equal(firstMerge.preview.remapped >= 2, true);
  assert.equal(collisionCurrent.templates[0].content, "Не заменять");
  const repeatedMerge = await importExport.buildDataPlan(firstMerge.state, validData, "merge", webcrypto);
  assert.equal(importExport.canonicalDataEqual(firstMerge.state, repeatedMerge.state), true);
  assert.equal(repeatedMerge.preview.new.templates, 0);
  assert.equal(
    await importExport.deterministicRemapId(dataMetadata.datasetId, "templates", "template-one", 0, webcrypto),
    await importExport.deterministicRemapId(dataMetadata.datasetId, "templates", "template-one", 0, webcrypto),
  );

  const duplicateGraph = {
    templates: [
      { id: "template-z", name: "Z", content: "Z", autoSend: false },
      { id: "template-a", name: "A", content: "A", autoSend: false },
    ],
    conversations: [
      { id: "conversation-a", kind: "stable", host: "chatgpt.com", remoteConversationId: "duplicate", createdAt: 30, lastSeenAt: 31, orphanedAt: null },
      { id: "conversation-b", kind: "stable", host: "chatgpt.com", remoteConversationId: "duplicate", createdAt: 20, lastSeenAt: 40, orphanedAt: null },
      { id: "conversation-c", kind: "stable", host: "chatgpt.com", remoteConversationId: "duplicate", createdAt: 10, lastSeenAt: 50, orphanedAt: null },
    ],
    glossaryConcepts: [
      { id: "concept-a", displayTerm: "Workflow", createdAt: 30, updatedAt: 31 },
      { id: "concept-b", displayTerm: "workflow", createdAt: 20, updatedAt: 40 },
      { id: "concept-c", displayTerm: "WORKFLOW", createdAt: 10, updatedAt: 50 },
    ],
    glossarySenses: [
      { id: "sense-a", conceptId: "concept-a", translation: "процесс", definition: "Действия.", createdAt: 30, updatedAt: 31 },
      { id: "sense-b", conceptId: "concept-b", translation: "процесс", definition: "Действия.", createdAt: 20, updatedAt: 40 },
      { id: "sense-c", conceptId: "concept-c", translation: "процесс", definition: "Действия.", createdAt: 10, updatedAt: 50 },
    ],
    glossaryLinks: [
      { id: "glossary-link-a", senseId: "sense-a", conversationId: "conversation-a", localOrder: 2, firstSeenAt: 30, lastSeenAt: 31 },
      { id: "glossary-link-b", senseId: "sense-b", conversationId: "conversation-b", localOrder: 1, firstSeenAt: 20, lastSeenAt: 40 },
      { id: "glossary-link-c", senseId: "sense-c", conversationId: "conversation-c", localOrder: 0, firstSeenAt: 10, lastSeenAt: 50 },
    ],
    savedItems: [
      { id: "saved-a", text: "Один текст", createdAt: 30, updatedAt: 31 },
      { id: "saved-b", text: "Один текст", createdAt: 20, updatedAt: 40 },
      { id: "saved-c", text: "Один текст", createdAt: 10, updatedAt: 50 },
    ],
    savedItemLinks: [
      { id: "saved-link-a", itemId: "saved-a", conversationId: "conversation-a", localOrder: 2, firstSeenAt: 30, lastSeenAt: 31 },
      { id: "saved-link-b", itemId: "saved-b", conversationId: "conversation-b", localOrder: 1, firstSeenAt: 20, lastSeenAt: 40 },
      { id: "saved-link-c", itemId: "saved-c", conversationId: "conversation-c", localOrder: 0, firstSeenAt: 10, lastSeenAt: 50 },
    ],
  };
  const duplicateEnvelope = {
    format: importExport.DATA_FORMAT,
    schemaVersion: importExport.SCHEMA_VERSION,
    workspaceSchemaVersion: workspace.WORKSPACE_SCHEMA_VERSION,
    datasetId: dataMetadata.datasetId,
    exportedAt: dataMetadata.exportedAt,
    payload: duplicateGraph,
  };
  const duplicateValidation = importExport.validateDataText(JSON.stringify(duplicateEnvelope));
  assert.equal(duplicateValidation.ok, true);
  const canonicalDuplicate = duplicateValidation.envelope.payload;
  assert.deepEqual(canonicalDuplicate.templates.map((item) => item.id), ["template-z", "template-a"]);
  assert.deepEqual(canonicalDuplicate.conversations.map((item) => item.id), ["conversation-c"]);
  assert.deepEqual(canonicalDuplicate.glossaryConcepts.map((item) => item.id), ["concept-c"]);
  assert.deepEqual(canonicalDuplicate.glossarySenses.map((item) => [item.id, item.conceptId]), [["sense-c", "concept-c"]]);
  assert.deepEqual(canonicalDuplicate.savedItems.map((item) => item.id), ["saved-c"]);
  assert.deepEqual(canonicalDuplicate.glossaryLinks.map((item) => [item.id, item.senseId, item.conversationId]), [
    ["glossary-link-c", "sense-c", "conversation-c"],
  ]);
  assert.deepEqual(canonicalDuplicate.savedItemLinks.map((item) => [item.id, item.itemId, item.conversationId]), [
    ["saved-link-c", "saved-c", "conversation-c"],
  ]);
  for (const family of ["conversations", "glossaryConcepts", "glossarySenses", "savedItems", "glossaryLinks", "savedItemLinks"]) {
    const retainedIds = new Set(canonicalDuplicate[family].map((item) => item.id));
    assert.equal([...duplicateValidation.canonical.remaps[family].values()].every((id) => retainedIds.has(id)), true);
  }
  assert.deepEqual(duplicateValidation.canonical.deduplicatedByFamily, {
    templates: 0,
    conversations: 2,
    glossaryConcepts: 2,
    glossarySenses: 2,
    glossaryLinks: 2,
    savedItems: 2,
    savedItemLinks: 2,
  });

  const temporaryPortable = {
    templates: [],
    conversations: [{ id: "temporary-source", kind: "temporary", host: "chatgpt.com", remoteConversationId: null, createdAt: 10, lastSeenAt: 20, orphanedAt: 20 }],
    glossaryConcepts: [{ id: "temporary-concept", displayTerm: "Context", createdAt: 10, updatedAt: 20 }],
    glossarySenses: [
      { id: "temporary-sense", conceptId: "temporary-concept", translation: "контекст", definition: "Окружение.", createdAt: 10, updatedAt: 20 },
      { id: "global-sense", conceptId: "temporary-concept", translation: "связь", definition: "Глобальное значение.", createdAt: 11, updatedAt: 21 },
    ],
    glossaryLinks: [{ id: "temporary-glossary-link", senseId: "temporary-sense", conversationId: "temporary-source", localOrder: 0, firstSeenAt: 10, lastSeenAt: 20 }],
    savedItems: [
      { id: "temporary-saved", text: "Временный текст", createdAt: 10, updatedAt: 20 },
      { id: "global-saved", text: "Глобальный текст", createdAt: 11, updatedAt: 21 },
    ],
    savedItemLinks: [{ id: "temporary-saved-link", itemId: "temporary-saved", conversationId: "temporary-source", localOrder: 0, firstSeenAt: 10, lastSeenAt: 20 }],
  };
  const temporaryValidation = importExport.validateDataText(importExport.createDataExport(temporaryPortable, dataMetadata).text);
  const occupiedTemporaryCurrent = {
    ...workspaceStore.createEmptyState(1),
    templates: [],
    conversations: [{ id: "temporary-source", kind: "stable", host: "chatgpt.com", remoteConversationId: "occupied", scopeKey: "stable:chatgpt.com:occupied", canonicalUrl: "https://chatgpt.com/c/occupied", createdAt: 1, lastSeenAt: 2, orphanedAt: null }],
  };
  const temporaryFirst = await importExport.buildDataPlan(occupiedTemporaryCurrent, temporaryValidation, "merge", webcrypto);
  const temporarySecond = await importExport.buildDataPlan(temporaryFirst.state, temporaryValidation, "merge", webcrypto);
  const temporaryThird = await importExport.buildDataPlan(temporarySecond.state, temporaryValidation, "merge", webcrypto);
  assert.equal(importExport.canonicalDataEqual(temporaryFirst.state, temporarySecond.state), true);
  assert.equal(importExport.canonicalDataEqual(temporarySecond.state, temporaryThird.state), true);
  assert.equal(temporaryThird.state.conversations.filter((item) => item.kind === "temporary").length, 1);
  assert.equal(temporaryThird.state.glossaryLinks.length, 1);
  assert.equal(temporaryThird.state.savedItemLinks.length, 1);
  assert.equal(temporaryThird.state.glossarySenses.length, 2);
  assert.equal(temporaryThird.state.savedItems.length, 2);
  assert.match(
    temporaryThird.state.conversations.find((item) => item.kind === "temporary").scopeKey,
    /^temporary:import-temporary-provenance-[0-9a-f]{32}$/,
  );
  const wrongTemporaryScope = structuredClone(temporaryThird.state);
  wrongTemporaryScope.conversations.find((item) => item.kind === "temporary").scopeKey = "temporary:import-wrong-provenance";
  assert.equal(importExport.canonicalDataEqual(temporaryThird.state, wrongTemporaryScope), false);
  const otherDatasetMetadata = { ...dataMetadata, datasetId: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee" };
  const otherTemporaryValidation = importExport.validateDataText(importExport.createDataExport(temporaryPortable, otherDatasetMetadata).text);
  const otherTemporaryMerge = await importExport.buildDataPlan(temporaryThird.state, otherTemporaryValidation, "merge", webcrypto);
  assert.equal(otherTemporaryMerge.state.conversations.filter((item) => item.kind === "temporary").length, 2);
  assert.equal(otherTemporaryMerge.state.glossaryLinks.length, 2);
  assert.equal(otherTemporaryMerge.state.savedItemLinks.length, 2);

  const timestampCurrent = {
    templates: [],
    conversations: [{ id: "current-conversation", kind: "stable", host: "chatgpt.com", remoteConversationId: "conversation-one", scopeKey: "stable:chatgpt.com:conversation-one", canonicalUrl: "https://chatgpt.com/c/conversation-one", createdAt: 15, lastSeenAt: 18, orphanedAt: 17 }],
    glossaryConcepts: [{ id: "current-concept", displayTerm: "WORKFLOW", canonicalTerm: "WORKFLOW", normalizedKey: "workflow", createdAt: 15, updatedAt: 18 }],
    glossarySenses: [{ id: "current-sense", conceptId: "current-concept", translation: "Процесс", definition: "Последовательность действий.", normalizedTranslation: "процесс", normalizedDefinition: "последовательность действий.", naturalKey: workspace.createSenseNaturalKey("current-concept", "Процесс", "Последовательность действий."), createdAt: 15, updatedAt: 18 }],
    glossaryLinks: [{ id: "current-glossary-link", senseId: "current-sense", conversationId: "current-conversation", linkKey: "current-sense\u001fcurrent-conversation", localOrder: 7, firstSeenAt: 15, lastSeenAt: 18 }],
    savedItems: [{ id: "current-saved", text: "Сохранённый текст", normalizedTextKey: "Сохранённый текст", createdAt: 15, updatedAt: 18 }],
    savedItemLinks: [{ id: "current-saved-link", itemId: "current-saved", conversationId: "current-conversation", linkKey: "current-saved\u001fcurrent-conversation", localOrder: 9, firstSeenAt: 15, lastSeenAt: 18 }],
  };
  const timestampMerge = await importExport.buildDataPlan(timestampCurrent, validData, "merge", webcrypto);
  assert.deepEqual(timestampMerge.state.conversations.find((item) => item.id === "current-conversation"), {
    ...timestampCurrent.conversations[0], createdAt: 10, lastSeenAt: 20, orphanedAt: null,
  });
  assert.equal(timestampMerge.state.glossaryConcepts.find((item) => item.id === "current-concept").displayTerm, "WORKFLOW");
  assert.equal(timestampMerge.state.glossaryConcepts.find((item) => item.id === "current-concept").createdAt, 10);
  assert.equal(timestampMerge.state.glossaryConcepts.find((item) => item.id === "current-concept").updatedAt, 20);
  assert.equal(timestampMerge.state.glossarySenses.find((item) => item.id === "current-sense").translation, "Процесс");
  assert.equal(timestampMerge.state.glossarySenses.find((item) => item.id === "current-sense").createdAt, 10);
  assert.equal(timestampMerge.state.glossarySenses.find((item) => item.id === "current-sense").updatedAt, 20);
  assert.equal(timestampMerge.state.savedItems.find((item) => item.id === "current-saved").id, "current-saved");
  assert.equal(timestampMerge.state.savedItems.find((item) => item.id === "current-saved").createdAt, 10);
  assert.equal(timestampMerge.state.savedItems.find((item) => item.id === "current-saved").updatedAt, 20);
  assert.deepEqual(
    timestampMerge.state.glossaryLinks.find((item) => item.id === "current-glossary-link"),
    { ...timestampCurrent.glossaryLinks[0], firstSeenAt: 10, lastSeenAt: 20 },
  );
  assert.deepEqual(
    timestampMerge.state.savedItemLinks.find((item) => item.id === "current-saved-link"),
    { ...timestampCurrent.savedItemLinks[0], firstSeenAt: 10, lastSeenAt: 20 },
  );
  const timestampRepeated = await importExport.buildDataPlan(timestampMerge.state, validData, "merge", webcrypto);
  assert.equal(importExport.canonicalDataEqual(timestampMerge.state, timestampRepeated.state), true);
  const timestampReplace = await importExport.buildDataPlan(timestampCurrent, validData, "replace", webcrypto);
  assert.equal(timestampReplace.state.glossaryConcepts[0].id, "concept-one");
  assert.equal(timestampReplace.state.glossaryConcepts[0].displayTerm, "Workflow");
  assert.equal(timestampReplace.state.glossaryLinks[0].localOrder, 0);

  const previewCurrent = {
    templates: [
      { id: "template-a", name: "A", content: "A", autoSend: false },
      { id: "template-b", name: "B", content: "B", autoSend: false },
    ],
    conversations: [], glossaryConcepts: [], glossarySenses: [], glossaryLinks: [], savedItems: [], savedItemLinks: [],
  };
  const previewIncoming = {
    ...previewCurrent,
    templates: [
      { id: "template-b", name: "B", content: "B", autoSend: false },
      { id: "template-c", name: "C", content: "C", autoSend: false },
    ],
  };
  const previewValidation = importExport.validateDataText(importExport.createDataExport(previewIncoming, dataMetadata).text);
  const identityReplace = await importExport.buildDataPlan(previewCurrent, previewValidation, "replace", webcrypto);
  assert.equal(identityReplace.preview.current.templates, 2);
  assert.equal(identityReplace.preview.incoming.templates, 2);
  assert.equal(identityReplace.preview.retained.templates, 1);
  assert.equal(identityReplace.preview.created.templates, 1);
  assert.equal(identityReplace.preview.removed.templates, 1);
  assert.equal(identityReplace.preview.resulting.templates, 2);
  const orderOnlyValidation = importExport.validateDataText(importExport.createDataExport({
    ...previewCurrent,
    templates: [...previewCurrent.templates].reverse(),
  }, dataMetadata).text);
  const orderOnlyReplace = await importExport.buildDataPlan(previewCurrent, orderOnlyValidation, "replace", webcrypto);
  assert.equal(orderOnlyReplace.preview.retained.templates, 2);
  assert.equal(orderOnlyReplace.preview.created.templates, 0);
  assert.equal(orderOnlyReplace.preview.removed.templates, 0);
  assert.equal(orderOnlyReplace.preview.orderChanged.templates, true);
  assert.equal(importExport.canonicalDataEqual(previewCurrent, orderOnlyReplace.state), false);
  for (const changedTemplate of [
    { ...previewCurrent.templates[0], content: "Changed content" },
    { ...previewCurrent.templates[0], name: "Changed name" },
    { ...previewCurrent.templates[0], autoSend: true },
  ]) {
    const changedInPlace = importExport.validateDataText(importExport.createDataExport({
      ...previewCurrent,
      templates: [changedTemplate, previewCurrent.templates[1]],
    }, dataMetadata).text);
    assert.equal((await importExport.buildDataPlan(previewCurrent, changedInPlace, "replace", webcrypto)).preview.orderChanged.templates, false);
  }
  const reorderAndContentValidation = importExport.validateDataText(importExport.createDataExport({
    ...previewCurrent,
    templates: [previewCurrent.templates[1], { ...previewCurrent.templates[0], content: "Changed while reordered" }],
  }, dataMetadata).text);
  assert.equal((await importExport.buildDataPlan(previewCurrent, reorderAndContentValidation, "replace", webcrypto)).preview.orderChanged.templates, true);
  assert.equal(identityReplace.preview.orderChanged.templates, true);
  const mergeReorder = await importExport.buildDataPlan(previewCurrent, orderOnlyValidation, "merge", webcrypto);
  assert.equal(mergeReorder.preview.orderChanged.templates, false);
  const emptyValidation = importExport.validateDataText(importExport.createDataExport({
    templates: [], conversations: [], glossaryConcepts: [], glossarySenses: [], glossaryLinks: [], savedItems: [], savedItemLinks: [],
  }, dataMetadata).text);
  assert.equal((await importExport.buildDataPlan(previewCurrent, emptyValidation, "replace", webcrypto)).preview.removed.templates, 2);
  assert.equal((await importExport.buildDataPlan(previewCurrent, emptyValidation, "replace", webcrypto)).preview.orderChanged.templates, true);
  assert.equal((await importExport.buildDataPlan({}, emptyValidation, "replace", webcrypto)).preview.orderChanged.templates, false);
  assert.equal((await importExport.buildDataPlan({}, previewValidation, "replace", webcrypto)).preview.created.templates, 2);

  const brokenReference = JSON.parse(dataExport.text);
  brokenReference.payload.glossaryLinks[0].senseId = "missing-sense";
  assert.equal(importExport.validateDataText(JSON.stringify(brokenReference)).errors.some((item) => item.code === "BROKEN_REFERENCE"), true);
  const duplicateId = JSON.parse(dataExport.text);
  duplicateId.payload.savedItems.push({ ...duplicateId.payload.savedItems[0] });
  assert.equal(importExport.validateDataText(JSON.stringify(duplicateId)).errors[0].code, "DUPLICATE_ID");
  const futureData = JSON.parse(dataExport.text);
  futureData.schemaVersion += 1;
  assert.equal(importExport.validateDataText(JSON.stringify(futureData)).errors[0].code, "FUTURE_SCHEMA");
  const largePortable = { ...portableState, templates: Array.from({ length: 1000 }, (_, index) => ({ id: `template-${index}`, name: `Шаблон ${index}`, content: `Текст ${index}`, autoSend: false })) };
  const largeValidation = importExport.validateDataText(importExport.createDataExport(largePortable, dataMetadata).text);
  const plannerStartedAt = performance.now();
  assert.equal((await importExport.buildDataPlan({}, largeValidation, "merge", webcrypto)).state.templates.length, 1000);
  assert.equal(performance.now() - plannerStartedAt < 5000, true);

  const largeDuplicateLinkPayload = {
    templates: [],
    conversations: [{ id: "large-conversation", kind: "stable", host: "chatgpt.com", remoteConversationId: "large", createdAt: 1, lastSeenAt: 2, orphanedAt: null }],
    glossaryConcepts: [],
    glossarySenses: [],
    glossaryLinks: [],
    savedItems: [{ id: "large-item", text: "Large duplicate item", createdAt: 1, updatedAt: 2 }],
    savedItemLinks: Array.from({ length: 20000 }, (_, index) => ({
      id: `large-link-${String(index).padStart(5, "0")}`,
      itemId: "large-item",
      conversationId: "large-conversation",
      localOrder: 20000 - index,
      firstSeenAt: 30000 - index,
      lastSeenAt: 40000 + index,
    })),
  };
  assert.equal(importExport.byteLength(JSON.stringify(largeDuplicateLinkPayload)) < importExport.DATA_MAX_BYTES, true);
  const largeDuplicateStartedAt = performance.now();
  const largeDuplicateCanonical = importExport.canonicalizeDataPayload(largeDuplicateLinkPayload);
  assert.equal(largeDuplicateCanonical.payload.savedItemLinks.length, 1);
  assert.deepEqual({
    localOrder: largeDuplicateCanonical.payload.savedItemLinks[0].localOrder,
    firstSeenAt: largeDuplicateCanonical.payload.savedItemLinks[0].firstSeenAt,
    lastSeenAt: largeDuplicateCanonical.payload.savedItemLinks[0].lastSeenAt,
  }, { localOrder: 1, firstSeenAt: 10001, lastSeenAt: 59999 });
  assert.equal(largeDuplicateCanonical.deduplicatedByFamily.savedItemLinks, 19999);
  assert.equal(performance.now() - largeDuplicateStartedAt < 5000, true);

  const temporaryConversationState = {
    templates: [],
    conversations: Array.from({ length: 500 }, (_, index) => ({
      id: `temporary-${String(index).padStart(4, "0")}`,
      kind: "temporary",
      host: "chatgpt.com",
      remoteConversationId: null,
      createdAt: index + 1,
      lastSeenAt: index + 2,
      orphanedAt: index + 2,
    })),
    glossaryConcepts: [], glossarySenses: [], glossaryLinks: [], savedItems: [], savedItemLinks: [],
  };
  const largeTemporaryValidation = importExport.validateDataText(importExport.createDataExport(temporaryConversationState, dataMetadata).text);
  let activeDigests = 0;
  let maximumDigests = 0;
  let digestCalls = 0;
  const instrumentedCrypto = {
    subtle: {
      async digest(...args) {
        activeDigests += 1;
        maximumDigests = Math.max(maximumDigests, activeDigests);
        digestCalls += 1;
        try {
          await Promise.resolve();
          return await webcrypto.subtle.digest(...args);
        } finally {
          activeDigests -= 1;
        }
      },
    },
  };
  const temporaryPlanStartedAt = performance.now();
  const manyTemporaryPlan = await importExport.buildDataPlan({}, largeTemporaryValidation, "replace", instrumentedCrypto);
  const repeatedTemporaryPlan = await importExport.buildDataPlan({}, largeTemporaryValidation, "replace", webcrypto);
  assert.equal(digestCalls, 500);
  assert.equal(maximumDigests, 1);
  assert.deepEqual(
    manyTemporaryPlan.state.conversations.map((item) => item.scopeKey),
    repeatedTemporaryPlan.state.conversations.map((item) => item.scopeKey),
  );
  assert.equal(performance.now() - temporaryPlanStartedAt < 5000, true);

  const importStore = createStore();
  const userData = Object.fromEntries(workspaceStore.USER_STORE_NAMES.map((name) => [name, replaceData.state[name]]));
  await importStore.putImportBackup("data", await importStore.snapshotUserData());
  await importStore.setMetaValue("pendingDataImport", { phase: "applying", createdAt: 1 });
  await importStore.replaceUserData(userData);
  assert.equal((await importStore.snapshotUserData()).savedItems.length, 1);
  assert.equal((await importStore.getImportBackup("data")).kind, "data");
  assert.equal((await importStore.getMetaValue("pendingDataImport")).phase, "applying");
  await importStore.deleteMetaValue("pendingDataImport");
  assert.equal(await importStore.getMetaValue("pendingDataImport"), null);

  const migrationStore = createStore();
  const migration = await migrationStore.migrateLegacyGlossary([
    {
      id: "legacy-1",
      term: "WorkflowOrchestrator",
      translation: "оркестратор workflow",
      definition: "Координирует шаги.",
      createdAt: 10,
      updatedAt: 20,
    },
    {
      id: "legacy-2",
      term: "workflow orchestrator",
      translation: "оркестратор workflow",
      definition: "Координирует шаги.",
      createdAt: 5,
      updatedAt: 30,
    },
    {
      id: "legacy-3",
      term: "Workflow Orchestrator",
      translation: "отдельное значение",
      definition: "Другой смысл.",
      createdAt: 15,
      updatedAt: 25,
    },
    { id: "broken", term: "", translation: "x", definition: "y" },
  ]);
  assert.equal(migration.migrated, true);
  assert.deepEqual(migration.marker, {
    status: "complete",
    sourceSchemaVersion: 1,
    sourceCount: 4,
    migratedCount: 3,
    skippedCount: 1,
  });
  const migratedState = migrationStore.snapshot();
  assert.equal(migratedState.glossaryConcepts.length, 1);
  assert.equal(migratedState.glossaryConcepts[0].createdAt, 5);
  assert.equal(migratedState.glossaryConcepts[0].updatedAt, 30);
  assert.equal(migratedState.glossarySenses.length, 2);
  assert.equal(migratedState.glossaryLinks.length, 0);
  assert.equal((await migrationStore.migrateLegacyGlossary([])).migrated, false);
  assert.equal(migrationStore.snapshot().glossarySenses.length, 2);

  const rollbackStore = createStore();
  rollbackStore.failNextWrite(new Error("simulated abort"));
  await assert.rejects(
    rollbackStore.migrateLegacyGlossary([{ term: "state", translation: "состояние", definition: "Состояние системы." }]),
    /simulated abort/,
  );
  assert.equal(rollbackStore.snapshot().glossaryConcepts.length, 0);
  assert.equal(rollbackStore.snapshot().meta.find((item) => item.key === "v1GlossaryMigrationState").value, null);
  assert.equal((await rollbackStore.migrateLegacyGlossary([
    { term: "state", translation: "состояние", definition: "Состояние системы." },
  ])).migrated, true);

  const store = createStore();
  const tempScope = "temporary:aaaaaaaa-bbbb-cccc";
  const firstTemp = await store.ensureConversation(temporary("aaaaaaaa-bbbb-cccc"));
  const reusedTemp = await store.ensureConversation(temporary("aaaaaaaa-bbbb-cccc"));
  assert.equal(firstTemp.context.id, reusedTemp.context.id);
  assert.equal(reusedTemp.created, false);

  const stableOne = await store.ensureConversation(stable("one"));
  const stableOneAgain = await store.ensureConversation(stable("one"));
  const stableTwo = await store.ensureConversation(stable("two"));
  assert.equal(stableOne.context.id, stableOneAgain.context.id);
  assert.notEqual(stableOne.context.id, stableTwo.context.id);

  const firstTerms = await store.addAnalysisTerms([
    { term: "state", translation: "состояние", definition: "Состояние workflow." },
    { term: "state", translation: "государство", definition: "Политическое образование." },
  ], tempScope);
  assert.equal(firstTerms.results.length, 2);
  assert.equal(firstTerms.results.every((item) => item.status === "new"), true);
  const exactAttach = await store.addAnalysisTerms([
    { term: "State", translation: "состояние", definition: "Состояние workflow." },
  ], tempScope);
  assert.equal(exactAttach.results[0].status, "alreadySaved");
  assert.equal((await store.queryGlossary({ conversationScope: tempScope, mode: "local", query: "" })).length, 2);
  assert.equal((await store.queryGlossary({ conversationScope: tempScope, mode: "global", query: "" })).length, 0);
  assert.equal((await store.queryGlossary({ conversationScope: tempScope, mode: "global", query: "state" })).length, 2);

  const localBeforeMove = await store.queryGlossary({ conversationScope: tempScope, mode: "local", query: "" });
  await store.moveGlossaryLink(localBeforeMove[1].id, localBeforeMove[0].id, tempScope);
  const localAfterMove = await store.queryGlossary({ conversationScope: tempScope, mode: "local", query: "" });
  assert.deepEqual(localAfterMove.map((item) => item.id), [localBeforeMove[1].id, localBeforeMove[0].id]);

  await store.attachGlossarySense(localAfterMove[0].id, stableOne.context.scopeKey);
  assert.equal((await store.queryGlossary({ conversationScope: stableOne.context.scopeKey, mode: "local", query: "" })).length, 1);
  await store.unlinkGlossary(localAfterMove[0].id, stableOne.context.scopeKey);
  assert.equal((await store.queryGlossary({ conversationScope: stableOne.context.scopeKey, mode: "local", query: "" })).length, 0);
  assert.equal((await store.queryGlossary({ conversationScope: stableOne.context.scopeKey, mode: "global", query: "state" })).length, 2);

  const replacementStore = createStore();
  const replacementOne = await replacementStore.ensureConversation(stable("replacement-one"));
  const replacementTwo = await replacementStore.ensureConversation(stable("replacement-two"));
  const originalReplacement = await replacementStore.addAnalysisTerms([{
    term: "state",
    translation: "состояние",
    definition: "Старое определение.",
  }], replacementOne.context.scopeKey);
  const candidateReplacement = await replacementStore.addAnalysisTerms([{
    term: "State",
    translation: "состояние",
    definition: "Исправленное определение.",
  }], replacementTwo.context.scopeKey);
  assert.equal(candidateReplacement.results[0].status, "duplicate");
  assert.equal(candidateReplacement.results[0].replacementCandidate.status, "single");
  assert.equal(candidateReplacement.results[0].replacementCandidate.targetSenseId, originalReplacement.results[0].id);
  assert.equal(candidateReplacement.results[0].replacementCandidate.newSenseId, candidateReplacement.results[0].id);
  assert.equal(candidateReplacement.results[0].savedEntry.definition, "Старое определение.");
  assert.equal((await replacementStore.addAnalysisTerms([{
    term: "state",
    translation: "состояние",
    definition: "Исправленное определение.",
  }], replacementOne.context.scopeKey)).results[0].status, "alreadySaved");
  await assert.rejects(
    replacementStore.replaceGlossarySense({
      senseId: originalReplacement.results[0].id,
      sourceSenseId: candidateReplacement.results[0].id,
    }),
    /INVALID_GLOSSARY_REPLACEMENT/,
  );
  await assert.rejects(
    replacementStore.replaceGlossarySense({
      senseId: originalReplacement.results[0].id,
      sourceSenseId: candidateReplacement.results[0].id,
      expectedUpdatedAt: "1000",
    }),
    /INVALID_GLOSSARY_REPLACEMENT/,
  );
  const stale = await replacementStore.replaceGlossarySense({
    senseId: originalReplacement.results[0].id,
    sourceSenseId: candidateReplacement.results[0].id,
    expectedUpdatedAt: -1,
  });
  assert.equal(stale.ok, false);
  assert.equal(stale.stale, true);
  assert.equal(replacementStore.snapshot().glossaryLinks.length, 3);
  const replaced = await replacementStore.replaceGlossarySense({
    senseId: originalReplacement.results[0].id,
    sourceSenseId: candidateReplacement.results[0].id,
    expectedUpdatedAt: candidateReplacement.results[0].replacementCandidate.expectedUpdatedAt,
  });
  assert.equal(replaced.ok, true);
  assert.equal(replaced.entry.id, originalReplacement.results[0].id);
  assert.equal(replaced.entry.definition, "Исправленное определение.");
  const replacementState = replacementStore.snapshot();
  assert.equal(replacementState.glossarySenses.length, 1);
  assert.equal(replacementState.glossaryLinks.length, 2);
  assert.equal(new Set(replacementState.glossaryLinks.map((link) => link.conversationId)).size, 2);
  assert.equal(replacementState.glossarySenses.some((sense) => sense.id === candidateReplacement.results[0].id), false);

  const ambiguousStore = createStore();
  const ambiguousConversation = await ambiguousStore.ensureConversation(stable("ambiguous"));
  await ambiguousStore.addAnalysisTerms([{
    term: "route",
    translation: "маршрут",
    definition: "Первое определение.",
  }], ambiguousConversation.context.scopeKey);
  const secondMeaning = await ambiguousStore.addAnalysisTerms([{
    term: "route",
    translation: "маршрут",
    definition: "Второе определение.",
  }], ambiguousConversation.context.scopeKey);
  assert.equal(secondMeaning.results[0].replacementCandidate.status, "single");
  const multipleCandidates = await ambiguousStore.addAnalysisTerms([{
    term: "route",
    translation: "маршрут",
    definition: "Третье определение.",
  }], ambiguousConversation.context.scopeKey);
  assert.equal(multipleCandidates.results[0].status, "new");
  assert.deepEqual(multipleCandidates.results[0].replacementCandidate, { status: "multiple", count: 2 });
  const noCandidate = await ambiguousStore.addAnalysisTerms([{
    term: "route",
    translation: "направлять",
    definition: "Другое значение.",
  }], ambiguousConversation.context.scopeKey);
  assert.equal(noCandidate.results[0].replacementCandidate, undefined);

  const firstSaved = await store.saveSelection("First line\n\nSecond line", tempScope);
  const duplicateSaved = await store.saveSelection("First line  \r\n\r\nSecond line", tempScope);
  assert.equal(firstSaved.item.id, duplicateSaved.item.id);
  assert.equal(duplicateSaved.changed, false);
  assert.equal(firstSaved.item.text, "First line\n\nSecond line");
  const secondSaved = await store.saveSelection("Another item", tempScope);
  assert.equal((await store.querySaved({ conversationScope: tempScope, mode: "local", query: "" })).length, 2);
  assert.equal((await store.querySaved({ conversationScope: tempScope, mode: "global", query: "" })).length, 0);
  assert.equal((await store.querySaved({ conversationScope: tempScope, mode: "global", query: "second" })).length, 1);
  await store.moveSavedLink(secondSaved.item.id, firstSaved.item.id, tempScope);
  assert.deepEqual(
    (await store.querySaved({ conversationScope: tempScope, mode: "local", query: "" })).map((item) => item.id),
    [secondSaved.item.id, firstSaved.item.id],
  );

  await store.addAnalysisTerms([
    { term: "state", translation: "состояние", definition: "Состояние workflow." },
  ], stableOne.context.scopeKey);
  await store.saveSelection("First line\n\nSecond line", stableOne.context.scopeKey);
  const rebound = await store.rebindConversation(tempScope, stable("one"));
  assert.equal(rebound.rebound, true);
  assert.equal(rebound.glossaryLinksMoved, 2);
  assert.equal(rebound.savedLinksMoved, 2);
  assert.equal((await store.rebindConversation(tempScope, stable("one"))).rebound, false);
  const reboundState = store.snapshot();
  assert.equal(reboundState.conversations.some((item) => item.scopeKey === tempScope), false);
  assert.equal(new Set(reboundState.glossaryLinks.map((item) => item.linkKey)).size, reboundState.glossaryLinks.length);
  assert.equal(new Set(reboundState.savedItemLinks.map((item) => item.linkKey)).size, reboundState.savedItemLinks.length);

  const stableOneLocal = await store.queryGlossary({ conversationScope: stableOne.context.scopeKey, mode: "local", query: "" });
  assert.equal(stableOneLocal.length, 2);
  assert.equal((await store.queryGlossary({ conversationScope: stableTwo.context.scopeKey, mode: "local", query: "" })).length, 0);

  const orphanScope = "temporary:orphaned-context";
  await store.ensureConversation(temporary("orphaned-context"));
  const orphanSaved = await store.saveSelection("Orphaned but global", orphanScope);
  const orphaned = await store.orphanConversation(orphanScope);
  assert.equal(orphaned.orphaned, true);
  assert.equal(orphaned.context.orphanedAt > 0, true);
  assert.equal((await store.querySaved({ conversationScope: stableTwo.context.scopeKey, mode: "global", query: "orphaned" }))[0].id, orphanSaved.item.id);
  assert.equal((await store.querySaved({ conversationScope: stableTwo.context.scopeKey, mode: "local", query: "" })).length, 0);

  const savedLocal = await store.querySaved({ conversationScope: stableOne.context.scopeKey, mode: "local", query: "" });
  const anotherSaved = savedLocal.find((item) => item.text === "Another item");
  await store.unlinkSaved(anotherSaved.id, stableOne.context.scopeKey);
  assert.equal((await store.querySaved({ conversationScope: stableOne.context.scopeKey, mode: "global", query: "another" })).length, 1);
  await store.deleteSavedItem(anotherSaved.id);
  assert.equal((await store.querySaved({ conversationScope: stableOne.context.scopeKey, mode: "global", query: "another" })).length, 0);

  const deleteSenseId = stableOneLocal[0].id;
  await store.deleteGlossarySense(deleteSenseId);
  assert.equal((await store.queryGlossary({ conversationScope: stableOne.context.scopeKey, mode: "global", query: "новое" })).length, 0);

  let adapterId = 0;
  let adapterClock = 5000;
  function createProductionAdapter(initialState) {
    const fake = createInstrumentedDatabase(initialState);
    const adapter = new workspaceStore.IndexedDbWorkspaceStore({
      createId(prefix) { adapterId += 1; return `${prefix}-adapter-${adapterId}`; },
      now() { adapterClock += 1; return adapterClock; },
    });
    adapter.databasePromise = Promise.resolve(fake.database);
    return { adapter, fake };
  }
  function conversationRecord(id, scopeKey) {
    return {
      id,
      scopeKey,
      kind: scopeKey.startsWith("temporary:") ? "temporary" : "stable",
      host: "chatgpt.com",
      remoteConversationId: scopeKey.startsWith("stable:") ? scopeKey.split(":").at(-1) : null,
      canonicalUrl: scopeKey.startsWith("stable:") ? `https://chatgpt.com/c/${scopeKey.split(":").at(-1)}` : null,
      createdAt: 1,
      lastSeenAt: 1,
      orphanedAt: null,
    };
  }

  const insertState = workspaceStore.createEmptyState(1);
  insertState.conversations.push(conversationRecord("conversation-local", "stable:chatgpt.com:adapter-local"));
  const insertBoundary = createProductionAdapter(insertState);
  const insertedItem = await insertBoundary.adapter.saveSelection("Targeted adapter item", "stable:chatgpt.com:adapter-local");
  assert.equal(insertedItem.ok, undefined);
  assert.equal(insertedItem.changed, true);
  assert.equal(insertBoundary.fake.instrumentation.calls.some((call) => call.operation === "clear"), false);
  assert.equal(insertBoundary.fake.instrumentation.calls.some((call) => call.operation === "getAll"), false);
  assert.deepEqual(
    [...new Set(insertBoundary.fake.instrumentation.calls
      .filter((call) => ["add", "put", "delete"].includes(call.operation))
      .map((call) => call.store))].sort(),
    ["meta", "savedItemLinks", "savedItems"],
  );

  const moveState = workspaceStore.createEmptyState(1);
  moveState.conversations.push(
    conversationRecord("conversation-move", "stable:chatgpt.com:adapter-move"),
    conversationRecord("conversation-unrelated", "stable:chatgpt.com:adapter-unrelated"),
  );
  moveState.savedItems.push(
    { id: "saved-a", text: "A", normalizedTextKey: "A", createdAt: 1, updatedAt: 1 },
    { id: "saved-b", text: "B", normalizedTextKey: "B", createdAt: 1, updatedAt: 1 },
    { id: "saved-unrelated", text: "U", normalizedTextKey: "U", createdAt: 1, updatedAt: 1 },
  );
  moveState.savedItemLinks.push(
    { id: "link-a", itemId: "saved-a", conversationId: "conversation-move", linkKey: "saved-a\u001fconversation-move", localOrder: 0, firstSeenAt: 1, lastSeenAt: 1 },
    { id: "link-b", itemId: "saved-b", conversationId: "conversation-move", linkKey: "saved-b\u001fconversation-move", localOrder: 1, firstSeenAt: 1, lastSeenAt: 1 },
    { id: "link-unrelated", itemId: "saved-unrelated", conversationId: "conversation-unrelated", linkKey: "saved-unrelated\u001fconversation-unrelated", localOrder: 0, firstSeenAt: 1, lastSeenAt: 1 },
  );
  const moveBoundary = createProductionAdapter(moveState);
  await moveBoundary.adapter.moveSavedLink("saved-b", "saved-a", "stable:chatgpt.com:adapter-move");
  const moveWrites = moveBoundary.fake.instrumentation.calls.filter((call) => ["put", "delete", "add"].includes(call.operation));
  assert.equal(moveWrites.some((call) => call.store === "savedItems" || call.store === "glossaryLinks"), false);
  assert.equal(moveWrites.some((call) => call.key === "link-unrelated"), false);
  assert.deepEqual(
    moveBoundary.fake.snapshot().savedItemLinks
      .filter((link) => link.conversationId === "conversation-move")
      .sort((left, right) => left.localOrder - right.localOrder)
      .map((link) => link.itemId),
    ["saved-b", "saved-a"],
  );

  const completedMigrationState = workspaceStore.createEmptyState(1);
  completedMigrationState.meta.find((item) => item.key === "v1GlossaryMigrationState").value = {
    status: "complete",
    sourceSchemaVersion: 1,
    sourceCount: 0,
    migratedCount: 0,
    skippedCount: 0,
  };
  const migrationBoundary = createProductionAdapter(completedMigrationState);
  assert.deepEqual(await migrationBoundary.adapter.initialize(), { ok: true, changed: false });
  assert.equal((await migrationBoundary.adapter.migrateLegacyGlossary([])).migrated, false);
  assert.deepEqual(migrationBoundary.fake.instrumentation.transactions.map((transaction) => ({
    storeNames: transaction.storeNames,
    mode: transaction.mode,
  })), [
    { storeNames: ["meta"], mode: "readonly" },
    { storeNames: ["meta"], mode: "readonly" },
  ]);
  assert.equal(migrationBoundary.fake.instrumentation.calls.some((call) => ["put", "add", "delete", "clear"].includes(call.operation)), false);

  const queryState = workspaceStore.createEmptyState(1);
  queryState.conversations.push(conversationRecord("conversation-query", "stable:chatgpt.com:adapter-query"));
  queryState.glossaryConcepts.push({ id: "concept-query", displayTerm: "query", canonicalTerm: "query", normalizedKey: "query", createdAt: 1, updatedAt: 1 });
  queryState.glossarySenses.push({ id: "sense-query", conceptId: "concept-query", translation: "запрос", definition: "Описание.", normalizedTranslation: "запрос", normalizedDefinition: "описание.", naturalKey: workspace.createSenseNaturalKey("concept-query", "запрос", "Описание."), createdAt: 1, updatedAt: 1 });
  queryState.glossaryLinks.push({ id: "glossary-link-query", senseId: "sense-query", conversationId: "conversation-query", linkKey: "sense-query\u001fconversation-query", localOrder: 0, firstSeenAt: 1, lastSeenAt: 1 });
  const localQueryBoundary = createProductionAdapter(queryState);
  assert.equal((await localQueryBoundary.adapter.queryGlossary({
    conversationScope: "stable:chatgpt.com:adapter-query",
    mode: "local",
    query: "",
    limit: 2,
  })).length, 1);
  assert.equal(localQueryBoundary.fake.instrumentation.calls.some((call) => call.store === "savedItems" || call.store === "savedItemLinks" || call.store === "importBackups"), false);
  assert.equal(localQueryBoundary.fake.instrumentation.calls.some((call) => call.operation === "getAll"), false);

  const globalQueryState = workspaceStore.createEmptyState(1);
  globalQueryState.conversations.push(conversationRecord("conversation-global", "stable:chatgpt.com:adapter-global"));
  for (let index = 0; index < 6; index += 1) {
    globalQueryState.savedItems.push({
      id: `global-${index}`,
      text: `matching item ${index}`,
      normalizedTextKey: `matching item ${index}`,
      createdAt: index + 1,
      updatedAt: index + 1,
    });
  }
  const globalQueryBoundary = createProductionAdapter(globalQueryState);
  assert.equal((await globalQueryBoundary.adapter.querySaved({
    conversationScope: "stable:chatgpt.com:adapter-global",
    mode: "global",
    query: "matching",
    limit: 2,
  })).length, 2);
  assert.equal(globalQueryBoundary.fake.instrumentation.calls.filter((call) => call.store === "savedItems" && call.operation === "cursor").length, 2);

  const glossaryLimitState = workspaceStore.createEmptyState(1);
  glossaryLimitState.conversations.push(conversationRecord("conversation-glossary-limit", "stable:chatgpt.com:adapter-glossary-limit"));
  for (let index = 0; index < 6; index += 1) {
    const conceptId = `concept-limit-${index}`;
    glossaryLimitState.glossaryConcepts.push({
      id: conceptId,
      displayTerm: `matching term ${index}`,
      canonicalTerm: `matching term ${index}`,
      normalizedKey: `matching term ${index}`,
      createdAt: index + 1,
      updatedAt: index + 1,
    });
    glossaryLimitState.glossarySenses.push({
      id: `sense-limit-${index}`,
      conceptId,
      translation: `перевод ${index}`,
      definition: `Описание ${index}.`,
      normalizedTranslation: `перевод ${index}`,
      normalizedDefinition: `описание ${index}.`,
      naturalKey: workspace.createSenseNaturalKey(conceptId, `перевод ${index}`, `Описание ${index}.`),
      createdAt: index + 1,
      updatedAt: index + 1,
    });
  }
  const glossaryLimitBoundary = createProductionAdapter(glossaryLimitState);
  assert.equal((await glossaryLimitBoundary.adapter.queryGlossary({
    conversationScope: "stable:chatgpt.com:adapter-glossary-limit",
    mode: "global",
    query: "matching",
    limit: 2,
  })).length, 2);
  assert.equal(glossaryLimitBoundary.fake.instrumentation.calls
    .filter((call) => call.store === "glossarySenses" && call.operation === "cursor").length, 2);

  const sparseGlobalState = workspaceStore.createEmptyState(1);
  sparseGlobalState.conversations.push(conversationRecord("conversation-sparse", "stable:chatgpt.com:adapter-sparse"));
  function addSparseGlossary(id, term, updatedAt) {
    const conceptId = `concept-${id}`;
    sparseGlobalState.glossaryConcepts.push({
      id: conceptId,
      displayTerm: term,
      canonicalTerm: term,
      normalizedKey: term,
      createdAt: updatedAt,
      updatedAt,
    });
    sparseGlobalState.glossarySenses.push({
      id: `sense-${id}`,
      conceptId,
      translation: `перевод ${id}`,
      definition: `Описание ${id}.`,
      normalizedTranslation: `перевод ${id}`,
      normalizedDefinition: `описание ${id}.`,
      naturalKey: workspace.createSenseNaturalKey(conceptId, `перевод ${id}`, `Описание ${id}.`),
      createdAt: updatedAt,
      updatedAt,
    });
  }
  for (let index = 0; index < 25; index += 1) {
    addSparseGlossary(`recent-${index}`, `unrelated term ${index}`, 1000 - index);
    sparseGlobalState.savedItems.push({
      id: `saved-recent-${index}`,
      text: `unrelated saved item ${index}`,
      normalizedTextKey: `unrelated saved item ${index}`,
      createdAt: 1000 - index,
      updatedAt: 1000 - index,
    });
  }
  addSparseGlossary("older-match-a", "needle glossary a", 2);
  addSparseGlossary("older-match-b", "needle glossary b", 1);
  addSparseGlossary("oldest-unrelated", "oldest unrelated glossary", 0);
  sparseGlobalState.savedItems.push(
    { id: "saved-older-match-a", text: "needle saved a", normalizedTextKey: "needle saved a", createdAt: 2, updatedAt: 2 },
    { id: "saved-older-match-b", text: "needle saved b", normalizedTextKey: "needle saved b", createdAt: 1, updatedAt: 1 },
    { id: "saved-oldest-unrelated", text: "oldest unrelated saved", normalizedTextKey: "oldest unrelated saved", createdAt: 0, updatedAt: 0 },
  );

  const emptyGlobalBoundary = createProductionAdapter(sparseGlobalState);
  assert.deepEqual(await emptyGlobalBoundary.adapter.queryGlossary({
    conversationScope: "stable:chatgpt.com:adapter-sparse",
    mode: "global",
    query: "   ",
    limit: 2,
  }), []);
  assert.deepEqual(await emptyGlobalBoundary.adapter.querySaved({
    conversationScope: "stable:chatgpt.com:adapter-sparse",
    mode: "global",
    query: "",
    limit: 2,
  }), []);
  assert.equal(emptyGlobalBoundary.fake.instrumentation.calls.some((call) => (
    ["glossarySenses", "savedItems"].includes(call.store) && call.operation === "openCursor"
  )), false);

  const sparseGlobalBoundary = createProductionAdapter(sparseGlobalState);
  const sparseGlossaryResults = await sparseGlobalBoundary.adapter.queryGlossary({
    conversationScope: "stable:chatgpt.com:adapter-sparse",
    mode: "global",
    query: "needle",
    limit: 2,
  });
  const sparseSavedResults = await sparseGlobalBoundary.adapter.querySaved({
    conversationScope: "stable:chatgpt.com:adapter-sparse",
    mode: "global",
    query: "needle",
    limit: 2,
  });
  assert.deepEqual(sparseGlossaryResults.map((item) => item.id), ["sense-older-match-a", "sense-older-match-b"]);
  assert.deepEqual(sparseSavedResults.map((item) => item.id), ["saved-older-match-a", "saved-older-match-b"]);
  assert.equal(sparseGlobalBoundary.fake.instrumentation.calls
    .filter((call) => call.store === "glossarySenses" && call.operation === "cursor").length, 27);
  assert.equal(sparseGlobalBoundary.fake.instrumentation.calls
    .filter((call) => call.store === "savedItems" && call.operation === "cursor").length, 27);

  const rebindState = workspaceStore.createEmptyState(1);
  rebindState.conversations.push(
    conversationRecord("conversation-temp", "temporary:adapter-temp"),
    conversationRecord("conversation-target", "stable:chatgpt.com:adapter-target"),
    conversationRecord("conversation-other", "stable:chatgpt.com:adapter-other"),
  );
  rebindState.glossaryLinks.push(
    { id: "rebind-glossary", senseId: "sense-rebind", conversationId: "conversation-temp", linkKey: "sense-rebind\u001fconversation-temp", localOrder: 1, firstSeenAt: 2, lastSeenAt: 3 },
    { id: "other-glossary", senseId: "sense-other", conversationId: "conversation-other", linkKey: "sense-other\u001fconversation-other", localOrder: 0, firstSeenAt: 1, lastSeenAt: 1 },
  );
  rebindState.savedItemLinks.push(
    { id: "rebind-saved", itemId: "saved-rebind", conversationId: "conversation-temp", linkKey: "saved-rebind\u001fconversation-temp", localOrder: 1, firstSeenAt: 2, lastSeenAt: 3 },
    { id: "other-saved", itemId: "saved-other", conversationId: "conversation-other", linkKey: "saved-other\u001fconversation-other", localOrder: 0, firstSeenAt: 1, lastSeenAt: 1 },
  );
  const rebindBoundary = createProductionAdapter(rebindState);
  const reboundAdapter = await rebindBoundary.adapter.rebindConversation("temporary:adapter-temp", stable("adapter-target"));
  assert.equal(reboundAdapter.rebound, true);
  const rebindWrites = rebindBoundary.fake.instrumentation.calls.filter((call) => ["put", "delete", "add"].includes(call.operation));
  assert.equal(rebindWrites.some((call) => ["other-glossary", "other-saved", "conversation-other"].includes(call.key)), false);
  assert.equal(rebindBoundary.fake.snapshot().conversations.some((conversation) => conversation.id === "conversation-temp"), false);
  assert.equal(rebindBoundary.fake.snapshot().glossaryLinks.find((link) => link.id === "rebind-glossary").conversationId, "conversation-target");
  assert.equal(rebindBoundary.fake.snapshot().savedItemLinks.find((link) => link.id === "rebind-saved").conversationId, "conversation-target");

  const importBoundary = createProductionAdapter(workspaceStore.createEmptyState(1));
  const indexedUserData = Object.fromEntries(workspaceStore.USER_STORE_NAMES.map((name) => [name, []]));
  indexedUserData.savedItems = [{ id: "indexed-import", text: "Indexed import", normalizedTextKey: "indexed import", createdAt: 1, updatedAt: 1 }];
  await importBoundary.adapter.putImportBackup("data", { workspace: indexedUserData, templates: [] });
  assert.equal((await importBoundary.adapter.getImportBackup("data")).kind, "data");
  assert.equal(importBoundary.fake.instrumentation.transactions.some((transaction) => (
    transaction.mode === "readwrite" && transaction.storeNames.length === 1 && transaction.storeNames[0] === "importBackups"
  )), true);
  importBoundary.fake.resetInstrumentation();
  const indexedMerge = await importBoundary.adapter.mergeUserData(indexedUserData);
  assert.equal(indexedMerge.changed, true);
  assert.equal(importBoundary.fake.instrumentation.calls.some((call) => call.operation === "clear"), false);
  assert.equal(importBoundary.fake.snapshot().savedItems.length, 1);
  assert.deepEqual(importBoundary.fake.instrumentation.transactions[0].storeNames, [
    "meta", "conversations", "glossaryConcepts", "glossarySenses", "glossaryLinks", "savedItems", "savedItemLinks",
  ]);
  importBoundary.fake.resetInstrumentation();
  const repeatedIndexedMerge = await importBoundary.adapter.mergeUserData(indexedUserData);
  assert.equal(repeatedIndexedMerge.changed, false);
  assert.equal(importBoundary.fake.instrumentation.calls.some((call) => ["add", "put", "clear", "delete"].includes(call.operation)), false);
  importBoundary.fake.resetInstrumentation();
  const timestampIndexedData = clone(indexedUserData);
  timestampIndexedData.savedItems[0].updatedAt = 2;
  const timestampIndexedMerge = await importBoundary.adapter.mergeUserData(timestampIndexedData);
  assert.equal(timestampIndexedMerge.changed, true);
  assert.deepEqual(
    importBoundary.fake.instrumentation.calls.filter((call) => ["add", "put", "clear", "delete"].includes(call.operation))
      .map((call) => [call.operation, call.store, call.key]),
    [["put", "savedItems", "indexed-import"], ["put", "meta", "revision:all"]],
  );
  importBoundary.fake.resetInstrumentation();
  const replacementUserData = Object.fromEntries(workspaceStore.USER_STORE_NAMES.map((name) => [name, []]));
  replacementUserData.savedItems = [{ id: "indexed-replace", text: "Indexed replace", normalizedTextKey: "indexed replace", createdAt: 2, updatedAt: 2 }];
  await importBoundary.adapter.replaceUserData(replacementUserData);
  assert.equal(importBoundary.fake.instrumentation.calls.filter((call) => call.operation === "clear").length, 6);
  assert.equal(importBoundary.fake.instrumentation.calls.some((call) => call.store === "importBackups"), false);
  assert.deepEqual(importBoundary.fake.snapshot().savedItems.map((item) => item.id), ["indexed-replace"]);
}

runStoreTests()
  .then(() => console.log("workspace logic ok"))
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
