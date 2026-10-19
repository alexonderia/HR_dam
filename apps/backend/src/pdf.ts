import { PDFArray, PDFDict, PDFDocument, PDFName, PDFObject, PDFStream } from "@cantoo/pdf-lib";
import { HttpError } from "./errors.js";

const blockedKeys = new Set([
  "EmbeddedFiles", "EF", "RichMediaContent", "RichMediaSettings",
]);
const blockedActions = new Set(["JavaScript", "Launch"]);
const blockedSubtypes = new Set(["RichMedia", "FileAttachment"]);

function nameOf(value: PDFObject | undefined) {
  if (!(value instanceof PDFName)) return undefined;
  return value.decodeText();
}

export async function validatePdf(buffer: Buffer) {
  try {
    const document = await PDFDocument.load(buffer, {
      ignoreEncryption: false,
      throwOnInvalidObject: true,
      updateMetadata: false,
    });
    if (!(document.catalog instanceof PDFDict)) throw new Error("Missing PDF catalog");

    // Object streams are decoded by the parser. Font, image and page stream bytes
    // are data, not PDF dictionaries, and must never be searched for action names.
    const pending = document.context.enumerateIndirectObjects().map(([, object]) => object);
    const visited = new Set<PDFObject>();
    while (pending.length) {
      const object = pending.pop()!;
      if (visited.has(object)) continue;
      visited.add(object);
      if (object instanceof PDFStream) {
        pending.push(object.dict);
      } else if (object instanceof PDFArray) {
        for (const value of object.asArray()) pending.push(value);
      } else if (object instanceof PDFDict) {
        for (const [key, value] of object.entries()) {
          const name = nameOf(key)!;
          const resolved = document.context.lookup(value);
          const valueName = nameOf(resolved);
          if (blockedKeys.has(name) ||
              (name === "S" && blockedActions.has(valueName || "")) ||
              (name === "Type" && valueName === "EmbeddedFile") ||
              (name === "Subtype" && blockedSubtypes.has(valueName || ""))) {
            throw new HttpError(422, "PDF содержит активное или вложенное содержимое.");
          }
          if (resolved) pending.push(resolved);
        }
      }
    }
  } catch (error) {
    if (error instanceof HttpError) throw error;
    throw new HttpError(422, "Не удалось проверить PDF: файл повреждён или защищён паролем.");
  }
}
