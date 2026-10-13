import json
import re
from typing import Optional

from app.ollama_client import ask_ollama_chat
from app.rank_models import ProfileRequest


def build_ranking_prompt(resume_text: str, profile: ProfileRequest) -> tuple[str, str]:
    """
    Создает промпт для оценки кандидата по конкретному профилю.
    """
    
    system_prompt = """Ты — опытный рекрутер и эксперт по оценке кандидатов.

Твоя задача — оценить резюме кандидата на соответствие требованиям конкретной должности.

Отвечай ТОЛЬКО валидным JSON без пояснений, без markdown, без дополнительного текста.

Формат ответа:
{
  "score": число от 0 до 100,
  "matched_keywords": ["найденный навык 1", "найденный навык 2"],
  "triggered_stop_factors": ["сработавший стоп-фактор"],
  "explanation": "краткое объяснение оценки"
}

Правила оценки:
- Оценивай от 0 до 100
- 90-100: идеальное соответствие
- 70-89: хорошее соответствие
- 50-69: частичное соответствие
- 30-49: слабое соответствие
- 0-29: не соответствует или есть стоп-факторы

Если сработал стоп-фактор, оценка должна быть низкой.
"""
    
    # Собираем требования профиля
    profile_requirements = f"""Должность: {profile.position_name}
"""
    
    if profile.education:
        profile_requirements += f"Образование: {profile.education}\n"
    
    if profile.experience:
        profile_requirements += f"Опыт работы: {profile.experience}\n"
    
    if profile.keywords:
        profile_requirements += f"Ключевые навыки: {', '.join(profile.keywords)}\n"
    
    if profile.stop_factors:
        profile_requirements += f"Стоп-факторы: {', '.join(profile.stop_factors)}\n"
    
    if profile.comment:
        profile_requirements += f"Дополнительные требования: {profile.comment}\n"
    
    user_prompt = f"""Оцени резюме кандидата на соответствие требованиям должности.

ТРЕБОВАНИЯ К ДОЛЖНОСТИ:
{profile_requirements}

РЕЗЮМЕ КАНДИДАТА:
{resume_text}

Верни оценку в формате JSON."""
    
    return system_prompt, user_prompt


def clean_json_response(response: str) -> str:
    """Очищает ответ модели от лишнего текста"""
    response = response.strip()
    
    # Удаляем markdown обертку
    response = re.sub(r"^```(?:json)?\s*", "", response)
    response = re.sub(r"\s*```$", "", response)
    
    # Ищем первую фигурную скобку и последнюю
    start = response.find('{')
    end = response.rfind('}') + 1
    
    if start != -1 and end > start:
        response = response[start:end]
    
    return response


def parse_ranking_response(response: str) -> Optional[dict]:
    """Парсит ответ модели"""
    try:
        cleaned = clean_json_response(response)
        data = json.loads(cleaned)
        
        # Проверяем обязательные поля
        if "score" not in data:
            return None
        
        # Валидируем оценку
        score = data.get("score")
        if not isinstance(score, (int, float)):
            return None
        
        if score < 0:
            score = 0
        if score > 100:
            score = 100
        
        data["score"] = float(score)
        
        return data
    
    except Exception as e:
        print(f"Ошибка парсинга ответа: {e}")
        print(f"Ответ модели: {response[:500]}")
        return None


def rank_profile(resume_text: str, profile: ProfileRequest) -> dict:
    """
    Оценивает кандидата по одному профилю.
    """
    system_prompt, user_prompt = build_ranking_prompt(resume_text, profile)
    
    ollama_response = ask_ollama_chat(
        system_prompt=system_prompt,
        user_prompt=user_prompt,
        num_ctx=16384,
        max_tokens=512,
        temperature=0.0
    )
    
    if "error" in ollama_response:
        return {
            "score": 0.0,
            "explanation": f"Ошибка модели: {ollama_response['error'][:200]}"
        }
    
    parsed = parse_ranking_response(ollama_response["response"])
    
    if parsed is None:
        return {
            "score": 0.0,
            "explanation": "Не удалось получить оценку от модели"
        }
    
    return parsed