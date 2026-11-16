import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { scorePresentation, ratingAnalysis, ratingEstimateText } from "@hr/contracts";
import { ratingAnalysisHtml } from "../apps/backend/src/export.js";

test("wide uncertainty shows its confirmed lower score, never an invented narrower range", () => {
  const shown = scorePresentation({ min: 0, max: 70 });
  assert.equal(shown.value, "0");
  assert.equal(shown.insufficient, true);
  assert.equal(shown.label, "Подтверждённая оценка");
  assert.match(shown.note, /Недостаточно сведений/);
  assert.equal(scorePresentation({ min: 0, max: 20 }).value, "0–20");
  assert.equal(scorePresentation({ min: 0, max: 20.01 }).insufficient, true);
  assert.equal(scorePresentation({ min: 70, max: 70 }).value, "70");
  assert.equal(scorePresentation({ min: 80, max: 95 }).value, "80–95");
  assert.equal(scorePresentation({ min: 80, max: 95 }, true).insufficient, true);
});

test("saved results lose stale coverage text and broad ranges in presentation, while their original facts stay intact", () => {
  const fixtures = JSON.parse(readFileSync(new URL("./fixtures/evidence-ratings.json", import.meta.url), "utf8"));
  const rating = structuredClone(fixtures.find((f: { name: string }) => f.name === "unknown_is_not_absent").result.clusters[0].profiles[0]);
  rating.explanation += " Охват критериев: 50%.";
  const before = structuredClone(rating);
  const report = ratingAnalysis(rating);
  assert.equal(report.estimate!.value, "50");
  assert.ok(report.clarifications.length > 0);
  assert.doesNotMatch(report.explanation, /50–100|охват/i);
  assert.doesNotMatch(ratingAnalysisHtml(rating), /50–100|охват/i);
  assert.match(ratingEstimateText(rating), /^50 из 100\. Недостаточно сведений/);
  assert.deepEqual(rating, before);
  const noInformation = structuredClone(rating);
  noInformation.details.score_range = { min: 0, max: 0 };
  noInformation.details.score_status = "insufficient_evidence";
  assert.equal(ratingAnalysis(noInformation).estimate!.insufficient, true);
});
