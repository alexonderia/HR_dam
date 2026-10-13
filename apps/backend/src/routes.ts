import { Router } from "express";
import multer from "multer";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import {
  clusterSchema,
  profileSchema,
  blacklistSchema,
} from "@hr/contracts";
import { pool, transaction, getAnalysisStatus } from "@hr/data-access";
import { config } from "./config.js";
import { HttpError } from "./errors.js";
import { submitCandidate } from "./submission.js";
import { getCandidates, getClusters } from "@hr/data-access";
import { getFile } from "@hr/data-access";
import { exportCsv, reportHtml, escapeHtml, htmlDocument } from "./export.js";
import { extractDocxText } from "@hr/documents";
import { presentResumeEvent, probeWorker, queueStatus } from "./processing.js";

export const router = Router();
const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: config.maxFileSize,
    files: 1,
    fields: 6,
    fieldSize: 1000,
  },
});
router.get("/health", async (_req, res) => {
  await pool.query("SELECT 1");
  res.json({ ok: true });
});
router.get("/analysis/status", async (_req, res) => {
  res.json(await getAnalysisStatus());
});
async function requireAnalysis() {
  const status = await getAnalysisStatus(true);
  if (!status.available) throw new HttpError(503, status.message);
  const clusters = await getClusters();
  if (!clusters.some(c => c.is_active && c.profiles.some(p => p.is_active)))
    throw new HttpError(409, "Добавьте активный кластер с активным профилем перед анализом.");
}
router.get("/overview", async (_req, res) => {
  const [clusters, candidates, blacklist] = await Promise.all([
    getClusters(),
    getCandidates(),
    pool.query(
      "SELECT * FROM candidate_blacklist ORDER BY last_name,first_name",
    ),
  ]);
  res.json({ clusters, candidates, blacklist: blacklist.rows });
});
router.post("/candidates", upload.single("resume"), async (req, res) => {
  const result = await submitCandidate(req.body, req.file);
  if (result.rejected)
    throw new HttpError(409, "Кандидат уже в работе. Замена резюме запрещена.");
  res.status(201).json(result);
});
router.get("/resumes/:id/events", async (req, res) => {
  const id = z.uuid().parse(req.params.id);
  const result = await pool.query(
    "SELECT * FROM resume_events WHERE resume_id=$1 ORDER BY created_at,id",
    [id],
  );
  res.json(result.rows.map(presentResumeEvent));
});
router.get("/resumes/:id/processing", async (req, res) => {
  const id = z.uuid().parse(req.params.id);
  const result = await pool.query(
    `SELECT r.scoring_status,r.updated_at,
      (SELECT count(*)::int FROM profiles p JOIN clusters c ON c.id=p.cluster_id WHERE p.is_active AND c.is_active) AS active_profiles,
      (SELECT count(*)::int FROM resumes q WHERE q.scoring_status='pending' AND (q.updated_at,q.id)<(r.updated_at,r.id)) AS ahead,
      (SELECT count(*)::int FROM resumes q WHERE q.scoring_status='processing') AS processing
     FROM resumes r WHERE r.id=$1`, [id],
  );
  const row = result.rows[0];
  if (!row) throw new HttpError(404, "Резюме не найдено.");
  if (row.scoring_status !== "pending") { res.json({ queue: null }); return; }
  const analysis = await getAnalysisStatus();
  const worker = analysis.available && row.active_profiles ? await probeWorker(config.workerHealthUrl) : null;
  res.json({ queue: queueStatus({ queuedAt: new Date(row.updated_at).toISOString(), activeProfiles: row.active_profiles,
    analysisAvailable: analysis.available, worker, ahead: row.ahead, processing: row.processing }) });
});
router.post("/resumes/:id/retry", async (req, res) => {
  const id = z.uuid().parse(req.params.id);
  await requireAnalysis();
  const result = await pool.query(
    `UPDATE resumes SET scoring_status='pending',updated_at=now() WHERE id=$1 AND scoring_status IN ('failed','completed') RETURNING id`,
    [id],
  );
  if (!result.rowCount)
    throw new HttpError(
      409,
      "Повторная оценка доступна после завершения или ошибки.",
    );
  res.json({ ok: true });
});
router.patch("/resumes/:id/status", async (req, res) => {
  const id = z.uuid().parse(req.params.id),
    { status } = z
      .object({ status: z.enum(["in_process", "historical"]) })
      .parse(req.body);
  await transaction(async (client) => {
    const result = await client.query(
      "SELECT status,scoring_status FROM resumes WHERE id=$1 FOR UPDATE",
      [id],
    );
    const current = result.rows[0];
    if (!current) throw new HttpError(404, "Резюме не найдено.");
    if (!(
      (current.status === "in_work" &&
        status === "in_process" &&
        current.scoring_status === "completed") ||
      (current.status === "in_process" && status === "historical")
    ))
      throw new HttpError(
        409,
        "Недопустимый переход статуса. Дождитесь оценки.",
      );
    await client.query(
      "UPDATE resumes SET status=$2,updated_at=now() WHERE id=$1",
      [id, status],
    );
    await client.query(
      `INSERT INTO resume_events (id,resume_id,event_type,message,created_at) VALUES ($1,$2,'status_changed',$3,now())`,
      [randomUUID(), id, `Статус изменён на ${status}`],
    );
  });
  res.json({ ok: true });
});
for (const [resource, schema, table] of [
  ["clusters", clusterSchema, "clusters"],
  ["profiles", profileSchema, "profiles"],
  ["blacklist", blacklistSchema, "candidate_blacklist"],
] as const) {
  router.post(`/${resource}`, async (req, res) => {
    const values = schema.parse(req.body),
      keys = Object.keys(values),
      id = randomUUID();
    const result = await pool.query(
      `INSERT INTO ${table} (id,${keys.join(",")}) VALUES ($1,${keys.map((_, i) => "$" + (i + 2)).join(",")}) RETURNING *`,
      [id, ...Object.values(values)],
    );
    res.status(201).json(result.rows[0]);
  });
  router.put(`/${resource}/:id`, async (req, res) => {
    const id = z.uuid().parse(req.params.id),
      values = schema.parse(req.body),
      keys = Object.keys(values);
    const result = await pool.query(
      `UPDATE ${table} SET ${keys.map((key, i) => `${key}=$${i + 2}`).join(",")} WHERE id=$1 RETURNING *`,
      [id, ...Object.values(values)],
    );
    if (!result.rowCount) throw new HttpError(404, "Запись не найдена.");
    res.json(result.rows[0]);
  });
}
router.get("/files/:id", async (req, res) => {
  const id = z.uuid().parse(req.params.id);
  const result = await pool.query("SELECT * FROM files WHERE id=$1", [id]);
  const file = result.rows[0];
  if (!file) throw new HttpError(404, "Файл не найден.");
  const buffer = await getFile(file.bucket, file.object_key);
  res.set("Cache-Control", "no-store");
  if (req.query.preview === "true" && file.mime_type !== "application/pdf") {
    const text = extractDocxText(buffer);
    // Plain text rendering avoids executing document HTML and external relationships.
    res.set(
      "Content-Security-Policy",
      "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'",
    );
    res
      .type("html")
      .send(
        htmlDocument(
          file.file_name,
          `<pre>${escapeHtml(text)}</pre>`,
          req.query.print === "true",
        ),
      );
  } else {
    const mode = req.query.download === "true" ? "attachment" : "inline";
    res.set(
      "Content-Disposition",
      `${mode}; filename="resume.${file.mime_type === "application/pdf" ? "pdf" : "docx"}"; filename*=UTF-8''${encodeURIComponent(file.file_name)}`,
    );
    res.type(file.mime_type).send(buffer);
  }
});
router.get("/resumes/:id/report", async (req, res) => {
  const id = z.uuid().parse(req.params.id);
  const [candidates, clusters] = await Promise.all([
    getCandidates(),
    getClusters(),
  ]);
  const candidate = candidates.find((c) => c.resume_id === id);
  if (!candidate) throw new HttpError(404, "Резюме не найдено.");
  res.set(
    "Content-Security-Policy",
    "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'",
  );
  if (req.query.download === "true") res.attachment(`report-${id}.html`);
  res
    .type("html")
    .send(reportHtml(candidate, clusters, req.query.print === "true"));
});
router.get("/export", async (_req, res) => {
  const [candidates, clusters] = await Promise.all([
    getCandidates(),
    getClusters(),
  ]);
  res
    .attachment("candidate-distribution.csv")
    .type("text/csv")
    .send(exportCsv(candidates, clusters));
});
