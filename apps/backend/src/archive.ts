import { unzipSync } from "fflate";
import { config } from "./config.js";
import { HttpError } from "./errors.js";

const crcTable = Uint32Array.from({ length: 256 }, (_, value) => {
  for (let bit = 0; bit < 8; bit++) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  return value >>> 0;
});
const crc32 = (buffer: Buffer) => {
  let value = 0xffffffff;
  for (const byte of buffer) value = crcTable[(value ^ byte) & 255] ^ (value >>> 8);
  return (value ^ 0xffffffff) >>> 0;
};

export const safeFileName = (value: string) => value.replace(/[\r\n\x00-\x1f/\\]/g, "_").slice(-180);
export function multipartFileName(value: string) {
  const decoded = Buffer.from(value, "latin1").toString("utf8");
  return safeFileName(decoded.includes("\uFFFD") ? value : decoded);
}

// Inspect the central directory before allocating any decompression buffers.
// No archive paths are ever written to the local filesystem.
export function extractResumeArchive(buffer: Buffer) {
  const invalid = () => new HttpError(422, "Повреждённый ZIP или неподдерживаемый формат архива.");
  if (!buffer.length || buffer.length > config.maxArchiveSize)
    throw new HttpError(422, "ZIP должен быть размером от 1 байта до 50 МБ.");
  let end = buffer.length - 22;
  for (; end >= Math.max(0, buffer.length - 65557); end--)
    if (buffer.readUInt32LE(end) === 0x06054b50 && end + 22 + buffer.readUInt16LE(end + 20) === buffer.length) break;
  if (end < Math.max(0, buffer.length - 65557)) throw invalid();
  const count = buffer.readUInt16LE(end + 10), offset = buffer.readUInt32LE(end + 16);
  if (buffer.readUInt16LE(end + 4) || buffer.readUInt16LE(end + 6) ||
      count !== buffer.readUInt16LE(end + 8) || count === 65535 ||
      offset + buffer.readUInt32LE(end + 12) !== end || count > 2000) throw invalid();
  let cursor = offset, expanded = 0;
  const entries: { size: number; compressed: number; crc: number }[] = [];
  for (let i = 0; i < count; i++) {
    if (cursor + 46 > end || buffer.readUInt32LE(cursor) !== 0x02014b50) throw invalid();
    const flags = buffer.readUInt16LE(cursor + 8), method = buffer.readUInt16LE(cursor + 10);
    if (flags & 1) throw new HttpError(422, "ZIP с паролем не поддерживается.");
    if (![0, 8].includes(method)) throw invalid();
    if (((buffer.readUInt32LE(cursor + 38) >>> 16) & 0xf000) === 0xa000)
      throw new HttpError(422, "ZIP не должен содержать символические ссылки.");
    const size = buffer.readUInt32LE(cursor + 24), compressed = buffer.readUInt32LE(cursor + 20);
    entries.push({ size, compressed, crc: buffer.readUInt32LE(cursor + 16) });
    expanded += size;
    if (size > config.maxFileSize || expanded > config.maxExpandedArchiveSize)
      throw new HttpError(422, "В ZIP превышен лимит: 50 МБ на файл или 250 МБ после распаковки.");
    const local = buffer.readUInt32LE(cursor + 42);
    if (local + 30 > offset || buffer.readUInt32LE(local) !== 0x04034b50 || buffer.readUInt16LE(local + 6) & 1)
      throw invalid();
    if (buffer.readUInt16LE(local + 8) !== method ||
        local + 30 + buffer.readUInt16LE(local + 26) + buffer.readUInt16LE(local + 28) + compressed > offset ||
        (method === 0 && compressed !== size)) throw invalid();
    cursor += 46 + buffer.readUInt16LE(cursor + 28) + buffer.readUInt16LE(cursor + 30) + buffer.readUInt16LE(cursor + 32);
  }
  if (cursor !== end) throw invalid();
  const ignored: string[] = [], selected = new Map<string, { size: number; crc: number }>(), paths = new Set<string>();
  let seen = 0;
  try {
    // Exclude the ZIP comment so embedded signatures cannot redirect the library's EOCD scan.
    const contents = unzipSync(buffer.subarray(0, end + 22), { filter: entry => {
      seen++;
      const expected = entries[seen - 1];
      if (!expected || entry.originalSize !== expected.size || entry.size !== expected.compressed) throw invalid();
      const path = entry.name.replace(/\\/g, "/");
      if (!path || path.startsWith("/") || /^[a-z]:/i.test(path) || /[\x00-\x1f]/.test(path) ||
          path.split("/").some(part => part === ".." || part === "."))
        throw new HttpError(422, "ZIP содержит недопустимый путь к файлу.");
      if (paths.has(path)) throw new HttpError(422, "ZIP содержит повторяющиеся пути к файлам.");
      paths.add(path);
      if (path.endsWith("/")) return false;
      if (path.split("/").some(part => part.startsWith(".")) || path.startsWith("__MACOSX/") ||
          !/\.(pdf|docx|doc|rtf|txt)$/i.test(path)) { ignored.push(path); return false; }
      selected.set(entry.name, entries[seen - 1]);
      if (selected.size > config.maxImportFiles)
        throw new HttpError(422, `В одном ZIP допускается до ${config.maxImportFiles} резюме.`);
      return true;
    }});
    if (seen !== count || !selected.size) throw new HttpError(422, "В ZIP не найдены резюме PDF, DOCX, DOC, RTF или TXT.");
    const files = [...selected].map(([path, expected]) => {
      const content = Buffer.from(contents[path]);
      if (content.length !== expected.size || crc32(content) !== expected.crc) throw invalid();
      return { sourcePath: path, filename: safeFileName(path.replace(/\\/g, "/").split("/").pop()!), buffer: content };
    });
    if (files.some(file => !file.buffer.length)) throw new HttpError(422, "ZIP содержит пустое резюме.");
    return { files, ignored };
  } catch (error) {
    if (error instanceof HttpError) throw error;
    throw invalid();
  }
}
