import { unzipSync } from "fflate";
import { XMLParser, XMLValidator } from "fast-xml-parser";

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
