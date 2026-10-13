import assert from "node:assert/strict";
import { test } from "node:test";
import { strToU8, zipSync } from "fflate";
import { extractDocxText } from "@hr/documents";
import { validateFile } from "../apps/backend/src/files.js";

function document(xml: string, extra: Record<string, Uint8Array> = {}) {
  return Buffer.from(
    zipSync({
      "[Content_Types].xml": strToU8(
        '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>',
      ),
      "word/document.xml": strToU8(xml),
      ...extra,
    }),
  );
}
const xml =
  '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>Python &amp; SQL &lt;script&gt;</w:t></w:r></w:p><w:p><w:r><w:t>Second paragraph</w:t></w:r></w:p></w:body></w:document>';
test("DOCX extraction keeps paragraph order and decodes plain text", () => {
  assert.equal(
    extractDocxText(document(xml)),
    "Python & SQL <script>\nSecond paragraph\n",
  );
});
test("DOCX extraction rejects entity declarations and corrupt archives", () => {
  assert.throws(() =>
    extractDocxText(
      document('<!DOCTYPE doc [<!ENTITY bomb "xxx">]><doc>&bomb;</doc>'),
    ),
  );
  assert.throws(() => extractDocxText(Buffer.from("not a document")));
});
test("file validation rejects forged extensions, executable PDF and DOCX macros", async () => {
  await assert.rejects(validateFile(Buffer.from("not a pdf"), "resume.pdf"));
  await assert.rejects(
    validateFile(Buffer.from("%PDF-1.4\n/JavaScript (x)\n%%EOF"), "resume.pdf"),
  );
  await assert.rejects(
    validateFile(
      document(xml, { "word/vbaProject.bin": strToU8("macro") }),
      "resume.docx",
    ),
  );
  assert.equal(
    await validateFile(document(xml), "resume.docx"),
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  );
});
