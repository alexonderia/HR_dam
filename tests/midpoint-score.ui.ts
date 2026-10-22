import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { chromium, expect } from "@playwright/test";

const fixtures = JSON.parse(await readFile(new URL("./fixtures/evidence-ratings.json", import.meta.url), "utf8"));
const browser = await chromium.launch({ channel: process.env.TEST_BROWSER_CHANNEL });
try {
  const page = await browser.newPage();
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  for (const name of ["range_v2_22_87", "midpoint_v3_range_v2_22_87"]) {
    const fixture = fixtures.find((f: { name: string }) => f.name === name);
    const cluster = { ...fixture.requirements[0], name: "QA", track: "it", comment: "", is_active: true };
    cluster.profiles = cluster.profiles.map((p: object) => ({ ...p, cluster_id: cluster.id, position_name: "QA", is_active: true }));
    const rating = fixture.result.clusters[0].profiles[0];
    const candidate = { id: "candidate", resume_id: "resume", file_id: "file", file_name: "resume.txt", mime_type: "text/plain",
      last_name: "Test", first_name: "Candidate", phone: null, status: "in_work", scoring_status: "completed", blacklisted: false,
      created_at: "2026-10-22T08:00:00+03:00", updated_at: "2026-10-22T08:00:00+03:00",
      ratings: [{ ...rating, profile_id: rating.id, calculated_at: "2026-10-22T08:00:00+03:00" }] };
    await page.unrouteAll();
    await page.route("**/api/**", route => {
      const path = new URL(route.request().url()).pathname;
      return route.fulfill({ json: path.endsWith("/overview") ? { clusters: [cluster], candidates: [candidate], blacklist: [], resumeImports: [] }
        : path.endsWith("/analysis/status") ? { available: true } : path.endsWith("/events") ? [] : {} });
    });
    await page.goto(process.env.TEST_BASE_URL || "http://127.0.0.1:3000");
    await expect(page.locator(".matrix .score")).toHaveText("32,87");
    await page.getByRole("button", { name: "QA: детали рейтинга", exact: true }).click();
    const dialog = page.getByRole("dialog");
    await expect(dialog.locator(".score")).toHaveText(["32,87", "32,87"]);
    await dialog.locator("details summary").first().click();
    await expect(dialog.locator(".explanation-text")).toContainText("32.87/100");
    await expect(dialog).not.toContainText(/диапазон/iu);
  }
  assert.deepEqual(errors, []);
  console.log("PASS: legacy and v3 results show one midpoint in the matrix, profile and explanation");
} finally { await browser.close(); }
