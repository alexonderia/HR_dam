import { randomUUID } from "node:crypto";
import { identityKey, fullName, validateRankResponse, contactsResponseSchema,
  assessmentCompletedMessage, type Cluster, type ProcessingResult } from "@hr/contracts";
import { transaction, blacklistMatchSql } from "@hr/data-access";
import type { StoredFile } from "@hr/processing";
import { emptyPerson, manualContactFields, planContactUpdate } from "./contact-policy.js";
import { lockContactWrites, writeContactPlan } from "./contact-persistence.js";
import { config } from "./config.js";
import { HttpError } from "./errors.js";

export async function persistResult(requirements: Cluster[], file: StoredFile, jobId: string,
  result: Extract<ProcessingResult, { evaluations: unknown }>, analysisDurationMs: number | null) {
  const evaluations = new Map(result.evaluations.map(evaluation => [evaluation.target_id, evaluation]));
  const comparisons = requirements.map(cluster => ({
    id: cluster.id,
    profiles: cluster.profiles.map(profile => {
      const evaluation = evaluations.get(profile.id);
      if (!evaluation) throw new HttpError(409, "Обработчик вернул неполный результат оценки.");
      const { score, matched_keywords, triggered_stop_factors, explanation, details, criteria } = evaluation;
      return { id: profile.id, score, matched_keywords, triggered_stop_factors, explanation, details: details || { criteria } };
    }),
  }));
  let rank: ReturnType<typeof validateRankResponse>;
  try { rank = validateRankResponse({ clusters: comparisons }, requirements); }
  catch { throw new HttpError(409, "Обработчик вернул некорректное обоснование оценки."); }
  if (result.contact_details && !contactsResponseSchema.safeParse(result).success)
    throw new HttpError(409, "Контакты не подтверждены источником.");
  const manual = manualContactFields(file);
  const initial = planContactUpdate(emptyPerson(), result.candidate, result.contact_details, file.file_id, file.candidate_hint, manual, true);
  const person = initial.values;
  return transaction(async client => {
    await lockContactWrites(client);
    const existingReceipt = await client.query(`SELECT r.id AS resume_id,r.candidate_id FROM resume_events e
      JOIN resumes r ON r.id=e.resume_id WHERE e.id=$1 AND e.event_type='scored'`, [jobId]);
    if (existingReceipt.rows[0]) return { ...existingReceipt.rows[0], warning: undefined };
    const nameComplete = Boolean(person.last_name && person.first_name);
    const nameKey = nameComplete ? identityKey(fullName(person)) : null;
    const lockKeys = [person.phone ? `phone:${person.phone}` : null, nameKey ? `name:${nameKey}` : null]
      .filter((key): key is string => Boolean(key)).sort();
    for (const key of lockKeys) await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [key]);
    let candidateId: string, resumeId: string, replacing = false;
    if (file.target_resume_id) {
      const current = await client.query("SELECT *,updated_at=$2::timestamptz AS lease_matches FROM resumes WHERE id=$1 FOR UPDATE", [file.target_resume_id, file.target_updated_at]);
      const row = current.rows[0];
      if (!row || row.file_id !== file.file_id || !row.lease_matches)
        throw new HttpError(409, "Резюме изменилось после отправки на оценку. Запустите новую обработку.");
      candidateId = row.candidate_id; resumeId = row.id;
      const currentContacts = await client.query("SELECT * FROM candidates WHERE id=$1 FOR UPDATE", [candidateId]);
      await writeContactPlan(client, candidateId, planContactUpdate(currentContacts.rows[0], result.candidate,
        result.contact_details, file.file_id));
    } else {
      const matched = await client.query(`SELECT c.* FROM candidates c WHERE c.phone=$1 OR ($2::boolean AND
        lower(replace(c.last_name,'ё','е'))=$3 AND lower(replace(c.first_name,'ё','е'))=$4 AND
        lower(replace(coalesce(c.middle_name,''),'ё','е'))=$5) FOR UPDATE OF c`,
        [person.phone, nameComplete, identityKey(person.last_name || ""), identityKey(person.first_name || ""), identityKey(person.middle_name || "")]);
      if (matched.rows.length > 1) throw new HttpError(409, "Телефон и ФИО относятся к разным кандидатам. Требуется ручная проверка.");
      const same = matched.rows[0];
      if (same && ((person.phone && same.phone && person.phone !== same.phone) ||
          (nameComplete && same.last_name && same.first_name && identityKey(fullName(same)) !== nameKey)))
        throw new HttpError(409, "Найден кандидат с совпадающими и противоречащими данными. Требуется ручная проверка.");
      candidateId = same?.id || randomUUID();
      const currentResume = same ? await client.query("SELECT * FROM resumes WHERE candidate_id=$1 FOR UPDATE", [candidateId]) : null;
      const current = currentResume?.rows[0];
      if (current?.status === "in_process") throw new HttpError(409, "Кандидат в процессе отбора. Замена резюме запрещена.");
      resumeId = current?.id || randomUUID(); replacing = Boolean(current);
      if (!same) await client.query(`INSERT INTO candidates(id,phone,last_name,first_name,middle_name,contact_provenance,created_at,updated_at)
        VALUES($1,$2,$3,$4,$5,$6,now(),now())`, [candidateId, person.phone, person.last_name, person.first_name, person.middle_name, JSON.stringify(initial.provenance)]);
      else await writeContactPlan(client, candidateId, planContactUpdate(same, result.candidate, result.contact_details,
        file.file_id, file.candidate_hint, manual));
      await client.query(`INSERT INTO files(id,bucket,object_key,file_name,mime_type,size_bytes,file_sha256,created_at)
        VALUES($1,$2,$3,$4,$5,$6,$7,now())`, [file.file_id, config.bucket, file.key, file.file_name, file.mime_type, file.size_bytes, file.sha256]);
      if (current) await client.query("UPDATE resumes SET file_id=$2,status='in_work',scoring_status='completed',updated_at=now() WHERE id=$1", [resumeId, file.file_id]);
      else await client.query(`INSERT INTO resumes(id,candidate_id,file_id,status,scoring_status,created_at,updated_at)
        VALUES($1,$2,$3,'in_work','completed',now(),now())`, [resumeId, candidateId, file.file_id]);
      await client.query(`INSERT INTO resume_events(id,resume_id,event_type,message,created_at) VALUES($1,$2,$3,$4,now())`,
        [randomUUID(), resumeId, replacing ? "replaced" : "uploaded", replacing ? "Найдено ранее загруженное резюме. Текущее резюме обновлено." : "Резюме загружено и обработано."]);
    }
    await client.query("UPDATE resumes SET contact_extraction=$2 WHERE id=$1", [resumeId, JSON.stringify(result.contact_details ?? null)]);
    const blacklisted = await client.query(`SELECT EXISTS(SELECT 1 FROM candidates c JOIN candidate_blacklist b
      ON b.is_active AND ${blacklistMatchSql} WHERE c.id=$1) AS matched`, [candidateId]);
    const warning = blacklisted.rows[0].matched ? "Кандидат найден в чёрном списке. Требуется ручная проверка." : undefined;
    if (file.assessment_cluster_ids) {
      const ids = requirements.map(cluster => cluster.id);
      if (!file.target_resume_id || ids.length !== file.assessment_cluster_ids.length
          || ids.some(id => !file.assessment_cluster_ids!.includes(id)))
        throw new HttpError(409, "Набор кластеров повторной оценки не соответствует требованиям задания.");
      await client.query(`DELETE FROM profile_ratings p USING profiles f
        WHERE p.resume_id=$1 AND p.profile_id=f.id AND f.cluster_id=ANY($2::uuid[])`, [resumeId, ids]);
    } else {
      await client.query("DELETE FROM profile_ratings WHERE resume_id=$1", [resumeId]);
      await client.query("DELETE FROM resume_cluster_assessments WHERE resume_id=$1", [resumeId]);
    }
    for (const cluster of rank.clusters) for (const rating of cluster.profiles) await client.query(
      `INSERT INTO profile_ratings(id,resume_id,profile_id,score,matched_keywords,triggered_stop_factors,details,explanation,calculated_at)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,now())`, [randomUUID(), resumeId, rating.id, rating.score,
        JSON.stringify(rating.matched_keywords ?? null), JSON.stringify(rating.triggered_stop_factors ?? null), JSON.stringify(rating.details ?? null), rating.explanation ?? null]);
    for (const cluster of requirements) await client.query(`INSERT INTO resume_cluster_assessments(resume_id,cluster_id,requirements,assessed_at)
      VALUES($1,$2,$3,now()) ON CONFLICT(resume_id,cluster_id) DO UPDATE SET requirements=EXCLUDED.requirements,assessed_at=EXCLUDED.assessed_at`,
      [resumeId, cluster.id, JSON.stringify(cluster)]);
    await client.query("UPDATE resumes SET scoring_status='completed',updated_at=now() WHERE id=$1", [resumeId]);
    // The event UUID remains the idempotency receipt for this analysis attempt.
    await client.query("INSERT INTO resume_events(id,resume_id,event_type,message,created_at,analysis_duration_ms) VALUES($1,$2,'scored',$3,now(),$4)",
      [jobId, resumeId, assessmentCompletedMessage(Boolean(warning)), analysisDurationMs]);
    return { candidate_id: candidateId, resume_id: resumeId, warning };
  });
}

export async function markTargetFailure(file: StoredFile, jobId: string, message: string, analysisDurationMs: number | null) {
  if (!file.target_resume_id) return;
  await transaction(async client => {
    const updated = await client.query(`UPDATE resumes SET scoring_status='failed' WHERE id=$1 AND file_id=$2
      AND updated_at=$3::timestamptz AND scoring_status IN ('pending','processing') RETURNING id`,
      [file.target_resume_id, file.file_id, file.target_updated_at]);
    if (updated.rowCount) await client.query(`INSERT INTO resume_events(id,resume_id,event_type,message,created_at,analysis_duration_ms)
      VALUES($1,$2,'scoring_failed',$3,now(),$4) ON CONFLICT(id) DO NOTHING`, [jobId, file.target_resume_id, message.slice(0, 2000), analysisDurationMs]);
  });
}
