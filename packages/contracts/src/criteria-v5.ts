import {optionalRequirementV4} from './criteria.js';
export const optionalRequirementV5=new RegExp(optionalRequirementV4.source+'|преимуществен[\\p{L}]*|приоритет[\\p{L}]*','iu');
export function protectedText(text:string):string {
 const chars=text.split('');let quote:string|undefined,depth=0;
 for(let i=0;i<chars.length;i++){
  const c=text[i];
  if(quote){chars[i]=' ';if(c===quote)quote=undefined;}
  else if(['"','«','“'].includes(c)){quote=c==='«'?'»':c==='“'?'”':c;chars[i]=' ';}
  else if(c==='('){depth++;chars[i]=' ';}
  else if(depth){chars[i]=' ';if(c===')')depth--;}
 }
 return chars.join('');
}
export function requirementClausesV5(text:string):string[]{
 const masked=protectedText(text),result:string[]=[];let start=0;
 const pattern=/[;\n]+|\s+(?:и|а|но)\s+(?=желател)|(?<=[а-яa-z][а-яa-z][.!?])\s+|,\s*(?=(?:желател[\p{L}]*|предпочтител[\p{L}]*|преимуществен[\p{L}]*|приоритет[\p{L}]*|mba\s+приветству[\p{L}]*))/giu;
 for(const match of masked.matchAll(pattern)){const part=text.slice(start,match.index).trim();if(part)result.push(part);start=match.index+match[0].length;}
 const tail=text.slice(start).trim();if(tail)result.push(tail);return result;
}
export function conditionStructureV5(text:string):{operator:'atomic'|'all'|'any'|'ambiguous';parts:string[]} {
 const masked=protectedText(text),any=[...masked.matchAll(/\s+(?:или|либо)\s+/giu)],all=[...masked.matchAll(/\s+и\s+/giu)];
 if(/(?<![\p{L}])(?:если|кроме)(?![\p{L}])|при\s+условии|за\s+исключением/iu.test(masked)||any.length&&all.length)return {operator:'ambiguous',parts:[text]};
 const matches=any.length?any:all;if(!matches.length)return {operator:'atomic',parts:[text]};
 let start=0;let parts:string[]=[];
 for(const match of matches){parts.push(text.slice(start,match.index).trim());start=match.index+match[0].length;}
 parts.push(text.slice(start).trim());
 if(!any.length&&!parts.every(p=>/^(?:организац|контрол|руковод|распредел|планирован|подготов|состав|веден|проведен|настро|разработ|проверк|обеспеч|диагност|обслужив|ремонт)/iu.test(p))&&!parts.every(p=>/^[a-z0-9+# .:/-]+$/iu.test(p)))return {operator:"atomic",parts:[text]};
 if(any.length&&parts.length===2){
  const left=/^(.*?)([а-яё]+(?:ых|ого|ных|ной|ые|ного))$/iu.exec(parts[0]),right=/^([а-яё]+(?:ых|ого|ных|ной|ые|ного))\s+(.+)$/iu.exec(parts[1]);
  if(left&&right&&left[1].trim())parts=[left[1]+left[2]+' '+right[2],left[1]+right[1]+' '+right[2]];
 }
 return {operator:any.length?'any':'all',parts};
}
export function requirementListV5(text:string):string[]{
 text=text.trim();
 const result:string[]=[];
 // A sentence-ending dot is a separator; dots in .NET and Python 3.12 are not.
 const explicit=/[;\r\n]|\.(?=\s|;|$)/gu;
 const boundaries=[...text.matchAll(explicit)];
 const separators=boundaries.length?boundaries:[...text.matchAll(/(?<!\d),|,(?!\d)/gu)];
 let start=0;
 for(const match of separators){
  const part=text.slice(start,match.index).trim();if(part)result.push(part);
  start=match.index+match[0].length;
 }
 const tail=text.slice(start).trim();if(tail)result.push(tail);
 return result;
}

// Arrays already carry item boundaries. Retain an explicit separator when a
// saved comma-containing item is opened in the text editor, even if it is alone.
export function requirementListTextV5(items:readonly string[]):string {
 const text=items.join("\n");
 return items.length===1&&items[0].includes(",")?text+";":text;
}
