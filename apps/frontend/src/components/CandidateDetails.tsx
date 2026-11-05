import { useEffect, useRef, useState } from "react";
import {
  Download,
  ExternalLink,
  FileText,
  Printer,
  RotateCcw,
  ShieldAlert,
  ChevronRight,
} from "lucide-react";
import { clusterScore, clusterScoreRange, ratingEvidence, formatMoscowDateTime, formatAnalysisDuration, assessmentRetryRestriction } from "@hr/contracts";
import { useData } from "../lib/store";
import { mutate, reportUrl, openWindow } from "../lib/api";
import {
  Button,
  CandidateStatus,
  ErrorMessage,
  Modal,
  Person,
  Score,
} from "./ui";
import { ResumePreview } from "./ResumePreview";
import { ExportDialog } from "./ExportDialog";
import { BlacklistAction, CandidateWorkflow } from "./CandidateActions";
import { StopFactorTag } from "./StopFactorTag";
import { ContactRecovery, ContactSources } from "./ContactRecovery";

export function CandidateDetails({
  candidateId,
  onClose,
  focusClusterId,
  focusProfileId,
}: {
  candidateId: string;
  onClose: () => void;
  focusClusterId?: string;
  focusProfileId?: string;
}) {
  const { candidates, clusters, refresh, analysis } = useData();
  const candidate = candidates.find((c) => c.id === candidateId);
  const [preview, setPreview] = useState(false),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [exportMode, setExportMode] = useState<"export" | "print">();
  const ratingsRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!focusClusterId && !focusProfileId) return;
    const element = ratingsRef.current?.querySelector<HTMLElement>(
      `[data-rating-id="${focusProfileId || focusClusterId}"]`,
    );
    if (!element) return;
    if (element instanceof HTMLDetailsElement) element.open = true;
    const dialog = element.closest<HTMLDialogElement>("dialog");
    if (!dialog) return;
    const header = dialog.querySelector<HTMLElement>(".dialog-header");
    const top = element.getBoundingClientRect().top
      - dialog.getBoundingClientRect().top + dialog.scrollTop
      - (header?.offsetHeight || 0) - 16;
    dialog.scrollTop = Math.max(0, top);
  }, [focusClusterId, focusProfileId, candidateId, preview]);
  if (!candidate) return null;
  const retryRestriction = assessmentRetryRestriction(candidate);
  const ratingsByProfile = new Map(
    candidate.ratings.map((rating) => [rating.profile_id, rating]),
  );
  const sortedClusters = [...clusters].sort(
    (a, b) => (clusterScore(candidate, b) ?? -1) - (clusterScore(candidate, a) ?? -1),
  );
  const processed = candidate.ratings
    .map((r) => r.calculated_at)
    .sort((a, b) => Date.parse(a) - Date.parse(b))
    .at(-1);
  const anchor = focusProfileId
    ? `#profile-${focusProfileId}`
    : focusClusterId
      ? `#cluster-${focusClusterId}`
      : "";
  return (
    <>
      {!preview && (
        <Modal title="Карточка кандидата" onClose={onClose} wide>
          <div className="candidate-summary">
            <Person candidate={candidate} />
            <CandidateStatus candidate={candidate} />
          </div>
          <div className="candidate-processing">
          <div>
          <p className="muted">
            Последняя обработка:{" "}
            {processed
              ? formatMoscowDateTime(processed) + " МСК"
              : "оценка ещё не завершена"}
          </p>
          {(processed || candidate.scoring_status === "completed") && <p className="muted">Время анализа: {formatAnalysisDuration(candidate.analysis_duration_ms)}</p>}
          </div>
            <div className="toolbar candidate-document-actions">
              <Button aria-label="Открыть резюме" title="Открыть резюме" onClick={() => setPreview(true)}>
                <FileText size={16} />
                Резюме
              </Button>
              <Button
                secondary
                aria-label="Открыть отчёт"
                title="Открыть отчёт"
                onClick={() =>
                  openWindow(reportUrl(candidate.resume_id) + anchor)
                }
              >
                <ExternalLink size={16} />
                Отчёт
              </Button>
              <Button secondary aria-label="Экспорт" title="Экспорт" onClick={() => setExportMode("export")}>
                <Download size={16} />
                Экспорт
              </Button>
              <Button secondary aria-label="Печать" title="Печать" onClick={() => setExportMode("print")}>
                <Printer size={16} />
                Печать
              </Button>
            </div>
          </div>
          <ErrorMessage message={error} />
          {candidate.contact_extraction?.warnings.map(warning => <p key={warning} role="status">{warning}</p>)}
          <ContactSources candidate={candidate} />
          {candidate.blacklisted && (
            <div className="af-alert af-alert--warning notice">
              <ShieldAlert size={19} />
              <span>
                Кандидат найден в чёрном списке по телефону или ФИО.
                Переход в «В процессе» недоступен.
              </span>
            </div>
          )}
          <div className="candidate-controls">
            <CandidateWorkflow key={candidate.id} candidate={candidate} />
            <div className="toolbar candidate-management">
              <ContactRecovery key={candidate.resume_id} resumeId={candidate.resume_id} />
              <Button
                secondary
                disabled={busy || !!retryRestriction}
                title={retryRestriction || undefined}
                onClick={async () => {
                  setBusy(true);
                  setError("");
                  try {
                    await mutate(`/resumes/${candidate.resume_id}/retry`, {});
                    await refresh();
                  } catch (e) {
                    setError((e as Error).message);
                  } finally {
                    setBusy(false);
                  }
                }}
              >
                <RotateCcw size={16} />
                Пересчитать оценку
              </Button>
              <BlacklistAction candidate={candidate} />
            </div>
          </div>
          <h3 className="af-title">Соответствие профилям</h3>
          <p className="muted">
            Рейтинг кластера — максимальная оценка по его профилям. Раскройте
            профиль, чтобы увидеть обоснование.
          </p>
          <div className="rating-details" ref={ratingsRef}>
            {sortedClusters.map((cluster) => {
              const rated = cluster.profiles
                .filter((p) => ratingsByProfile.has(p.id))
                .sort((a, b) => Number(ratingsByProfile.get(b.id)!.score)
                  - Number(ratingsByProfile.get(a.id)!.score));
              return rated.length ? (
                <section
                  key={cluster.id}
                  data-rating-id={cluster.id}
                >
                  <h4>
                    {cluster.name}
                    {!cluster.is_active && (
                      <span className="af-badge badge badge--neutral">
                        Неактивен
                      </span>
                    )}
                    <Score value={clusterScore(candidate, cluster)} upperValue={clusterScoreRange(candidate, cluster)?.max} />
                  </h4>
                  {rated.map((p) => {
                    const r = ratingsByProfile.get(p.id)!;
                    return (
                      <details
                        key={p.id}
                        data-rating-id={p.id}
                        open={focusProfileId === p.id || undefined}
                      >
                        <summary>
                          <ChevronRight size={16} aria-hidden="true" />
                          <span>
                            {p.position_name}
                            {!p.is_active && <small> · неактивен</small>}
                          </span>
                          <Score value={Number(r.score)} upperValue={ratingEvidence(r)?.score_range.max} />
                        </summary>
                        <div className="rating-explanation">
                          <section>
                            <h5>Обоснование оценки</h5>
                            {ratingEvidence(r) && <p className="muted">
                              Охват проверенными критериями: {ratingEvidence(r)!.coverage}%.
                              Диапазон отражает сведения, требующие уточнения. Правила оценки предварительные;
                              качество на разметке рекрутеров ещё не проверено.
                            </p>}
                            <p className="explanation-text">
                              {r.explanation ||
                                "Обработчик не предоставил пояснение."}
                            </p>
                          </section>
                          <div className="evidence-grid">
                            <section>
                              <h5>Совпадения с требованиями</h5>
                              <div className="tags">
                                {r.matched_keywords?.length ? (
                                  r.matched_keywords.map((word, i) => (
                                    <span key={i} className="af-badge tag">
                                      {word}
                                    </span>
                                  ))
                                ) : (
                                  <p>Нет совпадений</p>
                                )}
                              </div>
                            </section>
                            <section>
                              <h5>Стоп-факторы</h5>
                              <div className="tags">
                                {r.triggered_stop_factors?.length ? (
                                  r.triggered_stop_factors.map((word, i) => (
                                    <StopFactorTag key={i} text={word} />
                                  ))
                                ) : (
                                  <p>Не найдены</p>
                                )}
                              </div>
                            </section>
                          </div>
                        </div>
                      </details>
                    );
                  })}
                </section>
              ) : null;
            })}
            {!candidate.ratings.length && (
              <p className="af-alert af-alert--info notice">
                Оценки ещё не сформированы. Состояние доступно на экране
                «Обработка».
              </p>
            )}
          </div>
          <div className="dialog-footer">
            <Button secondary onClick={onClose}>
              Закрыть
            </Button>
          </div>
        </Modal>
      )}
      {preview && (
        <ResumePreview
          candidate={candidate}
          onClose={() => setPreview(false)}
        />
      )}
      {exportMode && (
        <ExportDialog
          candidates={[candidate]}
          clusters={clusters}
          candidateReport
          mode={exportMode}
          onClose={() => setExportMode(undefined)}
        />
      )}
    </>
  );
}
