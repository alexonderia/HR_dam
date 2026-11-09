import { createHash, randomUUID } from "node:crypto";
import { contactsResponseSchema, contactFields, type ContactRecoveryPreview } from "@hr/contracts";
import { getFile, pool, transaction } from "@hr/data-access";
import { HttpError } from "./errors.js";
import { contactLabels, planContactUpdate, type StoredContacts } from "./contact-policy.js";
import { lockContactWrites, writeContactPlan } from "./contact-persistence.js";

interface RecoveryRow extends StoredContacts {
  resume_id: string; candidate_id: string; file_id: string; file_sha256: string; file_name: string; mime_type: string;
  size_bytes: string; bucket: string; object_key: string;
}
async function readResume(id: string, client: Pick<typeof pool, "query"> = pool, lock = false): Promise<RecoveryRow> {
  const result = await client.query(`SELECT c.last_name,c.first_name,c.middle_name,c.phone,c.contact_provenance,r.id AS resume_id,r.candidate_id,r.file_id,
    f.file_sha256,f.file_name,f.mime_type,f.size_bytes,f.bucket,f.object_key FROM resumes r JOIN candidates c ON c.id=r.candidate_id
    JOIN files f ON f.id=r.file_id WHERE r.id=$1 ${lock ? "FOR UPDATE OF r,c" : ""}`, [id]);
  if (!result.rows[0]) throw new HttpError(404, "Резюме не найдено.");
  return result.rows[0];
}
function revision(row: RecoveryRow, contacts: ReturnType<typeof contactsResponseSchema.parse>) {
  return createHash("sha256").update(JSON.stringify({ candidate_id: row.candidate_id, file_id: row.file_id,
    file_sha256: row.file_sha256, file_name: row.file_name, bucket: row.bucket, object_key: row.object_key,
    values: contactFields.map(field => row[field]), provenance: row.contact_provenance, contacts })).digest("hex");
}
async function extractContacts(row: RecoveryRow) {
  const bytes = await getFile(row.bucket, row.object_key);
  if (bytes.length !== Number(row.size_bytes) || createHash("sha256").update(bytes).digest("hex") !== row.file_sha256)
    throw new HttpError(409, "Содержимое файла изменилось. Восстановление контактов отменено.");
  // Contact evidence is received through the job API; the backend does not invoke handlers.
  const { rows } = await pool.query(`SELECT job->'result' AS result FROM processing_tasks t
    CROSS JOIN LATERAL jsonb_array_elements(t.state->'jobs') AS job
    WHERE job->>'operation'='evaluate' AND job->'result'->>'status'='completed'
      AND job->>'file_id'=$1 AND job->'receipt'->>'resume_id'=$2 AND job->>'applied'='true'
      AND EXISTS(SELECT 1 FROM jsonb_array_elements(t.state->'files') f WHERE f->>'file_id'=$1 AND f->>'sha256'=$3)
    ORDER BY t.created_at DESC, job->>'created_at' DESC LIMIT 1`, [row.file_id, row.resume_id, row.file_sha256]);
  const parsed = contactsResponseSchema.safeParse(rows[0]?.result);
  if (!parsed.success) throw new HttpError(409,
    "Для этого файла нет сохранённых источников контактов. Запустите повторную оценку резюме.");
  return parsed.data;
}
export async function previewResumeContacts(id: string): Promise<ContactRecoveryPreview> {
  const row = await readResume(id), contacts = await extractContacts(row);
  const plan = planContactUpdate(row, contacts.candidate, contacts.contact_details, row.file_id);
  return { revision: revision(row, contacts), ...contacts, changes: plan.changes, protected_fields: plan.protected_fields };
}
export async function recoverResumeContacts(id: string, expectedRevision: string) {
  const row = await readResume(id), contacts = await extractContacts(row);
  const stale = () => new HttpError(409, "Контакты или файл изменились. Снова откройте просмотр изменений.");
  if (revision(row, contacts) !== expectedRevision) throw stale();
  return transaction(async client => {
    await lockContactWrites(client);
    const current = await readResume(id, client, true);
    if (revision(current, contacts) !== expectedRevision) throw stale();
    const plan = planContactUpdate(current, contacts.candidate, contacts.contact_details, current.file_id);
    await writeContactPlan(client, current.candidate_id, plan);
    // Do not alter the scoring lease, ratings, requirements or scoring_status.
    await client.query("UPDATE resumes SET contact_extraction=$2 WHERE id=$1", [id, JSON.stringify(contacts.contact_details)]);
    if (plan.changes.length) await client.query(`INSERT INTO resume_events(id,resume_id,event_type,message,created_at)
      VALUES($1,$2,'contacts_recovered',$3,now())`, [randomUUID(), id,
      "Контакты восстановлены из текста резюме: " + plan.changes.map(c => contactLabels[c.field].toLowerCase()).join(", ") + "."]);
    return { changed_fields: plan.changes.map(c => c.field), warnings: contacts.contact_details.warnings };
  });
}
