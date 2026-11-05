import { useId, useState } from "react";
import { Info, ShieldAlert } from "lucide-react";
import { fullName, canChangeStatus, inProcessRestriction, statusLabels, type Candidate } from "@hr/contracts";
import { useData } from "../lib/store";
import { mutate } from "../lib/api";
import { Button, ErrorMessage, Field, Modal } from "./ui";

export function BlacklistAction({ candidate }: { candidate: Candidate }) {
  const { refresh } = useData();
  const [open, setOpen] = useState(false),
    [company, setCompany] = useState(""),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  return (
    <>
      <Button
        disabled={candidate.blacklisted || !candidate.phone || !candidate.last_name || !candidate.first_name}
        title={!candidate.phone || !candidate.last_name || !candidate.first_name ? "Для чёрного списка нужны ФИО и телефон. Добавьте известные данные в разделе «Чёрный список»." : undefined}
        onClick={() => setOpen(true)}
      >
        <ShieldAlert size={16} />
        {candidate.blacklisted ? "В чёрном списке" : "В чёрный список"}
      </Button>
      {open && (
        <Modal
          title="Добавить в чёрный список"
          onClose={() => !busy && setOpen(false)}
        >
          <p>
            {fullName(candidate)} · {candidate.phone}
          </p>
          <form
            onSubmit={async (e) => {
              e.preventDefault();
              setBusy(true);
              setError("");
              try {
                await mutate("/blacklist", {
                  phone: candidate.phone,
                  last_name: candidate.last_name,
                  first_name: candidate.first_name,
                  middle_name: candidate.middle_name ?? "",
                  company_name: company,
                  is_active: true,
                });
                await refresh();
                setOpen(false);
              } catch (e) {
                setError((e as Error).message);
              } finally {
                setBusy(false);
              }
            }}
          >
            <Field label="Компания *">
              <input
                className="af-input"
                required
                minLength={2}
                maxLength={255}
                value={company}
                onChange={(e) => setCompany(e.target.value)}
              />
            </Field>
            <ErrorMessage message={error} />
            <div className="dialog-footer">
              <Button secondary disabled={busy} onClick={() => setOpen(false)}>
                Отмена
              </Button>
              <Button type="submit" disabled={busy}>
                Добавить в чёрный список
              </Button>
            </div>
          </form>
        </Modal>
      )}
    </>
  );
}

export function CandidateWorkflow({ candidate }: { candidate: Candidate }) {
  const { refresh } = useData();
  const statusId = useId();
  const restriction = inProcessRestriction(candidate);
  const [busy, setBusy] = useState(false),
    [archive, setArchive] = useState(false),
    [pendingStatus, setPendingStatus] = useState<Candidate["status"]>(),
    [outcome, setOutcome] = useState("employed"),
    [error, setError] = useState("");
  async function change(status: Candidate["status"]) {
    setBusy(true);
    setError("");
    try {
      await mutate(
        `/resumes/${candidate.resume_id}/status`,
        { status, ...(status === "historical" ? { outcome } : {}) },
        "PATCH",
      );
      await refresh();
      setArchive(false);
      setPendingStatus(undefined);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="workflow-control">
      <div className="af-field field">
        <div className="workflow-label">
          <label className="af-label" htmlFor={statusId}>Статус кандидата</label>
          <details className="status-info">
            <summary aria-label="Информация о статусах"><Info size={16} /></summary>
            <div className="status-info-content">В работе — проверен и распределён; в процессе — собеседование или трудоустройство; архив — процесс завершён.</div>
          </details>
        </div>
        <select
          id={statusId}
          className="af-select"
          value={candidate.status}
          aria-describedby={restriction ? `${statusId}-restriction` : undefined}
          disabled={
            busy ||
            candidate.scoring_status !== "completed" ||
            candidate.status === "historical"
          }
          onChange={(e) =>
            e.target.value === "historical"
              ? setArchive(true)
              : (setError(""), setPendingStatus(e.target.value as Candidate["status"]))
          }
        >
          <option
            value="in_work"
            disabled={
              candidate.status !== "in_work" &&
              !canChangeStatus(candidate, "in_work")
            }
          >
            В работе
          </option>
          <option
            value="in_process"
            disabled={
              candidate.status !== "in_process" &&
              !canChangeStatus(candidate, "in_process")
            }
          >
            В процессе
          </option>
          <option
            value="historical"
            disabled={
              candidate.status !== "historical" &&
              !canChangeStatus(candidate, "historical")
            }
          >
            Архив
          </option>
        </select>
      </div>
      {restriction && <p className="muted workflow-restriction" id={`${statusId}-restriction`}>{restriction}</p>}
      {candidate.scoring_status !== "completed" && (
        <p className="muted">Статус можно изменить после завершения оценки.</p>
      )}
      {!archive && !pendingStatus && <ErrorMessage message={error} />}
      {pendingStatus && (
        <Modal title="Изменить статус кандидата" onClose={() => !busy && setPendingStatus(undefined)}>
          <p>{fullName(candidate)}</p>
          <p>Изменить статус с «{statusLabels[candidate.status]}» на «{statusLabels[pendingStatus]}»?</p>
          <ErrorMessage message={error || (pendingStatus === "in_process" ? restriction : null) || ""} />
          <div className="dialog-footer">
            <Button secondary disabled={busy} onClick={() => setPendingStatus(undefined)}>Отмена</Button>
            <Button disabled={busy || !canChangeStatus(candidate, pendingStatus)} onClick={() => void change(pendingStatus)}>Подтвердить</Button>
          </div>
        </Modal>
      )}
      {archive && (
        <Modal
          title="Завершить процесс и заархивировать"
          onClose={() => !busy && setArchive(false)}
        >
          <p>{fullName(candidate)}</p>
          <Field label="Итог отбора">
            <select
              className="af-select"
              value={outcome}
              onChange={(e) => setOutcome(e.target.value)}
            >
              <option value="employed">Кандидат трудоустроен</option>
              <option value="rejected_all">Отклонён всеми кластерами</option>
            </select>
          </Field>
          <ErrorMessage message={error} />
          <div className="dialog-footer">
            <Button secondary disabled={busy} onClick={() => setArchive(false)}>
              Отмена
            </Button>
            <Button disabled={busy} onClick={() => void change("historical")}>
              Заархивировать
            </Button>
          </div>
        </Modal>
      )}
    </div>
  );
}
