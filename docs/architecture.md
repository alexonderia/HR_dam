# Разделение приложений

Репозиторий использует npm workspaces. Корневой `package.json` содержит только команды оркестрации и инструменты разработки; production-зависимости описаны в каждом приложении или библиотеке. Общий `package-lock.json` фиксирует версии всего репозитория и используется при выборочной установке зависимостей в Docker.

## Ответственность

| Приложение | Выполняет | Общие пакеты | Runtime |
| --- | --- | --- | --- |
| `apps/frontend` | Интерфейс, клиентская валидация, запросы HTTP | `contracts` | Nginx, статическая сборка |
| `apps/backend` | REST API, загрузки, антивирус, статусы, требования, чёрный список, экспорты | `contracts`, `data-access`, `documents` | Node.js, скомпилированный JS |
| `apps/worker` | Очередь, отправка в обработчик, проверка и запись результатов | `contracts`, `data-access` | Node.js, скомпилированный JS |
| `apps/ranker` | `POST /rank`, извлечение текста, базовая оценка ключевых слов | `contracts`, `documents` | Node.js, скомпилированный JS |

У каждого приложения собственные `package.json`, `tsconfig.json`, `Dockerfile` и `dist`. Продакшен-образы серверов содержат только выбранные production-зависимости и скомпилированный код нужных пакетов. React/Vite не устанавливаются в backend, worker или ranker. Frontend runtime не содержит Node.js, серверный код, настройки БД или S3.

## Общие пакеты

- `@hr/contracts`: браузерные и серверные типы, схемы Zod, нормализация ФИО/телефона, проверка ответа `POST /rank`. Не обращается к файловой системе, БД или сети.
- `@hr/data-access`: PostgreSQL pool, транзакции, чтение кандидатов/требований и операции S3. Используется только backend и worker.
- `@hr/documents`: извлечение безопасного текста из DOCX. Используется backend для предпросмотра и ranker для оценки.

Приложения не импортируют исходники друг друга. Обращение к общему коду идёт через имена пакетов и их `exports`, ведущие в `dist`. Пакеты собираются перед потребителями. Сквозные тесты могут обращаться к нескольким приложениям и их данным; это не production-связь.

## Взаимодействие и Compose

Браузер получает страницу с `frontend:8080`. Запросы `/api/*` Nginx пересылает в `backend:3001`, сохраняя путь запроса. Worker читает задания из PostgreSQL, получает файлы из S3 и отправляет их в `ranker:3002/rank` либо внешний `RANKER_URL`. Все компоненты запускаются как отдельные сервисы Compose.

На хосте адрес приложения остаётся http://localhost:3000 (`APP_PORT`). Backend и ranker не публикуют свои порты на хост. Frontend не получает переменные PostgreSQL/S3. DNS backend в Nginx обновляется, поэтому замена контейнера backend не требует пересборки frontend.

При переходе с прежней структуры:

```powershell
docker compose up -d --build --remove-orphans
```

`--remove-orphans` удаляет прежний объединённый контейнер `hr_dam-app`; volumes PostgreSQL, SeaweedFS и остальные данные сохраняются. В последующих запусках достаточно обычного `docker compose up -d --build`.

## Независимые сборки

При первоначальной установке выполните `npm ci` в корне. Общие пакеты компилируются командой `npm run build:packages`. Затем приложение можно собрать отдельно:

```powershell
npm run build -w @hr/frontend
npm run build -w @hr/backend
npm run build -w @hr/worker
npm run build -w @hr/ranker
```

Для frontend нужен только предварительно собранный пакет контрактов: `npm run build -w @hr/contracts`. Команда `npm run build` собирает весь репозиторий в порядке зависимостей.

Docker самостоятельно собирает необходимые библиотеки. Например:

```powershell
docker compose build frontend
docker compose build backend
docker compose up -d --no-deps frontend
docker compose up -d --no-deps backend
```

Изменения приложения требуют пересборки только его образа. При изменении общего пакета пересобирайте использующие его приложения. Обновление требований к профилям в БД не требует пересборки контейнеров.

## Проверки границ

`npm run test:architecture` проверяет отсутствие импортов исходников соседних приложений, соответствие импортов заявленным зависимостям, зависимость frontend только от `contracts` среди внутренних пакетов и отсутствие раздачи frontend из backend. Сквозной сценарий `npm run test:integration` проверяет прежние пользовательские действия через Nginx и API.

Механика установки сверена с [npm workspaces / npm ci](https://docs.npmjs.com/cli/commands/npm-ci/); проксирование — с [Nginx proxy_pass](https://nginx.org/en/docs/http/ngx_http_proxy_module.html).
