import { test } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { contactResult } from "./fixtures/contact-result.js";
import { Readable } from "node:stream";
import { signToken, AccessError } from "@hr/security";
import { ProcessingEngine, newTask, mutateTask, expireWork, type Task, type TaskStore, type Publication, type Job } from "@hr/processing";

test("expired guest uploads become eligible for deletion, including uploads failed by an earlier version", () => {
  const now = Date.now();
  const deadline = new Date(now - 1000).toISOString();
  const fresh = newTask("guest", "synthetic", "Interrupted upload", [], now - 2000);
  fresh.deadline = new Date(now + 1000).toISOString();
  fresh.upload_deadline = deadline;
  const old = { ...structuredClone(fresh), status: "failed" as const, finished_at: deadline };
  const accepted = { ...structuredClone(fresh), status: "queued" as const };

  for (const task of [fresh, old]) {
    expireWork(task, now);
    assert.equal(task.status, "failed");
    assert.equal(task.expires_at, deadline);
    assert.equal(task.deleted_at, deadline);
  }
  expireWork(accepted, now);
  assert.equal(accepted.status, "queued");
  assert.equal(accepted.deleted_at, undefined);
});
import { processingCommandSchema, processingEventSchema, evaluateResultSchema, evaluationSchema } from "@hr/contracts";
import { createAuthCheck } from "../apps/auth-check/src/app.js";

const pair = () => generateKeyPairSync("rsa", { modulusLength: 2048, publicKeyEncoding: { type: "spki", format: "pem" }, privateKeyEncoding: { type: "pkcs8", format: "pem" } });
const keys = pair();
class MemoryStore implements TaskStore {
  values = new Map<string, { task: Task; version: string }>(); reads = 0;
  async create(task: Task) { this.values.set(task.id, { task: structuredClone(task), version: "1" }); }
  async read(id: string) { this.reads++; return structuredClone(this.values.get(id) || null); }
  async replace(task: Task, version: string) {
    const old = this.values.get(task.id); if (old?.version !== version) return false;
    this.values.set(task.id, { task: structuredClone(task), version: String(Number(version) + 1) }); return true;
  }
  async *list() { yield* this.values.keys(); }
}
async function setup(mime = "text/plain", mode: "guest" | "authorized" = "guest") {
  const store = new MemoryStore(), sent: Publication[] = [];
  let failPublish = false;
  const engine = new ProcessingEngine(mode, store, { put: async () => {}, get: async () => Readable.from([]), remove: async () => {} },
    { publish: async message => { if (failPublish) throw new Error("confirm lost"); sent.push(structuredClone(message)); } }, { privateKey: keys.privateKey, publicKey: keys.publicKey });
  const task = newTask(mode, "test-owner", "Synthetic resume", [{ id: randomUUID(), name: "Test target", education: "", experience: "", keywords: ["TypeScript"], stop_factors: [], comment: "" }]);
  const fileId = randomUUID(); task.files = [{ file_id: fileId, file_name: "synthetic.txt", mime_type: mime, size_bytes: 5, sha256: "a".repeat(64), key: "technical/key" }]; task.source_ids = [fileId];
  await store.create(task); await engine.accept(task.id); await engine.event(sent[0].body);
  return { store, engine, task: (await store.read(task.id))!.task, sent, failure: (value: boolean) => { failPublish = value; } };
}
function evaluation(task: Task) {
  return { status: "completed", candidate: { last_name: null, first_name: null, middle_name: null, phone: null }, evaluations: [{ target_id: task.requirements[0].id, score: 80,
    criteria: ["education", "experience", "keywords"].map(name => ({ name, status: "unknown", explanation: "No synthetic evidence" })), matched_keywords: [], triggered_stop_factors: [], explanation: "Synthetic result" }] };
}
async function checkpointCase(mime = "text/plain") {
  const r = await setup(mime);
  const [fixture] = JSON.parse(readFileSync(new URL("./fixtures/evidence-ratings-v2.json", import.meta.url), "utf8"));
  await mutateTask(r.store, r.task.id, task => {
    task.requirements = fixture.requirements.flatMap((c: any) => c.profiles.map((p: any) => ({
      id:p.id, name:p.position_name || "Test", education:p.education || "", experience:p.experience || "",
      keywords:p.keywords || [], stop_factors:p.stop_factors || [], comment:p.comment || "", cluster_comment:c.comment || "",
    })));
  });
  const task = (await r.store.read(r.task.id))!.task;
  const profile = fixture.result.clusters[0].profiles[0];
  const value = evaluationSchema.parse({ ...evaluation(task).evaluations[0], target_id:profile.id,
    score:profile.score, details:profile.details, matched_keywords:profile.matched_keywords || [],
    triggered_stop_factors:profile.triggered_stop_factors || [], explanation:profile.explanation || "" });
  const job = task.jobs[0], auth = await r.engine.authorize(`Bearer ${r.engine.token(job)}`, job.job_id, "progress:write");
  const progress = { job_id:job.job_id, attempt:job.attempt, status:"processing" as const,
    checkpoint:{context:"b".repeat(64), evaluation:value} };
  return {...r, task, job, auth, progress};
}
test("profile checkpoints survive redelivery, retain the first value and do not finish or publish results", async () => {
  const r = await checkpointCase(), before = r.sent.length;
  await r.engine.progress(r.auth.claims, r.progress);
  const changed = structuredClone(r.progress); changed.checkpoint.evaluation.explanation += " Different duplicate";
  await r.engine.progress(r.auth.claims, changed);
  const task = (await r.store.read(r.task.id))!.task;
  assert.deepEqual(task.jobs[0].evaluation_checkpoints?.evaluations, [r.progress.checkpoint.evaluation]);
  assert.deepEqual(r.engine.input(task, task.jobs[0], "/internal").evaluation_checkpoints, task.jobs[0].evaluation_checkpoints);
  assert.equal(task.jobs[0].result, undefined); assert.equal(task.jobs[0].applied, undefined);
  assert.equal(task.status, "processing"); assert.equal(r.sent.length, before);
});
test("checkpoint validation rejects unknown targets, forged scores and evidence-free summaries", async () => {
  const r = await checkpointCase();
  for (const change of [{target_id:randomUUID()}, {score:r.progress.checkpoint.evaluation.score === 99 ? 98 : 99}, {details:undefined}]) {
    const input = structuredClone(r.progress); Object.assign(input.checkpoint.evaluation, change);
    await assert.rejects(r.engine.progress(r.auth.claims, input));
  }
  assert.equal((await r.store.read(r.task.id))!.task.jobs[0].evaluation_checkpoints, undefined);
});
test("checkpoint context changes discard previous reuse and deleted or superseded jobs cannot write", async () => {
  const r = await checkpointCase(); await r.engine.progress(r.auth.claims, r.progress);
  const next = structuredClone(r.progress); next.checkpoint.context = "c".repeat(64);
  await r.engine.progress(r.auth.claims, next);
  assert.equal((await r.store.read(r.task.id))!.task.jobs[0].evaluation_checkpoints?.context, next.checkpoint.context);
  await mutateTask(r.store, r.task.id, task => { task.jobs[0].attempt++; });
  await assert.rejects(r.engine.progress(r.auth.claims, next), (e: unknown) => e instanceof AccessError && e.status === 409);
  const deleted = await checkpointCase();
  await mutateTask(deleted.store, deleted.task.id, task => { task.deleted_at = new Date().toISOString(); });
  await assert.rejects(deleted.engine.progress(deleted.auth.claims, deleted.progress), (e: unknown) => e instanceof AccessError && e.status === 410);
  const parser = await checkpointCase("application/pdf");
  await assert.rejects(parser.engine.progress(parser.auth.claims, parser.progress), (e: unknown) => e instanceof AccessError && e.status === 403);
});
test("checkpoints never permit incomplete final results and are removed once the complete result is durable", async () => {
  const r = await checkpointCase(); await r.engine.progress(r.auth.claims, r.progress);
  await mutateTask(r.store, r.task.id, task => { task.requirements.push({...task.requirements[0], id:randomUUID()}); });
  const result = {...evaluation(r.task), evaluations:[r.progress.checkpoint.evaluation]};
  await assert.rejects(r.engine.result(r.auth.claims, result), (e: unknown) => e instanceof AccessError && e.status === 422);
  await mutateTask(r.store, r.task.id, task => { task.requirements.pop(); });
  await r.engine.result(r.auth.claims, result);
  const saved = (await r.store.read(r.task.id))!.task.jobs[0];
  assert.ok(saved.result); assert.equal(saved.evaluation_checkpoints, undefined);
  await assert.rejects(r.engine.progress(r.auth.claims, r.progress), (e: unknown) => e instanceof AccessError && e.status === 409);
});
test("processing messages accept the current contract and reject extra fields and malformed criteria", () => {
  const identity = { task_id: randomUUID(), mode: "guest", deadline: new Date(Date.now() + 60000).toISOString() };
  const command = { ...identity, job_id: randomUUID(), file_id: randomUUID(), operation: "prepare", attempt: 1 };
  const event = { ...identity, event_id: randomUUID(), event_type: "task.accepted" };
  assert.equal(processingCommandSchema.safeParse(command).success, true);
  assert.equal(processingEventSchema.safeParse(event).success, true);
  assert.equal(processingCommandSchema.safeParse({ ...command, url: "http://attacker" }).success, false);
  assert.equal(processingCommandSchema.safeParse({ ...command, schema_version: 2 }).success, false);
  assert.equal(processingEventSchema.safeParse({ ...event, schema_version: 2 }).success, false);
  assert.equal(evaluateResultSchema.safeParse({ status: "completed", candidate: {}, evaluations: [] }).success, false);
});
test("accepted event redelivery preserves stable command IDs and never publishes content", async () => {
  const r = await setup(); await r.engine.event(r.sent[0].body);
  const commands = r.sent.filter(m => m.kind === "command");
  assert.equal(commands.length, 2); assert.deepEqual(commands[0], commands[1]);
  assert.equal((await r.store.read(r.task.id))!.task.jobs.length, 1);
  assert.equal(JSON.stringify(commands).includes("TypeScript"), false);
});
test("lost result confirm retains first result and keeps work processable until confirmed", async () => {
  const r = await setup(), job = r.task.jobs[0];
  const auth = await r.engine.authorize(`Bearer ${r.engine.token(job)}`, job.job_id, "result:write");
  r.failure(true); await assert.rejects(r.engine.result(auth.claims, evaluation(r.task)));
  let saved = (await r.store.read(r.task.id))!.task;
  assert.equal(r.engine.input(saved, saved.jobs[0], "/internal").should_process, true);
  assert.deepEqual(r.engine.input(saved, saved.jobs[0], "/internal").saved_result, evaluation(r.task));
  r.failure(false);
  const changed = evaluation(r.task); changed.evaluations[0].score = 1;
  await r.engine.result(auth.claims, changed);
  saved = (await r.store.read(r.task.id))!.task;
  assert.equal(saved.jobs[0].confirmed, true);
  assert.equal((saved.jobs[0].result as ReturnType<typeof evaluation>).evaluations[0].score, 80);
  await r.engine.event(r.sent.at(-1)!.body);
  assert.equal((await r.store.read(r.task.id))!.task.status, "completed");
});
test("a parser can recover its durable result without uploading outputs again after a lost confirm", async () => {
  const r = await setup("application/pdf"), job = r.task.jobs[0];
  const auth = await r.engine.authorize(`Bearer ${r.engine.token(job)}`, job.job_id, "result:write");
  const result = { status: "completed" as const, files: [{ file_id: job.file_id }], errors: [] };
  r.failure(true);
  await assert.rejects(r.engine.result(auth.claims, result));
  const saved = (await r.store.read(r.task.id))!.task;
  const input = r.engine.input(saved, saved.jobs[0], "/internal");
  assert.equal(input.should_process, true);
  assert.deepEqual(input.saved_result, result);
  r.failure(false);
  await r.engine.result(auth.claims, input.saved_result);
  const confirmed = (await r.store.read(r.task.id))!.task;
  assert.equal(confirmed.jobs[0].confirmed, true);
  assert.deepEqual(confirmed.jobs[0].result, result);
});
test("prepare fan-out is idempotent after publication failure", async () => {
  const r = await setup("application/pdf"), job = r.task.jobs[0];
  const auth = await r.engine.authorize(`Bearer ${r.engine.token(job)}`, job.job_id, "result:write");
  const outputs = [1, 2].map(n => ({ ...r.task.files[0], file_id: randomUUID(), source_file_id: job.file_id, output_key: `resume-${n}`, key: `output/${n}` }));
  for (const output of outputs) await r.engine.registerOutput(auth.claims, output);
  await r.engine.result(auth.claims, { status: "completed", files: outputs.map(f => ({ file_id: f.file_id })), errors: [] });
  const event = r.sent.at(-1)!.body;
  r.failure(true); await assert.rejects(r.engine.event(event));
  r.failure(false); await r.engine.event(event);
  const saved = (await r.store.read(r.task.id))!.task;
  assert.equal(saved.jobs.filter(j => j.operation === "evaluate").length, 2);
  assert.equal(r.sent.filter(m => m.kind === "command" && m.body.operation === "evaluate").length, 2);
});
test("foreign mode keys and evaluate output permission are rejected before storage reads", async () => {
  const r = await setup(), foreign = await setup("text/plain", "authorized"), job = r.task.jobs[0];
  const count = foreign.store.reads;
  await assert.rejects(foreign.engine.authorize(`Bearer ${r.engine.token(job)}`, job.job_id, "input:read"), (e: unknown) => e instanceof AccessError && e.status === 401);
  assert.equal(foreign.store.reads, count);
  const before = r.store.reads;
  await assert.rejects(r.engine.authorize(`Bearer ${r.engine.token(job)}`, job.job_id, "output:write"));
  assert.equal(r.store.reads, before);
});
test("deletion fences concurrent result writes and expiry uses the original deadline", async () => {
  const r = await setup(), job = r.task.jobs[0];
  const auth = await r.engine.authorize(`Bearer ${r.engine.token(job)}`, job.job_id, "result:write");
  await mutateTask(r.store, r.task.id, task => { task.deleted_at = new Date().toISOString(); });
  await assert.rejects(r.engine.result(auth.claims, evaluation(r.task)), (e: unknown) => e instanceof AccessError && e.status === 410);
  const t = newTask("guest", "owner", "test", [], Date.now() - 3600000); t.status = "queued";
  t.deadline = new Date(Date.now() - 1800000).toISOString(); expireWork(t);
  assert.equal(t.finished_at, t.deadline); assert.equal(Date.parse(t.expires_at), Date.parse(t.deadline) + 7200000);
});
test("auth-check enforces policies, rejects forged/expired cookies and clears invalid sessions", async () => {
  const app = createAuthCheck(keys.publicKey, false), server = app.listen(0, "127.0.0.1");
  await new Promise<void>(resolve => server.once("listening", resolve));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const now = Math.floor(Date.now() / 1000);
  const cookie = `hr_session=${signToken({ iss: "hr-auth", aud: "hr-browser", sub: randomUUID(), sid: randomUUID(), name: "Synthetic user", iat: now, exp: now + 900 }, keys.privateKey, "hr-session+jwt")}`;
  try {
    assert.equal((await fetch(`${base}/verify`, { headers: { "X-Access-Policy": "guest" } })).status, 204);
    assert.equal((await fetch(`${base}/verify`, { headers: { "X-Access-Policy": "authorized" } })).status, 401);
    assert.equal((await fetch(`${base}/verify`, { headers: { Cookie: cookie, "X-Access-Policy": "guest" } })).status, 403);
    assert.equal((await fetch(`${base}/verify`, { headers: { Cookie: cookie, "X-Access-Policy": "authorized" } })).status, 204);
    const invalid = await fetch(`${base}/session`, { headers: { Cookie: "hr_session=forged" } });
    assert.equal(invalid.status, 401); assert.match(invalid.headers.get("set-cookie")!, /Max-Age=0/);
    assert.equal((await (await fetch(`${base}/session`)).json()).mode, "guest");
    const expired = `hr_session=${signToken({ iss: "hr-auth", aud: "hr-browser", sub: randomUUID(), sid: randomUUID(), name: "Synthetic user", iat: now - 1000, exp: now - 1 }, keys.privateKey, "hr-session+jwt")}`;
    assert.equal((await fetch(`${base}/verify`, { headers: { Cookie: expired, "X-Access-Policy": "guest" } })).status, 401);
  } finally { await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
});
test("a sibling retry deadline does not discard a valid result from the earlier job", async () => {
  const r = await setup(), job = r.task.jobs[0];
  const auth = await r.engine.authorize(`Bearer ${r.engine.token(job)}`, job.job_id, "result:write");
  await r.engine.result(auth.claims, evaluation(r.task));
  await mutateTask(r.store, r.task.id, task => { task.deadline = new Date(Date.parse(task.deadline) + 60000).toISOString(); });
  await r.engine.event(r.sent.at(-1)!.body);
  assert.equal((await r.store.read(r.task.id))!.task.status, "completed");
});
test("DLQ accounts a confirmed prepare failure without publishing another command", async () => {
  const r = await setup("application/pdf"), job = r.task.jobs[0];
  const auth = await r.engine.authorize(`Bearer ${r.engine.token(job)}`, job.job_id, "result:write");
  await r.engine.result(auth.claims, { status: "failed", error: { code: "INVALID_FILE", message: "Synthetic invalid document" } });
  const before = r.sent.length;
  await r.engine.dead(r.sent.at(-1)!.body);
  assert.equal((await r.store.read(r.task.id))!.task.status, "failed");
  assert.equal(r.sent.length, before);
});
test("the guest absolute TTL does not invalidate an explicit authorized retry days later", () => {
  const t = newTask("authorized", "owner", "test", [], Date.now() - 172800000);
  t.status = "queued"; t.deadline = new Date(Date.now() + 60000).toISOString();
  expireWork(t); assert.equal(t.status, "queued");
});
test("current file, operation and attempt are checked against persisted work", async () => {
  const r = await setup(), job = r.task.jobs[0];
  for (const changed of [{ ...job, file_id: randomUUID() }, { ...job, operation: "prepare" as const }, { ...job, attempt: 2 }]) {
    await assert.rejects(r.engine.authorize(`Bearer ${r.engine.token(changed)}`, job.job_id, "input:read"), (e: unknown) => e instanceof AccessError && e.status === 409);
  }
  const before = r.store.reads;
  const expired = { ...job, deadline: new Date(Date.now() - 60000).toISOString() };
  await assert.rejects(r.engine.authorize(`Bearer ${r.engine.token(expired)}`, job.job_id, "input:read"));
  assert.equal(r.store.reads, before);
});
test("prepare cannot register a result referencing a file outside its job", async () => {
  const r = await setup("application/pdf"), job = r.task.jobs[0];
  const auth = await r.engine.authorize(`Bearer ${r.engine.token(job)}`, job.job_id, "result:write");
  await assert.rejects(r.engine.result(auth.claims, { status: "completed", files: [{ file_id: randomUUID() }], errors: [] }),
    (e: unknown) => e instanceof AccessError && e.status === 422);
  assert.equal((await r.store.read(r.task.id))!.task.jobs[0].result, undefined);
});


test("processing accepts contact provenance and evidence ratings, rejecting forged scores before saving", async () => {
  const fixtures = JSON.parse(readFileSync(new URL("./fixtures/evidence-ratings.json", import.meta.url), "utf8"));
  for (const fixture of fixtures) {
    const r = await setup();
    await mutateTask(r.store, r.task.id, task => {
      task.requirements = fixture.requirements.flatMap((c: any) => c.profiles.map((p: any) => ({
        id: p.id, name: p.position_name || "Test", education: p.education || "", experience: p.experience || "",
        keywords: p.keywords || [], stop_factors: p.stop_factors || [], comment: p.comment || "", cluster_comment: c.comment || "",
      })));
    });
    const job = r.task.jobs[0], auth = await r.engine.authorize(`Bearer ${r.engine.token(job)}`, job.job_id, "result:write");
    const contacts = contactResult({ last_name: "Тестова", first_name: "Анна", phone: "+79000000001" });
    const result = { ...evaluation(r.task), ...contacts, evaluations: fixture.result.clusters.flatMap((c: any) => c.profiles.map((p: any) => ({
      target_id: p.id, score: p.score, details: p.details, criteria: evaluation(r.task).evaluations[0].criteria,
      matched_keywords: p.matched_keywords || [], triggered_stop_factors: p.triggered_stop_factors || [], explanation: p.explanation || "",
    }))) };
    const forged = structuredClone(result); forged.evaluations[0].score = result.evaluations[0].score === 99 ? 98 : 99;
    await assert.rejects(r.engine.result(auth.claims, forged), (e: unknown) => e instanceof AccessError && e.status === 422);
    assert.equal((await r.store.read(r.task.id))!.task.jobs[0].result, undefined);
    await r.engine.result(auth.claims, result);
    const saved: any = (await r.store.read(r.task.id))!.task.jobs[0].result;
    assert.deepEqual(saved.contact_details, contacts.contact_details);
    assert.deepEqual(saved.evaluations[0].details, result.evaluations[0].details);
  }
});

test("prepare outputs inherit manual contacts while internal input hides storage keys and retry leases", async () => {
  const r = await setup("application/zip", "authorized"), job = r.task.jobs[0];
  const candidate = { last_name: "Тестова", first_name: "Анна", middle_name: null, phone: "+79000000001" };
  await mutateTask(r.store, r.task.id, task => { Object.assign(task.files[0], { candidate_hint: candidate, target_updated_at: "internal-lease" }); });
  const auth = await r.engine.authorize(`Bearer ${r.engine.token(job)}`, job.job_id, "output:write");
  const output = await r.engine.registerOutput(auth.claims, { file_id: randomUUID(), source_file_id: job.file_id,
    file_name: "prepared.pdf", mime_type: "application/pdf", size_bytes: 5, sha256: "b".repeat(64), key: "secret-storage-key", output_key: "resume-1" });
  assert.deepEqual(output.candidate_hint, candidate);
  const task = (await r.store.read(r.task.id))!.task, input = r.engine.input(task, task.jobs[0], "/internal");
  for (const key of ["key", "candidate_hint", "target_updated_at", "output_key"]) assert.ok(!(key in input.file), key);
});

test("a long queue does not consume execution time and redelivery cannot renew it", async t => {
  const r = await setup('text/plain', 'authorized'), job = r.task.jobs[0];
  const initial=Date.now();let now=initial;
  t.mock.method(Date,'now',()=>now);
  now+=3*3600000;
  const auth=await r.engine.authorize(`Bearer ${r.engine.token(job)}`,job.job_id,'input:read');
  assert.equal(r.engine.input(auth.task,auth.job,'/internal/app').should_process,true);
  assert.equal(auth.job.work_deadline,undefined);
  expireWork(auth.task,now);assert.equal(auth.task.status,'queued');
  await r.engine.progress(auth.claims,{job_id:job.job_id,attempt:1,status:'processing'});
  const started=(await r.store.read(r.task.id))!.task;
  const deadline=started.jobs[0].work_deadline!;
  assert.equal(Date.parse(deadline),now+1800000);
  assert.equal(started.jobs[0].started_at,new Date(now).toISOString());
  now+=10*60000;
  await r.engine.progress(auth.claims,{job_id:job.job_id,attempt:1,status:'processing'});
  assert.equal((await r.store.read(r.task.id))!.task.jobs[0].work_deadline,deadline);
  now=Date.parse(deadline)+1;
  await assert.rejects(r.engine.authorize(`Bearer ${r.engine.token(job)}`,job.job_id,'input:read'),(e:unknown)=>e instanceof AccessError&&e.status===409);
  const expired=(await r.store.read(r.task.id))!.task;expireWork(expired,now);
  assert.equal(expired.status,'failed');assert.equal(expired.jobs[0].result?.status,'failed');
});

test("an expired active resume does not expire its queued siblings or later PDF children",async t=>{
  const r=await setup('application/pdf','authorized');const initial=Date.now();let now=initial;
  t.mock.method(Date,'now',()=>now);
  await mutateTask(r.store,r.task.id,task=>{
    const queued={...task.files[0],file_id:randomUUID(),file_name:'second.txt',mime_type:'text/plain'};
    task.files.push(queued);task.jobs.push({...task.jobs[0],job_id:randomUUID(),file_id:queued.file_id,operation:'evaluate'});
  });
  const job=r.task.jobs[0];const auth=await r.engine.authorize(`Bearer ${r.engine.token(job)}`,job.job_id,'progress:write');
  await r.engine.progress(auth.claims,{job_id:job.job_id,attempt:1,status:'processing'});
  now+=31*60000;const task=(await r.store.read(r.task.id))!.task;expireWork(task,now);
  assert.equal(task.jobs[0].result?.status,'failed');assert.equal(task.jobs[1].applied,undefined);
  assert.equal(task.status,'processing');
  // A queued sibling gets its own full budget after the preceding timeout.
  await r.store.replace(task,(await r.store.read(task.id))!.version);
  const second=task.jobs[1];const next=await r.engine.authorize(`Bearer ${r.engine.token(second)}`,second.job_id,'progress:write');
  await r.engine.progress(next.claims,{job_id:second.job_id,attempt:1,status:'processing'});
  assert.equal(Date.parse((await r.store.read(task.id))!.task.jobs[1].work_deadline!),now+1800000);
});

test("PDF preparation cannot spend the execution budget of children waiting in the queue",async t=>{
 const r=await setup('application/pdf','authorized'),parent=r.task.jobs[0];let now=Date.now();
 t.mock.method(Date,'now',()=>now);
 const auth=await r.engine.authorize(`Bearer ${r.engine.token(parent)}`,parent.job_id,'result:write');
 await r.engine.progress(auth.claims,{job_id:parent.job_id,attempt:1,status:'processing'});
 await r.engine.result(auth.claims,{status:'completed',files:[{file_id:parent.file_id}],errors:[]});
 await r.engine.event(r.sent.at(-1)!.body);
 now+=2*3600000;
 const task=(await r.store.read(r.task.id))!.task;expireWork(task,now);
 const child=task.jobs.find(j=>j.operation==='evaluate')!;
 assert.equal(child.work_deadline,undefined);assert.equal(child.applied,undefined);
 const next=await r.engine.authorize(`Bearer ${r.engine.token(child)}`,child.job_id,'progress:write');
 await r.engine.progress(next.claims,{job_id:child.job_id,attempt:1,status:'processing'});
 assert.equal(Date.parse((await r.store.read(task.id))!.task.jobs.find(j=>j.job_id===child.job_id)!.work_deadline!),now+1800000);
});

test("all 15 queued resumes complete even when their combined runtime exceeds 30 minutes",async t=>{
 const r=await setup('text/plain','authorized');let now=Date.now();t.mock.method(Date,'now',()=>now);
 await mutateTask(r.store,r.task.id,task=>{
  for(let i=1;i<15;i++){
   const file={...task.files[0],file_id:randomUUID(),file_name:`resume-${i}.txt`};task.files.push(file);
   task.jobs.push({...task.jobs[0],job_id:randomUUID(),file_id:file.file_id});
  }
 });
 const task=(await r.store.read(r.task.id))!.task;
 for(const job of task.jobs){
  const auth=await r.engine.authorize(`Bearer ${r.engine.token(job)}`,job.job_id,'progress:write');
  await r.engine.progress(auth.claims,{job_id:job.job_id,attempt:1,status:'processing'});
  now+=12*60000;
  await r.engine.result(auth.claims,evaluation(task));await r.engine.event(r.sent.at(-1)!.body);
  const snapshot=(await r.store.read(task.id))!.task;expireWork(snapshot,now);
  assert.equal(snapshot.jobs.some(j=>j.result?.status==='failed'),false);
 }
 const done=(await r.store.read(task.id))!.task;
 assert.equal(done.status,'completed');assert.equal(done.jobs.filter(j=>j.applied).length,15);
});

test("queue waiting remains bounded and never extends a guest's absolute lifetime",()=>{
 const now=Date.now(),task=newTask('guest','test','bounded',[],now);
 task.status='queued';task.files=[{file_id:randomUUID(),file_name:'test.txt',mime_type:'text/plain',size_bytes:1,sha256:'a'.repeat(64),key:'test'}];task.source_ids=[task.files[0].file_id];
 expireWork(task,now+25*3600000);
 assert.equal(task.status,'failed');assert.ok(Date.parse(task.expires_at)<=now+24*3600000);
});

test("a durable result survives execution expiry while its publication is retried",async t=>{
 const r=await setup('text/plain','authorized'),job=r.task.jobs[0];let now=Date.now();t.mock.method(Date,'now',()=>now);
 const auth=await r.engine.authorize(`Bearer ${r.engine.token(job)}`,job.job_id,'result:write');
 await r.engine.progress(auth.claims,{job_id:job.job_id,attempt:1,status:'processing'});
 r.failure(true);await assert.rejects(r.engine.result(auth.claims,evaluation(r.task)));
 now+=31*60000;
 const task=(await r.store.read(r.task.id))!.task;expireWork(task,now);
 assert.equal(task.jobs[0].result?.status,'completed');assert.equal(task.jobs[0].applied,undefined);
 const replay=await r.engine.authorize(`Bearer ${r.engine.token(job)}`,job.job_id,'input:read');
 assert.equal(r.engine.input(replay.task,replay.job,'/internal/app').work_deadline,undefined);
 r.failure(false);await r.engine.result(auth.claims,evaluation(r.task));await r.engine.event(r.sent.at(-1)!.body);
 assert.equal((await r.store.read(task.id))!.task.status,'completed');
});

test("retry waits do not consume active budget, and an older delivery cannot pause its successor",async t=>{
 const r=await setup('text/plain','authorized'),job=r.task.jobs[0];let now=Date.now();t.mock.method(Date,'now',()=>now);
 const first=randomUUID(),second=randomUUID();
 const a=await r.engine.authorize(`Bearer ${r.engine.token(job)}`,job.job_id,'progress:write',first);
 await r.engine.progress(a.claims,{job_id:job.job_id,attempt:1,status:'processing',run_id:first});
 now+=14*60000;
 await r.engine.progress(a.claims,{job_id:job.job_id,attempt:1,status:'waiting_retry',run_id:first});
 const paused=(await r.store.read(r.task.id))!.task;
 assert.equal(paused.status,'queued');assert.equal(paused.jobs[0].work_elapsed_ms,14*60000);assert.equal(paused.jobs[0].work_deadline,undefined);
 now+=2*3600000;expireWork(paused,now);assert.equal(paused.jobs[0].result,undefined);
 const b=await r.engine.authorize(`Bearer ${r.engine.token(job)}`,job.job_id,'progress:write',second);
 await r.engine.progress(b.claims,{job_id:job.job_id,attempt:1,status:'processing',run_id:second});
 let current=(await r.store.read(r.task.id))!.task.jobs[0];
 assert.equal(Date.parse(current.work_deadline!),now+16*60000);assert.equal(current.retry_waiting_since,undefined);
 await r.engine.progress(a.claims,{job_id:job.job_id,attempt:1,status:'waiting_retry',run_id:first});
 current=(await r.store.read(r.task.id))!.task.jobs[0];assert.equal(current.work_run_id,second);assert.ok(current.work_segment_started_at);
 await assert.rejects(r.engine.result(a.claims,evaluation(r.task)),(e:unknown)=>e instanceof AccessError&&e.status===409);
 now+=10*60000;
 await r.engine.progress(b.claims,{job_id:job.job_id,attempt:1,status:'waiting_retry',run_id:second});
 current=(await r.store.read(r.task.id))!.task.jobs[0];assert.equal(current.work_elapsed_ms,24*60000);
 now+=3600000;
 const third=randomUUID(),c=await r.engine.authorize(`Bearer ${r.engine.token(job)}`,job.job_id,'progress:write',third);
 await r.engine.progress(c.claims,{job_id:job.job_id,attempt:1,status:'processing',run_id:third});
 assert.equal(Date.parse((await r.store.read(r.task.id))!.task.jobs[0].work_deadline!),now+6*60000);
 now+=6*60000+1;const expired=(await r.store.read(r.task.id))!.task;expireWork(expired,now);assert.equal(expired.status,'failed');
});

test("a resumed delivery retains all validated profile checkpoints",async t=>{
 const r=await checkpointCase();let now=Date.now();t.mock.method(Date,'now',()=>now);
 const first=randomUUID(),second=randomUUID();
 await r.engine.progress(r.auth.claims,{job_id:r.job.job_id,attempt:1,status:'processing',run_id:first});
 await r.engine.progress(r.auth.claims,{...r.progress,run_id:first});
 now+=60000;await r.engine.progress(r.auth.claims,{job_id:r.job.job_id,attempt:1,status:'waiting_retry',run_id:first});
 now+=3600000;await r.engine.progress(r.auth.claims,{job_id:r.job.job_id,attempt:1,status:'processing',run_id:second});
 const saved=(await r.store.read(r.task.id))!.task.jobs[0].evaluation_checkpoints!;
 assert.equal(saved.evaluations.length,1);assert.equal(saved.context,r.progress.checkpoint.context);
});
