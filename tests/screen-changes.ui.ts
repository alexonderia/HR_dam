import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { chromium, expect } from "@playwright/test";
import { unzipSync, strFromU8 } from "fflate";
import type { Candidate, Cluster } from "@hr/contracts";
import {
  createExport,
  exportOptionsSchema,
} from "../apps/backend/src/export-options.js";

const base = process.env.TEST_BASE_URL || "http://127.0.0.1:5173";
const clusterId = "5cabfa83-676b-4084-9ec8-212658478b6b";
const cluster: Cluster = {
  id: clusterId,
  name: "Информационные технологии и автоматизация производства",
  track: "it",
  comment: "",
  is_active: true,
  profiles: [
    {
      id: "d5ebfa74-a6f9-44aa-9b93-43ce2d62fbfb",
      cluster_id: clusterId,
      position_name:
        "Разработчик программного обеспечения производственных систем с длинным названием",
      is_active: true,
      education: "",
      experience: "",
      keywords: [],
      stop_factors: [],
      comment: "",
    },
    {
      id: "a4ebfa74-a6f9-44aa-9b93-43ce2d62fbfb",
      cluster_id: clusterId,
      position_name: "Аналитик",
      is_active: false,
      education: "",
      experience: "",
      keywords: [],
      stop_factors: [],
      comment: "",
    },
  ],
};
const clusters = [
  {
    ...cluster,
    id: "e4ebfa74-a6f9-44aa-9b93-43ce2d62fbfb",
    name: "Неактивный кластер",
    is_active: false,
    profiles: [],
  },
  cluster,
];
const candidate: Candidate = {
  id: "b4ebfa74-a6f9-44aa-9b93-43ce2d62fbfb",
  resume_id: "c4ebfa74-a6f9-44aa-9b93-43ce2d62fbfb",
  last_name: "Иванов",
  first_name: "Иван",
  middle_name: "",
  phone: "+79991234567",
  status: "in_work",
  scoring_status: "completed",
  file_id: "f4ebfa74-a6f9-44aa-9b93-43ce2d62fbfb",
  file_name: "resume.txt",
  mime_type: "text/plain",
  created_at: "2026-10-14T08:00:00Z",
  updated_at: "2026-10-14T08:00:00Z",
  blacklisted: false,
  other_resumes_count: 0,
  ratings: cluster.profiles.map((p, i) => ({
    profile_id: p.id,
    score: 80 - i * 30,
    calculated_at: "2026-10-14T08:00:00Z",
    explanation:
      "Опыт соответствует требованиям.\nПроверено образование и опыт работы.",
    matched_keywords: ["SQL", "Python"],
    triggered_stop_factors: i ? ["Недостаточно опыта"] : [],
  })),
};
const candidates = [
  candidate,
  {
    ...candidate,
    id: "a5ebfa74-a6f9-44aa-9b93-43ce2d62fbfb",
    resume_id: "a6ebfa74-a6f9-44aa-9b93-43ce2d62fbfb",
    last_name: "Петров",
    phone: "+79991234568",
  },
];
const browser = await chromium.launch({
  channel: process.env.TEST_BROWSER_CHANNEL,
});
try {
  const context = await browser.newContext({
    viewport: { width: 1440, height: 1000 },
  });
  await context.addInitScript(() => {
    window.print = () => {
      document.body.dataset.printed = "true";
    };
  });
  const page = await context.newPage();
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  let profileBody: { keywords: string[]; stop_factors: string[] } | undefined;
  await page.route("**/api/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith("/overview"))
      return route.fulfill({ json: { clusters, candidates, blacklist: [] } });
    if (path.endsWith("/analysis/status"))
      return route.fulfill({ json: { available: true, message: "Готово" } });
    if (path.endsWith("/events"))
      return route.fulfill({
        json: [
          ...Array.from({ length: 5 }, (_, i) => ({
            id: `earlier-${i}`,
            event_type: "uploaded",
            message: `Предыдущее событие ${i}`,
            created_at: `2026-10-12T0${i}:00:00Z`,
          })),
          {
            id: "old",
            event_type: "uploaded",
            message: "Старое событие",
            created_at: "2026-10-13T08:00:00Z",
          },
          {
            id: "new",
            event_type: "scored",
            message: "Новое событие",
            created_at: "2026-10-14T08:00:00Z",
          },
        ],
      });
    if (path.endsWith("/status")) {
      const body = route.request().postDataJSON();
      candidate.status = body.status;
      return route.fulfill({ json: { ok: true } });
    }
    if (path.endsWith("/blacklist")) {
      candidate.blacklisted = true;
      return route.fulfill({ json: { id: "blocked" } });
    }
    if (path.endsWith("/profiles")) {
      profileBody = route.request().postDataJSON();
      return route.fulfill({ json: { id: "profile" } });
    }
    if (path.endsWith("/export")) {
      const options = exportOptionsSchema.parse(route.request().postDataJSON());
      const result = createExport(
        candidates.filter((c) => options.candidate_ids.includes(c.id)),
        clusters.filter((c) => options.cluster_ids.includes(c.id)),
        options,
      );
      return route.fulfill({ body: result.body, contentType: result.mime });
    }
    if (path.includes("/files/"))
      return route.fulfill({
        body: "<!doctype html><html><body>Текст резюме</body></html>",
        contentType: "text/html",
      });
    return route.fulfill({ status: 404, json: { error: path } });
  });
  await mkdir(".qa", { recursive: true });
  await page.goto(base);
  const matrixWidth = await page.locator(".matrix-scroll").evaluate(element => ({
    viewport: element.clientWidth,
    table: element.querySelector("table")!.getBoundingClientRect().width,
  }));
  assert.ok(matrixWidth.table >= matrixWidth.viewport - 1);
  await page.locator(".cluster-header").click();
  assert.equal(await page.locator(".matrix thead tr").count(), 1);
  assert.equal(await page.locator(".matrix thead th").count(), 6);
  const cells = await page.locator(".matrix thead th").evaluateAll((nodes) =>
    nodes.map((n) => {
      const r = n.getBoundingClientRect();
      return { left: r.left, right: r.right };
    }),
  );
  for (let i = 1; i < cells.length; i++)
    assert.ok(cells[i].left >= cells[i - 1].right - 1);
  await page.setViewportSize({ width: 1100, height: 1000 });
  const before = await page.locator(".matrix tbody td").first().boundingBox();
  await page.locator(".matrix-scroll").evaluate((n) => {
    n.scrollLeft = 400;
  });
  assert.ok(
    await page.locator(".matrix-scroll").evaluate((n) => n.scrollLeft > 0),
  );
  const after = await page.locator(".matrix tbody td").first().boundingBox();
  assert.equal(before?.x, after?.x);
  await page.screenshot({
    path: ".qa/matrix-expanded-sticky.png",
    fullPage: true,
  });
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.locator(".matrix-scroll").evaluate((n) => {
    n.scrollLeft = 0;
  });
  await page
    .getByRole("button", {
      name: cluster.profiles[0].position_name + ": детали рейтинга",
      exact: true,
    })
    .first()
    .click();
  const target = page.locator(`[data-rating-id="${cluster.profiles[0].id}"]`);
  await expect(target).toHaveAttribute("open", "");
  await expect(target).toBeInViewport();
  await expect(page.locator(".profile-column").first().locator("small")).toHaveCount(0);
  await expect(page.locator(".cluster-column--expanded")).toHaveCount(1);
  const position = await target.evaluate((element) => {
    const dialog = element.closest("dialog")!;
    const header = dialog.querySelector(".dialog-header")!;
    return {
      targetTop: element.getBoundingClientRect().top,
      headerBottom: header.getBoundingClientRect().bottom,
      outline: getComputedStyle(element).outlineStyle,
      pageScroll: window.scrollY,
    };
  });
  assert.ok(position.targetTop >= position.headerBottom);
  assert.equal(position.outline, "none");
  assert.equal(position.pageScroll, 0);
  await expect(
    page.getByText("Последняя обработка:", { exact: false }),
  ).toHaveCount(1);
  await page.screenshot({
    path: ".qa/candidate-rating-focus.png",
    fullPage: true,
  });
  await page
    .getByRole("button", { name: "Открыть резюме", exact: true })
    .click();
  await expect(page.getByRole("dialog")).toHaveCount(1);
  await expect(page.getByTitle("Предпросмотр резюме")).toBeVisible();
  await page
    .getByRole("button", { name: "Вернуться к карточке", exact: true })
    .click();
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Закрыть", exact: true })
    .first()
    .click();
  await page.getByRole("button", { name: "Экспорт", exact: true }).click();
  await page.getByLabel("Содержание").selectOption("table");
  const downloadEvent = page.waitForEvent("download");
  await page.getByRole("button", { name: "Скачать", exact: true }).click();
  const download = await downloadEvent;
  await download.saveAs(".qa/matrix-ui.xlsx");
  const { readFile } = await import("node:fs/promises");
  const exported = unzipSync(await readFile(".qa/matrix-ui.xlsx"));
  assert.match(
    strFromU8(exported["xl/worksheets/sheet1.xml"]),
    /Разработчик программного/,
  );
  await page.getByRole("button", { name: "Печать", exact: true }).click();
  await page.getByLabel("Содержание").selectOption("table");
  await page.getByLabel("Добавить отдельный отчёт каждого кандидата").check();
  const popupEvent = page.waitForEvent("popup");
  await page
    .getByRole("button", { name: "Перейти к печати", exact: true })
    .click();
  const popup = await popupEvent;
  await expect(popup.locator(".individual-report")).toHaveCount(2);
  await expect(popup.locator("body")).toHaveAttribute("data-printed", "true");
  await expect(
    popup.locator(".af-table").first().locator("thead tr"),
  ).toHaveCount(1);
  await popup.close();

  await page.goto(base + "/submit");
  await page
    .getByRole("textbox", { name: "Телефон", exact: true })
    .fill("8 (999) 123-45-67");
  await expect(
    page.getByRole("textbox", { name: "Телефон", exact: true }),
  ).toHaveValue("(999) 123-45-67");
  await page.getByLabel("Страна номера").selectOption("BY");
  await page
    .getByRole("textbox", { name: "Телефон", exact: true })
    .fill("+375291234567");
  await expect(
    page.getByRole("textbox", { name: "Телефон", exact: true }),
  ).toHaveValue("291234567");
  await expect(
    page.getByText("Обновить резюме, если телефон и ФИО уже есть в базе"),
  ).toHaveCount(0);
  await page.screenshot({ path: ".qa/submission-phone.png", fullPage: true });

  await page.goto(base + "/processing");
  await expect(page.locator(".event-list .event").first()).toContainText(
    "Новое событие",
  );
  await expect(page.locator(".event-list .event")).toHaveCount(5);
  await page.getByRole("button", { name: "Следующие события" }).click();
  await expect(page.locator(".event-list .event")).toHaveCount(2);
  await page.getByRole("button", { name: "Предыдущие события" }).click();
  await expect(page.locator(".event-list .event").first()).toContainText("Новое событие");
  await page.getByLabel("Информация о статусах").click();
  const alignment = await page.locator(".processing-actions").evaluate(element => {
    const select = element.querySelector("select")!.getBoundingClientRect();
    const button = element.querySelector(":scope > button")!.getBoundingClientRect();
    const tip = element.querySelector(".status-info-content")!.getBoundingClientRect();
    const card = element.closest(".processing-detail")!.getBoundingClientRect();
    return { selectBottom: select.bottom, buttonBottom: button.bottom, tipLeft: tip.left, cardLeft: card.left };
  });
  assert.ok(Math.abs(alignment.selectBottom - alignment.buttonBottom) <= 1);
  assert.ok(alignment.tipLeft > alignment.cardLeft + 16);
  await page.getByLabel("Информация о статусах").click();
  await page.getByLabel("Поиск кандидатов").fill("Петров");
  await expect(page.locator(".queue-item")).toHaveCount(1);
  await page.getByLabel("Поиск кандидатов").fill("Иванов");
  await page
    .getByLabel("Статус кандидата", { exact: true })
    .selectOption("in_process");
  await expect(page.getByRole("dialog", { name: "Изменить статус кандидата" })).toBeVisible();
  await expect(page.getByLabel("Статус кандидата", { exact: true })).toHaveValue("in_work");
  await page.getByRole("button", { name: "Отмена", exact: true }).click();
  await page.getByLabel("Статус кандидата", { exact: true }).selectOption("in_process");
  await page.getByRole("button", { name: "Подтвердить", exact: true }).click();
  await expect(
    page.getByLabel("Статус кандидата", { exact: true }),
  ).toHaveValue("in_process");
  await page
    .getByLabel("Статус кандидата", { exact: true })
    .selectOption("historical");
  await page.getByLabel("Итог отбора").selectOption("rejected_all");
  await page
    .getByRole("button", { name: "Заархивировать", exact: true })
    .click();
  await expect(
    page.getByLabel("Статус кандидата", { exact: true }),
  ).toHaveValue("historical");
  await page
    .getByRole("button", { name: "В чёрный список", exact: true })
    .click();
  await page.getByLabel("Компания").fill("Тестовая компания");
  await page
    .getByRole("button", { name: "Добавить в чёрный список", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "В чёрном списке", exact: true }),
  ).toBeDisabled();
  await page.screenshot({
    path: ".qa/processing-workflow.png",
    fullPage: true,
  });

  await page.goto(base + "/requirements");
  await expect(page.locator(".cluster-toggle").first()).toContainText(
    cluster.name,
  );
  assert.equal(
    await page.locator('.cluster-toggle[aria-expanded="true"]').count(),
    0,
  );
  await page.locator(".cluster-toggle").first().click();
  await expect(
    page.locator(".requirements-table tbody tr").first(),
  ).toContainText(cluster.profiles[0].position_name);
  await page
    .locator(".cluster-panel")
    .first()
    .getByRole("button", { name: "Профиль", exact: true })
    .click();
  await page.getByLabel("Название профиля / должности").fill("Новый профиль");
  await page
    .getByLabel("Ключевые слова", { exact: true })
    .fill("Python, SQL; REST\nPython");
  await page.getByLabel("Стоп-факторы", { exact: true }).fill("Первый, Второй");
  await page
    .getByRole("button", { name: "Сохранить профиль", exact: true })
    .click();
  assert.deepEqual(profileBody?.keywords, ["Python", "SQL", "REST"]);
  assert.deepEqual(profileBody?.stop_factors, ["Первый", "Второй"]);

  await page.setViewportSize({ width: 390, height: 844 });
  for (const path of [
    "/",
    "/submit",
    "/processing",
    "/requirements",
    "/blacklist",
  ]) {
    await page.goto(base + path);
    await expect(page.locator("main h1")).toBeVisible();
    assert.ok(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
      `Overflow: ${path}`,
    );
  }
  assert.deepEqual(errors, []);
  console.log(
    "UI passed: one-row matrix, sticky candidate column, rating focus, single resume dialog, Excel download, country phone input, search, workflow/archive, blacklist, journal, collapsed/sorted requirements, comma delimiters and all mobile routes.",
  );
} finally {
  await browser.close();
}
