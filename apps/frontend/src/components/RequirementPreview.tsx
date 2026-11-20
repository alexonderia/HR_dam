import { compileRatingCriteria, proofTerms } from "@hr/contracts";

type Profile = Parameters<typeof compileRatingCriteria>[0];
export function RequirementPreview({ profile, clusterComment = "" }: { profile: Profile; clusterComment?: string }) {
  const criteria = compileRatingCriteria(profile, clusterComment);
  const mandatory = criteria.filter(c => !c.optional);
  const duplicates = criteria.reduce((n, c) => n + Math.max(0, (c.origins?.length || 1) - 1), 0);
  const samples=criteria.slice(0,200).map(c=>({criterion:c,terms:new Set(proofTerms(c.requirement))}));
  const possibleDuplicates:string[]=[];
  for(let i=0;i<samples.length&&possibleDuplicates.length<10;i++)for(let j=i+1;j<samples.length&&possibleDuplicates.length<10;j++){
    const a=samples[i],b=samples[j];
    const shared=[...a.terms].filter(t=>b.terms.has(t)).length;
    if(shared>=2&&shared/Math.max(a.terms.size,b.terms.size)>=.75)
      possibleDuplicates.push(`${a.criterion.requirement} / ${b.criterion.requirement}`);
  }
  const ambiguous = criteria.filter(c => c.condition?.operator === "ambiguous");
  return <div className="af-field">
    {!mandatory.length ? <p role="status">Нет обязательных условий: оценка не будет определена. Стоп-факторы проверяются отдельно.</p>
      : mandatory.length < 3 ? <p role="status">Указано мало условий. Высокая оценка означает совпадение только с этими требованиями.</p> : null}
    {!!ambiguous.length && <p role="status">Уточните условия со смешанными «и / или» или оговорками. Они останутся на уточнении до изменения формулировки.</p>}
    {!!criteria.length && <details><summary>Проверить разбор требований ({criteria.length})</summary>
      <p>Основные условия влияют на балл. Желательные проверяются отдельно. Смысловые повторы проверьте вручную.</p>
      {!!duplicates && <p>Точные повторы объединены: {duplicates}. Их вес учитывается один раз.</p>}
      {!!possibleDuplicates.length && <div><p>Возможные смысловые повторы — проверьте область, уровень и обязательность:</p><ul>{possibleDuplicates.map(pair=><li key={pair}>{pair}</li>)}</ul></div>}
      <ol>{criteria.map(c => <li key={c.id}>{c.requirement} — {c.optional ? "желательное" : "основное"}
        {c.condition?.operator === "all" ? "; нужны все части" : c.condition?.operator === "any" ? "; достаточно любого варианта" : c.condition?.operator === "ambiguous" ? "; требуется уточнение логики" : ""}
      </li>)}</ol>
    </details>}
  </div>;
}
