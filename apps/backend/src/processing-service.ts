import { pool, PermanentQueueError } from "@hr/data-access";
import { keyFromEnv, AccessError } from "@hr/security";
import { ObjectStore, ProcessingBroker, ProcessingEngine, mutateTask, expireWork, type Task, type Job, type Publication } from "@hr/processing";
import { AuthorizedTaskStore } from "./processing-store.js";
import { persistResult, markTargetFailure } from "./import-results.js";
import type { ImportFile, ImportManifest } from "@hr/contracts";
import { config } from "./config.js";

async function project(task: Task, job: Job) {
  const file = task.files.find(f => f.file_id === job.file_id)!;
  const input: ImportFile = { id: file.file_id, ...file, source_path: file.metadata?.archive_path || file.file_name, bucket: config.bucket,
    object_key: file.key, candidate_hint: file.candidate_hint || { last_name: null, first_name: null, middle_name: null, phone: null } };
  const duration = job.started_at ? Math.max(0, Date.now() - Date.parse(job.started_at)) : null;
  if (job.result?.status === "failed") { await markTargetFailure(input, job.job_id, job.result.error.message, duration); return; }
  if (job.operation !== "evaluate" || !job.result || !("evaluations" in job.result)) return;
  const manifest: ImportManifest = { version: 1, id: task.id, archive_name: task.name, created_at: task.created_at,
    requirements: task.clusters!, ignored_files: [], items: [input] };
  const result = job.result;
  try { return await persistResult(manifest, input, { version: 1, job_id: job.job_id, batch_id: task.id, item_id: file.file_id, attempt: job.attempt,
    status: "completed", candidate: result.candidate, analysis: { clusters: task.clusters!.map(cluster => ({ id: cluster.id,
      profiles: cluster.profiles.map(profile => {
        const evaluation = result.evaluations.find(e => e.target_id === profile.id)!;
        return { id: profile.id, score: evaluation.score, matched_keywords: evaluation.matched_keywords,
          triggered_stop_factors: evaluation.triggered_stop_factors, details: { criteria: evaluation.criteria }, explanation: evaluation.explanation };
      }) })) } }, duration); } catch (error) {
    if (error instanceof PermanentQueueError) {
      await markTargetFailure(input, job.job_id, error.message, duration);
      throw new AccessError(409, error.message);
    }
    throw error;
  }
}
let runtime: { objects: ObjectStore; store: AuthorizedTaskStore; broker: ProcessingBroker; engine: ProcessingEngine } | undefined;
export function authorizedProcessing() {
  if (runtime) return runtime;
  const objects = new ObjectStore(config.bucket), store = new AuthorizedTaskStore();
  let engine: ProcessingEngine;
  const broker = new ProcessingBroker(process.env.PROCESSING_AMQP_URL || "", "authorized", (task, id) => engine.token(task.jobs.find(j => j.job_id === id)!),
    async id => { await pool.query("UPDATE processing_outbox SET published_at=now() WHERE id=$1 AND published_at IS NULL", [id]); });
  engine = new ProcessingEngine("authorized", store, objects, broker, { privateKey: keyFromEnv("AUTHORIZED_JOB_PRIVATE_KEY"), publicKey: keyFromEnv("AUTHORIZED_JOB_PUBLIC_KEY") }, project);
  return runtime = { objects, store, broker, engine };
}
let flushing = false;
export async function flushAuthorizedOutbox() {
  if (flushing) return;
  flushing = true;
  const runtime = authorizedProcessing();
  try {
    const { rows } = await pool.query("SELECT o.id,o.message,t.state FROM processing_outbox o JOIN processing_tasks t ON t.id=o.task_id WHERE o.published_at IS NULL ORDER BY o.created_at LIMIT 100");
    for (const row of rows) {
      const task = row.state as Task;
      if (Date.now() >= Date.parse(task.deadline)) {
        await mutateTask(runtime.store, task.id, current => { expireWork(current); });
        await pool.query("UPDATE processing_outbox SET published_at=now() WHERE id=$1", [row.id]);
        continue;
      }
      await runtime.broker.publish(row.message as Publication, task);
    }
  } finally { flushing = false; }
}
export function startAuthorizedProcessing() {
  const runtime = authorizedProcessing(), stop = runtime.broker.start(runtime.engine);
  const flush = () => flushAuthorizedOutbox().catch(() => console.error("Authorized outbox retained for retry"));
  void flush(); const timer = setInterval(() => void flush(), 5000);
  return async () => { clearInterval(timer); await stop(); };
}
export async function processingBrokerStatus() {
  const endpoint = process.env.PROCESSING_MANAGEMENT_URL || "http://rabbitmq:15672";
  const connection = new URL(process.env.PROCESSING_AMQP_URL || "amqp://localhost/hr-authorized");
  try {
    const response = await fetch(`${endpoint}/api/queues/hr-authorized`, { headers: { Authorization: `Basic ${Buffer.from(`${decodeURIComponent(connection.username)}:${decodeURIComponent(connection.password)}`).toString("base64")}` }, signal: AbortSignal.timeout(3000) });
    if (!response.ok) throw new Error();
    const rows = await response.json() as { name: string; messages_ready?: number; messages_unacknowledged?: number; consumers?: number }[];
    return { mode: "broker" as const, broker_enabled: true, rank_bridge_enabled: false, available: true,
      analysis_consumers: rows.find(q => q.name === "hr.authorized.evaluate")?.consumers || 0,
      queues: Object.fromEntries(rows.map(q => [q.name, { ready: q.messages_ready || 0, processing: q.messages_unacknowledged || 0, consumers: q.consumers || 0 }])) };
  } catch { return { mode: "broker" as const, broker_enabled: true, rank_bridge_enabled: false, available: false, analysis_consumers: 0, queues: {} }; }
}
