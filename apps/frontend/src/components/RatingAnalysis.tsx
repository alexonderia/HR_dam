import { ratingAnalysis, type ReportRating } from "@hr/contracts";
import { CompactRatingAnalysis } from "./CompactRatingAnalysis";

export function RatingAnalysis({ rating, compact = false }: { rating: ReportRating; compact?: boolean }) {
  const analysis = ratingAnalysis(rating), knownStops = analysis.stops.filter(stop => stop.state !== "unknown");
  if (compact) return <CompactRatingAnalysis rating={rating} analysis={analysis} />;
  const hasCriteria = analysis.groups.some(group => group.items.length);
  return <div className="rating-explanation rating-analysis">
    {analysis.evidence && <section className="rating-overview" aria-label="Дополнительные показатели">
      <dl className="rating-metrics">
        <div><dt>Диапазон оценки</dt><dd>{analysis.range} из 100</dd></div>
        <div><dt>Охват критериев</dt><dd>{analysis.evidence.coverage.toLocaleString("ru-RU")}%</dd></div>
      </dl>
      {analysis.evidence.context_truncated && <p className="af-alert af-alert--warning">Оценён только фрагмент резюме.</p>}
    </section>}
    <section className="rating-rationale">
      <h5>Обоснование оценки</h5>
      <p className="explanation-text">{rating.explanation?.trim() ? rating.explanation : "Обоснование не указано."}</p>
    </section>
    {hasCriteria && <section className="rating-requirements">
      <h5>Проверка требований</h5>
      {analysis.groups.filter(group => group.items.length).map(group => <div className={`rating-group rating-group--${group.status}`} key={group.status}>
        <h6>{group.title}<span className="rating-group-count">{group.items.length}</span></h6>
        <ul className="rating-item-list">{group.items.map((item, index) => <li key={index}>
          <span className="af-caption">{item.category}</span><strong>{item.requirement}</strong>
          {!!item.notes.length && <p className="rating-item-notes">{item.notes.join(" ")}</p>}
          {!!item.quotes.length && <blockquote>{item.quotes.join("\n")}</blockquote>}
        </li>)}</ul>
      </div>)}
    </section>}
    {!!analysis.skills.length && <section className="rating-skills">
      <h5>Навыки</h5>
      {analysis.skills.map(group => <div key={group.status} className={`rating-skill-group rating-skill-group--${group.status}`}>
        <span className="af-caption">{group.title}</span>
        <div className="tags">{group.items.map((skill, i) => <span className="af-badge tag" key={i}>{skill.requirement}</span>)}</div>
        {group.items.some(skill => skill.quotes.length) && <details className="rating-sources"><summary>Цитаты из резюме</summary>{group.items.map((skill, i) => <blockquote key={i}>{skill.quotes.join("\n")}</blockquote>)}</details>}
      </div>)}
    </section>}
    {!!analysis.missing.length && <section className="rating-missing">
      <dl>{analysis.missing.map(field => <div key={field.label}><dt>{field.label}</dt><dd>Не указано</dd></div>)}</dl>
    </section>}
    <section className={`rating-stops rating-stops--${knownStops.some(stop => stop.state === "triggered") ? "triggered" : knownStops.length ? "not_triggered" : "unknown"}`}>
      <h5>Стоп-факторы</h5>
      {knownStops.length ? <ul className="rating-item-list">{knownStops.map((stop, index) => <li key={index}>
        <strong>{stop.requirement}</strong><p>{stop.status}. {stop.notes}</p>
        {!!stop.quotes.length && <blockquote>{stop.quotes.join("\n")}</blockquote>}
      </li>)}</ul> : <p>{analysis.stops.length ? "Не указано" : rating.triggered_stop_factors?.join("; ") || "Не заданы"}</p>}
    </section>
  </div>;
}
