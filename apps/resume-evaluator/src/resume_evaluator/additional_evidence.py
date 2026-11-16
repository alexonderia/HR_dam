"""Conservative relevance checks for free-form recruiter requirements.

Mirrored by contracts/additional-evidence.ts. A real quote is necessary but is
not proof of an unrelated condition. This check never promotes model unknown.
"""
import re
from resume_evaluator.criteria import OPTIONAL_V3, requirement_clauses_v3

CONCEPTS = [
    (r"\b(?:kubernetes|k8s)\b", r"\b(?:kubernetes|k8s)\b"),
    (r"высоконагруж\w*|high[ -]?load", r"высоконагруж\w*|high[ -]?load|высок(?:ая|ие|их|ую)\s+нагруз\w*"),
    (r"б[эе]кенд\w*|back[ -]?end", r"б[эе]кенд\w*|back[ -]?end|server[ -]?side|серверн\w*\s+(?:разработ\w*|част\w*)"),
]
IGNORED = {"ищем", "нужен", "нужна", "сильного", "сильный", "кандидат", "кандидата", "требуется",
    "опыт", "опыта", "опытом", "работы", "работа", "работать", "знание", "знания", "навык", "навыки",
    "умение", "владение", "для", "систем", "системы", "системами", "системах", "плюс", "желательно",
    "желателен", "желательна", "приветствуется", "будет", "плюсом", "сильных", "уверенное", "хорошее",
    "коммерческий", "коммерческого", "требование", "наличие", "обязательно", "обязателен", "специалист", "специалиста", "от", "до",
    "лет", "года", "год", "месяцев", "with", "and", "the", "for", "experience", "knowledge"}
NEGATIVE = re.compile(r"\b(?:нет|без|отсутств\w*|никогда|не\s+(?:име\w*|владе\w*|зна\w*|работ\w*|использ\w*|занима\w*|готов\w*|уме\w*|дела\w*|разрабатыва\w*))\b", re.I)
INTENT = re.compile(r"хотел\w*\s+бы|хочу|планирую|намерен\w*|желаю\s+изуч|мечтаю", re.I)
LEARNING = re.compile(r"изучаю|учусь|прохожу\s+курс|учебн\w*|базов\w*\s+уров", re.I)


def _anchors(requirement):
    text = requirement.casefold().replace("ё", "е")
    anchors = []
    for wanted, evidence in CONCEPTS:
        if re.search(wanted, text, re.I):
            anchors.append(evidence)
            text = re.sub(wanted, " ", text, flags=re.I)
    for token in re.findall(r"(?<!\w)[a-z][a-z0-9+#.-]*", text):
        token = token.rstrip(".-")
        if token not in IGNORED:
            anchors.append(r"(?<![\w])" + re.escape(token) + r"(?![\w])")
    # Without explicit technical concepts, require a meaningful Russian term.
    if not anchors:
        for token in re.findall(r"[а-я]+", text):
            if len(token) >= 4 and token not in IGNORED:
                anchors.append(re.escape(token[:6]) + r"\w*")
    return list(dict.fromkeys(anchors))


def additional_evidence_verdict(requirement, status, quotes):
    if status == "unknown":
        return True, None
    clauses = requirement_clauses_v3(requirement)
    mandatory = [c for c in clauses if not OPTIONAL_V3.search(c)]
    if status == "not_met" and mandatory and len(mandatory) < len(clauses):
        return additional_evidence_verdict(" и ".join(mandatory), status, quotes)
    alternatives = re.split(r"\s+или\s+", requirement, flags=re.I)
    if len(alternatives) > 1:
        answers = [additional_evidence_verdict(part, status, quotes) for part in alternatives]
        return (all(a[0] for a in answers) if status == "not_met" else any(a[0] for a in answers)), "not_relevant"
    anchors = _anchors(requirement)
    if not anchors:
        return False, "ambiguous_requirement"
    if not quotes:
        return False, "unverified_evidence"
    positive, negative, learning, intentions = set(), set(), set(), set()
    for quote in quotes:
        # A denial about another skill in the same paragraph must not qualify.
        for sentence in re.split(r"[,;\n]|[.!?](?=\s|$)|\s+(?:но|однако|а|зато)\s+|\s+и\s+(?=не\s|нет\b|без\b)", quote):
            for index, anchor in enumerate(anchors):
                for match in re.finditer(anchor, sentence, re.I):
                    context = sentence[max(0, match.start()-70):min(len(sentence), match.end()+70)]
                    if INTENT.search(context): intentions.add(index)
                    elif NEGATIVE.search(context): negative.add(index)
                    elif LEARNING.search(context): learning.add(index)
                    else: positive.add(index)
    if positive.intersection(negative):
        return False, "contradictory"
    if status == "not_met":
        return bool(negative), "not_relevant"
    if status == "met":
        return len(positive) == len(anchors) and not negative and not learning, "future_intent" if intentions else "not_relevant"
    return bool(positive or learning) and not negative, "future_intent" if intentions else "not_relevant"
