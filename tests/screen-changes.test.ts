import assert from "node:assert/strict";
import { test } from "node:test";
import { unzipSync, strFromU8 } from "fflate";
import {
  canChangeStatus,
  inProcessRestriction,
  personSchema,
  type Candidate,
  type Cluster,
} from "@hr/contracts";
import {
  createExport,
  exportOptionsSchema,
  matrixRows,
} from "../apps/backend/src/export-options.js";
import { reportHtml } from "../apps/backend/src/export.js";
import { presentResumeEvent } from "../apps/backend/src/processing.js";
import {
  phoneCountries,
  nationalPhone,
  formatNationalPhone,
} from "../apps/frontend/src/lib/phone.js";
import { extractDocumentText } from "@hr/documents";
import { validateFile } from "../apps/backend/src/files.js";

const cluster: Cluster = {
  id: "5cabfa83-676b-4084-9ec8-212658478b6b",
  name: "ИТ",
  track: "it",
  comment: "",
  is_active: true,
  profiles: [
    {
      id: "d5ebfa74-a6f9-44aa-9b93-43ce2d62fbfb",
      cluster_id: "5cabfa83-676b-4084-9ec8-212658478b6b",
      position_name: "Разработчик с длинным названием профиля",
      is_active: true,
      education: "",
      experience: "",
      keywords: [],
      stop_factors: [],
      comment: "",
    },
    {
      id: "a4ebfa74-a6f9-44aa-9b93-43ce2d62fbfb",
      cluster_id: "5cabfa83-676b-4084-9ec8-212658478b6b",
      position_name: "Аналитик",
      is_active: false,
      education: "",
      experience: "",
      keywords: [],
      stop_factors: [],
      comment: "",
    },
  ],
};
const candidate: Candidate = {
  id: "b4ebfa74-a6f9-44aa-9b93-43ce2d62fbfb",
  resume_id: "c4ebfa74-a6f9-44aa-9b93-43ce2d62fbfb",
  last_name: "Иванов",
  first_name: "Иван",
  middle_name: "",
  phone: "+79991234567",
  status: "in_work",
  scoring_status: "completed",
  file_id: "",
  file_name: "resume.txt",
  mime_type: "text/plain",
  created_at: "2026-10-14T08:00:00Z",
  updated_at: "2026-10-14T08:00:00Z",
  blacklisted: false,
  other_resumes_count: 0,
  has_other_resume_in_process: false,
  ratings: cluster.profiles.map((p, i) => ({
    profile_id: p.id,
    score: 80 - i * 30,
    calculated_at: "2026-10-14T08:00:00Z",
    explanation: "<script>bad</script>\nОпыт соответствует",
    matched_keywords: ["SQL"],
    triggered_stop_factors: [],
  })),
};
const options = exportOptionsSchema.parse({
  candidate_ids: [candidate.id],
  cluster_ids: [cluster.id],
  expanded: [cluster.id],
  content: "table",
  format: "xlsx",
});

test("matrix export preserves one header row, adjacent cluster/profile columns and numeric scores", () => {
  assert.deepEqual(matrixRows([candidate], [cluster], []), [
    ["Кандидат", "ИТ", "Статус"],
    ["Иванов Иван\n+79991234567", 80, "В работе"],
  ]);
  const result = createExport([candidate], [cluster], options);
  const files = unzipSync(result.body as Buffer);
  const xml = strFromU8(files["xl/worksheets/sheet1.xml"]);
  assert.match(xml, /xSplit="1" ySplit="1"/);
  assert.match(xml, /ИТ \/ Разработчик/);
  assert.match(xml, /<c r="B2" s="0" t="n"><v>80<\/v>/);
  assert.equal((xml.match(/<row r="1"/g) || []).length, 1);
  assert.doesNotMatch(xml, /<f>/);
  assert.equal(
    Object.keys(files).filter((p) => /worksheets\/sheet/.test(p)).length,
    1,
  );
});
test("full Excel export adds evidence and candidate metadata; attachments contain separate complete reports", () => {
  const result = createExport([candidate], [cluster], {
    ...options,
    content: "report",
    individual: true,
  });
  assert.equal(result.extension, "zip");
  const archive = unzipSync(result.body as Buffer);
  const matrix = unzipSync(archive["distribution.xlsx"]);
  assert.match(strFromU8(matrix["xl/workbook.xml"]), /Обоснования/);
  const individual = unzipSync(archive[`reports/${candidate.resume_id}.xlsx`]);
  assert.match(
    strFromU8(individual["xl/worksheets/sheet1.xml"]),
    /&lt;script&gt;/,
  );
  assert.match(
    strFromU8(individual["xl/worksheets/sheet2.xml"]),
    /Обработано \(МСК\)/,
  );
});
test("report provides export settings, unique cluster anchors and one processing date", () => {
  const html = reportHtml(candidate, [cluster], false, false, true);
  assert.match(html, /name="format"/);
  assert.match(html, /name="content"/);
  assert.equal(html.split(`id="cluster-${cluster.id}"`).length - 1, 1);
  assert.equal(html.split("Обработано:").length - 1, 1);
  assert.match(html, /Обоснование/);
  assert.doesNotMatch(html, /<script>bad/);
  assert.doesNotMatch(
    reportHtml(candidate, [cluster], false, true),
    /Опыт соответствует/,
  );
});
test("phone input formats Russian digits, strips pasted prefixes and preserves international codes", () => {
  const ru = phoneCountries[0],
    by = phoneCountries.find((c) => c.id === "BY")!;
  assert.equal(nationalPhone("8 (999) 123-45-67", ru), "9991234567");
  assert.equal(nationalPhone("+7 (999) 123-45-67", ru), "9991234567");
  assert.equal(formatNationalPhone("9991234567", "7"), "(999) 123-45-67");
  assert.equal(nationalPhone("+375291234567", by), "291234567");
  assert.equal(nationalPhone("99912345678999", ru).length, 10);
  const parse = (phone: string) =>
    personSchema.safeParse({ last_name: "Иванов", first_name: "Иван", phone });
  assert.equal(parse("+7999123456").success, false);
  assert.equal(parse("+799912345678").success, false);
  assert.equal(parse("+37499123456").success, true);
  const shortInternational = parse("+4930123456");
  assert.ok(shortInternational.success);
  assert.equal(shortInternational.data.phone, "+4930123456");
});
test("workflow allows completed candidates to progress or return, and keeps archived/incomplete candidates locked", () => {
  assert.ok(canChangeStatus(candidate, "in_process"));
  assert.ok(canChangeStatus(candidate, "historical"));
  assert.ok(canChangeStatus({ ...candidate, status: "in_process" }, "in_work"));
  assert.equal(
    canChangeStatus({ ...candidate, scoring_status: "pending" }, "in_process"),
    false,
  );
  assert.equal(
    canChangeStatus({ ...candidate, status: "historical" }, "in_work"),
    false,
  );
  const message = "Статус изменён: Архив. Кандидат отклонён всеми кластерами.";
  assert.equal(
    presentResumeEvent({
      id: "1",
      event_type: "status_changed",
      message,
      created_at: "",
    }).message,
    message,
  );
});
test("blacklist and another active resume restrict only the transition to in_process", () => {
  for (const blocked of [
    { ...candidate, blacklisted: true },
    { ...candidate, has_other_resume_in_process: true },
  ]) {
    assert.equal(canChangeStatus(blocked, "in_process"), false);
    assert.ok(inProcessRestriction(blocked));
    assert.ok(canChangeStatus(blocked, "historical"));
    assert.ok(canChangeStatus({ ...blocked, status: "in_process" }, "in_work"));
  }
  assert.match(inProcessRestriction({ ...candidate, blacklisted: true })!, /чёрном списке/);
  assert.match(inProcessRestriction({ ...candidate, has_other_resume_in_process: true })!, /другое резюме/);
  assert.equal(inProcessRestriction(candidate), null);
  assert.ok(canChangeStatus(candidate, "in_process"));
});

test("legacy text files preserve Cyrillic and reject binary TXT and active RTF", async () => {
  const cp1251 = Buffer.from([0xcf, 0xf0, 0xe8, 0xe2, 0xe5, 0xf2]);
  assert.equal(await validateFile(cp1251, "resume.txt"), "text/plain");
  assert.equal(await extractDocumentText(cp1251, "text/plain"), "Привет");
  const utf16 = Buffer.concat([
    Buffer.from([0xff, 0xfe]),
    Buffer.from("Резюме", "utf16le"),
  ]);
  assert.equal(await extractDocumentText(utf16, "text/plain"), "Резюме");
  const rtf = Buffer.from(
    "{\\rtf1\\ansi\\ansicpg1251 \\'cf\\'f0\\'e8\\'e2\\'e5\\'f2\\par SQL experience}",
  );
  assert.equal(await validateFile(rtf, "resume.rtf"), "application/rtf");
  assert.match(await extractDocumentText(rtf, "application/rtf"), /Привет/);
  await assert.rejects(validateFile(Buffer.from([0, 1, 2]), "binary.txt"));
  await assert.rejects(
    validateFile(Buffer.from("{\\rtf1\\object bad}"), "resume.rtf"),
  );
  await assert.rejects(
    validateFile(
      Buffer.from("d0cf11e0a1b11ae1000000000000000000000000", "hex"),
      "fake.doc",
    ),
  );
});
