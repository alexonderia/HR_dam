"""Use PDF typography to validate name headings outside the name dictionary."""

from statistics import median

from app.candidate_extractor import FIRST_NAMES, PHONE_LABEL, _parse_name
from app.resume_sections import has_resume_sections


class AmbiguousNameHeader(ValueError):
    pass


def pdf_name_header(page, text: str) -> str | None:
    try:
        layout = page.get_text("dict")
    except TypeError:
        # Text-only document adapters have no evidence of typography.
        return None
    lines = [line for block in layout["blocks"] for line in block.get("lines", [])]
    sizes = [span["size"] for line in lines for span in line["spans"] if span["text"].strip()]
    if not sizes:
        return None
    minimum = max(14, median(sizes) * 1.25)
    beginning = " ".join(text.splitlines()[:6]).split()
    candidates = {}
    for line in lines:
        spans = [s for s in line["spans"] if s["text"].strip()]
        if not spans or min(s["size"] for s in spans) < minimum:
            continue
        label = " ".join(s["text"] for s in spans).strip()
        parsed = _parse_name(label.split(), False, header=True)
        if parsed:
            words = label.split()
            at_beginning = line["bbox"][1] <= page.rect.height * .25 and any(
                beginning[i:i + len(words)] == words for i in range(len(beginning) - len(words) + 1))
            unfamiliar_pair = len(words) == 2 and not any(
                word.casefold().replace("ё", "е") in FIRST_NAMES for word in words)
            if unfamiliar_pair and not at_beginning:
                # A large section title ending in a surname-like plural is
                # insufficient evidence for a second two-part candidate name.
                offset = text.find(label)
                tail = text[offset + len(label):] if offset >= 0 else ""
                if not (has_resume_sections(tail) and PHONE_LABEL.search(tail)):
                    continue
            person, _ = parsed
            candidates.setdefault(tuple(person.values()), []).append((label, line["bbox"][1]))
    if len(candidates) > 1:
        raise AmbiguousNameHeader()
    for occurrences in candidates.values():
        for label, y in occurrences:
            words = label.split()
            if y <= page.rect.height * .25 and any(beginning[i:i + len(words)] == words
                    for i in range(len(beginning) - len(words) + 1)):
                return label
    return None
