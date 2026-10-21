import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createServer } from "node:net";
import { createServer as createHttpServer } from "node:http";
import { readFile, rm } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { zipSync, strToU8 } from "fflate";
import { analysisJobSchema, type AnalysisJob, type ImportJobState, type ResumeImportDetail, type RequirementUpdates, type RequirementReassessmentResult, type Cluster, type Profile } from "@hr/contracts";
import { pool, connectBroker, closeBroker, startQueueConsumer, publishQueue, queues, readImportLedger, deleteFile,
  stagedFilePath, spoolRoot, flushImportOutbox, restoreClusterAssessmentHistory, analysisConfig, getAnalysisStatus, type config } from "@hr/data-access";

assert.match(process.env.POSTGRES_DB || "", /^hr_dam_queue_test_[a-f0-9]+$/);
assert.equal(process.env.RABBITMQ_VHOST, process.env.POSTGRES_DB);
const batchIds: string[] = [], stops: (() => Promise<void>)[] = [];
let releaseCompletion: (() => void) | undefined;
let infected = false;
let modelReady = false;
const control = createHttpServer((_req, res) => {
  res.writeHead(modelReady ? 200 : 503, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ available: modelReady, adapter: "amqp", alive: true, model_ready: modelReady,
    broker_connected: true, consumer_alive: true, busy: false }));
}).listen(0, "127.0.0.1");
await new Promise<void>(resolve => control.once("listening", resolve));
analysisConfig.readyUrl = `http://127.0.0.1:${(control.address() as { port: number }).port}/ready`;
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
const identity = (job: AnalysisJob) => ({ version: job.version, job_id: job.job_id,
  batch_id: job.batch_id, item_id: job.item_id, attempt: job.attempt });
const jobState = (job: AnalysisJob) => request<ImportJobState>("/internal/resume-jobs/status", {
  method: "POST", headers: { ...auth, "Content-Type": "application/json" }, body: JSON.stringify(identity(job)),
});
async function upload(name: string, content: Uint8Array, archive = true) {
  const form = new FormData();
  form.append(archive ? "archive" : "resume", new Blob([Uint8Array.from(content)]), name);
  const result = await request<ResumeImportDetail & { queued: boolean }>(archive ? "/resume-imports" : "/candidates", { method: "POST", body: form }, 202);
  batchIds.push(result.id); return result;
}
const accepted: AnalysisJob[] = [];
try {
  for (const name of ["V1__initial_schema.sql", "V2__normalized_candidate_identity.sql", "V3__optional_candidate_identity.sql", "V4__analysis_duration.sql", "V5__cluster_assessment_requirements.sql", "V6__contact_provenance.sql"])
    await pool.query(await readFile(`db/migrations/${name}`, "utf8"));
  const cluster = randomUUID(), profile = randomUUID();
  await pool.query("INSERT INTO clusters(id,name,track) VALUES($1,'Integration','test')", [cluster]);
  await pool.query("INSERT INTO profiles(id,cluster_id,position_name) VALUES($1,$2,'Developer')", [profile, cluster]);
  await pool.query("INSERT INTO candidate_blacklist(id,phone,last_name,first_name,company_name) VALUES($1,'+79991234567','Тестов','Иван','Test')", [randomUUID()]);
  await connectBroker();
  const statusConnection = await (await connectBroker()).connection.createChannel();
  const statusConsumer = await statusConnection.consume(queues.analysis, () => {}, { exclusive: true });
  try {
    await getAnalysisStatus(true);
    assert.equal((await request<{ available: boolean }>("/analysis/status")).available, false,
      "A consumer in the queue must not hide an unavailable model");
    modelReady = true; await getAnalysisStatus(true);
    assert.equal((await request<{ available: boolean }>("/analysis/status")).available, true);
  } finally { await statusConnection.cancel(statusConsumer.consumerTag); await statusConnection.close(); }
  stops.push(startResultConsumers());
  const stopStorage = startQueueConsumer(queues.storage, storeResume, failStorageJob);
  stops.push(stopStorage);
  const zip = zipSync({ "nested/a.txt": strToU8("Resume A"), "b.txt": strToU8("Resume B"), "notes.csv": strToU8("ignored") });
  const batch = await upload("resumes.zip", zip);
  assert.equal(batch.total_files, 2);
  assert.equal(batch.ignored_files.length, 1);
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM candidates")).rows[0].n, 0);
  const { publisher } = await connectBroker();
  const send = publisher.sendToQueue.bind(publisher);
  // Hold the blacklist item's final event AFTER its DB transaction commits.
  // Completion and its warning must already be visible from the DB receipt.
  publisher.sendToQueue = (...args: Parameters<typeof send>) => {
    const record = JSON.parse(args[1].toString()) as { kind?: string; event?: { job_id: string; stage: string } };
    if (record.kind === "event" && record.event?.stage === "completed" && record.event.job_id === accepted[1]?.job_id) {
      releaseCompletion = () => { publisher.sendToQueue = send; send(...args); };
      return true;
    }
    return send(...args);
  };
  await waitFor(() => publisher.checkQueue(queues.analysis), q => q.messageCount === 2, "Files did not reach analysis queue");
  const redeliveryChannel = await (await connectBroker()).connection.createChannel();
  const abandoned = await redeliveryChannel.get(queues.analysis, { noAck: false }); assert.ok(abandoned);
  await redeliveryChannel.close();
  await waitFor(() => publisher.checkQueue(queues.analysis), q => q.messageCount === 2, "Unacknowledged job was lost after consumer disconnect");
  for (let i = 0; i < 2; i++) {
    const message = await publisher.get(queues.analysis, { noAck: false }); assert.ok(message);
    const job = analysisJobSchema.parse(JSON.parse(message.content.toString())); accepted.push(job);
    assert.deepEqual(await jobState(job), { status: "pending", should_process: true });
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
  assert.ok(releaseCompletion, "The completed event was not delayed");
  assert.deepEqual(await jobState(accepted[1]), { status: "completed", should_process: false });
  await storeResume(accepted[1]);
  assert.equal((await publisher.checkQueue(queues.analysis)).messageCount, 0, "Completed storage redelivery enqueued another analysis");
  releaseCompletion(); releaseCompletion = undefined;
  await request("/internal/resume-jobs/status", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(identity(accepted[0])) }, 401);
  await request("/internal/resume-jobs/status", { method: "POST", headers: { ...auth, "Content-Type": "application/json" }, body: "{}" }, 422);
  await request("/internal/resume-jobs/status", { method: "POST", headers: { ...auth, "Content-Type": "application/json" },
    body: JSON.stringify({ ...identity(accepted[0]), item_id: randomUUID() }) }, 404);

  let infrastructureRecovered = false, infrastructureFailures = 0, exhaustedFailures = 0;
  const infrastructureProbe = { probe: randomUUID() };
  const stopRecovery = startQueueConsumer(queues.analysis, async body => {
    assert.deepEqual(body, infrastructureProbe);
    if (++infrastructureFailures <= 7) throw Object.assign(new Error("Database restarting"), { code: "57P03" });
    infrastructureRecovered = true;
  }, async () => { exhaustedFailures++; });
  stops.push(stopRecovery);
  await publishQueue(queues.analysis, infrastructureProbe, infrastructureProbe.probe);
  await waitFor(async () => infrastructureRecovered, value => value, "Infrastructure outage exhausted document retries");
  await stopRecovery();
  assert.equal(infrastructureFailures, 8);
  assert.equal(exhaustedFailures, 0);
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM profile_ratings")).rows[0].n, 2, "Infrastructure recovery changed completed ZIP items");

  const single = await upload("single.txt", strToU8("Single resume"), false);
  await waitFor(() => publisher.checkQueue(queues.analysis), q => q.messageCount === 1, "Single upload bypassed queue");
  let message = await publisher.get(queues.analysis, { noAck: false }); assert.ok(message);
  let job = analysisJobSchema.parse(JSON.parse(message.content.toString()));
  await publishQueue(queues.results, { version: 1, job_id: job.job_id, batch_id: job.batch_id, item_id: job.item_id,
    attempt: job.attempt, status: "failed", error: { code: "UNREADABLE", message: "Test failure" } }, job.job_id);
  publisher.ack(message);
  await waitFor(() => request<ResumeImportDetail>(`/resume-imports/${single.id}`), d => d.failed_files === 1, "Failure was not recorded in RabbitMQ");
  assert.deepEqual(await jobState(job), { status: "failed", should_process: false });
  await request(`/resume-imports/${single.id}/items/${job.item_id}/retry`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" }, 202);
  await waitFor(() => publisher.checkQueue(queues.analysis), q => q.messageCount === 1, "Retry not published");
  message = await publisher.get(queues.analysis, { noAck: false }); assert.ok(message);
  const retried = analysisJobSchema.parse(JSON.parse(message.content.toString()));
  assert.equal(retried.attempt, 2);
  assert.deepEqual(await jobState(job), { status: "superseded", should_process: false });
  assert.deepEqual(await jobState(retried), { status: "pending", should_process: true });
  const analysis = { clusters: [{ id: cluster, profiles: [{ id: profile, score: 75 }] }] };
  await publishQueue(queues.results, { version: 1, job_id: job.job_id, batch_id: job.batch_id, item_id: job.item_id, attempt: 1, status: "completed", candidate: {}, analysis }, job.job_id);
  await publishQueue(queues.results, { version: 1, job_id: retried.job_id, batch_id: retried.batch_id, item_id: retried.item_id, attempt: 2, status: "completed", candidate: {}, analysis }, retried.job_id);
  publisher.ack(message);
  await waitFor(() => request<ResumeImportDetail>(`/resume-imports/${single.id}`), d => d.processed_files === 1, "Retry result not applied");
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM candidates")).rows[0].n, 3);
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM candidates WHERE phone IS NULL")).rows[0].n, 2, "Unknown people were merged");

  const retryResumeId = done.items[0].resume_id;
  for (const status of ["in_process", "historical"]) {
    await pool.query("UPDATE resumes SET status=$2 WHERE id=$1", [retryResumeId, status]);
    const denied = await request<{ error: string }>(`/resumes/${retryResumeId}/retry`, { method: "POST" }, 409);
    assert.match(denied.error, /только.*«В работе»/);
    assert.equal((await pool.query("SELECT scoring_status FROM resumes WHERE id=$1", [retryResumeId])).rows[0].scoring_status, "completed");
    assert.equal((await publisher.checkQueue(queues.analysis)).messageCount, 0, "Rejected retry must not enqueue analysis");
  }
  await pool.query("UPDATE resumes SET status='in_work' WHERE id=$1", [retryResumeId]);
  const retryBatch = await request<ResumeImportDetail>(`/resumes/${retryResumeId}/retry`, { method: "POST" }, 202);
  batchIds.push(retryBatch.id);
  await waitFor(() => publisher.checkQueue(queues.analysis), q => q.messageCount === 1, "Existing resume did not enter RabbitMQ");
  message = await publisher.get(queues.analysis, { noAck: false }); assert.ok(message);
  job = analysisJobSchema.parse(JSON.parse(message.content.toString()));
  assert.equal(job.file.target_resume_id, done.items[0].resume_id);
  assert.deepEqual(await jobState(job), { status: "pending", should_process: true }, "A completed candidate must not suppress a new assessment job");
  await publishQueue(queues.results, { version: 1, job_id: job.job_id, batch_id: job.batch_id, item_id: job.item_id,
    attempt: job.attempt, status: "failed", error: { code: "analysis_failed", message: "Test retry failure" } }, job.job_id);
  publisher.ack(message);
  await waitFor(() => request<ResumeImportDetail>(`/resume-imports/${retryBatch.id}`), d => d.failed_files === 1, "Re-evaluation failure not applied");
  for (const status of ["in_process", "historical"]) {
    await pool.query("UPDATE resumes SET status=$2 WHERE id=$1", [retryResumeId, status]);
    const denied = await request<{ error: string }>(`/resume-imports/${retryBatch.id}/items/${job.item_id}/retry`, { method: "POST" }, 409);
    assert.match(denied.error, /только.*«В работе»/);
    assert.equal((await pool.query("SELECT scoring_status FROM resumes WHERE id=$1", [retryResumeId])).rows[0].scoring_status, "failed");
    assert.equal((await publisher.checkQueue(queues.analysis)).messageCount, 0, "Rejected import retry must not enqueue analysis");
  }
  await pool.query("UPDATE resumes SET status='in_work' WHERE id=$1", [retryResumeId]);
  await request(`/resume-imports/${retryBatch.id}/items/${job.item_id}/retry`, { method: "POST" }, 202);
  await waitFor(() => publisher.checkQueue(queues.analysis), q => q.messageCount === 1, "Failed re-evaluation did not retry");
  message = await publisher.get(queues.analysis, { noAck: false }); assert.ok(message);
  job = analysisJobSchema.parse(JSON.parse(message.content.toString()));
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
  const updates = async () => (await request<{ requirementUpdates: RequirementUpdates }>("/overview")).requirementUpdates;
  const reassess = (ids: string[]) => request<RequirementReassessmentResult>("/requirements/reassessment", {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ cluster_ids: ids }),
  }, 202);
  assert.equal((await updates()).resume_count, 0, "Current requirement snapshots must be fresh");
  const others = (await pool.query("SELECT id FROM resumes WHERE id<>$1 ORDER BY id", [retryResumeId])).rows;
  await pool.query("UPDATE resumes SET status='in_process' WHERE id=$1", [others[0].id]);
  await pool.query("UPDATE resumes SET status='historical' WHERE id=$1", [others[1].id]);
  const jsonPost = (data: unknown, method = "POST"): RequestInit => ({ method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(data) });
  const addedCluster = await request<Cluster>("/clusters", jsonPost({ name: "New cluster", track: "test" }), 201);
  assert.equal((await updates()).resume_count, 0, "Empty clusters do not require analysis");
  const addedProfile = await request<Profile>("/profiles", jsonPost({ cluster_id: addedCluster.id, position_name: "New profile" }), 201);
  assert.equal((await updates()).resume_count, 1, "Only resumes in work are affected");
  assert.deepEqual((await updates()).clusters.map(cluster => cluster.cluster_id), [addedCluster.id]);
  const preserved = (await pool.query("SELECT score,calculated_at FROM profile_ratings WHERE resume_id=$1 AND profile_id=$2", [retryResumeId, profile])).rows[0];
  assert.equal((await reassess([addedCluster.id])).queued_resumes, 1);
  await waitFor(() => publisher.checkQueue(queues.analysis), q => q.messageCount === 1, "Scoped assessment did not queue");
  message = await publisher.get(queues.analysis, { noAck: false }); assert.ok(message);
  job = analysisJobSchema.parse(JSON.parse(message.content.toString())); batchIds.push(job.batch_id);
  assert.deepEqual(job.requirements.map(cluster => cluster.id), [addedCluster.id]);
  assert.deepEqual(job.file.assessment_cluster_ids, [addedCluster.id]);
  assert.equal((await updates()).ready_resume_count, 0, "Notice remains while analysis runs");
  assert.equal((await reassess([addedCluster.id])).queued_resumes, 0, "Repeated clicks must not duplicate pending work");
  await request(`/profiles/${addedProfile.id}`, jsonPost({ ...addedProfile, experience: "Changed during assessment" }, "PUT"));
  await publishQueue(queues.results, { version: 1, job_id: job.job_id, batch_id: job.batch_id, item_id: job.item_id,
    attempt: job.attempt, status: "completed", candidate: {}, analysis: { clusters: [{ id: addedCluster.id, profiles: [{ id: addedProfile.id, score: 88 }] }] } }, job.job_id);
  publisher.ack(message);
  await waitFor(() => request<ResumeImportDetail>(`/resume-imports/${job.batch_id}`), d => d.processed_files === 1, "Scoped result not applied");
  assert.deepEqual((await pool.query("SELECT score,calculated_at FROM profile_ratings WHERE resume_id=$1 AND profile_id=$2", [retryResumeId, profile])).rows[0], preserved, "Other cluster ratings must remain unchanged");
  assert.equal((await updates()).resume_count, 1, "Edits during assessment must remain stale");
  assert.equal((await reassess([addedCluster.id])).queued_resumes, 1);
  await waitFor(() => publisher.checkQueue(queues.analysis), q => q.messageCount === 1, "Updated assessment did not queue");
  message = await publisher.get(queues.analysis, { noAck: false }); assert.ok(message);
  job = analysisJobSchema.parse(JSON.parse(message.content.toString())); batchIds.push(job.batch_id);
  assert.equal(job.requirements[0].profiles[0].experience, "Changed during assessment");
  await publishQueue(queues.results, { version: 1, job_id: job.job_id, batch_id: job.batch_id, item_id: job.item_id,
    attempt: job.attempt, status: "completed", candidate: {}, analysis: { clusters: [{ id: addedCluster.id, profiles: [{ id: addedProfile.id, score: 91 }] }] } }, job.job_id);
  publisher.ack(message);
  await waitFor(() => request<ResumeImportDetail>(`/resume-imports/${job.batch_id}`), d => d.processed_files === 1, "Fresh scoped result not applied");
  assert.equal((await updates()).resume_count, 0, "Notice clears only after current results are saved");
  const savedClusters = (await request<{ clusters: Cluster[] }>("/overview")).clusters;
  const unchangedProfile = savedClusters.find(cluster => cluster.id === addedCluster.id)!.profiles[0];
  await request(`/profiles/${addedProfile.id}`, jsonPost(unchangedProfile, "PUT"));
  assert.equal((await updates()).resume_count, 0, "Saving identical requirements must not invalidate results");
  const originalProfile = savedClusters.find(row => row.id === cluster)!.profiles[0];
  await request(`/profiles/${profile}`, jsonPost({ ...originalProfile, education: "Changed education" }, "PUT"));
  assert.deepEqual((await updates()).clusters.map(row => row.cluster_id), [cluster], "Only the edited cluster needs analysis");
  assert.equal((await reassess([cluster])).queued_resumes, 1);
  await waitFor(() => publisher.checkQueue(queues.analysis), q => q.messageCount === 1, "Edited cluster did not queue");
  message = await publisher.get(queues.analysis, { noAck: false }); assert.ok(message);
  job = analysisJobSchema.parse(JSON.parse(message.content.toString())); batchIds.push(job.batch_id);
  assert.deepEqual(job.requirements.map(row => row.id), [cluster]);
  await failStorageJob(job, new Error("Scoped storage failure"));
  publisher.ack(message);
  await waitFor(() => request<ResumeImportDetail>(`/resume-imports/${job.batch_id}`), d => d.failed_files === 1, "Scoped failure not applied");
  assert.equal((await updates()).ready_resume_count, 1, "Failed assessments remain stale and can be retried");
  assert.equal((await reassess([cluster])).queued_resumes, 1);
  await waitFor(() => publisher.checkQueue(queues.analysis), q => q.messageCount === 1, "Failed scoped assessment did not retry");
  message = await publisher.get(queues.analysis, { noAck: false }); assert.ok(message);
  job = analysisJobSchema.parse(JSON.parse(message.content.toString())); batchIds.push(job.batch_id);
  await publishQueue(queues.results, { version: 1, job_id: job.job_id, batch_id: job.batch_id, item_id: job.item_id,
    attempt: job.attempt, status: "completed", candidate: {}, analysis: { clusters: [{ id: cluster, profiles: [{ id: profile, score: 33 }] }] } }, job.job_id);
  publisher.ack(message);
  await waitFor(() => request<ResumeImportDetail>(`/resume-imports/${job.batch_id}`), d => d.processed_files === 1, "Retried scoped result not applied");
  assert.equal((await updates()).resume_count, 0);
  assert.equal(Number((await pool.query("SELECT score FROM profile_ratings WHERE resume_id=$1 AND profile_id=$2", [retryResumeId, addedProfile.id])).rows[0].score), 91, "Unrelated cluster score must survive edited-cluster assessment");
  await request(`/profiles/${profile}`, jsonPost({ ...originalProfile, education: "Another education change" }, "PUT"));
  await pool.query("DELETE FROM resume_cluster_assessments WHERE resume_id=$1", [retryResumeId]);
  const restoredHistory = await restoreClusterAssessmentHistory();
  assert.equal(restoredHistory.restored, 2, "Legacy inputs must be restored from matching successful jobs");
  assert.equal(restoredHistory.baselined, 0, "Known inputs must not be replaced by current requirements");
  assert.deepEqual((await updates()).clusters.map(row => row.cluster_id), [cluster], "One edited legacy profile must affect exactly one cluster");
  assert.deepEqual(await restoreClusterAssessmentHistory(), { restored: 0, baselined: 0 }, "Restoring history must be idempotent");
  const legacyPerson = randomUUID(), legacyFile = randomUUID(), legacyResume = randomUUID();
  await pool.query("INSERT INTO candidates(id,phone,last_name,first_name,middle_name,created_at,updated_at) VALUES($1,NULL,NULL,NULL,NULL,now(),now())", [legacyPerson]);
  await pool.query(`INSERT INTO files(id,bucket,object_key,file_name,mime_type,size_bytes,created_at)
    VALUES($1,'test',$2,'legacy.txt','text/plain',1,now())`, [legacyFile, `legacy-history/${legacyFile}`]);
  await pool.query(`INSERT INTO resumes(id,candidate_id,file_id,status,scoring_status,created_at,updated_at)
    VALUES($1,$2,$3,'in_work','completed',now(),now())`, [legacyResume, legacyPerson, legacyFile]);
  await pool.query("INSERT INTO profile_ratings(id,resume_id,profile_id,score,calculated_at) VALUES($1,$2,$3,42,now())", [randomUUID(), legacyResume, profile]);
  assert.deepEqual(await restoreClusterAssessmentHistory(), { restored: 0, baselined: 1 }, "Unrecorded legacy results start tracking existing requirements without demanding a new assessment");
  const legacyUpdates = await updates();
  assert.equal(legacyUpdates.clusters.find(row => row.cluster_id === cluster)!.resume_count, 1, "Missing history must not add unchanged legacy results to the edited cluster");
  await pool.query("DELETE FROM profile_ratings WHERE resume_id=$1", [legacyResume]);
  await pool.query("DELETE FROM resumes WHERE id=$1", [legacyResume]);
  await pool.query("DELETE FROM candidates WHERE id=$1", [legacyPerson]);
  await pool.query("DELETE FROM files WHERE id=$1", [legacyFile]);
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
  releaseCompletion?.();
  for (const stop of stops) await stop();
  for (const id of batchIds) {
    try { const { manifest } = await readImportLedger(id); for (const item of manifest.items) await deleteFile(item.object_key); } catch { /* Retain diagnostics on infrastructure failure. */ }
  }
  await closeBroker(); await pool.end();
  await new Promise<void>(resolve => server.close(() => resolve()));
  await new Promise<void>(resolve => scanner.close(() => resolve()));
  control.closeAllConnections(); await new Promise<void>(resolve => control.close(() => resolve()));
  assert.ok(spoolRoot.includes(process.env.POSTGRES_DB!));
  await rm(spoolRoot, { recursive: true, force: true });
}
