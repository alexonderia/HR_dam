"""Exercise the real one-process HTTP/AMQP lifecycle in an isolated RabbitMQ vhost.

Run with the analyzer's Python environment; never touches application queues or DB.
Only model scoring and backend/download responses are fixtures.
"""

import base64
import hashlib
import json
import os
from pathlib import Path
import socket
import subprocess
import sys
import threading
import time
import uuid
from datetime import datetime, timedelta, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import pika
import requests

ROOT = Path(__file__).resolve().parents[1]
env = os.environ.copy()
for line in (ROOT / '.env').read_text(encoding='utf-8').splitlines():
    if line and not line.startswith('#') and '=' in line:
        key, value = line.split('=', 1)
        env[key.strip()] = value.strip().strip('\"\'')
resource = 'hr_dam_analyzer_test_' + uuid.uuid4().hex[:12]
management = env.get('RABBITMQ_MANAGEMENT_URL') or 'http://127.0.0.1:15672'
user, password = env.get('RABBITMQ_USER', 'hr_dam'), env.get('RABBITMQ_PASSWORD', '')
state = dict(ready=True, score_status=200, hold=False)
release = threading.Event()
shutdown_started = threading.Event()
content = 'Румянцева Дарья\nКонстантиновна\nТелефон: +7 999 123 45 67\nОпыт работы: аналитик данных Python SQL.'.encode()


class Fixture(BaseHTTPRequestHandler):
    def reply(self, code, body):
        data = json.dumps(body).encode()
        self.send_response(code); self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(data))); self.end_headers(); self.wfile.write(data)

    def do_GET(self):
        if self.path == '/api/tags':
            self.reply(200, {'models': [{'name': env.get('OLLAMA_MODEL', 'qwen3.5:9b')}] if state['ready'] else []})
        elif self.path == '/resume.txt':
            self.send_response(200); self.send_header('Content-Length', str(len(content))); self.end_headers(); self.wfile.write(content)
        else:
            self.reply(404, {})

    def do_POST(self):
        self.rfile.read(int(self.headers.get('Content-Length', '0')))
        if self.path == '/score':
            if state['hold']:
                release.wait(5)
            if state['score_status'] == 503:
                state['ready'] = False
            self.reply(state['score_status'], {})
        elif self.path == '/api/internal/resume-jobs/status':
            self.reply(200, {'status': 'pending', 'should_process': True})
        elif self.path == '/stopping':
            shutdown_started.set()
            self.reply(200, {})
        else:
            self.reply(404, {})

    def log_message(self, *args):
        pass


fixture = ThreadingHTTPServer(('127.0.0.1', 0), Fixture)
thread = threading.Thread(target=fixture.serve_forever, daemon=True); thread.start()
fixture_url = f'http://127.0.0.1:{fixture.server_port}'
process = None
log = None
connection = None
vhost_created = False


def rabbit(method, path, **kwargs):
    response = requests.request(method, management + '/api/' + path, auth=(user, password), timeout=10, **kwargs)
    response.raise_for_status()
    return response


def wait_for(read, matches=lambda value: bool(value), timeout=15):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        try:
            value = read()
            if matches(value):
                return value
        except requests.RequestException:
            pass
        time.sleep(.05)
    raise AssertionError('Timed out waiting for analyzer state')


def start(adapter):
    global process, log
    with socket.socket() as address:
        address.bind(('127.0.0.1', 0)); port = address.getsockname()[1]
    child_env = {**env, 'PYTHONPATH': str(ROOT / 'apps/resume-analyzer'), 'PYTHONIOENCODING': 'utf-8',
        'ANALYZER_ADAPTER': adapter, 'RABBITMQ_ENABLED': 'true', 'RANK_BRIDGE_ENABLED': 'false' if adapter == 'amqp' else 'true',
        'RABBITMQ_HOST': '127.0.0.1', 'RABBITMQ_VHOST': resource, 'RESUME_ANALYZER_CALLBACK_TOKEN': 'fixture-token',
        'OLLAMA_BASE_URL': fixture_url, 'BACKEND_BASE_URL': fixture_url, 'MODEL_PROBE_INTERVAL_SECONDS': '0.1',
        'MODEL_PROBE_TIMEOUT_SECONDS': '1', 'SHUTDOWN_GRACE_SECONDS': '5', 'TEST_ANALYZER_PORT': str(port),
        'LOG_DIR': str(ROOT / '.qa' / resource), 'DIAGNOSTIC_LOGS_ENABLED': 'false'}
    folder = ROOT / '.qa' / resource; folder.mkdir(parents=True, exist_ok=True)
    log = (folder / (adapter + '.log')).open('wb')
    process = subprocess.Popen([sys.executable, str(ROOT / 'tests/fixtures/analyzer-process.py')], cwd=ROOT, env=child_env,
                               stdout=log, stderr=subprocess.STDOUT)
    url = f'http://127.0.0.1:{port}'
    wait_for(lambda: requests.get(url + '/ready', timeout=1), lambda response: response.ok)
    return url


def stop(url):
    global process, log
    requests.post(url + '/test/shutdown', timeout=2)
    process.wait(timeout=10)
    assert process.returncode == 0
    process = None
    log.close(); log = None


cluster, profile = str(uuid.uuid4()), str(uuid.uuid4())
requirements = [{'id': cluster, 'name': 'Test', 'profiles': [{'id': profile, 'cluster_id': cluster, 'position_name': 'Analyst'}]}]


def job():
    return {'version': 1, 'job_id': str(uuid.uuid4()), 'batch_id': str(uuid.uuid4()), 'item_id': str(uuid.uuid4()), 'attempt': 1,
        'file': {'id': str(uuid.uuid4()), 'file_id': str(uuid.uuid4()), 'source_path': 'resume.txt', 'file_name': 'resume.txt',
            'mime_type': 'text/plain', 'size_bytes': len(content), 'sha256': hashlib.sha256(content).hexdigest(),
            'bucket': 'fixture', 'object_key': 'resume.txt', 'download_url': fixture_url + '/resume.txt',
            'download_url_expires_at': (datetime.now(timezone.utc) + timedelta(hours=1)).isoformat(), 'candidate_hint': {}},
        'requirements': requirements}


def publish(data, retries=5):
    channel.basic_publish('', 'hr.resume.analysis', json.dumps(data), properties=pika.BasicProperties(headers={'hr-retries': retries}))


def get(queue):
    method, properties, body = channel.basic_get(queue, auto_ack=True)
    return (properties, json.loads(body)) if method else None


try:
    rabbit('PUT', 'vhosts/' + resource, json={}); vhost_created = True
    rabbit('PUT', 'permissions/' + resource + '/' + requests.utils.quote(user, safe=''), json={'configure': '.*', 'write': '.*', 'read': '.*'})
    connection = pika.BlockingConnection(pika.ConnectionParameters('127.0.0.1', int(env.get('RABBITMQ_PORT', '5672')),
        virtual_host=resource, credentials=pika.PlainCredentials(user, password)))
    channel = connection.channel(); channel.confirm_delivery()
    for name in ('analysis', 'progress', 'results'):
        channel.queue_declare('hr.resume.' + name, durable=True)
    channel.queue_declare('hr.resume.analysis.retry', durable=True, arguments={
        'x-message-ttl': 250, 'x-dead-letter-exchange': '', 'x-dead-letter-routing-key': 'hr.resume.analysis'})
    http = start('http')
    response = requests.post(http + '/rank', files={'file': ('resume.txt', content, 'text/plain')},
        data={'requirements': json.dumps({'clusters': requirements})}, timeout=5)
    assert response.status_code == 200, response.text
    expected = response.json()
    assert expected['candidate']['middle_name'] == 'Константиновна'
    stop(http)

    native = start('amqp')
    assert requests.post(native + '/rank', files={'file': ('resume.txt', content)}, data={'requirements': '{}'}).status_code == 409
    competing = connection.channel()
    try:
        competing.basic_consume('hr.resume.analysis', lambda *args: None)
        raise AssertionError('Native and bridge consumers shared the queue')
    except pika.exceptions.ChannelClosedByBroker as error:
        assert error.reply_code == 403
    state['ready'] = False
    wait_for(lambda: requests.get(native + '/ready').json(), lambda data: not data['available'])
    assert requests.get(native + '/health').ok
    queued = job(); publish(queued)
    retry = wait_for(lambda: get('hr.resume.analysis.retry'))
    assert retry[0].headers['hr-retries'] == 5 and retry[1]['job_id'] == queued['job_id']
    assert get('hr.resume.results') is None
    state['ready'] = True
    wait_for(lambda: requests.get(native + '/ready').json(), lambda data: data['available'])
    publish(queued)
    result = wait_for(lambda: get('hr.resume.results'))[1]
    assert result['status'] == 'completed'
    for field in ('candidate', 'contact_details'):
        assert result[field] == expected[field]
    assert result['analysis']['clusters'] == expected['clusters']
    assert isinstance(result['analysis_duration_ms'], int)
    print('PASS: HTTP/AMQP pipeline parity, native readiness, offline waiting, exclusive queue, explicit timing')

    state['score_status'] = 503; publish(job())
    retry = wait_for(lambda: get('hr.resume.analysis.retry'))
    assert retry[0].headers['hr-retries'] == 5
    assert get('hr.resume.results') is None
    state['score_status'] = 200; state['ready'] = True
    wait_for(lambda: requests.get(native + '/ready').json(), lambda data: data['available'])
    publish(retry[1]); result = wait_for(lambda: get('hr.resume.results'))[1]
    assert result['status'] == 'completed'
    print('PASS: mid-analysis model outage retains exhausted retry budget and recovers without failed result')

    state['hold'] = True; release.clear(); shutdown_started.clear(); pending = job(); publish(pending)
    wait_for(lambda: requests.get(native + '/status').json(), lambda data: data['busy'])
    assert requests.get(native + '/health').ok
    requests.post(native + '/test/shutdown', timeout=2)
    assert shutdown_started.wait(3)
    release.set(); process.wait(timeout=10)
    assert process.returncode == 0
    returned = wait_for(lambda: get('hr.resume.analysis'))
    assert returned[1]['job_id'] == pending['job_id']
    assert get('hr.resume.results') is None
    process = None; log.close(); log = None
    print('PASS: liveness while busy and graceful native shutdown return unfinished delivery')
finally:
    release.set()
    if process is not None:
        process.terminate()
        try:
            process.wait(timeout=5)
        except subprocess.TimeoutExpired:
            process.kill(); process.wait(timeout=5)
    if log:
        log.close()
    if connection and connection.is_open:
        connection.close()
    fixture.shutdown(); fixture.server_close(); thread.join(timeout=2)
    if vhost_created:
        rabbit('DELETE', 'vhosts/' + resource)
