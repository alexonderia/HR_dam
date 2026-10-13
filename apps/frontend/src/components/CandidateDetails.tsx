import { useState } from "react";
import {
  Download,
  ExternalLink,
  FileText,
  Printer,
  RotateCcw,
  ShieldAlert,
  ArrowRight,
} from "lucide-react";
import type { Candidate } from "@hr/contracts";
import { fullName } from "@hr/contracts";
import { useData } from "../lib/store";
import { mutate, reportUrl, openWindow } from "../lib/api";
import {
  Button,
  CandidateStatus,
  ErrorMessage,
  Field,
  Modal,
  Person,
  Score,
} from "./ui";
import { ResumePreview } from "./ResumePreview";

export function CandidateDetails({
  candidateId,
  onClose,
}: {
  candidateId: string;
  onClose: () => void;
}) {
  const { candidates, clusters, refresh } = useData();
  const candidate = candidates.find((c) => c.id === candidateId);
  const [preview, setPreview] = useState(false),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [blacklist, setBlacklist] = useState(false),
    [company, setCompany] = useState("");
  if (!candidate) return null;
  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setError("");
    try {
      await fn();
      await refresh();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <Modal title="Карточка кандидата" onClose={onClose} wide>
        <div className="candidate-summary">
          <Person candidate={candidate} />
          <CandidateStatus candidate={candidate} />
        </div>
        <ErrorMessage message={error} />
        {candidate.blacklisted && (
          <div className="notice warning">
            <ShieldAlert size={19} />
            <span>
              Совпадение с чёрным списком по телефону или ФИО. Проверьте данные
              до передачи в работу.
            </span>
          </div>
        )}
        <div className="toolbar">
          <Button secondary onClick={() => setPreview(true)}>
            <FileText size={16} />
            Резюме
          </Button>
          <a
            className="af-btn af-btn--secondary"
            href={reportUrl(candidate.resume_id, "download")}
          >
            <Download size={16} />
            Отчёт
          </a>
          <Button
            secondary
            onClick={() => openWindow(reportUrl(candidate.resume_id))}
          >
            <ExternalLink size={16} />
            Открыть отчёт
          </Button>
          <Button
            secondary
            onClick={() => openWindow(reportUrl(candidate.resume_id, "print"))}
          >
            <Printer size={16} />
            Печать
          </Button>
        </div>
        <h3>Соответствие профилям</h3>
        <p className="muted">
          Оценки на момент последней обработки. Максимум по профилям формирует
          рейтинг кластера.
        </p>
        <div className="rating-details">
          {clusters.map((cluster) => {
            const rated = cluster.profiles.filter((p) =>
              candidate.ratings.some((r) => r.profile_id === p.id),
            );
            return rated.length ? (
              <section key={cluster.id}>
                <h4>
                  {cluster.name}
                  {!cluster.is_active && (
                    <span className="badge neutral">Неактивен</span>
                  )}
                </h4>
                {rated.map((p) => {
                  const r = candidate.ratings.find(
                    (r) => r.profile_id === p.id,
                  )!;
                  return (
                    <details key={p.id}>
                      <summary>
                        <span>
                          {p.position_name}
                          {!p.is_active && <small> · неактивен</small>}
                        </span>
                        <Score value={Number(r.score)} />
                      </summary>
                      <div className="rating-explanation">
                        <p>
                          {r.explanation ||
                            "Обработчик не предоставил пояснение."}
                        </p>
                        <p>
                          <strong>Ключевые слова:</strong>{" "}
                          {r.matched_keywords?.join(", ") || "нет совпадений"}
                        </p>
                        <p>
                          <strong>Стоп-факторы:</strong>{" "}
                          {r.triggered_stop_factors?.join(", ") || "не найдены"}
                        </p>
                        {r.details != null && (
                          <pre>{JSON.stringify(r.details, null, 2)}</pre>
                        )}
                        <small>
                          Рассчитано:{" "}
                          {new Date(r.calculated_at).toLocaleString("ru-RU", {
                            timeZone: "Europe/Moscow",
                          })}
                        </small>
                      </div>
                    </details>
                  );
                })}
              </section>
            ) : null;
          })}
          {!candidate.ratings.length && (
            <p className="notice">
              Оценки ещё не сформированы. Состояние доступно на экране
              «Обработка».
            </p>
          )}
        </div>
        <div className="dialog-footer">
          <Button
            secondary
            disabled={
              busy ||
              !["failed", "completed"].includes(candidate.scoring_status)
            }
            onClick={() =>
              void run(() =>
                mutate(`/resumes/${candidate.resume_id}/retry`, {}),
              )
            }
          >
            <RotateCcw size={16} />
            Пересчитать
          </Button>
          <Button secondary disabled={busy} onClick={() => setBlacklist(true)}>
            <ShieldAlert size={16} />В чёрный список
          </Button>
          {candidate.status === "in_work" && (
            <Button
              disabled={busy || candidate.scoring_status !== "completed"}
              onClick={() =>
                void run(() =>
                  mutate(
                    `/resumes/${candidate.resume_id}/status`,
                    { status: "in_process" },
                    "PATCH",
                  ),
                )
              }
            >
              Взять в работу
              <ArrowRight size={16} />
            </Button>
          )}
          {candidate.status === "in_process" && (
            <Button
              disabled={busy}
              onClick={() =>
                void run(() =>
                  mutate(
                    `/resumes/${candidate.resume_id}/status`,
                    { status: "historical" },
                    "PATCH",
                  ),
                )
              }
            >
              Завершить работу
            </Button>
          )}
        </div>
      </Modal>
      {preview && (
        <ResumePreview
          candidate={candidate}
          onClose={() => setPreview(false)}
        />
      )}
      {blacklist && (
        <Modal
          title="Добавить в чёрный список"
          onClose={() => setBlacklist(false)}
        >
          <p>
            {fullName(candidate)} · {candidate.phone}
          </p>
          <p className="muted">
            Данные будут скопированы в независимую запись чёрного списка.
          </p>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void run(async () => {
                await mutate("/blacklist", {
                  phone: candidate.phone,
                  last_name: candidate.last_name,
                  first_name: candidate.first_name,
                  middle_name: candidate.middle_name || "",
                  company_name: company,
                  is_active: true,
                });
                setBlacklist(false);
              });
            }}
          >
            <Field label="Компания">
              <input
                className="af-input"
                required
                minLength={2}
                maxLength={255}
                value={company}
                onChange={(e) => setCompany(e.target.value)}
              />
            </Field>
            <ErrorMessage message={error} />
            <div className="dialog-footer">
              <Button type="submit" disabled={busy}>
                Добавить
              </Button>
            </div>
          </form>
        </Modal>
      )}
    </>
  );
}
