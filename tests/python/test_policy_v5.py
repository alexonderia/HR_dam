"""Profession-specific tenure and polarity regressions for the v5 scorer."""
import unittest
from resume_evaluator.evidence_scoring import compile_criteria, verify_and_score,validate_rating_source
from resume_evaluator.rank_models import ProfileRequest
from resume_evaluator.policy_v5 import assertion_proof,education_proof
from resume_evaluator.criteria_v5 import clauses_v5,requirement_list_v5


def score(source,profile,status='not_met'):
    parsed={'assessments':[{'id':c['id'],'status':status,'evidence':[source]} for c in compile_criteria(profile)],'stop_factors':[]}
    return verify_and_score(parsed,source,profile,assessment_date='2026-11-20')

MANAGER=ProfileRequest(id='manager',position_name='Руководитель производственного подразделения',
 education='среднее профессиональное или высшее, преимущественно технического, транспортного либо управленческого профиля. Приоритет имеет подтверждённый опыт организации работы подразделения.',
 experience='Организация работы производственных или транспортных подразделений. Руководство бригадами и распределение задач. Контроль трудовой дисциплины и исполнения заданий. Планирование графиков работы персонала. Контроль технического состояния транспорта и оборудования. Организация технического обслуживания и ремонта. Подготовка заявок на материалы, запчасти и оборудование. Ведение производственной и отчётной документации.',
 keywords=['Бригадир или мастер или начальник автоколонны или начальник смены или руководитель подразделения','транспорт','производство','управление бригадой','производственные процессы','организация персонала','техническое обслуживание','дисциплина','планирование смен'])

class PolicyV5Tests(unittest.TestCase):
    def test_unrelated_general_years_and_degree_do_not_raise_backend(self):
        p=ProfileRequest(id='p',position_name='Backend',experience='от 3 лет',education='Высшее',keywords=['Python','SQL','Rest API'])
        source='Опыт работы\nМарт 2022 — настоящее время\nРаботал водителем. Перевозка грузов.\nОбразование\nБакалавр\nГосударственное и муниципальное управление'
        r=score(source,p,'met');self.assertEqual(r['score'],0)
        self.assertEqual(r['details']['professional_basis']['status'],'unconfirmed')
        self.assertEqual(r['details']['general_experience_months'],56)
        c=next(c for c in r['details']['criteria'] if c['category']=='experience')
        self.assertEqual(c['status'],'unknown');self.assertNotIn('experience_months',c)
        self.assertEqual(next(c for c in r['details']['criteria'] if c['category']=='education')['status'],'met')
        validate_rating_source(r,source)
        r['details']['general_work_evidence'][0]['quote']='Несуществующая цитата'
        with self.assertRaises(ValueError):validate_rating_source(r,source)

    def test_degree_cannot_prove_ml(self):
        p=ProfileRequest(id='p',position_name='ML',education='Высшее',keywords=['Python','SQL','ML'])
        self.assertEqual(score('Образование\nБакалавр',p,'met')['score'],0)

    def test_positive_duty_cannot_be_negative(self):
        requirement='Контроль технического состояния транспорта и оборудования.'
        p=ProfileRequest(id='p',position_name='Начальник автоколонны',experience=requirement)
        r=score('Опыт работы\n'+requirement,p)
        self.assertEqual(r['score'],100)
        self.assertEqual(r['details']['criteria'][0]['status'],'met')

    def test_company_period_is_not_new_leadership_period(self):
        source='Опыт работы\nМарт 2022 — настоящее время\nТранспортная компания. Начал карьеру водителем. Затем назначен бригадиром. Недавно назначен начальником автоколонны.'
        p=ProfileRequest(id='p',position_name='Начальник автоколонны',experience='от 3 лет',keywords=['транспорт'])
        c=next(c for c in score(source,p,'met')['details']['criteria'] if c['category']=='experience')
        self.assertEqual(c['status'],'unknown');self.assertNotIn('experience_months',c)
        p.experience='От 3 лет в транспортной сфере'
        c=next(c for c in score(source,p,'met')['details']['criteria'] if c['category']=='experience')
        self.assertEqual(c['status'],'met');self.assertEqual(c['experience_months'],56)

    def test_full_manager_profile_preserves_duties_and_education_alternatives(self):
        source='Опыт работы\nНачальник автоколонны.\n'+MANAGER.experience+'\nОбразование\nБакалавр\nГосударственное и муниципальное управление'
        r=score(source,MANAGER)
        exp=[c for c in r['details']['criteria'] if c['category']=='experience' and not c['optional']]
        self.assertEqual(len(exp),8)
        self.assertTrue(all(c['status']=='met' for c in exp),[(c['requirement'],c['status']) for c in exp])
        self.assertEqual(next(c for c in r['details']['criteria'] if c['category']=='education' and not c['optional'])['status'],'met')
        self.assertGreaterEqual(r['score'],35)

    def test_negative_education_must_refer_to_degree(self):
        self.assertFalse(education_proof('Высшее','not_met',['Нет детей. Не женат.']))
        self.assertTrue(education_proof('Высшее','not_met',['Высшее образование не получено']))
        self.assertFalse(assertion_proof('Контроль качества кода','met',['Контроль качества складских отгрузок. Код писал в учебном проекте.']))

    def test_comma_in_duty_and_stop_does_not_split_objects(self):
        self.assertEqual(len(clauses_v5('Подготовка заявок на материалы, запчасти и оборудование.')),1)
        self.assertEqual(len(requirement_list_v5('Отсутствие руководящего опыта для должности, предполагающей самостоятельное управление подразделением.')),1)
        self.assertEqual(requirement_list_v5('Python, SQL, Rest API'),['Python','SQL','Rest API'])

    def test_training_is_not_applied_skill(self):
        p=ProfileRequest(id='p',position_name='Developer',keywords=['Python'])
        r=score('Python используется в учебном проекте разработки приложений.',p,'met')
        self.assertEqual(r['score'],50)
        self.assertEqual(r['details']['criteria'][0]['status'],'partial')

    def test_duplicate_model_ids_split_batch_without_accepting_incomplete_result(self):
        import json
        from unittest.mock import patch
        from resume_evaluator.scoring import rank_profile
        def response(**kwargs):
            payload=json.loads(kwargs['user_prompt'])
            criteria=payload['criteria']
            identifiers=[c['id'] for c in criteria]
            if len(identifiers)>1:identifiers=[identifiers[0]]*len(identifiers)
            return {'response':json.dumps({'assessments':[{'id':i,'status':'met','evidence':['b0'],'unknown_reason':None,'partial_reason':None} for i in identifiers],'stop_factors':[]})}
        p=ProfileRequest(id='p',position_name='Backend',keywords=['Python','SQL'])
        with patch('resume_evaluator.scoring.ask_ollama_chat',side_effect=response) as model:
            r=rank_profile('Работаю с Python и SQL.',p)
        self.assertEqual(model.call_count,4)
        self.assertEqual(r['score'],100)
        self.assertEqual({c['id'] for c in r['details']['criteria']},{'keyword:0:0','keyword:1:0'})

    def test_single_transferable_tool_does_not_prove_backend_tenure(self):
        p=ProfileRequest(id='p',position_name='Backend',experience='от 3 лет',keywords=['Python','SQL','Rest API'])
        source='Опыт работы\nМарт 2022 — настоящее время\nВодитель. Использовал SQL для транспортных отчётов.'
        r=score(source,p,'met')
        c=next(c for c in r['details']['criteria'] if c['category']=='experience')
        self.assertEqual(c['status'],'unknown');self.assertNotIn('experience_months',c)

    def test_named_professional_role_proves_its_own_period(self):
        p=ProfileRequest(id='p',position_name='Backend',experience='от 3 лет',keywords=['Python','SQL','Rest API'])
        source='Опыт работы\nМарт 2022 — настоящее время\nBackend-разработчик. Разработка серверных приложений.'
        c=next(c for c in score(source,p,'met')['details']['criteria'] if c['category']=='experience')
        self.assertEqual(c['status'],'met');self.assertEqual(c['experience_months'],56)

    def test_generic_organization_does_not_prove_construction(self):
        from resume_evaluator.policy_v5 import professional_context
        scope={'role':'Инженер-строитель','anchors':['строительное производство','управление строительством','AutoCAD']}
        self.assertFalse(professional_context('Организация строительно-монтажных работ на объектах.',scope,['Организация работы колонны на объекте.']))
        self.assertFalse(professional_context('Строительство и реконструкция промышленных объектов.',scope,['Организация работы колонны на объекте.']))
        self.assertTrue(professional_context('Строительство и реконструкция промышленных объектов.',scope,['Выполнял строительство промышленных объектов.']))

    def test_semantic_review_cannot_turn_transport_organization_into_construction(self):
        p=ProfileRequest(id='p',position_name='Инженер-строитель',keywords=['строительное производство'],experience='Строительство и реконструкция промышленных объектов.')
        source='Организация работы колонны на объекте и распределение задач между сотрудниками.'
        review={'method':'focused-model-review-v1','status':'partial','action_matches':False,'object_matches':True,'responsibility_matches':False,'evidence':['b0'],'supported_text':source}
        entry={'id':'experience:0','status':'partial','evidence':[source],'_verified_evidence':[{'quote':source,'start':0,'end':len(source),'block_id':'b0','section':'Опыт работы'}],'semantic_review':review}
        r=verify_and_score({'assessments':[entry],'stop_factors':[]},source,p)
        self.assertEqual(r['score'],0)
        c=next(c for c in r['details']['criteria'] if c['category']=='experience')
        self.assertEqual(c['status'],'unknown');self.assertEqual(c['unknown_reason'],'not_relevant')
