import { useEffect, useId, useRef, useState } from "react";
import { AlertCircle, CheckCircle2, ChevronRight, Download, FileText, LoaderCircle, Paperclip, X } from "lucide-react";
import { guestCriteriaSchema, type ProcessingResult } from "@hr/contracts";
import { Button, ErrorMessage, Framework, InfoHint, Score } from "../components/ui";
import { RatingAnalysis } from "../components/RatingAnalysis";
import { sessionApi } from "../lib/session-api";
import { downloadReport } from "../lib/report-download";

interface Report { task_id: string; status: string; source_count: number; candidate_count: number; completed_count: number; expires_at: string;
  results: ({ file_id: string } & Extract<ProcessingResult, { evaluations: unknown }> )[];
  errors: { file_id: string; message: string; code: string }[] }
interface Ticket { id: string; status: "waiting" | "admitted"; position: number }
const complete = (status: string) => ["completed", "partially_completed", "failed"].includes(status);
const statusLabel: Record<string, string> = { uploading: "Загрузка не завершена", queued: "В очереди на обработку", processing: "Обработка", completed: "Готово", partially_completed: "Готова часть отчёта", failed: "Обработка завершилась ошибкой" };
const statusDescription: Record<string, string> = {
  uploading: "Загрузка файлов ещё не завершена.",
  queued: "Ожидаем начала обработки. Результаты появятся здесь автоматически.",
  processing: "Резюме обрабатываются. Готовые оценки добавляются автоматически.",
  completed: "Обработка завершена. Все готовые оценки представлены ниже.",
  partially_completed: "Обработка завершена с ошибками. Готовые оценки доступны ниже.",
  failed: "Можно отправить файлы на обработку заново.",
};
const bestScore = (result: Report["results"][number]) => Math.max(-1, ...result.evaluations.map(evaluation => evaluation.score));
const plural = (count: number, forms: [string, string, string]) => forms[count % 100 >= 11 && count % 100 <= 14 ? 2 : count % 10 === 1 ? 0 : count % 10 >= 2 && count % 10 <= 4 ? 1 : 2];
const guestFields = [
  { key: "name", label: "Название подбора", hint: "Укажите название вакансии или подбора. Например, «Python-разработчик»." },
  { key: "education", label: "Образование", hint: "Требования к уровню и направлению образования. Например, «Высшее техническое»." },
  { key: "experience", label: "Опыт работы", hint: "Нужный стаж, роли и задачи. Например, «От 3 лет разработки на Python»." },
  { key: "keywords", label: "Навыки (через запятую)", hint: "Навыки, технологии и инструменты для проверки в резюме. Укажите через запятую или с новой строки: Python, SQL, Docker." },
  { key: "stop_factors", label: "Стоп-факторы (через запятую)", hint: "Критичные несоответствия требованиям. Например, «Нет обязательного сертификата». Каждый пункт — через запятую или с новой строки." },
  { key: "comment", label: "Комментарий", hint: "Дополнительные пожелания и контекст вакансии. Например, «Важен опыт в производственных компаниях»." },
] as const;
const fileSize = (bytes: number) => bytes < 1024 ? `${bytes} Б` : `${(bytes / (bytes >= 1048576 ? 1048576 : 1024)).toLocaleString("ru-RU", { maximumFractionDigits: 1 })} ${bytes >= 1048576 ? "МБ" : "КБ"}`;
export function Guest({ onLogin }: { onLogin: () => void }) {
  const [report, setReport] = useState<Report>(), [error, setError] = useState(""), [busy, setBusy] = useState(false);
  const [downloading, setDownloading] = useState(false);
  const [expandedCandidates, setExpandedCandidates] = useState<Record<string, boolean>>({});
  const [visibleCandidates, setVisibleCandidates] = useState(4);
  const [stage, setStage] = useState(""), [files, setFiles] = useState<File[]>([]);
  const [values, setValues] = useState({ name: "Подбор кандидатов", education: "", experience: "", keywords: "", stop_factors: "", comment: "" });
  const [taskId, setTaskId] = useState(() => localStorage.getItem("hr_guest_task") || "");
  const mounted = useRef(true), attempt = useRef<{ fingerprint: string; key: string } | undefined>(undefined);
  const fileInput = useRef<HTMLInputElement>(null), attachmentsId = useId();
  const reportElement = useRef<HTMLElement>(null);
  const rankedResults = report ? [...report.results].sort((a, b) => bestScore(b) - bestScore(a)) : [];
  const statusTone = report?.status === "completed" ? "success" : report?.status === "failed" ? "danger" : report?.status === "partially_completed" ? "warning" : "active";
  const shownCandidates = rankedResults.reduce((count, result, index) => expandedCandidates[result.file_id] ? Math.max(count, index + 1) : count, visibleCandidates);
  const saveReport = async () => {
    if (!report) return;
    setDownloading(true); setError("");
    try {
      await sessionApi(`/guest/tasks/${report.task_id}/report`);
      if (reportElement.current) downloadReport(reportElement.current);
    } catch (e) { setError((e as Error).message); }
    finally { setDownloading(false); }
  };
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => {
    setExpandedCandidates({});
    setVisibleCandidates(4);
    if (!taskId) return;
    let active = true, timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const data = await sessionApi<Report>(`/guest/tasks/${taskId}`);
        if (!active) return; setReport(data); setError("");
        if (!complete(data.status)) timer = setTimeout(() => void poll(), 2500);
      } catch (e) { if (active) { setError((e as Error).message); timer = setTimeout(() => void poll(), 10000); } }
    };
    void poll(); return () => { active = false; clearTimeout(timer); };
  }, [taskId]);
  const submit = async () => {
    setError("");
    if (!files.length || files.some(f => !f.size || f.size > 52428800) || files.length > 50 || files.reduce((n, f) => n + f.size, 0) > 262144000) {
      setError("Выберите до 50 файлов по 50 МБ, общим объёмом до 250 МБ."); return;
    }
    setBusy(true);
    try {
      const criteria = guestCriteriaSchema.parse({ ...values, keywords: values.keywords.split(/[,\n]/).map(v => v.trim()).filter(Boolean),
        stop_factors: values.stop_factors.split(/[,\n]/).map(v => v.trim()).filter(Boolean) });
      setStage("Подготовка отправки…");
      const hex = (data: ArrayBuffer) => Array.from(new Uint8Array(data), b => b.toString(16).padStart(2, "0")).join("");
      const descriptions = [];
      for (const file of files) descriptions.push({ name: file.name, size: file.size, sha256: hex(await crypto.subtle.digest("SHA-256", await file.arrayBuffer())) });
      const fingerprint = hex(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify({ criteria, files: descriptions }))));
      if (attempt.current?.fingerprint !== fingerprint) attempt.current = { fingerprint, key: crypto.randomUUID() };
      let ticket = await sessionApi<Ticket>("/guest/queue", { method: "POST", body: JSON.stringify({ file_count: files.length, size_bytes: files.reduce((n, f) => n + f.size, 0) }) });
      while (ticket.status === "waiting") {
        setStage(`Ожидание допуска · место ${ticket.position}. Файлы ещё не передаются.`);
        await new Promise(resolve => setTimeout(resolve, 2000)); if (!mounted.current) return;
        ticket = await sessionApi<Ticket>(`/guest/queue/${ticket.id}`);
      }
      if (!mounted.current) return;
      setStage("Загрузка файлов…");
      const form = new FormData(); form.append("criteria", JSON.stringify(criteria)); for (const file of files) form.append("files", file);
      const result = await sessionApi<Report>("/guest/tasks", { method: "POST", headers: { "Idempotency-Key": attempt.current!.key, "X-Submission-Digest": fingerprint, "X-Upload-Permit": ticket.id }, body: form });
      if (mounted.current) { localStorage.setItem("hr_guest_task", result.task_id); setReport(result); setTaskId(result.task_id); setStage(""); }
    } catch (e) { if (mounted.current) setError((e as Error).message); }
    finally { if (mounted.current) setBusy(false); }
  };
  return <Framework className="guest-app"><div className={`guest-page ${report ? "guest-page--report" : ""}`}>
    <header className="guest-header"><img src="/assets/brand/brand-54ddb68464f478e321f2.webp" alt="Алабуга" />
      {report ? <><div className="guest-report-title"><h1 className="af-heading">Результаты оценки</h1><p>Доступно до {new Date(report.expires_at).toLocaleString("ru-RU", { timeZone: "Europe/Moscow" })} МСК</p></div>
        <Button className="guest-download" disabled={downloading} aria-busy={downloading} onClick={() => void saveReport()}><Download size={20} aria-hidden="true" />Скачать отчёт</Button></>
        : <Button secondary onClick={onLogin}>Вход для сотрудников</Button>}
    </header>
    <main className="guest-main">{!report && <div className="guest-intro"><h1 className="af-heading">Оценка резюме</h1>
      <p className="af-body">Задайте критерии и загрузите резюме. Отчёт будет доступен до двух часов после обработки, но не более суток с отправки.</p></div>}
      {!report && !taskId && <form className="af-card af-card--outer guest-form" onSubmit={e => { e.preventDefault(); void submit(); }}>
        <div className="guest-fields">{guestFields.map(({ key, label, hint }) => <div className={`af-field ${key === "name" || key === "comment" ? "guest-field--wide" : ""}`} key={key}>
          <div className="guest-field-heading"><label className="af-label" htmlFor={`${attachmentsId}-${key}`} id={`${attachmentsId}-${key}-label`}>{label}</label>
            <InfoHint id={`${attachmentsId}-${key}-help`} label={label}>{hint}</InfoHint></div>
          {key === "name" ? <input id={`${attachmentsId}-${key}`} className="af-input af-input--lg" name={key} aria-labelledby={`${attachmentsId}-${key}-label`} aria-describedby={`${attachmentsId}-${key}-help`} maxLength={300} required disabled={busy} value={values[key]} onChange={e => setValues({ ...values, [key]: e.target.value })} />
            : <textarea id={`${attachmentsId}-${key}`} className="af-textarea" name={key} aria-labelledby={`${attachmentsId}-${key}-label`} aria-describedby={`${attachmentsId}-${key}-help`} rows={3} maxLength={10000} disabled={busy} value={values[key]} onChange={e => setValues({ ...values, [key]: e.target.value })} />}
        </div>)}</div>
        <section className="guest-attachments" aria-labelledby={`${attachmentsId}-heading`}>
          <div className="guest-field-heading"><h2 className="af-label" id={`${attachmentsId}-heading`}>Резюме или ZIP-архив</h2>
            <InfoHint id={`${attachmentsId}-help`} label="Резюме или ZIP-архив">Прикрепите резюме кандидатов отдельными файлами или ZIP-архивом. Форматы: PDF, DOCX, DOC, RTF, TXT, ZIP. До 50 файлов по 50 МБ, всего — до 250 МБ. PDF может содержать нескольких кандидатов.</InfoHint></div>
          <div className="guest-attachment-control"><Button secondary className="af-btn--lg" disabled={busy} aria-describedby={`${attachmentsId}-help ${attachmentsId}-status`} onClick={() => fileInput.current?.click()}>
            <Paperclip className="af-btn__icon" size={24} aria-hidden="true" />{files.length ? "Изменить файлы" : "Прикрепить файлы"}
          </Button><p className="af-caption" id={`${attachmentsId}-status`} role="status">{files.length ? `Выбрано файлов: ${files.length} · ${fileSize(files.reduce((sum, file) => sum + file.size, 0))}` : "Файлы пока не выбраны"}</p></div>
          <input ref={fileInput} type="file" multiple hidden accept=".pdf,.zip,.docx,.doc,.rtf,.txt" aria-label="Резюме или ZIP-архив" disabled={busy} onChange={e => {
            const selected = Array.from(e.target.files || []);
            if (selected.length) { setFiles(selected); setError(""); }
            e.currentTarget.value = "";
          }} />
          {!!files.length && <ul className="guest-file-list" role="list">{files.map((file, index) => <li className="guest-file" key={`${file.name}-${index}`}>
            <FileText className="guest-file-icon" size={20} aria-hidden="true" /><div className="guest-file-details"><span className="af-body af-body--md">{file.name}</span><small className="af-caption">{fileSize(file.size)}</small></div>
            <Button className="af-btn--clear af-btn--icon" aria-label={`Убрать файл ${file.name}`} disabled={busy} onClick={() => { setFiles(current => current.filter((_, position) => position !== index)); setError(""); }}><X className="af-btn__icon" size={20} aria-hidden="true" /></Button>
          </li>)}</ul>}
        </section>
        {stage && <p role="status" aria-live="polite">{stage}</p>}<div className="guest-form-actions"><Button className="af-btn--lg" type="submit" disabled={busy} aria-busy={busy}>{busy ? "Отправка…" : "Оценить резюме"}</Button></div>
      </form>}
      <ErrorMessage message={error} />
      {!report && taskId && <section className="af-card af-card--outer guest-report-loading" role="status"><LoaderCircle className="guest-processing-spinner" size={20} aria-hidden="true" /><span>Получаем статус обработки…</span></section>}
      {report && <section ref={reportElement} className="guest-report" aria-label="Результаты оценки">
        <div className={`guest-processing guest-processing--${statusTone}`} role="status" aria-live="polite" aria-atomic="true">
          <div className="guest-processing-heading"><span>Статус обработки</span><span className="guest-processing-badge">
            {!complete(report.status) ? <LoaderCircle className="guest-processing-spinner" size={16} aria-hidden="true" /> : report.status === "completed" ? <CheckCircle2 size={16} aria-hidden="true" /> : <AlertCircle size={16} aria-hidden="true" />}
            {statusLabel[report.status] || "Статус не указан"}
          </span></div>
          <dl className="guest-processing-counts"><div><dt>{plural(report.source_count, ["источник", "источника", "источников"])}</dt><dd>{report.source_count}</dd></div><div><dt>{plural(report.candidate_count, ["кандидат", "кандидата", "кандидатов"])}</dt><dd>{report.candidate_count}</dd></div><div><dt>оценок</dt><dd>{report.candidate_count ? `${report.completed_count} из ${report.candidate_count}` : report.completed_count}</dd></div></dl>
          {report.status !== "completed" && <p>{statusDescription[report.status]}</p>}
        </div>
        {!!rankedResults.length && <p className="af-caption guest-results-order">По убыванию основного балла{rankedResults.some(result => result.evaluations.length > 1) ? " · по наибольшей оценке кандидата" : ""}</p>}
        <h2 className="sr-only">Оценки кандидатов</h2>
        <div className="guest-candidates">{rankedResults.map((result, index) => <details key={result.file_id} className="guest-candidate" hidden={index >= shownCandidates} open={expandedCandidates[result.file_id] ?? index === 0}
          onToggle={event => { const open = event.currentTarget.open; setExpandedCandidates(current => current[result.file_id] === open ? current : { ...current, [result.file_id]: open }); }}>
          <summary className="guest-candidate-heading">
            <ChevronRight className="guest-candidate-chevron" size={22} aria-hidden="true" />
            <div className="guest-candidate-name"><h3>{[result.candidate.last_name, result.candidate.first_name, result.candidate.middle_name].filter(Boolean).join(" ") || "Имя не указано"}</h3>
            </div>
            <div className="guest-candidate-score"><span className="sr-only">{result.evaluations.length > 1 ? "Оценки" : "Основная оценка"}</span>
              {result.evaluations.map(evaluation => <span className="guest-score-value" key={evaluation.target_id}><Score value={evaluation.score} /><span className="guest-score-scale">из 100</span></span>)}
            </div>
          </summary>
          <div className="guest-candidate-body">{result.evaluations.map(evaluation => <div key={evaluation.target_id}>
            {result.evaluations.length > 1 && <div className="guest-rating-score"><span>Основная оценка</span><Score value={evaluation.score} /><span>из 100</span></div>}
            <RatingAnalysis rating={evaluation} compact />
          </div>)}</div></details>)}</div>
        {rankedResults.length > shownCandidates && <Button secondary className="af-btn--clear guest-show-more" onClick={() => setVisibleCandidates(rankedResults.length)}>Ещё {rankedResults.length - shownCandidates} {plural(rankedResults.length - shownCandidates, ["кандидат", "кандидата", "кандидатов"])}<ChevronRight size={18} aria-hidden="true" /></Button>}
        {report.errors.map((item, i) => <p className="af-alert af-alert--warning" key={i}>{item.message}</p>)}
        {complete(report.status) && report.status !== "completed" && <p>Сохранённая часть отчёта доступна для скачивания. Для новой обработки отправьте файлы заново.</p>}
        <div className="guest-actions"><Button secondary onClick={() => { attempt.current = undefined; setTaskId(""); setReport(undefined); setFiles([]); localStorage.removeItem("hr_guest_task"); }}>Новая отправка</Button>
          <Button secondary onClick={async () => { try { await sessionApi(`/guest/tasks/${report.task_id}`, { method: "DELETE" }); localStorage.removeItem("hr_guest_task"); setTaskId(""); setReport(undefined); setFiles([]); } catch (e) { setError((e as Error).message); } }}>Удалить данные</Button>
          <Button secondary className="af-btn--clear guest-report-login" onClick={onLogin}>Вход для сотрудников</Button></div>
      </section>}
      {!report && taskId && <Button secondary onClick={() => { setTaskId(""); localStorage.removeItem("hr_guest_task"); setError(""); }}>Новая отправка</Button>}
    </main>
  </div></Framework>;
}
