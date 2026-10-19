import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { setTimeout as delay } from "node:timers/promises";
import { booleanSetting } from "../packages/data-access/src/processing-mode.js";

test("processing switches accept only explicit boolean values", () => {
  const key = "TEST_PROCESSING_FLAG";
  try {
    delete process.env[key]; assert.equal(booleanSetting(key, false), false);
    process.env[key] = "true"; assert.equal(booleanSetting(key, false), true);
    process.env[key] = "false"; assert.equal(booleanSetting(key, true), false);
    process.env[key] = "disabled"; assert.throws(() => booleanSetting(key, true));
  } finally { delete process.env[key]; }
});

test("direct tasks survive a consumer process crash without contacting RabbitMQ", async () => {
  await mkdir(resolve(".qa"), { recursive: true });
  const root = await mkdtemp(join(resolve(".qa"), "direct-queue-test-"));
  process.env.RESUME_SPOOL_DIR = root;
  process.env.RABBITMQ_ENABLED = "false";
  process.env.RABBITMQ_URL = "amqp://127.0.0.1:1";
  process.env.RABBITMQ_MANAGEMENT_URL = "http://127.0.0.1:1";
  process.env.DIRECT_QUEUE_LEASE_MS = "500";
  process.env.QUEUE_RETRY_DELAY_MS = "1";
  const data = await import("@hr/data-access");
  const moduleUrl = pathToFileURL(resolve("packages/data-access/dist/index.js")).href;
  const child = spawn(process.execPath, ["--input-type=module", "-e", `
    const { startQueueConsumer, queues } = await import(${JSON.stringify(moduleUrl)});
    startQueueConsumer(queues.analysis, async () => {
      process.send({ claimed: true });
      await new Promise(() => {});
    }, async () => {});
  `], { env: { ...process.env }, stdio: ["ignore", "ignore", "pipe", "ipc"] });
  let stop: (() => Promise<void>) | undefined;
  try {
    const claimed = once(child, "message");
    await data.publishQueue(data.queues.analysis, { durable: "resume" }, "crash-test");
    const [message] = await Promise.race([claimed, delay(5000).then(() => { throw new Error("Child did not claim task"); })]);
    assert.deepEqual(message, { claimed: true });
    const exited = once(child, "exit"); child.kill("SIGKILL"); await exited;
    let received = 0;
    stop = data.startQueueConsumer(data.queues.analysis, async body => {
      assert.deepEqual(body, { durable: "resume" }); received++;
    }, async (_body, error) => { throw error; });
    for (let i = 0; i < 60 && !received; i++) await delay(50);
    assert.equal(received, 1, "Unacknowledged task was not recovered");
    await stop(); stop = undefined;
    const stats = await data.getBrokerStatus();
    assert.equal(stats.broker_enabled, false);
    assert.equal(stats.queues[data.queues.analysis].ready, 0);
    assert.equal(stats.queues[data.queues.analysis].processing, 0);
    assert.throws(() => data.connectBroker(), /disabled/);
    let outages = 0, recovered = false, exhausted = 0;
    const original = { job_id: "same-job", attempt: 1 };
    stop = data.startQueueConsumer(data.queues.analysis, async body => {
      assert.deepEqual(body, original);
      if (++outages <= 7) throw Object.assign(new Error("Database restarting"), { code: "57P03" });
      recovered = true;
    }, async () => { exhausted++; });
    await data.publishQueue(data.queues.analysis, original, "infrastructure", { "hr-retries": 5 });
    for (let i = 0; i < 100 && !recovered; i++) await delay(50);
    assert.equal(recovered, true, "Infrastructure waiting must survive an already used document retry budget");
    assert.equal(outages, 8);
    assert.equal(exhausted, 0);
    await stop(); stop = undefined;
  } finally {
    child.kill("SIGKILL");
    await stop?.(); await data.closeBroker();
    await rm(root, { recursive: true, force: true });
  }
});
