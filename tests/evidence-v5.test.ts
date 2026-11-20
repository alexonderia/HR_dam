import assert from 'node:assert/strict';
import {test} from 'node:test';
import {readFileSync} from 'node:fs';
import {validateEvidenceRating,compileRatingCriteria,assertionProof,educationProof} from '@hr/contracts';
const fixtures=JSON.parse(readFileSync(new URL('./fixtures/evidence-ratings-v5.json',import.meta.url),'utf8'));
test('v5 Python scores and full profile clauses pass independent API checks',()=>{
 for(const c of fixtures)assert.doesNotThrow(()=>validateEvidenceRating(c.rating,c.profile),c.name);
});
test('backend general years never count as professional evidence',()=>{
 const c=fixtures.find((c:any)=>c.name==='full_Backend');
 assert.equal(c.rating.score,0);assert.equal(c.rating.details.professional_basis.status,'unconfirmed');
 const copy=structuredClone(c.rating);copy.score=52.94;copy.details.score_range.min=52.94;
 assert.throws(()=>validateEvidenceRating(copy,c.profile));
 const changed=structuredClone(c.rating);changed.details.general_experience_months++;
 assert.throws(()=>validateEvidenceRating(changed,c.profile));
});
test('v5 verifies both negative and positive nonnumeric experience claims',()=>{
 const c=fixtures.find((c:any)=>c.name==='full_Руководитель производственного подразделения');
 const duty=c.rating.details.criteria.find((c:any)=>c.requirement.startsWith('Контроль технического'));
 assert.equal(duty.status,'met');
 const copy=structuredClone(c.rating);copy.details.criteria.find((c:any)=>c.id===duty.id).status='not_met';
 assert.throws(()=>validateEvidenceRating(copy,c.profile));
 assert.equal(educationProof('Высшее','not_met',['Нет детей. Не женат.']),false);
 assert.equal(assertionProof('Контроль качества кода','met',['Контроль качества складских отгрузок. Код изучаю.']),false);
});
test('bare tenure has the same profile scope in internal and HTTP targets',()=>{
 const internal=compileRatingCriteria({position_name:'Backend',keywords:['Python'],experience:'от 3 лет'});
 const target=compileRatingCriteria({name:'Backend',keywords:['Python'],experience:'от 3 лет'});
 assert.deepEqual(internal,target);
});
test('one transferable technology is insufficient to claim years in another role',async()=>{
 const{scopeMatches}=await import('@hr/contracts');
 const scope={role:'Backend',anchors:['Python','SQL','Rest API']};
 assert.equal(scopeMatches('от 3 лет',scope,'Водитель. Использовал SQL для транспортных отчётов.'),false);
 assert.equal(scopeMatches('от 3 лет',scope,'Backend-разработчик. Разработка серверных приложений.'),true);
});
test('professional qualifiers cannot be waived by a semantic paraphrase',async()=>{
 const{professionalContext}=await import('@hr/contracts');
 const scope={role:'Инженер-строитель',anchors:['строительное производство','управление строительством']};
 assert.equal(professionalContext('Строительство и реконструкция промышленных объектов.',scope,['Организация работы колонны на объекте.']),false);
 assert.equal(professionalContext('Управление строительными бригадами.',scope,['Управлял бригадой водителей.']),false);
});
