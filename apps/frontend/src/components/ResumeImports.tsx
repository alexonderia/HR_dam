import { useEffect, useId, useRef, useState } from "react";
import { Link } from "react-router-dom";
import {
  AlertCircle, ArrowUpRight, CheckCircle2, ChevronLeft, ChevronRight,
  Clock3, FileText, Files, FolderOpen, LoaderCircle, RefreshCw, Search,
  ShieldAlert, UploadCloud, UserRound,
} from "lucide-react";
import type { ResumeImportDetail, ResumeImportSummary, BrokerStatus, ImportItemStatus } from "@hr/contracts";
import { formatMoscowDateTime, formatMoscowTime, formatAnalysisDuration } from "@hr/contracts";
import { api, mutate } from "../lib/api";
import { useData } from "../lib/store";
import { Button, ErrorMessage } from "./ui";
import { groupCandidateImports, candidateImportStatus, type TrackingItem } from "../lib/import-groups";

const stages = {
  uploading: { label: "Загрузка в хранилище", filter: "Загружаются", icon: UploadCloud },
  pending: { label: "Ожидает анализа", filter: "В очереди", icon: Clock3 },
  processing: { label: "Анализируется", filter: "Анализируются", icon: LoaderCircle },
  completed: { label: "Готово", filter: "Готовы", icon: CheckCircle2 },
  failed: { label: "Ошибка", filter: "Ошибки", icon: AlertCircle },
};
type FileFilter = "all" | ImportItemStatus;
const priority = { failed: 0, processing: 1, uploading: 2, pending: 3, completed: 4 };
const pageSize = 10;
const oneHourMs = 60 * 60 * 1000;

function elapsedAnalysisTime(startedAt: string, now: number) {
  const seconds = Math.max(0, Math.floor((now - Date.parse(startedAt)) / 1000));
  if (seconds < 60) return `${seconds} с`;
  const minutes = Math.floor(seconds / 60);
  return minutes < 60 ? `${minutes} мин ${seconds % 60} с` : `${Math.floor(minutes / 60)} ч ${minutes % 60} мин`;
}

export function ResumeImports({ lastHourOnly = false }: { lastHourOnly?: boolean }) {
  const { resumeImports, resumeImportsError, refresh, analysis, loading, candidates } = useData();
  const [selected, setSelected] = useState("");
  const [snapshot, setSnapshot] = useState<{ batches: ResumeImportDetail[]; fetchedAt: Date }>();
  const [error, setError] = useState("");
  const [retryError, setRetryError] = useState("");
  const [busy, setBusy] = useState("");
  const [broker, setBroker] = useState<BrokerStatus>();
  const [reload, setReload] = useState(0);
  const [filter, setFilter] = useState<FileFilter>("all");
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(1);
  const [filesExpanded, setFilesExpanded] = useState(false);
  const fileListId = useId();
  const [now, setNow] = useState(() => Date.now());
  const retrying = useRef("");
  const requestVersion = useRef(0);
  const inPeriod = (batch: ResumeImportSummary) => !lastHourOnly || Date.parse(batch.created_at) >= now - oneHourMs;
  const batches = (snapshot?.batches ?? resumeImports).filter(inPeriod);
  const hasImports = resumeImports.length > 0;
  const current = batches.reduce((sum, batch) => ({
    ...sum, total_files: sum.total_files + batch.total_files,
    processed_files: sum.processed_files + batch.processed_files,
    failed_files: sum.failed_files + batch.failed_files,
    pending_files: sum.pending_files + batch.pending_files,
    uploading_files: sum.uploading_files + batch.uploading_files,
    processing_files: sum.processing_files + batch.processing_files,
    ignored_files: [...sum.ignored_files, ...batch.ignored_files.map(path => `${batch.archive_name}: ${path}`)],
  }), { total_files: 0, processed_files: 0, failed_files: 0, pending_files: 0, uploading_files: 0, processing_files: 0, ignored_files: [] } as Pick<ResumeImportSummary,
    "total_files" | "processed_files" | "failed_files" | "pending_files" | "uploading_files" | "processing_files" | "ignored_files">);
  const allItems: TrackingItem[] = snapshot?.batches.flatMap(batch => batch.items.map(item => ({
    ...item, batchId: batch.id, batchName: batch.archive_name, batchCreatedAt: batch.created_at,
  }))) ?? [];
  const items = allItems.filter(item => !lastHourOnly || Date.parse(item.batchCreatedAt) >= now - oneHourMs);

  useEffect(() => {
    if (!lastHourOnly && !current.processing_files) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [lastHourOnly, current.processing_files]);
  const selectedBatchExists = !selected || batches.some(batch => batch.id === selected);
  useEffect(() => {
    if (!selectedBatchExists) { setSelected(""); setPage(1); }
  }, [selectedBatchExists]);
  useEffect(() => {
    let active = true, loading = false;
    const controller = new AbortController();
    const load = async () => {
      if (loading || document.hidden) return;
      loading = true;
      try {
        const status = await api<BrokerStatus>("/processing/queue", { signal: AbortSignal.any([controller.signal, AbortSignal.timeout(6500)]) });
        if (active) setBroker(status);
      } catch { if (active) setBroker(undefined); }
      finally { loading = false; }
    };
    void load();
    const timer = setInterval(() => void load(), 5000);
    return () => { active = false; controller.abort(); clearInterval(timer); };
  }, [reload]);
  useEffect(() => {
    if (!hasImports) return;
    let active = true, running = false;
    const controller = new AbortController();
    const load = async () => {
      if (running || document.hidden || retrying.current) return;
      running = true;
      const version = requestVersion.current;
      try {
        const next = await api<ResumeImportDetail[]>("/resume-imports/status", {
          signal: AbortSignal.any([controller.signal, AbortSignal.timeout(10000)]),
        });
        if (active && version === requestVersion.current) {
          setSnapshot({ batches: next, fetchedAt: new Date() }); setError("");
        }
      } catch {
        if (active && version === requestVersion.current) setError("Не удалось обновить общий статус проверок. Последние полученные данные сохранены; повторим автоматически.");
      } finally { running = false; }
    };
    void load();
    const timer = setInterval(() => void load(), 3000);
    return () => { active = false; controller.abort(); clearInterval(timer); };
  }, [hasImports, reload]);

  async function retry(item: TrackingItem) {
    if (retrying.current) return;
    const batchId = item.batchId;
    retrying.current = batchId; requestVersion.current++;
    setBusy(item.id); setRetryError("");
    try {
      const next = await mutate<ResumeImportDetail>(`/resume-imports/${batchId}/items/${item.id}/retry`, {});
      setSnapshot(previous => previous ? {
        batches: previous.batches.map(batch => batch.id === batchId ? next : batch), fetchedAt: new Date(),
      } : previous);
      await refresh();
    } catch (cause) {
      setRetryError((cause as Error).message);
    } finally {
      retrying.current = ""; setBusy("");
    }
  }

  if (!batches.length && !lastHourOnly) return resumeImportsError ? <ErrorMessage message={resumeImportsError} /> : null;
  const counts = {
    all: current?.total_files ?? 0,
    uploading: current?.uploading_files ?? 0,
    pending: Math.max(0, (current?.pending_files ?? 0) - (current?.uploading_files ?? 0) - (current?.processing_files ?? 0)),
    processing: current?.processing_files ?? 0,
    completed: current?.processed_files ?? 0,
    failed: current?.failed_files ?? 0,
  };
  const settled = counts.completed + counts.failed;
  const percent = counts.all ? Math.round(settled / counts.all * 100) : 0;
  const remaining = current?.pending_files ?? 0;
  const analyzing = counts.processing > 0;
  const activeFiles = items.filter(item => item.status === "processing");
  const waitingForAnalysis = remaining > 0 && !analyzing && (!analysis.available || broker?.analysis_consumers === 0);
  const query = search.trim().toLocaleLowerCase("ru");
  const groups = groupCandidateImports(items, candidates, allItems);
  const filtered = groups.map(group => ({ ...group, total: group.items.length, items: group.items.filter(item =>
    (!selected || item.batchId === selected) && (filter === "all" || item.status === filter) &&
    `${group.name} ${group.phone || ""} ${item.file_name} ${item.source_path} ${item.batchName}`.toLocaleLowerCase("ru").includes(query),
  ) })).filter(group => group.items.length).sort((a, b) =>
    priority[candidateImportStatus(a.items)] - priority[candidateImportStatus(b.items)]
      || Date.parse(b.items[0].updated_at) - Date.parse(a.items[0].updated_at) || a.name.localeCompare(b.name, "ru", { numeric: true }));
  const pageCount = Math.max(1, Math.ceil(filtered.length / pageSize));
  const currentPage = Math.min(page, pageCount);
  const rows = filtered.slice((currentPage - 1) * pageSize, currentPage * pageSize);
  const filters = [
    { id: "all" as const, label: "Всего файлов", icon: Files },
    ...Object.entries(stages).map(([id, stage]) => ({ id: id as ImportItemStatus, label: stage.filter, icon: stage.icon })),
  ];

  return <section className="af-card panel resume-imports" aria-label="Массовая обработка резюме">
    <div className="panel-heading import-heading">
      <div className="import-heading-title"><span className="import-heading-icon"><FolderOpen size={22} /></span><div>
        <h2 className="af-title">Общий статус проверок</h2>
        <p>{lastHourOnly ? "Загрузки за последний час" : "Все загрузки"}</p>
      </div></div>
      <div className="toolbar"><span className="af-badge badge badge--neutral">Всего в обработке: {remaining}</span>
        <Button secondary disabled={!!busy} onClick={() => { setReload(value => value + 1); void refresh(); }}><RefreshCw size={16} />Обновить</Button></div>
    </div>
    <div className="import-content">
      <ErrorMessage message={error} />
      <ErrorMessage message={retryError} />
      <ErrorMessage message={resumeImportsError ?? ""} />
      {counts.all > 0 && <>
        <div className="import-overview">
          <div className="import-progress-heading">
            <div><h3>{analyzing ? "Идёт анализ резюме" : counts.uploading ? "Файлы загружаются в хранилище" : remaining ? "Ожидание начала анализа" : counts.failed ? "Обработка завершена с ошибками" : "Все резюме обработаны"}</h3>
              <p>Завершено <strong>{settled} из {counts.all}</strong>{counts.failed > 0 && ` · с ошибками: ${counts.failed}`}</p></div>
            <strong className="import-percentage">{percent}<span>%</span></strong>
          </div>
          <div className="import-progress" role="progressbar" aria-label="Общий прогресс проверок" aria-valuemin={0} aria-valuemax={counts.all || 1} aria-valuenow={settled}
            aria-valuetext={`Завершено ${settled} из ${counts.all}. Готово: ${counts.completed}, ошибок: ${counts.failed}.`}>
            <span className="import-progress-success" style={{ width: `${counts.all ? counts.completed / counts.all * 100 : 0}%` }} />
            <span className="import-progress-failed" style={{ width: `${counts.all ? counts.failed / counts.all * 100 : 0}%` }} />
          </div>
        </div>
        {analyzing && <div className={`import-analysis${error ? " import-analysis--stale" : ""}`} aria-label="Текущий анализ">
          <div className="import-analysis-heading"><LoaderCircle size={18} className={error ? undefined : "spin"} /><div>
            <strong>{error ? "Последний полученный статус: идёт анализ" : "Обработчик анализирует резюме"}</strong>
            {error && <p>Связь прервана. Уточним состояние после восстановления подключения.</p>}
          </div></div>
          <ul className="import-analysis-files">{activeFiles.slice(0, 3).map(item => <li key={`${item.batchId}-${item.id}`}>
            <strong>{item.file_name}</strong><span>Начало {formatMoscowTime(item.analysis_started_at || item.updated_at)} МСК · {error ? "Статус получен" : "Прошло"} {error && snapshot ? formatMoscowTime(snapshot.fetchedAt) + " МСК" : elapsedAnalysisTime(item.analysis_started_at || item.updated_at, now)}</span>
          </li>)}</ul>
          {activeFiles.length > 3 && <button type="button" className="af-link import-analysis-more" onClick={() => { setFilesExpanded(true); setSelected(""); setFilter("processing"); setPage(1); }}>Показать все анализируемые файлы: {counts.processing}</button>}
          {!error && <div className="import-analysis-activity" aria-hidden="true"><span /></div>}
        </div>}
        <div className="import-metrics" role="group" aria-label="Фильтр файлов по состоянию">
          {filters.map(({ id, label, icon: Icon }) => <button key={id} type="button" className={`import-metric import-metric--${id}${filter === id ? " is-selected" : ""}`}
            aria-pressed={filter === id} onClick={() => { setFilesExpanded(true); setSelected(""); setFilter(id); setPage(1); }}>
            <span><Icon size={17} className={id === "processing" && analyzing ? "spin" : undefined} /><span>{label}</span></span><strong>{counts[id]}</strong>
          </button>)}
        </div>
        {waitingForAnalysis && <div className="import-service-notice" role="status"><Clock3 size={19} /><div>
          <strong>Ожидаем доступности анализа</strong>
          <p>{!analysis.available ? analysis.message : "Обработка начнётся после подключения обработчика резюме."} Повторная загрузка не требуется.</p>
        </div></div>}
        {!!current.ignored_files.length && <details className="import-ignored"><summary>Пропущено файлов: {current.ignored_files.length} <span>· не входят в прогресс</span></summary>
          <p>Служебные файлы и неподдерживаемые форматы не отправляются на анализ.</p>
          <ul>{current.ignored_files.map((path, index) => <li key={`${index}-${path}`}>{path}</li>)}</ul>
        </details>}
      </>}
      {counts.all > 0 ? <div className="import-files-section">
        <button type="button" className="af-btn af-btn--clear import-list-toggle" aria-label="Список загрузок" aria-expanded={filesExpanded} aria-controls={fileListId}
          onClick={() => setFilesExpanded(value => !value)}>
          <ChevronRight size={17} className={filesExpanded ? "is-expanded" : undefined} />
          <strong>Список загрузок</strong><span className="af-badge badge badge--neutral">{counts.all}</span>
          <span className="import-list-toggle-hint">{filesExpanded ? "Свернуть" : "Развернуть"}</span>
        </button>
        <div id={fileListId} className="import-list-body" hidden={!filesExpanded}>
        <div className="import-files-toolbar">
          <div><h3>По кандидатам{filter !== "all" ? ` · ${stages[filter].filter.toLocaleLowerCase("ru")}` : ""}</h3><p>Раскройте кандидата, чтобы увидеть историю загрузок.</p></div>
          <div className="search import-search"><Search size={17} /><input className="af-input" aria-label="Поиск файлов загрузки" placeholder="Кандидат, телефон или файл" value={search}
            onChange={event => { setSearch(event.target.value); setPage(1); }} /></div>
        </div>
        <details className="import-scope-options"><summary>{selected ? `Файлы одной загрузки: ${batches.find(batch => batch.id === selected)?.archive_name ?? selected}` : "Уточнить загрузку"}</summary>
          <div className="af-field import-batch-field"><label className="af-label" htmlFor="resume-import-batch">Фильтр списка по загрузке</label>
            <select id="resume-import-batch" className="af-select" value={selected} onChange={event => { setSelected(event.target.value); setPage(1); }}>
              <option value="">Все загрузки</option>
              {batches.map(batch => <option key={batch.id} value={batch.id}>{batch.archive_name} · {formatMoscowDateTime(batch.created_at)} МСК</option>)}
            </select></div>
        </details>
        {!snapshot ? <div className="import-list-empty" role="status">{error ? <><AlertCircle size={24} /><strong>Не удалось получить список файлов</strong><span>Нажмите «Обновить» или дождитесь автоматического обновления.</span></>
          : <><LoaderCircle size={24} className="spin" /><span>Получаем состояние файлов…</span></>}</div>
          : !rows.length ? <div className="import-list-empty"><Search size={24} /><strong>Файлы не найдены</strong><span>Измените название или выберите другое состояние.</span>
            <Button secondary onClick={() => { setSelected(""); setFilter("all"); setSearch(""); setPage(1); }}>Показать все файлы</Button></div>
            : <ul className="import-candidate-list" aria-label="Загрузки по кандидатам">{rows.map(group => {
              const status = candidateImportStatus(group.items), latest = group.items.find(item => item.status === status)!, StageIcon = stages[status].icon;
              return <li key={group.key}><details className="import-candidate-group">
                <summary className="import-candidate-summary">
                  <ChevronRight size={17} className="import-candidate-chevron" />
                  <span className="import-candidate-name"><strong><UserRound size={16} />{group.name}</strong>
                    <small>{group.phone || (group.identified ? latest.file_name : "ФИО не указано")}</small>
                    <small>Загрузок: {group.total}{group.items.length !== group.total && ` · показано: ${group.items.length}`}</small>
                  </span>
                  <span className={`import-candidate-status import-file-status--${status}`}><StageIcon size={15} className={status === "processing" ? "spin" : undefined} />{stages[status].label}</span>
                  <span className="import-candidate-updated"><time dateTime={latest.updated_at}>{formatMoscowDateTime(latest.updated_at)} МСК</time>
                    {["completed", "failed"].includes(latest.status) && <small>Время анализа: {formatAnalysisDuration(latest.analysis_duration_ms)}</small>}
                  </span>
                </summary>
                <ul className="import-file-list" aria-label={`История загрузок: ${group.name}`}>{group.items.map(item => {
              const stage = stages[item.status], Icon = stage.icon;
              const folder = item.source_path !== item.file_name ? item.source_path : "";
              return <li className={`import-file import-file--${item.status}`} key={`${item.batchId}-${item.id}`}>
                <div className="import-file-name"><span className="import-file-icon"><FileText size={20} /></span><div>
                  <strong>{item.file_name}</strong>{folder && <small>{folder}</small>}
                  <small>Загрузка: {item.batchName} · {formatMoscowDateTime(item.batchCreatedAt)} МСК</small>
                  {item.error && <p className="import-file-message import-error"><AlertCircle size={14} /><span>{item.error}</span></p>}
                  {item.warning && <p className="import-file-message import-warning"><ShieldAlert size={14} /><span>{item.warning}</span></p>}
                </div></div>
                <div className={`import-file-status import-file-status--${item.status}`}><Icon size={15} className={item.status === "processing" ? "spin" : undefined} />
                  <span>{stage.label} · Попытка {item.attempt}</span></div>
                <div className="import-file-updated"><small>Последнее изменение</small><time dateTime={item.updated_at}>{formatMoscowDateTime(item.updated_at)} МСК</time>
                  {["completed", "failed"].includes(item.status) && <span>Время анализа: {formatAnalysisDuration(item.analysis_duration_ms)}</span>}
                </div>
                <div className="import-file-actions">
                  {item.resume_id && <Link className="af-link" to={`/processing?resume=${item.resume_id}`}>Кандидат<ArrowUpRight size={14} /></Link>}
                  {item.status === "failed" && (item.attempt < 100
                    ? <Button secondary disabled={!!busy} onClick={() => void retry(item)}>{busy === item.id ? <LoaderCircle size={15} className="spin" /> : <RefreshCw size={15} />}{busy === item.id ? "Отправляем…" : "Повторить"}</Button>
                    : <small>Лимит попыток исчерпан. Загрузите файл заново.</small>)}
                </div>
              </li>;
                })}</ul>
              </details></li>;
            })}</ul>}
        {snapshot && <div className="import-list-footer">
          <span>{filtered.length ? `${(currentPage - 1) * pageSize + 1}–${Math.min(currentPage * pageSize, filtered.length)} из ${filtered.length} кандидатов` : "0 кандидатов"}</span>
          {pageCount > 1 && <div className="pagination">
            <Button secondary className="icon-button" disabled={currentPage <= 1} aria-label="Предыдущая страница файлов" onClick={() => setPage(currentPage - 1)}><ChevronLeft size={16} /></Button>
            <span>{currentPage} / {pageCount}</span>
            <Button secondary className="icon-button" disabled={currentPage >= pageCount} aria-label="Следующая страница файлов" onClick={() => setPage(currentPage + 1)}><ChevronRight size={16} /></Button>
          </div>}
        </div>}
        </div>
      </div> : <p className="muted" role="status">{loading && !snapshot ? "Получаем статус загрузок…" : error || resumeImportsError ? "Сведения о загрузках за последний час пока недоступны." : "За последний час загрузок не было."}</p>}
      <div className="import-live-status"><span className={`import-live-dot${error ? " import-live-dot--error" : ""}`} />
        <span>{error ? "Ожидаем восстановления связи" : "Автообновление каждые 3 секунды"}</span>
        {snapshot && <span>Обновлено {formatMoscowTime(snapshot.fetchedAt)} МСК</span>}
      </div>
    </div>
  </section>;
}
