import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { chromium, expect } from "@playwright/test";
import { zipSync, strToU8 } from "fflate";
import type { Candidate, ResumeImportDetail } from "@hr/contracts";
import { formatMoscowTime, moscowTimestamp } from "@hr/contracts";
import type { Locator } from "@playwright/test";

async function expandCandidateGroups(panel: Locator) {
  const closed = panel.locator(".import-candidate-group:not([open]) > summary");
  while (await closed.count()) await closed.first().click();
}

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
      updated_at: now, analysis_duration_ms: 329000, blacklisted: false, has_other_resume_in_process: false, other_resumes_count: 0, ratings: [] };
    const detail = (): ResumeImportDetail => ({ id: "b0000000-0000-4000-8000-000000000001", archive_name: "resumes.zip",
      created_at: now, total_files: 1, processed_files: completed ? 1 : 0, pending_files: completed ? 0 : 1,
      failed_files: 0, uploading_files: 0, processing_files: 0, ignored_files: ["notes.csv"], items: [{
        id: "a0000000-0000-4000-8000-000000000001", source_path: "folder/resume.txt", file_name: "resume.txt",
        status: completed ? "completed" : "pending", attempt: 1, error: null, warning: null,
        candidate_id: completed ? candidate.id : null, resume_id: completed ? candidate.resume_id : null, updated_at: now,
        analysis_duration_ms: completed ? 329000 : null,
      }] });
    await page.route("**/api/**", async route => {
      const path = new URL(route.request().url()).pathname;
      let body: unknown = {}, status = 200;
      if (path === "/api/overview") body = { candidates: completed ? [candidate] : [], clusters: [], blacklist: [], resumeImports: accepted ? [detail()] : [] };
      else if (path === "/api/analysis/status") body = { available: false, message: "Обработчик резюме пока не подключён. Файлы ожидают обработки." };
      else if (path === "/api/processing/queue") body = { available: true, analysis_consumers: 0, queues: { "hr.resume.analysis": { ready: accepted && !completed ? 1 : 0, processing: 0, consumers: 0 } } };
      else if (path === "/api/resume-imports" && route.request().method() === "POST") {
        accepted = true; posts++; status = 202; body = detail();
      } else if (path === "/api/resume-imports/status") body = accepted ? [detail()] : [];
      else if (path.startsWith("/api/resume-imports/")) body = detail();
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
    const listToggle = page.getByRole("button", { name: "Список загрузок", exact: true });
    await expect(listToggle).toHaveAttribute("aria-expanded", "false");
    await listToggle.click();
    await expandCandidateGroups(page.getByRole("region", { name: "Массовая обработка резюме" }));
    await expect(page.getByText("folder/resume.txt", { exact: true })).toBeVisible();
    await expect(page.getByText("Ожидает анализа · Попытка 1")).toBeVisible();
    await listToggle.click();
    completed = true;
    await expect(page.getByRole("progressbar")).toHaveAttribute("aria-valuenow", "1", { timeout: 10000 });
    await expect(listToggle).toHaveAttribute("aria-expanded", "false");
    await listToggle.click();
    await expandCandidateGroups(page.getByRole("region", { name: "Массовая обработка резюме" }));
    await expect(page.getByText("Готово · Попытка 1")).toBeVisible({ timeout: 10000 });
    await expect(page.locator(".import-file").getByText("Время анализа: 5 мин 29 с", { exact: true })).toBeVisible();
    await expect(page.getByText("ФИО не указано", { exact: true }).first()).toBeVisible({ timeout: 10000 });
    await expect(page.getByText("Телефон не указан", { exact: true }).first()).toBeVisible();
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false, `${name}: horizontal overflow`);
    assert.deepEqual(errors, []);
    await context.close();
  }
  const context = await browser.newContext({ viewport: { width: 1440, height: 1100 } });
  const page = await context.newPage();
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  const now = new Date().toISOString();
  const first: ResumeImportDetail = {
    id: "b0000000-0000-4000-8000-000000000001", archive_name: "Резюме — октябрь.zip", created_at: now,
    total_files: 23, processed_files: 17, failed_files: 2, pending_files: 4, uploading_files: 1, processing_files: 1,
    ignored_files: ["__MACOSX/.DS_Store", "Информация.xlsx"],
    items: Array.from({ length: 23 }, (_, index) => ({
      id: `file-${index}`, file_name: `Кандидат_${index}.pdf`, source_path: `Отдел разработки/Кандидат_${index}.pdf`,
      status: index < 2 ? "failed" : index === 2 ? "processing" : index === 3 ? "uploading" : index < 6 ? "pending" : "completed",
      attempt: index === 1 ? 100 : 1, error: index < 2 ? "В документе нет текстового слоя." : null,
      warning: index === 8 ? "Кандидат найден в чёрном списке. Требуется ручная проверка." : null,
      candidate_id: null, resume_id: index >= 6 ? `resume-${index}` : null, updated_at: now,
      analysis_duration_ms: index === 0 ? 900000 : index >= 6 ? 329000 : null,
    })),
  };
  const second: ResumeImportDetail = { ...first, id: "b0000000-0000-4000-8000-000000000002", archive_name: "Другая загрузка.pdf",
    total_files: 1, processed_files: 1, failed_files: 0, pending_files: 0, uploading_files: 0, processing_files: 0,
    ignored_files: [], items: [{ ...first.items[6], id: "other-file", file_name: "Другой_кандидат.pdf", source_path: "Другой_кандидат.pdf", resume_id: "other-resume" }] };
  const queued: ResumeImportDetail = { ...second, id: "b0000000-0000-4000-8000-000000000003", archive_name: "Ожидающий_файл.pdf", created_at: moscowTimestamp(now),
    processed_files: 0, pending_files: 1,
    items: [{ ...second.items[0], id: "queued-file", file_name: "Ожидающий_файл.pdf", source_path: "Ожидающий_файл.pdf", status: "pending", resume_id: null }] };
  const older: ResumeImportDetail = { ...queued, id: "b0000000-0000-4000-8000-000000000004", archive_name: "Давняя_загрузка.pdf",
    created_at: new Date(Date.parse(now) - 2 * 60 * 60 * 1000).toISOString(), processing_files: 1,
    items: [{ ...queued.items[0], id: "older-file", file_name: "Давняя_загрузка.pdf", source_path: "Давняя_загрузка.pdf", status: "processing", updated_at: now }] };
  let failRetry = true, failDetails = false;
  let releaseRetry: (() => void) | undefined;
  await page.route("**/api/**", async route => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/api/overview") return route.fulfill({ json: { candidates: [], clusters: [], blacklist: [], resumeImports: [first, second, queued, older] } });
    if (path === "/api/analysis/status") return route.fulfill({ json: { available: true, message: "Готово" } });
    if (path === "/api/processing/queue") return route.fulfill({ json: { available: true, analysis_consumers: 1, queues: {} } });
    if (path.endsWith("/retry")) {
      if (failRetry) { failRetry = false; return route.fulfill({ status: 503, json: { error: "Повторная отправка временно недоступна." } }); }
      await new Promise<void>(resolve => { releaseRetry = resolve; });
      first.items[0] = { ...first.items[0], status: "uploading", attempt: 2, error: null, analysis_duration_ms: null };
      first.failed_files--; first.pending_files++; first.uploading_files++;
      return route.fulfill({ json: first });
    }
    if (path.startsWith("/api/resume-imports/")) {
      if (failDetails) return route.fulfill({ status: 503, json: { error: "Недоступно" } });
      return route.fulfill({ json: path.endsWith("/status") ? [first, second, queued, older] : path.endsWith(second.id) ? second : path.endsWith(queued.id) ? queued : first });
    }
    return route.fulfill({ json: [] });
  });
  await page.goto(base + `/processing?batch=${first.id}`);
  const panel = page.getByRole("region", { name: "Массовая обработка резюме" });
  const metrics = panel.getByRole("group", { name: "Фильтр файлов по состоянию" });
  const rows = panel.locator(".import-file");
  const search = panel.getByRole("textbox", { name: "Поиск файлов загрузки" });
  await expect(rows).toHaveCount(10);
  await expect(panel.getByRole("heading", { name: "Общий статус проверок", exact: true })).toBeVisible();
  await expect(panel.getByText("Загрузки за последний час", { exact: true })).toBeVisible();
  await expect(panel.getByRole("progressbar")).toHaveAttribute("aria-valuenow", "20");
  await expect(panel.getByRole("progressbar")).toHaveAttribute("aria-valuemax", "25");
  await expect(panel.getByLabel("Выберите загрузку")).toHaveCount(0);
  await expect(panel.locator(".import-scope-options")).not.toHaveAttribute("open");
  await expect(panel.getByRole("heading", { name: "Идёт анализ резюме", exact: true })).toBeVisible();
  await expect(panel.getByLabel("Текущий анализ")).toContainText("Кандидат_2.pdf");
  await expect(panel.getByLabel("Текущий анализ")).toContainText(`Начало ${formatMoscowTime(now)} МСК · Прошло`);
  await expect(panel.getByLabel("Текущий анализ")).not.toContainText(older.archive_name);
  await expect(metrics.getByRole("button", { name: "В очереди 3", exact: true })).toBeVisible();
  const listToggle = panel.getByRole("button", { name: "Список загрузок", exact: true });
  await expect(listToggle).toHaveAttribute("aria-expanded", "false");
  await expect(rows.first()).toBeHidden();
  await panel.screenshot({ path: ".qa/resume-compact-closed-desktop.png" });
  await listToggle.click();
  await expandCandidateGroups(panel);
  await expect(rows.first()).toBeVisible();
  await expect(rows.first()).toContainText("Кандидат_0.pdf");
  await expect(rows.first()).toContainText("Время анализа: 15 мин 0 с");
  await expect(rows.filter({ hasText: "Кандидат_1.pdf" })).toContainText("Время анализа: нет данных");
  await panel.screenshot({ path: ".qa/resume-tracking-desktop.png" });
  await panel.getByRole("button", { name: "Следующая страница файлов" }).click();
  await expect(panel.locator(".import-list-footer")).toContainText("11–20 из 25 кандидатов");
  await metrics.getByRole("button", { name: "Готовы 18", exact: true }).click();
  await expect(panel.locator(".import-list-footer")).toContainText("1–10 из 18");
  await search.fill("Отдел разработки/Кандидат_22");
  await expect(rows).toHaveCount(1);
  await expect(rows).toContainText("Кандидат_22.pdf");
  await search.fill("Кандидат_8.pdf");
  await expandCandidateGroups(panel);
  await expect(panel.getByText("Кандидат найден в чёрном списке. Требуется ручная проверка.")).toBeVisible();
  await search.fill("Нет такого файла");
  await expect(panel.getByText("Файлы не найдены", { exact: true })).toBeVisible();
  await panel.getByRole("button", { name: "Показать все файлы" }).click();
  await expect(search).toHaveValue("");
  await expect(rows).toHaveCount(10);
  await metrics.getByRole("button", { name: "Ошибки 2", exact: true }).click();
  await expandCandidateGroups(panel);
  await expect(rows).toHaveCount(2);
  await expect(panel.getByRole("button", { name: "Повторить", exact: true })).toHaveCount(1);
  await expect(panel.getByText("Лимит попыток исчерпан. Загрузите файл заново.")).toBeVisible();
  await panel.getByRole("button", { name: "Повторить", exact: true }).click();
  await expect(panel.getByRole("alert")).toContainText("Повторная отправка временно недоступна");
  failDetails = true;
  await panel.getByRole("button", { name: "Обновить", exact: true }).click();
  await expect(panel.getByText(/Не удалось обновить общий статус/)).toBeVisible();
  await expect(rows).toHaveCount(2);
  await expect(panel.getByText("Ожидаем восстановления связи", { exact: true })).toBeVisible();
  await expect(panel.locator(".import-analysis--stale")).toBeVisible();
  await expect(panel.locator(".import-analysis-activity")).toHaveCount(0);
  failDetails = false;
  await panel.getByRole("button", { name: "Обновить", exact: true }).click();
  await expect(panel.getByText(/Не удалось обновить общий статус/)).toHaveCount(0);
  await expect(panel.getByRole("alert")).toContainText("Повторная отправка временно недоступна");
  await panel.getByRole("button", { name: "Повторить", exact: true }).click();
  await expect(panel.getByRole("button", { name: "Отправляем…", exact: true })).toBeDisabled();
  await expect.poll(() => Boolean(releaseRetry)).toBe(true);
  await metrics.getByRole("button", { name: "Всего файлов 25", exact: true }).click();
  await panel.locator(".import-scope-options > summary").click();
  const scope = panel.getByLabel("Фильтр списка по загрузке");
  await expect(scope.locator("option")).toHaveCount(4);
  await expect(scope).not.toContainText(older.archive_name);
  await scope.selectOption(second.id);
  await expect(rows).toHaveCount(1);
  await expect(rows).toContainText("Другой_кандидат.pdf");
  await expect(panel.getByRole("progressbar")).toHaveAttribute("aria-valuemax", "25");
  await expect(panel.getByLabel("Текущий анализ")).toContainText("Кандидат_2.pdf");
  releaseRetry!();
  await expect(panel.getByRole("button", { name: "Обновить", exact: true })).toBeEnabled();
  await expect(rows).toContainText("Другой_кандидат.pdf");
  await metrics.getByRole("button", { name: "Загружаются 2", exact: true }).click();
  await expect(scope).toHaveValue("");
  await expect(rows).toHaveCount(2);
  await expect(rows.filter({ hasText: "Кандидат_0.pdf" })).toContainText("Попытка 2");
  for (const width of [1024, 390, 320]) {
    await page.setViewportSize({ width, height: 844 });
    await expect(metrics.getByRole("button", { name: "Ошибки 1", exact: true })).toBeVisible();
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false, `${width}px: horizontal overflow`);
  }
  await listToggle.click();
  await expect(rows.first()).toBeHidden();
  await expect(panel.getByLabel("Текущий анализ")).toBeVisible();
  await panel.screenshot({ path: ".qa/resume-compact-closed-mobile.png" });
  await metrics.getByRole("button", { name: "Загружаются 2", exact: true }).click();
  await expect(listToggle).toHaveAttribute("aria-expanded", "true");
  await panel.screenshot({ path: ".qa/resume-tracking-mobile.png" });
  await page.setViewportSize({ width: 1440, height: 1100 });
  await metrics.getByRole("button", { name: "Всего файлов 25", exact: true }).click();
  await scope.selectOption(queued.id);
  await expect(rows).toHaveCount(1);
  await expect(rows).toContainText("Ожидает анализа");
  await expect(panel.getByRole("heading", { name: "Идёт анализ резюме", exact: true })).toBeVisible();
  await expect(panel.getByLabel("Текущий анализ")).toContainText("Кандидат_2.pdf");
  queued.processing_files = 1;
  queued.items[0].status = "processing";
  queued.items[0].updated_at = new Date().toISOString();
  await panel.getByRole("button", { name: "Обновить", exact: true }).click();
  await expect(panel.getByRole("heading", { name: "Идёт анализ резюме", exact: true })).toBeVisible();
  await expect(panel.getByRole("progressbar")).toHaveAttribute("aria-valuenow", "19");
  await expect(panel.getByLabel("Текущий анализ")).toContainText("Ожидающий_файл.pdf");
  await expect(panel.getByLabel("Текущий анализ")).toContainText("Кандидат_2.pdf");
  const elapsed = panel.locator(".import-analysis-files li").filter({ hasText: "Ожидающий_файл.pdf" }).locator("span");
  const initialElapsed = await elapsed.innerText();
  await expect(elapsed).not.toHaveText(initialElapsed);
  await panel.screenshot({ path: ".qa/resume-analysis-active-desktop.png" });
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(panel.getByLabel("Текущий анализ")).toBeVisible();
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false);
  await panel.screenshot({ path: ".qa/resume-analysis-active-mobile.png" });
  queued.processing_files = 0; queued.pending_files = 0; queued.processed_files = 1;
  queued.items[0].status = "completed";
  first.items = first.items.map(item => ["pending", "processing", "uploading"].includes(item.status) ? { ...item, status: "completed" } : item);
  first.processed_files = 22; first.pending_files = 0; first.uploading_files = 0; first.processing_files = 0;
  await panel.getByRole("button", { name: "Обновить", exact: true }).click();
  await expect(panel.getByRole("heading", { name: "Обработка завершена с ошибками", exact: true })).toBeVisible();
  await expect(panel.getByLabel("Текущий анализ")).toHaveCount(0);
  await expect(panel.getByRole("progressbar")).toHaveAttribute("aria-valuenow", "25");
  await page.clock.setFixedTime(Date.now() + 60 * 60 * 1000 + 1);
  await expect(panel.getByText("За последний час загрузок не было.", { exact: true })).toBeVisible();
  await expect(panel.getByRole("progressbar")).toHaveCount(0);
  await expect(panel.getByRole("button", { name: "Список загрузок", exact: true })).toHaveCount(0);
  await expect(panel.getByLabel("Текущий анализ")).toHaveCount(0);
  await page.goto(base + "/submit");
  await expect(panel.getByRole("progressbar")).toHaveAttribute("aria-valuemax", "26");
  await expect(panel.locator(".import-heading").getByText("Все загрузки", { exact: true })).toBeVisible();
  await expect(panel.getByLabel("Текущий анализ")).toContainText(older.archive_name);
  assert.deepEqual(errors, []);
  await context.close();
  const groupedContext = await browser.newContext({ viewport: { width: 1440, height: 1100 } });
  const groupedPage = await groupedContext.newPage();
  const groupNow = new Date().toISOString();
  const groupCandidate: Candidate = { id: "candidate-one", resume_id: "resume-one", file_id: "file-one", file_name: "resume.pdf",
    last_name: "Иванов", first_name: "Иван", middle_name: null, phone: "+79991234567", mime_type: "application/pdf",
    status: "in_work", scoring_status: "completed", created_at: groupNow, updated_at: groupNow,
    blacklisted: false, has_other_resume_in_process: false, other_resumes_count: 0, ratings: [] };
  const groupOther = { ...groupCandidate, id: "candidate-two", resume_id: "resume-two", last_name: "Петров", phone: "+79997654321" };
  const groupItem = (id: string, extra: Partial<ResumeImportDetail["items"][number]> = {}): ResumeImportDetail["items"][number] => ({
    id, file_name: "resume.pdf", source_path: "resume.pdf", status: "completed", attempt: 1, error: null, warning: null,
    candidate_id: null, resume_id: null, updated_at: groupNow, analysis_duration_ms: 329000, ...extra,
  });
  const groupedFiles = [
    groupItem("old-failure", { status: "failed", file_sha256: "a".repeat(64), error: "Старая ошибка анализа." }),
    groupItem("success", { file_name: "updated.pdf", candidate_id: groupCandidate.id, resume_id: groupCandidate.resume_id, file_sha256: "a".repeat(64) }),
    groupItem("pending", { status: "pending", target_resume_id: groupCandidate.resume_id, file_sha256: "b".repeat(64), analysis_duration_ms: null }),
    groupItem("copy", { file_name: "copy.pdf", file_sha256: "a".repeat(64) }),
    groupItem("other-candidate", { candidate_id: groupOther.id, resume_id: groupOther.resume_id, file_sha256: "c".repeat(64) }),
    groupItem("unidentified", { file_sha256: "d".repeat(64) }),
  ];
  const groupedBatches = () => groupedFiles.map((item, index): ResumeImportDetail => ({
    id: `group-batch-${index}`, archive_name: item.file_name, created_at: groupNow, total_files: 1,
    processed_files: Number(item.status === "completed"), failed_files: Number(item.status === "failed"),
    pending_files: Number(["pending", "processing", "uploading"].includes(item.status)), uploading_files: 0, processing_files: 0,
    ignored_files: [], items: [item],
  }));
  await groupedPage.route("**/api/**", route => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/api/overview") return route.fulfill({ json: { candidates: [groupCandidate, groupOther], clusters: [], blacklist: [], resumeImports: groupedBatches() } });
    if (path === "/api/resume-imports/status") return route.fulfill({ json: groupedBatches() });
    if (path === "/api/analysis/status") return route.fulfill({ json: { available: true, message: "Готово" } });
    return route.fulfill({ json: { available: true, analysis_consumers: 1, queues: {} } });
  });
  await groupedPage.goto(base + "/submit");
  const groupedPanel = groupedPage.getByRole("region", { name: "Массовая обработка резюме" });
  await groupedPanel.getByRole("button", { name: "Список загрузок", exact: true }).click();
  const candidateGroups = groupedPanel.locator(".import-candidate-group");
  await expect(candidateGroups).toHaveCount(3);
  await expect(groupedPanel.locator(".import-list-footer")).toContainText("1–3 из 3 кандидатов");
  const john = candidateGroups.filter({ has: groupedPage.locator(".import-candidate-name strong", { hasText: "Иванов Иван" }) });
  await expect(john).not.toHaveAttribute("open");
  await expect(john.locator("summary")).toContainText("Загрузок: 4");
  await expect(john.locator(".import-candidate-status")).toHaveText("Ожидает анализа");
  await john.locator("summary").click();
  await expect(john.locator(".import-file")).toHaveCount(4);
  await expect(john.getByText("Старая ошибка анализа.", { exact: true })).toBeVisible();
  const groupedSearch = groupedPanel.getByRole("textbox", { name: "Поиск файлов загрузки" });
  await groupedSearch.fill("+79991234567");
  await expect(candidateGroups).toHaveCount(1);
  await expect(john.locator(".import-file")).toHaveCount(4);
  await groupedSearch.fill("copy.pdf");
  await expect(john.locator(".import-file")).toHaveCount(1);
  await expect(john.locator("summary")).toContainText("Загрузок: 4 · показано: 1");
  await groupedSearch.fill("");
  groupedFiles[2] = { ...groupedFiles[2], status: "completed", candidate_id: groupCandidate.id, resume_id: groupCandidate.resume_id,
    analysis_duration_ms: 61000, updated_at: new Date(Date.parse(groupNow) + 1000).toISOString() };
  await groupedPanel.getByRole("button", { name: "Обновить", exact: true }).click();
  await expect(john.locator(".import-candidate-status")).toHaveText("Готово");
  await expect(john).toHaveAttribute("open");
  await expect(john.locator(".import-file").first()).toContainText("Время анализа: 1 мин 1 с");
  await groupedPanel.screenshot({ path: ".qa/import-candidate-groups-desktop.png" });
  for (const width of [390, 320]) {
    await groupedPage.setViewportSize({ width, height: 844 });
    assert.equal(await groupedPage.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false, `${width}px: grouped uploads overflow`);
  }
  await groupedPanel.screenshot({ path: ".qa/import-candidate-groups-mobile.png" });
  await groupedPanel.getByRole("button", { name: "Ошибки 1", exact: true }).click();
  await expect(candidateGroups).toHaveCount(1);
  await expect(john.locator(".import-file")).toHaveCount(1);
  await expect(john.locator("summary")).toContainText("Загрузок: 4 · показано: 1");
  await expect(john.locator(".import-candidate-status")).toHaveText("Ошибка");
  await groupedContext.close();
  console.log("PASS: ZIP upload, last-hour processing scope, UTC/Moscow dates, automatic expiry, preserved intake history, global counts/active files, filters, search, retries and responsive tracking.");
} finally { await browser.close(); }
