import assert from "node:assert/strict";
import { chromium, expect } from "@playwright/test";
import { readFile, writeFile } from "node:fs/promises";
import { setTimeout } from "node:timers/promises";

const browser = await chromium.launch({ channel: process.env.TEST_BROWSER_CHANNEL || "msedge", headless: true });
try {
  const page = await browser.newPage();
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.goto(process.env.TEST_BASE_URL || "http://localhost:3000");
  const plan = await readFile(new URL("../reports/resume-evaluation-improvement-plan.md", import.meta.url), "utf8");
  const skills = [...plan.matchAll(/```text\s*\n([\s\S]*?)\n```/gu)][3][1];
  const preview = page.locator("summary").filter({ hasText: "Проверить разбор требований" });
  for (const pasted of [skills, skills + "\n", "\r\n" + skills + "\r\n\r\n"]) {
    await page.locator("textarea[name=keywords]").fill(pasted);
    await expect(preview).toHaveText("Проверить разбор требований (13)");
  }
  await page.locator("textarea[name=keywords]").fill("Организация работы, включая графики; Контроль транспорта");
  await expect(preview).toHaveText("Проверить разбор требований (2)");
  console.log("PASS browser: pasted control list has 13 items with trailing blank lines; explicit groups keep commas");

  // Optional local acceptance run against the real upload and evaluator.
  // Supply a single authorized control PDF and its original input fields.
  if (process.env.TEST_RESUME_FILE && process.env.TEST_CRITERIA_FILE) {
    const criteria = JSON.parse(await readFile(process.env.TEST_CRITERIA_FILE, "utf8")) as Record<string, string>;
    for (const [key, value] of Object.entries(criteria)) await page.locator(`[name="${key}"]`).fill(value);
    await page.locator('input[type="file"]').setInputFiles(process.env.TEST_RESUME_FILE);
    const accepted = page.waitForResponse(response => new URL(response.url()).pathname === "/api/guest/tasks" && response.request().method() === "POST");
    await page.getByRole("button", { name: "Оценить резюме", exact: true }).click();
    const response = await accepted;
    assert.equal(response.status(), 202, await response.text());
    let report = await response.json();
    console.log(`PASS real upload: task=${report.task_id}`);
    const deadline = Date.now() + 900000;
    let previous = "";
    while (!["completed", "partially_completed", "failed"].includes(report.status)) {
      assert.ok(Date.now() < deadline, "Control evaluation exceeded fifteen minutes");
      await setTimeout(5000);
      const status = await page.request.get(`/api/guest/tasks/${report.task_id}`);
      assert.equal(status.status(), 200, await status.text());
      report = await status.json();
      const progress = `${report.status}: ${report.completed_count}/${report.candidate_count}`;
      if (progress !== previous) { console.log(progress); previous = progress; }
    }
    assert.equal(report.status, "completed", JSON.stringify(report.errors));
    const evaluation = report.results[0].evaluations[0];
    const keywords = evaluation.details.criteria.filter((c: { category: string }) => c.category === "keyword");
    assert.equal(keywords.length, 13);
    assert.equal(evaluation.details.policy_version, "evidence-v5");
    console.log(JSON.stringify({task_id:report.task_id,score:evaluation.score,coverage:evaluation.details.coverage,skills:keywords.map((c: {requirement:string;status:string})=>({requirement:c.requirement,status:c.status}))}));
    if (process.env.TEST_RESULT_FILE) await writeFile(process.env.TEST_RESULT_FILE, JSON.stringify(report, null, 2));
  }
  assert.deepEqual(errors, []);
} finally { await browser.close(); }
