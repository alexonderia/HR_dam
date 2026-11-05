import assert from "node:assert/strict";
import { chromium, expect } from "@playwright/test";
import { type Candidate, type ContactRecoveryPreview } from "@hr/contracts";
import { contactResult } from "./fixtures/contact-result.js";

const base = process.env.TEST_BASE_URL || "http://127.0.0.1:5173";
const browser = await chromium.launch({ channel: process.env.TEST_BROWSER_CHANNEL });
try {
  for (const viewport of [{ width: 1440, height: 1000 }, { width: 390, height: 844 }]) {
    const page = await browser.newPage({ viewport });
    const errors: string[] = [];
    page.on("pageerror", error => errors.push(error.message));
    const contacts = contactResult({ last_name: "Румянцева", first_name: "Дарья", middle_name: "Константиновна" });
    const now = new Date().toISOString();
    const candidate: Candidate = { id: "c0000000-0000-4000-8000-000000000001", resume_id: "e0000000-0000-4000-8000-000000000001",
      file_id: "f0000000-0000-4000-8000-000000000001", last_name: "Румянцева", first_name: "Дарья", middle_name: null, phone: null,
      file_name: "resume.docx", mime_type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", status: "in_work",
      scoring_status: "completed", created_at: now, updated_at: now, blacklisted: false, has_other_resume_in_process: false,
      other_resumes_count: 0, ratings: [] };
    const preview: ContactRecoveryPreview = { ...contacts, revision: "a".repeat(64), protected_fields: ["last_name", "first_name"],
      changes: [{ field: "middle_name", previous: null, value: "Константиновна", evidence: contacts.contact_details.fields.middle_name! }] };
    let failApply = true, previews = 0, applications = 0, scoringCalls = 0;
    await page.route("**/api/**", async route => {
      const path = new URL(route.request().url()).pathname;
      if (path.endsWith("/overview")) return route.fulfill({ json: { candidates: [candidate], clusters: [], blacklist: [], resumeImports: [] } });
      if (path.endsWith("/analysis/status")) return route.fulfill({ json: { available: false, message: "Модель недоступна" } });
      if (path.endsWith("/contacts/preview")) { previews++; return route.fulfill({ json: preview }); }
      if (path.endsWith("/contacts/recover")) {
        applications++;
        assert.deepEqual(route.request().postDataJSON(), { revision: preview.revision });
        if (failApply) { failApply = false; return route.fulfill({ status: 409, json: { error: "Контакты изменились. Обновите просмотр." } }); }
        candidate.middle_name = "Константиновна";
        candidate.contact_provenance = { middle_name: { source: "resume_text", value: "Константиновна", evidence: contacts.contact_details.fields.middle_name! } };
        return route.fulfill({ json: { changed_fields: ["middle_name"], warnings: [] } });
      }
      if (path.endsWith("/retry")) scoringCalls++;
      return route.fulfill({ json: [] });
    });
    await page.goto(base);
    await page.getByRole("button", { name: /Румянцева Дарья/ }).first().click();
    const card = page.getByRole("dialog", { name: "Карточка кандидата" });
    await card.getByRole("button", { name: "Восстановить контакты", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "Восстановление контактов" });
    await expect(dialog.getByRole("cell", { name: "Константиновна", exact: true })).toBeVisible();
    await expect(dialog).toContainText("Защищены: фамилия, имя");
    await expect(dialog).toContainText("Высокая уверенность");
    await dialog.getByRole("button", { name: "Применить изменения" }).click();
    await expect(dialog).toContainText("Контакты изменились. Обновите просмотр.");
    await expect(dialog.getByRole("button", { name: "Применить изменения" })).toBeDisabled();
    await dialog.getByRole("button", { name: "Обновить просмотр" }).click();
    await expect(dialog.getByRole("button", { name: "Применить изменения" })).toBeEnabled();
    await dialog.getByRole("button", { name: "Применить изменения" }).click();
    await expect(dialog).not.toBeVisible();
    await expect(card).toBeVisible();
    await card.getByText("Источники контактов", { exact: true }).click();
    await expect(card).toContainText("Отчество: Константиновна");
    assert.equal(scoringCalls, 0);
    assert.equal(previews, 2); assert.equal(applications, 2);
    assert.deepEqual(errors, []);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false);
    await page.close();
  }
  console.log("Contact recovery UI passed on desktop/mobile with offline model, stale-preview handling, sources and zero scoring calls");
} finally { await browser.close(); }
