"""Isolated PostgreSQL database and RabbitMQ vhost; never clear application data."""
from pathlib import Path
import base64
import json
import os
import subprocess
import uuid
import sys
from urllib.parse import quote
from urllib.request import Request, urlopen

ROOT = Path(__file__).resolve().parents[1]
env = os.environ.copy()
for line in (ROOT / '.env').read_text(encoding='utf-8').splitlines():
    if line and not line.startswith('#') and '=' in line:
        key, value = line.split('=', 1)
        env[key.strip()] = value.strip().strip('\"\'')
name = 'hr_dam_queue_test_' + uuid.uuid4().hex[:12]
bridge_mode = sys.argv[2] if len(sys.argv) == 3 and sys.argv[1] == '--bridge' else None
if bridge_mode not in (None, 'broker', 'direct'):
    raise ValueError('Bridge mode must be broker or direct')
uses_broker = bridge_mode != 'direct'
user, password = env.get('RABBITMQ_USER', 'hr_dam'), env.get('RABBITMQ_PASSWORD', '')
auth = 'Basic ' + base64.b64encode((user + ':' + password).encode()).decode()
management = env.get('RABBITMQ_MANAGEMENT_URL') or 'http://127.0.0.1:15672'

def rabbit(method, path, body=None):
    data = json.dumps(body).encode() if body is not None else None
    request = Request(management + '/api/' + path, data=data, method=method,
                      headers={'Authorization': auth, 'Content-Type': 'application/json'})
    with urlopen(request, timeout=10) as response:
        return response.read()

def sql(query):
    return subprocess.run(['docker', 'compose', 'exec', '-T', 'postgres', 'sh', '-ec',
                           'exec psql -X -U "$POSTGRES_USER" -d postgres -v ON_ERROR_STOP=1'],
                          cwd=ROOT, input=query, text=True, capture_output=True, check=True)

database_created = False
vhost_created = False
try:
    sql('CREATE DATABASE "' + name + '";')
    database_created = True
    if uses_broker:
        rabbit('PUT', 'vhosts/' + name, {})
        vhost_created = True
        rabbit('PUT', 'permissions/' + name + '/' + quote(user, safe=''),
               {'configure': '.*', 'write': '.*', 'read': '.*'})
    env.update(POSTGRES_DB=name, RABBITMQ_VHOST=name,
               ANALYZER_ADAPTER='http' if bridge_mode else 'amqp',
               RABBITMQ_ENABLED='true' if uses_broker else 'false',
               RANK_BRIDGE_ENABLED='true' if bridge_mode else 'false',
               RABBITMQ_URL='amqp://' + quote(user, safe='') + ':' + quote(password, safe='')
               + '@127.0.0.1:5672/' + name + '?heartbeat=15',
               RABBITMQ_MANAGEMENT_URL=management, QUEUE_RETRY_DELAY_MS='100',
               RESUME_SPOOL_DIR=str(ROOT / '.qa' / name), PGHOST='127.0.0.1',
               S3_ENDPOINT='http://127.0.0.1:' + env.get('S3_PORT', '8333'))
    if not uses_broker:
        env.update(RABBITMQ_URL='amqp://127.0.0.1:1', RABBITMQ_MANAGEMENT_URL='http://127.0.0.1:1', RABBITMQ_PASSWORD='')
    test = 'tests/rank-modes.integration.ts' if bridge_mode else 'tests/queue-imports.integration.ts'
    result = subprocess.run(['node', 'node_modules/tsx/dist/cli.mjs', test], cwd=ROOT, env=env)
    raise SystemExit(result.returncode)
finally:
    if vhost_created:
        rabbit('DELETE', 'vhosts/' + name)
    if database_created:
        sql('DROP DATABASE "' + name + '" WITH (FORCE);')
