import { Router } from "express";
import { createReadStream } from "node:fs";
import { pipeline } from "node:stream/promises";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { outputMetadataSchema } from "@hr/contracts";
import { AccessError } from "@hr/security";
import { inspectUpload, receiveUpload } from "./uploads.js";
import type { ProcessingEngine } from "./engine.js";
import type { StoredFile } from "./types.js";

export function internalRouter(engine: ProcessingEngine, base: string): Router {
  const router = Router();
  router.use("/jobs/:jobId", async (req, res, next) => {
    const permission = req.path === "/input" ? "input:read" : req.path.startsWith("/files/") ? "file:read" :
      req.path.startsWith("/output/") ? "output:write" : req.path === "/progress" ? "progress:write" : "result:write";
    res.locals.job = await engine.authorize(req.header("authorization"), z.uuid().parse(req.params.jobId), permission); next();
  });
  router.get("/jobs/:jobId/input", (_req, res) => {
    const { task, job } = res.locals.job; res.json(engine.input(task, job, base));
  });
  router.get("/jobs/:jobId/files/:fileId", async (req, res) => {
    const { task, job } = res.locals.job;
    if (z.uuid().parse(req.params.fileId) !== job.file_id) throw new AccessError(403);
    const file = task.files.find((f: StoredFile) => f.file_id === job.file_id)!;
    res.type(file.mime_type).set("Content-Length", String(file.size_bytes)).set("X-Content-SHA256", file.sha256);
    await pipeline(await engine.blobs.get(file.key), res);
  });
  router.put("/jobs/:jobId/output/:fileKey", async (req, res) => {
    const { task, job, claims } = res.locals.job;
    const outputKey = z.string().regex(/^[a-zA-Z0-9_-]{1,80}$/).parse(req.params.fileKey);
    const upload = await receiveUpload(req, res, "file", 1);
    let uploaded: string | undefined;
    try {
      const metadata = outputMetadataSchema.parse(JSON.parse(req.body.metadata));
      if (metadata.source_file_id !== job.file_id) throw new AccessError(403);
      const incoming = await inspectUpload(upload.files[0], false);
      if (metadata.file_name !== incoming.file_name || metadata.mime_type !== incoming.mime_type) throw new AccessError(422, "Метаданные не соответствуют файлу.");
      const old = task.files.find((f: StoredFile) => f.source_file_id === job.file_id && f.output_key === outputKey);
      if (old && (old.sha256 !== incoming.sha256 || JSON.stringify(old.metadata) !== JSON.stringify(metadata))) throw new AccessError(409);
      const fileId = old?.file_id || randomUUID();
      // Unique object keys prevent a losing concurrent upload overwriting a registered file.
      const key = `tasks/${task.id}/files/${randomUUID()}`;
      if (!old) { await engine.blobs.put(key, createReadStream(upload.files[0].path), incoming.size_bytes, incoming.mime_type); uploaded = key; }
      const file = await engine.registerOutput(claims, { ...incoming, file_id: fileId, key: old?.key || key,
        source_file_id: job.file_id, metadata, output_key: outputKey });
      if (uploaded && uploaded !== file.key) await engine.blobs.remove(uploaded);
      uploaded = undefined;
      res.json({ file_id: file.file_id, size_bytes: file.size_bytes, sha256: file.sha256 });
    } finally { if (uploaded) await engine.blobs.remove(uploaded); await upload.dispose(); }
  });
  router.post("/jobs/:jobId/progress", async (req, res) => {
    const input = z.object({ job_id: z.uuid(), attempt: z.number().int().positive(), status: z.literal("processing") }).strict().parse(req.body);
    await engine.progress(res.locals.job.claims, input); res.json({ accepted: true });
  });
  router.post("/jobs/:jobId/result", async (req, res) => { await engine.result(res.locals.job.claims, req.body); res.json({ accepted: true }); });
  return router;
}
