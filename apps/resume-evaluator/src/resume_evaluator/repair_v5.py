"""Recover direct assertions from the same document, without invented facts."""
import re
from resume_evaluator.document_proof import source_blocks
from resume_evaluator.proof_policy import terms, matching, experience_constraint
from resume_evaluator.policy_v5 import assertion_proof, education_proof, scope_matches


def source_evidence(source, offset=0):
    return [{"quote": b['text'], 'start': b['start']-offset, 'end': b['end']-offset,
             'block_id': b['id'], 'section': b['section'],
             **({'page': b['page']} if 'page' in b else {})} for b in source_blocks(source, offset)]


def repair_assertion(criterion, assessment, source, evidence, offset=0):
    requirement, category = criterion['requirement'], criterion['category']
    status = (assessment or {}).get('status', 'unknown')
    candidates = source_evidence(source, offset)
    if category in {'keyword','additional'}:
        if status == 'unknown' or not evidence:
            return status, evidence, None
        # Repair a mistaken polarity; never replace an invalid/foreign citation
        # or silently promote a model unknown through global keyword lookup.
        candidates = []
    if category == 'experience' and experience_constraint(requirement):
        # Bare years need an actual professional anchor in a work record.
        candidates = [e for e in candidates if not re.search(r'образован|навык|обо мне', e['section'], re.I)
                      and scope_matches(requirement, criterion.get('experience_scope'), e['quote'])]
        combined = {(e['start'], e['end']): e for e in [*evidence, *candidates]}
        return status, list(combined.values())[:96], None
    proof = education_proof if category == 'education' else assertion_proof
    condition = criterion['condition']
    if condition['operator'] == 'ambiguous':
        return 'unknown', evidence, 'ambiguous_requirement'
    # Stop a model's negative conclusion from surviving on a positive citation.
    if status == 'not_met' and not proof(requirement, status, [e['quote'] for e in evidence], condition):
        status = 'unknown'
    wanted = terms(requirement)
    ranked = sorted(candidates, key=lambda e: -sum(matching(t, e['quote']) for t in wanted))
    if category == 'education':
        ranked = [e for e in candidates if re.search(r'образован|бакалавр|магистр|диплом|колледж|университет|институт', e['section']+' '+e['quote'], re.I)]
    elif category == 'keyword':
        # Desired titles in an export header are not employment. A direct work
        # assertion or a declared skills section is needed for global recovery.
        ranked = [e for e in ranked if re.search(r'навык',e['section'],re.I)
                  or re.search(r'работа[лю]|назнач|должност|карьер|руковод|контрол|распредел|организац|веден|обеспеч|подготов|состав',e['quote'],re.I)]
    pool = {(e['start'],e['end']): e for e in [*evidence,*ranked[:16]]}
    positive = [e for e in pool.values() if proof(requirement,'met',[e['quote']],condition)]
    negative = [e for e in pool.values() if proof(requirement,'not_met',[e['quote']],condition)]
    if positive and negative:
        return 'unknown', positive[:2]+negative[:2], 'contradictory'
    if positive:
        return 'met', positive[:3], None
    if negative:
        return 'not_met', negative[:3], None
    if status in {'met','partial'} and proof(requirement,'partial',[e['quote'] for e in evidence],condition):
        return 'partial', evidence, None
    if category=='education' and proof(requirement,'partial',[e['quote'] for e in evidence],condition):
        return 'partial', evidence, None
    # Semantic review may still resolve a paraphrase, but its decision must be
    # independently checked against the original blocks by the caller.
    return 'unknown', evidence, 'unverified_evidence' if evidence else 'not_stated'
