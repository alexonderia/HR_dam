"""Проверка цитат и расчёт оценки по явной, версионированной формуле."""

import hashlib
import math
import re
from fractions import Fraction

from app.rank_models import ProfileRequest

POLICY_VERSION = "evidence-v1"
CATEGORY_WEIGHTS = {"keyword": 40, "experience": 30, "education": 15, "additional": 15}
STOP_PENALTY = 10
MAX_STOP_PENALTY = 30
OPTIONAL = re.compile(r"желатель\w*|приветству\w*|будет\s+плюсом|не\s+обязател\w*", re.I)
NEGATIVE = re.compile(r"\b(?:нет|без|отсутств\w*|отказ\w*|не\s+(?:готов\w*|име\w*|владе\w*|зна\w*|работа\w*|использ\w*|уме\w*))\b", re.I)
LEARNING = re.compile(r"\b(?:изучаю|изучает|учусь|планирую|хочу\s+изучить|начальн\w*|базов\w*)\b", re.I)
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
        clauses = re.split(r"[,;\n]+", text) if OPTIONAL.search(text) else [text]
        for index, clause in enumerate(clauses):
            add(f"{category}:{index}", category, clause, category)
    for source, text in (("profile_comment", profile.comment or ""), ("cluster_comment", cluster_requirements)):
        for index, clause in enumerate(re.split(r"[;\n]+", text)):
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
    aliases = ALIASES.get(normalized(keyword), [keyword])
    positive, negative, learning = [], [], []
    for alias in aliases:
        pattern = r"(?<![\w])" + r"\s+".join(re.escape(word) for word in alias.split()) + r"(?![\w])"
        for match in re.finditer(pattern, source, re.I):
            # Keep the surrounding statement so a quoted skill cannot hide its negation.
            start = max(source.rfind("\n", 0, match.start()), source.rfind(".", 0, match.start()), -1) + 1
            ends = [value for value in (source.find("\n", match.end()), source.find(".", match.end())) if value >= 0]
            end = min(ends) if ends else len(source)
            start, end = max(start, match.start() - 160), min(end, match.end() + 160)
            context = source[start:end].strip()
            evidence = quote_evidence(source, context)
            if evidence is None:
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
    return "unknown", []


def _verified_quotes(source, quotes):
    evidence = [quote_evidence(source, quote) for quote in quotes]
    # A fabricated part must not be used to qualify a real but unrelated quotation.
    if not evidence or any(item is None for item in evidence):
        return []
    return list({(e["start"], e["end"]): e for e in evidence}.values())


def _assess_criterion(criterion, assessment, source):
    status = assessment["status"] if assessment else "unknown"
    evidence = _verified_quotes(source, assessment["evidence"]) if assessment else []
    if status != "unknown" and not evidence:
        status = "unknown"
    if criterion["category"] == "keyword":
        status, evidence = _skill_evidence(source, criterion["requirement"])
    result = {**criterion, "status": status, "evidence": evidence, "credit": {"met": 1, "partial": .5}.get(status, 0)}
    if criterion["category"] == "experience":
        required = minimum_months(criterion["requirement"])
        observed = [duration_months(item["quote"]) for item in evidence]
        observed = [value for value in observed if value is not None]
        # A total-experience summary also caps claims of longer relevant experience.
        summary = re.search(rf"(?:опыт\s+работы|общий\s+стаж)\s*[:—–-]?\s*(\d{{1,2}}\s*{YEAR}(?:\s*\d{{1,2}}\s*{MONTH})?|\d{{1,3}}\s*{MONTH})\b", source, re.I)
        total = duration_months(summary[1]) if summary else None
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
            if result["status"] != "unknown":
                result.update(status="met" if actual >= required else "partial" if actual > 0 else "not_met",
                              credit=min(actual / required, 1))
            result["experience_months"] = actual
        elif required and result["status"] != "unknown":
            result.update(status="unknown", credit=0)
        if required:
            result["required_months"] = required
        if total is not None:
            result["total_experience_months"] = total
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
    return result


def _content_tokens(text):
    ignored = {"нет", "без", "не", "по", "на", "из", "от", "до", "за", "со", "во", "при", "опыт", "опыта", "наличие", "отсутствие", "кандидат", "кандидатов", "рассматриваем", "только", "работы", "лет", "года", "год"}
    return {token[:6] for token in re.findall(r"[\w+#]+", normalized(text)) if len(token) >= 2 and token not in ignored}


def _stop_supported(requirement, evidence):
    text = " ".join(e["quote"] for e in evidence)
    threshold = minimum_months(requirement)
    durations = [duration_months(e["quote"]) for e in evidence]
    durations = [value for value in durations if value is not None]
    if threshold and durations and re.search(r"менее|недостат", requirement, re.I):
        return max(durations) < threshold
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
    for status, label in (("met", "Подтверждено"), ("partial", "Частичное соответствие"), ("not_met", "Подтверждённое несоответствие"), ("unknown", "Требует уточнения")):
        if not groups[status]:
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
    lines.append(f"Диапазон соответствия по доступным сведениям: {score_range['min']:g}–{score_range['max']:g}/100; охват проверенными критериями — {coverage:g}%. Неизвестные сведения не означают отсутствие компетенции.")
    if truncated:
        lines.append("Оценён только фрагмент резюме из-за ограничения контекста; оставшиеся сведения требуют проверки.")
    return "\n".join(lines)


def verify_and_score(parsed: dict, source: str, profile: ProfileRequest, cluster_requirements="", *, model="", context_truncated=False) -> dict:
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
    checked = [_assess_criterion(c, by_id.get(c["id"]), source) for c in criteria]
    stops = []
    by_stop = {s["id"]: s for s in parsed["stop_factors"]}
    penalized = set()
    for index, requirement in enumerate(profile.stop_factors):
        identifier = f"stop:{index}"
        assessment = by_stop.get(identifier)
        status = assessment["status"] if assessment else "unknown"
        evidence = _verified_quotes(source, assessment["evidence"]) if assessment else []
        if status != "unknown" and not evidence or status == "triggered" and not _stop_supported(requirement, evidence):
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
                      "penalty": penalty, "duplicates": duplicates})
    penalty = min(MAX_STOP_PENALTY, sum(s["penalty"] for s in stops))
    points = sum(c["weight"] * c["credit"] for c in checked) / 100
    unknown = sum(c["weight"] * c["possible_credit"] for c in checked if c["status"] == "unknown") / 100
    coverage = round_score(sum(c["weight"] for c in checked if c["status"] != "unknown") / 100)
    score_range = {"min": round_score(points - penalty), "max": round_score(points + unknown - penalty)}
    if not any(c["weight"] for c in checked):
        score_range = {"min": 0, "max": 100}
    details = {"method": "evidence-v1", "policy_version": POLICY_VERSION, "policy_status": "provisional",
               "model": model, "source_text_sha256": hashlib.sha256(source.encode()).hexdigest(),
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
