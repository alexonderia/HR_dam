import { clarificationSources, groupRatingClarifications, type ratingAnalysis } from "@hr/contracts";

export function RatingClarifications({ items }: { items: ReturnType<typeof ratingAnalysis>["clarifications"] }) {
  if (!items.length) return null;
  const sources = clarificationSources(items);
  return <details className="rating-sources rating-clarifications" open>
    <summary>Требуют уточнения ({items.length})</summary>
    <div className="rating-clarification-groups">{groupRatingClarifications(items).map(group => <section key={JSON.stringify([group.reason, group.question])}>
      <p>{group.reason}.</p>
      <ul className="rating-item-list">{group.items.map(item => <li key={item.id}>
        <span className="af-caption">{item.category}</span>
        <strong>{item.requirement}</strong>
        {item.optional && <p className="rating-item-notes">Желательное требование, на балл не влияет.</p>}
      </li>)}</ul>
    </section>)}</div>
    {!!sources.length && <details className="rating-sources rating-clarification-sources">
      <summary>Цитаты из резюме ({sources.length})</summary>
      {sources.map(source => <figure key={source.quote}>
        <figcaption>К уточнениям: {source.requirements.join(", ")}</figcaption>
        <blockquote>{source.quote}</blockquote>
      </figure>)}
    </details>}
  </details>;
}
