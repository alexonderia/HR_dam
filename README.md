# HR DAM — распределение кандидатов по кластерам

Веб-приложение на React + TypeScript с Alabuga Framework, API, фоновой обработкой,
антивирусом, PostgreSQL и S3. После подготовки окружения — `docker compose up -d --build`,
интерфейс: http://localhost:3000.

[Карта документации: где и что описано](docs/README.md).

[Памятка пользователя: функции и порядок работы](apps/frontend/src/content/user-guide.md).
В приложении: «Памятка пользователя» в меню или http://localhost:3000/help;
доступны оглавление, скачивание Markdown и печать / сохранение PDF.

[Описание приложения, сценарии, правила и разработка](docs/application.md).
[Состав приложений и история предыдущего протокола](docs/architecture.md).
[Подключение агента Ollama, Compose и проверка отказов модели](docs/analysis.md).

Подготовка гостевого и авторизованного режимов реализована. Разборщик и оценщик собираются из этого репозитория и включаются профилем `processing`; без этого профиля задания ожидают обработчиков. Документы:
[целевая архитектура](docs/target-architecture.md),
[временное хранение и удаление гостевых данных](docs/guest-task-lifecycle.md),
[контракты разборщика и оценщика](docs/processing-services-contract.md),
[план реализации](docs/implementation-plan.md).

## PostgreSQL + Flyway + SeaweedFS

Минимальная инфраструктура по [спецификации](docs/candidate_matching_architecture.md):
Бизнес-схема V1–V6, авторизация и задачи обработки V7; постоянный и временный S3 bucket.
Образы закреплены: PostgreSQL `16.13-alpine3.23`, Flyway `12.1.0`, SeaweedFS
`4.29`, AWS CLI `2.27.49` (только одноразовая инициализация bucket), pgAdmin `9.18`.

## Запуск

В новом окружении скопируйте `.env.example` в `.env` и заполните
`POSTGRES_PASSWORD`, `S3_ACCESS_KEY`, `S3_SECRET_KEY`, `PGADMIN_PASSWORD`,
ключи режимов и брокера (их создаёт `npm run prepare:environment`)
уникальными значениями; задайте `PGADMIN_EMAIL` для входа в админку.
В текущем рабочем каталоге `.env` уже создан со случайными учётными данными;
он исключён из Git. Значения в `.env.example` не содержат секретов.

```powershell
if (-not (Test-Path .env)) { Copy-Item .env.example .env }

npm run prepare:environment
docker compose up -d --build
docker compose ps -a
docker compose logs flyway s3-init
```

Для обычного перезапуска без изменения кода достаточно `docker compose restart`.
После изменения `.env` примените настройки через `docker compose up -d --no-build`.
Текущий запуск использует отдельные очереди гостевого и авторизованного режимов.
Старые переключатели `RABBITMQ_ENABLED`, `ANALYZER_ADAPTER`, `RANK_BRIDGE_ENABLED`
и профиль `broker` к нему не относятся. `worker` и `resume-analyzer` сохранены в исходниках
для прежней реализации; основной Compose их не запускает.
Если изменён один сервис, собирайте и пересоздавайте только его, например:

```powershell
docker compose build backend
docker compose up -d --no-build --no-deps backend
```

Frontend запускается независимо от backend и PostgreSQL. Auth-check проверяет
сессию по открытому ключу, guest-api использует отдельные S3/AMQP credentials.
Единственный опубликованный прикладной порт — 3000.
[Порядок включения обработки и подключения обработчиков](docs/preparation.md).

Учётную запись сотрудника создают после миграций:

```powershell
$env:HR_USER_LOGIN = "hr-admin"
$env:HR_USER_NAME = "Администратор"
$hrPassword = Read-Host "Пароль (минимум 12 символов)" -AsSecureString
$env:HR_USER_PASSWORD = [Net.NetworkCredential]::new("", $hrPassword).Password
npm run user:create
Remove-Item Env:HR_USER_PASSWORD
```

Для сборки обработчиков и подключения Ollama на хосте используйте профиль обработки:

```powershell
docker compose --profile processing -f docker-compose.yml -f docker-compose.local-ollama.yml up -d --build
```

Он подключается к `http://host.docker.internal:11434` и не запускает контейнеры
`ollama`/`ollama-init`, поэтому доступ к NVIDIA GPU из Docker не требуется.
Для модели на другой машине задайте `LOCAL_OLLAMA_BASE_URL=http://<IP>:11434`
в `.env`; имя установленной модели задаётся через `OLLAMA_MODEL`.
Подготовка Ollama и переключение режимов описаны в [инструкции](docs/analysis.md#ollama-на-хосте).

Контейнеры имеют фиксированные имена без суффикса `-1`: `hr_dam-postgres`,
`hr_dam-pgadmin`, `hr_dam-flyway`, `hr_dam-seaweedfs`, `hr_dam-s3-init`.

`flyway` и `s3-init` должны завершиться с кодом 0; PostgreSQL и SeaweedFS —
иметь статус `healthy`, как и pgAdmin. Flyway ждёт готовности PostgreSQL; инициализация
bucket ждёт healthcheck SeaweedFS и проверяет подписанный S3 запрос.
Существующий bucket не изменяется. `clean` и автоматический baseline Flyway
отключены. Пустые секреты блокируют запуск конфигурации.

## Подключение

| Параметр | С хоста | В сети Compose |
| --- | --- | --- |
| PostgreSQL | Не опубликован | `postgres:5432` |
| База / пользователь | `POSTGRES_DB` / `POSTGRES_USER` из `.env` | те же |
| Пароль PostgreSQL | `POSTGRES_PASSWORD` из `.env` | тот же |
| S3 endpoint | Не опубликован | `S3_INTERNAL_ENDPOINT`, по умолчанию `http://seaweedfs:8333` |
| Bucket / регион | `S3_BUCKET=resumes` / `S3_REGION=us-east-1` | те же |
| Ключи S3 | `S3_ACCESS_KEY` / `S3_SECRET_KEY` из `.env` | те же |

S3 клиент использует path-style адресацию. PostgreSQL, S3 и RabbitMQ доступны
только во внутренних сетях Compose. Для pgAdmin включите профиль `administration`.

## Админка PostgreSQL

После `docker compose --profile administration up -d pgadmin` откройте [pgAdmin](http://127.0.0.1:5050). Логин — `PGADMIN_EMAIL`, пароль —
`PGADMIN_PASSWORD` из `.env`. Порт задаётся через `PGADMIN_PORT`.
В текущем окружении логин — `admin@example.com`, пароль сгенерирован случайно.

Подключение `HR DAM → Candidate Matching` настроено автоматически при первом
запуске. При открытии сервера введите `POSTGRES_PASSWORD` из `.env`.
Таблицы: `Databases → candidate_matching → Schemas → public → Tables`.
SQL можно выполнять через Query Tool. Изменения схемы оформляйте миграциями.

Пользователи, сохранённые подключения и настройки pgAdmin хранятся в volume
`pgadmin_data`. Смена `PGADMIN_PASSWORD` в `.env` не меняет пароль уже созданного
пользователя; используйте меню изменения пароля в pgAdmin. Если изменены
`POSTGRES_DB` или `POSTGRES_USER`, обновите сохранённое подключение в интерфейсе.
Конфигурация использует официальный
[механизм импорта подключений](https://www.pgadmin.org/docs/pgadmin4/latest/container_deployment.html).

```powershell
docker compose logs -f pgadmin
docker compose restart pgadmin
```

## Остановка и логи

```powershell
docker compose logs -f postgres seaweedfs
docker compose logs flyway s3-init
docker compose stop
docker compose up -d --no-build
docker compose down
```

`down` сохраняет именованные volumes. Не используйте `down -v`, если данные
нужно сохранить. PostgreSQL хранится в `postgres_data`; объекты, метаданные
master и встроенного filer SeaweedFS — в `seaweedfs_data`. Встроенный LevelDB
filer хранит внутреннюю структуру S3; метаданные приложения находятся только
в таблице `files`, отдельный сервер БД для SeaweedFS не создаётся.
Смена пароля в `.env` не меняет пароль уже инициализированного PostgreSQL.

## Миграции и проверка

Первичная схема: `db/migrations/V1__initial_schema.sql`. Миграции V1–V6
сохранены в исходном виде. Изменения авторизации и обработки от 9 ноября
объединены в `V7__authentication_and_processing.sql`; таблицы сотрудников
называются `users` и `sessions`. Следующие изменения добавлять отдельными
миграциями, без сброса схемы и удаления данных.

```powershell
docker compose up -d --build
docker compose run --rm flyway info
docker compose run --rm flyway validate
npm run test:processing
```

Актуальная сквозная проверка — `npm run test:processing`: отдельный Compose
project, реальные S3 CAS и RabbitMQ retries/DLQ, синтетические документы,
авторизация и рестарты outbox. Исторический `scripts/verify.py` проверяет исходную
схему V1 и не используется для текущей схемы.

## Недостающие сведения

Спецификация говорит о двух значениях `clusters.track`, но не называет их.
Поэтому поле реализовано как обязательный `VARCHAR(20)` без выдуманного
CHECK. После уточнения значения следует закрепить новой миграцией.
Приложение предупреждает о совпадении с чёрным списком, продолжая оценку резюме.
Правила приложения и пределы встроенного обработчика описаны в [документации](docs/application.md).

Использованы поддерживаемые механизмы
[учётных данных SeaweedFS](https://github.com/seaweedfs/seaweedfs/wiki/S3-Credentials),
[встроенного filer](https://github.com/seaweedfs/seaweedfs/wiki/Filer-Stores) и
[запрета Flyway clean](https://documentation.red-gate.com/fd/flyway-clean-disabled-setting-277578981.html).

## Обработка

ZIP/PDF направляются в prepare, готовые документы — в evaluate. Команды и события
используют фиксированные quorum queues в `hr-guest` и `hr-authorized`, mandatory
и publisher confirms. Guest API хранит состояние только в `guest-temporary`;
backend сохраняет задачи и outbox в PostgreSQL. В новом Compose нет worker и rank bridge.

Для подключения образов из другой ветки задайте `PREPARE_IMAGE` / `EVALUATE_IMAGE`
и запустите `docker compose --profile processing up -d`.
[Контракт подключения и переход с v1](docs/preparation.md).

Проверки: `npm run build`, `npm test`, `npm run test:architecture`,
`npm run test:processing`. Последняя команда использует отдельный Compose
project, синтетические файлы и тестовых обработчиков протокола. Прежние
`test:workflow`, `test:queue`, `test:rank-modes` относятся к v1.

Backup сохраняет постоянный bucket и PostgreSQL, включая outbox. Временный bucket,
буферы Nginx и `.secrets` не копируются. Ключи и настройки окружения хранят отдельно.
