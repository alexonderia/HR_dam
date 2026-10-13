# Анализ резюме через Ollama

Основной сервис находится в `apps/resume-analyzer`. Обычная команда `docker compose up -d --build` запускает также Ollama с доступом к NVIDIA GPU и загружает Qwen3.5 4B Q4_K_M. Backend, интерфейс и сохранение резюме работают независимо от загрузки/готовности модели. Для анализа добавьте активный кластер и профиль.

## Полный стек с Ollama в Compose

Настройки по умолчанию: `OLLAMA_BASE_URL=http://ollama:11434`, `OLLAMA_MODEL=qwen3.5:4b-q4_K_M`.

```powershell
docker compose up -d --build
docker compose logs -f ollama-init
```

В Compose закреплён официальный образ `ollama/ollama:0.40.3` для обоих контейнеров. `ollama-init` проверяет наличие модели и загружает её только при первом запуске или смене модели. `ollama_data` хранит веса между перезапусками и пересборками. Контейнер Ollama использует одну NVIDIA GPU, выполняет один запрос одновременно и держит в памяти одну модель. Файлы модели занимают около 3,3 ГБ; выполнение также требует памяти под контекст и рабочие буферы. В Windows нужен Docker Desktop с WSL 2 и работающим доступом к NVIDIA GPU. Настройка следует [документации Docker Compose](https://docs.docker.com/compose/how-tos/gpu-support/).

Для проверки:

```powershell
docker compose exec ollama ollama list
docker compose exec ollama ollama ps
```

После первого запроса `ollama ps` должен показывать модель и `100% GPU`. Порт Ollama доступен только внутри сети Compose; анализатор обращается к `http://ollama:11434`.

Пробный анализ синтетических PDF/DOCX без записи кандидатов:

```powershell
Get-Content tests/model.integration.py | docker compose exec -T resume-analyzer python -
```

## Ограничение памяти Ollama

Встроенная Ollama получает `LLAMA_ARG_CACHE_RAM` из `OLLAMA_PROMPT_CACHE_MB`
(по умолчанию 1024 MiB). Это ограничивает кэш состояний прошлых промптов в RAM;
ограничение действует отдельно от количества параллельных запросов и загруженных
моделей. Значение `0` отключает этот кэш. Поддержка переменной проверена в
`--help` llama-server из закреплённого образа. Механизм накопления кэша описан в
[репозитории Ollama](https://github.com/ollama/ollama/issues/18264).

Изменение `OLLAMA_PROMPT_CACHE_MB` в `.env` применяется при пересоздании
контейнера Ollama. Текущий анализ должен завершиться перед пересозданием:

```powershell
docker compose up -d --no-deps ollama
```

В режиме Ollama вне Docker задайте `LLAMA_ARG_CACHE_RAM=1024` в окружении
самой Ollama и перезапустите её. `OLLAMA_PROMPT_CACHE_MB` управляет только
встроенным контейнером. Контекст и формат запросов анализатора не меняются.

## Ollama на хосте

Для Ollama, установленной вне Docker, добавьте `docker-compose.local-ollama.yml`. В этом режиме `ollama` и `ollama-init` исключены из обычного запуска через [профиль Compose](https://docs.docker.com/compose/how-tos/profiles/), доступ к NVIDIA GPU из Docker не требуется. Остальные сервисы, включая Python-анализатор, работают в контейнерах.

В `.env` задайте:

```dotenv
LOCAL_OLLAMA_BASE_URL=http://host.docker.internal:11434
OLLAMA_MODEL=qwen3.5:4b-q4_K_M
```

`LOCAL_OLLAMA_BASE_URL` по умолчанию указывает на хост Docker и в этом режиме имеет приоритет над `OLLAMA_BASE_URL`, даже если в существующем `.env` остался адрес контейнера. Для Ollama на другой машине укажите её адрес, например `LOCAL_OLLAMA_BASE_URL=http://192.168.1.50:11434`. `localhost` внутри анализатора указывает на сам контейнер.

На машине с Ollama проверьте наличие модели командой `ollama list`; если её нет, выполните `ollama pull qwen3.5:4b-q4_K_M`. Если используется другая установленная модель, запишите её точное имя в `OLLAMA_MODEL`.

Ollama должна принимать подключения от контейнеров или другой машины. Для этого настройте `OLLAMA_HOST=0.0.0.0:11434` и перезапустите Ollama. В Windows полностью закройте приложение из трея, задайте пользовательскую переменную окружения и снова запустите приложение; порядок описан в [документации Ollama](https://docs.ollama.com/faq#setting-environment-variables-on-windows). Для отдельного запуска сервера из PowerShell:

```powershell
$env:OLLAMA_HOST='0.0.0.0:11434'
$env:LLAMA_ARG_CACHE_RAM='1024'
ollama serve
```

При первом запуске приложения:

```powershell
docker compose -f docker-compose.yml -f docker-compose.local-ollama.yml up -d --build
docker compose -f docker-compose.yml -f docker-compose.local-ollama.yml logs -f resume-analyzer worker
```

Если ранее запускали контейнерную Ollama, сначала остановите её:

```powershell
docker compose stop ollama-init ollama
docker compose -f docker-compose.yml -f docker-compose.local-ollama.yml up -d --build
```

Проверка подключения из анализатора:

```powershell
docker compose -f docker-compose.yml -f docker-compose.local-ollama.yml exec resume-analyzer python -c "import os, requests; r = requests.get(os.environ['OLLAMA_BASE_URL'].rstrip('/') + '/api/tags', timeout=5); r.raise_for_status(); print(r.json())"
```

Для последующих команд `up`, `logs`, `stop` и `down` используйте те же два `-f`. Чтобы обычные команды `docker compose` автоматически использовали этот режим, можно задать в `.env` `COMPOSE_FILE=docker-compose.yml:docker-compose.local-ollama.yml` и `COMPOSE_PATH_SEPARATOR=:`. Для возврата к контейнерной Ollama удалите эти две настройки и выполните:

```powershell
docker compose up -d --build
```

## Контракт и ошибки

Worker отправляет `POST /rank` с `multipart/form-data`: `file` (PDF/DOCX до 10 МБ) и `requirements` (JSON с `clusters[].profiles[]`). Ответ содержит полный набор `clusters[].profiles[]`, оценки 0–100, найденные навыки, стоп-факторы, объяснение и `details.method=ollama-agent-v1`. Общие требования кластера включаются в запрос модели. Используется [Ollama Chat API](https://docs.ollama.com/api/chat); формат ответа ограничен JSON Schema и дополнительно проверяется анализатором. Механизм описан в [документации структурированных ответов](https://docs.ollama.com/capabilities/structured-outputs).

Каждая попытка worker отправляет один и тот же файл со **всеми активными
кластерами и их активными профилями**. Требования берутся один раз при начале
задания и сохраняются для повторных попыток; разбиения запроса на части нет.
При HTTP 429/500/502/503/504 и временных ошибках подключения worker повторяет
полный запрос до двух раз (`ANALYSIS_MAX_RETRIES=2`). Задержки — 15 и 30 секунд;
начальная задержка задаётся через `ANALYSIS_RETRY_DELAY_MS=15000`, максимальная —
60 секунд. `ANALYSIS_MAX_RETRIES=0` отключает повторы. Ошибки документа и другие
постоянные HTTP-ошибки, некорректный JSON или неполный набор оценок при HTTP 200
не повторяются. Анализатор может сообщать ошибку оценки через HTTP 503; такие
ответы тоже попадают под ограниченные повторы, поскольку отдельного кода
временной ошибки в его API нет.

Все попытки, чтение ответа и задержки входят в общий
`RESUME_ANALYZER_TIMEOUT_MS`; по исчерпании бюджета новые попытки не запускаются.
Оценки публикуются одной транзакцией только после проверки полного ответа.
После окончательной ошибки задание становится `failed`, прежние оценки
сохраняются; повторный запуск после этого доступен вручную. Промежуточные
вычисления внутри анализатора не восстанавливаются при повторе полного запроса.

Логи worker содержат события `analysis_started`, `analysis_retry`,
`analysis_completed`, `analysis_failed`: ID резюме, количество кластеров и
профилей, номер попытки, длительность, тип ошибки и HTTP-статус. Текст резюме,
требования и ответы модели в эти логи не записываются. Для применения изменений
worker достаточно `docker compose up -d --build --no-deps worker`; код и
контейнер анализатора при этом не пересобираются.

`/health` сообщает только о работе Python API. `/ready` возвращает `{ "available": true }` с HTTP 200 после успешного реального ответа модели; иначе HTTP 503. Проверка модели выполняется в фоне, поэтому недоступная Ollama не задерживает HTTP-проверку состояния. При некорректном ответе/таймауте `/rank` возвращает HTTP 503, оценки не подменяются нулевыми. Ошибки документа/требований возвращают HTTP 422, превышение лимита — 413. PDF без текстового слоя требует OCR.

`GET /api/analysis/status` всегда возвращает JSON доступности анализа с HTTP 200, включая недоступный обработчик. Приём резюме не зависит от готовности анализа: файл проверяется антивирусом и сохраняется в S3, данные кандидата, метаданные файла и задание `pending` — в PostgreSQL. API возвращает HTTP 201 даже при недоступном анализаторе или модели. Worker начинает оценку после сохранения, когда анализ доступен и есть активные требования. Повторная оценка на API возвращает 503 при недоступном анализе; в интерфейсе отключаются только кнопки пересчёта. Просмотр/скачивание резюме, отчёты, CSV, требования, чёрный список и смена статусов продолжают работать. Прерванный анализ становится `failed`, при неудачном пересчёте прежние оценки сохраняются.

Проверка состояния кэшируется на 5 секунд в backend, в интерфейсе обновляется каждые 5 секунд, фоновая проверка модели — каждые 15 секунд. Обнаружение зависшей модели дополнительно ограничено `MODEL_PROBE_TIMEOUT_SECONDS` (60 по умолчанию). Отказ уже выполняющегося анализа ограничен `OLLAMA_TIMEOUT_SECONDS` (180). Анализ всех профилей ограничен `RANK_TIMEOUT_SECONDS` (840); worker ждёт `RESUME_ANALYZER_TIMEOUT_MS` (900000). При настройке оставьте таймаут worker больше полного лимита анализа.

Для `resume-analyzer` на другом сервере задайте полный `RESUME_ANALYZER_URL` и, при необходимости, `RESUME_ANALYZER_READY_URL`. По умолчанию используется путь `ready` относительно URL ранжирования. Проверка должна явно возвращать `available=true`, обычного HTTP 200 недостаточно.

Анализ выполняется только через `resume-analyzer`. При его недоступности или отказе модели анализ не проводится; замены другим обработчиком нет.

`GET /api/resumes/:id/processing` возвращает причину и длительность ожидания. Backend сверяет готовность анализа, наличие активных профилей, состояние worker через внутренний `/health` и порядок очереди. Worker сообщает, работает ли он, ожидает доступности анализа/требований или обрабатывает другое резюме. Для ожидания от 60 секунд интерфейс выделяет причину и время. Ранее загруженные версии определяются по успешным заменам резюме; чёрный список проверяется по текущим активным записям. Старые технические сообщения журнала преобразуются для отображения; исходная история сохраняется.

## Проверки

```powershell
npm ci
npm run build
npm test
npm run test:architecture
docker compose run --rm --no-deps -v "${PWD}/apps/resume-analyzer/tests:/tests:ro" resume-analyzer python -m unittest discover -s /tests -v
```

Полный интеграционный сценарий использует настоящий Python-сервис и тестовую HTTP-модель Ollama, проверяет PDF/DOCX, очереди, БД/S3/антивирус, UI, отказы, таймауты, некорректные ответы и восстановление. Chrome должен быть установлен. Тест создаёт и удаляет только собственные записи и объекты.

```powershell
docker compose -f docker-compose.yml -f tests/compose.integration.yml up -d --build
$env:TEST_MODEL_CONTROL_URL='http://127.0.0.1:11435/control'
npm run test:integration
Remove-Item Env:TEST_MODEL_CONTROL_URL
docker compose stop resume-analyzer
npm run test:service-outage
docker compose up -d --remove-orphans
```

Последняя команда возвращает обычную конфигурацию модели и удаляет тестовый контейнер. Для реальной модели `npm run test:integration` проверяет диапазон оценок и контракт без ожидания заранее заданных оценок.
