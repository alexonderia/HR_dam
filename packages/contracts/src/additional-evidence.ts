// Keep the cases aligned with resume_evaluator/additional_evidence.py.
import {optionalRequirementV3,requirementClausesV3} from "./criteria.js";
const concepts = [
  [/\b(?:kubernetes|k8s)\b/iu, "\\b(?:kubernetes|k8s)\\b"],
  [/высоконагруж[\p{L}]*|high[ -]?load/iu, "высоконагруж[\\p{L}]*|high[ -]?load|высок(?:ая|ие|их|ую)\\s+нагруз[\\p{L}]*"],
  [/б[эе]кенд[\p{L}]*|back[ -]?end/iu, "б[эе]кенд[\\p{L}]*|back[ -]?end|server[ -]?side|серверн[\\p{L}]*\\s+(?:разработ[\\p{L}]*|част[\\p{L}]*)"],
] as const;
const ignored = new Set("ищем нужен нужна сильного сильный кандидат кандидата требуется опыт опыта опытом работы работа работать знание знания навык навыки умение владение для систем системы системами системах плюс желательно желателен желательна приветствуется будет плюсом сильных уверенное хорошее коммерческий коммерческого требование наличие обязательно обязателен специалист специалиста от до лет года год месяцев with and the for experience knowledge".split(" "));
const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
function anchors(requirement: string): string[] {
  let text = requirement.toLowerCase().replaceAll("ё", "е");
  const result: string[] = [];
  for (const [wanted, evidence] of concepts) if (wanted.test(text)) {
    result.push(evidence); text = text.replace(new RegExp(wanted.source, "giu"), " ");
  }
  for (const match of text.matchAll(/(?<![\p{L}\p{N}_])[a-z][a-z0-9+#.-]*/gu)) {
    const token = match[0].replace(/[.-]+$/u, "");
    if (!ignored.has(token)) result.push(`(?<![\\p{L}\\p{N}_])${escape(token)}(?![\\p{L}\\p{N}_])`);
  }
  if (!result.length) for (const token of text.match(/[а-я]+/gu) || [])
    if (token.length >= 4 && !ignored.has(token)) result.push(escape(token.slice(0, 6)) + "[\\p{L}]*");
  return [...new Set(result)];
}
const negative = /(?<![\p{L}])(?:нет|без|отсутств[\p{L}]*|никогда|не\s+(?:име[\p{L}]*|владе[\p{L}]*|зна[\p{L}]*|работ[\p{L}]*|использ[\p{L}]*|занима[\p{L}]*|готов[\p{L}]*|уме[\p{L}]*|дела[\p{L}]*|разрабатыва[\p{L}]*))(?![\p{L}])/iu;
const intention = /хотел[\p{L}]*\s+бы|хочу|планирую|намерен[\p{L}]*|желаю\s+изуч|мечтаю/iu;
const learning = /изучаю|учусь|прохожу\s+курс|учебн[\p{L}]*|базов[\p{L}]*\s+уров/iu;
export function additionalEvidenceVerdict(requirement: string, status: string, quotes: string[]): { valid: boolean; reason?: "ambiguous_requirement" | "unverified_evidence" | "not_relevant" | "contradictory" | "future_intent" } {
  if (status === "unknown") return {valid:true};
  const clauses=requirementClausesV3(requirement),mandatory=clauses.filter(c=>!optionalRequirementV3.test(c));
  if (status === "not_met" && mandatory.length && mandatory.length<clauses.length)
    return additionalEvidenceVerdict(mandatory.join(" и "),status,quotes);
  const alternatives = requirement.split(/\s+или\s+/iu);
  if (alternatives.length > 1) {
    const results = alternatives.map(part => additionalEvidenceVerdict(part,status,quotes));
    return {valid:status === "not_met" ? results.every(r=>r.valid) : results.some(r=>r.valid),reason:"not_relevant"};
  }
  const terms = anchors(requirement);
  if (!terms.length) return {valid:false,reason:"ambiguous_requirement"};
  if (!quotes.length) return {valid:false,reason:"unverified_evidence"};
  const positive = new Set<number>(), denied = new Set<number>(), studying = new Set<number>(), intentions = new Set<number>();
  for (const quote of quotes) for (const sentence of quote.split(/[,;\n]|[.!?](?=\s|$)|\s+(?:но|однако|а|зато)\s+|\s+и\s+(?=не\s|нет(?=$|[^\p{L}])|без(?=$|[^\p{L}]))/iu))
    terms.forEach((term,index) => { for (const match of sentence.matchAll(new RegExp(term,"giu"))) {
      const context = sentence.slice(Math.max(0,match.index-70),match.index+match[0].length+70);
      if (intention.test(context)) intentions.add(index);
      else if (negative.test(context)) denied.add(index);
      else if (learning.test(context)) studying.add(index);
      else positive.add(index);
    }});
  if ([...positive].some(i=>denied.has(i))) return {valid:false,reason:"contradictory"};
  if (status === "not_met") return {valid:denied.size>0,reason:"not_relevant"};
  return {valid:status === "met" ? positive.size === terms.length && !denied.size && !studying.size
    : (positive.size>0 || studying.size>0) && !denied.size,reason:intentions.size ? "future_intent" : "not_relevant"};
}
