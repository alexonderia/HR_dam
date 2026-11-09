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
export function newTask(mode: ProcessingMode, owner: string, name: string, requirements: ProcessingTarget[], now = Date.now()): Task {
  return { id: randomUUID(), mode, owner, name, requirements, created_at: new Date(now).toISOString(),
    expires_at: new Date(now + guestAbsoluteTtlMs).toISOString(), deadline: new Date(Math.min(now + Number(process.env.PROCESSING_TIMEOUT_MS || 1800000), mode === "guest" ? now + guestAbsoluteTtlMs : Infinity)).toISOString(),
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
  if (terminal(task) || task.deleted_at) return;
  const deadline = Math.min(Date.parse(task.deadline), task.mode === "guest" ? Date.parse(task.created_at) + guestAbsoluteTtlMs : Infinity,
    task.status === "uploading" ? Date.parse(task.upload_deadline) : Infinity);
  if (now < deadline) return;
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
