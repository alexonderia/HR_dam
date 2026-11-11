"""Exercise production worker images in a separate Compose project/volumes."""

import subprocess
import uuid
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
PREFIX = ["docker", "compose", "-p", "hr-dam-processors-qa", "--profile", "processing",
          "-f", "docker-compose.yml", "-f", "tests/compose.processing.yml", "-f", "tests/compose.processors.yml"]


def run(*args):
    subprocess.run(PREFIX + list(args), cwd=ROOT, check=True)


def main():
    run("build", "frontend", "auth-check", "guest-api", "backend", "seaweedfs", "resume-parser", "resume-evaluator")
    try:
        # No PostgreSQL/backend in the initial guest acceptance run.
        run("stop", "backend", "postgres")
        run("up", "-d", "--wait", "frontend", "auth-check", "guest-api", "clamav",
            "model-stub", "resume-parser", "resume-evaluator")
        run("run", "--rm", "--no-deps", "processor-tests", "guest")
        run("up", "-d", "--wait", "backend")
        login = "synthetic-processor-" + uuid.uuid4().hex[:12]
        run("run", "--rm", "--no-deps", "-e", "HR_USER_LOGIN=" + login,
            "-e", "HR_USER_NAME=Synthetic processor", "-e", "HR_USER_PASSWORD=synthetic-processor-password-only",
            "backend", "node", "apps/backend/dist/create-user.js")
        run("run", "--rm", "--no-deps", "-e", "HR_PROCESSOR_TEST_LOGIN=" + login, "processor-tests", "authorized")
        print("PASS real processor acceptance checks", flush=True)
    except Exception:
        run("logs", "--no-color", "--tail", "60", "resume-parser", "resume-evaluator", "guest-api", "backend", "flyway")
        raise
    finally:
        # Free only this project's containers/networks; retain its volumes.
        run("down")


if __name__ == "__main__":
    main()
