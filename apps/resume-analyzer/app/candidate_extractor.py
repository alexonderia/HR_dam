
"""Извлечение ФИО и телефона кандидата из резюме."""

import re


PHONE_PATTERN = re.compile(
    r"(?<!\w)(?:\+7|7|8)"
    r"[\s()\-]*"
    r"(?:\d[\s()\-]*){10}"
    r"(?!\d)"
)

NAME_PATTERN = re.compile(
    r"^[А-ЯЁ][а-яё-]+$"
)


def normalize_phone(phone: str) -> str | None:
    """Приводит российский номер к формату +7XXXXXXXXXX."""

    digits = re.sub(r"\D", "", phone)

    if len(digits) != 11:
        return None

    if digits[0] not in ("7", "8"):
        return None

    return "+7" + digits[1:]


def extract_phone(text: str) -> str | None:
    """Находит первый подходящий российский номер."""

    match = PHONE_PATTERN.search(text)

    if not match:
        return None

    return normalize_phone(match.group())


def extract_name(text: str) -> dict:
    """
    Пытается определить ФИО по первым строкам резюме.

    Предполагаемый формат:
    Иванов Иван Иванович
    """

    lines = [
        line.strip()
        for line in text.splitlines()
        if line.strip()
    ]

    for line in lines[:15]:
        words = line.split()

        if len(words) not in (2, 3):
            continue

        if not all(NAME_PATTERN.fullmatch(word) for word in words):
            continue

        return {
            "last_name": words[0],
            "first_name": words[1],
            "middle_name": words[2] if len(words) == 3 else None,
        }

    return {
        "last_name": None,
        "first_name": None,
        "middle_name": None,
    }


def extract_candidate(text: str) -> dict:
    """Собирает контактные данные кандидата."""

    candidate = extract_name(text)
    candidate["phone"] = extract_phone(text)

    return candidate
