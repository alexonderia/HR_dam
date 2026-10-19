import { z } from "zod";
import { normalizeName, personSchema, clusterSchema, profileSchema, rankResponseSchema } from "./domain.js";

const optionalName = z.preprocess(
  value => typeof value === "string" ? normalizeName(value) || null : value,
  z.string().max(100).regex(/^[^\x00-\x1f]*$/u).nullish().transform(value => value ?? null),
);
export const extractedPersonSchema = z.object({
  last_name: optionalName, first_name: optionalName, middle_name: optionalName,
  phone: z.preprocess(value => typeof value === "string" && !value.trim() ? null : value,
    personSchema.shape.phone.nullish().transform(value => value ?? null)),
});
export type ExtractedPerson = z.infer<typeof extractedPersonSchema>;
export const requirementSchema = clusterSchema.extend({ id: z.uuid(), profiles: z.array(profileSchema.extend({ id: z.uuid() })).min(1) });
export const importFileSchema = z.object({
  id: z.uuid(), file_id: z.uuid(), source_path: z.string().min(1).max(2048),
  file_name: z.string().min(1).max(180), mime_type: z.string().max(100),
  size_bytes: z.number().int().positive().max(50 * 1024 * 1024),
  sha256: z.string().regex(/^[a-f0-9]{64}$/), bucket: z.string().min(1).max(255), object_key: z.string().min(1).max(2048),
  candidate_hint: extractedPersonSchema,
  target_resume_id: z.uuid().optional(), target_updated_at: z.string().optional(),
  assessment_cluster_ids: z.array(z.uuid()).min(1).optional(),
});
export type ImportFile = z.infer<typeof importFileSchema>;
export const importManifestSchema = z.object({
  version: z.literal(1), id: z.uuid(), archive_name: z.string().min(1).max(180),
  created_at: z.iso.datetime({ offset: true }), ignored_files: z.array(z.string()),
  requirements: z.array(requirementSchema).min(1), items: z.array(importFileSchema).min(1).max(200),
});
export type ImportManifest = z.infer<typeof importManifestSchema>;
export const storageJobSchema = z.object({
  version: z.literal(1), job_id: z.uuid(), batch_id: z.uuid(), item_id: z.uuid(),
  attempt: z.number().int().min(1).max(100), file: importFileSchema,
  requirements: z.array(requirementSchema).min(1),
});
export type StorageJob = z.infer<typeof storageJobSchema>;
export const analysisJobSchema = storageJobSchema.extend({
  file: importFileSchema.extend({ download_url: z.url(), download_url_expires_at: z.iso.datetime({ offset: true }) }),
});
export type AnalysisJob = z.infer<typeof analysisJobSchema>;
const resultEnvelope = { version: z.literal(1), job_id: z.uuid(), batch_id: z.uuid(), item_id: z.uuid(), attempt: z.number().int().min(1).max(100),
  analysis_duration_ms: z.number().int().min(0).max(2147483647).optional() };
export const importResultSchema = z.discriminatedUnion("status", [
  z.object({ ...resultEnvelope, status: z.literal("completed"), candidate: extractedPersonSchema, analysis: rankResponseSchema }).strict(),
  z.object({ ...resultEnvelope, status: z.literal("failed"), error: z.object({ code: z.string().min(1).max(100), message: z.string().min(1).max(2000) }).strict() }).strict(),
]);
export type ImportResult = z.infer<typeof importResultSchema>;
export const importEventSchema = z.object({
  ...resultEnvelope, stage: z.enum(["uploading", "pending", "processing", "completed", "failed"]),
  created_at: z.iso.datetime({ offset: true }), error: z.string().max(2000).optional(), warning: z.string().optional(),
  candidate_id: z.uuid().optional(), resume_id: z.uuid().optional(),
});
export type ImportEvent = z.infer<typeof importEventSchema>;
export function importAnalysisTiming(events: ImportEvent[], event: ImportEvent | undefined, finishedAt?: string) {
  const started = event && events.filter(e => e.item_id === event.item_id && e.job_id === event.job_id &&
    e.attempt === event.attempt && e.stage === "processing" && Number.isFinite(Date.parse(e.created_at)))
    .sort((a, b) => Date.parse(a.created_at) - Date.parse(b.created_at))[0];
  const end = finishedAt || (event && ["completed", "failed"].includes(event.stage) ? event.created_at : undefined);
  const elapsed = started && end ? Date.parse(end) - Date.parse(started.created_at) : NaN;
  return { analysis_started_at: started?.created_at ?? null,
    analysis_duration_ms: event?.analysis_duration_ms ?? (Number.isFinite(elapsed) && elapsed >= 0 && elapsed <= 2147483647 ? elapsed : null) };
}
export type ImportItemStatus = ImportEvent["stage"];
export interface ResumeImportSummary {
  id: string; archive_name: string; created_at: string; total_files: number;
  processed_files: number; failed_files: number; pending_files: number;
  uploading_files: number; processing_files: number; ignored_files: string[];
}
export interface ResumeImportItem {
  id: string; source_path: string; file_name: string; status: ImportItemStatus; attempt: number;
  error: string | null; warning: string | null; candidate_id: string | null; resume_id: string | null; updated_at: string;
  analysis_started_at?: string | null; analysis_duration_ms?: number | null;
  file_sha256?: string; candidate_hint?: ExtractedPerson; target_resume_id?: string;
}
export interface ResumeImportDetail extends ResumeImportSummary { items: ResumeImportItem[] }
export interface BrokerStatus {
  mode?: "broker" | "direct";
  broker_enabled?: boolean;
  rank_bridge_enabled?: boolean;
  available: boolean; analysis_consumers: number;
  queues: Record<string, { ready: number; processing: number; consumers: number }>;
}
