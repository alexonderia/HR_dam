import assert from "node:assert/strict";
import { test } from "node:test";
import { randomUUID } from "node:crypto";
import { zipSync, strToU8 } from "fflate";
import { extractedPersonSchema, importResultSchema, importEventSchema } from "@hr/contracts";
import { extractResumeArchive } from "../apps/backend/src/archive.js";
import { latestItemEvent } from "@hr/data-access";

test("ZIP selects supported resumes in nested folders and ignores metadata", () => {
  const zip = Buffer.from(zipSync({ "CV/Иванов.txt": strToU8("Опыт: Python"), "other.rtf": strToU8("{\\rtf1 CV}"),
    "notes.csv": strToU8("ignored"), "__MACOSX/extra.txt": strToU8("metadata") }));
  const result = extractResumeArchive(zip);
  assert.equal(result.files.length, 2);
  assert.equal(result.files[0].filename, "Иванов.txt");
  assert.deepEqual(result.ignored, ["notes.csv", "__MACOSX/extra.txt"]);
});
test("ZIP rejects traversal, duplicates, corruption, empty files and ZIP bombs", () => {
  for (const path of ["../cv.txt", "/cv.txt", "c:/cv.txt", "x/./cv.txt"])
    assert.throws(() => extractResumeArchive(Buffer.from(zipSync({ [path]: strToU8("CV") }))));
  assert.throws(() => extractResumeArchive(Buffer.from("not a ZIP")));
  assert.throws(() => extractResumeArchive(Buffer.from(zipSync({ "empty.txt": new Uint8Array() }))));
  const zip = Buffer.from(zipSync({ "cv.txt": strToU8("CV") }));
  const central = zip.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
  zip.writeUInt32LE(300 * 1024 * 1024, central + 24);
  assert.throws(() => extractResumeArchive(zip));
});
test("missing extracted identity stays null; blacklist input remains strict", () => {
  assert.deepEqual(extractedPersonSchema.parse({ phone: "", last_name: "  " }),
    { last_name: null, first_name: null, middle_name: null, phone: null });
  assert.equal(extractedPersonSchema.parse({ last_name: "И.", phone: "8 (999) 123-45-67" }).phone, "+79991234567");
});
test("results require correlation, finite scores, supported version and terminal status", () => {
  const envelope = { version: 1, job_id: randomUUID(), batch_id: randomUUID(), item_id: randomUUID(), attempt: 1 };
  const result = importResultSchema.parse({ ...envelope, status: "completed", candidate: {}, analysis: { clusters: [] } });
  assert.equal(result.status, "completed");
  if (result.status === "completed") assert.equal(result.candidate.phone, null);
  assert.throws(() => importResultSchema.parse({ ...envelope, status: "completed", candidate: {}, analysis: { clusters: [{ id: randomUUID(), profiles: [{ id: randomUUID(), score: 101 }] }] } }));
  assert.throws(() => importResultSchema.parse({ ...envelope, version: 2, status: "failed", error: { code: "bad", message: "bad" } }));
});
test("late storage/progress events cannot undo terminal results or a newer attempt", () => {
  const item = randomUUID(), job = randomUUID(), batch = randomUUID();
  const base = { version: 1 as const, job_id: job, item_id: item, batch_id: batch, attempt: 1, created_at: new Date().toISOString() };
  const events = [{ ...base, stage: "completed" as const }, { ...base, stage: "pending" as const }];
  assert.equal(latestItemEvent(events, item)?.stage, "completed");
  assert.equal(latestItemEvent([...events, { ...base, job_id: randomUUID(), attempt: 2, stage: "uploading" }], item)?.attempt, 2);
});

test("import events accept Moscow offsets and compare mixed timezone timestamps by actual time", () => {
  const base = { version: 1 as const, job_id: randomUUID(), item_id: randomUUID(), batch_id: randomUUID(),
    attempt: 1, stage: "processing" as const };
  const earlier = importEventSchema.parse({ ...base, created_at: "2026-10-16T13:00:00+03:00" });
  const later = importEventSchema.parse({ ...base, created_at: "2026-10-16T10:30:00Z" });
  assert.equal(latestItemEvent([earlier, later], base.item_id), later);
});
