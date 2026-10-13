"""Smoke test of the real model through the running analyzer; no DB writes."""
import io
import json
import time

import fitz
import requests
from docx import Document

BASE = "http://127.0.0.1:8000"
MODEL = "qwen3.5:4b-q4_K_M"
CLUSTER = "5cabfa83-676b-4084-9ec8-212658478b6b"
PROFILE = "d5ebfa74-a6f9-44aa-9b93-43ce2d62fbfb"
TEXT = "Fictional test candidate. Computer science degree. Five years of Python and SQL development. Builds REST APIs and writes automated tests."
requirements = {"clusters": [{"id": CLUSTER, "name": "Software engineering",
    "comment": "Evaluate the listed skills and experience.", "profiles": [{
        "id": PROFILE, "position_name": "Python developer", "education": "Computer science",
        "experience": "At least three years of development", "keywords": ["Python", "SQL"],
        "stop_factors": [], "comment": "Experience with REST APIs and automated testing",
    }]}]}

ready = requests.get(BASE + "/ready", timeout=5)
assert ready.status_code == 200 and ready.json()["available"], "Model is not ready"

docx = Document()
docx.add_paragraph(TEXT)
docx_buffer = io.BytesIO()
docx.save(docx_buffer)
with fitz.open() as pdf:
    page = pdf.new_page()
    page.insert_textbox(fitz.Rect(50, 50, 550, 750), TEXT)
    pdf_bytes = pdf.tobytes()

for filename, data in [("synthetic.docx", docx_buffer.getvalue()), ("synthetic.pdf", pdf_bytes)]:
    start = time.monotonic()
    response = requests.post(BASE + "/rank", files={"file": (filename, data)},
                             data={"requirements": json.dumps(requirements)}, timeout=240)
    assert response.status_code == 200, f"{filename}: HTTP {response.status_code}: {response.text[:300]}"
    result = response.json()
    assert len(result["clusters"]) == 1 and result["clusters"][0]["id"] == CLUSTER
    profiles = result["clusters"][0]["profiles"]
    assert len(profiles) == 1 and profiles[0]["id"] == PROFILE
    rating = profiles[0]
    assert 0 <= rating["score"] <= 100
    assert rating["explanation"].strip()
    assert rating["details"]["model"] == MODEL
    assert isinstance(rating["matched_keywords"], list)
    print(json.dumps({"file": filename, "score": rating["score"], "model": MODEL,
                      "elapsed_seconds": round(time.monotonic() - start, 2)}, ensure_ascii=True), flush=True)
