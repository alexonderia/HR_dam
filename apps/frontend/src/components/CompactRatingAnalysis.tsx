import { AlertCircle, CheckCircle2, CircleMinus, XCircle } from "lucide-react";
import { ratingAnalysis, type ReportRating } from "@hr/contracts";

type Analysis = ReturnType<typeof ratingAnalysis>;
const icons = { met: CheckCircle2, partial: AlertCircle, not_met: XCircle, unknown: CircleMinus };

export function CompactRatingAnalysis({ rating, analysis }: { rating: ReportRating; analysis: Analysis }) {
  const knownStops = analysis.stops.filter(stop => stop.state !== "unknown");
  const stopState = knownStops.some(stop => stop.state === "triggered") ? "not_met" : knownStops.length ? "met" : "unknown";
  const StopIcon = icons[stopState];
  const quotes = [...new Set(analysis.evidence?.criteria.filter(criterion => criterion.status !== "unknown")
    .flatMap(criterion => criterion.evidence.map(evidence => evidence.quote)) || [])];
  return <div className="rating-explanation rating-analysis rating-analysis--compact">
    <div className={`rating-summary ${analysis.evidence ? "" : "rating-summary--text-only"}`}>
      <section className="rating-rationale">
        <h4>Обоснование оценки</h4>
        <p className="explanation-text">{rating.explanation?.trim() ? rating.explanation : "Обоснование не указано."}</p>
        {!!quotes.length && <figure className="rating-highlight-quote"><blockquote>{quotes[0]}</blockquote><figcaption>
          <span>Цитата из резюме</span>
          {quotes.length > 1 && <details className="rating-sources rating-all-sources"><summary>Все цитаты</summary>
            {analysis.evidence?.criteria.filter(criterion => criterion.status !== "unknown" && criterion.evidence.length).map(criterion => <div key={criterion.id}>
              <strong>{criterion.requirement}</strong>{criterion.evidence.map((evidence, index) => <blockquote key={index}>{evidence.quote}</blockquote>)}
            </div>)}
          </details>}
        </figcaption></figure>}
      </section>
      {analysis.evidence && <section className="rating-overview" aria-label="Дополнительные показатели">
        <dl className="rating-metrics">
          <div><dt>Диапазон оценки</dt><dd>{analysis.range} из 100</dd></div>
          <div><dt>Охват критериев</dt><dd>{analysis.evidence.coverage.toLocaleString("ru-RU")}%</dd><p className="rating-metric-help">Доля веса оценённых требований</p></div>
        </dl>
        {analysis.evidence.context_truncated && <p className="af-alert af-alert--warning">Оценён только фрагмент резюме.</p>}
      </section>}
    </div>
    <div className="rating-findings">
      <h4 className="sr-only">Проверка требований</h4>
      {analysis.groups.map(group => {
        const skills = analysis.skills.find(skillGroup => skillGroup.status === group.status);
        if (!group.items.length && !skills) return null;
        const Icon = icons[group.status];
        return <section className={`rating-finding rating-finding--${group.status}`} key={group.status}>
          <h5 className="rating-finding-label"><span className="rating-state"><Icon size={18} aria-hidden="true" />{analysis.evidence ? group.title : skills?.title || group.title}</span></h5>
          <div className="rating-finding-content">
            {!!group.items.length && <ul className="rating-item-list">{group.items.map((item, index) => <li key={index}>
              <span className="sr-only">{item.category}</span><strong>{item.requirement}</strong>
              {!!item.notes.length && <p className="rating-item-notes">{item.notes.join(" ")}</p>}
            </li>)}</ul>}
            {skills && <div className={`rating-skill-group rating-skill-group--${skills.status}`}>
              <span className="sr-only">Навыки</span>
              <div className="tags">{skills.items.map((skill, index) => <span className="af-badge tag" key={index}>{skill.requirement}</span>)}</div>
            </div>}
          </div>
        </section>;
      })}
      {analysis.missing.map(field => <section className="rating-missing" key={field.label}><dl><div className="rating-finding rating-finding--unknown">
        <dt className="rating-finding-label"><span className="rating-state"><CircleMinus size={18} aria-hidden="true" />{field.label}</span></dt><dd className="rating-finding-content">Не указано</dd>
      </div></dl></section>)}
      <section className={`rating-finding rating-stops rating-finding--${stopState}`}>
        <h5 className="rating-finding-label"><span className="rating-state"><StopIcon size={18} aria-hidden="true" />Стоп-факторы</span></h5>
        <div className="rating-finding-content">{knownStops.length ? <ul className="rating-item-list">{knownStops.map((stop, index) => <li key={index}>
          <strong>{stop.requirement}</strong><p>{stop.status}. {stop.notes}</p>
          {!!stop.quotes.length && <details className="rating-sources"><summary>Основание</summary><blockquote>{stop.quotes.join("\n")}</blockquote></details>}
        </li>)}</ul> : <p>{analysis.stops.length ? "Не указано" : rating.triggered_stop_factors?.join("; ") || "Не заданы"}</p>}</div>
      </section>
    </div>
  </div>;
}
