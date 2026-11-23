// Present earned points consistently; bounds remain in the evidence metadata.
export const insufficientScoreNote = "Недостаточно сведений для полной оценки. Баллы начислены за подтверждённые требования с учётом частичного соответствия. Уточните недостающие сведения — оценка может измениться.";

export function scorePresentation(range: { min: number; max: number }, truncated = false) {
  const format = (value: number) => value.toLocaleString("ru-RU", { maximumFractionDigits: 2 });
  const insufficient = truncated || range.min !== range.max;
  return {
    insufficient,
    label: "Подтверждённая оценка",
    value: format(range.min),
    note: insufficient ? insufficientScoreNote : "",
  };
}
