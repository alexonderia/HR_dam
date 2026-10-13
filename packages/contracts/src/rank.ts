import { rankResponseSchema } from "./domain.js";

export function validateRankResponse(
  input: unknown,
  expected: { id: string; profiles: { id: string }[] }[],
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
  return result;
}
