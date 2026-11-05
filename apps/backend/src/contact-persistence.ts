import { identityKey, type ExtractedPerson } from "@hr/contracts";
import { pool } from "@hr/data-access";
import { HttpError } from "./errors.js";
import { type planContactUpdate } from "./contact-policy.js";

type Client = Pick<typeof pool, "query">;
export async function lockContactWrites(client: Client) {
  // All contact writers acquire this before identity/row locks. Recovery and
  // scoring therefore cannot deadlock by taking those locks in reverse order.
  await client.query("SELECT pg_advisory_xact_lock(hashtextextended('candidate-contacts-write',0))");
}
export async function checkContactIdentity(client: Client, candidateId: string, person: ExtractedPerson) {
  const nameComplete = Boolean(person.last_name && person.first_name);
  const conflict = await client.query(`SELECT id FROM candidates WHERE id<>$1 AND (phone=$2 OR ($3::boolean AND
    lower(replace(last_name,'ё','е'))=$4 AND lower(replace(first_name,'ё','е'))=$5 AND
    lower(replace(coalesce(middle_name,''),'ё','е'))=$6)) LIMIT 1`,
    [candidateId, person.phone, nameComplete, identityKey(person.last_name || ""), identityKey(person.first_name || ""), identityKey(person.middle_name || "")]);
  if (conflict.rowCount) throw new HttpError(409, "Контакты совпадают с другим кандидатом. Требуется ручная проверка.");
}
export async function writeContactPlan(client: Client, candidateId: string, plan: ReturnType<typeof planContactUpdate>) {
  if (plan.valuesChanged) await checkContactIdentity(client, candidateId, plan.values);
  const p = plan.values, provenance = JSON.stringify(plan.provenance);
  await client.query(`UPDATE candidates SET phone=$2,last_name=$3,first_name=$4,middle_name=$5,contact_provenance=$6,updated_at=now()
    WHERE id=$1 AND (phone,last_name,first_name,middle_name,contact_provenance) IS DISTINCT FROM ($2,$3,$4,$5,$6::jsonb)`,
    [candidateId, p.phone, p.last_name, p.first_name, p.middle_name, provenance]);
}
