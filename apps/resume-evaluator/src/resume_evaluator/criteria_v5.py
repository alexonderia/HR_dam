"""Quote-aware clauses and explicit delimiter priority for skills/stop lists."""
import re
from resume_evaluator.criteria import OPTIONAL_V4

OPTIONAL_V5 = re.compile(OPTIONAL_V4.pattern + r"|преимуществен\w*|приоритет\w*", re.I)


def protected_text(text):
    masked = list(text)
    quote = None
    depth = 0
    for i, char in enumerate(text):
        if quote:
            masked[i] = " "
            if char == quote:
                quote = None
        elif char in ('"', '«', '“'):
            quote = {'«': '»', '“': '”'}.get(char, char)
            masked[i] = " "
        elif char == '(':
            depth += 1
            masked[i] = " "
        elif depth:
            masked[i] = " "
            if char == ')':
                depth -= 1
    return ''.join(masked)


def clauses_v5(text):
    masked = protected_text(text)
    boundary = re.compile(r"[;\n]+|\s+(?:и|а|но)\s+(?=желател)|(?<=[а-яa-z][а-яa-z][.!?])\s+|,\s*(?=(?:желател\w*|предпочтител\w*|преимуществен\w*|приоритет\w*|mba\s+приветству\w*))", re.I)
    result, start = [], 0
    for match in boundary.finditer(masked):
        if text[start:match.start()].strip():
            result.append(text[start:match.start()].strip())
        start = match.end()
    if text[start:].strip():
        result.append(text[start:].strip())
    return result


def condition_v5(text):
    masked = protected_text(text)
    any_matches = list(re.finditer(r"\s+(?:или|либо)\s+", masked, re.I))
    all_matches = list(re.finditer(r"\s+и\s+", masked, re.I))
    ambiguous = bool(re.search(r"\b(?:если|кроме)\b|при\s+условии|за\s+исключением", masked, re.I))
    if ambiguous or any_matches and all_matches:
        return {"operator": "ambiguous", "parts": [text]}
    action=r"^(?:организац|контрол|руковод|распредел|планирован|подготов|состав|веден|проведен|настро|разработ|проверк|обеспеч|диагност|обслужив|ремонт)"
    matches = any_matches or all_matches
    if not matches:
        return {"operator": "atomic", "parts": [text]}
    parts, start = [], 0
    for match in matches:
        parts.append(text[start:match.start()].strip())
        start = match.end()
    parts.append(text[start:].strip())
    if not any_matches and not (all(re.search(action,p,re.I) for p in parts) or all(re.fullmatch(r"[a-z0-9+# .:/-]+",p,re.I) for p in parts)):
        return {"operator":"atomic","parts":[text]}
    # Shared adjective alternatives keep their common action and object.
    # "контроль складских или транспортных операций" is not two unrelated fragments.
    if any_matches and len(parts) == 2:
        left = re.match(r"^(.*?)([а-яё]+(?:ых|ого|ных|ной|ые|ного))$", parts[0], re.I)
        right = re.match(r"^([а-яё]+(?:ых|ого|ных|ной|ые|ного))\s+(.+)$", parts[1], re.I)
        if left and right and left[1].strip():
            parts = [left[1] + left[2] + ' ' + right[2], left[1] + right[1] + ' ' + right[2]]
    return {"operator": "any" if any_matches else "all", "parts": parts}


def requirement_list_v5(text):
    text = text.strip()
    # Mirror contracts: .NET/version dots are not sentence delimiters.
    explicit = list(re.finditer(r'[;\r\n]|\.(?=\s|;|$)', text))
    separators = explicit or list(re.finditer(r'(?<!\d),|,(?!\d)', text))
    result, start = [], 0
    for match in separators:
        if text[start:match.start()].strip():
            result.append(text[start:match.start()].strip())
        start = match.end()
    if text[start:].strip():
        result.append(text[start:].strip())
    return result
