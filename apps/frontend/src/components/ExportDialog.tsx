import { useState } from "react";
import type { Candidate, Cluster } from "@hr/contracts";
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
  const [content, setContent] = useState("report"),
    [format, setFormat] = useState(mode === "print" ? "html" : "xlsx"),
    [individual, setIndividual] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  async function run() {
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
          candidate_ids: candidates.map((c) => c.id),
          cluster_ids: clusters.map((c) => c.id),
          expanded,
          content,
          format,
          individual,
          print: mode === "print",
          candidateReport,
        }),
      });
      if (!response.ok)
        throw new Error(
          (await response.json()).error || "Не удалось сформировать экспорт.",
        );
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
        link.download = `candidate-${candidateReport ? "report" : "distribution"}.${individual ? "zip" : format}`;
        link.click();
        setTimeout(() => URL.revokeObjectURL(url), 60000);
      }
      onClose();
    } catch (e) {
      printWindow?.close();
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <Modal
      title={mode === "print" ? "Настройки печати" : "Настройки экспорта"}
      onClose={() => !busy && onClose()}
    >
      <p>
        {candidateReport
          ? "Отчёт кандидата"
          : `Кандидатов: ${candidates.length}. Сохраняются фильтры, сортировка и раскрытие кластеров. Выгружаются все найденные кандидаты.`}
      </p>
      <Field label="Содержание">
        <select
          className="af-select"
          value={content}
          onChange={(e) => setContent(e.target.value)}
        >
          <option value="report">Полный отчёт с обоснованиями</option>
          <option value="table">Только таблица</option>
        </select>
      </Field>
      {mode === "export" && (
        <Field label="Формат">
          <select
            className="af-select"
            value={format}
            onChange={(e) => setFormat(e.target.value)}
          >
            <option value="xlsx">Excel (.xlsx)</option>
            <option value="csv">CSV (.csv)</option>
            <option value="html">HTML (.html)</option>
          </select>
        </Field>
      )}
      {mode === "export" && format === "csv" && content === "report" && (
        <p className="muted">
          CSV содержит оценки по профилям и обоснования. Для матрицы в текущем
          виде выберите «Только таблица».
        </p>
      )}
      {mode === "print" && (
        <p className="muted">
          В окне печати можно выбрать принтер или сохранить PDF.
        </p>
      )}
      {!candidateReport && (
        <label className="af-check checkbox">
          <input
            className="af-checkbox"
            type="checkbox"
            checked={individual}
            onChange={(e) => setIndividual(e.target.checked)}
          />
          {mode === "print"
            ? "Добавить отдельный отчёт каждого кандидата"
            : "Приложить отдельные отчёты кандидатов (ZIP)"}
        </label>
      )}
      <ErrorMessage message={error} />
      <div className="dialog-footer">
        <Button secondary disabled={busy} onClick={onClose}>
          Отмена
        </Button>
        <Button
          disabled={busy || !candidates.length}
          onClick={() => void run()}
        >
          {busy
            ? "Подготовка…"
            : mode === "print"
              ? "Перейти к печати"
              : "Скачать"}
        </Button>
      </div>
    </Modal>
  );
}
