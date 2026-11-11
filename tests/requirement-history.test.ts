import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { Cluster } from "@hr/contracts";

// This file tests the scoped current protocol. No broker or real database is
// available: overview must remain a SELECT even for pre-migration ratings.
process.env.PROCESSING_AMQP_URL = "amqp://fixture:fixture@localhost/hr-authorized";
const { pool, restoreClusterAssessmentHistory } = await import("@hr/data-access");
const { requirementUpdatePlan } = await import("../apps/backend/src/requirement-updates.js");

function cluster(): Cluster {
  const id = randomUUID();
  return { id, name: "Synthetic cluster", track: "test", comment: "", is_active: true,
    profiles: [{ id: randomUUID(), cluster_id: id, position_name: "Synthetic developer", education: "",
      experience: "", keywords: ["Python"], stop_factors: [], comment: "", is_active: true }] };
}
function overviewRows(t: TestContext, rows: unknown[]) {
  const calls: string[] = [];
  const query = async (sql: string) => {
    calls.push(sql);
    assert.match(sql, /^SELECT r\.id/);
    assert.doesNotMatch(sql, /\b(?:INSERT|UPDATE|DELETE|LOCK)\b/i);
    return { rows, rowCount: rows.length, command: "SELECT", fields: [], oid: 0 };
  };
  t.mock.method(pool, "query", query as unknown as typeof pool.query);
  return calls;
}

test("overview of a legacy rated resume is read-only and does not require the old queue", async t => {
  const current = cluster();
  const calls = overviewRows(t, [{ id: randomUUID(), status: "in_work", scoring_status: "completed",
    assessed: {}, rated_cluster_ids: [current.id] }]);
  const result = await requirementUpdatePlan([current]);
  assert.equal(result.summary.resume_count, 0);
  assert.deepEqual(result.resumes, []);
  assert.equal(calls.length, 1);
});

test("a changed saved snapshot still marks the existing cluster for reassessment", async t => {
  const saved = cluster(), current = structuredClone(saved), id = randomUUID();
  current.profiles[0].keywords.push("SQL");
  overviewRows(t, [{ id, status: "in_work", scoring_status: "completed",
    assessed: { [saved.id]: saved }, rated_cluster_ids: [saved.id] }]);
  const result = await requirementUpdatePlan([current]);
  assert.deepEqual(result.resumes, [{ resume_id: id, cluster_ids: [current.id], ready: true }]);
});

test("a new unrated cluster is not hidden by the legacy snapshot fallback", async t => {
  const old = cluster(), added = cluster(), id = randomUUID();
  overviewRows(t, [{ id, status: "in_work", scoring_status: "completed",
    assessed: {}, rated_cluster_ids: [old.id] }]);
  const result = await requirementUpdatePlan([old, added]);
  assert.deepEqual(result.resumes, [{ resume_id: id, cluster_ids: [added.id], ready: true }]);
});

test("explicit initialization before editing requirements baselines current ratings without v1 transport", async t => {
  const current = cluster(), statements: string[] = [];
  const result = (rows: unknown[], command = "SELECT") => ({ rows, rowCount: rows.length, command, fields: [], oid: 0 });
  const query = async (sql: string) => {
    statements.push(sql);
    if (sql.startsWith("SELECT DISTINCT e.id")) return result([{ id: randomUUID() }]);
    if (sql.startsWith("SELECT * FROM clusters")) return result([current]);
    if (sql.startsWith("SELECT * FROM profiles")) return result(current.profiles);
    assert.fail("Unexpected pool statement");
  };
  t.mock.method(pool, "query", query as unknown as typeof pool.query);
  const client = { query: async (sql: string) => {
    statements.push(sql);
    if (sql.startsWith("INSERT INTO resume_cluster_assessments")) return result([{}], "INSERT");
    assert.ok(["BEGIN", "COMMIT", "LOCK TABLE clusters,profiles IN SHARE MODE"].includes(sql));
    return result([]);
  }, release: () => {} };
  t.mock.method(pool, "connect", (async () => client) as unknown as typeof pool.connect);
  assert.deepEqual(await restoreClusterAssessmentHistory(), { restored: 0, baselined: 1 });
  assert.equal(statements.filter(sql => sql.startsWith("INSERT INTO resume_cluster_assessments")).length, 1);
});
