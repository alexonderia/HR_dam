import { z } from "zod";
import { contactDetailsSchema } from "./contacts.js";

export interface AnalysisStatus {
  available: boolean;
  message: string;
  adapter?: "http" | "amqp";
  alive?: boolean;
  broker_connected?: boolean | null;
  consumer_alive?: boolean | null;
  model_ready?: boolean;
  busy?: boolean;
}

export interface WorkerStatus {
  state: "idle" | "waiting_analysis" | "waiting_requirements" | "processing" | "error";
  current_resume_id: string | null;
}

export interface QueueStatus {
  reason: "analysis_unavailable" | "no_profiles" | "processing_paused" | "waiting_turn" | "starting" | "delayed";
  message: string;
  waiting_seconds: number;
  position: number;
  delayed: boolean;
}

export interface ResumeProcessing {
  queue: QueueStatus | null;
}

export const normalizeName = (value: string) =>
  value.normalize("NFKC").replace(/\s+/gu, " ").trim();
export const identityKey = (value: string) =>
  normalizeName(value).toLocaleLowerCase("ru").replace(/ё/gu, "е");
export function normalizePhone(value: string) {
  let digits = value.replace(/[^0-9]/g, "");
  if (!value.trim().startsWith("+") && digits.length === 10) digits = "7" + digits;
  if (!value.trim().startsWith("+") && digits.length === 11 && digits[0] === "8") digits = "7" + digits.slice(1);
  return digits ? "+" + digits : "";
}
const name = z
  .string()
  .transform(normalizeName)
  .pipe(
    z
      .string()
      .min(2)
      .max(100)
      .regex(/^[\p{L}][\p{L}\s'-]*$/u, "Используйте буквы, пробел или дефис"),
  );
export const personSchema = z.object({
  phone: z
    .string()
    .transform(normalizePhone)
    .pipe(z.string().regex(/^\+[1-9]\d{7,14}$/, "Проверьте номер телефона")
      .refine(value => !value.startsWith("+7") || value.length === 12, "Номер +7 должен содержать 11 цифр")),
  last_name: name,
  first_name: name,
  middle_name: z
    .string()
    .transform(normalizeName)
    .pipe(z.union([z.literal(""), name]))
    .default(""),
});
const optionalExtractedName = z.preprocess(
  value => typeof value === "string" ? normalizeName(value) || null : value,
  z.string().max(100).regex(/^[^\x00-\x1f]*$/u).nullish().transform(value => value ?? null),
);
export const extractedPersonSchema = z.object({
  last_name: optionalExtractedName, first_name: optionalExtractedName, middle_name: optionalExtractedName,
  phone: z.preprocess(value => typeof value === "string" && !value.trim() ? null : value,
    personSchema.shape.phone.nullish().transform(value => value ?? null)),
});
export type ExtractedPerson = z.infer<typeof extractedPersonSchema>;
export const contactsResponseSchema = z.object({ candidate: extractedPersonSchema, contact_details: contactDetailsSchema })
  .superRefine((value, ctx) => {
    for (const field of ["last_name", "first_name", "middle_name", "phone"] as const) {
      if (Boolean(value.candidate[field]) !== Boolean(value.contact_details.fields[field]))
        ctx.addIssue({ code: "custom", message: "Контакт должен иметь источник.", path: ["candidate", field] });
      const actual = value.candidate[field], quote = value.contact_details.fields[field]?.quote;
      if (actual && quote) {
        const supported = field === "phone"
          ? /^\+7\d{10}$/.test(actual) && [actual.slice(1), "8" + actual.slice(2)].some(digits => quote.replace(/\D/g, "").includes(digits))
          : quote.split(/[^\p{L}'-]+/u).some(word => identityKey(word) === identityKey(actual));
        if (!supported) ctx.addIssue({ code: "custom", message: "Значение отсутствует в цитате.", path: ["candidate", field] });
      }
    }
    if (value.contact_details.text_status === "no_text" && Object.values(value.candidate).some(Boolean))
      ctx.addIssue({ code: "custom", message: "В пустом тексте не может быть контактов." });
    const hasName = Boolean(value.candidate.last_name && value.candidate.first_name);
    if ((value.contact_details.name_status === "extracted") !== hasName ||
        (!hasName && [value.candidate.last_name, value.candidate.first_name, value.candidate.middle_name].some(Boolean)))
      ctx.addIssue({ code: "custom", message: "Статус ФИО противоречит найденным полям." });
    if ((value.contact_details.phone_status === "extracted") !== Boolean(value.candidate.phone))
      ctx.addIssue({ code: "custom", message: "Статус телефона противоречит найденному номеру." });
  });
export const clusterSchema = z.object({
  name: z.string().trim().min(2).max(255),
  track: z.string().trim().min(1).max(20),
  comment: z.string().max(10000).default(""),
  is_active: z.boolean().default(true),
});
export const profileSchema = z.object({
  cluster_id: z.uuid(),
  position_name: z.string().trim().min(2).max(255),
  education: z.string().max(5000).default(""),
  experience: z.string().max(5000).default(""),
  keywords: z.array(z.string().trim().min(1).max(200)).max(100).default([]),
  stop_factors: z.array(z.string().trim().min(1).max(200)).max(100).default([]),
  comment: z.string().max(10000).default(""),
  is_active: z.boolean().default(true),
});
export const blacklistSchema = personSchema.extend({
  company_name: z.string().trim().min(2).max(255),
  is_active: z.boolean().default(true),
});
export const ratingSchema = z.object({
  id: z.uuid(),
  score: z.number().min(0).max(100),
  matched_keywords: z.array(z.string()).optional(),
  triggered_stop_factors: z.array(z.string()).optional(),
  details: z.unknown().optional(),
  explanation: z.string().optional(),
});
export const rankResponseSchema = z.object({
  analysis_duration_ms: z.number().int().min(0).max(2147483647).optional(),
  candidate: extractedPersonSchema.optional(),
  contact_details: contactDetailsSchema.optional(),
  clusters: z.array(
    z.object({ id: z.uuid(), profiles: z.array(ratingSchema) }),
  ),
}).superRefine((value, ctx) => {
  if (value.contact_details && !contactsResponseSchema.safeParse(value).success)
    ctx.addIssue({ code: "custom", message: "Контакты не подтверждены корректным источником." });
});
export type Profile = z.infer<typeof profileSchema> & { id: string };
export type Cluster = z.infer<typeof clusterSchema> & {
  id: string;
  profiles: Profile[];
};
export type BlacklistEntry = z.infer<typeof blacklistSchema> & { id: string };
export interface Rating {
  profile_id: string;
  score: number;
  matched_keywords?: string[];
  triggered_stop_factors?: string[];
  details?: unknown;
  explanation?: string;
  calculated_at: string;
}
export interface Candidate {
  id: string;
  phone: string | null;
  last_name: string | null;
  first_name: string | null;
  middle_name: string | null;
  contact_provenance?: import("./contacts.js").ContactProvenance;
  contact_extraction?: import("./contacts.js").ContactDetails | null;
  resume_id: string;
  file_id: string;
  file_name: string;
  mime_type: string;
  status: "in_work" | "in_process" | "historical";
  scoring_status: "pending" | "processing" | "completed" | "failed";
  analysis_duration_ms?: number | null;
  created_at: string;
  updated_at: string;
  blacklisted: boolean;
  has_other_resume_in_process: boolean;
  other_resumes_count: number;
  ratings: Rating[];
}
export interface ResumeEvent {
  id: string;
  event_type: string;
  message: string;
  created_at: string;
  analysis_duration_ms?: number | null;
}
export const fullName = (p: {
  last_name: string | null;
  first_name: string | null;
  middle_name?: string | null;
}) => [p.last_name, p.first_name, p.middle_name].filter(Boolean).join(" ");
export const statusLabels = {
  in_work: "В работе",
  in_process: "В процессе",
  historical: "Архив",
};
export const scoringLabels = {
  pending: "В очереди",
  processing: "Оценивается",
  completed: "Оценён",
  failed: "Ошибка оценки",
};
