"""Verified calendar-month union; date arithmetic is never delegated to a model."""

import calendar
from datetime import date
import re

MONTHS = {"январ": 1, "феврал": 2, "март": 3, "апрел": 4, "ма": 5, "июн": 6,
          "июл": 7, "август": 8, "сентябр": 9, "октябр": 10, "ноябр": 11, "декабр": 12,
          "jan": 1, "feb": 2, "mar": 3, "apr": 4, "may": 5, "jun": 6,
          "jul": 7, "aug": 8, "sep": 9, "oct": 10, "nov": 11, "dec": 12}
DATE = r"(?:\d{1,2}\.\d{1,2}\.(?:19|20)\d{2}|\d{1,2}[./](?:19|20)\d{2}|[а-яА-ЯёЁa-zA-Z]+\s+(?:19|20)\d{2})"
RANGE = re.compile(rf"(?P<first>{DATE})\s*[-–—]\s*(?P<last>{DATE}|настоящее\s+время|по\s+настоящее\s+время|н\.?\s*в\.?|present|current)", re.I)
SECTION = re.compile(r"^\s*(?:образование|навыки|ключевые навыки|обо мне|контакты|история|комментарии)\b", re.I)
WORK_SECTION = re.compile(r"^\s*(?:опыт работы|трудовая деятельность|work experience|employment)\b", re.I)


def month_index(value: date) -> int:
    return value.year * 12 + value.month - 1


def endpoint(text: str, *, last: bool, as_of: date) -> int | None:
    if re.fullmatch(r"настоящее\s+время|по\s+настоящее\s+время|н\.?\s*в\.?|present|current", text, re.I):
        return month_index(as_of) if last else None
    try:
        if re.fullmatch(r"\d{1,2}\.\d{1,2}\.\d{4}", text):
            day, month, year = map(int, text.split("."))
            value = date(year, month, day)
            index = month_index(value)
            # Count full calendar months only; incomplete boundary months do not
            # inflate experience. Full month/year end dates include that month.
            return index + (day == calendar.monthrange(year, month)[1] if last else day > 1)
        if re.fullmatch(r"\d{1,2}[./]\d{4}", text):
            month, year = map(int, re.split(r"[./]", text))
        else:
            name, year_text = text.casefold().split()
            year = int(year_text)
            month = next((number for prefix, number in MONTHS.items() if name.startswith(prefix)), 0)
        value = date(year, month, 1)
        return month_index(value) + int(last)
    except (ValueError, StopIteration):
        return None


def union_months(periods: list[dict]) -> int:
    total, end = 0, -1
    for period in sorted(periods, key=lambda p: (p["start_month"], p["end_month"])):
        first, last = period["start_month"], period["end_month"]
        total += max(0, last - max(first, end))
        end = max(end, last)
    return total


def verified_periods(source, evidence, requirement, as_of, relevant, forbidden, explicit_duration):
    """Date header and job belong to one source block touched by evidence."""
    as_of = date.fromisoformat(as_of)
    matches = list(RANGE.finditer(source))
    periods, citations = [], []
    for index, match in enumerate(matches):
        line_start = source.rfind("\n", 0, match.start()) + 1
        first, last = endpoint(match["first"], last=False, as_of=as_of), endpoint(match["last"], last=True, as_of=as_of)
        if first is None or last is None:
            continue
        # Future work is not experience; do not count a future end date.
        last = min(last, month_index(as_of) + int(as_of.day == calendar.monthrange(as_of.year, as_of.month)[1]))
        if not first < last:
            continue
        end = matches[index + 1].start() if index + 1 < len(matches) else len(source)
        for heading in re.finditer(r"[^\n]+", source[line_start:end]):
            if heading.start() > 0 and SECTION.search(heading[0]):
                end = line_start + heading.start()
                break
        in_work = True
        for previous in reversed(source[:line_start].splitlines()):
            if WORK_SECTION.search(previous):
                break
            if SECTION.search(previous):
                in_work = False
                break
        block = source[line_start:end]
        if (not in_work or forbidden(block) or not relevant(requirement, block)
                or not any(e["start"] < end and e["end"] > line_start for e in evidence)):
            continue
        stated = explicit_duration(block)
        if stated is not None:
            last = min(last, first + stated)
        if last <= first:
            continue
        quote = {"quote": source[match.start():match.end()], "start": match.start(), "end": match.end()}
        periods.append({"start_month": first, "end_month": last, "start": match.start(), "end": match.end()})
        citations.append(quote)
    return periods, citations
