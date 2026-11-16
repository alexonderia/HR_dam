import json
from pathlib import Path
import unittest

from resume_evaluator.additional_evidence import additional_evidence_verdict
from resume_evaluator.evidence_scoring import compile_criteria, verify_and_score
from resume_evaluator.rank_models import ProfileRequest


class AdditionalEvidenceTests(unittest.TestCase):
    def test_shared_relevance_cases(self):
        cases=json.loads((Path(__file__).parent/"fixtures/additional-proof-cases.json").read_text())
        for case in cases:
            with self.subTest(case=case["name"]):
                valid,_=additional_evidence_verdict(case["requirement"],case["status"],case["quotes"])
                self.assertEqual(valid,case["valid"])

    def test_bonus_does_not_change_mandatory_condition_or_score(self):
        profile=ProfileRequest(id="p",position_name="Backend",comment="Ищем сильного бэкендера для высоконагруженных систем. Плюс опыт с Kubernetes")
        criteria=compile_criteria(profile)
        self.assertEqual(len(criteria),2)
        self.assertFalse(criteria[0]["optional"])
        self.assertEqual(criteria[0]["weight"],10000)
        self.assertTrue(criteria[1]["optional"])
        self.assertEqual(criteria[1]["weight"],0)
        source="Разрабатываю backend высоконагруженных систем."
        result=verify_and_score({"assessments":[{"id":"profile_comment:0","status":"met","evidence":[source]},
            {"id":"profile_comment:1","status":"unknown","evidence":[]}],"stop_factors":[]},source,profile)
        self.assertEqual(result["score"],100)
        self.assertEqual(result["details"]["criteria"][1]["status"],"unknown")

    def test_real_quote_for_other_profession_cannot_prove_either_status(self):
        source="Работаю электромонтажником, выполняю монтаж электрооборудования."
        profile=ProfileRequest(id="p",position_name="Backend",comment="Опыт с Kubernetes")
        for status in ("met","not_met"):
            result=verify_and_score({"assessments":[{"id":"profile_comment:0","status":status,"evidence":[source]}],"stop_factors":[]},source,profile)
            self.assertEqual(result["details"]["criteria"][0]["status"],"unknown")
            self.assertEqual(result["score"],0)
