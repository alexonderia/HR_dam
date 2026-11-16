import unittest

from resume_evaluator.evidence_scoring import compile_criteria, verify_and_score
from resume_evaluator.rank_models import ProfileRequest
from resume_evaluator.scoring import document_chunks, ContextFitError, parse_ranking_response


class HRPolicyTests(unittest.TestCase):
    def score(self, source, *, quotes=None, status="met", experience=None, keywords=None, reason=None):
        profile = ProfileRequest(id="p", position_name="Developer", experience=experience, keywords=keywords or [])
        identifier = "experience:0" if experience else "keyword:0:0"
        result = verify_and_score({"assessments": [{"id": identifier, "status": status, "evidence": quotes or [],
            "unknown_reason": reason}], "stop_factors": []}, source, profile, assessment_date="2026-11-13")
        return result

    def test_future_intention_never_becomes_a_skill(self):
        for source in ("Хотел бы изучить Python.", "Хочу работать с Python.", "Планирую освоить Python."):
            for status in ("met", "unknown"):
                with self.subTest(source=source, status=status):
                    result = self.score(source, quotes=[source], status=status, keywords=["Python"])
                    self.assertEqual(result["score"], 0)
                    self.assertEqual(result["details"]["criteria"][0]["unknown_reason"], "future_intent")

    def test_unknown_model_answer_is_not_promoted_by_literal_match(self):
        result = self.score("Владею Python", status="unknown", keywords=["Python"], reason="not_stated")
        self.assertEqual(result["score"], 0)

    def test_learning_is_partial_and_applied_skill_is_met(self):
        for source, expected in (("Изучаю Python.", "partial"), ("Прохожу курс по Python.", "partial"), ("Работаю с Python.", "met")):
            result = self.score(source, quotes=[source], keywords=["Python"])
            self.assertEqual(result["details"]["criteria"][0]["status"], expected)

    def test_preference_does_not_remove_required_experience(self):
        for marker in ("и желательно", "а желательно", "но желательно"):
            profile = ProfileRequest(id="p", position_name="Developer", experience="От 3 лет Python " + marker + " знание Docker")
            criteria = compile_criteria(profile)
            self.assertEqual(len(criteria), 2)
            self.assertFalse(criteria[0]["optional"])
            self.assertEqual(criteria[0]["weight"], 10000)
            self.assertTrue(criteria[1]["optional"])
            self.assertEqual(criteria[1]["weight"], 0)

    def test_sequential_jobs_are_combined_and_overlaps_count_once(self):
        cases = [("01.01.2020 — 31.12.2021", "01.01.2022 — 31.12.2023", 48),
                 ("Январь 2020 — Декабрь 2021", "Январь 2021 — Декабрь 2022", 36)]
        for first, second, expected in cases:
            source = first + "\nPython-разработчик: коммерческая разработка API, первая работа.\n" + second + "\nPython-разработчик: коммерческая разработка API, вторая работа."
            result = self.score(source, quotes=[source], experience="От 3 лет коммерческой разработки на Python")
            criterion = result["details"]["criteria"][0]
            self.assertEqual(criterion["experience_months"], expected)
            self.assertEqual(criterion["status"], "met")

    def test_current_work_uses_fixed_snapshot_date_and_no_future_months(self):
        source = "Январь 2026 — настоящее время\nPython-разработчик: коммерческая разработка API."
        result = self.score(source, quotes=[source], experience="От 3 лет разработки на Python")
        self.assertEqual(result["details"]["criteria"][0]["experience_months"], 10)
        self.assertEqual(result["details"]["assessment_date"], "2026-11-13")

    def test_study_dates_cannot_create_work_experience(self):
        source = "Образование\nЯнварь 2020 — Декабрь 2024\nРазработчик Python, учебный проект."
        result = self.score(source, quotes=[source], experience="От 3 лет разработки на Python")
        self.assertEqual(result["details"]["criteria"][0]["status"], "unknown")

    def test_date_only_years_do_not_invent_precise_months(self):
        source = "2020 — 2024\nPython-разработчик: коммерческая разработка API."
        result = self.score(source, quotes=[source], experience="От 3 лет разработки на Python")
        self.assertEqual(result["details"]["criteria"][0]["status"], "unknown")

    def test_oversized_document_is_rejected_instead_of_cutting_off_tail(self):
        with self.assertRaises(ContextFitError):
            document_chunks("А" * 10000, 10)

    def test_model_unknown_requires_a_reason(self):
        self.assertIsNone(parse_ranking_response('{"assessments":[{"id":"a","status":"unknown","evidence":[]}],"stop_factors":[]}'))

    def test_compound_skills_use_explicit_and_or_truth_tables(self):
        for requirement, source, status in (("Python и Docker", "Владею Python. Не знаю Docker.", "not_met"),
                                            ("Python и Docker", "Владею Python и Docker.", "met"),
                                            ("Python или Java", "Владею Java.", "met"),
                                            ("Python и Docker", "Владею Python.", "partial")):
            result = self.score(source, keywords=[requirement], quotes=[source])
            self.assertEqual(result["details"]["criteria"][0]["status"], status)

    def test_explicit_failure_of_other_required_part_wins_over_short_experience(self):
        source = "Коммерческая разработка на Python — 1 год. Не знаю Docker."
        result = self.score(source, quotes=[source], experience="От 3 лет разработки на Python и Docker", status="partial")
        self.assertEqual(result["details"]["criteria"][0]["status"], "not_met")

    def test_conflicting_total_and_job_history_is_reported_for_clarification(self):
        source = "Опыт работы — 1 год.\nЯнварь 2020 — Декабрь 2023\nКоммерческая разработка на Python."
        result = self.score(source, quotes=[source], experience="От 3 лет разработки на Python")
        criterion = result["details"]["criteria"][0]
        self.assertEqual(criterion["status"], "unknown")
        self.assertEqual(criterion["unknown_reason"], "contradictory")
        self.assertNotIn("experience_months", criterion)

    def test_verified_months_resolve_only_duration_partial_not_missing_parts(self):
        source = "Январь 2020 — Декабрь 2023\nКоммерческая разработка на Python."
        profile = ProfileRequest(id="p", position_name="Developer", experience="От 3 лет разработки на Python")
        for reason, expected in (("duration", "met"), ("missing_parts", "partial")):
            result = verify_and_score({"assessments": [{"id":"experience:0", "status":"partial", "evidence":[source],
                "partial_reason":reason}], "stop_factors":[]}, source, profile, assessment_date="2026-11-13")
            self.assertEqual(result["details"]["criteria"][0]["status"], expected)

    def test_irrelevant_reason_is_normalized_without_changing_a_model_status(self):
        import json
        value = {"assessments":[{"id":"a", "status":"met", "evidence":["Python"],
                 "unknown_reason":"not_stated", "partial_reason":"learning"}], "stop_factors":[]}
        parsed = parse_ranking_response(json.dumps(value))
        self.assertEqual(parsed["assessments"][0]["status"], "met")
        self.assertIsNone(parsed["assessments"][0]["unknown_reason"])
        self.assertIsNone(parsed["assessments"][0]["partial_reason"])
