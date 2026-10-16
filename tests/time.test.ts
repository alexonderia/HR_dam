import assert from "node:assert/strict";
import { test } from "node:test";
import { formatMoscowDateTime, formatMoscowTime, moscowTimestamp, moscowJsonReplacer } from "@hr/contracts";

test("Moscow formatting is independent of host timezone and handles the midnight boundary", () => {
  const previous = process.env.TZ;
  try {
    for (const zone of ["UTC", "America/Los_Angeles", "Asia/Tokyo"]) {
      process.env.TZ = zone;
      assert.equal(formatMoscowDateTime("2026-10-16T23:15:00Z"), "17.10.2026, 02:15:00");
      assert.equal(formatMoscowTime("2026-10-16T23:15:00Z"), "02:15:00");
      assert.equal(moscowTimestamp("2026-10-16T23:15:00Z"), "2026-10-17T02:15:00.000+03:00");
    }
  } finally {
    if (previous === undefined) delete process.env.TZ;
    else process.env.TZ = previous;
  }
});

test("Moscow timestamps preserve instants and PostgreSQL microseconds without applying the offset twice", () => {
  const expected = "2026-10-17T02:15:00.123456+03:00";
  assert.equal(moscowTimestamp("2026-10-16T23:15:00.123456Z"), expected);
  assert.equal(moscowTimestamp(expected), expected);
  assert.equal(Date.parse(expected), Date.parse("2026-10-16T23:15:00.123456Z"));
  const source = { created_at: new Date("2026-10-16T23:15:00Z"), updated_at: null,
    ratings: [{ calculated_at: "2026-10-16T23:15:00.123456Z" }],
    explanation: "2026-10-16T23:15:00Z" };
  const output = JSON.parse(JSON.stringify(source, moscowJsonReplacer));
  assert.equal(output.created_at, "2026-10-17T02:15:00.000+03:00");
  assert.equal(output.ratings[0].calculated_at, expected);
  assert.equal(output.updated_at, null);
  assert.equal(output.explanation, source.explanation);
});
