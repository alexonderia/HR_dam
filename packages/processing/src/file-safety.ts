import { fileTypeFromBuffer } from "file-type";
import { unzipSync } from "fflate";
import { decodeText, extractDocumentText } from "@hr/documents";
import { AccessError as HttpError } from "@hr/security";
import { validatePdf } from "./pdf-safety.js";
const config = { maxFileSize: 50 * 1024 * 1024 };
export async function validateFile(buffer: Buffer, filename: string) {
  if (!buffer.length || buffer.length > config.maxFileSize)
    throw new HttpError(422, "Размер файла должен быть от 1 байта до 50 МБ.");
  const ext = filename.toLowerCase().split(".").pop();
  const type = ["pdf", "docx"].includes(ext || "") ? await fileTypeFromBuffer(buffer) : undefined;
  if (type?.ext === "pdf" && ext === "pdf") {
    await validatePdf(buffer);
    return "application/pdf";
  }
  if (type?.ext === "docx" && ext === "docx") {
    let expanded = 0;
    const files = unzipSync(buffer, {
      filter: (entry) => {
        expanded += entry.originalSize;
        if (expanded > 40 * 1024 * 1024)
          throw new HttpError(422, "Слишком большой распакованный документ.");
        if (/vbaProject|embeddings\//i.test(entry.name))
          throw new HttpError(422, "DOCX содержит макросы или вложения.");
        return entry.name === "word/document.xml";
      },
    });
    if (!files["word/document.xml"])
      throw new HttpError(422, "Повреждённый DOCX.");
    return "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
  }
  if (ext === "txt") {
    const text = decodeText(buffer);
    if (/[\x00-\x08\x0e-\x1f]/.test(text)) throw new HttpError(422, "TXT содержит двоичные данные.");
    return "text/plain";
  }
  if (ext === "rtf" && /^\{\\rtf\d/.test(buffer.toString("latin1"))) {
    if (/\\(object|objdata|field|bin)\b/i.test(buffer.toString("latin1")))
      throw new HttpError(422, "RTF содержит вложенные объекты или активные поля.");
    await extractDocumentText(buffer, "application/rtf");
    return "application/rtf";
  }
  if (ext === "doc" && buffer.subarray(0, 8).equals(Buffer.from("d0cf11e0a1b11ae1", "hex"))) {
    if (/VBA|Macros|ObjectPool/i.test(buffer.toString("utf16le")))
      throw new HttpError(422, "DOC содержит макросы или вложенные объекты.");
    try { await extractDocumentText(buffer, "application/msword"); }
    catch { throw new HttpError(422, "Не удалось прочитать DOC."); }
    return "application/msword";
  }
  throw new HttpError(422, "Поддерживаются PDF, DOCX, DOC, RTF и TXT. Содержимое должно соответствовать формату.");
}
