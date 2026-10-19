import { importEventSchema, type ImportEvent } from "@hr/contracts";
import * as rabbit from "./rabbit-queue.js";
import * as local from "./local-queue.js";
import { brokerEnabled, processingMode, rankBridgeEnabled } from "./processing-mode.js";
export { queues, batchQueue, PermanentQueueError, QueuePausedError, MissingImportError, isInfrastructureError, latestItemEvent } from "./rabbit-queue.js";
export { closeBroker } from "./rabbit-queue.js";
export function connectBroker() {
  if (!brokerEnabled) throw new Error("RabbitMQ is disabled; use ensureProcessingTransport");
  return rabbit.connectBroker();
}
export async function ensureProcessingTransport() {
  if (brokerEnabled) await rabbit.connectBroker();
  else await local.ensureLocalQueue();
}
export const publishQueue: typeof rabbit.publishQueue = (...args) => brokerEnabled ? rabbit.publishQueue(...args) : local.publishLocalQueue(...args);
export const readImportLedger: typeof rabbit.readImportLedger = id => brokerEnabled ? rabbit.readImportLedger(id) : local.readLocalLedger(id);
export const brokerQueues: typeof rabbit.brokerQueues = () => brokerEnabled ? rabbit.brokerQueues() : local.localQueues();
export async function publishImportEvent(event: ImportEvent) {
  const parsed = importEventSchema.parse(event);
  await publishQueue(rabbit.batchQueue(parsed.batch_id), { kind: "event", event: parsed }, `${parsed.job_id}:${parsed.stage}`);
}
export async function getBrokerStatus() {
  const status = brokerEnabled ? await rabbit.getBrokerStatus() : await local.localQueueStatus();
  return { ...status, mode: processingMode, broker_enabled: brokerEnabled, rank_bridge_enabled: rankBridgeEnabled };
}
export const startQueueConsumer: typeof rabbit.startQueueConsumer = (...args) => brokerEnabled ? rabbit.startQueueConsumer(...args) : local.startLocalQueueConsumer(...args);
