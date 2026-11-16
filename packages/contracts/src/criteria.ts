// Keep fixtures shared with resume_evaluator.criteria; no LLM clause rewriting.
export const optionalRequirement = /желател[\p{L}]*|приветству[\p{L}]*|будет\s+плюсом|не\s+обязател[\p{L}]*/iu;
export function requirementClauses(text: string): string[] {
  return text.replace(/\s+(?:и|а|но)\s+(?=(?:желател[\p{L}]*|приветству[\p{L}]*|будет\s+плюсом|не\s+обязател[\p{L}]*))/giu, ";")
    .split(/[,;\n]+/u).map(part => part.trim()).filter(Boolean);
}
export const optionalRequirementV3 = new RegExp(optionalRequirement.source + "|(?:^|[.!?;\\n]\\s*)плюс(?=$|[^\\p{L}])", "iu");
export function requirementClausesV3(text: string): string[] {
  return requirementClauses(text.replace(/(?<=[.!?])\s+(?=(?:плюс(?=$|[^\p{L}])|желател[\p{L}]*|приветству[\p{L}]*|будет\s+плюсом|не\s+обязател[\p{L}]*))/giu, ";")
    .replace(/\s+(?=плюс\s)/giu, ";"));
}
