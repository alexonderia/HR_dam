# Подбор кандидатов — спецификация MVP

**Стек:** PostgreSQL (данные), SeaweedFS через S3 API (файлы). 8 таблиц.

## 1. Схема данных

Обозначения: `PK` — первичный ключ; `FK →` — внешний ключ; `UQ` — уникальность; `?` — NULL; `[]` — массив PostgreSQL. Неуказанные значения по умолчанию не предполагаются.

```text
clusters
  id                 UUID PK
  name               VARCHAR(255)
  track              VARCHAR(20)       # одно из двух значений
  comment            TEXT?
  is_active          BOOLEAN DEFAULT TRUE

profiles
  id                 UUID PK
  cluster_id         UUID FK → clusters.id
  position_name      VARCHAR(255)
  education          TEXT?
  experience         TEXT?
  keywords           TEXT[]?
  stop_factors       TEXT[]?
  comment            TEXT?
  is_active          BOOLEAN DEFAULT TRUE

candidates
  id                 UUID PK
  phone              VARCHAR(20) UQ    # нормализованный
  last_name          VARCHAR(100)
  first_name         VARCHAR(100)
  middle_name        VARCHAR(100)?
  created_at         TIMESTAMPTZ
  updated_at         TIMESTAMPTZ

candidate_blacklist
  id                 UUID PK
  phone              VARCHAR(20)       # нормализованный
  last_name          VARCHAR(100)
  first_name         VARCHAR(100)
  middle_name        VARCHAR(100)?
  company_name       VARCHAR(255)
  is_active          BOOLEAN DEFAULT TRUE

files
  id                 UUID PK
  bucket             VARCHAR(255)
  object_key         TEXT
  file_name          TEXT
  mime_type          VARCHAR(100)?
  size_bytes         BIGINT?
  file_sha256        CHAR(64)?
  created_at         TIMESTAMPTZ

resumes
  id                 UUID PK
  candidate_id       UUID FK → candidates.id UQ
  file_id            UUID FK → files.id UQ
  status             VARCHAR(20)
  scoring_status     VARCHAR(20)
  created_at         TIMESTAMPTZ
  updated_at         TIMESTAMPTZ

profile_ratings
  id                 UUID PK
  resume_id          UUID FK → resumes.id
  profile_id         UUID FK → profiles.id
  score              NUMERIC(5,2)     # 0..100
  matched_keywords   JSONB?
  triggered_stop_factors JSONB?
  details            JSONB?
  explanation        TEXT?
  calculated_at      TIMESTAMPTZ

resume_events
  id                 UUID PK
  resume_id          UUID FK → resumes.id
  event_type         VARCHAR(50)
  actor_id           UUID?
  recipient_id       UUID?
  message            TEXT?
  created_at         TIMESTAMPTZ
```

**Ограничения и индексы:**
- `candidates`: `UNIQUE(phone)`; совпадение телефона при различии ФИО требует проверки.
- `candidate_blacklist`: **нет `candidate_id` и FK на `candidates`**; индекс `(phone, last_name, first_name, middle_name) WHERE is_active = TRUE`.
- `files`: `UNIQUE(bucket, object_key)`.
- `resumes`: `UNIQUE(candidate_id)`, `UNIQUE(file_id)` — одно актуальное резюме на кандидата.
- `profile_ratings`: `UNIQUE(resume_id, profile_id)`, `CHECK(score BETWEEN 0 AND 100)`.
- `profiles`: индекс `cluster_id`.

## 2. Статусы

`resumes.status`:
- `in_work` — доступно для отбора; замена файла разрешена, статус остаётся `in_work`.
- `in_process` — в обработке (собеседование/трудоустройство); замена запрещена.
- `historical` — обработка завершена; замена разрешена, новый статус `in_work`.

Переходы: `in_work → in_process → historical`; повторная загрузка из `in_work`/`historical` → `in_work`.

`resumes.scoring_status`:
- `pending` — ожидает оценки;
- `processing` — оценивается;
- `completed` — актуальные рейтинги сохранены;
- `failed` — ошибка, повторный запуск → `pending`.

Переходы: `pending → processing → completed | failed`. Бизнес-статус и статус оценки независимы.

## 3. Сценарий

1. **Форма:** телефон, фамилия, имя, отчество (если есть), файл PDF/DOCX.
2. **PostgreSQL:** проверить `candidate_blacklist` по нормализованному телефону **и ФИО** только при `is_active = TRUE`; найти/создать `candidates` по телефону (ФИО — дополнительная проверка); проверить `resumes.status`; подготовить `files.object_key`.
3. **SeaweedFS:** загрузить файл через S3 API. Только после успеха привязать `file_id` в `resumes` (`in_work`, `pending`); при замене очистить прежние `profile_ratings`. При ошибке убрать незакреплённые объекты/метаданные.
4. **Оценка:** отправить обработчику файл и **текущие требования всех активных кластеров и профилей**; получить рейтинг каждого профиля (в ответе — группировка по кластерам).
5. **PostgreSQL:** перед записью сверить `resume_id` и полученный `file_id` с текущим `resumes.file_id`; если совпадает — одной транзакцией записать `profile_ratings`, установить `completed`, создать `scored`; при ошибке — `failed` и `scoring_failed`. Ответ старого файла игнорировать.
6. **Итоговая таблица:** `candidates → resumes → profile_ratings → profiles → clusters`; вывод: ФИО, телефон, кластер, профиль, рейтинг, статус.

## 4. Замена, логирование, правила

- Новое резюме при `in_work`/`historical`: заменить **ссылку на файл**, пересчитать рейтинги, событие `replaced`. В `in_process`: отказ + `replacement_rejected`, без изменений файла и оценок.
- События `resume_events.event_type`: `uploaded`, `replaced`, `replacement_rejected`, `scored`, `scoring_failed`, `status_changed`.
- Для простого уведомления заполнить `recipient_id` и `message`; доставки/прочтения в MVP нет.
- Чёрный список хранится независимо от кандидатов. Совпадение ищется по телефону и ФИО; **правило блокировки после совпадения отдельно не задано**.
- Требования хранятся только текущие; при их изменении старые рейтинги автоматически не пересчитываются.
- **Не предусмотрены:** `revision`, версии требований, отдельная таблица проверок, отдельная таблица уведомлений, `resumes.taken_by`/`taken_at`, `profile_ratings.is_eligible`.
- Файл хранится в SeaweedFS, `files` содержит метаданные; PostgreSQL и S3 не образуют единую транзакцию.
