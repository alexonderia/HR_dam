"""Readiness must survive long jobs without hiding an unavailable model."""

import unittest
from unittest.mock import patch

import requests

from app import readiness
from app.ollama_client import ModelUnavailable


class ReadinessTests(unittest.TestCase):
    def setUp(self):
        self.now = 1000.0
        self.clock = patch.object(readiness.time, "monotonic", side_effect=lambda: self.now)
        self.clock.start()
        readiness.mark_ready(True)

    def tearDown(self):
        self.clock.stop()
        readiness.mark_ready(False)
        self.assertFalse(readiness.model_lock.locked())

    def expire(self):
        self.now += readiness.INTERVAL + readiness.PROBE_TIMEOUT + 11

    def test_five_long_jobs_complete_without_waiting_for_monitor(self):
        completed = []
        with patch.object(readiness, "_probe_model", return_value=True) as probe:
            for job in range(5):
                with readiness.model_capacity():
                    self.now += 200
                    completed.append(job)
        self.assertEqual(completed, list(range(5)))
        self.assertEqual(probe.call_count, 4)

    def test_expired_readiness_rechecks_actual_model_availability(self):
        self.expire()
        with patch.object(readiness, "_probe_model", return_value=False) as probe:
            with self.assertRaises(ModelUnavailable):
                with readiness.model_capacity():
                    self.fail("An unavailable model must not receive a job")
        probe.assert_called_once_with()
        self.assertFalse(readiness.is_ready())

    def test_failed_probe_releases_capacity_and_allows_recovery(self):
        self.expire()
        with patch.object(readiness, "_probe_model", side_effect=requests.Timeout):
            with self.assertRaises(ModelUnavailable):
                with readiness.model_capacity():
                    self.fail("A timed out probe must not admit a job")
        self.assertFalse(readiness.model_lock.locked())
        self.expire()
        with patch.object(readiness, "_probe_model", return_value=True):
            with readiness.model_capacity():
                self.assertTrue(readiness.is_ready())

    def test_recent_unavailability_is_preserved(self):
        readiness.mark_ready(False)
        with patch.object(readiness, "_probe_model") as probe:
            with self.assertRaises(ModelUnavailable):
                with readiness.model_capacity():
                    self.fail("A recent failed probe must remain authoritative")
        probe.assert_not_called()

    def test_nested_capacity_does_not_probe_during_inference(self):
        with patch.object(readiness, "_probe_model") as probe:
            with readiness.model_capacity():
                self.expire()
                with readiness.model_capacity():
                    self.assertTrue(readiness.is_ready())
        probe.assert_not_called()


if __name__ == "__main__":
    unittest.main()
