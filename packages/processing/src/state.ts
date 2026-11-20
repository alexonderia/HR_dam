import { randomUUID, createHash } from "node:crypto";
import { AccessError } from "@hr/security";
import type { ProcessingMode, ProcessingTarget } from "@hr/contracts";
import type { Task, TaskStore, Publication, StoredFile, Job } from "./types.js";

export const stableId = (value: string) => {
  const h = createHash("sha256").update(value).digest("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`;
};
export const terminal = (task: Task) => ["completed", "partially_completed", "failed"].includes(task.status);
function boundedLifetime(name: string, fallback: number, ceiling: number) {
  const value = Number(process.env[name] || fallback);
  if (!Number.isSafeInteger(value) || value < 1000 || value > ceiling) throw new Error(`Invalid ${name}`);
  return value;
}
export const guestAbsoluteTtlMs = boundedLifetime("GUEST_ABSOLUTE_TTL_MS", 86400000, 86400000);
export const guestResultTtlMs = boundedLifetime("GUEST_RESULT_TTL_MS", 7200000, 7200000);
export const queueTimeoutMs = boundedLifetime("PROCESSING_QUEUE_TIMEOUT_MS", 86400000, 86400000);
export function processingTimeoutMs() { return boundedLifetime("PROCESSING_TIMEOUT_MS", 1800000, 86400000); }
export function activeWorkMs(job: Job, now = Date.now()): number {
  if (job.work_elapsed_ms != null) return job.work_elapsed_ms + (job.work_segment_started_at ? Math.max(0, now - Date.parse(job.work_segment_started_at)) : 0);
  return job.started_at ? Math.max(0, (job.result ? Date.parse(job.activity_at || job.started_at) : now) - Date.parse(job.started_at)) : 0;
}
export function pauseWork(job: Job, now = Date.now()) {
  job.work_elapsed_ms = activeWorkMs(job, now);
  delete job.work_segment_started_at;
  delete job.work_deadline;
  job.retry_waiting_since = job.activity_at = new Date(now).toISOString();
}
export function beginWork(job: Job, runId: string, now = Date.now()) {
  if (job.work_run_id === runId && job.work_segment_started_at) return;
  // Preserve time already charged by the previous protocol when upgrading a live job.
  job.work_elapsed_ms = job.work_elapsed_ms != null ? activeWorkMs(job, now) : job.work_deadline ? activeWorkMs(job, now) : 0;
  job.work_budget_ms ||= processingTimeoutMs();
  const remaining = job.work_budget_ms - job.work_elapsed_ms;
  if (remaining <= 0) throw new AccessError(409, "Время выполнения обработки истекло.");
  job.work_run_id = runId;
  job.work_segment_started_at = new Date(now).toISOString();
  job.work_deadline = new Date(Math.min(now + remaining, Date.parse(job.deadline))).toISOString();
  delete job.retry_waiting_since;
}
export function taskQueueDeadline(task: Task, now = Date.now()) {
  return new Date(Math.min(now + queueTimeoutMs, task.mode === "guest" ? Date.parse(task.created_at) + guestAbsoluteTtlMs : Infinity)).toISOString();
}
export function newTask(mode: ProcessingMode, owner: string, name: string, requirements: ProcessingTarget[], now = Date.now()): Task {
  return { id: randomUUID(), timing_version: 2, mode, owner, name, requirements, created_at: new Date(now).toISOString(),
    expires_at: new Date(now + guestAbsoluteTtlMs).toISOString(), deadline: new Date(Math.min(now + queueTimeoutMs, mode === "guest" ? now + guestAbsoluteTtlMs : Infinity)).toISOString(),
    upload_deadline: new Date(now + Number(process.env.UPLOAD_TIMEOUT_MS || 600000)).toISOString(), status: "uploading",
    source_ids: [], files: [], jobs: [], accepted_event_id: randomUUID() };
}
export function live(task: Task, now = Date.now()) {
  if (task.deleted_at || (task.mode === "guest" && now >= Date.parse(task.expires_at))) throw new AccessError(410, "Срок доступа к данным завершён.");
}
export function finish(task: Task, at: number) {
  if (task.finished_at) return;
  const successful = task.jobs.filter(j => j.operation === "evaluate" && j.applied && !j.projection_error && j.result?.status === "completed").length;
  const errors = task.jobs.some(j => j.projection_error || j.result?.status === "failed" || (j.result?.status === "completed" && "errors" in j.result && j.result.errors.length));
  task.status = successful ? errors ? "partially_completed" : "completed" : "failed";
  task.finished_at = new Date(at).toISOString();
  if (task.mode === "guest") task.expires_at = new Date(Math.min(at + guestResultTtlMs, Date.parse(task.created_at) + guestAbsoluteTtlMs)).toISOString();
}
export function expireWork(task: Task, now = Date.now()) {
  if (task.deleted_at) return;
  const workDeadline = Math.min(Date.parse(task.deadline),
    task.mode === "guest" ? Date.parse(task.created_at) + guestAbsoluteTtlMs : Infinity);
  const uploadDeadline = Math.min(workDeadline, Date.parse(task.upload_deadline));
  // Older versions marked expired uploads failed but kept their blobs for the report TTL.
  if (task.mode === "guest" && task.status === "failed" && !task.jobs.length &&
      now >= uploadDeadline && Date.parse(task.finished_at || "") === uploadDeadline) {
    closeGuestUpload(task, uploadDeadline);
    return;
  }
  if (terminal(task)) return;
  if (task.timing_version === 2 && task.status !== "uploading" && now < workDeadline) {
    for (const job of task.jobs) if (!job.applied && (!job.result || now >= Date.parse(job.deadline)) && now >= Math.min(Date.parse(job.deadline), Date.parse(job.work_deadline || job.deadline))) {
      if (job.work_elapsed_ms != null) { job.work_elapsed_ms = activeWorkMs(job, now); delete job.work_segment_started_at; }
      job.result = { status: "failed", error: { code: "PROCESSING_TIMEOUT", message: "Время выполнения обработки истекло." } };
      job.applied = true;
    }
    if (task.jobs.length && task.jobs.every(job => job.applied)) finish(task, now);
    return;
  }
  const deadline = task.status === "uploading" ? uploadDeadline : workDeadline;
  if (now < deadline) return;
  if (task.mode === "guest" && task.status === "uploading") {
    abortGuestUpload(task, deadline);
    return;
  }
  if (!task.jobs.length && task.status !== "uploading") for (const file of task.files.filter(f => task.source_ids.includes(f.file_id)))
    assignJob(task, file, !file.target_resume_id && ["application/pdf", "application/zip"].includes(file.mime_type) ? "prepare" : "evaluate");
  for (const job of task.jobs) if (!job.applied) {
    // A valid saved result survives a lost publication confirm.
    if (!job.result || job.result.status !== "completed") job.result = { status: "failed", error: { code: "PROCESSING_TIMEOUT", message: "Время обработки истекло." } };
    if (!job.applied && job.result.status === "completed") job.result = { status: "failed", error: { code: "PROCESSING_TIMEOUT", message: "Результат не был принят до завершения обработки." } };
    job.applied = true;
  }
  finish(task, deadline);
}

export function abortGuestUpload(task: Task, at = Date.now()) {
  if (task.mode !== "guest" || task.status !== "uploading" || task.deleted_at) return;
  finish(task, at);
  closeGuestUpload(task, at);
}

function closeGuestUpload(task: Task, at: number) {
  task.deleted_at = task.expires_at = new Date(at).toISOString();
}
export function assignJob(task: Task, file: StoredFile, operation: "prepare" | "evaluate") {
  const id = stableId(`${task.id}:${operation}:${file.file_id}`);
  let job = task.jobs.find(j => j.job_id === id);
  if (!job) {
    job = { job_id: id, task_id: task.id, file_id: file.file_id, operation,
      mode: task.mode, attempt: 1, deadline: task.deadline, created_at: task.created_at };
    task.jobs.push(job);
  }
  return job;
}
export function command(job: Job): Publication {
  const { job_id, task_id, file_id, operation, mode, attempt, deadline } = job;
  return { kind: "command", body: { job_id, task_id, file_id, operation, mode, attempt, deadline } };
}
export async function mutateTask(store: TaskStore, id: string, change: (task: Task) => Publication[] | void) {
  for (let attempt = 0; attempt < 30; attempt++) {
    const record = await store.read(id);
    if (!record) throw new AccessError(404, "Задача не найдена.");
    const messages = change(record.task) || [];
    if (await store.replace(record.task, record.version, messages)) return { task: record.task, messages };
  }
  throw new AccessError(503, "Конкурентное обновление. Повторите запрос.");
}
