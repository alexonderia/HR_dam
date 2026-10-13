import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { setTimeout as delay } from "node:timers/promises";
import { pool, transaction, getAnalysisStatus } from "@hr/data-access";
import { getClusters } from "@hr/data-access";
import { getFile } from "@hr/data-access";
import { config } from "./config.js";
import { validateRankResponse } from "@hr/contracts";
import type { WorkerStatus } from "@hr/contracts";

let status: WorkerStatus = { state: "idle", current_resume_id: null };
const healthServer = createServer((req, res) => {
  if (req.url !== "/health" || req.method !== "GET") { res.writeHead(404); res.end(); return; }
  res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" });
  res.end(JSON.stringify(status));
}).listen(config.healthPort, "0.0.0.0");

let stopping = false;
for (const signal of ["SIGINT", "SIGTERM"])
  process.on(signal, () => {
    stopping = true;
    healthServer.close();
  });
async function processNext() {
  // Leave queued jobs intact while the service/model is offline.
  if (!(await getAnalysisStatus()).available) {
    status = { state: "waiting_analysis", current_resume_id: null };
    return false;
  }
  const clusters = (await getClusters())
    .filter((c) => c.is_active)
    .map((c) => ({ ...c, profiles: c.profiles.filter((p) => p.is_active) }))
    .filter((c) => c.profiles.length);
  // Accept uploads independently of requirements; claim only runnable jobs.
  if (!clusters.length) {
    status = { state: "waiting_requirements", current_resume_id: null };
    return false;
  }
  const job = await transaction(async (client) => {
    // A crashed worker leaves a lease that expires, without resetting other live workers.
    await client.query(
      `UPDATE resumes SET scoring_status='pending',updated_at=now() WHERE scoring_status='processing' AND updated_at < now()-($1 * interval '1 millisecond')`,
      [config.timeoutMs + 60000],
    );
    const result = await client.query(
      `SELECT r.*,f.bucket,f.object_key,f.file_name,f.mime_type FROM resumes r JOIN files f ON f.id=r.file_id WHERE r.scoring_status='pending' ORDER BY r.updated_at,r.id FOR UPDATE OF r SKIP LOCKED LIMIT 1`,
    );
    if (!result.rowCount) return null;
    const row = result.rows[0];
    const claimed = await client.query(
      `UPDATE resumes SET scoring_status='processing',updated_at=now() WHERE id=$1 RETURNING updated_at::text AS lease`,
      [row.id],
    );
    return { ...row, lease: claimed.rows[0].lease };
  });
  if (!job) { status = { state: "idle", current_resume_id: null }; return false; }
  status = { state: "processing", current_resume_id: job.id };
  try {
    const buffer = await getFile(job.bucket, job.object_key);
    const form = new FormData();
    form.append(
      "file",
      new Blob([new Uint8Array(buffer)], { type: job.mime_type }),
      job.file_name,
    );
    form.append("requirements", JSON.stringify({ clusters }));
    const response = await fetch(config.rankUrl, {
      method: "POST",
      body: form,
      signal: AbortSignal.timeout(config.timeoutMs),
    });
    if (!response.ok) {
      const body = (await response.json().catch(() => ({}))) as {
        error?: string;
        detail?: string;
      };
      throw new Error(
        (body.error || body.detail)?.slice(0, 500) ||
          `Обработчик вернул HTTP ${response.status}`,
      );
    }
    const result = validateRankResponse(await response.json(), clusters);
    await transaction(async (client) => {
      const current = await client.query(
        "SELECT file_id,scoring_status,updated_at::text AS lease FROM resumes WHERE id=$1 FOR UPDATE",
        [job.id],
      );
      const row = current.rows[0];
      if (
        !row ||
        row.file_id !== job.file_id ||
        row.scoring_status !== "processing" ||
        row.lease !== job.lease
      )
        return;
      await client.query("DELETE FROM profile_ratings WHERE resume_id=$1", [
        job.id,
      ]);
      for (const cluster of result.clusters)
        for (const rating of cluster.profiles) {
          await client.query(
            `INSERT INTO profile_ratings (id,resume_id,profile_id,score,matched_keywords,triggered_stop_factors,details,explanation,calculated_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,now())`,
            [
              randomUUID(),
              job.id,
              rating.id,
              rating.score,
              JSON.stringify(rating.matched_keywords ?? null),
              JSON.stringify(rating.triggered_stop_factors ?? null),
              JSON.stringify(rating.details ?? null),
              rating.explanation ?? null,
            ],
          );
        }
      await client.query(
        `UPDATE resumes SET scoring_status='completed',updated_at=now() WHERE id=$1`,
        [job.id],
      );
      await client.query(
        `INSERT INTO resume_events (id,resume_id,event_type,message,created_at) VALUES ($1,$2,'scored',$3,now())`,
        [
          randomUUID(),
          job.id,
          "Оценка завершена. Результат доступен в карточке кандидата.",
        ],
      );
    });
  } catch (error) {
    await transaction(async (client) => {
      const updated = await client.query(
        `UPDATE resumes SET scoring_status='failed',updated_at=now() WHERE id=$1 AND file_id=$2 AND scoring_status='processing' AND updated_at=$3 RETURNING id`,
        [job.id, job.file_id, job.lease],
      );
      if (updated.rowCount)
        await client.query(
          `INSERT INTO resume_events (id,resume_id,event_type,message,created_at) VALUES ($1,$2,'scoring_failed',$3,now())`,
          [
            randomUUID(),
            job.id,
            error instanceof Error
              ? error.message.slice(0, 1000)
              : "Ошибка оценки",
          ],
        );
    });
  }
  status = { state: "idle", current_resume_id: null };
  return true;
}
while (!stopping) {
  try {
    if (!(await processNext())) await delay(1500);
  } catch {
    status = { state: "error", current_resume_id: null };
    console.error("Worker infrastructure unavailable; retrying");
    await delay(5000);
  }
}
await pool.end();
