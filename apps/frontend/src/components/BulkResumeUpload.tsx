import { useRef, useState } from "react";
import { Link } from "react-router-dom";
import { UploadCloud, LoaderCircle } from "lucide-react";
import type { ResumeImportDetail } from "@hr/contracts";
import { api } from "../lib/api";
import { useData } from "../lib/store";
import { Button, ErrorMessage } from "./ui";

export function BulkResumeUpload() {
  const { refresh } = useData();
  const [file, setFile] = useState<File>(), [error, setError] = useState(""),
    [busy, setBusy] = useState(false), [result, setResult] = useState<ResumeImportDetail>();
  const input = useRef<HTMLInputElement>(null);
  const choose = (selected?: File) => {
    if (!selected || busy) return;
    setError(""); setFile(undefined);
    if (!/\.zip$/i.test(selected.name) || !selected.size || selected.size > 50 * 1024 * 1024) {
      setError("Выберите ZIP размером до 50 МБ."); return;
    }
    setFile(selected);
  };
  return <form onSubmit={async event => {
    event.preventDefault();
    if (!file) { setError("Прикрепите ZIP с резюме."); return; }
    setBusy(true); setError("");
    const form = new FormData(); form.append("archive", file);
    try {
      setResult(await api<ResumeImportDetail>("/resume-imports", { method: "POST", body: form }));
      setFile(undefined); await refresh();
    } catch (error) { setError((error as Error).message); }
    finally { setBusy(false); }
  }}>
    <div className="section-label"><span>ZIP</span><div>
      <h2 className="af-title">Массовая загрузка резюме</h2>
      <p>Данные кандидатов заполнятся после анализа каждого резюме.</p>
    </div></div>
    <p className="muted">До 200 резюме PDF, DOCX, DOC, RTF или TXT, в том числе в папках. ZIP — до 50 МБ, распакованные файлы — до 250 МБ, отдельное резюме — до 50 МБ. Архивы с паролем не поддерживаются.</p>
    <div className={`drop-zone ${file ? "selected" : ""}`} onDragOver={event => event.preventDefault()}
      onDrop={event => { event.preventDefault(); choose(event.dataTransfer.files[0]); }}>
      <UploadCloud size={32} />
      <strong>{file?.name || "Перетащите ZIP с резюме сюда"}</strong>
      <span>{file ? `${(file.size / 1024 / 1024).toFixed(1)} МБ` : "Указывать кандидатов вручную не требуется"}</span>
      <Button secondary disabled={busy} onClick={() => input.current?.click()}>{file ? "Заменить ZIP" : "Выбрать ZIP"}</Button>
      <input ref={input} className="sr-only" type="file" accept=".zip" aria-label="ZIP с резюме" disabled={busy}
        onChange={event => { choose(event.target.files?.[0]); event.target.value = ""; }} />
    </div>
    <p className="muted">Каждое резюме проходит проверку. Служебные и неподдерживаемые файлы пропускаются. Кандидаты появятся в базе по мере получения результатов анализа.</p>
    <ErrorMessage message={error} />
    {result && <div className="af-alert af-alert--success notice" role="status">
      <strong>Архив «{result.archive_name}» принят: {result.total_files} резюме.</strong>
      <p>Обработано: {result.processed_files}. В обработке: {result.pending_files}. Ошибок: {result.failed_files}.</p>
      {!!result.ignored_files.length && <p>Пропущено файлов: {result.ignored_files.length}.</p>}
      <Link className="af-link" to="/processing">Следить за массовой обработкой</Link>
    </div>}
    <div className="form-footer"><span>{busy ? "Проверяем файлы и отправляем в обработку…" : "ФИО и телефон могут отсутствовать в резюме"}</span>
      <Button type="submit" disabled={busy || !file}>{busy && <LoaderCircle size={16} className="spin" />}{busy ? "Загружаем…" : "Загрузить архив"}</Button>
    </div>
  </form>;
}
