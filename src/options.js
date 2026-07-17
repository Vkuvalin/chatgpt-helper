(function initOptionsPage() {
  "use strict";

  const contract = globalThis.ChatGPTHelperAnalysisContract;
  const MESSAGES = contract.MESSAGE_TYPES;
  const form = document.getElementById("key-form");
  const input = document.getElementById("api-key");
  const statusView = document.getElementById("status-view");
  const message = document.getElementById("message");
  const deleteConfirm = document.getElementById("delete-confirm");
  const cancelReplace = document.querySelector('[data-action="cancel-replace"]');
  let configured = false;
  let busy = false;

  function setMessage(kind, text) {
    message.className = `message ${kind || ""}`;
    message.textContent = text || "";
  }

  function setBusy(value) {
    busy = value;
    document.querySelectorAll("button, input").forEach((element) => { element.disabled = value; });
  }

  function render(replacing) {
    statusView.hidden = !configured || replacing;
    form.hidden = configured && !replacing;
    cancelReplace.hidden = !configured || !replacing;
    deleteConfirm.hidden = true;
    if (!replacing) input.value = "";
  }

  async function send(messageValue) {
    return chrome.runtime.sendMessage(messageValue);
  }

  async function loadStatus() {
    setBusy(true);
    try {
      const response = await send({ type: MESSAGES.GET_KEY_STATUS });
      configured = response?.ok && response.configured === true;
      render(false);
    } catch (_) {
      setMessage("error", "Не удалось прочитать состояние ключа.");
    } finally {
      setBusy(false);
    }
  }

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (busy) return;
    const apiKey = input.value.trim();
    setBusy(true);
    setMessage("", "");
    try {
      const response = await send({ type: MESSAGES.SET_KEY, apiKey });
      if (!response?.ok) {
        setMessage("error", response?.error?.message || "Не удалось сохранить ключ.");
        return;
      }
      input.value = "";
      configured = true;
      render(false);
      setMessage("success", "Ключ сохранён. Его значение больше не отображается.");
    } catch (_) {
      setMessage("error", "Не удалось сохранить ключ.");
    } finally {
      setBusy(false);
    }
  });

  document.addEventListener("click", async (event) => {
    const button = event.target.closest("[data-action]");
    if (!button || busy) return;
    const action = button.dataset.action;
    if (action === "replace") {
      setMessage("", "");
      render(true);
      input.focus();
      return;
    }
    if (action === "cancel-replace") {
      render(false);
      setMessage("", "");
      return;
    }
    if (action === "ask-delete") {
      deleteConfirm.hidden = false;
      return;
    }
    if (action === "cancel-delete") {
      deleteConfirm.hidden = true;
      return;
    }

    setBusy(true);
    setMessage("", "");
    try {
      if (action === "verify") {
        const response = await send({ type: MESSAGES.VERIFY_KEY });
        if (response?.status === "valid") setMessage("success", "Ключ действителен.");
        else if (response?.status === "limit-exhausted") setMessage("error", "Ключ действителен, но доступный лимит исчерпан.");
        else setMessage("error", response?.error?.message || "Не удалось проверить ключ.");
      } else if (action === "confirm-delete") {
        const response = await send({ type: MESSAGES.DELETE_KEY });
        if (!response?.ok) {
          setMessage("error", response?.error?.message || "Не удалось удалить ключ.");
        } else {
          configured = false;
          render(false);
          setMessage("success", "Ключ удалён. Словарь сохранён.");
        }
      }
    } catch (_) {
      setMessage("error", action === "verify" ? "Не удалось проверить ключ." : "Не удалось удалить ключ.");
    } finally {
      setBusy(false);
    }
  });

  void loadStatus();
})();
