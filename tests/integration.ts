import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { chromium, expect } from "@playwright/test";
import { zipSync, unzipSync, strToU8 } from "fflate";
import { pool, transaction } from "@hr/data-access";
import { deleteFile } from "@hr/data-access";
import type {
  Candidate,
  Cluster,
  Profile,
  BlacklistEntry,
} from "@hr/contracts";

const base = process.env.TEST_BASE_URL || "http://127.0.0.1:3000";
const method = process.env.TEST_ANALYSIS_METHOD || "ollama-agent-v1";
const modelControl = process.env.TEST_MODEL_CONTROL_URL;
const ids = {
  clusters: [] as string[],
  profiles: [] as string[],
  candidates: [] as string[],
  blacklist: [] as string[],
};
const phone = "+7999" + String(Date.now()).slice(-7);
const person = {
  last_name: "Проверочный",
  first_name: "Иван",
  middle_name: "Тестович",
  phone,
};
const stamp = Date.now().toString();
async function request<T>(
  url: string,
  body?: unknown,
  method = "POST",
): Promise<T> {
  const response = await fetch(
    base + "/api" + url,
    body === undefined
      ? undefined
      : {
          method,
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        },
  );
  const data = await response.json();
  assert.ok(response.ok, `${url}: ${JSON.stringify(data)}`);
  return data as T;
}
async function overview() {
  return request<{
    candidates: Candidate[];
    clusters: Cluster[];
    blacklist: BlacklistEntry[];
  }>("/overview");
}
function makePdf(text = "Python SQL REST API backend development experience") {
  const stream = `BT /F1 12 Tf 50 750 Td (${text}) Tj ET`;
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`,
  ];
  let output = "%PDF-1.4\n";
  const offsets = [0];
  objects.forEach((o, i) => {
    offsets.push(Buffer.byteLength(output));
    output += `${i + 1} 0 obj\n${o}\nendobj\n`;
  });
  const xref = Buffer.byteLength(output);
  output += `xref\n0 6\n0000000000 65535 f \n${offsets
    .slice(1)
    .map((offset) => String(offset).padStart(10, "0") + " 00000 n \n")
    .join("")}trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  return Buffer.from(output);
}
const pdf = makePdf();
const docx = Buffer.from(
  zipSync({
    "[Content_Types].xml": strToU8(
      '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>',
    ),
    "_rels/.rels": strToU8(
      '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>',
    ),
    "word/document.xml": strToU8(
      '<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>Python SQL REST API backend &lt;script&gt;alert(1)&lt;/script&gt;</w:t></w:r></w:p></w:body></w:document>',
    ),
  }),
);
async function upload(
  data: typeof person,
  buffer: Buffer,
  filename: string,
  replace = false,
) {
  const form = new FormData();
  Object.entries(data).forEach(([k, v]) => form.append(k, v));
  form.append("resume", new Blob([new Uint8Array(buffer)]), filename);
  form.append("allow_replace", String(replace));
  const response = await fetch(base + "/api/candidates", {
    method: "POST",
    body: form,
  });
  return { status: response.status, body: await response.json() };
}
async function waitFor(id: string, status: string) {
  for (let i = 0; i < 90; i++) {
    const candidate = (await overview()).candidates.find((c) => c.id === id);
    if (candidate?.scoring_status === status) return candidate;
    if (candidate?.scoring_status === "failed" && status !== "failed") {
      const events = await request<unknown[]>(
        `/resumes/${candidate.resume_id}/events`,
      );
      throw new Error(`Scoring failed: ${JSON.stringify(events)}`);
    }
    await delay(1000);
  }
  throw new Error(`Scoring timeout ${id}`);
}
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
try {
  const cluster = await request<Cluster>("/clusters", {
    name: `ИТ-кластер · проверка ${stamp}`,
    track: "test",
    comment: "Тестовые требования",
    is_active: true,
  });
  ids.clusters.push(cluster.id);
  const inactive = await request<Cluster>("/clusters", {
    name: `Неактивный кластер ${stamp}`,
    track: "test",
    is_active: false,
  });
  ids.clusters.push(inactive.id);
  const createProfile = async (
    position: string,
    keywords: string[],
    active: boolean,
    clusterId = cluster.id,
  ) => {
    const p = await request<Profile>("/profiles", {
      cluster_id: clusterId,
      position_name: position,
      keywords,
      is_active: active,
    });
    ids.profiles.push(p.id);
    return p;
  };
  const developer = await createProfile(
    "Backend-разработчик",
    ["Python", "SQL"],
    true,
  );
  const analyst = await createProfile("Аналитик", ["Excel"], true);
  // Existing schema permits NULL in optional requirement fields.
  await pool.query(
    "UPDATE profiles SET education=NULL,experience=NULL,stop_factors=NULL,comment=NULL WHERE id=$1",
    [analyst.id],
  );
  await pool.query("UPDATE clusters SET comment=NULL WHERE id=$1", [
    cluster.id,
  ]);
  await createProfile("Приостановленный профиль", ["Python"], false);
  await createProfile(
    "Неактивный кластер / профиль",
    ["SQL"],
    true,
    inactive.id,
  );
  const blocked = await request<BlacklistEntry>("/blacklist", {
    ...person,
    company_name: "Тестовая компания",
    is_active: true,
  });
  ids.blacklist.push(blocked.id);
  console.log("API: requirements and independent blacklist created");

  browser = await chromium.launch({ channel: "chrome", headless: true });
  const page = await browser.newPage({
    viewport: { width: 1440, height: 1000 },
  });
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(base + "/submit");
  await expect(
    page.getByRole("heading", { name: "Новое резюме", exact: true }),
  ).toBeVisible();
  await page.getByLabel("Фамилия *", { exact: true }).fill(person.last_name);
  await page.getByLabel("Имя *", { exact: true }).fill(person.first_name);
  await page.getByLabel("Отчество", { exact: true }).fill(person.middle_name);
  await page.getByLabel(/^Телефон \*/).fill(phone);
  await page.getByLabel("Файл резюме").setInputFiles({
    name: "Тестовое резюме.pdf",
    mimeType: "application/pdf",
    buffer: pdf,
  });
  await page.getByRole("button", { name: "Отправить резюме" }).click();
  await expect(
    page.getByRole("heading", { name: "Резюме принято" }),
  ).toBeVisible({ timeout: 70000 });
  let candidate = (await overview()).candidates.find((c) => c.phone === phone)!;
  assert.ok(candidate);
  ids.candidates.push(candidate.id);
  assert.equal(candidate.blacklisted, true);
  candidate = await waitFor(candidate.id, "completed");
  assert.equal(
    candidate.ratings.filter((r) => ids.profiles.includes(r.profile_id)).length,
    2,
  );
  if (modelControl) assert.equal(
    candidate.ratings.find((r) => r.profile_id === developer.id)?.score,
    100,
  );
  if (modelControl) assert.equal(
    candidate.ratings.find((r) => r.profile_id === analyst.id)?.score,
    0,
  );
  assert.equal(candidate.file_name, "Тестовое резюме.pdf");
  console.log(
    "Pipeline: browser upload → ClamAV → S3 → resume-analyzer → ratings, inactive requirements excluded",
  );

  assert.equal((await upload(person, pdf, "resume.pdf")).status, 409);
  assert.equal(
    (await upload({ ...person, first_name: "Пётр" }, pdf, "resume.pdf")).status,
    409,
  );
  assert.equal(
    (
      await upload(
        { ...person, phone: "+7888" + phone.slice(-7) },
        pdf,
        "resume.pdf",
      )
    ).status,
    409,
  );
  const badPdf = Buffer.concat([pdf, Buffer.from("\n/JavaScript (evil)")]);
  assert.equal((await upload(person, badPdf, "resume.pdf", true)).status, 422);
  // Standard EICAR test signature, in memory only; no malware file is written.
  const eicar = Buffer.from(
    "X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*",
  );
  const infectedDocx = Buffer.from(
    zipSync({ ...unzipSync(docx), "eicar.txt": new Uint8Array(eicar) }),
  );
  const infected = await upload(person, infectedDocx, "resume.docx", true);
  assert.equal(infected.status, 422, JSON.stringify(infected));
  assert.match(infected.body.error, /вредоносные/);
  console.log(
    "Validation: duplicate phone/name, PDF active content and antivirus test signature rejected",
  );

  await page.goto(base + "/");
  await page
    .getByRole("textbox", { name: "Поиск по ФИО или телефону" })
    .fill(phone);
  await page
    .locator("thead")
    .getByRole("button", { name: new RegExp(`ИТ-кластер · проверка ${stamp}`) })
    .click();
  await expect(
    page.getByText("Backend-разработчик", { exact: true }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: new RegExp(`Карточка: ${person.last_name}`) })
    .click();
  await expect(
    page.getByRole("heading", { name: "Карточка кандидата" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Резюме", exact: true }).click();
  await expect(page.getByTitle("Предпросмотр резюме")).toBeVisible();
  await page
    .getByRole("dialog")
    .last()
    .getByRole("button", { name: "Закрыть", exact: true })
    .click();
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Закрыть", exact: true })
    .click();
  await mkdir(".qa", { recursive: true });
  await page.screenshot({
    path: ".qa/distribution-desktop.png",
    fullPage: true,
  });
  assert.equal(await page.evaluate(() => (window as Window & { Alabuga?: { VERSION: string } }).Alabuga?.VERSION), "0.6.0");
  const brandImage = page.getByAltText("Алабуга");
  assert.ok(
    await brandImage.evaluate(
      (el) => (el as HTMLImageElement).naturalWidth > 0,
    ),
  );
  for (const route of ["/requirements", "/processing", "/blacklist"]) {
    await page.goto(base + route);
    await expect(page.locator("main h1")).toBeVisible();
  }
  await page.setViewportSize({ width: 390, height: 844 });
  for (const route of [
    "/",
    "/submit",
    "/requirements",
    "/processing",
    "/blacklist",
  ]) {
    await page.goto(base + route);
    await expect(page.locator("main h1")).toBeVisible();
    assert.ok(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth,
      ),
      `Mobile overflow ${route}`,
    );
  }
  await page.screenshot({ path: ".qa/blacklist-mobile.png", fullPage: true });
  assert.deepEqual(errors, []);
  console.log(
    "UI: all five routes, framework/version/assets, cluster expansion, dialogs and 390px layout passed",
  );

  const report = await fetch(
    base + `/api/resumes/${candidate.resume_id}/report?download=true`,
  );
  assert.equal(report.status, 200);
  assert.match(report.headers.get("content-disposition") || "", /attachment/);
  assert.ok((await report.text()).includes(method));
  const csv = await fetch(base + "/api/export");
  assert.equal(csv.status, 200);
  assert.match(await csv.text(), /Backend-разработчик/);
  await page.emulateMedia({ media: "print" });
  await page.goto(base + "/");
  await page.pdf({
    path: ".qa/distribution-print.pdf",
    format: "A4",
    landscape: true,
  });
  const replaced = await upload(person, docx, "updated.docx", true);
  assert.equal(replaced.status, 201, JSON.stringify(replaced));
  candidate = await waitFor(candidate.id, "completed");
  const preview = await fetch(
    base + `/api/files/${candidate.file_id}?preview=true`,
  );
  const previewHtml = await preview.text();
  assert.equal(preview.status, 200);
  assert.ok(previewHtml.includes("&lt;script&gt;alert(1)&lt;/script&gt;"));
  const file = await fetch(
    base + `/api/files/${candidate.file_id}?download=true`,
  );
  assert.equal(file.status, 200);
  assert.deepEqual(Buffer.from(await file.arrayBuffer()), docx);
  assert.equal(
    (await upload(person, makePdf(""), "empty.pdf", true)).status,
    201,
  );
  candidate = await waitFor(candidate.id, "failed");
  assert.equal(candidate.ratings.length, 0);
  await request(`/resumes/${candidate.resume_id}/retry`, {});
  candidate = await waitFor(candidate.id, "failed");
  assert.equal((await upload(person, docx, "restored.docx", true)).status, 201);
  candidate = await waitFor(candidate.id, "completed");
  console.log(
    "Worker: extraction failure persists and retry/replacement recover correctly",
  );
  await request(
    `/resumes/${candidate.resume_id}/status`,
    { status: "in_process" },
    "PATCH",
  );
  assert.equal((await upload(person, pdf, "resume.pdf", true)).status, 409);
  const events = await request<{ event_type: string }[]>(
    `/resumes/${candidate.resume_id}/events`,
  );
  assert.ok(events.some((e) => e.event_type === "replacement_rejected"));
  await request(
    `/resumes/${candidate.resume_id}/status`,
    { status: "historical" },
    "PATCH",
  );
  await request(
    `/blacklist/${blocked.id}`,
    { ...blocked, is_active: false },
    "PUT",
  );
  assert.equal(
    (await overview()).candidates.find((c) => c.id === candidate.id)
      ?.blacklisted,
    false,
  );
  assert.equal(
    (await upload(person, pdf, "from-archive.pdf", true)).status,
    201,
  );
  candidate = await waitFor(candidate.id, "completed");
  assert.equal(candidate.status, "in_work");
  const parallelPerson = {
    ...person,
    last_name: "Параллельный",
    phone: "+7888" + phone.slice(-7),
  };
  const simultaneous = await Promise.all([
    upload(parallelPerson, pdf, "one.pdf"),
    upload(parallelPerson, pdf, "two.pdf"),
  ]);
  assert.deepEqual(simultaneous.map((r) => r.status).sort(), [201, 409]);
  ids.candidates.push(
    simultaneous.find((r) => r.status === 201)!.body.candidate_id,
  );
  await waitFor(ids.candidates.at(-1)!, "completed");
  console.log(
    "Concurrency: simultaneous identical uploads produce one candidate; archived resume returns to selection",
  );
  console.log(
    "Exports/lifecycle: CSV, HTML, print PDF, DOCX preview/download, replacement, work lock and blacklist deactivation passed",
  );
  if (modelControl) {
    const setMode = async (mode: string) => {
      const response = await fetch(modelControl, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ mode }) });
      assert.ok(response.ok);
    };
    const waitAnalysis = async (available: boolean) => {
      let matchingSince = 0;
      for (let i = 0; i < 30; i++) {
        const status = await request<{ available: boolean }>("/analysis/status");
        if (status.available === available) {
          matchingSince ||= Date.now();
          // Outlast the backend cache; a cached pre-failure true is not recovery.
          if (Date.now() - matchingSince >= 5500) return;
        } else matchingSince = 0;
        await delay(1000);
      }
      throw new Error(`Analysis did not become available=${available}`);
    };
    try {
      for (const mode of ["offline", "timeout"]) {
        await setMode(mode);
        await waitAnalysis(false);
        await request("/health");
        const before = (await overview()).candidates.find(c => c.id === candidate.id)!;
        const retry = await fetch(base + `/api/resumes/${candidate.resume_id}/retry`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
        assert.equal(retry.status, 503);
        const after = (await overview()).candidates.find(c => c.id === candidate.id)!;
        assert.equal(after.file_id, before.file_id);
        assert.deepEqual(after.ratings, before.ratings);
        assert.equal((await fetch(base + `/api/files/${candidate.file_id}?download=true`)).status, 200);
        assert.equal((await fetch(base + `/api/resumes/${candidate.resume_id}/report`)).status, 200);
        assert.equal((await fetch(base + "/api/export")).status, 200);
        await request(`/blacklist/${blocked.id}`, { ...blocked, is_active: false }, "PUT");
        await request(`/clusters/${cluster.id}`, { ...cluster, comment: "Updated while model offline" }, "PUT");
        await page.goto(base + "/submit");
        await expect(page.getByRole("button", { name: "Отправить резюме" })).toBeEnabled();
        for (const route of ["/", "/requirements", "/blacklist", "/processing"]) {
          await page.goto(base + route);
          await expect(page.locator("main h1")).toBeVisible();
          await expect(page.getByRole("alert")).toHaveCount(0);
        }
        if (mode === "offline") {
          await request(`/resumes/${candidate.resume_id}/status`, { status: "in_process" }, "PATCH");
          await request(`/resumes/${candidate.resume_id}/status`, { status: "historical" }, "PATCH");
        }
        const saved = await upload(person, pdf, `saved-${mode}.pdf`, true);
        assert.equal(saved.status, 201, JSON.stringify(saved));
        candidate = (await overview()).candidates.find(c => c.id === candidate.id)!;
        assert.notEqual(candidate.file_id, before.file_id);
        assert.equal(candidate.ratings.length, 0);
        const downloaded = await fetch(base + `/api/files/${candidate.file_id}?download=true`);
        assert.equal(downloaded.status, 200);
        assert.deepEqual(Buffer.from(await downloaded.arrayBuffer()), pdf);
        await delay(3000);
        assert.equal((await overview()).candidates.find(c => c.id === candidate.id)?.scoring_status, "pending", "Worker must preserve queued jobs while model offline");
        await setMode("online");
        await waitAnalysis(true);
        candidate = await waitFor(candidate.id, "completed");
        await request(`/resumes/${candidate.resume_id}/retry`, {});
        candidate = await waitFor(candidate.id, "completed");
      }
      await setMode("invalid");
      await request(`/resumes/${candidate.resume_id}/retry`, {});
      candidate = await waitFor(candidate.id, "failed");
      assert.ok(candidate.ratings.length > 0, "Failed reanalysis must preserve previous ratings");
      await setMode("online");
      await waitAnalysis(true);
      await request(`/resumes/${candidate.resume_id}/retry`, {});
      await waitFor(candidate.id, "completed");
      console.log("Model outage: uploads/replacements persist in DB and S3 before scoring; queued jobs recover; invalid responses preserve previous ratings");
    } finally { await setMode("online"); }
  }
} finally {
  await browser?.close();
  const files = await pool.query(
    "SELECT id,object_key FROM files WHERE object_key LIKE ANY($1::text[])",
    [ids.candidates.map((id) => `resumes/${id}/%`)],
  );
  await transaction(async (client) => {
    const resumeIds = await client.query(
      "SELECT id FROM resumes WHERE candidate_id=ANY($1::uuid[])",
      [ids.candidates],
    );
    const resumes = resumeIds.rows.map((r) => r.id);
    await client.query(
      "DELETE FROM resume_events WHERE resume_id=ANY($1::uuid[])",
      [resumes],
    );
    await client.query(
      "DELETE FROM profile_ratings WHERE resume_id=ANY($1::uuid[]) OR profile_id=ANY($2::uuid[])",
      [resumes, ids.profiles],
    );
    await client.query("DELETE FROM resumes WHERE id=ANY($1::uuid[])", [
      resumes,
    ]);
    await client.query("DELETE FROM candidates WHERE id=ANY($1::uuid[])", [
      ids.candidates,
    ]);
    await client.query("DELETE FROM files WHERE id=ANY($1::uuid[])", [
      files.rows.map((f) => f.id),
    ]);
    await client.query(
      "DELETE FROM candidate_blacklist WHERE id=ANY($1::uuid[])",
      [ids.blacklist],
    );
    await client.query("DELETE FROM profiles WHERE id=ANY($1::uuid[])", [
      ids.profiles,
    ]);
    await client.query("DELETE FROM clusters WHERE id=ANY($1::uuid[])", [
      ids.clusters,
    ]);
  });
  for (const file of files.rows) await deleteFile(file.object_key);
  await pool.end();
  console.log("Only test-owned records and S3 objects cleaned up");
}
