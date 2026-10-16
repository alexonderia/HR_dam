import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { chromium, expect } from "@playwright/test";
import { zipSync, strToU8 } from "fflate";
import type { Candidate, ResumeImportDetail } from "@hr/contracts";

const base = process.env.TEST_BASE_URL || "http://127.0.0.1:3000";
const browser = await chromium.launch({ channel: process.env.TEST_BROWSER_CHANNEL || "chrome" });
await mkdir(".qa", { recursive: true });
try {
  for (const [name, viewport] of [["desktop", { width: 1440, height: 1100 }], ["mobile", { width: 390, height: 844 }]] as const) {
    const context = await browser.newContext({ viewport });
    const page = await context.newPage();
    const errors: string[] = [];
    page.on("pageerror", error => errors.push(error.message));
    let accepted = false, completed = false, posts = 0;
    const now = new Date().toISOString();
    const candidate: Candidate = { id: "c0000000-0000-4000-8000-000000000001", resume_id: "e0000000-0000-4000-8000-000000000001",
      file_id: "f0000000-0000-4000-8000-000000000001", phone: null, first_name: null, last_name: null, middle_name: null,
      file_name: "resume.txt", mime_type: "text/plain", status: "in_work", scoring_status: "completed", created_at: now,
      updated_at: now, blacklisted: false, has_other_resume_in_process: false, other_resumes_count: 0, ratings: [] };
    const detail = (): ResumeImportDetail => ({ id: "b0000000-0000-4000-8000-000000000001", archive_name: "resumes.zip",
      created_at: now, total_files: 1, processed_files: completed ? 1 : 0, pending_files: completed ? 0 : 1,
      failed_files: 0, uploading_files: 0, processing_files: 0, ignored_files: ["notes.csv"], items: [{
        id: "a0000000-0000-4000-8000-000000000001", source_path: "folder/resume.txt", file_name: "resume.txt",
        status: completed ? "completed" : "pending", attempt: 1, error: null, warning: null,
        candidate_id: completed ? candidate.id : null, resume_id: completed ? candidate.resume_id : null, updated_at: now,
      }] });
    await page.route("**/api/**", async route => {
      const path = new URL(route.request().url()).pathname;
      let body: unknown = {}, status = 200;
      if (path === "/api/overview") body = { candidates: completed ? [candidate] : [], clusters: [], blacklist: [], resumeImports: accepted ? [detail()] : [] };
      else if (path === "/api/analysis/status") body = { available: false, message: "Обработчик резюме пока не подключён. Файлы ожидают обработки." };
      else if (path === "/api/processing/queue") body = { available: true, analysis_consumers: 0, queues: { "hr.resume.analysis": { ready: accepted && !completed ? 1 : 0, processing: 0, consumers: 0 } } };
      else if (path === "/api/resume-imports" && route.request().method() === "POST") {
        accepted = true; posts++; status = 202; body = detail();
      } else if (path.startsWith("/api/resume-imports/")) body = detail();
      else if (path.endsWith("/events")) body = [];
      await route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
    });
    await page.goto(base + "/submit");
    await page.getByRole("button", { name: "ZIP с резюме", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Массовая загрузка резюме" })).toBeVisible();
    await expect(page.getByLabel("Фамилия", { exact: true })).toHaveCount(0);
    const input = page.getByLabel("ZIP с резюме", { exact: true });
    await input.setInputFiles({ name: "wrong.pdf", mimeType: "application/pdf", buffer: Buffer.from("wrong") });
    await expect(page.getByRole("alert")).toContainText("Выберите ZIP");
    assert.equal(posts, 0);
    await page.screenshot({ path: `.qa/zip-${name}.png`, fullPage: true });
    const zip = zipSync({ "folder/resume.txt": strToU8("Resume"), "notes.csv": strToU8("ignored") });
    await input.setInputFiles({ name: "resumes.zip", mimeType: "application/zip", buffer: Buffer.from(zip) });
    await page.getByRole("button", { name: "Загрузить архив", exact: true }).click();
    await expect(page.getByText("Архив «resumes.zip» принят: 1 резюме.")).toBeVisible();
    assert.equal(posts, 1);
    await page.getByRole("link", { name: "Следить за массовой обработкой" }).click();
    await expect(page.getByText("folder/resume.txt", { exact: true })).toBeVisible();
    await expect(page.getByText("Ожидает анализа · Попытка 1")).toBeVisible();
    completed = true;
    await expect(page.getByText("Готово · Попытка 1")).toBeVisible({ timeout: 10000 });
    await expect(page.getByText("ФИО не указано", { exact: true }).first()).toBeVisible({ timeout: 10000 });
    await expect(page.getByText("Телефон не указан", { exact: true }).first()).toBeVisible();
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false, `${name}: horizontal overflow`);
    assert.deepEqual(errors, []);
    await context.close();
  }
  console.log("PASS: ZIP form, invalid extension, upload acceptance, polling, nullable candidate rendering, desktop/mobile, no horizontal overflow");
} finally { await browser.close(); }
