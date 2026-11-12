import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { evaluateResultSchema, validateRankResponse } from "@hr/contracts";
import { newTask } from "@hr/processing";
import { guestReport } from "../apps/guest-api/src/service.js";

const fixtures = JSON.parse(readFileSync(new URL("./fixtures/evidence-ratings.json", import.meta.url), "utf8"));

function reportTask(rating: Record<string, unknown>) {
  const task = newTask("guest", "synthetic-owner", "Synthetic report", []);
  task.status = "completed";
  task.jobs.push({ job_id: randomUUID(), task_id: task.id, file_id: randomUUID(), operation: "evaluate", mode: "guest",
    attempt: 1, created_at: task.created_at, deadline: task.deadline, applied: true,
    result: evaluateResultSchema.parse({ status: "completed", candidate: { last_name: null, first_name: null, middle_name: null, phone: null },
      evaluations: [{ target_id: randomUUID(), ...rating,
        criteria: ["education", "experience", "keywords"].map(name => ({ name, status: "unknown", explanation: "Python: unknown" })) }] }),
  });
  return task;
}

test("saved guest reports rebuild explanations exactly like authorized reports without changing unknown skills or scores", () => {
  const fixture = fixtures.find((f: { name: string }) => f.name === "unknown_is_not_absent");
  const { id: _id, ...rating } = fixture.result.clusters[0].profiles[0];
  const task = reportTask({ ...rating, explanation: "Python confirmed, SQL absent" });
  const before = structuredClone(task);
  const report = guestReport(task);
  const { file_id: _fileId, ...reported } = report.results[0];
  const result = evaluateResultSchema.parse(reported);
  const evaluation = result.evaluations[0];
  const authorized = validateRankResponse(fixture.result, fixture.requirements).clusters[0].profiles[0];
  assert.equal(evaluation.explanation, authorized.explanation);
  assert.match(evaluation.explanation, /Подтверждено: SQL/);
  assert.match(evaluation.explanation, /Не указано: Навыки/);
  assert.doesNotMatch(evaluation.explanation, /Python confirmed|SQL absent|unknown/);
  assert.equal(evaluation.score, rating.score);
  assert.deepEqual(evaluation.details, rating.details);
  assert.deepEqual(evaluation.matched_keywords, rating.matched_keywords);
  assert.deepEqual(task, before, "reading a report must not rewrite the stored evaluation");
});

test("guest reports retain legacy explanations when the evaluator did not provide structured evidence", () => {
  const task = reportTask({ score: 60, explanation: "Пояснение сохранённого результата.", matched_keywords: [], triggered_stop_factors: [] });
  const { file_id: _fileId, ...reported } = guestReport(task).results[0];
  const result = evaluateResultSchema.parse(reported);
  assert.equal(result.evaluations[0].explanation, "Пояснение сохранённого результата.");
});
