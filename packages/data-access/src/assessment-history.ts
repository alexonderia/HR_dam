import { transaction } from "./db.js";
import { getClusters } from "./repository.js";

export async function restoreClusterAssessmentHistory() {
  let baselined = 0;
  // If no original inputs survived, begin tracking the existing rated cluster
  // from its current state. Missing history alone is not a requirements change.
  await transaction(async client => {
    await client.query("LOCK TABLE clusters,profiles IN SHARE MODE");
    for (const cluster of await getClusters()) {
      const result = await client.query(`INSERT INTO resume_cluster_assessments(resume_id,cluster_id,requirements)
        SELECT DISTINCT p.resume_id,$1::uuid,$2::jsonb FROM profile_ratings p JOIN profiles f ON f.id=p.profile_id
        WHERE f.cluster_id=$1 ON CONFLICT(resume_id,cluster_id) DO NOTHING`, [cluster.id, JSON.stringify(cluster)]);
      baselined += result.rowCount || 0;
    }
  });
  return { restored: 0, baselined };
}
