// Fresh database/vhost and uniquely named S3 objects; no user records are changed.
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { readdir, readFile } from "node:fs/promises";
import { importManifestSchema, importResultSchema, type ContactProvenance, type ContactRecoveryPreview } from "@hr/contracts";
import { contactResult } from "./fixtures/contact-result.js";

const { Client } = createRequire(new URL("../packages/data-access/package.json", import.meta.url))("pg");
const resource = "hr_dam_contacts_test_" + randomUUID().replaceAll("-", "");
const user = process.env.RABBITMQ_USER || "hr_dam", password = process.env.RABBITMQ_PASSWORD || "";
const admin = new Client({ host: process.env.PGHOST || "postgres", port: Number(process.env.POSTGRES_PORT || 5432),
  database: process.env.POSTGRES_DB, user: process.env.POSTGRES_USER, password: process.env.POSTGRES_PASSWORD });
async function rabbit(method: string, path: string, body?: unknown) {
  const response = await fetch((process.env.RABBITMQ_MANAGEMENT_URL || "http://rabbitmq:15672") + "/api/" + path, {
    method, headers: { Authorization: "Basic " + Buffer.from(user + ":" + password).toString("base64"), "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  assert.ok(response.ok, `RabbitMQ setup: HTTP ${response.status}`);
}
const fixtures = new Map<string, ReturnType<typeof contactResult>>();
let rankCalls = 0, contactCalls = 0;
let duringExtraction: (() => Promise<void>) | undefined;
const analyzer = createServer((req, res) => { void (async () => {
  const reply = (status: number, data: unknown) => { res.writeHead(status, { "Content-Type": "application/json" }); res.end(JSON.stringify(data)); };
  if (req.url === "/ready") { reply(200, { available: true }); return; }
  if (req.url !== "/contacts" && req.url !== "/rank") { reply(404, {}); return; }
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.from(chunk));
  const request = new Request("http://fixture" + req.url, { method: "POST", headers: {
    "Content-Type": req.headers["content-type"]! }, body: new Uint8Array(Buffer.concat(chunks)) });
  const form = await request.formData(), file = form.get("file") as File;
  const result = fixtures.get(await file.text());
  assert.ok(result, "original document bytes must reach the analyzer");
  if (req.url === "/contacts") {
    contactCalls++;
    assert.deepEqual([...form.keys()], ["file"]);
    const action = duringExtraction; duringExtraction = undefined;
    await action?.();
    reply(200, result);
  } else {
    rankCalls++;
    const requirements = JSON.parse(String(form.get("requirements")));
    reply(200, { ...result, clusters: requirements.clusters.map((c: { id: string; profiles: { id: string }[] }) => ({
      id: c.id, profiles: c.profiles.map(p => ({ id: p.id, score: 73, explanation: "Fixture" })),
    })) });
  }
})().catch(error => { console.error(error); res.destroy(); }); });
await new Promise<void>(resolve => analyzer.listen(0, "127.0.0.1", resolve));
const analyzerBase = `http://127.0.0.1:${(analyzer.address() as { port: number }).port}`;
process.env.RESUME_ANALYZER_URL = analyzerBase + "/rank";
process.env.RESUME_ANALYZER_CONTACTS_URL = analyzerBase + "/contacts";
process.env.RESUME_ANALYZER_READY_URL = analyzerBase + "/ready";
process.env.POSTGRES_DB = resource;
process.env.RABBITMQ_VHOST = resource;
process.env.RABBITMQ_ENABLED = "true";
process.env.ANALYZER_ADAPTER = "http";
process.env.RANK_BRIDGE_ENABLED = "true";
process.env.RABBITMQ_URL = `amqp://${encodeURIComponent(user)}:${encodeURIComponent(password)}@${process.env.RABBITMQ_HOST || "rabbitmq"}:5672/${resource}`;
let databaseCreated = false, vhostCreated = false;
let cleanup = async () => {};
await admin.connect();
try {
  await admin.query(`CREATE DATABASE "${resource}"`); databaseCreated = true;
  await rabbit("PUT", "vhosts/" + resource, {}); vhostCreated = true;
  await rabbit("PUT", "permissions/" + resource + "/" + encodeURIComponent(user), { configure: ".*", write: ".*", read: ".*" });
  const data = await import("@hr/data-access");
  const { previewResumeContacts, recoverResumeContacts } = await import("../apps/backend/src/contact-recovery.js");
  const { processImportResult } = await import("../apps/backend/src/import-results.js");
  const { rankQueuedResume } = await import("../apps/worker/src/rank-bridge.js");
  const { app } = await import("../apps/backend/src/app.js");
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>(resolve => server.once("listening", resolve));
  const api = `http://127.0.0.1:${(server.address() as { port: number }).port}/api`;
  const keys: string[] = [];
  cleanup = async () => {
    server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
    try { for (const key of keys) await data.deleteFile(key); }
    finally { await data.closeBroker(); await data.pool.end(); }
  };
  for (const migration of (await readdir(new URL("../db/migrations/", import.meta.url))).filter(f => /^V\d+__.*\.sql$/.test(f)).sort())
    await data.pool.query(await readFile(new URL("../db/migrations/" + migration, import.meta.url), "utf8"));
  const clusterId = randomUUID(), profileId = randomUUID();
  await data.pool.query("INSERT INTO clusters(id,name,track) VALUES($1,'Contacts test','test')", [clusterId]);
  await data.pool.query("INSERT INTO profiles(id,cluster_id,position_name) VALUES($1,$2,'Analyst')", [profileId, clusterId]);
  const requirements = [{ id: clusterId, name: "Contacts test", track: "test", profiles: [{ id: profileId, cluster_id: clusterId, position_name: "Analyst" }] }];
  async function store(result: ReturnType<typeof contactResult>) {
    const id = randomUUID(), key = `${resource}/${id}.txt`;
    const content = Buffer.from(Object.values(result.candidate).filter(Boolean).join(" ") + "\n" + id);
    fixtures.set(content.toString(), result); keys.push(key);
    await data.putFile(key, content, "text/plain");
    const file = { id: randomUUID(), file_id: id, source_path: id + ".txt", file_name: id + ".txt", mime_type: "text/plain",
      size_bytes: content.length, sha256: createHash("sha256").update(content).digest("hex"), bucket: data.config.bucket,
      object_key: key, candidate_hint: {} };
    return file;
  }
  async function seed(current: Partial<ReturnType<typeof contactResult>["candidate"]>, result: ReturnType<typeof contactResult>, provenance: ContactProvenance = {}) {
    const file = await store(result), candidateId = randomUUID(), resumeId = randomUUID();
    await data.pool.query(`INSERT INTO candidates(id,last_name,first_name,middle_name,phone,contact_provenance,created_at,updated_at)
      VALUES($1,$2,$3,$4,$5,$6,now(),now())`, [candidateId, current.last_name ?? null, current.first_name ?? null, current.middle_name ?? null, current.phone ?? null, JSON.stringify(provenance)]);
    await data.pool.query(`INSERT INTO files(id,bucket,object_key,file_name,mime_type,size_bytes,file_sha256,created_at) VALUES($1,$2,$3,$4,$5,$6,$7,now())`,
      [file.file_id, file.bucket, file.object_key, file.file_name, file.mime_type, file.size_bytes, file.sha256]);
    await data.pool.query(`INSERT INTO resumes(id,candidate_id,file_id,status,scoring_status,created_at,updated_at)
      VALUES($1,$2,$3,'in_work','completed',now(),now())`, [resumeId, candidateId, file.file_id]);
    await data.pool.query(`INSERT INTO profile_ratings(id,resume_id,profile_id,score,explanation,calculated_at) VALUES($1,$2,$3,71,'Untouched',now())`,
      [randomUUID(), resumeId, profileId]);
    return { file, candidateId, resumeId };
  }
  const candidate = async (id: string) => (await data.pool.query("SELECT * FROM candidates WHERE id=$1", [id])).rows[0];
  const scoring = async (id: string) => (await data.pool.query(`SELECT to_jsonb(p) AS rating,r.updated_at::text AS lease,r.scoring_status
    FROM profile_ratings p JOIN resumes r ON r.id=p.resume_id WHERE r.id=$1`, [id])).rows;
  const expected = contactResult({ last_name: "Румянцева", first_name: "Дарья", middle_name: "Константиновна", phone: "+79991234561" });
  const legacy = await seed({ last_name: "Румянцева", first_name: "Дарья" }, expected);
  const before = await scoring(legacy.resumeId);
  const previewResponse = await fetch(`${api}/resumes/${legacy.resumeId}/contacts/preview`, { method: "POST" });
  assert.equal(previewResponse.status, 200);
  const preview = await previewResponse.json() as ContactRecoveryPreview;
  assert.deepEqual(preview.changes.map(c => c.field), ["middle_name", "phone"]);
  const applyResponse = await fetch(`${api}/resumes/${legacy.resumeId}/contacts/recover`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ revision: preview.revision }) });
  assert.equal(applyResponse.status, 200);
  assert.equal((await candidate(legacy.candidateId)).middle_name, "Константиновна");
  assert.deepEqual(await scoring(legacy.resumeId), before);
  assert.equal((await data.pool.query("SELECT * FROM resume_events WHERE resume_id=$1 AND event_type='contacts_recovered'", [legacy.resumeId])).rowCount, 1);
  await assert.rejects(recoverResumeContacts(legacy.resumeId, preview.revision), (e: unknown) => (e as { status: number }).status === 409);
  console.log("Legacy missing contacts recovered through API; ratings and scoring lease untouched; stale replay rejected");

  const manual = await seed({ last_name: "Иванова", first_name: "Анна", phone: "+79991234562" }, expected);
  const manualPreview = await previewResumeContacts(manual.resumeId);
  assert.equal(manualPreview.changes.length, 0);
  await recoverResumeContacts(manual.resumeId, manualPreview.revision);
  assert.equal((await candidate(manual.candidateId)).phone, "+79991234562");
  assert.equal((await candidate(manual.candidateId)).middle_name, null);
  console.log("Conflicting legacy/manual identity protected, including empty fields");

  const automaticResult = contactResult({ last_name: "Смирнова", first_name: "Ольга", middle_name: "Сергеевна" });
  const automatic = await seed({ ...automaticResult.candidate, middle_name: "Петровна" }, automaticResult,
    { middle_name: { source: "resume_text", value: "Петровна" } });
  const autoPreview = await previewResumeContacts(automatic.resumeId);
  assert.equal(autoPreview.changes.length, 1);
  await recoverResumeContacts(automatic.resumeId, autoPreview.revision);
  assert.equal((await candidate(automatic.candidateId)).middle_name, "Сергеевна");
  console.log("Known automatic value corrected with new provenance");

  const concurrentResult = contactResult({ last_name: "Петрова", first_name: "Елена", middle_name: "Ивановна" });
  const concurrent = await seed({ last_name: "Петрова", first_name: "Елена" }, concurrentResult);
  const concurrentPreview = await previewResumeContacts(concurrent.resumeId);
  duringExtraction = async () => { await data.pool.query("UPDATE candidates SET middle_name='Павловна' WHERE id=$1", [concurrent.candidateId]); };
  await assert.rejects(recoverResumeContacts(concurrent.resumeId, concurrentPreview.revision), (e: unknown) => (e as { status: number }).status === 409);
  assert.equal((await candidate(concurrent.candidateId)).middle_name, "Павловна");
  console.log("Concurrent manual edit during extraction wins over recovery");

  const duplicate = await seed({}, expected), duplicatePreview = await previewResumeContacts(duplicate.resumeId);
  await assert.rejects(recoverResumeContacts(duplicate.resumeId, duplicatePreview.revision), (e: unknown) => (e as { status: number }).status === 409);
  assert.equal((await candidate(duplicate.candidateId)).phone, null);
  console.log("Identity collision rolls back all contact changes");

  const absent = contactResult({});
  absent.contact_details.phone_status = "unsupported";
  absent.contact_details.text_status = "present";
  absent.contact_details.warnings = ["Формат телефона не поддерживается."];
  const noContact = await seed({}, absent), noContactPreview = await previewResumeContacts(noContact.resumeId);
  assert.equal(noContactPreview.changes.length, 0);
  assert.equal(noContactPreview.contact_details.phone_status, "unsupported");
  assert.equal(rankCalls, 0);
  console.log("Unsupported/missing contact data surfaced; all recovery operations made zero scoring calls");

  async function manifestFor(file: Awaited<ReturnType<typeof store>>, target?: Awaited<ReturnType<typeof seed>>) {
    const batchId = randomUUID(), jobId = randomUUID();
    const item = target ? { ...file, target_resume_id: target.resumeId,
      target_updated_at: (await data.pool.query("SELECT updated_at::text AS lease FROM resumes WHERE id=$1", [target.resumeId])).rows[0].lease,
      candidate_hint: await candidate(target.candidateId) } : file;
    const manifest = importManifestSchema.parse({ version: 1, id: batchId, archive_name: file.file_name, created_at: new Date().toISOString(),
      requirements, ignored_files: [], items: [item] });
    await data.publishQueue(data.batchQueue(batchId), { kind: "manifest", manifest }, batchId);
    const identity = { version: 1 as const, job_id: jobId, batch_id: batchId, item_id: file.id, attempt: 1 };
    await data.publishImportEvent({ ...identity, stage: "pending", created_at: new Date().toISOString() });
    return { ...identity, file: manifest.items[0], requirements: manifest.requirements };
  }
  const reScoreResult = contactResult({ last_name: "Москаленко", first_name: "Иван", middle_name: "Петрович", phone: "+79991234563" });
  const target = await seed({ last_name: "Москаленко", first_name: "Иван" }, reScoreResult,
    { last_name: { source: "manual", value: "Москаленко" }, first_name: { source: "manual", value: "Иван" } });
  const job = await manifestFor(target.file, target);
  await processImportResult({ version: 1, job_id: job.job_id, batch_id: job.batch_id, item_id: job.item_id, attempt: 1,
    status: "completed", ...reScoreResult, analysis: { clusters: [{ id: clusterId, profiles: [{ id: profileId, score: 73 }] }] } });
  assert.equal((await candidate(target.candidateId)).middle_name, "Петрович");
  assert.equal((await candidate(target.candidateId)).contact_provenance.first_name.source, "manual");
  console.log("Regular re-scoring fills missing contacts while preserving manual fields and ignoring legacy snapshots");

  const httpContacts = contactResult({ last_name: "Соколова", first_name: "Мария", phone: "+79991234564" });
  const bridgeFile = await store(httpContacts), bridgeJob = await manifestFor(bridgeFile);
  await rankQueuedResume({ ...bridgeJob, file: { ...bridgeJob.file, download_url: "http://fixture/resume", download_url_expires_at: new Date(Date.now() + 3600000).toISOString() } });
  const { publisher } = await data.connectBroker();
  const message = await publisher.get(data.queues.results, { noAck: false });
  assert.ok(message);
  const result = importResultSchema.parse(JSON.parse(message.content.toString()));
  assert.equal(result.status, "completed");
  if (result.status === "completed") { assert.deepEqual(result.candidate, httpContacts.candidate); assert.deepEqual(result.contact_details, httpContacts.contact_details); }
  await processImportResult(result); publisher.ack(message);
  const bridgeSaved = (await data.pool.query("SELECT c.* FROM candidates c JOIN resumes r ON c.id=r.candidate_id WHERE r.file_id=$1", [bridgeFile.file_id])).rows[0];
  assert.equal(bridgeSaved.first_name, "Мария");
  assert.equal(bridgeSaved.middle_name, null);
  assert.equal(bridgeSaved.contact_provenance.phone.source, "resume_text");
  assert.equal(rankCalls, 1); assert.ok(contactCalls > 0);
  console.log("HTTP bridge forwards extracted contacts and provenance through RabbitMQ into DB");
} finally {
  await cleanup();
  analyzer.closeAllConnections(); await new Promise<void>(resolve => analyzer.close(() => resolve()));
  if (vhostCreated) await rabbit("DELETE", "vhosts/" + resource);
  if (databaseCreated) await admin.query(`DROP DATABASE "${resource}" WITH (FORCE)`);
  await admin.end();
}
