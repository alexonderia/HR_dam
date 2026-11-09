import { randomUUID } from "node:crypto";
import { Router, type Request, type Response, type NextFunction } from "express";
import { rateLimit } from "express-rate-limit";
import { z } from "zod";
import { pool } from "@hr/data-access";
import { AccessError, keyFromEnv, cookieSettings, checkOrigin, checkPassword, readSession, signToken, cookie, sessionCookieName } from "@hr/security";

function issue(res: Response, user: { id: string; display_name: string }, sid: string) {
  const now = Math.floor(Date.now() / 1000), ttl = 900;
  const token = signToken({ iss: "hr-auth", aud: "hr-browser", sub: user.id, sid, name: user.display_name, iat: now, exp: now + ttl }, keyFromEnv("AUTH_PRIVATE_KEY"), "hr-session+jwt");
  res.setHeader("Set-Cookie", cookie(sessionCookieName, token, ttl, cookieSettings().secure));
  res.json({ mode: "authorized", user: { id: user.id, name: user.display_name }, expires_at: new Date((now + ttl) * 1000).toISOString() });
}
export async function requireSession(req: Request, res: Response, next: NextFunction) {
  try {
    checkOrigin(req.method, req.header("origin"), cookieSettings().origin);
    const claims = readSession(req.header("cookie"), keyFromEnv("AUTH_PUBLIC_KEY"));
    if (!claims) throw new AccessError(401, "Войдите в приложение.");
    const result = await pool.query(`SELECT u.id,u.display_name FROM sessions s JOIN users u ON u.id=s.user_id
      WHERE s.id=$1 AND s.user_id=$2 AND s.revoked_at IS NULL AND s.expires_at>now() AND u.is_active`, [z.uuid().parse(claims.sid), z.uuid().parse(claims.sub)]);
    if (!result.rows[0]) throw new AccessError(401, "Сессия завершена.");
    res.locals.session = claims; res.locals.user = result.rows[0]; next();
  } catch (error) {
    if (error instanceof AccessError && error.status === 401) res.setHeader("Set-Cookie", cookie(sessionCookieName, "", 0, cookieSettings().secure));
    next(error);
  }
}
export const authRouter = Router();
authRouter.post("/login", rateLimit({ windowMs: 60000, limit: 10, standardHeaders: true, legacyHeaders: false }), async (req, res) => {
  checkOrigin(req.method, req.header("origin"), cookieSettings().origin);
  const input = z.object({ login: z.string().trim().min(1).max(255), password: z.string().min(1).max(512) }).strict().parse(req.body);
  const result = await pool.query("SELECT id,display_name,password_hash FROM users WHERE login=$1 AND is_active", [input.login.toLowerCase()]);
  const user = result.rows[0];
  // Same expensive check for unknown accounts prevents cheap login enumeration.
  const fallback = `scrypt:${"0".repeat(32)}:${"0".repeat(128)}`;
  if (!checkPassword(input.password, user?.password_hash || fallback) || !user) throw new AccessError(401, "Неверный логин или пароль.");
  const sid = randomUUID();
  await pool.query("INSERT INTO sessions(id,user_id,expires_at) VALUES($1,$2,now()+interval '8 hours')", [sid, user.id]);
  issue(res, user, sid);
});
authRouter.post("/logout", requireSession, async (_req, res) => {
  await pool.query("UPDATE sessions SET revoked_at=now() WHERE id=$1", [res.locals.session.sid]);
  res.setHeader("Set-Cookie", cookie(sessionCookieName, "", 0, cookieSettings().secure)); res.json({ mode: "guest" });
});
authRouter.post("/refresh", requireSession, async (_req, res) => { issue(res, res.locals.user, res.locals.session.sid); });
