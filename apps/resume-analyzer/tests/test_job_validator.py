import copy
import unittest
from uuid import uuid4

from pydantic import ValidationError

from app.job_validator import validate_analysis_job


def make_valid_job():
    cluster_id = str(uuid4())

    return {
        "version": 1,
        "job_id": str(uuid4()),
        "batch_id": str(uuid4()),
        "item_id": str(uuid4()),
        "attempt": 1,
        "file": {
            "id": str(uuid4()),
            "file_id": str(uuid4()),
            "source_path": "resume.pdf",
            "file_name": "resume.pdf",
            "mime_type": "application/pdf",
            "size_bytes": 12345,
            "sha256": "a" * 64,
            "bucket": "resumes",
            "object_key": "resume-imports/resume.pdf",
            "download_url": (
                "http://seaweedfs:8333/resumes/resume.pdf"
                "?X-Amz-Signature=test"
            ),
            "download_url_expires_at": "2026-10-20T12:00:00.000Z",
            "candidate_hint": {
                "last_name": None,
                "first_name": None,
                "middle_name": None,
                "phone": None,
            },
        },
        "requirements": [
            {
                "id": cluster_id,
                "name": "ИТ",
                "track": "it",
                "comment": "",
                "is_active": True,
                "profiles": [
                    {
                        "id": str(uuid4()),
                        "cluster_id": cluster_id,
                        "position_name": "Python Developer",
                        "education": "",
                        "experience": "",
                        "keywords": ["Python", "FastAPI"],
                        "stop_factors": [],
                        "comment": "",
                        "is_active": True,
                    }
                ],
            }
        ],
    }


class JobValidatorTests(unittest.TestCase):

    def setUp(self):
        self.job = make_valid_job()

    def test_valid_job(self):
        result = validate_analysis_job(self.job)
        self.assertEqual(result, self.job)

    def test_invalid_version(self):
        job = copy.deepcopy(self.job)
        job["version"] = 2

        with self.assertRaises(ValidationError):
            validate_analysis_job(job)

    def test_invalid_uuid(self):
        job = copy.deepcopy(self.job)
        job["job_id"] = "invalid-uuid"

        with self.assertRaises(ValidationError):
            validate_analysis_job(job)

    def test_empty_requirements(self):
        job = copy.deepcopy(self.job)
        job["requirements"] = []

        with self.assertRaises(ValidationError):
            validate_analysis_job(job)

    def test_empty_profiles(self):
        job = copy.deepcopy(self.job)
        job["requirements"][0]["profiles"] = []

        with self.assertRaises(ValidationError):
            validate_analysis_job(job)

    def test_invalid_sha256(self):
        job = copy.deepcopy(self.job)
        job["file"]["sha256"] = "wrong-hash"

        with self.assertRaises(ValidationError):
            validate_analysis_job(job)

    def test_file_too_large(self):
        job = copy.deepcopy(self.job)
        job["file"]["size_bytes"] = 60 * 1024 * 1024

        with self.assertRaises(ValidationError):
            validate_analysis_job(job)

    def test_invalid_download_url(self):
        job = copy.deepcopy(self.job)
        job["file"]["download_url"] = "not-a-url"

        with self.assertRaises(ValidationError):
            validate_analysis_job(job)

    def test_version_as_string(self):
        job = copy.deepcopy(self.job)
        job["version"] = "1"

        with self.assertRaises(ValidationError):
            validate_analysis_job(job)


    def test_invalid_expiration(self):
        job = copy.deepcopy(self.job)
        job["file"]["download_url_expires_at"] = "not-a-date"

        with self.assertRaises(ValidationError):
            validate_analysis_job(job)


    def test_expiration_without_timezone(self):
        job = copy.deepcopy(self.job)
        job["file"]["download_url_expires_at"] = "2026-10-20T12:00:00"

        with self.assertRaises(ValidationError):
            validate_analysis_job(job)


    def test_duplicate_profile(self):
        job = copy.deepcopy(self.job)

        profile = job["requirements"][0]["profiles"][0]
        job["requirements"][0]["profiles"].append(copy.deepcopy(profile))

        with self.assertRaises(ValidationError):
            validate_analysis_job(job)


    def test_profile_wrong_cluster(self):
        job = copy.deepcopy(self.job)

        job["requirements"][0]["profiles"][0]["cluster_id"] = str(uuid4())

        with self.assertRaises(ValidationError):
            validate_analysis_job(job)


if __name__ == "__main__":
    unittest.main()