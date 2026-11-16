import assert from "node:assert/strict";
import {test} from "node:test";
import {readFileSync} from "node:fs";
import {additionalEvidenceVerdict,compileRatingCriteria,validateRankResponse,verifiedRatingView,ratingAnalysis} from "@hr/contracts";

const cases=JSON.parse(readFileSync(new URL("./python/fixtures/additional-proof-cases.json",import.meta.url),"utf8"));
const fixtures=JSON.parse(readFileSync(new URL("./fixtures/evidence-ratings-v3.json",import.meta.url),"utf8"));
test("additional evidence relevance agrees with shared Python cases",()=>{
  for(const c of cases) assert.equal(additionalEvidenceVerdict(c.requirement,c.status,c.quotes).valid,c.valid,c.name);
});
test("new policy separates an explicit bonus while preserving historical clause compilation",()=>{
  const p={comment:"Ищем сильного бэкендера для высоконагруженных систем. Плюс опыт с Kubernetes"};
  for(const version of ["evidence-v1","evidence-v2"] as const) assert.equal(compileRatingCriteria(p,"",version).length,1);
  const current=compileRatingCriteria(p,"","evidence-v3");
  assert.equal(current.length,2);assert.equal(current[0].optional,false);assert.equal(current[0].weight,10000);
  assert.equal(current[1].optional,true);assert.equal(current[1].weight,0);
  const technologies=compileRatingCriteria({comment:"Опыт .NET и C++. Плюс опыт с Kubernetes"},"","evidence-v3");
  assert.equal(technologies.length,2);assert.equal(technologies[0].requirement.includes(".NET и C++"),true);
});
test("Python evidence-v3 fixtures pass the API, including relevant confirmations, denials and optional facts",()=>{
  for(const f of fixtures) validateRankResponse(f.result,f.requirements);
});
function unsupported(status:"met"|"not_met",version:"evidence-v2"|"evidence-v3") {
  const f=structuredClone(fixtures.find((f:any)=>f.name==="additional_unrelated_confirmation"));
  const p=f.result.clusters[0].profiles[0],d=p.details,c=d.criteria[0];
  d.policy_version=version;c.status=status;c.credit=status==="met"?1:0;c.possible_credit=c.credit;delete c.unknown_reason;
  p.score=c.credit*100;d.score_range={min:p.score,max:p.score};d.coverage=100;d.score_status="evaluated";
  return f;
}
test("API rejects an irrelevant quotation even when forged v3 arithmetic is internally consistent",()=>{
  for(const status of ["met","not_met"] as const){const f=unsupported(status,"evidence-v3");assert.throws(()=>validateRankResponse(f.result,f.requirements));}
});
test("existing reports withdraw unsupported additional claims with consistent scores and immutable source records",()=>{
  for(const status of ["met","not_met"] as const){
    const f=unsupported(status,"evidence-v2"),original=f.result.clusters[0].profiles[0],before=structuredClone(original);
    validateRankResponse(f.result,f.requirements); // Historical contract remains readable.
    const checked=verifiedRatingView(original);
    assert.equal(checked.score,0);assert.equal(checked.details.criteria[0].status,"unknown");
    assert.equal(checked.details.criteria[0].unknown_reason,"not_relevant");
    assert.deepEqual(checked.details.score_range,{min:0,max:100});assert.equal(checked.details.coverage,0);
    assert.equal(ratingAnalysis(original).groups.find(g=>g.status===status)!.items.length,0);
    validateRankResponse({clusters:[{id:f.result.clusters[0].id,profiles:[checked]}]},f.requirements);
    assert.deepEqual(original,before);
  }
});
test("supported additional facts are retained and a missing bonus does not lower the mandatory score",()=>{
  const f=fixtures.find((f:any)=>f.name==="additional_bonus"),p=f.result.clusters[0].profiles[0];
  assert.equal(verifiedRatingView(p),p);assert.equal(p.score,100);
  assert.equal(p.details.criteria[1].status,"unknown");assert.equal(p.details.criteria[1].weight,0);
});
