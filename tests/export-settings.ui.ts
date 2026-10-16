import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { chromium, expect } from "@playwright/test";
import type { Candidate, Cluster } from "@hr/contracts";
import { createExport, exportOptionsSchema, type ExportOptions } from "../apps/backend/src/export-options.js";

const base = process.env.TEST_BASE_URL || "http://127.0.0.1:3000";
const clusterId = "11111111-1111-4111-8111-111111111111";
const profile = {
  id: "22222222-2222-4222-8222-222222222222", cluster_id: clusterId,
  position_name: "Разработчик", is_active: true, education: "", experience: "",
  keywords: [], stop_factors: [], comment: "",
};
const clusters: Cluster[] = [
  { id: clusterId, name: "Разработка", track: "it", comment: "", is_active: true,
    profiles: [profile, { ...profile, id: "33333333-3333-4333-8333-333333333333", is_active: false }] },
  { id: "44444444-4444-4444-8444-444444444444", name: "Архивный кластер", track: "it", comment: "", is_active: false,
    profiles: [{ ...profile, id: "55555555-5555-4555-8555-555555555555", cluster_id: "44444444-4444-4444-8444-444444444444" }] },
];
const candidates: Candidate[] = Array.from({ length: 18 }, (_, index) => ({
  id: `aaaaaaaa-aaaa-4aaa-8aaa-${String(index).padStart(12, "0")}`,
  resume_id: `bbbbbbbb-bbbb-4bbb-8bbb-${String(index).padStart(12, "0")}`,
  file_id: `cccccccc-cccc-4ccc-8ccc-${String(index).padStart(12, "0")}`,
  last_name: index === 0 ? "Иванов" : `Кандидат ${index}`, first_name: "Иван", middle_name: "",
  phone: `+7999000${String(index).padStart(4, "0")}`, status: "in_work", scoring_status: "completed",
  file_name: "Резюме.txt", mime_type: "text/plain", blacklisted: index === 17,
  other_resumes_count: 0, has_other_resume_in_process: false,
  created_at: "2026-10-16T12:00:00+03:00", updated_at: "2026-10-16T12:00:00+03:00",
  ratings: [{ profile_id: profile.id, score: 80, explanation: "Подтверждён опыт.",
    matched_keywords: [], triggered_stop_factors: [], calculated_at: "2026-10-16T12:00:00+03:00" }],
}));

const browser = await chromium.launch({ channel: process.env.TEST_BROWSER_CHANNEL });
try {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  await context.addInitScript(() => { window.print = () => { document.body.dataset.printed = "true"; }; });
  const page = await context.newPage();
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const requests: ExportOptions[] = [];
  let failNext = true;
  let releaseFailure: (() => void) | undefined;
  await context.route("**/api/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/api/overview") return route.fulfill({ json: { candidates, clusters, blacklist: [], resumeImports: [] } });
    if (path === "/api/analysis/status") return route.fulfill({ json: { available: true, message: "Готово" } });
    if (path === "/api/events") return route.fulfill({ json: [] });
    if (path === "/api/export") {
      const options = exportOptionsSchema.parse(route.request().postDataJSON());
      requests.push(options);
      if (failNext) {
        failNext = false;
        await new Promise<void>((resolve) => { releaseFailure = resolve; });
        return route.fulfill({ status: 503, json: { error: "Не удалось собрать архив. Повторите попытку." } });
      }
      if (options.allData) return route.fulfill({ body: Buffer.from("test archive"), contentType: "application/zip",
        headers: { "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent("Все данные кандидатов.zip")}` } });
      const result = createExport(candidates.filter((candidate) => options.candidate_ids.includes(candidate.id)),
        clusters.filter((cluster) => options.cluster_ids.includes(cluster.id)), options);
      return route.fulfill({ body: result.body, contentType: result.mime });
    }
    throw new Error(`Unexpected API request: ${route.request().method()} ${path}`);
  });
  await mkdir(".qa/export-ux", { recursive: true });
  await page.goto(base);
  await expect(page.locator(".matrix tbody tr")).toHaveCount(15);
  const opener = page.getByRole("button", { name: "Экспорт", exact: true });
  await opener.click();
  const dialog = page.getByRole("dialog", { name: "Настройки экспорта" });
  const selection = dialog.getByRole("radio", { name: /Текущая выборка/ });
  const database = dialog.getByRole("radio", { name: /Вся база/ });
  await expect(selection).toBeChecked();
  await expect(dialog.getByRole("status")).toContainText("Кандидатов: 18");
  await dialog.getByLabel("Содержание", { exact: true }).selectOption("table");
  await dialog.getByLabel("Формат", { exact: true }).selectOption("csv");
  await dialog.getByRole("checkbox", { name: /Приложить отдельные отчёты/ }).check();
  await expect(dialog.getByRole("button", { name: "Скачать ZIP" })).toBeEnabled();
  await database.check();
  await expect(dialog.getByLabel("Содержание", { exact: true })).toHaveCount(0);
  await expect(dialog.getByLabel("Формат отчётов")).toHaveValue("csv");
  const blacklist = dialog.getByRole("checkbox", { name: /Включать кандидатов из чёрного списка/ });
  const active = dialog.getByRole("checkbox", { name: /Только активные требования/ });
  await expect(blacklist).toBeChecked();
  await expect(active).not.toBeChecked();
  await blacklist.uncheck();
  await active.check();
  await expect(dialog.getByRole("status")).toContainText("Кандидатов: 17");
  await expect(dialog.getByRole("status")).toContainText("Профилей: 1");
  // Native radio keyboard navigation must preserve the settings of both modes.
  await database.focus();
  await database.press("ArrowLeft");
  await expect(selection).toBeChecked();
  await expect(dialog.getByLabel("Содержание", { exact: true })).toHaveValue("table");
  await expect(dialog.getByRole("checkbox", { name: /Приложить отдельные отчёты/ })).toBeChecked();
  await selection.press("ArrowRight");
  await expect(active).toBeChecked();
  await expect(blacklist).not.toBeChecked();

  await page.setViewportSize({ width: 390, height: 844 });
  await dialog.getByRole("button", { name: "Скачать ZIP" }).click();
  await expect(dialog.getByRole("button", { name: "Подготовка…" })).toBeDisabled();
  await expect(dialog.getByRole("button", { name: "Закрыть", exact: true })).toBeDisabled();
  await expect(database).toBeDisabled();
  await page.keyboard.press("Escape");
  await expect(dialog).toBeVisible();
  await expect.poll(() => Boolean(releaseFailure)).toBe(true);
  releaseFailure!();
  await expect(dialog.getByRole("alert")).toContainText("Повторите попытку");
  await expect(dialog.getByRole("alert")).toBeInViewport();
  await page.screenshot({ path: ".qa/export-ux/08-mobile-error.png" });
  await expect(active).toBeChecked();
  const downloadEvent = page.waitForEvent("download");
  await dialog.getByRole("button", { name: "Скачать ZIP" }).click();
  const download = await downloadEvent;
  assert.equal(download.suggestedFilename(), "Все данные кандидатов.zip");
  await expect(dialog).toHaveCount(0);
  await expect(opener).toBeFocused();
  const archiveRequest = requests.at(-1)!;
  assert.deepEqual(archiveRequest.candidate_ids, []);
  assert.deepEqual(archiveRequest.cluster_ids, []);
  assert.deepEqual(archiveRequest.expanded, []);
  assert.equal(archiveRequest.content, "report");
  assert.equal(archiveRequest.individual, false);
  assert.equal(archiveRequest.includeBlacklisted, false);
  assert.equal(archiveRequest.activeRequirementsOnly, true);

  // Empty table results must still allow a complete archive.
  await page.getByLabel("Поиск по ФИО или телефону").fill("нет такого кандидата");
  await opener.click();
  await expect(dialog.getByRole("button", { name: "Скачать Excel" })).toBeDisabled();
  await expect(dialog.getByRole("status")).toContainText("По текущим фильтрам кандидатов нет");
  await database.check();
  await expect(dialog.getByRole("button", { name: "Скачать ZIP" })).toBeEnabled();
  await expect(dialog.getByRole("status")).toContainText("Кандидатов: 18");

  for (const viewport of [{ width: 390, height: 844 }, { width: 320, height: 568 }, { width: 740, height: 360 }]) {
    await page.setViewportSize(viewport);
    const footer = dialog.locator(":scope > .dialog-footer");
    const body = dialog.locator(".dialog-body");
    for (const bottom of [false, true]) {
      await body.evaluate((element, bottom) => { element.scrollTop = bottom ? element.scrollHeight : 0; }, bottom);
      const rect = await footer.boundingBox();
      assert.ok(rect && rect.y >= 0 && rect.y + rect.height <= viewport.height + 1);
      await expect(dialog.getByRole("button", { name: "Скачать ZIP" })).toBeInViewport();
      assert.ok(await dialog.evaluate((element) => element.scrollWidth <= element.clientWidth));
    }
  }
  await page.setViewportSize({ width: 390, height: 844 });
  await dialog.locator(".dialog-body").evaluate((element) => { element.scrollTop = element.scrollHeight; });
  await page.screenshot({ path: ".qa/export-ux/07-mobile-summary.png" });
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(opener).toBeFocused();

  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.getByLabel("Поиск по ФИО или телефону").fill("Иванов");
  await opener.click();
  await dialog.getByLabel("Содержание", { exact: true }).selectOption("table");
  const selectedDownload = page.waitForEvent("download");
  await dialog.getByRole("button", { name: "Скачать Excel" }).click();
  await selectedDownload;
  assert.deepEqual(requests.at(-1)!.candidate_ids, [candidates[0].id]);
  assert.equal(requests.at(-1)!.allData, false);

  await page.getByRole("button", { name: "Печать", exact: true }).click();
  const printDialog = page.getByRole("dialog", { name: "Настройки печати" });
  await expect(printDialog.getByRole("radio")).toHaveCount(0);
  await expect(printDialog.getByRole("combobox")).toHaveCount(1);
  await printDialog.getByRole("checkbox", { name: /Добавить отдельный отчёт/ }).check();
  const popupEvent = page.waitForEvent("popup");
  await printDialog.getByRole("button", { name: "Перейти к печати" }).click();
  const popup = await popupEvent;
  await expect(popup.locator("body")).toHaveAttribute("data-printed", "true");
  assert.equal(requests.at(-1)!.print, true);
  assert.equal(requests.at(-1)!.format, "html");
  assert.equal(requests.at(-1)!.individual, true);
  await popup.close();

  await page.getByRole("button", { name: "Карточка: Иванов Иван", exact: true }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Экспорт", exact: true }).click();
  await expect(dialog.getByText("Иванов Иван", { exact: true })).toBeVisible();
  await expect(dialog.getByRole("radio")).toHaveCount(0);
  await expect(dialog.getByRole("checkbox")).toHaveCount(0);
  const singleDownload = page.waitForEvent("download");
  await dialog.getByRole("button", { name: "Скачать Excel" }).click();
  await singleDownload;
  assert.equal(requests.at(-1)!.candidateReport, true);
  assert.deepEqual(requests.at(-1)!.candidate_ids, [candidates[0].id]);
  assert.deepEqual(errors, []);
  console.log("Export UX passed: scope, counts, settings, keyboard, pending/error/retry, downloads, empty selection, responsive footer, print and single-candidate export.");
} finally {
  await browser.close();
}
