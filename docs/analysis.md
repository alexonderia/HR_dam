# Анализ резюме через Ollama

> Один сервис `resume-analyzer` выбирает адаптер через `ANALYZER_ADAPTER=http|amqp`. HTTP bridge работает с RabbitMQ и без него; native AMQP требует брокер и отключённый bridge. [Режимы и контракт](resume-analyzer-rabbitmq-api.md).



Основной сервис находится в `apps/resume-analyzer`. Обычная команда `docker compose up -d --build` запускает также Ollama с доступом к NVIDIA GPU и загружает модель из `OLLAMA_MODEL` (по умолчанию `qwen3.5:9b`). Backend, интерфейс и сохранение резюме работают независимо от готовности модели. Для анализа добавьте активный кластер и профиль.

## Полный стек с Ollama в Compose

Настройки по умолчанию: `OLLAMA_BASE_URL=http://ollama:11434`, `OLLAMA_MODEL=qwen3.5:9b`.

```powershell
docker compose up -d --build
docker compose logs -f ollama-init
```

Оба контейнера используют локальный образ на основе официального `ollama/ollama:0.40.3` с добавленным файлом часового пояса `Europe/Moscow`. `ollama-init` проверяет наличие модели и загружает её только при первом запуске или смене модели. `ollama_data` хранит веса между перезапусками и пересборками. Контейнер Ollama использует одну NVIDIA GPU, выполняет один запрос одновременно и держит в памяти одну модель. Объём весов и требуемой памяти зависит от выбранной модели и контекста. В Windows нужен Docker Desktop с WSL 2 и работающим доступом к NVIDIA GPU. Настройка следует [документации Docker Compose](https://docs.docker.com/compose/how-tos/gpu-support/).

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
OLLAMA_MODEL=qwen3.5:9b
```

`LOCAL_OLLAMA_BASE_URL` по умолчанию указывает на хост Docker и в этом режиме имеет приоритет над `OLLAMA_BASE_URL`, даже если в существующем `.env` остался адрес контейнера. Для Ollama на другой машине укажите её адрес, например `LOCAL_OLLAMA_BASE_URL=http://192.168.1.50:11434`. `localhost` внутри анализатора указывает на сам контейнер.

На машине с Ollama проверьте наличие модели командой `ollama list`; если её нет, выполните `ollama pull qwen3.5:9b`. Если используется другая установленная модель, запишите её точное имя в `OLLAMA_MODEL`.

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

Worker отправляет `POST /rank` с `multipart/form-data`: `file` (PDF/DOCX до 50 МБ) и `requirements` (JSON с `clusters[].profiles[]`). Ответ содержит полный набор `clusters[].profiles[]`, оценки 0–100, найденные навыки, стоп-факторы, объяснение и `details.method=ollama-agent-v1`. Общие требования кластера включаются в запрос модели. Используется [Ollama Chat API](https://docs.ollama.com/api/chat); формат ответа ограничен JSON Schema и дополнительно проверяется анализатором. Механизм описан в [документации структурированных ответов](https://docs.ollama.com/capabilities/structured-outputs).

Каждая попытка worker отправляет один и тот же файл со **всеми активными
кластерами и их активными профилями**. Требования берутся один раз при начале
задания и сохраняются для повторных попыток; разбиения запроса на части нет.
При HTTP 429/500/502/503/504 и временных ошибках подключения worker повторяет
полный запрос до двух раз (`ANALYSIS_MAX_RETRIES=2`). Задержки — 15 и 30 секунд;
начальная задержка задаётся через `ANALYSIS_RETRY_DELAY_MS=15000`, максимальная —
60 секунд. `ANALYSIS_MAX_RETRIES=0` отключает повторы. Ошибки документа и другие
постоянные HTTP-ошибки, некорректный JSON или неполный набор оценок при HTTP 200
не повторяются внутри HTTP-запроса. Сетевая недоступность, HTTP 429/503/504 и
таймаут возвращают задание в ожидание, сохраняя счётчик ошибок документа.

Все попытки, чтение ответа и задержки входят в общий
`RESUME_ANALYZER_TIMEOUT_MS` (900000 мс, 15 минут); по исчерпании бюджета новые попытки не запускаются.
HTTP-клиент worker использует тот же лимит для подключения, ожидания заголовков
и чтения ответа, поэтому стандартный пятиминутный таймаут Undici не обрывает анализ.
Оценки публикуются одной транзакцией только после проверки полного ответа.
После постоянной ошибки документа или исчерпания повторов некорректного ответа
задание становится `failed`, прежние оценки сохраняются. Недоступность модели,
брокера, backend или S3 не расходует этот лимит. Промежуточные
вычисления внутри анализатора не восстанавливаются при повторе полного запроса.

Логи worker содержат события `analysis_started`, `analysis_retry`,
`analysis_completed`, `analysis_failed`: ID резюме, количество кластеров и
профилей, номер попытки, длительность, тип ошибки и HTTP-статус. Текст резюме,
требования и ответы модели в эти логи не записываются. Для применения изменений
worker достаточно `docker compose up -d --build --no-deps worker`; код и
контейнер анализатора при этом не пересобираются.

`/health` проверяет работу процесса и, для AMQP, жизнь consumer-потока. Отключение брокера или модели не меняет liveness. `/status` отдельно показывает `alive`, `adapter`, `broker_connected`, `consumer_alive`, `model_ready`, `busy`, `stopping` и итоговое `available`. `/ready` возвращает те же поля с HTTP 200 при готовности и 503 при ожидании. Занятость передаётся отдельно и не означает отказ сервиса.

Фоновая проверка читает Ollama `/api/tags` и проверяет наличие выбранной модели, не запускает генерацию и не конкурирует с анализом. Ошибки реального вызова модели также обновляют состояние. HTTP `/rank` возвращает 503 при недоступности, 504 при таймауте, 502 при некорректном ответе, 422 при ошибке документа/требований. Сообщения ошибок общие с AMQP. PDF без текстового слоя требует OCR.

`GET /api/analysis/status` возвращает JSON готовности с HTTP 200 даже при ожидании модели. Backend проверяет `/ready` в обоих режимах; наличие consumer в очереди само по себе не подтверждает готовность. В AMQP дополнительно требуются подключение consumer к брокеру и готовность модели. ZIP, одиночный файл и повторная оценка сохраняются с 202; инфраструктурная недоступность оставляет задания в ожидании. Просмотр результатов и восстановление контактов работают без модели.

Проверка состояния кэшируется на 5 секунд в backend, в интерфейсе обновляется каждые 5 секунд, фоновая проверка модели — каждые 15 секунд. `MODEL_PROBE_TIMEOUT_SECONDS` по умолчанию 10, `OLLAMA_TIMEOUT_SECONDS` — 180, `RANK_TIMEOUT_SECONDS` — 840; worker ждёт `RESUME_ANALYZER_TIMEOUT_MS` — 900000. Пользовательские значения `.env` имеют приоритет. Таймаут worker должен быть больше полного лимита анализа.

HTTP и AMQP используют один pipeline подготовки документа, извлечения контактов, проверки результата и обработки ошибок. Один процесс Uvicorn и общий ограничитель допускают один анализ одновременно; монитор readiness использует тот же ограничитель. Lifespan управляет монитором и consumer, при остановке прекращает приём заданий, проверяет отмену между профилями и возвращает неподтверждённую доставку брокеру. По умолчанию `SHUTDOWN_GRACE_SECONDS=210`, grace контейнера — 240 секунд. Если увеличивается таймаут модели, соответственно увеличьте оба лимита завершения. Несколько процессов требуют внешней координации; `WEB_CONCURRENCY`/`UVICORN_WORKERS` со значением больше 1 отклоняются штатным entrypoint.

Для `resume-analyzer` на другом сервере задайте полный `RESUME_ANALYZER_URL` и, при необходимости, `RESUME_ANALYZER_READY_URL`. По умолчанию используется путь `ready` относительно URL ранжирования. Проверка должна явно возвращать `available=true`, обычного HTTP 200 недостаточно.

Время анализа сохраняется в `resume_events.analysis_duration_ms` (миграция V4) и событиях загрузки. Pipeline явно возвращает длительность успешной подготовки текста и анализа, исключая скачивание, ожидание ограничителя и инфраструктурные повторы. HTTP bridge сохраняет это значение без собственного пересчёта. Для старого внешнего HTTP-анализатора без поля длительности остаётся совместимый замер HTTP-запроса; старые AMQP-результаты используют отметки одной попытки или неизвестное время. В карточке и отчёте показывается последняя успешная оценка. Скрипт `scripts/backfill-analysis-duration.mjs` обновляет только незаполненные старые значения.

Анализ выполняется через `resume-analyzer`; при недоступности модели задания ожидают её восстановления.

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

## Проверка изменений сервиса

Запускайте из корня проекта в PowerShell. Для текущей рабочей папки подготовлено
Python-окружение `.qa/contacts-venv`; на другой машине создайте venv и установите
`apps/resume-analyzer/requirements.txt`. Команды ниже не пересобирают работающие
контейнеры и не меняют рабочие записи кандидатов.

```powershell
npm.cmd test
npm.cmd run build
npm.cmd run test:architecture

$env:PYTHONPATH="apps/resume-analyzer"
$env:LOG_DIR=".qa/analyzer-test-logs"
.qa/contacts-venv/Scripts/python.exe -m unittest discover -s apps/resume-analyzer/tests -q
```

Интеграционные проверки требуют работающих PostgreSQL, RabbitMQ с Management API
и S3 из текущего Compose, а также настроенного `.env`. Они создают отдельные
тестовые БД/vhost и временные S3-объекты и удаляют их после завершения. Скоринг
подменён детерминированной фикстурой; качество ответов реальной модели ими не проверяется.

```powershell
# Реальный Python-сервис и AMQP consumer: readiness, общий pipeline,
# отключение/восстановление модели, эксклюзивность очереди, graceful shutdown.
.qa/contacts-venv/Scripts/python.exe tests/run_analyzer_service.py

# Backend/worker: native readiness, доставка, повторы и сохранение в БД.
python tests/run_queue_integration.py
python tests/run_queue_integration.py --bridge broker
python tests/run_queue_integration.py --bridge direct

# Восстановление контактов без скоринга и защита ручных значений.
$env:PGHOST="127.0.0.1"
$env:RABBITMQ_HOST="127.0.0.1"
$env:RABBITMQ_MANAGEMENT_URL="http://127.0.0.1:15672"
$env:S3_ENDPOINT="http://127.0.0.1:8333"
node --env-file=.env node_modules/tsx/dist/cli.mjs tests/contact-recovery.integration.ts
```

Для UI в одном терминале запустите `npm.cmd run dev -w @hr/frontend -- --host 127.0.0.1`.
Во втором выполните `$env:TEST_BROWSER_CHANNEL="msedge"`, затем
`node node_modules/tsx/dist/cli.mjs tests/contact-recovery.ui.ts`.
Этот сценарий проверяет десктопный и мобильный размеры с подменённым API.

После проверки кода новая версия применяется к текущей установке с локальной Ollama:

```powershell
docker compose -f docker-compose.yml -f docker-compose.local-ollama.yml --profile broker up -d --build --remove-orphans --wait
Invoke-RestMethod http://127.0.0.1:3000/api/analysis/status
Invoke-RestMethod http://127.0.0.1:3000/api/processing/mode
```

В текущем `.env` выбран `ANALYZER_ADAPTER=amqp`, `RABBITMQ_ENABLED=true`,
`RANK_BRIDGE_ENABLED=false`. При первом обновлении удаляется прежний отдельный
consumer, заменённый потоком внутри `resume-analyzer`. Для проверки состояния
при недоступной реальной модели остановите используемый Ollama и дождитесь
фоновой проверки: `available=false`, `model_ready=false`, liveness сохраняется,
новый импорт ожидает обработки. После возврата Ollama он должен завершиться.
Автоматический сценарий выше проверяет этот же переход без остановки рабочей модели.
