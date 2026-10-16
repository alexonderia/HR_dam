import json
import logging
import unittest
from datetime import datetime, timezone

from app.logging_config import HumanFormatter, JsonFormatter


class MoscowLoggingTests(unittest.TestCase):
    def record(self, message):
        record = logging.LogRecord("app", logging.INFO, "", 0, message, (), None)
        record.created = datetime(2026, 10, 16, 23, 15, 0, 123456, tzinfo=timezone.utc).timestamp()
        return record

    def test_structured_log_uses_record_time_and_explicit_moscow_offset(self):
        result = json.loads(JsonFormatter().format(self.record('{"event":"rank_job_completed"}')))
        self.assertEqual(result["timestamp"], "2026-10-17T02:15:00.123456+03:00")

    def test_plain_log_uses_the_same_moscow_timestamp(self):
        result = json.loads(JsonFormatter().format(self.record("Plain message")))
        self.assertEqual(result["timestamp"], "2026-10-17T02:15:00.123456+03:00")

    def test_console_log_labels_the_moscow_timezone(self):
        result = HumanFormatter().format(self.record("Plain message"))
        self.assertTrue(result.startswith("02:15:00 МСК"))
