import assert from "node:assert/strict";
import { test } from "node:test";
import { parseGuestCriteria } from "../apps/frontend/src/lib/guest-criteria.js";
import { processingTargetSchema, profileSchema, evaluationSchema } from "@hr/contracts";

const input = { name: "Подбор", education: "", experience: "", keywords: "", stop_factors: "", comment: "" };

test("long requirements survive guest input, profile storage, processing and evaluation", () => {
  const id = "11111111-1111-4111-8111-111111111111";
  for (const length of [301, 10001, 25000]) {
    const text = "Я".repeat(length);
    const criteria = parseGuestCriteria({ ...input, keywords: `${text}\nPython`, stop_factors: text });
    assert.deepEqual(criteria.keywords, [text, "Python"]);
    assert.deepEqual(criteria.stop_factors, [text]);
    const profile = profileSchema.parse({ ...criteria, name: undefined, cluster_id: id, position_name: "Подбор" });
    assert.equal(profile.keywords[0], text);
    assert.equal(profile.stop_factors[0], text);
    assert.equal(processingTargetSchema.parse({ ...criteria, id }).keywords[0], text);
    const evaluation = evaluationSchema.parse({ target_id: id, score: 0,
      criteria: ["education", "experience", "keywords"].map(name => ({ name, status: "unknown", explanation: "" })),
      matched_keywords: [text], triggered_stop_factors: [text], explanation: "" });
    assert.equal(evaluation.matched_keywords[0], text);
    assert.equal(evaluation.triggered_stop_factors[0], text);
  }
});

test("too many guest skills are reported as an item limit", () => {
  assert.throws(() => parseGuestCriteria({ ...input, keywords: Array(101).fill("SQL").join("\n") }),
    { message: "«Навыки»: не более 100 пунктов." });
});

test("guest validation preserves a compound condition and reports other form limits", () => {
  const condition = "Опыт разработки, включая настройку систем";
  assert.deepEqual(parseGuestCriteria({ ...input, keywords: condition + ";" }).keywords, [condition]);
  assert.throws(() => parseGuestCriteria({ ...input, name: " " }), { message: "Заполните поле «Название подбора»." });
  assert.throws(() => parseGuestCriteria({ ...input, experience: "Я".repeat(10001) }),
    { message: "«Опыт работы»: не более 10000 символов." });
});
