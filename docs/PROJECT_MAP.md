# Карта проекта `chatgpt-helper`

> Runtime-состав, ownership модулей, хранилища и основные потоки данных.

## 1. Назначение

`chatgpt-helper` — расширение Manifest V3 для ChatGPT. Оно добавляет рабочую панель с шаблонами, словарём и сохранёнными фрагментами, а также анализ и перевод выделенного текста через OpenRouter.

---

## 2. Обзор системы

Расширение состоит из трёх исполняемых частей:

1. **Content scripts** — UI и интеграция с DOM ChatGPT.
2. **Service worker** — валидация сообщений, mutations, IndexedDB, import/recovery и OpenRouter.
3. **Options page** — OpenRouter API key, импорт и экспорт.

```text
manifest.json
├── Service worker: src/service-worker.js
├── Options page:   src/options.html → src/options.js
└── Content scripts
    ├── contracts and domain helpers
    ├── ChatGPT DOM adapter
    ├── controllers and UI
    └── src/content-script.js

Content scripts / Options page
            │ chrome.runtime messages
            ▼
       Service worker
       ├── chrome.storage.local
       ├── chrome.storage.session
       ├── Workspace IndexedDB
       ├── Private IndexedDB
       └── OpenRouter API
```

Content script и Options page читают нужные значения из `chrome.storage.local`, но mutations выполняются через service worker; UI синхронизируется через runtime-события и `chrome.storage.onChanged`.

Build pipeline отсутствует: Manifest V3 runtime загружает исходные JS/CSS/HTML-файлы из репозитория.

---

## 3. Browser entrypoints

### `manifest.json`

Manifest владеет permissions, host permissions, entrypoints, browser action, commands, иконками и load order.

`manifest_version` равен `3`; background entrypoint — `src/service-worker.js`, Options page — `src/options.html` с `open_in_tab: true`. У browser action нет popup: click маршрутизируется service worker в content script для переключения панели.

```text
Permissions:
- storage
- contextMenus

Hosts:
- https://chatgpt.com/*
- https://chat.openai.com/*
- https://openrouter.ai/*
```

Content scripts и context menus ограничены двумя ChatGPT-hosts. `openrouter.ai` — отдельная host boundary service worker для анализа, перевода и проверки ключа; unrestricted wildcard hosts и permission `tabs` в manifest отсутствуют.

### Service worker

```text
src/service-worker.js
```

Порядок `importScripts()`:

```text
workspace-contract.js
template-tree.js
conversation-context.js
command-registry.js
import-export.js
workspace-store.js
analysis-contract.js
glossary-store.js
secret-store.js
openrouter-client.js
```

### Content scripts

Загружаются на двух ChatGPT-hosts с `run_at: document_idle`:

```text
workspace-contract.js
template-tree.js
conversation-context.js
command-registry.js
chatgpt-dom.js
analysis-contract.js
analysis-controller.js
translation-controller.js
analysis-ui.js
workspace-ui.js
content-script.js
```

`content-script.js` загружается последним и связывает page-side модули в единый runtime.

### Options page

```text
src/options.html
```

Load order:

```text
workspace-contract.js
template-tree.js
import-export.js
analysis-contract.js
options.js
```

Options page отвечает за API key, Settings/Data export, import preview и режимы `Merge` / `Replace`.

---

## 4. Карта модулей

### Contracts и domain helpers

| Файл | Ответственность |
|---|---|
| `workspace-contract.js` | settings defaults, limits, Workspace schema, message types, shared validation |
| `analysis-contract.js` | contract анализа, error codes, limits, provider-response validation |
| `template-tree.js` | pure model папок и шаблонов, moves, delete, migration, trusted icons |
| `conversation-context.js` | ChatGPT URL, stable scope, SPA location tracking |
| `command-registry.js` | browser commands, context-menu IDs, eligibility и handler mapping |
| `import-export.js` | portable JSON formats, schema validation, `Merge` / `Replace` plans |

### Page integration и UI

| Файл | Ответственность |
|---|---|
| `content-script.js` | Shadow DOM shell, panel lifecycle, settings/template UI, DnD, storage listeners |
| `workspace-ui.js` | glossary/saved rendering, cards, icons and breadcrumbs |
| `analysis-ui.js` | inline actions, analysis/translation dialogs, bounded Markdown |
| `chatgpt-dom.js` | selectors, selection extraction, composer read/write and auto-send |
| `analysis-controller.js` | page-side lifecycle анализа и stale-response handling |
| `translation-controller.js` | translation lifecycle, cancellation and stale-response handling |
| `options.js` | API-key UI, key status, import/export preview and file download |

### Privileged runtime и persistence

| Файл | Ответственность |
|---|---|
| `service-worker.js` | sender checks, routing, context menus/commands, mutations, locks, recovery and provider calls |
| `workspace-store.js` | durable Workspace domain, IndexedDB adapter, queries and imports |
| `secret-store.js` | isolated IndexedDB storage of OpenRouter API key |
| `glossary-store.js` | legacy V1 glossary schema/normalization boundary; текущий glossary хранится в Workspace |
| `openrouter-client.js` | единственный owner внешних HTTP-запросов |

### Основные domain-контракты

Template tree:

```js
// Folder
{ id, kind: "folder", parentId, name, iconKey }

// Template
{ id, kind: "template", parentId, name, iconKey, content, autoSend }
```

```text
Maximum folder depth: 6
Maximum node name:    120 characters
Maximum content:      200000 characters
```

Trusted icon keys:

```text
folder, document, code, terminal, database,
checklist, chart, globe, translate, brain,
spark, shield, bug, bookmark, rocket
```

Browser commands:

```text
analyze-selection
translate-selection
save-selection
normalize-composer
```

---

## 5. Ownership

Владельцы модулей перечислены в карте выше. Основные правила границ:

1. Content scripts не обращаются к Workspace IndexedDB напрямую.
2. Content scripts не получают OpenRouter API key.
3. Content scripts не выполняют OpenRouter HTTP-запросы.
4. Service worker не работает с DOM ChatGPT.
5. `template-tree.js` не выполняет storage mutations.
6. `import-export.js` строит планы, но не применяет их самостоятельно.
7. `openrouter-client.js` не сохраняет provider result в Workspace.

---

## 6. Хранение данных

### `chrome.storage.local`

Текущее пользовательское состояние:

```text
templates
settings
recentTemplateIds
templateTreeUiState
```

- `templates` — typed flat preorder tree;
- `settings` — theme, wallpaper, panel/recent behavior, analysis appearance and layout;
- `recentTemplateIds` — недавно использованные шаблоны;
- `templateTreeUiState` — collapsed folders.

Legacy migration inputs:

```text
glossarySchemaVersion
glossaryEntries
```

Они служат источником миграции V1 glossary в Workspace и не являются текущим glossary owner. Устаревший `selectedTemplate` только обнаруживается и удаляется при storage migration.

### `chrome.storage.session`

Временное runtime-состояние:

```text
chatgpt-helper:analysis-lock:<tabId>
chatgpt-helper:temporary-context:<tabId>
chatgpt-helper:import-lock
chatgpt-helper:deferred-orphan-tabs
```

- общий per-tab lock для анализа и перевода;
- live mapping вкладки на temporary conversation scope;
- session mutex импорта;
- очередь отложенной orphan-cleanup закрытых вкладок.

Durable import operation markers не находятся в session storage: `settingsImportOperation` и `dataImportOperation` записываются в Workspace store `meta`.

### Workspace IndexedDB

```text
Database:         chatgpt-helper-workspace
DB version:       1
Workspace schema: 2
```

Object stores:

```text
meta
conversations
glossaryConcepts
glossarySenses
glossaryLinks
savedItems
savedItemLinks
importBackups
```

`conversations`, glossary и saved stores составляют exportable user data. `meta` хранит schema/migration state, revisions и durable import markers; `importBackups` хранит технические rollback snapshots. Эти два operational stores не входят в Data export.

Глобальные glossary/saved entities отделены от links к конкретному conversation. Это позволяет глобальный поиск, локальный порядок и удаление link только из текущего чата либо entity во всех чатах.

### Private IndexedDB

```text
Database:   chatgpt-helper-private
DB version: 1
Store:      secrets
Record:     openrouter-api-key
```

API key:

- не хранится в `chrome.storage.local`;
- не передаётся content script;
- не включается в export;
- доступен privileged runtime.

Отдельная IndexedDB является storage isolation, но не прикладным шифрованием.

### Conversation scope

```text
stable:<host>:<remoteConversationId>
temporary:<generatedId>
```

Stable scope выводится только из поддерживаемого HTTPS URL с `/c/<id>`; hostname входит в identity. Для страницы без stable ID service worker создаёт per-tab temporary scope, сохраняет его mapping в session storage и durable conversation в Workspace. После появления stable URL rebind переносит links и удаляет temporary conversation; при закрытии вкладки запись помечается orphaned, а не теряет связанные данные.

---

## 7. Runtime communication

```text
Content script / Options page
        │ chrome.runtime message
        ▼
Service worker
        ├── sender and URL validation
        ├── payload validation
        ├── lock / serialization when required
        ├── storage, Workspace or provider operation
        └── normalized response
```

Классы сообщений:

- content-tab queries and mutations;
- template/settings mutations;
- Workspace operations;
- AI operations;
- options-only import/export;
- change notifications.

После mutations UI обновляется через runtime events или `chrome.storage.onChanged`.

---

## 8. Основные потоки

### Шаблон

```text
Template card
→ lookup template
→ read composer
→ insert and verify text
→ optional auto-send
→ update recentTemplateIds
```

### Сохранённый фрагмент

```text
Selection
→ command/context menu
→ conversation context
→ service worker
→ Workspace IndexedDB
→ Saved UI
```

Текст хранится как глобальный `savedItem`, привязка к чату — как `savedItemLink`.

### Локальный glossary lookup

```text
Selection
→ candidate extraction
→ Workspace query
→ inline result
```

OpenRouter не используется.

### Анализ терминов

```text
Selection
→ input validation
→ analysis controller
→ service worker
→ resolve conversation context (best effort) and load API key
→ OpenRouter
→ structured response validation
→ Workspace glossary merge, либо `unsaved` при недоступном Workspace
→ result UI
```

### Перевод

```text
Selection
→ translation controller
→ service worker
→ API key
→ OpenRouter
→ bounded response extraction
→ safe Markdown rendering
```

Перевод автоматически в Workspace не сохраняется.

### Settings update

```text
Panel settings
→ validated patch
→ service worker
→ chrome.storage.local
→ chrome.storage.onChanged
→ UI refresh
```

### Import

```text
JSON
→ schema validation
→ preview
→ Merge/Replace
→ повторная validation
→ session lock, IndexedDB backup and durable marker
→ apply and verification
→ finish or rollback
```

Rollback восстанавливает сбойную или незавершённую техническую операцию и не является Undo после успешного import.

---

## 9. OpenRouter boundary

OpenRouter используется для:

1. анализа английских терминов;
2. перевода выделенного текста;
3. проверки API key.

```text
Model:   openai/gpt-4.1-mini
Timeout: 25 seconds
```

Пользовательского model selector нет.

Analysis:

```text
temperature: 0
max_tokens:  2500
response:    strict JSON schema
terms:       up to 40
```

Translation:

```text
temperature:      0
max_tokens:       10000
requested output: Russian Markdown
renderer:         bounded Markdown; HTML не парсится
```

Provider configuration:

```text
require_parameters: true
allow_fallbacks: true
data_collection: deny
```

Response body ограничивается по размеру, provider errors преобразуются во внутренние error codes.

При AI-операции выбранный текст отправляется OpenRouter. Расширение не является полностью локальной AI-системой.

---

## 10. Import, export и recovery

Settings export:

```text
chatgpt-helper-settings.json
```

Включает active settings, в том числе wallpaper. Не включает templates, Workspace data или API key.

Data export:

```text
chatgpt-helper-data.json
```

Включает templates, conversations, glossary и saved entities/links.

Не включает:

- settings и wallpaper;
- OpenRouter API key;
- recent-template history;
- collapsed-folder UI state;
- Workspace `meta` и `importBackups`.

Portable Data JSON также не хранит derived internal fields (`scopeKey`, normalized keys): import восстанавливает их из валидированных полей.

Для Settings import `Merge` накладывает переданные поля на текущие настройки, а `Replace` начинает с defaults. Для Data import `Merge` объединяет файл с текущими exportable families, а `Replace` формирует эти families из файла; при Data `Replace` recent history и collapsed-folder state сбрасываются, поскольку в portable file их нет.

Apply использует session lock, backup в `importBackups`, durable marker в `meta`, read-back verification и rollback при technical failure или незавершённой операции. Ни один из двух JSON-файлов не является полным snapshot всего состояния расширения.

---

## 11. Trust boundaries

- **ChatGPT DOM** — внешняя и изменяемая структура; selectors сосредоточены в `chatgpt-dom.js`.
- **Runtime messages** — service worker проверяет sender, URL/host, message type и payload.
- **Imported JSON** — проверяются size, envelope, format, schema и records.
- **Provider response** — body ограничивается по размеру; analysis payload проходит schema validation, а translation принимает только непустой message content и не парсит HTML.
- **Rendered content** — icons берутся из allowlist; arbitrary SVG и provider HTML не исполняются.
- **API key** — доступен service worker через private IndexedDB и не включается в export.

---

## 12. Тестовая карта

| Test entrypoint | Область |
|---|---|
| `tests/template-tree-logic.test.js` | template-tree schema and mutations |
| `tests/translation-logic.test.js` | translation controller/worker/client, command routing and safe UI rendering |
| `tests/analysis-logic.test.js` | analysis and inline UI, sender/lock/storage orchestration, key/options and import recovery |
| `tests/workspace-logic.test.js` | manifest/load order, Workspace contracts/store/UI, settings and import/export formats |

Тесты — standalone Node scripts с VM, fake Chrome APIs, fake storage/IndexedDB и fake provider responses.

> Node/VM tests не заменяют ручной browser smoke с живым DOM ChatGPT и реальным Manifest V3 lifecycle.

---

## 13. Сокращённое дерево репозитория

```text
chatgpt-helper/
├── manifest.json
├── package-lock.json
├── icons/
│   ├── chatgpt-helper-16.png
│   ├── chatgpt-helper-32.png
│   ├── chatgpt-helper-48.png
│   └── chatgpt-helper-128.png
├── src/
│   ├── analysis-contract.js
│   ├── analysis-controller.js
│   ├── analysis-ui.js
│   ├── chatgpt-dom.js
│   ├── command-registry.js
│   ├── content-script.js
│   ├── conversation-context.js
│   ├── glossary-store.js
│   ├── import-export.js
│   ├── openrouter-client.js
│   ├── options.css
│   ├── options.html
│   ├── options.js
│   ├── secret-store.js
│   ├── service-worker.js
│   ├── template-tree.js
│   ├── workspace-contract.js
│   ├── workspace-store.js
│   └── workspace-ui.js
└── tests/
    ├── analysis-logic.test.js
    ├── template-tree-logic.test.js
    ├── translation-logic.test.js
    └── workspace-logic.test.js
```
