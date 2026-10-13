# Alabuga Framework: краткое руководство для агента

Версия библиотеки: **0.6.0**. Версия документа: **3**.

Этот файл можно скопировать в другой репозиторий вместе с библиотекой. Он описывает использование готовой браузерной сборки и не требует доступа к исходному монорепозиторию. Это справочник интеграции, а не файл AGENTS.md с правилами всего проекта.

## Что подключается

Alabuga Framework — библиотека фирменных HTML/CSS-компонентов и отображения JSON-документов: адаптивной страницы с секциями либо презентации 16:9. Реализация использует обычный DOM. Готовая сборка не требует React, Vue, npm-зависимостей, Docker, конструктора или ИИ-сервера.

Два сценария использования:

- Обычный интерфейс: HTML с классами `.af-*`; `initComponents()` добавляет поведение форм и диалогов.
- Документ: `renderDocument()` строит содержимое контейнера из JSON; `makeComposition()` создаёт готовую секцию.

Библиотека сама не сохраняет документы и не реализует аккаунты, маршрутизацию приложения или отправку форм на сервер.

## Файлы в принимающем проекте

Предполагается, что содержимое `apps/frontend/public/` раздаётся от корня сайта:

```text
apps/frontend/public/
  alabuga/
    alabuga.css
    alabuga.iife.js
  assets/                 # Для фирменных изображений и фонов
    brand/
    brand-landscape.svg
    ...
```

В исходном репозитории команда `npm run build:framework` создаёт JS/CSS в `packages/framework/dist/`. В этом проекте материалы находятся в `apps/frontend/public/assets/`. Шрифты уже встроены в собранный CSS. Для документов без фирменных изображений достаточно двух файлов JS/CSS.

Если приложение размещено под префиксом, например `/portal/`, добавь его к адресам JS, CSS и материалов. Открывай страницу через сервер принимающего проекта.

## Полный пример подключения

```html
<!doctype html>
<html lang="ru">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Пример Alabuga Framework</title>
  <link rel="stylesheet" href="/alabuga/alabuga.css">
</head>
<body>
  <main id="document"></main>
  <script src="/alabuga/alabuga.iife.js"></script>
  <script>
    // Пути в заводских композициях имеют вид ../assets/...
    // Заменяем их адресами материалов в принимающем проекте.
    const assetBase = '/assets/';
    const assetUrl = src => src.startsWith('../assets/')
      ? assetBase + src.slice('../assets/'.length)
      : src;

    function relocateAssets(section) {
      if (section.appearance?.background) {
        section.appearance.background = assetUrl(section.appearance.background);
      }
      for (const widget of section.widgets) {
        if (widget.type === 'image') widget.src = assetUrl(widget.src);
        if (widget.type === 'gallery') {
          for (const item of widget.items) item.src = assetUrl(item.src);
        }
      }
      return section;
    }

    // fitSlide() использует этот каталог при выборе фирменного фона.
    for (const background of Alabuga.slideBackgrounds) {
      background.src = assetUrl(background.src);
    }

    const doc = {
      schemaVersion: 3,
      kind: 'page',
      title: 'Мой сайт',
      pages: [relocateAssets(Alabuga.makeComposition('split', 'page'))]
    };

    const result = Alabuga.validateDocument(doc);
    if (!result.success) {
      throw new Error(result.issues.map(i => i.path + ': ' + i.message).join('; '));
    }
    const controller = Alabuga.renderDocument(
      document.getElementById('document'), result.data
    );
  </script>
</body>
</html>
```

Вызывай `relocateAssets()` для каждой новой заводской композиции. Внешние URL и `data:` этот адаптер оставляет без изменений. JSON из другого приложения может содержать собственные относительные пути: их нужно разрешить относительно источника документа, а не заменять вслепую.

## API готовой IIFE-сборки

После загрузки скрипта доступен глобальный объект `Alabuga`.

| API | Назначение |
| --- | --- |
| `VERSION` | Версия библиотеки |
| `validateDocument(input)` | `{success: true, data, issues: []}` либо `{success: false, issues}` |
| `widgetRegistry` | Названия виджетов и минимальные размеры |
| `isSafeUrl(value)` | Проверка разрешённого адреса |
| `renderDocument(host, input, options?)` | Отображение документа и получение контроллера |
| `initComponents(root?)` | Подключение поведения HTML-компонентов; возвращает функцию очистки |
| `compositionCatalog(kind)` | Массив записей `[id, название, описание]` |
| `makeComposition(id, kind)` | Новая секция с уникальными ID |
| `changeComposition(section, id, kind)` | Смена совместимой композиции с сохранением содержания |
| `applyLayoutVariant(section, variant, kind)` | Вариант `primary`, `stacked` или `asymmetric` |
| `fitSlide(section, options?)` | Асинхронный подбор оформления слайда |
| `measureSlide(section, options?)` | Асинхронное измерение; возвращает массив замечаний |
| `slideBackgrounds` | Каталог фирменных фонов |
| `showcase(kind)` | Полный демонстрационный документ |

Также экспортируются `compositions`, `layoutVariants`, `semanticSlots`.

`renderDocument()` принимает `{editing?: boolean, resolveAsset?: (id) => string | undefined}`. Режим `editing` отключает запуск авторских действий и скрытие шагов, но сам не добавляет интерфейс редактирования.

Контроллер предоставляет `update(doc)`, `getDocument()`, `destroy()`, `checkOverflow()`, `goToSlide(index)`, `next()`, `previous()`. Индекс слайда начинается с нуля. `synchronize(doc)` доступен только в режиме редактирования, когда внешний редактор уже обновил DOM.

Изменения применяются явно:

```js
const next = controller.getDocument();
next.title = 'Новое название';
controller.update(next);
// При удалении экрана/компонента:
controller.destroy();
```

В React/Vue и других приложениях создавай контроллер после появления DOM-контейнера и уничтожай при размонтировании. Renderer владеет дочерними узлами своего контейнера; не размещай в нём параллельно управляемые приложением элементы.

## Документ и виджеты

`{schemaVersion: 3, kind: 'page' | 'presentation', title, pages, modals?}`.

В режиме `page` массив `pages` содержит **секции одной веб-страницы**, а в `presentation` — слайды. Это не маршруты многостраничного сайта.

Секция содержит `id`, `title`, `grid`, `widgets`; дополнительно — `composition`, `appearance`, `role`, `transition`, `layoutVariant`. Типовая сетка: `{columns: 12, rowHeight: 64, gap: 16}`. `appearance.layout: 'flow'` используется для адаптивных композиций страницы, `'fixed'` — для фиксированной сетки.

Каждый виджет имеет `id`, `type`, `position: {col, row, width, height}`. Колонки и строки начинаются с **1**. ID уникальны во всём документе, начинаются с латинской буквы и имеют длину до 64 символов; далее разрешены буквы, цифры, `_`, `-`.

| Тип | Основное содержание |
| --- | --- |
| `text` | `content`: блоки `heading`, `paragraph`, `list`, `divider`, `callout`, `link` |
| `image` | `src`, непустой `alt`, `fit: 'cover' | 'contain'`, `caption` |
| `metric` | `value`, `note` |
| `calendar` | `date` в формате `YYYY-MM-DD` |
| `table` | `columns: [{key, label}]`, `rows: [{[key]: value}]`, `pageSize` |
| `button` | `label`, `action`, `variant: 'primary' | 'secondary'` |
| `quote` | `text`, `author` |
| `cards` | `items: [{title, text}]` |
| `gallery` | `items: [{src, alt, caption}]` |

Не добавляй произвольные поля в JSON: схема строгая. Проверяй весь документ перед отображением и после структурных правок. Виджеты не должны пересекаться или выходить за колонки; минимальные размеры доступны в `widgetRegistry`. Допускается до 100 секций/слайдов и 100 виджетов в каждой секции.

Композиции выбирай из `compositionCatalog(kind)`. Несовместимая смена композиции отклоняется; для другой структуры создавай новую секцию. Ручной текст заменяется в полях JSON, а не через HTML-разметку.

## Действия, оформление и слайды

- Кнопка: `{type: 'link', href}`, `{type: 'section', target}`, `{type: 'slide', target}`, `{type: 'modal', target}` либо `{type: 'close'}`. Цель должна существовать и соответствовать виду документа.
- Модальное окно в `doc.modals`: `{id, title, text}`.
- Ссылки: относительные адреса и HTTP(S). `javascript:`, `mailto:`, `tel:` и адреса с начальным `//` не поддерживаются.
- Темы: `light`, `contrast`, `accent`, `image`. У изображений есть `focalPoint` и `mobileFocalPoint` с координатами `x/y` от 0 до 100.
- Движение: `motion: {effect, speed, intensity, step}`. Эффекты: `none`, `fade`, `rise`, `scale`, `sequence`. Шаг 0 виден сразу; положительные шаги раскрываются навигацией презентации. Учитывается reduced motion.
- Презентация: 1600×900, масштабируется целиком. Проверка допустимой сетки не заменяет измерение переполнения текста.
- `fitSlide()` требует браузера, CSS, шрифтов и доступных изображений. Возвращает `{success, slide, changes, issues, candidates}`; исходный документ автоматически не заменяет и текст не сокращает.
- Если подбор не прошёл, покажи замечания и предложи разделить слайд либо изменить настройки. При печати CSS раскладывает слайды на отдельные страницы.

## CSS-компоненты без JSON

Используй контейнер `.af`, чтобы применились базовые шрифты и правила компонентов:

```html
<div class="af">
  <button type="button" class="af-btn">Основное действие</button>
  <label class="af-field">
    <span class="af-label">Название</span>
    <input class="af-input" name="title">
  </label>
</div>
```

`Alabuga.initComponents(root)` обслуживает `dialog.af-dialog`, атрибуты `data-af-dialog-open`, `data-af-dialog-close`, `data-af-dismiss` и формы `form[data-af-validate]`. Валидная форма создаёт событие `af:submit` с `FormData` в `event.detail`; отправку и хранение реализует принимающее приложение. Перед удалением HTML вызови возвращённую функцию очистки. JSON-renderer подключает своё поведение сам.

## Ограничения переноса

1. IIFE и ESM-сборка `alabuga.js` содержат публичный API корневого модуля. `exportHTML`, `embedLocalImage`, `brandAssets` и `demoDocument` в этот API не входят. Не вызывай несуществующий `Alabuga.exportHTML()`.
2. `asset:<sha256>` — ссылка на материал приложения. В чужом репозитории исходная IndexedDB отсутствует: нужен свой синхронный `resolveAsset(id)` либо замена ссылок на доступные URL/data до отображения.
3. Готовая IIFE — браузерный скрипт, не API для SSR. Измерение слайдов и отображение требуют DOM.
4. CSS использует глобальные переменные `--af-*` на `:root` и правило `@page` для презентаций. Встраивание не создаёт Shadow DOM: учитывай общие стили и печать принимающего приложения.
5. Наличие двух файлов не предоставляет конструктор, сохранение проектов, ИИ, HTML-экспорт или публикацию сайта. Эти возможности относятся к отдельным модулям/приложениям исходного репозитория.
6. Исходный npm workspace пока не упакован как самостоятельный JS-пакет: exports ведут на `.ts`, сборка использует корень монорепозитория, обычный `npm pack` не включает игнорируемый `dist`. Импорты `@alabuga/framework/...` не появятся от копирования JS/CSS.

## Проверка интеграции и задание агенту

После подключения проверь загрузку JS/CSS, отсутствие ошибок в консоли, `Alabuga.VERSION`, результат `validateDocument()`, наличие и декодирование изображений. Для сайта проверь узкий экран; для презентации — переполнение после загрузки шрифтов/изображений, навигацию и печать. Проверь вызов `destroy()` при удалении экрана.

Пример задания агенту принимающего репозитория:

> Прочитай FRAMEWORK_AGENT_GUIDE.md. Подключи локальные файлы Alabuga Framework из apps/frontend/public/alabuga. Собери страницу из штатных композиций с моим содержанием. Используй материалы из apps/frontend/public/assets, настрой их URL под базовый путь нашего приложения. Валидируй JSON, проверь адаптивность и очистку контроллера. Используй API готовой сборки; не добавляй конструктор или ИИ-сервер.

При обновлении библиотеки замени JS/CSS и необходимые материалы, сопоставь `Alabuga.VERSION` с версией этого руководства. Если доступен исходный репозиторий, точные контракты находятся в `packages/framework/src/schema.ts`, публичные экспорты сборки — в `packages/framework/src/index.ts`, дополнительные модульные точки входа — в `packages/framework/package.json`.
