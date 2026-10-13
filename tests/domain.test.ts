import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizePhone, personSchema, identityKey } from "@hr/contracts";
import { baselineScore } from "../apps/ranker/src/scoring.js";
import { validateRankResponse } from "@hr/contracts";
import { exportCsv, escapeHtml } from "../apps/backend/src/export.js";
import type { Candidate, Cluster, Profile } from "@hr/contracts";
const clusterId = "5cabfa83-676b-4084-9ec8-212658478b6b",
  profileId = "d5ebfa74-a6f9-44aa-9b93-43ce2d62fbfb";
const profile: Profile = {
  id: profileId,
  cluster_id: clusterId,
  position_name: "Backend",
  education: "",
  experience: "",
  comment: "",
  keywords: ["Python", "SQL"],
  stop_factors: ["нет допуска"],
  is_active: true,
};
test("normalization catches Russian phone variants and rejects malformed identity", () => {
  assert.equal(normalizePhone("8 (999) 123-45-67"), "+79991234567");
  assert.equal(normalizePhone("9991234567"), "+79991234567");
  assert.equal(identityKey("  СЕМЁНОВ   Иван "), "семенов иван");
  assert.equal(
    personSchema.safeParse({
      last_name: "<script>",
      first_name: "Иван",
      phone: "123",
    }).success,
    false,
  );
  assert.equal(
    personSchema.parse({
      last_name: " Иванов ",
      first_name: "Иван",
      phone: "89991234567",
    }).last_name,
    "Иванов",
  );
});
test("baseline does not invent education/experience scores and handles stop factors", () => {
  assert.equal(baselineScore("Опыт Python", profile).score, 50);
  assert.equal(baselineScore("Python SQL; нет допуска", profile).score, 0);
  assert.equal(
    baselineScore("Python SQL", { ...profile, keywords: [] }).score,
    0,
  );
  assert.equal(
    baselineScore("Python SQL", profile).details.education,
    "Не оценено",
  );
});
test("rank contract rejects omitted, duplicate, foreign and out-of-range ratings", () => {
  const expected = [{ id: clusterId, profiles: [{ id: profileId }] }];
  const response = (profiles: unknown[]) => ({
    clusters: [{ id: clusterId, profiles }],
  });
  assert.equal(
    validateRankResponse(response([{ id: profileId, score: 92.5 }]), expected)
      .clusters[0].profiles[0].score,
    92.5,
  );
  for (const profiles of [
    [],
    [{ id: profileId, score: 101 }],
    [{ id: clusterId, score: 20 }],
    [
      { id: profileId, score: 20 },
      { id: profileId, score: 25 },
    ],
  ])
    assert.throws(() => validateRankResponse(response(profiles), expected));
  assert.throws(() =>
    validateRankResponse(
      {
        clusters: [
          { id: clusterId, profiles: [] },
          { id: clusterId, profiles: [] },
        ],
      },
      [],
    ),
  );
});
test("HTML export escapes content and CSV prevents spreadsheet formula injection", () => {
  assert.equal(escapeHtml('<script>"&'), "&lt;script&gt;&quot;&amp;");
  const cluster: Cluster = {
    id: clusterId,
    name: '=HYPERLINK("bad")',
    track: "it",
    comment: "",
    is_active: true,
    profiles: [profile],
  };
  const candidate = {
    last_name: "Иванов",
    first_name: "Иван",
    phone: "+79991234567",
    status: "in_work",
    scoring_status: "completed",
    ratings: [{ profile_id: profileId, score: 80 }],
    blacklisted: false,
  } as Candidate;
  const csv = exportCsv([candidate], [cluster]);
  assert.ok(csv.startsWith("\uFEFF"));
  assert.ok(csv.includes("'=HYPERLINK"));
  assert.ok(csv.includes("'+79991234567"));
  assert.ok(csv.includes('"80"'));
});
