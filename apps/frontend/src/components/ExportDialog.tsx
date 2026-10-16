import { useEffect, useId, useRef, useState } from "react";
import { Download, FileArchive, FileText, LoaderCircle, Printer } from "lucide-react";
import { fullName, type Candidate, type Cluster } from "@hr/contracts";
import { useData } from "../lib/store";
import { Button, ErrorMessage, Field, Modal } from "./ui";

export function ExportDialog({
  candidates,
  clusters,
  expanded = [],
  candidateReport = false,
  mode,
  onClose,
}: {
  candidates: Candidate[];
  clusters: Cluster[];
  expanded?: string[];
  candidateReport?: boolean;
  mode: "export" | "print";
  onClose: () => void;
}) {
  const { candidates: databaseCandidates, clusters: databaseClusters } = useData();
  const formId = useId();
  const errorRef = useRef<HTMLDivElement>(null);
  const [content, setContent] = useState("report"),
    [format, setFormat] = useState(mode === "print" ? "html" : "xlsx"),
    [individual, setIndividual] = useState(false),
    [allData, setAllData] = useState(false),
    [includeBlacklisted, setIncludeBlacklisted] = useState(true),
    [activeRequirementsOnly, setActiveRequirementsOnly] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  useEffect(() => {
    const body = errorRef.current?.closest(".dialog-body");
    if (error && body) body.scrollTop = body.scrollHeight;
  }, [error]);
  const isPrint = mode === "print";
  const isArchive = !isPrint && (allData || individual);
  const candidateCount = allData
    ? databaseCandidates.filter((candidate) => includeBlacklisted || !candidate.blacklisted).length
    : candidates.length;
  const profileCount = databaseClusters
    .filter((cluster) => !activeRequirementsOnly || cluster.is_active)
    .flatMap((cluster) => cluster.profiles)
    .filter((profile) => !activeRequirementsOnly || profile.is_active).length;
  const formatName = format === "xlsx" ? "Excel" : format.toUpperCase();
  // A complete archive can still contain requirements when the database has no candidates.
  const canSubmit = allData || candidateCount > 0;
  async function run() {
    if (busy || !canSubmit) return;
    const printWindow = mode === "print" ? window.open("", "_blank") : null;
    if (mode === "print" && !printWindow) {
      setError("Разрешите открытие окна печати в браузере.");
      return;
    }
    if (printWindow) {
      printWindow.opener = null;
      printWindow.document.body.textContent = "Подготовка к печати…";
    }
    setBusy(true);
    setError("");
    try {
      const response = await fetch("/api/export", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          candidate_ids: allData ? [] : candidates.map((c) => c.id),
          cluster_ids: allData ? [] : clusters.map((c) => c.id),
          expanded: allData ? [] : expanded,
          content: allData ? "report" : content,
          format,
          individual: !allData && individual,
          print: mode === "print",
          candidateReport,
          allData,
          includeBlacklisted,
          activeRequirementsOnly,
        }),
      });
      if (!response.ok) {
        const details = await response.json().catch(() => null);
        throw new Error(details?.error || "Не удалось сформировать экспорт. Повторите попытку.");
      }
      if (printWindow) {
        // Keep the document on the application origin so report styles remain available.
        const html = await response.text();
        printWindow.document.open();
        printWindow.document.write(html);
        printWindow.document.close();
        await new Promise<void>((resolve) => {
          if (printWindow.document.readyState === "complete") resolve();
          else
            printWindow.addEventListener("load", () => resolve(), {
              once: true,
            });
        });
        await printWindow.document.fonts.ready;
        if (!printWindow.closed) {
          printWindow.focus();
          printWindow.print();
        }
      } else {
        const url = URL.createObjectURL(await response.blob());
        const link = document.createElement("a");
        link.href = url;
        const disposition = response.headers.get("Content-Disposition") || "";
        const encodedName = disposition.match(/filename\*=UTF-8''([^;]+)/i)?.[1];
        const plainName = disposition.match(/filename="([^"]+)"/i)?.[1];
        link.download = encodedName ? decodeURIComponent(encodedName) : plainName ||
          `${allData ? "Все данные кандидатов" : candidateReport ? "Отчёт кандидата" : "Распределение кандидатов"}.${allData || individual ? "zip" : format}`;
        link.click();
        setTimeout(() => URL.revokeObjectURL(url), 60000);
      }
      onClose();
    } catch (e) {
      printWindow?.close();
      setError(e instanceof TypeError
        ? "Не удалось связаться с сервером. Проверьте подключение и повторите попытку."
        : (e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <Modal
      title={mode === "print" ? "Настройки печати" : "Настройки экспорта"}
      onClose={onClose}
      closeDisabled={busy}
      className="export-dialog"
      footer={
        <div className="dialog-footer">
          <Button secondary disabled={busy} onClick={onClose}>Отмена</Button>
          <Button type="submit" form={formId} disabled={busy || !canSubmit}>
            {busy ? <LoaderCircle size={16} className="spin" aria-hidden="true" />
              : isPrint ? <Printer size={16} aria-hidden="true" /> : <Download size={16} aria-hidden="true" />}
            {busy ? "Подготовка…" : isPrint ? "Перейти к печати" : isArchive ? "Скачать ZIP" : `Скачать ${formatName}`}
          </Button>
        </div>
      }
    >
      <form id={formId} className="export-settings" onSubmit={(event) => {
        event.preventDefault();
        void run();
      }}>
        {!isPrint && !candidateReport ? (
          <fieldset className="export-section" disabled={busy}>
            <legend>Что выгрузить</legend>
            <div className="export-scope">
              <label className="export-scope-option">
                <input className="af-radio" type="radio" name={`${formId}-scope`} checked={!allData}
                  onChange={() => setAllData(false)} aria-describedby={`${formId}-scope-hint`} />
                <span><strong>Текущая выборка</strong><small>Кандидатов: {candidates.length}</small></span>
              </label>
              <label className="export-scope-option">
                <input className="af-radio" type="radio" name={`${formId}-scope`} checked={allData}
                  onChange={() => setAllData(true)} aria-describedby={`${formId}-scope-hint`} />
                <span><strong>Вся база</strong><small>Кандидатов: {databaseCandidates.length} · ZIP</small></span>
              </label>
            </div>
            <p className="export-hint" id={`${formId}-scope-hint`}>
              {allData ? "Без фильтров таблицы, включая архивных кандидатов и ожидающих оценки."
                : "С учётом фильтров, сортировки и раскрытых профилей на всех страницах таблицы."}
            </p>
          </fieldset>
        ) : (
          <p className="export-context">{candidateReport
            ? (candidates[0] && fullName(candidates[0])) || "ФИО не указано"
            : `Кандидатов: ${candidates.length}. Учитываются фильтры и порядок строк на всех страницах.`}</p>
        )}

        {allData && (
          <fieldset className="export-section export-options" disabled={busy}>
            <legend>Состав базы</legend>
            <label className="af-check export-check">
              <input className="af-checkbox" type="checkbox" checked={includeBlacklisted}
                onChange={(e) => setIncludeBlacklisted(e.target.checked)} />
              <span>Включать кандидатов из чёрного списка
                <small>В базе: {databaseCandidates.filter((candidate) => candidate.blacklisted).length}</small>
              </span>
            </label>
            <label className="af-check export-check">
              <input className="af-checkbox" type="checkbox" checked={activeRequirementsOnly}
                onChange={(e) => setActiveRequirementsOnly(e.target.checked)} />
              <span>Только активные требования
                <small>Активные профили активных кластеров — в требованиях и оценках.</small>
              </span>
            </label>
          </fieldset>
        )}

        <fieldset className="export-section" disabled={busy}>
          <legend>{isPrint ? "Содержание" : "Параметры файлов"}</legend>
          <div className={`export-fields${allData || isPrint ? " export-fields--single" : ""}`}>
            {!allData && <Field label="Содержание">
              <select className="af-select" value={content} onChange={(e) => setContent(e.target.value)}>
                <option value="report">Полный отчёт с обоснованиями</option>
                <option value="table">Только таблица</option>
              </select>
            </Field>}
            {!isPrint && <Field label={allData ? "Формат отчётов" : "Формат"}>
              <select className="af-select" value={format} onChange={(e) => setFormat(e.target.value)}>
                <option value="xlsx">Excel (.xlsx)</option>
                <option value="csv">CSV (.csv)</option>
                <option value="html">HTML (.html)</option>
              </select>
            </Field>}
          </div>
          {allData && <p className="export-hint">В архиве также будут HTML-отчёты и требования в Excel и JSON.</p>}
          {!allData && !isPrint && format === "csv" && content === "report" && (
            <p className="export-hint">CSV содержит оценки по профилям и обоснования. Для матрицы выберите «Только таблица».</p>
          )}
          {!candidateReport && !allData && <label className="af-check export-check export-attachment">
            <input className="af-checkbox" type="checkbox" checked={individual}
              onChange={(e) => setIndividual(e.target.checked)} />
            <span>{isPrint ? "Добавить отдельный отчёт каждого кандидата" : "Приложить отдельные отчёты кандидатов (ZIP)"}
              <small>{isPrint ? "Каждый отчёт начнётся с новой страницы." : "Сводный и отдельные отчёты будут упакованы в один архив."}</small>
            </span>
          </label>}
        </fieldset>

        {!canSubmit ? <div className="af-alert af-alert--info" role="status">
          {isPrint || candidateReport ? "Нет кандидатов для печати или экспорта."
            : "По текущим фильтрам кандидатов нет. Выберите «Вся база» или измените фильтры таблицы."}
        </div> : <div className="export-summary" role="status" aria-live="polite" aria-atomic="true">
          <div className="export-summary-title">
            {isPrint ? <Printer size={20} aria-hidden="true" /> : isArchive ? <FileArchive size={20} aria-hidden="true" /> : <FileText size={20} aria-hidden="true" />}
            <strong>{isPrint ? "Документ для печати" : isArchive ? "ZIP-архив" : `Файл ${formatName}`}</strong>
            <span>Кандидатов: {candidateCount}</span>
          </div>
          <p>{allData ? `Резюме, полные отчёты по ФИО, сводная таблица с рейтингами и требования. Профилей: ${profileCount}.`
            : content === "report" ? "Оценки по профилям и обоснования соответствия требованиям." : "Таблица с рейтингами без обоснований."}</p>
          {isPrint && <p className="export-hint">В окне печати можно выбрать принтер или сохранить PDF.</p>}
        </div>}
        {busy && <p className="export-hint" role="status">{isArchive ? "Собираем архив. При большом количестве резюме это может занять несколько минут." : "Готовим документ. Дождитесь завершения."}</p>}
        {error && <div ref={errorRef}><ErrorMessage message={error} /></div>}
      </form>
    </Modal>
  );
}
