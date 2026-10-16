# Разделение приложений

Репозиторий использует npm workspaces. Корневой `package.json` содержит только команды оркестрации и инструменты разработки; production-зависимости описаны в каждом приложении или библиотеке. Общий `package-lock.json` фиксирует версии всего репозитория и используется при выборочной установке зависимостей в Docker.

В `.npmrc` задан `install-strategy=nested`: React, Vite и остальные зависимости frontend находятся в `apps/frontend/node_modules`, серверные зависимости — внутри соответствующих приложений, зависимости библиотек — внутри пакетов. Корневой `node_modules` содержит инструменты разработки/тестирования и ссылки workspaces. Он нужен монорепозиторию. Статические ресурсы находятся в `apps/frontend/public`. Стратегия установки описана в [npm ci](https://docs.npmjs.com/cli/commands/npm-ci/#install-strategy).

## Ответственность

| Приложение | Выполняет | Общие пакеты | Runtime |
| --- | --- | --- | --- |
| `apps/frontend` | Интерфейс, клиентская валидация, запросы HTTP | `contracts` | Nginx, статическая сборка |
| `apps/backend` | REST API, загрузки, антивирус, статусы, требования, чёрный список, экспорты | `contracts`, `data-access`, `documents` | Node.js, скомпилированный JS |
| `apps/worker` | Очередь сохранения, запись S3, публикация задания анализа | `contracts`, `data-access` | Node.js, скомпилированный JS |
| `apps/resume-analyzer` | Агент Ollama, извлечение PDF/DOCX, `/rank`, `/health`, `/ready` | — | Python / FastAPI |

У каждого приложения Node.js собственные `package.json`, `tsconfig.json`, `Dockerfile` и `dist`. У Python-сервиса свои `requirements.txt`, код и Dockerfile. Продакшен-образы серверов содержат только выбранные production-зависимости и код нужных пакетов. React/Vite устанавливаются для сборки frontend. Frontend runtime содержит статическую сборку и Nginx.

## Общие пакеты

- `@hr/contracts`: браузерные и серверные типы, схемы Zod, нормализация ФИО/телефона, проверка ответа `POST /rank`. Не обращается к файловой системе, БД или сети.
- `@hr/data-access`: PostgreSQL pool, транзакции, чтение кандидатов/требований операции S3, RabbitMQ и постоянный outbox. Используется только backend и worker.
- `@hr/documents`: извлечение безопасного текста из DOCX. Используется backend для предпросмотра. Python-сервис анализа использует собственный извлекатель PDF/DOCX.

Приложения не импортируют исходники друг друга. Обращение к общему коду идёт через имена пакетов и их `exports`, ведущие в `dist`. Пакеты собираются перед потребителями. Сквозные тесты могут обращаться к нескольким приложениям и их данным; это не production-связь.

## Взаимодействие и Compose

Браузер получает страницу с `frontend:8080`, Nginx проксирует `/api` в backend. `RABBITMQ_ENABLED=true` включает очереди RabbitMQ; `false` — фоновые файловые задания в постоянном `resume_spool/direct` без соединений с брокером. Worker сохраняет файлы в S3, временный адаптер вызывает текущий `/rank`, backend последовательно записывает результаты в восемь существующих таблиц. В режиме с брокером адаптер можно отключить через `RANK_BRIDGE_ENABLED=false` для подключения нативного AMQP consumer. [Контракт и переключение режимов](resume-analyzer-rabbitmq-api.md).

На хосте адрес приложения остаётся http://localhost:3000 (`APP_PORT`). Backend и resume-analyzer доступны во внутренней сети Compose. Frontend не получает переменные PostgreSQL/S3. DNS backend в Nginx обновляется, поэтому замена контейнера backend не требует пересборки frontend.

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

## Изоляция отказа модели

`/api/health` проверяет PostgreSQL. `/api/analysis/status` проверяет HTTP-анализатор, когда включён адаптер `/rank`, либо наличие нативного consumer в режиме брокера. Загрузки принимаются без доступной модели: задания сохраняются в выбранном транспорте и ожидают её восстановления. Кандидаты появляются после успешного результата, прежние оценки сохраняются при неудачном пересчёте. `npm run test:queue` проверяет AMQP-контракт; `npm run test:rank-modes` — оба режима с настоящим HTTP multipart-запросом к тестовому `/rank`.
