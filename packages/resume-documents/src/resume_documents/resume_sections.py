"""Recognize explicitly labelled recruiting annexes in exported resumes."""

import re


SERVICE_SECTION = re.compile(
    r"^[ \t\f]*(?:Комментарии[ \t]+к[ \t]+резюме|История[ \t]+общения|"
    r"История[ \t]+работы[ \t]+с[ \t]+резюме)[ \t]*\r?$",
    re.IGNORECASE | re.MULTILINE,
)


class ResumeBoundaryError(ValueError):
    """A service annex cannot safely be distinguished from resumed CV text."""


def resume_body(text: str) -> str:
    """One evaluated resume ends before recruiter comments/history, if present."""
    heading = SERVICE_SECTION.search(text)
    if heading and has_resume_sections(text[heading.end():]):
        raise ResumeBoundaryError("После служебного раздела найдены разделы резюме. Проверьте документ и отделите комментарии от резюме.")
    return text[:heading.start()] if heading else text


def has_owner_footer(text: str, name: tuple) -> bool:
    """An export footer associates annex continuation pages with their resume."""
    normalize = lambda value: " ".join(value.casefold().replace("ё", "е").split())
    tail = normalize("\n".join(text.splitlines()[-4:]))
    # Exports commonly omit the patronymic from the footer even when the
    # candidate's header contains it.
    owner = normalize(" ".join(part for part in name[:2] if part))
    return bool(owner) and owner in tail and "резюме обновлено" in tail


def has_resume_sections(text: str) -> bool:
    # A recruiter name alone on an annex continuation is not a new resume.
    return bool(re.search(r"^[ \t\f]*(?:Опыт работы|Образование|Желаемая должность)[^\n]*$",
                          text, re.IGNORECASE | re.MULTILINE))
