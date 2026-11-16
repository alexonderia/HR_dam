"""Проверка цитат и расчёт оценки по явной, версионированной формуле."""

import hashlib
import math
import re
from fractions import Fraction

from resume_evaluator.rank_models import ProfileRequest
from resume_evaluator.criteria import OPTIONAL_V3 as OPTIONAL, requirement_clauses_v3 as requirement_clauses
from resume_evaluator.additional_evidence import additional_evidence_verdict
from resume_evaluator.employment import verified_periods, union_months
from datetime import datetime
from zoneinfo import ZoneInfo

POLICY_VERSION = "evidence-v3"
CATEGORY_WEIGHTS = {"keyword": 40, "experience": 30, "education": 15, "additional": 15}
STOP_PENALTY = 10
MAX_STOP_PENALTY = 30
NEGATIVE = re.compile(r"\b(?:нет|без|отсутств\w*|отказ\w*|не\s+(?:готов\w*|име\w*|владе\w*|зна\w*|работа\w*|использ\w*|уме\w*))\b", re.I)
LEARNING = re.compile(r"\b(?:изучаю|изучает|учусь|прохожу\s+курс|прош[её]л\s+курс|курс\w*\s+по|начальн\w*|базов\w*)\b", re.I)
INTENTION = re.compile(r"\b(?:хотел\w*\s+бы|хочу|планирую|планирует|намерен\w*|желаю|мечтаю|интересует|ваканси\w*|требования\s+работодателя)\b", re.I)
YEAR = r"(?:лет|года?|years?)"
MONTH = r"(?:месяц\w*|months?)"
ALIASES = {"sql": ["SQL", "MS SQL", "T-SQL", "MSSQL"], "rest api": ["REST API", "RESTful API"]}


def normalized(text: str) -> str:
    return re.sub(r"\s+", " ", text).strip().casefold().replace("ё", "е")


def minimum_months(requirement: str) -> int | None:
    text = normalized(requirement)
    for word, number in {"одного": 1, "двух": 2, "трех": 3, "четырех": 4, "пяти": 5}.items():
        text = re.sub(rf"\b{word}\b", str(number), text)
    match = re.search(rf"(\d+)\s*(?:[-–—]\s*\d+\s*)?({YEAR}|{MONTH})\b", text)
    if not match:
        return None
    value = int(match[1]) * (12 if re.fullmatch(YEAR, match[2]) else 1)
    if re.fullmatch(YEAR, match[2]) and not re.search(r"[-–—]", match[0]):
        months = re.match(rf"\s*[,и]?\s*(\d+)\s*{MONTH}\b", text[match.end():])
        if months:
            value += int(months[1])
    return value if value > 0 else None


def duration_months(text: str) -> int | None:
    """Принимает только явную длительность; календарный год не является стажем."""
    match = re.search(rf"(?<!\d)(\d{{1,2}})\s*{YEAR}(?:\s*[,и]?\s*(\d{{1,2}})\s*{MONTH})?\b", normalized(text))
    if match:
        return int(match[1]) * 12 + int(match[2] or 0)
    match = re.search(rf"(?<!\d)(\d{{1,3}})\s*{MONTH}\b", normalized(text))
    return int(match[1]) if match else None


DURATION = re.compile(rf"(?<![\w])(\d{{1,3}})\s*{YEAR}(?:\s*[,и]?\s*(\d{{1,2}})\s*{MONTH})?\b|(?<![\w])(\d{{1,3}})\s*{MONTH}\b", re.I)
WORK = re.compile(r"работ(?:а|ы|ал|ала|аю|ает|ать)|стаж|должност|разработ|программист|developer|engineer|менеджер|специалист|инженер|преподавател|репетитор|электромонтаж|бухгалтер|руководител|дизайнер|аналитик|продаж|тестиров|администратор", re.I)
NON_WORK = re.compile(r"возраст|мужчина|женщина|родил|рождени|обучени|уч[её]б|образован|колледж|университет|школ|возраст\s+компании|компании\s+\d", re.I)
PERSONAL_AGE = re.compile(r"\byears?\s+old\b|\bage\b", re.I)
COMPANY_AGE = re.compile(r"\bкомпани\w*\b[^.;\n]{0,120}\b(?:существу\w*|основан\w*|на\s+рынке)\b|\bкомпания\b[^.;\n]{0,120}\bработает\b", re.I)
EXPLICIT_WORK = re.compile(r"\b(?:опыт\w*|стаж\w*|длительност\w*|проработ\w*|работа\w*|разработк\w*|experience|tenure|worked|working)\b", re.I)
STATEMENT_END = re.compile(r";|[.!?](?=\s|$)")
SUMMARY = re.compile(rf"(?:опыт\s+работы|общий\s+стаж)\s*[:—–-]?\s*(\d{{1,3}}\s*{YEAR}(?:\s*[,и]?\s*\d{{1,2}}\s*{MONTH})?|\d{{1,3}}\s*{MONTH})\b", re.I)
JOB_DATE = re.compile(r"^(?:(?:январ|феврал|март|апрел|ма[йя]|июн|июл|август|сентябр|октябр|ноябр|декабр)\w*\s+)?(?:19|20)\d{2}\s*[-–—]", re.I)
SECTION = re.compile(r"^(?:образование|навыки|ключевые навыки|обо мне|контакты|дополнительная информация|история|комментарии)\b", re.I)


def _employment_context(source, start, end):
    """Bind a duration to its statement or a single dated work record.

    Never join arbitrary model quotations. Timeline boundaries come from the
    source, and only the duration itself must be inside a verified quotation.
    """
    lines = list(re.finditer(r"[^\n]+", source))
    index = next((i for i, line in enumerate(lines) if line.start() <= start < line.end()), None)
    if index is None:
        return ""
    # A job-like phrase inside an education/skills section is still not an
    # employment record. A following explicit work heading opens a new section.
    for previous in reversed(lines[:index]):
        if re.match(r"^(?:опыт\s+работы|трудовая\s+деятельность|work\s+experience|employment)\b", previous[0], re.I):
            break
        if SECTION.search(previous[0]):
            return ""
    line = lines[index]
    # Prefer the containing sentence; this separates age, school and work even
    # when an export puts them on one line.
    # A dot inside Node.js, .NET or a version number is not a sentence boundary.
    boundaries = list(STATEMENT_END.finditer(source, line.start(), line.end()))
    left = max([line.start()] + [item.end() for item in boundaries if item.start() < start])
    right = min([line.end()] + [item.start() for item in boundaries if item.start() >= end])
    statement = source[left:right].strip()
    if NON_WORK.search(statement) or PERSONAL_AGE.search(statement) or COMPANY_AGE.search(statement) or SUMMARY.search(statement) or INTENTION.search(statement):
        return ""
    if not EXPLICIT_WORK.search(statement) and (source[left:start].rstrip().endswith(",") or source[end:right].lstrip().startswith(",")):
        # A title next to a comma-separated age is not a work-duration claim.
        # Explicit "опыт", "работаю", etc. keeps actual long careers valid.
        return ""
    if WORK.search(statement):
        # The duration regex already includes any following months line.
        return statement
    # A bare duration must be part of a dated employment record. Random nearby
    # headings (or another quotation with a role) cannot qualify age as work.
    first = index
    while first > 0 and index - first < 12:
        if JOB_DATE.search(lines[first][0]):
            break
        if SECTION.search(lines[first - 1][0]) or DURATION.search(lines[first - 1][0]):
            return ""
        first -= 1
    if not JOB_DATE.search(lines[first][0]):
        return ""
    last = index + 1
    while last < len(lines) and last - index <= 12:
        if lines[last].start() < end:
            last += 1
            continue
        if JOB_DATE.search(lines[last][0]) or SECTION.search(lines[last][0]) or DURATION.search(lines[last][0]):
            break
        last += 1
    record = "\n".join(line[0] for line in lines[first:last])
    return record if (WORK.search(record) and not NON_WORK.search(record)
                      and not PERSONAL_AGE.search(record) and not COMPANY_AGE.search(record)) else ""


def _relevant_work(requirement, context, *, complete=True):
    """Conservative lexical guards supplement, never replace, model semantics."""
    requirement, context = normalized(requirement), normalized(context)
    # Explicit technologies must occur in the same work record, not the skills
    # list or another job. Slash / explicit OR denotes alternatives.
    technologies = [token.rstrip(".-") for token in re.findall(r"(?<!\w)[a-z][a-z0-9+#.-]*(?!\w)", requirement)]
    if technologies:
        found = [bool(re.search(r"(?<!\w)" + re.escape(t) + r"(?!\w)", context)) for t in technologies]
        if not (any(found) if re.search(r"\bили\b|/", requirement) else all(found)):
            return False
    families = ((r"разработ|программир", r"разработ|программист|developer|software"),
                (r"продаж", r"продаж|sales"), (r"бухгалтер", r"бухгалтер|accountant"),
                (r"преподав|обучени", r"преподав|учител|репетитор|teacher"))
    for wanted, supported in families:
        if re.search(wanted, requirement) and not re.search(supported, context):
            return False
    if complete and "микросервис" in requirement and not re.search(r"микросервис|microservice", context):
        return False
    # For other specialities require a concrete shared term; a generic number
    # of years alone is acceptable only when no speciality was requested.
    ignored = {"от", "до", "не", "менее", "более", "лет", "год", "года", "месяцев", "месяца", "месяц", "опыт", "опыта", "работы", "работа", "стаж", "стажа", "коммерческой", "коммерческий", "наличие", "на", "в", "и", "или", "с", "по", "трех", "двух", "одного", "четырех", "пяти"}
    terms = [word for word in re.findall(r"[а-я]+", requirement) if word not in ignored and len(word) > 2]
    return not terms or any(word[:6] in context for word in terms) or bool(technologies)


def relevant_durations(source, evidence, requirement, status="met"):
    values = []
    for match in DURATION.finditer(source):
        if not any(item["start"] <= match.start() and match.end() <= item["end"] for item in evidence):
            continue
        context = _employment_context(source, match.start(), match.end())
        if context and _relevant_work(requirement, context, complete=status == "met"):
            values.append(int(match[1]) * 12 + int(match[2] or 0) if match[1] else int(match[3]))
    return values


def format_months(value: int, *, minimum=False) -> str:
    def unit(number, forms):
        return forms[2] if 11 <= number % 100 <= 14 else forms[0] if number % 10 == 1 else forms[1] if 2 <= number % 10 <= 4 else forms[2]
    years, months = divmod(value, 12)
    parts = []
    if years:
        word = ('года' if years % 10 == 1 and years % 100 != 11 else 'лет') if minimum else unit(years, ('год', 'года', 'лет'))
        parts.append(f"{years} {word}")
    if months or not parts:
        word = ('месяца' if months % 10 == 1 and months % 100 != 11 else 'месяцев') if minimum else unit(months, ('месяц', 'месяца', 'месяцев'))
        parts.append(f"{months} {word}")
    return " ".join(parts)


def compile_criteria(profile: ProfileRequest, cluster_requirements: str = "") -> list[dict]:
    criteria = []

    def add(identifier, category, requirement, source):
        requirement = requirement.strip()
        if requirement:
            criteria.append({"id": identifier, "category": category, "requirement": requirement,
                             "source": source, "optional": bool(OPTIONAL.search(requirement)), "weight": 0})

    for index, item in enumerate(profile.keywords):
        for part, keyword in enumerate(re.split(r"[,;\n]+", item)):
            add(f"keyword:{index}:{part}", "keyword", keyword, "keywords")
    for category in ("experience", "education"):
        text = getattr(profile, category) or ""
        # Optional qualifications must not turn the required degree into an optional criterion.
        clauses = requirement_clauses(text) if OPTIONAL.search(text) else [text]
        for index, clause in enumerate(clauses):
            add(f"{category}:{index}", category, clause, category)
    for source, text in (("profile_comment", profile.comment or ""), ("cluster_comment", cluster_requirements)):
        for index, clause in enumerate(requirement_clauses(text)):
            add(f"{source}:{index}", "additional", clause, source)

    mandatory = [c for c in criteria if not c["optional"]]
    categories = {c["category"] for c in mandatory}
    total = sum(CATEGORY_WEIGHTS[c] for c in categories)
    if total:
        weights = []
        for criterion in mandatory:
            count = sum(c["category"] == criterion["category"] for c in mandatory)
            exact = Fraction(10000 * CATEGORY_WEIGHTS[criterion["category"]], total * count)
            criterion["weight"] = int(exact)
            weights.append((exact - int(exact), criterion))
        remainder = 10000 - sum(c["weight"] for c in mandatory)
        for _, criterion in sorted(weights, key=lambda item: (-item[0], item[1]["id"]))[:remainder]:
            criterion["weight"] += 1
    return criteria


def quote_evidence(source: str, quote: str) -> dict | None:
    """Возвращает исходный фрагмент и Unicode offsets, не текст модели."""
    if not quote.strip() or len(quote) > 2000:
        return None
    chars, offsets = [], []
    for index, char in enumerate(source):
        if char.isspace():
            if chars and chars[-1] != " ":
                chars.append(" ")
                offsets.append(index)
        else:
            for lowered in char.casefold().replace("ё", "е"):
                chars.append(lowered)
                offsets.append(index)
    needle = normalized(quote)
    position = "".join(chars).find(needle)
    if position < 0:
        return None
    start, end = offsets[position], offsets[position + len(needle) - 1] + 1
    return {"quote": source[start:end], "start": start, "end": end}


def _skill_evidence(source: str, keyword: str) -> tuple[str, list[dict]]:
    for conjunction, mode in ((r"\s+или\s+", "any"), (r"\s+и\s+", "all")):
        parts = re.split(conjunction, keyword, flags=re.I)
        if len(parts) <= 1:
            continue
        values = [_skill_evidence(source, part.strip()) for part in parts]
        statuses = [status for status, _ in values]
        if mode == "all":
            status = "not_met" if "not_met" in statuses else "met" if all(s == "met" for s in statuses) else "partial" if any(s in {"met", "partial"} for s in statuses) else "unknown"
        else:
            status = "met" if "met" in statuses else "partial" if "partial" in statuses else "not_met" if all(s == "not_met" for s in statuses) else "unknown"
        selected = values
        if status == "not_met" or (mode == "any" and status == "met"):
            selected = [(s, quotes) for s, quotes in values if s == status]
        evidence = {(e["start"], e["end"]): e for _, quotes in selected for e in quotes}
        return status, list(evidence.values())
    aliases = ALIASES.get(normalized(keyword), [keyword])
    positive, negative, learning, intentions = [], [], [], []
    for alias in aliases:
        pattern = r"(?<![\w])" + r"\s+".join(re.escape(word) for word in alias.split()) + r"(?![\w])"
        for match in re.finditer(pattern, source, re.I):
            # Keep the surrounding statement so a quoted skill cannot hide its negation.
            boundaries = list(STATEMENT_END.finditer(source))
            start = max([source.rfind("\n", 0, match.start()) + 1] + [b.end() for b in boundaries if b.start() < match.start()])
            ends = [source.find("\n", match.end())] + [b.start() for b in boundaries if b.start() >= match.end()]
            end = min([e for e in ends if e >= 0] or [len(source)])
            start, end = max(start, match.start() - 160), min(end, match.end() + 160)
            context = source[start:end].strip()
            evidence = quote_evidence(source, context)
            if evidence is None:
                continue
            if INTENTION.search(context):
                intentions.append(evidence)
                continue
            before = source[max(start, match.start() - 70):match.start()]
            after = source[match.end():min(end, match.end() + 30)]
            if NEGATIVE.search(before) or re.match(r"\s*[:—–-]?\s*(?:нет|не\s+знаю|не\s+владею)\b", after, re.I):
                negative.append(evidence)
            elif LEARNING.search(context):
                learning.append(evidence)
            else:
                positive.append(evidence)
    if negative and (positive or learning):
        return "unknown", (negative[:1] + (positive or learning)[:1])
    if positive:
        return "met", positive[:1]
    if learning:
        return "partial", learning[:1]
    if negative:
        return "not_met", negative[:1]
    return "unknown", intentions[:1]


def _verified_quotes(source, quotes):
    evidence = [quote_evidence(source, quote) for quote in quotes]
    # A fabricated part must not be used to qualify a real but unrelated quotation.
    if not evidence or any(item is None for item in evidence):
        return []
    return list({(e["start"], e["end"]): e for e in evidence}.values())


def verified_assessment_evidence(source, assessment):
    if not assessment:
        return []
    if "_verified_evidence" not in assessment:
        return _verified_quotes(source, assessment["evidence"])
    evidence = assessment["_verified_evidence"]
    if any(not 0 <= e["start"] < e["end"] <= len(source) or source[e["start"]:e["end"]] != e["quote"] for e in evidence):
        return []
    return evidence


def _assess_criterion(criterion, assessment, source, assessment_date):
    status = assessment["status"] if assessment else "unknown"
    evidence = verified_assessment_evidence(source, assessment)
    reason = assessment.get("unknown_reason") if assessment else None
    if status != "unknown" and not evidence:
        status = "unknown"
        reason = "unverified_evidence"
    if criterion["category"] == "keyword":
        checked_status, checked_evidence = _skill_evidence(source, criterion["requirement"])
        if assessment is None:
            status, evidence = checked_status, checked_evidence
        elif status != "unknown":
            if checked_status == "unknown":
                status = "unknown"
                reason = "future_intent" if INTENTION.search(" ".join(e["quote"] for e in evidence)) else "unverified_evidence"
            elif checked_status in {"not_met", "partial"} or status == "not_met":
                status = checked_status if checked_status in {"not_met", "partial"} else "unknown"
                evidence = checked_evidence
            else:
                evidence = checked_evidence
            # An explicit model unknown is never promoted by a keyword match.
    result = {**criterion, "status": status, "evidence": evidence, "credit": {"met": 1, "partial": .5}.get(status, 0)}
    if criterion["category"] == "additional" and status != "unknown":
        supported, why = additional_evidence_verdict(criterion["requirement"], status, [e["quote"] for e in evidence])
        if not supported:
            result.update(status="unknown", credit=0)
            reason = why
    partial_reason = (assessment or {}).get("partial_reason") or "missing_parts"
    if criterion["category"] == "keyword" and status == "partial" and LEARNING.search(" ".join(e["quote"] for e in evidence)):
        partial_reason = "learning"
    if criterion["category"] == "experience":
        technologies = [t.rstrip(".-") for t in re.findall(r"(?<!\w)[a-z][a-z0-9+#.-]*(?!\w)", normalized(criterion["requirement"]))]
        denied = [_skill_evidence(source, technology) for technology in technologies]
        hard_noncompliance = bool(denied) and (all(s == "not_met" for s, _ in denied) if re.search(r"\bили\b", criterion["requirement"], re.I) else any(s == "not_met" for s, _ in denied))
        if hard_noncompliance and status != "unknown":
            result.update(status="not_met", credit=0)
            for rejected, quotes in denied:
                if rejected == "not_met":
                    evidence.extend(e for e in quotes if e not in evidence)
        required = minimum_months(criterion["requirement"])
        observed = relevant_durations(source, evidence, criterion["requirement"], status)
        periods, date_quotes = verified_periods(source, evidence, criterion["requirement"], assessment_date,
            lambda requirement, block: bool(WORK.search(block)) and _relevant_work(requirement, block, complete=status == "met"),
            lambda block: bool(NON_WORK.search(block) or PERSONAL_AGE.search(block) or COMPANY_AGE.search(block) or INTENTION.search(block)), duration_months)
        dated_months = union_months(periods)
        if periods:
            observed.append(dated_months)
            for quote in date_quotes:
                if quote not in evidence:
                    evidence.append(quote)
        # A total-experience summary also caps claims of longer relevant experience.
        summary = SUMMARY.search(source)
        total = duration_months(summary[1]) if summary else None
        inconsistent_total = total is not None and bool(observed) and max(observed) > total
        if required and total is not None and total < required:
            summary_evidence = quote_evidence(source, summary[0])
            if summary_evidence and summary_evidence not in evidence:
                evidence.append(summary_evidence)
            # The summary is an upper bound, not proof of relevant experience.
            if not observed:
                result.update(status="unknown", credit=0)
            observed = [min(value, total) for value in observed]
        if required and observed:
            actual = max(observed)  # Never sum potentially overlapping jobs.
            if periods and dated_months >= max(observed):
                result["work_periods"] = periods
            if total is not None:
                actual = min(actual, total)
            if result["status"] in {"met", "partial"}:
                if actual < required:
                    if result["status"] == "met":
                        partial_reason = "duration"
                    result.update(status="partial" if actual > 0 else "not_met",
                                  credit=min(actual / required, 1 if partial_reason == "duration" else .5))
                elif result["status"] == "partial" and partial_reason == "duration":
                    # The model explicitly confirmed every nonnumeric condition.
                    # Verified calendar arithmetic resolves only the numeric part.
                    result.update(status="met", credit=1)
            if result["status"] != "unknown":
                result["experience_months"] = actual
        elif required and result["status"] != "unknown" and not hard_noncompliance:
            result.update(status="unknown", credit=0)
            reason = "not_relevant"
        if required:
            result["required_months"] = required
        if total is not None:
            result["total_experience_months"] = total
        if inconsistent_total:
            result.update(status="unknown", credit=0)
            result.pop("experience_months", None)
            reason = "contradictory"
            quote = quote_evidence(source, summary[0])
            if quote and quote not in evidence:
                evidence.append(quote)
        if hard_noncompliance:
            result.pop("experience_months", None)
            result.pop("work_periods", None)
        result["evidence"] = evidence
    if criterion["category"] == "education" and evidence:
        required = normalized(criterion["requirement"])
        education = normalized(" ".join(e["quote"] for e in evidence))
        higher = bool(re.search(r"высшее|бакалавр|магистр|специалитет|bachelor|master", education))
        secondary = bool(re.search(r"среднее|колледж|техникум", education))
        if not re.search(r"образован|высшее|бакалавр|магистр|специалитет|bachelor|master|среднее|колледж|техникум|университет|институт|аспирант|mba", education):
            result.update(status="unknown", credit=0)
        # Handle the unambiguous degree-level case; a field of study still needs comparison.
        if required in {"высшее", "высшее образование"}:
            if higher:
                result.update(status="met", credit=1)
            elif secondary:
                result.update(status="not_met", credit=0)
            else:
                result.update(status="unknown", credit=0)
    result["possible_credit"] = result["credit"] if result["status"] != "unknown" else min(
        result["total_experience_months"] / result["required_months"], 1
    ) if result.get("required_months") and result.get("total_experience_months") is not None else 1
    if result["status"] == "unknown":
        if criterion["category"] == "keyword":
            checked, quotes = _skill_evidence(source, criterion["requirement"])
            if checked == "unknown" and quotes:
                reason = "future_intent" if INTENTION.search(" ".join(e["quote"] for e in quotes)) else "not_stated" if re.search(r"\s(?:и|или)\s", criterion["requirement"], re.I) else "contradictory"
        result["unknown_reason"] = reason or "not_stated"
    if result["status"] == "partial":
        result["partial_reason"] = partial_reason
    return result


def _content_tokens(text):
    ignored = {"нет", "без", "не", "по", "на", "из", "от", "до", "за", "со", "во", "при", "опыт", "опыта", "наличие", "отсутствие", "кандидат", "кандидатов", "рассматриваем", "только", "работы", "лет", "года", "год"}
    return {token[:6] for token in re.findall(r"[\w+#]+", normalized(text)) if len(token) >= 2 and token not in ignored}


def _stop_supported(requirement, evidence, source):
    text = " ".join(e["quote"] for e in evidence)
    threshold = minimum_months(requirement)
    if threshold and re.search(r"менее|недостат", requirement, re.I):
        durations = relevant_durations(source, evidence, requirement)
        return bool(durations) and max(durations) < threshold
    if not _content_tokens(requirement).intersection(_content_tokens(text)):
        return False
    if NEGATIVE.search(requirement) and not NEGATIVE.search(text):
        return False
    return True


def round_score(value):
    return math.floor(max(0, min(100, value)) * 100 + .5) / 100


def _explanation(criteria, stops, score_range, coverage, truncated):
    groups = {status: [c for c in criteria if c["status"] == status] for status in ("met", "partial", "not_met", "unknown")}
    lines = []
    for status, label in (("met", "Подтверждено"), ("partial", "Частичное соответствие"), ("not_met", "Подтверждённое несоответствие"), ("unknown", "Не указано")):
        if not groups[status]:
            continue
        if status == "unknown":
            categories = {"keyword": "Навыки", "experience": "Опыт", "education": "Образование", "additional": "Дополнительные сведения"}
            lines.append(label + ": " + ", ".join(dict.fromkeys(categories[c["category"]] for c in groups[status])) + ".")
            continue
        items = []
        for criterion in groups[status]:
            item = criterion["requirement"]
            if "required_months" in criterion:
                actual = criterion.get("experience_months")
                total = criterion.get("total_experience_months")
                if actual is not None:
                    item += f" — в приведённых сведениях {format_months(actual)}, требуется не менее {format_months(criterion['required_months'], minimum=True)}"
                elif total is not None:
                    item += f" — общий стаж {format_months(total)}, требуется не менее {format_months(criterion['required_months'], minimum=True)}; релевантность стажа требует уточнения"
            if criterion["optional"]:
                item += " (желательное требование, на балл не влияет)"
            if criterion["evidence"]:
                item += " — «" + criterion["evidence"][0]["quote"] + "»"
            items.append(item)
        lines.append(label + ": " + "; ".join(items) + ".")
    triggered = [s for s in stops if s["status"] == "triggered"]
    if triggered:
        lines.append("Подтверждённые стоп-факторы: " + "; ".join(s["requirement"] + " — «" + s["evidence"][0]["quote"] + "»" for s in triggered) + ".")
    unknown_stops = [s["requirement"] for s in stops if s["status"] == "unknown"]
    if unknown_stops:
        lines.append("Стоп-факторы требуют уточнения, штраф не применён: " + "; ".join(unknown_stops) + ".")
    if truncated or not coverage or score_range['max'] - score_range['min'] > 20:
        lines.append(f"Подтверждённая оценка: {score_range['min']:g} из 100. Недостаточно сведений для полной оценки. Баллы начислены только за подтверждённые требования. Уточните недостающие сведения — оценка может измениться.")
    elif score_range['min'] == score_range['max']:
        lines.append(f"Подтверждённая оценка: {score_range['min']:g} из 100.")
    else:
        lines.append(f"Диапазон оценки: {score_range['min']:g}–{score_range['max']:g} из 100.")
    if truncated:
        lines.append("Оценён только фрагмент резюме из-за ограничения контекста; оставшиеся сведения требуют проверки.")
    return "\n".join(lines)


def verify_and_score(parsed: dict, source: str, profile: ProfileRequest, cluster_requirements="", *, model="", context_truncated=False, assessment_date=None, context_chunks=1) -> dict:
    assessment_date = assessment_date or datetime.now(ZoneInfo("Europe/Moscow")).date().isoformat()
    criteria = compile_criteria(profile, cluster_requirements)
    expected = {c["id"] for c in criteria}
    assessment_ids = [a["id"] for a in parsed["assessments"]]
    stop_ids = [s["id"] for s in parsed["stop_factors"]]
    if len(set(assessment_ids)) != len(assessment_ids) or set(assessment_ids) - expected:
        raise ValueError("Модель вернула неизвестный или повторяющийся критерий")
    expected_stops = {f"stop:{i}" for i in range(len(profile.stop_factors))}
    if len(set(stop_ids)) != len(stop_ids) or set(stop_ids) - expected_stops:
        raise ValueError("Модель вернула неизвестный или повторяющийся стоп-фактор")
    by_id = {a["id"]: a for a in parsed["assessments"]}
    checked = [_assess_criterion(c, by_id.get(c["id"]), source, assessment_date) for c in criteria]
    stops = []
    by_stop = {s["id"]: s for s in parsed["stop_factors"]}
    penalized = set()
    for index, requirement in enumerate(profile.stop_factors):
        identifier = f"stop:{index}"
        assessment = by_stop.get(identifier)
        status = assessment["status"] if assessment else "unknown"
        evidence = verified_assessment_evidence(source, assessment)
        if status != "unknown" and not evidence or status == "triggered" and not _stop_supported(requirement, evidence, source):
            status = "unknown"
        duplicates = [c["id"] for c in checked if c["status"] in {"partial", "not_met"}
                      and (_content_tokens(c["requirement"]).intersection(_content_tokens(requirement))
                           or c["category"] == "experience" and c.get("required_months") is not None
                           and c["required_months"] == minimum_months(requirement))]
        key = normalized(requirement)
        penalty = STOP_PENALTY if status == "triggered" and not duplicates and key not in penalized else 0
        if penalty:
            penalized.add(key)
        stops.append({"id": identifier, "requirement": requirement, "status": status, "evidence": evidence,
                      "penalty": penalty, "duplicates": duplicates,
                      **({"unknown_reason": (assessment or {}).get("unknown_reason") or "not_stated"} if status == "unknown" else {})})
    penalty = min(MAX_STOP_PENALTY, sum(s["penalty"] for s in stops))
    points = sum(c["weight"] * c["credit"] for c in checked) / 100
    unknown = sum(c["weight"] * c["possible_credit"] for c in checked if c["status"] == "unknown") / 100
    coverage = round_score(sum(c["weight"] for c in checked if c["status"] != "unknown") / 100)
    score_range = {"min": round_score(points - penalty), "max": round_score(points + unknown - penalty)}
    if not any(c["weight"] for c in checked):
        score_range = {"min": 0, "max": 100}
    details = {"method": "evidence-v1", "policy_version": POLICY_VERSION, "policy_status": "provisional",
               "model": model, "assessment_date": assessment_date, "context_chunks": context_chunks,
               "source_text_sha256": hashlib.sha256(source.encode()).hexdigest(),
               "source_text_length": len(source), "context_truncated": context_truncated,
               "criteria": checked, "stop_factors": stops, "coverage": coverage, "score_range": score_range,
               "stop_penalty": penalty, "score_status": "insufficient_evidence" if not coverage else "evaluated"}
    return {"score": score_range["min"],
            "matched_keywords": list(dict.fromkeys(c["requirement"] for c in checked if c["category"] == "keyword" and c["status"] in {"met", "partial"})),
            "triggered_stop_factors": list(dict.fromkeys(s["requirement"] for s in stops if s["status"] == "triggered")),
            "explanation": _explanation(checked, stops, score_range, coverage, context_truncated), "details": details}


def validate_rating_source(rating: dict, resume_text: str) -> None:
    """Повторная проверка границ цитат перед выдачей результата HTTP/AMQP."""
    details = rating.get("details", {})
    if details.get("method") != "evidence-v1":
        return
    size = details["source_text_length"]
    if size > len(resume_text) or details["source_text_sha256"] != hashlib.sha256(resume_text[:size].encode()).hexdigest():
        raise ValueError("Источник подтверждений не совпадает с анализируемым резюме")
    for item in details["criteria"] + details["stop_factors"]:
        for evidence in item["evidence"]:
            if not 0 <= evidence["start"] < evidence["end"] <= size or resume_text[evidence["start"]:evidence["end"]] != evidence["quote"]:
                raise ValueError("Цитата не совпадает с исходным текстом резюме")
