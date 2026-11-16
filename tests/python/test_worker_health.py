import json
import threading
import unittest
import urllib.error
import urllib.request
from http.server import ThreadingHTTPServer
from unittest.mock import Mock, patch

from processing_runtime.worker import health_handler, health_status, consume


class WorkerHealthTests(unittest.TestCase):
    def test_live_and_ready_are_independent_over_http(self):
        stop = threading.Event()
        model = [False]
        status = lambda: health_status("evaluate", {"guest": True, "authorized": True}, stop,
                                     model_ready=lambda: model[0], model_busy=lambda: False)
        server = ThreadingHTTPServer(("127.0.0.1", 0), health_handler(status))
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        base = f"http://127.0.0.1:{server.server_port}"
        try:
            self.assertEqual(urllib.request.urlopen(base + "/live").status, 200)
            with self.assertRaises(urllib.error.HTTPError) as error:
                urllib.request.urlopen(base + "/ready")
            self.assertEqual(error.exception.code, 503)
            self.assertFalse(json.load(error.exception)["model_ready"])
            model[0] = True
            self.assertTrue(json.load(urllib.request.urlopen(base + "/ready"))["available"])
            stop.set()
            with self.assertRaises(urllib.error.HTTPError):
                urllib.request.urlopen(base + "/live")
        finally:
            server.shutdown(); server.server_close(); thread.join()

    def test_parser_does_not_probe_model(self):
        probe = Mock(side_effect=AssertionError("Parser must not contact Ollama"))
        result = health_status("prepare", {"guest": True, "authorized": True}, threading.Event(), model_ready=probe)
        self.assertTrue(result["available"])
        self.assertIsNone(result["model_ready"])
        probe.assert_not_called()

    def test_consumer_pauses_and_resumes_without_rejecting_queued_jobs(self):
        stop = threading.Event()
        connection, channel = Mock(), Mock()
        connection.is_open = channel.is_open = True
        connection.channel.return_value = channel
        channel.basic_consume.return_value = "consumer"
        available = [False]
        ticks = [0]
        def tick(**_):
            ticks[0] += 1
            available[0] = ticks[0] in (1, 4)
            if ticks[0] == 5:
                stop.set()
        connection.process_data_events.side_effect = tick
        with patch("processing_runtime.worker.pika.BlockingConnection", return_value=connection):
            consume("guest", "evaluate", "amqp://localhost/hr-guest", None, "http://unused", stop,
                    Mock(), Mock(), {"guest": False}, lambda: available[0])
        self.assertEqual(channel.basic_consume.call_count, 2)
        channel.basic_cancel.assert_called_once_with("consumer")
        channel.basic_reject.assert_not_called()
