import { guestCriteriaSchema, requirementListV5 } from "@hr/contracts";

const labels = {
  name: "Название подбора", education: "Образование", experience: "Опыт работы",
  keywords: "Навыки", stop_factors: "Стоп-факторы", comment: "Комментарий",
};
type GuestCriteriaInput = Record<keyof typeof labels, string>;

export function parseGuestCriteria(values: GuestCriteriaInput) {
  const result = guestCriteriaSchema.safeParse({ ...values,
    keywords: requirementListV5(values.keywords), stop_factors: requirementListV5(values.stop_factors) });
  if (result.success) return result.data;
  const messages = result.error.issues.map(issue => {
    const field = issue.path[0] as keyof typeof labels;
    const label = labels[field] || "Критерии";
    const index = issue.path[1];
    if (issue.code === "too_big") {
      if (typeof index === "number") return `«${label}»: пункт ${index + 1} — не более ${issue.maximum} символов. Сократите пункт или разделите самостоятельные требования переносом строки.`;
      if (issue.origin === "array") return `«${label}»: не более ${issue.maximum} пунктов.`;
      return `«${label}»: не более ${issue.maximum} символов.`;
    }
    if (issue.code === "too_small") return `Заполните поле «${label}».`;
    return `Проверьте поле «${label}».`;
  });
  throw new Error([...new Set(messages)].join("\n"));
}
