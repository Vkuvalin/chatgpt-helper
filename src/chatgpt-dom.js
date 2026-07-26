(function initChatGptTemplateDom() {
  "use strict";

  if (window.ChatGPTTemplateDom?.version === 6) return;

  const workspaceContract = window.ChatGPTHelperWorkspaceContract;
  const normalizingComposers = new WeakSet();
  const writingComposers = new WeakSet();

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

  const EDITABLE_BLOCK_TAGS = new Set([
    "ADDRESS", "ARTICLE", "ASIDE", "BLOCKQUOTE", "DIV", "FOOTER", "H1", "H2", "H3", "H4", "H5", "H6",
    "HEADER", "LI", "MAIN", "NAV", "OL", "P", "PRE", "SECTION", "UL",
  ]);

  function editableIsBlock(node) {
    return node?.nodeType === 1 && EDITABLE_BLOCK_TAGS.has(String(node.tagName || "").toUpperCase());
  }

  function editableIsBreak(node) {
    return node?.nodeType === 1 && String(node.tagName || "").toUpperCase() === "BR";
  }

  function editableIsPlaceholderLine(node) {
    const children = Array.from(node?.childNodes || []);
    return children.length === 1 && editableIsBreak(children[0]);
  }

  function editableBoundaryBetween(left, right) {
    return editableIsBlock(left) || editableIsBlock(right);
  }

  function editableNodeText(node) {
    if (!node) return "";
    if (node.nodeType === 3) return String(node.data ?? node.textContent ?? "");
    if (editableIsBreak(node)) return "\n";
    if (editableIsPlaceholderLine(node)) return "";
    return editableChildrenText(node);
  }

  function editableChildrenText(container) {
    const children = Array.from(container?.childNodes || []);
    let text = "";
    children.forEach((child, index) => {
      if (index > 0 && editableBoundaryBetween(children[index - 1], child)) text += "\n";
      text += editableNodeText(child);
    });
    return text;
  }

  function readEditableText(editor) {
    return editableIsPlaceholderLine(editor) ? "" : editableChildrenText(editor);
  }

  function readComposerText(composer = findComposer()) {
    if (!composer) return "";
    return composer.tagName === "TEXTAREA" ? composer.value : readEditableText(composer);
  }

  const SELECTION_PARAGRAPH_TAGS = new Set([
    "BLOCKQUOTE", "H1", "H2", "H3", "H4", "H5", "H6", "P", "PRE",
  ]);
  const SELECTION_LINE_BLOCK_TAGS = new Set([
    "ADDRESS", "ARTICLE", "ASIDE", "DIV", "FOOTER", "HEADER", "MAIN", "NAV", "SECTION",
  ]);
  const SELECTION_TABLE_CONTAINER_TAGS = new Set([
    "TABLE", "TBODY", "TFOOT", "THEAD", "TR",
  ]);
  const SELECTION_TABLE_CELL_TAGS = new Set(["TD", "TH"]);

  function selectionTag(node) {
    return node?.nodeType === 1 ? String(node.tagName || "").toUpperCase() : "";
  }

  function selectionIsList(node) {
    return ["OL", "UL"].includes(selectionTag(node));
  }

  function selectionIsPlaceholderBlock(node) {
    const children = Array.from(node?.childNodes || []);
    return children.length === 1 && selectionTag(children[0]) === "BR";
  }

  function selectionClosest(node, tagName) {
    let current = node?.nodeType === 1 ? node : node?.parentNode;
    while (current) {
      if (selectionTag(current) === tagName) return current;
      current = current.parentNode;
    }
    return null;
  }

  function selectionFirstDescendant(node, tagName) {
    for (const child of Array.from(node?.childNodes || [])) {
      if (selectionTag(child) === tagName) return child;
      const nested = selectionFirstDescendant(child, tagName);
      if (nested) return nested;
    }
    return null;
  }

  function annotateClonedOrderedList(range, fragment) {
    const sourceList = selectionClosest(range?.startContainer, "OL");
    const sourceItem = selectionClosest(range?.startContainer, "LI");
    const clonedList = selectionFirstDescendant(fragment, "OL");
    if (!sourceList || !sourceItem || !clonedList || sourceItem.parentNode !== sourceList) return;
    const startValue = Number.parseInt(sourceList.getAttribute?.("start"), 10);
    let ordinal = Number.isInteger(startValue) ? startValue : 1;
    for (const item of Array.from(sourceList.childNodes || []).filter((child) => selectionTag(child) === "LI")) {
      const explicitValue = Number.parseInt(item.getAttribute?.("value"), 10);
      if (Number.isInteger(explicitValue)) ordinal = explicitValue;
      if (item === sourceItem) {
        clonedList.setAttribute?.("start", String(ordinal));
        return;
      }
      ordinal += 1;
    }
  }

  function structuredSelectionText(fragment) {
    let output = "";

    function ensureNewlines(count) {
      if (!output) return;
      const match = /\n*$/.exec(output);
      const present = match ? match[0].length : 0;
      if (present < count) output += "\n".repeat(count - present);
    }

    function appendText(value) {
      output += String(value ?? "")
        .replace(/\r\n?/g, "\n")
        .replace(/\u00a0/g, " ")
        .replace(/[\u200B-\u200D\u2060\uFEFF]/g, "");
    }

    function walkChildren(container) {
      Array.from(container?.childNodes || []).forEach(walk);
    }

    function walkList(list, depth) {
      const ordered = selectionTag(list) === "OL";
      const startValue = Number.parseInt(list.getAttribute?.("start"), 10);
      let ordinal = Number.isInteger(startValue) ? startValue : 1;
      const items = Array.from(list?.childNodes || []).filter((child) => selectionTag(child) === "LI");
      items.forEach((item) => {
        ensureNewlines(output ? 1 : 0);
        const explicitValue = Number.parseInt(item.getAttribute?.("value"), 10);
        const markerValue = Number.isInteger(explicitValue) ? explicitValue : ordinal;
        appendText(`${"  ".repeat(depth)}${ordered ? `${markerValue}.` : "•"} `);
        let directBlockSeen = false;
        const nestedLists = [];
        Array.from(item.childNodes || []).forEach((child) => {
          if (selectionIsList(child)) {
            nestedLists.push(child);
            return;
          }
          const tag = selectionTag(child);
          if (SELECTION_PARAGRAPH_TAGS.has(tag) || SELECTION_LINE_BLOCK_TAGS.has(tag)) {
            if (directBlockSeen) ensureNewlines(1);
            if (selectionIsPlaceholderBlock(child)) ensureNewlines(1);
            else walkChildren(child);
            directBlockSeen = true;
            return;
          }
          walk(child);
        });
        ordinal = markerValue + 1;
        nestedLists.forEach((nested) => {
          ensureNewlines(1);
          walkList(nested, depth + 1);
        });
        ensureNewlines(1);
      });
    }

    function walk(node) {
      if (!node) return;
      if (node.nodeType === 3) {
        appendText(node.data ?? node.textContent ?? "");
        return;
      }
      const tag = selectionTag(node);
      if (tag === "BR") {
        ensureNewlines(1);
        return;
      }
      if (tag === "OL" || tag === "UL") {
        walkList(node, 0);
        return;
      }
      if (tag === "LI") {
        walkList({ tagName: "UL", childNodes: [node], getAttribute() { return null; } }, 0);
        return;
      }
      if (tag === "PRE") {
        ensureNewlines(output ? 2 : 0);
        appendText(node.textContent || "");
        ensureNewlines(2);
        return;
      }
      if (SELECTION_TABLE_CELL_TAGS.has(tag)) {
        ensureNewlines(output ? 1 : 0);
        walkChildren(node);
        ensureNewlines(1);
        return;
      }
      if (SELECTION_TABLE_CONTAINER_TAGS.has(tag)) {
        ensureNewlines(output ? 1 : 0);
        walkChildren(node);
        ensureNewlines(1);
        return;
      }
      if (SELECTION_PARAGRAPH_TAGS.has(tag)) {
        ensureNewlines(output ? 2 : 0);
        if (selectionIsPlaceholderBlock(node)) ensureNewlines(2);
        else walkChildren(node);
        ensureNewlines(2);
        return;
      }
      if (SELECTION_LINE_BLOCK_TAGS.has(tag)) {
        if (selectionIsPlaceholderBlock(node)) {
          ensureNewlines(output ? 2 : 0);
          return;
        }
        ensureNewlines(output ? 1 : 0);
        walkChildren(node);
        ensureNewlines(1);
        return;
      }
      walkChildren(node);
    }

    walkChildren(fragment);
    return output.replace(/^\n+|\n+$/g, "");
  }

  function comparableSelectionText(value) {
    return adaptLineEndings(value)
      .replace(/^[\t ]*(?:•|[-*]|\d+[.)])[\t ]+/gm, "")
      .replace(/[\u200B-\u200D\u2060\uFEFF]/g, "")
      .replace(/\s+/g, " ")
      .trim();
  }

  function readSelectionText(fallbackValue, selectionValue) {
    const fallback = workspaceContract?.normalizeSelectedPlainText
      ? workspaceContract.normalizeSelectedPlainText(fallbackValue)
      : adaptLineEndings(fallbackValue);
    try {
      const selection = selectionValue || window.getSelection?.();
      if (!selection?.rangeCount) return fallback;
      const parts = [];
      for (let index = 0; index < selection.rangeCount; index += 1) {
        const range = selection.getRangeAt(index);
        const fragment = range?.cloneContents?.();
        if (fragment) annotateClonedOrderedList(range, fragment);
        const text = fragment ? structuredSelectionText(fragment) : adaptLineEndings(range?.toString?.() || "");
        if (containsMeaningfulText(text)) parts.push(text);
      }
      const structured = parts.join("\n");
      if (!containsMeaningfulText(structured)) return fallback;
      if (containsMeaningfulText(fallback)
        && comparableSelectionText(structured) !== comparableSelectionText(fallback)) return fallback;
      return structured;
    } catch (_) {
      return fallback;
    }
  }

  function inlineSelectionFailure(reason) {
    return Object.freeze({ ok: false, reason });
  }

  function inlineElement(node) {
    if (node?.nodeType === 1) return node;
    return node?.parentElement || node?.parentNode || null;
  }

  function inlineParentElement(node) {
    if (!node) return null;
    if (node.parentElement) return node.parentElement;
    const rootNode = node.getRootNode?.();
    return rootNode?.host || null;
  }

  function inlineEditableElement(node) {
    let current = inlineElement(node);
    while (current) {
      const tagName = String(current.tagName || "").toUpperCase();
      const contentEditable = current.getAttribute?.("contenteditable");
      const normalizedContentEditable = typeof contentEditable === "string"
        ? contentEditable.toLocaleLowerCase("en-US")
        : null;
      if (["INPUT", "TEXTAREA", "SELECT"].includes(tagName)
        || current.isContentEditable === true
        || normalizedContentEditable === "" || normalizedContentEditable === "true"
        || normalizedContentEditable === "plaintext-only"
        || current.getAttribute?.("role") === "textbox") return current;
      current = inlineParentElement(current);
    }
    return null;
  }

  function inlineExtensionElement(node, extensionRoot) {
    if (extensionRoot?.contains?.(node)) return extensionRoot;
    let current = inlineElement(node);
    while (current) {
      if (current === extensionRoot
        || current.id === "chatgpt-helper-overlay-root"
        || current.getAttribute?.("data-chatgpt-templates-overlay") !== null) return current;
      current = inlineParentElement(current);
    }
    return null;
  }

  function inlineSupportedPage(pageUrl) {
    try {
      return workspaceContract?.isSupportedHost?.(new URL(pageUrl, window.location?.href).hostname) === true;
    } catch (_) {
      return false;
    }
  }

  function inlineVisibleRect(rect, viewportWidth, viewportHeight) {
    if (!rect) return false;
    const values = [rect.top, rect.right, rect.bottom, rect.left, rect.width, rect.height];
    if (!values.every(Number.isFinite) || rect.width <= 0 || rect.height <= 0) return false;
    return rect.right > 0 && rect.bottom > 0 && rect.left < viewportWidth && rect.top < viewportHeight;
  }

  function captureInlineGlossarySelection(options) {
    const pageUrl = String(options?.pageUrl || window.location?.href || "");
    if (!inlineSupportedPage(pageUrl)) return inlineSelectionFailure("empty");
    const selection = options?.selection || window.getSelection?.();
    if (!selection || selection.rangeCount === 0) return inlineSelectionFailure("empty");
    if (selection.rangeCount !== 1) return inlineSelectionFailure("multiple-ranges");
    const range = selection.getRangeAt?.(0);
    if (!range || selection.isCollapsed === true || range.collapsed === true) {
      return inlineSelectionFailure("empty");
    }

    const anchorNode = inlineElement(range.commonAncestorContainer);
    if (!anchorNode?.isConnected) return inlineSelectionFailure("disconnected");
    if (inlineEditableElement(anchorNode)
      || inlineEditableElement(range.startContainer)
      || inlineEditableElement(range.endContainer)) return inlineSelectionFailure("editable");
    if (inlineExtensionElement(anchorNode, options?.extensionRoot)
      || inlineExtensionElement(range.startContainer, options?.extensionRoot)
      || inlineExtensionElement(range.endContainer, options?.extensionRoot)) {
      return inlineSelectionFailure("extension-ui");
    }

    const rawText = String(selection.toString?.() || range.toString?.() || "");
    const sourceText = readSelectionText(rawText, selection);
    const validated = workspaceContract?.validateInlineSelectionText?.(sourceText);
    if (!validated?.ok) {
      return inlineSelectionFailure(validated?.error || "empty");
    }
    if (!/[A-Za-z]/.test(validated.text)) return inlineSelectionFailure("no-latin");

    const viewportWidth = Number.isFinite(options?.viewportWidth)
      ? options.viewportWidth
      : Number(window.innerWidth);
    const viewportHeight = Number.isFinite(options?.viewportHeight)
      ? options.viewportHeight
      : Number(window.innerHeight);
    const visibleRects = Array.from(range.getClientRects?.() || [])
      .filter((rect) => inlineVisibleRect(rect, viewportWidth, viewportHeight));
    const rect = visibleRects.at(-1);
    if (!rect) return inlineSelectionFailure("no-geometry");

    return Object.freeze({
      ok: true,
      text: sourceText,
      anchorRect: Object.freeze({
        top: rect.top,
        right: rect.right,
        bottom: rect.bottom,
        left: rect.left,
        width: rect.width,
        height: rect.height,
      }),
      anchorNode,
      pageUrl,
    });
  }

  function normalizeComposerPlainText(value) {
    if (workspaceContract?.normalizeComposerPlainText) return workspaceContract.normalizeComposerPlainText(value);
    if (workspaceContract?.normalizeComposerText) return workspaceContract.normalizeComposerText(value);
    const text = String(value ?? "");
    return { text, changed: false, edits: [] };
  }

  const normalizeComposerText = normalizeComposerPlainText;

  function adaptLineEndings(value) {
    return String(value ?? "").replace(/\r\n?/g, "\n");
  }

  function containsMeaningfulText(text) {
    return String(text || "").replace(/[\u200B-\u200D\uFEFF]/g, "").trim().length > 0;
  }

  function comparableText(text) {
    return adaptLineEndings(text);
  }

  function setTextareaValue(textarea, text) {
    const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value")?.set;
    if (setter) setter.call(textarea, text);
    else textarea.value = text;
  }

  function setEditableValue(editor, text) {
    const fragment = document.createDocumentFragment();
    adaptLineEndings(text).split("\n").forEach((line) => {
      const block = document.createElement("p");
      if (line) block.appendChild(document.createTextNode(line));
      else block.appendChild(document.createElement("br"));
      fragment.appendChild(block);
    });
    editor.replaceChildren(fragment);
  }

  function dispatchComposerInput(editor, text) {
    try {
      editor.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: text }));
      return true;
    } catch (_) {
      try {
        editor.dispatchEvent(new Event("input", { bubbles: true }));
        return true;
      } catch (_) {
        return false;
      }
    }
  }

  function editablePointOffsetWithin(root, container, offset) {
    if (!root || !container) return null;
    if (root === container) {
      if (root.nodeType === 3) {
        return Math.max(0, Math.min(String(root.data ?? root.textContent ?? "").length, Number(offset) || 0));
      }
      if (editableIsBreak(root) || editableIsPlaceholderLine(root)) return 0;
      const children = Array.from(root.childNodes || []);
      const count = Math.max(0, Math.min(children.length, Number(offset) || 0));
      let total = 0;
      for (let index = 0; index < count; index += 1) {
        if (index > 0 && editableBoundaryBetween(children[index - 1], children[index])) total += 1;
        total += editableNodeText(children[index]).length;
      }
      if (count > 0 && count < children.length
        && editableBoundaryBetween(children[count - 1], children[count])) total += 1;
      return total;
    }

    let child = container;
    while (child && child.parentNode && child.parentNode !== root) child = child.parentNode;
    if (!child || child.parentNode !== root) return null;
    const children = Array.from(root.childNodes || []);
    const index = children.indexOf(child);
    if (index < 0) return null;
    const before = editablePointOffsetWithin(root, root, index);
    const within = editablePointOffsetWithin(child, container, offset);
    return Number.isInteger(before) && Number.isInteger(within) ? before + within : null;
  }

  function editablePointOffset(editor, container, offset) {
    const value = editablePointOffsetWithin(editor, container, offset);
    if (!Number.isInteger(value)) return null;
    return Math.max(0, Math.min(readEditableText(editor).length, value));
  }

  function editableSelectionOffsets(editor) {
    const selection = window.getSelection?.();
    if (!selection?.rangeCount) return null;
    const range = selection.getRangeAt(0);
    if (!editor.contains(range.startContainer) || !editor.contains(range.endContainer)) return null;
    const start = editablePointOffset(editor, range.startContainer, range.startOffset);
    const end = editablePointOffset(editor, range.endContainer, range.endOffset);
    if (!Number.isInteger(start) || !Number.isInteger(end)) return null;
    return start <= end ? { start, end } : { start: end, end: start };
  }

  function editablePointForOffset(editor, offsetValue, text) {
    const lines = adaptLineEndings(text).split("\n");
    const maximum = lines.join("\n").length;
    let offset = Math.max(0, Math.min(maximum, Number(offsetValue) || 0));
    let lineIndex = 0;
    while (lineIndex < lines.length - 1 && offset > lines[lineIndex].length) {
      offset -= lines[lineIndex].length + 1;
      lineIndex += 1;
    }
    const line = editor.childNodes?.[lineIndex] || editor;
    const walker = document.createTreeWalker(line, NodeFilter.SHOW_TEXT);
    let node = walker.nextNode();
    let remaining = Math.min(offset, lines[lineIndex]?.length || 0);
    while (node) {
      if (remaining <= node.data.length) return { node, offset: remaining };
      remaining -= node.data.length;
      node = walker.nextNode();
    }
    return { node: line, offset: 0 };
  }

  function setEditableSelection(editor, startOffset, endOffset, text) {
    const range = document.createRange();
    const start = editablePointForOffset(editor, startOffset, text);
    const end = editablePointForOffset(editor, endOffset, text);
    try {
      range.setStart(start.node, start.offset);
      range.setEnd(end.node, end.offset);
      const selection = window.getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
    } catch (_) {}
  }

  function replaceComposerText(text, selectionValue) {
    const composer = findComposer();
    if (!composer) return { ok: false, error: "Поле ввода ChatGPT не найдено." };
    if (writingComposers.has(composer)) return { ok: false, busy: true, error: "Поле ввода уже обновляется." };
    const nextText = adaptLineEndings(text);
    const currentText = adaptLineEndings(readComposerText(composer));
    const selection = selectionValue || (composer.tagName === "TEXTAREA"
      ? {
        start: Number.isInteger(composer.selectionStart) ? composer.selectionStart : currentText.length,
        end: Number.isInteger(composer.selectionEnd) ? composer.selectionEnd : currentText.length,
      }
      : editableSelectionOffsets(composer) || { start: currentText.length, end: currentText.length });
    const start = Math.max(0, Math.min(nextText.length, Number(selection.start) || 0));
    const end = Math.max(start, Math.min(nextText.length, Number(selection.end) || 0));
    if (currentText === nextText) return { ok: true, changed: false, text: nextText, selection: { start, end } };

    writingComposers.add(composer);
    try {
      composer.focus?.();
      if (composer.tagName === "TEXTAREA") setTextareaValue(composer, nextText);
      else setEditableValue(composer, nextText);
      const inputDispatched = dispatchComposerInput(composer, nextText);
      if (composer.tagName === "TEXTAREA") composer.setSelectionRange?.(start, end);
      else setEditableSelection(composer, start, end, nextText);
      return { ok: true, changed: true, inputDispatched, text: nextText, selection: { start, end } };
    } finally {
      writingComposers.delete(composer);
    }
  }

  function isComposerTarget(target) {
    const composer = findComposer();
    return Boolean(composer && target && (target === composer || composer.contains?.(target)));
  }

  function normalizeComposer(options) {
    let composer = null;
    let acquired = false;
    try {
      composer = findComposer();
      if (!composer) return { ok: false, error: "Поле ввода ChatGPT не найдено." };
      if (options?.requireFocus && !isComposerTarget(document.activeElement)) {
        return { ok: false, error: "Установите курсор в поле ввода ChatGPT." };
      }
      if (normalizingComposers.has(composer)) return { ok: false, busy: true, error: "Нормализация уже выполняется." };
      normalizingComposers.add(composer);
      acquired = true;
      const currentText = readComposerText(composer);
      const normalized = normalizeComposerPlainText(currentText);
      if (!normalized.changed) return { ok: true, changed: false, text: currentText, edits: [] };

      let offsets;
      if (composer.tagName === "TEXTAREA") {
        offsets = {
          start: Number.isInteger(composer.selectionStart) ? composer.selectionStart : currentText.length,
          end: Number.isInteger(composer.selectionEnd) ? composer.selectionEnd : currentText.length,
        };
      } else {
        offsets = editableSelectionOffsets(composer) || { start: currentText.length, end: currentText.length };
      }
      const nextStart = workspaceContract.mapOffsetThroughEdits(offsets.start, normalized.edits);
      const nextEnd = workspaceContract.mapOffsetThroughEdits(offsets.end, normalized.edits);
      const write = replaceComposerText(normalized.text, { start: nextStart, end: nextEnd });
      if (!write.ok) return write;
      return { ok: true, changed: write.changed, text: write.text, edits: normalized.edits };
    } catch (error) {
      return { ok: false, error: error?.message || "Не удалось нормализовать пустые строки." };
    } finally {
      if (composer && acquired) normalizingComposers.delete(composer);
    }
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
      const template = adaptLineEndings(text);
      if (!containsMeaningfulText(template)) {
        return {
          ok: false, inserted: false, unchanged: false, failed: true,
          verified: false, verificationFailed: false,
          sendAttempted: false, sent: false, sendFailed: false,
          error: "Пустой шаблон нельзя вставить.",
        };
      }

      const composer = findComposer();
      if (!composer) {
        return {
          ok: false, inserted: false, unchanged: false, failed: true,
          verified: false, verificationFailed: false,
          sendAttempted: false, sent: false, sendFailed: false,
          error: "Поле ввода ChatGPT не найдено.",
        };
      }

      const existingText = adaptLineEndings(readComposerText(composer));
      const appended = containsMeaningfulText(existingText);
      const nextText = appended
        ? `${existingText}\n\n${template}`
        : template;
      const write = replaceComposerText(nextText, { start: nextText.length, end: nextText.length });
      if (!write.ok) {
        return {
          ...write,
          inserted: false,
          unchanged: false,
          failed: true,
          verified: false,
          verificationFailed: false,
          sendAttempted: false,
          sent: false,
          sendFailed: false,
        };
      }
      const verified = await confirmComposerText(composer, nextText);
      return {
        ok: true,
        inserted: write.changed,
        unchanged: !write.changed,
        failed: false,
        verified,
        verificationFailed: !verified,
        sendAttempted: false,
        sent: false,
        sendFailed: false,
        text: nextText,
        appended,
        changed: write.changed,
        inputDispatched: write.inputDispatched,
        ...(verified ? {} : { error: "Шаблон вставлен, но не удалось подтвердить содержимое." }),
      };
    } catch (error) {
      return {
        ok: false, inserted: false, unchanged: false, failed: true,
        verified: false, verificationFailed: false,
        sendAttempted: false, sent: false, sendFailed: false,
        error: error?.message || "Не удалось вставить шаблон.",
      };
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
    if (insertion.failed || !autoSend) return insertion;
    if (!insertion.verified) {
      return {
        ...insertion,
        error: "Шаблон вставлен, но не удалось подтвердить содержимое. Автоотправка не выполнена.",
      };
    }
    const sent = await sendCurrentComposer();
    return {
      ...insertion,
      sendAttempted: true,
      sent: sent.ok === true,
      sendFailed: sent.ok !== true,
      ...(sent.ok ? {} : { error: `Шаблон вставлен, но не удалось отправить. ${sent.error || ""}`.trim() }),
    };
  }

  async function executeNextQuickAction() {
    try {
      const state = readComposer();
      if (state.ok && !state.empty) return { ok: true, noop: true };
      return executeTemplate("Далее", true);
    } catch (error) {
      return { ok: false, error: error?.message || "Не удалось выполнить быстрое действие." };
    }
  }

  window.ChatGPTTemplateDom = {
    version: 6,
    readComposer,
    readSelectionText,
    captureInlineGlossarySelection,
    normalizeComposerPlainText,
    normalizeComposerText,
    normalizeComposer,
    isComposerTarget,
    replaceComposerText,
    insertTemplateText,
    sendCurrentComposer,
    executeTemplate,
    executeNextQuickAction,
  };
})();
