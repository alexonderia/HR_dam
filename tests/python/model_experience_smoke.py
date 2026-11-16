"""Optional real-model smoke for the current policy, with synthetic inputs only.

Run in the evaluator image with PYTHONPATH=/app and this tests folder mounted.
This is a regression smoke, not independent recruiter quality measurement.
"""
import json
from resume_evaluator.scoring import rank_profile
from resume_evaluator.rank_models import ProfileRequest


def main():
    cases = [
        ("future_intent", "Хотел бы изучить Python. Работаю электромонтажником.",
         ProfileRequest(id="p", position_name="Developer", keywords=["Python"]), "unknown", None),
        ("calendar_jobs", "Январь 2020 — Декабрь 2021\nКоммерческая разработка на Python, первая работа.\nЯнварь 2022 — Декабрь 2023\nКоммерческая разработка на Python, вторая работа.",
         ProfileRequest(id="p", position_name="Developer", experience="От 3 лет разработки на Python"), "met", 48),
        ("required_and", "Владею Python. Не знаю Docker.",
         ProfileRequest(id="p", position_name="Developer", keywords=["Python и Docker"]), "not_met", None),
    ]
    for name, text, profile, expected, months in cases:
        rating = rank_profile(text, profile, timeout=180, assessment_date="2026-11-13")
        criterion = rating["details"]["criteria"][0]
        print(json.dumps({"case": name, "status": criterion["status"], "months": criterion.get("experience_months"),
                          "policy": rating["details"]["policy_version"], "score": rating["score"]}), flush=True)
        assert criterion["status"] == expected
        assert criterion.get("experience_months") == months
    print("PASS current-policy real model synthetic smoke", flush=True)


if __name__ == "__main__":
    main()
