// A display threshold, not a confidence interval or a change to scoring.
export const MAX_VISIBLE_SCORE_SPREAD = 20;
export const insufficientScoreNote = "Недостаточно сведений для полной оценки. Баллы начислены только за подтверждённые требования. Уточните недостающие сведения — оценка может измениться.";

export function scorePresentation(range: { min: number; max: number }, truncated = false) {
  const format = (value: number) => value.toLocaleString("ru-RU", { maximumFractionDigits: 2 });
  const insufficient = truncated || range.max - range.min > MAX_VISIBLE_SCORE_SPREAD;
  const showRange = !insufficient && range.min !== range.max;
  return {
    insufficient,
    label: showRange ? "Диапазон оценки" : "Подтверждённая оценка",
    value: showRange ? `${format(range.min)}–${format(range.max)}` : format(range.min),
    note: insufficient ? insufficientScoreNote : "",
  };
}
