import { pool } from "./db.js";
import type { Cluster, Candidate } from "@hr/contracts";

const personMatchSql = (left: string, right: string) => `(${left}.phone = ${right}.phone OR (
  replace(lower(${left}.last_name),'ё','е') = replace(lower(${right}.last_name),'ё','е') AND
  replace(lower(${left}.first_name),'ё','е') = replace(lower(${right}.first_name),'ё','е') AND
  replace(lower(coalesce(${left}.middle_name,'')),'ё','е') = replace(lower(coalesce(${right}.middle_name,'')),'ё','е')
))`;
export const blacklistMatchSql = personMatchSql("b", "c");
export const otherInProcessResumeSql = `EXISTS(
  SELECT 1 FROM resumes other_r JOIN candidates other_c ON other_c.id=other_r.candidate_id
  WHERE other_r.id<>r.id AND other_r.status='in_process'
    AND (other_r.candidate_id=c.id OR ${personMatchSql("other_c", "c")})
)`;
export async function getClusters(): Promise<Cluster[]> {
  const [clusters, profiles] = await Promise.all([
    pool.query("SELECT * FROM clusters ORDER BY is_active DESC,name"),
    pool.query("SELECT * FROM profiles ORDER BY is_active DESC,position_name"),
  ]);
  return clusters.rows.map((c) => ({
    ...c,
    comment: c.comment ?? "",
    profiles: profiles.rows
      .filter((p) => p.cluster_id === c.id)
      .map((p) => ({
        ...p,
        education: p.education ?? "",
        experience: p.experience ?? "",
        keywords: p.keywords ?? [],
        stop_factors: p.stop_factors ?? [],
        comment: p.comment ?? "",
      })),
  }));
}
export async function getCandidates(): Promise<Candidate[]> {
  const result =
    await pool.query(`SELECT c.*, r.id AS resume_id, r.file_id, r.status, r.scoring_status, r.updated_at,
    f.file_name, f.mime_type,
    (SELECT count(*)::int FROM resume_events e WHERE e.resume_id=r.id AND e.event_type='replaced') AS other_resumes_count,
    EXISTS(SELECT 1 FROM candidate_blacklist b WHERE b.is_active AND ${blacklistMatchSql}) AS blacklisted,
    ${otherInProcessResumeSql} AS has_other_resume_in_process,
    coalesce((SELECT jsonb_agg(jsonb_build_object('profile_id', pr.profile_id, 'score', pr.score,
      'matched_keywords', pr.matched_keywords, 'triggered_stop_factors', pr.triggered_stop_factors,
      'details', pr.details, 'explanation', pr.explanation, 'calculated_at', pr.calculated_at))
      FROM profile_ratings pr WHERE pr.resume_id=r.id),'[]'::jsonb) AS ratings
    FROM candidates c JOIN resumes r ON r.candidate_id=c.id JOIN files f ON f.id=r.file_id ORDER BY c.created_at DESC`);
  return result.rows.map((c) => ({ ...c, middle_name: c.middle_name ?? "" }));
}
