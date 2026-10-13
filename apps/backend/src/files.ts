import { createConnection } from "node:net";
import { createHash } from "node:crypto";
import { fileTypeFromBuffer } from "file-type";
import { unzipSync } from "fflate";
import { config } from "./config.js";
import { HttpError } from "./errors.js";

export async function scanFile(buffer: Buffer) {
  await new Promise<void>((resolve, reject) => {
    const socket = createConnection({
      host: config.clamHost,
      port: config.clamPort,
    });
    let result = "";
    const fail = (message: string) => {
      socket.destroy();
      reject(new HttpError(503, message));
    };
    socket.setTimeout(60000, () =>
      fail("Антивирус не ответил. Файл не сохранён."),
    );
    socket.on("error", () => fail("Антивирус недоступен. Попробуйте позже."));
    socket.on("connect", () => {
      socket.write("zINSTREAM\0");
      for (let i = 0; i < buffer.length; i += 65536) {
        const chunk = buffer.subarray(i, i + 65536),
          size = Buffer.alloc(4);
        size.writeUInt32BE(chunk.length);
        socket.write(size);
        socket.write(chunk);
      }
      socket.write(Buffer.alloc(4));
    });
    socket.on("data", (data) => {
      result += data.toString();
      if (!result.includes("\0")) return;
      socket.destroy();
      if (result.includes("FOUND"))
        reject(new HttpError(422, "В файле обнаружены вредоносные данные."));
      else if (/stream: OK\0/.test(result)) resolve();
      else reject(new HttpError(503, "Антивирус не смог проверить файл."));
    });
    socket.on("end", () => {
      if (!result.includes("\0")) fail("Антивирус прервал проверку.");
    });
  });
}
export async function validateFile(buffer: Buffer, filename: string) {
  if (!buffer.length || buffer.length > config.maxFileSize)
    throw new HttpError(422, "Размер файла должен быть от 1 байта до 10 МБ.");
  const type = await fileTypeFromBuffer(buffer);
  const ext = filename.toLowerCase().split(".").pop();
  if (type?.ext === "pdf" && ext === "pdf") {
    if (
      /\/(JavaScript|JS|Launch|EmbeddedFile|RichMedia)\b/.test(
        buffer.toString("latin1"),
      )
    )
      throw new HttpError(
        422,
        "PDF содержит активное или вложенное содержимое.",
      );
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
  throw new HttpError(422, "Разрешены только настоящие PDF и DOCX.");
}
export const hashFile = (buffer: Buffer) =>
  createHash("sha256").update(buffer).digest("hex");
