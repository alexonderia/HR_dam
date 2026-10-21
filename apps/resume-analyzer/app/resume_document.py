"""The same document/contact preparation for HTTP, AMQP and contact recovery."""

from app.candidate_extractor import extract_contacts
from app.text_extractor import extract_text_from_file
from app.errors import DocumentTextError


def prepare_resume_document(content: bytes, filename: str) -> tuple[str, dict]:
    try:
        text = extract_text_from_file(content, filename)
    except Exception as exc:
        raise DocumentTextError("Не удалось прочитать текст документа.") from exc
    return text, extract_contacts(text)
