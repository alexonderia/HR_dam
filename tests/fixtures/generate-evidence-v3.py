"""Generate scalar-score fixtures while preserving historical v1/v2 records."""

import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "apps/resume-analyzer"))

from app.evidence_scoring import verify_and_score
from app.rank_models import ProfileRequest

path = ROOT / "tests/fixtures/evidence-ratings.json"
fixtures = json.loads(path.read_text(encoding="utf-8"))
historical = [f for f in fixtures if f["result"]["clusters"][0]["profiles"][0]["details"]["method"] != "evidence-v3"]
generated = []
for fixture in historical:
    cluster = fixture["requirements"][0]
    profile = ProfileRequest(**cluster["profiles"][0])
    details = fixture["result"]["clusters"][0]["profiles"][0]["details"]
    parsed = {key: [{"id": c["id"], "status": c["status"], "evidence": [e["quote"] for e in c["evidence"]]}
                    for c in details[source]]
              for key, source in (("assessments", "criteria"), ("stop_factors", "stop_factors"))}
    rating = verify_and_score(parsed, fixture["source"], profile, cluster.get("comment", ""), model="synthetic-fixture")
    generated.append({**fixture, "name": "midpoint_v3_" + fixture["name"],
                      "result": {"clusters": [{"id": cluster["id"], "profiles": [{"id": profile.id, **rating}]}]}})
    assert "score_range" not in rating["details"]
    if fixture["name"] == "range_v2_22_87":
        assert rating["score"] == 32.87

profile = ProfileRequest(id="d00000f3-0000-4000-8000-000000000001", position_name="Developer",
                         keywords=[f"Skill{i}" for i in range(6)])
source = ". ".join(profile.keywords[:5])
rating = verify_and_score({"assessments": [], "stop_factors": []}, source, profile, model="synthetic-fixture")
assert rating["score"] == 91.67
cluster_id = "c00000f3-0000-4000-8000-000000000001"
generated.append({"name": "midpoint_v3_narrow_rounding", "source": source,
                  "requirements": [{"id": cluster_id, "profiles": [profile.model_dump()]}],
                  "result": {"clusters": [{"id": cluster_id, "profiles": [{"id": profile.id, **rating}]}]}})
path.write_text(json.dumps(historical + generated, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
print(f"Generated {len(generated)} v3 fixtures; preserved {len(historical)} historical fixtures")
