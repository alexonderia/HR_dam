import { pool } from "@hr/data-access";
import { keyFromEnv, AccessError } from "@hr/security";
import { ObjectStore, ProcessingBroker, ProcessingEngine, mutateTask, expireWork, probeEvaluator, type Task, type Job, type Publication } from "@hr/processing";
import { AuthorizedTaskStore } from "./processing-store.js";
import { persistResult, markTargetFailure } from "./import-results.js";
import { config } from "./config.js";
import { HttpError } from "./errors.js";

async function project(task: Task, job: Job) {
  const file = task.files.find(f => f.file_id === job.file_id)!;
  const duration = job.started_at ? Math.max(0, Date.now() - Date.parse(job.started_at)) : null;
  const result = job.result;
  if (result?.status === "failed") {
    await markTargetFailure(file, job.job_id, result.error.message, duration);
    return;
  }
  if (job.operation !== "evaluate" || !result || !("evaluations" in result)) return;
  try {
    return await persistResult(task.clusters!, file, job.job_id, result, duration);
  } catch (error) {
    if (error instanceof HttpError && error.status === 409) {
      await markTargetFailure(file, job.job_id, error.message, duration);
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
  const readiness = probeEvaluator();
  const endpoint = process.env.PROCESSING_MANAGEMENT_URL || "http://rabbitmq:15672";
  const connection = new URL(process.env.PROCESSING_AMQP_URL || "amqp://localhost/hr-authorized");
  try {
    const [response, evaluator] = await Promise.all([fetch(`${endpoint}/api/queues/hr-authorized`, { headers: { Authorization: `Basic ${Buffer.from(`${decodeURIComponent(connection.username)}:${decodeURIComponent(connection.password)}`).toString("base64")}` }, signal: AbortSignal.timeout(3000) }), readiness]);
    if (!response.ok) throw new Error();
    const rows = await response.json() as { name: string; messages_ready?: number; messages_unacknowledged?: number; consumers?: number }[];
    return { available: evaluator.available, evaluator,
      analysis_consumers: rows.find(q => q.name === "hr.authorized.evaluate")?.consumers || 0,
      queues: Object.fromEntries(rows.map(q => [q.name, { ready: q.messages_ready || 0, processing: q.messages_unacknowledged || 0, consumers: q.consumers || 0 }])) };
  } catch { return { available: false, evaluator: { ...await readiness, available: false }, analysis_consumers: 0, queues: {} }; }
}
