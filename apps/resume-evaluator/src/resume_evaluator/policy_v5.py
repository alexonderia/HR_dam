"""Scoped assertions and professional evidence gate, mirrored in contracts."""
import re
from resume_evaluator.proof_policy import (terms, matching, proof_verdict, statements,
    NEGATIVE, INTENT, LEARNING, EDUCATION, education_met_supported, experience_constraint)
from resume_evaluator.criteria_v5 import condition_v5

GENERAL = ('стаж', 'общ', 'коммерческ', 'миним', 'максим', 'сфер', 'недостат',
           'трех', 'двух', 'четыр', 'пят', 'одног', 'профессиональн', 'профильн')


def duration_terms(requirement):
    return [t for t in terms(requirement) if not t.startswith(GENERAL)]


def duration_scope(requirement, profile):
    if not experience_constraint(requirement) or duration_terms(requirement):
        return None
    return {'role': profile.position_name, 'anchors': list(dict.fromkeys(profile.keywords))}


def positive_anchor(wanted, text):
    positive, negative = set(), set()
    for _,_,clause in statements(text):
        found={i for i,t in enumerate(wanted) if matching(t,clause)}
        if NEGATIVE.search(clause):negative.update(found)
        elif not (INTENT.search(clause) or LEARNING.search(clause)):positive.update(found)
    return bool(wanted) and len(positive)==len(wanted) and not negative


def scope_matches(requirement, scope, text):
    wanted = duration_terms(requirement)
    if wanted:
        condition = condition_v5(requirement)
        return any(positive_anchor(duration_terms(p),text) for p in condition['parts']) if condition['operator']=='any' else positive_anchor(wanted,text)
    if not scope:
        return False
    role=re.sub(r'\bdeveloper\b','разработчик',scope['role'],flags=re.I)
    condition=condition_v5(role)
    if any(positive_anchor(duration_terms(p),text) for p in condition['parts'] if condition['operator']=='any') or positive_anchor(duration_terms(role),text):
        return True
    # A single transferable tool (SQL at a transport company, for example)
    # is not proof of years in another profession. Require the full configured
    # professional stack, applied in the same job, when no role title matches.
    anchors=[a for a in scope['anchors'] if duration_terms(a)]
    return len(anchors)>=2 and all(assertion_proof(a,'met',[text]) for a in anchors) and bool(re.search(r'работ|разработ|выполня|использ|примен|руковод|контрол|организ',text,re.I))



def ambiguous_role_period(requirement, scope, context):
    if not re.search(r'нач(?:ал|инал)\w*[^.\n]{0,100}(?:карьер|работ)|затем[^.\n]{0,60}(?:назнач|стал)|недавно[^.\n]{0,60}(?:назнач|стал)', context, re.I):
        return False
    target = requirement if duration_terms(requirement) else (scope or {}).get('role', '')
    # A transport-sector period can include several roles. A named role cannot
    # inherit all years of the company when the source explicitly describes promotion.
    if re.search(r'руковод|начальник|бригадир|директор|мастер|менеджер|управлен', target, re.I):
        return True
    roles = re.findall(r'(?:затем[^.\n]{0,30}(?:назначен|стал)|недавно[^.\n]{0,30}(?:назначен|стал)|начал\s+(?:карьеру|работу))\s+([^.;\n]{3,90})', context, re.I)
    return any(scope_matches(target, None, role) for role in roles)


def assertion_proof(requirement, status, quotes, condition=None, semantic=False):
    condition = condition or condition_v5(requirement)
    if status == 'unknown':
        return True
    if status == 'partial' and re.search(r'самостоятельн|лично',requirement,re.I) and not any(re.search(r'самостоятельн|лично',q,re.I) for q in quotes):
        return False
    if condition['operator'] == 'ambiguous':
        return False
    if condition['operator'] == 'any':
        outcomes = [proof_verdict(part, status, quotes, semantic)[0] for part in condition['parts']]
        return all(outcomes) if status == 'not_met' else any(outcomes)
    if condition["operator"]=="all":
        outcomes=[proof_verdict(p,status,quotes,semantic)[0] for p in condition["parts"]]
        return all(outcomes) if status=="met" else any(outcomes)
    if status=="met" and not semantic:
        return any(proof_verdict(requirement,status,[clause],False)[0] for quote in quotes for _,_,clause in statements(quote))
    return proof_verdict(requirement, status, quotes, semantic)[0]


def education_proof(requirement, status, quotes, condition=None):
    condition = condition or condition_v5(requirement)
    if status == 'unknown':
        return True
    if condition['operator'] == 'ambiguous':
        return False
    parts = condition['parts'] if condition['operator'] == 'any' else [requirement]
    if status == 'met':
        return any(education_met_supported(part, quotes) for part in parts)
    relevant = [clause for q in quotes for _, _, clause in statements(q) if EDUCATION.search(clause)]
    if status == 'partial':
        return any(LEARNING.search(c) or re.search(r'учусь|обучаюсь|студент|неокончен|незакончен', c, re.I) for c in relevant)
    # Absence of a requested degree/field must be explicit and about that degree.
    def denied(part):
        wanted = duration_terms(re.sub(r'образован\w*|высше\w*|средне\w*|профессиональн\w*', '', part, flags=re.I))
        levels = r'высш|бакалавр|магистр' if re.search(r'высш|бакалавр|магистр', part, re.I) else r'средн|колледж|техникум'
        return any(NEGATIVE.search(c) and not INTENT.search(c)
                   and (all(matching(t, c) for t in wanted) if wanted else re.search(levels, c, re.I)) for c in relevant)
    return bool(parts) and all(denied(part) for part in parts)


def professional_basis(criteria):
    core = [c for c in criteria if not c['optional'] and c['category'] != 'education']
    supported = [c['id'] for c in core if c['status'] in {'met', 'partial'} and c['credit'] > 0]
    return {'status': 'confirmed' if supported else 'unconfirmed' if core else 'not_configured',
            'criteria_ids': supported}


def professional_context(requirement,scope,quotes,condition=None):
    """A shared generic action cannot substitute for a configured profession.

    Derive qualifiers from this profile's own keywords, rather than maintaining
    a dictionary of professions. This gate never creates a positive conclusion.
    """
    if not scope:return True
    condition=condition or condition_v5(requirement)
    if condition['operator'] in {'any','all'}:
        checks=[professional_context(p,scope,quotes,{'operator':'atomic','parts':[p]}) for p in condition['parts']]
        return any(checks) if condition['operator']=='any' else all(checks)
    qualifiers=[t for t in terms(requirement) if any(matching(t,a) for a in scope['anchors'])]
    return all(any(positive_anchor([t],q) for q in quotes) for t in qualifiers)
