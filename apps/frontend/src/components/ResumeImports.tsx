import { useEffect, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import type { ResumeImportDetail, ResumeImportItem, ResumeImportSummary, BrokerStatus } from "@hr/contracts";
import { formatMoscowDateTime } from "@hr/contracts";
import { api, mutate } from "../lib/api";
import { useData } from "../lib/store";
import { Button, ErrorMessage } from "./ui";

const labels = { uploading: "Загрузка в хранилище", pending: "Ожидает анализа", processing: "Анализируется", completed: "Готово", failed: "Ошибка" };
export function ResumeImports() {
  const { resumeImports, resumeImportsError, refresh } = useData(), [params] = useSearchParams();
  const [selected, setSelected] = useState(params.get("batch") || ""), [detail, setDetail] = useState<ResumeImportDetail>(),
    [error, setError] = useState(""), [busy, setBusy] = useState("");
  const [broker, setBroker] = useState<BrokerStatus>();
  useEffect(() => {
    let active = true, loading = false;
    const load = async () => {
      if (loading || document.hidden) return;
      loading = true;
      try { const status = await api<BrokerStatus>("/processing/queue"); if (active) setBroker(status); }
      catch { if (active) setBroker(undefined); }
      finally { loading = false; }
    };
    void load(); const timer = setInterval(() => void load(), 5000);
    return () => { active = false; clearInterval(timer); };
  }, []);
  const currentId = selected || resumeImports[0]?.id;
  useEffect(() => {
    if (params.get("batch")) setSelected(params.get("batch")!);
  }, [params]);
  useEffect(() => {
    setDetail(undefined); setError("");
    if (!currentId) return;
    let active = true, running = false;
    const load = async () => {
      if (running || document.hidden) return;
      running = true;
      try {
        const next = await api<ResumeImportDetail>(`/resume-imports/${currentId}`);
        if (active) { setDetail(next); setError(""); }
      } catch (error) { if (active) setError((error as Error).message); }
      finally { running = false; }
    };
    void load(); const timer = setInterval(() => void load(), 3000);
    return () => { active = false; clearInterval(timer); };
  }, [currentId]);
  if (!resumeImports.length) return resumeImportsError ? <ErrorMessage message={resumeImportsError} /> : null;
  const current: ResumeImportSummary | undefined = detail ?? resumeImports.find(batch => batch.id === currentId);
  const canRetry = (item: ResumeImportItem) => item.status === "failed";
  return <section className="af-card panel resume-imports" aria-label="Массовая обработка резюме">
    <div className="panel-heading"><h2 className="af-title">Загрузки резюме</h2>
      <span className="af-badge badge badge--neutral">В обработке: {resumeImports.reduce((sum, batch) => sum + batch.pending_files, 0)}</span>
    </div>
    <div className="import-content">
    {broker && <p className="muted" role="status">В очереди анализа: {broker.queues["hr.resume.analysis"]?.ready || 0} · Анализируются: {broker.queues["hr.resume.analysis"]?.processing || 0}
      {!broker.analysis_consumers && " · Обработка начнётся после подключения обработчика резюме."}</p>}
    <label className="af-label" htmlFor="resume-import-batch">Загрузка</label>
    <select id="resume-import-batch" className="af-select" value={currentId} onChange={event => setSelected(event.target.value)}>
      {resumeImports.map(batch => <option key={batch.id} value={batch.id}>{batch.archive_name} · {formatMoscowDateTime(batch.created_at)} МСК · {batch.processed_files}/{batch.total_files}</option>)}
    </select>
    <ErrorMessage message={error} />
    <ErrorMessage message={resumeImportsError ?? ""} />
    {current && <>
      <p role="status">Всего резюме: <strong>{current.total_files}</strong> · Обработано: <strong>{current.processed_files}</strong> · В обработке: <strong>{current.pending_files}</strong> · Ошибок: <strong>{current.failed_files}</strong></p>
      <progress className="import-progress" aria-label="Прогресс обработки архива" value={current.processed_files + current.failed_files} max={current.total_files} />
      {!!current.pending_files && <p className="muted">Кандидаты и рейтинги появятся после анализа файлов. Прогресс обновляется автоматически.</p>}
      {!!current.ignored_files.length && <details><summary>Пропущено файлов: {current.ignored_files.length}</summary><ul>{current.ignored_files.map(path => <li key={path}>{path}</li>)}</ul></details>}
    </>}
    {detail && <div className="import-file-list">{detail.items.map(item => <div className="import-file" key={item.id}>
      <div><strong>{item.source_path}</strong><small>{labels[item.status]} · Попытка {item.attempt}</small>
        {item.error && <p className="import-error">{item.error}</p>}{item.warning && <p>{item.warning}</p>}
      </div>
      {item.resume_id && <Link className="af-link" to={`/processing?resume=${item.resume_id}`}>Кандидат</Link>}
      {canRetry(item) && <Button secondary disabled={!!busy} onClick={async () => {
        setBusy(item.id); setError("");
        try { setDetail(await mutate<ResumeImportDetail>(`/resume-imports/${currentId}/items/${item.id}/retry`, {})); await refresh(); }
        catch (error) { setError((error as Error).message); }
        finally { setBusy(""); }
      }}>{busy === item.id ? "Отправляем…" : "Повторить"}</Button>}
    </div>)}</div>}
    </div>
  </section>;
}
