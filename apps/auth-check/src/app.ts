import express from "express";
import { AccessError, readSession, cookie, sessionCookieName } from "@hr/security";

export function createAuthCheck(publicKey: string, secure = true) {
  const app = express();
  app.disable("x-powered-by");
  app.use((_req, res, next) => { res.set("Cache-Control", "no-store"); next(); });
  app.get("/health", (_req, res) => res.json({ ok: true }));
  app.get("/verify", (req, res) => {
    try {
      const policy = req.header("x-access-policy");
      if (!["guest", "authorized"].includes(policy || "")) throw new AccessError(403);
      const session = readSession(req.header("cookie"), publicKey);
      if (policy === "guest" && session) throw new AccessError(403);
      if (policy === "authorized" && !session) throw new AccessError(401);
      res.sendStatus(204);
    } catch (error) { res.status(error instanceof AccessError ? error.status : 503).end(); }
  });
  app.get("/session", (req, res) => {
    try {
      const session = readSession(req.header("cookie"), publicKey);
      res.json(session ? { mode: "authorized", user: { id: session.sub, name: session.name }, expires_at: new Date(session.exp * 1000).toISOString() } : { mode: "guest" });
    } catch {
      res.setHeader("Set-Cookie", cookie(sessionCookieName, "", 0, secure));
      res.status(401).json({ error: "Сессия завершена.", mode: "guest" });
    }
  });
  return app;
}
