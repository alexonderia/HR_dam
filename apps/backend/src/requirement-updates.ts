import { clusterRequirementsKey, assessmentRetryRestriction, type Cluster, type Candidate, type RequirementUpdates } from "@hr/contracts";
import { pool, restoreClusterAssessmentHistory } from "@hr/data-access";

let assessmentHistory: Promise<unknown> | undefined;
export function initializeAssessmentHistory() {
  return assessmentHistory ??= restoreClusterAssessmentHistory().catch(error => {
    assessmentHistory = undefined;
    throw error;
  });
}

export async function requirementUpdatePlan(clusters: Cluster[]) {
  // The current protocol has no access to v1's broker. Overview reads must not
  // depend on it or backfill data. Configuration writes initialize the baseline
  // before changing requirements; older deployments keep their ledger recovery.
  if (!process.env.PROCESSING_AMQP_URL) await initializeAssessmentHistory();
  const active = clusters.filter(cluster => cluster.is_active && cluster.profiles.some(profile => profile.is_active));
  const { rows } = await pool.query(`SELECT r.id,r.status,r.scoring_status,
    coalesce(jsonb_object_agg(a.cluster_id,a.requirements) FILTER (WHERE a.cluster_id IS NOT NULL),'{}'::jsonb) AS assessed,
    ARRAY(SELECT DISTINCT f.cluster_id::text FROM profile_ratings p JOIN profiles f ON f.id=p.profile_id
      WHERE p.resume_id=r.id) AS rated_cluster_ids
    FROM resumes r LEFT JOIN resume_cluster_assessments a ON a.resume_id=r.id
    WHERE r.status='in_work' AND (r.scoring_status='completed'
      OR EXISTS(SELECT 1 FROM profile_ratings p WHERE p.resume_id=r.id)
      OR EXISTS(SELECT 1 FROM resume_cluster_assessments s WHERE s.resume_id=r.id))
    GROUP BY r.id`);
  const currentKeys = new Map(active.map(cluster => [cluster.id, clusterRequirementsKey(cluster)]));
  const resumes: { resume_id: string; cluster_ids: string[]; ready: boolean }[] = [];
  const summary: RequirementUpdates = { resume_count: 0, ready_resume_count: 0, clusters: [] };
  for (const row of rows as (Pick<Candidate, "id" | "status" | "scoring_status"> & { assessed: Record<string, Cluster>; rated_cluster_ids: string[] })[]) {
    const rated = new Set(row.rated_cluster_ids);
    const stale = active.filter(cluster => {
      const assessed = row.assessed[cluster.id];
      // A legacy rated cluster without a snapshot starts tracking from its
      // current requirements. A new, never-rated cluster still needs assessment.
      return assessed ? clusterRequirementsKey(assessed) !== currentKeys.get(cluster.id) : !rated.has(cluster.id);
    });
    if (stale.length) resumes.push({ resume_id: row.id, cluster_ids: stale.map(cluster => cluster.id), ready: !assessmentRetryRestriction(row) });
  }
  summary.resume_count = resumes.length;
  summary.ready_resume_count = resumes.filter(resume => resume.ready).length;
  summary.clusters = active.map(cluster => {
    const affected = resumes.filter(resume => resume.cluster_ids.includes(cluster.id));
    return { cluster_id: cluster.id, cluster_name: cluster.name, resume_count: affected.length,
      ready_resume_count: affected.filter(resume => resume.ready).length };
  }).filter(cluster => cluster.resume_count > 0);
  return { summary, resumes };
}
