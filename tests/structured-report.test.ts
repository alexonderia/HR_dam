import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { unzipSync, strFromU8 } from "fflate";
import { ratingAnalysis, ratingRangeText, ratingScoreText, type Candidate, type Cluster } from "@hr/contracts";
import { reportHtml, ratingAnalysisHtml, exportCsv } from "../apps/backend/src/export.js";
import { ratingRows, matrixRows, createExport, exportOptionsSchema } from "../apps/backend/src/export-options.js";

const fixtures = JSON.parse(readFileSync(new URL("./fixtures/evidence-ratings.json", import.meta.url), "utf8"));
const fixture = fixtures.find((f: { name: string }) => f.name === "unknown_is_not_absent");
const rating = fixture.result.clusters[0].profiles[0];
const cluster: Cluster = { ...fixture.requirements[0], name: "Тестовый кластер", track: "it", is_active: true, comment: "",
  profiles: fixture.requirements[0].profiles.map((profile: object) => ({ ...profile, cluster_id: fixture.requirements[0].id, is_active: true })) };
const candidate: Candidate = { id: "10000000-0000-4000-8000-000000000001", resume_id: "20000000-0000-4000-8000-000000000001",
  last_name: "Тестовый", first_name: "Кандидат", middle_name: null, phone: null, status: "in_work", scoring_status: "completed",
  file_id: "30000000-0000-4000-8000-000000000001", file_name: "synthetic.txt", mime_type: "text/plain",
  created_at: "2026-11-11T10:00:00Z", updated_at: "2026-11-11T10:00:00Z", blacklisted: false, other_resumes_count: 0,
  has_other_resume_in_process: false, ratings: [{ ...rating, profile_id: rating.id, calculated_at: "2026-11-11T10:00:00Z" }] };

test("structured analysis preserves every criterion, status and source quote without changing the score", () => {
  for (const fixture of fixtures) {
    const rating = fixture.result.clusters[0].profiles[0], before = structuredClone(rating);
    const report = ratingAnalysis(rating);
    assert.equal(ratingScoreText(rating), String(rating.score));
    const format = (value: number) => value.toLocaleString("ru-RU", { maximumFractionDigits: 2 });
    assert.equal(ratingRangeText(rating), `${format(rating.details.score_range.min)}–${format(rating.details.score_range.max)}`);
    assert.equal(report.groups.reduce((n, group) => n + group.items.length, 0) + report.skills.reduce((n, group) => n + group.items.length, 0) + report.missing.reduce((n, field) => n + field.count, 0), rating.details.criteria.length);
    for (const group of report.groups) {
      const criteria = rating.details.criteria.filter((criterion: { status: string; category: string }) => criterion.category !== "keyword" && criterion.status !== "unknown" && criterion.status === group.status);
      assert.deepEqual(group.items.map(item => item.requirement), criteria.map((criterion: { requirement: string }) => criterion.requirement));
      assert.deepEqual(group.items.flatMap(item => item.quotes), criteria.flatMap((criterion: { evidence: { quote: string }[] }) => criterion.evidence.map(e => e.quote)));
    }
    assert.deepEqual(rating, before);
  }
});

test("HTML and print reports separate the primary score from the range and render criterion groups and escaped quotes", () => {
  const html = reportHtml(candidate, [cluster], false);
  assert.match(html, /class="primary-score">50 \/ 100<\/td>/);
  assert.match(html, /<th>Диапазон по доступным сведениям<\/th>/);
  assert.match(html, /<td>50–100<\/td>/);
  assert.match(html, /Навыки/);
  assert.match(html, /Не указано/);
  assert.match(html, /<blockquote>SQL<\/blockquote>/);
  assert.doesNotMatch(html, /primary-score">50–100/);
  const unsafe = structuredClone(rating);
  unsafe.details.criteria[0].evidence[0].quote = '<script>alert("x")</script>';
  const escaped = ratingAnalysisHtml(unsafe);
  assert.doesNotMatch(escaped, /<script>/);
  assert.match(escaped, /&lt;script&gt;/);
});

test("CSV and Excel keep scores numeric and place ranges, coverage and statuses in separate columns", () => {
  const rows = ratingRows([candidate], [cluster], true), header = rows[0], row = rows[1];
  assert.equal(row[header.indexOf("Основная оценка")], 50);
  assert.equal(row[header.indexOf("Диапазон по доступным сведениям")], "50–100");
  assert.equal(row[header.indexOf("Охват критериев, %")], 50);
  assert.match(String(row[header.indexOf("Подтверждено")]), /SQL/);
  assert.match(String(row[header.indexOf("Не указано")]), /Навыки: Не указано/);
  assert.equal(matrixRows([candidate], [cluster], [cluster.id])[1][1], 50);
  const options = exportOptionsSchema.parse({ candidateReport: true, format: "xlsx" });
  const files = unzipSync(createExport([candidate], [cluster], options).body as Buffer);
  const xml = strFromU8(files["xl/worksheets/sheet1.xml"]);
  assert.match(xml, /r="D2" s="0" t="n"><v>50<\/v>/);
  assert.match(xml, /r="E2"[^>]*>.*?50–100/);
  assert.match(exportCsv([candidate], [cluster]), /Диапазон/);
});

test("legacy reports keep their score and explanation without inventing a range or criterion statuses", () => {
  const legacy = { score: 73.25, explanation: "Сохранённое объяснение", matched_keywords: [], triggered_stop_factors: [] };
  const analysis = ratingAnalysis(legacy);
  assert.equal(ratingScoreText(legacy), "73.25");
  assert.equal(analysis.range, "");
  assert.equal(analysis.groups.flatMap(group => group.items).length, 0);
  assert.equal(analysis.legacyExplanation, legacy.explanation);
  assert.match(ratingAnalysisHtml(legacy), /Сохранённое объяснение/);
});
