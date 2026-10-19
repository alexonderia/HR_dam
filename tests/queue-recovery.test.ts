import assert from "node:assert/strict";
import { test } from "node:test";
import { isInfrastructureError, PermanentQueueError, QueuePausedError, queueRetry } from "../packages/data-access/src/queue-errors.js";
import { randomUUID } from "node:crypto";
import { importJobIdentitySchema } from "@hr/contracts";

test("infrastructure waiting preserves a document retry budget, even after five failures", () => {
  const failures = [
    new QueuePausedError("Not ready"),
    Object.assign(new Error("Database restarting"), { code: "57P03" }),
    Object.assign(new Error("Connection lost"), { code: "08006" }),
    new TypeError("fetch failed", { cause: Object.assign(new Error("Socket"), { code: "ECONNRESET" }) }),
    Object.assign(new Error("Storage unavailable"), { $metadata: { httpStatusCode: 503 } }),
    new Error("Connection terminated unexpectedly"),
    new Error("timeout exceeded when trying to connect"),
    Object.assign(new Error("Broker shutting down"), { code: 320 }),
  ];
  for (const error of failures) {
    assert.equal(isInfrastructureError(error), true);
    assert.equal(queueRetry(error, 0), 0);
    assert.equal(queueRetry(error, 5), 5);
  }
});

test("document, configuration and unknown errors keep bounded retries", () => {
  for (const error of [new Error("Unexpected bug"), Object.assign(new Error("Bad SQL"), { code: "42601" }),
    Object.assign(new Error("Access denied"), { $metadata: { httpStatusCode: 403 } })]) {
    assert.equal(isInfrastructureError(error), false);
    assert.equal(queueRetry(error, 0), 1);
    assert.equal(queueRetry(error, 5), null);
  }
  assert.equal(queueRetry(new PermanentQueueError("Invalid checksum"), 0), null);
  for (const invalid of [-1, NaN, Infinity, 1.5]) assert.equal(queueRetry(new QueuePausedError("Paused"), invalid), null);
  const cyclic: { cause?: unknown } = {}; cyclic.cause = cyclic;
  assert.equal(isInfrastructureError(cyclic), false);
});

test("job status lookup identifies one exact document attempt", () => {
  const identity = { version: 1, job_id: randomUUID(), batch_id: randomUUID(), item_id: randomUUID(), attempt: 1 };
  assert.deepEqual(importJobIdentitySchema.parse(identity), identity);
  for (const invalid of [{ ...identity, version: 2 }, { ...identity, attempt: 0 },
    { ...identity, job_id: "candidate-id" }, { ...identity, candidate_id: randomUUID() }])
    assert.equal(importJobIdentitySchema.safeParse(invalid).success, false);
});
