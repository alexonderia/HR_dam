import {createContext,useContext} from "react";
import { AlertCircle, CheckCircle2, XCircle } from "lucide-react";
import { clarificationSources, ratingAnalysis, type ReportRating } from "@hr/contracts";
import { RatingClarifications } from "./RatingClarifications";

const SourceLocations=createContext<{quote:string;start:number;end:number;page?:number}[]>([]);
type Analysis = ReturnType<typeof ratingAnalysis>;
const statusIcons = { not_met: XCircle, partial: AlertCircle, met: CheckCircle2 };
const statusOrder = ["not_met", "partial", "met"] as const;

function RatingSources({ items }: { items: { quotes: string[]; requirement?: string }[] }) {
  const locations=useContext(SourceLocations);
  const sources = clarificationSources(items.map(item => ({ requirement: item.requirement || "", quotes: item.quotes })));
  if (!sources.length) return null;
  return <details className="rating-sources">
    <summary>Цитаты из резюме</summary>
    {sources.map(source => <figure key={source.quote}>
      {source.requirements.some(Boolean) && <figcaption>{source.requirements.join(", ")}</figcaption>}
      <blockquote>{source.quote}</blockquote>
      <figcaption>{[...new Set(locations.filter(e=>e.quote.includes(source.quote)).map(e=>`${e.page?`Страница ${e.page}, `:""}символы ${e.start}–${e.end}`))].join("; ")}</figcaption>
    </figure>)}
  </details>;
}

function RatingStops({ stops, legacyStops }: { stops: Analysis["stops"]; legacyStops: string[] }) {
  const triggered = stops.filter(stop => stop.state === "triggered");
  const cleared = stops.filter(stop => stop.state === "not_triggered");
  if (!triggered.length && !cleared.length && !legacyStops.length) return null;
  const alertClass = triggered.length || legacyStops.length ? " rating-finding--not_met" : "";
  return <section className={`rating-finding rating-stops${alertClass}`}>
    <h5 className="rating-finding-label"><span className="rating-state">Стоп-факторы</span></h5>
    <div className="rating-finding-content">
      {(triggered.length > 0 || legacyStops.length > 0) && <ul className="rating-item-list">
        {triggered.map((stop, index) => <li key={index}>
          <strong>{stop.requirement}</strong>
          <p className="rating-item-notes">{stop.status}. {stop.notes}</p>
          <RatingSources items={[{ quotes: stop.quotes }]} />
        </li>)}
        {legacyStops.map((stop, index) => <li key={index}><strong>{stop}</strong></li>)}
      </ul>}
      {cleared.length > 0 && <details className="rating-cleared-stops">
        <summary>Не сработали ({cleared.length})</summary>
        <ul className="rating-item-list">
          {cleared.map((stop, index) => <li key={index}>
            <strong>{stop.requirement}</strong>
            <RatingSources items={[{ quotes: stop.quotes }]} />
          </li>)}
        </ul>
      </details>}
    </div>
  </section>;
}

export function RatingAnalysis({ rating }: { rating: ReportRating }) {
  const { evidence, estimate, groups, skills, clarifications, stops, policyNote, completeness, reviewNote, professionalNote, generalExperienceNote } = ratingAnalysis(rating);
  const legacyExplanation = !evidence && rating.explanation?.trim();
  const legacyStops = evidence ? [] : rating.triggered_stop_factors || [];
  const hasTriggeredStops = legacyStops.length > 0 || stops.some(stop => stop.state === "triggered");
  const stopFindings = <RatingStops stops={stops} legacyStops={legacyStops} />;
  const showRange = evidence && estimate && !estimate.insufficient && evidence.score_range.min !== evidence.score_range.max;
  const warning = evidence?.score_status==="not_defined"?"Оценка не определена: нет обязательных условий.":evidence?.context_truncated ? "Оценён только фрагмент резюме."
    : estimate?.insufficient ? "Недостаточно сведений для полной оценки." : "";
  const hasFindings = groups.some(group => group.items.length > 0) || skills.length > 0 || clarifications.length > 0;
  if (!showRange && !warning && !legacyExplanation && !hasFindings && !hasTriggeredStops && !stops.length) return null;

  return <SourceLocations.Provider value={evidence?[...evidence.criteria,...evidence.stop_factors].flatMap(c=>c.evidence):[]}><div className="rating-explanation rating-analysis">
    {(showRange || warning) && <div className="rating-overview">
      {showRange && <dl className="rating-metrics"><dt>{estimate.label}</dt><dd>{estimate.value} из 100</dd></dl>}
      {warning && <p className="rating-metric-help">{warning}</p>}
    </div>}
    {evidence && <p className="af-caption">{policyNote} {completeness}</p>}
    {professionalNote && <p className="rating-metric-help">{professionalNote}</p>}
    {generalExperienceNote && <p className="af-caption">{generalExperienceNote}</p>}
    {reviewNote && <p className="rating-metric-help">{reviewNote}</p>}
    {legacyExplanation && <section className="rating-rationale">
      <h5>Обоснование оценки</h5>
      <p className="explanation-text">{legacyExplanation}</p>
    </section>}
    {hasTriggeredStops && stopFindings}
    {statusOrder.map(status => {
      const group = groups.find(group => group.status === status);
      const skillGroup = skills.find(group => group.status === status);
      if (!group?.items.length && !skillGroup) return null;
      const Icon = statusIcons[status];
      return <section className={`rating-finding rating-finding--${status}`} key={status}>
        <h5 className="rating-finding-label"><span className="rating-state">
          <Icon size={16} aria-hidden="true" />{evidence ? group?.title : skillGroup?.title}
        </span></h5>
        <div className="rating-finding-content">
          {!!group?.items.length && <ul className="rating-item-list">{group.items.map((item, index) => <li key={index}>
            {item.category !== item.requirement && <span className="af-caption">{item.category}</span>}
            <strong>{item.requirement}</strong>
            {item.notes.length > 0 && <p className="rating-item-notes">{item.notes.join(" ")}</p>}
            <RatingSources items={[{ quotes: item.quotes }]} />
          </li>)}</ul>}
          {skillGroup && <div className={`rating-skill-group rating-skill-group--${status}`}>
            <span className="af-caption">Навыки</span>
            <div className="tags">{skillGroup.items.map((skill, index) => <span className="af-badge tag" key={index}>{skill.requirement}</span>)}</div>
            <RatingSources items={skillGroup.items} />
          </div>}
        </div>
      </section>;
    })}
    <RatingClarifications items={clarifications} />
    {!hasTriggeredStops && stopFindings}
  </div></SourceLocations.Provider>;
}
