"""Isolated processing acceptance tests. Uses only synthetic files and protocol peers."""
from pathlib import Path
import argparse
import http.client
import json
import subprocess
import urllib.request
import urllib.error
import os
from uuid import uuid4

ROOT = Path(__file__).resolve().parents[1]
PREFIX = ["docker", "compose", "-p", f"hr-dam-processing-qa-{uuid4().hex[:12]}",
          "-f", "docker-compose.yml", "-f", "tests/compose.processing.yml",
          "-f", "tests/compose.processing-networks.yml"]
ENV = {**os.environ, "COMPOSE_PROFILES": ""}


def run(*args):
    subprocess.run(PREFIX + list(args), cwd=ROOT, env=ENV, check=True)


def check_config():
    # Configuration contains secrets; inspect it in memory and never print it.
    config = json.loads(subprocess.check_output(PREFIX + ["config", "--format", "json"], cwd=ROOT, env=ENV))
    services = config["services"]
    guest, backend, auth = (services[name] for name in ("guest-api", "backend", "auth-check"))
    assert not set(guest["networks"]) & set(backend["networks"])
    assert not any(k.startswith("POSTGRES") or k == "PGHOST" for k in guest["environment"])
    assert not any(k.startswith(("POSTGRES", "S3", "GUEST_S3", "PROCESSING_AMQP")) for k in auth["environment"])
    for name in ("backend", "guest-api", "auth-check", "rabbitmq", "postgres", "seaweedfs"):
        assert not services[name].get("ports"), name
    assert not services["frontend"].get("depends_on")
    for name in ("resume-parser", "resume-evaluator"):
        processor = services.get(name)
        if processor:
            assert not any("PRIVATE" in key or "S3" in key or key.startswith("POSTGRES") for key in processor["environment"])
    print("PASS Compose network and credential isolation", flush=True)


def check_outage():
    run("stop", "auth-check")
    try:
        urllib.request.urlopen("http://localhost:13000/api/guest/queue/00000000-0000-4000-8000-000000000001", timeout=10)
        raise AssertionError("Nginx admitted a request without auth-check")
    except urllib.error.HTTPError as error:
        assert error.code == 503
        assert "application/json" in error.headers["Content-Type"]
        assert error.headers["Cache-Control"] == "no-store"
    assert urllib.request.urlopen("http://localhost:13000/health", timeout=5).status == 200
    print("PASS fail-closed auth-check outage and independent Nginx health", flush=True)


def check_upload_limit():
    connection = http.client.HTTPConnection("localhost", 13000, timeout=5)
    try:
        connection.request("POST", "/api/guest/tasks", headers={"Content-Length": str(252 * 1024 * 1024)})
        response = connection.getresponse()
        assert response.status == 413
        assert response.headers["Cache-Control"] == "no-store"
    finally:
        connection.close()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("scenario", nargs="?", choices=["full", "workflow", "outage"], default="full")
    scenario = parser.parse_args().scenario
    check_config()
    run("build", "frontend", "auth-check", "guest-api", "backend")
    try:
        run_scenario(scenario)
    except subprocess.CalledProcessError:
        subprocess.run(PREFIX + ["logs", "--no-color", "--tail", "30", "frontend", "backend",
                                 "guest-api", "auth-check", "clamav"],
                       cwd=ROOT, env=ENV, check=False)
        raise
    finally:
        # This run owns the unique project and all of its synthetic volumes.
        run("--profile", "test", "down", "--volumes")


def run_scenario(scenario):
    if scenario != "workflow":
        run("up", "-d", "--wait", "frontend", "auth-check", "guest-api", "clamav")
        check_upload_limit()
        if scenario == "full":
            run("run", "--rm", "--no-deps", "test-runner", "guest")
        check_outage()
    run("up", "-d", "--wait", "frontend", "auth-check", "backend")
    if scenario == "outage":
        run("run", "--rm", "--no-deps", "test-runner", "outage")
        return
    run("run", "--rm", "--no-deps", "--entrypoint", "node", "test-runner", "/app/tests/workflow.integration.ts")
    if scenario == "workflow":
        return
    run("run", "--rm", "--no-deps", "test-runner", "authorized")
    run("stop", "rabbitmq")
    run("run", "--rm", "--no-deps", "test-runner", "outbox-create")
    run("restart", "backend")
    run("up", "-d", "--wait", "rabbitmq")
    run("run", "--rm", "--no-deps", "test-runner", "recover")
    run("run", "--rm", "--no-deps", "test-runner", "cleanup")
    subprocess.run(["npx", "tsx", "tests/processing.ui.ts"], cwd=ROOT, shell=os.name == "nt", check=True)
    subprocess.run(["npx", "tsx", "tests/contact-recovery.ui.ts"], cwd=ROOT, shell=os.name == "nt",
                   env={**os.environ, "TEST_BASE_URL": "http://localhost:13000"}, check=True)
    print("Processing acceptance checks passed", flush=True)


if __name__ == "__main__":
    main()
