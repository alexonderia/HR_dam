import assert from "node:assert/strict";
import { test } from "node:test";
import { deflateSync } from "node:zlib";
import { PDFDocument, PDFHexString, PDFName, PDFString } from "@cantoo/pdf-lib";
import { validateFile } from "../apps/backend/src/files.js";

const activeContent = { status: 422, message: "PDF содержит активное или вложенное содержимое." };

async function pdf(
  configure: (document: PDFDocument) => void | Promise<void> = () => {},
  useObjectStreams = false,
) {
  const document = await PDFDocument.create();
  document.addPage();
  await configure(document);
  return Buffer.from(await document.save({ useObjectStreams }));
}

test("PDF validation ignores active-content tokens in compressed font data", async () => {
  const data = Buffer.from("font data /JS' /JavaScript /Launch /EmbeddedFile /RichMedia");
  const encoded = deflateSync(data, { level: 0 });
  assert.ok(encoded.includes(Buffer.from("/JS'")));
  const buffer = await pdf(document => {
    const fontFile = document.context.register(document.context.stream(encoded, {
      Filter: "FlateDecode", Length1: data.length,
    }));
    document.context.register(document.context.obj({ Type: "FontDescriptor", FontFile2: fontFile }));
  });
  assert.equal(await validateFile(buffer, "resume.pdf"), "application/pdf");
});

test("PDF validation permits tokens in text, comments, metadata and ordinary resource names", async () => {
  const text = "/JS /JavaScript /Launch /EmbeddedFile /RichMedia";
  const buffer = await pdf(document => {
    document.setTitle(text);
    document.context.register(PDFString.of(text));
    document.context.register(PDFHexString.fromText(text));
    document.getPages()[0].drawText(text);
    document.getPages()[0].node.set(PDFName.of("Resources"), document.context.obj({
      Font: { JS: { Type: "Font", Subtype: "Type1", BaseFont: "Helvetica" } },
    }));
    // Ordinary hyperlinks and cyclic page/parent references remain allowed.
    document.getPages()[0].node.set(PDFName.of("Annots"), document.context.obj([
      { Type: "Annot", Subtype: "Link", A: { S: "URI", URI: PDFString.of("https://example.com") } },
    ]));
  });
  assert.equal(await validateFile(Buffer.concat([buffer, Buffer.from(`\n% ${text}\n`)]), "resume.pdf"), "application/pdf");
});

for (const compressed of [false, true]) {
  test(`PDF validation rejects JavaScript in ${compressed ? "compressed" : "plain"} objects`, async () => {
    const buffer = await pdf(document => document.addJavaScript("startup", "app.alert('test')"), compressed);
    if (compressed) {
      assert.ok(buffer.includes(Buffer.from("/ObjStm")));
      assert.doesNotMatch(buffer.toString("latin1"), /\/S\s+\/JavaScript\b/);
    }
    await assert.rejects(validateFile(buffer, "resume.pdf"), activeContent);
  });

  test(`PDF validation rejects attachments in ${compressed ? "compressed" : "plain"} objects`, async () => {
    const buffer = await pdf(document => document.attach(Buffer.from("notes"), "notes.txt"), compressed);
    await assert.rejects(validateFile(buffer, "resume.pdf"), activeContent);
  });
}

test("PDF validation resolves indirect action names and nested additional actions", async () => {
  const buffer = await pdf(document => {
    const action = document.context.register(document.context.obj({
      S: document.context.register(PDFName.of("JavaScript")),
      JS: document.context.register(document.context.stream("app.alert('test')")),
    }));
    document.getPages()[0].node.set(PDFName.of("AA"), document.context.obj({ O: action }));
  }, true);
  await assert.rejects(validateFile(buffer, "resume.pdf"), activeContent);
});

test("PDF validation recognizes escaped dictionary keys and action names", async () => {
  for (const subtype of ["JavaScript", "Launch"]) {
    const buffer = await pdf(document => {
      document.catalog.set(PDFName.of("OpenAction"), document.context.register(document.context.obj({
        S: PDFName.of(subtype),
      })));
    });
    // Edit the serialized PDF to exercise the parser, including lower-case hex.
    const escaped = Buffer.from(buffer.toString("latin1")
      .replace("/S /" + subtype, "/#53 /" + (subtype === "Launch" ? "#4caunch" : "#4aavaScript")), "latin1");
    await assert.rejects(validateFile(escaped, "resume.pdf"), activeContent);
  }
});

test("PDF validation inspects object streams with escaped type names", async () => {
  const buffer = await pdf(document => document.addJavaScript("startup", "app.alert('test')"), true);
  const escaped = Buffer.from(buffer.toString("latin1").replace("/ObjStm", "/#4fbjStm"), "latin1");
  await assert.rejects(validateFile(escaped, "resume.pdf"), activeContent);
});

test("PDF validation rejects launch actions, attachment annotations and rich media", async () => {
  const dictionaries = [
    { S: "Launch", F: PDFString.of("program.exe") },
    { Type: "Annot", Subtype: "FileAttachment" },
    { Type: "Annot", Subtype: "RichMedia" },
    { Type: "EmbeddedFile" },
    { Type: "Filespec", EF: {} },
  ];
  for (const dictionary of dictionaries) {
    const buffer = await pdf(document => {
      document.getPages()[0].node.set(PDFName.of("Annots"), document.context.obj([dictionary]));
    });
    await assert.rejects(validateFile(buffer, "resume.pdf"), activeContent);
  }
});

test("PDF validation fails closed for malformed or encrypted documents", async () => {
  for (const buffer of [
    Buffer.from("%PDF-1.7\n%%EOF"),
    Buffer.from("%PDF-1.7\n1 0 obj << /Type /Catalog /Broken ??? >>\nendobj\n%%EOF"),
    await pdf(document => document.encrypt({ userPassword: "test-password", ownerPassword: "test-owner" })),
  ]) {
    await assert.rejects(validateFile(buffer, "resume.pdf"), {
      status: 422, message: /файл повреждён или защищён паролем/,
    });
  }
});
