import { createPrivateKey, createPublicKey, sign, verify, randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";

export class AccessError extends Error {
  constructor(public status: number, message = "Доступ запрещён.") { super(message); }
}
export function keyFromEnv(name: string) {
  const path = process.env[`${name}_FILE`];
  const pem = path ? readFileSync(path, "utf8") : process.env[name]?.replace(/\\n/g, "\n");
  if (!pem) throw new Error(`${name}_FILE is required`);
  return pem;
}
export type Claims = Record<string, unknown> & { iss: string; aud: string; sub: string; iat: number; exp: number };
const encoded = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
export function signToken(claims: Claims, key: string, typ: string) {
  const value = `${encoded({ alg: "RS256", typ })}.${encoded(claims)}`;
  return `${value}.${sign("RSA-SHA256", Buffer.from(value), createPrivateKey(key)).toString("base64url")}`;
}
export function verifyToken(token: string, key: string, typ: string, issuer: string, audience: string, now = Date.now()): Claims {
  try {
    if (token.length > 16384) throw new Error();
    const parts = token.split(".");
    if (parts.length !== 3 || parts.some(p => !/^[A-Za-z0-9_-]+$/.test(p))) throw new Error();
    const header = JSON.parse(Buffer.from(parts[0], "base64url").toString());
    if (header.alg !== "RS256" || header.typ !== typ || Object.keys(header).some(k => !["alg", "typ"].includes(k))) throw new Error();
    if (!verify("RSA-SHA256", Buffer.from(parts.slice(0, 2).join(".")), createPublicKey(key), Buffer.from(parts[2], "base64url"))) throw new Error();
    const c = JSON.parse(Buffer.from(parts[1], "base64url").toString());
    if (c.iss !== issuer || c.aud !== audience || typeof c.sub !== "string" || !c.sub ||
      !Number.isInteger(c.exp) || !Number.isInteger(c.iat) || c.iat > now / 1000 + 5 || c.exp <= now / 1000 || c.exp <= c.iat) throw new Error();
    return c;
  } catch { throw new AccessError(401, "Сессия или токен недействительны."); }
}
export function cookieValue(header: string | undefined, name: string) {
  const values = (header || "").split(";").map(p => p.trim()).filter(p => p.startsWith(`${name}=`));
  if (values.length > 1) throw new AccessError(401);
  return values.length ? values[0].slice(name.length + 1) : undefined;
}
export function cookie(name: string, value: string, maxAge: number, secure: boolean) {
  return `${name}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${Math.max(0, Math.floor(maxAge))}${secure ? "; Secure" : ""}`;
}
export function cookieSettings() {
  const origin = new URL(process.env.APP_ORIGIN || "http://localhost:3000");
  const local = origin.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(origin.hostname);
  if (origin.protocol !== "https:" && !local) throw new Error("APP_ORIGIN must use HTTPS outside localhost");
  return { origin: origin.origin, secure: !local };
}
export function checkOrigin(method: string, origin: string | undefined, allowed: string) {
  if (!["GET", "HEAD", "OPTIONS"].includes(method) && origin !== allowed) throw new AccessError(403, "Недопустимый источник запроса.");
}
export const sessionCookieName = "hr_session";
export function readSession(header: string | undefined, key: string) {
  const token = cookieValue(header, sessionCookieName);
  if (!token) return null;
  const claims = verifyToken(token, key, "hr-session+jwt", "hr-auth", "hr-browser");
  if (typeof claims.sid !== "string" || typeof claims.name !== "string") throw new AccessError(401);
  return claims;
}
export function hashPassword(password: string) {
  const salt = randomBytes(16).toString("hex");
  return `scrypt:${salt}:${scryptSync(password, salt, 64).toString("hex")}`;
}
export function checkPassword(password: string, hash: string) {
  const [kind, salt, hex] = hash.split(":");
  if (kind !== "scrypt" || !/^[a-f0-9]{32}$/.test(salt) || !/^[a-f0-9]{128}$/.test(hex)) return false;
  return timingSafeEqual(scryptSync(password, salt, 64), Buffer.from(hex, "hex"));
}
