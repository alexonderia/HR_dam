"""Isolated processing acceptance tests. Uses only synthetic files and protocol peers."""
from pathlib import Path
import json
import subprocess
import urllib.request
import urllib.error
import os

ROOT = Path(__file__).resolve().parents[1]
PREFIX = ["docker", "compose", "-p", "hr-dam-processing-qa", "-f", "docker-compose.yml", "-f", "tests/compose.processing.yml"]


def run(*args):
    subprocess.run(PREFIX + list(args), cwd=ROOT, check=True)


def main():
    # Configuration contains secrets; inspect it in memory and never print it.
    config = json.loads(subprocess.check_output(PREFIX + ["config", "--format", "json"], cwd=ROOT))
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
    run("build", "frontend", "auth-check", "guest-api", "backend")
    run("stop", "backend", "postgres")
    run("up", "-d", "--wait", "frontend", "auth-check", "guest-api", "clamav")
    run("run", "--rm", "--no-deps", "test-runner", "guest")
    run("stop", "auth-check")
    try:
        urllib.request.urlopen("http://localhost:13000/api/guest/queue/00000000-0000-4000-8000-000000000001", timeout=10)
        raise AssertionError("Nginx admitted a request without auth-check")
    except urllib.error.HTTPError as error:
        assert error.code == 503
        assert "application/json" in error.headers["Content-Type"]
    assert urllib.request.urlopen("http://localhost:13000/health", timeout=5).status == 200
    print("PASS fail-closed auth-check outage and independent Nginx health", flush=True)
    run("up", "-d", "--wait", "auth-check", "backend")
    run("run", "--rm", "--no-deps", "test-runner", "authorized")
    run("stop", "rabbitmq")
    run("run", "--rm", "--no-deps", "test-runner", "outbox-create")
    run("restart", "backend")
    run("up", "-d", "--wait", "rabbitmq")
    run("run", "--rm", "--no-deps", "test-runner", "recover")
    run("run", "--rm", "--no-deps", "test-runner", "cleanup")
    subprocess.run(["npx", "tsx", "tests/processing.ui.ts"], cwd=ROOT, shell=os.name == "nt", check=True)
    print("Processing acceptance checks passed", flush=True)


if __name__ == "__main__":
    main()
