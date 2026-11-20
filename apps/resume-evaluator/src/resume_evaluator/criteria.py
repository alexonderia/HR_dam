"""Deterministic requirement clauses; mirrored by contracts/criteria.ts."""

import re

OPTIONAL = re.compile(r"желател\w*|приветству\w*|будет\s+плюсом|не\s+обязател\w*", re.I)
OPTIONAL_V3 = re.compile(OPTIONAL.pattern + r"|(?:^|[.!?;\n]\s*)плюс\b", re.I)
OPTIONAL_V4 = re.compile(OPTIONAL_V3.pattern + r"|предпочтител\w*", re.I)


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


def requirement_clauses_v4(text: str) -> list[str]:
    text=re.sub(r"\s+(?:и|а|но)\s+(?=(?:желател\w*|предпочтител\w*|приветству\w*|будет\s+плюсом|не\s+обязател\w*))", ";", text, flags=re.I)
    if re.search(r"\b(?:если|кроме)\b|при\s+условии|за\s+исключением",text,re.I):return [text.strip()] if text.strip() else []
    return [p.strip() for p in re.split(r"(?<=[а-яa-z][а-яa-z][.!?])\s+|[;\n]+|(?<!\d),|,(?!\d)", text,flags=re.I) if p.strip()]


def condition_structure(text):
    all_parts = re.split(r"\s+и\s+", text, flags=re.I)
    any_parts = re.split(r"\s+или\s+", text, flags=re.I)
    ambiguous = bool(re.search(r"\b(?:если|кроме)\b|при\s+условии|за\s+исключением",text,re.I)) or len(all_parts)>1 and len(any_parts)>1
    operator = "ambiguous" if ambiguous else "all" if len(all_parts)>1 else "any" if len(any_parts)>1 else "atomic"
    return {"operator":operator,"parts":all_parts if operator=="all" else any_parts if operator=="any" else [text]}


def requirement_list(text):
    return [p.strip() for p in re.split(r"(?<!\d),|,(?!\d)|[;\n]+",text) if p.strip()]
