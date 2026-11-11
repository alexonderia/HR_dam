"""Bounded ZIP extraction and conservative text-PDF resume separation."""

import hashlib
import re
import stat
import zipfile
import zlib
from pathlib import PurePosixPath

import pymupdf as fitz

from app.candidate_extractor import extract_contacts
from app.pdf_names import AmbiguousNameHeader, pdf_name_header
from app.resume_sections import SERVICE_SECTION, has_owner_footer, has_resume_sections, resume_body

from .protocol import DocumentError, InvalidJob


MIMES = {".pdf": "application/pdf", ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
         ".doc": "application/msword", ".rtf": "application/rtf", ".txt": "text/plain"}


def drop_unused_images(document):
    """Prune shared photo dictionaries without rewriting page drawing commands."""
    used = {image["digest"] for page in document for image in page.get_image_info(hashes=True)}
    digests = {}
    for page in document:
        kind, resource = document.xref_get_key(page.xref, "Resources")
        owner = int(resource.split()[0]) if kind == "xref" else page.xref
        prefix = "XObject/" if kind == "xref" else "Resources/XObject/"
        for image in page.get_images(full=True):
            xref, name, referencer = image[0], image[7], image[9]
            if referencer or not re.fullmatch(r"[A-Za-z0-9_.-]+", name):
                continue
            # Keep unusually large resources rather than expanding them solely
            # for optional pruning. Normal output-size limits still apply.
            if image[2] * image[3] > 20_000_000:
                continue
            if xref not in digests:
                digests[xref] = fitz.Pixmap(document, xref).digest
            if digests[xref] not in used:
                document.xref_set_key(owner, prefix + name, "null")


def pdf_ranges(document):
    """Only split at an unambiguous candidate name at the start of a page.

    Unreadable/scanned or ambiguous multi-resume PDFs fail explicitly rather
    than silently attaching one candidate's pages to another candidate.
    """
    if document.needs_pass or not len(document) or len(document) > 10000:
        raise DocumentError("INVALID_FILE", "PDF защищён или содержит недопустимое число страниц.")
    starts, previous, in_service_section = [], None, False
    for index, page in enumerate(document):
        raw = page.get_text()
        if not raw.strip():
            raise DocumentError("CANNOT_SEPARATE_RESUMES", "В PDF есть страницы без текста; требуется OCR или ручное разделение.")
        heading = SERVICE_SECTION.search(raw)
        text = resume_body(raw)
        if heading and not text.strip():
            if not starts or previous is None:
                raise DocumentError("CANNOT_SEPARATE_RESUMES", "Перед служебным разделом PDF не найдено резюме кандидата.")
            in_service_section = True
            continue
        if in_service_section and previous and has_owner_footer(raw, previous):
            continue
        try:
            name_header = pdf_name_header(page, text)
        except AmbiguousNameHeader:
            raise DocumentError("CANNOT_SEPARATE_RESUMES", "На странице PDF несколько заголовков кандидатов; требуется разделение.") from None
        contacts = extract_contacts(text, name_header=name_header)
        details = contacts["contact_details"]
        if details["name_status"] == "ambiguous":
            raise DocumentError("CANNOT_SEPARATE_RESUMES", "На странице PDF нельзя однозначно определить кандидата.")
        name = tuple(contacts["candidate"][k] for k in ("last_name", "first_name", "middle_name"))
        source = details["fields"]["last_name"]
        header = source and source["confidence"] == "high" and source["line_start"] <= 6
        if in_service_section:
            if not (header and name != previous and has_resume_sections(text)):
                raise DocumentError("CANNOT_SEPARATE_RESUMES", "Не удалось определить границу после служебных разделов PDF.")
            in_service_section = False
        if index == 0:
            if len(document) > 1 and not header:
                raise DocumentError("CANNOT_SEPARATE_RESUMES", "Начало резюме в многостраничном PDF не определено.")
            starts.append(0)
            previous = name if header else None
        elif header and name != previous:
            starts.append(index)
            previous = name
        elif source and name != previous:
            raise DocumentError("CANNOT_SEPARATE_RESUMES", "Граница резюме находится внутри страницы или не определена.")
        if heading:
            in_service_section = True
    return list(zip(starts, starts[1:] + [len(document)]))


def prepare(api, metadata, source, directory):
    limits = metadata.get("limits", {})
    maximum, expanded, count_limit = (limits.get(k) for k in ("max_file_bytes", "max_expanded_bytes", "max_files"))
    if any(type(v) is not int or v <= 0 for v in (maximum, expanded, count_limit)) or maximum > 52428800 or expanded > 262144000 or count_limit > 200:
        raise InvalidJob()
    outputs, errors, output_bytes = [], [], 0
    file_id = api.job.command["file_id"]

    def emit(path, name, archive_path, pages):
        nonlocal output_bytes
        size = path.stat().st_size
        if size > maximum or output_bytes + size > expanded or len(outputs) >= count_limit:
            raise DocumentError("LIMIT_EXCEEDED", "Превышен размер или число выделенных резюме.")
        api.check()
        key = hashlib.sha256((str(archive_path) + ":" + name + ":" + str(pages)).encode()).hexdigest()
        value = {"file_name": name, "mime_type": MIMES[PurePosixPath(name).suffix.lower()],
                 "source_file_id": file_id, "archive_path": archive_path, "pages": pages}
        output_id = api.output(key, path, value)
        outputs.append({"file_id": output_id})
        output_bytes += size

    def pdf(path, name, archive_path):
        api.check()
        try:
            with fitz.open(path, filetype="pdf") as document:
                ranges = pdf_ranges(document)
                if len(ranges) == 1 and archive_path is None:
                    outputs.append({"file_id": file_id})
                    return
                for start, end in ranges:
                    api.check()
                    destination = directory / f"pages-{len(outputs)}.pdf"
                    with fitz.open() as result:
                        result.insert_pdf(document, from_page=start, to_page=end - 1)
                        # Merged PDFs may list every candidate photo on every
                        # page. Preserve only images actually used by this output.
                        drop_unused_images(result)
                        destination.write_bytes(result.tobytes(garbage=4, deflate=True, no_new_id=True))
                    output_name = f"{PurePosixPath(name).stem[:200]}-{start + 1}-{end}.pdf"
                    emit(destination, output_name, archive_path, list(range(start + 1, end + 1)))
                    destination.unlink()
        except (fitz.FileDataError, fitz.EmptyFileError, RuntimeError, ValueError):
            raise DocumentError("INVALID_FILE", "Не удалось прочитать PDF.") from None

    name = metadata["file"]["file_name"]
    extension = PurePosixPath(name).suffix.lower()
    if extension == ".pdf":
        pdf(source, name, None)
    elif extension == ".zip":
        try:
            with zipfile.ZipFile(source) as archive:
                entries = archive.infolist()
                if len(entries) > count_limit * 5:
                    raise DocumentError("LIMIT_EXCEEDED", "В архиве слишком много записей.")
                total, seen = 0, set()
                for index, entry in enumerate(entries):
                    api.check()
                    if entry.is_dir():
                        continue
                    path = entry.filename
                    relative = PurePosixPath(path)
                    try:
                        if not path or len(path) > 1000 or len(relative.name) > 255 or "\\" in path or ":" in path or relative.is_absolute() or ".." in relative.parts or any(ord(c) < 32 for c in path) or stat.S_ISLNK(entry.external_attr >> 16) or path in seen or entry.flag_bits & 1:
                            raise DocumentError("INVALID_FILE", "Небезопасный, повторяющийся или зашифрованный элемент архива.")
                        seen.add(path)
                        suffix = relative.suffix.lower()
                        if suffix not in MIMES:
                            raise DocumentError("UNSUPPORTED_FORMAT", "Формат элемента архива не поддерживается.")
                        total += entry.file_size
                        if entry.file_size > maximum or total > expanded:
                            raise DocumentError("LIMIT_EXCEEDED", "Превышен размер распакованных файлов.")
                        destination = directory / f"entry-{index}{suffix}"
                        with archive.open(entry) as incoming, destination.open("wb") as outgoing:
                            written = 0
                            while chunk := incoming.read(65536):
                                api.check()
                                written += len(chunk)
                                if written > entry.file_size or written > maximum:
                                    raise DocumentError("LIMIT_EXCEEDED", "Превышен размер элемента архива.")
                                outgoing.write(chunk)
                        if written != entry.file_size:
                            raise DocumentError("INVALID_FILE", "Размер элемента архива не совпадает с заявленным.")
                        if suffix == ".pdf":
                            pdf(destination, relative.name, path)
                        else:
                            emit(destination, relative.name, path, [])
                        destination.unlink()
                    except DocumentError as exc:
                        errors.append({"path": path[:1000], "code": exc.code, "message": exc.message})
                        if len(errors) >= 200:
                            break
                    except (zipfile.BadZipFile, RuntimeError, EOFError, NotImplementedError, zlib.error):
                        errors.append({"path": path[:1000], "code": "INVALID_FILE", "message": "Не удалось прочитать элемент архива."})
        except zipfile.BadZipFile:
            raise DocumentError("INVALID_FILE", "ZIP-архив повреждён.") from None
    else:
        raise DocumentError("UNSUPPORTED_FORMAT", "Разборщик принимает ZIP или PDF.")
    if not outputs:
        first = errors[0] if errors else {"code": "INVALID_FILE", "message": "Источник не содержит пригодных резюме."}
        raise DocumentError(first["code"], first["message"])
    return {"status": "completed", "files": outputs, "errors": errors}
