"""Stable source ranges. References resolve to original text, never model prose."""
import re

EXTRACTOR_VERSION="document-blocks-v2"
SECTION=re.compile(r"^(?:опыт работы|образование|навыки|ключевые навыки|дополнительное образование|достижения|обо мне|желаемая должность)\b",re.I)
DATE=re.compile(r"^(?:(?:январ|феврал|март|апрел|ма[йя]|июн|июл|август|сентябр|октябр|ноябр|декабр)\w*\s+)?(?:19|20)\d{2}\s*[-–—]",re.I)

def source_blocks(text,start=0,maximum=800,page_start=1):
    result=[];begin=0;section="document"
    for line in re.finditer(r"[^\n]*(?:\n|$)",text):
        if not line[0]:continue
        heading=bool(SECTION.search(line[0].strip()) or DATE.search(line[0].strip())
                     or re.match(r"\s*[-–—•●▪]\s+",line[0]) or not line[0].strip())
        if line.start()>begin and (heading or line.end()-begin>maximum):
            append_blocks(result,text,begin,line.start(),start,section,maximum)
            begin=line.start()
        if SECTION.search(line[0].strip()):section=line[0].strip()[:80]
    if begin<len(text):append_blocks(result,text,begin,len(text),start,section,maximum)
    for block in result:
        if "page" in block:block["page"]+=page_start-1
        elif page_start>1:block["page"]=page_start
    return result

def append_blocks(result,text,begin,end,offset,section,maximum):
    while begin<end:
        stop=min(end,begin+maximum)
        if stop<end:
            boundary=max(text.rfind("\n",begin+maximum//2,stop),text.rfind(" ",begin+maximum//2,stop))
            if boundary>begin:stop=boundary+1
        result.append({"id":f"b{offset+begin}","start":offset+begin,"end":offset+stop,"section":section,**({"page":text.count("\f",0,begin+len(text[begin:stop])-len(text[begin:stop].lstrip()))+1} if "\f" in text else {}),"text":text[begin:stop]})
        begin=stop

def resolve_references(parsed,blocks,offset=0):
    by_id={b["id"]:b for b in blocks}
    for key in ("assessments","stop_factors"):
        for entry in parsed[key]:
            refs=entry["evidence"]
            if refs and all(ref in by_id for ref in refs):
                chosen=[by_id[ref] for ref in dict.fromkeys(refs)]
                entry["evidence"]=[b["text"] for b in chosen]
                entry["_verified_evidence"]=[{"quote":b["text"],"start":b["start"]-offset,"end":b["end"]-offset,"block_id":b["id"],"section":b["section"],**({"page":b["page"]} if "page" in b else {})} for b in chosen]
    return parsed

def private_text(text,values=(),keep_location=False):
    for value in values:
        if value and len(value)>2:
            text=re.sub(re.escape(value),lambda m:" "*len(m[0]),text,flags=re.I)
    text=re.sub(r"[\w.+-]+@[\w.-]+\.[a-z]{2,}",lambda m:" "*len(m[0]),text,flags=re.I)
    text=re.sub(r"(?<!\d)(?:\+7|8)[ ()-]*(?:\d[ ()-]*){10}(?!\d)",lambda m:" "*len(m[0]),text)
    if not keep_location:
        text=re.sub(r"(?im)^(?:адрес|проживает|место проживания)\s*:[^\n]*",lambda m:" "*len(m[0]),text)
    return text
