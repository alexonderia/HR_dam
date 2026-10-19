import { pool, transaction } from "./db.js";
import { brokerQueues, readImportLedger } from "./queue.js";
import { getClusters } from "./repository.js";

// Restore the actual inputs of legacy scores before comparing requirements.
export async function restoreClusterAssessmentHistory() {
  const missing = await pool.query(`SELECT DISTINCT e.id FROM resume_events e
    JOIN profile_ratings p ON p.resume_id=e.resume_id AND p.calculated_at=e.created_at
    JOIN profiles f ON f.id=p.profile_id
    LEFT JOIN resume_cluster_assessments a ON a.resume_id=p.resume_id AND a.cluster_id=f.cluster_id
    WHERE e.event_type='scored' AND a.resume_id IS NULL`);
  const receipts = new Set<string>(missing.rows.map(row => row.id));
  let restored = 0, baselined = 0;
  if (receipts.size) {
    for (const queue of await brokerQueues()) {
      if (!/^hr\.resume\.batch\.[a-f0-9-]{36}$/.test(queue.name)) continue;
      const { manifest, events } = await readImportLedger(queue.name.slice("hr.resume.batch.".length));
      const jobs = new Map(events.filter(event => receipts.has(event.job_id)).map(event => [event.job_id, event.item_id]));
      for (const [jobId, itemId] of jobs) {
        const file = manifest.items.find(item => item.id === itemId);
        if (!file) continue;
        for (const cluster of manifest.requirements) {
          const result = await pool.query(`INSERT INTO resume_cluster_assessments(resume_id,cluster_id,requirements,assessed_at)
            SELECT e.resume_id,$2::uuid,$3::jsonb,e.created_at FROM resume_events e JOIN resumes r ON r.id=e.resume_id
            WHERE e.id=$1 AND e.event_type='scored' AND r.file_id=$4
              AND EXISTS(SELECT 1 FROM clusters c WHERE c.id=$2)
              AND (SELECT count(*) FROM profile_ratings p WHERE p.resume_id=e.resume_id
                AND p.profile_id=ANY($5::uuid[]) AND p.calculated_at=e.created_at)=cardinality($5::uuid[])
            ON CONFLICT(resume_id,cluster_id) DO NOTHING`,
          [jobId, cluster.id, JSON.stringify(cluster), file.file_id, cluster.profiles.map(profile => profile.id)]);
          restored += result.rowCount || 0;
        }
      }
    }
  }
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
  return { restored, baselined };
}
