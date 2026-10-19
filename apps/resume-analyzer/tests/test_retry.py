import unittest
from unittest.mock import MagicMock, patch

from app.job_result import should_retry
from app.ollama_client import ModelTimeout
from app.rabbitmq_client import publish_retry


class RetryTests(unittest.TestCase):

    def test_retry_limit(self):
        error = ModelTimeout("test")

        self.assertTrue(should_retry(error, 0))
        self.assertTrue(should_retry(error, 4))
        self.assertFalse(should_retry(error, 5))

    @patch("app.rabbitmq_client.publish_json")
    def test_retry_preserves_job_identity(self, mock_publish):
        channel = MagicMock()

        job = {
            "version": 1,
            "job_id": "a0000000-0000-4000-8000-000000000001",
            "batch_id": "b0000000-0000-4000-8000-000000000001",
            "item_id": "a0000000-0000-4000-8000-000000000001",
            "attempt": 1,
        }

        publish_retry(channel, job, retries=2)

        mock_publish.assert_called_once_with(
            channel=channel,
            queue_name="hr.resume.analysis.retry",
            message=job,
            message_id=job["job_id"],
            headers={"hr-retries": 2},
        )

        self.assertEqual(job["attempt"], 1)


if __name__ == "__main__":
    unittest.main()