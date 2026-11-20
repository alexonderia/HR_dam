"""Versioned statement checks, independent of a profession-specific dictionary.

The model compares meaning. These conservative guards verify scope, entities,
qualifiers and polarity of the cited statement; they never promote unknown.
"""
import re

STOP = set("и или в во на по с со к ко от до для при из за о об а но не нет без опыт опыта работы работа наличие отсутствие знание знания навыки навык умение владение ищем нужен нужна требуется важен важна важны важно кандидат кандидата специалист сильный сильного желательно плюс приветствуется обязательно образование высшее получено лет года год месяцев месяц менее более как также его ее их это этой указанной успешное".split())
SUFFIXES = sorted("иями ями ами ого ему ими ыми иями ениями ацией ации ация ацию иями остью остями ными ных ный ную ной ное ные ным ение ения ению ением ировать ировал ирую ирует ование ования ованию ание ания анию анием ительной ительную ствами ства ности ность ями ами ому его ыми ими ой ый ий ые ая яя ое ее ие ам ям ах ях ов ев ей ем ом ют ет ит ат ят ы а я у ю е и о ь".split(), key=len, reverse=True)
NEGATIVE = re.compile(r"\b(?:нет|без|отсутств\w*|отказ\w*|никогда|не\s+(?:зна\w*|владе\w*|име\w*|работ\w*|использ\w*|уме\w*|получ\w*|окончи\w*|готов\w*|занима\w*|провод\w*|выполня\w*))\b", re.I)
INTENT = re.compile(r"\b(?:хочу|планиру\w*|намерен\w*|мечтаю|хотел\w*\s+бы|желаем\w*\s+должност\w*|требования\s+работодателя)\b", re.I)
LEARNING = re.compile(r"\b(?:изучаю|изучает|учусь|обучаюсь|прохожу\s+курс|учебн\w*|начальн\w*\s+уров\w*|начинающ\w*|базов\w*\s+уров\w*)\b", re.I)
MISSING = re.compile(r"не\s+указан\w*|нет\s+(?:сведений|данных|информации)|не\s+подтвержден\w*", re.I)
CLAUSE = re.compile(r"[;\n]|[.!?](?=\s|$)|\s+(?:но|однако|зато)\s+|,\s*(?=(?:(?:я|он|она)\s+)?(?:не\s+)?(?:работ|использ|владе|зна|уме|изуч|планир|готов|име|вед|состав|контрол|обеспеч))|\s+и\s+(?=не\s)", re.I)


def normalize(text):
    text=" ".join(text.casefold().replace("ё", "е").split())
    text=re.sub(r"б[эе]кенд\w*|back[ -]?end","backend",text)
    return re.sub(r"высоконагруж\w*|high[ -]?load","highload",text)


def stem(word):
    word = normalize(word)
    if re.search(r"[a-z0-9+#]", word):
        return word.rstrip(".-")
    for suffix in SUFFIXES:
        if word.endswith(suffix) and len(word)-len(suffix) >= 3:
            word = word[:-len(suffix)]
            break
    if word.endswith("ок"):
        word = word[:-2]+"к"
    return word


def terms(text):
    return [stem(w) for w in re.findall(r"1[сc]|\d+(?:\.\d+)+|[а-яё]+|\.?[a-z][a-z0-9+#.-]*", normalize(text)) if w not in STOP and len(w)>1 and not re.match(r"важн|предпочтител|стабильн|своевременн|сильн",w)]


def matching(term, text):
    if re.search(r"[a-z0-9+#]", term):
        aliases = {"sql":["sql","ms sql","t-sql","mssql"],"rest api":["rest api","restful api"],"kubernetes":["kubernetes","k8s"]}.get(term,[term])
        return any(re.search(r"(?<!\w)"+re.escape(a)+r"(?!\w)",normalize(text)) for a in aliases)
    def related(t):
        common=0
        for a,b in zip(t,term):
            if a!=b:break
            common+=1
        return t==term or min(len(t),len(term))>=5 and (t.startswith(term) or term.startswith(t)) or common>=6
    return any(related(t) for t in terms(text))


def statements(text):
    start=0
    masked=re.sub(r"(?<=[^\s.!?;:])\n(?=[ \t]*[а-яёa-z])(?![ \t]*(?:не\b|нет\b|без\b|хочу\b|планирую\b|изучаю\b|знаю\b|владею\b|работаю\b|готов\b))"," ",text)
    for boundary in CLAUSE.finditer(masked):
        if boundary.start()>start:
            yield start,boundary.start(),text[start:boundary.start()]
        start=boundary.end()
    if start<len(text):
        yield start,len(text),text[start:]


def proof_verdict(requirement,status,quotes,semantic=False):
    if status=="unknown": return True,None
    alternatives=re.split(r"\s+или\s+",requirement,flags=re.I)
    if len(alternatives)>1:
        results=[proof_verdict(p,status,quotes,semantic)[0] for p in alternatives]
        return (all(results) if status=="not_met" else any(results)),"not_relevant"
    wanted=[normalize(requirement)] if normalize(requirement)=="rest api" else list(dict.fromkeys(terms(requirement)))
    if not wanted: return False,"ambiguous_requirement"
    positive,negative,learning,intentions=set(),set(),set(),set()
    for quote in quotes:
        for _,_,clause in statements(quote):
            if MISSING.search(clause): continue
            matched={i for i,t in enumerate(wanted) if matching(t,clause)}
            if INTENT.search(clause): intentions.update(matched)
            elif NEGATIVE.search(clause): negative.update(matched)
            elif LEARNING.search(clause): learning.update(matched)
            else: positive.update(matched)
    if positive&negative: return False,"contradictory"
    if status=="not_met": return bool(negative),"not_relevant"
    relevant=[c for q in quotes for _,_,c in statements(q) if all(matching(t,c) for t in wanted)]
    if status=="met" and not re.search(r"заяв\w*|запрос\w*",requirement,re.I) and relevant and all(re.search(r"(?:заяв\w*|запрос\w*)[^.;]{0,80}(?:на|для)\s",q,re.I) for q in relevant):
        return False,"not_relevant"
    if status=="met" and not re.search(r"журнал\w*|документ\w*",requirement,re.I) and relevant and all(re.search(r"(?:веден\w*|веду)\s+журнал\w*",q,re.I) for q in relevant):
        return False,"not_relevant"
    for qualifier,pattern in ((r"коммерческ\w*",r"коммерческ\w*|оплачиваем\w*"),(r"самостоятельн\w*",r"самостоятельн\w*|лично")):
        if status=="met" and re.search(qualifier,requirement,re.I) and not any(re.search(pattern,q,re.I) for q in quotes):
            return False,"not_relevant"
    if semantic and any(re.search(r"[a-z0-9+#]",term) and not any(matching(term,q) for q in quotes) for term in wanted):return False,"not_relevant"
    if status=="met": return (bool(positive) if semantic else len(positive)==len(wanted)) and not negative and not learning,"future_intent" if intentions else "not_relevant"
    if not semantic and sum(bool(re.search(r"[а-я]",t)) for t in wanted)>=2 and not learning and len(positive)<min(2,len(wanted)):return False,"not_relevant"
    return bool(positive|learning) and not negative,"future_intent" if intentions else "not_relevant"


def experience_constraint(text):
    text=normalize(text)
    for word,value in {"одного":"1","двух":"2","трех":"3","четырех":"4","пяти":"5"}.items():
        text=re.sub(r"\b"+word+r"\b",value,text)
    text=re.sub(r"от\s+(\d+(?:[.,]\d+)?)\s+до\s+(\d+(?:[.,]\d+)?)",r"\1–\2",text)
    match=re.search(r"(?<![\d.,])(\d+(?:[.,]\d+)?)\s*(?:[-–—]\s*(\d+(?:[.,]\d+)?)\s*)?(лет|года?|years?|месяц\w*|months?)\b",text)
    if not match:return None
    scale=12 if re.fullmatch(r"лет|года?|years?",match[3]) else 1
    lo=float(match[1].replace(",","."))*scale
    if lo!=int(lo): return {"ambiguous":True}
    lo=int(lo)
    if not match[2] and scale==12:
        more=re.match(r"\s*[,и]?\s*(\d+)\s*месяц\w*",text[match.end():])
        if more:lo+=int(more[1])
    if match[2]:
        hi=float(match[2].replace(",","."))*scale
        if hi!=int(hi) or hi<lo:return {"ambiguous":True}
        return {"minimum":lo,"maximum":int(hi),"min_inclusive":True,"max_inclusive":True}
    before=text[:match.start()]
    if re.search(r"(?:не\s+(?:более|больше)|максимум)\s*$",before):return {"maximum":lo,"max_inclusive":True}
    if re.search(r"не\s+(?:менее|меньше)\s*$",before):return {"minimum":lo,"min_inclusive":True}
    if re.search(r"(?:до|менее|меньше)\s*$",before):return {"maximum":lo,"max_inclusive":False}
    return {"minimum":lo,"min_inclusive":not bool(re.search(r"(?<!не )(?<!не  )(?:более|свыше|больше)\s*$",before))}

EDUCATION=re.compile(r"образован|высше|бакалавр|магистр|специалитет|bachelor|master|средне|колледж|техникум|университет|институт|аспирант|mba|диплом|квалификац",re.I)
COMPLETED=re.compile(r"окончил|окончила|окончен|завершил|завершила|завершен|получил|получила|получен|диплом|квалификац|бакалавр|магистр|специалитет|bachelor|master|mba",re.I)

def education_met_supported(requirement,quotes):
    clauses=[c for q in quotes for _,_,c in statements(q) if EDUCATION.search(c)]
    if not clauses or any(INTENT.search(c) or NEGATIVE.search(c) or LEARNING.search(c) for c in clauses):return False
    value=" ".join(clauses)
    if not COMPLETED.search(value):return False
    for level in (r"магистр|master",r"бакалавр|bachelor",r"mba"):
        if re.search(level,requirement,re.I) and not re.search(level,value,re.I):return False
    if re.search(r"высше",requirement,re.I) and not re.search(r"высше|бакалавр|магистр|специалитет|bachelor|master",value,re.I):return False
    requirement=re.sub(r"по\s+направлен\w*|по\s+специальност\w*"," ",requirement,flags=re.I)
    specific=re.sub(r"образован\w*|высше\w*|бакалавр\w*|магистр\w*|специалитет|bachelor|master|средне\w*|диплом\w*|окончен\w*|получен\w*", " ",requirement,flags=re.I)
    return all(matching(t," ".join(quotes)) for t in terms(specific))


def valid_semantic_review(review,status,evidence,requirement=""):
    if not isinstance(review,dict) or review.get("method")!="focused-model-review-v1":return False
    if status not in {"met","partial"} or review.get("status") not in {"met","partial"} or not review.get("object_matches"):return False
    if status=="met" and (review["status"]!="met" or not review.get("action_matches") or not review.get("responsibility_matches")):return False
    ids=review.get("evidence",[])
    if not ids or not set(ids)<={e.get("block_id") for e in evidence}:return False
    supported=review.get("supported_text","")
    if supported and requirement and not proof_verdict(requirement,review["status"],[supported],True)[0]:return False
    return (review["status"]!="partial" or bool(supported)) and (not supported or any(supported in e["quote"] for e in evidence if e.get("block_id") in ids))


def request_participation(requirement,quotes):
    """An administrative part of work, never proof of its full execution."""
    if re.search(r"заяв\w*|запрос\w*|самостоятельн\w*|лично|выполн\w*|исполн\w*|проведен\w*|осуществ\w*",requirement,re.I):return None
    wanted=list(dict.fromkeys(terms(requirement)))
    if len(wanted)<2:return None
    for quote in quotes:
        for _,_,clause in statements(quote):
            if (re.search(r"(?:заяв\w*|запрос\w*)[^.;]{0,80}(?:на|для)\s",clause,re.I)
                    and all(matching(t,clause) for t in wanted)
                    and not (NEGATIVE.search(clause) or INTENT.search(clause) or LEARNING.search(clause))):
                return clause.strip()
    return None
