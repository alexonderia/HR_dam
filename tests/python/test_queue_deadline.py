"""Queue lifetime and execution lifetime are independent and cannot be renewed."""
import time
import unittest
from datetime import datetime,timezone
from unittest.mock import patch
from processing_runtime.api import JobAPI
from processing_runtime.protocol import Job,ClosedJob,InvalidJob

class QueueDeadlineTests(unittest.TestCase):
    def api(self,now):
        return JobAPI('http://backend/internal/app',Job({'job_id':'job','attempt':1},'unused',now+86400))

    def test_progress_starts_execution_and_redelivery_cannot_extend_it(self):
        now=time.time();api=self.api(now)
        try:
            deadline=datetime.fromtimestamp(now+1800,timezone.utc).isoformat()
            with patch.object(api,'json_request',return_value={'accepted':True,'work_deadline':deadline}):api.progress()
            self.assertAlmostEqual(api.work_deadline,now+1800,places=4)
            with patch('processing_runtime.api.time.time',return_value=now+1801):
                with self.assertRaises(ClosedJob):api.check()
            changed=datetime.fromtimestamp(now+3600,timezone.utc).isoformat()
            with self.assertRaises(InvalidJob):api._read_work_deadline({'work_deadline':changed})
        finally:api.close()

    def test_input_restores_the_original_execution_deadline_on_redelivery(self):
        now=time.time();api=self.api(now)
        try:
            deadline=datetime.fromtimestamp(now+100,timezone.utc).isoformat()
            with patch.object(api,'json_request',return_value={'job_id':'job','attempt':1,'should_process':True,'work_deadline':deadline}):api.input()
            self.assertAlmostEqual(api.work_deadline,now+100,places=4)
            for invalid in ['not a date','2026-11-20T12:00:00',datetime.fromtimestamp(now+90000,timezone.utc).isoformat()]:
                with self.assertRaises(InvalidJob):api._read_work_deadline({'work_deadline':invalid})
        finally:api.close()

    def test_pause_reports_waiting_and_clears_local_deadline_even_on_shutdown(self):
        now=time.time();api=self.api(now)
        try:
            with patch.object(api,'json_request',return_value={'accepted':True}):api.progress()
            api.work_deadline=now+1800
            api.stopped=lambda:True
            calls=[]
            def request(method,path,**kwargs):
                api.check()
                calls.append(kwargs['json'])
                return {'accepted':True}
            with patch.object(api,'json_request',side_effect=request):api.pause()
            self.assertEqual(calls[0]['status'],'waiting_retry')
            self.assertEqual(calls[0]['run_id'],api.run_id)
            self.assertIsNone(api.work_deadline)
            self.assertFalse(api.run_started)
            self.assertTrue(api.stopped())
        finally:api.close()

    def test_busy_delivery_that_never_started_does_not_pause_another_run(self):
        api=self.api(time.time())
        try:
            with patch.object(api,'json_request') as request:api.pause()
            request.assert_not_called()
        finally:api.close()
