import multer from "multer";
import type { Request, Response, NextFunction } from "express";
import { mkdtemp, rm, open, readFile } from "node:fs/promises";
import { createReadStream } from "node:fs";
import { tmpdir } from "node:os";
import { join, basename } from "node:path";
import { createConnection } from "node:net";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { AccessError } from "@hr/security";
import { validateFile } from "./file-safety.js";

export interface IncomingFile { path: string; size: number; originalname: string }
export async function receiveUpload(req: Request, res: Response, field: string, count = 50): Promise<{ files: IncomingFile[]; dispose: () => Promise<void> }> {
  const directory = await mkdtemp(join(tmpdir(), "hr-upload-"));
  try {
    await new Promise<void>((resolve, reject) => {
      multer({ dest: directory, limits: { fileSize: 52428800, files: count, fields: 4, fieldSize: 65536, parts: count + 4 } })
        .array(field, count)(req, res, (error?: unknown) => error ? reject(error) : resolve());
    });
    const files = req.files as Express.Multer.File[];
    if (!files?.length || files.reduce((n, f) => n + f.size, 0) > 262144000) throw new AccessError(422, "Прикрепите файлы общим объёмом до 250 МБ.");
    return { files, dispose: () => rm(directory, { recursive: true, force: true }) };
  } catch (e) { await rm(directory, { recursive: true, force: true }); throw e; }
}
export function safeFileName(original: string) {
  const name = Buffer.from(original, "latin1").toString("utf8");
  const decoded = name.includes("�") ? original : name;
  const safe = basename(decoded.replace(/\\/g, "/")).replace(/[\x00-\x1f]/g, "").slice(0, 180);
  if (!safe) throw new AccessError(422, "Недопустимое имя файла.");
  return safe;
}
export async function inspectUpload(file: IncomingFile, allowArchive = true) {
  if (!file.size) throw new AccessError(422, "Файл пуст.");
  const name = safeFileName(file.originalname);
  const handle = await open(file.path, "r");
  const head = Buffer.alloc(Math.min(file.size, 8192));
  try { await handle.read(head, 0, head.length, 0); } finally { await handle.close(); }
  const extension = name.toLowerCase().split(".").pop();
  const zip = head.subarray(0, 4).equals(Buffer.from("504b0304", "hex"));
  let mime: string;
  if (extension === "pdf" && head.subarray(0, 5).toString() === "%PDF-") mime = "application/pdf";
  else if (extension === "zip" && zip && allowArchive) mime = "application/zip";
  else if (extension === "docx" && zip) mime = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
  else if (extension === "doc" && head.subarray(0, 8).toString("hex") === "d0cf11e0a1b11ae1") mime = "application/msword";
  else if (extension === "rtf" && /^\{\\rtf\d/.test(head.toString("latin1"))) mime = "application/rtf";
  else if (extension === "txt") mime = "text/plain";
  else throw new AccessError(422, "Содержимое не соответствует формату PDF, ZIP, DOCX, DOC, RTF или TXT.");
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(file.path)) {
    if (extension === "txt" && /[\x00-\x08\x0e-\x1f]/.test(chunk.toString("latin1"))) throw new AccessError(422, "TXT содержит двоичные данные.");
    hash.update(chunk);
  }
  // Structural safety validation uses one bounded document buffer after the
  // streaming upload. Archive expansion remains the prepare service's work.
  if (extension !== "zip") mime = await validateFile(await readFile(file.path), name);
  await scanPath(file.path);
  return { file_name: name, mime_type: mime, size_bytes: file.size, sha256: hash.digest("hex") };
}
export async function scanPath(path: string) {
  const socket = createConnection({ host: process.env.CLAMAV_HOST || "127.0.0.1", port: Number(process.env.CLAMAV_PORT || 3310) });
  let response = "";
  const verdict = new Promise<void>((resolve, reject) => {
    const fail = () => { socket.destroy(); reject(new AccessError(503, "Антивирус недоступен.")); };
    socket.setTimeout(60000, fail); socket.on("error", fail);
    socket.on("end", () => { if (!response.includes("\0")) fail(); });
    socket.on("data", data => {
      response += data.toString();
      if (response.length > 4096) return fail();
      if (!response.includes("\0")) return;
      socket.end();
      if (response.includes("FOUND")) reject(new AccessError(422, "Файл содержит вредоносные данные."));
      else if (/stream: OK\0/.test(response)) resolve(); else fail();
    });
  });
  // Register the rejection handler before streaming, including connect failures.
  void verdict.catch(() => {});
  try {
    await Promise.race([once(socket, "connect"), verdict]);
    socket.write("zINSTREAM\0");
    for await (const value of createReadStream(path, { highWaterMark: 65536 })) {
      const data = Buffer.from(value), size = Buffer.alloc(4); size.writeUInt32BE(data.length);
      if (!socket.write(Buffer.concat([size, data]))) await Promise.race([once(socket, "drain"), verdict]);
    }
    socket.write(Buffer.alloc(4));
    await verdict;
  } finally { socket.destroy(); }
}
export function apiErrors(error: unknown, _req: Request, res: Response, _next: NextFunction) {
  const status = error instanceof AccessError ? error.status : error instanceof multer.MulterError ? 422 :
    (error as { name?: string })?.name === "ZodError" ? 422 : 503;
  res.status(status).json({ error: error instanceof AccessError ? error.message : status === 422 ? "Проверьте поля и размер файлов." : "Сервис временно недоступен." });
}
