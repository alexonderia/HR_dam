import assert from "node:assert/strict";
import { test } from "node:test";
import { contactsResponseSchema, extractedPersonSchema, rankResponseSchema, type ImportFile } from "@hr/contracts";
import { emptyPerson, manualContactFields, planContactUpdate, snapshotContactHint } from "../apps/backend/src/contact-policy.js";
import { contactResult } from "./fixtures/contact-result.js";

const extracted = contactResult({ last_name: "Румянцева", first_name: "Дарья", middle_name: "Константиновна", phone: "+79991234567" });
const plan = (current: Parameters<typeof planContactUpdate>[0], result = extracted) =>
  planContactUpdate(current, result.candidate, result.contact_details, "file");

test("legacy invalid contacts do not block assessment hints or change stored values", () => {
  const current = { ...extracted.candidate, phone: "+799912345678" };
  const hint = snapshotContactHint(current);
  assert.deepEqual(hint, { ...extracted.candidate, phone: null });
  assert.equal(extractedPersonSchema.safeParse(current).success, false, "New input must still reject invalid phones");
  assert.deepEqual(planContactUpdate(current, extracted.candidate, extracted.contact_details, "file", hint).values, current);
  assert.equal(snapshotContactHint({ ...current, last_name: "Invalid\u0000name" }).last_name, null);
  assert.deepEqual(snapshotContactHint(extracted.candidate), extracted.candidate);
});

test("legacy populated contacts are protected and a matching missing patronymic can be filled", () => {
  const result = plan({ ...extracted.candidate, middle_name: null });
  assert.equal(result.values.middle_name, "Константиновна");
  assert.deepEqual(result.changes.map(c => c.field), ["middle_name"]);
  assert.deepEqual(result.protected_fields, ["last_name", "first_name", "phone"]);
  assert.equal(result.provenance.middle_name?.source, "resume_text");
  assert.equal(result.provenance.middle_name?.file_id, "file");
});
test("manual and legacy names prevent combining contacts from different identities", () => {
  const current = { ...emptyPerson(), last_name: "Иванова", first_name: "Анна" };
  assert.deepEqual(plan(current).values, current);
  assert.equal(plan(current).changes.length, 0);
});
test("legacy phones are never replaced", () => {
  assert.equal(plan({ ...extracted.candidate, phone: "+79991234568" }).values.phone, "+79991234568");
});
test("an explicitly protected manual null is not filled", () => {
  const result = plan({ ...extracted.candidate, middle_name: null,
    contact_provenance: { middle_name: { source: "manual", value: null } } });
  assert.equal(result.values.middle_name, null);
  assert.ok(result.protected_fields.includes("middle_name"));
});
test("a previous machine value can be corrected, while later edits are protected", () => {
  const old = { source: "resume_text" as const, value: "Петровна" };
  const machine = { ...extracted.candidate, middle_name: "Петровна", contact_provenance: { middle_name: old } };
  assert.equal(plan(machine).values.middle_name, "Константиновна");
  assert.equal(plan({ ...machine, middle_name: "Сергеевна" }).values.middle_name, "Сергеевна");
});
test("medium confidence, no text and missing fields cannot delete or change contacts", () => {
  assert.deepEqual(plan(emptyPerson(), contactResult(extracted.candidate, "medium")).values, emptyPerson());
  assert.deepEqual(plan(extracted.candidate, contactResult({})).values, extracted.candidate);
  const noMiddle = contactResult({ last_name: "Румянцева", first_name: "Дарья" });
  assert.equal(plan(emptyPerson(), noMiddle).values.middle_name, null);
});
test("manual hints take precedence and do not borrow a conflicting person's other fields", () => {
  const hint = { ...emptyPerson(), last_name: "Иванова", first_name: "Анна" };
  const result = planContactUpdate(emptyPerson(), extracted.candidate, extracted.contact_details, "file", hint, ["last_name", "first_name"]);
  assert.deepEqual(result.values, hint);
  assert.equal(result.provenance.first_name?.source, "manual");
});
test("snapshot hints in new and legacy re-scoring manifests are not manual input", () => {
  const file = { candidate_hint: extracted.candidate } as ImportFile;
  assert.equal(manualContactFields(file).length, 4);
  assert.deepEqual(manualContactFields({ ...file, target_resume_id: "resume" }), []);
  assert.deepEqual(manualContactFields({ ...file, candidate_hint_source: "snapshot" }), []);
  assert.deepEqual(manualContactFields({ ...file, candidate_hint_source: "manual", manual_contact_fields: [] }), []);
});
test("legacy analyzers remain compatible for new records, but cannot repair existing contacts without evidence", () => {
  assert.deepEqual(planContactUpdate(emptyPerson(), extracted.candidate, undefined, "file").values, emptyPerson());
  const legacy = planContactUpdate(emptyPerson(), extracted.candidate, undefined, "file", emptyPerson(), [], true);
  assert.deepEqual(legacy.values, extracted.candidate);
  assert.equal(legacy.provenance.first_name?.source, "legacy");
});
test("contact contracts preserve null and both HTTP and AMQP metadata", () => {
  const result = contactResult({ last_name: "Румянцева", first_name: "Дарья" });
  assert.equal(contactsResponseSchema.parse(result).candidate.middle_name, null);
  assert.deepEqual(rankResponseSchema.parse({ clusters: [], ...result }).contact_details, result.contact_details);
  assert.equal(extractedPersonSchema.parse({}).middle_name, null);
});
test("unsubstantiated contacts, international automatic numbers and no-text claims are rejected", () => {
  const wrong = structuredClone(extracted);
  wrong.candidate.middle_name = "Сергеевна";
  assert.equal(contactsResponseSchema.safeParse(wrong).success, false);
  const unsupported = contactResult({ phone: "+442079460958" });
  assert.equal(contactsResponseSchema.safeParse(unsupported).success, false);
  const empty = structuredClone(extracted);
  empty.contact_details.text_status = "no_text";
  assert.equal(contactsResponseSchema.safeParse(empty).success, false);
  const missing = structuredClone(extracted);
  missing.contact_details.fields.middle_name = null;
  assert.equal(contactsResponseSchema.safeParse(missing).success, false);
});
