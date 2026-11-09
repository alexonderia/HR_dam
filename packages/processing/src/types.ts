import type { Readable } from "node:stream";
import type { Cluster, ExtractedPerson, OutputMetadata, ProcessingCommand, ProcessingEvent, ProcessingMode, ProcessingResult, ProcessingTarget } from "@hr/contracts";

export interface StoredFile {
  file_id: string; file_name: string; mime_type: string; size_bytes: number; sha256: string; key: string;
  source_file_id?: string; metadata?: OutputMetadata; output_key?: string;
  candidate_hint?: ExtractedPerson; target_resume_id?: string; target_updated_at?: string; assessment_cluster_ids?: string[];
}
export interface Job extends ProcessingCommand {
  created_at: string; started_at?: string; activity_at?: string; result?: ProcessingResult;
  result_id?: string; event_id?: string; confirmed?: boolean; applied?: boolean;
  receipt?: { candidate_id: string; resume_id: string; warning?: string };
  projection_error?: string;
}
export interface Task {
  id: string; mode: ProcessingMode; owner: string; name: string; created_at: string; expires_at: string;
  deadline: string; finished_at?: string; deleted_at?: string; upload_deadline: string;
  status: "uploading" | "queued" | "processing" | "completed" | "partially_completed" | "failed";
  files: StoredFile[]; source_ids: string[]; jobs: Job[]; requirements: ProcessingTarget[];
  clusters?: Cluster[]; accepted_event_id: string;
}
export type Publication = { kind: "command"; body: ProcessingCommand } | { kind: "event"; body: ProcessingEvent };
export interface TaskStore {
  create(task: Task, messages?: Publication[]): Promise<void>;
  read(id: string): Promise<{ task: Task; version: string } | null>;
  replace(task: Task, version: string, messages?: Publication[]): Promise<boolean>;
  list(): AsyncIterable<string>;
}
export interface BlobStore {
  put(key: string, source: Readable | Buffer, size: number, mime: string): Promise<void>;
  get(key: string): Promise<Readable>;
  remove(key: string): Promise<void>;
}
export interface Publisher { publish(message: Publication, task: Task): Promise<void> }
