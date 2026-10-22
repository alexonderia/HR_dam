"""Synthetic regressions based on audit findings; not recruiter ground truth."""

import json
import unittest
from unittest.mock import patch

from app.evidence_scoring import compile_criteria, minimum_months, quote_evidence, verify_and_score
from app.rank_models import ProfileRequest
from app.scoring import rank_profile, parse_ranking_response
from app.ollama_client import ModelResponseError


def response(assessments=(), stops=()):
    return {"assessments": list(assessments), "stop_factors": list(stops)}


def assessment(identifier, quote, status="met"):
    return {"id": identifier, "status": status, "evidence": [quote] if quote else []}


class EvidenceScoringTests(unittest.TestCase):
    def profile(self, **kwargs):
        return ProfileRequest(id="profile", position_name="Developer", **kwargs)

    def test_mironova_cannot_inherit_data_or_frontend_stack_from_requirements(self):
        text = "Миронова Ульяна. Филология. Преподаватель английского языка. Canva, PowerPoint, Tilda."
        keywords = ["Python", "Pandas", "Tableau", "Power BI", "JavaScript", "TypeScript", "React", "Vue", "Redux", "Webpack", "Vite", "HTML", "CSS"]
        profile = self.profile(keywords=keywords)
        forged = [assessment(c["id"], "Python, Pandas, Tableau, Power BI, React") for c in compile_criteria(profile)]
        rating = verify_and_score(response(forged), text, profile)
        self.assertEqual(rating["matched_keywords"], [])
        self.assertEqual(rating["triggered_stop_factors"], [])
        self.assertEqual({c["status"] for c in rating["details"]["criteria"]}, {"unknown"})
        self.assertEqual(rating["score"], 10)
        self.assertNotIn("score_range", rating["details"])
        self.assertNotIn("full_score_range", rating["details"])
        self.assertIn("Требует уточнения", rating["explanation"])
        self.assertNotIn("Подтверждённое несоответствие:", rating["explanation"])

    def test_moskalenko_15_months_against_36_is_proportional_and_explicit(self):
        quote = "Android-разработчик — 1 год 3 месяца"
        text = "Москаленко Максим. Опыт работы — 1 год 3 месяца. " + quote
        profile = self.profile(experience="От трёх лет коммерческой разработки")
        rating = verify_and_score(response([assessment("experience:0", quote)]), text, profile)
        criterion = rating["details"]["criteria"][0]
        self.assertEqual(criterion["status"], "partial")
        self.assertEqual(criterion["experience_months"], 15)
        self.assertEqual(criterion["required_months"], 36)
        self.assertAlmostEqual(criterion["credit"], 15 / 36)
        self.assertEqual(rating["score"], 41.67)
        self.assertIn("1 год 3 месяца", rating["explanation"])
        self.assertIn("не менее 3 лет", rating["explanation"])

    def test_total_experience_does_not_prove_relevant_experience(self):
        text = "Опыт работы — 1 год 3 месяца. Репетитор английского языка."
        profile = self.profile(experience="От 3 лет Android-разработки")
        rating = verify_and_score(response([assessment("experience:0", "Репетитор английского языка")]), text, profile)
        criterion = rating["details"]["criteria"][0]
        self.assertEqual(criterion["status"], "unknown")
        self.assertEqual(criterion["credit"], 0)
        self.assertIn("общий стаж 1 год 3 месяца", rating["explanation"])
        self.assertEqual(rating["score"], 10)

    def test_quote_must_exist_in_resume_not_just_in_vacancy(self):
        profile = self.profile(education="Высшее техническое образование")
        rating = verify_and_score(response([assessment("education:0", profile.education)]), "Учился в колледже.", profile)
        self.assertEqual(rating["details"]["criteria"][0]["status"], "unknown")

    def test_present_but_unrelated_quote_does_not_confirm_skill(self):
        profile = self.profile(keywords=["Python"])
        rating = verify_and_score(response([assessment("keyword:0:0", "Опыт продаж")]), "Опыт продаж в магазине.", profile)
        self.assertEqual(rating["matched_keywords"], [])

    def test_explicit_skill_negation_is_not_a_match(self):
        profile = self.profile(keywords=["Python", "SQL"])
        rating = verify_and_score(response(), "Не владею Python. Навыки: SQL.", profile)
        self.assertEqual(rating["matched_keywords"], ["SQL"])
        self.assertEqual(rating["details"]["criteria"][0]["status"], "not_met")
        self.assertIn("Не владею Python", rating["explanation"])

    def test_conflicting_skill_statements_require_clarification(self):
        profile = self.profile(keywords=["Python"])
        rating = verify_and_score(response(), "Не знаю Python. Основной язык — Python.", profile)
        self.assertEqual(rating["matched_keywords"], [])
        self.assertEqual(rating["details"]["criteria"][0]["status"], "unknown")

    def test_skill_boundaries_and_explicit_aliases(self):
        profile = self.profile(keywords=["SQL", "Go", "Java"])
        rating = verify_and_score(response(), "Работал с MS SQL, Google Maps и JavaScript.", profile)
        self.assertEqual(rating["matched_keywords"], ["SQL"])

    def test_unknown_is_distinct_from_proven_noncompliance(self):
        profile = self.profile(keywords=["Python", "SQL"])
        unknown = verify_and_score(response(), "Навыки: SQL.", profile)
        denied = verify_and_score(response(), "Не знаю Python. Навыки: SQL.", profile)
        self.assertEqual(unknown["score"], 60)
        self.assertEqual(denied["score"], 50)
        self.assertEqual(unknown["details"]["coverage"], 50)
        self.assertEqual(denied["details"]["coverage"], 100)

    def test_example_22_87_to_42_87_becomes_one_midpoint_without_inventing_evidence(self):
        profile = self.profile(experience="1-3 года", keywords=["Postman", "DevTools", "Swagger", "тест-кейсы",
            "чек-листы", "баг репорты", "отчёты о тестировании", "регресс-тестирование",
            "тестирования ПО (SDLC/STLC)", "тестовая документация."])
        rating = verify_and_score(response(), "Postman. DevTools. Swagger. Чек-листы.", profile)
        self.assertEqual(rating["score"], 32.87)
        self.assertNotIn("score_range", rating["details"])
        self.assertNotIn("full_score_range", rating["details"])
        self.assertNotIn("range_limit", rating["details"])
        self.assertEqual(rating["details"]["policy_version"], "evidence-v3")
        self.assertEqual(rating["details"]["coverage"], 22.87)
        self.assertIn("32.87/100", rating["explanation"])
        self.assertNotIn("диапазон", rating["explanation"].lower())

    def test_existing_narrow_range_is_not_widened_and_ceiling_is_100(self):
        profile = self.profile(keywords=["SQL", "Python"], experience="От 3 лет")
        quote = "Разработчик — 2 года 6 месяцев"
        rating = verify_and_score(response([assessment("experience:0", quote)]), "SQL. Python. " + quote, profile)
        self.assertEqual(rating["score"], 92.86)
        self.assertNotIn("score_range", rating["details"])

    def test_narrow_midpoint_rounds_to_two_decimals_and_empty_evidence_stays_explicit(self):
        skills = [f"Skill{i}" for i in range(6)]
        rating = verify_and_score(response(), ". ".join(skills[:5]), self.profile(keywords=skills))
        self.assertEqual(rating["score"], 91.67)
        empty = verify_and_score(response(), "Resume", self.profile())
        self.assertEqual(empty["score"], 10)
        self.assertEqual(empty["details"]["score_status"], "insufficient_evidence")

    def test_qa_word_forms_and_separate_experience_quotes_reduce_unknowns(self):
        profile = self.profile(experience="1-3 года", keywords=["баг репорты", "регресс-тестирование", "тестовая документация."])
        source = "2 года 2 месяца\nQA-инженер. Создавал баг-репорты. Организовал процесс регрессионного тестирования. Вёл тестовую документацию."
        parsed = response([{"id": "experience:0", "status": "met", "evidence": ["2 года 2 месяца", "QA-инженер"]}])
        rating = verify_and_score(parsed, source, profile)
        self.assertEqual(rating["score"], 100)
        self.assertNotIn("score_range", rating["details"])
        self.assertEqual(rating["details"]["criteria"][-1]["experience_months"], 26)
        for criterion in rating["details"]["criteria"]:
            for quote in criterion["evidence"]:
                self.assertEqual(source[quote["start"]:quote["end"]], quote["quote"])

    def test_aliases_do_not_invent_reports_or_ignore_negation_and_learning(self):
        profile = self.profile(keywords=["регресс-тестирование", "тестовая документация", "отчёты о тестировании"])
        rating = verify_and_score(response(), "Нет опыта регрессионного тестирования. Изучаю тестовую документацию. Работал с Allure.", profile)
        self.assertEqual([c["status"] for c in rating["details"]["criteria"]], ["not_met", "partial", "unknown"])
        self.assertNotIn("отчёты о тестировании", rating["matched_keywords"])

    def test_punctuation_only_skill_is_not_a_match(self):
        rating = verify_and_score(response(), "Опыт продаж.", self.profile(keywords=["."]))
        self.assertEqual(rating["matched_keywords"], [])

    def test_unknown_or_duplicate_criterion_is_rejected(self):
        profile = self.profile(keywords=["SQL"])
        for items in ([assessment("invented", "SQL")], [assessment("keyword:0:0", "SQL")] * 2):
            with self.assertRaises(ValueError):
                verify_and_score(response(items), "SQL", profile)

    def test_empty_stop_list_rejects_invented_stop(self):
        with self.assertRaises(ValueError):
            verify_and_score(response(stops=[assessment("stop:0", "Нет Python", "triggered")]), "Нет Python", self.profile())

    def test_absence_of_information_is_not_a_triggered_stop(self):
        profile = self.profile(keywords=["SQL"], stop_factors=["Нет Python"])
        rating = verify_and_score(response(stops=[assessment("stop:0", "Навыки SQL", "triggered")]), "Навыки SQL", profile)
        self.assertEqual(rating["triggered_stop_factors"], [])
        self.assertEqual(rating["details"]["stop_penalty"], 0)

    def test_no_penalty_twice_for_same_skill_gap(self):
        profile = self.profile(keywords=["Python", "SQL"], stop_factors=["Нет Python"])
        rating = verify_and_score(response(stops=[assessment("stop:0", "Нет Python", "triggered")]), "Нет Python. SQL.", profile)
        self.assertEqual(rating["triggered_stop_factors"], ["Нет Python"])
        self.assertEqual(rating["details"]["stop_penalty"], 0)
        self.assertEqual(rating["score"], 50)

    def test_stop_penalty_is_capped_and_duplicate_inputs_do_not_stack(self):
        stops = ["Нет допуска А", "Нет допуска Б", "Нет допуска В", "Нет допуска Г", "Нет допуска Г"]
        source = ". ".join(stops) + ". SQL."
        rating = verify_and_score(response(stops=[assessment(f"stop:{i}", stop, "triggered") for i, stop in enumerate(stops)]), source,
                                  self.profile(keywords=["SQL"], stop_factors=stops))
        self.assertEqual(rating["details"]["stop_penalty"], 30)
        self.assertEqual(rating["details"]["stop_factors"][-1]["penalty"], 0)
        self.assertEqual(rating["score"], 70)

    def test_optional_mba_does_not_invalidate_higher_education(self):
        profile = self.profile(education="Высшее, MBA приветствуется")
        rating = verify_and_score(response([assessment("education:0", "Бакалавр филологии")]), "Бакалавр филологии", profile)
        self.assertEqual(rating["score"], 100)
        self.assertEqual(rating["details"]["criteria"][1]["weight"], 0)

    def test_weights_partial_credit_and_rounding_are_reproducible(self):
        profile = self.profile(keywords=["Python", "SQL"], experience="От 3 лет", education="Высшее", comment="Английский")
        quote = "Разработчик 1 год 6 месяцев"
        source = "Python. Изучаю SQL. " + quote + ". Бакалавр. Английский."
        parsed = response([assessment("experience:0", quote), assessment("education:0", "Бакалавр"), assessment("profile_comment:0", "Английский")])
        ratings = [verify_and_score(parsed, source, profile) for _ in range(3)]
        self.assertTrue(all(r == ratings[0] for r in ratings))
        self.assertEqual(ratings[0]["score"], 75)
        self.assertEqual(sum(c["weight"] for c in ratings[0]["details"]["criteria"]), 10000)

    def test_quotations_preserve_original_unicode_offsets(self):
        source = "🙂 Навык:\n SQL   Server."
        evidence = quote_evidence(source, "навык: SQL server")
        self.assertEqual(source[evidence["start"]:evidence["end"]], evidence["quote"])
        self.assertIsNone(quote_evidence(source, "Python"))

    def test_truncated_context_is_visible(self):
        rating = verify_and_score(response(), "SQL", self.profile(keywords=["SQL"]), context_truncated=True)
        self.assertTrue(rating["details"]["context_truncated"])
        self.assertIn("только фрагмент", rating["explanation"])

    def test_structured_model_response_cannot_supply_arbitrary_score_or_explanation(self):
        self.assertIsNone(parse_ranking_response('{"score":99,"explanation":"Perfect"}'))
        self.assertIsNone(parse_ranking_response('{"assessments":[],"stop_factors":[],"score":99}'))
        self.assertIsNotNone(parse_ranking_response(json.dumps(response())))

    def test_ranking_retries_unknown_ids_instead_of_saving_unverified_result(self):
        bad = response([assessment("invented", "SQL")])
        with patch("app.scoring.ask_ollama_chat", return_value={"response": json.dumps(bad)}) as model:
            with self.assertRaises(ModelResponseError):
                rank_profile("SQL", self.profile(keywords=["SQL"], education="Degree"))
        self.assertEqual(model.call_count, 2)

    def test_ranking_retries_omitted_criteria_instead_of_accepting_empty_assessments(self):
        profile = self.profile(keywords=["SQL"], experience="От 1 года")
        quote = "Разработчик — 2 года"
        complete = response([assessment("experience:0", quote)])
        with patch("app.scoring.ask_ollama_chat", side_effect=[{"response": json.dumps(response())},
                   {"response": json.dumps(complete)}]) as model:
            rating = rank_profile("SQL. " + quote, profile)
        self.assertEqual(model.call_count, 2)
        self.assertEqual(rating["score"], 100)

    def test_ranking_rejects_missing_stop_factor_assessments(self):
        profile = self.profile(keywords=["SQL"], stop_factors=["Отказ от переезда"])
        incomplete = response()
        with patch("app.scoring.ask_ollama_chat", return_value={"response": json.dumps(incomplete)}):
            with self.assertRaises(ModelResponseError):
                rank_profile("SQL. Готов к переезду.", profile)

    def test_requirement_ranges_use_lower_bound(self):
        self.assertEqual(minimum_months("1-3 года"), 12)
        self.assertEqual(minimum_months("От трёх лет"), 36)
        self.assertEqual(minimum_months("От 1 года 3 месяцев"), 15)

    def test_experience_stop_does_not_charge_the_same_duration_gap_twice(self):
        profile = self.profile(experience="От 3 лет", stop_factors=["Опыт менее 3 лет"])
        quote = "Разработчик — 1 год 3 месяца"
        rating = verify_and_score(response([assessment("experience:0", quote)], [assessment("stop:0", quote, "triggered")]), quote, profile)
        self.assertEqual(rating["triggered_stop_factors"], profile.stop_factors)
        self.assertEqual(rating["details"]["stop_penalty"], 0)
        self.assertEqual(rating["score"], 41.67)

    def test_two_letter_skill_is_not_penalized_twice(self):
        profile = self.profile(keywords=["Go", "SQL"], stop_factors=["Нет Go"])
        rating = verify_and_score(response(stops=[assessment("stop:0", "Нет Go", "triggered")]), "Нет Go. SQL.", profile)
        self.assertEqual(rating["score"], 50)
        self.assertEqual(rating["details"]["stop_penalty"], 0)


if __name__ == "__main__":
    unittest.main()
