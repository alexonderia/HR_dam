import { ratingEvidence, explainEvidenceRating } from "./evidence.js";
import { formatExperienceDuration } from "./time.js";
import { scorePresentation } from "./score-presentation.js";

export interface ReportRating {
  score: number;
  details?: unknown;
  explanation?: string | null;
  matched_keywords?: string[];
  triggered_stop_factors?: string[];
}

export const ratingGroupLabels = {
  met: "Подтверждено",
  partial: "Частичное соответствие",
  not_met: "Подтверждённое несоответствие",
  unknown: "Не указано",
} as const;
const categoryLabels = { keyword: "Навыки", experience: "Опыт", education: "Образование", additional: "Дополнительное требование" };
const stopLabels = { triggered: "Сработал", not_triggered: "Не сработал", unknown: "Не указано" };
export const unknownReasonLabels = {
  not_stated: "По резюме не удалось подтвердить условие", contradictory: "Сведения противоречат друг другу",
  not_relevant: "Сведения не подтверждают нужную работу или требование", unverified_evidence: "Подтверждение не прошло проверку",
  future_intent: "Указано намерение, а не имеющийся навык", incomplete_document: "Недостаточно контекста фрагмента",
  ambiguous_requirement: "Требование сформулировано неоднозначно",
};

type Clarification = { id: string; requirement: string; reason: string; question: string; quotes: string[] };

export function groupRatingClarifications<T extends Clarification>(items: T[]) {
  const groups = new Map<string, { reason: string; question: string; items: T[] }>();
  for (const item of items) {
    const key = JSON.stringify([item.reason, item.question]);
    const group = groups.get(key);
    if (group) group.items.push(item);
    else groups.set(key, { reason: item.reason, question: item.question, items: [item] });
  }
  return [...groups.values()];
}

export function clarificationSources(items: Pick<Clarification, "requirement" | "quotes">[]) {
  const quotes = items.flatMap(item => item.quotes.map(quote => ({ quote, requirement: item.requirement })))
    .map(item => ({ ...item, normalized: item.quote.replace(/\s+/gu, " ").trim() }))
    .filter(item => item.normalized)
    .sort((a, b) => b.normalized.length - a.normalized.length);
  const sources: { quote: string; normalized: string; requirements: string[] }[] = [];
  for (const item of quotes) {
    // Keep an original, longer quotation when it already includes the entire
    // shorter one. Never stitch quotes or change the saved evidence.
    const existing = sources.find(source => source.normalized.includes(item.normalized));
    if (existing) {
      if (!existing.requirements.includes(item.requirement)) existing.requirements.push(item.requirement);
    } else sources.push({ quote: item.quote, normalized: item.normalized, requirements: [item.requirement] });
  }
  return sources.map(({ quote, requirements }) => ({ quote, requirements }));
}

export function ratingRangeText(rating: { details?: unknown }): string {
  const range = ratingEvidence(rating)?.score_range;
  const format = (value: number) => value.toLocaleString("ru-RU", { maximumFractionDigits: 2 });
  return range ? `${format(range.min)}–${format(range.max)}` : "";
}

export function ratingEstimateText(rating: { details?: unknown }): string {
  const evidence = ratingEvidence(rating);
  if (!evidence) return "";
  const estimate = scorePresentation(evidence.score_range, evidence.context_truncated || evidence.score_status === "insufficient_evidence");
  return `${estimate.value} из 100${estimate.note ? ". " + estimate.note : ""}`;
}

export function ratingAnalysis(rating: ReportRating) {
  const evidence = ratingEvidence(rating);
  const clarifications = evidence ? [...evidence.criteria, ...evidence.stop_factors]
    .filter(item => item.status === "unknown").map(item => ({ id: item.id, requirement: item.requirement,
      category: "category" in item ? categoryLabels[item.category] : "Стоп-фактор",
      optional: "optional" in item && item.optional,
      reason: unknownReasonLabels[item.unknown_reason || "not_stated"],
      question: item.unknown_reason === "ambiguous_requirement" ? "HR: уточните обязательность и логику условия."
        : item.unknown_reason === "contradictory" ? "Уточните, какие сведения актуальны и к какой работе они относятся."
        : item.unknown_reason === "incomplete_document" ? "Проверьте полный документ и связь подтверждений."
        : "Уточните факты, примеры применения и периоды, подтверждающие это условие.",
      quotes: item.evidence.map(e => e.quote),
    })) : [];
  const missing = Object.entries(categoryLabels).flatMap(([category, label]) => {
    const count = evidence?.criteria.filter(c => c.category === category && c.status === "unknown").length || 0;
    return count ? [{ label, count }] : [];
  });
  const skills = evidence ? (Object.keys(ratingGroupLabels) as (keyof typeof ratingGroupLabels)[]).filter(status => status !== "unknown").map(status => ({
    status, title: ratingGroupLabels[status], items: (evidence?.criteria || []).filter(c => c.category === "keyword" && c.status === status).map(c => ({ requirement: c.requirement, quotes: c.evidence.map(e => e.quote) })),
  })).filter(group => group.items.length) : rating.matched_keywords?.length
    ? [{ status: "met" as const, title: "Указаны оценщиком", items: rating.matched_keywords.map(requirement => ({ requirement, quotes: [] as string[] })) }] : [];
  const groups = (Object.keys(ratingGroupLabels) as (keyof typeof ratingGroupLabels)[]).map(status => ({
    status, title: ratingGroupLabels[status],
    items: (evidence?.criteria || []).filter(c => c.category !== "keyword" && c.status === status && status !== "unknown").map(c => ({
      requirement: c.requirement, category: categoryLabels[c.category],
      notes: [
        ...(c.optional ? ["Желательное требование; на балл не влияет."] : []),
        ...(c.partial_reason === "learning" ? ["Подтверждено обучение, полное владение не подтверждено."] : []),
        ...(c.partial_reason === "missing_parts" ? ["Подтверждены не все части условия."] : []),
        ...(c.required_months != null ? [`Требуемый стаж: ${formatExperienceDuration(c.required_months)}.`] : []),
        ...(c.experience_months != null ? [`Подтверждённый стаж: ${formatExperienceDuration(c.experience_months)}.`] : []),
      ],
      quotes: c.evidence.map(e => e.quote),
    })),
  }));
  const stops = (evidence?.stop_factors || []).map(stop => ({
    requirement: stop.requirement, state: stop.status, status: stopLabels[stop.status],
    notes: stop.penalty ? `Штраф: −${stop.penalty} баллов.` : "Дополнительный штраф не применён.",
    quotes: stop.evidence.map(e => e.quote),
  }));
  return { evidence, groups, skills, missing, stops, clarifications, range: ratingRangeText(rating),
    estimate: evidence ? scorePresentation(evidence.score_range, evidence.context_truncated || evidence.score_status === "insufficient_evidence") : undefined,
    explanation: evidence ? explainEvidenceRating(evidence) : rating.explanation?.trim() || "Обоснование не указано.",
    legacyExplanation: evidence ? "" : rating.explanation || "Обработчик не предоставил пояснение." };
}

export function ratingAnalysisText(rating: ReportRating) {
  const analysis = ratingAnalysis(rating);
  const itemText = (item: { requirement: string; notes: string[]; quotes: string[] }) =>
    [item.requirement, ...item.notes, ...item.quotes.map(quote => `«${quote}»`)].join(" — ");
  return {
    groups: analysis.groups.map(group => ({ title: group.title, text: group.status === "unknown" ? [...analysis.missing.map(field => `${field.label}: Не указано`),
      ...groupRatingClarifications(analysis.clarifications).map(group => `${group.reason}. ${group.question}\n${group.items.map(item => "• " + item.requirement).join("\n")}`)].join("\n")
      : [...group.items.map(itemText), ...analysis.skills.filter(skills => skills.status === group.status).flatMap(skills => skills.items.map(skill => [skill.requirement, ...skill.quotes.map(quote => `«${quote}»`)].join(" — ")))].join("\n") })),
    stops: analysis.stops.length ? [...analysis.stops.filter(stop => stop.state !== "unknown").map(stop => [stop.requirement, stop.status, stop.notes, ...stop.quotes.map(quote => `«${quote}»`)].join(" — ")),
      ...(analysis.stops.some(stop => stop.state === "unknown") ? ["Не указано"] : [])].join("\n")
      : rating.triggered_stop_factors?.join("\n") || "Не найдены",
    explanation: analysis.explanation,
  };
}
