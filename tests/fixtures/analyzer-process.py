"""Real ASGI service/consumer with a deterministic scoring fixture, no real model calls."""

import os
import requests
import uvicorn

import app.main
import app.job_processor
from app.ollama_client import ModelUnavailable, ModelTimeout
from app.rank_models import RankResponse
from app.readiness import mark_ready


def score(resume_text, requirements, job_id):
    response = requests.post(os.environ["OLLAMA_BASE_URL"] + "/score", timeout=5)
    if response.status_code == 503:
        mark_ready(False)
        raise ModelUnavailable("Fixture model outage")
    if response.status_code == 504:
        raise ModelTimeout("Fixture model timeout")
    response.raise_for_status()
    return RankResponse.model_validate({"clusters": [{"id": cluster.id, "name": cluster.name,
        "profiles": [{"id": profile.id, "position_name": profile.position_name, "score": 73,
                      "explanation": "Fixture"} for profile in cluster.profiles]} for cluster in requirements.clusters]})


app.main.analyze_resume_text = score
app.job_processor.analyze_resume_text = score
original_update = app.main.update_runtime


def observe_shutdown(**changes):
    original_update(**changes)
    if changes.get("stopping"):
        requests.post(os.environ["OLLAMA_BASE_URL"] + "/stopping", timeout=2)


app.main.update_runtime = observe_shutdown
server = uvicorn.Server(uvicorn.Config(app.main.app, host="127.0.0.1", port=int(os.environ["TEST_ANALYZER_PORT"]),
                                      timeout_graceful_shutdown=5))


@app.main.app.post("/test/shutdown")
def shutdown_fixture():
    server.should_exit = True
    return {"ok": True}


server.run()
