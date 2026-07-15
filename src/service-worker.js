/* global chrome */
const TOGGLE_MESSAGE = "chatgpt-templates:toggle-panel";
const VALID_THEMES = new Set(["system", "graphite", "navy", "violet", "gold"]);

function createStableId() {
  if (typeof crypto?.randomUUID === "function") return crypto.randomUUID();
  return `template-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function normalizeTemplates(value) {
  if (!Array.isArray(value)) return [];

  const usedIds = new Set();
  return value.flatMap((template) => {
    if (!template || typeof template !== "object") return [];

    const name = typeof template.name === "string" ? template.name : "";
    const content = typeof template.content === "string" ? template.content : "";
    if (!name.trim() || !content.trim()) return [];

    let id = typeof template.id === "string" && template.id.trim() ? template.id : createStableId();
    if (usedIds.has(id)) id = createStableId();
    usedIds.add(id);

    return [{
      ...template,
      id,
      name,
      content,
      autoSend: template.autoSend === true,
    }];
  });
}

function normalizeSettings(value) {
  const settings = value && typeof value === "object" ? value : {};
  return {
    ...settings,
    theme: VALID_THEMES.has(settings.theme) ? settings.theme : "system",
    wallpaperDataUrl: typeof settings.wallpaperDataUrl === "string" && settings.wallpaperDataUrl.startsWith("data:image/")
      ? settings.wallpaperDataUrl
      : null,
    closePanelAfterRun: settings.closePanelAfterRun !== false,
    recentTemplatesHoverEnabled: settings.recentTemplatesHoverEnabled !== false,
  };
}

function normalizeRecentTemplateIds(value) {
  if (!Array.isArray(value)) return [];
  const result = [];
  for (const item of value) {
    if (typeof item !== "string") continue;
    const id = item.trim();
    if (!id || result.includes(id)) continue;
    result.push(id);
    if (result.length === 3) break;
  }
  return result;
}

async function migrateStorage() {
  const stored = await chrome.storage.local.get(["templates", "settings", "selectedTemplate", "recentTemplateIds"]);
  await chrome.storage.local.set({
    templates: normalizeTemplates(stored.templates),
    settings: normalizeSettings(stored.settings),
    recentTemplateIds: normalizeRecentTemplateIds(stored.recentTemplateIds),
  });
  await chrome.storage.local.remove("selectedTemplate");
}

chrome.runtime.onInstalled.addListener(() => {
  void migrateStorage().catch((error) => {
    console.warn("ChatGPT Templates storage migration failed.", error);
  });
});

chrome.action.onClicked.addListener((tab) => {
  if (!tab.id) return;
  void chrome.tabs.sendMessage(tab.id, { type: TOGGLE_MESSAGE }).catch(() => {
    // Unsupported pages do not have the content script; the action is a safe no-op there.
  });
});
