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
        {label}
      </span>
      {control}
      {hint && <small id={`${id}-hint`}>{hint}</small>}
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
    <div className="empty">
      <div className="empty-icon">
        <Inbox size={25} />
      </div>
      <h3>{title}</h3>
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
}: {
  title: string;
  children: ReactNode;
  onClose: () => void;
  wide?: boolean;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const dialog = ref.current!;
    dialog.showModal();
    return () => dialog.close();
  }, []);
  return (
    <dialog
      ref={ref}
      className={`app-dialog ${wide ? "wide" : ""}`}
      onCancel={onClose}
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="dialog-header">
        <h2>{title}</h2>
        <button className="icon-button" onClick={onClose} aria-label="Закрыть">
          <X size={20} />
        </button>
      </div>
      <div className="dialog-body">{children}</div>
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
export function CandidateStatus({ candidate }: { candidate: Candidate }) {
  return (
    <span
      className={`badge ${candidate.scoring_status === "failed" ? "danger" : candidate.scoring_status === "completed" ? (candidate.status === "in_process" ? "blue" : "success") : "neutral"}`}
    >
      {candidate.scoring_status === "processing" && (
        <LoaderCircle size={12} className="spin" />
      )}
      {candidate.scoring_status === "completed"
        ? statusLabels[candidate.status]
        : scoringLabels[candidate.scoring_status]}
    </span>
  );
}
export function Person({ candidate }: { candidate: Candidate }) {
  return (
    <div className="person">
      <span className="avatar">
        {candidate.last_name[0]}
        {candidate.first_name[0]}
      </span>
      <div>
        <strong>{fullName(candidate)}</strong>
        <small>{candidate.phone}</small>
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
        <div className="eyebrow">{eyebrow}</div>
        <h1>{title}</h1>
        <p>{text}</p>
      </div>
      <div className="heading-actions">{actions}</div>
    </div>
  );
}
export function ErrorMessage({ message }: { message: string }) {
  return message ? (
    <div className="notice danger" role="alert">
      {message}
    </div>
  ) : null;
}
