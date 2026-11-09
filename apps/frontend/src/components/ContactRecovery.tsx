import { useState } from "react";
import { ContactRound } from "lucide-react";
import { contactFields, type Candidate, type ContactField, type ContactRecoveryPreview } from "@hr/contracts";
import { mutate } from "../lib/api";
import { useData } from "../lib/store";
import { Button, ErrorMessage, Modal } from "./ui";

const labels: Record<ContactField, string> = { last_name: "Фамилия", first_name: "Имя", middle_name: "Отчество", phone: "Телефон" };
export function ContactSources({ candidate }: { candidate: Candidate }) {
  return <details>
    <summary>Источники контактов</summary>
    <dl>{contactFields.map(field => {
      const provenance = candidate.contact_provenance?.[field];
      return <div key={field}>
        <dt>{labels[field]}: {candidate[field] || "Не указано"}</dt>
        <dd>{provenance?.source === "manual" ? "Введено вручную"
          : provenance?.source === "resume_text" && provenance.value === candidate[field] && provenance.evidence
            ? <>Из текста резюме. Уверенность: {provenance.evidence.confidence === "high" ? "высокая" : "средняя"}.
              <blockquote>{provenance.evidence.quote}</blockquote>
              Строки {provenance.evidence.line_start}–{provenance.evidence.line_end}.</>
            : candidate[field] ? "Старая запись, источник не указан" : "Нет сведений в сохранённых контактах"}</dd>
      </div>;
    })}</dl>
  </details>;
}
export function ContactRecovery({ resumeId }: { resumeId: string }) {
  const { refresh } = useData();
  const [open, setOpen] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState("");
  const [preview, setPreview] = useState<ContactRecoveryPreview>();
  async function inspect() {
    setOpen(true); setBusy(true); setError(""); setPreview(undefined);
    try { setPreview(await mutate<ContactRecoveryPreview>(`/resumes/${resumeId}/contacts/preview`, {})); }
    catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  }
  async function apply() {
    if (!preview) return;
    setBusy(true); setError("");
    try {
      await mutate(`/resumes/${resumeId}/contacts/recover`, { revision: preview.revision });
      await refresh(); setOpen(false); setPreview(undefined);
    } catch (e) { setError((e as Error).message); setPreview(undefined); }
    finally { setBusy(false); }
  }
  return <>
    <Button secondary disabled={busy} onClick={inspect}><ContactRound size={16} />Восстановить контакты</Button>
    {open && <Modal title="Восстановление контактов" onClose={() => { if (!busy) setOpen(false); }} closeDisabled={busy} wide>
      <p>ФИО и телефон извлекаются из текущего резюме. Оценки сохраняются.</p>
      <p className="muted">Ручные значения и заполненные старые поля с неизвестным источником защищены от замены.</p>
      {busy && <p role="status">Обработка контактов…</p>}
      <ErrorMessage message={error} />
      {preview && <>
        {preview.contact_details.warnings.map(warning => <p key={warning} role="status">{warning}</p>)}
        {preview.protected_fields.length > 0 && <p className="muted">Защищены: {preview.protected_fields.map(f => labels[f].toLowerCase()).join(", ")}.</p>}
        {preview.changes.length ? <div className="table-scroll"><table>
          <thead><tr><th>Поле</th><th>Сейчас</th><th>Из резюме</th><th>Источник</th></tr></thead>
          <tbody>{preview.changes.map(change => <tr key={change.field}>
            <td>{labels[change.field]}</td><td>{change.previous || "Нет сведений"}</td><td>{change.value}</td>
            <td><blockquote>{change.evidence.quote}</blockquote><small>Строки {change.evidence.line_start}–{change.evidence.line_end}. Высокая уверенность.</small></td>
          </tr>)}</tbody>
        </table></div> : <p>Нет изменений, которые можно применить автоматически.</p>}
      </>}
      <div className="toolbar">
        <Button secondary disabled={busy} onClick={inspect}>Обновить просмотр</Button>
        <Button disabled={busy || !preview?.changes.length} onClick={apply}>Применить изменения</Button>
      </div>
    </Modal>}
  </>;
}
