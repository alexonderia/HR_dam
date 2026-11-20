import assert from "node:assert/strict";
import {test} from "node:test";
import {readFileSync} from "node:fs";
import {statementProof,experienceConstraint,validateEvidenceRating,ratingScoreText,compileRatingCriteria} from "@hr/contracts";
const cases=JSON.parse(readFileSync(new URL("./python/fixtures/proof-policy-v4.json",import.meta.url),"utf8"));
const fixtures=JSON.parse(readFileSync(new URL("./fixtures/evidence-ratings-v4.json",import.meta.url),"utf8"));
test("v4 statement guards agree with shared audit regressions",()=>{
 for(const c of cases)assert.equal(statementProof(c.requirement,c.status,c.quotes).valid,c.valid,c.name);
});
test("v4 Python arithmetic and proofs pass the independent API validator",()=>{
 for(const c of fixtures)assert.doesNotThrow(()=>validateEvidenceRating(c.rating,c.profile),c.name);
});
test("v4 exact duplicates retain provenance without extra weight",()=>{
 const c=compileRatingCriteria({keywords:["SQL","SQL","Python"],comment:"SQL"});
 assert.equal(c.length,2);assert.equal(c[0].weight,5000);assert.equal(c[0].origins?.length,3);
});
test("v4 bounds preserve the operator and decimal units",()=>{
 assert.deepEqual(experienceConstraint("не менее 2 лет"),{minimum:24,min_inclusive:true});
 assert.deepEqual(experienceConstraint("до 3 лет"),{maximum:36,max_inclusive:false});
 assert.deepEqual(experienceConstraint("от 1 до 3 лет"),{minimum:12,maximum:36,min_inclusive:true,max_inclusive:true});
 assert.equal(experienceConstraint("2,5 года")?.minimum,30);
});
test("empty v4 criteria have an undefined score presentation",()=>{
 const c=fixtures.find((c:any)=>c.rating.details.score_status==="not_defined");
 assert.equal(ratingScoreText(c.rating),"Оценка не определена");
});

test("numeric duplicate suppression compares operators and profession scope",async()=>{
 const {sameProofCondition}=await import("@hr/contracts");
 assert.equal(sameProofCondition("От 3 лет Python","Опыт менее 3 лет Python"),true);
 assert.equal(sameProofCondition("Опыт не более 3 лет Python","Опыт менее 3 лет Python"),false);
 assert.equal(sameProofCondition("От 3 лет Python","Опыт менее 3 лет бухгалтером"),false);
});
