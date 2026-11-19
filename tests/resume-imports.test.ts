import assert from "node:assert/strict";
import { test } from "node:test";
import { extractedPersonSchema, formatAnalysisDuration } from "@hr/contracts";

test("missing extracted identity stays null; blacklist input remains strict", () => {
  assert.deepEqual(extractedPersonSchema.parse({ phone: "", last_name: "  " }),
    { last_name: null, first_name: null, middle_name: null, phone: null });
  assert.equal(extractedPersonSchema.parse({ last_name: "И.", phone: "8 (999) 123-45-67" }).phone, "+79991234567");
});
test("analysis durations use readable units without fabricating missing measurements", () => {
  assert.equal(formatAnalysisDuration(329000), "5 мин 29 с");
  assert.equal(formatAnalysisDuration(900000), "15 мин 0 с");
  assert.equal(formatAnalysisDuration(3723000), "1 ч 2 мин 3 с");
  assert.equal(formatAnalysisDuration(523), "менее 1 с");
  for (const value of [null, undefined, NaN, -1]) assert.equal(formatAnalysisDuration(value), "нет данных");
});
