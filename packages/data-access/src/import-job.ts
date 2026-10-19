import type { ImportJobIdentity, ImportJobState } from "@hr/contracts";
import { pool } from "./db.js";
import { readImportLedger, latestItemEvent, MissingImportError, QueuePausedError } from "./queue.js";

// Check the exact attempt, not the candidate's overall scoring_status: a
// previously completed resume can have a new, legitimate assessment queued.
export async function getImportJobState(job: ImportJobIdentity): Promise<ImportJobState> {
  const { manifest, events } = await readImportLedger(job.batch_id);
  const file = manifest.items.find(item => item.id === job.item_id);
  if (!file) throw new MissingImportError("Файл не принадлежит загрузке.");
  const latest = latestItemEvent(events, job.item_id);
  if (!latest) throw new QueuePausedError("Состояние задания ещё не опубликовано.");
  if (latest.job_id !== job.job_id || latest.attempt !== job.attempt)
    return { status: "superseded", should_process: false };
  const receipt = await pool.query("SELECT 1 FROM resume_events WHERE id=$1 AND event_type='scored'", [job.job_id]);
  if (receipt.rowCount) return { status: "completed", should_process: false };
  if (file.target_resume_id) {
    const current = await pool.query(`SELECT 1 FROM resumes WHERE id=$1 AND file_id=$2 AND updated_at=$3::timestamptz`,
      [file.target_resume_id, file.file_id, file.target_updated_at]);
    if (!current.rowCount) return { status: "superseded", should_process: false };
  }
  if (latest.stage === "failed") return { status: "failed", should_process: false };
  if (latest.stage === "completed") throw new QueuePausedError("Завершение задания не подтверждено в БД.");
  return { status: latest.stage === "processing" ? "processing" : "pending", should_process: true };
}
