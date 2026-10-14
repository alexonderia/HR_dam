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

export function canChangeStatus(
  candidate: Pick<Candidate, "status" | "scoring_status">,
  next: Candidate["status"],
) {
  return (
    candidate.scoring_status === "completed" &&
    candidate.status !== "historical" &&
    candidate.status !== next
  );
}
