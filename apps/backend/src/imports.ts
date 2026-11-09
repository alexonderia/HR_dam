import { randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { extractedPersonSchema, assessmentRetryRestriction, clusterRequirementsKey, type Cluster, type ResumeImportDetail } from "@hr/contracts";
import { getClusters, transaction } from "@hr/data-access";
import { newTask, mutateTask, expireWork, command, inspectUpload, type IncomingFile } from "@hr/processing";
import { authorizedProcessing } from "./processing-service.js";
import { HttpError } from "./errors.js";

export async function activeRequirements() {
  const clusters = (await getClusters()).filter(c => c.is_active)
    .map(c => ({ ...c, profiles: c.profiles.filter(p => p.is_active) })).filter(c => c.profiles.length);
  if (!clusters.length) throw new HttpError(409, "Добавьте активный кластер и профиль перед загрузкой резюме.");
  if (Buffer.byteLength(JSON.stringify(clusters)) > 512 * 1024) throw new HttpError(422, "Набор требований превышает допустимый размер задания.");
  return clusters;
}
function targets(clusters: Cluster[]) {
  return clusters.flatMap(c => c.profiles.map(p => ({ id: p.id, name: p.position_name, education: p.education || "",
    experience: p.experience || "", keywords: p.keywords || [], stop_factors: p.stop_factors || [], comment: [c.comment, p.comment].filter(Boolean).join("\n") })));
}
export async function acceptResumes(file: IncomingFile | undefined, archive: boolean, hint: unknown = {}) {
  if (!file) throw new HttpError(422, "Прикрепите файл резюме или ZIP.");
  const candidate = extractedPersonSchema.parse(hint), requirements = await activeRequirements();
  const { objects, store, engine } = authorizedProcessing();
  const task = newTask("authorized", "shared", file.originalname, targets(requirements)); task.clusters = requirements;
  await store.create(task);
  // ZIP expansion and PDF splitting belong exclusively to the prepare service.
  const description = await inspectUpload(file, true);
  if (archive && description.mime_type !== "application/zip") throw new HttpError(422, "Выберите ZIP-архив.");
  const fileId = randomUUID(), key = `tasks/${task.id}/files/${fileId}`;
  await objects.put(key, createReadStream(file.path), description.size_bytes, description.mime_type);
  await mutateTask(store, task.id, current => {
    current.files.push({ ...description, file_id: fileId, key, candidate_hint: candidate }); current.source_ids.push(fileId);
  });
  // Task and task.accepted intention commit together; the outbox survives broker outages.
  try { await engine.accept(task.id); } catch (error) {
    const saved = await store.read(task.id); if (saved?.task.status === "uploading") throw error;
  }
  return { ...await importDetail(task.id), queued: true };
}
export async function importDetail(id: string): Promise<ResumeImportDetail> {
  const runtime = authorizedProcessing();
  const { task } = await mutateTask(runtime.store, id, current => { expireWork(current); });
  for (const job of task.jobs) if (job.applied && job.result?.status === "failed" && task.files.some(f => f.file_id === job.file_id && f.target_resume_id))
    await runtime.engine.project?.(task, job);
  const files = task.jobs.length ? task.files.filter(file => {
    if (task.jobs.some(j => j.file_id === file.file_id && j.operation === "evaluate")) return true;
    const prepare = task.jobs.find(j => j.file_id === file.file_id && j.operation === "prepare");
    return prepare && (!prepare.applied || prepare.result?.status === "failed");
  }) : task.files;
  const items = files.map(file => {
    const job = task.jobs.find(j => j.file_id === file.file_id && j.operation === "evaluate") || task.jobs.find(j => j.file_id === file.file_id);
    return { id: file.file_id, source_path: file.metadata?.archive_path || file.file_name, file_name: file.file_name,
      status: job?.applied ? job.projection_error || job.result?.status === "failed" ? "failed" as const : "completed" as const : job?.started_at ? "processing" as const : task.status === "uploading" ? "uploading" as const : "pending" as const,
      attempt: job?.attempt || 1, error: job?.projection_error || (job?.result?.status === "failed" ? job.result.error.message : null),
      warning: job?.receipt?.warning || null, candidate_id: job?.receipt?.candidate_id || null, resume_id: job?.receipt?.resume_id || null,
      updated_at: job?.activity_at || task.finished_at || task.created_at, analysis_started_at: job?.started_at || null,
      analysis_duration_ms: job?.started_at && job.applied ? Math.max(0, Date.parse(task.finished_at || job.activity_at || task.created_at) - Date.parse(job.started_at)) : null,
      file_sha256: file.sha256, candidate_hint: file.candidate_hint, target_resume_id: file.target_resume_id };
  });
  return { id: task.id, archive_name: task.name, created_at: task.created_at, items,
    source_files: task.source_ids.length, candidate_files: task.jobs.filter(j => j.operation === "evaluate").length,
    total_files: items.length, processed_files: items.filter(i => i.status === "completed").length,
    failed_files: items.filter(i => i.status === "failed").length, pending_files: items.filter(i => ["uploading", "pending", "processing"].includes(i.status)).length,
    uploading_files: items.filter(i => i.status === "uploading").length, processing_files: items.filter(i => i.status === "processing").length, ignored_files: [] };
}
export async function listImportDetails() {
  const all: ResumeImportDetail[] = [];
  for await (const id of authorizedProcessing().store.list()) all.push(await importDetail(id));
  return all.sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at));
}
export async function listImports() { return (await listImportDetails()).map(({ items: _items, ...summary }) => summary); }
export async function retryImport(id: string, itemId: string) {
  const { store, engine } = authorizedProcessing();
  const changed = await mutateTask(store, id, task => {
    const job = task.jobs.find(j => j.file_id === itemId && j.operation === "evaluate") || task.jobs.find(j => j.file_id === itemId);
    if (!job || job.result?.status !== "failed" || job.attempt >= 100) throw new HttpError(409, "Повтор доступен после ошибки обработки.");
    if (task.files.find(f => f.file_id === itemId)?.target_resume_id) throw new HttpError(409, "Запустите повторную оценку из карточки кандидата.");
    job.job_id = randomUUID(); job.attempt++; job.created_at = new Date().toISOString();
    task.deadline = new Date(Date.now() + 1800000).toISOString(); job.deadline = task.deadline;
    delete job.result; delete job.result_id; delete job.event_id; delete job.confirmed; delete job.applied; delete job.started_at; delete job.receipt; delete job.projection_error;
    task.status = "queued"; delete task.finished_at; return [command(job)];
  });
  try { await engine.dispatch(changed.task, changed.messages); } catch { /* durable outbox */ }
  return importDetail(id);
}
export async function enqueueExistingResume(resumeId: string, options: { recoverPending?: boolean; clusterIds?: string[]; onlyOutdated?: boolean } = {}) {
  let requirements = await activeRequirements();
  if (options.clusterIds) requirements = requirements.filter(c => options.clusterIds!.includes(c.id));
  if (!requirements.length) throw new HttpError(409, "Нет активных требований.");
  const { store } = authorizedProcessing();
  const task = newTask("authorized", "shared", "Повторная оценка", []);
  await transaction(async client => {
    const result = await client.query(`SELECT r.*,c.phone,c.last_name,c.first_name,c.middle_name,f.bucket,f.object_key,
      f.file_name,f.mime_type,f.size_bytes,f.file_sha256 FROM resumes r JOIN candidates c ON c.id=r.candidate_id
      JOIN files f ON f.id=r.file_id WHERE r.id=$1 FOR UPDATE OF r`, [resumeId]);
    const row = result.rows[0]; if (!row) throw new HttpError(404, "Резюме не найдено.");
    const restriction = assessmentRetryRestriction(row); if (restriction) throw new HttpError(409, restriction);
    if (options.onlyOutdated) {
      const assessed = await client.query("SELECT cluster_id,requirements FROM resume_cluster_assessments WHERE resume_id=$1", [resumeId]);
      const keys = new Map(assessed.rows.map((saved: { cluster_id: string; requirements: Cluster }) => [saved.cluster_id, clusterRequirementsKey(saved.requirements)]));
      requirements = requirements.filter(c => keys.get(c.id) !== clusterRequirementsKey(c)); if (!requirements.length) return;
    }
    const update = await client.query("UPDATE resumes SET scoring_status='pending',updated_at=now() WHERE id=$1 RETURNING updated_at::text AS lease", [resumeId]);
    task.requirements = targets(requirements); task.clusters = requirements; task.name = row.file_name;
    task.files = [{ file_id: row.file_id, file_name: row.file_name, mime_type: row.mime_type, size_bytes: Number(row.size_bytes), sha256: row.file_sha256,
      key: row.object_key, candidate_hint: extractedPersonSchema.parse(row), target_resume_id: resumeId, target_updated_at: update.rows[0].lease,
      ...(options.clusterIds ? { assessment_cluster_ids: requirements.map(c => c.id) } : {}) }]; task.source_ids = [row.file_id]; task.status = "queued";
    await client.query("INSERT INTO processing_tasks(id,state) VALUES($1,$2)", [task.id, JSON.stringify(task)]);
    await store.outbox(client, task, [{ kind: "event", body: { event_id: task.accepted_event_id, event_type: "task.accepted", task_id: task.id, mode: "authorized", deadline: task.deadline } }]);
  });
  return task.requirements.length ? importDetail(task.id) : null;
}
// Reconciliation only republishes committed authorized intentions.
export { flushAuthorizedOutbox as reconcilePendingResumes } from "./processing-service.js";
