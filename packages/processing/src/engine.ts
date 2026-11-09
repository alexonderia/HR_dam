import { processingCommandSchema, processingEventSchema, prepareResultSchema, evaluateResultSchema, failedResultSchema, type ProcessingEvent, type ProcessingMode } from "@hr/contracts";
import { AccessError, signToken, verifyToken, type Claims } from "@hr/security";
import { command, assignJob, expireWork, finish, live, mutateTask, stableId, terminal, guestAbsoluteTtlMs } from "./state.js";
import type { BlobStore, Job, Publication, Publisher, Task, TaskStore, StoredFile } from "./types.js";

export const jobPermissions = (operation: "prepare" | "evaluate") => ["input:read", "file:read", "progress:write", "result:write", ...(operation === "prepare" ? ["output:write"] : [])];
export class ProcessingEngine {
  constructor(readonly mode: ProcessingMode, readonly store: TaskStore, readonly blobs: BlobStore,
    readonly publisher: Publisher, readonly keys: { privateKey: string; publicKey: string },
    readonly project?: (task: Task, job: Job) => Promise<Job["receipt"]>) {}

  token(job: Job) {
    return signToken({ iss: `hr-${this.mode}-jobs`, aud: `hr-${this.mode}-job-api`, sub: job.job_id,
      mode: this.mode, task_id: job.task_id, file_id: job.file_id, operation: job.operation, attempt: job.attempt,
      permissions: jobPermissions(job.operation), iat: Math.floor(Date.parse(job.created_at) / 1000), exp: Math.floor(Date.parse(job.deadline) / 1000) },
    this.keys.privateKey, "hr-processing-job+jwt");
  }
  async authorize(authorization: string | undefined, jobId: string, permission: string) {
    // Cryptographic mode/issuer checks precede any storage access (including PostgreSQL).
    if (!authorization?.startsWith("Bearer ")) throw new AccessError(401);
    const c = verifyToken(authorization.slice(7), this.keys.publicKey, "hr-processing-job+jwt", `hr-${this.mode}-jobs`, `hr-${this.mode}-job-api`);
    if (c.mode !== this.mode || c.sub !== jobId || !Array.isArray(c.permissions) || !c.permissions.includes(permission)) throw new AccessError(403);
    const record = await this.store.read(String(c.task_id));
    if (!record) throw new AccessError(404, "Задача не найдена.");
    this.checkJob(record.task, c, permission);
    return { task: record.task, claims: c, job: record.task.jobs.find(j => j.job_id === jobId)! };
  }
  checkJob(task: Task, c: Claims, permission: string) {
    live(task);
    const job = task.jobs.find(j => j.job_id === c.sub);
    if (task.mode !== this.mode || !job || c.task_id !== task.id || c.operation !== job.operation || c.file_id !== job.file_id || c.attempt !== job.attempt ||
      c.exp !== Math.floor(Date.parse(job.deadline) / 1000) || Date.now() >= Date.parse(job.deadline)) throw new AccessError(409, "Задание устарело.");
    if (permission === "output:write" && job.operation !== "prepare") throw new AccessError(403);
    return job;
  }
  async dispatch(task: Task, messages: Publication[]) {
    for (const message of messages) await this.publisher.publish(message, task);
  }
  async accept(id: string) {
    const changed = await mutateTask(this.store, id, task => {
      live(task);
      if (task.status !== "uploading") throw new AccessError(409);
      if (!task.source_ids.length || !task.requirements.length || Date.now() >= Date.parse(task.upload_deadline)) throw new AccessError(422, "Загрузка не завершена.");
      task.status = "queued";
      task.deadline = new Date(Math.min(Date.now() + Number(process.env.PROCESSING_TIMEOUT_MS || 1800000), task.mode === "guest" ? Date.parse(task.created_at) + guestAbsoluteTtlMs : Infinity)).toISOString();
      return [{ kind: "event", body: { event_id: task.accepted_event_id, event_type: "task.accepted", task_id: task.id, mode: this.mode, deadline: task.deadline } }];
    });
    await this.dispatch(changed.task, changed.messages);
    return changed.task;
  }
  input(task: Task, job: Job, base: string) {
    const file = task.files.find(f => f.file_id === job.file_id)!;
    const { key: _key, candidate_hint: _hint, ...description } = file;
    return { job_id: job.job_id, attempt: job.attempt, should_process: !job.confirmed && !job.applied && !terminal(task),
      file: { ...description, download_path: `${base}/jobs/${job.job_id}/files/${file.file_id}` },
      ...(job.operation === "evaluate" ? { requirements: { targets: task.requirements } } : {}),
      limits: { max_file_bytes: 52428800, max_expanded_bytes: 262144000, max_files: 200 } };
  }
  async progress(c: Claims, input: { job_id: string; attempt: number; status: string }) {
    const { task } = await mutateTask(this.store, String(c.task_id), task => {
      const job = this.checkJob(task, c, "progress:write");
      if (input.job_id !== job.job_id || input.attempt !== job.attempt || input.status !== "processing") throw new AccessError(409);
      if (job.confirmed || job.applied || terminal(task)) return;
      job.started_at ||= new Date().toISOString(); job.activity_at = new Date().toISOString(); task.status = "processing";
    });
    return task;
  }
  async registerOutput(c: Claims, file: StoredFile) {
    let selected: StoredFile | undefined;
    await mutateTask(this.store, String(c.task_id), task => {
      const job = this.checkJob(task, c, "output:write");
      if (job.result || terminal(task)) throw new AccessError(409, "Результат уже сохранён.");
      selected = task.files.find(f => f.source_file_id === job.file_id && f.output_key === file.output_key);
      if (selected) {
        if (selected.sha256 !== file.sha256 || JSON.stringify(selected.metadata) !== JSON.stringify(file.metadata)) throw new AccessError(409, "Выходной файл изменился.");
        return;
      }
      if (task.files.length >= 400 || task.files.filter(f => f.source_file_id === job.file_id).length >= 200 ||
        task.files.filter(f => f.source_file_id === job.file_id).reduce((n, f) => n + f.size_bytes, file.size_bytes) > 262144000) throw new AccessError(422, "Превышен лимит выделенных файлов.");
      selected = file; task.files.push(file);
    });
    return selected!;
  }
  async result(c: Claims, input: unknown) {
    const saved = await mutateTask(this.store, String(c.task_id), task => {
      const job = this.checkJob(task, c, "result:write");
      if (!job.result) {
        if (terminal(task) || job.applied) throw new AccessError(409);
        const failed = failedResultSchema.safeParse(input);
        const result = failed.success ? failed.data : job.operation === "prepare" ? prepareResultSchema.parse(input) : evaluateResultSchema.parse(input);
        if (result.status === "completed" && "files" in result) {
          if (result.files.some(f => !task.files.some(s => s.file_id === f.file_id && (s.file_id === job.file_id || s.source_file_id === job.file_id)))) throw new AccessError(422, "Файл не принадлежит заданию.");
          if (result.files.some(f => f.file_id === job.file_id) && task.files.find(f => f.file_id === job.file_id)?.mime_type !== "application/pdf") throw new AccessError(422, "Исходник должен быть отдельным PDF.");
        }
        if (result.status === "completed" && "evaluations" in result) {
          const ids = result.evaluations.map(e => e.target_id);
          if (ids.length !== task.requirements.length || new Set(ids).size !== ids.length || ids.some(id => !task.requirements.some(t => t.id === id))) throw new AccessError(422, "Набор целей не соответствует заданию.");
        }
        job.result = result; job.result_id = stableId(`${job.job_id}:result`); job.event_id = stableId(`${job.job_id}:event`);
      }
      return [{ kind: "event", body: this.resultEvent(task, job) }];
    });
    const job = saved.task.jobs.find(j => j.job_id === c.sub)!;
    if (!job.confirmed) {
      await this.dispatch(saved.task, saved.messages);
      await mutateTask(this.store, saved.task.id, task => {
        const current = this.checkJob(task, c, "result:write"); current.confirmed = true;
      });
    }
  }
  resultEvent(task: Task, job: Job): ProcessingEvent {
    return { event_id: job.event_id!, task_id: task.id, job_id: job.job_id,
      event_type: `${job.operation}.${job.result!.status}` as "prepare.completed" | "prepare.failed" | "evaluate.completed" | "evaluate.failed",
      mode: this.mode, result_id: job.result_id!, attempt: job.attempt, deadline: job.deadline };
  }
  async event(input: unknown) {
    const event = processingEventSchema.parse(input);
    if (event.mode !== this.mode) throw new AccessError(422);
    let record = await this.store.read(event.task_id);
    if (!record || record.task.deleted_at || (this.mode === "guest" && Date.now() >= Date.parse(record.task.expires_at))) return;
    // Project business data before marking an event applied. The DB receipt is idempotent.
    let receipt: Job["receipt"];
    let projectionError: string | undefined;
    if (event.event_type !== "task.accepted") {
      const job = record.task.jobs.find(j => j.job_id === event.job_id);
      if (!job || job.attempt !== event.attempt || job.result_id !== event.result_id || job.event_id !== event.event_id || !job.result || event.deadline !== job.deadline || event.event_type !== `${job.operation}.${job.result.status}`) throw new AccessError(422, "Событие не соответствует сохранённому результату.");
      if (!job.applied && Date.now() < Date.parse(job.deadline) && this.project) {
        try { receipt = await this.project(record.task, job); }
        catch (error) {
          if (error instanceof AccessError && [409, 422].includes(error.status)) projectionError = error.message;
          else throw error;
        }
      }
    }
    const changed = await mutateTask(this.store, event.task_id, task => {
      if (task.deleted_at) return;
      expireWork(task);
      if (terminal(task)) return;
      if (event.event_type === "task.accepted" && event.deadline !== task.deadline) throw new AccessError(422);
      const messages: Publication[] = [];
      if (event.event_type === "task.accepted") {
        if (event.event_id !== task.accepted_event_id) throw new AccessError(422);
        for (const file of task.files.filter(f => task.source_ids.includes(f.file_id))) {
          const operation = !file.target_resume_id && ["application/zip", "application/pdf"].includes(file.mime_type) ? "prepare" : "evaluate";
          messages.push(command(assignJob(task, file, operation)));
        }
      } else {
        const job = task.jobs.find(j => j.job_id === event.job_id)!;
        if (job.result?.status === "completed" && "files" in job.result) for (const output of job.result.files) {
          const file = task.files.find(f => f.file_id === output.file_id)!;
          messages.push(command(assignJob(task, file, "evaluate")));
        }
        job.applied = true; job.confirmed = true; if (receipt) job.receipt = receipt;
        if (projectionError) job.projection_error = projectionError;
      }
      if (task.jobs.length && task.jobs.every(j => j.applied)) finish(task, Date.now());
      return messages;
    });
    // Even on redelivery, publish all stable derivative IDs before ACK.
    await this.dispatch(changed.task, changed.messages);
  }
  async dead(input: unknown) {
    const parsed = processingCommandSchema.safeParse(input);
    const event = processingEventSchema.safeParse(input);
    if (!parsed.success && !event.success) return;
    const body = parsed.success ? parsed.data : event.data!;
    if (body.mode !== this.mode) return;
    if (!await this.store.read(body.task_id)) return;
    if (event.success && (event.data.event_type.startsWith("evaluate.") || event.data.event_type === "prepare.failed")) {
      // A saved evaluation remains valid when only its event delivery failed.
      // Accounting it here performs no publication back into the work queue.
      await this.event(event.data); return;
    }
    const changed = await mutateTask(this.store, body.task_id, task => {
      if (task.deleted_at || terminal(task)) return;
      if (!("job_id" in body) && body.deadline !== task.deadline) return;
      expireWork(task); if (terminal(task)) return;
      const jobs = "job_id" in body ? task.jobs.filter(j => j.job_id === body.job_id && j.attempt === body.attempt) : task.jobs;
      for (const job of jobs) if (!job.applied) {
        if (job.result && job.confirmed) continue;
        job.result = { status: "failed", error: { code: "DELIVERY_LIMIT_EXCEEDED", message: "Не удалось завершить обработку. Отправьте файлы заново." } }; job.applied = true;
      }
      if (event.success && event.data.event_type === "prepare.completed") {
        const parentId = event.data.job_id;
        const parent = task.jobs.find(j => j.job_id === parentId);
        if (parent?.result?.status === "completed" && "files" in parent.result) {
          parent.applied = true;
          for (const output of parent.result.files) {
            const child = task.jobs.find(j => j.operation === "evaluate" && j.file_id === output.file_id);
            if (child && !child.applied && !child.confirmed) {
              child.result = { status: "failed", error: { code: "DELIVERY_LIMIT_EXCEEDED", message: "Не удалось передать резюме на оценку." } }; child.applied = true;
            }
          }
        }
      }
      if (!("job_id" in body) || task.jobs.every(j => j.applied)) finish(task, Date.now());
    });
    if (this.project) for (const job of changed.task.jobs) if (job.applied && job.result?.status === "failed")
      await this.project(changed.task, job);
  }
}
