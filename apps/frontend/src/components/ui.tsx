import {
  cloneElement,
  isValidElement,
  useEffect,
  useId,
  useRef,
  type ReactElement,
  type ReactNode,
} from "react";
import { X, Inbox, LoaderCircle } from "lucide-react";
import {
  fullName,
  scoringLabels,
  statusLabels,
  type Candidate,
} from "@hr/contracts";

declare global {
  interface Window {
    Alabuga?: {
      VERSION: string;
      initComponents: (root: HTMLElement) => () => void;
    };
  }
}
export function Framework({ children }: { children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const cleanup = window.Alabuga?.initComponents(ref.current!);
    return () => cleanup?.();
  }, []);
  return (
    <div className="af app" ref={ref}>
      {children}
    </div>
  );
}
export function Button({
  children,
  secondary = false,
  ...props
}: React.ButtonHTMLAttributes<HTMLButtonElement> & { secondary?: boolean }) {
  return (
    <button
      type="button"
      {...props}
      className={`af-btn ${secondary ? "af-btn--secondary" : ""} ${props.className || ""}`}
    >
      {children}
    </button>
  );
}
export function Field({
  label,
  children,
  hint,
}: {
  label: string;
  children: ReactNode;
  hint?: string;
}) {
  const id = useId();
  const control = isValidElement(children)
    ? cloneElement(children as ReactElement<Record<string, unknown>>, {
        id,
        "aria-labelledby": `${id}-label`,
        "aria-describedby": hint ? `${id}-hint` : undefined,
      })
    : children;
  return (
    <label className="af-field field" htmlFor={id}>
      <span className="af-label" id={`${id}-label`}>
        {label.endsWith(" *") ? (
          <>{label.slice(0, -2)} <span className="af-required">*</span></>
        ) : label}
      </span>
      {control}
      {hint && <small className="af-help" id={`${id}-hint`}>{hint}</small>}
    </label>
  );
}
export function Empty({
  title,
  text,
  action,
}: {
  title: string;
  text: string;
  action?: ReactNode;
}) {
  return (
    <div className="af-empty empty">
      <div className="empty-icon">
        <Inbox size={25} />
      </div>
      <h3 className="af-title">{title}</h3>
      <p>{text}</p>
      {action}
    </div>
  );
}
export function Modal({
  title,
  children,
  onClose,
  wide = false,
  className = "",
  footer,
  closeDisabled = false,
}: {
  title: string;
  children: ReactNode;
  onClose: () => void;
  wide?: boolean;
  className?: string;
  footer?: ReactNode;
  closeDisabled?: boolean;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  useEffect(() => {
    const dialog = ref.current!;
    const opener = document.activeElement;
    dialog.showModal();
    return () => {
      dialog.close();
      if (opener instanceof HTMLElement && opener.isConnected) opener.focus();
    };
  }, []);
  return (
    <dialog
      ref={ref}
      className={`af-dialog app-dialog ${wide ? "wide" : ""} ${className}`}
      aria-labelledby={titleId}
      onCancel={(e) => {
        e.preventDefault();
        if (!closeDisabled) onClose();
      }}
      onClick={(e) => {
        if (e.target === e.currentTarget && !closeDisabled) onClose();
      }}
    >
      <div className="dialog-header">
        <h2 className="af-title" id={titleId}>{title}</h2>
        <button type="button" className="af-btn af-btn--clear icon-button" onClick={onClose} disabled={closeDisabled} aria-label="Закрыть">
          <X size={20} />
        </button>
      </div>
      <div className="dialog-body">{children}</div>
      {footer}
    </dialog>
  );
}
export function Score({ value }: { value?: number }) {
  if (value === undefined)
    return (
      <span className="no-score" aria-label="Оценка отсутствует">
        —
      </span>
    );
  return (
    <span
      className={`score ${value >= 75 ? "high" : value >= 45 ? "medium" : "low"}`}
    >
      <span>
        {Number(value).toLocaleString("ru-RU", { maximumFractionDigits: 1 })}
      </span>
      <i style={{ width: `${value}%` }} />
    </span>
  );
}
export function CandidateStatus({ candidate, showScoring = false }: { candidate: Candidate; showScoring?: boolean }) {
  const showWorkflow = !showScoring && candidate.scoring_status === "completed";
  return (
    <span
      className={`af-badge badge ${candidate.scoring_status === "failed" ? "badge--danger" : candidate.scoring_status === "completed" ? (showWorkflow && candidate.status === "in_process" ? "" : "af-badge--success") : "badge--neutral"}`}
      title={showScoring ? "Состояние обработки резюме" : showWorkflow ? "Статус отбора" : undefined}
    >
      {candidate.scoring_status === "processing" && (
        <LoaderCircle size={12} className="spin" />
      )}
      {showWorkflow
        ? statusLabels[candidate.status]
        : scoringLabels[candidate.scoring_status]}
    </span>
  );
}
export function Person({ candidate }: { candidate: Candidate }) {
  return (
    <div className="person">
      <span className="avatar">
        {candidate.last_name?.[0] || "?"}
        {candidate.first_name?.[0] || ""}
      </span>
      <div>
        <strong>{fullName(candidate) || "ФИО не указано"}</strong>
        <small>{candidate.phone || "Телефон не указан"}</small>
      </div>
    </div>
  );
}
export function PageHeading({
  eyebrow = "Центр подбора",
  title,
  text,
  actions,
}: {
  eyebrow?: string;
  title: string;
  text: string;
  actions?: ReactNode;
}) {
  return (
    <div className="page-heading">
      <div>
        <div className="af-eyebrow eyebrow">{eyebrow}</div>
        <h1 className="af-heading">{title}</h1>
        <p>{text}</p>
      </div>
      <div className="heading-actions">{actions}</div>
    </div>
  );
}
export function ErrorMessage({ message }: { message: string }) {
  return message ? (
    <div className="af-alert af-alert--danger notice" role="alert">
      {message}
    </div>
  ) : null;
}
