"""Generate cross-language contract fixtures, never recruiter quality labels."""

import json

from resume_evaluator.evidence_scoring import verify_and_score
from resume_evaluator.rank_models import ProfileRequest


def fixtures():
    cases = [
        ("mironova_unsupported_stack", "Филология. Преподаватель. Canva, Tilda, PowerPoint.",
         {"keywords": ["Python", "Pandas", "Tableau", "Power BI", "React", "TypeScript"]}, [], []),
        ("moskalenko_15_of_36_months", "Опыт работы — 1 год 3 месяца. Android-разработчик — 1 год 3 месяца.",
         {"experience": "От 3 лет"}, [{"id": "experience:0", "status": "met", "evidence": ["Android-разработчик — 1 год 3 месяца"]}], []),
        ("unknown_is_not_absent", "SQL. Готов переехать в Татарстан.",
         {"keywords": ["SQL", "Python"], "stop_factors": ["Отказ от переезда в Татарстан"]}, [], []),
        ("no_double_penalty", "Нет Python. SQL.",
         {"keywords": ["Python", "SQL"], "stop_factors": ["Нет Python"]}, [], [{"id": "stop:0", "status": "triggered", "evidence": ["Нет Python"]}]),
        ("optional_mba", "Бакалавр филологии.", {"education": "Высшее, MBA приветствуется"},
         [{"id": "education:0", "status": "met", "evidence": ["Бакалавр филологии"]}], []),
        ("unicode_and_weight_remainders", "🙂 SQL. Python. Не знаю Java.", {"keywords": ["SQL", "Python", "Java", "Go", "React", "CSS", "HTML"], "experience": "От 3 лет"}, [], []),
        ("age_is_not_experience", "Мужчина, 23 года. Опыт работы — 1 год 5 месяцев. Электромонтажник.",
         {"experience": "От 3 лет коммерческой разработки на Python"},
         [{"id": "experience:0", "status": "met", "evidence": ["23 года"]}], []),
        ("compound_experience_stays_partial", "Коммерческая разработка на Python — 5 лет; микросервисами не занимался.",
         {"experience": "От 3 лет коммерческой разработки на Python и проектирование микросервисов"},
         [{"id": "experience:0", "status": "partial", "evidence": ["Коммерческая разработка на Python — 5 лет; микросервисами не занимался."]}], []),
        ("duration_does_not_override_noncompliance", "Коммерческая разработка на Python — 5 лет; микросервисами не занимался.",
         {"experience": "От 3 лет коммерческой разработки на Python и проектирование микросервисов"},
         [{"id": "experience:0", "status": "not_met", "evidence": ["Коммерческая разработка на Python — 5 лет; микросервисами не занимался."]}], []),
    ]
    cases += [
        ("additional_unrelated_confirmation", "Работаю электромонтажником.", {"comment":"Опыт с Kubernetes"},
         [{"id":"profile_comment:0","status":"met","evidence":["Работаю электромонтажником"]}], []),
        ("additional_unrelated_denial", "Работаю электромонтажником.", {"comment":"Опыт с Kubernetes"},
         [{"id":"profile_comment:0","status":"not_met","evidence":["Работаю электромонтажником"]}], []),
        ("additional_bonus", "Разрабатываю backend высоконагруженных систем.",
         {"comment":"Ищем сильного бэкендера для высоконагруженных систем. Плюс опыт с Kubernetes"},
         [{"id":"profile_comment:0","status":"met","evidence":["Разрабатываю backend высоконагруженных систем"]},
          {"id":"profile_comment:1","status":"unknown","evidence":[]}], []),
        ("additional_explicit_denial", "С Kubernetes не работал.", {"comment":"Опыт с Kubernetes"},
         [{"id":"profile_comment:0","status":"not_met","evidence":["С Kubernetes не работал"]}], []),
        ("future_intent", "Хотел бы изучить Python.", {"keywords": ["Python"]},
         [{"id": "keyword:0:0", "status": "unknown", "unknown_reason": "future_intent", "evidence": []}], []),
        ("optional_boundary", "Коммерческая разработка на Python — 1 год 3 месяца.",
         {"experience": "От 3 лет разработки на Python и желательно знание Docker"},
         [{"id": "experience:0", "status": "met", "evidence": ["Коммерческая разработка на Python — 1 год 3 месяца."]}], []),
        ("two_jobs_four_years", "01.01.2020 — 31.12.2021\nКоммерческая разработка на Python, первая работа.\n01.01.2022 — 31.12.2023\nКоммерческая разработка на Python, вторая работа.",
         {"experience": "От 3 лет разработки на Python"},
         [{"id": "experience:0", "status": "met", "evidence": ["Коммерческая разработка на Python, первая работа.", "Коммерческая разработка на Python, вторая работа."]}], []),
    ]
    result = []
    for name, source, arguments, assessments, stops in cases:
        profile = ProfileRequest(id="d5ebfa74-a6f9-44aa-9b93-43ce2d62fbfb", position_name="Developer", **arguments)
        rating = verify_and_score({"assessments": assessments, "stop_factors": stops}, source, profile, model="synthetic-fixture", assessment_date="2026-11-13")
        cluster = {"id": "5cabfa83-676b-4084-9ec8-212658478b6b", "profiles": [profile.model_dump()]}
        result.append({"name": name, "kind": "synthetic_contract_fixture", "source": source, "requirements": [cluster],
                       "result": {"clusters": [{"id": cluster["id"], "profiles": [{"id": profile.id, **rating}]}]}})
    return result


if __name__ == "__main__":
    print(json.dumps(fixtures(), ensure_ascii=False, indent=2))
