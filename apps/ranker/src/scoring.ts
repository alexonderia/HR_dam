import type { Profile } from "@hr/contracts";
import { identityKey } from "@hr/contracts";

export function baselineScore(text: string, profile: Profile) {
  const normalized = identityKey(text);
  const matched = profile.keywords.filter((keyword) =>
    normalized.includes(identityKey(keyword)),
  );
  const stops = profile.stop_factors.filter((factor) =>
    normalized.includes(identityKey(factor)),
  );
  const score =
    stops.length || !profile.keywords.length
      ? 0
      : Math.round((matched.length / profile.keywords.length) * 10000) / 100;
  return {
    id: profile.id,
    score,
    matched_keywords: matched,
    triggered_stop_factors: stops,
    details: {
      method: "keyword-baseline-v1",
      education: "Не оценено",
      experience: "Не оценено",
      cluster_requirements: "Не оценено",
      scanned_text_length: text.length,
    },
    explanation: `Базовый поиск слов: ${matched.length} из ${profile.keywords.length}. ${stops.length ? "Найден стоп-фактор; рейтинг 0." : !profile.keywords.length ? "Ключевые слова не заданы; рейтинг 0." : ""} Образование, опыт и общие требования требуют проверки сотрудником.`,
  };
}
