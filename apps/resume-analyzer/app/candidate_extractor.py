"""Conservative contact extraction. Every accepted value has a text source."""

import re


FIELDS = ("last_name", "first_name", "middle_name", "phone")
NAME_PATTERN = re.compile(r"^[А-ЯЁа-яё]+(?:-[А-ЯЁа-яё]+)*$")
FIRST_NAMES = set("""
Александр Александра Алексей Алёна Алена Алина Алиса Алла Анастасия Анатолий
Андрей Анна Антон Антонина Аркадий Артем Артём Артур Богдан Борис Вадим Валентин
Валентина Валерий Валерия Варвара Василий Василиса Вера Вероника Виктор Виктория
Виталий Владимир Владислав Владислава Вячеслав Галина Геннадий Георгий Глеб Григорий
Даниил Данил Дарья Денис Диана Дмитрий Евгений Евгения Евдокия Егор Екатерина
Елена Елизавета Жанна Захар Зинаида Злата Иван Игорь Илья Инна Ирина Кирилл
Клавдия Константин Кристина Ксения Лариса Лев Леонид Лидия Лилия Любовь Людмила
Максим Маргарита Марина Мария Марк Матвей Михаил Надежда Наталья Наталия Нелли
Никита Николай Нина Оксана Олег Олеся Ольга Павел Петр Пётр Полина Раиса Регина
Роман Ростислав Руслан Светлана Семен Семён Сергей Снежана София Софья Станислав
Степан Таисия Тамара Татьяна Тимофей Тимур Ульяна Федор Фёдор Филипп Эдуард
Эльвира Эмиль Юлия Юрий Яна Ярослав Ярослава
""".lower().replace("ё", "е").split())
HEADINGS = set("""
резюме кандидат соискатель опыт работы образование высшее среднее профессиональное
личные данные контактная контактные информация контакты телефон мобильный
дополнительная дополнительное навыки ключевые обо мне должность желаемая
дата рождения гражданство семейное положение русский язык английский
мужчина женщина достижения обязанности сертификаты курсы водительские права
настоящее время место город портфолио аналитик инженер разработчик менеджер
специалист руководитель директор ведущий старший младший проектная деятельность
""".split())
NAME_LABEL = re.compile(r"^\s*(?:фио|ф[.\s]*и[.\s]*о[.]?|имя|кандидат)\s*[:：]\s*", re.I)
PATRONYMIC = re.compile(r"(?:ович|евич|ич|овна|евна|ична)$", re.I)
PHONE_PATTERN = re.compile(r"(?<![\w+])\+?\d(?:[ \t\u00a0\u202f()\-‐‑‒–—]*\d){2,15}(?!\d)")
PHONE_LABEL = re.compile(
    r"(?<!\w)(?:тел(?:ефон)?\.?|моб(?:ильный)?\.?|phone|контакты|контактный\s+номер)"
    r"(?!\w)(?=\s*(?:[:：+(\d]|$))", re.I)


def _key(word: str) -> str:
    return word.lower().replace("ё", "е")


def _source(lines: list[str], start: int, end: int, confidence: str) -> dict:
    return {"source": "resume_text", "confidence": confidence,
            "quote": "\n".join(lines[start:end + 1]).strip(),
            "line_start": start + 1, "line_end": end + 1}


def _parse_name(words: list[str], labelled: bool) -> tuple[dict, str] | None:
    if len(words) not in (2, 3) or any(len(w) > 100 or not NAME_PATTERN.fullmatch(w) for w in words):
        return None
    if any(_key(w) in HEADINGS for w in words):
        return None
    if len(words) == 3 and not PATRONYMIC.search(words[2]):
        if PATRONYMIC.search(words[1]) and _key(words[0]) in FIRST_NAMES:
            words = [words[2], words[0], words[1]]
        else:
            return None
    first_known, second_known = (_key(w) in FIRST_NAMES for w in words[:2])
    if first_known == second_known and not labelled:
        return None
    # Both name orders occur in resumes; never manufacture the patronymic.
    first, last = (words[0], words[1]) if first_known and not second_known else (words[1], words[0])
    if PATRONYMIC.search(last):
        return None
    return ({"last_name": last.title(), "first_name": first.title(),
             "middle_name": words[2].title() if len(words) == 3 else None},
            "high" if first_known != second_known else "medium")


def _name(text: str) -> tuple[dict, dict, str]:
    lines = text.splitlines()
    nonempty = [i for i, line in enumerate(lines[:40]) if line.strip()][:20]
    options = []
    for offset, start in enumerate(nonempty):
        raw = lines[start].strip()
        labelled = bool(NAME_LABEL.match(raw))
        words = NAME_LABEL.sub("", raw).split()
        for following in range(4 if labelled and not words else 3):
            end_offset = offset + following
            if end_offset >= len(nonempty):
                break
            end = nonempty[end_offset]
            if following:
                if end - nonempty[end_offset - 1] > 2:
                    break
                words += lines[end].strip().split()
            if len(words) > 3:
                break
            parsed = _parse_name(words, labelled)
            if parsed:
                person, confidence = parsed
                options.append((person, _source(lines, start, end, confidence), labelled))
    # A complete three-part name supersedes its own two-part prefix.
    options = [o for o in options if o[0]["middle_name"] or not any(
        x[0]["middle_name"] and all(x[0][f] == o[0][f] for f in ("last_name", "first_name")) for x in options)]
    if any(o[2] for o in options):
        options = [o for o in options if o[2]]
    identities = {tuple(o[0].values()) for o in options}
    empty = {field: None for field in FIELDS[:3]}
    if len(identities) != 1:
        return empty, dict.fromkeys(FIELDS[:3]), "ambiguous" if identities else "not_found"
    person, source, _ = options[0]
    return person, {field: source if person[field] else None for field in FIELDS[:3]}, "extracted"


def normalize_phone(phone: str) -> str | None:
    digits = re.sub(r"\D", "", phone)
    if len(digits) == 11 and digits[0] in "78" and not (phone.startswith("+") and digits[0] != "7"):
        return "+7" + digits[1:]
    return None


def _phone(text: str) -> tuple[str | None, dict | None, str]:
    supported: dict[str, dict] = {}
    unsupported = False
    lines = text.splitlines()
    pending_label = False
    for i, line in enumerate(lines):
        if not line.strip():
            continue
        label = PHONE_LABEL.search(line)
        labelled = bool(label) or pending_label
        # A standalone label applies to the next nonempty line as well.
        pending_label = bool(label and not line[label.end():].strip(" :：\t") and not re.search(r"\d", line))
        found = False
        for match in PHONE_PATTERN.finditer(line):
            raw = match.group()
            digits = re.sub(r"\D", "", raw)
            # An unlabelled numeric identifier/date is not a phone number.
            if not labelled and not raw.startswith("+") and len(digits) != 11:
                continue
            found = True
            normalized = normalize_phone(raw)
            if normalized:
                supported[normalized] = {**_source(lines, i, i, "high"), "quote": raw}
            else:
                unsupported = True
        if labelled and not found and re.search(r"\d", line):
            unsupported = True
    if len(supported) > 1 or (supported and unsupported):
        return None, None, "ambiguous"
    if supported:
        phone, source = next(iter(supported.items()))
        return phone, source, "extracted"
    return None, None, "unsupported" if unsupported else "not_found"


def extract_contacts(text: str) -> dict:
    """Return values and provenance separately; empty/unsupported data stays null."""
    candidate, sources, name_status = _name(text)
    phone, source, phone_status = _phone(text)
    candidate["phone"] = phone
    sources["phone"] = source
    warnings = []
    if not text.strip():
        warnings.append("В документе нет текста. Для скана потребуется OCR.")
    if phone_status == "unsupported":
        warnings.append("Формат телефона не поддерживается. Поддерживаются номера +7, 7 или 8 с десятью цифрами после префикса.")
    if phone_status == "ambiguous":
        warnings.append("Найдено несколько вариантов телефона. Требуется ручная проверка.")
    if name_status == "ambiguous":
        warnings.append("Не удалось однозначно определить ФИО. Требуется ручная проверка.")
    if any(source and source["confidence"] == "medium" for source in sources.values()):
        warnings.append("ФИО определено предположительно. Требуется ручная проверка.")
    return {"candidate": candidate, "contact_details": {
        "version": 1, "method": "rules-ru-v1", "text_status": "present" if text.strip() else "no_text",
        "name_status": name_status, "phone_status": phone_status, "fields": sources, "warnings": warnings}}


def extract_name(text: str) -> dict:
    return _name(text)[0]


def extract_phone(text: str) -> str | None:
    return _phone(text)[0]


def extract_candidate(text: str) -> dict:
    return extract_contacts(text)["candidate"]
