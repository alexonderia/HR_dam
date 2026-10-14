import { unzipSync } from "fflate";
import { XMLParser, XMLValidator } from "fast-xml-parser";
import WordExtractor from "word-extractor";
import rtfParser from "rtf-parser";

export function decodeText(buffer: Buffer) {
  if (buffer.subarray(0, 2).equals(Buffer.from([0xff, 0xfe]))) return buffer.subarray(2).toString("utf16le");
  if (buffer.subarray(0, 2).equals(Buffer.from([0xfe, 0xff]))) return new TextDecoder("utf-16be").decode(buffer.subarray(2));
  try { return new TextDecoder("utf-8", { fatal: true }).decode(buffer); }
  catch { return new TextDecoder("windows-1251").decode(buffer); }
}

export async function extractDocumentText(buffer: Buffer, mime: string) {
  if (mime === "application/msword") return (await new WordExtractor().extract(buffer)).getBody();
  if (mime === "text/plain") return decodeText(buffer);
  if (mime === "application/rtf") {
    return new Promise<string>((resolve, reject) => {
      rtfParser.string(buffer.toString("latin1"), (error, document) => {
        if (error) { reject(error); return; }
        const read = (node: { value?: string; content?: typeof document[] }): string =>
          node.value ?? (node.content || []).map(read).join("");
        resolve((document.content || []).map(read).join("\n"));
      });
    });
  }
  return extractDocxText(buffer);
}

export function extractDocxText(buffer: Buffer) {
  let expanded = 0;
  const files = unzipSync(buffer, {
    filter: (entry) => {
      expanded += entry.originalSize;
      if (expanded > 40 * 1024 * 1024)
        throw new Error("Слишком большой распакованный DOCX.");
      return entry.name === "word/document.xml";
    },
  });
  if (!files["word/document.xml"])
    throw new Error("В DOCX отсутствует документ.");
  const xml = new TextDecoder().decode(files["word/document.xml"]);
  if (/<!DOCTYPE|<!ENTITY/i.test(xml) || XMLValidator.validate(xml) !== true)
    throw new Error("Некорректный XML в DOCX.");
  const tree = new XMLParser({
    preserveOrder: true,
    ignoreAttributes: true,
    removeNSPrefix: true,
    trimValues: false,
    parseTagValue: false,
  }).parse(xml) as Record<string, unknown>[];
  let text = "";
  const walk = (nodes: Record<string, unknown>[]) => {
    for (const node of nodes)
      for (const [tag, value] of Object.entries(node)) {
        if (tag === "#text") text += String(value);
        else if (tag === "tab") text += "\t";
        else if (tag === "br") text += "\n";
        else if (Array.isArray(value)) {
          walk(value as Record<string, unknown>[]);
          if (tag === "p") text += "\n";
        }
      }
  };
  walk(tree);
  return text;
}
