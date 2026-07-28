(function initCommandRegistry(root) {
  "use strict";

  if (root.ChatGPTHelperCommandRegistry) return;

  const TEXT_ENTRY_SELECTOR = "input, textarea, select, [contenteditable='true'], [contenteditable=''], [role='textbox']";
  const CONTENT_MESSAGE_TYPES = Object.freeze({
    ANALYZE: "RUN_ANALYSIS_COMMAND",
    TRANSLATE: "RUN_TRANSLATE_SELECTION_COMMAND",
    SAVE: "RUN_SAVE_SELECTION_COMMAND",
    NORMALIZE: "RUN_NORMALIZE_COMPOSER_COMMAND",
  });

  const COMMANDS = Object.freeze({
    analyzeSelection: Object.freeze({
      id: "analyze-selection",
      description: "Анализировать выделенный текст",
      allowedContext: "pageSelection",
      contextMenuId: "chatgpt-helper-analyze-selection",
      messageType: CONTENT_MESSAGE_TYPES.ANALYZE,
      handlerId: "runAnalysis",
    }),
    translateSelection: Object.freeze({
      id: "translate-selection",
      description: "Перевести выделенный текст",
      allowedContext: "pageSelection",
      contextMenuId: "chatgpt-helper-translate-selection",
      messageType: CONTENT_MESSAGE_TYPES.TRANSLATE,
      handlerId: "runTranslation",
    }),
    saveSelection: Object.freeze({
      id: "save-selection",
      description: "Сохранить выделенный текст",
      allowedContext: "pageSelection",
      contextMenuId: "chatgpt-helper-save-selection",
      messageType: CONTENT_MESSAGE_TYPES.SAVE,
      handlerId: "runSaveSelection",
    }),
    normalizeComposer: Object.freeze({
      id: "normalize-composer",
      description: "Нормализовать пустые строки в поле ввода",
      allowedContext: "composer",
      contextMenuId: "chatgpt-helper-normalize-composer",
      messageType: CONTENT_MESSAGE_TYPES.NORMALIZE,
      handlerId: "runNormalizeComposer",
    }),
  });

  const COMMAND_BY_ID = Object.freeze(Object.fromEntries(
    Object.values(COMMANDS).map((command) => [command.id, command]),
  ));
  const COMMAND_BY_MESSAGE = Object.freeze(Object.fromEntries(
    Object.values(COMMANDS).map((command) => [command.messageType, command]),
  ));

  function isTextEntryTarget(target) {
    if (!target || typeof target.closest !== "function") return false;
    try {
      return Boolean(target.closest(TEXT_ENTRY_SELECTOR));
    } catch (_) {
      return false;
    }
  }

  function selectionEligible(value) {
    const context = value || {};
    return context.supportedPage === true
      && context.isEditable !== true
      && typeof context.selectionText === "string"
      && Boolean(context.selectionText.trim());
  }

  function composerEligible(value) {
    const context = value || {};
    return context.supportedPage === true && context.isComposer === true;
  }

  function eligible(commandValue, context) {
    const command = typeof commandValue === "string"
      ? (COMMAND_BY_ID[commandValue] || COMMAND_BY_MESSAGE[commandValue])
      : commandValue;
    if (!command) return false;
    return command.allowedContext === "composer" ? composerEligible(context) : selectionEligible(context);
  }

  const api = Object.freeze({
    TEXT_ENTRY_SELECTOR,
    CONTENT_MESSAGE_TYPES,
    COMMANDS,
    COMMAND_BY_ID,
    COMMAND_BY_MESSAGE,
    isTextEntryTarget,
    selectionEligible,
    composerEligible,
    eligible,
  });

  root.ChatGPTHelperCommandRegistry = api;
  if (typeof module === "object" && module.exports) module.exports = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
