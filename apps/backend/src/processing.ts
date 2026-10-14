import { assessmentCompletedMessage, type QueueStatus, type ResumeEvent, type WorkerStatus } from "@hr/contracts";

export async function probeWorker(url: string): Promise<WorkerStatus | null> {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(1000) });
    const body = await response.json() as WorkerStatus;
    if (!response.ok || !["idle", "waiting_analysis", "waiting_requirements", "processing", "error"].includes(body.state)) return null;
    return body;
  } catch { return null; }
}

export function queueStatus(input: {
  queuedAt: string;
  activeProfiles: number;
  analysisAvailable: boolean;
  worker: WorkerStatus | null;
  ahead: number;
  processing: number;
}, now = Date.now()): QueueStatus {
  const waitingSeconds = Math.max(0, Math.floor((now - Date.parse(input.queuedAt)) / 1000) || 0);
  const common = { waiting_seconds: waitingSeconds, position: input.ahead + input.processing + 1, delayed: waitingSeconds >= 60 };
  if (!input.activeProfiles || input.worker?.state === "waiting_requirements")
    return { ...common, reason: "no_profiles", message: "Для анализа ещё не заданы активные профили. Резюме сохранено; обработка начнётся после настройки требований." };
  if (!input.analysisAvailable || input.worker?.state === "waiting_analysis")
    return { ...common, reason: "analysis_unavailable", message: "Анализ временно недоступен. Резюме сохранено и будет обработано после восстановления." };
  if (!input.worker || input.worker.state === "error")
    return { ...common, reason: "processing_paused", message: "Обработка очереди временно приостановлена. Резюме сохранено и ждёт возобновления обработки." };
  if (input.processing || input.ahead || input.worker.state === "processing")
    return { ...common, reason: "waiting_turn", message: input.ahead
      ? `Перед этим резюме ожидают обработки: ${input.ahead + input.processing}. Анализ начнётся, когда подойдёт его очередь.`
      : "Сейчас обрабатывается другое резюме. Ваше резюме ожидает своей очереди." };
  if (common.delayed)
    return { ...common, reason: "delayed", message: "Запуск анализа задерживается. Резюме сохранено и остаётся в очереди; обработка начнётся автоматически." };
  return { ...common, reason: "starting", message: "Резюме готово к анализу и ожидает начала обработки." };
}

export function presentResumeEvent(event: ResumeEvent): ResumeEvent {
  const message = event.message || "";
  let display = message;
  if (event.event_type === "uploaded" || event.event_type === "replaced") {
    // Older events retain their audit text; render business checks to users.
    if (/S3|PostgreSQL|Файл проверен антивирусом/i.test(message)) {
      const other = event.event_type === "replaced"
        ? "Найдено ранее загруженное резюме. Текущее резюме обновлено."
        : "Других резюме не найдено.";
      const blacklist = /Совпадение с чёрным списком|Есть совпадение с чёрным списком/i.test(message)
        ? "Есть совпадение с чёрным списком. Требуется проверка сотрудником."
        : "Совпадений с чёрным списком нет.";
      display = `${other} ${blacklist}`;
    }
  } else if (event.event_type === "scored") {
    display = assessmentCompletedMessage(/Кандидат найден в чёрном списке|Совпадение с чёрным списком/i.test(message));
  } else if (event.event_type === "scoring_failed") {
    display = /извлеч|прочитать|OCR|поврежд[её]н|текст не/i.test(message)
      ? "Не удалось прочитать текст резюме. Загрузите документ с доступным текстом."
      : "Не удалось завершить анализ. Повторите оценку позже.";
  } else if (event.event_type === "status_changed") {
    display = message.startsWith("Статус изменён:") ? message
      : message.includes("in_process") ? "Кандидат передан в работу."
      : message.includes("historical") ? "Работа с кандидатом завершена; резюме перенесено в архив."
      : "Статус кандидата изменён.";
  }
  return { ...event, message: display };
}
