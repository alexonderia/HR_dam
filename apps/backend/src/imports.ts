import { randomUUID } from "node:crypto";
import { extractedPersonSchema, importManifestSchema, type ImportFile, type ImportManifest, type ResumeImportDetail, type StorageJob } from "@hr/contracts";
import { getClusters, enqueueImport, ensureProcessingTransport, brokerQueues, readImportLedger, latestItemEvent, pool, transaction } from "@hr/data-access";
import { extractResumeArchive, multipartFileName } from "./archive.js";
import { validateFile, scanFile, hashFile } from "./files.js";
import { config } from "./config.js";
import { HttpError } from "./errors.js";

export async function activeRequirements() {
  const clusters = (await getClusters()).filter(c => c.is_active)
    .map(c => ({ ...c, profiles: c.profiles.filter(p => p.is_active) })).filter(c => c.profiles.length);
  if (!clusters.length) throw new HttpError(409, "Добавьте активный кластер и профиль перед загрузкой резюме.");
  if (Buffer.byteLength(JSON.stringify(clusters)) > 512 * 1024) throw new HttpError(422, "Набор требований превышает допустимый размер задания.");
  return clusters;
}
export async function acceptResumes(file: Express.Multer.File | undefined, archive: boolean, hint: unknown = {}) {
  if (!file) throw new HttpError(422, archive ? "Прикрепите ZIP с резюме." : "Прикрепите резюме.");
  const candidate = extractedPersonSchema.parse(hint);
  const filename = multipartFileName(file.originalname);
  if (archive && !/\.zip$/i.test(filename)) throw new HttpError(422, "Выберите ZIP-архив.");
  try { await ensureProcessingTransport(); } catch { throw new HttpError(503, "Обработка временно недоступна. Повторите загрузку позже."); }
  const requirements = await activeRequirements();
  const unpacked = archive ? extractResumeArchive(file.buffer) : {
    files: [{ sourcePath: filename, filename, buffer: file.buffer }], ignored: [] as string[],
  };
  const id = randomUUID(), items: ImportFile[] = [], buffers = new Map<string, Buffer>();
  // Validate the entire archive before publishing a single task.
  for (const source of unpacked.files) {
    const mime = await validateFile(source.buffer, source.filename);
    await scanFile(source.buffer);
    const itemId = randomUUID(), fileId = randomUUID();
    items.push({ id: itemId, file_id: fileId, source_path: source.sourcePath, file_name: source.filename,
      mime_type: mime, size_bytes: source.buffer.length, sha256: hashFile(source.buffer),
      bucket: config.bucket, object_key: `resume-imports/${id}/${fileId}/${source.filename}`, candidate_hint: candidate });
    buffers.set(fileId, source.buffer);
  }
  const manifest: ImportManifest = { version: 1, id, archive_name: filename, created_at: new Date().toISOString(),
    requirements, items, ignored_files: unpacked.ignored };
  importManifestSchema.parse(manifest);
  if (Buffer.byteLength(JSON.stringify(manifest)) > 1500 * 1024) throw new HttpError(422, "Список файлов архива слишком большой.");
  const queued = await enqueueImport(manifest, buffers);
  return { ...initialImportDetail(manifest), queued };
}
export function initialImportDetail(manifest: ImportManifest): ResumeImportDetail {
  return { id: manifest.id, archive_name: manifest.archive_name, created_at: manifest.created_at,
    total_files: manifest.items.length, processed_files: 0, pending_files: manifest.items.length, failed_files: 0,
    uploading_files: manifest.items.length, processing_files: 0, ignored_files: manifest.ignored_files,
    items: manifest.items.map(file => ({ id: file.id, source_path: file.source_path, file_name: file.file_name,
      status: "uploading", attempt: 1, error: null, warning: null, candidate_id: null, resume_id: null, updated_at: manifest.created_at })) };
}
export async function importDetail(id: string): Promise<ResumeImportDetail> {
  const { manifest, events } = await readImportLedger(id);
  const latest = manifest.items.map(file => latestItemEvent(events, file.id));
  const receipts = await pool.query(`SELECT e.id,r.id AS resume_id,r.candidate_id FROM resume_events e
    JOIN resumes r ON r.id=e.resume_id WHERE e.id=ANY($1::uuid[]) AND e.event_type='scored'`,
    [manifest.items.map((file, i) => latest[i]?.job_id || file.id)]);
  const detail = initialImportDetail(manifest);
  detail.items = detail.items.map((item, i) => {
    const event = latest[i], receipt = receipts.rows.find(row => row.id === (event?.job_id || item.id));
    return { ...item, status: receipt ? "completed" : event?.stage === "completed" ? "pending" : event?.stage || "uploading",
      attempt: event?.attempt || 1, error: receipt ? null : event?.error || null, warning: event?.warning || null,
      candidate_id: receipt?.candidate_id || null, resume_id: receipt?.resume_id || null, updated_at: event?.created_at || item.updated_at };
  });
  detail.processed_files = detail.items.filter(i => i.status === "completed").length;
  detail.failed_files = detail.items.filter(i => i.status === "failed").length;
  detail.pending_files = detail.total_files - detail.processed_files - detail.failed_files;
  detail.uploading_files = detail.items.filter(i => i.status === "uploading").length;
  detail.processing_files = detail.items.filter(i => i.status === "processing").length;
  return detail;
}
export async function listImports() {
  const ids = (await brokerQueues()).filter(q => /^hr\.resume\.batch\.[a-f0-9-]{36}$/.test(q.name)).map(q => q.name.slice("hr.resume.batch.".length));
  const all: ResumeImportDetail[] = [];
  for (let i = 0; i < ids.length; i += 8) all.push(...await Promise.all(ids.slice(i, i + 8).map(importDetail)));
  return all.sort((a, b) => b.created_at.localeCompare(a.created_at)).map(({ items: _items, ...summary }) => summary);
}
const retryLocks = new Map<string, Promise<unknown>>();
export async function retryImport(id: string, itemId: string) {
  const key = `${id}:${itemId}`;
  const previous = retryLocks.get(key) || Promise.resolve();
  const task = previous.catch(() => {}).then(async () => {
    const detail = await importDetail(id);
    const item = detail.items.find(i => i.id === itemId);
    if (!item) throw new HttpError(404, "Файл не найден.");
    if (item.status !== "failed") throw new HttpError(409, "Повтор доступен после ошибки обработки.");
    if (item.attempt >= 100) throw new HttpError(409, "Лимит повторов исчерпан. Загрузите резюме заново.");
    const { manifest } = await readImportLedger(id);
    const file = manifest.items.find(i => i.id === itemId)!;
    const job: StorageJob = { version: 1, job_id: randomUUID(), batch_id: id, item_id: itemId,
      attempt: item.attempt + 1, file, requirements: manifest.requirements };
    if (file.target_resume_id) await pool.query(`UPDATE resumes SET scoring_status='pending' WHERE id=$1
      AND updated_at=$2::timestamptz AND scoring_status='failed'`, [file.target_resume_id, file.target_updated_at]);
    await enqueueImport(manifest, new Map(), [job]);
    return importDetail(id);
  });
  retryLocks.set(key, task);
  try { return await task; } finally { if (retryLocks.get(key) === task) retryLocks.delete(key); }
}
export async function enqueueExistingResume(resumeId: string, recoverPending = false) {
  const requirements = await activeRequirements();
  return transaction(async client => {
    const result = await client.query(`SELECT r.*,c.phone,c.last_name,c.first_name,c.middle_name,f.bucket,f.object_key,
      f.file_name,f.mime_type,f.size_bytes,f.file_sha256 FROM resumes r JOIN candidates c ON c.id=r.candidate_id
      JOIN files f ON f.id=r.file_id WHERE r.id=$1 FOR UPDATE OF r`, [resumeId]);
    const row = result.rows[0];
    if (!row) throw new HttpError(404, "Резюме не найдено.");
    if (!recoverPending && !["completed", "failed"].includes(row.scoring_status)) throw new HttpError(409, "Дождитесь окончания текущей обработки.");
    const update = await client.query("UPDATE resumes SET scoring_status='pending',updated_at=now() WHERE id=$1 RETURNING updated_at::text AS lease", [resumeId]);
    const id = randomUUID();
    const manifest: ImportManifest = { version: 1, id, archive_name: row.file_name, created_at: new Date().toISOString(), requirements, ignored_files: [], items: [{
      id: randomUUID(), file_id: row.file_id, source_path: row.file_name, file_name: row.file_name, mime_type: row.mime_type,
      size_bytes: Number(row.size_bytes), sha256: row.file_sha256, bucket: row.bucket, object_key: row.object_key,
      candidate_hint: extractedPersonSchema.parse(row), target_resume_id: resumeId, target_updated_at: update.rows[0].lease,
    }] };
    importManifestSchema.parse(manifest);
    await enqueueImport(manifest, new Map());
    return initialImportDetail(manifest);
  });
}
export async function reconcilePendingResumes() {
  const pending = await pool.query("SELECT id,updated_at::text AS lease FROM resumes WHERE scoring_status IN ('pending','processing')");
  if (!pending.rowCount) return;
  const known = new Set<string>();
  for (const queue of await brokerQueues()) {
    if (!/^hr\.resume\.batch\.[a-f0-9-]{36}$/.test(queue.name)) continue;
    const { manifest } = await readImportLedger(queue.name.slice("hr.resume.batch.".length));
    for (const file of manifest.items) if (file.target_resume_id) known.add(`${file.target_resume_id}:${file.target_updated_at}`);
  }
  for (const row of pending.rows) if (!known.has(`${row.id}:${row.lease}`)) await enqueueExistingResume(row.id, true);
}
