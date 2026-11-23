"""Shared delimiter cases and preservation of the form's explicit array items."""
import json
import unittest
from pathlib import Path
from resume_evaluator.criteria_v5 import requirement_list_v5
from resume_evaluator.evidence_scoring import compile_criteria
from resume_evaluator.rank_models import ProfileRequest


class RequirementListTests(unittest.TestCase):
    def test_shared_separator_cases(self):
        cases = json.loads((Path(__file__).parents[1] / 'fixtures/requirement-list-v5.json').read_text())
        for case in cases:
            with self.subTest(text=case['text']):
                items = requirement_list_v5(case['text'])
                self.assertEqual(items, case['expected'])
                profile = ProfileRequest(id='test', position_name='Test', keywords=items)
                self.assertEqual([c['requirement'] for c in compile_criteria(profile)], list(dict.fromkeys(items)))

    def test_control_profile_has_thirteen_skills(self):
        import re
        plan = (Path(__file__).parents[2] / 'reports/resume-evaluation-improvement-plan.md').read_text()
        text = re.findall(r'```text\s*\n(.*?)\n```', plan, re.S)[3]
        profile = ProfileRequest(id='test', position_name='Test', keywords=requirement_list_v5(text))
        self.assertEqual(len(compile_criteria(profile)), 13)
