"""Tests of the metrics calculator; these examples are not recruiter labels."""

import importlib.util
import unittest
from pathlib import Path

spec = importlib.util.spec_from_file_location("quality", Path(__file__).resolve().parents[1] / "scripts" / "evaluate-resume-quality.py")
quality = importlib.util.module_from_spec(spec)
spec.loader.exec_module(quality)


class QualityMetricsTests(unittest.TestCase):
    def records(self):
        label = {"case_id": "synthetic-unit-test", "reviewer_id": "unit-test-only", "independent": True, "resume_text": "SQL. Python.",
                 "rating": {"matched_keywords": ["SQL", "Python"], "triggered_stop_factors": [],
                            "criteria": [{"id": "a", "status": "met"}], "score": 75}}
        prediction = {"rating": {"matched_keywords": ["SQL", "Java"], "triggered_stop_factors": [], "score": 50,
                       "details": {"criteria": [{"id": "a", "status": "unknown", "evidence": [{"quote": "SQL", "start": 0, "end": 3}]}], "stop_factors": []}}}
        return {"synthetic-unit-test": label}, {"synthetic-unit-test": prediction}

    def test_metrics_do_not_hide_false_matches_or_unknown_status(self):
        labels, predictions = self.records()
        result = quality.evaluate(labels, predictions)
        self.assertEqual(result["skills"]["precision"], .5)
        self.assertEqual(result["skills"]["recall"], .5)
        self.assertIsNone(result["stops"]["precision"])
        self.assertEqual(result["criterion_status_accuracy"], 0)
        self.assertEqual(result["invalid_citations"], 0)
        self.assertEqual(result["score_mae"], 25)

    def test_missing_predictions_and_nonindependent_labels_are_rejected(self):
        labels, predictions = self.records()
        with self.assertRaises(ValueError):
            quality.evaluate(labels, {})
        labels["synthetic-unit-test"]["independent"] = False
        with self.assertRaises(ValueError):
            quality.evaluate(labels, predictions)

    def test_fabricated_citation_is_counted(self):
        labels, predictions = self.records()
        predictions["synthetic-unit-test"]["rating"]["details"]["criteria"][0]["evidence"][0]["quote"] = "Java"
        self.assertEqual(quality.evaluate(labels, predictions)["invalid_citations"], 1)


if __name__ == "__main__":
    unittest.main()
