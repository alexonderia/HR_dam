import { createHash, randomUUID } from "node:crypto";
import { contactsResponseSchema, contactFields, type ContactRecoveryPreview } from "@hr/contracts";
import { analysisConfig, getFile, pool, transaction } from "@hr/data-access";
import { HttpError } from "./errors.js";
import { contactLabels, planContactUpdate, type StoredContacts } from "./contact-policy.js";
import { lockContactWrites, writeContactPlan } from "./contact-persistence.js";

interface RecoveryRow extends StoredContacts {
  candidate_id: string; file_id: string; file_sha256: string; file_name: string; mime_type: string;
  size_bytes: string; bucket: string; object_key: string;
}
async function readResume(id: string, client: Pick<typeof pool, "query"> = pool, lock = false): Promise<RecoveryRow> {
  const result = await client.query(`SELECT c.last_name,c.first_name,c.middle_name,c.phone,c.contact_provenance,r.candidate_id,r.file_id,
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
  const form = new FormData();
  form.append("file", new Blob([new Uint8Array(bytes)], { type: row.mime_type }), row.file_name);
  let response: Response;
  try {
    response = await fetch(process.env.RESUME_ANALYZER_CONTACTS_URL || new URL("contacts", analysisConfig.rankUrl), {
      method: "POST", body: form, signal: AbortSignal.timeout(120_000),
    });
  } catch { throw new HttpError(503, "Извлечение контактов временно недоступно. Повторите позже."); }
  if (!response.ok) throw new HttpError(response.status === 422 ? 422 : 503,
    response.status === 422 ? "Не удалось прочитать текст резюме." : "Извлечение контактов временно недоступно.");
  const parsed = contactsResponseSchema.safeParse(await response.json().catch(() => null));
  if (!parsed.success) throw new HttpError(502, "Сервис вернул контакты без корректного источника.");
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
