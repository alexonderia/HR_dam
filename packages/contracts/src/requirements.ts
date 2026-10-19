import type { Cluster } from "./domain.js";

// Compare assessment inputs independently of database/JSON key and list order.
export function clusterRequirementsKey(cluster: Cluster): string {
  return JSON.stringify({
    id: cluster.id, name: cluster.name, track: cluster.track,
    comment: cluster.comment || "", is_active: cluster.is_active,
    profiles: cluster.profiles.filter(profile => profile.is_active)
      .map(profile => ({
        id: profile.id, cluster_id: profile.cluster_id, position_name: profile.position_name,
        education: profile.education || "", experience: profile.experience || "",
        keywords: [...(profile.keywords || [])].sort(), stop_factors: [...(profile.stop_factors || [])].sort(),
        comment: profile.comment || "", is_active: profile.is_active,
      })).sort((a, b) => a.id.localeCompare(b.id)),
  });
}

export interface RequirementUpdates {
  resume_count: number;
  ready_resume_count: number;
  clusters: {
    cluster_id: string;
    cluster_name: string;
    resume_count: number;
    ready_resume_count: number;
  }[];
}

export interface RequirementReassessmentResult {
  queued_resumes: number;
  skipped_resumes: number;
  errors: { resume_id: string; message: string }[];
}
