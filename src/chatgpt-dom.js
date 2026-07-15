(function initChatGptTemplateDom() {
  "use strict";

  if (window.ChatGPTTemplateDom?.version === 1) return;

  function visible(element) {
    if (!element?.isConnected) return false;
    const style = window.getComputedStyle(element);
    const rect = element.getBoundingClientRect();
    return style.display !== "none" && style.visibility !== "hidden" && (rect.width > 0 || rect.height > 0);
  }

  function findComposer() {
    const selectors = [
      "#prompt-textarea",
      '[data-testid="composer-text-input"]',
      "textarea",
      'div.ProseMirror[contenteditable="true"]',
      '[contenteditable="true"][role="textbox"]',
    ];

    for (const selector of selectors) {
      const composer = Array.from(document.querySelectorAll(selector)).find(visible);
      if (composer) return composer;
    }
    return null;
  }

  function readComposerText(composer = findComposer()) {
    if (!composer) return "";
    return composer.tagName === "TEXTAREA" ? composer.value : composer.innerText || composer.textContent || "";
  }

  function containsMeaningfulText(text) {
    return String(text || "").replace(/[\u200B-\u200D\uFEFF]/g, "").trim().length > 0;
  }

  function comparableText(text) {
    return String(text || "")
      .replace(/\r\n?/g, "\n")
      .replace(/\u00A0/g, " ")
      .replace(/[\u200B-\u200D\uFEFF]/g, "")
      .replace(/\n+/g, "\n")
      .replace(/^\n|\n$/g, "");
  }

  function setTextareaValue(textarea, text) {
    const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value")?.set;
    if (setter) setter.call(textarea, text);
    else textarea.value = text;
    textarea.dispatchEvent(new Event("input", { bubbles: true }));
  }

  function setEditableValue(editor, text) {
    editor.focus();
    const selection = window.getSelection();
    const range = document.createRange();
    range.selectNodeContents(editor);
    selection.removeAllRanges();
    selection.addRange(range);

    let inserted = false;
    try {
      inserted = document.execCommand("insertText", false, text);
    } catch (_) {}
    if (!inserted) editor.textContent = text;

    try {
      editor.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: text }));
    } catch (_) {
      editor.dispatchEvent(new Event("input", { bubbles: true }));
    }
  }

  function insertComposerText(composer, text) {
    if (composer.tagName === "TEXTAREA") setTextareaValue(composer, text);
    else setEditableValue(composer, text);
  }

  function findSendButton(composer) {
    const root = composer.closest("form") || composer.parentElement || document;
    const selectors = [
      'button[data-testid="send-button"]',
      'button[aria-label*="Send"]',
      'button[aria-label*="Отправ"]',
      'button[type="submit"]',
    ];
    return Array.from(root.querySelectorAll(selectors.join(",")))
      .find((button) => {
        const label = `${button.getAttribute("aria-label") || ""} ${button.textContent || ""} ${button.dataset.testid || ""}`.toLowerCase();
        const excluded = /stop|останов|voice|mic|голос|микрофон|attach|upload|скреп/.test(label);
        return visible(button) && !excluded && !button.disabled && button.getAttribute("aria-disabled") !== "true";
      }) || null;
  }

  function wait(milliseconds) {
    return new Promise((resolve) => setTimeout(resolve, milliseconds));
  }

  async function confirmComposerText(composer, expectedText) {
    const expected = comparableText(expectedText);
    for (let attempt = 0; attempt < 16; attempt += 1) {
      const currentComposer = composer.isConnected ? composer : findComposer();
      if (currentComposer && comparableText(readComposerText(currentComposer)) === expected) {
        return true;
      }
      await wait(50);
    }
    return false;
  }

  async function waitForSendButton(composer) {
    for (let attempt = 0; attempt < 30; attempt += 1) {
      const button = findSendButton(composer);
      if (button) return button;
      await wait(100);
    }
    return null;
  }

  async function confirmMessageSent() {
    for (let attempt = 0; attempt < 30; attempt += 1) {
      if (!containsMeaningfulText(readComposerText())) return true;
      await wait(100);
    }
    return false;
  }

  function readComposer() {
    try {
      const composer = findComposer();
      if (!composer) return { ok: false, error: "Поле ввода ChatGPT не найдено." };
      const text = readComposerText(composer);
      return { ok: true, empty: !containsMeaningfulText(text), text };
    } catch (error) {
      return { ok: false, error: error?.message || "Не удалось прочитать поле ввода ChatGPT." };
    }
  }

  async function insertTemplateText(text) {
    try {
      const template = String(text ?? "");
      if (!template.trim()) return { ok: false, error: "Пустой шаблон нельзя вставить." };

      const composer = findComposer();
      if (!composer) return { ok: false, error: "Поле ввода ChatGPT не найдено." };

      const existingText = readComposerText(composer);
      const nextText = containsMeaningfulText(existingText)
        ? `${existingText}\n\n${template}`
        : template;
      insertComposerText(composer, nextText);
      if (!await confirmComposerText(composer, nextText)) {
        return { ok: false, error: "Не удалось вставить шаблон в поле ввода." };
      }
      return { ok: true, text: nextText, appended: containsMeaningfulText(existingText) };
    } catch (error) {
      return { ok: false, error: error?.message || "Не удалось вставить шаблон." };
    }
  }

  async function sendCurrentComposer() {
    try {
      const composer = findComposer();
      if (!composer) return { ok: false, error: "Поле ввода ChatGPT не найдено." };
      if (!containsMeaningfulText(readComposerText(composer))) {
        return { ok: false, error: "Поле ввода ChatGPT пусто." };
      }

      const sendButton = await waitForSendButton(composer);
      if (!sendButton) return { ok: false, error: "Кнопка отправки ChatGPT не найдена." };

      sendButton.click();
      if (await confirmMessageSent()) return { ok: true };
      return { ok: false, error: "Отправка не подтверждена ChatGPT." };
    } catch (error) {
      return { ok: false, error: error?.message || "Не удалось отправить сообщение." };
    }
  }

  async function executeTemplate(text, autoSend = false) {
    const insertion = await insertTemplateText(text);
    if (!insertion.ok || !autoSend) return insertion;
    const sent = await sendCurrentComposer();
    return sent.ok ? { ...insertion, sent: true } : sent;
  }

  async function executeNextQuickAction() {
    try {
      const state = readComposer();
      if (!state.ok) return state;
      if (!state.empty) return { ok: true, noop: true };

      const insertion = await insertTemplateText("Далее");
      if (!insertion.ok) return insertion;
      const sent = await sendCurrentComposer();
      return sent.ok ? { ok: true, sent: true } : sent;
    } catch (error) {
      return { ok: false, error: error?.message || "Не удалось выполнить быстрое действие." };
    }
  }

  window.ChatGPTTemplateDom = {
    version: 1,
    readComposer,
    insertTemplateText,
    sendCurrentComposer,
    executeTemplate,
    executeNextQuickAction,
  };
})();
