import assert from "node:assert/strict";
import { test } from "node:test";
import type { Candidate } from "@hr/contracts";
import { groupCandidateImports, candidateImportStatus, type TrackingItem } from "../apps/frontend/src/lib/import-groups.js";

const person = (id: string, phone = "+79991234567"): Candidate => ({ id, resume_id: `resume-${id}`, file_id: `file-${id}`,
  last_name: "Иванов", first_name: "Иван", middle_name: null, phone, file_name: "resume.pdf", mime_type: "application/pdf",
  status: "in_work", scoring_status: "completed", created_at: "2026-10-16T10:00:00Z", updated_at: "2026-10-16T10:00:00Z",
  blacklisted: false, has_other_resume_in_process: false, other_resumes_count: 0, ratings: [] });
const file = (id: string, extra: Partial<TrackingItem> = {}): TrackingItem => ({ id, source_path: "resume.pdf", file_name: "resume.pdf",
  status: "completed", attempt: 1, error: null, warning: null, candidate_id: null, resume_id: null,
  updated_at: "2026-10-16T10:00:00Z", batchId: `batch-${id}`, batchName: "batch.zip", batchCreatedAt: "2026-10-16T09:00:00Z", ...extra });

test("candidate uploads group across batches, resume versions, pending reanalysis and older failed files", () => {
  const candidate = person("one");
  const files = [file("old", { status: "failed", file_sha256: "same" }),
    file("complete", { candidate_id: candidate.id, resume_id: candidate.resume_id, file_sha256: "same" }),
    file("version", { candidate_id: candidate.id, file_sha256: "different", updated_at: "2026-10-16T11:00:00Z" }),
    file("pending", { status: "processing", target_resume_id: candidate.resume_id, updated_at: "2026-10-16T12:00:00Z" })];
  const groups = groupCandidateImports(files, [candidate]);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].name, "Иванов Иван");
  assert.equal(groups[0].phone, candidate.phone);
  assert.deepEqual(groups[0].items.map(item => item.id), ["pending", "version", "complete", "old"]);
  assert.equal(candidateImportStatus(groups[0].items), "processing");
  assert.equal(candidateImportStatus(groups[0].items.slice(1)), "completed", "Old failure must not replace the latest successful status");
  const recent = groupCandidateImports([files[0]], [candidate], files);
  assert.equal(recent[0].key, groups[0].key, "Older uploads may identify a recent file without appearing in its history");
  assert.equal(recent[0].items.length, 1);
});

test("identical filenames or names do not merge different candidates or different documents", () => {
  const first = person("one"), second = person("two", "+79997654321");
  assert.equal(groupCandidateImports([file("a", { candidate_id: first.id, file_sha256: "same" }),
    file("b", { candidate_id: second.id, file_sha256: "same" }), file("unknown", { file_sha256: "same" })], [first, second]).length, 3);
  assert.equal(groupCandidateImports([file("a", { file_sha256: "one" }), file("b", { file_sha256: "two" })], []).length, 2);
  assert.equal(groupCandidateImports([file("a"), file("b")], []).length, 2);
  assert.equal(groupCandidateImports([file("a", { file_sha256: "same" }), file("b", { file_sha256: "same" })], []).length, 1);
});

test("candidate hints match compatible phone identities and preserve conflicting identities", () => {
  const candidate = person("one");
  const hint = { last_name: "Иванов", first_name: "Иван", middle_name: null, phone: candidate.phone };
  const matched = groupCandidateImports([file("known", { candidate_id: candidate.id, file_sha256: "same" }),
    file("hint", { candidate_hint: hint }), file("conflict", { file_sha256: "same", candidate_hint: { ...hint, phone: "+79997654321" } })], [candidate]);
  assert.equal(matched.length, 2);
  assert.equal(matched.find(group => group.key === `candidate:${candidate.id}`)?.items.length, 2);
  assert.equal(groupCandidateImports([file("a", { candidate_hint: hint }), file("b", { candidate_hint: hint })], []).length, 1);
});

test("resume references still group uploads while candidate data is unavailable", () => {
  const files = [file("a", { resume_id: "resume" }), file("b", { target_resume_id: "resume" })];
  assert.equal(groupCandidateImports(files, []).length, 1);
  assert.equal(groupCandidateImports([files[1]], [], [file("known", { resume_id: "resume", candidate_id: "candidate" }), files[1]])[0].key, "candidate:candidate");
});
