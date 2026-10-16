import { createHash } from "node:crypto";
import { analysisJobSchema, type AnalysisJob } from "@hr/contracts";
import { getFile, getAnalysisStatus, publishQueue, queues, readImportLedger, latestItemEvent,
  PermanentQueueError, QueuePausedError, rankBridgeEnabled, startQueueConsumer } from "@hr/data-access";
import { extractDocumentText } from "@hr/documents";
import { analyzeResume, AnalysisError } from "./analysis.js";
import { config } from "./config.js";

function envelope(job: AnalysisJob) {
  return { version: 1 as const, job_id: job.job_id, batch_id: job.batch_id, item_id: job.item_id, attempt: job.attempt };
}
export async function rankQueuedResume(input: unknown) {
  const parsed = analysisJobSchema.safeParse(input);
  if (!parsed.success) throw new PermanentQueueError("Некорректное задание временного адаптера /rank.");
  const job = parsed.data;
  const { events } = await readImportLedger(job.batch_id);
  const latest = latestItemEvent(events, job.item_id);
  if (!latest || latest.job_id !== job.job_id || latest.attempt !== job.attempt || ["completed", "failed"].includes(latest.stage)) return;
  if (!(await getAnalysisStatus()).available) throw new QueuePausedError("HTTP analyzer is not ready");
  const buffer = await getFile(job.file.bucket, job.file.object_key);
  if (buffer.length !== job.file.size_bytes || createHash("sha256").update(buffer).digest("hex") !== job.file.sha256)
    throw new PermanentQueueError("Контрольная сумма резюме не совпадает.");
  await publishQueue(queues.progress, { ...envelope(job), stage: "processing", created_at: new Date().toISOString() }, `${job.job_id}:processing`);
  try {
    const legacy = ["application/msword", "application/rtf", "text/plain"].includes(job.file.mime_type);
    const content = legacy ? Buffer.from(await extractDocumentText(buffer, job.file.mime_type), "utf8") : buffer;
    const file = new Blob([new Uint8Array(content)], { type: legacy ? "text/plain" : job.file.mime_type });
    const analysis = await analyzeResume(job.requirements, file, legacy ? "resume.txt" : job.file.file_name, config,
      event => console.info(JSON.stringify({ event: `rank_bridge_${event.type}`, job_id: job.job_id, ...event })));
    // /rank currently returns ratings only. Unknown identity remains null.
    await publishQueue(queues.results, { ...envelope(job), status: "completed", candidate: job.file.candidate_hint, analysis }, job.job_id);
  } catch (error) {
    if (!(error instanceof AnalysisError)) throw error;
    await publishQueue(queues.results, { ...envelope(job), status: "failed",
      error: { code: `RANK_${error.kind.toUpperCase()}`, message: error.message.slice(0, 2000) } }, job.job_id);
  }
}
export async function failRankBridge(input: unknown, error: Error) {
  const parsed = analysisJobSchema.safeParse(input);
  if (!parsed.success) return;
  const job = parsed.data;
  await publishQueue(queues.results, { ...envelope(job), status: "failed", error: { code: "RANK_BRIDGE_FAILED",
    message: error instanceof PermanentQueueError ? error.message : "Не удалось обработать резюме через /rank. Повторите обработку." } }, job.job_id);
}
export function startRankBridge() {
  return rankBridgeEnabled ? startQueueConsumer(queues.analysis, rankQueuedResume, failRankBridge) : async () => {};
}
