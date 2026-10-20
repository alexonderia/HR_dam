"""Generate cross-language contract fixtures, never recruiter quality labels."""

import json

from app.evidence_scoring import verify_and_score
from app.rank_models import ProfileRequest


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
    ]
    result = []
    for name, source, arguments, assessments, stops in cases:
        profile = ProfileRequest(id="d5ebfa74-a6f9-44aa-9b93-43ce2d62fbfb", position_name="Developer", **arguments)
        rating = verify_and_score({"assessments": assessments, "stop_factors": stops}, source, profile, model="synthetic-fixture")
        cluster = {"id": "5cabfa83-676b-4084-9ec8-212658478b6b", "profiles": [profile.model_dump()]}
        result.append({"name": name, "kind": "synthetic_contract_fixture", "source": source, "requirements": [cluster],
                       "result": {"clusters": [{"id": cluster["id"], "profiles": [{"id": profile.id, **rating}]}]}})
    return result


if __name__ == "__main__":
    print(json.dumps(fixtures(), ensure_ascii=False, indent=2))
