# Целевая архитектура обработки резюме и контракт resume-analyzer

## Поток обработки

1. Фронтенд отправляет одиночное резюме или ZIP без обязательного указания кандидатов. Backend проверяет файлы, распаковывает архив и отправляет отдельное задание на каждый документ в `hr.resume.storage`.
2. Worker сохраняет документ в S3 и только после успешной записи публикует задание со ссылкой на файл в `hr.resume.analysis`.
3. Resume-analyzer получает задание, скачивает документ, извлекает данные кандидата и оценивает резюме. Начало обработки отправляет в `hr.resume.progress`, результат или ошибку — в `hr.resume.results`.
4. Backend последовательно принимает результаты. В одной транзакции создаёт или находит кандидата, сохраняет резюме, ссылку на S3 и рейтинги, проверяет чёрный список. Фронтенд обновляет список и счётчики.

RabbitMQ передаёт JSON-сообщения. Распаковку, запись в S3 и работу с БД выполняют backend/worker. Бинарные документы через RabbitMQ не передаются. Одиночная загрузка и повторная оценка используют тот же поток.

Список файлов и события обработки хранятся в очередях RabbitMQ; успешная обработка подтверждается записями в БД. `pending_files = total_files - processed_files - failed_files`. Новые таблицы и поля для прогресса не нужны. ФИО и телефон кандидата допускают `null`.

## Что реализовать в resume-analyzer

- AMQP consumer очереди `hr.resume.analysis` и publisher для прогресса и результатов.
- Скачивание PDF, DOCX, DOC, RTF, TXT из S3 по подписанной ссылке, проверку размера и SHA-256; обновление истёкшей ссылки через backend.
- Извлечение текста, фамилии, имени, отчества и телефона. Отсутствующие данные возвращать как `null`; найденный телефон — в международном формате, невалидный — `null`.
- Анализ по снимку `requirements` из задания: одна оценка для каждого переданного профиля, без пропусков, дубликатов и посторонних UUID.
- Подтверждения доставки, обработку повторных заданий и ошибок по правилам ниже. Запись кандидатов, рейтингов и проверку чёрного списка выполняет backend.

Нативный AMQP consumer предстоит добавить в resume-analyzer отдельно. Собственный HTTP endpoint для получения заданий ему не требуется: API взаимодействия с RabbitMQ — сообщения AMQP.

## AMQP API

В Compose: `rabbitmq:5672`, vhost `/`, учётные данные `RABBITMQ_USER` / `RABBITMQ_PASSWORD`. Для внешнего analyzer нужен доступный адрес брокера и S3. Очереди объявляет приложение. Exchange: `""`, routing key: имя очереди. Сообщения: JSON UTF-8, `content_type=application/json`, `delivery_mode=2`; очереди durable.

| Очередь | Направление | Назначение |
| --- | --- | --- |
| `hr.resume.analysis` | worker → resume-analyzer | Задание анализа одного документа |
| `hr.resume.progress` | resume-analyzer → backend | Начало обработки документа |
| `hr.resume.results` | resume-analyzer → backend | Успешный результат или ошибка |

Analyzer не потребляет служебные очереди `hr.resume.storage`, `hr.resume.batch.*`, `*.retry`, `hr.resume.dead`.

### Общие поля всех сообщений

```json
{
  "version": 1,
  "job_id": "a0000000-0000-4000-8000-000000000001",
  "batch_id": "b0000000-0000-4000-8000-000000000001",
  "item_id": "a0000000-0000-4000-8000-000000000001",
  "attempt": 1
}
```

`job_id` — идентификатор попытки, `batch_id` — загрузки, `item_id` — документа; `attempt` — номер попытки от 1 до 100. Analyzer копирует их из задания без изменений. При ручном повторе backend меняет `job_id` и увеличивает `attempt`; при повторной доставке брокером значения сохраняются. AMQP `correlation_id` рекомендуется равным `job_id`.

**Каждый JSON ниже — дополнение к общим полям. В RabbitMQ отправляется один объект: общие поля вместе с указанным содержимым.**

### Вход: `hr.resume.analysis`

```json
{
  "file": {
    "id": "a0000000-0000-4000-8000-000000000001",
    "file_id": "f0000000-0000-4000-8000-000000000001",
    "source_path": "folder/resume.pdf",
    "file_name": "resume.pdf",
    "mime_type": "application/pdf",
    "size_bytes": 12345,
    "sha256": "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
    "bucket": "resumes",
    "object_key": "resume-imports/resume.pdf",
    "download_url": "http://seaweedfs:8333/resumes/resume-imports/resume.pdf?X-Amz-Signature=example",
    "download_url_expires_at": "2026-10-16T12:00:00.000Z",
    "candidate_hint": { "last_name": null, "first_name": null, "middle_name": null, "phone": null }
  },
  "requirements": [{
    "id": "c0000000-0000-4000-8000-000000000001",
    "name": "ИТ", "track": "it", "comment": "", "is_active": true,
    "profiles": [{
      "id": "d0000000-0000-4000-8000-000000000001",
      "cluster_id": "c0000000-0000-4000-8000-000000000001",
      "position_name": "Разработчик", "education": "", "experience": "",
      "keywords": ["Python"], "stop_factors": [], "comment": "", "is_active": true
    }]
  }]
}
```

`file.id` соответствует документу загрузки, `file.file_id` — записи файла. `candidate_hint` содержит необязательные данные из формы; его непустые поля имеют приоритет при сохранении backend. Для повторной оценки возможны `file.target_resume_id` и `file.target_updated_at`; возвращать их в результате не нужно. Требования из задания нельзя заменять актуальными настройками из БД.

### Выход: успешный результат в `hr.resume.results`

```json
{
  "status": "completed",
  "candidate": { "last_name": "Иванов", "first_name": "Иван", "middle_name": null, "phone": "+79991234567" },
  "analysis": { "clusters": [{
    "id": "c0000000-0000-4000-8000-000000000001",
    "profiles": [{
      "id": "d0000000-0000-4000-8000-000000000001", "score": 82,
      "matched_keywords": ["Python"], "triggered_stop_factors": [],
      "details": {}, "explanation": "Опыт соответствует требованиям."
    }]
  }] }
}
```

Обязательны `candidate`, `analysis`, UUID кластеров/профилей и `score` от 0 до 100. Поля внутри `candidate` допускают `null` или отсутствие. `matched_keywords`, `triggered_stop_factors`, `details`, `explanation` необязательны. Не добавляйте в результат исходные `file`, `requirements` и другие поля вне схемы.

### Выход: ошибка в `hr.resume.results`

```json
{
  "status": "failed",
  "error": { "code": "TEXT_EXTRACTION_FAILED", "message": "Не удалось извлечь текст документа." }
}
```

`code` — до 100 символов, `message` — до 2000, без трассировок и секретов. Ошибка отображается сотруднику; кандидат и резюме для неуспешного импорта не создаются.

### Выход: начало обработки в `hr.resume.progress`

```json
{
  "stage": "processing",
  "created_at": "2026-10-16T11:00:00.000Z"
}
```

Отправляйте после готовности приступить к анализу. Analyzer публикует только `processing`; остальные состояния формирует приложение.

### Доставка и повторы

- Использовать manual ACK и `prefetch=1` на consumer. Результат публиковать persistent-сообщением, дождаться publisher confirm, затем подтвердить входное задание. Для результата `message_id=job_id`, для прогресса — `job_id:processing`.
- Повторная доставка допустима; backend применяет успешный результат идемпотентно по `job_id`, подтверждая сообщение после сохранения в БД. Результаты устаревших ручных попыток игнорируются.
- Временная недоступность модели или сети требует ожидания/повтора с задержкой. Не запускать немедленный бесконечный NACK/requeue. Невосстановимую ошибку документа возвращать как `status=failed`.
- Время обработки должно укладываться в настроенный acknowledgement timeout брокера.

## Вспомогательный HTTP API backend

Для обновления истёкшей ссылки (срок — один час):

```http
POST /api/internal/resume-imports/{batch_id}/items/{item_id}/download-url
Authorization: Bearer <RESUME_ANALYZER_CALLBACK_TOKEN>
```

В Compose базовый адрес — `http://backend:3001`. Ответ 200: `{ "download_url": "...", "download_url_expires_at": "..." }`; 401 — неверный токен, 404 — неизвестный документ, 409 — файл ещё не сохранён. Hostname подписанной ссылки менять нельзя.

Вместо прямой AMQP-публикации доступны `POST /api/internal/resume-results` и `POST /api/internal/resume-progress`: те же полные тела сообщений и Bearer-токен; ответ 202 после публикации в RabbitMQ. Получение заданий остаётся через AMQP.

## Режимы приложения и подключение analyzer

Значения задаются в корневом `.env` одинаково для backend и worker:

| `RABBITMQ_ENABLED` | `RANK_BRIDGE_ENABLED` | Обработка |
| --- | --- | --- |
| `false` | `true` | Без брокера: очередь в постоянном томе → S3 → временный HTTP `/rank` |
| `true` | `true` | RabbitMQ → временный адаптер `/rank` → RabbitMQ |
| `true` | `false` | Целевая архитектура: RabbitMQ → нативный consumer resume-analyzer |

После изменения переменных остановите backend/worker и пересоздайте контейнеры:

```powershell
docker compose stop backend worker
docker compose --profile broker up -d --build --wait
```

Для режима без брокера вторую команду замените на `docker compose up -d --build --wait`, затем остановите RabbitMQ: `docker compose stop rabbitmq`. Обычный `restart` не обновляет окружение. Незавершённые задания между режимами автоматически не переносятся; сначала завершите их в исходном режиме.

Нативный consumer запускается отдельно с `RANK_BRIDGE_ENABLED=false`, чтобы адаптер не забирал его задания. Без брокера всегда используется `/rank`. Текущий `/rank` возвращает только оценки; извлечение данных кандидата нужно реализовать в новом consumer.

Точные схемы сообщений: [imports.ts](../packages/contracts/src/imports.ts); формат рейтингов: [domain.ts](../packages/contracts/src/domain.ts).
