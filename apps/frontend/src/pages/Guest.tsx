import { useEffect, useId, useRef, useState } from "react";
import { FileText, Paperclip, X } from "lucide-react";
import { guestCriteriaSchema, type ProcessingResult } from "@hr/contracts";
import { Button, ErrorMessage, Framework, InfoHint } from "../components/ui";
import { sessionApi } from "../lib/session-api";

interface Report { task_id: string; status: string; source_count: number; candidate_count: number; completed_count: number; expires_at: string;
  results: ({ file_id: string } & Extract<ProcessingResult, { evaluations: unknown }> )[];
  errors: { file_id: string; message: string; code: string }[] }
interface Ticket { id: string; status: "waiting" | "admitted"; position: number }
const complete = (status: string) => ["completed", "partially_completed", "failed"].includes(status);
const statusLabel: Record<string, string> = { uploading: "Загрузка не завершена", queued: "В очереди на обработку", processing: "Обработка", completed: "Готово", partially_completed: "Готова часть отчёта", failed: "Обработка завершилась ошибкой" };
const criteriaLabels: Record<string, string> = { education: "Образование", experience: "Опыт", keywords: "Навыки" };
const matchLabels: Record<string, string> = { matched: "Соответствует", partial: "Частично", not_matched: "Не соответствует", unknown: "Нет сведений" };
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
  const [stage, setStage] = useState(""), [files, setFiles] = useState<File[]>([]);
  const [values, setValues] = useState({ name: "Подбор кандидатов", education: "", experience: "", keywords: "", stop_factors: "", comment: "" });
  const [taskId, setTaskId] = useState(() => localStorage.getItem("hr_guest_task") || "");
  const mounted = useRef(true), attempt = useRef<{ fingerprint: string; key: string } | undefined>(undefined);
  const fileInput = useRef<HTMLInputElement>(null), attachmentsId = useId();
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => {
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
  return <Framework className="guest-app"><div className="guest-page">
    <header className="guest-header"><img src="/assets/brand/brand-54ddb68464f478e321f2.webp" alt="Алабуга" /><Button secondary onClick={onLogin}>Вход для сотрудников</Button></header>
    <main className="guest-main"><div className="guest-intro"><h1 className="af-heading">Оценка резюме</h1>
      <p className="af-body">Задайте критерии и загрузите резюме. Отчёт будет доступен до двух часов после обработки, но не более суток с отправки.</p></div>
      {!report && <form className="af-card af-card--outer guest-form" onSubmit={e => { e.preventDefault(); void submit(); }}>
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
      {report && <section className="af-card af-card--outer guest-report" aria-live="polite"><h2 className="af-title">{statusLabel[report.status] || report.status}</h2>
        <p>Источников: {report.source_count}. Найдено кандидатов: {report.candidate_count}. Готово оценок: {report.completed_count}.</p>
        <p>Доступно до {new Date(report.expires_at).toLocaleString("ru-RU", { timeZone: "Europe/Moscow" })} МСК.</p>
        {report.results.map(result => <article key={result.file_id} className="guest-candidate"><h3>{[result.candidate.last_name, result.candidate.first_name, result.candidate.middle_name].filter(Boolean).join(" ") || "Имя не указано"}</h3>
          {result.evaluations.map(evaluation => <div key={evaluation.target_id}><strong>{evaluation.score} из 100</strong><dl>{evaluation.criteria.map(c => <div key={c.name}><dt>{criteriaLabels[c.name]} · {matchLabels[c.status]}</dt><dd>{c.explanation}</dd></div>)}</dl>
            {!!evaluation.triggered_stop_factors.length && <p>Стоп-факторы: {evaluation.triggered_stop_factors.join(", ")}</p>}<p>{evaluation.explanation}</p></div>)}</article>)}
        {report.errors.map((item, i) => <p className="af-alert af-alert--warning" key={i}>{item.message}</p>)}
        {complete(report.status) && report.status !== "completed" && <p>Сохранённая часть отчёта доступна для скачивания. Для новой обработки отправьте файлы заново.</p>}
        <div className="guest-actions"><a className="af-btn" href={`/api/guest/tasks/${report.task_id}/download`} download>Скачать отчёт</a>
          <Button secondary onClick={() => { attempt.current = undefined; setTaskId(""); setReport(undefined); setFiles([]); localStorage.removeItem("hr_guest_task"); }}>Новая отправка</Button>
          <Button secondary onClick={async () => { try { await sessionApi(`/guest/tasks/${report.task_id}`, { method: "DELETE" }); localStorage.removeItem("hr_guest_task"); setTaskId(""); setReport(undefined); setFiles([]); } catch (e) { setError((e as Error).message); } }}>Удалить данные</Button></div>
      </section>}
      {!report && taskId && <Button secondary onClick={() => { setTaskId(""); localStorage.removeItem("hr_guest_task"); setError(""); }}>Новая отправка</Button>}
    </main>
  </div></Framework>;
}
