"""Модель сравнивает критерии с цитатами; программа проверяет и считает балл."""

import json
import hashlib
from copy import deepcopy
import logging
import re
import time
from datetime import datetime
from zoneinfo import ZoneInfo
from typing import Optional

from resume_evaluator.config import settings
from resume_evaluator.evidence_scoring import compile_criteria, verify_and_score, quote_evidence
from resume_evaluator.logging_config import get_logger, log_event
from resume_evaluator.ollama_client import (
    ask_ollama_chat, ModelUnavailable, ModelTimeout, ModelResponseError,
    DEFAULT_TIMEOUT, MODEL,
)
from resume_evaluator.rank_models import ProfileRequest, ModelRating
from resume_evaluator.additional_evidence import additional_evidence_verdict
from resume_evaluator.proof_policy import proof_verdict,terms,matching,experience_constraint
from resume_evaluator.document_proof import source_blocks,resolve_references,private_text,EXTRACTOR_VERSION
from resume_evaluator.prompt_v4 import SYSTEM as SYSTEM_V4
from resume_evaluator.evidence_scoring import verified_assessment_evidence, _assess_criterion,stop_supported
from resume_evaluator.policy_v5 import duration_scope


class ContextFitError(ValueError):
    """Запрос не помещается в контекст модели."""


logger = get_logger("resume_evaluator.scoring")
RATING_SCHEMA = ModelRating.model_json_schema()
MAX_ATTEMPTS = 2
PROMPT_VERSION = "evidence-v5-scoped-work-2"
EVIDENCE_RETRY_FEEDBACK = {"code": "unverified_evidence", "instruction":
    "Предыдущие ссылки не подтверждают требование. Рассмотри другие source_blocks "
    "и противоположные утверждения. Верни только id подходящих блоков. "
    "Если подтверждения нет, верни unknown с причиной."}
FORMAT_RETRY_FEEDBACK = {"code": "response_format", "instruction":
    "Предыдущий ответ нарушил формат или список id. Верни все поля схемы и каждый переданный id ровно один раз."}


def rating_schema_for(criteria_ids, stop_ids, blocks=None):
    """Constrain the grammar to this request; source validation remains mandatory."""
    schema = deepcopy(RATING_SCHEMA)
    for key, definition, identifiers in (("assessments", "CriterionAssessment", criteria_ids),
                                         ("stop_factors", "StopFactorAssessment", stop_ids)):
        identifiers = sorted(identifiers)
        schema["properties"][key].update(minItems=len(identifiers), maxItems=len(identifiers))
        if identifiers:
            schema["$defs"][definition]["properties"]["id"]["enum"] = identifiers
        if blocks:
            base=schema["$defs"][definition]
            base["properties"]["evidence"]["items"]={"type":"string","enum":[b["id"] for b in blocks]}
            branches=[]
            statuses=("unknown","met","partial","not_met") if key=="assessments" else ("unknown","triggered","not_triggered")
            for status in statuses:
                branch=deepcopy(base)
                branch["properties"]["status"]={"const":status,"type":"string"}
                branch["properties"]["unknown_reason"]=({"type":"string","enum":["not_stated","contradictory","not_relevant","unverified_evidence","future_intent","incomplete_document","ambiguous_requirement"]}
                    if status=="unknown" else {"type":"null"})
                if status!="unknown":branch["properties"]["evidence"]["minItems"]=1
                if key=="assessments":
                    branch["properties"]["partial_reason"]={"type":"string","enum":["duration","learning","missing_parts"]} if status=="partial" else {"type":"null"}
                branches.append(branch)
            schema["$defs"][definition]={"anyOf":branches}
    return schema


def estimate_tokens(text: str) -> int:
    cyrillic = sum(1 for char in text if '\u0400' <= char <= '\u04FF')
    return int(cyrillic / 2 + (len(text) - cyrillic) / 4)


def check_context_fits(prompt_tokens: int, max_response_tokens: int, num_ctx: int,
                       usage_ratio: float | None = None) -> tuple[bool, int]:
    available = int(num_ctx * (settings.OLLAMA_CONTEXT_USAGE_RATIO if usage_ratio is None else usage_ratio))
    return prompt_tokens + max_response_tokens <= available, available


def truncate_resume_text(resume_text: str, target_tokens: int) -> str:
    tokens = estimate_tokens(resume_text)
    if tokens <= target_tokens:
        return resume_text
    return resume_text[:max(0, int(len(resume_text) * target_tokens / tokens * .95))]


def build_ranking_prompt(resume_text: str, profile: ProfileRequest,
                         cluster_requirements: str = "", *, assessment_date=None, fragment=None,
                         criteria_ids=None, stop_ids=None, retry_feedback=None,use_references=False,private_values=()) -> tuple[str, str]:
    system = SYSTEM_V4
    criteria = [{key: criterion[key] for key in ("id", "category", "requirement", "condition")}
                for criterion in compile_criteria(profile, cluster_requirements)]
    for entry in criteria:
        full=next(c for c in compile_criteria(profile,cluster_requirements) if c["id"]==entry["id"])
        if "experience_scope" in full:entry["experience_scope"]=full["experience_scope"]
    # Preference affects deterministic weights, never whether a fact is true.
    # Keep the original requirement in compiled/saved criteria and expose only
    # its factual clause to the model.
    for criterion in criteria:
        criterion["requirement"] = re.sub(r"^плюс\s+", "", criterion["requirement"], flags=re.I)
    stops = [{"id": f"stop:{index}", "requirement": text} for index, text in enumerate(profile.stop_factors)]
    if criteria_ids is not None:
        criteria = [c for c in criteria if c["id"] in criteria_ids]
    if stop_ids is not None:
        stops = [c for c in stops if c["id"] in stop_ids]
    # Stable system + source prefix lets Ollama reuse prefill across profiles and
    # retries. The complete source remains JSON data, with original offsets.
    payload = {"resume_text": resume_text, "assessment_date": assessment_date,
        "fragment": fragment or {"index": 1, "count": 1, "start": 0},
        "position_name": profile.position_name, "criteria": criteria, "stop_factors": stops}
    if use_references:
        blocks=source_blocks(resume_text,(fragment or {}).get("start",0),page_start=(fragment or {}).get("page_start",1))
        keep_location=bool(re.search(r"офис|переезд|прожив|город|место\s+работ",user_requirements(profile,cluster_requirements),re.I))
        blocks=[{**b,"text":private_text(b["text"],private_values,keep_location)} for b in blocks]
        # Retrieval is a hint, never evidence or a status. Include the whole
        # document and both polarities; only the model selects source IDs.
        for item in criteria+stops:
            wanted=list(set(terms(item["requirement"])))
            ranked=sorted(((sum(matching(t,b["text"]) for t in wanted),b) for b in blocks),key=lambda pair:(-pair[0],pair[1]["start"]))
            item["candidate_block_ids"]=[b["id"] for score,b in ranked[:3] if score]
        payload={"source_blocks":blocks,**{k:v for k,v in payload.items() if k!="resume_text"}}
    if retry_feedback:
        payload["retry_feedback"] = retry_feedback
    user = json.dumps(payload, ensure_ascii=False, separators=(",", ":"))
    return system, user


def clean_json_response(response: str) -> str:
    response = re.sub(r"^```(?:json)?\s*", "", response.strip())
    response = re.sub(r"\s*```$", "", response)
    start, end = response.find("{"), response.rfind("}") + 1
    return response[start:end] if start >= 0 and end > start else response


def parse_ranking_response(response: str) -> Optional[dict]:
    try:
        return ModelRating.model_validate(json.loads(clean_json_response(response))).model_dump()
    except (ValueError, TypeError):
        return None


def document_chunks(source, token_budget, cost=estimate_tokens):
    """Cover the entire source, retaining overlap and original Unicode offsets."""
    chunks, start = [], 0
    if token_budget <= 0:
        raise ContextFitError("Требования и схема не помещаются в контекст")
    while start < len(source) or not chunks:
        remainder = source[start:]
        fragment = truncate_resume_text(remainder, token_budget)
        while fragment and cost(fragment)>token_budget:
            fragment=fragment[:max(0,int(len(fragment)*.9))]
        if not fragment and remainder:
            raise ContextFitError("Недостаточно места для фрагмента резюме")
        end = start + len(fragment)
        if end < len(source):
            newline = source.rfind("\n", start + len(fragment) * 3 // 4, end)
            if newline >= 0:
                end = newline + 1
        chunks.append((start, end))
        if len(chunks) > 32:
            raise ContextFitError("Резюме превышает лимит 32 фрагментов; разделите документ")
        if end >= len(source):
            break
        start = max(start + 1, end - min(300, (end - start) // 5))
    return chunks


def merge_comparisons(parts, source):
    from resume_evaluator.evidence_scoring import quote_evidence
    result = {"assessments": [], "stop_factors": []}
    for key in result:
        groups = {}
        for parsed, start, end in parts:
            for entry in parsed[key]:
                item = dict(entry)
                verified = verified_assessment_evidence(source[start:end],item)
                if any(e is None for e in verified) or (not verified and item["status"] not in {"unknown"}):
                    item.update(status="unknown", unknown_reason="unverified_evidence")
                    verified = []
                item["_verified_evidence"] = [{**e, "start": e["start"] + start, "end": e["end"] + start} for e in verified]
                groups.setdefault(item["id"], []).append(item)
        for identifier, entries in groups.items():
            statuses = {e["status"] for e in entries} - {"unknown"}
            contradiction = ("not_met" in statuses and bool(statuses & {"met","partial"}) or {"triggered", "not_triggered"} <= statuses)
            order = ("not_met", "met", "partial") if key == "assessments" else ("triggered", "not_triggered")
            status = "unknown" if contradiction else next((s for s in order if s in statuses), "unknown")
            selected = entries if contradiction or status == "unknown" else [e for e in entries if e["status"] == status]
            evidence = {(e["start"], e["end"]): e for item in selected for e in item["_verified_evidence"]}
            if len(evidence) > 96:
                raise ContextFitError("Слишком много подтверждений по одному требованию")
            reason = "contradictory" if contradiction else next((e.get("unknown_reason") for e in selected if e.get("unknown_reason") not in (None, "not_stated")), "not_stated")
            result[key].append({"id": identifier, "status": status, "evidence": [e["quote"] for e in evidence.values()],
                "_verified_evidence": list(evidence.values()),"_retried":any(e.get("_retried") for e in entries), "unknown_reason": reason if status == "unknown" else None,
                **({"partial_reason": next(iter({e.get("partial_reason") for e in selected}), "missing_parts")
                    if len({e.get("partial_reason") for e in selected}) == 1 else "missing_parts"} if status == "partial" else {})})
    return result


def _rank_profile_batch(resume_text: str, profile: ProfileRequest, cluster_requirements: str = "",
                 timeout: float | None = None, *, job_id: str = "", assessment_date=None,
                 criterion_ids=None,stop_ids=None,private_values=(),return_parts=False,telemetry=None,source_ranges=None,max_attempts=MAX_ATTEMPTS) -> dict:
    from resume_evaluator.readiness import check_model_cancelled
    assessment_date = assessment_date or datetime.now(ZoneInfo("Europe/Moscow")).date().isoformat()
    num_ctx, max_tokens = settings.OLLAMA_NUM_CTX, settings.OLLAMA_MAX_TOKENS
    system, fixed = build_ranking_prompt("", profile, cluster_requirements, assessment_date=assessment_date,criteria_ids=criterion_ids,stop_ids=stop_ids,use_references=True)
    available = int(num_ctx * settings.OLLAMA_CONTEXT_USAGE_RATIO)
    retry_reserve = max(estimate_tokens(json.dumps({"retry_feedback": feedback}, ensure_ascii=False, separators=(",", ":")))
                        for feedback in (EVIDENCE_RETRY_FEEDBACK, FORMAT_RETRY_FEEDBACK)) + 64
    budget = available - estimate_tokens(system) - estimate_tokens(fixed) - max_tokens - retry_reserve
    fixed_payload=json.loads(fixed)
    budget-=32*(len(fixed_payload["criteria"])+len(fixed_payload["stop_factors"]))
    chunks = document_chunks(resume_text, budget,cost=lambda text:estimate_tokens(json.dumps(source_blocks(text),ensure_ascii=False,separators=(",",":"))))
    if source_ranges:
        chunks=[(a,b) for a,b in chunks if any(a<y and b>x for x,y in source_ranges)][:1]
    criteria_by_id = {c["id"]:c for c in compile_criteria(profile, cluster_requirements)}
    expected = set(criteria_by_id) if criterion_ids is None else set(criterion_ids)
    expected_stops = {f"stop:{i}" for i in range(len(profile.stop_factors))} if stop_ids is None else set(stop_ids)
    deadline = time.monotonic() + (DEFAULT_TIMEOUT if timeout is None else timeout)
    parts = []
    for index, (start, end) in enumerate(chunks):
        check_model_cancelled()
        system_prompt, user_prompt = build_ranking_prompt(resume_text[start:end], profile, cluster_requirements,
            assessment_date=assessment_date, fragment={"index": index + 1, "count": len(chunks), "start": start,"page_start":resume_text.count("\f",0,start)+1},criteria_ids=expected,stop_ids=expected_stops,use_references=True,private_values=private_values)
        blocks=source_blocks(resume_text[start:end],start,page_start=resume_text.count("\f",0,start)+1)
        if not check_context_fits(estimate_tokens(system_prompt) + estimate_tokens(user_prompt), max_tokens, num_ctx)[0]:
            raise ContextFitError("Фрагмент не помещается в контекст модели")
        last_exception = None
        pending, pending_stops = expected, expected_stops
        original = None
        retry_feedback = None
        for attempt in range(1, max_attempts + 1):
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise ModelTimeout("Истекло общее время обработки профиля") from last_exception
            try:
                failure_stage = "request"
                if retry_feedback:
                    system_prompt, user_prompt = build_ranking_prompt(resume_text[start:end], profile, cluster_requirements,
                        assessment_date=assessment_date, fragment={"index": index + 1, "count": len(chunks), "start": start,"page_start":resume_text.count("\f",0,start)+1},
                        criteria_ids=pending, stop_ids=pending_stops, retry_feedback=retry_feedback,use_references=True,private_values=private_values)
                if not check_context_fits(estimate_tokens(system_prompt) + estimate_tokens(user_prompt), max_tokens, num_ctx)[0]:
                    raise ContextFitError("Повторный запрос не помещается в контекст модели")
                response = ask_ollama_chat(system_prompt=system_prompt, user_prompt=user_prompt,
                    num_ctx=num_ctx, max_tokens=max_tokens, temperature=0.0,
                    timeout=min(DEFAULT_TIMEOUT, remaining), json_schema=rating_schema_for(pending, pending_stops,blocks),
                    job_id=job_id, profile_id=profile.id, attempt=attempt)
                if telemetry is not None:
                    telemetry.append({k:response.get(k) for k in ("prompt_tokens","generated_tokens","total_time_sec","done_reason")})
                if response.get("done_reason")=="length":
                    raise ModelResponseError("Ответ модели оборван лимитом токенов")
                failure_stage = "response_format"
                parsed = parse_ranking_response(response["response"])
                if parsed is None:
                    raise ModelResponseError("Некорректный формат сравнений")
                parsed=resolve_references(parsed,blocks,start)
                for key, ids in (("assessments", pending), ("stop_factors", pending_stops)):
                    failure_stage = "criterion_ids"
                    actual = [e["id"] for e in parsed[key]]
                    if set(actual) != ids or len(actual) != len(ids):
                        raise ModelResponseError("Пропущенные, повторные или чужие идентификаторы")
                invalid={"assessments":set(),"stop_factors":set()}
                for entry in parsed["assessments"]:
                    if entry["status"]=="unknown":continue
                    checked=_assess_criterion(criteria_by_id[entry["id"]],entry,resume_text[start:end],assessment_date,source_offset=start)
                    if checked["status"]=="unknown" and checked.get("unknown_reason")!="future_intent":
                        criterion=criteria_by_id[entry["id"]]
                        citations=entry.get("_verified_evidence",[])
                        paraphrase=(criterion["category"] in {"keyword","additional"} and entry["status"] in {"met","partial"}
                            and citations and all(e.get("block_id") for e in citations)
                            and re.search(r"[а-я]"," ".join(terms(criterion["requirement"])))
                            and proof_verdict(criterion["requirement"],"partial",[e["quote"] for e in citations],True)[0])
                        # A focused meaning review below is more useful than
                        # repeating the same broad comparison for this case.
                        if not paraphrase:invalid["assessments"].add(entry["id"])
                for entry in parsed["stop_factors"]:
                    if entry["status"]=="unknown":continue
                    citations=verified_assessment_evidence(resume_text[start:end],entry)
                    if not citations or not stop_supported(profile.stop_factors[int(entry["id"].split(":")[1])],entry["status"],citations,resume_text[start:end],duration_scope(profile.stop_factors[int(entry["id"].split(":")[1])],profile)):
                        invalid["stop_factors"].add(entry["id"])
                if any(invalid.values()) and attempt < max_attempts:
                    original = parsed
                    pending, pending_stops = invalid["assessments"], invalid["stop_factors"]
                    retry_feedback = EVIDENCE_RETRY_FEEDBACK
                    log_event(logger, logging.WARNING, "profile_evidence_retry", job_id=job_id,
                              profile_id=profile.id, attempt=attempt, max_attempts=MAX_ATTEMPTS)
                    continue
                if original is not None:
                    for key in ("assessments", "stop_factors"):
                        replacements = {e["id"]: e for e in parsed[key]}
                        parsed[key] = [replacements.get(e["id"], e) for e in original[key]]
                if attempt>1:
                    for key,ids in (("assessments",pending),("stop_factors",pending_stops)):
                        for entry in parsed[key]:
                            if entry["id"] in ids:entry["_retried"]=True
                parts.append((parsed, start, end))
                break
            except (ModelUnavailable, ModelTimeout, ModelResponseError) as error:
                last_exception = error
                if isinstance(error, ModelResponseError):
                    retry_feedback = {**FORMAT_RETRY_FEEDBACK, "code": failure_stage}
                log_event(logger, logging.WARNING, "profile_attempt_failed", job_id=job_id,
                          profile_id=profile.id, attempt=attempt, max_attempts=MAX_ATTEMPTS,
                          failure_stage=failure_stage)
                if attempt == max_attempts:
                    selected=[("criterion",i) for i in sorted(expected)]+[("stop",i) for i in sorted(expected_stops)]
                    if isinstance(error,ModelResponseError) and failure_stage in {"criterion_ids","response_format"} and len(selected)>1:
                        # Small models sometimes repeat an allowed ID. Narrow
                        # the request instead of restarting the whole document.
                        log_event(logger,logging.WARNING,"profile_batch_split",job_id=job_id,profile_id=profile.id,conditions=len(selected))
                        recovered=[]
                        middle=len(selected)//2
                        for group in (selected[:middle],selected[middle:]):
                            remaining=deadline-time.monotonic()
                            if remaining<=0:raise ModelTimeout("Истекло общее время обработки профиля") from error
                            recovered.extend(_rank_profile_batch(resume_text,profile,cluster_requirements,timeout=remaining,
                                job_id=job_id,assessment_date=assessment_date,
                                criterion_ids={i for kind,i in group if kind=="criterion"},stop_ids={i for kind,i in group if kind=="stop"},
                                private_values=private_values,return_parts=True,telemetry=telemetry,source_ranges=source_ranges,max_attempts=1))
                        if return_parts:return recovered
                        return verify_and_score(merge_comparisons(recovered,resume_text),resume_text,profile,cluster_requirements,
                            model=MODEL,assessment_date=assessment_date,context_truncated=False,context_chunks=len({(a,b) for _,a,b in recovered}))
                    raise
        check_model_cancelled()
    if time.monotonic() >= deadline:
        raise ModelTimeout("Истекло общее время обработки профиля")
    if return_parts:return parts
    merged = merge_comparisons(parts, resume_text)
    try:
        return verify_and_score(merged, resume_text, profile, cluster_requirements, model=MODEL,
            assessment_date=assessment_date, context_truncated=False, context_chunks=len(chunks))
    except ValueError as error:
        raise ModelResponseError(str(error)) from error


def user_requirements(profile,comment):
    return " ".join([profile.experience or "",profile.education or "",profile.comment or "",comment,*profile.keywords,*profile.stop_factors])


def rank_profile(resume_text,profile,cluster_requirements="",timeout=None,*,job_id="",assessment_date=None,private_values=()):
    assessment_date=assessment_date or datetime.now(ZoneInfo("Europe/Moscow")).date().isoformat()
    deadline=time.monotonic()+(DEFAULT_TIMEOUT if timeout is None else timeout)
    items=[("criterion",c["id"]) for c in compile_criteria(profile,cluster_requirements)]+[("stop",f"stop:{i}") for i in range(len(profile.stop_factors))]
    parts=[];maximum_chunks=1;telemetry=[]
    batch_size=max(1,min(8,settings.OLLAMA_MAX_TOKENS//160))
    for offset in range(0,len(items),batch_size):
        remaining=deadline-time.monotonic()
        if remaining<=0:raise ModelTimeout("Истекло общее время обработки профиля")
        selected=items[offset:offset+batch_size]
        batch=_rank_profile_batch(resume_text,profile,cluster_requirements,timeout=remaining,job_id=job_id,assessment_date=assessment_date,
            criterion_ids={i for kind,i in selected if kind=="criterion"},stop_ids={i for kind,i in selected if kind=="stop"},private_values=private_values,return_parts=True,telemetry=telemetry)
        maximum_chunks=max(maximum_chunks,min(32,len({(a,b) for _,a,b in batch})));parts.extend(batch)
    merged=merge_comparisons(parts,resume_text)
    # One bounded retrieval pass for a plausible missed assertion. A plain
    # absence with no candidate block costs no extra request. Contradictions
    # remain unknown; selecting a convenient positive cannot erase a denial.
    compiled={c["id"]:c for c in compile_criteria(profile,cluster_requirements)}
    missed=[];missed_stops=[];ranges=[]
    blocks=source_blocks(resume_text)
    candidates=[(entry,compiled[entry["id"]]["requirement"],missed) for entry in merged["assessments"]]
    candidates.extend((entry,profile.stop_factors[int(entry["id"].split(":")[1])],missed_stops) for entry in merged["stop_factors"])
    for entry,requirement,selected in candidates:
        if entry.get("_retried") or entry["status"]!="unknown" or entry.get("unknown_reason") not in {"not_stated","incomplete_document"}:continue
        core=re.sub(r"^(?:нет|отсутствие|отказ\s+от)\s*","",requirement,flags=re.I)
        wanted=list(set(terms(core)))
        matches=[block for block in blocks if wanted and sum(matching(t,block["text"]) for t in wanted)>len(wanted)/2]
        if matches:
            selected.append(entry["id"]);ranges.extend((block["start"],block["end"]) for block in matches)
        if len(missed)+len(missed_stops)>=batch_size:break
    remaining=deadline-time.monotonic()
    if (missed or missed_stops) and remaining>5:
        try:
            retry_parts=_rank_profile_batch(resume_text,profile,cluster_requirements,timeout=remaining,job_id=job_id,assessment_date=assessment_date,
                criterion_ids=set(missed),stop_ids=set(missed_stops),private_values=private_values,return_parts=True,telemetry=telemetry,source_ranges=ranges,max_attempts=1)
            retried=merge_comparisons(retry_parts,resume_text)
            for key in ("assessments","stop_factors"):
                replacements={entry["id"]:entry for entry in retried[key]}
                merged[key]=[replacements.get(entry["id"],entry) for entry in merged[key]]
        except (ModelUnavailable,ModelTimeout,ModelResponseError,ContextFitError):
            log_event(logger,logging.WARNING,"profile_optional_search_failed",job_id=job_id,profile_id=profile.id)
    # Only rejected paraphrases need another semantic judgement. Qualifiers,
    # source ranges, polarity and numeric checks cannot be waived by it.
    from resume_evaluator.semantic_review import review_duties,SYSTEM as REVIEW_SYSTEM
    review_items=[]
    for entry in merged["assessments"]:
        criterion=compiled[entry["id"]]
        if experience_constraint(criterion["requirement"]) or entry["status"] not in {"met","partial","not_met","unknown"} or criterion["category"] not in {"keyword","additional","experience"}:continue
        if not re.search(r"[а-я]"," ".join(terms(criterion["requirement"]))):continue
        citations=entry.get("_verified_evidence",[])
        if not citations or not all(e.get("block_id") for e in citations):continue
        checked=_assess_criterion(criterion,entry,resume_text,assessment_date)
        if checked["status"]!="unknown" and not (checked["status"]=="partial" and checked.get("partial_reason")=="missing_parts"):continue
        if not any(proof_verdict(criterion["requirement"],s,[e["quote"] for e in citations],True)[0] for s in (entry["status"],"partial")):continue
        # The second opinion may search other candidate blocks. The resulting
        # source is selected explicitly by ID, never replaced by string find.
        wanted=terms(criterion["requirement"])
        ranked=sorted(blocks,key=lambda block:-(sum(matching(t,block["text"]) for t in wanted)+2*bool(wanted and matching(wanted[-1],block["text"]))))
        expanded={(e["start"],e["end"]):e for e in citations}
        for block in ranked[:3]:
            expanded[(block["start"],block["end"]) ]={"quote":block["text"],"start":block["start"],"end":block["end"],"block_id":block["id"],"section":block["section"],**({"page":block["page"]} if "page" in block else {})}
        review_items.append({"entry":{**entry,"_verified_evidence":sorted(expanded.values(),key=lambda e:-(sum(matching(t,e["quote"]) for t in wanted)+2*bool(wanted and matching(wanted[-1],e["quote"]))))},"requirement":criterion["requirement"],"experience_scope":criterion.get("experience_scope")})
        if len(review_items)>=batch_size:break
    for item in review_items[:8]:
        remaining=deadline-time.monotonic()
        if remaining<=5:break
        try:
            reviewed,response=review_duties([item],timeout=remaining,num_ctx=settings.OLLAMA_NUM_CTX,
                max_tokens=min(768,settings.OLLAMA_MAX_TOKENS),private_values=private_values,job_id=job_id,profile_id=profile.id)
            if response:telemetry.append({key:response.get(key) for key in ("prompt_tokens","generated_tokens","total_time_sec","done_reason")})
            for entry in merged["assessments"]:
                if entry["id"] in reviewed:
                    entry["semantic_review"]=reviewed[entry["id"]]
                    selected=[e for e in item["entry"]["_verified_evidence"] if e["block_id"] in reviewed[entry["id"]]["evidence"]]
                    entry.update(evidence=[e["quote"] for e in selected],_verified_evidence=selected,
                        status=reviewed[entry["id"]]["status"],partial_reason="missing_parts" if reviewed[entry["id"]]["status"]=="partial" else None)
        except (ModelUnavailable,ModelTimeout,ModelResponseError):
            log_event(logger,logging.WARNING,"profile_semantic_review_failed",job_id=job_id,profile_id=profile.id)
    result=verify_and_score(merged,resume_text,profile,cluster_requirements,model=MODEL,assessment_date=assessment_date,context_chunks=maximum_chunks)
    from resume_evaluator.readiness import model_digest,model_quantization
    result["details"]["run_metadata"]={"prompt_version":PROMPT_VERSION,"prompt_sha256":hashlib.sha256((SYSTEM_V4+REVIEW_SYSTEM).encode()).hexdigest(),
        "extractor_version":EXTRACTOR_VERSION,"model_digest":model_digest(),"quantization":model_quantization(),"temperature":0,
        "num_ctx":settings.OLLAMA_NUM_CTX,"max_tokens":settings.OLLAMA_MAX_TOKENS,"requests":telemetry}
    return result
