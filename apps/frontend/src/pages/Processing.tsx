import { useEffect, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import {
  ArrowUpRight,
  Check,
  Circle,
  Database,
  FileCheck2,
  LoaderCircle,
  RotateCcw,
  Workflow,
} from "lucide-react";
import { type ResumeEvent, fullName } from "@hr/contracts";
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

export function Processing() {
  const { candidates, refresh } = useData(),
    [params] = useSearchParams();
  const [selected, setSelected] = useState(params.get("resume") || ""),
    [events, setEvents] = useState<ResumeEvent[]>([]),
    [error, setError] = useState(""),
    [details, setDetails] = useState<string>(),
    [busy, setBusy] = useState(false);
  const current =
    candidates.find((c) => c.resume_id === selected) || candidates[0];
  useEffect(() => {
    if (!current) return;
    let disposed = false;
    const load = () =>
      api<ResumeEvent[]>(`/resumes/${current.resume_id}/events`)
        .then((data) => {
          if (!disposed) {
            setEvents(data);
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
  const completed = current?.scoring_status === "completed",
    failed = current?.scoring_status === "failed",
    processing = current?.scoring_status === "processing";
  const steps = [
    {
      title: "Сохранение",
      text: "Данные проверены, файл сохранён",
      done: true,
      active: false,
      icon: Database,
    },
    {
      title: "Обработчик",
      text: failed
        ? "Проверка завершилась ошибкой"
        : processing
          ? "Оценка активных профилей"
          : completed
            ? "Оценки получены"
            : "Ожидание в очереди",
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
        <section className="panel queue">
          <div className="panel-heading">
            <h2>Резюме</h2>
            <span className="badge neutral">{candidates.length}</span>
          </div>
          {candidates.map((c) => (
            <button
              key={c.id}
              className={`queue-item ${current?.id === c.id ? "selected" : ""}`}
              onClick={() => {
                setSelected(c.resume_id);
                setEvents([]);
              }}
            >
              <Person candidate={c} />
              <CandidateStatus candidate={c} />
            </button>
          ))}
          {!candidates.length && (
            <Empty
              title="Очередь пуста"
              text="Загрузите первое резюме."
              action={
                <Link to="/submit" className="text-link">
                  Добавить кандидата
                </Link>
              }
            />
          )}
        </section>
        <section className="panel processing-detail">
          {current ? (
            <>
              <div className="panel-heading">
                <div>
                  <h2>{fullName(current)}</h2>
                  <p>{current.file_name}</p>
                </div>
                <CandidateStatus candidate={current} />
              </div>
              {current.blacklisted && (
                <div className="notice warning">
                  Есть совпадение с чёрным списком. Требуется ручная проверка.
                </div>
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
                <div className="notice danger">
                  {events
                    .filter((e) => e.event_type === "scoring_failed")
                    .at(-1)?.message ||
                    "Ошибка оценки. Можно повторить запуск."}
                </div>
              )}
              <ErrorMessage message={error} />
              <div className="toolbar">
                {["failed", "completed"].includes(current.scoring_status) && (
                  <Button
                    secondary
                    disabled={busy}
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
              <h3 className="journal-title">Журнал обработки</h3>
              <div className="event-list">
                {events.map((event) => (
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
                        }[event.event_type] || event.event_type}
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
