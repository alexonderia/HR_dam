import { randomUUID } from "node:crypto";
import { importResultSchema, importEventSchema, identityKey, fullName, validateRankResponse,
  assessmentCompletedMessage, type ImportResult, type ImportFile, type ImportManifest, type ImportEvent } from "@hr/contracts";
import { transaction, pool, readImportLedger, latestItemEvent, publishImportEvent, startQueueConsumer,
  queues, PermanentQueueError, MissingImportError, blacklistMatchSql } from "@hr/data-access";

async function trustedJob(result: Pick<ImportResult, "batch_id" | "item_id" | "job_id" | "attempt">) {
  const { manifest, events } = await readImportLedger(result.batch_id).catch(error => {
    if (error instanceof MissingImportError) throw new PermanentQueueError(error.message);
    throw error;
  });
  const file = manifest.items.find(i => i.id === result.item_id);
  if (!file) throw new PermanentQueueError("Файл не принадлежит загрузке.");
  const latest = latestItemEvent(events, result.item_id);
  if (!latest || latest.attempt !== result.attempt || latest.job_id !== result.job_id) return null;
  return { manifest, file, latest };
}
async function persistResult(manifest: ImportManifest, file: ImportFile, result: Extract<ImportResult, { status: "completed" }>) {
  const rank = validateRankResponse(result.analysis, manifest.requirements);
  const person = { ...result.candidate };
  for (const key of ["last_name", "first_name", "middle_name", "phone"] as const)
    if (file.candidate_hint[key]) person[key] = file.candidate_hint[key];
  return transaction(async client => {
    const existingReceipt = await client.query(`SELECT r.id AS resume_id,r.candidate_id FROM resume_events e
      JOIN resumes r ON r.id=e.resume_id WHERE e.id=$1 AND e.event_type='scored'`, [result.job_id]);
    if (existingReceipt.rows[0]) return { ...existingReceipt.rows[0], warning: undefined };
    const nameComplete = Boolean(person.last_name && person.first_name);
    const nameKey = nameComplete ? identityKey(fullName(person)) : null;
    const lockKeys = [person.phone ? `phone:${person.phone}` : null, nameKey ? `name:${nameKey}` : null]
      .filter((key): key is string => Boolean(key)).sort();
    for (const key of lockKeys) await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [key]);
    let candidateId: string, resumeId: string, replacing = false;
    if (file.target_resume_id) {
      const current = await client.query("SELECT *,updated_at::text AS lease FROM resumes WHERE id=$1 FOR UPDATE", [file.target_resume_id]);
      const row = current.rows[0];
      if (!row || row.file_id !== file.file_id || row.lease !== file.target_updated_at)
        throw new PermanentQueueError("Резюме изменилось после отправки на оценку. Запустите новую обработку.");
      candidateId = row.candidate_id; resumeId = row.id;
    } else {
      const matched = await client.query(`SELECT c.* FROM candidates c WHERE c.phone=$1 OR ($2::boolean AND
        lower(replace(c.last_name,'ё','е'))=$3 AND lower(replace(c.first_name,'ё','е'))=$4 AND
        lower(replace(coalesce(c.middle_name,''),'ё','е'))=$5) FOR UPDATE OF c`,
        [person.phone, nameComplete, identityKey(person.last_name || ""), identityKey(person.first_name || ""), identityKey(person.middle_name || "")]);
      if (matched.rows.length > 1) throw new PermanentQueueError("Телефон и ФИО относятся к разным кандидатам. Требуется ручная проверка.");
      const same = matched.rows[0];
      if (same && ((person.phone && same.phone && person.phone !== same.phone) ||
          (nameComplete && same.last_name && same.first_name && identityKey(fullName(same)) !== nameKey)))
        throw new PermanentQueueError("Найден кандидат с совпадающими и противоречащими данными. Требуется ручная проверка.");
      candidateId = same?.id || randomUUID();
      const currentResume = same ? await client.query("SELECT * FROM resumes WHERE candidate_id=$1 FOR UPDATE", [candidateId]) : null;
      const current = currentResume?.rows[0];
      if (current?.status === "in_process") throw new PermanentQueueError("Кандидат в процессе отбора. Замена резюме запрещена.");
      resumeId = current?.id || randomUUID(); replacing = Boolean(current);
      if (!same) await client.query(`INSERT INTO candidates(id,phone,last_name,first_name,middle_name,created_at,updated_at)
        VALUES($1,$2,$3,$4,$5,now(),now())`, [candidateId, person.phone, person.last_name, person.first_name, person.middle_name]);
      else await client.query(`UPDATE candidates SET phone=coalesce(phone,$2),last_name=coalesce(last_name,$3),
        first_name=coalesce(first_name,$4),middle_name=coalesce(middle_name,$5),updated_at=now() WHERE id=$1`,
        [candidateId, person.phone, person.last_name, person.first_name, person.middle_name]);
      await client.query(`INSERT INTO files(id,bucket,object_key,file_name,mime_type,size_bytes,file_sha256,created_at)
        VALUES($1,$2,$3,$4,$5,$6,$7,now())`, [file.file_id, file.bucket, file.object_key, file.file_name, file.mime_type, file.size_bytes, file.sha256]);
      if (current) await client.query("UPDATE resumes SET file_id=$2,status='in_work',scoring_status='completed',updated_at=now() WHERE id=$1", [resumeId, file.file_id]);
      else await client.query(`INSERT INTO resumes(id,candidate_id,file_id,status,scoring_status,created_at,updated_at)
        VALUES($1,$2,$3,'in_work','completed',now(),now())`, [resumeId, candidateId, file.file_id]);
      await client.query(`INSERT INTO resume_events(id,resume_id,event_type,message,created_at) VALUES($1,$2,$3,$4,now())`,
        [randomUUID(), resumeId, replacing ? "replaced" : "uploaded", replacing ? "Найдено ранее загруженное резюме. Текущее резюме обновлено." : "Резюме загружено и обработано."]);
    }
    const blacklisted = await client.query(`SELECT EXISTS(SELECT 1 FROM candidates c JOIN candidate_blacklist b
      ON b.is_active AND ${blacklistMatchSql} WHERE c.id=$1) AS matched`, [candidateId]);
    const warning = blacklisted.rows[0].matched ? "Кандидат найден в чёрном списке. Требуется ручная проверка." : undefined;
    await client.query("DELETE FROM profile_ratings WHERE resume_id=$1", [resumeId]);
    for (const cluster of rank.clusters) for (const rating of cluster.profiles) await client.query(
      `INSERT INTO profile_ratings(id,resume_id,profile_id,score,matched_keywords,triggered_stop_factors,details,explanation,calculated_at)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,now())`, [randomUUID(), resumeId, rating.id, rating.score,
        JSON.stringify(rating.matched_keywords ?? null), JSON.stringify(rating.triggered_stop_factors ?? null), JSON.stringify(rating.details ?? null), rating.explanation ?? null]);
    await client.query("UPDATE resumes SET scoring_status='completed',updated_at=now() WHERE id=$1", [resumeId]);
    // Existing event UUID is the idempotency receipt; no new DB fields or tables.
    await client.query("INSERT INTO resume_events(id,resume_id,event_type,message,created_at) VALUES($1,$2,'scored',$3,now())",
      [result.job_id, resumeId, assessmentCompletedMessage(Boolean(warning))]);
    return { candidate_id: candidateId, resume_id: resumeId, warning };
  });
}
export async function processImportResult(input: unknown) {
  const parsed = importResultSchema.safeParse(input);
  if (!parsed.success) throw new PermanentQueueError("Результат не соответствует контракту.");
  const result = parsed.data, job = await trustedJob(result);
  if (!job) return; // A newer manual retry superseded this attempt.
  const common = { version: 1 as const, job_id: result.job_id, batch_id: result.batch_id, item_id: result.item_id,
    attempt: result.attempt, created_at: new Date().toISOString() };
  const stored = await pool.query(`SELECT r.id AS resume_id,r.candidate_id,
    EXISTS(SELECT 1 FROM candidate_blacklist b WHERE b.is_active AND ${blacklistMatchSql}) AS blacklisted
    FROM resume_events e JOIN resumes r ON r.id=e.resume_id JOIN candidates c ON c.id=r.candidate_id
    WHERE e.id=$1 AND e.event_type='scored'`, [result.job_id]);
  if (stored.rows[0]) {
    if (job.latest.stage !== "completed") await publishImportEvent({ ...common, stage: "completed",
      candidate_id: stored.rows[0].candidate_id, resume_id: stored.rows[0].resume_id,
      warning: stored.rows[0].blacklisted ? "Кандидат найден в чёрном списке. Требуется ручная проверка." : undefined });
    return;
  }
  if (job.latest.stage === "completed" || job.latest.stage === "failed") return;
  if (result.status === "failed") {
    await markTargetFailure(job.file, result.job_id, result.error.message);
    await publishImportEvent({ ...common, stage: "failed", error: result.error.message });
    return;
  }
  let receipt: { candidate_id: string; resume_id: string; warning?: string };
  try { receipt = await persistResult(job.manifest, job.file, result); }
  catch (error) {
    if (error instanceof PermanentQueueError) throw error;
    if (error instanceof Error && /неполный|некорректный набор|профилей/.test(error.message)) throw new PermanentQueueError(error.message);
    throw error;
  }
  await publishImportEvent({ ...common, stage: "completed", ...receipt });
}
async function markTargetFailure(file: ImportFile, jobId: string, message: string) {
  if (!file.target_resume_id) return;
  await transaction(async client => {
    const updated = await client.query(`UPDATE resumes SET scoring_status='failed' WHERE id=$1 AND file_id=$2
      AND updated_at=$3::timestamptz AND scoring_status IN ('pending','processing') RETURNING id`,
      [file.target_resume_id, file.file_id, file.target_updated_at]);
    if (updated.rowCount) await client.query(`INSERT INTO resume_events(id,resume_id,event_type,message,created_at)
      VALUES($1,$2,'scoring_failed',$3,now()) ON CONFLICT(id) DO NOTHING`, [jobId, file.target_resume_id, message.slice(0, 2000)]);
  });
}
export async function failImportResult(input: unknown, error: Error) {
  const envelope = importEventSchema.pick({ version: true, job_id: true, batch_id: true, item_id: true, attempt: true }).safeParse(input);
  if (!envelope.success) return;
  const job = await trustedJob(envelope.data);
  if (!job || ["completed", "failed"].includes(job.latest.stage)) return;
  // A DB commit followed by lost RabbitMQ confirm is success, even after retries.
  const receipt = await pool.query("SELECT 1 FROM resume_events WHERE id=$1 AND event_type='scored'", [envelope.data.job_id]);
  if (receipt.rowCount) { await processImportResult(input); return; }
  await markTargetFailure(job.file, envelope.data.job_id, error.message);
  await publishImportEvent({ ...envelope.data, stage: "failed", created_at: new Date().toISOString(),
    error: error instanceof PermanentQueueError ? error.message : "Не удалось сохранить результат. Повторите обработку." });
}
export async function processImportProgress(input: unknown) {
  const parsed = importEventSchema.safeParse(input);
  if (!parsed.success || parsed.data.stage !== "processing") throw new PermanentQueueError("Invalid analyzer progress event");
  const event: ImportEvent = parsed.data, job = await trustedJob(event);
  if (!job || ["failed", "completed"].includes(job.latest.stage)) return;
  if (job.file.target_resume_id) await pool.query(`UPDATE resumes SET scoring_status='processing' WHERE id=$1 AND file_id=$2
    AND updated_at=$3::timestamptz AND scoring_status='pending'`, [job.file.target_resume_id, job.file.file_id, job.file.target_updated_at]);
  await publishImportEvent({ ...event, created_at: new Date().toISOString() });
}
export function startResultConsumers() {
  const results = startQueueConsumer(queues.results, processImportResult, failImportResult);
  const progress = startQueueConsumer(queues.progress, processImportProgress, async () => {});
  return async () => { await results(); await progress(); };
}
