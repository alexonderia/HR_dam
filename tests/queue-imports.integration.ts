import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createServer } from "node:net";
import { readFile, rm } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { zipSync, strToU8 } from "fflate";
import { analysisJobSchema, type AnalysisJob, type ResumeImportDetail } from "@hr/contracts";
import { pool, connectBroker, closeBroker, startQueueConsumer, publishQueue, queues, readImportLedger, deleteFile,
  stagedFilePath, spoolRoot, flushImportOutbox, type config } from "@hr/data-access";

assert.match(process.env.POSTGRES_DB || "", /^hr_dam_queue_test_[a-f0-9]+$/);
assert.equal(process.env.RABBITMQ_VHOST, process.env.POSTGRES_DB);
const batchIds: string[] = [], stops: (() => Promise<void>)[] = [];
let infected = false;
const scanner = createServer(socket => {
  let content = Buffer.alloc(0);
  socket.on("data", chunk => {
    content = Buffer.concat([content, Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)]);
    if (content.length > 12 && content.subarray(-4).equals(Buffer.alloc(4))) socket.end(infected ? "stream: Test FOUND\0" : "stream: OK\0");
  });
}).listen(0, "127.0.0.1");
await new Promise<void>(resolve => scanner.once("listening", resolve));
process.env.CLAMAV_HOST = "127.0.0.1";
process.env.CLAMAV_PORT = String((scanner.address() as { port: number }).port);
const { app } = await import("../apps/backend/src/app.js");
const { startResultConsumers } = await import("../apps/backend/src/import-results.js");
const { storeResume, failStorageJob } = await import("../apps/worker/src/storage.js");
const server = app.listen(0, "127.0.0.1");
await new Promise<void>(resolve => server.once("listening", resolve));
const base = `http://127.0.0.1:${(server.address() as { port: number }).port}/api`;
const auth = { Authorization: `Bearer ${process.env.RESUME_ANALYZER_CALLBACK_TOKEN}` };
async function request<T>(path: string, init?: RequestInit, status = 200): Promise<T> {
  const response = await fetch(base + path, init);
  const body = await response.json();
  assert.equal(response.status, status, JSON.stringify(body));
  return body as T;
}
async function waitFor<T>(read: () => Promise<T>, match: (value: T) => boolean, message: string) {
  for (let i = 0; i < 150; i++) { const value = await read(); if (match(value)) return value; await delay(100); }
  throw new Error(message);
}
async function upload(name: string, content: Uint8Array, archive = true) {
  const form = new FormData();
  form.append(archive ? "archive" : "resume", new Blob([Uint8Array.from(content)]), name);
  const result = await request<ResumeImportDetail & { queued: boolean }>(archive ? "/resume-imports" : "/candidates", { method: "POST", body: form }, 202);
  batchIds.push(result.id); return result;
}
const accepted: AnalysisJob[] = [];
try {
  for (const name of ["V1__initial_schema.sql", "V2__normalized_candidate_identity.sql", "V3__optional_candidate_identity.sql", "V4__analysis_duration.sql"])
    await pool.query(await readFile(`db/migrations/${name}`, "utf8"));
  const cluster = randomUUID(), profile = randomUUID();
  await pool.query("INSERT INTO clusters(id,name,track) VALUES($1,'Integration','test')", [cluster]);
  await pool.query("INSERT INTO profiles(id,cluster_id,position_name) VALUES($1,$2,'Developer')", [profile, cluster]);
  await pool.query("INSERT INTO candidate_blacklist(id,phone,last_name,first_name,company_name) VALUES($1,'+79991234567','Тестов','Иван','Test')", [randomUUID()]);
  await connectBroker();
  stops.push(startResultConsumers());
  const stopStorage = startQueueConsumer(queues.storage, storeResume, failStorageJob);
  stops.push(stopStorage);
  const zip = zipSync({ "nested/a.txt": strToU8("Resume A"), "b.txt": strToU8("Resume B"), "notes.csv": strToU8("ignored") });
  const batch = await upload("resumes.zip", zip);
  assert.equal(batch.total_files, 2);
  assert.equal(batch.ignored_files.length, 1);
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM candidates")).rows[0].n, 0);
  const { publisher } = await connectBroker();
  await waitFor(() => publisher.checkQueue(queues.analysis), q => q.messageCount === 2, "Files did not reach analysis queue");
  const redeliveryChannel = await (await connectBroker()).connection.createChannel();
  const abandoned = await redeliveryChannel.get(queues.analysis, { noAck: false }); assert.ok(abandoned);
  await redeliveryChannel.close();
  await waitFor(() => publisher.checkQueue(queues.analysis), q => q.messageCount === 2, "Unacknowledged job was lost after consumer disconnect");
  for (let i = 0; i < 2; i++) {
    const message = await publisher.get(queues.analysis, { noAck: false }); assert.ok(message);
    const job = analysisJobSchema.parse(JSON.parse(message.content.toString())); accepted.push(job);
    assert.equal(await (await fetch(job.file.download_url)).text(), job.file.file_name === "a.txt" ? "Resume A" : "Resume B");
    const renewed = await request<{ download_url: string }>(`/internal/resume-imports/${batch.id}/items/${job.item_id}/download-url`, { method: "POST", headers: auth });
    assert.ok(renewed.download_url.includes("X-Amz-Signature"));
    const event = { version: 1, job_id: job.job_id, batch_id: job.batch_id, item_id: job.item_id, attempt: job.attempt, stage: "processing", created_at: new Date().toISOString() };
    await publishQueue(queues.progress, event, job.job_id);
    const result = { version: 1, job_id: job.job_id, batch_id: job.batch_id, item_id: job.item_id, attempt: job.attempt,
      status: "completed", candidate: i ? { phone: "+79991234567", last_name: "Тестов", first_name: "Иван" } : {},
      analysis: { clusters: [{ id: cluster, profiles: [{ id: profile, score: 82, explanation: "Test result" }] }] } };
    await publishQueue(queues.results, result, job.job_id);
    await publishQueue(queues.results, result, job.job_id); // Delivery after lost confirmation.
    publisher.ack(message);
  }
  const done = await waitFor(() => request<ResumeImportDetail>(`/resume-imports/${batch.id}`), d => d.processed_files === 2, "Results were not persisted");
  assert.equal(done.pending_files, 0);
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM candidates")).rows[0].n, 2);
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM profile_ratings")).rows[0].n, 2);
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM candidates WHERE phone IS NULL AND first_name IS NULL AND last_name IS NULL")).rows[0].n, 1);
  assert.ok(done.items.some(i => i.warning?.includes("чёрном списке")));

  const single = await upload("single.txt", strToU8("Single resume"), false);
  await waitFor(() => publisher.checkQueue(queues.analysis), q => q.messageCount === 1, "Single upload bypassed queue");
  let message = await publisher.get(queues.analysis, { noAck: false }); assert.ok(message);
  let job = analysisJobSchema.parse(JSON.parse(message.content.toString()));
  await publishQueue(queues.results, { version: 1, job_id: job.job_id, batch_id: job.batch_id, item_id: job.item_id,
    attempt: job.attempt, status: "failed", error: { code: "UNREADABLE", message: "Test failure" } }, job.job_id);
  publisher.ack(message);
  await waitFor(() => request<ResumeImportDetail>(`/resume-imports/${single.id}`), d => d.failed_files === 1, "Failure was not recorded in RabbitMQ");
  await request(`/resume-imports/${single.id}/items/${job.item_id}/retry`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" }, 202);
  await waitFor(() => publisher.checkQueue(queues.analysis), q => q.messageCount === 1, "Retry not published");
  message = await publisher.get(queues.analysis, { noAck: false }); assert.ok(message);
  const retried = analysisJobSchema.parse(JSON.parse(message.content.toString()));
  assert.equal(retried.attempt, 2);
  const analysis = { clusters: [{ id: cluster, profiles: [{ id: profile, score: 75 }] }] };
  await publishQueue(queues.results, { version: 1, job_id: job.job_id, batch_id: job.batch_id, item_id: job.item_id, attempt: 1, status: "completed", candidate: {}, analysis }, job.job_id);
  await publishQueue(queues.results, { version: 1, job_id: retried.job_id, batch_id: retried.batch_id, item_id: retried.item_id, attempt: 2, status: "completed", candidate: {}, analysis }, retried.job_id);
  publisher.ack(message);
  await waitFor(() => request<ResumeImportDetail>(`/resume-imports/${single.id}`), d => d.processed_files === 1, "Retry result not applied");
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM candidates")).rows[0].n, 3);
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM candidates WHERE phone IS NULL")).rows[0].n, 2, "Unknown people were merged");

  const retryBatch = await request<ResumeImportDetail>(`/resumes/${done.items[0].resume_id}/retry`, { method: "POST" }, 202);
  batchIds.push(retryBatch.id);
  await waitFor(() => publisher.checkQueue(queues.analysis), q => q.messageCount === 1, "Existing resume did not enter RabbitMQ");
  message = await publisher.get(queues.analysis, { noAck: false }); assert.ok(message);
  job = analysisJobSchema.parse(JSON.parse(message.content.toString()));
  assert.equal(job.file.target_resume_id, done.items[0].resume_id);
  await publishQueue(queues.results, { version: 1, job_id: job.job_id, batch_id: job.batch_id, item_id: job.item_id,
    attempt: job.attempt, status: "completed", candidate: {}, analysis }, job.job_id);
  publisher.ack(message);
  await waitFor(() => request<ResumeImportDetail>(`/resume-imports/${retryBatch.id}`), d => d.processed_files === 1, "Re-evaluation not applied");
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM candidates")).rows[0].n, 3, "Re-evaluation created another candidate");
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM profile_ratings")).rows[0].n, 3);
  const { reconcilePendingResumes } = await import("../apps/backend/src/imports.js");
  await pool.query("UPDATE resumes SET scoring_status='pending',updated_at=now() WHERE id=$1", [done.items[0].resume_id]);
  await reconcilePendingResumes(); await reconcilePendingResumes();
  await waitFor(() => publisher.checkQueue(queues.analysis), q => q.messageCount === 1, "Legacy pending resume was not reconciled exactly once");
  message = await publisher.get(queues.analysis, { noAck: false }); assert.ok(message);
  job = analysisJobSchema.parse(JSON.parse(message.content.toString())); batchIds.push(job.batch_id);
  await publishQueue(queues.results, { version: 1, job_id: job.job_id, batch_id: job.batch_id, item_id: job.item_id,
    attempt: 1, status: "completed", candidate: {}, analysis }, job.job_id);
  publisher.ack(message);
  await waitFor(() => request<ResumeImportDetail>(`/resume-imports/${job.batch_id}`), d => d.processed_files === 1, "Reconciled result not applied");
  await request("/internal/resume-results", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" }, 401);
  await request(`/resume-imports/${randomUUID()}`, undefined, 404);
  infected = true;
  const form = new FormData(); form.append("archive", new Blob([Uint8Array.from(zip)]), "infected.zip");
  await request("/resume-imports", { method: "POST", body: form }, 422);
  infected = false;
  await stopStorage();
  const policyUrl = `${process.env.RABBITMQ_MANAGEMENT_URL}/api/policies/${process.env.RABBITMQ_VHOST}/test-reject-storage`;
  const managementAuth = { Authorization: `Basic ${Buffer.from(`${process.env.RABBITMQ_USER}:${process.env.RABBITMQ_PASSWORD}`).toString("base64")}`, "Content-Type": "application/json" };
  let response = await fetch(policyUrl, { method: "PUT", headers: managementAuth, body: JSON.stringify({ pattern: "^hr\\.resume\\.storage$", definition: { "max-length": 0, overflow: "reject-publish" }, priority: 100, "apply-to": "queues" }) });
  assert.equal(response.status, 201);
  await delay(200);
  const recovered = await upload("outbox.txt", strToU8("Recovered file"), false);
  assert.equal(recovered.queued, false, "Rejected publication did not retain an outbox record");
  response = await fetch(policyUrl, { method: "DELETE", headers: managementAuth }); assert.equal(response.status, 204);
  await delay(200); await flushImportOutbox();
  stops.push(startQueueConsumer(queues.storage, storeResume, failStorageJob));
  await waitFor(() => publisher.checkQueue(queues.analysis), q => q.messageCount === 1, "Outbox publication did not recover");
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM candidates")).rows[0].n, 3, "Queue recovery prematurely created a candidate");
  console.log("PASS: ZIP/single -> RabbitMQ -> S3 -> results -> DB; nullable identity, blacklist, duplicates, consumer disconnect, retry, stale result, re-evaluation, legacy reconciliation, URL refresh, antivirus rejection, rejected publish/outbox recovery");
} finally {
  for (const stop of stops) await stop();
  for (const id of batchIds) {
    try { const { manifest } = await readImportLedger(id); for (const item of manifest.items) await deleteFile(item.object_key); } catch { /* Retain diagnostics on infrastructure failure. */ }
  }
  await closeBroker(); await pool.end();
  await new Promise<void>(resolve => server.close(() => resolve()));
  await new Promise<void>(resolve => scanner.close(() => resolve()));
  assert.ok(spoolRoot.includes(process.env.POSTGRES_DB!));
  await rm(spoolRoot, { recursive: true, force: true });
}
