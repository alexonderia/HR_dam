// Mirrored by resume_evaluator/proof_policy.py; shared fixtures test both.
const stop=new Set("и или в во на по с со к ко от до для при из за о об а но не нет без опыт опыта работы работа наличие отсутствие знание знания навыки навык умение владение ищем нужен нужна требуется важен важна важны важно кандидат кандидата специалист сильный сильного желательно плюс приветствуется обязательно образование высшее получено лет года год месяцев месяц менее более как также его ее их это этой указанной успешное".split(" "));
const suffixes="иями ями ами ого ему ими ыми иями ениями ацией ации ация ацию иями остью остями ными ных ный ную ной ное ные ным ение ения ению ением ировать ировал ирую ирует ование ования ованию ание ания анию анием ительной ительную ствами ства ности ность ями ами ому его ыми ими ой ый ий ые ая яя ое ее ие ам ям ах ях ов ев ей ем ом ют ет ит ат ят ы а я у ю е и о ь".split(" ").sort((a,b)=>b.length-a.length);
export const proofNormalize=(s:string)=>s.toLowerCase().replaceAll("ё","е").trim().replace(/\s+/gu," ").replace(/б[эе]кенд[\p{L}]*|back[ -]?end/giu,"backend").replace(/высоконагруж[\p{L}]*|high[ -]?load/giu,"highload");
export function proofStem(w:string){w=proofNormalize(w);if(/[a-z0-9+#]/u.test(w))return w.replace(/[.-]+$/u,"");for(const s of suffixes)if(w.endsWith(s)&&w.length-s.length>=3){w=w.slice(0,-s.length);break;}return w.endsWith("ок")?w.slice(0,-2)+"к":w;}
export function proofTerms(s:string){return (proofNormalize(s).match(/1[сc]|\d+(?:\.\d+)+|[а-яё]+|\.?[a-z][a-z0-9+#.-]*/gu)||[]).filter(w=>!stop.has(w)&&w.length>1&&!/^(?:важн|предпочтител|стабильн|своевременн|сильн)/u.test(w)).map(proofStem);}
export function stopProof(requirement:string,status:string,quotes:string[]){
  const bounds=experienceConstraint(requirement);
  if(bounds&&!bounds.ambiguous){
    const values=quotes.filter(q=>/работ|стаж|опыт|разработ|developer|engineer/iu.test(q)&&!/возраст|мужчина|женщина|родил|years?\s+old/iu.test(q)).map(q=>experienceConstraint(q)?.minimum).filter((n):n is number=>n!=null);
    if(!values.length)return false;
    return values.every(v=>((bounds.minimum==null||(bounds.min_inclusive?v>=bounds.minimum:v>bounds.minimum))&&(bounds.maximum==null||(bounds.max_inclusive?v<=bounds.maximum:v<bounds.maximum)))===(status==="triggered"));
  }
  const core=requirement.replace(/^(?:нет|отсутствие|отсутствует|отказ\s+от|не\s+готов[\p{L}]*\s+к)\s*/iu,"");
  const opposite=(status==="triggered")===proofNegative(requirement);
  return statementProof(core,opposite?"not_met":"met",quotes).valid;
}
export function sameProofCondition(a:string,b:string){
 const x=experienceConstraint(a),y=experienceConstraint(b);
 if([...new Set(proofTerms(a))].sort().join("|")!==[...new Set(proofTerms(b))].sort().join("|"))return false;
 if(JSON.stringify(x)===JSON.stringify(y))return true;
 if(!x||!y)return false;
 return [[x,y],[y,x]].some(([lower,upper])=>lower.minimum!=null&&lower.maximum==null&&upper.maximum!=null&&upper.minimum==null&&lower.minimum===upper.maximum&&lower.min_inclusive!==upper.max_inclusive);
}

const escape=(s:string)=>s.replace(/[.*+?^${}()|[\]\\]/gu,"\\$&");
export function proofMatches(term:string,s:string):boolean{
  if(/[a-z0-9+#]/u.test(term)){const aliases=({sql:["sql","ms sql","t-sql","mssql"],"rest api":["rest api","restful api"],kubernetes:["kubernetes","k8s"]} as Record<string,string[]>)[term]||[term];return aliases.some(a=>new RegExp(`(?<![\\p{L}\\p{N}_])${escape(a)}(?![\\p{L}\\p{N}_])`,"u").test(proofNormalize(s)));}
  return proofTerms(s).some(t=>{let common=0;while(common<Math.min(t.length,term.length)&&t[common]===term[common])common++;return t===term||Math.min(t.length,term.length)>=5&&(t.startsWith(term)||term.startsWith(t))||common>=6;});
}
const negative=/(?<![\p{L}])(?:нет|без|отсутств[\p{L}]*|отказ[\p{L}]*|никогда|не\s+(?:зна[\p{L}]*|владе[\p{L}]*|име[\p{L}]*|работ[\p{L}]*|использ[\p{L}]*|уме[\p{L}]*|получ[\p{L}]*|окончи[\p{L}]*|готов[\p{L}]*|занима[\p{L}]*|провод[\p{L}]*|выполня[\p{L}]*))(?![\p{L}])/iu;
const intention=/(?<![\p{L}])(?:хочу|планиру[\p{L}]*|намерен[\p{L}]*|мечтаю|хотел[\p{L}]*\s+бы|желаем[\p{L}]*\s+должност[\p{L}]*|требования\s+работодателя)(?![\p{L}])/iu;
const learning=/(?<![\p{L}])(?:изучаю|изучает|учусь|обучаюсь|прохожу\s+курс|учебн[\p{L}]*|начальн[\p{L}]*\s+уров[\p{L}]*|начинающ[\p{L}]*|базов[\p{L}]*\s+уров[\p{L}]*)(?![\p{L}])/iu;
export const proofNegative=(s:string)=>negative.test(s);
export const proofIntention=(s:string)=>intention.test(s);
export const proofLearning=(s:string)=>learning.test(s);
export function proofStatements(s:string){
 const masked=s.replace(/(?<=[^\s.!?;:])\n(?=[ \t]*[а-яёa-z])(?![ \t]*(?:не(?![\p{L}])|нет(?![\p{L}])|без(?![\p{L}])|хочу(?![\p{L}])|планирую(?![\p{L}])|изучаю(?![\p{L}])|знаю(?![\p{L}])|владею(?![\p{L}])|работаю(?![\p{L}])|готов(?![\p{L}])))/gu," ");
 const clauses:string[]=[];let start=0;
 for(const boundary of masked.matchAll(/[;\n]|[.!?](?=\s|$)|\s+(?:но|однако|зато)\s+|,\s*(?=(?:(?:я|он|она)\s+)?(?:не\s+)?(?:работ|использ|владе|зна|уме|изуч|планир|готов|име|вед|состав|контрол|обеспеч))|\s+и\s+(?=не\s)/giu)){if(boundary.index>start)clauses.push(s.slice(start,boundary.index));start=boundary.index+boundary[0].length;}
 if(start<s.length)clauses.push(s.slice(start));return clauses;
}

export function statementProof(requirement:string,status:string,quotes:string[],semantic=false):{valid:boolean;reason?:"not_relevant"|"ambiguous_requirement"|"future_intent"|"contradictory"}{
  if(status==="unknown")return {valid:true};
  const alternatives=requirement.split(/\s+или\s+/iu);if(alternatives.length>1){const r=alternatives.map(p=>statementProof(p,status,quotes,semantic).valid);return {valid:status==="not_met"?r.every(Boolean):r.some(Boolean),reason:"not_relevant"};}
  const wanted=proofNormalize(requirement)==="rest api"?["rest api"]:[...new Set(proofTerms(requirement))];if(!wanted.length)return {valid:false,reason:"ambiguous_requirement"};
  const pos=new Set<number>(),neg=new Set<number>(),learn=new Set<number>(),intent=new Set<number>();
  for(const q of quotes)for(const clause of proofStatements(q)){
    if(/не\s+указан[\p{L}]*|нет\s+(?:сведений|данных|информации)|не\s+подтвержден[\p{L}]*/iu.test(clause))continue;
    wanted.forEach((t,i)=>{if(proofMatches(t,clause))(intention.test(clause)?intent:negative.test(clause)?neg:learning.test(clause)?learn:pos).add(i);});
  }
  if([...pos].some(i=>neg.has(i)))return {valid:false,reason:"contradictory"};
  if(status==="not_met")return {valid:neg.size>0,reason:"not_relevant"};
  const relevant=quotes.flatMap(proofStatements).filter(c=>wanted.every(t=>proofMatches(t,c)));
  if(status==="met"&&!/заяв[\p{L}]*|запрос[\p{L}]*/iu.test(requirement)&&relevant.length&&relevant.every(q=>/(?:заяв[\p{L}]*|запрос[\p{L}]*)[^.;]{0,80}(?:на|для)\s/iu.test(q)))return {valid:false,reason:"not_relevant"};
  if(status==="met"&&!/журнал[\p{L}]*|документ[\p{L}]*/iu.test(requirement)&&relevant.length&&relevant.every(q=>/(?:веден[\p{L}]*|веду)\s+журнал[\p{L}]*/iu.test(q)))return {valid:false,reason:"not_relevant"};
  for(const [wanted,actual] of [[/коммерческ[\p{L}]*/iu,/коммерческ[\p{L}]*|оплачиваем[\p{L}]*/iu],[/самостоятельн[\p{L}]*/iu,/самостоятельн[\p{L}]*|лично/iu]])if(status==="met"&&wanted.test(requirement)&&!quotes.some(q=>actual.test(q)))return {valid:false,reason:"not_relevant"};
  if(semantic&&wanted.some(t=>/[a-z0-9+#]/u.test(t)&&!quotes.some(q=>proofMatches(t,q))))return {valid:false,reason:"not_relevant"};
  if(status==="partial"&&!semantic&&wanted.filter(t=>/[а-я]/u.test(t)).length>=2&&!learn.size&&pos.size<Math.min(2,wanted.length))return {valid:false,reason:"not_relevant"};
  return {valid:status==="met"?(semantic?pos.size>0:pos.size===wanted.length)&&!neg.size&&!learn.size:(pos.size>0||learn.size>0)&&!neg.size,reason:intent.size?"future_intent":"not_relevant"};
}
export interface ExperienceConstraint{minimum?:number;maximum?:number;min_inclusive?:boolean;max_inclusive?:boolean;ambiguous?:boolean}
export function experienceConstraint(input:string):ExperienceConstraint|undefined{
  let s=proofNormalize(input);for(const [w,n]of Object.entries({одного:"1",двух:"2",трех:"3",четырех:"4",пяти:"5"}))s=s.replaceAll(w,n);
  s=s.replace(/от\s+(\d+(?:[.,]\d+)?)\s+до\s+(\d+(?:[.,]\d+)?)/gu,"$1–$2");
  const m=/(?<![\d.,])(\d+(?:[.,]\d+)?)\s*(?:[-–—]\s*(\d+(?:[.,]\d+)?)\s*)?(лет|года?|years?|месяц[\p{L}]*|months?)(?=$|[^\p{L}])/u.exec(s);if(!m)return;
  const scale=/^(?:лет|года?|years?)$/u.test(m[3])?12:1;let lo=Number(m[1].replace(",","."))*scale;if(!Number.isInteger(lo))return {ambiguous:true};
  if(!m[2]&&scale===12){const extra=/^\s*[,и]?\s*(\d+)\s*месяц[\p{L}]*/u.exec(s.slice(m.index+m[0].length));if(extra)lo+=Number(extra[1]);}
  if(m[2]){const hi=Number(m[2].replace(",","."))*scale;return !Number.isInteger(hi)||hi<lo?{ambiguous:true}:{minimum:lo,maximum:hi,min_inclusive:true,max_inclusive:true};}
  const before=s.slice(0,m.index);if(/(?:не\s+(?:более|больше)|максимум)\s*$/u.test(before))return {maximum:lo,max_inclusive:true};
  if(/не\s+(?:менее|меньше)\s*$/u.test(before))return {minimum:lo,min_inclusive:true};
  if(/(?:до|менее|меньше)\s*$/u.test(before))return {maximum:lo,max_inclusive:false};
  return {minimum:lo,min_inclusive:!/(?<!не )(?<!не  )(?:более|свыше|больше)\s*$/u.test(before)};
}
export function educationMetSupported(requirement:string,quotes:string[]):boolean {
  const education=/образован|высше|бакалавр|магистр|специалитет|bachelor|master|средне|колледж|техникум|университет|институт|аспирант|mba|диплом|квалификац/iu;
  const clauses=quotes.flatMap(proofStatements).filter(c=>education.test(c));
  if(!clauses.length||clauses.some(c=>proofIntention(c)||proofNegative(c)||proofLearning(c)))return false;
  const value=clauses.join(" ");
  if(!/окончил|окончила|окончен|завершил|завершила|завершен|получил|получила|получен|диплом|квалификац|бакалавр|магистр|специалитет|bachelor|master|mba/iu.test(value))return false;
  for(const level of [/магистр|master/iu,/бакалавр|bachelor/iu,/mba/iu])if(level.test(requirement)&&!level.test(value))return false;
  if(/высше/iu.test(requirement)&&!/высше|бакалавр|магистр|специалитет|bachelor|master/iu.test(value))return false;
  requirement=requirement.replace(/по\s+направлен[\p{L}]*|по\s+специальност[\p{L}]*/giu," ");
  const specific=requirement.replace(/образован[\p{L}]*|высше[\p{L}]*|бакалавр[\p{L}]*|магистр[\p{L}]*|специалитет|bachelor|master|средне[\p{L}]*|диплом[\p{L}]*|окончен[\p{L}]*|получен[\p{L}]*/giu," ");
  return proofTerms(specific).every(t=>proofMatches(t,quotes.join(" ")));
}

export interface SemanticReview {
 method:"focused-model-review-v1";status:"met"|"partial";action_matches:boolean;object_matches:boolean;responsibility_matches:boolean;evidence:string[];supported_text:string;
}
export function validSemanticReview(review:SemanticReview|undefined,status:string,evidence:{quote:string;block_id?:string}[],requirement=""):boolean {
 if(!review||review.method!=="focused-model-review-v1"||!["met","partial"].includes(status)||!["met","partial"].includes(review.status)||!review.object_matches)return false;
 if(status==="met"&&(review.status!=="met"||!review.action_matches||!review.responsibility_matches))return false;
 if(review.supported_text&&requirement&&!statementProof(requirement,review.status,[review.supported_text],true).valid)return false;
 if(!review.evidence.length||review.evidence.some(id=>!evidence.some(e=>e.block_id===id)))return false;
 return (review.status!=="partial"||!!review.supported_text)&&(!review.supported_text||evidence.some(e=>review.evidence.includes(e.block_id||"")&&e.quote.includes(review.supported_text)));
}
export function requestParticipation(requirement:string,quotes:string[]):string|undefined {
 if(/заяв[\p{L}]*|запрос[\p{L}]*|самостоятельн[\p{L}]*|лично|выполн[\p{L}]*|исполн[\p{L}]*|проведен[\p{L}]*|осуществ[\p{L}]*/iu.test(requirement))return;
 const wanted=[...new Set(proofTerms(requirement))];if(wanted.length<2)return;
 for(const quote of quotes)for(const clause of proofStatements(quote))
  if(/(?:заяв[\p{L}]*|запрос[\p{L}]*)[^.;]{0,80}(?:на|для)\s/iu.test(clause)&&wanted.every(t=>proofMatches(t,clause))&&!proofNegative(clause)&&!proofIntention(clause)&&!proofLearning(clause))return clause.trim();
}
