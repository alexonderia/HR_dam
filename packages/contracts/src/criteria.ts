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
export const optionalRequirementV4=new RegExp(optionalRequirementV3.source+"|предпочтител[\\p{L}]*","iu");
export function requirementClausesV4(text:string):string[]{
  if(/(?<![\p{L}])(?:если|кроме)(?![\p{L}])|при\s+условии|за\s+исключением/iu.test(text))return text.trim()?[text.trim()]:[];
  return text.replace(/\s+(?:и|а|но)\s+(?=(?:желател[\p{L}]*|предпочтител[\p{L}]*|приветству[\p{L}]*|будет\s+плюсом|не\s+обязател[\p{L}]*))/giu,";")
    .split(/(?<=[а-яa-z][а-яa-z][.!?])\s+|[;\n]+|(?<!\d),|,(?!\d)/iu).map(p=>p.trim()).filter(Boolean);
}

export function conditionStructure(text:string){
  const all=text.split(/\s+и\s+/iu),any=text.split(/\s+или\s+/iu);
  const ambiguous=/(?<![\p{L}])(?:если|кроме)(?![\p{L}])|при\s+условии|за\s+исключением/iu.test(text)||all.length>1&&any.length>1;
  const operator=ambiguous?"ambiguous":all.length>1?"all":any.length>1?"any":"atomic";
  return {operator,parts:operator==="all"?all:operator==="any"?any:[text]};
}

export function requirementList(text:string):string[]{
 return text.split(/(?<!\d),|,(?!\d)|[;\n]+/u).map(s=>s.trim()).filter(Boolean);
}
