import { z } from "zod";

export const contactFields = ["last_name", "first_name", "middle_name", "phone"] as const;
export type ContactField = typeof contactFields[number];
export const contactSourceSchema = z.object({
  source: z.literal("resume_text"), confidence: z.enum(["high", "medium"]),
  quote: z.string().min(1).max(4000), line_start: z.number().int().positive(), line_end: z.number().int().positive(),
}).strict().refine(value => value.line_end >= value.line_start);
export const contactDetailsSchema = z.object({
  version: z.literal(1), method: z.literal("rules-ru-v1"), text_status: z.enum(["present", "no_text"]),
  name_status: z.enum(["extracted", "not_found", "ambiguous"]),
  phone_status: z.enum(["extracted", "not_found", "unsupported", "ambiguous"]),
  fields: z.object({ last_name: contactSourceSchema.nullable(), first_name: contactSourceSchema.nullable(),
    middle_name: contactSourceSchema.nullable(), phone: contactSourceSchema.nullable() }).strict(),
  warnings: z.array(z.string().max(500)).max(10),
}).strict();
export type ContactDetails = z.infer<typeof contactDetailsSchema>;
export interface ContactProvenanceEntry {
  source: "manual" | "resume_text" | "legacy";
  value: string | null;
  file_id?: string;
  evidence?: z.infer<typeof contactSourceSchema>;
  method?: "rules-ru-v1";
}
export type ContactProvenance = Partial<Record<ContactField, ContactProvenanceEntry>>;
export interface ContactRecoveryPreview {
  revision: string;
  candidate: Record<ContactField, string | null>;
  contact_details: ContactDetails;
  changes: { field: ContactField; previous: string | null; value: string; evidence: z.infer<typeof contactSourceSchema> }[];
  protected_fields: ContactField[];
}
