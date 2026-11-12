import { ratingEvidence } from "./evidence.js";
import { formatExperienceDuration } from "./time.js";

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

export function ratingRangeText(rating: { details?: unknown }): string {
  const range = ratingEvidence(rating)?.score_range;
  const format = (value: number) => value.toLocaleString("ru-RU", { maximumFractionDigits: 2 });
  return range ? `${format(range.min)}–${format(range.max)}` : "";
}

export function ratingAnalysis(rating: ReportRating) {
  const evidence = ratingEvidence(rating);
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
  return { evidence, groups, skills, missing, stops, range: ratingRangeText(rating),
    legacyExplanation: evidence ? "" : rating.explanation || "Обработчик не предоставил пояснение." };
}

export function ratingAnalysisText(rating: ReportRating) {
  const analysis = ratingAnalysis(rating);
  const itemText = (item: { requirement: string; notes: string[]; quotes: string[] }) =>
    [item.requirement, ...item.notes, ...item.quotes.map(quote => `«${quote}»`)].join(" — ");
  return {
    groups: analysis.groups.map(group => ({ title: group.title, text: group.status === "unknown" ? analysis.missing.map(field => `${field.label}: Не указано`).join("\n")
      : [...group.items.map(itemText), ...analysis.skills.filter(skills => skills.status === group.status).flatMap(skills => skills.items.map(skill => [skill.requirement, ...skill.quotes.map(quote => `«${quote}»`)].join(" — ")))].join("\n") })),
    stops: analysis.stops.length ? [...analysis.stops.filter(stop => stop.state !== "unknown").map(stop => [stop.requirement, stop.status, stop.notes, ...stop.quotes.map(quote => `«${quote}»`)].join(" — ")),
      ...(analysis.stops.some(stop => stop.state === "unknown") ? ["Не указано"] : [])].join("\n")
      : rating.triggered_stop_factors?.join("\n") || "Не найдены",
    explanation: analysis.legacyExplanation,
  };
}
