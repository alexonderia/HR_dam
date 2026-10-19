import { mkdir, readFile, writeFile, rename, readdir, unlink, stat } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { importManifestSchema, importEventSchema, type ImportManifest, type ImportEvent, type BrokerStatus } from "@hr/contracts";
import { queues, batchQueue, type RabbitQueue } from "./rabbit-queue.js";
import { PermanentQueueError, MissingImportError, queueRetry } from "./queue-errors.js";
import { spoolRoot } from "./spool.js";

const root = join(spoolRoot, "direct");
const pollMs = 200;
const leaseMs = Number(process.env.DIRECT_QUEUE_LEASE_MS || 30000);
const retryMs = Number(process.env.QUEUE_RETRY_DELAY_MS || 10000);
const uuid = /^[a-f0-9-]{36}$/i;
interface Envelope { body: unknown; id: string; headers: Record<string, unknown>; available_at: number }
async function files(path: string) {
  try { return (await readdir(path)).filter(name => name.endsWith(".json")).sort(); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
}
async function atomicJson(path: string, value: unknown) {
  const temp = path + "." + randomUUID() + ".tmp";
  try {
    await writeFile(temp, JSON.stringify(value), { mode: 0o600, flush: true });
    await rename(temp, path);
  } finally { await unlink(temp).catch(() => {}); }
}
export async function ensureLocalQueue() {
  await Promise.all(["manifests", "events", "leases", "queues"].map(name => mkdir(join(root, name), { recursive: true })));
}
function queueDirectory(name: string) {
  if (!Object.values(queues).includes(name as typeof queues.storage)) throw new PermanentQueueError("Unsupported direct queue");
  return join(root, "queues", name);
}
async function ensureWorkQueue(name: string) {
  const directory = queueDirectory(name);
  await Promise.all(["ready", "processing"].map(part => mkdir(join(directory, part), { recursive: true })));
  return directory;
}
export async function publishLocalQueue(name: string, body: unknown, messageId: string, headers: Record<string, unknown> = {}) {
  await ensureLocalQueue();
  if (Buffer.byteLength(JSON.stringify(body)) > 2 * 1024 * 1024) throw new PermanentQueueError("Queue message exceeds 2 MiB");
  if (name.startsWith("hr.resume.batch.")) {
    const id = name.slice("hr.resume.batch.".length);
    if (!uuid.test(id)) throw new PermanentQueueError("Invalid batch ID");
    const record = body as { kind: string; manifest: unknown; event: unknown };
    if (record.kind === "manifest") {
      const manifest = importManifestSchema.parse(record.manifest);
      if (manifest.id !== id) throw new PermanentQueueError("Mismatched batch ID");
      await atomicJson(join(root, "manifests", id + ".json"), manifest);
    } else if (record.kind === "event") {
      const event = importEventSchema.parse(record.event);
      if (event.batch_id !== id) throw new PermanentQueueError("Mismatched event batch ID");
      const directory = join(root, "events", id);
      await mkdir(directory, { recursive: true });
      await atomicJson(join(directory, `${event.job_id}-${event.stage}.json`), event);
    } else throw new PermanentQueueError("Invalid inventory record");
    return;
  }
  const retry = name.endsWith(".retry");
  const directory = await ensureWorkQueue(retry ? name.slice(0, -6) : name);
  const envelope: Envelope = { body, id: messageId, headers, available_at: Date.now() + (retry ? retryMs : 0) };
  await atomicJson(join(directory, "ready", `${Date.now()}-${randomUUID()}.json`), envelope);
}
export async function readLocalLedger(id: string): Promise<{ manifest: ImportManifest; events: ImportEvent[] }> {
  if (!uuid.test(id)) throw new MissingImportError("Загрузка не найдена.");
  let manifest: ImportManifest;
  try { manifest = importManifestSchema.parse(JSON.parse(await readFile(join(root, "manifests", id + ".json"), "utf8"))); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new MissingImportError("Загрузка не найдена."); throw error; }
  const directory = join(root, "events", id);
  const events = await Promise.all((await files(directory)).map(async name => importEventSchema.parse(JSON.parse(await readFile(join(directory, name), "utf8")))));
  return { manifest, events };
}
async function leaseAlive(name: string, owner: string) {
  try { return Date.now() - (await stat(join(root, "leases", `${name}.${owner}.json`))).mtimeMs < leaseMs; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error; }
}
async function recoverClaims(name: string, owner: string) {
  const directory = await ensureWorkQueue(name);
  for (const filename of await files(join(directory, "processing"))) {
    const previousOwner = filename.slice(0, 36);
    if (previousOwner !== owner && await leaseAlive(name, previousOwner)) continue;
    try { await rename(join(directory, "processing", filename), join(directory, "ready", filename.slice(38))); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  }
}
export function startLocalQueueConsumer(name: string, handler: (body: unknown) => Promise<void>, exhausted: (body: unknown, error: Error) => Promise<void>) {
  let stopped = false;
  const owner = randomUUID(), leasePath = join(root, "leases", `${name}.${owner}.json`);
  let heartbeat = Promise.resolve();
  const beat = () => { heartbeat = heartbeat.catch(() => {}).then(async () => {
    await ensureLocalQueue(); await atomicJson(leasePath, { queue: name, owner });
  }); void heartbeat.catch(() => {}); };
  beat();
  const timer = setInterval(beat, Math.max(100, Math.min(2000, Math.floor(leaseMs / 3))));
  const task = (async () => {
    try {
      while (!stopped) {
        try {
          await heartbeat;
          await recoverClaims(name, owner);
          const directory = await ensureWorkQueue(name);
          let claimed = false;
          for (const filename of await files(join(directory, "ready"))) {
            if (stopped) break;
            let envelope: Envelope;
            try { envelope = JSON.parse(await readFile(join(directory, "ready", filename), "utf8")) as Envelope; }
            catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") continue; throw error; }
            if (envelope.available_at > Date.now()) continue;
            const inflight = join(directory, "processing", `${owner}--${filename}`);
            try { await rename(join(directory, "ready", filename), inflight); }
            catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") continue; throw error; }
            claimed = true;
            try {
              await handler(envelope.body);
              await unlink(inflight);
            } catch (cause) {
              const error = cause instanceof Error ? cause : new Error("Direct processing failed");
              const retries = Number(envelope.headers["hr-retries"] || 0);
              const next = queueRetry(error, retries);
              if (next != null) {
                await publishLocalQueue(name + ".retry", envelope.body, envelope.id,
                  { ...envelope.headers, "hr-retries": next });
              } else {
                await exhausted(envelope.body, error);
                await publishLocalQueue(queues.dead, envelope.body, envelope.id, envelope.headers);
              }
              await unlink(inflight);
            }
            break;
          }
          if (!claimed) await delay(pollMs);
        } catch { if (!stopped) { console.error("Direct processing unavailable; retrying"); await delay(1000); } }
      }
    } finally {
      clearInterval(timer);
      await heartbeat.catch(() => {});
      await unlink(leasePath).catch(() => {});
    }
  })();
  return async () => { stopped = true; await task; };
}
export async function localQueues(): Promise<RabbitQueue[]> {
  await ensureLocalQueue();
  const result: RabbitQueue[] = (await files(join(root, "manifests"))).map(name => ({ name: batchQueue(name.slice(0, -5)), messages_ready: 1 }));
  for (const name of Object.values(queues)) {
    const directory = queueDirectory(name);
    let consumers = 0;
    for (const filename of await files(join(root, "leases"))) {
      if (filename.startsWith(name + ".") && await leaseAlive(name, filename.slice(name.length + 1, -5))) consumers++;
    }
    result.push({ name, consumers, messages_ready: (await files(join(directory, "ready"))).length,
      messages_unacknowledged: (await files(join(directory, "processing"))).length });
  }
  return result;
}
export async function localQueueStatus(): Promise<BrokerStatus> {
  const status: BrokerStatus = { available: true, analysis_consumers: 0, queues: {} };
  for (const queue of await localQueues()) {
    if (queue.name.startsWith("hr.resume.batch.")) continue;
    status.queues[queue.name] = { ready: queue.messages_ready || 0, processing: queue.messages_unacknowledged || 0, consumers: queue.consumers || 0 };
    if (queue.name === queues.analysis) status.analysis_consumers = queue.consumers || 0;
  }
  return status;
}
