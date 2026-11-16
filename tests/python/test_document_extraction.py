import io
import unittest
from unittest.mock import patch

from docx import Document
from resume_documents import text_extractor


class DocumentExtractionTests(unittest.TestCase):
    def test_text_encodings_and_docx_tables(self):
        for encoding in ("utf-8", "utf-8-sig", "utf-16", "cp1251"):
            self.assertEqual(text_extractor.extract_text_from_file("Текст резюме".encode(encoding), "resume.txt"), "Текст резюме")
        document = Document()
        document.add_paragraph("Python-разработчик")
        document.add_table(rows=1, cols=1).cell(0, 0).text = "Опыт работы"
        output = io.BytesIO(); document.save(output)
        text = text_extractor.extract_text_from_file(output.getvalue(), "resume.docx")
        self.assertIn("Python-разработчик", text)
        self.assertIn("Опыт работы", text)

    def test_repeated_jobs_extract_independently_without_retaining_text(self):
        with patch.object(text_extractor, "extract_txt", wraps=text_extractor.extract_txt) as reader:
            for _ in range(2):
                self.assertEqual(text_extractor.extract_text_from_file(b"resume", "resume.txt"), "resume")
        self.assertEqual(reader.call_count, 2)
        self.assertFalse(hasattr(text_extractor, "_text_cache"))

    def test_corrupt_and_unsupported_files_fail_explicitly(self):
        for name in ("resume.pdf", "resume.docx", "resume.exe"):
            with self.subTest(name=name), self.assertRaises(Exception):
                text_extractor.extract_text_from_file(b"invalid", name)
