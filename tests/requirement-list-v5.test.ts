import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { compileRatingCriteria, requirementListV5, requirementListTextV5 } from "@hr/contracts";
import { parseGuestCriteria } from "../apps/frontend/src/lib/guest-criteria.js";

const cases = JSON.parse(readFileSync(new URL("./fixtures/requirement-list-v5.json", import.meta.url), "utf8")) as {text:string;expected:string[]}[];
test("requirement separators follow the same explicit priority as Python", () => {
  for (const {text,expected} of cases) assert.deepEqual(requirementListV5(text), expected, text);
});

test("guest form, preview and evaluator compiler preserve explicit item boundaries", () => {
  for (const {text,expected} of cases) {
    const criteria = parseGuestCriteria({name:"Подбор",education:"",experience:"",keywords:text,stop_factors:text,comment:""});
    assert.deepEqual(criteria.keywords, expected);
    assert.deepEqual(criteria.stop_factors, expected);
    const compiled = compileRatingCriteria(criteria);
    assert.deepEqual(compiled.map(c => c.requirement), [...new Set(expected)]);
    assert.deepEqual(requirementListV5(requirementListTextV5(expected)), expected, text);
  }
});

test("the control profile has thirteen separately weighted skills", () => {
  const plan = readFileSync(new URL("../reports/resume-evaluation-improvement-plan.md", import.meta.url), "utf8");
  const text = [...plan.matchAll(/```text\s*\n([\s\S]*?)\n```/gu)][3][1];
  for (const pasted of [text, text + "\n", "\r\n" + text + "\r\n\r\n"]) {
    const skills = requirementListV5(pasted);
    assert.equal(skills.length, 13);
    assert.equal(compileRatingCriteria({ keywords: skills }).length, 13);
  }
});
