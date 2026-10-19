import type { Candidate, Cluster } from "./domain.js";

export function clusterScore(candidate: Candidate, cluster: Cluster) {
  const scores = candidate.ratings
    .filter((r) => cluster.profiles.some((p) => p.id === r.profile_id))
    .map((r) => Number(r.score));
  return scores.length ? Math.max(...scores) : undefined;
}

export function matrixColumns(clusters: Cluster[], expanded: string[]) {
  return clusters.flatMap((cluster) => [
    {
      id: cluster.id,
      label: cluster.name,
      cluster,
      profile: undefined as Cluster["profiles"][number] | undefined,
    },
    ...(expanded.includes(cluster.id)
      ? cluster.profiles.map((profile) => ({
          id: profile.id,
          label: `${cluster.name} / ${profile.position_name}`,
          cluster,
          profile,
        }))
      : []),
  ]);
}

export function assessmentRetryRestriction(
  candidate: Pick<Candidate, "status" | "scoring_status">,
): string | null {
  if (candidate.status !== "in_work")
    return "Повторная оценка доступна только для резюме в статусе «В работе».";
  if (!["completed", "failed"].includes(candidate.scoring_status))
    return "Дождитесь окончания текущей обработки.";
  return null;
}

export function canChangeStatus(
  candidate: Pick<Candidate, "status" | "scoring_status" | "blacklisted" | "has_other_resume_in_process">,
  next: Candidate["status"],
) {
  return (
    candidate.scoring_status === "completed" &&
    candidate.status !== "historical" &&
    candidate.status !== next &&
    (next !== "in_process" || !inProcessRestriction(candidate))
  );
}

export function inProcessRestriction(
  candidate: Pick<Candidate, "blacklisted" | "has_other_resume_in_process">,
): string | null {
  if (candidate.blacklisted)
    return "Переход в «В процессе» недоступен: кандидат найден в чёрном списке.";
  if (candidate.has_other_resume_in_process)
    return "Переход в «В процессе» недоступен: у кандидата уже есть другое резюме с этим статусом.";
  return null;
}

export const blacklistAssessmentWarning = "Кандидат найден в чёрном списке. Требуется проверка сотрудником.";

export function assessmentCompletedMessage(blacklisted: boolean): string {
  return `Оценка завершена. ${blacklisted ? blacklistAssessmentWarning + " " : ""}Результат доступен в карточке кандидата.`;
}
