"""Deterministic requirement clauses; mirrored by contracts/criteria.ts."""

import re

OPTIONAL = re.compile(r"желател\w*|приветству\w*|будет\s+плюсом|не\s+обязател\w*", re.I)
OPTIONAL_V3 = re.compile(OPTIONAL.pattern + r"|(?:^|[.!?;\n]\s*)плюс\b", re.I)


def requirement_clauses(text: str) -> list[str]:
    # Split only explicit preference boundaries, never a technical AND/OR.
    # "3 years Python and preferably Docker" must not make the years optional.
    text = re.sub(r"\s+(?:и|а|но)\s+(?=(?:желател\w*|приветству\w*|будет\s+плюсом|не\s+обязател\w*))", ";", text, flags=re.I)
    return [part.strip() for part in re.split(r"[,;\n]+", text) if part.strip()]


def requirement_clauses_v3(text: str) -> list[str]:
    # Only explicit preference boundaries; never split .NET, C++ or AND/OR.
    text = re.sub(r"(?<=[.!?])\s+(?=(?:плюс\b|желател\w*|приветству\w*|будет\s+плюсом|не\s+обязател\w*))", ";", text, flags=re.I)
    text = re.sub(r"\s+(?=плюс\s)", ";", text, flags=re.I)
    return requirement_clauses(text)
