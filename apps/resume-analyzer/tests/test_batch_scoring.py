"""Joint assessment completeness, evidence integrity and model-call budget."""

import json
import re
import unittest
from unittest.mock import patch

from app.analysis_checkpoints import analysis_checkpoints
from app.analysis_service import analyze_resume_text
from app.batch_scoring import (
    BatchResponseError, STRATEGY_VERSION, Task, compile_tasks, evidence_lines,
    parse_batch_response, prepare_batches, response_schema,
)
from app.config import settings
from app.evidence_scoring import validate_rating_source, verify_and_score
from app.ollama_client import ModelTimeout
from app.rank_models import RequirementsRequest
from app.readiness import mark_ready


TEXT = "Резюме кандидата\nPython. SQL. Git.\nРазработчик — 1 год 3 месяца\nБакалавр, Университет\nГотов к переезду."


def requirements(count=2):
    return RequirementsRequest.model_validate({"clusters": [{"id": "c", "name": "IT", "comment": "Работа в команде",
        "profiles": [{"id": str(index), "position_name": "Developer" if index == 0 else f"Role {index}",
            "keywords": ["Python", "SQL"], "education": "Высшее", "experience": "От 3 лет"}
            for index in range(count)]}]})


def unknown_response(**kwargs):
    return {"response": json.dumps({key: "u" for key in kwargs["json_schema"]["required"]})}


class BatchScoringTests(unittest.TestCase):
    def setUp(self):
        analysis_checkpoints.clear()
        mark_ready(True)

    def tearDown(self):
        analysis_checkpoints.clear()
        mark_ready(False)

    def test_shared_education_and_cluster_requirements_but_role_specific_experience(self):
        req = requirements()
        tasks, bindings = compile_tasks(req)
        self.assertEqual(len(tasks), 4)
        self.assertEqual(bindings[0].criteria["education:0"], bindings[1].criteria["education:0"])
        self.assertEqual(bindings[0].criteria["cluster_comment:0"], bindings[1].criteria["cluster_comment:0"])
        self.assertNotEqual(bindings[0].criteria["experience:0"], bindings[1].criteria["experience:0"])
        self.assertFalse(any(t.category == "keyword" for t in tasks))
        req.clusters[0].profiles[0].education = "Профильное образование"
        req.clusters[0].profiles[1].education = "Профильное образование"
        _, relative = compile_tasks(req)
        self.assertNotEqual(relative[0].criteria["education:0"], relative[1].criteria["education:0"])

    def test_one_model_call_returns_all_33_profiles_with_original_ids_and_weights(self):
        req = requirements(33)
        with patch("app.batch_scoring.ask_ollama_chat", side_effect=unknown_response) as model:
            result = analyze_resume_text(TEXT, req, "joint-33")
        model.assert_called_once()
        self.assertEqual([p.id for p in result.clusters[0].profiles], [str(i) for i in range(33)])
        for original, profile in zip(req.clusters[0].profiles, result.clusters[0].profiles):
            expected = verify_and_score({"assessments": [], "stop_factors": []}, TEXT, original,
                                        req.clusters[0].comment, model=profile.details["model"])
            self.assertEqual(profile.model_dump(exclude={"id", "position_name"}), expected)
            validate_rating_source(profile.model_dump(), TEXT)
            self.assertEqual(sum(c["weight"] for c in profile.details["criteria"]), 10000)
            self.assertEqual(profile.details["method"], "evidence-v3")
            self.assertNotIn("score_range", profile.details)

    def test_line_references_restore_literal_quotes_and_do_not_transfer_experience_between_roles(self):
        req = requirements()
        tasks, bindings = compile_tasks(req)
        values = {t.id: "u" for t in tasks}
        values[bindings[0].criteria["experience:0"]] = "m:2"
        values[bindings[0].criteria["education:0"]] = "m:3"
        with patch("app.batch_scoring.ask_ollama_chat", return_value={"response": json.dumps(values)}):
            result = analyze_resume_text(TEXT, req, "quotes")
        first, second = result.clusters[0].profiles
        first_exp = next(c for c in first.details["criteria"] if c["category"] == "experience")
        second_exp = next(c for c in second.details["criteria"] if c["category"] == "experience")
        self.assertEqual(first_exp["status"], "partial")
        self.assertEqual(first_exp["experience_months"], 15)
        self.assertEqual(first_exp["required_months"], 36)
        self.assertEqual(first_exp["evidence"][0]["quote"], "Разработчик — 1 год 3 месяца")
        self.assertEqual(second_exp["status"], "unknown")
        for profile in (first, second):
            validate_rating_source(profile.model_dump(), TEXT)

    def test_keyword_only_profiles_make_no_model_calls(self):
        req = requirements(30)
        req.clusters[0].comment = None
        for p in req.clusters[0].profiles:
            p.education = p.experience = None
        with patch("app.batch_scoring.ask_ollama_chat") as model:
            result = analyze_resume_text(TEXT, req, "rules")
        model.assert_not_called()
        self.assertTrue(all(p.score == 100 and p.details["model"] == "rules" for p in result.clusters[0].profiles))

    def test_completed_batches_survive_infrastructure_retry_and_retain_productive_duration(self):
        req = requirements(4)
        clock, completed, failed = [0], [], [False]

        def respond(**kwargs):
            clock[0] += 1
            if kwargs["profile_id"] == "batch:1" and not failed[0]:
                failed[0] = True
                raise ModelTimeout("Fixture infrastructure timeout")
            completed.append(kwargs["profile_id"])
            return unknown_response(**kwargs)

        with patch("app.batch_scoring.MAX_TASKS_PER_CALL", 2), \
             patch("app.batch_scoring.time.monotonic", side_effect=lambda: clock[0]), \
             patch("app.batch_scoring.ask_ollama_chat", side_effect=respond):
            with self.assertRaises(ModelTimeout):
                analyze_resume_text(TEXT, req, "first")
            result = analyze_resume_text(TEXT, req, "retry")
        self.assertEqual(completed, ["batch:0", "batch:1", "batch:2"])
        self.assertEqual(result._restored_duration_ms, 1000)
        self.assertEqual(len(result.clusters[0].profiles), 4)
        self.assertNotIn("_restored_duration_ms", result.model_dump())

    def test_invalid_references_retry_with_safe_diagnostic_reason(self):
        req = requirements(1)
        tasks, _ = compile_tasks(req)
        bad = {t.id: "u" for t in tasks}
        bad[tasks[0].id] = "m:99999"
        with patch("app.batch_scoring.ask_ollama_chat", side_effect=[{"response": json.dumps(bad)},
                unknown_response(json_schema=response_schema(tasks))]) as model, \
             patch("app.batch_scoring.log_event") as log:
            result = analyze_resume_text(TEXT, req, "retry-invalid")
        self.assertEqual(model.call_count, 2)
        errors = [c for c in log.call_args_list if c.args[2] == "batch_attempt_failed"]
        self.assertEqual(errors[0].kwargs["reason_code"], "unknown_or_duplicate_source_line")
        self.assertNotIn("response", errors[0].kwargs)
        self.assertNotIn("raw_response", errors[0].kwargs)
        self.assertEqual(len(result.clusters[0].profiles), 1)

    def test_late_response_is_not_accepted_or_cached(self):
        clock = [0]
        def late(**kwargs):
            clock[0] += 2
            return unknown_response(**kwargs)
        with patch("app.batch_scoring.time.monotonic", side_effect=lambda: clock[0]), \
             patch("app.batch_scoring.ask_ollama_chat", side_effect=late), \
             patch("app.analysis_service.RANK_TIMEOUT", 1):
            with self.assertRaises(ModelTimeout):
                analyze_resume_text(TEXT, requirements(), "late")
        self.assertEqual(analysis_checkpoints._bytes, 0)

    def test_long_source_truncation_is_explicit_for_all_profiles(self):
        source = TEXT + " long text" * 5000
        with patch.object(settings, "OLLAMA_NUM_CTX", 4096), \
             patch("app.batch_scoring.ask_ollama_chat", side_effect=unknown_response):
            result = analyze_resume_text(source, requirements(), "truncated")
        for profile in result.clusters[0].profiles:
            self.assertTrue(profile.details["context_truncated"])
            self.assertLess(profile.details["source_text_length"], len(source))
            validate_rating_source(profile.model_dump(), source)


class BatchWireTests(unittest.TestCase):
    def setUp(self):
        self.tasks = [Task("q0", "criterion", "education", "Высшее", ""),
                      Task("q1", "stop", "stop", "Отказ от переезда", "Role")]
        self.lines = ["Бакалавр", "Не готов к переезду"]

    def test_strict_status_codes_and_source_references(self):
        result = parse_batch_response('{"q0":"m:0","q1":"t:1"}', self.tasks, self.lines)
        self.assertEqual(result["q0"], {"status": "met", "evidence": ["Бакалавр"]})
        self.assertEqual(result["q1"], {"status": "triggered", "evidence": ["Не готов к переезду"]})
        for task in self.tasks:
            pattern = response_schema(self.tasks)["properties"][task.id]["pattern"]
            self.assertIsNotNone(re.fullmatch(pattern, "u"))
            self.assertIsNone(re.fullmatch(pattern, "met"))

    def test_incomplete_duplicate_ids_wrong_status_and_fabricated_references_are_errors(self):
        for value in ('{}', '{"q0":"u"}', '{"q0":"u","q1":"u","extra":"u"}',
                      '{"q0":"m:0","q0":"u","q1":"u"}', '{"q0":"met","q1":"u"}',
                      '{"q0":"t:0","q1":"u"}', '{"q0":"u","q1":"m:1"}',
                      '{"q0":"m:-1","q1":"u"}', '{"q0":"m:9","q1":"u"}',
                      '{"q0":"m:0,0","q1":"u"}', '{"q0":"m:0,1,0,1","q1":"u"}',
                      '{"q0":123,"q1":"u"}', '{"q0":true,"q1":"u"}', 'bad json'):
            with self.subTest(response=value), self.assertRaises(BatchResponseError):
                parse_batch_response(value, self.tasks, self.lines)

    def test_long_and_unicode_fragments_are_exact_substrings_of_source(self):
        source = "🙂 Образование\n" + "Дословный исходный фрагмент " * 80
        lines = evidence_lines(source)
        self.assertGreater(len(lines), 2)
        self.assertTrue(all(line in source and len(line) <= 400 for line in lines))
