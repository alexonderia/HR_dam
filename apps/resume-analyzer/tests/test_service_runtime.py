import asyncio
import json
import os
import threading
import unittest
from concurrent.futures import ThreadPoolExecutor
from unittest.mock import patch

from app.candidate_extractor import extract_contacts
from app.config import settings
from app.consumer import resolve_delivery
from app.document_loader import DocumentTemporaryError, DownloadLinkTemporaryError
from app.errors import DocumentTextError, InsufficientResumeTextError, JobCancelled
from app.job_result import failed_result, http_error, processing_event
from app.job_status import JobStatusTemporaryError
from app.main import app, health_check, lifespan, readiness
from app.ollama_client import ModelUnavailable, ModelTimeout, ModelResponseError
from app.pipeline import process_document
from app.rank_models import RequirementsRequest, RankResponse
from app.readiness import mark_ready, model_lock
from app.analysis_service import analyze_resume_text
from app.analysis_checkpoints import analysis_checkpoints
from app.runtime import runtime_status, update_runtime

JOB = dict(version=1, job_id="job", batch_id="batch", item_id="item", attempt=1)
REQUIREMENTS = RequirementsRequest.model_validate({"clusters": [{"id": "c", "name": "Test", "profiles": [{"id": "p", "position_name": "Analyst"}]}]})
RATING = RankResponse.model_validate({"clusters": [{"id": "c", "name": "Test", "profiles": [{"id": "p", "position_name": "Analyst", "score": 0, "explanation": "Test"}]}]})
DOCUMENT = ("Resume text " * 10, extract_contacts(""))


class ServiceRuntimeTests(unittest.TestCase):
    def setUp(self):
        analysis_checkpoints.clear()
        mark_ready(True)
        update_runtime(broker_connected=False, consumer_alive=False, stopping=False, busy=False)

    def tearDown(self):
        analysis_checkpoints.clear()
        mark_ready(False)
        update_runtime(broker_connected=False, consumer_alive=False, stopping=False, busy=False)
        self.assertFalse(model_lock.locked())

    def test_native_model_broker_liveness_and_busy_are_independent(self):
        with patch.object(settings, "ANALYZER_ADAPTER", "amqp"):
            update_runtime(consumer_alive=True, broker_connected=True)
            mark_ready(False)
            self.assertEqual(health_check(), {"ok": True})
            self.assertEqual(readiness().status_code, 503)
            self.assertFalse(json.loads(readiness().body)["model_ready"])
            mark_ready(True)
            update_runtime(busy=True)
            self.assertEqual(readiness().status_code, 200)
            self.assertTrue(json.loads(readiness().body)["busy"])
            update_runtime(broker_connected=False)
            self.assertEqual(health_check(), {"ok": True})
            self.assertEqual(readiness().status_code, 503)
            update_runtime(consumer_alive=False)
            self.assertEqual(health_check().status_code, 503)

    def test_infrastructure_never_exhausts_document_retries(self):
        errors = [ModelUnavailable(), ModelTimeout(), JobStatusTemporaryError(), DocumentTemporaryError(), DownloadLinkTemporaryError()]
        for error in errors:
            for retries in (0, 5, 100):
                self.assertEqual(resolve_delivery(JOB, retries, error=error), {"action": "retry", "retries": retries})
        self.assertEqual(resolve_delivery(JOB, 5, error=JobCancelled()), {"action": "requeue"})
        self.assertEqual(resolve_delivery(JOB, 0, error=ModelResponseError())["retries"], 1)
        self.assertEqual(resolve_delivery(JOB, 5, error=ModelResponseError())["result"]["status"], "failed")

    def test_http_and_amqp_share_safe_document_and_model_errors(self):
        for error in (DocumentTextError(), InsufficientResumeTextError(), ModelUnavailable(), ModelTimeout(), ModelResponseError()):
            self.assertEqual(http_error(error)[1], failed_result(JOB, error)["error"]["message"])

    def test_duration_excludes_capacity_wait(self):
        with patch("app.pipeline.prepare_resume_document", return_value=DOCUMENT), \
             patch("app.pipeline.monotonic", side_effect=[0, .2, 100.2, 100.5]):
            result = process_document(b"file", "resume.txt", REQUIREMENTS, "job", analyze=lambda **_: RATING)
        self.assertEqual(result.analysis_duration_ms, 500)

    def test_duration_includes_successful_work_restored_from_interrupted_analysis(self):
        restored = RATING.model_copy(deep=True)
        restored._restored_duration_ms = 2000
        with patch("app.pipeline.prepare_resume_document", return_value=DOCUMENT), \
             patch("app.pipeline.monotonic", side_effect=[0, .2, 100.2, 100.5]):
            result = process_document(b"file", "resume.txt", REQUIREMENTS, "job", analyze=lambda **_: restored)
        self.assertEqual(result.analysis_duration_ms, 2500)
        self.assertNotIn("_restored_duration_ms", result.model_dump())

    def test_shared_capacity_serializes_concurrent_documents(self):
        entered = threading.Event()
        release = threading.Event()
        second_prepared = threading.Event()
        prepared = []
        seen = []

        def prepare(*args):
            prepared.append(True)
            if len(prepared) == 2:
                second_prepared.set()
            return DOCUMENT

        def analyze(**kwargs):
            seen.append(kwargs["job_id"])
            if kwargs["job_id"] == "first":
                entered.set()
                self.assertTrue(release.wait(2))
            return RATING

        with patch("app.pipeline.prepare_resume_document", side_effect=prepare), ThreadPoolExecutor(max_workers=2) as executor:
            first = executor.submit(process_document, b"file", "resume.txt", REQUIREMENTS, "first", analyze=analyze)
            self.assertTrue(entered.wait(1))
            self.assertTrue(runtime_status(True)["busy"])
            second = executor.submit(process_document, b"file", "resume.txt", REQUIREMENTS, "second", analyze=analyze)
            self.assertTrue(second_prepared.wait(1))
            self.assertEqual(seen, ["first"])
            release.set()
            first.result(timeout=2)
            second.result(timeout=2)
        self.assertEqual(seen, ["first", "second"])
        self.assertFalse(runtime_status(True)["busy"])

    def test_shutdown_cancels_after_joint_model_call(self):
        requirements = REQUIREMENTS.model_copy(deep=True)
        requirements.clusters[0].profiles[0].education = "Degree"
        profile = requirements.clusters[0].profiles[0].model_copy(update={"id": "second"})
        requirements.clusters[0].profiles.append(profile)
        stop = threading.Event()

        def cancel():
            if stop.is_set():
                raise JobCancelled()

        def rank(*args, **kwargs):
            stop.set()
            return {"response": json.dumps({key: "u" for key in kwargs["json_schema"]["required"]})}

        with patch("app.pipeline.prepare_resume_document", return_value=DOCUMENT), \
             patch("app.batch_scoring.ask_ollama_chat", side_effect=rank) as model:
            with self.assertRaises(JobCancelled):
                process_document(b"file", "resume.txt", requirements, "job", cancel, analyze_resume_text)
            self.assertEqual(model.call_count, 1)

    def test_invalid_adapter_and_multiple_workers_are_rejected(self):
        with patch.dict(os.environ, {"RABBITMQ_ENABLED": "true", "RANK_BRIDGE_ENABLED": "true"}), \
             patch.object(settings, "ANALYZER_ADAPTER", "amqp"):
            with self.assertRaisesRegex(ValueError, "RANK_BRIDGE_ENABLED=false"):
                settings.validate()
        with patch.dict(os.environ, {"WEB_CONCURRENCY": "2"}), patch.object(settings, "ANALYZER_ADAPTER", "http"):
            with self.assertRaisesRegex(ValueError, "one process"):
                settings.validate()

    def test_progress_uses_moscow_timezone(self):
        self.assertTrue(processing_event(JOB)["created_at"].endswith("+03:00"))


class NativeLifecycleTests(unittest.IsolatedAsyncioTestCase):
    async def test_lifecycle_owns_and_joins_native_consumer(self):
        connected = threading.Event()
        stopped = threading.Event()

        def monitor(stop):
            mark_ready(True)
            stop.wait(2)

        def consumer(stop):
            update_runtime(consumer_alive=True, broker_connected=True)
            connected.set()
            stop.wait(2)
            update_runtime(consumer_alive=False, broker_connected=False)
            stopped.set()

        with patch.object(settings, "ANALYZER_ADAPTER", "amqp"), \
             patch.object(settings, "RESUME_ANALYZER_CALLBACK_TOKEN", "test"), \
             patch.dict(os.environ, {"RABBITMQ_ENABLED": "true", "RANK_BRIDGE_ENABLED": "false"}), \
             patch("app.main.monitor", side_effect=monitor), patch("app.consumer.run_consumer", side_effect=consumer):
            async with lifespan(app):
                self.assertTrue(await asyncio.to_thread(connected.wait, 1))
                self.assertEqual(readiness().status_code, 200)
            self.assertTrue(stopped.is_set())
            self.assertFalse(runtime_status(False)["consumer_alive"])
