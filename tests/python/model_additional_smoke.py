"""Optional real-model checks of additional requirements, synthetic text only."""
import json
from resume_evaluator.scoring import rank_profile
from resume_evaluator.rank_models import ProfileRequest

profile=ProfileRequest(id="p",position_name="Backend",comment="Ищем сильного бэкендера для высоконагруженных систем. Плюс опыт с Kubernetes")
cases=[
    ("unrelated","Работаю электромонтажником. Выполняю монтаж и ремонт электрооборудования.",["unknown","unknown"],0),
    ("supported","Разрабатываю backend высоконагруженных систем. Работаю с Kubernetes.",["met","met"],100),
    ("bonus_denied","Разрабатываю backend высоконагруженных систем. С Kubernetes не работал.",["met","not_met"],100),
]
for name,source,expected,score in cases:
    rating=rank_profile(source,profile,timeout=180,assessment_date="2026-11-16")
    states=[c["status"] for c in rating["details"]["criteria"]]
    print(json.dumps({"case":name,"states":states,"score":rating["score"],"expected":expected}),flush=True)
    assert states==expected,(name,states)
    assert rating["score"]==score
print("PASS actual model: unrelated evidence, supported facts, optional denial",flush=True)
