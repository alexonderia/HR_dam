import { rankResponseSchema } from "./domain.js";
import { validateEvidenceRating, explainEvidenceRating } from "./evidence.js";

export function validateRankResponse(
  input: unknown,
  expected: { id: string; comment?: string | null; profiles: { id: string; keywords?: string[]; experience?: string | null; education?: string | null; comment?: string | null; stop_factors?: string[] }[] }[],
) {
  const result = rankResponseSchema.parse(input);
  const expectedPairs = expected.flatMap((c) =>
    c.profiles.map((p) => `${c.id}:${p.id}`),
  );
  const actualPairs = result.clusters.flatMap((c) =>
    c.profiles.map((p) => `${c.id}:${p.id}`),
  );
  if (
    result.clusters.length !== expected.length ||
    new Set(result.clusters.map((c) => c.id)).size !== result.clusters.length ||
    actualPairs.length !== expectedPairs.length ||
    new Set(actualPairs).size !== actualPairs.length ||
    actualPairs.some((pair) => !expectedPairs.includes(pair))
  )
    throw new Error(
      "Обработчик вернул неполный или некорректный набор профилей.",
    );
  for (const cluster of result.clusters) {
    const input = expected.find(c => c.id === cluster.id)!;
    for (const rating of cluster.profiles) {
      const profile = input.profiles.find(p => p.id === rating.id)!;
      if (["evidence-v1", "evidence-v2", "evidence-v3"].includes((rating.details as { method?: string } | undefined)?.method || "")) {
        const evidence = validateEvidenceRating(rating, profile, input.comment || "");
        rating.explanation = explainEvidenceRating(evidence);
      }
      if (profile.stop_factors && rating.triggered_stop_factors?.some(stop => !profile.stop_factors!.includes(stop)))
        throw new Error("Обработчик вернул стоп-фактор вне требований задания.");
    }
  }
  return result;
}
