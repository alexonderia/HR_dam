// Uses a fresh database and vhost, then removes only those test resources.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { readdir, readFile } from "node:fs/promises";
import { importManifestSchema } from "@hr/contracts";

const { Client } = createRequire(new URL("../packages/data-access/package.json", import.meta.url))("pg");
const resourceName = "hr_dam_evidence_test_" + randomUUID().replaceAll("-", "");
const user = process.env.RABBITMQ_USER || "hr_dam";
const password = process.env.RABBITMQ_PASSWORD || "";
const management = process.env.RABBITMQ_MANAGEMENT_URL || "http://rabbitmq:15672";
const admin = new Client({ host: process.env.PGHOST || "postgres", port: Number(process.env.POSTGRES_PORT || 5432),
  database: process.env.POSTGRES_DB, user: process.env.POSTGRES_USER, password: process.env.POSTGRES_PASSWORD });
const rabbit = async (method: string, path: string, body?: unknown) => {
  const result = await fetch(management + "/api/" + path, { method, headers: {
    Authorization: "Basic " + Buffer.from(user + ":" + password).toString("base64"), "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body) });
  if (!result.ok) throw new Error(`Isolated RabbitMQ setup failed: HTTP ${result.status}`);
};

let databaseCreated = false, vhostCreated = false;
let cleanup = async () => {};
await admin.connect();
try {
  await admin.query(`CREATE DATABASE "${resourceName}"`);
  databaseCreated = true;
  await rabbit("PUT", "vhosts/" + resourceName, {});
  vhostCreated = true;
  await rabbit("PUT", "permissions/" + resourceName + "/" + encodeURIComponent(user), { configure: ".*", write: ".*", read: ".*" });
  process.env.POSTGRES_DB = resourceName;
  process.env.RABBITMQ_VHOST = resourceName;
  process.env.RABBITMQ_ENABLED = "true";
  process.env.RABBITMQ_URL = `amqp://${encodeURIComponent(user)}:${encodeURIComponent(password)}@${process.env.RABBITMQ_HOST || "rabbitmq"}:5672/${resourceName}`;
  const { pool, publishQueue, publishImportEvent, batchQueue, closeBroker, getImportJobState, PermanentQueueError } = await import("@hr/data-access");
  cleanup = async () => { await closeBroker(); await pool.end(); };
  const { processImportResult, failImportResult } = await import("../apps/backend/src/import-results.js");
  for (const migration of (await readdir(new URL("../db/migrations/", import.meta.url))).filter(f => /^V\d+__.*\.sql$/u.test(f)).sort())
    await pool.query(await readFile(new URL("../db/migrations/" + migration, import.meta.url), "utf8"));
  const cases = JSON.parse(await readFile(new URL("./fixtures/evidence-ratings.json", import.meta.url), "utf8"));
  const invalid = structuredClone(cases[0]);
  invalid.name = "invalid_proof_rejected";
  invalid.result.clusters[0].profiles[0].score = 99;
  cases.push(invalid);
  for (const fixture of cases) {
    const cluster = fixture.requirements[0], profile = cluster.profiles[0];
    await pool.query("INSERT INTO clusters(id,name,track,is_active,comment) VALUES($1,'Synthetic','test',true,'') ON CONFLICT(id) DO NOTHING", [cluster.id]);
    await pool.query(`INSERT INTO profiles(id,cluster_id,position_name,education,experience,keywords,stop_factors,comment,is_active)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,true) ON CONFLICT(id) DO UPDATE SET education=$4,experience=$5,keywords=$6,stop_factors=$7,comment=$8`,
      [profile.id, cluster.id, profile.position_name, profile.education || "", profile.experience || "", profile.keywords, profile.stop_factors, profile.comment || ""]);
    const batchId = randomUUID(), itemId = randomUUID(), fileId = randomUUID(), jobId = randomUUID();
    const manifest = importManifestSchema.parse({ version: 1, id: batchId, archive_name: fixture.name + ".pdf", created_at: new Date().toISOString(),
      requirements: [{ ...cluster, name: "Synthetic", track: "test", is_active: true, comment: "", profiles: [{ ...profile, education: profile.education || "", experience: profile.experience || "", comment: profile.comment || "", cluster_id: cluster.id, is_active: true }] }],
      ignored_files: [], items: [{ id: itemId, file_id: fileId, source_path: fixture.name + ".pdf", file_name: fixture.name + ".pdf", mime_type: "application/pdf",
        size_bytes: 100, sha256: "a".repeat(64), bucket: "synthetic-test-only", object_key: fixture.name, candidate_hint: {} }] });
    const identity = { version: 1 as const, job_id: jobId, batch_id: batchId, item_id: itemId, attempt: 1 };
    await publishQueue(batchQueue(batchId), { kind: "manifest", manifest }, batchId);
    await publishImportEvent({ ...identity, stage: "pending", created_at: new Date().toISOString() });
    const incoming = { ...identity, status: "completed", candidate: {}, analysis: fixture.result };
    if (fixture.name === "invalid_proof_rejected") {
      await assert.rejects(processImportResult(incoming), error => error instanceof PermanentQueueError);
      await failImportResult(incoming, new PermanentQueueError("Invalid evidence test"));
      assert.deepEqual(await getImportJobState(identity), { status: "failed", should_process: false });
      assert.equal((await pool.query("SELECT id FROM files WHERE id=$1", [fileId])).rowCount, 0);
      console.log(fixture.name + ": permanent failure recorded without saving ratings");
      continue;
    }
    await processImportResult(incoming);
    assert.deepEqual(await getImportJobState(identity), { status: "completed", should_process: false });
    const saved = await pool.query("SELECT p.*,r.scoring_status FROM profile_ratings p JOIN resumes r ON r.id=p.resume_id WHERE r.file_id=$1", [fileId]);
    assert.equal(saved.rowCount, 1);
    assert.equal(saved.rows[0].scoring_status, "completed");
    assert.equal(saved.rows[0].details.policy_version, "evidence-v1");
    assert.equal(Number(saved.rows[0].score), fixture.result.clusters[0].profiles[0].score);
    assert.deepEqual(saved.rows[0].matched_keywords, fixture.result.clusters[0].profiles[0].matched_keywords);
    console.log(fixture.name + ": correlated result persisted and retry suppressed");
  }
} finally {
  await cleanup();
  if (vhostCreated) await rabbit("DELETE", "vhosts/" + resourceName);
  if (databaseCreated) await admin.query(`DROP DATABASE "${resourceName}" WITH (FORCE)`);
  await admin.end();
}
