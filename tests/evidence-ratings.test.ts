import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { unzipSync, strFromU8 } from "fflate";
import { validateRankResponse, ratingEvidence, ratingScore, ratingScoreText, ratingExplanation, clusterScore } from "@hr/contracts";
import type { Candidate, Cluster } from "@hr/contracts";
import { matrixRows, createExport, exportOptionsSchema } from "../apps/backend/src/export-options.js";
import { exportCsv, reportHtml } from "../apps/backend/src/export.js";

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
    if (details.method === "evidence-v3") assert.equal(rating.explanation, fixture.result.clusters[0].profiles[0].explanation, fixture.name);
    assert.doesNotMatch(rating.explanation!, /диапазон/iu);
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

test("historical bounds display one midpoint while confirmed duration stays 41.67", () => {
  const unknown = fixtures.find(f => f.name === "unknown_is_not_absent")!.result.clusters[0].profiles[0];
  assert.equal(ratingScoreText(unknown), "75");
  assert.equal(ratingEvidence(unknown)?.coverage, 50);
  const duration = fixtures.find(f => f.name === "moskalenko_15_of_36_months")!.result.clusters[0].profiles[0];
  assert.equal(duration.score, 41.67);
  assert.match(duration.explanation!, /1 год 3 месяца/);
  assert.match(duration.explanation!, /не менее 3 лет/);
  const candidate = { ratings: [{ ...unknown, profile_id: unknown.id }] };
  const cluster = { profiles: [{ id: unknown.id }] };
  assert.equal(clusterScore(candidate, cluster), 75);
  assert.doesNotMatch(ratingExplanation(unknown), /диапазон/iu);
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

test("v2 limits the example to 22.87–42.87 and retains the complete evidence range", () => {
  const fixture = fixtures.find(f => f.name === "range_v2_22_87")!;
  const rating = validateRankResponse(fixture.result, fixture.requirements).clusters[0].profiles[0];
  const details = ratingEvidence(rating)!;
  assert.equal(details.method, "evidence-v2");
  if (details.method !== "evidence-v2") throw new Error("Expected new policy");
  assert.equal(ratingScoreText(rating), "32.87");
  assert.deepEqual(details.full_score_range, { min: 22.87, max: 100 });
  assert.equal(details.range_limit, 20);
  assert.equal(details.coverage, 22.87);
  assert.match(rating.explanation!, /32.87\/100/);
  assert.equal(clusterScore({ ratings: [{ ...rating, profile_id: rating.id }] }, { profiles: [{ id: rating.id }] }), 32.87);
});

test("v3 returns the midpoint as one validated score without range metadata", () => {
  const fixture = fixtures.find(f => f.name === "midpoint_v3_range_v2_22_87")!;
  const rating = validateRankResponse(fixture.result, fixture.requirements).clusters[0].profiles[0];
  assert.equal(rating.score, 32.87);
  assert.equal(ratingScore(rating), 32.87);
  assert.equal(ratingScoreText(rating), "32.87");
  assert.equal(ratingEvidence(rating)?.method, "evidence-v3");
  for (const key of ["score_range", "full_score_range", "range_limit"]) assert.ok(!(key in (rating.details as object)));
  for (const mutate of [
    (r: any) => { r.score = 22.87; },
    (r: any) => { r.score = 42.87; },
    (r: any) => { r.details.score_range = { min: 22.87, max: 42.87 }; },
    (r: any) => { r.details.policy_version = "evidence-v2"; },
  ]) {
    const forged = structuredClone(fixture.result);
    mutate(forged.clusters[0].profiles[0]);
    assert.throws(() => validateRankResponse(forged, fixture.requirements));
  }
});

test("historical and new midpoint scores stay numeric and consistent in tables and exports", () => {
  for (const name of ["range_v2_22_87", "midpoint_v3_range_v2_22_87"]) {
    const fixture = fixtures.find(f => f.name === name)!;
    const input = fixture.requirements[0], rating = fixture.result.clusters[0].profiles[0];
    const cluster: Cluster = { id: input.id, name: "QA", track: "it", comment: "", is_active: true,
      profiles: [{ keywords: [], stop_factors: [], ...input.profiles[0], education: input.profiles[0].education || "",
        experience: input.profiles[0].experience || "", comment: input.profiles[0].comment || "",
        cluster_id: input.id, position_name: "QA", is_active: true }] };
    const candidate: Candidate = { id: "candidate", resume_id: "resume", file_id: "file", file_name: "resume.txt", mime_type: "text/plain",
      last_name: "Test", first_name: "Candidate", middle_name: null, phone: null, status: "in_work", scoring_status: "completed",
      created_at: "2026-10-22T08:00:00+03:00", updated_at: "2026-10-22T08:00:00+03:00", blacklisted: false,
      other_resumes_count: 0, has_other_resume_in_process: false,
      ratings: [{ ...rating, profile_id: rating.id, calculated_at: "2026-10-22T08:00:00+03:00" }] };
    assert.deepEqual(matrixRows([candidate], [cluster], [cluster.id])[1].slice(1, 3), [32.87, 32.87]);
    assert.match(exportCsv([candidate], [cluster]), /"32.87";"32.87"/);
    const html = reportHtml(candidate, [cluster], false);
    assert.match(html, /32.87 \/ 100/);
    assert.doesNotMatch(html, /диапазон|22.87–42.87/iu);
    const xlsx = createExport([candidate], [cluster], exportOptionsSchema.parse({ format: "xlsx", expanded: [cluster.id] }));
    if (typeof xlsx.body === "string") throw new Error("Expected XLSX bytes");
    const sheets = unzipSync(xlsx.body);
    assert.match(strFromU8(sheets["xl/worksheets/sheet1.xml"]), /<v>32.87<\/v>/);
  }
});

test("backend rejects forged v2 limits, original bounds, version changes and widened scores", () => {
  const fixture = fixtures.find(f => f.name === "range_v2_22_87")!;
  for (const mutate of [
    (details: any) => { details.range_limit = 10; },
    (details: any) => { details.score_range.max = 43; },
    (details: any) => { details.full_score_range.max = 99; },
    (details: any) => { delete details.full_score_range; },
    (details: any) => { details.policy_version = "evidence-v1"; },
  ]) {
    const result = structuredClone(fixture.result);
    mutate(result.clusters[0].profiles[0].details);
    assert.throws(() => validateRankResponse(result, fixture.requirements));
  }
});

test("QA aliases are checked against quotations, while tool names cannot invent another skill", () => {
  const fixture = fixtures.find(f => f.name === "range_v2_qa_word_forms")!;
  assert.equal(validateRankResponse(fixture.result, fixture.requirements).clusters[0].profiles[0].score, 100);
  const forged: any = structuredClone(fixture.result);
  const evidence = forged.clusters[0].profiles[0].details.criteria[0].evidence[0];
  evidence.quote = "Allure"; evidence.end = evidence.start + 6;
  assert.throws(() => validateRankResponse(forged, fixture.requirements));
});
