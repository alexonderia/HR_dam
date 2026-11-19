import type { ExtractedPerson } from "./domain.js";

export type ImportItemStatus = "uploading" | "pending" | "processing" | "completed" | "failed";
export interface ResumeImportSummary {
  id: string; archive_name: string; created_at: string; total_files: number;
  source_files?: number; candidate_files?: number;
  processed_files: number; failed_files: number; pending_files: number;
  uploading_files: number; processing_files: number; ignored_files: string[];
}
export interface ResumeImportItem {
  id: string; source_path: string; file_name: string; status: ImportItemStatus; attempt: number;
  error: string | null; warning: string | null; candidate_id: string | null; resume_id: string | null; updated_at: string;
  analysis_started_at?: string | null; analysis_duration_ms?: number | null;
  profile_progress?: { completed: number; total: number };
  file_sha256?: string; candidate_hint?: ExtractedPerson; target_resume_id?: string;
}
export interface ResumeImportDetail extends ResumeImportSummary { items: ResumeImportItem[] }
export interface BrokerStatus {
  available: boolean; analysis_consumers: number;
  queues: Record<string, { ready: number; processing: number; consumers: number }>;
}
