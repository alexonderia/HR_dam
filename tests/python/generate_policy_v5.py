"""Generate synthetic cross-language contract fixtures, never model benchmarks."""
import json
from pathlib import Path
from resume_evaluator.evidence_scoring import compile_criteria,verify_and_score
from resume_evaluator.rank_models import ProfileRequest

cases=[]
for c in json.loads((Path(__file__).parent/'fixtures/proof-policy-v4.json').read_text()):
    for field in ('keywords','comment'):
        p=ProfileRequest(id='p',position_name='Тест',**{field:[c['requirement']] if field=='keywords' else c['requirement']})
        criteria=compile_criteria(p);source='\n'.join(c['quotes'])
        parsed={'assessments':[{'id':criteria[0]['id'],'status':c['status'],'evidence':c['quotes']}],'stop_factors':[]}
        cases.append({'name':c['name']+'_'+field,'profile':p.model_dump(),'source':source,'parsed':parsed,'rating':verify_and_score(parsed,source,p,assessment_date='2026-11-19')})
for field,text,requirement,status in [('education','Высшее образование не получено','Высшее образование','met'),('education','Планирую получить высшее образование','Высшее образование','met'),('education','Бакалавр','Высшее образование','met'),('experience','Работаю разработчиком 2 года','до 3 лет разработки','met'),('experience','Работаю разработчиком 3 года','не более 2 лет разработки','met'),('experience','Работаю разработчиком 3 года','2,5 года разработки','met'),('experience','Работаю разработчиком 2 года','не менее 2 лет разработки','met')]:
    p=ProfileRequest(id='p',position_name='Тест',**{field:requirement});source=text
    parsed={'assessments':[{'id':compile_criteria(p)[0]['id'],'status':status,'evidence':[text]}],'stop_factors':[]}
    cases.append({'name':field+'_'+requirement+'_'+text,'profile':p.model_dump(),'source':source,'parsed':parsed,'rating':verify_and_score(parsed,source,p,assessment_date='2026-11-19')})
for requirement,text,status in [('Отсутствие опыта в транспорте','Работал в транспорте. Не владею Python.','triggered'),('Отказ от командировок','Знаю SQL','not_triggered'),('Отказ от командировок','Отказываюсь от командировок','triggered')]:
    p=ProfileRequest(id='p',position_name='Тест',stop_factors=[requirement]);parsed={'assessments':[],'stop_factors':[{'id':'stop:0','status':status,'evidence':[text]}]}
    cases.append({'name':'stop_'+text,'profile':p.model_dump(),'source':text,'parsed':parsed,'rating':verify_and_score(parsed,text,p,assessment_date='2026-11-19')})
for p in [ProfileRequest(id='p',position_name='Тест'),ProfileRequest(id='p',position_name='Тест',keywords=['SQL','SQL','Python'],comment='SQL'),ProfileRequest(id='p',position_name='Тест',education='Высшее образование. MBA приветствуется.')]:
    parsed={'assessments':[],'stop_factors':[]};source='SQL. Python. Бакалавр.'
    cases.append({'name':'structure_'+str(len(cases)),'profile':p.model_dump(),'source':source,'parsed':parsed,'rating':verify_and_score(parsed,source,p,assessment_date='2026-11-19')})

# A synthetic, explicit second-opinion record. It tests transport validation,
# not the model's frequency of finding or correctly interpreting this claim.
p=ProfileRequest(id='p',position_name='Тест',keywords=['Руководство бригадой водителей'])
text='Бригадир водителей. Распределял задачи между водителями.'
review={'method':'focused-model-review-v1','status':'met','action_matches':True,'object_matches':True,'responsibility_matches':True,'evidence':['b0'],'supported_text':'Бригадир водителей'}
entry={'id':'keyword:0:0','status':'met','evidence':[text],'_verified_evidence':[{'quote':text,'start':0,'end':len(text),'block_id':'b0','section':'document'}],'semantic_review':review}
parsed={'assessments':[entry],'stop_factors':[]}
cases.append({'name':'focused_leadership_review','profile':p.model_dump(),'source':text,'parsed':parsed,'rating':verify_and_score(parsed,text,p,assessment_date='2026-11-19')})
p=ProfileRequest(id='p',position_name='Тест',education='Высшее образование по направлению «Государственное и муниципальное управление»')
text='Образование\nБакалавр\nГосударственное и муниципальное управление'
parsed={'assessments':[{'id':'education:0','status':'met','evidence':[text]}],'stop_factors':[]}
cases.append({'name':'degree_field_next_line','profile':p.model_dump(),'source':text,'parsed':parsed,'rating':verify_and_score(parsed,text,p,assessment_date='2026-11-19')})
from test_policy_v5 import MANAGER
for p,source,status in [
    (ProfileRequest(id='p',position_name='Backend',experience='от 3 лет',education='Высшее',keywords=['Python','SQL','Rest API']), 'Опыт работы\nМарт 2022 — настоящее время\nРаботал водителем. Перевозка грузов.\nОбразование\nБакалавр', 'met'),
    (MANAGER,'Опыт работы\nНачальник автоколонны.\n'+MANAGER.experience+'\nОбразование\nБакалавр\nГосударственное и муниципальное управление','not_met'),
    (ProfileRequest(id='p',position_name='Начальник автоколонны',experience='от 3 лет',keywords=['транспорт']),'Опыт работы\nМарт 2022 — настоящее время\nНачал карьеру водителем. Затем назначен бригадиром. Недавно назначен начальником автоколонны.','met')]:
    parsed={'assessments':[{'id':c['id'],'status':status,'evidence':[source]} for c in compile_criteria(p)],'stop_factors':[]}
    cases.append({'name':'full_'+p.position_name,'profile':p.model_dump(),'source':source,'parsed':parsed,'rating':verify_and_score(parsed,source,p,assessment_date='2026-11-20')})
print(json.dumps(cases,ensure_ascii=False,indent=2))
