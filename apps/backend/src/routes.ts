import { Router } from "express";
import multer from "multer";
import { randomUUID } from "node:crypto";
import { timingSafeEqual } from "node:crypto";
import { z } from "zod";
import {
  clusterSchema,
  profileSchema,
  blacklistSchema,
  canChangeStatus,
  statusLabels,
  inProcessRestriction,
  identityKey,
  fullName,
  importResultSchema,
  importEventSchema,
} from "@hr/contracts";
import { pool, transaction } from "@hr/data-access";
import { blacklistMatchSql, otherInProcessResumeSql } from "@hr/data-access";
import { config } from "./config.js";
import { HttpError } from "./errors.js";
import { submitCandidate } from "./submission.js";
import { getCandidates, getClusters } from "@hr/data-access";
import { getFile } from "@hr/data-access";
import { exportCsv, reportHtml, escapeHtml, htmlDocument } from "./export.js";
import { extractDocumentText } from "@hr/documents";
import { createExport, exportOptionsSchema } from "./export-options.js";
import { presentResumeEvent, queueStatus } from "./processing.js";
import { acceptResumes, listImports, importDetail, retryImport, enqueueExistingResume } from "./imports.js";
import { getBrokerStatus, readImportLedger, fileDownloadUrl, publishQueue, queues, storedFileExists } from "@hr/data-access";
import { brokerEnabled, rankBridgeEnabled, processingMode, getAnalysisStatus } from "@hr/data-access";

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
  if (!brokerEnabled) { res.json(await getAnalysisStatus()); return; }
  try {
    const broker = await getBrokerStatus();
    if (rankBridgeEnabled && broker.analysis_consumers > 0) { res.json(await getAnalysisStatus()); return; }
    res.json({ available: broker.analysis_consumers > 0, message: broker.analysis_consumers > 0
      ? "Обработчик резюме подключён."
      : "Обработчик резюме пока не подключён. Загруженные файлы будут ожидать обработки в очереди." });
  } catch { res.json({ available: false, message: "Очередь временно недоступна. Принятые задания сохраняются." }); }
});
router.get("/processing/mode", (_req, res) => res.json({ mode: processingMode, broker_enabled: brokerEnabled, rank_bridge_enabled: rankBridgeEnabled }));
router.get("/processing/queue", async (_req, res) => res.json(await getBrokerStatus()));
const archiveUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: config.maxArchiveSize, files: 1, fields: 0 } });
router.post("/resume-imports", archiveUpload.single("archive"), async (req, res) => res.status(202).json(await acceptResumes(req.file, true)));
router.get("/resume-imports", async (_req, res) => res.json(await listImports()));
router.get("/resume-imports/:id", async (req, res) => res.json(await importDetail(z.uuid().parse(req.params.id))));
router.post("/resume-imports/:id/items/:item/retry", async (req, res) =>
  res.status(202).json(await retryImport(z.uuid().parse(req.params.id), z.uuid().parse(req.params.item))));
router.use("/internal", (req, _res, next) => {
  const expected = Buffer.from(`Bearer ${config.analyzerToken}`), actual = Buffer.from(req.header("authorization") || "");
  if (!config.analyzerToken || expected.length !== actual.length || !timingSafeEqual(expected, actual))
    throw new HttpError(401, "Требуется авторизация обработчика.");
  next();
});
router.post("/internal/resume-imports/:id/items/:item/download-url", async (req, res) => {
  const { manifest } = await readImportLedger(z.uuid().parse(req.params.id));
  const file = manifest.items.find(i => i.id === z.uuid().parse(req.params.item));
  if (!file) throw new HttpError(404, "Файл не найден.");
  if (!await storedFileExists(file.bucket, file.object_key)) throw new HttpError(409, "Файл ещё сохраняется.");
  res.json(await fileDownloadUrl(file.bucket, file.object_key));
});
router.post("/internal/resume-results", async (req, res) => {
  const result = importResultSchema.parse(req.body);
  await publishQueue(queues.results, result, result.job_id);
  res.status(202).json({ accepted: true });
});
router.post("/internal/resume-progress", async (req, res) => {
  const event = importEventSchema.parse(req.body);
  if (event.stage !== "processing") throw new HttpError(422, "Допустим только статус processing.");
  await publishQueue(queues.progress, event, `${event.job_id}:processing`);
  res.status(202).json({ accepted: true });
});
router.get("/overview", async (_req, res) => {
  const [clusters, candidates, blacklist] = await Promise.all([
    getClusters(),
    getCandidates(),
    pool.query(
      "SELECT * FROM candidate_blacklist ORDER BY last_name,first_name",
    ),
  ]);
  let resumeImports, resumeImportsError;
  try { resumeImports = await listImports(); }
  catch { resumeImportsError = "Не удалось получить состояние очереди. Принятые задания сохраняются; информация обновится автоматически."; }
  res.json({ clusters, candidates, blacklist: blacklist.rows, resumeImports: resumeImports || [], resumeImportsError });
});
router.post("/candidates", upload.single("resume"), async (req, res) => {
  const result = await submitCandidate(req.body, req.file);
  res.status(202).json(result);
});
router.get("/resumes/:id/events", async (req, res) => {
  const id = z.uuid().parse(req.params.id);
  const result = await pool.query(
    "SELECT * FROM resume_events WHERE resume_id=$1 ORDER BY created_at DESC,id DESC",
    [id],
  );
  res.json(result.rows.map(presentResumeEvent));
});
router.get("/resumes/:id/processing", async (req, res) => {
  const id = z.uuid().parse(req.params.id);
  const result = await pool.query(
    `SELECT r.scoring_status,r.updated_at,
      (SELECT count(*)::int FROM profiles p JOIN clusters c ON c.id=p.cluster_id WHERE p.is_active AND c.is_active) AS active_profiles
     FROM resumes r WHERE r.id=$1`, [id],
  );
  const row = result.rows[0];
  if (!row) throw new HttpError(404, "Резюме не найдено.");
  if (row.scoring_status !== "pending") { res.json({ queue: null }); return; }
  const broker = await getBrokerStatus();
  const analysis = rankBridgeEnabled ? await getAnalysisStatus() : { available: broker.analysis_consumers > 0 };
  const analysisQueue = broker.queues[queues.analysis];
  const worker = analysis.available ? { state: "idle" as const, current_resume_id: null } : null;
  res.json({ queue: queueStatus({ queuedAt: new Date(row.updated_at).toISOString(), activeProfiles: row.active_profiles,
    analysisAvailable: analysis.available, worker, ahead: Math.max(0, (analysisQueue?.ready || 0) - 1), processing: analysisQueue?.processing || 0 }) });
});
router.post("/resumes/:id/retry", async (req, res) => {
  const id = z.uuid().parse(req.params.id);
  res.status(202).json(await enqueueExistingResume(id));
});
router.patch("/resumes/:id/status", async (req, res) => {
  const id = z.uuid().parse(req.params.id),
    { status, outcome } = z
      .object({ status: z.enum(["in_work", "in_process", "historical"]), outcome: z.enum(["employed", "rejected_all"]).optional() })
      .parse(req.body);
  await transaction(async (client) => {
    const identity = await client.query(
      "SELECT c.* FROM candidates c JOIN resumes r ON r.candidate_id=c.id WHERE r.id=$1",
      [id],
    );
    const person = identity.rows[0];
    if (!person) throw new HttpError(404, "Резюме не найдено.");
    // Match submission's lock order and serialize transitions for the same identity.
    for (const key of [`name:${identityKey(fullName(person))}`, `phone:${person.phone}`].sort())
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [key]);
    await client.query("SELECT id FROM candidates WHERE id=$1 FOR UPDATE", [person.id]);
    const result = await client.query(
      `SELECT r.status,r.scoring_status,
        EXISTS(SELECT 1 FROM candidate_blacklist b WHERE b.is_active AND ${blacklistMatchSql}) AS blacklisted,
        ${otherInProcessResumeSql} AS has_other_resume_in_process
       FROM resumes r JOIN candidates c ON c.id=r.candidate_id WHERE r.id=$1 FOR UPDATE OF r`,
      [id],
    );
    const current = result.rows[0];
    if (!current) throw new HttpError(404, "Резюме не найдено.");
    const restriction = status === "in_process" ? inProcessRestriction(current) : null;
    if (restriction) throw new HttpError(409, restriction);
    if (!canChangeStatus(current, status))
      throw new HttpError(
        409,
        "Недопустимый переход статуса. Дождитесь оценки.",
      );
    if (status === "historical" && !outcome) throw new HttpError(422, "Укажите итог: трудоустроен или отклонён всеми кластерами.");
    await client.query(
      "UPDATE resumes SET status=$2,updated_at=now() WHERE id=$1",
      [id, status],
    );
    await client.query(
      `INSERT INTO resume_events (id,resume_id,event_type,message,created_at) VALUES ($1,$2,'status_changed',$3,now())`,
      [randomUUID(), id, `Статус изменён: ${statusLabels[status]}${outcome ? (outcome === "employed" ? ". Кандидат трудоустроен." : ". Кандидат отклонён всеми кластерами.") : ""}`],
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
    const text = await extractDocumentText(buffer, file.mime_type);
    // Plain text rendering avoids executing document HTML and external relationships.
    res.set(
      "Content-Security-Policy",
      "default-src 'none'; style-src 'self' 'unsafe-inline'; font-src data:; script-src 'unsafe-inline'",
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
      `${mode}; filename="resume.${String(file.file_name).split(".").pop()?.replace(/[^a-z0-9]/gi, "") || "txt"}"; filename*=UTF-8''${encodeURIComponent(file.file_name)}`,
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
    "default-src 'none'; style-src 'self' 'unsafe-inline'; font-src data:; script-src 'unsafe-inline'; form-action 'self'",
  );
  if (req.query.download === "true" && req.query.format && req.query.format !== "html") {
    const options = exportOptionsSchema.parse({ candidate_ids: [candidate.id], cluster_ids: clusters.map(c => c.id), candidateReport: true, format: req.query.format, content: req.query.content || "report" });
    const result = createExport([candidate], clusters, options);
    res.attachment(`report-${id}.${result.extension}`).type(result.mime).send(result.body);
    return;
  }
  if (req.query.download === "true") res.attachment(`report-${id}.html`);
  res
    .type("html")
    .send(reportHtml(candidate, clusters, req.query.print === "true", req.query.content === "table", req.query.print !== "true" && req.query.download !== "true"));
});
router.post("/export", async (req, res) => {
  const options = exportOptionsSchema.parse(req.body);
  if (options.print && options.format !== "html") throw new HttpError(422, "Для печати выберите HTML.");
  const [allCandidates, allClusters] = await Promise.all([getCandidates(), getClusters()]);
  const candidates = options.candidate_ids.flatMap(id => allCandidates.filter(c => c.id === id));
  const clusters = options.cluster_ids.flatMap(id => allClusters.filter(c => c.id === id));
  const result = createExport(candidates, clusters, options);
  res.set("Cache-Control", "no-store");
  res.set("Content-Security-Policy", "default-src 'none'; style-src 'self' 'unsafe-inline'; font-src data:; script-src 'unsafe-inline'");
  if (!options.print) res.attachment(`candidate-${options.candidateReport ? "report" : "distribution"}.${result.extension}`);
  res.type(result.mime).send(result.body);
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
