import { useState } from "react";
import { AlertTriangle, LoaderCircle, RefreshCw } from "lucide-react";
import type { RequirementReassessmentResult } from "@hr/contracts";
import { useData } from "../lib/store";
import { mutate } from "../lib/api";
import { Button, ErrorMessage, Modal } from "./ui";

export function RequirementUpdatesNotice() {
  const { requirementUpdates: updates, refresh } = useData();
  const [open, setOpen] = useState(false);
  const [selected, setSelected] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [result, setResult] = useState<RequirementReassessmentResult>();
  const clusters = updates?.clusters || [];
  const selectedClusters = clusters.filter(cluster => selected.includes(cluster.cluster_id));
  const canStart = selectedClusters.some(cluster => cluster.ready_resume_count > 0);
  async function start() {
    setBusy(true);
    setError("");
    setResult(undefined);
    try {
      const response = await mutate<RequirementReassessmentResult>("/requirements/reassessment", {
        cluster_ids: selectedClusters.map(cluster => cluster.cluster_id),
      });
      setResult(response);
      await refresh();
    } catch (error) {
      setError((error as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return <>
    {!!updates?.resume_count && <div className="af-alert af-alert--warning notice requirement-updates-notice" role="status">
      <AlertTriangle size={20} aria-hidden="true" />
      <div>
        <strong>Есть неактуальные результаты анализа</strong>
        <p>Резюме в статусе «В работе», для которых требуется обновить оценки: {updates.resume_count}. Новые или изменённые требования затрагивают кластеров: {clusters.length}.</p>
        {updates.ready_resume_count === 0 && <p>Оценка уже в очереди или выполняется. Уведомление исчезнет после обновления результатов.</p>}
      </div>
      <Button secondary onClick={() => {
        setSelected(clusters.map(cluster => cluster.cluster_id));
        setResult(undefined);
        setError("");
        setOpen(true);
      }}>Обновить оценки</Button>
    </div>}
    {open && <Modal title="Обновить оценки по изменённым требованиям" onClose={() => !busy && setOpen(false)} closeDisabled={busy}>
      <p>Выберите кластеры для повторной оценки текущих резюме «В работе». Будут использованы только требования выбранных кластеров. Оценки остальных кластеров сохранятся.</p>
      <div className="requirement-updates-list">
        {clusters.map(cluster => <label className="af-check requirement-updates-cluster" key={cluster.cluster_id}>
          <input className="af-checkbox" type="checkbox" checked={selected.includes(cluster.cluster_id)} disabled={busy || cluster.ready_resume_count === 0}
            onChange={event => setSelected(current => event.target.checked ? [...current, cluster.cluster_id] : current.filter(id => id !== cluster.cluster_id))} />
          <span><strong>{cluster.cluster_name}</strong><small>Нуждаются в обновлении: {cluster.resume_count} · доступны для запуска: {cluster.ready_resume_count}</small></span>
        </label>)}
        {!clusters.length && <p>Все результаты соответствуют текущим требованиям.</p>}
      </div>
      {result && <div className="af-alert af-alert--info notice" role="status">
        <div>
          <p>Поставлено в очередь резюме: {result.queued_resumes}.</p>
          {!!result.skipped_resumes && <p>Пропущено: {result.skipped_resumes}. Оценка уже выполняется, результаты обновлены или статус отбора изменился.</p>}
          {!!result.errors.length && <p>Не удалось запустить: {result.errors.length}. {result.errors[0].message} Повторите запуск для оставшихся резюме.</p>}
        </div>
      </div>}
      <ErrorMessage message={error} />
      <div className="dialog-footer">
        <Button secondary disabled={busy} onClick={() => setOpen(false)}>Закрыть</Button>
        <Button disabled={busy || !canStart} onClick={() => void start()}>
          {busy ? <LoaderCircle size={16} className="spin" /> : <RefreshCw size={16} />}
          {busy ? "Отправляем…" : "Запустить оценку"}
        </Button>
      </div>
    </Modal>}
  </>;
}
