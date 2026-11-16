"""Real worker processes, parsers and scoring; synthetic Ollama and documents."""

import hashlib
import io
import json
import os
import sys
import time
import uuid
import zipfile

import pymupdf as fitz
import requests
from docx import Document

ORIGIN = "http://localhost:13100"
BASE = "http://frontend:8080"
criteria = {"name": "Synthetic developer", "education": "", "experience": "", "keywords": ["Python"], "stop_factors": [], "comment": ""}


def request(browser, path, status=200, **kwargs):
    response = browser.request(kwargs.pop("method", "GET"), BASE + path, timeout=15, **kwargs)
    assert response.status_code == status, f"{path}: expected {status}, got {response.status_code}"
    return response.json()


def completed(browser, task_id, mode="guest"):
    path = f"/api/guest/tasks/{task_id}" if mode == "guest" else f"/api/app/resume-imports/{task_id}"
    end = time.monotonic() + 90
    while time.monotonic() < end:
        result = request(browser, path)
        if mode == "guest" and result["status"] in {"completed", "failed", "partially_completed"}:
            return result
        if mode == "authorized" and result["pending_files"] == 0:
            return result
        time.sleep(.25)
    raise AssertionError("Worker did not complete synthetic task")


def guest_submit(browser, name, content):
    ticket = request(browser, "/api/guest/queue", 201, method="POST", json={"file_count": 1, "size_bytes": len(content)})
    # JSON.stringify formatting/order is part of the submission fingerprint.
    manifest = {"criteria": criteria, "files": [{"name": name, "size": len(content), "sha256": hashlib.sha256(content).hexdigest()}]}
    digest = hashlib.sha256(json.dumps(manifest, ensure_ascii=False, separators=(",", ":")).encode()).hexdigest()
    accepted = request(browser, "/api/guest/tasks", 202, method="POST",
        headers={"Idempotency-Key": str(uuid.uuid4()), "X-Submission-Digest": digest, "X-Upload-Permit": ticket["id"]},
        data={"criteria": json.dumps(criteria)}, files={"files": (name, content)})
    return accepted["task_id"]


def docx():
    document = Document()
    document.add_paragraph("Synthetic resume. Python is used for developing and testing business applications.")
    data = io.BytesIO()
    document.save(data)
    return data.getvalue()


def wait_availability(browser, expected, mode="guest"):
    end = time.monotonic() + 15
    while time.monotonic() < end:
        status = request(browser, f"/api/{'guest' if mode == 'guest' else 'app'}/analysis/status")
        if status["available"] is expected:
            return status
        time.sleep(.3)
    raise AssertionError("Incorrect application readiness")


def model_control(available):
    response = requests.post("http://model-stub:11434/control", json={"available": available}, timeout=5)
    response.raise_for_status()


def outage(browser):
    model_control(False)
    try:
        status = wait_availability(browser, False)
        assert status["alive"] is True and status["model_ready"] is False, status
        before = requests.get("http://model-stub:11434/stats", timeout=5).json()["calls"]
        archive = io.BytesIO()
        with zipfile.ZipFile(archive, "w") as zipped:
            zipped.writestr("first.docx", docx())
            zipped.writestr("second.docx", docx())
        task = guest_submit(browser, "waiting-for-model.zip", archive.getvalue())
        end = time.monotonic() + 15
        while time.monotonic() < end:
            report = request(browser, f"/api/guest/tasks/{task}")
            if report["candidate_count"] == 2:
                break
            time.sleep(.3)
        assert report["candidate_count"] == 2, "Parser must work without Ollama"
        time.sleep(3)
        assert not report["errors"], report
        assert requests.get("http://model-stub:11434/stats", timeout=5).json()["calls"] == before
    finally:
        model_control(True)
    wait_availability(browser, True)
    report = completed(browser, task)
    assert report["completed_count"] == 2 and not report["errors"], report
    request(browser, f"/api/guest/tasks/{task}", 202, method="DELETE")
    print("PASS model outage: API reports unavailable, parser continues, queued evaluations wait and recover", flush=True)


def guest(browser):
    assert request(browser, "/api/session")["mode"] == "guest"
    task = guest_submit(browser, "synthetic.docx", docx())
    result = completed(browser, task)
    assert result["status"] == "completed", result.get("errors")
    assert result["results"][0]["evaluations"][0]["score"] == 100
    assert result["results"][0]["evaluations"][0]["details"]["method"] == "evidence-v1"
    assert requests.get("http://model-stub:11434/stats", timeout=5).json()["calls"] >= 3
    print("PASS real DOCX extraction, evidence scoring and broker retry after model outage", flush=True)
    request(browser, f"/api/guest/tasks/{task}", 202, method="DELETE")

    outage(browser)

    archive = io.BytesIO()
    with zipfile.ZipFile(archive, "w", zipfile.ZIP_DEFLATED) as zipped:
        zipped.writestr("first.docx", docx())
        zipped.writestr("folder/second.txt", "Synthetic resume. Python development experience and testing of business applications.")
        zipped.writestr("unsupported.exe", b"synthetic unsupported input")
        zipped.writestr("corrupted.docx", b"synthetic invalid DOCX content")
    task = guest_submit(browser, "synthetic.zip", archive.getvalue())
    result = completed(browser, task)
    assert result["candidate_count"] == 2, result
    assert result["completed_count"] == 2, result
    assert result["status"] == "partially_completed", result
    assert len(result["results"]) == 2
    assert all(r["evaluations"][0]["score"] == 100 for r in result["results"])
    print("PASS real ZIP prepare -> two evaluate jobs, with unsupported/corrupted-entry errors", flush=True)
    request(browser, f"/api/guest/tasks/{task}", 202, method="DELETE")

    with fitz.open() as pdf:
        pdf.new_page().insert_text((30, 40), "Synthetic resume. Python development experience and testing of business applications.")
        content = pdf.tobytes()
    task = guest_submit(browser, "synthetic.pdf", content)
    result = completed(browser, task)
    assert result["status"] == "completed", result
    assert result["results"][0]["evaluations"][0]["score"] == 100
    print("PASS single PDF prepare, reuse of input and real PDF text evaluation", flush=True)
    request(browser, f"/api/guest/tasks/{task}", 202, method="DELETE")

    with fitz.open() as pdf:
        for text in ("Иванов Иван Иванович\nPython разработка и тестирование бизнес-приложений. Опыт в учебном проекте.",
                     "Продолжение опыта работы\nPython разработка и тестирование приложений.",
                     "Петров Петр Петрович\nPython разработка и тестирование бизнес-приложений. Опыт в учебном проекте."):
            page = pdf.new_page()
            page.insert_font(fontname="resume", fontfile="/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf")
            page.insert_text((30, 40), text, fontname="resume")
        content = pdf.tobytes()
    task = guest_submit(browser, "synthetic-multiple.pdf", content)
    result = completed(browser, task)
    assert result["status"] == "completed", result
    assert result["candidate_count"] == 2 and result["completed_count"] == 2, result
    assert {r["candidate"]["last_name"] for r in result["results"]} == {"Иванов", "Петров"}
    print("PASS real multipage PDF separation and two independently evaluated candidates", flush=True)
    request(browser, f"/api/guest/tasks/{task}", 202, method="DELETE")

    with fitz.open() as pdf:
        pdf.new_page()
        content = pdf.tobytes()
    task = guest_submit(browser, "synthetic-no-text.pdf", content)
    result = completed(browser, task)
    assert result["status"] == "failed", result
    print("PASS unreadable PDF produces a permanent document error", flush=True)
    request(browser, f"/api/guest/tasks/{task}", 202, method="DELETE")


def authorized(browser):
    request(browser, "/api/auth/login", method="POST", json={"login": os.environ["HR_PROCESSOR_TEST_LOGIN"], "password": "synthetic-processor-password-only"})
    wait_availability(browser, True, "authorized")
    model_control(False)
    try:
        assert wait_availability(browser, False, "authorized")["model_ready"] is False
    finally:
        model_control(True)
    wait_availability(browser, True, "authorized")
    cluster = request(browser, "/api/app/clusters", 201, method="POST", json={"name": "Synthetic processor test " + str(uuid.uuid4()), "track": "test"})
    request(browser, "/api/app/profiles", 201, method="POST", json={"cluster_id": cluster["id"], "position_name": "Synthetic developer",
        "education": "", "experience": "", "keywords": ["Python"], "stop_factors": [], "comment": ""})
    task = request(browser, "/api/app/candidates", 202, method="POST",
        data={"last_name": "Синтетический", "first_name": "Кандидат"}, files={"resume": ("synthetic.docx", docx())})
    result = completed(browser, task["id"], "authorized")
    assert result["processed_files"] == 1, result
    assert result["items"][0]["resume_id"], result
    overview = request(browser, "/api/app/overview")
    assert any(c["ratings"] for c in overview["candidates"]), "Authorized ratings were not persisted"
    print("PASS same evaluator consumes authorized vhost and backend persists resume and scores", flush=True)


if __name__ == "__main__":
    browser = requests.Session()
    browser.headers["Origin"] = ORIGIN
    (guest if sys.argv[1] == "guest" else authorized)(browser)
