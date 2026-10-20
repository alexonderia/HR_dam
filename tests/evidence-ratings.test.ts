import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { validateRankResponse, ratingEvidence, ratingScoreText, clusterScoreRange } from "@hr/contracts";

const fixtures = JSON.parse(readFileSync(new URL("./fixtures/evidence-ratings.json", import.meta.url), "utf8")) as {
  name: string; source: string; requirements: Parameters<typeof validateRankResponse>[1];
  result: ReturnType<typeof validateRankResponse>;
}[];

test("Python evidence results pass backend validation with identical weights, rounding and Unicode offsets", () => {
  for (const fixture of fixtures) {
    const result = validateRankResponse(fixture.result, fixture.requirements);
    const rating = result.clusters[0].profiles[0];
    const details = ratingEvidence(rating)!;
    assert.ok(details, fixture.name);
    assert.equal(rating.explanation, fixture.result.clusters[0].profiles[0].explanation, fixture.name);
    for (const item of [...details.criteria, ...details.stop_factors]) for (const quote of item.evidence)
      assert.equal(Array.from(fixture.source).slice(quote.start, quote.end).join(""), quote.quote);
  }
});

test("backend rejects forged scores, weights, criteria, matches, stops, citation offsets and duration", () => {
  const mutations = [
    (r: any) => { r.score = 99; },
    (r: any) => { r.details.score_range.max = 98; },
    (r: any) => { r.details.criteria[0].weight = 1; },
    (r: any) => { r.details.criteria[0].requirement = "Unrequested skill"; },
    (r: any) => { r.details.criteria[0].id = "invented"; },
    (r: any) => { r.details.criteria[0].credit = .99; },
    (r: any) => { r.details.criteria[0].experience_months = 36; },
    (r: any) => { r.details.criteria[0].evidence[0].end += 1; },
    (r: any) => { r.details.criteria[0].evidence = []; },
    (r: any) => { r.details.coverage = 0; },
    (r: any) => { r.matched_keywords = ["Python"]; },
    (r: any) => { r.triggered_stop_factors = ["Invented refusal"]; },
    (r: any) => { r.details.policy_version = "arbitrary"; },
  ];
  const fixture = fixtures.find(f => f.name === "moskalenko_15_of_36_months")!;
  for (const mutate of mutations) {
    const result = structuredClone(fixture.result);
    mutate(result.clusters[0].profiles[0]);
    assert.throws(() => validateRankResponse(result, fixture.requirements));
  }
});

test("unknown facts retain a score range, while the Moskalenko duration gives 41.67 by the proposed formula", () => {
  const unknown = fixtures.find(f => f.name === "unknown_is_not_absent")!.result.clusters[0].profiles[0];
  assert.equal(ratingScoreText(unknown), "50–100");
  assert.equal(ratingEvidence(unknown)?.coverage, 50);
  const duration = fixtures.find(f => f.name === "moskalenko_15_of_36_months")!.result.clusters[0].profiles[0];
  assert.equal(duration.score, 41.67);
  assert.match(duration.explanation!, /1 год 3 месяца/);
  assert.match(duration.explanation!, /не менее 3 лет/);
  const candidate = { ratings: [{ ...unknown, profile_id: unknown.id }] };
  const cluster = { profiles: [{ id: unknown.id }] };
  assert.deepEqual(clusterScoreRange(candidate, cluster), { min: 50, max: 100 });
});

test("legacy saved ratings remain readable and out-of-input stop factors are rejected", () => {
  const fixture = fixtures[0];
  const result = structuredClone(fixture.result);
  const rating = result.clusters[0].profiles[0];
  delete rating.details;
  rating.score = 73;
  assert.equal(validateRankResponse(result, fixture.requirements).clusters[0].profiles[0].score, 73);
  rating.triggered_stop_factors = ["Not requested"];
  assert.throws(() => validateRankResponse(result, fixture.requirements));
});

test("backend rebuilds the explanation from checked comparisons instead of trusting a free-form claim", () => {
  const fixture = fixtures.find(f => f.name === "unknown_is_not_absent")!;
  const result = structuredClone(fixture.result);
  result.clusters[0].profiles[0].explanation = "Python confirmed, SQL absent, Kubernetes required";
  const checked = validateRankResponse(result, fixture.requirements).clusters[0].profiles[0];
  assert.match(checked.explanation!, /Подтверждено: SQL/);
  assert.match(checked.explanation!, /Требует уточнения: Python/);
  assert.doesNotMatch(checked.explanation!, /Kubernetes|SQL absent|Python confirmed/);
});
