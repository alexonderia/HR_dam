"""Numeric evidence must belong to the relevant job, never age or education."""

import unittest

from resume_evaluator.evidence_scoring import verify_and_score
from resume_evaluator.rank_models import ProfileRequest


class ExperienceContextTests(unittest.TestCase):
    def criterion(self, source, quotes, requirement="От 3 лет коммерческой разработки на Python", status="met"):
        rating = verify_and_score({"assessments": [{"id": "experience:0", "status": status, "evidence": quotes}],
                                   "stop_factors": []}, source,
                                  ProfileRequest(id="test", position_name="Developer", experience=requirement))
        return rating["details"]["criteria"][0]

    def test_age_and_unrelated_work_never_prove_development(self):
        source = "Мужчина, 23 года.\nОпыт работы — 1 год 5 месяцев.\nЭлектромонтажник."
        for quotes in (["23 года"], ["23 года", "Электромонтажник"], [source]):
            with self.subTest(quotes=quotes):
                result = self.criterion(source, quotes)
                self.assertEqual(result["status"], "unknown")
                self.assertNotIn("experience_months", result)
                self.assertEqual(result["total_experience_months"], 17)

    def test_real_23_years_are_not_rejected_by_numeric_limit(self):
        quote = "Python-разработчик: коммерческая разработка API — 23 года"
        result = self.criterion(quote, [quote])
        self.assertEqual(result["status"], "met")
        self.assertEqual(result["experience_months"], 276)

    def test_mixed_age_education_and_work_uses_work_duration(self):
        source = "Мужчина, 23 года.\nОбучение в колледже — 4 года.\nPython-разработчик: коммерческая разработка — 1 год 3 месяца."
        result = self.criterion(source, [source])
        self.assertEqual(result["experience_months"], 15)
        self.assertEqual(result["status"], "partial")

    def test_separate_job_cannot_lend_duration_to_python(self):
        source = "Электромонтажник — 5 лет.\nPython-разработчик: коммерческая разработка API."
        result = self.criterion(source, ["Электромонтажник — 5 лет", "Python-разработчик: коммерческая разработка API"])
        self.assertEqual(result["status"], "unknown")
        self.assertNotIn("experience_months", result)

    def test_summary_is_only_an_upper_bound(self):
        source = "Опыт работы — 10 лет.\nНавыки: Python."
        result = self.criterion(source, [source])
        self.assertEqual(result["status"], "unknown")
        self.assertNotIn("experience_months", result)

    def test_numeric_branch_does_not_promote_partial_or_negative(self):
        quote = "Коммерческая разработка на Python — 5 лет; микросервисами не занимался."
        requirement = "От 3 лет коммерческой разработки на Python и проектирование микросервисов"
        for status, credit in (("partial", .5), ("not_met", 0)):
            result = self.criterion(quote, [quote], requirement, status)
            # v4: explicit denial of a required AND-part outranks numeric tenure.
            self.assertEqual(result["status"], "not_met")
            self.assertEqual(result["credit"], 0)

    def test_duration_punctuation_and_line_breaks(self):
        for duration, months in (("1 год, 3 месяца", 15), ("1 год и 5 месяцев", 17), ("1 год\n3 месяца", 15)):
            quote = "Коммерческая разработка на Python — " + duration
            self.assertEqual(self.criterion(quote, [quote])["experience_months"], months)

    def test_education_section_does_not_become_employment(self):
        source = "Образование\n2020 — 2024\n4 года\nПрограммист Python: коммерческая разработка, учебная практика."
        result = self.criterion(source, [source])
        self.assertEqual(result["status"], "unknown")
        self.assertNotIn("experience_months", result)

    def test_dated_work_record_binds_wrapped_duration_to_its_role(self):
        source = "Опыт работы\nЯнварь 2024 — Апрель 2025\n1 год\n3 месяца\nPython-разработчик\nКоммерческая разработка API на Python.\nОбразование\nКолледж."
        result = self.criterion(source, [source])
        self.assertEqual(result["experience_months"], 15)
        self.assertEqual(result["status"], "partial")

    def test_age_does_not_trigger_experience_stop_factor(self):
        source = "Возраст: 2 года."
        rating = verify_and_score({"assessments": [], "stop_factors": [
            {"id": "stop:0", "status": "triggered", "evidence": [source]}]}, source,
            ProfileRequest(id="test", position_name="Developer", stop_factors=["Опыт менее 3 лет"]))
        self.assertEqual(rating["triggered_stop_factors"], [])
        self.assertEqual(rating["details"]["stop_penalty"], 0)

    def test_age_next_to_job_title_is_not_work_duration(self):
        for text in ("Python-разработчик, 23 года", "23 года, Python-разработчик",
                     "Python developer, 23 years old", "Python developer, age: 23 years"):
            with self.subTest(text=text):
                result = self.criterion(text, [text], "От 3 лет разработки на Python")
                self.assertEqual(result["status"], "unknown")
                self.assertNotIn("experience_months", result)

    def test_company_age_is_not_personal_experience(self):
        for text in ("Компания разработки на Python работает на рынке 23 года",
                     "Компания разработки на Python существует 23 года",
                     "Python-разработчик. Нашей компании 23 года."):
            with self.subTest(text=text):
                result = self.criterion(text, [text], "От 3 лет разработки на Python")
                self.assertEqual(result["status"], "unknown")
                self.assertNotIn("experience_months", result)

    def test_explicit_work_duration_with_comma_remains_valid(self):
        for text in ("Python-разработчик, опыт 23 года", "Python-разработчик, коммерческая разработка API, 23 года",
                     "В компании работаю Python-разработчиком 23 года"):
            with self.subTest(text=text):
                result = self.criterion(text, [text], "От 3 лет разработки на Python")
                self.assertEqual(result["status"], "met")
                self.assertEqual(result["experience_months"], 276)

    def test_technology_sentence_punctuation_is_not_part_of_its_name(self):
        for text, requirement in (("Коммерческая разработка на Python — 5 лет", "От 3 лет коммерческой разработки на Python."),
                                  ("Разработка на Node.js — 5 лет", "От 3 лет разработки на Node.js."),
                                  ("Разработка на C++ — 5 лет", "От 3 лет разработки на C++.")):
            with self.subTest(requirement=requirement):
                result = self.criterion(text, [text], requirement)
                self.assertEqual(result["status"], "met")
                self.assertEqual(result["experience_months"], 60)

    def test_company_age_cannot_be_requalified_through_a_dated_record(self):
        source = "Опыт работы\nЯнварь 2020 — настоящее время\n23 года\nКомпания разработки на Python существует давно."
        result = self.criterion(source, [source], "От 3 лет разработки на Python")
        self.assertEqual(result["status"], "unknown")
        self.assertNotIn("experience_months", result)


if __name__ == "__main__":
    unittest.main()
