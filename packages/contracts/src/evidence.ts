import {optionalRequirementV5,requirementClausesV5,conditionStructureV5} from "./criteria-v5.js";
import {durationScope,scopeMatches,ambiguousRolePeriod,assertionProof,educationProof,professionalBasis,professionalContext} from "./policy-v5.js";
import { z } from "zod";
import {conditionStructure,requirementList} from "./criteria.js";
import { optionalRequirement, requirementClauses, optionalRequirementV3, requirementClausesV3,optionalRequirementV4,requirementClausesV4 } from "./criteria.js";
import {requestParticipation,validSemanticReview,educationMetSupported,statementProof,stopProof,experienceConstraint,sameProofCondition} from "./proof-policy.js";
import { additionalEvidenceVerdict } from "./additional-evidence.js";
import { periodBounds } from "./employment.js";
import { scorePresentation } from "./score-presentation.js";

const quotationSchema = z.object({ quote: z.string().min(1).max(2000), start: z.number().int().nonnegative(), end: z.number().int().positive(),block_id:z.string().optional(),section:z.string().max(80).optional(),page:z.number().int().positive().optional() }).strict();
export const unknownReasonSchema = z.enum(["not_stated", "contradictory", "not_relevant", "unverified_evidence", "future_intent", "incomplete_document", "ambiguous_requirement"]);
const criterionSchema = z.object({
  id: z.string(), category: z.enum(["keyword", "experience", "education", "additional"]),
  requirement: z.string().min(1), source: z.enum(["keywords", "experience", "education", "profile_comment", "cluster_comment"]),
  optional: z.boolean(), weight: z.number().int().min(0).max(10000),
  experience_scope:z.object({role:z.string(),anchors:z.array(z.string())}).strict().optional(),
  participation_only:z.literal(true).optional(),confirmed_part:z.string().min(1).max(2000).optional(),
  semantic_review:z.object({method:z.literal("focused-model-review-v1"),status:z.enum(["met","partial"]),action_matches:z.boolean(),object_matches:z.boolean(),responsibility_matches:z.boolean(),evidence:z.array(z.string()).min(1).max(3),supported_text:z.string().max(500)}).strict().optional(),
  condition:z.object({operator:z.enum(["atomic","all","any","ambiguous"]),parts:z.array(z.string())}).strict().optional(),
  origins:z.array(z.object({source:z.string(),input_id:z.string(),text:z.string()}).strict()).max(1000).optional(),
  experience_constraint:z.object({minimum:z.number().int().nonnegative().optional(),maximum:z.number().int().nonnegative().optional(),min_inclusive:z.boolean().optional(),max_inclusive:z.boolean().optional(),ambiguous:z.boolean().optional()}).strict().optional(),
  status: z.enum(["met", "partial", "not_met", "unknown"]), evidence: z.array(quotationSchema).max(256),
  unknown_reason: unknownReasonSchema.optional(),
  partial_reason: z.enum(["duration", "learning", "missing_parts"]).optional(),
  work_periods: z.array(z.object({ start_month: z.number().int().min(1900*12), end_month: z.number().int(), start: z.number().int().nonnegative(), end: z.number().int().positive() }).strict()).max(96).optional(),
  credit: z.number().min(0).max(1), possible_credit: z.number().min(0).max(1), experience_months: z.number().int().nonnegative().optional(),
  required_months: z.number().int().positive().optional(), total_experience_months: z.number().int().nonnegative().optional(),
}).strict();
export const evidenceDetailsSchema = z.object({
  method: z.literal("evidence-v1"), policy_version: z.enum(["evidence-v1", "evidence-v2", "evidence-v3","evidence-v4","evidence-v5"]), policy_status: z.literal("provisional"),
  model: z.string(), assessment_date: z.iso.date().optional(), context_chunks: z.number().int().min(1).max(32).optional(), source_text_sha256: z.string().regex(/^[a-f0-9]{64}$/), source_text_length: z.number().int().nonnegative(),
  context_truncated: z.boolean(), criteria: z.array(criterionSchema).max(1000),
  professional_basis:z.object({status:z.enum(["confirmed","unconfirmed","not_configured"]),criteria_ids:z.array(z.string())}).strict().optional(),
  general_experience_months:z.number().int().nonnegative().optional(),
  general_work_periods:z.array(z.object({start_month:z.number().int(),end_month:z.number().int(),start:z.number().int().nonnegative(),end:z.number().int().positive()}).strict()).max(96).optional(),
  general_work_evidence:z.array(quotationSchema).max(96).optional(),
  presentation_review:z.object({reason:z.literal("unsupported_additional_evidence"),original_score:z.number().min(0).max(100)}).strict().optional(),
  run_metadata:z.object({prompt_version:z.string(),prompt_sha256:z.string().regex(/^[a-f0-9]{64}$/),extractor_version:z.string(),
    model_digest:z.string().nullable(),quantization:z.string().nullable(),temperature:z.number(),num_ctx:z.number().int().positive(),max_tokens:z.number().int().positive(),
    requests:z.array(z.object({prompt_tokens:z.number().nonnegative().nullable(),generated_tokens:z.number().nonnegative().nullable(),
      total_time_sec:z.number().nonnegative().nullable(),done_reason:z.string().nullable()}).strict()).max(9000)}).strict().optional(),
  stop_factors: z.array(z.object({ id: z.string(), requirement: z.string(), status: z.enum(["triggered", "not_triggered", "unknown"]),
    evidence: z.array(quotationSchema).max(96), unknown_reason: unknownReasonSchema.optional(), penalty: z.union([z.literal(0), z.literal(10)]), duplicates: z.array(z.string()), }).strict()).max(100),
  coverage: z.number().min(0).max(100), score_range: z.object({ min: z.number().min(0).max(100), max: z.number().min(0).max(100) }).strict(),
  stop_penalty: z.number().min(0).max(30), score_status: z.enum(["evaluated", "insufficient_evidence","not_defined"]),
}).strict();
export type EvidenceDetails = z.infer<typeof evidenceDetailsSchema>;
type EvidenceProfile = {position_name?:string;name?:string; keywords?: string[]; experience?: string | null; education?: string | null; comment?: string | null; stop_factors?: string[] };
type CriterionInput = Pick<EvidenceDetails["criteria"][number], "id" | "category" | "requirement" | "source" | "optional" | "weight"|"origins"|"condition"|"experience_scope">;
const optional = /желатель\w*|приветству\w*|будет\s+плюсом|не\s+обязател\w*/iu;
const normalize = (text: string) => text.trim().toLowerCase().replaceAll("ё", "е").replace(/\s+/gu, " ");

export function compileRatingCriteria(profile: EvidenceProfile, clusterComment = "", version: EvidenceDetails["policy_version"] = "evidence-v5"): CriterionInput[] {
  const criteria: CriterionInput[] = [];
  const preference = version === "evidence-v5"?optionalRequirementV5:version === "evidence-v4"?optionalRequirementV4:version === "evidence-v3" ? optionalRequirementV3 : version === "evidence-v2" ? optionalRequirement : optional;
  const clauses = version === "evidence-v5"?requirementClausesV5:version === "evidence-v4"?requirementClausesV4:version === "evidence-v3" ? requirementClausesV3 : requirementClauses;
  const add = (id: string, category: CriterionInput["category"], text: string, source: CriterionInput["source"]) => {
    const requirement = text.trim();
    if(!requirement)return;
    if(["evidence-v4","evidence-v5"].includes(version)&&experienceConstraint(requirement)&&/опыт|стаж|работ|разработ/iu.test(requirement)&&!/образован|высше|бакалавр|магистр|специалитет|bachelor|master|средне|колледж|техникум|университет|институт|аспирант|mba|диплом|квалификац/iu.test(requirement))category="experience";
    if(version==="evidence-v5"&&category==="education"&&!/образован|высше|бакалавр|магистр|специалитет|bachelor|master|средне|колледж|техникум|университет|институт|аспирант|mba|диплом|квалификац/iu.test(requirement)&&/опыт|стаж|работ|руковод|организац/iu.test(requirement))category="experience";
    const origin={source,input_id:id,text:requirement};
    const duplicate=["evidence-v4","evidence-v5"].includes(version)&&criteria.find(c=>normalize(c.requirement).replace(/[.!]+$/u,"")===normalize(requirement).replace(/[.!]+$/u,"")&&c.optional===preference.test(requirement));
    if(duplicate){duplicate.origins!.push(origin);return;}
    criteria.push({ id, category, requirement, source, optional: preference.test(requirement), weight: 0,...(["evidence-v4","evidence-v5"].includes(version)?{origins:[origin],condition:(version==="evidence-v5"?conditionStructureV5(requirement):conditionStructure(requirement)) as NonNullable<CriterionInput["condition"]>,...(version==="evidence-v5"&&category==="experience"&&(!experienceConstraint(requirement)||durationScope(requirement,profile))?{experience_scope:durationScope(requirement,profile)||{role:profile.position_name||profile.name||"",anchors:[...new Set(profile.keywords||[])]}}:{})}:{}) });
  };
  // v5 arrays contain explicit items from the form/API. Splitting them again
  // would destroy comma-containing conditions grouped by a newline or semicolon.
  profile.keywords?.forEach((text, index) => (version==="evidence-v5"?[text]:version==="evidence-v4"?requirementList(text):text.split(/[,;\n]+/u)).forEach((part, i) => add(`keyword:${index}:${i}`, "keyword", part, "keywords")));
  for (const category of ["experience", "education"] as const) {
    const text = profile[category] || "";
    (["evidence-v4","evidence-v5"].includes(version)?clauses(text):preference.test(text) ? version !== "evidence-v1" ? clauses(text) : text.split(/[,;\n]+/u) : [text]).forEach((part, index) => add(`${category}:${index}`, category, part, category));
  }
  for (const [source, text] of [["profile_comment", profile.comment || ""], ["cluster_comment", clusterComment]] as const)
    (version !== "evidence-v1" ? clauses(text) : text.split(/[;\n]+/u)).forEach((part, index) => add(`${source}:${index}`, "additional", part, source));
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
const reject = (): never => { throw new Error("Обработчик вернул некорректное обоснование оценки."); };

export function validateEvidenceRating(rating: { score: number; matched_keywords?: string[]; triggered_stop_factors?: string[]; details?: unknown },
  profile: EvidenceProfile, clusterComment = "") {
  const data = evidenceDetailsSchema.parse(rating.details);
  const expected = compileRatingCriteria(profile, clusterComment, data.policy_version);
  const current = data.policy_version !== "evidence-v1";
  const scoped=data.policy_version==="evidence-v5";
  if (current && (!data.assessment_date || !data.context_chunks)) reject();
  if (data.criteria.length !== expected.length || new Set(data.criteria.map(c => c.id)).size !== expected.length) reject();
  for (const criterion of data.criteria) {
    const input = expected.find(c => c.id === criterion.id);
    if (!input || Object.entries(input).some(([key, value]) => ["origins","condition","experience_scope"].includes(key)?JSON.stringify(criterion[key as keyof typeof input])!==JSON.stringify(value):criterion[key as keyof typeof input] !== value)) reject();
    if (criterion.status !== "unknown" && (!criterion.evidence.length||criterion.condition?.operator==="ambiguous")) reject();
    if(criterion.participation_only&&(!["evidence-v4","evidence-v5"].includes(data.policy_version)||criterion.status!=="partial"||!(scoped?["keyword","additional","experience"]:["keyword","additional"]).includes(criterion.category)||criterion.confirmed_part!==requestParticipation(criterion.requirement,criterion.evidence.map(e=>e.quote))))reject();
    if(criterion.confirmed_part&&!criterion.participation_only)reject();
    const semantic=validSemanticReview(criterion.semantic_review,criterion.status,criterion.evidence,scoped?"":criterion.requirement);
    if(criterion.semantic_review&&(!semantic||!["evidence-v4","evidence-v5"].includes(data.policy_version)||!(scoped?["keyword","additional","experience"]:["keyword","additional"]).includes(criterion.category)))reject();
    if(data.policy_version==="evidence-v4"&&["keyword","additional"].includes(criterion.category)&&!statementProof(criterion.requirement,criterion.status,criterion.evidence.map(e=>e.quote),semantic).valid)reject();
    if(data.policy_version==="evidence-v4"&&criterion.category==="education"&&criterion.status==="met"&&!educationMetSupported(criterion.requirement,criterion.evidence.map(e=>e.quote)))reject();
    if(scoped){
      const quotes=criterion.evidence.map(e=>e.quote);
      if(criterion.category==="education"&&!educationProof(criterion.requirement,criterion.status,quotes,criterion.condition))reject();
      if(criterion.category!=="education"&&!criterion.experience_constraint&&!assertionProof(criterion.requirement,criterion.status,quotes,criterion.condition,semantic))reject();
      if(semantic&&criterion.semantic_review?.supported_text&&!assertionProof(criterion.requirement,criterion.semantic_review.status,[criterion.semantic_review.supported_text],criterion.condition,true))reject();
      if(criterion.category==="experience"&&!criterion.experience_constraint&&['met','partial'].includes(criterion.status)&&!professionalContext(criterion.requirement,criterion.experience_scope,quotes,criterion.condition))reject();
      if(criterion.category==="experience"&&criterion.experience_months!=null){
        if(!quotes.some(q=>scopeMatches(criterion.requirement,criterion.experience_scope,q)))reject();
        if(criterion.work_periods&&ambiguousRolePeriod(criterion.requirement,criterion.experience_scope,quotes.join('\n')))reject();
      }
    }
    if (data.policy_version === "evidence-v3" && criterion.category === "additional"
      && !additionalEvidenceVerdict(criterion.requirement, criterion.status, criterion.evidence.map(e=>e.quote)).valid) reject();
    if (current && ((criterion.status === "unknown") !== (criterion.unknown_reason != null))) reject();
    if (current && ((criterion.status === "partial") !== (criterion.partial_reason != null))) reject();
    if (!current && (criterion.evidence.length > 4 || criterion.unknown_reason || criterion.partial_reason || criterion.work_periods)) reject();
    if (criterion.work_periods) {
      if (!current || criterion.category !== "experience") reject();
      const periods = [...criterion.work_periods].sort((a,b) => a.start_month-b.start_month || a.end_month-b.end_month);
      let total = 0, end = -1;
      const asOf = new Date(data.assessment_date! + "T00:00:00Z");
      const maximum = asOf.getUTCFullYear()*12 + asOf.getUTCMonth() + Number(asOf.getUTCDate() === new Date(Date.UTC(asOf.getUTCFullYear(), asOf.getUTCMonth()+1, 0)).getUTCDate());
      for (const period of periods) {
        const citation = criterion.evidence.find(e => e.start <= period.start && e.end >= period.end);
        const header = citation ? Array.from(citation.quote).slice(period.start-citation.start, period.end-citation.start).join("") : "";
        const bounds = periodBounds(header, data.assessment_date!);
        if (period.start_month >= period.end_month || period.end_month > maximum ||
          !bounds || period.start_month !== bounds[0] || period.end_month > bounds[1]) reject();
        total += Math.max(0, period.end_month - Math.max(end, period.start_month));
        end = Math.max(end, period.end_month);
      }
      const observed = criterion.total_experience_months == null ? total : Math.min(total, criterion.total_experience_months);
      if (criterion.status !== "unknown" && criterion.experience_months !== observed) reject();
    }
    if (!["evidence-v4","evidence-v5"].includes(data.policy_version) && criterion.category === "keyword" && criterion.status !== "unknown") {
      const aliases = ({ sql: ["SQL", "MS SQL", "T-SQL", "MSSQL"], "rest api": ["REST API", "RESTful API"] } as Record<string, string[]>)[normalize(criterion.requirement)] || [criterion.requirement];
      const hasLiteral = (term: string): boolean => {
        const variants = ({ sql: ["SQL", "MS SQL", "T-SQL", "MSSQL"], "rest api": ["REST API", "RESTful API"] } as Record<string,string[]>)[normalize(term)] || [term];
        return criterion.evidence.some(e => variants.some(alias => {
          const escaped = normalize(alias).replace(/[.*+?^${}()|[\]\\]/gu, "\\$&").replace(/ /gu, "\\s+");
          return new RegExp(`(?<![\\p{L}\\p{N}_])${escaped}(?![\\p{L}\\p{N}_])`, "u").test(normalize(e.quote));
        }));
      };
      const hasRequirement = (term: string): boolean => {
        const alternatives = term.split(/\s+или\s+/iu);
        if (alternatives.length > 1) return alternatives.some(hasRequirement);
        const combined = term.split(/\s+и\s+/iu);
        if (combined.length > 1) return combined.every(hasRequirement);
        return hasLiteral(term);
      };
      const containsSkill = current ? criterion.status === "met" ? hasRequirement(criterion.requirement)
        : criterion.requirement.split(/\s+(?:и|или)\s+/iu).some(hasLiteral)
        : aliases.some(hasLiteral);
      if (!containsSkill) reject();
    }
    let credit = criterion.status === "met" ? 1 : criterion.status === "partial" ? .5 : 0;
    if (criterion.status === "partial" && criterion.category === "experience" && criterion.required_months && criterion.experience_months != null) {
      const duration = Math.min(criterion.experience_months / criterion.required_months, 1);
      if (current) {
        if (criterion.partial_reason === "duration" && criterion.experience_months >= criterion.required_months) reject();
        credit = criterion.partial_reason === "duration" ? duration : Math.min(.5, duration);
      } else credit = criterion.experience_months < criterion.required_months ? duration : .5;
    }
    if (Math.abs(criterion.credit - credit) > 1e-10) reject();
    if (criterion.category === "experience") {
      const bounds=["evidence-v4","evidence-v5"].includes(data.policy_version)?experienceConstraint(criterion.requirement):undefined;
      if(criterion.required_months !== (["evidence-v4","evidence-v5"].includes(data.policy_version)?(bounds?.minimum||undefined):minimumExperienceMonths(criterion.requirement)))reject();
      if(["evidence-v4","evidence-v5"].includes(data.policy_version)&&JSON.stringify(criterion.experience_constraint)!==JSON.stringify(bounds))reject();
      if(bounds?.maximum!=null&&criterion.status==="met"&&(criterion.experience_months==null||criterion.experience_months>bounds.maximum||criterion.experience_months===bounds.maximum&&!bounds.max_inclusive))reject();
      if(bounds?.minimum!=null&&!bounds.min_inclusive&&criterion.status==="met"&&criterion.experience_months===bounds.minimum)reject();
    }
    const possible = criterion.status !== "unknown" ? criterion.credit
      : criterion.required_months && criterion.total_experience_months != null ? Math.min(criterion.total_experience_months / criterion.required_months, 1) : 1;
    if (Math.abs(criterion.possible_credit - possible) > 1e-10) reject();
    if (criterion.category === "experience" && criterion.required_months && criterion.status !== "unknown") {
      if (criterion.experience_months == null && (!current || criterion.status !== "not_met")) reject();
      if (criterion.status === "met" && criterion.experience_months! < criterion.required_months) reject();
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
    if(["evidence-v4","evidence-v5"].includes(data.policy_version)&&stop.status!=="unknown"&&!stopProof(stop.requirement,stop.status,stop.evidence.map(e=>e.quote)))reject();
    if(scoped&&stop.status!=="unknown"&&experienceConstraint(stop.requirement)&&!stop.evidence.some(e=>scopeMatches(stop.requirement,durationScope(stop.requirement,profile),e.quote)))reject();
    if (current && ((stop.status === "unknown") !== (stop.unknown_reason != null))) reject();
    if (!current && (stop.evidence.length > 3 || stop.unknown_reason)) reject();
    const duplicates = data.criteria.filter(c => ["partial", "not_met"].includes(c.status) && (["evidence-v4","evidence-v5"].includes(data.policy_version)?sameProofCondition(c.requirement,stop.requirement):intersects(contentTokens(c.requirement), contentTokens(stop.requirement)) ||
      c.category === "experience" && c.required_months != null && c.required_months === minimumExperienceMonths(stop.requirement))).map(c => c.id);
    if (JSON.stringify(stop.duplicates) !== JSON.stringify(duplicates)) reject();
    const key = normalize(stop.requirement);
    const penalty = stop.status === "triggered" && !duplicates.length && !penalized.has(key) ? 10 : 0;
    if (stop.penalty !== penalty) reject();
    if (penalty) penalized.add(key);
  }
  for (const quote of [...[...data.criteria, ...data.stop_factors].flatMap(c => c.evidence),...(data.general_work_evidence||[])])
    if (quote.end > data.source_text_length || quote.end <= quote.start || Array.from(quote.quote).length !== quote.end - quote.start) reject();
  if(data.general_work_periods||data.general_work_evidence||data.general_experience_months!=null){
    if(!scoped||!data.general_work_periods?.length||!data.general_work_evidence?.length||data.general_experience_months==null)reject();
    let total=0,end=-1;
    const asOf=new Date(data.assessment_date!+'T00:00:00Z');
    const maximum=asOf.getUTCFullYear()*12+asOf.getUTCMonth()+Number(asOf.getUTCDate()===new Date(Date.UTC(asOf.getUTCFullYear(),asOf.getUTCMonth()+1,0)).getUTCDate());
    for(const p of [...data.general_work_periods!].sort((a,b)=>a.start_month-b.start_month||a.end_month-b.end_month)){
      const e=data.general_work_evidence!.find(e=>e.start<=p.start&&e.end>=p.end);
      const bounds=e&&periodBounds(Array.from(e.quote).slice(p.start-e.start,p.end-e.start).join(''),data.assessment_date!);
      if(!bounds||p.start_month<1900*12||p.start_month!==bounds[0]||p.end_month<=p.start_month||p.end_month>bounds[1]||p.end_month>maximum)reject();
      total+=Math.max(0,p.end_month-Math.max(end,p.start_month));end=Math.max(end,p.end_month);
    }
    if(total!==data.general_experience_months)reject();
  }
  const matched = [...new Set(data.criteria.filter(c => c.category === "keyword" && ["met", "partial"].includes(c.status)).map(c => c.requirement))];
  const triggered = [...new Set(data.stop_factors.filter(s => s.status === "triggered").map(s => s.requirement))];
  if (JSON.stringify(rating.matched_keywords || []) !== JSON.stringify(matched) || JSON.stringify(rating.triggered_stop_factors || []) !== JSON.stringify(triggered)) reject();
  const penalty = Math.min(30, data.stop_factors.reduce((sum, s) => sum + s.penalty, 0));
  const points = data.criteria.reduce((sum, c) => sum + c.weight * c.credit, 0) / 100;
  const unknown = data.criteria.filter(c => c.status === "unknown").reduce((sum, c) => sum + c.weight * c.possible_credit, 0) / 100;
  const weighted = data.criteria.some(c => c.weight);
  const range = { min: weighted ? roundScore(points - penalty) : 0, max: weighted ? roundScore(points + unknown - penalty) : 100 };
  if(scoped){
    const basis=professionalBasis(data.criteria);
    if(JSON.stringify(data.professional_basis)!==JSON.stringify(basis))reject();
    if(basis.status==="unconfirmed"){
      range.min=0;
      if(!data.criteria.some(c=>!c.optional&&c.category!=="education"&&c.status==="unknown"))range.max=0;
    }
  }
  const coverage = roundScore(data.criteria.filter(c => c.status !== "unknown").reduce((sum, c) => sum + c.weight, 0) / 100);
  if (Math.abs(rating.score - range.min) > .001 || data.score_range.min !== range.min || data.score_range.max !== range.max || data.coverage !== coverage || data.stop_penalty !== penalty ||
    data.score_status !== (["evidence-v4","evidence-v5"].includes(data.policy_version)&&!weighted?"not_defined":coverage ? "evaluated" : "insufficient_evidence")) reject();
  return data;
}

export function ratingEvidence(rating?: { details?: unknown }): EvidenceDetails | undefined {
  if (!rating || (rating.details as { method?: string } | undefined)?.method !== "evidence-v1") return;
  const parsed = evidenceDetailsSchema.safeParse(rating.details);
  return parsed.success ? verifiedAdditionalEvidence(parsed.data) : undefined;
}

// Keep saved results immutable. Withdraw only unsupported additional claims in
// the report view, recomputing the score with the original weights and policy.
function verifiedAdditionalEvidence(data: EvidenceDetails): EvidenceDetails {
  if(["evidence-v4","evidence-v5"].includes(data.policy_version))return data;
  const invalid: ReturnType<typeof additionalEvidenceVerdict>[] = data.criteria.map(c=>c.category === "additional" && c.status !== "unknown"
    ? additionalEvidenceVerdict(c.requirement,c.status,c.evidence.map(e=>e.quote)) : {valid:true});
  if (invalid.every(v=>v.valid)) return data;
  const checked = evidenceDetailsSchema.parse(data);
  checked.presentation_review=data.presentation_review||{reason:"unsupported_additional_evidence",original_score:data.score_range.min};
  checked.criteria.forEach((c,i)=>{
    if (invalid[i].valid) return;
    c.status="unknown"; c.credit=0; c.possible_credit=1;
    if (checked.policy_version !== "evidence-v1") c.unknown_reason=invalid[i].reason || "not_relevant";
    delete c.partial_reason;
  });
  const penalized = new Set<string>();
  for (const stop of checked.stop_factors) {
    stop.duplicates=checked.criteria.filter(c=>["partial","not_met"].includes(c.status)
      && (intersects(contentTokens(c.requirement),contentTokens(stop.requirement))
        || c.category === "experience" && c.required_months != null && c.required_months === minimumExperienceMonths(stop.requirement))).map(c=>c.id);
    const key=normalize(stop.requirement);
    stop.penalty=stop.status === "triggered" && !stop.duplicates.length && !penalized.has(key) ? 10 : 0;
    if (stop.penalty) penalized.add(key);
  }
  checked.stop_penalty=Math.min(30,checked.stop_factors.reduce((sum,s)=>sum+s.penalty,0));
  const points=checked.criteria.reduce((sum,c)=>sum+c.weight*c.credit,0)/100;
  const unknown=checked.criteria.filter(c=>c.status === "unknown").reduce((sum,c)=>sum+c.weight*c.possible_credit,0)/100;
  checked.score_range=checked.criteria.some(c=>c.weight) ? {min:roundScore(points-checked.stop_penalty),max:roundScore(points+unknown-checked.stop_penalty)} : {min:0,max:100};
  checked.coverage=roundScore(checked.criteria.filter(c=>c.status !== "unknown").reduce((sum,c)=>sum+c.weight,0)/100);
  checked.score_status=checked.coverage ? "evaluated" : "insufficient_evidence";
  return checked;
}

export function verifiedRatingView<T extends {score:number;details?:unknown;explanation?:string|null}>(rating:T):T {
  if ((rating.details as {method?:string}|undefined)?.method !== "evidence-v1") return rating;
  const parsed=evidenceDetailsSchema.safeParse(rating.details);
  if (!parsed.success) return rating;
  const details=verifiedAdditionalEvidence(parsed.data);
  if (details === parsed.data) return rating;
  return {...rating,score:details.score_range.min,details,explanation:explainEvidenceRating(details)};
}

export function ratingScoreValue(rating?: {score:number;details?:unknown}): number|undefined {
  if(!rating)return;
  const evidence=ratingEvidence(rating);
  return evidence?.score_status==="not_defined"?undefined:evidence?.score_range.min??Number(rating.score);
}

export function ratingScoreText(rating: { score: number; details?: unknown }): string {
  const evidence=ratingEvidence(rating);
  return evidence?.score_status==="not_defined"?"Оценка не определена":String(evidence?.score_range.min??rating.score);
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
  for (const [status, label] of [["met", "Подтверждено"], ["partial", "Частичное соответствие"], ["not_met", "Подтверждённое несоответствие"], ["unknown", "Не указано"]]) {
    const group = data.criteria.filter(c => c.status === status);
    if (!group.length) continue;
    if (status === "unknown") {
      lines.push(`Условий, требующих уточнения: ${group.length}.`);
      continue;
    }
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
  if (unknown.length) lines.push(`Стоп-факторов, требующих уточнения: ${unknown.length}.`);
  const estimate = scorePresentation(data.score_range, data.context_truncated || data.score_status === "insufficient_evidence");
  lines.push(`${estimate.label}: ${estimate.value} из 100.${estimate.note ? " " + estimate.note : ""}`);
  if (data.context_truncated) lines.push("Оценён только фрагмент резюме из-за ограничения контекста; оставшиеся сведения требуют проверки.");
  return lines.join("\n");
}
