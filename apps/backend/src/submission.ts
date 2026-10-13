import { randomUUID } from "node:crypto";
import { personSchema, identityKey, fullName } from "@hr/contracts";
import { transaction, putFile, deleteFile } from "@hr/data-access";
import { config } from "./config.js";
import { HttpError } from "./errors.js";
import {
  validateFile,
  scanFile,
  hashFile,
} from "./files.js";

export async function submitCandidate(
  body: Record<string, unknown>,
  file: Express.Multer.File | undefined,
) {
  const person = personSchema.parse(body);
  if (!file) throw new HttpError(422, "Прикрепите резюме.");
  const utf8Name = Buffer.from(file.originalname, "latin1").toString("utf8");
  const originalName = utf8Name.includes("\uFFFD")
    ? file.originalname
    : utf8Name;
  const filename = originalName
    .replace(/[\r\n\x00-\x1f/\\]/g, "_")
    .slice(0, 180);
  const mime = await validateFile(file.buffer, filename);
  await scanFile(file.buffer);
  let uploadedKey: string | undefined;
  try {
    return await transaction(async (client) => {
      // Both identity keys are locked in a fixed order, including when no row exists yet.
      const lockKeys = [
        `name:${identityKey(fullName(person))}`,
        `phone:${person.phone}`,
      ].sort();
      for (const key of lockKeys)
        await client.query(
          "SELECT pg_advisory_xact_lock(hashtextextended($1,0))",
          [key],
        );
      const existing = await client.query(
        `SELECT c.*, r.id AS resume_id, r.file_id, r.status, r.scoring_status
        FROM candidates c LEFT JOIN resumes r ON r.candidate_id=c.id WHERE c.phone=$1 OR (
          lower(replace(c.last_name,'ё','е'))=$2 AND lower(replace(c.first_name,'ё','е'))=$3 AND
          lower(replace(coalesce(c.middle_name,''),'ё','е'))=$4) FOR UPDATE OF c`,
        [
          person.phone,
          identityKey(person.last_name),
          identityKey(person.first_name),
          identityKey(person.middle_name),
        ],
      );
      const same = existing.rows.find(
        (c) =>
          c.phone === person.phone &&
          identityKey(fullName(c)) === identityKey(fullName(person)),
      );
      if (existing.rows.length && (!same || existing.rows.length > 1))
        throw new HttpError(
          409,
          "Найден кандидат с таким телефоном или ФИО, но другими данными. Требуется проверка сотрудником.",
        );
      if (same?.resume_id) {
        const locked = await client.query(
          "SELECT status,scoring_status FROM resumes WHERE id=$1 FOR UPDATE",
          [same.resume_id],
        );
        Object.assign(same, locked.rows[0]);
        if (same.status === "in_process") {
          // Return an error marker to commit the rejection event before responding.
          await client.query(
            `INSERT INTO resume_events (id,resume_id,event_type,message,created_at) VALUES ($1,$2,'replacement_rejected',$3,now())`,
            [
              randomUUID(),
              same.resume_id,
              "Замена запрещена: кандидат в работе",
            ],
          );
          return { rejected: true as const };
        }
        if (body.allow_replace !== "true")
          throw new HttpError(
            409,
            "Кандидат уже существует. Для обновления подтвердите замену резюме.",
          );
      }
      const candidateId = same?.id || randomUUID(),
        resumeId = same?.resume_id || randomUUID(),
        fileId = randomUUID();
      uploadedKey = `resumes/${candidateId}/${fileId}/${filename}`;
      await putFile(uploadedKey, file.buffer, mime);
      if (!same)
        await client.query(
          `INSERT INTO candidates (id,phone,last_name,first_name,middle_name,created_at,updated_at) VALUES ($1,$2,$3,$4,$5,now(),now())`,
          [
            candidateId,
            person.phone,
            person.last_name,
            person.first_name,
            person.middle_name || null,
          ],
        );
      await client.query(
        `INSERT INTO files (id,bucket,object_key,file_name,mime_type,size_bytes,file_sha256,created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,now())`,
        [
          fileId,
          config.bucket,
          uploadedKey,
          filename,
          mime,
          file.buffer.length,
          hashFile(file.buffer),
        ],
      );
      if (same?.resume_id) {
        await client.query(
          `UPDATE resumes SET file_id=$2,status='in_work',scoring_status='pending',updated_at=now() WHERE id=$1`,
          [resumeId, fileId],
        );
        await client.query("DELETE FROM profile_ratings WHERE resume_id=$1", [
          resumeId,
        ]);
        await client.query(
          "UPDATE candidates SET updated_at=now() WHERE id=$1",
          [candidateId],
        );
      } else
        await client.query(
          `INSERT INTO resumes (id,candidate_id,file_id,status,scoring_status,created_at,updated_at) VALUES ($1,$2,$3,'in_work','pending',now(),now())`,
          [resumeId, candidateId, fileId],
        );
      const blacklist = await client.query(
        `SELECT id,company_name FROM candidate_blacklist WHERE is_active AND (phone=$1 OR (
        lower(replace(last_name,'ё','е'))=$2 AND lower(replace(first_name,'ё','е'))=$3 AND lower(replace(coalesce(middle_name,''),'ё','е'))=$4))`,
        [
          person.phone,
          identityKey(person.last_name),
          identityKey(person.first_name),
          identityKey(person.middle_name),
        ],
      );
      const warning = blacklist.rows.length
        ? "Совпадение с чёрным списком по телефону или ФИО. Нужна ручная проверка."
        : null;
      await client.query(
        `INSERT INTO resume_events (id,resume_id,event_type,message,created_at) VALUES ($1,$2,$3,$4,now())`,
        [
          randomUUID(),
          resumeId,
          same?.resume_id ? "replaced" : "uploaded",
          `Файл проверен антивирусом, сохранён в S3. ${warning || "Совпадений с чёрным списком нет."}`,
        ],
      );
      return {
        rejected: false as const,
        candidate_id: candidateId,
        resume_id: resumeId,
        warning,
      };
    });
  } catch (error) {
    if (uploadedKey)
      await deleteFile(uploadedKey).catch(() =>
        console.error(
          "S3 cleanup failed for uncommitted upload; reconciliation required",
        ),
      );
    throw error;
  }
}
