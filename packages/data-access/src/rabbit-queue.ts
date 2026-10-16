import amqp, { type ChannelModel, type ConfirmChannel, type ConsumeMessage, type Channel } from "amqplib";
import { setTimeout as delay } from "node:timers/promises";
import { importManifestSchema, importEventSchema, type ImportManifest, type ImportEvent, type BrokerStatus } from "@hr/contracts";

export const queues = {
  storage: "hr.resume.storage", analysis: "hr.resume.analysis", results: "hr.resume.results",
  progress: "hr.resume.progress", dead: "hr.resume.dead",
} as const;
export const batchQueue = (id: string) => `hr.resume.batch.${id}`;
const user = process.env.RABBITMQ_USER || "hr_dam";
const password = process.env.RABBITMQ_PASSWORD || "";
const vhost = process.env.RABBITMQ_VHOST || "/";
export const brokerConfig = {
  url: process.env.RABBITMQ_URL || `amqp://${encodeURIComponent(user)}:${encodeURIComponent(password)}@${process.env.RABBITMQ_HOST || "127.0.0.1"}:${process.env.RABBITMQ_PORT || 5672}/${encodeURIComponent(vhost)}?heartbeat=15`,
  managementUrl: process.env.RABBITMQ_MANAGEMENT_URL || "http://127.0.0.1:15672",
  retryDelayMs: Number(process.env.QUEUE_RETRY_DELAY_MS || 10000),
};
export class PermanentQueueError extends Error {}
export class QueuePausedError extends Error {}
export class MissingImportError extends Error {}
let broker: Promise<{ connection: ChannelModel; publisher: ConfirmChannel }> | undefined;

async function topology(channel: Channel) {
  await channel.assertQueue(queues.dead, { durable: true });
  for (const name of [queues.storage, queues.analysis, queues.results, queues.progress]) {
    await channel.assertQueue(name, { durable: true, arguments: {
      "x-dead-letter-exchange": "", "x-dead-letter-routing-key": queues.dead,
      ...([queues.results, queues.progress].includes(name as typeof queues.results) ? { "x-single-active-consumer": true } : {}),
    } });
    await channel.assertQueue(name + ".retry", { durable: true, arguments: {
        "x-message-ttl": brokerConfig.retryDelayMs, "x-dead-letter-exchange": "", "x-dead-letter-routing-key": name,
      } });
  }
}
export function connectBroker() {
  if (!broker) {
    const attempt = (async () => {
      const connection = await amqp.connect(brokerConfig.url, { timeout: 10000 });
      connection.on("error", () => {});
      connection.on("close", () => { if (broker === attempt) broker = undefined; });
      try {
        const publisher = await connection.createConfirmChannel();
        publisher.on("error", () => {});
        publisher.on("close", () => { if (broker === attempt) broker = undefined; });
        await topology(publisher);
        return { connection, publisher };
      } catch (error) { await connection.close().catch(() => {}); throw error; }
    })();
    broker = attempt;
    void attempt.catch(() => { if (broker === attempt) broker = undefined; });
  }
  return broker;
}
export async function publishQueue(name: string, body: unknown, messageId: string, headers: Record<string, unknown> = {}) {
  const { publisher } = await connectBroker();
  if (name.startsWith("hr.resume.batch.")) await publisher.assertQueue(name, { durable: true });
  const content = Buffer.from(JSON.stringify(body));
  if (content.length > 2 * 1024 * 1024) throw new PermanentQueueError("Queue message exceeds 2 MiB");
  await new Promise<void>((resolve, reject) => {
    publisher.sendToQueue(name, content, { persistent: true, contentType: "application/json", messageId,
      timestamp: Math.floor(Date.now() / 1000), headers }, error => error ? reject(error) : resolve());
  });
}
export async function publishImportEvent(event: ImportEvent) {
  const parsed = importEventSchema.parse(event);
  await publishQueue(batchQueue(parsed.batch_id), { kind: "event", event: parsed }, `${parsed.job_id}:${parsed.stage}`);
}

// Inventory queues have no consumers. Peek through a separate channel and always
// requeue the records; a channel/process crash also makes them available again.
const readers = new Map<string, Promise<unknown>>();
export async function readImportLedger(id: string): Promise<{ manifest: ImportManifest; events: ImportEvent[] }> {
  const previous = readers.get(id) || Promise.resolve();
  const read = previous.catch(() => {}).then(async () => {
    const { connection } = await connectBroker();
    const channel = await connection.createChannel();
    channel.on("error", () => {});
    try {
      const queue = await channel.checkQueue(batchQueue(id)).catch(error => {
        if ((error as { code?: number }).code === 404) throw new MissingImportError("Загрузка не найдена.");
        throw error;
      });
      if (queue.messageCount > 10000) throw new Error("Import ledger exceeds supported size");
      let manifest: ImportManifest | undefined;
      const events: ImportEvent[] = [];
      for (let i = 0; i < queue.messageCount; i++) {
        const message = await channel.get(batchQueue(id), { noAck: false });
        if (!message) break;
        const record = JSON.parse(message.content.toString()) as { kind: string; manifest?: unknown; event?: unknown };
        if (record.kind === "manifest") manifest = importManifestSchema.parse(record.manifest);
        if (record.kind === "event") events.push(importEventSchema.parse(record.event));
      }
      channel.nackAll(true);
      if (!manifest) throw new Error("Import inventory is unavailable");
      return { manifest, events };
    } finally { await channel.close().catch(() => {}); }
  });
  readers.set(id, read);
  try { return await read; } finally { if (readers.get(id) === read) readers.delete(id); }
}
export interface RabbitQueue { name: string; messages_ready?: number; messages_unacknowledged?: number; consumers?: number }
export async function brokerQueues(): Promise<RabbitQueue[]> {
  const response = await fetch(`${brokerConfig.managementUrl}/api/queues/${encodeURIComponent(vhost)}?columns=name,messages_ready,messages_unacknowledged,consumers`, {
    headers: { Authorization: `Basic ${Buffer.from(`${user}:${password}`).toString("base64")}` }, signal: AbortSignal.timeout(5000),
  });
  if (!response.ok) throw new Error("RabbitMQ management API is unavailable");
  return await response.json() as RabbitQueue[];
}
export async function getBrokerStatus(): Promise<BrokerStatus> {
  const status: BrokerStatus = { available: true, analysis_consumers: 0, queues: {} };
  for (const queue of await brokerQueues()) {
    if (!Object.values(queues).includes(queue.name as typeof queues.storage) && !queue.name.endsWith(".retry")) continue;
    status.queues[queue.name] = { ready: queue.messages_ready || 0, processing: queue.messages_unacknowledged || 0, consumers: queue.consumers || 0 };
    if (queue.name === queues.analysis) status.analysis_consumers = queue.consumers || 0;
  }
  // Management statistics can lag behind a newly connected consumer. A passive
  // AMQP declaration gives the current consumer and ready-message counts.
  const { publisher } = await connectBroker();
  const analysis = await publisher.checkQueue(queues.analysis);
  status.analysis_consumers = analysis.consumerCount;
  status.queues[queues.analysis] = { ...status.queues[queues.analysis], ready: analysis.messageCount,
    consumers: analysis.consumerCount, processing: status.queues[queues.analysis]?.processing || 0 };
  return status;
}
export function latestItemEvent(events: ImportEvent[], itemId: string): ImportEvent | undefined {
  const order = { uploading: 0, pending: 1, processing: 2, failed: 3, completed: 4 };
  return events.filter(e => e.item_id === itemId).sort((a, b) => b.attempt - a.attempt || order[b.stage] - order[a.stage] || Date.parse(b.created_at) - Date.parse(a.created_at))[0];
}
type Exhausted = (body: unknown, error: Error) => Promise<void>;
export function startQueueConsumer(name: string, handler: (body: unknown) => Promise<void>, exhausted: Exhausted) {
  let stopped = false, current: Channel | undefined;
  let active: Promise<void> = Promise.resolve();
  const task = (async () => {
    while (!stopped) {
      try {
        const { connection } = await connectBroker();
        const channel = await connection.createChannel();
        current = channel;
        channel.on("error", () => {});
        await channel.prefetch(1);
        const closed = new Promise<void>(resolve => channel.once("close", resolve));
        await channel.consume(name, (message: ConsumeMessage | null) => {
          if (!message) { void channel.close().catch(() => {}); return; }
          active = (async () => {
            let body: unknown;
            try {
              body = JSON.parse(message.content.toString());
              await handler(body);
              channel.ack(message);
            } catch (cause) {
              const error = cause instanceof Error ? cause : new Error("Queue processing failed");
              const retries = Number(message.properties.headers?.["hr-retries"] || 0);
              try {
                if (body && error instanceof QueuePausedError) {
                  await publishQueue(name + ".retry", body, message.properties.messageId || "paused", { "hr-retries": retries });
                  channel.ack(message);
                } else if (body && !(error instanceof PermanentQueueError) && retries < 5) {
                  await publishQueue(name + ".retry", body, message.properties.messageId || "retry", { "hr-retries": retries + 1 });
                  channel.ack(message);
                } else {
                  if (body) await exhausted(body, error);
                  channel.nack(message, false, false);
                }
              } catch {
                await delay(brokerConfig.retryDelayMs);
                try { channel.nack(message, false, true); } catch { /* Connection loss already requeues the delivery. */ }
              }
            }
          })();
        }, { noAck: false });
        if (stopped) await channel.close().catch(() => {});
        await closed;
        await active;
      } catch { if (!stopped) console.error("Queue consumer disconnected; reconnecting"); }
      if (!stopped) await delay(3000);
    }
  })();
  return async () => { stopped = true; await current?.close().catch(() => {}); await active; await task; };
}
export async function closeBroker() {
  const current = broker;
  broker = undefined;
  if (current) await (await current.catch(() => undefined))?.connection.close().catch(() => {});
}
