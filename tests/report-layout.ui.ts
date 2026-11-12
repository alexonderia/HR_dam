import assert from "node:assert/strict";
import { readFile, mkdir, copyFile } from "node:fs/promises";
import { randomUUID, createHash } from "node:crypto";
import { chromium, expect } from "@playwright/test";
import { evaluateResultSchema } from "@hr/contracts";

const directory = ".qa/report-option-1", phase = process.env.REPORT_QA_PHASE || "after";
await mkdir(directory, { recursive: true });
if (process.env.REPORT_REFERENCE) await copyFile(process.env.REPORT_REFERENCE, `${directory}/reference.png`);
const viewport = { width: 1487, height: 1058 }; // Selected design's native dimensions; no external image is needed to run the test.
const fixtures = JSON.parse(await readFile(new URL("./fixtures/evidence-ratings.json", import.meta.url), "utf8"));
const template = fixtures.find((fixture: { name: string }) => fixture.name === "unknown_is_not_absent").result.clusters[0].profiles[0];
const source = "Python, FastAPI, PostgreSQL\nРазработка API на Python, 2021–2026\nСреднее профессиональное образование";
const quote = (value: string) => ({ quote: value, start: source.indexOf(value), end: source.indexOf(value) + value.length });
const criterion = (id: string, category: string, requirement: string, weight: number, status: string, credit: number, evidence: ReturnType<typeof quote>[]) => ({
  id, category, requirement, source: category === "keyword" ? "keywords" : category === "additional" ? "profile_comment" : category,
  optional: false, weight, status, credit, possible_credit: status === "unknown" ? 1 : credit, evidence,
});
const explanation = "Опыт разработки и Python подтверждены резюме. Образование соответствует частично. Дополнительные сведения не указаны.";
const details = { ...structuredClone(template.details), source_text_length: source.length,
  source_text_sha256: createHash("sha256").update(source).digest("hex"), coverage: 90, score_range: { min: 82, max: 92 },
  criteria: [
    criterion("keyword:0:0", "keyword", "Python", 1500, "met", 1, [quote("Python, FastAPI, PostgreSQL")]),
    criterion("keyword:1:0", "keyword", "FastAPI", 1500, "met", 1, [quote("Python, FastAPI, PostgreSQL")]),
    criterion("keyword:2:0", "keyword", "PostgreSQL", 1400, "met", 1, [quote("Python, FastAPI, PostgreSQL")]),
    { ...criterion("experience:0", "experience", "Опыт разработки от 3 лет", 3000, "met", 1, [quote("Разработка API на Python, 2021–2026")]), required_months: 36, experience_months: 60 },
    criterion("education:0", "education", "Образование", 1600, "partial", .5, [quote("Среднее профессиональное образование")]),
    criterion("additional:0", "additional", "Работа с высоконагруженными системами", 1000, "unknown", 0, []),
  ] };
const names = [["Иванов", "Алексей"], ["Петрова", "Мария"], ["Смирнов", "Сергей"], ["Соколова", "Анна"], ["Орлов", "Илья"], ["Волкова", "Елена"], ["Морозов", "Дмитрий"], ["Кузнецова", "Ольга"], ["Соколов", "Иван"], ["Попова", "Анна"]];
const scores = [82, 68, 45, 31, 29, 28, 27, 26, 25, 24], taskId = randomUUID();
const report = { task_id: taskId, status: "completed", source_count: 1, candidate_count: 10, completed_count: 10,
  expires_at: new Date(Date.now() + 7200000).toISOString(), errors: [],
  results: names.map(([last_name, first_name], index) => ({ file_id: randomUUID(), ...evaluateResultSchema.parse({ status: "completed",
    candidate: { last_name, first_name, middle_name: null, phone: null }, evaluations: [{ target_id: randomUUID(), score: scores[index],
      explanation: index ? "Оценка сформирована по сведениям резюме." : explanation,
      matched_keywords: index ? [] : ["Python", "FastAPI", "PostgreSQL"], triggered_stop_factors: [], ...(index ? {} : { details }),
      criteria: ["education", "experience", "keywords"].map(name => ({ name, status: "unknown", explanation: "Сводка из ответа API." })) }] }) })),
};
const browser = await chromium.launch({ channel: process.env.TEST_BROWSER_CHANNEL || "chrome", headless: true });
try {
  const context = await browser.newContext({ viewport, deviceScaleFactor: 1 });
  await context.addInitScript(id => localStorage.setItem("hr_guest_task", id), taskId);
  const page = await context.newPage(), errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.route("**/api/**", async route => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(new URL(route.request().url()).pathname === "/api/session" ? { mode: "guest" } : report) }));
  await page.goto(process.env.TEST_BASE_URL || "http://localhost:3000");
  const first = page.locator(".guest-candidate").first();
  await expect(first.locator(".rating-rationale .explanation-text")).toHaveText(explanation);
  await expect(first.locator(".rating-metrics dd")).toHaveText(["82–92 из 100", "90%"]);
  await expect(first.locator(".rating-finding--partial .rating-state")).toHaveText("Частичное соответствие");
  await expect(page.locator(".guest-candidate:visible")).toHaveCount(4);
  await expect(page.getByRole("button", { name: "Ещё 6 кандидатов", exact: true })).toBeVisible();
  await page.evaluate(() => document.fonts.ready);
  await page.screenshot({ path: `${directory}/${phase}-desktop.png` });
  await first.locator(".rating-all-sources > summary").click();
  await expect(first.locator(".rating-all-sources").getByText("Среднее профессиональное образование", { exact: true })).toBeVisible();
  await expect(first.locator(".rating-all-sources").getByText("Разработка API на Python, 2021–2026", { exact: true })).toBeVisible();
  await first.locator(".rating-all-sources > summary").click();
  const downloadEvent = page.waitForEvent("download");
  await page.getByRole("button", { name: "Скачать отчёт", exact: true }).click();
  await (await downloadEvent).saveAs(`${directory}/report.html`);
  const standalone = await context.newPage();
  await standalone.setContent(await readFile(`${directory}/report.html`, "utf8"));
  await expect(standalone.locator(".guest-candidate:visible")).toHaveCount(10);
  await expect(standalone.locator(".guest-candidate[open]")).toHaveCount(10);
  await expect(standalone.locator(".guest-candidate-score .score")).toHaveText(scores.map(String));
  assert.equal(await standalone.locator("button, script, .guest-actions, .guest-report-login").count(), 0);
  await standalone.pdf({ path: `${directory}/report.pdf`, format: "A4", printBackground: true });
  await standalone.close();
  await page.getByRole("button", { name: "Ещё 6 кандидатов", exact: true }).click();
  await expect(page.locator(".guest-candidate:visible")).toHaveCount(10);
  await expect(first).toHaveAttribute("open", "");
  for (const width of [768, 390, 320]) {
    await page.setViewportSize({ width, height: 844 });
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), `report must fit ${width}px`);
    await expect(page.getByRole("button", { name: "Скачать отчёт", exact: true })).toBeVisible();
    if (width === 390) await page.screenshot({ path: `${directory}/${phase}-mobile.png`, fullPage: true });
  }
  await page.getByRole("button", { name: "Новая отправка", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Оценка резюме", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Оценить резюме", exact: true })).toBeVisible();
  assert.deepEqual(errors, []);
  console.log(`PASS selected report layout: ${viewport.width}x${viewport.height}, known/partial/missing findings, show-more, all ten candidates in download, tablet/mobile and return to upload form`);
} finally { await browser.close(); }
