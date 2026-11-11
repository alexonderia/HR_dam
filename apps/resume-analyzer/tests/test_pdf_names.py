"""Unfamiliar names require an actual, prominent PDF heading."""

import tempfile
import unittest
from pathlib import Path
from uuid import uuid4

import pymupdf as fitz

from app.candidate_extractor import extract_contacts
from app.evidence_scoring import verify_and_score
from app.pdf_names import pdf_name_header
from app.processing_v2.evaluator import evaluate
from app.processing_v2.parser import pdf_ranges
from app.processing_v2.protocol import DocumentError
from app.readiness import mark_ready


FONT = "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf"


def page(document, title, body="Опыт работы\nPython используется в учебном проекте разработки приложений.", size=18):
    result = document.new_page()
    result.insert_font(fontname="resume", fontfile=FONT)
    result.insert_text((30, 40), title, fontname="resume", fontsize=size)
    result.insert_text((30, 80), body, fontname="resume", fontsize=10)
    return result


class PDFNameTests(unittest.TestCase):
    def test_unfamiliar_name_with_patronymic_and_continuation(self):
        with fitz.open() as document:
            page(document, "Ахметов Дамир Рашидович")
            page(document, "Продолжение опыта работы", size=10)
            page(document, "Шарипов Айрат Фаритович")
            self.assertEqual(pdf_ranges(document), [(0, 2), (2, 3)])

    def test_unfamiliar_names_and_compound_patronymics_have_exact_sources(self):
        cases = [("Ахметов Дамир Рашидович", "Ахметов", "Дамир", "Рашидович"),
                 ("Дамир Рашидович Ахметов", "Ахметов", "Дамир", "Рашидович"),
                 ("Ахметов Дамир", "Ахметов", "Дамир", None),
                 ("Дамир Ахметов", "Ахметов", "Дамир", None),
                 ("Ахметов Дамир Рашид Оглы", "Ахметов", "Дамир", "Рашид Оглы")]
        for title, last, first, middle in cases:
            with self.subTest(title=title), fitz.open() as document:
                current = page(document, title)
                text = current.get_text()
                result = extract_contacts(text, name_header=pdf_name_header(current, text))
                self.assertEqual(result["candidate"], {"last_name": last, "first_name": first,
                    "middle_name": middle, "phone": None})
                self.assertEqual(result["contact_details"]["fields"]["first_name"]["quote"], title)
                self.assertEqual(result["contact_details"]["fields"]["first_name"]["line_start"], 1)

    def test_small_body_mention_does_not_become_a_header(self):
        with fitz.open() as document:
            current = page(document, "Ахметов Дамир Рашидович", size=10)
            self.assertIsNone(pdf_name_header(current, current.get_text()))
            page(document, "Продолжение", size=10)
            with self.assertRaises(DocumentError):
                pdf_ranges(document)

    def test_role_headings_do_not_become_candidates(self):
        for title in ("Менеджер Проектов", "Профессиональные навыки", "Опыт работы", "Знание языков"):
            with self.subTest(title=title), fitz.open() as document:
                current = page(document, title)
                self.assertIsNone(pdf_name_header(current, current.get_text()))

    def test_two_prominent_names_on_one_page_are_rejected(self):
        with fitz.open() as document:
            current = page(document, "Ахметов Дамир Рашидович")
            current.insert_text((30, 250), "Петров Петр Петрович", fontname="resume", fontsize=18)
            with self.assertRaises(DocumentError):
                pdf_ranges(document)

    def test_large_body_section_is_not_an_unfamiliar_second_candidate(self):
        with fitz.open() as document:
            current = page(document, "Ахметов Дамир Рашидович")
            current.insert_text((30, 480), "Уровень языков", fontname="resume", fontsize=18)
            self.assertEqual(pdf_ranges(document), [(0, 1)])

    def test_second_unfamiliar_two_part_resume_with_contacts_is_rejected(self):
        with fitz.open() as document:
            current = page(document, "Ахметов Дамир")
            current.insert_text((30, 250), "Шарипов Айрат", fontname="resume", fontsize=18)
            current.insert_text((30, 290), "Опыт работы\nТелефон: +7 999 123 45 67", fontname="resume", fontsize=10)
            with self.assertRaises(DocumentError):
                pdf_ranges(document)

    def test_evaluator_preserves_unfamiliar_candidate_name(self):
        from test_processing_v2 import FakeAPI, metadata
        with tempfile.TemporaryDirectory() as temp, fitz.open() as document:
            directory = Path(temp)
            source = directory / "input.pdf"
            page(document, "Ахметов Дамир Рашидович")
            document.save(source)
            target = {"id": str(uuid4()), "name": "Разработчик", "education": "", "experience": "",
                "keywords": ["Python"], "stop_factors": [], "comment": "", "cluster_comment": ""}
            def scorer(text, profile, comment, **_kwargs):
                return verify_and_score({"assessments": [{"id": "keyword:0:0", "status": "met",
                    "evidence": ["Python используется в учебном проекте"]}], "stop_factors": []}, text, profile, comment)
            mark_ready(True)
            try:
                result = evaluate(FakeAPI("evaluate"), {**metadata("input.pdf"),
                    "requirements": {"targets": [target]}}, source, directory, scorer)
            finally:
                mark_ready(False)
            self.assertEqual(result["candidate"]["first_name"], "Дамир")
            self.assertEqual(result["evaluations"][0]["score"], 100)


if __name__ == "__main__":
    unittest.main()
