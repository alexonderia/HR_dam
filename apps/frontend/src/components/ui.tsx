import {
  cloneElement,
  isValidElement,
  useEffect,
  useId,
  useRef,
  useState,
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
export function Framework({ children, className = "app" }: { children: ReactNode; className?: string }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const cleanup = window.Alabuga?.initComponents(ref.current!);
    return () => cleanup?.();
  }, []);
  return (
    <div className={`af ${className}`} ref={ref}>
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
export function InfoHint({ id, label, children }: { id: string; label: string; children: ReactNode }) {
  const trigger = useRef<HTMLButtonElement>(null), popup = useRef<HTMLSpanElement>(null);
  const pinned = useRef(false), timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const [open, setOpen] = useState(false);
  const cancelHide = () => clearTimeout(timer.current);
  const hide = () => {
    cancelHide();
    if (popup.current?.matches(":popover-open")) popup.current.hidePopover();
  };
  const show = () => {
    cancelHide();
    const tip = popup.current, button = trigger.current;
    if (!tip || !button) return;
    if (!tip.matches(":popover-open")) tip.showPopover();
    const anchor = button.getBoundingClientRect(), box = tip.getBoundingClientRect();
    tip.style.left = `${Math.max(16, Math.min(anchor.left, innerWidth - box.width - 16))}px`;
    tip.style.top = `${anchor.bottom + 8 + box.height <= innerHeight - 16 ? anchor.bottom + 8 : Math.max(16, anchor.top - box.height - 8)}px`;
  };
  const leave = () => {
    cancelHide();
    if (!pinned.current && document.activeElement !== trigger.current) timer.current = setTimeout(hide, 150);
  };
  useEffect(() => () => clearTimeout(timer.current), []);
  useEffect(() => {
    if (!open) return;
    const close = () => hide();
    window.addEventListener("resize", close);
    window.addEventListener("scroll", close, true);
    return () => { window.removeEventListener("resize", close); window.removeEventListener("scroll", close, true); };
  }, [open]);
  return <span className="field-info" onMouseEnter={show} onMouseLeave={leave}>
    <button ref={trigger} type="button" className="af-btn af-btn--clear af-btn--icon af-btn--sm af-btn--round"
      aria-label={`Подсказка: ${label}`} aria-describedby={id} aria-controls={id} aria-expanded={open}
      onFocus={show} onBlur={() => { if (!pinned.current) hide(); }}
      onClick={() => { if (pinned.current) { pinned.current = false; hide(); } else { pinned.current = true; show(); } }}>
      <span className="af-btn__icon af-btn__icon--info" aria-hidden="true" />
    </button>
    <span ref={popup} id={id} role="tooltip" popover="auto" className="af af-card af-card--inner af-body af-body--md field-tooltip"
      onMouseEnter={cancelHide} onMouseLeave={leave}
      onToggle={event => { const visible = event.currentTarget.matches(":popover-open"); setOpen(visible); if (!visible) pinned.current = false; }}>
      {children}
    </span>
  </span>;
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
      className={`af af-dialog app-dialog ${wide ? "wide" : ""} ${className}`}
      aria-labelledby={titleId}
      onCancel={(e) => {
        e.preventDefault();
        if (!closeDisabled) onClose();
      }}
      onClick={(e) => {
        if (e.target === e.currentTarget && !closeDisabled) onClose();
      }}
    >
      <div className="af-dialog__header dialog-header">
        <h2 className="af-title af-dialog__title" id={titleId}>{title}</h2>
        <button type="button" className="af-btn af-btn--clear af-btn--icon" onClick={onClose} disabled={closeDisabled} aria-label="Закрыть">
          <X className="af-btn__icon" size={20} aria-hidden="true" />
        </button>
      </div>
      <div className="dialog-body">{children}</div>
      {footer}
    </dialog>
  );
}
export function Score({ value, upperValue }: { value?: number; upperValue?: number }) {
  if (value === undefined)
    return (
      <span className="no-score" aria-label="Оценка отсутствует">
        —
      </span>
    );
  return (
    <span
      className={`score ${upperValue !== undefined && upperValue !== value ? "uncertain" : value >= 75 ? "high" : value >= 45 ? "medium" : "low"}`}
      title={upperValue !== undefined && upperValue !== value ? "Нижняя граница подтверждена резюме. Верхняя зависит от сведений, требующих уточнения." : undefined}
    >
      <span>
        {Number(value).toLocaleString("ru-RU", { maximumFractionDigits: 1 })}
        {upperValue !== undefined && upperValue !== value && `–${upperValue.toLocaleString("ru-RU", { maximumFractionDigits: 1 })}`}
      </span>
      <i style={{ width: `${value}%` }} />
    </span>
  );
}
export function CandidateStatus({ candidate }: { candidate: Candidate }) {
  const showWorkflow = candidate.scoring_status === "completed";
  return (
    <span
      className={`af-badge badge ${candidate.scoring_status === "failed" ? "badge--danger" : candidate.scoring_status === "completed" ? (showWorkflow && candidate.status === "in_process" ? "" : "af-badge--success") : "badge--neutral"}`}
      title={showWorkflow ? "Статус отбора" : "Состояние обработки резюме"}
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
