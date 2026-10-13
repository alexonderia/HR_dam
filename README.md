# HR DAM — распределение кандидатов по кластерам

Веб-приложение на React + TypeScript с Alabuga Framework, API, фоновой обработкой,
антивирусом, PostgreSQL и S3. Запуск: `docker compose up -d --build`,
интерфейс: http://localhost:3000.

[Описание приложения, сценарии, правила и разработка](docs/application.md).
[Разделение frontend, backend, worker и resume-analyzer](docs/architecture.md).
[Подключение агента Ollama, Compose и проверка отказов модели](docs/analysis.md).

## PostgreSQL + Flyway + SeaweedFS

Минимальная инфраструктура по [спецификации](docs/candidate_matching_architecture.md):
8 прикладных таблиц, служебная `flyway_schema_history`, S3 bucket для резюме.
Образы закреплены: PostgreSQL `16.13-alpine3.23`, Flyway `12.1.0`, SeaweedFS
`4.29`, AWS CLI `2.27.49` (только одноразовая инициализация bucket), pgAdmin `9.18`.

## Запуск

В новом окружении скопируйте `.env.example` в `.env` и заполните
`POSTGRES_PASSWORD`, `S3_ACCESS_KEY`, `S3_SECRET_KEY`, `PGADMIN_PASSWORD`
уникальными значениями; задайте `PGADMIN_EMAIL` для входа в админку.
В текущем рабочем каталоге `.env` уже создан со случайными учётными данными;
он исключён из Git. Значения в `.env.example` не содержат секретов.

```powershell
if (-not (Test-Path .env)) { Copy-Item .env.example .env }
docker compose up -d --build
docker compose ps -a
docker compose logs flyway s3-init
```

Для Ollama, установленной на хосте вне Docker, используйте отдельный режим:

```powershell
docker compose -f docker-compose.yml -f docker-compose.local-ollama.yml up -d --build
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
| PostgreSQL | `127.0.0.1:5432` | `postgres:5432` |
| База / пользователь | `POSTGRES_DB` / `POSTGRES_USER` из `.env` | те же |
| Пароль PostgreSQL | `POSTGRES_PASSWORD` из `.env` | тот же |
| S3 endpoint | `S3_ENDPOINT`, по умолчанию `http://127.0.0.1:8333` | `S3_INTERNAL_ENDPOINT`, по умолчанию `http://seaweedfs:8333` |
| Bucket / регион | `S3_BUCKET=resumes` / `S3_REGION=us-east-1` | те же |
| Ключи S3 | `S3_ACCESS_KEY` / `S3_SECRET_KEY` из `.env` | те же |

S3 клиент должен использовать path-style адресацию. Порты задаются через
`POSTGRES_PORT` и `S3_PORT`; при изменении S3 порта обновите `S3_ENDPOINT`.
Сервисы по умолчанию опубликованы только на `BIND_ADDRESS=127.0.0.1`.
Внутренние порты master/filer/volume на хост не публикуются.

## Админка PostgreSQL

Откройте [pgAdmin](http://127.0.0.1:5050). Логин — `PGADMIN_EMAIL`, пароль —
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
docker compose up -d --build
docker compose down
```

`down` сохраняет именованные volumes. Не используйте `down -v`, если данные
нужно сохранить. PostgreSQL хранится в `postgres_data`; объекты, метаданные
master и встроенного filer SeaweedFS — в `seaweedfs_data`. Встроенный LevelDB
filer хранит внутреннюю структуру S3; метаданные приложения находятся только
в таблице `files`, отдельный сервер БД для SeaweedFS не создаётся.
Смена пароля в `.env` не меняет пароль уже инициализированного PostgreSQL.

## Миграции и проверка

Первичная схема: `db/migrations/V1__initial_schema.sql`. Применённые миграции
не редактировать; добавлять только новые файлы, например
`db/migrations/V2__description.sql`, без сброса схемы и удаления данных.

```powershell
docker compose up -d --build
docker compose run --rm flyway info
docker compose run --rm flyway validate
python scripts/verify.py
```

Проверка требует Python 3 и работающего Docker, дополнительных Python-пакетов
нет. Она сверяет все столбцы с исходным Markdown, проверяет ограничения,
индексы, историю и повторный запуск миграций, авторизацию S3, загрузку,
чтение и удаление объекта. Для проверки сохранности создаёт одну временную
запись `files` и один объект с уникальным ключом, перезапускает контейнеры
PostgreSQL/SeaweedFS и повторяет `up`. В конце удаляет только эти тестовые
артефакты. При аварийном прерывании процесса они могут остаться.

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
