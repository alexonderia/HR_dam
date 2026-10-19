import { createHash } from "node:crypto";
import { readFile, unlink } from "node:fs/promises";
import { storageJobSchema } from "@hr/contracts";
import { stagedFilePath, putFile, getFile, fileDownloadUrl, publishQueue, publishImportEvent, queues, PermanentQueueError } from "@hr/data-access";

export async function storeResume(input: unknown) {
  const parsed = storageJobSchema.safeParse(input);
  if (!parsed.success) throw new PermanentQueueError("Invalid storage job");
  const job = parsed.data;
  let content: Buffer;
  try { content = await readFile(stagedFilePath(job.file.file_id)); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    content = await getFile(job.file.bucket, job.file.object_key);
  }
  if (content.length !== job.file.size_bytes || createHash("sha256").update(content).digest("hex") !== job.file.sha256)
    throw new PermanentQueueError("Контрольная сумма файла не совпадает. Загрузите резюме заново.");
  await putFile(job.file.object_key, content, job.file.mime_type, job.file.bucket);
  await publishImportEvent({ version: 1, job_id: job.job_id, batch_id: job.batch_id, item_id: job.item_id,
    attempt: job.attempt, stage: "pending", created_at: new Date().toISOString() });
  await publishQueue(queues.analysis, { ...job, file: { ...job.file, ...await fileDownloadUrl(job.file.bucket, job.file.object_key) } }, job.job_id);
  await unlink(stagedFilePath(job.file.file_id)).catch(error => {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") console.error("Processed staging file could not be removed");
  });
}
export async function failStorageJob(input: unknown, error: Error) {
  const parsed = storageJobSchema.safeParse(input);
  if (!parsed.success) return;
  const job = parsed.data;
  const message = error instanceof PermanentQueueError ? error.message : "Не удалось сохранить файл в хранилище. Повторите обработку.";
  if (job.file.target_resume_id) {
    // Let the result consumer release the resume's pending state before exposing a retry.
    await publishQueue(queues.results, { version: 1, job_id: job.job_id, batch_id: job.batch_id, item_id: job.item_id,
      attempt: job.attempt, status: "failed", error: { code: "storage_failed", message } }, job.job_id);
    return;
  }
  await publishImportEvent({ version: 1, job_id: job.job_id, batch_id: job.batch_id, item_id: job.item_id,
    attempt: job.attempt, stage: "failed", error: message, created_at: new Date().toISOString() });
}
