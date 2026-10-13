import json
import unittest
from io import BytesIO
from unittest.mock import patch, Mock

import requests
from fastapi import HTTPException, UploadFile
from docx import Document

from app.main import rank_resume, health_check, readiness
from app.ollama_client import ask_ollama_chat, ModelUnavailable
from app.rank_models import ProfileRequest
from app.scoring import parse_ranking_response, rank_profile, build_ranking_prompt
from app.readiness import mark_ready
from app.text_extractor import extract_text_from_file


class AnalyzerTests(unittest.TestCase):
    def setUp(self):
        mark_ready(True)
        self.profile = ProfileRequest(id="profile", position_name="Разработчик", keywords=["Python"])
        self.requirements = json.dumps({"clusters": [{"id": "cluster", "name": "ИТ",
            "comment": "Общие требования", "profiles": [self.profile.model_dump()]}]})

    def tearDown(self):
        mark_ready(False)

    def upload(self):
        doc = Document()
        doc.add_paragraph("Python SQL developer with five years of experience")
        buf = BytesIO()
        doc.save(buf)
        buf.seek(0)
        return UploadFile(filename="resume.docx", file=buf)

    def test_parse_rejects_invalid_scores_and_arrays(self):
        for score in ["80", True, -1, 101, float("nan"), float("inf")]:
            self.assertIsNone(parse_ranking_response(json.dumps({"score": score, "explanation": "OK"})))
        self.assertIsNone(parse_ranking_response('{"score":50,"explanation":"OK","matched_keywords":"Python"}'))
        self.assertEqual(parse_ranking_response('```json\n{"score":80,"explanation":"OK"}\n```')["score"], 80)

    def test_model_network_failure_and_empty_response_are_errors(self):
        with patch("app.ollama_client.requests.post", side_effect=requests.Timeout):
            with self.assertRaises(ModelUnavailable):
                ask_ollama_chat("system", "resume")
        response = Mock()
        response.json.return_value = {"message": {"content": ""}}
        with patch("app.ollama_client.requests.post", return_value=response):
            with self.assertRaises(ModelUnavailable):
                ask_ollama_chat("system", "resume")

    def test_invalid_model_response_is_not_zero_rating(self):
        with patch("app.scoring.ask_ollama_chat", return_value={"response": "bad json"}):
            with self.assertRaises(ModelUnavailable):
                rank_profile("resume", self.profile)

    def test_stop_factors_and_cluster_requirements(self):
        rating = {"score": 80, "explanation": "Stop", "triggered_stop_factors": ["stop"]}
        with patch("app.scoring.ask_ollama_chat", return_value={"response": json.dumps(rating)}):
            self.assertEqual(rank_profile("resume", self.profile)["score"], 0)
        self.assertIn("Общие требования", build_ranking_prompt("resume", self.profile, "Общие требования")[1])

    def test_success_preserves_contract_and_details(self):
        rating = {"score": 80, "explanation": "OK", "details": {"method": "ollama-agent-v1"}}
        with patch("app.main.rank_profile", return_value=rating) as rank:
            result = rank_resume(self.upload(), self.requirements)
        self.assertEqual(result.clusters[0].profiles[0].score, 80)
        self.assertEqual(result.clusters[0].profiles[0].details["method"], "ollama-agent-v1")
        self.assertIn("Общие требования", rank.call_args.args[2])

    def test_partial_failure_returns_no_success_and_disables_analysis(self):
        req = json.loads(self.requirements)
        req["clusters"][0]["profiles"].append({**self.profile.model_dump(), "id": "second"})
        with patch("app.main.rank_profile", side_effect=[{"score": 80, "explanation": "OK"}, ModelUnavailable("offline")]):
            with self.assertRaises(HTTPException) as exc:
                rank_resume(self.upload(), json.dumps(req))
        self.assertEqual(exc.exception.status_code, 503)
        self.assertEqual(readiness().status_code, 503)
        self.assertEqual(health_check(), {"ok": True})

    def test_offline_and_recovery(self):
        mark_ready(False)
        with self.assertRaises(HTTPException) as exc:
            rank_resume(self.upload(), self.requirements)
        self.assertEqual(exc.exception.status_code, 503)
        self.assertEqual(health_check(), {"ok": True})
        mark_ready(True)
        self.assertEqual(readiness().status_code, 200)

    def test_input_errors_do_not_mark_model_unavailable(self):
        with self.assertRaises(HTTPException) as exc:
            rank_resume(self.upload(), "not json")
        self.assertEqual(exc.exception.status_code, 422)
        self.assertEqual(readiness().status_code, 200)

    def test_extracts_docx_table_text(self):
        doc = Document()
        doc.add_table(rows=1, cols=1).cell(0, 0).text = "Python SQL"
        buf = BytesIO()
        doc.save(buf)
        self.assertIn("Python SQL", extract_text_from_file(buf.getvalue(), "resume.docx"))


if __name__ == "__main__":
    unittest.main()
