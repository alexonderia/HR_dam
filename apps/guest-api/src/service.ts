import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { z } from "zod";
import { guestCriteriaSchema, ratingEvidence, explainEvidenceRating } from "@hr/contracts";
import { AccessError } from "@hr/security";
import { newTask, mutateTask, live, expireWork, guestAbsoluteTtlMs, inspectUpload, type ObjectStore, type GuestTaskStore, type ProcessingEngine, type Task, type IncomingFile } from "@hr/processing";
import { AdmissionQueue } from "./admission.js";

export const digest = (s: string) => createHash("sha256").update(s).digest("hex");
export class GuestService {
  readonly admission: AdmissionQueue;
  constructor(readonly objects: ObjectStore, readonly store: GuestTaskStore, readonly engine: ProcessingEngine) { this.admission = new AdmissionQueue(objects); }
  async begin(owner: string, idempotency: string, fingerprint: string, permit: string) {
    z.string().min(16).max(200).regex(/^[\w-]+$/).parse(idempotency);
    z.string().regex(/^[a-f0-9]{64}$/).parse(fingerprint); z.uuid().parse(permit);
    const key = `idempotency/${owner}/${digest(idempotency)}.json`;
    let existing = await this.objects.json<{ task_id: string; fingerprint: string; expires_at: string }>(key);
    if (!existing) {
      const task = newTask("guest", owner, "Гостевая обработка", []);
      await this.admission.claim(permit, owner, task.id);
      if (await this.objects.conditional(key, { task_id: task.id, fingerprint, expires_at: task.expires_at }, null)) {
        await this.store.create(task); return { task, duplicate: false, fingerprint };
      }
      existing = await this.objects.json(key);
    }
    if (!existing || existing.value.fingerprint !== fingerprint) throw new AccessError(409, "Для изменённой отправки нужен новый Idempotency-Key.");
    const record = await this.store.read(existing.value.task_id);
    if (!record) throw new AccessError(410, "Отправка больше недоступна. Создайте новую.");
    if (record.task.owner !== owner) throw new AccessError(404);
    live(record.task); return { task: record.task, duplicate: true, fingerprint };
  }
  async upload(task: Task, files: IncomingFile[], body: Record<string, unknown>, fingerprint: string, duplicate: boolean) {
    const criteria = guestCriteriaSchema.parse(JSON.parse(String(body.criteria)));
    const descriptions: Awaited<ReturnType<typeof inspectUpload>>[] = [];
    for (const file of files) descriptions.push(await inspectUpload(file));
    const actual = digest(JSON.stringify({ criteria, files: descriptions.map(f => ({ name: f.file_name, size: f.size_bytes, sha256: f.sha256 })) }));
    if (actual !== fingerprint) throw new AccessError(409, "Состав отправки изменился. Создайте новую отправку.");
    if (duplicate) return this.read(task.id, task.owner);
    await mutateTask(this.store, task.id, current => {
      live(current); current.requirements = [{ id: randomUUID(), ...criteria }]; current.name = descriptions[0].file_name;
    });
    for (let i = 0; i < files.length; i++) {
      const fileId = randomUUID(), key = `tasks/${task.id}/files/${fileId}`;
      await this.objects.put(key, createReadStream(files[i].path), files[i].size, descriptions[i].mime_type);
      try {
        await mutateTask(this.store, task.id, current => {
          live(current);
          if (current.status !== "uploading" || Date.now() >= Date.parse(current.upload_deadline)) throw new AccessError(409);
          current.files.push({ ...descriptions[i], file_id: fileId, key }); current.source_ids.push(fileId);
        });
      } catch (error) { await this.objects.remove(key); throw error; }
    }
    return this.engine.accept(task.id);
  }
  async read(id: string, owner: string) {
    const record = await this.store.read(id);
    if (!record || record.task.owner !== owner) throw new AccessError(404, "Задача не найдена.");
    live(record.task);
    const { task } = await mutateTask(this.store, id, current => { live(current); expireWork(current); });
    live(task); return task;
  }
  async delete(id: string, owner: string) {
    const record = await this.store.read(id);
    if (!record || record.task.owner !== owner) throw new AccessError(404);
    await mutateTask(this.store, id, task => { task.deleted_at ||= new Date().toISOString(); });
  }
  async cleanup() {
    // Sequential deletion bounds S3 load; this scan never restarts processing.
    let failures = 0;
    for await (const id of this.store.list()) {
      try {
      const record = await this.store.read(id); if (!record) continue;
      if (!record.task.deleted_at) await mutateTask(this.store, id, task => {
        expireWork(task);
        if (Date.now() >= Date.parse(task.expires_at)) task.deleted_at = new Date().toISOString();
      });
      const current = (await this.store.read(id))!.task;
      if (!current.deleted_at) continue;
      for await (const key of this.objects.keys(`tasks/${id}/`)) if (!key.endsWith("/state.json")) await this.objects.remove(key);
      await mutateTask(this.store, id, task => { task.files = []; task.jobs = []; task.source_ids = []; task.requirements = []; task.name = ""; delete task.clusters; });
      if (Date.now() >= Date.parse(current.created_at) + guestAbsoluteTtlMs) await this.objects.remove(`tasks/${id}/state.json`);
      } catch { failures++; }
    }
    for await (const key of this.objects.keys("idempotency/")) {
      const r = await this.objects.json<{ expires_at: string }>(key);
      if (r && Date.now() >= Date.parse(r.value.expires_at)) await this.objects.remove(key);
    }
    // A process can die between writing a blob and registering it. Tasks are
    // always created before blobs, so a prefix without state is an orphan.
    for await (const key of this.objects.keys("tasks/")) {
      const match = /^tasks\/([a-f0-9-]{36})\/files\//.exec(key);
      if (match && !await this.store.read(match[1])) await this.objects.remove(key);
    }
    await this.admission.change(() => {});
    if (failures) console.error(`Guest cleanup: ${failures} tasks retained for retry`);
  }
}
export function guestReport(task: Task) {
  return { task_id: task.id, status: task.status, created_at: task.created_at, expires_at: task.expires_at,
    finished_at: task.finished_at || null, source_count: task.source_ids.length,
    candidate_count: task.jobs.filter(j => j.operation === "evaluate").length,
    completed_count: task.jobs.filter(j => j.operation === "evaluate" && j.applied && j.result?.status === "completed").length,
    files: task.files.map(file => ({ file_id: file.file_id, file_name: file.file_name, source_file_id: file.source_file_id || null, pages: file.metadata?.pages || [] })),
    results: task.jobs.flatMap(j => {
      const result = j.result;
      if (j.operation !== "evaluate" || !j.applied || result?.status !== "completed" || !("evaluations" in result)) return [];
      return [{ file_id: j.file_id, ...result,
        evaluations: result.evaluations.map(evaluation => {
          const evidence = ratingEvidence(evaluation);
          return evidence ? { ...evaluation, explanation: explainEvidenceRating(evidence) } : evaluation;
        }),
      }];
    }),
    errors: task.jobs.filter(j => j.applied && j.result).flatMap(j => j.result!.status === "failed"
      ? [{ file_id: j.file_id, ...j.result!.error }] : "errors" in j.result! ? j.result!.errors.map(e => ({ file_id: j.file_id, ...e })) : []) };
}
