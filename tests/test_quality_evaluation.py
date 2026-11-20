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

    def test_duplicate_missing_foreign_criteria_are_rejected(self):
        for mutate in (lambda a:a.append(a[0]),lambda a:a.clear(),lambda a:a[0].update(id="foreign")):
            labels,predictions=self.records()
            mutate(predictions["synthetic-unit-test"]["rating"]["details"]["criteria"])
            with self.assertRaises(ValueError):quality.evaluate(labels,predictions)

    def test_unknown_is_included_in_accuracy_but_not_determined_accuracy(self):
        labels,predictions=self.records()
        report=quality.evaluate(labels,predictions)
        self.assertEqual(report["determined_fraction"],0)
        self.assertIsNone(report["determined_accuracy"])
        self.assertEqual(report["confusion_matrix"],{"met":{"unknown":1}})
        self.assertEqual(report["slices"]["all"]["criteria"],1)

    def test_latency_sufficiency_and_failed_cases(self):
        labels,predictions=self.records()
        labels["synthetic-unit-test"]["rating"]["criteria"][0]["sufficient_citations"]=["SQL"]
        predictions["synthetic-unit-test"]["latency_ms"]=1500
        report=quality.evaluate(labels,predictions)
        self.assertEqual(report["latency_ms"]["p95"],1500)
        self.assertEqual(report["sufficient_citation_fraction"],1)
        predictions["synthetic-unit-test"]={"error_code":"timeout","latency_ms":2000}
        report=quality.evaluate(labels,predictions)
        self.assertEqual(report["timeouts"],1)
        self.assertEqual(report["evaluated_cases"],0)

    def test_equivalent_variants_report_status_instability(self):
        from copy import deepcopy
        labels,predictions=self.records()
        first=next(iter(labels))
        labels[first]["invariance_group"]="same-facts"
        labels["variant"]=deepcopy(labels[first]);labels["variant"]["case_id"]="variant"
        predictions["variant"]=deepcopy(predictions[first])
        predictions["variant"]["rating"]["details"]["criteria"][0]["status"]="met"
        result=quality.evaluate(labels,predictions)
        self.assertEqual(result["invariance"],{"groups":1,"groups_with_status_changes":1,"cases":2})


if __name__ == "__main__":
    unittest.main()
