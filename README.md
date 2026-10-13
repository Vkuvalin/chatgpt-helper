<p align="center">
  <img src="./icons/chatgpt-helper-128.png" alt="ChatGPT-Helper">
</p>

<div align="center">

# ChatGPT Helper

**Расширение для ChatGPT с шаблонами, папками, локальным словарём, сохранёнными фрагментами, переводом и анализом выделенного текста.**

![Manifest V3](https://img.shields.io/badge/Manifest-V3-5A67D8)
![Chromium](https://img.shields.io/badge/browser-Chromium-4285F4)
![JavaScript](https://img.shields.io/badge/JavaScript-Vanilla-F7DF1E)
![Version](https://img.shields.io/badge/version-1.2.0-2EA44F)
![Interface](https://img.shields.io/badge/interface-Русский-6F42C1)

</div>

## Демонстрация

Видео работы расширения и примеры его интерфейса.

[Смотреть видео](https://github.com/user-attachments/assets/6add510f-475d-46b2-8276-0538c57d95ee)

**Пример анализа:** выделенный текст преобразуется в термины с переводами и определениями.

<p align="center">
  <img src="https://github.com/user-attachments/assets/685ba178-d297-4682-89be-7b2315004e51" alt="Результат анализа выделенного текста в ChatGPT Helper" width="520" />
</p>


---

## Зачем нужен ChatGPT Helper

ChatGPT хорошо работает с отдельным запросом, но повторяющиеся рабочие сценарии быстро распадаются между сообщениями, заметками и внешними файлами.

ChatGPT Helper добавляет поверх интерфейса ChatGPT локальное рабочее пространство:

- хранит и запускает повторно используемые шаблоны;
- организует их во вложенные папки;
- сохраняет полезные фрагменты из разговоров;
- формирует локальный словарь терминов;
- переводит и анализирует выделенный текст;
- сохраняет настройки, темы и данные между сессиями.

Расширение работает непосредственно внутри ChatGPT и не требует отдельного приложения или build-процесса.

---

## Возможности

### Шаблоны и рабочее пространство

- шаблоны с именем, иконкой и содержимым;
- вложенные папки до шести уровней;
- перетаскивание элементов;
- Auto-send после безопасной проверки вставки;
- список недавно использованных шаблонов;
- предпросмотр перед запуском;
- быстрое действие **«Далее»**.

### Словарь и сохранённые фрагменты

- сохранение выделенного текста из контекстного меню;
- локальные записи текущего разговора;
- глобальный поиск по всему профилю;
- прикрепление существующей записи к другому чату;
- отдельное локальное и глобальное удаление;
- поиск по уже сохранённому словарю без внешнего запроса.

### Анализ и перевод

- анализ английских терминов в выделенном тексте;
- перевод выделенного текста на русский;
- запуск из панели над выделением, контекстного меню или команды браузера;
- безопасный Markdown-вывод;
- сохранение результатов анализа в словарь;
- обработка ошибок OpenRouter, тайм-аутов и ограничений провайдера.

### Настройка интерфейса

- темы `System / Neutral`, `Graphite`, `Deep Navy`, `Neon Violet`, `Codex Gold`;
- собственные обои;
- изменение размеров панели и диалогов;
- настройка оформления словаря;
- импорт и экспорт настроек;
- отдельный импорт и экспорт пользовательских данных.

---


## Скриншоты возможностей

Раскройте нужный раздел. Для подробного просмотра откройте изображение в полном размере.

<details>
<summary><strong>Шаблоны и папки</strong></summary>

Дерево папок и редактор шаблона.

<table>
<tr>
<td valign="top" width="50%">
<img src="https://github.com/user-attachments/assets/6b768239-4715-4a46-ac99-b3bfeff8b425" alt="Дерево шаблонов и вложенных папок" width="100%" />
</td>
<td valign="top" width="50%">
<img src="https://github.com/user-attachments/assets/efa2539f-8f2f-4506-b059-c9b0b9f4058a" alt="Редактор шаблона" width="100%" />
</td>
</tr>
</table>

</details>

<details>
<summary><strong>Быстрый доступ к панели</strong></summary>

Открытие меню и запуск следующего действия.

<table>
<tr>
<td valign="top" width="50%">
<img src="https://github.com/user-attachments/assets/6bc9a77f-3197-4338-9b75-3e64780d4080" alt="Кнопка открытия панели шаблонов" width="100%" />
</td>
<td valign="top" width="50%">
<img src="https://github.com/user-attachments/assets/06aa87bc-75ff-4efe-98f3-512f8607cad7" alt="Быстрое действие «Далее»" width="100%" />
</td>
</tr>
</table>

</details>

<details>
<summary><strong>Сохранённые фрагменты</strong></summary>

Текст, сохранённый с привязкой к разговору.

<p align="center">
  <img src="https://github.com/user-attachments/assets/556008cd-4157-4126-9ddb-aa730c7ae152" alt="Сохранённый текст в текущем разговоре" width="520" />
</p>

</details>

<details>
<summary><strong>Настройки и оформление</strong></summary>

Параметры панели, темы и настройки расширения.

<table>
<tr>
<td valign="top" width="33%">
<img src="https://github.com/user-attachments/assets/76e66acd-2446-4990-8b25-9cfac6e3b222" alt="Настройки расширения" width="100%" />
</td>
<td valign="top" width="33%">
<img src="https://github.com/user-attachments/assets/d32957d2-0da7-4878-820f-c8536b74821f" alt="Выбор темы оформления" width="100%" />
</td>
<td valign="top" width="33%">
<img src="https://github.com/user-attachments/assets/01e7ff02-c656-471d-bb09-4c9c2b24b4b3" alt="Дополнительные настройки расширения" width="100%" />
</td>
</tr>
</table>

</details>

<details>
<summary><strong>Словарь выделенного текста</strong></summary>

Всплывающие действия и поиск по сохранённому словарю.

<table>
<tr>
<td valign="top" width="33%">
<img src="https://github.com/user-attachments/assets/8e283075-62ea-4336-afb4-d8861b9c6346" alt="Действия для выделенного текста" width="100%" />
</td>
<td valign="top" width="33%">
<img src="https://github.com/user-attachments/assets/f7f293bb-ccc3-4da8-b718-6ae3872b796c" alt="Словарная запись" width="100%" />
</td>
<td valign="top" width="33%">
<img src="https://github.com/user-attachments/assets/c70e282b-e7f7-4aa8-a571-351b4b3df892" alt="Быстрый поиск по словарю" width="100%" />
</td>
</tr>
</table>

</details>

<details>
<summary><strong>Анализ текста</strong></summary>

Запуск анализа, результат и словарь терминов.

<table>
<tr>
<td valign="top" width="33%">
<img src="https://github.com/user-attachments/assets/cdb1ae8d-4660-49c1-b84b-9f3636f19722" alt="Запуск анализа выделенного текста" width="100%" />
</td>
<td valign="top" width="33%">
<img src="https://github.com/user-attachments/assets/685ba178-d297-4682-89be-7b2315004e51" alt="Результат анализа терминов" width="100%" />
</td>
<td valign="top" width="33%">
<img src="https://github.com/user-attachments/assets/77257a2d-418c-4d43-9d0d-455dac8196e0" alt="Термины в локальном словаре" width="100%" />
</td>
</tr>
</table>

</details>

<details>
<summary><strong>Перевод текста</strong></summary>

Выделение текста и результат перевода на русский.

<table>
<tr>
<td valign="top" width="50%">
<img src="https://github.com/user-attachments/assets/b7f08c9c-7d84-4c38-9566-100e4d9a2042" alt="Запуск перевода выделенного текста" width="100%" />
</td>
<td valign="top" width="50%">
<img src="https://github.com/user-attachments/assets/0a09b47b-832a-4ff0-a28e-8f5987345c9c" alt="Результат перевода" width="100%" />
</td>
</tr>
</table>

</details>

---

## Быстрый старт

### 1. Получите проект

```bash
git clone https://github.com/Vkuvalin/chatgpt-helper.git
```

Также можно скачать репозиторий через **Code → Download ZIP** и распаковать архив.

### 2. Загрузите расширение

1. Откройте страницу управления расширениями — для Google Chrome обычно используется `chrome://extensions`.
2. Включите режим разработчика.
3. Выберите загрузку распакованного расширения.
4. Укажите каталог проекта, в котором находится `manifest.json`.
5. Откройте или обновите вкладку ChatGPT.

Сборка и `npm install` не требуются. Шаблоны, папки и сохранённые фрагменты работают без API key; для анализа и перевода нужен ключ OpenRouter.

Подробная установка, настройка OpenRouter и описание всех пользовательских сценариев находятся в [руководстве пользователя](docs/USER_GUIDE.md).

---

## Как устроено расширение

ChatGPT Helper построен как компактное расширение Manifest V3 без отдельного процесса сборки:

- **content scripts** добавляют интерфейс и работают с DOM ChatGPT;
- **service worker** выполняет привилегированные операции, управляет данными и внешними запросами;
- **локальные хранилища браузера** (`chrome.storage` и IndexedDB) сохраняют настройки и пользовательские данные, а API key находится в отдельной IndexedDB;
- **OpenRouter boundary** изолирует внешние AI-операции: при анализе и переводе выделенный текст отправляется OpenRouter.

Подробное устройство модулей, хранилищ и потоков данных описано в [карте проекта](docs/PROJECT_MAP.md).

---

## Поддерживаемые страницы

Расширение активируется на:

```text
https://chatgpt.com/*
https://chat.openai.com/*
```

Проект ориентирован на Chromium-браузеры и загружается вручную как unpacked extension. Официальная матрица браузеров и версий пока не заявляется.

---

## Ограничения

- расширение зависит от актуального DOM ChatGPT;
- AI-функции зависят от OpenRouter, доступности выбранной модели и API key;
- встроенной синхронизации между устройствами нет;
- `chatgpt.com` и `chat.openai.com` используют отдельные области данных разговоров;
- настройки и пользовательские данные экспортируются раздельно;
- API key не входит в резервные копии;

---

## Статус

Рабочая версия для локального использования как unpacked extension. Основной функциональный объём завершён; развитие новых возможностей отложено.

Текущая версия:

```text
1.2.0
```

---

## Документация

- [Руководство пользователя](docs/USER_GUIDE.md)
- [Карта проекта](docs/PROJECT_MAP.md)
