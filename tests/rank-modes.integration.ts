import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createServer as createScanner } from "node:net";
import { createServer } from "node:http";
import { readFile, rm } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { zipSync, strToU8 } from "fflate";
import type { ResumeImportDetail, Candidate, Cluster } from "@hr/contracts";

assert.match(process.env.POSTGRES_DB || "", /^hr_dam_queue_test_[a-f0-9]+$/);
const batches: string[] = [], stops: (() => Promise<void>)[] = [];
let ready = false, rankCalls = 0, rejectNext = false;
let held: (() => void) | undefined;
const analyzer = createServer(async (req, res) => {
  const reply = (status: number, data: unknown) => { res.writeHead(status, { "Content-Type": "application/json" }); res.end(JSON.stringify(data)); };
  if (req.url === "/ready") { reply(ready ? 200 : 503, { available: ready }); return; }
  if (req.url !== "/rank" || req.method !== "POST") { reply(404, {}); return; }
  rankCalls++;
  if (rejectNext) { rejectNext = false; reply(422, { error: "Test document error" }); return; }
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.from(chunk));
  const request = new Request("http://fixture/rank", { method: "POST", headers: { "Content-Type": req.headers["content-type"]! }, body: new Uint8Array(Buffer.concat(chunks)) });
  const form = await request.formData();
  const file = form.get("file") as File;
  assert.equal(file.type, "text/plain");
  const text = await file.text();
  assert.match(text, /Python/);
  assert.equal(file.name, "resume.txt");
  const requirements = JSON.parse(String(form.get("requirements"))) as { clusters: Cluster[] };
  assert.equal(requirements.clusters[0].profiles.length, 2);
  if (text.includes("HOLD")) await new Promise<void>(resolve => { held = resolve; });
  reply(200, { clusters: requirements.clusters.map(cluster => ({ id: cluster.id,
    profiles: cluster.profiles.map(profile => ({ id: profile.id, score: 87, explanation: "HTTP fixture", matched_keywords: ["Python"] })) })) });
}).listen(0, "127.0.0.1");
await new Promise<void>(resolve => analyzer.once("listening", resolve));
const analyzerBase = `http://127.0.0.1:${(analyzer.address() as { port: number }).port}`;
process.env.RESUME_ANALYZER_URL = analyzerBase + "/rank";
process.env.RESUME_ANALYZER_READY_URL = analyzerBase + "/ready";
process.env.RESUME_ANALYZER_TIMEOUT_MS = "5000";
process.env.ANALYSIS_RETRY_DELAY_MS = "50";
process.env.ANALYSIS_MAX_RETRIES = "1";
const scanner = createScanner(socket => {
  let data = Buffer.alloc(0);
  socket.on("data", chunk => {
    data = Buffer.concat([data, Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)]);
    if (data.length > 12 && data.subarray(-4).equals(Buffer.alloc(4))) socket.end("stream: OK\0");
  });
}).listen(0, "127.0.0.1");
await new Promise<void>(resolve => scanner.once("listening", resolve));
process.env.CLAMAV_HOST = "127.0.0.1";
process.env.CLAMAV_PORT = String((scanner.address() as { port: number }).port);
const data = await import("@hr/data-access");
const { app } = await import("../apps/backend/src/app.js");
const { startResultConsumers } = await import("../apps/backend/src/import-results.js");
const { storeResume, failStorageJob } = await import("../apps/worker/src/storage.js");
const { startRankBridge } = await import("../apps/worker/src/rank-bridge.js");
const server = app.listen(0, "127.0.0.1");
await new Promise<void>(resolve => server.once("listening", resolve));
const base = `http://127.0.0.1:${(server.address() as { port: number }).port}/api`;
async function api<T>(path: string, init?: RequestInit, expected = 200): Promise<T> {
  const response = await fetch(base + path, init), body = await response.json();
  assert.equal(response.status, expected, JSON.stringify(body)); return body as T;
}
async function waitFor<T>(read: () => Promise<T>, test: (value: T) => boolean, error: string) {
  for (let i = 0; i < 200; i++) { const value = await read(); if (test(value)) return value; await delay(100); }
  throw new Error(error);
}
async function upload(name: string, content: Uint8Array, archive = false, hint: Record<string, string> = {}) {
  const form = new FormData();
  form.append(archive ? "archive" : "resume", new Blob([Uint8Array.from(content)]), name);
  for (const [key, value] of Object.entries(hint)) form.append(key, value);
  const batch = await api<ResumeImportDetail>(archive ? "/resume-imports" : "/candidates", { method: "POST", body: form }, 202);
  batches.push(batch.id); return batch;
}
const detail = (id: string) => api<ResumeImportDetail>(`/resume-imports/${id}`);
try {
  for (const migration of ["V1__initial_schema.sql", "V2__normalized_candidate_identity.sql", "V3__optional_candidate_identity.sql", "V4__analysis_duration.sql"])
    await data.pool.query(await readFile(`db/migrations/${migration}`, "utf8"));
  assert.equal((await data.pool.query("SHOW timezone")).rows[0].TimeZone, "Europe/Moscow");
  const lease = await data.pool.query(`SELECT
    '2026-10-16 10:00:00.123456+00'::timestamptz = '2026-10-16 13:00:00.123456+03'::timestamptz AS same,
    '2026-10-16 10:00:00.123456+00'::timestamptz = '2026-10-16 13:00:00.123457+03'::timestamptz AS different`);
  assert.equal(lease.rows[0].same, true);
  assert.equal(lease.rows[0].different, false);
  const clusterId = randomUUID();
  await data.pool.query("INSERT INTO clusters(id,name,track) VALUES($1,'Test','test')", [clusterId]);
  for (let i = 0; i < 2; i++) await data.pool.query("INSERT INTO profiles(id,cluster_id,position_name) VALUES($1,$2,$3)", [randomUUID(), clusterId, "Profile " + i]);
  await data.ensureProcessingTransport();
  stops.push(startResultConsumers());
  stops.push(data.startQueueConsumer(data.queues.storage, storeResume, failStorageJob));
  let bridge = startRankBridge(); stops.push(bridge);
  const mode = await api<{ mode: string; broker_enabled: boolean }>("/processing/mode");
  assert.equal(mode.broker_enabled, process.env.RABBITMQ_ENABLED === "true");
  assert.equal(mode.mode, data.processingMode);
  const zip = zipSync({ "a.txt": strToU8("Python experience A"), "nested/b.txt": strToU8("Python experience B") });
  const batch = await upload("batch.zip", zip, true);
  await waitFor(() => detail(batch.id), d => d.uploading_files === 0, "Storage did not complete");
  assert.equal(rankCalls, 0, "Rank called while analyzer not ready");
  assert.equal((await data.pool.query("SELECT count(*)::int AS n FROM candidates")).rows[0].n, 0);
  ready = true; await data.getAnalysisStatus(true);
  await waitFor(() => detail(batch.id), d => d.processed_files === 2, "ZIP results not saved through /rank");
  assert.equal((await data.pool.query("SELECT count(*)::int AS n FROM profile_ratings")).rows[0].n, 4);
  assert.equal((await data.pool.query("SELECT count(*)::int AS n FROM candidates WHERE phone IS NULL AND first_name IS NULL")).rows[0].n, 2);

  const single = await upload("single.txt", strToU8("Python manual identity"), false,
    { last_name: "Иванов", first_name: "Иван", phone: "+79991234567" });
  assert.equal(single.items[0].candidate_hint?.phone, "+79991234567");
  assert.match(single.items[0].file_sha256!, /^[a-f0-9]{64}$/);
  await waitFor(() => detail(single.id), d => d.processed_files === 1, "Single result not saved");
  const overview = await api<{ candidates: Candidate[] }>("/overview");
  assert.ok(overview.candidates.some(c => c.phone === "+79991234567" && c.last_name === "Иванов"));
  const existing = overview.candidates.find(c => c.phone === "+79991234567")!;
  assert.match(existing.created_at, /\+03:00$/);
  const rescoring = await api<ResumeImportDetail>(`/resumes/${existing.resume_id}/retry`, { method: "POST" }, 202);
  assert.equal(rescoring.items[0].target_resume_id, existing.resume_id);
  batches.push(rescoring.id);
  await waitFor(() => detail(rescoring.id), d => d.processed_files === 1, "Moscow-time reanalysis lease rejected");
  assert.equal((await api<{ available: boolean }>("/analysis/status")).available, true);

  const slow = await upload("held.txt", strToU8("Python HOLD"));
  await waitFor(() => detail(slow.id), d => d.processing_files === 1, "Processing signal not received");
  assert.ok(held);
  assert.equal((await detail(slow.id)).items[0].analysis_duration_ms, null);
  await delay(250);
  held(); held = undefined;
  const timed = await waitFor(() => detail(slow.id), d => d.processed_files === 1, "Held request not completed");
  const duration = timed.items[0].analysis_duration_ms!;
  assert.ok(duration >= 250 && duration < 5000, `Unexpected analysis duration: ${duration}`);
  const timedCandidate = (await api<{ candidates: Candidate[] }>("/overview")).candidates.find(c => c.resume_id === timed.items[0].resume_id)!;
  assert.equal(timedCandidate.analysis_duration_ms, duration);
  const timedEvents = await api<{ analysis_duration_ms?: number }[]>(`/resumes/${timedCandidate.resume_id}/events`);
  assert.ok(timedEvents.some(event => event.analysis_duration_ms === duration));
  const repeated = await data.pool.query("SELECT id FROM resume_events WHERE resume_id=$1 AND event_type='scored'", [timedCandidate.resume_id]);
  const result = { version: 1, job_id: repeated.rows[0].id, item_id: timed.items[0].id, batch_id: slow.id, attempt: 1,
    status: "completed", candidate: {}, analysis: { clusters: [] }, analysis_duration_ms: duration + 5000 };
  const { processImportResult } = await import("../apps/backend/src/import-results.js");
  await processImportResult(result);
  assert.equal((await detail(slow.id)).items[0].analysis_duration_ms, duration, "Duplicate result changed recorded duration");

  rejectNext = true;
  const failed = await upload("failed.txt", strToU8("Python failure"));
  const error = await waitFor(() => detail(failed.id), d => d.failed_files === 1, "HTTP error not recorded");
  assert.ok(error.items[0].analysis_duration_ms != null && error.items[0].analysis_duration_ms >= 0);
  await api(`/resume-imports/${failed.id}/items/${error.items[0].id}/retry`, { method: "POST" }, 202);
  await waitFor(() => detail(failed.id), d => d.processed_files === 1, "Retry through /rank failed");

  await bridge();
  const delayed = await upload("delayed.txt", strToU8("Python persisted task"));
  await waitFor(() => detail(delayed.id), d => d.uploading_files === 0, "Delayed file not stored");
  assert.equal((await detail(delayed.id)).pending_files, 1);
  bridge = startRankBridge(); stops.push(bridge);
  await waitFor(() => detail(delayed.id), d => d.processed_files === 1, "Persisted task not recovered after consumer restart");
  const stats = await data.getBrokerStatus();
  assert.equal(stats.broker_enabled, data.brokerEnabled);
  assert.equal((await data.pool.query("SELECT count(*)::int AS n FROM candidates")).rows[0].n, 6);
  assert.equal((await data.pool.query("SELECT count(*)::int AS n FROM profile_ratings")).rows[0].n, 12);
  console.log(`PASS: mode=${mode.mode}; ZIP/single -> S3 -> real HTTP multipart /rank -> DB; readiness, null identity, manual hints, processing, failure/retry, restart`);
} finally {
  held?.();
  for (const stop of stops.reverse()) await stop();
  for (const id of batches) {
    try { const { manifest } = await data.readImportLedger(id); for (const file of manifest.items) await data.deleteFile(file.object_key); } catch { /* Keep diagnostics if cleanup cannot reach storage. */ }
  }
  await data.closeBroker(); await data.pool.end();
  await Promise.all([new Promise<void>(resolve => server.close(() => resolve())), new Promise<void>(resolve => scanner.close(() => resolve())), new Promise<void>(resolve => analyzer.close(() => resolve()))]);
  assert.ok(data.spoolRoot.includes(process.env.POSTGRES_DB!));
  await rm(data.spoolRoot, { recursive: true, force: true });
}
