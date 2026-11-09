import express from "express";
import helmet from "helmet";
import { rateLimit } from "express-rate-limit";
import { z } from "zod";
import { cookie, cookieValue, checkOrigin, readSession, signToken, verifyToken, AccessError } from "@hr/security";
import { internalRouter, apiErrors, receiveUpload, mutateTask, finish } from "@hr/processing";
import { randomUUID } from "node:crypto";
import { GuestService, digest, guestReport } from "./service.js";

export function createGuestApp(service: GuestService, settings: { authPublicKey: string; cookiePrivateKey: string; cookiePublicKey: string; origin: string; secure: boolean; ready: () => boolean }) {
  const app = express(); app.disable("x-powered-by"); app.use(helmet());
  app.use((_req, res, next) => { res.set("Cache-Control", "no-store"); next(); });
  app.get("/health", (_req, res) => res.status(settings.ready() ? 200 : 503).json({ ok: settings.ready(), atomic_storage: settings.ready() }));
  app.use(express.json({ limit: "256kb" }));
  app.use((req, _res, next) => { if (!settings.ready()) throw new AccessError(503, "Гостевое хранилище ещё не готово."); next(); });
  app.use("/internal/guest", internalRouter(service.engine, "/internal/guest"));
  app.use("/api/guest", (req, res, next) => {
    checkOrigin(req.method, req.header("origin"), settings.origin);
    if (readSession(req.header("cookie"), settings.authPublicKey)) throw new AccessError(403);
    const existing = cookieValue(req.header("cookie"), "hr_guest");
    const now = Math.floor(Date.now() / 1000);
    let claims;
    if (existing) claims = verifyToken(existing, settings.cookiePublicKey, "hr-guest-session+jwt", "hr-guest", "hr-guest-browser");
    const id = claims?.sub || randomUUID();
    if (!claims || claims.exp - now < 86400) res.setHeader("Set-Cookie", cookie("hr_guest", signToken({ iss: "hr-guest", aud: "hr-guest-browser", sub: id,
      iat: now, exp: now + 172800 }, settings.cookiePrivateKey, "hr-guest-session+jwt"), 172800, settings.secure));
    res.locals.owner = digest(id); next();
  });
  app.use("/api/guest/queue", rateLimit({ windowMs: 60000, limit: 60, standardHeaders: true, legacyHeaders: false }));
  app.post("/api/guest/queue", async (req, res) => {
    const input = z.object({ file_count: z.number().int().min(1).max(50), size_bytes: z.number().int().min(1).max(262144000) }).strict().parse(req.body);
    res.status(201).json(await service.admission.enqueue(res.locals.owner, input.file_count, input.size_bytes));
  });
  app.get("/api/guest/queue/:id", async (req, res) => res.json(await service.admission.status(z.uuid().parse(req.params.id), res.locals.owner)));
  app.post("/api/guest/tasks", async (req, res) => {
    const permit = req.header("x-upload-permit") || "";
    const initial = await service.begin(res.locals.owner, req.header("idempotency-key") || "", req.header("x-submission-digest") || "", permit);
    const limits = await service.admission.start(permit, res.locals.owner, initial.task.id, initial.duplicate);
    let upload: Awaited<ReturnType<typeof receiveUpload>> | undefined;
    try {
      upload = await receiveUpload(req, res, "files");
      if (!initial.duplicate) {
        if (upload.files.length !== limits.files || upload.files.reduce((n, f) => n + f.size, 0) !== limits.bytes) throw new AccessError(422, "Состав загрузки не соответствует допуску.");
      }
      const task = await service.upload(initial.task, upload.files, req.body, initial.fingerprint, initial.duplicate);
      res.status(202).json(guestReport(task));
    } catch (error) {
      if (!initial.duplicate) await mutateTask(service.store, initial.task.id, task => { task.status = "failed"; finish(task, Date.now()); }).catch(() => {});
      throw error;
    } finally { await upload?.dispose(); await service.admission.release(permit, res.locals.owner); }
  });
  for (const route of ["/api/guest/tasks/:id", "/api/guest/tasks/:id/report", "/api/guest/tasks/:id/download"]) app.get(route, async (req, res) => {
    const report = guestReport(await service.read(z.uuid().parse(req.params.id), res.locals.owner));
    if (route.endsWith("download")) res.attachment("resume-report.json");
    res.json(report);
  });
  app.delete("/api/guest/tasks/:id", async (req, res) => { await service.delete(z.uuid().parse(req.params.id), res.locals.owner); res.status(202).json({ deleted: true }); });
  app.use((_req, res) => res.status(404).json({ error: "Маршрут не найден." })); app.use(apiErrors); return app;
}
