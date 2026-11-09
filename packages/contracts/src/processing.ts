import { z } from "zod";
import { extractedPersonSchema } from "./imports.js";

export const processingModeSchema = z.enum(["guest", "authorized"]);
export const operationSchema = z.enum(["prepare", "evaluate"]);
const identity = {
  task_id: z.uuid(), mode: processingModeSchema,
  deadline: z.iso.datetime({ offset: true }),
};
export const processingCommandSchema = z.object({
  ...identity, job_id: z.uuid(), file_id: z.uuid(), operation: operationSchema,
  attempt: z.number().int().min(1).max(100),
}).strict();
export const processingEventSchema = z.discriminatedUnion("event_type", [
  z.object({ ...identity, event_id: z.uuid(), event_type: z.literal("task.accepted") }).strict(),
  z.object({ ...identity, event_id: z.uuid(), event_type: z.enum([
    "prepare.completed", "prepare.failed", "evaluate.completed", "evaluate.failed",
  ]), job_id: z.uuid(), attempt: z.number().int().positive(), result_id: z.uuid() }).strict(),
]);
export const processingErrorSchema = z.object({
  code: z.enum(["UNSUPPORTED_FORMAT", "INVALID_FILE", "LIMIT_EXCEEDED", "CANNOT_SEPARATE_RESUMES",
    "TEXT_EXTRACTION_FAILED", "PROCESSOR_UNAVAILABLE", "PROCESSING_TIMEOUT", "DELIVERY_LIMIT_EXCEEDED"]),
  message: z.string().min(1).max(2000),
}).strict();
export const processingTargetSchema = z.object({
  id: z.uuid(), name: z.string().trim().min(1).max(300),
  education: z.string().max(10000), experience: z.string().max(10000),
  keywords: z.array(z.string().trim().min(1).max(300)).max(100),
  stop_factors: z.array(z.string().trim().min(1).max(300)).max(100), comment: z.string().max(10000),
}).strict();
export const guestCriteriaSchema = processingTargetSchema.omit({ id: true }).strict();
export const evaluationSchema = z.object({
  target_id: z.uuid(), score: z.number().min(0).max(100),
  criteria: z.array(z.object({ name: z.enum(["education", "experience", "keywords"]),
    status: z.enum(["matched", "partial", "not_matched", "unknown"]), explanation: z.string().max(10000),
  }).strict()).length(3).refine(a => new Set(a.map(c => c.name)).size === 3),
  matched_keywords: z.array(z.string().max(300)).max(100),
  triggered_stop_factors: z.array(z.string().max(300)).max(100), explanation: z.string().max(20000),
}).strict();
export const prepareResultSchema = z.object({
  status: z.literal("completed"), files: z.array(z.object({ file_id: z.uuid() }).strict()).min(1).max(200),
  errors: z.array(z.object({ path: z.string().max(1000), code: processingErrorSchema.shape.code,
    message: z.string().max(2000) }).strict()).max(200),
}).strict().refine(r => new Set(r.files.map(f => f.file_id)).size === r.files.length);
export const evaluateResultSchema = z.object({
  status: z.literal("completed"), candidate: extractedPersonSchema.strict(),
  evaluations: z.array(evaluationSchema).min(1).max(200),
}).strict();
export const failedResultSchema = z.object({ status: z.literal("failed"), error: processingErrorSchema }).strict();
export const outputMetadataSchema = z.object({
  file_name: z.string().min(1).max(255).refine(s => !/[\x00-\x1f/\\]/.test(s)),
  mime_type: z.string().min(1).max(150), source_file_id: z.uuid(),
  archive_path: z.string().max(1000).nullable().refine(s => s === null || (!s.startsWith("/") && !s.includes("\\") && !s.split("/").includes(".."))),
  pages: z.array(z.number().int().positive()).max(10000),
}).strict();
export type ProcessingMode = z.infer<typeof processingModeSchema>;
export type ProcessingCommand = z.infer<typeof processingCommandSchema>;
export type ProcessingEvent = z.infer<typeof processingEventSchema>;
export type ProcessingTarget = z.infer<typeof processingTargetSchema>;
export type ProcessingResult = z.infer<typeof prepareResultSchema> | z.infer<typeof evaluateResultSchema> | z.infer<typeof failedResultSchema>;
export type OutputMetadata = z.infer<typeof outputMetadataSchema>;
