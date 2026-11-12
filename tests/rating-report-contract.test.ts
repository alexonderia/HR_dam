import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { ratingAnalysis, explainEvidenceRating, ratingAnalysisText, ratingScoreText, ratingRangeText, formatExperienceDuration } from "@hr/contracts";
import { ratingAnalysisHtml } from "../apps/backend/src/export.js";

const fixtures = JSON.parse(readFileSync(new URL("./fixtures/evidence-ratings.json", import.meta.url), "utf8"));

test("report presentation preserves evaluator experience facts and statuses without a second semantic assessment", () => {
  const rating = structuredClone(fixtures.find((fixture: { name: string }) => fixture.name === "moskalenko_15_of_36_months").result.clusters[0].profiles[0]);
  const criterion = rating.details.criteria[0];
  Object.assign(criterion, { status: "met", experience_months: 276, credit: 1, possible_credit: 1,
    evidence: [{ quote: "23 года", start: 0, end: 7 }] });
  delete criterion.total_experience_months;
  Object.assign(rating.details, { source_text_length: 7, coverage: 100, score_range: { min: 100, max: 100 } });
  rating.score = 100;
  const before = structuredClone(rating), report = ratingAnalysis(rating);
  const displayed = report.groups.find(group => group.status === "met")!.items;
  assert.equal(displayed.length, 1);
  assert.equal(displayed[0].requirement, criterion.requirement);
  assert.deepEqual(displayed[0].quotes, ["23 года"]);
  assert.deepEqual(report.missing, []);
  assert.match(explainEvidenceRating(report.evidence!), /Подтверждено:/);
  assert.match(explainEvidenceRating(report.evidence!), /23 года/);
  assert.match(ratingAnalysisHtml(rating), /23 года/);
  assert.match(ratingAnalysisText(rating).groups.find(group => group.title === "Подтверждено")!.text, /23 года/);
  assert.equal(ratingScoreText(rating), "100");
  assert.equal(ratingRangeText(rating), "100–100");
  assert.deepEqual(rating, before);
});

test("unreported skills are compactly formatted without changing the supplied comparisons", () => {
  const rating = fixtures.find((fixture: { name: string }) => fixture.name === "mironova_unsupported_stack").result.clusters[0].profiles[0];
  const before = structuredClone(rating), report = ratingAnalysis(rating);
  assert.equal(report.skills.length, 0);
  assert.equal(report.groups.flatMap(group => group.items).length, 0);
  assert.deepEqual(report.missing, [{ label: "Навыки", count: 6 }]);
  assert.doesNotMatch(ratingAnalysisHtml(rating), /Python|Pandas|React|Неизвестные сведения|Однозначное соответствие/);
  assert.match(ratingAnalysisHtml(rating), /Не указано/);
  assert.deepEqual(rating, before);
});

test("experience duration formatting changes units and wording only", () => {
  assert.equal(formatExperienceDuration(276), "23 года");
  assert.equal(formatExperienceDuration(36), "3 года");
  assert.equal(formatExperienceDuration(15), "1 год 3 месяца");
});
