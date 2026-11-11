"""Current worker contract, isolation, real document extraction and retry safety."""

import hashlib
import json
import os
import tempfile
import time
import unittest
import zipfile
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock, patch
from uuid import uuid4

os.environ["TEXT_CACHE_MAX_ITEMS"] = "0"
os.environ["TEXT_CACHE_MAX_BYTES"] = "0"

import jwt
import pymupdf as fitz
from cryptography.hazmat.primitives.asymmetric import rsa
from docx import Document

from app.processing_v2.api import JobAPI
from app.processing_v2.protocol import ClosedJob, DocumentError, InvalidJob, Job, RetryJob, api_address, verify_delivery
from app.processing_v2.__main__ import handle_delivery
from app.processing_v2.evaluator import evaluate
from app.processing_v2.parser import pdf_ranges, prepare
from app.evidence_scoring import verify_and_score
from app.readiness import mark_ready


PRIVATE = rsa.generate_private_key(public_exponent=65537, key_size=2048)
PUBLIC = PRIVATE.public_key()


def delivery(mode="guest", operation="evaluate", expires=None):
    expires = int(time.time()) + 300 if expires is None else expires
    command = {"job_id": str(uuid4()), "task_id": str(uuid4()), "file_id": str(uuid4()),
        "mode": mode, "operation": operation, "attempt": 1,
        "deadline": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(expires))}
    claims = {"iss": f"hr-{mode}-jobs", "aud": f"hr-{mode}-job-api", "sub": command["job_id"],
        **{k: command[k] for k in ("task_id", "file_id", "mode", "operation", "attempt")},
        "iat": expires - 600, "exp": expires,
        "permissions": ["input:read", "file:read", "progress:write", "result:write"] + (["output:write"] if operation == "prepare" else [])}
    token = jwt.encode(claims, PRIVATE, algorithm="RS256", headers={"typ": "hr-processing-job+jwt"})
    properties = SimpleNamespace(content_type="application/json", delivery_mode=2,
        message_id=command["job_id"], headers={"x-job-token": token})
    return command, properties, claims


class ProtocolTests(unittest.TestCase):
    def test_both_modes_and_operations(self):
        for mode in ("guest", "authorized"):
            for operation in ("prepare", "evaluate"):
                command, properties, _ = delivery(mode, operation)
                job = verify_delivery(json.dumps(command), properties, mode, operation, PUBLIC)
                self.assertEqual(job.command, command)

    def test_queue_identity_signature_and_permissions(self):
        command, properties, claims = delivery()
        body = json.dumps(command)
        for mode, operation in (("authorized", "evaluate"), ("guest", "prepare")):
            with self.assertRaises(InvalidJob):
                verify_delivery(body, properties, mode, operation, PUBLIC)
        for changed in ({"file_id": str(uuid4())}, {"permissions": ["input:read"]},
                        {"exp": claims["exp"] + 1}, {"iat": claims["exp"]}, {"attempt": True}):
            properties.headers["x-job-token"] = jwt.encode({**claims, **changed}, PRIVATE,
                algorithm="RS256", headers={"typ": "hr-processing-job+jwt"})
            with self.assertRaises(InvalidJob):
                verify_delivery(body, properties, "guest", "evaluate", PUBLIC)

    def test_invalid_signature_is_not_acknowledged_even_when_expired(self):
        command, properties, _ = delivery(expires=int(time.time()) - 10)
        with self.assertRaises(ClosedJob):
            verify_delivery(json.dumps(command), properties, "guest", "evaluate", PUBLIC)
        other = rsa.generate_private_key(public_exponent=65537, key_size=2048)
        with self.assertRaises(InvalidJob):
            verify_delivery(json.dumps(command), properties, "guest", "evaluate", other.public_key())

    def test_strict_command_and_message_properties(self):
        command, properties, _ = delivery()
        invalid = [{**command, "attempt": True}, {**command, "url": "http://untrusted"},
                   {**command, "deadline": "2026-11-10T12:00:00"}, {**command, "file_id": "../file"}]
        for value in invalid:
            with self.assertRaises(InvalidJob):
                verify_delivery(json.dumps(value), properties, "guest", "evaluate", PUBLIC)
        with self.assertRaises(InvalidJob):
            verify_delivery(json.dumps(command)[:-1] + ',"attempt":1}', properties, "guest", "evaluate", PUBLIC)
        properties.message_id = str(uuid4())
        with self.assertRaises(InvalidJob):
            verify_delivery(json.dumps(command), properties, "guest", "evaluate", PUBLIC)

    def test_api_configuration_rejects_unscoped_addresses(self):
        self.assertEqual(api_address("http://guest-api:3002/internal/guest/", "guest"), "http://guest-api:3002/internal/guest")
        for url in ("http://backend/internal/app", "http://user:password@host/internal/guest", "file:///internal/guest", "http://host/internal/guest?url=x"):
            with self.assertRaises(ValueError):
                api_address(url, "guest")


class FakeAPI:
    def __init__(self, operation="prepare"):
        self.job = Job(delivery(operation=operation)[0], "unused", time.time() + 300)
        self.outputs = []

    def check(self):
        self.job.check_open()

    def input(self):
        self.check()

    def output(self, key, path, metadata):
        digest = hashlib.sha256(path.read_bytes()).hexdigest()
        self.outputs.append((key, metadata, digest))
        return key[:8] + "-0000-4000-8000-000000000000"


def metadata(name):
    return {"file": {"file_name": name}, "limits": {"max_file_bytes": 52428800,
        "max_expanded_bytes": 262144000, "max_files": 200}}


class DocumentTests(unittest.TestCase):
    def test_docx_uses_real_extraction_and_verified_evidence(self):
        with tempfile.TemporaryDirectory() as temp:
            directory = Path(temp)
            document = Document()
            document.add_paragraph("Синтетическое резюме. Python используется в учебном проекте разработки приложений.")
            source = directory / "input.docx"
            document.save(source)
            target = {"id": str(uuid4()), "name": "Разработчик", "education": "", "experience": "",
                "keywords": ["Python"], "stop_factors": [], "comment": "", "cluster_comment": ""}
            value = {**metadata("input.docx"), "requirements": {"targets": [target]}}
            def scorer(text, profile, comment, **_kwargs):
                return verify_and_score({"assessments": [{"id": "keyword:0:0", "status": "met", "evidence": ["Python используется в учебном проекте"]}], "stop_factors": []}, text, profile, comment)
            mark_ready(True)
            result = evaluate(FakeAPI("evaluate"), value, source, directory, scorer)
            self.assertEqual(result["evaluations"][0]["score"], 100)
            self.assertEqual(result["evaluations"][0]["target_id"], target["id"])
            self.assertEqual([c["name"] for c in result["evaluations"][0]["criteria"]], ["education", "experience", "keywords"])
            self.assertIsNone(result["candidate"]["phone"])
            from app.text_extractor import _text_cache
            self.assertFalse(_text_cache)

    def test_zip_partial_result_and_repeat_output_keys(self):
        with tempfile.TemporaryDirectory() as temp:
            directory = Path(temp)
            source = directory / "input.zip"
            with zipfile.ZipFile(source, "w") as archive:
                archive.writestr("folder/resume.txt", "Synthetic document with enough resume text.")
                archive.writestr("../escape.txt", "must never escape")
                archive.writestr("nested.zip", b"PK")
            api = FakeAPI()
            first = prepare(api, metadata("input.zip"), source, directory)
            original = list(api.outputs)
            again = prepare(api, metadata("input.zip"), source, directory)
            self.assertEqual(first, again)
            self.assertEqual(original, api.outputs[len(original):])
            self.assertEqual(len(first["files"]), 1)
            self.assertEqual(len(first["errors"]), 2)
            self.assertEqual(original[0][1]["archive_path"], "folder/resume.txt")
            self.assertFalse((directory.parent / "escape.txt").exists())

    def test_zip_expansion_limit(self):
        with tempfile.TemporaryDirectory() as temp:
            directory = Path(temp)
            source = directory / "input.zip"
            with zipfile.ZipFile(source, "w", zipfile.ZIP_DEFLATED) as archive:
                archive.writestr("resume.txt", b"x" * 10000)
            value = metadata("input.zip")
            value["limits"]["max_expanded_bytes"] = 100
            with self.assertRaises(DocumentError) as error:
                prepare(FakeAPI(), value, source, directory)
            self.assertEqual(error.exception.code, "LIMIT_EXCEEDED")

    def test_single_pdf_reuses_source(self):
        with tempfile.TemporaryDirectory() as temp:
            directory = Path(temp)
            source = directory / "input.pdf"
            with fitz.open() as document:
                document.new_page().insert_text((30, 30), "Synthetic resume for one candidate, with Python experience.")
                document.save(source)
            api = FakeAPI()
            result = prepare(api, metadata("input.pdf"), source, directory)
            self.assertEqual(result["files"], [{"file_id": api.job.command["file_id"]}])
            self.assertFalse(api.outputs)

    def test_pdf_boundaries_and_ambiguous_document(self):
        class Page:
            def __init__(self, text): self.text = text
            def get_text(self): return self.text
        class PDF(list):
            needs_pass = False
        document = PDF([Page("Иванов Иван Иванович\nОпыт работы\nPython"),
            Page("Продолжение опыта работы\nРазработка приложений"),
            Page("Петров Петр Петрович\nОпыт работы\nJava")])
        self.assertEqual(pdf_ranges(document), [(0, 2), (2, 3)])
        with self.assertRaises(DocumentError):
            pdf_ranges(PDF([Page("Образование и опыт неизвестного кандидата"), Page("Другая страница")]))

    def test_pdf_comments_and_history_are_not_new_candidates(self):
        class Page:
            def __init__(self, text): self.text = text
            def get_text(self): return self.text
        class PDF(list): needs_pass = False
        pages = PDF([Page("Иванов Иван Иванович\nОпыт работы\nPython"),
            Page("Комментарии к резюме\nПетров Петр Петрович\nСидорова Анна Ивановна\nИстория общения"),
            Page("Сидорова Анна Ивановна\nПриглашение отправлено\nИванов Иван • Резюме обновлено 10 ноября")])
        self.assertEqual(pdf_ranges(pages), [(0, 3)])

    def test_new_resume_after_comments_is_still_separated(self):
        class Page:
            def __init__(self, text): self.text = text
            def get_text(self): return self.text
        class PDF(list): needs_pass = False
        pages = PDF([Page("Иванов Иван Иванович\nОпыт работы\nPython"),
            Page("Комментарии к резюме\nСидорова Анна Ивановна\nКомментарий сотрудника"),
            Page("Петров Петр Петрович\nОпыт работы\nJava")])
        self.assertEqual(pdf_ranges(pages), [(0, 2), (2, 3)])

    def test_unidentified_history_continuation_does_not_silently_become_resume(self):
        class Page:
            def __init__(self, text): self.text = text
            def get_text(self): return self.text
        class PDF(list): needs_pass = False
        with self.assertRaises(DocumentError):
            pdf_ranges(PDF([Page("Иванов Иван Иванович\nОпыт работы"),
                Page("Комментарии к резюме\nКомментарий сотрудника"),
                Page("Петров Петр Петрович\nОтправлено приглашение")]))

    def test_multiple_candidates_on_same_page_remain_ambiguous(self):
        class Page:
            def get_text(self): return "Иванов Иван Иванович\nОпыт работы\nПетров Петр Петрович\nОпыт работы"
        class PDF(list): needs_pass = False
        with self.assertRaises(DocumentError):
            pdf_ranges(PDF([Page()]))

    def test_evaluator_excludes_recruiter_comments_from_model_input(self):
        with tempfile.TemporaryDirectory() as temp:
            directory = Path(temp)
            source = directory / "input.pdf"
            with fitz.open() as document:
                for text in ("Иванов Иван Иванович\nPython используется в учебном проекте разработки приложений.",
                             "Комментарии к резюме\nПетров Петр Петрович\nJava и рекомендации сотрудника"):
                    page = document.new_page()
                    page.insert_font(fontname="resume", fontfile="/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf")
                    page.insert_text((30, 40), text, fontname="resume")
                document.save(source)
            target = {"id": str(uuid4()), "name": "Разработчик", "education": "", "experience": "",
                "keywords": ["Python"], "stop_factors": [], "comment": "", "cluster_comment": ""}
            def scorer(text, profile, comment, **_kwargs):
                self.assertNotIn("Петров", text)
                self.assertNotIn("Java", text)
                return verify_and_score({"assessments": [{"id": "keyword:0:0", "status": "met",
                    "evidence": ["Python используется в учебном проекте"]}], "stop_factors": []}, text, profile, comment)
            mark_ready(True)
            result = evaluate(FakeAPI("evaluate"), {**metadata("input.pdf"), "requirements": {"targets": [target]}},
                source, directory, scorer)
            self.assertEqual(result["candidate"]["last_name"], "Иванов")
            self.assertEqual(result["evaluations"][0]["score"], 100)

    def test_real_multipage_pdf_outputs_are_stable_on_redelivery(self):
        with tempfile.TemporaryDirectory() as temp:
            directory = Path(temp)
            source = directory / "input.pdf"
            with fitz.open() as document:
                for text in ("Иванов Иван Иванович\nPython разработка приложений",
                             "Продолжение опыта работы\nРазработка приложений",
                             "Петров Петр Петрович\nPython тестирование приложений"):
                    page = document.new_page()
                    page.insert_font(fontname="resume", fontfile="/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf")
                    page.insert_text((30, 40), text, fontname="resume")
                document.save(source)
            api = FakeAPI()
            first = prepare(api, metadata("input.pdf"), source, directory)
            original = list(api.outputs)
            second = prepare(api, metadata("input.pdf"), source, directory)
            self.assertEqual(first, second)
            self.assertEqual(original, api.outputs[len(original):])
            self.assertEqual([o[1]["pages"] for o in original], [[1, 2], [3]])

    def test_split_pdf_excludes_unused_other_candidate_images(self):
        with tempfile.TemporaryDirectory() as temp, fitz.open() as document:
            directory = Path(temp)
            source = directory / "input.pdf"
            images = []
            for name, color in (("Иванов Иван Иванович", b"\xff\x00\x00"),
                                ("Петров Петр Петрович", b"\x00\x00\xff")):
                page = document.new_page()
                page.insert_font(fontname="resume", fontfile="/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf")
                page.insert_text((30, 40), name, fontname="resume")
                photo = fitz.Pixmap(fitz.csRGB, 2, 2, color * 4, False)
                images.append(page.insert_image(fitz.Rect(30, 80, 60, 110), pixmap=photo))
            for i, page in enumerate(document):
                resource = int(document.xref_get_key(page.xref, "Resources")[1].split()[0])
                document.xref_set_key(resource, "XObject/OtherPhoto", f"{images[1-i]} 0 R")
                self.assertEqual(len(page.get_images()), 2)
            document.save(source)
            captured = []
            class API(FakeAPI):
                def output(self, key, path, value):
                    captured.append((value["pages"], path.read_bytes()))
                    return super().output(key, path, value)
            result = prepare(API(), metadata("input.pdf"), source, directory)
            self.assertEqual(len(result["files"]), 2)
            for pages, data in captured:
                with fitz.open(stream=data, filetype="pdf") as output:
                    self.assertEqual(len(output[0].get_images()), 1)
                    original = document[pages[0] - 1]
                    self.assertEqual(output[0].get_text(), original.get_text())
                    self.assertEqual(output[0].get_pixmap().samples, original.get_pixmap().samples)


class HTTPTests(unittest.TestCase):
    def setUp(self):
        command, properties, _ = delivery()
        self.api = JobAPI("http://guest-api:3002/internal/guest",
            verify_delivery(json.dumps(command), properties, "guest", "evaluate", PUBLIC))
        self.addCleanup(self.api.close)

    def response(self, status=200, value=None, chunks=None):
        response = Mock(status_code=status)
        response.__enter__ = Mock(return_value=response)
        response.__exit__ = Mock(return_value=False)
        response.iter_content.return_value = chunks if chunks is not None else [json.dumps(value).encode()]
        return response

    def test_transient_and_terminal_statuses(self):
        for status, error in ((503, RetryJob), (429, RetryJob), (404, ClosedJob), (410, ClosedJob), (403, InvalidJob)):
            with patch.object(self.api.session, "request", return_value=self.response(status)):
                with self.assertRaises(error): self.api.input()

    def test_invalid_extracted_file_is_a_document_error_for_partial_zip_results(self):
        with patch.object(self.api.session, "request", return_value=self.response(422)):
            with self.assertRaises(DocumentError):
                self.api.request("PUT", self.api.root + "/output/resume-1")

    def test_conflict_is_only_acknowledged_for_closed_job(self):
        active = {"job_id": self.api.job.id, "attempt": 1, "should_process": True}
        with patch.object(self.api.session, "request", side_effect=[self.response(409), self.response(value=active)]):
            with self.assertRaises(InvalidJob): self.api.progress()
        with patch.object(self.api.session, "request", side_effect=[self.response(409), self.response(value={**active, "should_process": False})]):
            with self.assertRaises(ClosedJob): self.api.progress()

    def test_download_rejects_foreign_url_and_wrong_digest(self):
        description = {"file_id": self.api.job.command["file_id"], "size_bytes": 3,
            "download_path": "http://untrusted/file", "sha256": hashlib.sha256(b"abc").hexdigest()}
        with tempfile.TemporaryDirectory() as temp:
            with self.assertRaises(InvalidJob): self.api.download(description, {"max_file_bytes": 100}, Path(temp))
            description["download_path"] = self.api.root.split(":3002")[1] + "/files/" + description["file_id"]
            with patch.object(self.api.session, "request", return_value=self.response(chunks=[b"xyz"])):
                with self.assertRaises(InvalidJob): self.api.download(description, {"max_file_bytes": 100}, Path(temp))

    def test_delivery_ack_only_after_result_success(self):
        command, properties, _ = delivery()
        api = Mock()
        api.input.return_value = {"file": {}, "limits": {}}
        with patch("app.processing_v2.__main__.JobAPI", return_value=api):
            processor = Mock(return_value={"status": "completed"})
            args = (json.dumps(command), properties, "guest", "evaluate", PUBLIC, "unused", lambda: False, processor)
            api.result.side_effect = RetryJob()
            self.assertEqual(handle_delivery(*args), "retry")
            api.result.side_effect = None
            self.assertEqual(handle_delivery(*args), "ack")
            processor.side_effect = DocumentError("INVALID_FILE", "Synthetic error")
            self.assertEqual(handle_delivery(*args), "ack")
            self.assertEqual(api.result.call_args.args[0]["status"], "failed")

    def test_saved_result_is_replayed_without_reprocessing_or_output_upload(self):
        command, properties, _ = delivery(operation="prepare")
        saved = {"status": "completed", "files": [{"file_id": str(uuid4())}], "errors": []}
        api, processor = Mock(), Mock()
        api.input.return_value = {"saved_result": saved}
        with patch("app.processing_v2.__main__.JobAPI", return_value=api):
            action = handle_delivery(json.dumps(command), properties, "guest", "prepare", PUBLIC, "unused", lambda: False, processor)
        self.assertEqual(action, "ack")
        api.result.assert_called_once_with(saved)
        api.download.assert_not_called()
        processor.assert_not_called()


if __name__ == "__main__":
    unittest.main()
