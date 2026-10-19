import { fullName, identityKey, type Candidate, type ResumeImportItem } from "@hr/contracts";

export type TrackingItem = ResumeImportItem & { batchId: string; batchName: string; batchCreatedAt: string };
export interface CandidateImportGroup {
  key: string;
  name: string;
  phone: string | null;
  identified: boolean;
  items: TrackingItem[];
}

function compatible(item: TrackingItem, candidate: Candidate) {
  const hint = item.candidate_hint;
  if (!hint) return true;
  return (["phone", "last_name", "first_name", "middle_name"] as const).every(key =>
    !hint[key] || !candidate[key] || identityKey(hint[key]) === identityKey(candidate[key]));
}

export function candidateImportStatus(items: TrackingItem[]) {
  return items.find(item => item.status === "processing")?.status
    || items.find(item => item.status === "uploading")?.status
    || items.find(item => item.status === "pending")?.status
    || items[0].status;
}

export function groupCandidateImports(items: TrackingItem[], candidates: Candidate[], referenceItems = items): CandidateImportGroup[] {
  const byId = new Map(candidates.map(candidate => [candidate.id, candidate]));
  const byResume = new Map(candidates.map(candidate => [candidate.resume_id, candidate.id]));
  for (const item of referenceItems) if (item.resume_id && item.candidate_id) byResume.set(item.resume_id, item.candidate_id);
  const knownId = (item: TrackingItem) => item.candidate_id
    || byResume.get(item.target_resume_id || item.resume_id || "");
  const byFile = new Map<string, Set<string>>();
  for (const item of referenceItems) {
    const id = knownId(item);
    if (!id || !item.file_sha256) continue;
    if (!byFile.has(item.file_sha256)) byFile.set(item.file_sha256, new Set());
    byFile.get(item.file_sha256)!.add(id);
  }
  const groups = new Map<string, CandidateImportGroup>();
  for (const item of items) {
    let id = knownId(item);
    if (!id && item.candidate_hint?.phone) {
      const matched = candidates.filter(candidate => candidate.phone === item.candidate_hint?.phone && compatible(item, candidate));
      if (matched.length === 1) id = matched[0].id;
    }
    if (!id && item.file_sha256) {
      const matched = byFile.get(item.file_sha256);
      if (matched?.size === 1) {
        const fileCandidateId = [...matched][0], candidate = byId.get(fileCandidateId);
        if (candidate ? compatible(item, candidate) : !item.candidate_hint?.phone) id = fileCandidateId;
      }
    }
    const candidate = id ? byId.get(id) : undefined;
    const name = (candidate && fullName(candidate)) || (item.candidate_hint && fullName(item.candidate_hint));
    const key = id ? `candidate:${id}` : item.target_resume_id || item.resume_id ? `resume:${item.target_resume_id || item.resume_id}`
      : item.candidate_hint?.phone ? `phone:${item.candidate_hint.phone}`
      : item.file_sha256 ? `file:${item.file_sha256}` : `item:${item.batchId}:${item.id}`;
    const existing = groups.get(key);
    if (existing) {
      existing.items.push(item);
      if (!existing.identified && name) { existing.name = name; existing.identified = true; }
      existing.phone ||= candidate?.phone || item.candidate_hint?.phone || null;
    } else groups.set(key, { key, name: name || item.file_name, phone: candidate?.phone || item.candidate_hint?.phone || null,
      identified: Boolean(name), items: [item] });
  }
  for (const group of groups.values()) group.items.sort((a, b) =>
    Date.parse(b.updated_at) - Date.parse(a.updated_at) || Date.parse(b.batchCreatedAt) - Date.parse(a.batchCreatedAt)
      || `${a.batchId}:${a.id}`.localeCompare(`${b.batchId}:${b.id}`));
  return [...groups.values()];
}
