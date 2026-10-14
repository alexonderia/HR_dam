import fitz  # PyMuPDF
from docx import Document
from io import BytesIO


def extract_text_from_pdf_bytes(pdf_bytes: bytes) -> str:
    """Извлекает текст из PDF"""
    try:
        with fitz.open(stream=pdf_bytes, filetype="pdf") as doc:
            if len(doc) > 100:
                raise ValueError("Документ содержит более 100 страниц")
            text = "\n".join(page.get_text() for page in doc)
        return text.strip()
    
    except Exception as e:
        raise Exception(f"Ошибка при извлечении текста из PDF: {str(e)}")


def extract_text_from_docx_bytes(docx_bytes: bytes) -> str:
    """Извлекает текст из DOCX"""
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
    Извлекает текст из файла в зависимости от расширения.
    """
    filename_lower = filename.lower()
    
    if filename_lower.endswith('.pdf'):
        return extract_text_from_pdf_bytes(file_bytes)
    
    elif filename_lower.endswith('.docx'):
        return extract_text_from_docx_bytes(file_bytes)
    elif filename_lower.endswith('.txt'):
        return file_bytes.decode('utf-8-sig')
    
    else:
        raise Exception("Поддерживаются PDF, DOCX и нормализованный TXT")
