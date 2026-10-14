import { useEffect, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import {
  ArrowUpRight,
  Check,
  Files,
  SearchCheck,
  ShieldCheck,
  FileCheck2,
  LoaderCircle,
  RotateCcw,
  Workflow,
  Search,
  ChevronLeft,
  ChevronRight,
} from "lucide-react";
import { type ResumeEvent, type QueueStatus, type ResumeProcessing, fullName } from "@hr/contracts";
import { useData } from "../lib/store";
import { api, mutate } from "../lib/api";
import {
  Button,
  CandidateStatus,
  Empty,
  ErrorMessage,
  PageHeading,
  Person,
} from "../components/ui";
import { CandidateDetails } from "../components/CandidateDetails";
import { BlacklistAction, CandidateWorkflow } from "../components/CandidateActions";

export function Processing() {
  const { candidates, refresh, analysis } = useData(),
    [params] = useSearchParams();
  const [selected, setSelected] = useState(params.get("resume") || ""),
    [search, setSearch] = useState(""),
    [events, setEvents] = useState<ResumeEvent[]>([]),
    [eventPage, setEventPage] = useState(1),
    [queue, setQueue] = useState<QueueStatus | null>(null),
    [queueError, setQueueError] = useState(""),
    [error, setError] = useState(""),
    [details, setDetails] = useState<string>(),
    [busy, setBusy] = useState(false);
  const filtered = candidates.filter(c => `${fullName(c)} ${c.phone}`.toLowerCase().includes(search.trim().toLowerCase()));
  const current = filtered.find((c) => c.resume_id === selected) || filtered[0];
  const eventPageCount = Math.max(1, Math.ceil(events.length / 5));
  const currentEventPage = Math.min(eventPage, eventPageCount);
  const shownEvents = events.slice((currentEventPage - 1) * 5, currentEventPage * 5);
  useEffect(() => { setEventPage(1); }, [current?.resume_id]);
  useEffect(() => {
    if (!current) return;
    let disposed = false;
    const load = () =>
      api<ResumeEvent[]>(`/resumes/${current.resume_id}/events`)
        .then((data) => {
          if (!disposed) {
            setEvents([...data].sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at)));
            setError("");
          }
        })
        .catch((e) => {
          if (!disposed) setError(e.message);
        });
    void load();
    const timer = setInterval(() => void load(), 2500);
    return () => {
      disposed = true;
      clearInterval(timer);
    };
  }, [current?.resume_id]);
  useEffect(() => {
    setQueue(null);
    setQueueError("");
    if (!current || current.scoring_status !== "pending") return;
    let disposed = false;
    let running = false;
    const load = async () => {
      if (running) return;
      running = true;
      try {
        const data = await api<ResumeProcessing>(`/resumes/${current.resume_id}/processing`, { signal: AbortSignal.timeout(6500) });
        if (!disposed) { setQueue(data.queue); setQueueError(""); }
      } catch {
        if (!disposed) setQueueError("Не удалось уточнить причину ожидания. Резюме сохранено; информация обновится автоматически.");
      } finally { running = false; }
    };
    void load();
    const timer = setInterval(() => void load(), 5000);
    return () => { disposed = true; clearInterval(timer); };
  }, [current?.resume_id, current?.scoring_status]);
  const completed = current?.scoring_status === "completed",
    failed = current?.scoring_status === "failed",
    processing = current?.scoring_status === "processing";
  const steps = [
    {
      title: "Проверка кандидата",
      text: "Проверены другие резюме и чёрный список",
      done: true,
      active: false,
      icon: SearchCheck,
    },
    {
      title: "Оценка по профилям",
      text: failed
        ? "Анализ не завершён"
        : processing
          ? "Резюме анализируется"
          : completed
            ? "Оценки получены"
            : analysis.available
              ? "Ожидание в очереди"
              : "Резюме сохранено, ожидает доступности анализа",
      done: completed,
      active: processing,
      icon: Workflow,
    },
    {
      title: "Результат",
      text: completed
        ? "Отчёт и рейтинги доступны"
        : "Сформируется после оценки",
      done: completed,
      active: false,
      icon: FileCheck2,
    },
  ];
  return (
    <>
      <PageHeading
        title="Обработка резюме"
        text="Состояние проверки и журнал событий обновляются автоматически."
      />
      <div className="processing-layout">
        <section className="af-card panel queue">
          <div className="panel-heading">
            <h2 className="af-title">Резюме</h2>
            <span className="af-badge badge badge--neutral">{candidates.length}</span>
          </div>
          <div className="search queue-search"><Search size={17} /><input className="af-input" aria-label="Поиск кандидатов" placeholder="ФИО или телефон" value={search} onChange={e => { setSearch(e.target.value); setEvents([]); }} /></div>
          {filtered.map((c) => (
            <button
              key={c.id}
              className={`queue-item ${current?.id === c.id ? "selected" : ""}`}
              aria-pressed={current?.id === c.id}
              onClick={() => {
                setSelected(c.resume_id);
                setEvents([]);
              }}
            >
              <Person candidate={c} />
              <CandidateStatus candidate={c} />
            </button>
          ))}
          {!!candidates.length && !filtered.length && <p className="muted">Кандидаты не найдены. Измените запрос.</p>}
          {!candidates.length && (
            <Empty
              title="Очередь пуста"
              text="Загрузите первое резюме."
              action={
                <Link to="/submit" className="af-link text-link">
                  Добавить кандидата
                </Link>
              }
            />
          )}
        </section>
        <section className="af-card panel processing-detail">
          {current ? (
            <>
              <div className="panel-heading">
                <div>
                  <h2 className="af-title">{fullName(current)}</h2>
                  <p>{current.file_name}</p>
                </div>
                <CandidateStatus candidate={current} />
              </div>
              <div className="processing-actions"><CandidateWorkflow key={current.id} candidate={current} /><BlacklistAction candidate={current} /></div>
              <div className="candidate-checks" aria-label="Результат проверки кандидата">
                <div className="candidate-check">
                  <Files size={20} />
                  <div>
                    <strong>Другие резюме</strong>
                    <p>{current.other_resumes_count > 0
                      ? `Ранее загружено резюме: ${current.other_resumes_count}.`
                      : "Других резюме не найдено."}</p>
                  </div>
                </div>
                <div className={`candidate-check ${current.blacklisted ? "warning" : ""}`}>
                  <ShieldCheck size={20} />
                  <div>
                    <strong>Чёрный список</strong>
                    <p>{current.blacklisted ? "Есть совпадение. Требуется проверка сотрудником." : "Совпадений с чёрным списком нет."}</p>
                  </div>
                </div>
              </div>
              {current.scoring_status === "pending" && (
                queue ? (queue.delayed || queue.reason !== "starting") && (
                  <div className="af-alert af-alert--warning notice queue-reason" aria-label="Причина ожидания" aria-live="polite">
                    <strong>Причина ожидания</strong>
                    <p>{queue.message}</p>
                    <small>{queue.waiting_seconds >= 60 ? `В очереди: ${Math.floor(queue.waiting_seconds / 60)} мин.` : "В очереди меньше минуты."}</small>
                  </div>
                ) : <p className="queue-loading muted">{queueError || "Уточняем причину ожидания…"}</p>
              )}
              <div className="pipeline">
                {steps.map(({ title, text, done, active, icon: Icon }, i) => (
                  <div
                    className={`pipeline-step ${done ? "done" : active ? "active" : ""}`}
                    key={title}
                  >
                    <div className="pipeline-icon">
                      {done ? (
                        <Check size={22} />
                      ) : active ? (
                        <LoaderCircle size={22} className="spin" />
                      ) : (
                        <Icon size={22} />
                      )}
                    </div>
                    <small>ШАГ 0{i + 1}</small>
                    <strong>{title}</strong>
                    <p>{text}</p>
                  </div>
                ))}
              </div>
              {failed && (
                <div className="af-alert af-alert--danger notice">
                  {events
                    .filter((e) => e.event_type === "scoring_failed")
                    .at(0)?.message ||
                    "Ошибка оценки. Можно повторить запуск."}
                </div>
              )}
              <ErrorMessage message={error} />
              <div className="toolbar">
                {["failed", "completed"].includes(current.scoring_status) && (
                  <Button
                    secondary
                    disabled={busy || !analysis.available}
                    title={!analysis.available ? analysis.message : undefined}
                    onClick={async () => {
                      setBusy(true);
                      try {
                        await mutate(`/resumes/${current.resume_id}/retry`, {});
                        await refresh();
                      } catch (e) {
                        setError((e as Error).message);
                      } finally {
                        setBusy(false);
                      }
                    }}
                  >
                    <RotateCcw size={16} />
                    Повторить оценку
                  </Button>
                )}
                <Button
                  disabled={!completed}
                  onClick={() => setDetails(current.id)}
                >
                  Открыть результат
                  <ArrowUpRight size={16} />
                </Button>
              </div>
              <h3 className="af-title journal-title">Журнал обработки</h3>
              <div className="event-list">
                {shownEvents.map((event) => (
                  <div key={event.id} className="event">
                    <span
                      className={`event-dot ${event.event_type.includes("failed") || event.event_type.includes("rejected") ? "danger" : ""}`}
                    />
                    <div>
                      <strong>
                        {{
                          uploaded: "Резюме сохранено",
                          replaced: "Резюме обновлено",
                          replacement_rejected: "Замена отклонена",
                          scored: "Оценка завершена",
                          scoring_failed: "Ошибка оценки",
                          status_changed: "Статус изменён",
                        }[event.event_type] || "Событие обработки"}
                      </strong>
                      <p>{event.message}</p>
                      <small>
                        {new Date(event.created_at).toLocaleString("ru-RU", {
                          timeZone: "Europe/Moscow",
                        })}{" "}
                        МСК
                      </small>
                    </div>
                  </div>
                ))}
                {!events.length && <p className="muted">Загрузка журнала…</p>}
              </div>
              {events.length > 5 && (
                <div className="table-footer" aria-label="Страницы журнала обработки">
                  <span>{(currentEventPage - 1) * 5 + 1}–{Math.min(currentEventPage * 5, events.length)} из {events.length} событий</span>
                  <div className="pagination">
                    <button className="af-btn af-btn--ghost af-btn--sm icon-button" aria-label="Предыдущие события" disabled={currentEventPage <= 1} onClick={() => setEventPage(currentEventPage - 1)}><ChevronLeft size={16} /></button>
                    <span>{currentEventPage} / {eventPageCount}</span>
                    <button className="af-btn af-btn--ghost af-btn--sm icon-button" aria-label="Следующие события" disabled={currentEventPage >= eventPageCount} onClick={() => setEventPage(currentEventPage + 1)}><ChevronRight size={16} /></button>
                  </div>
                </div>
              )}
            </>
          ) : (
            <Empty
              title="Здесь будет путь резюме"
              text="От сохранения файла до готовых оценок по профилям компании."
            />
          )}
        </section>
      </div>
      {details && (
        <CandidateDetails
          candidateId={details}
          onClose={() => setDetails(undefined)}
        />
      )}
    </>
  );
}
