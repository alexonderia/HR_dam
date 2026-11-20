"""Document extraction without cross-job caches or model dependencies."""
from io import BytesIO
from pathlib import Path
import subprocess
import tempfile

import pymupdf as fitz
from docx import Document
from docx.oxml.ns import qn
from docx.text.paragraph import Paragraph
from docx.table import Table
from striprtf.striprtf import rtf_to_text


def extract_text_from_pdf_bytes(pdf_bytes: bytes) -> str:
    """Извлекает текст из PDF."""
    try:
        with fitz.open(stream=pdf_bytes, filetype="pdf") as doc:
            pages = []
            unread = []
            for number, page in enumerate(doc, 1):
                # Preserve the native layout order until a labelled column
                # corpus demonstrates a better reading-order algorithm.
                value = page.get_text()
                if not value.strip():unread.append(number)
                pages.append(value)
            if unread:
                raise ValueError("Не прочитаны страницы PDF: " + ", ".join(map(str,unread)) + ". Требуется OCR или ручная проверка.")
            return "\f".join(pages).strip()
    except Exception as e:
        raise Exception(f"Ошибка при извлечении текста из PDF: {str(e)}")


def extract_text_from_docx_bytes(docx_bytes: bytes) -> str:
    """Извлекает текст из DOCX."""
    try:
        doc = Document(BytesIO(docx_bytes))
        text = ""
        for block in doc.element.body.iterchildren():
            if block.tag==qn("w:p"):
                paragraph=Paragraph(block,doc)
                if paragraph.text.strip():text+=paragraph.text+"\n"
            elif block.tag==qn("w:tbl"):
                for row in Table(block,doc).rows:
                    text+=" | ".join(cell.text for cell in row.cells)+"\n"
        return text.strip()
    except Exception as e:
        raise Exception(f"Ошибка при извлечении текста из DOCX: {str(e)}")



def extract_text_from_file(file_bytes: bytes, filename: str) -> str:
    readers = {".pdf": extract_text_from_pdf_bytes, ".docx": extract_text_from_docx_bytes,
               ".doc": extract_doc, ".rtf": extract_rtf, ".txt": extract_txt}
    reader = readers.get(Path(filename).suffix.lower())
    if reader is None:
        raise ValueError("Неподдерживаемый формат документа.")
    return reader(file_bytes).strip()


def extract_txt(file_bytes: bytes) -> str:
    """Извлекает текст из TXT."""

    if file_bytes.startswith((b"\xff\xfe", b"\xfe\xff")):
        return file_bytes.decode("utf-16")

    if file_bytes.startswith(b"\xef\xbb\xbf"):
        return file_bytes.decode("utf-8-sig")

    for encoding in ("utf-8", "cp1251"):
        try:
            return file_bytes.decode(encoding)
        except UnicodeDecodeError:
            continue

    raise ValueError("Не удалось определить кодировку TXT.")


def extract_rtf(file_bytes: bytes) -> str:
    """Извлекает текст из RTF."""

    # RTF использует ASCII-совместимую разметку,
    # а символы могут быть представлены escape-последовательностями.
    raw_text = file_bytes.decode("latin-1")

    return rtf_to_text(raw_text)


def extract_doc(file_bytes: bytes) -> str:
    """Преобразует DOC в DOCX через LibreOffice."""

    from docx import Document
    from io import BytesIO

    with tempfile.TemporaryDirectory() as tmp:
        directory = Path(tmp)

        source = directory / "resume.doc"
        output = directory / "converted"
        output.mkdir()

        source.write_bytes(file_bytes)

        try:
            subprocess.run(
                [
                    "libreoffice",
                    "-env:UserInstallation=file://" + str(directory / "lo-profile"),
                    "--headless",
                    "--convert-to",
                    "docx",
                    "--outdir",
                    str(output),
                    str(source),
                ],
                check=True,
                capture_output=True,
                timeout=60,
            )
        except (
            subprocess.CalledProcessError,
            subprocess.TimeoutExpired,
            FileNotFoundError,
        ) as exc:
            raise ValueError(
                "Не удалось преобразовать DOC в DOCX."
            ) from exc

        converted = output / "resume.docx"

        if not converted.exists():
            raise ValueError(
                "LibreOffice не создал DOCX."
            )

        return extract_text_from_docx_bytes(converted.read_bytes())
