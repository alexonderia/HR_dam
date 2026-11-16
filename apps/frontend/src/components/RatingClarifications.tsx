import { clarificationSources, groupRatingClarifications, type ratingAnalysis } from "@hr/contracts";

export function RatingClarifications({ items, expanded = false }: { items: ReturnType<typeof ratingAnalysis>["clarifications"]; expanded?: boolean }) {
  if (!items.length) return null;
  const sources = clarificationSources(items);
  return <details className="rating-sources rating-clarifications" open={expanded}>
    <summary>Что уточнить у кандидата или HR ({items.length})</summary>
    <div className="rating-clarification-groups">{groupRatingClarifications(items).map(group => <section key={JSON.stringify([group.reason, group.question])}>
      <p>{group.reason}. {group.question}</p>
      <ul className="rating-item-list">{group.items.map(item => <li key={item.id}>
        <strong>{item.requirement}</strong>
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
