import { contactFields, type ContactDetails, type ExtractedPerson } from "@hr/contracts";

export function contactResult(person: Partial<ExtractedPerson>, confidence: "high" | "medium" = "high") {
  const candidate: ExtractedPerson = { last_name: null, first_name: null, middle_name: null, phone: null, ...person };
  const quote = contactFields.map(f => candidate[f]).filter(Boolean).join(" ");
  const contact_details: ContactDetails = { version: 1, method: "rules-ru-v1", text_status: quote ? "present" : "no_text",
    name_status: candidate.first_name ? "extracted" : "not_found", phone_status: candidate.phone ? "extracted" : "not_found",
    fields: Object.fromEntries(contactFields.map(field => [field, candidate[field] ? {
      source: "resume_text", confidence, quote, line_start: 1, line_end: 1,
    } : null])) as ContactDetails["fields"], warnings: [] };
  return { candidate, contact_details };
}
