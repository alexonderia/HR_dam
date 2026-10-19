import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { chromium, expect } from "@playwright/test";
import type { RequirementUpdates } from "@hr/contracts";

const base = process.env.TEST_BASE_URL || "http://127.0.0.1:5173";
const browser = await chromium.launch({ channel: process.env.TEST_BROWSER_CHANNEL });
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  const first = "7dd06ccb-6026-42d1-8bbd-6440f0f647aa", second = "f59f09d8-80fd-42b5-8fc8-c1b78c316204";
  let updates: RequirementUpdates = { resume_count: 3, ready_resume_count: 3, clusters: [
    { cluster_id: first, cluster_name: "Новый кластер", resume_count: 3, ready_resume_count: 3 },
    { cluster_id: second, cluster_name: "Изменённый кластер", resume_count: 2, ready_resume_count: 2 },
  ] };
  const posts: { cluster_ids: string[] }[] = [];
  let reject = false;
  await page.route("**/api/**", async route => {
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith("/overview")) return route.fulfill({ json: { candidates: [], clusters: [], blacklist: [], resumeImports: [], requirementUpdates: updates } });
    if (path.endsWith("/analysis/status")) return route.fulfill({ json: { available: true, message: "Готово" } });
    if (path.endsWith("/requirements/reassessment")) {
      posts.push(route.request().postDataJSON());
      if (reject) return route.fulfill({ status: 503, json: { error: "Не удалось отправить задания" } });
      updates = { ...updates, ready_resume_count: 0, clusters: updates.clusters.map(cluster => ({ ...cluster, ready_resume_count: 0 })) };
      return route.fulfill({ status: 202, json: { queued_resumes: 3, skipped_resumes: 0, errors: [] } });
    }
    return route.fulfill({ status: 404, json: { error: path } });
  });
  await page.goto(base + "/requirements");
  const notice = page.locator(".requirement-updates-notice");
  await expect(notice).toContainText("Есть неактуальные результаты анализа");
  await page.reload();
  await expect(notice).toBeVisible();
  await page.getByRole("button", { name: "Обновить оценки", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByRole("checkbox")).toHaveCount(2);
  await dialog.getByRole("checkbox", { name: /Изменённый кластер/ }).uncheck();
  reject = true;
  await dialog.getByRole("button", { name: "Запустить оценку", exact: true }).click();
  await expect(dialog).toContainText("Не удалось отправить задания");
  await expect(notice).toBeVisible();
  await expect(dialog.getByRole("button", { name: "Запустить оценку", exact: true })).toBeEnabled();
  reject = false;
  await dialog.getByRole("button", { name: "Запустить оценку", exact: true }).click();
  await expect(dialog).toContainText("Поставлено в очередь резюме: 3");
  assert.deepEqual(posts, [{ cluster_ids: [first] }, { cluster_ids: [first] }]);
  await expect(dialog.getByRole("button", { name: "Запустить оценку", exact: true })).toBeDisabled();
  await dialog.getByRole("button", { name: "Закрыть", exact: true }).last().click();
  await expect(notice).toContainText("Оценка уже в очереди или выполняется");
  await page.goto(base + "/processing");
  await expect(notice).toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole("button", { name: "Обновить оценки", exact: true }).click();
  await expect(dialog).toBeVisible();
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), "Notice must fit a mobile screen");
  await mkdir(".qa", { recursive: true });
  await page.screenshot({ path: ".qa/requirement-updates-mobile.png", fullPage: true });
  await dialog.getByRole("button", { name: "Закрыть", exact: true }).last().click();
  updates = { resume_count: 0, ready_resume_count: 0, clusters: [] };
  await page.getByRole("button", { name: "Обновить данные", exact: true }).click();
  await expect(notice).toHaveCount(0);
  assert.deepEqual(errors, []);
  console.log("PASS: persistent requirement notice, cluster selection, request/error recovery, pending state, mobile layout and notice removal after completion.");
} finally {
  await browser.close();
}
