import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { pool, transaction } from "@hr/data-access";
import { assessmentCompletedMessage, type Candidate, type ResumeEvent } from "@hr/contracts";

// Requires the current backend in Compose. Only UUIDs created by this run are removed.
const base = process.env.TEST_BASE_URL || "http://127.0.0.1:3000";
const owned = { candidates: [] as string[], resumes: [] as string[], files: [] as string[], blacklist: [] as string[] };
const suffix = randomBytes(8).toString("hex").replace(/\d/g, digit => String.fromCharCode(65 + Number(digit)));
let phoneIndex = 0;
const phoneBase = String(Date.now()).slice(-5);
const nextPhone = () => `+7999${phoneBase}${String(++phoneIndex).padStart(2, "0")}`;

async function api(path: string, method = "GET", body?: unknown) {
  const response = await fetch(base + "/api" + path, {
    method,
    ...(body === undefined ? {} : { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }),
  });
  return { status: response.status, body: await response.json() };
}
const change = (resume: string, status: string, outcome?: string) => api(`/resumes/${resume}/status`, "PATCH", { status, ...(outcome ? { outcome } : {}) });
async function candidate(resume: string): Promise<Candidate> {
  const result = await api("/overview");
  assert.equal(result.status, 200);
  const found = result.body.candidates.find((row: Candidate) => row.resume_id === resume);
  assert.ok(found);
  return found;
}
async function seed(lastName: string, status = "in_work") {
  const person = { last_name: lastName, first_name: "Иван", middle_name: "Тестович", phone: nextPhone() };
  const id = randomUUID(), resume = randomUUID(), file = randomUUID();
  await transaction(async client => {
    await client.query("INSERT INTO candidates (id,phone,last_name,first_name,middle_name,created_at,updated_at) VALUES ($1,$2,$3,$4,$5,now(),now())",
      [id, person.phone, person.last_name, person.first_name, person.middle_name]);
    await client.query("INSERT INTO files (id,bucket,object_key,file_name,mime_type,size_bytes,created_at) VALUES ($1,'workflow-test',$2,'resume.txt','text/plain',0,now())", [file, `workflow-test/${file}`]);
    await client.query("INSERT INTO resumes (id,candidate_id,file_id,status,scoring_status,created_at,updated_at) VALUES ($1,$2,$3,$4,'completed',now(),now())", [resume, id, file, status]);
  });
  owned.candidates.push(id); owned.resumes.push(resume); owned.files.push(file);
  return { id, resume, person };
}
async function addBlacklist(person: Pick<Candidate, "phone" | "last_name" | "first_name" | "middle_name">) {
  const body = { ...person, company_name: "Проверка правил отбора", is_active: true };
  const result = await api("/blacklist", "POST", body);
  assert.equal(result.status, 201);
  owned.blacklist.push(result.body.id);
  return { id: result.body.id as string, body };
}

try {
  const clear = await seed(`Проверка${suffix}`);
  assert.equal((await candidate(clear.resume)).has_other_resume_in_process, false);
  assert.equal((await change(clear.resume, "in_process")).status, 200);
  assert.equal((await candidate(clear.resume)).has_other_resume_in_process, false, "The current resume must not block itself");
  assert.equal((await change(clear.resume, "in_work")).status, 200);

  const blacklisted = await addBlacklist(clear.person);
  assert.equal((await candidate(clear.resume)).blacklisted, true);
  const denied = await change(clear.resume, "in_process");
  assert.equal(denied.status, 409);
  assert.match(denied.body.error, /чёрном списке/);
  assert.equal((await candidate(clear.resume)).status, "in_work");
  assert.equal((await pool.query("SELECT count(*)::int AS count FROM resume_events WHERE resume_id=$1 AND event_type='status_changed'", [clear.resume])).rows[0].count, 2, "Rejected transitions must not write success events");

  const stored = assessmentCompletedMessage(true);
  await pool.query("INSERT INTO resume_events (id,resume_id,event_type,message,created_at) VALUES ($1,$2,'scored',$3,now())", [randomUUID(), clear.resume, stored]);
  const journal = await api(`/resumes/${clear.resume}/events`);
  assert.equal(journal.status, 200);
  assert.equal(journal.body.find((event: ResumeEvent) => event.event_type === "scored").message, stored);

  const inactive = await api(`/blacklist/${blacklisted.id}`, "PUT", { ...blacklisted.body, is_active: false });
  assert.equal(inactive.status, 200);
  assert.equal((await candidate(clear.resume)).blacklisted, false);
  assert.equal((await change(clear.resume, "in_process")).status, 200);
  assert.equal((await change(clear.resume, "in_work")).status, 200);

  const nameMatch = await seed(`ТЕСТЁ${suffix}`);
  await addBlacklist({ ...nameMatch.person, last_name: `тесте${suffix.toLowerCase()}`, phone: nextPhone() });
  assert.equal((await candidate(nameMatch.resume)).blacklisted, true, "Name matching must normalize case and uppercase Ё/Е");
  assert.equal((await change(nameMatch.resume, "in_process")).status, 409);
  assert.equal((await change(nameMatch.resume, "historical", "rejected_all")).status, 200, "Archiving remains available");

  // Legacy data can contain separate candidate records with the same full name.
  const active = await seed(`ДУБЛЁ${suffix}`, "in_process");
  const duplicate = await seed(`дубле${suffix.toLowerCase()}`);
  assert.equal((await candidate(duplicate.resume)).has_other_resume_in_process, true);
  const duplicateDenied = await change(duplicate.resume, "in_process");
  assert.equal(duplicateDenied.status, 409);
  assert.match(duplicateDenied.body.error, /другое резюме/);
  assert.equal((await change(active.resume, "in_work")).status, 200);
  assert.equal((await candidate(duplicate.resume)).has_other_resume_in_process, false);
  assert.equal((await change(duplicate.resume, "in_process")).status, 200);

  const parallelA = await seed(`ГОНКЁ${suffix}`);
  const parallelB = await seed(`гонке${suffix.toLowerCase()}`);
  const parallel = await Promise.all([change(parallelA.resume, "in_process"), change(parallelB.resume, "in_process")]);
  assert.deepEqual(parallel.map(result => result.status).sort(), [200, 409]);
  const statuses = await pool.query("SELECT status FROM resumes WHERE id=ANY($1::uuid[])", [[parallelA.resume, parallelB.resume]]);
  assert.equal(statuses.rows.filter(row => row.status === "in_process").length, 1);
  console.log("Workflow integration passed: server blacklist/duplicate guards, case and Ё/Е matching, inactive blacklist, allowed return/archive, immutable assessment warning, and concurrent transition serialization.");
} finally {
  try {
    await transaction(async client => {
      await client.query("DELETE FROM profile_ratings WHERE resume_id=ANY($1::uuid[])", [owned.resumes]);
      await client.query("DELETE FROM resume_events WHERE resume_id=ANY($1::uuid[])", [owned.resumes]);
      await client.query("DELETE FROM resumes WHERE id=ANY($1::uuid[])", [owned.resumes]);
      await client.query("DELETE FROM candidates WHERE id=ANY($1::uuid[])", [owned.candidates]);
      await client.query("DELETE FROM files WHERE id=ANY($1::uuid[])", [owned.files]);
      await client.query("DELETE FROM candidate_blacklist WHERE id=ANY($1::uuid[])", [owned.blacklist]);
    });
  } finally { await pool.end(); }
}
