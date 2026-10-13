import express from "express";
import multer from "multer";
import { extractDocxText } from "@hr/documents";
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";
import { z } from "zod";
import { clusterSchema, profileSchema } from "@hr/contracts";
import { baselineScore } from "./scoring.js";
import { config } from "./config.js";

const app = express();
const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: config.maxFileSize,
    fieldSize: 1024 * 1024,
    fields: 1,
    files: 1,
  },
});
const requirementsSchema = z.object({
  clusters: z.array(
    clusterSchema.extend({
      id: z.uuid(),
      profiles: z.array(
        profileSchema.omit({ cluster_id: true }).extend({ id: z.uuid() }),
      ),
    }),
  ),
});
app.get("/health", (_req, res) =>
  res.json({ ok: true, method: "keyword-baseline-v1" }),
);
app.post("/rank", upload.single("file"), async (req, res) => {
  if (!req.file) {
    res.status(422).json({ error: "File required" });
    return;
  }
  const requirements = requirementsSchema.parse(
    JSON.parse(req.body.requirements),
  );
  let text: string;
  if (req.file.buffer.subarray(0, 5).toString() === "%PDF-") {
    const task = getDocument({
      data: new Uint8Array(req.file.buffer),
      useSystemFonts: true,
      disableFontFace: true,
    });
    try {
      const pdf = await task.promise;
      if (pdf.numPages > 100)
        throw new Error("Документ содержит более 100 страниц");
      const parts: string[] = [];
      for (let i = 1; i <= pdf.numPages; i++) {
        const page = await pdf.getPage(i),
          content = await page.getTextContent();
        parts.push(
          content.items
            .map((item) => ("str" in item ? item.str : ""))
            .join(" "),
        );
      }
      text = parts.join("\n");
    } finally {
      await task.destroy();
    }
  } else text = extractDocxText(req.file.buffer);
  if (text.trim().length < 20)
    throw new Error(
      "Текст не извлечён. Для сканированного PDF необходим обработчик с OCR.",
    );
  res.json({
    clusters: requirements.clusters.map((c) => ({
      id: c.id,
      name: c.name,
      profiles: c.profiles.map((p) =>
        baselineScore(text, { ...p, cluster_id: c.id }),
      ),
    })),
  });
});
app.use(
  (
    error: Error,
    _req: express.Request,
    res: express.Response,
    _next: express.NextFunction,
  ) => res.status(422).json({ error: error.message }),
);
app.listen(config.port, "0.0.0.0", () => console.log("Keyword baseline ranker :3002"));
