import assert from "node:assert/strict";
import { test } from "node:test";
import { clusterRequirementsKey, type Cluster } from "@hr/contracts";

const cluster: Cluster = {
  id: "cluster", name: "IT", track: "it", comment: "", is_active: true,
  profiles: [{ id: "profile", cluster_id: "cluster", position_name: "Developer", education: "", experience: "",
    keywords: ["SQL", "Python"], stop_factors: ["A", "B"], comment: "", is_active: true }],
};
test("assessment requirements ignore ordering and inactive profile edits", () => {
  const inactive = { ...cluster.profiles[0], id: "inactive", is_active: false };
  assert.equal(clusterRequirementsKey(cluster), clusterRequirementsKey({ ...cluster, profiles: [inactive,
    { ...cluster.profiles[0], keywords: ["Python", "SQL"], stop_factors: ["B", "A"] }] }));
});
test("assessment requirements detect cluster, profile, membership and activation changes", () => {
  const key = clusterRequirementsKey(cluster);
  for (const changed of [
    { ...cluster, name: "Changed" }, { ...cluster, comment: "New requirement" },
    { ...cluster, profiles: [{ ...cluster.profiles[0], experience: "5 years" }] },
    { ...cluster, profiles: [{ ...cluster.profiles[0], is_active: false }] },
    { ...cluster, profiles: [...cluster.profiles, { ...cluster.profiles[0], id: "new" }] },
  ]) assert.notEqual(clusterRequirementsKey(changed), key);
});
