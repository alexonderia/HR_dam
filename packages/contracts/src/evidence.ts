import { z } from "zod";

const quotationSchema = z.object({ quote: z.string().min(1).max(2000), start: z.number().int().nonnegative(), end: z.number().int().positive() }).strict();
const criterionSchema = z.object({
  id: z.string(), category: z.enum(["keyword", "experience", "education", "additional"]),
  requirement: z.string().min(1), source: z.enum(["keywords", "experience", "education", "profile_comment", "cluster_comment"]),
  optional: z.boolean(), weight: z.number().int().min(0).max(10000),
  status: z.enum(["met", "partial", "not_met", "unknown"]), evidence: z.array(quotationSchema).max(4),
  credit: z.number().min(0).max(1), possible_credit: z.number().min(0).max(1), experience_months: z.number().int().nonnegative().optional(),
  required_months: z.number().int().positive().optional(), total_experience_months: z.number().int().nonnegative().optional(),
}).strict();
const scoreRangeSchema = z.object({ min: z.number().min(0).max(100), max: z.number().min(0).max(100) }).strict();
const RANGE_LIMIT = 20;
const evidenceDetailsBase = z.object({
  policy_status: z.literal("provisional"),
  model: z.string(), source_text_sha256: z.string().regex(/^[a-f0-9]{64}$/), source_text_length: z.number().int().nonnegative(),
  context_truncated: z.boolean(), criteria: z.array(criterionSchema).max(1000),
  stop_factors: z.array(z.object({ id: z.string(), requirement: z.string(), status: z.enum(["triggered", "not_triggered", "unknown"]),
    evidence: z.array(quotationSchema).max(3), penalty: z.union([z.literal(0), z.literal(10)]), duplicates: z.array(z.string()), }).strict()).max(100),
  coverage: z.number().min(0).max(100),
  stop_penalty: z.number().min(0).max(30), score_status: z.enum(["evaluated", "insufficient_evidence"]),
}).strict();
export const evidenceDetailsSchema = z.discriminatedUnion("method", [
  evidenceDetailsBase.extend({ method: z.literal("evidence-v1"), policy_version: z.literal("evidence-v1"), score_range: scoreRangeSchema }),
  evidenceDetailsBase.extend({ method: z.literal("evidence-v2"), policy_version: z.literal("evidence-v2"),
    score_range: scoreRangeSchema, full_score_range: scoreRangeSchema, range_limit: z.literal(RANGE_LIMIT) }),
  evidenceDetailsBase.extend({ method: z.literal("evidence-v3"), policy_version: z.literal("evidence-v3") }),
]);
export type EvidenceDetails = z.infer<typeof evidenceDetailsSchema>;
type EvidenceProfile = { keywords?: string[]; experience?: string | null; education?: string | null; comment?: string | null; stop_factors?: string[] };
type CriterionInput = Pick<EvidenceDetails["criteria"][number], "id" | "category" | "requirement" | "source" | "optional" | "weight">;
const optional = /желатель\w*|приветству\w*|будет\s+плюсом|не\s+обязател\w*/iu;
const normalize = (text: string) => text.trim().toLowerCase().replaceAll("ё", "е").replace(/\s+/gu, " ");
const skillAliases: Record<string, string[]> = {
  sql: ["SQL", "MS SQL", "T-SQL", "MSSQL"], "rest api": ["REST API", "RESTful API"],
  "тест-кейсы": ["тест-кейсы", "тест-кейс", "тест-кейсов", "тест-кейсами", "тест кейсы", "test cases", "test case"],
  "баг репорты": ["баг репорты", "баг-репорты", "баг-репортов", "баг-репортами", "багрепорты", "bug reports", "bug report"],
  "отчеты о тестировании": ["отчеты о тестировании", "отчёты о тестировании", "отчет о тестировании", "отчёт о тестировании", "тестовые отчеты", "тестовые отчёты", "test reports", "test report"],
  "регресс-тестирование": ["регресс-тестирование", "регресс тестирование", "регрессионное тестирование", "регрессионного тестирования", "регрессионным тестированием", "regression testing"],
  "тестовая документация": ["тестовая документация", "тестовую документацию", "тестовой документации", "тестовой документацией", "test documentation"],
};

export function compileRatingCriteria(profile: EvidenceProfile, clusterComment = ""): CriterionInput[] {
  const criteria: CriterionInput[] = [];
  const add = (id: string, category: CriterionInput["category"], text: string, source: CriterionInput["source"]) => {
    const requirement = text.trim();
    if (requirement) criteria.push({ id, category, requirement, source, optional: optional.test(requirement), weight: 0 });
  };
  profile.keywords?.forEach((text, index) => text.split(/[,;\n]+/u).forEach((part, i) => add(`keyword:${index}:${i}`, "keyword", part, "keywords")));
  for (const category of ["experience", "education"] as const) {
    const text = profile[category] || "";
    (optional.test(text) ? text.split(/[,;\n]+/u) : [text]).forEach((part, index) => add(`${category}:${index}`, category, part, category));
  }
  for (const [source, text] of [["profile_comment", profile.comment || ""], ["cluster_comment", clusterComment]] as const)
    text.split(/[;\n]+/u).forEach((part, index) => add(`${source}:${index}`, "additional", part, source));
  const mandatory = criteria.filter(c => !c.optional);
  const base = { keyword: 40, experience: 30, education: 15, additional: 15 };
  const total = [...new Set(mandatory.map(c => c.category))].reduce((sum, category) => sum + base[category], 0);
  if (total) {
    const fractions = mandatory.map(c => {
      const denominator = total * mandatory.filter(other => other.category === c.category).length;
      const numerator = 10000 * base[c.category];
      c.weight = Math.floor(numerator / denominator);
      return { c, numerator: numerator % denominator, denominator };
    });
    const remaining = 10000 - mandatory.reduce((sum, c) => sum + c.weight, 0);
    fractions.sort((a, b) => b.numerator * a.denominator - a.numerator * b.denominator || (a.c.id < b.c.id ? -1 : a.c.id > b.c.id ? 1 : 0));
    fractions.slice(0, remaining).forEach(({ c }) => c.weight++);
  }
  return criteria;
}

function contentTokens(text: string) {
  const ignored = new Set(["нет", "без", "не", "по", "на", "из", "от", "до", "за", "со", "во", "при", "опыт", "опыта", "наличие", "отсутствие", "кандидат", "кандидатов", "рассматриваем", "только", "работы", "лет", "года", "год"]);
  return new Set((normalize(text).match(/[\p{L}\p{N}_+#]+/gu) || []).filter(t => t.length >= 2 && !ignored.has(t)).map(t => t.slice(0, 6)));
}
export function minimumExperienceMonths(requirement: string): number | undefined {
  let text = normalize(requirement);
  for (const [word, number] of Object.entries({ одного: 1, двух: 2, трех: 3, четырех: 4, пяти: 5 })) text = text.replaceAll(word, String(number));
  const match = /(\d+)\s*(?:[-–—]\s*\d+\s*)?(лет|года?|years?|месяц[\p{L}]*|months?)(?=$|[^\p{L}])/u.exec(text);
  if (!match) return;
  const years = /^(лет|год|year)/u.test(match[2]);
  let value = Number(match[1]) * (years ? 12 : 1);
  if (years && !/[-–—]/u.test(match[0])) {
    const months = /^\s*[,и]?\s*(\d+)\s*(месяц[\p{L}]*|months?)(?=$|[^\p{L}])/u.exec(text.slice(match.index + match[0].length));
    if (months) value += Number(months[1]);
  }
  return value > 0 ? value : undefined;
}
const intersects = (a: Set<string>, b: Set<string>) => [...a].some(token => b.has(token));
const roundScore = (value: number) => Math.round(Math.max(0, Math.min(100, value)) * 100) / 100;
const midpoint = (min: number, max: number) => roundScore((min + max) / 2);
function evidenceScore(data: EvidenceDetails): number {
  if (data.method !== "evidence-v3") return midpoint(data.score_range.min, data.score_range.max);
  const points = data.criteria.reduce((sum, c) => sum + c.weight * c.credit, 0) / 100;
  const unknown = data.criteria.filter(c => c.status === "unknown").reduce((sum, c) => sum + c.weight * c.possible_credit, 0) / 100;
  const weighted = data.criteria.some(c => c.weight);
  const min = weighted ? roundScore(points - data.stop_penalty) : 0;
  const max = weighted ? roundScore(points + unknown - data.stop_penalty) : 100;
  return midpoint(min, Math.min(max, roundScore(min + RANGE_LIMIT)));
}
const reject = (): never => { throw new Error("Обработчик вернул некорректное обоснование оценки."); };

export function validateEvidenceRating(rating: { score: number; matched_keywords?: string[]; triggered_stop_factors?: string[]; details?: unknown },
  profile: EvidenceProfile, clusterComment = "") {
  const data = evidenceDetailsSchema.parse(rating.details);
  const expected = compileRatingCriteria(profile, clusterComment);
  if (data.criteria.length !== expected.length || new Set(data.criteria.map(c => c.id)).size !== expected.length) reject();
  for (const criterion of data.criteria) {
    const input = expected.find(c => c.id === criterion.id);
    if (!input || Object.entries(input).some(([key, value]) => criterion[key as keyof typeof input] !== value)) reject();
    if (criterion.status !== "unknown" && !criterion.evidence.length) reject();
    if (criterion.category === "keyword" && criterion.status !== "unknown") {
      const term = criterion.requirement.trim().replace(/[.;]+$/u, "");
      if (!term) reject();
      const aliases = Object.entries(skillAliases).find(([name, variants]) => name === normalize(term) ||
        variants.some(alias => normalize(alias) === normalize(term)))?.[1] || [term];
      const containsSkill = criterion.evidence.some(e => aliases.some(alias => {
        const escaped = normalize(alias).replace(/[.*+?^${}()|[\]\\]/gu, "\\$&").replace(/ /gu, "\\s+");
        return new RegExp(`(?<![\\p{L}\\p{N}_])${escaped}(?![\\p{L}\\p{N}_])`, "u").test(normalize(e.quote));
      }));
      if (!containsSkill) reject();
    }
    const credit = criterion.status === "met" ? 1 : criterion.status === "partial"
      ? criterion.category === "experience" && criterion.required_months && criterion.experience_months != null
        ? Math.min(criterion.experience_months / criterion.required_months, 1) : .5 : 0;
    if (Math.abs(criterion.credit - credit) > 1e-10) reject();
    if (criterion.category === "experience" && criterion.required_months !== minimumExperienceMonths(criterion.requirement)) reject();
    const possible = criterion.status !== "unknown" ? criterion.credit
      : criterion.required_months && criterion.total_experience_months != null ? Math.min(criterion.total_experience_months / criterion.required_months, 1) : 1;
    if (Math.abs(criterion.possible_credit - possible) > 1e-10) reject();
    if (criterion.category === "experience" && criterion.required_months && criterion.status !== "unknown") {
      if (criterion.experience_months == null) reject();
      if ((criterion.status === "met") !== (criterion.experience_months! >= criterion.required_months)) reject();
      if (criterion.total_experience_months != null && criterion.experience_months! > criterion.total_experience_months) reject();
    }
  }
  const texts = profile.stop_factors || [];
  if (data.stop_factors.length !== texts.length || new Set(data.stop_factors.map(s => s.id)).size !== texts.length) reject();
  const penalized = new Set<string>();
  for (const stop of data.stop_factors) {
    const index = Number(stop.id.replace(/^stop:/u, ""));
    if (stop.id !== `stop:${index}` || texts[index] !== stop.requirement) reject();
    if (stop.status !== "unknown" && !stop.evidence.length) reject();
    const duplicates = data.criteria.filter(c => ["partial", "not_met"].includes(c.status) && (intersects(contentTokens(c.requirement), contentTokens(stop.requirement)) ||
      c.category === "experience" && c.required_months != null && c.required_months === minimumExperienceMonths(stop.requirement))).map(c => c.id);
    if (JSON.stringify(stop.duplicates) !== JSON.stringify(duplicates)) reject();
    const key = normalize(stop.requirement);
    const penalty = stop.status === "triggered" && !duplicates.length && !penalized.has(key) ? 10 : 0;
    if (stop.penalty !== penalty) reject();
    if (penalty) penalized.add(key);
  }
  for (const quote of [...data.criteria, ...data.stop_factors].flatMap(c => c.evidence))
    if (quote.end > data.source_text_length || quote.end <= quote.start || Array.from(quote.quote).length !== quote.end - quote.start) reject();
  const matched = [...new Set(data.criteria.filter(c => c.category === "keyword" && ["met", "partial"].includes(c.status)).map(c => c.requirement))];
  const triggered = [...new Set(data.stop_factors.filter(s => s.status === "triggered").map(s => s.requirement))];
  if (JSON.stringify(rating.matched_keywords || []) !== JSON.stringify(matched) || JSON.stringify(rating.triggered_stop_factors || []) !== JSON.stringify(triggered)) reject();
  const penalty = Math.min(30, data.stop_factors.reduce((sum, s) => sum + s.penalty, 0));
  const points = data.criteria.reduce((sum, c) => sum + c.weight * c.credit, 0) / 100;
  const unknown = data.criteria.filter(c => c.status === "unknown").reduce((sum, c) => sum + c.weight * c.possible_credit, 0) / 100;
  const weighted = data.criteria.some(c => c.weight);
  const fullRange = { min: weighted ? roundScore(points - penalty) : 0, max: weighted ? roundScore(points + unknown - penalty) : 100 };
  const range = data.method === "evidence-v2"
    ? { min: fullRange.min, max: Math.min(fullRange.max, roundScore(fullRange.min + RANGE_LIMIT)) } : fullRange;
  if (data.method === "evidence-v2" && (data.full_score_range.min !== fullRange.min || data.full_score_range.max !== fullRange.max)) reject();
  const coverage = roundScore(data.criteria.filter(c => c.status !== "unknown").reduce((sum, c) => sum + c.weight, 0) / 100);
  const expectedScore = data.method === "evidence-v3" ? evidenceScore(data) : range.min;
  if (data.method !== "evidence-v3" && (data.score_range.min !== range.min || data.score_range.max !== range.max)) reject();
  if (Math.abs(rating.score - expectedScore) > .001 || data.coverage !== coverage || data.stop_penalty !== penalty ||
    data.score_status !== (coverage ? "evaluated" : "insufficient_evidence")) reject();
  return data;
}

export function ratingEvidence(rating?: { details?: unknown }): EvidenceDetails | undefined {
  if (!rating || !["evidence-v1", "evidence-v2", "evidence-v3"].includes((rating.details as { method?: string } | undefined)?.method || "")) return;
  const parsed = evidenceDetailsSchema.safeParse(rating.details);
  return parsed.success ? parsed.data : undefined;
}

export function ratingScore(rating: { score: number; details?: unknown }): number {
  const data = ratingEvidence(rating);
  return data && data.method !== "evidence-v3" ? evidenceScore(data) : Number(rating.score);
}

export function ratingScoreText(rating: { score: number; details?: unknown }): string {
  return String(ratingScore(rating));
}

export function ratingExplanation(rating: { details?: unknown; explanation?: string }): string {
  const data = ratingEvidence(rating);
  return data ? explainEvidenceRating(data) : rating.explanation || "";
}

export function explainEvidenceRating(data: EvidenceDetails): string {
  const duration = (value: number, minimum = false) => {
    const unit = (n: number, forms: string[]) => n % 100 >= 11 && n % 100 <= 14 ? forms[2] : n % 10 === 1 ? forms[0] : n % 10 >= 2 && n % 10 <= 4 ? forms[1] : forms[2];
    const years = Math.floor(value / 12), months = value % 12, parts: string[] = [];
    if (years) parts.push(`${years} ${minimum ? years % 10 === 1 && years % 100 !== 11 ? "года" : "лет" : unit(years, ["год", "года", "лет"])}`);
    if (months || !parts.length) parts.push(`${months} ${minimum ? months % 10 === 1 && months % 100 !== 11 ? "месяца" : "месяцев" : unit(months, ["месяц", "месяца", "месяцев"])}`);
    return parts.join(" ");
  };
  const lines: string[] = [];
  for (const [status, label] of [["met", "Подтверждено"], ["partial", "Частичное соответствие"], ["not_met", "Подтверждённое несоответствие"], ["unknown", "Требует уточнения"]]) {
    const group = data.criteria.filter(c => c.status === status);
    if (!group.length) continue;
    const items = group.map(c => {
      let text = c.requirement;
      if (c.required_months != null) {
        if (c.experience_months != null) text += ` — в приведённых сведениях ${duration(c.experience_months)}, требуется не менее ${duration(c.required_months, true)}`;
        else if (c.total_experience_months != null) text += ` — общий стаж ${duration(c.total_experience_months)}, требуется не менее ${duration(c.required_months, true)}; релевантность стажа требует уточнения`;
      }
      if (c.optional) text += " (желательное требование, на балл не влияет)";
      if (c.evidence.length) text += ` — «${c.evidence[0].quote}»`;
      return text;
    });
    lines.push(label + ": " + items.join("; ") + ".");
  }
  const triggered = data.stop_factors.filter(s => s.status === "triggered");
  if (triggered.length) lines.push("Подтверждённые стоп-факторы: " + triggered.map(s => s.requirement + " — «" + s.evidence[0].quote + "»").join("; ") + ".");
  const unknown = data.stop_factors.filter(s => s.status === "unknown");
  if (unknown.length) lines.push("Стоп-факторы требуют уточнения, штраф не применён: " + unknown.map(s => s.requirement).join("; ") + ".");
  lines.push(`Оценка по данным резюме: ${evidenceScore(data)}/100; охват проверенными критериями — ${data.coverage}%. Неизвестные сведения не означают отсутствие компетенции.`);
  if (!data.coverage)
    lines.push("Недостаточно подтверждений для оценки компетенций кандидата.");
  if (data.context_truncated) lines.push("Оценён только фрагмент резюме из-за ограничения контекста; оставшиеся сведения требуют проверки.");
  return lines.join("\n");
}
