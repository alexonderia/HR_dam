import {proofTerms,proofMatches,statementProof,proofStatements,proofNegative,proofIntention,proofLearning,educationMetSupported,experienceConstraint} from './proof-policy.js';
import {conditionStructureV5} from './criteria-v5.js';
export type ExperienceScope={role:string;anchors:string[]};
export function durationTerms(text:string){return proofTerms(text).filter(t=>!/^(?:стаж|общ|коммерческ|миним|максим|сфер|недостат|трех|двух|четыр|пят|одног|профессиональн|профильн)/u.test(t));}
export function durationScope(requirement:string,profile:{position_name?:string;name?:string;keywords?:string[]}):ExperienceScope|undefined {
 if(!experienceConstraint(requirement)||durationTerms(requirement).length)return;
 return {role:profile.position_name||profile.name||'',anchors:[...new Set(profile.keywords||[])]};
}
function positiveAnchor(wanted:string[],text:string){
 const positive=new Set<number>(),negative=new Set<number>();
 for(const clause of proofStatements(text))wanted.forEach((t,i)=>{if(proofMatches(t,clause)){if(proofNegative(clause))negative.add(i);else if(!proofIntention(clause)&&!proofLearning(clause))positive.add(i);}});
 return wanted.length>0&&positive.size===wanted.length&&!negative.size;
}
export function scopeMatches(requirement:string,scope:ExperienceScope|undefined,text:string):boolean {
 const wanted=durationTerms(requirement);
 if(wanted.length){const c=conditionStructureV5(requirement);return c.operator==='any'?c.parts.some(p=>positiveAnchor(durationTerms(p),text)):positiveAnchor(wanted,text);}
 if(!scope)return false;
 const role=scope.role.replace(/(?<![\p{L}])developer(?![\p{L}])/giu,'разработчик'),c=conditionStructureV5(role);
 if((c.operator==='any'&&c.parts.some(p=>positiveAnchor(durationTerms(p),text)))||positiveAnchor(durationTerms(role),text))return true;
 const anchors=scope.anchors.filter(a=>durationTerms(a).length);
 return anchors.length>=2&&anchors.every(a=>assertionProof(a,'met',[text]))&&/работ|разработ|выполня|использ|примен|руковод|контрол|организ/iu.test(text);
}

export function ambiguousRolePeriod(requirement:string,scope:ExperienceScope|undefined,context:string):boolean {
 if(!/нач(?:ал|инал)[\p{L}]*[^.\n]{0,100}(?:карьер|работ)|затем[^.\n]{0,60}(?:назнач|стал)|недавно[^.\n]{0,60}(?:назнач|стал)/iu.test(context))return false;
 const target=durationTerms(requirement).length?requirement:scope?.role||'';
 if(/руковод|начальник|бригадир|директор|мастер|менеджер|управлен/iu.test(target))return true;
 return [...context.matchAll(/(?:затем[^.\n]{0,30}(?:назначен|стал)|недавно[^.\n]{0,30}(?:назначен|стал)|начал\s+(?:карьеру|работу))\s+([^.;\n]{3,90})/giu)].some(m=>scopeMatches(target,undefined,m[1]));
}

export function assertionProof(requirement:string,status:string,quotes:string[],condition=conditionStructureV5(requirement),semantic=false):boolean {
 if(status==='unknown')return true;
 if(status==='partial'&&/самостоятельн|лично/iu.test(requirement)&&!quotes.some(q=>/самостоятельн|лично/iu.test(q)))return false;
 if(condition.operator==='ambiguous')return false;
 if(condition.operator==='any'){const values=condition.parts.map(p=>statementProof(p,status,quotes,semantic).valid);return status==='not_met'?values.every(Boolean):values.some(Boolean);}
 if(condition.operator==='all'){const values=condition.parts.map(p=>statementProof(p,status,quotes,semantic).valid);return status==='met'?values.every(Boolean):values.some(Boolean);}
 if(status==='met'&&!semantic)return quotes.flatMap(proofStatements).some(clause=>statementProof(requirement,status,[clause],false).valid);
 return statementProof(requirement,status,quotes,semantic).valid;
}
export function educationProof(requirement:string,status:string,quotes:string[],condition=conditionStructureV5(requirement)):boolean {
 if(status==='unknown')return true;if(condition.operator==='ambiguous')return false;
 const parts=condition.operator==='any'?condition.parts:[requirement];
 if(status==='met')return parts.some(p=>educationMetSupported(p,quotes));
 const relevant=quotes.flatMap(proofStatements).filter(c=>/образован|высше|бакалавр|магистр|специалитет|bachelor|master|средне|колледж|техникум|университет|институт|аспирант|mba|диплом|квалификац/iu.test(c));
 if(status==='partial')return relevant.some(c=>proofLearning(c)||/учусь|обучаюсь|студент|неокончен|незакончен/iu.test(c));
 return parts.length>0&&parts.every(part=>{const wanted=durationTerms(part.replace(/образован[\p{L}]*|высше[\p{L}]*|средне[\p{L}]*|профессиональн[\p{L}]*/giu,''));const levels=/высш|бакалавр|магистр/iu.test(part)?/высш|бакалавр|магистр/iu:/средн|колледж|техникум/iu;
  return relevant.some(c=>proofNegative(c)&&!proofIntention(c)&&(wanted.length?wanted.every(t=>proofMatches(t,c)):levels.test(c)));});
}
export function professionalBasis(criteria:{id:string;optional:boolean;category:string;status:string;credit:number}[]){
 const core=criteria.filter(c=>!c.optional&&c.category!=='education');const ids=core.filter(c=>['met','partial'].includes(c.status)&&c.credit>0).map(c=>c.id);
 return {status:ids.length?'confirmed':core.length?'unconfirmed':'not_configured',criteria_ids:ids};
}

export function professionalContext(requirement:string,scope:ExperienceScope|undefined,quotes:string[],condition=conditionStructureV5(requirement)):boolean{
 if(!scope)return true;
 if(condition.operator==='any'||condition.operator==='all'){
  const checks=condition.parts.map(p=>professionalContext(p,scope,quotes,{operator:'atomic',parts:[p]}));
  return condition.operator==='any'?checks.some(Boolean):checks.every(Boolean);
 }
 const qualifiers=proofTerms(requirement).filter(t=>scope.anchors.some(a=>proofMatches(t,a)));
 return qualifiers.every(t=>quotes.some(q=>positiveAnchor([t],q)));
}
