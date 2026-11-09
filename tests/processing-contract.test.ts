import { test } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { contactResult } from "./fixtures/contact-result.js";
import { Readable } from "node:stream";
import { signToken, AccessError } from "@hr/security";
import { ProcessingEngine, newTask, mutateTask, expireWork, type Task, type TaskStore, type Publication, type Job } from "@hr/processing";
import { processingCommandSchema, processingEventSchema, evaluateResultSchema } from "@hr/contracts";
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
  r.failure(false);
  const changed = evaluation(r.task); changed.evaluations[0].score = 1;
  await r.engine.result(auth.claims, changed);
  saved = (await r.store.read(r.task.id))!.task;
  assert.equal(saved.jobs[0].confirmed, true);
  assert.equal((saved.jobs[0].result as ReturnType<typeof evaluation>).evaluations[0].score, 80);
  await r.engine.event(r.sent.at(-1)!.body);
  assert.equal((await r.store.read(r.task.id))!.task.status, "completed");
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
