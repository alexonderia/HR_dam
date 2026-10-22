"""Regressions for redundant model work and full-analysis timeout loops."""

import json
import unittest
from unittest.mock import patch

from app.analysis_checkpoints import AnalysisCheckpoints, analysis_checkpoints
from app.analysis_service import analyze_resume_text, checkpoint_key
from app.config import settings
from app.evidence_scoring import verify_and_score
from app.ollama_client import ModelTimeout, ModelResponseError
from app.rank_models import ProfileRequest, RequirementsRequest, RankResponse
from app.readiness import mark_ready
from app.scoring import build_ranking_prompt, rank_profile, response_token_budget, parse_model_response


TEXT = "Python developer. Built REST APIs using SQL and Git. Two years of experience."
EMPTY = {"assessments": [], "stop_factors": []}


class AnalysisPerformanceTests(unittest.TestCase):
    def setUp(self):
        analysis_checkpoints.clear()
        mark_ready(True)

    def tearDown(self):
        analysis_checkpoints.clear()
        mark_ready(False)

    def requirements(self, count=3):
        return RequirementsRequest.model_validate({"clusters": [{"id": "cluster", "name": "Test",
            "profiles": [{"id": str(i), "position_name": f"Role {i}", "keywords": ["Python", "SQL"],
                          "education": "Degree"} for i in range(count)]}]})

    def test_keywords_are_checked_from_full_source_without_model_requests(self):
        profile = ProfileRequest(id="p", position_name="Developer", keywords=["Python", "SQL", "Git", "Java"])
        text = "Нет Python. Изучаю SQL. Git. JavaScript."
        expected = verify_and_score(EMPTY, text, profile, model="rules")
        with patch("app.scoring.ask_ollama_chat") as model:
            self.assertEqual(rank_profile(text, profile), expected)
        model.assert_not_called()
        self.assertEqual([c["status"] for c in expected["details"]["criteria"]],
                         ["not_met", "partial", "met", "unknown"])

    def test_only_semantic_criteria_and_stops_go_to_model_but_all_criteria_are_scored(self):
        profile = ProfileRequest(id="p", position_name="Developer", keywords=["Python", "SQL"],
                                 education="Degree", stop_factors=["Refuses relocation"])
        response = {"assessments": [{"id": "education:0", "status": "unknown", "evidence": []}],
                    "stop_factors": [{"id": "stop:0", "status": "unknown", "evidence": []}]}
        with patch("app.scoring.ask_ollama_chat", return_value={"response": json.dumps(response)}) as model:
            result = rank_profile(TEXT, profile)
        model.assert_called_once()
        self.assertNotIn("keyword:", model.call_args.kwargs["user_prompt"])
        self.assertEqual(result["matched_keywords"], ["Python", "SQL"])
        self.assertEqual(len(result["details"]["criteria"]), 3)
        self.assertEqual(len(result["details"]["stop_factors"]), 1)
        self.assertEqual(result, verify_and_score(response, TEXT, profile, model=result["details"]["model"]))

    def test_document_prefix_and_system_prompt_are_shared_across_profiles(self):
        first, second = self.requirements().clusters[0].profiles[:2]
        a, b = build_ranking_prompt(TEXT, first), build_ranking_prompt(TEXT, second)
        self.assertEqual(a[0], b[0])
        self.assertEqual(a[1].split("Должность:")[0], b[1].split("Должность:")[0])
        self.assertIn(TEXT, a[1].split("Должность:")[0])
        self.assertNotIn('"$defs"', a[0])
        with patch.object(settings, "OLLAMA_MAX_TOKENS", 1000):
            self.assertLessEqual(response_token_budget(first), 1000)

    def test_compact_model_response_restores_full_evidence_contract(self):
        profile = ProfileRequest(id="p", position_name="Developer", keywords=["Python", "SQL"],
                                 education="Degree", stop_factors=["Refuses relocation"])
        compact = {"c0": ["unknown"], "s0": ["unknown"]}
        full = {"assessments": [{"id": "education:0", "status": "unknown", "evidence": []}],
                "stop_factors": [{"id": "stop:0", "status": "unknown", "evidence": []}]}
        self.assertEqual(parse_model_response(json.dumps(compact), profile), full)
        with patch("app.scoring.ask_ollama_chat", return_value={"response": json.dumps(compact)}) as model:
            result = rank_profile(TEXT, profile)
        self.assertEqual(set(model.call_args.kwargs["json_schema"]["required"]), {"c0", "s0"})
        self.assertEqual(result, verify_and_score(full, TEXT, profile, model=result["details"]["model"]))

    def test_compact_model_response_requires_all_keys_valid_statuses_and_quotes(self):
        profile = self.requirements(1).clusters[0].profiles[0]
        for invalid in ({}, {"c0": []}, {"c0": ["maybe"]}, {"c0": ["met", 123]},
                        {"c0": ["unknown"], "invented": ["unknown"]}, {"c0": "unknown"},
                        {"c0": ["met", "one", "two", "three", "four"]}):
            with self.subTest(response=invalid):
                self.assertIsNone(parse_model_response(json.dumps(invalid), profile))

    def test_33_profiles_use_one_joint_model_call(self):
        requirements = self.requirements(33)
        def respond(**kwargs):
            return {"response": json.dumps({key: "u" for key in kwargs["json_schema"]["required"]})}
        with patch("app.batch_scoring.ask_ollama_chat", side_effect=respond) as model:
            result = analyze_resume_text(TEXT, requirements, "joint")
        model.assert_called_once()
        self.assertEqual(len(result.clusters[0].profiles), 33)
        self.assertEqual(result._restored_duration_ms, 0)
        self.assertNotIn("_restored_duration_ms", result.model_dump())
        # A later explicit reevaluation is fresh after the completed analysis.
        with patch("app.batch_scoring.ask_ollama_chat", side_effect=respond) as model:
            analyze_resume_text(TEXT, requirements, "fresh")
        model.assert_called_once()

    def test_changed_input_invalidates_interrupted_results(self):
        requirements = self.requirements()
        key = checkpoint_key(TEXT, requirements)
        changed = requirements.model_copy(deep=True)
        changed.clusters[0].profiles[0].education = "Different degree"
        self.assertNotEqual(key, checkpoint_key(TEXT, changed))
        changed = requirements.model_copy(deep=True)
        changed.clusters[0].comment = "New cluster requirement"
        self.assertNotEqual(key, checkpoint_key(TEXT, changed))
        self.assertNotEqual(key, checkpoint_key(TEXT + " Changed.", requirements))
        for setting in ("MODEL", "POLICY_VERSION"):
            with patch(f"app.analysis_service.{setting}", "different"):
                self.assertNotEqual(key, checkpoint_key(TEXT, requirements))

    def test_unverified_result_is_never_restored(self):
        requirements = self.requirements(1)
        wrong = verify_and_score(EMPTY, TEXT + " wrong source", requirements.clusters[0].profiles[0])
        result = RankResponse.model_validate({"clusters": [{"id": "cluster", "name": "Test", "profiles": [
            {"id": "0", "position_name": "Role 0", **wrong}]}]})
        with patch("app.analysis_service.rank_requirements", return_value=result):
            with self.assertRaises(ModelResponseError):
                analyze_resume_text(TEXT, requirements, "bad")
        self.assertIsNone(analysis_checkpoints.get(checkpoint_key(TEXT, requirements), (0, 0)))

    def test_long_response_retries_with_larger_budget_instead_of_repeating_truncation(self):
        profile = self.requirements(1).clusters[0].profiles[0]
        response = {"assessments": [{"id": "education:0", "status": "unknown", "evidence": []}],
                    "stop_factors": []}
        budget = response_token_budget(profile)
        with patch("app.scoring.ask_ollama_chat", side_effect=[
            {"response": '{"assessments":[', "generated_tokens": budget},
            {"response": json.dumps(response)},
        ]) as model:
            result = rank_profile(TEXT, profile)
        self.assertEqual(model.call_count, 2)
        self.assertGreater(model.call_args_list[1].kwargs["max_tokens"], budget)
        self.assertEqual(len(result["details"]["criteria"]), 3)

    def test_context_truncation_remains_explicit_and_quotes_stay_in_source(self):
        profile = self.requirements(1).clusters[0].profiles[0]
        text = TEXT + " long resume" * 3000
        response = {"assessments": [{"id": "education:0", "status": "unknown", "evidence": []}],
                    "stop_factors": []}
        with patch.object(settings, "OLLAMA_NUM_CTX", 4096), \
             patch("app.scoring.ask_ollama_chat", return_value={"response": json.dumps(response)}):
            result = rank_profile(text, profile)
        self.assertTrue(result["details"]["context_truncated"])
        self.assertLess(result["details"]["source_text_length"], len(text))
        self.assertEqual(result["matched_keywords"], ["Python", "SQL"])


class CheckpointBoundsTests(unittest.TestCase):
    def test_size_and_job_count_are_bounded_and_results_are_copied(self):
        cache = AnalysisCheckpoints(max_items=2, max_bytes=100)
        cache.put("a", 0, {"score": 1}, duration_ms=1000)
        cache.get("a", 0)["score"] = 99
        self.assertEqual(cache.get("a", 0)["score"], 1)
        self.assertEqual(cache.duration_ms("a", 0), 1000)
        cache.put("b", 0, {"score": 2})
        cache.put("c", 0, {"score": 3})
        self.assertIsNone(cache.get("a", 0))
        cache.put("c", 1, {"value": "x" * 70})
        self.assertLessEqual(cache._bytes, 100)
        cache.put("oversized", 0, {"value": "x" * 200})
        self.assertIsNone(cache.get("oversized", 0))
        cache.clear()
        self.assertEqual(cache._bytes, 0)

    def test_expired_progress_is_removed(self):
        cache = AnalysisCheckpoints(ttl_seconds=10)
        with patch("app.analysis_checkpoints.time.monotonic", return_value=0):
            cache.put("a", 0, {"score": 1})
        with patch("app.analysis_checkpoints.time.monotonic", return_value=11):
            self.assertIsNone(cache.get("a", 0))
        self.assertEqual(cache._bytes, 0)
