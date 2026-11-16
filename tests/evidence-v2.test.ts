import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { validateRankResponse, ratingAnalysis, compileRatingCriteria } from "@hr/contracts";
import { ratingAnalysisHtml } from "../apps/backend/src/export.js";

const fixtures = JSON.parse(readFileSync(new URL("./fixtures/evidence-ratings-v2.json", import.meta.url), "utf8"));

test("all current Python fixtures pass evidence-v2 API validation; legacy fixtures remain covered separately", () => {
  for (const fixture of fixtures) {
    const checked = validateRankResponse(fixture.result, fixture.requirements);
    assert.equal(checked.clusters[0].profiles[0].details.policy_version, "evidence-v2");
  }
});

test("mandatory experience remains weighted next to a preference, with versioned legacy behavior", () => {
  const profile = { experience: "От 3 лет разработки на Python и желательно знание Docker" };
  const current = compileRatingCriteria(profile, "", "evidence-v2");
  assert.equal(current.length, 2);
  assert.equal(current[0].weight, 10000);
  assert.equal(current[1].weight, 0);
  assert.equal(compileRatingCriteria(profile, "", "evidence-v1")[0].weight, 0);
});

test("unknown reason and dated work arithmetic cannot be forged", () => {
  const source = fixtures.find((f: any) => f.name === "two_jobs_four_years");
  assert.equal(source.result.clusters[0].profiles[0].details.criteria[0].experience_months, 48);
  for (const mutate of [
    (d: any) => { d.criteria[0].work_periods[0].end_month++; },
    (d: any) => { d.criteria[0].work_periods[0].start = 999999; },
    (d: any) => { d.assessment_date = "2020-01-01"; },
    (d: any) => { d.criteria[0].unknown_reason = "not_stated"; },
  ]) {
    const result = structuredClone(source.result);
    mutate(result.clusters[0].profiles[0].details);
    assert.throws(() => validateRankResponse(result, source.requirements));
  }
  const missing = fixtures.find((f: any) => f.name === "future_intent");
  const invalid = structuredClone(missing.result);
  delete invalid.clusters[0].profiles[0].details.criteria[0].unknown_reason;
  assert.throws(() => validateRankResponse(invalid, missing.requirements));
});

test("HR clarification reasons reach reports and escaped exports without changing a score", () => {
  const fixture = fixtures.find((f: any) => f.name === "future_intent");
  const rating = fixture.result.clusters[0].profiles[0];
  const before = structuredClone(rating);
  const analysis = ratingAnalysis(rating);
  assert.equal(analysis.clarifications.length, 1);
  assert.match(analysis.clarifications[0].reason, /намерение/);
  assert.match(ratingAnalysisHtml(rating), /Что уточнить/);
  const unsafe = structuredClone(rating);
  unsafe.details.criteria[0].requirement = "<script>unsafe</script>";
  assert.doesNotMatch(ratingAnalysisHtml(unsafe), /<script>/);
  assert.deepEqual(rating, before);
});
