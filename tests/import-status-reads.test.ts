import assert from "node:assert/strict";
import { generateKeyPairSync, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { test, type TestContext } from "node:test";
import { pool } from "@hr/data-access";
import { assignJob, newTask, type Task } from "@hr/processing";
import { importDetail, listImportDetails } from "../apps/backend/src/imports.js";
import { evaluationSchema } from "@hr/contracts";

const keys = generateKeyPairSync("rsa", { modulusLength: 2048, privateKeyEncoding: { format: "pem", type: "pkcs8" }, publicKeyEncoding: { format: "pem", type: "spki" } });
delete process.env.AUTHORIZED_JOB_PRIVATE_KEY_FILE;
delete process.env.AUTHORIZED_JOB_PUBLIC_KEY_FILE;
process.env.AUTHORIZED_JOB_PRIVATE_KEY = keys.privateKey;
process.env.AUTHORIZED_JOB_PUBLIC_KEY = keys.publicKey;
process.env.PROCESSING_AMQP_URL = "amqp://fixture:fixture@localhost/hr-authorized";

function database(t: TestContext, tasks: Task[]) {
  const saved = new Map(tasks.map(task => [task.id, { task: structuredClone(task), version: 1 }]));
  const statements: string[] = [];
  const result = (rows: unknown[]) => ({ rows, rowCount: rows.length, fields: [], command: "SELECT", oid: 0 });
  const query = async (sql: string, args: unknown[] = []) => {
    statements.push(sql);
    if (sql.startsWith("SELECT state,version")) {
      const row = saved.get(String(args[0]));
      return result(row ? [{ state: structuredClone(row.task), version: String(row.version) }] : []);
    }
    if (sql.startsWith("SELECT id,state")) return result([...saved.values()].filter(row => row.task.id > String(args[0])).sort((a,b) => a.task.id.localeCompare(b.task.id)).slice(0,100).map(row => ({ id: row.task.id, state: structuredClone(row.task) })));
    assert.fail("Unexpected database operation: " + sql);
  };
  t.mock.method(pool, "query", query as unknown as typeof pool.query);
  const client = { query: async (sql: string, args: unknown[] = []) => {
    statements.push(sql);
    if (sql.startsWith("UPDATE processing_tasks")) {
      const row = saved.get(String(args[0]))!;
      assert.equal(String(row.version), args[2]);
      row.task = JSON.parse(String(args[1])); row.version++;
      return result([{ id: row.task.id }]);
    }
    assert.ok(["BEGIN", "COMMIT", "ROLLBACK"].includes(sql));
    return result([]);
  }, release() {} };
  t.mock.method(pool, "connect", (async () => client) as unknown as typeof pool.connect);
  return { saved, statements };
}

test("reading a completed import repeatedly never rewrites its saved state", async t => {
  const task = newTask("authorized", "shared", "synthetic", []); task.status = "completed";
  const db = database(t, [task]);
  await importDetail(task.id); await importDetail(task.id);
  assert.equal(db.saved.get(task.id)!.version, 1);
  assert.equal(db.statements.length, 2);
  assert.ok(db.statements.every(sql => sql.startsWith("SELECT")));
});

test("import status exposes checkpoint counts without the intermediate evidence or extra writes", async t => {
  const [fixture] = JSON.parse(readFileSync(new URL("./fixtures/evidence-ratings-v2.json", import.meta.url), "utf8"));
  const p = fixture.result.clusters[0].profiles[0], req = fixture.requirements[0].profiles[0];
  const target = {id:p.id, name:req.position_name, education:req.education || "", experience:req.experience || "",
    keywords:req.keywords || [], stop_factors:req.stop_factors || [], comment:""};
  const task = newTask("authorized", "shared", "synthetic", [target, {...target,id:randomUUID()}]);
  task.status = "processing";
  const file = {file_id:randomUUID(),file_name:"synthetic.txt",mime_type:"text/plain",size_bytes:1,sha256:"a".repeat(64),key:"synthetic"};
  task.files = [file]; task.source_ids = [file.file_id]; assignJob(task,file,"evaluate");
  const checkpoint = evaluationSchema.parse({target_id:p.id,score:p.score,details:p.details,
    criteria:["education","experience","keywords"].map(name=>({name,status:"unknown",explanation:"Synthetic"})),
    matched_keywords:p.matched_keywords || [],triggered_stop_factors:p.triggered_stop_factors || [],explanation:p.explanation || ""});
  task.jobs[0].evaluation_checkpoints = {context:"b".repeat(64),evaluations:[checkpoint]};
  const db = database(t,[task]);
  const result = await importDetail(task.id);
  assert.deepEqual(result.items[0].profile_progress,{completed:1,total:2});
  assert.equal("evaluation_checkpoints" in result.items[0],false);
  assert.equal("details" in result.items[0],false);
  assert.equal(db.saved.get(task.id)!.version,1);
  assert.ok(db.statements.every(sql=>sql.startsWith("SELECT")));
});

test("listing 125 completed imports uses paged reads rather than a read and UPDATE per record", async t => {
  const tasks = Array.from({ length: 125 }, () => { const task = newTask("authorized", "shared", "synthetic", []); task.status = "completed"; return task; });
  const db = database(t, tasks);
  assert.equal((await listImportDetails()).length, 125);
  assert.equal(db.statements.length, 3);
  assert.ok(db.statements.every(sql => sql.startsWith("SELECT id,state")));
});

test("an expired import still records its timeout once, and subsequent status reads are read-only", async t => {
  const task = newTask("authorized", "shared", "synthetic", [], Date.now() - 4000000);
  task.status = "queued";
  const file = { file_id: randomUUID(), file_name: "synthetic.txt", mime_type: "text/plain", size_bytes: 1, sha256: "a".repeat(64), key: "synthetic" };
  task.files = [file]; task.source_ids = [file.file_id]; assignJob(task, file, "evaluate");
  const db = database(t, [task]);
  assert.equal((await importDetail(task.id)).items[0].status, "failed");
  const saved = db.saved.get(task.id)!;
  assert.equal(saved.task.jobs[0].result?.status, "failed");
  assert.equal(saved.version, 2);
  await importDetail(task.id);
  assert.equal(db.saved.get(task.id)!.version, 2);
  assert.equal(db.statements.filter(sql => sql.startsWith("UPDATE processing_tasks")).length, 1);
});
