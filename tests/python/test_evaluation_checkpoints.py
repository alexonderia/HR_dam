import copy
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch
from uuid import uuid4

from test_processing_v2 import FakeAPI, metadata
from processing_runtime.protocol import RetryJob
from resume_evaluator.evaluator import evaluate
from resume_evaluator.ollama_client import ModelTimeout
from resume_evaluator.evidence_scoring import verify_and_score
from resume_evaluator.readiness import mark_ready
import resume_evaluator.evaluator as evaluator_module


class CheckpointTests(unittest.TestCase):
    def setup_case(self, directory):
        source = Path(directory) / "input.txt"
        source.write_text("Синтетическое резюме: работаю с Python. Знаю SQL. Разрабатываю приложения.")
        targets = [{"id": str(uuid4()), "name": keyword, "education":"", "experience":"",
            "keywords":[keyword], "stop_factors":[], "comment":"", "cluster_comment":""} for keyword in ("Python", "SQL")]
        value = {**metadata("input.txt"), "assessment_date":"2026-11-13", "requirements":{"targets":targets}}
        mark_ready(True)
        return source, value, FakeAPI("evaluate")

    def score(self, text, profile, comment, **kwargs):
        return verify_and_score({"assessments":[{"id":"keyword:0:0", "status":"met", "evidence":[profile.keywords[0]]}],
            "stop_factors":[]}, text, profile, comment, assessment_date=kwargs.get("assessment_date"))

    def test_later_failure_resumes_without_rescoring_completed_profile(self):
        with tempfile.TemporaryDirectory() as directory:
            source, value, api = self.setup_case(directory)
            calls = []
            def score(text, profile, comment, **kwargs):
                calls.append(profile.id)
                if len(calls) == 2:
                    raise ModelTimeout()
                return self.score(text, profile, comment, **kwargs)
            with self.assertRaises(RetryJob):
                evaluate(api, value, source, Path(directory), score)
            self.assertEqual(len(api.saved_checkpoints["evaluations"]), 1)
            first = copy.deepcopy(api.saved_checkpoints["evaluations"][0])
            value["evaluation_checkpoints"] = copy.deepcopy(api.saved_checkpoints)
            result = evaluate(api, value, source, Path(directory), score)
            self.assertEqual(calls, [value["requirements"]["targets"][i]["id"] for i in (0, 1, 1)])
            self.assertEqual(result["evaluations"][0], first)
            self.assertEqual(len(result["evaluations"]), 2)
            # A replay with all checkpoints never needs model capacity or calls.
            value["evaluation_checkpoints"] = copy.deepcopy(api.saved_checkpoints)
            with patch("resume_evaluator.evaluator.model_capacity", side_effect=AssertionError("model must not be used")):
                replay = evaluate(api, value, source, Path(directory), score)
            self.assertEqual(replay, result)

    def test_changed_source_requirements_model_or_job_never_reuses_checkpoint(self):
        for changed in ("source", "requirements", "model", "policy", "implementation", "job", "date"):
            with self.subTest(changed=changed), tempfile.TemporaryDirectory() as directory:
                source, value, api = self.setup_case(directory)
                evaluate(api, value, source, Path(directory), self.score)
                value["evaluation_checkpoints"] = copy.deepcopy(api.saved_checkpoints)
                if changed == "source": source.write_text(source.read_text() + " Новый текст.")
                if changed == "requirements": value["requirements"]["targets"][0]["comment"] = "Новые требования"
                if changed == "job": api.job.command["job_id"] = str(uuid4())
                if changed == "date": value["assessment_date"] = "2026-11-14"
                from unittest.mock import Mock
                scorer = Mock(side_effect=self.score)
                changes = {name: "changed-" + name if changed == key else getattr(evaluator_module, name)
                    for key, name in (("model", "MODEL"), ("policy", "POLICY_VERSION"), ("implementation", "IMPLEMENTATION_REVISION"))}
                with patch.multiple(evaluator_module, **changes):
                    result = evaluate(api, value, source, Path(directory), scorer)
                self.assertEqual(scorer.call_count, 2)
                self.assertEqual(len(result["evaluations"]), 2)

    def test_checkpoint_ack_loss_does_not_force_model_to_repeat_saved_work(self):
        with tempfile.TemporaryDirectory() as directory:
            source, value, api = self.setup_case(directory)
            save = api.checkpoint
            def lost_reply(context, evaluation):
                save(context, evaluation)
                raise RetryJob()
            with patch.object(api, "checkpoint", side_effect=lost_reply), self.assertRaises(RetryJob):
                evaluate(api, value, source, Path(directory), self.score)
            value["evaluation_checkpoints"] = copy.deepcopy(api.saved_checkpoints)
            from unittest.mock import Mock
            scorer = Mock(side_effect=self.score)
            evaluate(api, value, source, Path(directory), scorer)
            self.assertEqual(scorer.call_count, 1)

    def test_execution_starts_only_after_model_capacity_is_acquired(self):
        from contextlib import contextmanager
        with tempfile.TemporaryDirectory() as directory:
            source,value,api=self.setup_case(directory)
            events=[]
            @contextmanager
            def capacity(check_cancelled):
                events.append('capacity')
                yield
            def progress():
                self.assertEqual(events,['capacity'])
                events.append('start')
            api.progress=progress
            def scorer(*args,**kwargs):
                self.assertIn('start',events)
                return self.score(*args,**kwargs)
            with patch('resume_evaluator.evaluator.model_capacity',side_effect=capacity):
                evaluate(api,value,source,Path(directory),scorer)
            self.assertEqual(events,['capacity','start'])

    def test_busy_model_does_not_start_the_execution_timer(self):
        from unittest.mock import Mock
        from resume_evaluator.readiness import ModelBusy
        with tempfile.TemporaryDirectory() as directory:
            source,value,api=self.setup_case(directory)
            api.progress=Mock()
            with patch('resume_evaluator.evaluator.model_capacity',side_effect=ModelBusy()):
                with self.assertRaises(RetryJob):evaluate(api,value,source,Path(directory),self.score)
            api.progress.assert_not_called()
