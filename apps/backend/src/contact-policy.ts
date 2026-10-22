import { contactFields, extractedPersonSchema, identityKey, type ContactDetails, type ContactField, type ContactProvenance,
  type ExtractedPerson, type ImportFile } from "@hr/contracts";

export const emptyPerson = (): ExtractedPerson => ({ last_name: null, first_name: null, middle_name: null, phone: null });
export function snapshotContactHint(current: ExtractedPerson): ExtractedPerson {
  // Legacy contacts can predate validation. Omit invalid transport hints while
  // keeping the stored contacts protected by the existing contact policy.
  const hint = emptyPerson();
  for (const field of contactFields) {
    const parsed = extractedPersonSchema.shape[field].safeParse(current[field]);
    hint[field] = parsed.success ? parsed.data : null;
  }
  return hint;
}
export const contactLabels: Record<ContactField, string> = {
  last_name: "Фамилия", first_name: "Имя", middle_name: "Отчество", phone: "Телефон",
};
export function manualContactFields(file: ImportFile): ContactField[] {
  // Old re-scoring manifests also contain a snapshot, not user input.
  if (file.target_resume_id || file.candidate_hint_source === "snapshot") return [];
  return file.manual_contact_fields ?? contactFields.filter(field => file.candidate_hint[field] !== null);
}
export interface StoredContacts extends ExtractedPerson { contact_provenance?: ContactProvenance }
export function planContactUpdate(current: StoredContacts, extracted: ExtractedPerson, details: ContactDetails | undefined,
  fileId: string, hint = emptyPerson(), manual: ContactField[] = [], allowLegacy = false) {
  const values = Object.fromEntries(contactFields.map(field => [field, current[field] || null])) as ExtractedPerson;
  const provenance = { ...current.contact_provenance };
  const protectedFields = contactFields.filter(field => {
    const old = provenance[field];
    return old?.source === "manual" || (Boolean(values[field]) &&
      !(old?.source === "resume_text" && old.value === values[field]));
  });
  // Do not attach part of someone else's name to a manually entered/legacy name.
  const conflictingName = protectedFields.some(field => field !== "phone" && values[field] && extracted[field]
    && identityKey(values[field]!) !== identityKey(extracted[field]!)) || manual.some(field => field !== "phone" && hint[field]
    && extracted[field] && identityKey(hint[field]!) !== identityKey(extracted[field]!));
  const changes: { field: ContactField; previous: string | null; value: string; evidence: NonNullable<ContactDetails["fields"][ContactField]> }[] = [];
  for (const field of contactFields) {
    if (manual.includes(field)) {
      const value = hint[field];
      if ((!values[field] && !protectedFields.includes(field)) || values[field] === value) {
        values[field] = value;
        provenance[field] = { source: "manual", value };
      }
      continue;
    }
    if (protectedFields.includes(field) || conflictingName) continue;
    const value = extracted[field], evidence = details?.fields[field];
    if (!value || (details ? evidence?.confidence !== "high" : !allowLegacy)) continue;
    const previous = values[field];
    values[field] = value;
    provenance[field] = evidence
      ? { source: "resume_text", value, file_id: fileId, method: details!.method, evidence }
      : { source: "legacy", value, file_id: fileId };
    if (value !== previous && evidence) changes.push({ field, previous, value, evidence });
  }
  return { values, provenance, changes, protected_fields: protectedFields,
    valuesChanged: contactFields.some(field => values[field] !== (current[field] || null)) };
}
