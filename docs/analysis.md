# Обработка резюме и Ollama

Актуальная схема от 12 ноября 2026 года: два самостоятельных сервиса
`apps/resume-parser` и `apps/resume-evaluator`. Parser выделяет резюме из PDF/ZIP,
evaluator читает один документ и сравнивает его с зафиксированными требованиями.

## Ollama на хосте

На Mac запустить Docker Desktop и нативную Ollama:

```bash
open -a Docker
open -a Ollama
ollama list
```

Имя установленной модели должно совпадать с `OLLAMA_MODEL` в `.env`.
Внутри evaluator используется адрес
`LOCAL_OLLAMA_BASE_URL=http://host.docker.internal:11434`.

```bash
docker compose --profile processing \
  -f docker-compose.yml \
  -f docker-compose.local-ollama.yml \
  -f docker-compose.mac.yml up -d --build --wait
```

В Linux без Mac overlay его последний `-f` исключить. Для контейнерной Ollama
с NVIDIA используется профиль `docker-ollama` без local-ollama overlay.

## Готовность

`/live` и совместимый `/health` сообщают, что процесс и потоки живы.
Docker HEALTHCHECK использует `/live`, чтобы отсутствие модели не вызывало
бессмысленных перезапусков. `/ready` дополнительно проверяет оба подключения
к RabbitMQ и, для evaluator, успешную пробу Ollama с нужной моделью.
Занятая исправная модель остаётся готовой; новые задания ждут своей очереди.
Parser не подключён к сети модели и не проверяет Ollama.

Приложение получает этот статус через `/api/app/analysis/status` после входа
или `/api/guest/analysis/status` в гостевом режиме. Количество consumers само
по себе не доказывает доступность анализа.

При подтверждённом отказе модели evaluator приостанавливает приём доставок,
сохраняя соединения с брокером. После успешной периодической пробы приём
восстанавливается. Уже принятые задания соблюдают deadline и правила
повторов/DLQ; бесконечного локального повторения задания нет.

```bash
docker compose --profile processing logs --tail 60 resume-parser resume-evaluator
docker compose exec -T resume-evaluator python -c \
  'import urllib.request; print(urllib.request.urlopen("http://127.0.0.1:8002/ready").read().decode())'
```

Использовать при диагностике тот же набор `-f`, что при запуске.
Не публиковать `.env`, тексты резюме, токены и пароли в журналах.

## Проверки

`python3 tests/run_processors.py` — отдельный проект, синтетические документы,
настоящие parser/evaluator и подставные Ollama/ClamAV. Проверяет оба режима,
PDF/ZIP/DOCX, отказ/восстановление модели, ожидание очереди и сохранение оценок.
Это техническая проверка, а не измерение качества реальной модели.

Полный Python-набор запускается в образе evaluator с исходниками parser только
для теста:

```bash
docker run --rm --network none \
  -v "$PWD/apps/resume-parser/src/resume_parser:/app/resume_parser:ro" \
  -v "$PWD/tests/python:/tests:ro" --entrypoint python \
  hr-dam-resume-evaluator:local -m unittest discover -s /tests
```

Контракты: `npm test`; границы: `npm run test:architecture`, `npm run test:compose`.
Правила оценки и ограничения — в [scoring-policy.md](scoring-policy.md).
