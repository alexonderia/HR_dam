"""Audit regressions. Synthetic assertions do not measure model accuracy."""
import json
import unittest
from io import BytesIO
from unittest.mock import patch
from pathlib import Path
from docx import Document
from resume_evaluator.proof_policy import proof_verdict, experience_constraint
from resume_evaluator.document_proof import source_blocks, resolve_references, private_text
from resume_evaluator.scoring import merge_comparisons
from resume_evaluator.evidence_scoring import compile_criteria, verify_and_score
from resume_evaluator.rank_models import ProfileRequest
from resume_documents.text_extractor import extract_text_from_docx_bytes

class PolicyV4Tests(unittest.TestCase):
    def test_shared_assertions(self):
        for case in json.loads((Path(__file__).parent/'fixtures/proof-policy-v4.json').read_text()):
            with self.subTest(case=case['name']):
                self.assertEqual(proof_verdict(case['requirement'],case['status'],case['quotes'])[0],case['valid'])

    def test_numeric_operators(self):
        for text, expected in [('2,5 года',{'minimum':30,'min_inclusive':True}),('2.5 года',{'minimum':30,'min_inclusive':True}),('до 3 лет',{'maximum':36,'max_inclusive':False}),('не более 2 лет',{'maximum':24,'max_inclusive':True}),('не менее 2 лет',{'minimum':24,'min_inclusive':True}),('от 1 до 3 лет',{'minimum':12,'maximum':36,'min_inclusive':True,'max_inclusive':True})]:
            with self.subTest(text=text):self.assertEqual(experience_constraint(text),expected)

    def test_duplicate_weights_and_provenance(self):
        p=ProfileRequest(id='p',position_name='d',keywords=['SQL','SQL','Python'],comment='SQL')
        criteria=compile_criteria(p)
        self.assertEqual(len(criteria),2)
        self.assertEqual([c['weight'] for c in criteria],[5000,5000])
        self.assertEqual(len(criteria[0]['origins']),3)

    def test_references_preserve_later_occurrence(self):
        text='Навыки\nPython\nОбразование\nPython\n'
        blocks=source_blocks(text)
        block=blocks[-1]
        parsed=resolve_references({'assessments':[{'id':'k','status':'met','evidence':[block['id']]}],'stop_factors':[]},blocks)
        e=parsed['assessments'][0]['_verified_evidence'][0]
        self.assertEqual(e['start'],block['start'])
        self.assertEqual(text[e['start']:e['end']],e['quote'])

    def test_partial_denial_conflict_remains_unknown(self):
        source='Знаю Python. Не знаю Python.'
        def part(status,quote):return ({'assessments':[{'id':'k','status':status,'evidence':[quote]}],'stop_factors':[]},0,len(source))
        result=merge_comparisons([part('partial','Знаю Python'),part('not_met','Не знаю Python')],source)
        self.assertEqual(result['assessments'][0]['unknown_reason'],'contradictory')

    def test_private_mask_retains_offsets(self):
        text='Иванов Иван\n+7 (999) 123-45-67\nx@y.ru\nPython'
        masked=private_text(text,['Иванов Иван'])
        self.assertEqual(len(masked),len(text))
        self.assertNotIn('Иванов',masked)
        self.assertNotIn('999',masked)
        self.assertEqual(masked.index('Python'),text.index('Python'))

    def test_docx_table_is_between_jobs(self):
        doc=Document();doc.add_paragraph('Работа 1');doc.add_table(rows=1,cols=1).cell(0,0).text='Обязанности 1';doc.add_paragraph('Работа 2')
        data=BytesIO();doc.save(data)
        self.assertEqual(extract_text_from_docx_bytes(data.getvalue()).splitlines(),['Работа 1','Обязанности 1','Работа 2'])

    def test_empty_criteria_are_not_low_evaluation(self):
        result=verify_and_score({'assessments':[],'stop_factors':[]},'Резюме',ProfileRequest(id='p',position_name='d'))
        self.assertEqual(result['details']['score_status'],'not_defined')

    def test_education_and_stop_audit(self):
        for text,expected in [('Высшее образование не получено','not_met'),('Планирую получить высшее образование','unknown'),('Бакалавр','met')]:
            p=ProfileRequest(id='p',position_name='d',education='Высшее образование')
            result=verify_and_score({'assessments':[{'id':'education:0','status':'met','evidence':[text]}],'stop_factors':[]},text,p)
            self.assertEqual(result['details']['criteria'][0]['status'],expected)
        for requirement,text,status in [('Отсутствие опыта в транспорте','Работал в транспорте. Не владею Python.','triggered'),('Отказ от командировок','Знаю SQL','not_triggered')]:
            p=ProfileRequest(id='p',position_name='d',stop_factors=[requirement])
            result=verify_and_score({'assessments':[],'stop_factors':[{'id':'stop:0','status':status,'evidence':[text]}]},text,p)
            self.assertEqual(result['details']['stop_factors'][0]['status'],'unknown')

    def test_focused_semantic_review_recovers_leadership_without_promoting_unknown(self):
        from resume_evaluator.scoring import rank_profile
        source="Опыт работы\nБригадир водителей. Распределял задачи между водителями."
        profile=ProfileRequest(id="p",position_name="Руководитель",keywords=["Руководство бригадой водителей"])
        primary={"assessments":[{"id":"keyword:0:0","status":"met","evidence":["b0"],"unknown_reason":None,"partial_reason":None}],"stop_factors":[]}
        review={"decisions":[{"id":"keyword:0:0","status":"met","action_matches":True,"object_matches":True,"responsibility_matches":True,"evidence":["b0"],"supported_text":"Бригадир водителей"}]}
        with patch("resume_evaluator.scoring.ask_ollama_chat",return_value={"response":json.dumps(primary)}) as first,patch("resume_evaluator.semantic_review.ask_ollama_chat",return_value={"response":json.dumps(review)}) as second:
            rating=rank_profile(source,profile)
        self.assertEqual(first.call_count,1)
        self.assertEqual(second.call_count,1)
        self.assertEqual(rating["details"]["criteria"][0]["status"],"met")
        self.assertIn("semantic_review",rating["details"]["criteria"][0])

    def test_focused_review_cannot_waive_source_or_commercial_qualifier(self):
        from resume_evaluator.proof_policy import proof_verdict,valid_semantic_review
        self.assertFalse(proof_verdict("Коммерческий опыт Python","met",["Python"],True)[0])
        self.assertFalse(proof_verdict("Контроль Python сервисов","met",["Контроль складских отгрузок"],True)[0])
        evidence=[{"quote":"Бригадир водителей","block_id":"b0"}]
        review={"method":"focused-model-review-v1","status":"met","action_matches":True,"object_matches":True,"responsibility_matches":True,"evidence":["foreign"],"supported_text":"Бригадир"}
        self.assertFalse(valid_semantic_review(review,"met",evidence))
        review.update(evidence=["b0"],object_matches=False)
        self.assertFalse(valid_semantic_review(review,"met",evidence))

    def test_service_heading_does_not_silently_delete_later_cv_sections(self):
        from resume_documents.resume_sections import resume_body,ResumeBoundaryError
        with self.assertRaises(ResumeBoundaryError):
            resume_body("Резюме\nКомментарии к резюме\nТекст сотрудника\nОпыт работы\nНовая работа")

    def test_numeric_duplicate_requires_same_boundary_or_complement(self):
        from resume_evaluator.evidence_scoring import same_condition
        self.assertTrue(same_condition("От 3 лет Python","Опыт менее 3 лет Python"))
        self.assertFalse(same_condition("Опыт не более 3 лет Python","Опыт менее 3 лет Python"))
        self.assertFalse(same_condition("От 3 лет Python","Опыт менее 3 лет бухгалтером"))

    def test_numeric_experience_in_comment_is_not_just_keyword_presence(self):
        p=ProfileRequest(id="p",position_name="d",comment="Опыт Python от 3 лет")
        source="Работаю с Python 1 год"
        criterion=compile_criteria(p)[0]
        self.assertEqual(criterion["category"],"experience")
        result=verify_and_score({"assessments":[{"id":criterion["id"],"status":"met","evidence":[source]}],"stop_factors":[]},source,p)
        self.assertEqual(result["details"]["criteria"][0]["status"],"partial")
        self.assertAlmostEqual(result["score"],33.33)

    def test_unread_pdf_page_is_numbered(self):
        import pymupdf as fitz
        from resume_documents.text_extractor import extract_text_from_pdf_bytes
        document=fitz.open();document.new_page().insert_text((40,40),"Readable resume");document.new_page()
        with self.assertRaisesRegex(Exception,"2"):
            extract_text_from_pdf_bytes(document.tobytes())
        document.close()

    def test_review_support_restores_pdf_line_wrap_inside_selected_block(self):
        from resume_evaluator.semantic_review import review_duties
        text="Подготовка заявок на закупку запчастей и\nматериалов."
        item={"requirement":"Закупка запчастей и материалов","entry":{"id":"k","_verified_evidence":[{"block_id":"b40","quote":text,"start":40,"end":40+len(text)}]}}
        decision={"id":"k","status":"partial","action_matches":True,"object_matches":True,"responsibility_matches":False,"evidence":["b40"],"supported_text":"Подготовка заявок на закупку запчастей и материалов"}
        with patch("resume_evaluator.semantic_review.ask_ollama_chat",return_value={"response":json.dumps({"decisions":[decision]})}):
            result,_=review_duties([item],timeout=30,num_ctx=8192,max_tokens=768)
        self.assertIn("\n",result["k"]["supported_text"])
        self.assertIn(result["k"]["supported_text"],text)

    def test_request_is_partial_participation_but_not_independent_execution(self):
        source="Подготовка заявок на закупку запчастей и\nматериалов."
        for requirement,expected in [("Закупка запчастей и материалов","partial"),("Самостоятельная закупка запчастей и материалов","unknown")]:
            p=ProfileRequest(id="p",position_name="d",keywords=[requirement])
            result=verify_and_score({"assessments":[{"id":"keyword:0:0","status":"met","evidence":[source]}],"stop_factors":[]},source,p)
            self.assertEqual(result["details"]["criteria"][0]["status"],expected)
            if expected=="partial":self.assertIn("\n",result["details"]["criteria"][0]["confirmed_part"])

    def test_soft_wrap_does_not_merge_a_separate_denial(self):
        from resume_evaluator.proof_policy import proof_verdict
        self.assertTrue(proof_verdict("Python","met",["Python\nне знаю SQL"])[0])

    def test_degree_field_can_continue_on_next_pdf_line(self):
        from resume_evaluator.proof_policy import education_met_supported
        requirement='Высшее образование по направлению «Государственное и муниципальное управление»'
        self.assertTrue(education_met_supported(requirement,['Образование\nБакалавр\nГосударственное и муниципальное управление']))
        self.assertFalse(education_met_supported(requirement,['Образование\nБакалавр филологии']))
