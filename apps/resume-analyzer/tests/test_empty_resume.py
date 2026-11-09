import json
import unittest
from io import BytesIO
from unittest.mock import patch
from uuid import uuid4

from docx import Document
from fastapi import HTTPException, UploadFile

from app.analysis_service import InsufficientResumeTextError, analyze_resume_text
from app.job_processor import build_requirements, process_job
from app.job_result import classify_error, failed_result, should_retry
from app.main import rank_resume


class EmptyResumeTests(unittest.TestCase):
    def setUp(self):
        content = BytesIO()
        Document().save(content)
        self.document = content.getvalue()
        self.job = {
            "version": 1,
            "job_id": str(uuid4()),
            "batch_id": str(uuid4()),
            "item_id": str(uuid4()),
            "attempt": 1,
            "file": {"file_name": "empty.docx"},
            "requirements": [{
                "id": str(uuid4()),
                "name": "IT",
                "profiles": [{
                    "id": str(uuid4()),
                    "position_name": "Developer",
                }],
            }],
        }

    def test_empty_docx_in_amqp_returns_document_failure_without_model_or_retry(self):
        with patch("app.job_processor.download_document", return_value=self.document), \
             patch("app.analysis_service.rank_profile") as rank:
            with self.assertRaises(InsufficientResumeTextError) as raised:
                process_job(self.job)

        rank.assert_not_called()
        result = failed_result(self.job, raised.exception)
        self.assertEqual(result, {
            "version": self.job["version"],
            "job_id": self.job["job_id"],
            "batch_id": self.job["batch_id"],
            "item_id": self.job["item_id"],
            "attempt": self.job["attempt"],
            "status": "failed",
            "error": {
                "code": "TEXT_EXTRACTION_FAILED",
                "message": InsufficientResumeTextError.message,
            },
        })
        self.assertFalse(should_retry(raised.exception, 0))

    def test_empty_docx_in_http_returns_422_with_same_document_message(self):
        requirements = json.dumps({"clusters": self.job["requirements"]})
        upload = UploadFile(filename="empty.docx", file=BytesIO(self.document))
        with patch("app.main.is_ready", return_value=True), \
             patch("app.main.analyze_resume_text") as analyze:
            with self.assertRaises(HTTPException) as raised:
                rank_resume(file=upload, requirements=requirements)

        analyze.assert_not_called()
        self.assertEqual(raised.exception.status_code, 422)
        self.assertEqual(raised.exception.detail, InsufficientResumeTextError.message)

    def test_whitespace_and_short_text_are_document_errors_before_model_readiness(self):
        requirements = build_requirements(self.job)
        with patch("app.analysis_service.is_ready") as ready, \
             patch("app.analysis_service.rank_profile") as rank:
            for text in ("", " \t\n", "x" * 49):
                with self.subTest(text_length=len(text)):
                    with self.assertRaises(InsufficientResumeTextError):
                        analyze_resume_text(text, requirements, self.job["job_id"])

        ready.assert_not_called()
        rank.assert_not_called()

    def test_invalid_job_remains_distinct_from_unreadable_document(self):
        error = ValueError("Invalid requirements: internal details")
        self.assertEqual(classify_error(error), ("INVALID_JOB", False))
        result = failed_result(self.job, error)
        self.assertEqual(result["error"]["message"], "Некорректное задание анализа.")
        self.assertNotIn("internal details", json.dumps(result))


if __name__ == "__main__":
    unittest.main()
