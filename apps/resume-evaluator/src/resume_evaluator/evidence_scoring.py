"""Проверка цитат и расчёт оценки по явной, версионированной формуле."""

from resume_evaluator.proof_policy import education_met_supported, EDUCATION, valid_semantic_review,request_participation

import hashlib
import math
import re
from fractions import Fraction

from resume_evaluator.rank_models import ProfileRequest
from resume_evaluator.criteria_v5 import OPTIONAL_V5 as OPTIONAL, clauses_v5 as requirement_clauses, condition_v5 as condition_structure,requirement_list_v5 as requirement_list
from resume_evaluator.policy_v5 import duration_scope,scope_matches,ambiguous_role_period,assertion_proof,education_proof,professional_basis,professional_context
from resume_evaluator.proof_policy import proof_verdict, statements, experience_constraint, terms as proof_terms, matching as proof_matching
from resume_evaluator.employment import verified_periods, union_months
from datetime import datetime
from zoneinfo import ZoneInfo

POLICY_VERSION = "evidence-v5"
CATEGORY_WEIGHTS = {"keyword": 40, "experience": 30, "education": 15, "additional": 15}
STOP_PENALTY = 10
MAX_STOP_PENALTY = 30
NEGATIVE = re.compile(r"\b(?:нет|без|отсутств\w*|отказ\w*|не\s+(?:готов\w*|име\w*|владе\w*|зна\w*|работа\w*|использ\w*|уме\w*))\b", re.I)
LEARNING = re.compile(r"\b(?:изучаю|изучает|учусь|прохожу\s+курс|прош[её]л\s+курс|курс\w*\s+по|начальн\w*\s+уров\w*|начинающ\w*|базов\w*\s+уров\w*)\b", re.I)
INTENTION = re.compile(r"\b(?:хотел\w*\s+бы|хочу|планирую|планирует|намерен\w*|желаю|мечтаю|интересует|ваканси\w*|требования\s+работодателя)\b", re.I)
YEAR = r"(?:лет|года?|years?)"
MONTH = r"(?:месяц\w*|months?)"
ALIASES = {"sql": ["SQL", "MS SQL", "T-SQL", "MSSQL"], "rest api": ["REST API", "RESTful API"]}


def normalized(text: str) -> str:
    return re.sub(r"\s+", " ", text).strip().casefold().replace("ё", "е")


def minimum_months(requirement: str) -> int | None:
    bounds=experience_constraint(requirement)
    return bounds.get("minimum") if bounds and not bounds.get("ambiguous") else None


def duration_months(text: str) -> int | None:
    """Принимает только явную длительность; календарный год не является стажем."""
    bounds=experience_constraint(text)
    return bounds.get("minimum") if bounds and not bounds.get("ambiguous") and "maximum" not in bounds else None


DURATION = re.compile(rf"(?<![\w.,])(\d{{1,3}}(?:[.,]\d+)?)\s*{YEAR}(?:\s*[,и]?\s*(\d{{1,2}})\s*{MONTH})?\b|(?<![\w.,])(\d{{1,3}}(?:[.,]\d+)?)\s*{MONTH}\b", re.I)
WORK = re.compile(r"работ(?:а|ы|ал|ала|аю|ает|ать)|стаж|должност|разработ|программист|developer|engineer|менеджер|специалист|инженер|преподавател|репетитор|электромонтаж|бухгалтер|руководител|дизайнер|аналитик|продаж|тестиров|администратор|назнач|карьер|водител|бригад|начальник", re.I)
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
    # For other specialities require a concrete shared term; a generic number
    # of years alone is acceptable only when no speciality was requested.
    meaningful=[t for t in proof_terms(requirement) if t not in {"стаж","коммерческ","коммерческй","сфер"}]
    return not meaningful or proof_matching(meaningful[-1],context)


def relevant_durations(source, evidence, requirement, status="met", scope=None):
    values = []
    for match in DURATION.finditer(source):
        if not any(item["start"] <= match.start() and match.end() <= item["end"] for item in evidence):
            continue
        context = _employment_context(source, match.start(), match.end())
        if context and scope_matches(requirement,scope,context) and not ambiguous_role_period(requirement,scope,context):
            value=duration_months(match[0])
            if value is not None:values.append(value)
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
        if experience_constraint(requirement) and re.search(r"опыт|стаж|работ|разработ",requirement,re.I) and not EDUCATION.search(requirement):category="experience"
        if category=="education" and not EDUCATION.search(requirement) and re.search(r"опыт|стаж|работ|руковод|организац",requirement,re.I):category="experience"
        origin={"source":source,"input_id":identifier,"text":requirement}
        duplicate=next((c for c in criteria if normalized(c["requirement"]).rstrip(".!") == normalized(requirement).rstrip(".!") and c["optional"] == bool(OPTIONAL.search(requirement))),None)
        if duplicate:
            duplicate["origins"].append(origin)
        elif requirement:
            criteria.append({"id": identifier, "category": category, "requirement": requirement,
                             "source": source, "optional": bool(OPTIONAL.search(requirement)), "weight": 0,"origins":[origin],"condition":condition_structure(requirement),**({"experience_scope":duration_scope(requirement,profile) or {"role":profile.position_name,"anchors":list(dict.fromkeys(profile.keywords))}} if category=="experience" and (not experience_constraint(requirement) or duration_scope(requirement,profile) is not None) else {})})

    for index, item in enumerate(profile.keywords):
        for part, keyword in enumerate(requirement_list(item)):
            add(f"keyword:{index}:{part}", "keyword", keyword, "keywords")
    for category in ("experience", "education"):
        text = getattr(profile, category) or ""
        # Optional qualifications must not turn the required degree into an optional criterion.
        clauses = requirement_clauses(text)
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


def _skill_evidence(source: str, keyword: str, regions=None) -> tuple[str, list[dict]]:
    for conjunction, mode in ((r"\s+или\s+", "any"), (r"\s+и\s+", "all")):
        parts = re.split(conjunction, keyword, flags=re.I)
        if len(parts) <= 1:
            continue
        values = [_skill_evidence(source, part.strip(), regions) for part in parts]
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
            if regions is not None and not any(e["start"]<=match.start() and e["end"]>=match.end() for e in regions):
                continue
            # Keep the surrounding statement so a quoted skill cannot hide its negation.
            start,end,_=next(((a,b,t) for a,b,t in statements(source) if a<=match.start() and b>=match.end()),(match.start(),match.end(),match[0]))
            start, end = max(start, match.start() - 160), min(end, match.end() + 160)
            context = source[start:end].strip()
            left=start+len(source[start:end])-len(source[start:end].lstrip())
            evidence = {"quote":context,"start":left,"end":left+len(context)}
            parent=next((e for e in regions or [] if e["start"]<=evidence["start"] and e["end"]>=evidence["end"]),None)
            if parent:
                evidence.update({k:parent[k] for k in ("block_id","section","page") if k in parent})
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


def _assess_criterion(criterion, assessment, source, assessment_date,source_offset=0):
    status = assessment["status"] if assessment else "unknown"
    evidence = verified_assessment_evidence(source, assessment)
    reason = assessment.get("unknown_reason") if assessment else None
    from resume_evaluator.repair_v5 import repair_assertion
    if not (assessment or {}).get("semantic_review"):
        status,evidence,repaired_reason=repair_assertion(criterion,assessment,source,evidence,source_offset)
        reason=repaired_reason or reason
    participation=request_participation(criterion["requirement"],[e["quote"] for e in evidence]) if criterion["category"] in {"keyword","additional","experience"} and not experience_constraint(criterion["requirement"]) and status in {"met","partial"} else None
    if participation:status="partial"
    review=None if participation else (assessment or {}).get("semantic_review")
    semantic=valid_semantic_review(review,status,evidence)
    if semantic and review.get("supported_text") and not assertion_proof(criterion["requirement"],review["status"],[review["supported_text"]],criterion["condition"],True):semantic=False
    if review is not None and not semantic:
        status="unknown"
        reason="unverified_evidence"
    if status != "unknown" and not evidence:
        status = "unknown"
        reason = "unverified_evidence"
    if criterion["category"] == "keyword":
        checked_status, checked_evidence = _skill_evidence(source, criterion["requirement"], evidence if assessment is not None else None)
        # Literal entity lookup is only for names/tools. Duties are supported by
        # the cited assertion, not a second global search for identical wording.
        if proof_terms(criterion["requirement"]) and normalized(criterion["requirement"]) not in ALIASES and not re.fullmatch(r"[a-z0-9+# .:/-]+",criterion["requirement"],re.I) and re.search(r"[а-я]"," ".join(proof_terms(criterion["requirement"]))):
            supported,why=(assertion_proof(criterion["requirement"],status,[e["quote"] for e in evidence],criterion["condition"],semantic),"unverified_evidence")
            if assessment is not None and status!="unknown":
                checked_status=status if supported else "unknown"
                checked_evidence=evidence
                if not supported:reason=why
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
        supported, why = (assertion_proof(criterion["requirement"],status,[e["quote"] for e in evidence],criterion["condition"],semantic),"unverified_evidence")
        if not supported:
            result.update(status="unknown", credit=0)
            reason = why
    partial_reason = (assessment or {}).get("partial_reason") or "missing_parts"
    if criterion["category"] == "keyword" and status == "partial" and LEARNING.search(" ".join(e["quote"] for e in evidence)):
        partial_reason = "learning"
    if criterion["category"] == "experience" and not experience_constraint(criterion["requirement"]):
        if result["status"]!="unknown" and not assertion_proof(criterion["requirement"],result["status"],[e["quote"] for e in evidence],criterion["condition"],semantic):
            result.update(status="unknown",credit=0);reason="unverified_evidence"
    if criterion["category"] == "experience" and experience_constraint(criterion["requirement"]):
        technologies = [t.rstrip(".-") for t in re.findall(r"(?<!\w)[a-z][a-z0-9+#.-]*(?!\w)", normalized(criterion["requirement"]))]
        denied = [_skill_evidence(source, technology, evidence) for technology in technologies]
        hard_noncompliance = bool(denied) and (all(s == "not_met" for s, _ in denied) if re.search(r"\bили\b", criterion["requirement"], re.I) else any(s == "not_met" for s, _ in denied))
        hard_noncompliance = hard_noncompliance or bool(evidence) and proof_verdict(criterion["requirement"],"not_met",[e["quote"] for e in evidence])[0]
        if hard_noncompliance and status != "unknown":
            result.update(status="not_met", credit=0)
            for rejected, quotes in denied:
                if rejected == "not_met":
                    evidence.extend(e for e in quotes if e not in evidence)
        required = minimum_months(criterion["requirement"])
        scope=criterion.get("experience_scope")
        observed = relevant_durations(source, evidence, criterion["requirement"], status,scope)
        periods, date_quotes = verified_periods(source, evidence, criterion["requirement"], assessment_date,
            lambda requirement, block: bool(WORK.search(block)) and scope_matches(requirement,scope,block) and not ambiguous_role_period(requirement,scope,block),
            lambda block: bool(NON_WORK.search(block) or PERSONAL_AGE.search(block) or COMPANY_AGE.search(block) or INTENTION.search(block)), duration_months)
        dated_months = union_months(periods)
        if (observed or periods) and not hard_noncompliance and result["status"] in {"unknown","not_met"}:
            result.update(status="met",credit=1)
            status="met"
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
        bounds=experience_constraint(criterion["requirement"])
        if bounds:
            result["experience_constraint"]=bounds
            if bounds.get("ambiguous"):
                result.update(status="unknown",credit=0);reason="ambiguous_requirement"
            elif "maximum" in bounds and not hard_noncompliance:
                if observed and result["status"]!="unknown":
                    actual=max(observed)
                    result["experience_months"]=actual
                    if periods and dated_months>=actual:result["work_periods"]=periods
                    excessive=actual>bounds["maximum"] or actual==bounds["maximum"] and not bounds.get("max_inclusive",True)
                    if excessive:result.update(status="not_met",credit=0)
                elif result["status"]!="unknown":
                    result.update(status="unknown",credit=0);reason="not_relevant"
            if bounds.get("minimum") is not None and not bounds.get("min_inclusive",True) and result.get("experience_months")==bounds["minimum"]:
                result.update(status="not_met",credit=0)
        result["evidence"] = evidence
    if criterion["category"] == "education" and evidence:
        if result["status"]!="unknown" and not education_proof(criterion["requirement"],result["status"],[e["quote"] for e in evidence],criterion["condition"]):
            result.update(status="unknown",credit=0);reason="unverified_evidence"
    if criterion["category"]=="experience" and not experience_constraint(criterion["requirement"]) and result["status"] in {"met","partial"}:
        if not professional_context(criterion["requirement"],criterion.get("experience_scope"),[e["quote"] for e in evidence],criterion["condition"]):
            result.update(status="unknown",credit=0);reason="not_relevant"
    if criterion["condition"]["operator"]=="ambiguous":
        result.update(status="unknown",credit=0);reason="ambiguous_requirement"
    result["possible_credit"] = result["credit"] if result["status"] != "unknown" else min(
        result["total_experience_months"] / result["required_months"], 1
    ) if result.get("required_months") and result.get("total_experience_months") is not None else 1
    if result["status"] == "unknown":
        if criterion["category"] == "keyword":
            checked, quotes = _skill_evidence(source, criterion["requirement"])
            if checked == "unknown" and quotes:
                reason = "future_intent" if INTENTION.search(" ".join(e["quote"] for e in quotes)) else "not_stated" if re.search(r"\s(?:и|или)\s", criterion["requirement"], re.I) else "contradictory"
        result["unknown_reason"] = reason or "not_stated"
    if participation and result["status"]=="partial":result.update(participation_only=True,confirmed_part=participation)
    if semantic and result["status"] in {"met","partial"}:result["semantic_review"]=review
    if result["status"] == "partial":
        result["partial_reason"] = partial_reason
    return result


def same_condition(a,b):
    a_bounds,b_bounds=experience_constraint(a),experience_constraint(b)
    if set(proof_terms(a))!=set(proof_terms(b)):return False
    if a_bounds==b_bounds:return True
    if not a_bounds or not b_bounds:return False
    for lower,upper in ((a_bounds,b_bounds),(b_bounds,a_bounds)):
        if set(lower)=={"minimum","min_inclusive"} and set(upper)=={"maximum","max_inclusive"}:
            if lower["minimum"]==upper["maximum"] and lower["min_inclusive"]!=upper["max_inclusive"]:return True
    return False



def stop_supported(requirement, status, evidence, source,scope=None):
    bounds=experience_constraint(requirement)
    if bounds and not bounds.get("ambiguous"):
        values=relevant_durations(source,evidence,requirement,scope=scope)
        if not values:return False
        def adverse(value):
            lower="minimum" not in bounds or (value>=bounds["minimum"] if bounds.get("min_inclusive",True) else value>bounds["minimum"])
            upper="maximum" not in bounds or (value<=bounds["maximum"] if bounds.get("max_inclusive",True) else value<bounds["maximum"])
            return lower and upper
        return all(adverse(v)==(status=="triggered") for v in values)
    core=re.sub(r"^(?:нет|отсутствие|отсутствует|отказ\s+от|не\s+готов\w*\s+к)\s*", "",requirement,flags=re.I)
    adverse=bool(NEGATIVE.search(requirement))
    wanted_negative=(status=="triggered") == adverse
    return proof_verdict(core,"not_met" if wanted_negative else "met",[e["quote"] for e in evidence])[0]


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
        if status != "unknown" and (not evidence or not stop_supported(requirement, status, evidence, source,duration_scope(requirement,profile))):
            status = "unknown"
        duplicates = [c["id"] for c in checked if c["status"] in {"partial", "not_met"} and same_condition(c["requirement"],requirement)]
        key = normalized(requirement)
        penalty = STOP_PENALTY if status == "triggered" and not duplicates and key not in penalized else 0
        if penalty:
            penalized.add(key)
        stops.append({"id": identifier, "requirement": requirement, "status": status, "evidence": evidence,
                      "penalty": penalty, "duplicates": duplicates,
                      **({"unknown_reason": (assessment or {}).get("unknown_reason") or "not_stated"} if status == "unknown" else {})})
    penalty = min(MAX_STOP_PENALTY, sum(s["penalty"] for s in stops))
    basis=professional_basis(checked)
    points = sum(c["weight"] * c["credit"] for c in checked) / 100
    unknown = sum(c["weight"] * c["possible_credit"] for c in checked if c["status"] == "unknown") / 100
    coverage = round_score(sum(c["weight"] for c in checked if c["status"] != "unknown") / 100)
    score_range = {"min": round_score(points - penalty), "max": round_score(points + unknown - penalty)}
    if basis["status"]=="unconfirmed":
        score_range["min"]=0
        if not any(not c["optional"] and c["category"]!="education" and c["status"]=="unknown" for c in checked):score_range["max"]=0
    if not any(c["weight"] for c in checked):
        score_range = {"min": 0, "max": 100}
    details = {"method": "evidence-v1", "policy_version": POLICY_VERSION, "policy_status": "provisional",
               "model": model, "assessment_date": assessment_date, "context_chunks": context_chunks,
               "source_text_sha256": hashlib.sha256(source.encode()).hexdigest(),
               "source_text_length": len(source), "context_truncated": context_truncated,
               "criteria": checked, "stop_factors": stops,"professional_basis":basis, "coverage": coverage, "score_range": score_range,
               "stop_penalty": penalty, "score_status": "not_defined" if not any(c["weight"] for c in checked) else "insufficient_evidence" if not coverage else "evaluated"}
    general_periods,general_quotes=verified_periods(source,[{"start":0,"end":len(source)}],"",assessment_date,
        lambda requirement,block:bool(WORK.search(block)),
        lambda block:bool(NON_WORK.search(block) or PERSONAL_AGE.search(block) or COMPANY_AGE.search(block) or INTENTION.search(block)),duration_months)
    if general_periods:
        details.update(general_experience_months=union_months(general_periods),general_work_periods=general_periods,general_work_evidence=general_quotes)
    return {"score": score_range["min"],
            "matched_keywords": list(dict.fromkeys(c["requirement"] for c in checked if c["category"] == "keyword" and c["status"] in {"met", "partial"})),
            "triggered_stop_factors": list(dict.fromkeys(s["requirement"] for s in stops if s["status"] == "triggered")),
            "explanation": ("Профессиональное соответствие не подтверждено. Общие сведения об образовании и стаже не повышают оценку.\n" if basis["status"]=="unconfirmed" else "") + ("Оценка не определена: нет обязательных условий.\n" if not any(c["weight"] for c in checked) else "") + _explanation(checked, stops, score_range, coverage, context_truncated), "details": details}


def validate_rating_source(rating: dict, resume_text: str) -> None:
    """Повторная проверка границ цитат перед выдачей результата HTTP/AMQP."""
    details = rating.get("details", {})
    if details.get("method") != "evidence-v1":
        return
    size = details["source_text_length"]
    if size > len(resume_text) or details["source_text_sha256"] != hashlib.sha256(resume_text[:size].encode()).hexdigest():
        raise ValueError("Источник подтверждений не совпадает с анализируемым резюме")
    for item in details["criteria"] + details["stop_factors"] + [{"evidence":details.get("general_work_evidence",[])}]:
        for evidence in item["evidence"]:
            if not 0 <= evidence["start"] < evidence["end"] <= size or resume_text[evidence["start"]:evidence["end"]] != evidence["quote"]:
                raise ValueError("Цитата не совпадает с исходным текстом резюме")
