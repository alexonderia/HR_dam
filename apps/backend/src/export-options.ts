import { zipSync, strToU8 } from "fflate";
import { z } from "zod";
import {
  fullName,
  statusLabels,
  scoringLabels,
  matrixColumns,
  clusterScore,
  type Candidate,
  type Cluster,
} from "@hr/contracts";
import { escapeHtml as h, htmlDocument, reportContent } from "./export.js";

export const exportOptionsSchema = z.object({
  candidate_ids: z.array(z.uuid()).max(10000),
  cluster_ids: z.array(z.uuid()).max(1000),
  expanded: z.array(z.uuid()).max(1000).default([]),
  content: z.enum(["report", "table"]).default("report"),
  format: z.enum(["html", "csv", "xlsx"]).default("html"),
  individual: z.boolean().default(false),
  print: z.boolean().default(false),
  candidateReport: z.boolean().default(false),
});
export type ExportOptions = z.infer<typeof exportOptionsSchema>;
type Cell = string | number;
type Sheet = { name: string; rows: Cell[][] };
const csv = (rows: Cell[][]) =>
  "\uFEFF" +
  rows
    .map((row) =>
      row
        .map((value) => {
          const safe =
            typeof value === "string" && /^\s*[=+@-]/.test(value)
              ? "'" + value
              : String(value);
          return '"' + safe.replace(/"/g, '""') + '"';
        })
        .join(";"),
    )
    .join("\r\n");
const table = (rows: Cell[][]) =>
  `<div class="af-table-scroll"><table class="af-table report-table"><thead><tr>${rows[0].map((v) => `<th>${h(v)}</th>`).join("")}</tr></thead><tbody>${rows
    .slice(1)
    .map((row) => `<tr>${row.map((v) => `<td>${h(v)}</td>`).join("")}</tr>`)
    .join("")}</tbody></table></div>`;

export function matrixRows(
  candidates: Candidate[],
  clusters: Cluster[],
  expanded: string[],
): Cell[][] {
  const columns = matrixColumns(clusters, expanded);
  return [
    ["Кандидат", ...columns.map((c) => c.label), "Статус"],
    ...candidates.map((c) => [
      (fullName(c) || "ФИО не указано") + "\n" + (c.phone || "Телефон не указан") + (c.blacklisted ? "\nЧёрный список" : ""),
      ...columns.map((column) =>
        column.profile
          ? (c.ratings.find((r) => r.profile_id === column.profile!.id)
              ?.score ?? "")
          : (clusterScore(c, column.cluster) ?? ""),
      ),
      c.scoring_status === "completed"
        ? statusLabels[c.status]
        : scoringLabels[c.scoring_status],
    ]),
  ];
}
export function ratingRows(
  candidates: Candidate[],
  clusters: Cluster[],
  full: boolean,
): Cell[][] {
  return [
    [
      "Кандидат",
      "Кластер",
      "Профиль",
      "Рейтинг",
      ...(full ? ["Обоснование", "Ключевые слова", "Стоп-факторы"] : []),
    ],
    ...candidates.flatMap((c) =>
      clusters.flatMap((cluster) =>
        cluster.profiles.flatMap((p) => {
          const r = c.ratings.find((r) => r.profile_id === p.id);
          return r
            ? [
                [
                  fullName(c) || "ФИО не указано",
                  cluster.name,
                  p.position_name,
                  Number(r.score),
                  ...(full
                    ? [
                        r.explanation || "",
                        r.matched_keywords?.join(", ") || "",
                        r.triggered_stop_factors?.join(", ") || "",
                      ]
                    : []),
                ],
              ]
            : [];
        }),
      ),
    ),
  ];
}
const columnName = (index: number): string =>
  index < 26
    ? String.fromCharCode(65 + index)
    : columnName(Math.floor(index / 26) - 1) +
      String.fromCharCode(65 + (index % 26));

export function xlsx(sheets: Sheet[]) {
  const files: Record<string, Uint8Array> = {};
  const put = (path: string, xml: string) => {
    files[path] = strToU8(
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' + xml,
    );
  };
  put(
    "[Content_Types].xml",
    `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>${sheets.map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join("")}</Types>`,
  );
  put(
    "_rels/.rels",
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>',
  );
  put(
    "xl/workbook.xml",
    `<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>${sheets.map((s, i) => `<sheet name="${h(s.name)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join("")}</sheets></workbook>`,
  );
  put(
    "xl/_rels/workbook.xml.rels",
    `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${sheets.map((_, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join("")}<Relationship Id="styles" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`,
  );
  put(
    "xl/styles.xml",
    '<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><fonts count="2"><font><sz val="11"/><name val="Arial"/></font><font><b/><sz val="11"/><name val="Arial"/></font></fonts><fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills><borders count="1"><border/></borders><cellStyleXfs count="1"><xf/></cellStyleXfs><cellXfs count="2"><xf fontId="0" fillId="0" borderId="0" xfId="0" applyAlignment="1"><alignment wrapText="1" vertical="top"/></xf><xf fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1" applyAlignment="1"><alignment wrapText="1" vertical="top"/></xf></cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>',
  );
  sheets.forEach((s, i) =>
    put(
      `xl/worksheets/sheet${i + 1}.xml`,
      `<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetViews><sheetView workbookViewId="0"><pane xSplit="1" ySplit="1" topLeftCell="B2" activePane="bottomRight" state="frozen"/></sheetView></sheetViews><cols>${s.rows[0].map((_, j) => `<col min="${j + 1}" max="${j + 1}" width="${j === 0 ? 38 : 28}" customWidth="1"/>`).join("")}</cols><sheetData>${s.rows
        .map(
          (row, r) =>
            `<row r="${r + 1}"${` ht="${Math.min(
              409,
              Math.max(
                24,
                ...row.map(
                  (v, c) =>
                    String(v)
                      .split("\n")
                      .reduce(
                        (n, line) =>
                          n +
                          Math.max(
                            1,
                            Math.ceil(line.length / (c === 0 ? 34 : 24)),
                          ),
                        0,
                      ) *
                      15 +
                    12,
                ),
              ),
            )}" customHeight="1"`}>${row.map((value, c) => `<c r="${columnName(c)}${r + 1}" s="${r === 0 ? 1 : 0}" ${typeof value === "number" ? `t="n"><v>${value}</v>` : `t="inlineStr"><is><t xml:space="preserve">${h(value).replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, "")}</t></is>`}</c>`).join("")}</row>`,
        )
        .join(
          "",
        )}</sheetData><autoFilter ref="A1:${columnName(s.rows[0].length - 1)}${s.rows.length}"/><pageSetup orientation="landscape" paperSize="9"/></worksheet>`,
    ),
  );
  return Buffer.from(zipSync(files));
}

export function createExport(
  candidates: Candidate[],
  clusters: Cluster[],
  options: ExportOptions,
): { body: Buffer | string; mime: string; extension: string } {
  const full = options.content === "report";
  const rows = options.candidateReport
    ? ratingRows(candidates, clusters, full)
    : matrixRows(candidates, clusters, options.expanded);
  const sheets: Sheet[] = [
    { name: options.candidateReport ? "Профили" : "Матрица", rows },
  ];
  if (full && !options.candidateReport)
    sheets.push({
      name: "Обоснования",
      rows: ratingRows(candidates, clusters, true),
    });
  if (full && options.format === "xlsx")
    sheets.push({
      name: "Кандидаты",
      rows: [
        [
          "Кандидат",
          "Телефон",
          "Статус",
          "Файл резюме",
          "Обработано (МСК)",
          "Чёрный список",
        ],
        ...candidates.map((c) => {
          const processed = c.ratings
            .map((r) => r.calculated_at)
            .sort()
            .at(-1);
          return [
            fullName(c) || "ФИО не указано",
            c.phone || "",
            statusLabels[c.status],
            c.file_name,
            processed
              ? new Date(processed).toLocaleString("ru-RU", {
                  timeZone: "Europe/Moscow",
                })
              : "Не обработано",
            c.blacklisted ? "Да" : "Нет",
          ];
        }),
      ],
    });
  if (options.format === "csv" && sheets.length > 1)
    sheets[0].rows = ratingRows(candidates, clusters, true);
  let body: Buffer | string, mime: string;
  if (options.format === "xlsx") {
    body = xlsx(sheets);
    mime = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
  } else if (options.format === "csv") {
    body = csv(sheets[0].rows);
    mime = "text/csv; charset=utf-8";
  } else {
    body = htmlDocument(
      options.candidateReport
        ? `Отчёт · ${candidates.map(fullName).join(", ")}`
        : "Распределение кандидатов",
      options.candidateReport
        ? candidates.map((c) => reportContent(c, clusters, !full)).join("")
        : table(rows) +
            (full
              ? `<h2>Обоснования оценок</h2>${table(ratingRows(candidates, clusters, true))}`
              : "") +
            (options.print && options.individual && !options.candidateReport
              ? candidates
                  .map(
                    (c) =>
                      `<section class="individual-report"><h2>${h(fullName(c))}</h2>${reportContent(c, clusters, false)}</section>`,
                  )
                  .join("")
              : ""),
      false,
    );
    mime = "text/html; charset=utf-8";
  }
  if (options.individual && !options.print && !options.candidateReport) {
    const files: Record<string, Uint8Array> = {
      [`distribution.${options.format}`]:
        typeof body === "string" ? strToU8(body) : body,
    };
    for (const candidate of candidates) {
      const report = createExport([candidate], clusters, {
        ...options,
        candidateReport: true,
        individual: false,
        content: "report",
      });
      files[`reports/${candidate.resume_id}.${report.extension}`] =
        typeof report.body === "string" ? strToU8(report.body) : report.body;
    }
    return {
      body: Buffer.from(zipSync(files)),
      mime: "application/zip",
      extension: "zip",
    };
  }
  return { body, mime, extension: options.format };
}
