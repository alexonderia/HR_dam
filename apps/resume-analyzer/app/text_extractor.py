"""Извлечение текста из PDF и DOCX с кэшированием."""

import hashlib
import logging
from collections import OrderedDict
from io import BytesIO

import pymupdf as fitz
from docx import Document

from app.config import settings
from app.logging_config import get_logger, log_event

logger = get_logger("app.text_extractor")

# LRU-кэш: {хэш_файла: извлечённый_текст}
_text_cache: "OrderedDict[str, str]" = OrderedDict()
_text_cache_bytes = 0

def get_file_hash(content: bytes) -> str:
    """Возвращает SHA-256 хэш содержимого файла."""
    return hashlib.sha256(content).hexdigest()


def _cache_get(file_hash: str) -> str | None:
    if file_hash in _text_cache:
        _text_cache.move_to_end(file_hash)
        return _text_cache[file_hash]
    return None



def _cache_put(file_hash: str, text: str) -> None:
    global _text_cache_bytes

    max_items = settings.TEXT_CACHE_MAX_ITEMS
    max_bytes = settings.TEXT_CACHE_MAX_BYTES
    text_size = len(text.encode("utf-8"))

    # Не кэшируем один текст, который сам превышает лимит.
    if max_items <= 0 or max_bytes <= 0 or text_size > max_bytes:
        return

    # Если запись уже существует, освобождаем её прежний размер.
    old_text = _text_cache.pop(file_hash, None)
    if old_text is not None:
        _text_cache_bytes -= len(old_text.encode("utf-8"))

    _text_cache[file_hash] = text
    _text_cache_bytes += text_size

    # Удаляем самые старые записи, пока не соблюдены оба ограничения.
    while _text_cache and (
        len(_text_cache) > max_items
        or _text_cache_bytes > max_bytes
    ):
        _, removed_text = _text_cache.popitem(last=False)
        _text_cache_bytes -= len(removed_text.encode("utf-8"))



def extract_text_from_pdf_bytes(pdf_bytes: bytes) -> str:
    """Извлекает текст из PDF."""
    try:
        doc = fitz.open(stream=pdf_bytes, filetype="pdf")
        text = ""
        for page in doc:
            text += page.get_text()
        doc.close()
        return text.strip()
    except Exception as e:
        raise Exception(f"Ошибка при извлечении текста из PDF: {str(e)}")


def extract_text_from_docx_bytes(docx_bytes: bytes) -> str:
    """Извлекает текст из DOCX."""
    try:
        doc = Document(BytesIO(docx_bytes))
        text = ""
        for paragraph in doc.paragraphs:
            if paragraph.text.strip():
                text += paragraph.text + "\n"
        for table in doc.tables:
            for row in table.rows:
                text += " | ".join(cell.text for cell in row.cells) + "\n"
        return text.strip()
    except Exception as e:
        raise Exception(f"Ошибка при извлечении текста из DOCX: {str(e)}")


def extract_text_from_file(file_bytes: bytes, filename: str) -> str:
    """
    Извлекает текст из файла с кэшированием по хэшу содержимого.
    
    Если файл с таким же содержимым уже обрабатывался,
    возвращает текст из кэша без повторного извлечения.
    """
    file_hash = get_file_hash(file_bytes)

    # Проверяем кэш
    cached = _cache_get(file_hash)
    if cached is not None:
        log_event(logger, logging.INFO, "text_cache_hit",
                  file_hash=file_hash[:12],
                  text_length_chars=len(cached))
        return cached

    # Извлекаем текст
    filename_lower = filename.lower()

    if filename_lower.endswith('.pdf'):
        text = extract_text_from_pdf_bytes(file_bytes)
    elif filename_lower.endswith('.docx'):
        text = extract_text_from_docx_bytes(file_bytes)
    else:
        raise Exception("Поддерживаются только файлы PDF и DOCX")

    # Сохраняем в кэш
    _cache_put(file_hash, text)
    log_event(logger, logging.INFO, "text_cache_miss",
              file_hash=file_hash[:12],
              text_length_chars=len(text))

    return text
