import assert from "node:assert/strict";
import { chromium, expect } from "@playwright/test";
import { setTimeout as delay } from "node:timers/promises";
import { zipSync, strToU8 } from "fflate";
import { pool, transaction, getFile, deleteFile } from "@hr/data-access";
import type { Candidate, ResumeProcessing } from "@hr/contracts";
import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";

// Run while analysis is unavailable. Only test-owned records/files are changed.
const base = process.env.TEST_BASE_URL || "http://127.0.0.1:3000";
let unavailable = false;
for (let i = 0; i < 15; i++) {
  const response = await fetch(base + "/api/analysis/status");
  assert.equal(response.status, 200);
  if (!(await response.json()).available) { unavailable = true; break; }
  await delay(1000);
}
assert.ok(unavailable, "This check requires unavailable analysis");
for (const endpoint of ["/health", "/overview", "/export"]) {
  assert.equal((await fetch(base + "/api" + endpoint)).status, 200);
}
assert.equal((await fetch(base + "/api/candidates", { method: "POST" })).status, 422);
assert.equal((await fetch(base + "/api/resumes/00000000-0000-4000-8000-000000000001/retry", {
  method: "POST", headers: { "Content-Type": "application/json" }, body: "{}",
})).status, 503);

const browser = await chromium.launch({ channel: "chrome", headless: true });
const person = {
  last_name: "Проверочный",
  first_name: "Сохранение",
  middle_name: "Безанализа",
  phone: "+7996" + String(Date.now()).slice(-7),
};
const docx = Buffer.from(zipSync({
  "[Content_Types].xml": strToU8('<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>'),
  "_rels/.rels": strToU8('<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>'),
  "word/document.xml": strToU8('<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>Python SQL developer with five years of experience</w:t></w:r></w:p></w:body></w:document>'),
}));
let candidateId: string | undefined;
let blacklistId: string | undefined;
try {
  const page = await browser.newPage();
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  for (const route of ["/", "/submit", "/requirements", "/blacklist", "/processing"]) {
    await page.goto(base + route);
    await expect(page.locator("main h1")).toBeVisible();
    await expect(page.getByRole("status")).toContainText("Остальные функции доступны");
    await expect(page.getByRole("alert")).toHaveCount(0);
    if (route === "/submit")
      await expect(page.getByRole("button", { name: "Отправить резюме" })).toBeEnabled();
  }

  await page.goto(base + "/submit");
  await expect(page.getByRole("status")).toContainText("Резюме можно сохранить");
  await page.getByLabel("Фамилия *", { exact: true }).fill(person.last_name);
  await page.getByLabel("Имя *", { exact: true }).fill(person.first_name);
  await page.getByLabel("Отчество", { exact: true }).fill(person.middle_name);
  await page.getByLabel(/^Телефон \*/).fill(person.phone);
  await page.getByLabel("Файл резюме").setInputFiles({ name: "saved-without-analysis.docx", mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", buffer: docx });
  const responsePromise = page.waitForResponse(response => response.url().endsWith("/api/candidates") && response.request().method() === "POST", { timeout: 70000 });
  await page.getByRole("button", { name: "Отправить резюме" }).click();
  const response = await responsePromise;
  assert.equal(response.status(), 201);
  candidateId = (await response.json()).candidate_id;
  await expect(page.getByRole("heading", { name: "Резюме принято" })).toBeVisible();
  await expect(page.getByText("Анализ начнётся автоматически, когда сервис и модель будут доступны.")).toBeVisible();

  const stored = await pool.query(
    `SELECT c.phone,c.last_name,r.id AS resume_id,r.scoring_status,f.id AS file_id,f.bucket,f.object_key,f.size_bytes
     FROM candidates c JOIN resumes r ON r.candidate_id=c.id JOIN files f ON f.id=r.file_id WHERE c.id=$1`,
    [candidateId],
  );
  assert.equal(stored.rowCount, 1);
  const original = stored.rows[0];
  assert.equal(original.phone, person.phone);
  assert.equal(original.last_name, person.last_name);
  assert.equal(original.scoring_status, "pending");
  assert.equal(Number(original.size_bytes), docx.length);
  assert.deepEqual(await getFile(original.bucket, original.object_key), docx);

  const form = new FormData();
  for (const [key, value] of Object.entries(person)) form.append(key, value);
  form.append("allow_replace", "true");
  form.append("resume", new Blob([new Uint8Array(docx)]), "replacement-without-analysis.docx");
  const replaced = await fetch(base + "/api/candidates", { method: "POST", body: form });
  assert.equal(replaced.status, 201);
  assert.equal((await replaced.json()).candidate_id, candidateId);
  await delay(3000);
  const overview = await (await fetch(base + "/api/overview")).json() as { candidates: Candidate[] };
  const candidate = overview.candidates.find(c => c.id === candidateId)!;
  assert.equal(candidate.scoring_status, "pending");
  assert.notEqual(candidate.file_id, original.file_id);
  assert.equal(candidate.ratings.length, 0);
  const download = await fetch(base + `/api/files/${candidate.file_id}?download=true`);
  assert.equal(download.status, 200);
  assert.deepEqual(Buffer.from(await download.arrayBuffer()), docx);
  const events = await (await fetch(base + `/api/resumes/${candidate.resume_id}/events`)).json() as { event_type: string }[];
  assert.ok(events.some(e => e.event_type === "uploaded"));
  assert.ok(events.some(e => e.event_type === "replaced"));
  assert.ok(!events.some(e => ["scored", "scoring_failed"].includes(e.event_type)));
  assert.equal(candidate.other_resumes_count, 1);
  await pool.query("UPDATE resumes SET updated_at=now()-interval '2 minutes' WHERE id=$1", [candidate.resume_id]);
  const processing = await (await fetch(base + `/api/resumes/${candidate.resume_id}/processing`)).json() as ResumeProcessing;
  assert.equal(processing.queue?.reason, "analysis_unavailable");
  assert.equal(processing.queue?.delayed, true);
  assert.ok(processing.queue!.waiting_seconds >= 120);
  // A legacy entry must be rendered without rewriting its stored audit message.
  await pool.query("INSERT INTO resume_events (id,resume_id,event_type,message,created_at) VALUES ($1,$2,'uploaded',$3,now())",
    [randomUUID(), candidate.resume_id, "Файл проверен антивирусом, сохранён в S3. Совпадений с чёрным списком нет."]);
  await page.goto(base + `/processing?resume=${candidate.resume_id}`);
  await expect(page.getByLabel("Причина ожидания")).toContainText("Анализ временно недоступен");
  await expect(page.getByLabel("Причина ожидания")).toContainText("В очереди:");
  await expect(page.getByLabel("Результат проверки кандидата")).toContainText("Ранее загружено резюме: 1");
  await expect(page.getByLabel("Результат проверки кандидата")).toContainText("Совпадений с чёрным списком нет");
  assert.doesNotMatch(await page.locator(".processing-detail").innerText(), /S3|PostgreSQL|\bБД\b|in_process|historical/);
  const blocked = await fetch(base + "/api/blacklist", { method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ...person, company_name: "Проверка интерфейса", is_active: true }) });
  assert.equal(blocked.status, 201);
  blacklistId = (await blocked.json()).id;
  await expect(page.getByLabel("Результат проверки кандидата")).toContainText("Есть совпадение");
  await mkdir(".qa", { recursive: true });
  await page.screenshot({ path: ".qa/processing-waiting-desktop.png", fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.getByLabel("Причина ожидания")).toBeVisible();
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  await page.screenshot({ path: ".qa/processing-waiting-mobile.png", fullPage: true });
  assert.deepEqual(errors, []);
  console.log("Unavailable analysis: browser upload and replacement persist in PostgreSQL/S3; jobs remain pending; validation/data/exports work independently");
} finally {
  await browser.close();
  const owned = await pool.query("SELECT id FROM candidates WHERE phone=$1 AND last_name=$2 AND first_name=$3 AND middle_name=$4", [person.phone, person.last_name, person.first_name, person.middle_name]);
  const candidateIds = owned.rows.map(row => row.id);
  const files = await pool.query("SELECT id,object_key FROM files WHERE object_key LIKE ANY($1::text[])", [candidateIds.map(id => `resumes/${id}/%`)]);
  try {
    await transaction(async client => {
      const resumes = await client.query("SELECT id FROM resumes WHERE candidate_id=ANY($1::uuid[])", [candidateIds]);
      const resumeIds = resumes.rows.map(row => row.id);
      await client.query("DELETE FROM profile_ratings WHERE resume_id=ANY($1::uuid[])", [resumeIds]);
      await client.query("DELETE FROM resume_events WHERE resume_id=ANY($1::uuid[])", [resumeIds]);
      await client.query("DELETE FROM resumes WHERE id=ANY($1::uuid[])", [resumeIds]);
      await client.query("DELETE FROM candidates WHERE id=ANY($1::uuid[])", [candidateIds]);
      if (blacklistId) await client.query("DELETE FROM candidate_blacklist WHERE id=$1", [blacklistId]);
      await client.query("DELETE FROM files WHERE id=ANY($1::uuid[])", [files.rows.map(row => row.id)]);
    });
    for (const file of files.rows) await deleteFile(file.object_key);
  } finally { await pool.end(); }
}
