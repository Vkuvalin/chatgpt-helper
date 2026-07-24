(function initOptionsPage() {
  "use strict";

  const analysisContract = globalThis.ChatGPTHelperAnalysisContract;
  const workspaceContract = globalThis.ChatGPTHelperWorkspaceContract;
  const importExport = globalThis.ChatGPTHelperImportExport;
  const MESSAGES = analysisContract.MESSAGE_TYPES;
  const BACKUP_MESSAGES = workspaceContract.MESSAGE_TYPES;
  const THEME_CLASSES = Object.freeze(["theme-system", "theme-graphite", "theme-navy", "theme-violet", "theme-gold"]);
  const CANCELLABLE_BACKUP_STATES = new Set(["reading", "validating", "ready", "success", "failed", "recovery-required"]);
  const form = document.getElementById("key-form");
  const input = document.getElementById("api-key");
  const statusView = document.getElementById("status-view");
  const message = document.getElementById("message");
  const deleteConfirm = document.getElementById("delete-confirm");
  const cancelReplace = document.querySelector('[data-action="cancel-replace"]');
  const backup = {
    settings: { state: "idle", file: null, fingerprint: null, text: null, preview: null, mode: "merge", result: "", error: false },
    data: { state: "idle", file: null, fingerprint: null, text: null, preview: null, mode: "merge", result: "", error: false },
  };
  let configured = false;
  let keyBusy = false;

  function setMessage(kind, text) {
    message.className = `message ${kind || ""}`;
    message.textContent = text || "";
  }

  function setKeyBusy(value) {
    keyBusy = value;
    document.querySelectorAll("[data-action], #api-key").forEach((element) => { element.disabled = value; });
  }

  function renderKey(replacing) {
    statusView.hidden = !configured || replacing;
    form.hidden = configured && !replacing;
    cancelReplace.hidden = !configured || !replacing;
    deleteConfirm.hidden = true;
    if (!replacing) input.value = "";
  }

  function send(messageValue) {
    return chrome.runtime.sendMessage(messageValue);
  }

  function fileFingerprint(file) {
    return file ? `${file.name}:${file.size}:${file.lastModified}` : null;
  }

  function previewText(kind, value) {
    if (!value) return "Файл не выбран.";
    if (kind === "settings") {
      return JSON.stringify({
        format: value.metadata,
        mode: backup[kind].mode,
        changed: value.changed,
        preserved: value.preserved,
        reset: value.reset,
        ignored: value.ignored,
        clamped: value.clamped,
        values: value.values,
        warnings: value.warnings,
      }, null, 2);
    }
    return JSON.stringify({
      format: value.metadata,
      mode: backup[kind].mode,
      incoming: value.incoming,
      current: value.current,
      retained: value.retained,
      created: value.created,
      resulting: value.resulting,
      removed: value.removed,
      remapped: value.remapped,
      deduplicated: value.deduplicated,
      deduplicatedTotal: value.deduplicatedTotal,
      skipped: value.skipped,
      temporaryOrphans: value.temporaryOrphans,
      orderChanged: value.orderChanged,
      warnings: value.warnings,
    }, null, 2);
  }

  function renderBackup(kind) {
    const state = backup[kind];
    const preview = document.querySelector(`[data-backup-preview="${kind}"]`);
    const result = document.querySelector(`[data-backup-result="${kind}"]`);
    const apply = document.querySelector(`[data-backup-action="apply"][data-kind="${kind}"]`);
    const selectedFile = document.querySelector(`[data-backup-selected-file="${kind}"]`);
    const selectedFilename = document.querySelector(`[data-backup-filename="${kind}"]`);
    const applying = Object.values(backup).some((item) => item.state === "applying");
    selectedFile.hidden = !state.file;
    selectedFilename.textContent = state.file?.name || "";
    selectedFilename.title = state.file?.name || "";
    preview.textContent = state.state === "reading" ? "Чтение файла…"
      : state.state === "validating" ? "Проверка файла…"
        : state.preview ? previewText(kind, state.preview) : "Файл не выбран.";
    result.textContent = state.result || "";
    result.className = `message ${state.error ? "error" : (state.result ? "success" : "")}`;
    apply.disabled = state.state !== "ready"
      || !state.preview
      || !state.text
      || state.fingerprint !== fileFingerprint(state.file)
      || applying;
    document.querySelectorAll(`[data-backup-kind="${kind}"] [data-backup-action]`).forEach((element) => {
      if (element === apply) return;
      if (element.dataset.backupAction === "cancel") {
        element.disabled = applying || !state.file || !CANCELLABLE_BACKUP_STATES.has(state.state);
        return;
      }
      element.disabled = applying || state.state === "reading" || state.state === "validating";
    });
  }

  function renderBackups() {
    renderBackup("settings");
    renderBackup("data");
  }

  function applyTheme(settingsValue) {
    const settings = workspaceContract.normalizeActiveSettings(settingsValue);
    document.documentElement.classList.remove(...THEME_CLASSES);
    document.documentElement.classList.add(`theme-${settings.theme}`);
  }

  async function loadTheme() {
    try {
      const stored = await chrome.storage.local.get("settings");
      applyTheme(stored.settings);
    } catch (_) {
      applyTheme(undefined);
    } finally {
      document.documentElement.classList.remove("theme-pending");
    }
  }

  function clearBackupSelection(kind) {
    const state = backup[kind];
    if (!state || Object.values(backup).some((item) => item.state === "applying")) return;
    state.state = "idle";
    state.file = null;
    state.fingerprint = null;
    state.text = null;
    state.preview = null;
    state.result = "";
    state.error = false;
    const fileInput = document.querySelector(`[data-backup-action="file"][data-kind="${kind}"]`);
    if (fileInput) fileInput.value = "";
    renderBackup(kind);
  }

  async function loadStatus() {
    setKeyBusy(true);
    try {
      const response = await send({ type: MESSAGES.GET_KEY_STATUS });
      configured = response?.ok && response.configured === true;
      renderKey(false);
    } catch (_) {
      setMessage("error", "Не удалось прочитать состояние ключа.");
    } finally {
      setKeyBusy(false);
    }
  }

  async function readBackupFile(kind, file) {
    const state = backup[kind];
    state.file = file || null;
    state.fingerprint = fileFingerprint(file);
    state.text = null;
    state.preview = null;
    state.result = "";
    state.error = false;
    if (!file) { state.state = "idle"; renderBackup(kind); return; }
    const maximum = kind === "settings" ? importExport.SETTINGS_MAX_BYTES : importExport.DATA_MAX_BYTES;
    if (file.size > maximum) {
      state.state = "failed";
      state.result = "Файл превышает допустимый размер.";
      state.error = true;
      renderBackup(kind);
      return;
    }
    const fingerprint = state.fingerprint;
    state.state = "reading";
    renderBackup(kind);
    try {
      const text = await file.text();
      if (file !== state.file || fingerprint !== state.fingerprint) return;
      state.state = "validating";
      renderBackup(kind);
      const response = await send({
        type: kind === "settings" ? BACKUP_MESSAGES.IMPORT_SETTINGS_PREVIEW : BACKUP_MESSAGES.IMPORT_DATA_PREVIEW,
        text,
        mode: state.mode,
      });
      if (file !== state.file || fingerprint !== state.fingerprint) return;
      if (!response?.ok) {
        state.state = response?.recoveryRequired ? "recovery-required" : "failed";
        state.result = response?.error?.message || "Файл не прошёл проверку.";
        state.error = true;
      } else {
        state.text = text;
        state.preview = response.preview;
        state.state = "ready";
      }
    } catch (_) {
      if (file !== state.file || fingerprint !== state.fingerprint) return;
      state.state = "failed";
      state.result = "Не удалось прочитать или проверить файл UTF-8.";
      state.error = true;
    }
    renderBackup(kind);
  }

  async function refreshPreview(kind) {
    const state = backup[kind];
    if (!state.file) return;
    return readBackupFile(kind, state.file);
  }

  function downloadText(filename, text) {
    const blob = new Blob([text], { type: "application/json;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.hidden = true;
    anchor.href = url;
    anchor.download = filename;
    document.body.appendChild(anchor);
    try {
      anchor.click();
    } finally {
      anchor.remove();
      setTimeout(() => URL.revokeObjectURL(url), 0);
    }
  }

  async function exportBackup(kind) {
    const state = backup[kind];
    state.result = "";
    state.error = false;
    renderBackup(kind);
    try {
      const response = await send({ type: kind === "settings" ? BACKUP_MESSAGES.EXPORT_SETTINGS : BACKUP_MESSAGES.EXPORT_DATA });
      if (!response?.ok) throw new Error(response?.error?.message || "Экспорт не выполнен.");
      downloadText(response.filename, response.text);
      state.result = "Файл экспорта подготовлен.";
    } catch (error) {
      state.result = error?.message || "Экспорт не выполнен.";
      state.error = true;
    }
    renderBackup(kind);
  }

  async function applyBackup(kind) {
    const state = backup[kind];
    if (state.state !== "ready" || !state.text || state.fingerprint !== fileFingerprint(state.file)) return;
    if (state.mode === "replace" && !window.confirm(`Replace полностью заменит ${kind === "settings" ? "активные настройки" : "шаблоны и Workspace-данные"}. Продолжить?`)) return;
    state.state = "applying";
    state.result = "Применение…";
    state.error = false;
    renderBackups();
    try {
      const response = await send({
        type: kind === "settings" ? BACKUP_MESSAGES.IMPORT_SETTINGS_APPLY : BACKUP_MESSAGES.IMPORT_DATA_APPLY,
        text: state.text,
        mode: state.mode,
      });
      if (!response?.ok) {
        state.state = response?.recoveryRequired ? "recovery-required" : "failed";
        state.result = response?.rolledBack ? "Импорт не выполнен; исходное состояние восстановлено." : (response?.error?.message || "Импорт не выполнен.");
        state.error = true;
      } else {
        state.state = "success";
        state.result = "Импорт успешно применён.";
        state.preview = null;
        state.text = null;
        state.file = null;
        state.fingerprint = null;
        const fileInput = document.querySelector(`[data-backup-action="file"][data-kind="${kind}"]`);
        if (fileInput) fileInput.value = "";
      }
    } catch (_) {
      state.state = "failed";
      state.result = "Связь с service worker прервана. Проверьте состояние перед повтором.";
      state.error = true;
    }
    renderBackups();
  }

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (keyBusy) return;
    const apiKey = input.value.trim();
    setKeyBusy(true);
    setMessage("", "");
    try {
      const response = await send({ type: MESSAGES.SET_KEY, apiKey });
      if (!response?.ok) { setMessage("error", response?.error?.message || "Не удалось сохранить ключ."); return; }
      input.value = "";
      configured = true;
      renderKey(false);
      setMessage("success", "Ключ сохранён. Его значение больше не отображается.");
    } catch (_) {
      setMessage("error", "Не удалось сохранить ключ.");
    } finally {
      setKeyBusy(false);
    }
  });

  document.addEventListener("change", (event) => {
    const action = event.target.dataset.backupAction;
    const kind = event.target.dataset.kind;
    if (!backup[kind]) return;
    if (action === "file") void readBackupFile(kind, event.target.files?.[0] || null);
    else if (action === "mode") {
      backup[kind].mode = event.target.value === "replace" ? "replace" : "merge";
      void refreshPreview(kind);
    }
  });

  document.addEventListener("click", async (event) => {
    const backupButton = event.target.closest("[data-backup-action]");
    if (backupButton && backupButton.tagName === "BUTTON") {
      const kind = backupButton.dataset.kind;
      if (backupButton.dataset.backupAction === "export") await exportBackup(kind);
      else if (backupButton.dataset.backupAction === "apply") await applyBackup(kind);
      else if (backupButton.dataset.backupAction === "cancel") clearBackupSelection(kind);
      return;
    }
    const button = event.target.closest("[data-action]");
    if (!button || keyBusy) return;
    const action = button.dataset.action;
    if (action === "replace") { setMessage("", ""); renderKey(true); input.focus(); return; }
    if (action === "cancel-replace") { renderKey(false); setMessage("", ""); return; }
    if (action === "ask-delete") { deleteConfirm.hidden = false; return; }
    if (action === "cancel-delete") { deleteConfirm.hidden = true; return; }
    setKeyBusy(true);
    setMessage("", "");
    try {
      if (action === "verify") {
        const response = await send({ type: MESSAGES.VERIFY_KEY });
        if (response?.status === "valid") setMessage("success", "Ключ действителен.");
        else if (response?.status === "limit-exhausted") setMessage("error", "Ключ действителен, но доступный лимит исчерпан.");
        else setMessage("error", response?.error?.message || "Не удалось проверить ключ.");
      } else if (action === "confirm-delete") {
        const response = await send({ type: MESSAGES.DELETE_KEY });
        if (!response?.ok) setMessage("error", response?.error?.message || "Не удалось удалить ключ.");
        else { configured = false; renderKey(false); setMessage("success", "Ключ удалён. Workspace-данные сохранены."); }
      }
    } catch (_) {
      setMessage("error", action === "verify" ? "Не удалось проверить ключ." : "Не удалось удалить ключ.");
    } finally {
      setKeyBusy(false);
    }
  });

  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName === "local" && changes.settings) applyTheme(changes.settings.newValue);
  });
  if (location.hash === "#backup") document.getElementById("backup")?.scrollIntoView();
  renderBackups();
  void Promise.all([loadTheme(), loadStatus()]);
})();
